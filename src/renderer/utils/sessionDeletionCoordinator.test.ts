import { describe, expect, it, vi } from 'vitest';

import type { Tab } from '@/types/tab';
import { applyTerminalSessionToTabs } from '@/utils/sessionTermination';

import {
    createSessionResourceTransitionState,
    deleteSessionThroughAppOwner,
    isSessionOpening,
    tryClaimSessionResourceTransition,
} from './sessionDeletionCoordinator';

function chatTab(id: string, sessionId: string): Tab {
    return {
        id,
        agentDir: '/workspace',
        sessionId,
        view: 'chat',
        title: id,
        sidecarConfigDisposition: 'adopt',
    };
}

describe('deleteSessionThroughAppOwner', () => {
    function tabOwnerInput(tabsRef: { current: Tab[] }) {
        return {
            getTabs: () => tabsRef.current,
            terminateTabsForSession: vi.fn((sessionId: string) => {
                tabsRef.current = [...applyTerminalSessionToTabs(tabsRef.current, sessionId)];
            }),
        };
    }

    it('serializes open and delete transitions for the same Session without blocking other Sessions', () => {
        const transitions = createSessionResourceTransitionState();
        const releaseOpen = tryClaimSessionResourceTransition(transitions, 'target-session', 'opening');

        expect(releaseOpen).not.toBeNull();
        expect(transitions.openingRevision).toBe(1);
        expect(isSessionOpening(transitions, 'target-session')).toBe(true);
        expect(isSessionOpening(transitions, 'other-session')).toBe(false);
        expect(tryClaimSessionResourceTransition(transitions, 'target-session', 'deleting')).toBeNull();

        const releaseOtherDelete = tryClaimSessionResourceTransition(transitions, 'other-session', 'deleting');
        expect(releaseOtherDelete).not.toBeNull();
        releaseOtherDelete?.();

        releaseOpen?.();
        expect(isSessionOpening(transitions, 'target-session')).toBe(false);
        expect(transitions.openingRevision).toBe(1);
        const releaseDelete = tryClaimSessionResourceTransition(transitions, 'target-session', 'deleting');
        expect(releaseDelete).not.toBeNull();
        expect(isSessionOpening(transitions, 'target-session')).toBe(false);
        expect(transitions.openingRevision).toBe(1);
        releaseDelete?.();
        expect(transitions.claims.size).toBe(0);
    });

    it('allows only the owning Tab to reenter its opening transition', () => {
        const transitions = createSessionResourceTransitionState();
        const releaseOuter = tryClaimSessionResourceTransition(
            transitions,
            'target-session',
            'opening',
            'tab-a',
        );

        const releaseNested = tryClaimSessionResourceTransition(
            transitions,
            'target-session',
            'opening',
            'tab-a',
        );
        expect(releaseNested).not.toBeNull();
        expect(tryClaimSessionResourceTransition(
            transitions,
            'target-session',
            'opening',
            'tab-b',
        )).toBeNull();
        expect(tryClaimSessionResourceTransition(
            transitions,
            'target-session',
            'deleting',
        )).toBeNull();

        releaseOuter?.();
        expect(transitions.claims.has('target-session')).toBe(true);
        expect(tryClaimSessionResourceTransition(
            transitions,
            'target-session',
            'deleting',
        )).toBeNull();

        releaseNested?.();
        expect(transitions.claims.has('target-session')).toBe(false);

        releaseNested?.();
        expect(transitions.claims.has('target-session')).toBe(false);
    });

    it('atomically deletes with every matching Tab owner before resetting those Tabs', async () => {
        const tabsRef = { current: [
            chatTab('active-tab', 'target-session'),
            chatTab('other-tab', 'other-session'),
            chatTab('duplicate-tab', 'target-session'),
        ] };
        const originalOtherTab = tabsRef.current[1];
        const events: string[] = [];
        const tabOwners = tabOwnerInput(tabsRef);
        const terminateTabsForSession = vi.fn((sessionId: string) => {
            events.push('tabs-reset');
            tabOwners.terminateTabsForSession(sessionId);
            expect(tabsRef.current[0]).toMatchObject({ id: 'active-tab', view: 'launcher', sessionId: null });
            expect(tabsRef.current[1]).toBe(originalOtherTab);
            expect(tabsRef.current[2]).toMatchObject({ id: 'duplicate-tab', view: 'launcher', sessionId: null });
        });
        const stopSseProxy = vi.fn(async (tabId: string) => {
            events.push(`sse:${tabId}`);
        });
        const deletePersistedSession = vi.fn(async (
            _sessionId: string,
            releasableTabIds: readonly string[],
        ) => {
            events.push('delete-storage');
            expect(releasableTabIds).toEqual(['active-tab', 'duplicate-tab']);
            expect(tabsRef.current[0]).toMatchObject({ view: 'chat', sessionId: 'target-session' });
            expect(tabsRef.current[2]).toMatchObject({ view: 'chat', sessionId: 'target-session' });
            return { deleted: true as const };
        });

        await expect(deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            getTabs: tabOwners.getTabs,
            terminateTabsForSession,
            hasPersistentOwners: vi.fn(async () => false),
            handoffMountedSessionActivity: vi.fn(async () => ({
                started: false,
                sessionId: 'target-session',
            })),
            stopSseProxy,
            deletePersistedSession,
        })).resolves.toEqual({ deleted: true });

        expect(events.indexOf('delete-storage')).toBeLessThan(events.indexOf('tabs-reset'));
        expect(events.indexOf('tabs-reset')).toBeLessThan(events.indexOf('sse:active-tab'));
        expect(events.indexOf('tabs-reset')).toBeLessThan(events.indexOf('sse:duplicate-tab'));
    });

    it('does not overwrite unrelated Tab changes that happen during preflight', async () => {
        const tabsRef = {
            current: [
                chatTab('target-tab', 'target-session'),
                chatTab('old-other-tab', 'other-session'),
            ],
        };
        const tabOwners = tabOwnerInput(tabsRef);
        let finishOwnerCheck!: (value: boolean) => void;
        const ownerCheck = new Promise<boolean>((resolve) => {
            finishOwnerCheck = resolve;
        });

        const deletion = deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            ...tabOwners,
            hasPersistentOwners: vi.fn(() => ownerCheck),
            handoffMountedSessionActivity: vi.fn(async () => ({
                started: false,
                sessionId: 'target-session',
            })),
            stopSseProxy: vi.fn(async () => undefined),
            deletePersistedSession: vi.fn(async () => ({ deleted: true as const })),
        });

        tabsRef.current = [
            tabsRef.current[0],
            chatTab('new-other-tab', 'new-other-session'),
        ];
        finishOwnerCheck(false);

        await expect(deletion).resolves.toEqual({ deleted: true });
        expect(tabsRef.current).toHaveLength(2);
        expect(tabsRef.current[0]).toMatchObject({ id: 'target-tab', view: 'launcher', sessionId: null });
        expect(tabsRef.current[1]).toMatchObject({ id: 'new-other-tab', sessionId: 'new-other-session' });
    });

    it('preserves mounted Tabs when the atomic delete authority refuses', async () => {
        const tabsRef = { current: [chatTab('tab-1', 'target-session')] };
        const terminateTabsForSession = vi.fn();
        const stopSseProxy = vi.fn();
        await expect(deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            getTabs: () => tabsRef.current,
            terminateTabsForSession,
            hasPersistentOwners: vi.fn(async () => false),
            handoffMountedSessionActivity: vi.fn(async () => ({
                started: false,
                sessionId: 'target-session',
            })),
            stopSseProxy,
            deletePersistedSession: vi.fn(async (_sessionId, releasableTabIds) => {
                expect(releasableTabIds).toEqual(['tab-1']);
                return { deleted: false as const, reason: 'in-use' as const };
            }),
        })).resolves.toEqual({ deleted: false, reason: 'in-use' });

        expect(terminateTabsForSession).not.toHaveBeenCalled();
        expect(stopSseProxy).not.toHaveBeenCalled();
        expect(tabsRef.current[0]).toMatchObject({ view: 'chat', sessionId: 'target-session' });
    });

    it('preserves mounted Tabs when Rust reports a persistent non-Tab owner', async () => {
        const terminateTabsForSession = vi.fn();
        const deletePersistedSession = vi.fn();

        await expect(deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            getTabs: () => [chatTab('tab-1', 'target-session')],
            terminateTabsForSession,
            hasPersistentOwners: vi.fn(async () => true),
            handoffMountedSessionActivity: vi.fn(),
            stopSseProxy: vi.fn(),
            deletePersistedSession,
        })).resolves.toEqual({ deleted: false, reason: 'in-use' });

        expect(terminateTabsForSession).not.toHaveBeenCalled();
        expect(deletePersistedSession).not.toHaveBeenCalled();
    });

    it('preserves mounted Tabs when backend activity cannot be determined', async () => {
        const terminateTabsForSession = vi.fn();
        const deletePersistedSession = vi.fn();

        await expect(deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            getTabs: () => [chatTab('tab-1', 'target-session')],
            terminateTabsForSession,
            hasPersistentOwners: vi.fn(async () => false),
            handoffMountedSessionActivity: vi.fn(async () => {
                throw new Error('activity unavailable');
            }),
            stopSseProxy: vi.fn(),
            deletePersistedSession,
        })).resolves.toEqual({ deleted: false, reason: 'activity-unavailable' });

        expect(terminateTabsForSession).not.toHaveBeenCalled();
        expect(deletePersistedSession).not.toHaveBeenCalled();
    });

    it('preserves mounted Tabs while Rust reports an active turn', async () => {
        const terminateTabsForSession = vi.fn();
        const deletePersistedSession = vi.fn();

        await expect(deleteSessionThroughAppOwner({
            sessionId: 'target-session',
            getTabs: () => [chatTab('tab-1', 'target-session')],
            terminateTabsForSession,
            hasPersistentOwners: vi.fn(async () => false),
            handoffMountedSessionActivity: vi.fn(async () => ({
                started: true,
                sessionId: 'target-session',
            })),
            stopSseProxy: vi.fn(),
            deletePersistedSession,
        })).resolves.toEqual({ deleted: false, reason: 'in-use' });

        expect(terminateTabsForSession).not.toHaveBeenCalled();
        expect(deletePersistedSession).not.toHaveBeenCalled();
    });
});
