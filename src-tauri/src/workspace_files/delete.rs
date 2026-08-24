//! Delete a file or directory inside the workspace.
//!
//! Default (`permanent` unset/false) moves the item to the OS trash via the
//! `trash` crate, so Finder's「放回原处」/ Explorer restore stays available —
//! tree deletions are no longer unrecoverable. `permanent: true` keeps the
//! old unlink semantics for callers cleaning up their own scratch files
//! (and for tests, which must not pollute the developer's trash).
//!
//! We use `symlink_metadata` (NOT `metadata`) so a broken symlink reports as
//! a file and gets removed cleanly. v0.2.5 hit a sidecar crash where
//! `metadata` followed a broken symlink and called into a sync `cpSync`-style
//! path checking; lesson is enshrined in CLAUDE.md red-line table.

use std::fs;

use serde::Serialize;

use super::path_safety::{
    reject_managed_global_skill_mutation, resolve_inside_workspace, validate_workspace_root,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub success: bool,
    pub deleted: bool,
}

#[tauri::command]
pub async fn cmd_workspace_delete(
    workspace: String,
    path: String,
    permanent: Option<bool>,
) -> Result<DeleteResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, &path)?;
    reject_managed_global_skill_mutation(&workspace_root, &target)?;

    // Refuse to delete the workspace root itself.
    if target == workspace_root {
        return Err("Refusing to delete workspace root".to_string());
    }

    let metadata = match fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DeleteResult {
                success: true,
                deleted: false,
            });
        }
        Err(e) => return Err(format!("stat failed: {}", e)),
    };

    // Symlinks always unlink directly regardless of mode. Rationale
    // (corrected by cross-review — trash 5.x backends are actually
    // symlink-aware on Linux): removing a link destroys no data (the target
    // is untouched), and trash-vs-unlink behavior for links differs subtly
    // across the macOS / Windows / freedesktop backends — direct unlink is
    // the one deterministic cross-platform semantic. Cost: a deleted VALID
    // symlink isn't restorable from the trash (only the link itself is lost).
    if metadata.is_symlink() {
        fs::remove_file(&target).map_err(|e| format!("Failed to delete {}: {}", path, e))?;
        return Ok(DeleteResult {
            success: true,
            deleted: true,
        });
    }

    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported file type".to_string());
    }

    if permanent.unwrap_or(false) {
        let res = if metadata.is_file() {
            fs::remove_file(&target)
        } else {
            fs::remove_dir_all(&target)
        };
        res.map_err(|e| format!("Failed to delete {}: {}", path, e))?;
    } else {
        trash::delete(&target).map_err(|e| format!("Failed to move {} to trash: {}", path, e))?;
    }

    Ok(DeleteResult {
        success: true,
        deleted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::path::PathBuf;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("delete")
    }

    #[tokio::test]
    async fn deletes_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("a.txt"), "x").unwrap();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "a.txt".to_string(),
            Some(true),
        )
        .await
        .unwrap();
        assert!(res.deleted);
        assert!(!ws.join("a.txt").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn deletes_directory_recursively() {
        let ws = make_tmp_workspace();
        let sub = ws.join("dir");
        fs::create_dir_all(sub.join("nested")).unwrap();
        fs::write(sub.join("a.txt"), "x").unwrap();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "dir".to_string(),
            Some(true),
        )
        .await
        .unwrap();
        assert!(res.deleted);
        assert!(!sub.exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn missing_returns_not_deleted_not_error() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "missing.txt".to_string(),
            Some(true),
        )
        .await
        .unwrap();
        assert!(!res.deleted);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_workspace_root_itself() {
        let ws = make_tmp_workspace();
        let res =
            cmd_workspace_delete(ws.to_string_lossy().to_string(), "".to_string(), Some(true))
                .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "../escape".to_string(),
            Some(true),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // v0.2.5 regression: broken symlink crashed the sidecar. Verify Rust path
    // handles it cleanly by removing the broken link as a "file".
    #[cfg(unix)]
    #[tokio::test]
    async fn deletes_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken")).unwrap();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "broken".to_string(),
            Some(true),
        )
        .await
        .unwrap();
        assert!(res.deleted);
        assert!(!ws.join("broken").exists());
        // exists() returns false for broken symlinks, so we also verify it's gone via symlink_metadata
        assert!(fs::symlink_metadata(ws.join("broken")).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // Trash-mode (permanent=None) must not hand symlinks to the trash crate —
    // its backends stat the link target, so a BROKEN link would error the
    // whole delete. The symlink branch unlinks directly, which also keeps
    // this test from polluting the developer's trash.
    #[cfg(unix)]
    #[tokio::test]
    async fn trash_mode_unlinks_broken_symlink_directly() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken2")).unwrap();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "broken2".to_string(),
            None,
        )
        .await
        .unwrap();
        assert!(res.deleted);
        assert!(fs::symlink_metadata(ws.join("broken2")).is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
