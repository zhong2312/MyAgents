// Internal Management API for Bun Sidecar → Rust IPC
// Provides HTTP endpoints on localhost for cron task management
// Only accessible from 127.0.0.1 (Bun Sidecar processes)

use axum::{
    extract::{DefaultBodyLimit, Query},
    http::{header::CACHE_CONTROL, HeaderMap, HeaderValue},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::net::TcpListener;

use crate::cron_task::{
    self, CronDelivery, CronSchedule, CronTask, CronTaskConfig, ProviderIntent, TaskProviderEnv,
};
use crate::im::adapter::{ImAdapter, ImStreamAdapter};
use crate::im::bridge;
use crate::im::types::MediaType;
use crate::im::{self, ManagedAgents, ManagedImBots};
use crate::session_goal::{
    self, GoalEndConditions, GoalMutationError, GoalStatus, GoalTurnFinalizationRequest,
    GoalTurnKind, SessionGoal, SessionGoalConfig,
};
use crate::task;
use crate::thought;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Global IM bots state (set once at startup for wake endpoint)
static IM_BOTS_STATE: OnceLock<ManagedImBots> = OnceLock::new();

/// Global Agent state (set once at startup)
static AGENT_STATE: OnceLock<ManagedAgents> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Set the IM bots state for the management API (called once at startup)
pub fn set_im_bots_state(bots: ManagedImBots) {
    let _ = IM_BOTS_STATE.set(bots);
}

/// Set the Agent state for the management API (called once at startup)
pub fn set_agent_state(agents: ManagedAgents) {
    let _ = AGENT_STATE.set(agents);
}

fn get_im_bots() -> Option<&'static ManagedImBots> {
    IM_BOTS_STATE.get()
}

fn get_agents() -> Option<&'static ManagedAgents> {
    AGENT_STATE.get()
}

/// Global Sidecar manager state (set once at startup)
static SIDECAR_STATE: OnceLock<crate::sidecar::ManagedSidecarManager> = OnceLock::new();

/// Set the SidecarManager state for the management API (called once at startup)
pub fn set_sidecar_state(state: crate::sidecar::ManagedSidecarManager) {
    let _ = SIDECAR_STATE.set(state);
}

fn get_sidecar_state() -> Option<&'static crate::sidecar::ManagedSidecarManager> {
    SIDECAR_STATE.get()
}

fn request_sidecar_generation(headers: &HeaderMap) -> Result<u64, Json<serde_json::Value>> {
    let generation = headers
        .get("x-myagents-sidecar-generation")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    generation.ok_or_else(|| {
        Json(serde_json::json!({
            "ok": false,
            "code": "invalid_request",
            "error": "A valid Sidecar generation is required",
        }))
    })
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars
pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    let app = Router::new()
        .route("/api/app/config-changed", post(app_config_changed_handler))
        .route("/api/cron/create", post(create_cron_handler))
        .route("/api/cron/list", get(list_cron_handler))
        .route("/api/cron/update", post(update_cron_handler))
        .route("/api/cron/delete", post(delete_cron_handler))
        .route("/api/cron/run", post(run_cron_handler))
        .route("/api/cron/trigger", post(trigger_cron_handler))
        .route("/api/cron/runs", get(runs_cron_handler))
        .route("/api/cron/status", get(status_cron_handler))
        .route("/api/goal/get", get(goal_get_handler))
        .route("/api/goal/create", post(goal_create_handler))
        .route("/api/goal/turn/claim", post(goal_turn_claim_handler))
        .route("/api/goal/turn/finalize", post(goal_turn_finalize_handler))
        .route("/api/goal/turn/abort", post(goal_turn_abort_handler))
        .route("/api/goal/turn/pause", post(goal_turn_pause_handler))
        .route("/api/goal/objective", post(goal_objective_handler))
        .route("/api/goal/update", post(goal_update_handler))
        .route(
            "/api/mcp/remove-references",
            post(remove_mcp_references_handler),
        )
        .route("/api/im/channels", get(list_im_channels_handler))
        .route("/api/im/wake", post(wake_bot_handler))
        .route("/api/im/send-media", post(send_media_handler))
        .route("/api/im/mirror", post(mirror_to_channel_handler))
        .route("/api/im-bridge/message", post(handle_bridge_message))
        .route("/api/cron/stop", post(stop_cron_handler))
        .route("/api/plugin/list", get(list_plugins_handler))
        .route("/api/plugin/install", post(install_plugin_handler))
        .route("/api/plugin/uninstall", post(uninstall_plugin_handler))
        .route(
            "/api/agent/runtime-status",
            get(agent_runtime_status_handler),
        )
        .route(
            "/api/agent/reload-config",
            post(agent_reload_config_handler),
        )
        .route(
            "/api/agent/stop-channels",
            post(agent_stop_channels_handler),
        )
        // Task Center (v0.1.69) — HTTP surface for the `myagents task` CLI.
        .route("/api/task/list", get(task_list_handler))
        .route("/api/task/get", get(task_get_handler))
        .route("/api/task/create-direct", post(task_create_direct_handler))
        .route(
            "/api/task/create-from-alignment",
            post(task_create_from_alignment_handler),
        )
        .route(
            "/api/task/create-attached",
            post(task_create_attached_handler),
        )
        .route("/api/task/update", post(task_update_handler))
        .route("/api/task/update-status", post(task_update_status_handler))
        .route(
            "/api/task/turn/authorize",
            post(task_turn_authorize_handler),
        )
        .route(
            "/api/task/append-session",
            post(task_append_session_handler),
        )
        .route("/api/task/archive", post(task_archive_handler))
        .route("/api/task/delete", post(task_delete_handler))
        .route("/api/task/run", post(task_run_handler))
        .route("/api/task/rerun", post(task_rerun_handler))
        .route("/api/task/read-doc", get(task_read_doc_handler))
        .route("/api/task/write-doc", post(task_write_doc_handler))
        .route("/api/thought/list", get(thought_list_handler))
        .route("/api/thought/create", post(thought_create_handler))
        .route("/api/space/list", post(space_list_handler))
        .route("/api/space/whoami", post(space_whoami_handler))
        .route(
            "/api/space/assignee-list",
            post(space_assignee_list_handler),
        )
        .route("/api/space/goal-list", post(space_goal_list_handler))
        .route("/api/space/issue-create", post(space_issue_create_handler))
        .route("/api/space/issue-update", post(space_issue_update_handler))
        .route("/api/space/issue-list", post(space_issue_list_handler))
        .route("/api/space/issue-get", post(space_issue_get_handler))
        .route(
            "/api/space/issue-comment",
            post(space_issue_comment_handler),
        )
        .route(
            "/api/space/issue-comments",
            post(space_issue_comments_handler),
        )
        .route(
            "/api/space/issue-comment-get",
            post(space_issue_comment_get_handler),
        )
        .route("/api/space/issue-status", post(space_issue_status_handler))
        .route("/api/space/issue-claim", post(space_issue_claim_handler))
        .route("/api/space/issue-close", post(space_issue_close_handler))
        .route(
            "/api/space/issue-complete",
            post(space_issue_complete_handler),
        )
        .route(
            "/api/space/issue-cancel-claim",
            post(space_issue_cancel_claim_handler),
        )
        .route(
            "/api/space/claim-local-task",
            post(space_claim_local_task_handler),
        )
        .route(
            "/api/space/attachment-download",
            post(space_attachment_download_handler),
        )
        .route(
            "/api/space/attachment-add",
            post(space_attachment_add_handler),
        )
        .route(
            "/api/space/attachment-inspect",
            post(space_attachment_inspect_handler),
        )
        // Session Inbox cross-sidecar delivery (PRD 0.2.18)
        .route("/api/inbox/deliver", post(inbox_deliver_handler))
        // Session Event watch registration (PRD 0.2.37)
        .route("/api/session/watch", post(session_watch_handler))
        // Secret-bearing internal route. Identity is validated against the
        // live Session:Sidecar generation; responses are never cacheable.
        .route("/api/grok/bearer", post(grok_bearer_handler))
        // Bridge messages carry base64-encoded media attachments (images/files).
        // Default axum 2MB limit is too small — raise to 50MB for this API.
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            ulog_error!("[management-api] Server error: {}", e);
        }
    });

    ulog_info!("[management-api] Started on http://127.0.0.1:{}", port);
    Ok(port)
}

/// Fan a disk-backed AppConfig invalidation out to every renderer window.
/// The payload intentionally contains no config fields because config.json may
/// contain credentials; renderers re-read the authorities after this signal.
async fn app_config_changed_handler() -> Json<serde_json::Value> {
    let Some(app_handle) = crate::logger::get_app_handle() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "App handle is not initialized",
        }));
    };
    match app_handle.emit("app:config-changed", ()) {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(error) => {
            ulog_warn!("[management] Failed to emit app:config-changed: {}", error);
            Json(serde_json::json!({
                "ok": false,
                "error": error.to_string(),
            }))
        }
    }
}

fn no_store_json(value: serde_json::Value) -> (HeaderMap, Json<serde_json::Value>) {
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, Json(value))
}

fn sidecar_identity_matches(current_generation: Option<u64>, requested_generation: u64) -> bool {
    current_generation == Some(requested_generation)
}

async fn grok_bearer_handler(
    headers: HeaderMap,
    Json(req): Json<crate::grok_auth::types::ManagementBearerRequest>,
) -> (HeaderMap, Json<serde_json::Value>) {
    let session_id = req.session_id.trim();
    if session_id.is_empty() {
        return no_store_json(serde_json::json!({
            "ok": false,
            "code": "invalid_request",
            "error": "sessionId is required",
        }));
    }
    let generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(Json(value)) => return no_store_json(value),
    };
    let Some(sidecars) = get_sidecar_state() else {
        return no_store_json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    let current_generation = sidecars
        .lock()
        .ok()
        .and_then(|manager| manager.generation_for(session_id));
    let is_current = sidecar_identity_matches(current_generation, generation);
    if !is_current {
        return no_store_json(serde_json::json!({
            "ok": false,
            "code": "stale_sidecar",
            "error": "Sidecar identity is no longer current",
        }));
    }

    let bearer_purpose = match req.purpose.as_deref().unwrap_or("execution") {
        "execution" => Ok(crate::grok_auth::types::ResolveBearerPurpose::Execution),
        "verification" => req
            .expected_lineage
            .as_ref()
            .filter(|lineage| !lineage.trim().is_empty())
            .map(
                |lineage| crate::grok_auth::types::ResolveBearerPurpose::Verification {
                    expected_lineage: lineage.clone(),
                },
            )
            .ok_or_else(|| {
                crate::grok_auth::types::GrokAuthError::new(
                    crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
                    "expectedLineage is required for verification",
                )
            }),
        _ => Err(crate::grok_auth::types::GrokAuthError::new(
            crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
            "Unsupported Grok bearer purpose",
        )),
    };

    let result = match req.reason.as_deref().unwrap_or("request") {
        "request" => match bearer_purpose.clone() {
            Ok(purpose) => crate::grok_auth::resolve_bearer_for_sidecar(
                crate::grok_auth::types::ResolveBearerReason::Request,
                None,
                purpose,
            )
            .await
            .map(Some),
            Err(error) => Err(error),
        },
        "auth_recovery" => match req.rejected_credential_version {
            Some(version) => match bearer_purpose {
                Ok(purpose) => crate::grok_auth::resolve_bearer_for_sidecar(
                    crate::grok_auth::types::ResolveBearerReason::AuthRecovery,
                    Some(version),
                    purpose,
                )
                .await
                .map(Some),
                Err(error) => Err(error),
            },
            None => Err(crate::grok_auth::types::GrokAuthError::new(
                crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
                "rejectedCredentialVersion is required",
            )),
        },
        "reject" => match req.rejected_credential_version {
            Some(version) => crate::grok_auth::reject_credential_for_sidecar(version)
                .await
                .map(|()| None),
            None => Err(crate::grok_auth::types::GrokAuthError::new(
                crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
                "rejectedCredentialVersion is required",
            )),
        },
        "report" => match (req.rejected_credential_version, req.http_status) {
            (Some(version), Some(status)) => {
                crate::grok_auth::record_upstream_outcome_for_sidecar(version, status)
                    .await
                    .map(|()| None)
            }
            _ => Err(crate::grok_auth::types::GrokAuthError::new(
                crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
                "rejectedCredentialVersion and httpStatus are required",
            )),
        },
        _ => Err(crate::grok_auth::types::GrokAuthError::new(
            crate::grok_auth::types::GrokAuthErrorCode::InvalidResponse,
            "Unsupported Grok bearer resolution reason",
        )),
    };

    match result {
        Ok(Some(resolved)) => no_store_json(serde_json::json!({
            "ok": true,
            "accessToken": resolved.access_token,
            "credentialVersion": resolved.credential_version,
        })),
        Ok(None) => no_store_json(serde_json::json!({ "ok": true })),
        Err(error) => no_store_json(serde_json::json!({
            "ok": false,
            "error": error,
        })),
    }
}

// ===== Request / Response types =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCronRequest {
    name: Option<String>,
    schedule: Option<CronSchedule>,
    message: String,
    session_target: Option<String>, // "new_session" | "single_session"
    source_bot_id: Option<String>,
    delivery: Option<CronDelivery>,
    workspace_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-cron provider id. Preferred over `provider_env` for
    /// all new callers; sidecar live-resolves env on every tick. Mutually
    /// exclusive with `provider_env` (an explicit-snapshot legacy path that
    /// still works for tasks persisted in 0.2.8 and earlier).
    provider_id: Option<String>,
    /// PRD #119: explicit routing intent. Frontend / IM Bot / CLI callers
    /// that know what they want should set this to `Subscription` or
    /// `Explicit`. Absent → `FollowAgent` (legacy snapshot semantics).
    /// PRD 0.2.9 — when `provider_id` is set, intent is ignored.
    provider_intent: Option<ProviderIntent>,
    runtime: Option<String>,
    runtime_config: Option<serde_json::Value>,
    /// Fallback interval if no schedule provided
    interval_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CreateCronResponse {
    task_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCronQuery {
    source_bot_id: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMcpReferencesRequest {
    server_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMcpReferencesResponse {
    ok: bool,
    task_updated: usize,
    cron_updated: usize,
}

// ListCronResponse removed — list_cron_handler now returns serde_json::Value
// with explicit { "ok": true, "tasks": [...] } for Admin API forwarding compatibility.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskSummary {
    id: String,
    name: Option<String>,
    prompt: String,
    status: String,
    schedule: Option<CronSchedule>,
    interval_minutes: u32,
    execution_count: u32,
    last_executed_at: Option<String>,
    created_at: String,
    /// Computed next-fire time (Rust enriches at read; never persisted).
    /// PRD 0.2.5 R6 — exposed for `cron list` Next column.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_execution_at: Option<String>,
    /// Last run success flag — denormalized from `cron_runs/<id>.jsonl`.
    /// PRD 0.2.5 R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_ok: Option<bool>,
    /// Last run duration in milliseconds — same denormalization as above.
    /// PRD 0.2.5 R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_duration_ms: Option<u64>,
    /// PRD 0.2.5 R9 — transient flag: a tick (scheduled or run-now) is
    /// firing this very instant. Distinct from `status`: a task can be
    /// `status: Running` (scheduler enabled, not currently firing) or
    /// `status: Running, currently_executing: true` (scheduler enabled
    /// AND a tick is in flight). Populated by the list handler from
    /// `executing_tasks`; not persisted. Default false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    currently_executing: bool,
    /// Internal system-managed task marker. Ordinary UI lists use this to hide
    /// Evo maintenance tasks while keeping session history/audit rows intact.
    #[serde(skip_serializing_if = "Option::is_none")]
    managed_kind: Option<String>,
}

impl From<CronTask> for CronTaskSummary {
    fn from(t: CronTask) -> Self {
        // Status field carries the raw `TaskStatus` enum name
        // ("Running" / "Stopped") — matches enum, persistence, Tauri IPC,
        // and frontend. The persistent state and the transient
        // "currently executing" state are SEPARATE concepts; the latter
        // is surfaced via `currently_executing` populated by the list
        // handler (PRD 0.2.5 R9 — vocabulary clarification).
        Self {
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            status: serde_json::to_value(&t.status)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown".to_string()),
            schedule: t.schedule,
            interval_minutes: t.interval_minutes,
            execution_count: t.execution_count,
            last_executed_at: t.last_executed_at.map(|dt| dt.to_rfc3339()),
            created_at: t.created_at.to_rfc3339(),
            next_execution_at: t.next_execution_at,
            last_run_ok: t.last_run_ok,
            last_run_duration_ms: t.last_run_duration_ms,
            // Default false — list_cron_handler post-processes to set true
            // for ids in the executing snapshot. Single-task projections
            // (e.g. /api/cron/run) don't need this.
            currently_executing: false,
            managed_kind: t.managed_kind,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCronRequest {
    task_id: String,
    patch: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const MANAGED_CRON_TASK_ERROR: &str =
    "Managed scheduled jobs are internal and cannot be managed from ordinary CronTask surfaces";
const LEGACY_LOOP_READ_ONLY_ERROR: &str = "Legacy Loop records are read-only and are never resumed";

fn is_managed_cron_task(task: &CronTask) -> bool {
    task.managed_kind
        .as_deref()
        .is_some_and(crate::task::is_supported_managed_kind)
}

async fn get_ordinary_cron_task(
    manager: &cron_task::CronTaskManager,
    task_id: &str,
) -> Result<CronTask, String> {
    let task = manager
        .get_task(task_id)
        .await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;
    if is_managed_cron_task(&task) {
        return Err(MANAGED_CRON_TASK_ERROR.to_string());
    }
    if matches!(&task.schedule, Some(CronSchedule::Loop)) {
        return Err(LEGACY_LOOP_READ_ONLY_ERROR.to_string());
    }
    Ok(task)
}

fn managed_api_response() -> ApiResponse {
    ApiResponse {
        ok: false,
        error: Some(MANAGED_CRON_TASK_ERROR.to_string()),
    }
}

fn managed_json_response() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": MANAGED_CRON_TASK_ERROR,
    })
}

// ===== Handlers =====

async fn remove_mcp_references_handler(
    Json(req): Json<RemoveMcpReferencesRequest>,
) -> Json<serde_json::Value> {
    if req.server_id.trim().is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "serverId is required",
        }));
    }

    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Task store is not initialized",
        }));
    };

    let task_updated = match task_store
        .remove_mcp_server_references(&req.server_id)
        .await
    {
        Ok(count) => count,
        Err(error) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Task cleanup failed: {}", error),
            }));
        }
    };

    let cron_updated = 0;

    Json(
        serde_json::to_value(RemoveMcpReferencesResponse {
            ok: true,
            task_updated,
            cron_updated,
        })
        .unwrap_or_else(|_| {
            serde_json::json!({
                "ok": true,
                "taskUpdated": task_updated,
                "cronUpdated": cron_updated,
            })
        }),
    )
}

async fn create_cron_handler(Json(req): Json<CreateCronRequest>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    if matches!(&req.schedule, Some(CronSchedule::Loop)) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Loop scheduling is retired; create a Session Goal for persistent work",
        }));
    }
    let run_mode = match req.session_target.as_deref() {
        Some("single_session") => cron_task::RunMode::SingleSession,
        _ => cron_task::RunMode::NewSession,
    };

    let interval_minutes = match &req.schedule {
        Some(CronSchedule::Every { minutes, .. }) => *minutes,
        Some(CronSchedule::At { .. }) => 60, // placeholder, not used for one-shot
        Some(CronSchedule::Cron { .. }) => 60, // placeholder, calculated by cron expression
        Some(CronSchedule::Loop) => unreachable!("Loop was rejected above"),
        None => req.interval_minutes.unwrap_or(30),
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let config = CronTaskConfig {
        workspace_path: req.workspace_path,
        session_id,
        prompt: req.message,
        interval_minutes: interval_minutes.max(5),
        end_conditions: Default::default(),
        run_mode,
        notify_enabled: true,
        tab_id: None,
        // PRD 0.2.5 R2/R3 — empty string is the sentinel for "user didn't pick →
        // resolve to runtime max at execute time". Pre-v0.2.5 this field
        // silently defaulted to "auto", which the cron resolver respects
        // literally as acceptEdits and breaks unattended runs.
        permission_mode: req.permission_mode.unwrap_or_default(),
        model: req.model,
        provider_env: req.provider_env,
        provider_id: req.provider_id,
        provider_intent: req.provider_intent.unwrap_or_default(),
        runtime: req.runtime,
        runtime_config: req.runtime_config,
        // Direct cron creation (legacy IM Bot path) doesn't carry a Task
        // parent — MCP override stays None (= follow workspace).
        mcp_enabled_servers: None,
        managed_kind: None,
        source_bot_id: req.source_bot_id,
        delivery: req.delivery,
        schedule: req.schedule,
        name: req.name,
    };

    match manager.create_task(config).await {
        Ok(task) => {
            // Auto-start the task
            let task_id = task.id.clone();
            if let Err(error) = manager.start_task(&task_id).await {
                ulog_warn!(
                    "[management-api] Created task {} but failed to start: {}",
                    task_id,
                    error
                );
                return Json(serde_json::json!({
                    "ok": false,
                    "taskId": task_id,
                    "error": format!("Task was created but could not be scheduled: {error}"),
                }));
            }

            // Fetch enriched task to get computed nextExecutionAt
            let next_exec = manager
                .get_task(&task_id)
                .await
                .and_then(|t| t.next_execution_at);

            Json(serde_json::json!({
                "ok": true,
                "taskId": task.id,
                "status": "running",
                "nextExecutionAt": next_exec
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e
        })),
    }
}

async fn list_cron_handler(Query(query): Query<ListCronQuery>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let mut tasks = if let Some(bot_id) = &query.source_bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &query.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };
    tasks.retain(|t| !is_managed_cron_task(t));

    // PRD 0.2.5 R9 — single snapshot of "currently executing" set, applied
    // to all summaries. Avoids N separate lock acquisitions; correct for
    // a moment-in-time read (the field is transient by design).
    let executing = manager.executing_snapshot().await;
    let summaries: Vec<CronTaskSummary> = tasks
        .into_iter()
        .map(|t| {
            let is_executing = executing.contains(&t.id);
            let mut summary = CronTaskSummary::from(t);
            summary.currently_executing = is_executing;
            summary
        })
        .collect();
    Json(serde_json::json!({ "ok": true, "tasks": summaries }))
}

async fn update_cron_handler(Json(req): Json<UpdateCronRequest>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    if let Err(e) = get_ordinary_cron_task(manager, &req.task_id).await {
        return Json(serde_json::json!({
            "ok": false,
            "error": e,
        }));
    }

    match manager.update_task_fields(&req.task_id, req.patch).await {
        Ok(updated) => {
            // Issue #115 — return the enriched task so callers can echo
            // the post-update `nextExecutionAt` + tz. CLI uses this to
            // print "next fire: <local time>" right after `✓ update`,
            // which prevents the strict-after-now confusion users hit
            // when reading the bare UTC value in a later `cron list`.
            let summary = CronTaskSummary::from(updated);
            Json(serde_json::json!({
                "ok": true,
                "task": summary,
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e,
        })),
    }
}

async fn delete_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();
    if let Err(e) = get_ordinary_cron_task(manager, &req.task_id).await {
        if e == MANAGED_CRON_TASK_ERROR {
            return Json(managed_api_response());
        }
        return Json(ApiResponse {
            ok: false,
            error: Some(e),
        });
    }

    // Stop first if running
    let _ = manager
        .stop_task(&req.task_id, Some("Deleted via management API".to_string()))
        .await;

    match manager.delete_task(&req.task_id).await {
        Ok(()) => Json(ApiResponse {
            ok: true,
            error: None,
        }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn run_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Check task exists
    let task = match get_ordinary_cron_task(manager, &req.task_id).await {
        Ok(t) => t,
        Err(e) => {
            return Json(ApiResponse {
                ok: false,
                error: Some(e),
            });
        }
    };

    // If task is stopped, start it first
    if task.status == cron_task::TaskStatus::Stopped {
        if let Err(e) = manager.start_task(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start task: {}", e)),
            });
        }
    }

    Json(ApiResponse {
        ok: true,
        error: None,
    })
}

/// PRD 0.2.5 R4 — POST /api/cron/trigger
/// Fire one immediate execution of an existing cron task without modifying
/// its schedule or status. Fire-and-forget: returns as soon as the dispatch
/// kicks off (does NOT wait for the AI to finish).
async fn trigger_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    if let Err(e) = get_ordinary_cron_task(manager, &req.task_id).await {
        return Json(serde_json::json!({
            "ok": false,
            "error": e,
        }));
    }
    match manager.trigger_now(&req.task_id).await {
        Ok(info) => Json(serde_json::json!({
            "ok": true,
            "taskId": info.task_id,
            "sessionId": info.session_id,
            "dispatchedAt": info.dispatched_at,
        })),
        Err(e) => {
            let is_conflict = e.contains("currently executing");
            // 409 semantics for "task busy"; 404/500 fall through to the
            // generic ApiResponse shape consumers already understand.
            if is_conflict {
                Json(serde_json::json!({
                    "ok": false,
                    "error": e,
                    "code": "task_busy",
                }))
            } else {
                Json(serde_json::json!({
                    "ok": false,
                    "error": e,
                }))
            }
        }
    }
}

// ===== Runs / Status / Wake handlers =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunsQuery {
    task_id: String,
    limit: Option<usize>,
}

async fn runs_cron_handler(Query(params): Query<RunsQuery>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    if let Err(e) = get_ordinary_cron_task(manager, &params.task_id).await {
        if e == MANAGED_CRON_TASK_ERROR {
            return Json(managed_json_response());
        }
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    let limit = params.limit.unwrap_or(20);
    let runs = cron_task::read_cron_runs(&params.task_id, limit);
    Json(serde_json::json!({ "ok": true, "runs": runs }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    bot_id: Option<String>,
    workspace_path: Option<String>,
}

async fn status_cron_handler(Query(params): Query<StatusQuery>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    let mut tasks = if let Some(bot_id) = &params.bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &params.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };
    tasks.retain(|task| !is_managed_cron_task(task));

    let total = tasks.len();
    let running = tasks
        .iter()
        .filter(|t| t.status == cron_task::TaskStatus::Running)
        .count();
    let last_executed = tasks.iter().filter_map(|t| t.last_executed_at).max();
    let next_execution = tasks
        .iter()
        .filter_map(|t| t.next_execution_at.clone())
        .min();

    Json(serde_json::json!({
        "ok": true,
        "totalTasks": total,
        "runningTasks": running,
        "lastExecutedAt": last_executed,
        "nextExecutionAt": next_execution,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalSessionQuery {
    session_id: String,
    workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalCreateRequest {
    session_id: String,
    workspace_path: String,
    objective: String,
    #[serde(default)]
    end_conditions: GoalEndConditions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalUpdateRequest {
    session_id: String,
    workspace_path: Option<String>,
    goal_id: String,
    status: String,
    reason: Option<String>,
    queue_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalTurnClaimRequest {
    session_id: String,
    workspace_path: Option<String>,
    goal_id: String,
    queue_id: String,
    kind: String,
    expected_control_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalTurnFinalizeRequest {
    session_id: String,
    workspace_path: Option<String>,
    goal_id: String,
    queue_id: String,
    success: bool,
    error: Option<String>,
    output_text: Option<String>,
    #[serde(default)]
    duration_ms: u64,
    #[serde(default)]
    consumed_tokens: u64,
    #[serde(default)]
    channel_delivery_expected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalTurnIdentityRequest {
    session_id: String,
    workspace_path: Option<String>,
    goal_id: String,
    queue_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalObjectiveRequest {
    session_id: String,
    workspace_path: Option<String>,
    goal_id: String,
    objective: String,
    expected_revision: u64,
}

fn goal_to_json(goal: &SessionGoal) -> serde_json::Value {
    serde_json::to_value(goal.view()).unwrap_or(serde_json::Value::Null)
}

fn goal_error_json(error: GoalMutationError, goal: Option<SessionGoal>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": false,
        "code": error.code(),
        "error": error.to_string(),
        "goal": goal.as_ref().map(goal_to_json),
    }))
}

async fn goal_snapshot(
    manager: &session_goal::SessionGoalManager,
    goal_id: &str,
) -> Option<SessionGoal> {
    manager.get(goal_id).await.ok().flatten()
}

async fn validate_goal_identity(
    manager: &session_goal::SessionGoalManager,
    session_id: &str,
    workspace_path: Option<&str>,
    goal_id: &str,
) -> Result<SessionGoal, GoalMutationError> {
    let Some(goal) = manager.get(goal_id).await? else {
        return Err(GoalMutationError::goal_changed("Goal identity changed"));
    };
    let workspace_matches = match workspace_path {
        Some(workspace) => {
            crate::workspace_path::normalize_workspace_path_identity(&goal.workspace_path)
                == crate::workspace_path::normalize_workspace_path_identity(workspace)
        }
        None => true,
    };
    if goal.session_id != session_id || !workspace_matches {
        return Err(GoalMutationError::goal_changed("Goal identity changed"));
    }
    Ok(goal)
}

async fn goal_turn_claim_handler(
    headers: HeaderMap,
    Json(req): Json<GoalTurnClaimRequest>,
) -> Json<serde_json::Value> {
    let session_id = req.session_id.trim();
    let goal_id = req.goal_id.trim();
    let queue_id = req.queue_id.trim();
    if session_id.is_empty() || goal_id.is_empty() || queue_id.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "code": "invalid_request",
            "error": "sessionId, goalId, and queueId are required",
        }));
    }
    let kind = match req.kind.as_str() {
        "user_query" => GoalTurnKind::UserQuery,
        "continuation" => GoalTurnKind::Continuation,
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "code": "invalid_request",
                "error": "kind must be user_query or continuation",
            }));
        }
    };
    let manager = session_goal::get_session_goal_manager();
    let goal = match find_current_goal(manager, session_id, req.workspace_path.as_deref()).await {
        Ok(Some(goal)) => goal,
        Ok(None) => {
            return goal_error_json(
                GoalMutationError::terminal("No active Goal in current session"),
                None,
            );
        }
        Err(error) => return goal_error_json(error, None),
    };
    if goal.id != goal_id {
        return goal_error_json(
            GoalMutationError::goal_changed("Goal identity changed before turn admission"),
            Some(goal),
        );
    }
    let sidecar_generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let Some(sidecars) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    match manager
        .claim_turn_from_sidecar(
            goal_id,
            queue_id,
            kind,
            req.expected_control_revision,
            session_id,
            sidecar_generation,
            sidecars,
        )
        .await
    {
        Ok((goal, authority)) => Json(serde_json::json!({
            "ok": true,
            "goal": goal_to_json(&goal),
            "turn": {
                "queueId": authority.queue_id,
                "turnNumber": authority.turn_number,
            },
        })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, goal_id).await),
    }
}

async fn goal_turn_finalize_handler(
    headers: HeaderMap,
    Json(req): Json<GoalTurnFinalizeRequest>,
) -> Json<serde_json::Value> {
    let manager = session_goal::get_session_goal_manager();
    if let Err(error) = validate_goal_identity(
        manager,
        &req.session_id,
        req.workspace_path.as_deref(),
        &req.goal_id,
    )
    .await
    {
        return goal_error_json(error, goal_snapshot(manager, &req.goal_id).await);
    }
    let sidecar_generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let Some(sidecars) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    match manager
        .finalize_turn_from_sidecar(
            &req.goal_id,
            &req.queue_id,
            GoalTurnFinalizationRequest {
                success: req.success,
                error: req.error,
                output_text: req.output_text,
                duration_ms: req.duration_ms,
                consumed_tokens: req.consumed_tokens,
                channel_delivery_expected: req.channel_delivery_expected,
            },
            sidecar_generation,
            sidecars,
        )
        .await
    {
        Ok(finalization) => Json(serde_json::json!({
            "ok": true,
            "goal": goal_to_json(&finalization.goal),
            "applied": finalization.applied,
        })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, &req.goal_id).await),
    }
}

async fn goal_turn_abort_handler(
    Json(req): Json<GoalTurnIdentityRequest>,
) -> Json<serde_json::Value> {
    let manager = session_goal::get_session_goal_manager();
    if let Err(error) = validate_goal_identity(
        manager,
        &req.session_id,
        req.workspace_path.as_deref(),
        &req.goal_id,
    )
    .await
    {
        return goal_error_json(error, goal_snapshot(manager, &req.goal_id).await);
    }
    match manager.abort_turn(&req.goal_id, &req.queue_id).await {
        Ok(goal) => Json(serde_json::json!({ "ok": true, "goal": goal_to_json(&goal) })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, &req.goal_id).await),
    }
}

async fn goal_turn_pause_handler(
    headers: HeaderMap,
    Json(req): Json<GoalTurnIdentityRequest>,
) -> Json<serde_json::Value> {
    let manager = session_goal::get_session_goal_manager();
    if let Err(error) = validate_goal_identity(
        manager,
        &req.session_id,
        req.workspace_path.as_deref(),
        &req.goal_id,
    )
    .await
    {
        return goal_error_json(error, goal_snapshot(manager, &req.goal_id).await);
    }
    let sidecar_generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let Some(sidecars) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    match manager
        .pause_turn_from_sidecar(
            &req.goal_id,
            &req.queue_id,
            &req.session_id,
            sidecar_generation,
            sidecars,
        )
        .await
    {
        Ok(goal) => Json(serde_json::json!({ "ok": true, "goal": goal_to_json(&goal) })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, &req.goal_id).await),
    }
}

async fn goal_objective_handler(Json(req): Json<GoalObjectiveRequest>) -> Json<serde_json::Value> {
    let session_id = req.session_id.trim();
    let goal_id = req.goal_id.trim();
    let objective = req.objective.trim();
    if session_id.is_empty() || goal_id.is_empty() || objective.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "sessionId, goalId, and objective are required",
        }));
    }
    let manager = session_goal::get_session_goal_manager();
    let goal = match find_current_goal(manager, session_id, req.workspace_path.as_deref()).await {
        Ok(Some(goal)) => goal,
        Ok(None) => {
            return Json(
                serde_json::json!({ "ok": false, "error": "No active Goal in current session" }),
            );
        }
        Err(error) => return goal_error_json(error, None),
    };
    if goal.id != goal_id {
        return goal_error_json(
            GoalMutationError::goal_changed("Goal identity changed before objective update"),
            Some(goal),
        );
    }
    match manager
        .update_objective_cas(&goal.id, objective.to_string(), Some(req.expected_revision))
        .await
    {
        Ok(goal) => Json(serde_json::json!({
            "ok": true,
            "goal": goal_to_json(&goal),
        })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, &goal.id).await),
    }
}

async fn find_current_goal(
    manager: &session_goal::SessionGoalManager,
    session_id: &str,
    workspace_path: Option<&str>,
) -> Result<Option<SessionGoal>, GoalMutationError> {
    manager
        .get_for_session(session_id, workspace_path, false)
        .await
}

async fn goal_get_handler(Query(params): Query<GoalSessionQuery>) -> Json<serde_json::Value> {
    if params.session_id.trim().is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "sessionId is required",
        }));
    }
    let manager = session_goal::get_session_goal_manager();
    let goal = match find_current_goal(
        manager,
        &params.session_id,
        params.workspace_path.as_deref(),
    )
    .await
    {
        Ok(goal) => goal,
        Err(error) => return goal_error_json(error, None),
    };
    Json(serde_json::json!({
        "ok": true,
        "goal": goal.as_ref().map(goal_to_json),
    }))
}

async fn goal_create_handler(Json(req): Json<GoalCreateRequest>) -> Json<serde_json::Value> {
    let session_id = req.session_id.trim();
    let workspace_path = req.workspace_path.trim();
    let objective = req.objective.trim();
    if session_id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "sessionId is required" }));
    }
    if workspace_path.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "workspacePath is required" }));
    }
    if objective.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "objective is required" }));
    }

    let manager = session_goal::get_session_goal_manager();

    let config = SessionGoalConfig {
        workspace_path: workspace_path.to_string(),
        session_id: session_id.to_string(),
        objective: objective.to_string(),
        end_conditions: req.end_conditions,
        notify_enabled: true,
        permission_mode: String::new(),
    };

    match manager.create_goal_and_run(config).await {
        Ok(task) => Json(serde_json::json!({
            "ok": true,
            "goal": goal_to_json(&task),
        })),
        Err(error) => {
            let current = find_current_goal(manager, session_id, Some(workspace_path))
                .await
                .ok()
                .flatten();
            goal_error_json(error, current)
        }
    }
}

async fn goal_update_handler(
    headers: HeaderMap,
    Json(req): Json<GoalUpdateRequest>,
) -> Json<serde_json::Value> {
    let session_id = req.session_id.trim();
    let goal_id = req.goal_id.trim();
    if session_id.is_empty() || goal_id.is_empty() {
        return Json(
            serde_json::json!({ "ok": false, "error": "sessionId and goalId are required" }),
        );
    }
    let status = match req.status.as_str() {
        "complete" => GoalStatus::Complete,
        "blocked" => GoalStatus::Blocked,
        other => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Unsupported Goal status '{}'. Use complete or blocked.", other),
            }));
        }
    };
    let manager = session_goal::get_session_goal_manager();
    let goal = match find_current_goal(manager, session_id, req.workspace_path.as_deref()).await {
        Ok(Some(goal)) => goal,
        Ok(None) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "No active Goal in current session",
            }));
        }
        Err(error) => return goal_error_json(error, None),
    };
    if goal.id != goal_id {
        return goal_error_json(
            GoalMutationError::goal_changed("Goal identity changed before terminal update"),
            Some(goal),
        );
    }
    let Some(queue_id) = req.queue_id.as_deref() else {
        return goal_error_json(
            GoalMutationError::stale_turn("Goal terminal update requires current turn authority"),
            Some(goal),
        );
    };
    let sidecar_generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let Some(sidecars) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    match manager
        .transition_terminal_authorized_from_sidecar(
            &goal.id,
            status,
            req.reason,
            queue_id,
            session_id,
            sidecar_generation,
            sidecars,
        )
        .await
    {
        Ok(outcome) => Json(serde_json::json!({
            "ok": true,
            "goal": goal_to_json(outcome.goal()),
        })),
        Err(error) => goal_error_json(error, goal_snapshot(manager, &goal.id).await),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WakeRequest {
    bot_id: String,
    text: Option<String>,
}

struct BotRefs {
    router: std::sync::Arc<tokio::sync::Mutex<im::router::SessionRouter>>,
    wake_tx: Option<tokio::sync::mpsc::Sender<im::types::HeartbeatWake>>,
    agent_id: Option<String>,
}

/// Look up a bot instance by ID — checks ManagedAgents first (primary path), then
/// falls back to ManagedImBots (legacy compatibility, usually empty after migration).
/// Returns refs with locks already dropped.
async fn find_bot_refs(bot_id: &str) -> Option<BotRefs> {
    // Check agent channels first (primary path after v0.1.41 migration)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for (agent_id, agent) in agents_guard.iter() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some(BotRefs {
                    router: std::sync::Arc::clone(&ch_inst.bot_instance.router),
                    wake_tx: ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                    agent_id: Some(agent_id.clone()),
                });
            }
        }
    }
    // Legacy fallback: ManagedImBots (for backward compatibility — usually empty)
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some(BotRefs {
                router: std::sync::Arc::clone(&instance.router),
                wake_tx: instance.heartbeat_wake_tx.clone(),
                agent_id: None,
            });
        }
    }
    None
}

async fn post_manual_wake_text(
    router: &std::sync::Arc<tokio::sync::Mutex<im::router::SessionRouter>>,
    target_session_key: Option<&str>,
    text: &str,
) {
    let port = {
        let router_guard = router.lock().await;
        match target_session_key {
            Some(session_key) => router_guard.active_private_peer_session_port(session_key),
            None => router_guard.latest_active_private_peer_session_port(),
        }
    };

    if let Some(port) = port {
        let client = crate::local_http::builder().build().unwrap_or_default();
        let body = serde_json::json!({
            "event": "manual_wake",
            "content": text,
        });
        let _ = client
            .post(format!("http://127.0.0.1:{}/api/im/system-event", port))
            .json(&body)
            .send()
            .await;
    }
}

/// Look up a bot's adapter by ID — checks ManagedAgents first, then legacy ManagedImBots.
async fn find_bot_adapter(bot_id: &str) -> Option<std::sync::Arc<im::AnyAdapter>> {
    // Check agent channels first (primary path)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some(std::sync::Arc::clone(&ch_inst.bot_instance.adapter));
            }
        }
    }
    // Legacy fallback
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some(std::sync::Arc::clone(&instance.adapter));
        }
    }
    None
}

/// Snapshot of channel metadata extracted under lock, resolved after lock is dropped.
struct ChannelSnapshot {
    bot_id: String,
    platform_str: String,
    name: String,
    agent_name: Option<String>,
    health: std::sync::Arc<im::health::HealthManager>,
}

/// GET /api/im/channels — List all configured IM channels for cron delivery target discovery.
/// Returns channel botId, platform, name, parent agent name, and runtime status.
/// Uses snapshot-then-await pattern to avoid holding ManagedAgents/ManagedImBots lock across awaits.
async fn list_im_channels_handler() -> Json<serde_json::Value> {
    let mut snapshots: Vec<ChannelSnapshot> = Vec::new();

    // Snapshot from ManagedAgents (primary path after v0.1.41) — lock dropped before await
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            for (ch_id, ch_inst) in &agent.channels {
                let platform_str = serde_json::to_value(&ch_inst.bot_instance.platform)
                    .and_then(|v| serde_json::from_value::<String>(v))
                    .unwrap_or_else(|_| "unknown".to_string());
                let name = ch_inst
                    .bot_instance
                    .config
                    .name
                    .clone()
                    .unwrap_or_else(|| ch_id.clone());
                snapshots.push(ChannelSnapshot {
                    bot_id: ch_id.clone(),
                    platform_str,
                    name,
                    agent_name: Some(agent.config.name.clone()),
                    health: std::sync::Arc::clone(&ch_inst.bot_instance.health),
                });
            }
        }
    } // agents_guard dropped here

    // Snapshot from legacy ManagedImBots — lock dropped before await
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        for (bot_id, instance) in bots_guard.iter() {
            // Skip if already collected from agent channels
            if snapshots.iter().any(|s| s.bot_id == *bot_id) {
                continue;
            }
            let platform_str = serde_json::to_value(&instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            let name = instance
                .config
                .name
                .clone()
                .unwrap_or_else(|| bot_id.clone());
            snapshots.push(ChannelSnapshot {
                bot_id: bot_id.clone(),
                platform_str,
                name,
                agent_name: None,
                health: std::sync::Arc::clone(&instance.health),
            });
        }
    } // bots_guard dropped here

    // Now resolve health states without holding any lock
    let mut channels = Vec::with_capacity(snapshots.len());
    for snap in snapshots {
        let health_state = snap.health.get_state().await;
        let status_str = serde_json::to_value(&health_state.status)
            .and_then(|v| serde_json::from_value::<String>(v))
            .unwrap_or_else(|_| "unknown".to_string());
        channels.push(serde_json::json!({
            "botId": snap.bot_id,
            "platform": snap.platform_str,
            "name": snap.name,
            "agentName": snap.agent_name,
            "status": status_str,
        }));
    }

    Json(serde_json::json!({ "ok": true, "channels": channels }))
}

async fn wake_bot_handler(Json(payload): Json<WakeRequest>) -> Json<serde_json::Value> {
    let refs = match find_bot_refs(&payload.bot_id).await {
        Some(refs) => refs,
        None => return Json(serde_json::json!({ "ok": false, "error": "Bot not found" })),
    };

    if let Some(agent_id) = refs.agent_id {
        let agents = match get_agents() {
            Some(agents) => agents,
            None => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "Agent state not available"
                }))
            }
        };
        let route = match im::resolve_agent_heartbeat_route(agents, &agent_id).await {
            im::AgentHeartbeatRouteResolution::Target(route) => route,
            im::AgentHeartbeatRouteResolution::NoPrivateTarget => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "No private heartbeat target for this Agent"
                }))
            }
            im::AgentHeartbeatRouteResolution::AgentMissing => {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "Agent not found"
                }))
            }
        };

        if let Some(ref text) = payload.text {
            post_manual_wake_text(&route.router, Some(&route.target.session_key), text).await;
        }

        if let Some(wake_tx) = route.wake_tx {
            let wake = im::types::HeartbeatWake::targeted(
                im::types::WakeReason::Manual,
                route.target.session_key,
            );
            match wake_tx.send(wake).await {
                Ok(_) => Json(serde_json::json!({ "ok": true })),
                Err(e) => Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Wake failed: {}", e)
                })),
            }
        } else {
            Json(serde_json::json!({
                "ok": false,
                "error": "Heartbeat not configured for this Agent"
            }))
        }
    } else {
        if let Some(ref text) = payload.text {
            post_manual_wake_text(&refs.router, None, text).await;
        }

        if let Some(ref wake_tx) = refs.wake_tx {
            match wake_tx
                .send(im::types::HeartbeatWake::new(im::types::WakeReason::Manual))
                .await
            {
                Ok(_) => Json(serde_json::json!({ "ok": true })),
                Err(e) => Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Wake failed: {}", e)
                })),
            }
        } else {
            Json(serde_json::json!({
                "ok": false,
                "error": "Heartbeat not configured for this bot"
            }))
        }
    }
}

// ===== Send Media handler =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SendMediaRequest {
    bot_id: String,
    chat_id: String,
    platform: String,
    file_path: String,
    caption: Option<String>,
}

async fn send_media_handler(Json(req): Json<SendMediaRequest>) -> Json<serde_json::Value> {
    // Get adapter from the bot instance (checks legacy IM bots, then agent channels)
    let adapter: std::sync::Arc<im::AnyAdapter> = match find_bot_adapter(&req.bot_id).await {
        Some(a) => a,
        None => {
            return Json(serde_json::json!({
                "ok": false, "error": format!("Bot not found: {}", req.bot_id)
            }))
        }
    };

    // Read the file
    let path = std::path::Path::new(&req.file_path);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let data = match tokio::fs::read(&req.file_path).await {
        Ok(d) => d,
        Err(e) => {
            return Json(serde_json::json!({
                "ok": false, "error": format!("File not found or unreadable: {}", e)
            }))
        }
    };

    let data_len = data.len() as u64;
    let media_type = MediaType::from_extension(ext);

    match media_type {
        MediaType::Image => {
            let size_limit: u64 = 10 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Image too large: {:.1} MB (max 10 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            ulog_info!(
                "[send-media] Sending image: {} ({} bytes) to {}",
                filename,
                data_len,
                req.chat_id
            );
            match adapter
                .send_photo(&req.chat_id, data, &filename, req.caption.as_deref())
                .await
            {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send photo: {}", e)
                })),
            }
        }
        MediaType::File => {
            let size_limit: u64 = 50 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("File too large: {:.1} MB (max 50 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            let mime = match ext.to_lowercase().as_str() {
                "pdf" => "application/pdf",
                "doc" | "docx" => "application/msword",
                "xls" | "xlsx" => "application/vnd.ms-excel",
                "ppt" | "pptx" => "application/vnd.ms-powerpoint",
                "mp4" => "video/mp4",
                "mp3" => "audio/mpeg",
                "zip" => "application/zip",
                "csv" => "text/csv",
                "json" => "application/json",
                "xml" => "application/xml",
                "html" => "text/html",
                "txt" => "text/plain",
                _ => "application/octet-stream",
            };
            ulog_info!(
                "[send-media] Sending file: {} ({} bytes, {}) to {}",
                filename,
                data_len,
                mime,
                req.chat_id
            );
            match adapter
                .send_file(&req.chat_id, data, &filename, mime, req.caption.as_deref())
                .await
            {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send file: {}", e)
                })),
            }
        }
        MediaType::NonMedia => Json(serde_json::json!({
            "ok": false,
            "error": format!("Unsupported file type: .{} — only images, documents, media, and archives can be sent", ext)
        })),
    }
}

// ===== Cron Stop handler =====

fn cron_stop_success_response(task: &crate::task::Task) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "taskId": task.id,
        "status": task.status.as_str(),
    })
}

async fn stop_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    if let Err(e) = get_ordinary_cron_task(manager, &req.task_id).await {
        if e == MANAGED_CRON_TASK_ERROR {
            return Json(managed_json_response());
        }
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    match manager
        .stop_task(&req.task_id, Some("Stopped via admin CLI".to_string()))
        .await
    {
        Ok(_) => {
            let Some(store) = crate::task::get_task_store() else {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": "task store not initialized",
                }));
            };
            let Some(task) = store.get(&req.task_id).await else {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Task not found: {}", req.task_id),
                }));
            };
            Json(cron_stop_success_response(&task))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ===== Plugin Management handlers =====

async fn list_plugins_handler() -> Json<serde_json::Value> {
    match bridge::list_openclaw_plugins().await {
        Ok(plugins) => Json(serde_json::json!({ "ok": true, "plugins": plugins })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallPluginRequest {
    npm_spec: String,
}

async fn install_plugin_handler(Json(req): Json<InstallPluginRequest>) -> Json<serde_json::Value> {
    // install_openclaw_plugin requires AppHandle, but Management API doesn't have it.
    // Use the global app handle from logger module.
    let app_handle = match crate::logger::get_app_handle() {
        Some(h) => h,
        None => return Json(serde_json::json!({ "ok": false, "error": "App not initialized" })),
    };
    match bridge::install_openclaw_plugin(app_handle, &req.npm_spec).await {
        Ok(metadata) => Json(serde_json::json!({ "ok": true, "plugin": metadata })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallPluginRequest {
    plugin_id: String,
}

async fn uninstall_plugin_handler(
    Json(req): Json<UninstallPluginRequest>,
) -> Json<serde_json::Value> {
    match bridge::uninstall_openclaw_plugin(&req.plugin_id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ===== Agent Runtime Status handler =====

async fn agent_runtime_status_handler() -> Json<serde_json::Value> {
    let agents = match get_agents() {
        Some(a) => a,
        None => return Json(serde_json::json!({ "ok": true, "agents": {} })),
    };

    let agents_guard = agents.lock().await;

    // Snapshot data under lock, then drop lock before awaiting health states
    struct AgentSnapshot {
        agent_id: String,
        agent_name: String,
        enabled: bool,
        channels: Vec<ChannelRuntimeSnapshot>,
    }
    struct ChannelRuntimeSnapshot {
        channel_id: String,
        platform_str: String,
        health: std::sync::Arc<im::health::HealthManager>,
    }

    let mut snapshots: Vec<AgentSnapshot> = Vec::new();
    for (agent_id, agent) in agents_guard.iter() {
        let mut ch_snapshots = Vec::new();
        for (ch_id, ch) in &agent.channels {
            let platform_str = serde_json::to_value(&ch.bot_instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            ch_snapshots.push(ChannelRuntimeSnapshot {
                channel_id: ch_id.clone(),
                platform_str,
                health: std::sync::Arc::clone(&ch.bot_instance.health),
            });
        }
        snapshots.push(AgentSnapshot {
            agent_id: agent_id.clone(),
            agent_name: agent.config.name.clone(),
            enabled: agent.config.enabled,
            channels: ch_snapshots,
        });
    }
    drop(agents_guard);

    // Now resolve health states without holding the lock
    let mut result = serde_json::Map::new();
    for snap in snapshots {
        let mut channels = Vec::new();
        for ch in &snap.channels {
            let health_state = ch.health.get_state().await;
            let status_str = serde_json::to_value(&health_state.status)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            channels.push(serde_json::json!({
                "channelId": ch.channel_id,
                "channelType": ch.platform_str,
                "status": status_str,
                "uptimeSeconds": health_state.uptime_seconds,
                "lastMessageAt": health_state.last_message_at,
                "errorMessage": health_state.error_message,
                "activeSessions": health_state.active_sessions.len(),
                "restartCount": health_state.restart_count,
            }));
        }
        result.insert(
            snap.agent_id.clone(),
            serde_json::json!({
                "agentId": snap.agent_id,
                "agentName": snap.agent_name,
                "enabled": snap.enabled,
                "channels": channels,
            }),
        );
    }

    Json(serde_json::json!({ "ok": true, "agents": result }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentReloadConfigRequest {
    agent_id: String,
    patch: im::types::AgentConfigPatch,
}

async fn agent_reload_config_handler(
    Json(req): Json<AgentReloadConfigRequest>,
) -> Json<serde_json::Value> {
    let Some(agents) = get_agents() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Agent state unavailable"
        }));
    };
    let Some(sidecar_manager) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Sidecar manager unavailable"
        }));
    };
    let Some(app_handle) = crate::logger::get_app_handle() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "App not initialized"
        }));
    };

    let agent_id = req.agent_id;
    match im::reload_agent_config_from_disk(
        app_handle,
        agents,
        sidecar_manager,
        agent_id.clone(),
        req.patch,
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true, "agentId": agent_id })),
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "error": error
        })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStopChannelsRequest {
    agent_id: String,
}

async fn agent_stop_channels_handler(
    Json(req): Json<AgentStopChannelsRequest>,
) -> Json<serde_json::Value> {
    let Some(agents) = get_agents() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Agent state unavailable"
        }));
    };
    let Some(sidecar_manager) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Sidecar manager unavailable"
        }));
    };

    let stopped = im::stop_agent_channels_for_archive(agents, sidecar_manager, &req.agent_id).await;
    ulog_info!(
        "[management] stopped {} channel(s) for archived agent {}",
        stopped,
        req.agent_id
    );

    Json(serde_json::json!({
        "ok": true,
        "agentId": req.agent_id,
        "stoppedChannels": stopped
    }))
}

// ===== Bridge Message handler (OpenClaw Channel Plugin → Rust) =====

/// Media attachment from Plugin Bridge (base64-encoded).
/// Classified by the Bridge shim based on MIME type:
///   - "image" → ImAttachmentType::Image (Claude Vision API)
///   - "file"  → ImAttachmentType::File (save to workspace + @path reference)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeAttachment {
    file_name: String,
    mime_type: String,
    /// base64-encoded file content
    data: String,
    /// "image" | "file"
    attachment_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeMessagePayload {
    bot_id: String,
    plugin_id: String,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    delivery_protocol: Option<crate::im::types::ImDeliveryProtocol>,
    sender_id: String,
    sender_name: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    text: String,
    chat_type: String, // "direct" | "group"
    chat_id: String,
    message_id: Option<String>,
    #[allow(dead_code)]
    group_id: Option<String>,
    is_mention: Option<bool>,
    /// Human-readable group name from plugin (e.g. GroupSubject in OpenClaw Feishu)
    #[serde(default)]
    group_name: Option<String>,
    /// Thread ID for threaded replies (MessageThreadId in OpenClaw)
    #[serde(default)]
    #[allow(dead_code)]
    thread_id: Option<String>,
    /// Quoted reply text content (ReplyToBody in OpenClaw)
    #[serde(default)]
    reply_to_body: Option<String>,
    /// Group-level custom system prompt from plugin config
    #[serde(default)]
    group_system_prompt: Option<String>,
    /// Media attachments from OpenClaw plugin (images, files, voice, video)
    #[serde(default)]
    attachments: Vec<BridgeAttachment>,
}

async fn handle_bridge_message(
    Json(payload): Json<BridgeMessagePayload>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    use crate::im::bridge;
    use crate::im::types::{ImAttachment, ImAttachmentType, ImMessage, ImPlatform, ImSourceType};

    // Validate plugin_id: reject empty, path separators, and colons.
    // Note: built-in platform names ("feishu" etc.) are allowed because OpenClaw plugins
    // may legitimately use them as channel IDs (e.g. official Feishu plugin = "feishu").
    // Bridge routing uses botId (UUID), not pluginId, so there's no collision.
    let plugin_id = payload.plugin_id.trim().to_string();
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains(':')
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Invalid plugin_id: '{}'", plugin_id)
            })),
        );
    }

    let sender = match bridge::get_bridge_sender(&payload.bot_id).await {
        Some(tx) => tx,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("No bridge sender registered for bot_id={}", payload.bot_id)
                })),
            );
        }
    };

    let source_type = if payload.chat_type == "group" {
        ImSourceType::Group
    } else {
        ImSourceType::Private
    };
    // Default: private=true (directed at bot), group=false (only if explicitly flagged)
    let is_mention = payload
        .is_mention
        .unwrap_or(source_type == ImSourceType::Private);

    let request_id = payload
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if payload.delivery_protocol.is_some() && request_id.is_none() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": "deliveryProtocol requires requestId"
            })),
        );
    }

    // Decode base64 media attachments from Bridge
    let mut im_attachments: Vec<ImAttachment> = Vec::new();
    for att in &payload.attachments {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(&att.data) {
            Ok(data) => {
                let attachment_type = if att.attachment_type == "image" {
                    ImAttachmentType::Image
                } else {
                    ImAttachmentType::File
                };
                crate::ulog_info!(
                    "[im-bridge] Decoded {} attachment: {} ({}, {} bytes)",
                    att.attachment_type,
                    att.file_name,
                    att.mime_type,
                    data.len()
                );
                im_attachments.push(ImAttachment {
                    file_name: att.file_name.clone(),
                    mime_type: att.mime_type.clone(),
                    data,
                    attachment_type,
                });
            }
            Err(e) => {
                crate::ulog_error!(
                    "[im-bridge] Failed to decode base64 for {}: {}",
                    att.file_name,
                    e
                );
            }
        }
    }

    let msg = ImMessage {
        chat_id: payload.chat_id,
        message_id: payload
            .message_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        text: payload.text,
        sender_id: payload.sender_id,
        sender_name: payload.sender_name,
        account_id: payload.account_id,
        source_type,
        platform: ImPlatform::OpenClaw(plugin_id),
        timestamp: chrono::Utc::now(),
        attachments: im_attachments,
        media_group_id: None,
        is_mention,
        reply_to_bot: false,
        hint_group_name: payload.group_name,
        reply_to_body: payload.reply_to_body,
        group_system_prompt: payload.group_system_prompt,
        request_id: request_id.unwrap_or_default(),
        delivery_protocol: payload.delivery_protocol,
    };

    match sender.send(msg).await {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({ "ok": true })),
        ),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Failed to send message to processing loop: {}", e)
            })),
        ),
    }
}

// ========================================================================
// Task Center handlers (v0.1.69)
// ========================================================================
//
// These endpoints are called by the Bun Admin API (admin-api.ts), which in
// turn is called by the `myagents task` CLI. The CLI is the **entry point of
// trust inference** for `actor` / `source` (PRD §10.2.1 caller-inference table):
//
// - `MYAGENTS_PORT` env var set → AI sub-process → `actor=agent, source=cli`
// - Otherwise (user terminal reading `~/.myagents/sidecar.port`) →
//   `actor=user, source=cli`
//
// That inference happens in the CLI script itself (knows its own env) and is
// forwarded to the Bun Admin API, which forwards here. We take the caller's
// word for actor/source: the CLI process running inside an SDK subprocess is
// inside a trust boundary already (the whole host is the user's machine).
// For UI transitions the Tauri command layer stamps `user/ui` authoritatively
// without ever reaching this path.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskListQuery {
    workspace_id: Option<String>,
    status: Option<String>,
    tag: Option<String>,
    include_deleted: Option<bool>,
}

async fn task_list_handler(Query(q): Query<TaskListQuery>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let filter = task::TaskListFilter {
        workspace_id: q.workspace_id,
        status: q.status.and_then(|s| parse_status_filter(&s)),
        tag: q.tag,
        include_deleted: q.include_deleted,
        include_managed: None,
    };
    let tasks = store.list(filter).await;
    let executions = crate::task_scheduler::get_task_scheduler()
        .execution_projections_snapshot()
        .await;
    let tasks = tasks
        .into_iter()
        .map(|task| {
            let execution = executions.get(&task.id).cloned();
            task::TaskProjection::new(task, execution)
        })
        .collect::<Vec<_>>();
    Json(serde_json::json!({ "ok": true, "tasks": tasks }))
}

fn parse_status_filter(raw: &str) -> Option<task::StatusFilter> {
    if raw.contains(',') {
        let list: Vec<task::TaskStatus> = raw
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|s| serde_json::from_str(&format!("\"{}\"", s)).ok())
            .collect();
        if list.is_empty() {
            None
        } else {
            Some(task::StatusFilter::Many(list))
        }
    } else {
        serde_json::from_str::<task::TaskStatus>(&format!("\"{}\"", raw.trim()))
            .ok()
            .map(task::StatusFilter::One)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskGetQuery {
    id: String,
}

async fn task_get_handler(Query(q): Query<TaskGetQuery>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.get_ordinary(&q.id).await {
        Ok(t) => {
            // Attach task.docs (four absolute paths) so the AI / CLI
            // reading this response knows where task.md / verify.md /
            // progress.md / alignment.md live without having to
            // re-derive the layout from convention. See
            // `task::build_task_docs` for semantics of the optional
            // fields (only existing files are surfaced).
            let docs = match task::build_task_docs(&t.id) {
                Ok(d) => d,
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("failed to build docs paths: {}", e)
                    }));
                }
            };
            let execution = crate::task_scheduler::get_task_scheduler()
                .execution_projection(&t.id)
                .await;
            Json(serde_json::json!({
                "ok": true,
                "task": task::TaskWithDocs {
                    task: t,
                    docs,
                    execution_state: execution.as_ref().map(|value| value.state),
                    execution_error: execution.and_then(|value| value.error),
                }
            }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn task_create_direct_handler(
    Json(input): Json<task::TaskCreateDirectInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let source_thought = input.source_thought_id.clone();
    match task_store.create_direct(input).await {
        Ok(t) => {
            // Best-effort bidirectional link (same as Tauri command layer).
            if let (Some(thought_id), Some(thoughts)) =
                (source_thought, thought::get_thought_store())
            {
                let _ = thoughts.link_task(&thought_id, &t.id).await;
            }
            Json(serde_json::json!({ "ok": true, "task": t }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn task_create_attached_handler(
    Json(input): Json<task::TaskCreateAttachedInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match task_store.create_attached(input).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn task_update_handler(Json(input): Json<task::TaskUpdateInput>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    if let Err(error) = store.get_ordinary(&input.id).await {
        return Json(serde_json::json!({ "ok": false, "error": error }));
    }
    // Reuses `TaskStore::update`, which:
    //   * rejects updates on Running/Verifying tasks (state-machine guard),
    //   * applies mode-transition hygiene (clearing recurring fields when
    //     `executionMode` flips to Once etc.),
    //   * projects schedule/notification/override changes back to the linked
    //     CronTask via `update_task_fields`, so a CLI patch like
    //     `--intervalMinutes 180` actually re-arms the scheduler.
    match store.update(input).await {
        Ok(task) => {
            let docs = match task::build_task_docs(&task.id) {
                Ok(d) => d,
                // Doc dir absence is non-fatal — surface the task without
                // docs paths so the caller still sees the update result.
                Err(_) => task::TaskDocs {
                    dir: String::new(),
                    task_md: String::new(),
                    verify_md: None,
                    progress_md: None,
                    alignment_md: None,
                },
            };
            let execution = crate::task_scheduler::get_task_scheduler()
                .execution_projection(&task.id)
                .await;
            Json(serde_json::json!({
                "ok": true,
                "task": task::TaskWithDocs {
                    task,
                    docs,
                    execution_state: execution.as_ref().map(|value| value.state),
                    execution_error: execution.and_then(|value| value.error),
                },
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskUpdateStatusApiRequest {
    id: String,
    status: task::TaskStatus,
    #[serde(default)]
    message: Option<String>,
    /// Caller-declared actor. CLI from AI subprocess → "agent"; user terminal → "user".
    actor: task::TransitionActor,
    /// Caller-declared source. Usually "cli" from this endpoint; scheduler /
    /// watchdog / crash paths don't use HTTP.
    #[serde(default)]
    source: Option<task::TransitionSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskTurnAuthorizeRequest {
    task_id: String,
    queue_id: String,
    session_id: String,
}

async fn task_turn_authorize_handler(
    headers: HeaderMap,
    Json(req): Json<TaskTurnAuthorizeRequest>,
) -> Json<serde_json::Value> {
    let task_id = req.task_id.trim();
    let queue_id = req.queue_id.trim();
    let session_id = req.session_id.trim();
    if task_id.is_empty() || queue_id.is_empty() || session_id.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "code": "invalid_request",
            "error": "taskId, queueId, and sessionId are required",
        }));
    }
    let generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let Some(sidecars) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    let generation_is_current = match sidecars.lock() {
        Ok(manager) => manager.is_live(session_id, generation),
        Err(error) => {
            return Json(serde_json::json!({
                "ok": false,
                "code": "management_unavailable",
                "error": format!("Sidecar lock poisoned: {error}"),
            }));
        }
    };
    if !generation_is_current {
        return Json(serde_json::json!({
            "ok": false,
            "code": "stale_sidecar",
            "error": "Task dispatch came from a stale Sidecar",
        }));
    }
    if !crate::task_scheduler::get_task_scheduler()
        .authorize_dispatch(task_id, queue_id)
        .await
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "task_dispatch_canceled",
            "error": "Task execution was canceled before dispatch",
        }));
    }
    Json(serde_json::json!({ "ok": true }))
}

async fn task_update_status_handler(
    Json(req): Json<TaskUpdateStatusApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let task_control = crate::task_scheduler::acquire_task_control(&req.id).await;
    let current = match store.get_ordinary(&req.id).await {
        Ok(task) => task,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    if task::is_terminal_execution_stop_request(current.status, req.status) {
        return match crate::task_scheduler::get_task_scheduler()
            .stop_with_control_held(&current.id, &task_control)
            .await
        {
            Ok(()) => Json(serde_json::json!({ "ok": true, "task": current })),
            Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
        };
    }
    match store
        .update_status_with_task_control_held(
            task::TaskUpdateStatusInput {
                id: req.id,
                status: req.status,
                message: req.message,
                actor: req.actor,
                source: req.source.or(Some(task::TransitionSource::Cli)),
            },
            &task_control,
        )
        .await
    {
        Ok((task, transition)) => Json(serde_json::json!({
            "ok": true,
            "task": task,
            "transition": transition
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskAppendSessionApiRequest {
    id: String,
    session_id: String,
}

async fn task_append_session_handler(
    Json(req): Json<TaskAppendSessionApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    if let Err(error) = store.get_ordinary(&req.id).await {
        return Json(serde_json::json!({ "ok": false, "error": error }));
    }
    match store.append_session(&req.id, &req.session_id).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskArchiveApiRequest {
    id: String,
    #[serde(default)]
    message: Option<String>,
}

async fn task_archive_handler(Json(req): Json<TaskArchiveApiRequest>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    if let Err(error) = store.get_ordinary(&req.id).await {
        return Json(serde_json::json!({ "ok": false, "error": error }));
    }
    match store.archive(&req.id, req.message).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDeleteApiRequest {
    id: String,
}

async fn task_delete_handler(Json(req): Json<TaskDeleteApiRequest>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let source_thought = match store.get_ordinary(&req.id).await {
        Ok(task) => task.source_thought_id,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    match store.delete(&req.id).await {
        Ok(()) => {
            if let (Some(thought_id), Some(thoughts)) =
                (source_thought, thought::get_thought_store())
            {
                let _ = thoughts.unlink_task(&thought_id, &req.id).await;
            }
            Json(serde_json::json!({ "ok": true }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThoughtListQuery {
    tag: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    /// `active` (default) / `archived` / `all`. CLI parity with v0.2.16
    /// archive feature so `myagents thought list --archived` works.
    archived: Option<String>,
}

async fn thought_list_handler(Query(q): Query<ThoughtListQuery>) -> Json<serde_json::Value> {
    let Some(store) = thought::get_thought_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "thought store not initialized"
        }));
    };
    let archive_mode = match q.archived.as_deref() {
        Some("archived") => Some(thought::ThoughtArchiveFilter::Archived),
        Some("all") => Some(thought::ThoughtArchiveFilter::All),
        // Missing or "active" → default Active behavior; anything else
        // we ignore rather than 400 so a typo doesn't surface as a hard
        // CLI failure.
        _ => Some(thought::ThoughtArchiveFilter::Active),
    };
    let thoughts = store
        .list(thought::ThoughtListFilter {
            tag: q.tag,
            query: q.query,
            limit: q.limit,
            archived: archive_mode,
        })
        .await;
    Json(serde_json::json!({ "ok": true, "thoughts": thoughts }))
}

async fn thought_create_handler(
    Json(input): Json<thought::ThoughtCreateInput>,
) -> Json<serde_json::Value> {
    let Some(store) = thought::get_thought_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "thought store not initialized"
        }));
    };
    match store.create(input).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "thought": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

fn space_cli_error(error: String) -> serde_json::Value {
    let (code, message) = error
        .split_once(": ")
        .filter(|(candidate, _)| {
            !candidate.is_empty()
                && candidate.chars().all(|character| {
                    character.is_ascii_uppercase() || character == '_' || character.is_ascii_digit()
                })
        })
        .map(|(code, message)| (code.to_string(), message.to_string()))
        .unwrap_or_else(|| ("SPACE_COMMAND_FAILED".to_string(), error));
    let (suggestion, suggested_command) = match code.as_str() {
        "SPACE_REQUIRED" | "SPACE_NOT_AVAILABLE" => (
            Some("Run `myagents space list --json`, then retry with one returned slug."),
            Some("myagents space list --json"),
        ),
        "ASSIGNEE_ID_INVALID" => (
            Some("List valid typed assignee IDs for the selected Space, then retry with one returned assigneeId."),
            None,
        ),
        "GOAL_NOT_FOUND" | "GOAL_IS_ARCHIVED" | "GOAL_ID_REQUIRED" => (
            Some("List active Goals for the selected Space and copy a current data.items[].id."),
            Some("myagents space goal list --space <slug> --json"),
        ),
        "ISSUE_MUTATION_CONFLICT" => (
            Some("Re-read the authoritative Issue, then retry only after reconciling the concurrent change."),
            Some("myagents space issue view <issueId> --space <slug> --json"),
        ),
        "ATTACHMENT_REQUIRED" => (
            Some("Add one or more workspace files with repeated --file flags."),
            None,
        ),
        "COMMENT_CONTENT_REQUIRED" => (
            Some("Add --body-file <path>, one or more --attachment <path> flags, or both."),
            None,
        ),
        "ATTACHMENT_COUNT_EXCEEDED" => (
            Some("Send at most five files in one command."),
            None,
        ),
        "ATTACHMENT_TOO_LARGE" => (
            Some("Choose a file no larger than 25 MB, then retry."),
            None,
        ),
        "ATTACHMENT_OUTSIDE_WORKSPACE"
        | "ATTACHMENT_SYMLINK_REJECTED"
        | "ATTACHMENT_NOT_FILE"
        | "ATTACHMENT_NOT_FOUND"
        | "ATTACHMENT_PATH_INVALID" => (
            Some("Choose a regular, non-symlink file inside the current workspace, then retry."),
            None,
        ),
        "WORKSPACE_REQUIRED" => (
            Some("Run the command from the intended workspace or pass --workspacePath <path>."),
            None,
        ),
        "SPACE_AGENT_BINDING_AMBIGUOUS" | "SPACE_AGENT_WORKSPACE_AMBIGUOUS" => (
            Some("Remove duplicate Registered Agent bindings in Space settings, then run space whoami again."),
            None,
        ),
        "SPACE_AGENT_BINDING_INVALID" | "SPACE_CONTEXT_INVALID" | "SPACE_CONTEXT_MISMATCH" => (
            Some("Verify the selected Space and current identity with `myagents space whoami --space <slug> --json`."),
            None,
        ),
        code if code.contains("PERMISSION")
            || code.contains("FORBIDDEN")
            || code == "NOT_AUTHORIZED"
            || code == "NOT_AUTHENTICATED"
            || code == "SESSION_EXPIRED"
            || code == "REGISTERED_AGENT_TOKEN_MISSING"
            || code == "REGISTERED_AGENT_TOKEN_IS_INVALID_OR_REVOKED"
            || code == "REGISTERED_AGENT_OWNER_MUST_BE_A_SPACE_OWNER_OR_ADMIN"
            || code == "THIS_ISSUE_IS_HUMAN_ONLY"
            || code == "THIS_ISSUE_IS_OUTSIDE_THIS_REGISTERED_AGENT_SUBSCRIPTION"
            || code == "ONLY_OWNER_ADMIN_OR_THE_CREATOR_OF_AN_OPEN_ISSUE_CAN_EDIT_IT" => (
            Some("Verify the effective actor with space whoami; retry only with a User or Registered Agent that has permission for this action."),
            Some("myagents space whoami --space <slug> --json"),
        ),
        code if code.contains("NOT_FOUND") => (
            Some("Re-read the current Space or Issue state, copy a current stable ID, and retry."),
            None,
        ),
        code if code.contains("QUOTA") || code.contains("LIMIT") => (
            Some("Reduce the requested payload or free Space capacity before retrying."),
            None,
        ),
        _ => (
            Some("Run the exact command with --help, verify the current Space state, and retry only after correcting the reported error."),
            None,
        ),
    };
    let mut payload = serde_json::json!({
        "ok": false,
        "code": code,
        "error": message,
    });
    if let Some(suggestion) = suggestion {
        payload["suggestion"] = serde_json::Value::String(suggestion.to_string());
    }
    if let Some(command) = suggested_command {
        payload["suggestedCommand"] = serde_json::Value::String(command.to_string());
    }
    payload
}

fn space_result(result: Result<serde_json::Value, String>) -> Json<serde_json::Value> {
    match result {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })),
        Err(error) => Json(space_cli_error(error)),
    }
}

async fn space_list_handler() -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_space_list().await)
}

async fn space_whoami_handler(
    Json(input): Json<crate::space_cloud::SpaceCliContextInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_whoami(input).await)
}

async fn space_assignee_list_handler(
    Json(input): Json<crate::space_cloud::SpaceCliContextInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_assignee_list(input).await)
}

async fn space_goal_list_handler(
    Json(input): Json<crate::space_cloud::SpaceCliGoalListInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_goal_list(input).await)
}

async fn space_issue_create_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueCreateInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_create(input).await)
}

async fn space_issue_update_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueUpdateInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_update(input).await)
}

async fn space_issue_get_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueGetInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_get(input).await)
}

async fn space_issue_list_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueListInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_list(input).await)
}

async fn space_issue_comment_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueCommentInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_comment(input).await)
}

async fn space_issue_comments_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueCommentsInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_comments(input).await)
}

async fn space_issue_comment_get_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueCommentGetInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_comment_get(input).await)
}

async fn space_issue_status_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueStatusInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_status(input).await)
}

async fn space_issue_claim_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueClaimInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_claim(input).await)
}

async fn space_issue_close_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueActionInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_close(input).await)
}

async fn space_issue_complete_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueActionInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_complete(input).await)
}

async fn space_issue_cancel_claim_handler(
    Json(input): Json<crate::space_cloud::SpaceCliIssueActionInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_issue_cancel_claim(input).await)
}

async fn space_claim_local_task_handler(
    Json(input): Json<crate::space_cloud::SpaceCliClaimLocalTaskInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_claim_local_task(input).await)
}

async fn space_attachment_download_handler(
    Json(input): Json<crate::space_cloud::SpaceCliAttachmentDownloadInput>,
) -> Json<serde_json::Value> {
    match crate::space_cloud::space_cli_attachment_download(input).await {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn space_attachment_add_handler(
    Json(input): Json<crate::space_cloud::SpaceCliAttachmentAddInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_attachment_add(input).await)
}

async fn space_attachment_inspect_handler(
    Json(input): Json<crate::space_cloud::SpaceCliAttachmentAddInput>,
) -> Json<serde_json::Value> {
    space_result(crate::space_cloud::space_cli_attachment_inspect(input).await)
}

// ========================================================================
// Task Center execution handlers (v0.1.69)
// ========================================================================

async fn task_create_from_alignment_handler(
    Json(input): Json<task::TaskCreateFromAlignmentInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match task_store.create_from_alignment(input).await {
        Ok(t) => {
            // Resolve thought→task linkage from the created task's record,
            // not the raw input — `source_thought_id` may have been
            // auto-inherited from alignment metadata.json and thus absent
            // on the input. Reading from `t` covers both code paths
            // uniformly.
            if let (Some(thought_id), Some(thoughts)) =
                (t.source_thought_id.clone(), thought::get_thought_store())
            {
                let _ = thoughts.link_task(&thought_id, &t.id).await;
            }
            Json(serde_json::json!({ "ok": true, "task": t }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// PRD §10.2.2 `POST /api/task/run` — trigger execution of an existing Task.
///
/// The Task row is the sole scheduling authority. Starting persists Running,
/// then arms the in-memory Task scheduler from that committed row.
async fn task_run_handler(Json(req): Json<TaskIdApiRequest>) -> Json<serde_json::Value> {
    if let Some(store) = task::get_task_store() {
        if let Err(error) = store.get_ordinary(&req.id).await {
            return Json(serde_json::json!({ "ok": false, "error": error }));
        }
    }
    match run_task_by_id(&req.id).await {
        Ok(task) => Json(serde_json::json!({
            "ok": true,
            "task": task,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

pub(crate) async fn run_task_by_id(id: &str) -> Result<task::Task, String> {
    let task_control = crate::task_scheduler::try_acquire_task_control(id)
        .await
        .ok_or_else(|| {
            format!("task {id} is stopping or changing scheduler state; retry after it settles")
        })?;
    run_task_by_id_with_control(id, &task_control).await
}

pub(crate) async fn run_task_by_id_with_control(
    id: &str,
    task_control: &crate::task_scheduler::TaskControlGuard,
) -> Result<task::Task, String> {
    let Some(task_store) = task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(ta) = task_store.get(id).await else {
        return Err("task not found".to_string());
    };

    if ta.status != task::TaskStatus::Todo {
        return Err(format!(
            "task is in state '{}'; use 'myagents task rerun {}' to re-dispatch it",
            ta.status.as_str(),
            ta.id
        ));
    }
    if let Some(execution) = crate::task_scheduler::get_task_scheduler()
        .execution_projection(id)
        .await
    {
        return Err(format!(
            "task {id} still has an unresolved {} execution; stop it before rerunning",
            execution.state.as_str()
        ));
    }

    crate::task_scheduler::validate_task_schedule(&ta)?;
    let (task, _) = task_store
        .update_status_with_task_control_held(
            task::TaskUpdateStatusInput {
                id: ta.id.clone(),
                status: task::TaskStatus::Running,
                message: Some("dispatched".to_string()),
                actor: task::TransitionActor::System,
                source: Some(task::TransitionSource::Scheduler),
            },
            task_control,
        )
        .await?;
    if let Err(error) = crate::task_scheduler::get_task_scheduler()
        .start_with_control_held(&task.id, task_control)
        .await
    {
        let _ = task_store
            .update_status_with_task_control_held(
                task::TaskUpdateStatusInput {
                    id: task.id.clone(),
                    status: task::TaskStatus::Blocked,
                    message: Some(format!("scheduler start failed: {error}")),
                    actor: task::TransitionActor::System,
                    source: Some(task::TransitionSource::Scheduler),
                },
                task_control,
            )
            .await;
        return Err(error);
    }
    Ok(task)
}

/// PRD §10.2.2 `POST /api/task/rerun` — reset the status back to `todo` (via
/// a proper audited transition) then invoke the `run` flow. Used when a task
/// is stuck in `blocked` / `stopped` / `done` / `archived` and the user wants
/// to try again from scratch.
async fn task_rerun_handler(Json(req): Json<TaskIdApiRequest>) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(task_control) = crate::task_scheduler::try_acquire_task_control(&req.id).await else {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("task {} is stopping or changing scheduler state; retry after it settles", req.id)
        }));
    };
    let ta = match task_store.get_ordinary(&req.id).await {
        Ok(task) => task,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };

    if !matches!(
        ta.status,
        task::TaskStatus::Blocked
            | task::TaskStatus::Stopped
            | task::TaskStatus::Done
            | task::TaskStatus::Archived
    ) {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("rerun only valid from blocked/stopped/done/archived; current = '{}'", ta.status.as_str())
        }));
    }

    // Step 1: reset → todo with source=rerun (PRD §10.2.1 caller-inference
    // table row "rerun").
    if let Some(execution) = crate::task_scheduler::get_task_scheduler()
        .execution_projection(&ta.id)
        .await
    {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("task {} still has an unresolved {} execution; retry stop before rerunning", ta.id, execution.state.as_str())
        }));
    }

    if let Err(e) = task_store
        .update_status_with_task_control_held(
            task::TaskUpdateStatusInput {
                id: ta.id.clone(),
                status: task::TaskStatus::Todo,
                message: Some("rerun requested".to_string()),
                actor: task::TransitionActor::System,
                source: Some(task::TransitionSource::Rerun),
            },
            &task_control,
        )
        .await
    {
        return Json(serde_json::json!({ "ok": false, "error": format!("reset failed: {}", e) }));
    }

    // Step 2: defer to the same path as `task/run`. Re-fetch to pick up the
    // fresh `todo` status.
    match run_task_by_id_with_control(&ta.id, &task_control).await {
        Ok(task) => Json(serde_json::json!({ "ok": true, "task": task })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskReadDocQuery {
    id: String,
    /// `task` | `verify` | `progress` — the md filename stem.
    doc: String,
}

/// `GET /api/task/read-doc?id=&doc=` — used by the `myagents task show-doc`
/// CLI so Agents running in a workspace can read a Task's markdown without
/// hardcoding the filesystem path (task docs live in the user profile dir
/// after v0.1.69, not in the workspace).
async fn task_read_doc_handler(
    axum::extract::Query(q): axum::extract::Query<TaskReadDocQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let ta = match store.get_ordinary(&q.id).await {
        Ok(task) => task,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    // Delegate to `task::task_doc_filename` so the Management API, Tauri
    // IPC, and any future doc-reading surface all share one whitelist —
    // preventing the v0.1.69 drift where Management accepted `alignment`
    // but Tauri IPC rejected it.
    let filename = match task::task_doc_filename(&q.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let dir = match task::task_docs_dir(&ta.id) {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let path = dir.join(filename);
    match std::fs::read_to_string(&path) {
        Ok(content) => Json(serde_json::json!({ "ok": true, "content": content })),
        // Missing file is not an error for the CLI — it means "no doc yet".
        // We still 200 and return empty content so scripting is idempotent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Json(serde_json::json!({ "ok": true, "content": "" }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("read {}: {}", filename, e),
        })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskWriteDocRequest {
    id: String,
    /// `task` | `verify` — `progress` is agent-only and rejected here.
    doc: String,
    content: String,
}

/// `POST /api/task/write-doc` — write `task.md` or `verify.md` for a Task.
/// Delegates to `TaskStore::write_doc`, which enforces the running/verifying
/// lock atomically with the file write (PRD §9.4). `progress.md` is
/// explicitly rejected here — only the runtime agent appends to it.
async fn task_write_doc_handler(Json(req): Json<TaskWriteDocRequest>) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    // Central whitelist via `task::task_doc_filename` — same contract as
    // read-doc. Then refuse writing progress.md / alignment.md (the Tauri
    // `cmd_task_write_doc` enforces the same rule, keeping both entry
    // points aligned).
    let filename = match task::task_doc_filename(&req.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    if filename == "progress.md" || filename == "alignment.md" {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!(
                "{} is not writable via this API (progress=agent-appended, alignment=skill-written)",
                filename
            ),
        }));
    }
    if let Err(error) = store.get_ordinary(&req.id).await {
        return Json(serde_json::json!({ "ok": false, "error": error }));
    }
    match store.write_doc(&req.id, filename, &req.content).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdApiRequest {
    id: String,
}

// ============================================================================
// IM Mirror — fan out desktop-driven session activity to a bound IM channel
// (PRD 0.2.14 Phase C).
//
// Sidecar calls this AFTER persisting a desktop user message and AFTER each
// AI text block completes. Rust looks up which IM channel currently binds
// `sessionId` (via `peer_sessions[*].session_id == sessionId`) and forwards
// the text (with `👤 桌面端用户消息` prefix for `role: user`, plain for
// `role: assistant`) plus any inline images.
//
// Tool calls / canUseTool / partial chunks are NOT mirrored (the Sidecar
// caller filters those out — see `agent-session.ts::mirrorIfChannelBound`).
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorRequest {
    session_id: String,
    /// "user" | "assistant"
    role: String,
    text: Option<String>,
    /// Optional inline images (base64 PNG/JPG). Sent after the text body.
    /// Each entry: { mimeType: "image/png" | "image/jpeg", dataBase64 }.
    images: Option<Vec<MirrorImage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorImage {
    mime_type: String,
    data_base64: String,
}

const DESKTOP_USER_PREFIX: &str = "[From: 桌面端用户消息]";
const MIRROR_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

async fn mirror_to_channel_handler(Json(req): Json<MirrorRequest>) -> Json<serde_json::Value> {
    let resolved = match im::session_delivery::find_channel_for_session(
        get_agents(),
        get_im_bots(),
        &req.session_id,
    )
    .await
    {
        Some(t) => t,
        None => {
            // Session has no channel binding — silent no-op (this is the
            // common case for pure-desktop sessions; we don't want noisy logs).
            return Json(serde_json::json!({ "mirrored": false }));
        }
    };
    let adapter = std::sync::Arc::clone(&resolved.adapter);
    let chat_id = resolved.chat_id.clone();
    let channel_id = resolved.channel_id.clone();

    // ----- Body text (with prefix for user role) -----
    //
    // PRD 0.2.14 — visual parity with native IM AI replies:
    //   * assistant role → `push_text_preferring_stream`. Adapters whose
    //     channels have a streaming protocol (Bridge plugins with
    //     `streaming: true` like OpenClaw Lark CardKit, Dingtalk AI Card)
    //     deliver the mirror via `start_stream → finalize_stream`, landing
    //     on the SAME visual surface as a live AI reply (CardKit /
    //     interactive card on Feishu via Bridge, AI Card on Dingtalk).
    //     Adapters that don't support streaming fall through to
    //     `send_message` (post-type bubble on native Feishu, plain text on
    //     Telegram). This is the helper documented at adapter.rs:244-289
    //     specifically for "out-of-band pushes that should match live
    //     reply style."
    //   * user role → plain `send_message`. The user-mirror has a `[From: …]`
    //     prefix and is conceptually a "system note about an external user
    //     event" — landing as a plain bubble is the desired visual
    //     (confirmed by dogfood: the user said the user-mirror bubble was
    //     correct, only the assistant-mirror needed CardKit treatment).
    let body = req.text.unwrap_or_default();
    let mut text_failed = false;
    let mut sent_text = false;
    if !body.is_empty() {
        let result = match req.role.as_str() {
            "user" => {
                let payload = format!("{}\n{}", DESKTOP_USER_PREFIX, body);
                adapter.send_message(&chat_id, &payload).await
            }
            _ => im::session_delivery::push_assistant_text(&resolved, &body).await,
        };
        match result {
            Ok(_) => sent_text = true,
            Err(e) => {
                ulog_warn!(
                    "[mirror] send_message failed channel={} session={}: {}",
                    channel_id,
                    &req.session_id[..8.min(req.session_id.len())],
                    e
                );
                text_failed = true;
            }
        }
    }

    // ----- Optional images (PNG/JPG only, 5MB cap each) -----
    //
    // Pre-decode size guard (review-by-codex M2): a 50MB base64 string
    // decodes to ~37.5MB binary which is rejected by `MIRROR_IMAGE_MAX_BYTES`
    // — but only AFTER we've already done the expensive `base64::decode`
    // allocation. Cap on the *encoded* length first so an attacker can't
    // amplify ~7x memory before being rejected.
    //
    // Formula: padded base64 inflates to `4 * ceil(bytes / 3)` chars.
    // MUST stay byte-for-byte equivalent to the Node-side
    // `MIRROR_IMAGE_MAX_BASE64_CHARS` in agent-session.ts:toMirrorImages
    // — otherwise the boundary 5 MiB image is accepted on one side and
    // rejected on the other (review-by-codex F4).
    const MIRROR_IMAGE_MAX_BASE64_LEN: usize = ((MIRROR_IMAGE_MAX_BYTES + 2) / 3) * 4 + 64;

    let mut sent_images = 0usize;
    let mut skipped_images = 0usize;
    if let Some(images) = req.images {
        // Capture total before consuming — needed so the break-on-error
        // path below can attribute the remaining unprocessed images to
        // `skipped_images` (review-by-codex F5). Without this, an early
        // break leaves the response's `imagesSkipped` undercounting and
        // hides "we silently dropped half the upload" from observability.
        let total_images = images.len();
        for (idx, img) in images.into_iter().enumerate() {
            // Whitelist MIME — the spec said PNG/JPG only.
            let (ext, ok_mime) = match img.mime_type.as_str() {
                "image/png" => ("png", true),
                "image/jpeg" | "image/jpg" => ("jpg", true),
                _ => ("bin", false),
            };
            if !ok_mime {
                skipped_images += 1;
                continue;
            }
            // Cheap encoded-size check BEFORE the decode allocation.
            if img.data_base64.len() > MIRROR_IMAGE_MAX_BASE64_LEN {
                ulog_debug!(
                    "[mirror] skip oversize image[{}] base64Len={}",
                    idx,
                    img.data_base64.len()
                );
                skipped_images += 1;
                continue;
            }
            let bytes = match base64_decode(&img.data_base64) {
                Some(b) => b,
                None => {
                    skipped_images += 1;
                    continue;
                }
            };
            if bytes.len() > MIRROR_IMAGE_MAX_BYTES {
                skipped_images += 1;
                continue;
            }
            let filename = format!("desktop-mirror-{}.{}", idx, ext);
            // Caption only on first image when paired with user text — keeps
            // the prefix visible alongside the visual.
            let caption = if req.role == "user" && !sent_text && idx == 0 {
                Some(DESKTOP_USER_PREFIX.to_string())
            } else {
                None
            };
            match adapter
                .send_photo(&chat_id, bytes, &filename, caption.as_deref())
                .await
            {
                Ok(_) => sent_images += 1,
                Err(e) => {
                    let remaining = total_images.saturating_sub(idx + 1);
                    ulog_warn!(
                        "[mirror] send_photo[{}] failed channel={}: {} — aborting, attributing {} remaining as skipped",
                        idx,
                        channel_id,
                        e,
                        remaining,
                    );
                    skipped_images += 1 + remaining;
                    // Break-on-transport-error (review-by-codex M4):
                    // adapter.send_photo failures are dominated by transport-
                    // class problems (network drop, expired auth, rate limit).
                    // Continuing the loop hammers the same dead leg N more
                    // times; better to surface what we sent and let the caller
                    // (or user) retry. Format-class errors are already
                    // filtered upstream by MIME whitelist + size cap, so
                    // here the failure is almost always transport. Remaining
                    // images counted into `skipped_images` so the response's
                    // `imagesSkipped` field stays observability-accurate.
                    break;
                }
            }
        }
    }

    Json(serde_json::json!({
        "mirrored": sent_text || sent_images > 0,
        "textSent": sent_text,
        "textFailed": text_failed,
        "imagesSent": sent_images,
        "imagesSkipped": skipped_images,
    }))
}

/// Standalone base64 decoder — keeps mirror handler dependency-free of any
/// crate not already pulled in by management_api.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s.trim()).ok()
}

// ========================================================================
// Session Inbox handlers (PRD 0.2.18)
// ========================================================================

/// Request body for `POST /api/inbox/deliver`. Wraps a `PendingInboxMessage`
/// plus optional `resume_workspace_path` for dead-session resume.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxDeliverRequest {
    message: crate::inbox::PendingInboxMessage,
    /// Optional workspace path (absolute) — when provided AND target session
    /// has no live sidecar, the target sidecar will be spawned with
    /// `resumeSessionId=<target_session_id>`. Caller sidecar (Node) reads
    /// this from its own SessionStore before invoking the management API.
    #[serde(default)]
    resume_workspace_path: Option<String>,
}

/// `POST /api/inbox/deliver` — sidecar-callable entry point for session inbox.
///
/// Invoked by:
///   - Caller sidecar's admin handler (POST /api/session/inbox) for request delivery
///   - Target sidecar's turn-end hook for reply pushback
///
/// Body: `{ message: PendingInboxMessage, resume_workspace_path?: string }`
async fn inbox_deliver_handler(Json(req): Json<InboxDeliverRequest>) -> Json<serde_json::Value> {
    let Some(manager) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "sidecar manager not initialized"
        }));
    };

    let resume_path = req
        .resume_workspace_path
        .as_ref()
        .map(std::path::PathBuf::from);

    let outcome = if resume_path.is_some() {
        let Some(app_handle) = crate::logger::get_app_handle() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": "global AppHandle not initialized — cannot resume dead session"
            }));
        };
        crate::inbox::deliver::deliver_with_resume(app_handle, manager, req.message, resume_path)
            .await
    } else {
        crate::inbox::deliver::deliver_inbox_message(manager, req.message).await
    };

    Json(serde_json::json!({
        "ok": true,
        "outcome": outcome,
    }))
}

/// `POST /api/session/watch` — register a one-shot cross-session watch.
///
/// The caller sidecar validates session metadata and passes watcher resume
/// information. Rust owns the live state observation because the SidecarManager
/// is the source of truth for running/starting/idle process state.
async fn session_watch_handler(
    Json(req): Json<crate::inbox::watch::SessionWatchRequest>,
) -> Json<serde_json::Value> {
    let Some(manager) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "sidecar manager not initialized"
        }));
    };
    let Some(app_handle) = crate::logger::get_app_handle() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "global AppHandle not initialized — cannot register session watch"
        }));
    };

    let result =
        crate::inbox::watch::register_session_watch(app_handle.clone(), manager.clone(), req).await;

    Json(serde_json::json!({
        "ok": true,
        "result": result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn grok_bearer_requires_the_current_sidecar_generation() {
        assert!(sidecar_identity_matches(Some(7), 7));
        assert!(!sidecar_identity_matches(Some(7), 6));
        assert!(!sidecar_identity_matches(None, 7));
    }

    #[test]
    fn grok_bearer_responses_are_never_cacheable() {
        let (headers, _) = no_store_json(serde_json::json!({ "ok": true }));
        assert_eq!(
            headers
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
    }

    #[test]
    fn goal_error_response_uses_structured_code() {
        let Json(response) = goal_error_json(
            GoalMutationError::stale_revision("expected 4, current 5"),
            None,
        );

        assert_eq!(
            response.get("code").and_then(Value::as_str),
            Some("stale_revision")
        );
        assert_eq!(
            response.get("error").and_then(Value::as_str),
            Some("stale_revision: expected 4, current 5")
        );
    }

    #[test]
    fn goal_create_request_defaults_and_deserializes_end_conditions() {
        let default_request: GoalCreateRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "workspacePath": "/tmp/workspace",
            "objective": "Ship it"
        }))
        .unwrap();
        assert_eq!(default_request.end_conditions, GoalEndConditions::default());

        let limited_request: GoalCreateRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "workspacePath": "/tmp/workspace",
            "objective": "Ship it",
            "endConditions": {
                "deadline": "2026-07-22T01:00:00.000Z",
                "maxExecutions": 5,
                "aiCanExit": false
            }
        }))
        .unwrap();
        assert_eq!(limited_request.end_conditions.max_executions, Some(5));
        assert!(!limited_request.end_conditions.ai_can_exit);
        assert_eq!(
            limited_request
                .end_conditions
                .deadline
                .expect("deadline")
                .to_rfc3339(),
            "2026-07-22T01:00:00+00:00"
        );
    }

    #[test]
    fn agent_reload_request_deserializes_presence_patch() {
        let request: AgentReloadConfigRequest = serde_json::from_value(serde_json::json!({
            "agentId": "agent-1",
            "patch": {
                "providerId": "codex-sub",
                "model": "gpt-5.6-sol",
                "permissionMode": "fullAgency",
                "providerEnvJson": null
            }
        }))
        .unwrap();

        assert_eq!(request.agent_id, "agent-1");
        assert_eq!(
            request.patch.provider_id,
            Some(Some("codex-sub".to_string()))
        );
        assert_eq!(request.patch.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(request.patch.permission_mode.as_deref(), Some("fullAgency"));
        assert_eq!(request.patch.provider_env_json, Some(None));
    }

    #[test]
    fn bridge_message_parses_request_scoped_openclaw_reply_protocol() {
        let payload: BridgeMessagePayload = serde_json::from_value(serde_json::json!({
            "botId": "bot-1",
            "pluginId": "openclaw-lark",
            "requestId": "request-1",
            "deliveryProtocol": "openclaw-reply",
            "senderId": "user-1",
            "accountId": "account-1",
            "text": "hello",
            "chatType": "direct",
            "chatId": "chat-1"
        }))
        .unwrap();

        assert_eq!(payload.request_id.as_deref(), Some("request-1"));
        assert_eq!(payload.account_id.as_deref(), Some("account-1"));
        assert_eq!(
            payload.delivery_protocol,
            Some(crate::im::types::ImDeliveryProtocol::OpenClawReply)
        );
    }

    #[test]
    fn space_cli_error_separates_failure_fact_from_recovery_direction() {
        let response =
            space_cli_error("SPACE_REQUIRED: This command requires --space <slug>.".to_string());
        assert_eq!(
            response.get("code").and_then(Value::as_str),
            Some("SPACE_REQUIRED")
        );
        assert_eq!(
            response.get("error").and_then(Value::as_str),
            Some("This command requires --space <slug>.")
        );
        assert_eq!(
            response.get("suggestedCommand").and_then(Value::as_str),
            Some("myagents space list --json")
        );
        assert!(response
            .get("suggestion")
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with("Run `myagents space list")));
    }

    #[test]
    fn space_cli_error_routes_goal_conflict_and_permission_recovery() {
        for code in ["GOAL_NOT_FOUND", "GOAL_IS_ARCHIVED"] {
            let response = space_cli_error(format!("{code}: Goal cannot be assigned."));
            assert_eq!(response.get("code").and_then(Value::as_str), Some(code));
            assert_eq!(
                response.get("suggestedCommand").and_then(Value::as_str),
                Some("myagents space goal list --space <slug> --json")
            );
            assert!(response
                .get("suggestion")
                .and_then(Value::as_str)
                .is_some_and(|value| value.contains("data.items[].id")));
        }

        let conflict = space_cli_error(
            "ISSUE_MUTATION_CONFLICT: Issue changed while applying mutation".to_string(),
        );
        assert_eq!(
            conflict.get("suggestedCommand").and_then(Value::as_str),
            Some("myagents space issue view <issueId> --space <slug> --json")
        );

        for code in [
            "SESSION_EXPIRED",
            "REGISTERED_AGENT_TOKEN_IS_INVALID_OR_REVOKED",
            "REGISTERED_AGENT_OWNER_MUST_BE_A_SPACE_OWNER_OR_ADMIN",
            "THIS_ISSUE_IS_OUTSIDE_THIS_REGISTERED_AGENT_SUBSCRIPTION",
            "ONLY_OWNER_ADMIN_OR_THE_CREATOR_OF_AN_OPEN_ISSUE_CAN_EDIT_IT",
        ] {
            let permission = space_cli_error(format!("{code}: Forbidden"));
            assert_eq!(permission.get("code").and_then(Value::as_str), Some(code));
            assert_eq!(
                permission.get("suggestedCommand").and_then(Value::as_str),
                Some("myagents space whoami --space <slug> --json")
            );
        }
    }

    #[tokio::test]
    async fn management_api_registers_goal_list_and_issue_update_routes() {
        let _mock = crate::space_cloud_mock::enable_for_test();
        let workspace = std::env::current_dir().expect("current workspace");
        let user_workspace =
            tempfile::tempdir_in(workspace).expect("User workspace inside project");
        let port = start_management_api()
            .await
            .expect("management API should start");
        let client = crate::local_http::json_client(std::time::Duration::from_secs(5));

        let goals = client
            .post(format!("http://127.0.0.1:{port}/api/space/goal-list"))
            .json(&serde_json::json!({
                "spaceSlug": "official",
                "includeArchived": false,
                "workspacePath": user_workspace.path()
            }))
            .send()
            .await
            .expect("goal-list route request")
            .json::<Value>()
            .await
            .expect("goal-list route response");
        assert_eq!(goals.get("ok").and_then(Value::as_bool), Some(true));
        assert!(goals
            .pointer("/data/items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty()));

        let updated = client
            .post(format!("http://127.0.0.1:{port}/api/space/issue-update"))
            .json(&serde_json::json!({
                "spaceSlug": "official",
                "issueId": "iss_mock_001",
                "title": "Updated through Management API",
                "workspacePath": user_workspace.path()
            }))
            .send()
            .await
            .expect("issue-update route request")
            .json::<Value>()
            .await
            .expect("issue-update route response");
        assert_eq!(updated.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            updated.pointer("/data/issue/title").and_then(Value::as_str),
            Some("Updated through Management API")
        );
    }

    #[test]
    fn cron_stop_response_preserves_authoritative_blocked_status() {
        let task: crate::task::Task = serde_json::from_value(serde_json::json!({
            "id": "blocked-task",
            "name": "blocked task",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "blocked",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        let response = cron_stop_success_response(&task);

        assert_eq!(
            response.get("taskId").and_then(Value::as_str),
            Some("blocked-task")
        );
        assert_eq!(
            response.get("status").and_then(Value::as_str),
            Some("blocked")
        );
    }

    #[tokio::test]
    async fn space_issue_comment_handler_wraps_mock_comment_result() {
        let _mock = crate::space_cloud_mock::enable_for_test();
        let workspace_path = std::env::current_dir()
            .expect("current workspace")
            .to_string_lossy()
            .to_string();

        let Json(comment_result) =
            space_issue_comment_handler(Json(crate::space_cloud::SpaceCliIssueCommentInput {
                issue_id: "iss_mock_004".to_string(),
                body: "management api comment".to_string(),
                space_slug: "official".to_string(),
                file_paths: Vec::new(),
                session_id: None,
                session_origin: None,
                workspace_id: None,
                agent_id: None,
                workspace_path: Some(workspace_path.clone()),
            }))
            .await;

        assert_eq!(
            comment_result.get("ok").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            comment_result
                .pointer("/data/comment/body")
                .and_then(Value::as_str),
            Some("management api comment")
        );
        let comment_id = comment_result
            .pointer("/data/comment/id")
            .and_then(Value::as_str)
            .expect("comment id")
            .to_string();
        let Json(exact_result) = space_issue_comment_get_handler(Json(
            crate::space_cloud::SpaceCliIssueCommentGetInput {
                issue_id: "iss_mock_004".to_string(),
                comment_id,
                space_slug: "official".to_string(),
                session_id: None,
                session_origin: None,
                workspace_id: None,
                agent_id: None,
                workspace_path: Some(workspace_path.clone()),
            },
        ))
        .await;
        assert_eq!(
            exact_result
                .pointer("/data/comment/body")
                .and_then(Value::as_str),
            Some("management api comment")
        );

        let Json(detail_result) =
            space_issue_get_handler(Json(crate::space_cloud::SpaceCliIssueGetInput {
                issue_id: "iss_mock_004".to_string(),
                space_slug: "official".to_string(),
                session_id: None,
                session_origin: None,
                workspace_id: None,
                agent_id: None,
                workspace_path: Some(workspace_path),
                comments_cursor: None,
                comments_limit: Some(5),
            }))
            .await;

        assert_eq!(detail_result.get("ok").and_then(Value::as_bool), Some(true));
        let comments = detail_result
            .pointer("/data/comments/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(comments
            .iter()
            .any(|comment| comment.get("body").and_then(Value::as_str)
                == Some("management api comment")));
    }
}
