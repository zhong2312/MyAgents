use super::*;

// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, shared by their live owners.

#[derive(Default)]
struct DispatchGateState {
    accepting: bool,
    in_flight: usize,
}

/// Per-process admission fence for renderer control requests.
///
/// Admission happens while `SidecarManager` still owns endpoint selection;
/// the returned lease then crosses the network await without retaining the
/// manager mutex. Process replacement closes the gate and waits for the exact
/// generation's admitted requests to finish before terminating it.
pub(crate) struct DispatchGate {
    state: Mutex<DispatchGateState>,
    drained: Condvar,
}

impl DispatchGate {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(DispatchGateState {
                accepting: true,
                in_flight: 0,
            }),
            drained: Condvar::new(),
        })
    }

    pub(crate) fn try_acquire(gate: &Arc<Self>) -> Option<DispatchLease> {
        let mut state = gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.accepting {
            return None;
        }
        state.in_flight += 1;
        Some(DispatchLease { gate: gate.clone() })
    }

    pub(crate) fn close_and_wait(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.accepting = false;
        while state.in_flight > 0 {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

pub(crate) struct DispatchLease {
    gate: Arc<DispatchGate>,
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert!(state.in_flight > 0);
        state.in_flight = state.in_flight.saturating_sub(1);
        if state.in_flight == 0 {
            self.gate.drained.notify_all();
        }
    }
}

/// Owner of a Sidecar.
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Floating companion surface. It is frontend-config-authoritative like a
    /// Tab, but the main App cannot release it during Tab lifecycle changes.
    Companion(String),
    /// Task Center task.
    Task(String),
    /// Session-owned Goal. The Goal persists independently from any Tab or Task.
    Goal(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
    /// Agent owner - keeps Sidecar alive for IM/Agent message processing
    /// String is the session_key (e.g. "agent:{agentId}:{channel}:{type}:{id}")
    Agent(String),
}

/// Explicit three-state lifecycle for a SessionSidecar.
///
/// Replaces the previous `healthy: bool` which conflated Starting (process alive,
/// not yet healthy) with Dead (process exited), causing race conditions where
/// health monitors would kill Starting sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    /// Process spawned, `wait_for_health` in progress — do not kill.
    Starting,
    /// TCP health check passed (`wait_for_health`), ready to serve requests.
    Healthy,
    /// Process exited or health check permanently failed.
    Dead,
}

/// Session-centric Sidecar instance
/// Each Session has at most one Sidecar, shared by multiple owners.
/// Result of `SidecarManager::kill_sidecar_if_runtime_differs`.
///
/// Distinguishes between three cases:
/// - `NoDrift`: the existing Sidecar's runtime matches the desired runtime
///   (or there's no existing Sidecar).
/// - `DetectedKeptAlive`: drift was detected but the Sidecar has non-Agent
///   owners (Tab/Task/Goal/BackgroundCompletion) attached, so killing would
///   orphan a desktop session. The caller (IM router) should still treat
///   this as drift and fork the peer to a new session_id.
/// - `KilledAndRemoved`: drift was detected AND the Sidecar had only Agent
///   owners, so it's been killed and evicted from the manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeDriftResult {
    NoDrift,
    DetectedKeptAlive,
    KilledAndRemoved,
}

impl RuntimeDriftResult {
    /// Did we observe a runtime drift? (True for both kill outcomes.)
    pub fn is_drift(&self) -> bool {
        matches!(self, Self::KilledAndRemoved | Self::DetectedKeptAlive)
    }
}

pub(super) enum ExistingSidecarReuse {
    Healthy {
        port: u16,
        generation: u64,
        runtime: String,
        runtime_source: Option<String>,
    },
    /// `owner_added` = whether THIS ensure call newly inserted its owner when it
    /// joined the still-starting Sidecar. Only true means a readiness-timeout
    /// detach may safely remove that owner (see `add_owner`).
    Starting {
        port: u16,
        generation: u64,
        runtime: String,
        runtime_source: Option<String>,
        owner_added: bool,
    },
}

pub(super) fn normalize_runtime_name(runtime: Option<&str>) -> &str {
    match runtime {
        Some(runtime) if !runtime.is_empty() => runtime,
        _ => "builtin",
    }
}

pub(super) fn normalize_runtime_source_name(
    runtime: &str,
    runtime_source: Option<&str>,
) -> &'static str {
    let runtime = normalize_runtime_name(Some(runtime));
    if runtime == "builtin" {
        return "builtin";
    }
    match runtime_source {
        Some("managed-provider") => "managed-provider",
        _ => "system-cli",
    }
}

pub(super) fn sidecar_has_non_agent_owner(owners: &HashSet<SidecarOwner>) -> bool {
    owners
        .iter()
        .any(|owner| !matches!(owner, SidecarOwner::Agent(_)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SidecarRemovalEventPolicy {
    pub(super) emit_stop: bool,
    pub(super) emit_terminal: bool,
}

pub(super) fn sidecar_removal_event_policy(
    owners: &HashSet<SidecarOwner>,
) -> SidecarRemovalEventPolicy {
    SidecarRemovalEventPolicy {
        emit_stop: true,
        emit_terminal: owners.is_empty(),
    }
}

#[cfg(test)]
pub(super) fn decide_runtime_drift_result(
    sidecar_runtime: Option<&str>,
    desired_runtime: &str,
    owners: &HashSet<SidecarOwner>,
) -> RuntimeDriftResult {
    decide_runtime_identity_drift_result(sidecar_runtime, None, desired_runtime, None, owners)
}

pub(super) fn decide_runtime_identity_drift_result(
    sidecar_runtime: Option<&str>,
    sidecar_runtime_source: Option<&str>,
    desired_runtime: &str,
    desired_runtime_source: Option<&str>,
    owners: &HashSet<SidecarOwner>,
) -> RuntimeDriftResult {
    let sidecar_runtime = normalize_runtime_name(sidecar_runtime);
    let desired_runtime = normalize_runtime_name(Some(desired_runtime));
    let sidecar_source = normalize_runtime_source_name(sidecar_runtime, sidecar_runtime_source);
    let desired_source = normalize_runtime_source_name(desired_runtime, desired_runtime_source);

    if sidecar_runtime == desired_runtime && sidecar_source == desired_source {
        RuntimeDriftResult::NoDrift
    } else if sidecar_has_non_agent_owner(owners) {
        RuntimeDriftResult::DetectedKeptAlive
    } else {
        RuntimeDriftResult::KilledAndRemoved
    }
}

pub(super) fn owner_prefers_live_agent_runtime(owner: &SidecarOwner) -> bool {
    matches!(
        owner,
        SidecarOwner::Agent(key) if key.starts_with("agent:") || key.starts_with("im:")
    )
}

pub(super) fn resolve_runtime_for_owner(
    runtime_override: Option<String>,
    owner: &SidecarOwner,
    session_runtime: Option<String>,
    agent_runtime: Option<String>,
) -> Option<String> {
    runtime_override.or_else(|| {
        if owner_prefers_live_agent_runtime(owner) {
            agent_runtime
        } else {
            session_runtime.or(agent_runtime)
        }
    })
}

#[cfg(test)]
mod lifecycle_contract_tests {
    use super::*;
    use crate::sidecar::manager::GlobalMonitorSnapshot;
    use std::collections::HashSet;

    fn owners(values: Vec<SidecarOwner>) -> HashSet<SidecarOwner> {
        values.into_iter().collect()
    }

    #[test]
    fn dispatch_gate_drains_admitted_request_before_closing_generation() {
        let gate = DispatchGate::new();
        let lease = DispatchGate::try_acquire(&gate).expect("first request is admitted");
        let closing_gate = gate.clone();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            closing_gate.close_and_wait();
            closed_tx.send(()).expect("report closed gate");
        });

        assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(lease);
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("closing waits only for the admitted request");
        assert!(DispatchGate::try_acquire(&gate).is_none());
    }

    fn assert_dispatch_blocks_generation_close<T>(dispatch: T, gate: Arc<DispatchGate>) {
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            gate.close_and_wait();
            closed_tx.send(()).expect("report closed generation");
        });
        assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(dispatch);
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("generation closes after its request completes");
    }

    #[test]
    fn session_and_global_dispatches_hold_their_selected_generation() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let session_gate = manager
            .sidecars
            .get("session-a")
            .expect("Session Sidecar")
            .dispatch_gate
            .clone();
        let session_dispatch = manager
            .acquire_frontend_session_dispatch("session-a", &SidecarOwner::Tab("tab-a".to_string()))
            .expect("Session dispatch");
        assert_dispatch_blocks_generation_close(session_dispatch, session_gate);

        manager.next_generation(GLOBAL_SIDECAR_ID);
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            SidecarInstance {
                process: spawn_test_child(),
                port: 31419,
                agent_dir: None,
                healthy: true,
                is_global: true,
                session_delete_authority: None,
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
            },
        );
        let global_gate = manager
            .instances
            .get(GLOBAL_SIDECAR_ID)
            .expect("Global Sidecar")
            .dispatch_gate
            .clone();
        let global_dispatch = manager.acquire_global_dispatch().expect("Global dispatch");
        assert_dispatch_blocks_generation_close(global_dispatch, global_gate);
    }

    #[test]
    fn global_standing_intent_survives_candidate_failure_until_explicit_stop() {
        let mut manager = SidecarManager::new();
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));

        manager.request_global_sidecar_running("test-start");
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::DesiredMissing
        ));

        let failed_generation = manager.next_generation(GLOBAL_SIDECAR_ID);
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            SidecarInstance {
                process: spawn_test_child(),
                port: 31419,
                agent_dir: None,
                healthy: false,
                is_global: true,
                session_delete_authority: None,
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
            },
        );
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Present { port: 31419, .. }
        ));

        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert_eq!(manager.current_generation(GLOBAL_SIDECAR_ID), 0);
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::DesiredMissing
        ));

        let ready_generation = manager.next_generation(GLOBAL_SIDECAR_ID);
        assert!(ready_generation > failed_generation);
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            SidecarInstance {
                process: spawn_test_child(),
                port: 31420,
                agent_dir: None,
                healthy: true,
                is_global: true,
                session_delete_authority: None,
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
            },
        );
        assert!(manager.acquire_global_dispatch().is_ok());
        assert!(manager.global_sidecar_is_desired());

        manager.request_global_sidecar_stopped("test-explicit-stop");
        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));

        manager.request_global_sidecar_running("test-stop-all");
        manager.stop_all();
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));
    }

    #[test]
    fn runtime_drift_with_tab_and_agent_owner_is_kept_alive() {
        let owners = owners(vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &owners),
            RuntimeDriftResult::DetectedKeptAlive
        );
    }

    #[test]
    fn runtime_drift_with_only_agent_owners_is_killable() {
        let owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &owners),
            RuntimeDriftResult::KilledAndRemoved
        );
    }

    #[test]
    fn builtin_runtime_names_are_normalized_for_no_drift() {
        let owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert_eq!(
            decide_runtime_drift_result(None, "", &owners),
            RuntimeDriftResult::NoDrift
        );
        assert_eq!(
            decide_runtime_drift_result(None, "builtin", &owners),
            RuntimeDriftResult::NoDrift
        );
    }

    #[test]
    fn runtime_source_is_part_of_drift_identity() {
        let owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert_eq!(
            decide_runtime_identity_drift_result(
                Some("codex"),
                Some("system-cli"),
                "codex",
                Some("managed-provider"),
                &owners,
            ),
            RuntimeDriftResult::KilledAndRemoved
        );
        assert_eq!(
            decide_runtime_identity_drift_result(
                Some("codex"),
                None,
                "codex",
                Some("system-cli"),
                &owners,
            ),
            RuntimeDriftResult::NoDrift
        );
    }

    #[test]
    fn desktop_style_owner_prefers_builtin_session_metadata_over_agent_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Tab("tab-a".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("builtin".to_string())
        );
    }

    #[test]
    fn agent_owner_ignores_session_runtime_and_follows_agent_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Agent("agent:a:openclaw:feishu:private:user".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("codex".to_string())
        );
    }

    #[test]
    fn maintenance_agent_owner_prefers_session_metadata_over_agent_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Agent("memory_update:a:s1".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("builtin".to_string())
        );
    }

    #[test]
    fn session_runtime_identity_parser_preserves_builtin_metadata() {
        let content = serde_json::json!([
            { "id": "missing-runtime" },
            { "id": "builtin-runtime", "runtime": "builtin" },
            { "id": "codex-runtime", "runtime": "codex" },
            { "id": "managed-codex-runtime", "runtime": "codex", "runtimeSource": "managed-provider" },
            { "id": "malformed-managed-runtime", "runtime": "builtin", "runtimeSource": "managed-provider" }
        ])
        .to_string();

        assert_eq!(
            resolve_session_runtime_identity_from_json("missing-runtime", &content),
            Some("builtin".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("builtin-runtime", &content),
            Some("builtin".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("codex-runtime", &content),
            Some("codex".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("codex-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("system-cli".to_string()),
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("managed-codex-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("managed-provider".to_string()),
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("malformed-managed-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("managed-provider".to_string()),
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("unknown", &content),
            None
        );
    }

    #[test]
    fn task_and_background_owners_make_runtime_drift_non_killable() {
        let task = owners(vec![SidecarOwner::Task("task-a".to_string())]);
        let background = owners(vec![SidecarOwner::BackgroundCompletion(
            "session-a".to_string(),
        )]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &task),
            RuntimeDriftResult::DetectedKeptAlive
        );
        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &background),
            RuntimeDriftResult::DetectedKeptAlive
        );
    }

    #[test]
    fn terminal_removal_requires_no_remaining_owners() {
        assert_eq!(
            sidecar_removal_event_policy(&HashSet::new()),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: true
            }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Tab("tab-a".to_string())])),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: false
            }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Agent("agent-a".to_string())])),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: false
            }
        );
    }

    #[test]
    fn sidecar_generation_is_monotonic_and_not_reused_after_clear() {
        let mut manager = SidecarManager::new();

        let first = manager.next_generation("session-a");
        let second = manager.next_generation("session-a");
        assert!(second > first);

        manager.clear_generation("session-a");
        assert_eq!(manager.current_generation("session-a"), 0);

        let third = manager.next_generation("session-a");
        assert!(third > second);
    }

    #[test]
    fn management_process_identity_covers_global_and_session_sidecars() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-a", SidecarState::Healthy);
        let session_generation = manager.current_generation("pending-a");
        assert!(manager.is_live_process("pending-a", session_generation));

        assert!(manager.upgrade_session_id("pending-a", "session-a"));
        assert!(
            manager.is_live_process("pending-a", session_generation),
            "a logical Session key upgrade must not invalidate the immutable identity injected into the live process"
        );
        assert!(
            !manager.is_live_process("session-a", session_generation),
            "the mutable Session key is not a substitute for the process's injected management identity"
        );

        let global_generation = manager.next_generation(GLOBAL_SIDECAR_ID);
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            SidecarInstance {
                process: spawn_test_child(),
                port: 31419,
                agent_dir: None,
                healthy: true,
                is_global: true,
                session_delete_authority: None,
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
            },
        );
        assert!(manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation + 1));

        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
    }

    #[test]
    fn tab_scoped_identity_upgrade_accepts_only_the_exact_tab_owner() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-real", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-real")
            .expect("session sidecar")
            .add_owner(SidecarOwner::Task("task-1".to_string()));

        assert!(!manager.upgrade_session_id_for_tab("pending-a", "session-real", "tab-b",));
        assert!(manager.session_id_upgrade_is_already_applied_for_tab(
            "pending-a",
            "session-real",
            "tab-a",
        ));
        assert!(manager.upgrade_session_id_for_tab("pending-a", "session-real", "tab-a",));
    }

    #[test]
    fn tab_scoped_identity_upgrade_rejects_a_recovering_source() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-recovery", SidecarState::Dead);
        manager.begin_session_sidecar_replacement("pending-recovery");

        assert!(!manager.upgrade_session_id_for_tab("pending-recovery", "session-real", "tab-a",));
        assert!(manager.recovering_sidecars.contains_key("pending-recovery"));
        assert!(!manager.recovering_sidecars.contains_key("session-real"));
    }

    #[test]
    fn tab_activation_reconcile_preserves_task_identity_atomically() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-task", SidecarState::Healthy);
        let sidecar = manager
            .get_session_sidecar_mut("session-task")
            .expect("session sidecar");
        sidecar.add_owner(SidecarOwner::Task("task-1".to_string()));
        sidecar.add_owner(SidecarOwner::BackgroundCompletion(
            "session-task".to_string(),
        ));
        sidecar.port = 32001;
        sidecar.workspace_path = PathBuf::from("/tmp/revived");
        assert!(manager.reconcile_session_tab_activation("session-task", "tab-a",));

        let sidecar = manager
            .get_session_sidecar_mut("session-task")
            .expect("session sidecar");
        assert_eq!(sidecar.port, 32001);
        assert_eq!(sidecar.workspace_path, PathBuf::from("/tmp/revived"));
        assert!(sidecar
            .owners
            .contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(sidecar
            .owners
            .contains(&SidecarOwner::Task("task-1".to_string())));
        assert!(
            !sidecar.owners.contains(&SidecarOwner::BackgroundCompletion(
                "session-task".to_string(),
            ))
        );
    }

    fn spawn_test_child() -> ChildTree {
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("powershell");
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            cmd
        };

        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("sleep");
            cmd.arg("60");
            cmd
        };

        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::process_cmd::spawn_tree(&mut cmd).expect("spawn test child tree")
    }

    fn insert_test_sidecar(manager: &mut SidecarManager, session_id: &str, state: SidecarState) {
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process: spawn_test_child(),
                port: 31418,
                session_id: session_id.to_string(),
                management_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state,
                owners: owners(vec![SidecarOwner::Tab("tab-a".to_string())]),
                completion_claims: HashSet::new(),
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
                runtime: None,
                runtime_source: None,
            },
        );
    }

    #[test]
    fn session_port_is_not_exposed_until_sidecar_is_healthy() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);

        assert_eq!(manager.get_session_port("session-a"), None);

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .state = SidecarState::Healthy;

        assert_eq!(manager.get_session_port("session-a"), Some(31418));
    }

    #[test]
    fn sse_owner_resolver_uses_exact_hint_and_requires_owner_match() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "session-b", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session-a")
            .owners = owners(vec![SidecarOwner::Tab("tab-other".to_string())]);

        let owner = SidecarOwner::Tab("tab-a".to_string());
        let error = manager
            .resolve_session_sidecar_for_frontend_owner("session-a", &owner)
            .expect_err("an exact hint with the wrong owner must fail closed");

        assert!(error.contains("not owned"));
        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("session-b", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
    }

    #[test]
    fn sse_owner_resolver_follows_pending_to_real_key_upgrade() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-tab-a", SidecarState::Healthy);
        let owner = SidecarOwner::Tab("tab-a".to_string());

        assert!(manager.upgrade_session_id("pending-tab-a", "session-real"));
        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("pending-tab-a", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
    }

    #[test]
    fn sse_owner_resolver_rejects_ambiguous_companion_handover() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-old", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "session-new", SidecarState::Healthy);
        let owner = SidecarOwner::Companion("floating-ball".to_string());
        for session_id in ["session-old", "session-new"] {
            manager
                .get_session_sidecar_mut(session_id)
                .expect("session sidecar")
                .owners = owners(vec![owner.clone()]);
        }

        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("session-new", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
        let error = manager
            .resolve_session_sidecar_for_frontend_owner("missing-hint", &owner)
            .expect_err("owner-only fallback must reject multiple matches");
        assert!(error.contains("ambiguously matches"));
        assert!(error.contains("session-new"));
        assert!(error.contains("session-old"));
    }

    #[test]
    fn session_has_frontend_owner_tracks_tab_and_companion_presence() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        assert!(manager.session_has_frontend_owner("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Companion("floating-ball".to_string())]);

        assert!(manager.session_has_frontend_owner("session-a"));
        assert!(manager.session_has_persistent_owners("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert!(!manager.session_has_frontend_owner("session-a"));
        assert!(!manager.session_has_frontend_owner("missing-session"));
    }

    #[test]
    fn healthy_inbox_attachment_adds_agent_owner_before_returning_port() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        assert_eq!(
            manager.attach_owner_to_healthy_session(
                "session-a",
                SidecarOwner::Agent("inbox-deliver-a".to_string()),
            ),
            Some(31418)
        );
        assert!(manager.session_has_persistent_owners("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .state = SidecarState::Dead;
        assert_eq!(
            manager.attach_owner_to_healthy_session(
                "session-a",
                SidecarOwner::Agent("inbox-deliver-b".to_string()),
            ),
            None
        );
    }

    #[test]
    fn stale_tab_release_does_not_clear_a_current_tab_owner() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        assert!(!manager.release_tab_session("session-a", "stale-tab", false));
        assert!(
            manager.session_has_exact_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),)
        );
        assert!(manager.session_has_frontend_owner("session-a"));
    }

    #[test]
    fn stale_release_does_not_disturb_persistent_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Goal("goal-a".to_string())]);

        assert!(!manager.release_tab_session("session-a", "closed-tab", false));
        assert!(manager.session_has_persistent_owners("session-a"));
    }

    #[test]
    fn replacement_commit_preserves_all_owners_and_process_coordinates() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .insert(SidecarOwner::Goal("goal-a".to_string()));

        manager.begin_session_sidecar_replacement("session-a");
        assert!(!manager.sidecars.contains_key("session-a"));
        assert!(manager.recovering_sidecars.contains_key("session-a"));

        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let replacement = manager
            .get_session_sidecar_mut("session-a")
            .expect("replacement sidecar");
        replacement.port = 32002;
        replacement.workspace_path = PathBuf::from("/tmp/new-workspace");
        replacement.owners = owners(vec![SidecarOwner::Task("task-a".to_string())]);
        let replacement_generation = manager.current_generation("session-a");

        let commit = manager
            .commit_ready_session_sidecar("session-a")
            .expect("replacement commit");
        assert_eq!(commit.generation, replacement_generation);
        assert_eq!(commit.port, 32002);
        let replacement = manager
            .get_session_sidecar_mut("session-a")
            .expect("committed replacement");
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Goal("goal-a".to_string())));
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Task("task-a".to_string())));
        assert!(!manager.recovering_sidecars.contains_key("session-a"));
    }

    #[test]
    fn recovery_epoch_survives_generation_reserve_and_readiness_failures() {
        let mut manager = SidecarManager::new();
        let mut terminal_events = manager.subscribe_terminal_events();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        let dead_generation = manager.current_generation("session-a");
        manager.begin_session_sidecar_replacement("session-a");
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;
        assert!(manager
            .record_session_recovery_failure(
                "session-a",
                Some(epoch.saturating_add(1)),
                std::time::Instant::now(),
            )
            .is_none());
        assert_eq!(
            manager
                .recovering_sidecars
                .get("session-a")
                .expect("same recovery")
                .failed_attempts,
            0
        );

        // Candidate generation was reserved but spawn failed before insertion.
        let reserved_generation = manager.next_generation("session-a");
        manager.clear_generation("session-a");
        let now = std::time::Instant::now();
        let reserve_failure = manager
            .record_session_recovery_failure("session-a", Some(epoch), now)
            .expect("reserve failure");
        assert_eq!(reserve_failure.epoch, epoch);
        assert_eq!(reserve_failure.dead_generation, dead_generation);
        assert_eq!(
            reserve_failure.candidate_generation,
            Some(reserved_generation)
        );

        // A later candidate reached active/Starting but failed readiness.
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);
        let readiness_generation = manager.current_generation("session-a");
        manager.remove_sidecar("session-a");
        let readiness_failure = manager
            .record_session_recovery_failure(
                "session-a",
                Some(epoch),
                now + reserve_failure.retry_after,
            )
            .expect("readiness failure");
        assert_eq!(readiness_failure.epoch, epoch);
        assert_eq!(readiness_failure.dead_generation, dead_generation);
        assert_eq!(
            readiness_failure.candidate_generation,
            Some(readiness_generation)
        );
        assert!(manager.recovering_sidecars.contains_key("session-a"));
        assert!(matches!(
            terminal_events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn recovery_fast_retries_transition_to_bounded_slow_retries() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager.begin_session_sidecar_replacement("session-a");
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;
        let mut now = std::time::Instant::now();
        let expected_delays = [15, 15, 15, 15, 60, 120, 240, 300, 300];

        for (index, expected_secs) in expected_delays.into_iter().enumerate() {
            let failure = manager
                .record_session_recovery_failure("session-a", Some(epoch), now)
                .expect("scheduled retry");
            assert_eq!(failure.failed_attempts, index as u32 + 1);
            assert_eq!(failure.retry_after, Duration::from_secs(expected_secs));
            assert!(manager.due_session_recoveries(now).is_empty());
            now += failure.retry_after;
            assert_eq!(
                manager.due_session_recoveries(now),
                vec!["session-a".to_string()]
            );
        }
    }

    #[test]
    fn ready_independent_candidate_settles_recovery_epoch_and_retains_mixed_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .extend([
                SidecarOwner::Task("task-a".to_string()),
                SidecarOwner::Goal("goal-a".to_string()),
            ]);
        manager.begin_session_sidecar_replacement("session-a");

        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let generation = manager.current_generation("session-a");
        let commit = manager
            .commit_ready_session_sidecar("session-a")
            .expect("independent candidate wins");
        assert_eq!(commit.generation, generation);
        assert_eq!(commit.port, 31418);
        assert!(!manager.has_session_recovery("session-a"));
        let owners = &manager
            .get_session_sidecar("session-a")
            .expect("committed sidecar")
            .owners;
        assert!(owners.contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(owners.contains(&SidecarOwner::Task("task-a".to_string())));
        assert!(owners.contains(&SidecarOwner::Goal("goal-a".to_string())));
    }

    #[test]
    fn background_completion_keeps_identity_active_after_tab_release() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners
            .insert(SidecarOwner::BackgroundCompletion("session-a".to_string()));
        assert!(!manager.release_tab_session("session-a", "tab-a", false));
        assert!(manager.session_has_persistent_owners("session-a"));
        assert!(
            !manager.session_has_exact_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),)
        );
    }

    #[test]
    fn deletion_protection_snapshot_excludes_plain_tabs_and_includes_recovering_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "tab-only", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "agent-owned", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("agent-owned")
            .expect("agent sidecar")
            .owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        insert_test_sidecar(&mut manager, "companion-owned", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("companion-owned")
            .expect("companion sidecar")
            .owners = owners(vec![SidecarOwner::Companion("floating-ball".to_string())]);

        insert_test_sidecar(&mut manager, "recovering", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("recovering")
            .expect("recovering sidecar")
            .owners = owners(vec![SidecarOwner::BackgroundCompletion(
            "recovering".to_string(),
        )]);
        manager.begin_session_sidecar_replacement("recovering");

        assert_eq!(
            manager.persistent_owner_session_ids(),
            vec![
                "agent-owned".to_string(),
                "companion-owned".to_string(),
                "recovering".to_string(),
            ]
        );
    }

    #[test]
    fn last_generic_owner_release_clears_session_identity() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Goal("goal-a".to_string())]);
        assert_eq!(
            manager.remove_session_owner("session-a", &SidecarOwner::Goal("goal-a".to_string())),
            (true, true)
        );
        assert!(!manager.sidecars.contains_key("session-a"));
        assert_eq!(manager.current_generation("session-a"), 0);
    }

    #[test]
    fn dead_sidecar_with_owners_still_protects_session_identity() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);

        assert!(!manager.has_session_sidecar("session-a"));
        assert!(manager.session_has_owners("session-a"));
    }

    #[test]
    fn owner_release_during_restart_updates_recovery_authority() {
        let mut manager = SidecarManager::new();
        let mut terminal_events = manager.subscribe_terminal_events();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .insert(SidecarOwner::Goal("goal-a".to_string()));
        manager.begin_session_sidecar_replacement("session-a");
        let recovery_epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;

        // The monitor's replacement initially owns only the owner chosen to
        // start it; the retained dead object still carries every owner.
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);
        assert_eq!(
            manager.remove_session_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),),
            (true, false),
        );
        assert!(!manager.recovery_attempt_is_authorized(
            "session-a",
            recovery_epoch,
            &SidecarOwner::Tab("tab-a".to_string())
        ));
        assert!(manager.recovery_attempt_is_authorized(
            "session-a",
            recovery_epoch,
            &SidecarOwner::Goal("goal-a".to_string())
        ));
        assert!(manager.sidecars.contains_key("session-a"));
        assert!(manager.session_has_persistent_owners("session-a"));

        // The selected candidate owner left, so the failed candidate now has
        // an empty local owner set. Retained Goal authority still makes this a
        // recoverable failure, not an ownerless terminal.
        manager.remove_sidecar("session-a");
        assert!(matches!(
            terminal_events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        assert_eq!(
            manager.remove_session_owner("session-a", &SidecarOwner::Goal("goal-a".to_string()),),
            (true, true),
        );
        assert!(!manager.sidecars.contains_key("session-a"));
        assert!(!manager.recovering_sidecars.contains_key("session-a"));
    }

    #[test]
    fn every_sidecar_owner_variant_blocks_session_deletion() {
        let owner_variants = vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Companion("floating-ball".to_string()),
            SidecarOwner::Task("task-a".to_string()),
            SidecarOwner::Goal("goal-a".to_string()),
            SidecarOwner::BackgroundCompletion("session-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ];

        for owner in owner_variants {
            let mut manager = SidecarManager::new();
            insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
            manager
                .get_session_sidecar_mut("session-a")
                .expect("session sidecar")
                .owners = owners(vec![owner]);

            assert!(manager.session_has_owners("session-a"));
        }
    }

    #[test]
    fn deletion_releases_only_the_exact_tabs_authorized_by_app() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let allowed = HashSet::from(["tab-a".to_string()]);

        assert!(!manager.session_has_unreleasable_owners("session-a", &allowed));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners
            .insert(SidecarOwner::Tab("tab-b".to_string()));
        assert!(manager.session_has_unreleasable_owners("session-a", &allowed));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ]);
        assert!(manager.session_has_unreleasable_owners("session-a", &allowed));
    }

    #[test]
    fn generation_for_requires_current_sidecar_entry() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let generation = manager
            .generation_for("session-a")
            .expect("current generation");

        manager.remove_sidecar("session-a");

        assert_eq!(manager.current_generation("session-a"), generation);
        assert_eq!(manager.generation_for("session-a"), None);
    }
}

pub struct SessionSidecar {
    /// The child process plus exact descendant-containment authority.
    pub(crate) process: ChildTree,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Immutable manager identity injected into `MYAGENTS_SIDECAR_ID` when
    /// this process was spawned. Unlike `session_id`, this does not change
    /// when pending/reset/handover flows rekey the logical Session.
    pub management_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners currently using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Completion identities already consumed by notification delivery for
    /// this exact Sidecar generation. The manager is the only writer; keeping
    /// the set on the generation entry makes teardown reclaim it naturally.
    pub(crate) completion_claims: HashSet<(String, String)>,
    /// Admission fence for control requests bound to this process generation.
    pub(crate) dispatch_gate: Arc<DispatchGate>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
    /// MYAGENTS_RUNTIME env var value this Sidecar was spawned with.
    /// Used for drift detection on Agent-owner reuse: when the agent's
    /// runtime config changes (e.g. codex → gemini), subsequent IM messages
    /// for the same peer session must not reuse a Sidecar that's still
    /// running the old runtime. None = builtin (no env var injected).
    pub runtime: Option<String>,
    /// MYAGENTS_RUNTIME_SOURCE env var value this Sidecar was spawned with.
    /// Missing external runtime source is treated as system-cli.
    pub runtime_source: Option<String>,
}

/// Proof that one completion identity was claimed from the authoritative
/// Sidecar generation. The private field prevents notification callers from
/// bypassing the manager's generation fence.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionCompletionClaim {
    _private: (),
}

impl SessionCompletionClaim {
    pub(super) fn new() -> Self {
        Self { _private: () }
    }
}

impl SessionSidecar {
    /// Is this sidecar healthy and ready to accept requests?
    pub fn is_reusable(&self) -> bool {
        matches!(self.state, SidecarState::Healthy)
    }

    /// Is this sidecar both marked healthy and still alive?
    pub fn is_ready_for_requests(&mut self) -> bool {
        !self.is_dead() && self.is_reusable()
    }

    /// Is this sidecar still starting up? (process alive, `wait_for_health` in progress)
    pub fn is_starting(&self) -> bool {
        matches!(self.state, SidecarState::Starting)
    }

    /// Is this sidecar dead?
    /// Also auto-detects process exit and transitions Starting/Healthy → Dead.
    pub fn is_dead(&mut self) -> bool {
        if self.state == SidecarState::Dead {
            return true;
        }
        // Check if the process actually exited while we thought it was alive
        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.state = SidecarState::Dead;
                true
            }
            Ok(None) => false, // Still running
            Err(_) => {
                self.state = SidecarState::Dead;
                true
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar.
    /// Returns true if the owner was newly inserted, false if it already owned
    /// this Sidecar (symmetric with `remove_owner`). The Starting-join path uses
    /// this to decide whether a later readiness-timeout detach is safe: only the
    /// call that actually added a *new* owner may remove it on timeout. A
    /// same-owner concurrent ensure (e.g. two `ensure_session_sidecar(.., Tab(t))`
    /// for one tab) gets `false` here, so it must NOT remove the shared owner —
    /// doing so would empty the owner set and kill a Sidecar another caller is
    /// still starting.
    pub fn add_owner(&mut self, owner: SidecarOwner) -> bool {
        self.owners.insert(owner)
    }

    /// Remove an owner from this Sidecar.
    /// Returns `(removed, last_owner_removed)` so stale cleanup is a true no-op.
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> (bool, bool) {
        let removed = self.owners.remove(owner);
        (removed, removed && self.owners.is_empty())
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        self.dispatch_gate.close_and_wait();
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id,
            self.port,
            self.state
        );
        let _ = self.process.terminate();
    }
}

/// Single Sidecar instance (legacy - used only for Global Sidecar).
/// Still uses `healthy: bool` since the Global Sidecar is a singleton
/// without the multi-owner race conditions that motivated `SidecarState`.
pub struct SidecarInstance {
    /// The child process plus exact descendant-containment authority.
    pub(crate) process: ChildTree,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
    /// Per-process capability proving a Session DELETE request came from the
    /// Rust lifecycle owner after it fenced every live/durable owner.
    pub session_delete_authority: Option<String>,
    /// Admission fence for control requests bound to this process generation.
    pub(crate) dispatch_gate: Arc<DispatchGate>,
    /// When this instance was created — used by health monitor to apply startup grace period.
    /// During the grace window the monitor skips health checks, preventing false "unhealthy"
    /// verdicts while the sidecar is still initialising (TCP check, Bun startup, Plugin Bridge…).
    pub created_at: std::time::Instant,
}

impl SidecarInstance {
    /// Check if the sidecar process is still running
    /// This actively checks the process rather than just relying on the healthy flag
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }

        // Try to check if process has exited
        match self.process.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                self.healthy = false;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }
}

/// Ensure Node.js process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        self.dispatch_gate.close_and_wait();
        ulog_info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = self.process.terminate();

        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                ulog_info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}
