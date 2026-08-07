import {
  appendSessionMessages,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
  type TranscriptMutationIntent,
  type TranscriptWriteCursor,
} from '../SessionStore';
import type { SessionMessage } from '../types/session';
import { resolveLastVisibleTurnPreview } from '../utils/session-message-preview';
import { deriveReloadResumeAnchor } from '../utils/rewind-anchor';
import { findTurnUsageStampIndex } from '../utils/sdk-turn-outcome';
import { seedBridgeThoughtSignatures } from '../bridge-cache';
import type { BuiltinTurnUsage, ContentBlock, MessageWire } from './types';
import {
  addCurrentSessionUuid,
  deletePersistChain,
  getMessages,
  invalidateTranscriptCursor,
  removeMessageAt,
  replaceMessages,
  setTranscriptCursor,
  setMessageSequence,
  setPendingReloadAnchor,
  transcriptState,
} from './transcript';

/** Sentinel value for stripped Playwright tool results (truthy, so ProcessRow sees tool as complete). */
export const PLAYWRIGHT_RESULT_SENTINEL = '[playwright_result_stripped]';

export type ScheduleTranscriptPersistOptions = {
  sessionId: string;
  getCurrentSessionId: () => string;
  targetMessageCount?: number;
  lastActiveAt?: string;
  metadataDisposition?: 'update' | 'skip';
};

export function stripPlaywrightResults(content: ContentBlock[]): ContentBlock[] {
  return content.map(block => {
    if (
      block.type === 'tool_use' &&
      block.tool?.name.startsWith('mcp__playwright__') &&
      block.tool.result &&
      block.tool.result !== PLAYWRIGHT_RESULT_SENTINEL
    ) {
      return { ...block, tool: { ...block.tool, result: PLAYWRIGHT_RESULT_SENTINEL } };
    }
    return block;
  });
}

export function messageWireToSessionMessage(msg: MessageWire): SessionMessage {
  const contentForDisk = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(stripPlaywrightResults(msg.content));
  const isAssistant = msg.role === 'assistant';
  return {
    id: msg.id,
    role: msg.role,
    content: contentForDisk,
    timestamp: msg.timestamp,
    sdkUuid: msg.sdkUuid,
    attachments: msg.attachments?.map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      path: att.relativePath ?? '',
    })),
    metadata: msg.metadata,
    usage: isAssistant ? msg.usage : undefined,
    toolCount: isAssistant ? msg.toolCount : undefined,
    durationMs: isAssistant ? msg.durationMs : undefined,
  };
}

export function sessionMessageToMessageWire(storedMsg: SessionMessage): MessageWire {
  let parsedContent: string | ContentBlock[] = storedMsg.content;
  if (storedMsg.content.startsWith('[')) {
    try {
      const parsed = JSON.parse(storedMsg.content);
      if (Array.isArray(parsed)) {
        parsedContent = parsed as ContentBlock[];
      }
    } catch {
      // Keep as string if parse fails.
    }
  }
  return {
    id: storedMsg.id,
    role: storedMsg.role,
    content: parsedContent,
    timestamp: storedMsg.timestamp,
    sdkUuid: storedMsg.sdkUuid,
    attachments: storedMsg.attachments?.map((att) => ({
      id: att.id,
      name: att.name,
      size: 0,
      mimeType: att.mimeType,
      relativePath: att.path,
    })),
    metadata: storedMsg.metadata,
    usage: storedMsg.usage,
    toolCount: storedMsg.toolCount,
    durationMs: storedMsg.durationMs,
  };
}

export function scheduleTranscriptPersist(options: ScheduleTranscriptPersistOptions): Promise<void> {
  const key = options.sessionId;
  const targetMessageCount = options.targetMessageCount ?? transcriptState.messages.length;
  const prev = transcriptState.persistChainBySession.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => {
    if (key !== options.getCurrentSessionId()) {
      console.warn(`[agent-session] skipping stale queued persist: scheduled for ${key}, current session is ${options.getCurrentSessionId()}`);
      return;
    }
    return persistTranscriptNow({
      sessionId: key,
      targetMessageCount,
      lastActiveAt: options.lastActiveAt,
      metadataDisposition: options.metadataDisposition,
    });
  });
  transcriptState.persistChainBySession.set(key, next);
  void next.finally(() => {
    if (transcriptState.persistChainBySession.get(key) === next) {
      deletePersistChain(key);
    }
  }).catch(() => undefined);
  return next;
}

export async function persistTranscriptNow(options: {
  sessionId: string;
  targetMessageCount?: number;
  lastActiveAt?: string;
  metadataDisposition?: 'update' | 'skip';
}): Promise<void> {
  const targetMessageCount = options.targetMessageCount ?? transcriptState.messages.length;
  const hadCursor = transcriptState.transcriptCursor !== null;
  const cursor = await ensureTranscriptCursor(options.sessionId);
  const boundedTargetCount = Math.min(targetMessageCount, transcriptState.messages.length);
  if (cursor.persistedMessageCount > boundedTargetCount) {
    if (hadCursor) {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(options.sessionId, true);
    }
    throw new Error(
      `[agent-session] transcript projection invariant failed for ${options.sessionId}: live target ${boundedTargetCount} is shorter than durable cursor ${cursor.persistedMessageCount}; rehydrated from SessionStore`,
    );
  }
  if (cursor.persistedMessageCount >= boundedTargetCount) {
    if (options.lastActiveAt && options.metadataDisposition !== 'skip') {
      try {
        await updateSessionMetadata(options.sessionId, { lastActiveAt: options.lastActiveAt });
      } catch (error) {
        console.error('[agent-session] failed to persist transcript metadata:', error);
      }
    }
    return;
  }

  const tail = transcriptState.messages.slice(cursor.persistedMessageCount, boundedTargetCount);
  const tailMapped = tail.map(messageWireToSessionMessage);
  const result = await appendSessionMessages(options.sessionId, cursor, tailMapped);
  if (!result.ok) {
    if ('cursor' in result) {
      setTranscriptCursor(result.cursor);
    } else {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(options.sessionId, true);
    }
    throw new Error(`[agent-session] failed to append transcript for ${options.sessionId}: ${result.reason}: ${result.error}`);
  }
  setTranscriptCursor(result.cursor);

  if (options.metadataDisposition === 'skip') return;
  const { preview: lastMessagePreview } =
    resolveLastVisibleTurnPreview(
      transcriptState.messages.slice(0, result.cursor.persistedMessageCount).map(messageWireToSessionMessage),
    );
  try {
    await updateSessionMetadata(options.sessionId, {
      ...(options.lastActiveAt ? { lastActiveAt: options.lastActiveAt } : {}),
      lastMessagePreview,
    });
  } catch (error) {
    console.error('[agent-session] failed to persist transcript metadata:', error);
  }
}

export async function saveForkTranscript(sessionId: string, messages: SessionMessage[]): Promise<void> {
  const snapshot = await loadSessionTranscript(sessionId);
  if (snapshot.cursor.persistedMessageCount !== 0 || snapshot.hasMalformedRows) {
    throw new Error(`[agent-session] refused fork transcript persist for non-empty target ${sessionId}`);
  }
  const result = await appendSessionMessages(sessionId, snapshot.cursor, messages);
  if (!result.ok) {
    throw new Error(`[agent-session] failed to persist fork transcript for ${sessionId}: ${result.reason}: ${result.error}`);
  }
}

export function loadTranscriptFromSessionMessages(
  storedMessages: SessionMessage[],
  cursor: TranscriptWriteCursor,
): void {
  replaceMessages(storedMessages.map(sessionMessageToMessageWire));
  setTranscriptCursor(cursor);
  if (storedMessages.length > 0) {
    const lastMsgId = storedMessages[storedMessages.length - 1].id;
    const parsedId = parseInt(lastMsgId, 10);
    if (!Number.isNaN(parsedId)) {
      setMessageSequence(parsedId + 1);
    }
  }

  for (const msg of getMessages()) {
    if (msg.sdkUuid) {
      addCurrentSessionUuid(msg.sdkUuid);
    }
  }

  setPendingReloadAnchor(deriveReloadResumeAnchor(transcriptState.messages, transcriptState.currentSessionUuids));
  seedThoughtSignatureCacheFromTranscript();
}

export function stampTurnUsageOnPendingAssistant(options: {
  usage: BuiltinTurnUsage;
  toolCount: number;
  durationMs?: number;
  providerId?: string;
}): void {
  const usageStampIndex = findTurnUsageStampIndex(
    transcriptState.messages,
    transcriptState.transcriptCursor?.persistedMessageCount ?? 0,
  );
  if (usageStampIndex < 0) return;
  const completedAssistant = transcriptState.messages[usageStampIndex];
  completedAssistant.usage = {
    inputTokens: options.usage.inputTokens,
    outputTokens: options.usage.outputTokens,
    cacheReadTokens: options.usage.cacheReadTokens || undefined,
    cacheCreationTokens: options.usage.cacheCreationTokens || undefined,
    providerId: options.providerId,
    model: options.usage.model,
    modelUsage: options.usage.modelUsage,
  };
  completedAssistant.toolCount = options.toolCount;
  completedAssistant.durationMs = options.durationMs;
}

export function resetTranscriptPersistenceForSession(sessionId: string): void {
  invalidateTranscriptCursor();
  deletePersistChain(sessionId);
}

export async function truncateTranscriptPersistenceForRewind(
  sessionId: string,
  targetMessageId: string,
  targetMessageCount: number,
): Promise<void> {
  await commitTranscriptMutation(sessionId, {
    kind: 'builtin-rewind',
    targetMessageId,
    targetMessageCount,
  });
}

export async function applyTranscriptRetractionToPersistence(
  sessionId: string,
  removedMessageIds: ReadonlySet<string>,
  request:
    | { kind: 'sdk-retraction'; sdkUuids: readonly string[]; streamingTailMessageId?: string }
    | { kind: 'builtin-admission-rollback' | 'builtin-transient-retry' },
): Promise<void> {
  const ids = [...removedMessageIds];
  const intent: TranscriptMutationIntent = request.kind === 'sdk-retraction'
    ? request
    : { kind: request.kind, messageId: ids[0] ?? '' };
  await commitTranscriptMutation(sessionId, intent);
  for (let i = transcriptState.messages.length - 1; i >= 0; i--) {
    if (!removedMessageIds.has(transcriptState.messages[i].id)) continue;
    removeMessageAt(i);
  }
}

async function ensureTranscriptCursor(
  sessionId: string,
  forceReload = false,
): Promise<TranscriptWriteCursor> {
  if (!forceReload && transcriptState.transcriptCursor) {
    return transcriptState.transcriptCursor;
  }
  const snapshot = await loadSessionTranscript(sessionId);
  const durablePrefixMatches = snapshot.messages.every(
    (message, index) => transcriptState.messages[index]?.id === message.id,
  );
  if (transcriptState.messages.length < snapshot.messages.length || !durablePrefixMatches) {
    replaceMessages(snapshot.messages.map(sessionMessageToMessageWire));
  }
  setTranscriptCursor(snapshot.cursor);
  return snapshot.cursor;
}

async function commitTranscriptMutation(
  sessionId: string,
  intent: TranscriptMutationIntent,
): Promise<void> {
  const cursor = await ensureTranscriptCursor(sessionId);
  const result = await mutateSessionTranscript(sessionId, cursor, intent);
  if (!result.ok) {
    if (result.reason === 'stale-cursor') {
      invalidateTranscriptCursor();
      await ensureTranscriptCursor(sessionId, true);
    }
    throw new Error(`[agent-session] failed transcript mutation for ${sessionId}: ${result.reason}: ${result.error}`);
  }
  setTranscriptCursor(result.cursor);
}

function seedThoughtSignatureCacheFromTranscript(): void {
  const thoughtSigEntries: Array<{ id: string; thought_signature: string }> = [];
  for (const msg of transcriptState.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.tool?.thought_signature) {
          thoughtSigEntries.push({ id: block.tool.id, thought_signature: block.tool.thought_signature });
        }
      }
    }
  }
  if (thoughtSigEntries.length > 0) {
    seedBridgeThoughtSignatures(thoughtSigEntries);
  }
}
