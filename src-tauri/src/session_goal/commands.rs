use super::{get_session_goal_manager, GoalStatus, SessionGoalConfig, SessionGoalView};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSchedulerLifecycleSnapshot {
    running_task_count: usize,
    delete_protected_session_ids: Vec<String>,
}

#[tauri::command]
pub async fn cmd_get_user_scheduler_lifecycle_snapshot(
    state: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    agent_state: tauri::State<'_, crate::im::ManagedAgents>,
    im_state: tauri::State<'_, crate::im::ManagedImBots>,
) -> Result<UserSchedulerLifecycleSnapshot, String> {
    let mut running_task_count = 0usize;
    if let Some(store) = crate::task::get_task_store() {
        for task in store.list(Default::default()).await {
            if task.status == crate::task::TaskStatus::Running {
                running_task_count += 1;
            }
        }
    }
    let mut delete_protected_session_ids = crate::task_scheduler::persistent_task_session_ids()
        .await
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let (running_goals, goal_sessions) = get_session_goal_manager()
        .lifecycle_snapshot()
        .await
        .map_err(|error| error.to_string())?;
    running_task_count += running_goals;
    delete_protected_session_ids.extend(goal_sessions);
    delete_protected_session_ids.extend(
        state
            .lock()
            .map_err(|error| error.to_string())?
            .persistent_owner_session_ids(),
    );
    delete_protected_session_ids.extend(
        crate::im::session_delivery::bound_session_ids(agent_state.inner(), im_state.inner()).await,
    );
    let mut delete_protected_session_ids =
        delete_protected_session_ids.into_iter().collect::<Vec<_>>();
    delete_protected_session_ids.sort();
    Ok(UserSchedulerLifecycleSnapshot {
        running_task_count,
        delete_protected_session_ids,
    })
}

#[tauri::command]
pub async fn cmd_create_session_goal(config: SessionGoalConfig) -> Result<SessionGoalView, String> {
    get_session_goal_manager()
        .create_goal_waiting_for_turn(config)
        .await
        .map(|goal| goal.view())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_goal(
    sessionId: String,
    workspacePath: Option<String>,
    includeTerminal: Option<bool>,
) -> Result<Option<SessionGoalView>, String> {
    get_session_goal_manager()
        .get_for_session(
            &sessionId,
            workspacePath.as_deref(),
            includeTerminal.unwrap_or(false),
        )
        .await
        .map(|goal| goal.map(|goal| goal.view()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_pause_session_goal(goal_id: String) -> Result<SessionGoalView, String> {
    get_session_goal_manager()
        .pause_goal_and_stop(&goal_id)
        .await
        .map(|goal| goal.view())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_resume_session_goal(goal_id: String) -> Result<SessionGoalView, String> {
    get_session_goal_manager()
        .resume_goal(&goal_id)
        .await
        .map(|goal| goal.view())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_mark_session_goal_terminal(
    goal_id: String,
    status: GoalStatus,
    reason: Option<String>,
) -> Result<SessionGoalView, String> {
    if status != GoalStatus::Canceled {
        return Err("User Goal control may only cancel the Goal".to_string());
    }
    get_session_goal_manager()
        .cancel_goal_and_stop(&goal_id, reason)
        .await
        .map(|goal| goal.view())
        .map_err(|error| error.to_string())
}
