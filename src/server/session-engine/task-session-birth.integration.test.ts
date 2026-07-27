import { describe, expect, it, vi } from 'vitest';
import {
  beginTaskSessionBirth,
  cancelTaskSessionBirth,
  runTaskSessionBirthAdmission,
} from './task-session-birth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Task Session birth admission', () => {
  it('cancels a creator waiting before materialization without running the write', async () => {
    const taskId = `task-before-${crypto.randomUUID()}`;
    const queueId = crypto.randomUUID();
    const authorize = deferred<{ accepted: boolean }>();
    const materialize = vi.fn(async () => 'session');
    const cancelDispatch = vi.fn();
    const lease = beginTaskSessionBirth(taskId, queueId, cancelDispatch)!;
    const admission = runTaskSessionBirthAdmission(
      lease,
      Object.assign(() => authorize.promise, { cancel: cancelDispatch }),
      materialize,
    );

    const settlement = cancelTaskSessionBirth(taskId, queueId);
    expect(settlement).not.toBeNull();
    await expect(settlement).resolves.toBeUndefined();
    authorize.resolve({ accepted: true });

    await expect(admission).resolves.toMatchObject({
      accepted: false,
      code: 'task_dispatch_canceled',
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('makes Stop wait for an in-progress metadata write and rejects late dispatch', async () => {
    const taskId = `task-during-${crypto.randomUUID()}`;
    const queueId = crypto.randomUUID();
    const metadataWrite = deferred<string>();
    const cancelDispatch = vi.fn();
    const lease = beginTaskSessionBirth(taskId, queueId, cancelDispatch)!;
    const admission = runTaskSessionBirthAdmission(
      lease,
      Object.assign(async () => ({ accepted: true }), {
        cancel: cancelDispatch,
      }),
      () => metadataWrite.promise,
    );
    await Promise.resolve();

    let stopSettled = false;
    const settlement = cancelTaskSessionBirth(taskId, queueId)!.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    metadataWrite.resolve('session-created');
    await expect(admission).resolves.toMatchObject({
      accepted: false,
      code: 'task_dispatch_canceled',
    });
    await settlement;
    expect(stopSettled).toBe(true);
    expect(cancelTaskSessionBirth(taskId, queueId)).toBeNull();
  });

  it('settles normally after authorized metadata birth', async () => {
    const taskId = `task-success-${crypto.randomUUID()}`;
    const queueId = crypto.randomUUID();
    const lease = beginTaskSessionBirth(taskId, queueId, () => undefined)!;

    await expect(
      runTaskSessionBirthAdmission(
        lease,
        async () => ({ accepted: true }),
        async () => 'session-created',
      ),
    ).resolves.toEqual({ accepted: true, value: 'session-created' });
    expect(cancelTaskSessionBirth(taskId, queueId)).toBeNull();
  });
});
