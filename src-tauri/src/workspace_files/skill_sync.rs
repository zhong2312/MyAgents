//! Symlink user-level skills/commands into a project's `.claude/` so the
//! Claude Agent SDK (which only looks under `<workspace>/.claude/skills/`)
//! can find them at runtime.
//!
//! Port of `src/server/agent-session.ts::syncProjectUserConfig`. The Rust
//! version is the source-of-truth going forward — Phase E removes the
//! sidecar's wrapper (`syncSkillsIfNeeded`) and the `cmd_list_slash_commands`
//! path now calls this directly so the Launcher (no sidecar) keeps symlinks
//! fresh too.
//!
//! # Invariants
//!
//! 1. We NEVER write through real (non-symlink) project skill/command paths.
//!    A user that hand-creates `<workspace>/.claude/skills/foo/` keeps it.
//! 2. We only DELETE project-side entries that are symlinks pointing into
//!    `~/.myagents/skills` (resp. `~/.myagents/commands`). Anything else
//!    is treated as user-owned and left alone.
//! 3. We use `fs::symlink_metadata` (NOT `fs::metadata`) for every existence
//!    probe — broken symlinks must register as occupied (CLAUDE.md v0.2.5
//!    red-line: `Path::exists()` follows symlinks and returns false for
//!    broken links → caller proceeds into write op → confusing failure).
//! 4. Windows: directory links use `junction::create` (NTFS junction — works
//!    without admin / Developer Mode, mirrors the sidecar's
//!    `symlinkSync(target, link, 'junction')`). File links use
//!    `std::os::windows::fs::symlink_file`, which DOES require Developer
//!    Mode; the sync logs a warning and skips the file if the symlink fails
//!    rather than abort the whole batch.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use crate::{ulog_debug, ulog_warn};

use super::platform_blocks::is_skill_blocked_on_platform;
use super::skills_config::{read_cli_tool_registry_enabled, read_disabled_list};

/// Idempotent: symlink user-level skills + commands into `<workspace>/.claude/`.
///
/// Returns `Ok(())` even if individual symlinks fail (logs a warning and
/// continues) — best-effort matches the sidecar's policy. Hard errors
/// (workspace not a dir, can't read user dir) propagate.
pub fn sync_workspace_skills(workspace: &Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    sync_workspace_skills_with_home(workspace, &home)
}

/// Internals: take the home dir explicitly so tests can inject a tempdir
/// without mutating the process-global `HOME` env var (which poisons other
/// tests running in parallel — cargo test isn't single-threaded by default).
fn sync_workspace_skills_with_home(workspace: &Path, home: &Path) -> Result<(), String> {
    if !workspace.is_dir() {
        return Err(format!(
            "workspace {} is not a directory",
            workspace.display()
        ));
    }
    let myagents_root = home.join(".myagents");
    sync_skills_subtree(workspace, &myagents_root);
    sync_commands_subtree(workspace, &myagents_root);
    Ok(())
}

fn sync_skills_subtree(workspace: &Path, myagents_root: &Path) {
    let user_skills = myagents_root.join("skills");
    if !user_skills.is_dir() {
        return;
    }
    let project_skills = workspace.join(".claude").join("skills");
    if let Err(e) = fs::create_dir_all(&project_skills) {
        ulog_warn!(
            "[skill-sync] mkdir {} failed: {}",
            project_skills.display(),
            e
        );
        return;
    }

    let disabled = read_disabled_list(myagents_root);
    let cli_tool_registry_enabled = read_cli_tool_registry_enabled(myagents_root);
    let mut managed: HashSet<String> = HashSet::new();

    let entries = match fs::read_dir(&user_skills) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let folder_name = entry.file_name().to_string_lossy().to_string();
        if folder_name.starts_with('.') {
            continue;
        }
        if is_skill_blocked_on_platform(&folder_name) {
            continue;
        }

        // Follow symlinks/junctions to determine "is dir" — user-installed
        // skills mounted via junction must be visible. (Read-only stat — the
        // CLAUDE.md v0.2.5 red-line about `Path::exists()` applies to
        // *destructive* ops, which we gate separately below.)
        let target = entry.path();
        let target_meta = match fs::metadata(&target) {
            Ok(m) => m,
            Err(_) => continue, // broken symlink — skip silently
        };
        if !target_meta.is_dir() {
            continue;
        }
        // Require SKILL.md so we don't symlink random user dirs that happen
        // to be inside ~/.myagents/skills.
        if !target.join("SKILL.md").is_file() {
            continue;
        }

        managed.insert(folder_name.clone());
        let link_path = project_skills.join(&folder_name);

        if disabled.contains(&folder_name)
            || (!cli_tool_registry_enabled && folder_name == "tool-creator")
        {
            // Disabled: remove our symlink if present; never remove real dirs.
            if let Ok(meta) = fs::symlink_metadata(&link_path) {
                if meta.is_symlink() {
                    let _ = remove_symlink_or_dir(&link_path);
                }
            }
            continue;
        }

        // Skip if a real (non-symlink) project dir exists — don't overwrite.
        // `symlink_metadata` (NOT `metadata`) so a broken symlink also
        // surfaces here as occupied; we then remove and re-create.
        //
        // Idempotent fast path: if the link already points at the right
        // target, do nothing. The previous logic always remove+recreated,
        // which (a) was wasteful and (b) produced spurious `File exists`
        // warnings when the remove silently failed (we ignore the error)
        // or when a concurrent reader recreated the link before our create
        // landed.
        match fs::symlink_metadata(&link_path) {
            Ok(meta) if !meta.is_symlink() => continue, // real dir, leave alone
            Ok(_) => {
                if fs::read_link(&link_path).ok().as_deref() == Some(target.as_path()) {
                    continue; // already correct — no-op
                }
                let _ = remove_symlink_or_dir(&link_path);
            }
            Err(_) => { /* doesn't exist — go create */ }
        }

        if let Err(e) = create_symlink_dir(&target, &link_path) {
            // `AlreadyExists` is benign here — the link landed via a
            // concurrent path (skill-sync runs on workspace open + tab
            // close + sidecar restart, all of which can race on the same
            // workspace). Demote to debug to keep the unified log clean.
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                ulog_debug!(
                    "[skill-sync] symlink {} → {} already exists (concurrent sync) — ignoring",
                    link_path.display(),
                    target.display(),
                );
            } else {
                ulog_warn!(
                    "[skill-sync] symlink {} → {} failed: {}",
                    link_path.display(),
                    target.display(),
                    e
                );
            }
        }
    }

    // Cleanup dangling symlinks: project-side links pointing into our user
    // skill dir whose targets are no longer in `managed` (deleted/renamed).
    cleanup_dangling_symlinks(&project_skills, &user_skills, &managed);
}

fn sync_commands_subtree(workspace: &Path, myagents_root: &Path) {
    let user_commands = myagents_root.join("commands");
    if !user_commands.is_dir() {
        return;
    }
    let project_commands = workspace.join(".claude").join("commands");
    if let Err(e) = fs::create_dir_all(&project_commands) {
        ulog_warn!(
            "[skill-sync] mkdir {} failed: {}",
            project_commands.display(),
            e
        );
        return;
    }

    let mut managed: HashSet<String> = HashSet::new();

    let entries = match fs::read_dir(&user_commands) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if !name.ends_with(".md") {
            continue;
        }
        // Must be a regular file (or symlink to one) — skip dirs.
        let target = entry.path();
        let meta = match fs::metadata(&target) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }

        managed.insert(name.clone());
        let link_path = project_commands.join(&name);

        // Skip real (non-symlink) project files. Same idempotent fast
        // path as `sync_skills_subtree` (above) — see that comment for why.
        match fs::symlink_metadata(&link_path) {
            Ok(meta) if !meta.is_symlink() => continue,
            Ok(_) => {
                if fs::read_link(&link_path).ok().as_deref() == Some(target.as_path()) {
                    continue;
                }
                let _ = remove_symlink_or_dir(&link_path);
            }
            Err(_) => { /* doesn't exist */ }
        }

        if let Err(e) = create_symlink_file(&target, &link_path) {
            // File symlinks on Windows require Developer Mode. We log + skip
            // the entry instead of aborting the whole sync — matches sidecar.
            // Benign EEXIST (concurrent skill-sync) demoted to debug.
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                ulog_debug!(
                    "[skill-sync] command symlink {} → {} already exists (concurrent sync) — ignoring",
                    link_path.display(),
                    target.display(),
                );
            } else {
                ulog_warn!(
                    "[skill-sync] command symlink {} → {} failed: {}",
                    link_path.display(),
                    target.display(),
                    e
                );
            }
        }
    }

    cleanup_dangling_symlinks(&project_commands, &user_commands, &managed);
}

/// Walk `project_dir` and remove entries that are symlinks pointing into
/// `user_dir` whose names are NOT in `keep`. Anything outside that narrow
/// criterion is left alone.
///
/// Cross-review (Codex round 3) caught: an earlier version used
/// `fs::canonicalize(&link)` to resolve the target, but `canonicalize` fails
/// for broken symlinks (the original sin: user disabled / removed the
/// `~/.myagents/skills/foo` source → project-side `foo` link is now broken).
/// That's exactly the case `cleanup_dangling_symlinks` is supposed to handle,
/// so the canonicalize approach silently skipped every dangling link → they
/// accumulated forever. Use lexical `read_link` + `path.parent().join(target)`
/// so broken links resolve to a path we can prefix-check.
fn cleanup_dangling_symlinks(project_dir: &Path, user_dir: &Path, keep: &HashSet<String>) {
    let entries = match fs::read_dir(project_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.contains(&name) {
            continue;
        }
        let link = entry.path();
        let meta = match fs::symlink_metadata(&link) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_symlink() && !is_windows_junction(&meta) {
            continue;
        }
        // Lexical: read the link target without traversing it. Works for
        // broken/dangling symlinks where canonicalize would fail.
        let target = match fs::read_link(&link) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let resolved_target = if target.is_absolute() {
            target
        } else {
            // Relative link target — resolve against the link's own dir.
            project_dir.join(target)
        };
        // Only touch links whose target prefix is our user dir — never
        // user-installed links that point elsewhere.
        if !resolved_target.starts_with(user_dir) {
            continue;
        }
        let _ = remove_symlink_or_dir(&link);
    }
}

/// Windows junctions show up in `symlink_metadata` as a special kind of
/// reparse point — `is_symlink()` may return `false` for them depending on
/// the std version. We treat them as "link-like" for cleanup purposes by
/// also checking via `FileType::is_dir()` + the metadata flag heuristic.
#[cfg(windows)]
fn is_windows_junction(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT = 0x400. Combined with `is_dir()` it
    // identifies a junction (directory reparse point) reliably across
    // Windows std variants.
    meta.is_dir() && (meta.file_attributes() & 0x400) != 0
}
#[cfg(not(windows))]
#[inline]
fn is_windows_junction(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn create_symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// On Windows we use NTFS junctions (no admin / Developer Mode required) —
/// matches the sidecar's `symlinkSync(target, link, 'junction')`.
/// `std::os::windows::fs::symlink_dir` would create a true symbolic link,
/// which requires elevated rights that most users don't have.
#[cfg(windows)]
fn create_symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    junction::create(target, link)
}

#[cfg(unix)]
fn create_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

/// Remove a symlink or (on Windows) a junction. `fs::remove_file` works for
/// Unix symlinks but Windows junctions are dirs and need `remove_dir_all`.
fn remove_symlink_or_dir(p: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(p)?;
    if meta.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::skills_config::REQUIRED_SYSTEM_SKILLS;
    use crate::workspace_files::test_support::make_test_workspace;

    fn add_user_skill(root: &Path, name: &str) {
        let user_skills = root.join(".myagents").join("skills");
        fs::create_dir_all(user_skills.join(name)).unwrap();
        fs::write(
            user_skills.join(name).join("SKILL.md"),
            "---\nname: x\n---\n",
        )
        .unwrap();
    }

    fn user_root_with_skill(name: &str) -> std::path::PathBuf {
        // Create a stand-in `~/.myagents` rooted at a tempdir for tests so
        // we don't poke the real user home.
        let root = make_test_workspace("home_for_skill_sync");
        add_user_skill(&root, name);
        root
    }

    #[test]
    fn creates_symlink_for_user_skill() {
        let home = user_root_with_skill("foo");
        let workspace = make_test_workspace("ws_for_skill_sync");
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        let link = workspace.join(".claude/skills/foo");
        assert!(link.exists(), "expected symlink at {}", link.display());
        let meta = fs::symlink_metadata(&link).unwrap();
        assert!(meta.is_symlink() || meta.is_dir(), "{:?}", meta);
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn skips_skill_without_skill_md() {
        let home = make_test_workspace("home_no_skill_md");
        let user_skill = home.join(".myagents/skills/empty");
        fs::create_dir_all(&user_skill).unwrap();
        // No SKILL.md → should be ignored.
        let workspace = make_test_workspace("ws_no_skill_md");
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        assert!(!workspace.join(".claude/skills/empty").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn idempotent_repeated_calls() {
        let home = user_root_with_skill("foo");
        let workspace = make_test_workspace("ws_idempotent");
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        // Still exactly one entry.
        let entries: Vec<_> = fs::read_dir(workspace.join(".claude/skills"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn skips_real_project_skill_dir() {
        // A user has hand-created `<workspace>/.claude/skills/foo/` (a real
        // dir, not a symlink). User also has a same-named skill in
        // `~/.myagents/skills/foo`. Sync MUST NOT clobber the real dir.
        let home = user_root_with_skill("foo");
        let workspace = make_test_workspace("ws_real_skill_kept");
        let real_dir = workspace.join(".claude/skills/foo");
        fs::create_dir_all(&real_dir).unwrap();
        fs::write(real_dir.join("USER_FILE"), "user data").unwrap();

        sync_workspace_skills_with_home(&workspace, &home).unwrap();

        // Real file still present — sync didn't overwrite.
        assert!(
            real_dir.join("USER_FILE").is_file(),
            "real project skill dir was clobbered"
        );
        // It's still a real dir, not a symlink.
        let meta = fs::symlink_metadata(&real_dir).unwrap();
        assert!(!meta.is_symlink());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn cleans_up_dangling_symlinks() {
        let home = user_root_with_skill("foo");
        let workspace = make_test_workspace("ws_cleanup_dangling");

        // First sync creates the foo symlink.
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        assert!(workspace.join(".claude/skills/foo").exists());

        // Delete the user-side skill, sync again — project-side link must
        // be cleaned up.
        fs::remove_dir_all(home.join(".myagents/skills/foo")).unwrap();
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        assert!(
            !workspace.join(".claude/skills/foo").exists(),
            "dangling symlink survived sync"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn respects_disabled_list() {
        let home = user_root_with_skill("foo");
        // Write a skills-config.json marking foo as disabled.
        fs::write(
            home.join(".myagents/skills-config.json"),
            r#"{"disabled":["foo"],"seeded":[],"generation":0}"#,
        )
        .unwrap();
        let workspace = make_test_workspace("ws_disabled");
        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        assert!(
            !workspace.join(".claude/skills/foo").exists(),
            "disabled skill was symlinked"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn required_system_skills_ignore_legacy_disabled_entries() {
        let home = make_test_workspace("home_required_skill_sync");
        for name in REQUIRED_SYSTEM_SKILLS
            .iter()
            .copied()
            .chain(std::iter::once("prompt-writer"))
        {
            add_user_skill(&home, name);
        }
        let disabled: Vec<&str> = REQUIRED_SYSTEM_SKILLS
            .iter()
            .copied()
            .chain(std::iter::once("prompt-writer"))
            .collect();
        fs::write(
            home.join(".myagents/skills-config.json"),
            serde_json::json!({ "disabled": disabled }).to_string(),
        )
        .unwrap();
        let workspace = make_test_workspace("ws_required_skill_sync");

        sync_workspace_skills_with_home(&workspace, &home).unwrap();

        for name in REQUIRED_SYSTEM_SKILLS {
            assert!(
                workspace.join(".claude/skills").join(name).exists(),
                "required skill {name} was not exposed"
            );
        }
        assert!(
            !workspace.join(".claude/skills/prompt-writer").exists(),
            "optional disabled system skill was exposed"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn gates_tool_creator_skill_off_by_default() {
        let home = user_root_with_skill("tool-creator");
        let workspace = make_test_workspace("ws_tool_creator_default_off");

        sync_workspace_skills_with_home(&workspace, &home).unwrap();

        assert!(
            !workspace.join(".claude/skills/tool-creator").exists(),
            "tool-creator should not be symlinked while the CLI tool registry lab gate is off"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn syncs_tool_creator_skill_when_cli_tool_registry_gate_is_enabled() {
        let home = user_root_with_skill("tool-creator");
        fs::write(
            home.join(".myagents/config.json"),
            r#"{"cliToolRegistryEnabled":true}"#,
        )
        .unwrap();
        let workspace = make_test_workspace("ws_tool_creator_enabled");

        sync_workspace_skills_with_home(&workspace, &home).unwrap();

        assert!(
            workspace.join(".claude/skills/tool-creator").exists(),
            "tool-creator should be symlinked when the CLI tool registry lab gate is on"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn removes_tool_creator_symlink_when_cli_tool_registry_gate_turns_off() {
        let home = user_root_with_skill("tool-creator");
        let config_path = home.join(".myagents/config.json");
        fs::write(&config_path, r#"{"cliToolRegistryEnabled":true}"#).unwrap();
        let workspace = make_test_workspace("ws_tool_creator_gate_flip");

        sync_workspace_skills_with_home(&workspace, &home).unwrap();
        assert!(workspace.join(".claude/skills/tool-creator").exists());

        fs::write(&config_path, r#"{"cliToolRegistryEnabled":false}"#).unwrap();
        sync_workspace_skills_with_home(&workspace, &home).unwrap();

        assert!(
            !workspace.join(".claude/skills/tool-creator").exists(),
            "tool-creator symlink should be removed after the lab gate turns off"
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&home);
    }
}
