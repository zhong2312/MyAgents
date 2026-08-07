//! Bounded large-response spill path for renderer HTTP dispatch.
//!
//! This module deliberately owns only proxy responses that are currently being
//! written plus failed-cleanup debt. Successfully committed body/meta pairs are
//! handed to the existing `/refs/:id` TTL lifecycle; attachments and Node-side
//! refs stay outside this budget.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::ulog_warn;

pub(crate) const PROXY_STREAM_THRESHOLD_BYTES: u64 = 1024 * 1024;
pub(crate) const LOOPBACK_RESPONSE_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const EXTERNAL_RESPONSE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROXY_SPILL_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const REF_COMMIT_MAX_ATTEMPTS: usize = 8;
const PREVIEW_BYTES: usize = 8 * 1024;
const ORPHAN_RETRIES_PER_SPILL: usize = 16;
const ORPHAN_RETRY_MAX_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy)]
pub(crate) struct ResponsePolicy {
    pub(crate) max_bytes: u64,
    pub(crate) spill_threshold_bytes: u64,
    pub(crate) allow_spill: bool,
}

impl ResponsePolicy {
    pub(crate) fn for_target(is_loopback: bool) -> Self {
        if is_loopback {
            Self {
                max_bytes: LOOPBACK_RESPONSE_MAX_BYTES,
                spill_threshold_bytes: PROXY_STREAM_THRESHOLD_BYTES,
                allow_spill: true,
            }
        } else {
            Self {
                max_bytes: EXTERNAL_RESPONSE_MAX_BYTES,
                spill_threshold_bytes: EXTERNAL_RESPONSE_MAX_BYTES,
                allow_spill: false,
            }
        }
    }

    pub(crate) fn check_content_length(self, content_length: Option<u64>) -> Result<(), String> {
        if let Some(length) = content_length {
            if length > self.max_bytes {
                return Err(format!(
                    "[proxy] response Content-Length {} exceeds {} byte limit",
                    length, self.max_bytes
                ));
            }
        }
        Ok(())
    }
}

pub(crate) struct SpilledBody {
    pub(crate) ref_url: String,
    pub(crate) mimetype: String,
    pub(crate) size_bytes: u64,
}

pub(crate) enum StreamOutcome {
    Buffered(Vec<u8>),
    Spilled(SpilledBody),
    Failed(String),
}

struct OrphanGroup {
    paths: Vec<PathBuf>,
    bytes: u64,
    failed_attempts: u32,
    next_retry_at: Instant,
}

impl OrphanGroup {
    fn after_failed_delete(paths: Vec<PathBuf>, bytes: u64) -> Self {
        let failed_attempts = 1;
        Self {
            paths,
            bytes,
            failed_attempts,
            next_retry_at: Instant::now() + orphan_retry_delay(failed_attempts),
        }
    }
}

#[derive(Default)]
struct BudgetState {
    active_bytes: u64,
    orphan_debt_bytes: u64,
    orphans: VecDeque<OrphanGroup>,
    inventory_complete: bool,
}

/// App-lifetime owner for proxy spill reservations and known cleanup debt.
pub(crate) struct ProxySpillManager {
    refs_dir: PathBuf,
    max_bytes: u64,
    state: Mutex<BudgetState>,
}

impl ProxySpillManager {
    pub(crate) fn new(refs_dir: PathBuf) -> Self {
        Self::with_limit(refs_dir, PROXY_SPILL_BUDGET_BYTES)
    }

    fn with_limit(refs_dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            refs_dir,
            max_bytes,
            state: Mutex::new(BudgetState::default()),
        }
    }

    /// Run after the single-instance lock is acquired, before renderer
    /// requests can create new proxy spills.
    pub(crate) async fn recover_startup_orphans(&self) -> Result<usize, String> {
        let mut state = self.state.lock().await;
        if state.inventory_complete {
            return Ok(0);
        }
        let entries = match std::fs::read_dir(&self.refs_dir) {
            Ok(entries) => entries
                .map(|entry| {
                    entry
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .map_err(|error| {
                            format!(
                                "[proxy] failed to enumerate refs directory {}: {}",
                                self.refs_dir.display(),
                                error
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                state.inventory_complete = true;
                return Ok(0);
            }
            Err(error) => {
                return Err(format!(
                    "[proxy] failed to scan refs directory {}: {}",
                    self.refs_dir.display(),
                    error
                ))
            }
        };
        let names = entries
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut candidates = Vec::new();
        let mut fallback_bytes = 0_u64;

        for name in entries {
            let is_body_orphan = is_ref_id(&name) && !names.contains(&format!("{name}.meta.json"));
            let is_body_part = name.strip_suffix(".part").is_some_and(is_ref_id);
            let is_meta_part = name.strip_suffix(".meta.json.part").is_some_and(is_ref_id);
            if !is_body_orphan && !is_body_part && !is_meta_part {
                continue;
            }

            let path = self.refs_dir.join(name);
            let bytes = std::fs::metadata(&path)
                .map_err(|error| {
                    format!(
                        "[proxy] failed to measure incomplete ref {}: {}",
                        path.display(),
                        error
                    )
                })?
                .len();
            fallback_bytes = fallback_bytes.saturating_add(bytes);
            candidates.push(path);
        }

        let candidate_count = candidates.len();
        let (remaining, remaining_bytes) = remove_paths(candidates, fallback_bytes).await;
        let removed = candidate_count.saturating_sub(remaining.len());
        if !remaining.is_empty() {
            let orphan = OrphanGroup::after_failed_delete(remaining, remaining_bytes);
            ulog_warn!(
                "[proxy] startup orphan cleanup blocked paths={} bytes={} attempt=1 retry_ms={}",
                orphan.paths.len(),
                orphan.bytes,
                orphan_retry_delay(1).as_millis()
            );
            state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_add(orphan.bytes);
            state.orphans.push_back(orphan);
        }
        state.inventory_complete = true;
        Ok(removed)
    }

    async fn prepare_spill(&self) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.refs_dir)
            .await
            .map_err(|error| format!("[proxy] failed to create refs directory: {error}"))?;
        if !self.state.lock().await.inventory_complete {
            return Err(
                "[proxy] startup ref inventory is incomplete; refusing new spill".to_string(),
            );
        }
        self.retry_orphans().await;
        Ok(())
    }

    /// Retry only when new disk growth is requested. There is no permanent GC
    /// worker; one spill demand processes at most a small fixed number of
    /// known groups.
    async fn retry_orphans(&self) {
        let mut state = self.state.lock().await;
        let attempts = state.orphans.len().min(ORPHAN_RETRIES_PER_SPILL);
        let now = Instant::now();
        for _ in 0..attempts {
            let Some(mut orphan) = state.orphans.pop_front() else {
                break;
            };
            if orphan.next_retry_at > now {
                state.orphans.push_back(orphan);
                continue;
            }
            let old_bytes = orphan.bytes;
            let (remaining, remaining_bytes) = remove_paths(orphan.paths, old_bytes).await;
            if remaining.is_empty() {
                state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_sub(old_bytes);
            } else {
                orphan.paths = remaining;
                orphan.bytes = remaining_bytes;
                orphan.failed_attempts = orphan.failed_attempts.saturating_add(1);
                let delay = orphan_retry_delay(orphan.failed_attempts);
                orphan.next_retry_at = now + delay;
                state.orphan_debt_bytes = state
                    .orphan_debt_bytes
                    .saturating_sub(old_bytes)
                    .saturating_add(remaining_bytes);
                ulog_warn!(
                    "[proxy] orphan cleanup still blocked paths={} bytes={} attempt={} retry_ms={}",
                    orphan.paths.len(),
                    orphan.bytes,
                    orphan.failed_attempts,
                    delay.as_millis()
                );
                state.orphans.push_back(orphan);
            }
        }
    }

    async fn reserve(&self, additional_bytes: u64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let used = state
            .active_bytes
            .checked_add(state.orphan_debt_bytes)
            .ok_or_else(|| "[proxy] spill budget overflow".to_string())?;
        let requested = used
            .checked_add(additional_bytes)
            .ok_or_else(|| "[proxy] spill budget overflow".to_string())?;
        if requested > self.max_bytes {
            return Err(format!(
                "[proxy] spill budget exceeded: requested {} bytes with {} of {} bytes in use",
                additional_bytes, used, self.max_bytes
            ));
        }
        state.active_bytes += additional_bytes;
        Ok(())
    }

    async fn finish(&self, reserved_bytes: u64, orphan: Option<OrphanGroup>) {
        let mut state = self.state.lock().await;
        debug_assert!(state.active_bytes >= reserved_bytes);
        state.active_bytes = state.active_bytes.saturating_sub(reserved_bytes);
        if let Some(orphan) = orphan {
            ulog_warn!(
                "[proxy] spill cleanup became debt paths={} bytes={} attempt={} retry_ms={}",
                orphan.paths.len(),
                orphan.bytes,
                orphan.failed_attempts,
                orphan
                    .next_retry_at
                    .saturating_duration_since(Instant::now())
                    .as_millis()
            );
            state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_add(orphan.bytes);
            state.orphans.push_back(orphan);
        }
    }

    #[cfg(test)]
    async fn budget_snapshot(&self) -> (u64, u64, usize) {
        let state = self.state.lock().await;
        (
            state.active_bytes,
            state.orphan_debt_bytes,
            state.orphans.len(),
        )
    }

    #[cfg(test)]
    async fn make_orphans_due(&self) {
        let mut state = self.state.lock().await;
        for orphan in &mut state.orphans {
            orphan.next_retry_at = Instant::now();
        }
    }
}

fn orphan_retry_delay(failed_attempts: u32) -> Duration {
    let exponent = failed_attempts.saturating_sub(1).min(9);
    Duration::from_secs(1_u64 << exponent).min(ORPHAN_RETRY_MAX_DELAY)
}

struct SpillState {
    file: Option<File>,
    id: String,
    body_part_path: PathBuf,
    body_path: PathBuf,
    meta_part_path: PathBuf,
    meta_path: PathBuf,
    cleanup_paths: Vec<PathBuf>,
    reserved_bytes: u64,
}

fn is_ref_id(value: &str) -> bool {
    (8..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn path_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "[proxy] failed to inspect spill target {}: {}",
            path.display(),
            error
        )),
    }
}

async fn any_path_exists(paths: &[&Path]) -> Result<bool, String> {
    for path in paths {
        if path_exists(path).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn init_spill(manager: &Arc<ProxySpillManager>) -> Result<SpillState, String> {
    init_spill_with(manager, || uuid::Uuid::new_v4().simple().to_string()).await
}

async fn init_spill_with<F>(
    manager: &Arc<ProxySpillManager>,
    mut next_id: F,
) -> Result<SpillState, String>
where
    F: FnMut() -> String,
{
    manager.prepare_spill().await?;
    for _ in 0..REF_COMMIT_MAX_ATTEMPTS {
        let id = next_id();
        if id.len() != 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("[proxy] ref id source returned a non-32-hex id".to_string());
        }
        let body_part_path = manager.refs_dir.join(format!("{id}.part"));
        let body_path = manager.refs_dir.join(&id);
        let meta_part_path = manager.refs_dir.join(format!("{id}.meta.json.part"));
        let meta_path = manager.refs_dir.join(format!("{id}.meta.json"));
        let file = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&body_part_path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "[proxy] failed to claim spill part {}: {}",
                    body_part_path.display(),
                    error
                ))
            }
        };

        let target_exists = match any_path_exists(&[&body_path, &meta_part_path, &meta_path]).await
        {
            Ok(exists) => exists,
            Err(error) => {
                drop(file);
                let _ = tokio::fs::remove_file(&body_part_path).await;
                return Err(error);
            }
        };
        if target_exists {
            drop(file);
            let _ = tokio::fs::remove_file(&body_part_path).await;
            continue;
        }

        return Ok(SpillState {
            file: Some(file),
            id,
            body_part_path: body_part_path.clone(),
            body_path,
            meta_part_path,
            meta_path,
            cleanup_paths: vec![body_part_path],
            reserved_bytes: 0,
        });
    }

    Err(format!(
        "[proxy] ref commit collided {REF_COMMIT_MAX_ATTEMPTS} times"
    ))
}

async fn write_reserved(
    manager: &ProxySpillManager,
    spill: &mut SpillState,
    bytes: &[u8],
) -> Result<(), String> {
    let byte_count = bytes.len() as u64;
    manager.reserve(byte_count).await?;
    spill.reserved_bytes += byte_count;
    spill
        .file
        .as_mut()
        .expect("spill file must be open while streaming")
        .write_all(bytes)
        .await
        .map_err(|error| format!("[proxy] failed to write spill body: {error}"))
}

/// Measure unique content still retained by protocol orphan paths.
///
/// Body/meta commit uses hard links, so pathname count is not byte identity.
/// A leftover `.part` that aliases a complete final pair retains no additional
/// blocks beyond the TTL-owned pair and is tracked only for deletion retry.
fn measure_remaining_debt(paths: &[PathBuf]) -> Option<u64> {
    struct IdentityGroup {
        handle: same_file::Handle,
        bytes: u64,
        owned_by_committed_pair: bool,
    }

    fn path_exists(path: &Path) -> std::io::Result<bool> {
        match std::fs::metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn aliases_committed_pair(path: &Path) -> std::io::Result<bool> {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return Ok(false);
        };
        let Some(parent) = path.parent() else {
            return Ok(false);
        };

        let (target, companion) = if let Some(id) = name.strip_suffix(".meta.json.part") {
            if !is_ref_id(id) {
                return Ok(false);
            }
            (parent.join(format!("{id}.meta.json")), parent.join(id))
        } else if let Some(id) = name.strip_suffix(".part") {
            if !is_ref_id(id) {
                return Ok(false);
            }
            (parent.join(id), parent.join(format!("{id}.meta.json")))
        } else {
            return Ok(false);
        };

        if !path_exists(&target)? || !path_exists(&companion)? {
            return Ok(false);
        }
        same_file::is_same_file(path, target)
    }

    let mut groups: Vec<IdentityGroup> = Vec::new();
    for path in paths {
        let metadata = std::fs::metadata(path).ok()?;
        let handle = same_file::Handle::from_path(path).ok()?;
        let owned_by_committed_pair = aliases_committed_pair(path).ok()?;
        if let Some(group) = groups.iter_mut().find(|group| group.handle == handle) {
            group.bytes = group.bytes.max(metadata.len());
            group.owned_by_committed_pair |= owned_by_committed_pair;
        } else {
            groups.push(IdentityGroup {
                handle,
                bytes: metadata.len(),
                owned_by_committed_pair,
            });
        }
    }

    Some(
        groups
            .into_iter()
            .filter(|group| !group.owned_by_committed_pair)
            .fold(0_u64, |total, group| total.saturating_add(group.bytes)),
    )
}

async fn remove_paths(paths: Vec<PathBuf>, fallback_bytes: u64) -> (Vec<PathBuf>, u64) {
    let mut remaining = Vec::new();
    for path in paths {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                remaining.push(path);
            }
        }
    }
    let debt_bytes = measure_remaining_debt(&remaining).unwrap_or(fallback_bytes);
    (remaining, debt_bytes)
}

async fn fail_spill(
    manager: &ProxySpillManager,
    mut spill: SpillState,
    error: String,
) -> StreamOutcome {
    drop(spill.file.take());
    let (remaining, remaining_bytes) =
        remove_paths(spill.cleanup_paths, spill.reserved_bytes).await;
    let orphan = (!remaining.is_empty())
        .then(|| OrphanGroup::after_failed_delete(remaining, remaining_bytes));
    manager.finish(spill.reserved_bytes, orphan).await;
    StreamOutcome::Failed(error)
}

async fn finish_spill(
    manager: &ProxySpillManager,
    mut spill: SpillState,
    content_type: &str,
    request_url: &str,
    size_bytes: u64,
    preview_buf: &[u8],
) -> StreamOutcome {
    let file = spill
        .file
        .as_mut()
        .expect("spill file must remain open until commit");
    if let Err(error) = file.flush().await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to flush spill body: {error}"),
        )
        .await;
    }
    if let Err(error) = file.sync_data().await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to sync spill body: {error}"),
        )
        .await;
    }
    drop(spill.file.take());

    if let Err(error) = tokio::fs::hard_link(&spill.body_part_path, &spill.body_path).await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to expose spill body without clobber: {error}"),
        )
        .await;
    }
    spill.cleanup_paths.push(spill.body_path.clone());

    let mimetype = if content_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        content_type.to_string()
    };
    let expires_at_ms = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0))
    .saturating_add(60 * 60 * 1000);
    let metadata = serde_json::json!({
        "kind": "ref",
        "id": spill.id,
        "sizeBytes": size_bytes,
        "mimetype": mimetype,
        "preview": BASE64.encode(preview_buf),
        "expiresAt": expires_at_ms,
    });
    let meta_bytes = match serde_json::to_vec(&metadata) {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail_spill(
                manager,
                spill,
                format!("[proxy] failed to serialize ref metadata: {error}"),
            )
            .await
        }
    };
    if let Err(error) = manager.reserve(meta_bytes.len() as u64).await {
        return fail_spill(manager, spill, error).await;
    }
    spill.reserved_bytes += meta_bytes.len() as u64;

    let mut meta_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&spill.meta_part_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            return fail_spill(
                manager,
                spill,
                format!("[proxy] failed to claim ref metadata part: {error}"),
            )
            .await
        }
    };
    spill.cleanup_paths.push(spill.meta_part_path.clone());
    if let Err(error) = meta_file.write_all(&meta_bytes).await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to write ref metadata: {error}"),
        )
        .await;
    }
    if let Err(error) = meta_file.flush().await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to flush ref metadata: {error}"),
        )
        .await;
    }
    if let Err(error) = meta_file.sync_data().await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to sync ref metadata: {error}"),
        )
        .await;
    }
    drop(meta_file);

    if let Err(error) = tokio::fs::hard_link(&spill.meta_part_path, &spill.meta_path).await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to expose ref metadata without clobber: {error}"),
        )
        .await;
    }

    // Meta is the reader-visible commit marker. Keep the final pair and remove
    // only the hard-link aliases. If unlink is blocked, the existing stale-part
    // GC can retry; aliases do not consume additional file blocks or budget.
    let _ = remove_paths(
        vec![spill.body_part_path.clone(), spill.meta_part_path.clone()],
        0,
    )
    .await;
    manager.finish(spill.reserved_bytes, None).await;

    let ref_url = origin_of(request_url)
        .map(|origin| format!("{origin}/refs/{}", spill.id))
        .unwrap_or_else(|| format!("http://127.0.0.1/refs/{}", spill.id));
    StreamOutcome::Spilled(SpilledBody {
        ref_url,
        mimetype,
        size_bytes,
    })
}

pub(crate) async fn stream_response_body(
    response: reqwest::Response,
    content_type: &str,
    request_url: &str,
    policy: ResponsePolicy,
    force_spill: bool,
    manager: Arc<ProxySpillManager>,
) -> StreamOutcome {
    let threshold = policy.spill_threshold_bytes as usize;
    let mut spill = if force_spill && policy.allow_spill {
        match init_spill(&manager).await {
            Ok(spill) => Some(spill),
            Err(error) => return StreamOutcome::Failed(error),
        }
    } else {
        None
    };
    let mut buffer = Vec::new();
    let mut size_bytes = 0_u64;
    let mut preview_buf = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("[proxy] upstream stream error: {error}");
                return match spill {
                    Some(spill) => fail_spill(&manager, spill, message).await,
                    None => StreamOutcome::Failed(message),
                };
            }
        };
        let next_size = match size_bytes.checked_add(chunk.len() as u64) {
            Some(size) if size <= policy.max_bytes => size,
            _ => {
                let message = format!(
                    "[proxy] response body exceeds {} byte limit",
                    policy.max_bytes
                );
                return match spill {
                    Some(spill) => fail_spill(&manager, spill, message).await,
                    None => StreamOutcome::Failed(message),
                };
            }
        };
        size_bytes = next_size;
        if preview_buf.len() < PREVIEW_BYTES {
            let take = PREVIEW_BYTES
                .saturating_sub(preview_buf.len())
                .min(chunk.len());
            preview_buf.extend_from_slice(&chunk[..take]);
        }

        if let Some(active_spill) = spill.as_mut() {
            if let Err(error) = write_reserved(&manager, active_spill, &chunk).await {
                let active_spill = spill.take().expect("active spill exists");
                return fail_spill(&manager, active_spill, error).await;
            }
        } else if policy.allow_spill && buffer.len().saturating_add(chunk.len()) > threshold {
            let mut active_spill = match init_spill(&manager).await {
                Ok(spill) => spill,
                Err(error) => return StreamOutcome::Failed(error),
            };
            if let Err(error) = write_reserved(&manager, &mut active_spill, &buffer).await {
                return fail_spill(&manager, active_spill, error).await;
            }
            if let Err(error) = write_reserved(&manager, &mut active_spill, &chunk).await {
                return fail_spill(&manager, active_spill, error).await;
            }
            buffer.clear();
            buffer.shrink_to_fit();
            spill = Some(active_spill);
        } else {
            buffer.extend_from_slice(&chunk);
        }
    }

    match spill {
        Some(spill) => {
            finish_spill(
                &manager,
                spill,
                content_type,
                request_url,
                size_bytes,
                &preview_buf,
            )
            .await
        }
        None => StreamOutcome::Buffered(buffer),
    }
}

fn origin_of(absolute_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(absolute_url).ok()?;
    let host = parsed.host_str()?;
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{host}{port}", parsed.scheme()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    async fn response_with_body(
        body: Vec<u8>,
        declared_length: Option<u64>,
    ) -> (reqwest::Response, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind response server");
        let address = listener.local_addr().expect("response server address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let length_header = declared_length
                .map(|length| format!("Content-Length: {length}\r\n"))
                .unwrap_or_default();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n{length_header}Connection: close\r\n\r\n"
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("write headers");
            socket.write_all(&body).await.expect("write body");
            let _ = socket.shutdown().await;
        });
        let url = format!("http://{address}/api/test");
        let response = crate::local_http::builder()
            .build()
            .expect("test client")
            .get(&url)
            .send()
            .await
            .expect("test response");
        (response, url)
    }

    async fn held_chunked_response(
        body: Vec<u8>,
        misleading_content_length: Option<u64>,
    ) -> (
        reqwest::Response,
        String,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind chunked response server");
        let address = listener.local_addr().expect("response server address");
        let (ready_tx, ready_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let length_header = misleading_content_length
                .map(|length| format!("Content-Length: {length}\r\n"))
                .unwrap_or_default();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n{length_header}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("write headers");
            socket
                .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                .await
                .expect("write chunk length");
            socket.write_all(&body).await.expect("write chunk body");
            socket.write_all(b"\r\n").await.expect("finish chunk");
            socket.flush().await.expect("flush held chunk");
            let _ = ready_tx.send(());
            let _ = release_rx.await;
            let _ = socket.write_all(b"0\r\n\r\n").await;
            let _ = socket.shutdown().await;
        });
        let url = format!("http://{address}/api/test");
        let response = crate::local_http::builder()
            .build()
            .expect("test client")
            .get(&url)
            .send()
            .await
            .expect("test response");
        (response, url, ready_rx, release_tx)
    }

    async fn interrupted_chunked_response(body: Vec<u8>) -> (reqwest::Response, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind interrupted response server");
        let address = listener.local_addr().expect("response server address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write headers");
            socket
                .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                .await
                .expect("write chunk length");
            socket.write_all(&body).await.expect("write partial body");
            socket.write_all(b"\r\n").await.expect("finish chunk");
            socket.flush().await.expect("flush partial stream");
            // Drop without the terminating zero-length chunk.
        });
        let url = format!("http://{address}/api/test");
        let response = crate::local_http::builder()
            .build()
            .expect("test client")
            .get(&url)
            .send()
            .await
            .expect("test response");
        (response, url)
    }

    #[tokio::test]
    async fn reservation_cap_is_atomic_across_three_concurrent_requests() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(root.path().to_path_buf(), 14));

        let (first, second, third) =
            tokio::join!(manager.reserve(7), manager.reserve(7), manager.reserve(7));
        assert_eq!(
            [first, second, third]
                .into_iter()
                .filter(Result::is_ok)
                .count(),
            2
        );
        assert_eq!(manager.budget_snapshot().await.0, 14);
    }

    #[tokio::test]
    async fn three_live_response_streams_share_one_atomic_disk_budget() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            85_000,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let (first_response, first_url, first_ready, first_release) =
            held_chunked_response(vec![1_u8; 30_000], None).await;
        let (second_response, second_url, second_ready, second_release) =
            held_chunked_response(vec![2_u8; 30_000], None).await;
        let (third_response, third_url, third_ready, third_release) =
            held_chunked_response(vec![3_u8; 30_000], None).await;
        let policy = ResponsePolicy {
            max_bytes: 35_000,
            spill_threshold_bytes: 1,
            allow_spill: true,
        };

        let first_manager = Arc::clone(&manager);
        let first_task = tauri::async_runtime::spawn(async move {
            stream_response_body(
                first_response,
                "application/octet-stream",
                &first_url,
                policy,
                true,
                first_manager,
            )
            .await
        });
        let second_manager = Arc::clone(&manager);
        let second_task = tauri::async_runtime::spawn(async move {
            stream_response_body(
                second_response,
                "application/octet-stream",
                &second_url,
                policy,
                true,
                second_manager,
            )
            .await
        });
        let third_manager = Arc::clone(&manager);
        let third_task = tauri::async_runtime::spawn(async move {
            stream_response_body(
                third_response,
                "application/octet-stream",
                &third_url,
                policy,
                true,
                third_manager,
            )
            .await
        });
        let _ = tokio::join!(first_ready, second_ready, third_ready);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if manager.budget_snapshot().await.0 == 60_000 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("two streams must hold the budget while the third is rejected");

        let _ = first_release.send(());
        let _ = second_release.send(());
        let _ = third_release.send(());
        let outcomes = tokio::join!(first_task, second_task, third_task);
        let outcomes = [
            outcomes.0.expect("first stream task"),
            outcomes.1.expect("second stream task"),
            outcomes.2.expect("third stream task"),
        ];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, StreamOutcome::Spilled(_)))
                .count(),
            2
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, StreamOutcome::Failed(_)))
                .count(),
            1
        );
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
    }

    #[test]
    fn orphan_retry_backoff_is_exponential_and_capped() {
        assert_eq!(orphan_retry_delay(1), Duration::from_secs(1));
        assert_eq!(orphan_retry_delay(2), Duration::from_secs(2));
        assert_eq!(orphan_retry_delay(20), Duration::from_secs(5 * 60));
    }

    #[tokio::test]
    async fn failed_deletion_stays_debt_until_a_demand_retry_settles_it() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(root.path().to_path_buf(), 10));
        let undeletable = root.path().join("undeletable.part");
        std::fs::create_dir(&undeletable).expect("directory makes remove_file fail");

        manager.reserve(8).await.expect("reserve");
        manager
            .finish(
                8,
                Some(OrphanGroup {
                    paths: vec![undeletable.clone()],
                    bytes: 8,
                    failed_attempts: 1,
                    next_retry_at: Instant::now(),
                }),
            )
            .await;
        manager.retry_orphans().await;
        assert!(manager.reserve(3).await.is_err());
        std::fs::remove_dir(&undeletable).expect("remove test blocker");
        manager.make_orphans_due().await;
        manager.retry_orphans().await;
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
        manager.reserve(10).await.expect("debt released");
    }

    #[tokio::test]
    async fn partial_cleanup_charges_only_the_paths_that_remain() {
        let root = tempfile::tempdir().expect("temp refs");
        let removed = root.path().join("removed.part");
        let blocked = root.path().join("blocked.meta.json.part");
        std::fs::write(&removed, vec![1_u8; 100]).expect("removable body");
        std::fs::create_dir(&blocked).expect("directory makes remove_file fail");
        let blocked_bytes = std::fs::metadata(&blocked).expect("blocked metadata").len();

        let (remaining, debt_bytes) =
            remove_paths(vec![removed.clone(), blocked.clone()], 100).await;

        assert_eq!(remaining, vec![blocked]);
        assert_eq!(debt_bytes, blocked_bytes);
        assert!(!removed.exists());
    }

    #[test]
    fn hard_link_aliases_are_charged_as_one_file_identity() {
        let root = tempfile::tempdir().expect("temp refs");
        let body_part = root.path().join(format!("{}.part", "7".repeat(32)));
        let body = root.path().join("7".repeat(32));
        std::fs::write(&body_part, vec![1_u8; 100]).expect("body part");
        std::fs::hard_link(&body_part, &body).expect("body hard link");

        assert_eq!(
            measure_remaining_debt(&[body_part, body]),
            Some(100),
            "two names for one allocation must consume one budget share"
        );
    }

    #[test]
    fn committed_pair_aliases_remain_retryable_without_extra_debt() {
        let root = tempfile::tempdir().expect("temp refs");
        let id = "8".repeat(32);
        let body_part = root.path().join(format!("{id}.part"));
        let body = root.path().join(&id);
        let meta_part = root.path().join(format!("{id}.meta.json.part"));
        let meta = root.path().join(format!("{id}.meta.json"));
        std::fs::write(&body_part, vec![1_u8; 100]).expect("body part");
        std::fs::hard_link(&body_part, &body).expect("body hard link");
        std::fs::write(&meta_part, b"{}").expect("meta part");
        std::fs::hard_link(&meta_part, &meta).expect("meta hard link");

        assert_eq!(
            measure_remaining_debt(&[body_part, meta_part]),
            Some(0),
            "aliases of a complete TTL-owned pair add no file content"
        );

        std::fs::remove_file(&body).expect("remove final body");
        std::fs::remove_file(&meta).expect("remove final meta");
        assert_eq!(
            measure_remaining_debt(&[
                root.path().join(format!("{id}.part")),
                root.path().join(format!("{id}.meta.json.part")),
            ]),
            Some(102),
            "once the committed pair is gone, the aliases retain the allocations"
        );
    }

    #[tokio::test]
    async fn startup_recovery_only_removes_protocol_orphans() {
        let root = tempfile::tempdir().expect("temp refs");
        let complete = "1".repeat(32);
        std::fs::write(root.path().join(&complete), b"body").expect("complete body");
        std::fs::write(root.path().join(format!("{complete}.meta.json")), b"{}")
            .expect("complete meta");
        let orphan = "2".repeat(32);
        let body_part = format!("{}.part", "3".repeat(32));
        let meta_part = format!("{}.meta.json.part", "4".repeat(32));
        for name in [&orphan, &body_part, &meta_part, "unrelated-file"] {
            std::fs::write(root.path().join(name), b"x").expect("fixture");
        }
        let manager = ProxySpillManager::with_limit(root.path().to_path_buf(), 100);

        assert_eq!(manager.recover_startup_orphans().await.expect("recover"), 3);
        assert!(root.path().join(&complete).exists());
        assert!(root.path().join(format!("{complete}.meta.json")).exists());
        assert!(root.path().join("unrelated-file").exists());
        assert!(!root.path().join(orphan).exists());
        assert!(!root.path().join(body_part).exists());
        assert!(!root.path().join(meta_part).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn incomplete_startup_inventory_fails_closed_until_rescan_succeeds() {
        let root = tempfile::tempdir().expect("temp refs");
        let dangling = root.path().join(format!("{}.part", "5".repeat(32)));
        std::os::unix::fs::symlink(root.path().join("missing-target"), &dangling)
            .expect("dangling protocol path");

        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            100,
        ));
        assert!(manager.recover_startup_orphans().await.is_err());
        assert!(init_spill(&manager).await.is_err());

        std::fs::remove_file(&dangling).expect("remove scan blocker");
        manager
            .recover_startup_orphans()
            .await
            .expect("explicit startup retry");
        let spill = init_spill(&manager).await.expect("rescan then admit");
        let _ = fail_spill(&manager, spill, "test cleanup".to_string()).await;
    }

    #[tokio::test]
    async fn persistent_startup_orphan_is_counted_again_after_restart() {
        let root = tempfile::tempdir().expect("temp refs");
        let undeletable = root.path().join(format!("{}.part", "6".repeat(32)));
        std::fs::create_dir(&undeletable).expect("directory makes remove_file fail");

        for _ in 0..2 {
            let manager = ProxySpillManager::with_limit(root.path().to_path_buf(), 1);
            manager
                .recover_startup_orphans()
                .await
                .expect("complete inventory with known orphan");
            let (_, debt, groups) = manager.budget_snapshot().await;
            assert!(debt > 0);
            assert_eq!(groups, 1);
            assert!(manager.reserve(1).await.is_err());
        }
    }

    #[tokio::test]
    async fn claim_retries_every_existing_protocol_target_without_overwrite() {
        for suffix in ["", ".part", ".meta.json", ".meta.json.part"] {
            let root = tempfile::tempdir().expect("temp refs");
            let manager = Arc::new(ProxySpillManager::with_limit(
                root.path().to_path_buf(),
                1024,
            ));
            manager
                .recover_startup_orphans()
                .await
                .expect("startup inventory");
            let collision = "a".repeat(32);
            let committed = "b".repeat(32);
            let collision_path = root.path().join(format!("{collision}{suffix}"));
            std::fs::write(&collision_path, b"existing").expect("collision fixture");
            let mut ids = vec![collision, committed.clone()].into_iter();

            let spill = init_spill_with(&manager, || ids.next().expect("candidate"))
                .await
                .expect("retry candidate");

            assert_eq!(spill.id, committed);
            assert_eq!(
                std::fs::read(&collision_path).expect("old bytes"),
                b"existing"
            );
            let _ = fail_spill(&manager, spill, "test cleanup".to_string()).await;
        }
    }

    #[tokio::test]
    async fn concurrent_writers_with_the_same_first_id_keep_body_meta_paired() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let collision = "c".repeat(32);
        let first_retry = "d".repeat(32);
        let second_retry = "e".repeat(32);
        let mut first_ids = vec![collision.clone(), first_retry].into_iter();
        let mut second_ids = vec![collision, second_retry].into_iter();

        let (first, second) = tokio::join!(
            init_spill_with(&manager, || first_ids.next().expect("first candidate")),
            init_spill_with(&manager, || second_ids.next().expect("second candidate"))
        );
        let mut first = first.expect("first claim");
        let mut second = second.expect("second claim");
        assert_ne!(first.id, second.id);

        write_reserved(&manager, &mut first, b"first-body")
            .await
            .expect("first write");
        write_reserved(&manager, &mut second, b"second-body")
            .await
            .expect("second write");
        let first_id = first.id.clone();
        let second_id = second.id.clone();
        let (first_outcome, second_outcome) = tokio::join!(
            finish_spill(
                &manager,
                first,
                "text/plain",
                "http://127.0.0.1:1/api/test",
                10,
                b"first-body"
            ),
            finish_spill(
                &manager,
                second,
                "text/plain",
                "http://127.0.0.1:1/api/test",
                11,
                b"second-body"
            )
        );
        assert!(matches!(first_outcome, StreamOutcome::Spilled(_)));
        assert!(matches!(second_outcome, StreamOutcome::Spilled(_)));
        assert_eq!(
            std::fs::read(root.path().join(first_id)).expect("first body"),
            b"first-body"
        );
        assert_eq!(
            std::fs::read(root.path().join(second_id)).expect("second body"),
            b"second-body"
        );
    }

    #[test]
    fn target_policies_bound_loopback_and_external_responses() {
        let loopback = ResponsePolicy::for_target(true);
        assert_eq!(loopback.max_bytes, LOOPBACK_RESPONSE_MAX_BYTES);
        assert!(loopback.allow_spill);
        let external = ResponsePolicy::for_target(false);
        assert_eq!(external.max_bytes, EXTERNAL_RESPONSE_MAX_BYTES);
        assert!(!external.allow_spill);
        assert!(external
            .check_content_length(Some(EXTERNAL_RESPONSE_MAX_BYTES + 1))
            .is_err());
    }

    #[tokio::test]
    async fn loopback_spill_commits_a_32_hex_body_meta_pair() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let body = vec![7_u8; 32];
        let (response, url) = response_with_body(body.clone(), Some(body.len() as u64)).await;
        let policy = ResponsePolicy {
            max_bytes: 64,
            spill_threshold_bytes: 16,
            allow_spill: true,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            true,
            manager.clone(),
        )
        .await;
        let StreamOutcome::Spilled(spilled) = outcome else {
            panic!("response should spill");
        };
        let id = spilled.ref_url.rsplit('/').next().expect("ref id");
        assert!(id.len() == 32 && is_ref_id(id));
        assert_eq!(std::fs::read(root.path().join(id)).expect("body"), body);
        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join(format!("{id}.meta.json"))).expect("metadata"),
        )
        .expect("metadata json");
        assert_eq!(metadata["id"], id);
        assert_eq!(metadata["sizeBytes"], 32);
        assert!(!root.path().join(format!("{id}.part")).exists());
        assert!(!root.path().join(format!("{id}.meta.json.part")).exists());
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
    }

    #[tokio::test]
    async fn external_response_stays_bounded_in_memory_and_never_creates_a_ref() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let body = vec![8_u8; 32];
        let (response, url) = response_with_body(body.clone(), None).await;
        let policy = ResponsePolicy {
            max_bytes: 64,
            spill_threshold_bytes: 16,
            allow_spill: false,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            false,
            manager,
        )
        .await;

        let StreamOutcome::Buffered(buffered) = outcome else {
            panic!("external response must remain buffered");
        };
        assert_eq!(buffered, body);
        assert!(std::fs::read_dir(root.path())
            .expect("refs dir")
            .next()
            .is_none());
    }

    #[tokio::test]
    async fn actual_stream_size_is_capped_when_content_length_is_absent() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let (response, url) = response_with_body(vec![9_u8; 17], None).await;
        let policy = ResponsePolicy {
            max_bytes: 16,
            spill_threshold_bytes: 8,
            allow_spill: true,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            false,
            manager.clone(),
        )
        .await;

        assert!(matches!(outcome, StreamOutcome::Failed(_)));
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
        assert!(std::fs::read_dir(root.path())
            .expect("refs dir")
            .next()
            .is_none());
    }

    #[tokio::test]
    async fn misleading_length_and_unterminated_chunking_cannot_bypass_actual_size_cap() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let (response, url, ready, release) = held_chunked_response(vec![9_u8; 17], Some(1)).await;
        let policy = ResponsePolicy {
            max_bytes: 16,
            spill_threshold_bytes: 8,
            allow_spill: true,
        };
        let _ = ready.await;

        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            stream_response_body(
                response,
                "application/octet-stream",
                &url,
                policy,
                false,
                Arc::clone(&manager),
            ),
        )
        .await
        .expect("size breach must cancel without waiting for stream termination");
        let _ = release.send(());

        assert!(matches!(outcome, StreamOutcome::Failed(_)));
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
    }

    #[tokio::test]
    async fn interrupted_live_spill_releases_its_reservation_and_temp_files() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        manager
            .recover_startup_orphans()
            .await
            .expect("startup inventory");
        let (response, url) = interrupted_chunked_response(vec![4_u8; 12]).await;
        let policy = ResponsePolicy {
            max_bytes: 16,
            spill_threshold_bytes: 8,
            allow_spill: true,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            false,
            Arc::clone(&manager),
        )
        .await;

        assert!(matches!(outcome, StreamOutcome::Failed(_)));
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
        assert!(std::fs::read_dir(root.path())
            .expect("refs dir")
            .next()
            .is_none());
    }

    #[test]
    fn origin_uses_the_loopback_request_authority() {
        assert_eq!(
            origin_of("http://127.0.0.1:31415/api/test?x=1"),
            Some("http://127.0.0.1:31415".to_string())
        );
        assert_eq!(
            origin_of("http://[::1]:31415/api/test"),
            Some("http://[::1]:31415".to_string())
        );
    }
}
