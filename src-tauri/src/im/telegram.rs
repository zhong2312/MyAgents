// Telegram Bot API adapter
// Handles long-polling, message sending (split + markdown fallback), ACK reactions,
// MessageCoalescer (fragment merging + debounce), and rate limit handling.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, Instant};

use super::types::{
    GroupEvent, ImAttachment, ImAttachmentType, ImConfig, ImMessage, ImPlatform, ImSourceType,
    TelegramError,
};
use super::util::{mime_to_ext, sanitize_filename};
use super::ApprovalCallback;
use crate::{proxy_config, ulog_debug, ulog_error, ulog_info, ulog_warn};

/// Telegram long-poll timeout (seconds)
const LONG_POLL_TIMEOUT: u64 = 30;
/// Max retries for transient errors before backing off
const MAX_TRANSIENT_RETRIES: u32 = 3;
/// Initial backoff for reconnect (seconds)
const INITIAL_BACKOFF_SECS: u64 = 1;
/// Max backoff for reconnect (seconds)
const MAX_BACKOFF_SECS: u64 = 30;

/// `reqwest::Error` Display output includes the request URL. Telegram embeds
/// the bot token in that URL, so transport errors must cross into product
/// errors as a bounded category rather than as the raw error chain.
fn safe_telegram_transport_error(context: &str, error: &reqwest::Error) -> TelegramError {
    if error.is_timeout() {
        return TelegramError::NetworkTimeout;
    }
    let category = if error.is_connect() {
        "connection error"
    } else if error.is_builder() {
        "invalid request"
    } else if error.is_request() {
        "request error"
    } else if error.is_body() {
        "response body error"
    } else if error.is_decode() {
        "response decode error"
    } else {
        "transport error"
    };
    TelegramError::Other(format!("{} failed: {}", context, category))
}

// MessageCoalescer constants
const DEFAULT_DEBOUNCE_MS: u64 = 500;
const DEFAULT_FRAGMENT_MERGE_MS: u64 = 1500;
const FRAGMENT_MIN_LENGTH: usize = 4000;
const MAX_FRAGMENTS: usize = 12;
const MAX_MERGED_LENGTH: usize = 50000;

/// Pending batch of messages being coalesced (only for fragment merging)
struct PendingBatch {
    fragments: Vec<String>,
    total_length: usize,
    #[allow(dead_code)]
    first_msg_id: i64,
    last_msg_id: i64,
    last_received: Instant,
    // Preserve sender metadata from the first fragment
    chat_id: String,
    sender_id: String,
    sender_name: Option<String>,
    source_type: ImSourceType,
    platform: ImPlatform,
    // OR'd across all fragments — true if ANY fragment had mention/reply-to-bot
    is_mention: bool,
    reply_to_bot: bool,
    hint_group_name: Option<String>,
    reply_to_body: Option<String>,
    group_system_prompt: Option<String>,
}

/// Merges fragmented messages (Telegram splits >4096 char pastes)
/// and debounces rapid consecutive messages from the same chat.
pub struct MessageCoalescer {
    pending: HashMap<String, PendingBatch>,
    debounce_ms: u64,
    fragment_merge_ms: u64,
}

impl MessageCoalescer {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            fragment_merge_ms: DEFAULT_FRAGMENT_MERGE_MS,
        }
    }

    /// Push a message. Returns a vec of messages ready to send.
    ///
    /// Non-fragment messages (< 4000 chars) are returned immediately — they
    /// bypass the pending buffer entirely. Only true fragments (Telegram's
    /// automatic splitting of long pastes, >= 4000 chars each) are buffered
    /// for merging.
    ///
    /// When a new message arrives and there's an existing pending batch,
    /// the old batch is flushed first, then the new message is either
    /// buffered (fragment) or returned immediately (non-fragment).
    pub fn push(&mut self, msg: &ImMessage) -> Vec<ImMessage> {
        let now = Instant::now();
        let is_fragment = msg.text.len() >= FRAGMENT_MIN_LENGTH;
        let chat_id = &msg.chat_id;
        let msg_id_i64 = msg.message_id.parse::<i64>().unwrap_or(0);
        let mut ready = Vec::new();

        if let Some(batch) = self.pending.get_mut(chat_id) {
            let time_since_last = now.duration_since(batch.last_received).as_millis() as u64;

            // Check if this is a continuation fragment
            let is_continuation = is_fragment
                && msg_id_i64 == batch.last_msg_id + 1
                && time_since_last < self.fragment_merge_ms;

            if is_continuation
                && batch.fragments.len() < MAX_FRAGMENTS
                && batch.total_length + msg.text.len() < MAX_MERGED_LENGTH
            {
                // Append to existing batch
                batch.total_length += msg.text.len();
                batch.fragments.push(msg.text.clone());
                batch.last_msg_id = msg_id_i64;
                batch.last_received = now;
                // OR mention flags: if any fragment has mention, the merged msg does too
                batch.is_mention = batch.is_mention || msg.is_mention;
                batch.reply_to_bot = batch.reply_to_bot || msg.reply_to_bot;
                if batch.hint_group_name.is_none() {
                    batch.hint_group_name = msg.hint_group_name.clone();
                }
                if batch.reply_to_body.is_none() {
                    batch.reply_to_body = msg.reply_to_body.clone();
                }
                if batch.group_system_prompt.is_none() {
                    batch.group_system_prompt = msg.group_system_prompt.clone();
                }
                return ready; // Still waiting for more fragments
            }

            // Not a continuation — flush the old batch
            if let Some(flushed) = self.flush_batch_to_msg(chat_id) {
                ready.push(flushed);
            }
        }

        if is_fragment {
            // Buffer: wait for more fragments before sending
            self.pending.insert(
                chat_id.to_string(),
                PendingBatch {
                    fragments: vec![msg.text.clone()],
                    total_length: msg.text.len(),
                    first_msg_id: msg_id_i64,
                    last_msg_id: msg_id_i64,
                    last_received: now,
                    chat_id: msg.chat_id.clone(),
                    sender_id: msg.sender_id.clone(),
                    sender_name: msg.sender_name.clone(),
                    source_type: msg.source_type.clone(),
                    platform: msg.platform.clone(),
                    is_mention: msg.is_mention,
                    reply_to_bot: msg.reply_to_bot,
                    hint_group_name: msg.hint_group_name.clone(),
                    reply_to_body: msg.reply_to_body.clone(),
                    group_system_prompt: msg.group_system_prompt.clone(),
                },
            );
        } else {
            // Non-fragment: return immediately, no debounce needed
            ready.push(msg.clone());
        }

        ready
    }

    /// Flush all batches that have exceeded the debounce timeout.
    /// Returns vec of ready-to-send ImMessages with correct sender metadata.
    pub fn flush_expired(&mut self) -> Vec<ImMessage> {
        let now = Instant::now();

        let expired_keys: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, batch)| {
                now.duration_since(batch.last_received).as_millis() as u64 >= self.debounce_ms
            })
            .map(|(k, _)| k.clone())
            .collect();

        let mut ready = Vec::new();
        for key in expired_keys {
            if let Some(flushed) = self.flush_batch_to_msg(&key) {
                ready.push(flushed);
            }
        }
        ready
    }

    /// Flush a pending batch, reconstructing a full ImMessage with stored metadata.
    fn flush_batch_to_msg(&mut self, chat_id: &str) -> Option<ImMessage> {
        self.pending.remove(chat_id).map(|batch| ImMessage {
            chat_id: batch.chat_id,
            message_id: batch.last_msg_id.to_string(),
            text: batch.fragments.join("\n"),
            sender_id: batch.sender_id,
            sender_name: batch.sender_name,
            account_id: None,
            source_type: batch.source_type,
            platform: batch.platform,
            timestamp: chrono::Utc::now(),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention: batch.is_mention,
            reply_to_bot: batch.reply_to_bot,
            hint_group_name: batch.hint_group_name,
            reply_to_body: batch.reply_to_body,
            group_system_prompt: batch.group_system_prompt,
            request_id: String::new(),
            delivery_protocol: None,
        })
    }
}

/// Telegram Bot API adapter
pub struct TelegramAdapter {
    bot_token: String,
    /// Shared mutable whitelist — updated from processing loop when a user binds via QR code.
    allowed_users: Arc<RwLock<Vec<String>>>,
    client: Client,
    message_tx: mpsc::Sender<ImMessage>,
    coalescer: Arc<Mutex<MessageCoalescer>>,
    bot_username: Arc<Mutex<Option<String>>>,
    /// Bot's numeric user ID (from getMe), used for reply-to-bot detection
    bot_user_id: Arc<Mutex<Option<i64>>>,
    /// Channel for forwarding approval callbacks from inline keyboard button clicks
    approval_tx: mpsc::Sender<ApprovalCallback>,
    /// Short ID → (full request_id, created_at) mapping (callback_data has 64 byte limit)
    short_id_map: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// Channel for group lifecycle events (bot added/removed from groups)
    group_event_tx: mpsc::Sender<GroupEvent>,
    /// Whether to use sendMessageDraft for streaming (experimental)
    use_message_draft: bool,
    /// Whether this adapter instance has fallen back to standard mode due to draft errors.
    /// AtomicBool avoids try_lock fragility and contention issues across concurrent streams.
    draft_fallback: Arc<std::sync::atomic::AtomicBool>,
}

impl TelegramAdapter {
    pub fn new(
        config: &ImConfig,
        message_tx: mpsc::Sender<ImMessage>,
        allowed_users: Arc<RwLock<Vec<String>>>,
        approval_tx: mpsc::Sender<ApprovalCallback>,
        group_event_tx: mpsc::Sender<GroupEvent>,
    ) -> Self {
        // External host (api.telegram.org) — system proxy wanted, not the
        // localhost guard.
        #[allow(clippy::disallowed_methods)]
        let client_builder = Client::builder().timeout(Duration::from_secs(LONG_POLL_TIMEOUT + 10));
        let client = proxy_config::build_client_with_proxy(client_builder).unwrap_or_else(|e| {
            ulog_warn!(
                "[telegram] Failed to build client with proxy: {}, falling back to direct",
                e
            );
            #[allow(clippy::disallowed_methods)]
            Client::builder()
                .timeout(Duration::from_secs(LONG_POLL_TIMEOUT + 10))
                .build()
                .expect("Failed to create HTTP client")
        });

        Self {
            bot_token: config.bot_token.clone(),
            allowed_users,
            client,
            message_tx,
            coalescer: Arc::new(Mutex::new(MessageCoalescer::new())),
            bot_username: Arc::new(Mutex::new(None)),
            bot_user_id: Arc::new(Mutex::new(None)),
            approval_tx,
            short_id_map: Arc::new(Mutex::new(HashMap::new())),
            group_event_tx,
            use_message_draft: config.telegram_use_draft.unwrap_or(true),
            draft_fallback: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Get the bot username (after getMe)
    pub async fn bot_username(&self) -> Option<String> {
        self.bot_username.lock().await.clone()
    }

    // ===== Telegram Bot API endpoints =====

    fn api_url(&self, method: &str) -> String {
        format!("https://api.telegram.org/bot{}/{}", self.bot_token, method)
    }

    /// Generic API call with rate limit and error handling
    async fn api_call(&self, method: &str, body: &Value) -> Result<Value, TelegramError> {
        let mut retries = 0;

        loop {
            let resp = self
                .client
                .post(&self.api_url(method))
                .json(body)
                .send()
                .await
                .map_err(|error| safe_telegram_transport_error("Telegram API request", &error))?;

            let status = resp.status();
            let body_text = resp
                .text()
                .await
                .map_err(|error| safe_telegram_transport_error("Telegram API response", &error))?;

            if status.as_u16() == 429 {
                // Rate limited
                let retry_after = serde_json::from_str::<Value>(&body_text)
                    .ok()
                    .and_then(|v| v["parameters"]["retry_after"].as_u64())
                    .unwrap_or(5);
                ulog_warn!(
                    "[telegram] Rate limited on {}, retry after {}s",
                    method,
                    retry_after
                );
                sleep(Duration::from_secs(retry_after)).await;
                continue;
            }

            let json: Value = serde_json::from_str(&body_text)
                .map_err(|e| TelegramError::Other(format!("JSON parse error: {}", e)))?;

            if json["ok"].as_bool() == Some(true) {
                return Ok(json["result"].clone());
            }

            // Handle specific error codes
            let description = json["description"].as_str().unwrap_or("");
            let error_code = json["error_code"].as_i64().unwrap_or(0);

            match error_code {
                400 if description.contains("can't parse entities") => {
                    return Err(TelegramError::MarkdownParseError);
                }
                400 if description.contains("message is not modified") => {
                    return Err(TelegramError::MessageNotModified);
                }
                400 if description.contains("MESSAGE_TOO_LONG") => {
                    return Err(TelegramError::MessageTooLong);
                }
                400 if description.contains("thread not found") => {
                    return Err(TelegramError::ThreadNotFound);
                }
                400 if description.contains("TEXTDRAFT_PEER_INVALID") => {
                    return Err(TelegramError::DraftPeerInvalid);
                }
                400 if description.contains("REACTION_INVALID")
                    || description.contains("REACTION_EMPTY") =>
                {
                    // Permanent error: emoji not available as reaction in this chat
                    ulog_debug!(
                        "[telegram] Reaction not available on {} (non-retryable): {}",
                        method,
                        description
                    );
                    return Err(TelegramError::Other(description.to_string()));
                }
                403 if description.contains("was kicked")
                    || description.contains("was blocked") =>
                {
                    return Err(TelegramError::BotKicked);
                }
                401 => {
                    return Err(TelegramError::TokenUnauthorized);
                }
                _ => {
                    retries += 1;
                    if retries >= MAX_TRANSIENT_RETRIES {
                        return Err(TelegramError::Other(format!(
                            "API error {}: {}",
                            error_code, description
                        )));
                    }
                    ulog_warn!(
                        "[telegram] Transient error on {} (attempt {}): {}",
                        method,
                        retries,
                        description
                    );
                    sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// Multipart API call for file uploads (sendPhoto, sendDocument).
    async fn api_call_multipart(
        &self,
        method: &str,
        form: reqwest::multipart::Form,
    ) -> Result<Value, TelegramError> {
        let resp = self
            .client
            .post(&self.api_url(method))
            .multipart(form)
            .send()
            .await
            .map_err(|error| safe_telegram_transport_error("Telegram API request", &error))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|error| safe_telegram_transport_error("Telegram API response", &error))?;

        if status.as_u16() == 429 {
            let retry_after = serde_json::from_str::<Value>(&body_text)
                .ok()
                .and_then(|v| v["parameters"]["retry_after"].as_u64())
                .unwrap_or(5);
            ulog_warn!(
                "[telegram] Rate limited on {}, retry after {}s",
                method,
                retry_after
            );
            sleep(Duration::from_secs(retry_after)).await;
            // Retry not possible (Form consumed), return error
            return Err(TelegramError::Other(format!("Rate limited on {}", method)));
        }

        let json: Value = serde_json::from_str(&body_text)
            .map_err(|e| TelegramError::Other(format!("JSON parse error: {}", e)))?;

        if json["ok"].as_bool() == Some(true) {
            return Ok(json["result"].clone());
        }

        let description = json["description"].as_str().unwrap_or("Unknown error");
        Err(TelegramError::Other(format!(
            "API error on {}: {}",
            method, description
        )))
    }

    /// Send a photo to a chat. Returns the sent message ID.
    pub async fn send_photo_media(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> Result<Option<i64>, TelegramError> {
        let mime = super::util::ext_to_mime(filename);
        let photo_part = reqwest::multipart::Part::bytes(data)
            .file_name(filename.to_string())
            .mime_str(mime)
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));

        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part("photo", photo_part);

        if let Some(cap) = caption {
            form = form.text("caption", cap.to_string());
        }

        let result = self.api_call_multipart("sendPhoto", form).await?;
        Ok(result["message_id"].as_i64())
    }

    /// Send a document/file to a chat. Returns the sent message ID.
    pub async fn send_document_media(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> Result<Option<i64>, TelegramError> {
        let doc_part = reqwest::multipart::Part::bytes(data)
            .file_name(filename.to_string())
            .mime_str(mime_type)
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));

        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part("document", doc_part);

        if let Some(cap) = caption {
            form = form.text("caption", cap.to_string());
        }

        let result = self.api_call_multipart("sendDocument", form).await?;
        Ok(result["message_id"].as_i64())
    }

    /// Verify bot token and get bot info
    pub async fn get_me(&self) -> Result<Value, TelegramError> {
        let result = self.api_call("getMe", &json!({})).await?;
        if let Some(username) = result["username"].as_str() {
            *self.bot_username.lock().await = Some(username.to_string());
        }
        if let Some(id) = result["id"].as_i64() {
            *self.bot_user_id.lock().await = Some(id);
        }
        Ok(result)
    }

    /// Register bot commands with Telegram
    pub async fn set_my_commands(&self) -> Result<(), TelegramError> {
        let commands = json!({
            "commands": [
                { "command": "new", "description": "开始新对话" },
                { "command": "model", "description": "查看或切换 AI 模型" },
                { "command": "provider", "description": "查看或切换 AI 供应商" },
                { "command": "mode", "description": "查看或切换权限模式" },
                { "command": "status", "description": "查看当前状态" },
                { "command": "help", "description": "查看所有命令" }
            ]
        });
        self.api_call("setMyCommands", &commands).await?;
        Ok(())
    }

    /// Get updates via long-polling
    async fn get_updates(&self, offset: i64) -> Result<Vec<Value>, TelegramError> {
        let body = json!({
            "offset": offset,
            "limit": 100,
            "timeout": LONG_POLL_TIMEOUT,
            "allowed_updates": ["message", "callback_query", "my_chat_member"]
        });
        let result = self.api_call("getUpdates", &body).await?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    /// Send message with Markdown, auto-split if needed
    pub async fn send_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> Result<Option<i64>, TelegramError> {
        let chunks = super::adapter::split_message(text, 4096);
        let total = chunks.len();
        let mut last_message_id = None;

        for (i, chunk) in chunks.iter().enumerate() {
            let decorated = if total == 1 {
                chunk.clone()
            } else if i < total - 1 {
                format!("{}\n\n_(continues…)_", chunk)
            } else {
                format!("_(continued)_\n\n{}", chunk)
            };

            last_message_id = Some(self.send_single_message(chat_id, &decorated).await?);
        }

        Ok(last_message_id)
    }

    /// Send a single message, trying Markdown first then falling back to plain text
    async fn send_single_message(&self, chat_id: &str, text: &str) -> Result<i64, TelegramError> {
        // Try Markdown first
        match self
            .api_call(
                "sendMessage",
                &json!({
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": "Markdown"
                }),
            )
            .await
        {
            Ok(result) => {
                return Ok(result["message_id"].as_i64().unwrap_or(0));
            }
            Err(TelegramError::MarkdownParseError) => {
                ulog_debug!("[telegram] Markdown parse failed, falling back to plain text");
            }
            Err(e) => return Err(e),
        }

        // Fallback to plain text
        let result = self
            .api_call(
                "sendMessage",
                &json!({
                    "chat_id": chat_id,
                    "text": text
                }),
            )
            .await?;
        Ok(result["message_id"].as_i64().unwrap_or(0))
    }

    /// Edit an existing message (for draft stream)
    pub async fn edit_message(
        &self,
        chat_id: &str,
        message_id: i64,
        text: &str,
    ) -> Result<(), TelegramError> {
        match self
            .api_call(
                "editMessageText",
                &json!({
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": text,
                    "parse_mode": "Markdown"
                }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(TelegramError::MarkdownParseError) => {
                // Retry without Markdown
                self.api_call(
                    "editMessageText",
                    &json!({
                        "chat_id": chat_id,
                        "message_id": message_id,
                        "text": text
                    }),
                )
                .await?;
                Ok(())
            }
            Err(TelegramError::MessageNotModified) => Ok(()), // Safe to ignore
            Err(e) => Err(e),
        }
    }

    /// Delete a message (for draft stream final split)
    pub async fn delete_message(
        &self,
        chat_id: &str,
        message_id: i64,
    ) -> Result<(), TelegramError> {
        self.api_call(
            "deleteMessage",
            &json!({
                "chat_id": chat_id,
                "message_id": message_id
            }),
        )
        .await?;
        Ok(())
    }

    /// Use sendMessageDraft to send/update a typing draft.
    /// On DraftPeerInvalid, sets draft_fallback = true for this adapter instance.
    async fn send_draft_update(
        &self,
        chat_id: &str,
        text: &str,
        draft_id: i64,
    ) -> Result<(), TelegramError> {
        use std::sync::atomic::Ordering;
        if self.draft_fallback.load(Ordering::Relaxed) {
            return Err(TelegramError::DraftPeerInvalid);
        }
        match self
            .api_call(
                "sendMessageDraft",
                &json!({
                    "chat_id": chat_id,
                    "text": text,
                    "draft_id": draft_id,
                    "parse_mode": "Markdown"
                }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(TelegramError::DraftPeerInvalid) => {
                self.draft_fallback.store(true, Ordering::Relaxed);
                Err(TelegramError::DraftPeerInvalid)
            }
            Err(TelegramError::MarkdownParseError) => {
                // Retry without Markdown parse_mode
                match self
                    .api_call(
                        "sendMessageDraft",
                        &json!({
                            "chat_id": chat_id,
                            "text": text,
                            "draft_id": draft_id
                        }),
                    )
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(TelegramError::DraftPeerInvalid) => {
                        self.draft_fallback.store(true, Ordering::Relaxed);
                        Err(TelegramError::DraftPeerInvalid)
                    }
                    Err(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Set reaction emoji on a message (ACK)
    pub async fn set_reaction(
        &self,
        chat_id: &str,
        message_id: i64,
        emoji: &str,
    ) -> Result<(), TelegramError> {
        let reaction = if emoji.is_empty() {
            json!([])
        } else {
            json!([{ "type": "emoji", "emoji": emoji }])
        };

        // Reactions may fail silently (bot permissions), don't propagate errors
        let _ = self
            .api_call(
                "setMessageReaction",
                &json!({
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "reaction": reaction
                }),
            )
            .await;
        Ok(())
    }

    /// ACK: message received (👀)
    pub async fn ack_received(&self, chat_id: &str, message_id: i64) {
        let _ = self.set_reaction(chat_id, message_id, "👀").await;
    }

    /// ACK: processing (⚡)
    pub async fn ack_processing(&self, chat_id: &str, message_id: i64) {
        let _ = self.set_reaction(chat_id, message_id, "⚡").await;
    }

    /// ACK: clear reaction
    pub async fn ack_clear(&self, chat_id: &str, message_id: i64) {
        let _ = self.set_reaction(chat_id, message_id, "").await;
    }

    /// Send "typing" chat action
    pub async fn send_typing(&self, chat_id: &str) {
        let _ = self
            .api_call(
                "sendChatAction",
                &json!({
                    "chat_id": chat_id,
                    "action": "typing"
                }),
            )
            .await;
    }

    // ===== Approval card operations =====

    /// Generate a short ID for callback_data (Telegram 64-byte limit).
    /// Stores the mapping for later resolution. Cleans up entries older than 15 minutes.
    async fn make_short_id(&self, full_id: &str) -> String {
        let short = &full_id[full_id.len().saturating_sub(8)..];
        let mut map = self.short_id_map.lock().await;
        // Periodic cleanup: remove entries older than 15 minutes (Sidecar times out at 10 min)
        let now = Instant::now();
        map.retain(|_, (_, created)| now.duration_since(*created) < Duration::from_secs(15 * 60));
        map.insert(short.to_string(), (full_id.to_string(), now));
        short.to_string()
    }

    /// Resolve a short ID back to the full request_id.
    async fn resolve_short_id(&self, short: &str) -> Option<String> {
        self.short_id_map
            .lock()
            .await
            .remove(short)
            .map(|(id, _)| id)
    }

    /// Send an approval message with inline keyboard buttons.
    pub async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> Result<Option<String>, TelegramError> {
        // Truncate input for display (char-boundary safe)
        let display_input = if tool_input.chars().count() > 200 {
            let end: usize = tool_input
                .char_indices()
                .nth(200)
                .map(|(i, _)| i)
                .unwrap_or(tool_input.len());
            format!("{}...", &tool_input[..end])
        } else {
            tool_input.to_string()
        };

        let short_id = self.make_short_id(request_id).await;
        let text = format!(
            "🔒 *工具使用请求*\n\n*工具*: `{}`\n*内容*: `{}`\n\n也可直接回复「允许」「始终允许」或「拒绝」",
            tool_name, display_input
        );

        let body = json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
            "reply_markup": {
                "inline_keyboard": [[
                    { "text": "✅ 允许", "callback_data": format!("pa:{}:ao", short_id) },
                    { "text": "✅ 始终允许", "callback_data": format!("pa:{}:aa", short_id) },
                    { "text": "❌ 拒绝", "callback_data": format!("pa:{}:d", short_id) }
                ]]
            }
        });

        match self.api_call("sendMessage", &body).await {
            Ok(result) => {
                let msg_id = result["message_id"].as_i64().unwrap_or(0);
                Ok(Some(msg_id.to_string()))
            }
            Err(TelegramError::MarkdownParseError) => {
                // Fallback without markdown
                let plain_text = format!(
                    "🔒 工具使用请求\n\n工具: {}\n内容: {}\n\n也可直接回复「允许」「始终允许」或「拒绝」",
                    tool_name, display_input
                );
                let body = json!({
                    "chat_id": chat_id,
                    "text": plain_text,
                    "reply_markup": {
                        "inline_keyboard": [[
                            { "text": "✅ 允许", "callback_data": format!("pa:{}:ao", short_id) },
                            { "text": "✅ 始终允许", "callback_data": format!("pa:{}:aa", short_id) },
                            { "text": "❌ 拒绝", "callback_data": format!("pa:{}:d", short_id) }
                        ]]
                    }
                });
                let result = self.api_call("sendMessage", &body).await?;
                let msg_id = result["message_id"].as_i64().unwrap_or(0);
                Ok(Some(msg_id.to_string()))
            }
            Err(e) => Err(e),
        }
    }

    /// Update an approval message to show resolved status (remove inline keyboard).
    pub async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> Result<(), TelegramError> {
        let (emoji, label) = if status == "denied" {
            ("❌", "已拒绝")
        } else {
            ("✅", "已允许")
        };

        let mid = message_id.parse::<i64>().unwrap_or(0);
        let _ = self
            .api_call(
                "editMessageText",
                &json!({
                    "chat_id": chat_id,
                    "message_id": mid,
                    "text": format!("🔒 工具使用请求 — {} {}", emoji, label),
                }),
            )
            .await;
        Ok(())
    }

    /// Process a callback_query update (inline keyboard button click).
    async fn process_callback_query(&self, update: &Value) -> Option<ApprovalCallback> {
        let cq = update.get("callback_query")?;
        let cq_id = cq["id"].as_str()?;
        let data = cq["data"].as_str()?;

        // Parse "pa:<short_id>:<action>"
        let parts: Vec<&str> = data.splitn(3, ':').collect();
        if parts.len() != 3 || parts[0] != "pa" {
            return None;
        }

        let request_id = self.resolve_short_id(parts[1]).await?;
        let decision = match parts[2] {
            "ao" => "allow_once",
            "aa" => "always_allow",
            "d" => "deny",
            _ => return None,
        }
        .to_string();

        // MUST answer callback query (otherwise button shows spinner)
        let answer_text = if decision == "deny" {
            "已拒绝"
        } else {
            "已允许"
        };
        let _ = self
            .api_call(
                "answerCallbackQuery",
                &json!({
                    "callback_query_id": cq_id,
                    "text": answer_text,
                }),
            )
            .await;

        let user_id = cq["from"]["id"].as_i64().unwrap_or(0).to_string();

        ulog_info!(
            "[telegram] Callback query: decision={}, rid={}",
            decision,
            &request_id[..request_id.len().min(16)]
        );
        Some(ApprovalCallback {
            request_id,
            decision,
            user_id,
        })
    }

    // ===== Long-polling loop =====

    /// Main listen loop — runs indefinitely, emitting ImMessages to message_tx.
    /// Handles reconnection with exponential backoff.
    pub async fn listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        let mut offset: i64 = 0;
        let mut backoff_secs = INITIAL_BACKOFF_SECS;

        ulog_info!("[telegram] Starting long-poll loop");

        loop {
            // Check shutdown signal
            if *shutdown_rx.borrow() {
                ulog_info!("[telegram] Shutdown signal received, stopping listen loop");
                break;
            }

            // Wrap getUpdates in select! so shutdown can interrupt the 30s long-poll
            let result = tokio::select! {
                result = self.get_updates(offset) => result,
                _ = shutdown_rx.changed() => {
                    ulog_info!("[telegram] Shutdown during long-poll, exiting");
                    break;
                }
            };

            match result {
                Ok(updates) => {
                    backoff_secs = INITIAL_BACKOFF_SECS; // Reset backoff on success

                    for update in updates {
                        // Update offset to acknowledge this update
                        if let Some(update_id) = update["update_id"].as_i64() {
                            offset = update_id + 1;
                        }

                        // Handle my_chat_member (bot added/removed from groups)
                        if let Some(event) = self.process_my_chat_member(&update) {
                            if self.group_event_tx.send(event).await.is_err() {
                                ulog_error!("[telegram] Group event channel closed");
                            }
                            continue;
                        }

                        // Handle callback_query (inline keyboard button clicks)
                        if let Some(cb) = self.process_callback_query(&update).await {
                            if self.approval_tx.send(cb).await.is_err() {
                                ulog_error!("[telegram] Approval channel closed");
                            }
                            continue;
                        }

                        if let Some(msg) = self.process_update(&update).await {
                            // Push through coalescer — returns messages ready to send
                            let ready_msgs = {
                                let mut coalescer = self.coalescer.lock().await;
                                coalescer.push(&msg)
                            };

                            for ready_msg in ready_msgs {
                                ulog_info!(
                                    "[telegram] Dispatching message from {} (chat {}): {} chars",
                                    ready_msg.sender_name.as_deref().unwrap_or("?"),
                                    ready_msg.chat_id,
                                    ready_msg.text.len(),
                                );
                                if self.message_tx.send(ready_msg).await.is_err() {
                                    ulog_error!("[telegram] Message channel closed");
                                    return;
                                }
                            }

                            // ACK received
                            if let Ok(mid) = msg.message_id.parse::<i64>() {
                                self.ack_received(&msg.chat_id, mid).await;
                            }
                        }
                    }

                    // Flush any debounce-expired fragment batches
                    let expired_msgs = {
                        let mut coalescer = self.coalescer.lock().await;
                        coalescer.flush_expired()
                    };
                    for expired_msg in expired_msgs {
                        ulog_info!(
                            "[telegram] Flushing expired fragment batch for chat {}",
                            expired_msg.chat_id,
                        );
                        if self.message_tx.send(expired_msg).await.is_err() {
                            ulog_error!("[telegram] Message channel closed");
                            return;
                        }
                    }
                }
                Err(TelegramError::TokenUnauthorized) => {
                    ulog_error!("[telegram] Bot token is unauthorized, stopping");
                    break;
                }
                Err(e) => {
                    ulog_warn!(
                        "[telegram] Long-poll error: {}, retrying in {}s",
                        e,
                        backoff_secs
                    );

                    // Check shutdown during backoff
                    tokio::select! {
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        _ = shutdown_rx.changed() => {
                            if *shutdown_rx.borrow() {
                                ulog_info!("[telegram] Shutdown during backoff");
                                break;
                            }
                        }
                    }

                    // Exponential backoff with cap
                    backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
                }
            }
        }

        ulog_info!("[telegram] Listen loop exited");
    }

    /// Download a file from Telegram by file_id.
    /// Flow: getFile(file_id) → file_path → GET /file/bot{token}/{file_path}
    /// Enforces MAX_FILE_DOWNLOAD_SIZE to prevent memory exhaustion.
    async fn download_file(&self, file_id: &str) -> Result<(Vec<u8>, String), TelegramError> {
        /// Maximum file download size (20 MB). Telegram Bot API limit is also 20 MB.
        const MAX_FILE_DOWNLOAD_SIZE: usize = 20 * 1024 * 1024;

        let result = self
            .api_call("getFile", &json!({ "file_id": file_id }))
            .await?;
        let file_path = result["file_path"]
            .as_str()
            .ok_or_else(|| TelegramError::Other("No file_path in getFile response".into()))?;

        // Check file_size from getFile response (Telegram provides this)
        if let Some(file_size) = result["file_size"].as_u64() {
            if file_size as usize > MAX_FILE_DOWNLOAD_SIZE {
                return Err(TelegramError::Other(format!(
                    "File too large: {} bytes (max {} bytes)",
                    file_size, MAX_FILE_DOWNLOAD_SIZE
                )));
            }
        }

        let url = format!(
            "https://api.telegram.org/file/bot{}/{}",
            self.bot_token, file_path
        );
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|error| safe_telegram_transport_error("Telegram file download", &error))?;
        if !resp.status().is_success() {
            return Err(TelegramError::Other(format!(
                "File download HTTP {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|error| safe_telegram_transport_error("Telegram file response", &error))?;

        // Double-check actual downloaded size
        if bytes.len() > MAX_FILE_DOWNLOAD_SIZE {
            return Err(TelegramError::Other(format!(
                "Downloaded file too large: {} bytes (max {} bytes)",
                bytes.len(),
                MAX_FILE_DOWNLOAD_SIZE
            )));
        }

        let name_hint = sanitize_filename(file_path.rsplit('/').next().unwrap_or("file"));
        Ok((bytes.to_vec(), name_hint))
    }

    /// Process a single Telegram update into an ImMessage.
    /// Handles text, photo, voice, audio, video, document, sticker, location, venue.
    async fn process_update(&self, update: &Value) -> Option<ImMessage> {
        let message = update.get("message")?;
        let chat = &message["chat"];
        let from = &message["from"];

        let chat_id = chat["id"].as_i64()?.to_string();
        let message_id = message["message_id"].as_i64()?.to_string();
        let sender_id = from["id"].as_i64()?;
        let sender_id_str = sender_id.to_string();
        let sender_name = from["username"]
            .as_str()
            .or_else(|| from["first_name"].as_str())
            .map(|s| s.to_string());

        // Determine source type
        let chat_type = chat["type"].as_str().unwrap_or("private");
        let source_type = match chat_type {
            "group" | "supergroup" => ImSourceType::Group,
            _ => ImSourceType::Private,
        };

        // Text: message.text OR message.caption (media messages use caption)
        let raw_text = message["text"]
            .as_str()
            .or_else(|| message["caption"].as_str())
            .unwrap_or("");

        // Media group ID (album)
        let media_group_id = message["media_group_id"].as_str().map(String::from);

        // ── Collect attachments ──
        let mut attachments: Vec<ImAttachment> = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();

        // 1. Photo (take highest resolution = last element)
        if let Some(photos) = message["photo"].as_array() {
            if let Some(photo) = photos.last() {
                if let Some(file_id) = photo["file_id"].as_str() {
                    match self.download_file(file_id).await {
                        Ok((data, name)) => {
                            attachments.push(ImAttachment {
                                file_name: name,
                                mime_type: "image/jpeg".into(),
                                data,
                                attachment_type: ImAttachmentType::Image,
                            });
                        }
                        Err(e) => ulog_warn!("[telegram] Failed to download photo: {}", e),
                    }
                }
            }
        }

        // 2. Voice note
        if let Some(voice) = message.get("voice") {
            if let Some(file_id) = voice["file_id"].as_str() {
                let mime = voice["mime_type"].as_str().unwrap_or("audio/ogg");
                match self.download_file(file_id).await {
                    Ok((data, _)) => {
                        let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
                        let ext = mime_to_ext(mime);
                        attachments.push(ImAttachment {
                            file_name: format!("voice_{}.{}", ts, ext),
                            mime_type: mime.into(),
                            data,
                            attachment_type: ImAttachmentType::File,
                        });
                        if raw_text.is_empty() {
                            text_parts.push("[语音消息]".into());
                        }
                    }
                    Err(e) => ulog_warn!("[telegram] Failed to download voice: {}", e),
                }
            }
        }

        // 3. Audio file
        if let Some(audio) = message.get("audio") {
            if let Some(file_id) = audio["file_id"].as_str() {
                let mime = audio["mime_type"].as_str().unwrap_or("audio/mpeg");
                let title = audio["title"]
                    .as_str()
                    .or_else(|| audio["file_name"].as_str())
                    .unwrap_or("audio");
                match self.download_file(file_id).await {
                    Ok((data, name)) => {
                        let file_name = audio["file_name"]
                            .as_str()
                            .map(|s| sanitize_filename(s))
                            .unwrap_or_else(|| sanitize_filename(&name));
                        attachments.push(ImAttachment {
                            file_name,
                            mime_type: mime.into(),
                            data,
                            attachment_type: ImAttachmentType::File,
                        });
                        text_parts.push(format!("[音频: {}]", title));
                    }
                    Err(e) => ulog_warn!("[telegram] Failed to download audio: {}", e),
                }
            }
        }

        // 4. Video / Video note
        if let Some(video) = message.get("video").or(message.get("video_note")) {
            if let Some(file_id) = video["file_id"].as_str() {
                let mime = video["mime_type"].as_str().unwrap_or("video/mp4");
                match self.download_file(file_id).await {
                    Ok((data, _name)) => {
                        let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
                        let ext = mime_to_ext(mime);
                        let file_name = video["file_name"]
                            .as_str()
                            .map(|s| sanitize_filename(s))
                            .unwrap_or_else(|| format!("video_{}.{}", ts, ext));
                        attachments.push(ImAttachment {
                            file_name,
                            mime_type: mime.into(),
                            data,
                            attachment_type: ImAttachmentType::File,
                        });
                        if raw_text.is_empty() {
                            text_parts.push("[视频]".into());
                        }
                    }
                    Err(e) => ulog_warn!("[telegram] Failed to download video: {}", e),
                }
            }
        }

        // 5. Document
        if let Some(doc) = message.get("document") {
            if let Some(file_id) = doc["file_id"].as_str() {
                let mime = doc["mime_type"]
                    .as_str()
                    .unwrap_or("application/octet-stream");
                match self.download_file(file_id).await {
                    Ok((data, name)) => {
                        let file_name = doc["file_name"]
                            .as_str()
                            .map(|s| sanitize_filename(s))
                            .unwrap_or_else(|| sanitize_filename(&name));
                        attachments.push(ImAttachment {
                            file_name: file_name.clone(),
                            mime_type: mime.into(),
                            data,
                            attachment_type: ImAttachmentType::File,
                        });
                        text_parts.push(format!("[文件: {}]", file_name));
                    }
                    Err(e) => ulog_warn!("[telegram] Failed to download document: {}", e),
                }
            }
        }

        // 6. Sticker
        if let Some(sticker) = message.get("sticker") {
            let is_animated = sticker["is_animated"].as_bool().unwrap_or(false);
            let is_video = sticker["is_video"].as_bool().unwrap_or(false);
            let emoji = sticker["emoji"].as_str().unwrap_or("");
            if !is_animated && !is_video {
                // Static WEBP → download as image for Vision
                if let Some(file_id) = sticker["file_id"].as_str() {
                    match self.download_file(file_id).await {
                        Ok((data, name)) => {
                            attachments.push(ImAttachment {
                                file_name: name,
                                mime_type: "image/webp".into(),
                                data,
                                attachment_type: ImAttachmentType::Image,
                            });
                            if !emoji.is_empty() {
                                text_parts.push(format!("[贴纸: {}]", emoji));
                            }
                        }
                        Err(e) => ulog_warn!("[telegram] Failed to download sticker: {}", e),
                    }
                }
            } else {
                // Animated/video sticker: skip media, keep emoji text
                if !emoji.is_empty() {
                    text_parts.push(format!("[贴纸: {}]", emoji));
                }
            }
        }

        // 7. Location / Venue
        if let Some(venue) = message.get("venue") {
            let lat = venue["location"]["latitude"].as_f64().unwrap_or(0.0);
            let lng = venue["location"]["longitude"].as_f64().unwrap_or(0.0);
            let title = venue["title"].as_str().unwrap_or("");
            let addr = venue["address"].as_str().unwrap_or("");
            text_parts.push(format!(
                "[位置: {}, {} ({:.4}, {:.4})]",
                title, addr, lat, lng
            ));
        } else if let Some(loc) = message.get("location") {
            let lat = loc["latitude"].as_f64().unwrap_or(0.0);
            let lng = loc["longitude"].as_f64().unwrap_or(0.0);
            text_parts.push(format!("[位置: {:.4}, {:.4}]", lat, lng));
        }

        // ── Build final text ──
        let mut final_text_parts = Vec::new();
        if !raw_text.is_empty() {
            final_text_parts.push(raw_text.to_string());
        }
        final_text_parts.extend(text_parts);
        let combined_text = final_text_parts.join("\n");

        // Skip if no content at all
        if combined_text.is_empty() && attachments.is_empty() {
            return None;
        }

        // Allow /start BIND_ messages to bypass whitelist (QR code binding flow)
        let is_bind_request = combined_text.starts_with("/start BIND_");

        // Whitelist check for private chats (bypassed for bind requests and group messages —
        // group access control is handled in mod.rs)
        if source_type == ImSourceType::Private
            && !is_bind_request
            && !self.is_allowed(sender_id, sender_name.as_deref()).await
        {
            ulog_debug!(
                "[telegram] Rejected message from non-whitelisted user: {} ({:?})",
                sender_id,
                sender_name
            );
            return None;
        }

        // Detect @Bot mention, /ask command, and reply-to-bot
        let bot_username = self.bot_username.lock().await;
        let is_at_mention = bot_username
            .as_ref()
            .map(|u| {
                // Telegram usernames are case-insensitive
                let mention = format!("@{}", u).to_lowercase();
                combined_text.to_lowercase().contains(&mention)
            })
            .unwrap_or(false);
        let is_ask = combined_text.starts_with("/ask");
        drop(bot_username);

        // Reply-to-bot detection: check if replying to bot's own message
        let reply_to_bot = if let Some(reply_msg) = message.get("reply_to_message") {
            let reply_from_id = reply_msg["from"]["id"].as_i64();
            let my_id = self.bot_user_id.lock().await;
            reply_from_id.is_some() && reply_from_id == *my_id
        } else {
            false
        };

        let is_mention = is_at_mention || is_ask || reply_to_bot || is_bind_request;

        // Strip @mention and /ask prefix from text
        let cleaned_text = clean_message_text(&combined_text, &*self.bot_username.lock().await);

        // Allow image-only messages (no text required when attachments present)
        if cleaned_text.trim().is_empty() && attachments.is_empty() {
            return None;
        }

        Some(ImMessage {
            chat_id,
            message_id,
            text: cleaned_text,
            sender_id: sender_id_str,
            sender_name,
            account_id: None,
            source_type,
            platform: ImPlatform::Telegram,
            timestamp: chrono::Utc::now(),
            attachments,
            media_group_id,
            is_mention,
            reply_to_bot,
            hint_group_name: None,
            reply_to_body: None,
            group_system_prompt: None,
            request_id: String::new(),
            delivery_protocol: None,
        })
    }

    /// Process my_chat_member update (bot added/removed from a group).
    fn process_my_chat_member(&self, update: &Value) -> Option<GroupEvent> {
        let member_update = update.get("my_chat_member")?;
        let chat = &member_update["chat"];
        let chat_type = chat["type"].as_str().unwrap_or("");
        // Only handle group/supergroup
        if chat_type != "group" && chat_type != "supergroup" {
            return None;
        }

        let chat_id = chat["id"].as_i64()?.to_string();
        let chat_title = chat["title"]
            .as_str()
            .unwrap_or("Unknown Group")
            .to_string();
        let new_status = member_update["new_chat_member"]["status"].as_str()?;
        let added_by_name = {
            let first = member_update["from"]["first_name"].as_str().unwrap_or("");
            let last = member_update["from"]["last_name"].as_str().unwrap_or("");
            let full = format!("{} {}", first, last).trim().to_string();
            if full.is_empty() {
                None
            } else {
                Some(full)
            }
        };

        match new_status {
            "member" | "administrator" => {
                ulog_info!(
                    "[telegram] Bot added to group: {} ({})",
                    chat_title,
                    chat_id
                );
                Some(GroupEvent::BotAdded {
                    chat_id,
                    chat_title,
                    platform: ImPlatform::Telegram,
                    added_by_name,
                })
            }
            "left" | "kicked" => {
                ulog_info!("[telegram] Bot removed from group: {}", chat_id);
                Some(GroupEvent::BotRemoved {
                    chat_id,
                    platform: ImPlatform::Telegram,
                })
            }
            _ => None,
        }
    }

    /// Check if a user is in the whitelist
    async fn is_allowed(&self, user_id: i64, username: Option<&str>) -> bool {
        let allowed_users = self.allowed_users.read().await;
        if allowed_users.is_empty() {
            return false; // Empty whitelist = reject all (default safe)
        }

        let user_id_str = user_id.to_string();
        for allowed in allowed_users.iter() {
            if allowed == &user_id_str {
                return true;
            }
            if let Some(uname) = username {
                if allowed.eq_ignore_ascii_case(uname) {
                    return true;
                }
            }
        }
        false
    }
}

/// Split text into chunks respecting max_len, trying to break at paragraph/line boundaries
pub fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a char-boundary-safe upper bound (max_len may fall mid-character for CJK/emoji)
        let mut safe_end = max_len.min(remaining.len());
        while !remaining.is_char_boundary(safe_end) {
            safe_end -= 1;
        }

        // Try to find a good break point within the safe range
        let search_range = &remaining[..safe_end];
        let break_point = search_range
            .rfind("\n\n") // Paragraph break
            .or_else(|| search_range.rfind('\n')) // Line break
            .or_else(|| search_range.rfind(". ")) // Sentence
            .or_else(|| search_range.rfind(' ')) // Word
            .unwrap_or(safe_end); // Hard cut at char boundary

        let break_at = if break_point == 0 {
            safe_end
        } else {
            break_point
        };

        chunks.push(remaining[..break_at].to_string());
        remaining = remaining[break_at..].trim_start();
    }

    chunks
}

/// Clean message text: remove @mention and /ask prefix
fn clean_message_text(text: &str, bot_username: &Option<String>) -> String {
    let mut cleaned = text.to_string();

    // Remove @BotUsername (case-insensitive, Telegram usernames are case-insensitive)
    if let Some(username) = bot_username {
        let mention = format!("@{}", username);
        // Case-insensitive removal: find and replace all occurrences
        let lower = cleaned.to_lowercase();
        let mention_lower = mention.to_lowercase();
        let mut result = String::new();
        let mut start = 0;
        while let Some(pos) = lower[start..].find(&mention_lower) {
            result.push_str(&cleaned[start..start + pos]);
            start += pos + mention.len();
        }
        result.push_str(&cleaned[start..]);
        cleaned = result;
    }

    // Trim before checking /ask (removing @mention may leave leading space)
    cleaned = cleaned.trim().to_string();

    // Remove /ask prefix
    if cleaned.starts_with("/ask") {
        cleaned = cleaned[4..].to_string();
    }

    cleaned.trim().to_string()
}

// ── ImAdapter trait implementation ─────────────────────────

impl super::adapter::ImAdapter for TelegramAdapter {
    async fn verify_connection(&self) -> super::adapter::AdapterResult<String> {
        let result = self.get_me().await.map_err(|e| e.to_string())?;
        let username = result["username"].as_str().unwrap_or("unknown").to_string();
        Ok(format!("@{}", username))
    }

    async fn register_commands(&self) -> super::adapter::AdapterResult<()> {
        self.set_my_commands().await.map_err(|e| e.to_string())
    }

    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        self.listen_loop(shutdown_rx).await;
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> super::adapter::AdapterResult<()> {
        self.send_message(chat_id, text)
            .await
            .map(|_| ()) // discard message_id
            .map_err(|e| e.to_string())
    }

    async fn ack_received(&self, chat_id: &str, message_id: &str) {
        if let Ok(mid) = message_id.parse::<i64>() {
            self.ack_received(chat_id, mid).await;
        }
    }

    async fn ack_processing(&self, chat_id: &str, message_id: &str) {
        if let Ok(mid) = message_id.parse::<i64>() {
            self.ack_processing(chat_id, mid).await;
        }
    }

    async fn ack_clear(&self, chat_id: &str, message_id: &str) {
        if let Ok(mid) = message_id.parse::<i64>() {
            self.ack_clear(chat_id, mid).await;
        }
    }

    async fn send_typing(&self, chat_id: &str) {
        self.send_typing(chat_id).await;
    }
}

// ── ImStreamAdapter trait implementation ─────────────────────────

impl super::adapter::ImStreamAdapter for TelegramAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<Option<String>> {
        use std::sync::atomic::Ordering;
        if self.use_message_draft && !self.draft_fallback.load(Ordering::Relaxed) {
            // Draft mode: use sendMessageDraft, return virtual "draft:{id}" ID.
            // The draft_id is encoded into the virtual ID string so each stream
            // is self-contained — no shared mutable state across concurrent chats.
            let draft_id = {
                use std::time::{SystemTime, UNIX_EPOCH};
                let t = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                (t.as_millis() as i64).max(1)
            };
            match self.send_draft_update(chat_id, text, draft_id).await {
                Ok(()) => Ok(Some(format!("draft:{}", draft_id))),
                Err(TelegramError::DraftPeerInvalid) => {
                    // Fallback to standard mode
                    ulog_warn!(
                        "[telegram] sendMessageDraft not supported, falling back to standard mode"
                    );
                    self.send_message(chat_id, text)
                        .await
                        .map(|opt| opt.map(|id| id.to_string()))
                        .map_err(|e| e.to_string())
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            // Standard mode
            self.send_message(chat_id, text)
                .await
                .map(|opt_id| opt_id.map(|id| id.to_string()))
                .map_err(|e| e.to_string())
        }
    }

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        // Parse draft_id directly from the virtual "draft:xxx" ID string.
        // This keeps draft routing stream-local — no shared state across concurrent chats.
        if let Some(id_str) = message_id.strip_prefix("draft:") {
            let draft_id = id_str
                .parse::<i64>()
                .map_err(|e| format!("Invalid draft ID: {}", e))?;
            return self
                .send_draft_update(chat_id, text, draft_id)
                .await
                .map_err(|e| e.to_string());
        }
        // Standard mode
        let mid = message_id
            .parse::<i64>()
            .map_err(|e| format!("Invalid message_id: {}", e))?;
        self.edit_message(chat_id, mid, text)
            .await
            .map_err(|e| e.to_string())
    }

    async fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> super::adapter::AdapterResult<()> {
        if message_id.starts_with("draft:") {
            // Drafts auto-clear when sendMessage is called, no need to delete
            return Ok(());
        }
        // Standard mode
        let mid = message_id
            .parse::<i64>()
            .map_err(|e| format!("Invalid message_id: {}", e))?;
        self.delete_message(chat_id, mid)
            .await
            .map_err(|e| e.to_string())
    }

    fn max_message_length(&self) -> usize {
        4096
    }

    async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> super::adapter::AdapterResult<Option<String>> {
        self.send_approval_card(chat_id, request_id, tool_name, tool_input)
            .await
            .map_err(|e| e.to_string())
    }

    async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.update_approval_status(chat_id, message_id, status)
            .await
            .map_err(|e| e.to_string())
    }

    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        self.send_photo_media(chat_id, data, filename, caption)
            .await
            .map(|opt_id| opt_id.map(|id| id.to_string()))
            .map_err(|e| e.to_string())
    }

    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        self.send_document_media(chat_id, data, filename, mime_type, caption)
            .await
            .map(|opt_id| opt_id.map(|id| id.to_string()))
            .map_err(|e| e.to_string())
    }

    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        <Self as super::adapter::ImStreamAdapter>::edit_message(self, chat_id, message_id, text)
            .await
    }

    fn use_draft_streaming(&self) -> bool {
        self.use_message_draft
            && !self
                .draft_fallback
                .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn preferred_throttle_ms(&self) -> u64 {
        if self.use_draft_streaming() {
            300
        } else {
            1000
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_error_projection_never_includes_the_token_bearing_url() {
        let token = "123456789:future-secret-token";
        let error = crate::local_http::builder()
            .build()
            .expect("test client")
            .get(format!(
                "https://api.telegram.org:invalid/bot{}/getMe",
                token
            ))
            .build()
            .expect_err("invalid port must fail request construction");

        let projected = safe_telegram_transport_error("Telegram API request", &error).to_string();
        assert_eq!(projected, "Telegram API request failed: invalid request");
        assert!(!projected.contains(token));
        assert!(!projected.contains("api.telegram.org"));
    }

    #[test]
    fn test_split_message_short() {
        let chunks = split_message("Hello world", 4096);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "Hello world");
    }

    #[test]
    fn test_split_message_long() {
        let text = "a".repeat(8000);
        let chunks = split_message(&text, 4096);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].len() <= 4096);
        assert!(chunks[1].len() <= 4096);
    }

    #[test]
    fn test_split_message_paragraph_break() {
        let text = format!("{}\n\n{}", "a".repeat(3000), "b".repeat(3000));
        let chunks = split_message(&text, 4096);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].starts_with("aaa"));
        assert!(chunks[1].starts_with("bbb"));
    }

    #[test]
    fn test_clean_message_text() {
        let bot = Some("mybot".to_string());
        assert_eq!(clean_message_text("@mybot hello", &bot), "hello");
        assert_eq!(
            clean_message_text("/ask what is this", &bot),
            "what is this"
        );
        assert_eq!(clean_message_text("@mybot /ask combined", &bot), "combined");
    }

    fn make_test_msg(chat_id: &str, msg_id: i64, text: &str) -> ImMessage {
        ImMessage {
            chat_id: chat_id.to_string(),
            message_id: msg_id.to_string(),
            text: text.to_string(),
            sender_id: "42".to_string(),
            sender_name: Some("testuser".to_string()),
            account_id: None,
            source_type: ImSourceType::Private,
            platform: ImPlatform::Telegram,
            timestamp: chrono::Utc::now(),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention: false,
            reply_to_bot: false,
            hint_group_name: None,
            reply_to_body: None,
            group_system_prompt: None,
            request_id: String::new(),
            delivery_protocol: None,
        }
    }

    #[test]
    fn test_coalescer_single_short_message_immediate() {
        let mut c = MessageCoalescer::new();
        // Short message should be returned immediately (not buffered)
        let msg = make_test_msg("chat1", 1, "hello");
        let result = c.push(&msg);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "hello");
        assert_eq!(result[0].sender_id, "42");
        assert_eq!(result[0].sender_name.as_deref(), Some("testuser"));
    }

    #[test]
    fn test_coalescer_fragment_merge() {
        let mut c = MessageCoalescer::new();
        let long_text = "a".repeat(4100);
        // First fragment — buffered, waiting for more
        let msg1 = make_test_msg("chat1", 1, &long_text);
        let result = c.push(&msg1);
        assert!(result.is_empty());

        // Second fragment (continuation: >= 4000 chars, consecutive msg_id)
        let long_text2 = "b".repeat(4100);
        let msg2 = make_test_msg("chat1", 2, &long_text2);
        let result = c.push(&msg2);
        assert!(result.is_empty()); // Still pending

        // Non-fragment message flushes old batch and is returned immediately
        let msg3 = make_test_msg("chat1", 100, "new message");
        let result = c.push(&msg3);
        assert_eq!(result.len(), 2); // flushed batch + new message
        assert!(result[0].text.contains("aaa"));
        assert!(result[0].text.contains("bbb"));
        assert_eq!(result[0].sender_id, "42"); // sender metadata preserved
        assert_eq!(result[1].text, "new message");
    }
}
