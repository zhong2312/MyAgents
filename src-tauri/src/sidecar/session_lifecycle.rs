use super::*;

pub(crate) type SessionLifecycleGuard = crate::keyed_lifecycle::KeyedLifecycleGuard;

static SESSION_LIFECYCLE_LOCKS: std::sync::OnceLock<
    crate::keyed_lifecycle::KeyedLifecycleRegistry,
> = std::sync::OnceLock::new();

pub(crate) async fn acquire_session_lifecycle(session_ids: &[&str]) -> SessionLifecycleGuard {
    SESSION_LIFECYCLE_LOCKS
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .acquire(session_ids)
        .await
}

pub(crate) async fn has_persisted_session_owner(session_id: &str) -> Result<bool, String> {
    Ok(crate::session_goal::get_session_goal_manager()
        .has_session_identity_protection(session_id)
        .await
        .map_err(|error| error.to_string())?
        || crate::task_scheduler::has_persistent_task_for_session(session_id).await)
}

async fn has_non_tab_session_owner(
    session_id: &str,
    agents: &crate::im::ManagedAgents,
    im_bots: &crate::im::ManagedImBots,
) -> Result<bool, String> {
    if has_persisted_session_owner(session_id).await? {
        return Ok(true);
    }
    Ok(crate::im::session_delivery::has_session_binding(agents, im_bots, session_id).await)
}

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
    /// Internal process identity used to commit replacement work. This is not
    /// part of the renderer/Tauri wire contract.
    #[serde(skip)]
    pub(crate) generation: u64,
}

/// Upper bound on ensure re-entry. The ensure path re-runs itself on
/// generation-change and concurrent-create (it must re-wait for `/health/ready`
/// rather than return a replacement port directly). This caps that re-entry so
/// a thrashing health monitor that keeps bumping the generation can't recurse
/// without a depth bound. Each attempt costs ≥2s (HTTP/readiness window), so 8
/// is generous — real churn settles in 1–2 (cross-review: all three reviewers
/// flagged the prior unbounded self-recursion).
const MAX_ENSURE_ATTEMPTS: u32 = 8;
const RECOVERY_ATTEMPT_STALE: &str = "RECOVERY_ATTEMPT_STALE";

fn sidecar_generation_is_alive(
    manager: &ManagedSidecarManager,
    session_id: &str,
    generation: u64,
) -> bool {
    let Ok(mut guard) = manager.lock() else {
        return true;
    };
    if guard.current_generation(session_id) != generation {
        return false;
    }
    guard
        .sidecars
        .get_mut(session_id)
        .map(|sidecar| matches!(sidecar.process.try_wait(), Ok(None)))
        .unwrap_or(false)
}

pub fn ensure_session_sidecar_with_runtime_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_identity_override(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        None,
    )
}

/// Blocking ensure kernel. Callers must normally use the lifecycle-fenced
/// async wrapper below. The health monitor is the sole direct caller because
/// it already holds the lifecycle guard while preserving the dead owner object
/// across restart failure.
pub(crate) fn ensure_session_sidecar_with_runtime_identity_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    let _lifecycle_spawn_permit = begin_lifecycle_spawn_permit()?;
    let attempt_result = ensure_session_sidecar_attempt(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        runtime_source_override,
        0,
        expected_recovery_epoch,
    );
    let mut result = match attempt_result {
        Ok(result) => result,
        Err(error) => {
            if let Ok(mut manager_guard) = manager.lock() {
                if error != RECOVERY_ATTEMPT_STALE {
                    if let Some(failure) = manager_guard.record_session_recovery_failure(
                        session_id,
                        expected_recovery_epoch,
                        std::time::Instant::now(),
                    ) {
                        ulog_error!(
                            "[sidecar-recovery] action=retry-scheduled session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                            session_id,
                            failure.epoch,
                            failure.dead_generation,
                            failure.candidate_generation,
                            failure.failed_attempts,
                            failure.retry_after.as_millis(),
                            error
                        );
                    }
                }
            }
            return Err(error);
        }
    };
    let should_commit = result.is_new
        || manager
            .lock()
            .map_err(|error| error.to_string())?
            .has_session_recovery(session_id);
    if should_commit {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        let Some(commit) = manager_guard.commit_ready_session_sidecar(session_id) else {
            let error = format!(
                "Session {} replacement on port {} lost lifecycle authority before commit",
                session_id, result.port
            );
            if let Some(failure) = manager_guard.record_session_recovery_failure(
                session_id,
                expected_recovery_epoch,
                std::time::Instant::now(),
            ) {
                ulog_error!(
                    "[sidecar-recovery] action=commit-rejected session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                    session_id,
                    failure.epoch,
                    failure.dead_generation,
                    failure.candidate_generation,
                    failure.failed_attempts,
                    failure.retry_after.as_millis(),
                    error
                );
            }
            return Err(error);
        };
        if commit.generation != result.generation || commit.port != result.port {
            result.port = commit.port;
            result.generation = commit.generation;
            result.is_new = false;
        }
    }
    Ok(result)
}

/// Async pit-of-success entrypoint for every owner-acquiring ensure.
///
/// The per-session lifecycle guard is held across the entire blocking ensure,
/// including readiness waits. Session deletion takes the same guard, so it
/// cannot validate an ownerless identity and then have this path recreate that
/// fixed identity immediately after deletion.
pub(crate) async fn ensure_session_sidecar_with_lifecycle<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_identity_override_lifecycle(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        None,
        None,
    )
    .await
}

pub(crate) async fn ensure_session_sidecar_with_runtime_identity_override_lifecycle<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    let lifecycle = Arc::new(acquire_session_lifecycle(&[&session_id]).await);
    ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
        lifecycle,
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        runtime_source_override,
    )
    .await
}

/// Blocking-thread ensure for a caller that already owns this Session's
/// lifecycle authority. The shared lease keeps that exact acquisition alive
/// through readiness without attempting to re-enter the non-reentrant lock.
///
/// Task reservation is the non-generic caller: the exact execution retains a
/// shared handle until SessionStore metadata is born, while the worker moves
/// its handle through Sidecar ensure. Other callers use the wrapper above.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ensure_session_sidecar_with_runtime_identity_override_lifecycle_held<
    R: Runtime,
>(
    lifecycle: Arc<SessionLifecycleGuard>,
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    // Keep the caller's authority alive until the blocking ensure and its
    // readiness wait finish. This is intentionally not a fresh acquisition.
    let _lifecycle = lifecycle;
    let ensure_app_handle = app_handle.clone();
    let event_session_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        ensure_session_sidecar_with_runtime_identity_override(
            &ensure_app_handle,
            &manager,
            &session_id,
            &workspace_path,
            owner,
            runtime_override,
            runtime_source_override,
            None,
        )
    })
    .await
    .map_err(|error| format!("ensure_session_sidecar blocking task failed: {error:?}"))??;

    // Every newly-created process starts a fresh liveRevision epoch. Emit from
    // the shared async ensure authority (not just the renderer command) so a
    // Task/IM/Goal revive cannot leave an attached Tab comparing revisions
    // from the previous process. First-ever creates are harmless: renderer
    // consumers filter by their currently attached Session, and pending births
    // already ignore this event.
    if result.is_new {
        let _ = app_handle.emit(
            "session-sidecar:restarted",
            serde_json::json!({
                "sessionId": event_session_id,
                "port": result.port,
            }),
        );
    }
    Ok(result)
}

fn resolve_runtime_identity_for_owner(
    owner: &SidecarOwner,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
    session_runtime_identity: Option<RuntimeIdentity>,
    agent_runtime_identity: Option<RuntimeIdentity>,
) -> RuntimeIdentity {
    let session_runtime = session_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.clone());
    let agent_runtime = agent_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.clone());
    let resolved_runtime = resolve_runtime_for_owner(
        runtime_override.map(str::to_string),
        owner,
        session_runtime,
        agent_runtime,
    );
    let resolved_runtime_name = normalize_runtime_name(resolved_runtime.as_deref()).to_string();
    let resolved_runtime_source = if resolved_runtime_name == "builtin" {
        None
    } else if runtime_override.is_some() {
        Some(runtime_source_override.unwrap_or("system-cli"))
    } else if session_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.as_str())
        == Some(resolved_runtime_name.as_str())
        && !owner_prefers_live_agent_runtime(owner)
    {
        session_runtime_identity
            .as_ref()
            .and_then(|identity| identity.runtime_source.as_deref())
    } else if agent_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.as_str())
        == Some(resolved_runtime_name.as_str())
    {
        agent_runtime_identity
            .as_ref()
            .and_then(|identity| identity.runtime_source.as_deref())
    } else {
        Some("system-cli")
    };
    RuntimeIdentity::new(Some(&resolved_runtime_name), resolved_runtime_source)
}

fn resolve_expected_runtime_identity(
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: &SidecarOwner,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
) -> RuntimeIdentity {
    // Existing Session metadata is authoritative for desktop-style owners.
    // A metadata creator has no Session row yet, so it follows the exact same
    // override -> Agent resolution that the spawn path uses. Live IM owners
    // intentionally ignore Session metadata and follow the Agent default.
    let session_runtime_identity = if owner_prefers_live_agent_runtime(owner) {
        None
    } else {
        resolve_session_runtime_identity_full(session_id)
    };
    let agent_runtime_identity = resolve_agent_runtime_identity_from_config(workspace_path);
    resolve_runtime_identity_for_owner(
        owner,
        runtime_override,
        runtime_source_override,
        session_runtime_identity,
        agent_runtime_identity,
    )
}

fn ensure_session_sidecar_attempt<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    if attempt >= MAX_ENSURE_ATTEMPTS {
        return Err(format!(
            "Session {} ensure exceeded {} attempts (sidecar generation churn not settling)",
            session_id, MAX_ENSURE_ATTEMPTS
        ));
    }
    ulog_info!(
        "[sidecar] ensure_session_sidecar called for session: {}, owner: {:?} (attempt {})",
        session_id,
        owner,
        attempt
    );
    let ensure_started = trace_start();
    let owner_for_trace = format!("{:?}", owner);
    let expected_runtime_identity = resolve_expected_runtime_identity(
        session_id,
        workspace_path,
        &owner,
        runtime_override.as_deref(),
        runtime_source_override.as_deref(),
    );
    let requested_runtime_for_trace = expected_runtime_identity.runtime.clone();
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_start")
            .session_id(Some(session_id))
            .runtime(Some(&requested_runtime_for_trace))
            .detail("owner", &owner_for_trace),
    );

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — same barrier as
    // `start_tab_sidecar`. Without this, Cron task recovery / session-monitor
    // auto-restart / IM message arrival during the startup window would spawn
    // a new session sidecar that races with the stale-process sweep (the very
    // case db58545 set out to prevent). In the common case this returns
    // immediately (AtomicBool load; cleanup completes in ~50 ms).
    wait_for_startup_cleanup(Duration::from_secs(15))?;

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");
    if expected_recovery_epoch.is_some_and(|epoch| {
        !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
    }) {
        return Err(RECOVERY_ATTEMPT_STALE.to_string());
    }

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    // Note: there used to be an inline drift check for Agent-owner Sidecars
    // here, but it's been removed as of v0.1.66. Drift is now handled at the
    // IM router layer (`SessionRouter::check_and_reset_on_runtime_drift`)
    // which runs BEFORE `ensure_session_sidecar` and regenerates the peer
    // session_id on drift. By the time we reach here:
    //
    //   - IM message path (router-driven): the router already forked to a
    //     fresh session_id, so `session_id` has no existing Sidecar and the
    //     spawn path below uses the owner-aware priority chain to pick the
    //     correct runtime from agent config.
    //
    //   - memory auto-update callers: they target an existing session_id
    //     that may be shared with a desktop Tab. Killing the Sidecar here
    //     would orphan the Tab's SSE stream. Better to let memory_auto_update
    //     reuse the existing (possibly stale-runtime) Sidecar — memory file
    //     updates are runtime-agnostic so a mismatched runtime doesn't
    //     actually break anything.
    //
    // The priority chain at the spawn path below still enforces "Agent owner
    // uses agent config, not session metadata" so fresh spawns for Agent
    // owners always honor the user's latest runtime choice, including the
    // external → builtin switch direction.

    let existing_sidecar_info: Option<ExistingSidecarReuse> = {
        let generation = manager_guard.current_generation(session_id);
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                manager_guard.begin_session_sidecar_replacement(session_id);
                None
            } else if sidecar.is_reusable() {
                if validate_sidecar_runtime_invariant(
                    session_id,
                    &expected_runtime_identity,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-healthy-precheck",
                )
                .is_err()
                {
                    manager_guard.begin_session_sidecar_replacement(session_id);
                    manager_guard.clear_generation(session_id);
                    None
                } else {
                    // Healthy — needs HTTP verification outside the lock
                    Some(ExistingSidecarReuse::Healthy {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                    })
                }
            } else {
                // Starting — another thread is doing wait_for_health/readiness.
                // Add the owner now, then wait for /health/ready outside the lock.
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id,
                    sidecar.port,
                    owner
                );
                if validate_sidecar_runtime_invariant(
                    session_id,
                    &expected_runtime_identity,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-starting",
                )
                .is_err()
                {
                    manager_guard.begin_session_sidecar_replacement(session_id);
                    manager_guard.clear_generation(session_id);
                    None
                } else {
                    let owner_added = sidecar.add_owner(owner.clone());
                    Some(ExistingSidecarReuse::Starting {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                        owner_added,
                    })
                }
            }
        } else {
            None
        }
    };

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(existing) = existing_sidecar_info {
        let (
            port,
            pre_gen,
            runtime_for_trace,
            runtime_source_for_trace,
            wait_for_starting,
            joined_owner_added,
        ) = match existing {
            ExistingSidecarReuse::Healthy {
                port,
                generation,
                runtime,
                runtime_source,
            } => (port, generation, runtime, runtime_source, false, false),
            ExistingSidecarReuse::Starting {
                port,
                generation,
                runtime,
                runtime_source,
                owner_added,
            } => (port, generation, runtime, runtime_source, true, owner_added),
        };
        let runtime_source_label =
            normalize_runtime_source_name(&runtime_for_trace, runtime_source_for_trace.as_deref())
                .to_string();
        drop(manager_guard);

        let check_started = trace_start();
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_start")
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );
        let http_healthy = if wait_for_starting {
            let readiness_alive = || sidecar_generation_is_alive(manager, session_id, pre_gen);
            wait_for_readiness(port, 30, Some(&readiness_alive)).is_ok()
        } else {
            // Verify HTTP server is actually responsive (not just process alive)
            check_sidecar_http_health(port)
        };
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_end")
                .duration_ms(elapsed_ms(check_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .status(if http_healthy { "ok" } else { "error" })
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if expected_recovery_epoch.is_some_and(|epoch| {
            !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
        }) {
            return Err(RECOVERY_ATTEMPT_STALE.to_string());
        }
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Re-enter the normal ensure path for the replacement instead of returning its
            // port directly. The replacement may still be Starting; the normal path knows
            // how to wait for /health/ready and also re-verifies Healthy sidecars over HTTP.
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, retrying ensure",
                        session_id,
                        sidecar.port,
                        sidecar.state
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-replacement",
                    )
                    .is_err()
                    {
                        manager_guard.begin_session_sidecar_replacement(session_id);
                        manager_guard.clear_generation(session_id);
                    } else {
                        drop(manager_guard);
                        return ensure_session_sidecar_attempt(
                            app_handle,
                            manager,
                            session_id,
                            workspace_path,
                            owner,
                            runtime_override,
                            runtime_source_override,
                            attempt + 1,
                            expected_recovery_epoch,
                        );
                    }
                }
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            let mut remove_for_runtime_drift = false;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id,
                        port,
                        owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-http-healthy",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail(
                                    "reuse",
                                    if wait_for_starting {
                                        "starting-ready"
                                    } else {
                                        "healthy"
                                    },
                                ),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                            generation: pre_gen,
                        });
                    }
                } else if sidecar.port == port && wait_for_starting {
                    ulog_info!(
                        "[sidecar] Session {} starting Sidecar reached readiness on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-starting-ready",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.state = SidecarState::Healthy;
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail("reuse", "starting-ready"),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                            generation: pre_gen,
                        });
                    }
                }
            }
            if remove_for_runtime_drift {
                manager_guard.begin_session_sidecar_replacement(session_id);
                manager_guard.clear_generation(session_id);
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            if wait_for_starting {
                // We joined a sidecar that another owner was already starting.
                // Our independent readiness timeout must not kill or replace
                // that startup; the original creator may still be inside its
                // longer TCP+ready boot window. Detach only the owner we added.
                ulog_warn!(
                    "[sidecar] Session {} starting Sidecar on port {} did not become ready for joining owner {:?}; preserving original startup",
                    session_id, port, owner
                );
                // Only detach the owner if THIS call actually added it. When the
                // owner was already present (a same-owner concurrent ensure joined
                // the same Starting sidecar), `add_owner` returned false; removing
                // it here would empty the shared owner set and tear down a sidecar
                // the other caller is still legitimately starting (cross-review
                // Codex Critical #2). Leave teardown to whoever truly owns it.
                let should_stop = if joined_owner_added {
                    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                        let (removed, last_owner_removed) = sidecar.remove_owner(&owner);
                        sidecar.port == port && removed && last_owner_removed
                    } else {
                        false
                    }
                } else {
                    false
                };
                if should_stop {
                    manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                }
                return Err(format!(
                    "Session {} sidecar on port {} is still starting",
                    session_id, port
                ));
            }
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard.begin_session_sidecar_replacement(session_id);
        }

        let result = create_new_session_sidecar(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            manager_guard,
            runtime_override.as_deref(),
            runtime_source_override.as_deref(),
            &expected_runtime_identity,
            attempt,
            expected_recovery_epoch,
        );
        if let Ok(ensure_result) = &result {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                    .duration_ms(elapsed_ms(ensure_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&requested_runtime_for_trace))
                    .status("ok")
                    .detail("port", ensure_result.port)
                    .detail("is_new", ensure_result.is_new),
            );
        }
        return result;
    }

    // No existing sidecar found, create a new one with the original guard
    let result = create_new_session_sidecar(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        manager_guard,
        runtime_override.as_deref(),
        runtime_source_override.as_deref(),
        &expected_runtime_identity,
        attempt,
        expected_recovery_epoch,
    );
    if let Ok(ensure_result) = &result {
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                .duration_ms(elapsed_ms(ensure_started))
                .session_id(Some(session_id))
                .runtime(Some(&requested_runtime_for_trace))
                .status("ok")
                .detail("port", ensure_result.port)
                .detail("is_new", ensure_result.is_new),
        );
    }
    result
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
fn create_new_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'_, SidecarManager>,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
    resolved_identity: &RuntimeIdentity,
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    let boot_started = trace_start();

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), retrying ensure",
                session_id, existing.state, existing.port
            );
            drop(manager_guard);
            return ensure_session_sidecar_attempt(
                app_handle,
                manager,
                session_id,
                workspace_path,
                owner,
                runtime_override.map(str::to_string),
                runtime_source_override.map(str::to_string),
                attempt + 1,
                expected_recovery_epoch,
            );
        }
        // Exists but process dead — remove before creating fresh
        manager_guard.begin_session_sidecar_replacement(session_id);
    }

    // Need to start a new Sidecar
    // First, find executables
    let node_path =
        find_node_executable(app_handle).ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path =
        find_server_script(app_handle).ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id,
        port,
        owner
    );

    // Build command (see sibling SessionSidecar path for the tsx-loader rationale)
    let mut cmd = crate::process_cmd::new(&node_path);
    append_sidecar_entrypoint_args(&mut cmd, &script_path, port, SidecarProcessRole::Session);
    cmd.arg("--agent-dir").arg(workspace_path);

    // Pass session_id to Bun for real sessions (not pending-xxx)
    // so Bun uses the same UUID as Rust/SDK, enabling resume on crash recovery
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("MYAGENTS_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Reuse validation and process spawn consume the same identity snapshot for
    // this ensure attempt. In particular, missing Session metadata is not an
    // implicit builtin identity for a metadata creator.
    if let Some(runtime) = resolved_identity.runtime_for_env() {
        cmd.env("MYAGENTS_RUNTIME", runtime);
    }
    if let Some(runtime_source) = resolved_identity.runtime_source_for_env() {
        cmd.env("MYAGENTS_RUNTIME_SOURCE", runtime_source);
    }
    let sidecar_generation = manager_guard.next_generation(session_id);
    cmd.env("MYAGENTS_SIDECAR_ID", session_id);
    cmd.env(
        "MYAGENTS_SIDECAR_GENERATION",
        sidecar_generation.to_string(),
    );
    let runtime_for_trace = resolved_identity.runtime.clone();
    let runtime_source_for_trace = resolved_identity.runtime_source_label().to_string();

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Spawn
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_start")
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .detail("owner", format!("{:?}", owner)),
    );
    let mut child = crate::process_cmd::spawn_tree(&mut cmd).map_err(|e| {
        manager_guard.clear_generation(session_id);
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_failed")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("error", e.to_string()),
        );
        format!("Failed to spawn sidecar: {}", e)
    })?;
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawned")
            .duration_ms(elapsed_ms(boot_started))
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .status("ok")
            .detail("port", port),
    );

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                // Once Bun's unified logger is initialized, ALL console.log output is
                // written directly to the unified log file by Bun's logger interceptor.
                // Capturing stdout after this point causes 100% duplication ([BUN] + [bun-out]).
                // Only pre-logger startup lines need to go through bun-out.
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init: silently drop stdout (Bun logger handles it)
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info => {
                        ulog_info!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Warn => {
                        ulog_warn!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Error => {
                        ulog_error!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                }
            }
        });
    }

    // Check if the process already exited (non-blocking poll). No pre-sleep;
    // the health-loop's alive_check catches any crash this probe misses.
    if let Ok(Some(status)) = child.try_wait() {
        manager_guard.clear_generation(session_id);
        thread::sleep(Duration::from_millis(100));
        ulog_error!(
            "[sidecar] SessionSidecar exited immediately with status: {:?}",
            status
        );
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_immediate_exit")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("status", format!("{:?}", status)),
        );
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        management_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        completion_claims: HashSet::new(),
        dispatch_gate: DispatchGate::new(),
        created_at: std::time::Instant::now(),
        runtime: resolved_identity.runtime_for_env().map(str::to_string),
        runtime_source: resolved_identity
            .runtime_source_for_env()
            .map(str::to_string),
    };

    manager_guard.insert_sidecar_at_generation(session_id, sidecar_generation, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health (TCP up). Then wait for /health/ready (deferred init
    // complete) so renderer-driven session startup gates on actual readiness,
    // not just liveness. Other startup paths (cron / IM bot) keep the looser
    // liveness-only contract — they don't surface a "still warming up" UI.
    let health_started = trace_start();
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            // Pattern 4: tighten the renderer-driven session sidecar startup
            // to wait for /health/ready as well. 30s timeout matches existing
            // long-running migration / SDK init budgets.
            let readiness_started = trace_start();
            let readiness_alive =
                || sidecar_generation_is_alive(manager, session_id, sidecar_generation);
            if let Err(e) = wait_for_readiness(port, 30, Some(&readiness_alive)) {
                ulog_error!(
                    "[sidecar] Session {} /health/ready failed: {}",
                    session_id,
                    e
                );
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::SidecarBoot, "ready_failed")
                        .duration_ms(elapsed_ms(readiness_started))
                        .session_id(Some(session_id))
                        .runtime(Some(&runtime_for_trace))
                        .status("error")
                        .detail("port", port)
                        .detail("error", &e),
                );
                let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
                let port_matches = manager_guard
                    .sidecars
                    .get(session_id)
                    .map(|s| s.port == port)
                    .unwrap_or(false);
                if port_matches {
                    manager_guard.remove_sidecar(session_id);
                }
                return Err(e);
            }
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id,
                port
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ready_ok")
                    .duration_ms(elapsed_ms(boot_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
                generation: sidecar_generation,
            })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live_failed")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("error")
                    .detail("port", port)
                    .detail("error", &e),
            );
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard
                .sidecars
                .get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            if port_matches {
                // Check exit status and mark crashed bun for fallback
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_node(&status, &node_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id);
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
            }
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    let (removed, stopped) = manager_guard.remove_session_owner(session_id, owner);

    if removed {
        if stopped {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner,
                session_id
            );
        } else {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner,
                session_id
            );
        }
        Ok(stopped)
    } else {
        ulog_debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id,
            owner
        );
        Ok(false)
    }
}

/// Get the port for a Session's Sidecar
pub fn get_session_sidecar_port(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u16>, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.get_session_port(session_id))
}

/// Check whether a Session has a live Sidecar entry, including one still starting.
pub fn has_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.has_session_sidecar(session_id))
}

/// Get the current sidecar generation for a Session, if Rust still tracks one.
pub fn get_session_generation(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u64>, String> {
    let manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.generation_for(session_id))
}

// ============= Session-Centric Tauri Commands =============

fn is_canonical_session_id(session_id: &str) -> bool {
    let len = session_id.len();
    (1..=99).contains(&len)
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Ensure a Session has a Sidecar running, adding the specified owner
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
) -> Result<EnsureSidecarResult, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "companion" => SidecarOwner::Companion(ownerId),
        "task" => SidecarOwner::Task(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    let workspace_path = PathBuf::from(&workspacePath);
    // The async lifecycle entrypoint owns both the per-session deletion fence
    // and the blocking-thread handoff for the full cold boot/readiness wait.
    let manager = state.inner().clone();
    ensure_session_sidecar_with_lifecycle(app_handle, manager, sessionId, workspace_path, owner)
        .await
}

/// Release an owner from a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_release_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    ownerType: String,
    ownerId: String,
) -> Result<bool, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "companion" => SidecarOwner::Companion(ownerId),
        "background_completion" => SidecarOwner::BackgroundCompletion(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    release_session_sidecar(&state, &sessionId, &owner)
}

/// Get the ready port for a Session's Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_port(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u16>, String> {
    get_session_sidecar_port(&state, &sessionId)
}

/// Check whether a Session has a live Sidecar entry, including Starting.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_has_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    has_session_sidecar(&state, &sessionId)
}

/// Get the current sidecar generation for a Session, if any.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_generation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u64>, String> {
    get_session_generation(&state, &sessionId)
}

/// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
/// This updates HashMap keys without stopping the Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_upgrade_session_id(
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    newSessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let _lifecycle = acquire_session_lifecycle(&[&oldSessionId, &newSessionId]).await;
    {
        let manager = state.lock().map_err(|e| e.to_string())?;
        if manager.session_id_upgrade_is_already_applied_for_tab(
            &oldSessionId,
            &newSessionId,
            &tabId,
        ) {
            return Ok(true);
        }
    }
    if has_persisted_session_owner(&oldSessionId).await?
        || has_persisted_session_owner(&newSessionId).await?
    {
        return Ok(false);
    }
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    if manager.session_has_persistent_owners(&oldSessionId)
        || manager.session_has_persistent_owners(&newSessionId)
    {
        return Ok(false);
    }
    Ok(manager.upgrade_session_id_for_tab(&oldSessionId, &newSessionId, &tabId))
}

/// Check whether a session identity must remain stable after a Tab detaches.
/// Includes both live background owners and durable Task/Goal state whose
/// physical Sidecar owner may still be attaching or recovering.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_has_persistent_owners(
    state: tauri::State<'_, ManagedSidecarManager>,
    agent_state: tauri::State<'_, crate::im::ManagedAgents>,
    im_state: tauri::State<'_, crate::im::ManagedImBots>,
    sessionId: String,
) -> Result<bool, String> {
    let sidecars = state.inner().clone();
    let has_live_owner = {
        let manager = sidecars.lock().unwrap_or_else(|e| e.into_inner());
        manager.session_has_persistent_owners(&sessionId)
    };
    Ok(has_live_owner
        || has_non_tab_session_owner(&sessionId, agent_state.inner(), im_state.inner()).await?)
}

/// Delete a transcript while releasing only the exact mounted Tab owners named
/// by App. The per-Session lifecycle guard stays held across owner validation,
/// the local DELETE, and successful owner release, so every refusal preserves
/// both storage and the mounted owner set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteCommandResult {
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl SessionDeleteCommandResult {
    fn deleted() -> Self {
        Self {
            deleted: true,
            reason: None,
        }
    }

    fn refused(reason: &'static str) -> Self {
        Self {
            deleted: false,
            reason: Some(reason),
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_delete_session_if_unowned(
    state: tauri::State<'_, ManagedSidecarManager>,
    agent_state: tauri::State<'_, crate::im::ManagedAgents>,
    im_state: tauri::State<'_, crate::im::ManagedImBots>,
    sessionId: String,
    releasableTabIds: Vec<String>,
) -> Result<SessionDeleteCommandResult, String> {
    if !is_canonical_session_id(&sessionId) {
        return Ok(SessionDeleteCommandResult::refused("invalid-session-id"));
    }
    // Fast negative for the common active Task/Goal case. A fresh Session
    // creator may retain the lifecycle guard until metadata birth; waiting on
    // that guard before looking at the already-published durable/transient
    // owner would make a delete click hang for the entire AI turn. This is
    // only a UX shortcut: the same predicate is checked again under the guard
    // below, which remains the correctness boundary for false -> true races.
    if has_non_tab_session_owner(&sessionId, agent_state.inner(), im_state.inner()).await? {
        return Ok(SessionDeleteCommandResult::refused("in-use"));
    }
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    // Do not lock IM routers while holding the Session lifecycle fence: IM
    // message/runtime paths take router → lifecycle. Configured dormant
    // bindings are disk-only and safe to repeat here. Any live binding that
    // appears after the preflight first attaches an Agent owner under this same
    // fence, and `session_has_owners` below catches it.
    if has_persisted_session_owner(&sessionId).await?
        || crate::im::session_delivery::configured_session_binding_exists(&sessionId)
    {
        return Ok(SessionDeleteCommandResult::refused("in-use"));
    }
    let sidecars = state.inner().clone();
    let releasable_tab_ids = releasableTabIds.into_iter().collect::<HashSet<_>>();

    tauri::async_runtime::spawn_blocking(move || {
        let session_port = {
            let manager = sidecars.lock().map_err(|error| error.to_string())?;
            if manager.session_has_unreleasable_owners(&sessionId, &releasable_tab_ids) {
                return Ok(SessionDeleteCommandResult::refused("in-use"));
            }
            manager
                .get_session_sidecar(&sessionId)
                .filter(|sidecar| sidecar.is_reusable())
                .map(|sidecar| sidecar.port)
        };
        if let Some(port) = session_port {
            match super::background::check_sidecar_is_busy(port) {
                Some(false) => {}
                Some(true) => return Ok(SessionDeleteCommandResult::refused("in-use")),
                None => return Ok(SessionDeleteCommandResult::refused("activity-unavailable")),
            }
        }

        // The activity request intentionally runs without the manager lock.
        // Revalidate owners before the storage mutation while the outer
        // per-Session lifecycle fence still excludes new owner acquisition.
        let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
        if manager.session_has_unreleasable_owners(&sessionId, &releasable_tab_ids) {
            return Ok(SessionDeleteCommandResult::refused("in-use"));
        }
        let (port, delete_authority) = {
            let Some(instance) = manager.get_instance_mut(GLOBAL_SIDECAR_ID) else {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            };
            if !instance.is_running() {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            }
            let Some(delete_authority) = instance.session_delete_authority.clone() else {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            };
            (instance.port, delete_authority)
        };
        let client = crate::local_http::blocking_builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| format!("Failed to create local HTTP client: {error}"))?;
        let response = client
            .delete(format!("http://127.0.0.1:{port}/sessions/{sessionId}"))
            .header(SESSION_DELETE_AUTHORITY_HEADER, delete_authority)
            .send()
            .map_err(|error| format!("Failed to delete session: {error}"))?;
        let status = response.status();
        let result = if status.is_success() {
            SessionDeleteCommandResult::deleted()
        } else {
            let body = response
                .text()
                .unwrap_or_else(|_| "<unreadable response>".to_string());
            match status.as_u16() {
                403 => return Ok(SessionDeleteCommandResult::refused("protected-session")),
                404 => SessionDeleteCommandResult::refused("not-found"),
                409 => return Ok(SessionDeleteCommandResult::refused("in-use")),
                _ => {
                    return Err(format!(
                        "Global Sidecar failed to delete session (HTTP {status}): {body}"
                    ))
                }
            }
        };

        // Success and not-found are both terminal/idempotent outcomes. Release
        // only the App-authorized Tab owners after storage has reached that
        // terminal state; every refusal above leaves them untouched.
        for tab_id in &releasable_tab_ids {
            manager.release_tab_session(&sessionId, tab_id, false);
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("Session deletion task failed: {error:?}"))?
}

/// Release a Tab owner under the Session lifecycle guard. This prevents a
/// newly-created Goal/Agent owner from landing between the renderer-side
/// presence check and owner removal.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_release_tab_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    let has_persisted_owner = has_persisted_session_owner(&sessionId).await?;
    let mut manager = state.lock().map_err(|error| error.to_string())?;
    Ok(manager.release_tab_session(&sessionId, &tabId, has_persisted_owner))
}

#[cfg(test)]
mod session_lifecycle_tests {
    use super::{
        acquire_session_lifecycle, is_canonical_session_id, resolve_runtime_identity_for_owner,
        validate_sidecar_runtime_invariant, EnsureSidecarResult, RuntimeIdentity,
        SessionDeleteCommandResult, SidecarOwner,
    };
    use std::time::Duration;

    #[test]
    fn metadata_creator_uses_agent_runtime_for_external_reuse_and_spawn() {
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Task("task-a".to_string()),
            None,
            None,
            None,
            Some(RuntimeIdentity::new(
                Some("codex"),
                Some("managed-provider"),
            )),
        );

        assert_eq!(expected.runtime, "codex");
        assert_eq!(expected.runtime_source.as_deref(), Some("managed-provider"));
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            Some("codex"),
            Some("managed-provider"),
            "test-healthy-reuse",
        )
        .is_ok());
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            Some("codex"),
            Some("managed-provider"),
            "test-starting-reuse",
        )
        .is_ok());
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            None,
            None,
            "test-wrong-builtin-reuse",
        )
        .is_err());
    }

    #[test]
    fn metadata_creator_runtime_override_wins_before_metadata_birth() {
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Task("task-a".to_string()),
            Some("gemini"),
            Some("system-cli"),
            None,
            Some(RuntimeIdentity::new(
                Some("codex"),
                Some("managed-provider"),
            )),
        );

        assert_eq!(expected.runtime, "gemini");
        assert_eq!(expected.runtime_source.as_deref(), Some("system-cli"));
    }

    #[test]
    fn deletion_accepts_only_one_canonical_session_path_segment() {
        assert!(is_canonical_session_id(
            "11111111-2222-4333-8444-555555555555"
        ));
        assert!(is_canonical_session_id("pending-tab-123"));

        for invalid in [
            "",
            "owned?shadow",
            "owned#shadow",
            "owned/shadow",
            "owned\\shadow",
            "owned_shadow",
            "owned%2Fshadow",
        ] {
            assert!(!is_canonical_session_id(invalid), "accepted {invalid:?}");
        }
        assert!(!is_canonical_session_id(&"a".repeat(100)));
    }

    #[test]
    fn deletion_result_preserves_machine_readable_refusal_reasons() {
        assert_eq!(
            serde_json::to_value(SessionDeleteCommandResult::deleted()).unwrap(),
            serde_json::json!({ "deleted": true })
        );
        assert_eq!(
            serde_json::to_value(SessionDeleteCommandResult::refused("in-use")).unwrap(),
            serde_json::json!({ "deleted": false, "reason": "in-use" })
        );
    }

    #[test]
    fn ensure_result_process_generation_is_not_part_of_public_wire_shape() {
        assert_eq!(
            serde_json::to_value(EnsureSidecarResult {
                port: 32001,
                is_new: true,
                generation: 42,
            })
            .unwrap(),
            serde_json::json!({ "port": 32001, "isNew": true })
        );
    }

    #[tokio::test]
    async fn lifecycle_lock_serializes_one_session_without_blocking_another() {
        let suffix = uuid::Uuid::new_v4();
        let first_session = format!("lifecycle-first-{suffix}");
        let other_session = format!("lifecycle-other-{suffix}");
        let first_guard = acquire_session_lifecycle(&[&first_session]).await;

        let (same_tx, same_rx) = tokio::sync::oneshot::channel();
        let same_session = first_session.clone();
        let same_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&same_session]).await;
            let _ = same_tx.send(());
        });
        assert!(tokio::time::timeout(Duration::from_millis(50), same_rx)
            .await
            .is_err());

        let (other_tx, other_rx) = tokio::sync::oneshot::channel();
        let other_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&other_session]).await;
            let _ = other_tx.send(());
        });
        tokio::time::timeout(Duration::from_secs(1), other_rx)
            .await
            .expect("another session must not be blocked")
            .expect("other-session sender must stay alive");

        drop(first_guard);
        tokio::time::timeout(Duration::from_secs(1), same_task)
            .await
            .expect("same-session waiter must proceed after release")
            .expect("same-session task must complete");
        other_task.await.expect("other-session task must complete");
    }
}
