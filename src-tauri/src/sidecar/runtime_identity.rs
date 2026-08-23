use super::*;

// ─── Agent Runtime resolution (v0.1.59) ───

// BOM-stripping moved to crate::utils::bom (issue #170 #6) so all JSON-
// reading sites share a single helper.
use crate::utils::bom::strip_bom;

const CODEX_SUBSCRIPTION_PROVIDER_ID: &str = "codex-sub";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub runtime: String,
    pub runtime_source: Option<String>,
}

impl RuntimeIdentity {
    pub fn new(runtime: Option<&str>, runtime_source: Option<&str>) -> Self {
        // managed-provider is the product-owned Codex runtime source. Older
        // metadata may contain the impossible builtin/managed-provider pair;
        // canonicalize before any spawn/reuse decision reads it.
        let runtime = if runtime_source == Some("managed-provider") {
            "codex".to_string()
        } else {
            normalize_runtime_name(runtime).to_string()
        };
        let normalized_source = normalize_runtime_source_name(&runtime, runtime_source);
        Self {
            runtime,
            runtime_source: if normalized_source == "builtin" {
                None
            } else {
                Some(normalized_source.to_string())
            },
        }
    }

    pub fn runtime_for_env(&self) -> Option<&str> {
        if self.runtime == "builtin" {
            None
        } else {
            Some(self.runtime.as_str())
        }
    }

    pub fn runtime_source_for_env(&self) -> Option<&str> {
        self.runtime_for_env()?;
        Some(self.runtime_source.as_deref().unwrap_or("system-cli"))
    }

    pub fn runtime_source_label(&self) -> &str {
        normalize_runtime_source_name(&self.runtime, self.runtime_source.as_deref())
    }
}

/// Look up the `runtime` field from the agent config in ~/.myagents/config.json
/// matching the given workspace path. Returns None for "builtin" (the default).
/// Used for NEW sessions (the agent config decides the default runtime for new conversations)
/// and for IM/Agent sidecar paths that don't have a session_id yet.
pub(crate) fn resolve_agent_runtime_identity_from_config(
    workspace_path: &std::path::Path,
) -> Option<RuntimeIdentity> {
    let config_dir = dirs::home_dir()?.join(".myagents");
    let config_path = config_dir.join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;
    let projects_content = std::fs::read_to_string(config_dir.join("projects.json")).ok()?;
    let projects: serde_json::Value = serde_json::from_str(strip_bom(&projects_content)).ok()?;
    resolve_agent_runtime_identity_from_values(&cfg, &projects, workspace_path)
}

pub(crate) fn resolve_agent_runtime_identity_by_id_from_config(
    agent_id: &str,
) -> Option<RuntimeIdentity> {
    let config_path = dirs::home_dir()?.join(".myagents").join("config.json");
    let content = std::fs::read_to_string(config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;
    resolve_agent_runtime_identity_by_id_from_value(&cfg, agent_id)
}

fn resolve_agent_runtime_identity_from_values(
    cfg: &serde_json::Value,
    projects: &serde_json::Value,
    workspace_path: &std::path::Path,
) -> Option<RuntimeIdentity> {
    let matching_projects = projects
        .as_array()?
        .iter()
        .filter(|project| {
            project
                .get("path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|path| workspace_paths_match(path, workspace_path))
        })
        .collect::<Vec<_>>();
    if matching_projects.len() != 1 {
        return None;
    }
    let agent_id = matching_projects[0].get("agentId")?.as_str()?;
    let claim_count = projects
        .as_array()?
        .iter()
        .filter(|project| {
            project.get("agentId").and_then(serde_json::Value::as_str) == Some(agent_id)
        })
        .count();
    if claim_count != 1 {
        return None;
    }

    resolve_agent_runtime_identity_by_id_from_value(cfg, agent_id)
        .filter(|identity| identity.runtime != "builtin")
}

fn resolve_agent_runtime_identity_by_id_from_value(
    cfg: &serde_json::Value,
    agent_id: &str,
) -> Option<RuntimeIdentity> {
    let agent = cfg
        .get("agents")?
        .as_array()?
        .iter()
        .find(|agent| agent.get("id").and_then(serde_json::Value::as_str) == Some(agent_id))?;
    let runtime = agent
        .get("runtime")
        .and_then(|value| value.as_str())
        .unwrap_or("builtin");
    let runtime_source = agent
        .get("runtimeConfig")
        .and_then(|value| value.as_object())
        .and_then(|config| config.get("source"))
        .and_then(|value| value.as_str());
    let managed_codex_selected = agent.get("providerId").and_then(|value| value.as_str())
        == Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
        && (runtime == "builtin"
            || (runtime == "codex" && runtime_source == Some("managed-provider")));
    if managed_codex_selected {
        return Some(if managed_codex_provider_ready(cfg) {
            RuntimeIdentity::new(Some("codex"), Some("managed-provider"))
        } else {
            RuntimeIdentity::new(Some("builtin"), None)
        });
    }
    // Gate: multi-agent runtime feature must be explicitly enabled
    // for user-managed external runtimes. Managed Codex provider
    // is gated above by its own provider readiness flags instead.
    if !cfg
        .get("multiAgentRuntime")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Some(RuntimeIdentity::new(Some("builtin"), None));
    }
    if runtime != "builtin" {
        // Only the readable legacy Managed Codex shape may retain this source.
        // Other explicit runtimes win over dormant provider/source fields,
        // matching the renderer/server Agent-template projection.
        let explicit_runtime_source = runtime_source.filter(|source| *source != "managed-provider");
        return Some(RuntimeIdentity::new(Some(runtime), explicit_runtime_source));
    }
    Some(RuntimeIdentity::new(Some("builtin"), None))
}

pub(super) fn resolve_agent_runtime_from_config(
    workspace_path: &std::path::Path,
) -> Option<String> {
    resolve_agent_runtime_identity_from_config(workspace_path).map(|identity| identity.runtime)
}

fn managed_codex_provider_ready(cfg: &serde_json::Value) -> bool {
    let install = cfg.get("managedCodexRuntimeInstall");
    let auth = cfg.get("managedCodexAuth");
    let runtime_usable = install
        .and_then(|value| value.get("usable"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let provider_disabled = cfg
        .get("disabledProviderIds")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .any(|id| id.as_str() == Some(CODEX_SUBSCRIPTION_PROVIDER_ID))
        })
        .unwrap_or(false);
    cfg.get("managedCodexProviderDevGate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !provider_disabled
        && runtime_usable
        && auth.and_then(|v| v.get("status")).and_then(|v| v.as_str()) == Some("valid")
        && matches!(
            auth.and_then(|v| v.get("authMethod"))
                .and_then(|v| v.as_str()),
            Some("chatgpt") | Some("access-token")
        )
}

fn workspace_paths_match(agent_path: &str, workspace_path: &std::path::Path) -> bool {
    crate::workspace_path::workspace_paths_equal(agent_path, &workspace_path.to_string_lossy())
}

/// Look up the `runtime` field from session metadata in ~/.myagents/sessions.json.
/// Returns Some("builtin") for builtin/missing-runtime sessions that are found,
/// and None only when no authoritative session metadata is available.
///
/// This is the authoritative source for EXISTING sessions — the session's own metadata
/// records which runtime created it, regardless of the current agent config.
/// Agent config (resolve_agent_runtime_from_config) decides the default for NEW sessions
/// and is gated by `multiAgentRuntime`; session metadata is stable once created and is
/// read regardless of that gate so an existing runtime-A history is never reopened as
/// runtime B under the same MyAgents session_id.
#[allow(dead_code)]
pub fn resolve_session_runtime_identity(session_id: &str) -> Option<String> {
    resolve_session_runtime_identity_full(session_id).map(|identity| identity.runtime)
}

pub fn resolve_session_runtime_identity_full(session_id: &str) -> Option<RuntimeIdentity> {
    let sessions_path = crate::app_dirs::myagents_data_dir()?.join("sessions.json");
    let content = std::fs::read_to_string(&sessions_path).ok()?;
    resolve_session_runtime_identity_full_from_json(session_id, &content)
}

#[cfg(test)]
pub(super) fn resolve_session_runtime_identity_from_json(
    session_id: &str,
    content: &str,
) -> Option<String> {
    resolve_session_runtime_identity_full_from_json(session_id, content)
        .map(|identity| identity.runtime)
}

pub(super) fn resolve_session_runtime_identity_full_from_json(
    session_id: &str,
    content: &str,
) -> Option<RuntimeIdentity> {
    let sessions: serde_json::Value = serde_json::from_str(strip_bom(content)).ok()?;
    let sessions_arr = sessions.as_array()?;

    for session in sessions_arr {
        if session.get("id").and_then(|v| v.as_str()) == Some(session_id) {
            return Some(RuntimeIdentity::new(
                session.get("runtime").and_then(|v| v.as_str()),
                session.get("runtimeSource").and_then(|v| v.as_str()),
            ));
        }
    }
    None
}

fn session_matches_restore_target(
    session: &serde_json::Value,
    session_id: &str,
    agent_dir: &str,
) -> bool {
    session.get("id").and_then(|value| value.as_str()) == Some(session_id)
        && session
            .get("agentDir")
            .and_then(|value| value.as_str())
            .is_some_and(|stored| workspace_paths_match(stored, std::path::Path::new(agent_dir)))
}

/// Lazy validation for tab restore (Issue #232 / PRD 0.2.25).
///
/// A restored "cold" chat tab is only activatable if (a) its session still
/// exists in `~/.myagents/sessions.json` and (b) its workspace directory still
/// exists on disk. This is read-only and reads the disk directly — it does NOT
/// depend on the global sidecar being up (which is async + flaky on startup),
/// matching the PRD's "validate lazily at first activation, decoupled from
/// global sidecar readiness" decision.
///
/// Returns false (drop the tab) on any miss: deleted session, moved/deleted
/// workspace, or unreadable index.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_can_restore_session(sessionId: String, agentDir: String) -> bool {
    // Validate the workspace through the project's canonical chokepoint
    // (system blacklist + must be an existing directory), same as every other
    // workspace command — NOT a bare `is_dir()`, which would accept relative /
    // credential / system paths. Catches moved/deleted workspaces that would
    // otherwise become a cold-start sidecar-spawn failure on click.
    if crate::workspace_files::path_safety::validate_workspace_root(&agentDir).is_err() {
        return false;
    }
    let Some(sessions_path) =
        crate::app_dirs::myagents_data_dir().map(|dir| dir.join("sessions.json"))
    else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(&sessions_path) else {
        return false;
    };
    let Ok(sessions) = serde_json::from_str::<serde_json::Value>(strip_bom(&content)) else {
        return false;
    };
    let Some(arr) = sessions.as_array() else {
        return false;
    };
    // The session must exist AND belong to this workspace. Session metadata and
    // the active Project can legitimately persist different Windows separator,
    // case, or trailing-slash forms, so use the same canonical identity as the
    // history-list query instead of a raw string comparison.
    arr.iter()
        .any(|session| session_matches_restore_target(session, &sessionId, &agentDir))
}

/// v0.1.69 T13: Runtime invariant check on Sidecar reuse.
///
/// The expected identity is resolved once per ensure attempt from the
/// owner-aware priority chain. For an existing Session that includes immutable
/// Session metadata; for a metadata creator it uses the requested override or
/// Agent default. Reuse and spawn MUST consume that same identity snapshot.
///
/// If we detect a mismatch on a reuse path, it indicates either:
///   (a) T12's new-tab gate missed a case
///   (b) Session metadata was mutated post-creation (shouldn't happen)
///   (c) Two sessions with different runtimes ended up sharing a sidecar entry
///
/// We log loudly with `[sidecar][runtime-drift-on-reuse]` and return an error
/// to the reuse path. For runtimeSource-aware Codex, reusing the wrong source
/// means using the wrong binary, CODEX_HOME, and auth owner, so the correct
/// recovery is to reject reuse and let ensure create a fresh sidecar for the
/// session identity.
pub(super) fn validate_sidecar_runtime_invariant(
    session_id: &str,
    expected_identity: &RuntimeIdentity,
    sidecar_runtime: Option<&str>,
    sidecar_runtime_source: Option<&str>,
    site: &str,
) -> Result<(), String> {
    let sidecar_rt = normalize_runtime_name(sidecar_runtime);
    let sidecar_source = normalize_runtime_source_name(sidecar_rt, sidecar_runtime_source);
    let expected_runtime = expected_identity.runtime.as_str();
    let expected_source = expected_identity.runtime_source_label();
    if sidecar_rt != expected_runtime || sidecar_source != expected_source {
        let message = format!(
            "session={} site={} sidecar_runtime={} sidecar_runtime_source={} expected_runtime={} expected_runtime_source={}",
            session_id, site, sidecar_rt, sidecar_source, expected_runtime, expected_source
        );
        ulog_error!(
            "[sidecar][runtime-drift-on-reuse] {} — rejecting reuse",
            message
        );
        return Err(message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_codex_provider_ready_requires_explicit_gate_install_and_chatgpt_auth() {
        let missing_gate = serde_json::json!({
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "usable": true,
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&missing_gate));

        let ready = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "usable": true,
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(managed_codex_provider_ready(&ready));

        let stale_but_usable = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "downloading",
                "usable": true,
                "installedVersion": "0.0.0-previous"
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(managed_codex_provider_ready(&stale_but_usable));

        let gate_off = serde_json::json!({
            "managedCodexProviderDevGate": false,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&gate_off));

        let api_key_auth = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "api-key"
            }
        });
        assert!(!managed_codex_provider_ready(&api_key_auth));

        let disabled = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "disabledProviderIds": [CODEX_SUBSCRIPTION_PROVIDER_ID],
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&disabled));
    }

    #[test]
    fn workspace_path_match_reuses_canonical_workspace_identity() {
        assert!(workspace_paths_match(
            r"C:\Users\me\Project\",
            std::path::Path::new("C:/Users/me/Project")
        ));
        assert!(workspace_paths_match(
            r"\\Server\Share\Project\",
            std::path::Path::new("//server/share/project")
        ));
        assert!(!workspace_paths_match(
            r"/tmp/a\b",
            std::path::Path::new("/tmp/a/b")
        ));
    }

    #[test]
    fn restore_target_match_reuses_canonical_workspace_identity() {
        let session = serde_json::json!({
            "id": "session-1",
            "agentDir": r"F:\\workspace\\小说\\DSXX\\"
        });

        assert!(session_matches_restore_target(
            &session,
            "session-1",
            "f:/workspace/小说/DSXX"
        ));
        assert!(!session_matches_restore_target(
            &session,
            "session-2",
            "F:/workspace/小说/DSXX"
        ));
        assert!(!session_matches_restore_target(
            &session,
            "session-1",
            "F:/workspace/小说/OTHER"
        ));
    }

    #[test]
    fn project_agent_id_selects_runtime_even_when_legacy_agent_path_disagrees() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "agents": [
                { "id": "extra", "workspacePath": "/repo/current", "runtime": "gemini" },
                { "id": "selected", "workspacePath": "/repo/old", "runtime": "codex" }
            ]
        });
        let projects = serde_json::json!([
            { "id": "project", "path": "/repo/current", "agentId": "selected" }
        ]);
        let identity = resolve_agent_runtime_identity_from_values(
            &config,
            &projects,
            std::path::Path::new("/repo/current"),
        )
        .expect("Project.agentId should select the Agent config");
        assert_eq!(identity.runtime, "codex");
    }

    #[test]
    fn exact_agent_id_selects_extra_or_orphan_runtime_without_project_guessing() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "agents": [
                { "id": "project-agent", "runtime": "gemini" },
                { "id": "extra", "workspacePath": "/repo/current", "runtime": "codex" },
                { "id": "orphan", "workspacePath": "/repo/orphan", "runtime": "claude-code" }
            ]
        });

        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "extra")
                .expect("extra Agent runtime")
                .runtime,
            "codex"
        );
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "orphan")
                .expect("orphan Agent runtime")
                .runtime,
            "claude-code"
        );
    }

    #[test]
    fn exact_builtin_agent_id_overrides_another_agents_external_workspace_runtime() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "agents": [
                { "id": "project-agent", "runtime": "codex" },
                { "id": "extra-builtin", "workspacePath": "/repo/current", "runtime": "builtin" }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "extra-builtin")
            .expect("exact builtin identity must remain explicit");
        assert_eq!(identity.runtime, "builtin");
        assert_eq!(identity.runtime_source, None);
    }

    #[test]
    fn managed_codex_provider_only_owns_managed_compatible_agent_shapes() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            },
            "agents": [
                { "id": "current", "runtime": "builtin", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                {
                    "id": "legacy",
                    "runtime": "codex",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                },
                { "id": "system-codex", "runtime": "codex", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                { "id": "claude-code", "runtime": "claude-code", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                {
                    "id": "gemini",
                    "runtime": "gemini",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                },
                { "id": "ordinary-provider", "runtime": "gemini", "providerId": "anthropic-api" }
            ]
        });

        for agent_id in ["current", "legacy"] {
            let identity = resolve_agent_runtime_identity_by_id_from_value(&config, agent_id)
                .expect("managed Agent identity");
            assert_eq!(identity.runtime, "codex");
            assert_eq!(identity.runtime_source.as_deref(), Some("managed-provider"));
        }

        for (agent_id, expected_runtime) in [
            ("system-codex", "codex"),
            ("claude-code", "claude-code"),
            ("gemini", "gemini"),
            ("ordinary-provider", "gemini"),
        ] {
            let identity = resolve_agent_runtime_identity_by_id_from_value(&config, agent_id)
                .expect("explicit external Agent identity");
            assert_eq!(identity.runtime, expected_runtime);
            assert_eq!(identity.runtime_source.as_deref(), Some("system-cli"));
        }
    }

    #[test]
    fn dormant_managed_provider_does_not_bypass_external_runtime_gate() {
        let config = serde_json::json!({
            "multiAgentRuntime": false,
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            },
            "agents": [
                { "id": "gemini", "runtime": "gemini", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "gemini")
            .expect("feature gate fallback identity");
        assert_eq!(identity.runtime, "builtin");
        assert_eq!(identity.runtime_source, None);
    }

    #[test]
    fn legacy_managed_codex_shape_does_not_bypass_provider_readiness() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "invalid",
                "authMethod": "chatgpt"
            },
            "agents": [
                {
                    "id": "legacy",
                    "runtime": "codex",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "legacy")
            .expect("unready managed provider fallback identity");
        assert_eq!(identity.runtime, "builtin");
        assert_eq!(identity.runtime_source, None);
    }

    #[test]
    fn duplicate_project_claim_is_target_local_failure() {
        let config = serde_json::json!({
            "multiAgentRuntime": true,
            "agents": [{ "id": "selected", "runtime": "codex" }]
        });
        let projects = serde_json::json!([
            { "id": "a", "path": "/repo/a", "agentId": "selected" },
            { "id": "b", "path": "/repo/b", "agentId": "selected" }
        ]);
        assert!(resolve_agent_runtime_identity_from_values(
            &config,
            &projects,
            std::path::Path::new("/repo/a"),
        )
        .is_none());
    }
}
