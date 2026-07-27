import { describe, expect, it, vi } from 'vitest';

import { handleInboxDrain, type InboxInjector } from './drain-handler';
import type { PendingInboxMessage } from './types';

describe('handleInboxDrain scenario routing', () => {
  it('routes Space issue delivery events as registeredAgent scenario', async () => {
    const seen: Parameters<InboxInjector>[] = [];
    const injector: InboxInjector = async (...args) => {
      seen.push(args);
      return { queued: false };
    };
    const message: PendingInboxMessage = {
      messageId: 'msg-space',
      fromSessionId: 'myagents-space',
      fromLabel: 'MyAgents Space',
      toSessionId: 'session-space',
      text: '<system-reminder>\n<myagents-space-issue>\nSpace issue delivery\n</myagents-space-issue>\n</system-reminder>\nVisible Space issue',
      replyBack: false,
      kind: 'event',
      sessionEvent: {
        version: 2,
        type: 'space.issue_delivery',
        eventId: 'msg-space',
        sourceSessionId: 'myagents-space',
        sourceLabel: 'MyAgents Space',
        targetSessionId: 'session-space',
        createdAt: '2026-06-30T00:00:00.000Z',
        deliveryId: 'delivery-1',
        deliveryKind: 'subscription',
        deliveryReason: 'issue_update',
        spaceId: 'space-1',
        registeredAgentId: 'agent-1',
        sourceIssueUpdateId: 'update-1',
        fromNotificationVersionExclusive: 0,
        toNotificationVersionInclusive: 1,
        protocolVersion: 2,
        instructionRevision: 3,
        issueId: 'issue-1',
        issueTitle: 'Issue',
        issueState: 'todo',
        notificationVersion: 1,
      },
    };

    const result = await handleInboxDrain([message], injector);

    expect(result.accepted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(message.text);
    expect(seen[0][0]).toContain('<system-reminder>');
    expect(seen[0][0]).not.toContain('<myagents-session-event');
    expect(seen[0][2]).toMatchObject({
      allowLazySessionMaterialization: true,
      scenario: {
        type: 'registeredAgent',
        platform: 'space',
        sourceType: 'issue-delivery',
        spaceId: 'space-1',
        registeredAgentId: 'agent-1',
      },
    });
  });

  it('keeps ordinary inbox requests on the default scenario path', async () => {
    const seen: Parameters<InboxInjector>[] = [];
    const injector: InboxInjector = async (...args) => {
      seen.push(args);
      return { queued: false };
    };

    const result = await handleInboxDrain([{
      messageId: 'msg-request',
      fromSessionId: 'session-a',
      fromLabel: 'A',
      toSessionId: 'session-b',
      text: 'Please check this',
      replyBack: true,
      kind: 'request',
    }], injector);

    expect(result.accepted).toBe(true);
    expect(seen[0][2]?.scenario).toBeUndefined();
  });

  it('rejects a Space delivery without exact Registered Agent identity before injection', async () => {
    const injector = vi.fn<InboxInjector>(async () => ({ queued: false }));
    const malformed = {
      messageId: 'msg-malformed-space',
      fromSessionId: 'myagents-space',
      fromLabel: 'MyAgents Space',
      toSessionId: 'session-space',
      text: '<system-reminder>delivery</system-reminder>',
      replyBack: false,
      kind: 'event',
      sessionEvent: {
        version: 2,
        type: 'space.issue_delivery',
        eventId: 'msg-malformed-space',
        createdAt: '2026-07-18T00:00:00.000Z',
        spaceId: '',
        registeredAgentId: 'agent-1',
        deliveryId: 'delivery-1',
        issueId: 'issue-1',
        issueTitle: 'Issue',
        issueState: 'todo',
      },
    } satisfies PendingInboxMessage;

    const result = await handleInboxDrain([malformed], injector);

    expect(result).toMatchObject({ accepted: false });
    expect(result.reason).toContain('INVALID_REGISTERED_AGENT_ORIGIN');
    expect(injector).not.toHaveBeenCalled();
  });
});
