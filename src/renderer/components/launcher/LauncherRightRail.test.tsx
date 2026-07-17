import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import type { TaskCenterData } from '@/hooks/useTaskCenterData';
import { i18n } from '@/i18n';
import * as taskCenterUtils from '@/utils/taskCenterUtils';

import LauncherRightRail from './LauncherRightRail';

vi.mock('@/utils/taskCenterUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/taskCenterUtils')>();
    return {
        ...actual,
        formatMessageCount: vi.fn(actual.formatMessageCount),
    };
});

vi.mock('@/components/SessionStatsModal', () => ({
    default: ({ sessionId }: { sessionId: string }) => (
        <div role="dialog" aria-label="session stats">
            stats:{sessionId}
        </div>
    ),
}));

function project(index: number): Project {
    return {
        id: `p${index}`,
        name: `Project ${index}`,
        displayName: index === 1 ? 'MyAgents' : `Project ${index}`,
        path: `/Users/zhihu/Documents/project/project-${index}`,
        providerId: null,
        permissionMode: null,
        isAgent: index === 1,
        agentId: index === 1 ? 'agent-1' : undefined,
    };
}

function session(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
        id: 's1',
        agentDir: project(1).path,
        title: 'Session A',
        createdAt: '2026-06-20T00:00:00.000Z',
        lastActiveAt: '2026-06-20T00:19:00.000Z',
        ...overrides,
    };
}

function taskCenterData(
    sessions: SessionMetadata[],
    actionOverrides: Partial<TaskCenterData['actions']> = {},
): TaskCenterData {
    return {
        sessions,
        cronTasks: [],
        protectedSchedulerSessionIds: new Set<string>(),
        tasks: [],
        sessionTagsMap: new Map(),
        cronBotInfoMap: new Map(),
        isLoading: false,
        isSessionsLoading: false,
        error: null,
        refresh: vi.fn(),
        actions: {
            deleteSession: vi.fn(async () => true),
            setSessionFavorite: vi.fn(async () => true),
            refreshSessions: vi.fn(),
            refreshCronTasks: vi.fn(),
            refreshTasks: vi.fn(),
            ...actionOverrides,
        },
    };
}

function renderRail(options: {
    projects?: Project[];
    sessions?: SessionMetadata[];
    actionOverrides?: Partial<TaskCenterData['actions']>;
    onOpenTask?: ReturnType<typeof vi.fn>;
} = {}) {
    const projects = options.projects ?? [project(1), project(2), project(3), project(4)];
    const onOpenTask = options.onOpenTask ?? vi.fn();
    const view = render(
        <ToastProvider>
            <LauncherRightRail
                projects={projects}
                agentLookup={new Map()}
                isProjectsLoading={false}
                launchingProjectId={null}
                taskCenterData={taskCenterData(options.sessions ?? [session()], options.actionOverrides)}
                onLaunch={vi.fn()}
                onOpenTask={onOpenTask}
                onOpenOverlay={vi.fn()}
                onRemoveProject={vi.fn()}
                onArchiveProject={vi.fn()}
                onUnarchiveProject={vi.fn()}
                onAgentSettings={vi.fn()}
                onOpenProjectFolder={vi.fn()}
                onToggleProjectPin={vi.fn()}
                onAddFolder={vi.fn()}
                onCreateFromTemplate={vi.fn()}
                onShowLogs={vi.fn()}
            />
        </ToastProvider>,
    );
    return { ...view, onOpenTask };
}

describe('LauncherRightRail', () => {
    beforeEach(() => {
        window.localStorage.removeItem('myagents.launcher.showAutomationHistorySessions');
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
                this.scrollTop = options.top ?? 0;
            }),
        });
    });

    it('collapses workspaces immediately and returns the right rail to the top', () => {
        const projects = [
            project(1),
            project(2),
            project(3),
            project(4),
            project(5),
            project(6),
            project(7),
            project(8),
        ];
        const { container } = renderRail({ projects });
        const scrollRoot = container.querySelector('.launcher-workspaces > div') as HTMLDivElement;

        fireEvent.click(screen.getByRole('button', { name: /展开更多 2 个/ }));
        expect(screen.getByText('Project 8')).toBeInTheDocument();

        scrollRoot.scrollTop = 420;
        fireEvent.click(screen.getByRole('button', { name: /^收起$/ }));

        expect(screen.getByRole('button', { name: /展开更多 2 个/ })).toBeInTheDocument();
        expect(screen.queryByText('Project 8')).not.toBeInTheDocument();
        expect(scrollRoot.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    });

    it('collapses archived workspaces when the workspace list collapses', () => {
        const projects = [
            project(1),
            project(2),
            project(3),
            project(4),
            project(5),
            project(6),
            project(7),
            { ...project(8), archivedAt: '2026-07-03T00:00:00.000Z' },
        ];
        renderRail({ projects });

        fireEvent.click(screen.getByRole('button', { name: /展示归档 Agent 工作区/ }));
        expect(screen.getByText('Project 8')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /展开更多 1 个/ }));
        fireEvent.click(screen.getByRole('button', { name: /^收起$/ }));

        expect(screen.getByRole('button', { name: /展示归档 Agent 工作区/ })).toBeInTheDocument();
        expect(screen.queryByText('Project 8')).not.toBeInTheDocument();
    });

    it('renders right rail chrome in English when the UI language is English', async () => {
        await i18n.changeLanguage('en-US');
        const projects = [
            project(1),
            project(2),
            project(3),
            project(4),
            project(5),
            project(6),
            project(7),
            project(8),
        ];

        renderRail({ projects, sessions: [] });

        expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Show 2 more/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Filter chat history: All/ })).toBeInTheDocument();
        expect(screen.getByText('No chat history')).toBeInTheDocument();
    });

    it('shows six collapsed workspaces before revealing the expand button', () => {
        renderRail({ projects: [project(1), project(2), project(3), project(4), project(5), project(6)] });

        expect(screen.getByText('Project 6')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /展开更多/ })).not.toBeInTheDocument();
    });

    it('labels the automation history toggle by current state', () => {
        renderRail({ sessions: [] });

        const hiddenStateButton = screen.getByRole('button', { name: '定时任务对话已隐藏' });
        fireEvent.click(hiddenStateButton);

        expect(screen.getByRole('button', { name: '定时任务对话已显示' })).toBeInTheDocument();
    });

    it('keeps the sticky history header inside the content column', () => {
        const { container } = renderRail();
        const stickyHeader = container.querySelector('.sticky') as HTMLElement;

        expect(stickyHeader).toHaveClass('bg-[var(--paper)]');
        expect(stickyHeader).not.toHaveClass('-mx-6');
        expect(stickyHeader).not.toHaveClass('px-6');
    });

    it('does not open the history session when a row menu action is clicked', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '查看统计' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'session stats' })).toHaveTextContent('stats:stats-session');
    });

    it('renders history row actions as an overlay without taking title width', () => {
        renderRail({ sessions: [session({ title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });

        expect(screen.getByText('Session A').closest('.launcher-history-row-title-fade')).not.toBeNull();
        expect(within(row).getByLabelText('更多').parentElement).toHaveClass('launcher-history-row-action-overlay');
    });

    it('filters launcher history to favorite sessions', () => {
        renderRail({
            sessions: [
                session({ id: 'favorite-session', title: 'Favorite Session', favorite: true }),
                session({ id: 'plain-session', title: 'Plain Session', lastActiveAt: '2026-06-20T00:18:00.000Z' }),
            ],
        });

        fireEvent.click(screen.getByRole('button', { name: /筛选历史对话/ }));
        fireEvent.click(screen.getByRole('button', { name: '我的收藏' }));

        expect(screen.getByText('Favorite Session')).toBeInTheDocument();
        expect(screen.queryByText('Plain Session')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /筛选历史对话：我的收藏/ })).toBeInTheDocument();
    });

    it('keeps only one history row menu open at a time', () => {
        renderRail({
            sessions: [
                session({ id: 'session-a', title: 'Session A' }),
                session({ id: 'session-b', title: 'Session B', lastActiveAt: '2026-06-20T00:18:00.000Z' }),
            ],
        });

        fireEvent.click(within(screen.getByRole('button', { name: /Session A/ })).getByLabelText('更多'));
        expect(screen.getAllByRole('button', { name: '查看统计' })).toHaveLength(1);

        fireEvent.click(within(screen.getByRole('button', { name: /Session B/ })).getByLabelText('更多'));
        expect(screen.getAllByRole('button', { name: '查看统计' })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
    });

    it('does not re-render non-target history rows when opening a row menu', () => {
        const formatMessageCount = vi.mocked(taskCenterUtils.formatMessageCount);
        renderRail({
            sessions: [
                session({ id: 'session-a', title: 'Session A' }),
                session({ id: 'session-b', title: 'Session B', lastActiveAt: '2026-06-20T00:18:00.000Z' }),
                session({ id: 'session-c', title: 'Session C', lastActiveAt: '2026-06-20T00:17:00.000Z' }),
            ],
        });

        formatMessageCount.mockClear();
        fireEvent.click(within(screen.getByRole('button', { name: /Session A/ })).getByLabelText('更多'));

        expect(formatMessageCount).toHaveBeenCalledTimes(1);
        expect(formatMessageCount.mock.calls[0]?.[0].id).toBe('session-a');
    });

    it('toggles favorite from the history row menu without opening the session', () => {
        const onOpenTask = vi.fn();
        const setSessionFavorite = vi.fn(async () => true);
        renderRail({
            onOpenTask,
            actionOverrides: { setSessionFavorite },
            sessions: [session({ id: 'favorite-target', title: 'Session A', favorite: false })],
        });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '收藏对话' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(setSessionFavorite).toHaveBeenCalledWith('favorite-target', true);
    });

    it('toggles favorite off from the history row menu', () => {
        const setSessionFavorite = vi.fn(async () => true);
        renderRail({
            actionOverrides: { setSessionFavorite },
            sessions: [session({ id: 'favorite-target', title: 'Session A', favorite: true })],
        });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '取消收藏' }));

        expect(setSessionFavorite).toHaveBeenCalledWith('favorite-target', false);
    });

    it('does not open the history session from row menu keyboard activation keys', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        const moreButton = within(row).getByLabelText('更多');
        fireEvent.keyDown(moreButton, { key: 'Enter' });
        fireEvent.click(moreButton);
        const statsItem = screen.getByRole('button', { name: '查看统计' });

        fireEvent.keyDown(statsItem, { key: 'Enter' });
        fireEvent.keyDown(statsItem, { key: ' ' });

        expect(onOpenTask).not.toHaveBeenCalled();
    });

    it('does not open the history session when clicking row menu padding', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        const popover = screen.getByRole('button', { name: '查看统计' }).parentElement as HTMLElement;

        fireEvent.click(popover);

        expect(onOpenTask).not.toHaveBeenCalled();
    });

    it('opens the same history menu from row right-click without opening the session', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        expect(row).toHaveClass('select-none');
        fireEvent.contextMenu(row, { clientX: 120, clientY: 240 });

        expect(screen.getByRole('button', { name: '查看统计' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '查看统计' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'session stats' })).toHaveTextContent('stats:stats-session');
    });

    it('opens the history menu on right mouse down before browser text selection can start', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.mouseDown(row, { button: 2, buttons: 2, clientX: 120, clientY: 240 });

        expect(screen.getByRole('button', { name: '查看统计' })).toBeInTheDocument();
        expect(onOpenTask).not.toHaveBeenCalled();
    });

    it('opens delete confirmation without opening the history session', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'delete-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '删除' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(screen.getByText('删除对话')).toBeInTheDocument();
    });
});
