// SSE Proxy module - Connects to sidecar SSE and forwards events via Tauri
// This bypasses WebView CORS restrictions entirely
// Supports multiple renderer-surface subscriptions (Chat Tabs and Companion)

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::proxy_spill::{stream_response_body, ProxySpillManager, ResponsePolicy, StreamOutcome};
use crate::sidecar::{FrontendSidecarBinding, ManagedSidecarManager, SidecarOwner};
use crate::{ulog_debug, ulog_info, ulog_warn};

/// Monotonically increasing connection id used to distinguish a "stale" task
/// (one whose entry has already been replaced by a newer connection) from
/// the live one. Pattern 1, audit A: SSE proxy task exits without clearing
/// `running=true` → tab permanently muted on reconnect because new
/// `start_sse_proxy` saw `running == true` and returned Ok early.
static SSE_SUBSCRIPTION_GENERATION: AtomicU64 = AtomicU64::new(1);
static SSE_TRANSPORT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_subscription_generation() -> u64 {
    SSE_SUBSCRIPTION_GENERATION.fetch_add(1, Ordering::Relaxed)
}

fn next_transport_generation() -> u64 {
    SSE_TRANSPORT_GENERATION.fetch_add(1, Ordering::Relaxed)
}

// Timeout constants (in seconds)
//
// SSE_READ_TIMEOUT: Idle timeout for SSE connections
// - Backend sends heartbeat every 15s
// - 60s gives 4x margin to handle network jitter
// - If no data received for 60s, connection is considered dead
//
// HTTP_PROXY_TIMEOUT: Total timeout for HTTP proxy requests
// - 120s (2 minutes) allows for slow API responses
// - Covers model generation time for complex requests
//
// HTTP_PROXY_LONG_TIMEOUT: For endpoints that legitimately need longer
// - Skill install-from-url downloads GitHub tarballs over slow/proxied networks
//   (sidecar `FETCH_TIMEOUT_MS` is 300s; we add a 60s buffer so the inner
//   timeout wins). Keep this list small — bumping the default is worse than
//   carving out specific known-long paths.
//
// TODO v0.2.0: Make these configurable via Settings
const SSE_READ_TIMEOUT_SECS: u64 = 60;
const SSE_RETRY_BASE_DELAY_MS: u64 = 250;
const SSE_RETRY_MAX_DELAY_MS: u64 = 5_000;
/// A legal SSE stream may run indefinitely, but one event must remain bounded.
/// Normal tool/result payloads spill to `/refs` far below this threshold, so
/// this is a protocol boundary rather than a product payload limit.
const SSE_EVENT_MAX_BYTES: usize = 8 * 1024 * 1024;
const SSE_EVENT_SEPARATOR_MAX_BYTES: usize = 4;
const HTTP_PROXY_TIMEOUT_SECS: u64 = 120;
const HTTP_PROXY_LONG_TIMEOUT_SECS: u64 = 360;
const CONTROL_DISPATCH_RETRY_DELAYS_MS: &[u64] = &[
    50, 100, 200, 400, 800, 1_500, 2_000, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000,
];

// Renderer API traffic is high-frequency. Rebuilding reqwest::Client for every
// loopback request discards its connection pool and can exhaust Windows'
// dynamic TCP ports during long-running desktop sessions.
static LOOPBACK_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn loopback_http_client() -> Result<reqwest::Client, String> {
    if let Some(client) = LOOPBACK_HTTP_CLIENT.get() {
        return Ok(client.clone());
    }

    let client = crate::local_http::builder()
        .tcp_nodelay(true)
        .http1_only()
        .pool_idle_timeout(std::time::Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .build()
        .map_err(|error| format!("[proxy] Failed to create loopback client: {}", error))?;
    let _ = LOOPBACK_HTTP_CLIENT.set(client);
    Ok(LOOPBACK_HTTP_CLIENT
        .get()
        .expect("loopback HTTP client must be initialized")
        .clone())
}

/// Endpoints that need the long-timeout budget. Keep this list short — most
/// sidecar work should finish in seconds, not minutes.
fn proxy_timeout_for(url_path: &str) -> u64 {
    if url_path.ends_with("/api/skill/install-from-url") {
        HTTP_PROXY_LONG_TIMEOUT_SECS
    } else {
        HTTP_PROXY_TIMEOUT_SECS
    }
}

/// One long-lived SSE subscription for a renderer surface.
struct SseConnection {
    /// Generation id assigned at spawn time; spawned task captures this and
    /// only clears its entry on exit if the entry's generation still matches.
    generation: u64,
    session_id_hint: String,
    owner: SidecarOwner,
    /// Shared running flag - used to gracefully stop the SSE stream
    running: Arc<AtomicBool>,
    /// Task handle for aborting if graceful stop fails
    abort_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl SseConnection {
    fn new(generation: u64, session_id_hint: String, owner: SidecarOwner) -> Self {
        Self {
            generation,
            session_id_hint,
            owner,
            running: Arc::new(AtomicBool::new(false)),
            abort_handle: None,
        }
    }

    fn matches_target(&self, session_id_hint: &str, owner: &SidecarOwner) -> bool {
        self.session_id_hint == session_id_hint && &self.owner == owner
    }

    /// Treat a connection whose task has finished (handle finished, or
    /// running flag already cleared) as not-running. New `start_sse_proxy`
    /// calls must proceed for these so a crashed task can be replaced.
    fn is_alive(&self) -> bool {
        if !self.running.load(Ordering::SeqCst) {
            return false;
        }
        match &self.abort_handle {
            Some(h) => !h.inner().is_finished(),
            None => false,
        }
    }

    fn stop(&mut self) {
        // Signal graceful stop first
        self.running.store(false, Ordering::SeqCst);
        // Then abort the task as backup
        if let Some(handle) = self.abort_handle.take() {
            handle.abort();
        }
    }
}

/// State for managing renderer-surface SSE subscriptions.
pub struct SseProxyState {
    /// Stable renderer connection key -> SSE subscription.
    connections: Mutex<HashMap<String, SseConnection>>,
}

impl Default for SseProxyState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

fn frontend_sidecar_owner(owner_type: &str, owner_id: String) -> Result<SidecarOwner, String> {
    if owner_id.is_empty() {
        return Err("SSE sidecar owner id must not be empty".to_string());
    }
    match owner_type {
        "tab" => Ok(SidecarOwner::Tab(owner_id)),
        "companion" => Ok(SidecarOwner::Companion(owner_id)),
        _ => Err(format!(
            "Unsupported SSE sidecar owner type: {}",
            owner_type
        )),
    }
}

/// Start a long-lived SSE subscription for a renderer surface.
#[tauri::command]
pub async fn start_sse_proxy(
    app: AppHandle,
    state: tauri::State<'_, Arc<SseProxyState>>,
    sidecar_manager: tauri::State<'_, ManagedSidecarManager>,
    connection_key: String,
    session_id_hint: String,
    sidecar_owner_type: String,
    sidecar_owner_id: String,
) -> Result<(), String> {
    if connection_key.is_empty() {
        return Err("SSE connection key must not be empty".to_string());
    }
    if session_id_hint.is_empty() {
        return Err("SSE session id hint must not be empty".to_string());
    }
    let owner = frontend_sidecar_owner(&sidecar_owner_type, sidecar_owner_id)?;

    let mut connections = state.connections.lock().await;

    // Check if this exact subscription is already running. Pattern 1, audit A: only
    // short-circuit when the previous task is *actually* alive — a finished
    // JoinHandle / cleared running flag means the prior task crashed without
    // cleanup, and we must replace it (otherwise the tab stays muted forever).
    if let Some(conn) = connections.get(&connection_key) {
        if conn.is_alive() && conn.matches_target(&session_id_hint, &owner) {
            ulog_debug!(
                "[sse-proxy] Subscription {} already active for hint {} and owner {:?}",
                connection_key,
                session_id_hint,
                owner
            );
            return Ok(());
        }
        ulog_debug!(
            "[sse-proxy] Replacing subscription {} (old_gen={}, old_hint={}, old_owner={:?})",
            connection_key,
            conn.generation,
            conn.session_id_hint,
            conn.owner
        );
    }

    // Stop existing connection if any (covers the "still alive but being
    // replaced" path; the is_alive() short-circuit above already returned
    // for the truly-running case).
    //
    // Pattern 1 fix #7C — TOCTOU note (load-bearing intentional design):
    // A's task may be cleaning up its entry concurrently. There are two
    // outcomes:
    //   (1) A's cleanup ran first and we observe `None` here → fine, we
    //       allocate a fresh generation below and insert.
    //   (2) A's cleanup hasn't run yet and we observe `Some(conn)` → we
    //       call conn.stop() and then insert OUR fresh generation. When A's
    //       cleanup eventually fires, its generation-match guard (in the
    //       spawned task's `match connections.get_mut(...)` block) won't
    //       match our newly-inserted entry → A becomes a no-op cleanup.
    // Both branches resolve correctly because A's cleanup is gated on
    // generation match. Keep this comment in place — removing it makes the
    // race look like a bug.
    if let Some(mut conn) = connections.remove(&connection_key) {
        conn.stop();
    }

    // Allocate this connection's generation and create the entry.
    let my_gen = next_subscription_generation();
    let mut conn = SseConnection::new(my_gen, session_id_hint.clone(), owner.clone());
    conn.running.store(true, Ordering::SeqCst);

    let app_handle = app.clone();
    let connection_key_clone = connection_key.clone();
    // Share the same running flag with the spawned task
    let running = conn.running.clone();
    let state_for_task = (*state).clone();
    let manager_for_task = sidecar_manager.inner().clone();
    let session_id_hint_for_task = session_id_hint.clone();
    let owner_for_task = owner.clone();

    // Spawn one task for the whole subscription lifetime. Individual HTTP
    // streams are attempts inside this supervisor, not connection owners.
    let handle = tauri::async_runtime::spawn(async move {
        run_sse_supervisor(
            &app_handle,
            &manager_for_task,
            &state_for_task,
            &running,
            &connection_key_clone,
            my_gen,
            &session_id_hint_for_task,
            &owner_for_task,
        )
        .await;

        // Pattern 1: on task exit, clear the running flag and remove the
        // entry — but only if the entry still belongs to *this* generation
        // (a newer start_sse_proxy may have already replaced us). Without
        // this, audit A would still bite: stale `running=true` → next
        // connect short-circuits and the tab is muted.
        let mut connections = state_for_task.connections.lock().await;
        match connections.get_mut(&connection_key_clone) {
            Some(entry) if entry.generation == my_gen => {
                entry.running.store(false, Ordering::SeqCst);
                entry.abort_handle = None;
                connections.remove(&connection_key_clone);
                ulog_debug!(
                    "[sse-proxy] Subscription {} cleaned own entry (gen={})",
                    connection_key_clone,
                    my_gen
                );
            }
            Some(entry) => {
                ulog_debug!(
                    "[sse-proxy] Subscription {} task exit (gen={}) superseded by gen={}; not clearing",
                    connection_key_clone,
                    my_gen,
                    entry.generation
                );
            }
            None => { /* already removed elsewhere */ }
        }
    });

    conn.abort_handle = Some(handle);
    connections.insert(connection_key.clone(), conn);

    ulog_info!(
        "[sse-proxy] Installed subscription {} (gen={}, hint={}, owner={:?})",
        connection_key,
        my_gen,
        session_id_hint,
        owner
    );

    Ok(())
}

/// Stop one renderer subscription. This is the only operation that ends the
/// supervisor's retry lifetime; transient transport failures never remove it.
#[tauri::command]
pub async fn stop_sse_proxy(
    state: tauri::State<'_, Arc<SseProxyState>>,
    connection_key: String,
) -> Result<(), String> {
    let mut connections = state.connections.lock().await;

    if let Some(mut conn) = connections.remove(&connection_key) {
        conn.stop();
        ulog_info!("[sse-proxy] Stopped subscription {}", connection_key);
    }

    Ok(())
}

/// Stop all SSE connections (for app cleanup)
#[tauri::command]
pub async fn stop_all_sse_proxies(
    state: tauri::State<'_, Arc<SseProxyState>>,
) -> Result<(), String> {
    let mut connections = state.connections.lock().await;

    for (connection_key, mut conn) in connections.drain() {
        conn.stop();
        ulog_info!("[sse-proxy] Stopped subscription {}", connection_key);
    }

    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TauriSseEnvelope {
    transport_generation: u64,
    data: String,
}

enum SseAttemptOutcome {
    Stopped,
    Disconnected {
        made_progress: bool,
        transport_generation: Option<u64>,
        reason: String,
    },
    ProtocolBudgetBreach {
        transport_generation: u64,
        observed_event_bytes: usize,
        limit_bytes: usize,
    },
}

fn retry_delay_ms(consecutive_failures: u32) -> u64 {
    let exponent = consecutive_failures.saturating_sub(1).min(20);
    SSE_RETRY_BASE_DELAY_MS
        .saturating_mul(1_u64 << exponent)
        .min(SSE_RETRY_MAX_DELAY_MS)
}

fn next_retry_failure_count(previous: u32, made_progress: bool) -> u32 {
    if made_progress {
        1
    } else {
        previous.saturating_add(1)
    }
}

fn next_retry_failure_count_for_outcome(previous: u32, outcome: &SseAttemptOutcome) -> u32 {
    match outcome {
        SseAttemptOutcome::Disconnected { made_progress, .. } => {
            next_retry_failure_count(previous, *made_progress)
        }
        // Receiving bytes is not progress when the peer never produces a
        // protocol-valid bounded event. Otherwise the same broken Sidecar can
        // force a reconnect/allocation loop at the 250 ms base delay.
        SseAttemptOutcome::ProtocolBudgetBreach { .. } => previous.saturating_add(1),
        SseAttemptOutcome::Stopped => previous,
    }
}

async fn run_sse_supervisor<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    state: &SseProxyState,
    running: &AtomicBool,
    connection_key: &str,
    subscription_generation: u64,
    session_id_hint: &str,
    owner: &SidecarOwner,
) {
    let mut consecutive_failures = 0_u32;
    let mut last_binding: Option<FrontendSidecarBinding> = None;

    while running.load(Ordering::SeqCst) {
        // Hold the std::sync::Mutex only for the authoritative lookup. Never
        // carry it into an HTTP await or retry sleep.
        let binding = {
            let mut manager = match sidecar_manager.lock() {
                Ok(manager) => manager,
                Err(poisoned) => poisoned.into_inner(),
            };
            manager.resolve_session_sidecar_for_frontend_owner(session_id_hint, owner)
        };

        let binding = match binding {
            Ok(binding) => binding,
            Err(reason) => {
                consecutive_failures = consecutive_failures.saturating_add(1);
                let delay_ms = retry_delay_ms(consecutive_failures);
                if consecutive_failures == 1 || consecutive_failures % 10 == 0 {
                    ulog_warn!(
                        "[sse-proxy] Subscription {} waiting for Sidecar (attempt={}, retry_delay_ms={}): {}",
                        connection_key,
                        consecutive_failures,
                        delay_ms,
                        reason
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                continue;
            }
        };

        let base_url = binding.base_url();
        if last_binding.as_ref() != Some(&binding) {
            ulog_info!(
                "[sse-proxy] Subscription {} resolved Sidecar endpoint {}",
                connection_key,
                base_url
            );
            last_binding = Some(binding.clone());
        }

        let stream_url = format!("{}/chat/stream", base_url.trim_end_matches('/'));
        let outcome = connect_sse_attempt(
            app,
            sidecar_manager,
            &binding,
            state,
            subscription_generation,
            &stream_url,
            running,
            connection_key,
        )
        .await;
        consecutive_failures = next_retry_failure_count_for_outcome(consecutive_failures, &outcome);
        match outcome {
            SseAttemptOutcome::Stopped => break,
            SseAttemptOutcome::Disconnected {
                transport_generation,
                reason,
                ..
            } => {
                let delay_ms = retry_delay_ms(consecutive_failures);
                if consecutive_failures == 1 || consecutive_failures % 10 == 0 {
                    ulog_warn!(
                        "[sse-proxy] Subscription {} transport disconnected (transport_generation={:?}, attempt={}, retry_delay_ms={}): {}",
                        connection_key,
                        transport_generation,
                        consecutive_failures,
                        delay_ms,
                        reason
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            SseAttemptOutcome::ProtocolBudgetBreach {
                transport_generation,
                observed_event_bytes,
                limit_bytes,
            } => {
                let delay_ms = retry_delay_ms(consecutive_failures);
                // Log only bounded diagnostics, never the offending payload.
                // The same first/every-tenth cadence as other disconnects
                // prevents a broken generation from flooding unified logs.
                if consecutive_failures == 1 || consecutive_failures % 10 == 0 {
                    ulog_warn!(
                        "[sse-proxy] Subscription {} protocol event budget exceeded (transport_generation={}, observed_bytes={}, limit_bytes={}, attempt={}, retry_delay_ms={})",
                        connection_key,
                        transport_generation,
                        observed_event_bytes,
                        limit_bytes,
                        consecutive_failures,
                        delay_ms
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }

    ulog_debug!(
        "[sse-proxy] Subscription {} supervisor stopped",
        connection_key
    );
}

/// Run one HTTP transport attempt and forward events with the subscription
/// prefix. Returning `Disconnected` is normal: the caller owns retry.
fn log_sse_info<R: tauri::Runtime>(app: &AppHandle<R>, message: String) {
    #[cfg(not(test))]
    crate::logger::info(app, message);
    #[cfg(test)]
    let _ = (app, message);
}

fn log_sse_error<R: tauri::Runtime>(app: &AppHandle<R>, message: String) {
    #[cfg(not(test))]
    crate::logger::error(app, message);
    #[cfg(test)]
    let _ = (app, message);
}

/// Emit only while this exact subscription generation is still authoritative.
/// The connections lock is intentionally held through the synchronous Tauri
/// emit and terminal-claim enqueue: once stop/replacement returns, an older
/// supervisor can no longer publish into listeners installed for the same key.
async fn emit_sse_event_if_current<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    sidecar_binding: &FrontendSidecarBinding,
    state: &SseProxyState,
    connection_key: &str,
    subscription_generation: u64,
    transport_generation: u64,
    event_name: String,
    data: String,
) -> bool {
    let connections = state.connections.lock().await;
    let is_current = connections.get(connection_key).is_some_and(|entry| {
        entry.generation == subscription_generation && entry.running.load(Ordering::SeqCst)
    });
    if !is_current {
        return false;
    }

    if event_name == "chat:message-complete"
        || event_name == "chat:message-stopped"
        || event_name == "chat:message-error"
    {
        log_sse_info(
            app,
            format!(
                "[sse-proxy] Subscription {} emitting critical event: {}",
                connection_key, event_name
            ),
        );
        if let Some(terminal) = crate::notification::completion_terminal_from_sse_data(&data) {
            let claim = sidecar_manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .claim_frontend_session_completion(
                    sidecar_binding,
                    &terminal.session_id,
                    &terminal.turn_id,
                );
            if let Some(claim) = claim {
                let notification_app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    crate::notification::submit_session_completion(
                        &notification_app,
                        terminal,
                        claim,
                    );
                });
            } else {
                ulog_debug!(
                    "[sse-proxy] Completion ignored after generation fence or duplicate claim: session={} turn={}",
                    terminal.session_id,
                    terminal.turn_id,
                );
            }
        }
    }

    let prefixed_event = format!("sse:{}:{}", connection_key, event_name);
    let envelope = TauriSseEnvelope {
        transport_generation,
        data,
    };
    if let Err(error) = app.emit(&prefixed_event, envelope) {
        log_sse_error(
            app,
            format!(
                "[sse-proxy] Subscription {} failed to emit {}: {}",
                connection_key, prefixed_event, error
            ),
        );
    }
    true
}

async fn connect_sse_attempt<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    sidecar_binding: &FrontendSidecarBinding,
    state: &SseProxyState,
    subscription_generation: u64,
    url: &str,
    running: &AtomicBool,
    connection_key: &str,
) -> SseAttemptOutcome {
    connect_sse_attempt_with_read_timeout(
        app,
        sidecar_manager,
        sidecar_binding,
        state,
        subscription_generation,
        url,
        running,
        connection_key,
        std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS),
        SSE_EVENT_MAX_BYTES,
    )
    .await
}

fn find_event_boundary(buf: &[u8]) -> Option<(usize, usize)> {
    // Returns (position_of_event_end, separator_length). Prefer the earliest
    // boundary so another event is never swallowed into the current one.
    let lf = buf.windows(2).position(|window| window == b"\n\n");
    let crlf = buf.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(lf), Some(crlf)) if lf <= crlf => Some((lf, 2)),
        (Some(_), Some(crlf)) => Some((crlf, 4)),
        (Some(lf), None) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
}

/// Drain at most one complete event while enforcing a budget on the bytes
/// before its delimiter. At exactly the limit, the delimiter may arrive in a
/// later network chunk without turning a legal frame into a false breach.
fn take_next_sse_event(
    buffer: &mut Vec<u8>,
    max_event_bytes: usize,
) -> Result<Option<String>, usize> {
    if let Some((position, separator_len)) = find_event_boundary(buffer) {
        if position > max_event_bytes {
            return Err(position);
        }
        let event = String::from_utf8_lossy(&buffer[..position]).to_string();
        buffer.drain(..position + separator_len);
        return Ok(Some(event));
    }

    if buffer.len() > max_event_bytes {
        return Err(buffer.len());
    }
    Ok(None)
}

async fn connect_sse_attempt_with_read_timeout<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    sidecar_binding: &FrontendSidecarBinding,
    state: &SseProxyState,
    subscription_generation: u64,
    url: &str,
    running: &AtomicBool,
    connection_key: &str,
    read_timeout: std::time::Duration,
    max_event_bytes: usize,
) -> SseAttemptOutcome {
    use futures_util::StreamExt;

    log_sse_info(
        app,
        format!(
            "[sse-proxy] Subscription {} opening transport",
            connection_key
        ),
    );

    // Build client with read_timeout (idle timeout) for SSE long connections
    // IMPORTANT: Do NOT use timeout() which is total request time - SSE connections are meant to be long-lived
    // Use read_timeout instead: if no data received within this time, connection is considered dead
    // Backend sends heartbeat every 15s, so 60s read_timeout gives 4x margin
    // CRITICAL: Enable tcp_nodelay to disable Nagle's algorithm for immediate packet transmission
    // Without this, small SSE events may be buffered and delayed, causing UI to feel unresponsive
    // Force HTTP/1.1 for compatibility with Bun server (HTTP/2 may cause connection issues on Windows)
    // Use short-lived connection pool to balance performance and stability
    let client = match crate::local_http::builder()
        .read_timeout(read_timeout)
        .tcp_nodelay(true)
        .http1_only() // Force HTTP/1.1 for SSE compatibility
        .pool_idle_timeout(std::time::Duration::from_secs(5))
        .pool_max_idle_per_host(2)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return SseAttemptOutcome::Disconnected {
                made_progress: false,
                transport_generation: None,
                reason: format!("failed to create local HTTP client: {}", error),
            };
        }
    };

    let response = match client
        .get(url)
        .header("Accept", "text/event-stream")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return SseAttemptOutcome::Disconnected {
                made_progress: false,
                transport_generation: None,
                reason: format!("connect failed: {}", error),
            };
        }
    };

    if !response.status().is_success() {
        return SseAttemptOutcome::Disconnected {
            made_progress: false,
            transport_generation: None,
            reason: format!("HTTP status {}", response.status()),
        };
    }

    let transport_generation = next_transport_generation();
    log_sse_info(
        app,
        format!(
            "[sse-proxy] Subscription {} transport connected (transport_generation={})",
            connection_key, transport_generation
        ),
    );

    let mut stream = response.bytes_stream();
    // Pattern 1 fix #7A: byte-level buffer + CRLF-aware split.
    //
    // The legacy String-based path called `String::from_utf8_lossy(&chunk)`
    // per chunk, which corrupts multi-byte UTF-8 sequences split across
    // chunk boundaries (replaced with U+FFFD). Worse, `find("\n\n")` only
    // matched LF-LF, missing CRLF event boundaries that some upstreams emit;
    // and `buffer = buffer[pos+2..].to_string()` was O(n) per drain.
    //
    // Fix: hold raw bytes in a `Vec<u8>`, search for either b"\n\n" or
    // b"\r\n\r\n" (whichever is closer to the head), `drain(..)` for O(1)
    // amortised consumption, and decode UTF-8 only on the complete event
    // slice — so partial multi-byte sequences at chunk tails stay buffered
    // until their final byte arrives.
    let mut buffer: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk_count: u64 = 0;

    while running.load(Ordering::SeqCst) {
        match stream.next().await {
            Some(Ok(chunk)) => {
                chunk_count += 1;
                let mut chunk_offset = 0;
                while chunk_offset < chunk.len() {
                    // Never copy an arbitrarily large network chunk into the
                    // parser buffer. Four bytes beyond the event budget are
                    // sufficient to recognize either legal SSE delimiter.
                    let buffer_limit =
                        max_event_bytes.saturating_add(SSE_EVENT_SEPARATOR_MAX_BYTES);
                    let available = buffer_limit.saturating_sub(buffer.len());
                    if available == 0 {
                        return SseAttemptOutcome::ProtocolBudgetBreach {
                            transport_generation,
                            observed_event_bytes: buffer.len(),
                            limit_bytes: max_event_bytes,
                        };
                    }
                    let append_len = available.min(chunk.len() - chunk_offset);
                    buffer.extend_from_slice(&chunk[chunk_offset..chunk_offset + append_len]);
                    chunk_offset += append_len;

                    // Process complete SSE events (end with \n\n or \r\n\r\n)
                    loop {
                        let event_str = match take_next_sse_event(&mut buffer, max_event_bytes) {
                            Ok(Some(event)) => event,
                            Ok(None) => break,
                            Err(observed_event_bytes) => {
                                return SseAttemptOutcome::ProtocolBudgetBreach {
                                    transport_generation,
                                    observed_event_bytes,
                                    limit_bytes: max_event_bytes,
                                };
                            }
                        };

                        // Fast local cancellation check before the authoritative
                        // generation fence below.
                        if !running.load(Ordering::SeqCst) {
                            return SseAttemptOutcome::Stopped;
                        }

                        // Parse and emit with the renderer-surface prefix.
                        if let Some((event_name, data)) = parse_sse_event(&event_str) {
                            if !emit_sse_event_if_current(
                                app,
                                sidecar_manager,
                                sidecar_binding,
                                state,
                                connection_key,
                                subscription_generation,
                                transport_generation,
                                event_name,
                                data,
                            )
                            .await
                            {
                                return SseAttemptOutcome::Stopped;
                            }
                        }
                    }
                }
            }
            Some(Err(e)) => {
                return SseAttemptOutcome::Disconnected {
                    made_progress: chunk_count > 0,
                    transport_generation: Some(transport_generation),
                    reason: format!("stream error after {} chunks: {}", chunk_count, e),
                };
            }
            None => {
                return SseAttemptOutcome::Disconnected {
                    made_progress: chunk_count > 0,
                    transport_generation: Some(transport_generation),
                    reason: format!("stream ended after {} chunks", chunk_count),
                };
            }
        }
    }

    SseAttemptOutcome::Stopped
}

/// Parse SSE event format
/// Per SSE spec, the format is:
/// - "event: name\n" (event type)
/// - "data: value\n" (data, can have multiple lines)
/// - "\n" (empty line ends the event)
/// IMPORTANT: Per spec, only ONE space after the colon should be skipped (if present)
fn parse_sse_event(event_str: &str) -> Option<(String, String)> {
    let mut event_name = String::from("message");
    let mut data_lines = Vec::new();

    for line in event_str.lines() {
        if line.starts_with("event:") {
            // Event name can be trimmed
            event_name = line[6..].trim().to_string();
        } else if line.starts_with("data:") {
            // Per SSE spec: skip exactly one space after "data:" if present
            let content = &line[5..];
            let data_value = content.strip_prefix(' ').unwrap_or(content);
            data_lines.push(data_value.to_string());
        }
    }

    if data_lines.is_empty() {
        None
    } else {
        Some((event_name, data_lines.join("\n")))
    }
}

/// Generic HTTP request proxy - bypasses WebView CORS entirely
#[derive(serde::Deserialize)]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub body: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarHttpRequest {
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

impl SidecarHttpRequest {
    fn resolve(
        self,
        dispatch: &crate::sidecar::manager::SidecarHttpDispatch,
    ) -> Result<HttpRequest, String> {
        Ok(HttpRequest {
            url: dispatch.url_for_path(&self.path)?,
            method: self.method,
            body: self.body,
            headers: self.headers,
        })
    }
}

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: std::collections::HashMap<String, String>,
    /// True if body is base64 encoded (for binary responses)
    pub is_base64: bool,
    /// When set, the loopback response body was spilled to the shared ref store
    /// and the renderer should fetch it from this URL instead of decoding
    /// `body`. `body` is empty in that case; `is_base64` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_url: Option<String>,
    /// MIME type when `ref_url` is set (saves the renderer a header lookup
    /// before fetching).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_mimetype: Option<String>,
    /// Total byte size when `ref_url` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_size_bytes: Option<u64>,
}

/// Check if content type indicates binary data
fn is_binary_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("application/octet-stream")
        || ct.starts_with("application/pdf")
}

async fn acquire_session_dispatch_with_wait(
    manager: &ManagedSidecarManager,
    session_id_hint: &str,
    owner: &SidecarOwner,
) -> Result<crate::sidecar::manager::SidecarHttpDispatch, String> {
    let total_attempts = CONTROL_DISPATCH_RETRY_DELAYS_MS.len() + 1;
    for (attempt, delay_ms) in std::iter::once(&0)
        .chain(CONTROL_DISPATCH_RETRY_DELAYS_MS.iter())
        .enumerate()
    {
        if *delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
        }
        let result = manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .acquire_frontend_session_dispatch(session_id_hint, owner);
        match result {
            Ok(dispatch) => return Ok(dispatch),
            Err(error) if attempt + 1 == total_attempts => {
                return Err(format!(
                    "Session Sidecar was not ready for owner {:?}: {}",
                    owner, error
                ));
            }
            Err(_) => {}
        }
    }
    unreachable!("dispatch retry iterator always contains its final attempt")
}

async fn acquire_global_dispatch_with_wait(
    manager: &ManagedSidecarManager,
) -> Result<crate::sidecar::manager::SidecarHttpDispatch, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut delay_index = 0_usize;
    loop {
        let result = manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .acquire_global_dispatch();
        let last_error = match result {
            Ok(dispatch) => return Ok(dispatch),
            Err(error) => error,
        };
        if std::time::Instant::now() >= deadline {
            return Err(format!("Global Sidecar was not ready: {last_error}"));
        }
        let delay_ms = CONTROL_DISPATCH_RETRY_DELAYS_MS
            [delay_index.min(CONTROL_DISPATCH_RETRY_DELAYS_MS.len() - 1)];
        delay_index += 1;
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
}

#[tauri::command]
pub async fn session_sidecar_http_request(
    app: AppHandle,
    sidecar_manager: tauri::State<'_, ManagedSidecarManager>,
    spill_manager: tauri::State<'_, Arc<ProxySpillManager>>,
    session_id_hint: String,
    sidecar_owner_type: String,
    sidecar_owner_id: String,
    request: SidecarHttpRequest,
) -> Result<HttpResponse, String> {
    let owner = frontend_sidecar_owner(&sidecar_owner_type, sidecar_owner_id)?;
    let dispatch =
        acquire_session_dispatch_with_wait(sidecar_manager.inner(), &session_id_hint, &owner)
            .await?;
    let request = request.resolve(&dispatch)?;
    execute_http_request(app, spill_manager.inner().clone(), request, true).await
}

#[tauri::command]
pub async fn global_sidecar_http_request(
    app: AppHandle,
    sidecar_manager: tauri::State<'_, ManagedSidecarManager>,
    spill_manager: tauri::State<'_, Arc<ProxySpillManager>>,
    request: SidecarHttpRequest,
) -> Result<HttpResponse, String> {
    let dispatch = acquire_global_dispatch_with_wait(sidecar_manager.inner()).await?;
    let request = request.resolve(&dispatch)?;
    execute_http_request(app, spill_manager.inner().clone(), request, true).await
}

#[tauri::command]
pub async fn proxy_analytics_http_request(
    app: AppHandle,
    spill_manager: tauri::State<'_, Arc<ProxySpillManager>>,
    request: HttpRequest,
) -> Result<HttpResponse, String> {
    if !request.method.eq_ignore_ascii_case("POST") {
        return Err("Analytics proxy only accepts POST requests".to_string());
    }
    execute_http_request(app, spill_manager.inner().clone(), request, false).await
}

async fn execute_http_request(
    app: AppHandle,
    spill_manager: Arc<ProxySpillManager>,
    request: HttpRequest,
    target_is_loopback: bool,
) -> Result<HttpResponse, String> {
    use crate::logger;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    // CRITICAL: Validate URL is absolute before forwarding to reqwest.
    // Relative URLs (e.g., "/api/something") cause reqwest to fail with an opaque
    // "relative URL without a base" builder error. This cascades into:
    //   IPC error → frontend treats as sidecar crash → SSE reconnect → Global Sidecar restart
    //   → full UI re-render (all tabs rebuilt). See: #78
    //
    // This guard catches the issue at the source with a clear error message.
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        // Truncate safely (chars, not bytes) to prevent panic on multi-byte UTF-8
        let display_url: String = request.url.chars().take(200).collect();
        let err = format!(
            "[proxy] Blocked relative URL: '{}'. Expected absolute URL (http://...). \
             This usually means the sidecar port was not resolved before making this request.",
            display_url
        );
        logger::warn(&app, &err);
        return Err(err);
    }

    // Skip logging for high-frequency polling paths (matches Bun-side skip list).
    // Extract path (before '?') from full URL for precise matching.
    let url_path = request.url.split('?').next().unwrap_or(&request.url);
    let is_noisy_path = url_path.ends_with("/api/unified-log")
        || url_path.ends_with("/agent/dir")
        || url_path.ends_with("/sessions");
    let start = std::time::Instant::now();

    // Reuse one loopback client so Sidecar requests share a connection pool.
    // Request-specific timeouts are applied below because skill installation
    // has a longer budget than ordinary API calls.
    let timeout_secs = proxy_timeout_for(url_path);
    // External traffic remains proxy-config aware and is low-frequency.
    let tune = |b: reqwest::ClientBuilder| {
        b.tcp_nodelay(true)
            .http1_only() // Force HTTP/1.1 for SSE compatibility
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .pool_max_idle_per_host(2)
    };
    // Control-plane commands select loopback explicitly and MUST bypass the
    // system proxy. Reuse the loopback client so requests share a connection
    // pool without exposing a generic renderer URL proxy.
    let client = if target_is_loopback {
        loopback_http_client().map_err(|err| {
            logger::error(&app, &err);
            err
        })?
    } else {
        // External host — same proxy-aware path as the updater / LiteLLM cache.
        // The bare builder needs an explicit clippy allow per call site so the
        // localhost no_proxy trap stays banned everywhere else.
        #[allow(clippy::disallowed_methods)]
        let external_builder = tune(reqwest::Client::builder());
        crate::proxy_config::build_client_with_proxy(external_builder)
            .inspect_err(|e| logger::error(&app, e))?
    };

    let mut req_builder = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        _ => {
            let err = format!("[proxy] Unsupported method: {}", request.method);
            logger::error(&app, &err);
            return Err(err);
        }
    };
    req_builder = req_builder.timeout(std::time::Duration::from_secs(timeout_secs));

    // Add headers
    if let Some(headers) = request.headers {
        for (key, value) in headers {
            req_builder = req_builder.header(&key, &value);
        }
    }

    // Add body for POST/PUT/PATCH
    if let Some(ref body) = request.body {
        req_builder = req_builder.header("Content-Type", "application/json");
        req_builder = req_builder.body(body.clone());
    }

    // Send request with detailed error logging.
    //
    // Log severity is classified by error kind because localhost connections
    // come and go with normal Sidecar lifecycle (Tab close → Sidecar killed,
    // BackgroundCompletion finishes → Sidecar reaped, runtime restart, etc.).
    // Connection / send-side failures during those windows are EXPECTED, not
    // bugs — emitting them at ERROR drowns real issues in the unified log.
    // Timeouts, in contrast, mean the Sidecar is alive but stuck — that IS a
    // bug worth surfacing loudly.
    let response = req_builder.send().await.map_err(|e| {
        let mut err = format!("[proxy] Request failed: {}", e);

        let is_connect = e.is_connect();
        let is_request = e.is_request();
        let is_timeout = e.is_timeout();
        let is_body = e.is_body();

        if is_connect {
            err.push_str(" (Connection error - cannot establish connection)");
        }
        if is_timeout {
            err.push_str(" (Timeout error - request took too long)");
        }
        if is_request {
            err.push_str(" (Request error - invalid request)");
        }
        if is_body {
            err.push_str(" (Body error - failed to read response body)");
        }
        if let Some(source) = e.source() {
            err.push_str(&format!(" | Source: {}", source));
        }

        // Classify: lifecycle (WARN) vs genuine fault (ERROR).
        // Connection refused / send-error to a localhost port → WARN: the
        // peer Sidecar is gone, almost certainly because its owner released
        // it. The renderer's `tauriClient::stopSseProxy` + Tab close already
        // race against in-flight requests; this is the cleanup tail.
        // Timeout → ERROR: Sidecar is alive (TCP open) but unresponsive,
        // which means a hang or deadlock worth investigating.
        let is_localhost = request.url.starts_with("http://127.0.0.1:")
            || request.url.starts_with("http://localhost:");
        let is_lifecycle_class = (is_connect || is_request) && !is_timeout;
        if is_localhost && is_lifecycle_class {
            logger::warn(&app, &err);
        } else {
            logger::error(&app, &err);
        }
        e.to_string()
    })?;

    let status = response.status().as_u16();

    // Collect response headers
    let mut resp_headers = std::collections::HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(key.to_string(), v.to_string());
        }
    }

    // Check if this is binary content
    let content_type = resp_headers
        .get("content-type")
        .map(|s| s.as_str())
        .unwrap_or("");

    let is_binary = is_binary_content_type(content_type);

    let content_length_hint: Option<u64> = resp_headers
        .get("content-length")
        .and_then(|s| s.parse::<u64>().ok());
    let response_policy = ResponsePolicy::for_target(target_is_loopback);
    if let Err(error) = response_policy.check_content_length(content_length_hint) {
        logger::warn(&app, &error);
        return Err(error);
    }
    let header_says_spill = content_length_hint
        .map(|len| response_policy.allow_spill && len > response_policy.spill_threshold_bytes)
        .unwrap_or(false);

    let stream_outcome = stream_response_body(
        response,
        content_type,
        &request.url,
        response_policy,
        header_says_spill,
        spill_manager,
    )
    .await;

    let (body, is_base64) = match stream_outcome {
        StreamOutcome::Spilled(spill) => {
            if !is_noisy_path {
                let elapsed = start.elapsed().as_millis();
                logger::debug(
                    &app,
                    format!(
                        "[proxy] {} {} -> {} (spilled {}B, {}ms, ref={})",
                        request.method,
                        request.url,
                        status,
                        spill.size_bytes,
                        elapsed,
                        spill.ref_url
                    ),
                );
            }
            return Ok(HttpResponse {
                status,
                body: String::new(),
                headers: resp_headers,
                is_base64: false,
                ref_url: Some(spill.ref_url),
                ref_mimetype: Some(spill.mimetype),
                ref_size_bytes: Some(spill.size_bytes),
            });
        }
        StreamOutcome::Buffered(bytes) => {
            if is_binary {
                (BASE64.encode(&bytes), true)
            } else {
                // Lossless decode: if the body isn't valid UTF-8, treat as
                // binary fallback (base64) rather than panicking. Matches the
                // old `response.text()` semantics for valid utf-8 bodies.
                match String::from_utf8(bytes) {
                    Ok(s) => (s, false),
                    Err(e) => (BASE64.encode(e.as_bytes()), true),
                }
            }
        }
        StreamOutcome::Failed(err) => {
            logger::warn(&app, &err);
            return Err(err);
        }
    };

    // Log: single line for success, skip noisy polling endpoints entirely
    if !is_noisy_path {
        let elapsed = start.elapsed().as_millis();
        if status >= 200 && status < 300 {
            logger::debug(
                &app,
                format!(
                    "[proxy] {} {} -> {} ({}B, {}ms)",
                    request.method,
                    request.url,
                    status,
                    body.len(),
                    elapsed
                ),
            );
        } else {
            logger::warn(
                &app,
                format!(
                    "[proxy] {} {} -> {} ({}B, {}ms)",
                    request.method,
                    request.url,
                    status,
                    body.len(),
                    elapsed
                ),
            );
        }
    }

    Ok(HttpResponse {
        status,
        body,
        headers: resp_headers,
        is_base64,
        ref_url: None,
        ref_mimetype: None,
        ref_size_bytes: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex as StdMutex};
    use tauri::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn loopback_response(raw_response: &'static [u8]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback server");
        let address = listener.local_addr().expect("loopback address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(raw_response)
                .await
                .expect("write test response");
            let _ = socket.shutdown().await;
        });
        format!("http://{}/chat/stream", address)
    }

    async fn loopback_owned_response(raw_response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback server");
        let address = listener.local_addr().expect("loopback address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(&raw_response)
                .await
                .expect("write test response");
            let _ = socket.shutdown().await;
        });
        format!("http://{}/chat/stream", address)
    }

    async fn loopback_port_with_request_signal(
        raw_response: &'static [u8],
    ) -> (u16, tokio::sync::oneshot::Receiver<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback server");
        let port = listener.local_addr().expect("loopback address").port();
        let (requested_tx, requested_rx) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(raw_response)
                .await
                .expect("write test response");
            let _ = socket.shutdown().await;
            let _ = requested_tx.send(());
        });
        (port, requested_rx)
    }

    async fn stalled_loopback_stream() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stalled loopback server");
        let address = listener.local_addr().expect("stalled loopback address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept stalled request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
                )
                .await
                .expect("write stalled headers");
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });
        format!("http://{}/chat/stream", address)
    }

    async fn active_test_state(connection_key: &str, generation: u64) -> Arc<SseProxyState> {
        let state = Arc::new(SseProxyState::default());
        let connection = SseConnection::new(
            generation,
            "session-test".to_string(),
            SidecarOwner::Tab("tab-test".to_string()),
        );
        connection.running.store(true, Ordering::SeqCst);
        state
            .connections
            .lock()
            .await
            .insert(connection_key.to_string(), connection);
        state
    }

    fn detached_test_completion_authority() -> (ManagedSidecarManager, FrontendSidecarBinding) {
        (
            Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new())),
            FrontendSidecarBinding::detached_test_value(),
        )
    }

    #[test]
    fn frontend_sse_owner_contract_reuses_existing_owner_variants() {
        assert_eq!(
            frontend_sidecar_owner("tab", "tab-a".to_string()),
            Ok(SidecarOwner::Tab("tab-a".to_string()))
        );
        assert_eq!(
            frontend_sidecar_owner("companion", "floating-ball".to_string()),
            Ok(SidecarOwner::Companion("floating-ball".to_string()))
        );
        assert!(frontend_sidecar_owner("task", "task-a".to_string()).is_err());
        assert!(frontend_sidecar_owner("tab", String::new()).is_err());
    }

    #[test]
    fn sse_retry_delay_is_bounded_exponential() {
        assert_eq!(retry_delay_ms(0), SSE_RETRY_BASE_DELAY_MS);
        assert_eq!(retry_delay_ms(1), 250);
        assert_eq!(retry_delay_ms(2), 500);
        assert_eq!(retry_delay_ms(3), 1_000);
        assert_eq!(retry_delay_ms(6), SSE_RETRY_MAX_DELAY_MS);
        assert_eq!(retry_delay_ms(u32::MAX), SSE_RETRY_MAX_DELAY_MS);
    }

    #[test]
    fn successful_transport_resets_backoff_before_the_next_disconnect() {
        assert_eq!(next_retry_failure_count(7, true), 1);
        assert_eq!(retry_delay_ms(next_retry_failure_count(7, true)), 250);
        assert_eq!(next_retry_failure_count(7, false), 8);
    }

    #[test]
    fn protocol_budget_breach_never_resets_retry_backoff() {
        let breach = SseAttemptOutcome::ProtocolBudgetBreach {
            transport_generation: 4,
            observed_event_bytes: 33,
            limit_bytes: 32,
        };
        let after_first = next_retry_failure_count_for_outcome(7, &breach);
        let after_second = next_retry_failure_count_for_outcome(after_first, &breach);

        assert_eq!(after_first, 8);
        assert_eq!(after_second, 9);
        assert_eq!(retry_delay_ms(after_second), SSE_RETRY_MAX_DELAY_MS);
    }

    #[test]
    fn event_budget_is_per_frame_and_accepts_a_split_delimiter_at_the_limit() {
        let mut buffer = vec![b'x'; 16];
        assert_eq!(take_next_sse_event(&mut buffer, 16), Ok(None));

        buffer.extend_from_slice(b"\n\nsmall\n\n");
        assert_eq!(
            take_next_sse_event(&mut buffer, 16),
            Ok(Some("x".repeat(16)))
        );
        assert_eq!(
            take_next_sse_event(&mut buffer, 16),
            Ok(Some("small".to_string()))
        );
        assert_eq!(take_next_sse_event(&mut buffer, 16), Ok(None));
    }

    #[test]
    fn event_budget_rejects_terminated_and_unterminated_frames_over_the_limit() {
        let mut unterminated = vec![b'x'; 17];
        assert_eq!(take_next_sse_event(&mut unterminated, 16), Err(17));

        let mut terminated = vec![b'x'; 17];
        terminated.extend_from_slice(b"\r\n\r\n");
        assert_eq!(take_next_sse_event(&mut terminated, 16), Err(17));
    }

    #[test]
    fn tauri_sse_envelope_exposes_transport_generation_without_changing_data() {
        let envelope = TauriSseEnvelope {
            transport_generation: 42,
            data: r#"{"sessionId":"s1","payload":"hello"}"#.to_string(),
        };
        let json = serde_json::to_value(envelope).expect("serialize SSE envelope");

        assert_eq!(json["transportGeneration"], 42);
        assert_eq!(json["data"], r#"{"sessionId":"s1","payload":"hello"}"#);
    }

    #[test]
    fn transport_generation_is_monotonic_across_attempts() {
        let first = next_transport_generation();
        let second = next_transport_generation();
        assert!(second > first);
    }

    #[tokio::test]
    async fn sse_attempt_classifies_connect_failure_and_non_success_status() {
        let app = tauri::test::mock_app();
        let running = AtomicBool::new(true);
        let state = active_test_state("test", 1).await;
        let (manager, binding) = detached_test_completion_authority();

        let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("reserve unavailable port");
        let unavailable_url = format!(
            "http://{}/chat/stream",
            unavailable.local_addr().expect("unavailable address")
        );
        drop(unavailable);
        match connect_sse_attempt(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &unavailable_url,
            &running,
            "test",
        )
        .await
        {
            SseAttemptOutcome::Disconnected { made_progress, .. } => {
                assert!(!made_progress)
            }
            SseAttemptOutcome::ProtocolBudgetBreach { .. } => {
                panic!("connect failure is not a protocol breach")
            }
            SseAttemptOutcome::Stopped => panic!("connect failure must be retryable"),
        }

        let status_url = loopback_response(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        match connect_sse_attempt(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &status_url,
            &running,
            "test",
        )
        .await
        {
            SseAttemptOutcome::Disconnected {
                made_progress,
                reason,
                ..
            } => {
                assert!(!made_progress);
                assert!(reason.contains("503"));
            }
            SseAttemptOutcome::ProtocolBudgetBreach { .. } => {
                panic!("HTTP status is not a protocol breach")
            }
            SseAttemptOutcome::Stopped => panic!("HTTP status must be retryable"),
        }
    }

    #[tokio::test]
    async fn sse_attempt_forwards_one_generation_on_every_event_then_retries_eof() {
        let app = tauri::test::mock_app();
        let payloads = Arc::new(StdMutex::new(Vec::<String>::new()));
        let payloads_for_listener = payloads.clone();
        app.listen("sse:test:chat:message-chunk", move |event: tauri::Event| {
            payloads_for_listener
                .lock()
                .expect("payload lock")
                .push(event.payload().to_string());
        });
        let url = loopback_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: chat:message-chunk\ndata: first\n\nevent: chat:message-chunk\ndata: second\n\n",
        )
        .await;
        let running = AtomicBool::new(true);
        let state = active_test_state("test", 1).await;
        let (manager, binding) = detached_test_completion_authority();

        match connect_sse_attempt(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &url,
            &running,
            "test",
        )
        .await
        {
            SseAttemptOutcome::Disconnected {
                made_progress,
                reason,
                ..
            } => {
                assert!(made_progress);
                assert!(reason.contains("stream ended"));
            }
            SseAttemptOutcome::ProtocolBudgetBreach { .. } => {
                panic!("bounded events must not breach")
            }
            SseAttemptOutcome::Stopped => panic!("EOF must be retryable"),
        }

        let payloads = payloads.lock().expect("payload lock");
        assert_eq!(payloads.len(), 2);
        let first: serde_json::Value = serde_json::from_str(&payloads[0]).expect("first envelope");
        let second: serde_json::Value =
            serde_json::from_str(&payloads[1]).expect("second envelope");
        assert_eq!(first["data"], "first");
        assert_eq!(second["data"], "second");
        assert_eq!(first["transportGeneration"], second["transportGeneration"]);
    }

    #[tokio::test]
    async fn sse_attempt_treats_truncated_body_as_retryable_stream_error() {
        let app = tauri::test::mock_app();
        let url = loopback_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 256\r\nConnection: close\r\n\r\nevent: chat:message-chunk\ndata: partial\n\n",
        )
        .await;
        let running = AtomicBool::new(true);
        let state = active_test_state("test", 1).await;
        let (manager, binding) = detached_test_completion_authority();

        match connect_sse_attempt(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &url,
            &running,
            "test",
        )
        .await
        {
            SseAttemptOutcome::Disconnected {
                made_progress,
                reason,
                ..
            } => {
                assert!(made_progress);
                assert!(reason.contains("stream error"));
            }
            SseAttemptOutcome::ProtocolBudgetBreach { .. } => {
                panic!("bounded event must not breach")
            }
            SseAttemptOutcome::Stopped => panic!("body error must be retryable"),
        }
    }

    #[tokio::test]
    async fn sse_attempt_treats_read_timeout_as_retryable_without_progress() {
        let app = tauri::test::mock_app();
        let url = stalled_loopback_stream().await;
        let running = AtomicBool::new(true);
        let state = active_test_state("test", 1).await;
        let (manager, binding) = detached_test_completion_authority();

        match connect_sse_attempt_with_read_timeout(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &url,
            &running,
            "test",
            std::time::Duration::from_millis(25),
            SSE_EVENT_MAX_BYTES,
        )
        .await
        {
            SseAttemptOutcome::Disconnected {
                made_progress,
                reason,
                ..
            } => {
                assert!(!made_progress);
                assert!(reason.contains("stream error"));
            }
            SseAttemptOutcome::ProtocolBudgetBreach { .. } => {
                panic!("read timeout is not a protocol breach")
            }
            SseAttemptOutcome::Stopped => panic!("read timeout must be retryable"),
        }
    }

    #[tokio::test]
    async fn protocol_budget_breach_is_attempt_local_and_next_transport_recovers() {
        let app = tauri::test::mock_app();
        let running = AtomicBool::new(true);
        let state = active_test_state("test", 1).await;
        let (manager, binding) = detached_test_completion_authority();
        let mut oversized_response =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                .to_vec();
        oversized_response.extend_from_slice(&vec![b'x'; 33]);
        let oversized_url = loopback_owned_response(oversized_response).await;

        let breached_generation = match connect_sse_attempt_with_read_timeout(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &oversized_url,
            &running,
            "test",
            std::time::Duration::from_secs(1),
            32,
        )
        .await
        {
            SseAttemptOutcome::ProtocolBudgetBreach {
                transport_generation,
                observed_event_bytes,
                limit_bytes,
            } => {
                assert_eq!(observed_event_bytes, 33);
                assert_eq!(limit_bytes, 32);
                transport_generation
            }
            _ => panic!("unterminated oversized event must be a protocol breach"),
        };

        let recovered_url = loopback_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: recovered\n\n",
        )
        .await;
        match connect_sse_attempt_with_read_timeout(
            app.handle(),
            &manager,
            &binding,
            &state,
            1,
            &recovered_url,
            &running,
            "test",
            std::time::Duration::from_secs(1),
            32,
        )
        .await
        {
            SseAttemptOutcome::Disconnected {
                made_progress,
                transport_generation: Some(recovered_generation),
                ..
            } => {
                assert!(made_progress);
                assert!(recovered_generation > breached_generation);
            }
            _ => panic!("the next bounded transport must recover normally"),
        }
    }

    #[tokio::test]
    async fn replaced_subscription_generation_cannot_emit_to_reused_event_namespace() {
        let app = tauri::test::mock_app();
        let payloads = Arc::new(StdMutex::new(Vec::<String>::new()));
        let payloads_for_listener = payloads.clone();
        app.listen("sse:fb:chat:message-chunk", move |event: tauri::Event| {
            payloads_for_listener
                .lock()
                .expect("payload lock")
                .push(event.payload().to_string());
        });
        let state = active_test_state("fb", 2).await;
        let (manager, binding) = detached_test_completion_authority();

        let emitted = emit_sse_event_if_current(
            app.handle(),
            &manager,
            &binding,
            &state,
            "fb",
            1,
            99,
            "chat:message-chunk".to_string(),
            "stale old-session chunk".to_string(),
        )
        .await;

        assert!(!emitted);
        assert!(payloads.lock().expect("payload lock").is_empty());
    }

    #[tokio::test]
    async fn supervisor_retries_and_resolves_the_sidecar_port_again() {
        let app = tauri::test::mock_app();
        let (first_port, first_requested) = loopback_port_with_request_signal(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let (second_port, second_requested) = loopback_port_with_request_signal(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: chat:message-chunk\ndata: recovered\n\n",
        )
        .await;
        let owner = SidecarOwner::Tab("tab-test".to_string());
        let manager: ManagedSidecarManager =
            Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));
        manager
            .lock()
            .expect("manager lock")
            .insert_test_ready_frontend_sidecar("session-test", first_port, owner.clone());
        let state = active_test_state("test", 1).await;
        let running = Arc::new(AtomicBool::new(true));

        let task = tauri::async_runtime::spawn({
            let app_handle = app.handle().clone();
            let manager = manager.clone();
            let state = state.clone();
            let running = running.clone();
            let owner = owner.clone();
            async move {
                run_sse_supervisor(
                    &app_handle,
                    &manager,
                    &state,
                    &running,
                    "test",
                    1,
                    "session-test",
                    &owner,
                )
                .await;
            }
        });

        tokio::time::timeout(std::time::Duration::from_secs(1), first_requested)
            .await
            .expect("first attempt timeout")
            .expect("first attempt signal");
        manager
            .lock()
            .expect("manager lock")
            .set_test_sidecar_port("session-test", second_port);
        tokio::time::timeout(std::time::Duration::from_secs(2), second_requested)
            .await
            .expect("second attempt timeout")
            .expect("second attempt signal");

        running.store(false, Ordering::SeqCst);
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("supervisor stop timeout")
            .expect("supervisor task");
    }
}
