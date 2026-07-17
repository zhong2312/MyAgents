import { describe, it, expect } from 'vitest';

import { tabContentKind, isRestoreAbandoned } from './tabContentKind';
import type { Tab } from '@/types/tab';

function tab(over: Partial<Tab>): Tab {
    return {
        id: 't',
        agentDir: '/ws',
        sessionId: 'sid',
        view: 'chat',
        title: 'T',
        sidecarConfigDisposition: 'push',
        ...over,
    };
}

describe('tabContentKind', () => {
    it('a cold restored chat tab renders the placeholder, NOT chat', () => {
        // This is the load-bearing invariant (Issue #232): the 'chat' kind is
        // the ONLY one that mounts TabProvider → SSE / ensureSessionSidecar.
        // A cold tab must never reach it before activation.
        expect(tabContentKind(tab({ restoreState: 'cold' }), false)).toBe('cold');
        expect(tabContentKind(tab({ restoreState: 'cold' }), false)).not.toBe('chat');
    });

    it('a normal chat tab (no restoreState) mounts chat', () => {
        expect(tabContentKind(tab({ restoreState: undefined }), false)).toBe('chat');
    });

    it('deferred mount wins over everything', () => {
        expect(tabContentKind(tab({ restoreState: 'cold' }), true)).toBe('deferred');
        expect(tabContentKind(tab({ view: 'launcher' }), true)).toBe('deferred');
    });

    it('dispatches non-chat views by view field', () => {
        expect(tabContentKind(tab({ view: 'launcher' }), false)).toBe('launcher');
        expect(tabContentKind(tab({ view: 'settings' }), false)).toBe('settings');
        expect(tabContentKind(tab({ view: 'taskcenter' }), false)).toBe('taskcenter');
        expect(tabContentKind(tab({ view: 'space' }), false)).toBe('space');
        expect(tabContentKind(tab({ view: 'workbench', workbench: { workbenchId: 'io.myagents.test', route: 'home' } }), false)).toBe('workbench');
    });

    it('once restoreState is cleared, the tab becomes a live chat tab', () => {
        const cold = tab({ restoreState: 'cold' });
        expect(tabContentKind(cold, false)).toBe('cold');
        const activated = { ...cold, restoreState: undefined };
        expect(tabContentKind(activated, false)).toBe('chat');
    });
});

describe('isRestoreAbandoned', () => {
    const SID = 'sid-1';
    const DIR = '/ws/a';

    it('not abandoned while the same cold tab is still present', () => {
        expect(isRestoreAbandoned(tab({ restoreState: 'cold', sessionId: SID, agentDir: DIR }), SID, DIR)).toBe(false);
    });

    it('abandoned when the tab was closed (gone)', () => {
        // The orphan-owner race: tab closed mid-activation → any acquired
        // sidecar owner must be released, not left to leak (Issue #232).
        expect(isRestoreAbandoned(undefined, SID, DIR)).toBe(true);
    });

    it('abandoned when the tab is no longer cold (already activated by a race)', () => {
        expect(isRestoreAbandoned(tab({ restoreState: undefined, sessionId: SID, agentDir: DIR }), SID, DIR)).toBe(true);
    });

    it('abandoned when the tab switched to a different session', () => {
        expect(isRestoreAbandoned(tab({ restoreState: 'cold', sessionId: 'other', agentDir: DIR }), SID, DIR)).toBe(true);
    });

    it('abandoned when the workspace changed', () => {
        expect(isRestoreAbandoned(tab({ restoreState: 'cold', sessionId: SID, agentDir: '/ws/b' }), SID, DIR)).toBe(true);
    });
});
