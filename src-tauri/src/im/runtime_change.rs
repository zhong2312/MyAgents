//! Runtime-change session detach (v0.2.14 dogfood fix).
//!
//! Backstory: every IM session is created with `snapshotForImSession()` in
//! `src/server/utils/session-snapshot.ts`, which stores ONLY the session's
//! `runtime` and leaves `model / permissionMode / mcpEnabledServers /
//! providerId / providerRoute / providerEnvJson / configSnapshotAt` undefined — the D4
//! "live-follow agent config" policy. Works fine while runtime is stable.
//!
//! Runtime change is the one config delta D4 cannot live-follow: an SDK
//! conversation under runtime A cannot be resumed under runtime B because
//! the on-disk session format is runtime-specific (Claude Code's signed
//! transcript, Codex's threadId, builtin's SDK message log, …). Forcing a
//! cross-runtime resume gets you "Session ID is already in use" + 404
//! errors on the next message — exactly what dogfood hit.
//!
//! This module orchestrates the fix: when an agent's runtime is about to
//! change, every bot-bound session in that agent is "frozen" with the
//! agent's about-to-be-replaced config (matching the desktop session
//! snapshot policy from `snapshotForOwnedSession`), then the binding's
//! `peer_session.session_id` is rotated to a fresh UUID and the channel
//! is notified. The result:
//!
//!   * Old session → detached from the bot, fully self-contained snapshot.
//!     Reopening it from desktop's session history works exactly like any
//!     other historical session — sidecar boots with the OLD runtime +
//!     OLD model/provider/mcp/permission, picking those from session
//!     metadata via the existing `configSnapshotAt`-driven snapshot path.
//!   * New session_id → empty, no sidecar yet. Next IM message arriving
//!     for the channel spawns a fresh sidecar with the NEW runtime.
//!   * IM user → sees a one-line notification explaining the switch +
//!     the new session's 8-char prefix (matching `/new` IM affordance).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

use super::adapter::ImAdapter;
use super::health;
use super::types::ImSourceType;
use super::ImBotInstance;
use crate::sidecar::{release_session_sidecar, ManagedSidecarManager, SidecarOwner};
use crate::utils::file_lock::{with_file_lock, FileLockOptions};
use crate::{ulog_info, ulog_warn};

const SUBSCRIPTION_PROVIDER_ID: &str = "anthropic-sub";

/// Payload of the Channel config that was active when the session was
/// detached". MUST stay aligned with the TS Pick in
/// `src/server/utils/session-snapshot.ts::OwnedSessionSnapshot` (sans
/// `configSnapshotAt` — that field is a writer-stamped marker, not part of
/// the payload, set by both the sidecar `/api/session/freeze` endpoint and
/// the Rust file-lock fallback writer to "now" at write time).
///
pub struct OwnedSessionSnapshot {
    runtime: String,
    runtime_source: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    mcp_enabled_servers: Option<Vec<String>>,
    provider_id: Option<String>,
    provider_route: Option<Value>,
    provider_execution_identity: Option<Value>,
    provider_env_json: Option<String>,
}

impl OwnedSessionSnapshot {
    fn to_json(&self) -> Value {
        // configSnapshotAt is intentionally omitted — both the sidecar
        // freeze endpoint AND the file-lock fallback below stamp `now`
        // themselves, so the marker reflects when the write actually
        // committed (not when Rust composed the payload).
        let mut obj = serde_json::Map::new();
        obj.insert("runtime".into(), json!(self.runtime));
        if let Some(ref source) = self.runtime_source {
            obj.insert("runtimeSource".into(), json!(source));
        }
        if let Some(ref m) = self.model {
            obj.insert("model".into(), json!(m));
        }
        if let Some(ref pm) = self.permission_mode {
            obj.insert("permissionMode".into(), json!(pm));
        }
        if let Some(ref mcp) = self.mcp_enabled_servers {
            obj.insert("mcpEnabledServers".into(), json!(mcp));
        }
        if let Some(ref pid) = self.provider_id {
            obj.insert("providerId".into(), json!(pid));
        }
        if let Some(ref route) = self.provider_route {
            obj.insert("providerRoute".into(), route.clone());
        }
        if let Some(ref identity) = self.provider_execution_identity {
            obj.insert("providerExecutionIdentity".into(), identity.clone());
        }
        if self.provider_route.is_none() {
            if let Some(ref penv) = self.provider_env_json {
                obj.insert("providerEnvJson".into(), json!(penv));
            }
        }
        Value::Object(obj)
    }
}

fn provider_route_json(provider_id: Option<&str>, model: Option<&str>) -> Option<Value> {
    let provider_id = provider_id?;
    let model = model?;
    if provider_id.is_empty() || model.is_empty() {
        return None;
    }
    Some(json!({
        "kind": if provider_id == SUBSCRIPTION_PROVIDER_ID { "subscription" } else { "provider" },
        "providerId": provider_id,
        "model": model,
    }))
}

fn runtime_source_from_config(runtime_config: Option<&serde_json::Value>) -> Option<String> {
    match runtime_config
        .and_then(|v| v.get("source"))
        .and_then(|v| v.as_str())
    {
        Some("managed-provider") => Some("managed-provider".to_string()),
        Some("system-cli") => Some("system-cli".to_string()),
        _ => None,
    }
}

fn managed_codex_identity_json(model: Option<&str>) -> Option<Value> {
    let model = model?;
    if model.is_empty() {
        return None;
    }
    Some(json!({
        "kind": "runtime-backed-provider",
        "providerId": "codex-sub",
        "runtime": "codex",
        "runtimeSource": "managed-provider",
        "model": model,
    }))
}

fn enabled_mcp_ids_from_servers_json(raw: Option<&str>) -> Option<Vec<String>> {
    raw.and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
        .map(|servers| {
            servers
                .iter()
                // Renderer/runtime `mcpServersJson` is already the enabled
                // definition list and does not carry an `enabled` field.
                // Older/full-list writers that explicitly set enabled=false
                // still opt out here.
                .filter(|s| s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
                .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
}

/// Build the OwnedSessionSnapshot from one channel's CURRENT live-follow state.
///
/// Used by `/new` when the peer session has already released its sidecar
/// (`sidecar_port == 0`): there is no Node process to ask for held/live state,
/// so the router freezes the old session with the channel's current live
/// Agent/Channel config before rotating the binding.
pub async fn build_snapshot_from_channel_state(
    runtime: &tokio::sync::RwLock<String>,
    current_model: &tokio::sync::RwLock<Option<String>>,
    permission_mode: &tokio::sync::RwLock<String>,
    mcp_servers_json: &tokio::sync::RwLock<Option<String>>,
    runtime_config: &tokio::sync::RwLock<Option<serde_json::Value>>,
    provider_id: Option<String>,
    current_provider_env: &tokio::sync::RwLock<Option<Value>>,
) -> OwnedSessionSnapshot {
    let runtime_value = runtime.read().await.clone();
    let runtime_config_value = runtime_config.read().await.clone();
    let model_value = current_model.read().await.clone();
    let mcp_servers_json_value = mcp_servers_json.read().await.clone();
    let provider_env_value = current_provider_env.read().await.clone();
    let is_external = runtime_value != "builtin";
    let live_provider_id = provider_env_value
        .as_ref()
        .and_then(|v| v.get("providerId"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let runtime_source = runtime_source_from_config(runtime_config_value.as_ref());
    let provider_id_for_snapshot = if runtime_source.as_deref() == Some("managed-provider") {
        Some("codex-sub".to_string())
    } else if is_external {
        None
    } else {
        live_provider_id.or(provider_id).or_else(|| {
            if provider_env_value.is_none() && model_value.is_some() {
                Some(SUBSCRIPTION_PROVIDER_ID.to_string())
            } else {
                None
            }
        })
    };
    let route = if is_external {
        None
    } else {
        provider_route_json(provider_id_for_snapshot.as_deref(), model_value.as_deref())
    };
    let provider_execution_identity = if runtime_source.as_deref() == Some("managed-provider") {
        managed_codex_identity_json(model_value.as_deref())
    } else {
        None
    };
    OwnedSessionSnapshot {
        runtime: runtime_value,
        runtime_source,
        model: model_value.clone(),
        permission_mode: Some(permission_mode.read().await.clone()),
        mcp_enabled_servers: enabled_mcp_ids_from_servers_json(mcp_servers_json_value.as_deref()),
        provider_id: provider_id_for_snapshot,
        provider_route: route,
        provider_execution_identity,
        provider_env_json: if is_external {
            None
        } else {
            provider_env_value.as_ref().map(|v| v.to_string())
        },
    }
}

/// Push the snapshot into the running sidecar via HTTP (`/api/session/freeze`).
/// Returns `Ok(())` on 2xx, otherwise a `String` describing the failure for
/// the caller to log + fall back to the Rust file-lock writer.
async fn freeze_via_sidecar(
    http: &reqwest::Client,
    port: u16,
    session_id: &str,
    snapshot_json: &Value,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/session/freeze", port);
    let resp = http
        .post(&url)
        .json(&json!({
            "sessionId": session_id,
            "snapshot": snapshot_json,
        }))
        .send()
        .await
        .map_err(|e| format!("freeze HTTP send failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("freeze returned {}: {}", status, body));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileLockFreezeOutcome {
    Frozen,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeerFileLockFreezeDisposition {
    Frozen,
    MissingBirthPending,
    MissingUnindexedPeerSession,
}

pub(crate) fn resolve_peer_file_lock_freeze_outcome(
    outcome: FileLockFreezeOutcome,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
    session_id: &str,
) -> Result<PeerFileLockFreezeDisposition, String> {
    match outcome {
        FileLockFreezeOutcome::Frozen => Ok(PeerFileLockFreezeDisposition::Frozen),
        FileLockFreezeOutcome::Missing if metadata_birth_pending => {
            Ok(PeerFileLockFreezeDisposition::MissingBirthPending)
        }
        FileLockFreezeOutcome::Missing if !metadata_indexed => {
            Ok(PeerFileLockFreezeDisposition::MissingUnindexedPeerSession)
        }
        FileLockFreezeOutcome::Missing => {
            Err(format!("session {} not found in sessions.json", session_id))
        }
    }
}

/// Rust fallback writer — used when the session's sidecar is dead at freeze
/// time (port==0 from a prior `release_all_sidecars_preserve_bindings` or a
/// natural exit). We still need the session to carry its OLD config so that
/// a future desktop reopen behaves correctly; without this, the session's
/// metadata stays D4-shaped (runtime field only) and the reopen would pick
/// up the agent's NEW runtime config — same bug we're trying to avoid.
///
/// Uses the SAME on-disk `~/.myagents/sessions.lock` that the Node sidecar's
/// `withSessionsLock` uses (`SessionStore.ts:32`). This is a cross-process
/// writer pair, so the lock convention MUST match exactly.
pub(crate) async fn freeze_via_file_lock_status(
    session_id: &str,
    snapshot: &OwnedSessionSnapshot,
) -> Result<FileLockFreezeOutcome, String> {
    let myagents_dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "MyAgents data dir unavailable".to_string())?;
    let sessions_path = myagents_dir.join("sessions.json");
    let tmp_path = myagents_dir.join("sessions.json.tmp");
    let lock_path = myagents_dir.join("sessions.lock");

    // Pre-build the JSON value the snapshot would write — done OUTSIDE the
    // closure so all the borrowed `&self` fields stay on the async side.
    let snapshot_json = snapshot.to_json();
    let session_id_owned = session_id.to_string();

    let result = with_file_lock(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<FileLockFreezeOutcome, crate::utils::file_lock::FileLockError> {
            let content = match std::fs::read_to_string(&sessions_path) {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(FileLockFreezeOutcome::Missing);
                }
                Err(e) => {
                    return Err(crate::utils::file_lock::FileLockError::Io(e));
                }
            };
            let mut sessions: Value = serde_json::from_str(&content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("parse sessions.json: {}", e),
                ))
            })?;
            let arr = match sessions.as_array_mut() {
                Some(a) => a,
                None => {
                    return Err(crate::utils::file_lock::FileLockError::Io(
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "sessions.json must contain a SessionMetadata array",
                        ),
                    ));
                }
            };
            let mut found = false;
            for entry in arr.iter_mut() {
                if entry.get("id").and_then(|v| v.as_str()) == Some(session_id_owned.as_str()) {
                    if let Some(obj) = entry.as_object_mut() {
                        if let Some(snap_obj) = snapshot_json.as_object() {
                            for (k, v) in snap_obj {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                        // Stamp the freeze marker. Same convention as the
                        // sidecar endpoint: write happens here = "now" lives
                        // here. ISO-8601 to match Node `new Date().toISOString()`.
                        let now = chrono::Utc::now()
                            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                            .to_string();
                        obj.insert("configSnapshotAt".into(), json!(now));
                        found = true;
                        break;
                    }
                }
            }
            if !found {
                return Ok(FileLockFreezeOutcome::Missing);
            }

            let new_content = serde_json::to_string_pretty(&sessions).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("serialize sessions.json: {}", e),
                ))
            })?;
            std::fs::write(&tmp_path, new_content)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            std::fs::rename(&tmp_path, &sessions_path)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            Ok(FileLockFreezeOutcome::Frozen)
        },
    )
    .await;

    match result {
        Ok(outcome) => Ok(outcome),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn freeze_via_file_lock(
    session_id: &str,
    snapshot: &OwnedSessionSnapshot,
) -> Result<(), String> {
    match freeze_via_file_lock_status(session_id, snapshot).await? {
        FileLockFreezeOutcome::Frozen => Ok(()),
        FileLockFreezeOutcome::Missing => {
            Err(format!("session {} not found in sessions.json", session_id))
        }
    }
}

fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

#[derive(Debug)]
struct RuntimeChangeNotification {
    chat_id: String,
    text: String,
    source_type: ImSourceType,
    last_active: Instant,
    session_key: String,
    new_session_id: String,
}

fn source_type_priority(source_type: &ImSourceType) -> u8 {
    match source_type {
        ImSourceType::Private => 1,
        ImSourceType::Group => 0,
    }
}

fn should_replace_notification_candidate(
    existing: &RuntimeChangeNotification,
    candidate: &RuntimeChangeNotification,
) -> bool {
    let existing_priority = source_type_priority(&existing.source_type);
    let candidate_priority = source_type_priority(&candidate.source_type);
    candidate_priority > existing_priority
        || (candidate_priority == existing_priority && candidate.last_active > existing.last_active)
}

/// For one Channel, freeze each peer session (HTTP if sidecar is
/// alive, file-lock fallback otherwise), rotate session_id to a fresh UUID,
/// release the old Agent owner, and push one notification per IM delivery target.
///
/// Caller (`cmd_update_agent_config` runtime branch) is responsible for:
///
///   * Comparing old/new effective identities for this same Channel.
///   * Capturing the old snapshot before mutating the Channel's live config.
///
/// Errors per peer_session are logged + swallowed — partial success is
/// preferable to refusing to apply the runtime change and leaving the user
/// in a confused state.
pub async fn freeze_and_rotate_for_runtime_change(
    agent_id: &str,
    channel_id: &str,
    bot_instance: &ImBotInstance,
    old_runtime: &str,
    new_runtime: &str,
    sidecar_manager: &ManagedSidecarManager,
    snapshot: OwnedSessionSnapshot,
) {
    let snapshot_json = snapshot.to_json();

    // Reuse a single short-timeout HTTP client across all freeze calls.
    // Localhost only — `local_http::builder()` per the project red-line.
    // Build failure is non-fatal: we log it and proceed; every per-session
    // freeze attempt below will then go straight to the file-lock fallback,
    // which is fully functional without HTTP. (review-by-codex F4: original
    // returned early here, leaving bindings completely un-rotated.)
    let http: Option<reqwest::Client> = match crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => Some(c),
        Err(e) => {
            ulog_warn!(
                "[runtime-change] HTTP client build failed ({}); all freezes will use file-lock fallback",
                e
            );
            None
        }
    };

    let mut total_bindings = 0usize;
    let mut frozen_via_sidecar = 0usize;
    let mut frozen_via_fallback = 0usize;
    let mut skipped_missing_unindexed = 0usize;
    let mut skipped_persistent_owner = 0usize;
    let mut rotated = 0usize;
    let mut notified = 0usize;
    let mut notification_targets = 0usize;
    let mut deduped_notifications = 0usize;

    let adapter = bot_instance.adapter.clone();
    let health = bot_instance.health.clone();
    let mut pending_notifications: HashMap<String, RuntimeChangeNotification> = HashMap::new();
    let mut channel_rotated = 0usize;

    {
        let mut router = bot_instance.router.lock().await;
        let keys: Vec<String> = router.peer_session_keys();

        for key in keys {
            total_bindings += 1;

            // Snapshot prior session for chat_id + sidecar port, then rotate.
            let prior = match router.peer_session_snapshot(&key) {
                Some(p) => p,
                None => continue, // race: removed under us — skip safely
            };
            let old_session_id = prior.session_id.clone();
            let port = prior.sidecar_port;
            let chat_id = prior.source_id.clone();
            let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&old_session_id]).await;
            match crate::sidecar::has_persisted_session_owner(&old_session_id).await {
                Ok(false) => {}
                Ok(true) => {
                    skipped_persistent_owner += 1;
                    ulog_info!(
                            "[runtime-change] preserving session {} while it has a persistent Goal/task owner",
                            short_id(&old_session_id)
                        );
                    continue;
                }
                Err(error) => {
                    skipped_persistent_owner += 1;
                    ulog_warn!(
                        "[runtime-change] preserving session {} because owner lookup failed: {}",
                        short_id(&old_session_id),
                        error
                    );
                    continue;
                }
            }

            // ----- 1. Freeze old session (HTTP if alive AND client built;
            //         file-lock fallback otherwise). The two paths must be
            //         symmetric — both stamp configSnapshotAt=now and merge
            //         only present snapshot fields (review-by-codex F2).
            let try_http = port != 0 && http.is_some();
            if try_http {
                let client = http.as_ref().unwrap();
                match freeze_via_sidecar(client, port, &old_session_id, &snapshot_json).await {
                    Ok(()) => {
                        frozen_via_sidecar += 1;
                        ulog_info!(
                            "[runtime-change] froze session {} via sidecar port {}",
                            short_id(&old_session_id),
                            port
                        );
                    }
                    Err(e) => {
                        ulog_warn!(
                                "[runtime-change] sidecar freeze failed (channel={} session={}): {} — falling back to file lock",
                                channel_id,
                                short_id(&old_session_id),
                                e
                            );
                        match freeze_via_file_lock_status(&old_session_id, &snapshot)
                            .await
                            .and_then(|outcome| {
                                resolve_peer_file_lock_freeze_outcome(
                                    outcome,
                                    prior.metadata_birth_pending,
                                    prior.metadata_indexed,
                                    &old_session_id,
                                )
                            }) {
                            Ok(PeerFileLockFreezeDisposition::Frozen) => {
                                frozen_via_fallback += 1;
                                ulog_info!(
                                            "[runtime-change] froze session {} via file lock (sidecar fallback)",
                                            short_id(&old_session_id)
                                        );
                            }
                            Ok(PeerFileLockFreezeDisposition::MissingBirthPending) => {
                                skipped_missing_unindexed += 1;
                                ulog_info!(
                                            "[runtime-change] skipped freeze for birth-pending session {} missing from SessionStore (sidecar fallback)",
                                            short_id(&old_session_id)
                                        );
                            }
                            Ok(PeerFileLockFreezeDisposition::MissingUnindexedPeerSession) => {
                                skipped_missing_unindexed += 1;
                                ulog_info!(
                                            "[runtime-change] skipped freeze for unindexed peer session {} missing from SessionStore (sidecar fallback)",
                                            short_id(&old_session_id)
                                        );
                            }
                            Err(e2) => ulog_warn!(
                                "[runtime-change] file-lock freeze ALSO failed for session {}: {}",
                                short_id(&old_session_id),
                                e2
                            ),
                        }
                    }
                }
            } else {
                // Sidecar dead (port==0 from previous preserve_bindings) OR
                // HTTP client failed to build. Go straight to file-lock.
                match freeze_via_file_lock_status(&old_session_id, &snapshot)
                    .await
                    .and_then(|outcome| {
                        resolve_peer_file_lock_freeze_outcome(
                            outcome,
                            prior.metadata_birth_pending,
                            prior.metadata_indexed,
                            &old_session_id,
                        )
                    }) {
                    Ok(PeerFileLockFreezeDisposition::Frozen) => {
                        frozen_via_fallback += 1;
                        ulog_info!(
                                "[runtime-change] froze session {} via file lock (no HTTP path available)",
                                short_id(&old_session_id)
                            );
                    }
                    Ok(PeerFileLockFreezeDisposition::MissingBirthPending) => {
                        skipped_missing_unindexed += 1;
                        ulog_info!(
                                "[runtime-change] skipped freeze for birth-pending session {} missing from SessionStore (no HTTP path available)",
                                short_id(&old_session_id)
                            );
                    }
                    Ok(PeerFileLockFreezeDisposition::MissingUnindexedPeerSession) => {
                        skipped_missing_unindexed += 1;
                        ulog_info!(
                                "[runtime-change] skipped freeze for unindexed peer session {} missing from SessionStore (no HTTP path available)",
                                short_id(&old_session_id)
                            );
                    }
                    Err(e) => ulog_warn!(
                        "[runtime-change] file-lock freeze failed for session {}: {}",
                        short_id(&old_session_id),
                        e
                    ),
                }
            }

            // ----- 2. Mint fresh session_id and rotate the binding.
            //         `last_active = Instant::now()` matches every other
            //         peer_session creation site (`add_peer_session` /
            //         `handover.rs::cmd_handover_session_to_channel` step 5);
            //         keeping the prior's stale timestamp would make the
            //         fresh binding look "old" to most_recent_peer_session_key
            //         and similar last-write-wins selectors.
            //         (review-by-codex F4.)
            let new_session_id = Uuid::new_v4().to_string();
            let mut new_peer = prior.clone();
            new_peer.session_id = new_session_id.clone();
            new_peer.sidecar_port = 0; // next IM message spawns a fresh sidecar with NEW runtime
            new_peer.message_count = 0;
            new_peer.metadata_birth_pending = true;
            new_peer.metadata_indexed = false;
            new_peer.last_active = Instant::now();
            router.upsert_peer_session(new_peer);
            rotated += 1;
            channel_rotated += 1;
            ulog_info!(
                "[runtime-change] rotated peer_session {} → {} (channel={})",
                short_id(&old_session_id),
                short_id(&new_session_id),
                channel_id,
            );

            // ----- 3. Release the OLD session's Agent owner. The sidecar
            // dies if no other owner remains (typical case for IM-only
            // bindings); a desktop tab on the same session keeps its
            // sidecar alive (Tab owner persists), and that's correct —
            // the user gets to keep using the old session as a regular
            // historical session backed by the snapshot we just wrote.
            let owner = SidecarOwner::Agent(key.clone());
            let _ = release_session_sidecar(sidecar_manager, &old_session_id, &owner);

            // ----- 4. Queue one notification per actual adapter delivery
            // target. A channel can temporarily contain stale duplicate
            // peer bindings that collapse to the same Feishu/OpenClaw
            // chatId; rotating them all is correct, but user-facing
            // management messages must be per delivered conversation.
            let candidate = RuntimeChangeNotification {
                chat_id: chat_id.clone(),
                text: format!(
                    "Agent 工作区 Runtime 从「{}」更新为「{}」，开始新会话（{}）",
                    old_runtime,
                    new_runtime,
                    short_id(&new_session_id),
                ),
                source_type: prior.source_type.clone(),
                last_active: prior.last_active,
                session_key: key,
                new_session_id,
            };
            if let Some(existing) = pending_notifications.get_mut(&chat_id) {
                deduped_notifications += 1;
                if should_replace_notification_candidate(existing, &candidate) {
                    ulog_info!(
                            "[runtime-change] coalesced duplicate notification target channel={} chat={} replacing session_key={} new_session={} with session_key={} new_session={}",
                            channel_id,
                            chat_id,
                            existing.session_key,
                            short_id(&existing.new_session_id),
                            candidate.session_key,
                            short_id(&candidate.new_session_id),
                        );
                    *existing = candidate;
                } else {
                    ulog_info!(
                            "[runtime-change] coalesced duplicate notification target channel={} chat={} keeping session_key={} new_session={}, skipped session_key={} new_session={}",
                            channel_id,
                            chat_id,
                            existing.session_key,
                            short_id(&existing.new_session_id),
                            candidate.session_key,
                            short_id(&candidate.new_session_id),
                        );
                }
            } else {
                pending_notifications.insert(chat_id, candidate);
            }
        }
    }

    if channel_rotated > 0 {
        let _ = health::persist_router_active_sessions(
            &health,
            &bot_instance.router,
            "runtime-change-rotation",
        )
        .await;
    }

    notification_targets += pending_notifications.len();
    for notification in pending_notifications.into_values() {
        match adapter
            .send_message(&notification.chat_id, &notification.text)
            .await
        {
            Ok(_) => {
                notified += 1;
                ulog_info!(
                    "[runtime-change] notified channel={} chat={} session_key={} new_session={}",
                    channel_id,
                    notification.chat_id,
                    notification.session_key,
                    short_id(&notification.new_session_id),
                );
            }
            Err(e) => ulog_warn!(
                "[runtime-change] notification send failed (channel={} chat={} session_key={}): {}",
                channel_id,
                notification.chat_id,
                notification.session_key,
                e
            ),
        }
    }

    if total_bindings > 0 {
        ulog_info!(
            "[runtime-change] agent={} {} → {}: bindings={} frozen(sidecar={}, fallback={}) skipped_missing_unindexed={} skipped_persistent_owner={} rotated={} notification_targets={} notified={} deduped_notifications={}",
            agent_id,
            old_runtime,
            new_runtime,
            total_bindings,
            frozen_via_sidecar,
            frozen_via_fallback,
            skipped_missing_unindexed,
            skipped_persistent_owner,
            rotated,
            notification_targets,
            notified,
            deduped_notifications,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        chat_id: &str,
        source_type: ImSourceType,
        last_active: Instant,
        session_key: &str,
        new_session_id: &str,
    ) -> RuntimeChangeNotification {
        RuntimeChangeNotification {
            chat_id: chat_id.to_string(),
            text: String::new(),
            source_type,
            last_active,
            session_key: session_key.to_string(),
            new_session_id: new_session_id.to_string(),
        }
    }

    #[test]
    fn notification_candidate_prefers_private_over_group_for_same_delivery_target() {
        let now = Instant::now();
        let existing = candidate(
            "ou_123",
            ImSourceType::Group,
            now + Duration::from_secs(10),
            "agent:a:openclaw:feishu:group:ou_123",
            "group-new",
        );
        let private = candidate(
            "ou_123",
            ImSourceType::Private,
            now,
            "agent:a:openclaw:feishu:private:ou_123",
            "private-new",
        );

        assert!(should_replace_notification_candidate(&existing, &private));
    }

    #[test]
    fn notification_candidate_prefers_more_recent_same_source_type() {
        let now = Instant::now();
        let existing = candidate(
            "oc_123",
            ImSourceType::Group,
            now,
            "agent:a:openclaw:feishu:group:oc_123",
            "older-new",
        );
        let newer = candidate(
            "oc_123",
            ImSourceType::Group,
            now + Duration::from_secs(10),
            "agent:a:openclaw:feishu:group:oc_123",
            "newer-new",
        );

        assert!(should_replace_notification_candidate(&existing, &newer));
        assert!(!should_replace_notification_candidate(&newer, &existing));
    }

    #[test]
    fn mcp_snapshot_treats_runtime_json_as_enabled_definition_list() {
        let raw = serde_json::json!([
            { "id": "remote-http", "type": "http", "url": "https://example.test/mcp" },
            { "id": "disabled-legacy", "enabled": false }
        ])
        .to_string();

        assert_eq!(
            enabled_mcp_ids_from_servers_json(Some(&raw)),
            Some(vec!["remote-http".to_string()])
        );
    }

    #[test]
    fn missing_file_lock_freeze_is_skipped_for_unindexed_peer_sessions() {
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Frozen,
                false,
                true,
                "persisted-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::Frozen
        );
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Missing,
                true,
                false,
                "birth-pending-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::MissingBirthPending
        );
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Missing,
                false,
                false,
                "legacy-unindexed-peer-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::MissingUnindexedPeerSession
        );

        let err = resolve_peer_file_lock_freeze_outcome(
            FileLockFreezeOutcome::Missing,
            false,
            true,
            "persisted-session",
        )
        .unwrap_err();
        assert_eq!(err, "session persisted-session not found in sessions.json");
    }
}
