//! Workspace file index — scans workspace directories, builds per-workspace Tantivy indices.
//!
//! # Incremental refresh
//!
//! The naive "invalidate on every search-mode entry" strategy rebuilds the
//! whole index from scratch every time the user opens the search box, which
//! on a 1000+ file workspace takes ~20 seconds and blocks the UI. The user
//! only cares about one thing: "are recent file changes searchable?" — not
//! "reindex everything just in case".
//!
//! The fix is `refresh_or_create`: walk the tree **metadata only** (cheap —
//! hundreds of ms for thousands of files), diff against a stored
//! `(rel_path → (mtime_ms, size))` map, and only `delete_term + add_document`
//! the files that actually changed. Unchanged files are reused in-place.
//!
//! Foreground search never pays the full build cost. It uses a valid persisted
//! index when one is available; otherwise it falls back to a bounded direct scan
//! of the current filesystem and lets the explicit refresh path build/reconcile
//! the Tantivy index in the background. Files created by the AI between sessions
//! are picked up on the next mode entry automatically.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};

use crate::{ulog_info, ulog_warn};
use serde::{Deserialize, Serialize};

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

use super::schema::{self, FileFields, SCHEMA_VERSION};
use super::searcher::{FileMatchLine, FileSearchHit, FileSearchResult};
use super::tokenizer;
use super::util::{byte_to_utf16, ceil_char_boundary, floor_char_boundary};

/// Directories to skip when scanning workspace files.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "target",
    ".venv",
    "venv",
    ".myagents",
    ".claude",
];

/// File extensions to skip (binary files).
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "avif", "mp3", "mp4", "avi", "mov",
    "wav", "ogg", "webm", "flac", "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst", "pdf",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "woff", "woff2", "ttf", "eot", "otf", "exe",
    "dll", "so", "dylib", "a", "lib", "sqlite", "db", "sqlite3", "pyc", "pyo", "class", "o", "obj",
    "DS_Store",
];

/// Maximum file size to index (1 MB).
const MAX_FILE_SIZE: u64 = 1_048_576;
#[cfg(not(test))]
const DIRECT_SCAN_MAX_FILES: usize = 2_000;
#[cfg(test)]
const DIRECT_SCAN_MAX_FILES: usize = 3;
const FILE_INDEX_MANIFEST: &str = ".file_index_manifest.json";
const SCHEMA_VERSION_FILE: &str = ".schema_version";

/// Per-file staleness fingerprint. Two files with the same `(mtime_ms, size)`
/// are assumed unchanged — good enough because any content edit changes mtime,
/// and the size check catches the rare case of an editor that restores mtime
/// after a modification.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    mtime_ms: u64,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexManifest {
    schema_version: u32,
    workspace: String,
    files: HashMap<String, FileState>,
}

/// Manages per-workspace Tantivy indices.
pub struct FileIndexManager {
    base_dir: PathBuf,
    indices: Mutex<HashMap<String, Arc<Mutex<Option<WorkspaceFileIndex>>>>>,
}

struct WorkspaceFileIndex {
    index: Index,
    reader: IndexReader,
    fields: FileFields,
    /// Snapshot of file state at last index/refresh. Keyed by **relative**
    /// path from workspace root — the same string we store in the doc — so
    /// `delete_term` hits the right entry.
    file_states: HashMap<String, FileState>,
}

impl FileIndexManager {
    pub fn new(base_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&base_dir);
        Self {
            base_dir,
            indices: Mutex::new(HashMap::new()),
        }
    }

    fn slot_for(&self, workspace: &str) -> Result<Arc<Mutex<Option<WorkspaceFileIndex>>>, String> {
        let mut indices = self
            .indices
            .lock()
            .map_err(|e| format!("file index map mutex poisoned: {}", e))?;
        Ok(indices
            .entry(workspace.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone())
    }

    fn index_dir_for_workspace(&self, workspace: &str) -> PathBuf {
        self.base_dir.join(simple_hash(workspace))
    }

    fn load_or_create_index(&self, workspace: &str) -> Result<WorkspaceFileIndex, String> {
        if let Some(index) = self.load_existing_index(workspace)? {
            return Ok(index);
        }
        self.create_and_populate_index(workspace)
    }

    fn load_existing_index(&self, workspace: &str) -> Result<Option<WorkspaceFileIndex>, String> {
        let index_dir = self.index_dir_for_workspace(workspace);
        if !index_dir.join("meta.json").exists() {
            return Ok(None);
        }

        let stored_schema_version = fs::read_to_string(index_dir.join(SCHEMA_VERSION_FILE))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok());
        if stored_schema_version != Some(SCHEMA_VERSION) {
            ulog_warn!(
                "[search] Workspace index schema version mismatch for {} (stored={:?}, current={}); rebuilding",
                workspace,
                stored_schema_version,
                SCHEMA_VERSION
            );
            return Ok(None);
        }

        let manifest_path = index_dir.join(FILE_INDEX_MANIFEST);
        let manifest: FileIndexManifest = match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
        {
            Some(manifest) => manifest,
            None => {
                ulog_warn!(
                    "[search] Workspace index manifest missing or invalid for {}; rebuilding",
                    workspace
                );
                return Ok(None);
            }
        };

        if manifest.schema_version != SCHEMA_VERSION || manifest.workspace != workspace {
            ulog_warn!(
                "[search] Workspace index manifest mismatch for {}; rebuilding",
                workspace
            );
            return Ok(None);
        }

        let (_schema, fields) = schema::file_schema();
        let index = match Index::open_in_dir(&index_dir) {
            Ok(index) => index,
            Err(e) => {
                ulog_warn!(
                    "[search] Failed to open persisted workspace index for {}: {}; rebuilding",
                    workspace,
                    e
                );
                return Ok(None);
            }
        };
        register_file_tokenizer(&index);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| format!("Failed to create file index reader: {}", e))?;

        ulog_info!(
            "[search] Loaded persisted workspace index: {} files for {}",
            manifest.files.len(),
            workspace
        );

        Ok(Some(WorkspaceFileIndex {
            index,
            reader,
            fields,
            file_states: manifest.files,
        }))
    }

    fn persist_manifest(
        &self,
        workspace: &str,
        file_states: &HashMap<String, FileState>,
    ) -> Result<(), String> {
        let index_dir = self.index_dir_for_workspace(workspace);
        fs::create_dir_all(&index_dir)
            .map_err(|e| format!("Failed to create file index dir: {}", e))?;

        let manifest = FileIndexManifest {
            schema_version: SCHEMA_VERSION,
            workspace: workspace.to_string(),
            files: file_states.clone(),
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize file index manifest: {}", e))?;
        let manifest_path = index_dir.join(FILE_INDEX_MANIFEST);
        let tmp_path = index_dir.join(format!(
            "{}.tmp-{}",
            FILE_INDEX_MANIFEST,
            std::process::id()
        ));
        fs::write(&tmp_path, manifest_bytes)
            .map_err(|e| format!("Failed to write file index manifest temp file: {}", e))?;
        fs::rename(&tmp_path, &manifest_path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed to replace file index manifest: {}", e)
        })?;
        fs::write(
            index_dir.join(SCHEMA_VERSION_FILE),
            SCHEMA_VERSION.to_string(),
        )
        .map_err(|e| format!("Failed to write file index schema version: {}", e))?;
        Ok(())
    }

    /// Invalidate an index so it will be rebuilt next time. Used for hard
    /// resets (schema migration, corruption recovery); the common path is
    /// `refresh_or_create` instead.
    pub fn invalidate_index(&self, workspace: &str) -> Result<(), String> {
        let mut indices = self
            .indices
            .lock()
            .map_err(|e| format!("file index map mutex poisoned: {}", e))?;
        if let Some(slot) = indices.remove(workspace) {
            let mut guard = slot
                .lock()
                .map_err(|e| format!("file index slot mutex poisoned: {}", e))?;
            *guard = None;
        }
        drop(indices);

        let index_dir = self.index_dir_for_workspace(workspace);
        match fs::symlink_metadata(&index_dir) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(&index_dir)
                .map_err(|e| format!("Failed to remove workspace file index dir: {}", e))?,
            Ok(_) => fs::remove_file(&index_dir)
                .map_err(|e| format!("Failed to remove workspace file index path: {}", e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to stat workspace file index dir: {}", e)),
        }
        Ok(())
    }

    /// Refresh an existing workspace index incrementally, loading the persisted
    /// Tantivy index + manifest first if this process has not touched the
    /// workspace yet. Returns `(total_files, changed_files)`.
    ///
    /// Called after the foreground search has returned available results.
    /// Cheap on a warm cache (hundreds of ms to stat the tree + zero writes if
    /// nothing changed).
    pub fn refresh_or_create(&self, workspace: &str) -> Result<(usize, usize), String> {
        let slot = self.slot_for(workspace)?;
        let mut slot_guard = slot
            .lock()
            .map_err(|e| format!("file index slot mutex poisoned: {}", e))?;

        if slot_guard.is_none() {
            *slot_guard = Some(self.load_or_create_index(workspace)?);
        }

        let ws_path = Path::new(workspace);
        if !ws_path.is_dir() {
            return Ok((0, 0));
        }

        let start = std::time::Instant::now();
        let discovered = discover_files(ws_path)?;

        // Scope the mutable borrow so we can call ulog_info after.
        let (total, change_count) = {
            let ws_index = slot_guard.as_mut().unwrap();

            let mut to_reindex: Vec<(String, PathBuf)> = Vec::new();
            let mut new_file_states: HashMap<String, FileState> =
                HashMap::with_capacity(discovered.len());

            for (rel_path, (abs_path, state)) in discovered {
                let needs_reindex = match ws_index.file_states.get(&rel_path) {
                    Some(old) => *old != state,
                    None => true,
                };
                if needs_reindex {
                    to_reindex.push((rel_path.clone(), abs_path));
                }
                new_file_states.insert(rel_path, state);
            }

            let deleted: Vec<String> = ws_index
                .file_states
                .keys()
                .filter(|k| !new_file_states.contains_key(*k))
                .cloned()
                .collect();

            let change_count = to_reindex.len() + deleted.len();
            let total = new_file_states.len();

            if change_count == 0 {
                ws_index.file_states = new_file_states;
                return Ok((total, 0));
            }

            let mut writer = create_file_index_writer(&ws_index.index, 30_000_000, "refresh")?;

            let path_field = ws_index.fields.path;
            for (rel, _) in &to_reindex {
                writer.delete_term(Term::from_field_text(path_field, rel));
            }
            for rel in &deleted {
                writer.delete_term(Term::from_field_text(path_field, rel));
            }

            for (rel_path, abs_path) in &to_reindex {
                let Some(expected_state) = new_file_states.get(rel_path).cloned() else {
                    continue;
                };
                let Some(content) = read_indexable_file(abs_path, &expected_state) else {
                    // File vanished, became non-UTF8, grew past the cap, changed
                    // between discovery/read, or was swapped to a symlink. Drop
                    // from the state map so a future refresh re-adds it if it
                    // settles back into an indexable regular file.
                    new_file_states.remove(rel_path);
                    continue;
                };
                let name = abs_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let _ = writer.add_document(doc!(
                    ws_index.fields.path => rel_path.as_str(),
                    ws_index.fields.name => name.as_str(),
                    ws_index.fields.content => content.as_str(),
                    ws_index.fields.ext => ext.as_str(),
                ));
            }

            writer
                .commit()
                .map_err(|e| format!("commit failed: {}", e))?;
            drop(writer);

            ws_index
                .reader
                .reload()
                .map_err(|e| format!("reader reload failed: {}", e))?;
            ws_index.file_states = new_file_states;
            self.persist_manifest(workspace, &ws_index.file_states)
                .map_err(|e| {
                    format!(
                        "Failed to persist workspace index manifest after refresh: {}",
                        e
                    )
                })?;

            (total, change_count)
        };

        ulog_info!(
            "[search] Refreshed workspace index: {} changed, {} total for {} ({:.0}ms)",
            change_count,
            total,
            workspace,
            start.elapsed().as_secs_f64() * 1000.0
        );

        Ok((total, change_count))
    }

    /// Search workspace files. Loads a persisted index on first access. If the
    /// index is missing, stale, or currently being built/refreshed, fall back to
    /// a bounded direct scan instead of making the foreground query wait for a
    /// full Tantivy build.
    pub fn search(
        &self,
        query: &str,
        workspace: &str,
        limit: usize,
        max_matches_per_file: usize,
    ) -> Result<FileSearchResult, String> {
        let start = std::time::Instant::now();
        let ws_path = Path::new(workspace);

        let slot = self.slot_for(workspace)?;
        let mut slot_guard = match slot.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                ulog_info!(
                    "[search] Workspace index busy for {}; using direct scan fallback",
                    workspace
                );
                return direct_search_workspace_files(
                    query,
                    ws_path,
                    limit,
                    max_matches_per_file,
                    start,
                );
            }
            Err(TryLockError::Poisoned(e)) => {
                return Err(format!("file index slot mutex poisoned: {}", e));
            }
        };

        if slot_guard.is_none() {
            match self.load_existing_index(workspace)? {
                Some(index) => {
                    *slot_guard = Some(index);
                }
                None => {
                    ulog_info!(
                        "[search] No warm workspace index for {}; using direct scan fallback",
                        workspace
                    );
                    return direct_search_workspace_files(
                        query,
                        ws_path,
                        limit,
                        max_matches_per_file,
                        start,
                    );
                }
            }
        }

        let ws_index = slot_guard
            .as_ref()
            .ok_or_else(|| format!("Index not found for workspace: {}", workspace))?;

        let f = &ws_index.fields;
        let searcher = ws_index.reader.searcher();

        let mut parser = QueryParser::for_index(&ws_index.index, vec![f.name, f.content]);
        parser.set_field_boost(f.name, 2.0);

        let tantivy_query = parser
            .parse_query(query)
            .map_err(|e| format!("Query parse error: {}", e))?;

        let top_docs = searcher
            .search(&tantivy_query, &TopDocs::with_limit(limit))
            .map_err(|e| format!("Search error: {}", e))?;

        let query_lower = query.to_lowercase();
        let mut hits = Vec::new();
        let mut total_matches = 0;

        for (_score, doc_addr) in top_docs {
            let doc_result = searcher.doc::<tantivy::TantivyDocument>(doc_addr);
            let doc = match doc_result {
                Ok(d) => d,
                Err(_) => continue,
            };

            let path = get_text_field(&doc, f.path);
            let name = get_text_field(&doc, f.name);
            let content = get_text_field(&doc, f.content);

            // Find matching lines from the actual file content
            let matches = find_matching_lines(&content, &query_lower, max_matches_per_file);

            let match_count = matches.len();
            total_matches += match_count;

            // If no line-level matches but the name matches, show it as a filename-only match
            if match_count > 0 || name.to_lowercase().contains(&query_lower) {
                hits.push(FileSearchHit {
                    path,
                    name,
                    match_count: match_count.max(1),
                    matches,
                });
            }
        }

        Ok(FileSearchResult {
            total_files: hits.len(),
            total_matches,
            hits,
            query_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Create and populate a workspace file index from scratch. Returns the
    /// number of files indexed.
    fn create_and_populate_index(&self, workspace: &str) -> Result<WorkspaceFileIndex, String> {
        // Use a hash of the workspace path as directory name
        let index_dir = self.index_dir_for_workspace(workspace);
        let _ = fs::create_dir_all(&index_dir);

        let (schema, fields) = schema::file_schema();

        // Create a fresh index only from the explicit refresh path. Foreground
        // search uses valid persisted indices or direct-scan fallback so a large
        // cold workspace cannot keep the UI stuck on "搜索中".
        let index = Index::create_in_dir(&index_dir, schema.clone())
            .or_else(|_| {
                // If directory exists with incompatible index, recreate
                let _ = fs::remove_dir_all(&index_dir);
                let _ = fs::create_dir_all(&index_dir);
                Index::create_in_dir(&index_dir, schema)
            })
            .map_err(|e| format!("Failed to create file index: {}", e))?;

        // MUST register tokenizer before creating the writer — the writer
        // snapshots the tokenizer manager at construction time, so late
        // registration would leave docs tokenized with the default English
        // tokenizer and jieba would never run.
        register_file_tokenizer(&index);

        let mut writer = create_file_index_writer(&index, 30_000_000, "initial build")?;

        // Walk the tree metadata-first, then read + index each discovered file.
        let ws_path = Path::new(workspace);
        let file_states = if ws_path.is_dir() {
            let discovered = discover_files(ws_path)?;
            let mut states: HashMap<String, FileState> = HashMap::with_capacity(discovered.len());
            for (rel_path, (abs_path, state)) in discovered {
                let Some(content) = read_indexable_file(&abs_path, &state) else {
                    continue;
                };
                let name = abs_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let _ = writer.add_document(doc!(
                    fields.path => rel_path.as_str(),
                    fields.name => name.as_str(),
                    fields.content => content.as_str(),
                    fields.ext => ext.as_str(),
                ));
                states.insert(rel_path, state);
            }
            states
        } else {
            HashMap::new()
        };

        writer
            .commit()
            .map_err(|e| format!("commit failed: {}", e))?;
        // Drop the writer after the initial commit — subsequent incremental
        // refreshes open a short-lived writer of their own. Keeping one live
        // would waste ~30 MB of heap per workspace for no benefit.
        drop(writer);

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| format!("Failed to create file index reader: {}", e))?;

        let workspace_index = WorkspaceFileIndex {
            index,
            reader,
            fields,
            file_states,
        };

        self.persist_manifest(workspace, &workspace_index.file_states)
            .map_err(|e| {
                format!(
                    "Failed to persist workspace index manifest after build: {}",
                    e
                )
            })?;

        ulog_info!(
            "[search] Indexed {} files for workspace: {}",
            workspace_index.file_states.len(),
            workspace
        );

        Ok(workspace_index)
    }
}

/// Walk a workspace tree metadata-only and return `rel_path → (abs_path, FileState)`
/// for every file that passes the index filters (skip dirs, binary ext, hidden,
/// size cap). No file contents are read.
fn discover_files(root: &Path) -> Result<HashMap<String, (PathBuf, FileState)>, String> {
    let mut out = HashMap::new();
    walk_dir(root, root, &mut out);
    Ok(out)
}

fn walk_dir(root: &Path, dir: &Path, out: &mut HashMap<String, (PathBuf, FileState)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // permission denied / vanished → skip silently
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            walk_dir(root, &path, out);
            continue;
        }

        // File filters — keep in sync with the skip rules above.
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if is_binary_extension(&ext) {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }

        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_FILE_SIZE {
            continue;
        }

        let state = file_state_from_metadata(&metadata);

        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        out.insert(rel, (path, state));
    }
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| name == *s) || name.starts_with('.')
}

fn is_binary_extension(ext: &str) -> bool {
    BINARY_EXTENSIONS.iter().any(|b| ext == *b)
}

fn direct_search_workspace_files(
    query: &str,
    root: &Path,
    limit: usize,
    max_matches_per_file: usize,
    start: std::time::Instant,
) -> Result<FileSearchResult, String> {
    if query.trim().is_empty() || limit == 0 || !root.is_dir() {
        return Ok(FileSearchResult {
            total_files: 0,
            total_matches: 0,
            hits: Vec::new(),
            query_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    let query_lower = query.to_lowercase();
    let mut hits = Vec::new();
    let mut total_matches = 0;
    let mut scanned_files = 0;
    let stopped_early = direct_walk_search(
        root,
        root,
        &query_lower,
        limit,
        max_matches_per_file,
        &mut hits,
        &mut total_matches,
        &mut scanned_files,
        DIRECT_SCAN_MAX_FILES,
    );

    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    ulog_info!(
        "[search] Direct workspace scan for {:?} in {} -> {} hits, {} files scanned{} ({:.1}ms)",
        query,
        root.display(),
        hits.len(),
        scanned_files,
        if stopped_early {
            " (stopped early)"
        } else {
            ""
        },
        elapsed_ms
    );

    Ok(FileSearchResult {
        total_files: hits.len(),
        total_matches,
        hits,
        query_time_ms: elapsed_ms,
    })
}

fn direct_walk_search(
    root: &Path,
    dir: &Path,
    query_lower: &str,
    limit: usize,
    max_matches_per_file: usize,
    hits: &mut Vec<FileSearchHit>,
    total_matches: &mut usize,
    scanned_files: &mut usize,
    max_files: usize,
) -> bool {
    if hits.len() >= limit || *scanned_files >= max_files {
        return true;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if hits.len() >= limit || *scanned_files >= max_files {
            return true;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if !should_skip_dir(&name) {
                if direct_walk_search(
                    root,
                    &path,
                    query_lower,
                    limit,
                    max_matches_per_file,
                    hits,
                    total_matches,
                    scanned_files,
                    max_files,
                ) {
                    return true;
                }
            }
            continue;
        }

        if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE || name.starts_with('.') {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if is_binary_extension(&ext) {
            continue;
        }

        *scanned_files += 1;
        let name_matches = name.to_lowercase().contains(query_lower);
        let state = file_state_from_metadata(&metadata);
        let content = read_indexable_file(&path, &state);
        let matches = content
            .as_deref()
            .map(|body| find_matching_lines(body, query_lower, max_matches_per_file))
            .unwrap_or_default();

        if !name_matches && matches.is_empty() {
            continue;
        }

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let match_count = matches.len().max(1);
        *total_matches += matches.len();
        hits.push(FileSearchHit {
            path: rel_path,
            name,
            match_count,
            matches,
        });
    }
    false
}

/// Find matching lines in file content.
///
/// Returns `FileMatchLine`s whose `highlights` are **UTF-16 code unit
/// offsets** into `line_content` (the unit JavaScript strings are indexed by).
/// All byte slicing is clamped to UTF-8 char boundaries to avoid panics on
/// Chinese / emoji content.
fn find_matching_lines(content: &str, query_lower: &str, max_matches: usize) -> Vec<FileMatchLine> {
    const MAX_LINE_BYTES: usize = 200;

    let mut matches = Vec::new();
    let query_words: Vec<&str> = query_lower.split_whitespace().collect();
    if query_words.is_empty() {
        return matches;
    }

    for (line_idx, line) in content.lines().enumerate() {
        let line_lower = line.to_lowercase();

        // Check if any query word appears in this line
        let has_match = query_words.iter().any(|w| line_lower.contains(w));
        if !has_match {
            continue;
        }

        // Find highlight byte positions (in `line_lower`, which for ASCII/CJK
        // shares byte layout with `line`).
        let mut byte_highlights: Vec<[usize; 2]> = Vec::new();
        for word in &query_words {
            if word.is_empty() {
                continue;
            }
            let mut search_from = 0;
            while let Some(pos) = line_lower[search_from..].find(word) {
                let abs = search_from + pos;
                byte_highlights.push([abs, abs + word.len()]);
                search_from = abs + word.len();
            }
        }
        byte_highlights.sort_by_key(|h| h[0]);

        // Truncate long lines at a UTF-8 char boundary (plain byte slice would
        // panic mid-codepoint on Chinese / emoji content).
        let (line_content, truncated_len) = if line.len() > MAX_LINE_BYTES {
            let boundary = floor_char_boundary(line, MAX_LINE_BYTES);
            (format!("{}...", &line[..boundary]), boundary)
        } else {
            (line.to_string(), line.len())
        };

        // Drop highlights past the truncation point; clamp end to the cut.
        // Then convert remaining byte offsets to UTF-16 code unit offsets so
        // the frontend's `text.slice(...)` lands on the intended glyphs.
        let highlights: Vec<[usize; 2]> = byte_highlights
            .into_iter()
            .filter_map(|[s, e]| {
                if s >= truncated_len {
                    return None;
                }
                let e = e.min(truncated_len);
                let s = floor_char_boundary(&line_content, s);
                let e = ceil_char_boundary(&line_content, e);
                Some([
                    byte_to_utf16(&line_content, s),
                    byte_to_utf16(&line_content, e),
                ])
            })
            .collect();

        matches.push(FileMatchLine {
            line_number: line_idx + 1,
            line_content,
            highlights,
        });

        if matches.len() >= max_matches {
            break;
        }
    }

    matches
}

/// Get text field value from a Tantivy document.
fn get_text_field(doc: &tantivy::TantivyDocument, field: tantivy::schema::Field) -> String {
    doc.get_first(field)
        .and_then(|v| match v {
            tantivy::schema::OwnedValue::Str(s) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn file_state_from_metadata(metadata: &fs::Metadata) -> FileState {
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FileState {
        mtime_ms,
        size: metadata.len(),
    }
}

fn read_indexable_file(abs_path: &Path, expected_state: &FileState) -> Option<String> {
    let metadata = fs::symlink_metadata(abs_path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE_SIZE {
        return None;
    }
    if file_state_from_metadata(&metadata) != *expected_state {
        return None;
    }

    let file = open_regular_file_no_follow(abs_path)?;
    let mut reader = file.take(MAX_FILE_SIZE + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    reader.read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn open_regular_file_no_follow(abs_path: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(abs_path).ok()
}

fn create_file_index_writer(
    index: &Index,
    heap_size: usize,
    context: &str,
) -> Result<IndexWriter, String> {
    index
        .writer(heap_size)
        .map_err(|e| format!("Failed to create file index writer for {}: {}", context, e))
}

fn register_file_tokenizer(index: &Index) {
    index.tokenizers().register(
        tokenizer::TOKENIZER_NAME,
        tokenizer::build_chinese_tokenizer(),
    );
}

/// Stable 64-bit FNV-1a hash of the workspace path.
///
/// This is used as the on-disk directory name for per-workspace Tantivy
/// indices. It MUST stay deterministic across Rust and std upgrades —
/// `DefaultHasher` is explicitly documented as unstable, so using it here
/// would silently orphan every workspace's index the moment the hasher
/// implementation changes. FNV-1a is a plain spec with no moving parts.
fn simple_hash(s: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn active_workspace_writer_lock_is_never_deleted_as_stale() {
        let temp = tempfile::tempdir().unwrap();
        let index_dir = temp.path().join("index");
        fs::create_dir_all(&index_dir).unwrap();
        let (schema, _) = schema::file_schema();
        let index = Index::create_in_dir(&index_dir, schema).unwrap();
        let first = create_file_index_writer(&index, 30_000_000, "first writer").unwrap();
        let lock_path = index_dir.join(".tantivy-writer.lock");

        assert!(create_file_index_writer(&index, 30_000_000, "second writer").is_err());
        assert!(lock_path.exists());

        drop(first);
        create_file_index_writer(&index, 30_000_000, "replacement writer").unwrap();
    }

    #[test]
    fn search_without_persisted_index_uses_direct_scan_without_cold_build() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("gaokao.md"), "今天整理高考活动资料\n").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir.clone());
        let result = manager.search("高考", &workspace, 10, 5).unwrap();

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "gaokao.md");
        let index_dir = base_dir.join(simple_hash(&workspace));
        assert!(
            !index_dir.join(FILE_INDEX_MANIFEST).exists(),
            "foreground search must not cold-build the Tantivy index"
        );
    }

    #[test]
    fn search_uses_direct_scan_when_workspace_index_slot_is_busy() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("notes.txt"), "busyfallbacktoken line\n").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir);
        let slot = manager.slot_for(&workspace).unwrap();
        let _held = slot.lock().unwrap();

        let result = manager
            .search("busyfallbacktoken", &workspace, 10, 5)
            .unwrap();

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "notes.txt");
    }

    #[test]
    fn direct_scan_stops_after_file_budget_for_miss_queries() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        for idx in 0..DIRECT_SCAN_MAX_FILES {
            fs::write(workspace.join(format!("{idx:02}.txt")), "ordinary content").unwrap();
        }
        fs::write(
            workspace.join(format!("{:02}.txt", DIRECT_SCAN_MAX_FILES)),
            "latebudgettoken",
        )
        .unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir);
        let result = manager
            .search("latebudgettoken", &workspace, 10, 5)
            .unwrap();

        assert!(
            result.hits.is_empty(),
            "cold direct scan should not read beyond its foreground file budget"
        );
    }

    #[test]
    fn loads_persisted_index_before_refreshing_filesystem_changes() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let file_path = workspace.join("notes.txt");
        fs::write(&file_path, "originaltoken line\n").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir.clone());
        let (total, _changed) = manager.refresh_or_create(&workspace).unwrap();
        assert_eq!(total, 1);
        let initial = manager.search("originaltoken", &workspace, 10, 5).unwrap();
        assert_eq!(initial.hits.len(), 1);

        let index_dir = base_dir.join(simple_hash(&workspace));
        assert!(index_dir.join(FILE_INDEX_MANIFEST).exists());
        assert!(index_dir.join(SCHEMA_VERSION_FILE).exists());

        // Simulate an app restart and an external file edit before the next
        // foreground refresh. The first search should serve the persisted
        // Tantivy index (stale but immediate); refresh then reconciles it.
        drop(manager);
        fs::write(&file_path, "updatedtoken line with different size\n").unwrap();

        let manager = FileIndexManager::new(base_dir);
        let stale = manager.search("originaltoken", &workspace, 10, 5).unwrap();
        assert_eq!(stale.hits.len(), 1);

        let (total, _changed) = manager.refresh_or_create(&workspace).unwrap();
        assert_eq!(total, 1);

        let old = manager.search("originaltoken", &workspace, 10, 5).unwrap();
        assert!(old.hits.is_empty());
        let updated = manager.search("updatedtoken", &workspace, 10, 5).unwrap();
        assert_eq!(updated.hits.len(), 1);
    }

    #[test]
    fn invalidate_removes_persisted_workspace_index() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let file_path = workspace.join("notes.txt");
        fs::write(&file_path, "beforetoken").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir.clone());
        let (total, _changed) = manager.refresh_or_create(&workspace).unwrap();
        assert_eq!(total, 1);
        assert_eq!(
            manager
                .search("beforetoken", &workspace, 10, 5)
                .unwrap()
                .hits
                .len(),
            1
        );

        let index_dir = base_dir.join(simple_hash(&workspace));
        assert!(index_dir.join(FILE_INDEX_MANIFEST).exists());

        manager.invalidate_index(&workspace).unwrap();
        assert!(!index_dir.exists());

        fs::write(&file_path, "aftertoken with different size").unwrap();
        let old = manager.search("beforetoken", &workspace, 10, 5).unwrap();
        assert!(old.hits.is_empty());
        let new = manager.search("aftertoken", &workspace, 10, 5).unwrap();
        assert_eq!(new.hits.len(), 1);
    }

    #[test]
    fn invalid_manifest_falls_back_to_current_filesystem_scan() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let file_path = workspace.join("notes.txt");
        fs::write(&file_path, "oldtoken").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir.clone());
        let (total, _changed) = manager.refresh_or_create(&workspace).unwrap();
        assert_eq!(total, 1);
        assert_eq!(
            manager
                .search("oldtoken", &workspace, 10, 5)
                .unwrap()
                .hits
                .len(),
            1
        );
        drop(manager);

        let index_dir = base_dir.join(simple_hash(&workspace));
        fs::write(index_dir.join(FILE_INDEX_MANIFEST), "not json").unwrap();
        fs::write(&file_path, "newtoken with different size").unwrap();

        let manager = FileIndexManager::new(base_dir);
        let old = manager.search("oldtoken", &workspace, 10, 5).unwrap();
        assert!(old.hits.is_empty());
        let new = manager.search("newtoken", &workspace, 10, 5).unwrap();
        assert_eq!(new.hits.len(), 1);
    }

    #[test]
    fn missing_schema_marker_falls_back_to_current_filesystem_scan() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let file_path = workspace.join("notes.txt");
        fs::write(&file_path, "indexedtoken").unwrap();

        let workspace = workspace_path(&workspace);
        let manager = FileIndexManager::new(base_dir.clone());
        let (total, _changed) = manager.refresh_or_create(&workspace).unwrap();
        assert_eq!(total, 1);
        drop(manager);

        let index_dir = base_dir.join(simple_hash(&workspace));
        fs::remove_file(index_dir.join(SCHEMA_VERSION_FILE)).unwrap();
        fs::write(&file_path, "freshfilesystemtoken with different size").unwrap();

        let manager = FileIndexManager::new(base_dir);
        let old = manager.search("indexedtoken", &workspace, 10, 5).unwrap();
        assert!(old.hits.is_empty());
        let fresh = manager
            .search("freshfilesystemtoken", &workspace, 10, 5)
            .unwrap();
        assert_eq!(fresh.hits.len(), 1);
    }

    #[test]
    fn read_indexable_file_rechecks_size_before_read() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("grows.txt");
        fs::write(&file_path, "small").unwrap();
        let expected_state = file_state_from_metadata(&fs::symlink_metadata(&file_path).unwrap());

        fs::write(&file_path, "x".repeat(MAX_FILE_SIZE as usize + 1)).unwrap();

        assert!(read_indexable_file(&file_path, &expected_state).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_files_inside_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let base_dir = temp.path().join("index");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().join("outside-secret.txt");
        fs::write(&outside, "secretoutsideworkspace").unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("link.txt")).unwrap();

        let manager = FileIndexManager::new(base_dir);
        let result = manager
            .search("secretoutsideworkspace", &workspace_path(&workspace), 10, 5)
            .unwrap();
        assert!(result.hits.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn read_indexable_file_rejects_symlink_swap_after_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("candidate.txt");
        let outside = temp.path().join("outside-secret.txt");
        fs::write(&file_path, "regular content").unwrap();
        fs::write(&outside, "secretoutsideworkspace").unwrap();
        let expected_state = file_state_from_metadata(&fs::symlink_metadata(&file_path).unwrap());

        fs::remove_file(&file_path).unwrap();
        std::os::unix::fs::symlink(&outside, &file_path).unwrap();

        assert!(read_indexable_file(&file_path, &expected_state).is_none());
    }
}
