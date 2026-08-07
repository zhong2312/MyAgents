//! Task store for Task Center (v0.1.69).
//!
//! Tasks are workspace-scoped execution units. The primary index lives in
//! `~/.myagents/tasks.jsonl` (one task per line, atomic full-rewrite on change).
//! Associated markdown documents live under `~/.myagents/tasks/<taskId>/{task.md,
//! verify.md, progress.md, alignment.md}` (moved out of the workspace in
//! v0.1.69 — see `task_docs_dir` doc for the rationale). This module
//! manages `task.md` and `progress.md` but treats `verify.md` /
//! `alignment.md` as externally managed (written by `/task-alignment` skill
//! + Agent).
//!
//! See PRD `specs/prd/prd_0.1.69_task_center.md`:
//! - §3.2 — schema
//! - §9.1 — state machine + transitions table
//! - §10.2.1 — `update-status` handler: transition validity, actor/source guard,
//!   atomic history append, side-effect dispatch, progress.md, notification, SSE.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::cron_task::{
    EndConditions as CronEndConditions, RecurringWindow, RunMode as CronRunMode,
};
use crate::task_trigger::{validate_task_trigger, TaskTrigger};
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
use tauri::Emitter;

/// Task-layer `RunMode`. Same semantics as `cron_task::RunMode` but emits PRD-
/// specified kebab-case JSON (`"single-session"` / `"new-session"`). We do NOT
/// reuse `cron_task::RunMode` directly because it emits snake_case which would
/// silently diverge from the TS shared type. Convert at the cron-adapter boundary
/// via `From`/`Into`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskRunMode {
    #[serde(rename = "single-session")]
    SingleSession,
    #[serde(rename = "new-session")]
    NewSession,
}

impl From<CronRunMode> for TaskRunMode {
    fn from(m: CronRunMode) -> Self {
        match m {
            CronRunMode::SingleSession => Self::SingleSession,
            CronRunMode::NewSession => Self::NewSession,
        }
    }
}
impl From<TaskRunMode> for CronRunMode {
    fn from(m: TaskRunMode) -> Self {
        match m {
            TaskRunMode::SingleSession => Self::SingleSession,
            TaskRunMode::NewSession => Self::NewSession,
        }
    }
}

/// Task-layer `EndConditions` — PRD-compatible shape.
///
/// `deadline` is a Unix timestamp in milliseconds (JS `Date.now()` compatible),
/// not a `DateTime<Utc>` like `cron_task::EndConditions`. We convert at the
/// cron-adapter boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    #[serde(default = "default_true")]
    pub ai_can_exit: bool,
}

impl From<CronEndConditions> for TaskEndConditions {
    fn from(c: CronEndConditions) -> Self {
        Self {
            deadline: c.deadline.map(|dt| dt.timestamp_millis()),
            max_executions: c.max_executions,
            ai_can_exit: c.ai_can_exit,
        }
    }
}

impl From<TaskEndConditions> for CronEndConditions {
    fn from(t: TaskEndConditions) -> Self {
        use chrono::TimeZone;
        Self {
            deadline: t
                .deadline
                .and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()),
            max_executions: t.max_executions,
            ai_can_exit: t.ai_can_exit,
        }
    }
}

// ================ Enums ================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    Running,
    Verifying,
    Done,
    Blocked,
    Stopped,
    Archived,
    /// Pseudo-state used ONLY as the `to` field of a soft-delete audit entry
    /// (PRD §10.2.2). Never a legal transition target via `update_status`;
    /// only `delete()` may write it. A Task whose `status` equals `Deleted`
    /// is equivalent to `deleted=true` and is filtered out of all list
    /// queries by default.
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskExecutionTrigger {
    Scheduled,
    Manual,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskExecutionTerminalTransition {
    pub status: TaskStatus,
    pub message: String,
    pub source: TransitionSource,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Archived => "archived",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionActor {
    System,
    User,
    Agent,
}

impl TransitionActor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionSource {
    Cli,
    Ui,
    Watchdog,
    Crash,
    Scheduler,
    EndCondition,
    Rerun,
    /// Task was created by the backend Legacy Cron migration. Rendered in the status-
    /// history panel so the user can tell upgrade-originated tasks from
    /// user-authored ones.
    Migration,
}

impl TransitionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Ui => "ui",
            Self::Watchdog => "watchdog",
            Self::Crash => "crash",
            Self::Scheduler => "scheduler",
            Self::EndCondition => "endCondition",
            Self::Rerun => "rerun",
            Self::Migration => "migration",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionMode {
    Once,
    Scheduled,
    Recurring,
    /// Read-only compatibility value. New creation/update rejects it.
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutor {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskDispatchOrigin {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "ai-aligned")]
    AiAligned,
    #[serde(rename = "attached-session")]
    AttachedSession,
}

// ================ Struct ================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTransition {
    /// `None` represents the implicit pre-creation state.
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    pub at: i64,
    pub actor: TransitionActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TransitionSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub desktop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_thread: Option<String>,
    /// Defaults to `['done', 'blocked', 'endCondition']` when absent; keep as
    /// `Option<Vec>` so omitted-means-default is distinguishable from explicit empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<String>>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            desktop: true,
            bot_channel_id: None,
            bot_thread: None,
            events: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum NotificationFieldPatch<T> {
    Unchanged,
    Clear,
    Set(T),
}

impl<T> Default for NotificationFieldPatch<T> {
    fn default() -> Self {
        Self::Unchanged
    }
}

impl<'de, T> Deserialize<'de> for NotificationFieldPatch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Clear,
        })
    }
}

/// Task-specific partial notification mutation. Missing fields are unchanged;
/// explicit null clears the field to its domain default.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationPatch {
    #[serde(default)]
    desktop: NotificationFieldPatch<bool>,
    #[serde(default)]
    bot_channel_id: NotificationFieldPatch<String>,
    #[serde(default)]
    bot_thread: NotificationFieldPatch<String>,
    #[serde(default)]
    events: NotificationFieldPatch<Vec<String>>,
}

impl TaskNotificationPatch {
    fn is_empty(&self) -> bool {
        matches!(self.desktop, NotificationFieldPatch::Unchanged)
            && matches!(self.bot_channel_id, NotificationFieldPatch::Unchanged)
            && matches!(self.bot_thread, NotificationFieldPatch::Unchanged)
            && matches!(self.events, NotificationFieldPatch::Unchanged)
    }

    fn apply(self, existing: Option<NotificationConfig>) -> NotificationConfig {
        let mut notification = existing.unwrap_or_default();
        match self.desktop {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.desktop = true,
            NotificationFieldPatch::Set(value) => notification.desktop = value,
        }
        match self.bot_channel_id {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.bot_channel_id = None,
            NotificationFieldPatch::Set(value) => notification.bot_channel_id = Some(value),
        }
        match self.bot_thread {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.bot_thread = None,
            NotificationFieldPatch::Set(value) => notification.bot_thread = Some(value),
        }
        match self.events {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.events = None,
            NotificationFieldPatch::Set(value) => notification.events = Some(value),
        }
        notification
    }
}

fn default_true() -> bool {
    true
}

fn default_task_executor_agent() -> TaskExecutor {
    TaskExecutor::Agent
}

pub const MANAGED_KIND_MEMORY_GARDENER: &str = "memory_gardener";
pub const MANAGED_KIND_MEMORY_MOLT: &str = "memory_molt";
pub const MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH: &str = "memory_auto_update_batch";
pub const MANAGED_TASK_ERROR: &str =
    "Managed scheduled jobs are internal and cannot be managed from ordinary Task surfaces";

pub fn is_supported_managed_kind(kind: &str) -> bool {
    matches!(
        kind.trim(),
        MANAGED_KIND_MEMORY_GARDENER
            | MANAGED_KIND_MEMORY_MOLT
            | MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH
    )
}

pub fn is_managed_task(task: &Task) -> bool {
    task.managed_kind
        .as_deref()
        .is_some_and(is_supported_managed_kind)
}

fn reject_managed_kind_from_ordinary_create(kind: &Option<String>) -> Result<(), String> {
    if kind.as_deref().is_some_and(|raw| !raw.trim().is_empty()) {
        return Err(MANAGED_TASK_ERROR.to_string());
    }
    Ok(())
}

fn validate_ordinary_caller_origin(
    actor: TransitionActor,
    source: Option<TransitionSource>,
) -> Result<(), String> {
    match (actor, source) {
        (TransitionActor::User, Some(TransitionSource::Ui | TransitionSource::Cli))
        | (TransitionActor::Agent, Some(TransitionSource::Cli)) => Ok(()),
        (TransitionActor::System, _) => {
            Err("ordinary Task mutations cannot claim system authority".to_string())
        }
        (TransitionActor::Agent, _) => Err(String::from(TaskOpError::agent_source_must_be_cli())),
        (TransitionActor::User, _) => {
            Err("user Task mutations require source=ui or source=cli".to_string())
        }
    }
}

fn normalize_managed_kind(kind: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = kind else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if is_supported_managed_kind(trimmed) {
        Ok(Some(trimmed.to_string()))
    } else {
        Err(format!("unsupported managedKind: {}", trimmed))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskExternalSourceType {
    #[serde(rename = "space-issue")]
    SpaceIssue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskExternalSource {
    #[serde(rename = "type")]
    pub source_type: TaskExternalSourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    pub issue_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub workspace_id: String,
    /// Absolute path to the workspace — Sidecar cwd and AI-bash base. Task
    /// docs live in `~/.myagents/tasks/<id>/` (user-scoped, v0.1.69+), not
    /// here. Stored so UI and execution don't have to resolve it separately.
    #[serde(default)]
    pub workspace_path: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_conditions: Option<TaskEndConditions>,
    /// Recurring-mode fixed interval (minutes). Set when
    /// `execution_mode == Recurring` and `cron_expression` is absent. The
    /// Task scheduler reads this field directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Advanced-mode cron expression (takes precedence over
    /// `interval_minutes` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
    /// IANA timezone id for `cron_expression` (e.g. `Asia/Shanghai`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_timezone: Option<String>,
    /// Optional first-fire timestamp for recurring tasks. Stored as RFC3339
    /// and used by tasks that should arm without firing immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    /// Optional wall-clock window used to catch up missed anchored recurring
    /// runs without waiting for another full interval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring_window: Option<RecurringWindow>,
    /// Dedicated "when to fire" timestamp for `Scheduled` mode
    /// (ms since epoch). Decouples from `end_conditions.deadline`,
    /// which semantically means "when to stop running".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_at: Option<i64>,
    /// Optional persisted trigger configuration. Missing means effective
    /// time/always without rewriting legacy Task rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<TaskTrigger>,
    /// Per-task model override used when the Task creates an execution Session.
    /// Existing Sessions keep their own model authority.
    ///
    /// PRD 0.2.9 pairing rule (asymmetric, by design): when `provider_id`
    /// is set, `model` MUST also be set (validated by
    /// `validate_task_provider_routing`) — provider-without-model would
    /// silently route the picked provider's API to the agent's default
    /// model and reproduce the cross-provider misroute that #130 surfaced.
    /// The reverse is intentionally NOT rejected: model-only means "use
    /// the Agent's currently-resolved provider but override model id",
    /// reachable from the CLI / management API for legacy / advanced use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. When `None` the Task
    /// follows the workspace agent. When set,
    /// the sidecar live-resolves env on every tick from
    /// `~/.myagents/config.json`, so credential rotation propagates without
    /// a re-save and credential copies never land in `tasks.jsonl` /
    /// the legacy Cron store.
    ///
    /// Mutually exclusive with `runtime ∈ {claude-code, codex, gemini}`
    /// (external runtimes manage their own provider) — enforced by
    /// `validate_task_provider_routing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Per-task permission mode override (auto / plan / fullAgency / custom).
    /// When `None`, the linked Agent's default is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// For `single-session` run mode: id of a pre-existing SDK session to
    /// continue instead of minting a fresh uuid on first dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preselected_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4). When `None`
    /// the executor falls back to the Agent workspace's `mcpEnabledServers`.
    /// `Some(vec![])` means "explicitly run with no MCP servers".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker. Hidden from ordinary Task Center
    /// lists, but kept in task history/session records for auditability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<i64>,
    /// Last timer-driven execution. Manual `run-now` updates
    /// `last_executed_at` for audit/UI but must not move the recurring timer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scheduled_at: Option<i64>,
    #[serde(default)]
    pub execution_count: u32,
    /// Durable receipt for the most recently admitted command-trigger event.
    /// It closes the cross-file crash window between Task outcome accounting
    /// and clearing the Trigger outbox. Startup may safely settle a matching
    /// pending event without admitting a second AI turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activation_event_id: Option<String>,
    #[serde(default)]
    pub status_history: Vec<StatusTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,
    pub dispatch_origin: TaskDispatchOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_source: Option<TaskExternalSource>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

impl Task {
    pub fn effective_trigger(&self) -> TaskTrigger {
        self.trigger.clone().unwrap_or_default()
    }
}

pub(crate) fn task_bound_session_ids(task: &Task) -> Vec<String> {
    let mut session_ids = task.session_ids.clone();
    if let Some(session_id) = task.preselected_session_id.as_ref() {
        session_ids.push(session_id.clone());
    }
    session_ids.retain(|session_id| !session_id.trim().is_empty());
    session_ids.sort();
    session_ids.dedup();
    session_ids
}

pub(crate) fn task_protected_session_ids(task: &Task) -> Vec<String> {
    if task.deleted {
        return Vec::new();
    }
    let protects_identity = if task.dispatch_origin == TaskDispatchOrigin::AttachedSession {
        matches!(
            task.status,
            TaskStatus::Todo
                | TaskStatus::Running
                | TaskStatus::Verifying
                | TaskStatus::Blocked
                | TaskStatus::Stopped
        )
    } else {
        task.status == TaskStatus::Running && task.run_mode == Some(TaskRunMode::SingleSession)
    };
    if protects_identity {
        task_bound_session_ids(task)
    } else {
        Vec::new()
    }
}

pub(crate) fn task_protects_session_identity(task: &Task, session_id: &str) -> bool {
    task_protected_session_ids(task)
        .iter()
        .any(|value| value == session_id)
}

/// Absolute paths to a task's markdown documents. Returned by `cmd_task_get`
/// as a sibling of `Task` so the CLI / AI can read & edit the docs directly
/// via standard file-system tools (Read / Edit / Write) without having to
/// re-derive the paths from `task_docs_dir()`'s convention. Single source of
/// truth for "where do the task docs live" — callers never guess the layout.
///
/// A doc path is only included when the file actually exists on disk
/// (except `task_md`, which is always created at task creation time and is
/// therefore always surfaced). This lets the consumer distinguish "AI has
/// started working" (progress.md / verify.md present) from "fresh task"
/// without a second `fs.exists()` round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDocs {
    /// Absolute path to the task's docs directory.
    pub dir: String,
    /// task.md — always created at task creation; always surfaced.
    pub task_md: String,
    /// verify.md — present when the AI or user has written verification rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_md: Option<String>,
    /// progress.md — present when the AI has started recording execution progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_md: Option<String>,
    /// alignment.md — present when the task was created via /task-alignment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment_md: Option<String>,
}

/// Build a [`TaskDocs`] for a task id by resolving `task_docs_dir()` and
/// checking the on-disk existence of each optional doc file.
pub fn build_task_docs(task_id: &str) -> Result<TaskDocs, String> {
    let dir = task_docs_dir(task_id)?;
    let dir_str = dir.to_string_lossy().into_owned();
    let file_if_exists = |name: &str| -> Option<String> {
        let p = dir.join(name);
        if p.exists() {
            Some(p.to_string_lossy().into_owned())
        } else {
            None
        }
    };
    Ok(TaskDocs {
        dir: dir_str,
        task_md: dir.join("task.md").to_string_lossy().into_owned(),
        verify_md: file_if_exists("verify.md"),
        progress_md: file_if_exists("progress.md"),
        alignment_md: file_if_exists("alignment.md"),
    })
}

/// Response shape for `cmd_task_get` — flattens [`Task`] and adjoins a
/// computed [`TaskDocs`]. `#[serde(flatten)]` keeps the JSON shape
/// backwards-compatible (all prior Task fields appear at the top level);
/// only `docs` is new. Consumers that don't know about `docs` ignore it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWithDocs {
    #[serde(flatten)]
    pub task: Task,
    pub docs: TaskDocs,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<crate::task_scheduler::TaskExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_state: Option<crate::task_trigger::TaskTriggerRuntimeState>,
    /// Computed by the scheduler authority; never persisted on the Task row.
    pub next_execution_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjection {
    #[serde(flatten)]
    pub task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<crate::task_scheduler::TaskExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_error: Option<String>,
    /// Computed by the scheduler authority; never persisted on the Task row.
    pub next_execution_at: Option<i64>,
}

impl TaskProjection {
    fn new(task: Task, execution: Option<crate::task_scheduler::TaskExecutionProjection>) -> Self {
        let next_execution_at = crate::task_scheduler::next_execution_at(&task)
            .ok()
            .flatten()
            .map(|value| value.timestamp_millis());
        Self {
            task,
            execution_state: execution.as_ref().map(|value| value.state),
            execution_error: execution.and_then(|value| value.error),
            next_execution_at,
        }
    }
}

pub(crate) async fn project_task(task: Task) -> TaskProjection {
    let execution = crate::task_scheduler::get_task_scheduler()
        .execution_projection(&task.id)
        .await;
    TaskProjection::new(task, execution)
}

/// Lightweight list projection. Trigger runtime diagnostics intentionally stay
/// on the per-id get path so one large or corrupt state file cannot fail a
/// collection read.
pub(crate) async fn project_task_list(tasks: Vec<Task>) -> Vec<TaskProjection> {
    let executions = crate::task_scheduler::get_task_scheduler()
        .execution_projections_snapshot()
        .await;
    tasks
        .into_iter()
        .map(|task| {
            let execution = executions.get(&task.id).cloned();
            TaskProjection::new(task, execution)
        })
        .collect()
}

// ================ Input DTOs ================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateDirectInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    /// Contents of `task.md` — the "executor" prompt that will be sent on dispatch.
    pub task_md_content: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields (v0.1.69 unified model) ────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub recurring_window: Option<RecurringWindow>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    #[serde(default)]
    pub trigger: Option<TaskTrigger>,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. MUST be paired with
    /// `model` (validated by `validate_task_provider_routing`).
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker. Only a small allow-list is accepted.
    #[serde(default)]
    pub managed_kind: Option<String>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateFromAlignmentInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    /// Optional from v0.1.69 — when missing, read from the alignment dir's
    /// `metadata.json` (written at the 「AI 讨论」 launch point). Lets the
    /// AI caller pass just `--name` and inherit the rest from session
    /// metadata instead of re-typing 3 long UUIDs.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// Source directory `~/.myagents/tasks/<alignmentSessionId>/` — its
    /// contents are moved (renamed) to `~/.myagents/tasks/<newTaskId>/`.
    pub alignment_session_id: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    #[serde(default)]
    pub trigger: Option<TaskTrigger>,
    // ── Execution overrides (must stay in lockstep with TaskCreateDirectInput) ──
    // Without these fields the Bun admin-api would accept `--model` /
    // `--permissionMode` flags from the CLI, validate them, enrich the success
    // response as if the override took effect — and then serde would silently
    // drop the keys here, leaving the persisted Task with `None` for both.
    // That's exactly the silent-data-loss bug the cross-review flagged.
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. MUST be paired with
    /// `model` (validated by `validate_task_provider_routing`).
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub enum TaskCreateAttachedSource {
    #[serde(rename = "space-issue")]
    SpaceIssue,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateAttachedInput {
    pub name: String,
    #[serde(default = "default_task_executor_agent")]
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    pub task_md_content: String,
    pub current_session_id: String,
    pub source: TaskCreateAttachedSource,
    #[serde(default)]
    pub source_space_id: Option<String>,
    pub source_issue_id: String,
    #[serde(default)]
    pub source_claim_id: Option<String>,
    #[serde(default)]
    pub source_delivery_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

/// Sidecar metadata persisted to `~/.myagents/tasks/<alignmentSessionId>/metadata.json`
/// at the moment the 「AI 讨论」 flow creates the alignment session. Lets
/// `create_from_alignment` inherit the workspace + thought ids without the
/// AI caller having to re-pass them through the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentSessionMetadata {
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub executor: Option<TaskExecutor>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<TaskExecutionMode>,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields ────────────────────────────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub recurring_window: Option<RecurringWindow>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    #[serde(default)]
    pub trigger: Option<TaskTrigger>,
    #[serde(default)]
    pub clear_trigger: bool,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override.
    ///
    /// On update semantics: `None` means "leave provider_id unchanged" (omitted
    /// in JSON or sent as `null` — serde collapses both to `None` here, so
    /// `null-as-clear` is NOT a thing for this field, contrary to a stale
    /// earlier doc revision). To clear the override, callers MUST use
    /// `clear_provider_override: true` (below), which atomically resets both
    /// `provider_id` and `model` to `None`. Validated by
    /// `validate_task_provider_routing`.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// PRD 0.2.9 — Explicit "clear all builtin-runtime overrides" flag. When
    /// true, `provider_id` and `model` are both reset to `None` regardless
    /// of what the corresponding fields above carry. Lets the renderer's
    /// "跟随 Agent" picker option round-trip cleanly without inventing a
    /// double-Option serde shape.
    #[serde(default)]
    pub clear_provider_override: bool,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// PRD #131 / Codex-review #2 — symmetric "clear runtime override"
    /// flag. When true, `runtime` AND `runtime_config` are both reset to
    /// `None` regardless of what the corresponding fields above carry.
    /// Without this, the renderer's "跟随 Agent" runtime option could
    /// not round-trip a clear: `runtime: undefined` over JSON deserializes
    /// to `None`, but the apply path uses `if let Some(v) = input.runtime`
    /// which leaves the existing override untouched. Mirrors the
    /// established pattern from `clear_provider_override`.
    #[serde(default)]
    pub clear_runtime_override: bool,
    /// Per-task MCP enable list override. `Some(vec![])` means explicitly no
    /// MCP; `None` = leave existing override untouched.
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Reset MCP override to follow Agent/workspace. This is separate from
    /// `mcp_enabled_servers = Some(vec![])`, which is now a real explicit
    /// "no MCP" state.
    #[serde(default)]
    pub clear_mcp_override: bool,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
    /// Field-level notification update merged under the same Task write lock.
    /// Kept separate from full `notification` replacement so existing GUI
    /// callers retain their exact contract.
    #[serde(default)]
    pub notification_patch: Option<TaskNotificationPatch>,
    /// When `Some`, the new contents are atomically written to
    /// `~/.myagents/tasks/<id>/task.md` under the same write lock that persists the
    /// JSONL row. Empty string is rejected — prompt must have content.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Internal-only status-transition payload. Accepts explicit `actor`/`source`
/// because crash recovery, scheduler ticks, end-condition firing, watchdog,
/// and CLI adapters all need to assert *their* actor — not the client's.
///
/// The public Tauri command uses `UiTaskUpdateStatusInput` which omits these
/// fields and the Tauri layer stamps `actor=user, source=ui` authoritatively
/// (PRD §10.2.1 caller-inference table row 3: UI button → user/ui). This
/// prevents a malicious/buggy renderer from spoofing `actor=agent` or
/// `source=endCondition`.
#[derive(Debug, Clone)]
pub struct TaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub actor: TransitionActor,
    pub source: Option<TransitionSource>,
}

/// Public DTO for the Tauri command. NOT serde-tagged with `actor`/`source` — those
/// are stamped by the command handler from its trusted entry context.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub message: Option<String>,
}

/// Accepts either a single status (`"running"`) or an array (`["running", "done"]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    One(TaskStatus),
    Many(Vec<TaskStatus>),
}

impl StatusFilter {
    fn matches(&self, s: TaskStatus) -> bool {
        match self {
            Self::One(x) => *x == s,
            Self::Many(xs) => xs.iter().any(|x| *x == s),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub status: Option<StatusFilter>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
    #[serde(default)]
    pub include_managed: Option<bool>,
}

// ================ Errors ================

/// Transition-related rejection returned to the caller. Rendered as `{code, message}`
/// so the UI / CLI can branch on `code` rather than string-match messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOpError {
    pub code: String,
    pub message: String,
}

impl TaskOpError {
    fn invalid_transition(from: TaskStatus, to: TaskStatus) -> Self {
        Self {
            code: "invalid_transition".to_string(),
            message: format!(
                "invalid transition from {} to {}",
                from.as_str(),
                to.as_str()
            ),
        }
    }
    fn archive_user_only() -> Self {
        Self {
            code: "archive_user_only".to_string(),
            message: "archive is user-only (PRD §9.1)".to_string(),
        }
    }
    fn agent_source_must_be_cli() -> Self {
        Self {
            code: "agent_source_must_be_cli".to_string(),
            message: "agent transitions must come through CLI (source='cli')".to_string(),
        }
    }
    fn not_found(id: &str) -> Self {
        Self {
            code: "not_found".to_string(),
            message: format!("task not found: {}", id),
        }
    }
    fn already_deleted() -> Self {
        Self {
            code: "already_deleted".to_string(),
            message: "task has been deleted".to_string(),
        }
    }
    fn update_rejected_while_running() -> Self {
        Self {
            code: "update_rejected_running".to_string(),
            message: "cannot edit task fields while running/verifying".to_string(),
        }
    }
}

impl From<TaskOpError> for String {
    fn from(e: TaskOpError) -> Self {
        // When serialized to the CLI / invoke() caller, preserve `code` by
        // embedding a JSON-stringified payload. Callers that just want a message
        // can parse it back; ones that don't care just show it.
        serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
    }
}

// ================ State machine ================

/// The exhaustive transition table from PRD §9.1 (v1.4, with lenient
/// verifying → running). Returns `true` if the transition is legal at the
/// machine level (actor/source guards are applied separately).
pub fn is_transition_legal(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    matches!(
        (from, to),
        // Forward progression
        (Todo, Running)
        | (Running, Verifying)
        | (Running, Done)
        | (Running, Blocked)
        | (Running, Stopped)
        | (Verifying, Running)     // v1.4 lenient mode
        | (Verifying, Done)
        | (Verifying, Blocked)
        | (Verifying, Stopped)
        // Re-run / reset
        | (Blocked, Todo)
        | (Stopped, Todo)
        | (Done, Todo)
        | (Archived, Todo)
        // Archiving
        | (Done, Archived)
    )
}

/// A stop request against an already terminal schedule is idempotent control
/// of its concrete turn, not a second durable status transition. This keeps
/// the original terminal reason (`blocked` / `done` / `archived`) while still
/// providing retry-stop when exact turn confirmation previously failed.
pub(crate) fn is_terminal_execution_stop_request(from: TaskStatus, to: TaskStatus) -> bool {
    to == TaskStatus::Stopped
        && matches!(
            from,
            TaskStatus::Blocked | TaskStatus::Stopped | TaskStatus::Done | TaskStatus::Archived
        )
}

// ================ Store ================

pub struct TaskStore {
    /// taskId → Task (full row)
    inner: Arc<RwLock<HashMap<String, Task>>>,
    jsonl_path: PathBuf,
    /// A malformed store remains read-only so recovery cannot overwrite the
    /// original bytes with an empty or partial map.
    load_error: Option<String>,
    /// User-scoped Task artifact root. In production this is the same
    /// `~/.myagents/tasks/` root used by `task_docs_dir`; deriving it from the
    /// store data dir keeps tests and alternate app data roots isolated.
    task_artifacts_root: PathBuf,
}

impl TaskStore {
    /// Create a new store. Scans disk, runs crash-recovery migration on any
    /// running/verifying rows (PRD §9.1.1), and returns a handle with the live
    /// (post-recovery) map.
    pub fn new(data_dir: PathBuf) -> Self {
        let jsonl_path = data_dir.join("tasks.jsonl");
        let task_artifacts_root = data_dir.join("tasks");
        if let Some(parent) = jsonl_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let (initial, needs_rewrite, load_error) = match Self::load_and_recover(&jsonl_path) {
            Ok((tasks, needs_rewrite)) => (tasks, needs_rewrite, None),
            Err(error) => {
                ulog_error!(
                    "[task] store is corrupt and will remain read-only: {}",
                    error
                );
                (HashMap::new(), false, Some(error))
            }
        };
        // Write back the recovery results synchronously so a second crash doesn't
        // lose the migration. This runs during app `setup()` before any command is
        // dispatchable, so there is no contention.
        if needs_rewrite {
            if let Err(e) = Self::persist_locked(&jsonl_path, &initial) {
                ulog_warn!("[task] crash-recovery persist failed: {}", e);
            } else {
                ulog_info!("[task] startup recovery updates persisted");
            }
        }
        let store = Self {
            inner: Arc::new(RwLock::new(initial)),
            jsonl_path,
            load_error,
            task_artifacts_root,
        };
        store.cleanup_orphaned_trigger_state();
        store
    }

    /// A deleted or non-command Task cannot own Trigger runtime state. The Task
    /// row itself is the durable cleanup obligation, so startup can repair any
    /// interrupted best-effort deletion without a second persisted flag.
    fn cleanup_orphaned_trigger_state(&self) {
        let current = self
            .inner
            .try_read()
            .expect("TaskStore is uncontended during construction")
            .clone();
        for task in current
            .values()
            .filter(|task| task.deleted || !task.effective_trigger().is_command())
        {
            let task_id = &task.id;
            let path = match self.trigger_state_path(task_id) {
                Ok(path) => path,
                Err(error) => {
                    ulog_warn!(
                        "[task] Trigger state cleanup path rejected task={}: {}",
                        task_id,
                        error
                    );
                    continue;
                }
            };
            match fs::remove_file(&path) {
                Ok(()) => {
                    ulog_info!("[task] Trigger state cleanup recovered task={}", task_id);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    ulog_warn!(
                        "[task] Trigger state cleanup will retry on next startup task={}: {}",
                        task_id,
                        error
                    );
                }
            }
        }
    }

    pub(crate) fn trigger_state_path(&self, task_id: &str) -> Result<PathBuf, String> {
        validate_safe_id(task_id, "taskId")?;
        let resolved = self
            .task_artifacts_root
            .join(task_id)
            .join("trigger-state.json");
        if !resolved.starts_with(&self.task_artifacts_root) {
            return Err("trigger state path escaped Task artifact root".to_string());
        }
        Ok(resolved)
    }

    /// Acquire every Session lifecycle that the projected Task state will
    /// protect, then re-read under the TaskStore write lock. Retrying when the
    /// projection changes gives all durable binding mutations one lock order:
    /// Session lifecycle -> TaskStore. Session deletion uses the same order.
    async fn lock_for_session_protection<'a, F>(
        &'a self,
        id: &str,
        protected_after: F,
    ) -> Result<
        (
            tokio::sync::RwLockWriteGuard<'a, HashMap<String, Task>>,
            crate::sidecar::SessionLifecycleGuard,
        ),
        String,
    >
    where
        F: Fn(&Task) -> Vec<String>,
    {
        loop {
            // Do not await lifecycle while holding TaskStore: deletion takes
            // lifecycle first and then reads TaskStore.
            let expected_session_ids = {
                let inner = self.inner.read().await;
                let task = inner
                    .get(id)
                    .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
                protected_after(task)
            };
            let session_refs = expected_session_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            let lifecycle = crate::sidecar::acquire_session_lifecycle(&session_refs).await;
            let inner = self.inner.write().await;
            let current = inner
                .get(id)
                .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
            if protected_after(current) == expected_session_ids {
                return Ok((inner, lifecycle));
            }
            drop(inner);
            drop(lifecycle);
        }
    }

    fn load_and_recover(path: &Path) -> Result<(HashMap<String, Task>, bool), String> {
        let mut map = Self::load_jsonl(path)?;
        let now = now_ms();
        let mut changed = false;
        for task in map.values_mut() {
            if task.last_scheduled_at.is_none() && task.last_executed_at.is_some() {
                task.last_scheduled_at = task.last_executed_at;
                changed = true;
            }
            if !matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
                continue;
            }
            let from = task.status;
            if from == TaskStatus::Running && task.execution_mode == TaskExecutionMode::Loop {
                task.status = TaskStatus::Stopped;
                task.updated_at = now;
                task.status_history.push(StatusTransition {
                    from: Some(from),
                    to: TaskStatus::Stopped,
                    at: now,
                    actor: TransitionActor::System,
                    message: Some("Legacy Loop tasks are retired".to_string()),
                    source: Some(TransitionSource::Migration),
                });
                changed = true;
                continue;
            }
            // Running is the durable "scheduler enabled" state for time-based
            // Tasks, not proof that a turn was in flight. Preserve recurring
            // Tasks and one-shots that have not fired; TaskScheduler rebuilds
            // their only in-memory handle after startup migration.
            let recover_scheduler = from == TaskStatus::Running
                && (task.effective_trigger().is_command()
                    || task.execution_mode == TaskExecutionMode::Recurring
                    || (task.execution_mode == TaskExecutionMode::Scheduled
                        && task.execution_count == 0));
            if recover_scheduler {
                continue;
            }

            task.status = TaskStatus::Blocked;
            task.updated_at = now;
            task.status_history.push(StatusTransition {
                from: Some(from),
                to: TaskStatus::Blocked,
                at: now,
                actor: TransitionActor::System,
                message: Some("上次运行被应用重启中断,可重新派发以继续".to_string()),
                source: Some(TransitionSource::Crash),
            });
            changed = true;
        }
        Ok((map, changed))
    }

    fn load_jsonl(path: &Path) -> Result<HashMap<String, Task>, String> {
        let mut map: HashMap<String, Task> = HashMap::new();
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(map),
            Err(error) => return Err(format!("read {}: {}", path.display(), error)),
        };
        let reader = BufReader::new(file);
        for (i, line) in reader.lines().enumerate() {
            let raw = line.map_err(|error| {
                format!("{} line {} I/O error: {}", path.display(), i + 1, error)
            })?;
            if raw.trim().is_empty() {
                continue;
            }
            let task = serde_json::from_str::<Task>(&raw).map_err(|error| {
                format!("{} line {} malformed: {}", path.display(), i + 1, error)
            })?;
            if map.insert(task.id.clone(), task).is_some() {
                return Err(format!(
                    "{} line {} duplicates an earlier task id",
                    path.display(),
                    i + 1
                ));
            }
        }
        ulog_info!("[task] loaded {} task(s) from disk", map.len());
        Ok(map)
    }

    pub(crate) fn ensure_writable(&self) -> Result<(), String> {
        match self.load_error.as_deref() {
            Some(error) => Err(format!(
                "Task store is read-only because startup validation failed: {error}"
            )),
            None => Ok(()),
        }
    }

    /// Atomically rewrite the jsonl file from the provided map.
    ///
    /// Crash-durable atomic-write pattern: write + `sync_all` the tmp file, then
    /// rename, then fsync the containing directory. On any error the tmp file is
    /// best-effort unlinked. Caller MUST hold `inner.write()`; this function does
    /// not take the lock itself.
    fn persist_locked(path: &Path, map: &HashMap<String, Task>) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create tasks dir: {}", e))?;
        }
        let tmp = path.with_extension("jsonl.tmp");
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| format!("Failed to open tasks tmp: {}", e))?;
            // Deterministic ordering by createdAt for easier diffing.
            let mut rows: Vec<&Task> = map.values().collect();
            rows.sort_by_key(|t| t.created_at);
            for t in rows {
                let line =
                    serde_json::to_string(t).map_err(|e| format!("serialize task: {}", e))?;
                file.write_all(line.as_bytes())
                    .map_err(|e| format!("write task line: {}", e))?;
                file.write_all(b"\n")
                    .map_err(|e| format!("write newline: {}", e))?;
            }
            file.flush()
                .map_err(|e| format!("flush tasks tmp: {}", e))?;
            // Durability: force the tmp file contents to disk BEFORE rename.
            file.sync_all()
                .map_err(|e| format!("sync tasks tmp: {}", e))?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(format!("rename tasks.jsonl: {}", e));
        }
        // Best-effort: fsync the containing directory so the rename is durable.
        // Failure here is logged but not fatal — the rename is already committed
        // at kernel level; dir-fsync is just power-loss insurance.
        if let Some(parent) = path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        ulog_debug!("[task] atomically persisted {} tasks", map.len());
        Ok(())
    }

    // ---- Create ----

    pub async fn create_direct(&self, input: TaskCreateDirectInput) -> Result<Task, String> {
        self.create_direct_with_origin(input, TransitionActor::User, Some(TransitionSource::Ui))
            .await
    }

    pub async fn create_direct_with_origin(
        &self,
        input: TaskCreateDirectInput,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<Task, String> {
        reject_managed_kind_from_ordinary_create(&input.managed_kind)?;
        validate_ordinary_caller_origin(actor, source)?;
        self.create_direct_internal(
            input,
            actor,
            source,
            "created (direct)",
            session_metadata_exists,
        )
        .await
    }

    pub async fn create_system_managed_direct(
        &self,
        input: TaskCreateDirectInput,
    ) -> Result<Task, String> {
        if !input
            .managed_kind
            .as_deref()
            .is_some_and(is_supported_managed_kind)
        {
            return Err("system managed task requires a supported managedKind".to_string());
        }
        self.create_direct_internal(
            input,
            TransitionActor::System,
            Some(TransitionSource::Scheduler),
            "created (system-managed)",
            session_metadata_exists,
        )
        .await
    }

    async fn create_direct_internal<F>(
        &self,
        mut input: TaskCreateDirectInput,
        created_actor: TransitionActor,
        created_source: Option<TransitionSource>,
        created_message: &'static str,
        session_exists: F,
    ) -> Result<Task, String>
    where
        F: FnOnce(&str) -> bool,
    {
        if input.execution_mode == TaskExecutionMode::Loop {
            return Err("Loop task mode is retired; use a Session Goal".to_string());
        }
        // Validate workspace_path + name up front so we don't half-write.
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        validate_new_task_session_binding(input.run_mode, input.preselected_session_id.as_deref())?;
        if let Some(trigger) = input.trigger.as_ref() {
            validate_task_trigger(trigger)?;
        }
        // PRD 0.2.9 — Pin runtime='builtin' when provider_id is set with no
        // explicit runtime (closes the "Agent runtime later flips to
        // external" cross-talk hole). Idempotent.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        // PRD 0.2.9 — Provider routing invariants (pairing + runtime-exclusion).
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        let managed_kind = normalize_managed_kind(input.managed_kind)?;
        // Cron expression validation at the boundary — same contract as
        // `update()`; ensures the scheduler never gets handed a malformed
        // expression that would make it die silently at first fire.
        if let Some(expr) = input.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(expr, input.cron_timezone.as_deref())
                    .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it always passes; the guard is for callers that pass external ids.
        let task_dir = task_docs_dir(&id)?;
        let bound_session_id = if input.run_mode == Some(TaskRunMode::SingleSession) {
            input.preselected_session_id.clone()
        } else {
            None
        };
        let bound_session_refs = bound_session_id
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session_lifecycle =
            crate::sidecar::acquire_session_lifecycle(&bound_session_refs).await;
        if let Some(session_id) = bound_session_id.as_deref() {
            if !session_exists(session_id) {
                return Err(format!(
                    "preselectedSessionId does not reference an existing Session: {}",
                    session_id
                ));
            }
        }

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            start_at: input.start_at,
            recurring_window: input.recurring_window,
            dispatch_at: input.dispatch_at,
            trigger: input.trigger,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            managed_kind,
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            last_scheduled_at: None,
            execution_count: 0,
            last_activation_event_id: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: created_actor,
                message: Some(created_message.to_string()),
                source: created_source,
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            external_source: None,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (fix cross-review C3):
        // if the docs dir is unwritable (disk full, permissions, etc.) the task.md
        // write fails before the JSONL row is durable. Previous ordering left an
        // "orphan JSONL row with no task.md" on disk after restart — a real
        // integrity violation, not just a recoverable hiccup. Worst case now is
        // an orphan empty directory with no JSONL row referencing it, which is
        // harmless (never shows up in list()) and can be swept by a background
        // cleanup job later.
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            // JSONL write failed — roll back the docs dir so we don't leave
            // orphan directories on disk. `remove_dir_all` is best-effort
            // (already-interrupted filesystem may leave stragglers); log and
            // continue so the caller gets the actual error, not a cleanup one.
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        ulog_info!("[task] created direct id={} name={}", id, t.name);

        // Broadcast so every open Task Center panel refreshes (CC review C5).
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": created_actor.as_str(),
                "source": created_source.map(|source| source.as_str()),
                "message": created_message,
                "event": "created",
            }),
        );
        Ok(t)
    }

    /// Create a Task at an explicit initial status, bypassing the default
    /// Todo entry point. Used only by backend Legacy Cron migration, which preserves the
    /// cron's lifecycle state (running crons → Running task, naturally
    /// ended crons → Done, user-paused crons → Stopped) so the Task
    /// Center doesn't spuriously mass-categorise every upgraded row as
    /// 待启动. The status-history entry records `actor=System,
    /// source=Migration` so the audit trail is clear.
    ///
    /// `initial_status` is validated against a whitelist of legitimate
    /// migration targets — the full state-machine alphabet isn't
    /// appropriate here (a migration can't plausibly land in Verifying
    /// or Blocked, and Deleted / Archived aren't reachable via this
    /// path).
    pub async fn create_migrated(
        &self,
        input: TaskCreateDirectInput,
        initial_status: TaskStatus,
        message: String,
    ) -> Result<Task, String> {
        self.create_migrated_with_id(Uuid::new_v4().to_string(), input, initial_status, message)
            .await
    }

    pub async fn create_migrated_with_id(
        &self,
        id: String,
        mut input: TaskCreateDirectInput,
        initial_status: TaskStatus,
        message: String,
    ) -> Result<Task, String> {
        validate_safe_id(&id, "legacy cron id")?;
        validate_task_name(&input.name)?;
        if let Some(trigger) = input.trigger.as_ref() {
            validate_task_trigger(trigger)?;
        }
        // PRD 0.2.9 — Same pin+validate sequence as create_direct.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        let managed_kind = normalize_managed_kind(input.managed_kind)?;
        if !matches!(
            initial_status,
            TaskStatus::Todo
                | TaskStatus::Running
                | TaskStatus::Done
                | TaskStatus::Stopped
                | TaskStatus::Blocked
        ) {
            return Err(format!(
                "invalid migration target status: {}",
                initial_status.as_str()
            ));
        }
        let now = now_ms();
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;

        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it cannot fail; the explicit check is still cheap insurance.
        let task_dir = task_docs_dir(&id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            start_at: input.start_at,
            recurring_window: input.recurring_window,
            dispatch_at: input.dispatch_at,
            trigger: input.trigger,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            managed_kind,
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: initial_status,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            last_scheduled_at: None,
            execution_count: 0,
            last_activation_event_id: None,
            status_history: vec![StatusTransition {
                from: None,
                to: initial_status,
                at: now,
                actor: TransitionActor::System,
                message: Some(message.clone()),
                source: Some(TransitionSource::Migration),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            external_source: None,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (same ordering invariant
        // as create_direct — see fix for C3). Orphan docs dir on JSONL failure is
        // harmless; orphan JSONL row without task.md is an integrity violation.
        let protected_session_ids = task_protected_session_ids(&t);
        let protected_session_refs = protected_session_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session_lifecycle =
            crate::sidecar::acquire_session_lifecycle(&protected_session_refs).await;
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        if let Some(existing) = inner.get(&id) {
            let migrated = existing
                .status_history
                .iter()
                .any(|transition| transition.source == Some(TransitionSource::Migration));
            let same_workspace =
                crate::workspace_path::normalize_workspace_path_identity(&existing.workspace_path)
                    == crate::workspace_path::normalize_workspace_path_identity(&workspace_path);
            if migrated && same_workspace {
                return Ok(existing.clone());
            }
            return Err(format!(
                "Legacy cron id {id} collides with an unrelated Task"
            ));
        }
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] migrated jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        ulog_info!(
            "[task] created migrated id={} name={} status={}",
            id,
            t.name,
            initial_status.as_str()
        );

        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": initial_status.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::System.as_str(),
                "source": TransitionSource::Migration.as_str(),
                "message": message,
                "event": "created",
            }),
        );
        Ok(t)
    }

    pub async fn create_from_alignment(
        &self,
        input: TaskCreateFromAlignmentInput,
    ) -> Result<Task, String> {
        self.create_from_alignment_with_origin(
            input,
            TransitionActor::Agent,
            Some(TransitionSource::Cli),
        )
        .await
    }

    pub async fn create_from_alignment_with_origin(
        &self,
        mut input: TaskCreateFromAlignmentInput,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<Task, String> {
        validate_ordinary_caller_origin(actor, source)?;
        validate_task_name(&input.name)?;
        validate_safe_id(&input.alignment_session_id, "alignmentSessionId")?;
        validate_new_task_session_binding(input.run_mode, input.preselected_session_id.as_deref())?;
        if let Some(trigger) = input.trigger.as_ref() {
            validate_task_trigger(trigger)?;
        }
        // PRD 0.2.9 — Same pin+validate sequence as create_direct.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        // The AI-discussion path (想法 → /task-alignment → create-from-alignment)
        // does not surface schedule fields in its input contract, yet the
        // `executionMode` is passed through unchanged. If we accept recurring /
        // scheduled / loop here we persist a Task with `interval_minutes=None`,
        // `cron_expression=None`, `dispatch_at=None` — a subsequent `task run`
        // fails with "no resolvable schedule" and the user cannot fix it from
        // the CLI (no --cron flag on this subcommand). Gate at the boundary so
        // the error surfaces at creation time with actionable guidance.
        if !matches!(input.execution_mode, TaskExecutionMode::Once) {
            return Err(format!(
                "create-from-alignment only supports executionMode=once; \
                 to set a schedule, create the task and then `myagents task update <id> \
                 --cronExpression <expr>` or use `create-direct` (got {:?})",
                input.execution_mode
            ));
        }

        let src = task_docs_dir(&input.alignment_session_id)?;
        if !src.exists() {
            return Err(format!("alignment dir not found: {}", src.display()));
        }

        // Resolve workspace_id / workspace_path: explicit args win; if missing,
        // try to read `<alignment_dir>/metadata.json` (written at 「AI 讨论」
        // launch time). Falling back to the sidecar file means AI callers can
        // just pass `--name` — no need to re-type UUIDs already baked in at
        // session creation.
        // Distinguish "file missing" from "file corrupt":
        // - missing → fallback to explicit args (the documented happy path)
        // - corrupt → log and fall back, so post-mortem log search reveals
        //   the real cause instead of the misleading "workspaceId missing"
        //   error that would otherwise surface below.
        let meta_path = src.join("metadata.json");
        let metadata: Option<AlignmentSessionMetadata> = match fs::read_to_string(&meta_path) {
            Ok(s) => match serde_json::from_str::<AlignmentSessionMetadata>(&s) {
                Ok(m) => Some(m),
                Err(e) => {
                    ulog_warn!(
                        "[task] alignment metadata.json parse failed at {}: {} — falling back to explicit args",
                        meta_path.display(),
                        e,
                    );
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                ulog_warn!(
                    "[task] alignment metadata.json read failed at {}: {} — falling back to explicit args",
                    meta_path.display(),
                    e,
                );
                None
            }
        };

        let workspace_id = input
            .workspace_id
            .clone()
            .or_else(|| metadata.as_ref().map(|m| m.workspace_id.clone()))
            .ok_or_else(|| {
                "workspaceId missing — pass --workspaceId or ensure alignment metadata.json exists"
                    .to_string()
            })?;
        let raw_workspace_path = input
            .workspace_path
            .clone()
            .or_else(|| metadata.as_ref().map(|m| m.workspace_path.clone()))
            .ok_or_else(|| {
                "workspacePath missing — pass --workspacePath or ensure alignment metadata.json exists"
                    .to_string()
            })?;
        let workspace_path = canonicalize_workspace_path(&raw_workspace_path)?;
        let source_thought_id = input
            .source_thought_id
            .clone()
            .or_else(|| metadata.as_ref().and_then(|m| m.source_thought_id.clone()));

        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let dst = task_docs_dir(&id)?;
        let bound_session_id = if input.run_mode == Some(TaskRunMode::SingleSession) {
            input.preselected_session_id.clone()
        } else {
            None
        };
        let bound_session_refs = bound_session_id
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session_lifecycle =
            crate::sidecar::acquire_session_lifecycle(&bound_session_refs).await;
        if let Some(session_id) = bound_session_id.as_deref() {
            if !session_metadata_exists(session_id) {
                return Err(format!(
                    "preselectedSessionId does not reference an existing Session: {}",
                    session_id
                ));
            }
        }

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: input.trigger,
            // Per-task overrides — surface the CLI-provided values so the
            // execution path in Bun (`/cron/execute-sync` via T15 snapshot
            // resolution) actually picks them up. Prior to v0.1.69's
            // cross-review fixes these were hardcoded `None` which silently
            // dropped every `--model` / `--permissionMode` flag passed to
            // `task create-from-alignment`.
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            managed_kind: None,
            source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            last_scheduled_at: None,
            execution_count: 0,
            last_activation_event_id: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor,
                message: Some("created (ai-aligned)".to_string()),
                source,
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::AiAligned,
            external_source: None,
            deleted: false,
            deleted_at: None,
        };

        // Transactional order (PRD design):
        // 1. Persist the row to jsonl FIRST. If this fails, the alignment dir is
        //    untouched — retry is safe.
        // 2. Move the alignment dir to `~/.myagents/tasks/<newId>/`. If this fails, we unwind
        //    the row from jsonl so the store stays consistent.
        // 3. Swap in-memory state only after both succeed.
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;

        if let Err(e) = move_alignment_dir(&src, &dst) {
            // Roll back jsonl — remove the task row we just persisted.
            next.remove(&id);
            if let Err(persist_err) = Self::persist_locked(&self.jsonl_path, &next) {
                ulog_warn!(
                    "[task] create_from_alignment rollback failed: {} (original error: {})",
                    persist_err,
                    e
                );
            }
            return Err(format!("move alignment dir: {}", e));
        }

        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        ulog_info!("[task] created ai-aligned id={} name={}", id, t.name);

        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "created (ai-aligned)",
                "event": "created",
            }),
        );
        Ok(t)
    }

    pub async fn create_attached(&self, input: TaskCreateAttachedInput) -> Result<Task, String> {
        self.create_attached_with_session_probe(input, session_metadata_exists)
            .await
    }

    async fn create_attached_with_session_probe<F>(
        &self,
        input: TaskCreateAttachedInput,
        session_exists: F,
    ) -> Result<Task, String>
    where
        F: FnOnce(&str) -> bool,
    {
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        validate_safe_id(&input.current_session_id, "currentSessionId")?;
        let task_md_content = input.task_md_content.trim().to_string();
        if task_md_content.is_empty() {
            return Err("taskMdContent is empty".to_string());
        }
        let source_issue_id = input.source_issue_id.trim().to_string();
        if source_issue_id.is_empty() {
            return Err("sourceIssueId is empty".to_string());
        }

        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let task_dir = task_docs_dir(&id)?;
        let external_source = match input.source {
            TaskCreateAttachedSource::SpaceIssue => TaskExternalSource {
                source_type: TaskExternalSourceType::SpaceIssue,
                space_id: input.source_space_id.filter(|s| !s.trim().is_empty()),
                issue_id: source_issue_id,
                claim_id: input.source_claim_id.filter(|s| !s.trim().is_empty()),
                delivery_id: input.source_delivery_id.filter(|s| !s.trim().is_empty()),
            },
        };

        let created_transition = StatusTransition {
            from: None,
            to: TaskStatus::Todo,
            at: now,
            actor: TransitionActor::Agent,
            message: Some("created (attached-session)".to_string()),
            source: Some(TransitionSource::Cli),
        };
        let attached_transition = StatusTransition {
            from: Some(TaskStatus::Todo),
            to: TaskStatus::Running,
            at: now,
            actor: TransitionActor::Agent,
            message: Some("attached to current session".to_string()),
            source: Some(TransitionSource::Cli),
        };

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_thought_id: None,
            session_ids: vec![input.current_session_id.clone()],
            status: TaskStatus::Running,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: Some(now),
            last_scheduled_at: None,
            execution_count: 0,
            last_activation_event_id: None,
            status_history: vec![created_transition, attached_transition],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::AttachedSession,
            external_source: Some(external_source),
            deleted: false,
            deleted_at: None,
        };

        // Session deletion uses this same guard before checking Task/Goal/live
        // owners. Hold it until the attached Task's docs, JSONL row, and
        // in-memory authority all expose the binding atomically.
        let lifecycle =
            crate::sidecar::acquire_session_lifecycle(&[&input.current_session_id]).await;
        if !session_exists(&input.current_session_id) {
            return Err(
                "the attached Session no longer exists; reopen or reclaim the Space work before creating a Task"
                    .to_string(),
            );
        }
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] attached jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(lifecycle);

        ulog_info!(
            "[task] created attached id={} name={} session={}",
            id,
            t.name,
            input.current_session_id
        );
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "created (attached-session)",
                "event": "created",
            }),
        );
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": TaskStatus::Todo.as_str(),
                "to": TaskStatus::Running.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "attached to current session",
            }),
        );
        emit_task_event(
            "task:session-appended",
            serde_json::json!({
                "taskId": t.id,
                "sessionId": input.current_session_id,
            }),
        );
        Ok(t)
    }

    // ---- Read ----

    pub async fn get(&self, id: &str) -> Option<Task> {
        self.inner.read().await.get(id).cloned()
    }

    pub async fn get_ordinary(&self, id: &str) -> Result<Task, String> {
        let task = self
            .get(id)
            .await
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
        if is_managed_task(&task) {
            return Err(MANAGED_TASK_ERROR.to_string());
        }
        Ok(task)
    }

    /// Check-and-write `~/.myagents/tasks/<id>/<filename>` atomically with respect to
    /// the running/verifying lock. The status check and the file write
    /// both happen under the same write lock so a concurrent
    /// `update_status(running)` can't slip in between and let us mutate
    /// a doc on an already-executing task. PRD §9.4.
    ///
    /// On success `updated_at` is bumped so listings re-sort.
    pub async fn write_doc(&self, id: &str, filename: &str, content: &str) -> Result<(), String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(TaskOpError::update_rejected_while_running()));
        }
        // Resolve path through the sandbox guard — rejects id escape.
        let dir = task_docs_dir(&existing.id)?;
        let path = dir.join(filename);

        // Persist the markdown file first. If this fails we haven't
        // touched the JSONL yet, so the store stays consistent.
        write_atomic_text(&path, content)?;

        // Bump `updated_at` and persist under the same lock.
        let mut updated = existing;
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated);
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(())
    }

    pub async fn list(&self, filter: TaskListFilter) -> Vec<Task> {
        let inner = self.inner.read().await;
        let mut out: Vec<Task> = inner.values().cloned().collect();

        if !filter.include_managed.unwrap_or(false) {
            out.retain(|t| !is_managed_task(t));
        }
        if !filter.include_deleted.unwrap_or(false) {
            out.retain(|t| !t.deleted);
        }
        if let Some(ws) = filter.workspace_id.as_deref() {
            out.retain(|t| t.workspace_id == ws);
        }
        if let Some(status_filter) = filter.status.as_ref() {
            out.retain(|t| status_filter.matches(t.status));
        }
        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            out.retain(|t| t.tags.iter().any(|x| x.to_lowercase() == needle));
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub async fn remove_mcp_server_references(&self, server_id: &str) -> Result<usize, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        let mut updated = 0usize;

        for task in next.values_mut() {
            let Some(ids) = task.mcp_enabled_servers.as_mut() else {
                continue;
            };
            let before = ids.len();
            ids.retain(|id| id != server_id);
            if ids.len() != before {
                task.updated_at = now_ms();
                updated += 1;
            }
        }

        if updated == 0 {
            return Ok(0);
        }

        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(updated)
    }

    // ---- Update fields ----

    pub async fn update(&self, input: TaskUpdateInput) -> Result<Task, String> {
        let task_control = crate::task_scheduler::acquire_task_control(&input.id).await;
        self.update_with_task_control_held(input, &task_control)
            .await
    }

    pub(crate) async fn update_with_task_control_held(
        &self,
        input: TaskUpdateInput,
        task_control: &crate::task_scheduler::TaskControlGuard,
    ) -> Result<Task, String> {
        self.update_with_task_control_and_session_probe(
            input,
            task_control,
            session_metadata_exists,
        )
        .await
    }

    async fn update_with_task_control_and_session_probe<F>(
        &self,
        input: TaskUpdateInput,
        _task_control: &crate::task_scheduler::TaskControlGuard,
        session_exists: F,
    ) -> Result<Task, String>
    where
        F: Fn(&str) -> bool,
    {
        if crate::task_scheduler::get_task_scheduler()
            .execution_projection(&input.id)
            .await
            .is_some()
        {
            return Err("cannot edit a Task while its current execution is unresolved".to_string());
        }
        if self
            .get(&input.id)
            .await
            .is_some_and(|task| task.effective_trigger().is_command())
            && self
                .read_trigger_state(&input.id)
                .await?
                .pending_activation
                .is_some()
        {
            return Err(
                "cannot edit a Task while its Activation Event is pending; stop it first"
                    .to_string(),
            );
        }
        self.ensure_writable()?;
        if input
            .run_mode
            .is_some_and(|mode| mode != TaskRunMode::SingleSession)
            && input
                .preselected_session_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(
                "preselectedSessionId is only valid with runMode=single-session".to_string(),
            );
        }
        let projected_run_mode = input.run_mode;
        let projected_preselected_session_id = input.preselected_session_id.clone();
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(&input.id, move |task| {
                let mut projected = task.clone();
                if let Some(value) = projected_run_mode {
                    projected.run_mode = Some(value);
                }
                if let Some(value) = projected_preselected_session_id.as_ref() {
                    projected.preselected_session_id = if value.trim().is_empty() {
                        None
                    } else {
                        Some(value.clone())
                    };
                }
                if projected_run_mode.is_some_and(|mode| mode != TaskRunMode::SingleSession) {
                    projected.preselected_session_id = None;
                }
                let mut protected = task_protected_session_ids(&projected);
                if projected.run_mode == Some(TaskRunMode::SingleSession) {
                    if let Some(session_id) = projected.preselected_session_id.as_ref() {
                        protected.push(session_id.clone());
                        protected.sort();
                        protected.dedup();
                    }
                }
                protected
            })
            .await?;
        let interval_updated = input.interval_minutes.is_some();
        let cron_expression_updated = input.cron_expression.is_some();
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(TaskOpError::update_rejected_while_running()));
        }
        if input.execution_mode == Some(TaskExecutionMode::Loop) {
            return Err("Loop task mode is retired; use a Session Goal".to_string());
        }
        // PRD 0.2.9 invariant 3 — reject contradictory clear-vs-set inputs at
        // the input layer (rather than silently letting the merge order
        // decide). Surfaces client bugs instead of swallowing them.
        if input.clear_provider_override
            && input.provider_id.as_deref().is_some_and(|s| !s.is_empty())
        {
            return Err(
                "providerId 与 clearProviderOverride=true 冲突 — 调用方必须二选一".to_string(),
            );
        }
        if input.clear_mcp_override && input.mcp_enabled_servers.is_some() {
            return Err(
                "mcpEnabledServers 与 clearMcpOverride=true 冲突 — 调用方必须二选一".to_string(),
            );
        }
        if input.notification.is_some() && input.notification_patch.is_some() {
            return Err(
                "notification 与 notificationPatch 不能同时设置 — 调用方必须二选一".to_string(),
            );
        }
        if input.clear_trigger && input.trigger.is_some() {
            return Err("trigger 与 clearTrigger=true 冲突 — 调用方必须二选一".to_string());
        }
        let mut updated = existing.clone();
        if let Some(v) = input.name {
            validate_task_name(&v)?;
            updated.name = v;
        }
        if let Some(v) = input.executor {
            updated.executor = v;
        }
        if let Some(v) = input.description {
            updated.description = Some(v);
        }
        if let Some(v) = input.execution_mode {
            updated.execution_mode = v;
        }
        if let Some(v) = input.run_mode {
            updated.run_mode = Some(v);
        }
        if let Some(v) = input.end_conditions {
            updated.end_conditions = Some(v);
        }
        if let Some(v) = input.interval_minutes {
            updated.interval_minutes = Some(v);
        }
        if let Some(v) = input.cron_expression {
            // Empty string clears — the renderer uses "" to mean "switch back
            // from advanced mode".
            updated.cron_expression = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.cron_timezone {
            updated.cron_timezone = if v.trim().is_empty() { None } else { Some(v) };
        }
        if interval_updated && !cron_expression_updated {
            updated.cron_expression = None;
            updated.cron_timezone = None;
        } else if cron_expression_updated && updated.cron_expression.is_some() {
            updated.interval_minutes = None;
            updated.start_at = None;
            updated.recurring_window = None;
        }
        if let Some(v) = input.start_at {
            updated.start_at = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.recurring_window {
            updated.recurring_window = Some(v);
        }
        if let Some(v) = input.dispatch_at {
            updated.dispatch_at = Some(v);
        }
        if let Some(v) = input.trigger {
            validate_task_trigger(&v)?;
            updated.trigger = Some(v);
        }
        if input.clear_trigger {
            updated.trigger = None;
        }
        if let Some(v) = input.model {
            updated.model = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.provider_id {
            updated.provider_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        // PRD 0.2.9 — Explicit "follow Agent" reset: clears both provider_id
        // and model atomically. Renderer's "跟随 Agent" picker option sends
        // this flag rather than relying on an empty-string round-trip,
        // which would only clear one field if the renderer accidentally
        // omitted the other.
        if input.clear_provider_override {
            updated.provider_id = None;
            updated.model = None;
        }
        if let Some(v) = input.permission_mode {
            updated.permission_mode = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.preselected_session_id {
            updated.preselected_session_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        if input
            .run_mode
            .is_some_and(|mode| mode != TaskRunMode::SingleSession)
        {
            updated.preselected_session_id = None;
        }
        if let Some(v) = input.runtime {
            updated.runtime = Some(v);
        }
        if let Some(v) = input.runtime_config {
            updated.runtime_config = Some(v);
        }
        // PRD #131 / Codex-review #2 — atomic clear of runtime + runtime_config.
        // Applied AFTER the merge so explicit field values get overridden
        // (matches `clear_provider_override` semantics, line above).
        if input.clear_runtime_override {
            updated.runtime = None;
            updated.runtime_config = None;
        }
        if let Some(v) = input.mcp_enabled_servers {
            updated.mcp_enabled_servers = normalize_mcp_override(Some(v));
        }
        if input.clear_mcp_override {
            updated.mcp_enabled_servers = None;
        }
        if let Some(v) = input.tags {
            updated.tags = v;
        }
        if let Some(v) = input.notification {
            updated.notification = Some(v);
        }
        if let Some(patch) = input.notification_patch {
            if !patch.is_empty() {
                updated.notification = Some(patch.apply(updated.notification));
            }
        }
        // PRD 0.2.9 — Pin runtime='builtin' on the merged state when the
        // post-merge shape has provider_id set without an explicit runtime.
        // Mirrors the pin done in create_direct; closes the cross-talk hole.
        pin_runtime_for_provider_id(&updated.provider_id, &mut updated.runtime);
        // Provider routing invariants on merged state. Runs after pin so the
        // external-exclusion rule fires correctly, and after all field merges
        // (including clear_provider_override) so the rules see the actual
        // post-update shape, not the input fragments.
        validate_task_provider_routing(&updated.provider_id, &updated.model, &updated.runtime)?;
        updated.updated_at = now_ms();

        // Mode-transition hygiene: `run_mode` / `end_conditions` / the
        // schedule-detail fields are only meaningful for certain execution
        // modes. When the user flips `execution_mode → Once`, lingering
        // recurring/scheduled fields would leave an invalid Task schedule.
        // `TaskUpdateInput` uses `Option<T>` so the client can't express
        // "clear me", so we clear server-side the moment the mode no longer
        // needs them.
        match updated.execution_mode {
            TaskExecutionMode::Once => {
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                updated.start_at = None;
                updated.recurring_window = None;
                updated.dispatch_at = None;
            }
            TaskExecutionMode::Scheduled => {
                // Scheduled only needs dispatch_at; clear recurring knobs.
                // Also strip any legacy `endConditions.deadline` that a
                // pre-v0.1.69 row might be carrying — once dispatch_at is
                // populated (either by the user editing or by the
                // legacy-upgrade path), the deadline has no remaining
                // meaning here and only confuses later readers that still
                // treat `endConditions.deadline` as "when to stop running".
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                updated.start_at = None;
                updated.recurring_window = None;
                if let Some(ref mut ec) = updated.end_conditions {
                    ec.deadline = None;
                }
            }
            TaskExecutionMode::Recurring => {
                // dispatch_at belongs to Scheduled only.
                updated.dispatch_at = None;
            }
            TaskExecutionMode::Loop => {
                // dispatch_at and anchored windows belong to time-based modes.
                updated.dispatch_at = None;
                updated.start_at = None;
                updated.recurring_window = None;
            }
        }

        let session_binding_updated = updated.run_mode != existing.run_mode
            || updated.preselected_session_id != existing.preselected_session_id;
        if session_binding_updated {
            validate_new_task_session_binding(
                updated.run_mode,
                updated.preselected_session_id.as_deref(),
            )?;
            if updated.run_mode == Some(TaskRunMode::SingleSession) {
                let session_id = updated
                    .preselected_session_id
                    .as_deref()
                    .expect("single-session binding validated above");
                if !session_exists(session_id) {
                    return Err(format!(
                        "preselectedSessionId does not reference an existing Session: {}",
                        session_id
                    ));
                }
            }
        }

        // Validate cron_expression at the boundary so malformed input can't
        // reach the scheduler (it would silently die at first fire, leaving
        // the task "running" but never ticking).
        if let Some(expr) = updated.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(expr, updated.cron_timezone.as_deref())
                    .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }

        let leaves_command_mode =
            existing.effective_trigger().is_command() && !updated.effective_trigger().is_command();
        let enters_command_mode =
            !existing.effective_trigger().is_command() && updated.effective_trigger().is_command();
        if enters_command_mode {
            // A non-command row is itself the durable proof that any existing
            // Trigger state is stale. Delete it before enabling command mode;
            // if this fails the authoritative row remains non-command.
            self.remove_trigger_state_file(&updated.id)?;
        }

        // Atomic task.md write — when the client sent `prompt`, we want the
        // new markdown body committed under the same write lock that
        // persists the JSONL row. Status was already verified above, so a
        // concurrent `update_status(running)` can't land between these two
        // writes.
        if let Some(ref prompt) = input.prompt {
            if prompt.trim().is_empty() {
                return Err("prompt is empty".to_string());
            }
            if matches!(updated.dispatch_origin, TaskDispatchOrigin::AiAligned) {
                return Err(
                    "ai-aligned tasks use /task-implement; edit alignment.md instead".to_string(),
                );
            }
            let dir = task_docs_dir(&updated.id)?;
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir task dir: {}", e))?;
            write_atomic_text(&dir.join("task.md"), prompt)?;
        }

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);

        if leaves_command_mode {
            if let Err(error) = self.remove_trigger_state(&updated.id).await {
                ulog_warn!(
                    "[task] command Trigger state cleanup deferred to startup task={}: {}",
                    updated.id,
                    error
                );
            }
        }

        Ok(updated)
    }

    // ---- Status transition ----

    /// Apply a status transition with PRD §10.2.1 core semantics:
    ///   1. transition-table legality
    ///   2. actor/source guards (archived user-only, agent→cli only,
    ///      `Deleted` never accepted here — only `delete()` may write it)
    ///   3. persist-then-swap atomic history append
    ///
    /// `actor` is explicit (not inferred): callers MUST assert their actor. The
    /// Tauri command layer sets `actor=User, source=Ui` authoritatively so a
    /// malicious renderer cannot spoof `agent` / `system`.
    ///
    /// Returns `(updated_task, transition_written)`. Progress.md / notification /
    /// SSE side-effects are caller responsibility (Phase 4/5 wiring).
    pub async fn update_status(
        &self,
        input: TaskUpdateStatusInput,
    ) -> Result<(Task, StatusTransition), String> {
        let task_control = crate::task_scheduler::acquire_task_control(&input.id).await;
        self.update_status_with_task_control_held(input, &task_control)
            .await
    }

    pub(crate) async fn update_status_with_task_control_held(
        &self,
        input: TaskUpdateStatusInput,
        task_control: &crate::task_scheduler::TaskControlGuard,
    ) -> Result<(Task, StatusTransition), String> {
        // `Deleted` is reserved for `delete()`.
        if input.status == TaskStatus::Deleted {
            return Err(String::from(TaskOpError::invalid_transition(
                TaskStatus::Deleted,
                TaskStatus::Deleted,
            )));
        }

        self.ensure_writable()?;
        let target_status = input.status;
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(&input.id, move |task| {
                let mut projected = task.clone();
                projected.status = target_status;
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }

        let from = existing.status;
        let to = input.status;

        // 1. legality
        if !is_transition_legal(from, to) {
            return Err(String::from(TaskOpError::invalid_transition(from, to)));
        }

        // 2. actor/source guard
        let actor = input.actor;
        let source = input.source;
        if to == TaskStatus::Archived && actor != TransitionActor::User {
            return Err(String::from(TaskOpError::archive_user_only()));
        }
        if actor == TransitionActor::Agent && source != Some(TransitionSource::Cli) {
            return Err(String::from(TaskOpError::agent_source_must_be_cli()));
        }
        if existing.dispatch_origin == TaskDispatchOrigin::AttachedSession && to == TaskStatus::Todo
        {
            return Err(
                "attached-session Tasks cannot be rerun; reopen or reclaim the Space work to create a new attached Task"
                    .to_string(),
            );
        }

        let now = now_ms();
        let mut updated = existing;
        updated.status = to;
        updated.updated_at = now;
        let transition = StatusTransition {
            from: Some(from),
            to,
            at: now,
            actor,
            message: input.message,
            source,
        };
        updated.status_history.push(transition.clone());

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        // Drop the write lock before firing side-effects so listeners that
        // refetch via `get()` don't contend with us.
        drop(inner);
        // The committed row is now visible to the deletion predicate, so its
        // durable protection set takes over from the mutation guard.
        drop(session_lifecycle);

        ulog_info!(
            "[task] status {}: {} → {} (actor={}, source={:?})",
            updated.id,
            from.as_str(),
            to.as_str(),
            actor.as_str(),
            source.map(|s| s.as_str())
        );

        let stop_error = if matches!(
            to,
            TaskStatus::Stopped | TaskStatus::Blocked | TaskStatus::Archived | TaskStatus::Done
        ) {
            crate::task_scheduler::get_task_scheduler()
                .stop_with_control_held(&updated.id, task_control)
                .await
                .err()
        } else {
            None
        };
        // An ambiguous exact stop still owns the durable Activation Event.
        // Only clear that outbox after Runtime termination was confirmed.
        let pending_cancel_error = if should_cancel_pending_after_transition(
            to,
            updated.effective_trigger().is_command(),
            stop_error.is_none(),
        ) {
            self.cancel_pending_activation(&updated.id)
                .await
                .err()
                .map(|error| {
                    format!("Task was stopped, but pending Activation cleanup needs retry: {error}")
                })
        } else {
            None
        };

        // NB: progress.md is intentionally NOT touched here. It's the
        // AI's own workspace document — `/task-alignment` creates it
        // with a structured template and `/task-implement` updates it
        // via standard Read / Edit / Write tools. The program code only
        // writes `status_history` (authoritative audit log, above). The
        // UI's "执行日志" panel reads progress.md directly from disk.
        // (v0.1.69+: previously `append_progress_line` polluted the AI's
        // doc with machine-format lines — removed.)

        // PRD §10.2.1 step 6: notification dispatch (desktop + bot) for
        // subscribed transitions. Side-effects fire AFTER persist so a
        // crash between write and notify is recoverable from disk state.
        dispatch_notification(&updated, &transition);

        // PRD §10.2.1 step 7: SSE broadcast. Renderer listens on
        // `task:status-changed` for live refresh across all open Task Center
        // tabs.
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": updated.id,
                "from": transition.from.map(|s| s.as_str()),
                "to": transition.to.as_str(),
                "at": transition.at,
                "actor": transition.actor.as_str(),
                "source": transition.source.map(|s| s.as_str()),
                "message": transition.message.clone(),
            }),
        );

        if let Some(error) = stop_error.or(pending_cancel_error) {
            return Err(error);
        }

        Ok((updated, transition))
    }

    // ---- Execution bookkeeping ----

    fn append_session_locked(
        &self,
        inner: &mut HashMap<String, Task>,
        id: &str,
        session_id: &str,
    ) -> Result<(Task, bool), String> {
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        if updated.session_ids.iter().any(|value| value == session_id) {
            return Ok((updated, false));
        }
        updated.session_ids.push(session_id.to_string());
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok((updated, true))
    }

    fn emit_session_appended(updated: &Task, session_id: &str) {
        emit_task_event(
            "task:session-appended",
            serde_json::json!({
                "taskId": updated.id,
                "sessionId": session_id,
            }),
        );
    }

    pub async fn append_session(&self, id: &str, session_id: &str) -> Result<Task, String> {
        self.ensure_writable()?;
        let projected_session_id = session_id.to_string();
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if !projected
                    .session_ids
                    .iter()
                    .any(|value| value == &projected_session_id)
                {
                    projected.session_ids.push(projected_session_id.clone());
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let result = self.append_session_locked(&mut inner, id, session_id);
        // Drop the write lock before emitting — listeners may call back
        // into TaskStore (e.g. overlay refetch) and we don't want a
        // re-entrant deadlock.
        drop(inner);
        drop(session_lifecycle);
        let (updated, changed) = result?;
        if changed {
            // Surfaces newly-linked sessions to TaskDetailOverlay while it's
            // already open. Without this the "任务执行" section under-reports
            // until the user closes and reopens the overlay (review HIGH
            // finding: a pre-existing silent mutation that became visible
            // after promoting TaskSessionsList to the second block).
            Self::emit_session_appended(&updated, session_id);
        }
        Ok(updated)
    }

    /// Commit a Session binding while the caller retains that Session's
    /// lifecycle guard. Scheduler reservation uses this to publish transient
    /// execution ownership and durable TaskStore binding under one guard.
    pub(crate) async fn append_session_with_lifecycle_held(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Task, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let result = self.append_session_locked(&mut inner, id, session_id);
        drop(inner);
        let (updated, changed) = result?;
        if changed {
            Self::emit_session_appended(&updated, session_id);
        }
        Ok(updated)
    }

    fn set_execution_session_locked(
        &self,
        inner: &mut HashMap<String, Task>,
        id: &str,
        session_id: &str,
    ) -> Result<(Task, bool), String> {
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        let appended = !updated.session_ids.iter().any(|value| value == session_id);
        updated.preselected_session_id = Some(session_id.to_string());
        if appended {
            updated.session_ids.push(session_id.to_string());
        }
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok((updated, appended))
    }

    /// Rebind a scheduler-selected Session while the caller owns both the old
    /// and replacement Session lifecycles. Existing `session_ids` history is
    /// preserved; a never-materialized preselection is not fabricated into a
    /// completed-run history entry.
    pub(crate) async fn set_execution_session_with_lifecycle_held(
        &self,
        id: &str,
        session_id: String,
        replaced_session_id: Option<&str>,
    ) -> Result<Task, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let result = self.set_execution_session_locked(&mut inner, id, &session_id);
        drop(inner);
        let (updated, appended) = result?;
        if appended {
            Self::emit_session_appended(&updated, &session_id);
        }
        if let Some(replaced_session_id) = replaced_session_id {
            emit_task_event(
                "task:session-rebound",
                serde_json::json!({
                    "taskId": updated.id,
                    "replacedSessionId": replaced_session_id,
                    "sessionId": session_id,
                    "reason": "session_missing",
                }),
            );
        }
        Ok(updated)
    }

    /// Commit one completed scheduler attempt to the Task authority. Run
    /// details remain in the existing JSONL history keyed by the same Task id.
    pub async fn record_execution_if_status(
        &self,
        id: &str,
        trigger: TaskExecutionTrigger,
        expected_status: TaskStatus,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.status != expected_status || existing.deleted {
            return Ok(None);
        }
        let mut updated = existing;
        let executed_at = now_ms();
        updated.execution_count = updated.execution_count.saturating_add(1);
        updated.last_executed_at = Some(executed_at);
        if trigger == TaskExecutionTrigger::Scheduled {
            updated.last_scheduled_at = Some(executed_at);
        }
        updated.updated_at = executed_at;

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);

        emit_task_event(
            "task:execution-complete",
            serde_json::json!({
                "taskId": updated.id,
                "executionCount": updated.execution_count,
                "lastExecutedAt": updated.last_executed_at,
            }),
        );
        Ok(Some(updated))
    }

    /// Atomically commit an admitted command-trigger turn to the Task row.
    ///
    /// The Trigger outbox is a separate crash-durable file. We therefore
    /// persist the execution count, event receipt, and any terminal Task
    /// transition together *before* clearing that outbox. If the app exits in
    /// between, startup recognizes the receipt and settles the matching event
    /// without dispatching the AI turn again.
    pub(crate) async fn record_activation_execution_if_status(
        &self,
        id: &str,
        event_id: &str,
        trigger: TaskExecutionTrigger,
        expected_status: TaskStatus,
        terminal: Option<TaskExecutionTerminalTransition>,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let projected_terminal = terminal.as_ref().map(|transition| transition.status);
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if let Some(status) = projected_terminal {
                    projected.status = status;
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Ok(None);
        }
        if existing.last_activation_event_id.as_deref() == Some(event_id) {
            return Ok(Some(existing));
        }
        if existing.status != expected_status {
            return Ok(None);
        }

        let mut updated = existing;
        let executed_at = now_ms();
        updated.execution_count = updated.execution_count.saturating_add(1);
        updated.last_executed_at = Some(executed_at);
        updated.last_activation_event_id = Some(event_id.to_string());
        if trigger == TaskExecutionTrigger::Scheduled {
            updated.last_scheduled_at = Some(executed_at);
        }
        let transition = if let Some(terminal) = terminal {
            if !matches!(terminal.status, TaskStatus::Done | TaskStatus::Blocked)
                || !is_transition_legal(updated.status, terminal.status)
            {
                return Err(format!(
                    "invalid activation terminal transition: {} -> {}",
                    updated.status.as_str(),
                    terminal.status.as_str()
                ));
            }
            let transition = StatusTransition {
                from: Some(updated.status),
                to: terminal.status,
                at: executed_at,
                actor: TransitionActor::System,
                message: Some(terminal.message),
                source: Some(terminal.source),
            };
            updated.status = terminal.status;
            updated.status_history.push(transition.clone());
            Some(transition)
        } else {
            None
        };
        updated.updated_at = executed_at;

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);

        emit_task_event(
            "task:execution-complete",
            serde_json::json!({
                "taskId": updated.id,
                "executionCount": updated.execution_count,
                "lastExecutedAt": updated.last_executed_at,
                "activationEventId": event_id,
            }),
        );
        if let Some(transition) = transition.as_ref() {
            dispatch_notification(&updated, transition);
            emit_task_event(
                "task:status-changed",
                serde_json::json!({
                    "taskId": updated.id,
                    "from": transition.from.map(|status| status.as_str()),
                    "to": transition.to.as_str(),
                    "at": transition.at,
                    "actor": transition.actor.as_str(),
                    "source": transition.source.map(|source| source.as_str()),
                    "message": transition.message.clone(),
                }),
            );
        }
        Ok(Some(updated))
    }

    /// Advance only the timer anchor after a command Detector check that did
    /// not enter an AI turn. `executionCount` and `lastExecutedAt` remain AI-
    /// execution metrics.
    pub async fn record_scheduled_check_if_status(
        &self,
        id: &str,
        expected_status: TaskStatus,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.status != expected_status || existing.deleted {
            return Ok(None);
        }
        let mut updated = existing;
        let checked_at = now_ms();
        updated.last_scheduled_at = Some(checked_at);
        updated.updated_at = checked_at;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(Some(updated))
    }

    pub async fn import_legacy_execution_state(
        &self,
        id: &str,
        execution_count: u32,
        last_executed_at: Option<i64>,
        session_id: Option<&str>,
    ) -> Result<Task, String> {
        self.ensure_writable()?;
        let projected_session_id = session_id
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if let Some(session_id) = projected_session_id.as_ref() {
                    if !projected
                        .session_ids
                        .iter()
                        .any(|value| value == session_id)
                    {
                        projected.session_ids.push(session_id.clone());
                    }
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing.clone();
        updated.execution_count = updated.execution_count.max(execution_count);
        updated.last_executed_at = match (updated.last_executed_at, last_executed_at) {
            (Some(current), Some(legacy)) => Some(current.max(legacy)),
            (current, legacy) => current.or(legacy),
        };
        updated.last_scheduled_at = match (updated.last_scheduled_at, last_executed_at) {
            (Some(current), Some(legacy)) => Some(current.max(legacy)),
            (current, legacy) => current.or(legacy),
        };
        let mut changed = updated.execution_count != existing.execution_count
            || updated.last_executed_at != existing.last_executed_at
            || updated.last_scheduled_at != existing.last_scheduled_at;
        if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
            if !updated.session_ids.iter().any(|value| value == session_id) {
                updated.session_ids.push(session_id.to_string());
                changed = true;
            }
        }
        if !changed {
            drop(inner);
            drop(session_lifecycle);
            return Ok(existing);
        }
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        Ok(updated)
    }

    // ---- Archive / Delete ----

    /// User-only archive entry. Emits `Done → Archived` with actor=user.
    /// `update_status` tears down the Task scheduler on terminal states.
    pub async fn archive(&self, id: &str, message: Option<String>) -> Result<Task, String> {
        self.archive_with_origin(
            id,
            message,
            TransitionActor::User,
            Some(TransitionSource::Ui),
        )
        .await
    }

    pub async fn archive_with_origin(
        &self,
        id: &str,
        message: Option<String>,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<Task, String> {
        validate_ordinary_caller_origin(actor, source)?;
        let (task, _) = self
            .update_status(TaskUpdateStatusInput {
                id: id.to_string(),
                status: TaskStatus::Archived,
                message,
                actor,
                source,
            })
            .await?;
        Ok(task)
    }

    /// Product-level delete. Writes a durable `→ Deleted` tombstone transition
    /// to `statusHistory` (PRD §10.2.2), sets `status=Deleted`, flips the
    /// `deleted` flag, and tears down the Task scheduler so it cannot fire
    /// against a deleted Task. Downstream auditors
    /// can filter `statusHistory` on `to == Deleted` to find all removed tasks,
    /// preserving migration safety and audit without promising restoration or a
    /// retention window. Workspace-owned scripts are outside this store.
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        self.delete_with_origin(id, TransitionActor::User, Some(TransitionSource::Ui))
            .await
    }

    pub async fn delete_with_origin(
        &self,
        id: &str,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<(), String> {
        validate_ordinary_caller_origin(actor, source)?;
        let task_control = crate::task_scheduler::acquire_task_control(id).await;
        self.ensure_writable()?;
        let before = self
            .get(id)
            .await
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
        // Delete owns cancellation: an active Detector/AI turn is stopped and
        // its exact process/session lifecycle is confirmed before the row can
        // disappear from ordinary recovery surfaces.
        crate::task_scheduler::get_task_scheduler()
            .stop_with_control_held(id, &task_control)
            .await?;
        if before.deleted {
            if let Err(error) = self.remove_trigger_state(id).await {
                ulog_warn!(
                    "[task] deleted Trigger state cleanup deferred to startup retry task={}: {}",
                    id,
                    error
                );
            }
            return Ok(());
        }
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        let now = now_ms();
        let from = updated.status;
        updated.status_history.push(StatusTransition {
            from: Some(from),
            to: TaskStatus::Deleted,
            at: now,
            actor,
            message: Some("deleted".to_string()),
            source,
        });
        updated.status = TaskStatus::Deleted;
        updated.deleted = true;
        updated.deleted_at = Some(now);
        updated.updated_at = now;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        if let Err(error) = Self::persist_locked(&self.jsonl_path, &next) {
            drop(inner);
            if before.status == TaskStatus::Running {
                let _ = crate::task_scheduler::get_task_scheduler()
                    .start_with_control_held(id, &task_control)
                    .await;
            }
            return Err(error);
        }
        *inner = next;
        drop(inner);
        if let Err(error) = self.remove_trigger_state(id).await {
            ulog_warn!(
                "[task] deleted Trigger state cleanup deferred to startup retry task={}: {}",
                id,
                error
            );
        }
        ulog_info!("[task] soft-deleted id={}", id);
        Ok(())
    }
}

// ================ Helpers ================

/// Normalise the per-task `mcp_enabled_servers` override at storage time.
///
///   `None`      → follow Agent/workspace
///   `Some([])`  → explicit no MCP
///   `Some([…])` → explicit override
fn normalize_mcp_override(input: Option<Vec<String>>) -> Option<Vec<String>> {
    input
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Strict id validator — rejects `..`, path separators, `\0`, leading `.`, and
/// anything not ASCII alphanumeric / `-` / `_`. Also rejects Windows reserved
/// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) case-insensitively —
/// creating a file/dir with these names on Windows triggers OS-level errors
/// regardless of extension. This is the pit-of-success guard against
/// `taskId="../../etc/passwd"` and similar injections (CC + Codex review).
pub fn validate_safe_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{} is empty or too long", label));
    }
    if value.starts_with('.') {
        return Err(format!("{} may not start with '.'", label));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !ok {
            return Err(format!("{} contains invalid character {:?}", label, ch));
        }
    }
    let upper = value.to_ascii_uppercase();
    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if WINDOWS_RESERVED.iter().any(|r| upper == *r) {
        return Err(format!(
            "{} matches a Windows reserved device name ({})",
            label, upper
        ));
    }
    Ok(())
}

/// Clean + validate a caller-supplied workspace path. Requires non-empty absolute
/// path. Does NOT perform `.canonicalize()` (that would require the path to exist
/// at call time — tasks may reference workspaces that have been moved).
fn canonicalize_workspace_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("workspacePath is empty".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!("workspacePath must be absolute: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn validate_task_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("task name is empty".to_string());
    }
    // PRD §3.2 says "短，<60 字符" — enforce char count (not bytes).
    if trimmed.chars().count() > 120 {
        return Err("task name exceeds 120 chars".to_string());
    }
    Ok(())
}

fn validate_new_task_session_binding(
    run_mode: Option<TaskRunMode>,
    preselected_session_id: Option<&str>,
) -> Result<(), String> {
    if run_mode != Some(TaskRunMode::SingleSession) {
        if preselected_session_id
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(
                "preselectedSessionId is only valid with runMode=single-session".to_string(),
            );
        }
        return Ok(());
    }
    let session_id = preselected_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "single-session Task creation requires a materialized preselectedSessionId".to_string()
        })?;
    if session_id.starts_with("pending-") {
        return Err(
            "single-session Task creation requires a materialized preselectedSessionId".to_string(),
        );
    }
    Ok(())
}

/// PRD 0.2.9 — Validate the per-task provider routing invariants.
///
/// Three invariants enforced uniformly across Task write paths, including
/// compatibility ingress and Legacy Cron migration:
///
///   1. **Pairing**: `provider_id.is_some()` ⇒ `model.is_some()`. Picking
///      a provider without a model silently routes the chosen provider's
///      API to the agent's default model — exactly the cross-provider
///      misroute that #130 surfaced.
///
///   2. **External-runtime exclusion**: external runtimes (claude-code /
///      codex / gemini) MUST NOT carry a builtin `provider_id`; they
///      self-manage providers via their own CLI. A task with
///      `runtime='codex' + provider_id='openai-...'` would either fail
///      validation or, worse, get a model id that codex doesn't recognise.
///
///      `runtime: None` is treated as "force builtin" when `provider_id`
///      is set — see invariant 3 below. This closes the codex-review
///      finding "Agent runtime later switched to Codex/Gemini → task
///      survives with `providerId+model` and silently ignores them at
///      execute time" (Codex P1 #5 against PRD 0.2.9): with `provider_id`
///      set, the only valid runtime is `'builtin'` or `None` AND we
///      additionally pin runtime='builtin' on save (see callers).
///
///   3. **No contradictory clear**: `clear_provider_override == true`
///      together with `provider_id == Some(_)` is rejected at the input
///      layer. The Rust merge order (apply provider_id, then clear)
///      makes "clear win", but accepting the contradictory shape silently
///      hides client bugs. Callers must send one or the other.
///
/// `provider_id`-aware runtime materialization (the matching pin) lives at
/// the call sites — see `create_direct` / `update`.
fn validate_task_provider_routing(
    provider_id: &Option<String>,
    model: &Option<String>,
    runtime: &Option<String>,
) -> Result<(), String> {
    if provider_id.is_some() && model.is_none() {
        return Err(
            "providerId 必须与 model 配对设置 — 选了 provider 后请同时选择该 provider 下的具体 model"
                .to_string(),
        );
    }
    if let Some(rt) = runtime.as_deref() {
        let is_external = matches!(rt, "claude-code" | "codex" | "gemini");
        if is_external && provider_id.is_some() {
            return Err(format!(
                "外部 runtime '{}' 自管 provider — 不允许同时指定 providerId（请在该 runtime 自身的设置中切换 provider）",
                rt
            ));
        }
    }
    Ok(())
}

fn session_metadata_exists(session_id: &str) -> bool {
    crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(session_id).is_some()
}

fn should_cancel_pending_after_transition(
    status: TaskStatus,
    command_trigger: bool,
    exact_stop_confirmed: bool,
) -> bool {
    exact_stop_confirmed
        && command_trigger
        && matches!(status, TaskStatus::Stopped | TaskStatus::Archived)
}

/// PRD 0.2.9 — Materialize `runtime: Some("builtin")` whenever a
/// `provider_id` is set with `runtime: None`. This closes the cross-talk
/// hole flagged by Codex review (P1 #5):
///
/// - User saves task with `runtime: None, provider_id: 'openai-...'`
///   (relying on Agent runtime = builtin).
/// - Later: user changes Agent runtime to codex.
/// - Without pinning, the task survives validation but its provider
///   fields are silently ignored at execute time (codex branch reads
///   only runtimeConfig.model).
/// - Pinning `runtime: 'builtin'` makes the task fail validation at
///   next save (provider_id + external runtime is invariant 2),
///   AND keeps execution honoring the chosen provider regardless of
///   Agent's later runtime switch — providerId IS the user's pinned
///   intent for THIS task.
///
/// Idempotent: if `runtime` is already `Some(_)`, do nothing. Validator
/// runs after this materialization, so any non-None+external case still
/// surfaces as a "外部 runtime 不允许 providerId" error.
fn pin_runtime_for_provider_id(provider_id: &Option<String>, runtime: &mut Option<String>) {
    if provider_id.is_some() && runtime.is_none() {
        *runtime = Some("builtin".to_string());
    }
}

/// Resolve `~/.myagents/tasks/<id>/` and verify the resolved path stays inside
/// `~/.myagents/tasks/`. This is the pit-of-success guard — centralizing path
/// join + boundary check here means no caller can accidentally escape the
/// sandbox via a bad id.
///
/// v0.1.69 relocation: task docs used to live under `<workspace>/.task/<id>/`,
/// keyed by the absolute workspace path. That coupled application data
/// (markdown describing how the task runs) to project content (which could
/// be moved, renamed, deleted, or tracked in git by accident). Tasks are
/// now a first-class user-scoped artifact, alongside `thoughts/`,
/// `sessions/`, and `cron_runs/` — the workspace remains the *execution
/// context* (Sidecar cwd, AI bash tool base) but no longer the storage.
pub fn task_docs_dir(task_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(task_id, "taskId")?;
    let base = task_docs_root()?;
    let resolved = base.join(task_id);
    // Defense in depth: after the `validate_safe_id` check above, any resolved
    // path must still lexically start with `~/.myagents/tasks/`. This catches
    // future bypasses if the validator is weakened.
    if !resolved.starts_with(&base) {
        return Err(format!(
            "task_docs_dir escaped base: {} (base={})",
            resolved.display(),
            base.display()
        ));
    }
    Ok(resolved)
}

/// Root dir for all task documents — `~/.myagents/tasks/`.
///
/// Honors `MYAGENTS_TASK_DOCS_ROOT` **only in debug / test builds** so tests
/// (and the one-off migration script) can redirect to a tempdir without
/// touching the real user profile. Production builds ignore the env var to
/// shut down the "user's shell rc or a rogue child-process env accidentally
/// redirects application data" risk. The env var MUST be an absolute path;
/// relative values are rejected so a stray `./tasks` in CI doesn't pollute
/// the cwd.
fn task_docs_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(override_path) = std::env::var("MYAGENTS_TASK_DOCS_ROOT") {
            let p = PathBuf::from(&override_path);
            if !p.is_absolute() {
                return Err(format!(
                    "MYAGENTS_TASK_DOCS_ROOT must be absolute, got {}",
                    override_path
                ));
            }
            return Ok(p);
        }
    }
    // Route through `app_dirs::myagents_data_dir()` so future dev/prod data
    // isolation (see `app_dirs.rs` doc — e.g. `~/.myagents-dev/` for debug
    // builds) picks up this path automatically. Don't hardcode home dir.
    crate::app_dirs::myagents_data_dir()
        .map(|d| d.join("tasks"))
        .ok_or_else(|| "cannot resolve myagents data dir for task docs".to_string())
}

/// Crash-durable atomic text write: tmp write → sync_all → rename → cleanup
/// on any failure. Mirrors `persist_locked` guarantees for arbitrary files.
pub(crate) fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    let write_res = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("open tmp: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        file.flush().map_err(|e| format!("flush tmp: {}", e))?;
        file.sync_all().map_err(|e| format!("sync tmp: {}", e))?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename: {}", e));
    }
    // A synced file followed by rename is not fully power-loss durable until
    // the directory entry itself is synced. Trigger state contains the durable
    // Activation Event outbox, so treat a failed directory sync as a failed
    // commit on Unix instead of acknowledging an event that may disappear.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("sync parent dir: {e}"))?;
    }
    Ok(())
}

/// Move `src` directory to `dst`. Tries `fs::rename` first (fast path, atomic on
/// the same filesystem). On cross-filesystem or other error, falls back to
/// `copy_dir_recursive` + `remove_dir_all(src)`. Symlinks and unusual file types
/// return `Err` — task docs must be plain files/dirs only.
fn move_alignment_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {}", e))?;
    copy_dir_recursive(src, dst).map_err(|e| format!("copy: {}", e))?;
    fs::remove_dir_all(src).map_err(|e| format!("remove src: {}", e))?;
    Ok(())
}

/// Construct the first-message prompt for a dispatch tick (PRD §9.3.1).
///
/// - `dispatchOrigin='direct'`   → `执行任务：<task.md 正文>`
/// - `dispatchOrigin='ai-aligned'` → `/task-implement` slash command (the skill
///    reads `~/.myagents/tasks/<id>/{task,verify,progress,alignment}.md` on its own)
///
/// Returns `None` if the store isn't initialized or the task doesn't exist.
/// Returns `Some(Err(...))` for unrecoverable I/O such as a missing task.md.
pub async fn build_dispatch_prompt(task_id: &str) -> Option<Result<String, String>> {
    let store = get_task_store()?;
    let task = store.get(task_id).await?;
    Some(compose_dispatch_prompt(&task))
}

fn compose_dispatch_prompt(task: &Task) -> Result<String, String> {
    match task.dispatch_origin {
        TaskDispatchOrigin::AiAligned => {
            // The task-implement skill discovers the four alignment docs from
            // `~/.myagents/tasks/<taskId>/` on its own. We just need to invoke it.
            Ok(format!("/task-implement {}", task.id))
        }
        TaskDispatchOrigin::AttachedSession => Err(format!(
            "attached-session task {} is already bound to a live session and cannot be dispatched",
            task.id
        )),
        TaskDispatchOrigin::Direct => {
            let dir = task_docs_dir(&task.id)?;
            let task_md = dir.join("task.md");
            match fs::read_to_string(&task_md) {
                Ok(body) => {
                    let trimmed = body.trim();
                    if trimmed.is_empty() {
                        Err(format!(
                            "task.md is empty for direct-dispatch task {}",
                            task.id
                        ))
                    } else {
                        Ok(format!("执行任务：{}", trimmed))
                    }
                }
                Err(e) => Err(format!(
                    "Failed to read task.md for {} ({}): {}",
                    task.id,
                    task_md.display(),
                    e
                )),
            }
        }
    }
}

/// Default events a task subscribes to when `NotificationConfig.events` is absent.
const DEFAULT_NOTIFICATION_EVENTS: &[&str] = &["done", "blocked", "endCondition"];

/// PRD §12.2 — check the per-task subscription and dispatch desktop + bot pushes.
/// Dispatch runs best-effort; bot push failure falls back to desktop (§12.6).
fn dispatch_notification(task: &Task, t: &StatusTransition) {
    // Event key — prefer the transition source if it's an `endCondition`
    // virtual event (PRD §12.2), else use the target status.
    let event_key: &str = match (t.source, t.to) {
        (Some(TransitionSource::EndCondition), _) => "endCondition",
        (_, TaskStatus::Done) => "done",
        (_, TaskStatus::Blocked) => "blocked",
        (_, TaskStatus::Stopped) => "stopped",
        (_, TaskStatus::Verifying) => "verifying",
        _ => return, // other transitions don't map to notification events
    };

    let cfg = task.notification.as_ref();
    let subscribed: Vec<String> = cfg.and_then(|c| c.events.clone()).unwrap_or_else(|| {
        DEFAULT_NOTIFICATION_EVENTS
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    if !subscribed.iter().any(|e| e == event_key) {
        return;
    }

    // Build the message (PRD §12.3): "任务「<name>」<动词短语>" + optional
    // `message` body. No emoji (v1.4 decision).
    let verb = match event_key {
        "done" => "已完成",
        "blocked" => "已阻塞",
        "stopped" => "已暂停",
        "verifying" => "进入验证",
        "endCondition" => "循环收敛",
        _ => "状态变更",
    };
    let title = format!("任务「{}」{}", task.name, verb);
    let body = t.message.clone().unwrap_or_default();

    let desktop_enabled = cfg.map(|c| c.desktop).unwrap_or(true);
    let bot_channel = cfg.and_then(|c| c.bot_channel_id.clone());

    let Some(handle) = crate::logger::get_app_handle() else {
        ulog_warn!("[task] notification skipped — no app handle");
        return;
    };

    // Task Center notifications bring the window to the foreground on click
    // but don't deep-link to a specific chat Tab — Tasks live in their own
    // surface (the Task Center page), and no Tab is owned by a Task. The
    // legacy implementation emitted `taskId` in the event payload but the
    // front-end listener typed the field as `tabId`, so the value was always
    // dropped. Pass `None` here and preserve that no-deep-link semantics
    // exactly.
    if desktop_enabled {
        crate::notification::show_with_navigation_target_and_badge(
            &handle,
            &title,
            &body,
            None,
            Some(crate::notification_badge::NotificationBadgeIncrement {
                id: format!("task:{}:{}:{}", task.id, event_key, t.at),
                source: "task-center".to_string(),
                created_at: t.at,
                target: crate::notification_badge::NotificationBadgeTarget::TaskCenter {
                    task_id: Some(task.id.clone()),
                },
            }),
        );
    }

    if let Some(channel) = bot_channel {
        let handle_cloned = handle.clone();
        let bot_thread = cfg.and_then(|c| c.bot_thread.clone());
        let summary = if body.is_empty() {
            title.clone()
        } else {
            format!("{}\n{}", title, body)
        };
        let task_id = task.id.clone();
        let title_owned = title.clone();
        let desktop_was_enabled = desktop_enabled;
        let event_key_owned = event_key.to_string();
        let transition_at = t.at;
        tauri::async_runtime::spawn(async move {
            // PRD §12.6 — bot push failure falls back to desktop so the user
            // isn't silently left without any notification. Even if the user
            // explicitly turned off `desktop`, a bot failure that left them
            // with zero notifications is a degraded experience we surface.
            let delivered = crate::cron_task::deliver_task_notification_to_bot_checked(
                &handle_cloned,
                &channel,
                bot_thread.as_deref(),
                &task_id,
                &summary,
            )
            .await;
            if !delivered {
                let fallback_body = if desktop_was_enabled {
                    format!("(bot 推送失败) {}", summary)
                } else {
                    format!("(bot 推送失败，降级桌面通知) {}", summary)
                };
                crate::notification::show_with_navigation_target_and_badge(
                    &handle_cloned,
                    &title_owned,
                    &fallback_body,
                    None,
                    Some(crate::notification_badge::NotificationBadgeIncrement {
                        id: format!(
                            "task:{}:{}:{}:bot-fallback",
                            task_id, event_key_owned, transition_at
                        ),
                        source: "task-center".to_string(),
                        created_at: chrono::Utc::now().timestamp_millis(),
                        target: crate::notification_badge::NotificationBadgeTarget::TaskCenter {
                            task_id: Some(task_id.clone()),
                        },
                    }),
                );
            }
        });
    }
}

/// SSE / frontend broadcast. Uses the global AppHandle from `logger` so any
/// module can emit without threading the handle through constructors.
fn emit_task_event(event: &str, payload: serde_json::Value) {
    if let Some(handle) = crate::logger::get_app_handle() {
        let _ = handle.emit(event, payload);
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            fs::create_dir_all(&target)?;
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            // Symlinks / sockets / fifos — refuse loudly rather than silently skip
            // (CC + Codex review: previous `// symlinks skipped` comment led to
            // cross-device semantics divergence when `fs::rename` preserved them
            // but the fallback dropped them).
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unsupported file type in alignment dir: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

// ================ Static access for Management API ================
//
// The Rust Management API (src/management_api.rs) serves HTTP requests from
// the Bun Sidecar on a loopback port. It runs as a tokio task without direct
// access to Tauri `State`, so we expose a singleton `OnceLock` just like
// `cron_task::CRON_TASK_MANAGER`. `lib.rs` calls `set_task_store()` during
// `setup()` with the same `Arc<TaskStore>` that's in managed state — the two
// handles point at the same inner store (Arc::clone), so mutations are
// visible to both the Tauri IPC path and the HTTP path.

static TASK_STORE: std::sync::OnceLock<Arc<TaskStore>> = std::sync::OnceLock::new();

pub fn set_task_store(store: Arc<TaskStore>) {
    let _ = TASK_STORE.set(store);
}

pub fn get_task_store() -> Option<&'static Arc<TaskStore>> {
    TASK_STORE.get()
}

// ================ Tauri commands ================
//
// The Tauri layer is the trust boundary for actor/source inference (PRD §10.2.1
// caller-inference table): UI button presses are authoritatively stamped as
// `actor=User, source=Ui`. The command DTOs therefore do NOT expose `actor`/
// `source` fields — a malicious renderer cannot spoof `agent` / `system`.
// Server-side callers (scheduler, CLI → Admin API) use the richer internal
// `TaskStore::update_status` API and supply their own trusted actor/source.
//
// Cross-store/scheduler policy lives in `task_application`; commands only
// stamp trusted caller fields and adapt Tauri DTOs/errors.

pub type ManagedTaskStore = Arc<TaskStore>;

#[tauri::command]
pub async fn cmd_task_create_direct(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateDirectInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(
        task_state.inner().as_ref(),
        Some(thought_state.inner().as_ref()),
    )
    .create_direct(input)
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_create_from_alignment(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateFromAlignmentInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(
        task_state.inner().as_ref(),
        Some(thought_state.inner().as_ref()),
    )
    .create_from_alignment(input)
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_create_attached(
    task_state: tauri::State<'_, ManagedTaskStore>,
    input: TaskCreateAttachedInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(task_state.inner().as_ref(), None)
        .create_attached(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_list(
    state: tauri::State<'_, ManagedTaskStore>,
    filter: Option<TaskListFilter>,
) -> Result<Vec<TaskProjection>, String> {
    let mut filter = filter.unwrap_or_default();
    filter.include_managed = None;
    let tasks = state.list(filter).await;
    Ok(project_task_list(tasks).await)
}

#[tauri::command]
pub async fn cmd_task_get(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<Option<TaskWithDocs>, String> {
    let task = match state.get_ordinary(&id).await {
        Ok(task) => task,
        Err(error) if error == String::from(TaskOpError::not_found(&id)) => return Ok(None),
        Err(error) => return Err(error),
    };
    let docs = build_task_docs(&task.id)?;
    let execution = crate::task_scheduler::get_task_scheduler()
        .execution_projection(&task.id)
        .await;
    let trigger_state = if task.effective_trigger().is_command() {
        Some(state.read_trigger_state(&task.id).await?)
    } else {
        None
    };
    let next_execution_at = crate::task_scheduler::next_execution_at(&task)
        .ok()
        .flatten()
        .map(|value| value.timestamp_millis());
    Ok(Some(TaskWithDocs {
        task,
        docs,
        execution_state: execution.as_ref().map(|value| value.state),
        execution_error: execution.and_then(|value| value.error),
        trigger_state,
        next_execution_at,
    }))
}

#[tauri::command]
pub async fn cmd_task_trigger_validate(trigger: TaskTrigger) -> Result<TaskTrigger, String> {
    validate_task_trigger(&trigger)?;
    Ok(trigger)
}

#[tauri::command]
pub async fn cmd_task_trigger_test(
    task_id: Option<String>,
    owner_task_id: Option<String>,
    trigger: Option<TaskTrigger>,
    workspace_path: Option<String>,
    checkpoint: Option<serde_json::Map<String, serde_json::Value>>,
    checkpoint_revision: Option<u64>,
    checkpoint_updated_at: Option<i64>,
) -> serde_json::Value {
    let result = match (task_id, trigger, workspace_path) {
        (Some(task_id), None, None) => {
            crate::task_scheduler::get_task_scheduler()
                .test_trigger(&task_id, None)
                .await
        }
        (None, Some(trigger), Some(workspace_path)) => {
            crate::task_scheduler::get_task_scheduler()
                .test_trigger_spec(
                    owner_task_id,
                    trigger,
                    workspace_path,
                    checkpoint,
                    checkpoint_revision.unwrap_or(0),
                    checkpoint_updated_at,
                )
                .await
        }
        _ => Err(crate::task_trigger::DetectorRunFailure::from_message(
            "invalid_request",
            "provide either taskId or trigger + workspacePath",
        )),
    };
    match result {
        Ok(result) => serde_json::json!({ "ok": true, "result": result }),
        Err(failure) => serde_json::json!({ "ok": false, "failure": failure }),
    }
}

#[tauri::command]
pub async fn cmd_task_check_now(
    id: String,
) -> Result<crate::task_scheduler::TaskTriggerCheckNowResult, String> {
    crate::task_scheduler::get_task_scheduler()
        .check_now(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_run_now(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<String, String> {
    state.get_ordinary(&id).await?;
    crate::task_scheduler::get_task_scheduler()
        .trigger_now(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_reset_checkpoint(
    id: String,
) -> Result<crate::task_trigger::TaskTriggerRuntimeState, String> {
    crate::task_scheduler::get_task_scheduler()
        .reset_checkpoint(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_update(
    state: tauri::State<'_, ManagedTaskStore>,
    input: TaskUpdateInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .update_ordinary(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_update_status(
    state: tauri::State<'_, ManagedTaskStore>,
    input: UiTaskUpdateStatusInput,
) -> Result<Task, String> {
    // Trust boundary: UI callers are stamped as user/ui here. The internal
    // `update_status` API remains available for scheduler / watchdog / crash /
    // endCondition / rerun paths with their own actor/source context.
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .update_status_ordinary(TaskUpdateStatusInput {
            id: input.id,
            status: input.status,
            message: input.message,
            actor: TransitionActor::User,
            source: Some(TransitionSource::Ui),
        })
        .await
        .map(|result| result.task)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_append_session(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    session_id: String,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .append_session_ordinary(&id, &session_id)
        .await
        .map_err(|error| error.to_string())
}

/// Persist alignment-session sidecar metadata to
/// `~/.myagents/tasks/<alignmentSessionId>/metadata.json`.
///
/// Called at the moment the frontend spawns an 「AI 讨论」 session so that
/// `create_from_alignment` can later inherit workspace_id / workspace_path /
/// source_thought_id from the file instead of demanding the AI caller
/// re-pass them through the CLI. See the read side in
/// `TaskStore::create_from_alignment`.
///
/// Creates the alignment dir on demand — the frontend reaches here BEFORE
/// the AI has written any docs into that dir, so we must be the one that
/// ensures its existence. `validate_safe_id` guards against `..` / slashes
/// in the id per the rest of this module's path-safety pattern.
#[tauri::command]
pub async fn cmd_task_write_alignment_metadata(
    alignment_session_id: String,
    workspace_id: String,
    workspace_path: String,
    source_thought_id: Option<String>,
) -> Result<(), String> {
    validate_safe_id(&alignment_session_id, "alignmentSessionId")?;
    let dir = task_docs_dir(&alignment_session_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir alignment dir: {}", e))?;
    let meta = AlignmentSessionMetadata {
        workspace_id,
        workspace_path,
        source_thought_id,
        created_at: now_ms(),
    };
    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("serialize alignment metadata: {}", e))?;
    // Atomic tmp+rename — matches the module's `write_atomic_text` convention
    // (task.md / progress.md writes). Concurrent writers for the same
    // alignment id cannot produce a half-written file; a crash mid-write
    // leaves the old file (or no file) but never a corrupt one.
    write_atomic_text(&dir.join("metadata.json"), &json)?;
    ulog_debug!(
        "[task] wrote alignment metadata id={} thought={:?}",
        alignment_session_id,
        meta.source_thought_id,
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_task_archive(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    message: Option<String>,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .archive_ordinary(&id, message)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_delete(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    id: String,
) -> Result<(), String> {
    crate::task_application::TaskApplication::new(
        task_state.inner().as_ref(),
        Some(thought_state.inner().as_ref()),
    )
    .delete_ordinary(&id)
    .await
    .map_err(|error| error.to_string())
}

/// Read one of the markdown documents attached to a Task.
///
/// - `task`: the executor prompt (`~/.myagents/tasks/<id>/task.md`). Authored by the user
///   at dispatch, editable from the task detail overlay.
/// - `verify`: acceptance criteria (`~/.myagents/tasks/<id>/verify.md`). Optional; may
///   be authored by the user or produced by the alignment flow. Returns an
///   empty string when the file does not yet exist.
/// - `progress`: read-only execution log (`~/.myagents/tasks/<id>/progress.md`). Agents
///   append to this file during runs; the UI renders it but does not write.
/// - `alignment`: AI-discussion decision record (`~/.myagents/tasks/<id>/alignment.md`).
///   Written by `/task-alignment` skill directly; read-only from the UI.
#[tauri::command]
pub async fn cmd_task_read_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
) -> Result<String, String> {
    let task = state.get_ordinary(&id).await?;
    let filename = task_doc_filename(&doc)?;
    let path = task_docs_dir(&task.id)?.join(filename);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", filename, e)),
    }
}

/// Write `task.md` or `verify.md` for a Task. `progress.md` is agent-only
/// (the CLI / SDK tool appends to it) and is rejected here. The running/
/// verifying lock is enforced atomically with the file write inside
/// `TaskStore::write_doc` — status check and file mutation happen under
/// the same lock so a concurrent `update_status(running)` can't land in
/// between and let us mutate a doc that's mid-execution.
#[tauri::command]
pub async fn cmd_task_write_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
    content: String,
) -> Result<(), String> {
    let filename = task_doc_filename(&doc)?;
    // progress.md + alignment.md are AI-owned workspace documents — the
    // `/task-alignment` skill creates alignment.md and `/task-implement`
    // writes progress.md using standard Read / Edit / Write tools against
    // the absolute path in `Task.docs`. The UI has no editor for them, so
    // this Tauri command (which backs `TaskEditPanel`) rejects writes to
    // both names — catches an accidental misroute rather than silently
    // corrupting the AI's workbook.
    if filename == "progress.md" || filename == "alignment.md" {
        return Err(format!(
            "{} is AI-owned and not writable via this API",
            filename
        ));
    }
    state.get_ordinary(&id).await?;
    state.write_doc(&id, filename, &content).await
}

/// Reveal `~/.myagents/tasks/<id>/` in the OS file manager so the user
/// can inspect / edit `task.md`, `verify.md`, `progress.md`, `alignment.md`
/// directly. Sandboxed through `task_docs_dir` so we can't be coerced into
/// opening an arbitrary path. Creates the dir on demand — a fresh Task
/// has no docs dir until its first write.
#[tauri::command]
pub async fn cmd_task_open_docs_dir(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<(), String> {
    // Validate the task exists so the UI can't open a docs dir for a
    // deleted / unknown task (Finder would happily open an empty dir).
    state.get_ordinary(&id).await?;
    let dir = task_docs_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir task dir: {}", e))?;
    let path = dir.to_string_lossy().to_string();

    // OS openers via process_cmd::new — CREATE_NO_WINDOW is a no-op for
    // GUI-subsystem binaries (open / explorer.exe / xdg-open) so the wrapper
    // is functionally equivalent to raw Command::new here, but going through
    // it preserves the single-mental-model rule from CLAUDE.md ("ALL child
    // processes use process_cmd::new").
    #[cfg(target_os = "macos")]
    {
        crate::process_cmd::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_cmd::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process_cmd::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open: {}", e))?;
    }
    Ok(())
}

/// Aggregate runtime telemetry from the Task authority and its run-history
/// projection. No scheduler state is persisted separately.
///
/// The renderer uses this in the detail overlay's "运行统计" section
/// without having to stitch three data sources together.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunStats {
    pub execution_count: u32,
    pub last_executed_at: Option<i64>,
    pub last_success: Option<bool>,
    pub last_duration_ms: Option<i64>,
    pub scheduler_status: Option<String>,
    pub session_count: usize,
    /// Next scheduled fire time (ms since epoch), computed by the same Rust
    /// resolver used by the live Task scheduler.
    pub next_execution_at: Option<i64>,
}

#[tauri::command]
pub async fn cmd_task_get_run_stats(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<TaskRunStats, String> {
    let task = state
        .get(&id)
        .await
        .ok_or_else(|| String::from(TaskOpError::not_found(&id)))?;

    let mut stats = TaskRunStats {
        execution_count: task.execution_count,
        last_executed_at: task.last_executed_at,
        last_success: None,
        last_duration_ms: None,
        scheduler_status: Some(task.status.as_str().to_string()),
        session_count: task.session_ids.len(),
        next_execution_at: crate::task_scheduler::next_execution_at(&task)
            .ok()
            .flatten()
            .map(|value| value.timestamp_millis()),
    };

    let runs = crate::cron_task::read_cron_runs(&task.id, 1);
    if let Some(last) = runs.last() {
        stats.last_success = Some(last.ok);
        stats.last_duration_ms = Some(last.duration_ms as i64);
    }

    Ok(stats)
}

/// Central doc-name whitelist for all task-md entry points (Tauri IPC
/// `cmd_task_read_doc`/`cmd_task_write_doc` + Management API
/// `/api/task/read-doc`/`/api/task/write-doc`). Keep these in lockstep —
/// divergence led to the v0.1.69 bug where Management API accepted
/// `alignment` but Tauri IPC rejected it, so the renderer couldn't read
/// alignment.md through the same path the CLI uses.
pub fn task_doc_filename(doc: &str) -> Result<&'static str, String> {
    match doc {
        "task" => Ok("task.md"),
        "verify" => Ok("verify.md"),
        "progress" => Ok("progress.md"),
        "alignment" => Ok("alignment.md"),
        other => Err(format!(
            "unknown doc name: {} (expected task|verify|progress|alignment)",
            other
        )),
    }
}

// ================ Tests ================

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::{Arc, OnceLock};
    use tempfile::tempdir;

    /// Shared task-docs root for the entire test binary. Initialised
    /// exactly once via `ensure_test_docs_root()` before any test touches
    /// `task_docs_dir()`. Each test uses a fresh UUID task id, so writes
    /// never collide even though the root is shared.
    ///
    /// Per-test tempdir + env-var swapping doesn't work here: `cargo test`
    /// runs tests in parallel within one process, and env vars are
    /// process-global — two concurrent tests would race each other's
    /// redirects. `std::env::set_var` is also technically unsound when
    /// called from multiple threads (Rust 2024 edition marks it `unsafe`
    /// for this reason), so we call it exactly once inside
    /// `get_or_init`'s closure.
    static TEST_DOCS_ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();

    fn ensure_test_docs_root() {
        TEST_DOCS_ROOT.get_or_init(|| {
            let dir = tempdir().expect("create shared test docs tempdir");
            std::env::set_var("MYAGENTS_TASK_DOCS_ROOT", dir.path());
            dir
        });
    }

    async fn create_direct_with_existing_session(
        store: &TaskStore,
        input: TaskCreateDirectInput,
    ) -> Result<Task, String> {
        reject_managed_kind_from_ordinary_create(&input.managed_kind)?;
        store
            .create_direct_internal(
                input,
                TransitionActor::User,
                Some(TransitionSource::Ui),
                "created (direct)",
                |_| true,
            )
            .await
    }

    fn sample_direct_input(ws: &Path) -> TaskCreateDirectInput {
        TaskCreateDirectInput {
            name: "升级 openclaw lark 适配器".to_string(),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "ws-myagents".to_string(),
            workspace_path: ws.to_string_lossy().into_owned(),
            task_md_content: "跑通 v2.4".to_string(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_thought_id: Some("thought-1".to_string()),
            tags: vec!["MyAgents".to_string()],
            notification: None,
        }
    }

    fn status_input(
        id: &str,
        to: TaskStatus,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> TaskUpdateStatusInput {
        TaskUpdateStatusInput {
            id: id.to_string(),
            status: to,
            message: None,
            actor,
            source,
        }
    }

    fn empty_update_input(id: &str) -> TaskUpdateInput {
        TaskUpdateInput {
            id: id.to_string(),
            name: None,
            executor: None,
            description: None,
            execution_mode: None,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            clear_trigger: false,
            model: None,
            provider_id: None,
            clear_provider_override: false,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            clear_runtime_override: false,
            mcp_enabled_servers: None,
            clear_mcp_override: false,
            tags: None,
            notification: None,
            notification_patch: None,
            prompt: None,
        }
    }

    async fn assert_waits_for_session_lifecycle<T, F>(session_id: &str, operation: F) -> T
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let guard = crate::sidecar::acquire_session_lifecycle(&[session_id]).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut task = tauri::async_runtime::spawn(async move {
            let _ = started_tx.send(());
            operation.await
        });
        started_rx.await.expect("mutation task should start");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut task)
                .await
                .is_err(),
            "mutation must wait while deletion owns the Session lifecycle"
        );
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("mutation should resume after lifecycle release")
            .expect("mutation task should not panic")
            .expect("mutation should succeed")
    }

    async fn assert_waits_for_task_control<T, F>(task_id: &str, operation: F) -> T
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let guard = crate::task_scheduler::acquire_task_control(task_id).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut task = tauri::async_runtime::spawn(async move {
            let _ = started_tx.send(());
            operation.await
        });
        started_rx.await.expect("Task mutation should start");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut task)
                .await
                .is_err(),
            "Task mutation must wait for the same Task control lifecycle"
        );
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("Task mutation should resume after control release")
            .expect("Task mutation should not panic")
            .expect("Task mutation should succeed")
    }

    #[tokio::test]
    async fn ordinary_create_rejects_managed_kind() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());

        let err = store
            .create_direct(input)
            .await
            .expect_err("ordinary create must not mint hidden managed tasks");
        assert_eq!(err, MANAGED_TASK_ERROR);
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn system_managed_create_is_hidden_from_default_list() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());

        let created = store.create_system_managed_direct(input).await.unwrap();
        assert!(is_managed_task(&created));
        assert!(store.list(TaskListFilter::default()).await.is_empty());

        let visible_to_system = store
            .list(TaskListFilter {
                include_managed: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(visible_to_system.len(), 1);
        assert_eq!(visible_to_system[0].id, created.id);
    }

    #[test]
    fn transition_table_allows_lenient_verifying_to_running() {
        use TaskStatus::*;
        assert!(is_transition_legal(Verifying, Running));
        assert!(is_transition_legal(Running, Verifying));
        assert!(is_transition_legal(Verifying, Done));
        assert!(is_transition_legal(Running, Done));
        assert!(is_transition_legal(Done, Archived));
        assert!(is_transition_legal(Archived, Todo));
    }

    #[test]
    fn transition_table_rejects_bad_paths() {
        use TaskStatus::*;
        assert!(!is_transition_legal(Todo, Done)); // no skipping run
        assert!(!is_transition_legal(Todo, Archived)); // archive only from done
        assert!(!is_transition_legal(Blocked, Archived)); // must reset first
        assert!(!is_transition_legal(Stopped, Archived));
        assert!(!is_transition_legal(Running, Archived));
    }

    #[test]
    fn stop_request_preserves_existing_terminal_reason() {
        use TaskStatus::*;
        for status in [Blocked, Stopped, Done, Archived] {
            assert!(is_terminal_execution_stop_request(status, Stopped));
        }
        assert!(!is_terminal_execution_stop_request(Running, Stopped));
        assert!(!is_terminal_execution_stop_request(Done, Todo));
    }

    #[tokio::test]
    async fn create_direct_writes_task_md_and_history() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        std::fs::create_dir_all(&store_dir).unwrap();
        let store = TaskStore::new(store_dir);

        let input = sample_direct_input(&ws);
        let created = store.create_direct(input).await.unwrap();
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.status_history.len(), 1);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[0].actor, TransitionActor::User);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::Direct);

        // task.md materialized at the user-scoped location (no longer under
        // `<workspace>/.task/`).
        let md = task_docs_dir(&created.id).unwrap().join("task.md");
        assert!(md.exists());
        let body = std::fs::read_to_string(&md).unwrap();
        assert_eq!(body, "跑通 v2.4");
    }

    #[tokio::test]
    async fn single_session_create_requires_a_materialized_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        for preselected_session_id in [None, Some("   "), Some("pending-tab-1")] {
            let mut input = sample_direct_input(&ws);
            input.run_mode = Some(TaskRunMode::SingleSession);
            input.preselected_session_id = preselected_session_id.map(str::to_string);
            let error = store
                .create_direct(input)
                .await
                .expect_err("pending or empty single-session binding must not commit a Task");
            assert_eq!(
                error,
                "single-session Task creation requires a materialized preselectedSessionId"
            );
        }

        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn single_session_create_rejects_a_missing_session() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let missing = format!("missing-session-{}", uuid::Uuid::new_v4());
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some(missing.clone());

        let error = store
            .create_direct_internal(
                input,
                TransitionActor::User,
                Some(TransitionSource::Ui),
                "created (direct)",
                |_| false,
            )
            .await
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "preselectedSessionId does not reference an existing Session: {}",
                missing
            )
        );
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn unchanged_legacy_single_session_binding_remains_editable() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-missing-session".to_string());
        let created = store
            .create_migrated_with_id(
                format!("legacy-edit-{}", uuid::Uuid::new_v4()),
                input,
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let mut update = empty_update_input(&created.id);
        update.name = Some("edited legacy task".to_string());
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some("legacy-missing-session".to_string());

        let updated = store.update(update).await.unwrap();
        assert_eq!(updated.name, "edited legacy task");
        assert_eq!(
            updated.preselected_session_id.as_deref(),
            Some("legacy-missing-session")
        );
    }

    #[tokio::test]
    async fn explicit_single_session_rebind_rejects_a_missing_session() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let missing = format!("missing-session-{}", uuid::Uuid::new_v4());
        let mut update = empty_update_input(&created.id);
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some(missing.clone());
        let task_control = crate::task_scheduler::acquire_task_control(&created.id).await;

        let error = store
            .update_with_task_control_and_session_probe(update, &task_control, |_| false)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "preselectedSessionId does not reference an existing Session: {}",
                missing
            )
        );
        let unchanged = store.get(&created.id).await.unwrap();
        assert_eq!(unchanged.run_mode, None);
        assert!(unchanged.preselected_session_id.is_none());
    }

    #[tokio::test]
    async fn multiple_single_session_tasks_can_share_one_materialized_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        for _ in 0..2 {
            let mut input = sample_direct_input(&ws);
            input.run_mode = Some(TaskRunMode::SingleSession);
            input.preselected_session_id = Some("session-real".to_string());
            let created = create_direct_with_existing_session(&store, input)
                .await
                .unwrap();
            assert_eq!(
                created.preselected_session_id.as_deref(),
                Some("session-real")
            );
        }

        assert_eq!(store.list(TaskListFilter::default()).await.len(), 2);
    }

    #[tokio::test]
    async fn corrupt_store_is_all_or_nothing_and_read_only() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let data = dir.path().join("data");
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        let path = data.join("tasks.jsonl");
        std::fs::write(&path, b"{not-json}\n").unwrap();

        let store = TaskStore::new(data);

        assert!(store.list(TaskListFilter::default()).await.is_empty());
        let error = store
            .create_direct(sample_direct_input(&ws))
            .await
            .expect_err("corrupt stores must reject mutation");
        assert!(error.contains("read-only"), "got: {error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"{not-json}\n");
    }

    #[tokio::test]
    async fn legacy_import_never_regresses_newer_task_progress() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store
            .create_migrated_with_id(
                "legacy-progress".to_string(),
                sample_direct_input(&ws),
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let imported = store
            .import_legacy_execution_state(&task.id, 5, Some(100), Some("legacy-session"))
            .await
            .unwrap();
        assert_eq!(imported.execution_count, 5);

        let current = store
            .record_execution_if_status(
                &task.id,
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Stopped,
            )
            .await
            .unwrap()
            .unwrap();
        let after_restart = store
            .import_legacy_execution_state(&task.id, 2, Some(50), Some("legacy-session"))
            .await
            .unwrap();

        assert_eq!(after_restart.execution_count, current.execution_count);
        assert_eq!(after_restart.last_executed_at, current.last_executed_at);
    }

    #[tokio::test]
    async fn running_legacy_create_waits_for_bound_session_lifecycle() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-create-session".to_string());
        let store_for_create = Arc::clone(&store);
        let id = format!("legacy-create-{}", uuid::Uuid::new_v4());

        let created = assert_waits_for_session_lifecycle("legacy-create-session", async move {
            store_for_create
                .create_migrated_with_id(id, input, TaskStatus::Running, "migrated".to_string())
                .await
        })
        .await;
        assert_eq!(created.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn legacy_session_import_waits_before_extending_protected_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-primary-session".to_string());
        let task = store
            .create_migrated_with_id(
                format!("legacy-import-{}", uuid::Uuid::new_v4()),
                input,
                TaskStatus::Running,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let store_for_import = Arc::clone(&store);
        let task_id = task.id.clone();

        let imported = assert_waits_for_session_lifecycle("legacy-import-session", async move {
            store_for_import
                .import_legacy_execution_state(
                    &task_id,
                    1,
                    Some(100),
                    Some("legacy-import-session"),
                )
                .await
        })
        .await;
        assert!(imported
            .session_ids
            .iter()
            .any(|session_id| session_id == "legacy-import-session"));
    }

    #[tokio::test]
    async fn manual_execution_does_not_move_the_scheduler_anchor() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let scheduled = store
            .record_execution_if_status(&task.id, TaskExecutionTrigger::Scheduled, task.status)
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let manual = store
            .record_execution_if_status(&task.id, TaskExecutionTrigger::Manual, task.status)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(manual.last_scheduled_at, scheduled.last_scheduled_at);
        assert!(manual.last_executed_at >= scheduled.last_executed_at);
    }

    #[tokio::test]
    async fn activation_receipt_closes_outbox_accounting_crash_window() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(data_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: Some(30_000),
            },
        });
        let task = store.create_direct(input).await.unwrap();
        let (task, _) = store
            .update_status(status_input(
                &task.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();
        let detector_result = crate::task_trigger::DetectorRunSuccess {
            invocation_id: "invocation-319".to_string(),
            decision: crate::task_trigger::DetectorDecision::Activate,
            reason: crate::task_trigger::TaskTriggerReason {
                code: "build_failed".to_string(),
                message: "Build failed".to_string(),
            },
            event: Some(crate::task_trigger::TaskActivationEvent {
                id: "build-319".to_string(),
                kind: "ci.failed".to_string(),
                occurred_at: "2026-08-03T09:30:00+08:00".to_string(),
            }),
            handoff: Some(crate::task_trigger::TaskActivationHandoff {
                summary: "Build 319 failed".to_string(),
                text: None,
                data: None,
            }),
            next_checkpoint: None,
            duration_ms: 10,
            exit_code: 0,
            stderr_tail: None,
        };
        store
            .commit_detector_success(
                &task,
                &detector_result,
                crate::task_trigger::DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();

        let committed = store
            .record_activation_execution_if_status(
                &task.id,
                "build-319",
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Running,
                Some(TaskExecutionTerminalTransition {
                    status: TaskStatus::Done,
                    message: "Task execution completed".to_string(),
                    source: TransitionSource::EndCondition,
                }),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(committed.execution_count, 1);
        assert_eq!(committed.status, TaskStatus::Done);
        assert_eq!(
            committed.last_activation_event_id.as_deref(),
            Some("build-319")
        );
        assert!(store
            .read_trigger_state(&task.id)
            .await
            .unwrap()
            .pending_activation
            .is_some());

        // Simulate a crash after the Task row commit but before clearing the
        // Trigger outbox. The receipt survives reload and makes re-accounting
        // idempotent; startup can now settle only the matching pending event.
        let recovered = TaskStore::new(data_dir);
        let replay = recovered
            .record_activation_execution_if_status(
                &task.id,
                "build-319",
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Running,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replay.execution_count, 1);
        assert_eq!(replay.status, TaskStatus::Done);
        recovered
            .settle_pending_activation(&task.id, "build-319")
            .await
            .unwrap();
        assert!(recovered
            .read_trigger_state(&task.id)
            .await
            .unwrap()
            .pending_activation
            .is_none());
    }

    #[tokio::test]
    async fn command_task_cannot_be_edited_while_activation_is_pending() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        });
        let task = store.create_direct(input).await.unwrap();
        let success = crate::task_trigger::DetectorRunSuccess {
            invocation_id: "invocation-pending".to_string(),
            decision: crate::task_trigger::DetectorDecision::Activate,
            reason: crate::task_trigger::TaskTriggerReason {
                code: "changed".to_string(),
                message: "Changed".to_string(),
            },
            event: Some(crate::task_trigger::TaskActivationEvent {
                id: "event-pending".to_string(),
                kind: "state.changed".to_string(),
                occurred_at: "2026-08-03T09:30:00Z".to_string(),
            }),
            handoff: Some(crate::task_trigger::TaskActivationHandoff {
                summary: "State changed".to_string(),
                text: None,
                data: None,
            }),
            next_checkpoint: None,
            duration_ms: 1,
            exit_code: 0,
            stderr_tail: None,
        };
        store
            .commit_detector_success(
                &task,
                &success,
                crate::task_trigger::DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();
        let mut update = empty_update_input(&task.id);
        update.name = Some("must not change".to_string());

        let error = store.update(update).await.unwrap_err();

        assert!(error.contains("Activation Event is pending"));
        assert_eq!(store.get(&task.id).await.unwrap().name, task.name);
    }

    #[tokio::test]
    async fn stale_execution_cannot_commit_after_status_changes() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &task.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();

        let committed = store
            .record_execution_if_status(&task.id, TaskExecutionTrigger::Scheduled, TaskStatus::Todo)
            .await
            .unwrap();

        assert!(committed.is_none());
        assert_eq!(store.get(&task.id).await.unwrap().execution_count, 0);
    }

    #[tokio::test]
    async fn migration_rejects_an_unrelated_task_id_collision() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let ordinary = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let error = store
            .create_migrated_with_id(
                ordinary.id,
                sample_direct_input(&ws),
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .expect_err("migration must not adopt an unrelated Task");

        assert!(error.contains("collides"), "got: {error}");
    }

    #[tokio::test]
    async fn create_attached_binds_current_session_without_cron() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #123".to_string(),
                    executor: TaskExecutor::Agent,
                    description: Some("MyAgents Space Issue iss_123".to_string()),
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "session-123".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_123".to_string(),
                    source_claim_id: Some("claim_123".to_string()),
                    source_delivery_id: Some("delivery_123".to_string()),
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();

        assert_eq!(created.status, TaskStatus::Running);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::AttachedSession);
        assert_eq!(created.session_ids, vec!["session-123".to_string()]);
        assert_eq!(created.status_history.len(), 2);
        assert_eq!(created.status_history[0].from, None);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[1].from, Some(TaskStatus::Todo));
        assert_eq!(created.status_history[1].to, TaskStatus::Running);
        assert_eq!(
            created
                .external_source
                .as_ref()
                .map(|s| s.issue_id.as_str()),
            Some("iss_123")
        );

        let md = task_docs_dir(&created.id).unwrap().join("task.md");
        assert_eq!(std::fs::read_to_string(&md).unwrap(), "处理 Space Issue");
        let dispatch_err = compose_dispatch_prompt(&created).unwrap_err();
        assert!(dispatch_err.contains("attached-session"));
    }

    #[tokio::test]
    async fn create_attached_rejects_a_session_deleted_before_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        let error = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #deleted".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "deleted-attached-session".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_deleted".to_string(),
                    source_claim_id: Some("claim_deleted".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| false,
            )
            .await
            .expect_err("deletion that wins the lifecycle must prevent attachment");
        assert!(error.contains("no longer exists"), "got: {error}");
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn running_transition_waits_for_bound_session_lifecycle() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("session-locked".to_string());
        let created = create_direct_with_existing_session(&store, input)
            .await
            .unwrap();
        let store_for_transition = Arc::clone(&store);
        let task_id = created.id.clone();
        let (updated, _) = assert_waits_for_session_lifecycle("session-locked", async move {
            store_for_transition
                .update_status(status_input(
                    &task_id,
                    TaskStatus::Running,
                    TransitionActor::System,
                    Some(TransitionSource::Scheduler),
                ))
                .await
        })
        .await;
        assert_eq!(updated.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn terminal_transition_and_runtime_stop_share_task_control() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();
        let store_for_stop = Arc::clone(&store);
        let task_id = created.id.clone();
        let task_id_for_operation = task_id.clone();

        let (stopped, _) = assert_waits_for_task_control(&task_id, async move {
            store_for_stop
                .update_status(status_input(
                    &task_id_for_operation,
                    TaskStatus::Stopped,
                    TransitionActor::User,
                    Some(TransitionSource::Ui),
                ))
                .await
        })
        .await;
        assert_eq!(stopped.status, TaskStatus::Stopped);
    }

    #[tokio::test]
    async fn attached_terminal_task_cannot_be_rerun() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #lifecycle".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "attached-session-locked".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_lifecycle".to_string(),
                    source_claim_id: Some("claim_lifecycle".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::System,
                Some(TransitionSource::EndCondition),
            ))
            .await
            .unwrap();

        let error = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Todo,
                TransitionActor::System,
                Some(TransitionSource::Rerun),
            ))
            .await
            .expect_err("Attached Space work must be reclaimed into a new Task");
        assert!(error.contains("cannot be rerun"), "got: {error}");
        assert_eq!(
            store.get(&created.id).await.unwrap().status,
            TaskStatus::Done
        );
    }

    #[tokio::test]
    async fn public_append_waits_before_adding_a_protected_session_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("primary-session".to_string());
        let created = create_direct_with_existing_session(&store, input)
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();

        let store_for_append = Arc::clone(&store);
        let task_id = created.id.clone();
        let updated = assert_waits_for_session_lifecycle("appended-session", async move {
            store_for_append
                .append_session(&task_id, "appended-session")
                .await
        })
        .await;
        assert!(updated
            .session_ids
            .iter()
            .any(|id| id == "appended-session"));
    }

    #[tokio::test]
    async fn attached_field_update_waits_before_adding_a_protected_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #field-update".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "attached-primary".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_field_update".to_string(),
                    source_claim_id: Some("claim_field_update".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Stopped,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let store_for_update = Arc::clone(&store);
        let task_id = created.id.clone();
        let mut update = empty_update_input(&task_id);
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some("attached-secondary".to_string());
        let updated = assert_waits_for_session_lifecycle("attached-secondary", async move {
            let task_control = crate::task_scheduler::acquire_task_control(&task_id).await;
            store_for_update
                .update_with_task_control_and_session_probe(update, &task_control, |_| true)
                .await
        })
        .await;
        assert_eq!(
            updated.preselected_session_id.as_deref(),
            Some("attached-secondary")
        );
    }

    #[tokio::test]
    async fn update_status_appends_history_and_persists() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        // todo → running (system)
        let (t, tr) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);
        assert_eq!(tr.from, Some(TaskStatus::Todo));
        assert_eq!(t.status_history.len(), 2);
        assert!(t.last_executed_at.is_none());

        // running → verifying (agent/cli)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Verifying);

        // lenient: verifying → running (v1.4)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);

        // verify persistence across reopen
        drop(store);
        let store2 = TaskStore::new(store_dir);
        let reloaded = store2.get(&created.id).await.unwrap();
        // Crash recovery kicks in — running rows are rewritten to blocked at load.
        assert_eq!(reloaded.status, TaskStatus::Blocked);
        // 4 transitions from the runtime session + 1 crash-recovery transition.
        assert_eq!(reloaded.status_history.len(), 5);
        let last = reloaded.status_history.last().unwrap();
        assert_eq!(last.actor, TransitionActor::System);
        assert_eq!(last.source, Some(TransitionSource::Crash));
    }

    #[tokio::test]
    async fn update_status_rejects_invalid_transition() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("illegal transition should fail");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_deleted_as_target() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Deleted,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .expect_err("Deleted is delete()-only");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_agent_without_cli_source() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Ui), // <-- wrong
            ))
            .await
            .expect_err("agent must come from cli");
        assert!(err.contains("agent_source_must_be_cli"));
    }

    #[tokio::test]
    async fn archive_rejects_non_user_actor() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        // todo → running → done
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();

        // agent cannot archive
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Archived,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("agent cannot archive");
        assert!(err.contains("archive_user_only"));

        // user can
        let archived = store.archive(&created.id, None).await.unwrap();
        assert_eq!(archived.status, TaskStatus::Archived);
    }

    #[tokio::test]
    async fn update_rejects_while_running() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: Some("new".to_string()),
                executor: None,
                description: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                interval_minutes: None,
                cron_expression: None,
                cron_timezone: None,
                start_at: None,
                recurring_window: None,
                dispatch_at: None,
                trigger: None,
                clear_trigger: false,
                model: None,
                provider_id: None,
                clear_provider_override: false,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                clear_runtime_override: false,
                mcp_enabled_servers: None,
                clear_mcp_override: false,
                tags: None,
                notification: None,
                notification_patch: None,
                prompt: None,
            })
            .await
            .expect_err("should reject");
        assert!(err.contains("update_rejected_running"));
    }

    #[tokio::test]
    async fn notification_patch_preserves_omitted_fields_and_applies_false_and_null() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut create = sample_direct_input(&ws);
        create.notification = Some(NotificationConfig {
            desktop: true,
            bot_channel_id: Some("bot-a".to_string()),
            bot_thread: Some("thread-a".to_string()),
            events: Some(vec!["done".to_string()]),
        });
        let created = store.create_direct(create).await.unwrap();

        let mut false_patch = empty_update_input(&created.id);
        false_patch.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());
        let after_false = store.update(false_patch).await.unwrap();
        let notification = after_false.notification.unwrap();
        assert!(!notification.desktop);
        assert_eq!(notification.bot_channel_id.as_deref(), Some("bot-a"));
        assert_eq!(notification.bot_thread.as_deref(), Some("thread-a"));
        assert_eq!(notification.events, Some(vec!["done".to_string()]));

        let mut clear_patch = empty_update_input(&created.id);
        clear_patch.notification_patch = Some(
            serde_json::from_value(serde_json::json!({
                "desktop": null,
                "botChannelId": null,
                "botThread": null,
                "events": null
            }))
            .unwrap(),
        );
        let after_clear = store.update(clear_patch).await.unwrap();
        assert_eq!(
            after_clear.notification,
            Some(NotificationConfig::default())
        );
    }

    #[tokio::test]
    async fn empty_notification_patch_is_an_exact_noop() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        assert!(created.notification.is_none());

        let mut update = empty_update_input(&created.id);
        update.notification_patch = Some(serde_json::from_value(serde_json::json!({})).unwrap());
        let updated = store.update(update).await.unwrap();

        assert!(updated.notification.is_none());
    }

    #[tokio::test]
    async fn concurrent_notification_patches_preserve_both_writers() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let mut desktop = empty_update_input(&created.id);
        desktop.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());
        let mut bot = empty_update_input(&created.id);
        bot.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "botChannelId": "bot-b" })).unwrap());

        let (desktop_result, bot_result) = tokio::join!(store.update(desktop), store.update(bot));
        desktop_result.unwrap();
        bot_result.unwrap();
        let final_task = store.get(&created.id).await.unwrap();
        let notification = final_task.notification.unwrap();
        assert!(!notification.desktop);
        assert_eq!(notification.bot_channel_id.as_deref(), Some("bot-b"));
    }

    #[tokio::test]
    async fn full_notification_and_patch_are_mutually_exclusive() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let mut update = empty_update_input(&created.id);
        update.notification = Some(NotificationConfig::default());
        update.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());

        let error = store.update(update).await.unwrap_err();

        assert!(error.contains("notificationPatch"));
        assert!(store.get(&created.id).await.unwrap().notification.is_none());
    }

    #[tokio::test]
    async fn delete_soft_and_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        store.delete(&created.id).await.unwrap();
        // list excludes deleted by default
        assert!(store.list(TaskListFilter::default()).await.is_empty());
        // include_deleted shows it
        let all = store
            .list(TaskListFilter {
                include_deleted: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted);
        // Delete writes a proper `→ Deleted` pseudo-transition (not from==to).
        assert_eq!(all[0].status, TaskStatus::Deleted);
        let last = all[0].status_history.last().unwrap();
        assert_eq!(last.to, TaskStatus::Deleted);
        assert_eq!(last.from, Some(TaskStatus::Todo));
        assert_eq!(last.actor, TransitionActor::User);

        // second delete is a no-op
        store.delete(&created.id).await.unwrap();
    }

    #[tokio::test]
    async fn startup_retries_trigger_state_cleanup_for_deleted_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.delete(&created.id).await.unwrap();

        // Recreate the file after delete to model a transient cleanup failure
        // that left the durable deleted row as the retry obligation.
        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(&trigger_state, "orphaned-state").unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        assert!(recovered.get(&created.id).await.unwrap().deleted);
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn startup_retries_trigger_state_cleanup_for_non_command_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        });
        let created = store.create_direct(input).await.unwrap();
        let mut update = empty_update_input(&created.id);
        update.trigger = Some(crate::task_trigger::TaskTrigger::default());
        let updated = store.update(update).await.unwrap();
        assert!(!updated.effective_trigger().is_command());

        // Recreate the file after the authoritative command-to-always row
        // commit to model a transient physical-cleanup failure. The
        // non-command row remains the durable retry obligation across restart.
        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(&trigger_state, "orphaned-state").unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        assert!(!recovered
            .get(&created.id)
            .await
            .unwrap()
            .effective_trigger()
            .is_command());
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn failed_command_cleanup_blocks_reenable_until_stale_state_is_gone() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let command_trigger = crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        };
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(command_trigger.clone());
        let created = store.create_direct(input).await.unwrap();

        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(
            &trigger_state,
            serde_json::to_vec(&crate::task_trigger::TaskTriggerRuntimeState::default()).unwrap(),
        )
        .unwrap();
        let cleanup_failure = crate::task_trigger::force_trigger_cleanup_failure(&created.id);
        let mut disable = empty_update_input(&created.id);
        disable.trigger = Some(crate::task_trigger::TaskTrigger::default());
        let disabled = store.update(disable).await.unwrap();
        assert!(!disabled.effective_trigger().is_command());
        assert!(trigger_state.exists());

        let mut reenable = empty_update_input(&created.id);
        reenable.trigger = Some(command_trigger.clone());
        let error = store.update(reenable).await.unwrap_err();
        assert!(error.contains("remove"), "got: {error}");
        let still_disabled = store.get(&created.id).await.unwrap();
        assert!(!still_disabled.effective_trigger().is_command());
        assert!(trigger_state.exists());

        drop(cleanup_failure);
        let mut retry = empty_update_input(&created.id);
        retry.trigger = Some(command_trigger);
        let reenabled = store.update(retry).await.unwrap();
        assert!(reenabled.effective_trigger().is_command());
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn stop_reports_pending_activation_cleanup_failure_after_persisting_status() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data_dir = dir.path().join("data");
        let store = TaskStore::new(data_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        });
        let created = store.create_direct(input).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        // Make the TaskStore-owned trigger-state root non-traversable. The
        // durable status write still succeeds, while pending cancellation must
        // fail loudly so the user can retry instead of assuming cleanup won.
        std::fs::write(data_dir.join("tasks"), "not-a-directory").unwrap();

        let error = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Stopped,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap_err();
        assert!(error.contains("trigger-state.json"), "got: {error}");
        assert_eq!(
            store.get(&created.id).await.unwrap().status,
            TaskStatus::Stopped
        );
    }

    #[test]
    fn ambiguous_exact_stop_keeps_the_durable_pending_activation() {
        assert!(!should_cancel_pending_after_transition(
            TaskStatus::Stopped,
            true,
            false,
        ));
        assert!(should_cancel_pending_after_transition(
            TaskStatus::Stopped,
            true,
            true,
        ));
    }

    #[tokio::test]
    async fn delete_rejects_until_the_exact_execution_is_settled() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let scheduler = crate::task_scheduler::get_task_scheduler();
        let queue_id = scheduler
            .claim_execution_for_test(&created.id)
            .await
            .unwrap();

        let result = store.delete(&created.id).await;
        scheduler
            .release_execution_for_test(&created.id, &queue_id)
            .await;

        let error = result.expect_err("delete must fail closed until exact stop is confirmed");
        assert!(
            error.contains("current turn could not be confirmed stopped"),
            "got: {error}"
        );
        assert!(!store.get(&created.id).await.unwrap().deleted);
    }

    #[test]
    fn task_docs_dir_rejects_traversal() {
        assert!(task_docs_dir("../etc").is_err());
        assert!(task_docs_dir("..").is_err());
        assert!(task_docs_dir("a/b").is_err());
        assert!(task_docs_dir("a\\b").is_err());
        assert!(task_docs_dir(".hidden").is_err());
        assert!(task_docs_dir("").is_err());
        // Valid UUID-ish id works
        assert!(task_docs_dir("abc-123_ok").is_ok());
    }

    #[test]
    fn normalize_mcp_override_preserves_explicit_empty() {
        assert_eq!(normalize_mcp_override(None), None);
        assert_eq!(normalize_mcp_override(Some(vec![])), Some(vec![]));
        assert_eq!(
            normalize_mcp_override(Some(vec!["tool-a".to_string()])),
            Some(vec!["tool-a".to_string()])
        );
    }

    #[tokio::test]
    async fn remove_mcp_server_references_preserves_empty_override() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.mcp_enabled_servers = Some(vec!["removed".to_string()]);
        let created = store.create_direct(input).await.unwrap();

        let updated = store.remove_mcp_server_references("removed").await.unwrap();
        assert_eq!(updated, 1);

        let task = store.get(&created.id).await.unwrap();
        assert_eq!(task.mcp_enabled_servers, Some(vec![]));
    }

    #[tokio::test]
    async fn update_rejects_conflicting_mcp_override_inputs() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: None,
                executor: None,
                description: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                interval_minutes: None,
                cron_expression: None,
                cron_timezone: None,
                start_at: None,
                recurring_window: None,
                dispatch_at: None,
                trigger: None,
                clear_trigger: false,
                model: None,
                provider_id: None,
                clear_provider_override: false,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                clear_runtime_override: false,
                mcp_enabled_servers: Some(vec![]),
                clear_mcp_override: true,
                tags: None,
                notification: None,
                notification_patch: None,
                prompt: None,
            })
            .await
            .expect_err("should reject contradictory MCP override inputs");

        assert!(err.contains("mcpEnabledServers"));
        assert!(err.contains("clearMcpOverride"));
    }

    /// PRD 0.2.9 — verify the provider-routing validator enforces both
    /// invariants (pairing + external-runtime exclusion) and accepts the
    /// "follow Agent" empty state plus the legacy `model`-only shape.
    #[test]
    fn validate_task_provider_routing_enforces_pairing_and_runtime_exclusion() {
        // 1. Empty (= follow Agent) — accepted.
        assert!(validate_task_provider_routing(&None, &None, &None).is_ok());

        // 2. Pair (provider + model) on builtin runtime — accepted.
        assert!(validate_task_provider_routing(
            &Some("openai-x".into()),
            &Some("gpt-4o".into()),
            &Some("builtin".into()),
        )
        .is_ok());

        // 3. providerId without model — rejected (cross-provider misroute risk).
        let err =
            validate_task_provider_routing(&Some("openai-x".into()), &None, &None).unwrap_err();
        assert!(err.contains("providerId"), "got: {}", err);
        assert!(err.contains("model"), "got: {}", err);

        // 4. External runtime + providerId — rejected (codex / cc / gemini
        //    self-manage providers).
        for rt in ["claude-code", "codex", "gemini"] {
            let err = validate_task_provider_routing(
                &Some("openai-x".into()),
                &Some("gpt-4o".into()),
                &Some(rt.to_string()),
            )
            .unwrap_err();
            assert!(err.contains(rt), "got: {}", err);
        }

        // 5. Legacy `model`-only (pre-0.2.9 task) — accepted as FollowAgent.
        assert!(
            validate_task_provider_routing(&None, &Some("legacy-model".into()), &None,).is_ok()
        );

        // 6. External runtime without provider override — accepted (the
        //    common case for codex/gemini/cc tasks).
        assert!(validate_task_provider_routing(&None, &None, &Some("codex".into()),).is_ok());
    }

    /// PRD 0.2.9 — verify `pin_runtime_for_provider_id` materialises
    /// `runtime: 'builtin'` when `provider_id` is set with no explicit
    /// runtime. Closes the cross-talk hole flagged by Codex review.
    #[test]
    fn pin_runtime_for_provider_id_materialises_builtin() {
        // 1. provider_id set, runtime None → pin to builtin.
        let mut rt: Option<String> = None;
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt);
        assert_eq!(rt, Some("builtin".into()));

        // 2. provider_id None, runtime None → no change.
        let mut rt2: Option<String> = None;
        pin_runtime_for_provider_id(&None, &mut rt2);
        assert_eq!(rt2, None);

        // 3. provider_id set, runtime already set → no change (idempotent).
        let mut rt3: Option<String> = Some("builtin".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt3);
        assert_eq!(rt3, Some("builtin".into()));

        // 4. provider_id set, runtime explicitly external → no change here
        //    (validator catches the conflict afterward).
        let mut rt4: Option<String> = Some("codex".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt4);
        assert_eq!(rt4, Some("codex".into()));
    }

    #[tokio::test]
    async fn crash_recovery_rewrites_running_to_blocked_on_reload() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let a = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let b = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &a.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let ra = recovered.get(&a.id).await.unwrap();
        let rb = recovered.get(&b.id).await.unwrap();
        assert_eq!(ra.status, TaskStatus::Blocked);
        assert_eq!(rb.status, TaskStatus::Blocked);
        // Each has a crash-recovery transition appended.
        assert_eq!(
            ra.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
        assert_eq!(
            rb.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
    }

    #[tokio::test]
    async fn startup_preserves_enabled_time_schedules_for_scheduler_recovery() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let mut recurring_input = sample_direct_input(&ws);
        recurring_input.execution_mode = TaskExecutionMode::Recurring;
        recurring_input.interval_minutes = Some(60);
        let recurring = store.create_direct(recurring_input).await.unwrap();

        let mut scheduled_input = sample_direct_input(&ws);
        scheduled_input.execution_mode = TaskExecutionMode::Scheduled;
        scheduled_input.dispatch_at = Some(now_ms() + 60_000);
        let scheduled = store.create_direct(scheduled_input).await.unwrap();

        for id in [&recurring.id, &scheduled.id] {
            store
                .update_status(status_input(
                    id,
                    TaskStatus::Running,
                    TransitionActor::System,
                    Some(TransitionSource::Scheduler),
                ))
                .await
                .unwrap();
        }
        let recurring_history_len = recurring.status_history.len() + 1;
        let scheduled_history_len = scheduled.status_history.len() + 1;
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let recurring = recovered.get(&recurring.id).await.unwrap();
        let scheduled = recovered.get(&scheduled.id).await.unwrap();
        assert_eq!(recurring.status, TaskStatus::Running);
        assert_eq!(scheduled.status, TaskStatus::Running);
        assert_eq!(recurring.status_history.len(), recurring_history_len);
        assert_eq!(scheduled.status_history.len(), scheduled_history_len);
    }

    #[tokio::test]
    async fn status_filter_accepts_single_or_array() {
        use serde_json::json;
        // Single value
        let f: TaskListFilter = serde_json::from_value(json!({"status": "running"})).unwrap();
        assert!(f.status.is_some());
        // Array of values
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": ["running", "done"]})).unwrap();
        assert!(f.status.is_some());
    }

    #[tokio::test]
    async fn dispatch_origin_and_run_mode_serialize_kebab_case() {
        // PRD §3.2 / TS shared types — these wire values must match exactly.
        let d = TaskDispatchOrigin::AiAligned;
        assert_eq!(serde_json::to_string(&d).unwrap(), "\"ai-aligned\"");
        let attached = TaskDispatchOrigin::AttachedSession;
        assert_eq!(
            serde_json::to_string(&attached).unwrap(),
            "\"attached-session\""
        );
        let r = TaskRunMode::SingleSession;
        assert_eq!(serde_json::to_string(&r).unwrap(), "\"single-session\"");
    }

    #[test]
    fn execution_projection_serializes_as_transient_camel_case_fields() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-projection",
            "name": "projection",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "once",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let projection = TaskProjection::new(
            task,
            Some(crate::task_scheduler::TaskExecutionProjection {
                state: crate::task_scheduler::TaskExecutionState::StopFailed,
                error: Some("stop failed".to_string()),
            }),
        );

        let value = serde_json::to_value(projection).unwrap();
        assert_eq!(
            value.get("executionState"),
            Some(&serde_json::json!("stop_failed"))
        );
        assert_eq!(
            value.get("executionError"),
            Some(&serde_json::json!("stop failed"))
        );
        assert!(value.get("execution_state").is_none());
        assert!(value.get("triggerState").is_none());
    }

    #[tokio::test]
    async fn end_conditions_deadline_serializes_as_ms() {
        let ec = TaskEndConditions {
            deadline: Some(1_700_000_000_000),
            max_executions: Some(5),
            ai_can_exit: true,
        };
        let s = serde_json::to_string(&ec).unwrap();
        assert!(s.contains("\"deadline\":1700000000000"));
    }

    #[tokio::test]
    // `tokio::spawn` is fine inside `#[tokio::test]` — the test attribute
    // provides the runtime context. Allow the project-wide ban only here.
    #[allow(clippy::disallowed_methods)]
    async fn concurrent_creates_preserve_all_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));

        let mut handles = Vec::new();
        for i in 0..20 {
            let s = store.clone();
            let w = ws.clone();
            handles.push(tokio::spawn(async move {
                let mut input = sample_direct_input(&w);
                input.name = format!("task {}", i);
                s.create_direct(input).await.unwrap()
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let listed = store.list(TaskListFilter::default()).await;
        assert_eq!(listed.len(), 20);
    }

    #[tokio::test]
    async fn append_session_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-2").await.unwrap();
        let reloaded = store.get(&created.id).await.unwrap();
        assert_eq!(
            reloaded.session_ids,
            vec!["sess-1".to_string(), "sess-2".to_string()]
        );
    }

    // Removed `update_progress_appends_to_file` test: targeted `TaskStore::update_progress`
    // which was renamed/removed in v0.1.69+ (see comment at line 1935 about
    // append_progress_line). Test code was stale dead reference blocking the
    // workspace test binary from compiling. Cleaned up incidentally during
    // PRD 0.2.7 Phase A so workspace_files unit tests can run.
}
