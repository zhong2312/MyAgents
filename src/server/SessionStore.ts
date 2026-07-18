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

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { SessionMetadata, SessionData, SessionMessage, SessionStats } from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import { isSystemMaintenanceSession } from '../shared/managedScheduledJob';
import { stripBom } from '../shared/utils';
import { workspacePathsEqual } from '../shared/workspacePath';
import { ensureDirSync } from './utils/fs-utils';
import { withFileLock } from './utils/file-lock';
import { countNonEmptyJsonlLines } from './utils/jsonl-line-count';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { normalizeSessionRuntimeIdentity } from './utils/session-runtime-identity';

const MYAGENTS_DIR = join(homedir(), '.myagents');
const SESSIONS_FILE = join(MYAGENTS_DIR, 'sessions.json');
const SESSIONS_DIR = join(MYAGENTS_DIR, 'sessions');
const ATTACHMENTS_DIR = join(MYAGENTS_DIR, 'attachments');
const SESSIONS_TMP_FILE = join(MYAGENTS_DIR, 'sessions.json.tmp');
const SESSIONS_LOCK_FILE = join(MYAGENTS_DIR, 'sessions.lock');
const SESSIONS_LOCK_DIR = join(MYAGENTS_DIR, 'session-locks');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * Line count cache for JSONL files
 * Avoids repeated file reads when appending messages
 * Cache is per-process (each Sidecar maintains its own cache)
 */
const lineCountCache = new Map<string, number>();

class CorruptSessionsIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CorruptSessionsIndexError';
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
 * Get cached line count, reading from file only on cache miss
 */
function getCachedLineCount(sessionId: string, filePath: string): number {
    const cached = lineCountCache.get(sessionId);
    if (cached !== undefined) {
        emitPerfTrace({
            trace: 'storage_io',
            phase: 'line_count_cache_hit',
            sessionId,
            count: cached,
            status: 'ok',
        });
        return cached;
    }
    // Cold start: read from file
    const start = nowMs();
    const count = countLinesFromFile(filePath);
    let sizeBytes: number | undefined;
    try {
        sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
    } catch {
        sizeBytes = undefined;
    }
    emitPerfTrace({
        trace: 'storage_io',
        phase: 'line_count_cache_miss',
        sessionId,
        durationMs: elapsedMs(start),
        sizeBytes,
        count,
        status: 'ok',
    });
    lineCountCache.set(sessionId, count);
    return count;
}

/**
 * Update cached line count after appending messages
 */
function incrementLineCount(sessionId: string, delta: number): void {
    const current = lineCountCache.get(sessionId) ?? 0;
    lineCountCache.set(sessionId, current + delta);
}

/**
 * Clear line count cache for a session (on delete)
 */
function clearLineCountCache(sessionId: string): void {
    lineCountCache.delete(sessionId);
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
 * Count lines in a JSONL file by reading the file (internal, use getCachedLineCount for performance)
 */
function countLinesFromFile(filePath: string): number {
    return countNonEmptyJsonlLines(filePath);
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

    try {
        // Read legacy JSON
        const content = readFileSync(legacyPath, 'utf-8');
        const data = JSON.parse(content) as { messages: SessionMessage[] };
        const messages = data.messages ?? [];

        if (messages.length > 0) {
            // Write to JSONL format
            const jsonlContent = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
            writeFileSync(jsonlPath, jsonlContent, 'utf-8');
            console.log(`[SessionStore] Migrated ${messages.length} messages to JSONL: ${sessionId}`);
        }

        // Remove legacy file
        unlinkSync(legacyPath);
        console.log(`[SessionStore] Removed legacy JSON file: ${sessionId}`);

        return messages;
    } catch (error) {
        console.error('[SessionStore] Migration failed:', error);
        return [];
    }
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

/**
 * Delete session metadata and data.
 *
 * `precondition`, when provided, is evaluated inside the sessions lock against
 * the current metadata row before any files or index entries are removed.
 */
export async function deleteSession(
    sessionId: string,
    precondition?: (current: SessionMetadata) => boolean,
): Promise<boolean> {
    ensureStorageDir();

    // Lock order matches saveSessionMessages: per-session file lock OUTER,
    // sessions lock INNER. Taking the file lock here serializes the delete
    // against an in-flight append from another writer of the same session
    // (cross-tab cron, background completion) — previously the unlink could
    // interleave with an append and leave either a half-deleted file or a
    // just-recreated one.
    return withSessionFileLock(sessionId, async () => withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const index = all.findIndex(s => s.id === sessionId);

        if (index < 0) {
            return false; // Not found
        }
        if (precondition && !precondition(all[index])) {
            return false;
        }

        const filtered = all.filter(s => s.id !== sessionId);

        try {
            // Remove the data files FIRST, then the index entry. If we crash
            // between the two steps, the failure mode is "entry present, file
            // gone" — a visible empty session the user can still see and delete
            // again. The previous order (entry first) left "entry gone, file
            // present": an invisible orphan that no UI can reach (issue #336).
            const jsonlFile = getSessionFilePath(sessionId);
            const legacyFile = getLegacySessionFilePath(sessionId);

            if (existsSync(jsonlFile)) {
                unlinkSync(jsonlFile);
            }
            if (existsSync(legacyFile)) {
                unlinkSync(legacyFile);
            }

            // Clear line count cache
            clearLineCountCache(sessionId);

            atomicWriteSessionsFile(JSON.stringify(filtered, null, 2));

            return true;
        } catch (error) {
            console.error('[SessionStore] Failed to delete session:', error);
            return false;
        }
    }));
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

/**
 * Append a single message to session (O(1) operation).
 * Serialized against `saveSessionMessages` and `rewindMessages` via the
 * per-session JSONL lock (Pattern 5 §5.3.3).
 */
export async function appendSessionMessage(sessionId: string, message: SessionMessage): Promise<void> {
    ensureStorageDir();

    const filePath = getSessionFilePath(sessionId);

    try {
        await withSessionFileLock(sessionId, async () => {
            // Index⟺data invariant (issue #336) — same would-create refusal as
            // saveSessionMessages: never mint a JSONL for an unindexed session.
            if (!existsSync(filePath) && !getSessionMetadata(sessionId)) {
                console.warn(`[SessionStore] REFUSING to create JSONL for unindexed session ${sessionId} (appendSessionMessage): no sessions.json entry.`);
                return;
            }
            const line = JSON.stringify(message) + '\n';
            const start = nowMs();
            appendFileSync(filePath, line, 'utf-8');
            emitPerfTrace({
                trace: 'storage_io',
                phase: 'session_jsonl_append',
                sessionId,
                durationMs: elapsedMs(start),
                sizeBytes: Buffer.byteLength(line, 'utf-8'),
                count: 1,
                status: 'ok',
            });
        });
    } catch (error) {
        console.error('[SessionStore] Failed to append message:', error);
    }
}

/**
 * Save session messages using incremental append.
 * Only appends new messages and updates stats incrementally for performance.
 *
 * The stats update is performed inside withSessionsLock to prevent TOCTOU races
 * where another process could modify sessions.json between our read and write.
 */
/**
 * Persist the cumulative message array for a session.
 *
 * `opts.allowShrink` (default true) gates the rewind/retry shrink-rewrite: when
 * `messages.length < existingCount` the file is rewritten to the shorter array
 * (deleting the tail). That is correct for an INTENTIONAL truncation (builtin
 * rewind, external retry) but catastrophic if a caller ever passes a partial /
 * truncated array (e.g. a failed cold-load). Append-only callers MUST pass
 * `allowShrink: false` so a spurious short array refuses to delete on-disk data
 * instead of silently nuking it.
 */
export type SaveSessionMessagesResult =
    | { ok: true; action: 'appended' | 'rewritten' | 'noop'; count: number; totalCount: number }
    | { ok: false; reason: 'unindexed-create-refused'; count: number }
    | { ok: false; reason: 'shrink-refused'; count: number; existingCount: number }
    | { ok: false; reason: 'write-error'; count: number; error: string };

export async function saveSessionMessages(
    sessionId: string,
    messages: SessionMessage[],
    opts?: { allowShrink?: boolean },
): Promise<SaveSessionMessagesResult> {
    const allowShrink = opts?.allowShrink ?? true;
    ensureStorageDir();

    const filePath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    try {
        // Pattern 5: serialize JSONL append/rewrite against any other writer of the
        // same session (cross-tab cron, background completion). Lock hold time is
        // ~1ms per call (single append + sessions.json stats update).
        return await withSessionFileLock(sessionId, async () => {
            // Index⟺data invariant (issue #336): never CREATE a JSONL for a session
            // that has no sessions.json entry. The one real-world producer of that
            // state is deleteSession() racing a live sidecar: the delete removes the
            // entry + unlinks the file, then the owner sidecar's next persist (e.g.
            // resetSession's "persist before clearing") sees existsSync=false →
            // existingCount=0 → re-appends its ENTIRE in-memory array, resurrecting
            // the full file as an invisible orphan (entry gone, data present — the
            // user's session has vanished from every list while 10MB sit on disk).
            // Refusing the would-create write makes deletion final and stops any
            // current or future caller from minting orphans. Appends to an EXISTING
            // unindexed file are still allowed below (legacy orphans keep their data).
            const fileAlreadyExists = existsSync(filePath) || existsSync(legacyPath);
            if (!fileAlreadyExists && !getSessionMetadata(sessionId)) {
                // Include the call stack: this refusal converts a future
                // "caller forgot to register metadata first" ordering bug from
                // an orphan file into a silently dropped first message — the
                // stack is the only way to identify that caller from the log.
                console.warn(`[SessionStore] REFUSING to create JSONL for unindexed session ${sessionId} (${messages.length} in-memory messages): no sessions.json entry (deleted or never registered). Callers must persist metadata BEFORE messages.\n${new Error().stack}`);
                return { ok: false, reason: 'unindexed-create-refused', count: messages.length };
            }

            // Get existing message count (use cached line count for performance)
            let existingCount = 0;

            if (existsSync(filePath)) {
                existingCount = getCachedLineCount(sessionId, filePath);
            } else if (existsSync(legacyPath)) {
                // Migrate first, then get count from new file
                migrateToJsonl(sessionId);
                existingCount = getCachedLineCount(sessionId, filePath);
            }

            // Detect shrink: in-memory messages are fewer than what's on disk.
            // Only an INTENTIONAL truncation (rewind / retry) may rewrite the file
            // to the shorter state. An append-only caller seeing this means its
            // in-memory array is partial (failed/truncated load) — rewriting would
            // delete the on-disk tail, so we refuse and keep the durable copy.
            if (messages.length < existingCount) {
                if (!allowShrink) {
                    console.error(`[SessionStore] REFUSING shrink-rewrite for session ${sessionId}: in-memory ${messages.length} < on-disk ${existingCount} but allowShrink=false (likely a partial/failed load). Keeping the on-disk file intact, skipping write.`);
                    return { ok: false, reason: 'shrink-refused', count: messages.length, existingCount };
                }
                console.log(`[SessionStore] Intentional truncation: messages.length=${messages.length} < existingCount=${existingCount}, rewriting JSONL for session ${sessionId}`);
                const fullContent = messages.map(msg => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : '');
                const rewriteStart = nowMs();
                writeFileSync(filePath, fullContent, 'utf-8');
                emitPerfTrace({
                    trace: 'storage_io',
                    phase: 'session_jsonl_rewrite',
                    sessionId,
                    durationMs: elapsedMs(rewriteStart),
                    sizeBytes: Buffer.byteLength(fullContent, 'utf-8'),
                    count: messages.length,
                    status: 'ok',
                });
                lineCountCache.set(sessionId, messages.length);

                // Recalculate full stats after rewrite
                const fullStats = calculateSessionStats(messages);
                await withSessionsLock(async () => {
                    const all = readSessionsIndexForWrite();
                    const index = all.findIndex(s => s.id === sessionId);
                    if (index < 0) return;
                    const session = all[index];
                    if (index >= 0) {
                        all[index] = { ...session, stats: fullStats };
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                    }
                });
                return { ok: true, action: 'rewritten', count: messages.length, totalCount: messages.length };
            }

            // Only append new messages
            const newMessages = messages.slice(existingCount);

            if (newMessages.length > 0) {
                // Append to JSONL file under the per-session lock acquired above.
                const linesToAppend = newMessages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
                const appendStart = nowMs();
                appendFileSync(filePath, linesToAppend, 'utf-8');
                emitPerfTrace({
                    trace: 'storage_io',
                    phase: 'session_jsonl_append',
                    sessionId,
                    durationMs: elapsedMs(appendStart),
                    sizeBytes: Buffer.byteLength(linesToAppend, 'utf-8'),
                    count: newMessages.length,
                    status: 'ok',
                });
                incrementLineCount(sessionId, newMessages.length);
                console.log(`[SessionStore] Appended ${newMessages.length} new messages (total: ${messages.length})`);

                // Update stats in sessions.json atomically (read + calculate + write under lock)
                const incrementalStats = calculateSessionStats(newMessages);
                await withSessionsLock(async () => {
                    // Read metadata inside the lock to prevent TOCTOU race
                    const all = readSessionsIndexForWrite();
                    const index = all.findIndex(s => s.id === sessionId);
                    if (index < 0) {
                        // Appended to an EXISTING file whose index entry is gone
                        // (legacy orphan / deleted mid-append). Data is preserved but
                        // invisible to every session list — say so instead of silently
                        // diverging (issue #336 family).
                        console.warn(`[SessionStore] appended ${newMessages.length} message(s) to unindexed session ${sessionId} — sessions.json has no entry; stats not updated`);
                        return;
                    }
                    const session = all[index];

                    const existingStats = session.stats ?? {
                        messageCount: 0,
                        totalInputTokens: 0,
                        totalOutputTokens: 0,
                    };
                    const updatedStats: SessionStats = {
                        messageCount: existingStats.messageCount + incrementalStats.messageCount,
                        totalInputTokens: existingStats.totalInputTokens + incrementalStats.totalInputTokens,
                        totalOutputTokens: existingStats.totalOutputTokens + incrementalStats.totalOutputTokens,
                        totalCacheReadTokens: ((existingStats.totalCacheReadTokens ?? 0) + (incrementalStats.totalCacheReadTokens ?? 0)) || undefined,
                        totalCacheCreationTokens: ((existingStats.totalCacheCreationTokens ?? 0) + (incrementalStats.totalCacheCreationTokens ?? 0)) || undefined,
                    };

                    // Write directly (we already hold the lock — don't call saveSessionMetadata which would deadlock)
                    if (index >= 0) {
                        all[index] = { ...session, stats: updatedStats };
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                    }
                });
                return { ok: true, action: 'appended', count: newMessages.length, totalCount: messages.length };
            }

            return { ok: true, action: 'noop', count: 0, totalCount: messages.length };
        });
    } catch (error) {
        console.error('[SessionStore] Failed to save session messages:', error);
        return {
            ok: false,
            reason: 'write-error',
            count: messages.length,
            error: error instanceof Error ? error.message : String(error),
        };
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
