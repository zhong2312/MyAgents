import { describe, it, expect } from 'vitest';

import {
    serializeTabs,
    deserializeTabs,
    hydratePersistedState,
    pickDurableOverride,
    parseCleanMarker,
    shouldOfferRestore,
    planRestoreTabs,
    type PersistedTabState,
} from './tabPersistence';
import { MAX_TABS, type Tab } from '@/types/tab';

function chatTab(over: Partial<Tab> = {}): Tab {
    return {
        id: `tab-${Math.random().toString(36).slice(2, 8)}`,
        agentDir: '/ws/a',
        sessionId: '11111111-2222-3333-4444-555555555555',
        view: 'chat',
        title: 'Chat A',
        sidecarConfigDisposition: 'push',
        ...over,
    };
}

describe('serializeTabs', () => {
    it('keeps only chat tabs with a real session + workspace', () => {
        const tabs: Tab[] = [
            chatTab({ id: 'a', sessionId: 'sid-a' }),
            { id: 'b', agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab', sidecarConfigDisposition: 'push' },
            { id: 'c', agentDir: null, sessionId: null, view: 'settings', title: 'Settings', sidecarConfigDisposition: 'push' },
            { id: 'd', agentDir: '/ws/d', sessionId: null, view: 'taskcenter', title: 'Tasks', sidecarConfigDisposition: 'push' },
            chatTab({ id: 'e', sessionId: 'pending-tab-e' }), // pending → dropped
            chatTab({ id: 'f', agentDir: '', sessionId: 'sid-f' }), // no workspace → dropped
        ];
        const state = serializeTabs(tabs, 'a');
        expect(state).not.toBeNull();
        expect(state!.tabs.map((t) => t.id)).toEqual(['a']);
    });

    it('whitelists fields — no runtime-only fields leak to disk', () => {
        const tab = chatTab({
            id: 'a',
            sessionId: 'sid-a',
            isGenerating: true,
            hasUnread: true,
            sidecarConfigDisposition: 'adopt',
            initialMessage: { text: 'secret draft' },
        });
        const state = serializeTabs([tab], 'a')!;
        expect(state.tabs[0]).toEqual({
            id: 'a',
            agentDir: '/ws/a',
            sessionId: 'sid-a',
            title: 'Chat A',
        });
        expect(Object.keys(state.tabs[0])).not.toContain('isGenerating');
        expect(Object.keys(state.tabs[0])).not.toContain('initialMessage');
    });

    it('de-dupes by sessionId (first occurrence wins)', () => {
        const tabs = [
            chatTab({ id: 'a', sessionId: 'dup' }),
            chatTab({ id: 'b', sessionId: 'dup' }),
            chatTab({ id: 'c', sessionId: 'other' }),
        ];
        const state = serializeTabs(tabs, 'b')!;
        expect(state.tabs.map((t) => t.id)).toEqual(['a', 'c']);
        // active 'b' was deduped away → falls back to first surviving tab
        expect(state.activeTabId).toBe('a');
    });

    it('preserves activeTabId when it survives filtering', () => {
        const tabs = [chatTab({ id: 'a', sessionId: 's1' }), chatTab({ id: 'b', sessionId: 's2' })];
        expect(serializeTabs(tabs, 'b')!.activeTabId).toBe('b');
    });

    it('returns null when nothing is restorable', () => {
        const tabs: Tab[] = [
            { id: 'b', agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab', sidecarConfigDisposition: 'push' },
        ];
        expect(serializeTabs(tabs, 'b')).toBeNull();
    });

    it('de-dupes by tab id (duplicate ids collide as React keys / owner ids)', () => {
        const tabs = [
            chatTab({ id: 'same', sessionId: 's1' }),
            chatTab({ id: 'same', sessionId: 's2' }),
        ];
        const state = serializeTabs(tabs, 'same')!;
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBe('s1');
    });

    it('caps at MAX_TABS', () => {
        const tabs = Array.from({ length: MAX_TABS + 5 }, (_, i) =>
            chatTab({ id: `t${i}`, sessionId: `s${i}` }),
        );
        expect(serializeTabs(tabs, 't0')!.tabs).toHaveLength(MAX_TABS);
    });
});

describe('deserializeTabs', () => {
    it('round-trips a serialized state', () => {
        const tabs = [chatTab({ id: 'a', sessionId: 's1' }), chatTab({ id: 'b', sessionId: 's2' })];
        const state = serializeTabs(tabs, 'b')!;
        const back = deserializeTabs(JSON.stringify(state));
        expect(back).toEqual(state);
    });

    it('returns null on bad JSON', () => {
        expect(deserializeTabs('{not json')).toBeNull();
        expect(deserializeTabs(null)).toBeNull();
        expect(deserializeTabs('')).toBeNull();
    });

    it('returns null on version mismatch', () => {
        const raw = JSON.stringify({ version: 99, tabs: [{ id: 'a', agentDir: '/ws', sessionId: 's', title: 't' }], activeTabId: 'a' });
        expect(deserializeTabs(raw)).toBeNull();
    });

    it('skips malformed tab entries and pending sessions', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'a', agentDir: '/ws', sessionId: 's-a', title: 'A' },
                { id: 'b', sessionId: 's-b', title: 'missing agentDir' },
                { id: 'c', agentDir: '/ws', sessionId: 'pending-x', title: 'pending' },
                { id: 'd', agentDir: '/ws', sessionId: 's-d' }, // missing title
                'garbage',
            ],
            activeTabId: 'a',
        });
        const back = deserializeTabs(raw)!;
        expect(back.tabs.map((t) => t.id)).toEqual(['a']);
    });

    it('re-dedups and re-caps defensively', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'a', agentDir: '/ws', sessionId: 'dup', title: 'A' },
                { id: 'b', agentDir: '/ws', sessionId: 'dup', title: 'B' },
            ],
            activeTabId: 'b',
        });
        const back = deserializeTabs(raw)!;
        expect(back.tabs.map((t) => t.id)).toEqual(['a']);
        expect(back.activeTabId).toBe('a'); // b deduped → fallback
    });

    it('de-dupes by tab id on read too', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'same', agentDir: '/ws', sessionId: 's1', title: 'A' },
                { id: 'same', agentDir: '/ws', sessionId: 's2', title: 'B' },
            ],
            activeTabId: 'same',
        });
        expect(deserializeTabs(raw)!.tabs).toHaveLength(1);
    });

    it('falls back activeTabId to first tab when stored active is gone', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [{ id: 'a', agentDir: '/ws', sessionId: 's', title: 'A' }],
            activeTabId: 'missing',
        });
        expect(deserializeTabs(raw)!.activeTabId).toBe('a');
    });

    it('returns null when no valid tabs remain', () => {
        const raw = JSON.stringify({ version: 1, tabs: [{ id: 'a' }], activeTabId: 'a' });
        expect(deserializeTabs(raw)).toBeNull();
    });
});

describe('hydratePersistedState', () => {
    const state: PersistedTabState = {
        version: 1,
        tabs: [
            { id: 'a', agentDir: '/ws/a', sessionId: 's-a', title: 'A' },
            { id: 'b', agentDir: '/ws/b', sessionId: 's-b', title: 'B' },
        ],
        activeTabId: 'b',
    };

    it('hydrates each persisted tab as a live pending chat tab', () => {
        const { tabs, activeTabId } = hydratePersistedState(state);
        expect(activeTabId).toBe('b');
        expect(tabs).toEqual([
            { id: 'a', agentDir: '/ws/a', sessionId: 's-a', view: 'chat', title: 'A', sidecarConfigDisposition: 'pending' },
            { id: 'b', agentDir: '/ws/b', sessionId: 's-b', view: 'chat', title: 'B', sidecarConfigDisposition: 'pending' },
        ]);
    });
});

describe('pickDurableOverride', () => {
    const durable: PersistedTabState = {
        version: 1,
        tabs: [{ id: 'a', agentDir: '/ws/a', sessionId: 's-a', title: 'A' }],
        activeTabId: 'a',
    };

    it('keeps the localStorage result when it restored tabs (it is at least as fresh)', () => {
        expect(pickDurableOverride(true, durable)).toBeNull();
    });

    it('adopts the durable snapshot only when localStorage came up empty', () => {
        expect(pickDurableOverride(false, durable)).toBe(durable);
    });

    it('returns null when there is no durable snapshot to fall back to', () => {
        expect(pickDurableOverride(false, null)).toBeNull();
    });

    it('returns null when the durable snapshot has no tabs', () => {
        expect(pickDurableOverride(false, { version: 1, tabs: [], activeTabId: null })).toBeNull();
    });
});

describe('parseCleanMarker (Issue #309 — clean-exit marker)', () => {
    it('returns true only for a well-formed { clean: true }', () => {
        expect(parseCleanMarker('{"clean":true}')).toBe(true);
        expect(parseCleanMarker('{ "clean": true, "extra": 1 }')).toBe(true);
    });

    it('treats absent / malformed / non-true as NOT a clean quit (offer restore)', () => {
        expect(parseCleanMarker(null)).toBe(false);
        expect(parseCleanMarker('')).toBe(false);
        expect(parseCleanMarker('not json')).toBe(false);
        expect(parseCleanMarker('{"clean":false}')).toBe(false);
        expect(parseCleanMarker('{"clean":"true"}')).toBe(false); // string, not boolean
        expect(parseCleanMarker('{}')).toBe(false);
        expect(parseCleanMarker('true')).toBe(false); // not an object
        expect(parseCleanMarker('null')).toBe(false);
    });
});

describe('shouldOfferRestore (Issue #309 — startup behaviour)', () => {
    it('offers restore after a non-clean exit with restorable tabs', () => {
        expect(shouldOfferRestore(false, 3)).toBe(true);
        expect(shouldOfferRestore(false, 1)).toBe(true);
    });

    it('never offers after a deliberate (clean) quit, even with tabs', () => {
        expect(shouldOfferRestore(true, 3)).toBe(false);
        expect(shouldOfferRestore(true, 0)).toBe(false);
    });

    it('never offers when there is nothing to restore', () => {
        expect(shouldOfferRestore(false, 0)).toBe(false);
    });
});

describe('planRestoreTabs (Issue #309 — pill restore merge)', () => {
    const launcher: Tab = { id: 'launch-1', agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab', sidecarConfigDisposition: 'push' };
    function restored(id: string, session: string): Tab {
        return { id, agentDir: '/ws/a', sessionId: session, view: 'chat', title: id, sidecarConfigDisposition: 'pending' };
    }
    const candidate = {
        tabs: [restored('r1', 's-1'), restored('r2', 's-2'), restored('r3', 's-3')],
        activeTabId: 'r2',
    };

    it('replaces a pristine lone launcher and keeps the candidate active tab', () => {
        const plan = planRestoreTabs([launcher], candidate);
        expect(plan).not.toBeNull();
        expect(plan!.tabs.map(t => t.id)).toEqual(['r1', 'r2', 'r3']);
        expect(plan!.activeTabId).toBe('r2');
    });

    it('appends (not replaces) when real work is already open, deduped by sessionId', () => {
        const open: Tab = { id: 'open-1', agentDir: '/ws/b', sessionId: 's-2', view: 'chat', title: 'Open', sidecarConfigDisposition: 'push' };
        const plan = planRestoreTabs([open], candidate);
        // s-2 already open → r2 dropped; r1 + r3 appended after the live tab.
        expect(plan!.tabs.map(t => t.id)).toEqual(['open-1', 'r1', 'r3']);
        // candidate active (r2) was deduped out → falls back to first restored in list.
        expect(plan!.activeTabId).toBe('r1');
    });

    it('never lets activeTabId point outside the list when the cap slices it off', () => {
        const open: Tab = { id: 'open-1', agentDir: '/ws/b', sessionId: 's-x', view: 'chat', title: 'Open', sidecarConfigDisposition: 'push' };
        // maxTabs=2: base [open-1] + r1 → r2/r3 (incl. active r2) sliced off.
        const plan = planRestoreTabs([open], candidate, 2);
        expect(plan!.tabs.map(t => t.id)).toEqual(['open-1', 'r1']);
        expect(plan!.tabs.some(t => t.id === plan!.activeTabId)).toBe(true);
        expect(plan!.activeTabId).toBe('r1');
    });

    it('returns null when there is nothing to restore', () => {
        expect(planRestoreTabs([launcher], { tabs: [], activeTabId: null })).toBeNull();
    });

    it('returns null when every candidate tab is already open (all deduped)', () => {
        const open: Tab = { id: 'open-1', agentDir: '/ws/b', sessionId: 's-1', view: 'chat', title: 'Open', sidecarConfigDisposition: 'push' };
        // single candidate, already open, base is not a pristine launcher → nothing to add.
        expect(planRestoreTabs([open], { tabs: [restored('r1', 's-1')], activeTabId: 'r1' })).toBeNull();
    });
});
