export type LiveRevisionEnvelope<T = unknown> = {
  sessionId: string;
  liveRevision: number;
  payload: T;
};

export function isLiveRevisionEnvelope(value: unknown): value is LiveRevisionEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<LiveRevisionEnvelope>;
  return typeof envelope.sessionId === 'string'
    && Number.isSafeInteger(envelope.liveRevision)
    && (envelope.liveRevision ?? 0) > 0
    && Object.prototype.hasOwnProperty.call(envelope, 'payload');
}

const LIVE_RESTORE_EVENTS = new Set([
  'chat:message-replay',
  'chat:status',
  'chat:message-chunk',
  'chat:thinking-start',
  'chat:thinking-chunk',
  'chat:tool-use-start',
  'chat:server-tool-use-start',
  'chat:tool-input-delta',
  'chat:content-block-stop',
  'chat:tool-result-start',
  'chat:tool-result-delta',
  'chat:tool-result-complete',
  'chat:tool-attachment-update',
  'chat:subagent-tool-use',
  'chat:subagent-tool-input-delta',
  'chat:subagent-tool-result-start',
  'chat:subagent-tool-result-delta',
  'chat:subagent-tool-result-complete',
  'chat:subagent-tool-attachment-update',
  'chat:message-sdk-uuid',
  'chat:messages-retracted',
  'chat:message-complete',
  'chat:message-stopped',
  'chat:message-error',
  'permission:request',
  'permission:expired',
  'ask-user-question:request',
  'ask-user-question:expired',
  'exit-plan-mode:request',
  'exit-plan-mode:expired',
  'enter-plan-mode:request',
  'enter-plan-mode:expired',
  'queue:started',
]);

export function participatesInLiveRestore(event: string, data: unknown): boolean {
  if (!LIVE_RESTORE_EVENTS.has(event)) return false;
  if (event === 'chat:message-error') {
    return Boolean(data)
      && typeof data === 'object'
      && Boolean((data as { completionTerminal?: unknown }).completionTerminal);
  }
  if (event === 'enter-plan-mode:request') {
    return !data || typeof data !== 'object' || !(data as { autoApproved?: unknown }).autoApproved;
  }
  if (event !== 'chat:message-replay') return true;
  return Boolean(data)
    && typeof data === 'object'
    && (data as { replayKind?: unknown }).replayKind === 'live-user-echo';
}
