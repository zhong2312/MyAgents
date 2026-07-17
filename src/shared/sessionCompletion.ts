import type { SessionOrigin } from './session-origin';

export type SessionCompletionStatus = 'complete' | 'stopped' | 'error';

export type SessionCompletionTerminal = Readonly<{
  sessionId: string;
  workspacePath: string;
  turnId: string;
  turnOwner?: Readonly<{
    kind: 'goal' | 'task';
    id: string;
  }>;
  origin: SessionOrigin;
  status: SessionCompletionStatus;
}>;

export function withSessionCompletionTerminal(
  payload: unknown,
  completionTerminal: SessionCompletionTerminal | null,
): unknown {
  if (!completionTerminal) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...payload, completionTerminal };
  }
  if (typeof payload === 'string') {
    return { message: payload, completionTerminal };
  }
  return { completionTerminal };
}
