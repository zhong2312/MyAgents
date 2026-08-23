import { randomUUID } from 'crypto';
import { localTimestamp } from '../shared/logTime';
import { isLiveRevisionEnvelope, type LiveRevisionEnvelope } from '../shared/liveRevision';
import { summarizeSensitiveValueForLog } from './utils/log-summary';

type SseClient = {
  id: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const encoder = new TextEncoder();

// ──────────────────────────────────────────────────────────────────────────
// Pattern 2 §2.3.2 — Priority-aware SSE backpressure.
//
// The historical client.send() called controller.enqueue() unconditionally;
// when the WebKit/Tauri downstream stalled (slow renderer, paused tab, frozen
// proxy), Node's ReadableStreamDefaultController would hold every pending
// chunk in memory forever. A long streaming session against a paused tab
// would OOM the sidecar.
//
// Three priority tiers:
//   - 'critical'    → must reach the client even under pressure (errors,
//                     completions, init events). Wait briefly, then enqueue
//                     anyway and emit a slow-client warning. NEVER dropped.
//   - 'coalescible' → chunk-style deltas. When the queue is over the high-water
//                     mark, the newest entry of the same event type replaces
//                     the previous queued entry of the same type (we're going
//                     to emit a tail-of-stream snapshot anyway).
//   - 'droppable'   → telemetry, logs. Drop silently and bump a counter.
//
// Per-client bounded queue (`MAX_QUEUE_PER_CLIENT`) is a hard ceiling — once
// the queue is full of critical entries, further critical entries still go
// in (we'd rather burn memory than drop a completion event), but the slow
// client is logged so operators can spot the wedge.
// ──────────────────────────────────────────────────────────────────────────

export type SseEventPriority = 'critical' | 'coalescible' | 'droppable';

/**
 * Default priority used when an event isn't listed in `SSE_EVENT_PRIORITIES`.
 *
 * Codex M9 fix: defaulting unknown events to 'coalescible' silently dropped
 * unregistered structural / control events (`chat:tool-use-start`,
 * `chat:content-block-stop`, `chat:message-sdk-uuid`, queue events…) under
 * backpressure — invisible data loss for anything someone forgot to
 * register. We now fail closed: unregistered events take the same priority
 * as critical events and emit a one-shot warning with the event name so the
 * regression is loud. Existing registered streaming deltas keep their
 * 'coalescible' priority via SSE_EVENT_PRIORITIES below.
 */
const DEFAULT_PRIORITY: SseEventPriority = 'critical';
const unknownEventWarned = new Set<string>();

/**
 * Data-driven priority table. Each callsite of `broadcast(event, ...)` picks
 * up its priority from this map — adding a new event type to the codebase
 * only requires registering it here, not threading priority through callers.
 *
 * Conventions:
 *   - chunk/delta-style streaming events                   → 'coalescible'
 *   - completion / error / init / permission gate events   → 'critical'
 *   - log / telemetry chatter                              → 'droppable'
 */
export const SSE_EVENT_PRIORITIES: Readonly<Record<string, SseEventPriority>> = Object.freeze({
  // Streaming deltas — coalescible (replace same-key tail under pressure).
  'chat:message-chunk': 'coalescible',
  'chat:thinking-chunk': 'coalescible',
  'chat:tool-input-delta': 'coalescible',
  'chat:tool-result-delta': 'coalescible',
  'chat:subagent-tool-input-delta': 'coalescible',
  'chat:subagent-tool-result-delta': 'coalescible',
  // PRD 0.2.32 — context-usage indicator snapshot. A latest-wins value
  // (renderer only does setContextUsage(latest)) broadcast at Codex sub-turn
  // frequency; under backpressure superseded snapshots MUST collapse to the
  // newest rather than queue, so it is coalescible (NOT critical — the default
  // for unregistered events, which would never coalesce and spam a one-shot
  // [sse] missing-from-priorities warning per process).
  'chat:context-usage': 'coalescible',
  'chat:agent-plan-update': 'coalescible',
  'chat:runtime-tool-catalog': 'coalescible',
  // (Phase E PRD 0.2.7: `workspace:files-changed` SSE event removed; the
  // renderer subscribes to the Rust workspace_files watcher via Tauri
  // events instead, so this whitelist no longer needs the entry.)
  // Logs / telemetry — droppable.
  'chat:log': 'droppable',
  'chat:logs': 'droppable',
  'chat:debug-message': 'droppable',
  'chat:runtime-diagnostics': 'droppable',
  // Critical — never drop or coalesce. Includes block-boundary / start
  // markers, completion / error events, status updates, queue lifecycle,
  // and renderer-driven request/response gates. The SDK emits these in
  // tight bursts at turn start (system_init → status → thinking-start →
  // content-block-stop → tool-use-start → …); coalescing any of them
  // would corrupt the renderer's structural state machine.
  'chat:system-init': 'critical',
  'chat:slash-commands': 'critical',
  'chat:system-status': 'critical',
  'chat:status': 'critical',
  'chat:init': 'critical',
  'chat:api-retry': 'critical',
  'chat:attachments-filtered': 'critical',
  'chat:attachments-fallback': 'critical',
  'chat:thinking-start': 'critical',
  'chat:content-block-stop': 'critical',
  'chat:message-sdk-uuid': 'critical',
  'chat:message-replay': 'critical',
  'chat:message-stopped': 'critical',
  'chat:message-complete': 'critical',
  'chat:message-error': 'critical',
  'chat:agent-error': 'critical',
  'chat:tool-use-start': 'critical',
  'chat:tool-result-start': 'critical',
  'chat:tool-result-complete': 'critical',
  'chat:tool-attachment-update': 'critical', // PRD 0.2.15 — placeholder fulfillment must reach UI (replaces loading skeleton)
  'chat:server-tool-use-start': 'critical',
  'chat:subagent-tool-use': 'critical',
  'chat:subagent-tool-result-start': 'critical',
  'chat:subagent-tool-result-complete': 'critical',
  'chat:subagent-status': 'critical',
  'chat:permission-mode-changed': 'critical',
  'chat:session-title-changed': 'critical',
  'chat:task-notification': 'critical',
  'chat:task-started': 'critical',
  'permission:request': 'critical',
  'permission:expired': 'critical',
  'ask-user-question:request': 'critical',
  'ask-user-question:expired': 'critical',
  'exit-plan-mode:request': 'critical',
  'exit-plan-mode:expired': 'critical',
  'enter-plan-mode:request': 'critical',
  'enter-plan-mode:expired': 'critical',
  'mcp:oauth-expired': 'critical',
  'config:changed': 'critical',
  // Plugin lifecycle (PRD 0.2.17). install-progress is per-install progress
  // phase, plugins:changed is the invalidation signal for the Plugins panel.
  // Both are infrequent and structural — critical guarantees they don't get
  // coalesced or dropped under load.
  'plugin:install-progress': 'critical',
  'plugins:changed': 'critical',
  'queue:added': 'critical',
  'queue:started': 'critical',
  'queue:cancelled': 'critical',
});

function resolvePriority(event: string): SseEventPriority {
  const explicit = SSE_EVENT_PRIORITIES[event];
  if (explicit) return explicit;
  if (!unknownEventWarned.has(event)) {
    unknownEventWarned.add(event);
    console.warn(
      `[sse] event "${event}" missing from SSE_EVENT_PRIORITIES — treating as critical. ` +
        `Register it in src/server/sse.ts to silence and pick the correct priority.`,
    );
  }
  return DEFAULT_PRIORITY;
}

const MAX_QUEUE_PER_CLIENT = 1000;
/** Highwater for coalesce trigger — once queue depth exceeds this, coalescible
 *  events start replacing same-type tails instead of appending. */
const COALESCE_HIGH_WATER = 256;
/** OOM defense — beyond this, even critical events get the slow client
 *  force-closed rather than enqueued. PRD §2.3.2 contract: critical never
 *  drops on the normal path, but a wedged renderer + buggy plugin emitting
 *  many `chat:status` / `config:changed` (both critical) must not be allowed
 *  to grow Node memory unboundedly. 10x MAX_QUEUE_PER_CLIENT gives plenty of
 *  headroom for a recoverable burst while bounding the worst case. */
const MAX_QUEUE_HARD_LIMIT = 10 * MAX_QUEUE_PER_CLIENT;
/** How long a 'critical' enqueue waits for desiredSize to recover before
 *  forcing through with a slow-client warning. PRD §2.3.2: "wait briefly,
 *  then enqueue anyway". Used by the dispatch path to give downstream a
 *  chance to drain before we bypass the soft cap. */
const _CRITICAL_BACKOFF_MS = 100;

interface SseMetrics {
  /** Total dropped events broken down by event type. */
  dropped: Record<string, number>;
  /** Total slow-client critical force-throughs. */
  slowConsumerEnqueue: number;
  /** Coalesce-replace operations (kept as a sanity counter). */
  coalesceReplace: number;
}

const SSE_METRICS_KEY = '__myagents_sse_metrics__';
const sseMetrics: SseMetrics =
  ((globalThis as Record<string, unknown>)[SSE_METRICS_KEY] as SseMetrics) ??
  ((globalThis as Record<string, unknown>)[SSE_METRICS_KEY] = {
    dropped: {},
    slowConsumerEnqueue: 0,
    coalesceReplace: 0,
  } as SseMetrics);

export function getSseMetrics(): Readonly<SseMetrics> {
  // Shallow copy — exported for /api/admin diagnostics. The dropped table is
  // a fresh object so callers can JSON.stringify without holding a live ref.
  return {
    dropped: { ...sseMetrics.dropped },
    slowConsumerEnqueue: sseMetrics.slowConsumerEnqueue,
    coalesceReplace: sseMetrics.coalesceReplace,
  };
}

function bumpDropped(event: string): void {
  sseMetrics.dropped[event] = (sseMetrics.dropped[event] ?? 0) + 1;
}

// 🔧 Fix: Use globalThis to ensure single clients Set even if module is loaded twice
// (Per ChatGPT's suggestion to prevent module double-loading issues)
const CLIENTS_KEY = '__myagents_sse_clients__';
// SSE_INSTANCE_ID lives in sse-instance.ts (a leaf module) to break the
// static cycle with logger.ts. Re-exported here so existing callers that
// import it from './sse' keep working.
export { SSE_INSTANCE_ID } from './sse-instance';

const clients: Set<SseClient> =
  (globalThis as Record<string, unknown>)[CLIENTS_KEY] as Set<SseClient> ??
  ((globalThis as Record<string, unknown>)[CLIENTS_KEY] = new Set<SseClient>());

const HEARTBEAT_INTERVAL_MS = 15000;

// ── Last-Value Cache ──
// Events whose latest value is cached and replayed to newly connected clients.
// Solves the "late joiner" problem: when a Tab connects to a session already in progress
// (e.g., IM Bot mid-flight), it immediately receives the current session state instead
// of showing idle until the next live event arrives.
// chat:system-init is already replayed inline by the /chat/stream handler
// (index.ts), so caching it here would cause duplicate delivery that poisons
// isStreamingRef in the frontend. SDK slash commands are cached because the
// SDK control-plane initialize can complete before the renderer has finished
// attaching its SSE listeners; the slash menu still needs that latest snapshot.
const CACHED_EVENTS = new Set(['chat:status', 'chat:slash-commands']);
const LAST_VALUE_CACHE_KEY = '__myagents_sse_lvc__';
const lastValueCache: Map<string, unknown> =
  (globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] as Map<string, unknown> ??
  ((globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] = new Map<string, unknown>());

export function summarizeSsePayload(event: string, data: unknown): string {
  if (event === 'chat:message-replay' && typeof data === 'object' && data !== null) {
    const replay = data as {
      message?: { id?: string; role?: string };
      replayKind?: string;
      sessionId?: string;
    };
    const message = replay.message;
    if (message?.id) {
      return [
        `messageId=${message.id}`,
        `replayKind=${replay.replayKind ?? 'legacy'}`,
        `role=${message.role ?? 'unknown'}`,
        `sessionScope=${replay.sessionId ? 'present' : 'none'}`,
      ].join(' ');
    }
  }
  if (event === 'chat:message-chunk' && typeof data === 'string') {
    return `chars=${data.length}`;
  }
  if (data === null || data === undefined) {
    return 'data=null';
  }

  // SSE is a transport boundary. Its payload may contain prompts, tool
  // arguments/results, commands, passwords, local paths, or provider errors.
  // Never preview recursively: field names evolve and a new payload shape
  // would otherwise silently become a new plaintext logging surface.
  try {
    const isErrorPayload = typeof data === 'object' && data !== null && (data as { isError?: unknown }).isError === true;
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    const summary = summarizeSensitiveValueForLog(serialized ?? null);
    return `payload=${JSON.stringify(summary)}${isErrorPayload ? ' isError=true' : ''}`;
  } catch {
    return 'data=[unserializable]';
  }
}

function formatSse(event: string, data: unknown): Uint8Array {
  const lines: string[] = [];
  if (event) {
    lines.push(`event: ${event}`);
  }

  const safeJsonStringify = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ error: 'unserializable_payload' });
    }
  };

  if (data === undefined) {
    lines.push('data:');
  } else if (data === null) {
    lines.push('data: null');
  } else if (typeof data === 'string') {
    const parts = data.split(/\r?\n/);
    parts.forEach((part) => {
      lines.push(`data: ${part}`);
    });
  } else {
    lines.push(`data: ${safeJsonStringify(data)}`);
  }

  lines.push('');
  return encoder.encode(`${lines.join('\n')}\n`);
}

function heartbeatChunk(): Uint8Array {
  return encoder.encode(': ping\n\n');
}

// Streaming payloads are transport details, never unified-log events. The
// existing turn/content owners log one bounded preview after composing the
// terminal assistant text; logging here would scale with token/delta count.
const SILENT_EVENTS = new Set([
  'chat:message-chunk', 'chat:thinking-chunk',
  'chat:tool-input-delta', 'chat:tool-result-delta',
  'chat:subagent-tool-input-delta', 'chat:subagent-tool-result-delta',
  'chat:content-block-stop', 'chat:message-sdk-uuid', 'chat:log',
]);

// Time-window coalescing for high-frequency streaming deltas.
//
// Background: each SDK token emits a `chat:message-chunk` (string delta) at
// ~60Hz. With N concurrent sidecars (one per Tab) all streaming at once, the
// Rust sse_proxy fires N × 60 = 300+ Tauri `emit()` calls per second — every
// one of them round-trips JSON through the single WebKit IPC channel. On macOS
// that thread is the same one running the React renderer, so the backlog
// materializes as UI jank in every tab simultaneously.
//
// Solution: buffer consecutive streamed deltas in a 40ms window per process,
// then flush as one chunk. This applies to assistant text, reasoning text and
// streamed tool JSON. 40ms ≈ 25fps, far above the ~15fps threshold below
// which streaming feels choppy, while avoiding thousands of Tauri/WebView IPC
// messages during providers that emit one thinking token or tool character at
// a time. Any structural event (tool start/stop, completion, permission, …)
// flushes pending buffers first to preserve the protocol order.
const CHUNK_COALESCE_MS = 40;
type LiveRevisionScope = {
  sessionId: string;
  nextRevision: () => number;
};

type ChunkBuffer = {
  event: string;
  merged: string;
  timer: ReturnType<typeof setTimeout>;
  deltaPayload?: Readonly<Record<string, unknown>>;
  liveScope?: LiveRevisionScope;
};

const chunkBuffers = new Map<string, ChunkBuffer>();

type DeltaCoalesceDescriptor = {
  key: string;
  delta: string;
  payload?: Readonly<Record<string, unknown>>;
};

function coalesceDeltaDescriptor(
  event: string,
  data: unknown,
): DeltaCoalesceDescriptor | null {
  if (event === 'chat:message-chunk' && typeof data === 'string') {
    return { key: event, delta: data };
  }
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  if (typeof payload.delta !== 'string') return null;

  if (event === 'chat:thinking-chunk') {
    const { index } = payload;
    if (typeof index !== 'number' && typeof index !== 'string') return null;
    return { key: `${event}|index:${index}`, delta: payload.delta, payload };
  }

  if (
    event === 'chat:tool-input-delta' ||
    event === 'chat:tool-result-delta'
  ) {
    const streamId = payload.toolId ?? payload.toolUseId ?? payload.index;
    if (typeof streamId !== 'string' && typeof streamId !== 'number') return null;
    return { key: `${event}|tool:${streamId}`, delta: payload.delta, payload };
  }

  if (
    event === 'chat:subagent-tool-input-delta' ||
    event === 'chat:subagent-tool-result-delta'
  ) {
    const parentToolUseId = payload.parentToolUseId;
    const toolId = payload.toolId ?? payload.toolUseId;
    if (typeof parentToolUseId !== 'string' || !parentToolUseId) return null;
    if (typeof toolId !== 'string' || !toolId) return null;
    return {
      key: `${event}|parent:${parentToolUseId}|tool:${toolId}`,
      delta: payload.delta,
      payload,
    };
  }

  return null;
}

// Events that don't carry ordering semantics with the text stream and must
// NOT cause a pending-chunk buffer drain. `chat:log` fires from inside the
// text-delta handler on verbose providers; treating it as a flush boundary
// would defeat coalescing entirely under heavy logging. Anything else
// (tool-use-start, message-complete, permission prompts, …) must still
// flush so the consumer's strict ordering invariants hold.
const NON_FLUSHING_EVENTS = new Set<string>(['chat:log']);

// Coalesce buffer scope: module-level Map. Each Sidecar is one Node process
// serving a single session under the project's Tab-scoped Sidecar isolation
// (see specs/ARCHITECTURE.md § "Tab-scoped 隔离"), so cross-session
// mixing cannot happen here. If that invariant ever changes, key the buffer
// by client id instead.

function flushCoalescedChunk(key: string): void {
  const entry = chunkBuffers.get(key);
  if (!entry) return;
  chunkBuffers.delete(key);
  clearTimeout(entry.timer);
  const payload = entry.deltaPayload
    ? { ...entry.deltaPayload, delta: entry.merged }
    : entry.merged;
  if (entry.liveScope) {
    const envelope: LiveRevisionEnvelope = {
      sessionId: entry.liveScope.sessionId,
      liveRevision: entry.liveScope.nextRevision(),
      payload,
    };
    broadcastImmediate(entry.event, envelope);
    return;
  }
  broadcastImmediate(entry.event, payload);
}

function flushAllCoalesced(): void {
  if (chunkBuffers.size === 0) return;
  // Copy keys — flushCoalescedChunk deletes entries as it runs.
  const keys = Array.from(chunkBuffers.keys());
  for (const k of keys) flushCoalescedChunk(k);
}

function enqueueCoalescedDelta(
  event: string,
  descriptor: DeltaCoalesceDescriptor,
  liveScope?: LiveRevisionScope,
): void {
  let entry = chunkBuffers.get(descriptor.key);
  if (
    entry &&
    ((liveScope && entry.liveScope?.sessionId !== liveScope.sessionId) ||
      (!liveScope && entry.liveScope))
  ) {
    flushCoalescedChunk(descriptor.key);
    entry = undefined;
  }
  // A different streamed block cannot overtake an earlier buffered block.
  // Keeping one active buffer preserves the original event order even for
  // providers that interleave multiple tool-call indexes.
  if (!entry && chunkBuffers.size > 0) {
    flushAllCoalesced();
  }
  entry = chunkBuffers.get(descriptor.key);
  if (!entry) {
    entry = {
      event,
      merged: descriptor.delta,
      ...(descriptor.payload ? { deltaPayload: descriptor.payload } : {}),
      ...(liveScope ? { liveScope } : {}),
      timer: setTimeout(
        () => flushCoalescedChunk(descriptor.key),
        CHUNK_COALESCE_MS,
      ),
    };
    chunkBuffers.set(descriptor.key, entry);
    return;
  }
  entry.merged += descriptor.delta;
}

function broadcastImmediate(event: string, data: unknown): void {
  const eventPayload = isLiveRevisionEnvelope(data) ? data.payload : data;
  if (!SILENT_EVENTS.has(event)) {
    console.log(`[sse] ${event} -> ${summarizeSsePayload(event, eventPayload)}`);
  }
  // Update last-value cache for stateful events
  if (CACHED_EVENTS.has(event)) {
    lastValueCache.set(event, data);
  }
  for (const client of clients) {
    client.send(event, data);
  }
}

export function broadcast(event: string, data: unknown): void {
  const descriptor = coalesceDeltaDescriptor(event, data);
  if (descriptor) {
    enqueueCoalescedDelta(event, descriptor);
    return;
  }
  // Every non-coalesced event flushes pending chunk buffers first so that
  // a tool-use-start or message-complete never lands before the text delta
  // that preceded it — except for events declared non-ordering above, which
  // pass through without disturbing the in-flight coalesce window.
  if (chunkBuffers.size > 0 && !NON_FLUSHING_EVENTS.has(event)) {
    flushAllCoalesced();
  }
  broadcastImmediate(event, data);
}

export function broadcastLive(
  event: string,
  data: unknown,
  scope: LiveRevisionScope,
): void {
  const descriptor = coalesceDeltaDescriptor(event, data);
  if (descriptor) {
    enqueueCoalescedDelta(event, descriptor, scope);
    return;
  }

  if (chunkBuffers.size > 0 && !NON_FLUSHING_EVENTS.has(event)) {
    flushAllCoalesced();
  }
  const envelope: LiveRevisionEnvelope = {
    sessionId: scope.sessionId,
    liveRevision: scope.nextRevision(),
    payload: data,
  };
  broadcastImmediate(event, envelope);
}

/** Flush before an owner exposes a live snapshot so its revision covers all content. */
export function flushPendingLiveEvents(): void {
  flushAllCoalesced();
}

/**
 * Get all active SSE clients (for logger integration)
 */
export function getClients(): SseClient[] {
  return Array.from(clients);
}

export function createSseClient(onClose: (client: SseClient) => void): {
  client: SseClient;
  response: Response;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let client: SseClient | null = null;
  // `pending` holds payloads queued before the stream's start() handler hooks
  // up the controller. `queue` is the post-start backpressure-aware buffer;
  // its entries are tagged with the event name + priority so we can do
  // priority-aware dispositions when downstream stalls.
  const pending: Uint8Array[] = [];
  type QueueEntry = { event: string; priority: SseEventPriority; chunk: Uint8Array };
  const queue: QueueEntry[] = [];
  let slowConsumerLogged = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Drain as many queued entries as `controller.desiredSize` permits. Called
   * after every enqueue and after `pull()` (which fires when downstream
   * actually consumed bytes — i.e. desiredSize bumped back into positive).
   *
   * `force=true` ignores the desiredSize hint and pushes everything through;
   * used at close-time so a paused downstream still receives any tail of
   * queued criticals before EOF.
   */
  const drainQueue = (force: boolean = false): void => {
    if (!controller) return;
    while (queue.length > 0) {
      if (!force) {
        const desired = controller.desiredSize;
        if (desired === null || desired <= 0) break;
      }
      const entry = queue.shift()!;
      try {
        controller.enqueue(entry.chunk);
      } catch {
        // Controller closed — drop the rest; cancel handler will clean up.
        queue.length = 0;
        return;
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (pending.length > 0) {
        pending.forEach((chunk) => {
          controller?.enqueue(chunk);
        });
        pending.length = 0;
      }
    },
    pull() {
      // Downstream consumed; try to flush any backlog we coalesced/queued.
      drainQueue();
    },
    cancel() {
      if (controller) {
        controller = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      queue.length = 0;
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  });

  /**
   * Decide and apply the disposition for an event under backpressure.
   *
   * Returns true if the entry was added to the live queue (or the controller
   * directly), false if it was dropped.
   */
  const dispatchWithBackpressure = (event: string, payload: Uint8Array): boolean => {
    const priority = resolvePriority(event);

    if (!controller) {
      // Pre-start: buffer raw payloads — start() flushes them.
      pending.push(payload);
      return true;
    }

    const desired = controller.desiredSize;

    // Hot path: downstream is consuming, queue is empty.
    if (queue.length === 0 && (desired === null || desired > 0)) {
      try {
        controller.enqueue(payload);
        return true;
      } catch {
        return false;
      }
    }

    // Either we already have a backlog, or downstream is paused. Time for
    // priority-aware dispositions.

    // Coalescible: if queue is hot, replace the previous same-type tail entry
    // rather than letting the queue grow unbounded with stale chunks.
    if (priority === 'coalescible' && queue.length >= COALESCE_HIGH_WATER) {
      // Find the most recent same-event entry and replace its chunk in place.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].event === event) {
          queue[i].chunk = payload;
          sseMetrics.coalesceReplace += 1;
          drainQueue();
          return true;
        }
      }
      // No prior same-type entry — fall through to normal append.
    }

    // Hard ceiling check.
    //
    // Fix #6 (review-by-cc + review-by-codex): critical events used to bypass
    // MAX_QUEUE_PER_CLIENT *unboundedly* — a wedged renderer + buggy plugin
    // emitting many critical events (e.g. chat:status / config:changed) could
    // grow the queue forever, OOMing the sidecar. We now apply a secondary
    // hard cap MAX_QUEUE_HARD_LIMIT (10x the soft cap). Beyond that, even
    // critical events trigger a force-close on the slow client — better to
    // evict than to OOM.
    if (queue.length >= MAX_QUEUE_HARD_LIMIT) {
      console.warn(
        `[sse] hard cap exceeded, force-closing slow client ${client?.id ?? 'unknown'} (reason=oom-defense queue=${queue.length} event=${event})`,
      );
      // Evict immediately so subsequent broadcasts don't try to enqueue.
      bumpDropped(event);
      try { client?.close?.(); } catch { /* ignore */ }
      return false;
    }

    if (queue.length >= MAX_QUEUE_PER_CLIENT) {
      if (priority === 'critical') {
        sseMetrics.slowConsumerEnqueue += 1;
        if (!slowConsumerLogged) {
          slowConsumerLogged = true;
          console.warn(
            `[sse] slow client ${client?.id ?? 'unknown'}: forcing critical ${event} through (queue=${queue.length})`,
          );
        }
        // fall through to push
      } else {
        bumpDropped(event);
        return false;
      }
    }

    if (priority === 'droppable' && (desired !== null && desired <= 0)) {
      bumpDropped(event);
      return false;
    }

    queue.push({ event, priority, chunk: payload });

    if (priority === 'critical' && (desired === null || desired > 0)) {
      drainQueue();
      return true;
    }

    if (priority === 'critical') {
      // Fix #6: PRD §2.3.2 contract — when a critical event sees
      // desiredSize<=0, "wait briefly" before forcing through. We can't
      // synchronously await here (would block other broadcasts), but we
      // schedule a deferred drainQueue() for ~CRITICAL_BACKOFF_MS in case
      // downstream recovers. The event is already enqueued so it'll be
      // delivered as soon as the controller has room (either via this
      // timer's drain attempt, or via pull() if downstream consumes
      // sooner). The slow-client log fires above when the queue actually
      // fills.
      const backoffTimer = setTimeout(() => {
        try { drainQueue(); } catch { /* ignore */ }
      }, _CRITICAL_BACKOFF_MS);
      backoffTimer.unref?.();
      drainQueue();
      return true;
    }

    drainQueue();
    return true;
  };

  client = {
    id: randomUUID(),
    send: (event, data) => {
      try {
        const payload = formatSse(event, data);
        dispatchWithBackpressure(event, payload);
      } catch {
        if (client) {
          clients.delete(client);
          onClose(client);
          console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
          client = null;
        }
      }
    },
    close: () => {
      if (!controller) {
        return;
      }
      // Force-flush any queued backlog before closing. Without `force`, a
      // paused downstream (desiredSize ≤ 0) would lose tail criticals on EOF;
      // here we want every queued event to land in the readable side's
      // internal buffer so the consumer's last `read()`s return them.
      try { drainQueue(true); } catch { /* ignore */ }
      controller.close();
      controller = null;
      queue.length = 0;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  };

  clients.add(client);
  console.log(`[sse] client connected id=${client.id} total=${clients.size}`);

  // Send cached log history to newly connected client (Ring Buffer for early logs)
  // Only replay logs from BEFORE this client connected — logs after connectTime
  // are already delivered by live broadcast (client was added to `clients` above).
  const connectTime = localTimestamp();
  try {
    import('./logger').then(({ getLogHistory }) => {
      const history = getLogHistory();
      const replayEntries = history.filter(e => e.timestamp < connectTime);
      if (replayEntries.length > 0) {
        // Small delay to ensure connection is stable
        setTimeout(() => {
          replayEntries.forEach(entry => {
            client?.send('chat:log', entry);
          });
        }, 200);
      }
    }).catch(() => {
      // Ignore if logger not yet initialized
    });
  } catch {
    // Ignore
  }

  // Replay last-value cache to newly connected client.
  // Solves the "late joiner" problem: a Tab connecting to a mid-flight IM session
  // immediately receives the current session state (e.g., chat:status → "running")
  // instead of appearing idle until the next live event.
  // Delay is required: the SSE stream (hono/node-server) buffers correctly, but the
  // full chain is: Node Sidecar → SSE bytes → Rust proxy parse → Tauri emit → React listener.
  // React's useEffect registers the Tauri listener AFTER first render, so a synchronous
  // replay arrives before the listener is ready and gets silently dropped.
  // 200ms matches the log replay delay and gives React enough time to mount.
  if (lastValueCache.size > 0) {
    setTimeout(() => {
      for (const [event, cached] of lastValueCache) {
        console.log(`[sse] replaying cached ${event} to client ${client?.id}`);
        client?.send(event, cached);
      }
    }, 200);
  }

  heartbeatTimer = setInterval(() => {
    if (!controller) {
      return;
    }
    try {
      controller.enqueue(heartbeatChunk());
    } catch {
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  });

  response.headers.set('X-SSE-Client-Id', client.id);

  return { client, response };
}
