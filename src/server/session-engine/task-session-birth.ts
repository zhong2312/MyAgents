import type { DispatchGuard, DispatchGuardResult } from '../session-core/turn-queue';

type TaskSessionBirthPhase = 'registered' | 'materializing' | 'settled';

type TaskSessionBirthEntry = {
  key: string;
  taskId: string;
  queueId: string;
  canceled: boolean;
  phase: TaskSessionBirthPhase;
  cancelDispatch: () => void;
  settled: Promise<void>;
  resolveSettled: () => void;
};

export type TaskSessionBirthLease = {
  readonly taskId: string;
  readonly queueId: string;
  isCanceled(): boolean;
  settle(): void;
};

export type TaskSessionBirthAdmission<T> =
  | { accepted: true; value: T }
  | { accepted: false; code?: string; error: string };

const pendingTaskSessionBirths = new Map<string, TaskSessionBirthEntry>();
const taskSessionBirthEntries = new WeakMap<TaskSessionBirthLease, TaskSessionBirthEntry>();

function birthKey(taskId: string, queueId: string): string {
  return `${taskId}\u0000${queueId}`;
}

function settleEntry(entry: TaskSessionBirthEntry): void {
  if (entry.phase === 'settled') return;
  entry.phase = 'settled';
  if (pendingTaskSessionBirths.get(entry.key) === entry) {
    pendingTaskSessionBirths.delete(entry.key);
  }
  entry.resolveSettled();
}

/**
 * Register the pre-metadata phase of one exact Task request. The lease is
 * installed before the request waits on the scheduled-turn mutex, so Stop can
 * cancel a queued creator without waiting for an unrelated long turn.
 */
export function beginTaskSessionBirth(
  taskId: string,
  queueId: string,
  cancelDispatch: () => void,
): TaskSessionBirthLease | null {
  const key = birthKey(taskId, queueId);
  if (pendingTaskSessionBirths.has(key)) return null;

  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const entry: TaskSessionBirthEntry = {
    key,
    taskId,
    queueId,
    canceled: false,
    phase: 'registered',
    cancelDispatch,
    settled,
    resolveSettled,
  };
  pendingTaskSessionBirths.set(key, entry);
  const lease: TaskSessionBirthLease = {
    taskId,
    queueId,
    isCanceled: () => entry.canceled,
    settle: () => settleEntry(entry),
  };
  taskSessionBirthEntries.set(lease, entry);
  return lease;
}

/**
 * Cancel an exact pre-birth request and return its settlement barrier. Before
 * materialization starts, cancellation is immediately authoritative because
 * the admission helper will refuse to enter that phase. During the metadata
 * write, Stop waits for the write/cancellation check to settle.
 */
export function cancelTaskSessionBirth(taskId: string, queueId: string): Promise<void> | null {
  const entry = pendingTaskSessionBirths.get(birthKey(taskId, queueId));
  if (!entry || entry.taskId !== taskId || entry.queueId !== queueId) return null;

  entry.canceled = true;
  entry.cancelDispatch();
  if (entry.phase === 'registered') settleEntry(entry);
  return entry.settled;
}

function rejectedAdmission(result: DispatchGuardResult): TaskSessionBirthAdmission<never> {
  return {
    accepted: false,
    ...(result.code ? { code: result.code } : {}),
    error: result.error ?? 'Task execution is no longer authorized',
  };
}

/**
 * Linearize Rust execution authorization, Stop cancellation, and SessionStore
 * metadata birth. There is no await between the final canceled check and the
 * phase transition to `materializing`; Stop either prevents the transition or
 * waits for its settlement.
 */
export async function runTaskSessionBirthAdmission<T>(
  lease: TaskSessionBirthLease,
  authorize: DispatchGuard,
  materialize: () => Promise<T>,
): Promise<TaskSessionBirthAdmission<T>> {
  const entry = taskSessionBirthEntries.get(lease);
  if (!entry) {
    throw new Error('Unknown Task Session birth lease');
  }
  if (entry.canceled || entry.phase === 'settled') {
    settleEntry(entry);
    return rejectedAdmission({
      accepted: false,
      code: 'task_dispatch_canceled',
      error: 'Task execution was canceled before Session creation',
    });
  }

  let authorization: DispatchGuardResult;
  try {
    authorization = await authorize();
  } catch (error) {
    authorization = {
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (entry.canceled) {
    settleEntry(entry);
    return rejectedAdmission({
      accepted: false,
      code: 'task_dispatch_canceled',
      error: 'Task execution was canceled before Session creation',
    });
  }
  if (!authorization.accepted) {
    settleEntry(entry);
    return rejectedAdmission(authorization);
  }

  // JavaScript runs this check + phase transition without an interleaving
  // await. A concurrent Stop therefore observes either `registered` and
  // prevents materialization, or `materializing` and waits for settlement.
  entry.phase = 'materializing';
  try {
    const value = await materialize();
    if (entry.canceled) {
      return rejectedAdmission({
        accepted: false,
        code: 'task_dispatch_canceled',
        error: 'Task execution was canceled during Session creation',
      });
    }
    return { accepted: true, value };
  } finally {
    settleEntry(entry);
  }
}
