import { describe, expect, it, vi } from 'vitest';

import type { ExternalRuntimeConfigSnapshot } from '../types';
import type { ExternalSendContext } from './types';
import { NO_CHANNEL_DELIVERY } from '../../session-core/channel-delivery';
import type { SessionMessage } from '../../types/session';

async function loadFreshQueueOwner() {
  vi.resetModules();
  return await import('./operation-queue');
}

type QueueOwner = Awaited<ReturnType<typeof loadFreshQueueOwner>>;
let userMessageSequence = 0;

function userMessage(content: string): SessionMessage {
  return {
    id: `user-test-${userMessageSequence++}`,
    role: 'user',
    content,
    timestamp: '2026-08-02T00:00:00.000Z',
  };
}

function enqueueMessage(
  queue: QueueOwner,
  input: Omit<Parameters<QueueOwner['enqueueExternalMessageOperation']>[0], 'userMessage'>,
) {
  return queue.enqueueExternalMessageOperation({
    ...input,
    userMessage: userMessage(input.text),
  });
}

function context(overrides: Partial<ExternalSendContext> = {}): ExternalSendContext {
  return {
    sessionId: 'session-1',
    workspacePath: '/workspace',
    scenario: { type: 'desktop' },
    channelDelivery: NO_CHANNEL_DELIVERY,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ExternalRuntimeConfigSnapshot> = {}): ExternalRuntimeConfigSnapshot {
  return {
    model: 'model-a',
    permissionMode: 'default',
    reasoningEffort: undefined,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('external operation queue owner', () => {
  it('tracks user-message projection state per in-flight operation', async () => {
    const queue = await loadFreshQueueOwner();
    const firstGate = deferred();
    const secondGate = deferred();
    const first = queue.createExternalMessageOperation({
      text: 'first',
      context: context(),
      runtimeConfig: snapshot(),
      userMessage: userMessage('first'),
    });
    const second = queue.createExternalMessageOperation({
      text: 'second',
      context: context(),
      runtimeConfig: snapshot(),
      userMessage: userMessage('second'),
    });

    queue.markExternalUserMessageSurfaced(first);
    queue.markExternalUserMessageSurfaced(second);
    const firstRun = queue.withExternalMessageOperation(first, () => firstGate.promise);
    const secondRun = queue.withExternalMessageOperation(second, () => secondGate.promise);
    expect(queue.getExternalPendingUserMessageProjections('session-1').map(message => message.content))
      .toEqual(['first', 'second']);

    queue.markExternalUserMessagePersisted(first);
    expect(queue.getExternalPendingUserMessageProjections('session-1').map(message => message.content))
      .toEqual(['second']);
    queue.markExternalUserMessageRetracted(second);
    expect(queue.getExternalPendingUserMessageProjections('session-1')).toEqual([]);

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it('claims an idle direct-send slot synchronously and releases it after the tail settles', async () => {
    const queue = await loadFreshQueueOwner();
    const releaseFirst = deferred();
    let firstStarted = false;
    let secondStarted = false;

    const first = queue.chainExternalSend(async () => {
      firstStarted = true;
      await releaseFirst.promise;
      return 'first';
    });
    expect(firstStarted).toBe(false);
    expect(queue.hasExternalSendInFlight()).toBe(true);
    await Promise.resolve();
    expect(firstStarted).toBe(true);

    const second = queue.chainExternalSend(async () => {
      secondStarted = true;
      return 'second';
    });
    expect(secondStarted).toBe(false);

    releaseFirst.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    await Promise.resolve();
    expect(queue.hasExternalSendInFlight()).toBe(false);
  });

  it('coalesces adjacent config operations and lets later fields win', async () => {
    const queue = await loadFreshQueueOwner();

    expect(queue.enqueueExternalConfigOperation({ model: 'model-a' }, 'desktop')).toBe(1);
    expect(queue.enqueueExternalConfigOperation({ permissionMode: 'full-auto' }, 'runtime-config')).toBe(1);
    expect(queue.enqueueExternalConfigOperation({ model: 'model-b' }, 'im-sync')).toBe(1);

    expect(queue.consumeLeadingExternalConfigOps()).toEqual({
      patch: {
        model: 'model-b',
        permissionMode: 'full-auto',
      },
      source: 'im-sync',
    });
    expect(queue.hasExternalQueuedOperations()).toBe(false);
  });

  it('does not coalesce config operations across a queued message', async () => {
    const queue = await loadFreshQueueOwner();

    queue.enqueueExternalConfigOperation({ model: 'model-a' }, 'desktop');
    const queued = enqueueMessage(queue, {
      text: 'hello',
      context: context(),
      runtimeConfig: snapshot({ model: 'model-a' }),
    });
    expect(queued.queued).toBe(true);
    queue.enqueueExternalConfigOperation({ permissionMode: 'plan' }, 'runtime-config');

    expect(queue.consumeLeadingExternalConfigOps()).toEqual({
      patch: { model: 'model-a' },
      source: 'desktop',
    });
    expect(queue.shiftExternalOperation()).toMatchObject({
      kind: 'message',
      text: 'hello',
      runtimeConfig: { model: 'model-a' },
    });
    expect(queue.consumeLeadingExternalConfigOps()).toEqual({
      patch: { permissionMode: 'plan' },
      source: 'runtime-config',
    });
  });

  it('reports queued and reserved messages by domain owner', async () => {
    const queue = await loadFreshQueueOwner();
    enqueueMessage(queue, {
      text: 'goal clarification',
      context: context({ turnOwner: { kind: 'goal', id: 'goal-1' } }),
      runtimeConfig: snapshot(),
    });

    expect(queue.hasExternalQueuedMessageByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);
    expect(queue.hasExternalQueuedMessageByOwner({ kind: 'goal', id: 'goal-2' })).toBe(false);
    queue.reserveExternalOperationForDrain();
    expect(queue.hasExternalQueuedMessageByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);
  });

  it('keeps each queued message bound to its enqueue-time runtime config snapshot', async () => {
    const queue = await loadFreshQueueOwner();
    const firstConfig = snapshot({ model: 'model-a', permissionMode: 'default' });
    const secondConfig = snapshot({ model: 'model-b', permissionMode: 'full-auto' });

    const first = enqueueMessage(queue, {
      text: 'first',
      context: context({ model: firstConfig.model, permissionMode: firstConfig.permissionMode }),
      runtimeConfig: firstConfig,
    });
    const second = enqueueMessage(queue, {
      text: 'second',
      context: context({ model: secondConfig.model, permissionMode: secondConfig.permissionMode }),
      runtimeConfig: secondConfig,
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(true);
    expect(queue.shiftExternalOperation()).toMatchObject({
      kind: 'message',
      text: 'first',
      runtimeConfig: {
        model: 'model-a',
        permissionMode: 'default',
      },
    });
    expect(queue.shiftExternalOperation()).toMatchObject({
      kind: 'message',
      text: 'second',
      runtimeConfig: {
        model: 'model-b',
        permissionMode: 'full-auto',
      },
    });
  });

  it('blocks immediate sends while a drain reservation is in flight', async () => {
    const queue = await loadFreshQueueOwner();

    expect(queue.shouldQueueExternalOperation('idle', {
      responseMode: 'realtime',
      canSteerActiveTurn: true,
    })).toBe(false);
    queue.setExternalOperationDrainInFlight(true);
    expect(queue.shouldQueueExternalOperation('idle', {
      responseMode: 'realtime',
      canSteerActiveTurn: true,
    })).toBe(true);
    expect(queue.canDrainExternalOperations('idle')).toBe(false);

    queue.setExternalOperationDrainInFlight(false);
    expect(queue.shouldQueueExternalOperation('idle', {
      responseMode: 'realtime',
      canSteerActiveTurn: true,
    })).toBe(false);
  });

  it('allows realtime active-turn steering only before queued work exists', async () => {
    const queue = await loadFreshQueueOwner();

    expect(queue.shouldQueueExternalOperation('running', {
      responseMode: 'realtime',
      canSteerActiveTurn: true,
    })).toBe(false);
    enqueueMessage(queue, {
      text: 'already queued',
      context: context(),
      runtimeConfig: snapshot(),
    });
    expect(queue.shouldQueueExternalOperation('running', {
      responseMode: 'realtime',
      canSteerActiveTurn: true,
    })).toBe(true);
    expect(queue.shouldQueueExternalOperation('running', {
      responseMode: 'turn',
      canSteerActiveTurn: true,
    })).toBe(true);
  });

  it('moves queued messages to the front, cancels them, and reports message status only', async () => {
    const queue = await loadFreshQueueOwner();

    queue.enqueueExternalConfigOperation({ model: 'model-a' }, 'desktop');
    const first = enqueueMessage(queue, {
      text: 'first-message',
      context: context(),
      runtimeConfig: snapshot({ model: 'model-a' }),
    });
    const second = enqueueMessage(queue, {
      text: 'second-message',
      context: context(),
      runtimeConfig: snapshot({ model: 'model-b' }),
    });
    if (!first.queued || !second.queued) throw new Error('test queue setup failed');

    expect(queue.getExternalQueueStatusSnapshot()).toEqual([
      { id: first.queueId, messagePreview: 'first-message' },
      { id: second.queueId, messagePreview: 'second-message' },
    ]);
    expect(queue.moveExternalQueuedMessageToFront(second.queueId)).toBe(true);
    expect(queue.cancelExternalQueuedMessage(second.queueId)).toBe('second-message');
    expect(queue.getExternalQueueStatusSnapshot()).toEqual([
      { id: first.queueId, messagePreview: 'first-message' },
    ]);
  });

  it('returns cancelled message ids when clearing the queue', async () => {
    const queue = await loadFreshQueueOwner();

    queue.enqueueExternalConfigOperation({ model: 'model-a' }, 'desktop');
    const first = enqueueMessage(queue, {
      text: 'first',
      context: context(),
      runtimeConfig: snapshot(),
    });
    const second = enqueueMessage(queue, {
      text: 'second',
      context: context(),
      runtimeConfig: snapshot(),
    });
    if (!first.queued || !second.queued) throw new Error('test queue setup failed');

    expect(queue.clearExternalQueueWithCancellation()).toEqual([first.queueId, second.queueId]);
    expect(queue.hasExternalQueuedOperations()).toBe(false);
  });

  it('cancels a reserved drain message when clearing the queue', async () => {
    const queue = await loadFreshQueueOwner();
    const first = enqueueMessage(queue, {
      text: 'reserved',
      context: context(),
      runtimeConfig: snapshot(),
    });
    if (!first.queued) throw new Error('test queue setup failed');

    const reserved = queue.reserveExternalOperationForDrain();
    expect(reserved).toMatchObject({ kind: 'message', queueId: first.queueId });

    expect(queue.clearExternalQueueWithCancellation()).toEqual([first.queueId]);
    queue.releaseExternalDrainReservation(reserved);
  });

  it('settles queued dispatch acceptance only when the drained operation is accepted', async () => {
    const queue = await loadFreshQueueOwner();
    const queued = enqueueMessage(queue, {
      text: 'wait for drain',
      context: context(),
      runtimeConfig: snapshot(),
    });
    if (!queued.queued) throw new Error('test queue setup failed');

    let settled = false;
    void queued.dispatchAcceptance.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const reserved = queue.reserveExternalOperationForDrain();
    if (!reserved || reserved.kind !== 'message') throw new Error('expected queued message');
    queue.settleExternalMessageOperation(reserved, { queued: true });

    await expect(queued.dispatchAcceptance).resolves.toEqual({ queued: true });
  });

  it('settles queued dispatch acceptance as rejected when the queue item is cancelled', async () => {
    const queue = await loadFreshQueueOwner();
    const queued = enqueueMessage(queue, {
      text: 'cancel me',
      context: context(),
      runtimeConfig: snapshot(),
    });
    if (!queued.queued) throw new Error('test queue setup failed');

    expect(queue.cancelExternalQueuedMessage(queued.queueId)).toBe('cancel me');
    await expect(queued.dispatchAcceptance).resolves.toEqual({ queued: false });
  });

  it('finds and cancels a queued IM operation by request identity', async () => {
    const queue = await loadFreshQueueOwner();
    const queued = enqueueMessage(queue, {
      text: 'follow-up from IM',
      context: context({
        requestId: 'request-2',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      }),
      runtimeConfig: snapshot(),
    });
    if (!queued.queued) throw new Error('test queue setup failed');

    const cancelled = queue.cancelExternalQueuedMessageByRequestId('request-2');
    expect(cancelled).toMatchObject({
      queueId: queued.queueId,
      text: 'follow-up from IM',
      context: { requestId: 'request-2' },
    });
    await expect(queued.dispatchAcceptance).resolves.toEqual({ queued: false });
    expect(queue.hasExternalQueuedOperations()).toBe(false);
  });

  it('exposes a reserved IM operation without letting queue cancellation steal drain ownership', async () => {
    const queue = await loadFreshQueueOwner();
    const queued = enqueueMessage(queue, {
      text: 'reserved IM follow-up',
      context: context({
        requestId: 'request-reserved',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      }),
      runtimeConfig: snapshot(),
    });
    if (!queued.queued) throw new Error('test queue setup failed');

    const reserved = queue.reserveExternalOperationForDrain();
    expect(queue.cancelExternalQueuedMessageByRequestId('request-reserved')).toBeNull();
    expect(queue.getExternalReservedMessageByRequestId('request-reserved')).toBe(reserved);

    let settled = false;
    void queued.dispatchAcceptance.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    if (!reserved || reserved.kind !== 'message') throw new Error('expected reserved IM message');
    queue.settleExternalMessageOperation(reserved, { queued: false });
    await expect(queued.dispatchAcceptance).resolves.toEqual({ queued: false });
  });

  it('resets stale desktop send tails without running old queued closures', async () => {
    const queue = await loadFreshQueueOwner();
    let releaseFirst!: () => void;
    const first = queue.chainExternalSend(() => new Promise<string>((resolve) => {
      releaseFirst = () => resolve('first');
    }));
    const staleDispatch = vi.fn(async () => 'stale');
    const stale = queue.chainExternalSend(staleDispatch);

    await Promise.resolve();
    expect(releaseFirst).toBeTypeOf('function');
    queue.clearExternalQueueWithCancellation();

    const freshDispatch = vi.fn(async () => 'fresh');
    await expect(queue.chainExternalSend(freshDispatch)).resolves.toBe('fresh');
    expect(freshDispatch).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(stale).rejects.toBeInstanceOf(queue.ExternalQueueGenerationStaleError);
    expect(staleDispatch).not.toHaveBeenCalled();
  });

  it('enforces the queued message cap without counting config operations', async () => {
    const queue = await loadFreshQueueOwner();

    for (let i = 0; i < 50; i += 1) {
      queue.enqueueExternalConfigOperation({ model: `model-${i}` }, 'desktop');
      const result = enqueueMessage(queue, {
        text: `message-${i}`,
        context: context(),
        runtimeConfig: snapshot({ model: `model-${i}` }),
      });
      expect(result.queued).toBe(true);
    }

    const overflow = enqueueMessage(queue, {
      text: 'overflow',
      context: context(),
      runtimeConfig: snapshot(),
    });
    expect(overflow).toEqual({
      queued: false,
      error: '排队消息已达上限，请稍后再发',
    });
  });
});
