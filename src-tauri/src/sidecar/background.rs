use super::manager::{
    BackgroundOwnerAttach, BackgroundOwnerRelease, BackgroundPollBinding, BackgroundPollTarget,
    SessionOwnerRelease,
};
use super::*;

// ============= Background Session Completion =============
// Keeps a Sidecar alive in the background while AI finishes responding,
// even after the Tab releases its ownership.

/// Background completion polling interval (2 seconds)
const BG_POLL_INTERVAL_SECS: u64 = 2;
/// Background completion safety timeout (60 minutes)
const BG_MAX_DURATION_SECS: u64 = 3600;

/// Result from start_background_completion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCompletionResult {
    pub started: bool,
    pub session_id: String,
}

impl BackgroundCompletionResult {
    fn new(session_id: &str, started: bool) -> Self {
        Self {
            started,
            session_id: session_id.to_string(),
        }
    }
}

/// Check if a Sidecar's session is currently in "running" state
/// by calling GET /api/session-state
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarSessionSnapshot {
    session_state: String,
    #[serde(default)]
    is_busy: bool,
    #[serde(default)]
    completion_terminal: Option<crate::notification::SessionCompletionTerminal>,
}

impl SidecarSessionSnapshot {
    fn is_busy(&self) -> bool {
        self.is_busy || matches!(self.session_state.as_str(), "running" | "starting")
    }
}

fn check_sidecar_session_snapshot(port: u16) -> Option<SidecarSessionSnapshot> {
    let url = format!("http://127.0.0.1:{}/api/session-state", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&url).send() {
        Ok(response) if response.status().is_success() => {
            response.json::<SidecarSessionSnapshot>().ok()
        }
        _ => None,
    }
}

pub(super) fn check_sidecar_session_state(port: u16) -> Option<String> {
    check_sidecar_session_snapshot(port).map(|snapshot| snapshot.session_state)
}

pub(super) fn check_sidecar_is_busy(port: u16) -> Option<bool> {
    check_sidecar_session_snapshot(port).map(|snapshot| snapshot.is_busy())
}

fn background_response_is_current(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
    binding: BackgroundPollBinding,
) -> bool {
    manager.lock().ok().is_some_and(|mut manager_guard| {
        manager_guard.background_binding_is_current(session_id, owner, binding)
    })
}

/// Start background completion for a session.
/// Adds a BackgroundCompletion owner and spawns a polling thread.
/// Returns an error when the Sidecar exists but its activity cannot be checked;
/// destructive callers must not interpret that uncertainty as idle.
pub fn start_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<BackgroundCompletionResult, String> {
    // Phase 1: Snapshot the exact process identity (with lock).
    let binding = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        manager_guard.reusable_session_binding(session_id)
    };

    let binding = match binding {
        Some(binding) => binding,
        None => {
            ulog_debug!(
                "[bg-completion] No running sidecar for session {}",
                session_id
            );
            return Ok(BackgroundCompletionResult::new(session_id, false));
        }
    };

    // Phase 2: Check session activity (without lock - HTTP call).
    // (issue #174) `starting` is also "in flight" — the SDK subprocess has
    // been launched but system_init hasn't arrived, and the user might be
    // closing the tab in the up-to-10-minute startup-timeout window. Treat
    // it the same as `running` so background completion attaches and keeps
    // the bootstrapping subprocess alive instead of killing it on tab close.
    let is_busy = check_sidecar_is_busy(binding.port);
    if is_busy.is_none() {
        ulog_warn!(
            "[bg-completion] Unable to read session state for {}",
            session_id
        );
        return Err(format!("Unable to read session activity for {session_id}"));
    }
    if is_busy != Some(true) {
        ulog_info!(
            "[bg-completion] Session {} is not busy, no background completion needed",
            session_id
        );
        return Ok(BackgroundCompletionResult::new(session_id, false));
    }

    // Phase 3: Prefer the probed generation. If replacement won while the
    // HTTP call was in flight, attach to the logical Session under the manager
    // lock so the current process or recovery epoch retains the work.
    let poll_generation = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
        match manager_guard.attach_background_owner_if_current(session_id, bg_owner, binding) {
            BackgroundOwnerAttach::AlreadyOwned => {
                ulog_info!(
                    "[bg-completion] Session {} already has a BackgroundCompletion owner",
                    session_id
                );
                return Ok(BackgroundCompletionResult::new(session_id, true));
            }
            BackgroundOwnerAttach::Attached(current) => Some(current.generation),
            BackgroundOwnerAttach::Recovering => Some(binding.generation),
            BackgroundOwnerAttach::Stale => {
                let owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
                match manager_guard.attach_background_owner_to_logical_session(session_id, owner) {
                    Some(BackgroundOwnerAttach::AlreadyOwned) => {
                        return Ok(BackgroundCompletionResult::new(session_id, true));
                    }
                    Some(BackgroundOwnerAttach::Attached(current)) => Some(current.generation),
                    Some(BackgroundOwnerAttach::Recovering) => Some(binding.generation),
                    Some(BackgroundOwnerAttach::Stale) | None => {
                        return Err(format!(
                            "Sidecar disappeared during activity check for {session_id}"
                        ));
                    }
                }
            }
        }
    };
    ulog_info!(
        "[bg-completion] Added BackgroundCompletion owner to logical session {} (observed generation {:?})",
        session_id,
        poll_generation
    );

    // Phase 4: Spawn polling thread
    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();

    thread::spawn(move || {
        poll_background_completion(
            &app_handle_clone,
            &manager_clone,
            &session_id_clone,
            poll_generation,
        );
    });

    Ok(BackgroundCompletionResult::new(session_id, true))
}

/// Start a BackgroundCompletion owner for a headless message/event delivery.
///
/// Unlike `start_background_completion`, this intentionally does not require
/// `/api/session-state` to already report `running`/`starting`: the caller has
/// just delivered a user/event message and needs an owner to cover the small
/// window before the sidecar flips from idle to running. The shared poller will
/// release the owner on the first idle/error check if no turn actually starts.
pub fn start_headless_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<BackgroundCompletionResult, String> {
    let poll_generation = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
        let Some(attach) =
            manager_guard.attach_background_owner_to_logical_session(session_id, bg_owner)
        else {
            ulog_debug!(
                "[bg-completion] No running sidecar for headless session {}",
                session_id
            );
            return Ok(BackgroundCompletionResult::new(session_id, false));
        };
        match attach {
            BackgroundOwnerAttach::Attached(binding) => Some(binding.generation),
            BackgroundOwnerAttach::Recovering => None,
            BackgroundOwnerAttach::AlreadyOwned => {
                ulog_info!(
                    "[bg-completion] Session {} already has a BackgroundCompletion owner",
                    session_id
                );
                return Ok(BackgroundCompletionResult::new(session_id, true));
            }
            BackgroundOwnerAttach::Stale => {
                return Ok(BackgroundCompletionResult::new(session_id, false));
            }
        }
    };
    ulog_info!(
        "[bg-completion] Added headless BackgroundCompletion owner to logical session {} (observed generation {:?})",
        session_id,
        poll_generation
    );

    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();
    thread::spawn(move || {
        poll_background_completion(
            &app_handle_clone,
            &manager_clone,
            &session_id_clone,
            poll_generation,
        );
    });

    Ok(BackgroundCompletionResult::new(session_id, true))
}

/// Polling loop that runs in a background thread.
/// Checks session state every BG_POLL_INTERVAL_SECS until AI finishes,
/// then removes the BackgroundCompletion owner (which may stop the Sidecar).
fn poll_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    initial_generation: Option<u64>,
) {
    ulog_info!(
        "[bg-completion] Starting polling for session {} at generation {:?}",
        session_id,
        initial_generation
    );
    let start_time = std::time::Instant::now();
    let max_duration = Duration::from_secs(BG_MAX_DURATION_SECS);
    let poll_interval = Duration::from_secs(BG_POLL_INTERVAL_SECS);
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut consecutive_http_failures: u32 = 0;
    let mut expected_generation = initial_generation;
    const MAX_HTTP_FAILURES: u32 = 3;

    loop {
        thread::sleep(poll_interval);

        // Safety timeout
        if start_time.elapsed() > max_duration {
            ulog_warn!(
                "[bg-completion] Session {} hit safety timeout ({} min), stopping",
                session_id,
                BG_MAX_DURATION_SECS / 60
            );
            let sidecar_stopped = match release_session_sidecar(manager, session_id, &bg_owner) {
                Ok(stopped) => stopped,
                Err(error) => {
                    ulog_error!(
                        "[bg-completion] Failed to release timed-out owner for session {}: {}",
                        session_id,
                        error
                    );
                    false
                }
            };
            finish_background_completion(app_handle, session_id, sidecar_stopped);
            return;
        }

        let binding = {
            let mut manager_guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match manager_guard.background_poll_target(session_id, &bg_owner) {
                BackgroundPollTarget::Current(binding) => binding,
                BackgroundPollTarget::Recovering => {
                    consecutive_http_failures = 0;
                    ulog_debug!(
                        "[bg-completion] Session {} is recovering; waiting to rebind",
                        session_id
                    );
                    continue;
                }
                BackgroundPollTarget::Gone => {
                    ulog_info!(
                        "[bg-completion] BackgroundCompletion owner removed for session {}, exiting poll",
                        session_id
                    );
                    return;
                }
            }
        };
        if expected_generation != Some(binding.generation) {
            ulog_info!(
                "[bg-completion] Rebound session {} from generation {:?} to {} (port {})",
                session_id,
                expected_generation,
                binding.generation,
                binding.port
            );
            expected_generation = Some(binding.generation);
            consecutive_http_failures = 0;
        }

        // Check session state via HTTP (lock released, no contention), then
        // revalidate the same generation before consuming any result.
        // (issue #174) `starting` keeps the poll alive — same rationale as
        // the initial gate above: the subprocess is bootstrapping, not done.
        let snapshot = check_sidecar_session_snapshot(binding.port);
        let response_is_current =
            background_response_is_current(manager, session_id, &bg_owner, binding);
        if !response_is_current {
            consecutive_http_failures = 0;
            ulog_debug!(
                "[bg-completion] Discarded stale response for session {} generation {}",
                session_id,
                binding.generation
            );
            continue;
        }

        match snapshot {
            Some(ref snapshot) if snapshot.is_busy() => {
                consecutive_http_failures = 0;
                ulog_debug!(
                    "[bg-completion] Session {} still active (state: {}), continuing poll",
                    session_id,
                    snapshot.session_state
                );
                continue;
            }
            Some(snapshot) => {
                let completion_identity = snapshot
                    .completion_terminal
                    .as_ref()
                    .map(|terminal| (terminal.session_id.as_str(), terminal.turn_id.as_str()));
                let release = manager.lock().ok().map(|mut manager_guard| {
                    manager_guard.release_background_owner_if_current(
                        session_id,
                        &bg_owner,
                        binding,
                        completion_identity,
                    )
                });
                match release {
                    Some(BackgroundOwnerRelease::Released {
                        sidecar_stopped,
                        completion_claim,
                        drain,
                    }) => {
                        if let Err(error) = finish_session_owner_release(
                            manager,
                            SessionOwnerRelease {
                                removed: true,
                                stopped: sidecar_stopped,
                                drain,
                            },
                        ) {
                            ulog_error!(
                                "[bg-completion] Failed to finish owner retirement for session {}: {}",
                                session_id,
                                error
                            );
                            return;
                        }
                        ulog_info!(
                            "[bg-completion] Session {} finished on generation {} (state: {})",
                            session_id,
                            binding.generation,
                            snapshot.session_state
                        );
                        if let (Some(terminal), Some(claim)) =
                            (snapshot.completion_terminal, completion_claim)
                        {
                            crate::notification::submit_session_completion(
                                app_handle, terminal, claim,
                            );
                        }
                        finish_background_completion(app_handle, session_id, sidecar_stopped);
                        return;
                    }
                    Some(BackgroundOwnerRelease::Stale) => {
                        consecutive_http_failures = 0;
                        continue;
                    }
                    Some(BackgroundOwnerRelease::Gone) | None => return,
                }
            }
            None => {
                consecutive_http_failures += 1;
                if consecutive_http_failures >= MAX_HTTP_FAILURES {
                    let release = manager.lock().ok().map(|mut manager_guard| {
                        manager_guard.release_background_owner_if_current(
                            session_id, &bg_owner, binding, None,
                        )
                    });
                    match release {
                        Some(BackgroundOwnerRelease::Released {
                            sidecar_stopped,
                            drain,
                            ..
                        }) => {
                            if let Err(error) = finish_session_owner_release(
                                manager,
                                SessionOwnerRelease {
                                    removed: true,
                                    stopped: sidecar_stopped,
                                    drain,
                                },
                            ) {
                                ulog_error!(
                                    "[bg-completion] Failed to finish unreachable owner retirement for session {}: {}",
                                    session_id,
                                    error
                                );
                                return;
                            }
                            ulog_warn!(
                                "[bg-completion] Session {} generation {} HTTP unreachable {} consecutive times, giving up",
                                session_id, binding.generation, consecutive_http_failures
                            );
                            finish_background_completion(app_handle, session_id, sidecar_stopped);
                            return;
                        }
                        Some(BackgroundOwnerRelease::Stale) => {
                            consecutive_http_failures = 0;
                            continue;
                        }
                        Some(BackgroundOwnerRelease::Gone) | None => return,
                    }
                }
                ulog_warn!(
                    "[bg-completion] Session {} HTTP unreachable ({}/{}), retrying...",
                    session_id,
                    consecutive_http_failures,
                    MAX_HTTP_FAILURES
                );
                continue;
            }
        }
    }
}

fn finish_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    session_id: &str,
    sidecar_stopped: bool,
) {
    ulog_info!(
        "[bg-completion] Session {} background completion finished, sidecar_stopped: {}",
        session_id,
        sidecar_stopped
    );

    // Emit Tauri event to notify frontend
    let _ = app_handle.emit(
        "session:background-complete",
        serde_json::json!({
            "sessionId": session_id,
            "sidecarStopped": sidecar_stopped,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        background_response_is_current, cancel_background_completion, SidecarSessionSnapshot,
    };
    use crate::sidecar::manager::{
        BackgroundOwnerAttach, BackgroundOwnerRelease, BackgroundPollTarget,
    };
    use crate::sidecar::{SidecarManager, SidecarOwner};
    use std::sync::{Arc, Mutex};

    #[test]
    fn busy_snapshot_includes_accepted_queue_work_and_legacy_active_states() {
        let queued: SidecarSessionSnapshot = serde_json::from_value(serde_json::json!({
            "sessionState": "idle",
            "isBusy": true
        }))
        .unwrap();
        assert!(queued.is_busy());

        let legacy_running: SidecarSessionSnapshot = serde_json::from_value(serde_json::json!({
            "sessionState": "running"
        }))
        .unwrap();
        assert!(legacy_running.is_busy());

        let idle: SidecarSessionSnapshot = serde_json::from_value(serde_json::json!({
            "sessionState": "idle"
        }))
        .unwrap();
        assert!(!idle.is_busy());
    }

    #[test]
    fn initial_busy_probe_rebinds_owner_to_the_current_logical_session() {
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32001,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        let observed = manager
            .reusable_session_binding("session-a")
            .expect("initial binding");

        manager.begin_session_sidecar_replacement("session-a");
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32002,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        manager
            .commit_ready_session_sidecar("session-a")
            .expect("replacement commit");

        let owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        assert_eq!(
            manager.attach_background_owner_if_current("session-a", owner.clone(), observed),
            BackgroundOwnerAttach::Stale
        );
        assert!(matches!(
            manager.attach_background_owner_to_logical_session("session-a", owner.clone()),
            Some(BackgroundOwnerAttach::Attached(binding)) if binding.port == 32002
        ));
        assert!(manager.session_has_exact_owner("session-a", &owner));
    }

    #[test]
    fn initial_busy_probe_retains_owner_through_a_replacement_gap() {
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32001,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        let observed = manager
            .reusable_session_binding("session-a")
            .expect("initial binding");
        manager.begin_session_sidecar_replacement("session-a");

        let owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        assert_eq!(
            manager.attach_background_owner_if_current("session-a", owner.clone(), observed),
            BackgroundOwnerAttach::Stale
        );
        assert_eq!(
            manager.attach_background_owner_to_logical_session("session-a", owner.clone()),
            Some(BackgroundOwnerAttach::Recovering)
        );
        assert_eq!(
            manager.background_poll_target("session-a", &owner),
            BackgroundPollTarget::Recovering
        );
    }

    #[test]
    fn initial_busy_probe_moves_a_dead_active_generation_into_recovery() {
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32001,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        let observed = manager
            .reusable_session_binding("session-a")
            .expect("initial binding");
        manager
            .get_session_sidecar_mut("session-a")
            .expect("active sidecar")
            .state = super::super::SidecarState::Dead;

        let owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        assert_eq!(
            manager.attach_background_owner_if_current("session-a", owner.clone(), observed),
            BackgroundOwnerAttach::Stale
        );
        assert_eq!(
            manager.attach_background_owner_to_logical_session("session-a", owner.clone()),
            Some(BackgroundOwnerAttach::Recovering)
        );

        assert!(
            manager
                .remove_session_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),)
                .removed
        );
        assert_eq!(
            manager.background_poll_target("session-a", &owner),
            BackgroundPollTarget::Recovering
        );
        assert!(manager.session_has_exact_owner("session-a", &owner));
    }

    #[test]
    fn stale_idle_running_and_http_failure_responses_cannot_release_new_owner() {
        let owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar("session-a", 32001, owner.clone());
        let old_binding = match manager.background_poll_target("session-a", &owner) {
            BackgroundPollTarget::Current(binding) => binding,
            other => panic!("expected current binding, got {other:?}"),
        };

        manager.begin_session_sidecar_replacement("session-a");
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32002,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        let new_generation = manager.current_generation("session-a");
        assert_eq!(
            manager.background_poll_target("session-a", &owner),
            BackgroundPollTarget::Recovering,
            "an uncommitted candidate is still an explicit recovery wait"
        );
        manager
            .commit_ready_session_sidecar("session-a")
            .expect("replacement commit");
        let manager = Arc::new(Mutex::new(manager));

        // All three response boundaries pass through the same post-HTTP fence.
        for response_boundary in ["running", "idle", "http-failure"] {
            assert!(
                !background_response_is_current(&manager, "session-a", &owner, old_binding,),
                "{response_boundary} from the old generation was accepted"
            );
        }

        let mut guard = manager.lock().expect("manager lock");
        assert!(matches!(
            guard.release_background_owner_if_current("session-a", &owner, old_binding, None),
            BackgroundOwnerRelease::Stale
        ));
        assert!(guard.session_has_exact_owner("session-a", &owner));
        let rebound = match guard.background_poll_target("session-a", &owner) {
            BackgroundPollTarget::Current(binding) => binding,
            other => panic!("expected rebound current target, got {other:?}"),
        };
        assert_eq!(rebound.generation, new_generation);
        assert_eq!(rebound.port, 32002);
        assert!(matches!(
            guard.release_background_owner_if_current("session-a", &owner, rebound, None),
            BackgroundOwnerRelease::Released {
                sidecar_stopped: false,
                completion_claim: None,
                drain: None,
            }
        ));
    }

    #[test]
    fn explicit_cancel_releases_background_owner_during_recovery_gap() {
        let owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar("session-a", 32001, owner.clone());
        manager.begin_session_sidecar_replacement("session-a");
        let manager = Arc::new(Mutex::new(manager));

        assert_eq!(
            cancel_background_completion(&manager, "session-a"),
            Ok(true)
        );
        let guard = manager.lock().expect("manager lock");
        assert!(!guard.session_has_exact_owner("session-a", &owner));
        assert!(!guard.has_session_recovery("session-a"));
    }
}

/// Cancel background completion for a session (e.g., when user reconnects).
///
/// Pattern 1 (Unified Cancellation): goes through `release_session_sidecar`
/// rather than mutating `sidecar.owners` directly. The release path is the
/// canonical "owner removal + maybe-stop" entry — bypassing it left the
/// "owners empty → stop sidecar" invariant unenforced (audit A: ownerless
/// but live sidecar → orphan).
///
/// Pre-check whether the BackgroundCompletion owner exists before calling
/// release (release returns Ok(false) for non-existent owners too, but we
/// want to distinguish "no-op because nothing to cancel" from "released").
pub fn cancel_background_completion(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());

    // Cheap probe: does this session have the BackgroundCompletion owner?
    // Holding the lock only for the read keeps release_session_sidecar's
    // own lock acquisition uncontested.
    let has_bg_owner = {
        let manager_guard = manager.lock().map_err(|e| e.to_string())?;
        manager_guard.session_has_exact_owner(session_id, &bg_owner)
    };

    if !has_bg_owner {
        ulog_debug!(
            "[bg-completion] No BackgroundCompletion owner to cancel for session {}",
            session_id
        );
        return Ok(false);
    }

    // Delegate to the canonical release path so the "owners empty → stop"
    // invariant is enforced and any ancillary cleanup runs.
    let stopped = release_session_sidecar(manager, session_id, &bg_owner)?;
    ulog_info!(
        "[bg-completion] Cancelled background completion for session {} (sidecar_stopped: {})",
        session_id,
        stopped
    );
    Ok(true)
}

/// Start background completion for a session
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_start_background_completion(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<BackgroundCompletionResult, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_background_completion(&app_handle, &manager, &sessionId)
    })
    .await
    .map_err(|error| format!("Background completion start task failed: {error:?}"))?
}

/// Cancel background completion for a session (when user reconnects)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_cancel_background_completion(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cancel_background_completion(&manager, &sessionId))
        .await
        .map_err(|error| format!("Background completion cancel task failed: {error:?}"))?
}

/// Get session IDs that have active background completions
#[tauri::command]
pub fn cmd_get_background_sessions(
    state: tauri::State<'_, ManagedSidecarManager>,
) -> Result<Vec<String>, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_background_session_ids())
}
