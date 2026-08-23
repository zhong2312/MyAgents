//! Session ↔ Channel surface handover (PRD 0.2.14).
//!
//! Two Tauri commands surface here:
//!
//! * [`cmd_session_new_with_surface_migration`] — desktop user clicks "+新对话"
//!   on a channel-bound session. The exact participating Tab + Agent owners,
//!   Router binding, and Node Runtime move together to a fresh `session_id`.
//!   This is deliberately different from IM `/new`, which only rotates the
//!   Agent binding and leaves every other owner on the source Session.
//!
//! * [`cmd_handover_session_to_channel`] — desktop user clicks the 📤 button on
//!   a pure-desktop session and picks a target channel. The channel's prior
//!   binding (if any) is replaced; the desktop session gains a
//!   `SidecarOwner::Agent(session_key)` so subsequent IM messages route into it.
//!
//! Heavy lifting reuses what already exists:
//!
//! * [`super::router::SessionRouter::stage_surface_session_migration`] updates
//!   the single Router authority after exact owner admission.
//! * [`crate::sidecar::ensure_session_sidecar`] / [`crate::sidecar::release_session_sidecar`]
//!   manage the `SidecarOwner::Agent` lifetime.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::health::{self, HealthManager};
use super::router::{parse_session_key, peer_binding_source_requires_freeze, SessionRouter};
use super::runtime_change;
use super::types::{ImSourceType, LastActiveChannel, LastActivePrivateTarget, PeerSession};
use super::{ImConsumers, ManagedAgents, PeerLocks};
use crate::sidecar::{
    ensure_session_sidecar_with_lifecycle, release_session_sidecar, ManagedSidecarManager,
    SidecarOwner,
};
use crate::{ulog_info, ulog_warn};

struct ChannelRuntimeRefs {
    channel_id: String,
    router: std::sync::Arc<tokio::sync::Mutex<SessionRouter>>,
    health: std::sync::Arc<HealthManager>,
    consumers: ImConsumers,
}

async fn acquire_peer_operation_fence(
    peer_locks: &PeerLocks,
    session_key: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let peer_lock = {
        let mut locks = peer_locks.lock().await;
        locks
            .entry(session_key.to_string())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    peer_lock.lock_owned().await
}

fn target_consumer_needs_cancel(
    prior_session_id: Option<&str>,
    prior_sidecar_port: Option<u16>,
    next_session_id: &str,
    next_sidecar_port: u16,
) -> bool {
    let session_changed = prior_session_id
        .map(|prior| prior != next_session_id)
        .unwrap_or(false);
    let port_changed = prior_sidecar_port
        .map(|prior| prior != next_sidecar_port)
        .unwrap_or(false);
    session_changed || port_changed
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use serde_json::Value;
    use tokio::sync::{oneshot, Mutex as AsyncMutex};

    use super::{
        acquire_peer_operation_fence, freeze_current_via_sidecar, migrate_surface_via_sidecar,
        target_consumer_needs_cancel,
    };

    #[tokio::test]
    async fn handover_peer_fence_waits_for_an_inflight_im_operation() {
        let peer_locks = Arc::new(AsyncMutex::new(std::collections::HashMap::new()));
        let first = acquire_peer_operation_fence(&peer_locks, "agent:a:weixin:private:user").await;
        let (acquired_tx, mut acquired_rx) = oneshot::channel();
        let waiter = tauri::async_runtime::spawn({
            let peer_locks = Arc::clone(&peer_locks);
            async move {
                let _second =
                    acquire_peer_operation_fence(&peer_locks, "agent:a:weixin:private:user").await;
                let _ = acquired_tx.send(());
            }
        });

        tokio::task::yield_now().await;
        assert!(matches!(
            acquired_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        drop(first);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("handover waiter should acquire the shared fence")
            .expect("handover waiter should not panic");
        assert!(acquired_rx.await.is_ok());
    }

    #[test]
    fn target_consumer_cancel_is_required_when_handover_replaces_session() {
        assert!(target_consumer_needs_cancel(
            Some("prior-session"),
            Some(31415),
            "next-session",
            31415,
        ));
    }

    #[test]
    fn target_consumer_cancel_is_required_when_sidecar_port_changes() {
        assert!(target_consumer_needs_cancel(
            Some("same-session"),
            Some(31415),
            "same-session",
            31416,
        ));
    }

    #[test]
    fn target_consumer_can_be_reused_for_same_session_and_port() {
        assert!(!target_consumer_needs_cancel(
            Some("same-session"),
            Some(31415),
            "same-session",
            31415,
        ));
    }

    #[tokio::test]
    async fn freeze_current_via_sidecar_sends_metadata_indexed_flag() {
        let (tx, rx) = oneshot::channel::<Value>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let app = Router::new().route(
            "/api/session/freeze-current",
            post({
                let tx = tx.clone();
                move |Json(payload): Json<Value>| {
                    let tx = tx.clone();
                    async move {
                        if let Some(tx) = tx.lock().expect("capture mutex").take() {
                            let _ = tx.send(payload);
                        }
                        Json(serde_json::json!({ "success": true }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let port = listener
            .local_addr()
            .expect("test server local addr")
            .port();
        let server = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        freeze_current_via_sidecar(port, false, false)
            .await
            .expect("freeze-current succeeds");

        let payload = rx.await.expect("captured freeze-current payload");
        assert_eq!(payload["metadataBirthPending"].as_bool(), Some(false));
        assert_eq!(payload["metadataIndexed"].as_bool(), Some(false));

        server.abort();
    }

    #[tokio::test]
    async fn surface_migration_via_sidecar_sends_the_proven_target() {
        let (tx, rx) = oneshot::channel::<Value>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let app = Router::new().route(
            "/api/session/surface-migration",
            post({
                let tx = tx.clone();
                move |Json(payload): Json<Value>| {
                    let tx = tx.clone();
                    async move {
                        if let Some(tx) = tx.lock().expect("capture mutex").take() {
                            let _ = tx.send(payload.clone());
                        }
                        Json(serde_json::json!({
                            "sessionId": payload["targetSessionId"],
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let port = listener
            .local_addr()
            .expect("test server local addr")
            .port();
        let server = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = "6d57334a-44d8-4fe1-a4f2-cd57fc8beb85";

        migrate_surface_via_sidecar(port, target, true, false)
            .await
            .expect("surface migration succeeds");

        let payload = rx.await.expect("captured migration payload");
        assert_eq!(payload["targetSessionId"].as_str(), Some(target));
        assert_eq!(payload["metadataBirthPending"].as_bool(), Some(true));
        assert_eq!(payload["metadataIndexed"].as_bool(), Some(false));

        server.abort();
    }

    #[tokio::test]
    async fn surface_migration_accepts_a_verified_post_commit_error() {
        let target = "6d57334a-44d8-4fe1-a4f2-cd57fc8beb85";
        let app = Router::new()
            .route(
                "/api/session/surface-migration",
                post(|| async {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "late failure",
                    )
                }),
            )
            .route(
                "/api/session-state",
                get(move || async move { Json(serde_json::json!({ "sessionId": target })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let port = listener
            .local_addr()
            .expect("test server local addr")
            .port();
        let server = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        migrate_surface_via_sidecar(port, target, false, true)
            .await
            .expect("verified target is already committed");

        server.abort();
    }
}

/// UTF-8-safe shortener for log lines and notification text. The bare
/// `&s[..8.min(s.len())]` form is byte-indexed and panics if byte 8 lands
/// inside a multi-byte char. Session ids are UUIDs so the panic never
/// triggers in practice, but the chars-based form is correct by construction
/// and removes the trap for any future caller passing non-ASCII strings.
fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

async fn freeze_current_via_sidecar(
    port: u16,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
) -> Result<(), String> {
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let url = format!("http://127.0.0.1:{}/api/session/freeze-current", port);
    let resp = client
        .post(&url)
        .json(&json!({
            "metadataBirthPending": metadata_birth_pending,
            "metadataIndexed": metadata_indexed,
        }))
        .send()
        .await
        .map_err(|e| format!("freeze-current HTTP send failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("freeze-current returned {}: {}", status, body));
    }
    Ok(())
}

async fn migrate_surface_via_sidecar(
    port: u16,
    target_session_id: &str,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
) -> Result<(), String> {
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let url = format!("http://127.0.0.1:{}/api/session/surface-migration", port);
    let response = client
        .post(&url)
        .json(&json!({
            "targetSessionId": target_session_id,
            "metadataBirthPending": metadata_birth_pending,
            "metadataIndexed": metadata_indexed,
        }))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => return Ok(()),
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if sidecar_runtime_session_id(&client, port).await.as_deref() == Some(target_session_id)
            {
                // The Runtime commit is authoritative even if optional
                // post-commit work produced a non-success response.
                return Ok(());
            }
            return Err(format!("surface-migration returned {status}: {body}"));
        }
        Err(error) => {
            if sidecar_runtime_session_id(&client, port).await.as_deref() == Some(target_session_id)
            {
                // A loopback response can disappear after Node committed.
                // Verify the identity once instead of rolling Rust back across
                // an already-committed Runtime.
                return Ok(());
            }
            return Err(format!("surface-migration HTTP send failed: {error}"));
        }
    }
}

async fn sidecar_runtime_session_id(client: &reqwest::Client, port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/api/session-state");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    body.get("sessionId")?.as_str().map(str::to_string)
}

// ============================================================================
// 1. New conversation with surface migration
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub new_session_id: String,
}

/// Desktop "+新对话" on a channel-bound session.
///
/// Rust admits this operation only when the source Sidecar has exactly the
/// participating `Tab(tabId) + Agent(sessionKey)` owners. Router projection is
/// staged durably before Node mutation, then the same target identity is
/// adopted by SidecarManager and the SessionEngine facade.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_new_with_surface_migration<R: Runtime>(
    app: AppHandle<R>,
    oldSessionId: String,
    tabId: String,
    sessionKey: String,
) -> Result<NewSessionResult, String> {
    ulog_info!(
        "[handover] operation=surface_session_migration stage=start session={} tab={} key={}",
        short_id(&oldSessionId),
        tabId,
        sessionKey,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app
        .try_state()
        .ok_or_else(|| "Agent state unavailable".to_string())?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app
        .try_state()
        .ok_or_else(|| "Sidecar manager unavailable".to_string())?;

    // Locate the channel that owns this session_key. We scan ManagedAgents
    // because session_key encodes agent_id but ChannelInstance routers don't
    // expose a reverse index.
    let parts: Vec<&str> = sessionKey.split(':').collect();
    if parts.len() < 5 || parts[0] != "agent" {
        return Err(format!("Invalid session_key format: {}", sessionKey));
    }
    let target_agent_id = parts[1];

    let found_binding = {
        let agents = agent_state.lock().await;
        let agent = agents.get(target_agent_id).ok_or_else(|| {
            format!(
                "Agent {} not found (channel may be offline)",
                target_agent_id
            )
        })?;

        // The router sits on each ChannelInstance.bot_instance. Find the
        // channel whose router actually has this peer_session entry. The
        // common case is a single-channel agent so the loop is cheap.
        let mut found = None;
        for ch in agent.channels.values() {
            let router_guard = ch.bot_instance.router.lock().await;
            if router_guard.has_peer_session(&sessionKey) {
                drop(router_guard);
                found = Some((
                    ch.bot_instance.router.clone(),
                    ch.bot_instance.health.clone(),
                    ch.bot_instance.peer_locks.clone(),
                ));
                break;
            }
        }
        found
    };

    let (router_arc, health, peer_locks) = found_binding.ok_or_else(|| {
        format!(
            "No active channel binds session_key {}; cannot migrate",
            sessionKey
        )
    })?;

    // Reuse the exact enqueue fence used by `/new`, normal IM turns, and
    // heartbeat. No second migration mutex/state machine is introduced.
    let peer_lock = {
        let mut locks = peer_locks.lock().await;
        locks
            .entry(sessionKey.clone())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _peer_guard = peer_lock.lock().await;

    // Match the active-session projection lock order used by every Router
    // writer. The peer fence excludes `/new` and ordinary IM turns for this
    // binding until all three identities have converged.
    let _projection = health.lock_active_sessions_projection().await;
    let mut router = router_arc.lock().await;
    let prior = router
        .peer_session_snapshot(&sessionKey)
        .ok_or_else(|| format!("No peer binding for {sessionKey}"))?;
    if prior.session_id != oldSessionId {
        return Err(format!(
            "Channel binding changed before migration: expected {}, found {}",
            short_id(&oldSessionId),
            short_id(&prior.session_id)
        ));
    }

    let new_session_id = uuid::Uuid::new_v4().to_string();
    let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[
        oldSessionId.as_str(),
        new_session_id.as_str(),
    ])
    .await;
    if crate::sidecar::has_persisted_session_owner(&oldSessionId).await?
        || crate::sidecar::has_persisted_session_owner(&new_session_id).await?
    {
        return Err("Cannot migrate a Session with a persistent Goal or task owner".to_string());
    }

    let sidecar_port = {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        if !manager_guard.surface_session_migration_is_admissible(
            &oldSessionId,
            &tabId,
            &sessionKey,
        ) {
            return Err(
                "Session owners changed; only the current Tab and Channel may migrate together"
                    .to_string(),
            );
        }
        manager_guard
            .get_session_port(&oldSessionId)
            .ok_or_else(|| "Source Sidecar is not ready for surface migration".to_string())?
    };
    if prior.sidecar_port != sidecar_port {
        return Err("Router and SidecarManager disagree on the source Sidecar".to_string());
    }

    // Stage and durably project B while the Router is fenced. If persistence
    // fails, exact compare-and-rollback restores A before any Runtime identity
    // changes.
    let transition =
        router.stage_surface_session_migration(&sessionKey, &oldSessionId, &new_session_id)?;
    if let Err(error) = health
        .persist_active_sessions_snapshot(router.active_sessions())
        .await
    {
        let rolled_back = router.rollback_peer_binding_transition(&transition);
        ulog_warn!(
            "[handover] operation=surface_session_migration stage=persist result=failed old={} new={} rollback={} durable_state=unchanged error={}",
            short_id(&oldSessionId),
            short_id(&new_session_id),
            rolled_back,
            error
        );
        return Err(format!("Failed to save Channel migration: {error}"));
    }

    let manager_upgraded = manager
        .lock()
        .map_err(|error| error.to_string())?
        .upgrade_session_id_for_surface_migration(
            &oldSessionId,
            &new_session_id,
            &tabId,
            &sessionKey,
        );
    if !manager_upgraded {
        let rolled_back = router.rollback_peer_binding_transition(&transition);
        let rollback_persisted = rolled_back
            && health
                .persist_active_sessions_snapshot(router.active_sessions())
                .await
                .is_ok();
        ulog_warn!(
            "[handover] operation=surface_session_migration stage=manager-rekey result=failed old={} new={} rollback={} rollback_persisted={}",
            short_id(&oldSessionId),
            short_id(&new_session_id),
            rolled_back,
            rollback_persisted
        );
        return Err("Sidecar owner admission changed before migration".to_string());
    }

    if let Err(error) = migrate_surface_via_sidecar(
        sidecar_port,
        &new_session_id,
        prior.metadata_birth_pending,
        prior.metadata_indexed,
    )
    .await
    {
        let manager_rolled_back = manager
            .lock()
            .map_err(|lock_error| lock_error.to_string())?
            .upgrade_session_id_for_surface_migration(
                &new_session_id,
                &oldSessionId,
                &tabId,
                &sessionKey,
            );
        let router_rolled_back = router.rollback_peer_binding_transition(&transition);
        let rollback_persisted = router_rolled_back
            && health
                .persist_active_sessions_snapshot(router.active_sessions())
                .await
                .is_ok();
        ulog_warn!(
            "[handover] operation=surface_session_migration stage=runtime result=failed old={} new={} manager_rollback={} router_rollback={} rollback_persisted={} error={}",
            short_id(&oldSessionId),
            short_id(&new_session_id),
            manager_rolled_back,
            router_rolled_back,
            rollback_persisted,
            error
        );
        if !manager_rolled_back || !router_rolled_back || !rollback_persisted {
            return Err(format!(
                "Surface migration failed and could not restore its owner snapshot: {error}"
            ));
        }
        return Err(error);
    }

    ulog_info!(
        "[handover] operation=surface_session_migration result=committed old={} new={} tab={} key={}",
        short_id(&oldSessionId),
        short_id(&new_session_id),
        tabId,
        sessionKey,
    );

    Ok(NewSessionResult { new_session_id })
}

// ============================================================================
// 2. Handover desktop session to channel
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverResult {
    pub ok: bool,
    pub session_key: String,
    pub notified: bool,
    pub state_persisted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Bind `session_id` (the desktop session) to `(agent_id, channel_id)`.
///
/// We replace the channel's most-recently-active `peer_session` so the channel
/// continues talking to the same chat (same user / same group), just with the
/// desktop session as the new conversation backend. The old binding's session
/// loses its `Agent` owner; the desktop session gains it.
///
/// ## Step ordering (v0.2.14 cross-bugfix)
///
/// Earlier ordering wrote the `peer_session` mutation BEFORE attaching the
/// `Agent` owner to the target sidecar. If `ensure_session_sidecar` failed
/// (or panicked silently), the channel would already be bound to the new
/// session_id but the desktop tab would be the only owner — close the tab
/// and the sidecar dies, IM messages then orphan into nothing.
///
/// New order:
///
///   1. Resolve channel + workspace (read-only)
///   2. Snapshot the chat to take over (`most_recent_peer_session_key`)
///   3. Look up sidecar port (read-only)
///   4. **`ensure_session_sidecar`** — attach Agent owner FIRST. Fail-fast
///      here makes the operation atomic from the user's POV: nothing was
///      mutated, the old binding is intact, the renderer toast says
///      "交接失败" with no surprise side-effects.
///   5. **Mutate `peer_sessions`** — atomic snapshot+upsert under one lock.
///   6. Release prior owner (best-effort).
///   7. Send notification to the IM chat (last step; failure → notified=false
///      surfaces back to the renderer toast as "已交接（通知未发送）").
///
/// ## Observability
///
/// Every step logs an `[handover]` ulog line on entry / decision / completion.
/// The PRD 0.2.14 dogfood found a case where the function silently exited
/// after acquiring the manager lock with NO subsequent log line, which made
/// root-causing the missing notification impossible. Each step is now a
/// log breadcrumb so partial-failure diagnosis is grep-able.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_handover_session_to_channel<R: Runtime>(
    app: AppHandle<R>,
    sessionId: String,
    agentId: String,
    channelId: String,
    workspacePath: String,
    sessionKey: Option<String>,
) -> Result<HandoverResult, String> {
    ulog_info!(
        "[handover] start session={} → agent={} channel={}",
        short_id(&sessionId),
        agentId,
        channelId,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app.try_state().ok_or_else(|| {
        ulog_warn!("[handover] step1 ManagedAgents state unavailable");
        "Agent state unavailable".to_string()
    })?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app.try_state().ok_or_else(|| {
        ulog_warn!("[handover] step1 ManagedSidecarManager state unavailable");
        "Sidecar manager unavailable".to_string()
    })?;

    // ----- 1. Resolve target channel + workspace constraint
    let (
        router_arc,
        adapter,
        target_health,
        target_peer_locks,
        agent_workspace,
        last_active_channel,
        last_active_private_target,
        fallback_snapshot,
        channel_runtimes,
    ) = {
        let agents = agent_state.lock().await;
        let agent = agents.get(&agentId).ok_or_else(|| {
            ulog_warn!(
                "[handover] step1 agent {} not found in ManagedAgents",
                agentId
            );
            format!("Agent {} not found", agentId)
        })?;
        let channel = agent.channels.get(&channelId).ok_or_else(|| {
            ulog_warn!(
                "[handover] step1 channel {} not found in agent {}",
                channelId,
                agentId
            );
            format!("Channel {} not found in agent {}", channelId, agentId)
        })?;
        let fallback_snapshot = runtime_change::build_snapshot_from_channel_state(
            &channel.bot_instance.runtime,
            &channel.bot_instance.current_model,
            &channel.bot_instance.permission_mode,
            &channel.bot_instance.mcp_servers_json,
            &channel.bot_instance.runtime_config,
            channel.bot_instance.config.provider_id.clone(),
            &channel.bot_instance.current_provider_env,
        )
        .await;
        let channel_runtimes = agent
            .channels
            .iter()
            .map(|(ch_id, ch)| ChannelRuntimeRefs {
                channel_id: ch_id.clone(),
                router: ch.bot_instance.router.clone(),
                health: ch.bot_instance.health.clone(),
                consumers: ch.bot_instance.im_consumers.clone(),
            })
            .collect::<Vec<_>>();
        (
            channel.bot_instance.router.clone(),
            channel.bot_instance.adapter.clone(),
            channel.bot_instance.health.clone(),
            channel.bot_instance.peer_locks.clone(),
            agent.config.resolved_workspace_path.clone(),
            agent.last_active_channel.clone(),
            agent.last_active_private_target.clone(),
            fallback_snapshot,
            channel_runtimes,
        )
    };
    ulog_info!("[handover] step1 channel resolved");

    let req_workspace = PathBuf::from(&workspacePath);
    // #320 family: use the canonical workspace-path identity (drive-letter case
    // fold + trailing-slash trim), not a separator-only fold — a Windows agent
    // workspace `C:\Users\...` vs request `c:/users/.../` must still match.
    if crate::cron_task::normalize_path(&agent_workspace)
        != crate::cron_task::normalize_path(&req_workspace.to_string_lossy())
    {
        ulog_warn!(
            "[handover] workspace mismatch: agent={} request={}",
            agent_workspace,
            req_workspace.display()
        );
        return Err(format!(
            "Workspace mismatch: agent workspace = {}, session workspace = {}",
            agent_workspace,
            req_workspace.display(),
        ));
    }

    // ----- 2. Pick the chat to take over. The desktop UI now passes an
    // explicit peer `sessionKey`, so a Feishu bot with both private and group
    // chats never falls back to "whatever was most recent". The legacy
    // fallback remains only for older callers and logs loudly.
    let target_session_key = {
        let router = router_arc.lock().await;
        match sessionKey
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(explicit_key) => {
                if !router.has_peer_session(explicit_key) {
                    ulog_warn!(
                        "[handover] explicit sessionKey not found in channel router: channel={} key={}",
                        channelId,
                        explicit_key
                    );
                    return Err(format!("目标聊天不存在或已离线：{}", explicit_key));
                }
                explicit_key.to_string()
            }
            None => {
                ulog_warn!(
                    "[handover] missing explicit sessionKey; falling back to most recent peer_session for channel {}",
                    channelId
                );
                router.most_recent_peer_session_key().ok_or_else(|| {
                    ulog_warn!("[handover] no prior peer_session for channel {}", channelId);
                    "Channel 没有最近活跃的对话；请先在 IM 端发一条消息建立会话".to_string()
                })?
            }
        }
    };
    ulog_info!("[handover] step2 target_session_key={}", target_session_key);

    // Serialize the whole owner rotation with ordinary IM enqueue, `/new`,
    // heartbeat, and surface migration for this exact chat. In particular,
    // a first IM message must finish its SessionStore materialization before
    // the source is classified as durable vs unmaterialized below.
    let _target_peer_guard =
        acquire_peer_operation_fence(&target_peer_locks, &target_session_key).await;
    let prior_before_handover = {
        let router = router_arc.lock().await;
        router.peer_session_snapshot(&target_session_key)
    };

    // ----- 3. Check whether the target session already has a Sidecar in the
    // manager. We don't require one here: provider/runtime boundary forks can
    // create a fresh target SessionMetadata, move the IM binding to it, and only
    // then open the desktop Tab. `ensure_session_sidecar` below is the
    // authoritative attach/create point and returns the real port.
    {
        let mut mgr = manager.lock().map_err(|e| {
            ulog_warn!("[handover] step3 manager lock poisoned: {}", e);
            e.to_string()
        })?;
        ulog_info!(
            "[handover] step3 session {} sidecar_present={}",
            short_id(&sessionId),
            mgr.has_session_sidecar(&sessionId),
        );
    }

    // ----- 4. Attach Agent owner to target Sidecar FIRST (fail-fast).
    //
    // Done before any router mutation so that an `ensure_session_sidecar`
    // failure leaves zero observable side-effect — the old binding is intact,
    // no orphaned chat-id-without-owner state. Was step 5 in the pre-0.2.14
    // ordering; reordered after a dogfood report where the function exited
    // silently mid-step without notification or `[handover] done` log.
    //
    // The async lifecycle entrypoint performs the blocking-thread handoff and
    // holds the same per-session fence used by deletion.
    let owner = SidecarOwner::Agent(target_session_key.clone());
    let app_clone = app.clone();
    let mgr_clone = manager.inner().clone();
    let sid_clone = sessionId.clone();
    let workspace_clone = req_workspace.clone();
    let owner_clone = owner.clone();
    let ensure_result = ensure_session_sidecar_with_lifecycle(
        app_clone,
        mgr_clone,
        sid_clone,
        workspace_clone,
        owner_clone,
    )
    .await
    .map_err(|e| {
        ulog_warn!(
            "[handover] step4 ensure_session_sidecar failed for session {}: {}",
            short_id(&sessionId),
            e
        );
        format!("Failed to attach Agent owner: {}", e)
    })?;
    let target_port = ensure_result.port;
    ulog_info!(
        "[handover] step4 Agent owner attached to session {} (port={}, is_new={})",
        short_id(&sessionId),
        target_port,
        ensure_result.is_new,
    );

    // ----- 4b. Freeze the prior channel-bound session BEFORE mutating the
    // binding. If this fails, release the just-attached Agent owner and leave
    // the channel on the old session. This preserves the transactional UX:
    // no "old session frozen but IM still bound to it" half-state.
    if let Some(prior) = prior_before_handover.as_ref() {
        if prior.session_id != sessionId {
            // Re-read immediately before freeze. The per-peer fence excludes
            // IM materialization, while this identity check also fails closed
            // if another supported owner path replaced the source meanwhile.
            let (prior_for_freeze, prior_metadata_disposition) = {
                let router = router_arc.lock().await;
                let current_prior = router.peer_session_snapshot(&target_session_key);
                let before_identity = Some((prior.session_id.as_str(), prior.sidecar_port));
                let current_identity = current_prior
                    .as_ref()
                    .map(|current| (current.session_id.as_str(), current.sidecar_port));
                if before_identity != current_identity {
                    let _ = release_session_sidecar(manager.inner(), &sessionId, &owner);
                    ulog_warn!(
                        "[handover] step4b binding changed before freeze; target owner released key={}",
                        target_session_key
                    );
                    return Err(
                        "Channel binding changed during handover; please retry.".to_string()
                    );
                }
                (
                    current_prior.expect("binding identity matched an existing source"),
                    router.classify_peer_session_metadata_for_binding_rotation(&target_session_key),
                )
            };
            let freeze_result = if !peer_binding_source_requires_freeze(prior_metadata_disposition)
            {
                ulog_info!(
                    "[handover] step4b skipped freeze for unmaterialized prior session {} disposition={:?}",
                    short_id(&prior_for_freeze.session_id),
                    prior_metadata_disposition,
                );
                Ok(())
            } else if prior_for_freeze.sidecar_port != 0 {
                freeze_current_via_sidecar(
                    prior_for_freeze.sidecar_port,
                    prior_for_freeze.metadata_birth_pending,
                    prior_for_freeze.metadata_indexed,
                )
                .await
                .map(|_| {
                    ulog_info!(
                        "[handover] step4b froze prior session {} via sidecar port {}",
                        short_id(&prior_for_freeze.session_id),
                        prior_for_freeze.sidecar_port
                    );
                })
            } else {
                runtime_change::freeze_via_file_lock_status(
                    &prior_for_freeze.session_id,
                    &fallback_snapshot,
                )
                .await
                .and_then(|outcome| {
                    runtime_change::resolve_peer_file_lock_freeze_outcome(
                        outcome,
                        prior_for_freeze.metadata_birth_pending,
                        prior_for_freeze.metadata_indexed,
                        &prior_for_freeze.session_id,
                    )
                })
                .map(|disposition| match disposition {
                        runtime_change::PeerFileLockFreezeDisposition::Frozen => {
                            ulog_info!(
                                "[handover] step4b froze idle prior session {} via file lock",
                                short_id(&prior_for_freeze.session_id)
                            );
                        }
                        runtime_change::PeerFileLockFreezeDisposition::MissingBirthPending => {
                            ulog_info!(
                                "[handover] step4b skipped freeze for birth-pending prior session {} missing from SessionStore",
                                short_id(&prior_for_freeze.session_id)
                            );
                        }
                        runtime_change::PeerFileLockFreezeDisposition::MissingUnindexedPeerSession => {
                            ulog_info!(
                                "[handover] step4b skipped freeze for unindexed prior peer session {} missing from SessionStore",
                                short_id(&prior_for_freeze.session_id)
                            );
                        }
                    })
            };
            if let Err(e) = freeze_result {
                let _ = release_session_sidecar(manager.inner(), &sessionId, &owner);
                ulog_warn!(
                    "[handover] step4b freeze prior session {} failed; target owner released: {}",
                    short_id(&prior.session_id),
                    e
                );
                return Err(format!("Failed to freeze prior channel session: {}", e));
            }
        }
    }

    // ----- 5. Mutate router atomically (snapshot prior + upsert under one lock).
    //
    // Use `target_port` from step 4 (the authoritative port returned by
    // ensure_session_sidecar) rather than what step 3 read pre-ensure —
    // `is_new=true` means the old sidecar was dead and a fresh one was minted
    // on a different port; binding the IM channel to the stale port would
    // route subsequent messages into a closed socket.
    let mut persist_warning: Option<String> = None;
    let (chat_id, prior_session_id, prior_sidecar_port) = {
        let mut router = router_arc.lock().await;
        let current_prior = router.peer_session_snapshot(&target_session_key);
        let before_identity = prior_before_handover
            .as_ref()
            .map(|p| (p.session_id.as_str(), p.sidecar_port));
        let current_identity = current_prior
            .as_ref()
            .map(|p| (p.session_id.as_str(), p.sidecar_port));
        if before_identity != current_identity {
            let _ = release_session_sidecar(manager.inner(), &sessionId, &owner);
            ulog_warn!(
                "[handover] step5 binding changed while freezing; target owner released key={}",
                target_session_key
            );
            return Err("Channel binding changed during handover; please retry.".to_string());
        }
        let prior = prior_before_handover.clone();
        let prior_session_id = prior.as_ref().map(|p| p.session_id.clone());
        let prior_sidecar_port = prior.as_ref().map(|p| p.sidecar_port);
        let (source_type, source_id) = parse_session_key(&target_session_key);
        let source_display_name = prior
            .as_ref()
            .and_then(|p| p.source_display_name.clone())
            .or_else(|| Some(source_id.clone()));
        let last_sender_name = prior.as_ref().and_then(|p| p.last_sender_name.clone());

        router.upsert_peer_session(PeerSession {
            session_key: target_session_key.clone(),
            session_id: sessionId.clone(),
            sidecar_port: target_port,
            workspace_path: req_workspace.clone(),
            source_type,
            source_id: source_id.clone(),
            source_display_name,
            last_sender_name,
            message_count: 0,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now(),
        });

        (source_id, prior_session_id, prior_sidecar_port)
    };
    ulog_info!(
        "[handover] step5 peer_session upserted: chat_id={} prior_session={}",
        chat_id,
        prior_session_id
            .as_deref()
            .map(short_id)
            .unwrap_or_else(|| "none".into()),
    );
    if let Err(e) =
        health::persist_router_active_sessions(&target_health, &router_arc, "handover-upsert").await
    {
        persist_warning = Some(format!("Active session state failed to persist: {}", e));
    }

    if target_consumer_needs_cancel(
        prior_session_id.as_deref(),
        prior_sidecar_port,
        &sessionId,
        target_port,
    ) {
        if let Some(target_runtime) = channel_runtimes
            .iter()
            .find(|runtime| runtime.channel_id == channelId)
        {
            if let Some(handle) = target_runtime
                .consumers
                .lock()
                .await
                .remove(&target_session_key)
            {
                handle
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                ulog_info!(
                    "[handover] step5 cancelled stale target ImEventConsumer for {}",
                    target_session_key
                );
            }
        }
    }

    // ----- 5b. Enforce one channel binding per session.
    //
    // The handover command is also used as "switch this already-bound desktop
    // session from channel A to channel B". In that path, mutating only the
    // target router leaves the old channel's peer_session pointing at the same
    // session_id; status polling and mirror routing then pick whichever channel
    // they scan first. Remove every non-target binding for this session across
    // the agent's channels before notifying the target.
    let mut removed_count = 0usize;
    for runtime in &channel_runtimes {
        let (removed_bindings, should_persist_removal) = {
            let mut router_guard = runtime.router.lock().await;
            let keep_session_key = if runtime.channel_id == channelId {
                Some(target_session_key.as_str())
            } else {
                None
            };
            let removed =
                router_guard.remove_peer_sessions_for_session_except(&sessionId, keep_session_key);
            let should_persist = !removed.is_empty();
            (removed, should_persist)
        };
        if should_persist_removal {
            if let Err(e) = health::persist_router_active_sessions(
                &runtime.health,
                &runtime.router,
                "handover-remove-stale-binding",
            )
            .await
            {
                persist_warning.get_or_insert_with(|| {
                    format!("Active session state failed to persist: {}", e)
                });
            }
        }

        for removed in removed_bindings {
            removed_count += 1;
            let removed_owner = SidecarOwner::Agent(removed.session_key.clone());
            if let Some(handle) = runtime.consumers.lock().await.remove(&removed.session_key) {
                handle
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                ulog_info!(
                    "[handover] step5b cancelled stale ImEventConsumer for {}",
                    removed.session_key
                );
            }
            match release_session_sidecar(manager.inner(), &removed.session_id, &removed_owner) {
                Ok(stopped) => ulog_info!(
                    "[handover] step5b removed stale channel binding {} from session {} (sidecar_stopped={})",
                    removed.session_key,
                    short_id(&removed.session_id),
                    stopped
                ),
                Err(e) => ulog_warn!(
                    "[handover] step5b release stale binding {} failed: {}",
                    removed.session_key,
                    e
                ),
            }
        }
    }
    if removed_count > 0 {
        ulog_info!(
            "[handover] step5b removed {} stale binding(s) for session {}",
            removed_count,
            short_id(&sessionId),
        );
    }

    {
        let now_str = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        *last_active_channel.write().await = Some(LastActiveChannel {
            channel_id: channelId.clone(),
            session_key: target_session_key.clone(),
            last_active_at: now_str,
        });
        let target_is_private = router_arc
            .lock()
            .await
            .peer_source_type(&target_session_key)
            == Some(ImSourceType::Private);
        if target_is_private {
            *last_active_private_target.write().await = Some(LastActivePrivateTarget {
                channel_id: channelId.clone(),
                session_key: target_session_key.clone(),
                last_active_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            });
        }
    }
    ulog_info!(
        "[handover] step5c lastActiveChannel updated: agent={} channel={} session_key={}",
        agentId,
        channelId,
        target_session_key,
    );
    let _ = app.emit(
        "agent:status-changed",
        serde_json::json!({
            "agentId": agentId,
            "channelId": channelId,
            "event": "handover",
        }),
    );

    // ----- 6. Release the prior session's Agent owner (best-effort).
    // Same-session re-bind (prior == new) is a no-op — don't accidentally
    // strip the owner we just attached.
    if let Some(prior_sid) = prior_session_id.as_deref() {
        if prior_sid != sessionId {
            match release_session_sidecar(manager.inner(), prior_sid, &owner) {
                Ok(stopped) => ulog_info!(
                    "[handover] step6 released prior Agent owner from {} (sidecar_stopped={})",
                    short_id(prior_sid),
                    stopped
                ),
                Err(e) => ulog_warn!(
                    "[handover] step6 release_session_sidecar({}) failed: {}",
                    short_id(prior_sid),
                    e
                ),
            }
        }
    }

    // ----- 7. Notify the channel. Same 8-char session-id prefix surface that
    // `/new` shows in IM (`✅ 已创建新对话 (xxxxxxxx)`) so the user can
    // correlate the two affordances. Failure here is non-fatal — `notified`
    // surfaces back to the renderer toast.
    let notification = format!("当前会话切换至「{}」", short_id(&sessionId));
    ulog_info!(
        "[handover] step7 sending notification to chat={} via adapter",
        chat_id
    );
    let notified = match adapter.send_message(&chat_id, &notification).await {
        Ok(_) => {
            ulog_info!("[handover] step7 notification sent");
            true
        }
        Err(e) => {
            ulog_warn!("[handover] step7 notification send failed: {}", e);
            false
        }
    };

    ulog_info!(
        "[handover] done: session={} now bound to {} (notified={})",
        short_id(&sessionId),
        target_session_key,
        notified,
    );

    Ok(HandoverResult {
        ok: true,
        session_key: target_session_key,
        notified,
        state_persisted: persist_warning.is_none(),
        warning: persist_warning,
    })
}

// AnyAdapter::send_message is on `ImAdapter` — pull the trait into scope so
// `adapter.send_message(...)` resolves on `Arc<AnyAdapter>` in §6 above.
use super::adapter::ImAdapter;
