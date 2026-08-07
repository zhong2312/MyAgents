use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::im::types::{HeartbeatConfig, MemoryAutoUpdateConfig};
use crate::task::{
    self, TaskCreateDirectInput, TaskEndConditions, TaskExecutionMode, TaskExecutor,
    TaskListFilter, TaskRunMode, TaskStatus, TaskUpdateInput, TaskUpdateStatusInput,
    TransitionActor, TransitionSource, MANAGED_KIND_MEMORY_GARDENER, MANAGED_KIND_MEMORY_MOLT,
};

const GARDENER_INTERVAL_MINUTES: u32 = 72 * 60;
const MOLT_INTERVAL_MINUTES: u32 = 14 * 24 * 60;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryEvolutionTasksRequest {
    pub agent_id: String,
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryEvolutionTasksResult {
    pub enabled: bool,
    pub gardener_task_id: Option<String>,
    pub molt_task_id: Option<String>,
}

struct EvoJobSpec {
    managed_kind: &'static str,
    name: &'static str,
    interval_minutes: u32,
    prompt: String,
}

#[tauri::command]
pub async fn cmd_configure_memory_evolution_tasks(
    request: ConfigureMemoryEvolutionTasksRequest,
) -> Result<ConfigureMemoryEvolutionTasksResult, String> {
    let Some(store) = task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };

    if request.enabled {
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            &request.workspace_path,
        )?;
    }

    let gardener = job_spec(
        MANAGED_KIND_MEMORY_GARDENER,
        "Memory Gardener",
        GARDENER_INTERVAL_MINUTES,
        "myagents-memory-gardener",
        &request.workspace_path,
    );
    let molt = job_spec(
        MANAGED_KIND_MEMORY_MOLT,
        "Memory Molt",
        MOLT_INTERVAL_MINUTES,
        "myagents-memory-molt",
        &request.workspace_path,
    );

    if !request.enabled {
        stop_existing_job(store, &request.workspace_path, &gardener).await?;
        stop_existing_job(store, &request.workspace_path, &molt).await?;
        backfill_and_log_system_maintenance_session_markers(&request.workspace_path).await;
        return Ok(ConfigureMemoryEvolutionTasksResult {
            enabled: false,
            gardener_task_id: None,
            molt_task_id: None,
        });
    }

    let gardener_task_id = ensure_job_running(store, &request, &gardener).await?;
    let molt_task_id = ensure_job_running(store, &request, &molt).await?;
    backfill_and_log_system_maintenance_session_markers(&request.workspace_path).await;

    crate::ulog_info!(
        "[memory-evolution] ensured managed tasks for agent {}: gardener={}, molt={}",
        request.agent_id,
        gardener_task_id,
        molt_task_id
    );

    Ok(ConfigureMemoryEvolutionTasksResult {
        enabled: true,
        gardener_task_id: Some(gardener_task_id),
        molt_task_id: Some(molt_task_id),
    })
}

async fn backfill_and_log_system_maintenance_session_markers(workspace_path: &str) {
    match backfill_system_maintenance_session_markers(workspace_path).await {
        Ok(count) if count > 0 => {
            crate::ulog_info!(
                "[memory-evolution] backfilled {} system maintenance session marker(s) for {}",
                count,
                workspace_path
            );
        }
        Ok(_) => {}
        Err(error) => {
            crate::ulog_warn!(
                "[memory-evolution] failed to backfill system maintenance session markers for {}: {}",
                workspace_path,
                error
            );
        }
    }
}

fn job_spec(
    managed_kind: &'static str,
    name: &'static str,
    interval_minutes: u32,
    skill_name: &'static str,
    workspace_path: &str,
) -> EvoJobSpec {
    EvoJobSpec {
        managed_kind,
        name,
        interval_minutes,
        prompt: format!(
            "Use the {} skill to maintain long-term memory for this workspace.\n\nWorkspace: `{}`\n\nConstraints:\n- Only inspect and edit memory-related files unless the skill explicitly requires a small supporting read.\n- If this workspace is a git repository, commit only the memory-related files changed by this run.\n- Do not push.\n- If required memory substrate files are missing, create them from the MyAgents defaults before continuing.",
            skill_name, workspace_path
        ),
    }
}

async fn ensure_job_running(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
) -> Result<String, String> {
    let task = match find_existing_job(store, &request.workspace_path, spec).await {
        Some(task) => reconcile_existing_job(store, request, spec, task).await?,
        None => {
            store
                .create_system_managed_direct(TaskCreateDirectInput {
                    name: spec.name.to_string(),
                    executor: TaskExecutor::Agent,
                    description: Some(
                        "System-managed long-term memory evolution task.".to_string(),
                    ),
                    workspace_id: request.workspace_id.clone(),
                    workspace_path: request.workspace_path.clone(),
                    task_md_content: spec.prompt.clone(),
                    execution_mode: TaskExecutionMode::Recurring,
                    run_mode: Some(TaskRunMode::NewSession),
                    end_conditions: Some(TaskEndConditions::default()),
                    interval_minutes: Some(spec.interval_minutes),
                    cron_expression: None,
                    cron_timezone: None,
                    start_at: Some(first_start_at(
                        spec.interval_minutes,
                        request.memory_auto_update.as_ref(),
                        request.heartbeat.as_ref(),
                    )),
                    recurring_window: Some(recurring_window(
                        request.memory_auto_update.as_ref(),
                        request.heartbeat.as_ref(),
                    )),
                    trigger: None,
                    dispatch_at: None,
                    model: None,
                    provider_id: None,
                    permission_mode: None,
                    preselected_session_id: None,
                    runtime: request.runtime.clone(),
                    runtime_config: request.runtime_config.clone(),
                    mcp_enabled_servers: request.mcp_enabled_servers.clone(),
                    managed_kind: Some(spec.managed_kind.to_string()),
                    source_thought_id: None,
                    tags: vec![
                        "system".to_string(),
                        "memory".to_string(),
                        "evo".to_string(),
                    ],
                    notification: None,
                })
                .await?
        }
    };

    arm_task_for_scheduler(store, task).await
}

async fn stop_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    workspace_path: &str,
    spec: &EvoJobSpec,
) -> Result<(), String> {
    let Some(task) = find_existing_job(store, workspace_path, spec).await else {
        return Ok(());
    };
    stop_job_for_update(store, &task, "memory evolution disabled").await
}

async fn stop_job_for_update(
    store: &std::sync::Arc<task::TaskStore>,
    task: &task::Task,
    reason: &str,
) -> Result<(), String> {
    if matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
        store
            .update_status(TaskUpdateStatusInput {
                id: task.id.clone(),
                status: TaskStatus::Stopped,
                message: Some(reason.to_string()),
                actor: TransitionActor::System,
                source: Some(TransitionSource::Scheduler),
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

async fn reconcile_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
    existing: task::Task,
) -> Result<task::Task, String> {
    let desired_window = recurring_window(
        request.memory_auto_update.as_ref(),
        request.heartbeat.as_ref(),
    );
    let existing_window_matches = existing.recurring_window.as_ref() == Some(&desired_window);
    let existing_start_at = existing
        .start_at
        .as_deref()
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map(|s| s.trim().to_string());
    let start_at = if existing_window_matches {
        existing_start_at.unwrap_or_else(|| {
            first_start_at(
                spec.interval_minutes,
                request.memory_auto_update.as_ref(),
                request.heartbeat.as_ref(),
            )
        })
    } else {
        first_start_at(
            spec.interval_minutes,
            request.memory_auto_update.as_ref(),
            request.heartbeat.as_ref(),
        )
    };
    let desired_description = "System-managed long-term memory evolution task.";
    let desired_tags = vec![
        "system".to_string(),
        "memory".to_string(),
        "evo".to_string(),
    ];
    let current_prompt = task::task_docs_dir(&existing.id)
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("task.md")).ok());

    let runtime_drift = existing.runtime != request.runtime
        || (request.runtime.is_none() && existing.runtime_config.is_some())
        || request
            .runtime_config
            .as_ref()
            .is_some_and(|desired| existing.runtime_config.as_ref() != Some(desired));
    let mcp_drift = existing.mcp_enabled_servers != request.mcp_enabled_servers;
    let drifted = existing.name != spec.name
        || existing.description.as_deref() != Some(desired_description)
        || existing.execution_mode != TaskExecutionMode::Recurring
        || existing.run_mode != Some(TaskRunMode::NewSession)
        || existing.end_conditions != Some(TaskEndConditions::default())
        || existing.interval_minutes != Some(spec.interval_minutes)
        || existing.cron_expression.is_some()
        || existing.cron_timezone.is_some()
        || existing.start_at.as_deref() != Some(start_at.as_str())
        || existing.recurring_window.as_ref() != Some(&desired_window)
        || existing.dispatch_at.is_some()
        || existing.model.is_some()
        || existing.provider_id.is_some()
        || existing.permission_mode.is_some()
        || existing.preselected_session_id.is_some()
        || runtime_drift
        || mcp_drift
        || existing.tags != desired_tags
        || current_prompt.as_deref() != Some(spec.prompt.as_str());

    if !drifted {
        return Ok(existing);
    }

    if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
        stop_job_for_update(
            store,
            &existing,
            "memory evolution settings changed; re-arming",
        )
        .await?;
    }

    store
        .update(TaskUpdateInput {
            id: existing.id,
            name: Some(spec.name.to_string()),
            executor: None,
            description: Some(desired_description.to_string()),
            execution_mode: Some(TaskExecutionMode::Recurring),
            run_mode: Some(TaskRunMode::NewSession),
            end_conditions: Some(TaskEndConditions::default()),
            interval_minutes: Some(spec.interval_minutes),
            cron_expression: Some(String::new()),
            cron_timezone: Some(String::new()),
            start_at: Some(start_at),
            recurring_window: Some(desired_window),
            dispatch_at: None,
            trigger: None,
            clear_trigger: true,
            model: None,
            provider_id: None,
            clear_provider_override: true,
            permission_mode: Some(String::new()),
            preselected_session_id: Some(String::new()),
            runtime: request.runtime.clone(),
            runtime_config: request.runtime_config.clone(),
            clear_runtime_override: request.runtime.is_none(),
            mcp_enabled_servers: request.mcp_enabled_servers.clone(),
            clear_mcp_override: request.mcp_enabled_servers.is_none(),
            tags: Some(desired_tags),
            notification: None,
            notification_patch: None,
            prompt: Some(spec.prompt.clone()),
        })
        .await
}

async fn backfill_system_maintenance_session_markers(
    workspace_path: &str,
) -> Result<usize, String> {
    let Some(store) = task::get_task_store() else {
        return Ok(0);
    };
    let managed_by_cron_id: HashMap<String, String> = store
        .list(task::TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .filter(|task| {
            crate::workspace_path::normalize_workspace_path_identity(&task.workspace_path)
                == crate::workspace_path::normalize_workspace_path_identity(workspace_path)
        })
        .filter_map(|task| {
            let kind = match task.managed_kind.as_deref() {
                Some(task::MANAGED_KIND_MEMORY_GARDENER) => task::MANAGED_KIND_MEMORY_GARDENER,
                Some(task::MANAGED_KIND_MEMORY_MOLT) => task::MANAGED_KIND_MEMORY_MOLT,
                _ => return None,
            };
            Some((task.id, kind.to_string()))
        })
        .collect();
    if managed_by_cron_id.is_empty() {
        return Ok(0);
    }

    let myagents_dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "无法定位 MyAgents 数据目录".to_string())?;
    let sessions_path = myagents_dir.join("sessions.json");
    let tmp_path = myagents_dir.join("sessions.json.tmp");
    let lock_path = myagents_dir.join("sessions.lock");

    let result = crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || -> Result<usize, crate::utils::file_lock::FileLockError> {
            let content = match std::fs::read_to_string(&sessions_path) {
                Ok(content) => content,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(err) => return Err(crate::utils::file_lock::FileLockError::Io(err)),
            };
            let mut sessions: Value = serde_json::from_str(crate::utils::bom::strip_bom(&content))
                .map_err(|err| {
                    crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("parse sessions.json: {}", err),
                    ))
                })?;
            let arr = sessions.as_array_mut().ok_or_else(|| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "sessions.json must contain a SessionMetadata array",
                ))
            })?;

            let mut changed = 0usize;
            for session in arr.iter_mut() {
                let Some(cron_id) = session.get("cronTaskId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(kind) = managed_by_cron_id.get(cron_id) else {
                    continue;
                };
                let Some(obj) = session.as_object_mut() else {
                    continue;
                };
                if obj.get("systemMaintenanceKind").and_then(Value::as_str) == Some(kind.as_str()) {
                    continue;
                }
                obj.insert(
                    "systemMaintenanceKind".to_string(),
                    Value::String(kind.clone()),
                );
                changed += 1;
            }

            if changed == 0 {
                return Ok(0);
            }

            let new_content = serde_json::to_string_pretty(&sessions).map_err(|err| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("serialize sessions.json: {}", err),
                ))
            })?;
            std::fs::write(&tmp_path, new_content)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            std::fs::rename(&tmp_path, &sessions_path)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            Ok(changed)
        },
    )
    .await;

    result.map_err(|err| format!("sessions metadata lock/write failed: {}", err))
}

async fn arm_task_for_scheduler(
    store: &std::sync::Arc<task::TaskStore>,
    task: task::Task,
) -> Result<String, String> {
    if task.status == TaskStatus::Running {
        crate::task_scheduler::get_task_scheduler()
            .start(&task.id)
            .await?;
        return Ok(task.id);
    }

    let current = store
        .get(&task.id)
        .await
        .ok_or_else(|| format!("task {} disappeared while arming", task.id))?;

    if current.status != TaskStatus::Todo {
        store
            .update_status(TaskUpdateStatusInput {
                id: current.id.clone(),
                status: TaskStatus::Todo,
                message: Some("memory evolution enabled".to_string()),
                actor: TransitionActor::System,
                source: Some(TransitionSource::Scheduler),
            })
            .await?;
    }

    let result = crate::task_application::TaskApplication::from_globals()
        .map_err(|error| error.to_string())?
        .run(&task.id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.task.id)
}

fn first_start_at(
    interval_minutes: u32,
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> String {
    let base = chrono::Utc::now() + chrono::Duration::minutes(interval_minutes.max(5) as i64);
    align_to_memory_update_window(base, memory_auto_update, heartbeat).to_rfc3339()
}

fn recurring_window(
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> crate::cron_task::RecurringWindow {
    let default_memory_auto_update;
    let memory_auto_update = match memory_auto_update {
        Some(config) => config,
        None => {
            default_memory_auto_update = MemoryAutoUpdateConfig::default();
            &default_memory_auto_update
        }
    };
    let timezone = memory_auto_update
        .update_window_timezone
        .as_deref()
        .or_else(|| {
            heartbeat
                .and_then(|config| config.active_hours.as_ref())
                .map(|hours| hours.timezone.as_str())
        })
        .unwrap_or("Asia/Shanghai")
        .to_string();

    crate::cron_task::RecurringWindow {
        timezone,
        start: memory_auto_update.update_window_start.clone(),
        end: memory_auto_update.update_window_end.clone(),
    }
}

fn align_to_memory_update_window(
    base: chrono::DateTime<chrono::Utc>,
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> chrono::DateTime<chrono::Utc> {
    use chrono::{TimeZone, Timelike};

    let default_memory_auto_update;
    let memory_auto_update = match memory_auto_update {
        Some(config) => config,
        None => {
            default_memory_auto_update = MemoryAutoUpdateConfig::default();
            &default_memory_auto_update
        }
    };

    let tz_name = memory_auto_update
        .update_window_timezone
        .as_deref()
        .or_else(|| {
            heartbeat
                .and_then(|config| config.active_hours.as_ref())
                .map(|hours| hours.timezone.as_str())
        })
        .unwrap_or("Asia/Shanghai");
    let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() else {
        crate::ulog_warn!(
            "[memory-evolution] invalid timezone '{}'; using unaligned first start",
            tz_name
        );
        return base;
    };

    let start = parse_hhmm(&memory_auto_update.update_window_start).unwrap_or(21 * 60);
    let end = parse_hhmm(&memory_auto_update.update_window_end).unwrap_or(9 * 60);
    let local = base.with_timezone(&tz);
    let now_minutes = local.hour() * 60 + local.minute();
    if is_in_window(now_minutes, start, end) {
        return base;
    }

    let target_date = if start <= end {
        if now_minutes < start {
            local.date_naive()
        } else {
            local
                .date_naive()
                .checked_add_days(chrono::Days::new(1))
                .unwrap_or_else(|| local.date_naive())
        }
    } else {
        // Wrapping window (for example 21:00-09:00). Reaching this branch
        // means the base time is between end and start, so today's start is
        // the next valid time.
        local.date_naive()
    };

    let hour = start / 60;
    let minute = start % 60;
    let Some(naive) = target_date.and_hms_opt(hour, minute, 0) else {
        return base;
    };
    let candidate = match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&chrono::Utc)),
        chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&chrono::Utc)),
        chrono::LocalResult::None => (1..=120).find_map(|offset| {
            let adjusted = naive + chrono::Duration::minutes(offset);
            match tz.from_local_datetime(&adjusted) {
                chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&chrono::Utc)),
                chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&chrono::Utc)),
                chrono::LocalResult::None => None,
            }
        }),
    };

    candidate.filter(|dt| *dt > base).unwrap_or(base)
}

fn is_in_window(minutes: u32, start: u32, end: u32) -> bool {
    if start <= end {
        minutes >= start && minutes < end
    } else {
        minutes >= start || minutes < end
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (hour, minute) = s.split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

async fn find_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    workspace_path: &str,
    spec: &EvoJobSpec,
) -> Option<task::Task> {
    let normalized_workspace = crate::cron_task::normalize_path(workspace_path);
    store
        .list(TaskListFilter {
            workspace_id: None,
            status: None,
            tag: None,
            include_deleted: Some(false),
            include_managed: Some(true),
        })
        .await
        .into_iter()
        .find(|task| {
            task.managed_kind.as_deref() == Some(spec.managed_kind)
                && crate::cron_task::normalize_path(&task.workspace_path) == normalized_workspace
        })
}
