import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEventMetadata } from '@/api/SseConnection';
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
    isConnected: vi.fn(() => state.connected),
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
  ensureSessionSidecar: vi.fn(async () => undefined),
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));

function Probe() {
  const { sessionId, isLoading, sessionState, historyMessages, systemInitInfo } = useTabState();
  return (
    <output data-testid="activity">
      {JSON.stringify({
        sessionId,
        isLoading,
        sessionState,
        historyCount: historyMessages.length,
        initModel: systemInitInfo?.model ?? null,
      })}
    </output>
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

function emit(eventName: string, data: unknown): void {
  const handler = sseHarness.state.eventHandler;
  if (!handler) throw new Error('SSE event handler is not installed');
  act(() => {
    handler(eventName, data, { connectionGeneration: 1 });
  });
}

describe('TabProvider session activity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('Unexpected proxyFetch call'));
  });

  it.each([false, true])(
    'keeps system-init metadata-only when prewarm=%s',
    async (prewarm) => {
      render(
        <TabProvider
          tabId="tab-activity"
          agentDir="/tmp/workspace"
          sessionId="pending-activity"
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

  it('keeps the live SSE owner when an active pending session receives its real id', async () => {
    const view = render(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-upgrade"
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
});
