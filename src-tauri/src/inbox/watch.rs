use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sidecar::{ManagedSidecarManager, SidecarState};
use crate::{ulog_info, ulog_warn};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWatchRequest {
    pub watch_id: String,
    pub watcher_session_id: String,
    #[serde(default)]
    pub watcher_resume_workspace_path: Option<String>,
    pub target_session_id: String,
    #[serde(default)]
    pub target_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWatchResult {
    pub watch_id: String,
    pub target_session_id: String,
    pub target_state_at_registration: String,
    pub delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_result: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterWatchResponse {
    accepted: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    delivery: Option<String>,
    #[serde(default)]
    target_state_at_registration: Option<String>,
    #[serde(default)]
    final_state: Option<String>,
    #[serde(default)]
    terminal_reason: Option<String>,
    #[serde(default)]
    latest_result: Option<String>,
}

fn lookup_live_port(manager: &ManagedSidecarManager, session_id: &str) -> Option<(u16, String)> {
    let guard = manager.lock().ok()?;
    let sidecar = guard.get_session_sidecar(session_id)?;
    match sidecar.state {
        SidecarState::Healthy if sidecar.is_reusable() => {
            Some((sidecar.port, "healthy".to_string()))
        }
        SidecarState::Healthy => None,
        SidecarState::Starting => Some((sidecar.port, "starting".to_string())),
        SidecarState::Dead => None,
    }
}

async fn register_on_target_sidecar(
    port: u16,
    req: &SessionWatchRequest,
    observed_sidecar_state: &str,
) -> Result<RegisterWatchResponse, String> {
    let url = format!("http://127.0.0.1:{}/api/session-watch/register", port);
    let client = crate::local_http::json_client(Duration::from_secs(10));
    let deadline = if observed_sidecar_state == "starting" {
        Some(Instant::now() + Duration::from_secs(45))
    } else {
        None
    };

    loop {
        let response = client
            .post(&url)
            .json(&serde_json::json!({
                "watchId": req.watch_id.clone(),
                "watcherSessionId": req.watcher_session_id.clone(),
                "watcherResumeWorkspacePath": req.watcher_resume_workspace_path.clone(),
                "targetSessionId": req.target_session_id.clone(),
                "targetLabel": req.target_label.clone(),
                "observedSidecarState": observed_sidecar_state,
            }))
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    if status.as_u16() == 503 && deadline.is_some_and(|d| Instant::now() < d) {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    return Err(format!("target watch register HTTP {}", status.as_u16()));
                }
                return response
                    .json::<RegisterWatchResponse>()
                    .await
                    .map_err(|e| format!("target watch register response parse failed: {}", e));
            }
            Err(e) => {
                if deadline.is_some_and(|d| Instant::now() < d) {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                return Err(format!("target watch register HTTP failed: {}", e));
            }
        }
    }
}

pub async fn register_session_watch(
    _app_handle: AppHandle,
    manager: ManagedSidecarManager,
    req: SessionWatchRequest,
) -> SessionWatchResult {
    let Some((port, observed_sidecar_state)) = lookup_live_port(&manager, &req.target_session_id)
    else {
        return SessionWatchResult {
            watch_id: req.watch_id,
            target_session_id: req.target_session_id,
            target_state_at_registration: "idle".to_string(),
            delivery: "already_idle".to_string(),
            final_state: None,
            terminal_reason: None,
            latest_result: None,
        };
    };

    match register_on_target_sidecar(port, &req, &observed_sidecar_state).await {
        Ok(body) => {
            let target_state = body
                .target_state_at_registration
                .unwrap_or_else(|| "unknown".to_string());
            let delivery = body.delivery.unwrap_or_else(|| {
                if body.accepted {
                    "registered".to_string()
                } else {
                    body.reason.unwrap_or_else(|| "error".to_string())
                }
            });

            if body.accepted && delivery == "registered" {
                ulog_info!(
                    "[session-watch] registered watch_id={} target={} watcher={} state={}",
                    req.watch_id,
                    req.target_session_id,
                    req.watcher_session_id,
                    target_state
                );
                return SessionWatchResult {
                    watch_id: req.watch_id,
                    target_session_id: req.target_session_id,
                    target_state_at_registration: target_state,
                    delivery,
                    final_state: None,
                    terminal_reason: None,
                    latest_result: body.latest_result,
                };
            }

            return SessionWatchResult {
                watch_id: req.watch_id,
                target_session_id: req.target_session_id,
                target_state_at_registration: target_state,
                delivery: if delivery == "already_idle" {
                    "already_idle".to_string()
                } else {
                    "error".to_string()
                },
                final_state: body.final_state,
                terminal_reason: body.terminal_reason,
                latest_result: body.latest_result,
            };
        }
        Err(e) => {
            ulog_warn!(
                "[session-watch] failed to register watch_id={} target={}: {}",
                req.watch_id,
                req.target_session_id,
                e
            );
            SessionWatchResult {
                watch_id: req.watch_id,
                target_session_id: req.target_session_id,
                target_state_at_registration: "unknown".to_string(),
                delivery: "error".to_string(),
                final_state: Some("registration_failed".to_string()),
                terminal_reason: Some("watch_registration_failed".to_string()),
                latest_result: None,
            }
        }
    }
}
