// Heartbeat Runner for IM Bot
// Periodically checks a user-defined checklist and pushes results to IM.
// Supports active hours, instant wake (from cron completion), and dedup.

use std::sync::Arc;
use std::time::Duration;

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use crate::sidecar::ManagedSidecarManager;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

use super::adapter::push_text_preferring_stream;
use super::health::{self, HealthManager};
use super::router::{EnsureSidecarPrep, SessionRouter};
use super::types::{
    ActiveHours, HeartbeatConfig, HeartbeatWake, HostInteractionCapability, PendingCronEvent,
    WakeReason,
};
use super::{AnyAdapter, ChannelModelWorkGate, PeerLocks};

/// Response from sidecar /api/im/heartbeat endpoint
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    status: String, // "silent" | "content" | "error"
    text: Option<String>,
    #[allow(dead_code)]
    reason: Option<String>,
    /// True only when SessionEngine accepted the injected turn. A birth-pending
    /// peer can consume its one-time materialization authority at this boundary.
    #[serde(default)]
    message_enqueued: bool,
}

fn cron_event_matches_session(event: &PendingCronEvent, session_key: &str) -> bool {
    event
        .target_session_key
        .as_deref()
        .map_or(true, |target| target == session_key)
}

fn snapshot_pending_cron_event_for_session(
    pending: &[PendingCronEvent],
    session_key: &str,
) -> Vec<PendingCronEvent> {
    pending
        .iter()
        .find(|event| cron_event_matches_session(event, session_key))
        .cloned()
        .map(|event| vec![event])
        .unwrap_or_default()
}

fn count_pending_cron_events_for_session(pending: &[PendingCronEvent], session_key: &str) -> usize {
    pending
        .iter()
        .filter(|event| cron_event_matches_session(event, session_key))
        .count()
}

pub(super) fn wake_for_pending_cron_event(event: &PendingCronEvent) -> HeartbeatWake {
    HeartbeatWake::new(WakeReason::CronComplete {
        task_id: event.task_id.clone(),
        summary: event.content.clone(),
    })
    .with_target(event.target_session_key.clone())
}

/// Heartbeat prompt sent to sidecar
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatRequest {
    prompt: String,
    source: String,
    source_id: String,
    ack_max_chars: u32,
    is_high_priority: bool,
    runtime: String,
    runtime_config: Option<serde_json::Value>,
    host_interaction: HostInteractionCapability,
    /// SessionRouter-owned authority for materializing a Rust-minted peer
    /// session that has not reached SessionStore yet.
    metadata_birth_pending: bool,
    /// Pending cron events held by Rust as the authoritative payload (v0.2.4).
    /// When non-empty, the sidecar handler MUST use these instead of (or in
    /// addition to) the in-memory `systemEventQueue` — sidecar-side queue is
    /// downgraded to a transport buffer for legacy callers and is not durable
    /// across sidecar restarts. Serialized as `pendingCronEvents` (camelCase).
    /// Always sent (possibly empty) so the sidecar can detect "no body events,
    /// fall back to queue" by checking length, no `Option` wrapper needed.
    pending_cron_events: Vec<PendingCronEvent>,
}

/// HeartbeatRunner manages the periodic heartbeat loop for an IM Bot.
pub struct HeartbeatRunner {
    bot_label: String, // e.g. "feishu_mino" or "@mino115_bot" for log identification
    config: Arc<RwLock<HeartbeatConfig>>,
    last_push_text: Arc<Mutex<Option<String>>>,
    last_error_text: Arc<Mutex<Option<String>>>, // Last error from heartbeat for user notification
    http_client: reqwest::Client,
    executing: Arc<Mutex<bool>>,
    // Hot-reloadable config refs — needed to sync AI config when waking up an idle-collected sidecar
    current_model: Arc<RwLock<Option<String>>>,
    current_provider_env: Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: Arc<RwLock<Option<String>>>,
    runtime: Arc<RwLock<String>>,
    runtime_config: Arc<RwLock<Option<serde_json::Value>>>,
    host_interaction: HostInteractionCapability,
    /// Pending cron events shared with `ImBotInstance` (v0.2.4). Snapshot in
    /// run_once → ship to sidecar via HeartbeatRequest body → clear delivered
    /// entries only after IM push success. Same Arc as the bot instance, so
    /// deliver-side appends and runner-side clears coordinate without IPC.
    pending_cron_events: Arc<Mutex<Vec<PendingCronEvent>>>,
    model_work_gate: Arc<ChannelModelWorkGate>,
    /// Self-wake channel (clone of the same `mpsc::Sender` whose `Receiver`
    /// drives `run_loop`). Used at the end of `run_once` to cascade-trigger
    /// the next iteration when there are still pending cron events: the
    /// run_once contract is "process at most one cron event per cycle" (so
    /// the AI can't accidentally drop a relay by under-quoting a multi-event
    /// prompt), and without cascade the second event would wait a full
    /// heartbeat interval. Each successful delivery targets the next queue
    /// entry, so one Channel can drain events for multiple private peers.
    self_wake_tx: mpsc::Sender<HeartbeatWake>,
}

impl HeartbeatRunner {
    /// Create a new HeartbeatRunner.
    /// Returns (runner, config_arc) — caller keeps the config arc for hot-updating.
    pub(crate) fn new(
        config: HeartbeatConfig,
        bot_label: String,
        current_model: Arc<RwLock<Option<String>>>,
        current_provider_env: Arc<RwLock<Option<serde_json::Value>>>,
        mcp_servers_json: Arc<RwLock<Option<String>>>,
        runtime: Arc<RwLock<String>>,
        runtime_config: Arc<RwLock<Option<serde_json::Value>>>,
        host_interaction: HostInteractionCapability,
        pending_cron_events: Arc<Mutex<Vec<PendingCronEvent>>>,
        model_work_gate: Arc<ChannelModelWorkGate>,
        self_wake_tx: mpsc::Sender<HeartbeatWake>,
    ) -> (Self, Arc<RwLock<HeartbeatConfig>>) {
        let config = Arc::new(RwLock::new(config));
        let runner = Self {
            bot_label,
            config: Arc::clone(&config),
            last_push_text: Arc::new(Mutex::new(None)),
            last_error_text: Arc::new(Mutex::new(None)),
            http_client: crate::local_http::json_client(Duration::from_secs(330)), // 5.5 min (heartbeat timeout is 5 min)
            executing: Arc::new(Mutex::new(false)),
            current_model,
            current_provider_env,
            mcp_servers_json,
            runtime,
            runtime_config,
            host_interaction,
            pending_cron_events,
            model_work_gate,
            self_wake_tx,
        };
        (runner, config)
    }

    /// Main heartbeat loop. Runs until shutdown signal.
    pub(crate) async fn run_loop<R: Runtime>(
        self,
        mut shutdown_rx: watch::Receiver<bool>,
        mut wake_rx: mpsc::Receiver<HeartbeatWake>,
        router: Arc<Mutex<SessionRouter>>,
        sidecar_manager: ManagedSidecarManager,
        adapter: Arc<AnyAdapter>,
        app_handle: AppHandle<R>,
        peer_locks: PeerLocks,
        health: Arc<HealthManager>,
        agent_id: String,
        workspace_path: String,
    ) {
        let initial_interval = {
            let cfg = self.config.read().await;
            Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
        };
        let mut interval = tokio::time::interval(initial_interval);
        // Skip the first immediate tick
        interval.tick().await;

        ulog_info!(
            "[heartbeat] Runner started for {} (interval={}min)",
            self.bot_label,
            initial_interval.as_secs() / 60
        );

        let mut consecutive_errors: u32 = 0;
        let mut pause_notified = false;
        const MAX_CONSECUTIVE_ERRORS: u32 = 3;

        loop {
            // Check if interval needs updating
            {
                let cfg = self.config.read().await;
                let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                if desired != interval.period() {
                    ulog_info!(
                        "[heartbeat] Interval changed to {}min",
                        desired.as_secs() / 60
                    );
                    interval = tokio::time::interval(desired);
                    interval.tick().await; // skip immediate tick
                                           // Config changed — reset error counter to give the new config a chance
                    consecutive_errors = 0;
                    pause_notified = false;
                }
            }

            // Back off: if too many consecutive errors, skip this cycle to stop
            // injecting heartbeat prompts into a broken session (e.g. context overflow)
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                ulog_warn!(
                    "[heartbeat] {} consecutive errors for {}, pausing until config change or success",
                    consecutive_errors, self.bot_label
                );

                // Notify user via IM on first pause (not on every skipped tick)
                if !pause_notified {
                    pause_notified = true;
                    let notify_target = {
                        let rg = router.lock().await;
                        rg.find_any_peer_session()
                    };
                    if let Some((_session_key, _source, source_id)) = notify_target {
                        let error_detail = self.last_error_text.lock().await.take().map(|d| {
                            if d.len() > 200 {
                                format!("{}...", &d[..200])
                            } else {
                                d
                            }
                        });
                        let msg = if let Some(detail) = error_detail {
                            format!(
                                "[MyAgents] {} 心跳连续 {} 次失败，已暂停。\n\n错误: {}\n\n请在客户端重启该 Channel 或开始新对话以恢复。",
                                self.bot_label, MAX_CONSECUTIVE_ERRORS, detail
                            )
                        } else {
                            format!(
                                "[MyAgents] {} 心跳连续 {} 次失败，已暂停。请在客户端重启该 Channel 或开始新对话以恢复。",
                                self.bot_label, MAX_CONSECUTIVE_ERRORS
                            )
                        };
                        if let Err(e) =
                            push_text_preferring_stream(adapter.as_ref(), &source_id, &msg).await
                        {
                            ulog_warn!("[heartbeat] Failed to send pause notification: {}", e);
                        }
                    }
                }

                // Wait for either shutdown, wake signal (config change), or next interval
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() { break; }
                    }
                    Some(_) = wake_rx.recv() => {
                        // Config change or external wake — reset and retry
                        consecutive_errors = 0;
                        pause_notified = false;
                        ulog_info!("[heartbeat] {} resuming after wake signal", self.bot_label);
                        interval.reset();
                    }
                    _ = interval.tick() => {
                        // Still paused — skip this tick
                        continue;
                    }
                }
                continue;
            }

            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        ulog_info!("[heartbeat] Shutdown signal received, exiting");
                        break;
                    }
                }
                _ = interval.tick() => {
                    let ok = self.run_once(
                        HeartbeatWake::new(WakeReason::Interval),
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                        &peer_locks,
                        &health,
                        &agent_id,
                        &workspace_path,
                    ).await;
                    if ok { consecutive_errors = 0; } else { consecutive_errors += 1; }
                }
                Some(reason) = wake_rx.recv() => {
                    // Coalesce: drain any additional wake signals within 250ms window
                    let mut reasons = vec![reason];
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    while let Ok(r) = wake_rx.try_recv() {
                        reasons.push(r);
                    }

                    // Use highest-priority wake; for equal priority preserve explicit routing metadata.
                    let best_wake = reasons.into_iter()
                        .max_by_key(|w| {
                            (
                                u8::from(w.is_high_priority()),
                                u8::from(w.target_session_key.is_some()),
                            )
                        })
                        .unwrap_or_else(|| HeartbeatWake::new(WakeReason::Interval));

                    let ok = self.run_once(
                        best_wake,
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                        &peer_locks,
                        &health,
                        &agent_id,
                        &workspace_path,
                    ).await;
                    if ok { consecutive_errors = 0; } else { consecutive_errors += 1; }

                    // Reset interval timer after wake to avoid rapid fire
                    interval.reset();
                }
            }
        }

        ulog_info!("[heartbeat] Runner stopped for {}", self.bot_label);
    }

    /// Execute a single heartbeat cycle.
    /// Returns `true` if the heartbeat was successful (AI responded), `false` on error/skip.
    /// Uses the same ensure_sidecar flow as user messages — if the sidecar was
    /// idle-collected, it will be automatically restarted.
    ///
    /// Acquires the per-peer lock for the target session_key before calling Sidecar
    /// HTTP APIs. This serializes heartbeat with user messages on the same Sidecar,
    /// preventing imStreamCallback conflicts that would cause lost responses or
    /// double "(No response)" messages.
    async fn run_once<R: Runtime>(
        &self,
        wake: HeartbeatWake,
        router: &Arc<Mutex<SessionRouter>>,
        sidecar_manager: &ManagedSidecarManager,
        adapter: &Arc<AnyAdapter>,
        app_handle: &AppHandle<R>,
        peer_locks: &PeerLocks,
        health: &Arc<HealthManager>,
        agent_id: &str,
        _workspace_path: &str,
    ) -> bool {
        let config = self.config.read().await.clone();
        let reason = wake.reason.clone();
        let target_session_key = wake.target_session_key.clone();
        let is_high_priority = reason.is_high_priority();

        // Gate 1: Enabled check (high-priority wakes bypass — agent-level heartbeat
        // sends delegated wakes to per-channel runners that have enabled=false)
        if !config.enabled && !is_high_priority {
            ulog_debug!("[heartbeat] Skipped: disabled");
            return true; // Gate skip is not a failure
        }

        // Gate 2: Active hours (high-priority wakes skip this)
        if !is_high_priority {
            if let Some(ref active_hours) = config.active_hours {
                if !is_in_active_hours(active_hours) {
                    ulog_debug!("[heartbeat] Skipped: outside active hours");
                    return true; // Gate skip is not a failure
                }
            }
        }

        let Some(_model_work_guard) = self.model_work_gate.try_enter() else {
            ulog_debug!("[heartbeat] Skipped: channel transport is reconnecting");
            return true;
        };

        // Gate 3: Concurrent execution guard
        // Both paths do check+set in a single lock acquisition to avoid TOCTOU races.
        if is_high_priority {
            // High priority (e.g. CronComplete): poll-wait for the lock to become free
            let start = std::time::Instant::now();
            loop {
                let mut executing = self.executing.lock().await;
                if !*executing {
                    *executing = true;
                    break;
                }
                drop(executing);
                if start.elapsed() > Duration::from_secs(60) {
                    ulog_warn!(
                        "[heartbeat] High-priority wake timed out waiting for concurrent execution"
                    );
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        } else {
            let mut executing = self.executing.lock().await;
            if *executing {
                ulog_debug!("[heartbeat] Skipped: previous heartbeat still executing");
                return true; // Gate skip is not a failure
            }
            *executing = true;
        }

        // Resolve the peer session (even if sidecar was idle-collected).
        // Agent-level heartbeat supplies an explicit private target; that path
        // must not fallback to another historical peer if the target vanished.
        // Legacy per-bot wakes with no explicit target keep the old latest-private
        // behavior.
        let (session_key, source, source_id) = {
            let router_guard = router.lock().await;
            if let Some(ref target_key) = target_session_key {
                match router_guard.get_private_peer_session_target(target_key) {
                    Some(target) => (target.session_key, target.source, target.source_id),
                    None => {
                        ulog_warn!(
                            "[heartbeat] Explicit private target missing for {} agent={} session_key={} reason={}, skipping",
                            self.bot_label,
                            agent_id,
                            target_key,
                            reason_label(&reason),
                        );
                        *self.executing.lock().await = false;
                        return true;
                    }
                }
            } else {
                match router_guard.latest_private_peer_session_target() {
                    Some(target) => (target.session_key, target.source, target.source_id),
                    None => {
                        // No private peer sessions at all — no one has ever talked to this bot
                        ulog_debug!(
                            "[heartbeat] No private peer sessions for {}, skipping",
                            self.bot_label
                        );
                        *self.executing.lock().await = false;
                        return true; // No peers is not a failure
                    }
                }
            }
        };

        // Acquire per-peer lock BEFORE any Sidecar I/O.
        // Lock ordering: peer_lock → router_lock (same as processing loop, no deadlock).
        // This ensures heartbeat and user messages to the same Sidecar are serialized,
        // preventing imStreamCallback from being overwritten while a response is in-flight.
        let peer_lock = {
            let mut locks = peer_locks.lock().await;
            locks
                .entry(session_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _peer_guard = peer_lock.lock().await;

        ulog_debug!("[heartbeat] Acquired peer lock for {}", session_key);

        let current_runtime = self.runtime.read().await.clone();
        let current_runtime_config = self.runtime_config.read().await.clone();
        let current_runtime_source = current_runtime_config
            .as_ref()
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        {
            let drift_result = match SessionRouter::check_and_reset_on_runtime_identity_drift(
                router,
                &session_key,
                &current_runtime,
                current_runtime_source.as_deref(),
                sidecar_manager,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    ulog_error!(
                        "[heartbeat] Could not reconcile Session identity for {}: {}",
                        session_key,
                        error
                    );
                    return false;
                }
            };
            if let Some((old_id, new_id)) = drift_result {
                ulog_info!(
                    "[heartbeat] Runtime drift reset peer {} before heartbeat: {} -> {} ({})",
                    session_key,
                    &old_id[..8.min(old_id.len())],
                    &new_id[..8.min(new_id.len())],
                    current_runtime,
                );
                let _ = health::persist_router_active_sessions(
                    health,
                    router,
                    "heartbeat-runtime-drift",
                )
                .await;
            }
        }

        // Ensure sidecar is running — split into 3 phases to avoid holding router lock
        // during the blocking sidecar creation (up to 5 minutes).
        // Phase 1: Check health / extract info (brief lock)
        let prep = {
            let mut router_guard = router.lock().await;
            router_guard
                .prepare_ensure_sidecar(&session_key, sidecar_manager)
                .await
        };

        let (port, is_new_sidecar) = match prep {
            EnsureSidecarPrep::Healthy(p) => (p, false),
            EnsureSidecarPrep::NeedCreate(info) => {
                let info = info.with_runtime_identity(
                    Some(&current_runtime),
                    current_runtime_source.as_deref(),
                );
                // Phase 2: Create sidecar (NO lock held — blocking up to 5 min)
                match super::router::SessionRouter::create_sidecar_blocking(
                    info.clone(),
                    app_handle,
                    sidecar_manager,
                )
                .await
                {
                    // #327: use the authoritative is_new — a reused sidecar (the
                    // manager kept an existing healthy one for this session_id)
                    // reports false so the config sync below is skipped.
                    Ok((port, is_new)) => {
                        // Phase 3: Write result back (brief lock)
                        {
                            let mut router_guard = router.lock().await;
                            router_guard.commit_ensure_sidecar(&session_key, &info, port);
                        }
                        let _ = health::persist_router_active_sessions(
                            health,
                            router,
                            "heartbeat-ensure-sidecar",
                        )
                        .await;
                        (port, is_new)
                    }
                    Err(e) => {
                        ulog_warn!(
                            "[heartbeat] Failed to ensure sidecar for {}: {}",
                            self.bot_label,
                            e
                        );
                        *self.executing.lock().await = false;
                        return false;
                    }
                }
            }
        };

        // Sync AI config for newly created sidecar (same as user message flow).
        // Use brief lock to get http_client, then release — HTTP calls happen outside the lock.
        if is_new_sidecar {
            let model = self.current_model.read().await.clone();
            let penv = self.current_provider_env.read().await.clone();
            let mcp = self.mcp_servers_json.read().await.clone();
            let runtime_config = self.runtime_config.read().await.clone();
            let http_client = {
                let rg = router.lock().await;
                rg.http_client().clone()
            };
            super::router::SessionRouter::sync_ai_config_with_client(
                &http_client,
                port,
                &current_runtime,
                runtime_config.as_ref(),
                model.as_deref(),
                mcp.as_deref(),
                penv.as_ref(),
            )
            .await;
            ulog_info!(
                "[heartbeat] Woke up sidecar for {} on port {}",
                self.bot_label,
                port
            );
        }

        // Touch session activity BEFORE the HTTP call.
        // ensure_sidecar sets last_active when creating a new sidecar, but NOT when
        // returning an existing healthy one. We must touch here to prevent idle collection
        // even if the heartbeat HTTP call times out (which can take up to 5.5 minutes).
        {
            let mut router_guard = router.lock().await;
            router_guard.touch_session_activity(&session_key);
        }
        let _ = health::persist_router_active_sessions(health, router, "heartbeat-touch").await;

        // Build heartbeat prompt — a FIXED template.
        // The actual checklist lives in HEARTBEAT.md in the workspace root.
        // AI reads the file itself via tool use; we don't inject file content here.
        // Cron-completion events are shipped via the `pending_cron_events` body
        // field (Rust-side truth source, see PendingCronEvent doc); legacy
        // non-cron system events still flow through the sidecar's in-memory
        // `systemEventQueue` and get drained server-side.
        let now_text = chrono::Local::now()
            .format("%Y-%m-%d %H:%M (%Z)")
            .to_string();
        let prompt = format!(
            "This is a heartbeat from the system.\n\
             Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.\n\
             Do not infer or repeat old tasks from prior chats.\n\
             If there is nothing that needs attention, reply exactly: HEARTBEAT_OK\n\
             If something needs attention, do NOT include \"HEARTBEAT_OK\"\n\
             \n\
             Current time: {}",
            now_text
        );

        let ack_max_chars = config.ack_max_chars.unwrap_or(300);

        // Snapshot at most ONE pending cron event under the lock, then release.
        // The single-event-per-cycle rule defends against AI partial-relay: if
        // we batched 3 events into one prompt and the AI happened to relay only
        // 2, our success-clears-all logic would silently drop the third. By
        // forcing one event per heartbeat we make every push correspond to a
        // single (task_id, timestamp) ack — the AI can't accidentally drop
        // anything we've claimed to deliver. When pending has more entries,
        // the cascade self-wake at the end of run_once schedules the next one
        // immediately; n events drain in n heartbeat cycles, not n intervals.
        let pending_snapshot: Vec<PendingCronEvent> = {
            let pending = self.pending_cron_events.lock().await;
            snapshot_pending_cron_event_for_session(&pending, &session_key)
        };
        if !pending_snapshot.is_empty() {
            let total_pending = {
                let pending = self.pending_cron_events.lock().await;
                count_pending_cron_events_for_session(&pending, &session_key)
            };
            ulog_info!(
                "[heartbeat] Shipping cron event task_id={} to sidecar for session {} (1 of {} pending for this session)",
                pending_snapshot[0].task_id,
                session_key,
                total_pending
            );
        }

        // Capture the exact binding that owns this request. `session_key` is
        // stable across runtime/model rotation, so it cannot fence a delayed ACK.
        let binding = {
            let router_guard = router.lock().await;
            router_guard.peer_session_snapshot(&session_key)
        };
        let Some(binding) = binding else {
            ulog_warn!(
                "[heartbeat] Peer binding disappeared before dispatch for {}",
                session_key
            );
            *self.executing.lock().await = false;
            return false;
        };
        if binding.sidecar_port != port {
            ulog_warn!(
                "[heartbeat] Peer binding rotated before dispatch for {} (ensured_port={}, current_port={})",
                session_key,
                port,
                binding.sidecar_port
            );
            *self.executing.lock().await = false;
            return false;
        }
        let expected_session_id = binding.session_id;
        let metadata_birth_pending = binding.metadata_birth_pending;

        // Call sidecar heartbeat endpoint (peer_lock is held — no concurrent IM chat possible)
        let request = HeartbeatRequest {
            prompt,
            source: source.clone(),
            source_id: source_id.clone(),
            ack_max_chars,
            is_high_priority,
            runtime: current_runtime.clone(),
            runtime_config: self.runtime_config.read().await.clone(),
            host_interaction: self.host_interaction.clone(),
            metadata_birth_pending,
            pending_cron_events: pending_snapshot.clone(),
        };

        let url = format!("http://127.0.0.1:{}/api/im/heartbeat", port);
        ulog_debug!(
            "[heartbeat] Calling {} (reason={:?})",
            url,
            reason_label(&reason)
        );

        let result = match self.http_client.post(&url).json(&request).send().await {
            Ok(resp) => {
                let status_code = resp.status();
                // Read body as text first for diagnostic logging on parse failure
                let body_text = match resp.text().await {
                    Ok(t) => t,
                    Err(e) => {
                        ulog_warn!(
                            "[heartbeat] Failed to read response body: {} (status={})",
                            e,
                            status_code
                        );
                        *self.last_error_text.lock().await =
                            Some(format!("HTTP read error: {}", e));
                        *self.executing.lock().await = false;
                        return false;
                    }
                };
                match serde_json::from_str::<HeartbeatResponse>(&body_text) {
                    Ok(r) => r,
                    Err(e) => {
                        // Log truncated body for debugging (cap at 300 chars)
                        let preview = if body_text.len() > 300 {
                            &body_text[..300]
                        } else {
                            &body_text
                        };
                        ulog_warn!(
                            "[heartbeat] Failed to parse response: {} (status={}, body={})",
                            e,
                            status_code,
                            preview
                        );
                        *self.last_error_text.lock().await =
                            Some(format!("Response parse error (status={})", status_code));
                        *self.executing.lock().await = false;
                        return false;
                    }
                }
            }
            Err(e) => {
                ulog_warn!("[heartbeat] HTTP call failed: {}", e);
                *self.last_error_text.lock().await = Some(format!("HTTP call failed: {}", e));
                *self.executing.lock().await = false;
                return false;
            }
        };

        // Match ordinary IM enqueue semantics: consume the Router-owned birth
        // authority only after SessionEngine confirms that it accepted the
        // first turn. AI relay or outbound push may still fail independently.
        if metadata_birth_pending && result.message_enqueued {
            let birth_consumed = {
                let mut router_guard = router.lock().await;
                router_guard
                    .mark_metadata_birth_consumed_if_session(&session_key, &expected_session_id)
            };
            if birth_consumed {
                let _ = health::persist_router_active_sessions(
                    health,
                    router,
                    "heartbeat-birth-consumed",
                )
                .await;
                ulog_info!(
                    "[heartbeat] Consumed metadata birth after Sidecar accepted turn for {} ({})",
                    session_key,
                    expected_session_id
                );
            } else {
                ulog_warn!(
                    "[heartbeat] Ignored metadata birth ACK for stale session {} ({})",
                    session_key,
                    expected_session_id
                );
            }
        }

        // Did this cycle successfully ack a cron event? Set inside the "content"
        // arm when push to IM succeeded AND the snapshotted event was cleared
        // from pending. Used only by the cascade-wake decision below: cascade
        // means "we just made progress, immediately try the next pending event";
        // without progress (silent/error/push fail), we fall back to the
        // normal interval tick which gives the IM platform/AI room to recover
        // instead of hot-looping. This is the natural backoff for both AI
        // dropped-relay and IM platform outage.
        let mut cron_event_acked_this_cycle = false;

        // Handle response (still under peer_lock — IM message send is safe)
        let success = match result.status.as_str() {
            "silent" => {
                ulog_debug!("[heartbeat] AI responded HEARTBEAT_OK (silent)");
                true
            }
            "content" => {
                if let Some(text) = &result.text {
                    let is_cron_triggered = !pending_snapshot.is_empty();
                    let mut last_push = self.last_push_text.lock().await;

                    // Dedup is for chatty heartbeat content (e.g. HEARTBEAT.md telling
                    // the AI to keep reminding the user about the same thing). It
                    // MUST NOT apply to cron-triggered cycles: cron payloads carry a
                    // fresh task_id+timestamp every time, but the AI may produce
                    // textually-identical relays for templated daily reports. Treating
                    // dedup-hit as "delivered" would clear pending and silently drop
                    // today's report; instead, cron cycles always attempt the push
                    // and let the platform decide.
                    let dedup_hit =
                        !is_cron_triggered && last_push.as_deref() == Some(text.as_str());

                    let push_succeeded = if dedup_hit {
                        ulog_debug!("[heartbeat] Dedup suppressed (same content as last push)");
                        false
                    } else {
                        ulog_info!("[heartbeat] Pushing content to IM (len={})", text.len());
                        // Only commit to dedup AFTER the IM platform actually accepted
                        // the push. Writing `last_push` on failure turns dedup into a
                        // dead-letter — the next heartbeat carrying the same content
                        // would be silently suppressed.
                        match push_text_preferring_stream(adapter.as_ref(), &source_id, text).await
                        {
                            Ok(_) => {
                                *last_push = Some(text.clone());
                                true
                            }
                            Err(e) => {
                                ulog_warn!("[heartbeat] Failed to send IM message: {}", e);
                                false
                            }
                        }
                    };
                    drop(last_push);

                    // Cron→IM at-least-once: clear the snapshotted event from the
                    // pending vec ONLY on confirmed `push_text_preferring_stream`
                    // success. Push failure / dedup suppression / sidecar restart
                    // (which we'd never reach here) all leave pending intact, and
                    // the next heartbeat retries with the same payload until the IM
                    // platform actually accepts it (or the bot is restarted).
                    //
                    // Match by (task_id, timestamp) so concurrent appends made after
                    // our snapshot are not affected — only the specific entry we
                    // shipped to the sidecar gets cleared.
                    if is_cron_triggered {
                        if push_succeeded {
                            let mut pending = self.pending_cron_events.lock().await;
                            let before = pending.len();
                            pending.retain(|p| {
                                !pending_snapshot.iter().any(|s| {
                                    s.task_id == p.task_id
                                        && s.timestamp == p.timestamp
                                        && s.target_session_key == p.target_session_key
                                })
                            });
                            let cleared = before - pending.len();
                            if cleared > 0 {
                                cron_event_acked_this_cycle = true;
                                ulog_info!(
                                    "[heartbeat] Acked {} cron event(s); {} still pending",
                                    cleared,
                                    pending.len()
                                );
                            }
                        } else {
                            ulog_warn!(
                                "[heartbeat] Cron event task_id={} held in pending — push not confirmed",
                                pending_snapshot[0].task_id
                            );
                        }
                    }
                }
                true
            }
            "error" => {
                ulog_warn!("[heartbeat] Heartbeat returned error: {:?}", result.text);
                *self.last_error_text.lock().await = result.text.clone();
                false
            }
            other => {
                ulog_warn!("[heartbeat] Unknown status: {}", other);
                false
            }
        };

        // Release executing flag (peer_lock is dropped automatically when _peer_guard goes out of scope)
        *self.executing.lock().await = false;

        // Cascade-wake: only trigger an immediate next heartbeat if THIS cycle
        // actually made progress (acked at least one cron event) AND there is
        // another event waiting. Without the progress check we'd hot-loop on
        // persistent failure modes (AI giving silent for cron, or IM platform
        // refusing pushes), each cycle costing AI tokens or hammering the
        // platform. Falling back to the regular interval tick gives natural
        // backoff (30 min by default). Pending is durable across the wait, so
        // nothing is lost — just deferred.
        if cron_event_acked_this_cycle {
            let next_pending = {
                let pending = self.pending_cron_events.lock().await;
                pending.first().map(wake_for_pending_cron_event)
            };
            if let Some(cascade_wake) = next_pending {
                match self.self_wake_tx.try_send(cascade_wake) {
                    Ok(_) => ulog_info!("[heartbeat] Cascade-wake scheduled for next cron event"),
                    Err(mpsc::error::TrySendError::Full(wake)) => {
                        // The runner cannot await its own full queue. Wait for
                        // the next receiver slot without blocking this cycle.
                        let wake_tx = self.self_wake_tx.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = wake_tx.send(wake).await;
                        });
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        // Receiver dropped → runner is shutting down; nothing to do.
                        ulog_debug!("[heartbeat] Cascade-wake skipped: wake channel closed");
                    }
                }
            }
        }

        success
    }
}

/// Check if current time is within the active hours window.
pub fn is_in_active_hours(hours: &ActiveHours) -> bool {
    // Parse timezone
    let tz: chrono_tz::Tz = match hours.timezone.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!(
                "[heartbeat] Invalid timezone '{}', assuming active",
                hours.timezone
            );
            return true;
        }
    };

    let now = chrono::Utc::now().with_timezone(&tz);
    let now_minutes = now.hour() * 60 + now.minute();

    let start_minutes = parse_hhmm(&hours.start).unwrap_or(0);
    let end_minutes = parse_hhmm(&hours.end).unwrap_or(24 * 60);

    if start_minutes <= end_minutes {
        // Normal window: e.g. 09:00-22:00
        now_minutes >= start_minutes && now_minutes < end_minutes
    } else {
        // Cross-midnight window: e.g. 22:00-06:00
        now_minutes >= start_minutes || now_minutes < end_minutes
    }
}

/// Parse "HH:MM" to total minutes since midnight.
fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    Some(h * 60 + m)
}

fn reason_label(reason: &WakeReason) -> &str {
    match reason {
        WakeReason::Interval => "interval",
        WakeReason::CronComplete { .. } => "cron_complete",
        WakeReason::Manual => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cron_event(task_id: &str, target_session_key: Option<&str>) -> PendingCronEvent {
        PendingCronEvent {
            target_session_key: target_session_key.map(|s| s.to_string()),
            event: "cron_complete".to_string(),
            task_id: task_id.to_string(),
            content: format!("content {task_id}"),
            timestamp: 1,
            from_session_id: None,
            from_label: None,
        }
    }

    #[test]
    fn snapshot_pending_cron_event_respects_target_session_key() {
        let pending = vec![
            cron_event("task-a", Some("im:feishu:private:a")),
            cron_event("task-b", Some("im:feishu:private:b")),
        ];

        let snapshot = snapshot_pending_cron_event_for_session(&pending, "im:feishu:private:b");

        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].task_id, "task-b");
    }

    #[test]
    fn snapshot_pending_cron_event_keeps_legacy_unbound_events_eligible() {
        let pending = vec![cron_event("legacy", None)];

        let snapshot = snapshot_pending_cron_event_for_session(&pending, "im:feishu:private:any");

        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].task_id, "legacy");
    }

    #[test]
    fn session_count_excludes_other_private_peers() {
        let pending = vec![
            cron_event("task-a", Some("im:feishu:private:a")),
            cron_event("task-b", Some("im:feishu:private:b")),
            cron_event("legacy", None),
        ];

        assert_eq!(
            count_pending_cron_events_for_session(&pending, "im:feishu:private:a"),
            2,
        );
        assert_eq!(
            count_pending_cron_events_for_session(&pending, "im:feishu:private:b"),
            2,
        );
    }

    #[test]
    fn next_pending_cron_wake_switches_private_target() {
        let event = cron_event("task-b", Some("im:feishu:private:b"));

        let wake = wake_for_pending_cron_event(&event);

        assert!(wake.is_high_priority());
        assert_eq!(
            wake.target_session_key.as_deref(),
            Some("im:feishu:private:b")
        );
        assert!(matches!(
            wake.reason,
            WakeReason::CronComplete { task_id, .. } if task_id == "task-b"
        ));
    }

    #[test]
    fn heartbeat_request_serializes_metadata_birth_authority() {
        let request = HeartbeatRequest {
            prompt: "heartbeat".to_string(),
            source: "feishu_private".to_string(),
            source_id: "peer-1".to_string(),
            ack_max_chars: 300,
            is_high_priority: true,
            runtime: "codex".to_string(),
            runtime_config: None,
            host_interaction: HostInteractionCapability::none(),
            metadata_birth_pending: true,
            pending_cron_events: Vec::new(),
        };

        let payload = serde_json::to_value(request).expect("heartbeat request should serialize");

        assert_eq!(payload["metadataBirthPending"].as_bool(), Some(true));
    }

    #[test]
    fn heartbeat_response_deserializes_enqueue_ack_with_safe_default() {
        let accepted: HeartbeatResponse = serde_json::from_value(serde_json::json!({
            "status": "error",
            "messageEnqueued": true,
        }))
        .expect("heartbeat response with enqueue ack should deserialize");
        let legacy: HeartbeatResponse = serde_json::from_value(serde_json::json!({
            "status": "silent",
        }))
        .expect("legacy heartbeat response should deserialize");

        assert!(accepted.message_enqueued);
        assert!(!legacy.message_enqueued);
    }
}
