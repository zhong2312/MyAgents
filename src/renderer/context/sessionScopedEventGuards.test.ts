import { describe, it, expect } from 'vitest';
import {
    classifySessionActivity,
    decideSystemInitSessionId,
    decidePersistedContextUsageSeed,
    shouldAcceptSessionScopedSseSnapshot,
    shouldPreserveSnapshotOnPendingBirthPropSync,
} from './sessionScopedEventGuards';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const SID_C = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const PENDING_B = 'pending-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('classifySessionActivity', () => {
    it.each(['starting', 'running'] as const)('classifies %s as active', (state) => {
        expect(classifySessionActivity(state)).toBe('active');
    });

    it.each(['idle', 'error'] as const)('classifies %s as terminal', (state) => {
        expect(classifySessionActivity(state)).toBe('terminal');
    });

    it('does not infer backend activity from the renderer-only stopping state', () => {
        expect(classifySessionActivity('stopping')).toBe('none');
    });
});

describe('shouldAcceptSessionScopedSseSnapshot', () => {
    it('rejects a stale A snapshot while the tab is switching to pending B', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_A,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: true,
            }),
        ).toBe(false);
    });

    it('accepts a pending-session snapshot from the currently attached pending connection', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: true,
            }),
        ).toBe(true);
    });

    it('accepts a concrete snapshot during pending-session id upgrade', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });

    it('rejects a pending-connection upgrade snapshot without matching payload session id', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: true,
                isCurrentSessionPending: false,
            }),
        ).toBe(false);
    });

    it('rejects payloads for a different concrete session', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(false);
    });

    it('accepts matching concrete session snapshots', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });

    it('accepts the current reset target payload through the still-attached sidecar stream', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_A,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });

    it('accepts a matching payload during SSE bootstrap before the connection id is promoted', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: null,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });

    it('rejects stale payloads during SSE bootstrap', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: null,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(false);
    });
});

describe('shouldPreserveSnapshotOnPendingBirthPropSync', () => {
    it('preserves snapshots when parent prop catches up to an internally adopted birth session', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: PENDING_B,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: SID_B,
                wasPreviousSessionPending: true,
                isNextSessionPending: false,
            }),
        ).toBe(true);
    });

    it('clears snapshots when an unused pending tab switches to an existing session', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: PENDING_B,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: PENDING_B,
                wasPreviousSessionPending: true,
                isNextSessionPending: false,
            }),
        ).toBe(false);
    });

    it('clears snapshots on real-to-real session switches', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: SID_A,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: SID_B,
                wasPreviousSessionPending: false,
                isNextSessionPending: false,
            }),
        ).toBe(false);
    });
});

describe('decideSystemInitSessionId', () => {
    it('rejects stale system-init payloads during real-to-real history switches', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        });
    });

    it('accepts pending-session birth system-init and syncs to the concrete id', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: PENDING_B,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: true,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: true,
            shouldSyncSessionId: true,
            isSessionBirth: true,
            reason: 'birth-session',
        });
    });

    it('rejects stale old-session system-init while the tab is on a different pending session', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_A,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: true,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        });
    });

    it('allows explicit reset birth to sync from a pending id to the reset id', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: PENDING_B,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_B,
                expectedBirthSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: true,
                isNewSession: true,
                isResetBirthPending: true,
            }),
        ).toEqual({
            accept: true,
            shouldSyncSessionId: true,
            isSessionBirth: true,
            reason: 'birth-session',
        });
    });

    it('rejects expected reset birth once the tab has moved to another concrete session', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_C,
                currentSessionId: SID_C,
                payloadSessionId: SID_B,
                expectedBirthSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: true,
                isResetBirthPending: true,
            }),
        ).toEqual({
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        });
    });

    it('rejects explicit reset birth when the payload does not match the expected new id', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_A,
                currentSessionId: SID_A,
                payloadSessionId: SID_C,
                expectedBirthSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: true,
                isResetBirthPending: true,
            }),
        ).toEqual({
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        });
    });

    it('accepts null-session launch birth only when no old SSE session is attached', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: null,
                currentSessionId: null,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: true,
            shouldSyncSessionId: true,
            isSessionBirth: true,
            reason: 'birth-session',
        });
    });

    it('rejects null-session system-init when it came from a still-attached old SSE session', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_A,
                currentSessionId: null,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        });
    });

    it('accepts matching concrete session system-init without syncing', () => {
        expect(
            decideSystemInitSessionId({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
                isNewSession: false,
                isResetBirthPending: false,
            }),
        ).toEqual({
            accept: true,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'matching-session',
        });
    });
});

describe('decidePersistedContextUsageSeed', () => {
    it('preserves an already accepted live snapshot for the target session', () => {
        expect(
            decidePersistedContextUsageSeed({
                snapshotSource: 'builtin',
                seedRuntime: 'builtin',
                targetSessionId: SID_B,
                liveSessionId: SID_B,
            }),
        ).toBe('preserve-live');
    });

    it('seeds persisted usage when no live snapshot exists for the target session and runtime matches', () => {
        expect(
            decidePersistedContextUsageSeed({
                snapshotSource: 'builtin',
                seedRuntime: 'builtin',
                targetSessionId: SID_B,
                liveSessionId: null,
            }),
        ).toBe('seed');
    });

    it('does not preserve a live snapshot from a different session', () => {
        expect(
            decidePersistedContextUsageSeed({
                snapshotSource: 'builtin',
                seedRuntime: 'builtin',
                targetSessionId: SID_B,
                liveSessionId: SID_A,
            }),
        ).toBe('seed');
    });

    it('clears persisted usage when no live snapshot exists and runtime mismatches', () => {
        expect(
            decidePersistedContextUsageSeed({
                snapshotSource: 'codex',
                seedRuntime: 'builtin',
                targetSessionId: SID_B,
                liveSessionId: null,
            }),
        ).toBe('clear');
    });
});
