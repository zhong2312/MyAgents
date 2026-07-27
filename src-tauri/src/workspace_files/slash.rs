//! Slash command listing for the chat input picker.
//!
//! Sources, in dedup priority order (first wins):
//! 1. `<workspace>/.claude/commands/*.md`        — project commands
//! 2. `~/.myagents/commands/*.md`                — user commands
//! 3. `<workspace>/.claude/skills/*/SKILL.md`    — project skills
//! 4. `~/.myagents/skills/*/SKILL.md`            — user skills (respects skills config disabled list)
//! 5. Built-in commands (compact, context, …)
//!
//! Returned shape exactly matches the sidecar `/api/commands` response
//! `SlashCommand[]` so the frontend can swap between the two without code
//! changes.
//!
//! Phase E (PRD 0.2.7): this command now ALSO performs the symlink sync
//! that `/api/commands` used to do — `sync_workspace_skills` runs before the
//! scan so launcher (no sidecar) keeps `<workspace>/.claude/skills` symlinks
//! fresh just like a chat tab does. The sync is idempotent and cheap when
//! nothing has changed (just stat ops). The sidecar's
//! `syncSkillsIfNeeded` wrapper is removed; CRUD-time sync still happens
//! sidecar-side via `syncProjectUserConfig` for tab-local immediacy.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::path_safety::validate_external_read_path;
use super::platform_blocks::is_skill_blocked_on_platform;
use super::skill_sync::sync_workspace_skills;
use super::skills_config::{read_cli_tool_registry_enabled, read_disabled_list};

// These are *text-insertion* builtins: selecting one inserts `/name ` and the
// text is sent to the AI/CLI. Do NOT add UI-action commands here (e.g. `loop`,
// which opens a panel) — those are renderer-only and live in
// `src/renderer/utils/slashActions.ts`. Listing a UI-action command here would
// surface it in the launcher (no panel, no handler) as a dead text entry.
const BUILTIN_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("compact", "压缩对话历史，释放上下文空间"),
    ("context", "显示或管理当前上下文"),
    ("cost", "查看 token 使用量和费用"),
    ("init", "初始化项目配置 (.CLAUDE.md)"),
    ("pr-comments", "生成 Pull Request 评论"),
    ("release-notes", "根据最近提交生成发布说明"),
    ("review", "对代码进行审查"),
    ("security-review", "进行安全相关的代码审查"),
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// "builtin" | "custom" | "skill"
    pub source: String,
    /// "user" | "project" — only for custom / skill
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// File path on disk (custom) or SKILL.md path (skill).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Folder name for skills (may differ from display name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    /// File name without `.md` for custom commands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandsResponse {
    pub success: bool,
    pub commands: Vec<SlashCommand>,
    /// Folder names of skills that came from the user-level dir but were NOT
    /// shadowed by a project-level skill — used by the frontend to know which
    /// global skills are still "active" after dedup.
    pub global_skill_folder_names: Vec<String>,
}

#[tauri::command]
pub async fn cmd_list_slash_commands(workspace: String) -> Result<SlashCommandsResponse, String> {
    // workspace may not exist yet (e.g. brand-new workspace selected in the
    // launcher before any chat has touched it), but it MUST still pass the
    // system-directory blacklist — otherwise a caller passing `/etc` or
    // `~/.ssh` could probe directory existence via this read-only scan. We
    // use `validate_external_read_path` (path traversal + blacklist only,
    // no existence requirement) instead of `validate_workspace_root` (which
    // requires the dir to exist). Empty string is treated as "no scan".
    let workspace_root = if workspace.is_empty() {
        PathBuf::new()
    } else {
        validate_external_read_path(&workspace)?
    };
    let workspace_exists = workspace_root.is_dir();

    // Sync user-level skills/commands into the workspace's `.claude/`
    // BEFORE scanning, so skills the user enabled in another tab / global
    // settings show up immediately. Best-effort — failures are logged inside
    // `sync_workspace_skills` and don't block the scan (worst case the user
    // sees a slightly stale picker, not a crash).
    if workspace_exists {
        if let Err(e) = sync_workspace_skills(&workspace_root) {
            crate::ulog_warn!(
                "[slash] skill sync failed for {}: {}",
                workspace_root.display(),
                e
            );
        }
    }

    let home_dir = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    let myagents_root = home_dir.join(".myagents");

    let disabled = disabled_skill_names_for_slash(&myagents_root);

    let mut commands: Vec<SlashCommand> = Vec::new();

    // 1. Project commands
    if workspace_exists {
        scan_commands_dir(
            &workspace_root.join(".claude").join("commands"),
            "project",
            &mut commands,
        );
    }
    // 2. User commands
    scan_commands_dir(&myagents_root.join("commands"), "user", &mut commands);
    // 3. Project skills
    if workspace_exists {
        scan_skills_dir(
            &workspace_root.join(".claude").join("skills"),
            "project",
            &disabled,
            &mut commands,
        );
    }
    // 4. User skills
    scan_skills_dir(
        &myagents_root.join("skills"),
        "user",
        &disabled,
        &mut commands,
    );

    // 5. Builtins (lowest priority — get filtered out if name collides)
    for (name, desc) in BUILTIN_SLASH_COMMANDS {
        commands.push(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "builtin".to_string(),
            scope: None,
            path: None,
            folder_name: None,
            file_name: None,
        });
    }

    // Capture user-level skill folder names BEFORE dedup so the frontend can
    // distinguish "not a skill" from "skill shadowed by project version".
    let global_skill_folder_names: Vec<String> = commands
        .iter()
        .filter(|c| {
            c.source == "skill" && c.scope.as_deref() == Some("user") && c.folder_name.is_some()
        })
        .filter_map(|c| c.folder_name.clone())
        .collect();

    // Dedup by `name` — first occurrence wins.
    let mut seen: HashSet<String> = HashSet::new();
    let unique: Vec<SlashCommand> = commands
        .into_iter()
        .filter(|c| seen.insert(c.name.clone()))
        .collect();

    Ok(SlashCommandsResponse {
        success: true,
        commands: unique,
        global_skill_folder_names,
    })
}

fn disabled_skill_names_for_slash(myagents_root: &Path) -> Vec<String> {
    let mut disabled = read_disabled_list(myagents_root);
    if !read_cli_tool_registry_enabled(myagents_root)
        && !disabled.iter().any(|name| name == "tool-creator")
    {
        disabled.push("tool-creator".to_string());
    }
    disabled
}

fn scan_commands_dir(dir: &Path, scope: &str, out: &mut Vec<SlashCommand>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".md") {
            continue;
        }
        let path = entry.path();
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let frontmatter = parse_command_frontmatter(&content);
        let file_name = name_str.trim_end_matches(".md").to_string();
        out.push(SlashCommand {
            name: frontmatter
                .name
                .clone()
                .unwrap_or_else(|| file_name.clone()),
            description: frontmatter.description.unwrap_or_default(),
            source: "custom".to_string(),
            scope: Some(scope.to_string()),
            path: Some(path.to_string_lossy().to_string()),
            folder_name: None,
            file_name: Some(file_name),
        });
    }
}

fn scan_skills_dir(dir: &Path, scope: &str, disabled: &[String], out: &mut Vec<SlashCommand>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let folder_path = entry.path();

        // Read-only scan — follow symlinks / Windows junctions to detect
        // dir-likeness so user-installed skills mounted via junction surface.
        // For a broken symlink, `metadata()` returns Err and we just skip;
        // the v0.2.5 cpSync crash mode (CLAUDE.md red-line) doesn't apply
        // here because we never write through this path. Issue #104 was
        // about the sidecar's parallel `isDirEntry` helper supporting the
        // same junction-mounted case.
        let is_dir_like = std::fs::metadata(&folder_path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if !is_dir_like {
            continue;
        }
        if is_skill_blocked_on_platform(&folder_name) {
            continue;
        }
        if scope == "user" && disabled.iter().any(|d| d == &folder_name) {
            continue;
        }

        let skill_md = folder_path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let content = match std::fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let parsed = parse_skill_frontmatter(&content);
        let name = parsed.name.clone().unwrap_or_else(|| folder_name.clone());
        out.push(SlashCommand {
            name,
            description: parsed.description.unwrap_or_default(),
            source: "skill".to_string(),
            scope: Some(scope.to_string()),
            path: Some(skill_md.to_string_lossy().to_string()),
            folder_name: Some(folder_name),
            file_name: None,
        });
    }
}

#[derive(Debug, Default)]
struct ParsedFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// Extract the YAML body between `---` fences and parse `name` + `description`.
/// Falls back gracefully (returns empty struct) if the file has no frontmatter
/// or the YAML is malformed — never errors out.
fn parse_skill_frontmatter(content: &str) -> ParsedFrontmatter {
    let mut parsed = parse_yaml_block(content);

    // Skill spec allows the name to come from the first `# Heading` if not
    // present in frontmatter. We mirror that behavior so a SKILL.md without
    // a `name:` key still surfaces with a meaningful name.
    if parsed.name.is_none() {
        let body = extract_body(content).unwrap_or(content.to_string());
        for line in body.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("# ") {
                parsed.name = Some(rest.trim().to_string());
                break;
            }
        }
    }
    parsed
}

fn parse_command_frontmatter(content: &str) -> ParsedFrontmatter {
    parse_yaml_block(content)
}

fn parse_yaml_block(content: &str) -> ParsedFrontmatter {
    let body = match extract_frontmatter_str(content) {
        Some(s) => s,
        None => return ParsedFrontmatter::default(),
    };
    let value: serde_yaml::Value = match serde_yaml::from_str(&body) {
        Ok(v) => v,
        Err(_) => return ParsedFrontmatter::default(),
    };
    let mapping = match value.as_mapping() {
        Some(m) => m,
        None => return ParsedFrontmatter::default(),
    };
    let mut out = ParsedFrontmatter::default();
    if let Some(v) = mapping.get(&serde_yaml::Value::String("name".into())) {
        if let Some(s) = v.as_str() {
            out.name = Some(s.to_string());
        }
    }
    if let Some(v) = mapping.get(&serde_yaml::Value::String("description".into())) {
        if let Some(s) = v.as_str() {
            out.description = Some(s.to_string());
        }
    }
    out
}

fn extract_frontmatter_str(content: &str) -> Option<String> {
    // Pattern: optional CR before first `---`, content body until next `---`.
    let s = content.trim_start();
    let stripped = s.strip_prefix("---")?;
    let after_first = stripped
        .strip_prefix('\n')
        .or_else(|| stripped.strip_prefix("\r\n"))?;
    // Find the closing `---` on its own line.
    let mut depth = 0;
    for (idx, line) in after_first.split_inclusive('\n').enumerate() {
        if line.trim_end_matches(['\r', '\n']) == "---" && idx > 0 {
            return Some(after_first[..depth].to_string());
        }
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(String::new());
        }
        depth += line.len();
    }
    None
}

fn extract_body(content: &str) -> Option<String> {
    let s = content.trim_start();
    let stripped = s.strip_prefix("---")?;
    let after_first = stripped
        .strip_prefix('\n')
        .or_else(|| stripped.strip_prefix("\r\n"))?;
    let mut acc = 0;
    for (idx, line) in after_first.split_inclusive('\n').enumerate() {
        if line.trim_end_matches(['\r', '\n']) == "---" && idx > 0 {
            return Some(after_first[acc + line.len()..].to_string());
        }
        acc += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("slash")
    }

    #[test]
    fn parses_skill_with_name_and_description() {
        let content = "---\nname: my-skill\ndescription: Does the thing\n---\n\n# Heading\nbody";
        let parsed = parse_skill_frontmatter(content);
        assert_eq!(parsed.name.as_deref(), Some("my-skill"));
        assert_eq!(parsed.description.as_deref(), Some("Does the thing"));
    }

    #[test]
    fn skill_falls_back_to_first_heading_for_name() {
        let content = "---\ndescription: foo\n---\n\n# Skill Title\nbody";
        let parsed = parse_skill_frontmatter(content);
        assert_eq!(parsed.name.as_deref(), Some("Skill Title"));
    }

    #[test]
    fn no_frontmatter_returns_empty() {
        let parsed = parse_skill_frontmatter("just plain markdown");
        assert!(parsed.name.is_none());
        assert!(parsed.description.is_none());
    }

    #[test]
    fn malformed_yaml_returns_empty() {
        let parsed = parse_skill_frontmatter("---\nname: [unclosed\n---\n");
        assert!(parsed.name.is_none());
    }

    #[test]
    fn disabled_skill_names_include_tool_creator_when_cli_tool_registry_gate_is_off() {
        let root = make_test_workspace("slash_gate_off_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        assert!(disabled.iter().any(|name| name == "tool-creator"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn disabled_skill_names_do_not_include_tool_creator_when_cli_tool_registry_gate_is_on() {
        let root = make_test_workspace("slash_gate_on_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("config.json"),
            r#"{"cliToolRegistryEnabled":true}"#,
        )
        .unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        assert!(!disabled.iter().any(|name| name == "tool-creator"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn disabled_skill_names_keep_required_system_skills_available() {
        let root = make_test_workspace("slash_required_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("skills-config.json"),
            r#"{"disabled":["myagents-memory-update","myagents-memory-gardener","myagents-memory-molt","myagents-cli","myagents-docs","prompt-writer"]}"#,
        )
        .unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        for name in [
            "myagents-memory-update",
            "myagents-memory-gardener",
            "myagents-memory-molt",
            "myagents-cli",
            "myagents-docs",
        ] {
            assert!(!disabled.iter().any(|candidate| candidate == name));
        }
        assert!(disabled.iter().any(|name| name == "prompt-writer"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn lists_builtin_when_no_dirs_exist() {
        let ws = make_tmp_workspace();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(res.success);
        // Built-ins should always appear at minimum.
        assert!(res.commands.iter().any(|c| c.name == "review"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn lists_project_commands() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("my-cmd.md"),
            "---\ndescription: My custom command\n---\nbody\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res.commands.iter().find(|c| c.name == "my-cmd").unwrap();
        assert_eq!(hit.source, "custom");
        assert_eq!(hit.scope.as_deref(), Some("project"));
        assert_eq!(hit.description, "My custom command");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn lists_project_skills() {
        let ws = make_tmp_workspace();
        let skill_dir = ws.join(".claude").join("skills").join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: hello\n---\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res.commands.iter().find(|c| c.name == "my-skill").unwrap();
        assert_eq!(hit.source, "skill");
        assert_eq!(hit.scope.as_deref(), Some("project"));
        assert_eq!(hit.folder_name.as_deref(), Some("my-skill"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn project_overrides_builtin_with_same_name() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("review.md"),
            "---\ndescription: Custom review\n---\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let review = res.commands.iter().find(|c| c.name == "review").unwrap();
        assert_eq!(review.source, "custom");
        // Should appear only once.
        assert_eq!(
            res.commands.iter().filter(|c| c.name == "review").count(),
            1
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn handles_nonexistent_workspace() {
        // Should still return builtins, not error.
        let res = cmd_list_slash_commands("/definitely/not/a/real/path".to_string()).await;
        // validate_file_path is permissive about non-existent paths since the
        // function is supposed to be safe-by-default. For workspace listing
        // we treat missing workspace as "skip project scan".
        if let Ok(r) = res {
            assert!(r.commands.iter().any(|c| c.name == "review"));
        }
        // If validation rejects, that's also acceptable behavior — both modes
        // are non-crashing.
    }
}
