import { describe, it, expect, vi } from 'vitest';
import {
  decideInFlightActionOnResult,
  decideInFlightCancelSettlement,
  reconcileInterruptReceipt,
  shouldDropInFlightAfterLateInterruptReceipt,
  terminalEventMatchesInFlight,
} from './inflight-terminal';

describe('decideInFlightActionOnResult (issue #289 — force-send must surface, not drop)', () => {
  it('FORCE-send (the bug): interrupting + forced + has meta → surface (show the bubble)', () => {
    // This is the regression for #289: force was dropping the in-flight item even though
    // the SDK processes it. It MUST surface now.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).toBe('surface');
  });

  it('plain STOP drops only when the receipt explicitly omits the in-flight uuid', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: false,
    })).toBe('drop');
  });

  it('plain STOP preserves the queue when an older CLI returns no receipt', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: null,
    })).toBe('await-replay');
  });

  it('plain STOP preserves an in-flight item that the interrupt receipt says will still run', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: true,
    })).toBe('await-replay');
  });

  it('natural completion: not interrupting + has meta → await replay (no false queue:started)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: true })).toBe('await-replay');
  });

  it('force but no meta (cannot build a bubble) → noop (defensive)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: false })).toBe('noop');
  });

  it('natural completion but no meta → await replay', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: false })).toBe('await-replay');
  });

  it('forced wins over the stop drop even if both flags are set (force is the explicit intent)', () => {
    // forced=true must NOT be dropped by the `isInterrupting && !forced` stop rule.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).not.toBe('drop');
  });
});

describe('decideInFlightCancelSettlement', () => {
  it('SDK cancelled=true is the only path that clears local in-flight state and removes the queue pill', () => {
    expect(decideInFlightCancelSettlement('cancelled')).toEqual({
      cancelled: true,
      removePendingRequest: true,
      clearSlot: true,
      broadcastCancelled: true,
      promoteNext: true,
    });
  });

  it.each(['not-cancelled', 'unavailable', 'error'] as const)(
    'SDK %s keeps the in-flight item waiting for replay or assistant-start confirmation',
    (result) => {
      expect(decideInFlightCancelSettlement(result)).toEqual({
        cancelled: false,
        removePendingRequest: false,
        clearSlot: false,
        broadcastCancelled: false,
        promoteNext: false,
      });
    },
  );
});

describe('terminalEventMatchesInFlight', () => {
  it('does not apply an interrupt terminal event to a newly promoted in-flight item', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-b',
      isInterrupting: true,
      interruptTargetQueueId: 'queue-a',
    })).toBe(false);
  });

  it('applies an interrupt terminal event to the item that was in-flight when interrupt started', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-a',
      isInterrupting: true,
      interruptTargetQueueId: 'queue-a',
    })).toBe(true);
  });

  it('applies non-interrupt terminal events to the current in-flight item', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-a',
      isInterrupting: false,
      interruptTargetQueueId: null,
    })).toBe(true);
  });
});

describe('shouldDropInFlightAfterLateInterruptReceipt', () => {
  it('drops the exact preserved item when result wins the race and the later receipt omits it', () => {
    expect(shouldDropInFlightAfterLateInterruptReceipt({
      postInterruptOutcome: 'result-claimed',
      interruptTargetQueueId: 'queue-a',
      currentQueueId: 'queue-a',
      stillQueued: new Set(),
    })).toBe(true);
  });

  it('keeps an item listed by the receipt', () => {
    expect(shouldDropInFlightAfterLateInterruptReceipt({
      postInterruptOutcome: 'result-claimed',
      interruptTargetQueueId: 'queue-a',
      currentQueueId: 'queue-a',
      stillQueued: new Set(['queue-a']),
    })).toBe(false);
  });

  it('does not let a late receipt cancel a replacement in-flight item', () => {
    expect(shouldDropInFlightAfterLateInterruptReceipt({
      postInterruptOutcome: 'result-claimed',
      interruptTargetQueueId: 'queue-a',
      currentQueueId: 'queue-b',
      stillQueued: new Set(),
    })).toBe(false);
  });

  it('does nothing before a graceful result has claimed the terminal boundary', () => {
    expect(shouldDropInFlightAfterLateInterruptReceipt({
      postInterruptOutcome: null,
      interruptTargetQueueId: 'queue-a',
      currentQueueId: 'queue-a',
      stillQueued: new Set(),
    })).toBe(false);
  });
});

describe('reconcileInterruptReceipt', () => {
  it('drops and drains the exact preserved item when result wins the deferred receipt race', async () => {
    let resolveReceipt!: (value: { still_queued: string[] }) => void;
    let outcome: 'result-claimed' | 'session-ended' | null = null;
    let currentQueueId: string | null = 'queue-a';
    const dropExactInFlight = vi.fn(() => { currentQueueId = null; });
    const scheduleDrain = vi.fn();
    const receipt = new Promise<{ still_queued: string[] }>((resolve) => { resolveReceipt = resolve; });
    const reconciliation = reconcileInterruptReceipt({
      requestReceipt: () => receipt,
      isCurrentOwner: () => true,
      getPostInterruptOutcome: () => outcome,
      interruptTargetQueueId: 'queue-a',
      getCurrentQueueId: () => currentQueueId,
      onReceipt: vi.fn(),
      onUnavailable: vi.fn(),
      dropExactInFlight,
      scheduleDrain,
    });

    // The result owner preserves queue-a before the control receipt exists.
    outcome = 'result-claimed';
    resolveReceipt({ still_queued: [] });
    await reconciliation;

    expect(dropExactInFlight).toHaveBeenCalledOnce();
    expect(scheduleDrain).toHaveBeenCalledOnce();
    expect(currentQueueId).toBeNull();
  });

  it('lets a receipt-first omission drive the later result decision', async () => {
    let survivedInterrupt: boolean | null = null;
    const dropExactInFlight = vi.fn();
    await reconcileInterruptReceipt({
      requestReceipt: async () => ({ still_queued: [] }),
      isCurrentOwner: () => true,
      getPostInterruptOutcome: () => null,
      interruptTargetQueueId: 'queue-a',
      getCurrentQueueId: () => 'queue-a',
      onReceipt: value => { survivedInterrupt = value.has('queue-a'); },
      onUnavailable: vi.fn(),
      dropExactInFlight,
      scheduleDrain: vi.fn(),
    });

    expect(dropExactInFlight).not.toHaveBeenCalled();
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt,
    })).toBe('drop');
  });

  it('ignores missing receipts and receipts from a replaced Query owner', async () => {
    const onUnavailable = vi.fn();
    const onReceipt = vi.fn();
    const dropExactInFlight = vi.fn();
    const scheduleDrain = vi.fn();
    const common = {
      getPostInterruptOutcome: () => 'result-claimed' as const,
      interruptTargetQueueId: 'queue-a',
      getCurrentQueueId: () => 'queue-a',
      onReceipt,
      onUnavailable,
      dropExactInFlight,
      scheduleDrain,
    };

    await reconcileInterruptReceipt({
      ...common,
      requestReceipt: async () => undefined,
      isCurrentOwner: () => true,
    });
    await reconcileInterruptReceipt({
      ...common,
      requestReceipt: async () => ({ still_queued: [] }),
      isCurrentOwner: () => false,
    });

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onReceipt).not.toHaveBeenCalled();
    expect(dropExactInFlight).not.toHaveBeenCalled();
    expect(scheduleDrain).not.toHaveBeenCalled();
  });

  it('does not cancel a surviving or replacement in-flight item', async () => {
    const dropExactInFlight = vi.fn();
    const scheduleDrain = vi.fn();
    for (const scenario of [
      { currentQueueId: 'queue-a', stillQueued: ['queue-a'] },
      { currentQueueId: 'queue-b', stillQueued: [] },
    ]) {
      await reconcileInterruptReceipt({
        requestReceipt: async () => ({ still_queued: scenario.stillQueued }),
        isCurrentOwner: () => true,
        getPostInterruptOutcome: () => 'result-claimed',
        interruptTargetQueueId: 'queue-a',
        getCurrentQueueId: () => scenario.currentQueueId,
        onReceipt: vi.fn(),
        onUnavailable: vi.fn(),
        dropExactInFlight,
        scheduleDrain,
      });
    }

    expect(dropExactInFlight).not.toHaveBeenCalled();
    expect(scheduleDrain).not.toHaveBeenCalled();
  });
});
