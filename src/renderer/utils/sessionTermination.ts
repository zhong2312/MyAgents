/**
 * Tab.sessionId cleanup helpers for the `session:sidecar-terminal` Tauri
 * event flow. The Rust SidecarManager broadcasts `terminal_events` only when
 * a sidecar's last owner has been released (so the health monitor will not
 * auto-restart it). Renderer turns those signals into Tab state resets so
 * `planSessionOpen` can no longer "jump-to-tab" into a Tab whose underlying
 * session is gone.
 *
 * Pure helpers — no React/Tauri imports — so the cleanup contract is
 * unit-testable without component scaffolding.
 */
import { isPendingSessionId } from '../../shared/constants';
import type { Tab } from '@/types/tab';

/**
 * Reset Tab fields when the bound session is permanently gone.
 *
 * Intentionally minimal: only the fields a fresh `createNewTab()` would set.
 * `agentDir` is cleared because the Tab returns to launcher view, where the
 * workspace is re-picked. `sidecarConfigDisposition` is reset to the benign
 * launcher default 'push' (the previous push/adopt/pending disposition doesn't
 * survive sidecar shutdown). `isGenerating` / `hasUnread` are also cleared: a permanently
 * gone sidecar can never fire chat:message-complete, so these UI flags
 * (which TabProvider toggles in response to those events) would otherwise
 * stick on a launcher tab and the user would see a misleading "still
 * working" / "unread" badge on a blank canvas. (Codex review suggestion.)
 */
export function resetTabToLauncher(tab: Tab): Tab {
    return {
        ...tab,
        agentDir: null,
        sessionId: null,
        view: 'launcher',
        title: 'New Tab',
        // Back to a launcher tab → benign 'push' default (its next chat flip sets the
        // real disposition). MUST be explicit: `...tab` would otherwise carry a stale
        // 'pending'/'adopt' onto a launcher tab.
        sidecarConfigDisposition: 'push',
        initialMessage: undefined,
        isGenerating: false,
        hasUnread: false,
    };
}

/**
 * Apply a single `session:sidecar-terminal` event: clear any Tab whose
 * `sessionId` matches the gone session. Most events match zero or one Tab
 * (Tab→Session is normally 1:1) but cron-takeover paths can transiently
 * leave two Tabs sharing a session, so this maps over all matches.
 *
 * Returns the same array reference if nothing changed — keeps React's
 * `setTabs(prev => …)` no-op-friendly (a referentially-equal next state
 * means React skips the re-render).
 */
export function applyTerminalSessionToTabs(
    tabs: readonly Tab[],
    sessionId: string,
): Tab[] | readonly Tab[] {
    let changed = false;
    const next = tabs.map((t) => {
        if (t.sessionId === sessionId) {
            changed = true;
            return resetTabToLauncher(t);
        }
        return t;
    });
    return changed ? next : tabs;
}

/**
 * Apply a reconcile payload (sent on broadcast `Lagged`): keep any Tab whose
 * sessionId is in the live set, reset everyone else.
 *
 * Pending session ids (`pending-{tabId}`) live entirely in the renderer
 * before the backend assigns a real id and bypass the live-sidecar set —
 * preserve them so a brand-new Tab mid-launch isn't yanked back to the
 * launcher view by a reconcile event firing during its setup window.
 */
export function reconcileTabsToLiveSessions(
    tabs: readonly Tab[],
    liveSessionIds: readonly string[],
): Tab[] | readonly Tab[] {
    const live = new Set(liveSessionIds);
    let changed = false;
    const next = tabs.map((t) => {
        if (!t.sessionId) return t;
        // Use the shared `isPendingSessionId` helper rather than a local
        // `startsWith('pending-')` — the prefix lives in `../../shared/constants`
        // and could drift; using the shared predicate keeps it the single
        // source of truth. (Codex review #AI-1.)
        if (isPendingSessionId(t.sessionId)) return t;
        if (live.has(t.sessionId)) return t;
        changed = true;
        return resetTabToLauncher(t);
    });
    return changed ? next : tabs;
}
