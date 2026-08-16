const DSML_TAG_PATTERN =
  /^<(\/)?(?:\|DSML\||｜DSML｜)(tool_calls|invoke|parameter)(?:\s[^>]*)?>$/u;
const DSML_TAG_PREFIXES = [
  "<|DSML|",
  "<｜DSML｜",
  "</|DSML|",
  "</｜DSML｜",
] as const;

const MAX_SNAPSHOT_SOURCE_LENGTH = 512 * 1024;

type ThinkingBlockState = {
  snapshotMode: "probing" | "snapshot" | "delta";
  snapshotProbe: string[];
  snapshotSource: string;
  pendingTag: string;
  protocolStack: string[];
};

export type ThinkingDeltaNormalization = {
  delta: string;
  filteredProtocolTags: number;
  normalizedSnapshot: boolean;
};

function blockKey(scopeId: string | undefined, index: number): string {
  return `${scopeId ?? "root"}\0${index}`;
}

function createBlockState(): ThinkingBlockState {
  return {
    snapshotMode: "probing",
    snapshotProbe: [],
    snapshotSource: "",
    pendingTag: "",
    protocolStack: [],
  };
}

function isPossibleDsmlTagPrefix(value: string): boolean {
  return DSML_TAG_PREFIXES.some(
    (prefix) => prefix.startsWith(value) || value.startsWith(prefix),
  );
}

function normalizeSnapshot(
  state: ThinkingBlockState,
  incoming: string,
): { delta: string; normalized: boolean } {
  if (!incoming || state.snapshotMode === "delta") {
    return { delta: incoming, normalized: false };
  }

  if (state.snapshotMode === "snapshot") {
    const previous = state.snapshotSource;
    if (incoming.startsWith(previous)) {
      state.snapshotSource = incoming;
      if (incoming.length > MAX_SNAPSHOT_SOURCE_LENGTH) {
        state.snapshotMode = "delta";
        state.snapshotSource = "";
      }
      return { delta: incoming.slice(previous.length), normalized: true };
    }

    if (previous.startsWith(incoming)) {
      return { delta: "", normalized: true };
    }

    state.snapshotMode = "delta";
    state.snapshotSource = "";
    return { delta: incoming, normalized: false };
  }

  const probe = state.snapshotProbe;
  if (probe.length === 0) {
    if (incoming.length <= MAX_SNAPSHOT_SOURCE_LENGTH) {
      probe.push(incoming);
    } else {
      state.snapshotMode = "delta";
    }
    return { delta: incoming, normalized: false };
  }

  const previous = probe[probe.length - 1] ?? "";
  if (!incoming.startsWith(previous)) {
    state.snapshotMode = "delta";
    state.snapshotProbe = [];
    return {
      delta: probe.length === 2 ? probe[1] + incoming : incoming,
      normalized: false,
    };
  }

  if (incoming.length > MAX_SNAPSHOT_SOURCE_LENGTH) {
    state.snapshotMode = "delta";
    state.snapshotProbe = [];
    return {
      delta: probe.length === 2 ? probe[1] + incoming : incoming,
      normalized: false,
    };
  }

  if (probe.length === 1) {
    probe.push(incoming);
    return { delta: "", normalized: false };
  }

  const emittedPrefix = probe[0] ?? "";
  state.snapshotMode = "snapshot";
  state.snapshotProbe = [];
  state.snapshotSource = incoming;
  return { delta: incoming.slice(emittedPrefix.length), normalized: true };
}

function finishSnapshotProbe(state: ThinkingBlockState): string {
  if (state.snapshotMode !== "probing") return "";

  const heldDelta = state.snapshotProbe[1] ?? "";
  state.snapshotProbe = [];
  state.snapshotMode = "delta";
  return heldDelta;
}

function stripDsmlProtocol(
  state: ThinkingBlockState,
  incoming: string,
): { delta: string; filteredProtocolTags: number } {
  const value = state.pendingTag + incoming;
  state.pendingTag = "";
  let output = "";
  let cursor = 0;
  let filteredProtocolTags = 0;

  while (cursor < value.length) {
    const tagStart = value.indexOf("<", cursor);
    if (tagStart === -1) {
      if (state.protocolStack.length === 0) output += value.slice(cursor);
      break;
    }

    if (state.protocolStack.length === 0) {
      output += value.slice(cursor, tagStart);
    }

    const tagEnd = value.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      const tail = value.slice(tagStart);
      if (isPossibleDsmlTagPrefix(tail)) {
        state.pendingTag = tail;
      } else if (state.protocolStack.length === 0) {
        output += tail;
      }
      break;
    }

    const tag = value.slice(tagStart, tagEnd + 1);
    const match = tag.match(DSML_TAG_PATTERN);
    if (!match) {
      if (state.protocolStack.length === 0) output += tag;
      cursor = tagEnd + 1;
      continue;
    }

    filteredProtocolTags += 1;
    const closing = match[1] === "/";
    const name = match[2] ?? "";
    if (!closing) {
      state.protocolStack.push(name);
    } else {
      const matchingIndex = state.protocolStack.lastIndexOf(name);
      if (matchingIndex !== -1) {
        state.protocolStack.splice(matchingIndex);
      }
    }
    cursor = tagEnd + 1;
  }

  return { delta: output, filteredProtocolTags };
}

/**
 * Normalizes provider thinking streams before they enter transcript/UI state.
 * Some compatible providers emit cumulative snapshots and leak DSML tool
 * framing through reasoning deltas instead of returning suffix-only text.
 */
export class ThinkingDeltaNormalizer {
  private readonly blocks = new Map<string, ThinkingBlockState>();

  start(index: number, scopeId?: string): void {
    this.blocks.set(blockKey(scopeId, index), createBlockState());
  }

  push(
    index: number,
    incoming: string,
    scopeId?: string,
  ): ThinkingDeltaNormalization {
    const key = blockKey(scopeId, index);
    const state = this.blocks.get(key) ?? createBlockState();
    this.blocks.set(key, state);

    const snapshot = normalizeSnapshot(state, incoming);
    const protocol = stripDsmlProtocol(state, snapshot.delta);
    return {
      delta: protocol.delta,
      filteredProtocolTags: protocol.filteredProtocolTags,
      normalizedSnapshot: snapshot.normalized,
    };
  }

  finish(index: number, scopeId?: string): ThinkingDeltaNormalization {
    const key = blockKey(scopeId, index);
    const state = this.blocks.get(key);
    this.blocks.delete(key);
    if (!state) {
      return { delta: "", filteredProtocolTags: 0, normalizedSnapshot: false };
    }

    const heldSnapshotDelta = finishSnapshotProbe(state);
    const protocol = stripDsmlProtocol(state, heldSnapshotDelta);

    const pending = state.pendingTag;
    state.pendingTag = "";
    if (!pending) {
      return {
        delta: protocol.delta,
        filteredProtocolTags: protocol.filteredProtocolTags,
        normalizedSnapshot: false,
      };
    }
    if (pending.length >= 3 && isPossibleDsmlTagPrefix(pending)) {
      return {
        delta: protocol.delta,
        filteredProtocolTags: protocol.filteredProtocolTags + 1,
        normalizedSnapshot: false,
      };
    }
    return {
      delta: protocol.delta + pending,
      filteredProtocolTags: protocol.filteredProtocolTags,
      normalizedSnapshot: false,
    };
  }
}

export function sanitizeCompleteThinkingText(value: string): string {
  const normalizer = new ThinkingDeltaNormalizer();
  normalizer.start(0);
  const streamed = normalizer.push(0, value);
  const finished = normalizer.finish(0);
  return streamed.delta + finished.delta;
}
