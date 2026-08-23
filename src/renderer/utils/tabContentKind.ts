// What to render for a tab's content area (App.MemoizedTabContent). Extracted
// as a pure function so view dispatch and deferred mounting remain testable
// without mounting the whole App tree.

import type { Tab } from '@/types/tab';

export type TabContentKind =
    | 'deferred' // one-frame placeholder for a freshly created heavy non-Chat tab
    | 'deferred-chat' // live TabProvider + lightweight boot surface; Chat mounts later
    | 'launcher'
    | 'settings'
    | 'capabilities'
    | 'taskcenter'
    | 'space'
    | 'workbench'
    | 'chat'; // every chat tab is live and mounts TabProvider

/**
 * Decide which content branch a tab renders. Order matters:
 *  - deferred Chat keeps its lifecycle provider but postpones the heavy view
 *  - deferred non-Chat views use a cheap placeholder
 *  - non-chat views are dispatched by `view`
 *  - every chat tab mounts the normal TabProvider path
 */
export function tabContentKind(tab: Tab, isDeferredMount: boolean): TabContentKind {
    if (isDeferredMount) return tab.view === 'chat' ? 'deferred-chat' : 'deferred';
    if (tab.view === 'launcher') return 'launcher';
    if (tab.view === 'settings') return 'settings';
    if (tab.view === 'capabilities') return 'capabilities';
    if (tab.view === 'taskcenter') return 'taskcenter';
    if (tab.view === 'space') return 'space';
    if (tab.view === 'workbench') return 'workbench';
    return 'chat';
}
