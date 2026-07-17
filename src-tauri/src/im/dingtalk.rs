// DingTalk (钉钉) Bot adapter
// Handles Stream mode WebSocket connection, message sending/editing (AI Card),
// OAuth2 access_token management, and event parsing.
//
// DingTalk Stream Mode uses JSON text frames (unlike Feishu's binary protobuf),
// making the wire protocol simpler.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::sleep;

use futures::SinkExt;
use futures::StreamExt;

use super::types::{GroupEvent, ImConfig, ImMessage, ImPlatform, ImSourceType};
use super::ApprovalCallback;
use crate::{proxy_config, ulog_debug, ulog_error, ulog_info, ulog_warn};

// ── Constants ───────────────────────────────────────────────

/// DingTalk new API base URL (v1.0 / v2.0)
const DINGTALK_API_BASE: &str = "https://api.dingtalk.com";
/// Legacy API base (some endpoints still use this)
#[allow(dead_code)]
const DINGTALK_OAPI_BASE: &str = "https://oapi.dingtalk.com";

/// Token refresh margin (refresh when < 5 min remaining)
const TOKEN_REFRESH_MARGIN_SECS: u64 = 300;
/// Token validity period (DingTalk tokens are valid for 2 hours / 7200s)
const TOKEN_VALIDITY_SECS: u64 = 7200;

/// WebSocket reconnect initial backoff
const WS_INITIAL_BACKOFF_SECS: u64 = 1;
/// WebSocket reconnect max backoff
const WS_MAX_BACKOFF_SECS: u64 = 60;
/// WebSocket read timeout: if no data (including pings) is received
/// within this period, the connection is assumed dead.
/// With client-side pings every 30s, 120s means ~4 missed pings → truly dead.
const WS_READ_TIMEOUT_SECS: u64 = 120;
/// Client-side WebSocket ping interval. Keeps NAT/firewall mappings alive
/// and enables faster dead-connection detection (without this, silent TCP
/// drops go unnoticed until the read timeout fires).
const WS_PING_INTERVAL_SECS: u64 = 30;

/// Dedup cache TTL (72 hours)
const DEDUP_TTL_SECS: u64 = 72 * 60 * 60;
/// Max dedup cache size before forced cleanup
const DEDUP_MAX_SIZE: usize = 5000;
/// Minimum interval between dedup disk writes (ms)
const DEDUP_PERSIST_INTERVAL_MS: u64 = 500;

/// Max Markdown message length for DingTalk
const MAX_MESSAGE_LENGTH: usize = 20000;

// ── AI Card tracking ────────────────────────────────────────

/// Tracks an active AI Card for streaming updates
struct ActiveCardState {
    /// Outgoing track ID (UUID, used for streaming PUT)
    out_track_id: String,
    /// Last content sent (for dedup)
    last_content: String,
    /// Creation time
    #[allow(dead_code)]
    created_at: Instant,
}

// ── Helper: persist dedup cache ─────────────────────────────

/// Persist dedup cache to disk (atomic: write tmp → rename).
fn save_dedup_cache_to_disk(path: &std::path::Path, cache: &HashMap<String, u64>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp_path = path.with_extension("json.tmp.dedup");
    match serde_json::to_string(cache) {
        Ok(json_str) => {
            if let Err(e) = std::fs::write(&tmp_path, &json_str) {
                ulog_warn!("[dingtalk] Failed to write dedup cache tmp: {}", e);
                return;
            }
            if let Err(e) = std::fs::rename(&tmp_path, path) {
                ulog_warn!("[dingtalk] Failed to rename dedup cache: {}", e);
            }
        }
        Err(e) => {
            ulog_warn!("[dingtalk] Failed to serialize dedup cache: {}", e);
        }
    }
}

/// Cached access token
struct TokenCache {
    access_token: String,
    expires_at: Instant,
}

// ── DingTalk Bot Adapter ────────────────────────────────────

#[allow(dead_code)]
pub struct DingtalkAdapter {
    client_id: String,
    client_secret: String,
    /// Whether to use AI Card for streaming replies
    use_ai_card: bool,
    /// Card template ID (required when use_ai_card is true)
    card_template_id: Option<String>,
    /// HTTP client (uses proxy config)
    client: Client,
    /// Cached OAuth2 access token
    token_cache: Arc<RwLock<Option<TokenCache>>>,
    /// Serializes token refresh to prevent concurrent refreshes
    token_refresh_lock: Arc<tokio::sync::Mutex<()>>,
    /// Channel for forwarding parsed IM messages to the processing loop
    msg_tx: mpsc::Sender<ImMessage>,
    /// Allowed users (sender_id whitelist)
    allowed_users: Arc<RwLock<Vec<String>>>,
    /// Bot name (fetched on start)
    bot_name: Arc<RwLock<Option<String>>>,
    /// Robot code (= client_id, used in API calls)
    robot_code: String,
    /// Message dedup cache: msgId → unix_timestamp_secs
    dedup_cache: Arc<Mutex<HashMap<String, u64>>>,
    /// Path for persisting dedup cache
    dedup_persist_path: Option<PathBuf>,
    /// Epoch millis of last dedup disk write (debounce)
    dedup_last_persist_ms: AtomicU64,
    /// Channel for forwarding approval callbacks
    approval_tx: mpsc::Sender<ApprovalCallback>,
    /// Channel for group lifecycle events
    group_event_tx: mpsc::Sender<GroupEvent>,
    /// Active AI Cards: chat_id → ActiveCardState
    active_cards: Arc<Mutex<HashMap<String, ActiveCardState>>>,
    /// Known group conversation IDs (to detect first-message from new groups)
    known_groups: Arc<Mutex<HashSet<String>>>,
}

impl DingtalkAdapter {
    pub fn new(
        config: &ImConfig,
        msg_tx: mpsc::Sender<ImMessage>,
        allowed_users: Arc<RwLock<Vec<String>>>,
        approval_tx: mpsc::Sender<ApprovalCallback>,
        dedup_path: Option<PathBuf>,
        group_event_tx: mpsc::Sender<GroupEvent>,
    ) -> Self {
        // External host (open-dingtalk.com) — system proxy wanted.
        #[allow(clippy::disallowed_methods)]
        let client_builder = Client::builder().timeout(Duration::from_secs(30));
        let client = proxy_config::build_client_with_proxy(client_builder).unwrap_or_else(|e| {
            ulog_warn!(
                "[dingtalk] Failed to build client with proxy: {}, falling back to direct",
                e
            );
            #[allow(clippy::disallowed_methods)]
            Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client")
        });

        let dedup_cache = Self::load_dedup_cache(dedup_path.as_deref());

        let client_id = config.dingtalk_client_id.clone().unwrap_or_default();

        // Pre-populate known groups from persisted group_permissions so we don't
        // re-trigger BotAdded for already-discovered groups on restart.
        let known_groups: HashSet<String> = config
            .group_permissions
            .iter()
            .map(|gp| gp.group_id.clone())
            .collect();

        Self {
            client_id: client_id.clone(),
            client_secret: config.dingtalk_client_secret.clone().unwrap_or_default(),
            use_ai_card: config.dingtalk_use_ai_card.unwrap_or(false),
            card_template_id: config.dingtalk_card_template_id.clone(),
            client,
            token_cache: Arc::new(RwLock::new(None)),
            token_refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            msg_tx,
            allowed_users,
            bot_name: Arc::new(RwLock::new(None)),
            robot_code: client_id,
            dedup_cache: Arc::new(Mutex::new(dedup_cache)),
            dedup_persist_path: dedup_path,
            dedup_last_persist_ms: AtomicU64::new(0),
            approval_tx,
            group_event_tx,
            active_cards: Arc::new(Mutex::new(HashMap::new())),
            known_groups: Arc::new(Mutex::new(known_groups)),
        }
    }

    /// Load dedup cache from disk, filtering out expired entries.
    fn load_dedup_cache(path: Option<&std::path::Path>) -> HashMap<String, u64> {
        let path = match path {
            Some(p) if p.exists() => p,
            _ => return HashMap::new(),
        };
        match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<HashMap<String, u64>>(&content) {
                Ok(mut cache) => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let before = cache.len();
                    cache.retain(|_, ts| now.saturating_sub(*ts) < DEDUP_TTL_SECS);
                    ulog_info!(
                        "[dingtalk] Loaded dedup cache from disk: {} entries ({} expired)",
                        cache.len(),
                        before - cache.len()
                    );
                    cache
                }
                Err(e) => {
                    ulog_warn!("[dingtalk] Failed to parse dedup cache file: {}", e);
                    HashMap::new()
                }
            },
            Err(e) => {
                ulog_warn!("[dingtalk] Failed to read dedup cache file: {}", e);
                HashMap::new()
            }
        }
    }

    /// Flush dedup cache to disk unconditionally (call on graceful shutdown).
    pub async fn flush_dedup_cache(&self) {
        if let Some(path) = &self.dedup_persist_path {
            let snapshot = self.dedup_cache.lock().await.clone();
            save_dedup_cache_to_disk(path, &snapshot);
            ulog_info!(
                "[dingtalk] Dedup cache flushed to disk ({} entries)",
                snapshot.len()
            );
        }
    }

    /// Debounced dedup cache persistence (at most once per DEDUP_PERSIST_INTERVAL_MS).
    async fn maybe_persist_dedup(&self) {
        let Some(path) = &self.dedup_persist_path else {
            return;
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let last = self.dedup_last_persist_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < DEDUP_PERSIST_INTERVAL_MS {
            return;
        }
        self.dedup_last_persist_ms.store(now_ms, Ordering::Relaxed);

        let snapshot = self.dedup_cache.lock().await.clone();
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            save_dedup_cache_to_disk(&path, &snapshot);
        });
    }

    /// Check and insert a message ID into the dedup cache.
    /// Returns true if this is a NEW message (not a duplicate).
    async fn dedup_check(&self, msg_id: &str) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut cache = self.dedup_cache.lock().await;

        // Periodic cleanup: remove expired entries
        if cache.len() > DEDUP_MAX_SIZE {
            cache.retain(|_, ts| now.saturating_sub(*ts) < DEDUP_TTL_SECS);
        }

        // Check if already seen
        if cache.contains_key(msg_id) {
            return false;
        }

        cache.insert(msg_id.to_string(), now);
        drop(cache);

        self.maybe_persist_dedup().await;
        true
    }

    // ===== Token management =====

    /// Get a valid access token, refreshing if expired.
    async fn get_token(&self) -> Result<String, String> {
        // Check cache first
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if Instant::now() < tc.expires_at {
                    return Ok(tc.access_token.clone());
                }
            }
        }
        self.refresh_token().await
    }

    /// Request a new access_token from DingTalk OAuth2.
    async fn refresh_token(&self) -> Result<String, String> {
        let _guard = self.token_refresh_lock.lock().await;

        // Double-check after acquiring lock
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if Instant::now() < tc.expires_at {
                    return Ok(tc.access_token.clone());
                }
            }
        }

        let url = format!("{}/v1.0/oauth2/accessToken", DINGTALK_API_BASE);
        let body = json!({
            "appKey": self.client_id,
            "appSecret": self.client_secret,
        });

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Token request failed: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Token request HTTP {}: {}", status, text));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Token response parse error: {}", e))?;

        // DingTalk v1.0 returns { accessToken, expireIn }
        let token = json["accessToken"]
            .as_str()
            .ok_or_else(|| format!("No accessToken in response: {}", text))?
            .to_string();

        let expire = json["expireIn"].as_u64().unwrap_or(TOKEN_VALIDITY_SECS);
        let expires_at =
            Instant::now() + Duration::from_secs(expire.saturating_sub(TOKEN_REFRESH_MARGIN_SECS));

        {
            let mut cache = self.token_cache.write().await;
            *cache = Some(TokenCache {
                access_token: token.clone(),
                expires_at,
            });
        }

        ulog_info!("[dingtalk] Token refreshed, expires in {}s", expire);
        Ok(token)
    }

    /// Make an authenticated DingTalk API call (new API v1.0/v2.0).
    /// Auto-retries once on 401 (token expired).
    async fn api_call(
        &self,
        method: &str,
        url: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        let mut retries = 0;

        loop {
            let token = self.get_token().await?;

            let mut req = match method {
                "GET" => self.client.get(url),
                "PUT" => self.client.put(url),
                "DELETE" => self.client.delete(url),
                _ => self.client.post(url),
            };

            req = req.header("x-acs-dingtalk-access-token", &token);

            if let Some(b) = body {
                req = req.json(b);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("DingTalk API error: {}", e))?;

            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();

            // Handle 401 — refresh token and retry once
            if status.as_u16() == 401 && retries == 0 {
                ulog_warn!("[dingtalk] Got 401, refreshing token and retrying");
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            if !status.is_success() {
                return Err(format!("DingTalk API HTTP {}: {}", status, text));
            }

            let json: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));

            return Ok(json);
        }
    }

    // ===== Bot info =====

    /// Verify credentials by fetching bot info.
    async fn get_bot_info(&self) -> Result<String, String> {
        // Use the token to verify connectivity
        let _token = self.get_token().await?;

        // DingTalk doesn't have a direct "get bot info" endpoint like Feishu.
        // We verify by successfully obtaining a token. The bot name is the app name
        // configured in DingTalk developer console; we use client_id as identifier.
        let id_preview: String = self.client_id.chars().take(8).collect();
        let name = format!("dingtalk_{}", id_preview);
        *self.bot_name.write().await = Some(name.clone());
        Ok(name)
    }

    // ===== Message sending =====

    /// Send a Markdown message to a single user (1:1 chat).
    async fn send_private_message(
        &self,
        user_id: &str,
        text: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/v1.0/robot/oToMessages/batchSend", DINGTALK_API_BASE);
        let body = json!({
            "robotCode": self.robot_code,
            "userIds": [user_id],
            "msgKey": "sampleMarkdown",
            "msgParam": serde_json::to_string(&json!({
                "title": "AI 助手",
                "text": text
            })).unwrap_or_default(),
        });

        let resp = self.api_call("POST", &url, Some(&body)).await?;
        let process_query_key = resp["processQueryKey"].as_str().map(String::from);
        Ok(process_query_key)
    }

    /// Send a Markdown message to a group chat.
    async fn send_group_message(
        &self,
        conversation_id: &str,
        text: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/v1.0/robot/groupMessages/send", DINGTALK_API_BASE);
        let body = json!({
            "robotCode": self.robot_code,
            "openConversationId": conversation_id,
            "msgKey": "sampleMarkdown",
            "msgParam": serde_json::to_string(&json!({
                "title": "AI 助手",
                "text": text
            })).unwrap_or_default(),
        });

        let resp = self.api_call("POST", &url, Some(&body)).await?;
        let process_query_key = resp["processQueryKey"].as_str().map(String::from);
        Ok(process_query_key)
    }

    /// Unified send: auto-detect private vs group by chat_id format.
    /// Convention: group chat IDs are stored as "group:{openConversationId}"
    /// Private chat IDs are stored as the raw staffId.
    pub async fn send_text_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> Result<Option<String>, String> {
        if let Some(group_id) = chat_id.strip_prefix("group:") {
            self.send_group_message(group_id, text).await
        } else {
            self.send_private_message(chat_id, text).await
        }
    }

    /// Edit a message — only works for AI Card streaming updates.
    /// For regular messages, DingTalk does not support editing → returns Err.
    pub async fn edit_text_message(
        &self,
        chat_id: &str,
        _message_id: &str,
        text: &str,
    ) -> Result<(), String> {
        if !self.use_ai_card {
            // DingTalk regular messages can't be edited via Robot API.
            // Returning Err lets callers fall back to delete+send when needed
            // (e.g., the "(No response)" placeholder path in stream_to_im).
            return Err("DingTalk regular messages cannot be edited".to_string());
        }

        // Look up active card for this chat
        let card_state = {
            let cards = self.active_cards.lock().await;
            cards
                .get(chat_id)
                .map(|c| (c.out_track_id.clone(), c.last_content.clone()))
        };

        let Some((out_track_id, last_content)) = card_state else {
            return Err("No active AI Card for this chat".to_string());
        };

        // Skip if content hasn't changed
        if text == last_content {
            return Ok(());
        }

        let url = format!("{}/v1.0/card/streaming", DINGTALK_API_BASE);
        let body = json!({
            "outTrackId": out_track_id,
            "key": "content",
            "content": text,
            "isFull": true,
            "isFinalize": false,
            "guid": uuid::Uuid::new_v4().to_string(),
        });

        self.api_call("PUT", &url, Some(&body)).await?;

        // Update last_content
        {
            let mut cards = self.active_cards.lock().await;
            if let Some(card) = cards.get_mut(chat_id) {
                card.last_content = text.to_string();
            }
        }

        Ok(())
    }

    /// Delete a message — DingTalk Robot API does not support message deletion.
    pub async fn delete_text_message(
        &self,
        _chat_id: &str,
        _message_id: &str,
    ) -> Result<(), String> {
        // DingTalk Robot messages cannot be recalled/deleted via API
        ulog_debug!("[dingtalk] delete_text_message: not supported by DingTalk Robot API");
        Ok(())
    }

    // ===== AI Card operations =====

    /// Create a new AI Card instance and deliver it to the conversation.
    /// Returns the card_instance_id.
    async fn create_ai_card(&self, chat_id: &str, initial_text: &str) -> Result<String, String> {
        let template_id = self
            .card_template_id
            .as_deref()
            .ok_or_else(|| "AI Card template ID not configured".to_string())?;

        let out_track_id = uuid::Uuid::new_v4().to_string();

        // Build card data with conversation scope
        let (open_space_id, im_group_open_deliver_model, im_robot_open_deliver_model) =
            if let Some(group_id) = chat_id.strip_prefix("group:") {
                // Group chat
                (
                    format!("dtv1.card//IM_GROUP.{}", group_id),
                    Some(json!({
                        "robotCode": self.robot_code,
                    })),
                    None,
                )
            } else {
                // Private chat
                (
                    format!("dtv1.card//IM_ROBOT.{}", chat_id),
                    None,
                    Some(json!({
                        "robotCode": self.robot_code,
                    })),
                )
            };

        let url = format!("{}/v1.0/card/instances/createAndDeliver", DINGTALK_API_BASE);
        let mut body = json!({
            "cardTemplateId": template_id,
            "outTrackId": out_track_id,
            "cardData": {
                "cardParamMap": {
                    "content": initial_text,
                }
            },
            "openSpaceId": open_space_id,
            "imGroupOpenDeliverModel": {},
            "imRobotOpenDeliverModel": {},
            "callbackType": "STREAM",
        });

        if let Some(model) = im_group_open_deliver_model {
            body["imGroupOpenDeliverModel"] = model;
        }
        if let Some(model) = im_robot_open_deliver_model {
            body["imRobotOpenDeliverModel"] = model;
        }

        self.api_call("POST", &url, Some(&body)).await?;

        // Track the active card
        {
            let mut cards = self.active_cards.lock().await;
            cards.insert(
                chat_id.to_string(),
                ActiveCardState {
                    out_track_id: out_track_id.clone(),
                    last_content: initial_text.to_string(),
                    created_at: Instant::now(),
                },
            );
        }

        ulog_info!(
            "[dingtalk] Created AI Card for chat {}: outTrackId={}",
            chat_id,
            out_track_id
        );
        Ok(out_track_id)
    }

    /// Finalize an active AI Card (send isFinalize: true).
    /// Called after stream_to_im completes.
    pub async fn post_stream_cleanup(&self, chat_id: &str) {
        let card_state = {
            let mut cards = self.active_cards.lock().await;
            cards.remove(chat_id)
        };

        let Some(card) = card_state else {
            return; // No active card for this chat
        };

        let url = format!("{}/v1.0/card/streaming", DINGTALK_API_BASE);
        let body = json!({
            "outTrackId": card.out_track_id,
            "key": "content",
            "content": card.last_content,
            "isFull": true,
            "isFinalize": true,
            "guid": uuid::Uuid::new_v4().to_string(),
        });

        match self.api_call("PUT", &url, Some(&body)).await {
            Ok(_) => {
                ulog_info!("[dingtalk] Finalized AI Card for chat {}", chat_id);
            }
            Err(e) => {
                ulog_warn!(
                    "[dingtalk] Failed to finalize AI Card for chat {}: {}",
                    chat_id,
                    e
                );
            }
        }
    }

    // ===== Approval card (tool permission) =====

    /// Send an approval card for tool permission request.
    /// DingTalk uses Markdown message with inline action hints since interactive
    /// cards require template setup. Fallback to text-based approval.
    pub async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> Result<Option<String>, String> {
        let truncated_input = if tool_input.chars().count() > 500 {
            let truncated: String = tool_input.chars().take(500).collect();
            format!("{}...", truncated)
        } else {
            tool_input.to_string()
        };

        let text = format!(
            "## 🔐 工具授权请求\n\n**工具**: `{}`\n\n**参数**:\n```\n{}\n```\n\n**请求ID**: `{}`\n\n> 回复以下关键词来处理：\n> - `允许` 或 `approve` — 允许执行\n> - `拒绝` 或 `deny` — 拒绝执行",
            tool_name, truncated_input, request_id,
        );

        self.send_text_message(chat_id, &text).await
    }

    /// Update approval status (text-based since we use Markdown messages).
    pub async fn update_approval_status(
        &self,
        chat_id: &str,
        _message_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let emoji = match status {
            "approved" | "allow_once" | "always_allow" => "✅",
            "denied" | "deny" => "❌",
            _ => "ℹ️",
        };
        let text = format!("{} 工具授权已处理: {}", emoji, status);
        self.send_text_message(chat_id, &text).await?;
        Ok(())
    }

    // ===== WebSocket Stream connection =====

    /// Main WebSocket listen loop with automatic reconnection.
    pub async fn ws_listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        let mut backoff_secs = WS_INITIAL_BACKOFF_SECS;

        loop {
            if *shutdown_rx.borrow() {
                ulog_info!("[dingtalk] Shutdown signal received, exiting WS loop");
                break;
            }

            let conn_start = Instant::now();
            match self.ws_connect_and_listen(&mut shutdown_rx).await {
                Ok(()) => {
                    ulog_info!("[dingtalk] WS connection closed gracefully");
                    backoff_secs = WS_INITIAL_BACKOFF_SECS;
                }
                Err(e) => {
                    ulog_warn!("[dingtalk] WS connection error: {}", e);
                    // Reset backoff if connection was alive for a while (not an immediate failure)
                    if conn_start.elapsed() > Duration::from_secs(30) {
                        backoff_secs = WS_INITIAL_BACKOFF_SECS;
                    }
                }
            }

            if *shutdown_rx.borrow() {
                break;
            }

            ulog_info!("[dingtalk] Reconnecting in {}s...", backoff_secs);
            tokio::select! {
                _ = sleep(Duration::from_secs(backoff_secs)) => {},
                _ = shutdown_rx.changed() => {
                    break;
                }
            }

            // Exponential backoff
            backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
        }

        // Flush dedup cache on shutdown
        self.flush_dedup_cache().await;
    }

    /// Open a Stream connection and process messages until error or shutdown.
    async fn ws_connect_and_listen(
        &self,
        shutdown_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), String> {
        // Step 1: Get WebSocket endpoint
        let register_url = format!("{}/v1.0/gateway/connections/open", DINGTALK_API_BASE);
        let register_body = json!({
            "clientId": self.client_id,
            "clientSecret": self.client_secret,
            "subscriptions": [
                { "type": "CALLBACK", "topic": "/v1.0/im/bot/messages/get" },
                { "type": "CALLBACK", "topic": "/v1.0/card/instances/callback" },
                { "type": "EVENT", "topic": "*" },
            ],
        });

        let resp = self
            .client
            .post(&register_url)
            .json(&register_body)
            .send()
            .await
            .map_err(|e| format!("Stream register failed: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Stream register HTTP {}: {}", status, text));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Stream register parse error: {}", e))?;

        let endpoint = json["endpoint"]
            .as_str()
            .ok_or_else(|| "No endpoint in stream register response".to_string())?;
        let ticket = json["ticket"]
            .as_str()
            .ok_or_else(|| "No ticket in stream register response".to_string())?;

        // Step 2: Connect WebSocket
        let ws_url = format!("{}?ticket={}", endpoint, ticket);
        ulog_info!("[dingtalk] Connecting to WS endpoint...");

        use tokio_tungstenite::tungstenite::Message as WsMessage;
        let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("WS connect failed: {}", e))?;

        ulog_info!("[dingtalk] WebSocket connected");

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Track last received data to detect dead connections.
        let mut last_activity = tokio::time::Instant::now();

        // Client-side ping to keep NAT/firewall mappings alive.
        // Without this, idle TCP connections get silently dropped by middleboxes,
        // and the server's SYSTEM pings never reach us.
        let mut ping_interval = tokio::time::interval(Duration::from_secs(WS_PING_INTERVAL_SECS));
        ping_interval.tick().await; // skip immediate tick

        loop {
            let timeout_at = last_activity + Duration::from_secs(WS_READ_TIMEOUT_SECS);
            // biased: prioritize read over timeout to avoid false "dead connection"
            // when data arrives at the same instant the timeout fires.
            tokio::select! {
                biased;
                msg = ws_read.next() => {
                    match msg {
                        Some(Ok(ws_msg)) => {
                            last_activity = tokio::time::Instant::now();
                            match ws_msg {
                                WsMessage::Text(text) => {
                                    self.handle_ws_text_frame(&text, &mut ws_write).await;
                                }
                                WsMessage::Ping(data) => {
                                    let _ = ws_write.send(WsMessage::Pong(data)).await;
                                }
                                WsMessage::Close(_) => {
                                    ulog_info!("[dingtalk] WS received Close frame");
                                    return Ok(());
                                }
                                _ => {
                                    // Binary, Pong, etc. — ignore
                                }
                            }
                        }
                        Some(Err(e)) => {
                            return Err(format!("WS read error: {}", e));
                        }
                        None => {
                            return Ok(()); // Stream ended
                        }
                    }
                }
                _ = tokio::time::sleep_until(timeout_at) => {
                    return Err(format!(
                        "WS read timeout (no data for {}s, dead connection)",
                        WS_READ_TIMEOUT_SECS
                    ));
                }
                _ = ping_interval.tick() => {
                    if let Err(e) = ws_write.send(WsMessage::Ping(vec![])).await {
                        return Err(format!("WS ping send failed: {}", e));
                    }
                }
                _ = shutdown_rx.changed() => {
                    ulog_info!("[dingtalk] Shutdown during WS listen");
                    let _ = ws_write.send(WsMessage::Close(None)).await;
                    return Ok(());
                }
            }
        }
    }

    /// Handle a JSON text frame from DingTalk Stream.
    async fn handle_ws_text_frame(
        &self,
        text: &str,
        ws_write: &mut futures::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::Message,
        >,
    ) {
        let frame: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[dingtalk] Failed to parse WS frame: {}", e);
                return;
            }
        };

        let spec_version = frame["specVersion"].as_str().unwrap_or("");
        let frame_type = frame["type"].as_str().unwrap_or("");
        let headers = &frame["headers"];
        let message_id = headers["messageId"].as_str().unwrap_or("");
        let topic = headers["topic"].as_str().unwrap_or("");

        ulog_debug!(
            "[dingtalk] WS frame: type={}, topic={}, specVersion={}",
            frame_type,
            topic,
            spec_version
        );

        // Handle SYSTEM frames (ping/pong, disconnect notice)
        if frame_type == "SYSTEM" {
            match topic {
                "ping" => {
                    // Echo back with same headers and opaque data
                    let pong = json!({
                        "code": 200,
                        "headers": frame["headers"],
                        "message": "OK",
                        "data": frame["data"],
                    });
                    let pong_text = serde_json::to_string(&pong).unwrap_or_default();
                    if let Err(e) = ws_write
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            pong_text.into(),
                        ))
                        .await
                    {
                        ulog_warn!("[dingtalk] Failed to send pong: {}", e);
                    }
                }
                "disconnect" => {
                    let reason = frame["data"].as_str().unwrap_or("unknown");
                    ulog_info!("[dingtalk] Server disconnect notice: {}", reason);
                    // Connection will close naturally; reconnect loop handles it
                }
                _ => {
                    ulog_debug!("[dingtalk] Unknown SYSTEM topic: {}", topic);
                }
            }
            return;
        }

        // Send ACK for CALLBACK and EVENT frames
        if (frame_type == "CALLBACK" || frame_type == "EVENT") && !message_id.is_empty() {
            // EVENT frames expect a status-bearing ACK; CALLBACK frames accept a simple ACK.
            let ack_data = if frame_type == "EVENT" {
                serde_json::to_string(&json!({"status": "SUCCESS", "message": "success"}))
                    .unwrap_or_else(|_| "{}".to_string())
            } else {
                "{}".to_string()
            };
            let ack = json!({
                "code": 200,
                "headers": {
                    "contentType": "application/json",
                    "messageId": message_id,
                },
                "message": "OK",
                "data": ack_data,
            });
            let ack_text = serde_json::to_string(&ack).unwrap_or_default();
            if let Err(e) = ws_write
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    ack_text.into(),
                ))
                .await
            {
                ulog_warn!(
                    "[dingtalk] Failed to send ACK for {} frame: {}",
                    frame_type,
                    e
                );
            }
        }

        // Handle EVENT frames (event subscriptions: group lifecycle, etc.)
        if frame_type == "EVENT" {
            let event_type = headers["eventType"].as_str().unwrap_or("");
            ulog_info!("[dingtalk] EVENT received: eventType={}", event_type);
            if let Some(data_str) = frame["data"].as_str() {
                if let Ok(data) = serde_json::from_str::<Value>(data_str) {
                    self.handle_event_frame(event_type, &data).await;
                }
            }
            return;
        }

        // Route CALLBACK frames by topic
        match topic {
            "/v1.0/im/bot/messages/get" => {
                // Bot message callback (both single chat and group chat)
                if let Some(data_str) = frame["data"].as_str() {
                    if let Ok(data) = serde_json::from_str::<Value>(data_str) {
                        self.handle_bot_message(&data).await;
                    } else {
                        ulog_warn!("[dingtalk] Failed to parse bot message data");
                    }
                }
            }
            "/v1.0/im/bot/messages/get/" => {
                // Alternative topic path (some versions include trailing slash)
                if let Some(data_str) = frame["data"].as_str() {
                    if let Ok(data) = serde_json::from_str::<Value>(data_str) {
                        self.handle_bot_message(&data).await;
                    }
                }
            }
            "/v1.0/card/instances/callback" => {
                // AI Card callback (button clicks, etc.)
                if let Some(data_str) = frame["data"].as_str() {
                    if let Ok(data) = serde_json::from_str::<Value>(data_str) {
                        self.handle_card_callback(&data).await;
                    }
                }
            }
            _ => {
                ulog_debug!("[dingtalk] Unhandled topic: {}", topic);
            }
        }
    }

    /// Handle an incoming bot message event.
    async fn handle_bot_message(&self, data: &Value) {
        let msg_id = data["msgId"].as_str().unwrap_or("");
        if msg_id.is_empty() {
            ulog_warn!("[dingtalk] Bot message missing msgId");
            return;
        }

        // Dedup check
        if !self.dedup_check(msg_id).await {
            ulog_debug!("[dingtalk] Duplicate message {}, skipping", msg_id);
            return;
        }

        let sender_staff_id = data["senderStaffId"].as_str().unwrap_or("");
        let sender_nick = data["senderNick"].as_str();
        let conversation_type = data["conversationType"].as_str().unwrap_or("1");

        // Extract text content
        let msg_type = data["msgtype"].as_str().unwrap_or("text");
        let text_content = match msg_type {
            "text" => data["text"]["content"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string(),
            "richText" => {
                // Rich text: try to extract plain text
                data["content"]["richText"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| item["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default()
            }
            _ => {
                ulog_debug!("[dingtalk] Unsupported message type: {}", msg_type);
                format!("[不支持的消息类型: {}]", msg_type)
            }
        };

        if text_content.is_empty() {
            ulog_debug!("[dingtalk] Empty message content, skipping");
            return;
        }

        // Determine source type and chat_id
        let (source_type, chat_id, is_mention) = if conversation_type == "2" {
            // Group chat
            let open_conversation_id = data["conversationId"].as_str().unwrap_or("");
            let chat_id_full = format!("group:{}", open_conversation_id);

            // Detect new group: if this conversationId hasn't been seen before,
            // emit GroupEvent::BotAdded so the whitelist/approval flow triggers.
            {
                let mut groups = self.known_groups.lock().await;
                if !groups.contains(&chat_id_full) {
                    groups.insert(chat_id_full.clone());
                    let conversation_title = data["conversationTitle"]
                        .as_str()
                        .unwrap_or("Unknown Group")
                        .to_string();
                    let added_by = sender_nick.map(String::from);
                    ulog_info!(
                        "[dingtalk] New group detected: {} ({})",
                        conversation_title,
                        chat_id_full
                    );
                    if self
                        .group_event_tx
                        .send(GroupEvent::BotAdded {
                            chat_id: chat_id_full.clone(),
                            chat_title: conversation_title,
                            platform: ImPlatform::Dingtalk,
                            added_by_name: added_by,
                        })
                        .await
                        .is_err()
                    {
                        ulog_error!("[dingtalk] Group event channel closed");
                    }
                }
            }

            let is_in_at_list = data["isInAtList"]
                .as_bool()
                .or_else(|| data["isInAtList"].as_str().map(|s| s == "true"))
                .unwrap_or(false);
            (ImSourceType::Group, chat_id_full, is_in_at_list)
        } else {
            // Private chat (1:1)
            (ImSourceType::Private, sender_staff_id.to_string(), true)
        };

        let msg = ImMessage {
            chat_id,
            message_id: msg_id.to_string(),
            text: text_content,
            sender_id: sender_staff_id.to_string(),
            sender_name: sender_nick.map(String::from),
            account_id: None,
            source_type,
            platform: ImPlatform::Dingtalk,
            timestamp: chrono::Utc::now(),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention,
            reply_to_bot: false,
            hint_group_name: None,
            reply_to_body: None,
            group_system_prompt: None,
            request_id: String::new(),
            delivery_protocol: None,
        };

        let text_preview: String = msg.text.chars().take(100).collect();
        ulog_info!(
            "[dingtalk] Received message from {} ({}): {}",
            sender_staff_id,
            msg.source_type == ImSourceType::Group,
            text_preview
        );

        if let Err(e) = self.msg_tx.send(msg).await {
            ulog_error!("[dingtalk] Failed to send message to channel: {}", e);
        }
    }

    /// Handle AI Card callback (button clicks for approval, etc.).
    async fn handle_card_callback(&self, data: &Value) {
        let action = data["action"].as_str().unwrap_or("");
        let out_track_id = data["outTrackId"].as_str().unwrap_or("");
        ulog_debug!(
            "[dingtalk] Card callback: action={}, outTrackId={}",
            action,
            out_track_id
        );

        // Card callbacks for approval will be handled if we implement interactive cards
        // For now, approvals are text-based
    }

    /// Handle DingTalk EVENT frame (event subscription: group lifecycle, etc.)
    ///
    /// Event types relevant to group lifecycle (from DingTalk event subscription):
    ///  - `chat_add_member`    — member added to group (user or bot)
    ///  - `chat_remove_member` — member removed from group
    ///  - `chat_disband`       — group dissolved
    async fn handle_event_frame(&self, event_type: &str, data: &Value) {
        match event_type {
            // Bot added to a group (enterprise internal bot event subscription).
            // Payload: { openConversationId, robotCode, coolAppCode, operator, operateTime }
            // NOTE: Group name is NOT in the payload; we use a placeholder here.
            // The first-message detection in handle_bot_message has conversationTitle
            // and may fire first (or simultaneously), so mod.rs deduplicates via
            // "already approved" check.
            "im_cool_app_install" => {
                let open_conv_id = data["openConversationId"].as_str().unwrap_or("");
                if open_conv_id.is_empty() {
                    ulog_warn!("[dingtalk] im_cool_app_install missing openConversationId");
                    return;
                }
                let chat_id = format!("group:{}", open_conv_id);

                // Check if already known (first-message detection may have fired first)
                let is_new = {
                    let mut groups = self.known_groups.lock().await;
                    groups.insert(chat_id.clone())
                };
                if !is_new {
                    ulog_debug!(
                        "[dingtalk] Group {} already known, skipping im_cool_app_install",
                        chat_id
                    );
                    return;
                }

                let operator = data["operator"].as_str().unwrap_or("").to_string();
                let added_by = if operator.is_empty() {
                    None
                } else {
                    Some(operator)
                };

                ulog_info!("[dingtalk] Bot added to group via event: {}", chat_id);
                if self
                    .group_event_tx
                    .send(GroupEvent::BotAdded {
                        chat_id,
                        chat_title: "新群聊".to_string(),
                        platform: ImPlatform::Dingtalk,
                        added_by_name: added_by,
                    })
                    .await
                    .is_err()
                {
                    ulog_error!("[dingtalk] Group event channel closed");
                }
            }
            "chat_disband" => {
                // Group dissolved — bot is definitely no longer in the group.
                let chat_id_raw = data["ChatId"]
                    .as_str()
                    .or_else(|| data["chatId"].as_str())
                    .or_else(|| data["openConversationId"].as_str())
                    .unwrap_or("");
                if chat_id_raw.is_empty() {
                    ulog_warn!("[dingtalk] chat_disband event missing chat ID");
                    return;
                }
                let chat_id = format!("group:{}", chat_id_raw);

                self.known_groups.lock().await.remove(&chat_id);

                ulog_info!("[dingtalk] Group disbanded: {}", chat_id);
                if self
                    .group_event_tx
                    .send(GroupEvent::BotRemoved {
                        chat_id,
                        platform: ImPlatform::Dingtalk,
                    })
                    .await
                    .is_err()
                {
                    ulog_error!("[dingtalk] Group event channel closed");
                }
            }
            "chat_remove_member" => {
                // Generic member-removed event — fires for ANY member, not just the bot.
                // We cannot reliably determine if the bot itself was removed because the
                // payload's UserId[] contains user IDs (not robot codes).
                // Log for debugging; the bot will simply stop receiving messages from that
                // group if it was the one removed, and the group record stays harmlessly.
                let chat_id_raw = data["ChatId"]
                    .as_str()
                    .or_else(|| data["chatId"].as_str())
                    .or_else(|| data["openConversationId"].as_str())
                    .unwrap_or("");
                ulog_debug!(
                    "[dingtalk] chat_remove_member in group:{} (not treated as bot removal)",
                    chat_id_raw
                );
            }
            _ => {
                ulog_debug!("[dingtalk] Unhandled event type: {}", event_type);
            }
        }
    }
}

// ===== ImAdapter trait implementation =====

impl super::adapter::ImAdapter for DingtalkAdapter {
    async fn verify_connection(&self) -> super::adapter::AdapterResult<String> {
        self.get_bot_info().await
    }

    async fn register_commands(&self) -> super::adapter::AdapterResult<()> {
        // DingTalk does not support command registration via API
        Ok(())
    }

    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        self.ws_listen_loop(shutdown_rx).await;
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> super::adapter::AdapterResult<()> {
        self.send_text_message(chat_id, text).await?;
        Ok(())
    }

    async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
        // DingTalk has no reaction/ack mechanism
    }

    async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
        // DingTalk has no reaction/ack mechanism
    }

    async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
        // DingTalk has no reaction/ack mechanism
    }

    async fn send_typing(&self, _chat_id: &str) {
        // DingTalk has no typing indicator
    }
}

// ===== ImStreamAdapter trait implementation =====

impl super::adapter::ImStreamAdapter for DingtalkAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<Option<String>> {
        if self.use_ai_card && self.card_template_id.is_some() {
            // AI Card mode: create card and return outTrackId as message_id.
            // On failure, degrade to regular Markdown.
            match self.create_ai_card(chat_id, text).await {
                Ok(out_track_id) => return Ok(Some(out_track_id)),
                Err(e) => {
                    ulog_warn!(
                        "[dingtalk] AI Card creation failed, falling back to Markdown: {}",
                        e
                    );
                    // Fall through to regular send below
                }
            }
        }
        // Non-card mode (or card fallback): DON'T send here.
        // Return Ok(None) so the stream pipeline skips intermediate edits.
        // The complete text will be sent once at block-end via finalize_block → send_message.
        Ok(None)
    }

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.edit_text_message(chat_id, message_id, text).await
    }

    async fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.delete_text_message(chat_id, message_id).await
    }

    fn max_message_length(&self) -> usize {
        MAX_MESSAGE_LENGTH
    }

    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.edit_message(chat_id, message_id, text).await
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
    }

    async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.update_approval_status(chat_id, message_id, status)
            .await
    }

    async fn send_photo(
        &self,
        chat_id: &str,
        _data: Vec<u8>,
        _filename: &str,
        caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        // DingTalk Robot API doesn't support direct image upload via robot messages.
        // Send caption as text fallback.
        let text = caption.unwrap_or("[图片]");
        self.send_text_message(chat_id, text).await
    }

    async fn send_file(
        &self,
        chat_id: &str,
        _data: Vec<u8>,
        filename: &str,
        _mime_type: &str,
        caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        // DingTalk Robot API doesn't support direct file upload via robot messages.
        // Send caption + filename as text fallback.
        let text = if let Some(cap) = caption {
            format!("📎 {}\n\n{}", filename, cap)
        } else {
            format!("📎 {}", filename)
        };
        self.send_text_message(chat_id, &text).await
    }

    /// Pattern C: trait-based dispatch for AI Card finalization. Forwards to
    /// the existing inherent method `Self::post_stream_cleanup`.
    async fn post_stream_cleanup(&self, chat_id: &str) {
        DingtalkAdapter::post_stream_cleanup(self, chat_id).await;
    }
}
