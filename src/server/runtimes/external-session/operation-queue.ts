import type { ImagePayload } from '../types';
import type { ExternalRuntimeConfigPatch, ExternalRuntimeConfigSnapshot } from '../types';
import { canDrainExternalQueue, shouldQueueExternalSend } from '../external-queue-policy';
import { mergeRuntimeConfigPatches } from '../../session-core/runtime-config-policy';
import type { ChatQueueResponseMode } from '../../../shared/config-types';
import type { TurnOwner } from '../../session-core/turn-queue';
import type { SessionMessage } from '../../types/session';
import type {
  ExternalConfigSource,
  ExternalQueuedConfigOperation,
  ExternalMessageOperation,
  ExternalQueuedMessageOperation,
  ExternalSendContext,
  ExternalSendResult,
  ExternalSessionState,
  ExternalTurnOperation,
} from './types';

const externalOperationQueue: ExternalTurnOperation[] = [];
const externalInFlightMessageOperations: ExternalMessageOperation[] = [];
let externalReservedDrainOperation: ExternalTurnOperation | null = null;
let externalQueueSeq = 0;
let externalConfigSeq = 0;
let externalOperationDrainInFlight = false;
let externalUserMsgSeq = 0;
let externalSendTail: Promise<unknown> | null = null;
let externalOperationGeneration = 0;

const EXTERNAL_MAX_QUEUE_SIZE = 50;

export class ExternalQueueGenerationStaleError extends Error {
  constructor() {
    super('External operation queue generation is stale');
    this.name = 'ExternalQueueGenerationStaleError';
  }
}

export function isExternalQueueGenerationStaleError(err: unknown): err is ExternalQueueGenerationStaleError {
  return err instanceof ExternalQueueGenerationStaleError;
}

export function getExternalOperationGeneration(): number {
  return externalOperationGeneration;
}

export function isCurrentExternalOperationGeneration(generation: number): boolean {
  return externalOperationGeneration === generation;
}

export function getExternalOperationQueueLength(): number {
  return externalOperationQueue.length;
}

export function hasExternalQueuedOperations(): boolean {
  return externalOperationQueue.length > 0;
}

export function isExternalOperationDrainInFlight(): boolean {
  return externalOperationDrainInFlight;
}

/** Existing direct-send owner occupancy. IM admission uses this promise itself
 * as the atomic signal that an earlier idle send already owns dispatch. */
export function hasExternalSendInFlight(): boolean {
  return externalSendTail !== null;
}

export function setExternalOperationDrainInFlight(value: boolean): void {
  externalOperationDrainInFlight = value;
}

export function queuedExternalMessageCount(): number {
  return externalOperationQueue.reduce((count, item) => count + (item.kind === 'message' ? 1 : 0), 0);
}

export function hasQueuedExternalConfigOperation(): boolean {
  return externalOperationQueue.some((item) => item.kind === 'config');
}

export function shouldQueueExternalOperation(
  state: ExternalSessionState,
  options?: {
    responseMode?: ChatQueueResponseMode;
    canSteerActiveTurn?: boolean;
  },
): boolean {
  return shouldQueueExternalSend({
    state,
    queueLength: externalOperationQueue.length,
    responseMode: options?.responseMode ?? 'turn',
    canSteerActiveTurn: options?.canSteerActiveTurn === true,
  }) || externalOperationDrainInFlight;
}

export function canDrainExternalOperations(state: ExternalSessionState): boolean {
  return canDrainExternalQueue(state, externalOperationQueue.length) && !externalOperationDrainInFlight;
}

export function nextExternalUserMessageId(): string {
  return `user-${Date.now()}-${externalUserMsgSeq++}`;
}

export function nextExternalQueueId(): string {
  return `xq-${Date.now()}-${externalQueueSeq++}`;
}

export function createExternalMessageOperation(input: {
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  runtimeConfig: ExternalRuntimeConfigSnapshot;
  userMessage: SessionMessage;
  surfaceMode?: 'chat-replay' | 'queue-started';
  queueId?: string;
}): ExternalMessageOperation {
  const queueId = input.queueId ?? input.context.queueId ?? nextExternalQueueId();
  return {
    kind: 'message',
    queueId,
    text: input.text,
    images: input.images,
    context: { ...input.context, queueId },
    runtimeConfig: input.runtimeConfig,
    userProjection: {
      message: input.userMessage,
      surfaceMode: input.surfaceMode ?? 'chat-replay',
      surfaced: false,
      inTranscript: false,
      persisted: false,
      retracted: false,
    },
  };
}

export async function withExternalMessageOperation<T>(
  operation: ExternalMessageOperation,
  dispatch: () => Promise<T>,
): Promise<T> {
  externalInFlightMessageOperations.push(operation);
  try {
    return await dispatch();
  } finally {
    const index = externalInFlightMessageOperations.indexOf(operation);
    if (index !== -1) externalInFlightMessageOperations.splice(index, 1);
  }
}

export function getExternalPendingUserMessageProjections(sessionId: string): SessionMessage[] {
  return externalInFlightMessageOperations
    .filter(operation => (
      operation.context.sessionId === sessionId
      && operation.userProjection.surfaced
      && !operation.userProjection.persisted
      && !operation.userProjection.retracted
    ))
    .map(operation => operation.userProjection.message);
}

export function markExternalUserMessageSurfaced(operation: ExternalMessageOperation): void {
  operation.userProjection.surfaced = true;
}

export function markExternalUserMessageInTranscript(operation: ExternalMessageOperation): void {
  operation.userProjection.inTranscript = true;
}

export function markExternalUserMessagePersisted(operation: ExternalMessageOperation): void {
  operation.userProjection.persisted = true;
}

export function markExternalUserMessageRetracted(operation: ExternalMessageOperation): void {
  operation.userProjection.retracted = true;
}

export function enqueueExternalMessageOperation(input: {
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  runtimeConfig: ExternalRuntimeConfigSnapshot;
  userMessage: SessionMessage;
  surfaceMode?: 'chat-replay' | 'queue-started';
  queueId?: string;
}): {
  queued: true;
  queueId: string;
  dispatchAcceptance: Promise<ExternalSendResult>;
} | { queued: false; error: string } {
  if (queuedExternalMessageCount() >= EXTERNAL_MAX_QUEUE_SIZE) {
    return { queued: false, error: '排队消息已达上限，请稍后再发' };
  }
  const operation = createExternalMessageOperation(input);
  const queueId = operation.queueId;
  let settleDispatchAcceptance!: (result: ExternalSendResult) => void;
  const dispatchAcceptance = new Promise<ExternalSendResult>((resolve) => {
    settleDispatchAcceptance = resolve;
  });
  externalOperationQueue.push({
    ...operation,
    dispatchAcceptance,
    settleDispatchAcceptance,
  });
  return { queued: true, queueId, dispatchAcceptance };
}

export function enqueueExternalConfigOperation(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): number {
  const tail = externalOperationQueue[externalOperationQueue.length - 1];
  if (tail?.kind === 'config') {
    tail.patch = mergeRuntimeConfigPatches(tail.patch, patch);
    tail.source = source;
    return externalOperationQueue.length;
  }
  externalOperationQueue.push({
    kind: 'config',
    opId: `xcfg-${Date.now()}-${externalConfigSeq++}`,
    patch,
    source,
  });
  return externalOperationQueue.length;
}

export function clearExternalQueueOperationsWithCancellation(): ExternalQueuedMessageOperation[] {
  const queuedMessages = externalOperationQueue
    .filter((item): item is ExternalQueuedMessageOperation => item.kind === 'message');
  for (const item of queuedMessages) {
    markExternalUserMessageRetracted(item);
    item.context.beforeDispatch?.cancel?.();
    item.settleDispatchAcceptance({ queued: false });
  }
  if (externalReservedDrainOperation?.kind === 'message') {
    queuedMessages.push(externalReservedDrainOperation);
    markExternalUserMessageRetracted(externalReservedDrainOperation);
    externalReservedDrainOperation.context.beforeDispatch?.cancel?.();
    externalReservedDrainOperation.settleDispatchAcceptance({
      queued: false,
    });
  }
  externalOperationQueue.length = 0;
  externalReservedDrainOperation = null;
  externalOperationDrainInFlight = false;
  externalSendTail = null;
  externalOperationGeneration += 1;
  return queuedMessages;
}

export function clearExternalQueueWithCancellation(): string[] {
  return clearExternalQueueOperationsWithCancellation().map((item) => item.queueId);
}

export function cancelExternalQueuedMessageOperationsByOwner(owner: TurnOwner): ExternalQueuedMessageOperation[] {
  const matches = (item: ExternalQueuedMessageOperation) =>
    item.context.turnOwner?.kind === owner.kind
      && item.context.turnOwner.id === owner.id;
  const canceled: ExternalQueuedMessageOperation[] = [];
  for (let index = externalOperationQueue.length - 1; index >= 0; index -= 1) {
    const item = externalOperationQueue[index];
    if (item.kind !== 'message' || !matches(item)) continue;
    externalOperationQueue.splice(index, 1);
    markExternalUserMessageRetracted(item);
    item.context.beforeDispatch?.cancel?.();
    item.settleDispatchAcceptance({ queued: false });
    canceled.push(item);
  }
  return canceled;
}

export function cancelExternalQueuedMessagesByOwner(owner: TurnOwner): string[] {
  return cancelExternalQueuedMessageOperationsByOwner(owner).map((item) => item.queueId);
}

export function hasExternalQueuedMessageByOwner(owner: TurnOwner): boolean {
  const matches = (item: ExternalQueuedMessageOperation) =>
    item.context.turnOwner?.kind === owner.kind
      && item.context.turnOwner.id === owner.id;
  return externalOperationQueue.some(
    (item) => item.kind === 'message' && matches(item),
  ) || (
    externalReservedDrainOperation?.kind === 'message'
    && matches(externalReservedDrainOperation)
  );
}

export function consumeLeadingExternalConfigOps(): { patch: ExternalRuntimeConfigPatch; source: ExternalConfigSource } | null {
  let patch: ExternalRuntimeConfigPatch | null = null;
  let source: ExternalConfigSource = 'runtime-config';
  while (externalOperationQueue[0]?.kind === 'config') {
    const op = externalOperationQueue.shift() as ExternalQueuedConfigOperation;
    patch = mergeRuntimeConfigPatches(patch ?? {}, op.patch);
    source = op.source;
  }
  return patch ? { patch, source } : null;
}

export function shiftExternalOperation(): ExternalTurnOperation | undefined {
  return externalOperationQueue.shift();
}

export function reserveExternalOperationForDrain(): ExternalTurnOperation | undefined {
  externalReservedDrainOperation = externalOperationQueue.shift() ?? null;
  return externalReservedDrainOperation ?? undefined;
}

export function releaseExternalDrainReservation(item: ExternalTurnOperation | undefined): void {
  if (!item) return;
  if (externalReservedDrainOperation === item) {
    externalReservedDrainOperation = null;
  }
}

export function unshiftExternalOperation(item: ExternalTurnOperation): void {
  externalOperationQueue.unshift(item);
}

export function moveExternalQueuedMessageToFront(queueId: string): boolean {
  const idx = externalOperationQueue.findIndex(q => q.kind === 'message' && q.queueId === queueId);
  if (idx < 0) return false;
  if (idx > 0) {
    const [item] = externalOperationQueue.splice(idx, 1);
    externalOperationQueue.unshift(item);
  }
  return true;
}

export function cancelExternalQueuedMessageOperation(queueId: string): ExternalQueuedMessageOperation | null {
  const idx = externalOperationQueue.findIndex(q => q.kind === 'message' && q.queueId === queueId);
  if (idx < 0) return null;
  const [item] = externalOperationQueue.splice(idx, 1) as ExternalQueuedMessageOperation[];
  markExternalUserMessageRetracted(item);
  item.context.beforeDispatch?.cancel?.();
  item.settleDispatchAcceptance({ queued: false });
  return item;
}

export function cancelExternalQueuedMessage(queueId: string): string | null {
  return cancelExternalQueuedMessageOperation(queueId)?.text ?? null;
}

export function cancelExternalQueuedMessageByRequestId(
  requestId: string,
): ExternalQueuedMessageOperation | null {
  const item = externalOperationQueue.find(
    (candidate): candidate is ExternalQueuedMessageOperation => (
      candidate.kind === 'message' && candidate.context.requestId === requestId
    ),
  );
  return item ? cancelExternalQueuedMessageOperation(item.queueId) : null;
}

/** A reserved item is already owned by the drain; callers may signal its
 * dispatch guard/promotion, but must not remove or settle it themselves. */
export function getExternalReservedMessageByRequestId(
  requestId: string,
): ExternalQueuedMessageOperation | null {
  return externalReservedDrainOperation?.kind === 'message'
    && externalReservedDrainOperation.context.requestId === requestId
    ? externalReservedDrainOperation
    : null;
}

export function settleExternalMessageOperation(
  item: ExternalQueuedMessageOperation,
  result: ExternalSendResult,
): void {
  item.settleDispatchAcceptance(result);
}

export function getExternalQueueStatusSnapshot(): Array<{ id: string; messagePreview: string }> {
  return externalOperationQueue
    .filter((q): q is ExternalQueuedMessageOperation => q.kind === 'message')
    .map(q => ({ id: q.queueId, messagePreview: q.text.slice(0, 100) }));
}

export function chainExternalSend<T>(
  dispatch: () => Promise<T>,
  generation = externalOperationGeneration,
): Promise<T> {
  const run = (): Promise<T> => {
    if (!isCurrentExternalOperationGeneration(generation)) {
      return Promise.reject(new ExternalQueueGenerationStaleError());
    }
    try {
      return Promise.resolve(dispatch());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // Keep dispatch on the promise boundary: several callers finish binding
  // request/turn ownership immediately after enqueue returns. The tail itself
  // is assigned synchronously, which is the admission claim other IM calls see.
  const predecessor = externalSendTail ?? Promise.resolve();
  const task = predecessor.then(run);
  const tracked = task.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (externalSendTail === tracked) externalSendTail = null;
  });
  externalSendTail = tracked;
  return task;
}
