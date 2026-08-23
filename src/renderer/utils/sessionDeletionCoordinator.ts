import type { BackgroundCompletionResult, SessionDeleteResult } from '@/api/tauriClient';
import type { Tab } from '@/types/tab';

interface SessionDeletionCoordinatorInput {
    sessionId: string;
    getTabs: () => readonly Tab[];
    terminateTabsForSession: (sessionId: string) => void;
    hasPersistentOwners: (sessionId: string) => Promise<boolean>;
    handoffMountedSessionActivity: (sessionId: string) => Promise<BackgroundCompletionResult>;
    stopSseProxy: (tabId: string) => Promise<unknown>;
    deletePersistedSession: (sessionId: string, releasableTabIds: readonly string[]) => Promise<SessionDeleteResult>;
}

export type SessionResourceTransition = 'opening' | 'deleting';
export type SessionResourceTransitionClaim = {
    transition: SessionResourceTransition;
    ownerId?: string;
    holders: number;
};

export type SessionResourceTransitionState = {
    claims: Map<string, SessionResourceTransitionClaim>;
    openingRevision: number;
};

export function createSessionResourceTransitionState(): SessionResourceTransitionState {
    return { claims: new Map(), openingRevision: 0 };
}

/** True while App is materializing a new owner for this fixed Session identity. */
export function isSessionOpening(
    state: SessionResourceTransitionState,
    sessionId: string,
): boolean {
    return state.claims.get(sessionId)?.transition === 'opening';
}

/**
 * Synchronous App-level admission for operations that can create or destroy a
 * mounted Session. JavaScript runs this check-and-set without an await gap, so
 * an open cannot register after deletion has snapshotted the mounted Tabs (and
 * vice versa). The returned release only clears its own claim.
 */
export function tryClaimSessionResourceTransition(
    state: SessionResourceTransitionState,
    sessionId: string,
    transition: SessionResourceTransition,
    ownerId?: string,
): (() => void) | null {
    const existing = state.claims.get(sessionId);
    if (existing) {
        if (
            transition === 'opening'
            && existing.transition === 'opening'
            && ownerId !== undefined
            && existing.ownerId === ownerId
        ) {
            existing.holders += 1;
            let released = false;
            return () => {
                if (released || state.claims.get(sessionId) !== existing) return;
                released = true;
                existing.holders -= 1;
                if (existing.holders === 0) {
                    state.claims.delete(sessionId);
                }
            };
        }
        return null;
    }
    const claim = {
        transition,
        ...(ownerId !== undefined ? { ownerId } : {}),
        holders: 1,
    };
    if (transition === 'opening') {
        state.openingRevision += 1;
    }
    state.claims.set(sessionId, claim);
    let released = false;
    return () => {
        if (released || state.claims.get(sessionId) !== claim) return;
        released = true;
        claim.holders -= 1;
        if (claim.holders === 0) {
            state.claims.delete(sessionId);
        }
    };
}

/**
 * App-owned lifecycle transition for user Session deletion.
 *
 * A Session row is a projection over both persisted history and any mounted
 * Tabs. Storage deletion must therefore happen only after App has unmounted
 * every matching Chat surface and Rust has observed every Tab owner release.
 * Persistent Task/Goal/Agent/background owners remain authoritative in Rust
 * and are never released as a side effect of deleting history.
 */
export async function deleteSessionThroughAppOwner({
    sessionId,
    getTabs,
    terminateTabsForSession,
    hasPersistentOwners,
    handoffMountedSessionActivity,
    stopSseProxy,
    deletePersistedSession,
}: SessionDeletionCoordinatorInput): Promise<SessionDeleteResult> {
    const hasMountedTab = getTabs()
        .some((tab) => tab.view === 'chat' && tab.sessionId === sessionId);

    // Rust repeats the same predicate under the deletion lifecycle lock. This
    // preflight is only to preserve mounted Tabs when refusal is already known;
    // it never grants permission to mutate storage.
    if (await hasPersistentOwners(sessionId)) {
        return { deleted: false, reason: 'in-use' };
    }

    if (hasMountedTab) {
        // Renderer activity flags are projections. Ask Rust to either attach a
        // BackgroundCompletion owner or authoritatively confirm idle before
        // releasing the last mounted Tab. The strict call preserves errors.
        let activity: BackgroundCompletionResult;
        try {
            activity = await handoffMountedSessionActivity(sessionId);
        } catch (error) {
            console.error(`[session-delete] Failed to check activity for ${sessionId}:`, error);
            return { deleted: false, reason: 'activity-unavailable' };
        }
        if (activity.started) {
            return { deleted: false, reason: 'in-use' };
        }
    }

    // Other Sessions are allowed to open and close while this Session's
    // preflight awaits Rust. Read the owner IDs only now, and terminate through
    // a functional App update so an old full-array snapshot cannot overwrite
    // unrelated Tab changes.
    const ownerTabIds = getTabs()
        .filter((tab) => tab.view === 'chat' && tab.sessionId === sessionId)
        .map((tab) => tab.id);

    // Rust validates that these are the only remaining live owners, deletes
    // storage, and releases them under one lifecycle fence. A refusal therefore
    // leaves both the mounted Tabs and their owners intact; no rollback path is
    // needed in the renderer.
    const result = await deletePersistedSession(sessionId, ownerTabIds);
    if (!result.deleted && result.reason !== 'not-found') {
        return result;
    }

    if (ownerTabIds.length > 0) {
        terminateTabsForSession(sessionId);
        await Promise.allSettled(ownerTabIds.map(async (tabId) => {
            try {
                await stopSseProxy(tabId);
            } catch (error) {
                console.warn(`[session-delete] Failed to stop SSE proxy for Tab ${tabId}:`, error);
            }
        }));
    }

    return { deleted: true };
}
