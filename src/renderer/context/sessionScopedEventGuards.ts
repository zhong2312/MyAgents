import type { SessionState } from './TabContext';

export type SessionActivityDecision = 'active' | 'terminal' | 'none';

/**
 * Turn activity is authoritative only when it comes from a backend session
 * state snapshot (`chat:status` or REST liveSessionState). Runtime/system init
 * metadata must never infer activity.
 */
export function classifySessionActivity(sessionState: SessionState): SessionActivityDecision {
    if (sessionState === 'starting' || sessionState === 'running') return 'active';
    if (sessionState === 'idle' || sessionState === 'error') return 'terminal';
    return 'none';
}

/**
 * Pure guard for session-scoped SSE snapshots.
 *
 * A Tab can switch Session identity while an SSE stream is still draining
 * cached/live events. The event's captured Session id is the business scope;
 * the connection label is only a transport attachment hint and may legitimately
 * lag during a same-Sidecar reset/migration handover.
 *
 * Concrete current sessions therefore accept only matching stamped payloads,
 * even if the stream was attached under the previous Session key. Pending and
 * legacy unscoped paths retain the stricter attachment checks below.
 */
export function shouldAcceptSessionScopedSseSnapshot(p: {
    connectedSessionId: string | null;
    currentSessionId: string | null;
    payloadSessionId?: string | null;
    isConnectedSessionPending: boolean;
    isCurrentSessionPending: boolean;
}): boolean {
    if (
        p.payloadSessionId &&
        p.currentSessionId &&
        !p.isCurrentSessionPending
    ) {
        return p.payloadSessionId === p.currentSessionId;
    }

    const isBootstrappingCurrentSession =
        p.connectedSessionId === null &&
        p.currentSessionId !== null &&
        !p.isCurrentSessionPending &&
        p.payloadSessionId === p.currentSessionId;

    const isSameAttachedSession =
        isBootstrappingCurrentSession ||
        p.connectedSessionId === p.currentSessionId ||
        (
            p.isConnectedSessionPending &&
            !p.isCurrentSessionPending &&
            p.payloadSessionId === p.currentSessionId
        );

    if (!isSameAttachedSession) {
        return false;
    }

    if (
        p.payloadSessionId &&
        p.currentSessionId &&
        !p.isCurrentSessionPending &&
        p.payloadSessionId !== p.currentSessionId
    ) {
        return false;
    }

    return true;
}

export type SystemInitSessionIdDecision = {
    accept: boolean;
    shouldSyncSessionId: boolean;
    isSessionBirth: boolean;
    reason: 'no-payload-session' | 'matching-session' | 'birth-session' | 'stale-session-mismatch';
};

/**
 * `chat:system-init` is both a session-birth signal and a session-scoped
 * runtime snapshot. It may change the tab's session id only for birth paths
 * (pending/null/reset → concrete id). Existing history switches already chose a
 * target session before reconnecting SSE; a mismatched system-init there is a
 * stale pre-warm/runtime snapshot from the previous session and must not pull
 * the tab back.
 */
export function decideSystemInitSessionId(p: {
    connectedSessionId: string | null;
    currentSessionId: string | null;
    payloadSessionId?: string | null;
    expectedBirthSessionId?: string | null;
    isConnectedSessionPending: boolean;
    isCurrentSessionPending: boolean;
    isNewSession: boolean;
    isResetBirthPending: boolean;
}): SystemInitSessionIdDecision {
    const payloadSessionId = p.payloadSessionId ?? null;
    if (!payloadSessionId) {
        return {
            accept: true,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'no-payload-session',
        };
    }

    const isBirthCandidate =
        p.isNewSession ||
        p.isResetBirthPending ||
        p.currentSessionId === null ||
        p.isCurrentSessionPending;

    if (p.currentSessionId === payloadSessionId) {
        const accept = shouldAcceptSessionScopedSseSnapshot({
            connectedSessionId: p.connectedSessionId,
            currentSessionId: p.currentSessionId,
            payloadSessionId,
            isConnectedSessionPending: p.isConnectedSessionPending,
            isCurrentSessionPending: p.isCurrentSessionPending,
        });
        return {
            accept,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: accept ? 'matching-session' : 'stale-session-mismatch',
        };
    }

    if (!isBirthCandidate) {
        return {
            accept: false,
            shouldSyncSessionId: false,
            isSessionBirth: false,
            reason: 'stale-session-mismatch',
        };
    }

    const matchesExpectedBirth =
        !p.expectedBirthSessionId ||
        p.expectedBirthSessionId === payloadSessionId;
    const birthStillOwnsTab =
        !p.expectedBirthSessionId ||
        p.currentSessionId === p.expectedBirthSessionId ||
        p.currentSessionId === null ||
        p.isCurrentSessionPending;

    const scopedBirth = matchesExpectedBirth && birthStillOwnsTab && (
        p.isNewSession ||
        p.isResetBirthPending ||
        (p.currentSessionId === null && p.connectedSessionId === null) ||
        shouldAcceptSessionScopedSseSnapshot({
            connectedSessionId: p.connectedSessionId,
            currentSessionId: p.currentSessionId,
            payloadSessionId,
            isConnectedSessionPending: p.isConnectedSessionPending,
            isCurrentSessionPending: p.isCurrentSessionPending,
        })
    );

    return {
        accept: scopedBirth,
        shouldSyncSessionId: scopedBirth,
        isSessionBirth: scopedBirth,
        reason: scopedBirth ? 'birth-session' : 'stale-session-mismatch',
    };
}

/**
 * Session-scoped snapshots are normally cleared whenever the session prop
 * changes. Preserve them only when the component has already adopted the
 * concrete session id internally, and the parent prop is merely catching up
 * from the pending placeholder for the same just-born session.
 */
export function shouldPreserveSnapshotOnPendingBirthPropSync(p: {
    previousSessionId: string | null;
    nextSessionId: string | null;
    currentSessionIdBeforeSync: string | null;
    wasPreviousSessionPending: boolean;
    isNextSessionPending: boolean;
}): boolean {
    return (
        p.previousSessionId !== null &&
        p.nextSessionId !== null &&
        p.wasPreviousSessionPending &&
        !p.isNextSessionPending &&
        p.currentSessionIdBeforeSync === p.nextSessionId
    );
}

export type PersistedContextUsageSeedDecision = 'seed' | 'clear' | 'preserve-live';

export function decidePersistedContextUsageSeed(p: {
    snapshotSource: string | null | undefined;
    seedRuntime: string;
    targetSessionId: string;
    liveSessionId: string | null;
}): PersistedContextUsageSeedDecision {
    if (p.liveSessionId === p.targetSessionId) {
        return 'preserve-live';
    }
    return p.snapshotSource === p.seedRuntime ? 'seed' : 'clear';
}
