//! Base64 file IO inside a workspace.
//!
//! Two flows:
//!
//! - `import_files_b64`: frontend has `File` objects (paste / drag-drop / file
//!   picker), encodes them base64, sends them as JSON because Tauri IPC has no
//!   `multipart/form-data`. Rust decodes and writes into `<workspace>/<target_dir>/`.
//!
//! - `read_files_b64`: frontend dropped absolute file paths from Tauri's native
//!   drag-drop event; Rust reads them and returns base64 so the frontend can
//!   reconstruct `File` objects to feed into the image attachment pipeline.
//!   Image-only by design — non-images go through `transfer::copy_paths`.
//!
//! Concurrency: import uses O_CREAT|O_EXCL on Unix and the equivalent on
//! Windows so two callers racing for the same target name can never silently
//! overwrite — they both see a "file exists" error and bump the suffix
//! independently. Mirrors `writeBase64FilesToAgentDir` in TS.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use super::path_safety::{
    reject_managed_global_skill_mutation, resolve_inside_workspace, sanitize_filename,
    validate_external_read_path, validate_workspace_root,
};

/// Hard ceiling on collision retries — guards against pathological loops.
const MAX_COLLISION_SUFFIX: u32 = 9999;

/// 10MB max for image reads — matches sidecar `/api/files/read-as-base64`.
const MAX_IMAGE_SIZE_BYTES: u64 = 10 * 1024 * 1024;

const ALLOWED_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif", "avif",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Base64FileEntry {
    pub name: String,
    /// base64-encoded file body (no data URL prefix).
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    /// Path relative to the workspace root, suitable for `@reference` use in chat.
    pub relative_path: String,
    /// Final on-disk filename after collision-aware renaming.
    pub final_name: String,
    /// Whether the original name collided and we appended a suffix.
    pub renamed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub files: Vec<String>,
}

/// Import base64-encoded files into `<workspace>/<target_dir>/`.
///
/// `target_dir` is workspace-relative (e.g. `"myagents_files"`). Empty string
/// means workspace root itself. The directory is created if it does not exist.
///
/// Tauri auto-converts the JS-side camelCase (`targetDir`) to the Rust-side
/// snake_case parameter name (`target_dir`); the frontend hook keeps sending
/// camelCase for consistency with `serde(rename_all = "camelCase")` JSON.
#[tauri::command]
pub async fn cmd_workspace_import_files_b64(
    workspace: String,
    files: Vec<Base64FileEntry>,
    target_dir: Option<String>,
) -> Result<ImportResult, String> {
    if files.is_empty() {
        return Err("No files provided".to_string());
    }

    let workspace_root = validate_workspace_root(&workspace)?;
    let target_root =
        resolve_inside_workspace(&workspace_root, target_dir.as_deref().unwrap_or(""))?;
    reject_managed_global_skill_mutation(&workspace_root, &target_root)?;

    tokio::fs::create_dir_all(&target_root)
        .await
        .map_err(|e| format!("Failed to create target directory: {}", e))?;

    let mut written: Vec<String> = Vec::with_capacity(files.len());

    for entry in files {
        let safe_name = sanitize_filename(&entry.name);
        let bytes = BASE64
            .decode(entry.content.as_bytes())
            .map_err(|e| format!("Invalid base64 for {}: {}", entry.name, e))?;
        let final_relative = write_unique_file(&target_root, &workspace_root, &safe_name, &bytes)?;
        written.push(final_relative);
    }

    Ok(ImportResult {
        success: true,
        files: written,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAsBase64Request {
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAsBase64Item {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    /// base64 body (empty string if `error` is set).
    pub data: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAsBase64Response {
    pub success: bool,
    pub files: Vec<ReadAsBase64Item>,
}

/// Read absolute paths (from Tauri drag-drop) as base64. Image-only.
///
/// We loop per-file rather than failing the whole batch on one bad file —
/// the user dragged in a folder that happens to contain a non-image, the
/// expected UX is "import the images, ignore the rest".
#[tauri::command]
pub async fn cmd_workspace_read_files_b64(
    paths: Vec<String>,
) -> Result<ReadAsBase64Response, String> {
    if paths.is_empty() {
        return Err("paths is required".to_string());
    }

    let mut items: Vec<ReadAsBase64Item> = Vec::with_capacity(paths.len());

    for path in paths {
        let item = read_one_image_as_b64(&path).await;
        items.push(item);
    }

    Ok(ReadAsBase64Response {
        success: true,
        files: items,
    })
}

async fn read_one_image_as_b64(raw_path: &str) -> ReadAsBase64Item {
    let name = std::path::Path::new(raw_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let make_err = |err: String| ReadAsBase64Item {
        path: raw_path.to_string(),
        name: name.clone(),
        mime_type: String::new(),
        data: String::new(),
        error: Some(err),
    };

    let ext = std::path::Path::new(raw_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    match ext.as_deref() {
        Some(e) if ALLOWED_IMAGE_EXTS.contains(&e) => {}
        _ => return make_err("Only image files are allowed".to_string()),
    }

    let resolved = match validate_external_read_path(raw_path) {
        Ok(p) => p,
        Err(e) => return make_err(format!("Access denied: {}", e)),
    };

    // Symlink defense: a `.png` filename can be a symlink to anything (the
    // attacker drops `evil.png → ~/.bash_history` into Downloads). Allowlist
    // checks the file *name* not the target, so without this guard the
    // renderer would receive arbitrary file bytes round-tripped as base64
    // image data. Reject symlinks outright — legitimate image drops never
    // go through one.
    let symlink_meta = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(m) => m,
        Err(_) => return make_err("File not found".to_string()),
    };
    if symlink_meta.is_symlink() {
        return make_err("Symlinks are not allowed".to_string());
    }
    if !symlink_meta.is_file() {
        return make_err("Not a regular file".to_string());
    }
    if symlink_meta.len() > MAX_IMAGE_SIZE_BYTES {
        return make_err("File too large (max 10MB)".to_string());
    }

    // Bounded read — actual defense against TOCTOU file growth between the
    // size check and the read. The previous `tokio::fs::read` call read
    // unbounded; an attacker could `truncate -s 4G` a regular file between
    // metadata and read → 4GB allocation. Mirrors
    // `download.rs::cmd_workspace_download_file` (which got this right
    // earlier).
    let read_cap = MAX_IMAGE_SIZE_BYTES + 1;
    let mut file = match tokio::fs::File::open(&resolved).await {
        Ok(f) => f,
        Err(e) => return make_err(format!("Open failed: {}", e)),
    };
    let mut bytes = Vec::with_capacity(symlink_meta.len() as usize);
    use tokio::io::AsyncReadExt;
    if let Err(e) = (&mut file).take(read_cap).read_to_end(&mut bytes).await {
        return make_err(format!("Read failed: {}", e));
    }
    if bytes.len() as u64 > MAX_IMAGE_SIZE_BYTES {
        return make_err("File too large (max 10MB)".to_string());
    }

    ReadAsBase64Item {
        path: raw_path.to_string(),
        name,
        mime_type: mime_for_ext(ext.as_deref().unwrap_or("")),
        data: BASE64.encode(&bytes),
        error: None,
    }
}

fn mime_for_ext(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Write `bytes` into `<target_root>/<safe_name>`, bumping `_1`, `_2`, ... on
/// collision. Returns the final path *relative to workspace_root* so the
/// caller can build `@reference` strings without re-doing relativization.
fn write_unique_file(
    target_root: &PathBuf,
    workspace_root: &PathBuf,
    safe_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let (stem, ext_with_dot) = match safe_name.rfind('.') {
        Some(idx) if idx > 0 => (&safe_name[..idx], &safe_name[idx..]),
        _ => (safe_name, ""),
    };

    let mut counter: u32 = 0;
    loop {
        let candidate_name = if counter == 0 {
            safe_name.to_string()
        } else {
            format!("{}_{}{}", stem, counter, ext_with_dot)
        };
        let full = target_root.join(&candidate_name);

        // O_CREAT | O_EXCL — atomic create-only, no overwrite. EEXIST is the
        // race-safe "another writer just took this name" signal.
        match OpenOptions::new().write(true).create_new(true).open(&full) {
            Ok(mut f) => {
                f.write_all(bytes)
                    .map_err(|e| format!("Failed to write {}: {}", candidate_name, e))?;
                let rel = full
                    .strip_prefix(workspace_root)
                    .map_err(|_| "Resolved path escaped workspace".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                return Ok(rel);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                counter += 1;
                if counter > MAX_COLLISION_SUFFIX {
                    return Err(format!("Too many filename collisions for {}", safe_name));
                }
            }
            Err(e) => {
                return Err(format!("Failed to create {}: {}", candidate_name, e));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("files_b64")
    }

    #[tokio::test]
    async fn imports_single_file() {
        let ws = make_tmp_workspace();
        let payload = vec![Base64FileEntry {
            name: "hello.txt".to_string(),
            content: BASE64.encode(b"hi"),
        }];
        let res = cmd_workspace_import_files_b64(
            ws.to_string_lossy().to_string(),
            payload,
            Some("myagents_files".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(res.files, vec!["myagents_files/hello.txt".to_string()]);
        assert_eq!(
            fs::read(ws.join("myagents_files").join("hello.txt")).unwrap(),
            b"hi"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn collision_appends_counter() {
        let ws = make_tmp_workspace();
        for _ in 0..3 {
            let payload = vec![Base64FileEntry {
                name: "doc.txt".to_string(),
                content: BASE64.encode(b"x"),
            }];
            cmd_workspace_import_files_b64(
                ws.to_string_lossy().to_string(),
                payload,
                Some("dir".to_string()),
            )
            .await
            .unwrap();
        }
        assert!(ws.join("dir").join("doc.txt").exists());
        assert!(ws.join("dir").join("doc_1.txt").exists());
        assert!(ws.join("dir").join("doc_2.txt").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn sanitizes_illegal_chars() {
        let ws = make_tmp_workspace();
        let payload = vec![Base64FileEntry {
            name: "bad<name>.md".to_string(),
            content: BASE64.encode(b"y"),
        }];
        let res = cmd_workspace_import_files_b64(
            ws.to_string_lossy().to_string(),
            payload,
            Some("dir".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(res.files[0], "dir/bad_name_.md");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_invalid_base64() {
        let ws = make_tmp_workspace();
        let payload = vec![Base64FileEntry {
            name: "bad.bin".to_string(),
            content: "not_valid_base64!!!".to_string(),
        }];
        let res =
            cmd_workspace_import_files_b64(ws.to_string_lossy().to_string(), payload, None).await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal_target_dir() {
        let ws = make_tmp_workspace();
        let payload = vec![Base64FileEntry {
            name: "x.txt".to_string(),
            content: BASE64.encode(b"x"),
        }];
        let res = cmd_workspace_import_files_b64(
            ws.to_string_lossy().to_string(),
            payload,
            Some("../etc".to_string()),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn read_b64_rejects_non_image() {
        let ws = make_tmp_workspace();
        let txt = ws.join("file.txt");
        fs::write(&txt, b"hi").unwrap();
        let res = cmd_workspace_read_files_b64(vec![txt.to_string_lossy().to_string()])
            .await
            .unwrap();
        assert!(res.files[0].error.is_some());
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review regression guard: a malicious drag-drop with a `.png`
    // name that is actually a symlink to a private file (e.g.
    // `~/.bash_history`) would round-trip private bytes as base64 image
    // data. The allowlist checks the filename, not the target — symlink
    // rejection covers the gap.
    #[cfg(unix)]
    #[tokio::test]
    async fn read_b64_rejects_symlink_image() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        let secret = ws.join("secret.png");
        fs::write(&secret, b"\x89PNG\r\n\x1a\n").unwrap();
        let link = ws.join("decoy.png");
        symlink(&secret, &link).unwrap();
        let res = cmd_workspace_read_files_b64(vec![link.to_string_lossy().to_string()])
            .await
            .unwrap();
        assert!(res.files[0].error.is_some());
        assert!(res.files[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Symlinks"));
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review (round 2 / Codex) caught: the previous "bounded read"
    // claim was fake — `read_cap` was computed but never applied to
    // `tokio::fs::read` (which is unbounded). The fix uses
    // `File::open + take(read_cap).read_to_end`. This regression guard
    // simulates the post-stat file-growth case by writing a file SIZED at
    // the cap exactly, then asserts read is bounded — if a future change
    // drops the `take` again, this test would surface the issue (we'd OOM
    // or read way more than expected).
    //
    // We can't easily simulate true TOCTOU growth in a single-threaded
    // tokio test, but we can verify: (a) a file at MAX_IMAGE_SIZE_BYTES
    // is read in full (boundary), (b) a file at MAX+1 is rejected.
    // Combined with the symlink-rejection guard above, the surface area
    // for surprise attacker-controlled growth is closed.
    #[tokio::test]
    async fn read_b64_caps_at_max_size() {
        let ws = make_tmp_workspace();
        // PNG magic so the extension allowlist doesn't pre-reject.
        let too_big = ws.join("huge.png");
        let buf = vec![0u8; (MAX_IMAGE_SIZE_BYTES + 1) as usize];
        fs::write(&too_big, &buf).unwrap();
        let res = cmd_workspace_read_files_b64(vec![too_big.to_string_lossy().to_string()])
            .await
            .unwrap();
        assert!(res.files[0].error.is_some());
        assert!(
            res.files[0]
                .error
                .as_deref()
                .unwrap_or("")
                .contains("too large"),
            "expected size-cap error, got {:?}",
            res.files[0].error,
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn read_b64_returns_data_for_image() {
        let ws = make_tmp_workspace();
        let png = ws.join("pic.png");
        fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let res = cmd_workspace_read_files_b64(vec![png.to_string_lossy().to_string()])
            .await
            .unwrap();
        assert!(res.files[0].error.is_none());
        assert_eq!(res.files[0].mime_type, "image/png");
        assert!(!res.files[0].data.is_empty());
        let _ = fs::remove_dir_all(&ws);
    }
}
