//! Copy absolute filesystem paths into the workspace.
//!
//! Source: paths the user dragged in via Tauri's native drag-drop event, or
//! paths returned from a Tauri file picker. These are real OS paths the user
//! controls, so we apply the same blacklist + auto-rename logic as the sidecar
//! `/api/files/copy` endpoint.
//!
//! Why this exists separately from `files_b64::import`: drag/drop / file picker
//! gives us paths, not bytes. Round-tripping a 500MB file through base64 IPC
//! would blow the Tauri payload budget; copying directly path → workspace is
//! both faster and safer.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::path_safety::{
    reject_managed_global_skill_mutation, resolve_existing_inside_workspace,
    resolve_inside_workspace, validate_external_read_path, validate_workspace_root,
};

const MAX_COLLISION_SUFFIX: u32 = 9999;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedFile {
    pub source_path: String,
    /// Target path relative to workspace root.
    pub target_path: String,
    pub renamed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub success: bool,
    pub copied_files: Vec<CopiedFile>,
    /// Per-file failures (blacklist reject, fs error). Cross-review 0.2.33
    /// (Codex W3): these were log-only, so a drop where EVERY source was
    /// rejected returned `success:true, copiedFiles:[]` and the frontend
    /// refreshed with no files and no explanation. Same contract as
    /// `InternalCopyResult.errors` — the sibling paste path already
    /// surfaces them.
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPathsRequest {
    pub workspace: String,
    pub source_paths: Vec<String>,
    pub target_dir: String,
    #[serde(default = "default_true")]
    pub auto_rename: bool,
}

fn default_true() -> bool {
    true
}

/// Copy absolute paths into `<workspace>/<target_dir>/`.
///
/// Each entry in `source_paths` is treated independently — a single failure
/// does not abort the rest, mirroring the sidecar's "best effort" semantics
/// for drag-drop UX.
///
/// Tauri auto-converts JS-side camelCase (`sourcePaths`/`targetDir`/`autoRename`)
/// to Rust snake_case parameter names — match the convention used by every
/// other command in this codebase.
#[tauri::command]
pub async fn cmd_workspace_copy_paths(
    workspace: String,
    source_paths: Vec<String>,
    target_dir: String,
    auto_rename: Option<bool>,
) -> Result<CopyResult, String> {
    if source_paths.is_empty() {
        return Err("sourcePaths is required".to_string());
    }

    let workspace_root = validate_workspace_root(&workspace)?;
    let target_root = resolve_inside_workspace(&workspace_root, &target_dir)?;
    reject_managed_global_skill_mutation(&workspace_root, &target_root)?;
    fs::create_dir_all(&target_root)
        .map_err(|e| format!("Failed to create target directory: {}", e))?;

    let auto_rename = auto_rename.unwrap_or(true);
    let mut copied: Vec<CopiedFile> = Vec::with_capacity(source_paths.len());
    let mut errors: Vec<String> = Vec::new();

    for source in source_paths {
        match copy_one_path(&source, &target_root, &workspace_root, auto_rename) {
            Ok(item) => copied.push(item),
            Err(err) => {
                // Per-file failures continue the batch so the user keeps the
                // files that did go through — but they must reach the caller,
                // not just the log (cross-review 0.2.33, Codex W3).
                // ulog_* (not log::*) per CLAUDE.md red-line — log::warn!
                // doesn't reach `~/.myagents/logs/unified-{date}.log`.
                crate::ulog_warn!("[workspace_files::copy] skipping {}: {}", source, err);
                errors.push(format!("{}: {}", source, err));
            }
        }
    }

    Ok(CopyResult {
        success: true,
        copied_files: copied,
        errors,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCopyResult {
    pub success: bool,
    pub copied_files: Vec<CopiedFile>,
    pub errors: Vec<String>,
}

/// Copy WORKSPACE-RELATIVE paths to another directory inside the same
/// workspace — the tree's copy/paste (Cmd+C → Cmd+V). Separate from
/// `cmd_workspace_copy_paths` because both endpoints live inside the
/// workspace: sources go through `resolve_inside_workspace`, NOT the
/// external-read blacklist (whose semantics target foreign OS paths and
/// could reject workspaces on unusual locations). Collisions always
/// auto-rename — the canonical "paste next to the original" flow IS a
/// collision.
#[tauri::command]
pub async fn cmd_workspace_copy_internal(
    workspace: String,
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<InternalCopyResult, String> {
    if source_paths.is_empty() {
        return Err("sourcePaths is required".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let target_root = resolve_inside_workspace(&workspace_root, target_dir.trim())?;
    reject_managed_global_skill_mutation(&workspace_root, &target_root)?;
    if !target_root.is_dir() {
        return Err("Target must be an existing directory".to_string());
    }

    let mut copied: Vec<CopiedFile> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for src in source_paths {
        let trimmed = src.trim();
        match copy_internal_one(trimmed, &workspace_root, &target_root) {
            Ok(item) => copied.push(item),
            Err(err) => errors.push(format!("{}: {}", trimmed, err)),
        }
    }

    Ok(InternalCopyResult {
        success: true,
        copied_files: copied,
        errors,
    })
}

fn copy_internal_one(
    src_rel: &str,
    workspace_root: &Path,
    target_root: &Path,
) -> Result<CopiedFile, String> {
    // READ side: canonicalize (CLAUDE.md red-line). A lexical resolve would
    // let an intermediate symlink component (`evil → /etc`) pass the prefix
    // check while `fs::copy` follows the link — exfiltrating bytes from
    // outside the workspace INTO an AI-readable workspace file.
    let resolved = resolve_existing_inside_workspace(workspace_root, src_rel)?;
    let metadata = fs::symlink_metadata(&resolved).map_err(|e| format!("stat failed: {}", e))?;

    // Copying a directory into itself / its own subtree would make
    // `copy_dir_recursive` walk the growing destination — refuse up front.
    // BOTH sides canonicalized: the target dir exists (checked by the
    // command), and a symlink target pointing into the source subtree would
    // defeat a lexical comparison (unbounded recursive copy). Canonicalizing
    // the target also fails closed if `targetDir` is a symlink escaping the
    // workspace (the write would land outside otherwise).
    let canonical_target = fs::canonicalize(target_root)
        .map_err(|_| "Target directory canonicalize failed".to_string())?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root canonicalize failed".to_string())?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("Target escapes workspace root via symlink".to_string());
    }
    if metadata.is_dir() && canonical_target.starts_with(&resolved) {
        return Err("Cannot copy folder into itself".to_string());
    }

    let name = resolved
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "source has no filename".to_string())?;
    // All filesystem ops below run on CANONICAL paths — `strip_prefix` must
    // use the canonical root too (on macOS the temp/workspace path may be
    // reached via `/var → /private/var`, so lexical and canonical prefixes
    // differ).
    let (final_name, renamed) = unique_target_name(&canonical_target, &name, true)?;
    let dest = canonical_target.join(&final_name);

    if metadata.is_dir() {
        copy_dir_recursive(&resolved, &dest)?;
    } else if metadata.is_file() {
        fs::copy(&resolved, &dest).map_err(|e| format!("copy failed: {}", e))?;
    } else {
        return Err("Unsupported file type".to_string());
    }

    let target_relative = dest
        .strip_prefix(&canonical_root)
        .map_err(|_| "Resolved path escaped workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(CopiedFile {
        source_path: src_rel.to_string(),
        target_path: target_relative,
        renamed,
    })
}

fn copy_one_path(
    source: &str,
    target_root: &Path,
    workspace_root: &Path,
    auto_rename: bool,
) -> Result<CopiedFile, String> {
    let validated_source = validate_external_read_path(source)?;
    let metadata =
        fs::symlink_metadata(&validated_source).map_err(|e| format!("stat failed: {}", e))?;

    let source_name = Path::new(source)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "source has no filename".to_string())?;

    let (final_name, renamed) = unique_target_name(target_root, &source_name, auto_rename)?;
    let dest = target_root.join(&final_name);

    if metadata.is_dir() {
        copy_dir_recursive(&validated_source, &dest)?;
    } else if metadata.is_file() {
        fs::copy(&validated_source, &dest).map_err(|e| format!("copy failed: {}", e))?;
    } else {
        return Err(format!("Unsupported file type for {}", source));
    }

    let target_relative = dest
        .strip_prefix(workspace_root)
        .map_err(|_| "Resolved path escaped workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(CopiedFile {
        source_path: source.to_string(),
        target_path: target_relative,
        renamed,
    })
}

/// Symlink-aware "is this slot occupied" — `Path::exists()` follows symlinks,
/// returning false for a broken symlink. CLAUDE.md v0.2.5 red-line: relying on
/// follow-symlink existence checks before destructive ops causes confusing
/// `fs::copy` / `fs::rename` failures (and on some kernels writes through the
/// symlink to its target). Mirrors `crud.rs::slot_occupied`.
fn slot_occupied(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn unique_target_name(
    target_root: &Path,
    name: &str,
    auto_rename: bool,
) -> Result<(String, bool), String> {
    let candidate_path = target_root.join(name);
    if !slot_occupied(&candidate_path) {
        return Ok((name.to_string(), false));
    }
    if !auto_rename {
        return Err(format!("File {} already exists", name));
    }

    let (stem, ext_with_dot) = match name.rfind('.') {
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    };

    for counter in 1..=MAX_COLLISION_SUFFIX {
        let candidate = format!("{}_{}{}", stem, counter, ext_with_dot);
        if !slot_occupied(&target_root.join(&candidate)) {
            return Ok((candidate, true));
        }
    }
    Err(format!("Too many filename collisions for {}", name))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir failed: {}", e))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read_dir({}): {}", src.display(), e))?;
    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("read_dir entry: {}", e))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| format!("stat: {}", e))?;
        let dest_path = dst.join(entry.file_name());
        if metadata.is_symlink() {
            // Skip symlinks to avoid escaping the source tree. Mirrors the
            // sidecar `merge_dir_recursive` behavior. Cross-review round 2
            // (Codex LOW-1): silent skip can drop legitimate symlinks
            // (npm `node_modules/.bin`, virtualenv `python` link); user
            // discovers files missing in the copied tree without a hint.
            // Log so a grep of unified.log surfaces the skipped paths.
            crate::ulog_warn!(
                "[workspace_files::transfer] skipped symlink {} (copy_dir_recursive does not follow links)",
                entry.path().display()
            );
            continue;
        } else if metadata.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path).map_err(|e| format!("copy: {}", e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::path::PathBuf;

    fn make_tmp_dir(prefix: &str) -> PathBuf {
        make_test_workspace(&format!("transfer_{}", prefix))
    }

    #[tokio::test]
    async fn internal_copy_file_and_dir() {
        let ws = make_tmp_dir("internal_basic");
        fs::create_dir_all(ws.join("dst")).unwrap();
        fs::create_dir_all(ws.join("src/nested")).unwrap();
        fs::write(ws.join("a.txt"), "a").unwrap();
        fs::write(ws.join("src/nested/b.txt"), "b").unwrap();

        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string(), "src".to_string()],
            "dst".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.copied_files.len(), 2);
        assert!(res.errors.is_empty());
        assert!(ws.join("dst/a.txt").is_file());
        assert!(ws.join("dst/src/nested/b.txt").is_file());
        // Source untouched (it's a copy).
        assert!(ws.join("a.txt").is_file());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn internal_copy_into_same_dir_auto_renames() {
        let ws = make_tmp_dir("internal_same_dir");
        fs::write(ws.join("a.txt"), "a").unwrap();

        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string()],
            "".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.copied_files.len(), 1);
        assert!(res.copied_files[0].renamed);
        assert_eq!(res.copied_files[0].target_path, "a_1.txt");
        assert!(ws.join("a_1.txt").is_file());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn internal_copy_rejects_dir_into_itself() {
        let ws = make_tmp_dir("internal_self");
        fs::create_dir_all(ws.join("a/b")).unwrap();

        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["a".to_string()],
            "a/b".to_string(),
        )
        .await
        .unwrap();

        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        assert!(res.errors[0].contains("itself"));
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review (Codex critical): a LEXICAL source resolve let an
    // intermediate symlink component (`evil → outside`) pass the prefix
    // check while fs::copy followed the link — exfiltrating outside bytes
    // into the AI-readable workspace. Sources must canonicalize.
    #[cfg(unix)]
    #[tokio::test]
    async fn internal_copy_rejects_symlinked_source_component_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_dir("internal_symlink_src_ws");
        let outside = make_tmp_dir("internal_symlink_src_outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, ws.join("evil")).unwrap();
        fs::create_dir_all(ws.join("dst")).unwrap();

        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["evil/secret.txt".to_string()],
            "dst".to_string(),
        )
        .await
        .unwrap();

        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        assert!(!ws.join("dst/secret.txt").exists());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    // Cross-review (Codex critical): the into-self check must compare
    // CANONICAL paths — a symlink target dir pointing into the source
    // subtree defeats a lexical comparison and the recursive copy chases
    // its own growing destination.
    #[cfg(unix)]
    #[tokio::test]
    async fn internal_copy_rejects_symlink_target_into_source() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_dir("internal_symlink_self");
        fs::create_dir_all(ws.join("a/b")).unwrap();
        fs::write(ws.join("a/f.txt"), "x").unwrap();
        symlink(ws.join("a/b"), ws.join("ln")).unwrap();

        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["a".to_string()],
            "ln".to_string(),
        )
        .await
        .unwrap();

        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        assert!(res.errors[0].contains("itself"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn internal_copy_rejects_traversal_source() {
        let ws = make_tmp_dir("internal_traversal");
        fs::create_dir_all(ws.join("dst")).unwrap();
        let res = cmd_workspace_copy_internal(
            ws.to_string_lossy().to_string(),
            vec!["../escape.txt".to_string()],
            "dst".to_string(),
        )
        .await
        .unwrap();
        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn copies_file_to_target() {
        let ws = make_tmp_dir("ws");
        let src_root = make_tmp_dir("src");
        let src_file = src_root.join("foo.txt");
        fs::write(&src_file, b"abc").unwrap();

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            "myagents_files".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(res.copied_files.len(), 1);
        assert_eq!(res.copied_files[0].target_path, "myagents_files/foo.txt");
        assert_eq!(
            fs::read(ws.join("myagents_files").join("foo.txt")).unwrap(),
            b"abc"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&src_root);
    }

    #[tokio::test]
    async fn auto_renames_on_collision() {
        let ws = make_tmp_dir("ws");
        let src_root = make_tmp_dir("src");
        let src_file = src_root.join("foo.txt");
        fs::write(&src_file, b"abc").unwrap();

        // Pre-place a file with the same name.
        fs::create_dir_all(ws.join("dir")).unwrap();
        fs::write(ws.join("dir").join("foo.txt"), b"existing").unwrap();

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            "dir".to_string(),
            Some(true),
        )
        .await
        .unwrap();

        assert!(res.copied_files[0].renamed);
        assert_eq!(res.copied_files[0].target_path, "dir/foo_1.txt");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&src_root);
    }

    #[tokio::test]
    async fn copies_directory_recursively() {
        let ws = make_tmp_dir("ws");
        let src_root = make_tmp_dir("src");
        let inner = src_root.join("project");
        fs::create_dir_all(inner.join("sub")).unwrap();
        fs::write(inner.join("a.txt"), b"a").unwrap();
        fs::write(inner.join("sub").join("b.txt"), b"b").unwrap();

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![inner.to_string_lossy().to_string()],
            "imp".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(res.copied_files[0].target_path, "imp/project");
        assert_eq!(
            fs::read(ws.join("imp").join("project").join("a.txt")).unwrap(),
            b"a"
        );
        assert_eq!(
            fs::read(ws.join("imp").join("project").join("sub").join("b.txt")).unwrap(),
            b"b"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&src_root);
    }

    // Cross-review regression guard: pre-fix `unique_target_name` used
    // `Path::exists()` which follows symlinks. A broken symlink at the target
    // slot returned false → caller proceeded into `fs::copy` / `fs::rename`
    // and got a confusing error or wrote through the symlink. CLAUDE.md
    // v0.2.5 red-line. `slot_occupied` (mirroring `crud.rs`) uses
    // `fs::symlink_metadata` so the slot is correctly seen as occupied.
    #[cfg(unix)]
    #[tokio::test]
    async fn collision_check_handles_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_dir("ws");
        let src_root = make_tmp_dir("src");
        let src_file = src_root.join("foo.txt");
        fs::write(&src_file, b"abc").unwrap();

        // Pre-place a broken symlink at the target slot.
        fs::create_dir_all(ws.join("dir")).unwrap();
        symlink("/nonexistent/target", ws.join("dir").join("foo.txt")).unwrap();

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            "dir".to_string(),
            Some(true),
        )
        .await
        .unwrap();

        // Auto-renamed instead of overwriting the symlink.
        assert!(res.copied_files[0].renamed);
        assert_eq!(res.copied_files[0].target_path, "dir/foo_1.txt");
        // Original broken symlink left untouched.
        assert!(fs::symlink_metadata(ws.join("dir").join("foo.txt"))
            .map(|m| m.is_symlink())
            .unwrap_or(false));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&src_root);
    }

    #[tokio::test]
    async fn rejects_blacklisted_source() {
        let ws = make_tmp_dir("ws");
        #[cfg(not(windows))]
        let blacklisted = "/etc/hosts";
        #[cfg(windows)]
        let blacklisted = "C:\\Windows\\system.ini";

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![blacklisted.to_string()],
            "out".to_string(),
            None,
        )
        .await
        .unwrap();
        // The batch returns success=true with an empty copied list — and the
        // per-file failure is reported, not just logged (Codex W3).
        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review 0.2.33 (Codex Critical): the EXTERNAL copy path validated
    // sources purely lexically — `<dir>/lure/secret` where `lure → ~/.ssh`
    // passes the credential-dir blacklist (the literal string doesn't start
    // with a blacklisted prefix) while fs::copy follows the intermediate
    // symlink, exfiltrating credential bytes into the AI-readable workspace.
    // `validate_external_read_path` must canonicalize and re-check.
    #[cfg(unix)]
    #[tokio::test]
    async fn external_copy_rejects_intermediate_symlink_into_blacklisted_dir() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_dir("ws");
        let staging = make_tmp_dir("staging");
        // `lure` resolves into /etc — a FORBIDDEN_SYSTEM_DIRS prefix on unix.
        symlink("/etc", staging.join("lure")).unwrap();
        let evil_source = staging.join("lure").join("hosts");

        let res = cmd_workspace_copy_paths(
            ws.to_string_lossy().to_string(),
            vec![evil_source.to_string_lossy().to_string()],
            "out".to_string(),
            None,
        )
        .await
        .unwrap();

        assert!(res.copied_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        assert!(!ws.join("out/hosts").exists());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&staging);
    }
}
