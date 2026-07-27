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

use crate::sidecar::{ManagedSidecarManager, SidecarOwner, SidecarState};
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
    state: tauri::State<'_, ManagedSidecarManager>,
    message: PendingInboxMessage,
) -> Result<DeliverOutcome, String> {
    Ok(deliver_inbox_message(&state, message).await)
}

/// Look up target sidecar port. Returns None if no healthy sidecar exists.
fn lookup_target_port(manager: &ManagedSidecarManager, session_id: &str) -> Option<u16> {
    let guard = manager.lock().ok()?;
    let sidecar = guard.get_session_sidecar(session_id)?;
    if matches!(sidecar.state, SidecarState::Healthy) {
        Some(sidecar.port)
    } else {
        None
    }
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

/// Direct delivery — target sidecar must already be Healthy. Used when caller
/// knows target is alive (e.g. peer sidecar on same machine, no resume needed).
pub async fn deliver_inbox_message(
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
) -> DeliverOutcome {
    let to_sid = message.to_session_id.clone();

    ulog_info!(
        "[inbox] cmd_inbox_deliver kind={:?} from={} to={} reply_back={} msg_id={}",
        message.kind,
        message.from_session_id,
        to_sid,
        message.reply_back,
        message.message_id
    );

    let Some(port) = lookup_target_port(manager, &to_sid) else {
        ulog_warn!("[inbox] target session {} has no healthy sidecar", to_sid);
        return DeliverOutcome::SessionNotFound;
    };

    http_post_drain(port, &message).await
}

/// Helper for the admin handler: ensure target sidecar exists (resume if dead),
/// then deliver. Returns the same DeliverOutcome.
///
/// **Owner lifecycle (review-by-architecture + review-by-cc + review-by-codex
/// all flagged this):** when we spawn a sidecar to deliver to a dead session,
/// we attach a transient Tab owner. That owner MUST be released after delivery
/// regardless of outcome — otherwise the resumed sidecar stays alive forever.
/// We use a uuid-stamped owner id so concurrent inbox deliveries don't share
/// owner identity, and release it in a guaranteed-fired cleanup.
///
/// NOTE: ensure_session_sidecar uses blocking reqwest internally, so we wrap
/// in spawn_blocking. Owner release is also sync (manager.lock).
pub async fn deliver_with_resume(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
    resume_workspace_path: Option<std::path::PathBuf>,
) -> DeliverOutcome {
    let to_sid = message.to_session_id.clone();

    // Quick alive check first — if Healthy, skip resume + owner machinery.
    if lookup_target_port(manager, &to_sid).is_some() {
        let outcome = deliver_inbox_message(manager, message).await;
        start_headless_completion_if_delivered(app_handle, manager, &to_sid, &outcome);
        return outcome;
    }

    // Target not alive — need to resume. Require workspace_path.
    let Some(workspace_path) = resume_workspace_path else {
        ulog_warn!(
            "[inbox] target {} not alive and no workspace_path provided — cannot resume",
            to_sid
        );
        return DeliverOutcome::SessionNotFound;
    };

    // Unique transient owner id so two concurrent inbox deliveries to the same
    // dead session each track + release their own owner without stepping on
    // each other (owners are a HashSet; identical owner ids would merge, and
    // releasing one would orphan the other).
    let owner_id = format!("inbox-deliver-{}", uuid::Uuid::new_v4());
    let transient_owner = SidecarOwner::Tab(owner_id.clone());

    ulog_info!(
        "[inbox] resuming target session {} for inbox delivery (transient owner={})",
        to_sid,
        owner_id
    );

    let resume_result = crate::sidecar::ensure_session_sidecar_with_lifecycle(
        app_handle.clone(),
        manager.clone(),
        to_sid.clone(),
        workspace_path,
        transient_owner.clone(),
    )
    .await;

    match resume_result {
        Ok(_) => {
            ulog_info!("[inbox] resume succeeded for {}", to_sid);
        }
        Err(e) => {
            ulog_error!("[inbox] resume failed for {}: {}", to_sid, e);
            // ensure_session_sidecar may have inserted the owner on a partial
            // failure path; release defensively (idempotent — no-op if absent).
            release_transient_owner(manager, &to_sid, &transient_owner);
            return DeliverOutcome::DeliveryFailed {
                reason: format!("resume failed: {}", e),
            };
        }
    }

    // Deliver — and ALWAYS release the transient owner afterwards (guarantees
    // the resumed sidecar doesn't stay alive forever if no real owner attached
    // during the brief window). Real owners (Tab/Task/Goal/Agent/BackgroundCompletion)
    // that arrive during the resume window keep the sidecar alive — release_owner
    // is idempotent per-owner-id.
    let outcome = deliver_inbox_message(manager, message).await;
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
    match crate::sidecar::start_headless_background_completion(app_handle, manager, session_id) {
        Ok(result) => {
            ulog_info!(
                "[inbox] headless BackgroundCompletion for {} started={}",
                session_id,
                result.started
            );
        }
        Err(e) => {
            ulog_error!(
                "[inbox] failed to start headless BackgroundCompletion for {}: {}",
                session_id,
                e
            );
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
