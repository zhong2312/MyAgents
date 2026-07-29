/**
 * Issue #289 — what to do with the in-flight mid-turn queued item when the SDK's
 * `result` (turn-end) arrives during/after an interrupt.
 *
 * Background: a message sent mid-turn is yielded to the SDK ("in-flight to CLI") and
 * waits in the SDK commandQueue until the SDK either replays/dequeues it or the host
 * cancels it via cancel_async_message. A graceful interrupt still routes a `result`
 * through handleMessageComplete, but natural completion alone is not a consumption
 * acknowledgement. So whether the item should be SURFACED (shown as a user bubble),
 * DROPPED, or kept waiting depends on the terminal reason and user intent:
 *
 *  - Plain STOP: the interrupt receipt decides whether the queued item survived.
 *    Preserve it until replay when the receipt lists it, or when an older CLI omits
 *    the receipt; drop it only when the receipt explicitly omits its UUID.
 *  - FORCE ("立即发送"): the user explicitly asked for THIS item to run now. force
 *    interrupts the current turn precisely so the SDK drains + processes the queued
 *    command — so it MUST be surfaced as a user bubble (the AI's reply renders under it).
 *    Dropping it is the #289 bug: "message vanishes from UI but the AI processed it".
 *  - Natural completion (not interrupting): keep waiting for SDK replay or the next
 *    assistant-turn signal. Do not surface merely because the previous turn ended.
 *
 * Pure decision core (Functional Core / Imperative Shell): the shell passes the live
 * flags; the caller performs the broadcast. This is ONLY for the result/complete handler.
 * The stop/error handlers fire when the item was lost with a force-closed subprocess
 * (rescuePendingToQueue does NOT rescue the in-flight item), so those always drop and
 * do not use this.
 */
export type InFlightTerminalAction = 'drop' | 'surface' | 'await-replay' | 'noop';

export type InFlightAsyncCancelResult = 'cancelled' | 'not-cancelled' | 'unavailable' | 'error';

export type InFlightCancelSettlement = {
  cancelled: boolean;
  removePendingRequest: boolean;
  clearSlot: boolean;
  broadcastCancelled: boolean;
  promoteNext: boolean;
};

export function decideInFlightActionOnResult(opts: {
  /** An interrupt (stop or force) is in progress for this terminal result. */
  isInterrupting: boolean;
  /** This interrupt was a force-execute targeting THIS in-flight item (#289). */
  forced: boolean;
  /** inFlightMetadata is available to build the user bubble. */
  hasMeta: boolean;
  /** true/false from a public receipt; null/undefined when the CLI omitted it. */
  survivedInterrupt?: boolean | null;
}): InFlightTerminalAction {
  // SDK 0.3.220's interrupt receipt is authoritative: an explicitly listed
  // survivor WILL run, while an explicitly absent UUID can be dropped. Older
  // CLIs omit the receipt; preserve in that case because Stop only owns the
  // current turn and must not invent cancellation of a queued message.
  if (opts.isInterrupting && !opts.forced && opts.survivedInterrupt !== false) return 'await-replay';
  // Receipt explicitly says this in-flight UUID did not survive the interrupt.
  if (opts.isInterrupting && !opts.forced) return 'drop';
  // Force-send: explicit user intent to interrupt and process this item now.
  if (opts.forced) return opts.hasMeta ? 'surface' : 'noop';
  // Natural completion is not an SDK consumption ack. Keep the pill queued until
  // SDKUserMessageReplay or a later assistant-turn signal confirms consumption.
  return 'await-replay';
}

export function decideInFlightCancelSettlement(result: InFlightAsyncCancelResult): InFlightCancelSettlement {
  const cancelled = result === 'cancelled';
  return {
    cancelled,
    removePendingRequest: cancelled,
    clearSlot: cancelled,
    broadcastCancelled: cancelled,
    promoteNext: cancelled,
  };
}

export function terminalEventMatchesInFlight(opts: {
  currentQueueId: string | null;
  isInterrupting: boolean;
  interruptTargetQueueId: string | null;
}): boolean {
  if (!opts.currentQueueId) return false;
  if (!opts.isInterrupting) return true;
  return opts.interruptTargetQueueId === opts.currentQueueId;
}

/**
 * Reconcile the narrow result-before-interrupt-receipt race.
 *
 * The result handler preserves an in-flight queued command when no receipt is
 * available yet. If the receipt arrives later and explicitly omits that exact
 * UUID, the preserved queue pill must be cancelled at the existing queue owner.
 */
export function shouldDropInFlightAfterLateInterruptReceipt(opts: {
  postInterruptOutcome: 'result-claimed' | 'session-ended' | null;
  interruptTargetQueueId: string | null;
  currentQueueId: string | null;
  stillQueued: ReadonlySet<string>;
}): boolean {
  return opts.postInterruptOutcome === 'result-claimed'
    && opts.interruptTargetQueueId !== null
    && opts.currentQueueId === opts.interruptTargetQueueId
    && !opts.stillQueued.has(opts.interruptTargetQueueId);
}

export type InterruptReceipt = { still_queued: readonly string[] };

/**
 * Imperative receipt shell shared by the live interrupt owner and its race
 * tests. Live state is read after the deferred SDK control response resolves,
 * so result-first and Query-replacement ordering cannot use stale snapshots.
 */
export async function reconcileInterruptReceipt(params: {
  requestReceipt: () => Promise<InterruptReceipt | undefined>;
  isCurrentOwner: () => boolean;
  getPostInterruptOutcome: () => 'result-claimed' | 'session-ended' | null;
  interruptTargetQueueId: string | null;
  getCurrentQueueId: () => string | null;
  onReceipt: (stillQueued: ReadonlySet<string>) => void;
  onUnavailable: () => void;
  dropExactInFlight: () => void;
  scheduleDrain: () => void;
}): Promise<InterruptReceipt | undefined> {
  const receipt = await params.requestReceipt();
  if (!params.isCurrentOwner()) return receipt;
  if (!receipt) {
    params.onUnavailable();
    return receipt;
  }

  const stillQueued = new Set(receipt.still_queued);
  params.onReceipt(stillQueued);
  if (shouldDropInFlightAfterLateInterruptReceipt({
    postInterruptOutcome: params.getPostInterruptOutcome(),
    interruptTargetQueueId: params.interruptTargetQueueId,
    currentQueueId: params.getCurrentQueueId(),
    stillQueued,
  })) {
    params.dropExactInFlight();
    params.scheduleDrain();
  }
  return receipt;
}
