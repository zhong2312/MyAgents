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

/// Check if a Sidecar's session is currently in "running" state
/// by calling GET /api/session-state
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarSessionSnapshot {
    session_state: String,
    #[serde(default)]
    completion_terminal: Option<crate::notification::SessionCompletionTerminal>,
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

/// Start background completion for a session.
/// Adds a BackgroundCompletion owner and spawns a polling thread.
/// Returns { started: true } if AI is actively running, { started: false } if idle.
pub fn start_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<BackgroundCompletionResult, String> {
    let result_id = session_id.to_string();

    // Phase 1: Check if sidecar exists and get port (with lock)
    let port = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_reusable() {
                Some(sidecar.port)
            } else {
                None
            }
        } else {
            None
        }
    };

    let port = match port {
        Some(p) => p,
        None => {
            ulog_debug!(
                "[bg-completion] No running sidecar for session {}",
                session_id
            );
            return Ok(BackgroundCompletionResult {
                started: false,
                session_id: result_id,
            });
        }
    };

    // Phase 2: Check session state (without lock - HTTP call).
    // (issue #174) `starting` is also "in flight" — the SDK subprocess has
    // been launched but system_init hasn't arrived, and the user might be
    // closing the tab in the up-to-10-minute startup-timeout window. Treat
    // it the same as `running` so background completion attaches and keeps
    // the bootstrapping subprocess alive instead of killing it on tab close.
    let state = check_sidecar_session_state(port);
    let is_active = matches!(state.as_deref(), Some("running") | Some("starting"));

    if !is_active {
        ulog_info!("[bg-completion] Session {} is not active (state: {:?}), no background completion needed", session_id, state);
        return Ok(BackgroundCompletionResult {
            started: false,
            session_id: result_id,
        });
    }

    // Phase 3: Add BackgroundCompletion owner (with lock)
    {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
            if sidecar.owners.contains(&bg_owner) {
                ulog_info!(
                    "[bg-completion] Session {} already has a BackgroundCompletion owner",
                    session_id
                );
                return Ok(BackgroundCompletionResult {
                    started: true,
                    session_id: result_id,
                });
            }
            sidecar.add_owner(bg_owner);
            ulog_info!(
                "[bg-completion] Added BackgroundCompletion owner to session {} (port {})",
                session_id,
                port
            );
        } else {
            ulog_warn!(
                "[bg-completion] Sidecar disappeared during state check for session {}",
                session_id
            );
            return Ok(BackgroundCompletionResult {
                started: false,
                session_id: result_id,
            });
        }
    }

    // Phase 4: Spawn polling thread
    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();

    thread::spawn(move || {
        poll_background_completion(&app_handle_clone, &manager_clone, &session_id_clone, port);
    });

    Ok(BackgroundCompletionResult {
        started: true,
        session_id: result_id,
    })
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
    let result_id = session_id.to_string();
    let port = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) else {
            ulog_debug!(
                "[bg-completion] No running sidecar for headless session {}",
                session_id
            );
            return Ok(BackgroundCompletionResult {
                started: false,
                session_id: result_id,
            });
        };
        if !sidecar.is_reusable() {
            ulog_debug!(
                "[bg-completion] Sidecar for headless session {} is not reusable",
                session_id
            );
            return Ok(BackgroundCompletionResult {
                started: false,
                session_id: result_id,
            });
        }

        let port = sidecar.port;
        let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
        if sidecar.owners.contains(&bg_owner) {
            ulog_info!(
                "[bg-completion] Session {} already has a BackgroundCompletion owner",
                session_id
            );
            return Ok(BackgroundCompletionResult {
                started: true,
                session_id: result_id,
            });
        }
        sidecar.add_owner(bg_owner);
        ulog_info!(
            "[bg-completion] Added headless BackgroundCompletion owner to session {} (port {})",
            session_id,
            port
        );
        port
    };

    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();

    thread::spawn(move || {
        poll_background_completion(&app_handle_clone, &manager_clone, &session_id_clone, port);
    });

    Ok(BackgroundCompletionResult {
        started: true,
        session_id: result_id,
    })
}

/// Polling loop that runs in a background thread.
/// Checks session state every BG_POLL_INTERVAL_SECS until AI finishes,
/// then removes the BackgroundCompletion owner (which may stop the Sidecar).
fn poll_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    port: u16,
) {
    ulog_info!(
        "[bg-completion] Starting polling for session {} on port {}",
        session_id,
        port
    );
    let start_time = std::time::Instant::now();
    let max_duration = Duration::from_secs(BG_MAX_DURATION_SECS);
    let poll_interval = Duration::from_secs(BG_POLL_INTERVAL_SECS);
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut consecutive_http_failures: u32 = 0;
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
            break;
        }

        // Check owner still exists + sidecar process still alive (single lock acquisition)
        {
            let mut manager_guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match manager_guard.sidecars.get_mut(session_id) {
                Some(sidecar) => {
                    // Owner removed externally (e.g., user reconnected via cancelBackgroundCompletion)
                    if !sidecar.owners.contains(&bg_owner) {
                        ulog_info!("[bg-completion] BackgroundCompletion owner removed for session {} (user reconnected?), exiting poll", session_id);
                        return; // Don't remove owner - it's already gone
                    }
                    // Process died
                    if sidecar.is_dead() {
                        ulog_warn!(
                            "[bg-completion] Sidecar process died for session {}",
                            session_id
                        );
                        break;
                    }
                }
                None => {
                    ulog_info!(
                        "[bg-completion] Sidecar removed for session {}, exiting poll",
                        session_id
                    );
                    return; // Sidecar already gone, nothing to clean up
                }
            }
        }

        // Check session state via HTTP (lock released, no contention).
        // (issue #174) `starting` keeps the poll alive — same rationale as
        // the initial gate above: the subprocess is bootstrapping, not done.
        match check_sidecar_session_snapshot(port) {
            Some(ref snapshot)
                if snapshot.session_state == "running" || snapshot.session_state == "starting" =>
            {
                consecutive_http_failures = 0;
                ulog_debug!(
                    "[bg-completion] Session {} still active (state: {}), continuing poll",
                    session_id,
                    snapshot.session_state
                );
                continue;
            }
            Some(snapshot) => {
                ulog_info!(
                    "[bg-completion] Session {} finished (state: {})",
                    session_id,
                    snapshot.session_state
                );
                if let Some(terminal) = snapshot.completion_terminal {
                    crate::notification::submit_session_completion(app_handle, terminal);
                }
                break;
            }
            None => {
                consecutive_http_failures += 1;
                if consecutive_http_failures >= MAX_HTTP_FAILURES {
                    ulog_warn!(
                        "[bg-completion] Session {} HTTP unreachable {} consecutive times, giving up",
                        session_id, consecutive_http_failures
                    );
                    break;
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

    // Remove BackgroundCompletion owner
    let sidecar_stopped = match release_session_sidecar(manager, session_id, &bg_owner) {
        Ok(stopped) => stopped,
        Err(e) => {
            ulog_error!(
                "[bg-completion] Failed to release owner for session {}: {}",
                session_id,
                e
            );
            false
        }
    };

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
        manager_guard
            .sidecars
            .get(session_id)
            .map(|s| s.owners.contains(&bg_owner))
            .unwrap_or(false)
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
pub fn cmd_start_background_completion(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<BackgroundCompletionResult, String> {
    start_background_completion(&app_handle, &state, &sessionId)
}

/// Cancel background completion for a session (when user reconnects)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_cancel_background_completion(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    cancel_background_completion(&state, &sessionId)
}

/// Get session IDs that have active background completions
#[tauri::command]
pub fn cmd_get_background_sessions(
    state: tauri::State<'_, ManagedSidecarManager>,
) -> Result<Vec<String>, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_background_session_ids())
}
