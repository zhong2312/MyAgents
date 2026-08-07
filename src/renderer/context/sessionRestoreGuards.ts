// Pure decision core for coordinating the two history-restore paths in
// TabProvider, extracted so the invariants are unit-testable (Functional Core /
// Imperative Shell). See sessionRestoreGuards.test.ts.
//
// Background (#0608 — "restore drops recent messages"):
//   A chat tab restores history through TWO paths that must not fight:
//     1. REST `/sessions/:id` — reads DISK (authoritative, paginated, ordered).
//        loadSession sets the full first page, then marks the session as
//        REST-restored (`restoredSessionId`).
//     2. SSE `/chat/stream` — on connect sends `chat:init` then replays the
//        sidecar's IN-MEMORY history as `chat:message-replay` events.
//   When both ran for the same session, a late `chat:init` (arriving in the
//   commit window right after loadSession dropped its load guard) wiped the
//   just-restored REST page, and the in-memory replay then refilled it with an
//   older / truncated set — the user's most recent messages disappeared.
//
//   Fix: REST is the single source of truth for history. Once a session is
//   REST-restored, SSE `chat:init` must not clear it and `chat:message-replay`
//   must not re-deliver history (older pages come via `?before=`; the in-flight
//   turn rides REST's liveStreamingMessage + live chunk events). These two pure
//   predicates encode that coordination.

import type { ContentBlock } from '@/types/chat';

export function isRestoreActionBlocked(
    phase: 'inactive' | 'restoring' | 'ready' | 'failed',
): boolean {
    return phase === 'restoring' || phase === 'failed';
}

/**
 * Normalize the persisted wire representation once, before it reaches the
 * visible message projection. Older transcripts may contain a JSON-stringified
 * ContentBlock array; malformed or ordinary strings remain text.
 */
function isContentBlock(value: unknown): value is ContentBlock {
    if (typeof value !== 'object' || value === null) return false;
    const block = value as Record<string, unknown>;
    switch (block.type) {
        case 'text':
            return typeof block.text === 'string';
        case 'thinking':
            return typeof block.thinking === 'string';
        case 'tool_use':
        case 'server_tool_use': {
            if (typeof block.tool !== 'object' || block.tool === null) return false;
            const tool = block.tool as Record<string, unknown>;
            return typeof tool.id === 'string' && typeof tool.name === 'string';
        }
        default:
            return false;
    }
}

export function normalizeSessionMessageContent(
    content: unknown,
): string | ContentBlock[] {
    if (Array.isArray(content)) {
        return content.every(isContentBlock) ? content : JSON.stringify(content);
    }
    if (typeof content !== 'string') return '';
    if (!content.startsWith('[') || !content.includes('"type"')) return content;

    try {
        const parsed = JSON.parse(content) as unknown;
        if (
            Array.isArray(parsed)
            && parsed.every(isContentBlock)
        ) {
            return parsed as ContentBlock[];
        }
    } catch {
        // Persisted plain text is allowed to resemble JSON.
    }
    return content;
}

/**
 * True iff history for `currentSessionId` was already authoritatively restored
 * from disk by loadSession. BOTH ids must be non-null AND equal — a null
 * `restoredSessionId` means "never REST-restored", and two nulls must NOT be
 * treated as a match (that would mis-handle the first-ever, no-session state).
 */
export function isRestoredSession(
    restoredSessionId: string | null,
    currentSessionId: string | null,
): boolean {
    return restoredSessionId !== null && restoredSessionId === currentSessionId;
}

/**
 * Live turn events may be emitted by a server owner that bypasses the
 * renderer's send path. A stamped event is accepted only for the currently
 * attached session. Legacy unmarked events remain compatible with established
 * sessions, but cannot end a new-session stale-event window.
 */
export function shouldAcceptLiveTurnEvent(p: {
    isNewSession: boolean;
    payloadSessionId: string | null;
    isCurrentSessionScope: boolean;
}): boolean {
    if (p.payloadSessionId) return p.isCurrentSessionScope;
    return !p.isNewSession;
}

/**
 * Whether an SSE `chat:message-replay` event should be skipped.
 *
 * `chat:message-replay` is OVERLOADED (Codex review of #0608): the SSE-connect
 * backfill replays the whole in-memory transcript with `replayKind:
 * 'cold-history'`, but the SAME event also carries session-stamped LIVE echoes
 * of a freshly-sent user / command bubble. Only the cold-history backfill yields
 * to a REST-restored session — REST owns the ordered, paginated history, and
 * re-delivering the in-memory set on top of a partial REST page reorders /
 * truncates it. A LIVE echo must ALWAYS render, otherwise a new user message
 * sent after a restore disappears from the UI while the assistant streams.
 *
 * Reset-session birth has one extra transient: `/chat/reset` can synchronize
 * the renderer/Rust to the freshly minted backend id before the later
 * `chat:system-init` confirms it. During that window, only replay stamped for
 * the current Session may cross the birth guard. This includes cold history
 * from a physical reconnect; REST-restored sessions still reject cold history.
 */
export function shouldSkipHistoryReplay(p: {
    isNewSession: boolean;
    isLoadingSession: boolean;
    isColdHistoryReplay: boolean;
    isCurrentSessionReplay?: boolean;
    isResetBirthPending?: boolean;
    restoredSessionId: string | null;
    currentSessionId: string | null;
}): boolean {
    if (p.isLoadingSession) return true;
    if (p.isNewSession && !p.isCurrentSessionReplay) return true;
    if (p.isColdHistoryReplay && p.isResetBirthPending && !p.isCurrentSessionReplay) return true;
    return (
        p.isColdHistoryReplay &&
        isRestoredSession(p.restoredSessionId, p.currentSessionId)
    );
}

/**
 * Whether an SSE `chat:init` should clear local history. Only when no load is in
 * flight, nothing is on screen yet, AND the session hasn't been REST-restored.
 * The REST-restored check is the load-bearing guard: it stays correct even when
 * `historyLength` (read from a commit-lagging ref mirror) momentarily reports 0
 * right after loadSession set the page — preventing the #0608 wipe.
 */
export function shouldClearHistoryOnInit(p: {
    isLoadingSession: boolean;
    historyLength: number;
    restoredSessionId: string | null;
    currentSessionId: string | null;
}): boolean {
    return (
        !p.isLoadingSession &&
        p.historyLength === 0 &&
        !isRestoredSession(p.restoredSessionId, p.currentSessionId)
    );
}

/**
 * Idempotent history append for replay/sync paths. The ref-level seen-id guard
 * catches most duplicate bursts before scheduling React work; this updater-level
 * guard is the final boundary because it checks against the actual committed
 * history array.
 */
export function appendUniqueMessageById<T extends { id: string }>(
    messages: T[],
    message: T,
): T[] {
    return messages.some(existing => existing.id === message.id)
        ? messages
        : [...messages, message];
}

export function upsertMessageById<T extends { id: string }>(
    messages: T[],
    message: T,
): T[] {
    const idx = messages.findIndex(existing => existing.id === message.id);
    if (idx === -1) return [...messages, message];
    if (messages[idx] === message) return messages;
    const next = [...messages];
    next[idx] = message;
    return next;
}

export function updateMessageById<T extends { id: string }>(
    messages: T[],
    id: string | null | undefined,
    update: (message: T) => T,
): T[] {
    if (!id) return messages;
    const idx = messages.findIndex(existing => existing.id === id);
    if (idx === -1) return messages;
    const updated = update(messages[idx]);
    if (updated === messages[idx]) return messages;
    const next = [...messages];
    next[idx] = updated;
    return next;
}

/**
 * Replace the authoritative recent tail from a live REST snapshot while
 * preserving older pages that were already paginated into the viewport.
 * If the two views do not overlap, fail closed to the snapshot instead of
 * guessing an ordering relationship.
 */
export function reconcileLiveRecoveryHistory<T extends { id: string }>(
    current: T[],
    snapshot: T[],
): { messages: T[]; hasOverlap: boolean } {
    if (snapshot.length === 0) {
        return { messages: [], hasOverlap: false };
    }

    const overlapIndex = current.findIndex(message => message.id === snapshot[0].id);
    if (overlapIndex < 0) {
        return { messages: snapshot, hasOverlap: false };
    }

    return {
        messages: [...current.slice(0, overlapIndex), ...snapshot],
        hasOverlap: true,
    };
}
