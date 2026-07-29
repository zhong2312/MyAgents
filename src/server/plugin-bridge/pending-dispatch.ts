/**
 * Request-scoped OpenClaw reply transport.
 *
 * Rust produces ordered turn events; the loaded plugin owns rendering and
 * delivery. This queue is only the cross-process hand-off between them. It
 * deliberately knows nothing about platform pacing, CardKit, or retry policy.
 */

import { summarizeSensitiveValueForLog } from '../utils/log-summary';

type MaybePromise<T> = T | Promise<T>;

export type OpenClawReplyPayload = Record<string, unknown> & {
  text?: string;
  isError?: boolean;
};

export interface PendingDispatchCallbacks {
  onReplyStart?: () => MaybePromise<void>;
  onPartialReply?: (payload: OpenClawReplyPayload) => MaybePromise<void>;
  onReasoningStream?: (payload: OpenClawReplyPayload) => MaybePromise<void>;
  sendFinalReply: (payload: OpenClawReplyPayload) => MaybePromise<boolean | void>;
  getQueuedCounts?: () => Record<string, number>;
}

export type PendingDispatchResult = {
  queuedFinal: number;
  counts: Record<string, number>;
};

type PartialLane = 'answer' | 'reasoning';

type PendingOperation =
  | { kind: 'run-start' }
  | {
      kind: 'partial';
      streamId: string;
      lane: PartialLane;
      payload: OpenClawReplyPayload;
    }
  | { kind: 'block-boundary'; streamId: string }
  | { kind: 'final'; payload: OpenClawReplyPayload }
  | { kind: 'complete'; outcome: 'completed' | 'aborted' };

export interface PendingDispatch {
  requestId: string;
  chatId: string;
  pluginId: string;
  callbacks: PendingDispatchCallbacks;
  queue: PendingOperation[];
  streamIds: Set<string>;
  sealed: boolean;
  settled: boolean;
  draining: boolean;
  runStartQueued: boolean;
  acceptedFinals: number;
  partialReceived: number;
  partialDelivered: number;
  partialCoalesced: number;
  blockBoundariesAccepted: number;
  finalPayloadsReceived: number;
  registeredAt: number;
  firstPartialAcceptedAt?: number;
  producerTerminalAcceptedAt?: number;
  canonicalFinalAcceptedAt?: number;
  resolve: (result: PendingDispatchResult) => void;
  reject: (error: Error) => void;
}

const pendingByRequestId = new Map<string, PendingDispatch>();
const requestIdByStreamId = new Map<string, string>();

function dispatchMissing(identity: string): Error {
  const error = new Error(`protocol_dispatch_missing: ${identity}`);
  error.name = 'ProtocolDispatchMissingError';
  return error;
}

function getOpenDispatch(requestId: string): PendingDispatch {
  const dispatch = pendingByRequestId.get(requestId);
  if (!dispatch || dispatch.settled) throw dispatchMissing(`requestId=${requestId}`);
  return dispatch;
}

function cleanupDispatch(dispatch: PendingDispatch): void {
  pendingByRequestId.delete(dispatch.requestId);
  for (const streamId of dispatch.streamIds) {
    requestIdByStreamId.delete(streamId);
  }
  dispatch.streamIds.clear();
}

function logCanonicalFinal(
  dispatch: PendingDispatch,
  outcome: 'completed' | 'aborted',
  payloads: readonly OpenClawReplyPayload[],
): void {
  const composedText = payloads
    .map(payload => typeof payload.text === 'string' ? payload.text : '')
    .filter(Boolean)
    .join('\n');
  const textSummary = summarizeSensitiveValueForLog(composedText.trim() ? composedText : null);
  console.log(
    `[pending-dispatch] canonical_final pluginId=${dispatch.pluginId} requestId=${dispatch.requestId} `
      + `outcome=${outcome} count=${payloads.length} chars=${textSummary.chars} hash=${textSummary.hash ?? 'none'}`,
  );
}

function settleResolved(
  dispatch: PendingDispatch,
  outcome: 'completed' | 'aborted' | 'failed',
): void {
  if (dispatch.settled) return;
  let counts: Record<string, number> = { final: dispatch.acceptedFinals };
  try {
    counts = dispatch.callbacks.getQueuedCounts?.() ?? counts;
  } catch (error) {
    console.warn(
      `[pending-dispatch] delivery_count_read_failed pluginId=${dispatch.pluginId} requestId=${dispatch.requestId}:`,
      error,
    );
  }
  dispatch.settled = true;
  cleanupDispatch(dispatch);
  dispatch.resolve({
    queuedFinal: counts.final ?? dispatch.acceptedFinals,
    counts,
  });
  const settledAt = Date.now();
  console.log(
    `[pending-dispatch] plugin_dispatch_resolved pluginId=${dispatch.pluginId} requestId=${dispatch.requestId} `
      + `outcome=${outcome} durationMs=${settledAt - dispatch.registeredAt} `
      + `producerTerminalToResolveMs=${dispatch.producerTerminalAcceptedAt === undefined
        ? 'n/a'
        : settledAt - dispatch.producerTerminalAcceptedAt} `
      + `firstPartialAcceptedMs=${dispatch.firstPartialAcceptedAt === undefined
        ? 'n/a'
        : dispatch.firstPartialAcceptedAt - dispatch.registeredAt} `
      + `canonicalFinalAcceptedMs=${dispatch.canonicalFinalAcceptedAt === undefined
        ? 'n/a'
        : dispatch.canonicalFinalAcceptedAt - dispatch.registeredAt} `
      + `partialReceived=${dispatch.partialReceived} partialDelivered=${dispatch.partialDelivered} `
      + `partialCoalesced=${dispatch.partialCoalesced} rawBlockBarriers=${dispatch.blockBoundariesAccepted} `
      + `finalPayloadsReceived=${dispatch.finalPayloadsReceived} queuedFinal=${counts.final ?? dispatch.acceptedFinals}`,
  );
}

const CALLBACK_FAILURE_PAYLOAD: OpenClawReplyPayload = {
  text: '⚠️ 回复投递失败，请稍后重试。',
  isError: true,
};

async function settleCallbackFailure(
  dispatch: PendingDispatch,
  operation: PendingOperation,
  error: unknown,
): Promise<void> {
  if (dispatch.settled) return;
  dispatch.sealed = true;
  dispatch.queue = [];
  console.error(
    `[pending-dispatch] dispatch_failed pluginId=${dispatch.pluginId} requestId=${dispatch.requestId} `
      + `operation=${operation.kind}:`,
    error,
  );
  try {
    const accepted = await dispatch.callbacks.sendFinalReply(CALLBACK_FAILURE_PAYLOAD);
    if (accepted !== false) dispatch.acceptedFinals += 1;
  } catch (terminalError) {
    console.error(
      `[pending-dispatch] failure_final_failed pluginId=${dispatch.pluginId} requestId=${dispatch.requestId}:`,
      terminalError,
    );
  }
  settleResolved(dispatch, 'failed');
}

async function executeOperation(dispatch: PendingDispatch, operation: PendingOperation): Promise<void> {
  switch (operation.kind) {
    case 'run-start':
      await dispatch.callbacks.onReplyStart?.();
      console.log(`[pending-dispatch] run_started requestId=${dispatch.requestId}`);
      return;
    case 'partial':
      if (operation.lane === 'reasoning') {
        await dispatch.callbacks.onReasoningStream?.(operation.payload);
      } else {
        await dispatch.callbacks.onPartialReply?.(operation.payload);
      }
      dispatch.partialDelivered += 1;
      return;
    case 'block-boundary':
      console.log(
        `[pending-dispatch] raw_block_barrier_accepted requestId=${dispatch.requestId} streamId=${operation.streamId}`,
      );
      return;
    case 'final': {
      const accepted = await dispatch.callbacks.sendFinalReply(operation.payload);
      if (accepted !== false) dispatch.acceptedFinals += 1;
      return;
    }
    case 'complete':
      settleResolved(dispatch, operation.outcome);
  }
}

async function drain(dispatch: PendingDispatch): Promise<void> {
  if (dispatch.draining || dispatch.settled) return;
  dispatch.draining = true;
  try {
    while (!dispatch.settled) {
      const operation = dispatch.queue.shift();
      if (!operation) break;
      try {
        await executeOperation(dispatch, operation);
      } catch (error) {
        await settleCallbackFailure(dispatch, operation, error);
        break;
      }
    }
  } finally {
    dispatch.draining = false;
    if (!dispatch.settled && dispatch.queue.length > 0) void drain(dispatch);
  }
}

function enqueue(dispatch: PendingDispatch, operation: PendingOperation): void {
  if (dispatch.sealed && operation.kind !== 'final' && operation.kind !== 'complete') {
    throw dispatchMissing(`sealed requestId=${dispatch.requestId}`);
  }

  if (operation.kind === 'partial') {
    const tail = dispatch.queue.at(-1);
    if (
      tail?.kind === 'partial'
      && tail.streamId === operation.streamId
      && tail.lane === operation.lane
    ) {
      tail.payload = operation.payload;
      dispatch.partialCoalesced += 1;
      return;
    }
  }

  dispatch.queue.push(operation);
  void drain(dispatch);
}

export function registerPendingDispatch(
  requestId: string,
  chatId: string,
  callbacks: PendingDispatchCallbacks,
  pluginId = 'unknown',
): Promise<PendingDispatchResult> {
  if (!requestId) throw new Error('requestId is required');
  if (pendingByRequestId.has(requestId)) {
    throw new Error(`Duplicate pending dispatch requestId=${requestId}`);
  }

  return new Promise((resolve, reject) => {
    pendingByRequestId.set(requestId, {
      requestId,
      chatId,
      pluginId,
      callbacks,
      queue: [],
      streamIds: new Set(),
      sealed: false,
      settled: false,
      draining: false,
      runStartQueued: false,
      acceptedFinals: 0,
      partialReceived: 0,
      partialDelivered: 0,
      partialCoalesced: 0,
      blockBoundariesAccepted: 0,
      finalPayloadsReceived: 0,
      registeredAt: Date.now(),
      resolve,
      reject,
    });
    console.log(`[pending-dispatch] dispatch_registered pluginId=${pluginId} requestId=${requestId}`);
  });
}

export function getPendingDispatch(requestId: string): PendingDispatch | undefined {
  const dispatch = pendingByRequestId.get(requestId);
  return dispatch && !dispatch.settled ? dispatch : undefined;
}

export function enqueueRunStart(requestId: string): void {
  const dispatch = getOpenDispatch(requestId);
  if (dispatch.runStartQueued) return;
  dispatch.runStartQueued = true;
  enqueue(dispatch, { kind: 'run-start' });
}

export function bindPendingStream(requestId: string, streamId: string): void {
  const dispatch = getOpenDispatch(requestId);
  if (dispatch.sealed) throw dispatchMissing(`sealed requestId=${requestId}`);
  if (requestIdByStreamId.has(streamId)) throw new Error(`Duplicate streamId=${streamId}`);
  dispatch.streamIds.add(streamId);
  requestIdByStreamId.set(streamId, requestId);
  console.log(`[pending-dispatch] stream_started requestId=${requestId} streamId=${streamId}`);
}

export function enqueuePartial(
  streamId: string,
  payload: OpenClawReplyPayload,
  lane: PartialLane,
): void {
  const requestId = requestIdByStreamId.get(streamId);
  if (!requestId) throw dispatchMissing(`streamId=${streamId}`);
  const dispatch = getOpenDispatch(requestId);
  dispatch.partialReceived += 1;
  dispatch.firstPartialAcceptedAt ??= Date.now();
  enqueue(dispatch, { kind: 'partial', streamId, lane, payload });
}

export function enqueueBlockBoundary(streamId: string): void {
  const requestId = requestIdByStreamId.get(streamId);
  if (!requestId) throw dispatchMissing(`streamId=${streamId}`);
  const dispatch = getOpenDispatch(requestId);
  requestIdByStreamId.delete(streamId);
  dispatch.streamIds.delete(streamId);
  dispatch.blockBoundariesAccepted += 1;
  enqueue(dispatch, { kind: 'block-boundary', streamId });
}

export function completePendingDispatch(
  requestId: string,
  finalPayloads: OpenClawReplyPayload[],
): void {
  const dispatch = getOpenDispatch(requestId);
  dispatch.sealed = true;
  dispatch.producerTerminalAcceptedAt = Date.now();
  dispatch.finalPayloadsReceived += finalPayloads.length;
  if (finalPayloads.length > 0) dispatch.canonicalFinalAcceptedAt = Date.now();
  logCanonicalFinal(dispatch, 'completed', finalPayloads);
  for (const payload of finalPayloads) enqueue(dispatch, { kind: 'final', payload });
  enqueue(dispatch, { kind: 'complete', outcome: 'completed' });
  console.log(
    `[pending-dispatch] complete_barrier_accepted pluginId=${dispatch.pluginId} requestId=${requestId}`,
  );
}

export function abortPendingDispatch(
  requestId: string,
  terminalPayload: OpenClawReplyPayload,
): void {
  const dispatch = getOpenDispatch(requestId);
  dispatch.sealed = true;
  dispatch.producerTerminalAcceptedAt = Date.now();
  dispatch.finalPayloadsReceived += 1;
  dispatch.canonicalFinalAcceptedAt = Date.now();
  dispatch.queue = dispatch.queue.filter(operation => operation.kind !== 'partial');
  logCanonicalFinal(dispatch, 'aborted', [terminalPayload]);
  enqueue(dispatch, { kind: 'final', payload: terminalPayload });
  enqueue(dispatch, { kind: 'complete', outcome: 'aborted' });
  console.log(
    `[pending-dispatch] dispatch_aborted pluginId=${dispatch.pluginId} requestId=${requestId}`,
  );
}

/** Setup/identity failures only. Runtime error/cancel use abortPendingDispatch. */
export function rejectPendingDispatch(requestId: string, error: Error): void {
  const dispatch = pendingByRequestId.get(requestId);
  if (!dispatch || dispatch.settled) return;
  dispatch.settled = true;
  cleanupDispatch(dispatch);
  console.error(
    `[pending-dispatch] dispatch_failed pluginId=${dispatch.pluginId} requestId=${requestId} phase=setup:`,
    error,
  );
  dispatch.reject(error);
}

/** Clean up all pending dispatches when the Bridge process shuts down. */
export function clearAllPendingDispatches(): void {
  for (const dispatch of pendingByRequestId.values()) {
    if (dispatch.settled) continue;
    dispatch.settled = true;
    dispatch.reject(new Error('Bridge shutting down'));
  }
  pendingByRequestId.clear();
  requestIdByStreamId.clear();
}
