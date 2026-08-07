import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../shared/types/agent';
import type { InboxTurnMeta, PendingInboxMessage } from './types';

const mocks = vi.hoisted(() => ({
  claimPreparedSessionForTurnAdmission: vi.fn(),
  deleteSession: vi.fn(),
  getSessionData: vi.fn(),
  getSessionMetadata: vi.fn(),
  saveSessionMetadata: vi.fn(),
  createMaterializedSessionMetadata: vi.fn(),
  cancellableFetch: vi.fn(),
}));

vi.mock('../SessionStore', () => ({
  claimPreparedSessionForTurnAdmission: mocks.claimPreparedSessionForTurnAdmission,
  deleteSession: mocks.deleteSession,
  getSessionData: mocks.getSessionData,
  getSessionMetadata: mocks.getSessionMetadata,
  saveSessionMetadata: mocks.saveSessionMetadata,
}));

vi.mock('../utils/session-materialization', () => ({
  createMaterializedSessionMetadata: mocks.createMaterializedSessionMetadata,
}));

vi.mock('../utils/cancellation', () => ({
  cancellableFetch: mocks.cancellableFetch,
}));

import { handleInboxDrain } from './drain-handler';
import { deliverInboxReply } from './reply-deliver';
import { handleFreshSessionStart, type FreshSessionInjector } from './start-handler';

describe('fresh Agent Session collaboration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MYAGENTS_MANAGEMENT_PORT = '31500';
    mocks.getSessionData.mockReturnValue(null);
    mocks.getSessionMetadata.mockImplementation((sessionId: string) => ({
      id: sessionId,
      agentDir: sessionId === 'source-session' ? '/source/workspace' : '/target/workspace',
      title: sessionId === 'source-session' ? 'Source Agent' : 'Target Agent',
    }));
    // Fresh admission must observe an empty target before materialization.
    mocks.getSessionMetadata.mockReturnValueOnce(null);
    mocks.saveSessionMetadata.mockResolvedValue(undefined);
    mocks.createMaterializedSessionMetadata.mockReturnValue({
      id: 'fresh-session',
      agentDir: '/target/workspace',
      title: 'Review this change',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastActiveAt: '2026-08-01T00:00:00.000Z',
    });
    mocks.claimPreparedSessionForTurnAdmission.mockResolvedValue({ status: 'claimed' });
    mocks.deleteSession.mockResolvedValue({ deleted: true });
  });

  it('returns admission before terminal and correlates exactly one send.result to the receipt message', async () => {
    const request: PendingInboxMessage = {
      messageId: 'receipt-message-id',
      fromSessionId: 'source-session',
      fromLabel: 'Source Agent',
      toSessionId: 'fresh-session',
      text: 'Review this change',
      replyBack: true,
      kind: 'request',
    };
    let admittedInboxMeta: InboxTurnMeta | undefined;
    let terminalReached = false;
    const targetInjector: FreshSessionInjector = async (_text, options) => {
      admittedInboxMeta = options.inboxMeta;
      const acceptance = await options.beforeDispatch();
      return {
        queued: true,
        queueId: options.queueId,
        dispatchAcceptance: Promise.resolve(acceptance),
      };
    };

    const admission = await handleFreshSessionStart(
      request,
      {
        sessionId: 'fresh-session',
        workspacePath: '/target/workspace',
        agent: { id: 'target-agent', name: 'Target Agent' } as AgentConfig,
        runtime: 'codex',
        runtimeSource: 'system-cli',
      },
      targetInjector,
    );

    expect(admission).toEqual({ accepted: true });
    expect(terminalReached).toBe(false);
    expect(admittedInboxMeta?.originalMessageId).toBe(request.messageId);

    const callerPrompts: string[] = [];
    const replyEnvelopes: PendingInboxMessage[] = [];
    mocks.cancellableFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body)) as { message: PendingInboxMessage };
      replyEnvelopes.push(envelope.message);
      const drained = await handleInboxDrain(
        [envelope.message],
        async (prompt, inboxMeta) => {
          callerPrompts.push(prompt);
          expect(inboxMeta).toBeUndefined();
          return { queued: true };
        },
      );
      expect(drained).toEqual({ accepted: true });
      return new Response(JSON.stringify({
        ok: true,
        outcome: { status: 'delivered', message_id: envelope.message.messageId },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    terminalReached = true;
    await expect(deliverInboxReply(
      'fresh-session',
      admittedInboxMeta!,
      { text: 'Review complete' },
    )).resolves.toBe(true);

    expect(replyEnvelopes).toHaveLength(1);
    expect(replyEnvelopes[0]).toMatchObject({
      kind: 'reply',
      fromSessionId: 'fresh-session',
      toSessionId: 'source-session',
      replyBack: false,
      sessionEvent: {
        type: 'send.result',
        requestEventId: request.messageId,
        status: 'ok',
        payload: 'Review complete',
      },
    });
    expect(callerPrompts).toHaveLength(1);
    expect(callerPrompts[0]).toContain('type="send.result"');
    expect(callerPrompts[0]).toContain(`request_event_id="${request.messageId}"`);
  });
});
