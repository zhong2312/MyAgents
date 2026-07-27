use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use crate::config_io::with_config_lock;
use crate::cron_task::normalize_path;
use crate::im::types::{HeartbeatConfig, MemoryAutoUpdateConfig};
use crate::sidecar::{self, ManagedSidecarManager, SidecarOwner};
use crate::utils::bom::strip_bom;
use crate::utils::system_reminder::{leading_system_reminder_kind, strip_leading_system_reminder};
use crate::{ulog_info, ulog_warn};
use chrono::{DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;

pub const SCAN_CADENCE_MINUTES: u32 = 30;
const IDLE_COOLDOWN_MINUTES: i64 = 30;
const ACTIVE_SESSION_LOOKBACK_DAYS: i64 = 7;
const MEMORY_UPDATE_HTTP_TIMEOUT_SECS: u64 = 61 * 60;
const MANAGED_AUTO_UPDATE_NAME: &str = "Memory Auto-Update";
const MANAGED_AUTO_UPDATE_PROMPT: &str =
    "System-managed memory auto-update dispatcher. This Task is hidden from ordinary UI.";

static IN_FLIGHT_WORKSPACES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static CONFIGURE_LIFECYCLES: LazyLock<crate::keyed_lifecycle::KeyedLifecycleRegistry> =
    LazyLock::new(crate::keyed_lifecycle::KeyedLifecycleRegistry::new);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryAutoUpdateTaskResult {
    pub enabled: bool,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryAutoUpdateTaskRequest {
    pub agent_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAutoUpdateBatchSummary {
    pub checked_sessions: u32,
    pub eligible_sessions: u32,
    pub updated: u32,
    pub skipped_recent_input: u32,
    pub skipped_busy: u32,
    pub skipped_inactive: u32,
    pub skipped_no_threshold: u32,
    pub skipped_min_interval: u32,
    pub skipped_duplicate: u32,
    pub failed: u32,
    pub completed_at: String,
    #[serde(skip)]
    pub termination_unconfirmed: bool,
}

pub struct ManagedMemoryAutoUpdateOutcome {
    pub success: bool,
    pub termination_unconfirmed: bool,
    pub output_text: String,
}

#[derive(Debug)]
struct DiskMemoryAutoUpdateAgent {
    request: ConfigureMemoryAutoUpdateTaskRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    #[serde(default)]
    agent_dir: Option<String>,
    #[serde(default)]
    last_active_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageLine {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, alias = "created_at")]
    created_at: Option<String>,
    #[serde(default)]
    attachments: Option<Value>,
}

#[derive(Debug, Default)]
struct SessionJsonlAnalysis {
    query_count: u32,
    last_human_user_at: Option<DateTime<Utc>>,
    last_memory_update_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
struct SessionCandidate {
    id: String,
}

#[derive(Debug)]
enum SessionUpdateOutcome {
    Updated,
    Busy,
    Canceled,
    TerminationUnconfirmed(String),
    Failed(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUpdateResponse {
    status: String,
    reason: Option<String>,
    #[serde(default)]
    termination_unconfirmed: bool,
}

#[derive(Debug)]
enum MemoryUpdateSidecarTarget {
    Ready(u16),
    BoundButNotReady,
    Missing,
}

struct MemoryUpdateSidecarOwnerGuard {
    manager: ManagedSidecarManager,
    session_id: String,
    owner: SidecarOwner,
    release_on_drop: bool,
}

impl MemoryUpdateSidecarOwnerGuard {
    fn retain_for_task_stop(&mut self) {
        self.release_on_drop = false;
    }

    fn confirm_turn_settled(&mut self) {
        self.release_on_drop = true;
    }
}

impl Drop for MemoryUpdateSidecarOwnerGuard {
    fn drop(&mut self) {
        if !self.release_on_drop {
            return;
        }
        if let Err(error) =
            sidecar::release_session_sidecar(&self.manager, &self.session_id, &self.owner)
        {
            ulog_warn!(
                "[memory-auto-update] failed to release Sidecar owner session={}: {}",
                self.session_id,
                error
            );
        }
    }
}

struct WorkspaceInflightGuard {
    key: String,
}

impl WorkspaceInflightGuard {
    async fn acquire(workspace_path: &str) -> Option<Self> {
        let key = normalize_path(workspace_path);
        let mut guard = IN_FLIGHT_WORKSPACES.lock().await;
        if guard.contains(&key) {
            return None;
        }
        guard.insert(key.clone());
        Some(Self { key })
    }

    async fn release(self) {
        let mut guard = IN_FLIGHT_WORKSPACES.lock().await;
        guard.remove(&self.key);
    }
}

fn authoritative_configure_request(
    requested: ConfigureMemoryAutoUpdateTaskRequest,
    disk_agents: Vec<DiskMemoryAutoUpdateAgent>,
) -> ConfigureMemoryAutoUpdateTaskRequest {
    let workspace_identity = normalize_path(&requested.workspace_path);
    disk_agents
        .into_iter()
        .find(|agent| normalize_path(&agent.request.workspace_path) == workspace_identity)
        .map(|agent| agent.request)
        .unwrap_or(ConfigureMemoryAutoUpdateTaskRequest {
            agent_id: requested.agent_id,
            workspace_path: requested.workspace_path,
            memory_auto_update: None,
            heartbeat: None,
        })
}

async fn load_authoritative_configure_request(
    requested: ConfigureMemoryAutoUpdateTaskRequest,
) -> Result<ConfigureMemoryAutoUpdateTaskRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_disk_memory_auto_update_agents()
            .map(|agents| authoritative_configure_request(requested, agents))
    })
    .await
    .map_err(|error| format!("memory auto-update config read task failed: {error}"))?
}

#[tauri::command]
pub async fn cmd_configure_memory_auto_update_task(
    request: ConfigureMemoryAutoUpdateTaskRequest,
) -> Result<ConfigureMemoryAutoUpdateTaskResult, String> {
    configure_memory_auto_update_task(request).await
}

pub async fn configure_memory_auto_update_task(
    request: ConfigureMemoryAutoUpdateTaskRequest,
) -> Result<ConfigureMemoryAutoUpdateTaskResult, String> {
    // The hidden Task is unique per workspace, so creation, drift repair, and
    // disable must share one transaction boundary. Per-Task control cannot
    // serialize the initial create because no Task id exists yet.
    let workspace_identity = normalize_path(&request.workspace_path);
    let _configure_lifecycle = CONFIGURE_LIFECYCLES.acquire(&[&workspace_identity]).await;
    let request = load_authoritative_configure_request(request).await?;
    let store =
        crate::task::get_task_store().ok_or_else(|| "task store not initialized".to_string())?;
    let mut existing = find_managed_tasks_for_workspace(&request.workspace_path).await;
    existing.sort_by_key(|task| task.created_at);
    let keep = existing.first().cloned();

    for duplicate in existing.iter().skip(1) {
        ulog_warn!(
            "[memory-auto-update] deleting duplicate managed Task {} for workspace {}",
            duplicate.id,
            request.workspace_path
        );
        stop_managed_task(store, duplicate, "duplicate managed Task cleanup")
            .await
            .map_err(|error| {
                format!(
                    "failed to stop duplicate managed Task {}: {}",
                    duplicate.id, error
                )
            })?;
        store.delete(&duplicate.id).await.map_err(|error| {
            format!(
                "failed to delete duplicate managed Task {}: {}",
                duplicate.id, error
            )
        })?;
    }

    let Some(mut config) = request
        .memory_auto_update
        .clone()
        .filter(|config| config.enabled)
    else {
        if let Some(task) = keep {
            stop_managed_task(store, &task, "memory auto-update disabled").await?;
            return Ok(ConfigureMemoryAutoUpdateTaskResult {
                enabled: false,
                task_id: Some(task.id),
            });
        }
        return Ok(ConfigureMemoryAutoUpdateTaskResult {
            enabled: false,
            task_id: None,
        });
    };

    apply_heartbeat_timezone_fallback(&mut config, request.heartbeat.as_ref());
    let desired_window = recurring_window(&config);
    let task = if let Some(existing) = keep {
        let start_at = if existing.recurring_window.as_ref() == Some(&desired_window)
            && existing
                .start_at
                .as_deref()
                .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_ok())
        {
            existing.start_at.clone().unwrap_or_default()
        } else {
            next_scan_start_at(&config).to_rfc3339()
        };
        let drifted = existing.name != MANAGED_AUTO_UPDATE_NAME
            || existing.execution_mode != crate::task::TaskExecutionMode::Recurring
            || existing.run_mode != Some(crate::task::TaskRunMode::SingleSession)
            || existing.interval_minutes != Some(SCAN_CADENCE_MINUTES)
            || existing.cron_expression.is_some()
            || existing.start_at.as_deref() != Some(start_at.as_str())
            || existing.recurring_window.as_ref() != Some(&desired_window)
            || existing
                .notification
                .as_ref()
                .is_some_and(|value| value.desktop)
            || existing.managed_kind.as_deref()
                != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH);

        if drifted {
            stop_managed_task(
                store,
                &existing,
                "memory auto-update settings changed; re-arming",
            )
            .await?;
            store
                .update(crate::task::TaskUpdateInput {
                    id: existing.id,
                    name: Some(MANAGED_AUTO_UPDATE_NAME.to_string()),
                    executor: None,
                    description: Some("System-managed memory auto-update dispatcher.".to_string()),
                    execution_mode: Some(crate::task::TaskExecutionMode::Recurring),
                    run_mode: Some(crate::task::TaskRunMode::SingleSession),
                    end_conditions: Some(crate::task::TaskEndConditions::default()),
                    interval_minutes: Some(SCAN_CADENCE_MINUTES),
                    cron_expression: Some(String::new()),
                    cron_timezone: Some(String::new()),
                    start_at: Some(start_at),
                    recurring_window: Some(desired_window),
                    dispatch_at: None,
                    model: None,
                    provider_id: None,
                    clear_provider_override: true,
                    permission_mode: Some(String::new()),
                    preselected_session_id: Some(String::new()),
                    runtime: None,
                    runtime_config: None,
                    clear_runtime_override: true,
                    mcp_enabled_servers: None,
                    clear_mcp_override: true,
                    tags: Some(vec!["system".to_string(), "memory".to_string()]),
                    notification: Some(crate::task::NotificationConfig {
                        desktop: false,
                        bot_channel_id: None,
                        bot_thread: None,
                        events: Some(vec![]),
                    }),
                    prompt: Some(MANAGED_AUTO_UPDATE_PROMPT.to_string()),
                })
                .await?
        } else {
            existing
        }
    } else {
        store
            .create_system_managed_direct(crate::task::TaskCreateDirectInput {
                name: MANAGED_AUTO_UPDATE_NAME.to_string(),
                executor: crate::task::TaskExecutor::Agent,
                description: Some("System-managed memory auto-update dispatcher.".to_string()),
                workspace_id: request.agent_id.clone(),
                workspace_path: request.workspace_path.clone(),
                task_md_content: MANAGED_AUTO_UPDATE_PROMPT.to_string(),
                execution_mode: crate::task::TaskExecutionMode::Recurring,
                run_mode: Some(crate::task::TaskRunMode::SingleSession),
                end_conditions: Some(crate::task::TaskEndConditions::default()),
                interval_minutes: Some(SCAN_CADENCE_MINUTES),
                cron_expression: None,
                cron_timezone: None,
                start_at: Some(next_scan_start_at(&config).to_rfc3339()),
                recurring_window: Some(desired_window),
                dispatch_at: None,
                model: None,
                provider_id: None,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                mcp_enabled_servers: None,
                managed_kind: Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH.to_string()),
                source_thought_id: None,
                tags: vec!["system".to_string(), "memory".to_string()],
                notification: Some(crate::task::NotificationConfig {
                    desktop: false,
                    bot_channel_id: None,
                    bot_thread: None,
                    events: Some(vec![]),
                }),
            })
            .await?
    };

    arm_managed_task(store, task.clone()).await?;
    ulog_info!(
        "[memory-auto-update] armed managed Task {} for agent {} workspace {}",
        task.id,
        request.agent_id,
        request.workspace_path
    );
    Ok(ConfigureMemoryAutoUpdateTaskResult {
        enabled: true,
        task_id: Some(task.id),
    })
}

async fn arm_managed_task(
    store: &std::sync::Arc<crate::task::TaskStore>,
    task: crate::task::Task,
) -> Result<(), String> {
    let scheduler = crate::task_scheduler::get_task_scheduler();
    if let Some(execution) = scheduler.execution_projection(&task.id).await {
        if execution.state == crate::task_scheduler::TaskExecutionState::Running
            && task.status == crate::task::TaskStatus::Running
        {
            return Ok(());
        }
        if execution.state != crate::task_scheduler::TaskExecutionState::Running {
            scheduler.stop(&task.id).await?;
        }
    }
    if task.status == crate::task::TaskStatus::Running {
        return scheduler.start(&task.id).await;
    }
    if scheduler.is_executing(&task.id).await {
        scheduler.stop(&task.id).await?;
    }
    if task.status != crate::task::TaskStatus::Todo {
        store
            .update_status(crate::task::TaskUpdateStatusInput {
                id: task.id.clone(),
                status: crate::task::TaskStatus::Todo,
                message: Some("memory auto-update enabled".to_string()),
                actor: crate::task::TransitionActor::System,
                source: Some(crate::task::TransitionSource::Scheduler),
            })
            .await?;
    }
    crate::management_api::run_task_by_id(&task.id)
        .await
        .map(|_| ())
}

async fn stop_managed_task(
    store: &std::sync::Arc<crate::task::TaskStore>,
    task: &crate::task::Task,
    message: &str,
) -> Result<(), String> {
    if matches!(
        task.status,
        crate::task::TaskStatus::Running | crate::task::TaskStatus::Verifying
    ) {
        store
            .update_status(crate::task::TaskUpdateStatusInput {
                id: task.id.clone(),
                status: crate::task::TaskStatus::Stopped,
                message: Some(message.to_string()),
                actor: crate::task::TransitionActor::System,
                source: Some(crate::task::TransitionSource::Scheduler),
            })
            .await?;
    } else if crate::task_scheduler::get_task_scheduler()
        .is_executing(&task.id)
        .await
    {
        crate::task_scheduler::get_task_scheduler()
            .stop(&task.id)
            .await?;
    }
    Ok(())
}

pub async fn reconcile_memory_auto_update_tasks_from_disk() -> Result<(), String> {
    let agents = load_disk_memory_auto_update_agents()?;
    let mut enabled_workspaces = HashSet::new();

    for agent in agents {
        if agent
            .request
            .memory_auto_update
            .as_ref()
            .is_some_and(|config| config.enabled)
        {
            enabled_workspaces.insert(normalize_path(&agent.request.workspace_path));
        }
        if let Err(error) = configure_memory_auto_update_task(agent.request.clone()).await {
            ulog_warn!(
                "[memory-auto-update] startup reconcile failed for agent {} workspace {}: {}",
                agent.request.agent_id,
                agent.request.workspace_path,
                error
            );
        }
    }

    let Some(store) = crate::task::get_task_store() else {
        return Ok(());
    };
    let existing = store
        .list(crate::task::TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await;
    for task in existing {
        if task.managed_kind.as_deref() != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH)
            || enabled_workspaces.contains(&normalize_path(&task.workspace_path))
        {
            continue;
        }
        configure_memory_auto_update_task(ConfigureMemoryAutoUpdateTaskRequest {
            agent_id: task.workspace_id.clone(),
            workspace_path: task.workspace_path.clone(),
            memory_auto_update: None,
            heartbeat: None,
        })
        .await?;
    }
    Ok(())
}

async fn find_managed_tasks_for_workspace(workspace_path: &str) -> Vec<crate::task::Task> {
    let Some(store) = crate::task::get_task_store() else {
        return Vec::new();
    };
    store
        .list(crate::task::TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .filter(|task| {
            task.managed_kind.as_deref() == Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH)
                && normalize_path(&task.workspace_path) == normalize_path(workspace_path)
        })
        .collect()
}
pub async fn run_managed_task_batch(
    handle: &AppHandle,
    task: &crate::task::Task,
    queue_id: &str,
) -> Result<ManagedMemoryAutoUpdateOutcome, String> {
    let Some((agent_id, mut config, heartbeat)) =
        load_enabled_memory_auto_update_agent_for_workspace(&task.workspace_path)?
    else {
        let text = format!(
            "Memory auto-update hidden batch skipped for {}: memoryAutoUpdate is not explicitly enabled.",
            task.workspace_path
        );
        return Ok(ManagedMemoryAutoUpdateOutcome {
            success: true,
            termination_unconfirmed: false,
            output_text: text,
        });
    };
    apply_heartbeat_timezone_fallback(&mut config, heartbeat.as_ref());

    if !is_in_update_window(&config) {
        let text = format!(
            "Memory auto-update hidden batch skipped for {}: outside update window {}-{}.",
            task.workspace_path, config.update_window_start, config.update_window_end
        );
        return Ok(ManagedMemoryAutoUpdateOutcome {
            success: true,
            termination_unconfirmed: false,
            output_text: text,
        });
    }

    let sidecar_state = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;
    let summary = run_batch(
        handle,
        &agent_id,
        &task.workspace_path,
        &config,
        &sidecar_state,
        &task.id,
        queue_id,
    )
    .await;
    let ok = summary.failed == 0;
    Ok(ManagedMemoryAutoUpdateOutcome {
        success: ok,
        termination_unconfirmed: summary.termination_unconfirmed,
        output_text: format_batch_summary(&summary),
    })
}

pub async fn run_batch<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    workspace_path: &str,
    config: &MemoryAutoUpdateConfig,
    sidecar_manager: &ManagedSidecarManager,
    task_id: &str,
    queue_id: &str,
) -> MemoryAutoUpdateBatchSummary {
    let mut summary = MemoryAutoUpdateBatchSummary {
        completed_at: Utc::now().to_rfc3339(),
        ..Default::default()
    };

    let Some(inflight) = WorkspaceInflightGuard::acquire(workspace_path).await else {
        summary.skipped_duplicate = 1;
        return summary;
    };

    let scheduler = crate::task_scheduler::get_task_scheduler();
    if !scheduler.authorize_dispatch(task_id, queue_id).await {
        inflight.release().await;
        return summary;
    }

    if let Err(error) = prepare_update_memory_file(workspace_path) {
        ulog_warn!(
            "[memory-auto-update] failed to prepare UPDATE_MEMORY.md for {}: {}",
            workspace_path,
            error
        );
        summary.failed = 1;
        inflight.release().await;
        return summary;
    }

    let candidates = collect_candidates(workspace_path, config, &mut summary);
    summary.eligible_sessions = candidates.len() as u32;

    let http_client =
        crate::local_http::json_client(Duration::from_secs(MEMORY_UPDATE_HTTP_TIMEOUT_SECS));
    for candidate in candidates {
        // Session deletion takes this same lifecycle before consulting live
        // Task execution ownership. Recheck metadata under the fence, then
        // publish the exact execution binding before releasing it: deletion
        // either wins first (and this stale candidate is skipped) or observes
        // the live batch and cannot remove the Session mid-update.
        let session_lifecycle = crate::sidecar::acquire_session_lifecycle(&[&candidate.id]).await;
        if crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(&candidate.id)
            .is_none()
        {
            drop(session_lifecycle);
            continue;
        }
        if !scheduler
            .bind_execution_session(task_id, queue_id, &candidate.id)
            .await
        {
            drop(session_lifecycle);
            break;
        }
        drop(session_lifecycle);
        match update_single_session(
            &candidate.id,
            workspace_path,
            sidecar_manager,
            app_handle,
            &http_client,
            task_id,
            queue_id,
        )
        .await
        {
            SessionUpdateOutcome::Updated => {
                summary.updated += 1;
                ulog_info!(
                    "[memory-auto-update] session {} updated successfully",
                    candidate.id
                );
            }
            SessionUpdateOutcome::Busy => {
                summary.skipped_busy += 1;
                ulog_info!(
                    "[memory-auto-update] session {} busy; will retry on next scan",
                    candidate.id
                );
            }
            SessionUpdateOutcome::Canceled => break,
            SessionUpdateOutcome::TerminationUnconfirmed(error) => {
                summary.failed += 1;
                summary.termination_unconfirmed = true;
                ulog_warn!(
                    "[memory-auto-update] session {} termination unconfirmed: {}",
                    candidate.id,
                    error
                );
                break;
            }
            SessionUpdateOutcome::Failed(error) => {
                summary.failed += 1;
                ulog_warn!(
                    "[memory-auto-update] session {} update failed: {}",
                    candidate.id,
                    error
                );
            }
        }
    }

    if summary.updated > 0 {
        update_successful_completion(app_handle, agent_id, summary.updated).await;
    }

    summary.completed_at = Utc::now().to_rfc3339();
    inflight.release().await;
    summary
}

pub fn format_batch_summary(summary: &MemoryAutoUpdateBatchSummary) -> String {
    format!(
        "Memory auto-update batch completed at {}. checked={}, eligible={}, updated={}, skippedRecentInput={}, skippedBusy={}, skippedInactive={}, skippedNoThreshold={}, skippedMinInterval={}, skippedDuplicate={}, failed={}",
        summary.completed_at,
        summary.checked_sessions,
        summary.eligible_sessions,
        summary.updated,
        summary.skipped_recent_input,
        summary.skipped_busy,
        summary.skipped_inactive,
        summary.skipped_no_threshold,
        summary.skipped_min_interval,
        summary.skipped_duplicate,
        summary.failed
    )
}

fn recurring_window(config: &MemoryAutoUpdateConfig) -> crate::cron_task::RecurringWindow {
    crate::cron_task::RecurringWindow {
        timezone: config
            .update_window_timezone
            .clone()
            .unwrap_or_else(|| "Asia/Shanghai".to_string()),
        start: config.update_window_start.clone(),
        end: config.update_window_end.clone(),
    }
}

fn next_scan_start_at(config: &MemoryAutoUpdateConfig) -> DateTime<Utc> {
    let tz_name = config
        .update_window_timezone
        .as_deref()
        .unwrap_or("Asia/Shanghai");
    let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() else {
        return Utc::now() + chrono::Duration::seconds(10);
    };
    let now_local = Utc::now().with_timezone(&tz);
    if is_local_time_in_window(now_local.hour() * 60 + now_local.minute(), config) {
        return Utc::now() + chrono::Duration::seconds(10);
    }

    let start = parse_hhmm(&config.update_window_start).unwrap_or(0);
    let today_start = now_local
        .date_naive()
        .and_hms_opt(start / 60, start % 60, 0)
        .and_then(|naive| naive.and_local_timezone(tz).single())
        .unwrap_or(now_local + chrono::Duration::minutes(1));
    let next = if today_start > now_local {
        today_start
    } else {
        today_start + chrono::Duration::days(1)
    };
    next.with_timezone(&Utc)
}

fn apply_heartbeat_timezone_fallback(
    config: &mut MemoryAutoUpdateConfig,
    heartbeat: Option<&HeartbeatConfig>,
) {
    if config.update_window_timezone.is_none() {
        config.update_window_timezone = heartbeat
            .and_then(|h| h.active_hours.as_ref())
            .map(|hours| hours.timezone.clone());
    }
}

fn load_disk_memory_auto_update_agents() -> Result<Vec<DiskMemoryAutoUpdateAgent>, String> {
    let Some(data_dir) = crate::app_dirs::myagents_data_dir() else {
        return Ok(Vec::new());
    };
    let config_path = data_dir.join("config.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read config.json: {}", error)),
    };
    let config: Value =
        serde_json::from_str(strip_bom(&content)).map_err(|e| format!("parse config: {}", e))?;
    Ok(collect_disk_memory_auto_update_agents(&config))
}

fn collect_disk_memory_auto_update_agents(config: &Value) -> Vec<DiskMemoryAutoUpdateAgent> {
    let Some(agents) = config.get("agents").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for agent in agents {
        let Some(agent_id) = agent.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(workspace_path) = agent.get("workspacePath").and_then(Value::as_str) else {
            continue;
        };
        let Some(mau_value) = agent.get("memoryAutoUpdate") else {
            continue;
        };
        let memory_auto_update = match serde_json::from_value::<MemoryAutoUpdateConfig>(
            mau_value.clone(),
        ) {
            Ok(config) => Some(config),
            Err(error) => {
                ulog_warn!(
                    "[memory-auto-update] skipping startup reconcile for agent {}: invalid memoryAutoUpdate config: {}",
                    agent_id,
                    error
                );
                continue;
            }
        };
        let heartbeat = agent
            .get("heartbeat")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());

        result.push(DiskMemoryAutoUpdateAgent {
            request: ConfigureMemoryAutoUpdateTaskRequest {
                agent_id: agent_id.to_string(),
                workspace_path: workspace_path.to_string(),
                memory_auto_update,
                heartbeat,
            },
        });
    }
    result
}

fn prepare_update_memory_file(workspace_path: &str) -> Result<(), String> {
    crate::workspace_files::memory_rules::ensure_update_memory_file_for_workspace(workspace_path)
        .map(|_| ())
}

fn collect_candidates(
    workspace_path: &str,
    config: &MemoryAutoUpdateConfig,
    summary: &mut MemoryAutoUpdateBatchSummary,
) -> Vec<SessionCandidate> {
    let Some(myagents_dir) = crate::app_dirs::myagents_data_dir() else {
        return vec![];
    };
    let sessions_path = myagents_dir.join("sessions.json");
    let sessions_content = match std::fs::read_to_string(&sessions_path) {
        Ok(content) => content,
        Err(_) => return vec![],
    };
    let sessions: Vec<SessionMeta> = match serde_json::from_str(strip_bom(&sessions_content)) {
        Ok(sessions) => sessions,
        Err(error) => {
            ulog_warn!(
                "[memory-auto-update] failed to parse sessions.json for {}: {}",
                workspace_path,
                error
            );
            return vec![];
        }
    };

    let normalized_workspace = normalize_path(workspace_path);
    let now = Utc::now();
    let active_session_cutoff = now - chrono::Duration::days(ACTIVE_SESSION_LOOKBACK_DAYS);
    let idle_cutoff = now - chrono::Duration::minutes(IDLE_COOLDOWN_MINUTES);
    let min_interval_cutoff = now - chrono::Duration::hours(config.interval_hours as i64);
    let mut candidates = Vec::new();

    for session in sessions {
        let Some(agent_dir) = session.agent_dir.as_ref() else {
            continue;
        };
        if normalize_path(agent_dir) != normalized_workspace {
            continue;
        }
        summary.checked_sessions += 1;

        // sessions.json is only a coarse I/O prefilter. A recent value cannot
        // make a session eligible because automatic turns may have polluted
        // it; eligibility is always decided from the last human JSONL row.
        // Missing/malformed metadata fails open. A recent JSONL mtime also
        // fails open, covering a durable append whose metadata write failed.
        let jsonl_modified_at = session_jsonl_modified_at(&myagents_dir, &session.id);
        if !should_scan_session_history(
            session.last_active_at.as_deref(),
            jsonl_modified_at,
            active_session_cutoff,
        ) {
            summary.skipped_inactive += 1;
            continue;
        }

        let analysis = analyze_session_jsonl(&myagents_dir, &session.id);
        if !is_within_active_session_lookback(&analysis, now) {
            summary.skipped_inactive += 1;
            continue;
        }
        if analysis
            .last_memory_update_at
            .is_some_and(|dt| dt > min_interval_cutoff)
        {
            summary.skipped_min_interval += 1;
            continue;
        }
        if analysis.query_count < config.query_threshold {
            summary.skipped_no_threshold += 1;
            continue;
        }

        if analysis
            .last_human_user_at
            .is_some_and(|dt| dt > idle_cutoff)
        {
            summary.skipped_recent_input += 1;
            continue;
        }

        candidates.push(SessionCandidate { id: session.id });
    }

    candidates
}

fn analyze_session_jsonl(myagents_dir: &Path, session_id: &str) -> SessionJsonlAnalysis {
    let jsonl_path = session_jsonl_path(myagents_dir, session_id);
    let content = match std::fs::read_to_string(&jsonl_path) {
        Ok(content) => content,
        Err(_) => return SessionJsonlAnalysis::default(),
    };
    analyze_session_jsonl_content(&content)
}

fn session_jsonl_path(myagents_dir: &Path, session_id: &str) -> PathBuf {
    myagents_dir
        .join("sessions")
        .join(format!("{}.jsonl", session_id))
}

fn session_jsonl_modified_at(myagents_dir: &Path, session_id: &str) -> Option<DateTime<Utc>> {
    std::fs::metadata(session_jsonl_path(myagents_dir, session_id))
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(DateTime::<Utc>::from)
}

fn analyze_session_jsonl_content(content: &str) -> SessionJsonlAnalysis {
    let lines: Vec<MessageLine> = content
        .lines()
        .filter_map(|line| serde_json::from_str::<MessageLine>(line).ok())
        .collect();
    let mut last_update_idx: Option<usize> = None;
    let mut last_memory_update_at: Option<DateTime<Utc>> = None;
    let mut last_human_user_at: Option<DateTime<Utc>> = None;

    for (idx, msg) in lines.iter().enumerate() {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let text = msg.content.as_ref().map(message_text).unwrap_or_default();
        let ts = message_timestamp(msg);
        if is_memory_update_marker(&text) {
            last_update_idx = Some(idx);
            last_memory_update_at = ts;
            continue;
        }
        if is_human_user_message(msg, &text) {
            if let Some(ts) = ts {
                last_human_user_at = Some(ts);
            }
        }
    }

    let start = last_update_idx.map(|idx| idx + 1).unwrap_or(0);
    let mut query_count = 0u32;
    for msg in lines.iter().skip(start) {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let text = msg.content.as_ref().map(message_text).unwrap_or_default();
        if !is_human_user_message(msg, &text) {
            continue;
        }
        query_count += 1;
    }

    SessionJsonlAnalysis {
        query_count,
        last_human_user_at,
        last_memory_update_at,
    }
}

fn is_within_active_session_lookback(analysis: &SessionJsonlAnalysis, now: DateTime<Utc>) -> bool {
    let cutoff = now - chrono::Duration::days(ACTIVE_SESSION_LOOKBACK_DAYS);
    analysis
        .last_human_user_at
        .is_some_and(|timestamp| timestamp >= cutoff)
}

fn should_scan_session_history(
    metadata_last_active_at: Option<&str>,
    jsonl_modified_at: Option<DateTime<Utc>>,
    cutoff: DateTime<Utc>,
) -> bool {
    match metadata_last_active_at.and_then(parse_datetime_utc) {
        None => true,
        Some(timestamp) if timestamp >= cutoff => true,
        Some(_) => jsonl_modified_at.is_some_and(|timestamp| timestamp >= cutoff),
    }
}

async fn update_single_session<R: Runtime>(
    session_id: &str,
    workspace_path: &str,
    sidecar_manager: &ManagedSidecarManager,
    app_handle: &AppHandle<R>,
    http_client: &reqwest::Client,
    task_id: &str,
    queue_id: &str,
) -> SessionUpdateOutcome {
    let owner = SidecarOwner::Task(task_id.to_string());

    let target = {
        let mut mgr = match sidecar_manager.lock() {
            Ok(guard) => guard,
            Err(error) => return SessionUpdateOutcome::Failed(format!("lock: {}", error)),
        };
        if let Some(port) = mgr.get_session_port(session_id) {
            if !mgr.add_session_owner(session_id, owner.clone()) {
                return SessionUpdateOutcome::Failed(
                    "ready Sidecar disappeared before memory-update owner attach".to_string(),
                );
            }
            MemoryUpdateSidecarTarget::Ready(port)
        } else if mgr.generation_for(session_id).is_some() {
            MemoryUpdateSidecarTarget::BoundButNotReady
        } else {
            MemoryUpdateSidecarTarget::Missing
        }
    };

    // Both Ready and Missing paths own the Sidecar before the HTTP request.
    // `ensure_session_sidecar` attaches the supplied owner even if another
    // caller wins creation after the Missing observation.
    let port = match target {
        MemoryUpdateSidecarTarget::Ready(port) => port,
        MemoryUpdateSidecarTarget::BoundButNotReady => return SessionUpdateOutcome::Busy,
        MemoryUpdateSidecarTarget::Missing => {
            let ah = app_handle.clone();
            let sm = sidecar_manager.clone();
            let sid = session_id.to_string();
            let ws = workspace_path.to_string();
            let own = owner.clone();
            let started =
                sidecar::ensure_session_sidecar_with_lifecycle(ah, sm, sid, PathBuf::from(ws), own)
                    .await
                    .map_err(|e| format!("ensure_sidecar: {}", e));

            match started {
                Ok(result) => result.port,
                Err(error) => return SessionUpdateOutcome::Failed(error),
            }
        }
    };

    let mut owner_guard = MemoryUpdateSidecarOwnerGuard {
        manager: sidecar_manager.clone(),
        session_id: session_id.to_string(),
        owner,
        release_on_drop: true,
    };

    if !crate::task_scheduler::get_task_scheduler()
        .authorize_dispatch(task_id, queue_id)
        .await
    {
        return SessionUpdateOutcome::Canceled;
    }

    // From this point the HTTP request may reach the runtime even if this
    // worker is canceled or panics. Keep the Task owner by default; only a
    // concrete response that proves the turn settled may release it.
    owner_guard.retain_for_task_stop();
    let outcome = post_memory_update(http_client, port, session_id, task_id, queue_id).await;
    if !matches!(outcome, SessionUpdateOutcome::TerminationUnconfirmed(_)) {
        owner_guard.confirm_turn_settled();
    }
    outcome
}

async fn post_memory_update(
    http_client: &reqwest::Client,
    port: u16,
    session_id: &str,
    task_id: &str,
    queue_id: &str,
) -> SessionUpdateOutcome {
    let url = format!("http://127.0.0.1:{}/api/memory/update", port);
    let response = match http_client
        .post(&url)
        .json(&serde_json::json!({
            "source": "auto",
            "sessionId": session_id,
            "taskId": task_id,
            "queueId": queue_id,
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return SessionUpdateOutcome::TerminationUnconfirmed(format!(
                "HTTP request failed after dispatch: {}",
                error
            ));
        }
    };
    let status = response.status();
    let parsed = response.json::<MemoryUpdateResponse>().await;
    let body = match parsed {
        Ok(body) => body,
        Err(error) => {
            return SessionUpdateOutcome::TerminationUnconfirmed(format!(
                "Failed to read memory update response after dispatch (status {}): {}",
                status, error
            ));
        }
    };
    if body.termination_unconfirmed {
        return SessionUpdateOutcome::TerminationUnconfirmed(
            body.reason
                .unwrap_or_else(|| "runtime turn may still be alive".to_string()),
        );
    }
    match body.status.as_str() {
        "completed" => SessionUpdateOutcome::Updated,
        "skipped" if body.reason.as_deref() == Some("session_busy") => SessionUpdateOutcome::Busy,
        "timeout" => SessionUpdateOutcome::Failed("turn timed out".to_string()),
        "skipped" => SessionUpdateOutcome::Failed(format!("skipped: {:?}", body.reason)),
        "error" => SessionUpdateOutcome::Failed(format!("turn failed: {:?}", body.reason)),
        other => SessionUpdateOutcome::Failed(format!("unexpected status: {}", other)),
    }
}

async fn update_successful_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    updated_count: u32,
) {
    let agent_id = agent_id.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let config_path = crate::app_dirs::myagents_data_dir()
            .ok_or("No data dir")?
            .join("config.json");
        with_config_lock(&config_path, true, |config| {
            let Some(agents) = config.get_mut("agents").and_then(|v| v.as_array_mut()) else {
                return Ok(());
            };
            let Some(agent) = agents
                .iter_mut()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id.as_str()))
            else {
                return Ok(());
            };
            let current = agent
                .get("memoryAutoUpdate")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let mut mau: MemoryAutoUpdateConfig =
                serde_json::from_value(current).unwrap_or_default();
            mau.last_batch_at = Some(Utc::now().to_rfc3339());
            mau.last_batch_session_count = Some(updated_count);
            agent["memoryAutoUpdate"] = serde_json::to_value(mau).unwrap_or(Value::Null);
            Ok(())
        })?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let _ = app_handle.emit("agent:config-changed", serde_json::json!({}));
        }
        Ok(Err(error)) => ulog_warn!("[memory-auto-update] failed to update config: {}", error),
        Err(error) => ulog_warn!(
            "[memory-auto-update] config update spawn_blocking failed: {}",
            error
        ),
    }
}

fn load_enabled_memory_auto_update_agent_for_workspace(
    workspace_path: &str,
) -> Result<Option<(String, MemoryAutoUpdateConfig, Option<HeartbeatConfig>)>, String> {
    let Some(data_dir) = crate::app_dirs::myagents_data_dir() else {
        return Ok(None);
    };
    let config_path = data_dir.join("config.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read config.json: {}", error)),
    };
    let config: Value =
        serde_json::from_str(strip_bom(&content)).map_err(|e| format!("parse config: {}", e))?;
    let Some(agents) = config.get("agents").and_then(Value::as_array) else {
        return Ok(None);
    };
    let normalized_workspace = normalize_path(workspace_path);
    for agent in agents {
        let Some(agent_workspace) = agent.get("workspacePath").and_then(Value::as_str) else {
            continue;
        };
        if normalize_path(agent_workspace) != normalized_workspace {
            continue;
        }
        let Some(mau_value) = agent.get("memoryAutoUpdate") else {
            continue;
        };
        if mau_value.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(agent_id) = agent.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mau: MemoryAutoUpdateConfig = serde_json::from_value(mau_value.clone())
            .map_err(|e| format!("parse memoryAutoUpdate: {}", e))?;
        let heartbeat = agent
            .get("heartbeat")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        return Ok(Some((agent_id.to_string(), mau, heartbeat)));
    }
    Ok(None)
}

pub fn is_in_update_window(config: &MemoryAutoUpdateConfig) -> bool {
    let tz_name = config
        .update_window_timezone
        .as_deref()
        .unwrap_or("Asia/Shanghai");
    let tz: chrono_tz::Tz = match tz_name.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!(
                "[memory-auto-update] invalid timezone '{}', assuming in-window",
                tz_name
            );
            return true;
        }
    };

    let now = Utc::now().with_timezone(&tz);
    is_local_time_in_window(now.hour() * 60 + now.minute(), config)
}

fn is_local_time_in_window(now_minutes: u32, config: &MemoryAutoUpdateConfig) -> bool {
    let start = parse_hhmm(&config.update_window_start).unwrap_or(0);
    let end = parse_hhmm(&config.update_window_end).unwrap_or(360);
    if start <= end {
        now_minutes >= start && now_minutes < end
    } else {
        now_minutes >= start || now_minutes < end
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

fn message_timestamp(message: &MessageLine) -> Option<DateTime<Utc>> {
    message
        .timestamp
        .as_deref()
        .or(message.created_at.as_deref())
        .and_then(parse_datetime_utc)
}

fn parse_datetime_utc(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

fn message_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(message_text)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(obj) => obj
            .get("text")
            .or_else(|| obj.get("content"))
            .map(message_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn is_memory_update_marker(text: &str) -> bool {
    let trimmed = text.trim_start();
    leading_system_reminder_kind(text) == Some("MEMORY_UPDATE")
        || trimmed.starts_with("<MEMORY_UPDATE>")
        || trimmed.starts_with("/UPDATE_MEMORY")
}

fn is_automatic_user_text(text: &str) -> bool {
    let leading_kind = leading_system_reminder_kind(text);
    is_memory_update_marker(text)
        || matches!(
            leading_kind,
            Some(
                "HEARTBEAT"
                    | "CRON_TASK"
                    | "LOCAL_COMMAND_OUTPUT"
                    | "myagents-session-event"
                    | "myagents-space-issue"
            )
        )
}

fn human_user_text(text: &str) -> Option<String> {
    if is_automatic_user_text(text) {
        return None;
    }

    let visible = strip_leading_system_reminder(text);
    (!visible.trim().is_empty()).then_some(visible)
}

fn is_human_user_message(message: &MessageLine, text: &str) -> bool {
    if is_automatic_user_text(text) {
        return false;
    }
    human_user_text(text).is_some()
        || message
            .attachments
            .as_ref()
            .is_some_and(|attachments| match attachments {
                Value::Array(items) => !items.is_empty(),
                Value::Null => false,
                _ => true,
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::memory_rules::ensure_update_memory_file_at as ensure_update_memory_file;

    fn spawn_owner_guard_test_child() -> std::process::Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = crate::process_cmd::new("powershell");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = crate::process_cmd::new("sleep");
            command.arg("60");
            command
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn owner guard test child")
    }

    fn base_config() -> MemoryAutoUpdateConfig {
        MemoryAutoUpdateConfig {
            enabled: true,
            interval_hours: 24,
            query_threshold: 2,
            update_window_start: "00:00".to_string(),
            update_window_end: "07:00".to_string(),
            update_window_timezone: Some("Asia/Shanghai".to_string()),
            last_batch_at: None,
            last_batch_session_count: None,
        }
    }

    #[test]
    fn memory_update_response_decodes_termination_ambiguity_from_node_wire_shape() {
        let response: MemoryUpdateResponse = serde_json::from_value(serde_json::json!({
            "status": "timeout",
            "terminationUnconfirmed": true
        }))
        .expect("decode memory update response");

        assert!(response.termination_unconfirmed);
    }

    #[test]
    fn jsonl_analysis_resets_queries_when_memory_update_is_dispatched() {
        let content = r#"{"role":"user","content":"before","timestamp":"2026-01-01T00:00:00.000Z"}
{"role":"user","content":"<system-reminder><MEMORY_UPDATE>update</MEMORY_UPDATE></system-reminder>","timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"assistant","content":"provider failed","timestamp":"2026-01-01T01:01:00.000Z"}
{"role":"user","content":"q1","timestamp":"2026-01-01T02:00:00.000Z"}
{"role":"user","content":"<system-reminder><HEARTBEAT>hidden</HEARTBEAT></system-reminder>","timestamp":"2026-01-01T02:05:00.000Z"}
{"role":"user","content":[{"type":"text","text":"q2"}],"timestamp":"2026-01-01T03:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 2);
        assert_eq!(
            analysis
                .last_memory_update_at
                .expect("memory marker")
                .to_rfc3339(),
            "2026-01-01T01:00:00+00:00"
        );
        assert_eq!(
            analysis.last_human_user_at.expect("last user").to_rfc3339(),
            "2026-01-01T03:00:00+00:00"
        );
    }

    #[test]
    fn latest_memory_dispatch_throttles_even_when_the_turn_fails() {
        let content = r#"{"role":"user","content":"<system-reminder><MEMORY_UPDATE>first</MEMORY_UPDATE></system-reminder>","timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"assistant","content":"MEMORY_UPDATE_OK","timestamp":"2026-01-01T01:01:00.000Z"}
{"role":"user","content":"q1","timestamp":"2026-01-01T02:00:00.000Z"}
{"role":"user","content":"<system-reminder><MEMORY_UPDATE>retry</MEMORY_UPDATE></system-reminder>","timestamp":"2026-01-01T03:00:00.000Z"}
{"role":"assistant","content":"provider failed","timestamp":"2026-01-01T03:01:00.000Z"}
{"role":"user","content":"q2","timestamp":"2026-01-01T04:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 1);
        assert_eq!(
            analysis
                .last_memory_update_at
                .expect("last dispatched memory update")
                .to_rfc3339(),
            "2026-01-01T03:00:00+00:00"
        );
    }

    #[test]
    fn dispatched_memory_marker_creates_cooldown_without_an_assistant_reply() {
        let content = r#"{"role":"user","content":"q1","timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"user","content":"<system-reminder><MEMORY_UPDATE>orphan</MEMORY_UPDATE></system-reminder>","timestamp":"2026-01-01T02:00:00.000Z"}
{"role":"user","content":"q2","timestamp":"2026-01-01T03:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 1);
        assert_eq!(
            analysis
                .last_memory_update_at
                .expect("memory dispatch marker")
                .to_rfc3339(),
            "2026-01-01T02:00:00+00:00"
        );
    }

    #[test]
    fn jsonl_analysis_uses_visible_goal_queries_but_ignores_automatic_turns() {
        let content = r#"{"role":"user","content":"<system-reminder><GOAL_CONTINUATION>hidden</GOAL_CONTINUATION></system-reminder>first goal query","timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"user","content":"<system-reminder><GOAL_CONTINUATION>hidden</GOAL_CONTINUATION></system-reminder>","timestamp":"2026-01-01T02:00:00.000Z"}
{"role":"user","content":"<system-reminder><CRON_TASK>hidden</CRON_TASK></system-reminder>scheduled prompt","timestamp":"2026-01-01T03:00:00.000Z"}
{"role":"user","content":"<system-reminder><GOAL_CONTEXT>hidden</GOAL_CONTEXT></system-reminder>follow-up","timestamp":"2026-01-01T04:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 2);
        assert_eq!(
            analysis
                .last_human_user_at
                .expect("visible goal query")
                .to_rfc3339(),
            "2026-01-01T04:00:00+00:00"
        );
    }

    #[test]
    fn jsonl_analysis_counts_attachment_only_human_input() {
        let content = r#"{"role":"user","content":"<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>","timestamp":"2026-01-01T00:00:00.000Z"}
{"role":"user","content":"","attachments":[{"path":"image.png"}],"timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"user","content":"<system-reminder><CRON_TASK>scheduled</CRON_TASK></system-reminder>","attachments":[{"path":"maintenance.txt"}],"timestamp":"2026-01-01T02:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 1);
        assert_eq!(
            analysis
                .last_human_user_at
                .expect("attachment-only human input")
                .to_rfc3339(),
            "2026-01-01T01:00:00+00:00"
        );
    }

    #[test]
    fn marker_detection_uses_the_standard_leading_reminder_protocol() {
        assert!(is_memory_update_marker(
            "<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>"
        ));
        assert!(is_memory_update_marker("  /UPDATE_MEMORY maintain"));
        assert!(is_memory_update_marker(
            "<MEMORY_UPDATE>legacy</MEMORY_UPDATE>"
        ));
        assert!(!is_memory_update_marker(
            "请解释为什么日志里出现 /UPDATE_MEMORY"
        ));
        assert!(human_user_text("请解释 <CRON_TASK> 标签").is_some());
        assert!(is_automatic_user_text(
            "<system-reminder><LOCAL_COMMAND_OUTPUT>local</LOCAL_COMMAND_OUTPUT></system-reminder><local-command-stdout>cost output</local-command-stdout>"
        ));
        assert!(is_automatic_user_text(
            "<system-reminder><myagents-session-event type=\"watch.completed\">result</myagents-session-event></system-reminder>"
        ));
        assert!(is_automatic_user_text(
            "<system-reminder><myagents-space-issue>issue</myagents-space-issue></system-reminder>"
        ));
        assert!(human_user_text("请解释 <inbox-message> 标签").is_some());
    }

    #[test]
    fn active_session_lookback_requires_human_input_within_seven_days() {
        let now = parse_datetime_utc("2026-01-08T12:00:00.000Z").unwrap();
        let exactly_seven_days = SessionJsonlAnalysis {
            last_human_user_at: parse_datetime_utc("2026-01-01T12:00:00.000Z"),
            ..Default::default()
        };
        let too_old = SessionJsonlAnalysis {
            last_human_user_at: parse_datetime_utc("2026-01-01T11:59:59.999Z"),
            ..Default::default()
        };

        assert!(is_within_active_session_lookback(&exactly_seven_days, now));
        assert!(!is_within_active_session_lookback(&too_old, now));
        assert!(!is_within_active_session_lookback(
            &SessionJsonlAnalysis::default(),
            now,
        ));
    }

    #[test]
    fn metadata_is_only_a_coarse_prefilter_and_jsonl_remains_authority() {
        let now = parse_datetime_utc("2026-01-08T12:00:00.000Z").unwrap();
        let cutoff = now - chrono::Duration::days(ACTIVE_SESSION_LOOKBACK_DAYS);

        assert!(!should_scan_session_history(
            Some("2026-01-01T11:59:59.999Z"),
            Some(parse_datetime_utc("2026-01-01T11:59:59.999Z").unwrap()),
            cutoff,
        ));
        assert!(should_scan_session_history(None, None, cutoff));
        assert!(should_scan_session_history(
            Some("not-a-date"),
            None,
            cutoff
        ));

        // If the metadata write failed after a durable transcript append, the
        // fresh JSONL mtime keeps the authoritative history reachable.
        assert!(should_scan_session_history(
            Some("2025-12-01T00:00:00.000Z"),
            Some(parse_datetime_utc("2026-01-08T11:00:00.000Z").unwrap()),
            cutoff,
        ));

        // A maintenance turn may make metadata look fresh. The stale human
        // JSONL timestamp must still reject the session after it is opened.
        assert!(should_scan_session_history(
            Some("2026-01-08T11:00:00.000Z"),
            None,
            cutoff,
        ));
        let stale_human_history = SessionJsonlAnalysis {
            last_human_user_at: parse_datetime_utc("2025-12-01T00:00:00.000Z"),
            ..Default::default()
        };
        assert!(!is_within_active_session_lookback(
            &stale_human_history,
            now,
        ));
    }

    #[test]
    fn memory_update_owner_keeps_ready_sidecar_alive_after_tab_detaches() {
        let session_id = "memory-owner-session";
        let tab_owner = SidecarOwner::Tab("tab-a".to_string());
        let memory_owner = SidecarOwner::Task("memory-task".to_string());
        let manager = crate::sidecar::create_sidecar_manager();
        {
            let mut sidecars = manager.lock().expect("sidecar manager lock");
            sidecars.insert_sidecar(
                session_id,
                crate::sidecar::SessionSidecar {
                    process: spawn_owner_guard_test_child(),
                    port: 31419,
                    session_id: session_id.to_string(),
                    workspace_path: PathBuf::from("/tmp/workspace"),
                    state: crate::sidecar::SidecarState::Healthy,
                    owners: HashSet::from([tab_owner.clone()]),
                    created_at: std::time::Instant::now(),
                    runtime: None,
                    runtime_source: None,
                },
            );
            assert!(sidecars.add_session_owner(session_id, memory_owner.clone()));
        }

        let owner_guard = MemoryUpdateSidecarOwnerGuard {
            manager: manager.clone(),
            session_id: session_id.to_string(),
            owner: memory_owner,
            release_on_drop: true,
        };
        {
            let mut sidecars = manager.lock().expect("sidecar manager lock");
            assert_eq!(
                sidecars.remove_session_owner(session_id, &tab_owner),
                (true, false),
                "the memory-update owner must keep the Sidecar alive"
            );
            assert!(sidecars.session_has_owners(session_id));
        }

        drop(owner_guard);
        assert!(
            !manager
                .lock()
                .expect("sidecar manager lock")
                .session_has_owners(session_id),
            "RAII release must remove the temporary owner and stop the ownerless Sidecar"
        );
    }

    #[test]
    fn unconfirmed_memory_turn_retains_task_owner_for_retry_stop() {
        let session_id = "memory-owner-unconfirmed";
        let task_owner = SidecarOwner::Task("memory-task-unconfirmed".to_string());
        let manager = crate::sidecar::create_sidecar_manager();
        {
            let mut sidecars = manager.lock().expect("sidecar manager lock");
            sidecars.insert_sidecar(
                session_id,
                crate::sidecar::SessionSidecar {
                    process: spawn_owner_guard_test_child(),
                    port: 31420,
                    session_id: session_id.to_string(),
                    workspace_path: PathBuf::from("/tmp/workspace"),
                    state: crate::sidecar::SidecarState::Healthy,
                    owners: HashSet::from([task_owner.clone()]),
                    created_at: std::time::Instant::now(),
                    runtime: None,
                    runtime_source: None,
                },
            );
        }

        let mut owner_guard = MemoryUpdateSidecarOwnerGuard {
            manager: manager.clone(),
            session_id: session_id.to_string(),
            owner: task_owner.clone(),
            release_on_drop: true,
        };
        owner_guard.retain_for_task_stop();
        drop(owner_guard);

        assert!(
            manager
                .lock()
                .expect("sidecar manager lock")
                .session_has_owners(session_id),
            "an ambiguous turn must keep its Task owner until exact stop"
        );
        crate::sidecar::release_session_sidecar(&manager, session_id, &task_owner)
            .expect("retry stop releases retained owner");
    }

    #[test]
    fn confirmed_memory_turn_releases_a_dispatch_retained_owner() {
        let session_id = "memory-owner-confirmed";
        let task_owner = SidecarOwner::Task("memory-task-confirmed".to_string());
        let manager = crate::sidecar::create_sidecar_manager();
        {
            let mut sidecars = manager.lock().expect("sidecar manager lock");
            sidecars.insert_sidecar(
                session_id,
                crate::sidecar::SessionSidecar {
                    process: spawn_owner_guard_test_child(),
                    port: 31421,
                    session_id: session_id.to_string(),
                    workspace_path: PathBuf::from("/tmp/workspace"),
                    state: crate::sidecar::SidecarState::Healthy,
                    owners: HashSet::from([task_owner.clone()]),
                    created_at: std::time::Instant::now(),
                    runtime: None,
                    runtime_source: None,
                },
            );
        }

        let mut owner_guard = MemoryUpdateSidecarOwnerGuard {
            manager: manager.clone(),
            session_id: session_id.to_string(),
            owner: task_owner,
            release_on_drop: true,
        };
        owner_guard.retain_for_task_stop();
        owner_guard.confirm_turn_settled();
        drop(owner_guard);

        assert!(
            !manager
                .lock()
                .expect("sidecar manager lock")
                .session_has_owners(session_id),
            "a confirmed terminal outcome must restore ordinary RAII release"
        );
    }

    #[test]
    fn update_window_handles_wrapping_ranges() {
        let cfg = base_config();
        assert!(is_local_time_in_window(60, &cfg));
        assert!(!is_local_time_in_window(8 * 60, &cfg));

        let mut wrapping = cfg;
        wrapping.update_window_start = "21:00".to_string();
        wrapping.update_window_end = "09:00".to_string();
        assert!(is_local_time_in_window(22 * 60, &wrapping));
        assert!(is_local_time_in_window(2 * 60, &wrapping));
        assert!(!is_local_time_in_window(12 * 60, &wrapping));
    }

    #[test]
    fn ensure_update_memory_file_accepts_empty_body_after_frontmatter_without_rewriting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        let original = "---\ndescription: placeholder\n---\n\n   \n";
        std::fs::write(&path, original).expect("write empty file");

        ensure_update_memory_file(&path).expect("ensure file");

        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn ensure_update_memory_file_accepts_zero_byte_file_without_rewriting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        std::fs::write(&path, "").expect("write zero-byte file");

        ensure_update_memory_file(&path).expect("ensure file");

        assert_eq!(std::fs::read_to_string(path).unwrap(), "");
    }

    #[test]
    fn ensure_update_memory_file_preserves_existing_custom_instructions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        let original =
            "---\ndescription: custom\n---\n\nWrite decisions to memory/topics/product.md.\n";
        std::fs::write(&path, original).expect("write custom file");

        ensure_update_memory_file(&path).expect("ensure file");

        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn ensure_update_memory_file_creates_frontmatter_only_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");

        ensure_update_memory_file(&path).expect("ensure file");

        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            crate::workspace_files::memory_rules::default_update_memory_content()
        );
    }

    #[test]
    fn ensure_update_memory_file_rejects_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        std::fs::create_dir(&path).expect("create directory collision");

        let error = ensure_update_memory_file(&path).expect_err("directory must fail closed");

        assert!(error.contains("directory"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_update_memory_file_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target.md");
        let path = dir.path().join("UPDATE_MEMORY.md");
        std::fs::write(&target, "custom").expect("write target");
        symlink(&target, &path).expect("create symlink");

        let error = ensure_update_memory_file(&path).expect_err("symlink must fail closed");

        assert!(error.contains("symlink"));
        assert_eq!(std::fs::read_to_string(target).unwrap(), "custom");
    }

    #[test]
    fn disk_reconcile_only_uses_explicit_memory_auto_update_config() {
        let config = serde_json::json!({
            "agents": [
                {
                    "id": "missing",
                    "workspacePath": "/tmp/missing"
                },
                {
                    "id": "enabled",
                    "workspacePath": "/tmp/enabled",
                    "memoryAutoUpdate": {
                        "enabled": true,
                        "intervalHours": 24,
                        "queryThreshold": 3,
                        "updateWindowStart": "00:00",
                        "updateWindowEnd": "07:00",
                        "updateWindowTimezone": "Asia/Shanghai"
                    }
                },
                {
                    "id": "disabled",
                    "workspacePath": "/tmp/disabled",
                    "memoryAutoUpdate": {
                        "enabled": false,
                        "intervalHours": 24,
                        "queryThreshold": 3,
                        "updateWindowStart": "00:00",
                        "updateWindowEnd": "07:00",
                        "updateWindowTimezone": "Asia/Shanghai"
                    }
                }
            ]
        });

        let agents = collect_disk_memory_auto_update_agents(&config);

        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].request.agent_id, "enabled");
        assert_eq!(
            agents[0]
                .request
                .memory_auto_update
                .as_ref()
                .unwrap()
                .enabled,
            true
        );
        assert_eq!(agents[1].request.agent_id, "disabled");
        assert_eq!(
            agents[1]
                .request
                .memory_auto_update
                .as_ref()
                .unwrap()
                .enabled,
            false
        );
    }

    #[test]
    fn configure_request_uses_latest_disk_authority_not_arrival_order() {
        let disabled_disk = collect_disk_memory_auto_update_agents(&serde_json::json!({
            "agents": [{
                "id": "agent-current",
                "workspacePath": "/tmp/workspace",
                "memoryAutoUpdate": {
                    "enabled": false,
                    "intervalHours": 24,
                    "queryThreshold": 3,
                    "updateWindowStart": "00:00",
                    "updateWindowEnd": "07:00"
                }
            }]
        }));
        let stale_enable = ConfigureMemoryAutoUpdateTaskRequest {
            agent_id: "agent-stale".to_string(),
            workspace_path: "/tmp/workspace".to_string(),
            memory_auto_update: Some(base_config()),
            heartbeat: None,
        };

        let resolved = authoritative_configure_request(stale_enable, disabled_disk);

        assert_eq!(resolved.agent_id, "agent-current");
        assert!(!resolved.memory_auto_update.unwrap().enabled);

        let enabled_disk = collect_disk_memory_auto_update_agents(&serde_json::json!({
            "agents": [{
                "id": "agent-current",
                "workspacePath": "/tmp/workspace",
                "memoryAutoUpdate": {
                    "enabled": true,
                    "intervalHours": 24,
                    "queryThreshold": 3,
                    "updateWindowStart": "00:00",
                    "updateWindowEnd": "07:00"
                }
            }]
        }));
        let stale_disable = ConfigureMemoryAutoUpdateTaskRequest {
            agent_id: "agent-stale".to_string(),
            workspace_path: "/tmp/workspace".to_string(),
            memory_auto_update: None,
            heartbeat: None,
        };

        let resolved = authoritative_configure_request(stale_disable, enabled_disk);

        assert_eq!(resolved.agent_id, "agent-current");
        assert!(resolved.memory_auto_update.unwrap().enabled);
    }
}
