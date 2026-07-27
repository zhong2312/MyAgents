use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, TimeZone, Utc};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::cron_task::CronRunRecord;
use crate::task::{
    task_protects_session_identity, Task, TaskExecutionMode, TaskExecutionTrigger, TaskListFilter,
    TaskStatus, TaskUpdateStatusInput, TransitionActor, TransitionSource,
};
use crate::{ulog_error, ulog_info, ulog_warn};

pub struct TaskSchedulerController {
    handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

#[derive(Debug)]
struct ActiveTaskExecution {
    queue_id: String,
    canceled: bool,
    session_id: Option<String>,
    pending_session_birth: Option<PendingSessionBirth>,
    state: TaskExecutionState,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionState {
    Running,
    Stopping,
    StopFailed,
}

impl TaskExecutionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::StopFailed => "stop_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionProjection {
    pub state: TaskExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct ReservedExecutionSession {
    session_id: String,
    initialize_session: bool,
    // Session metadata birth must finish before a second Task sharing this
    // identity can enter the adopt path. The guard is released as soon as the
    // authoritative SessionStore row appears, not held for the whole AI turn.
    birth_lifecycle: Arc<crate::sidecar::SessionLifecycleGuard>,
}

struct PendingSessionBirth {
    session_id: String,
    _lifecycle: Arc<crate::sidecar::SessionLifecycleGuard>,
}

impl std::fmt::Debug for PendingSessionBirth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingSessionBirth")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

type ActiveExecutions = Arc<RwLock<HashMap<String, ActiveTaskExecution>>>;

pub(crate) type TaskControlGuard = crate::keyed_lifecycle::KeyedLifecycleGuard;

static TASK_CONTROL_LIFECYCLES: std::sync::OnceLock<
    crate::keyed_lifecycle::KeyedLifecycleRegistry,
> = std::sync::OnceLock::new();

pub(crate) async fn acquire_task_control(task_id: &str) -> TaskControlGuard {
    TASK_CONTROL_LIFECYCLES
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .acquire(&[task_id])
        .await
}

pub(crate) async fn try_acquire_task_control(task_id: &str) -> Option<TaskControlGuard> {
    TASK_CONTROL_LIFECYCLES
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .try_acquire(task_id)
        .await
}

impl TaskSchedulerController {
    fn new() -> Self {
        Self {
            handles: Arc::new(RwLock::new(HashMap::new())),
            executions: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn initialize(&self, handle: AppHandle) {
        *self.app_handle.write().await = Some(handle.clone());
        let Some(store) = crate::task::get_task_store() else {
            ulog_error!("[task-scheduler] TaskStore is not initialized");
            return;
        };
        let running = store
            .list(TaskListFilter {
                status: Some(crate::task::StatusFilter::One(TaskStatus::Running)),
                include_managed: Some(true),
                ..Default::default()
            })
            .await;

        for task in running {
            if task.execution_mode == TaskExecutionMode::Loop {
                let _ = store
                    .update_status(TaskUpdateStatusInput {
                        id: task.id,
                        status: TaskStatus::Stopped,
                        message: Some("Legacy Loop tasks are retired".to_string()),
                        actor: TransitionActor::System,
                        source: Some(TransitionSource::Migration),
                    })
                    .await;
                continue;
            }
            if let Err(error) = self.start(&task.id).await {
                ulog_error!(
                    "[task-scheduler] failed to restore task {}: {}",
                    task.id,
                    error
                );
                block_task(&task, format!("Task scheduler recovery failed: {error}")).await;
            }
        }
        let _ = handle.emit("task:scheduler-ready", serde_json::json!({}));
    }

    pub async fn start(&self, task_id: &str) -> Result<(), String> {
        let control = acquire_task_control(task_id).await;
        self.start_with_control_held(task_id, &control).await
    }

    pub(crate) async fn start_with_control_held(
        &self,
        task_id: &str,
        _control: &TaskControlGuard,
    ) -> Result<(), String> {
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted || task.status != TaskStatus::Running {
            return Err(format!("task {task_id} is not running"));
        }
        validate_task_schedule(&task)?;

        let mut handles = self.handles.write().await;
        let execution = self.execution_projection(task_id).await;
        if execution.as_ref().is_some_and(|execution| {
            matches!(
                execution.state,
                TaskExecutionState::Stopping | TaskExecutionState::StopFailed
            )
        }) {
            let state = execution.expect("checked above").state;
            return Err(format!(
                "task {task_id} has an unresolved {} execution",
                state.as_str()
            ));
        }

        if let Some(existing) = handles.get(task_id) {
            if !existing.inner().is_finished() {
                return Ok(());
            }
            handles.remove(task_id);
        }
        if let Some(execution) = execution {
            return Err(format!(
                "task {task_id} has an unresolved {} execution",
                execution.state.as_str()
            ));
        }

        let task_id_owned = task_id.to_string();
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let handle = tauri::async_runtime::spawn(async move {
            run_scheduler_loop(task_id_owned.clone(), executions, app_handle).await;
            ulog_info!("[task-scheduler] loop exited task={}", task_id_owned);
        });
        handles.insert(task_id.to_string(), handle);
        drop(handles);
        emit_cron_ui_event(
            &self.app_handle,
            "cron:scheduler-started",
            serde_json::json!({
                "taskId": task.id,
                "intervalMinutes": task.interval_minutes.unwrap_or(0),
                "executionCount": task.execution_count,
            }),
        )
        .await;
        ulog_info!("[task-scheduler] armed task={}", task_id);
        Ok(())
    }

    pub async fn stop(&self, task_id: &str) -> Result<(), String> {
        let control = acquire_task_control(task_id).await;
        self.stop_with_control_held(task_id, &control).await
    }

    pub(crate) async fn stop_with_control_held(
        &self,
        task_id: &str,
        _control: &TaskControlGuard,
    ) -> Result<(), String> {
        let active = {
            let mut executions = self.executions.write().await;
            executions.get_mut(task_id).map(|execution| {
                execution.canceled = true;
                execution.state = TaskExecutionState::Stopping;
                execution.error = None;
                (execution.queue_id.clone(), execution.session_id.clone())
            })
        };
        if active.is_some() {
            self.emit_execution_state(task_id).await;
        }
        let scheduler_handle = self.handles.write().await.remove(task_id);
        // The timer loop must stop immediately. Its claimed execution is a
        // detached worker and is stopped below by exact queue identity.
        if let Some(handle) = scheduler_handle {
            handle.abort();
        }
        let task = match crate::task::get_task_store() {
            Some(store) => store.get(task_id).await,
            None => None,
        };
        let app_handle = self.app_handle.read().await.clone();
        let stop_result = match (&active, app_handle.as_ref(), task.as_ref()) {
            (Some((queue_id, active_session)), Some(handle), Some(task)) => {
                crate::task_execution::stop_task_turn(
                    handle,
                    task,
                    active_session.as_deref(),
                    queue_id,
                )
                .await
                .map(|()| {
                    crate::task_execution::release_task_sessions(
                        handle,
                        task,
                        active_session.as_deref(),
                    );
                })
            }
            (Some(_), None, _) => Err("Task scheduler app handle is unavailable".to_string()),
            (Some(_), _, None) => Err(format!("task not found while stopping: {task_id}")),
            (None, Some(handle), Some(task)) => {
                crate::task_execution::release_task_sessions(handle, task, None);
                Ok(())
            }
            (None, _, _) => Ok(()),
        };

        if let Err(error) = stop_result {
            let message = format!(
                "Task schedule is stopped, but the current turn could not be confirmed stopped: {error}"
            );
            let mut executions = self.executions.write().await;
            if let Some((queue_id, _)) = active.as_ref() {
                if let Some(execution) = executions
                    .get_mut(task_id)
                    .filter(|execution| execution.queue_id == *queue_id)
                {
                    execution.state = TaskExecutionState::StopFailed;
                    execution.error = Some(message.clone());
                }
            }
            drop(executions);
            self.emit_execution_state(task_id).await;
            ulog_error!("[task-scheduler] task={} {}", task_id, message);
            return Err(message);
        }

        if let Some((queue_id, _)) = active {
            release_execution(&self.executions, task_id, &queue_id).await;
            self.emit_execution_state(task_id).await;
        }
        if let Some(handle) = app_handle {
            let _ = handle.emit(
                "cron:task-stopped",
                serde_json::json!({ "taskId": task_id }),
            );
        }
        Ok(())
    }

    pub async fn trigger_now(&self, task_id: &str) -> Result<String, String> {
        let control = try_acquire_task_control(task_id).await.ok_or_else(|| {
            format!(
                "task {task_id} is stopping or changing scheduler state; retry after it settles"
            )
        })?;
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted {
            return Err(format!("task {task_id} is deleted"));
        }
        if !matches!(task.status, TaskStatus::Running | TaskStatus::Stopped) {
            return Err(format!(
                "task {task_id} is {}; run-now only supports running or stopped tasks",
                task.status.as_str()
            ));
        }
        if self.app_handle.read().await.is_none() {
            return Err("task scheduler app handle is unavailable".to_string());
        }
        let queue_id = claim_execution(&self.executions, task_id).await?;
        let reserved_session = match reserve_claimed_execution_session(
            &self.executions,
            store,
            &task,
            &queue_id,
        )
        .await
        {
            Ok(Some(reserved_session)) => reserved_session,
            Ok(None) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(format!("task {task_id} does not execute in a Session"));
            }
            Err(error) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(error);
            }
        };
        self.emit_execution_state(task_id).await;

        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id = task.id;
        let session_id = reserved_session.session_id.clone();
        drop(control);
        tauri::async_runtime::spawn(async move {
            let claim = ExecutionClaimGuard::new(
                Arc::clone(&executions),
                Arc::clone(&app_handle),
                task_id.clone(),
                queue_id.clone(),
            );
            if let Err(error) = run_one_claimed(
                &task_id,
                &queue_id,
                &executions,
                &app_handle,
                TaskExecutionTrigger::Manual,
                Some(reserved_session),
            )
            .await
            {
                ulog_error!(
                    "[task-scheduler] immediate run failed task={}: {}",
                    task_id,
                    error
                );
            }
            claim.settle().await;
        });
        Ok(session_id)
    }

    pub async fn is_executing(&self, task_id: &str) -> bool {
        self.executions.read().await.contains_key(task_id)
    }

    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executions.read().await.keys().cloned().collect()
    }

    pub async fn execution_projection(&self, task_id: &str) -> Option<TaskExecutionProjection> {
        self.executions
            .read()
            .await
            .get(task_id)
            .map(|execution| TaskExecutionProjection {
                state: execution.state,
                error: execution.error.clone(),
            })
    }

    pub async fn execution_projections_snapshot(&self) -> HashMap<String, TaskExecutionProjection> {
        self.executions
            .read()
            .await
            .iter()
            .map(|(task_id, execution)| {
                (
                    task_id.clone(),
                    TaskExecutionProjection {
                        state: execution.state,
                        error: execution.error.clone(),
                    },
                )
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) async fn claim_execution_for_test(&self, task_id: &str) -> Result<String, String> {
        claim_execution(&self.executions, task_id).await
    }

    #[cfg(test)]
    pub(crate) async fn release_execution_for_test(&self, task_id: &str, queue_id: &str) {
        release_execution(&self.executions, task_id, queue_id).await;
    }

    pub async fn authorize_dispatch(&self, task_id: &str, queue_id: &str) -> bool {
        execution_is_authorized(&self.executions, task_id, queue_id).await
    }

    /// Publish the concrete Session currently used by a local managed Task
    /// batch. Exact queue authority gates the write, so a stop that wins first
    /// prevents later Session dispatch; once published, `/task/stop` can target
    /// the active SessionEngine turn.
    pub(crate) async fn bind_execution_session(
        &self,
        task_id: &str,
        queue_id: &str,
        session_id: &str,
    ) -> bool {
        let mut active = self.executions.write().await;
        let Some(execution) = active.get_mut(task_id) else {
            return false;
        };
        if execution.queue_id != queue_id || execution.canceled {
            return false;
        }
        execution.session_id = Some(session_id.to_string());
        true
    }

    #[cfg(test)]
    async fn cancel_execution(&self, task_id: &str) {
        if let Some(execution) = self.executions.write().await.get_mut(task_id) {
            execution.canceled = true;
            execution.state = TaskExecutionState::Stopping;
        }
    }

    async fn emit_execution_state(&self, task_id: &str) {
        emit_execution_state_event(&self.executions, &self.app_handle, task_id).await;
    }
}

async fn claim_execution(executions: &ActiveExecutions, task_id: &str) -> Result<String, String> {
    let mut active = executions.write().await;
    if active.contains_key(task_id) {
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = uuid::Uuid::new_v4().to_string();
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
            pending_session_birth: None,
            state: TaskExecutionState::Running,
            error: None,
        },
    );
    Ok(queue_id)
}

async fn execution_is_authorized(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
) -> bool {
    executions
        .read()
        .await
        .get(task_id)
        .is_some_and(|active| active.queue_id == queue_id && !active.canceled)
}

async fn reserve_claimed_execution_session(
    executions: &ActiveExecutions,
    store: &crate::task::TaskStore,
    task: &Task,
    queue_id: &str,
) -> Result<Option<ReservedExecutionSession>, String> {
    if !crate::task_execution::uses_session_engine(task) {
        return Ok(None);
    }
    let selected_session_id = crate::task_execution::select_execution_session(task);
    // Deletion takes this same guard before checking durable/transient owners.
    // Hold it from the moment the execution publishes its Session identity,
    // through the durable Task binding and any required Session metadata
    // birth. `execute_task_with_reservation` releases it at that exact point.
    let selected_lifecycle =
        crate::sidecar::acquire_session_lifecycle(&[&selected_session_id]).await;
    let selected_materialized = session_metadata_exists(&selected_session_id).await;
    let selected_was_bound = crate::task::task_bound_session_ids(task)
        .iter()
        .any(|session_id| session_id == &selected_session_id);

    let (session_id, lifecycle, initialize_session) =
        if selected_was_bound && !selected_materialized {
            // A persisted binding whose SessionStore row was deleted is
            // historical identity, not permission to resurrect that UUID.
            // Rebind to a fresh identity while both old and new lifecycles are
            // fenced. The fresh UUID cannot already be visible to another
            // owner, so nested acquisition cannot invert an existing lock
            // order.
            let replacement_session_id = uuid::Uuid::new_v4().to_string();
            let replacement_lifecycle =
                crate::sidecar::acquire_session_lifecycle(&[&replacement_session_id]).await;
            store
                .set_execution_session_with_lifecycle_held(
                    &task.id,
                    replacement_session_id.clone(),
                    Some(&selected_session_id),
                )
                .await?;
            drop(selected_lifecycle);
            (replacement_session_id, replacement_lifecycle, true)
        } else {
            store
                .append_session_with_lifecycle_held(&task.id, &selected_session_id)
                .await?;
            (
                selected_session_id,
                selected_lifecycle,
                !selected_materialized,
            )
        };
    let birth_lifecycle = Arc::new(lifecycle);
    {
        let mut active = executions.write().await;
        let Some(execution) = active.get_mut(&task.id) else {
            return Err("Task execution was canceled before Session dispatch".to_string());
        };
        if execution.queue_id != queue_id || execution.canceled {
            return Err("Task execution was canceled before Session dispatch".to_string());
        }
        execution.session_id = Some(session_id.clone());
        if initialize_session {
            // The exact execution generation, not its worker future, owns the
            // fail-closed metadata-birth authority. Worker abort/panic may
            // mark this generation StopFailed but cannot release the lease.
            execution.pending_session_birth = Some(PendingSessionBirth {
                session_id: session_id.clone(),
                _lifecycle: Arc::clone(&birth_lifecycle),
            });
        }
    }
    if initialize_session {
        observe_reserved_session_birth(
            Arc::clone(executions),
            task.id.clone(),
            queue_id.to_string(),
            session_id.clone(),
        );
    }
    Ok(Some(ReservedExecutionSession {
        session_id,
        initialize_session,
        birth_lifecycle,
    }))
}

async fn session_metadata_exists(session_id: &str) -> bool {
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(&session_id)
            .is_some()
    })
    .await
    .unwrap_or(false)
}

async fn clear_pending_session_birth(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
    session_id: &str,
) -> bool {
    let mut active = executions.write().await;
    let Some(execution) = active
        .get_mut(task_id)
        .filter(|execution| execution.queue_id == queue_id)
    else {
        return false;
    };
    if execution
        .pending_session_birth
        .as_ref()
        .is_some_and(|pending| pending.session_id == session_id)
    {
        execution.pending_session_birth = None;
        true
    } else {
        false
    }
}

fn observe_reserved_session_birth(
    executions: ActiveExecutions,
    task_id: String,
    queue_id: String,
    session_id: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut polls = 0_u32;
        loop {
            if session_metadata_exists(&session_id).await {
                clear_pending_session_birth(&executions, &task_id, &queue_id, &session_id).await;
                return;
            }
            let exact_generation_still_owns_birth = executions
                .read()
                .await
                .get(&task_id)
                .filter(|execution| execution.queue_id == queue_id)
                .and_then(|execution| execution.pending_session_birth.as_ref())
                .is_some_and(|pending| pending.session_id == session_id);
            if !exact_generation_still_owns_birth {
                return;
            }
            polls = polls.saturating_add(1);
            let delay_ms = if polls <= 50 { 20 } else { 250 };
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    });
}

async fn execute_task_with_reservation(
    handle: &AppHandle,
    task: &Task,
    queue_id: &str,
    executions: &ActiveExecutions,
    reservation: Option<ReservedExecutionSession>,
) -> Result<crate::task_execution::TaskExecutionOutcome, String> {
    let Some(reservation) = reservation else {
        return crate::task_execution::execute_managed_task(handle, task, queue_id).await;
    };
    let ReservedExecutionSession {
        session_id,
        initialize_session,
        birth_lifecycle,
    } = reservation;
    let result = crate::task_execution::execute_task(
        handle,
        task,
        queue_id,
        session_id.clone(),
        initialize_session,
        birth_lifecycle,
    )
    .await;
    if !result
        .as_ref()
        .is_ok_and(|outcome| outcome.termination_unconfirmed)
    {
        // Confirmed failure can retry as a new creator. Successful turns have
        // already materialized; clearing here is an idempotent fast path for
        // the observer. Ambiguous transport remains owned by the exact active
        // execution until metadata birth or confirmed stop removes it.
        clear_pending_session_birth(executions, &task.id, queue_id, &session_id).await;
    }
    result
}

async fn release_execution(executions: &ActiveExecutions, task_id: &str, queue_id: &str) {
    let mut active = executions.write().await;
    if active
        .get(task_id)
        .is_some_and(|execution| execution.queue_id == queue_id)
    {
        active.remove(task_id);
    }
}

async fn retain_unconfirmed_execution(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
    error: String,
) {
    let mut active = executions.write().await;
    if let Some(execution) = active
        .get_mut(task_id)
        .filter(|execution| execution.queue_id == queue_id)
    {
        execution.canceled = true;
        execution.state = TaskExecutionState::StopFailed;
        execution.error = Some(error);
    }
}

async fn emit_execution_state_event(
    executions: &ActiveExecutions,
    app_handle: &RwLock<Option<AppHandle>>,
    task_id: &str,
) {
    let projection =
        executions
            .read()
            .await
            .get(task_id)
            .map(|execution| TaskExecutionProjection {
                state: execution.state,
                error: execution.error.clone(),
            });
    if let Some(handle) = app_handle.read().await.as_ref() {
        let _ = handle.emit(
            "cron:execution-state-changed",
            serde_json::json!({
                "taskId": task_id,
                "state": projection.as_ref().map(|value| value.state),
                "error": projection.and_then(|value| value.error),
            }),
        );
    }
}

struct ExecutionClaimGuard {
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    task_id: String,
    queue_id: String,
    settled: bool,
}

impl ExecutionClaimGuard {
    fn new(
        executions: ActiveExecutions,
        app_handle: Arc<RwLock<Option<AppHandle>>>,
        task_id: String,
        queue_id: String,
    ) -> Self {
        Self {
            executions,
            app_handle,
            task_id,
            queue_id,
            settled: false,
        }
    }

    async fn settle(mut self) {
        let mut active = self.executions.write().await;
        let keep_for_stop_confirmation = active
            .get(&self.task_id)
            .filter(|execution| execution.queue_id == self.queue_id)
            .is_some_and(|execution| {
                matches!(
                    execution.state,
                    TaskExecutionState::Stopping | TaskExecutionState::StopFailed
                )
            });
        if !keep_for_stop_confirmation
            && active
                .get(&self.task_id)
                .is_some_and(|execution| execution.queue_id == self.queue_id)
        {
            active.remove(&self.task_id);
        }
        drop(active);
        emit_execution_state_event(&self.executions, &self.app_handle, &self.task_id).await;
        self.settled = true;
    }
}

impl Drop for ExecutionClaimGuard {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id = self.task_id.clone();
        let queue_id = self.queue_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut active = executions.write().await;
            if let Some(execution) = active
                .get_mut(&task_id)
                .filter(|execution| execution.queue_id == queue_id)
            {
                execution.canceled = true;
                execution.state = TaskExecutionState::StopFailed;
                execution.error = Some(
                    "Task execution worker ended before lifecycle settlement; stop it before rerunning"
                        .to_string(),
                );
            }
            drop(active);
            emit_execution_state_event(&executions, &app_handle, &task_id).await;
        });
    }
}

async fn run_scheduler_loop(
    task_id: String,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
) {
    loop {
        let Some(store) = crate::task::get_task_store() else {
            return;
        };
        let Some(task) = store.get(&task_id).await else {
            return;
        };
        if task.deleted || task.status != TaskStatus::Running {
            return;
        }
        if end_condition_reached(&task) {
            finish_task(
                &task,
                "Task end condition reached",
                TransitionSource::EndCondition,
            )
            .await;
            return;
        }
        let target = match next_execution_at(&task) {
            Ok(Some(target)) => target,
            Ok(None) => return,
            Err(error) => {
                block_task(&task, error).await;
                return;
            }
        };
        sleep_until_wallclock(target).await;

        let result = run_one(&task_id, &executions, &app_handle).await;
        match result {
            Ok(RunDisposition::Continue) => {}
            Ok(RunDisposition::Stop) => return,
            Err(error) => {
                ulog_error!("[task-scheduler] task={} run failed: {}", task_id, error);
                return;
            }
        }
    }
}

enum RunDisposition {
    Continue,
    Stop,
}

async fn run_one(
    task_id: &str,
    executions: &ActiveExecutions,
    app_handle: &Arc<RwLock<Option<AppHandle>>>,
) -> Result<RunDisposition, String> {
    let control = acquire_task_control(task_id).await;
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(RunDisposition::Stop);
    }

    let queue_id = match claim_execution(executions, task_id).await {
        Ok(queue_id) => queue_id,
        Err(_) => {
            ulog_warn!("[task-scheduler] overlap skipped task={}", task_id);
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            return Ok(RunDisposition::Continue);
        }
    };
    let reserved_session =
        match reserve_claimed_execution_session(executions, store, &task, &queue_id).await {
            Ok(reservation) => reservation,
            Err(error) => {
                release_execution(executions, task_id, &queue_id).await;
                return Err(error);
            }
        };
    emit_execution_state_event(executions, app_handle, task_id).await;
    drop(control);

    let task_id_owned = task_id.to_string();
    let queue_id_owned = queue_id.clone();
    let executions = Arc::clone(executions);
    let app_handle = Arc::clone(app_handle);
    let worker = tauri::async_runtime::spawn(async move {
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            Arc::clone(&app_handle),
            task_id_owned.clone(),
            queue_id_owned.clone(),
        );
        let result = run_one_claimed(
            &task_id_owned,
            &queue_id_owned,
            &executions,
            &app_handle,
            TaskExecutionTrigger::Scheduled,
            reserved_session,
        )
        .await;
        claim.settle().await;
        result
    });
    worker
        .await
        .map_err(|error| format!("task execution worker failed: {error}"))?
}

async fn run_one_claimed(
    task_id: &str,
    queue_id: &str,
    executions: &ActiveExecutions,
    app_handle: &RwLock<Option<AppHandle>>,
    trigger: TaskExecutionTrigger,
    reserved_session: Option<ReservedExecutionSession>,
) -> Result<RunDisposition, String> {
    if !execution_is_authorized(executions, task_id, queue_id).await {
        return Ok(RunDisposition::Stop);
    }
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted
        || (trigger == TaskExecutionTrigger::Scheduled && task.status != TaskStatus::Running)
    {
        return Ok(RunDisposition::Stop);
    }
    let started = Instant::now();
    let handle = app_handle
        .read()
        .await
        .clone()
        .ok_or_else(|| "task scheduler app handle is unavailable".to_string());
    emit_cron_ui_event(
        app_handle,
        "cron:execution-starting",
        serde_json::json!({
            "taskId": task_id,
            "executionNumber": task.execution_count.saturating_add(1),
            "trigger": if trigger == TaskExecutionTrigger::Manual { "manual" } else { "scheduled" },
        }),
    )
    .await;
    let execution = match handle.as_ref() {
        Ok(handle) => {
            execute_task_with_reservation(handle, &task, queue_id, executions, reserved_session)
                .await
        }
        Err(error) => Err(error.clone()),
    };

    let (record, outcome) = match execution {
        Ok(outcome) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: outcome.success,
                duration_ms: outcome.duration_ms,
                content: outcome.output_text.clone(),
                error: outcome.error.clone(),
            },
            Some(outcome),
        ),
        Err(error) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: false,
                duration_ms: started.elapsed().as_millis() as u64,
                content: None,
                error: Some(error.clone()),
            },
            None,
        ),
    };

    if let Some(outcome) = outcome
        .as_ref()
        .filter(|outcome| outcome.termination_unconfirmed)
    {
        retain_unconfirmed_execution(
            executions,
            task_id,
            queue_id,
            outcome.error.clone().unwrap_or_else(|| {
                "Task turn termination was not confirmed; retry stop before rerunning".to_string()
            }),
        )
        .await;
        emit_execution_state_event(executions, app_handle, task_id).await;
    }
    // The outcome commit and every externally visible consequence share the
    // same per-Task control epoch as Stop/Rerun. If control won first, the
    // exact queue check below rejects this worker. If this worker won first,
    // Stop/Rerun waits until history, notifications, and any terminal status
    // transition all belong to this generation before creating the next one.
    let task_control = acquire_task_control(task_id).await;
    let active = executions.read().await;
    let authorized = active
        .get(task_id)
        .is_some_and(|execution| execution.queue_id == queue_id && !execution.canceled);
    if !authorized {
        return Ok(RunDisposition::Stop);
    }
    let updated = match store
        .record_execution_if_status(task_id, trigger, task.status)
        .await
    {
        Ok(Some(updated)) => updated,
        Ok(None) => return Ok(RunDisposition::Stop),
        Err(error) => {
            drop(active);
            if trigger == TaskExecutionTrigger::Scheduled {
                block_task_with_control_held(
                    &task,
                    format!("Task execution commit failed; scheduler stopped: {error}"),
                    &task_control,
                )
                .await;
            }
            return Err(format!("task execution commit failed: {error}"));
        }
    };
    drop(active);
    if let Err(error) = crate::cron_task::record_cron_run(task_id, &record).await {
        ulog_warn!(
            "[task-scheduler] run history write failed task={}: {}",
            task_id,
            error
        );
    }

    emit_cron_ui_event(
        app_handle,
        "cron:execution-complete",
        serde_json::json!({
            "taskId": task_id,
            "success": record.ok,
            "executionCount": updated.execution_count,
        }),
    )
    .await;
    if let Some(error) = record.error.as_deref() {
        emit_cron_ui_event(
            app_handle,
            "cron:execution-error",
            serde_json::json!({ "taskId": task_id, "error": error }),
        )
        .await;
    }

    if let (Ok(handle), Some(outcome)) = (handle.as_ref(), outcome.as_ref()) {
        crate::task_execution::deliver_task_result(handle, &task, outcome).await;
    }

    // A user may stop/delete the Task while the runtime turn is unwinding.
    // The committed status is authoritative; never let the late outcome
    // transition that terminal Task again.
    if updated.status != TaskStatus::Running {
        return Ok(RunDisposition::Stop);
    }

    if trigger == TaskExecutionTrigger::Manual {
        // Run-now is an observational execution of the existing schedule.
        // Its AI exit/end-condition result must not terminalize a recurring
        // Task or change whether the scheduler remains armed.
        return Ok(RunDisposition::Continue);
    }

    let provider_failure = record.error.as_deref().is_some_and(|error| {
        error.starts_with("Provider '")
            && (error.contains("not found in config") || error.contains("has no API Key"))
    });
    if provider_failure || outcome.is_none() {
        block_task_with_control_held(
            &updated,
            record
                .error
                .clone()
                .unwrap_or_else(|| "Task execution failed".to_string()),
            &task_control,
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    let outcome = outcome.expect("checked above");
    if !outcome.success
        && matches!(
            updated.execution_mode,
            TaskExecutionMode::Once | TaskExecutionMode::Scheduled
        )
    {
        block_task_with_control_held(
            &updated,
            outcome
                .error
                .clone()
                .unwrap_or_else(|| "Task execution failed".to_string()),
            &task_control,
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    if let Some(reason) = outcome.ai_exit_reason {
        finish_task_with_control_held(
            &updated,
            &reason,
            TransitionSource::EndCondition,
            &task_control,
        )
        .await;
        return Ok(RunDisposition::Stop);
    }
    if matches!(
        updated.execution_mode,
        TaskExecutionMode::Once | TaskExecutionMode::Scheduled
    ) || end_condition_reached(&updated)
    {
        finish_task_with_control_held(
            &updated,
            "Task execution completed",
            TransitionSource::EndCondition,
            &task_control,
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    Ok(RunDisposition::Continue)
}

async fn emit_cron_ui_event(
    app_handle: &RwLock<Option<AppHandle>>,
    event: &str,
    payload: serde_json::Value,
) {
    if let Some(handle) = app_handle.read().await.as_ref() {
        let _ = handle.emit(event, payload);
    }
}

async fn finish_task(task: &Task, message: &str, source: TransitionSource) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Done,
            message: Some(message.to_string()),
            actor: TransitionActor::System,
            source: Some(source),
        })
        .await;
}

async fn finish_task_with_control_held(
    task: &Task,
    message: &str,
    source: TransitionSource,
    task_control: &TaskControlGuard,
) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status_with_task_control_held(
            TaskUpdateStatusInput {
                id: task.id.clone(),
                status: TaskStatus::Done,
                message: Some(message.to_string()),
                actor: TransitionActor::System,
                source: Some(source),
            },
            task_control,
        )
        .await;
}

async fn block_task(task: &Task, message: String) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Blocked,
            message: Some(message),
            actor: TransitionActor::System,
            source: Some(TransitionSource::Scheduler),
        })
        .await;
}

async fn block_task_with_control_held(
    task: &Task,
    message: String,
    task_control: &TaskControlGuard,
) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status_with_task_control_held(
            TaskUpdateStatusInput {
                id: task.id.clone(),
                status: TaskStatus::Blocked,
                message: Some(message),
                actor: TransitionActor::System,
                source: Some(TransitionSource::Scheduler),
            },
            task_control,
        )
        .await;
}

fn end_condition_reached(task: &Task) -> bool {
    let Some(conditions) = task.end_conditions.as_ref() else {
        return false;
    };
    conditions
        .deadline
        .is_some_and(|deadline| Utc::now().timestamp_millis() >= deadline)
        || conditions
            .max_executions
            .is_some_and(|max| task.execution_count >= max)
}

pub fn validate_task_schedule(task: &Task) -> Result<(), String> {
    match task.execution_mode {
        TaskExecutionMode::Once => Ok(()),
        TaskExecutionMode::Scheduled if task.dispatch_at.is_none() => {
            Err("Scheduled task requires dispatchAt".to_string())
        }
        TaskExecutionMode::Scheduled => Ok(()),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task.cron_expression.as_deref() {
                crate::cron_task::validate_cron_expression(
                    expression,
                    task.cron_timezone.as_deref(),
                )?;
            }
            Ok(())
        }
        TaskExecutionMode::Loop => Err("Legacy Loop tasks are retired".to_string()),
    }
}

pub fn next_execution_at(task: &Task) -> Result<Option<DateTime<Utc>>, String> {
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(None);
    }
    validate_task_schedule(task)?;
    let now = Utc::now();
    let clamp = |candidate: DateTime<Utc>, seconds: i64| {
        let minimum = now + chrono::Duration::seconds(seconds);
        if candidate > minimum {
            candidate
        } else {
            minimum
        }
    };

    match task.execution_mode {
        TaskExecutionMode::Once => Ok(Some(now + chrono::Duration::seconds(2))),
        TaskExecutionMode::Scheduled => Ok(task
            .dispatch_at
            .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
            .map(|target| clamp(target, 2))),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task
                .cron_expression
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return crate::cron_task::validation::next_cron_fire_time(
                    expression,
                    task.cron_timezone.as_deref(),
                )
                .map(Some);
            }

            let interval_secs = task.interval_minutes.unwrap_or(60).max(5) as i64 * 60;
            let catch_up = task.recurring_window.as_ref();
            if task.last_scheduled_at.is_none() {
                if let Some(start_at) = task.start_at.as_deref() {
                    let target = DateTime::parse_from_rfc3339(start_at)
                        .map_err(|error| format!("invalid startAt: {error}"))?
                        .with_timezone(&Utc);
                    return Ok(Some(
                        crate::cron_task::schedule::resolve_missed_interval_target(
                            target,
                            interval_secs,
                            now,
                            catch_up,
                            2,
                        ),
                    ));
                }
                return Ok(Some(now + chrono::Duration::seconds(2)));
            }
            let base = task
                .last_scheduled_at
                .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
                .unwrap_or(now);
            Ok(Some(
                crate::cron_task::schedule::resolve_missed_interval_target(
                    base + chrono::Duration::seconds(interval_secs),
                    interval_secs,
                    now,
                    catch_up,
                    5,
                ),
            ))
        }
        TaskExecutionMode::Loop => Ok(None),
    }
}

async fn sleep_until_wallclock(target: DateTime<Utc>) {
    loop {
        let now = Utc::now();
        if now >= target {
            return;
        }
        let seconds = (target - now).num_seconds().clamp(1, 30) as u64;
        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
    }
}

static TASK_SCHEDULER: std::sync::OnceLock<TaskSchedulerController> = std::sync::OnceLock::new();

pub fn get_task_scheduler() -> &'static TaskSchedulerController {
    TASK_SCHEDULER.get_or_init(TaskSchedulerController::new)
}

pub async fn has_persistent_task_for_session(session_id: &str) -> bool {
    if active_execution_protects_session(&get_task_scheduler().executions, session_id).await {
        return true;
    }
    let Some(store) = crate::task::get_task_store() else {
        return false;
    };
    store
        .list(TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .any(|task| task_protects_session_identity(&task, session_id))
}

async fn active_execution_protects_session(
    executions: &ActiveExecutions,
    session_id: &str,
) -> bool {
    executions
        .read()
        .await
        .values()
        .any(|execution| execution.session_id.as_deref() == Some(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_task(task: &Task) -> (tempfile::TempDir, crate::task::TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("tasks.jsonl"),
            format!("{}\n", serde_json::to_string(task).unwrap()),
        )
        .unwrap();
        let store = crate::task::TaskStore::new(data_dir);
        (dir, store)
    }

    #[tokio::test]
    async fn stop_fences_a_claimed_execution_before_runtime_dispatch() {
        let controller = TaskSchedulerController::new();
        let queue_id = claim_execution(&controller.executions, "task-1")
            .await
            .expect("claim execution");

        assert!(controller.authorize_dispatch("task-1", &queue_id).await);
        controller.cancel_execution("task-1").await;
        assert!(!controller.authorize_dispatch("task-1", &queue_id).await);

        release_execution(&controller.executions, "task-1", &queue_id).await;
        assert!(!controller.is_executing("task-1").await);
    }

    #[tokio::test]
    async fn stale_execution_generation_cannot_authorize_after_rerun_claims() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let first_queue = claim_execution(&executions, "task-rerun").await.unwrap();
        release_execution(&executions, "task-rerun", &first_queue).await;
        let second_queue = claim_execution(&executions, "task-rerun").await.unwrap();

        assert_ne!(first_queue, second_queue);
        assert!(!execution_is_authorized(&executions, "task-rerun", &first_queue).await);
        assert!(execution_is_authorized(&executions, "task-rerun", &second_queue).await);

        release_execution(&executions, "task-rerun", &second_queue).await;
    }

    #[tokio::test]
    async fn managed_batch_session_binding_requires_the_exact_live_claim() {
        let controller = TaskSchedulerController::new();
        let queue_id = claim_execution(&controller.executions, "managed-task")
            .await
            .unwrap();

        assert!(
            controller
                .bind_execution_session("managed-task", &queue_id, "session-a")
                .await
        );
        assert_eq!(
            controller
                .executions
                .read()
                .await
                .get("managed-task")
                .and_then(|execution| execution.session_id.as_deref()),
            Some("session-a")
        );
        assert!(
            !controller
                .bind_execution_session("managed-task", "stale-queue", "session-b")
                .await
        );
        controller.cancel_execution("managed-task").await;
        assert!(
            !controller
                .bind_execution_session("managed-task", &queue_id, "session-b")
                .await
        );

        release_execution(&controller.executions, "managed-task", &queue_id).await;
    }

    #[tokio::test]
    async fn task_control_serializes_only_the_same_task() {
        let first_task = format!("task-control-first-{}", uuid::Uuid::new_v4());
        let other_task = format!("task-control-other-{}", uuid::Uuid::new_v4());
        let guard = acquire_task_control(&first_task).await;

        assert!(try_acquire_task_control(&first_task).await.is_none());
        assert!(try_acquire_task_control(&other_task).await.is_some());

        drop(guard);
        assert!(try_acquire_task_control(&first_task).await.is_some());
    }

    #[tokio::test]
    async fn run_now_reservation_returns_the_session_bound_and_persisted_for_this_run() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-run-now",
            "name": "run now",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "sessionIds": ["previous-run"],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("task-run-now").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let returned_session =
            reserve_claimed_execution_session(&executions, &store, &task, &queue_id)
                .await
                .unwrap()
                .expect("ordinary Task execution must reserve a Session");

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert_ne!(returned_session.session_id, "previous-run");
        assert_eq!(
            bound_session.as_deref(),
            Some(returned_session.session_id.as_str())
        );
        assert_eq!(
            persisted.session_ids.last().map(String::as_str),
            Some(returned_session.session_id.as_str())
        );

        drop(returned_session);
        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn metadata_birth_releases_lifecycle_while_execution_remains_active() {
        let session_id = format!("shared-session-{}", uuid::Uuid::new_v4());
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-shared-session",
            "name": "shared session",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": session_id.clone(),
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get(&task.id).await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();
        let reservation = reserve_claimed_execution_session(&executions, &store, &task, &queue_id)
            .await
            .unwrap()
            .expect("ordinary Task execution must reserve a Session");
        assert_ne!(reservation.session_id, session_id);
        assert!(reservation.initialize_session);
        let rebound = store.get(&task.id).await.unwrap();
        assert_eq!(
            rebound.preselected_session_id.as_deref(),
            Some(reservation.session_id.as_str())
        );
        assert!(!rebound.session_ids.iter().any(|value| value == &session_id));
        assert!(rebound
            .session_ids
            .iter()
            .any(|value| value == &reservation.session_id));

        let (acquired_tx, mut acquired_rx) = tokio::sync::mpsc::unbounded_channel();
        let session_for_waiter = reservation.session_id.clone();
        let waiter = tauri::async_runtime::spawn(async move {
            let _guard = crate::sidecar::acquire_session_lifecycle(&[&session_for_waiter]).await;
            let _ = acquired_tx.send(());
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "a Starting joiner must remain behind the creator's metadata-birth boundary"
        );

        let reservation_session_id = reservation.session_id.clone();
        let dispatch_lifecycle = Arc::clone(&reservation.birth_lifecycle);
        drop(reservation);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "dispatch must share the reservation's existing lifecycle acquisition"
        );
        drop(dispatch_lifecycle);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "dropping the worker-side leases must not release exact-generation birth authority"
        );
        assert!(
            clear_pending_session_birth(&executions, &task.id, &queue_id, &reservation_session_id)
                .await,
            "metadata birth must clear only the exact generation's long-lived lease"
        );
        assert!(
            executions.read().await.contains_key(&task.id),
            "the AI turn remains active after Session metadata is born"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), acquired_rx.recv())
            .await
            .expect("joiner should acquire after metadata birth, before the AI turn completes")
            .expect("joiner should report its acquisition");
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("joiner should resume after metadata birth")
            .expect("joiner task should not panic");
        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn abandoned_worker_keeps_birth_lifecycle_until_metadata_observer_clears_it() {
        let task_id = "task-abandoned-birth";
        let session_id = format!("abandoned-birth-{}", uuid::Uuid::new_v4());
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, task_id).await.unwrap();
        let lifecycle = Arc::new(crate::sidecar::acquire_session_lifecycle(&[&session_id]).await);
        {
            let mut active = executions.write().await;
            let execution = active.get_mut(task_id).unwrap();
            execution.session_id = Some(session_id.clone());
            execution.pending_session_birth = Some(PendingSessionBirth {
                session_id: session_id.clone(),
                _lifecycle: Arc::clone(&lifecycle),
            });
        }
        drop(lifecycle);
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            Arc::new(RwLock::new(None)),
            task_id.to_string(),
            queue_id.clone(),
        );
        drop(claim);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if executions
                    .read()
                    .await
                    .get(task_id)
                    .is_some_and(|execution| execution.state == TaskExecutionState::StopFailed)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned worker should become a visible StopFailed generation");

        let (acquired_tx, mut acquired_rx) = tokio::sync::mpsc::unbounded_channel();
        let session_for_waiter = session_id.clone();
        let waiter = tauri::async_runtime::spawn(async move {
            let _guard = crate::sidecar::acquire_session_lifecycle(&[&session_for_waiter]).await;
            let _ = acquired_tx.send(());
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(75), acquired_rx.recv())
                .await
                .is_err(),
            "worker loss must not release exact-generation birth authority"
        );

        assert!(clear_pending_session_birth(&executions, task_id, &queue_id, &session_id).await);
        tokio::time::timeout(std::time::Duration::from_secs(2), acquired_rx.recv())
            .await
            .expect("metadata birth should release the exact generation's lease")
            .expect("next creator should report its acquisition");
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("next creator should finish after metadata birth")
            .expect("next creator should not panic");
        release_execution(&executions, task_id, &queue_id).await;
    }

    #[tokio::test]
    async fn managed_batch_reservation_does_not_bind_or_persist_a_session() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "managed-batch",
            "name": "memory batch",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "managedKind": "memory_auto_update_batch",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("managed-batch").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let reserved = reserve_claimed_execution_session(&executions, &store, &task, &queue_id)
            .await
            .unwrap();

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert!(reserved.is_none());
        assert_eq!(bound_session, None);
        assert!(persisted.session_ids.is_empty());

        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn active_execution_protects_its_reserved_session_until_release() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        executions.write().await.insert(
            "task-1".to_string(),
            ActiveTaskExecution {
                queue_id: "queue-1".to_string(),
                canceled: false,
                session_id: Some("session-1".to_string()),
                pending_session_birth: None,
                state: TaskExecutionState::Running,
                error: None,
            },
        );

        assert!(active_execution_protects_session(&executions, "session-1").await);
        release_execution(&executions, "task-1", "queue-1").await;
        assert!(!active_execution_protects_session(&executions, "session-1").await);
    }

    #[tokio::test]
    async fn abandoned_worker_claim_becomes_visible_stop_failure() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-abandoned")
            .await
            .unwrap();
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-abandoned".to_string(),
            queue_id,
        );

        drop(claim);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let state = executions
                    .read()
                    .await
                    .get("task-abandoned")
                    .map(|execution| execution.state);
                if state == Some(TaskExecutionState::StopFailed) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Drop cleanup should surface an unsettled worker");
    }

    #[tokio::test]
    async fn worker_settlement_does_not_clear_an_unconfirmed_stop() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-stop-failed")
            .await
            .unwrap();
        {
            let mut active = executions.write().await;
            let execution = active.get_mut("task-stop-failed").unwrap();
            execution.canceled = true;
            execution.state = TaskExecutionState::StopFailed;
            execution.error = Some("stop not confirmed".to_string());
        }
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-stop-failed".to_string(),
            queue_id.clone(),
        );

        claim.settle().await;

        let active = executions.read().await;
        let execution = active.get("task-stop-failed").unwrap();
        assert_eq!(execution.queue_id, queue_id);
        assert_eq!(execution.state, TaskExecutionState::StopFailed);
    }

    #[tokio::test]
    async fn runtime_termination_ambiguity_keeps_the_exact_execution_retryable() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-orphan").await.unwrap();
        retain_unconfirmed_execution(
            &executions,
            "task-orphan",
            &queue_id,
            "runtime process may still be alive".to_string(),
        )
        .await;
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-orphan".to_string(),
            queue_id.clone(),
        );

        claim.settle().await;

        let active = executions.read().await;
        let execution = active.get("task-orphan").unwrap();
        assert_eq!(execution.queue_id, queue_id);
        assert!(execution.canceled);
        assert_eq!(execution.state, TaskExecutionState::StopFailed);
        assert_eq!(
            execution.error.as_deref(),
            Some("runtime process may still be alive")
        );
    }

    #[test]
    fn attached_task_protects_its_session_until_terminal_completion() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "attached-task",
            "name": "Space issue",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "once",
            "sessionIds": ["session-1"],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "attached-session"
        }))
        .unwrap();

        for status in [
            TaskStatus::Todo,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::Blocked,
            TaskStatus::Stopped,
        ] {
            task.status = status;
            assert!(task_protects_session_identity(&task, "session-1"));
        }
        for status in [TaskStatus::Done, TaskStatus::Archived, TaskStatus::Deleted] {
            task.status = status;
            assert!(!task_protects_session_identity(&task, "session-1"));
        }
        task.status = TaskStatus::Running;
        task.deleted = true;
        assert!(!task_protects_session_identity(&task, "session-1"));
    }

    #[test]
    fn only_running_direct_single_session_tasks_protect_idle_identity() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "direct-task",
            "name": "Direct",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": "session-1",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        assert!(task_protects_session_identity(&task, "session-1"));
        task.status = TaskStatus::Stopped;
        assert!(!task_protects_session_identity(&task, "session-1"));
        task.status = TaskStatus::Running;
        task.run_mode = Some(crate::task::TaskRunMode::NewSession);
        assert!(!task_protects_session_identity(&task, "session-1"));
    }

    #[test]
    fn loop_is_not_a_valid_task_schedule() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "loop",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        task.execution_mode = TaskExecutionMode::Loop;
        assert!(validate_task_schedule(&task).is_err());
    }

    #[test]
    fn recurring_start_at_is_the_first_trigger_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-start-at",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .expect("task json");

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn manual_history_does_not_skip_the_first_scheduled_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-manual-first",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": 2,
            "executionCount": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn recurring_schedule_uses_the_last_timer_run_not_run_now() {
        let now = Utc::now();
        let scheduled = now - chrono::Duration::minutes(10);
        let manual = now - chrono::Duration::minutes(1);
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-anchor",
            "name": "anchored",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": manual.timestamp_millis(),
            "lastScheduledAt": scheduled.timestamp_millis(),
            "executionCount": 2,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        let next = next_execution_at(&task).unwrap().unwrap();
        let expected = scheduled + chrono::Duration::minutes(60);
        assert!((next - expected).num_seconds().abs() <= 1);
    }

    #[test]
    fn rerun_one_shot_is_not_gated_by_cumulative_execution_count() {
        for (mode, dispatch_at) in [
            (TaskExecutionMode::Once, None),
            (
                TaskExecutionMode::Scheduled,
                Some(Utc::now().timestamp_millis() - 1_000),
            ),
        ] {
            let mut task: Task = serde_json::from_value(serde_json::json!({
                "id": "task-rerun",
                "name": "rerun",
                "executor": "agent",
                "workspaceId": "ws",
                "workspacePath": "/tmp/ws",
                "executionMode": "once",
                "sessionIds": [],
                "executionCount": 3,
                "status": "running",
                "tags": [],
                "createdAt": 1,
                "updatedAt": 1,
                "statusHistory": [],
                "dispatchOrigin": "direct"
            }))
            .unwrap();
            task.execution_mode = mode;
            task.dispatch_at = dispatch_at;
            assert!(next_execution_at(&task).unwrap().is_some());
        }
    }
}
