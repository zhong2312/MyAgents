import { describe, expect, it } from 'vitest';

import type { Tab } from '@/types/tab';

import {
    applyTerminalSessionToTabs,
    reconcileTabsToLiveSessions,
    resetTabToLauncher,
} from './sessionTermination';

const makeTab = (overrides: Partial<Tab>): Tab => ({
    id: 'tab-x',
    agentDir: '/Users/me/proj',
    sessionId: 'sess-1',
    view: 'chat',
    title: 'Project',
    sidecarConfigDisposition: 'push',
    ...overrides,
});

describe('resetTabToLauncher', () => {
    it('resets the session-bound fields back to a launcher state', () => {
        const tab = makeTab({
            agentDir: '/x',
            sessionId: 'sess-1',
            view: 'chat',
            title: 'X',
            sidecarConfigDisposition: 'adopt',
            initialMessage: { text: 'hi' } as Tab['initialMessage'],
        });
        const next = resetTabToLauncher(tab);
        expect(next.id).toBe(tab.id);
        expect(next.agentDir).toBeNull();
        expect(next.sessionId).toBeNull();
        expect(next.view).toBe('launcher');
        expect(next.title).toBe('New Tab');
        // Stale 'adopt' must reset to the benign launcher default, not carry over.
        expect(next.sidecarConfigDisposition).toBe('push');
        expect(next.initialMessage).toBeUndefined();
    });

    it('clears isGenerating / hasUnread flags', () => {
        // A permanently-gone sidecar can't fire chat:message-complete, so
        // these flags would otherwise stick on a launcher tab and show a
        // misleading "still working" / "unread" badge on a blank canvas.
        const tab = makeTab({ isGenerating: true, hasUnread: true });
        const next = resetTabToLauncher(tab);
        expect(next.isGenerating).toBe(false);
        expect(next.hasUnread).toBe(false);
    });
});

describe('applyTerminalSessionToTabs', () => {
    it('clears the matching tab and leaves siblings untouched', () => {
        const tabs: Tab[] = [
            makeTab({ id: 'a', sessionId: 'sess-1' }),
            makeTab({ id: 'b', sessionId: 'sess-2' }),
        ];
        const next = applyTerminalSessionToTabs(tabs, 'sess-1');
        expect(next).not.toBe(tabs);
        expect(next).toHaveLength(2);
        expect(next[0].sessionId).toBeNull();
        expect(next[0].view).toBe('launcher');
        expect(next[1]).toBe(tabs[1]); // referentially preserved
    });

    it('returns the same reference when no tab matches', () => {
        const tabs: Tab[] = [makeTab({ id: 'a', sessionId: 'sess-1' })];
        const next = applyTerminalSessionToTabs(tabs, 'sess-99');
        expect(next).toBe(tabs);
    });

    it('clears every tab bound to the same session', () => {
        // Cron takeover transiently leaves two tabs sharing a session id —
        // a single terminal event must clear both.
        const tabs: Tab[] = [
            makeTab({ id: 'a', sessionId: 'sess-1' }),
            makeTab({ id: 'b', sessionId: 'sess-1' }),
            makeTab({ id: 'c', sessionId: 'sess-2' }),
        ];
        const next = applyTerminalSessionToTabs(tabs, 'sess-1');
        expect((next as Tab[])[0].sessionId).toBeNull();
        expect((next as Tab[])[1].sessionId).toBeNull();
        expect((next as Tab[])[2]).toBe(tabs[2]);
    });

    it('ignores tabs with null sessionId', () => {
        const tabs: Tab[] = [makeTab({ id: 'a', sessionId: null, view: 'launcher' })];
        const next = applyTerminalSessionToTabs(tabs, 'sess-anything');
        expect(next).toBe(tabs);
    });
});

describe('reconcileTabsToLiveSessions', () => {
    it('clears tabs whose sessionId is not in the live set', () => {
        const tabs: Tab[] = [
            makeTab({ id: 'a', sessionId: 'sess-alive' }),
            makeTab({ id: 'b', sessionId: 'sess-dead' }),
        ];
        const next = reconcileTabsToLiveSessions(tabs, ['sess-alive']);
        expect((next as Tab[])[0]).toBe(tabs[0]);
        expect((next as Tab[])[1].sessionId).toBeNull();
    });

    it('preserves tabs with pending session ids', () => {
        // A brand-new Tab mid-launch has `pending-{tabId}`; it isn't in
        // Rust's live set yet, but we must NOT yank it back to launcher
        // mid-flight.
        const tabs: Tab[] = [
            makeTab({ id: 'a', sessionId: 'pending-tab-a' }),
            makeTab({ id: 'b', sessionId: 'sess-dead' }),
        ];
        const next = reconcileTabsToLiveSessions(tabs, []);
        expect((next as Tab[])[0]).toBe(tabs[0]); // pending preserved
        expect((next as Tab[])[1].sessionId).toBeNull();
    });

    it('returns the same reference when nothing changes', () => {
        const tabs: Tab[] = [
            makeTab({ id: 'a', sessionId: 'sess-alive' }),
            makeTab({ id: 'b', sessionId: null, view: 'launcher' }),
        ];
        const next = reconcileTabsToLiveSessions(tabs, ['sess-alive']);
        expect(next).toBe(tabs);
    });

    it('preserves tabs with null sessionId regardless of live set', () => {
        const tabs: Tab[] = [makeTab({ id: 'a', sessionId: null, view: 'launcher' })];
        const next = reconcileTabsToLiveSessions(tabs, []);
        expect(next).toBe(tabs);
    });
});
