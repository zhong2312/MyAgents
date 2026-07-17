// SSE Proxy module - Connects to sidecar SSE and forwards events via Tauri
// This bypasses WebView CORS restrictions entirely
// Supports multiple connections (one per Tab)

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::{ulog_debug, ulog_error, ulog_info};

/// Monotonically increasing connection id used to distinguish a "stale" task
/// (one whose entry has already been replaced by a newer connection) from
/// the live one. Pattern 1, audit A: SSE proxy task exits without clearing
/// `running=true` → tab permanently muted on reconnect because new
/// `start_sse_proxy` saw `running == true` and returned Ok early.
static SSE_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_generation() -> u64 {
    SSE_GENERATION.fetch_add(1, Ordering::Relaxed)
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
const HTTP_PROXY_TIMEOUT_SECS: u64 = 120;
const HTTP_PROXY_LONG_TIMEOUT_SECS: u64 = 360;

/// Endpoints that need the long-timeout budget. Keep this list short — most
/// sidecar work should finish in seconds, not minutes.
fn proxy_timeout_for(url_path: &str) -> u64 {
    if url_path.ends_with("/api/skill/install-from-url") {
        HTTP_PROXY_LONG_TIMEOUT_SECS
    } else {
        HTTP_PROXY_TIMEOUT_SECS
    }
}

/// Classify whether an absolute URL targets the local loopback (the sidecar) or
/// an external host.
///
/// `proxy_http_request` is the single Rust entry point for **all** renderer HTTP:
/// the overwhelming majority is `http://127.0.0.1:<port>/...` to the owning
/// Sidecar (which MUST bypass any system proxy via `local_http`, or Clash/V2Ray
/// returns 502), but the renderer analytics queue also POSTs to an **external**
/// endpoint (`https://analytics.myagents.io/api/track`) through this same path.
///
/// Routing the external case through the localhost-only `.no_proxy()` client
/// silently bypasses the user's configured proxy AND reqwest's system-proxy
/// discovery — so a China/Windows user whose only egress is a Clash/V2Ray HTTP
/// proxy makes a forced-direct connection that fails, and telemetry is dropped
/// after 5 silent retries. That biases the platform dashboard toward whoever
/// happens to have working direct egress. External hosts MUST therefore use the
/// proxy-aware client (`proxy_config::build_client_with_proxy`), exactly like the
/// updater / LiteLLM cache. See CLAUDE.md `local_http` red-line + proxy_config.md.
///
/// Parse with the SAME parser reqwest uses to actually connect (`reqwest::Url`,
/// i.e. the WHATWG `url` crate), so the proxy decision can never disagree with
/// the real destination host. A hand-rolled parser would: e.g. a backslash +
/// userinfo trick like `http://evil.com\@127.0.0.1/` parses to host `evil.com`
/// (backslash is a path separator), but a naive "take the last `@`" reader would
/// see `127.0.0.1` and wrongly bypass the proxy. The parse cost is negligible
/// next to building a `reqwest::Client` + an HTTP round trip. Anything that does
/// not parse, or is not a loopback host, is treated as external (fail toward
/// honoring the proxy; relative URLs are already rejected upstream).
fn request_target_is_loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    // host_str() brackets IPv6 literals (`[::1]`); strip them before IP parse.
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // `is_loopback()` covers 127.0.0.0/8 and ::1 exactly — a substring check like
    // `starts_with("127.")` would wrongly match a host such as `127.0.0.1.evil.com`.
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// Single SSE connection for a Tab
struct SseConnection {
    /// Generation id assigned at spawn time; spawned task captures this and
    /// only clears its entry on exit if the entry's generation still matches.
    generation: u64,
    /// Shared running flag - used to gracefully stop the SSE stream
    running: Arc<AtomicBool>,
    /// Task handle for aborting if graceful stop fails
    abort_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl SseConnection {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            running: Arc::new(AtomicBool::new(false)),
            abort_handle: None,
        }
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

/// State for managing multiple SSE connections (one per Tab)
pub struct SseProxyState {
    /// Tab ID -> SSE connection
    connections: Mutex<HashMap<String, SseConnection>>,
}

impl Default for SseProxyState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

/// Start SSE proxy connection for a specific Tab
#[tauri::command]
pub async fn start_sse_proxy(
    app: AppHandle,
    state: tauri::State<'_, Arc<SseProxyState>>,
    url: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tab_id = tab_id.unwrap_or_else(|| "__default__".to_string());

    let mut connections = state.connections.lock().await;

    // Check if already running for this tab. Pattern 1, audit A: only
    // short-circuit when the previous task is *actually* alive — a finished
    // JoinHandle / cleared running flag means the prior task crashed without
    // cleanup, and we must replace it (otherwise the tab stays muted forever).
    if let Some(conn) = connections.get(&tab_id) {
        if conn.is_alive() {
            ulog_debug!(
                "[sse-proxy] Tab {} already has an active connection",
                tab_id
            );
            return Ok(());
        }
        ulog_debug!(
            "[sse-proxy] Tab {} prior task ended (gen={}); replacing",
            tab_id,
            conn.generation
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
    if let Some(mut conn) = connections.remove(&tab_id) {
        conn.stop();
    }

    // Allocate this connection's generation and create the entry.
    let my_gen = next_generation();
    let mut conn = SseConnection::new(my_gen);
    conn.running.store(true, Ordering::SeqCst);

    let app_handle = app.clone();
    let tab_id_clone = tab_id.clone();
    // Share the same running flag with the spawned task
    let running = conn.running.clone();
    let state_for_task = (*state).clone();

    // Spawn async task to handle SSE stream
    let handle = tauri::async_runtime::spawn(async move {
        let outcome = connect_sse(&app_handle, &url, &running, &tab_id_clone).await;
        match outcome {
            Ok(_) => {
                ulog_debug!(
                    "[sse-proxy] Tab {} connection closed normally",
                    tab_id_clone
                );
            }
            Err(e) => {
                ulog_error!("[sse-proxy] Tab {} connection error: {}", tab_id_clone, e);
                // Emit error with tab_id prefix so frontend can filter
                let _ = app_handle.emit(&format!("sse:{}:error", tab_id_clone), e.to_string());
            }
        }

        // Pattern 1: on task exit, clear the running flag and remove the
        // entry — but only if the entry still belongs to *this* generation
        // (a newer start_sse_proxy may have already replaced us). Without
        // this, audit A would still bite: stale `running=true` → next
        // connect short-circuits and the tab is muted.
        let mut connections = state_for_task.connections.lock().await;
        match connections.get_mut(&tab_id_clone) {
            Some(entry) if entry.generation == my_gen => {
                entry.running.store(false, Ordering::SeqCst);
                entry.abort_handle = None;
                connections.remove(&tab_id_clone);
                ulog_debug!(
                    "[sse-proxy] Tab {} cleaned own entry (gen={})",
                    tab_id_clone,
                    my_gen
                );
            }
            Some(entry) => {
                ulog_debug!(
                    "[sse-proxy] Tab {} task exit (gen={}) superseded by gen={}; not clearing",
                    tab_id_clone,
                    my_gen,
                    entry.generation
                );
            }
            None => { /* already removed elsewhere */ }
        }
    });

    conn.abort_handle = Some(handle);
    connections.insert(tab_id.clone(), conn);

    ulog_info!(
        "[sse-proxy] Started connection for tab {} (gen={})",
        tab_id,
        my_gen
    );

    Ok(())
}

/// Stop SSE proxy connection for a specific Tab
#[tauri::command]
pub async fn stop_sse_proxy(
    state: tauri::State<'_, Arc<SseProxyState>>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tab_id = tab_id.unwrap_or_else(|| "__default__".to_string());

    let mut connections = state.connections.lock().await;

    if let Some(mut conn) = connections.remove(&tab_id) {
        conn.stop();
        ulog_info!("[sse-proxy] Stopped connection for tab {}", tab_id);
    }

    Ok(())
}

/// Stop all SSE connections (for app cleanup)
#[tauri::command]
pub async fn stop_all_sse_proxies(
    state: tauri::State<'_, Arc<SseProxyState>>,
) -> Result<(), String> {
    let mut connections = state.connections.lock().await;

    for (tab_id, mut conn) in connections.drain() {
        conn.stop();
        ulog_info!("[sse-proxy] Stopped connection for tab {}", tab_id);
    }

    Ok(())
}

/// Connect to SSE endpoint and forward events with Tab prefix
async fn connect_sse(
    app: &AppHandle,
    url: &str,
    running: &AtomicBool,
    tab_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::logger;
    use futures_util::StreamExt;

    logger::info(
        app,
        format!("[sse-proxy] Tab {} connecting to {}", tab_id, url),
    );

    // Build client with read_timeout (idle timeout) for SSE long connections
    // IMPORTANT: Do NOT use timeout() which is total request time - SSE connections are meant to be long-lived
    // Use read_timeout instead: if no data received within this time, connection is considered dead
    // Backend sends heartbeat every 15s, so 60s read_timeout gives 4x margin
    // CRITICAL: Enable tcp_nodelay to disable Nagle's algorithm for immediate packet transmission
    // Without this, small SSE events may be buffered and delayed, causing UI to feel unresponsive
    // Force HTTP/1.1 for compatibility with Bun server (HTTP/2 may cause connection issues on Windows)
    // Use short-lived connection pool to balance performance and stability
    let client = crate::local_http::builder()
        .read_timeout(std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS))
        .tcp_nodelay(true)
        .http1_only() // Force HTTP/1.1 for SSE compatibility
        .pool_idle_timeout(std::time::Duration::from_secs(5))
        .pool_max_idle_per_host(2)
        .build()
        .map_err(|e| format!("[sse-proxy] Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .header("Accept", "text/event-stream")
        .send()
        .await?;

    if !response.status().is_success() {
        let err = format!(
            "[sse-proxy] Tab {} connection failed: {}",
            tab_id,
            response.status()
        );
        logger::error(app, &err);
        return Err(err.into());
    }

    logger::info(
        app,
        format!(
            "[sse-proxy] Tab {} connected, status: {}, read_timeout: {}s (heartbeat interval: 15s)",
            tab_id,
            response.status(),
            SSE_READ_TIMEOUT_SECS
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

    fn find_event_boundary(buf: &[u8]) -> Option<(usize, usize)> {
        // Returns (position_of_event_end, separator_length).
        // Prefer the EARLIEST boundary so we don't accidentally swallow
        // another event into the current one if both kinds appear.
        let lf = buf.windows(2).position(|w| w == b"\n\n");
        let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
        match (lf, crlf) {
            (Some(l), Some(c)) => {
                if l <= c {
                    Some((l, 2))
                } else {
                    Some((c, 4))
                }
            }
            (Some(l), None) => Some((l, 2)),
            (None, Some(c)) => Some((c, 4)),
            (None, None) => None,
        }
    }

    while running.load(Ordering::SeqCst) {
        match stream.next().await {
            Some(Ok(chunk)) => {
                chunk_count += 1;
                buffer.extend_from_slice(&chunk);

                // Process complete SSE events (end with \n\n or \r\n\r\n)
                while let Some((pos, sep_len)) = find_event_boundary(&buffer) {
                    // Decode the complete event region as UTF-8 (lossy is
                    // fine HERE — by the time we have a full event boundary,
                    // any multi-byte sequence has its final byte present).
                    let event_str = String::from_utf8_lossy(&buffer[..pos]).to_string();
                    // O(1) amortised drain.
                    buffer.drain(..pos + sep_len);

                    // Re-check `running` BEFORE emitting. Without this fence,
                    // a stop_sse_proxy() call that fires between `stream.next()`
                    // resolving and the inner emit loop running would still
                    // dispatch the buffered events. The renderer side will
                    // already have called `unlisten()` for those event names,
                    // so each emit produces a "Couldn't find callback id N"
                    // warning on the JS console (12+ such warnings observed
                    // in the 2026-05-07 logs across tab-close events).
                    // Dropping the events here is safe: the renderer treats
                    // a closed-tab SSE stream as terminated, and the
                    // sidecar persists state independently of SSE delivery.
                    if !running.load(Ordering::SeqCst) {
                        break;
                    }

                    // Parse and emit SSE event with Tab prefix
                    if let Some((event_name, data)) = parse_sse_event(&event_str) {
                        // Log critical state-changing events
                        if event_name == "chat:message-complete"
                            || event_name == "chat:message-stopped"
                            || event_name == "chat:message-error"
                        {
                            logger::info(
                                app,
                                format!(
                                    "[sse-proxy] Tab {} emitting critical event: {}",
                                    tab_id, event_name
                                ),
                            );
                            if let Some(terminal) =
                                crate::notification::completion_terminal_from_sse_data(&data)
                            {
                                let notification_app = app.clone();
                                tauri::async_runtime::spawn_blocking(move || {
                                    crate::notification::submit_session_completion(
                                        &notification_app,
                                        terminal,
                                    );
                                });
                            }
                        }
                        // Emit with tab_id prefix: sse:tab_id:event_name
                        let prefixed_event = format!("sse:{}:{}", tab_id, event_name);
                        if let Err(e) = app.emit(&prefixed_event, data) {
                            logger::error(
                                app,
                                format!(
                                    "[sse-proxy] Tab {} failed to emit {}: {}",
                                    tab_id, prefixed_event, e
                                ),
                            );
                        }
                    }
                }
            }
            Some(Err(e)) => {
                // Log detailed error information for debugging
                let err_detail = format!("{:?}", e); // Debug format shows more details
                let buffer_preview = if buffer.len() > 200 {
                    format!(
                        "{}...(truncated, total {} bytes)",
                        String::from_utf8_lossy(&buffer[..200]),
                        buffer.len(),
                    )
                } else {
                    String::from_utf8_lossy(&buffer).to_string()
                };

                logger::error(app, format!(
                    "[sse-proxy] Tab {} stream error after {} chunks\n  Error: {}\n  Error detail: {}\n  Buffer preview: {:?}",
                    tab_id, chunk_count, e, err_detail, buffer_preview
                ));

                let err = format!(
                    "[sse-proxy] Tab {} stream error after {} chunks: {}",
                    tab_id, chunk_count, e
                );
                return Err(err.into());
            }
            None => {
                logger::info(
                    app,
                    format!(
                        "[sse-proxy] Tab {} stream ended after {} chunks",
                        tab_id, chunk_count
                    ),
                );
                break;
            }
        }
    }

    logger::info(
        app,
        format!(
            "[sse-proxy] Tab {} connection closed, processed {} chunks",
            tab_id, chunk_count
        ),
    );
    Ok(())
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

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: std::collections::HashMap<String, String>,
    /// True if body is base64 encoded (for binary responses)
    pub is_base64: bool,
    /// Pattern 2 §2.3.4: when set, the response body was spilled to disk by the
    /// sidecar's large-value-store and the renderer should fetch it from this
    /// URL (a `/refs/<id>` endpoint on the same sidecar) instead of decoding
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

/// Pattern 2 §2.3.4: stream-to-disk threshold. Bodies larger than this are
/// written to `~/.myagents/refs/<id>` instead of being base64-encoded /
/// returned inline. 1 MiB matches the sidecar-side `inlineMaxBytes` default
/// but is intentionally a separate constant — Rust proxy and sidecar can
/// drift independently without breaking the protocol.
const PROXY_STREAM_THRESHOLD_BYTES: u64 = 1024 * 1024;

/// Check if content type indicates binary data
fn is_binary_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("application/octet-stream")
        || ct.starts_with("application/pdf")
}

/// Proxy an HTTP request through Rust - completely bypasses WebView CORS
#[tauri::command]
pub async fn proxy_http_request(
    app: AppHandle,
    request: HttpRequest,
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

    // Build client with configurable timeout
    // Enable tcp_nodelay to disable Nagle's algorithm for faster response times
    // Force HTTP/1.1 for compatibility with Bun server (HTTP/2 may cause connection issues on Windows)
    // Use short-lived connection pool to balance performance and stability
    let timeout_secs = proxy_timeout_for(url_path);
    // Shared tuning for both the loopback and external client. tcp_nodelay +
    // http1_only mirror the SSE-compat settings; the short-lived pool balances
    // perf and stability.
    let tune = |b: reqwest::ClientBuilder| {
        b.timeout(std::time::Duration::from_secs(timeout_secs))
            .tcp_nodelay(true)
            .http1_only() // Force HTTP/1.1 for SSE compatibility
            .pool_idle_timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(2)
    };
    // Loopback (the Sidecar) MUST bypass the system proxy — Clash/V2Ray would
    // 502 it. External hosts (the analytics endpoint) MUST honor the user's
    // proxy config / system-proxy discovery — otherwise telemetry is silently
    // dropped for proxy-dependent users. See `request_target_is_loopback`.
    let client = if request_target_is_loopback(&request.url) {
        tune(crate::local_http::builder()).build().map_err(|e| {
            let err = format!("[proxy] Failed to create client: {}", e);
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

    // Pattern 2 §2.3.4: stream-to-disk path for large responses.
    //
    // Strategy: always read upstream as a stream and decide while reading.
    // - Buffer in memory up to PROXY_STREAM_THRESHOLD_BYTES (1 MiB). If the
    //   response completes inside that, fall through to the in-memory
    //   base64/text path (no fs hit, no extra RTT).
    // - If the buffer would exceed the threshold, switch to spill: open
    //   ~/.myagents/refs/<id>, dump the buffered bytes, then continue
    //   piping incoming chunks straight to disk.
    //
    // This catches chunked responses (no Content-Length header) — exactly
    // the case where the old header-only check fell back to a fully-buffered
    // `response.bytes()` / `response.text()`.
    //
    // Content-Length is still useful as an early-decision fast path: if
    // the upstream advertises >threshold up front, we go straight to spill
    // without a wasted memory buffer.
    let content_length_hint: Option<u64> = resp_headers
        .get("content-length")
        .and_then(|s| s.parse::<u64>().ok());
    let header_says_spill = content_length_hint
        .map(|len| len > PROXY_STREAM_THRESHOLD_BYTES)
        .unwrap_or(false);

    let stream_outcome = stream_or_spill_response_body(
        &app,
        response,
        content_type,
        &request.url,
        header_says_spill,
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
            // Don't re-log here — `stream_or_spill_response_body` already
            // emitted the fine-grained `[proxy] upstream stream error: …`
            // at the appropriate level (warn for transient stream tear-down
            // when the Sidecar is killed mid-response, which is the common
            // case during Tab close / cron task end). A duplicate log line
            // at ERROR was creating "WARN+ERROR same event" pairs that
            // ate space and made real issues harder to find.
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

struct SpilledBody {
    ref_url: String,
    mimetype: String,
    size_bytes: u64,
}

enum StreamOutcome {
    /// Body fit inside PROXY_STREAM_THRESHOLD_BYTES — caller handles encoding.
    Buffered(Vec<u8>),
    /// Body exceeded the threshold; written to ~/.myagents/refs/<id>.
    Spilled(SpilledBody),
    /// Upstream stream error or fs error after partial read. Caller surfaces
    /// to the renderer; partial spill files are cleaned up before returning.
    Failed(String),
}

/// Read the response body as a stream. Buffer up to PROXY_STREAM_THRESHOLD_BYTES
/// in memory; if the threshold is exceeded, transparently switch to spill mode
/// and write the buffered bytes plus all subsequent chunks to disk.
///
/// `force_spill` short-circuits the buffering phase when Content-Length already
/// said the body is large — we open the spill file immediately rather than
/// buffer 1 MiB just to throw it on disk.
async fn stream_or_spill_response_body(
    app: &AppHandle,
    response: reqwest::Response,
    content_type: &str,
    request_url: &str,
    force_spill: bool,
) -> StreamOutcome {
    use crate::logger;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use futures_util::StreamExt;
    use std::path::PathBuf;
    use tokio::fs::{create_dir_all, File};
    use tokio::io::AsyncWriteExt;

    let threshold = PROXY_STREAM_THRESHOLD_BYTES as usize;
    let preview_cap: usize = 8 * 1024; // matches sidecar default previewBytes

    // Lazy-initialised spill state. None until we either decide to spill
    // (force_spill) or the in-memory buffer crosses the threshold.
    struct SpillState {
        file: File,
        body_path: PathBuf,
        meta_path: PathBuf,
        id: String,
        refs_dir: PathBuf,
    }
    let mut spill: Option<SpillState> = None;
    let mut buffer: Vec<u8> = Vec::new();
    let mut size_bytes: u64 = 0;
    let mut preview_buf: Vec<u8> = Vec::new();

    // Helper: open the spill file lazily. Returns Err string on fs failure.
    async fn init_spill(app: &AppHandle) -> Result<SpillState, String> {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                let err = "[proxy] dirs::home_dir() returned None — cannot spill".to_string();
                logger::warn(app, &err);
                return Err(err);
            }
        };
        let refs_dir: PathBuf = home.join(".myagents").join("refs");
        if let Err(e) = create_dir_all(&refs_dir).await {
            let err = format!("[proxy] failed to mkdir refs dir: {}", e);
            logger::warn(app, &err);
            return Err(err);
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let body_path = refs_dir.join(&id);
        let meta_path = refs_dir.join(format!("{}.meta.json", id));
        let file = match File::create(&body_path).await {
            Ok(f) => f,
            Err(e) => {
                let err = format!("[proxy] failed to create ref body file: {}", e);
                logger::warn(app, &err);
                return Err(err);
            }
        };
        Ok(SpillState {
            file,
            body_path,
            meta_path,
            id,
            refs_dir,
        })
    }

    if force_spill {
        match init_spill(app).await {
            Ok(s) => spill = Some(s),
            Err(e) => return StreamOutcome::Failed(e),
        }
    }

    let mut stream = response.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                let err = format!("[proxy] upstream stream error: {}", e);
                logger::warn(app, &err);
                if let Some(s) = &spill {
                    let _ = tokio::fs::remove_file(&s.body_path).await;
                }
                return StreamOutcome::Failed(err);
            }
        };

        size_bytes += chunk.len() as u64;
        if preview_buf.len() < preview_cap {
            let take = preview_cap
                .saturating_sub(preview_buf.len())
                .min(chunk.len());
            preview_buf.extend_from_slice(&chunk[..take]);
        }

        if let Some(s) = &mut spill {
            // Already spilling — write straight to disk.
            if let Err(e) = s.file.write_all(&chunk).await {
                let err = format!("[proxy] failed to write spill chunk: {}", e);
                logger::warn(app, &err);
                let _ = tokio::fs::remove_file(&s.body_path).await;
                return StreamOutcome::Failed(err);
            }
        } else if buffer.len() + chunk.len() > threshold {
            // Crossing the threshold for the first time — open the spill
            // file, dump what we've buffered so far, then continue with the
            // current chunk.
            let mut s = match init_spill(app).await {
                Ok(s) => s,
                Err(e) => return StreamOutcome::Failed(e),
            };
            if !buffer.is_empty() {
                if let Err(e) = s.file.write_all(&buffer).await {
                    let err = format!("[proxy] failed to flush buffer to spill: {}", e);
                    logger::warn(app, &err);
                    let _ = tokio::fs::remove_file(&s.body_path).await;
                    return StreamOutcome::Failed(err);
                }
                buffer.clear();
                buffer.shrink_to_fit();
            }
            if let Err(e) = s.file.write_all(&chunk).await {
                let err = format!("[proxy] failed to write spill chunk: {}", e);
                logger::warn(app, &err);
                let _ = tokio::fs::remove_file(&s.body_path).await;
                return StreamOutcome::Failed(err);
            }
            spill = Some(s);
        } else {
            buffer.extend_from_slice(&chunk);
        }
    }

    let Some(mut s) = spill else {
        // Stayed under the threshold — return the in-memory buffer.
        return StreamOutcome::Buffered(buffer);
    };

    // Spill path: finalise file and write meta.json.
    if let Err(e) = s.file.flush().await {
        let err = format!("[proxy] failed to flush spill body: {}", e);
        logger::warn(app, &err);
        let _ = tokio::fs::remove_file(&s.body_path).await;
        return StreamOutcome::Failed(err);
    }
    drop(s.file);

    // Build preview as base64 of head bytes — the sidecar treats binary
    // mimetypes as base64 previews, and base64 is safe to embed in JSON for
    // text mimetypes too. The renderer doesn't currently consume preview;
    // this is purely for log / SSE diagnostics.
    let preview = BASE64.encode(&preview_buf);

    let mimetype = if content_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        content_type.to_string()
    };

    // TTL = 1 hour, matching sidecar default.
    let expires_at_ms = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
    .saturating_add(60 * 60 * 1000);

    let meta_json = serde_json::json!({
        "kind": "ref",
        "id": s.id,
        "sizeBytes": size_bytes,
        "mimetype": mimetype,
        "preview": preview,
        "expiresAt": expires_at_ms,
    });
    if let Err(e) = tokio::fs::write(
        &s.meta_path,
        serde_json::to_vec(&meta_json).unwrap_or_default(),
    )
    .await
    {
        let err = format!("[proxy] failed to write ref meta: {}", e);
        logger::warn(app, &err);
        let _ = tokio::fs::remove_file(&s.body_path).await;
        return StreamOutcome::Failed(err);
    }
    // refs_dir kept on the struct so future cleanup paths can reach it; not
    // used here.
    let _ = &s.refs_dir;

    // Compose ref URL on the same origin as the original request — that's
    // the sidecar that owns this ref's filesystem (refs dir is shared, but
    // each sidecar exposes /refs/:id on its own port). For the typical
    // `http://127.0.0.1:<port>/...` case we just substitute the path-and-query
    // tail with `/refs/<id>`. Avoids a `url` crate dep (transitive only).
    let ref_url = origin_of(request_url)
        .map(|origin| format!("{}/refs/{}", origin, s.id))
        .unwrap_or_else(|| format!("http://127.0.0.1/refs/{}", s.id));

    StreamOutcome::Spilled(SpilledBody {
        ref_url,
        mimetype,
        size_bytes,
    })
}

/// Extract the `scheme://host[:port]` portion of an absolute http(s) URL.
/// Returns None on parse failure. Manual parser to avoid pulling the `url`
/// crate into the direct dependency list.
fn origin_of(absolute_url: &str) -> Option<String> {
    let scheme_end = absolute_url.find("://")?;
    let after = &absolute_url[scheme_end + 3..];
    // Authority ends at the first '/', '?' or '#'.
    let auth_end = after
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(after.len());
    let authority = &after[..auth_end];
    Some(format!("{}://{}", &absolute_url[..scheme_end], authority))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_sidecar_urls_bypass_proxy() {
        // The sidecar is always http://127.0.0.1:<port>/... — these MUST stay on
        // the no_proxy client or a system proxy 502s every UI request.
        assert!(request_target_is_loopback(
            "http://127.0.0.1:31415/api/agents/set"
        ));
        assert!(request_target_is_loopback(
            "http://127.0.0.1:31900/health/ready"
        ));
        assert!(request_target_is_loopback(
            "http://localhost:31415/chat/stream"
        ));
        assert!(request_target_is_loopback("http://127.0.0.5:8080/x")); // whole 127.0.0.0/8
        assert!(request_target_is_loopback("http://[::1]:31415/refs/abc"));
        assert!(request_target_is_loopback(
            "http://[0:0:0:0:0:0:0:1]:31415/x"
        ));
        // Case-insensitive host.
        assert!(request_target_is_loopback("http://LOCALHOST:31415/x"));
        // userinfo prefix on a genuine loopback host is still loopback.
        assert!(request_target_is_loopback(
            "http://user:pass@127.0.0.1:31415/x"
        ));
        // No path, only query/fragment.
        assert!(request_target_is_loopback("http://127.0.0.1:31415?x=1"));
        assert!(request_target_is_loopback("http://127.0.0.1:31415#f"));
    }

    #[test]
    fn external_urls_are_not_loopback() {
        // The analytics endpoint (and any future external POST) MUST route
        // through the proxy-aware client, so it must NOT classify as loopback.
        assert!(!request_target_is_loopback(
            "https://analytics.myagents.io/api/track"
        ));
        assert!(!request_target_is_loopback(
            "https://download.myagents.io/update/x.json"
        ));
        // Look-alikes that are NOT loopback hosts.
        assert!(!request_target_is_loopback("http://127.0.0.1.evil.com/x"));
        assert!(!request_target_is_loopback("http://localhost.evil.com/x"));
        assert!(!request_target_is_loopback(
            "https://user:pass@analytics.myagents.io/track"
        ));
        // Parser-disagreement guard: a backslash is a path separator to the real
        // URL parser, so the true host is `evil.com`, NOT `127.0.0.1`. Must be
        // external (else a hostile URL would bypass the proxy). This is the case
        // a hand-rolled "last @ wins" parser gets wrong.
        assert!(!request_target_is_loopback(
            "http://evil.com\\@127.0.0.1/path"
        ));
        // IPv4-mapped IPv6 is not ::1 loopback.
        assert!(!request_target_is_loopback(
            "http://[::ffff:127.0.0.1]:80/x"
        ));
        // Not an absolute URL → not loopback (caller already guards relative URLs).
        assert!(!request_target_is_loopback("/api/something"));
    }
}
