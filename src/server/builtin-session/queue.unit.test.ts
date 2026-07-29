import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginPromotedItem,
  cancelTurnAdmissionTicket,
  cancelPromotedItem,
  clearInFlightSlotIfMatches,
  clearPromotedItem,
  getInFlightQueueId,
  getPromotedItemCancellation,
  hasQueuedTurnByOwner,
  isPromotedItemCanceled,
  isPromotedItemInFlight,
  getTurnAdmissionIdentity,
  resetQueueForTest,
  requeuePromotedItemBeforeSdkDispatch,
  setInFlightQueueItem,
  snapshotQueue,
  setTurnAdmissionTicket,
} from './queue';
import type { MessageQueueItem } from './types';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';

function queueItem(id: string): MessageQueueItem {
  return {
    id,
    message: { role: 'user', content: [{ type: 'text', text: 'continue Goal' }] },
    messageText: 'continue Goal',
    wasQueued: false,
    resolve: () => undefined,
    turnOwner: { kind: 'goal', id: 'goal-1' },
    channelDelivery: NO_CHANNEL_DELIVERY,
  };
}

describe('builtin promoted queue item', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('keeps one stable identity cancellable during dispatch promotion', () => {
    const cancelDispatch = vi.fn();
    const item = queueItem('goal-turn');
    item.beforeDispatch = Object.assign(async () => ({ accepted: true }), {
      cancel: cancelDispatch,
    });
    beginPromotedItem(item);

    expect(isPromotedItemInFlight()).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-2' })).toBe(false);
    expect(cancelPromotedItem('other-turn')).toBeNull();
    expect(cancelPromotedItem('goal-turn')).toBe(item);
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(isPromotedItemCanceled('goal-turn')).toBe(true);

    clearPromotedItem('goal-turn');
    expect(isPromotedItemInFlight()).toBe(false);
  });

  it('publishes and cancels the owner identity during turn admission', () => {
    const cancelPersistence = vi.fn();
    const cancelDispatch = vi.fn();
    const beforeUserPersistence = Object.assign(async () => ({ accepted: true }), {
      cancel: cancelPersistence,
    });
    const beforeDispatch = Object.assign(async () => ({ accepted: true }), {
      cancel: cancelDispatch,
    });
    setTurnAdmissionTicket({
      queueId: 'goal-admission',
      createdAt: 1,
      messageText: 'continue Goal',
      turnOwner: { kind: 'goal', id: 'goal-1' },
      beforeUserPersistence,
      beforeDispatch,
      canceled: false,
    });

    expect(getTurnAdmissionIdentity()).toEqual({
      queueId: 'goal-admission',
      owner: { kind: 'goal', id: 'goal-1' },
    });
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);

    const canceled = cancelTurnAdmissionTicket('goal-admission');
    expect(canceled?.ticket.canceled).toBe(true);
    expect(cancelPersistence).toHaveBeenCalledOnce();
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(getTurnAdmissionIdentity()).toBeNull();
  });

  it('settles the promoted-item cancellation fence immediately', async () => {
    const item = queueItem('promotion-cancel');
    beginPromotedItem(item);
    const cancellation = getPromotedItemCancellation(item.id);

    expect(cancellation).not.toBeNull();
    expect(cancelPromotedItem(item.id)).toBe(item);
    await expect(cancellation).resolves.toBeUndefined();
  });

  it('releases only the exact provisional SDK in-flight owner', () => {
    setInFlightQueueItem('realtime-before-yield', {
      messageText: 'queued',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    expect(clearInFlightSlotIfMatches('other')).toBe(false);
    expect(getInFlightQueueId()).toBe('realtime-before-yield');
    expect(clearInFlightSlotIfMatches('realtime-before-yield')).toBe(true);
    expect(getInFlightQueueId()).toBeNull();
  });

  it('atomically requeues a promoted realtime item and releases its provisional slot', () => {
    const item = queueItem('mutation-requeue');
    item.wasQueued = true;
    beginPromotedItem(item);
    setInFlightQueueItem(item.id, {
      messageText: item.messageText,
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    requeuePromotedItemBeforeSdkDispatch(item);

    expect(isPromotedItemInFlight()).toBe(false);
    expect(getInFlightQueueId()).toBeNull();
    expect(snapshotQueue().messageQueue.map(queued => queued.id)).toEqual([item.id]);
  });
});
