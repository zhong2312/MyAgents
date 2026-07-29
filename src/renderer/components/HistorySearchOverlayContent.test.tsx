import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchSessions: vi.fn(),
    deleteSession: vi.fn(),
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
    },
}));

vi.mock('@/api/searchClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/api/searchClient')>();
    return { ...actual, searchSessions: mocks.searchSessions };
});

vi.mock('@/components/Toast', () => ({
    useToast: () => mocks.toast,
}));

vi.mock('@/context/SessionDeletionContext', () => ({
    useSessionDeletion: () => mocks.deleteSession,
}));

vi.mock('react-virtuoso', () => ({
    Virtuoso: ({
        data,
        itemContent,
    }: {
        data: unknown[];
        itemContent: (index: number, item: unknown) => React.ReactNode;
    }) => <>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</>,
}));

import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import type { TaskCenterData } from '@/hooks/useTaskCenterData';
import { i18n } from '@/i18n';

import HistorySearchOverlayContent from './HistorySearchOverlayContent';

const session: SessionMetadata = {
    id: '642ea003-5219-4af7-a812-a9812d6e79de',
    agentDir: '/workspace',
    title: 'Shared menu session',
    createdAt: '2026-07-20T00:00:00.000Z',
    lastActiveAt: '2026-07-20T00:00:00.000Z',
};

const project: Project = {
    id: 'project-1',
    name: 'Workspace',
    path: '/workspace',
    providerId: null,
    permissionMode: null,
};

function taskCenterData(overrides: Partial<TaskCenterData> = {}): TaskCenterData {
    return {
        sessions: [session],
        deleteProtectedSessionIds: new Set(),
        sessionTagsMap: new Map(),
        isSessionsLoading: false,
        actions: {
            deleteSession: vi.fn(async () => ({ deleted: true as const })),
            setSessionFavorite: vi.fn(async () => true),
        },
        ...overrides,
    } as TaskCenterData;
}

function renderOverlay(initialMode: 'default' | 'search' = 'default') {
    return render(
        <HistorySearchOverlayContent
            projects={[project]}
            taskCenterData={taskCenterData()}
            initialMode={initialMode}
            onClose={vi.fn()}
            onOpenSession={vi.fn()}
        />,
    );
}

function expectSharedSessionMenu() {
    const menu = document.querySelector<HTMLElement>('.session-context-menu');
    expect(menu).not.toBeNull();
    expect(within(menu!).getAllByRole('button').map(button => button.textContent)).toEqual([
        i18n.t('launcher:rightRail.copySessionId'),
        i18n.t('launcher:rightRail.favorite'),
        i18n.t('launcher:rightRail.viewStats'),
        i18n.t('launcher:rightRail.delete'),
    ]);
}

describe('HistorySearchOverlayContent', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage('zh-CN');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
    });

    it('keeps only all and favorites in the non-search browse filters', () => {
        renderOverlay();

        const browseFilters = document.querySelector<HTMLElement>('[data-history-browse-filters]')!;
        expect(within(browseFilters).getByRole('button', { name: '全部' })).toBeInTheDocument();
        const favoritesFilter = within(browseFilters).getByRole('button', { name: '收藏' });
        for (const removedFilter of ['活跃中', '桌面', '聊天机器人']) {
            expect(within(browseFilters).queryByRole('button', { name: removedFilter })).not.toBeInTheDocument();
        }

        fireEvent.click(favoritesFilter);
        expect(screen.queryByText(session.title)).not.toBeInTheDocument();
    });

    it('uses the shared sidebar menu and suppresses text selection in the browse list', async () => {
        renderOverlay();

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-session-row]')!;
        expect(row).toHaveClass('select-none');

        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
        fireEvent(row, mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);

        const contextMenu = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 120,
            clientY: 90,
        });
        fireEvent(row, contextMenu);
        expect(contextMenu.defaultPrevented).toBe(true);
        expectSharedSessionMenu();

        fireEvent.click(screen.getByRole('button', { name: i18n.t('launcher:rightRail.copySessionId') }));
        await waitFor(() => {
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${session.id}`);
            expect(mocks.toast.success).toHaveBeenCalledWith(i18n.t('launcher:rightRail.copySessionIdSuccess'));
        });
    });

    it('routes browse deletion through the App owner and explains a live owner refusal', async () => {
        mocks.deleteSession.mockResolvedValue({ deleted: false, reason: 'in-use' });
        renderOverlay();

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
        const menu = document.querySelector<HTMLElement>('.session-context-menu')!;
        fireEvent.click(within(menu).getByRole('button', { name: i18n.t('launcher:rightRail.delete') }));
        const confirm = screen.getByText(i18n.t('app:historyOverlay.deleteTitle'))
            .closest<HTMLElement>('.glass-panel')!;
        fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('app:historyOverlay.delete') }));

        await waitFor(() => {
            expect(mocks.deleteSession).toHaveBeenCalledWith(session.id);
            expect(mocks.toast.warning).toHaveBeenCalledWith(
                i18n.t('launcher:rightRail.deleteBlockedByOwner'),
            );
        });
    });

    it('routes a direct Session ID deletion through the App owner', async () => {
        mocks.deleteSession.mockResolvedValue({ deleted: true });
        renderOverlay('search');
        fireEvent.change(screen.getByPlaceholderText(i18n.t('app:historyOverlay.searchPlaceholder')), {
            target: { value: `SessionID: ${session.id}` },
        });

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-direct-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 160, clientY: 110 });

        expectSharedSessionMenu();
        const menu = document.querySelector<HTMLElement>('.session-context-menu')!;
        fireEvent.click(within(menu).getByRole('button', { name: i18n.t('launcher:rightRail.delete') }));
        const confirm = screen.getByText(i18n.t('app:historyOverlay.deleteTitle'))
            .closest<HTMLElement>('.glass-panel')!;
        fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('app:historyOverlay.delete') }));

        await waitFor(() => {
            expect(mocks.deleteSession).toHaveBeenCalledWith(session.id);
            expect(mocks.toast.success).toHaveBeenCalledWith(
                i18n.t('app:historyOverlay.deleted'),
            );
        });
    });

    it('opens the same menu for a full-text search result', async () => {
        mocks.searchSessions.mockResolvedValue({
            hits: [{
                sessionId: session.id,
                title: session.title,
                agentDir: session.agentDir,
                score: 1,
                matchType: 'title',
                snippet: null,
                snippetHighlights: [],
                titleHighlights: [],
                matchedRole: null,
                lastActiveAt: session.lastActiveAt,
                source: 'desktop',
                turnCount: 1,
            }],
        });
        renderOverlay('search');
        fireEvent.change(screen.getByPlaceholderText(i18n.t('app:historyOverlay.searchPlaceholder')), {
            target: { value: 'Shared menu' },
        });

        const title = await screen.findByText(session.title);
        const row = title.closest<HTMLElement>('[data-history-search-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 180, clientY: 130 });

        expectSharedSessionMenu();
    });
});
