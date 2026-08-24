//! Session index — reads sessions.json + JSONL files, builds/queries Tantivy index.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, RwLock};

use crate::perf_trace::{elapsed_ms, emit_perf_trace, trace_start, PerfTrace, PerfTraceName};
use crate::ulog_warn;
use crate::utils::bom::strip_bom;
use crate::utils::system_reminder::strip_leading_system_reminder;

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyError, Term};

use super::schema::{self, SessionFields, SCHEMA_VERSION};
use super::searcher::{SessionSearchHit, SessionSearchResult};
use super::tokenizer;
use super::util::{byte_to_utf16, ceil_char_boundary, floor_char_boundary};

const INDEX_RECOVERY_REQUIRED: &str = "[recoverable-tantivy-corruption]";

/// Owns the replaceable, derived session-search index.
///
/// Normal reads and writes share the read side of `state`; Tantivy's writer
/// mutex still serializes mutations while searches remain concurrent. The
/// write side is used only to replace a confirmed-corrupt derived index from
/// authoritative `sessions.json` + JSONL data.
pub struct SessionIndex {
    state: RwLock<Option<SessionIndexState>>,
    index_dir: PathBuf,
    data_dir: PathBuf,
}

struct SessionIndexState {
    index: Index,
    reader: IndexReader,
    writer: StdMutex<IndexWriter>,
    fields: SessionFields,
    /// Pattern 3 §3.2.4 / D.4 — directory holding the Tantivy index plus
    /// per-session `<sessionId>.offset` sidecar files used for incremental
    /// indexing (see `reindex_session_incremental`).
    index_dir: PathBuf,
}

impl SessionIndex {
    pub fn new(index_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        let state = match SessionIndexState::open(index_dir.clone()) {
            Ok(state) => state,
            Err(error) if is_recoverable_index_error(&error) => {
                ulog_warn!(
                    "[search] Session index is corrupt during open; rebuilding derived index: {}",
                    error
                );
                reset_session_index_dir(&index_dir)?;
                SessionIndexState::open(index_dir.clone())?
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            state: RwLock::new(Some(state)),
            index_dir,
            data_dir,
        })
    }

    fn with_recovery<T>(
        &self,
        operation: &str,
        action: impl Fn(&SessionIndexState) -> Result<T, String>,
    ) -> Result<T, String> {
        let first_result = {
            let state = self
                .state
                .read()
                .map_err(|e| format!("session index state lock poisoned: {}", e))?;
            match state.as_ref() {
                Some(state) => action(state),
                None => Err(INDEX_RECOVERY_REQUIRED.to_string()),
            }
        };
        match first_result {
            Ok(value) => return Ok(value),
            Err(error) if is_recoverable_index_error(&error) => {}
            Err(error) => return Err(error),
        }

        // A concurrent caller may have repaired the index while we waited for
        // exclusive ownership. Re-run once before electing this caller to rebuild.
        let mut state = self
            .state
            .write()
            .map_err(|e| format!("session index state lock poisoned: {}", e))?;
        if let Some(current) = state.as_ref() {
            match action(current) {
                Ok(value) => return Ok(value),
                Err(error) if is_recoverable_index_error(&error) => {}
                Err(error) => return Err(error),
            }
        }

        ulog_warn!(
            "[search] Session index corruption detected during {}; rebuilding derived index",
            operation
        );

        // Drop all Tantivy handles before removing the directory. This is
        // required on Windows, where mapped segment files cannot be unlinked.
        drop(state.take());
        reset_session_index_dir(&self.index_dir)?;
        let rebuilt = SessionIndexState::open(self.index_dir.clone())?;
        let rebuild_result = if self.data_dir.join("sessions.json").exists() {
            rebuilt.index_all_sessions(&self.data_dir).map(|_| ())
        } else {
            Ok(())
        };
        *state = Some(rebuilt);
        rebuild_result?;

        action(
            state
                .as_ref()
                .expect("rebuilt session index must be installed"),
        )
    }

    pub fn index_all_sessions(&self, data_dir: &Path) -> Result<usize, String> {
        self.with_recovery("initial indexing", |state| {
            state.index_all_sessions(data_dir)
        })
    }

    pub fn reindex_session(&self, session_id: &str, sessions_dir: &Path) -> Result<(), String> {
        self.with_recovery("session reindex", |state| {
            state.reindex_session(session_id, sessions_dir)
        })
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        self.with_recovery("session delete", |state| state.delete_session(session_id))
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<SessionSearchResult, String> {
        self.with_recovery("session search", |state| {
            state.search(query, limit, &self.data_dir)
        })
    }

    pub fn doc_count(&self) -> Result<u64, String> {
        let state = self
            .state
            .read()
            .map_err(|e| format!("session index state lock poisoned: {}", e))?;
        state
            .as_ref()
            .map(SessionIndexState::doc_count)
            .ok_or_else(|| "session index recovery is pending".to_string())
    }

    #[cfg(test)]
    fn read_session_offset(&self, session_id: &str) -> u64 {
        self.state
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .read_session_offset(session_id)
    }

    #[cfg(test)]
    fn write_session_offset(&self, session_id: &str, offset: u64) {
        self.state
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .write_session_offset(session_id, offset);
    }
}

impl SessionIndexState {
    /// Open or create the session index at the given directory.
    fn open(index_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&index_dir)
            .map_err(|e| format!("Failed to create session index dir: {}", e))?;

        let (schema, fields) = schema::session_schema();
        let version_file = index_dir.join(".schema_version");
        let stored_version = fs::read_to_string(&version_file)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok());

        // If the stored schema version mismatches, wipe and recreate.
        if stored_version != Some(SCHEMA_VERSION) && index_dir.join("meta.json").exists() {
            ulog_warn!(
                "[search] Session index schema version mismatch (stored={:?}, current={}), rebuilding",
                stored_version,
                SCHEMA_VERSION
            );
            // Remove contents but keep directory.
            if let Ok(entries) = fs::read_dir(&index_dir) {
                for entry in entries.flatten() {
                    let _ =
                        fs::remove_file(entry.path()).or_else(|_| fs::remove_dir_all(entry.path()));
                }
            }
        }

        // Open or create index
        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(&index_dir)
                .map_err(|e| tantivy_error("Failed to open session index", e))?
        } else {
            Index::create_in_dir(&index_dir, schema)
                .map_err(|e| tantivy_error("Failed to create session index", e))?
        };

        // Persist current schema version marker.
        let _ = fs::write(&version_file, SCHEMA_VERSION.to_string());

        // Register Chinese tokenizer. MUST happen before creating the writer
        // so docs are tokenized with jieba at index time (tantivy snapshots
        // the tokenizer manager when the writer is created).
        index.tokenizers().register(
            tokenizer::TOKENIZER_NAME,
            tokenizer::build_chinese_tokenizer(),
        );

        // 50MB writer heap — sufficient for desktop usage. Tantivy/OS owns the
        // lock lifetime; pathname existence alone does not prove a stale lock.
        let writer = index
            .writer(50_000_000)
            .map_err(|e| tantivy_error("Failed to create index writer", e))?;

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| tantivy_error("Failed to create index reader", e))?;

        Ok(Self {
            index,
            reader,
            writer: StdMutex::new(writer),
            fields,
            index_dir,
        })
    }

    /// Pattern 3 §3.2.4 / D.4 — read the byte offset stored in
    /// `<index_dir>/offsets/<sessionId>.offset`. `0` means "never indexed
    /// before" (or sidecar missing).
    fn read_session_offset(&self, session_id: &str) -> u64 {
        let path = self
            .index_dir
            .join("offsets")
            .join(format!("{}.offset", session_id));
        match fs::read_to_string(&path) {
            Ok(s) => s.trim().parse::<u64>().unwrap_or(0),
            Err(_) => 0,
        }
    }

    /// Persist the byte offset reached during the last incremental index pass.
    fn write_session_offset(&self, session_id: &str, offset: u64) {
        let dir = self.index_dir.join("offsets");
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(format!("{}.offset", session_id));
        let _ = fs::write(&path, offset.to_string());
    }

    /// Drop the per-session offset sidecar. Used when a full rebuild is
    /// performed (delete + reindex) so future appends start fresh.
    fn drop_session_offset(&self, session_id: &str) {
        let path = self
            .index_dir
            .join("offsets")
            .join(format!("{}.offset", session_id));
        let _ = fs::remove_file(&path);
    }

    /// Index all sessions from disk. Returns the number of sessions indexed.
    pub fn index_all_sessions(&self, data_dir: &Path) -> Result<usize, String> {
        let sessions_file = data_dir.join("sessions.json");
        let sessions_dir = data_dir.join("sessions");

        let content = fs::read_to_string(&sessions_file)
            .map_err(|e| format!("Failed to read sessions.json: {}", e))?;

        let sessions: Vec<serde_json::Value> = serde_json::from_str(strip_bom(&content))
            .map_err(|e| format!("Failed to parse sessions.json: {}", e))?;

        // Get set of already-indexed session IDs
        let indexed_ids = self.get_indexed_session_ids();

        // Hold the writer lock for the whole batch. Search uses a separate
        // Tantivy reader, so normal indexing does not block user queries.
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("writer mutex poisoned: {}", e))?;

        let mut count = 0;
        let mut changed = false;
        for session in &sessions {
            let session_id = match session.get("id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => continue,
            };

            if !crate::session_visibility::is_history_visible_session(session, &sessions_dir) {
                writer.delete_term(Term::from_field_text(self.fields.session_id, session_id));
                self.drop_session_offset(session_id);
                changed = true;
                continue;
            }

            // Skip already indexed sessions
            if indexed_ids.contains(session_id) {
                continue;
            }

            // Index this session
            if let Err(e) = index_single_session(&mut writer, &self.fields, session, &sessions_dir)
            {
                ulog_warn!("[search] Failed to index session {}: {}", session_id, e);
                continue;
            }
            count += 1;
            changed = true;
            // Pattern 3 §D.4 — record the byte offset reached so subsequent
            // watcher-triggered reindex calls can take the incremental path.
            let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
            if let Ok(meta) = jsonl_path.metadata() {
                self.write_session_offset(session_id, meta.len());
            }
        }

        if changed {
            writer
                .commit()
                .map_err(|e| tantivy_error("Failed to commit session index", e))?;
            drop(writer);
            self.reader
                .reload()
                .map_err(|e| tantivy_error("Failed to reload reader", e))?;
        }

        Ok(count)
    }

    /// Re-index a session incrementally.
    ///
    /// **Pattern 3 §3.2.4 / D.4 — delete-and-rebuild was O(session) per
    /// append.** We now keep a `<index_dir>/offsets/<sessionId>.offset`
    /// sidecar file that tracks the byte offset of the JSONL we have already
    /// indexed. On each watcher tick:
    ///   - If a saved offset exists and the JSONL file is at-least-as-big,
    ///     read only the bytes from `offset..end` and index the new messages
    ///     (parsed line-by-line). The title doc is upserted via
    ///     `delete_term` on `<sessionId>_title` before re-adding.
    ///   - Otherwise (no offset recorded, or the file shrank — likely a
    ///     rewind/truncation), fall back to delete-all + full reindex and
    ///     reset the offset.
    pub fn reindex_session(&self, session_id: &str, sessions_dir: &Path) -> Result<(), String> {
        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        let saved_offset = self.read_session_offset(session_id);
        let current_size = jsonl_path.metadata().map(|m| m.len()).unwrap_or(0);

        // Fast path: incremental tail-read. Only safe when:
        //   - we have a saved offset, AND
        //   - the file has only grown, AND
        //   - we are not at byte 0 (offset 0 + grown = first index → full path)
        if saved_offset > 0 && current_size >= saved_offset {
            if current_size == saved_offset {
                // No new bytes — title-only update (sessions.json edit). Take
                // the cheap path: update the title doc only.
                return self.update_session_title_only(session_id, sessions_dir);
            }
            return self.append_session_messages(
                session_id,
                sessions_dir,
                saved_offset,
                current_size,
            );
        }

        // Fall back to full rebuild (corrupt offset, rewind, first index).
        self.drop_session_offset(session_id);
        let indexed = self.full_reindex_session(session_id, sessions_dir)?;
        if indexed && current_size > 0 {
            self.write_session_offset(session_id, current_size);
        }
        Ok(())
    }

    /// Full delete-and-rebuild path. Reserved for first index, rewind, and
    /// recovery from a corrupted offset sidecar.
    fn full_reindex_session(&self, session_id: &str, sessions_dir: &Path) -> Result<bool, String> {
        let trace_started = trace_start();
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("writer mutex poisoned: {}", e))?;

        // Delete existing docs for this session
        let term = Term::from_field_text(self.fields.session_id, session_id);
        writer.delete_term(term);

        // Read session metadata from sessions.json to get title etc.
        let data_dir = sessions_dir.parent().unwrap_or(Path::new("."));
        let sessions_file = data_dir.join("sessions.json");
        let mut indexed = false;
        if let Ok(content) = fs::read_to_string(&sessions_file) {
            if let Ok(sessions) =
                serde_json::from_str::<Vec<serde_json::Value>>(strip_bom(&content))
            {
                if let Some(meta) = sessions
                    .iter()
                    .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(session_id))
                {
                    if crate::session_visibility::is_history_visible_session(meta, sessions_dir) {
                        index_single_session(&mut writer, &self.fields, meta, sessions_dir)?;
                        indexed = true;
                    }
                }
            }
        }

        writer
            .commit()
            .map_err(|e| tantivy_error("commit failed", e))?;
        drop(writer);
        self.reader
            .reload()
            .map_err(|e| tantivy_error("reload failed", e))?;
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::StorageIo, "search_reindex_full")
                .duration_ms(elapsed_ms(trace_started))
                .session_id(Some(session_id))
                .status("ok"),
        );
        Ok(indexed)
    }

    /// Append-only path: read JSONL bytes in `[from, to)` and add a doc per
    /// new message line. Assumes line boundaries are aligned with `from`
    /// (true because `saveSessionMessages` is append-only of complete lines
    /// terminated by `\n` — our writer flushes a full batch at a time).
    /// Title doc is left untouched; if `sessions.json` changed independently
    /// the watcher classifies that as `SessionsJson` and triggers
    /// `update_session_title_only` separately.
    fn append_session_messages(
        &self,
        session_id: &str,
        sessions_dir: &Path,
        from: u64,
        to: u64,
    ) -> Result<(), String> {
        let trace_started = trace_start();
        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        let to = to.min(jsonl_path.metadata().map(|m| m.len()).unwrap_or(to));
        if from >= to {
            return Ok(());
        }
        let bytes = read_jsonl_range(&jsonl_path, from, to)?;
        let chunk = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => {
                // Multi-byte split right at `from` — fall back to full rebuild.
                self.drop_session_offset(session_id);
                if self.full_reindex_session(session_id, sessions_dir)? {
                    self.write_session_offset(session_id, to);
                }
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::StorageIo, "search_reindex_incremental")
                        .duration_ms(elapsed_ms(trace_started))
                        .session_id(Some(session_id))
                        .size_bytes(to.saturating_sub(from))
                        .status("ok")
                        .detail("reason", "utf8_boundary_fallback_full_reindex"),
                );
                return Ok(());
            }
        };

        // We need the session metadata (title, agent_dir, etc.) for the
        // doc fields — re-read sessions.json once.
        let data_dir = sessions_dir.parent().unwrap_or(Path::new("."));
        let sessions_file = data_dir.join("sessions.json");
        let meta_raw = fs::read_to_string(&sessions_file).unwrap_or_default();
        let sessions_json: Vec<serde_json::Value> =
            serde_json::from_str(strip_bom(&meta_raw)).unwrap_or_default();
        let meta = match sessions_json
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(session_id))
        {
            Some(m) => m.clone(),
            None => return Ok(()), // session not in metadata yet — skip
        };
        if !crate::session_visibility::is_history_visible_session(&meta, sessions_dir) {
            self.delete_session(session_id)?;
            return Ok(());
        }
        let title = meta
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(无标题)");
        let agent_dir = meta.get("agentDir").and_then(|v| v.as_str()).unwrap_or("");
        let last_active_at = meta
            .get("lastActiveAt")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let source = meta
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("desktop");
        let message_count = meta
            .get("stats")
            .and_then(|s| s.get("messageCount"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        if self
            .indexed_title_for_session(session_id)
            .as_deref()
            .is_some_and(|indexed_title| indexed_title != title)
        {
            self.drop_session_offset(session_id);
            if self.full_reindex_session(session_id, sessions_dir)? {
                self.write_session_offset(session_id, to);
            }
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::StorageIo, "search_reindex_incremental")
                    .duration_ms(elapsed_ms(trace_started))
                    .session_id(Some(session_id))
                    .size_bytes(to.saturating_sub(from))
                    .status("ok")
                    .detail("reason", "title_changed_full_reindex"),
            );
            return Ok(());
        }

        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("writer mutex poisoned: {}", e))?;

        let f = &self.fields;
        writer.delete_term(Term::from_field_text(
            f.message_id,
            &format!("{}_title", session_id),
        ));
        let _ = writer.add_document(doc!(
            f.session_id => session_id,
            f.message_id => format!("{}_title", session_id),
            f.agent_dir => agent_dir,
            f.role => "title",
            f.title => title,
            f.content => title,
            f.timestamp => last_active_at,
            f.last_active_at => last_active_at,
            f.source => source,
            f.message_count => message_count,
        ));

        let mut indexed_count = 0u64;
        let mut next_offset = from;
        let mut cursor = 0u64;
        let mut blocked_reason: Option<&'static str> = None;
        for segment in chunk.split_inclusive('\n') {
            let segment_len = segment.len() as u64;
            if !segment.ends_with('\n') {
                blocked_reason = Some("partial_line");
                break;
            }
            let line_end_offset = from + cursor + segment_len;
            cursor += segment_len;

            let line = segment.trim();
            if line.is_empty() {
                next_offset = line_end_offset;
                continue;
            }
            let msg: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(e) => {
                    blocked_reason = Some("json_parse_error");
                    ulog_warn!(
                        "[search] incremental parse failed for session {} at offset {}: {}",
                        session_id,
                        from + cursor.saturating_sub(segment_len),
                        e
                    );
                    break;
                }
            };
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let timestamp = msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
            let text = extract_text_content(&msg);
            if text.is_empty() {
                next_offset = line_end_offset;
                continue;
            }
            let _ = writer.add_document(doc!(
                f.session_id => session_id,
                f.message_id => msg_id,
                f.agent_dir => agent_dir,
                f.role => role,
                f.title => title,
                f.content => text.as_str(),
                f.timestamp => timestamp,
                f.last_active_at => last_active_at,
                f.source => source,
                f.message_count => message_count,
            ));
            indexed_count += 1;
            next_offset = line_end_offset;
        }

        writer
            .commit()
            .map_err(|e| tantivy_error("commit failed", e))?;
        drop(writer);
        self.reader
            .reload()
            .map_err(|e| tantivy_error("reload failed", e))?;
        // Persist new offset only after a successful commit.
        if next_offset > from {
            self.write_session_offset(session_id, next_offset);
        }
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::StorageIo, "search_reindex_incremental")
                .duration_ms(elapsed_ms(trace_started))
                .session_id(Some(session_id))
                .size_bytes(next_offset.saturating_sub(from))
                .count(indexed_count)
                .status(if blocked_reason.is_some() {
                    "skipped"
                } else {
                    "ok"
                })
                .detail("blocked_reason", blocked_reason.unwrap_or("none")),
        );
        Ok(())
    }

    /// Title / metadata-only refresh: delete the `<sessionId>_title` doc and
    /// re-add it from `sessions.json`. Used when sessions.json metadata
    /// changes without any JSONL append (e.g. user edited the title).
    fn update_session_title_only(
        &self,
        session_id: &str,
        sessions_dir: &Path,
    ) -> Result<(), String> {
        let data_dir = sessions_dir.parent().unwrap_or(Path::new("."));
        let sessions_file = data_dir.join("sessions.json");
        let meta_raw = fs::read_to_string(&sessions_file).unwrap_or_default();
        let sessions_json: Vec<serde_json::Value> =
            serde_json::from_str(strip_bom(&meta_raw)).unwrap_or_default();
        let meta = match sessions_json
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(session_id))
        {
            Some(m) => m.clone(),
            None => return Ok(()),
        };
        if !crate::session_visibility::is_history_visible_session(&meta, sessions_dir) {
            return self.delete_session(session_id);
        }

        let f = &self.fields;
        let title = meta
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(无标题)");
        let agent_dir = meta.get("agentDir").and_then(|v| v.as_str()).unwrap_or("");
        let last_active_at = meta
            .get("lastActiveAt")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let source = meta
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("desktop");
        let message_count = meta
            .get("stats")
            .and_then(|s| s.get("messageCount"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("writer mutex poisoned: {}", e))?;

        // Delete existing title doc only (message docs untouched).
        writer.delete_term(Term::from_field_text(
            f.message_id,
            &format!("{}_title", session_id),
        ));
        let _ = writer.add_document(doc!(
            f.session_id => session_id,
            f.message_id => format!("{}_title", session_id),
            f.agent_dir => agent_dir,
            f.role => "title",
            f.title => title,
            f.content => title,
            f.timestamp => last_active_at,
            f.last_active_at => last_active_at,
            f.source => source,
            f.message_count => message_count,
        ));
        writer
            .commit()
            .map_err(|e| tantivy_error("commit failed", e))?;
        drop(writer);
        self.reader
            .reload()
            .map_err(|e| tantivy_error("reload failed", e))?;
        Ok(())
    }

    /// Delete all documents for a session.
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("writer mutex poisoned: {}", e))?;
        let term = Term::from_field_text(self.fields.session_id, session_id);
        writer.delete_term(term);
        writer
            .commit()
            .map_err(|e| tantivy_error("commit failed", e))?;
        drop(writer);
        self.reader
            .reload()
            .map_err(|e| tantivy_error("reload failed", e))?;
        // Pattern 3 §D.4 — drop the offset sidecar so a re-created session
        // with the same id starts indexing from byte 0.
        self.drop_session_offset(session_id);
        Ok(())
    }

    /// Search sessions by query string.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        data_dir: &Path,
    ) -> Result<SessionSearchResult, String> {
        let start = std::time::Instant::now();
        let searcher = self.reader.searcher();
        let f = &self.fields;

        // Search across title and content fields with title boosted
        let mut parser = QueryParser::for_index(&self.index, vec![f.title, f.content]);
        parser.set_field_boost(f.title, 3.0);

        let tantivy_query = parser
            .parse_query(query)
            .map_err(|e| format!("Query parse error: {}", e))?;

        let top_docs = searcher
            .search(&tantivy_query, &TopDocs::with_limit(limit * 3))
            .map_err(|e| tantivy_error("Search error", e))?;

        // Deduplicate by session_id (keep highest scoring doc per session)
        let mut seen_sessions = HashSet::new();
        let mut hits = Vec::new();
        let query_lower = query.to_lowercase();

        for (score, doc_addr) in top_docs {
            let doc = searcher
                .doc::<tantivy::TantivyDocument>(doc_addr)
                .map_err(|e| tantivy_error("Doc retrieval error", e))?;

            let session_id = get_text_field(&doc, f.session_id);
            if !is_session_currently_history_visible(data_dir, &session_id) {
                continue;
            }
            if !seen_sessions.insert(session_id.clone()) {
                continue;
            }

            // Once we've collected `limit` hits, keep scanning just to count
            // additional unique sessions — this makes `total_count` reflect
            // the true number of matching sessions rather than the page size.
            if hits.len() >= limit {
                continue;
            }

            let role = get_text_field(&doc, f.role);
            let title = get_text_field(&doc, f.title);
            let content = get_text_field(&doc, f.content);
            let agent_dir = get_text_field(&doc, f.agent_dir);
            let last_active_at = get_text_field(&doc, f.last_active_at);
            let source = get_text_field(&doc, f.source);
            let message_count = get_u64_field(&doc, f.message_count);

            let match_type = if role == "title" {
                "title".to_string()
            } else {
                "content".to_string()
            };

            // Build highlighted title
            let title_highlights = find_highlights(&title, &query_lower);

            // Build snippet with highlights for content matches
            let (snippet, snippet_highlights) = if match_type == "content" && role != "title" {
                build_snippet(&content, &query_lower, 80)
            } else {
                (None, vec![])
            };

            hits.push(SessionSearchHit {
                session_id,
                title: title.clone(),
                agent_dir,
                score,
                match_type,
                snippet,
                snippet_highlights,
                title_highlights,
                matched_role: if role == "title" { None } else { Some(role) },
                last_active_at,
                source: Some(source),
                turn_count: Some(message_count as u32),
            });
        }

        Ok(SessionSearchResult {
            total_count: seen_sessions.len(),
            hits,
            query_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Get the total number of documents in the index.
    pub fn doc_count(&self) -> u64 {
        let searcher = self.reader.searcher();
        searcher.num_docs()
    }

    /// Get set of session IDs already in the index.
    fn get_indexed_session_ids(&self) -> HashSet<String> {
        let searcher = self.reader.searcher();
        let mut ids = HashSet::new();

        // Use a term query to find all "title" role docs (one per session)
        let role_term = Term::from_field_text(self.fields.role, "title");
        let query =
            tantivy::query::TermQuery::new(role_term, tantivy::schema::IndexRecordOption::Basic);

        if let Ok(docs) = searcher.search(&query, &TopDocs::with_limit(100_000)) {
            for (_score, addr) in docs {
                if let Ok(doc) = searcher.doc::<tantivy::TantivyDocument>(addr) {
                    let id = get_text_field(&doc, self.fields.session_id);
                    if !id.is_empty() {
                        ids.insert(id);
                    }
                }
            }
        }

        ids
    }

    fn indexed_title_for_session(&self, session_id: &str) -> Option<String> {
        let searcher = self.reader.searcher();
        let title_doc_id = format!("{}_title", session_id);
        let term = Term::from_field_text(self.fields.message_id, &title_doc_id);
        let query = tantivy::query::TermQuery::new(term, tantivy::schema::IndexRecordOption::Basic);
        let docs = searcher.search(&query, &TopDocs::with_limit(1)).ok()?;
        let (_score, addr) = docs.first().copied()?;
        let doc = searcher.doc::<tantivy::TantivyDocument>(addr).ok()?;
        Some(get_text_field(&doc, self.fields.title))
    }
}

fn is_recoverable_index_error(error: &str) -> bool {
    error.starts_with(INDEX_RECOVERY_REQUIRED)
}

fn tantivy_error(context: &str, error: TantivyError) -> String {
    let detail = error.to_string();
    if matches!(error, TantivyError::DataCorruption(_)) || detail.contains("FileDoesNotExist") {
        format!("{} {}: {}", INDEX_RECOVERY_REQUIRED, context, detail)
    } else {
        format!("{}: {}", context, detail)
    }
}

fn reset_session_index_dir(index_dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(index_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(index_dir)
                .map_err(|e| format!("Failed to remove corrupt session index: {}", e))?;
        }
        Ok(_) => fs::remove_file(index_dir)
            .map_err(|e| format!("Failed to remove corrupt session index path: {}", e))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect corrupt session index: {}",
                error
            ));
        }
    }
    Ok(())
}

fn is_session_currently_history_visible(data_dir: &Path, session_id: &str) -> bool {
    let sessions_file = data_dir.join("sessions.json");
    let sessions_dir = data_dir.join("sessions");
    let Ok(content) = fs::read_to_string(sessions_file) else {
        return false;
    };
    let Ok(sessions) = serde_json::from_str::<Vec<serde_json::Value>>(strip_bom(&content)) else {
        return false;
    };
    sessions
        .iter()
        .find(|session| session.get("id").and_then(|v| v.as_str()) == Some(session_id))
        .is_some_and(|session| {
            crate::session_visibility::is_history_visible_session(session, &sessions_dir)
        })
}

/// Read exactly the JSONL byte range needed for an incremental index pass.
/// This keeps append-only reindexing O(delta) instead of reading the full
/// session transcript on every watcher tick.
fn read_jsonl_range(path: &Path, from: u64, to: u64) -> Result<Vec<u8>, String> {
    if from >= to {
        return Ok(Vec::new());
    }

    let mut file = File::open(path).map_err(|e| format!("open jsonl failed: {}", e))?;
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek jsonl failed: {}", e))?;

    let mut bytes = Vec::with_capacity((to - from).min(1024 * 1024) as usize);
    file.take(to - from)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read jsonl range failed: {}", e))?;
    Ok(bytes)
}

/// Index a single session into the provided writer: its title (as a "title"
/// doc) + every text-bearing message from its JSONL file.
///
/// Extracted as a free function so callers can hold the writer lock across
/// an entire batch without re-entering `SessionIndex` methods.
fn index_single_session(
    writer: &mut IndexWriter,
    f: &SessionFields,
    session_meta: &serde_json::Value,
    sessions_dir: &Path,
) -> Result<(), String> {
    let session_id = session_meta
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing session id")?;
    if !crate::session_visibility::is_history_visible_session(session_meta, sessions_dir) {
        writer.delete_term(Term::from_field_text(f.session_id, session_id));
        return Ok(());
    }
    let title = session_meta
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("New Chat");
    let agent_dir = session_meta
        .get("agentDir")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let last_active_at = session_meta
        .get("lastActiveAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source = session_meta
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("desktop");
    let message_count = session_meta
        .get("stats")
        .and_then(|s| s.get("messageCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Add title document
    writer
        .add_document(doc!(
            f.session_id => session_id,
            f.message_id => format!("{}_title", session_id),
            f.agent_dir => agent_dir,
            f.role => "title",
            f.title => title,
            f.content => title,
            f.timestamp => last_active_at,
            f.last_active_at => last_active_at,
            f.source => source,
            f.message_count => message_count,
        ))
        .map_err(|e| format!("Failed to add title doc: {}", e))?;

    // Read and index JSONL messages
    let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() {
        if let Ok(content) = fs::read_to_string(&jsonl_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) {
                    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let timestamp = msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
                    let text = extract_text_content(&msg);

                    if text.is_empty() {
                        continue;
                    }

                    let _ = writer.add_document(doc!(
                        f.session_id => session_id,
                        f.message_id => msg_id,
                        f.agent_dir => agent_dir,
                        f.role => role,
                        f.title => title,
                        f.content => text.as_str(),
                        f.timestamp => timestamp,
                        f.last_active_at => last_active_at,
                        f.source => source,
                        f.message_count => message_count,
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Extract text content from a session message JSON.
///
/// MyAgents persists messages in one of three shapes:
/// - user messages: `content` is a plain string
/// - assistant messages: `content` is a string that is itself a JSON-encoded
///   `ContentBlock[]` array (e.g., `"[{\"type\":\"text\",\"text\":\"...\"}]"`)
/// - legacy assistant messages: `content` is a raw JSON array
///
/// We must extract just the `text` blocks, skipping `tool_use` / `tool_result`
/// / `thinking` blocks so only user-facing text is searchable.
fn extract_text_content(msg: &serde_json::Value) -> String {
    let content = match msg.get("content") {
        Some(c) => c,
        None => return String::new(),
    };

    if let Some(s) = content.as_str() {
        // Try to parse as a stringified JSON array first (assistant path).
        if let Ok(blocks) = serde_json::from_str::<Vec<serde_json::Value>>(s) {
            return blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ");
        }
        // Plain user message string. Hidden system-reminder payload is model
        // context, not user-visible/searchable history.
        return strip_leading_system_reminder(s);
    }

    // Legacy / raw array content.
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
    }

    String::new()
}

/// Get a text field value from a Tantivy document.
fn get_text_field(doc: &tantivy::TantivyDocument, field: tantivy::schema::Field) -> String {
    doc.get_first(field)
        .and_then(|v| match v {
            tantivy::schema::OwnedValue::Str(s) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Get a u64 field value from a Tantivy document.
fn get_u64_field(doc: &tantivy::TantivyDocument, field: tantivy::schema::Field) -> u64 {
    doc.get_first(field)
        .and_then(|v| match v {
            tantivy::schema::OwnedValue::U64(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0)
}

/// Find highlight positions for query terms in text.
///
/// Returns `[start, end]` offsets in **UTF-16 code units** (the unit JavaScript
/// strings are indexed by). The frontend slices highlights with `text.slice`,
/// which operates on UTF-16 units, so byte offsets would be wildly wrong for
/// Chinese content (3 UTF-8 bytes vs 1 UTF-16 unit per CJK char).
fn find_highlights(text: &str, query_lower: &str) -> Vec<[usize; 2]> {
    let text_lower = text.to_lowercase();
    // text.len() and text_lower.len() may differ for exotic locales (e.g.,
    // German ß, Turkish İ). Since JS slices the ORIGINAL text on the frontend,
    // we must map positions back to `text`. For ASCII/CJK/Latin the two are
    // 1:1 so `min` clamp keeps us safe without introducing drift in practice.
    let mut byte_highlights: Vec<[usize; 2]> = Vec::new();

    for word in query_lower.split_whitespace() {
        if word.is_empty() {
            continue;
        }
        let mut search_from = 0;
        while let Some(pos) = text_lower[search_from..].find(word) {
            let abs_byte = search_from + pos;
            byte_highlights.push([abs_byte, abs_byte + word.len()]);
            search_from = abs_byte + word.len();
        }
    }
    byte_highlights.sort_by_key(|h| h[0]);

    // Convert byte offsets (in text_lower) to UTF-16 offsets on `text`.
    // text_lower and text usually have identical byte layout for our
    // target scripts, so we clamp to char boundaries of `text` to be safe.
    byte_highlights
        .into_iter()
        .map(|[s, e]| {
            let s = floor_char_boundary(text, s.min(text.len()));
            let e = ceil_char_boundary(text, e.min(text.len()));
            [byte_to_utf16(text, s), byte_to_utf16(text, e)]
        })
        .collect()
}

/// Build a snippet around the first match, with highlight positions returned
/// in UTF-16 code units relative to the returned snippet string.
///
/// All byte slicing is clamped to UTF-8 char boundaries so Chinese / emoji
/// content cannot panic.
fn build_snippet(
    text: &str,
    query_lower: &str,
    max_len: usize,
) -> (Option<String>, Vec<[usize; 2]>) {
    let text_lower = text.to_lowercase();
    if text_lower.len() != text.len() {
        // Exotic locale — fall back to lowercase-only snippet to stay safe.
        return build_snippet_from_lowercased(&text_lower, query_lower, max_len);
    }

    // Find first query word match in the lowercased text.
    let first_word = query_lower.split_whitespace().next().unwrap_or(query_lower);
    if first_word.is_empty() {
        return (None, vec![]);
    }
    let match_pos = match text_lower.find(first_word) {
        Some(pos) => pos,
        None => return (None, vec![]),
    };

    // Window in UTF-8 bytes — clamp all indices to char boundaries.
    let half = max_len / 2;
    let raw_start = match_pos.saturating_sub(half);
    let raw_end = std::cmp::min(text.len(), match_pos + first_word.len() + half);
    let start = floor_char_boundary(text, raw_start);
    let end = ceil_char_boundary(text, raw_end);

    // Prefer breaking at whitespace / Chinese punctuation to avoid cutting
    // mid-word. We must use `char_indices` (not `find`/`rfind` which return
    // byte offsets) and advance by `char.len_utf8()` — `p + 1` lands inside
    // the next codepoint for multi-byte punctuation like `，` / `。`, which
    // then panics when the returned `end` is used to slice `text`.
    let start = text[start..match_pos]
        .char_indices()
        .find(|(_, c)| c.is_whitespace() || *c == '，' || *c == '。')
        .map(|(p, c)| start + p + c.len_utf8())
        .unwrap_or(start);
    let end_min = std::cmp::min(text.len(), match_pos + first_word.len());
    let end = text[end_min..end]
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace() || *c == '，' || *c == '。')
        .map(|(p, c)| end_min + p + c.len_utf8())
        .unwrap_or(end);
    let end = std::cmp::max(end, end_min);

    let slice = &text[start..end];
    let trimmed = slice.trim();
    let mut result = String::new();
    if start > 0 {
        result.push_str("...");
    }
    result.push_str(trimmed);
    if end < text.len() {
        result.push_str("...");
    }

    // Find highlights inside the produced snippet, then convert to UTF-16.
    let highlights = find_highlights_in_str(&result, query_lower);
    (Some(result), highlights)
}

/// Build a snippet directly from already-lowercased text. Used as a
/// degraded-but-safe fallback for locales where `text.to_lowercase()` changes
/// byte length (so we can no longer map offsets back to the original text).
fn build_snippet_from_lowercased(
    text_lower: &str,
    query_lower: &str,
    max_len: usize,
) -> (Option<String>, Vec<[usize; 2]>) {
    let first_word = query_lower.split_whitespace().next().unwrap_or(query_lower);
    if first_word.is_empty() {
        return (None, vec![]);
    }
    let match_pos = match text_lower.find(first_word) {
        Some(pos) => pos,
        None => return (None, vec![]),
    };
    let half = max_len / 2;
    let start = floor_char_boundary(text_lower, match_pos.saturating_sub(half));
    let end = ceil_char_boundary(
        text_lower,
        std::cmp::min(text_lower.len(), match_pos + first_word.len() + half),
    );
    let slice = &text_lower[start..end];
    let mut result = String::new();
    if start > 0 {
        result.push_str("...");
    }
    result.push_str(slice.trim());
    if end < text_lower.len() {
        result.push_str("...");
    }
    let highlights = find_highlights_in_str(&result, query_lower);
    (Some(result), highlights)
}

/// Find `[start, end]` UTF-16 highlight ranges for every occurrence of any
/// whitespace-separated query word inside `haystack` (case-insensitive).
fn find_highlights_in_str(haystack: &str, query_lower: &str) -> Vec<[usize; 2]> {
    let haystack_lower = haystack.to_lowercase();
    let mut byte_ranges: Vec<[usize; 2]> = Vec::new();

    for word in query_lower.split_whitespace() {
        if word.is_empty() {
            continue;
        }
        let mut search_from = 0;
        while let Some(pos) = haystack_lower[search_from..].find(word) {
            let abs = search_from + pos;
            byte_ranges.push([abs, abs + word.len()]);
            search_from = abs + word.len();
        }
    }
    byte_ranges.sort_by_key(|h| h[0]);

    byte_ranges
        .into_iter()
        .map(|[s, e]| {
            let s = floor_char_boundary(haystack, s.min(haystack.len()));
            let e = ceil_char_boundary(haystack, e.min(haystack.len()));
            [byte_to_utf16(haystack, s), byte_to_utf16(haystack, e)]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    fn write_session_metadata_with_title(data_dir: &Path, session_id: &str, title: &str) {
        let sessions = json!([
            {
                "id": session_id,
                "title": title,
                "agentDir": "/tmp/myagents-test-agent",
                "lastActiveAt": "2026-06-06T00:00:00.000Z",
                "source": "desktop",
                "stats": { "messageCount": 2 }
            }
        ]);
        fs::write(data_dir.join("sessions.json"), sessions.to_string()).unwrap();
    }

    fn write_session_metadata_value(data_dir: &Path, session: serde_json::Value) {
        fs::write(data_dir.join("sessions.json"), json!([session]).to_string()).unwrap();
    }

    fn write_session_metadata(data_dir: &Path, session_id: &str) {
        write_session_metadata_with_title(data_dir, session_id, "Search Tail Read Contract");
    }

    fn message_line(id: &str, content: &str) -> String {
        format!(
            "{}\n",
            json!({
                "id": id,
                "role": "user",
                "timestamp": "2026-06-06T00:00:00.000Z",
                "content": content
            })
        )
    }

    #[test]
    fn extract_text_indexes_only_visible_system_reminder_tail() {
        let content = [
            "<system-reminder>",
            "<myagents-space-issue>",
            "<issue-instruction>hidden issue action</issue-instruction>",
            "<issue>secret facts</issue>",
            "</myagents-space-issue>",
            "</system-reminder>",
            "Space issue delivered",
        ]
        .join("\n");
        let msg = json!({
            "role": "user",
            "content": content
        });

        assert_eq!(extract_text_content(&msg), "Space issue delivered");
    }

    #[test]
    fn extract_text_drops_pure_system_reminder_payload() {
        let content = [
            "<system-reminder>",
            "<HEARTBEAT>",
            "<task-result>hidden cron output</task-result>",
            "</HEARTBEAT>",
            "</system-reminder>",
        ]
        .join("\n");
        let msg = json!({
            "role": "user",
            "content": content
        });

        assert_eq!(extract_text_content(&msg), "");
    }

    #[test]
    fn extract_text_keeps_plain_user_message() {
        let msg = json!({
            "role": "user",
            "content": "Find the release notes"
        });

        assert_eq!(extract_text_content(&msg), "Find the release notes");
    }

    #[test]
    fn read_jsonl_range_returns_requested_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"alpha\nbeta\ngamma\n").unwrap();

        let from = b"alpha\n".len() as u64;
        let to = from + b"beta\n".len() as u64;
        let bytes = read_jsonl_range(&path, from, to).unwrap();

        assert_eq!(bytes, b"beta\n");
    }

    #[test]
    fn read_jsonl_range_empty_when_from_reaches_to() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"alpha\n").unwrap();

        assert!(read_jsonl_range(&path, 6, 6).unwrap().is_empty());
        assert!(read_jsonl_range(&path, 7, 6).unwrap().is_empty());
    }

    #[test]
    fn incremental_reindex_tail_reads_and_indexes_appended_message() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "tail-read-session";
        write_session_metadata(&data_dir, session_id);

        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        fs::write(
            &jsonl_path,
            message_line("m1", "firstunique searchable text"),
        )
        .unwrap();

        let index = SessionIndex::new(temp.path().join("index"), data_dir.clone()).unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();
        let initial_offset = index.read_session_offset(session_id);
        assert!(initial_offset > 0);

        let mut file = OpenOptions::new().append(true).open(&jsonl_path).unwrap();
        file.write_all(message_line("m2", "secondunique appended text").as_bytes())
            .unwrap();

        index.reindex_session(session_id, &sessions_dir).unwrap();

        let updated_offset = index.read_session_offset(session_id);
        assert!(updated_offset > initial_offset);
        let result = index.search("secondunique", 10).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.hits[0].session_id, session_id);
    }

    #[test]
    fn incremental_reindex_does_not_advance_offset_past_partial_line() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "partial-line-session";
        write_session_metadata(&data_dir, session_id);

        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        let first = message_line("m1", "stable indexed text");
        fs::write(&jsonl_path, &first).unwrap();

        let index = SessionIndex::new(temp.path().join("index"), data_dir.clone()).unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();
        let stable_offset = index.read_session_offset(session_id);

        let partial = json!({
            "id": "m2",
            "role": "user",
            "timestamp": "2026-06-06T00:00:00.000Z",
            "content": "latercompleted searchable text"
        })
        .to_string();
        let mut file = OpenOptions::new().append(true).open(&jsonl_path).unwrap();
        file.write_all(partial.as_bytes()).unwrap();
        drop(file);

        index.reindex_session(session_id, &sessions_dir).unwrap();
        assert_eq!(index.read_session_offset(session_id), stable_offset);
        assert_eq!(index.search("latercompleted", 10).unwrap().total_count, 0);

        let mut file = OpenOptions::new().append(true).open(&jsonl_path).unwrap();
        file.write_all(b"\n").unwrap();
        drop(file);

        index.reindex_session(session_id, &sessions_dir).unwrap();
        assert!(index.read_session_offset(session_id) > stable_offset);
        let result = index.search("latercompleted", 10).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.hits[0].session_id, session_id);
    }

    #[test]
    fn incremental_reindex_refreshes_title_when_metadata_changes_with_append() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "title-refresh-session";
        write_session_metadata_with_title(&data_dir, session_id, "oldtitleunique");

        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        fs::write(&jsonl_path, message_line("m1", "first body text")).unwrap();

        let index = SessionIndex::new(temp.path().join("index"), data_dir.clone()).unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();

        write_session_metadata_with_title(&data_dir, session_id, "newtitleunique");
        let mut file = OpenOptions::new().append(true).open(&jsonl_path).unwrap();
        file.write_all(message_line("m2", "appended title refresh body").as_bytes())
            .unwrap();

        index.reindex_session(session_id, &sessions_dir).unwrap();

        assert_eq!(index.search("newtitleunique", 10).unwrap().total_count, 1);
        assert_eq!(index.search("oldtitleunique", 10).unwrap().total_count, 0);
    }

    #[test]
    fn incremental_reindex_utf8_split_falls_back_to_full_rebuild() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "utf8-fallback-session";
        write_session_metadata(&data_dir, session_id);

        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        let content = format!(
            "{}{}",
            message_line("m1", "prefix 多字节内容"),
            message_line("m2", "boundaryunique recovered text")
        );
        fs::write(&jsonl_path, &content).unwrap();

        let bytes = fs::read(&jsonl_path).unwrap();
        let split_offset = bytes
            .windows("多".len())
            .position(|window| window == "多".as_bytes())
            .map(|pos| pos as u64 + 1)
            .unwrap();

        let index = SessionIndex::new(temp.path().join("index"), data_dir.clone()).unwrap();
        index.write_session_offset(session_id, split_offset);
        index.reindex_session(session_id, &sessions_dir).unwrap();

        assert_eq!(index.read_session_offset(session_id), bytes.len() as u64);
        let result = index.search("boundaryunique", 10).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.hits[0].session_id, session_id);
    }

    #[test]
    fn prepared_session_is_hidden_until_committed() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "prepared-search-session";

        write_session_metadata_value(
            &data_dir,
            json!({
                "id": session_id,
                "title": "preparedunique",
                "agentDir": "/tmp/myagents-test-agent",
                "lastActiveAt": "2026-06-06T00:00:00.000Z",
                "source": "desktop",
                "materializationState": "prepared",
                "stats": { "messageCount": 1 }
            }),
        );
        fs::write(
            sessions_dir.join(format!("{}.jsonl", session_id)),
            message_line("m1", "preparedbodyunique searchable text"),
        )
        .unwrap();

        let index = SessionIndex::new(
            data_dir.join("search_index").join("sessions"),
            data_dir.clone(),
        )
        .unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();

        assert_eq!(index.search("preparedunique", 10).unwrap().total_count, 0);
        assert_eq!(
            index.search("preparedbodyunique", 10).unwrap().total_count,
            0
        );
        assert_eq!(index.read_session_offset(session_id), 0);

        write_session_metadata_value(
            &data_dir,
            json!({
                "id": session_id,
                "title": "committedunique",
                "agentDir": "/tmp/myagents-test-agent",
                "lastActiveAt": "2026-06-06T00:00:00.000Z",
                "source": "desktop",
                "stats": { "messageCount": 1 }
            }),
        );
        index.reindex_session(session_id, &sessions_dir).unwrap();

        assert_eq!(index.search("committedunique", 10).unwrap().total_count, 1);
        assert_eq!(
            index.search("preparedbodyunique", 10).unwrap().total_count,
            1
        );
    }

    #[test]
    fn search_filters_stale_hidden_docs_before_cleanup_runs() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "stale-hidden-query-session";

        write_session_metadata_with_title(&data_dir, session_id, "stalequeryunique");
        fs::write(
            sessions_dir.join(format!("{}.jsonl", session_id)),
            message_line("m1", "stalequerybodyunique searchable text"),
        )
        .unwrap();

        let index = SessionIndex::new(
            data_dir.join("search_index").join("sessions"),
            data_dir.clone(),
        )
        .unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();
        assert_eq!(index.search("stalequeryunique", 10).unwrap().total_count, 1);

        write_session_metadata_value(
            &data_dir,
            json!({
                "id": session_id,
                "title": "stalequeryunique",
                "agentDir": "/tmp/myagents-test-agent",
                "lastActiveAt": "2026-06-06T00:00:00.000Z",
                "source": "desktop",
                "materializationState": "prepared",
                "stats": { "messageCount": 1 }
            }),
        );

        assert_eq!(index.search("stalequeryunique", 10).unwrap().total_count, 0);
        assert_eq!(
            index
                .search("stalequerybodyunique", 10)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn legacy_managed_codex_empty_draft_deletes_stale_index_docs() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "legacy-managed-codex-draft";

        write_session_metadata_with_title(&data_dir, session_id, "staledraftunique");
        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        fs::write(
            &jsonl_path,
            message_line("m1", "stalecontentunique searchable text"),
        )
        .unwrap();

        let index = SessionIndex::new(
            data_dir.join("search_index").join("sessions"),
            data_dir.clone(),
        )
        .unwrap();
        index.reindex_session(session_id, &sessions_dir).unwrap();
        assert_eq!(index.search("staledraftunique", 10).unwrap().total_count, 1);
        assert_eq!(
            index.search("stalecontentunique", 10).unwrap().total_count,
            1
        );

        fs::remove_file(&jsonl_path).unwrap();
        write_session_metadata_value(
            &data_dir,
            json!({
                "id": session_id,
                "title": "New Chat",
                "agentDir": "/tmp/myagents-test-agent",
                "lastActiveAt": "2026-06-06T00:00:00.000Z",
                "source": "desktop",
                "runtime": "codex",
                "runtimeSource": "managed-provider",
                "providerId": "codex-sub",
                "origin": { "kind": "desktop", "surface": "agent_card" },
                "stats": { "messageCount": 0 }
            }),
        );

        index.index_all_sessions(&data_dir).unwrap();

        assert_eq!(index.search("staledraftunique", 10).unwrap().total_count, 0);
        assert_eq!(
            index.search("stalecontentunique", 10).unwrap().total_count,
            0
        );
    }

    #[test]
    fn missing_delete_segment_rebuilds_derived_index_without_touching_session_data() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let sessions_dir = data_dir.join("sessions");
        let index_dir = data_dir.join("search_index").join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let session_id = "missing-delete-segment";
        let keeper_id = "missing-delete-segment-keeper";
        fs::write(
            data_dir.join("sessions.json"),
            json!([
                {
                    "id": session_id,
                    "title": "recoverableunique",
                    "agentDir": "/tmp/myagents-test-agent",
                    "lastActiveAt": "2026-06-06T00:00:00.000Z",
                    "source": "desktop",
                    "stats": { "messageCount": 1 }
                },
                {
                    "id": keeper_id,
                    "title": "keeperunique",
                    "agentDir": "/tmp/myagents-test-agent",
                    "lastActiveAt": "2026-06-06T00:00:00.000Z",
                    "source": "desktop",
                    "stats": { "messageCount": 1 }
                }
            ])
            .to_string(),
        )
        .unwrap();
        let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
        fs::write(
            &jsonl_path,
            message_line("m1", "recoverablebodyunique searchable text"),
        )
        .unwrap();
        fs::write(
            sessions_dir.join(format!("{}.jsonl", keeper_id)),
            message_line("m2", "keeperbodyunique searchable text"),
        )
        .unwrap();
        let transcript_before = fs::read(&jsonl_path).unwrap();

        let index = SessionIndex::new(index_dir.clone(), data_dir.clone()).unwrap();
        index.index_all_sessions(&data_dir).unwrap();
        assert_eq!(
            index.search("recoverableunique", 10).unwrap().total_count,
            1
        );
        assert_eq!(index.search("keeperunique", 10).unwrap().total_count, 1);

        let metadata_path = data_dir.join("sessions.json");
        let updated_metadata = fs::read_to_string(&metadata_path)
            .unwrap()
            .replace("keeperunique", "recoveredkeeperunique");
        fs::write(&metadata_path, updated_metadata).unwrap();
        let metadata_before = fs::read(&metadata_path).unwrap();

        drop(index);

        // Construct the corrupt state directly. Tantivy may optimize a real
        // delete into a segment rewrite, so relying on it to emit a `.del`
        // file makes this recovery test platform-dependent.
        let index_meta_path = index_dir.join("meta.json");
        let mut index_meta: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_meta_path).unwrap()).unwrap();
        let opstamp = index_meta["opstamp"].as_u64().unwrap();
        let segment = index_meta["segments"]
            .as_array_mut()
            .and_then(|segments| segments.first_mut())
            .unwrap();
        segment["deletes"] = json!({
            "num_deleted_docs": 1,
            "opstamp": opstamp,
        });
        fs::write(
            &index_meta_path,
            serde_json::to_vec_pretty(&index_meta).unwrap(),
        )
        .unwrap();

        let index = SessionIndex::new(index_dir, data_dir.clone()).unwrap();
        index.index_all_sessions(&data_dir).unwrap();

        assert_eq!(
            index.search("recoverableunique", 10).unwrap().total_count,
            1
        );
        assert_eq!(
            index
                .search("recoveredkeeperunique", 10)
                .unwrap()
                .total_count,
            1
        );
        assert_eq!(
            fs::read(data_dir.join("sessions.json")).unwrap(),
            metadata_before
        );
        assert_eq!(fs::read(jsonl_path).unwrap(), transcript_before);
    }

    #[test]
    fn active_writer_lock_is_never_deleted_as_stale() {
        let temp = tempfile::tempdir().unwrap();
        let index_dir = temp.path().join("index");
        let data_dir = temp.path().join("data");
        let first = SessionIndex::new(index_dir.clone(), data_dir.clone()).unwrap();
        let lock_path = index_dir.join(".tantivy-writer.lock");

        assert!(SessionIndex::new(index_dir.clone(), data_dir.clone()).is_err());
        assert!(lock_path.exists());

        drop(first);
        SessionIndex::new(index_dir, data_dir).unwrap();
    }

    #[test]
    fn user_query_cannot_impersonate_index_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let index_dir = temp.path().join("index");
        let data_dir = temp.path().join("data");
        let marker = index_dir.join("must-remain");
        let index = SessionIndex::new(index_dir.clone(), data_dir).unwrap();
        fs::write(&marker, "derived-state-marker").unwrap();

        let error = index.search("FileDoesNotExist:anything", 10).unwrap_err();

        assert!(error.contains("Field does not exist"));
        assert!(marker.exists(), "query errors must not reset the index");
    }
}
