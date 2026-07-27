use tauri::{AppHandle, Manager};

use super::{get_session_goal_manager, GoalStatus};
use crate::sidecar::ManagedSidecarManager;
use crate::{ulog_error, ulog_info, ulog_warn};

pub async fn initialize_session_goal_manager(app_handle: AppHandle) {
    let manager = get_session_goal_manager();
    manager.set_app_handle(app_handle.clone()).await;

    let sidecars = app_handle.state::<ManagedSidecarManager>().inner().clone();
    match sidecars.lock() {
        Ok(guard) => {
            let mut sidecar_stops = guard.subscribe_stop_events();
            let sidecars_for_reconcile = sidecars.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match sidecar_stops.recv().await {
                        Ok((session_id, generation)) => {
                            revoke_stopped_sidecar_authority_until_durable(&session_id, generation)
                                .await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                            ulog_warn!(
                                "[Goal] Sidecar lifecycle listener lagged by {} event(s); reconciling authorities",
                                count
                            );
                            reconcile_authorities_until_durable(&sidecars_for_reconcile).await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        Err(error) => ulog_error!("[Goal] Failed to subscribe to Sidecar lifecycle: {}", error),
    }

    match manager.startup_snapshot().await {
        Ok(goals) => {
            for goal in goals {
                if !goal.is_terminal() && goal.end_conditions.deadline.is_some() {
                    manager.ensure_deadline(&goal.id).await;
                }
                if goal.status == GoalStatus::Active {
                    manager.ensure_continuation(&goal.id, 0).await;
                } else if !goal.delivery_outbox.is_empty() {
                    manager.ensure_delivery_replay(&goal.id).await;
                }
            }
            ulog_info!("[Goal] Session Goal manager initialized");
        }
        Err(error) => ulog_error!("[Goal] Startup recovery failed: {}", error),
    }
}

async fn revoke_stopped_sidecar_authority_until_durable(session_id: &str, generation: u64) {
    let manager = get_session_goal_manager();
    loop {
        match manager
            .revoke_turn_authorities_for_sidecar(session_id, generation)
            .await
        {
            Ok(count) => {
                if count > 0 {
                    if let Ok(Some(goal)) = manager
                        .get_for_session(session_id, None, false)
                        .await
                    {
                        if goal.status == GoalStatus::Active {
                            manager.ensure_continuation(&goal.id, 0).await;
                        }
                    }
                }
                return;
            }
            Err(error) => ulog_error!(
                "[Goal] Authority revoke is not durable after Session {} generation {} stopped: {}; retrying",
                session_id,
                generation,
                error
            ),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

async fn reconcile_authorities_until_durable(sidecars: &ManagedSidecarManager) {
    let manager = get_session_goal_manager();
    loop {
        match manager
            .reconcile_turn_authorities_with_live_sidecars(sidecars)
            .await
        {
            Ok(_) => return,
            Err(error) => ulog_error!(
                "[Goal] Authority reconciliation is not durable: {}; retrying",
                error
            ),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}
