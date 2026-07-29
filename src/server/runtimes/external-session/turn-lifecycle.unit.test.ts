import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitExternalRealtimeChannelDelivery,
  admitExternalTurnChannelDelivery,
  beginExternalTurnPromotion,
  bindExternalTurn,
  cancelExternalTurnPromotion,
  captureExternalAssistantChannelDelivery,
  commitExternalAssistantChannelDelivery,
  finishExternalTurnPromotion,
  getExternalCurrentTurnIdentity,
  getExternalTurnTerminalGeneration,
  isExternalTurnPromotionCurrent,
  isExternalTurnPromotionInFlight,
  markExternalSessionComplete,
  markExternalTurnComplete,
  markExternalTurnStarted,
  notifyExternalTurnOutcome,
  notifyExternalTurnStopped,
  resetExternalTurnLifecycleState,
  stageExternalAssistantChannelDelivery,
  setExternalTurnCompleted,
  waitForExternalTurnTerminalObserver,
} from './turn-lifecycle';
import {
  CALLER_OWNED_CHANNEL_DELIVERY,
  DESKTOP_CHANNEL_DELIVERY,
  NO_CHANNEL_DELIVERY,
} from '../../session-core/channel-delivery';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('external turn lifecycle owner', () => {
  beforeEach(() => {
    resetExternalTurnLifecycleState();
  });

  it('keeps assistant Session delivery independent from a failed Desktop user mirror', async () => {
    const deliverAssistant = vi.fn(async () => undefined);
    admitExternalTurnChannelDelivery(DESKTOP_CHANNEL_DELIVERY, {
      kind: 'deliver-session-bound-user',
      waitForPersistence: Promise.resolve(true),
      deliverUser: async () => {
        throw new Error('user mirror failed');
      },
    });

    expect(stageExternalAssistantChannelDelivery(deliverAssistant)).toBe(true);
    commitExternalAssistantChannelDelivery(captureExternalAssistantChannelDelivery());
    await vi.waitFor(() => expect(deliverAssistant).toHaveBeenCalledOnce());
  });

  it('does not let a Desktop realtime steer displace a caller-owned response transport', () => {
    admitExternalTurnChannelDelivery(CALLER_OWNED_CHANNEL_DELIVERY, { kind: 'skip' });
    admitExternalRealtimeChannelDelivery(DESKTOP_CHANNEL_DELIVERY, { kind: 'skip' });

    expect(stageExternalAssistantChannelDelivery(vi.fn(async () => undefined))).toBe(false);

    admitExternalTurnChannelDelivery(NO_CHANNEL_DELIVERY, { kind: 'skip' });
    admitExternalRealtimeChannelDelivery(DESKTOP_CHANNEL_DELIVERY, { kind: 'skip' });
    expect(stageExternalAssistantChannelDelivery(vi.fn(async () => undefined))).toBe(true);
  });

  it('does not release a completed assistant block until the success owner commits it', async () => {
    const deliverAssistant = vi.fn(async () => undefined);
    admitExternalTurnChannelDelivery(DESKTOP_CHANNEL_DELIVERY, { kind: 'skip' });

    expect(stageExternalAssistantChannelDelivery(deliverAssistant)).toBe(true);
    const batch = captureExternalAssistantChannelDelivery();
    await Promise.resolve();
    expect(deliverAssistant).not.toHaveBeenCalled();

    commitExternalAssistantChannelDelivery(batch);
    await vi.waitFor(() => expect(deliverAssistant).toHaveBeenCalledOnce());
  });

  it('keeps channel delivery ordered across turn boundaries', async () => {
    const firstUserTransport = deferred();
    const delivered: string[] = [];
    admitExternalTurnChannelDelivery(DESKTOP_CHANNEL_DELIVERY, {
      kind: 'deliver-session-bound-user',
      waitForPersistence: Promise.resolve(true),
      deliverUser: async () => {
        await firstUserTransport.promise;
        delivered.push('user-a');
      },
    });
    stageExternalAssistantChannelDelivery(async () => { delivered.push('assistant-a'); });
    const batchA = captureExternalAssistantChannelDelivery();

    // The next turn can be admitted while A is still persisting. Its user
    // projection must join after A's already-reserved assistant position.
    admitExternalTurnChannelDelivery(DESKTOP_CHANNEL_DELIVERY, {
      kind: 'deliver-session-bound-user',
      waitForPersistence: Promise.resolve(true),
      deliverUser: async () => { delivered.push('user-b'); },
    });
    stageExternalAssistantChannelDelivery(async () => { delivered.push('assistant-b'); });
    const batchB = captureExternalAssistantChannelDelivery();
    commitExternalAssistantChannelDelivery(batchB);

    await Promise.resolve();
    expect(delivered).toEqual([]);
    commitExternalAssistantChannelDelivery(batchA);
    firstUserTransport.resolve();
    await vi.waitFor(() => expect(delivered).toEqual([
      'user-a',
      'assistant-a',
      'user-b',
      'assistant-b',
    ]));
  });

  it('ignores a prewarm process exit when no external turn started', () => {
    setExternalTurnCompleted(false);

    const plan = markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'error', result: 'process exited' },
      {
        hasAssistantText: true,
        isUserRequestedStop: () => true,
      },
    );

    expect(plan).toEqual({ kind: 'ignore-prewarm-exit', subtype: 'error' });
  });

  it('routes a runtime-started resumed turn through user-stop handling', () => {
    setExternalTurnCompleted(false);
    markExternalTurnStarted(123);

    const plan = markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'error', result: 'process exited' },
      {
        hasAssistantText: true,
        isUserRequestedStop: () => true,
      },
    );

    expect(plan.kind).toBe('suppress-user-stop');
  });

  it('invalidates a guarded turn promotion exactly once on Stop', async () => {
    const cancelDispatch = vi.fn();
    const promotion = beginExternalTurnPromotion({
      queueId: 'goal-turn',
      owner: { kind: 'goal', id: 'goal-1' },
      cancelDispatch,
    });
    expect(promotion).not.toBeNull();
    expect(beginExternalTurnPromotion()).toBeNull();
    expect(isExternalTurnPromotionInFlight()).toBe(true);
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(true);
    expect(getExternalCurrentTurnIdentity()).toEqual({
      queueId: 'goal-turn',
      owner: { kind: 'goal', id: 'goal-1' },
    });

    expect(cancelExternalTurnPromotion({ preserveQueue: true })).toBe(promotion);
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(promotion?.signal.aborted).toBe(true);
    expect(promotion?.preserveQueueOnCancel).toBe(true);
    expect(cancelExternalTurnPromotion()).toBeNull();
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(false);
    expect(isExternalTurnPromotionInFlight()).toBe(false);

    finishExternalTurnPromotion(promotion!);
    await expect(promotion?.settled).resolves.toEqual({ status: 'not-dispatched' });
    expect(isExternalTurnPromotionInFlight()).toBe(false);
  });

  it('keeps only ambiguous or dispatched promotion bindings addressable', async () => {
    const owner = { kind: 'task' as const, id: 'task-1' };
    const canceled = beginExternalTurnPromotion({ queueId: 'queue-canceled', owner })!;
    bindExternalTurn('queue-canceled', owner);
    finishExternalTurnPromotion(canceled, { status: 'not-dispatched' });
    await expect(canceled.settled).resolves.toEqual({ status: 'not-dispatched' });
    expect(getExternalCurrentTurnIdentity()).toBeNull();

    const ambiguous = beginExternalTurnPromotion({ queueId: 'queue-ambiguous', owner })!;
    bindExternalTurn('queue-ambiguous', owner);
    finishExternalTurnPromotion(ambiguous, { status: 'termination-unconfirmed' });
    await expect(ambiguous.settled).resolves.toEqual({ status: 'termination-unconfirmed' });
    expect(getExternalCurrentTurnIdentity()).toEqual({ queueId: 'queue-ambiguous', owner });
  });

  it('assigns one monotonic terminal generation to each runtime turn', () => {
    const before = getExternalTurnTerminalGeneration();
    markExternalTurnStarted(100);
    markExternalTurnComplete(
      { kind: 'turn_complete', status: 'completed' },
      { intentionalStopInProgress: false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 1);

    markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'success', result: '' },
      { hasAssistantText: true, isUserRequestedStop: () => false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 1);

    setExternalTurnCompleted(false);
    markExternalTurnStarted(200);
    markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'success', result: '' },
      { hasAssistantText: true, isUserRequestedStop: () => false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 2);
  });

  it('notifies the current queue turn once without retaining an outcome cache', async () => {
    const onTerminal = vi.fn();
    bindExternalTurn('queue-1', { kind: 'goal', id: 'goal-1' }, onTerminal);
    expect(getExternalCurrentTurnIdentity()).toEqual({
      queueId: 'queue-1',
      owner: { kind: 'goal', id: 'goal-1' },
    });

    const before = getExternalTurnTerminalGeneration();
    markExternalTurnStarted(100);
    markExternalTurnComplete(
      { kind: 'turn_complete', status: 'completed' },
      { intentionalStopInProgress: false },
    );
    notifyExternalTurnOutcome(before + 1, {
      success: true,
      text: 'target result',
      durationMs: 3_500,
      usage: { inputTokens: 700, outputTokens: 80 },
    });
    notifyExternalTurnOutcome(before + 1, {
      success: true,
      text: 'duplicate',
    });
    await waitForExternalTurnTerminalObserver();

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'complete',
      text: 'target result',
      assistantMessagePresent: true,
      durationMs: 3_500,
      usage: { inputTokens: 700, outputTokens: 80 },
    });
    expect(getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('settles the current queue turn when process stop has no terminal event', async () => {
    const onTerminal = vi.fn();
    bindExternalTurn('queue-stop', { kind: 'goal', id: 'goal-1' }, onTerminal);

    notifyExternalTurnStopped('partial output', {
      durationMs: 1_250,
      usage: { inputTokens: 90, outputTokens: 10 },
    });
    notifyExternalTurnStopped('duplicate');
    await waitForExternalTurnTerminalObserver();

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'stopped',
      text: 'partial output',
      assistantMessagePresent: true,
      error: 'Execution stopped',
      durationMs: 1_250,
      usage: { inputTokens: 90, outputTokens: 10 },
    });
    expect(getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('keeps the next external turn behind an async terminal observer', async () => {
    let release!: () => void;
    bindExternalTurn('queue-barrier', undefined, () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    notifyExternalTurnStopped('partial');
    notifyExternalTurnStopped('duplicate');
    let settled = false;
    void waitForExternalTurnTerminalObserver().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await waitForExternalTurnTerminalObserver();
    expect(settled).toBe(true);
  });

  it('does not run the terminal observer before durable finalization settles', async () => {
    let finishPersist!: () => void;
    const finalization = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    const onTerminal = vi.fn();
    bindExternalTurn('queue-finalization', undefined, onTerminal);

    notifyExternalTurnStopped('partial', {}, finalization);
    await Promise.resolve();
    expect(onTerminal).not.toHaveBeenCalled();

    finishPersist();
    await waitForExternalTurnTerminalObserver();
    expect(onTerminal).toHaveBeenCalledOnce();
  });
});
