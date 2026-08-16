//! Atomically persist a bounded binary project asset.
//!
//! Workbenches use this only after creating the target through the generic
//! workspace CRUD capability. Keeping the binary write separate from text
//! saves prevents image data from crossing into JSON facts as base64 strings.

use std::fs;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use super::path_safety::{atomic_write_file, resolve_existing_inside_workspace, validate_workspace_root};

const MAX_BINARY_CONTENT_BYTES: usize = 12 * 1024 * 1024;

#[tauri::command]
pub async fn cmd_workspace_save_binary_file(
    workspace: String,
    path: String,
    content_base64: String,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    let bytes = BASE64
        .decode(content_base64.trim())
        .map_err(|_| "binary content must be valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BINARY_CONTENT_BYTES {
        return Err("Binary content exceeds the 12 MB limit".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let resolved = resolve_existing_inside_workspace(&workspace_root, trimmed)?;
    let metadata = fs::symlink_metadata(&resolved).map_err(|_| "File not found".to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }
    atomic_write_file(&resolved, &bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn writes_existing_binary_file_atomically() {
        let workspace = make_test_workspace("save_binary_ok");
        fs::write(workspace.join("asset.png"), b"old").unwrap();
        cmd_workspace_save_binary_file(
            workspace.to_string_lossy().to_string(),
            "asset.png".to_string(),
            BASE64.encode(b"\x89PNG\r\n"),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(workspace.join("asset.png")).unwrap(), b"\x89PNG\r\n");
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn rejects_missing_or_invalid_binary_target() {
        let workspace = make_test_workspace("save_binary_reject");
        assert!(cmd_workspace_save_binary_file(
            workspace.to_string_lossy().to_string(),
            "missing.png".to_string(),
            BASE64.encode(b"bytes"),
        )
        .await
        .is_err());
        fs::write(workspace.join("asset.png"), b"old").unwrap();
        assert!(cmd_workspace_save_binary_file(
            workspace.to_string_lossy().to_string(),
            "asset.png".to_string(),
            "not-base64".to_string(),
        )
        .await
        .is_err());
        let _ = fs::remove_dir_all(workspace);
    }
}
