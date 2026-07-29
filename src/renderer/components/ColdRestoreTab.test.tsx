// Behavior test for Issue #232 cold-tab restore — codex flagged "a cold
// restored tab must NOT mount TabProvider (which is what connects SSE / calls
// ensureSessionSidecar / starts recovery timers) until first activation" as the
// main regression risk. We render the real MemoizedTabContent with TabProvider
// (and the heavy page components) mocked, and assert the cold tab renders a
// placeholder while a live chat tab mounts TabProvider.
import { fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('@/pages/Chat', () => ({ default: () => <div data-testid="chat" /> }));
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

import { MemoizedTabContent } from '@/App';

function coldTab(over: Partial<Tab> = {}): Tab {
  return {
    id: 'restored-1',
    agentDir: '/ws/a',
    sessionId: '11111111-2222-3333-4444-555555555555',
    view: 'chat',
    title: 'Restored',
    restoreState: 'cold',
    sidecarConfigDisposition: 'pending',
    ...over,
  };
}

const noopProps = {
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
  onSwitchSession: vi.fn(async () => {}),
  onOpenSessionInNewTab: vi.fn(async () => {}),
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

describe('cold restored tab', () => {
  it('does NOT mount TabProvider before activation', () => {
    tabProviderSpy.mockClear();
    render(<MemoizedTabContent tab={coldTab()} isActive {...noopProps} />);
    expect(tabProviderSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tab-provider')).toBeNull();
    expect(screen.queryByTestId('chat')).toBeNull();
  });

  it('mounts TabProvider once restoreState is cleared (activated)', async () => {
    tabProviderSpy.mockClear();
    render(<MemoizedTabContent tab={coldTab({ restoreState: undefined })} isActive {...noopProps} />);
    // TabProvider (not lazy) mounts synchronously — it's the SSE/sidecar side-effect gate.
    expect(tabProviderSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tab-provider')).not.toBeNull();
    // Chat is route-split (React.lazy + Suspense, P1), so it resolves one
    // microtask after mount — await it rather than asserting synchronously.
    expect(await screen.findByTestId('chat')).not.toBeNull();
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
