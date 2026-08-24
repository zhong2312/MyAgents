//! File / folder CRUD: new-file, new-folder, rename, move.
//!
//! `delete` already lives in `delete.rs` (used by SimpleChatInput's Cmd+Z
//! undo). The DirectoryPanel calls the same `cmd_workspace_delete`.

use std::fs;
use std::path::Path;

use serde::Serialize;

use super::path_safety::{
    reject_managed_global_skill_mutation, resolve_inside_workspace, validate_item_name,
    validate_workspace_root,
};

/// Symlink-aware existence probe. `Path::exists()` follows symlinks, which
/// returns `false` for a broken symlink — see CLAUDE.md v0.2.5 red-line. For
/// "is this slot occupied" checks before a write op we need the inode-level
/// answer: is there ANY directory entry at this path. `symlink_metadata`
/// gives us that without traversing the link.
fn slot_occupied(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePathResult {
    pub success: bool,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub success: bool,
    pub new_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedFile {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub success: bool,
    pub moved_files: Vec<MovedFile>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn cmd_workspace_new_file(
    workspace: String,
    parent_dir: String,
    name: String,
) -> Result<CreatePathResult, String> {
    validate_item_name(name.trim())?;
    let workspace_root = validate_workspace_root(&workspace)?;
    let parent = resolve_inside_workspace(&workspace_root, parent_dir.trim())?;
    if !parent.is_dir() {
        return Err("Parent directory does not exist".to_string());
    }
    let target = parent.join(name.trim());
    reject_managed_global_skill_mutation(&workspace_root, &target)?;
    if slot_occupied(&target) {
        return Err("File already exists".to_string());
    }
    fs::write(&target, "").map_err(|e| format!("Failed to create file: {}", e))?;
    let rel = target
        .strip_prefix(&workspace_root)
        .map_err(|_| "Path escaped workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(CreatePathResult {
        success: true,
        path: rel,
    })
}

#[tauri::command]
pub async fn cmd_workspace_new_folder(
    workspace: String,
    parent_dir: String,
    name: String,
) -> Result<CreatePathResult, String> {
    validate_item_name(name.trim())?;
    let workspace_root = validate_workspace_root(&workspace)?;
    let parent = resolve_inside_workspace(&workspace_root, parent_dir.trim())?;
    if !parent.is_dir() {
        return Err("Parent directory does not exist".to_string());
    }
    let target = parent.join(name.trim());
    reject_managed_global_skill_mutation(&workspace_root, &target)?;
    if slot_occupied(&target) {
        return Err("Folder already exists".to_string());
    }
    fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder: {}", e))?;
    let rel = target
        .strip_prefix(&workspace_root)
        .map_err(|_| "Path escaped workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(CreatePathResult {
        success: true,
        path: rel,
    })
}

#[tauri::command]
pub async fn cmd_workspace_rename(
    workspace: String,
    old_path: String,
    new_name: String,
) -> Result<RenameResult, String> {
    validate_item_name(new_name.trim())?;
    let workspace_root = validate_workspace_root(&workspace)?;
    let old_resolved = resolve_inside_workspace(&workspace_root, old_path.trim())?;
    if !slot_occupied(&old_resolved) {
        return Err("File or folder not found".to_string());
    }
    let parent = old_resolved
        .parent()
        .ok_or_else(|| "No parent directory".to_string())?;
    let new_resolved = parent.join(new_name.trim());
    reject_managed_global_skill_mutation(&workspace_root, &old_resolved)?;
    reject_managed_global_skill_mutation(&workspace_root, &new_resolved)?;
    if slot_occupied(&new_resolved) {
        return Err("Target name already exists".to_string());
    }
    fs::rename(&old_resolved, &new_resolved).map_err(|e| format!("Rename failed: {}", e))?;
    let rel = new_resolved
        .strip_prefix(&workspace_root)
        .map_err(|_| "Path escaped workspace".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(RenameResult {
        success: true,
        new_path: rel,
    })
}

#[tauri::command]
pub async fn cmd_workspace_move(
    workspace: String,
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<MoveResult, String> {
    if source_paths.is_empty() {
        return Err("sourcePaths is required".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, target_dir.trim())?;
    reject_managed_global_skill_mutation(&workspace_root, &target)?;
    if !target.is_dir() {
        return Err("Target must be an existing directory".to_string());
    }

    let mut moved: Vec<MovedFile> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for src in source_paths {
        let trimmed = src.trim();
        let resolved_src = match resolve_inside_workspace(&workspace_root, trimmed) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("Invalid source {}: {}", trimmed, e));
                continue;
            }
        };
        if !slot_occupied(&resolved_src) {
            errors.push(format!("Not found: {}", trimmed));
            continue;
        }
        if let Err(error) = reject_managed_global_skill_mutation(&workspace_root, &resolved_src) {
            errors.push(format!("Cannot move {}: {}", trimmed, error));
            continue;
        }
        // Block moving a dir into itself / its descendant. Use Path::starts_with
        // (component-aware) instead of string comparison via `.display()` —
        // `.display()` is lossy on non-UTF-8 filenames and silently substitutes
        // U+FFFD, which would let a corrupt-name dir slip past this check.
        // Path::starts_with covers both equality and descendant cases at the
        // component level.
        if target.starts_with(&resolved_src) {
            errors.push(format!("Cannot move folder into itself: {}", trimmed));
            continue;
        }
        let item_name = match resolved_src.file_name() {
            Some(s) => s.to_string_lossy().to_string(),
            None => {
                errors.push(format!("Cannot determine filename for {}", trimmed));
                continue;
            }
        };
        // Skip no-op (already in target).
        if resolved_src.parent() == Some(target.as_path()) {
            continue;
        }

        let mut destination = target.join(&item_name);
        if slot_occupied(&destination) {
            // Auto-rename `name (1).ext`, `name (2).ext`, ...
            let stem;
            let ext;
            match item_name.rfind('.') {
                Some(idx) if idx > 0 => {
                    stem = &item_name[..idx];
                    ext = &item_name[idx..];
                }
                _ => {
                    stem = item_name.as_str();
                    ext = "";
                }
            }
            // Cap at 9999 collisions; if all slots are taken, refuse rather
            // than silently overwriting (cross-review caught: previous loop
            // would fall through with `destination` still pointing at the
            // colliding path, and `fs::rename` overwrites on Unix).
            let mut found = false;
            for counter in 1..=9999u32 {
                let candidate = format!("{} ({}){}", stem, counter, ext);
                let candidate_path = target.join(&candidate);
                if !slot_occupied(&candidate_path) {
                    destination = candidate_path;
                    found = true;
                    break;
                }
            }
            if !found {
                errors.push(format!(
                    "Too many name collisions in target for {}",
                    trimmed
                ));
                continue;
            }
        }

        if let Err(error) = reject_managed_global_skill_mutation(&workspace_root, &destination) {
            errors.push(format!("Cannot move {}: {}", trimmed, error));
            continue;
        }

        if let Err(e) = fs::rename(&resolved_src, &destination) {
            errors.push(format!("Move {} failed: {}", trimmed, e));
            continue;
        }

        let rel_old = relativize(&resolved_src, &workspace_root);
        let rel_new = relativize(&destination, &workspace_root);
        moved.push(MovedFile {
            old_path: rel_old,
            new_path: rel_new,
        });
    }

    Ok(MoveResult {
        success: true,
        moved_files: moved,
        errors,
    })
}

fn relativize(p: &Path, root: &Path) -> String {
    p.strip_prefix(root)
        .map(|x| x.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn creates_file() {
        let ws = make_test_workspace("crud_new_file");
        let res = cmd_workspace_new_file(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "hello.txt".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.path, "hello.txt");
        assert!(ws.join("hello.txt").is_file());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_existing_file() {
        let ws = make_test_workspace("crud_existing_file");
        fs::write(ws.join("a.txt"), "").unwrap();
        let res = cmd_workspace_new_file(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "a.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_invalid_name() {
        let ws = make_test_workspace("crud_invalid_name");
        let res = cmd_workspace_new_file(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "../escape.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn creates_folder() {
        let ws = make_test_workspace("crud_new_folder");
        let res = cmd_workspace_new_folder(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "subdir".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.path, "subdir");
        assert!(ws.join("subdir").is_dir());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn renames_file() {
        let ws = make_test_workspace("crud_rename");
        fs::write(ws.join("old.txt"), "x").unwrap();
        let res = cmd_workspace_rename(
            ws.to_string_lossy().to_string(),
            "old.txt".to_string(),
            "new.txt".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.new_path, "new.txt");
        assert!(ws.join("new.txt").is_file());
        assert!(!ws.join("old.txt").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_rename_collision() {
        let ws = make_test_workspace("crud_rename_collision");
        fs::write(ws.join("a.txt"), "").unwrap();
        fs::write(ws.join("b.txt"), "").unwrap();
        let res = cmd_workspace_rename(
            ws.to_string_lossy().to_string(),
            "a.txt".to_string(),
            "b.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn moves_files() {
        let ws = make_test_workspace("crud_move");
        fs::create_dir_all(ws.join("dst")).unwrap();
        fs::write(ws.join("a.txt"), "a").unwrap();
        fs::write(ws.join("b.txt"), "b").unwrap();

        let res = cmd_workspace_move(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string(), "b.txt".to_string()],
            "dst".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.moved_files.len(), 2);
        assert!(ws.join("dst/a.txt").is_file());
        assert!(ws.join("dst/b.txt").is_file());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn move_auto_renames_collision() {
        let ws = make_test_workspace("crud_move_collision");
        fs::create_dir_all(ws.join("dst")).unwrap();
        fs::write(ws.join("dst/a.txt"), "existing").unwrap();
        fs::write(ws.join("a.txt"), "new").unwrap();

        let res = cmd_workspace_move(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string()],
            "dst".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.moved_files[0].new_path, "dst/a (1).txt");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn move_blocks_dir_into_self() {
        let ws = make_test_workspace("crud_move_self");
        fs::create_dir_all(ws.join("a/b")).unwrap();
        let res = cmd_workspace_move(
            ws.to_string_lossy().to_string(),
            vec!["a".to_string()],
            "a/b".to_string(),
        )
        .await
        .unwrap();
        // Move was attempted but rejected per-item; errors carry the reason.
        assert!(res.moved_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review regression guard: pre-fix code used `Path::exists()` which
    // follows symlinks → broken-symlink at a slot returns false → caller
    // proceeds with `fs::write` / `fs::create_dir_all` and gets a confusing
    // error. CLAUDE.md v0.2.5 red-line. The slot_occupied helper uses
    // `symlink_metadata` so a broken symlink correctly registers as "occupied".
    #[cfg(unix)]
    #[tokio::test]
    async fn new_file_rejects_broken_symlink_slot() {
        use std::os::unix::fs::symlink;
        let ws = make_test_workspace("crud_broken_slot_file");
        symlink("/nonexistent/target", ws.join("foo.txt")).unwrap();
        let res = cmd_workspace_new_file(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "foo.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("already exists"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn new_folder_rejects_broken_symlink_slot() {
        use std::os::unix::fs::symlink;
        let ws = make_test_workspace("crud_broken_slot_folder");
        symlink("/nonexistent/target", ws.join("bar")).unwrap();
        let res = cmd_workspace_new_folder(
            ws.to_string_lossy().to_string(),
            "".to_string(),
            "bar".to_string(),
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("already exists"));
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review caught: `.display()` is lossy on non-UTF-8 filenames; the
    // pre-fix into-self check used string formatting via `.display()` which
    // would fail open on corrupt names. `Path::starts_with` is component-aware.
    #[tokio::test]
    async fn move_into_self_uses_component_check() {
        let ws = make_test_workspace("crud_move_self_components");
        // Edge: directory whose parent IS the source — three-level nest.
        fs::create_dir_all(ws.join("outer/inner/deep")).unwrap();
        let res = cmd_workspace_move(
            ws.to_string_lossy().to_string(),
            vec!["outer".to_string()],
            "outer/inner/deep".to_string(),
        )
        .await
        .unwrap();
        assert!(res.moved_files.is_empty());
        assert_eq!(res.errors.len(), 1);
        assert!(res.errors[0].contains("itself"));
        let _ = fs::remove_dir_all(&ws);
    }
}
