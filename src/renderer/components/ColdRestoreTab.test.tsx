// Behavior test for Issue #232 cold-tab restore — codex flagged "a cold
// restored tab must NOT mount TabProvider (which is what connects SSE / calls
// ensureSessionSidecar / starts recovery timers) until first activation" as the
// main regression risk. We render the real MemoizedTabContent with TabProvider
// (and the heavy page components) mocked, and assert the cold tab renders a
// placeholder while a live chat tab mounts TabProvider.
import { render, screen } from '@testing-library/react';
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
vi.mock('@/pages/Settings', () => ({ default: () => <div data-testid="settings" /> }));
vi.mock('@/pages/TaskCenter', () => ({ default: () => <div data-testid="taskcenter" /> }));
vi.mock('@/workbench-sdk/WorkbenchShell', () => ({ default: () => <div data-testid="workbench" /> }));

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
  settingsInitialMcpId: undefined,
  settingsInitialSelect: undefined,
  onLaunchProject: vi.fn(),
  onBack: vi.fn(async () => {}),
  onSwitchSession: vi.fn(async () => {}),
  onOpenSessionInNewTab: vi.fn(async () => {}),
  onNewSession: vi.fn(async () => true),
  onUpdateGenerating: vi.fn(),
  onUpdateTitle: vi.fn(),
  onUpdateUnread: vi.fn(),
  onRenameSession: vi.fn(),
  onForkSession: vi.fn(),
  onUpdateSessionId: vi.fn(async () => true),
  onClearInitialMessage: vi.fn(),
  onSidecarConfigAdopted: vi.fn(),
  onUpdateWorkbenchRoute: vi.fn(),
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

  it('renders a workbench without mounting TabProvider', async () => {
    tabProviderSpy.mockClear();
    render(
      <MemoizedTabContent
        tab={coldTab({
          view: 'workbench',
          sessionId: null,
          restoreState: undefined,
          workbench: { workbenchId: 'io.myagents.testbench', route: 'home' },
        })}
        isActive
        {...noopProps}
      />,
    );
    expect(await screen.findByTestId('workbench')).not.toBeNull();
    expect(tabProviderSpy).not.toHaveBeenCalled();
  });
});
