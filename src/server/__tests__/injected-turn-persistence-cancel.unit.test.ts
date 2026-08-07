import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));
const storeMocks = vi.hoisted(() => {
  const cursor = { persistedMessageCount: 0 } as never;
  return {
    cursor,
    appendSessionMessages: vi.fn(),
    mutateSessionTranscript: vi.fn(),
    loadSessionTranscript: vi.fn(),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (...args: unknown[]) => sdkMocks.query(...args),
  };
});

vi.mock('../sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sse')>();
  return {
    ...actual,
    broadcast: vi.fn(),
    broadcastLive: vi.fn(),
  };
});

vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return {
    ...actual,
    commitPreparedSessionForFirstUserTurn: vi.fn(),
    saveSessionMetadata: vi.fn(async () => undefined),
    appendSessionMessages: storeMocks.appendSessionMessages,
    mutateSessionTranscript: storeMocks.mutateSessionTranscript,
    loadSessionTranscript: storeMocks.loadSessionTranscript,
  };
});

import {
  appendSessionMessages,
  commitPreparedSessionForFirstUserTurn,
  mutateSessionTranscript,
  saveSessionMetadata,
} from '../SessionStore';
import { broadcast, broadcastLive } from '../sse';
import {
  cancelImRequest,
  cancelQueueItem,
  cancelQueuedTurnsByOwner,
  enqueueUserMessage,
  getDispatchedTurnIdentity,
  getMessages,
  initializeAgent,
  interruptCurrentResponse,
} from '../agent-session';
import {
  beginPromotedItem,
  resetQueueForTest,
  setCommittingTurnAdmissionQueueId,
} from '../builtin-session/queue';
import { isAbortRequested } from '../builtin-session/lifecycle';
import { peekPendingOutputOwner } from '../builtin-session/turn';
import type { MessageQueueItem } from '../builtin-session/types';
import type { DispatchGuard } from '../session-core/turn-queue';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import { imRequestRegistry } from '../utils/im-request-registry';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function createPromptDrainingQuery(options: { prompt: AsyncIterable<unknown> }) {
  const prompt = options.prompt[Symbol.asyncIterator]();
  const iterator = (async function* () {
    while (true) {
      const next = await prompt.next();
      if (next.done) return;
      yield* [];
    }
  })();
  return Object.assign(iterator, {
    initializationResult: vi.fn(async () => ({ commands: [] })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(),
    mcpServerStatus: vi.fn(async () => []),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setMcpServers: vi.fn(async () => undefined),
  });
}

describe('injected-turn cancellation before user persistence', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    sdkMocks.query.mockImplementation(createPromptDrainingQuery);
    storeMocks.loadSessionTranscript.mockResolvedValue({
      messages: [],
      cursor: storeMocks.cursor,
      hasMalformedRows: false,
    });
    vi.mocked(appendSessionMessages).mockResolvedValue({
      ok: true,
      action: 'appended',
      count: 0,
      totalCount: 0,
      cursor: storeMocks.cursor,
    });
    vi.mocked(mutateSessionTranscript).mockResolvedValue({
      ok: true,
      action: 'noop',
      cursor: storeMocks.cursor,
    });
    resetQueueForTest();
    await initializeAgent('/tmp/myagents-mcp-readiness-cancel', null, undefined, {
      preWarmDisabled: true,
    });
  });

  it('rejects and retracts an ordinary user row when transcript persistence fails', async () => {
    vi.mocked(appendSessionMessages).mockResolvedValueOnce({
      ok: false,
      reason: 'write-error',
      error: 'disk full',
      cursor: storeMocks.cursor,
    });

    await expect(enqueueUserMessage(
      'must not survive a failed write',
      [], undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY },
    )).rejects.toThrow('failed to append transcript');

    expect(getMessages()).not.toContainEqual(expect.objectContaining({
      role: 'user',
      content: 'must not survive a failed write',
    }));
    expect(vi.mocked(appendSessionMessages)).toHaveBeenCalledOnce();
    expect(vi.mocked(mutateSessionTranscript)).toHaveBeenCalledWith(
      expect.any(String),
      storeMocks.cursor,
      expect.objectContaining({ kind: 'builtin-admission-rollback' }),
    );
    const retractionEvents = [
      ...vi.mocked(broadcast).mock.calls,
      ...vi.mocked(broadcastLive).mock.calls,
    ].filter(([event]) => event === 'chat:messages-retracted');
    expect(retractionEvents).toContainEqual([
      'chat:messages-retracted',
      expect.objectContaining({ retractedStreamingTail: false }),
      expect.anything(),
    ]);
    expect(sdkMocks.query).not.toHaveBeenCalled();
  });

  it('cancels an admitted IM request while its user row is persisting before SDK yield', async () => {
    vi.useFakeTimers();
    const persistenceStarted = deferred<void>();
    const releasePersistence = deferred<{
      ok: true;
      action: 'appended';
      count: number;
      totalCount: number;
      cursor: never;
    }>();
    vi.mocked(appendSessionMessages).mockImplementationOnce(async () => {
      persistenceStarted.resolve();
      return releasePersistence.promise;
    });
    const beforeDispatch: DispatchGuard = Object.assign(
      vi.fn(async () => ({ accepted: true })),
      { cancel: vi.fn() },
    );
    imRequestRegistry.register('request-admission-persist', null);

    const admission = await enqueueUserMessage(
      'cancel during admission persistence',
      [], undefined, undefined, undefined, undefined, undefined,
      'request-admission-persist', undefined, undefined, undefined,
      {
        queueId: 'queue-admission-persist',
        turnOwner: { kind: 'task', id: 'task-admission-persist' },
        queueResponseModeOverride: 'turn',
        beforeDispatch,
        channelDelivery: NO_CHANNEL_DELIVERY,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    await persistenceStarted.promise;
    await expect(admission.dispatchAcceptance).resolves.toEqual({ accepted: true });
    expect(peekPendingOutputOwner()).toBeNull();

    const cancellation = cancelImRequest('request-admission-persist', 'user');
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(cancellation).resolves.toEqual({ aborted: true, mode: 'running' });
    expect(imRequestRegistry.get('request-admission-persist')).toBeUndefined();

    releasePersistence.resolve({
      ok: true,
      action: 'appended',
      count: 1,
      totalCount: 1,
      cursor: storeMocks.cursor,
    });
    await vi.runAllTicks();
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
        channelDelivery: NO_CHANNEL_DELIVERY,
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
        channelDelivery: NO_CHANNEL_DELIVERY,
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
      channelDelivery: NO_CHANNEL_DELIVERY,
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

  it('does not report pre-dispatch cancellation after the durable admission CAS starts', async () => {
    const item: MessageQueueItem = {
      id: 'prepared-admission-commit',
      message: { role: 'user', content: 'commit prepared session' },
      messageText: 'commit prepared session',
      wasQueued: false,
      resolve: vi.fn(),
      channelDelivery: NO_CHANNEL_DELIVERY,
    };
    beginPromotedItem(item);
    setCommittingTurnAdmissionQueueId(item.id);

    await expect(cancelQueueItem(item.id)).resolves.toEqual({ status: 'not_cancelled' });
    expect(getDispatchedTurnIdentity()).toEqual({ queueId: item.id });
    expect(item.resolve).not.toHaveBeenCalled();
  });

  it('stops the session when a deadline expires during the durable admission CAS', async () => {
    const item: MessageQueueItem = {
      id: 'prepared-admission-timeout',
      message: { role: 'user', content: 'commit prepared session' },
      messageText: 'commit prepared session',
      wasQueued: false,
      resolve: vi.fn(),
      channelDelivery: NO_CHANNEL_DELIVERY,
    };
    beginPromotedItem(item);
    setCommittingTurnAdmissionQueueId(item.id);

    await expect(interruptCurrentResponse('timeout')).resolves.toBe(true);
    expect(isAbortRequested()).toBe(true);
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
        channelDelivery: NO_CHANNEL_DELIVERY,
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
        channelDelivery: NO_CHANNEL_DELIVERY,
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
