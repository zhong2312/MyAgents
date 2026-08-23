import { describe, it, expect } from 'vitest';

import { tabContentKind } from './tabContentKind';
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
    it('a restored pending chat tab mounts the normal chat path', () => {
        expect(tabContentKind(tab({ sidecarConfigDisposition: 'pending' }), false)).toBe('chat');
    });

    it('deferred Chat keeps its lifecycle branch while non-Chat uses a placeholder', () => {
        expect(tabContentKind(tab({ sidecarConfigDisposition: 'pending' }), true)).toBe('deferred-chat');
        expect(tabContentKind(tab({ view: 'launcher' }), true)).toBe('deferred');
    });

    it('dispatches non-chat views by view field', () => {
        expect(tabContentKind(tab({ view: 'launcher' }), false)).toBe('launcher');
        expect(tabContentKind(tab({ view: 'settings' }), false)).toBe('settings');
        expect(tabContentKind(tab({ view: 'capabilities' }), false)).toBe('capabilities');
        expect(tabContentKind(tab({ view: 'taskcenter' }), false)).toBe('taskcenter');
        expect(tabContentKind(tab({ view: 'space' }), false)).toBe('space');
        expect(tabContentKind(tab({ view: 'workbench', workbench: { workbenchId: 'io.myagents.test', route: 'home' } }), false)).toBe('workbench');
    });

});
