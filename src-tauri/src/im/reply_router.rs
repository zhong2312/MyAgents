#![allow(dead_code)] // Wired up in Pattern C-6 (mod.rs spawn refactor).
                     // IM Pipeline v2 — Pattern C: ReplyRouter
                     //
                     // Per peer_session reply state machine. Replaces the per-request SSE consumer
                     // that lived inside `stream_to_im` (legacy /api/im/chat path). For each
                     // in-flight requestId, holds a `ReplySlot` capturing block-text accumulator,
                     // draft / placeholder message IDs, and stream protocol state. Events arrive
                     // from `ImEventConsumer` (which long-polls /api/im/events), get routed by
                     // requestId, mutate the slot, then dispatch the appropriate adapter call
                     // (send / edit / finalize / abort).
                     //
                     // Architectural note: ReplyRouter is owned by a single `ImEventConsumer`
                     // task, so event-to-adapter handoff is naturally ordered. Native adapters
                     // perform their platform I/O here. OpenClaw adapters only await the Bridge's
                     // enqueue ACK; the plugin-owned dispatcher performs renderer/platform I/O on
                     // its own per-request queue. The "concurrent in-flight requests" win comes
                     // from request-scoped ownership, not from parallelizing this router.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::adapter::{self, ImStreamAdapter};
use super::types::{AskUserQuestionPayload, ImDeliveryProtocol, ImSourceType};
use super::{
    finalize_block, format_draft_text, has_sentence_boundary, GroupStreamContext, PendingApproval,
    PendingApprovals, PendingQuestion, PendingQuestions, THINKING_PLACEHOLDER,
};
use crate::{ulog_error, ulog_info, ulog_warn};

fn terminal_text(data: Option<&Value>) -> Option<&str> {
    data.and_then(|value| {
        value.as_str().or_else(|| {
            value
                .get("finalPayloads")
                .and_then(Value::as_array)
                .and_then(|payloads| payloads.first())
                .and_then(|payload| payload.get("text"))
                .and_then(Value::as_str)
        })
    })
}

/// Per-requestId reply state. Mirrors the locals previously declared at the
/// top of `stream_to_im` / `stream_to_im_streaming`. One slot per in-flight
/// IM user message.
pub struct ReplySlot {
    pub request_id: String,
    pub chat_id: String,
    /// Original IM message_id — used by adapter.ack_clear() on terminal.
    pub message_id: String,
    pub source_type: ImSourceType,
    pub requester_user_id: Option<String>,
    pub delivery_protocol: Option<ImDeliveryProtocol>,
    /// Whether the request is in group "always" mode (for NO_REPLY detection).
    pub group_activation_always: bool,

    // ── Edit-based protocol state (Telegram, Feishu, Dingtalk basic, Bridge) ──
    pub block_text: String,
    pub draft_id: Option<String>,
    pub last_edit: Instant,
    pub any_text_sent: bool,
    pub placeholder_id: Option<String>,
    pub first_content_sent: bool,
    pub last_block_text: String,

    // ── Streaming protocol state (Dingtalk AI Card / supports_streaming) ──
    pub stream_id: Option<String>,
    pub sequence: u32,
    pub reply_dispatch_started: bool,

    // Result session_id (carried out via 'complete' event for the caller)
    pub completed_session_id: Option<String>,
    /// Whether the slot has reached a terminal state (complete / error / cancelled).
    pub is_done: bool,
}

impl ReplySlot {
    pub fn new(
        request_id: String,
        chat_id: String,
        message_id: String,
        source_type: ImSourceType,
        requester_user_id: Option<String>,
        group_activation_always: bool,
        delivery_protocol: Option<ImDeliveryProtocol>,
    ) -> Self {
        Self {
            request_id,
            chat_id,
            message_id,
            source_type,
            requester_user_id,
            delivery_protocol,
            group_activation_always,
            block_text: String::new(),
            draft_id: None,
            last_edit: Instant::now(),
            any_text_sent: false,
            placeholder_id: None,
            first_content_sent: false,
            last_block_text: String::new(),
            stream_id: None,
            sequence: 0,
            reply_dispatch_started: false,
            completed_session_id: None,
            is_done: false,
        }
    }
}

/// Per peer_session reply dispatcher. Maps requestId → slot, processes events
/// from /api/im/events, calls adapter to render content. Owned by ImEventConsumer.
pub struct ReplyRouter {
    slots: HashMap<String, ReplySlot>,
    pending_approvals: PendingApprovals,
    pending_questions: PendingQuestions,
}

impl ReplyRouter {
    pub(crate) fn new(
        pending_approvals: PendingApprovals,
        pending_questions: PendingQuestions,
    ) -> Self {
        Self {
            slots: HashMap::new(),
            pending_approvals,
            pending_questions,
        }
    }

    /// Pre-register a slot when /api/im/enqueue accepts the request.
    /// If a slot already exists (rare race — re-enqueue), it's preserved.
    pub(crate) fn register(
        &mut self,
        request_id: String,
        chat_id: String,
        message_id: String,
        source_type: ImSourceType,
        requester_user_id: Option<String>,
        group_ctx: Option<&GroupStreamContext>,
        delivery_protocol: Option<ImDeliveryProtocol>,
    ) {
        if self.slots.contains_key(&request_id) {
            return;
        }
        let group_activation_always = matches!(
            group_ctx.map(|g| &g.activation),
            Some(super::types::GroupActivation::Always),
        );
        let slot = ReplySlot::new(
            request_id.clone(),
            chat_id,
            message_id,
            source_type,
            requester_user_id,
            group_activation_always,
            delivery_protocol,
        );
        self.slots.insert(request_id, slot);
    }

    /// Dispatch a single event from /api/im/events to the matching slot.
    ///
    /// Returns `Some(TerminalOutcome)` when the slot reaches a terminal state
    /// (caller can use this to record session_id, etc.). Returns `None` when
    /// the slot stays alive. Post-stream hooks (ack_clear + post_stream_cleanup)
    /// fire automatically on terminal so callers don't repeat the dance.
    pub async fn dispatch<A: ImStreamAdapter>(
        &mut self,
        event: &Value,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        // Bus events have shape: { seq, requestId, type, data, ts }
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // C7 fix: session-level events (requestId=null) MUST be handled before the
        // requestId-scoped routing below. The legacy code returned None on null
        // requestId, silently dropping `gap` (eviction / cross-generation reset)
        // and any future system-wide events the bus introduces.
        let request_id_opt = event.get("requestId").and_then(|v| v.as_str());
        if request_id_opt.is_none() || request_id_opt == Some("") {
            self.handle_session_event(event_type, event, adapter).await;
            return None;
        }
        let request_id = request_id_opt.unwrap().to_string();

        if !self.slots.contains_key(&request_id) {
            ulog_warn!(
                "[reply-router] Dropped event for unregistered requestId={} type={}",
                request_id,
                event_type,
            );
            return None;
        }

        let (chat_id, message_id, already_done) = {
            let slot = self.slots.get(&request_id).expect("checked above");
            (slot.chat_id.clone(), slot.message_id.clone(), slot.is_done)
        };
        if already_done {
            return None;
        }

        let uses_openclaw_reply = matches!(
            self.slots
                .get(&request_id)
                .and_then(|slot| slot.delivery_protocol.as_ref()),
            Some(ImDeliveryProtocol::OpenClawReply)
        );
        let outcome = if uses_openclaw_reply {
            self.dispatch_openclaw_reply(event_type, event, &request_id, adapter, sidecar_port)
                .await
        } else if adapter.supports_streaming() {
            self.dispatch_streaming(event_type, event, &request_id, adapter, sidecar_port)
                .await
        } else {
            self.dispatch_edit_based(event_type, event, &request_id, adapter, sidecar_port)
                .await
        };

        // Pattern C: terminal cleanup hooks. Fire AFTER inner dispatch completes
        // (slot is_done set, last edit/finalize already done) and BEFORE the
        // caller unregister + on_terminal callback runs. Keeps the protocol-
        // specific cleanup (DingTalk AI Card finalize) and ACK reaction clear
        // in one place — adapter calls can be retired later without touching
        // every call site.
        if outcome.is_some() {
            if !uses_openclaw_reply {
                adapter.post_stream_cleanup(&chat_id).await;
            }
            adapter::ImAdapter::ack_clear(adapter, &chat_id, &message_id).await;
        }

        outcome
    }

    async fn handle_question_request<A: ImStreamAdapter>(
        &mut self,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) {
        let Some(slot) = self.slots.get(request_id) else {
            return;
        };
        let raw = event.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let payload: AskUserQuestionPayload = match serde_json::from_str(raw) {
            Ok(payload) => payload,
            Err(e) => {
                ulog_warn!("[reply-router] Invalid AskUserQuestion payload: {}", e);
                return;
            }
        };
        let question_request_id = payload.request_id.clone();
        let chat_id = slot.chat_id.clone();
        let requester_user_id = slot.requester_user_id.clone();
        let source_type = slot.source_type.clone();

        if payload.questions.iter().any(|q| q.is_secret) {
            let _ = adapter
                .send_message(
                    &chat_id,
                    "本次提问包含敏感输入，IM 渠道暂不支持安全收集，已自动取消。请在桌面端继续，或改用非敏感文本。",
                )
                .await;
            let url = format!(
                "http://127.0.0.1:{}/api/ask-user-question/respond",
                sidecar_port
            );
            match crate::local_http::json_client(Duration::from_secs(30))
                .post(&url)
                .json(&json!({
                    "requestId": question_request_id,
                    "answers": Value::Null,
                }))
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    match resp.json::<Value>().await {
                        Ok(body)
                            if status.is_success()
                                && body.get("success").and_then(Value::as_bool) == Some(true) =>
                        {
                            ulog_info!(
                                "[reply-router] AskUserQuestion secret request cancelled: rid={}",
                                &payload.request_id[..payload.request_id.len().min(16)]
                            );
                        }
                        Ok(body) => {
                            ulog_error!(
                                "[reply-router] AskUserQuestion secret cancel failed: HTTP {} body={}",
                                status,
                                body
                            );
                        }
                        Err(e) => {
                            ulog_error!(
                                "[reply-router] AskUserQuestion secret cancel returned invalid JSON: {}",
                                e
                            );
                        }
                    }
                }
                Err(e) => {
                    ulog_error!("[reply-router] AskUserQuestion secret cancel error: {}", e);
                }
            }
            return;
        }

        let card_msg_id = match adapter
            .send_question_card(&chat_id, &payload, &source_type)
            .await
        {
            Ok(Some(mid)) => mid,
            Ok(None) => String::new(),
            Err(e) => {
                ulog_error!("[reply-router] Failed to send AskUserQuestion card: {}", e);
                return;
            }
        };
        {
            let mut guard = self.pending_questions.lock().await;
            let now = Instant::now();
            guard.retain(|_, p| now.duration_since(p.created_at) < Duration::from_secs(15 * 60));
            guard.insert(
                question_request_id,
                PendingQuestion {
                    sidecar_port,
                    chat_id,
                    card_message_id: card_msg_id,
                    requester_user_id,
                    source_type,
                    questions: payload.questions,
                    created_at: now,
                },
            );
        }
    }

    async fn handle_question_expired<A: ImStreamAdapter>(&mut self, event: &Value, adapter: &A) {
        let raw = event.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let question_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
        if question_request_id.is_empty() {
            return;
        }
        let pending = self
            .pending_questions
            .lock()
            .await
            .remove(&question_request_id);
        if let Some(p) = pending {
            if !p.card_message_id.is_empty() {
                let _ = adapter
                    .update_question_status(&p.chat_id, &p.card_message_id, "expired")
                    .await;
            }
        }
    }

    async fn dispatch_edit_based<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        match event_type {
            // Bus emits 'delta' (per-token streaming text). The accumulated text
            // arrives via separate state — the legacy SSE protocol used 'partial'
            // with full text. Bus events deliver the delta only; we accumulate.
            "delta" => {
                let chunk = data.and_then(|v| v.as_str()).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);

                // First meaningful text → create draft message (if adapter supports edit)
                if adapter.supports_edit()
                    && slot.draft_id.is_none()
                    && !slot.block_text.trim().is_empty()
                    && has_sentence_boundary(&slot.block_text)
                {
                    let display = format_draft_text(&slot.block_text, adapter.max_message_length());
                    if let Ok(Some(id)) =
                        adapter.send_message_returning_id(&chat_id, &display).await
                    {
                        slot.draft_id = Some(id);
                        slot.last_edit = Instant::now();
                    }
                    slot.first_content_sent = true;
                }

                // Throttled edit
                if let Some(ref did) = slot.draft_id {
                    let throttle = Duration::from_millis(adapter.preferred_throttle_ms());
                    if slot.last_edit.elapsed() >= throttle {
                        slot.last_edit = Instant::now();
                        let display =
                            format_draft_text(&slot.block_text, adapter.max_message_length());
                        let _ = adapter.edit_message(&chat_id, did, &display).await;
                    }
                }
                None
            }

            "block-end" => {
                // Producer (agent-session.ts) emits `block-end` with `data: ''`
                // (no payload — the SDK's content_block_stop carries no text).
                // Empty `data` means "use the slot's accumulated text"; the
                // legacy `unwrap_or_else` fallback only fired on `None`, so
                // `Some("")` slipped through as `final_text = ""` → trim empty
                // → abort_stream (which renders `[Aborted]` on Feishu lark
                // streaming sessions). Treat empty string as "not provided".
                let final_text = data
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| slot.block_text.clone());
                if final_text.trim().is_empty() {
                    if let Some(ref did) = slot.draft_id {
                        let _ = adapter.delete_message(&chat_id, did).await;
                    }
                } else {
                    finalize_block(adapter, &chat_id, slot.draft_id.clone(), &final_text).await;
                    slot.any_text_sent = true;
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.draft_id = None;
                None
            }

            "complete" => {
                // C5 fix: bus emits 'complete' with `data` = the SDK's result text
                // (legacy 'partial-then-complete' would carry the result string),
                // NOT a session_id. The session_id for record_response is taken from
                // the peer_session, not from the event payload. Returning None here
                // tells the caller "use the existing peer_session_id".
                let trimmed_last = slot.last_block_text.trim();
                let is_no_reply = (slot.group_activation_always
                    || matches!(slot.source_type, ImSourceType::Group))
                    && (trimmed_last == "<NO_REPLY>" || trimmed_last == "NO_REPLY");

                if is_no_reply {
                    if let Some(ref did) = slot.draft_id {
                        let _ = adapter.delete_message(&chat_id, did).await;
                    }
                    if let Some(ref pid) = slot.placeholder_id {
                        let _ = adapter.delete_message(&chat_id, pid).await;
                    }
                    slot.is_done = true;
                    return Some(TerminalOutcome {
                        session_id: None,
                        silent: true,
                    });
                }

                // Flush any remaining block text
                if !slot.block_text.trim().is_empty() {
                    finalize_block(
                        adapter,
                        &chat_id,
                        slot.draft_id.clone(),
                        &slot.block_text.clone(),
                    )
                    .await;
                    slot.any_text_sent = true;
                } else if let Some(ref did) = slot.draft_id {
                    let _ = adapter.delete_message(&chat_id, did).await;
                }
                if !slot.any_text_sent {
                    if let Some(ref pid) = slot.placeholder_id {
                        if adapter
                            .edit_message(&chat_id, pid, "(No response)")
                            .await
                            .is_err()
                        {
                            let _ = adapter.delete_message(&chat_id, pid).await;
                            let _ = adapter.send_message(&chat_id, "(No response)").await;
                        }
                    } else {
                        let _ = adapter.send_message(&chat_id, "(No response)").await;
                    }
                }
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            "ask-user-question-request" => {
                self.handle_question_request(event, request_id, adapter, sidecar_port)
                    .await;
                None
            }

            "ask-user-question-expired" => {
                self.handle_question_expired(event, adapter).await;
                None
            }

            "permission-request" => {
                let raw = data.and_then(|v| v.as_str()).unwrap_or("");
                let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
                let perm_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
                let tool_name = json_payload["toolName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                let tool_input_str = match json_payload["input"] {
                    Value::String(ref s) => s.clone(),
                    Value::Null => String::new(),
                    ref other => serde_json::to_string(other).unwrap_or_default(),
                };
                ulog_info!(
                    "[reply-router] Permission request: tool={}, rid={}",
                    tool_name,
                    &perm_request_id[..perm_request_id.len().min(16)],
                );
                let card_msg_id = match adapter
                    .send_approval_card(&chat_id, &perm_request_id, &tool_name, &tool_input_str)
                    .await
                {
                    Ok(Some(mid)) => mid,
                    Ok(None) => String::new(),
                    Err(e) => {
                        ulog_error!("[reply-router] Failed to send approval card: {}", e);
                        String::new()
                    }
                };
                {
                    let mut guard = self.pending_approvals.lock().await;
                    let now = Instant::now();
                    guard.retain(|_, p| {
                        now.duration_since(p.created_at) < Duration::from_secs(15 * 60)
                    });
                    guard.insert(
                        perm_request_id,
                        PendingApproval {
                            sidecar_port,
                            chat_id: chat_id.clone(),
                            card_message_id: card_msg_id,
                            created_at: now,
                        },
                    );
                }
                None
            }

            "activity" => {
                // Non-text block (thinking / tool_use). Show placeholder if user
                // hasn't seen any content yet.
                if !slot.first_content_sent && slot.placeholder_id.is_none() {
                    if let Ok(Some(id)) = adapter
                        .send_message_returning_id(&chat_id, THINKING_PLACEHOLDER)
                        .await
                    {
                        slot.placeholder_id = Some(id);
                    }
                    slot.first_content_sent = true;
                }
                None
            }

            "error" | "cancelled" => {
                let msg = terminal_text(data).unwrap_or("Unknown error");
                if let Some(ref did) = slot.draft_id {
                    let _ = adapter.delete_message(&chat_id, did).await;
                }
                if let Some(ref pid) = slot.placeholder_id {
                    let _ = adapter.delete_message(&chat_id, pid).await;
                }
                // W4 fix: cancel reason ('user' / 'timeout' / etc.) is an internal
                // CancelReason enum string — never surface it raw to chat. Show a
                // localized line; reason stays in logs.
                let user_msg = if event_type == "cancelled" {
                    "🛑 已取消".to_string()
                } else {
                    format!("⚠️ {}", msg)
                };
                let _ = adapter.send_message(&chat_id, &user_msg).await;
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            _ => None, // unknown event type — ignore
        }
    }

    async fn dispatch_openclaw_reply<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        // Interactive cards remain ordinary adapter operations. They do not
        // participate in the reply snapshot/final transport.
        if matches!(
            event_type,
            "ask-user-question-request" | "ask-user-question-expired" | "permission-request"
        ) {
            return self
                .dispatch_edit_based(event_type, event, request_id, adapter, sidecar_port)
                .await;
        }

        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        if !slot.reply_dispatch_started {
            if let Err(error) = adapter.start_reply_dispatch(request_id).await {
                ulog_error!(
                    "[reply-router] OpenClaw run start failed requestId={}: {}",
                    request_id,
                    error
                );
                // A reply-operation admission failure means the process-scoped
                // plugin owner is absent (connection failure) or no longer has
                // this request (protocol_dispatch_missing). Retaining the Rust
                // slot cannot recreate that owner and would only leak it.
                slot.is_done = true;
                return Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                });
            }
            slot.reply_dispatch_started = true;
        }

        match event_type {
            "delta" => {
                let chunk = data.and_then(Value::as_str).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);
                if let Some(stream_id) = slot.stream_id.as_deref() {
                    slot.sequence += 1;
                    if let Err(error) = adapter
                        .update_reply_stream(stream_id, &slot.block_text, slot.sequence, false)
                        .await
                    {
                        ulog_error!(
                            "[reply-router] OpenClaw partial handoff failed requestId={} streamId={}: {}",
                            request_id,
                            stream_id,
                            error
                        );
                    }
                } else {
                    match adapter
                        .start_reply_stream(request_id, &chat_id, &slot.block_text)
                        .await
                    {
                        Ok(stream_id) if !stream_id.is_empty() => {
                            slot.stream_id = Some(stream_id);
                            slot.sequence = 1;
                        }
                        Ok(_) => ulog_error!(
                            "[reply-router] OpenClaw start stream returned empty ID requestId={}",
                            request_id
                        ),
                        Err(error) => ulog_error!(
                            "[reply-router] OpenClaw start stream failed requestId={}: {}",
                            request_id,
                            error
                        ),
                    }
                }
                None
            }

            "block-end" => {
                if let Some(stream_id) = slot.stream_id.take() {
                    if let Err(error) = adapter.finish_reply_stream_block(&stream_id).await {
                        ulog_error!(
                            "[reply-router] OpenClaw block barrier failed requestId={} streamId={}: {}",
                            request_id,
                            stream_id,
                            error
                        );
                    }
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.sequence = 0;
                None
            }

            "complete" => {
                let final_payloads = data
                    .and_then(|value| value.get("finalPayloads"))
                    .filter(|value| value.is_array())
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new()));
                let silent = slot.group_activation_always
                    && final_payloads.as_array().is_some_and(|payloads| {
                        payloads.iter().any(|payload| {
                            matches!(
                                payload.get("text").and_then(Value::as_str).map(str::trim),
                                Some("<NO_REPLY>" | "NO_REPLY")
                            )
                        })
                    });
                if let Err(error) = adapter
                    .complete_reply_dispatch(request_id, &final_payloads)
                    .await
                {
                    ulog_error!(
                        "[reply-router] OpenClaw complete handoff failed requestId={}: {}",
                        request_id,
                        error
                    );
                }
                // The Bridge endpoint ACKs queue admission synchronously. On
                // failure there is no reachable pending dispatcher to retry or
                // settle, so local terminal cleanup remains authoritative.
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent,
                })
            }

            "error" | "cancelled" => {
                let terminal_payload = data
                    .and_then(|value| value.get("finalPayloads"))
                    .and_then(Value::as_array)
                    .and_then(|payloads| payloads.first())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if let Err(error) = adapter
                    .abort_reply_dispatch(request_id, event_type, &terminal_payload)
                    .await
                {
                    ulog_error!(
                        "[reply-router] OpenClaw abort handoff failed requestId={}: {}",
                        request_id,
                        error
                    );
                }
                // See the complete branch: keeping the local slot cannot
                // recover a process-scoped plugin dispatch owner.
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            "activity" => None,
            _ => None,
        }
    }

    async fn dispatch_streaming<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        match event_type {
            "delta" => {
                let chunk = data.and_then(|v| v.as_str()).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);

                if slot.stream_id.is_none()
                    && !slot.block_text.trim().is_empty()
                    && has_sentence_boundary(&slot.block_text)
                {
                    if let Ok(sid) = adapter.start_stream(&chat_id, &slot.block_text).await {
                        if !sid.is_empty() {
                            slot.stream_id = Some(sid);
                            slot.sequence = 1;
                            slot.any_text_sent = true;
                            slot.first_content_sent = true;
                        }
                    }
                } else if let Some(ref sid) = slot.stream_id {
                    slot.sequence += 1;
                    let _ = adapter
                        .stream_chunk(&chat_id, sid, &slot.block_text, slot.sequence, false)
                        .await;
                }
                None
            }

            "activity" => {
                if let Some(ref sid) = slot.stream_id {
                    slot.sequence += 1;
                    let _ = adapter
                        .stream_chunk(&chat_id, sid, "", slot.sequence, true)
                        .await;
                } else if !slot.first_content_sent {
                    if let Ok(Some(id)) = adapter
                        .send_message_returning_id(&chat_id, THINKING_PLACEHOLDER)
                        .await
                    {
                        slot.placeholder_id = Some(id);
                    }
                    slot.first_content_sent = true;
                }
                None
            }

            "block-end" => {
                // Same fallback semantics as the edit-based path: producer
                // emits `block-end` with empty `data` — fall back to the slot
                // accumulator. Without this filter, every block-end aborted
                // the active stream → Feishu lark card showed `[Aborted]`.
                let final_text = data
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| slot.block_text.clone());
                if !final_text.trim().is_empty() {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter.finalize_stream(&chat_id, sid, &final_text).await;
                        slot.any_text_sent = true;
                    } else {
                        let _ = adapter.send_message(&chat_id, &final_text).await;
                        slot.any_text_sent = true;
                    }
                } else if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.stream_id = None;
                slot.sequence = 0;
                None
            }

            "complete" => {
                // C5 fix: see edit-based path. session_id NOT taken from event payload.
                let trimmed_last = slot.last_block_text.trim();
                let is_no_reply = slot.group_activation_always
                    && (trimmed_last == "<NO_REPLY>" || trimmed_last == "NO_REPLY");
                if is_no_reply {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter.abort_stream(&chat_id, sid).await;
                    }
                    if let Some(ref pid) = slot.placeholder_id {
                        let _ = adapter.delete_message(&chat_id, pid).await;
                    }
                    slot.is_done = true;
                    return Some(TerminalOutcome {
                        session_id: None,
                        silent: true,
                    });
                }

                if !slot.block_text.trim().is_empty() {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter
                            .finalize_stream(&chat_id, sid, &slot.block_text.clone())
                            .await;
                    } else {
                        let _ = adapter
                            .send_message(&chat_id, &slot.block_text.clone())
                            .await;
                    }
                    slot.any_text_sent = true;
                } else if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                if !slot.any_text_sent {
                    if let Some(ref pid) = slot.placeholder_id {
                        if adapter
                            .edit_message(&chat_id, pid, "(No response)")
                            .await
                            .is_err()
                        {
                            let _ = adapter.delete_message(&chat_id, pid).await;
                            let _ = adapter.send_message(&chat_id, "(No response)").await;
                        }
                    } else {
                        let _ = adapter.send_message(&chat_id, "(No response)").await;
                    }
                }
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            "ask-user-question-request" => {
                self.handle_question_request(event, request_id, adapter, sidecar_port)
                    .await;
                None
            }

            "ask-user-question-expired" => {
                self.handle_question_expired(event, adapter).await;
                None
            }

            "permission-request" => {
                // Same as edit-based path
                let raw = data.and_then(|v| v.as_str()).unwrap_or("");
                let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
                let perm_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
                let tool_name = json_payload["toolName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                let tool_input_str = match json_payload["input"] {
                    Value::String(ref s) => s.clone(),
                    Value::Null => String::new(),
                    ref other => serde_json::to_string(other).unwrap_or_default(),
                };
                let card_msg_id = adapter
                    .send_approval_card(&chat_id, &perm_request_id, &tool_name, &tool_input_str)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                {
                    let mut guard = self.pending_approvals.lock().await;
                    let now = Instant::now();
                    guard.retain(|_, p| {
                        now.duration_since(p.created_at) < Duration::from_secs(15 * 60)
                    });
                    guard.insert(
                        perm_request_id,
                        PendingApproval {
                            sidecar_port,
                            chat_id: chat_id.clone(),
                            card_message_id: card_msg_id,
                            created_at: now,
                        },
                    );
                }
                None
            }

            "error" | "cancelled" => {
                let msg = terminal_text(data).unwrap_or("Unknown error");
                if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                if let Some(ref pid) = slot.placeholder_id {
                    let _ = adapter.delete_message(&chat_id, pid).await;
                }
                // W4 fix: cancel reason ('user' / 'timeout' / etc.) is an internal
                // CancelReason enum string — never surface it raw to chat. Show a
                // localized line; reason stays in logs.
                let user_msg = if event_type == "cancelled" {
                    "🛑 已取消".to_string()
                } else {
                    format!("⚠️ {}", msg)
                };
                let _ = adapter.send_message(&chat_id, &user_msg).await;
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            _ => None,
        }
    }

    /// Handle bus session-level events (requestId=null) — primarily `gap`
    /// (ImEventBus ring eviction or cross-generation reset). Currently
    /// surfaces a single user-visible warning to ALL active slots when a gap
    /// is observed; in practice IM volumes don't trigger eviction often.
    async fn handle_session_event<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        adapter: &A,
    ) {
        if event_type != "gap" {
            return; // unknown session-level event — ignore
        }
        let dropped_seqs = event
            .get("data")
            .and_then(|d| d.get("droppedSeqs"))
            .and_then(|s| s.as_array())
            .and_then(|arr| {
                let lo = arr.first().and_then(|v| v.as_u64())?;
                let hi = arr.get(1).and_then(|v| v.as_u64())?;
                Some((lo, hi))
            });
        let reason = event
            .get("data")
            .and_then(|d| d.get("reason"))
            .and_then(|r| r.as_str())
            .unwrap_or("eviction");
        let affected_request_ids: Option<std::collections::HashSet<String>> = event
            .get("data")
            .and_then(|d| d.get("requestIds"))
            .and_then(|ids| ids.as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(ToString::to_string))
                    .collect()
            });
        ulog_warn!(
            "[reply-router] gap event observed reason={} dropped={:?} active_slots={}",
            reason,
            dropped_seqs,
            self.slots.len(),
        );
        // For each active slot, surface a one-line warning so the user
        // doesn't see partial replies as truthful complete content. Skip
        // already-done slots (their UI is finalized).
        let chat_ids: Vec<String> = self
            .slots
            .iter()
            .filter(|(request_id, slot)| {
                !slot.is_done
                    && affected_request_ids
                        .as_ref()
                        .map_or(true, |ids| ids.contains(request_id.as_str()))
            })
            .map(|(_, slot)| slot.chat_id.clone())
            .collect();
        if chat_ids.is_empty() {
            return;
        }
        let prefix = if reason == "session-reset" {
            "⚠️ 会话已重置，部分回复未送达"
        } else {
            "⚠️ 部分流式内容丢失（事件队列溢出）"
        };
        // De-dup chat_ids — multiple slots in the same chat get one warning each.
        let mut seen = std::collections::HashSet::new();
        for chat_id in chat_ids {
            if seen.insert(chat_id.clone()) {
                let _ = adapter.send_message(&chat_id, prefix).await;
            }
        }
    }

    /// Drop a slot after handling its terminal event. Caller invokes after
    /// processing TerminalOutcome.
    pub fn unregister(&mut self, request_id: &str) {
        self.slots.remove(request_id);
    }

    /// Diagnostic.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

/// Returned by `dispatch` when a slot reaches a terminal state.
#[derive(Debug)]
pub struct TerminalOutcome {
    /// Sidecar's session_id from the 'complete' event payload, if any.
    pub session_id: Option<String>,
    /// Group "always" mode NO_REPLY → don't surface to the user (silent close).
    pub silent: bool,
}

/// Thin wrapper enabling sharing a `ReplyRouter` across `ImEventConsumer`
/// reconnect cycles via Arc<Mutex<...>>. Each `dispatch` call is brief
/// (one event), so contention is negligible.
pub type SharedReplyRouter = Arc<Mutex<ReplyRouter>>;

pub(crate) fn shared_router(
    pending_approvals: PendingApprovals,
    pending_questions: PendingQuestions,
) -> SharedReplyRouter {
    Arc::new(Mutex::new(ReplyRouter::new(
        pending_approvals,
        pending_questions,
    )))
}

// Allow `adapter` module to be referenced — keeps cargo check happy if no other
// reference exists in this file (currently used via type imports above).
#[allow(unused_imports)]
use adapter::ImStreamAdapter as _ImStreamAdapter;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};

    use serde_json::json;

    use super::ReplyRouter;
    use crate::im::adapter::{AdapterResult, ImAdapter, ImStreamAdapter};
    use crate::im::types::{AskUserQuestionPayload, ImDeliveryProtocol, ImSourceType};

    #[derive(Default)]
    struct RecordingAdapter {
        sent_messages: StdMutex<Vec<(String, String)>>,
        reply_operations: StdMutex<Vec<serde_json::Value>>,
    }

    impl RecordingAdapter {
        fn sent_messages(&self) -> Vec<(String, String)> {
            self.sent_messages.lock().unwrap().clone()
        }

        fn reply_operations(&self) -> Vec<serde_json::Value> {
            self.reply_operations.lock().unwrap().clone()
        }
    }

    impl ImAdapter for RecordingAdapter {
        async fn verify_connection(&self) -> AdapterResult<String> {
            Ok("test".to_string())
        }

        async fn register_commands(&self) -> AdapterResult<()> {
            Ok(())
        }

        async fn listen_loop(&self, _shutdown_rx: tokio::sync::watch::Receiver<bool>) {}

        async fn send_message(&self, chat_id: &str, text: &str) -> AdapterResult<()> {
            self.sent_messages
                .lock()
                .unwrap()
                .push((chat_id.to_string(), text.to_string()));
            Ok(())
        }

        async fn ack_received(&self, _chat_id: &str, _message_id: &str) {}

        async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {}

        async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {}

        async fn send_typing(&self, _chat_id: &str) {}
    }

    impl ImStreamAdapter for RecordingAdapter {
        async fn send_message_returning_id(
            &self,
            chat_id: &str,
            text: &str,
        ) -> AdapterResult<Option<String>> {
            self.send_message(chat_id, text).await?;
            Ok(Some("sent-id".to_string()))
        }

        async fn edit_message(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _text: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn delete_message(&self, _chat_id: &str, _message_id: &str) -> AdapterResult<()> {
            Ok(())
        }

        fn max_message_length(&self) -> usize {
            4096
        }

        async fn send_approval_card(
            &self,
            _chat_id: &str,
            _request_id: &str,
            _tool_name: &str,
            _tool_input: &str,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("approval-id".to_string()))
        }

        async fn update_approval_status(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _status: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn send_question_card(
            &self,
            _chat_id: &str,
            _payload: &AskUserQuestionPayload,
            _source_type: &ImSourceType,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("question-id".to_string()))
        }

        async fn update_question_status(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _status: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn send_photo(
            &self,
            _chat_id: &str,
            _data: Vec<u8>,
            _filename: &str,
            _caption: Option<&str>,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("photo-id".to_string()))
        }

        async fn send_file(
            &self,
            _chat_id: &str,
            _data: Vec<u8>,
            _filename: &str,
            _mime_type: &str,
            _caption: Option<&str>,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("file-id".to_string()))
        }

        async fn finalize_message(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _text: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn start_reply_dispatch(&self, request_id: &str) -> AdapterResult<()> {
            self.reply_operations
                .lock()
                .unwrap()
                .push(json!({ "kind": "start", "requestId": request_id }));
            Ok(())
        }

        async fn start_reply_stream(
            &self,
            request_id: &str,
            chat_id: &str,
            initial_text: &str,
        ) -> AdapterResult<String> {
            let stream_id = format!("stream-{}", self.reply_operations.lock().unwrap().len());
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "stream-start",
                "requestId": request_id,
                "chatId": chat_id,
                "text": initial_text,
                "streamId": stream_id,
            }));
            Ok(stream_id)
        }

        async fn update_reply_stream(
            &self,
            stream_id: &str,
            text: &str,
            sequence: u32,
            is_thinking: bool,
        ) -> AdapterResult<()> {
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "partial",
                "streamId": stream_id,
                "text": text,
                "sequence": sequence,
                "isThinking": is_thinking,
            }));
            Ok(())
        }

        async fn finish_reply_stream_block(&self, stream_id: &str) -> AdapterResult<()> {
            self.reply_operations
                .lock()
                .unwrap()
                .push(json!({ "kind": "block-boundary", "streamId": stream_id }));
            Ok(())
        }

        async fn complete_reply_dispatch(
            &self,
            request_id: &str,
            final_payloads: &serde_json::Value,
        ) -> AdapterResult<()> {
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "complete",
                "requestId": request_id,
                "finalPayloads": final_payloads,
            }));
            Ok(())
        }

        async fn abort_reply_dispatch(
            &self,
            request_id: &str,
            reason: &str,
            terminal_payload: &serde_json::Value,
        ) -> AdapterResult<()> {
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "abort",
                "requestId": request_id,
                "reason": reason,
                "terminalPayload": terminal_payload,
            }));
            Ok(())
        }
    }

    #[tokio::test]
    async fn ask_user_question_request_registers_pending_question_by_inner_id() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(
            Arc::clone(&pending_approvals),
            Arc::clone(&pending_questions),
        );
        router.register(
            "turn-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            Some("user-1".to_string()),
            None,
            None,
        );
        let adapter = RecordingAdapter::default();

        router
            .dispatch(
                &json!({
                    "seq": 1,
                    "requestId": "turn-1",
                    "type": "ask-user-question-request",
                    "data": serde_json::to_string(&json!({
                        "requestId": "ask-1",
                        "questions": [{
                            "id": "choice",
                            "header": "Choice",
                            "question": "Pick one",
                            "options": [{ "label": "A", "description": "" }],
                            "multiSelect": false
                        }],
                        "previewFormat": "html"
                    })).unwrap(),
                    "ts": 0
                }),
                &adapter,
                4321,
            )
            .await;

        let guard = pending_questions.lock().await;
        let pending = guard
            .get("ask-1")
            .expect("question is tracked by inner request id");
        assert_eq!(pending.sidecar_port, 4321);
        assert_eq!(pending.chat_id, "chat-1");
        assert_eq!(pending.requester_user_id.as_deref(), Some("user-1"));
        assert!(!guard.contains_key("turn-1"));
    }

    #[tokio::test]
    async fn scoped_gap_warns_only_affected_active_slots() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "active-request".to_string(),
            "chat-active".to_string(),
            "msg-active".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        router.register(
            "other-request".to_string(),
            "chat-other".to_string(),
            "msg-other".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        let adapter = RecordingAdapter::default();

        router
            .dispatch(
                &json!({
                    "seq": 1,
                    "requestId": null,
                    "type": "gap",
                    "data": {
                        "droppedSeqs": [1, 42],
                        "requestIds": ["other-request"]
                    },
                    "ts": 0
                }),
                &adapter,
                0,
            )
            .await;

        assert_eq!(
            adapter.sent_messages(),
            vec![(
                "chat-other".to_string(),
                "⚠️ 部分流式内容丢失（事件队列溢出）".to_string(),
            )],
        );
    }

    #[tokio::test]
    async fn openclaw_reply_uses_request_protocol_and_keeps_block_boundary_non_terminal() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply),
        );
        let adapter = RecordingAdapter::default();

        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "delta", "data": "first" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "block-end", "data": "" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        assert_eq!(router.slot_count(), 1);
        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "delta", "data": "second" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "complete",
                    "data": { "finalPayloads": [{ "text": "canonical final" }] }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(adapter.sent_messages(), Vec::<(String, String)>::new());
        assert_eq!(
            adapter.reply_operations(),
            vec![
                json!({ "kind": "start", "requestId": "request-1" }),
                json!({
                    "kind": "stream-start",
                    "requestId": "request-1",
                    "chatId": "chat-1",
                    "text": "first",
                    "streamId": "stream-1"
                }),
                json!({ "kind": "block-boundary", "streamId": "stream-1" }),
                json!({
                    "kind": "stream-start",
                    "requestId": "request-1",
                    "chatId": "chat-1",
                    "text": "second",
                    "streamId": "stream-3"
                }),
                json!({
                    "kind": "complete",
                    "requestId": "request-1",
                    "finalPayloads": [{ "text": "canonical final" }]
                }),
            ]
        );
    }

    #[tokio::test]
    async fn openclaw_reply_abort_forwards_only_the_producer_terminal_payload() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply),
        );
        let adapter = RecordingAdapter::default();

        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "error",
                    "data": {
                        "finalPayloads": [{ "text": "safe error", "isError": true }]
                    }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(
            adapter.reply_operations(),
            vec![
                json!({ "kind": "start", "requestId": "request-1" }),
                json!({
                    "kind": "abort",
                    "requestId": "request-1",
                    "reason": "error",
                    "terminalPayload": { "text": "safe error", "isError": true }
                }),
            ]
        );
    }

    #[tokio::test]
    async fn native_adapter_reads_error_text_from_typed_terminal_payload() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        let adapter = RecordingAdapter::default();

        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "error",
                    "data": {
                        "finalPayloads": [{ "text": "safe error", "isError": true }]
                    }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(
            adapter.sent_messages(),
            vec![("chat-1".to_string(), "⚠️ safe error".to_string())]
        );
    }
}
