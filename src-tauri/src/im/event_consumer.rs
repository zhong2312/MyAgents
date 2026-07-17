// IM Pipeline v2 — Pattern C: ImEventConsumer
//
// Long-polls /api/im/events on the Sidecar for one peer_session, demuxes the
// fan-in event stream by requestId via ReplyRouter. Owns the SSE connection
// + reconnect lifecycle (exponential backoff, `since=<lastSeq>` resume on
// reconnect for crash-recovery semantics).
//
// One ImEventConsumer task per peer_session. Spawned by `mod.rs` after
// `ensure_sidecar` returns, cancelled by setting the shared AtomicBool when
// the peer_session goes idle. Replaces the per-message SSE consumer that
// lived inside `stream_to_im` (the old /api/im/chat path).

#![allow(dead_code)] // Wired up in Pattern C-6 (mod.rs spawn refactor).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

use super::adapter::ImStreamAdapter;
use super::reply_router::{ReplyRouter, TerminalOutcome};
use crate::{ulog_info, ulog_warn};

const RECONNECT_INITIAL_MS: u64 = 200;
const RECONNECT_MAX_MS: u64 = 5_000;

/// Shared cancellation flag handed to the consumer task. The owner (mod.rs
/// spawn or peer_session lifecycle) flips it via `cancel.store(true,
/// Ordering::SeqCst)` to terminate the loop.
pub type CancelFlag = Arc<AtomicBool>;

/// Spawns a long-poll consumer task. The task runs until `cancel` flips true;
/// on transient errors it reconnects with exponential backoff and resumes via
/// `?since=<lastSeq>`.
///
/// On a terminal event ('complete' / 'error' / 'cancelled'), the matching
/// slot is removed from `router` and `on_terminal` is invoked with the
/// requestId + outcome (used by mod.rs to record session_id + fire post-stream
/// cleanup).
/// Spawn a long-poll consumer for a peer_session. The `session_label` arg is
/// used for log identification only — the Sidecar's /api/im/events does not
/// filter by session (Sidecar is 1:1 with session, so the bus implicitly
/// scopes). Kept as a parameter so the log line can identify which
/// peer_session this consumer belongs to.
pub fn spawn_consumer<A>(
    client: Client,
    sidecar_port: u16,
    session_label: String,
    initial_replay_request_id: String,
    router: Arc<Mutex<ReplyRouter>>,
    adapter: Arc<A>,
    cancel: CancelFlag,
    on_terminal: Arc<dyn Fn(String, TerminalOutcome) + Send + Sync>,
) -> JoinHandle<()>
where
    A: ImStreamAdapter + Send + Sync + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut last_seq: u64 = 0;
        let mut backoff_ms = RECONNECT_INITIAL_MS;

        loop {
            if cancel.load(Ordering::SeqCst) {
                ulog_info!(
                    "[event-consumer] Cancelled (session={})",
                    &session_label[..session_label.len().min(8)],
                );
                return;
            }

            // W6 fix: legacy URL had `?session=<id>` but the Sidecar handler
            // never read it (Sidecar is 1:1 with session). Removed to avoid
            // misleading future readers.
            let url = events_url(sidecar_port, last_seq, &initial_replay_request_id);

            let response_result = client
                .get(&url)
                .header("Accept", "text/event-stream")
                .send()
                .await;

            let response = match response_result {
                Ok(resp) if resp.status().is_success() => {
                    backoff_ms = RECONNECT_INITIAL_MS;
                    resp
                }
                Ok(resp) => {
                    ulog_warn!(
                        "[event-consumer] /api/im/events returned {} (port={})",
                        resp.status(),
                        sidecar_port,
                    );
                    sleep_with_cancel(&cancel, backoff_ms).await;
                    backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
                    continue;
                }
                Err(e) => {
                    ulog_warn!(
                        "[event-consumer] connect failed: {} (port={}) — retry in {}ms",
                        e,
                        sidecar_port,
                        backoff_ms,
                    );
                    sleep_with_cancel(&cancel, backoff_ms).await;
                    backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
                    continue;
                }
            };

            let mut byte_stream = response.bytes_stream();
            let mut buffer = String::new();

            'inner: loop {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                // W8a fix: race the stream read against a periodic cancel
                // poll. Without this, a quiet stream (no events for tens of
                // seconds) leaves us blocked on `byte_stream.next()` until
                // the next byte arrives — flipping `cancel` from outside
                // takes effect only when the upstream reconnect happens.
                // 1s tick is fine; bus produces deltas << 1s apart in
                // active turns, and idle is the case we're optimizing.
                let chunk_result = tokio::select! {
                    biased;
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        // Tick: check cancel and continue waiting for the next byte.
                        if cancel.load(Ordering::SeqCst) {
                            return;
                        }
                        continue 'inner;
                    }
                    res = byte_stream.next() => res,
                };
                match chunk_result {
                    Some(Ok(chunk)) => {
                        let bytes_ref: &[u8] = chunk.as_ref();
                        buffer.push_str(&String::from_utf8_lossy(bytes_ref));
                        while let Some(pos) = buffer.find("\n\n") {
                            let event_str: String = buffer.drain(..pos).collect();
                            buffer.drain(..2);
                            if event_str.starts_with(':') {
                                continue;
                            }
                            let data = extract_data(&event_str);
                            if data.is_empty() {
                                continue;
                            }
                            let bus_event: Value = match serde_json::from_str(&data) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            if let Some(seq) = bus_event.get("seq").and_then(|s| s.as_u64()) {
                                if seq > last_seq {
                                    last_seq = seq;
                                }
                            }
                            let mut router_guard = router.lock().await;
                            let outcome = router_guard
                                .dispatch(&bus_event, adapter.as_ref(), sidecar_port)
                                .await;
                            if let Some(outcome) = outcome {
                                let request_id = bus_event
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                drop(router_guard);
                                // The terminal callback synchronously acquires its
                                // model-work guard before ReplyRouter ownership is
                                // released, so proxy reconnect cannot observe a gap.
                                on_terminal(request_id.clone(), outcome);
                                router.lock().await.unregister(&request_id);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        ulog_warn!("[event-consumer] stream error: {} — reconnecting", e);
                        break 'inner;
                    }
                    None => {
                        ulog_info!("[event-consumer] stream ended — reconnecting");
                        break 'inner;
                    }
                }
            }

            sleep_with_cancel(&cancel, backoff_ms).await;
            backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
        }
    })
}

fn events_url(sidecar_port: u16, last_seq: u64, initial_replay_request_id: &str) -> String {
    if last_seq == 0 {
        format!(
            "http://127.0.0.1:{}/api/im/events?since=0&replayRequestId={}",
            sidecar_port, initial_replay_request_id,
        )
    } else {
        format!(
            "http://127.0.0.1:{}/api/im/events?since={}",
            sidecar_port, last_seq
        )
    }
}

async fn sleep_with_cancel(cancel: &CancelFlag, ms: u64) {
    let deadline = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50.min(ms))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::events_url;

    #[test]
    fn first_connection_replays_only_the_initial_request() {
        assert_eq!(
            events_url(31415, 0, "req-1"),
            "http://127.0.0.1:31415/api/im/events?since=0&replayRequestId=req-1",
        );
    }

    #[test]
    fn reconnect_resumes_after_last_seen_sequence() {
        assert_eq!(
            events_url(31415, 42, "req-1"),
            "http://127.0.0.1:31415/api/im/events?since=42",
        );
    }
}

fn extract_data(event_str: &str) -> String {
    let mut data_lines = Vec::new();
    for line in event_str.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    data_lines.join("\n")
}
