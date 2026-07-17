import { describe, expect, it } from 'vitest';

import {
  decideQueueAdmission,
  decideRealtimeHandoff,
  findQueueLocation,
  moveQueueIndexToFront,
  resolveChatQueueResponseMode,
  shouldApplyChatQueueResponseMode,
  shouldClearAdmissionTicketOnAbort,
  shouldStartTurnBoundaryItem,
} from './turn-queue';

describe('turn-queue policy', () => {
  it('applies desktop-only queue response mode and preserves realtime admission', () => {
    expect(shouldApplyChatQueueResponseMode(true)).toBe(true);
    expect(shouldApplyChatQueueResponseMode(false)).toBe(false);
    expect(resolveChatQueueResponseMode('turn', true)).toBe('turn');
    expect(resolveChatQueueResponseMode('turn', false)).toBe('realtime');
    expect(decideQueueAdmission({ mode: 'realtime', busy: false, hasInFlight: false })).toBe('direct');
    expect(decideQueueAdmission({ mode: 'realtime', busy: true, hasInFlight: false })).toBe('realtime-inflight');
    expect(decideQueueAdmission({ mode: 'realtime', busy: true, hasInFlight: true })).toBe('realtime-buffer');
    expect(decideQueueAdmission({ mode: 'turn', busy: true, hasInFlight: false })).toBe('turn-boundary');
  });

  it('keeps later desktop sends in turn-boundary mode when a scoped turn item exists', () => {
    expect(decideQueueAdmission({
      mode: 'realtime',
      busy: true,
      hasInFlight: false,
      hasScopedTurnBoundaryQueued: true,
    })).toBe('turn-boundary');
  });

  it('claims SDK in-flight ownership only when the generator can accept the handoff', () => {
    expect(decideRealtimeHandoff(true)).toBe('sdk-inflight');
    expect(decideRealtimeHandoff(false)).toBe('local-queue');
  });

  it('finds queue locations in cancellation priority order', () => {
    expect(findQueueLocation({
      messageIndex: -1,
      pendingMidTurnIndex: 2,
      turnBoundaryIndex: 0,
      inFlight: true,
    })).toEqual({ location: 'pending-mid-turn', index: 2 });
    expect(findQueueLocation({
      messageIndex: -1,
      pendingMidTurnIndex: -1,
      turnBoundaryIndex: -1,
      inFlight: true,
    })).toEqual({ location: 'in-flight', index: -1 });
  });

  it('moves queued work to the front without replacing queue identity', () => {
    const queue = ['a', 'b', 'c'];
    expect(moveQueueIndexToFront(queue, 2)).toBe(true);
    expect(queue).toEqual(['c', 'a', 'b']);
    expect(moveQueueIndexToFront(queue, -1)).toBe(false);
  });

  it('blocks turn-boundary starts while adjacent queues or lifecycle gates are active', () => {
    const base = {
      hasTurnInFlight: false,
      hasCompetingAdmissionTicket: false,
      hasInFlightToCli: false,
      hasPendingMidTurn: false,
      hasMessageQueue: false,
      promotedItemInFlight: false,
      shouldAbortSession: false,
      reason: 'complete' as const,
      hasQuerySession: false,
      hasResetInProgress: false,
      hasRewindInProgress: false,
    };
    expect(shouldStartTurnBoundaryItem(base)).toBe(true);
    expect(shouldStartTurnBoundaryItem({ ...base, hasCompetingAdmissionTicket: true })).toBe(false);
    expect(shouldStartTurnBoundaryItem({ ...base, hasPendingMidTurn: true })).toBe(false);
    expect(shouldStartTurnBoundaryItem({ ...base, hasPendingMidTurn: true, allowRealtimePending: true })).toBe(true);
    expect(shouldStartTurnBoundaryItem({ ...base, shouldAbortSession: true, reason: 'complete' })).toBe(false);
    expect(shouldStartTurnBoundaryItem({ ...base, shouldAbortSession: true, reason: 'recovery' })).toBe(true);
  });

  it('clears admission tickets on abort unless the current enqueue is still committing', () => {
    expect(shouldClearAdmissionTicketOnAbort({
      ticketQueueId: 'q1',
      committingQueueId: 'q1',
    })).toBe(false);
    expect(shouldClearAdmissionTicketOnAbort({
      ticketQueueId: 'q1',
      committingQueueId: 'q2',
    })).toBe(true);
    expect(shouldClearAdmissionTicketOnAbort({
      ticketQueueId: null,
      committingQueueId: 'q2',
    })).toBe(false);
  });
});
