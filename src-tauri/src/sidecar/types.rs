use super::*;

// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, shared by their live owners.

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
    use std::collections::HashSet;

    fn owners(values: Vec<SidecarOwner>) -> HashSet<SidecarOwner> {
        values.into_iter().collect()
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
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let session_generation = manager.current_generation("session-a");
        assert!(manager.is_live_process("session-a", session_generation));

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
                created_at: std::time::Instant::now(),
            },
        );
        assert!(manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation + 1));

        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
    }

    fn spawn_test_child() -> Child {
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
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child")
    }

    fn insert_test_sidecar(manager: &mut SidecarManager, session_id: &str, state: SidecarState) {
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process: spawn_test_child(),
                port: 31418,
                session_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state,
                owners: owners(vec![SidecarOwner::Tab("tab-a".to_string())]),
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
            .resolve_session_sidecar_url_for_frontend_owner("session-a", &owner)
            .expect_err("an exact hint with the wrong owner must fail closed");

        assert!(error.contains("not owned"));
        assert_eq!(
            manager.resolve_session_sidecar_url_for_frontend_owner("session-b", &owner),
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
            manager.resolve_session_sidecar_url_for_frontend_owner("pending-tab-a", &owner),
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
            manager.resolve_session_sidecar_url_for_frontend_owner("session-new", &owner),
            Ok("http://127.0.0.1:31418".to_string())
        );
        let error = manager
            .resolve_session_sidecar_url_for_frontend_owner("missing-hint", &owner)
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
    fn stale_tab_release_does_not_clear_a_new_tab_activation() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager.activate_session(
            "session-a".to_string(),
            Some("tab-a".to_string()),
            None,
            31418,
            "/tmp/workspace".to_string(),
            false,
        );

        assert!(!manager.release_tab_session("session-a", "stale-tab", false));
        assert_eq!(
            manager
                .session_activations
                .get("session-a")
                .and_then(|activation| activation.tab_id.as_deref()),
            Some("tab-a")
        );
        assert!(manager.session_has_frontend_owner("session-a"));
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
        manager.activate_session(
            "session-a".to_string(),
            Some("tab-a".to_string()),
            None,
            31418,
            "/tmp/workspace".to_string(),
            false,
        );

        assert!(!manager.release_tab_session("session-a", "tab-a", false));
        assert!(manager.session_has_persistent_owners("session-a"));
        assert_eq!(
            manager
                .session_activations
                .get("session-a")
                .and_then(|activation| activation.tab_id.as_deref()),
            None
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
        let recovering = manager.remove_sidecar("recovering").expect("dead sidecar");
        manager
            .recovering_sidecars
            .insert("recovering".to_string(), recovering);

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
        manager.activate_session(
            "session-a".to_string(),
            None,
            None,
            31418,
            "/tmp/workspace".to_string(),
            false,
        );

        assert_eq!(
            manager.remove_session_owner("session-a", &SidecarOwner::Goal("goal-a".to_string())),
            (true, true)
        );
        assert!(!manager.sidecars.contains_key("session-a"));
        assert!(!manager.session_activations.contains_key("session-a"));
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
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .insert(SidecarOwner::Goal("goal-a".to_string()));
        let dead = manager.remove_sidecar("session-a").expect("dead sidecar");
        manager
            .recovering_sidecars
            .insert("session-a".to_string(), dead);

        // The monitor's replacement initially owns only the owner chosen to
        // start it; the retained dead object still carries every owner.
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);
        assert_eq!(
            manager.remove_session_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),),
            (true, false),
        );
        assert!(manager.sidecars.contains_key("session-a"));
        assert!(manager.session_has_persistent_owners("session-a"));

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
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners currently using this Sidecar
    pub owners: HashSet<SidecarOwner>,
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
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id,
            self.port,
            self.state
        );
        let _ = kill_process(&mut self.process);
    }
}

/// Single Sidecar instance (legacy - used only for Global Sidecar).
/// Still uses `healthy: bool` since the Global Sidecar is a singleton
/// without the multi-owner race conditions that motivated `SidecarState`.
pub struct SidecarInstance {
    /// The child process handle
    pub process: Child,
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
        ulog_info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = kill_process(&mut self.process);

        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                ulog_info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Session activation record
/// Tracks which Sidecar is currently "activating" a Session
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionActivation {
    /// Session ID being activated
    pub session_id: String,
    /// Tab ID that owns this activation (None for headless cron tasks)
    pub tab_id: Option<String>,
    /// Cron task ID if activated by cron task
    pub task_id: Option<String>,
    /// Port of the Sidecar handling this session
    pub port: u16,
    /// Workspace path
    pub workspace_path: String,
    /// Whether this is a cron task activation
    pub is_cron_task: bool,
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
