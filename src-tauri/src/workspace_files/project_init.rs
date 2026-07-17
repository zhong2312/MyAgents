//! Atomic initialization for a brand-new workspace directory.
//!
//! Workbenches provide a declarative UTF-8 text blueprint. The host validates
//! it, builds the complete project in a sibling staging directory, optionally
//! initializes Git, and only then renames it to the requested workspace path.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ulog_info;

use super::path_safety::{
    resolve_inside_workspace, validate_item_name, validate_new_workspace_root,
};

const INITIALIZATION_VERSION: u32 = 1;
const MAX_DIRECTORIES: usize = 256;
const MAX_FILES: usize = 256;
const MAX_RELATIVE_PATH_BYTES: usize = 512;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_TOTAL_CONTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectTextFile {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectInitialization {
    version: u32,
    #[serde(default)]
    directories: Vec<String>,
    #[serde(default)]
    files: Vec<WorkspaceProjectTextFile>,
    #[serde(default)]
    initialize_git: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeWorkspaceProjectResult {
    workspace_path: String,
    git_initialized: bool,
    directories_created: usize,
    files_created: usize,
}

struct ValidatedBlueprint {
    directories: Vec<String>,
    files: Vec<WorkspaceProjectTextFile>,
    initialize_git: bool,
}

fn path_identity(path: &str) -> String {
    #[cfg(windows)]
    {
        return path.to_lowercase();
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn validate_relative_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.len() > MAX_RELATIVE_PATH_BYTES {
        return Err("Project path is empty or too long".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err(format!(
            "Project path must be relative and use '/' separators: {}",
            path
        ));
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return Err(format!("Project path contains an empty segment: {}", path));
    }
    for segment in &segments {
        validate_item_name(segment)
            .map_err(|error| format!("Invalid project path '{}': {}", path, error))?;
    }
    Ok(segments.join("/"))
}

fn path_ancestors(path: &str) -> impl Iterator<Item = String> + '_ {
    let mut components = path.split('/').collect::<Vec<_>>();
    components.pop();
    (1..=components.len()).map(move |length| components[..length].join("/"))
}

fn validate_blueprint(
    initialization: WorkspaceProjectInitialization,
) -> Result<ValidatedBlueprint, String> {
    if initialization.version != INITIALIZATION_VERSION {
        return Err(format!(
            "Unsupported project initialization version: {}",
            initialization.version
        ));
    }
    if initialization.directories.len() > MAX_DIRECTORIES {
        return Err(format!(
            "Project contains more than {} directories",
            MAX_DIRECTORIES
        ));
    }
    if initialization.files.len() > MAX_FILES {
        return Err(format!("Project contains more than {} files", MAX_FILES));
    }

    let mut directory_ids = HashSet::new();
    let mut directories = Vec::with_capacity(initialization.directories.len());
    for path in initialization.directories {
        let normalized = validate_relative_path(&path)?;
        if !directory_ids.insert(path_identity(&normalized)) {
            return Err(format!("Duplicate project directory: {}", normalized));
        }
        directories.push(normalized);
    }

    let mut total_content_bytes = 0usize;
    let mut file_ids = HashSet::new();
    let mut files = Vec::with_capacity(initialization.files.len());
    for file in initialization.files {
        let normalized = validate_relative_path(&file.path)?;
        let file_bytes = file.content.len();
        if file_bytes > MAX_FILE_BYTES {
            return Err(format!("Project file is too large: {}", normalized));
        }
        total_content_bytes = total_content_bytes
            .checked_add(file_bytes)
            .ok_or_else(|| "Project content size overflow".to_string())?;
        if total_content_bytes > MAX_TOTAL_CONTENT_BYTES {
            return Err("Project initialization content exceeds 2 MiB".to_string());
        }
        let identity = path_identity(&normalized);
        if !file_ids.insert(identity.clone()) {
            return Err(format!("Duplicate project file: {}", normalized));
        }
        if directory_ids.contains(&identity) {
            return Err(format!(
                "Project path is both file and directory: {}",
                normalized
            ));
        }
        files.push(WorkspaceProjectTextFile {
            path: normalized,
            content: file.content,
        });
    }

    for path in directories
        .iter()
        .chain(files.iter().map(|file| &file.path))
    {
        for ancestor in path_ancestors(path) {
            if file_ids.contains(&path_identity(&ancestor)) {
                return Err(format!(
                    "Project file cannot contain another entry: {}",
                    ancestor
                ));
            }
        }
    }

    directories.sort_by_key(|path| path.matches('/').count());
    Ok(ValidatedBlueprint {
        directories,
        files,
        initialize_git: initialization.initialize_git,
    })
}

fn create_staging_directory(parent: &Path) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let candidate = parent.join(format!(
            ".myagents-create-{}",
            uuid::Uuid::new_v4().simple()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create project staging directory: {}",
                    error
                ))
            }
        }
    }
    Err("Failed to allocate a project staging directory".to_string())
}

fn write_project_file(root: &Path, file: &WorkspaceProjectTextFile) -> Result<(), String> {
    let target = resolve_inside_workspace(root, &file.path)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("Project file has no parent: {}", file.path))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create directory for '{}': {}", file.path, error))?;
    let mut handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| format!("Failed to create project file '{}': {}", file.path, error))?;
    handle
        .write_all(file.content.as_bytes())
        .map_err(|error| format!("Failed to write project file '{}': {}", file.path, error))?;
    handle
        .sync_all()
        .map_err(|error| format!("Failed to flush project file '{}': {}", file.path, error))?;
    Ok(())
}

fn initialize_git(root: &Path) -> Result<(), String> {
    let git = crate::system_binary::find("git")
        .ok_or_else(|| "Git was requested but no Git executable was found".to_string())?;
    let mut command = crate::process_cmd::new(git);
    command.arg("init").arg("--quiet").current_dir(root);
    crate::proxy_config::apply_to_subprocess(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Failed to start Git: {}", error))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Git initialization failed with status {}", output.status)
    } else {
        format!("Git initialization failed: {}", stderr)
    })
}

fn initialize_project_blocking(
    workspace_path: String,
    initialization: WorkspaceProjectInitialization,
) -> Result<InitializeWorkspaceProjectResult, String> {
    let mut target = validate_new_workspace_root(&workspace_path)?;
    let blueprint = validate_blueprint(initialization)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Workspace parent directory is required".to_string())?
        .to_path_buf();
    fs::create_dir_all(&parent)
        .map_err(|error| format!("Failed to create workspace parent directory: {}", error))?;

    // Re-resolve after creating missing parents. This catches a path component
    // being redirected between validation and creation before any project file
    // is written.
    let resolved_after_creation = validate_new_workspace_root(&workspace_path)?;
    if resolved_after_creation != target {
        return Err("Workspace parent changed during project creation".to_string());
    }
    target = resolved_after_creation;
    let staging = create_staging_directory(&parent)?;

    let result = (|| {
        for directory in &blueprint.directories {
            let path = resolve_inside_workspace(&staging, directory)?;
            fs::create_dir_all(&path).map_err(|error| {
                format!(
                    "Failed to create project directory '{}': {}",
                    directory, error
                )
            })?;
        }
        for file in &blueprint.files {
            write_project_file(&staging, file)?;
        }
        if blueprint.initialize_git {
            initialize_git(&staging)?;
        }

        match fs::symlink_metadata(&target) {
            Ok(_) => return Err(format!("Workspace already exists: {}", workspace_path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect workspace path: {}", error)),
        }
        fs::rename(&staging, &target)
            .map_err(|error| format!("Failed to commit project directory: {}", error))?;

        ulog_info!(
            "[workspace] Initialized project at {:?}: {} directories, {} files, git={}",
            target,
            blueprint.directories.len(),
            blueprint.files.len(),
            blueprint.initialize_git
        );
        Ok(InitializeWorkspaceProjectResult {
            workspace_path: target.to_string_lossy().to_string(),
            git_initialized: blueprint.initialize_git,
            directories_created: blueprint.directories.len(),
            files_created: blueprint.files.len(),
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[tauri::command]
pub async fn cmd_workspace_initialize_project(
    workspace_path: String,
    initialization: WorkspaceProjectInitialization,
) -> Result<InitializeWorkspaceProjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        initialize_project_blocking(workspace_path, initialization)
    })
    .await
    .map_err(|error| format!("Project initialization task failed: {}", error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    fn blueprint(files: Vec<(&str, &str)>) -> WorkspaceProjectInitialization {
        WorkspaceProjectInitialization {
            version: 1,
            directories: vec!["manuscript/chapters".to_string(), "knowledge".to_string()],
            files: files
                .into_iter()
                .map(|(path, content)| WorkspaceProjectTextFile {
                    path: path.to_string(),
                    content: content.to_string(),
                })
                .collect(),
            initialize_git: false,
        }
    }

    #[test]
    fn initializes_project_and_commits_complete_directory() {
        let parent = make_test_workspace("project_init_success");
        let target = parent.join("novel");
        let result = initialize_project_blocking(
            target.to_string_lossy().to_string(),
            blueprint(vec![("novel.json", "{}\n"), ("story/core.md", "# Core\n")]),
        )
        .unwrap();

        assert_eq!(result.files_created, 2);
        assert!(target.join("manuscript/chapters").is_dir());
        assert_eq!(
            fs::read_to_string(target.join("story/core.md")).unwrap(),
            "# Core\n"
        );
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn creates_missing_save_directory_before_project_commit() {
        let parent = make_test_workspace("project_init_missing_parent");
        let target = parent.join("novels").join("novel");
        initialize_project_blocking(
            target.to_string_lossy().to_string(),
            blueprint(vec![("novel.json", "{}\n")]),
        )
        .unwrap();

        assert!(target.join("novel.json").is_file());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn rejects_existing_target_without_modifying_it() {
        let parent = make_test_workspace("project_init_existing");
        let target = parent.join("novel");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "keep").unwrap();

        let result = initialize_project_blocking(
            target.to_string_lossy().to_string(),
            blueprint(vec![("novel.json", "{}")]),
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn rejects_traversal_before_creating_target() {
        let parent = make_test_workspace("project_init_traversal");
        let target = parent.join("novel");
        let result = initialize_project_blocking(
            target.to_string_lossy().to_string(),
            blueprint(vec![("../escape.md", "x")]),
        );

        assert!(result.is_err());
        assert!(!target.exists());
        assert!(!parent.join("escape.md").exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn rejects_file_directory_collision_before_creating_target() {
        let parent = make_test_workspace("project_init_collision");
        let target = parent.join("novel");
        let result = initialize_project_blocking(
            target.to_string_lossy().to_string(),
            blueprint(vec![("story", "file"), ("story/core.md", "nested")]),
        );

        assert!(result.is_err());
        assert!(!target.exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn accepts_prompt_registry_larger_than_legacy_limit() {
        let registry = "x".repeat(170 * 1024);
        let validated = validate_blueprint(blueprint(vec![
            ("prompts/registry.json", registry.as_str()),
            ("novel.json", "{}\n"),
        ]))
        .unwrap();

        assert_eq!(validated.files.len(), 2);
    }

    #[test]
    fn rejects_file_over_project_initialization_limit() {
        let oversized = "x".repeat(MAX_FILE_BYTES + 1);
        let result = validate_blueprint(blueprint(vec![(
            "prompts/registry.json",
            oversized.as_str(),
        )]));

        assert!(result
            .err()
            .expect("oversized file should be rejected")
            .contains("Project file is too large: prompts/registry.json"));
    }

    #[test]
    fn rejects_total_content_over_project_initialization_limit() {
        let content = "x".repeat(MAX_FILE_BYTES);
        let files = (0..9)
            .map(|index| (format!("prompts/{index}.md"), content.clone()))
            .collect::<Vec<_>>();
        let initialization = WorkspaceProjectInitialization {
            version: 1,
            directories: Vec::new(),
            files: files
                .into_iter()
                .map(|(path, content)| WorkspaceProjectTextFile { path, content })
                .collect(),
            initialize_git: false,
        };

        assert!(validate_blueprint(initialization)
            .err()
            .expect("oversized initialization should be rejected")
            .contains("Project initialization content exceeds 2 MiB"));
    }
}
