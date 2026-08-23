//! Workspace file IO commands.
//!
//! This module is the canonical home for "operations against a workspace path"
//! that the SimpleChatInput / DirectoryPanel surfaces depend on. They live in
//! Rust (not the Node sidecar) for two reasons:
//!
//! 1. **Decoupling from Session lifetime** — the launcher input has no Sidecar,
//!    but it still needs to upload files, search by name, and list slash
//!    commands. Putting these operations in Tauri lets every entry point
//!    (launcher, chat tab, future cloud client) call the same functions
//!    without spinning up a Sidecar.
//!
//! 2. **Pit-of-success** — workspace files are an OS resource, not an AI
//!    runtime resource. Anchoring them in Tauri makes "no Sidecar dependency"
//!    the default; trying to call out to HTTP would require a separate, more
//!    awkward path.
//!
//! Architectural rule (CLAUDE.md red-line table): the renderer MUST go through
//! these `cmd_workspace_*` invokes for any workspace file operation. The
//! sidecar HTTP endpoints they replace (`/api/files/import-base64`,
//! `/agent/search-files`, `/api/commands`, …) are scheduled for deletion in
//! Phase E after DirectoryPanel migrates too. ESLint enforcement covers the
//! transition.

pub mod attachment_export;
pub mod check_paths;
pub mod claude_md;
pub mod crud;
pub mod delete;
pub mod download;
pub mod files_b64;
pub mod git_branch;
pub mod gitignore;
pub mod memory_rules;
pub mod path_safety;
pub mod platform_blocks;
pub mod project_init;
pub mod read_preview;
pub mod save_file;
pub mod save_binary;
pub mod search;
pub mod skills_config;
pub mod slash;
pub mod system_open;
#[cfg(test)]
pub(crate) mod test_support;
pub mod transfer;
pub mod tree;
pub mod user_attachments;
pub mod watcher;

// `lib.rs` registers each command with the FULL submodule path
// (e.g. `workspace_files::files_b64::cmd_workspace_import_files_b64`) because
// `tauri::generate_handler!` looks up auto-generated `__cmd__<name>` wrappers
// in the same module that defined the command. Re-exporting at this level
// would NOT bring the wrapper along, so we deliberately don't.
