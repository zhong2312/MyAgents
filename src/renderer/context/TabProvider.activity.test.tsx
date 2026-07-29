import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEventMetadata } from '@/api/SseConnection';
import { tryClaimSessionResourceTransition } from '@/utils/sessionDeletionCoordinator';
import { useTabState } from './TabContext';
import TabProvider from './TabProvider';

type EventHandler = (
  eventName: string,
  data: unknown,
  metadata: SseEventMetadata,
) => void;
type StatusHandler = (
  status: 'connected' | 'disconnected' | 'reconnecting' | 'failed',
) => void;

const sseHarness = vi.hoisted(() => {
  const state = {
    connected: false,
    generation: 1,
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
    getConnectionGeneration: vi.fn(() => state.generation),
  };
  return { state, connection };
});

const tauriHarness = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  ensureSessionSidecar: vi.fn(async () => undefined),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => sseHarness.connection,
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { multiAgentRuntime: false } }),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getAgentByWorkspacePath: () => undefined,
}));

vi.mock('@/config/services/appConfigService', () => ({
  notifyConfigChanged: vi.fn(),
}));

vi.mock('@/analytics', () => ({
  track: vi.fn(),
  consumePendingSessionBirth: vi.fn(),
  peekPendingSessionBirth: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  hashAgentNameSync: () => null,
  birthContextForSurface: vi.fn(),
}));

vi.mock('@/utils/frontendLogger', () => ({
  subscribeFrontendLogs: () => () => undefined,
  setCurrentTabId: vi.fn(),
  setFocusedTabId: vi.fn(),
}));

vi.mock('@/api/tauriClient', () => ({
  getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:1234'),
  proxyFetch: tauriHarness.proxyFetch,
  isTauri: () => false,
  getSessionActivation: vi.fn(async () => null),
  getSessionPort: vi.fn(async () => null),
  ensureSessionSidecar: tauriHarness.ensureSessionSidecar,
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));

function Probe() {
  const {
    sessionId,
    isLoading,
    isSessionLoading,
    sessionState,
    historyMessages,
    streamingMessage,
    systemInitInfo,
    queuedMessages,
    adoptMigratedSession,
    resetSession,
    sendMessage,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
  } = useTabState();
  return (
    <>
      <output data-testid="activity">
        {JSON.stringify({
          sessionId,
          isLoading,
          sessionState,
          historyCount: historyMessages.length,
          initModel: systemInitInfo?.model ?? null,
        })}
      </output>
      <output data-testid="init-tools">{JSON.stringify(systemInitInfo?.tools ?? [])}</output>
      <output data-testid="streaming-content">{JSON.stringify(streamingMessage?.content ?? null)}</output>
      <output data-testid="session-loading">{String(isSessionLoading)}</output>
      <output data-testid="queue-ids">{JSON.stringify(queuedMessages.map(item => item.queueId))}</output>
      <button type="button" onClick={() => void sendMessage('hello')}>send message</button>
      <button type="button" onClick={() => void resetSession()}>reset session</button>
      <button type="button" onClick={() => void adoptMigratedSession('session-migrated-b', { sidecarAlreadyMigrated: true })}>adopt migrated session</button>
      <button type="button" onClick={() => void cancelQueuedMessage('queue-stale-cancel')}>cancel stale</button>
      <button type="button" onClick={() => void forceExecuteQueuedMessage('queue-stale-force')}>force stale</button>
    </>
  );
}

function readActivity(): {
  sessionId: string | null;
  isLoading: boolean;
  sessionState: string;
  historyCount: number;
  initModel: string | null;
} {
  return JSON.parse(screen.getByTestId('activity').textContent ?? '{}') as {
    sessionId: string | null;
    isLoading: boolean;
    sessionState: string;
    historyCount: number;
    initModel: string | null;
  };
}

function emit(eventName: string, data: unknown, metadata?: Partial<SseEventMetadata>): void {
  const handler = sseHarness.state.eventHandler;
  if (!handler) throw new Error('SSE event handler is not installed');
  act(() => {
    handler(eventName, data, {
      connectionGeneration: sseHarness.state.generation,
      ...metadata,
    });
  });
}

function readQueueIds(): string[] {
  return JSON.parse(screen.getByTestId('queue-ids').textContent ?? '[]') as string[];
}

function readInitTools(): string[] {
  return JSON.parse(screen.getByTestId('init-tools').textContent ?? '[]') as string[];
}

function readStreamingContent(): string | unknown[] | null {
  return JSON.parse(screen.getByTestId('streaming-content').textContent ?? 'null') as string | unknown[] | null;
}

const allowSessionOpening = () => () => undefined;

describe('TabProvider session activity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.generation = 1;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('Unexpected proxyFetch call'));
  });

  it('does not reacquire a Tab owner from an SSE status failure', async () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-race"
        agentDir="/tmp/workspace"
        sessionId="session-delete-race"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.statusHandler).not.toBeNull());
    act(() => {
      sseHarness.state.connected = false;
      sseHarness.state.statusHandler?.('failed');
    });

    await waitFor(() => expect(readActivity().isLoading).toBe(false));
    expect(claimSessionOpeningTransition).not.toHaveBeenCalled();
    expect(tauriHarness.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('does not submit a turn while App is deleting the Session', () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-send"
        agentDir="/tmp/workspace"
        sessionId="session-delete-send"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));

    expect(claimSessionOpeningTransition).toHaveBeenCalledWith('session-delete-send');
    expect(tauriHarness.proxyFetch.mock.calls.some(
      ([url]) => String(url).includes('/chat/send'),
    )).toBe(false);
  });

  it('holds turn admission until the backend accepts the send', async () => {
    let resolveSend!: (response: Response) => void;
    const sendResponse = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    tauriHarness.proxyFetch.mockReturnValueOnce(sendResponse);
    const releaseSendTransition = vi.fn();
    const claimSessionOpeningTransition = vi.fn(() => releaseSendTransition);
    render(
      <TabProvider
        tabId="tab-send-admission"
        agentDir="/tmp/workspace"
        sessionId="session-send-admission"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    await waitFor(() => {
      expect(tauriHarness.proxyFetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat/send'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(releaseSendTransition).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await sendResponse;
    });
    await waitFor(() => expect(releaseSendTransition).toHaveBeenCalledOnce());
  });

  it.each([false, true])(
    'keeps system-init metadata-only when prewarm=%s',
    async (prewarm) => {
      render(
        <TabProvider
          tabId="tab-activity"
          agentDir="/tmp/workspace"
          sessionId="pending-activity"
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: null,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-a',
      });

      emit('chat:status', { sessionState: 'starting' });
      expect(readActivity()).toMatchObject({
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:01.000Z', model: 'model-b' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
        initModel: 'model-b',
      });

      emit('chat:status', { sessionState: 'idle' });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-b',
      });
    },
  );

  it('keeps the pending identity when App refuses system-init adoption', async () => {
    const onSessionIdChange = vi.fn(async () => false);
    render(
      <TabProvider
        tabId="tab-refused-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-refused-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-refused-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-refused-upgrade'));
    expect(readActivity().sessionId).toBe('pending-refused-upgrade');
  });

  it('commits system-init identity only after App accepts adoption', async () => {
    let resolveAdoption!: (accepted: boolean) => void;
    const onSessionIdChange = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveAdoption = resolve;
    }));
    render(
      <TabProvider
        tabId="tab-delayed-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-delayed-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-delayed-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-delayed-upgrade'));
    expect(readActivity().sessionId).toBe('pending-delayed-upgrade');

    await act(async () => {
      resolveAdoption(true);
    });
    await waitFor(() => expect(readActivity().sessionId).toBe('real-delayed-upgrade'));
  });

  it('keeps the live SSE owner when an active pending session receives its real id', async () => {
    const view = render(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    emit('chat:status', { sessionState: 'starting' });
    expect(readActivity()).toMatchObject({
      sessionId: 'pending-upgrade',
      isLoading: true,
      sessionState: 'starting',
    });

    sseHarness.connection.disconnect.mockClear();
    tauriHarness.proxyFetch.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="session-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toMatchObject({
        sessionId: 'session-upgrade',
        isLoading: true,
        sessionState: 'starting',
      });
    });
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(tauriHarness.proxyFetch).not.toHaveBeenCalled();
  });

  it('keeps the live SSE owner when reset upgrades a real session on the same sidecar', async () => {
    let resolveSessionC!: (response: Response) => void;
    const sessionCResponse = new Promise<Response>((resolve) => {
      resolveSessionC = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const sessionMatch = url.match(/\/sessions\/(session-reset-[abc])\?/);
      if (sessionMatch?.[1] === 'session-reset-c' && !init?.method) {
        return sessionCResponse;
      }
      if (sessionMatch && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: sessionMatch[1],
            agentDir: '/tmp/workspace',
            title: 'Reset source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.endsWith('/chat/reset') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          sessionId: 'session-reset-b',
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async (nextSessionId: string) => {
      view.rerender(
        <TabProvider
          tabId="tab-reset"
          agentDir="/tmp/workspace"
          sessionId={nextSessionId}
          onSessionIdChange={onSessionIdChange}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );
      return true;
    });

    const view = render(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-reset-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-b'));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-reset-b'));
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();

    const firstUserMessage = {
      id: '0',
      role: 'user',
      content: 'hello after reset',
      timestamp: '2026-07-15T00:00:01.000Z',
    };
    emit('chat:message-replay', {
      replayKind: 'cold-history',
      sessionId: 'session-reset-b',
      message: firstUserMessage,
    });
    expect(readActivity().historyCount).toBe(1);

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-reset-b',
      message: firstUserMessage,
    });
    expect(readActivity().historyCount).toBe(1);

    emit('chat:status', { sessionState: 'running' }, {
      sessionId: 'session-reset-a',
      liveRevision: 1,
    });
    expect(readActivity().sessionState).toBe('idle');

    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-c"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));

    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      tauriHarness.proxyFetch.mock.calls.some(([url]) => (
        typeof url === 'string' && url.includes('/sessions/session-reset-b?')
      )),
    ).toBe(true));

    resolveSessionC(new Response(JSON.stringify({
      success: true,
      session: {
        id: 'session-reset-c',
        agentDir: '/tmp/workspace',
        title: 'Slow switch target',
        createdAt: '2026-07-15T00:00:00.000Z',
        lastActiveAt: '2026-07-15T00:00:00.000Z',
        runtime: 'builtin',
        messages: [],
        snapshotRevision: 0,
        liveSessionState: 'idle',
        liveStreamingMessage: null,
        hasMoreBefore: false,
      },
    }), { status: 200 }));
  });

  it('moves reset scope before parent adoption without letting connected status relabel it', async () => {
    let resolveAdoption!: (accepted: boolean) => void;
    const adoption = new Promise<boolean>((resolve) => {
      resolveAdoption = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-reset-race-a?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-reset-race-a',
            agentDir: '/tmp/workspace',
            title: 'Reset race source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/chat/reset') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          sessionId: 'session-reset-race-b',
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.endsWith('/chat/send') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const transitions = new Map();
    const transitionOwnerId = 'tab-reset-race';
    const claimSessionOpeningTransition = vi.fn((sessionId: string) => (
      tryClaimSessionResourceTransition(
        transitions,
        sessionId,
        'opening',
        transitionOwnerId,
      )
    ));
    const onSessionIdChange = vi.fn(() => {
      const releaseAdoption = tryClaimSessionResourceTransition(
        transitions,
        'session-reset-race-b',
        'opening',
        transitionOwnerId,
      );
      if (!releaseAdoption) return Promise.resolve(false);
      return adoption.finally(releaseAdoption);
    });
    const view = render(
      <TabProvider
        tabId="tab-reset-race"
        agentDir="/tmp/workspace"
        sessionId="session-reset-race-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-race-b'));
    expect(readActivity().sessionId).toBe('session-reset-race-b');

    act(() => {
      sseHarness.state.statusHandler?.('connected');
    });
    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-reset-race-b',
      message: {
        id: 'reset-race-user',
        role: 'user',
        content: 'accepted during adoption',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    emit('chat:status', { sessionState: 'running' }, {
      sessionId: 'session-reset-race-a',
      liveRevision: 1,
    });
    expect(readActivity()).toMatchObject({
      sessionId: 'session-reset-race-b',
      historyCount: 1,
      sessionState: 'idle',
    });

    claimSessionOpeningTransition.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(claimSessionOpeningTransition).toHaveBeenCalledWith('session-reset-race-b');
    await waitFor(() => expect(
      tauriHarness.proxyFetch.mock.calls.some(([url, init]) => (
        String(url).endsWith('/chat/send') && init?.method === 'POST'
      )),
    ).toBe(true));

    view.rerender(
      <TabProvider
        tabId="tab-reset-race"
        agentDir="/tmp/workspace"
        sessionId="session-reset-race-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );
    await act(async () => {
      resolveAdoption(true);
      await adoption;
    });

    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();
    expect(transitions.size).toBe(0);
  });

  it('reconciles chat-init assistant snapshots instead of appending them as deltas', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-stream-snapshot?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-stream-snapshot',
            agentDir: '/tmp/workspace',
            title: 'Streaming snapshot',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-stream-snapshot"
        agentDir="/tmp/workspace"
        sessionId="session-stream-snapshot"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: 'Hel',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toBe('Hel');

    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: 'Hello',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toBe('Hello');

    emit('chat:message-chunk', '!');
    expect(readStreamingContent()).toBe('Hello!');

    const structuredContent = [
      { type: 'thinking', thinking: 'checking', isComplete: false },
      { type: 'text', text: 'Structured answer' },
    ];
    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: structuredContent,
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toEqual(structuredContent);
  });

  it('rolls back a refused migration relabel before a later real-session switch', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/\/sessions\/(session-refused-[ab])\?/);
      if (match && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: match[1],
            agentDir: '/tmp/workspace',
            title: match[1],
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async () => false);
    const view = render(
      <TabProvider
        tabId="tab-refused-migration"
        agentDir="/tmp/workspace"
        sessionId="session-refused-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-refused-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'adopt migrated session' }));
    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalled());
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();

    view.rerender(
      <TabProvider
        tabId="tab-refused-migration"
        agentDir="/tmp/workspace"
        sessionId="session-refused-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
  });

  it('keeps the live SSE owner when an accepted surface migration upgrades the same sidecar', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-migrated-a?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-migrated-a',
            agentDir: '/tmp/workspace',
            title: 'Migration source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async (nextSessionId: string) => {
      view.rerender(
        <TabProvider
          tabId="tab-migration"
          agentDir="/tmp/workspace"
          sessionId={nextSessionId}
          onSessionIdChange={onSessionIdChange}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );
      return true;
    });

    const view = render(
      <TabProvider
        tabId="tab-migration"
        agentDir="/tmp/workspace"
        sessionId="session-migrated-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-migrated-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'adopt migrated session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-migrated-b',
      { sidecarAlreadyMigrated: true },
    ));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-migrated-b'));
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();
  });

  it('replaces the SSE subscription for an ordinary real-session switch', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/\/sessions\/(session-switch-[ab])\?/);
      if (match && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: match[1],
            agentDir: '/tmp/workspace',
            title: match[1],
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const view = render(
      <TabProvider
        tabId="tab-switch"
        agentDir="/tmp/workspace"
        sessionId="session-switch-a"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-switch-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    view.rerender(
      <TabProvider
        tabId="tab-switch"
        agentDir="/tmp/workspace"
        sessionId="session-switch-b"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-switch-b'));
  });

  it('clears runtime tool metadata when switching to another session', async () => {
    const view = render(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-a" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: {
        timestamp: '2026-07-15T00:00:00.000Z',
        model: 'codex-model',
        tools: ['mcp__playwright__browser_click'],
      },
      prewarm: false,
      runtime: 'codex',
    });
    expect(readInitTools()).toEqual(['mcp__playwright__browser_click']);

    view.rerender(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-b" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readInitTools()).toEqual([]));
  });

  it('restores a running session as active before any assistant chunk exists', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-rest?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-rest',
            agentDir: '/tmp/workspace',
            title: 'Restored session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'running',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-rest"
        agentDir="/tmp/workspace"
        sessionId="session-rest"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toEqual({
        sessionId: 'session-rest',
        isLoading: true,
        sessionState: 'running',
        historyCount: 0,
        initModel: null,
      });
    });

    expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(2);
  });

  it('reconciles a new transport generation without a session-loading overlay', async () => {
    let resolveRecovery!: (response: Response) => void;
    const recoveryResponse = new Promise<Response>((resolve) => {
      resolveRecovery = resolve;
    });
    let sessionGetCount = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-recovery?') && !init?.method) {
        sessionGetCount += 1;
        if (sessionGetCount === 2) return recoveryResponse;
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-recovery',
            agentDir: '/tmp/workspace',
            title: 'Recovery session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: [
              { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
              { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
            ],
            snapshotRevision: 2,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: true,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-recovery"
        agentDir="/tmp/workspace"
        sessionId="session-recovery"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(readActivity().historyCount).toBe(2));

    act(() => {
      sseHarness.state.generation = 2;
      sseHarness.state.statusHandler?.('connected');
    });
    await waitFor(() => expect(sessionGetCount).toBe(2));
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
    expect(readActivity().historyCount).toBe(2);

    await act(async () => {
      resolveRecovery(new Response(JSON.stringify({
        success: true,
        session: {
          id: 'session-recovery',
          agentDir: '/tmp/workspace',
          title: 'Recovery session',
          createdAt: '2026-07-15T00:00:00.000Z',
          lastActiveAt: '2026-07-15T00:00:02.000Z',
          runtime: 'builtin',
          messages: [
            { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
            { id: 'm2', role: 'assistant', content: 'two-final', timestamp: '2026-07-15T00:00:01.000Z' },
            { id: 'm3', role: 'user', content: 'three', timestamp: '2026-07-15T00:00:02.000Z' },
          ],
          snapshotRevision: 3,
          liveSessionState: 'idle',
          liveStreamingMessage: null,
          hasMoreBefore: true,
        },
      }), { status: 200 }));
      await recoveryResponse;
    });

    await waitFor(() => expect(readActivity().historyCount).toBe(3));
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
    expect(tauriHarness.proxyFetch.mock.calls.filter(
      ([url]) => String(url).endsWith('/sessions/switch'),
    )).toHaveLength(1);
  });

  it('retries a failed live snapshot while keeping the recovered transport attached', async () => {
    let sessionGetCount = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-retry?') && !init?.method) {
        sessionGetCount += 1;
        if (sessionGetCount === 2) {
          throw new Error('transient snapshot reset');
        }
        const recovered = sessionGetCount >= 3;
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-retry',
            agentDir: '/tmp/workspace',
            title: 'Retry session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: recovered
              ? '2026-07-15T00:00:02.000Z'
              : '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: recovered
              ? [
                  { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
                  { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
                  { id: 'm3', role: 'assistant', content: 'recovered', timestamp: '2026-07-15T00:00:02.000Z' },
                ]
              : [
                  { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
                  { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
                ],
            snapshotRevision: recovered ? 3 : 2,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/switch') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-retry"
        agentDir="/tmp/workspace"
        sessionId="session-retry"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(readActivity().historyCount).toBe(2));

    act(() => {
      sseHarness.state.generation = 2;
      sseHarness.state.statusHandler?.('connected');
    });

    await waitFor(() => expect(sessionGetCount).toBe(3), { timeout: 2_000 });
    await waitFor(() => expect(readActivity().historyCount).toBe(3));
    expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
    expect(tauriHarness.proxyFetch.mock.calls.filter(
      ([url]) => String(url).endsWith('/sessions/switch'),
    )).toHaveLength(1);
  });

  it.each([
    ['queue-stale-cancel', 'cancel stale', '/chat/queue/cancel'],
    ['queue-stale-force', 'force stale', '/chat/queue/force'],
  ] as const)(
    'removes stale queue replica %s after the authority reports not-found',
    async (queueId, actionLabel, route) => {
      tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
        if (url.endsWith(route)) {
          return new Response(JSON.stringify({
            success: false,
            stale: true,
            error: 'Queue item not found',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected proxyFetch call: ${url}`);
      });

      render(
        <TabProvider
          tabId={`tab-${queueId}`}
          agentDir="/tmp/workspace"
          sessionId={`pending-${queueId}`}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('queue:added', { queueId, messageText: 'stale queued request' });
      expect(readQueueIds()).toContain(queueId);

      fireEvent.click(screen.getByRole('button', { name: actionLabel }));

      await waitFor(() => expect(readQueueIds()).not.toContain(queueId));
    },
  );
});
