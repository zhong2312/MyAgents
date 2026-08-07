// Focused behavior tests for App's content slots. Restored persisted Sessions
// are normal live Chat Tabs: active and inactive slots both mount TabProvider,
// while only visibility/focus projection changes when the user switches tabs.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Tab } from '@/types/tab';

// TabProvider is the ONLY branch that triggers sidecar/SSE side effects — a
// spy marker lets us assert whether it was mounted.
const tabProviderSpy = vi.fn();
vi.mock('@/context/TabProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => {
    tabProviderSpy();
    return <div data-testid="tab-provider">{children}</div>;
  },
}));

// Stub the heavy page subtrees so importing App stays cheap and side-effect free.
const chatRenderSpy = vi.hoisted(() => vi.fn());
vi.mock('@/pages/Chat', () => ({
  default: ({ isWindowFocused }: { isWindowFocused: boolean }) => {
    chatRenderSpy(isWindowFocused);
    return <div data-testid="chat" />;
  },
}));
vi.mock('@/pages/Launcher', () => ({ default: () => <div data-testid="launcher" /> }));
vi.mock('@/pages/Settings', () => ({
  default: function MockSettings({ mode = 'settings' }: { mode?: 'settings' | 'capabilities' }) {
    const [draft, setDraft] = useState('');
    return (
      <input
        data-testid={`${mode}-draft`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  },
}));
vi.mock('@/pages/TaskCenter', () => ({ default: () => <div data-testid="taskcenter" /> }));
vi.mock('@/components/ChatBootOverlay', () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

import { MemoizedTabContent } from '@/App';

function restoredTab(over: Partial<Tab> = {}): Tab {
  return {
    id: 'restored-1',
    agentDir: '/ws/a',
    sessionId: '11111111-2222-3333-4444-555555555555',
    view: 'chat',
    title: 'Restored',
    sidecarConfigDisposition: 'pending',
    ...over,
  };
}

const noopProps = {
  isWindowFocused: true,
  isLoading: false,
  error: null,
  isDeferredMount: false,
  settingsInitialSection: undefined,
  capabilityInitialSection: 'skills' as const,
  capabilityNavigationNonce: 0,
  capabilityInitialMcpId: undefined,
  capabilityInitialOfficialToolId: undefined,
  capabilityInitialSelect: undefined,
  onLauncherWorkspaceSelectionChange: vi.fn(),
  onLaunchProject: vi.fn(),
  onOpenTargetSession: vi.fn(async () => true),
  onOpenHistorySession: vi.fn(async () => {}),
  onNewSession: vi.fn(async () => true),
  onUpdateGenerating: vi.fn(),
  onUpdateTitle: vi.fn(),
  onUpdateUnread: vi.fn(),
  onRenameSession: vi.fn(),
  onForkSession: vi.fn(),
  onUpdateSessionId: vi.fn(async () => true),
  claimSessionOpeningTransition: vi.fn(() => () => undefined),
  onClearInitialMessage: vi.fn(),
  onSidecarConfigAdopted: vi.fn(),
  onSettingsSectionChange: vi.fn(),
  updateReady: false,
  updateVersion: null,
  updateChecking: false,
  updateDownloading: false,
  updateInstalling: false,
  updatePreparing: false,
  onCheckForUpdate: vi.fn(async () => 'up-to-date' as const),
  onRestartAndUpdate: vi.fn(),
  taskCenterPendingIntent: null,
};

describe('restored live chat tab', () => {
  it('mounts TabProvider immediately for the active restored tab', async () => {
    tabProviderSpy.mockClear();
    render(<MemoizedTabContent tab={restoredTab()} isActive {...noopProps} />);
    expect(tabProviderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
  });

  it('mounts TabProvider immediately for an inactive restored tab too', async () => {
    tabProviderSpy.mockClear();
    render(<MemoizedTabContent tab={restoredTab()} isActive={false} {...noopProps} />);
    expect(tabProviderSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('chat')).toBeInTheDocument();
    expect(screen.getByTestId('tab-provider').parentElement).toHaveClass('invisible');
  });

  it('projects desktop focus only through the active Chat slot', async () => {
    chatRenderSpy.mockClear();
    const liveTab = restoredTab();
    const view = render(
      <MemoizedTabContent tab={liveTab} isActive={false} {...noopProps} />,
    );
    await screen.findByTestId('chat');
    const inactiveRenderCount = chatRenderSpy.mock.calls.length;

    view.rerender(
      <MemoizedTabContent
        tab={liveTab}
        isActive={false}
        {...noopProps}
        isWindowFocused={false}
      />,
    );
    expect(chatRenderSpy).toHaveBeenCalledTimes(inactiveRenderCount);

    view.rerender(
      <MemoizedTabContent
        tab={liveTab}
        isActive
        {...noopProps}
        isWindowFocused={false}
      />,
    );
    await waitFor(() => expect(chatRenderSpy).toHaveBeenLastCalledWith(false));
  });

  it('keeps Settings and Capabilities UI state in their own mounted Tab slots', async () => {
    const settingsTab: Tab = {
      id: 'settings-tab', agentDir: null, sessionId: null, view: 'settings', title: 'Settings', sidecarConfigDisposition: 'push',
    };
    const capabilitiesTab: Tab = {
      id: 'capabilities-tab', agentDir: null, sessionId: null, view: 'capabilities', title: 'Capabilities', sidecarConfigDisposition: 'push',
    };
    const contents = (active: 'settings' | 'capabilities') => (
      <>
        <MemoizedTabContent tab={settingsTab} isActive={active === 'settings'} {...noopProps} />
        <MemoizedTabContent tab={capabilitiesTab} isActive={active === 'capabilities'} {...noopProps} />
      </>
    );
    const view = render(contents('settings'));
    const settingsDraft = await screen.findByTestId('settings-draft');
    fireEvent.change(settingsDraft, { target: { value: 'provider draft' } });

    view.rerender(contents('capabilities'));
    const capabilitiesDraft = await screen.findByTestId('capabilities-draft');
    fireEvent.change(capabilitiesDraft, { target: { value: 'mcp draft' } });

    view.rerender(contents('settings'));
    expect(screen.getByTestId('settings-draft')).toHaveValue('provider draft');
    expect(screen.getByTestId('capabilities-draft')).toHaveValue('mcp draft');
  });
});
