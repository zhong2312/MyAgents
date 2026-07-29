/**
 * useTaskCenterData — thin subscriber over the single app-level task-center
 * store (P2). All ownership (state, fetch lifecycle, listeners, tombstones,
 * derived maps) lives in `taskCenterStore.ts`; this hook just subscribes via
 * `useSyncExternalStore`, so a new Launcher mount reads already-warm data
 * (instant, no spinner, no re-fetch) instead of owning a per-instance fetch.
 *
 * Back-compat: the types/const that other files import from this module
 * (`SessionTag`, `TaskCenterData`, `TASK_CENTER_FRESHNESS_TTL_MS`) are
 * re-exported from the store, so no consumer import paths change.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
    subscribe,
    subscribePassive,
    getSnapshot,
    refresh,
    ensureWorkspaceSessions,
    setSidebarWorkspaceSessionDemand,
    TASK_CENTER_FRESHNESS_TTL_MS,
    type TaskCenterData,
} from '@/hooks/taskCenterStore';
import { CUSTOM_EVENTS } from '../../shared/constants';

export type {
    SessionTag,
    TaskCenterData,
    TaskCenterRefreshScope,
    TaskCenterRefreshOptions,
    TaskCenterActions,
} from '@/hooks/taskCenterStore';
export { TASK_CENTER_FRESHNESS_TTL_MS } from '@/hooks/taskCenterStore';

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    const data = useSyncExternalStore(subscribe, getSnapshot);

    // On an inactive → active transition, kick a throttled silent revalidate so
    // the surface the user just focused is fresh. The store also self-refreshes
    // on Tauri events + every 60s, so this is a top-up, not the primary path.
    // `refresh`/TTL are stable module bindings → deps are just [isActive].
    const prevActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevActiveRef.current;
        prevActiveRef.current = isActive;
        if (wasInactive && isActive) {
            refresh('all', { silent: true, minIntervalMs: TASK_CENTER_FRESHNESS_TTL_MS });
        }
    }, [isActive]);

    return data;
}

/**
 * App-shell projection of the Task Center authority. It subscribes passively,
 * demand-loads only expanded workspaces, and escalates to a one-shot full load
 * only while the global search overlay is open.
 */
export function useGlobalSidebarTaskCenterData(
    workspacePaths: readonly string[],
    searchOpen: boolean,
): TaskCenterData {
    const data = useSyncExternalStore(subscribePassive, getSnapshot);
    const workspaceKey = workspacePaths.join('\n');

    useEffect(() => {
        setSidebarWorkspaceSessionDemand(workspacePaths);
        return () => setSidebarWorkspaceSessionDemand([]);
    }, [workspaceKey, workspacePaths]);

    useEffect(() => {
        if (!searchOpen) return;
        // The overlay shell renders from the current snapshot immediately;
        // revalidation must not flip global loading chrome or compete with that
        // first paint. HistorySearchOverlayContent deliberately has no second
        // mount-time refresh owner.
        refresh('all', { force: true, reason: 'global-sidebar-search', silent: true });
    }, [searchOpen]);

    useEffect(() => {
        if (workspacePaths.length === 0) return;
        const handleSessionChange = () => ensureWorkspaceSessions(workspacePaths, true);
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handleSessionChange);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handleSessionChange);
    }, [workspaceKey, workspacePaths]);

    return data;
}
