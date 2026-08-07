/**
 * Single app-level store for Task Center data (P2).
 *
 * Task-center data (sessions / cronTasks / backgroundSessions /
 * agentStatuses / agents) is app-GLOBAL — none of it is tab-scoped. Previously
 * `useTaskCenterData` owned it PER Launcher mount (its own state + a 6-way
 * Promise.all fan-out + its own Tauri listeners), and C-2 bolted a module-level
 * SWR cache on top to make re-mounts instant. That cache was a band-aid for the
 * real mismatch: global data with a per-instance owner.
 *
 * This store gives that data ONE owner: a single fetch lifecycle, listeners
 * registered ONCE (ref-counted by live subscribers), always-warm state, and
 * `computeSessionTagsMap`/`computeCronBotInfoMap` computed once for everyone.
 * `useTaskCenterData` becomes a thin `useSyncExternalStore` subscriber, so a new
 * Launcher tab subscribes to already-warm data — instant, zero fetch, no
 * spinner — which supersedes and removes `taskCenterCache.ts`.
 *
 * The app-global sidebar is a passive projection over this same authority. It
 * demand-loads only expanded workspace Session slices and keeps one lightweight
 * listener for authoritative Session projection changes, without starting Task
 * polling/listeners. Full Task Center/search reads take over through the same
 * generation fence, then hand current workspace demand back on teardown.
 *
 * Carried-over invariants from C-2:
 *  - tombstones: a deleted session must not resurrect (cross-instance) if a
 *    revalidate transiently re-returns it;
 *  - degraded fetch: a PARTIAL fetch failure must NOT blank a good slice — the
 *    prior value is preserved (better than the old per-instance behaviour).
 *
 * Scope: DISPLAY data only. The Launcher's MCP / provider / agent-config load
 * (first-message correctness) stays in Launcher, eager, and never flows here.
 */

import {
    deleteSession as deleteSessionApi,
    getSessions,
    updateSession as updateSessionApi,
    type SessionMetadata,
} from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { getUserSchedulerLifecycleSnapshot } from '@/api/tauriClient';
import { loadAppConfig } from '@/config/configService';
import { i18n } from '@/i18n';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../../shared/perfTrace';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { isManagedScheduledJob } from '../../shared/managedScheduledJob';
import { normalizeWorkspacePathIdentity } from '../../shared/workspacePath';
import type { CronTask } from '@/types/cronTask';

function taskText(key: string, options?: Record<string, unknown>): string {
    return String(i18n.t(`task:${key}`, options));
}
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';

// ===== Public types (re-exported by useTaskCenterData for back-compat) =====

export type SessionTag =
    | { type: 'im'; platform: string }
    | { type: 'cron' }
    | { type: 'background' }
    | { type: 'floatingBall' };

export interface TaskCenterData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    deleteProtectedSessionIds: ReadonlySet<string>;
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
    isLoading: boolean;
    isSessionsLoading: boolean;
    error: string | null;
    workspaceSessionStates: ReadonlyMap<string, WorkspaceSessionLoadState>;
    refresh: (scope?: TaskCenterRefreshScope, options?: TaskCenterRefreshOptions) => void;
    actions: TaskCenterActions;
}

export interface WorkspaceSessionLoadState {
    isLoading: boolean;
    error: string | null;
}

export type TaskCenterRefreshScope = 'all' | 'sessions' | 'cronTasks' | 'backgroundSessions' | 'agentStatuses';

export interface TaskCenterRefreshOptions {
    force?: boolean;
    minIntervalMs?: number;
    reason?: string;
    silent?: boolean;
}

export interface TaskCenterActions {
    deleteSession: (
        sessionId: string,
        releasableTabIds?: readonly string[],
    ) => ReturnType<typeof deleteSessionApi>;
    setSessionFavorite: (sessionId: string, favorite: boolean) => Promise<boolean>;
    refreshSessions: () => void;
    refreshCronTasks: () => void;
}

export const TASK_CENTER_FRESHNESS_TTL_MS = 2_000;

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
const SESSION_METADATA_LISTENER_RETRY_MS = 2_000;

// ===== Pure helpers (unit-tested) =====

export const sortSessionsByLastActive = (data: SessionMetadata[]): SessionMetadata[] =>
    [...data].sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

/** Drop tombstoned sessions (deleted in any tab); pure. */
export function filterTombstoned(data: SessionMetadata[], deleted: ReadonlySet<string>): SessionMetadata[] {
    if (deleted.size === 0) return data;
    return data.filter((s) => !deleted.has(s.id));
}

/** 悬浮球渠道当前绑定的主 session（gate-aware）。与 IM 标签同语义：标的
 *  是"此刻被渠道绑定的主 session"（live join），不是持久出身——功能关闭
 *  时渠道视为离线、不打标（IM channel offline 同款行为）。Pure. */
export function resolveFloatingBallBoundSession(
    cfg: {
        floatingBallDevGate?: boolean;
        floatingBallEnabled?: boolean;
        floatingBallSessionId?: string;
    } | null,
): string | null {
    if (!cfg || cfg.floatingBallDevGate === false || cfg.floatingBallEnabled !== true) return null;
    return cfg.floatingBallSessionId ?? null;
}

/** Compute session→tags map (im / cron / background / floatingBall). Pure. */
export function computeSessionTagsMap(
    sessions: SessionMetadata[],
    cronTasks: CronTask[],
    backgroundSessionIds: string[],
    agentStatuses: AgentStatusMap,
    floatingBallSessionId: string | null,
): Map<string, SessionTag[]> {
    const map = new Map<string, SessionTag[]>();
    const imSessionPlatformMap = new Map<string, string>();
    for (const agentStatus of Object.values(agentStatuses)) {
        for (const channel of agentStatus.channels) {
            if (channel.status !== 'online' && channel.status !== 'connecting') continue;
            for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
            }
        }
    }
    const cronSessionIds = new Set<string>();
    const bgSessionIds = new Set<string>(backgroundSessionIds);
    for (const t of cronTasks) {
        if (isManagedScheduledJob(t)) continue;
        if (t.status !== 'running') continue;
        const sid = t.internalSessionId || t.sessionId;
        if (t.schedule?.kind === 'at') bgSessionIds.add(sid);
        else cronSessionIds.add(sid);
    }
    for (const session of sessions) {
        const tags: SessionTag[] = [];
        const imPlatform = imSessionPlatformMap.get(session.id);
        if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
        if (floatingBallSessionId && session.id === floatingBallSessionId) {
            tags.push({ type: 'floatingBall' });
        }
        if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
        if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
        if (tags.length > 0) map.set(session.id, tags);
    }
    return map;
}

/** Compute channel-id → {name, platform} from agents[].channels[]. Pure. */
export function computeCronBotInfoMap(agents: AgentConfig[]): Map<string, { name: string; platform: string }> {
    const map = new Map<string, { name: string; platform: string }>();
    for (const agent of agents) {
        for (const channel of (agent.channels ?? [])) {
            map.set(channel.id, { name: channel.name || agent.name, platform: channel.type });
        }
    }
    return map;
}

function filterManagedCronTasks(data: CronTask[]): CronTask[] {
    return data.filter((task) => !isManagedScheduledJob(task));
}

// ===== Store internals =====

interface StoreState {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    deleteProtectedSessionIds: string[];
    backgroundSessionIds: string[];
    agentStatuses: AgentStatusMap;
    agents: AgentConfig[];
    /** 悬浮球渠道当前绑定的 session（gate-aware，见 resolveFloatingBallBoundSession）。 */
    floatingBallSessionId: string | null;
    isLoading: boolean;
    isSessionsLoading: boolean;
    error: string | null;
    workspaceSessionStates: ReadonlyMap<string, WorkspaceSessionLoadState>;
}

let state: StoreState = {
    sessions: [],
    cronTasks: [],
    deleteProtectedSessionIds: [],
    backgroundSessionIds: [],
    agentStatuses: {},
    agents: [],
    floatingBallSessionId: null,
    isLoading: true,
    isSessionsLoading: true,
    error: null,
    workspaceSessionStates: new Map(),
};

const listeners = new Set<() => void>();
const passiveListeners = new Set<() => void>();
const deletedSessionIds = new Set<string>(); // cross-instance tombstones
const loadedWorkspaceSessionKeys = new Set<string>();
const workspaceSessionRequests = new Map<string, Promise<void>>();
const workspaceForceAfterRequest = new Set<string>();
const demandedWorkspaceDirs = new Map<string, string>();
let sessionDecorationRequest: Promise<void> | null = null;
let onDemandGeneration = 0;
let fullSessionAuthoritySeq: number | null = null;

interface FavoriteMutation {
    desired: boolean;
    promise: Promise<boolean>;
}

const favoriteMutations = new Map<string, FavoriteMutation>();

let started = false;
let lifecycleGen = 0; // bumped on stop — an in-flight fetch captured before a stop must not apply state or retry
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
const refreshTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};
let cleanupTauriListeners: (() => void) | null = null;
let sessionMetadataListenerAbort: AbortController | null = null;
let sessionMetadataListenerRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastFullFetchAt = 0;

// per-scope request sequence (latest-wins) — protects against out-of-order async
let seq = 0;
const latestSeqByScope: Partial<Record<TaskCenterRefreshScope, number>> = {};
function startRequest(scope: TaskCenterRefreshScope): number {
    const s = ++seq;
    latestSeqByScope[scope] = s;
    if (scope === 'all') {
        latestSeqByScope.sessions = s;
        latestSeqByScope.cronTasks = s;
        latestSeqByScope.backgroundSessions = s;
        latestSeqByScope.agentStatuses = s;
    }
    return s;
}
const isLatest = (scope: TaskCenterRefreshScope, s: number): boolean => latestSeqByScope[scope] === s;

// Memoized derived maps — recomputed only when their inputs change by reference.
let mapsCache: {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    backgroundSessionIds: string[];
    agentStatuses: AgentStatusMap;
    agents: AgentConfig[];
    floatingBallSessionId: string | null;
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
} | null = null;

let snapshot!: TaskCenterData; // initialised after `refresh`/`actions` exist (buildSnapshot reads them → avoid TDZ)

function buildSnapshot(): TaskCenterData {
    if (
        !mapsCache ||
        mapsCache.sessions !== state.sessions ||
        mapsCache.cronTasks !== state.cronTasks ||
        mapsCache.backgroundSessionIds !== state.backgroundSessionIds ||
        mapsCache.agentStatuses !== state.agentStatuses ||
        mapsCache.agents !== state.agents ||
        mapsCache.floatingBallSessionId !== state.floatingBallSessionId
    ) {
        mapsCache = {
            sessions: state.sessions,
            cronTasks: state.cronTasks,
            backgroundSessionIds: state.backgroundSessionIds,
            agentStatuses: state.agentStatuses,
            agents: state.agents,
            floatingBallSessionId: state.floatingBallSessionId,
            sessionTagsMap: computeSessionTagsMap(
                state.sessions,
                state.cronTasks,
                state.backgroundSessionIds,
                state.agentStatuses,
                state.floatingBallSessionId,
            ),
            cronBotInfoMap: computeCronBotInfoMap(state.agents),
        };
    }
    return {
        sessions: state.sessions,
        cronTasks: state.cronTasks,
        deleteProtectedSessionIds: new Set(state.deleteProtectedSessionIds),
        sessionTagsMap: mapsCache.sessionTagsMap,
        cronBotInfoMap: mapsCache.cronBotInfoMap,
        isLoading: state.isLoading,
        isSessionsLoading: state.isSessionsLoading,
        error: state.error,
        workspaceSessionStates: state.workspaceSessionStates,
        refresh,
        actions,
    };
}

function setState(patch: Partial<StoreState>): void {
    state = { ...state, ...patch };
    snapshot = buildSnapshot();
    for (const l of listeners) l();
    for (const l of passiveListeners) l();
}

function patchSessionFavorite(sessionId: string, favorite: boolean): void {
    setState({
        sessions: state.sessions.map((session) =>
            session.id === sessionId ? { ...session, favorite } : session,
        ),
    });
}

function patchWorkspaceSessionState(key: string, patch: Partial<WorkspaceSessionLoadState>): void {
    const current = state.workspaceSessionStates.get(key) ?? { isLoading: false, error: null };
    const next = new Map(state.workspaceSessionStates);
    next.set(key, { ...current, ...patch });
    setState({ workspaceSessionStates: next });
}

/**
 * Transfer Session/decorations request authority from passive workspace reads
 * to a full Task Center/search read. Outstanding promises cannot be cancelled,
 * so the shared generation makes their eventual writes no-ops.
 */
function beginFullSessionAuthority(requestSeq: number): void {
    onDemandGeneration++;
    workspaceSessionRequests.clear();
    workspaceForceAfterRequest.clear();
    sessionDecorationRequest = null;
    fullSessionAuthoritySeq = requestSeq;
    if (demandedWorkspaceDirs.size > 0) {
        const next = new Map(state.workspaceSessionStates);
        for (const key of demandedWorkspaceDirs.keys()) {
            next.set(key, {
                isLoading: !loadedWorkspaceSessionKeys.has(key),
                error: null,
            });
        }
        setState({ workspaceSessionStates: next });
    }
}

function adoptFullSessionIndexForDemand(): void {
    if (demandedWorkspaceDirs.size === 0) return;
    const next = new Map(state.workspaceSessionStates);
    for (const key of demandedWorkspaceDirs.keys()) {
        loadedWorkspaceSessionKeys.add(key);
        next.set(key, { isLoading: false, error: null });
    }
    setState({ workspaceSessionStates: next });
}

function resumeDemandedWorkspaceSessions(force = true): void {
    if (started || fullSessionAuthoritySeq !== null || demandedWorkspaceDirs.size === 0) return;
    ensureWorkspaceSessions([...demandedWorkspaceDirs.values()], force);
}

async function runFavoriteMutation(sessionId: string, previous: boolean, mutation: FavoriteMutation): Promise<boolean> {
    let lastPersisted = previous;
    try {
        while (true) {
            const next = mutation.desired;
            patchSessionFavorite(sessionId, next);
            const updated = await updateSessionApi(sessionId, { favorite: next });
            if (!updated) {
                patchSessionFavorite(sessionId, lastPersisted);
                return false;
            }

            lastPersisted = !!updated.favorite;
            patchSessionFavorite(sessionId, lastPersisted);
            if (mutation.desired === lastPersisted) {
                if (started) refresh('sessions', { force: true, reason: 'set-session-favorite', silent: true });
                return true;
            }
        }
    } catch (err) {
        console.warn('[taskCenterStore] Failed to update session favorite:', err);
        patchSessionFavorite(sessionId, lastPersisted);
        return false;
    } finally {
        if (favoriteMutations.get(sessionId) === mutation) {
            favoriteMutations.delete(sessionId);
        }
    }
}

// ===== Fetch + refreshers =====

async function fetchData(retryCount = 0, silent = false): Promise<void> {
    const requestSeq = startRequest('all');
    const gen = lifecycleGen;
    beginFullSessionAuthority(requestSeq);
    let retryScheduled = false;
    let fullSucceeded = false;
    if (retryCount === 0 && !silent) {
        setState({
            isLoading: true,
            isSessionsLoading: state.sessions.length === 0,
            error: null,
        });
    }

    try {
        // getSessions is the CRITICAL slice: NOT caught, so a sessions failure
        // rejects the whole fetch → retry/error (an initial total failure must
        // not become a silent empty state). The other sources are best-effort:
        // a PARTIAL failure preserves the prior slice (`ok.*` false → skipped).
        const ok = { cron: true, lifecycle: true, bg: true, agents: true, status: true };
        const sessionsPromise = getSessions().then((sessionsData) => {
            if (gen !== lifecycleGen) return sessionsData;
            if (!isLatest('all', requestSeq) || !isLatest('sessions', requestSeq)) return sessionsData;
            if (deletedSessionIds.size > 0) {
                const liveIds = new Set(sessionsData.map((s) => s.id));
                for (const id of [...deletedSessionIds]) if (!liveIds.has(id)) deletedSessionIds.delete(id);
            }
            setState({
                sessions: sortSessionsByLastActive(filterTombstoned(sessionsData, deletedSessionIds)),
                isSessionsLoading: false,
            });
            // Session availability should not wait for slower cron/config/tag
            // decoration slices. Empty-but-loaded workspaces are complete too.
            adoptFullSessionIndexForDemand();
            return sessionsData;
        });
        const agentStatusPromise = isTauriEnvironment()
            ? import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                .catch(() => { ok.status = false; return state.agentStatuses; })
            : Promise.resolve({} as AgentStatusMap);

        const [sessionsData, cronData, schedulerLifecycle, bgSessions, agentStatusResult, appConfig] = await Promise.all([
            sessionsPromise,
            getAllCronTasks().then(filterManagedCronTasks).catch(() => { ok.cron = false; return state.cronTasks; }),
            getUserSchedulerLifecycleSnapshot().catch(() => {
                ok.lifecycle = false;
                return { runningTaskCount: 0, deleteProtectedSessionIds: state.deleteProtectedSessionIds };
            }),
            getBackgroundSessions().catch(() => { ok.bg = false; return state.backgroundSessionIds; }),
            agentStatusPromise,
            loadAppConfig().catch(() => { ok.agents = false; return null; }),
        ]);

        if (gen !== lifecycleGen) return; // store stopped (last subscriber left) mid-fetch
        if (!isLatest('all', requestSeq)) return; // superseded by a newer full fetch

        // Prune tombstones the backend no longer returns (delete is now durable)
        // so the set can't grow unbounded.
        if (deletedSessionIds.size > 0) {
            const liveIds = new Set(sessionsData.map((s) => s.id));
            for (const id of [...deletedSessionIds]) if (!liveIds.has(id)) deletedSessionIds.delete(id);
        }

        // Per-slice latest-wins: skip a slice whose scope was refreshed by a
        // newer PARTIAL request that already landed (its scope seq moved past
        // this full request) — otherwise an older full fetch would clobber it.
        const patch: Partial<StoreState> = {};
        if (isLatest('sessions', requestSeq)) patch.sessions = sortSessionsByLastActive(filterTombstoned(sessionsData, deletedSessionIds));
        if (isLatest('sessions', requestSeq)) patch.isSessionsLoading = false;
        if (ok.cron && isLatest('cronTasks', requestSeq)) patch.cronTasks = filterManagedCronTasks(cronData);
        if (ok.lifecycle && isLatest('cronTasks', requestSeq)) {
            patch.deleteProtectedSessionIds = schedulerLifecycle.deleteProtectedSessionIds;
        }
        if (ok.bg && isLatest('backgroundSessions', requestSeq)) patch.backgroundSessionIds = bgSessions;
        if (ok.status && isLatest('agentStatuses', requestSeq)) patch.agentStatuses = agentStatusResult;
        if (ok.agents) {
            patch.agents = appConfig?.agents ?? [];
            patch.floatingBallSessionId = resolveFloatingBallBoundSession(appConfig);
        }
        patch.isLoading = false;
        if (!silent) patch.error = null;
        setState(patch);
        fullSucceeded = true;
        lastFullFetchAt = Date.now();
        perfMark(RENDERER_PERF_PHASE.tabDataReady, { surface: 'taskcenter' });
    } catch (err) {
        if (gen !== lifecycleGen) return; // stopped mid-fetch → don't retry with zero subscribers
        console.error('[taskCenterStore] Failed to load data:', err);
        if (!silent && retryCount < MAX_AUTO_RETRIES) {
            retryScheduled = true;
            retryTimer = setTimeout(() => { void fetchData(retryCount + 1, silent); }, RETRY_DELAY_MS);
        } else if (!silent) {
            setState({
                isLoading: false,
                isSessionsLoading: false,
                error: taskText('tasks.loadFailedRetry'),
            });
        } else {
            setState({ isLoading: false, isSessionsLoading: false });
        }
    } finally {
        if (fullSessionAuthoritySeq === requestSeq && !retryScheduled) {
            fullSessionAuthoritySeq = null;
            if (!fullSucceeded) resumeDemandedWorkspaceSessions(true);
        }
    }
}

function refreshSessionsNow(): void {
    const s = startRequest('sessions');
    const gen = lifecycleGen;
    beginFullSessionAuthority(s);
    let succeeded = false;
    getSessions().then((data) => {
        if (gen !== lifecycleGen || fullSessionAuthoritySeq !== s) return;
        if (!isLatest('sessions', s)) return;
        setState({ sessions: sortSessionsByLastActive(filterTombstoned(data, deletedSessionIds)) });
        adoptFullSessionIndexForDemand();
        succeeded = true;
    }).catch((err) => console.warn('[taskCenterStore] refresh sessions failed:', err))
        .finally(() => {
            if (fullSessionAuthoritySeq !== s) return;
            fullSessionAuthoritySeq = null;
            if (!succeeded) resumeDemandedWorkspaceSessions(true);
        });
}
function refreshCronTasksNow(): void {
    const s = startRequest('cronTasks');
    Promise.all([getAllCronTasks(), getUserSchedulerLifecycleSnapshot()])
        .then(([data, lifecycle]) => {
            if (isLatest('cronTasks', s)) {
                setState({
                    cronTasks: filterManagedCronTasks(data),
                    deleteProtectedSessionIds: lifecycle.deleteProtectedSessionIds,
                });
            }
        })
        .catch((err) => console.warn('[taskCenterStore] refresh cron failed:', err));
}
function refreshBackgroundNow(): void {
    const s = startRequest('backgroundSessions');
    getBackgroundSessions().then((data) => { if (isLatest('backgroundSessions', s)) setState({ backgroundSessionIds: data }); })
        .catch((err) => console.warn('[taskCenterStore] refresh background failed:', err));
}
function refreshAgentStatusNow(): void {
    const s = startRequest('agentStatuses');
    if (!isTauriEnvironment()) return;
    import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status')
            .then((data) => { if (isLatest('agentStatuses', s)) setState({ agentStatuses: data }); })
            .catch((err) => console.warn('[taskCenterStore] refresh agent status failed:', err)))
        .catch((err) => console.warn('[taskCenterStore] load tauri api failed:', err));
}

async function refreshSessionDecorationsOnDemand(): Promise<void> {
    if (sessionDecorationRequest) return sessionDecorationRequest;
    const generation = onDemandGeneration;
    sessionDecorationRequest = (async () => {
        const [cronData, schedulerLifecycle, bgSessions, agentStatuses, appConfig] = await Promise.all([
            getAllCronTasks().then(filterManagedCronTasks).catch(() => state.cronTasks),
            getUserSchedulerLifecycleSnapshot().catch(() => ({
                runningTaskCount: 0,
                deleteProtectedSessionIds: state.deleteProtectedSessionIds,
            })),
            getBackgroundSessions().catch(() => state.backgroundSessionIds),
            isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => state.agentStatuses)
                : Promise.resolve(state.agentStatuses),
            loadAppConfig().catch(() => null),
        ]);
        if (generation !== onDemandGeneration) return;
        setState({
            cronTasks: cronData,
            deleteProtectedSessionIds: schedulerLifecycle.deleteProtectedSessionIds,
            backgroundSessionIds: bgSessions,
            agentStatuses,
            ...(appConfig ? {
                agents: appConfig.agents ?? [],
                floatingBallSessionId: resolveFloatingBallBoundSession(appConfig),
            } : {}),
        });
    })().finally(() => {
        if (generation === onDemandGeneration) sessionDecorationRequest = null;
    });
    return sessionDecorationRequest;
}

function mergeWorkspaceSessions(agentDir: string, sessions: SessionMetadata[]): void {
    const targetKey = normalizeWorkspacePathIdentity(agentDir);
    const retained = state.sessions.filter(
        (session) => normalizeWorkspacePathIdentity(session.agentDir) !== targetKey,
    );
    setState({
        sessions: sortSessionsByLastActive(filterTombstoned([...retained, ...sessions], deletedSessionIds)),
    });
}

/**
 * Demand-load only the Session metadata for workspaces whose trees are open.
 * This writes into the same Task Center store authority without activating its
 * full tasks/cron/session polling lifecycle.
 */
export function ensureWorkspaceSessions(agentDirs: readonly string[], force = false): void {
    const unique = new Map<string, string>();
    for (const agentDir of agentDirs) {
        const key = normalizeWorkspacePathIdentity(agentDir);
        if (key) unique.set(key, agentDir);
    }
    if (unique.size === 0) return;

    for (const [key, agentDir] of unique) demandedWorkspaceDirs.set(key, agentDir);
    if (started || fullSessionAuthoritySeq !== null) return;

    void refreshSessionDecorationsOnDemand();
    for (const [key, agentDir] of unique) {
        if (!force && loadedWorkspaceSessionKeys.has(key)) continue;
        if (workspaceSessionRequests.has(key)) {
            if (force) workspaceForceAfterRequest.add(key);
            continue;
        }
        patchWorkspaceSessionState(key, { isLoading: true, error: null });
        const generation = onDemandGeneration;
        const request = getSessions(agentDir)
            .then((sessions) => {
                if (generation !== onDemandGeneration) return;
                loadedWorkspaceSessionKeys.add(key);
                mergeWorkspaceSessions(agentDir, sessions);
                patchWorkspaceSessionState(key, { isLoading: false, error: null });
            })
            .catch((err) => {
                if (generation !== onDemandGeneration) return;
                console.warn(`[taskCenterStore] workspace sessions failed (${agentDir}):`, err);
                patchWorkspaceSessionState(key, {
                    isLoading: false,
                    error: taskText('tasks.loadFailedRetry'),
                });
            })
            .finally(() => {
                if (generation !== onDemandGeneration) return;
                workspaceSessionRequests.delete(key);
                if (workspaceForceAfterRequest.delete(key)) {
                    const demandedDir = demandedWorkspaceDirs.get(key);
                    if (demandedDir) ensureWorkspaceSessions([demandedDir], true);
                }
            });
        workspaceSessionRequests.set(key, request);
    }
}

/** Replace the App Shell's current expansion demand without starting full polling. */
export function setSidebarWorkspaceSessionDemand(agentDirs: readonly string[]): void {
    const next = new Map<string, string>();
    for (const agentDir of agentDirs) {
        const key = normalizeWorkspacePathIdentity(agentDir);
        if (key) next.set(key, agentDir);
    }
    demandedWorkspaceDirs.clear();
    for (const [key, agentDir] of next) demandedWorkspaceDirs.set(key, agentDir);
    ensureWorkspaceSessions(agentDirs);
}

interface SessionMetadataChangedPayload {
    agentDirs?: string[];
}

/**
 * Invalidate the passive workspace cache from the persisted projection owner,
 * not from whichever Runtime/channel happened to author the write.
 */
function handleSessionMetadataChanged(payload: SessionMetadataChangedPayload): void {
    const changedKeys = new Set(
        (payload.agentDirs ?? [])
            .map(normalizeWorkspacePathIdentity)
            .filter(Boolean),
    );
    if (changedKeys.size === 0) {
        loadedWorkspaceSessionKeys.clear();
    } else {
        for (const key of changedKeys) loadedWorkspaceSessionKeys.delete(key);
    }

    // Active Task Center/search surfaces own a complete global snapshot. A
    // newer global request also supersedes any full read that raced this event.
    if (started || fullSessionAuthoritySeq !== null) {
        refreshSessionsNow();
        return;
    }

    const affectedDemand = [...demandedWorkspaceDirs]
        .filter(([key]) => changedKeys.size === 0 || changedKeys.has(key))
        .map(([, agentDir]) => agentDir);
    if (affectedDemand.length > 0) ensureWorkspaceSessions(affectedDemand, true);
}

function ensureSessionMetadataListener(): void {
    if (
        sessionMetadataListenerAbort ||
        !isTauriEnvironment() ||
        (listeners.size === 0 && passiveListeners.size === 0)
    ) return;
    if (sessionMetadataListenerRetryTimer) {
        clearTimeout(sessionMetadataListenerRetryTimer);
        sessionMetadataListenerRetryTimer = null;
    }
    const ac = new AbortController();
    sessionMetadataListenerAbort = ac;
    void listenWithCleanup<SessionMetadataChangedPayload>(
        'session:metadata-changed',
        (event) => handleSessionMetadataChanged(event.payload ?? {}),
        ac.signal,
    ).then((registration) => {
        if (sessionMetadataListenerAbort !== ac || ac.signal.aborted) return;
        if (!registration.isRegistered()) {
            ac.abort();
            sessionMetadataListenerAbort = null;
            if (listeners.size > 0 || passiveListeners.size > 0) {
                sessionMetadataListenerRetryTimer = setTimeout(() => {
                    sessionMetadataListenerRetryTimer = null;
                    ensureSessionMetadataListener();
                }, SESSION_METADATA_LISTENER_RETRY_MS);
            }
            return;
        }

        // Tauri events are edge-triggered and are not replayed. Re-read the
        // persisted authority after registration to close both the async
        // install window and any zero-subscriber interval before this mount.
        handleSessionMetadataChanged({});
    });
}

function maybeStopSessionMetadataListener(): void {
    if (listeners.size > 0 || passiveListeners.size > 0) return;
    sessionMetadataListenerAbort?.abort();
    sessionMetadataListenerAbort = null;
    if (sessionMetadataListenerRetryTimer) {
        clearTimeout(sessionMetadataListenerRetryTimer);
        sessionMetadataListenerRetryTimer = null;
    }
}

function debounced(key: string, fn: () => void, delayMs: number): void {
    if (refreshTimers[key]) clearTimeout(refreshTimers[key]!);
    refreshTimers[key] = setTimeout(() => { refreshTimers[key] = null; fn(); }, delayMs);
}

export const refresh = (scope: TaskCenterRefreshScope = 'all', options: TaskCenterRefreshOptions = {}): void => {
    if (!options.force && options.minIntervalMs && scope === 'all') {
        if (Date.now() - lastFullFetchAt < options.minIntervalMs) return;
    }
    switch (scope) {
        case 'sessions': return refreshSessionsNow();
        case 'cronTasks': return refreshCronTasksNow();
        case 'backgroundSessions': return refreshBackgroundNow();
        case 'agentStatuses': return refreshAgentStatusNow();
        default: void fetchData(0, options.silent ?? false);
    }
};

export const actions: TaskCenterActions = {
    deleteSession: async (sessionId: string, releasableTabIds = []) => {
        const result = await deleteSessionApi(sessionId, releasableTabIds);
        if (!result.deleted && result.reason !== 'not-found') {
            if (result.reason === 'in-use') {
                refresh('cronTasks', { force: true, reason: 'delete-session-in-use', silent: true });
            }
            return result;
        }
        deletedSessionIds.add(sessionId); // tombstone — survives across all subscribers
        setState({ sessions: state.sessions.filter((s) => s.id !== sessionId) });
        if (started) refresh('sessions', { force: true, reason: 'delete-session', silent: true });
        return result.deleted ? result : { deleted: true };
    },
    setSessionFavorite: async (sessionId: string, favorite: boolean) => {
        const existing = favoriteMutations.get(sessionId);
        if (existing) {
            existing.desired = favorite;
            patchSessionFavorite(sessionId, favorite);
            return existing.promise;
        }

        const previous = state.sessions.find((session) => session.id === sessionId)?.favorite ?? false;
        const mutation: FavoriteMutation = {
            desired: favorite,
            promise: Promise.resolve(false),
        };
        favoriteMutations.set(sessionId, mutation);
        mutation.promise = runFavoriteMutation(sessionId, previous, mutation);
        return mutation.promise;
    },
    refreshSessions: () => refresh('sessions', { force: true, silent: true }),
    refreshCronTasks: () => refresh('cronTasks', { force: true, silent: true }),
};

// First snapshot — built now that `refresh` and `actions` are defined
// (buildSnapshot references them; building at the top-level declaration would
// hit the temporal dead zone).
snapshot = buildSnapshot();

// ===== Lifecycle (ref-counted by subscribers) =====

function registerTauriListeners(): void {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    const onSessionTitle = () => debounced('sessions', refreshSessionsNow, 300);
    window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, onSessionTitle);

    void listenWithCleanup('session:background-complete', () => {
        debounced('background', refreshBackgroundNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
        debounced('cron', refreshCronTasksNow, 100);
    }, ac.signal);
    void listenWithCleanup('cron:task-stopped', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:task-started', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:execution-complete', () => {
        debounced('cron', refreshCronTasksNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
    }, ac.signal);
    void listenWithCleanup('cron:scheduler-started', () => {
        debounced('cron', refreshCronTasksNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
    }, ac.signal);
    void listenWithCleanup('cron:task-deleted', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:task-updated', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('goal:changed', () => debounced('cron', refreshCronTasksNow, 200), ac.signal);
    void listenWithCleanup('agent:status-changed', () => {
        debounced('agent', refreshAgentStatusNow, 1000);
        debounced('sessions', refreshSessionsNow, 1000);
        debounced('cron', refreshCronTasksNow, 100);
    }, ac.signal);
    void listenWithCleanup('task:status-changed', () => {
        debounced('cron', refreshCronTasksNow, 100);
    }, ac.signal);
    void listenWithCleanup('task:session-rebound', () => {
        debounced('sessions', refreshSessionsNow, 100);
        debounced('cron', refreshCronTasksNow, 100);
    }, ac.signal);

    cleanupTauriListeners = () => {
        ac.abort();
        window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, onSessionTitle);
    };
}

function ensureStarted(): void {
    if (started) return;
    started = true;
    registerTauriListeners();
    void fetchData(0); // initial load (once; subsequent subscribers get warm data)
    intervalTimer = setInterval(() => { void fetchData(0, true); }, BACKGROUND_REFRESH_INTERVAL_MS);
}

function maybeStop(): void {
    if (listeners.size > 0) return;
    // No live subscribers → stop background work, but KEEP data warm so the next
    // mount is still instant.
    started = false;
    lifecycleGen++; // invalidate any in-flight fetch so it won't apply state or schedule a retry after stop
    cleanupTauriListeners?.();
    cleanupTauriListeners = null;
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const k of Object.keys(refreshTimers)) {
        if (refreshTimers[k]) { clearTimeout(refreshTimers[k]!); refreshTimers[k] = null; }
    }
    // Hand Session authority back to the always-mounted App Shell projection.
    // Any full request from the just-unmounted Task Center is now stale by
    // lifecycleGen; the demand generation below owns the next write.
    fullSessionAuthoritySeq = null;
    resumeDemandedWorkspaceSessions(true);
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    ensureSessionMetadataListener();
    ensureStarted();
    return () => {
        listeners.delete(listener);
        maybeStop();
        maybeStopSessionMetadataListener();
    };
}

/** Subscribe to the shared snapshot without starting the full Task Center lifecycle. */
export function subscribePassive(listener: () => void): () => void {
    passiveListeners.add(listener);
    ensureSessionMetadataListener();
    return () => {
        passiveListeners.delete(listener);
        maybeStopSessionMetadataListener();
    };
}

export function getSnapshot(): TaskCenterData {
    return snapshot;
}

/** Test-only: reset all module state between cases. */
export function __resetTaskCenterStoreForTest(): void {
    onDemandGeneration++;
    lifecycleGen++;
    state = { sessions: [], cronTasks: [], deleteProtectedSessionIds: [], backgroundSessionIds: [], agentStatuses: {}, agents: [], floatingBallSessionId: null, isLoading: true, isSessionsLoading: true, error: null, workspaceSessionStates: new Map() };
    listeners.clear();
    passiveListeners.clear();
    deletedSessionIds.clear();
    loadedWorkspaceSessionKeys.clear();
    workspaceSessionRequests.clear();
    workspaceForceAfterRequest.clear();
    demandedWorkspaceDirs.clear();
    sessionDecorationRequest = null;
    fullSessionAuthoritySeq = null;
    favoriteMutations.clear();
    mapsCache = null;
    snapshot = buildSnapshot();
    started = false;
    lastFullFetchAt = 0;
    seq = 0;
    cleanupTauriListeners?.();
    cleanupTauriListeners = null;
    sessionMetadataListenerAbort?.abort();
    sessionMetadataListenerAbort = null;
    if (sessionMetadataListenerRetryTimer) {
        clearTimeout(sessionMetadataListenerRetryTimer);
        sessionMetadataListenerRetryTimer = null;
    }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const k of Object.keys(refreshTimers)) {
        if (refreshTimers[k]) { clearTimeout(refreshTimers[k]!); refreshTimers[k] = null; }
    }
    for (const k of Object.keys(latestSeqByScope)) delete latestSeqByScope[k as TaskCenterRefreshScope];
}

/** Test-only: seed sessions without starting the subscriber fetch lifecycle. */
export function __setTaskCenterSessionsForTest(sessions: SessionMetadata[]): void {
    setState({ sessions });
}
