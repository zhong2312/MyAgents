import type { Message } from '@/types/chat';

/**
 * Module-level store for background task (SDK sub-agent) completion statuses.
 *
 * Solves a timing problem: `chat:task-notification` SSE events may fire
 * before the corresponding TaskTool component mounts its event listener.
 * By writing to this Map first, TaskTool can read the status on mount
 * and also subscribe to future changes via the DOM event.
 *
 * Resource management:
 *   - Active (non-terminal) entries live until either the task reaches a
 *     terminal status or `clearAllBackgroundTaskStatuses()` is called on
 *     session boundary transitions.
 *   - Terminal entries are retained for an LRU window (MAX_TERMINAL_RETAINED)
 *     so late-mounting TaskTool components can still read the final state,
 *     then evicted oldest-first. Active entries are never evicted by the LRU.
 *   - Orphan terminal statuses (notification arrived without a prior
 *     task-started registration) are held in a small pool keyed by taskId.
 *     If task-started arrives later with the same taskId, the orphan is
 *     automatically reconciled and dispatched to listeners.
 */

/** Terminal statuses emitted by the SDK's task_notification system messages. */
export type BackgroundTaskTerminalStatus = 'completed' | 'error' | 'failed' | 'stopped';

const TERMINAL: Set<string> = new Set<string>(['completed', 'error', 'failed', 'stopped']);

/** Check whether a status string is terminal (task is done). */
export function isTerminalStatus(status: string | undefined): status is BackgroundTaskTerminalStatus {
    return !!status && TERMINAL.has(status);
}

// ─── Capacity limits ───
//
// A single long session with many sub-agent invocations could otherwise let
// these maps grow unbounded. Active entries are never auto-evicted (they're
// meaningful); terminal entries sit in an LRU window long enough that a
// freshly-mounted TaskTool can still read them.

const MAX_TERMINAL_RETAINED = 128;   // terminal-state entries kept for late mount
const MAX_ORPHAN_RETAINED = 32;      // notification-without-registration pool
const MAX_ACTIVE_SOFT_WARN = 512;    // soft warning threshold for active entries

// ─── Primary state ───

const DEFAULT_SCOPE = '__default__';
const KEY_SEPARATOR = '\u0000';

function scopeFor(sessionId?: string | null): string {
    return sessionId || DEFAULT_SCOPE;
}

function taskKey(sessionId: string | null | undefined, taskId: string): string {
    return `${scopeFor(sessionId)}${KEY_SEPARATOR}${taskId}`;
}

function toolKey(sessionId: string | null | undefined, toolUseId: string): string {
    return `${scopeFor(sessionId)}${KEY_SEPARATOR}${toolUseId}`;
}

function keyPrefix(sessionId: string | null | undefined): string {
    return `${scopeFor(sessionId)}${KEY_SEPARATOR}`;
}

function splitTaskKey(key: string): { scope: string; taskId: string } {
    const idx = key.indexOf(KEY_SEPARATOR);
    if (idx === -1) return { scope: DEFAULT_SCOPE, taskId: key };
    return { scope: key.slice(0, idx), taskId: key.slice(idx + KEY_SEPARATOR.length) };
}

const statuses = new Map<string, string>();                     // scoped taskId → status
const descriptions = new Map<string, string>();                 // scoped taskId → description
const toolUseIdToTaskId = new Map<string, string>();            // scoped toolUseId → taskId
const taskIdToToolUseId = new Map<string, string>();            // scoped taskId → toolUseId
const taskStartedAt = new Map<string, number>();                // scoped taskId → first observed start time
const taskTypes = new Map<string, string>();                    // scoped taskId → SDK task_type

// Insertion-ordered set of taskIds that have reached a terminal state.
// Map preserves insertion order — treating it as an LRU by deleting+re-adding on touch.
const terminalOrder = new Map<string, true>();

// Orphan pool: terminal status arrived before task-started → we have no toolUseId.
// Store by taskId so a later reconcile (when TaskTool provides its own toolUseId)
// can locate it. Map keeps insertion order for eviction.
interface OrphanEntry {
    taskId: string;
    status: string;
}
const orphanByTaskId = new Map<string, OrphanEntry>();

const EVENT_NAME = 'background-task-status';

// ─── Registration (task started) ───

function linkTaskToolUse(taskId: string, toolUseId: string, sessionId?: string | null): void {
    const scopedTaskKey = taskKey(sessionId, taskId);
    const previousToolUseId = taskIdToToolUseId.get(scopedTaskKey);
    if (previousToolUseId && previousToolUseId !== toolUseId) {
        toolUseIdToTaskId.delete(toolKey(sessionId, previousToolUseId));
    }
    toolUseIdToTaskId.set(toolKey(sessionId, toolUseId), taskId);
    taskIdToToolUseId.set(scopedTaskKey, toolUseId);
}

/** Register the toolUseId↔taskId mapping (called when chat:task-started arrives).
 *  Also reconciles any orphan terminal status stored for this taskId. */
export function registerBackgroundTask(
    taskId: string,
    toolUseId: string,
    meta?: { description?: string; taskType?: string },
    sessionId?: string | null,
): void {
    const scopedTaskKey = taskKey(sessionId, taskId);
    linkTaskToolUse(taskId, toolUseId, sessionId);
    if (!taskStartedAt.has(scopedTaskKey)) {
        taskStartedAt.set(scopedTaskKey, Date.now());
    }
    if (meta?.description) {
        descriptions.set(scopedTaskKey, meta.description);
    }
    if (meta?.taskType) {
        taskTypes.set(scopedTaskKey, meta.taskType);
    }

    // Reconcile: if a terminal notification arrived earlier with no toolUseId,
    // promote it to a proper status now and dispatch once so listeners catch up.
    const orphan = orphanByTaskId.get(scopedTaskKey);
    if (orphan) {
        orphanByTaskId.delete(scopedTaskKey);
        applyStatus(taskId, orphan.status, toolUseId, sessionId);
        return;
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { taskId, toolUseId, status: 'started', sessionId: sessionId ?? null },
    }));
}

// ─── Status updates ───

/** Called by TabProvider when `chat:task-started` arrives. Stores description for later display. */
export function setBackgroundTaskDescription(taskId: string, description: string, sessionId?: string | null): void {
    descriptions.set(taskKey(sessionId, taskId), description);
}

/** Read task description (set at task-started time).
 * Accepts either taskId or toolUseId — resolves through the mapping like getBackgroundTaskStatus.
 */
export function getBackgroundTaskDescription(key: string, sessionId?: string | null): string | undefined {
    const taskId = toolUseIdToTaskId.get(toolKey(sessionId, key)) ?? key;
    return descriptions.get(taskKey(sessionId, taskId));
}

/** Called by TabProvider when `chat:task-notification` arrives.
 * @param directToolUseId - toolUseId forwarded from the SSE event (preferred).
 *   Falls back to the mapping registered at task-started time if absent.
 *   If still absent and the status is terminal, the notification is parked
 *   in the orphan pool for later reconciliation via reconcileOrphanForToolUse.
 */
export function setBackgroundTaskStatus(
    taskId: string,
    status: string,
    directToolUseId?: string,
    sessionId?: string | null,
): void {
    const scopedTaskKey = taskKey(sessionId, taskId);
    const toolUseId = directToolUseId ?? taskIdToToolUseId.get(scopedTaskKey);
    if (toolUseId) {
        linkTaskToolUse(taskId, toolUseId, sessionId);
    }

    if (!toolUseId && isTerminalStatus(status)) {
        // No association available — park in orphan pool so a late TaskTool can reconcile.
        // Evict oldest first if pool full.
        if (orphanByTaskId.size >= MAX_ORPHAN_RETAINED) {
            const oldest = orphanByTaskId.keys().next().value;
            if (oldest !== undefined) orphanByTaskId.delete(oldest);
        }
        orphanByTaskId.set(scopedTaskKey, { taskId, status });
        console.warn(
            '[backgroundTaskStatus] Terminal notification for taskId=%s has no toolUseId ' +
            'mapping — parked in orphan pool (%d/%d).',
            taskId, orphanByTaskId.size, MAX_ORPHAN_RETAINED,
        );
        return;
    }

    applyStatus(taskId, status, toolUseId, sessionId);
}

/** Core status-apply path: writes status, updates LRU, dispatches event, enforces caps. */
function applyStatus(taskId: string, status: string, toolUseId: string | undefined, sessionId?: string | null): void {
    const scopedTaskKey = taskKey(sessionId, taskId);
    statuses.set(scopedTaskKey, status);

    if (isTerminalStatus(status)) {
        // Refresh LRU position: delete+re-add so this entry becomes most-recent.
        terminalOrder.delete(scopedTaskKey);
        terminalOrder.set(scopedTaskKey, true);
        enforceTerminalCap(sessionId);
    }

    // Soft warn on active-set inflation — active entries are only cleared by session reset.
    const prefix = keyPrefix(sessionId);
    let activeCount = 0;
    for (const key of statuses.keys()) {
        if (key.startsWith(prefix) && !terminalOrder.has(key)) activeCount++;
    }
    if (activeCount > MAX_ACTIVE_SOFT_WARN) {
        console.warn(
            '[backgroundTaskStatus] Active entries exceed soft cap (%d > %d). Long session?',
            activeCount, MAX_ACTIVE_SOFT_WARN,
        );
    }

    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { taskId, toolUseId, status, sessionId: sessionId ?? null },
    }));
}

/** Evict oldest terminal entries (and their associated metadata) to stay under cap. */
function enforceTerminalCap(sessionId?: string | null): void {
    const prefix = keyPrefix(sessionId);
    const scopedTerminalKeys = Array.from(terminalOrder.keys()).filter(key => key.startsWith(prefix));
    while (scopedTerminalKeys.length > MAX_TERMINAL_RETAINED) {
        const oldestTaskKey = scopedTerminalKeys.shift();
        if (oldestTaskKey === undefined) break;
        terminalOrder.delete(oldestTaskKey);
        statuses.delete(oldestTaskKey);
        descriptions.delete(oldestTaskKey);
        taskStartedAt.delete(oldestTaskKey);
        taskTypes.delete(oldestTaskKey);
        const tuid = taskIdToToolUseId.get(oldestTaskKey);
        taskIdToToolUseId.delete(oldestTaskKey);
        if (tuid) toolUseIdToTaskId.delete(toolKey(sessionId, tuid));
    }
}

// ─── Reads ───

/**
 * Read current status by toolUseId (the key TaskTool components have).
 * Falls back to direct taskId lookup for backward compatibility.
 */
export function getBackgroundTaskStatus(key: string, sessionId?: string | null): string | undefined {
    // Try as toolUseId first (new path), then as taskId (old path / direct)
    const taskId = toolUseIdToTaskId.get(toolKey(sessionId, key)) ?? key;
    return statuses.get(taskKey(sessionId, taskId));
}

export interface BackgroundTaskNotificationRecord {
    taskId: string;
    toolUseId?: string;
    status: string;
    summary?: string;
    description?: string;
}

export function parseBackgroundTaskNotificationContent(content: string): BackgroundTaskNotificationRecord | null {
    const match = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        if (typeof parsed.taskId !== 'string' || typeof parsed.status !== 'string') return null;
        return {
            taskId: parsed.taskId,
            toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : undefined,
            status: parsed.status,
            summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
        };
    } catch {
        return null;
    }
}

export function parseBackgroundTaskNotificationMessage(message: Message): BackgroundTaskNotificationRecord | null {
    if (!message.id.startsWith('task-notification-')) return null;
    if (typeof message.content !== 'string') return null;
    return parseBackgroundTaskNotificationContent(message.content);
}

export function collectCompletedBackgroundToolIdsFromHistory(messages: Message[]): Set<string> {
    const set = new Set<string>();
    for (const message of messages) {
        const record = parseBackgroundTaskNotificationMessage(message);
        if (record?.toolUseId && isTerminalStatus(record.status)) {
            set.add(record.toolUseId);
        }
    }
    return set;
}

/**
 * Rehydrate the process-local status store from persisted hidden notification
 * records. This keeps all UI surfaces on the same background task state after
 * Cmd+R, session restore, or lazy-loading older pages.
 */
export function hydrateBackgroundTaskStatusesFromHistory(messages: Message[], sessionId?: string | null): void {
    for (const message of messages) {
        const record = parseBackgroundTaskNotificationMessage(message);
        if (!record) continue;
        if (record.description) {
            setBackgroundTaskDescription(record.taskId, record.description, sessionId);
        }
        // Persisted rows without toolUseId cannot prove which Task tool they
        // complete after a renderer reload. Do not keep re-parking them as
        // live orphans on every messages change; the server-side history row
        // still preserves the audit text.
        if (!record.toolUseId) continue;
        setBackgroundTaskStatus(record.taskId, record.status, record.toolUseId, sessionId);
    }
}

/**
 * Whether a background task identified by toolUseId has been registered in
 * this renderer's lifetime (i.e., chat:task-started observed).
 *
 * Used by PRD 0.2.17 Agent Status Panel to distinguish three cases that
 * `getBackgroundTaskStatus` cannot:
 *   - undefined + registered  → currently running, no terminal notification yet
 *   - terminal status + registered → completed (within retain window)
 *   - undefined + NOT registered → either never started in this renderer
 *     (e.g., full Cmd+R reload), OR LRU-evicted from the terminal cache.
 *     In both cases we should treat as "not active" — the panel should not
 *     resurrect ancient tasks just because their tool_use blocks live in
 *     session history. (Codex review C3.)
 *
 * Note: `enforceTerminalCap` evicts toolUseIdToTaskId entries for old
 * terminal tasks, so this function naturally stops returning true for them.
 * For genuinely still-running tasks the mapping is never evicted (capping
 * only touches the `terminalOrder` set).
 */
export function isBackgroundTaskRegistered(toolUseId: string, sessionId?: string | null): boolean {
    return toolUseIdToTaskId.has(toolKey(sessionId, toolUseId));
}

export interface ActiveBackgroundTask {
    taskId: string;
    toolUseId: string;
    description?: string;
    taskType?: string;
    startedAt: number;
    status?: string;
}

export function getActiveBackgroundTasks(sessionId?: string | null): ActiveBackgroundTask[] {
    const out: ActiveBackgroundTask[] = [];
    const scope = scopeFor(sessionId);
    for (const [scopedTaskKey, toolUseId] of taskIdToToolUseId) {
        const { scope: taskScope, taskId } = splitTaskKey(scopedTaskKey);
        if (taskScope !== scope) continue;
        const status = statuses.get(scopedTaskKey);
        if (isTerminalStatus(status)) continue;
        out.push({
            taskId,
            toolUseId,
            description: descriptions.get(scopedTaskKey),
            taskType: taskTypes.get(scopedTaskKey),
            startedAt: taskStartedAt.get(scopedTaskKey) ?? Date.now(),
            status,
        });
    }
    return out;
}

/** Clear entries. Pass sessionId on session reset; omit in tests/global teardown. */
export function clearAllBackgroundTaskStatuses(sessionId?: string | null): void {
    if (sessionId === undefined) {
        statuses.clear();
        descriptions.clear();
        toolUseIdToTaskId.clear();
        taskIdToToolUseId.clear();
        taskStartedAt.clear();
        taskTypes.clear();
        terminalOrder.clear();
        orphanByTaskId.clear();
        return;
    }
    const prefix = keyPrefix(sessionId);
    for (const map of [statuses, descriptions, taskIdToToolUseId, taskStartedAt, taskTypes, terminalOrder, orphanByTaskId]) {
        for (const key of Array.from(map.keys())) {
            if (key.startsWith(prefix)) map.delete(key);
        }
    }
    for (const key of Array.from(toolUseIdToTaskId.keys())) {
        if (key.startsWith(prefix)) toolUseIdToTaskId.delete(key);
    }
}

/** Event name for addEventListener — exported to avoid magic strings. */
export const BACKGROUND_TASK_STATUS_EVENT = EVENT_NAME;
