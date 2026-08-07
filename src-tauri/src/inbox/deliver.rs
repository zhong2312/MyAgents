// Session Inbox 跨 sidecar 投递 (PRD 0.2.18)
//
// 入口:`cmd_inbox_deliver` Tauri command + `deliver_with_resume` 异步函数(由
// management API `/api/inbox/deliver` handler 调用)。流程:
//
//   1. 找 target_session_id 对应的 SessionSidecar(SidecarManager 查询)
//   2. 如果不存在或 unhealthy:
//      - 有 resume_workspace_path → spawn 临时 owner + ensure_session_sidecar
//        唤起,投递结束后**显式 release**(避免 owner 永久泄漏)
//      - 无 resume_workspace_path → 返回 SessionNotFound
//   3. HTTP POST `/api/inbox/drain` (via local_http) body 携带 message
//   4. HTTP 2xx + drain accepted → Delivered
//   5. HTTP 非 2xx / 网络错误 → DeliveryFailed
//
// fire-and-forget 设计:失败由 caller AI 自决重试,不做 at-least-once 重试,
// 不在 sidecar 上保留队列(早期版本里 SessionSidecar.pending_inbox_messages
// 是 reinvention,已删除——push/pop 没有 consumer,反而是 leak surface)。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sidecar::{ManagedSidecarManager, SidecarOwner};
use crate::{ulog_error, ulog_info, ulog_warn};

use super::types::PendingInboxMessage;

/// Drain handler 投递结果(对应 sidecar /api/inbox/drain 的响应)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResponse {
    /// Whether the sidecar accepted the messages (e.g., enqueueUserMessage returned queued)
    pub accepted: bool,
    /// Optional reason if accepted=false (e.g., 'external_busy', 'queue_full')
    #[serde(default)]
    pub reason: Option<String>,
}

/// `cmd_inbox_deliver` 的响应:可能 success(投递成功)或 error(失败原因)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum DeliverOutcome {
    /// 投递成功:HTTP POST 拿到 2xx + accepted=true
    Delivered { message_id: String },
    /// Target session 不存在或不健康(sidecar 没起 / dead state)
    SessionNotFound,
    /// HTTP 投递失败(网络/sidecar 5xx 等)
    DeliveryFailed { reason: String },
    /// Target sidecar 拒绝接收(例如 external runtime busy)
    Rejected { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshSessionStartRequest {
    pub agent_id: String,
    pub workspace_path: String,
    pub from_session_id: String,
    pub from_label: String,
    pub prompt: String,
    pub reply_back: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshSessionStartOutcome {
    pub status: String,
    pub agent_id: String,
    pub session_id: String,
    pub message_id: String,
    pub reply_back: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshStartTargetResponse {
    accepted: Option<bool>,
    #[serde(default)]
    reason: Option<String>,
}

/// Tauri command 接收 inbox message 并投递到 target sidecar。
///
/// 命名 snake_case 是因为 Tauri 自动会把命令名按 generate_handler! 时的写法
/// 暴露给前端(我们 ts 端实际不调用此命令——它由 sidecar admin handler 通过
/// management API 投递,见 `crate::management_api::inbox_deliver_handler`)。
///
/// 留出 #[tauri::command] 仍允许将来手动 invoke 用于排查。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_inbox_deliver(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    message: PendingInboxMessage,
) -> Result<DeliverOutcome, String> {
    Ok(deliver_with_resume(&app_handle, &state, message, None).await)
}

/// HTTP POST the message to target sidecar's `/api/inbox/drain`.
async fn http_post_drain(port: u16, message: &PendingInboxMessage) -> DeliverOutcome {
    let url = format!("http://127.0.0.1:{}/api/inbox/drain", port);
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let message_id = message.message_id.clone();

    match client
        .post(&url)
        .json(&serde_json::json!({ "messages": [message] }))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                match resp.json::<DrainResponse>().await {
                    Ok(drain_resp) if !drain_resp.accepted => {
                        let reason = drain_resp.reason.unwrap_or_else(|| "unknown".to_string());
                        ulog_warn!(
                            "[inbox] target accepted HTTP but rejected message {}: {}",
                            message_id,
                            reason
                        );
                        DeliverOutcome::Rejected { reason }
                    }
                    _ => {
                        ulog_info!("[inbox] delivered msg_id={} (port {})", message_id, port);
                        DeliverOutcome::Delivered { message_id }
                    }
                }
            } else {
                let reason = format!("HTTP {}", status.as_u16());
                ulog_warn!(
                    "[inbox] delivery failed: {} (msg_id={})",
                    reason,
                    message_id
                );
                DeliverOutcome::DeliveryFailed { reason }
            }
        }
        Err(e) => {
            let reason = format!("network error: {}", e);
            ulog_error!(
                "[inbox] HTTP POST to {} failed: {} (msg_id={})",
                url,
                e,
                message_id
            );
            DeliverOutcome::DeliveryFailed { reason }
        }
    }
}

async fn http_post_fresh_start(
    port: u16,
    agent_id: &str,
    message: &PendingInboxMessage,
) -> Result<FreshStartTargetResponse, String> {
    let url = format!("http://127.0.0.1:{}/api/inbox/start", port);
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "agentId": agent_id,
            "message": message
        }))
        .send()
        .await
        .map_err(|error| format!("admission acknowledgement was not confirmed: {error}"))?;
    let status = response.status();
    let parsed = response
        .json::<FreshStartTargetResponse>()
        .await
        .map_err(|error| {
            format!(
                "admission acknowledgement was not confirmed (HTTP {}): {error}",
                status.as_u16()
            )
        })?;
    Ok(parsed)
}

/// Start a new Session under one Agent and wait only for target dispatch
/// acceptance. The lifecycle fence spans ID birth, ensure, admission,
/// BackgroundCompletion handoff, and transient-owner release.
pub async fn start_fresh_session(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    request: FreshSessionStartRequest,
) -> FreshSessionStartOutcome {
    let session_id = uuid::Uuid::new_v4().to_string();
    let message = PendingInboxMessage::new_request(
        request.from_session_id,
        request.from_label,
        session_id.clone(),
        request.prompt,
        request.reply_back,
    );
    let message_id = message.message_id.clone();
    let owner_id = format!("inbox-start-{}", uuid::Uuid::new_v4());
    let transient_owner = SidecarOwner::Agent(owner_id);
    let lifecycle =
        std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[&session_id]).await);

    let outcome = |status: &str, reason: Option<String>| FreshSessionStartOutcome {
        status: status.to_string(),
        agent_id: request.agent_id.clone(),
        session_id: session_id.clone(),
        message_id: message_id.clone(),
        reply_back: request.reply_back,
        reason,
    };

    let runtime_identity =
        crate::sidecar::resolve_agent_runtime_identity_by_id_from_config(&request.agent_id);
    let runtime_override = runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.clone());
    let runtime_source_override = runtime_identity
        .as_ref()
        .and_then(|identity| identity.runtime_source.clone());
    let ensure =
        crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
            lifecycle.clone(),
            app_handle.clone(),
            manager.clone(),
            session_id.clone(),
            std::path::PathBuf::from(&request.workspace_path),
            transient_owner.clone(),
            runtime_override,
            runtime_source_override,
        )
        .await;
    let port = match ensure {
        Ok(result) => result.port,
        Err(error) => {
            release_transient_owner(manager, &session_id, &transient_owner);
            return outcome(
                "delivery_failed",
                Some(format!("sidecar start failed: {error}")),
            );
        }
    };

    let target = http_post_fresh_start(port, &request.agent_id, &message).await;
    let result = match target {
        Ok(response) if response.accepted == Some(true) => {
            if start_headless_completion(app_handle, manager, &session_id) {
                outcome("accepted", None)
            } else {
                outcome(
                    "unconfirmed",
                    Some(
                        "dispatch was accepted but background completion ownership was not confirmed"
                            .to_string(),
                    ),
                )
            }
        }
        Ok(response) if response.accepted == Some(false) => outcome(
            "rejected",
            Some(
                response
                    .reason
                    .unwrap_or_else(|| "target rejected admission".to_string()),
            ),
        ),
        Ok(response) => {
            // ACK ambiguity deliberately has no durable retry protocol. Reuse
            // the existing headless completion owner when possible, return the
            // allocated IDs, and let callers inspect history without resending.
            let _ = start_headless_completion(app_handle, manager, &session_id);
            outcome(
                "unconfirmed",
                Some(response.reason.unwrap_or_else(|| {
                    "target could not confirm Runtime dispatch acceptance".to_string()
                })),
            )
        }
        Err(reason) => {
            let _ = start_headless_completion(app_handle, manager, &session_id);
            outcome("unconfirmed", Some(reason))
        }
    };
    // BackgroundCompletion, when attached, now owns the ordinary lifecycle.
    // No fresh-start-specific durable token or recovery state is introduced.
    release_transient_owner(manager, &session_id, &transient_owner);
    drop(lifecycle);
    result
}

/// Helper for the admin handler: ensure target sidecar exists (resume if dead),
/// then deliver. Returns the same DeliverOutcome.
///
/// Healthy reuse and dead-session resume share one transient Agent owner path.
/// The lifecycle fence covers lookup/ensure, delivery, BackgroundCompletion
/// handoff, and owner release so deletion cannot cross the delivery.
pub async fn deliver_with_resume(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
    resume_workspace_path: Option<std::path::PathBuf>,
) -> DeliverOutcome {
    let to_sid = message.to_session_id.clone();
    let owner_id = format!("inbox-deliver-{}", uuid::Uuid::new_v4());
    let transient_owner = SidecarOwner::Agent(owner_id.clone());
    let lifecycle =
        std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[&to_sid]).await);

    ulog_info!(
        "[inbox] delivering kind={:?} from={} to={} reply_back={} msg_id={} transient_owner={}",
        message.kind,
        message.from_session_id,
        to_sid,
        message.reply_back,
        message.message_id,
        owner_id
    );

    let healthy_port = manager.lock().ok().and_then(|mut sidecars| {
        sidecars.attach_owner_to_healthy_session(&to_sid, transient_owner.clone())
    });

    let port = if let Some(port) = healthy_port {
        port
    } else {
        let Some(workspace_path) = resume_workspace_path else {
            ulog_warn!(
                "[inbox] target {} not alive and no workspace_path provided — cannot resume",
                to_sid
            );
            return DeliverOutcome::SessionNotFound;
        };

        ulog_info!(
            "[inbox] resuming target session {} for inbox delivery (transient owner={})",
            to_sid,
            owner_id
        );

        let resume_result =
            crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
                lifecycle.clone(),
                app_handle.clone(),
                manager.clone(),
                to_sid.clone(),
                workspace_path,
                transient_owner.clone(),
                None,
                None,
            )
            .await;

        match resume_result {
            Ok(result) => {
                ulog_info!("[inbox] resume succeeded for {}", to_sid);
                result.port
            }
            Err(e) => {
                ulog_error!("[inbox] resume failed for {}: {}", to_sid, e);
                release_transient_owner(manager, &to_sid, &transient_owner);
                return DeliverOutcome::DeliveryFailed {
                    reason: format!("resume failed: {}", e),
                };
            }
        }
    };

    let outcome = http_post_drain(port, &message).await;
    start_headless_completion_if_delivered(app_handle, manager, &to_sid, &outcome);
    release_transient_owner(manager, &to_sid, &transient_owner);
    outcome
}

fn start_headless_completion_if_delivered(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    session_id: &str,
    outcome: &DeliverOutcome,
) {
    if !matches!(outcome, DeliverOutcome::Delivered { .. }) {
        return;
    }
    start_headless_completion(app_handle, manager, session_id);
}

fn start_headless_completion(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> bool {
    match crate::sidecar::start_headless_background_completion(app_handle, manager, session_id) {
        Ok(result) => {
            ulog_info!(
                "[inbox] headless BackgroundCompletion for {} started={}",
                session_id,
                result.started
            );
            result.started
        }
        Err(e) => {
            ulog_error!(
                "[inbox] failed to start headless BackgroundCompletion for {}: {}",
                session_id,
                e
            );
            false
        }
    }
}

/// Release the transient inbox-delivery owner. Idempotent — no-op if the
/// sidecar was already torn down or the owner was never inserted.
fn release_transient_owner(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) {
    match crate::sidecar::release_session_sidecar(manager, session_id, owner) {
        Ok(stopped) => {
            ulog_info!(
                "[inbox] released transient owner for {}; sidecar_stopped={}",
                session_id,
                stopped
            );
        }
        Err(e) => {
            ulog_warn!(
                "[inbox] cannot release transient owner for {}: {}",
                session_id,
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_start_request_uses_the_camel_case_management_contract() {
        let request = FreshSessionStartRequest {
            agent_id: "agent-1".to_string(),
            workspace_path: "/workspace".to_string(),
            from_session_id: "source-session".to_string(),
            from_label: "Source Agent".to_string(),
            prompt: "Review this".to_string(),
            reply_back: true,
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "agentId": "agent-1",
                "workspacePath": "/workspace",
                "fromSessionId": "source-session",
                "fromLabel": "Source Agent",
                "prompt": "Review this",
                "replyBack": true,
            })
        );
    }

    #[test]
    fn fresh_start_outcome_keeps_receipt_ids_for_unconfirmed_admission() {
        let outcome = FreshSessionStartOutcome {
            status: "unconfirmed".to_string(),
            agent_id: "agent-1".to_string(),
            session_id: "fresh-session".to_string(),
            message_id: "message-1".to_string(),
            reply_back: true,
            reason: Some("ACK lost".to_string()),
        };

        let value = serde_json::to_value(outcome).unwrap();
        assert_eq!(value["status"], "unconfirmed");
        assert_eq!(value["agentId"], "agent-1");
        assert_eq!(value["sessionId"], "fresh-session");
        assert_eq!(value["messageId"], "message-1");
        assert_eq!(value["replyBack"], true);
        assert_eq!(value["reason"], "ACK lost");
    }

    #[test]
    fn explicit_target_rejection_is_distinct_from_ack_loss() {
        let parsed: FreshStartTargetResponse = serde_json::from_value(serde_json::json!({
            "accepted": false,
            "reason": "runtime rejected dispatch"
        }))
        .unwrap();

        assert_eq!(parsed.accepted, Some(false));
        assert_eq!(parsed.reason.as_deref(), Some("runtime rejected dispatch"));
    }

    #[test]
    fn target_can_return_unconfirmed_admission_as_json_null() {
        let parsed: FreshStartTargetResponse = serde_json::from_value(serde_json::json!({
            "accepted": null,
            "unconfirmed": true,
            "reason": "termination could not be confirmed"
        }))
        .unwrap();

        assert_eq!(parsed.accepted, None);
        assert_eq!(
            parsed.reason.as_deref(),
            Some("termination could not be confirmed")
        );
    }
}
