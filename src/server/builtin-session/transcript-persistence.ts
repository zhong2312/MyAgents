import {
  saveSessionMessages,
  updateSessionMetadata,
  type SaveSessionMessagesResult,
} from '../SessionStore';
import type { SessionMessage } from '../types/session';
import { resolveLastVisibleTurnPreview } from '../utils/session-message-preview';
import { deriveReloadResumeAnchor } from '../utils/rewind-anchor';
import { findTurnUsageStampIndex } from '../utils/sdk-turn-outcome';
import { seedBridgeThoughtSignatures } from '../bridge-cache';
import type { BuiltinTurnUsage, ContentBlock, MessageWire } from './types';
import {
  addCurrentSessionUuid,
  appendMessage,
  appendPersistedSessionMessage,
  clearPersistedSessionMessageCache,
  deletePersistChain,
  getMessages,
  removeMessageAt,
  removePersistedSessionMessageAt,
  replacePersistedSessionMessageCache,
  setLastPersistedIndex,
  setMessageSequence,
  setPendingReloadAnchor,
  transcriptState,
  truncatePersistedSessionMessageCache,
} from './transcript';

/** Sentinel value for stripped Playwright tool results (truthy, so ProcessRow sees tool as complete). */
export const PLAYWRIGHT_RESULT_SENTINEL = '[playwright_result_stripped]';

export type TranscriptPersistenceSnapshot = {
  lastPersistedIndex: number;
  persistedSessionMessageCache: SessionMessage[];
};

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
  if (transcriptState.lastPersistedIndex > transcriptState.messages.length) {
    console.warn(`[agent-session] persist cursor (${transcriptState.lastPersistedIndex}) exceeds transcriptState.messages.length (${transcriptState.messages.length}); resetting`);
    resetTranscriptPersistenceCursor();
  }
  if (transcriptState.persistedSessionMessageCache.length > transcriptState.messages.length) {
    truncatePersistedSessionMessageCache(transcriptState.messages.length);
  }

  const targetMessageCount = options.targetMessageCount ?? transcriptState.messages.length;
  const boundedTargetCount = Math.min(targetMessageCount, transcriptState.messages.length);
  if (transcriptState.lastPersistedIndex >= boundedTargetCount) {
    if (options.lastActiveAt && options.metadataDisposition !== 'skip') {
      try {
        await updateSessionMetadata(options.sessionId, { lastActiveAt: options.lastActiveAt });
      } catch (error) {
        console.error('[agent-session] failed to persist transcript metadata:', error);
      }
    }
    return;
  }

  const tail = transcriptState.messages.slice(transcriptState.lastPersistedIndex, boundedTargetCount);
  const tailMapped = tail.map(messageWireToSessionMessage);
  const sessionMessages = transcriptState.persistedSessionMessageCache
    .slice(0, transcriptState.lastPersistedIndex)
    .concat(tailMapped);

  assertSaveSessionMessagesOk(
    await saveSessionMessages(options.sessionId, sessionMessages),
    options.sessionId,
  );

  truncatePersistedSessionMessageCache(transcriptState.lastPersistedIndex);
  for (const message of tailMapped) {
    appendPersistedSessionMessage(message);
  }
  setLastPersistedIndex(boundedTargetCount);

  if (options.metadataDisposition === 'skip') return;
  const { preview: lastMessagePreview } =
    resolveLastVisibleTurnPreview(sessionMessages);
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
  assertSaveSessionMessagesOk(
    await saveSessionMessages(sessionId, messages),
    sessionId,
  );
}

export function loadTranscriptFromSessionMessages(storedMessages: SessionMessage[]): void {
  for (const storedMsg of storedMessages) {
    appendMessage(sessionMessageToMessageWire(storedMsg));
  }
  setLastPersistedIndex(transcriptState.messages.length);
  clearPersistedSessionMessageCache();
  for (const storedMsg of storedMessages) {
    appendPersistedSessionMessage(storedMsg);
  }
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
    transcriptState.lastPersistedIndex,
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
  setLastPersistedIndex(0);
  clearPersistedSessionMessageCache();
  deletePersistChain(sessionId);
}

export function resetTranscriptPersistenceCursor(): void {
  setLastPersistedIndex(0);
  clearPersistedSessionMessageCache();
}

export function truncateTranscriptPersistenceForRewind(): void {
  resetTranscriptPersistenceCursor();
}

export function snapshotTranscriptPersistenceState(): TranscriptPersistenceSnapshot {
  return {
    lastPersistedIndex: transcriptState.lastPersistedIndex,
    persistedSessionMessageCache: transcriptState.persistedSessionMessageCache.slice(),
  };
}

export function restoreTranscriptPersistenceState(snapshot: TranscriptPersistenceSnapshot): void {
  if (transcriptState.lastPersistedIndex !== snapshot.lastPersistedIndex) {
    console.warn(`[agent] forkSession: parent persist cursor drifted (${snapshot.lastPersistedIndex} -> ${transcriptState.lastPersistedIndex}); restoring`);
    setLastPersistedIndex(snapshot.lastPersistedIndex);
  }
  if (transcriptState.persistedSessionMessageCache.length !== snapshot.persistedSessionMessageCache.length) {
    replacePersistedSessionMessageCache(snapshot.persistedSessionMessageCache);
  }
}

export function applyTranscriptRetractionToPersistence(removedMessageIds: ReadonlySet<string>): {
  removedBelowCursor: number;
} {
  let removedBelowCursor = 0;
  for (let i = transcriptState.messages.length - 1; i >= 0; i--) {
    if (!removedMessageIds.has(transcriptState.messages[i].id)) continue;
    if (i < transcriptState.lastPersistedIndex) removedBelowCursor += 1;
    if (i < transcriptState.persistedSessionMessageCache.length) {
      removePersistedSessionMessageAt(i);
    }
    removeMessageAt(i);
  }
  if (removedBelowCursor > 0) {
    setLastPersistedIndex(transcriptState.lastPersistedIndex - removedBelowCursor);
  }
  return { removedBelowCursor };
}

function assertSaveSessionMessagesOk(result: SaveSessionMessagesResult, sessionId: string): void {
  if (result.ok) return;
  const details = result.reason === 'write-error'
    ? `${result.reason}: ${result.error}`
    : result.reason === 'shrink-refused'
      ? `${result.reason}: in-memory ${result.count} < on-disk ${result.existingCount}`
      : `${result.reason}: count=${result.count}`;
  throw new Error(`[agent-session] failed to persist transcript for ${sessionId}: ${details}`);
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
