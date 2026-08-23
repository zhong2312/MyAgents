import type { InboxTurnMeta } from '../../inbox/types';
import { imEventBus, type ImEventType } from '../../utils/im-event-bus';
import { imRequestRegistry } from '../../utils/im-request-registry';
import type { ExternalPendingInteractiveRequest } from './types';

let activeRequestId: string | null = null;
let currentTurnInboxMeta: InboxTurnMeta | null = null;

const currentTurnAttachmentHints: string[] = [];
const pendingPermissionSuggestions = new Map<string, unknown[] | undefined>();
const pendingExternalAskUserQuestions = new Map<string, { input: Record<string, unknown> }>();
const pendingExternalInteractiveRequests = new Map<string, ExternalPendingInteractiveRequest>();

export function resetExternalInteractiveState(): void {
  activeRequestId = null;
  currentTurnInboxMeta = null;
  currentTurnAttachmentHints.length = 0;
  pendingPermissionSuggestions.clear();
  pendingExternalAskUserQuestions.clear();
  pendingExternalInteractiveRequests.clear();
}

export function getExternalActiveRequestId(): string | null {
  return activeRequestId;
}

export function getExternalImBridgeTurnContext(): import('../../session-core/im-bridge-types').ImBridgeTurnContext | null {
  return activeRequestId
    ? imRequestRegistry.get(activeRequestId)?.imBridgeTurnContext ?? null
    : null;
}

export function setExternalActiveRequestId(requestId: string | null | undefined): void {
  activeRequestId = requestId ?? null;
}

export function clearExternalActiveRequestId(): void {
  activeRequestId = null;
}

/** Pattern B — emit per-request IM event. Subscribers in /api/im/chat filter
 *  by matching requestId. No-op when no active IM trace (desktop / cron). */
export function fireExternalImCallback(type: ImEventType, data: unknown): void {
  if (activeRequestId !== null) {
    imEventBus.emit(activeRequestId, type, data);
  }
}

export function finalizeExternalActiveRequest(status: 'completed' | 'failed'): void {
  if (activeRequestId) {
    imRequestRegistry.setStatus(activeRequestId, status);
    imRequestRegistry.unregister(activeRequestId);
  }
  activeRequestId = null;
}

/** Settle one admitted-but-not-yet-running IM request by its own trace id. */
export function finalizeExternalQueuedImRequest(
  requestId: string,
  terminal: 'cancelled' | 'failed',
  eventData: unknown,
): void {
  imEventBus.emit(requestId, terminal === 'cancelled' ? 'cancelled' : 'error', eventData);
  imRequestRegistry.setStatus(requestId, terminal);
  imRequestRegistry.unregister(requestId);
}

export function setExternalTurnInboxMeta(meta: InboxTurnMeta | null): void {
  currentTurnInboxMeta = meta;
}

export function getExternalTurnInboxMeta(): InboxTurnMeta | null {
  return currentTurnInboxMeta;
}

export function clearExternalTurnInboxMeta(): void {
  currentTurnInboxMeta = null;
}

export function resetExternalTurnAttachmentHints(): void {
  currentTurnAttachmentHints.length = 0;
}

export function addExternalTurnAttachmentHint(hint: string): void {
  currentTurnAttachmentHints.push(hint);
}

export function getExternalTurnAttachmentHintsSnapshot(): string[] {
  return [...currentTurnAttachmentHints];
}

export function snapshotExternalTurnReplyState(): {
  inboxMeta: InboxTurnMeta | null;
  attachmentHints: string[];
} {
  const inboxMeta = currentTurnInboxMeta;
  currentTurnInboxMeta = null;
  const attachmentHints = currentTurnAttachmentHints.splice(0);
  return { inboxMeta, attachmentHints };
}

export function deliverExternalWatchError(input: {
  sessionId: string | null | undefined;
  text: string;
  errorCode: string;
  errorMessage: string;
}): void {
  if (!input.sessionId) return;
  const attachmentHintSnapshot = getExternalTurnAttachmentHintsSnapshot();
  const attachmentHints = attachmentHintSnapshot.length > 0
    ? attachmentHintSnapshot
    : undefined;
  void import('../../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
    deliverSessionWatchEvents(input.sessionId!, {
      text: input.text,
      error: { code: input.errorCode, message: input.errorMessage },
      attachmentHints,
    }),
  ).catch((err) =>
    console.error('[session-watch] external failure watch push failed:', err),
  );
}

/**
 * PRD 0.2.18 — clear inbox meta + push error reply if needed when
 * sendExternalMessage rejects BEFORE persistTurnResult ever runs (Case 1/2/3
 * throw paths). Without this helper the meta would leak to the next turn and
 * a stale reply would be pushed to the wrong caller.
 */
export function clearExternalInboxMetaOnRejection(input: {
  sessionId: string | null | undefined;
  errorCode: string;
  errorMessage: string;
}): void {
  const meta = currentTurnInboxMeta;
  if (!meta) return;
  currentTurnInboxMeta = null;
  resetExternalTurnAttachmentHints();
  if (!meta.replyBack) return;
  const sid = input.sessionId || meta.fromSessionId; // best-effort
  void import('../../inbox/reply-deliver').then(({ deliverInboxReply }) =>
    deliverInboxReply(sid, meta, {
      text: '',
      error: { code: input.errorCode, message: input.errorMessage },
    }),
  ).catch((err) =>
    console.error('[inbox] external rejection reply pushback failed:', err),
  );
}

export function setExternalPermissionSuggestions(requestId: string, suggestions: unknown[] | undefined): void {
  pendingPermissionSuggestions.set(requestId, suggestions);
}

export function consumeExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  const suggestions = pendingPermissionSuggestions.get(requestId);
  pendingPermissionSuggestions.delete(requestId);
  return suggestions;
}

export function getExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  return pendingPermissionSuggestions.get(requestId);
}

export function clearExternalPermissionSuggestions(): void {
  pendingPermissionSuggestions.clear();
}

export function setExternalAskUserQuestion(
  requestId: string,
  value: { input: Record<string, unknown> },
): void {
  pendingExternalAskUserQuestions.set(requestId, value);
}

export function getExternalAskUserQuestion(
  requestId: string,
): { input: Record<string, unknown> } | undefined {
  return pendingExternalAskUserQuestions.get(requestId);
}

export function hasExternalAskUserQuestion(requestId: string): boolean {
  return pendingExternalAskUserQuestions.has(requestId);
}

export function deleteExternalAskUserQuestion(requestId: string): void {
  pendingExternalAskUserQuestions.delete(requestId);
}

export function clearExternalAskUserQuestions(): void {
  pendingExternalAskUserQuestions.clear();
}

export function setExternalInteractiveRequest(
  requestId: string,
  request: ExternalPendingInteractiveRequest,
): void {
  pendingExternalInteractiveRequests.set(requestId, request);
}

export function getExternalInteractiveRequest(requestId: string): ExternalPendingInteractiveRequest | undefined {
  return pendingExternalInteractiveRequests.get(requestId);
}

export function deleteExternalInteractiveRequest(requestId: string): void {
  pendingExternalInteractiveRequests.delete(requestId);
}

export function getExternalInteractiveRequestEntries(): IterableIterator<[string, ExternalPendingInteractiveRequest]> {
  return pendingExternalInteractiveRequests.entries();
}

export function getExternalInteractiveRequestsSnapshot(): ExternalPendingInteractiveRequest[] {
  return Array.from(pendingExternalInteractiveRequests.values());
}

export function hasExternalInteractiveRequests(): boolean {
  return pendingExternalInteractiveRequests.size > 0;
}

export function clearExternalInteractiveRequests(): void {
  pendingExternalInteractiveRequests.clear();
}
