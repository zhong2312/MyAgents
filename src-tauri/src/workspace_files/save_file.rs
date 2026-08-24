//! Save edited workspace file content (Phase D.5 / E1 migration).
//!
//! Mirrors sidecar `/agent/save-file` semantics:
//! - File MUST already exist (this command does NOT create — that's
//!   `cmd_workspace_new_file`'s job; `FilePreviewModal` only opens
//!   existing files for edit, so this distinction matches the UX path).
//! - 2MB content cap (matches `read_preview` cap so a roundtrip
//!   read → edit → save is symmetric).
//! - Atomic write via `path_safety::atomic_write_file` (tmp + rename in
//!   the same parent dir).
//! - Read-side path resolver (`resolve_existing_inside_workspace`) so
//!   a workspace-internal symlink to an outside file (`evil_link →
//!   /etc/passwd`) cannot be overwritten through this endpoint — the
//!   CRIT check from Phase D.5 cross-review applies symmetrically to
//!   write-while-existing.

use std::fs;

use super::path_safety::{
    atomic_write_file, atomic_write_file_if_current, reject_managed_global_skill_mutation,
    resolve_existing_inside_workspace, validate_workspace_root,
};

const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;

/// Returns `Ok(())` on success — no body needed (`Result` is the only
/// signal `FilePreviewModal` consumes).
#[tauri::command]
pub async fn cmd_workspace_save_file(
    workspace: String,
    path: String,
    content: String,
    expected_content: Option<String>,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err("Content too large".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let resolved = resolve_existing_inside_workspace(&workspace_root, trimmed)?;
    reject_managed_global_skill_mutation(&workspace_root, &resolved)?;

    // `resolved` is canonicalized — the symlink-escape gate is closed by
    // `resolve_existing_inside_workspace`. Use `symlink_metadata` for the
    // final file-vs-dir check rather than `metadata`: if some future refactor
    // returns a non-canonical path here, `symlink_metadata` keeps the safety
    // guarantee instead of silently following a freshly inserted link.
    let metadata = fs::symlink_metadata(&resolved).map_err(|_| "File not found".to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }

    if let Some(expected) = expected_content {
        atomic_write_file_if_current(&resolved, content.as_bytes(), expected.as_bytes())
    } else {
        atomic_write_file(&resolved, content.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn writes_existing_file() {
        let ws = make_test_workspace("save_writes");
        fs::write(ws.join("a.md"), "old").unwrap();
        cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "a.md".to_string(),
            "new content".to_string(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(ws.join("a.md")).unwrap(), "new content");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_missing_file() {
        let ws = make_test_workspace("save_missing");
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "nope.md".to_string(),
            "x".to_string(),
            None,
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_oversize() {
        let ws = make_test_workspace("save_oversize");
        fs::write(ws.join("f.md"), "old").unwrap();
        let big = "a".repeat(MAX_CONTENT_BYTES + 1);
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "f.md".to_string(),
            big,
            None,
        )
        .await;
        assert!(res.is_err());
        // File unchanged.
        assert_eq!(fs::read_to_string(ws.join("f.md")).unwrap(), "old");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn writes_at_max_content_bytes() {
        let ws = make_test_workspace("save_at_max_size");
        fs::write(ws.join("f.md"), "old").unwrap();
        let content = "a".repeat(MAX_CONTENT_BYTES);
        cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "f.md".to_string(),
            content,
            Some("old".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::metadata(ws.join("f.md")).unwrap().len(),
            MAX_CONTENT_BYTES as u64
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_test_workspace("save_traversal");
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "../etc/hosts".to_string(),
            "x".to_string(),
            None,
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_directory_target() {
        let ws = make_test_workspace("save_dir");
        fs::create_dir_all(ws.join("sub")).unwrap();
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "sub".to_string(),
            "x".to_string(),
            None,
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // Phase D.5 read-side gate covers cmd_workspace_save_file too (same
    // resolver). A workspace-internal symlink to `/etc/...` MUST NOT be
    // writable via save.
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_test_workspace("save_symlink_escape");
        let outside = std::env::temp_dir().join(format!("save_outside_{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let real = outside.join("real.md");
        fs::write(&real, "OUTSIDE").unwrap();
        symlink(&real, ws.join("evil.md")).unwrap();

        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "evil.md".to_string(),
            "OVERWRITE".to_string(),
            None,
        )
        .await;
        assert!(res.is_err());
        // The outside file is untouched.
        assert_eq!(fs::read_to_string(&real).unwrap(), "OUTSIDE");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn rejects_when_expected_content_mismatches() {
        let ws = make_test_workspace("save_expected_mismatch");
        fs::write(ws.join("a.md"), "external").unwrap();
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "a.md".to_string(),
            "local dirty".to_string(),
            Some("old baseline".to_string()),
        )
        .await;
        assert!(res.is_err());
        assert_eq!(fs::read_to_string(ws.join("a.md")).unwrap(), "external");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_when_expected_content_mismatches_large_current_file() {
        let ws = make_test_workspace("save_expected_large_mismatch");
        let huge_external = "x".repeat(MAX_CONTENT_BYTES + 128);
        fs::write(ws.join("a.md"), &huge_external).unwrap();
        let res = cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "a.md".to_string(),
            "local dirty".to_string(),
            Some("old baseline".to_string()),
        )
        .await;
        assert!(res.is_err());
        assert_eq!(
            fs::metadata(ws.join("a.md")).unwrap().len(),
            huge_external.len() as u64
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn writes_when_expected_content_matches() {
        let ws = make_test_workspace("save_expected_match");
        fs::write(ws.join("a.md"), "old baseline").unwrap();
        cmd_workspace_save_file(
            ws.to_string_lossy().to_string(),
            "a.md".to_string(),
            "local dirty".to_string(),
            Some("old baseline".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(ws.join("a.md")).unwrap(), "local dirty");
        let _ = fs::remove_dir_all(&ws);
    }
}
