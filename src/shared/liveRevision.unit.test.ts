import { describe, expect, it } from 'vitest';
import { participatesInLiveRestore } from './liveRevision';

describe('live revision event classification', () => {
  it('includes state-backed live events but excludes cold replay and transient banners', () => {
    expect(participatesInLiveRestore('chat:message-chunk', 'delta')).toBe(true);
    expect(participatesInLiveRestore('chat:message-stopped', null)).toBe(true);
    expect(participatesInLiveRestore('chat:message-replay', { replayKind: 'live-user-echo' })).toBe(true);
    expect(participatesInLiveRestore('chat:message-replay', { replayKind: 'cold-history' })).toBe(false);
    expect(participatesInLiveRestore('chat:message-error', 'temporary failure')).toBe(false);
    expect(participatesInLiveRestore('chat:message-error', {
      message: 'terminal failure',
      completionTerminal: {
        sessionId: 'session-a',
        workspacePath: '/tmp/workspace',
        turnId: 'turn-a',
        origin: { kind: 'desktop', surface: 'launcher_input' },
        status: 'error',
      },
    })).toBe(true);
    expect(participatesInLiveRestore('chat:agent-error', { message: 'temporary failure' })).toBe(false);
  });

  it('does not revision the SDK auto-approved plan notification without pending owner state', () => {
    expect(participatesInLiveRestore('enter-plan-mode:request', { requestId: 'pending' })).toBe(true);
    expect(participatesInLiveRestore('enter-plan-mode:request', {
      requestId: 'sdk-auto',
      autoApproved: true,
    })).toBe(false);
  });
});
