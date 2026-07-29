import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { defaultWorkspacePath: null as string | null, agents: [] },
  projects: [] as Array<Record<string, unknown>>,
  taskData: {
    sessions: [] as Array<Record<string, unknown>>,
    isSessionsLoading: false,
    error: null as string | null,
    sessionTagsMap: new Map(),
    workspaceSessionStates: new Map<string, { isLoading: boolean; error: string | null }>(),
    deleteProtectedSessionIds: new Set<string>(),
    refresh: vi.fn(),
    actions: {
      deleteSession: vi.fn(async () => ({ deleted: true as const })),
      setSessionFavorite: vi.fn(async () => true),
    },
  },
  addProject: vi.fn(),
  removeProject: vi.fn(),
  patchProject: vi.fn(),
  touchProject: vi.fn(),
  refreshConfig: vi.fn(),
  configError: null as string | null,
  forcedRail: true,
  isTauri: false,
  openExternal: vi.fn(async () => undefined),
  deleteSession: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: mocks.config,
    projects: mocks.projects,
    isLoading: false,
    error: mocks.configError,
    addProject: mocks.addProject,
    removeProject: mocks.removeProject,
    patchProject: mocks.patchProject,
    touchProject: mocks.touchProject,
    refreshConfig: mocks.refreshConfig,
  }),
}));

vi.mock('@/hooks/useTaskCenterData', () => ({
  useGlobalSidebarTaskCenterData: () => mocks.taskData,
}));

vi.mock('@/hooks/taskCenterStore', () => ({ ensureWorkspaceSessions: vi.fn() }));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ openPathExternal: vi.fn() }),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => mocks.isTauri,
  pickFolderForDialog: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@/components/HistorySearchOverlayContent', () => ({
  default: ({
    initialMode,
    onClose,
    onOpenSession,
    projects,
    taskCenterData,
  }: {
    initialMode?: string;
    onClose: () => void;
    onOpenSession: (session: Record<string, unknown>, project: Record<string, unknown>) => void;
    projects: Array<Record<string, unknown>>;
    taskCenterData: { sessions: Array<Record<string, unknown>> };
  }) => (
    <div data-testid="task-center-overlay" data-initial-mode={initialMode}>
      <button type="button" onClick={onClose}>Close search test overlay</button>
      {taskCenterData.sessions[0] && projects[0] && (
        <button
          type="button"
          onClick={() => onOpenSession(taskCenterData.sessions[0], projects[0])}
        >
          Open search session test
        </button>
      )}
    </div>
  ),
}));

vi.mock('@/components/FeedbackPopover', () => ({ default: () => null }));

vi.mock('@/components/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('@/context/SessionDeletionContext', () => ({
  useSessionDeletion: () => mocks.deleteSession,
}));

import { i18n } from '@/i18n';
import type { Tab } from '@/types/tab';
import { GLOBAL_SIDEBAR_PREFERENCE_KEY } from '@/utils/globalSidebarPreference';
import GlobalSidebar, { isPointerWithinBounds } from './GlobalSidebar';

const launcherTab: Tab = {
  id: 'launcher-tab',
  agentDir: null,
  sessionId: null,
  view: 'launcher',
  title: 'Launcher',
  sidecarConfigDisposition: 'push',
};

type SidebarProps = ComponentProps<typeof GlobalSidebar>;

function sidebar(overrides: Partial<SidebarProps> = {}) {
  return (
    <GlobalSidebar
      tabs={[launcherTab]}
      activeTab={launcherTab}
      activeWorkspacePath={null}
      teamSpaceAvailable
      onNewTab={vi.fn()}
      onOpenTaskCenter={vi.fn()}
      onOpenSpace={vi.fn()}
      onOpenCapabilities={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenBugReport={vi.fn()}
      onOpenWorkspace={vi.fn(async () => true)}
      onOpenSession={vi.fn(async () => true)}
      {...overrides}
    />
  );
}

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  return render(sidebar(overrides));
}

describe('GlobalSidebar rail flyout', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.projects.length = 0;
    mocks.taskData.sessions.length = 0;
    mocks.taskData.sessionTagsMap.clear();
    mocks.taskData.workspaceSessionStates.clear();
    mocks.taskData.deleteProtectedSessionIds.clear();
    mocks.deleteSession.mockResolvedValue({ deleted: true });
    mocks.config.defaultWorkspacePath = null;
    mocks.configError = null;
    mocks.forcedRail = true;
    mocks.isTauri = false;
    mocks.touchProject.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: mocks.forcedRail,
        media: '(max-width: 1080px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens idempotently on click even after the hover delay has elapsed', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(125));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('opens the product website from the compact brand link without a row hover surface', async () => {
    mocks.forcedRail = false;
    renderSidebar();

    const brandLink = screen.getByRole('button', {
      name: String(i18n.t('app:globalSidebar.openWebsite')),
    });
    const brandRow = brandLink.closest('[data-global-sidebar-brand-row]');

    expect(brandLink).toHaveClass('cursor-pointer');
    expect(brandLink).not.toHaveClass('w-full', 'hover:bg-[var(--hover-bg)]', 'hover:bg-[var(--paper-inset)]');
    expect(brandRow).not.toHaveClass('cursor-pointer', 'hover:bg-[var(--hover-bg)]');

    fireEvent.click(brandLink);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledWith('https://myagents.io');
    });
  });

  it('opens immediately from keyboard focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.focus(trigger);

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('hands Tab focus from the rail trigger into the viewport-owned flyout', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.focus(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });

    fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(within(region).getByRole('button', {
      name: String(i18n.t('app:globalSidebar.workspaceViewOptions')),
    })).toHaveFocus();
    act(() => vi.advanceTimersByTime(220));
    expect(region).toBeInTheDocument();
  });

  it('hands Shift+Tab focus from the first flyout action back to its rail trigger', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.focus(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    fireEvent.keyDown(trigger, { key: 'Tab' });
    const firstAction = within(region).getByRole('button', {
      name: String(i18n.t('app:globalSidebar.workspaceViewOptions')),
    });

    fireEvent.keyDown(firstAction, { key: 'Tab', shiftKey: true });

    expect(trigger).toHaveFocus();
    act(() => vi.advanceTimersByTime(220));
    expect(region).toBeInTheDocument();
  });

  it('closes after a workspace navigation succeeds', async () => {
    const onOpenWorkspace = vi.fn(async () => true);
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar({ onOpenWorkspace });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) }));
    });

    await vi.waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('closes on Escape from the rail trigger and restores trigger focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape from inside the viewport-owned flyout and restores trigger focus', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    const workspaceToggle = screen.getByText('Project one')
      .closest('[data-global-sidebar-workspace-row]')!
      .querySelector('button')!;

    workspaceToggle.focus();
    fireEvent.keyDown(workspaceToggle, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes after the pointer leaves an otherwise idle flyout', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(219));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('keeps the flyout open when collapsing a workspace only changes layout beneath the pointer', () => {
    const bounds = { left: 72, right: 392, top: 48, bottom: 700 };

    expect(isPointerWithinBounds(bounds, 200, 160)).toBe(true);
    expect(isPointerWithinBounds(bounds, 420, 160)).toBe(false);
    expect(isPointerWithinBounds(bounds, bounds.right, 160)).toBe(false);
    expect(isPointerWithinBounds(bounds, 200, bounds.bottom)).toBe(false);
    expect(isPointerWithinBounds({ left: 0, right: 0, top: 0, bottom: 0 }, 0, 0)).toBe(false);

  });

  it('keeps the flyout open when collapsing a workspace removes the focused Session under a stationary pointer', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Focused session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const flyout = region.closest('[data-global-sidebar-flyout]')!;
    const session = screen.getByRole('button', { name: /Focused session/ });
    const workspaceToggle = screen.getByText('Project one').closest('[data-global-sidebar-workspace-row]')!
      .querySelector('button')!;
    const branch = screen.getByText('Focused session').closest('[data-global-sidebar-workspace-branch]')!;

    fireEvent.pointerEnter(flyout);
    session.focus();
    fireEvent.blur(session);
    fireEvent.click(workspaceToggle);

    expect(branch).toHaveAttribute('data-state', 'closed');
    expect(branch).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: /Focused session/, hidden: true })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByRole('button', { name: /Focused session/, hidden: true })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Focused session/ })).not.toBeInTheDocument();
  });

  it('uses the sidebar surface and invisible fixed-height placeholders in the rail flyout', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: true, error: null });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const flyout = region.closest('[data-global-sidebar-flyout]');
    expect(flyout).toHaveClass('bg-[var(--global-sidebar-bg)]');
    expect(flyout).toHaveClass('fixed', 'top-32', 'bottom-28');
    expect(flyout).not.toHaveClass('absolute', 'top-12', 'bottom-3');
    expect(flyout).not.toHaveClass('bg-[var(--paper-elevated)]');
    const placeholder = region.querySelector('[data-global-sidebar-session-placeholder]')!;
    expect(placeholder.children).toHaveLength(3);
    for (const row of Array.from(placeholder.children)) {
      expect(row).toHaveClass('h-9');
      expect(row).not.toHaveClass('animate-pulse', 'bg-[var(--paper-inset)]/60');
      expect(row).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('uses instant custom tooltips for workspace header and row actions', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const addButton = screen.getByRole('button', { name: String(i18n.t('launcher:addWorkspaceMenu.add')) });
    const viewOptionsButton = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.workspaceViewOptions')) });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const newChatButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) });
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });

    expect(Boolean(viewOptionsButton.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(moreButton.compareDocumentPosition(newChatButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    for (const button of [addButton, viewOptionsButton, newChatButton, moreButton]) {
      expect(button).not.toHaveAttribute('title');
      const tip = button.parentElement?.querySelector('[role="tooltip"]');
      expect(tip).toHaveClass('bg-[var(--button-dark-bg)]/90');
      expect(tip).not.toHaveClass('delay-500', 'transition-opacity');
    }
    expect(viewOptionsButton.parentElement?.querySelector('[role="tooltip"]')).toHaveTextContent('更多');
    expect(moreButton.parentElement?.querySelector('[role="tooltip"]')).toHaveTextContent('更多');
    expect(newChatButton.parentElement?.querySelector('[role="tooltip"]')).toHaveTextContent('新对话');
    expect(moreButton.parentElement?.querySelector('[role="tooltip"]')).toHaveClass('top-full');
    expect(newChatButton.parentElement?.querySelector('[role="tooltip"]')).toHaveClass('top-full');
  });

  it('opens a workspace context menu without allowing right-click text selection', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    expect(workspaceRow).toHaveClass('select-none');

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(workspaceRow, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(workspaceRow, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    const pinItem = screen.getByRole('button', { name: String(i18n.t('launcher:workspaceCard.pin')) });
    const menu = pinItem.closest<HTMLElement>('.global-sidebar-nested-layer')!;
    expect(within(menu).getAllByRole('button').map((item) => item.textContent)).toEqual([
      String(i18n.t('launcher:workspaceCard.agentSettings')),
      String(i18n.t('launcher:workspaceCard.openFolder')),
      String(i18n.t('launcher:workspaceCard.pin')),
      String(i18n.t('launcher:workspaceCard.archive')),
      String(i18n.t('launcher:workspaceCard.remove')),
    ]);
  });

  it('opens a Session context menu without allowing right-click text selection', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Selectable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const sessionRow = screen.getByText('Selectable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    expect(sessionRow).toHaveClass('select-none');

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(sessionRow, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(sessionRow, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.copySessionId')) })).toBeInTheDocument();
  });

  it('routes sidebar Session deletion through the App-owned lifecycle capability', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'deletable-session',
      agentDir: '/work/project-one',
      title: 'Deletable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Deletable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(row).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.delete')) }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });

    expect(mocks.deleteSession).toHaveBeenCalledWith('deletable-session');
    expect(mocks.toast.success).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.deleted')));
  });

  it('lets the Rust authority decide protected sidebar deletion and explains its refusal', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'protected-session',
      agentDir: '/work/project-one',
      title: 'Protected session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    mocks.taskData.deleteProtectedSessionIds.add('protected-session');
    mocks.deleteSession.mockResolvedValue({ deleted: false, reason: 'in-use' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Protected session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(row).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    const deleteButton = screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.delete')) });
    expect(deleteButton).not.toBeDisabled();
    fireEvent.click(deleteButton);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });

    expect(mocks.deleteSession).toHaveBeenCalledWith('protected-session');
    expect(mocks.toast.warning).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.deleteBlockedByOwner')));
  });

  it('copies the Session ID from the first row of the history menu', async () => {
    const sessionId = '642ea003-5219-4af7-a812-a9812d6e79de';
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: sessionId,
      agentDir: '/work/project-one',
      title: 'Copyable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const sessionRow = screen.getByText('Copyable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(sessionRow).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    const copyButton = screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.copySessionId')) });
    const menu = copyButton.closest<HTMLElement>('.global-sidebar-nested-layer')!;
    expect(within(menu).getAllByRole('button')[0]).toBe(copyButton);

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${sessionId}`);
    expect(mocks.toast.success).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.copySessionIdSuccess')));
  });

  it('reserves tooltips for non-workspace rail actions', () => {
    renderSidebar();

    expect(screen.queryByRole('tooltip', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    const taskTip = screen.getByRole('tooltip', { name: '任务' });
    expect(taskTip).toHaveClass('left-full', 'bg-[var(--button-dark-bg)]/90');
    expect(taskTip).not.toHaveClass('delay-500', 'transition-opacity');

    fireEvent.click(screen.getByRole('button', { name: '小助理' }));
    expect(screen.queryByRole('tooltip', { name: '小助理' })).not.toBeInTheDocument();
  });

  it('keeps the workspace surface open when Session navigation is rejected', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'rejected-session',
      agentDir: '/work/project-one',
      title: 'Rejected session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const onOpenSession = vi.fn(async () => false);
    renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Rejected session/ }));
    });

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('keeps the workspace surface open when Session navigation throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'failed-session',
      agentDir: '/work/project-one',
      title: 'Failed session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const onOpenSession = vi.fn(async () => {
      throw new Error('navigation failed');
    });
    renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Failed session/ }));
    });

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(
      '[GlobalSidebar] Failed to open Session:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('closes the workspace surface when the authoritative active Tab changes', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    const view = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    const activeSessionTab: Tab = {
      id: 'active-session-tab',
      agentDir: '/work/project-one',
      sessionId: 'active-session',
      view: 'chat',
      title: 'Active Session',
      sidecarConfigDisposition: 'adopt',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, activeSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
    }));

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('does not let an old Session completion close a newly reopened flyout', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'slow-session',
      agentDir: '/work/project-one',
      title: 'Slow session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    let resolveOpen!: (opened: boolean) => void;
    const onOpenSession = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    const view = renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.click(screen.getByRole('button', { name: /Slow session/ }));

    const activeSessionTab: Tab = {
      id: 'slow-session-tab',
      agentDir: '/work/project-one',
      sessionId: 'slow-session',
      view: 'chat',
      title: 'Slow session',
      sidecarConfigDisposition: 'pending',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, activeSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
      onOpenSession,
    }));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('does not let an old workspace completion close a newly reopened flyout', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    let resolveOpen!: (opened: boolean) => void;
    const onOpenWorkspace = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    const view = renderSidebar({ onOpenWorkspace });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) }));

    const pendingWorkspaceTab: Tab = {
      id: 'pending-workspace-tab',
      agentDir: '/work/project-one',
      sessionId: null,
      view: 'chat',
      title: 'Project one',
      sidecarConfigDisposition: 'pending',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, pendingWorkspaceTab],
      activeTab: pendingWorkspaceTab,
      activeWorkspacePath: '/work/project-one',
      onOpenWorkspace,
    }));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('keeps one fixed toggle across manual rail/expanded and leaves forced rail branded but stable', () => {
    mocks.forcedRail = false;
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const first = renderSidebar();
    const navigation = screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) });
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'rail');
    expect(navigation).not.toHaveAttribute('data-global-sidebar-motion');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'true');
    expect(navigation).toHaveClass('[--global-sidebar-surface:var(--global-sidebar-bg)]');
    expect(navigation).not.toHaveClass('bg-[var(--global-sidebar-bg)]');
    expect(navigation).not.toHaveClass('bg-[var(--paper)]', 'bg-[var(--paper-elevated)]', 'border-r');
    expect(navigation).not.toHaveClass('border-[var(--line)]');
    const brandIcon = navigation.querySelector('[data-global-sidebar-brand-icon]');
    const brandLink = navigation.querySelector('[data-global-sidebar-brand-link]');
    const brandName = navigation.querySelector('[data-global-sidebar-brand-name]');
    const brandRow = navigation.querySelector('[data-global-sidebar-brand-row]');
    const primaryNav = navigation.querySelector('[data-global-sidebar-primary-nav]');
    const workspaceRail = navigation.querySelector('[data-global-sidebar-workspace-rail]');
    const footerActions = navigation.querySelector('[data-global-sidebar-footer-actions]');
    expect(brandIcon).not.toBeNull();
    expect(brandLink).toHaveClass('w-10', 'overflow-hidden');
    expect(brandName).toHaveAttribute('aria-hidden', 'true');
    expect(brandRow).toHaveClass('global-sidebar-brand-row');
    expect(primaryNav).toHaveClass('global-sidebar-rail-stack');
    expect(primaryNav).not.toHaveClass('items-center', 'px-2', 'border-t', 'space-y-1');
    expect(workspaceRail).toHaveClass('global-sidebar-rail-stack');
    expect(workspaceRail).not.toHaveClass('items-center', 'px-2', 'border-t', 'border-[var(--line-subtle)]');
    expect(footerActions).toHaveClass('global-sidebar-rail-stack');
    expect(footerActions).not.toHaveClass('items-center', 'px-2', 'space-y-1', 'border-t', 'border-[var(--line-subtle)]');
    const expand = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) });
    expect(expand).toHaveAttribute('data-global-sidebar-toggle');
    expect(expand).not.toHaveAttribute('title');
    const toggleSlot = expand.closest('.absolute');
    expect(toggleSlot).toHaveClass('left-[var(--global-sidebar-toggle-left)]');
    expect(expand.querySelector('[data-global-sidebar-toggle-icon]')).toHaveClass('lucide-panel-left');
    expect(screen.getByRole('tooltip', { name: String(i18n.t('app:globalSidebar.expand')) }))
      .toHaveClass('bg-[var(--button-dark-bg)]/90');
    fireEvent.click(expand);
    const collapse = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.collapse')) });
    expect(collapse).toBe(expand);
    expect(collapse.closest('.absolute')).toBe(toggleSlot);
    expect(collapse.querySelector('[data-global-sidebar-toggle-icon]')).toHaveClass('lucide-panel-left');
    expect(screen.getByRole('tooltip', { name: String(i18n.t('app:globalSidebar.collapse')) }))
      .not.toHaveClass('delay-500', 'transition-opacity');
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'expanded');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'expand');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'false');
    expect(navigation.querySelector('[data-global-sidebar-brand-icon]')).toBe(brandIcon);
    expect(navigation.querySelector('[data-global-sidebar-brand-link]')).toBe(brandLink);
    expect(brandLink).not.toHaveClass('w-10', 'overflow-hidden');
    expect(navigation.querySelector('[data-global-sidebar-brand-row]')).toBe(brandRow);
    expect(navigation.querySelector('[data-global-sidebar-primary-nav]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(navigation.querySelector('[data-global-sidebar-workspace-rail]')).not.toBeInTheDocument();
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).not.toHaveClass('border-t', 'border-[var(--line-subtle)]');
    expect(navigation.querySelector('[data-global-sidebar-footer-actions]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(brandName).toBe(screen.getByText('MyAgents'));
    expect(brandName).toHaveClass('theme-product-wordmark', 'text-sm', 'font-medium');
    expect(brandName).not.toHaveClass('font-semibold', 'tracking-wide', 'theme-launcher-hero-title');
    expect(brandName).toHaveAttribute('aria-hidden', 'false');

    fireEvent.click(collapse);
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'rail');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'collapse');
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]'))
      .toHaveAttribute('aria-hidden', 'true');
    expect(navigation.querySelector('[data-global-sidebar-workspace-rail]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) }));
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'expanded');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'expand');
    act(() => { vi.advanceTimersByTime(200); });
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.collapse')) }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).not.toBeInTheDocument();
    first.unmount();

    mocks.forcedRail = true;
    renderSidebar();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) })).not.toBeInTheDocument();
    const websiteButton = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.openWebsite')) });
    expect(websiteButton.querySelector('[data-global-sidebar-brand-icon]')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) }))
      .toHaveAttribute('data-global-sidebar-toggle-visible', 'false');
  });

  it('uses compact navigation and workspace rows with state-driven workspace weight', () => {
    mocks.forcedRail = false;
    mocks.projects.push(
      { id: 'project-1', name: 'Project one', path: '/work/project-one' },
      { id: 'project-2', name: 'Project two', path: '/work/project-two' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'expanded',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar({ activeWorkspacePath: '/work/project-one' });

    for (const label of [
      i18n.t('app:globalSidebar.newChat'),
      i18n.t('app:globalSidebar.tasks'),
      i18n.t('app:globalSidebar.team'),
      i18n.t('app:globalSidebar.capabilities'),
      i18n.t('app:globalSidebar.helper'),
      i18n.t('app:globalSidebar.settings'),
    ]) {
      const action = screen.getByRole('button', { name: String(label) });
      expect(action).toHaveClass('h-9');
      expect(action).not.toHaveClass('h-10');
    }

    const activeRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const inactiveRow = screen.getByText('Project two').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const activeTitle = activeRow.querySelector('[data-global-sidebar-workspace-title]');
    const inactiveTitle = inactiveRow.querySelector('[data-global-sidebar-workspace-title]');
    expect(activeRow).toHaveClass('h-9');
    expect(inactiveRow).toHaveClass('h-9');
    expect(activeTitle).toHaveClass('font-medium');
    expect(inactiveTitle).toHaveClass('font-normal');
    expect(inactiveTitle?.className).toContain('group-hover/workspace:font-medium');
    expect(inactiveTitle?.className).toContain('group-focus-within/workspace:font-medium');

    fireEvent.click(within(inactiveRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) }));
    expect(inactiveTitle).toHaveClass('font-medium');
    expect(inactiveTitle).not.toHaveClass('font-normal');
  });

  it('animates workspace branches in the expanded sidebar and cancels a pending collapse when reopened', () => {
    mocks.forcedRail = false;
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Animated session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'expanded',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();

    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const workspaceToggle = within(workspaceRow).getAllByRole('button')[0];
    const branch = workspaceRow.nextElementSibling as HTMLElement;
    const workspaceChevron = workspaceToggle.querySelector('svg');
    expect(branch).toHaveAttribute('data-global-sidebar-workspace-branch');
    expect(branch).toHaveAttribute('data-state', 'closed');
    expect(workspaceToggle).toHaveClass('gap-1', 'pl-1', 'pr-2', 'text-sm');
    expect(workspaceChevron).toHaveClass('h-3.5', 'w-3.5');
    expect(workspaceRow.querySelector('[data-global-sidebar-workspace-title]')).toHaveClass('ml-1');
    expect(screen.queryByText('Animated session')).not.toBeInTheDocument();

    fireEvent.click(workspaceToggle);
    act(() => vi.advanceTimersByTime(16));
    expect(branch).toHaveAttribute('data-state', 'open');
    expect(branch).toHaveClass('grid-rows-[1fr]', 'duration-200', 'motion-reduce:transition-none');
    expect(branch.querySelector('.ml-2\\.5')).toHaveClass('pl-1');
    expect(screen.getByText('Animated session')).toHaveClass('text-sm');

    fireEvent.click(workspaceToggle);
    expect(branch).toHaveAttribute('data-state', 'closed');
    expect(screen.getByText('Animated session')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(workspaceToggle);
    act(() => vi.advanceTimersByTime(200));

    expect(branch).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Animated session')).toBeInTheDocument();
  });

  it('opens the global search overlay directly in search mode', async () => {
    mocks.isTauri = true;
    const { container } = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
    const coldPanel = document.querySelector('[data-history-search-overlay-panel]');
    expect(coldPanel).toBeInTheDocument();

    const backdrop = coldPanel?.parentElement ?? null;
    expect(container).not.toContainElement(backdrop);
    expect(backdrop?.parentElement).toBe(document.body);

    await act(async () => {
      await vi.dynamicImportSettled();
    });

    const overlay = screen.getByTestId('task-center-overlay');
    expect(overlay).toHaveAttribute('data-initial-mode', 'search');
    expect(document.querySelector('[data-history-search-overlay-panel]')).toBe(coldPanel);
  });

  it('hides the Team Space navigation entry when the feature is unavailable', () => {
    const onOpenSpace = vi.fn();
    renderSidebar({ teamSpaceAvailable: false, onOpenSpace });

    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.team')) }))
      .not.toBeInTheDocument();
    expect(onOpenSpace).not.toHaveBeenCalled();
  });

  it('does not let an old Session completion close a newly reopened search overlay', async () => {
    mocks.isTauri = true;
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'slow-search-session',
      agentDir: '/work/project-one',
      title: 'Slow search session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    let resolveOpen!: (opened: boolean) => void;
    const onOpenSession = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    renderSidebar({ onOpenSession });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
      await vi.dynamicImportSettled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open search session test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close search test overlay' }));
    expect(screen.queryByTestId('task-center-overlay')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
      await vi.dynamicImportSettled();
    });
    expect(screen.getByTestId('task-center-overlay')).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByTestId('task-center-overlay')).toBeInTheDocument();
  });

  it('keeps archived workspaces reachable when there are no active workspaces', () => {
    mocks.projects.push({
      id: 'archived-1',
      name: 'Archived project',
      path: '/work/archived',
      archivedAt: '2026-07-20T00:00:00.000Z',
    });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const archived = screen.getByRole('button', { name: /已归档/ });
    expect(archived).toBeInTheDocument();
    fireEvent.click(archived);
    expect(screen.getByText('Archived project')).toBeInTheDocument();
  });

  it('keeps the flyout alive while a menu-launched confirmation owns focus', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByText(String(i18n.t('launcher:workspaceCard.remove'))));

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(moreButton).toHaveFocus();
  });

  it('returns focus to a nested menu anchor when Escape dismisses the portal', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });
    fireEvent.click(moreButton);
    const pinItem = screen.getByText(String(i18n.t('launcher:workspaceCard.pin')));
    pinItem.focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(moreButton).toHaveFocus();
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('pages 11 sessions as 5 → 10 → 11, exposes every tag, and leaves no icon spacer for a closed session', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    for (let index = 1; index <= 11; index += 1) {
      mocks.taskData.sessions.push({
        id: `session-${index}`,
        agentDir: '/work/project-one',
        title: `Session ${index}`,
        createdAt: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
        lastActiveAt: `2026-07-${String(12 - index).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: false, error: null });
    mocks.taskData.sessionTagsMap.set('session-1', [
      { type: 'im', platform: 'Telegram' },
      { type: 'cron' },
    ]);

    renderSidebar({ activeWorkspacePath: '/work/project-one' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(document.querySelector('[data-global-sidebar-workspace-list]')).not.toHaveClass('space-y-1');
    const workspaceRow = screen.getByText('Project one').closest('[data-global-sidebar-workspace-row]');
    expect(workspaceRow).toHaveClass('bg-[var(--hover-bg)]');
    expect(workspaceRow).not.toHaveClass('bg-[var(--paper-elevated)]', 'shadow-sm');
    const firstSession = screen.getByRole('button', { name: /Session 1/ });
    expect(firstSession.className).toContain('focus-visible:ring-2');
    expect(firstSession.firstElementChild?.textContent).toBe('Session 1');
    expect(firstSession).toHaveTextContent('Telegram');
    expect(firstSession).toHaveTextContent(String(i18n.t('app:sessionTags.cron')));
    const firstSessionRow = firstSession.closest('[data-global-sidebar-session-row]');
    expect(firstSessionRow).toHaveClass('h-9');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-title]')).toHaveClass('text-sm');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-title]')).not.toHaveClass('text-xs');
    expect(screen.getByText('Telegram')).toHaveClass('text-xs', 'font-medium');
    expect(firstSession).toHaveClass('w-full');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-date]')).toHaveClass('ml-auto');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('absolute');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('pointer-events-none');
    const sessionDate = firstSessionRow?.querySelector('[data-global-sidebar-session-date]');
    expect(sessionDate).toHaveClass('text-xs');
    const sessionMore = firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay] button');
    expect(sessionDate).not.toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(sessionDate).toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(screen.queryByText('Session 6')).not.toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 10')).toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 11')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) })).not.toBeInTheDocument();
  });

  it('projects only the shared generating and unread Tab signals into Session rows', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const sessionSpecs = [
      { id: 'active-session', title: 'Active session' },
      { id: 'open-session', title: 'Open session' },
      { id: 'unread-session', title: 'Unread session' },
      { id: 'generating-session', title: 'Generating session' },
    ];
    sessionSpecs.forEach((session, index) => {
      mocks.taskData.sessions.push({
        ...session,
        agentDir: '/work/project-one',
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
        lastActiveAt: `2026-07-2${index}T00:00:00.000Z`,
      });
    });
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: false, error: null });

    const activeSessionTab: Tab = {
      id: 'active-tab',
      agentDir: '/work/project-one',
      sessionId: 'active-session',
      view: 'chat',
      title: 'Active session',
      sidecarConfigDisposition: 'adopt',
    };
    const openSessionTab: Tab = {
      ...activeSessionTab,
      id: 'open-tab',
      sessionId: 'open-session',
      title: 'Open session',
    };
    const unreadSessionTab: Tab = {
      ...activeSessionTab,
      id: 'unread-tab',
      sessionId: 'unread-session',
      title: 'Unread session',
      hasUnread: true,
    };
    const generatingSessionTab: Tab = {
      ...activeSessionTab,
      id: 'generating-tab',
      sessionId: 'generating-session',
      title: 'Generating session',
      isGenerating: true,
      hasUnread: true,
    };

    renderSidebar({
      tabs: [launcherTab, activeSessionTab, openSessionTab, unreadSessionTab, generatingSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const rowFor = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    const activeRow = rowFor('Active session');
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    expect(workspaceRow).not.toHaveAttribute('aria-current');
    expect(workspaceRow).not.toHaveClass('bg-[var(--hover-bg)]');
    expect(workspaceRow.querySelector('[data-global-sidebar-workspace-title]')).toHaveClass('font-medium');
    expect(activeRow).toHaveClass('bg-[var(--hover-bg)]');
    expect(activeRow).toHaveAttribute('aria-current', 'page');
    expect(activeRow.querySelector('[data-tab-activity-indicator]')).toBeNull();
    expect(rowFor('Open session').querySelector('[data-tab-activity-indicator]')).toBeNull();

    const unreadIndicator = rowFor('Unread session').querySelector('[data-tab-activity-indicator]');
    expect(unreadIndicator).toHaveAttribute('data-tab-activity-indicator', 'unread');
    expect(unreadIndicator).toHaveClass('bg-[var(--accent-warm)]');

    const generatingIndicator = rowFor('Generating session').querySelector('[data-tab-activity-indicator]');
    expect(generatingIndicator).toHaveAttribute('data-tab-activity-indicator', 'generating');
    expect(generatingIndicator?.children).toHaveLength(2);
    Array.from(generatingIndicator?.children ?? []).forEach((dot) => {
      expect(dot).toHaveClass('bg-[var(--success)]');
    });
  });

  it('keeps one workspace failure local while another workspace remains usable', () => {
    mocks.projects.push(
      { id: 'project-a', name: 'Project A', path: '/work/a' },
      { id: 'project-b', name: 'Project B', path: '/work/b' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/a', '/work/b'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    mocks.taskData.sessions.push({
      id: 'session-b',
      agentDir: '/work/b',
      title: 'Healthy session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    mocks.taskData.workspaceSessionStates.set('/work/a', { isLoading: false, error: 'A failed' });
    mocks.taskData.workspaceSessionStates.set('/work/b', { isLoading: false, error: null });

    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('A failed')).toBeInTheDocument();
    expect(screen.getByText('Healthy session')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) })).toHaveLength(1);
  });

  it('shows config loading failures with an explicit retry action', () => {
    mocks.configError = 'config unavailable';
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('config unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) }));
    expect(mocks.refreshConfig).toHaveBeenCalled();
  });
});
