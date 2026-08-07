// Compatibility client for scheduled Tasks. Command names remain `cron`, but
// Rust writes TaskStore and arms TaskSchedulerController.

import { isTauriEnvironment } from '@/utils/browserMock';
import type { CronTask, CronTaskConfig, CronRunRecord, CronSchedule, CronEndConditions, CronDelivery } from '@/types/cronTask';

// Cached invoke function to avoid repeated dynamic imports
let cachedInvoke: typeof import('@tauri-apps/api/core').invoke | null = null;

/**
 * Get the invoke function, caching it for subsequent calls
 */
async function getInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
  if (!cachedInvoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    cachedInvoke = invoke;
  }
  return cachedInvoke;
}

/**
 * Helper to invoke a Tauri command with environment check
 * Throws error if not in Tauri environment
 */
async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) {
    throw new Error('Cron tasks are only available in Tauri environment');
  }
  console.log('[cronTaskClient] invokeCommand:', cmd, args);
  const invoke = await getInvoke();
  console.log('[cronTaskClient] invoke function obtained, calling...');
  const result = await invoke<T>(cmd, args);
  console.log('[cronTaskClient] invoke completed:', cmd);
  return result;
}

/**
 * Helper to invoke a Tauri command with fallback for non-Tauri environment
 * Returns fallback value if not in Tauri environment
 */
async function invokeCommandWithFallback<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  fallback: T
): Promise<T> {
  if (!isTauriEnvironment()) {
    return fallback;
  }
  const invoke = await getInvoke();
  return invoke(cmd, args);
}

// ============= Scheduled Task compatibility operations =============

/** Create a new cron task */
export const createCronTask = (config: CronTaskConfig): Promise<CronTask> =>
  invokeCommand('cmd_create_cron_task', { config });

/** Start a cron task */
export const startCronTask = (taskId: string): Promise<CronTask> =>
  invokeCommand('cmd_start_cron_task', { taskId });

/** Stop a cron task with optional exit reason */
export const stopCronTask = (taskId: string, exitReason?: string): Promise<CronTask> =>
  invokeCommand('cmd_stop_cron_task', { taskId, exitReason });

/** Delete a cron task */
export const deleteCronTask = (taskId: string): Promise<void> =>
  invokeCommand('cmd_delete_cron_task', { taskId });

/** Get a cron task by ID */
export const getCronTask = (taskId: string): Promise<CronTask> =>
  invokeCommand('cmd_get_cron_task', { taskId });

/** Get all cron tasks */
export const getAllCronTasks = (): Promise<CronTask[]> =>
  invokeCommandWithFallback('cmd_get_cron_tasks', undefined, []);

/** Get cron tasks for a specific workspace */
export const getWorkspaceCronTasks = (workspacePath: string): Promise<CronTask[]> =>
  invokeCommandWithFallback('cmd_get_workspace_cron_tasks', { workspacePath }, []);

/** Get active cron task for a session (running only) */
export const getSessionCronTask = (sessionId: string): Promise<CronTask | null> =>
  invokeCommandWithFallback('cmd_get_session_cron_task', { sessionId }, null);

// ============= Background Session Queries =============

/** Get session IDs that have active background completions */
export const getBackgroundSessions = (): Promise<string[]> =>
  invokeCommandWithFallback('cmd_get_background_sessions', undefined, []);

/** Check if a task is currently executing */
export const isTaskExecuting = (taskId: string): Promise<boolean> =>
  invokeCommandWithFallback('cmd_is_task_executing', { taskId }, false);

// ============= Cron Task Run History =============

/** Get execution history (run records) for a cron task */
export const getCronRuns = (taskId: string, limit?: number): Promise<CronRunRecord[]> =>
  invokeCommandWithFallback('cmd_get_cron_runs', { taskId, limit }, []);

// ============= Cron Task Field Updates =============

export interface CronTaskFieldUpdate {
  name?: string;
  prompt?: string;
  schedule?: CronSchedule;
  intervalMinutes?: number;
  endConditions?: CronEndConditions;
  notifyEnabled?: boolean;
  model?: string;
  permissionMode?: string;
  delivery?: CronDelivery;
  clearDelivery?: boolean;
}

export function normalizeCronTaskFieldUpdate(fields: CronTaskFieldUpdate): CronTaskFieldUpdate {
  const normalized = { ...fields };
  if (!normalized.schedule) {
    return normalized;
  }

  if (normalized.schedule.kind === 'every') {
    normalized.intervalMinutes = normalized.schedule.minutes;
  } else {
    delete normalized.intervalMinutes;
  }

  return normalized;
}

/** Update editable fields of a cron task */
export const updateCronTaskFields = (
  taskId: string,
  fields: CronTaskFieldUpdate
): Promise<CronTask> =>
  invokeCommand('cmd_update_cron_task_fields', { taskId, ...normalizeCronTaskFieldUpdate(fields) });
