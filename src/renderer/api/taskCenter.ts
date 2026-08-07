// Task Center API — thin wrappers around Tauri invoke()
// Handles both Tauri (desktop) and browser dev mode (no-op fallback).

import type {
  Thought,
  ThoughtArchiveFilter,
  ThoughtCreateInput,
  ThoughtUpdateInput,
} from '@/../shared/types/thought';
import type {
  Task,
  TaskCreateAttachedInput,
  TaskCreateDirectInput,
  TaskCreateFromAlignmentInput,
  TaskListFilter,
  TaskRunStats,
  TaskTrigger,
  TaskTriggerCheckNowResult,
  TaskTriggerRuntimeState,
  TaskTriggerTestResponse,
  TaskUpdateInput,
  TaskUpdateStatusInput,
} from '@/../shared/types/task';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `Task Center commands require Tauri runtime; ran in browser mode: ${cmd}`,
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ==================== Thoughts ====================

export function thoughtCreate(input: ThoughtCreateInput): Promise<Thought> {
  return inv('cmd_thought_create', { input });
}

export function thoughtList(filter?: {
  tag?: string;
  query?: string;
  limit?: number;
  /**
   * Archive-state view filter (v0.2.16). Omit ≡ `'active'`. Pass `'all'`
   * if the caller really does want both (e.g. search). Bottom line: the
   * default behavior hides archived thoughts.
   */
  archived?: ThoughtArchiveFilter;
}): Promise<Thought[]> {
  return inv('cmd_thought_list', { filter });
}

export function thoughtGet(id: string): Promise<Thought | null> {
  return inv('cmd_thought_get', { id });
}

export function thoughtUpdate(input: ThoughtUpdateInput): Promise<Thought> {
  return inv('cmd_thought_update', { input });
}

export function thoughtDelete(id: string): Promise<void> {
  return inv('cmd_thought_delete', { id });
}

/**
 * Toggle a thought's archive flag (v0.2.16). Idempotent — re-archiving an
 * already-archived thought is a no-op. Returns the updated Thought.
 */
export function thoughtSetArchived(id: string, archived: boolean): Promise<Thought> {
  return inv('cmd_thought_set_archived', { id, archived });
}

/** Per-source delete failure surfaced by `thoughtMerge` — the merge itself
 *  succeeds (the new thought is committed), but the named source's physical
 *  delete failed. The renderer prompts the user to manually clean up. */
export interface MergeSourceDeleteFailure {
  id: string;
  error: string;
}

/** Result of `thoughtMerge`. `merged` is always present; `failedSourceDeletes`
 *  lists any sources whose physical delete failed after the merge committed. */
export interface ThoughtMergeResult {
  merged: Thought;
  failedSourceDeletes: MergeSourceDeleteFailure[];
}

/**
 * Merge multiple thoughts into one new thought, then delete the originals.
 * `sourceIds` MUST be ordered top→bottom as displayed; the merged content
 * is joined with `\n—\n` separators in that order. See PRD 0.2.4 §需求 2.
 *
 * Atomicity: the merged thought is created atomically (pre-flight + tmp/rename).
 * Source deletes are best-effort — partial failures are surfaced via
 * `failedSourceDeletes` rather than rolling back the merge (which would lose
 * already-deleted source data).
 */
export function thoughtMerge(sourceIds: string[]): Promise<ThoughtMergeResult> {
  return inv('cmd_thought_merge', { sourceIds });
}

/** Reveal `~/.myagents/thoughts/` in the OS file manager (Finder/Explorer). */
export function thoughtOpenDir(): Promise<void> {
  return inv('cmd_thought_open_dir');
}

// ==================== Tasks ====================

export function taskCreateDirect(
  input: TaskCreateDirectInput & { taskMdContent: string },
): Promise<Task> {
  return inv('cmd_task_create_direct', { input });
}

export function taskCreateFromAlignment(
  input: TaskCreateFromAlignmentInput & { alignmentSessionId: string },
): Promise<Task> {
  return inv('cmd_task_create_from_alignment', { input });
}

export function taskCreateAttached(input: TaskCreateAttachedInput): Promise<Task> {
  return inv('cmd_task_create_attached', { input });
}

export function taskList(filter?: TaskListFilter): Promise<Task[]> {
  return inv('cmd_task_list', { filter });
}

export function taskGet(id: string): Promise<Task | null> {
  return inv('cmd_task_get', { id });
}

export function taskUpdate(input: TaskUpdateInput): Promise<Task> {
  return inv('cmd_task_update', { input });
}

export function taskTriggerValidate(trigger: TaskTrigger): Promise<TaskTrigger> {
  return inv('cmd_task_trigger_validate', { trigger });
}

export function taskTriggerTestTask(taskId: string): Promise<TaskTriggerTestResponse> {
  return inv('cmd_task_trigger_test', { taskId });
}

export function taskTriggerTestSpec(
  trigger: TaskTrigger,
  workspacePath: string,
  checkpointState?: Pick<
    TaskTriggerRuntimeState,
    'checkpoint' | 'checkpointRevision' | 'checkpointUpdatedAt'
  >,
  ownerTaskId?: string,
): Promise<TaskTriggerTestResponse> {
  return inv('cmd_task_trigger_test', {
    ownerTaskId,
    trigger,
    workspacePath,
    checkpoint: checkpointState?.checkpoint ?? undefined,
    checkpointRevision: checkpointState?.checkpointRevision,
    checkpointUpdatedAt: checkpointState?.checkpointUpdatedAt,
  });
}

export function taskCheckNow(id: string): Promise<TaskTriggerCheckNowResult> {
  return inv('cmd_task_check_now', { id });
}

/** Force one AI turn through the ordinary Task queue without running Detector. */
export function taskRunNow(id: string): Promise<string> {
  return inv('cmd_task_run_now', { id });
}

export function taskResetCheckpoint(id: string): Promise<TaskTriggerRuntimeState> {
  return inv('cmd_task_reset_checkpoint', { id });
}

export function taskUpdateStatus(input: TaskUpdateStatusInput): Promise<Task> {
  return inv('cmd_task_update_status', { input });
}

export function taskUpdateProgress(id: string, message: string): Promise<void> {
  return inv('cmd_task_update_progress', { id, message });
}

export function taskAppendSession(id: string, sessionId: string): Promise<Task> {
  return inv('cmd_task_append_session', { id, sessionId });
}

export function taskArchive(id: string, message?: string): Promise<Task> {
  return inv('cmd_task_archive', { id, message });
}

export function taskDelete(id: string): Promise<void> {
  return inv('cmd_task_delete', { id });
}

/** Names of the markdown documents attached to a Task. */
export type TaskDocName = 'task' | 'verify' | 'progress';

/** Read `.task/<id>/<doc>.md`. Missing files resolve to `""` (not an error). */
export function taskReadDoc(id: string, doc: TaskDocName): Promise<string> {
  return inv('cmd_task_read_doc', { id, doc });
}

/**
 * Write `.task/<id>/<doc>.md`. Allowed for `task` and `verify` only;
 * `progress` is agent-only (the CLI / SDK tool appends during runs).
 * Rejected while the task is running / verifying (PRD §9.4 lock).
 */
export function taskWriteDoc(
  id: string,
  doc: Exclude<TaskDocName, 'progress'>,
  content: string,
): Promise<void> {
  return inv('cmd_task_write_doc', { id, doc, content });
}

/**
 * Reveal `~/.myagents/tasks/<id>/` in the OS file manager. Creates the
 * directory on demand for tasks that haven't written any doc yet.
 * Tauri-only (no browser fallback — the editor surface is desktop).
 */
export function taskOpenDocsDir(id: string): Promise<void> {
  return inv('cmd_task_open_docs_dir', { id });
}

/**
 * Aggregate runtime telemetry for the detail overlay — execution count,
 * last-run result and next trigger. Composed from TaskStore and the run
 * history keyed by the same Task id.
 */
export function taskGetRunStats(id: string): Promise<TaskRunStats> {
  return inv('cmd_task_get_run_stats', { id });
}

// ============================================================
// Search (Task Center — v0.1.69, §13.2)
// ============================================================

export interface ThoughtSearchHit {
  id: string;
  snippet: string;
  tags: string[];
  updatedAt: number;
}

export interface ThoughtSearchResult {
  hits: ThoughtSearchHit[];
  total: number;
}

export interface TaskSearchHit {
  id: string;
  name: string;
  snippet: string;
  status: string;
  workspaceId: string;
  updatedAt: number;
}

export interface TaskSearchResult {
  hits: TaskSearchHit[];
  total: number;
}

export function searchThoughts(
  query: string,
  limit = 50,
): Promise<ThoughtSearchResult> {
  return inv('cmd_search_thoughts', { query, limit });
}

export function searchTasks(
  query: string,
  workspaceId?: string,
  limit = 50,
): Promise<TaskSearchResult> {
  return inv('cmd_search_tasks', { query, workspaceId, limit });
}

// ============================================================
// Execution triggers (renderer → Global Sidecar → Rust Management API)
// ============================================================
//
// `taskRun` / `taskRerun` go through the Admin API path (Node Sidecar forwards
// to Rust `/api/task/run|rerun`) because the execution primitive binds a
// CronTask to the Task Center task and kicks the Rust scheduler. The Tauri
// IPC shortcut (`cmd_task_update_status`) would skip CronTask registration
// and the task would never fire.

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface TaskRunResult {
  task: Task;
  /** One-based ordinal assigned by the Task execution owner after admission. */
  attemptOrdinal: number;
}

async function postAdmin<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { apiPostJson } = await import('@/api/apiFetch');
  const result = await apiPostJson<AdminResponse<T>>(path, body);
  if (!result.success) {
    throw new Error(result.error ?? `${path} failed`);
  }
  return result.data as T;
}

/** Dispatch task execution (PRD §11.1 unified primitive). */
export function taskRun(id: string): Promise<TaskRunResult> {
  return postAdmin('/api/admin/task/run', { id });
}

/** Reset status → todo, then dispatch (PRD §10.2.2 row "rerun"). */
export function taskRerun(id: string): Promise<TaskRunResult> {
  return postAdmin('/api/admin/task/rerun', { id });
}

/** True if the current environment exposes Task Center commands (Tauri-only). */
export function taskCenterAvailable(): boolean {
  return isTauri();
}
