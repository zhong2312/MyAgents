// What to render for a tab's content area (App.MemoizedTabContent).
//
// Extracted as a pure function so the load-bearing invariant — a restored
// "cold" chat tab renders a placeholder and NOT the chat path (which is the
// only branch that mounts TabProvider → SSE connect / ensureSessionSidecar) —
// is unit-testable without mounting the whole App tree (Issue #232 / PRD
// 0.2.25). codex review flagged "cold tab must not mount TabProvider" as the
// main regression risk; gating it on this typed discriminant makes the wrong
// path unrepresentable in the JSX switch.

import type { Tab } from '@/types/tab';

export type TabContentKind =
    | 'deferred' // one-frame placeholder for a freshly created heavy tab
    | 'launcher'
    | 'settings'
    | 'capabilities'
    | 'taskcenter'
    | 'space'
    | 'workbench'
    | 'cold' // restored chat tab not yet activated → placeholder, NO TabProvider
    | 'chat'; // live chat tab → mounts TabProvider

/**
 * Decide which content branch a tab renders. Order matters:
 *  - deferred-mount placeholder wins (keeps the open action off the hot path)
 *  - non-chat views are dispatched by `view`
 *  - a chat tab still flagged `restoreState:'cold'` renders the cold
 *    placeholder — crucially BEFORE the 'chat' branch, so TabProvider never
 *    mounts for a tab whose sidecar hasn't been ensured yet
 *  - everything else is a live chat tab
 */
export function tabContentKind(tab: Tab, isDeferredMount: boolean): TabContentKind {
    if (isDeferredMount) return 'deferred';
    if (tab.view === 'launcher') return 'launcher';
    if (tab.view === 'settings') return 'settings';
    if (tab.view === 'capabilities') return 'capabilities';
    if (tab.view === 'taskcenter') return 'taskcenter';
    if (tab.view === 'space') return 'space';
    if (tab.view === 'workbench') return 'workbench';
    if (tab.restoreState === 'cold') return 'cold';
    return 'chat';
}

/**
 * Has a restored-tab activation been abandoned partway through? `activateRestoredTab`
 * does async work (validate → ensureSessionSidecar → activateSession); between
 * awaits the user can close the tab, switch it to another session, or a racing
 * call can already activate it. If so, any sidecar owner we acquire must be
 * released rather than left orphaned (Issue #232, codex review).
 *
 * Abandoned iff the tab no longer exists, is no longer cold, or its
 * sessionId/agentDir changed from what we started activating.
 */
export function isRestoreAbandoned(
    tab: Tab | undefined,
    startedSessionId: string,
    startedAgentDir: string,
): boolean {
    return (
        !tab ||
        tab.restoreState !== 'cold' ||
        tab.sessionId !== startedSessionId ||
        tab.agentDir !== startedAgentDir
    );
}
