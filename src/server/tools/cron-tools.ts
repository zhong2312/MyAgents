// Cron task context tracking — sidecar-side state for the AI-driven cron flow.
//
// Historical note: this module used to ALSO host an in-process MCP server
// (`cron-tools` with `exit_cron_task`). The MCP was retired in v0.2.11 in
// favour of the universal `myagents task exit` CLI command (`cron exit` remains
// a compatibility alias) + system prompt guidance (see SECTION_TASK_EXIT). The CLI
// handler lives in admin-api.ts::handleCronExit. Rust consumes the request in
// the synchronous Task result and commits the terminal Task state.
//
// What this file still owns: the per-session cron context map. Both the
// permission gate (agent-session.ts) and the CLI exit handler read it to
// decide whether the current session is in a cron run and whether the AI
// is allowed to exit.

// ============= Cron Task Detection Constants =============
// Used by the cron engine to detect AI exit requests in response text.

/** Marker for AI-initiated task completion (legacy format) */
export const CRON_TASK_COMPLETE_MARKER = 'CRON_TASK_COMPLETE';

/** Pattern to match completion marker with reason */
export const CRON_TASK_COMPLETE_PATTERN = /\[CRON_TASK_COMPLETE:\s*(.+?)\]/;

/** Text indicating AI requested task exit via tool */
export const CRON_TASK_EXIT_TEXT = 'Scheduled task exit requested';

/** Pattern to extract exit reason from tool response */
export const CRON_TASK_EXIT_REASON_PATTERN = /Reason:\s*(.+?)(?:\n|$)/;

/**
 * Cron task context for tool execution
 * Uses Map to avoid race conditions when multiple tasks execute concurrently
 * Key: sessionId (or 'default' if not specified)
 */
interface CronTaskContext {
  taskId: string;
  canExit: boolean;
  startedAt: number; // Timestamp for debugging
}

export interface CronTaskExitRequest {
  taskId: string;
  reason: string;
  timestamp: string;
}

const cronTaskContextMap = new Map<string, CronTaskContext>();
const cronTaskExitRequestMap = new Map<string, CronTaskExitRequest>();

// Track the "active" session for backward compatibility
// This is set when setCronTaskContext is called and used by callers that
// don't pass an explicit sessionId (e.g., admin-api.ts::handleCronExit).
let activeSessionKey: string | null = null;

/**
 * Set the current cron task context
 * Called by agent-session before executing a cron task prompt
 * @param taskId - The cron task ID
 * @param canExit - Whether AI is allowed to exit this task
 * @param sessionId - Optional session ID for isolation (defaults to 'default')
 */
export function setCronTaskContext(taskId: string | null, canExit: boolean = false, sessionId?: string): void {
  const key = sessionId || 'default';

  if (taskId === null) {
    // Clear context for this session
    cronTaskContextMap.delete(key);
    if (activeSessionKey === key) {
      activeSessionKey = null;
    }
    console.log(`[cron-tools] Context cleared for session: ${key}`);
  } else {
    // Set context for this session
    cronTaskExitRequestMap.delete(key);
    cronTaskContextMap.set(key, {
      taskId,
      canExit,
      startedAt: Date.now()
    });
    activeSessionKey = key;
    console.log(`[cron-tools] Context set: taskId=${taskId}, canExit=${canExit}, session=${key}`);
  }
}

/**
 * Get the current cron task context
 * @param sessionId - Optional session ID (uses active session if not specified)
 */
export function getCronTaskContext(sessionId?: string): { taskId: string | null; canExit: boolean } {
  const key = sessionId || activeSessionKey || 'default';
  const context = cronTaskContextMap.get(key);

  if (!context) {
    return { taskId: null, canExit: false };
  }

  return { taskId: context.taskId, canExit: context.canExit };
}

export function markCronTaskExitRequested(reason: string, sessionId?: string): CronTaskExitRequest | null {
  const key = sessionId || activeSessionKey || 'default';
  const context = cronTaskContextMap.get(key);
  if (!context) return null;

  const request: CronTaskExitRequest = {
    taskId: context.taskId,
    reason,
    timestamp: new Date().toISOString(),
  };
  cronTaskExitRequestMap.set(key, request);
  return request;
}

export function consumeCronTaskExitRequest(sessionId?: string): CronTaskExitRequest | null {
  const key = sessionId || activeSessionKey || 'default';
  const request = cronTaskExitRequestMap.get(key);
  if (!request) return null;

  cronTaskExitRequestMap.delete(key);
  return request;
}

/**
 * Clear the cron task context
 * Called after task execution completes
 * @param sessionId - Optional session ID (clears active session if not specified)
 */
export function clearCronTaskContext(sessionId?: string): void {
  const key = sessionId || activeSessionKey || 'default';
  cronTaskContextMap.delete(key);

  if (activeSessionKey === key) {
    activeSessionKey = null;
  }

  console.log(`[cron-tools] Context cleared for session: ${key}`);
}

/**
 * Clear all cron task contexts
 * Used for cleanup when sidecar shuts down
 */
export function clearAllCronTaskContexts(): void {
  cronTaskContextMap.clear();
  cronTaskExitRequestMap.clear();
  activeSessionKey = null;
  console.log('[cron-tools] All contexts cleared');
}
