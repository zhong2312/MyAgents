use super::*;

const MANAGED_CRON_TASK_ERROR: &str =
    "Managed scheduled jobs are internal and cannot be managed from ordinary CronTask surfaces";
const LOOP_CRON_TASK_ERROR: &str =
    "Loop scheduling is retired; create a Session Goal for persistent work";

fn is_managed_cron_task(task: &CronTask) -> bool {
    task.managed_kind
        .as_deref()
        .is_some_and(crate::task::is_supported_managed_kind)
}

async fn get_ordinary_cron_task(
    manager: &CronTaskManager,
    task_id: &str,
) -> Result<CronTask, String> {
    let task = manager
        .get_task(task_id)
        .await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;
    if is_managed_cron_task(&task) {
        return Err(MANAGED_CRON_TASK_ERROR.to_string());
    }
    Ok(task)
}

// ============ Tauri Commands ============

/// Create a new cron task
#[tauri::command]
pub async fn cmd_create_cron_task(config: CronTaskConfig) -> Result<CronTask, String> {
    if config
        .managed_kind
        .as_deref()
        .is_some_and(|kind| !kind.trim().is_empty())
    {
        return Err(MANAGED_CRON_TASK_ERROR.to_string());
    }
    if matches!(&config.schedule, Some(CronSchedule::Loop)) {
        return Err(LOOP_CRON_TASK_ERROR.to_string());
    }
    let manager = get_cron_task_manager();
    manager.create_task(config).await
}

/// Start a scheduled Task and arm its scheduler as one backend use case.
#[tauri::command]
pub async fn cmd_start_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await?;
    let task = manager.start_task(&task_id).await?;

    ulog_info!(
        "[CronTask] Started cron task {} for workspace {}",
        task.id,
        task.workspace_path
    );

    // Emit event so frontend task list refreshes immediately
    let _ = app_handle.emit(
        "cron:task-started",
        serde_json::json!({
            "taskId": task.id,
        }),
    );

    Ok(task)
}

/// Stop a cron task (with optional exit reason)
/// exit_reason can be set when AI calls ExitCronTask or end conditions are met
#[tauri::command]
pub async fn cmd_stop_cron_task(
    task_id: String,
    exit_reason: Option<String>,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await?;
    manager.stop_task(&task_id, exit_reason).await
}

/// Delete a cron task
#[tauri::command]
pub async fn cmd_delete_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await?;
    manager.delete_task(&task_id).await?;
    let _ = app_handle.emit(
        "cron:task-deleted",
        serde_json::json!({ "taskId": task_id }),
    );
    Ok(())
}

/// Get a cron task by ID
#[tauri::command]
pub async fn cmd_get_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await
}

/// Get all cron tasks
#[tauri::command]
pub async fn cmd_get_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_all_tasks()
        .await
        .into_iter()
        .filter(|task| !is_managed_cron_task(task))
        .collect())
}

/// Read-only diagnostic surface for historical rows that have no Task authority.
#[tauri::command]
pub async fn cmd_get_unmigrated_legacy_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_unmigrated_legacy_tasks()
        .await
        .into_iter()
        .filter(|task| !is_managed_cron_task(task))
        .collect())
}

/// Get cron tasks for a workspace
#[tauri::command]
pub async fn cmd_get_workspace_cron_tasks(workspace_path: String) -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_tasks_for_workspace(&workspace_path)
        .await
        .into_iter()
        .filter(|task| !is_managed_cron_task(task))
        .collect())
}

/// Get active cron task for a session (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_active_task_for_session(&sessionId)
        .await
        .filter(|task| !is_managed_cron_task(task)))
}

/// Check if a task is currently executing
#[tauri::command]
pub async fn cmd_is_task_executing(task_id: String) -> Result<bool, String> {
    let manager = get_cron_task_manager();
    Ok(manager.is_task_executing(&task_id).await)
}

/// Get execution history (run records) for a cron task
#[tauri::command]
pub async fn cmd_get_cron_runs(
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<CronRunRecord>, String> {
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await?;
    Ok(read_cron_runs(&task_id, limit.unwrap_or(20)))
}

/// Update editable fields of a cron task (name, prompt, schedule, endConditions)
/// If the task is running, it will be stopped, updated, and restarted.
#[tauri::command]
pub async fn cmd_update_cron_task_fields(
    app_handle: tauri::AppHandle,
    task_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<CronSchedule>,
    interval_minutes: Option<u32>,
    end_conditions: Option<EndConditions>,
    notify_enabled: Option<bool>,
    model: Option<String>,
    permission_mode: Option<String>,
    delivery: Option<CronDelivery>,
    clear_delivery: Option<bool>,
) -> Result<CronTask, String> {
    // Delegate to the single-source-of-truth implementation in
    // `update_task_fields`. It handles the stop→apply→restart bounce
    // uniformly for every caller (Tauri command + Task Center projection),
    // so changing a running cron's schedule through any surface takes effect
    // immediately.
    let manager = get_cron_task_manager();
    get_ordinary_cron_task(manager, &task_id).await?;
    let mut patch = serde_json::Map::new();
    if let Some(n) = name {
        patch.insert("name".to_string(), serde_json::Value::String(n));
    }
    if let Some(p) = prompt {
        patch.insert("prompt".to_string(), serde_json::Value::String(p));
    }
    if let Some(s) = schedule {
        patch.insert(
            "schedule".to_string(),
            serde_json::to_value(&s).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(im) = interval_minutes {
        patch.insert(
            "intervalMinutes".to_string(),
            serde_json::Value::Number(serde_json::Number::from(im)),
        );
    }
    if let Some(ec) = end_conditions {
        patch.insert(
            "endConditions".to_string(),
            serde_json::to_value(&ec).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(ne) = notify_enabled {
        patch.insert("notifyEnabled".to_string(), serde_json::Value::Bool(ne));
    }
    if let Some(m) = model {
        patch.insert("model".to_string(), serde_json::Value::String(m));
    }
    if let Some(pm) = permission_mode {
        patch.insert("permissionMode".to_string(), serde_json::Value::String(pm));
    }
    if let Some(d) = delivery {
        patch.insert(
            "delivery".to_string(),
            serde_json::to_value(&d).unwrap_or(serde_json::Value::Null),
        );
    } else if clear_delivery == Some(true) {
        patch.insert("clearDelivery".to_string(), serde_json::Value::Bool(true));
    }

    let updated = manager
        .update_task_fields(&task_id, serde_json::Value::Object(patch))
        .await?;

    let _ = app_handle.emit(
        "cron:task-updated",
        serde_json::json!({ "taskId": task_id }),
    );
    Ok(updated)
}
