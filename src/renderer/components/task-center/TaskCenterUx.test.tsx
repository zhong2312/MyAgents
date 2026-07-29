import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMetadata } from '@/api/sessionClient';
import type { Task } from '@/../shared/types/task';

import { DispatchTaskDialog } from './DispatchTaskDialog';
import { TaskSessionsList } from './TaskSessionsList';
import { TaskStatusBadge } from './TaskStatusBadge';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskItemActions } from './views/TaskItemActions';

const taskApiMocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  taskGetRunStats: vi.fn(),
  taskCreateDirect: vi.fn(),
  taskRun: vi.fn(),
  taskWriteDoc: vi.fn(),
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
    taskRun: taskApiMocks.taskRun,
    taskWriteDoc: taskApiMocks.taskWriteDoc,
  };
});

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
vi.mock('@/components/CustomSelect', () => ({
  default: ({ value, options }: { value: string; options: Array<{ value: string; label: string }> }) => (
    <div role="button">{options.find((option) => option.value === value)?.label ?? value}</div>
  ),
}));
vi.mock('./editors/TaskAdvancedConfigEditor', () => ({
  TaskAdvancedConfigEditor: () => <div>高级配置</div>,
}));
vi.mock('@/components/task-center/NotificationConfigEditor', () => ({
  default: () => <div>任务通知配置</div>,
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
    taskApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 0 });
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
});
