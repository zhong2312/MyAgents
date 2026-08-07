use super::manager::GlobalMonitorSnapshot;
use super::*;

// ============= Tab-based Multi-instance Commands =============

/// Resolve the Node process role from the canonical sidecar identity and
/// reject caller-shape mismatches before any spawn side effects occur.
///
/// `agent_dir.is_none()` alone is not a valid Global discriminator: the
/// generic Tab command is public IPC and may receive arbitrary Tab IDs.  If
/// such a call minted a Global role, its distinct manager key would bypass the
/// canonical Global singleton and start a second proactive OAuth scheduler.
fn resolve_sidecar_process_role(
    tab_id: &str,
    has_agent_dir: bool,
) -> Result<SidecarProcessRole, String> {
    match (tab_id == GLOBAL_SIDECAR_ID, has_agent_dir) {
        (true, false) => Ok(SidecarProcessRole::Global),
        (false, true) => Ok(SidecarProcessRole::Session),
        (true, true) => Err(format!(
            "Global Sidecar '{}' must not receive an agent directory",
            GLOBAL_SIDECAR_ID
        )),
        (false, false) => Err(format!(
            "Session Sidecar '{}' requires an agent directory",
            tab_id
        )),
    }
}

/// Start a Sidecar for a specific Tab
/// Each Tab gets its own dedicated Sidecar (1:1 relationship)
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    let process_role = resolve_sidecar_process_role(tab_id, agent_dir.is_some())?;
    let _lifecycle_spawn_permit = begin_lifecycle_spawn_permit()?;

    if process_role == SidecarProcessRole::Global {
        manager
            .lock()
            .map_err(|error| error.to_string())?
            .request_global_sidecar_running("start-request");
    }

    start_tab_sidecar_admitted(app_handle, manager, tab_id, agent_dir, process_role)
}

/// Spawn one candidate after lifecycle admission and role validation. Public
/// start requests establish standing Global demand before entering here;
/// monitor retries reuse this candidate path without re-establishing demand
/// after an explicit stop.
fn start_tab_sidecar_admitted<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
    process_role: SidecarProcessRole,
) -> Result<u16, String> {
    let is_global = process_role == SidecarProcessRole::Global;

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — spawning a new
    // sidecar before stale ones are killed would race on ports. In the
    // common case this returns immediately (cleanup finishes in ~50 ms).
    // 15 s is a generous upper bound; the new sysinfo-based cleanup is
    // bounded internally at ~3 s even with laggy processes.
    wait_for_startup_cleanup(Duration::from_secs(15))?;

    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if is_global && !manager_guard.global_sidecar_is_desired() {
        return Err("Global Sidecar start canceled because it is no longer desired".to_string());
    }

    // Check if already running for this tab
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            ulog_info!(
                "[sidecar] Tab {} already has running instance on port {}",
                tab_id,
                instance.port
            );
            return Ok(instance.port);
        }
    }

    // Remove stale instance if exists
    let removed_instance = manager_guard.remove_instance(tab_id);
    if is_global && removed_instance.is_some() {
        // The CLI port file is only a projection of the current healthy
        // generation. Once replacement retires that generation, the old port
        // must not remain discoverable during readiness/backoff.
        remove_global_port_file();
    }
    drop(removed_instance);

    // Find executables
    let node_path =
        find_node_executable(app_handle).ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path =
        find_server_script(app_handle).ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting for tab {} on port {}, agent_dir: {:?}",
        tab_id,
        port,
        agent_dir
    );

    // Build command — node directly executes server-dist.js (esbuild output).
    // In debug mode (.ts source) we inject tsx's ESM loader so TypeScript is
    // transpiled on the fly. Release builds load the pre-bundled .js and skip
    // the loader, keeping startup lean.
    // SIDECAR_MARKER tails every argv for reliable process identification.
    let mut cmd = crate::process_cmd::new(&node_path);
    // The role was validated against the canonical manager identity before
    // acquiring permits, locks, ports, or filesystem resources.
    append_sidecar_entrypoint_args(&mut cmd, &script_path, port, process_role);
    let session_delete_authority = configure_session_delete_authority(&mut cmd, process_role);
    if is_global {
        cmd.arg("--no-pre-warm");
    }
    let effective_agent_dir = if let Some(ref dir) = agent_dir {
        cmd.arg("--agent-dir").arg(dir);
        Some(dir.clone())
    } else {
        // Global sidecar: use temp directory
        let temp_dir = std::env::temp_dir().join(format!("myagents-global-{}", std::process::id()));
        ulog_info!("[sidecar] Creating temp agent directory: {:?}", temp_dir);

        // Create directory and fail early if unable to create
        std::fs::create_dir_all(&temp_dir).map_err(|e| {
            let err = format!(
                "[sidecar] Failed to create temp directory {:?}: {}. \
                 Check permissions on TEMP directory ({}). \
                 This directory is required for Global Sidecar to store runtime data.",
                temp_dir,
                e,
                std::env::temp_dir().display()
            );
            ulog_error!("{}", err);
            err
        })?;

        cmd.arg("--agent-dir").arg(&temp_dir);
        Some(temp_dir)
    };

    // Set working directory to script's parent directory
    // This is crucial for bun to find relative imports
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
        ulog_info!("[sidecar] Working directory set to: {:?}", script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("MYAGENTS_MANAGEMENT_PORT", mgmt_port.to_string());
    }
    // Global and legacy instance Sidecars consume the same Management API as
    // Session Sidecars. Reserve a process-global generation before spawn and
    // inject the manager key instead of fabricating a Session identity.
    let sidecar_generation = manager_guard.next_generation(tab_id);
    if is_global {
        ulog_info!(
            "[sidecar-global] action=candidate-reserved generation={} port={}",
            sidecar_generation,
            port
        );
    }
    cmd.env("MYAGENTS_SIDECAR_ID", tab_id);
    cmd.env(
        "MYAGENTS_SIDECAR_GENERATION",
        sidecar_generation.to_string(),
    );

    // Inject runtime type for Agent Runtime selection (v0.1.59)
    // This path is used by start_sidecar (generic, IM/Agent channels).
    // Session sidecars created via ensure_session_sidecar use resolve_session_runtime()
    // for authoritative per-session runtime. This fallback uses agent config for cases
    // without a session_id (global sidecar, IM initial start).
    if !is_global {
        if let Some(ref dir) = agent_dir {
            if let Some(runtime) = resolve_agent_runtime_from_config(dir) {
                cmd.env("MYAGENTS_RUNTIME", &runtime);
            }
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // 关键诊断日志：打印当前可执行文件路径，确认运行的是正确版本
    ulog_info!("[sidecar] current_exe = {:?}", std::env::current_exe().ok());

    ulog_info!(
        "[sidecar] Spawning: bun={:?}, script={:?}, port={}, is_global={}",
        node_path,
        script_path,
        port,
        is_global
    );

    // Spawn
    let mut child = crate::process_cmd::spawn_tree(&mut cmd).map_err(|e| {
        manager_guard.clear_generation(tab_id);
        ulog_error!("[sidecar] Failed to spawn: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    ulog_info!("[sidecar] Process spawned with pid: {:?}", child.id());

    // 启动线程捕获 stdout → 写入统一日志（确保 Bun 输出在 unified log 可见）
    if let Some(stdout) = child.stdout.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][{}] {}", tab_id_clone, line);
                }
            }
        });
    }

    // 启动线程捕获 stderr → 写入统一日志。
    //
    // 不是所有 sidecar stderr 都是 ERROR：Node.js 的 `console.warn` /
    // 直接 `process.stderr.write` 在 sidecar 里有几处合法的 informational
    // 用法，盲目标 ERROR 会让 unified log 出现假阳性（grep ERROR 拿到无关
    // 噪音）。识别已知 informational/warn 前缀，按真实严重度落级。
    if let Some(stderr) = child.stderr.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info => ulog_info!("[bun-err][{}] {}", tab_id_clone, line),
                    SidecarStderrLevel::Warn => ulog_warn!("[bun-err][{}] {}", tab_id_clone, line),
                    SidecarStderrLevel::Error => {
                        ulog_error!("[bun-err][{}] {}", tab_id_clone, line)
                    }
                }
            }
        });
    }

    // Check if the process already exited. `try_wait()` is a non-blocking
    // poll — if the OS hasn't reaped the child yet, returns Ok(None). We no
    // longer pre-sleep 50ms here; the health-loop's alive_check (every 20
    // attempts) catches any crash that escapes this initial probe.
    if let Ok(Some(status)) = child.try_wait() {
        // Crash detected — give the stderr reader a brief window to flush.
        thread::sleep(Duration::from_millis(100));
        ulog_error!(
            "[sidecar] Process exited immediately with status: {:?}",
            status
        );
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        manager_guard.clear_generation(tab_id);
        return Err(diag);
    }

    // Create instance (not yet healthy)
    let instance = SidecarInstance {
        process: child,
        port,
        agent_dir: effective_agent_dir,
        healthy: false,
        is_global,
        session_delete_authority,
        dispatch_gate: DispatchGate::new(),
        created_at: std::time::Instant::now(),
    };

    manager_guard.insert_instance(tab_id.to_string(), instance);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure — detects process death during health check.
    // Critical for Windows VMs where Defender delays bun.exe execution by 20-30s,
    // causing the crash to happen well after the 50ms early exit check above.
    //
    // Also detects instance replacement: if the health monitor restarts the sidecar
    // while we're waiting, the old port is dead and a new instance sits at a different
    // port under the same tab_id. Checking `instance.port == expected_port` prevents
    // this closure from silently accepting the replacement and looping forever on a
    // dead port.
    let liveness_manager = manager.clone();
    let liveness_tab_id = tab_id.to_string();
    let expected_port = port;
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(instance) = guard.get_instance_mut(&liveness_tab_id) {
                // Reject if the instance was replaced (different port = different process)
                if instance.port != expected_port {
                    return false;
                }
                matches!(instance.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if is_global {
                let candidate_is_current = manager_guard.current_generation(tab_id)
                    == sidecar_generation
                    && manager_guard
                        .get_instance(tab_id)
                        .is_some_and(|instance| instance.port == port);
                if !manager_guard.global_sidecar_is_desired() || !candidate_is_current {
                    if candidate_is_current {
                        manager_guard.remove_instance(tab_id);
                        remove_global_port_file();
                    }
                    return Err(
                        "Global Sidecar candidate is no longer current or desired".to_string()
                    );
                }
            }
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                instance.healthy = true;
            }
            if is_global {
                ulog_info!(
                    "[sidecar-global] action=candidate-ready generation={} port={}",
                    sidecar_generation,
                    port
                );
            }
            Ok(port)
        }
        Err(e) => {
            // Health check failed — diagnostics go to unified log directly
            ulog_error!("[sidecar] Health check failed: {}", e);
            let mut diag = e.clone();

            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            let candidate_is_current = manager_guard.get_instance(tab_id).is_some_and(|instance| {
                !is_global
                    || (manager_guard.current_generation(tab_id) == sidecar_generation
                        && instance.port == port)
            });
            if candidate_is_current {
                let instance = manager_guard
                    .get_instance_mut(tab_id)
                    .expect("current candidate remains present while manager is locked");
                match instance.process.try_wait() {
                    Ok(Some(status)) => {
                        #[cfg(target_os = "windows")]
                        maybe_mark_crashed_node(&status, &node_path);
                        let detail = format!(" | process exited: {:?}", status);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                    Ok(None) => {
                        let detail = " | process alive but not listening. \
                            Possible causes: antivirus slow-scanning bun.exe, or port conflict";
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(detail);
                    }
                    Err(wait_err) => {
                        let detail = format!(" | try_wait error: {}", wait_err);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                }

                // Note: stderr is already captured by the drain thread → ulog_error!
                // No need to .take() here (it was already taken at spawn time)
            }

            // Remove only the exact failed Global generation. A concurrent
            // legal start may already have installed a newer winner.
            if candidate_is_current {
                manager_guard.remove_instance(tab_id);
                if is_global {
                    remove_global_port_file();
                    ulog_error!(
                        "[sidecar-global] action=candidate-readiness-failed generation={} port={} error={}",
                        sidecar_generation,
                        port,
                        diag
                    );
                }
            }

            Err(diag)
        }
    }
}

/// Stop a Sidecar for a specific Tab
/// Each Tab has its own Sidecar, so stopping is straightforward
pub fn stop_tab_sidecar(manager: &ManagedSidecarManager, tab_id: &str) -> Result<(), String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if tab_id == GLOBAL_SIDECAR_ID {
        manager_guard.request_global_sidecar_stopped("explicit-tab-stop");
    }

    if let Some(instance) = manager_guard.remove_instance(tab_id) {
        ulog_info!(
            "[sidecar] Stopped instance for tab {} on port {}",
            tab_id,
            instance.port
        );
        // Instance is dropped here, killing the process
    } else {
        ulog_debug!("[sidecar] No instance found for tab {}", tab_id);
    }

    if tab_id == GLOBAL_SIDECAR_ID {
        remove_global_port_file();
    }

    Ok(())
}

/// Get the server URL for a specific Tab
/// Direct legacy instances remain addressable, while Session-centric lookup is
/// resolved from the authoritative Tab owner token.
pub fn get_tab_server_url(manager: &ManagedSidecarManager, tab_id: &str) -> Result<String, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            return Ok(format!("http://127.0.0.1:{}", instance.port));
        }
    }

    manager_guard
        .resolve_session_sidecar_for_frontend_owner("", &SidecarOwner::Tab(tab_id.to_string()))
        .map(|binding| binding.base_url())
}

/// Get status for a Tab's sidecar
/// This function checks multiple sources (same as get_tab_server_url)
pub fn get_tab_sidecar_status(
    manager: &ManagedSidecarManager,
    tab_id: &str,
) -> Result<SidecarStatus, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        return Ok(SidecarStatus {
            running: instance.is_running(),
            port: instance.port,
            agent_dir: instance
                .agent_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }

    let tab_owner = SidecarOwner::Tab(tab_id.to_string());
    let mut matching_sessions = manager_guard
        .sidecars
        .iter()
        .filter_map(|(session_id, sidecar)| {
            sidecar
                .owners
                .contains(&tab_owner)
                .then_some(session_id.clone())
        })
        .collect::<Vec<_>>();
    if matching_sessions.len() == 1 {
        let session_id = matching_sessions.pop().expect("one matching Session");
        let sidecar = manager_guard
            .sidecars
            .get_mut(&session_id)
            .expect("matching Session remains present while manager is locked");
        return Ok(SidecarStatus {
            running: sidecar.is_ready_for_requests(),
            port: sidecar.port,
            agent_dir: sidecar.workspace_path.to_string_lossy().into_owned(),
        });
    }

    // No sidecar found
    Ok(SidecarStatus {
        running: false,
        port: 0,
        agent_dir: String::new(),
    })
}

/// Start the global sidecar (for Settings page)
pub fn start_global_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<u16, String> {
    let port = start_tab_sidecar(app_handle, manager, GLOBAL_SIDECAR_ID, None)?;
    publish_global_port_if_current(manager, port)?;
    Ok(port)
}

/// Publish CLI discovery only while the same healthy candidate is still the
/// manager-owned current Global. Holding the manager lock across validation
/// and write orders this projection against an explicit stop.
fn publish_global_port_if_current(
    manager: &ManagedSidecarManager,
    port: u16,
) -> Result<(), String> {
    let mut guard = manager.lock().map_err(|error| error.to_string())?;
    if !guard.global_sidecar_is_desired() || guard.current_generation(GLOBAL_SIDECAR_ID) == 0 {
        return Err("Global Sidecar stopped before publishing its CLI port".to_string());
    }
    let instance = guard
        .get_instance_mut(GLOBAL_SIDECAR_ID)
        .ok_or_else(|| "Global Sidecar candidate disappeared before CLI publish".to_string())?;
    if instance.port != port || !instance.is_running() {
        return Err(
            "Global Sidecar candidate is not current and healthy for CLI publish".to_string(),
        );
    }
    write_global_port_file(port);
    Ok(())
}

/// Retry the canonical Global candidate only while manager-owned standing
/// demand still exists. Unlike a user start request, this must never recreate
/// demand after an explicit stop raced with the monitor.
fn restart_global_sidecar_if_desired<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<Option<u16>, String> {
    let _lifecycle_spawn_permit = begin_lifecycle_spawn_permit()?;
    {
        let guard = manager.lock().map_err(|error| error.to_string())?;
        if !guard.global_sidecar_is_desired() {
            return Ok(None);
        }
    }

    let port = start_tab_sidecar_admitted(
        app_handle,
        manager,
        GLOBAL_SIDECAR_ID,
        None,
        SidecarProcessRole::Global,
    )?;
    publish_global_port_if_current(manager, port)?;
    Ok(Some(port))
}

/// Atomically snapshot Global standing demand and its current candidate.
fn check_global_sidecar_status(
    manager: &ManagedSidecarManager,
) -> Result<GlobalMonitorSnapshot, String> {
    let mut guard = manager.lock().map_err(|error| error.to_string())?;
    Ok(guard.global_monitor_snapshot())
}

/// How often to poll session-state for the turn wake-lock. Idle sleep triggers
/// after minutes of no user input, so a 10s poll asserts the lock long before
/// the OS can sleep and drop the SDK's HTTPS stream.
const WAKE_LOCK_POLL_INTERVAL_SECS: u64 = 10;

/// Holds a single process-wide system wake-lock (prevents idle sleep) while ANY
/// managed sidecar has an in-flight AI turn (session-state `running`/`starting`).
///
/// WHY: the SDK keeps a long-lived HTTPS stream to the model API; if the host
/// idle-sleeps mid-turn that socket dies and the SDK never notices, so the turn
/// stalls (and historically the 10-min watchdog then killed it). Cron already
/// held a wake-lock per execution (`cron_task.rs`); interactive turns did not —
/// so "walk away during a long task" let the Mac sleep and lose the turn. This
/// generalizes the protection to every turn type by reading the same
/// `/api/session-state` the background-completion poller already uses.
///
/// One assertion is enough system-wide, so we hold/release a single RAII
/// `WakeLock` based on whether any sidecar is currently active. This complements
/// the suspension-aware inactivity watchdog: the wake-lock *prevents* idle sleep
/// during active turns; the watchdog handles the sleep we cannot prevent
/// (lid close / forced sleep) by not counting suspended time as inactivity.
pub async fn monitor_turn_wake_lock(
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    // RAII: dropping this releases the OS assertion (also on loop break / task drop).
    let mut wake_lock: Option<crate::wake_lock::WakeLock> = None;

    loop {
        tokio::time::sleep(Duration::from_secs(WAKE_LOCK_POLL_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break; // wake_lock drops here → assertion released
        }

        // Snapshot live sidecar ports under the lock; never hold the mutex
        // across the (blocking) HTTP poll below.
        let ports: Vec<u16> = match manager.lock() {
            Ok(guard) => guard
                .sidecars
                .values()
                .filter(|sc| sc.is_reusable())
                .map(|sc| sc.port)
                .collect(),
            // A poisoned lock is permanent — if we kept `continue`-ing we'd hold
            // the wake-lock (block idle sleep) forever. Release it and retry.
            Err(_) => {
                wake_lock = None;
                continue;
            }
        };

        // Poll session-state off the async runtime (check_sidecar_session_state
        // is blocking). A dead/unreachable sidecar returns None → not active.
        let any_active = tokio::task::spawn_blocking(move || {
            ports.iter().any(|&port| {
                matches!(
                    check_sidecar_session_state(port).as_deref(),
                    Some("running") | Some("starting")
                )
            })
        })
        .await
        .unwrap_or(false);

        match (any_active, wake_lock.is_some()) {
            (true, false) => {
                wake_lock = crate::wake_lock::WakeLock::acquire("active AI turn")
                    .map_err(|e| {
                        ulog_warn!("[wake-lock] turn wake-lock acquire failed: {} — continuing without protection", e);
                        e
                    })
                    .ok();
                if wake_lock.is_some() {
                    ulog_debug!("[wake-lock] acquired — an AI turn is active");
                }
            }
            (false, true) => {
                wake_lock = None; // drop releases the OS assertion
                ulog_debug!("[wake-lock] released — no active AI turns");
            }
            _ => {}
        }
    }
}

/// How many CONSECUTIVE HTTP-health failures the global sidecar must rack up
/// (process still alive each time) before the monitor concludes it's truly
/// stuck and replaces it. #236: a single 2s health-check miss is not enough —
/// on Windows under Defender scanning / a momentary load spike / a brief OS
/// suspend the global sidecar's event loop can stall past the 2s budget while
/// being perfectly alive. Restarting on that single blip kills a healthy
/// global (the reporter saw it killed 6× in 76 minutes) and takes every
/// renderer consumer down with it. Requiring 2 consecutive failures (≈15s
/// apart) tolerates the transient stall while still recovering a genuinely
/// hung process within ~30s. A DEAD process is restarted immediately —
/// liveness is unambiguous, only HTTP-readiness is blip-prone.
const GLOBAL_HEALTH_FAIL_THRESHOLD: u32 = 2;
const GLOBAL_MAX_RESTART_FAILURES: u32 = 5;
const GLOBAL_CHECK_INTERVAL_SECS: u64 = 15;
const GLOBAL_MAX_BACKOFF_SECS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalRestartSource {
    DesiredMissing,
    PresentDead {
        port: u16,
        created_at: std::time::Instant,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum GlobalMonitorCycle<T> {
    Idle,
    RestartAttempted {
        source: GlobalRestartSource,
        result: T,
    },
    InspectPresent {
        port: u16,
        created_at: std::time::Instant,
    },
}

/// One executable monitor-cycle seam. A missing desired candidate and an
/// unambiguously dead present candidate both invoke the injected restart path;
/// stopped state never does. Production injects the real spawn path, while
/// tests inject deterministic `Err -> Ok` outcomes without a fault API.
async fn run_global_monitor_cycle<T, Restart, RestartFuture>(
    snapshot: GlobalMonitorSnapshot,
    restart: Restart,
) -> GlobalMonitorCycle<T>
where
    Restart: FnOnce(GlobalRestartSource) -> RestartFuture,
    RestartFuture: std::future::Future<Output = T>,
{
    match snapshot {
        GlobalMonitorSnapshot::Stopped => GlobalMonitorCycle::Idle,
        GlobalMonitorSnapshot::DesiredMissing => GlobalMonitorCycle::RestartAttempted {
            source: GlobalRestartSource::DesiredMissing,
            result: restart(GlobalRestartSource::DesiredMissing).await,
        },
        GlobalMonitorSnapshot::Present {
            port,
            process_alive: false,
            created_at,
        } => {
            let source = GlobalRestartSource::PresentDead { port, created_at };
            GlobalMonitorCycle::RestartAttempted {
                source,
                result: restart(source).await,
            }
        }
        GlobalMonitorSnapshot::Present {
            port,
            process_alive: true,
            created_at,
        } => GlobalMonitorCycle::InspectPresent { port, created_at },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalRestartAttemptStatus {
    Succeeded,
    Failed,
    Stopped,
}

#[derive(Debug, PartialEq, Eq)]
enum GlobalRestartAttemptResult {
    Succeeded(u16),
    Failed(String),
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GlobalRestartTransition {
    restart_failures: u32,
    health_failures: u32,
    emit_restarted: bool,
}

/// Pure settlement for one monitor-owned restart attempt. The monitor keeps
/// retry scheduling local, while standing demand remains manager-owned.
fn global_restart_attempt_transition(
    status: GlobalRestartAttemptStatus,
    restart_failures: u32,
    health_failures: u32,
) -> GlobalRestartTransition {
    match status {
        GlobalRestartAttemptStatus::Succeeded => GlobalRestartTransition {
            restart_failures: 0,
            health_failures: 0,
            emit_restarted: true,
        },
        GlobalRestartAttemptStatus::Failed => GlobalRestartTransition {
            restart_failures: restart_failures.saturating_add(1),
            health_failures,
            emit_restarted: false,
        },
        GlobalRestartAttemptStatus::Stopped => GlobalRestartTransition {
            restart_failures: 0,
            health_failures: 0,
            emit_restarted: false,
        },
    }
}

async fn run_global_sidecar_restart(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
) -> GlobalRestartAttemptResult {
    let app_clone = app_handle.clone();
    let mgr_clone = manager.clone();
    match tokio::task::spawn_blocking(move || {
        restart_global_sidecar_if_desired(&app_clone, &mgr_clone)
    })
    .await
    {
        Ok(Ok(Some(port))) => GlobalRestartAttemptResult::Succeeded(port),
        Ok(Ok(None)) => GlobalRestartAttemptResult::Stopped,
        Ok(Err(error)) => GlobalRestartAttemptResult::Failed(error),
        Err(error) => GlobalRestartAttemptResult::Failed(format!(
            "spawn_blocking failed during global sidecar restart: {}",
            error
        )),
    }
}

fn settle_global_sidecar_restart(
    app_handle: &AppHandle,
    result: GlobalRestartAttemptResult,
    consecutive_restart_failures: &mut u32,
    consecutive_health_failures: &mut u32,
) {
    use crate::logger;

    let status = match &result {
        GlobalRestartAttemptResult::Succeeded(_) => GlobalRestartAttemptStatus::Succeeded,
        GlobalRestartAttemptResult::Failed(_) => GlobalRestartAttemptStatus::Failed,
        GlobalRestartAttemptResult::Stopped => GlobalRestartAttemptStatus::Stopped,
    };

    let transition = global_restart_attempt_transition(
        status,
        *consecutive_restart_failures,
        *consecutive_health_failures,
    );
    *consecutive_restart_failures = transition.restart_failures;
    *consecutive_health_failures = transition.health_failures;

    match result {
        GlobalRestartAttemptResult::Succeeded(new_port) => {
            let new_url = format!("http://127.0.0.1:{}", new_port);
            logger::info(
                app_handle,
                format!(
                    "[sidecar] Global sidecar auto-restarted on port {} ({})",
                    new_port, new_url
                ),
            );
            if transition.emit_restarted {
                let _ = app_handle.emit("global-sidecar:restarted", &new_url);
            }
        }
        GlobalRestartAttemptResult::Failed(error) => {
            let next_retry_secs = global_restart_backoff_secs(*consecutive_restart_failures);
            if *consecutive_restart_failures >= GLOBAL_MAX_RESTART_FAILURES {
                ulog_error!(
                    "[sidecar] Failed to auto-restart global sidecar ({} consecutive failures, next_retry_secs={}): {}",
                    consecutive_restart_failures,
                    next_retry_secs,
                    error
                );
            } else {
                ulog_error!(
                    "[sidecar] Failed to auto-restart global sidecar (attempt {}, next_retry_secs={}): {}",
                    consecutive_restart_failures,
                    next_retry_secs,
                    error
                );
            }
        }
        GlobalRestartAttemptResult::Stopped => {
            ulog_info!("[sidecar-global] action=restart-canceled reason=explicit-stop");
        }
    }
}

fn global_restart_backoff_secs(restart_failures: u32) -> u64 {
    std::cmp::min(
        GLOBAL_CHECK_INTERVAL_SECS.saturating_mul(2u64.saturating_pow(restart_failures)),
        GLOBAL_MAX_BACKOFF_SECS,
    )
}

/// Pure restart decision for the global sidecar health monitor. Extracted so
/// the "don't kill on a single transient blip" rule (#236) is unit-testable
/// without standing up a real sidecar. Returns
/// `(needs_restart, next_consecutive_health_failures)`.
fn global_restart_decision(
    process_alive: bool,
    http_healthy: bool,
    prev_health_failures: u32,
    threshold: u32,
) -> (bool, u32) {
    if !process_alive {
        // Dead is unambiguous — restart now, reset the (HTTP-only) streak.
        return (true, 0);
    }
    if http_healthy {
        return (false, 0);
    }
    let failures = prev_health_failures.saturating_add(1);
    (failures >= threshold, failures)
}

/// Background health monitor for the Global Sidecar.
/// Periodically checks if the Global Sidecar is alive and auto-restarts it when it dies.
/// Emits `global-sidecar:restarted` Tauri event with the new URL on successful restart.
pub async fn monitor_global_sidecar(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use crate::logger;
    use std::sync::atomic::Ordering::Relaxed;

    let mut consecutive_restart_failures: u32 = 0;
    // #236: consecutive HTTP-health misses while the process is still alive.
    // Reset on a healthy probe or a dead process; a restart only fires once it
    // reaches GLOBAL_HEALTH_FAIL_THRESHOLD.
    let mut consecutive_health_failures: u32 = 0;
    let mut is_first_check = true;

    logger::info(
        &app_handle,
        "[sidecar] Global sidecar health monitor started".to_string(),
    );

    loop {
        // First iteration: short delay (let Global Sidecar start up)
        // Subsequent iterations: normal interval or backoff on restart failures
        if is_first_check {
            is_first_check = false;
            tokio::time::sleep(Duration::from_secs(GLOBAL_CHECK_INTERVAL_SECS)).await;
        } else if consecutive_restart_failures > 0 {
            // Exponential backoff: 30s, 60s, 120s, 240s, 300s, 300s, ...
            let backoff = global_restart_backoff_secs(consecutive_restart_failures);
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        } else {
            tokio::time::sleep(Duration::from_secs(GLOBAL_CHECK_INTERVAL_SECS)).await;
        }

        if shutdown.load(Relaxed) {
            logger::info(
                &app_handle,
                "[sidecar] Global sidecar monitor stopping (app shutdown)".to_string(),
            );
            break;
        }

        if is_update_shutdown_in_progress() {
            consecutive_health_failures = 0;
            consecutive_restart_failures = 0;
            continue;
        }

        // Read standing demand and current process state under one manager
        // lock. A desired-but-missing Global is pending recovery work.
        let snapshot = match check_global_sidecar_status(&manager) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                ulog_error!("[sidecar-global] action=snapshot-error error={}", error);
                continue;
            }
        };
        let restart_attempt = consecutive_restart_failures.saturating_add(1);
        let cycle = run_global_monitor_cycle(snapshot, |source| {
            let app_handle = &app_handle;
            let manager = &manager;
            async move {
                match source {
                    GlobalRestartSource::DesiredMissing => ulog_warn!(
                        "[sidecar-global] action=restart source=desired-missing attempt={}",
                        restart_attempt
                    ),
                    GlobalRestartSource::PresentDead { port, created_at } => ulog_warn!(
                        "[sidecar-global] action=restart source=present-dead port={} age={:?} attempt={}",
                        port,
                        created_at.elapsed(),
                        restart_attempt
                    ),
                }
                run_global_sidecar_restart(app_handle, manager).await
            }
        })
        .await;

        let (port, created_at) = match cycle {
            GlobalMonitorCycle::Idle => {
                consecutive_health_failures = 0;
                consecutive_restart_failures = 0;
                continue;
            }
            GlobalMonitorCycle::RestartAttempted { result, .. } => {
                consecutive_health_failures = 0;
                settle_global_sidecar_restart(
                    &app_handle,
                    result,
                    &mut consecutive_restart_failures,
                    &mut consecutive_health_failures,
                );
                continue;
            }
            GlobalMonitorCycle::InspectPresent { port, created_at } => (port, created_at),
        };

        // Startup grace period: skip health checks for recently-created instances.
        // During startup the sidecar may be busy with TCP check, Bun init, Plugin Bridge
        // loading, etc. — an aggressive health check during this window false-fires and
        // triggers an unnecessary restart that cascades into frontend timeout (#58).
        let age = created_at.elapsed();
        if age < Duration::from_secs(STARTUP_GRACE_SECS) {
            // Dead candidates were restarted by `run_global_monitor_cycle`.
            // A live candidate in grace has not earned any failures yet.
            consecutive_health_failures = 0;
            continue;
        }

        // The cycle already handled a dead process; verify the live candidate
        // with the existing blocking HTTP probe.
        let http_healthy = tokio::task::spawn_blocking(move || check_sidecar_http_health(port))
            .await
            .unwrap_or(false);

        // #236: don't restart a still-alive global on a single transient HTTP
        // blip — require GLOBAL_HEALTH_FAIL_THRESHOLD consecutive misses.
        let (needs_restart, next_failures) = global_restart_decision(
            true,
            http_healthy,
            consecutive_health_failures,
            GLOBAL_HEALTH_FAIL_THRESHOLD,
        );
        consecutive_health_failures = next_failures;

        if !http_healthy && !needs_restart {
            ulog_warn!(
                "[sidecar] Global sidecar on port {} HTTP health check failed ({}/{}) — alive, deferring restart (transient blip guard)",
                port, consecutive_health_failures, GLOBAL_HEALTH_FAIL_THRESHOLD
            );
        }

        if !needs_restart || shutdown.load(Relaxed) {
            // Healthy (or under the blip threshold) — reset restart-failure counter.
            consecutive_restart_failures = 0;
            continue;
        }

        ulog_warn!(
            "[sidecar] Global sidecar on port {} is unhealthy (alive={}, health_failures={}), auto-restarting...",
            port, true, consecutive_health_failures
        );

        // Mark the existing instance as unhealthy so start_global_sidecar() won't
        // short-circuit with "already running". Without this, a hung process (alive
        // but not responding to HTTP) would never be replaced — is_running() checks
        // the healthy flag first, and start_tab_sidecar returns the old port.
        {
            if let Ok(mut guard) = manager.lock() {
                if let Some(instance) = guard.get_instance_mut(GLOBAL_SIDECAR_ID) {
                    if instance.port == port {
                        instance.healthy = false;
                    }
                }
            }
        }

        ulog_warn!(
            "[sidecar-global] action=restart source=present-unhealthy attempt={}",
            consecutive_restart_failures.saturating_add(1)
        );
        let result = run_global_sidecar_restart(&app_handle, &manager).await;
        settle_global_sidecar_restart(
            &app_handle,
            result,
            &mut consecutive_restart_failures,
            &mut consecutive_health_failures,
        );
    }
}

#[cfg(test)]
mod global_restart_decision_tests {
    use super::{
        global_restart_attempt_transition, global_restart_backoff_secs, global_restart_decision,
        run_global_monitor_cycle, GlobalMonitorCycle, GlobalRestartAttemptResult,
        GlobalRestartAttemptStatus, GlobalRestartSource,
    };
    use crate::sidecar::manager::GlobalMonitorSnapshot;
    use crate::sidecar::SidecarManager;

    const T: u32 = 2; // GLOBAL_HEALTH_FAIL_THRESHOLD in tests

    #[test]
    fn dead_process_restarts_immediately_and_resets_streak() {
        // Even with a prior streak, a dead process restarts now.
        assert_eq!(global_restart_decision(false, false, 1, T), (true, 0));
        assert_eq!(global_restart_decision(false, true, 0, T), (true, 0));
    }

    #[test]
    fn healthy_process_never_restarts_and_resets_streak() {
        assert_eq!(global_restart_decision(true, true, 1, T), (false, 0));
    }

    #[test]
    fn single_transient_blip_does_not_restart_a_live_sidecar() {
        // #236 core: alive + first HTTP miss → defer, just record the failure.
        assert_eq!(global_restart_decision(true, false, 0, T), (false, 1));
    }

    #[test]
    fn restarts_after_threshold_consecutive_blips() {
        // Second consecutive miss reaches the threshold → restart.
        assert_eq!(global_restart_decision(true, false, 1, T), (true, 2));
    }

    #[test]
    fn a_healthy_probe_between_blips_breaks_the_streak() {
        let (_, after_first) = global_restart_decision(true, false, 0, T);
        assert_eq!(after_first, 1);
        let (restart, after_recover) = global_restart_decision(true, true, after_first, T);
        assert_eq!((restart, after_recover), (false, 0));
        // Next blip starts the count over, so one more blip alone won't restart.
        assert_eq!(
            global_restart_decision(true, false, after_recover, T),
            (false, 1)
        );
    }

    #[tokio::test]
    async fn failed_candidate_dispatches_a_real_second_cycle_and_success_settles_once() {
        use std::cell::Cell;

        let mut manager = SidecarManager::new();
        manager.request_global_sidecar_running("test-start");

        let attempts = Cell::new(0_u32);
        let first_attempts = &attempts;
        let mut restarted_events = 0;
        let first_cycle = run_global_monitor_cycle(
            GlobalMonitorSnapshot::Present {
                port: 31419,
                process_alive: false,
                created_at: std::time::Instant::now(),
            },
            move |source| async move {
                first_attempts.set(first_attempts.get() + 1);
                assert!(matches!(source, GlobalRestartSource::PresentDead { .. }));
                GlobalRestartAttemptResult::Failed("candidate #1 readiness failed".to_string())
            },
        )
        .await;
        let first_result = match first_cycle {
            GlobalMonitorCycle::RestartAttempted { result, .. } => result,
            other => panic!("dead candidate must dispatch restart, got {other:?}"),
        };
        let first = global_restart_attempt_transition(
            match first_result {
                GlobalRestartAttemptResult::Failed(_) => GlobalRestartAttemptStatus::Failed,
                other => panic!("first attempt must fail, got {other:?}"),
            },
            0,
            T,
        );
        assert_eq!(first.restart_failures, 1);
        assert_eq!(first.health_failures, T);
        assert!(!first.emit_restarted);
        assert_eq!(global_restart_backoff_secs(first.restart_failures), 30);

        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::DesiredMissing
        ));
        let second_attempts = &attempts;
        let second_cycle = run_global_monitor_cycle(
            manager.global_monitor_snapshot(),
            move |source| async move {
                second_attempts.set(second_attempts.get() + 1);
                assert_eq!(source, GlobalRestartSource::DesiredMissing);
                GlobalRestartAttemptResult::Succeeded(31420)
            },
        )
        .await;
        let second_result = match second_cycle {
            GlobalMonitorCycle::RestartAttempted { result, .. } => result,
            other => panic!("desired-missing must dispatch restart, got {other:?}"),
        };
        let second = global_restart_attempt_transition(
            match second_result {
                GlobalRestartAttemptResult::Succeeded(31420) => {
                    GlobalRestartAttemptStatus::Succeeded
                }
                other => panic!("second attempt must succeed, got {other:?}"),
            },
            first.restart_failures,
            first.health_failures,
        );
        restarted_events += u32::from(second.emit_restarted);

        assert_eq!(attempts.get(), 2);
        assert_eq!(second.restart_failures, 0);
        assert_eq!(second.health_failures, 0);
        assert_eq!(restarted_events, 1);
    }

    #[tokio::test]
    async fn explicit_stop_between_attempts_prevents_the_second_restart_dispatch() {
        use std::cell::Cell;

        let mut manager = SidecarManager::new();
        manager.request_global_sidecar_running("test-start");
        let first = global_restart_attempt_transition(GlobalRestartAttemptStatus::Failed, 0, T);
        assert_eq!(first.restart_failures, 1);

        manager.request_global_sidecar_stopped("test-stop-between-attempts");
        let attempts = Cell::new(0_u32);
        let cycle = run_global_monitor_cycle(manager.global_monitor_snapshot(), |_| async {
            attempts.set(attempts.get() + 1);
            GlobalRestartAttemptResult::Failed("must not run".to_string())
        })
        .await;
        assert!(matches!(cycle, GlobalMonitorCycle::Idle));
        assert_eq!(attempts.get(), 0);

        let stopped = global_restart_attempt_transition(
            GlobalRestartAttemptStatus::Stopped,
            first.restart_failures,
            first.health_failures,
        );
        assert_eq!(stopped.restart_failures, 0);
        assert_eq!(stopped.health_failures, 0);
        assert!(!stopped.emit_restarted);
    }
}

#[cfg(test)]
mod sidecar_process_role_invariant_tests {
    use super::resolve_sidecar_process_role;
    use crate::sidecar::{SidecarProcessRole, GLOBAL_SIDECAR_ID};

    #[test]
    fn accepts_only_the_two_canonical_identity_directory_pairs() {
        assert_eq!(
            resolve_sidecar_process_role(GLOBAL_SIDECAR_ID, false),
            Ok(SidecarProcessRole::Global)
        );
        assert_eq!(
            resolve_sidecar_process_role("__legacy__", true),
            Ok(SidecarProcessRole::Session)
        );
    }

    #[test]
    fn rejects_both_role_identity_mismatches() {
        assert!(resolve_sidecar_process_role(GLOBAL_SIDECAR_ID, true).is_err());
        assert!(resolve_sidecar_process_role("session-123", false).is_err());
    }
}

/// Forward `terminal_events` from `SidecarManager` to the renderer as the
/// `session:sidecar-terminal` Tauri event. Lets the renderer drop stale
/// `tab.sessionId` bindings the moment the underlying session is gone for good
/// (no auto-restart will fire because no owners remained at removal). Without
/// this bridge, a Tab that lost its sidecar via voluntary release silently
/// keeps `sessionId` set; the next time the user clicks that session in the
/// task center, `planSessionOpen` matches the stale Tab and "jumps" to a tab
/// whose sidecar has been gone for hours — empty UI + flood of "no running
/// sidecar" errors. (See unified-2026-05-02.log around 22:49:48 for the
/// reference trace.)
///
/// `Lagged` recovery: capacity is 64, normally plenty. On a burst (e.g.
/// shutdown / `cmd_stop_all`) we may drop events. Emit a one-shot reconcile
/// payload carrying the *currently-live* session ids so the renderer can
/// clear any tab whose `sessionId` is not in that set — equivalent to the
/// IM module's reconcile-against-`live_sidecar_set()` pattern.
pub async fn forward_terminal_events_to_renderer(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    mut rx: tokio::sync::broadcast::Receiver<(String, u64)>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    ulog_info!("[sidecar] Terminal-event forwarder started");

    loop {
        if shutdown.load(Relaxed) {
            break;
        }
        match rx.recv().await {
            Ok((session_id, generation)) => {
                let _ = app_handle.emit(
                    "session:sidecar-terminal",
                    serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                    }),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                ulog_warn!(
                    "[sidecar] Terminal-event forwarder lagged by {} — emitting reconcile",
                    n
                );
                // On lock poison we cannot snapshot the live set safely.
                // Fall through with `Skip` (don't emit at all) rather than
                // emitting an empty list — an empty list would tell the
                // renderer "no sessions are live, clear every tab", which is
                // a destructive fallback exactly when our state is most
                // uncertain. The renderer's defensive `hasSessionSidecar` check
                // in `handleLaunchProject` jump-to-tab still saves the user
                // if they do click into a stale binding before our next
                // event arrives. (Codex review WARN-1.)
                let live: Option<Vec<String>> = match manager.lock() {
                    Ok(g) => Some(
                        g.live_sidecar_set()
                            .into_iter()
                            .map(|(sid, _)| sid)
                            .collect(),
                    ),
                    Err(e) => {
                        ulog_error!(
                            "[sidecar] Terminal-event reconcile skipped — manager lock poisoned: {}",
                            e
                        );
                        None
                    }
                };
                if let Some(live) = live {
                    let _ = app_handle.emit(
                        "session:sidecar-terminal-reconcile",
                        serde_json::json!({ "liveSessionIds": live }),
                    );
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                ulog_info!("[sidecar] Terminal-event forwarder channel closed");
                break;
            }
        }
    }
}

/// Monitor all session sidecars and auto-restart dead ones that still have owners.
/// Recovery identity, retained owners, and retry clock all remain manager-owned;
/// this task is only a periodic dispatcher.
fn recovery_dispatch_candidates(
    manager: &mut SidecarManager,
    now: std::time::Instant,
    update_quiesced: bool,
) -> Vec<String> {
    if update_quiesced {
        Vec::new()
    } else {
        manager.due_session_recoveries(now)
    }
}

#[cfg(test)]
mod session_recovery_dispatch_tests {
    use super::recovery_dispatch_candidates;
    use crate::sidecar::{SidecarManager, SidecarOwner, SidecarState};

    #[test]
    fn update_quiesce_pauses_without_losing_active_or_recovering_work() {
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32001,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        manager
            .get_session_sidecar_mut("session-a")
            .expect("sidecar")
            .state = SidecarState::Dead;
        let now = std::time::Instant::now();

        assert!(recovery_dispatch_candidates(&mut manager, now, true).is_empty());
        assert!(manager.sidecars.contains_key("session-a"));
        assert!(!manager.has_session_recovery("session-a"));

        assert_eq!(
            recovery_dispatch_candidates(&mut manager, now, false),
            vec!["session-a".to_string()]
        );
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("manager-owned recovery")
            .epoch;
        let failure = manager
            .record_session_recovery_failure("session-a", Some(epoch), now)
            .expect("retry state");
        let retry_at = now + failure.retry_after;

        assert!(recovery_dispatch_candidates(&mut manager, retry_at, true).is_empty());
        assert!(manager.has_session_recovery("session-a"));
        assert_eq!(
            recovery_dispatch_candidates(&mut manager, retry_at, false),
            vec!["session-a".to_string()]
        );
    }
}

pub async fn monitor_session_sidecars(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 15;

    // Initial delay: let app fully start before monitoring
    tokio::time::sleep(Duration::from_secs(20)).await;
    ulog_info!("[sidecar] Session sidecar health monitor started");

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }
        let update_quiesced = is_update_shutdown_in_progress();
        let session_ids = match manager.lock() {
            Ok(mut guard) => {
                recovery_dispatch_candidates(&mut guard, std::time::Instant::now(), update_quiesced)
            }
            Err(_) => continue,
        };
        for session_id in session_ids {
            if shutdown.load(Relaxed) {
                break;
            }
            if is_update_shutdown_in_progress() {
                continue;
            }

            // Deletion and every owner-acquiring ensure use this same guard.
            // Keep it across take → blocking restart → install/restore so no
            // delete can observe the deliberate manager gap.
            let _lifecycle = acquire_session_lifecycle(&[&session_id]).await;

            let restart_identity = {
                let guard = match manager.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                guard.recovery_restart_identity(&session_id, std::time::Instant::now())
            };
            let Some(restart_identity) = restart_identity else {
                continue;
            };
            ulog_info!(
                "[sidecar-recovery] action=dispatch session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms=0",
                session_id,
                restart_identity.epoch,
                restart_identity.dead_generation,
                restart_identity.prior_candidate_generation,
                restart_identity.attempt
            );
            // Pin the restart to the same runtime the dead sidecar was running
            // with. Owner iteration order cannot change the process identity.
            let recovery_epoch = restart_identity.epoch;
            let dead_generation = restart_identity.dead_generation;
            let attempt = restart_identity.attempt;
            let first_owner = restart_identity.owner;
            let workspace = restart_identity.workspace_path;
            let pinned_runtime = restart_identity.runtime;
            let pinned_runtime_source = restart_identity.runtime_source;
            let mgr = manager.clone();
            let app = app_handle.clone();
            let sid = session_id.clone();

            let restart = tauri::async_runtime::spawn_blocking(move || {
                ensure_session_sidecar_with_runtime_identity_override(
                    &app,
                    &mgr,
                    &sid,
                    &workspace,
                    first_owner,
                    pinned_runtime,
                    pinned_runtime_source,
                    Some(recovery_epoch),
                )
            })
            .await;

            match restart {
                Ok(Ok(result)) => {
                    let installed = manager.lock().ok().is_some_and(|guard| {
                        guard.is_live(&session_id, result.generation)
                            && !guard.has_session_recovery(&session_id)
                    });
                    if !installed {
                        continue;
                    }
                    ulog_info!(
                        "[sidecar-recovery] action=settled session={} epoch={} dead_generation={} candidate_generation={} attempt={} port={}",
                        session_id,
                        recovery_epoch,
                        dead_generation,
                        result.generation,
                        attempt,
                        result.port
                    );
                    let _ = app_handle.emit(
                        "session-sidecar:restarted",
                        serde_json::json!({
                            "sessionId": session_id,
                            "port": result.port,
                        }),
                    );
                }
                Ok(Err(e)) => {
                    ulog_error!(
                        "[sidecar-recovery] action=attempt-failed session={} epoch={} dead_generation={} attempt={} error={}",
                        session_id, recovery_epoch, dead_generation, attempt, e
                    );
                }
                Err(e) => {
                    let failure = manager.lock().ok().and_then(|mut guard| {
                        guard.record_session_recovery_failure(
                            &session_id,
                            Some(recovery_epoch),
                            std::time::Instant::now(),
                        )
                    });
                    ulog_error!(
                        "[sidecar-recovery] action=worker-failed session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={:?} error={}",
                        session_id,
                        recovery_epoch,
                        dead_generation,
                        failure.and_then(|value| value.candidate_generation),
                        attempt,
                        failure.map(|value| value.retry_after.as_millis()),
                        e
                    );
                }
            }
        }
    }
}
