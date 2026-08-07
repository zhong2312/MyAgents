/**
 * SessionStore - Handles persistence of session data using JSONL format.
 *
 * Storage structure:
 * ~/.myagents/
 * ├── sessions.json          # Array of SessionMetadata (index)
 * └── sessions/
 *     ├── {session-id}.jsonl  # Messages in JSONL format (append-only)
 *     └── ...
 *
 * JSONL Benefits:
 * - O(1) append for new messages (no full file rewrite)
 * - Crash recovery: partial writes don't corrupt history
 * - Concurrent safety: append is atomic on most filesystems
 */

import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, truncateSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { PendingConversationMutation, SessionMetadata, SessionData, SessionMessage, SessionStats } from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import { isPendingSessionId } from '../shared/constants';
import { isSystemMaintenanceSession } from '../shared/managedScheduledJob';
import {
    normalizeSessionOrigin,
    type RegisteredAgentSessionOrigin,
    type SessionOrigin,
} from '../shared/session-origin';
import { stripBom } from '../shared/utils';
import { workspacePathsEqual } from '../shared/workspacePath';
import { ensureDirSync } from './utils/fs-utils';
import { withFileLock } from './utils/file-lock';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { normalizeSessionRuntimeIdentity } from './utils/session-runtime-identity';
import { resolveLastVisibleTurnPreview } from './utils/session-message-preview';

const MYAGENTS_DIR = join(homedir(), '.myagents');
const SESSIONS_FILE = join(MYAGENTS_DIR, 'sessions.json');
const SESSIONS_DIR = join(MYAGENTS_DIR, 'sessions');
const ATTACHMENTS_DIR = join(MYAGENTS_DIR, 'attachments');
const SESSIONS_TMP_FILE = join(MYAGENTS_DIR, 'sessions.json.tmp');
const SESSIONS_LOCK_FILE = join(MYAGENTS_DIR, 'sessions.lock');
const SESSIONS_LOCK_DIR = join(MYAGENTS_DIR, 'session-locks');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

type TranscriptFileIdentity = Readonly<{
    exists: boolean;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    endsWithNewline: boolean;
}>;

const transcriptCursorState: unique symbol = Symbol('TranscriptWriteCursor');

/**
 * In-process capability proving which durable transcript snapshot an owner
 * loaded. The symbol-keyed physical identity is deliberately unavailable to
 * callers; only SessionStore can issue or advance the capability.
 */
export type TranscriptWriteCursor = Readonly<{
    persistedMessageCount: number;
    [transcriptCursorState]: Readonly<{
        sessionId: string;
        file: TranscriptFileIdentity;
    }>;
}>;

export type SessionTranscriptSnapshot = Readonly<{
    messages: SessionMessage[];
    cursor: TranscriptWriteCursor;
    hasMalformedRows: boolean;
}>;

class CorruptSessionsIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CorruptSessionsIndexError';
    }
}

class MalformedSessionTranscriptError extends Error {
    constructor(sessionId: string) {
        super(`Session ${sessionId} contains malformed JSONL rows`);
        this.name = 'MalformedSessionTranscriptError';
    }
}

function isSessionMetadataLike(entry: unknown): entry is SessionMetadata {
    return Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string'
    );
}

function dedupeSessionMetadata(sessions: SessionMetadata[]): SessionMetadata[] {
    const byId = new Map<string, SessionMetadata>();
    for (const session of sessions) {
        byId.set(session.id, session);
    }
    return [...byId.values()];
}

/**
 * File locking for sessions.json + per-session JSONL concurrent access safety.
 *
 * Pattern 5 §5.4 invariant: no synchronous event-loop blocking. We use the
 * shared async {@link withFileLock} helper (atomic mkdir lock, polled with
 * setTimeout — never Atomics.wait, never busy-spin). This forces all writer
 * paths in SessionStore to be async, and callers cascade `await` accordingly.
 *
 * Stale-recovery rules (delegated to withFileLock):
 *   - lockdir owner file format: `node:<pid>` / `rust:<pid>` / `renderer:<ts>`
 *   - lockdir age > LOCK_STALE_MS AND owner pid dead → broken automatically.
 *   - renderer:* owners (no observable pid) → age-only break.
 *
 * Lock hold time is ~1ms per call (single append + sessions.json stats update).
 */
async function withSessionsLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(
        { lockPath: SESSIONS_LOCK_FILE, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

/**
 * Per-session JSONL writer lock. Serializes append + rewind on
 * `<session>.jsonl` against any other writer (cross-tab cron, background
 * completion, future multi-owner cases).
 */
async function withSessionFileLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    if (!existsSync(SESSIONS_LOCK_DIR)) {
        try { mkdirSync(SESSIONS_LOCK_DIR, { recursive: true }); } catch { /* ignore — withFileLock will surface acquire failures */ }
    }
    const lockPath = join(SESSIONS_LOCK_DIR, `${safeId}.jsonl.lock`);
    return withFileLock(
        { lockPath, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

async function withSessionFileLocks<T>(sessionIds: string[], fn: () => Promise<T>): Promise<T> {
    const orderedIds = [...new Set(sessionIds)].sort();
    const acquireNext = async (index: number): Promise<T> => {
        if (index >= orderedIds.length) {
            return fn();
        }
        return withSessionFileLock(orderedIds[index], () => acquireNext(index + 1));
    };
    return acquireNext(0);
}

/**
 * Atomic write: write to tmp file then rename.
 * Prevents data loss from partial writes (process crash / power loss during writeFileSync).
 * rename() is atomic on POSIX (macOS/Linux) and near-atomic on Windows (NTFS MoveFileEx).
 */
function atomicWriteSessionsFile(content: string): void {
    const start = nowMs();
    writeFileSync(SESSIONS_TMP_FILE, content, 'utf-8');
    renameSync(SESSIONS_TMP_FILE, SESSIONS_FILE);
    emitPerfTrace({
        trace: 'storage_io',
        phase: 'sessions_metadata_write',
        durationMs: elapsedMs(start),
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        status: 'ok',
    });
}

function parseSessionsIndex(content: string): SessionMetadata[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripBom(content));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CorruptSessionsIndexError(`sessions.json is not valid JSON: ${detail}`);
    }

    if (!Array.isArray(parsed)) {
        throw new CorruptSessionsIndexError('sessions.json must contain a SessionMetadata array.');
    }

    const malformedIndex = parsed.findIndex(entry => !isSessionMetadataLike(entry));
    if (malformedIndex >= 0) {
        throw new CorruptSessionsIndexError(`sessions.json entry at index ${malformedIndex} is not valid SessionMetadata.`);
    }

    return (parsed as SessionMetadata[]).map(normalizeSessionRuntimeIdentity);
}

function extractCompleteSessionMetadataObjects(content: string): SessionMetadata[] {
    const sessions: SessionMetadata[] = [];
    const text = stripBom(content);
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                objectStart = i;
            }
            depth++;
            continue;
        }

        if (char === '}' && depth > 0) {
            depth--;
            if (depth === 0 && objectStart >= 0) {
                const candidate = text.slice(objectStart, i + 1);
                objectStart = -1;
                try {
                    const parsed = JSON.parse(candidate) as unknown;
                    if (isSessionMetadataLike(parsed)) {
                        sessions.push(parsed);
                    }
                } catch {
                    // Ignore this object; recovery is best-effort and never
                    // mutates the original corrupt file before it is backed up.
                }
            }
        }
    }

    return sessions;
}

function recoverSessionsIndexFromContent(content: string): SessionMetadata[] {
    try {
        const parsed = JSON.parse(stripBom(content)) as unknown;
        if (Array.isArray(parsed)) {
            return dedupeSessionMetadata(parsed.filter(isSessionMetadataLike).map(normalizeSessionRuntimeIdentity));
        }
    } catch {
        // Fall through to structural scan for truncated or partially written JSON.
    }

    return dedupeSessionMetadata(
        extractCompleteSessionMetadataObjects(content).map(normalizeSessionRuntimeIdentity),
    );
}

function readTmpSessionsIndexStrict(): SessionMetadata[] | null {
    if (!existsSync(SESSIONS_TMP_FILE)) {
        return null;
    }

    try {
        if (existsSync(SESSIONS_FILE)) {
            const tmpStat = statSync(SESSIONS_TMP_FILE);
            const mainStat = statSync(SESSIONS_FILE);
            if (tmpStat.mtimeMs < mainStat.mtimeMs) {
                console.warn('[SessionStore] Ignoring stale sessions.json.tmp during corrupt-index recovery.');
                return null;
            }
        }
        return parseSessionsIndex(readFileSync(SESSIONS_TMP_FILE, 'utf-8'));
    } catch (error) {
        console.warn('[SessionStore] Ignoring invalid sessions.json.tmp during corrupt-index recovery:', error);
        return null;
    }
}

function recoverSessionsIndexCandidates(): SessionMetadata[] {
    const corruptContent = existsSync(SESSIONS_FILE) ? readFileSync(SESSIONS_FILE, 'utf-8') : '';
    let recovered = recoverSessionsIndexFromContent(corruptContent);
    const tmpSessions = readTmpSessionsIndexStrict();
    if (tmpSessions && tmpSessions.length > 0) {
        recovered = tmpSessions;
    }
    return recovered;
}

function createCorruptBackupPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(MYAGENTS_DIR, `sessions.json.corrupt-${stamp}`);
    if (!existsSync(base)) {
        return base;
    }

    for (let i = 1; i < 1000; i++) {
        const candidate = `${base}-${i}`;
        if (!existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error('[SessionStore] Cannot allocate a unique sessions.json corrupt backup path.');
}

function readSessionsIndexStrict(): SessionMetadata[] {
    if (!existsSync(SESSIONS_FILE)) {
        return [];
    }

    return parseSessionsIndex(readFileSync(SESSIONS_FILE, 'utf-8'));
}

function backupCorruptSessionsIndex(error: CorruptSessionsIndexError): string {
    const backupPath = createCorruptBackupPath();
    try {
        renameSync(SESSIONS_FILE, backupPath);
    } catch (renameError) {
        const detail = renameError instanceof Error ? renameError.message : String(renameError);
        throw new Error(`[SessionStore] Cannot recover corrupt sessions.json (${error.message}); failed to move it aside: ${detail}`);
    }
    console.error(`[SessionStore] sessions.json was corrupt and has been moved to ${backupPath}. Cause: ${error.message}`);
    return backupPath;
}

function readSessionsIndexForWrite(): SessionMetadata[] {
    try {
        return readSessionsIndexStrict();
    } catch (error) {
        if (error instanceof CorruptSessionsIndexError) {
            const recovered = recoverSessionsIndexCandidates();
            const backupPath = backupCorruptSessionsIndex(error);
            atomicWriteSessionsFile(JSON.stringify(recovered, null, 2));
            console.error(`[SessionStore] Recovered ${recovered.length} session metadata entries while repairing sessions.json. Backup: ${backupPath}`);
            return recovered;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`[SessionStore] Failed to read sessions.json for write: ${detail}`);
    }
}

/**
 * Ensure storage directories exist
 */
function ensureStorageDir(): void {
    if (!existsSync(MYAGENTS_DIR)) {
        ensureDirSync(MYAGENTS_DIR);
    }
    if (!existsSync(SESSIONS_DIR)) {
        ensureDirSync(SESSIONS_DIR);
    }
    if (!existsSync(ATTACHMENTS_DIR)) {
        ensureDirSync(ATTACHMENTS_DIR);
    }
}

/**
 * Validate session ID to prevent path traversal attacks
 */
function isValidSessionId(sessionId: string): boolean {
    // Allow UUID format and session-timestamp-random format
    return /^[a-zA-Z0-9-]+$/.test(sessionId) && sessionId.length > 0 && sessionId.length < 100;
}

/**
 * Get the JSONL file path for a session
 */
function getSessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/**
 * Get the legacy JSON file path (for migration)
 */
function getLegacySessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.json`);
}

/**
 * Read messages from JSONL file with per-line error tolerance
 * Corrupted lines are skipped to prevent data loss
 */
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    if (!existsSync(filePath)) {
        return [];
    }

    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        const messages: SessionMessage[] = [];

        for (let i = 0; i < lines.length; i++) {
            try {
                messages.push(JSON.parse(lines[i]) as SessionMessage);
            } catch (lineError) {
                // Skip corrupted lines but continue processing
                console.warn(`[SessionStore] Skipping corrupted line ${i + 1}:`, lineError);
            }
        }

        return messages;
    } catch (error) {
        console.error('[SessionStore] Failed to read JSONL file:', error);
        return [];
    }
}

function readJsonlSnapshot(filePath: string): {
    messages: SessionMessage[];
    hasMalformedRows: boolean;
} {
    if (!existsSync(filePath)) {
        return { messages: [], hasMalformedRows: false };
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const messages: SessionMessage[] = [];
    let hasMalformedRows = false;
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            messages.push(JSON.parse(line) as SessionMessage);
        } catch {
            hasMalformedRows = true;
        }
    }
    return { messages, hasMalformedRows };
}

function getTranscriptFileIdentity(filePath: string): TranscriptFileIdentity {
    if (!existsSync(filePath)) {
        return { exists: false, dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, endsWithNewline: false };
    }
    const stat = statSync(filePath);
    let endsWithNewline = false;
    if (stat.size > 0) {
        const fd = openSync(filePath, 'r');
        try {
            const byte = Buffer.allocUnsafe(1);
            readSync(fd, byte, 0, 1, stat.size - 1);
            endsWithNewline = byte[0] === 0x0a;
        } finally {
            closeSync(fd);
        }
    }
    return {
        exists: true,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        endsWithNewline,
    };
}

function sameTranscriptFileIdentity(
    left: TranscriptFileIdentity,
    right: TranscriptFileIdentity,
): boolean {
    return left.exists === right.exists
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.endsWithNewline === right.endsWithNewline;
}

function issueTranscriptCursor(
    sessionId: string,
    persistedMessageCount: number,
    file: TranscriptFileIdentity,
): TranscriptWriteCursor {
    return Object.freeze({
        persistedMessageCount,
        [transcriptCursorState]: Object.freeze({ sessionId, file }),
    });
}

function cursorMatches(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    file: TranscriptFileIdentity,
): boolean {
    return cursor[transcriptCursorState].sessionId === sessionId
        && sameTranscriptFileIdentity(cursor[transcriptCursorState].file, file);
}

function readSessionMessagesForMutation(sessionId: string): SessionMessage[] {
    const jsonlPath = getSessionFilePath(sessionId);
    if (existsSync(jsonlPath)) {
        const snapshot = readJsonlSnapshot(jsonlPath);
        if (snapshot.hasMalformedRows) throw new MalformedSessionTranscriptError(sessionId);
        return snapshot.messages;
    }
    if (existsSync(getLegacySessionFilePath(sessionId))) return migrateToJsonl(sessionId);
    return [];
}

function atomicRewriteSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    const filePath = getSessionFilePath(sessionId);
    const tempPath = `${filePath}.rewind-${process.pid}.tmp`;
    const content = messages.map(message => JSON.stringify(message)).join('\n')
        + (messages.length > 0 ? '\n' : '');
    try {
        writeFileSync(tempPath, content, 'utf-8');
        renameSync(tempPath, filePath);
    } catch (error) {
        try {
            if (existsSync(tempPath)) unlinkSync(tempPath);
        } catch { /* best-effort temp cleanup */ }
        throw error;
    }
}

function readMessagesFromLegacyJson(filePath: string): SessionMessage[] {
    if (!existsSync(filePath)) {
        return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as { messages?: unknown };
    return Array.isArray(data.messages)
        ? data.messages.filter((msg): msg is SessionMessage => Boolean(msg && typeof msg === 'object' && typeof (msg as { role?: unknown }).role === 'string'))
        : [];
}

export function sessionHasUserMessages(sessionId: string): boolean {
    const jsonlPath = getSessionFilePath(sessionId);
    if (existsSync(jsonlPath)) {
        const content = readFileSync(jsonlPath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        for (const line of lines) {
            const msg = JSON.parse(line) as { role?: unknown };
            if (msg.role === 'user') {
                return true;
            }
        }
    }

    const legacyPath = getLegacySessionFilePath(sessionId);
    return readMessagesFromLegacyJson(legacyPath).some(msg => msg.role === 'user');
}

function hasPositiveNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function statsShowActivity(stats: SessionMetadata['stats'] | undefined): boolean {
    return hasPositiveNumber(stats?.messageCount)
        || hasPositiveNumber(stats?.totalInputTokens)
        || hasPositiveNumber(stats?.totalOutputTokens)
        || hasPositiveNumber(stats?.totalCacheReadTokens)
        || hasPositiveNumber(stats?.totalCacheCreationTokens);
}

function isManagedCodexRuntimeBackedBirth(session: SessionMetadata): boolean {
    const identity = session.providerExecutionIdentity;
    return Boolean(
        identity?.kind === 'runtime-backed-provider'
        && identity.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
        && identity.runtime === 'codex'
        && identity.runtimeSource === 'managed-provider'
    ) || (
        session.runtime === 'codex'
        && session.runtimeSource === 'managed-provider'
        && session.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
    );
}

function isDesktopOrUnknownOrigin(session: SessionMetadata): boolean {
    const kind = session.origin?.kind;
    if (kind && kind !== 'desktop' && kind !== 'unknown') {
        return false;
    }
    if (session.source && session.source !== 'desktop') {
        return false;
    }
    return true;
}

export function isLegacyPreQueryManagedCodexDraft(session: SessionMetadata): boolean {
    if (session.materializationState === 'prepared') return false;
    if (!isManagedCodexRuntimeBackedBirth(session)) return false;
    if (!isDesktopOrUnknownOrigin(session)) return false;
    if (session.favorite === true) return false;
    if (session.cronTaskId) return false;
    if (session.title !== 'New Chat') return false;
    if (session.titleSource === 'user') return false;
    if (session.lastMessagePreview) return false;
    if (session.lastContextUsage) return false;
    if (session.runtimeUsageTotals) return false;
    if (statsShowActivity(session.stats)) return false;
    try {
        return !sessionHasUserMessages(session.id);
    } catch {
        return false;
    }
}

export function isHistoryVisibleSession(session: SessionMetadata): boolean {
    return session.materializationState !== 'prepared'
        && !isSystemMaintenanceSession(session)
        && !isLegacyPreQueryManagedCodexDraft(session);
}

/**
 * Migrate legacy JSON file to JSONL format
 * Handles interrupted migrations (both files exist) gracefully
 */
function migrateToJsonl(sessionId: string): SessionMessage[] {
    const legacyPath = getLegacySessionFilePath(sessionId);
    const jsonlPath = getSessionFilePath(sessionId);

    // Handle interrupted migration: if both files exist, prefer JSONL and cleanup legacy
    if (existsSync(jsonlPath) && existsSync(legacyPath)) {
        console.log(`[SessionStore] Cleaning up interrupted migration: ${sessionId}`);
        try {
            unlinkSync(legacyPath);
        } catch (e) {
            console.warn('[SessionStore] Failed to cleanup legacy file:', e);
        }
        return readMessagesFromJsonl(jsonlPath);
    }

    if (!existsSync(legacyPath)) {
        return [];
    }

    // Read legacy JSON. Migration failures must propagate: returning an empty
    // snapshot would let a later append create a JSONL that masks intact legacy
    // history. The atomic rewrite keeps the legacy file authoritative until a
    // complete JSONL has been published.
    const content = readFileSync(legacyPath, 'utf-8');
    const data = JSON.parse(content) as { messages: SessionMessage[] };
    const messages = data.messages ?? [];

    if (messages.length > 0) {
        atomicRewriteSessionMessages(sessionId, messages);
        console.log(`[SessionStore] Migrated ${messages.length} messages to JSONL: ${sessionId}`);
    }

    unlinkSync(legacyPath);
    console.log(`[SessionStore] Removed legacy JSON file: ${sessionId}`);
    return messages;
}

/**
 * Read all session metadata
 */
export function getAllSessionMetadata(): SessionMetadata[] {
    ensureStorageDir();

    try {
        return readSessionsIndexStrict();
    } catch (error) {
        if (error instanceof CorruptSessionsIndexError) {
            const recovered = recoverSessionsIndexCandidates();
            console.error(`[SessionStore] sessions.json is corrupt; returning ${recovered.length} recoverable session metadata entries. Next metadata write will move the corrupt file aside and rewrite a repaired index. Cause: ${error.message}`);
            return recovered;
        }
        console.error('[SessionStore] Failed to read sessions.json:', error);
        return [];
    }
}

/**
 * Get sessions for a specific agent directory
 */
export function getSessionsByAgentDir(agentDir: string): SessionMetadata[] {
    const all = getAllSessionMetadata();
    return all
        // #320 family: session agentDir and the caller's path come from
        // different stores (sessions.json vs projects.json/config) — on
        // Windows they disagree on separators/drive case, so raw === drops
        // every session. Compare on the canonical identity.
        .filter(s => workspacePathsEqual(s.agentDir, agentDir))
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

/**
 * Get session metadata by ID
 */
export function getSessionMetadata(sessionId: string): SessionMetadata | null {
    const all = getAllSessionMetadata();
    return all.find(s => s.id === sessionId) ?? null;
}

export function getPersistedSessionOrigin(sessionId: string): SessionOrigin | undefined {
    return normalizeSessionOrigin(getSessionMetadata(sessionId)?.origin);
}

export type EnsureRegisteredAgentSessionOriginResult =
    | { success: true; metadataExists: boolean; adoptedLegacyOrigin?: boolean }
    | { success: false; error: string };

/**
 * Bind a delivery Session to one exact Registered Agent identity.
 *
 * Existing context-free registered-agent origins are upgraded in place for
 * compatibility. Any other existing origin is an authority conflict and is
 * rejected. Missing metadata is safe: the caller must pass the same exact
 * origin as the birth origin when it materializes the Session.
 */
export async function ensureRegisteredAgentSessionOrigin(
    sessionId: string,
    expected: RegisteredAgentSessionOrigin,
): Promise<EnsureRegisteredAgentSessionOriginResult> {
    ensureStorageDir();
    return withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const index = all.findIndex(session => session.id === sessionId);
        if (index < 0) {
            return { success: true, metadataExists: false };
        }

        const current = all[index];
        const normalized = normalizeSessionOrigin(current.origin);
        if (normalized) {
            const matches = normalized.kind === 'registered-agent'
                && normalized.surface === 'space_issue_delivery'
                && normalized.context.spaceId === expected.context.spaceId
                && normalized.context.registeredAgentId === expected.context.registeredAgentId;
            return matches
                ? { success: true, metadataExists: true }
                : {
                    success: false,
                    error: 'SESSION_ORIGIN_CONFLICT: This Session is already bound to a different origin.',
                };
        }

        const raw = current.origin as {
            kind?: unknown;
            surface?: unknown;
            context?: unknown;
        } | undefined;
        const isLegacyContextFreeRegisteredOrigin = raw?.kind === 'registered-agent'
            && raw.surface === 'space_issue_delivery'
            && !Object.prototype.hasOwnProperty.call(raw, 'context');
        if (isLegacyContextFreeRegisteredOrigin) {
            all[index] = { ...current, origin: expected };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return {
                success: true,
                metadataExists: true,
                ...(isLegacyContextFreeRegisteredOrigin ? { adoptedLegacyOrigin: true } : {}),
            };
        }

        return {
            success: false,
            error: 'SESSION_ORIGIN_CONFLICT: This Session is already bound to a different origin.',
        };
    });
}

/**
 * Save session metadata (create or update)
 */
export async function saveSessionMetadata(session: SessionMetadata): Promise<void> {
    ensureStorageDir();

    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();

        const index = all.findIndex(s => s.id === session.id);

        if (index >= 0) {
            all[index] = session;
        } else {
            all.push(session);
        }

        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        } catch (error) {
            console.error('[SessionStore] Failed to write sessions.json:', error);
            throw error;
        }
    });
}

export type SessionDeleteIntent =
    | { kind: 'user-delete' }
    | { kind: 'prepared-materialization-rollback'; sourceSessionId: string };

export type SessionDeleteResult =
    | { deleted: true }
    | {
        deleted: false;
        reason: 'not-found' | 'protected-session' | 'precondition-failed' | 'data-present' | 'io-error';
    };

function rejectSessionDeletion(
    sessionId: string,
    intent: SessionDeleteIntent,
    reason: Exclude<SessionDeleteResult, { deleted: true }>['reason'],
    detail: string,
): SessionDeleteResult {
    console.warn(`[SessionStore] Refused session deletion id=${sessionId} intent=${intent.kind} reason=${reason}: ${detail}`);
    return { deleted: false, reason };
}

/**
 * Delete session metadata and data for one of the explicitly supported
 * lifecycle transitions. The intent is validated while both the per-session
 * data lock and sessions-index lock are held, immediately before deletion.
 *
 * User deletion is additionally fenced by the Rust Sidecar lifecycle owner;
 * prepared rollback can only remove transaction-owned metadata that has not
 * admitted transcript data.
 */
export async function deleteSession(
    sessionId: string,
    intent: SessionDeleteIntent,
): Promise<SessionDeleteResult> {
    ensureStorageDir();

    // Lock order matches transcript append/mutation: per-session file lock OUTER,
    // sessions lock INNER. Taking the file lock here serializes the delete
    // against an in-flight append from another writer of the same session
    // (cross-tab cron, background completion) — previously the unlink could
    // interleave with an append and leave either a half-deleted file or a
    // just-recreated one.
    try {
        return await withSessionFileLock(sessionId, async () => withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(s => s.id === sessionId);

            if (index < 0) {
                return { deleted: false, reason: 'not-found' };
            }
            const current = all[index];
            const jsonlFile = getSessionFilePath(sessionId);
            const legacyFile = getLegacySessionFilePath(sessionId);
            const hasJsonl = existsSync(jsonlFile);
            const hasLegacyData = existsSync(legacyFile);

            switch (intent.kind) {
                case 'user-delete':
                    if (isSystemMaintenanceSession(current)) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'protected-session',
                            'system maintenance sessions are not user-editable',
                        );
                    }
                    break;
                case 'prepared-materialization-rollback':
                    if (
                        current.materializationState !== 'prepared'
                        || current.materializationSourceSessionId !== intent.sourceSessionId
                    ) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'precondition-failed',
                            'the prepared row is not owned by this materialization transaction',
                        );
                    }
                    if (hasJsonl || hasLegacyData) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'data-present',
                            'prepared rollback cannot remove a session after transcript data exists',
                        );
                    }
                    break;
            }

            const filtered = all.filter(s => s.id !== sessionId);

            // Remove the data files FIRST, then the index entry. If we crash
            // between the two steps, the failure mode is "entry present, file
            // gone" — a visible empty session the user can still see and delete
            // again. The previous order (entry first) left "entry gone, file
            // present": an invisible orphan that no UI can reach (issue #336).
            console.log(
                `[SessionStore] Deleting session id=${sessionId} intent=${intent.kind} metadataState=${current.materializationState ?? 'committed'} jsonl=${hasJsonl} legacy=${hasLegacyData}`,
            );

            if (hasJsonl) {
                unlinkSync(jsonlFile);
            }
            if (hasLegacyData) {
                unlinkSync(legacyFile);
            }

            atomicWriteSessionsFile(JSON.stringify(filtered, null, 2));

            return { deleted: true };
        }));
    } catch (error) {
        console.error(`[SessionStore] Failed to delete session id=${sessionId} intent=${intent.kind}:`, error);
        return { deleted: false, reason: 'io-error' };
    }
}

export type PendingSessionIdentityMigrationResult =
    | { migrated: true; metadata: SessionMetadata; transcript: SessionTranscriptSnapshot }
    | {
        migrated: false;
        reason: 'source-not-found' | 'source-not-pending' | 'target-exists' | 'data-conflict' | 'authority-revoked' | 'io-error';
    };

function pathsReferToSameFile(firstPath: string, secondPath: string): boolean {
    try {
        const first = statSync(firstPath);
        const second = statSync(secondPath);
        return first.ino !== 0 && first.dev === second.dev && first.ino === second.ino;
    } catch {
        return false;
    }
}

function loadSessionTranscriptLocked(sessionId: string): SessionTranscriptSnapshot {
    const filePath = getSessionFilePath(sessionId);
    if (!existsSync(filePath) && existsSync(getLegacySessionFilePath(sessionId))) {
        migrateToJsonl(sessionId);
    }
    const snapshot = readJsonlSnapshot(filePath);
    return {
        messages: snapshot.messages,
        cursor: issueTranscriptCursor(
            sessionId,
            snapshot.messages.length,
            getTranscriptFileIdentity(filePath),
        ),
        hasMalformedRows: snapshot.hasMalformedRows,
    };
}

/**
 * Atomically hand a pending Session identity to the concrete SDK UUID without
 * discarding a transcript that may already have been persisted under the
 * pending ID. Source data remains authoritative until the target hard-link
 * staging and the single sessions.json identity replacement have both
 * succeeded.
 */
export async function migratePendingSessionIdentity(
    sourceSessionId: string,
    targetSessionId: string,
    patch: Pick<SessionMetadata, 'sdkSessionId' | 'unifiedSession'>,
    commitPrecondition?: () => boolean,
): Promise<PendingSessionIdentityMigrationResult> {
    ensureStorageDir();
    if (!isPendingSessionId(sourceSessionId) || sourceSessionId === targetSessionId) {
        return { migrated: false, reason: 'source-not-pending' };
    }

    try {
        return await withSessionFileLocks(
            [sourceSessionId, targetSessionId],
            async () => withSessionsLock(async () => {
                if (commitPrecondition && !commitPrecondition()) {
                    return { migrated: false, reason: 'authority-revoked' };
                }
                const all = readSessionsIndexForWrite();
                const sourceIndex = all.findIndex(session => session.id === sourceSessionId);
                if (sourceIndex < 0) {
                    // Crash recovery: metadata publication is atomic, but the
                    // process can die before the obsolete source hard-link is
                    // removed. The target row carries the source identity as
                    // provenance until cleanup finishes, so a retry can prove
                    // ownership without accepting an unrelated target row.
                    const targetIndex = all.findIndex(session => session.id === targetSessionId);
                    const targetMetadata = targetIndex >= 0 ? all[targetIndex] : undefined;
                    if (targetMetadata?.materializationSourceSessionId === sourceSessionId) {
                        const sourceJsonl = getSessionFilePath(sourceSessionId);
                        const targetJsonl = getSessionFilePath(targetSessionId);
                        const sourceLegacy = getLegacySessionFilePath(sourceSessionId);
                        const targetLegacy = getLegacySessionFilePath(targetSessionId);
                        const sourceJsonlExists = existsSync(sourceJsonl);
                        const targetJsonlExists = existsSync(targetJsonl);
                        const sourceLegacyExists = existsSync(sourceLegacy);
                        const targetLegacyExists = existsSync(targetLegacy);

                        if (
                            (sourceJsonlExists && targetJsonlExists && !pathsReferToSameFile(sourceJsonl, targetJsonl))
                            || (sourceLegacyExists && targetLegacyExists && !pathsReferToSameFile(sourceLegacy, targetLegacy))
                        ) {
                            return { migrated: false, reason: 'data-conflict' };
                        }
                        if (sourceJsonlExists && !targetJsonlExists) linkSync(sourceJsonl, targetJsonl);
                        if (sourceLegacyExists && !targetLegacyExists) linkSync(sourceLegacy, targetLegacy);
                        if (sourceJsonlExists) unlinkSync(sourceJsonl);
                        if (sourceLegacyExists) unlinkSync(sourceLegacy);

                        // Prepared-session ownership uses this field until the
                        // first turn commits. For an already-visible session it
                        // was only the crash-recovery marker and can now retire.
                        let recoveredMetadata = targetMetadata;
                        if (targetMetadata.materializationState !== 'prepared') {
                            recoveredMetadata = {
                                ...targetMetadata,
                                materializationSourceSessionId: undefined,
                            };
                            all[targetIndex] = recoveredMetadata;
                            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                        }

                        return {
                            migrated: true,
                            metadata: recoveredMetadata,
                            transcript: loadSessionTranscriptLocked(targetSessionId),
                        };
                    }
                    return { migrated: false, reason: 'source-not-found' };
                }
                if (all.some(session => session.id === targetSessionId)) {
                    return { migrated: false, reason: 'target-exists' };
                }

                const sourceJsonl = getSessionFilePath(sourceSessionId);
                const targetJsonl = getSessionFilePath(targetSessionId);
                const sourceLegacy = getLegacySessionFilePath(sourceSessionId);
                const targetLegacy = getLegacySessionFilePath(targetSessionId);
                const hasSourceJsonl = existsSync(sourceJsonl);
                const hasSourceLegacy = existsSync(sourceLegacy);

                const hasTargetJsonl = existsSync(targetJsonl);
                const hasTargetLegacy = existsSync(targetLegacy);
                const jsonlStagedByThisSource = hasSourceJsonl
                    && hasTargetJsonl
                    && pathsReferToSameFile(sourceJsonl, targetJsonl);
                const legacyStagedByThisSource = hasSourceLegacy
                    && hasTargetLegacy
                    && pathsReferToSameFile(sourceLegacy, targetLegacy);

                if (
                    (hasTargetJsonl && !jsonlStagedByThisSource)
                    || (hasTargetLegacy && !legacyStagedByThisSource)
                ) {
                    console.warn(`[SessionStore] Refused pending identity migration source=${sourceSessionId} target=${targetSessionId}: target data exists without an indexed target`);
                    return { migrated: false, reason: 'data-conflict' };
                }

                // Stage the target as a hard link before publishing metadata.
                // Source remains authoritative until the index commit; a crash
                // leaves a same-inode target that a retry can identify without
                // overwriting unrelated orphan data.
                if (hasSourceJsonl && !hasTargetJsonl) {
                    linkSync(sourceJsonl, targetJsonl);
                }
                if (hasSourceLegacy && !hasTargetLegacy) {
                    linkSync(sourceLegacy, targetLegacy);
                }

                const sourceMetadata = all[sourceIndex];
                const metadata: SessionMetadata = {
                    ...sourceMetadata,
                    ...patch,
                    id: targetSessionId,
                    // Keep provenance durable until source-name cleanup has
                    // completed. Prepared sessions already use the same marker
                    // for their admission transaction, so no new state field is
                    // needed.
                    materializationSourceSessionId:
                        sourceMetadata.materializationSourceSessionId ?? sourceSessionId,
                };
                all[sourceIndex] = metadata;
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));

                // Metadata now points at the same inode. Remove the obsolete
                // source name before releasing either file lock. If cleanup
                // fails, roll the metadata identity back while both names still
                // reference identical bytes; never publish a split-writable
                // source/target pair.
                try {
                    if (hasSourceJsonl) unlinkSync(sourceJsonl);
                    if (hasSourceLegacy) unlinkSync(sourceLegacy);
                } catch (error) {
                    try {
                        // One source name may already have been removed before
                        // another unlink failed. Recreate every missing source
                        // name from its same-inode target before restoring the
                        // original metadata row.
                        if (hasSourceJsonl && !existsSync(sourceJsonl) && existsSync(targetJsonl)) {
                            linkSync(targetJsonl, sourceJsonl);
                        }
                        if (hasSourceLegacy && !existsSync(sourceLegacy) && existsSync(targetLegacy)) {
                            linkSync(targetLegacy, sourceLegacy);
                        }
                        all[sourceIndex] = sourceMetadata;
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));

                        if (existsSync(targetJsonl)) unlinkSync(targetJsonl);
                        if (existsSync(targetLegacy)) unlinkSync(targetLegacy);
                    } catch (rollbackError) {
                        console.error(`[SessionStore] Pending identity migration rollback could not fully restore source=${sourceSessionId} target=${targetSessionId}:`, rollbackError);
                    }
                    console.error(`[SessionStore] Pending identity migration source cleanup failed source=${sourceSessionId} target=${targetSessionId}:`, error);
                    return { migrated: false, reason: 'io-error' };
                }

                let completedMetadata = metadata;
                if (metadata.materializationState !== 'prepared') {
                    completedMetadata = {
                        ...metadata,
                        materializationSourceSessionId: undefined,
                    };
                    all[sourceIndex] = completedMetadata;
                    atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                }

                console.log(`[SessionStore] Migrated pending session identity source=${sourceSessionId} target=${targetSessionId} jsonl=${hasSourceJsonl} legacy=${hasSourceLegacy}`);
                return {
                    migrated: true,
                    metadata: completedMetadata,
                    transcript: loadSessionTranscriptLocked(targetSessionId),
                };
            }),
        );
    } catch (error) {
        console.error(`[SessionStore] Failed pending identity migration source=${sourceSessionId} target=${targetSessionId}:`, error);
        return { migrated: false, reason: 'io-error' };
    }
}

/**
 * Get full session data including messages
 */
export function getSessionData(sessionId: string): SessionData | null {
    const metadata = getSessionMetadata(sessionId);
    if (!metadata) {
        return null;
    }

    return getSessionDataFromMetadata(metadata);
}

/**
 * Get full session data when the caller already owns the authoritative
 * metadata row. Bulk readers must use this path instead of looking the same
 * row up in sessions.json again for every session.
 */
export function getSessionDataFromMetadata(metadata: SessionMetadata): SessionData {
    const sessionId = metadata.id;

    const jsonlPath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    let messages: SessionMessage[] = [];

    // Check for JSONL file first
    if (existsSync(jsonlPath)) {
        messages = readMessagesFromJsonl(jsonlPath);
    }
    // Check for legacy JSON file and migrate
    else if (existsSync(legacyPath)) {
        messages = migrateToJsonl(sessionId);
    }

    return {
        ...metadata,
        messages,
    };
}

/**
 * Load the durable transcript and issue the only capability accepted by later
 * append/mutation calls. Legacy JSON is migrated lazily under the same
 * per-Session writer lock used by every transcript mutation.
 */
export async function loadSessionTranscript(sessionId: string): Promise<SessionTranscriptSnapshot> {
    ensureStorageDir();
    return withSessionFileLock(sessionId, async () => loadSessionTranscriptLocked(sessionId));
}

export type ConversationMutationResult =
    | { success: true; metadata: SessionMetadata; messages: SessionMessage[] }
    | {
        success: false;
        reason: 'precondition_failed' | 'storage_consistency_error' | 'write_error';
        error: string;
    };

function finalizeCodexRewindMetadata(
    current: SessionMetadata,
    intent: PendingConversationMutation,
    messages: SessionMessage[],
): SessionMetadata {
    const { preview } = resolveLastVisibleTurnPreview(messages);
    return {
        ...current,
        runtimeSessionId: intent.replacementRuntimeSessionId ?? undefined,
        pendingConversationMutation: undefined,
        runtimeUsageTotals: undefined,
        lastContextUsage: undefined,
        stats: calculateSessionStats(messages),
        lastMessagePreview: preview,
    };
}

async function resolvePendingConversationMutationLocked(
    sessionId: string,
): Promise<ConversationMutationResult> {
    const messages = readSessionMessagesForMutation(sessionId);
    return withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const index = all.findIndex(session => session.id === sessionId);
        if (index < 0) {
            return { success: false, reason: 'precondition_failed', error: 'Session metadata is missing' };
        }
        const current = all[index];
        const intent = current.pendingConversationMutation;
        if (!intent) return { success: true, metadata: current, messages };
        if (intent.schemaVersion !== 1 || intent.kind !== 'codex-rewind') {
            return { success: false, reason: 'storage_consistency_error', error: 'Unknown conversation mutation intent' };
        }
        if (current.runtimeSessionId !== intent.sourceRuntimeSessionId) {
            return {
                success: false,
                reason: 'storage_consistency_error',
                error: 'Conversation mutation source binding mismatch',
            };
        }

        if (messages.length === intent.sourceMessageCount) {
            const restored = { ...current, pendingConversationMutation: undefined };
            all[index] = restored;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return { success: true, metadata: restored, messages };
        }
        if (messages.length === intent.targetMessageCount) {
            const completed = finalizeCodexRewindMetadata(current, intent, messages);
            all[index] = completed;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return { success: true, metadata: completed, messages };
        }
        return {
            success: false,
            reason: 'storage_consistency_error',
            error: `Conversation mutation count mismatch: expected ${intent.sourceMessageCount} or ${intent.targetMessageCount}, found ${messages.length}`,
        };
    });
}

/** Resolve the bounded Codex rewind intent before a Session may resume or send. */
export async function resolvePendingConversationMutation(
    sessionId: string,
): Promise<ConversationMutationResult> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(sessionId, () => resolvePendingConversationMutationLocked(sessionId));
    } catch (error) {
        return {
            success: false,
            reason: error instanceof MalformedSessionTranscriptError
                ? 'storage_consistency_error'
                : 'write_error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Commit transcript truncation and native binding replacement under one recoverable intent. */
export async function commitCodexConversationRewind(input: {
    sessionId: string;
    sourceRuntimeSessionId: string;
    replacementRuntimeSessionId: string | null;
    sourceMessages: SessionMessage[];
    targetMessages: SessionMessage[];
}): Promise<ConversationMutationResult> {
    ensureStorageDir();
    if (
        input.targetMessages.length >= input.sourceMessages.length
        || input.targetMessages.some((message, index) => message.id !== input.sourceMessages[index]?.id)
    ) {
        return { success: false, reason: 'precondition_failed', error: 'Rewind target is not a strict transcript prefix' };
    }
    const intent: PendingConversationMutation = {
        schemaVersion: 1,
        kind: 'codex-rewind',
        sourceRuntimeSessionId: input.sourceRuntimeSessionId,
        replacementRuntimeSessionId: input.replacementRuntimeSessionId,
        sourceMessageCount: input.sourceMessages.length,
        targetMessageCount: input.targetMessages.length,
    };

    try {
        return await withSessionFileLock(input.sessionId, async () => {
            const durableMessages = readSessionMessagesForMutation(input.sessionId);
            if (
                durableMessages.length !== input.sourceMessages.length
                || durableMessages.some((message, index) => message.id !== input.sourceMessages[index]?.id)
            ) {
                return { success: false, reason: 'precondition_failed', error: 'Session transcript changed before rewind' };
            }

            const intentWritten = await withSessionsLock(async () => {
                const all = readSessionsIndexForWrite();
                const index = all.findIndex(session => session.id === input.sessionId);
                if (index < 0) return false;
                const current = all[index];
                if (
                    current.runtime !== 'codex'
                    || current.runtimeSessionId !== input.sourceRuntimeSessionId
                    || current.pendingConversationMutation
                ) return false;
                all[index] = { ...current, pendingConversationMutation: intent };
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                return true;
            });
            if (!intentWritten) {
                return { success: false, reason: 'precondition_failed', error: 'Session binding changed before rewind' };
            }

            try {
                atomicRewriteSessionMessages(input.sessionId, input.targetMessages);
                return await resolvePendingConversationMutationLocked(input.sessionId);
            } catch (error) {
                const recovered = await resolvePendingConversationMutationLocked(input.sessionId);
                if (
                    recovered.success
                    && recovered.messages.length === input.targetMessages.length
                    && recovered.messages.every((message, index) => message.id === input.targetMessages[index]?.id)
                ) return recovered;
                if (!recovered.success && recovered.reason === 'storage_consistency_error') return recovered;
                return {
                    success: false,
                    reason: 'write_error',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });
    } catch (error) {
        return {
            success: false,
            reason: error instanceof MalformedSessionTranscriptError
                ? 'storage_consistency_error'
                : 'write_error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Calculate session statistics from messages
 */
export function calculateSessionStats(messages: SessionMessage[]): SessionStats {
    let messageCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    for (const msg of messages) {
        if (msg.role === 'user') {
            messageCount++;
        } else if (msg.role === 'assistant' && msg.usage) {
            totalInputTokens += msg.usage.inputTokens ?? 0;
            totalOutputTokens += msg.usage.outputTokens ?? 0;
            totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;
            totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
        }
    }

    return {
        messageCount,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens: totalCacheReadTokens || undefined,
        totalCacheCreationTokens: totalCacheCreationTokens || undefined,
    };
}

export type AppendSessionMessagesResult =
    | { ok: true; action: 'appended' | 'noop'; count: number; totalCount: number; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'unindexed-create-refused' | 'write-error'; error: string; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'stale-cursor' | 'storage-consistency-error'; error: string };

export type TranscriptMutationIntent =
    | { kind: 'builtin-rewind'; targetMessageId: string; targetMessageCount: number }
    | { kind: 'sdk-retraction'; sdkUuids: readonly string[]; streamingTailMessageId?: string }
    | { kind: 'builtin-admission-rollback'; messageId: string }
    | { kind: 'builtin-transient-retry'; messageId: string }
    | { kind: 'external-rejected-message'; messageId: string }
    | { kind: 'external-retry'; userMessageId: string; targetMessageCount: number };

export type MutateSessionTranscriptResult =
    | { ok: true; action: 'replaced' | 'noop'; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'stale-cursor' | 'precondition-failed' | 'malformed-transcript' | 'write-error'; error: string };

function appendHasExpectedLineage(
    before: TranscriptFileIdentity,
    after: TranscriptFileIdentity,
): boolean {
    if (!before.exists) return after.exists;
    if (!after.exists || before.dev !== after.dev) return false;
    return before.ino === 0 || after.ino === 0 || before.ino === after.ino;
}

function appendedSuffixMatches(
    filePath: string,
    before: TranscriptFileIdentity,
    after: TranscriptFileIdentity,
    bytes: Buffer,
    mode: 'exact' | 'prefix',
): boolean {
    if (!appendHasExpectedLineage(before, after) || after.size < before.size) return false;
    const suffixLength = after.size - before.size;
    if (mode === 'exact' ? suffixLength !== bytes.length : suffixLength >= bytes.length) return false;
    const content = readFileSync(filePath);
    const suffix = content.subarray(before.size);
    return mode === 'exact' ? suffix.equals(bytes) : bytes.subarray(0, suffix.length).equals(suffix);
}

async function updateStatsAfterAppend(sessionId: string, messages: SessionMessage[]): Promise<void> {
    const delta = calculateSessionStats(messages);
    try {
        await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(session => session.id === sessionId);
            if (index < 0) {
                console.warn(`[SessionStore] appended ${messages.length} message(s) to unindexed session ${sessionId}; stats not updated`);
                return;
            }
            const current = all[index];
            const stats = current.stats ?? { messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 };
            all[index] = {
                ...current,
                stats: {
                    messageCount: stats.messageCount + delta.messageCount,
                    totalInputTokens: stats.totalInputTokens + delta.totalInputTokens,
                    totalOutputTokens: stats.totalOutputTokens + delta.totalOutputTokens,
                    totalCacheReadTokens: ((stats.totalCacheReadTokens ?? 0) + (delta.totalCacheReadTokens ?? 0)) || undefined,
                    totalCacheCreationTokens: ((stats.totalCacheCreationTokens ?? 0) + (delta.totalCacheCreationTokens ?? 0)) || undefined,
                },
            };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        });
    } catch (error) {
        console.warn(`[SessionStore] Transcript append committed for ${sessionId}, but stats update failed:`, error);
    }
}

async function replaceDerivedTranscriptProjection(
    sessionId: string,
    messages: SessionMessage[],
): Promise<void> {
    try {
        await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(session => session.id === sessionId);
            if (index < 0) return;
            const { preview } = resolveLastVisibleTurnPreview(messages);
            all[index] = {
                ...all[index],
                stats: calculateSessionStats(messages),
                lastMessagePreview: preview,
            };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        });
    } catch (error) {
        console.warn(`[SessionStore] Transcript mutation committed for ${sessionId}, but derived metadata update failed:`, error);
    }
}

/** Append only caller-supplied tail rows when the issued durable cursor is current. */
export async function appendSessionMessages(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    messages: readonly SessionMessage[],
): Promise<AppendSessionMessagesResult> {
    ensureStorageDir();
    const filePath = getSessionFilePath(sessionId);
    try {
        return await withSessionFileLock(sessionId, async () => {
            const before = cursor[transcriptCursorState].file;
            const needsSeparator = before.exists && before.size > 0 && !before.endsWithNewline;
            const serialized = `${needsSeparator ? '\n' : ''}${messages.map(message => JSON.stringify(message)).join('\n')}${messages.length > 0 ? '\n' : ''}`;
            const bytes = Buffer.from(serialized, 'utf-8');
            const current = getTranscriptFileIdentity(filePath);

            if (!cursorMatches(sessionId, cursor, current)) {
                if (messages.length > 0 && appendedSuffixMatches(filePath, before, current, bytes, 'exact')) {
                    const recoveredCursor = issueTranscriptCursor(
                        sessionId,
                        cursor.persistedMessageCount + messages.length,
                        current,
                    );
                    await replaceDerivedTranscriptProjection(sessionId, readJsonlSnapshot(filePath).messages);
                    return { ok: true, action: 'appended', count: messages.length, totalCount: recoveredCursor.persistedMessageCount, cursor: recoveredCursor };
                }
                return { ok: false, reason: 'stale-cursor', error: 'Session transcript changed after the cursor was issued' };
            }
            if (messages.length === 0) {
                return { ok: true, action: 'noop', count: 0, totalCount: cursor.persistedMessageCount, cursor };
            }
            if (!current.exists && !getSessionMetadata(sessionId)) {
                return {
                    ok: false,
                    reason: 'unindexed-create-refused',
                    error: 'Session metadata is missing; refused to create transcript',
                    cursor,
                };
            }

            const startedAt = nowMs();
            try {
                appendFileSync(filePath, bytes);
            } catch (error) {
                const afterFailure = getTranscriptFileIdentity(filePath);
                if (sameTranscriptFileIdentity(before, afterFailure)) {
                    return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor };
                }
                if (appendedSuffixMatches(filePath, before, afterFailure, bytes, 'exact')) {
                    const recoveredCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount + messages.length, afterFailure);
                    await updateStatsAfterAppend(sessionId, [...messages]);
                    return { ok: true, action: 'appended', count: messages.length, totalCount: recoveredCursor.persistedMessageCount, cursor: recoveredCursor };
                }
                if (appendedSuffixMatches(filePath, before, afterFailure, bytes, 'prefix')) {
                    try {
                        truncateSync(filePath, before.size);
                        const repaired = getTranscriptFileIdentity(filePath);
                        const repairedCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount, repaired);
                        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor: repairedCursor };
                    } catch (repairError) {
                        return { ok: false, reason: 'storage-consistency-error', error: repairError instanceof Error ? repairError.message : String(repairError) };
                    }
                }
                return { ok: false, reason: 'storage-consistency-error', error: error instanceof Error ? error.message : String(error) };
            }

            let after: TranscriptFileIdentity;
            try {
                after = getTranscriptFileIdentity(filePath);
                if (!appendedSuffixMatches(filePath, before, after, bytes, 'exact')) {
                    return { ok: false, reason: 'storage-consistency-error', error: 'Append completed without the expected durable suffix' };
                }
            } catch (error) {
                return {
                    ok: false,
                    reason: 'storage-consistency-error',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            emitPerfTrace({
                trace: 'storage_io',
                phase: 'session_jsonl_append',
                sessionId,
                durationMs: elapsedMs(startedAt),
                sizeBytes: bytes.length,
                count: messages.length,
                status: 'ok',
            });
            await updateStatsAfterAppend(sessionId, [...messages]);
            const nextCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount + messages.length, after);
            return { ok: true, action: 'appended', count: messages.length, totalCount: nextCursor.persistedMessageCount, cursor: nextCursor };
        });
    } catch (error) {
        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor };
    }
}

function deriveTranscriptMutationTarget(
    messages: SessionMessage[],
    intent: TranscriptMutationIntent,
): { ok: true; target: SessionMessage[] | null } | { ok: false; error: string } {
    if (intent.kind === 'builtin-rewind' || intent.kind === 'external-retry') {
        const targetId = intent.kind === 'builtin-rewind' ? intent.targetMessageId : intent.userMessageId;
        const targetIndex = messages.findIndex(message => message.id === targetId && message.role === 'user');
        if (targetIndex < 0) {
            return intent.targetMessageCount >= messages.length
                ? { ok: true, target: null }
                : { ok: false, error: 'Mutation target is missing from the proven durable prefix' };
        }
        if (targetIndex !== intent.targetMessageCount) {
            return { ok: false, error: 'Mutation target index does not match the durable transcript' };
        }
        return { ok: true, target: messages.slice(0, targetIndex) };
    }
    if (intent.kind === 'sdk-retraction') {
        const sdkUuids = new Set(intent.sdkUuids);
        const target = messages.filter(message => (
            (!message.sdkUuid || !sdkUuids.has(message.sdkUuid))
            && message.id !== intent.streamingTailMessageId
        ));
        return { ok: true, target: target.length === messages.length ? null : target };
    }
    const target = messages.filter(message => message.id !== intent.messageId);
    return { ok: true, target: target.length === messages.length ? null : target };
}

/** Commit a named destructive transcript operation from a proven durable source. */
export async function mutateSessionTranscript(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    intent: TranscriptMutationIntent,
): Promise<MutateSessionTranscriptResult> {
    ensureStorageDir();
    const filePath = getSessionFilePath(sessionId);
    try {
        return await withSessionFileLock(sessionId, async () => {
            const current = getTranscriptFileIdentity(filePath);
            if (!cursorMatches(sessionId, cursor, current)) {
                return { ok: false, reason: 'stale-cursor', error: 'Session transcript changed after the cursor was issued' };
            }
            if (!getSessionMetadata(sessionId)) {
                return { ok: false, reason: 'precondition-failed', error: 'Session metadata is missing' };
            }
            const source = readJsonlSnapshot(filePath);
            if (source.hasMalformedRows) {
                return { ok: false, reason: 'malformed-transcript', error: 'Destructive mutation requires a fully readable transcript' };
            }
            if (source.messages.length !== cursor.persistedMessageCount) {
                return { ok: false, reason: 'stale-cursor', error: 'Cursor message count does not match durable transcript' };
            }
            const derived = deriveTranscriptMutationTarget(source.messages, intent);
            if (!derived.ok) {
                return { ok: false, reason: 'precondition-failed', error: derived.error };
            }
            const target = derived.target;
            if (!target) {
                return { ok: true, action: 'noop', cursor };
            }
            try {
                atomicRewriteSessionMessages(sessionId, target);
            } catch (error) {
                return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error) };
            }
            await replaceDerivedTranscriptProjection(sessionId, target);
            return {
                ok: true,
                action: 'replaced',
                cursor: issueTranscriptCursor(sessionId, target.length, getTranscriptFileIdentity(filePath)),
            };
        });
    } catch (error) {
        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Update session metadata.
 *
 * Writable keys include config-snapshot fields (v0.1.69) so the PATCH
 * /sessions/:id endpoint can persist model / permissionMode / MCP / provider
 * onto an existing session without replaying the full SessionMetadata blob.
 */
function monotonicLastActiveAt(current: string, incoming: string): string {
    const incomingMs = Date.parse(incoming);
    const currentMs = Date.parse(current);
    const incomingIsCanonical = Number.isFinite(incomingMs)
        && new Date(incomingMs).toISOString() === incoming;
    if (!incomingIsCanonical || (Number.isFinite(currentMs) && incomingMs < currentMs)) {
        return current;
    }
    return incoming;
}

export async function updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<SessionMetadata,
        | 'title'
        | 'lastActiveAt'
        | 'sdkSessionId'
        | 'unifiedSession'
        | 'stats'
        | 'cronTaskId'
        | 'source'
        | 'origin'
        | 'historyGroupPath'
        | 'workbenchToolset'
        | 'favorite'
        | 'lastMessagePreview'
        | 'titleSource'
        | 'titleGenAttempts'
        | 'runtime'
        | 'runtimeSource'
        | 'runtimeSessionId'
        | 'runtimeUsageTotals'
        | 'lastContextUsage'
        | 'model'
        | 'reasoningEffort'
        | 'permissionMode'
        | 'mcpEnabledServers'
        | 'enabledPluginIds'
        | 'enabledOfficialToolIds'
        | 'providerId'
        | 'providerRoute'
        | 'providerExecutionIdentity'
        | 'providerRouteRepairedAt'
        | 'providerEnvJson'
        | 'configSnapshotAt'
        | 'materializationState'
        | 'materializationSourceSessionId'
        | 'pendingContinueAfterAbort'
    >>,
    /**
     * Optional compare-and-set guard evaluated INSIDE the lock against the
     * freshly-read current metadata. When it returns false the write is skipped
     * and this returns null. This closes a check-then-write TOCTOU that a
     * caller cannot close on its own: reading metadata, deciding, then calling
     * this leaves a window where a concurrent writer can change the very field
     * the decision was based on. Auto-titling uses it to never clobber a title
     * the user renamed during the multi-second LLM call (review #3).
     */
    precondition?: (current: SessionMetadata) => boolean,
): Promise<SessionMetadata | null> {
    // Race-safe read-modify-write — must happen entirely under
    // `withSessionsLock` so a concurrent updater (e.g. periodic stats /
    // title patch / runtime-change freeze) doesn't get its just-applied
    // changes clobbered by us reading a pre-their-write snapshot and
    // writing back the full stale object.
    //
    // Pre-v0.2.14: read happened OUTSIDE the lock, so two concurrent
    // updaters could each compute `{...session, ...patch_X}` from the
    // same snapshot and the second writer would silently drop the first
    // writer's fields. Now: read fresh under the lock, patch, write back
    // — all atomic. (review-by-codex F3.)
    ensureStorageDir();
    let result: SessionMetadata | null = null;
    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const idx = all.findIndex(s => s.id === sessionId);
        if (idx < 0) {
            // session not found — leave result=null
            return;
        }
        if (precondition && !precondition(all[idx])) {
            // CAS guard failed against the in-lock snapshot — skip the write.
            return;
        }
        const current = all[idx];
        const patch = { ...updates };
        if (patch.lastActiveAt !== undefined) {
            patch.lastActiveAt = monotonicLastActiveAt(current.lastActiveAt, patch.lastActiveAt);
        }
        const updated: SessionMetadata = { ...current, ...patch };
        all[idx] = updated;
        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            result = updated;
        } catch (error) {
            console.error('[SessionStore] updateSessionMetadata write failed:', error);
        }
    });
    return result;
}

export async function commitPreparedSessionForFirstUserTurn(
    sessionId: string,
    params: {
        messageText?: string;
        title?: string;
        runtimeSessionId?: string;
        origin?: SessionMetadata['origin'];
        lastActiveAt?: string;
        lastMessagePreview?: string;
    },
): Promise<SessionMetadata | null> {
    ensureStorageDir();
    const title = params.title ?? generateSessionTitle(params.messageText ?? '');
    let result: SessionMetadata | null = null;

    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const idx = all.findIndex(s => s.id === sessionId);
        if (idx < 0) return;

        const current = all[idx];
        const patch: Partial<SessionMetadata> = {};
        const canSetDefaultTitle = current.title === 'New Chat' && current.titleSource !== 'user';

        if (canSetDefaultTitle && title && title !== current.title) {
            patch.title = title;
            patch.titleSource = 'default';
        }
        if (!current.origin && params.origin) {
            patch.origin = params.origin;
        }
        if (params.runtimeSessionId && current.runtimeSessionId !== params.runtimeSessionId) {
            patch.runtimeSessionId = params.runtimeSessionId;
        }
        if (current.materializationState === 'prepared') {
            patch.materializationState = undefined;
            patch.materializationSourceSessionId = undefined;
            patch.lastMessagePreview = params.lastMessagePreview;
            if (params.lastActiveAt) {
                patch.lastActiveAt = monotonicLastActiveAt(current.lastActiveAt, params.lastActiveAt);
            }
        }

        if (Object.keys(patch).length === 0) {
            result = current;
            return;
        }

        const updated: SessionMetadata = { ...current, ...patch };
        all[idx] = updated;
        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        result = updated;
    });

    return result;
}

export type PreparedSessionAdmissionClaimResult =
    | { status: 'claimed'; metadata: SessionMetadata }
    | { status: 'already-committed'; metadata: SessionMetadata }
    | { status: 'not-found' }
    | { status: 'source-mismatch' }
    | { status: 'io-error' };

/**
 * Durable turn-admission compare-and-set for renderer-prepared sessions.
 *
 * This is deliberately a typed SessionStore operation instead of a caller-side
 * `getSessionMetadata()` followed by `commitPrepared...()`: rollback and
 * admission must decide against the same in-lock row. `expectedSourceSessionId`
 * is supplied by the in-process preparation transaction when one exists; its
 * absence supports crash/restart recovery of a still-prepared row without
 * weakening an active transaction's ownership check.
 */
export async function claimPreparedSessionForTurnAdmission(
    sessionId: string,
    expectedSourceSessionId: string | undefined,
    params: {
        messageText?: string;
        title?: string;
        origin?: SessionMetadata['origin'];
        lastMessagePreview?: string;
    },
): Promise<PreparedSessionAdmissionClaimResult> {
    ensureStorageDir();
    const title = params.title ?? generateSessionTitle(params.messageText ?? '');

    try {
        return await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const idx = all.findIndex(session => session.id === sessionId);
            if (idx < 0) return { status: 'not-found' };

            const current = all[idx];
            if (current.materializationState !== 'prepared') {
                return { status: 'already-committed', metadata: current };
            }
            if (
                expectedSourceSessionId !== undefined
                && current.materializationSourceSessionId !== expectedSourceSessionId
            ) {
                return { status: 'source-mismatch' };
            }

            const patch: Partial<SessionMetadata> = {
                materializationState: undefined,
                materializationSourceSessionId: undefined,
                lastMessagePreview: params.lastMessagePreview,
            };
            const canSetDefaultTitle = current.title === 'New Chat' && current.titleSource !== 'user';
            if (canSetDefaultTitle && title && title !== current.title) {
                patch.title = title;
                patch.titleSource = 'default';
            }
            if (!current.origin && params.origin) {
                patch.origin = params.origin;
            }

            const updated: SessionMetadata = { ...current, ...patch };
            all[idx] = updated;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return { status: 'claimed', metadata: updated };
        });
    } catch (error) {
        console.error(`[SessionStore] Failed prepared turn-admission claim for ${sessionId}:`, error);
        return { status: 'io-error' };
    }
}

export async function removeMcpServerFromSessionSnapshots(serverId: string): Promise<number> {
    ensureStorageDir();
    let updatedCount = 0;
    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const next = all.map(session => {
            if (!Array.isArray(session.mcpEnabledServers) || !session.mcpEnabledServers.includes(serverId)) {
                return session;
            }
            updatedCount++;
            return {
                ...session,
                mcpEnabledServers: session.mcpEnabledServers.filter(id => id !== serverId),
            };
        });

        if (updatedCount === 0) {
            return;
        }
        atomicWriteSessionsFile(JSON.stringify(next, null, 2));
    });
    return updatedCount;
}

/**
 * Create a new session for the given agent directory.
 *
 * `snapshot` is the partial SessionMetadata produced by the caller (typically via
 * `snapshotForOwnedSession()` for Desktop/Cron or `snapshotForImSession()` for IM).
 * Hand-assembling fields here is forbidden — go through the helpers in
 * `utils/session-snapshot.ts` so a new field added later cannot silently bypass
 * snapshot capture (PRD §6.2 pit-of-success).
 */
export async function createSession(agentDir: string, snapshot?: Partial<SessionMetadata>): Promise<SessionMetadata> {
    const session = createSessionMetadata(agentDir, snapshot);
    await saveSessionMetadata(session);
    console.log(`[SessionStore] Created session ${session.id} for ${agentDir} runtime=${session.runtime} configSnapshot=${session.configSnapshotAt ? 'yes' : 'no'}`);
    return session;
}

/**
 * Update session title from first message if needed
 */
export async function updateSessionTitleFromMessage(sessionId: string, message: string): Promise<void> {
    const session = getSessionMetadata(sessionId);
    if (!session || session.title !== 'New Chat') {
        return;
    }

    const title = generateSessionTitle(message);
    await updateSessionMetadata(sessionId, { title, titleSource: 'default' });
}

/**
 * Save attachment data to disk
 * @returns Relative path to the attachment
 */
export function saveAttachment(
    sessionId: string,
    attachmentId: string,
    fileName: string,
    base64Data: string,
    mimeType: string
): string {
    ensureStorageDir();

    // Create session-specific attachments directory
    const sessionAttachmentsDir = join(ATTACHMENTS_DIR, sessionId);
    if (!existsSync(sessionAttachmentsDir)) {
        ensureDirSync(sessionAttachmentsDir);
    }

    // Determine file extension
    const ext = mimeType.split('/')[1] || 'bin';
    const safeFileName = `${attachmentId}.${ext}`;
    const filePath = join(sessionAttachmentsDir, safeFileName);

    // Decode base64 and write to file
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        writeFileSync(filePath, buffer);
        console.log(`[SessionStore] Saved attachment: ${filePath}`);
        return `${sessionId}/${safeFileName}`;
    } catch (error) {
        console.error('[SessionStore] Failed to save attachment:', error);
        throw error;
    }
}

/**
 * Get absolute path to attachment
 */
export function getAttachmentPath(relativePath: string): string {
    return join(ATTACHMENTS_DIR, relativePath);
}
