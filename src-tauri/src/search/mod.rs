//! Full-text search engine for MyAgents.
//!
//! Provides two independent search capabilities:
//! 1. **Session search** — searches across all session titles and message content
//! 2. **Workspace file search** — searches file names and content within a workspace
//!
//! Built on Tantivy (Rust-native full-text search engine) with jieba-rs for Chinese
//! tokenization. Exposed to the frontend via Tauri IPC commands (`cmd_search_*`).
//!
//! Architecture: singleton `SearchEngine` managed as Tauri state, same tier as
//! `SidecarManager` and `TaskStore`.

mod file_indexer;
mod schema;
mod searcher;
mod session_indexer;
mod tokenizer;
mod util;
mod watcher;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;

use crate::workspace_files::path_safety::validate_workspace_root;
use crate::{ulog_error, ulog_info};

pub use searcher::{
    FileMatchLine, FileSearchHit, FileSearchResult, SessionSearchHit, SessionSearchResult,
};

/// The main search engine singleton.
///
/// Holds Tantivy indices for sessions (global) and workspace files (per-workspace).
///
/// **Session index** is held as `Arc<SessionIndex>` (no outer mutex). Normal
/// search and indexing share a read lock over the current Tantivy state; only
/// confirmed corruption takes the write lock to replace that derived state.
/// Tantivy's writer mutex still enforces the single-writer invariant.
///
/// **File indices** keep only a short global map lock to locate the per-workspace
/// slot. Heavy refresh/search work is serialized per workspace and run on a
/// blocking worker, so a cold index in one workspace does not block searches in
/// another workspace or pin an async runtime thread.
pub struct SearchEngine {
    data_dir: PathBuf,
    session_index: Arc<session_indexer::SessionIndex>,
    file_indices: Arc<file_indexer::FileIndexManager>,
}

impl SearchEngine {
    /// Create a new SearchEngine with indices stored under `data_dir/search_index/`.
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        let index_dir = data_dir.join("search_index");
        std::fs::create_dir_all(&index_dir)
            .map_err(|e| format!("Failed to create search index dir: {}", e))?;

        let session_index =
            session_indexer::SessionIndex::new(index_dir.join("sessions"), data_dir.clone())
                .map_err(|e| format!("Failed to create session index: {}", e))?;

        let file_manager = file_indexer::FileIndexManager::new(index_dir.join("workspaces"));

        Ok(Self {
            data_dir,
            session_index: Arc::new(session_index),
            file_indices: Arc::new(file_manager),
        })
    }

    /// Start background indexing of existing sessions.
    /// Reads `sessions.json` and indexes any sessions not yet in the index.
    ///
    /// MUST use `tauri::async_runtime::spawn` — this is called from Tauri's
    /// `.setup()` callback which runs on the main thread without a Tokio reactor.
    /// `tokio::spawn` would panic and, because `.setup()` is invoked through an
    /// ObjC callback on macOS, the panic cannot unwind across the FFI boundary
    /// and aborts the process (`panic_cannot_unwind` in `did_finish_launching`).
    pub fn start_background_indexing(&self) {
        let data_dir = self.data_dir.clone();
        let session_index = self.session_index.clone();

        tauri::async_runtime::spawn(async move {
            ulog_info!("[search] Starting background session indexing...");
            let start = std::time::Instant::now();

            let sessions_file = data_dir.join("sessions.json");
            let have_sessions_file = sessions_file.exists();

            if have_sessions_file {
                // `index_all_sessions` is synchronous + disk/CPU-bound. Run on a
                // blocking worker so we don't pin a Tokio reactor thread and so
                // the user search path stays responsive.
                let indexer = session_index.clone();
                let dir_for_index = data_dir.clone();
                let result =
                    tokio::task::spawn_blocking(move || indexer.index_all_sessions(&dir_for_index))
                        .await;

                match result {
                    Ok(Ok(count)) => {
                        ulog_info!(
                            "[search] Background indexing complete: {} sessions indexed in {:.1}s",
                            count,
                            start.elapsed().as_secs_f64()
                        );
                    }
                    Ok(Err(e)) => {
                        ulog_error!("[search] Background indexing failed: {}", e);
                    }
                    Err(e) => {
                        ulog_error!("[search] Background indexing task panicked: {}", e);
                    }
                }
            } else {
                ulog_info!("[search] No sessions.json found, skipping initial indexing");
            }

            // Start the filesystem watcher AFTER the initial pass so its
            // baseline snapshot matches the index's starting state. The
            // watcher runs on its own std thread for the rest of the
            // process lifetime and keeps the index in sync with any
            // future session writes, deletes, or title edits — no
            // matter which process authored them.
            watcher::spawn_session_watcher(data_dir, session_index);
        });
    }

    /// Search session history (title + content). Normal reads remain concurrent
    /// with background indexing; only corruption recovery takes exclusive ownership.
    pub async fn search_sessions(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<SessionSearchResult, String> {
        self.session_index.search(query, limit)
    }

    /// Search workspace files (name + content).
    pub async fn search_files(
        &self,
        query: &str,
        workspace: &str,
        limit: usize,
        max_matches_per_file: usize,
    ) -> Result<FileSearchResult, String> {
        let mgr = self.file_indices.clone();
        let query = query.to_string();
        let workspace = workspace.to_string();
        tokio::task::spawn_blocking(move || {
            mgr.search(&query, &workspace, limit, max_matches_per_file)
        })
        .await
        .map_err(|e| format!("file search task panicked: {}", e))?
    }

    /// Get index status (for debugging).
    pub async fn get_status(&self) -> Result<IndexStatus, String> {
        Ok(IndexStatus {
            session_doc_count: self.session_index.doc_count()?,
            index_dir: self.data_dir.join("search_index").display().to_string(),
        })
    }

    /// Invalidate workspace file index to force it to be rebuilt from scratch next time
    pub async fn invalidate_workspace_file_index(&self, workspace: &str) {
        let mgr = self.file_indices.clone();
        let workspace = workspace.to_string();
        match tokio::task::spawn_blocking(move || mgr.invalidate_index(&workspace)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => ulog_error!("[search] Failed to invalidate workspace index: {}", e),
            Err(e) => ulog_error!("[search] Workspace index invalidation task panicked: {}", e),
        }
    }

    /// Incrementally refresh the workspace file index against the current
    /// filesystem. Walks metadata only and re-indexes just the files whose
    /// mtime/size changed. Called after the foreground file search returns
    /// available results, so refresh work cannot jump ahead of the user's
    /// actual query.
    pub async fn refresh_workspace_file_index(
        &self,
        workspace: &str,
    ) -> Result<(usize, usize), String> {
        let mgr = self.file_indices.clone();
        let workspace = workspace.to_string();
        tokio::task::spawn_blocking(move || mgr.refresh_or_create(&workspace))
            .await
            .map_err(|e| format!("workspace index refresh task panicked: {}", e))?
    }

    /// Search Task Center thoughts (v0.1.69, PRD §13.2). Substring match over
    /// content + tags (case-insensitive). The store keeps everything in memory
    /// and the expected N < 10k, so Tantivy overhead is unwarranted at v1
    /// scale; we defer that to a later release when user data grows past the
    /// linear-scan threshold.
    pub async fn search_thoughts(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<ThoughtSearchResult, String> {
        let Some(store) = crate::thought::get_thought_store() else {
            return Ok(ThoughtSearchResult {
                hits: vec![],
                total: 0,
            });
        };
        let start = std::time::Instant::now();
        // Search intentionally spans archived thoughts too (v0.2.16 PRD
        // §2.2 decision 4 — mailbox-archive semantics). The default
        // ThoughtListFilter hides archived since v0.2.16, so we have to
        // ask for `All` explicitly here.
        let all = store
            .list(crate::thought::ThoughtListFilter {
                archived: Some(crate::thought::ThoughtArchiveFilter::All),
                ..Default::default()
            })
            .await;
        let needle = query.trim().to_lowercase();
        let hits: Vec<ThoughtSearchHit> = all
            .into_iter()
            .filter(|t| {
                if needle.is_empty() {
                    return true;
                }
                t.content.to_lowercase().contains(&needle)
                    || t.tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&needle))
            })
            .take(limit)
            .map(|t| ThoughtSearchHit {
                id: t.id,
                snippet: make_snippet(&t.content, &needle, 180),
                tags: t.tags,
                updated_at: t.updated_at,
            })
            .collect();
        let total = hits.len() as u64;
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        ulog_info!(
            "[search] thought query={:?} → {} hits ({:.1}ms)",
            query,
            total,
            elapsed_ms
        );
        Ok(ThoughtSearchResult { hits, total })
    }

    /// Search Task Center tasks. Matches on name + description + tags +
    /// task.md contents (read lazily per task, cached per-call). Filters by
    /// workspace when supplied.
    pub async fn search_tasks(
        &self,
        query: &str,
        workspace_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSearchResult, String> {
        let Some(store) = crate::task::get_task_store() else {
            return Ok(TaskSearchResult {
                hits: vec![],
                total: 0,
            });
        };
        let start = std::time::Instant::now();
        let all = store
            .list(crate::task::TaskListFilter {
                workspace_id: workspace_id.map(|s| s.to_string()),
                ..Default::default()
            })
            .await;
        let needle = query.trim().to_lowercase();
        let mut hits: Vec<TaskSearchHit> = Vec::new();
        for t in all.into_iter() {
            if hits.len() >= limit {
                break;
            }
            let mut matched = false;
            let mut snippet = String::new();
            if needle.is_empty() {
                matched = true;
            } else {
                if t.name.to_lowercase().contains(&needle) {
                    matched = true;
                    snippet = t.name.clone();
                }
                if let Some(desc) = t.description.as_deref() {
                    if !matched && desc.to_lowercase().contains(&needle) {
                        matched = true;
                        snippet = desc.to_string();
                    }
                }
                if !matched && t.tags.iter().any(|x| x.to_lowercase().contains(&needle)) {
                    matched = true;
                    snippet = format!("tags: {}", t.tags.join(", "));
                }
                if !matched {
                    // Peek at task.md — bounded read so we don't blow out I/O
                    // on a huge workspace. `task_docs_dir` errors on bad inputs
                    // so we silently skip in that case. After v0.1.69 relocation
                    // task docs live in ~/.myagents/tasks/<id>/, not in the
                    // workspace.
                    if let Ok(dir) = crate::task::task_docs_dir(&t.id) {
                        let md = dir.join("task.md");
                        if let Ok(body) = std::fs::read_to_string(&md) {
                            let lc = body.to_lowercase();
                            if lc.contains(&needle) {
                                matched = true;
                                snippet = make_snippet(&body, &needle, 180);
                            }
                        }
                    }
                }
            }
            if matched {
                hits.push(TaskSearchHit {
                    id: t.id,
                    name: t.name,
                    snippet,
                    status: t.status.as_str().to_string(),
                    workspace_id: t.workspace_id,
                    updated_at: t.updated_at,
                });
            }
        }
        let total = hits.len() as u64;
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        ulog_info!(
            "[search] task query={:?} → {} hits ({:.1}ms)",
            query,
            total,
            elapsed_ms
        );
        Ok(TaskSearchResult { hits, total })
    }
}

fn make_snippet(body: &str, needle: &str, ctx_chars: usize) -> String {
    if needle.is_empty() || body.is_empty() {
        return body.chars().take(ctx_chars).collect();
    }
    let lc = body.to_lowercase();
    match lc.find(needle) {
        Some(byte_idx) => {
            // Expand around match using char boundary clamping.
            let start = byte_idx.saturating_sub(ctx_chars / 2);
            let end = (byte_idx + needle.len() + ctx_chars / 2).min(body.len());
            let clamped_start = body
                .char_indices()
                .take_while(|(i, _)| *i <= start)
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
            let clamped_end = body
                .char_indices()
                .take_while(|(i, _)| *i <= end)
                .last()
                .map(|(i, _)| i + body[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(0))
                .unwrap_or(body.len());
            let mut out = String::new();
            if clamped_start > 0 {
                out.push('…');
            }
            out.push_str(&body[clamped_start..clamped_end]);
            if clamped_end < body.len() {
                out.push('…');
            }
            out
        }
        None => body.chars().take(ctx_chars).collect(),
    }
}

#[derive(Debug, Serialize)]
pub struct ThoughtSearchResult {
    pub hits: Vec<ThoughtSearchHit>,
    pub total: u64,
}

#[derive(Debug, Serialize)]
pub struct ThoughtSearchHit {
    pub id: String,
    pub snippet: String,
    pub tags: Vec<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct TaskSearchResult {
    pub hits: Vec<TaskSearchHit>,
    pub total: u64,
}

#[derive(Debug, Serialize)]
pub struct TaskSearchHit {
    pub id: String,
    pub name: String,
    pub snippet: String,
    pub status: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct IndexStatus {
    pub session_doc_count: u64,
    pub index_dir: String,
}

// ── Tauri IPC Commands ──────────────────────────────────────────────

/// Search session history.
#[tauri::command]
pub async fn cmd_search_sessions(
    state: tauri::State<'_, Arc<SearchEngine>>,
    query: String,
    limit: Option<usize>,
) -> Result<SessionSearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SessionSearchResult {
            hits: vec![],
            total_count: 0,
            query_time_ms: 0.0,
        });
    }
    state.search_sessions(query, limit.unwrap_or(50)).await
}

/// Search workspace files.
#[tauri::command]
pub async fn cmd_search_workspace_files(
    state: tauri::State<'_, Arc<SearchEngine>>,
    query: String,
    workspace: String,
    limit: Option<usize>,
    max_matches_per_file: Option<usize>,
) -> Result<FileSearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(FileSearchResult {
            hits: vec![],
            total_files: 0,
            total_matches: 0,
            query_time_ms: 0.0,
        });
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let workspace = workspace_root.to_string_lossy().into_owned();
    state
        .search_files(
            query,
            &workspace,
            limit.unwrap_or(50),
            max_matches_per_file.unwrap_or(10),
        )
        .await
}

/// Get search index status.
#[tauri::command]
pub async fn cmd_search_index_status(
    state: tauri::State<'_, Arc<SearchEngine>>,
) -> Result<IndexStatus, String> {
    state.get_status().await
}

/// Invalidate workspace file index so it gets rebuilt on next search
#[tauri::command]
pub async fn cmd_invalidate_workspace_index(
    state: tauri::State<'_, Arc<SearchEngine>>,
    workspace: String,
) -> Result<(), String> {
    state.invalidate_workspace_file_index(&workspace).await;
    Ok(())
}

/// Incrementally refresh a workspace file index. Returns `(total_files, changed_files)`.
#[tauri::command]
pub async fn cmd_refresh_workspace_index(
    state: tauri::State<'_, Arc<SearchEngine>>,
    workspace: String,
) -> Result<(usize, usize), String> {
    let workspace = validate_workspace_root(&workspace)?
        .to_string_lossy()
        .into_owned();
    state.refresh_workspace_file_index(&workspace).await
}

/// Search Task Center thoughts (v0.1.69).
#[tauri::command]
pub async fn cmd_search_thoughts(
    state: tauri::State<'_, Arc<SearchEngine>>,
    query: String,
    limit: Option<usize>,
) -> Result<ThoughtSearchResult, String> {
    state.search_thoughts(&query, limit.unwrap_or(50)).await
}

/// Search Task Center tasks (v0.1.69). Optional workspace filter.
#[tauri::command]
pub async fn cmd_search_tasks(
    state: tauri::State<'_, Arc<SearchEngine>>,
    query: String,
    workspace_id: Option<String>,
    limit: Option<usize>,
) -> Result<TaskSearchResult, String> {
    state
        .search_tasks(&query, workspace_id.as_deref(), limit.unwrap_or(50))
        .await
}
