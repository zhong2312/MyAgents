import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@/../shared/types/task';
import { TaskDetailOverlay, TriggerRuntimeSection } from './TaskDetailOverlay';

const detailApiMocks = vi.hoisted(() => ({
  taskDelete: vi.fn(),
  taskCheckNow: vi.fn(),
  taskGet: vi.fn(),
  taskGetRunStats: vi.fn(),
  taskResetCheckpoint: vi.fn(),
}));

vi.mock('@/api/taskCenter', () => ({
  taskArchive: vi.fn(),
  taskDelete: detailApiMocks.taskDelete,
  taskGet: detailApiMocks.taskGet,
  taskGetRunStats: detailApiMocks.taskGetRunStats,
  taskCheckNow: detailApiMocks.taskCheckNow,
  taskRerun: vi.fn(),
  taskResetCheckpoint: detailApiMocks.taskResetCheckpoint,
  taskRun: vi.fn(),
  taskRunNow: vi.fn(),
  taskTriggerTestTask: vi.fn(),
  taskUpdateStatus: vi.fn(),
}));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ projects: [] }) }));
vi.mock('@/hooks/useAgentStatuses', () => ({ useAgentStatuses: () => ({ statuses: [] }) }));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('@/config/services/agentConfigService', () => ({ patchAgentConfig: vi.fn() }));
vi.mock('@/components/OverlayBackdrop', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./TaskSessionsList', () => ({ TaskSessionsList: () => <div /> }));
vi.mock('./SummaryCard', () => ({ SummaryCard: () => <div /> }));
vi.mock('./TaskDocBlock', () => ({ TaskDocBlock: () => <div /> }));
vi.mock('./TaskEditPanel', () => ({ TaskEditPanel: () => <div /> }));

function commandTask(): Task {
  return {
    id: 'task-sensor',
    name: '等待构建完成',
    executor: 'agent',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/me/感知 项目',
    executionMode: 'recurring',
    runMode: 'single-session',
    preselectedSessionId: 'session-existing',
    intervalMinutes: 5,
    trigger: {
      source: { type: 'time' },
      detector: {
        type: 'command',
        command: { executable: 'node', args: ['detector.js', '--fixture', 'failed build.json'] },
        timeoutMs: 30_000,
      },
    },
    triggerState: {
      protocolVersion: 1,
      checkpoint: { cursor: 318 },
      checkpointRevision: 7,
      checkpointUpdatedAt: Date.parse('2026-08-03T09:00:00+08:00'),
      checkCount: 19,
      lastCheckedAt: Date.parse('2026-08-03T09:30:00+08:00'),
      lastOutcome: 'activate',
      lastReason: { code: 'build_failed', message: '构建失败' },
      lastActivatedAt: Date.parse('2026-08-03T09:30:00+08:00'),
      consecutiveFailures: 2,
      lastError: {
        code: 'detector_timeout',
        message: 'Detector timed out',
        occurredAt: Date.parse('2026-08-03T09:25:00+08:00'),
        exitCode: 137,
        signal: 'SIGKILL',
        timedOut: true,
        stderrTail: 'last stderr line',
      },
      pendingActivation: {
        event: { id: 'build-319', kind: 'ci.failed', occurredAt: '2026-08-03T09:29:00+08:00' },
        reason: { code: 'build_failed', message: '构建失败' },
        handoff: { summary: 'Build 319 failed' },
        invocationCause: 'scheduled',
        detectedAt: Date.parse('2026-08-03T09:30:00+08:00'),
        taskUpdatedAt: Date.parse('2026-08-03T09:00:00+08:00'),
        deliveryState: 'dispatching',
        queueId: 'queue-319',
      },
      recentEventIds: [],
    },
    sessionIds: ['session-existing'],
    status: 'running',
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    executionCount: 3,
    statusHistory: [],
    dispatchOrigin: 'direct',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  detailApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 3 });
});

describe('TriggerRuntimeSection', () => {
  it('shows health, split statistics, checkpoint, pending event, and error', () => {
    render(
      <TriggerRuntimeSection
        task={commandTask()}
        action={null}
        testResult={null}
        onTest={vi.fn()}
        onCheck={vi.fn()}
        onRun={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText('待投送')).toBeInTheDocument();
    expect(screen.getByText('19')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('build-319 · ci.failed')).toBeInTheDocument();
    expect(screen.getByText('Detector timed out')).toBeInTheDocument();
    expect(screen.getByText('137')).toBeInTheDocument();
    expect(screen.getByText('SIGKILL')).toBeInTheDocument();
    expect(screen.getByText('是')).toBeInTheDocument();
    expect(screen.getByText('last stderr line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即执行 AI' })).toBeDisabled();
    fireEvent.click(screen.getByText('命令配置与 checkpoint'));
    expect(screen.getByText(/"cursor": 318/)).toBeInTheDocument();
    expect(screen.getByText('["detector.js","--fixture","failed build.json"]')).toBeInTheDocument();
  });

  it('keeps test, check-now, and run-now as separate actions', () => {
    const onTest = vi.fn();
    const onCheck = vi.fn();
    const onRun = vi.fn();
    render(
      <TriggerRuntimeSection
        task={{ ...commandTask(), triggerState: { ...commandTask().triggerState!, pendingActivation: undefined } }}
        action={null}
        testResult={null}
        onTest={onTest}
        onCheck={onCheck}
        onRun={onRun}
        onReset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '测试 Detector' }));
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
    fireEvent.click(screen.getByRole('button', { name: '立即执行 AI' }));
    expect(onTest).toHaveBeenCalledOnce();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('requires confirmation before resetting the platform checkpoint', async () => {
    const task = {
      ...commandTask(),
      status: 'stopped' as const,
      triggerState: { ...commandTask().triggerState!, pendingActivation: undefined },
    };
    detailApiMocks.taskGet.mockResolvedValue(task);
    detailApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 3 });
    detailApiMocks.taskResetCheckpoint.mockResolvedValue(undefined);

    render(<TaskDetailOverlay task={task} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重置 checkpoint' }));

    expect(screen.getByText('重置平台 checkpoint？')).toBeInTheDocument();
    expect(detailApiMocks.taskResetCheckpoint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(detailApiMocks.taskResetCheckpoint).toHaveBeenCalledWith(task.id));
  });

  it('shows check-now loading/error and ignores a late result after unmount', async () => {
    const task = {
      ...commandTask(),
      status: 'stopped' as const,
      triggerState: { ...commandTask().triggerState!, pendingActivation: undefined },
    };
    detailApiMocks.taskGet.mockResolvedValue(task);
    const pendingCheck = deferred<Awaited<ReturnType<typeof import('@/api/taskCenter').taskCheckNow>>>();
    detailApiMocks.taskCheckNow.mockReturnValueOnce(pendingCheck.promise);
    const onChanged = vi.fn();
    const view = render(
      <TaskDetailOverlay task={task} onClose={vi.fn()} onChanged={onChanged} />,
    );
    await waitFor(() => expect(detailApiMocks.taskGet).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
    expect(screen.getByRole('button', { name: '立即检查' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '立即执行 AI' })).toBeDisabled();
    view.unmount();
    pendingCheck.resolve({
      outcome: 'error',
      state: {
        ...task.triggerState!,
        lastOutcome: 'error',
        lastError: {
          code: 'detector_timeout',
          message: 'late timeout',
          occurredAt: 1,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(detailApiMocks.taskGet).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('surfaces a structured check-now program failure', async () => {
    const task = {
      ...commandTask(),
      status: 'stopped' as const,
      triggerState: { ...commandTask().triggerState!, pendingActivation: undefined },
    };
    detailApiMocks.taskGet.mockResolvedValue(task);
    detailApiMocks.taskCheckNow.mockResolvedValue({
      outcome: 'error',
      state: {
        ...task.triggerState!,
        lastOutcome: 'error',
        lastError: {
          code: 'detector_timeout',
          message: 'Detector exceeded 30 seconds',
          occurredAt: 1,
          timedOut: true,
        },
      },
      queueId: 'queue-error',
    });

    render(<TaskDetailOverlay task={task} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));

    expect(await screen.findByText('Detector exceeded 30 seconds')).toBeInTheDocument();
  });

  it('requires confirmation before deleting the Task and its trigger state', async () => {
    const task = {
      ...commandTask(),
      status: 'stopped' as const,
      triggerState: { ...commandTask().triggerState!, pendingActivation: undefined },
    };
    const onClose = vi.fn();
    detailApiMocks.taskGet.mockResolvedValue(task);
    detailApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 3 });
    detailApiMocks.taskDelete.mockResolvedValue(undefined);

    render(<TaskDetailOverlay task={task} onClose={onClose} />);
    fireEvent.click(screen.getByTitle('更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(screen.getByText('删除任务')).toBeInTheDocument();
    expect(detailApiMocks.taskDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(detailApiMocks.taskDelete).toHaveBeenCalledWith(task.id));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores a late delete result after the detail overlay unmounts', async () => {
    const task = {
      ...commandTask(),
      status: 'stopped' as const,
      triggerState: { ...commandTask().triggerState!, pendingActivation: undefined },
    };
    const deletion = deferred<void>();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    detailApiMocks.taskGet.mockResolvedValue(task);
    detailApiMocks.taskDelete.mockReturnValueOnce(deletion.promise);

    const view = render(
      <TaskDetailOverlay task={task} onClose={onClose} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByTitle('更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(detailApiMocks.taskDelete).toHaveBeenCalledWith(task.id));

    view.unmount();
    deletion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
