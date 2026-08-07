//! Read-only Legacy CronTask -> Task migration.
//!
//! The old JSON file remains a diagnostic backup. Live scheduling starts only
//! from TaskStore after this migration completes.

use crate::cron_task;
use crate::task;
use crate::{ulog_info, ulog_warn};

fn run_mode_from_cron(mode: &cron_task::RunMode) -> task::TaskRunMode {
    match mode {
        cron_task::RunMode::SingleSession => task::TaskRunMode::SingleSession,
        cron_task::RunMode::NewSession => task::TaskRunMode::NewSession,
    }
}

fn end_conditions_from_cron(conditions: &cron_task::EndConditions) -> task::TaskEndConditions {
    task::TaskEndConditions {
        deadline: conditions.deadline.map(|value| value.timestamp_millis()),
        max_executions: conditions.max_executions,
        ai_can_exit: conditions.ai_can_exit,
    }
}

fn notification_from_cron(cron: &cron_task::CronTask) -> task::NotificationConfig {
    task::NotificationConfig {
        desktop: cron.notify_enabled,
        bot_channel_id: cron
            .delivery
            .as_ref()
            .map(|delivery| delivery.bot_id.clone()),
        bot_thread: cron
            .delivery
            .as_ref()
            .map(|delivery| delivery.chat_id.clone()),
        events: Some(vec![
            "done".to_string(),
            "blocked".to_string(),
            "endCondition".to_string(),
        ]),
    }
}

fn normal_status(cron: &cron_task::CronTask) -> task::TaskStatus {
    if matches!(cron.schedule, Some(cron_task::CronSchedule::At { .. })) && cron.execution_count > 0
    {
        return task::TaskStatus::Done;
    }
    match cron.status {
        cron_task::TaskStatus::Running => task::TaskStatus::Running,
        cron_task::TaskStatus::Stopped if cron.exit_reason.is_some() => task::TaskStatus::Done,
        cron_task::TaskStatus::Stopped => task::TaskStatus::Stopped,
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let prefix: String = value.chars().take(max.saturating_sub(1)).collect();
    format!("{prefix}…")
}

fn task_name(cron: &cron_task::CronTask) -> String {
    if let Some(name) = cron
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return truncate_chars(name, 120);
    }
    truncate_chars(
        cron.prompt
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("未命名定时任务")
            .trim(),
        60,
    )
}

fn workspace_id_for(
    cron: &cron_task::CronTask,
    agents: &[crate::im::types::AgentConfigRust],
) -> Option<String> {
    let target = crate::workspace_path::normalize_workspace_path_identity(&cron.workspace_path);
    agents
        .iter()
        .find(|agent| {
            crate::workspace_path::normalize_workspace_path_identity(&agent.resolved_workspace_path)
                == target
        })
        .map(|agent| agent.id.clone())
}

fn migration_input(
    cron: &cron_task::CronTask,
    workspace_id: String,
) -> (task::TaskCreateDirectInput, task::TaskStatus, String) {
    let run_mode = run_mode_from_cron(&cron.run_mode);
    let mut blocked_reason = None;
    let uses_external_runtime = cron
        .runtime
        .as_deref()
        .is_some_and(|runtime| runtime != "builtin");
    let provider_id = if uses_external_runtime {
        // External runtimes own their provider configuration. Historical
        // builtin provider fields were never part of that execution route.
        None
    } else if cron.provider_env.is_some() {
        blocked_reason = Some(
            "Legacy provider credentials were not copied; select a provider before rerun"
                .to_string(),
        );
        None
    } else if cron.provider_id.is_some() && cron.model.is_none() {
        blocked_reason = Some(
            "Legacy provider routing has no model; select a provider and model before rerun"
                .to_string(),
        );
        None
    } else if cron.provider_intent == cron_task::ProviderIntent::Subscription {
        if cron.model.is_some() {
            Some("anthropic-sub".to_string())
        } else {
            blocked_reason = Some(
                "Legacy subscription routing has no model; select a model before rerun".to_string(),
            );
            None
        }
    } else {
        cron.provider_id.clone()
    };

    let (
        execution_mode,
        interval_minutes,
        cron_expression,
        cron_timezone,
        start_at,
        window,
        dispatch_at,
    ) = match cron.schedule.as_ref() {
        Some(cron_task::CronSchedule::At { at }) => (
            task::TaskExecutionMode::Scheduled,
            None,
            None,
            None,
            None,
            None,
            chrono::DateTime::parse_from_rfc3339(at)
                .ok()
                .map(|value| value.timestamp_millis()),
        ),
        Some(cron_task::CronSchedule::Cron { expr, tz }) => (
            task::TaskExecutionMode::Recurring,
            None,
            Some(expr.clone()),
            tz.clone(),
            None,
            None,
            None,
        ),
        Some(cron_task::CronSchedule::Every {
            minutes,
            start_at,
            catch_up_window,
        }) => (
            task::TaskExecutionMode::Recurring,
            Some(*minutes),
            None,
            None,
            start_at.clone(),
            catch_up_window.clone(),
            None,
        ),
        Some(cron_task::CronSchedule::Loop) => unreachable!("Loop rows are filtered"),
        None => (
            task::TaskExecutionMode::Recurring,
            Some(cron.interval_minutes.max(5)),
            None,
            None,
            None,
            None,
            None,
        ),
    };

    let status = blocked_reason
        .as_ref()
        .map(|_| task::TaskStatus::Blocked)
        .unwrap_or_else(|| normal_status(cron));
    let message = blocked_reason.unwrap_or_else(|| match status {
        task::TaskStatus::Running => "migrated from legacy cron (running)".to_string(),
        task::TaskStatus::Done => format!(
            "migrated from legacy cron (done{})",
            cron.exit_reason
                .as_deref()
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        ),
        task::TaskStatus::Stopped => "migrated from legacy cron (stopped)".to_string(),
        _ => "migrated from legacy cron".to_string(),
    });

    (
        task::TaskCreateDirectInput {
            name: task_name(cron),
            executor: task::TaskExecutor::Agent,
            description: None,
            workspace_id,
            workspace_path: cron.workspace_path.clone(),
            task_md_content: cron.prompt.clone(),
            execution_mode,
            run_mode: Some(run_mode),
            end_conditions: Some(end_conditions_from_cron(&cron.end_conditions)),
            interval_minutes,
            cron_expression,
            cron_timezone,
            start_at,
            recurring_window: window,
            dispatch_at,
            trigger: None,
            model: cron.model.clone(),
            provider_id,
            permission_mode: (!cron.permission_mode.is_empty())
                .then(|| cron.permission_mode.clone()),
            preselected_session_id: (run_mode == task::TaskRunMode::SingleSession)
                .then(|| cron.session_id.trim().to_string())
                .filter(|value| !value.is_empty()),
            runtime: cron.runtime.clone(),
            runtime_config: cron.runtime_config.clone(),
            mcp_enabled_servers: cron.mcp_enabled_servers.clone(),
            managed_kind: cron.managed_kind.clone(),
            source_thought_id: None,
            tags: cron
                .source_bot_id
                .as_ref()
                .map(|id| vec![format!("bot:{id}")])
                .unwrap_or_default(),
            notification: Some(notification_from_cron(cron)),
        },
        status,
        message,
    )
}

async fn migrate_one(
    store: &task::TaskStore,
    cron: &cron_task::CronTask,
    workspace_id: Option<String>,
) -> Result<task::Task, String> {
    if matches!(cron.schedule, Some(cron_task::CronSchedule::Loop)) {
        return Err("Legacy Loop tasks are retired and are not migrated".to_string());
    }

    let target_id = cron
        .legacy_task_id
        .clone()
        .unwrap_or_else(|| cron.id.clone());
    if let Some(existing) = store.get(&target_id).await {
        let was_migrated = existing
            .status_history
            .iter()
            .any(|transition| transition.source == Some(task::TransitionSource::Migration));
        if existing.deleted && (cron.legacy_task_id.is_some() || was_migrated) {
            return Ok(existing);
        }
        if cron.legacy_task_id.is_some() {
            let migrated = store
                .import_legacy_execution_state(
                    &existing.id,
                    cron.execution_count,
                    cron.last_executed_at.map(|value| value.timestamp_millis()),
                    Some(&cron.session_id),
                )
                .await?;
            if let Err(error) =
                crate::cron_task::run_records::migrate_cron_run_history(&cron.id, &migrated.id)
                    .await
            {
                ulog_warn!(
                    "[legacy-cron] run history migration failed {} -> {}: {}",
                    cron.id,
                    migrated.id,
                    error
                );
            }
            return Ok(migrated);
        }
    }

    let missing_workspace = workspace_id.is_none();
    let workspace_id = workspace_id.unwrap_or_else(|| format!("legacy-{}", cron.id));
    let (input, mut status, mut message) = migration_input(cron, workspace_id);
    if missing_workspace {
        status = task::TaskStatus::Blocked;
        message = "Legacy Cron workspace is no longer registered; select a workspace before rerun"
            .to_string();
    }
    let task = store
        .create_migrated_with_id(target_id, input, status, message)
        .await?;
    let task = store
        .import_legacy_execution_state(
            &task.id,
            cron.execution_count,
            cron.last_executed_at.map(|value| value.timestamp_millis()),
            Some(&cron.session_id),
        )
        .await?;
    if let Err(error) =
        crate::cron_task::run_records::migrate_cron_run_history(&cron.id, &task.id).await
    {
        ulog_warn!(
            "[legacy-cron] run history migration failed {} -> {}: {}",
            cron.id,
            task.id,
            error
        );
    }
    Ok(task)
}

pub async fn migrate_legacy_crons_on_startup() -> Result<(), String> {
    let store = task::get_task_store().ok_or_else(|| "task store not initialized".to_string())?;
    let manager = cron_task::get_cron_task_manager();
    if let Some(error) = manager.legacy_load_error() {
        return Err(format!("legacy Cron store failed validation: {error}"));
    }
    let agents = crate::im::read_agent_configs_from_disk();
    let rows = manager.get_legacy_tasks().await;
    let mut migrated = 0usize;
    let mut failures = Vec::new();

    for cron in rows {
        if matches!(cron.schedule, Some(cron_task::CronSchedule::Loop)) {
            ulog_info!("[legacy-cron] retired Loop row {}", cron.id);
            continue;
        }
        let workspace_id = workspace_id_for(&cron, &agents);
        match migrate_one(store, &cron, workspace_id).await {
            Ok(_) => migrated += 1,
            Err(error) => {
                ulog_warn!("[legacy-cron] failed to migrate {}: {}", cron.id, error);
                failures.push(format!("{}: {}", cron.id, error));
            }
        }
    }

    if migrated > 0 {
        ulog_info!("[legacy-cron] migrated {} row(s) into TaskStore", migrated);
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} legacy Cron row(s) remain read-only after migration failure: {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_at(execution_count: u32) -> cron_task::CronTask {
        serde_json::from_value(serde_json::json!({
            "id": "legacy-at",
            "workspacePath": "/tmp/workspace",
            "sessionId": "session-1",
            "prompt": "run once",
            "intervalMinutes": 60,
            "status": "running",
            "executionCount": execution_count,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "schedule": { "kind": "at", "at": "2026-01-02T00:00:00Z" }
        }))
        .unwrap()
    }

    #[test]
    fn previously_executed_one_shot_migrates_terminal() {
        assert_eq!(normal_status(&legacy_at(1)), task::TaskStatus::Done);
    }

    #[test]
    fn pending_one_shot_remains_running_for_scheduler_recovery() {
        assert_eq!(normal_status(&legacy_at(0)), task::TaskStatus::Running);
    }

    #[test]
    fn migration_preserves_source_bot_identity() {
        let mut cron = legacy_at(0);
        cron.source_bot_id = Some("bot-1".to_string());

        let (input, _, _) = migration_input(&cron, "workspace-1".to_string());

        assert_eq!(input.tags, vec!["bot:bot-1"]);
    }
}
