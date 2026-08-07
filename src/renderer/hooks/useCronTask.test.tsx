import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCronTask,
  deleteCronTask,
  getCronTask,
  startCronTask,
  stopCronTask,
} from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { useCronTask } from './useCronTask';

vi.mock('@/api/cronTaskClient', () => ({
  createCronTask: vi.fn(),
  startCronTask: vi.fn(),
  stopCronTask: vi.fn(),
  deleteCronTask: vi.fn(),
  getCronTask: vi.fn(),
}));

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    workspacePath: '/tmp/workspace',
    sessionId: 'session-1',
    prompt: 'keep going',
    intervalMinutes: 5,
    endConditions: { aiCanExit: true },
    runMode: 'single_session',
    status: 'running',
    executionCount: 0,
    createdAt: '2026-07-10T10:00:00.000Z',
    notifyEnabled: true,
    schedule: { kind: 'every', minutes: 5 },
    ...overrides,
  };
}

describe('useCronTask surface ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createCronTask).mockResolvedValue(task({ status: 'stopped' }));
    vi.mocked(startCronTask).mockResolvedValue(task());
    vi.mocked(stopCronTask).mockResolvedValue(task({ status: 'stopped' }));
    vi.mocked(deleteCronTask).mockResolvedValue();
    vi.mocked(getCronTask).mockResolvedValue(task());
  });

  it('restores an ordinary time-based Cron', () => {
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
      materializeOwner: async () => ({
        workspacePath: '/tmp/workspace',
        sessionId: 'session-1',
      }),
    }));

    act(() => result.current.restoreFromTask(task()));

    expect(result.current.state.task?.id).toBe('task-1');
    expect(result.current.state.config?.taskKind).toBe('cron');
  });

  it('refuses to restore a retired legacy Loop', () => {
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
      materializeOwner: async () => ({
        workspacePath: '/tmp/workspace',
        sessionId: 'session-1',
      }),
    }));

    act(() => result.current.restoreFromTask(task({ schedule: { kind: 'loop' } })));

    expect(result.current.state.task).toBeNull();
    expect(result.current.state.config).toBeNull();
  });

  it('materializes a pending owner before committing a single-session Task', async () => {
    const materializeOwner = vi.fn().mockResolvedValue({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-real',
    });
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'pending-tab-1',
      materializeOwner,
    }));
    act(() => result.current.enableCronMode({
      taskKind: 'cron',
      prompt: 'keep going',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session',
      notifyEnabled: true,
    }));

    await act(async () => {
      await result.current.startTask();
    });

    expect(materializeOwner).toHaveBeenCalledTimes(1);
    expect(createCronTask).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-real',
      runMode: 'single_session',
    }));
  });

  it('does not create a Task when pending materialization fails', async () => {
    const materializeOwner = vi.fn().mockRejectedValue(new Error('materialize failed'));
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'pending-tab-1',
      materializeOwner,
    }));
    act(() => result.current.enableCronMode({
      taskKind: 'cron',
      prompt: 'keep going',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session',
      notifyEnabled: true,
    }));

    await act(async () => {
      await expect(result.current.startTask()).rejects.toThrow('materialize failed');
    });

    expect(createCronTask).not.toHaveBeenCalled();
    expect(result.current.state.task).toBeNull();
  });

  it('lets cancellation win after materialization but before Task creation', async () => {
    let resolveOwner!: (owner: { workspacePath: string; sessionId: string }) => void;
    const materializeOwner = vi.fn(() => new Promise<{ workspacePath: string; sessionId: string }>(
      resolve => { resolveOwner = resolve; },
    ));
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'pending-tab-1',
      materializeOwner,
    }));
    act(() => result.current.enableCronMode({
      taskKind: 'cron',
      prompt: 'keep going',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session',
      notifyEnabled: true,
    }));

    let startPromise!: Promise<void>;
    act(() => { startPromise = result.current.startTask(); });
    await waitFor(() => expect(materializeOwner).toHaveBeenCalledTimes(1));
    act(() => result.current.disableCronMode());
    await act(async () => {
      resolveOwner({ workspacePath: '/tmp/workspace', sessionId: 'session-real' });
      await startPromise;
    });

    expect(createCronTask).not.toHaveBeenCalled();
    expect(result.current.state.isEnabled).toBe(false);
  });

  it('does not create a Task after the owning Tab unmounts', async () => {
    let resolveOwner!: (owner: { workspacePath: string; sessionId: string }) => void;
    const materializeOwner = vi.fn(() => new Promise<{ workspacePath: string; sessionId: string }>(
      resolve => { resolveOwner = resolve; },
    ));
    const { result, unmount } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'pending-tab-1',
      materializeOwner,
    }));
    act(() => result.current.enableCronMode({
      taskKind: 'cron',
      prompt: 'keep going',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session',
      notifyEnabled: true,
    }));

    let startPromise!: Promise<void>;
    act(() => { startPromise = result.current.startTask(); });
    await waitFor(() => expect(materializeOwner).toHaveBeenCalledTimes(1));
    unmount();
    resolveOwner({ workspacePath: '/tmp/workspace', sessionId: 'session-real' });
    await startPromise;

    expect(createCronTask).not.toHaveBeenCalled();
  });
});
