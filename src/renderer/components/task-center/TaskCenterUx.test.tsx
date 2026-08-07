import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMetadata } from '@/api/sessionClient';
import type { Task } from '@/../shared/types/task';

import { DispatchTaskDialog } from './DispatchTaskDialog';
import { TaskSessionsList } from './TaskSessionsList';
import { TaskStatusBadge } from './TaskStatusBadge';
import { TaskListPanel } from './TaskListPanel';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskItemActions } from './views/TaskItemActions';
import { __setTaskCenterSessionsForTest } from '@/hooks/taskCenterStore';

const taskApiMocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  taskGetRunStats: vi.fn(),
  taskCreateDirect: vi.fn(),
  taskList: vi.fn(),
  taskRun: vi.fn(),
  taskRerun: vi.fn(),
  taskWriteDoc: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('@/api/sessionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sessionClient')>();
  return {
    ...actual,
    getSessions: taskApiMocks.getSessions,
  };
});

vi.mock('@/api/taskCenter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/taskCenter')>();
  return {
    ...actual,
    taskGetRunStats: taskApiMocks.taskGetRunStats,
    taskCreateDirect: taskApiMocks.taskCreateDirect,
    taskList: taskApiMocks.taskList,
    taskRun: taskApiMocks.taskRun,
    taskRerun: taskApiMocks.taskRerun,
    taskWriteDoc: taskApiMocks.taskWriteDoc,
  };
});

vi.mock('@/analytics', () => ({
  track: analyticsMocks.track,
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    projects: [{
      id: 'workspace-1',
      name: 'mino',
      displayName: 'mino',
      path: '/Users/me/mino',
      isHidden: false,
    }],
    providers: [],
  }),
}));

vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/OverlayBackdrop', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./editors/TaskAdvancedConfigEditor', () => ({
  TaskAdvancedConfigEditor: () => <div>高级配置</div>,
}));
vi.mock('@/components/task-center/NotificationConfigEditor', () => ({
  default: () => <div>任务通知配置</div>,
}));
vi.mock('./views/TaskListRow', () => ({
  TaskListRow: ({
    task,
    onRun,
    onRerun,
  }: {
    task?: Task;
    onRun?: () => void;
    onRerun?: () => void;
  }) => (
    <div>
      <span>{task?.name}</span>
      <button type="button" title="更多操作">更多操作</button>
      {task?.status === 'todo' ? (
        <button type="button" onClick={onRun}>立即执行</button>
      ) : (
        <button type="button" onClick={onRerun}>重新派发</button>
      )}
    </div>
  ),
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: '每日 AI 行业新闻与暴论',
    executor: 'agent',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/me/mino',
    executionMode: 'recurring',
    runMode: 'new-session',
    sessionIds: [],
    status: 'running',
    tags: [],
    createdAt: Date.parse('2026-06-20T00:00:00+08:00'),
    updatedAt: Date.parse('2026-06-27T11:12:00+08:00'),
    statusHistory: [],
    dispatchOrigin: 'direct',
    ...overrides,
  };
}

function expectedTaskSessionTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return d.getFullYear() === now.getFullYear()
    ? `${mm}-${dd} ${hh}:${mi}`
    : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

describe('Task Center UX refinements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem('myagents:task-center:view', 'list');
    taskApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 0 });
    taskApiMocks.taskList.mockResolvedValue([]);
    taskApiMocks.getSessions.mockResolvedValue([]);
    __setTaskCenterSessionsForTest([]);
  });

  it('defaults the task panel to list view when no preference is stored', async () => {
    window.localStorage.removeItem('myagents:task-center:view');

    render(<TaskListPanel />);

    await waitFor(() => {
      expect(screen.getByTitle(/列表视图|List view/)).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTitle(/卡片视图|Card view/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps an explicit card preference and persists a later list choice', async () => {
    window.localStorage.setItem('myagents:task-center:view', 'card');

    render(<TaskListPanel />);

    await waitFor(() => {
      expect(screen.getByTitle(/卡片视图|Card view/)).toHaveAttribute('aria-pressed', 'true');
    });

    fireEvent.click(screen.getByTitle(/列表视图|List view/));

    expect(window.localStorage.getItem('myagents:task-center:view')).toBe('list');
    expect(screen.getByTitle(/列表视图|List view/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('tracks a run only after using the ordinal accepted by the Task owner', async () => {
    const accepted = task({
      status: 'running',
      executionMode: 'once',
      sessionIds: ['shared-session'],
    });
    taskApiMocks.taskList.mockResolvedValueOnce([
      task({
        status: 'todo',
        executionMode: 'once',
        sessionIds: [],
      }),
    ]);
    taskApiMocks.taskRun.mockResolvedValueOnce({ task: accepted, attemptOrdinal: 6 });

    render(<TaskListPanel />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('立即执行'));

    await waitFor(() => expect(taskApiMocks.taskRun).toHaveBeenCalledWith('task-1'));
    expect(analyticsMocks.track).toHaveBeenCalledWith('task_run', {
      source: 'desktop',
      run_count: 6,
    });
  });

  it('does not track a run rejected before admission', async () => {
    taskApiMocks.taskList.mockResolvedValueOnce([
      task({ status: 'todo', executionMode: 'once' }),
    ]);
    taskApiMocks.taskRun.mockRejectedValueOnce(new Error('task is busy'));

    render(<TaskListPanel />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('立即执行'));

    await waitFor(() => expect(taskApiMocks.taskRun).toHaveBeenCalledWith('task-1'));
    expect(analyticsMocks.track).not.toHaveBeenCalled();
  });

  it('tracks rerun with the same accepted ordinal contract', async () => {
    const stopped = task({
      status: 'stopped',
      executionMode: 'once',
      sessionIds: [],
    });
    taskApiMocks.taskList.mockResolvedValueOnce([stopped]);
    taskApiMocks.taskRerun.mockResolvedValueOnce({
      task: { ...stopped, status: 'running' },
      attemptOrdinal: 5,
    });

    render(<TaskListPanel />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('重新派发'));

    await waitFor(() => expect(taskApiMocks.taskRerun).toHaveBeenCalledWith('task-1'));
    expect(analyticsMocks.track).toHaveBeenCalledWith('task_run', {
      source: 'desktop',
      run_count: 5,
    });
  });

  it('does not render latest status messages on task cards', () => {
    render(
      <TaskCardItem
        task={task({
          executionMode: 'once',
          statusHistory: [{
            from: 'running',
            to: 'blocked',
            at: Date.parse('2026-06-27T11:12:00+08:00'),
            actor: 'system',
            source: 'crash',
            message: '上次运行被应用重启中断，调度器将在下次计划时间继续',
          }],
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByText(/上次运行被应用重启中断/)).not.toBeInTheDocument();
  });

  it('marks command Detector tasks in the normal task list surface', () => {
    render(
      <TaskCardItem
        task={task({
          trigger: {
            source: { type: 'time' },
            detector: {
              type: 'command',
              command: { executable: 'node', args: ['detector.js'] },
            },
          },
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('命令感知')).toBeInTheDocument();
  });

  it('projects a failed stop separately from the persisted stopped status', () => {
    render(<TaskStatusBadge status="stopped" executionState="stop_failed" />);

    expect(screen.getByText('停止未确认')).toBeInTheDocument();
  });

  it('offers retry-stop but no generic rerun for terminal attached work', () => {
    const retryStop = vi.fn();
    const { rerender } = render(
      <TaskItemActions
        variant="task"
        status="stopped"
        executionState="stop_failed"
        canRerun={false}
        onStop={retryStop}
        onOpenDetail={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    expect(screen.queryByText('删除')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('重试中止'));
    expect(retryStop).toHaveBeenCalledOnce();

    rerender(
      <TaskItemActions
        variant="task"
        status="done"
        canRerun={false}
        onRerun={vi.fn()}
        onOpenDetail={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    expect(screen.queryByText('重新派发')).not.toBeInTheDocument();
  });

  it('uses launcher session title fallback and keeps execution timestamps on one line', async () => {
    const session: SessionMetadata = {
      id: 'session-1',
      agentDir: '/Users/me/mino',
      title: 'New Chat',
      lastMessagePreview: '每日 AI 行业新闻采集与总结',
      createdAt: '2026-06-27T03:12:00.000Z',
      lastActiveAt: '2026-06-27T03:12:00.000Z',
    };
    taskApiMocks.getSessions.mockResolvedValueOnce([session]);

    render(<TaskSessionsList task={task({ sessionIds: ['session-1'] })} />);

    expect(await screen.findByText('每日 AI 行业新闻采集与总结')).toBeInTheDocument();
    expect(screen.queryByText('New Chat')).not.toBeInTheDocument();

    const timestamp = screen.getByText(expectedTaskSessionTimestamp(session.lastActiveAt));
    expect(timestamp).toHaveClass('whitespace-nowrap', 'tabular-nums');
    expect(taskApiMocks.getSessions).toHaveBeenCalledWith('/Users/me/mino');
  });

  it('starts the create task form with name, task demand, checklist, and workspace configuration', async () => {
    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
      />,
    );

    expect(screen.queryByText('基本信息')).not.toBeInTheDocument();
    expect(screen.queryByText('简短描述')).not.toBeInTheDocument();
    expect(screen.queryByText('标签')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('以逗号分隔，例如 MyAgents, 维护')).not.toBeInTheDocument();
    expect(screen.getByText('任务需求 Task.md')).toBeInTheDocument();
    expect(screen.queryByText('AI 执行时看到的 prompt，默认取自想法原文。你可以补充细节、目标、约束。')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('AI 执行时看到的 prompt，默认取自想法原文。你可以补充细节、目标、约束。')).toBeInTheDocument();

    const name = screen.getByText('任务名称');
    const taskDemand = screen.getByText('任务需求 Task.md');
    const checklist = screen.getByText('验收清单');
    const workspace = screen.getByText('Agent 工作区');

    await waitFor(() => {
      expect(name.compareDocumentPosition(taskDemand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(taskDemand.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(checklist.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('creates a blank task without exposing or synthesizing tags', async () => {
    taskApiMocks.taskCreateDirect.mockResolvedValue(task({
      name: '整理交付清单',
      executionMode: 'once',
      status: 'todo',
    }));
    taskApiMocks.taskRun.mockResolvedValue(true);

    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如: 升级 OpenClaw lark 适配器到 v2.4'), {
      target: { value: '整理交付清单' },
    });
    fireEvent.change(screen.getByPlaceholderText('AI 执行时看到的 prompt，默认取自想法原文。你可以补充细节、目标、约束。'), {
      target: { value: '整理本周交付内容并输出检查清单。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => {
      expect(taskApiMocks.taskCreateDirect).toHaveBeenCalledWith(
        expect.objectContaining({ tags: [] }),
      );
    });
  });

  it('materializes an existing Session when continuous conversation is selected', async () => {
    const existing: SessionMetadata = {
      id: 'session-existing',
      agentDir: '/Users/me/mino',
      title: '构建排障上下文',
      createdAt: '2026-08-03T01:00:00.000Z',
      lastActiveAt: '2026-08-03T02:00:00.000Z',
    };
    const other: SessionMetadata = {
      id: 'session-other',
      agentDir: '/Users/me/mino',
      title: '其他排障上下文',
      createdAt: '2026-08-02T01:00:00.000Z',
      lastActiveAt: '2026-08-02T02:00:00.000Z',
    };
    __setTaskCenterSessionsForTest([other, existing]);
    taskApiMocks.taskCreateDirect.mockResolvedValue(task({
      executionMode: 'once',
      runMode: 'single-session',
      preselectedSessionId: existing.id,
      status: 'todo',
    }));
    taskApiMocks.taskRun.mockResolvedValue(true);

    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        currentSessionId="session-existing"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('例如: 升级 OpenClaw lark 适配器到 v2.4'), {
      target: { value: '等待构建完成' },
    });
    fireEvent.change(screen.getByPlaceholderText('AI 执行时看到的 prompt，默认取自想法原文。你可以补充细节、目标、约束。'), {
      target: { value: '构建失败后分析日志。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '连续对话' }));
    // The actual current Session is selected by default; opening that selector
    // must still expose the distinction from other workspace Sessions.
    fireEvent.click(screen.getByRole('button', { name: '当前 Session · 构建排障上下文' }));
    const currentSessionButtons = screen.getAllByRole('button', { name: '当前 Session · 构建排障上下文' });
    expect(currentSessionButtons).toHaveLength(2);
    expect(screen.getByRole('button', { name: '其他 Session · 其他排障上下文' })).toBeInTheDocument();
    fireEvent.click(currentSessionButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(taskApiMocks.taskCreateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runMode: 'single-session',
        preselectedSessionId: 'session-existing',
      }),
    ));
  });
});
