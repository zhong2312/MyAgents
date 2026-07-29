import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sse')>();
  return {
    ...actual,
    broadcast: vi.fn(),
    broadcastLive: vi.fn(),
  };
});

import { broadcast, broadcastLive } from '../sse';
import {
  cancelQueueItem,
  enqueueUserMessage,
  getQueueStatus,
  initializeAgent,
  resetSession,
} from '../agent-session';
import { resetConfigForTest } from '../builtin-session/config';
import {
  resetLifecycleForTest,
  setQuerySession,
  setSessionTerminationPromise,
} from '../builtin-session/lifecycle';
import {
  beginPromotedItem,
  resetQueueForTest,
  setTurnAdmissionTicket,
} from '../builtin-session/queue';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import type { MessageQueueItem } from '../builtin-session/types';
import type { DispatchGuard } from '../session-core/turn-queue';

function acceptedGuard(): DispatchGuard {
  return Object.assign(
    vi.fn(async () => ({ accepted: true })),
    { cancel: vi.fn() },
  );
}

function visibleEvents(): string[] {
  return [
    ...vi.mocked(broadcast).mock.calls.map(([event]) => event),
    ...vi.mocked(broadcastLive).mock.calls.map(([event]) => event),
  ];
}

describe('injected-turn invisible admission reservation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-invisible-admission', null, undefined, {
      preWarmDisabled: true,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not emit status or queue UI before a direct infrastructure turn commits', async () => {
    const result = await enqueueUserMessage(
      'direct infrastructure turn', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        queueId: 'invisible-direct-admission',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-direct' },
        channelDelivery: NO_CHANNEL_DELIVERY,
        beforeUserPersistence: acceptedGuard(),
        beforeDispatch: acceptedGuard(),
      },
    );

    expect(result).toMatchObject({ queueId: 'invisible-direct-admission' });
    expect(visibleEvents()).not.toContain('chat:status');
    expect(visibleEvents()).not.toContain('queue:added');
    await cancelQueueItem('invisible-direct-admission');
    expect(visibleEvents()).not.toContain('queue:cancelled');
  });

  it('keeps a busy turn-boundary preflight out of queue status and SSE', async () => {
    setTurnAdmissionTicket({
      queueId: 'existing-admission',
      createdAt: Date.now(),
      messageText: 'existing',
      canceled: false,
    });
    const result = await enqueueUserMessage(
      'queued infrastructure turn', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        queueId: 'invisible-turn-boundary-admission',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-queued' },
        channelDelivery: NO_CHANNEL_DELIVERY,
        beforeUserPersistence: acceptedGuard(),
        beforeDispatch: acceptedGuard(),
      },
    );

    expect(result).toMatchObject({
      queued: true,
      queueId: 'invisible-turn-boundary-admission',
    });
    expect(visibleEvents()).not.toContain('chat:status');
    expect(visibleEvents()).not.toContain('queue:added');
    expect(getQueueStatus()).not.toContainEqual(expect.objectContaining({
      id: 'invisible-turn-boundary-admission',
    }));

    await cancelQueueItem('invisible-turn-boundary-admission');
    expect(visibleEvents()).not.toContain('queue:cancelled');
  });

  it('keeps cold-start messageQueue admission invisible when reset drains it', async () => {
    await enqueueUserMessage(
      'cold infrastructure turn', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        queueId: 'invisible-reset-message',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-reset-message' },
        channelDelivery: NO_CHANNEL_DELIVERY,
        beforeUserPersistence: acceptedGuard(),
        beforeDispatch: acceptedGuard(),
      },
    );
    setQuerySession({ close: vi.fn(), interrupt: vi.fn(async () => undefined) } as never);

    await resetSession();

    expect(visibleEvents()).not.toContain('queue:cancelled');
  });

  it('keeps ready turn-boundary admission invisible when reset drains it', async () => {
    setTurnAdmissionTicket({
      queueId: 'existing-reset-admission',
      createdAt: Date.now(),
      messageText: 'existing',
      canceled: false,
    });
    await enqueueUserMessage(
      'ready infrastructure turn', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        queueId: 'invisible-reset-boundary',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-reset-boundary' },
        channelDelivery: NO_CHANNEL_DELIVERY,
        beforeUserPersistence: acceptedGuard(),
        beforeDispatch: acceptedGuard(),
      },
    );
    setQuerySession({ close: vi.fn(), interrupt: vi.fn(async () => undefined) } as never);

    await resetSession();

    expect(visibleEvents()).not.toContain('queue:cancelled');
  });

  it('keeps canonical reset behind a promoted domain rollback acknowledgement', async () => {
    let releaseRollback!: () => void;
    const rollback = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const onTerminal = vi.fn();
    const beforeDispatch: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn(() => rollback) },
    );
    const item: MessageQueueItem = {
      id: 'reset-promoted-rollback',
      message: { role: 'user', content: 'continue Goal' },
      messageText: 'continue Goal',
      wasQueued: false,
      resolve: vi.fn(),
      beforeDispatch,
      onTerminal,
      channelDelivery: NO_CHANNEL_DELIVERY,
    };
    beginPromotedItem(item);
    setQuerySession({
      close: vi.fn(),
      interrupt: vi.fn(async () => undefined),
    } as never);
    setSessionTerminationPromise(Promise.resolve());

    let resetSettled = false;
    const reset = resetSession().then(() => { resetSettled = true; });
    await vi.waitFor(() => expect(beforeDispatch.cancel).toHaveBeenCalledOnce());

    expect(resetSettled).toBe(false);
    expect(onTerminal).not.toHaveBeenCalled();

    releaseRollback();
    await reset;
    expect(resetSettled).toBe(true);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      error: 'Session aborted before queue dispatch',
    }));
  });
});
