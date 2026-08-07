import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionClientMocks = vi.hoisted(() => ({
    deleteSession: vi.fn(),
    getSessions: vi.fn(),
    updateSession: vi.fn(),
}));

const cronTaskMocks = vi.hoisted(() => ({
    getAllCronTasks: vi.fn(),
    getBackgroundSessions: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
    loadAppConfig: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
    isTauri: false,
}));

const tauriListenMocks = vi.hoisted(() => ({
    handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
    listenWithCleanup: vi.fn(),
}));

const tauriCoreMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
    deleteSession: sessionClientMocks.deleteSession,
    getSessions: sessionClientMocks.getSessions,
    updateSession: sessionClientMocks.updateSession,
}));

vi.mock('@/api/cronTaskClient', () => ({
    getAllCronTasks: cronTaskMocks.getAllCronTasks,
    getBackgroundSessions: cronTaskMocks.getBackgroundSessions,
}));

vi.mock('@/config/configService', () => ({
    loadAppConfig: configMocks.loadAppConfig,
}));

vi.mock('@/utils/browserMock', () => ({
    isTauriEnvironment: () => browserMocks.isTauri,
}));

vi.mock('@/utils/tauriListen', () => ({
    listenWithCleanup: tauriListenMocks.listenWithCleanup,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriCoreMocks.invoke,
}));

import {
    actions,
    filterTombstoned,
    sortSessionsByLastActive,
    computeCronBotInfoMap,
    computeSessionTagsMap,
    resolveFloatingBallBoundSession,
    getSnapshot,
    subscribe,
    subscribePassive,
    ensureWorkspaceSessions,
    setSidebarWorkspaceSessionDemand,
    __resetTaskCenterStoreForTest,
    __setTaskCenterSessionsForTest,
} from './taskCenterStore';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';

const sess = (id: string, lastActiveAt: string): SessionMetadata =>
    ({ id, lastActiveAt } as unknown as SessionMetadata);

const favoriteSession = (favorite?: boolean): SessionMetadata => {
    const base: SessionMetadata = {
        id: 's1',
        agentDir: '/ws',
        title: 'Session',
        createdAt: '2026-06-20T00:00:00.000Z',
        lastActiveAt: '2026-06-20T00:00:00.000Z',
    };
    return favorite === undefined ? base : { ...base, favorite };
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    __resetTaskCenterStoreForTest();
    vi.clearAllMocks();
    browserMocks.isTauri = false;
    tauriListenMocks.handlers.clear();
    tauriCoreMocks.invoke.mockImplementation(async (command: string) => {
        if (command === 'cmd_get_user_scheduler_lifecycle_snapshot') {
            return { runningTaskCount: 0, deleteProtectedSessionIds: [] };
        }
        if (command === 'cmd_all_agents_status') return {};
        throw new Error(`Unexpected Tauri command in taskCenterStore test: ${command}`);
    });
    tauriListenMocks.listenWithCleanup.mockImplementation(async (
        event: string,
        handler: (event: { payload: unknown }) => void,
        signal: AbortSignal,
    ) => {
        const handlers = tauriListenMocks.handlers.get(event) ?? new Set();
        handlers.add(handler);
        tauriListenMocks.handlers.set(event, handlers);
        const unlisten = () => handlers.delete(handler);
        signal.addEventListener('abort', unlisten, { once: true });
        return {
            unlisten,
            isRegistered: () => handlers.has(handler),
        };
    });
    sessionClientMocks.deleteSession.mockResolvedValue({ deleted: true });
    sessionClientMocks.getSessions.mockResolvedValue([]);
    cronTaskMocks.getAllCronTasks.mockResolvedValue([]);
    cronTaskMocks.getBackgroundSessions.mockResolvedValue([]);
    configMocks.loadAppConfig.mockResolvedValue({ agents: [] });
});

describe('filterTombstoned', () => {
    it('returns the same array reference when there are no tombstones', () => {
        const data = [sess('a', 'x')];
        expect(filterTombstoned(data, new Set())).toBe(data);
    });
    it('drops tombstoned ids', () => {
        const data = [sess('a', 'x'), sess('b', 'y')];
        expect(filterTombstoned(data, new Set(['a'])).map((s) => s.id)).toEqual(['b']);
    });
});

describe('sortSessionsByLastActive', () => {
    it('sorts desc by lastActiveAt without mutating the input', () => {
        const data = [sess('old', '2020-01-01T00:00:00Z'), sess('new', '2026-01-01T00:00:00Z')];
        expect(sortSessionsByLastActive(data).map((s) => s.id)).toEqual(['new', 'old']);
        expect(data.map((s) => s.id)).toEqual(['old', 'new']); // input untouched
    });
});

describe('computeCronBotInfoMap', () => {
    it('maps channel id → {name, platform}, falling back to agent name', () => {
        const agents = [{
            name: 'Agent A',
            channels: [{ id: 'c1', name: '', type: 'telegram' }, { id: 'c2', name: 'Named', type: 'feishu' }],
        }] as unknown as AgentConfig[];
        const m = computeCronBotInfoMap(agents);
        expect(m.get('c1')).toEqual({ name: 'Agent A', platform: 'telegram' });
        expect(m.get('c2')).toEqual({ name: 'Named', platform: 'feishu' });
    });
});

describe('computeSessionTagsMap', () => {
    const noStatuses = {} as AgentStatusMap;
    it('running scheduled cron → cron tag; one-shot (at) → background tag; idle → no tag', () => {
        const sessions = [sess('s-cron', 'x'), sess('s-at', 'y'), sess('s-none', 'z')];
        const crons = [
            { status: 'running', sessionId: 's-cron', schedule: { kind: 'every' } },
            { status: 'running', sessionId: 's-at', schedule: { kind: 'at' } },
            { status: 'idle', sessionId: 's-none', schedule: { kind: 'every' } },
        ] as unknown as CronTask[];
        const m = computeSessionTagsMap(sessions, crons, [], noStatuses, null);
        expect(m.get('s-cron')).toEqual([{ type: 'cron' }]);
        expect(m.get('s-at')).toEqual([{ type: 'background' }]);
        expect(m.has('s-none')).toBe(false);
    });
    it('tags explicit background session ids', () => {
        const m = computeSessionTagsMap([sess('bg', 'x')], [], ['bg'], noStatuses, null);
        expect(m.get('bg')).toEqual([{ type: 'background' }]);
    });
    it('prefers internalSessionId over sessionId for cron mapping', () => {
        const crons = [{ status: 'running', sessionId: 'outer', internalSessionId: 'internal', schedule: { kind: 'every' } }] as unknown as CronTask[];
        const m = computeSessionTagsMap([sess('internal', 'x')], crons, [], noStatuses, null);
        expect(m.get('internal')).toEqual([{ type: 'cron' }]);
    });
    it('悬浮球当前绑定的 session → floatingBall 标签（与其它标签可叠加）', () => {
        const m = computeSessionTagsMap(
            [sess('fb-sid', 'x'), sess('other', 'y')],
            [{ status: 'running', sessionId: 'fb-sid', schedule: { kind: 'every' } }] as unknown as CronTask[],
            [],
            noStatuses,
            'fb-sid',
        );
        expect(m.get('fb-sid')).toEqual([{ type: 'floatingBall' }, { type: 'cron' }]);
        expect(m.has('other')).toBe(false);
    });
});

describe('resolveFloatingBallBoundSession', () => {
    it('enabled 开且 devGate 未显式关闭时视为渠道在线、返回绑定 sid', () => {
        expect(
            resolveFloatingBallBoundSession({
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBe('sid-1');
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: true,
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBe('sid-1');
    });
    it('gate 显式关闭 / 本体未启用 / 无绑定 / 无配置 → null（IM channel offline 同语义，不打标）', () => {
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: false,
                floatingBallEnabled: true,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBeNull();
        expect(
            resolveFloatingBallBoundSession({
                floatingBallDevGate: true,
                floatingBallEnabled: false,
                floatingBallSessionId: 'sid-1',
            }),
        ).toBeNull();
        expect(
            resolveFloatingBallBoundSession({ floatingBallDevGate: true, floatingBallEnabled: true }),
        ).toBeNull();
        expect(resolveFloatingBallBoundSession(null)).toBeNull();
    });
});

describe('store snapshot', () => {
    it('getSnapshot returns a stable reference (required by useSyncExternalStore)', () => {
        __resetTaskCenterStoreForTest();
        const a = getSnapshot();
        const b = getSnapshot();
        expect(a).toBe(b);
        expect(a.isLoading).toBe(true);
        expect(a.isSessionsLoading).toBe(true);
        expect(a.sessions).toEqual([]);
        expect(a.sessionTagsMap.size).toBe(0);
    });

    it('keeps passive App-shell subscription idle and loads only requested workspaces', async () => {
        sessionClientMocks.getSessions.mockImplementation(async (agentDir?: string) => (
            agentDir === '/work/mino'
                ? [{ ...favoriteSession(false), agentDir, id: 'mino-session' }]
                : []
        ));
        const listener = vi.fn();
        const unsubscribe = subscribePassive(listener);
        try {
            expect(sessionClientMocks.getSessions).not.toHaveBeenCalled();

            ensureWorkspaceSessions(['/work/mino']);
            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['mino-session']);
            });

            expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(1);
            expect(sessionClientMocks.getSessions).toHaveBeenCalledWith('/work/mino');
        } finally {
            unsubscribe();
        }
    });

    it('refreshes a loaded passive workspace when authoritative Session metadata changes', async () => {
        const agentDir = '/work/mino';
        let currentSessions = [
            { ...favoriteSession(false), agentDir, id: 'existing-session' },
        ];
        sessionClientMocks.getSessions.mockImplementation(async (requestedAgentDir?: string) => (
            requestedAgentDir === agentDir ? currentSessions : []
        ));

        setSidebarWorkspaceSessionDemand([agentDir]);
        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['existing-session']);
        });

        browserMocks.isTauri = true;
        const unsubscribe = subscribePassive(() => undefined);
        try {
            await vi.waitFor(() => {
                expect(tauriListenMocks.handlers.get('session:metadata-changed')?.size).toBe(1);
                expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(2);
            });

            currentSessions = [
                { ...favoriteSession(false), agentDir, id: 'feishu-session', title: 'Feishu turn' },
                { ...favoriteSession(false), agentDir, id: 'existing-session' },
            ];
            for (const handler of tauriListenMocks.handlers.get('session:metadata-changed') ?? []) {
                handler({ payload: { agentDirs: [agentDir] } });
            }

            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((session) => session.id)).toEqual([
                    'feishu-session',
                    'existing-session',
                ]);
            });
            expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(3);
            expect(sessionClientMocks.getSessions).toHaveBeenLastCalledWith(agentDir);
        } finally {
            unsubscribe();
        }
    });

    it('reconciles changes that land while the metadata listener is still registering', async () => {
        const agentDir = '/work/mino';
        let currentSessions = [
            { ...favoriteSession(false), agentDir, id: 'existing-session' },
        ];
        sessionClientMocks.getSessions.mockImplementation(async (requestedAgentDir?: string) => (
            requestedAgentDir === agentDir ? currentSessions : []
        ));

        setSidebarWorkspaceSessionDemand([agentDir]);
        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['existing-session']);
        });

        const registration = deferred<{
            unlisten: () => void;
            isRegistered: () => boolean;
        }>();
        tauriListenMocks.listenWithCleanup.mockReturnValueOnce(registration.promise);
        browserMocks.isTauri = true;
        const unsubscribe = subscribePassive(() => undefined);
        try {
            currentSessions = [
                { ...favoriteSession(false), agentDir, id: 'feishu-session', title: 'Feishu turn' },
                { ...favoriteSession(false), agentDir, id: 'existing-session' },
            ];

            registration.resolve({
                unlisten: () => undefined,
                isRegistered: () => true,
            });

            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((session) => session.id)).toEqual([
                    'feishu-session',
                    'existing-session',
                ]);
            });
            expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(2);
            expect(sessionClientMocks.getSessions).toHaveBeenLastCalledWith(agentDir);
        } finally {
            unsubscribe();
        }
    });

    it('reconciles a loaded workspace after a zero-subscriber event gap', async () => {
        const agentDir = '/work/mino';
        let currentSessions = [
            { ...favoriteSession(false), agentDir, id: 'existing-session' },
        ];
        sessionClientMocks.getSessions.mockImplementation(async (requestedAgentDir?: string) => (
            requestedAgentDir === agentDir ? currentSessions : []
        ));

        setSidebarWorkspaceSessionDemand([agentDir]);
        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['existing-session']);
        });

        browserMocks.isTauri = true;
        const firstUnsubscribe = subscribePassive(() => undefined);
        await vi.waitFor(() => {
            expect(tauriListenMocks.handlers.get('session:metadata-changed')?.size).toBe(1);
        });
        firstUnsubscribe();
        expect(tauriListenMocks.handlers.get('session:metadata-changed')?.size).toBe(0);

        currentSessions = [
            { ...favoriteSession(false), agentDir, id: 'feishu-session', title: 'Feishu turn' },
            { ...favoriteSession(false), agentDir, id: 'existing-session' },
        ];
        const secondUnsubscribe = subscribePassive(() => undefined);
        try {
            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((session) => session.id)).toEqual([
                    'feishu-session',
                    'existing-session',
                ]);
            });
        } finally {
            secondUnsubscribe();
        }
    });

    it('retries a failed metadata-listener registration while subscribers remain', async () => {
        vi.useFakeTimers();
        browserMocks.isTauri = true;
        tauriListenMocks.listenWithCleanup
            .mockResolvedValueOnce({
                unlisten: () => undefined,
                isRegistered: () => false,
            })
            .mockResolvedValueOnce({
                unlisten: () => undefined,
                isRegistered: () => true,
            });

        const unsubscribe = subscribePassive(() => undefined);
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(tauriListenMocks.listenWithCleanup).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2_000);
            expect(tauriListenMocks.listenWithCleanup).toHaveBeenCalledTimes(2);
        } finally {
            unsubscribe();
            vi.useRealTimers();
        }
    });

    it('cancels metadata-listener retry after the final subscriber leaves', async () => {
        vi.useFakeTimers();
        browserMocks.isTauri = true;
        tauriListenMocks.listenWithCleanup.mockResolvedValue({
            unlisten: () => undefined,
            isRegistered: () => false,
        });

        const unsubscribe = subscribePassive(() => undefined);
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(tauriListenMocks.listenWithCleanup).toHaveBeenCalledTimes(1);

            unsubscribe();
            await vi.advanceTimersByTimeAsync(2_000);
            expect(tauriListenMocks.listenWithCleanup).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores an on-demand workspace response from an invalidated generation', async () => {
        const staleFetch = deferred<SessionMetadata[]>();
        sessionClientMocks.getSessions.mockReturnValueOnce(staleFetch.promise);
        ensureWorkspaceSessions(['/work/stale']);

        __resetTaskCenterStoreForTest();
        sessionClientMocks.getSessions.mockResolvedValueOnce([
            { ...favoriteSession(false), agentDir: '/work/current', id: 'current-session' },
        ]);
        ensureWorkspaceSessions(['/work/current']);
        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['current-session']);
        });

        staleFetch.resolve([
            { ...favoriteSession(false), agentDir: '/work/stale', id: 'stale-session' },
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['current-session']);
    });

    it('keeps concurrent workspace loading and errors isolated by normalized path', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        sessionClientMocks.getSessions.mockImplementation(async (agentDir?: string) => {
            if (agentDir === '/work/a') throw new Error('workspace A unavailable');
            if (agentDir === '/work/b') {
                return [{ ...favoriteSession(false), agentDir, id: 'session-b' }];
            }
            return [];
        });

        try {
            ensureWorkspaceSessions(['/work/a', '/work/b']);
            await vi.waitFor(() => {
                expect(getSnapshot().workspaceSessionStates.get('/work/a')?.error).toBeTruthy();
                expect(getSnapshot().workspaceSessionStates.get('/work/b')).toEqual({
                    isLoading: false,
                    error: null,
                });
            });

            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['session-b']);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('prevents an older passive workspace response from overwriting a full fetch', async () => {
        const staleWorkspaceFetch = deferred<SessionMetadata[]>();
        sessionClientMocks.getSessions.mockImplementation((agentDir?: string) => {
            if (agentDir) return staleWorkspaceFetch.promise;
            return Promise.resolve([
                { ...favoriteSession(false), agentDir: '/work/a', id: 'full-session' },
            ]);
        });

        setSidebarWorkspaceSessionDemand(['/work/a']);
        const unsubscribe = subscribe(() => undefined);
        try {
            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['full-session']);
            });

            staleWorkspaceFetch.resolve([
                { ...favoriteSession(false), agentDir: '/work/a', id: 'stale-session' },
            ]);
            await Promise.resolve();
            await Promise.resolve();

            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['full-session']);
        } finally {
            unsubscribe();
        }
    });

    it('hands an interrupted full load back to the passive workspace demand', async () => {
        const interruptedFullFetch = deferred<SessionMetadata[]>();
        sessionClientMocks.getSessions.mockImplementation((agentDir?: string) => {
            if (!agentDir) return interruptedFullFetch.promise;
            return Promise.resolve([
                { ...favoriteSession(false), agentDir, id: 'passive-session' },
            ]);
        });

        const unsubscribe = subscribe(() => undefined);
        setSidebarWorkspaceSessionDemand(['/work/a']);
        unsubscribe();

        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['passive-session']);
        });
        interruptedFullFetch.resolve([
            { ...favoriteSession(false), agentDir: '/work/a', id: 'interrupted-session' },
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['passive-session']);
    });

    it('does not let a sessions-only refresh overwrite passive authority after unsubscribe', async () => {
        const staleRefresh = deferred<SessionMetadata[]>();
        sessionClientMocks.getSessions
            .mockResolvedValueOnce([])
            .mockImplementation((agentDir?: string) => {
                if (agentDir === '/work/a') {
                    return Promise.resolve([
                        { ...favoriteSession(false), agentDir, id: 'passive-session' },
                    ]);
                }
                return staleRefresh.promise;
            });

        const unsubscribe = subscribe(() => undefined);
        await vi.waitFor(() => expect(getSnapshot().isLoading).toBe(false));
        setSidebarWorkspaceSessionDemand(['/work/a']);
        actions.refreshSessions();
        unsubscribe();

        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['passive-session']);
        });

        staleRefresh.resolve([
            { ...favoriteSession(false), agentDir: '/work/a', id: 'stale-refresh-session' },
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['passive-session']);
    });

    it('queues a forced workspace refresh behind an existing request', async () => {
        const firstFetch = deferred<SessionMetadata[]>();
        sessionClientMocks.getSessions
            .mockReturnValueOnce(firstFetch.promise)
            .mockResolvedValueOnce([
                { ...favoriteSession(false), agentDir: '/work/a', id: 'fresh-session' },
            ]);

        ensureWorkspaceSessions(['/work/a']);
        ensureWorkspaceSessions(['/work/a'], true);
        expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(1);

        firstFetch.resolve([
            { ...favoriteSession(false), agentDir: '/work/a', id: 'stale-session' },
        ]);

        await vi.waitFor(() => expect(sessionClientMocks.getSessions).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => {
            expect(getSnapshot().sessions.map((session) => session.id)).toEqual(['fresh-session']);
        });
    });

    it('marks demanded workspaces complete as soon as the full Session slice arrives', async () => {
        const sessionsFetch = deferred<SessionMetadata[]>();
        const slowCronFetch = deferred<CronTask[]>();
        sessionClientMocks.getSessions.mockReturnValueOnce(sessionsFetch.promise);
        cronTaskMocks.getAllCronTasks.mockReturnValueOnce(slowCronFetch.promise);

        const unsubscribe = subscribe(() => undefined);
        setSidebarWorkspaceSessionDemand(['/work/a']);
        sessionsFetch.resolve([
            { ...favoriteSession(false), agentDir: '/work/a', id: 'full-session' },
        ]);

        try {
            await vi.waitFor(() => {
                expect(getSnapshot().workspaceSessionStates.get('/work/a')).toEqual({
                    isLoading: false,
                    error: null,
                });
            });
            expect(getSnapshot().isLoading).toBe(true);

            slowCronFetch.resolve([]);
            await vi.waitFor(() => expect(getSnapshot().isLoading).toBe(false));
        } finally {
            unsubscribe();
        }
    });

    it('prevents stale passive decorations from overwriting a newer full snapshot', async () => {
        const staleCronFetch = deferred<CronTask[]>();
        cronTaskMocks.getAllCronTasks
            .mockReturnValueOnce(staleCronFetch.promise)
            .mockResolvedValueOnce([{ id: 'fresh-cron' }] as unknown as CronTask[]);
        sessionClientMocks.getSessions.mockImplementation(async (agentDir?: string) => (
            agentDir
                ? [{ ...favoriteSession(false), agentDir, id: 'workspace-session' }]
                : [{ ...favoriteSession(false), agentDir: '/work/a', id: 'full-session' }]
        ));

        setSidebarWorkspaceSessionDemand(['/work/a']);
        const unsubscribe = subscribe(() => undefined);
        try {
            await vi.waitFor(() => {
                expect(getSnapshot().cronTasks.map((task) => task.id)).toEqual(['fresh-cron']);
            });

            staleCronFetch.resolve([{ id: 'stale-cron' }] as unknown as CronTask[]);
            await Promise.resolve();
            await Promise.resolve();

            expect(getSnapshot().cronTasks.map((task) => task.id)).toEqual(['fresh-cron']);
        } finally {
            unsubscribe();
        }
    });

    it('publishes sessions before slower non-history slices finish', async () => {
        const cronFetch = deferred<CronTask[]>();
        sessionClientMocks.getSessions.mockResolvedValueOnce([
            sess('fresh', '2026-07-04T00:00:00.000Z'),
        ]);
        cronTaskMocks.getAllCronTasks.mockReturnValueOnce(cronFetch.promise);

        const unsubscribe = subscribe(() => undefined);
        try {
            await vi.waitFor(() => {
                expect(getSnapshot().sessions.map((s) => s.id)).toEqual(['fresh']);
            });

            expect(getSnapshot().isSessionsLoading).toBe(false);
            expect(getSnapshot().isLoading).toBe(true);

            cronFetch.resolve([]);
            await vi.waitFor(() => {
                expect(getSnapshot().isLoading).toBe(false);
            });
        } finally {
            unsubscribe();
        }
    });

});

describe('actions.deleteSession', () => {
    it('treats an already-absent Session as an idempotent deletion success', async () => {
        __setTaskCenterSessionsForTest([favoriteSession(false)]);
        sessionClientMocks.deleteSession.mockResolvedValueOnce({
            deleted: false,
            reason: 'not-found',
        });

        await expect(actions.deleteSession('s1')).resolves.toEqual({ deleted: true });
        expect(getSnapshot().sessions).toEqual([]);
    });
});

describe('actions.setSessionFavorite', () => {
    it('optimistically updates then rolls back when PATCH fails', async () => {
        __setTaskCenterSessionsForTest([favoriteSession(false)]);
        sessionClientMocks.updateSession.mockRejectedValueOnce(new Error('write failed'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const success = await actions.setSessionFavorite('s1', true);

            expect(success).toBe(false);
            expect(sessionClientMocks.updateSession).toHaveBeenCalledWith('s1', { favorite: true });
            expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('serializes opposite in-flight requests so the final intent wins', async () => {
        __setTaskCenterSessionsForTest([favoriteSession(false)]);
        sessionClientMocks.getSessions.mockResolvedValue([favoriteSession()]);
        const firstPatch = deferred<SessionMetadata | null>();
        const secondPatch = deferred<SessionMetadata | null>();
        sessionClientMocks.updateSession
            .mockImplementationOnce(() => firstPatch.promise)
            .mockImplementationOnce(() => secondPatch.promise);

        const firstResult = actions.setSessionFavorite('s1', true);
        expect(getSnapshot().sessions[0]?.favorite).toBe(true);

        const secondResult = actions.setSessionFavorite('s1', false);
        expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
        expect(sessionClientMocks.updateSession).toHaveBeenCalledTimes(1);

        firstPatch.resolve(favoriteSession(true));
        await Promise.resolve();
        await Promise.resolve();

        expect(sessionClientMocks.updateSession).toHaveBeenCalledTimes(2);
        expect(sessionClientMocks.updateSession).toHaveBeenNthCalledWith(2, 's1', { favorite: false });

        secondPatch.resolve(favoriteSession());
        await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([true, true]);
        expect(!!getSnapshot().sessions[0]?.favorite).toBe(false);
    });
});
