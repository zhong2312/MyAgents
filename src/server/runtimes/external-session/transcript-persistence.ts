import type { MessageUsage, SessionMessage } from '../../types/session';
import {
  saveSessionMessages,
  updateSessionMetadata,
  type SaveSessionMessagesResult,
} from '../../SessionStore';
import { resolveLastVisibleTurnPreview } from '../../utils/session-message-preview';
import type { ContextUsage } from '../../../shared/types/context-usage';
import type { PersistContentBlock } from './types';

let allSessionMessages: SessionMessage[] = [];
let lastPersistedRuntimeUsageTotals: MessageUsage | null = null;
let transcriptSessionId = '';

export function resetExternalTranscriptState(): void {
  allSessionMessages = [];
  lastPersistedRuntimeUsageTotals = null;
  transcriptSessionId = '';
}

export function getExternalSessionMessagesSnapshot(): SessionMessage[] {
  return [...allSessionMessages];
}

export function getExternalTranscriptSessionId(): string {
  return transcriptSessionId;
}

export function forEachExternalSessionMessage(
  callback: (message: SessionMessage) => void,
): void {
  for (const message of allSessionMessages) {
    callback(message);
  }
}

export function setExternalSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  transcriptSessionId = sessionId;
  allSessionMessages = messages;
}

export function clearExternalSessionMessages(sessionId?: string): void {
  if (sessionId !== undefined) {
    transcriptSessionId = sessionId;
  }
  allSessionMessages = [];
}

export function pushExternalSessionMessage(message: SessionMessage): void {
  allSessionMessages.push(message);
}

export function getExternalSessionMessageCount(): number {
  return allSessionMessages.length;
}

export function findExternalSessionMessageIndex(
  predicate: (message: SessionMessage) => boolean,
): number {
  return allSessionMessages.findIndex(predicate);
}

export function getExternalSessionMessageAt(index: number): SessionMessage | undefined {
  return allSessionMessages[index];
}

export function truncateExternalSessionMessages(length: number): void {
  allSessionMessages.length = length;
}

export function removeExternalSessionMessageById(messageId: string): boolean {
  for (let i = allSessionMessages.length - 1; i >= 0; i -= 1) {
    if (allSessionMessages[i]?.id === messageId) {
      allSessionMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function getLastPersistedRuntimeUsageTotals(): MessageUsage | null {
  return lastPersistedRuntimeUsageTotals;
}

export function setLastPersistedRuntimeUsageTotals(usage: MessageUsage | null): void {
  lastPersistedRuntimeUsageTotals = usage;
}

function isContentBlockJson(content: string): boolean {
  return content.startsWith('[') && content.includes('"type"');
}

export function getLastExternalAssistantTextFromTranscript(): string {
  for (let i = allSessionMessages.length - 1; i >= 0; i--) {
    const msg = allSessionMessages[i];
    if (msg.role !== 'assistant') continue;
    const content = msg.content ?? '';
    if (isContentBlockJson(content)) {
      try {
        const blocks = JSON.parse(content) as PersistContentBlock[];
        return blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('');
      } catch {
        // Fall through to plain text.
      }
    }
    return content;
  }
  return '';
}

function describeSaveSessionMessagesFailure(
  result: Extract<SaveSessionMessagesResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'unindexed-create-refused':
      return `session metadata is missing; refused to create JSONL (${result.count} message(s))`;
    case 'shrink-refused':
      return `append-only save saw shorter memory history (${result.count}) than disk (${result.existingCount})`;
    case 'write-error':
      return result.error;
  }
}

function assertExternalSessionMessagesPersisted(
  result: SaveSessionMessagesResult,
  context: string,
): void {
  if (!result.ok) {
    throw new Error(`${context}: ${describeSaveSessionMessagesFailure(result)}`);
  }
}

export async function persistExternalUserMessageAppend(
  sessionId: string,
  _userMessageId: string,
  failureContext: string,
  lastActiveAt?: string,
  metadataDisposition: 'update' | 'skip' = 'update',
): Promise<{ lastMessagePreview?: string }> {
  const { preview: lastMessagePreview } = resolveLastVisibleTurnPreview(allSessionMessages);
  const saveResult = await saveSessionMessages(sessionId, allSessionMessages, { allowShrink: false });
  assertExternalSessionMessagesPersisted(saveResult, failureContext);

  if (metadataDisposition === 'skip') return { lastMessagePreview };
  try {
    await updateSessionMetadata(sessionId, {
      lastMessagePreview,
      ...(lastActiveAt ? { lastActiveAt } : {}),
    });
  } catch (error) {
    // The transcript is already durable and may already be entering the
    // runtime. A metadata-only failure must not roll back or duplicate it.
    console.warn('[external-session] failed to update user preview metadata:', error);
  }
  return { lastMessagePreview };
}

export async function removeAndPersistExternalSessionMessage(
  sessionId: string,
  messageId: string,
  failureContext: string,
): Promise<boolean> {
  const removed = removeExternalSessionMessageById(messageId);
  if (!removed) return false;
  const saveResult = await saveSessionMessages(sessionId, allSessionMessages);
  assertExternalSessionMessagesPersisted(saveResult, failureContext);
  return true;
}

export async function truncateExternalTranscriptForRetry(
  sessionId: string,
  userMessageId: string,
): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: SessionMessage['attachments'];
}> {
  const targetIndex = allSessionMessages.findIndex(
    m => m.id === userMessageId && m.role === 'user',
  );
  if (targetIndex < 0) {
    return { success: false, error: 'Message not found' };
  }
  const target = allSessionMessages[targetIndex];
  if (!target) {
    return { success: false, error: 'Message not found' };
  }
  const content = typeof target.content === 'string' ? target.content : '';
  const attachments = target.attachments;

  // Drops the failed user message plus any partial assistant blocks left
  // behind from a half-finalized turn. saveSessionMessages detects the
  // shorter in-memory history and rewrites the JSONL.
  allSessionMessages.length = targetIndex;
  try {
    const saveResult = await saveSessionMessages(sessionId, allSessionMessages);
    assertExternalSessionMessagesPersisted(
      saveResult,
      '[external-session] popLastUserMessageForRetry failed to persist truncation',
    );
  } catch (err) {
    console.error('[external-session] popLastUserMessageForRetry: failed to persist truncation:', err);
    return { success: false, error: 'Failed to persist truncation' };
  }
  return { success: true, content, attachments };
}

export interface ExternalAssistantTurnPersistInput {
  sessionId: string | null;
  content: string | null;
  durationMs?: number;
  usage: MessageUsage | null | undefined;
  toolCount: number;
  contextUsage: ContextUsage | null;
  lastActiveAt?: string;
}

export interface ExternalAssistantTurnPersistResult {
  ok: boolean;
  failureReason?: string;
  messageCount: number;
  appendedAssistant: boolean;
}

export async function appendAndPersistExternalAssistantTurn(
  input: ExternalAssistantTurnPersistInput,
): Promise<ExternalAssistantTurnPersistResult> {
  let appendedAssistant = false;
  if (input.content) {
    allSessionMessages.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: input.content,
      timestamp: new Date().toISOString(),
      durationMs: input.durationMs,
      usage: input.usage || undefined,
      toolCount: input.toolCount || undefined,
    });
    appendedAssistant = true;
  }

  if (allSessionMessages.length === 0 || !input.sessionId) {
    return { ok: true, messageCount: allSessionMessages.length, appendedAssistant };
  }

  try {
    const saveResult = await saveSessionMessages(input.sessionId, allSessionMessages, { allowShrink: false });
    if (!saveResult.ok) {
      if (input.lastActiveAt) {
        try {
          await updateSessionMetadata(input.sessionId, { lastActiveAt: input.lastActiveAt });
        } catch (error) {
          console.error('[external-session] failed to persist terminal activity after transcript refusal:', error);
        }
      }
      return {
        ok: false,
        failureReason: describeSaveSessionMessagesFailure(saveResult),
        messageCount: allSessionMessages.length,
        appendedAssistant,
      };
    }

    const { preview: lastMessagePreview } =
      resolveLastVisibleTurnPreview(allSessionMessages);
    await updateSessionMetadata(input.sessionId, {
      lastMessagePreview,
      runtimeUsageTotals: lastPersistedRuntimeUsageTotals ?? undefined,
      ...(input.contextUsage ? { lastContextUsage: input.contextUsage } : {}),
      ...(input.lastActiveAt ? { lastActiveAt: input.lastActiveAt } : {}),
    });
    return { ok: true, messageCount: allSessionMessages.length, appendedAssistant };
  } catch (err) {
    return {
      ok: false,
      failureReason: err instanceof Error ? err.message : String(err),
      messageCount: allSessionMessages.length,
      appendedAssistant,
    };
  }
}
