/**
 * Issue #336 — deleteSession vs live-sidecar persist race.
 *
 * Artifact state in the wild: a session's sessions.json entry is GONE while its
 * full JSONL sits on disk (10MB / 221 messages in the report). Root cause:
 * deleteSession removes the index entry + unlinks the JSONL, but a live sidecar
 * still holding the session in memory persists afterwards — the old cumulative saver
 * saw existsSync=false → existingCount=0 → re-appended the ENTIRE in-memory
 * array, resurrecting the file as an invisible orphan no UI can reach.
 *
 * The fix enforces the index⟺data invariant at the single point that creates
 * JSONL files: cursor append refuses a WOULD-CREATE write when the session
 * has no sessions.json entry. Appends to an EXISTING unindexed file stay allowed
 * (legacy orphans keep accumulating their data rather than losing it).
 *
 * HOME is redirected to a temp dir BEFORE a fresh (vi.resetModules) dynamic
 * import of SessionStore, so the module-level ~/.myagents paths bind to the
 * sandbox. A guard test asserts the binding before anything destructive runs.
 */

import { mkdtempSync, rmSync, existsSync, linkSync, readFileSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type SessionStoreModule = typeof import('../SessionStore');
type SessionMetadata = import('../types/session').SessionMetadata;

let home: string;
let store: SessionStoreModule;
let originalHome: string | undefined;

const sessionsDir = () => join(home, '.myagents', 'sessions');
const sessionsJson = () => join(home, '.myagents', 'sessions.json');
const sessionsTmpJson = () => join(home, '.myagents', 'sessions.json.tmp');
const jsonlPath = (id: string) => join(sessionsDir(), `${id}.jsonl`);

function msg(id: number) {
    return {
        id: String(id),
        role: 'user' as const,
        content: `message ${id}`,
        timestamp: new Date().toISOString(),
    };
}

function sessionMeta(id: string, agentDir: string): SessionMetadata {
    return {
        id,
        agentDir,
        title: `Recovered ${id.slice(0, 4)}`,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        unifiedSession: true,
        runtime: 'builtin',
    };
}

async function appendAll(sessionId: string, messages: ReturnType<typeof msg>[]) {
    const snapshot = await store.loadSessionTranscript(sessionId);
    return store.appendSessionMessages(
        sessionId,
        snapshot.cursor,
        messages.slice(snapshot.cursor.persistedMessageCount),
    );
}

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'myagents-336-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    store = await import('../SessionStore');
});

afterAll(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
});

describe('issue #336 — delete vs persist resurrection', () => {
    it('sandbox guard: SessionStore is bound to the temp HOME', async () => {
        const meta = await store.createSession('/tmp/workspace-a');
        // The entry must land in the sandbox sessions.json — if this fails the
        // module bound to the real home dir and NOTHING below may run.
        expect(existsSync(sessionsJson())).toBe(true);
        const all = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(all.some(s => s.id === meta.id)).toBe(true);
    });

    it('backs up a corrupt sessions.json before creating metadata for a new session', async () => {
        writeFileSync(sessionsJson(), '{"truncated"', 'utf-8');

        const meta = await store.createSession('/tmp/workspace-corrupt');
        const recovered = store.getSessionMetadata(meta.id);
        expect(recovered?.id).toBe(meta.id);

        const backupNames = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-'));
        expect(backupNames.length).toBeGreaterThan(0);
        expect(readFileSync(join(home, '.myagents', backupNames[0]), 'utf-8')).toBe('{"truncated"');

        const persistResult = await appendAll(meta.id, [msg(10)]);
        expect(persistResult.ok).toBe(true);
        expect(existsSync(jsonlPath(meta.id))).toBe(true);
    });

    it('treats a durable transcript append as success when only derived stats fail', async () => {
        const meta = await store.createSession('/tmp/workspace-stats-failure');
        mkdirSync(sessionsTmpJson());

        try {
            const result = await appendAll(meta.id, [msg(11)]);

            expect(result).toMatchObject({
                ok: true,
                action: 'appended',
                count: 1,
            });
            expect(readFileSync(jsonlPath(meta.id), 'utf-8')).toContain('message 11');
        } finally {
            rmSync(sessionsTmpJson(), { recursive: true, force: true });
        }
    });

    it('salvages valid metadata from a malformed sessions.json array before metadata creation', async () => {
        const beforeBackups = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-')).length;
        const preserved = sessionMeta('22222222-2222-2222-2222-222222222222', '/tmp/workspace-preserved-malformed');
        writeFileSync(sessionsJson(), JSON.stringify([preserved, null], null, 2), 'utf-8');
        expect(store.getSessionMetadata(preserved.id)?.id).toBe(preserved.id);

        const meta = await store.createSession('/tmp/workspace-malformed');
        expect(store.getSessionMetadata(meta.id)?.id).toBe(meta.id);
        expect(store.getSessionMetadata(preserved.id)?.id).toBe(preserved.id);

        const backupNames = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-'));
        expect(backupNames.length).toBe(beforeBackups + 1);
        const latestBackup = backupNames.sort().at(-1);
        expect(latestBackup).toBeTruthy();
        expect(readFileSync(join(home, '.myagents', latestBackup!), 'utf-8')).toContain(preserved.id);

        const repaired = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(repaired.some(s => s.id === preserved.id)).toBe(true);
        expect(repaired.some(s => s.id === meta.id)).toBe(true);
    });

    it('salvages complete metadata objects from truncated sessions.json before metadata creation', async () => {
        const beforeBackups = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-')).length;
        const preserved = sessionMeta('33333333-3333-3333-3333-333333333333', '/tmp/workspace-preserved-truncated');
        const corruptContent = `[\n${JSON.stringify(preserved, null, 2)},\n{"id":`;
        writeFileSync(sessionsJson(), corruptContent, 'utf-8');
        expect(store.getSessionMetadata(preserved.id)?.id).toBe(preserved.id);

        const meta = await store.createSession('/tmp/workspace-truncated');
        expect(store.getSessionMetadata(meta.id)?.id).toBe(meta.id);
        expect(store.getSessionMetadata(preserved.id)?.id).toBe(preserved.id);

        const backupNames = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-'));
        expect(backupNames.length).toBe(beforeBackups + 1);
        const latestBackup = backupNames.sort().at(-1);
        expect(latestBackup).toBeTruthy();
        expect(readFileSync(join(home, '.myagents', latestBackup!), 'utf-8')).toBe(corruptContent);

        const repaired = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(repaired.some(s => s.id === preserved.id)).toBe(true);
        expect(repaired.some(s => s.id === meta.id)).toBe(true);
    });

    it('writes a repaired index even when the metadata operation is a no-op', async () => {
        const beforeBackups = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-')).length;
        const preserved = sessionMeta('44444444-4444-4444-4444-444444444444', '/tmp/workspace-preserved-noop');
        writeFileSync(sessionsJson(), JSON.stringify([preserved, null], null, 2), 'utf-8');

        const deletion = await store.deleteSession(
            '55555555-5555-5555-5555-555555555555',
            { kind: 'user-delete' },
        );
        expect(deletion).toEqual({ deleted: false, reason: 'not-found' });

        const backupNames = readdirSync(join(home, '.myagents'))
            .filter(name => name.startsWith('sessions.json.corrupt-'));
        expect(backupNames.length).toBe(beforeBackups + 1);
        expect(existsSync(sessionsJson())).toBe(true);
        const repaired = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(repaired).toHaveLength(1);
        expect(repaired[0]?.id).toBe(preserved.id);
    });

    it('ignores stale sessions.json.tmp when repairing a corrupt index', async () => {
        const stale = sessionMeta('66666666-6666-6666-6666-666666666666', '/tmp/workspace-stale-tmp');
        writeFileSync(sessionsTmpJson(), JSON.stringify([stale], null, 2), 'utf-8');
        writeFileSync(sessionsJson(), '{"newer-corrupt"', 'utf-8');
        const oldDate = new Date('2026-01-01T00:00:00.000Z');
        const newerDate = new Date('2026-01-02T00:00:00.000Z');
        utimesSync(sessionsTmpJson(), oldDate, oldDate);
        utimesSync(sessionsJson(), newerDate, newerDate);

        const meta = await store.createSession('/tmp/workspace-ignore-stale-tmp');

        expect(store.getSessionMetadata(meta.id)?.id).toBe(meta.id);
        expect(store.getSessionMetadata(stale.id)).toBeNull();
        const repaired = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(repaired.some(s => s.id === stale.id)).toBe(false);
    });

    it('prefers a valid newer sessions.json.tmp over partial structural salvage', async () => {
        const partial = sessionMeta('77777777-7777-7777-7777-777777777777', '/tmp/workspace-partial-main');
        const tmpOnly = sessionMeta('88888888-8888-8888-8888-888888888888', '/tmp/workspace-newer-tmp');
        writeFileSync(sessionsJson(), `[\n${JSON.stringify(partial, null, 2)},\n{"id":`, 'utf-8');
        writeFileSync(sessionsTmpJson(), JSON.stringify([partial, tmpOnly], null, 2), 'utf-8');
        const olderDate = new Date('2026-01-01T00:00:00.000Z');
        const newerDate = new Date('2026-01-02T00:00:00.000Z');
        utimesSync(sessionsJson(), olderDate, olderDate);
        utimesSync(sessionsTmpJson(), newerDate, newerDate);

        const meta = await store.createSession('/tmp/workspace-prefer-newer-tmp');

        expect(store.getSessionMetadata(meta.id)?.id).toBe(meta.id);
        expect(store.getSessionMetadata(tmpOnly.id)?.id).toBe(tmpOnly.id);
        const repaired = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(repaired.some(s => s.id === partial.id)).toBe(true);
        expect(repaired.some(s => s.id === tmpOnly.id)).toBe(true);
        expect(repaired.some(s => s.id === meta.id)).toBe(true);
    });

    it('a post-delete persist must NOT resurrect the JSONL (the #336 race)', async () => {
        const meta = await store.createSession('/tmp/workspace-a');
        const history = [msg(0), msg(1)];
        const initialSave = await appendAll(meta.id, history);
        expect(initialSave.ok).toBe(true);
        expect(existsSync(jsonlPath(meta.id))).toBe(true);

        const deletion = await store.deleteSession(meta.id, { kind: 'user-delete' });
        expect(deletion).toEqual({ deleted: true });
        expect(existsSync(jsonlPath(meta.id))).toBe(false);
        expect(store.getSessionMetadata(meta.id)).toBeNull();

        // Simulate the live owner sidecar persisting its in-memory array after
        // the delete (resetSession's "persist before clearing" / turn complete).
        const postDeleteSave = await appendAll(meta.id, [...history, msg(2)]);
        expect(postDeleteSave.ok).toBe(false);
        if (!postDeleteSave.ok) {
            expect(postDeleteSave.reason).toBe('unindexed-create-refused');
        }

        // Old code: the file is re-created with ALL messages (full orphan).
        expect(existsSync(jsonlPath(meta.id))).toBe(false);
        const all = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(all.some(s => s.id === meta.id)).toBe(false);
    });

    it('refuses to CREATE a JSONL for a never-registered session id', async () => {
        const ghostId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const result = await appendAll(ghostId, [msg(0)]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('unindexed-create-refused');
        }
        expect(existsSync(jsonlPath(ghostId))).toBe(false);
    });

    it('still appends to an EXISTING unindexed file (legacy orphan keeps its data)', async () => {
        const orphanId = '11111111-2222-3333-4444-555555555555';
        mkdirSync(sessionsDir(), { recursive: true });
        writeFileSync(jsonlPath(orphanId), JSON.stringify(msg(0)) + '\n', 'utf-8');

        const result = await appendAll(orphanId, [msg(0), msg(1)]);
        expect(result.ok).toBe(true);

        const lines = readFileSync(jsonlPath(orphanId), 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });

    it('only a named destructive mutation may replace durable rows', async () => {
        const meta = await store.createSession('/tmp/workspace-explicit-mutation');
        const original = [msg(0), msg(1)];
        expect((await appendAll(meta.id, original)).ok).toBe(true);
        const snapshot = await store.loadSessionTranscript(meta.id);

        const result = await store.mutateSessionTranscript(meta.id, snapshot.cursor, {
            kind: 'builtin-admission-rollback',
            messageId: original[1].id,
        });

        expect(result).toMatchObject({ ok: true, action: 'replaced' });
        const stored = readFileSync(jsonlPath(meta.id), 'utf-8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as { content: string });
        expect(stored.map(message => message.content)).toEqual([original[0].content]);
    });

    it('deleteSession returns a typed not-found result for an unknown id', async () => {
        expect(await store.deleteSession(
            '99999999-9999-9999-9999-999999999999',
            { kind: 'user-delete' },
        )).toEqual({ deleted: false, reason: 'not-found' });
    });

    it('prepared rollback cannot delete a session once transcript data exists', async () => {
        const prepared = sessionMeta('12121212-1212-4212-8212-121212121212', '/tmp/workspace-prepared');
        prepared.materializationState = 'prepared';
        prepared.materializationSourceSessionId = 'pending-source';
        await store.saveSessionMetadata(prepared);
        expect((await appendAll(prepared.id, [msg(0)])).ok).toBe(true);

        const deletion = await store.deleteSession(prepared.id, {
            kind: 'prepared-materialization-rollback',
            sourceSessionId: 'pending-source',
        });

        expect(deletion).toEqual({ deleted: false, reason: 'data-present' });
        expect(store.getSessionMetadata(prepared.id)?.id).toBe(prepared.id);
        expect(existsSync(jsonlPath(prepared.id))).toBe(true);
    });

    it('pending identity migration atomically adopts an already-persisted transcript', async () => {
        const pending = sessionMeta('pending-identity-source', '/tmp/workspace-pending');
        const targetId = '13131313-1313-4313-8313-131313131313';
        await store.saveSessionMetadata(pending);
        expect((await appendAll(pending.id, [msg(0), msg(1)])).ok).toBe(true);

        const migration = await store.migratePendingSessionIdentity(pending.id, targetId, {
            sdkSessionId: targetId,
            unifiedSession: true,
        });

        expect(migration).toMatchObject({ migrated: true });
        expect(store.getSessionMetadata(pending.id)).toBeNull();
        expect(store.getSessionMetadata(targetId)).toMatchObject({
            id: targetId,
            sdkSessionId: targetId,
            unifiedSession: true,
        });
        expect(existsSync(jsonlPath(pending.id))).toBe(false);
        expect(readFileSync(jsonlPath(targetId), 'utf-8').trim().split('\n')).toHaveLength(2);
    });

    it('pending identity migration refuses to overwrite an indexed target', async () => {
        const pending = sessionMeta('pending-collision-source', '/tmp/workspace-pending');
        const target = sessionMeta('14141414-1414-4414-8414-141414141414', '/tmp/workspace-other');
        await store.saveSessionMetadata(pending);
        await store.saveSessionMetadata(target);

        expect(await store.migratePendingSessionIdentity(pending.id, target.id, {
            sdkSessionId: target.id,
            unifiedSession: true,
        })).toEqual({ migrated: false, reason: 'target-exists' });
        expect(store.getSessionMetadata(pending.id)?.id).toBe(pending.id);
        expect(store.getSessionMetadata(target.id)?.agentDir).toBe('/tmp/workspace-other');
    });

    it('pending identity migration refuses to overwrite unindexed target data', async () => {
        const pending = sessionMeta('pending-data-collision-source', '/tmp/workspace-pending');
        const targetId = '16161616-1616-4616-8616-161616161616';
        await store.saveSessionMetadata(pending);
        expect((await appendAll(pending.id, [msg(0)])).ok).toBe(true);
        writeFileSync(jsonlPath(targetId), JSON.stringify(msg(99)) + '\n', 'utf-8');

        expect(await store.migratePendingSessionIdentity(pending.id, targetId, {
            sdkSessionId: targetId,
            unifiedSession: true,
        })).toEqual({ migrated: false, reason: 'data-conflict' });
        expect(store.getSessionMetadata(pending.id)?.id).toBe(pending.id);
        expect(readFileSync(jsonlPath(pending.id), 'utf-8')).toContain('message 0');
        expect(readFileSync(jsonlPath(targetId), 'utf-8')).toContain('message 99');
    });

    it('pending identity migration resumes from a same-inode target staged before a crash', async () => {
        const pending = sessionMeta('pending-staged-source', '/tmp/workspace-pending');
        const targetId = '17171717-1717-4717-8717-171717171717';
        await store.saveSessionMetadata(pending);
        expect((await appendAll(pending.id, [msg(0), msg(1)])).ok).toBe(true);

        // Simulate a process crash after hard-link staging but before the
        // sessions.json identity commit.
        linkSync(jsonlPath(pending.id), jsonlPath(targetId));

        const migration = await store.migratePendingSessionIdentity(pending.id, targetId, {
            sdkSessionId: targetId,
            unifiedSession: true,
        });

        expect(migration).toMatchObject({ migrated: true });
        expect(store.getSessionMetadata(pending.id)).toBeNull();
        expect(store.getSessionMetadata(targetId)?.id).toBe(targetId);
        expect(existsSync(jsonlPath(pending.id))).toBe(false);
        expect(readFileSync(jsonlPath(targetId), 'utf-8').trim().split('\n')).toHaveLength(2);
    });

    it('pending identity migration finishes cleanup after metadata publication survived a crash', async () => {
        const pending = sessionMeta('pending-post-commit-source', '/tmp/workspace-pending');
        const targetId = '18181818-1818-4818-8818-181818181818';
        await store.saveSessionMetadata(pending);
        expect((await appendAll(pending.id, [msg(0), msg(1)])).ok).toBe(true);
        linkSync(jsonlPath(pending.id), jsonlPath(targetId));

        // Simulate the exact durable state after the sessions.json identity
        // commit and before source-link cleanup.
        const all = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as SessionMetadata[];
        const sourceIndex = all.findIndex(session => session.id === pending.id);
        all[sourceIndex] = {
            ...all[sourceIndex],
            id: targetId,
            sdkSessionId: targetId,
            materializationSourceSessionId: pending.id,
        };
        writeFileSync(sessionsJson(), JSON.stringify(all, null, 2), 'utf-8');

        const migration = await store.migratePendingSessionIdentity(pending.id, targetId, {
            sdkSessionId: targetId,
            unifiedSession: true,
        });

        expect(migration).toMatchObject({ migrated: true });
        expect(existsSync(jsonlPath(pending.id))).toBe(false);
        expect(readFileSync(jsonlPath(targetId), 'utf-8').trim().split('\n')).toHaveLength(2);
        expect(store.getSessionMetadata(targetId)?.materializationSourceSessionId).toBeUndefined();
    });

    it('prepared admission and rollback linearize on the durable marker', async () => {
        const prepared = sessionMeta('15151515-1515-4515-8515-151515151515', '/tmp/workspace-race');
        prepared.materializationState = 'prepared';
        prepared.materializationSourceSessionId = 'pending-race-source';
        await store.saveSessionMetadata(prepared);

        const [commit, deletion] = await Promise.all([
            store.claimPreparedSessionForTurnAdmission(
                prepared.id,
                'pending-race-source',
                { messageText: 'accepted turn' },
            ),
            store.deleteSession(prepared.id, {
                kind: 'prepared-materialization-rollback',
                sourceSessionId: 'pending-race-source',
            }),
        ]);

        if (deletion.deleted) {
            expect(commit).toEqual({ status: 'not-found' });
            expect(store.getSessionMetadata(prepared.id)).toBeNull();
        } else {
            expect(deletion.reason).toBe('precondition-failed');
            expect(commit.status).toBe('claimed');
            expect(store.getSessionMetadata(prepared.id)?.materializationState).toBeUndefined();
        }
    });
});
