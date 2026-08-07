import { describe, it, expect } from 'vitest';
import {
    isRestoredSession,
    isRestoreActionBlocked,
    shouldAcceptLiveTurnEvent,
    shouldSkipHistoryReplay,
    shouldClearHistoryOnInit,
    appendUniqueMessageById,
    upsertMessageById,
    updateMessageById,
    reconcileLiveRecoveryHistory,
    normalizeSessionMessageContent,
} from './sessionRestoreGuards';

const SID = 'e959f73c-42af-4fb6-9c50-4b9c589ee975';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('normalizeSessionMessageContent', () => {
    it('preserves structured blocks and parses their persisted JSON representation', () => {
        const blocks = [{ type: 'text' as const, text: '**rendered once**' }];
        expect(normalizeSessionMessageContent(blocks)).toBe(blocks);
        expect(normalizeSessionMessageContent(JSON.stringify(blocks))).toEqual(blocks);
    });

    it('leaves plain and malformed JSON-looking strings as text', () => {
        expect(normalizeSessionMessageContent('**plain markdown**')).toBe('**plain markdown**');
        expect(normalizeSessionMessageContent('[{"type":')).toBe('[{"type":');
        expect(normalizeSessionMessageContent('[{"value":1}]')).toBe('[{"value":1}]');
    });

    it('keeps malformed or unknown block arrays visible as text', () => {
        const missingText = '[{"type":"text"}]';
        const unknown = '[{"type":"not-a-block","value":"hello"}]';
        expect(normalizeSessionMessageContent(missingText)).toBe(missingText);
        expect(normalizeSessionMessageContent(unknown)).toBe(unknown);
        expect(normalizeSessionMessageContent([{ type: 'thinking' }])).toBe('[{"type":"thinking"}]');
    });
});

describe('isRestoredSession', () => {
    it('matches only when both ids are non-null and equal', () => {
        expect(isRestoredSession(SID, SID)).toBe(true);
        expect(isRestoredSession(SID, OTHER)).toBe(false);
        expect(isRestoredSession(null, SID)).toBe(false);
        expect(isRestoredSession(SID, null)).toBe(false);
        // Two nulls must NOT be a match — that is the first-ever / no-session state.
        expect(isRestoredSession(null, null)).toBe(false);
    });
});

describe('isRestoreActionBlocked', () => {
    it('blocks every mutation surface while history authority is restoring or failed', () => {
        expect(isRestoreActionBlocked('restoring')).toBe(true);
        expect(isRestoreActionBlocked('failed')).toBe(true);
        expect(isRestoreActionBlocked('inactive')).toBe(false);
        expect(isRestoreActionBlocked('ready')).toBe(false);
    });
});

describe('shouldSkipHistoryReplay', () => {
    it('skips COLD-HISTORY replay once the session is REST-restored (the #0608 fix)', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });

    it('does NOT skip a LIVE echo (freshly-sent user bubble) on a REST-restored session', () => {
        // #0608 Codex-review blocker: chat:message-replay is overloaded — a newly
        // sent user/command bubble echoes on the SAME event as a live-user-echo. It
        // is the authoritative render path for the bubble and MUST NOT be suppressed,
        // else new messages vanish from the UI after a restore.
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT skip cold-history for a session that was never REST-restored (SSE-only)', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT skip cold-history when a different session was restored', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: OTHER,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('skips ANY replay while loadSession REST fetch is in flight', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: true,
                isColdHistoryReplay: false,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });

    it('skips ANY replay while a new session is being born', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: true,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                isCurrentSessionReplay: false,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });

    it('accepts the current session live-user echo as the new-turn boundary', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: true,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                isCurrentSessionReplay: true,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('accepts scoped reset-birth cold-history without suppressing the live user echo', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                isCurrentSessionReplay: true,
                isResetBirthPending: true,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);

        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                isResetBirthPending: true,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });
});

describe('shouldAcceptLiveTurnEvent', () => {
    it('accepts a session-stamped event only for the current Tab session', () => {
        expect(shouldAcceptLiveTurnEvent({
            isNewSession: true,
            payloadSessionId: SID,
            isCurrentSessionScope: true,
        })).toBe(true);
        expect(shouldAcceptLiveTurnEvent({
            isNewSession: false,
            payloadSessionId: OTHER,
            isCurrentSessionScope: false,
        })).toBe(false);
    });

    it('keeps legacy unmarked events out of a new-session birth window', () => {
        expect(shouldAcceptLiveTurnEvent({
            isNewSession: true,
            payloadSessionId: null,
            isCurrentSessionScope: false,
        })).toBe(false);
        expect(shouldAcceptLiveTurnEvent({
            isNewSession: false,
            payloadSessionId: null,
            isCurrentSessionScope: false,
        })).toBe(true);
    });
});

describe('shouldClearHistoryOnInit', () => {
    it('does NOT clear a REST-restored session even if the history ref still reads 0', () => {
        // The exact #0608 race: loadSession just set the page, but historyMessagesRef
        // (commit-lagging mirror) momentarily reports 0 when a late chat:init arrives.
        // The REST-restored guard must keep the page on screen.
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('clears on first-ever chat:init with no session and no history (legit no-op clear)', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: null,
                currentSessionId: null,
            }),
        ).toBe(true);
    });

    it('does NOT clear while loadSession is in flight', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: true,
                historyLength: 0,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT clear when history is already on screen', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 80,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('clears a backend-initiated auto-reset that emptied a non-restored session', () => {
        // chat:init for a session that was reset backend-side (not REST-restored,
        // nothing on screen) is the one case the clear is still correct.
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: OTHER,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });
});

describe('appendUniqueMessageById', () => {
    it('appends a replay message whose backend id is not already in history', () => {
        const existing = [{ id: 'user-1', role: 'user' }];
        const next = { id: 'assistant-42', role: 'assistant' };

        expect(appendUniqueMessageById(existing, next)).toEqual([...existing, next]);
    });

    it('returns the original history array when replay repeats an existing backend id', () => {
        const existing = [
            { id: 'user-1', role: 'user' },
            { id: 'assistant-42', role: 'assistant' },
        ];

        const result = appendUniqueMessageById(existing, {
            id: 'assistant-42',
            role: 'assistant',
        });

        expect(result).toBe(existing);
    });
});

describe('upsertMessageById', () => {
    it('reconciles a final streaming assistant over an existing backend-id history row', () => {
        const existing = [
            { id: 'user-1', content: 'hello' },
            { id: 'assistant-42', content: 'partial' },
        ];
        const finalAssistant = { id: 'assistant-42', content: 'partial plus final suffix' };

        expect(upsertMessageById(existing, finalAssistant)).toEqual([
            existing[0],
            finalAssistant,
        ]);
    });

    it('appends when the id is new', () => {
        const existing = [{ id: 'user-1', content: 'hello' }];
        const finalAssistant = { id: 'assistant-42', content: 'done' };

        expect(upsertMessageById(existing, finalAssistant)).toEqual([
            existing[0],
            finalAssistant,
        ]);
    });
});

describe('updateMessageById', () => {
    it('patches an existing backend-id row when completion arrives without a live streaming row', () => {
        const existing = [
            { id: 'user-1', usage: 0 },
            { id: 'assistant-42', usage: 0 },
        ];

        expect(updateMessageById(existing, 'assistant-42', message => ({ ...message, usage: 12 }))).toEqual([
            existing[0],
            { id: 'assistant-42', usage: 12 },
        ]);
    });

    it('returns the original array when the target id is absent', () => {
        const existing = [{ id: 'user-1', usage: 0 }];

        expect(updateMessageById(existing, 'assistant-42', message => ({ ...message, usage: 12 }))).toBe(existing);
    });
});

describe('reconcileLiveRecoveryHistory', () => {
    it('preserves paginated older rows and replaces the overlapping recent tail', () => {
        const current = [
            { id: 'old-1', value: 'old' },
            { id: 'old-2', value: 'old' },
            { id: 'tail-1', value: 'stale' },
            { id: 'tail-2', value: 'stale' },
        ];
        const snapshot = [
            { id: 'tail-1', value: 'authoritative' },
            { id: 'tail-2', value: 'authoritative' },
            { id: 'tail-3', value: 'new' },
        ];

        expect(reconcileLiveRecoveryHistory(current, snapshot)).toEqual({
            messages: [current[0], current[1], ...snapshot],
            hasOverlap: true,
        });
    });

    it('fails closed to the snapshot when there is no overlap', () => {
        const snapshot = [{ id: 'new-1' }, { id: 'new-2' }];
        expect(reconcileLiveRecoveryHistory([{ id: 'stale-1' }], snapshot)).toEqual({
            messages: snapshot,
            hasOverlap: false,
        });
    });

    it('reports overlap even when the snapshot starts at the current first row', () => {
        const snapshot = [{ id: 'tail-1', value: 'authoritative' }];
        expect(reconcileLiveRecoveryHistory([{ id: 'tail-1', value: 'stale' }], snapshot)).toEqual({
            messages: snapshot,
            hasOverlap: true,
        });
    });

    it('accepts an authoritative empty snapshot', () => {
        expect(reconcileLiveRecoveryHistory([{ id: 'stale-1' }], [])).toEqual({
            messages: [],
            hasOverlap: false,
        });
    });
});
