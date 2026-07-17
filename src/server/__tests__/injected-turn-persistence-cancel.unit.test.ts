import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return {
    ...actual,
    commitPreparedSessionForFirstUserTurn: vi.fn(),
    saveSessionMetadata: vi.fn(async () => undefined),
  };
});

import {
  commitPreparedSessionForFirstUserTurn,
  saveSessionMetadata,
} from '../SessionStore';
import {
  cancelQueueItem,
  cancelQueuedTurnsByOwner,
  enqueueUserMessage,
  initializeAgent,
} from '../agent-session';
import {
  beginPromotedItem,
  resetQueueForTest,
} from '../builtin-session/queue';
import type { MessageQueueItem } from '../builtin-session/types';
import type { DispatchGuard } from '../session-core/turn-queue';

describe('injected-turn cancellation before user persistence', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetQueueForTest();
    await initializeAgent('/tmp/myagents-mcp-readiness-cancel', null, undefined, {
      preWarmDisabled: true,
    });
  });

  it('aborts the pending infrastructure gate and writes no session metadata', async () => {
    let releaseGate!: (result: { accepted: boolean; error?: string }) => void;
    let markGateStarted!: () => void;
    const gateStarted = new Promise<void>((resolve) => {
      markGateStarted = resolve;
    });
    const gateResult = new Promise<{ accepted: boolean; error?: string }>((resolve) => {
      releaseGate = resolve;
    });
    const beforeUserPersistence: DispatchGuard = Object.assign(
      vi.fn(async () => {
        markGateStarted();
        return gateResult;
      }),
      {
        cancel: vi.fn(() => {
          releaseGate({ accepted: false, error: 'Queue item was cancelled' });
        }),
      },
    );
    const beforeDispatch: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn() },
    );

    const enqueue = enqueueUserMessage(
      'run scheduled task',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        queueId: 'cancel-before-persistence',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-1' },
        beforeUserPersistence,
        beforeDispatch,
      },
    );

    await gateStarted;
    const cancellation = await cancelQueueItem('cancel-before-persistence');
    const result = await enqueue;

    expect(cancellation).toEqual({
      status: 'cancelled',
      cancelledText: 'run scheduled task',
    });
    expect(result).toMatchObject({
      queued: false,
      error: 'Queue item was cancelled before dispatch',
    });
    expect(beforeUserPersistence.cancel).toHaveBeenCalledOnce();
    expect(beforeDispatch.cancel).toHaveBeenCalledOnce();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(saveSessionMetadata).not.toHaveBeenCalled();
    expect(commitPreparedSessionForFirstUserTurn).not.toHaveBeenCalled();
  });

  it('defers first-turn SessionStore writes until the guarded runtime admission commit', async () => {
    // Keep the deferred startStreamingSession(0) callback from launching a
    // real SDK subprocess. This test owns only the pre-dispatch queue state.
    vi.useFakeTimers();
    const beforeUserPersistence: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn() },
    );
    const beforeDispatch: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn() },
    );

    const result = await enqueueUserMessage(
      'run guarded task',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        queueId: 'deferred-session-metadata',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-2' },
        beforeUserPersistence,
        beforeDispatch,
      },
    );

    expect(result).toMatchObject({ queueId: 'deferred-session-metadata' });
    expect(beforeUserPersistence).toHaveBeenCalledOnce();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(saveSessionMetadata).not.toHaveBeenCalled();
    expect(commitPreparedSessionForFirstUserTurn).not.toHaveBeenCalled();

    await cancelQueueItem('deferred-session-metadata');
  });

  it('does not report a promoted cancellation until its domain rollback settles', async () => {
    let releaseRollback!: () => void;
    const rollback = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const beforeDispatch: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn(() => rollback) },
    );
    const item: MessageQueueItem = {
      id: 'promoted-durable-cancel',
      message: { role: 'user', content: 'continue Goal' },
      messageText: 'continue Goal',
      wasQueued: true,
      resolve: vi.fn(),
      beforeDispatch,
      settleDispatchAcceptance: vi.fn(),
    };
    beginPromotedItem(item);

    let cancellationSettled = false;
    const cancellation = cancelQueueItem(item.id).then((result) => {
      cancellationSettled = true;
      return result;
    });

    await vi.waitFor(() => expect(beforeDispatch.cancel).toHaveBeenCalledOnce());
    expect(cancellationSettled).toBe(false);
    expect(item.settleDispatchAcceptance).not.toHaveBeenCalled();

    releaseRollback();
    await expect(cancellation).resolves.toEqual({
      status: 'cancelled',
      cancelledText: 'continue Goal',
    });
    expect(item.settleDispatchAcceptance).toHaveBeenCalledWith({
      accepted: false,
      error: 'Queue item was cancelled',
    });
  });

  it('makes every concurrent infrastructure preflight addressable by owner before persistence', async () => {
    const createPendingGuard = () => {
      let started!: () => void;
      let release!: (result: { accepted: boolean; error?: string }) => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const resultPromise = new Promise<{ accepted: boolean; error?: string }>((resolve) => { release = resolve; });
      const guard: DispatchGuard = Object.assign(
        vi.fn(async () => {
          started();
          return resultPromise;
        }),
        {
          cancel: vi.fn(() => release({ accepted: false, error: 'Queue item was cancelled' })),
        },
      );
      return { guard, startedPromise };
    };
    const first = createPendingGuard();
    const second = createPendingGuard();
    const finalGuard = (): DispatchGuard => Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn() },
    );

    const firstEnqueue = enqueueUserMessage(
      'first task', [], undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      {
        queueId: 'concurrent-infrastructure-a',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-a' },
        beforeUserPersistence: first.guard,
        beforeDispatch: finalGuard(),
      },
    );
    await first.startedPromise;

    const secondEnqueue = enqueueUserMessage(
      'second task', [], undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      {
        queueId: 'concurrent-infrastructure-b',
        queueResponseModeOverride: 'turn',
        turnOwner: { kind: 'task', id: 'task-b' },
        beforeUserPersistence: second.guard,
        beforeDispatch: finalGuard(),
      },
    );
    await second.startedPromise;

    await expect(cancelQueuedTurnsByOwner({ kind: 'task', id: 'task-b' })).resolves.toBe(1);
    await expect(secondEnqueue).resolves.toMatchObject({
      queued: false,
      error: 'Queue item was cancelled before dispatch',
    });
    expect(second.guard.cancel).toHaveBeenCalledOnce();
    expect(saveSessionMetadata).not.toHaveBeenCalled();
    expect(commitPreparedSessionForFirstUserTurn).not.toHaveBeenCalled();

    await cancelQueuedTurnsByOwner({ kind: 'task', id: 'task-a' });
    await firstEnqueue;
  });
});
