import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEventMetadata } from '@/api/SseConnection';
import { useTabState } from './TabContext';
import TabProvider from './TabProvider';

type EventHandler = (
  eventName: string,
  data: unknown,
  metadata: SseEventMetadata,
) => void;
type StatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void;

const sseHarness = vi.hoisted(() => {
  const state = {
    connected: false,
    eventHandler: null as EventHandler | null,
    statusHandler: null as StatusHandler | null,
  };
  const connection = {
    setEventHandler: vi.fn((handler: EventHandler) => {
      state.eventHandler = handler;
    }),
    setStatusHandler: vi.fn((handler: StatusHandler) => {
      state.statusHandler = handler;
    }),
    connect: vi.fn(async () => {
      state.connected = true;
      state.statusHandler?.('connected');
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    isActive: vi.fn(() => state.connected),
    getConnectionGeneration: vi.fn(() => 1),
  };
  return { state, connection };
});

const tauriHarness = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => sseHarness.connection,
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { multiAgentRuntime: false }, projects: [] }),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getAgentByWorkspacePath: () => undefined,
  getProjectAgent: () => undefined,
}));

vi.mock('@/config/services/appConfigService', () => ({
  notifyConfigChanged: vi.fn(),
}));

vi.mock('@/analytics', () => ({
  track: vi.fn(),
  consumePendingSessionBirth: vi.fn(),
  peekPendingSessionBirth: vi.fn(() => ({ surface: 'launcher_input' })),
  setPendingSessionBirth: vi.fn(),
  hashAgentNameSync: () => null,
  birthContextForSurface: vi.fn(() => ({ surface: 'launcher_input' })),
}));

vi.mock('@/utils/frontendLogger', () => ({
  subscribeFrontendLogs: () => () => undefined,
  setCurrentTabId: vi.fn(),
  setFocusedTabId: vi.fn(),
}));

vi.mock('@/api/tauriClient', () => ({
  getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:1234'),
  sessionSidecarFetch: vi.fn(async (
    _sessionId: string,
    _owner: { type: 'tab'; id: string },
    path: string,
    init?: RequestInit,
  ) => tauriHarness.proxyFetch(path, init)),
  isTauri: () => false,
  getSessionActivation: vi.fn(async () => null),
  getSessionPort: vi.fn(async () => null),
  ensureSessionSidecar: vi.fn(async () => undefined),
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));

function ResetControl() {
  const { resetSession } = useTabState();
  return <button type="button" onClick={() => void resetSession()}>reset</button>;
}

function TitleHarness({ initialTitle = 'New Chat' }: { initialTitle?: string }) {
  const [title, setTitle] = useState(initialTitle);
  return (
    <>
      <output data-testid="session-title">{title}</output>
      <button type="button" onClick={() => setTitle('人工命名')}>manual rename</button>
      <TabProvider
        tabId="tab-title"
        agentDir="/tmp/mino"
        sessionId="pending-title"
        sessionTitle={title}
        onTitleChange={setTitle}
        claimSessionOpeningTransition={() => () => undefined}
      >
        <ResetControl />
      </TabProvider>
    </>
  );
}

function emit(eventName: string, data: unknown): void {
  const handler = sseHarness.state.eventHandler;
  if (!handler) throw new Error('SSE event handler is not installed');
  act(() => {
    handler(eventName, data, { connectionGeneration: 1 });
  });
}

describe('TabProvider session title projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('Unexpected proxyFetch call'));
  });

  it('shows the first accepted query before optional AI titling and still accepts the later AI title', async () => {
    const onTitleChange = vi.fn();
    render(
      <TabProvider
        tabId="tab-title"
        agentDir="/tmp/mino"
        sessionId="pending-title"
        sessionTitle="New Chat"
        onTitleChange={onTitleChange}
        claimSessionOpeningTransition={() => () => undefined}
      >
        <div />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'first-user-message',
        role: 'user',
        content: '你还记得我之前跟你一起做过一个知乎 tech club 的分享么？',
        timestamp: '2026-08-02T12:44:19.000Z',
      },
    });

    expect(onTitleChange).toHaveBeenCalledWith(
      '你还记得我之前跟你一起做过一个知乎 tech club 的分享么？',
    );

    emit('chat:session-title-changed', {
      sessionId: 'pending-title',
      title: '知乎 Tech Club 分享复盘',
      titleSource: 'auto',
    });

    expect(onTitleChange).toHaveBeenLastCalledWith('知乎 Tech Club 分享复盘');
  });

  it('rolls back a retracted provisional title but preserves a newer manual title', async () => {
    render(<TitleHarness />);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'retracted-first-query',
        role: 'user',
        content: '这条消息会被运行时拒绝',
        timestamp: '2026-08-02T12:44:19.000Z',
      },
    });
    expect(screen.getByTestId('session-title').textContent).toBe('这条消息会被运行时拒绝');

    emit('chat:messages-retracted', {
      messageIds: ['retracted-first-query'],
      retractedStreamingTail: false,
    });
    expect(screen.getByTestId('session-title').textContent).toBe('New Chat');

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'retracted-after-rename',
        role: 'user',
        content: '第二条也会被拒绝',
        timestamp: '2026-08-02T12:45:19.000Z',
      },
    });
    expect(screen.getByTestId('session-title').textContent).toBe('第二条也会被拒绝');
    fireEvent.click(screen.getByRole('button', { name: 'manual rename' }));
    expect(screen.getByTestId('session-title').textContent).toBe('人工命名');

    emit('chat:messages-retracted', {
      messageIds: ['retracted-after-rename'],
      retractedStreamingTail: false,
    });
    expect(screen.getByTestId('session-title').textContent).toBe('人工命名');
  });

  it('lets wrapper-only user events yield title eligibility to the first real query', async () => {
    const onTitleChange = vi.fn();
    render(
      <TabProvider
        tabId="tab-title"
        agentDir="/tmp/mino"
        sessionId="pending-title"
        sessionTitle="New Chat"
        onTitleChange={onTitleChange}
        claimSessionOpeningTransition={() => () => undefined}
      >
        <div />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'wrapper-only',
        role: 'user',
        content: '<system-reminder>\n<CRON_TASK>\n</CRON_TASK>\n</system-reminder>',
        timestamp: '2026-08-02T12:44:19.000Z',
      },
    });
    expect(onTitleChange).not.toHaveBeenCalled();

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'first-real-query',
        role: 'user',
        content: '真正的首条问题',
        timestamp: '2026-08-02T12:45:19.000Z',
      },
    });
    expect(onTitleChange).toHaveBeenCalledOnce();
    expect(onTitleChange).toHaveBeenCalledWith('真正的首条问题');
  });

  it('projects queue admission but rejects a different-session event', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/sessions/session-title?')) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-title',
            agentDir: '/tmp/mino',
            title: 'New Chat',
            createdAt: '2026-08-02T12:44:00.000Z',
            lastActiveAt: '2026-08-02T12:44:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected proxyFetch call: ${path}`);
    });
    const onTitleChange = vi.fn();
    render(
      <TabProvider
        tabId="tab-title"
        agentDir="/tmp/mino"
        sessionId="session-title"
        sessionTitle="New Chat"
        onTitleChange={onTitleChange}
        claimSessionOpeningTransition={() => () => undefined}
      >
        <div />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('New Chat'));
    onTitleChange.mockClear();

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'different-session',
      message: {
        id: 'stale-query',
        role: 'user',
        content: '不应显示',
        timestamp: '2026-08-02T12:44:19.000Z',
      },
    });
    expect(onTitleChange).not.toHaveBeenCalled();

    emit('queue:started', {
      queueId: 'queue-title',
      sessionId: 'session-title',
      userMessage: {
        id: 'queued-query',
        role: 'user',
        content: '队列里的首条问题',
        timestamp: '2026-08-02T12:45:19.000Z',
      },
    });
    expect(onTitleChange).toHaveBeenCalledWith('队列里的首条问题');
  });

  it('restores the established title marker when reset is rejected', async () => {
    tauriHarness.proxyFetch.mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: 'reset rejected',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<TitleHarness initialTitle="已有标题" />);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());

    emit('chat:session-title-changed', {
      sessionId: 'pending-title',
      title: '已有标题',
      titleSource: 'auto',
    });
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));

    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalledWith(
      '/chat/reset',
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(screen.getByTestId('session-title').textContent).toBe('已有标题'));

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-title',
      message: {
        id: 'later-existing-query',
        role: 'user',
        content: '不能覆盖已有标题',
        timestamp: '2026-08-02T12:46:19.000Z',
      },
    });
    expect(screen.getByTestId('session-title').textContent).toBe('已有标题');
  });
});
