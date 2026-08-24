//! Read-only access to `~/.myagents/skills-config.json`.
//!
//! Used by the no-Sidecar Launcher picker. Project-level capability selection
//! is intentionally not interpreted in Rust; Runtime admission is Node-owned.
//!
//! Schema parity with sidecar `interface SkillsConfig`. We only deserialize
//! `disabled` because nothing else is needed at the Rust callsites today;
//! `seeded` and `generation` are owned by the sidecar's seeding/generation
//! optimization paths.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::utils::bom::strip_bom;

#[derive(Debug, Default, Deserialize)]
struct SkillsConfig {
    #[serde(default)]
    disabled: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct AppConfigGate {
    #[serde(default, rename = "cliToolRegistryEnabled")]
    cli_tool_registry_enabled: bool,
}

/// Read the user's disabled-skill list from `~/.myagents/skills-config.json`.
/// Returns an empty list if the file is missing, unreadable, or malformed —
/// safe default lets the caller continue without disabling anything.
pub fn read_disabled_list(myagents_root: &Path) -> Vec<String> {
    let path = myagents_root.join("skills-config.json");
    if !path.is_file() {
        return Vec::new();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<SkillsConfig>(&content)
            .map(|c| {
                c.disabled
                    .into_iter()
                    .filter(|name| !is_required_system_skill(name))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Product-owned runtime contracts that must remain enabled across every
/// MyAgents surface. Keep in sync with `src/shared/systemSkills.ts`.
pub const REQUIRED_SYSTEM_SKILLS: &[&str] = &[
    "task-alignment",
    "task-implement",
    "myagents-memory-update",
    "myagents-memory-gardener",
    "myagents-memory-molt",
    "myagents-cli",
    "myagents-anydoc",
    "myagents-task-automation",
    "myagents-docs",
];

pub fn is_required_system_skill(name: &str) -> bool {
    REQUIRED_SYSTEM_SKILLS.contains(&name)
}

/// Read the experimental user-registered CLI tool registry gate from
/// `~/.myagents/config.json`. Omitted/malformed/unreadable means disabled,
/// matching the TypeScript `isCliToolRegistryEnabled()` helper.
pub fn read_cli_tool_registry_enabled(myagents_root: &Path) -> bool {
    let path = myagents_root.join("config.json");
    if !path.is_file() {
        return false;
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<AppConfigGate>(strip_bom(&content))
            .map(|c| c.cli_tool_registry_enabled)
            .unwrap_or(false),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_system_skills_are_not_reported_as_disabled() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(
            root.path().join("skills-config.json"),
            r#"{"disabled":["task-alignment","task-implement","myagents-memory-update","myagents-memory-gardener","myagents-memory-molt","myagents-cli","myagents-task-automation","myagents-docs","ordinary-skill"]}"#,
        )
        .expect("write skills config");

        assert_eq!(
            read_disabled_list(root.path()),
            vec!["ordinary-skill".to_string()]
        );
        for name in REQUIRED_SYSTEM_SKILLS {
            assert!(is_required_system_skill(name));
        }
        assert!(!is_required_system_skill("prompt-writer"));
    }

    #[test]
    fn rust_and_typescript_required_system_skill_lists_match() {
        let shared = include_str!("../../../src/shared/systemSkills.ts");
        let body = shared
            .split_once("export const REQUIRED_SYSTEM_SKILLS = [")
            .expect("TypeScript required system skill declaration")
            .1
            .split_once("] as const;")
            .expect("TypeScript required system skill terminator")
            .0;
        let typescript_skills: Vec<&str> = body
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix('\'')?;
                rest.split_once('\'').map(|(name, _)| name)
            })
            .collect();

        assert_eq!(typescript_skills, REQUIRED_SYSTEM_SKILLS);
    }
}
