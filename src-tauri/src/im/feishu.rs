// Feishu (Lark) Bot adapter
// Handles WebSocket long connection, message sending/editing/deleting,
// tenant_access_token management, and event parsing.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::sleep;

use prost::Message as ProstMessage;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::types::{
    AskUserQuestionItem, AskUserQuestionPayload, GroupEvent, ImAttachment, ImAttachmentType,
    ImConfig, ImMessage, ImPlatform, ImSourceType,
};
use super::util::{mime_to_ext, sanitize_filename};
use super::{ApprovalCallback, QuestionCallback};
use crate::{proxy_config, ulog_debug, ulog_error, ulog_info, ulog_warn};

// ── Feishu WebSocket Protobuf Frame ──────────────────────────
// Matches the official larksuite/oapi-sdk-go Frame definition (pbbp2.pb.go).
// Feishu WS sends ONLY binary protobuf frames — text frames are never used.

#[derive(Clone, PartialEq, ProstMessage)]
struct WsFrame {
    #[prost(uint64, tag = 1)]
    seq_id: u64,
    #[prost(uint64, tag = 2)]
    log_id: u64,
    #[prost(int32, tag = 3)]
    service: i32,
    #[prost(int32, tag = 4)]
    method: i32, // 0 = control, 1 = data
    #[prost(message, repeated, tag = 5)]
    headers: Vec<WsHeader>,
    #[prost(string, optional, tag = 6)]
    payload_encoding: Option<String>,
    #[prost(string, optional, tag = 7)]
    payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = 8)]
    payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = 9)]
    log_id_new: Option<String>,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct WsHeader {
    #[prost(string, tag = 1)]
    key: String,
    #[prost(string, tag = 2)]
    value: String,
}

/// Frame method constants (from official SDK)
const FRAME_METHOD_CONTROL: i32 = 0;
const FRAME_METHOD_DATA: i32 = 1;

/// Dedup cache TTL (72 hours — matching Feishu's max event retry window).
/// Feishu retransmits unACKed events on reconnect with exponential backoff for up to 72h.
const DEDUP_TTL_SECS: u64 = 72 * 60 * 60;
/// Max dedup cache size before forced cleanup
const DEDUP_MAX_SIZE: usize = 5000;
/// Minimum interval between dedup disk writes (ms) to coalesce bursts
const DEDUP_PERSIST_INTERVAL_MS: u64 = 500;

/// Feishu API base URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn/open-apis";
/// Token refresh margin (refresh when < 10 min remaining)
const TOKEN_REFRESH_MARGIN_SECS: u64 = 600;
/// Token validity period (Feishu tokens are valid for 2 hours)
const TOKEN_VALIDITY_SECS: u64 = 7200;
/// WebSocket reconnect initial backoff
const WS_INITIAL_BACKOFF_SECS: u64 = 1;
/// WebSocket reconnect max backoff
const WS_MAX_BACKOFF_SECS: u64 = 60;
/// WebSocket read timeout: if no data (including server pings) is received
/// within this period, the connection is assumed dead and will be reconnected.
/// With client-side pings every 30s, 120s means ~4 missed pings → truly dead.
const WS_READ_TIMEOUT_SECS: u64 = 120;
/// Client-side WebSocket ping interval. Keeps NAT/firewall mappings alive
/// and enables faster dead-connection detection.
const WS_PING_INTERVAL_SECS: u64 = 30;

/// Persist dedup cache to disk (atomic: write tmp → rename).
/// Free function so it can be used from `spawn_blocking` ('static closure).
fn save_dedup_cache_to_disk(path: &std::path::Path, cache: &HashMap<String, u64>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp_path = path.with_extension("json.tmp.dedup");
    match serde_json::to_string(cache) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&tmp_path, &json) {
                ulog_warn!("[feishu] Failed to write dedup cache tmp: {}", e);
                return;
            }
            if let Err(e) = std::fs::rename(&tmp_path, path) {
                ulog_warn!("[feishu] Failed to rename dedup cache: {}", e);
            }
        }
        Err(e) => {
            ulog_warn!("[feishu] Failed to serialize dedup cache: {}", e);
        }
    }
}

/// Cached tenant access token
struct TokenCache {
    access_token: String,
    expires_at: Instant,
}

// ── Markdown → Feishu Post converter ─────────────────────────

/// List tracking state for nested lists
enum ListKind {
    Unordered,
    Ordered(u64), // current item number
}

/// Safe single-message size limit (bytes). Feishu API has a ~150KB request body limit.
/// After markdown→Post JSON conversion + double JSON encoding, 15000 bytes of raw markdown
/// is a conservative safe ceiling for a single message.
const FEISHU_SPLIT_THRESHOLD: usize = 15000;

// ── Card Kit v2.0 helpers ──────────────────────────────────────

/// Check if text contains markdown tables or fenced code blocks that benefit
/// from Card Kit v2.0 native rendering (instead of Post rich-text).
fn should_use_card(text: &str) -> bool {
    // 1. Fenced code block
    if text.contains("```") {
        return true;
    }
    // 2. Markdown table (header row + separator row)
    has_markdown_table(text)
}

/// Detect markdown table: a `|---|` separator row preceded by a `|...|` header row.
fn has_markdown_table(text: &str) -> bool {
    let mut prev_is_pipe_row = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if is_table_separator(trimmed) && prev_is_pipe_row {
            return true;
        }
        prev_is_pipe_row = trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() > 1;
    }
    false
}

/// Check if a line is a markdown table separator like `|---|---|` or `|:---:|---:|`.
fn is_table_separator(line: &str) -> bool {
    if !line.starts_with('|') || !line.ends_with('|') || line.len() < 5 {
        return false;
    }
    let inner = &line[1..line.len() - 1];
    inner.chars().all(|c| matches!(c, '-' | ':' | '|' | ' ')) && inner.contains('-')
}

/// Strip `**bold**` markers from markdown table rows.
/// Feishu Card Kit renders tables natively but doesn't parse inline formatting in cells.
fn strip_bold_in_table_rows(text: &str) -> String {
    let mut result = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let is_table_row = trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() > 1;
        if is_table_row && trimmed.contains("**") {
            result.push(line.replace("**", ""));
        } else {
            result.push(line.to_string());
        }
    }
    result.join("\n")
}

/// Build a Card Kit v2.0 JSON structure with a single markdown element.
fn build_markdown_card(text: &str) -> Value {
    let content = strip_bold_in_table_rows(text);
    json!({
        "schema": "2.0",
        "config": { "wide_screen_mode": true },
        "body": {
            "elements": [{
                "tag": "markdown",
                "content": content,
            }]
        }
    })
}

/// Convert Markdown text to Feishu Post rich-text format.
/// Returns a serde_json::Value with the structure: {"zh_cn": {"content": [[...], ...]}}
fn markdown_to_feishu_post(md: &str) -> Value {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(md, opts);

    let mut paragraphs: Vec<Vec<Value>> = Vec::new();
    let mut current_line: Vec<Value> = Vec::new();
    let mut styles: Vec<String> = Vec::new();
    let mut link_url: Option<String> = None;
    let mut in_code_block = false;
    let mut code_block_buf = String::new();
    let mut list_stack: Vec<ListKind> = Vec::new();
    let mut item_prefix: Option<String> = None;
    let mut in_blockquote = false;

    for event in parser {
        match event {
            Event::Start(Tag::Strong) => {
                styles.push("bold".to_string());
            }
            Event::End(TagEnd::Strong) => {
                styles.retain(|s| s != "bold");
            }
            Event::Start(Tag::Emphasis) => {
                styles.push("italic".to_string());
            }
            Event::End(TagEnd::Emphasis) => {
                styles.retain(|s| s != "italic");
            }
            Event::Start(Tag::Strikethrough) => {
                styles.push("strikethrough".to_string());
            }
            Event::End(TagEnd::Strikethrough) => {
                styles.retain(|s| s != "strikethrough");
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link_url = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                link_url = None;
            }
            Event::Start(Tag::Heading { .. }) => {
                // Flush any pending line
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                styles.push("bold".to_string());
            }
            Event::End(TagEnd::Heading(_)) => {
                styles.retain(|s| s != "bold");
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::Paragraph) => {
                // Nothing special needed
            }
            Event::End(TagEnd::Paragraph) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::BlockQuote(_)) => {
                in_blockquote = true;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                in_blockquote = false;
            }
            Event::Start(Tag::List(start)) => match start {
                Some(n) => list_stack.push(ListKind::Ordered(n)),
                None => list_stack.push(ListKind::Unordered),
            },
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
            }
            Event::Start(Tag::Item) => {
                // Generate prefix based on current list context
                let indent = "  ".repeat(list_stack.len().saturating_sub(1));
                let bq = if in_blockquote { "│ " } else { "" };
                if let Some(list_kind) = list_stack.last_mut() {
                    match list_kind {
                        ListKind::Unordered => {
                            item_prefix = Some(format!("{}{}• ", bq, indent));
                        }
                        ListKind::Ordered(n) => {
                            item_prefix = Some(format!("{}{}{}. ", bq, indent, n));
                            *n += 1;
                        }
                    }
                }
            }
            Event::End(TagEnd::Item) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                in_code_block = true;
                code_block_buf.clear();
                // Extract language hint if present (take first word, ignore metadata)
                if let CodeBlockKind::Fenced(lang) = kind {
                    let lang_str = lang.split_whitespace().next().unwrap_or("").to_string();
                    if !lang_str.is_empty() {
                        code_block_buf.push_str(&format!("[{}]\n", lang_str));
                    }
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let buf = std::mem::take(&mut code_block_buf);
                if buf.trim().is_empty() {
                    // Skip empty code blocks
                } else {
                    // Wrap code block with visual separator (Feishu Post has no native code block)
                    paragraphs.push(vec![json!({"tag": "text", "text": "─── ✦ ───"})]);
                    for line in buf.lines() {
                        paragraphs.push(vec![json!({
                            "tag": "text",
                            "text": format!("  {}", line),
                            "style": ["italic"],
                        })]);
                    }
                    paragraphs.push(vec![json!({"tag": "text", "text": "─── ✦ ───"})]);
                }
            }
            Event::Text(text) => {
                if in_code_block {
                    code_block_buf.push_str(&text);
                    continue;
                }

                let text_str = text.to_string();

                // Handle blockquote prefix
                let display_text =
                    if in_blockquote && current_line.is_empty() && item_prefix.is_none() {
                        format!("│ {}", text_str)
                    } else {
                        text_str
                    };

                // Prepend item prefix if any
                let final_text = if let Some(prefix) = item_prefix.take() {
                    format!("{}{}", prefix, display_text)
                } else {
                    display_text
                };

                if let Some(ref url) = link_url {
                    // Link element
                    current_line.push(json!({
                        "tag": "a",
                        "text": final_text,
                        "href": url,
                    }));
                } else if !styles.is_empty() {
                    // Styled text
                    current_line.push(json!({
                        "tag": "text",
                        "text": final_text,
                        "style": styles.clone(),
                    }));
                } else {
                    // Plain text
                    current_line.push(json!({
                        "tag": "text",
                        "text": final_text,
                    }));
                }
            }
            Event::Code(code) => {
                // Inline code: map to bold+italic (Feishu has no inline code style)
                let code_text = code.to_string();
                if let Some(prefix) = item_prefix.take() {
                    // Emit prefix as plain text, then code as styled
                    current_line.push(json!({"tag": "text", "text": prefix}));
                }
                current_line.push(json!({
                    "tag": "text",
                    "text": code_text,
                    "style": ["bold", "italic"],
                }));
            }
            Event::SoftBreak => {
                // Flush current line as a paragraph
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::HardBreak => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Rule => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                paragraphs.push(vec![json!({"tag": "text", "text": "───────"})]);
            }
            _ => {}
        }
    }

    // Flush any remaining content
    if !current_line.is_empty() {
        paragraphs.push(current_line);
    }

    // If no content was parsed, return a single empty paragraph
    if paragraphs.is_empty() {
        paragraphs.push(vec![json!({"tag": "text", "text": md})]);
    }

    json!({
        "zh_cn": {
            "content": paragraphs
        }
    })
}

// ── Feishu Post → plain text converter (receive direction) ──

/// Extract plain text from a Feishu Post rich-text content JSON.
///
/// Post content structure (received):
/// ```json
/// { "title": "...", "content": [[{"tag":"text","text":"..."}, ...], ...] }
/// ```
/// Or wrapped in a locale key:
/// ```json
/// { "zh_cn": { "title": "...", "content": [[...]] } }
/// ```
fn feishu_post_to_text(content: &Value) -> String {
    // Post content may be wrapped in a locale key (zh_cn / en_us / etc.)
    // Direct structure: {"title": "...", "content": [[...]]}
    // Locale-wrapped:  {"zh_cn": {"title": "...", "content": [[...]]}}
    let post = if let Some(obj) = content.as_object() {
        if obj.get("content").map_or(false, |v| v.is_array()) {
            // Direct structure — "content" is the paragraph array
            content
        } else {
            // Locale-wrapped — prefer zh_cn, fallback to first available
            obj.get("zh_cn")
                .or_else(|| obj.get("en_us"))
                .or_else(|| obj.values().next())
                .unwrap_or(content)
        }
    } else {
        content
    };

    let mut lines: Vec<String> = Vec::new();

    // Optional title
    if let Some(title) = post["title"].as_str() {
        if !title.is_empty() {
            lines.push(title.to_string());
        }
    }

    // Paragraphs: [[element, ...], ...]
    if let Some(paragraphs) = post["content"].as_array() {
        for para in paragraphs {
            if let Some(elements) = para.as_array() {
                let mut line_parts: Vec<String> = Vec::new();
                for elem in elements {
                    let tag = elem["tag"].as_str().unwrap_or("");
                    match tag {
                        "text" => {
                            if let Some(t) = elem["text"].as_str() {
                                line_parts.push(t.to_string());
                            }
                        }
                        "a" => {
                            // Hyperlink: show text + URL
                            let text = elem["text"].as_str().unwrap_or("");
                            let href = elem["href"].as_str().unwrap_or("");
                            if !href.is_empty() && text != href {
                                line_parts.push(format!("{} ({})", text, href));
                            } else if !text.is_empty() {
                                line_parts.push(text.to_string());
                            } else {
                                line_parts.push(href.to_string());
                            }
                        }
                        "at" => {
                            let name = elem["user_name"].as_str().unwrap_or("@someone");
                            line_parts.push(format!("@{}", name));
                        }
                        "img" => {
                            line_parts.push("[图片]".to_string());
                        }
                        "media" => {
                            line_parts.push("[附件]".to_string());
                        }
                        "code_block" => {
                            // Undocumented but may appear; try to extract text/code
                            if let Some(t) = elem["text"].as_str().or(elem["code"].as_str()) {
                                line_parts.push(format!("```\n{}\n```", t));
                            } else {
                                ulog_debug!(
                                    "[feishu] code_block element has no text/code: {}",
                                    elem
                                );
                            }
                        }
                        "emotion" => {
                            let emoji = elem["emoji_type"].as_str().unwrap_or("emoji");
                            line_parts.push(format!("[{}]", emoji));
                        }
                        other => {
                            // Unknown tag — best effort: extract text field if present
                            ulog_debug!(
                                "[feishu] Unknown post element tag: '{}', elem: {}",
                                other,
                                elem
                            );
                            if let Some(t) = elem["text"].as_str() {
                                line_parts.push(t.to_string());
                            }
                        }
                    }
                }
                lines.push(line_parts.join(""));
            }
        }
    }

    lines.join("\n")
}

/// Extract all image_key values from a Feishu Post rich-text content.
/// Post structure: {"zh_cn": {"content": [[{"tag": "img", "image_key": "img_xxx"}, ...], ...]}}
fn extract_post_image_keys(content: &Value) -> Vec<String> {
    let mut keys = Vec::new();

    // Navigate to paragraphs (same locale-unwrapping logic as feishu_post_to_text)
    let post = if let Some(obj) = content.as_object() {
        if obj.get("content").map_or(false, |v| v.is_array()) {
            content
        } else {
            obj.get("zh_cn")
                .or_else(|| obj.get("en_us"))
                .or_else(|| obj.values().next())
                .unwrap_or(content)
        }
    } else {
        content
    };

    if let Some(paragraphs) = post["content"].as_array() {
        for para in paragraphs {
            if let Some(elements) = para.as_array() {
                for elem in elements {
                    let tag = elem["tag"].as_str().unwrap_or("");
                    if tag == "img" {
                        if let Some(key) = elem["image_key"].as_str() {
                            if !key.is_empty() {
                                keys.push(key.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    keys
}

/// Feishu Bot API adapter
pub struct FeishuAdapter {
    app_id: String,
    app_secret: String,
    client: Client,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
    /// Serializes token refresh to prevent concurrent refreshes
    token_refresh_lock: Arc<tokio::sync::Mutex<()>>,
    msg_tx: mpsc::Sender<ImMessage>,
    allowed_users: Arc<RwLock<Vec<String>>>,
    bot_name: Arc<RwLock<Option<String>>>,
    /// Message dedup cache: message_id → unix_timestamp_secs (72h TTL, disk-persisted)
    dedup_cache: Arc<Mutex<HashMap<String, u64>>>,
    /// Path for persisting dedup cache across restarts
    dedup_persist_path: Option<PathBuf>,
    /// Epoch millis of last dedup disk write (debounce: at most once per 500ms)
    dedup_last_persist_ms: AtomicU64,
    /// Channel for forwarding approval callbacks from card button clicks
    approval_tx: mpsc::Sender<ApprovalCallback>,
    /// Channel for forwarding AskUserQuestion callbacks from card buttons
    question_tx: mpsc::Sender<QuestionCallback>,
    /// Channel for group lifecycle events (bot added/removed from groups)
    group_event_tx: mpsc::Sender<GroupEvent>,
    /// Bot's own open_id (for @mention and reply-to-bot detection)
    bot_open_id: Arc<RwLock<Option<String>>>,
    /// User name cache: open_id → (display_name, fetched_at)
    /// LRU-style: max 1000 entries, 24h TTL
    user_name_cache: Arc<Mutex<HashMap<String, (String, std::time::Instant)>>>,
    /// Known group chat_ids for auto-discovery (same pattern as DingTalk).
    /// Pre-populated from persisted group_permissions on startup.
    known_groups: Arc<Mutex<HashSet<String>>>,
}

impl FeishuAdapter {
    pub fn new(
        config: &ImConfig,
        msg_tx: mpsc::Sender<ImMessage>,
        allowed_users: Arc<RwLock<Vec<String>>>,
        approval_tx: mpsc::Sender<ApprovalCallback>,
        question_tx: mpsc::Sender<QuestionCallback>,
        dedup_path: Option<PathBuf>,
        group_event_tx: mpsc::Sender<GroupEvent>,
    ) -> Self {
        // External host (open.feishu.cn / open.larksuite.com) — system proxy wanted.
        #[allow(clippy::disallowed_methods)]
        let client_builder = Client::builder().timeout(Duration::from_secs(30));
        let client = proxy_config::build_client_with_proxy(client_builder).unwrap_or_else(|e| {
            ulog_warn!(
                "[feishu] Failed to build client with proxy: {}, falling back to direct",
                e
            );
            #[allow(clippy::disallowed_methods)]
            Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client")
        });

        // Load dedup cache from disk (survives app restart)
        let dedup_cache = Self::load_dedup_cache(dedup_path.as_deref());

        // Pre-populate known groups from persisted group_permissions so we don't
        // re-trigger BotAdded for already-discovered groups on restart.
        let known_groups: HashSet<String> = config
            .group_permissions
            .iter()
            .map(|gp| gp.group_id.clone())
            .collect();

        Self {
            app_id: config.feishu_app_id.clone().unwrap_or_default(),
            app_secret: config.feishu_app_secret.clone().unwrap_or_default(),
            client,
            token_cache: Arc::new(RwLock::new(None)),
            token_refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            msg_tx,
            allowed_users,
            bot_name: Arc::new(RwLock::new(None)),
            dedup_cache: Arc::new(Mutex::new(dedup_cache)),
            dedup_persist_path: dedup_path,
            dedup_last_persist_ms: AtomicU64::new(0),
            approval_tx,
            question_tx,
            group_event_tx,
            bot_open_id: Arc::new(RwLock::new(None)),
            user_name_cache: Arc::new(Mutex::new(HashMap::new())),
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
                        "[feishu] Loaded dedup cache from disk: {} entries ({} expired)",
                        cache.len(),
                        before - cache.len()
                    );
                    cache
                }
                Err(e) => {
                    ulog_warn!("[feishu] Failed to parse dedup cache file: {}", e);
                    HashMap::new()
                }
            },
            Err(e) => {
                ulog_warn!("[feishu] Failed to read dedup cache file: {}", e);
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
                "[feishu] Dedup cache flushed to disk ({} entries)",
                snapshot.len()
            );
        }
    }

    // ===== Token management =====

    /// Get a valid tenant access token, refreshing if expired.
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

        // Refresh token
        self.refresh_token().await
    }

    /// Request a new tenant_access_token from Feishu.
    /// Uses a Mutex to prevent concurrent refresh requests (race condition).
    async fn refresh_token(&self) -> Result<String, String> {
        let _guard = self.token_refresh_lock.lock().await;

        // Double-check: another caller may have refreshed while we waited for the lock
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if Instant::now() < tc.expires_at {
                    return Ok(tc.access_token.clone());
                }
            }
        }

        let url = format!("{}/auth/v3/tenant_access_token/internal", FEISHU_API_BASE);
        let body = json!({
            "app_id": self.app_id,
            "app_secret": self.app_secret,
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

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            return Err(format!(
                "Token request error code {}: {}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }

        let token = json["tenant_access_token"]
            .as_str()
            .ok_or_else(|| "No tenant_access_token in response".to_string())?
            .to_string();

        let expire = json["expire"].as_u64().unwrap_or(TOKEN_VALIDITY_SECS);
        let expires_at =
            Instant::now() + Duration::from_secs(expire.saturating_sub(TOKEN_REFRESH_MARGIN_SECS));

        // Update cache
        {
            let mut cache = self.token_cache.write().await;
            *cache = Some(TokenCache {
                access_token: token.clone(),
                expires_at,
            });
        }

        ulog_info!("[feishu] Token refreshed, expires in {}s", expire);
        Ok(token)
    }

    /// Make an authenticated API call, auto-retrying on 401 (token expired).
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
                "PATCH" => self.client.patch(url),
                _ => self.client.post(url),
            };

            req = req.header("Authorization", format!("Bearer {}", token));

            if let Some(b) = body {
                req = req.json(b);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("Feishu API error: {}", e))?;

            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();

            // Handle 401 — refresh token and retry once
            if status.as_u16() == 401 && retries == 0 {
                ulog_warn!("[feishu] Got 401, refreshing token and retrying");
                // Invalidate cache
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            let json: Value = serde_json::from_str(&text)
                .map_err(|e| format!("API response parse error: {}", e))?;

            let code = json["code"].as_i64().unwrap_or(-1);
            if code == 0 {
                return Ok(json);
            }

            // Token invalid error codes
            if (code == 99991663 || code == 99991661) && retries == 0 {
                ulog_warn!("[feishu] Token invalid (code {}), refreshing", code);
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            return Err(format!(
                "Feishu API error code {}: {}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }
    }

    // ===== Resource download =====

    /// Download a message resource (image/file) from Feishu.
    /// API: GET /im/v1/messages/{message_id}/resources/{file_key}?type=image|file
    /// Returns (data, content_type). Retries once on 401 (token expired).
    async fn download_resource(
        &self,
        message_id: &str,
        file_key: &str,
        resource_type: &str,
    ) -> Result<(Vec<u8>, String), String> {
        /// Maximum file download size (20 MB)
        const MAX_DOWNLOAD_SIZE: usize = 20 * 1024 * 1024;

        let url = format!(
            "{}/im/v1/messages/{}/resources/{}?type={}",
            FEISHU_API_BASE, message_id, file_key, resource_type
        );

        let mut retries = 0;
        loop {
            let token = self.get_token().await?;
            let resp = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", token))
                .send()
                .await
                .map_err(|e| format!("Resource download error: {}", e))?;

            // Handle 401 — refresh token and retry once
            if resp.status().as_u16() == 401 && retries == 0 {
                ulog_warn!("[feishu] Resource download got 401, refreshing token");
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            if !resp.status().is_success() {
                return Err(format!(
                    "Resource download HTTP {} for {}",
                    resp.status(),
                    file_key
                ));
            }

            // Strip parameters from content-type (e.g. "image/jpeg; charset=utf-8" → "image/jpeg")
            // Claude API's media_type expects a clean MIME type without parameters.
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or("application/octet-stream")
                .trim()
                .to_string();

            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Resource read error: {}", e))?;

            if bytes.len() > MAX_DOWNLOAD_SIZE {
                return Err(format!(
                    "Resource too large: {} bytes (max {})",
                    bytes.len(),
                    MAX_DOWNLOAD_SIZE
                ));
            }

            ulog_info!(
                "[feishu] Downloaded resource: {} ({} bytes, {})",
                file_key,
                bytes.len(),
                content_type
            );
            return Ok((bytes.to_vec(), content_type));
        }
    }

    // ===== Bot info =====

    /// Get bot info to verify credentials.
    async fn get_bot_info(&self) -> Result<String, String> {
        let url = format!("{}/bot/v3/info", FEISHU_API_BASE);
        let resp = self.api_call("GET", &url, None).await?;

        let bot = &resp["bot"];
        let name = bot["app_name"].as_str().unwrap_or("Feishu Bot");
        *self.bot_name.write().await = Some(name.to_string());
        // Store bot's open_id for @mention and reply-to-bot detection
        if let Some(open_id) = bot["open_id"].as_str() {
            *self.bot_open_id.write().await = Some(open_id.to_string());
            ulog_info!("[feishu] Bot open_id: {}", open_id);
        }
        Ok(name.to_string())
    }

    // ===== Message operations =====

    /// Send a rich-text (post) message and return the message_id.
    /// Automatically converts Markdown to Feishu Post format.
    /// Always uses Post format — for streaming drafts and explicit Post-only paths.
    pub async fn send_post_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let post_content = markdown_to_feishu_post(text);
        let content = serde_json::to_string(&post_content).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "post",
            "content": content,
        });

        let resp = self.api_call("POST", &url, Some(&body)).await?;
        let msg_id = resp["data"]["message_id"].as_str().map(String::from);
        Ok(msg_id)
    }

    /// Auto-detecting send: Card Kit v2.0 for table/code content, Post for plain text.
    /// Automatically splits messages that exceed the safe size limit into multiple sends.
    pub async fn send_text_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> Result<Option<String>, String> {
        if text.len() <= FEISHU_SPLIT_THRESHOLD {
            // Single message — use auto-detect (Card or Post)
            return if should_use_card(text) {
                self.send_card_message(chat_id, text).await
            } else {
                self.send_post_message(chat_id, text).await
            };
        }

        // Split and send as multiple messages
        let chunks = super::adapter::split_message(text, FEISHU_SPLIT_THRESHOLD);
        let total = chunks.len();
        let mut last_msg_id = None;
        for (i, chunk) in chunks.iter().enumerate() {
            let decorated = if total == 1 {
                chunk.clone()
            } else if i < total - 1 {
                format!("{}\n\n_(续…)_", chunk)
            } else {
                format!("_(接上条)_\n\n{}", chunk)
            };
            // Each chunk uses auto-detect independently
            let msg_id = if should_use_card(&decorated) {
                self.send_card_message(chat_id, &decorated).await?
            } else {
                self.send_post_message(chat_id, &decorated).await?
            };
            last_msg_id = msg_id;
        }
        Ok(last_msg_id)
    }

    /// Send a Card Kit v2.0 interactive message with markdown content.
    async fn send_card_message(&self, chat_id: &str, text: &str) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let card = build_markdown_card(text);
        let content = serde_json::to_string(&card).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": content,
        });

        let resp = self.api_call("POST", &url, Some(&body)).await?;
        let msg_id = resp["data"]["message_id"].as_str().map(String::from);
        Ok(msg_id)
    }

    /// Edit an existing Card message (PATCH, not PUT).
    #[allow(dead_code)]
    async fn edit_card_message(&self, message_id: &str, text: &str) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        let card = build_markdown_card(text);
        let card_str = serde_json::to_string(&card).unwrap_or_default();
        let body = json!({ "content": card_str });

        self.api_call("PATCH", &url, Some(&body)).await?;
        Ok(())
    }

    /// Upload an image to Feishu and return the image_key.
    /// Two-step process: upload → get key, then use key to send message.
    async fn upload_image(&self, data: Vec<u8>, filename: &str) -> Result<String, String> {
        let url = format!("{}/im/v1/images", FEISHU_API_BASE);
        let mut retries = 0;

        loop {
            let token = self.get_token().await?;

            let image_part = reqwest::multipart::Part::bytes(data.clone())
                .file_name(filename.to_string())
                .mime_str("application/octet-stream")
                .map_err(|e| format!("Failed to create multipart: {}", e))?;

            let form = reqwest::multipart::Form::new()
                .text("image_type", "message")
                .part("image", image_part);

            let resp = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .multipart(form)
                .send()
                .await
                .map_err(|e| format!("Image upload failed: {}", e))?;

            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();

            // Handle 401 — refresh token and retry once
            if status.as_u16() == 401 && retries == 0 {
                ulog_warn!("[feishu] Got 401 on image upload, refreshing token");
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            let json: Value = serde_json::from_str(&text)
                .map_err(|e| format!("Image upload response parse error: {}", e))?;

            let code = json["code"].as_i64().unwrap_or(-1);
            if code != 0 {
                return Err(format!(
                    "Image upload error {}: {}",
                    code,
                    json["msg"].as_str().unwrap_or("unknown")
                ));
            }

            let image_key = json["data"]["image_key"]
                .as_str()
                .ok_or_else(|| "No image_key in upload response".to_string())?
                .to_string();

            ulog_info!("[feishu] Image uploaded: {} → {}", filename, image_key);
            return Ok(image_key);
        }
    }

    /// Upload a file to Feishu and return the file_key.
    async fn upload_file(
        &self,
        data: Vec<u8>,
        filename: &str,
        file_type: &str,
    ) -> Result<String, String> {
        let url = format!("{}/im/v1/files", FEISHU_API_BASE);
        let mut retries = 0;

        loop {
            let token = self.get_token().await?;

            let file_part = reqwest::multipart::Part::bytes(data.clone())
                .file_name(filename.to_string())
                .mime_str("application/octet-stream")
                .map_err(|e| format!("Failed to create multipart: {}", e))?;

            let form = reqwest::multipart::Form::new()
                .text("file_type", file_type.to_string())
                .text("file_name", filename.to_string())
                .part("file", file_part);

            let resp = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .multipart(form)
                .send()
                .await
                .map_err(|e| format!("File upload failed: {}", e))?;

            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();

            if status.as_u16() == 401 && retries == 0 {
                ulog_warn!("[feishu] Got 401 on file upload, refreshing token");
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            let json: Value = serde_json::from_str(&text)
                .map_err(|e| format!("File upload response parse error: {}", e))?;

            let code = json["code"].as_i64().unwrap_or(-1);
            if code != 0 {
                return Err(format!(
                    "File upload error {}: {}",
                    code,
                    json["msg"].as_str().unwrap_or("unknown")
                ));
            }

            let file_key = json["data"]["file_key"]
                .as_str()
                .ok_or_else(|| "No file_key in upload response".to_string())?
                .to_string();

            ulog_info!("[feishu] File uploaded: {} → {}", filename, file_key);
            return Ok(file_key);
        }
    }

    /// Send an image message using a previously uploaded image_key.
    async fn send_image_message(
        &self,
        chat_id: &str,
        image_key: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let content = serde_json::to_string(&json!({ "image_key": image_key })).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "image",
            "content": content,
        });
        let resp = self.api_call("POST", &url, Some(&body)).await?;
        Ok(resp["data"]["message_id"].as_str().map(String::from))
    }

    /// Send a file message using a previously uploaded file_key.
    async fn send_file_message(
        &self,
        chat_id: &str,
        file_key: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let content = serde_json::to_string(&json!({ "file_key": file_key })).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "file",
            "content": content,
        });
        let resp = self.api_call("POST", &url, Some(&body)).await?;
        Ok(resp["data"]["message_id"].as_str().map(String::from))
    }

    /// Map file extension to Feishu file_type parameter.
    fn ext_to_feishu_file_type(ext: &str) -> &'static str {
        match ext.to_lowercase().as_str() {
            "pdf" => "pdf",
            "doc" | "docx" => "doc",
            "xls" | "xlsx" => "xls",
            "ppt" | "pptx" => "ppt",
            "mp4" | "avi" | "mov" | "mkv" => "mp4",
            "mp3" | "ogg" | "wav" => "mp3",
            _ => "stream",
        }
    }

    /// Edit an existing message with rich-text (post) content.
    /// Uses PUT (not PATCH — PATCH is for message cards only).
    /// Automatically converts Markdown to Feishu Post format.
    pub async fn edit_text_message(&self, message_id: &str, text: &str) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        let post_content = markdown_to_feishu_post(text);
        let content = serde_json::to_string(&post_content).unwrap_or_default();
        let body = json!({
            "msg_type": "post",
            "content": content,
        });

        self.api_call("PUT", &url, Some(&body)).await?;
        Ok(())
    }

    /// Delete a message.
    pub async fn delete_text_message(&self, message_id: &str) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        self.api_call("DELETE", &url, None).await?;
        Ok(())
    }

    // ===== WebSocket long connection =====

    /// Get WebSocket endpoint URL from Feishu.
    /// Unlike other Feishu APIs that use Bearer token, this endpoint requires
    /// AppID + AppSecret directly in the request body (matching official SDK behavior).
    async fn get_ws_endpoint(&self) -> Result<String, String> {
        let url = "https://open.feishu.cn/callback/ws/endpoint";

        // The WS endpoint uses direct app credentials, NOT Bearer token.
        // This matches the official larksuite/oapi-sdk-go implementation.
        let body = json!({
            "AppID": self.app_id,
            "AppSecret": self.app_secret,
        });

        let resp = self
            .client
            .post(url)
            .header("locale", "zh")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("WS endpoint request failed: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(format!("WS endpoint HTTP {}: {}", status, text));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("WS endpoint response parse error: {}", e))?;

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = json["msg"].as_str().unwrap_or("unknown");
            return Err(format!("WS endpoint error code {}: {}", code, msg));
        }

        // The response contains a URL field with the WSS endpoint
        let ws_url = json["data"]["URL"]
            .as_str()
            .or_else(|| json["data"]["url"].as_str())
            .ok_or_else(|| format!("No WebSocket URL in response: {}", json))?
            .to_string();

        // Append client_config query params
        let client_config = json["data"]["ClientConfig"]
            .as_object()
            .or_else(|| json["data"]["client_config"].as_object());

        let final_url = if let Some(config) = client_config {
            // Some Feishu responses include reconnect count etc. in client_config
            let _ = config; // Use if needed
            ws_url
        } else {
            ws_url
        };

        Ok(final_url)
    }

    /// Parse a Feishu IM event into an ImMessage.
    /// Async because image/file/audio/video messages require downloading resources.
    async fn parse_im_event(&self, event: &Value) -> Option<ImMessage> {
        let header = event.get("header")?;
        let event_type = header["event_type"].as_str()?;

        if event_type != "im.message.receive_v1" {
            return None;
        }

        let event_data = event.get("event")?;
        let message = event_data.get("message")?;
        let sender = event_data.get("sender")?;

        let chat_id = message["chat_id"].as_str()?.to_string();
        let message_id = message["message_id"].as_str()?.to_string();
        let msg_type = message["message_type"].as_str()?;

        let content_str = message["content"].as_str()?;
        let content: Value = match serde_json::from_str(content_str) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[feishu] Failed to parse message content JSON: {}", e);
                return None;
            }
        };

        // ── Collect attachments + text by message type ──
        let mut attachments: Vec<ImAttachment> = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();

        let text = match msg_type {
            "text" => content["text"].as_str().unwrap_or("").to_string(),
            "post" => {
                let post_text = feishu_post_to_text(&content);
                // Also extract and download images embedded in post content
                let image_keys = extract_post_image_keys(&content);
                for key in &image_keys {
                    match self.download_resource(&message_id, key, "image").await {
                        Ok((data, content_type)) => {
                            let ext = mime_to_ext(&content_type);
                            attachments.push(ImAttachment {
                                file_name: format!("{}.{}", key, ext),
                                mime_type: content_type,
                                data,
                                attachment_type: ImAttachmentType::Image,
                            });
                        }
                        Err(e) => {
                            ulog_warn!("[feishu] Failed to download post image {}: {}", key, e)
                        }
                    }
                }
                post_text
            }
            "image" => {
                // Image message: {"image_key": "img_v3_xxx"}
                if let Some(image_key) = content["image_key"].as_str() {
                    match self
                        .download_resource(&message_id, image_key, "image")
                        .await
                    {
                        Ok((data, content_type)) => {
                            let ext = mime_to_ext(&content_type);
                            attachments.push(ImAttachment {
                                file_name: format!("image.{}", ext),
                                mime_type: content_type,
                                data,
                                attachment_type: ImAttachmentType::Image,
                            });
                        }
                        Err(e) => ulog_warn!("[feishu] Failed to download image: {}", e),
                    }
                }
                String::new()
            }
            "file" => {
                // File message: {"file_key": "file_v3_xxx", "file_name": "doc.pdf"}
                if let Some(file_key) = content["file_key"].as_str() {
                    let file_name = content["file_name"].as_str().unwrap_or("file");
                    match self.download_resource(&message_id, file_key, "file").await {
                        Ok((data, content_type)) => {
                            attachments.push(ImAttachment {
                                file_name: sanitize_filename(file_name),
                                mime_type: content_type,
                                data,
                                attachment_type: ImAttachmentType::File,
                            });
                            text_parts.push(format!("[文件: {}]", file_name));
                        }
                        Err(e) => ulog_warn!("[feishu] Failed to download file: {}", e),
                    }
                }
                String::new()
            }
            "audio" => {
                // Audio message: {"file_key": "file_v3_xxx", "duration": 1000}
                if let Some(file_key) = content["file_key"].as_str() {
                    match self.download_resource(&message_id, file_key, "file").await {
                        Ok((data, content_type)) => {
                            let ext = mime_to_ext(&content_type);
                            let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
                            attachments.push(ImAttachment {
                                file_name: format!("voice_{}.{}", ts, ext),
                                mime_type: content_type,
                                data,
                                attachment_type: ImAttachmentType::File,
                            });
                            text_parts.push("[语音消息]".into());
                        }
                        Err(e) => ulog_warn!("[feishu] Failed to download audio: {}", e),
                    }
                }
                String::new()
            }
            "media" | "video" => {
                // Video/media message: {"file_key": "file_v3_xxx", "file_name": "xxx.mp4", "duration": ...}
                if let Some(file_key) = content["file_key"].as_str() {
                    let orig_name = content["file_name"].as_str();
                    match self.download_resource(&message_id, file_key, "file").await {
                        Ok((data, content_type)) => {
                            let ext = mime_to_ext(&content_type);
                            let file_name =
                                orig_name.map(|n| sanitize_filename(n)).unwrap_or_else(|| {
                                    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
                                    format!("video_{}.{}", ts, ext)
                                });
                            attachments.push(ImAttachment {
                                file_name,
                                mime_type: content_type,
                                data,
                                attachment_type: ImAttachmentType::File,
                            });
                            text_parts.push("[视频]".into());
                        }
                        Err(e) => ulog_warn!("[feishu] Failed to download video: {}", e),
                    }
                }
                String::new()
            }
            _ => {
                ulog_debug!("[feishu] Ignoring unsupported message type: {}", msg_type);
                return None;
            }
        };

        // ── Build final text ──
        let mut final_text_parts = Vec::new();
        if !text.is_empty() {
            final_text_parts.push(text);
        }
        final_text_parts.extend(text_parts);
        let combined_text = final_text_parts.join("\n");

        // Skip if no content at all (no text AND no attachments)
        if combined_text.trim().is_empty() && attachments.is_empty() {
            ulog_debug!("[feishu] Ignoring empty {} message", msg_type);
            return None;
        }

        let sender_id = match sender["sender_id"]["open_id"].as_str() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                ulog_warn!("[feishu] Missing sender open_id in message {}", message_id);
                return None;
            }
        };

        // Sender type: "user" for users
        let sender_type = sender["sender_type"].as_str().unwrap_or("user");
        if sender_type != "user" {
            return None; // Ignore bot's own messages
        }

        // Determine source type from chat_type
        let chat_type = message["chat_type"].as_str().unwrap_or("p2p");
        let source_type = match chat_type {
            "group" => ImSourceType::Group,
            _ => ImSourceType::Private, // "p2p" or default
        };

        // @Bot mention detection: check mentions array for bot's open_id
        let bot_oid = self.bot_open_id.read().await;
        let is_at_mention = bot_oid.is_some()
            && message
                .get("mentions")
                .and_then(|m| m.as_array())
                .map(|mentions| {
                    mentions
                        .iter()
                        .any(|m| m["id"]["open_id"].as_str() == bot_oid.as_deref())
                })
                .unwrap_or(false);
        drop(bot_oid);

        // Reply-to-bot detection: Feishu doesn't include parent message sender info in events.
        // Accurately detecting reply-to-bot would require tracking all sent message IDs or
        // an API call per reply (GET /im/v1/messages/{parent_id}), both adding complexity.
        // Pragmatic: only @mention and /ask trigger the bot in Feishu groups.
        // This is a known platform limitation vs Telegram (which provides reply_to_message.from.id).
        let reply_to_bot = false;

        let is_mention = is_at_mention;

        // Sender name: fetch via user name cache (GET /contact/v3/users/{open_id})
        let sender_name_str = self.get_user_name(&sender_id).await;

        Some(ImMessage {
            chat_id,
            message_id,
            text: combined_text,
            sender_id,
            sender_name: sender_name_str,
            account_id: None,
            source_type,
            platform: ImPlatform::Feishu,
            timestamp: chrono::Utc::now(),
            attachments,
            media_group_id: None,
            is_mention,
            reply_to_bot,
            hint_group_name: None,
            reply_to_body: None,
            group_system_prompt: None,
            request_id: String::new(),
            delivery_protocol: None,
        })
    }

    /// Check if a user is in the whitelist.
    async fn is_allowed(&self, sender_id: &str) -> bool {
        let allowed = self.allowed_users.read().await;
        if allowed.is_empty() {
            return false; // Empty whitelist = reject all
        }
        allowed.iter().any(|u| u == sender_id)
    }

    /// Get a header value from a protobuf frame by key.
    fn get_frame_header<'a>(frame: &'a WsFrame, key: &str) -> Option<&'a str> {
        frame
            .headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    /// Build a protobuf pong frame in response to a ping frame.
    fn build_pong_frame(ping_frame: &WsFrame) -> Vec<u8> {
        let mut pong = WsFrame {
            seq_id: ping_frame.seq_id,
            log_id: ping_frame.log_id,
            service: ping_frame.service,
            method: FRAME_METHOD_CONTROL,
            headers: vec![WsHeader {
                key: "type".to_string(),
                value: "pong".to_string(),
            }],
            payload_encoding: None,
            payload_type: None,
            payload: None,
            log_id_new: ping_frame.log_id_new.clone(),
        };
        // Copy non-type headers from ping
        for h in &ping_frame.headers {
            if h.key != "type" {
                pong.headers.push(h.clone());
            }
        }
        pong.encode_to_vec()
    }

    /// Build a protobuf response frame for a received data frame.
    ///
    /// The official Feishu SDK (`larksuite/oapi-sdk-go` ws/client.go) responds to data
    /// frames by sending back the *same* frame structure with:
    ///   - Original headers preserved, plus a `biz_rt` header (processing time in ms)
    ///   - A JSON payload: `{"StatusCode":200,"Headers":{},"Data":null}`
    ///
    /// Without a valid response payload, the Feishu server considers the event
    /// unacknowledged and retries delivery with exponential backoff (seconds → hours).
    fn build_response_frame(data_frame: &WsFrame) -> Vec<u8> {
        let mut headers = data_frame.headers.clone();
        headers.push(WsHeader {
            key: "biz_rt".to_string(),
            value: "0".to_string(),
        });

        let response_payload = br#"{"StatusCode":200,"Headers":{},"Data":null}"#;

        let resp = WsFrame {
            seq_id: data_frame.seq_id,
            log_id: data_frame.log_id,
            service: data_frame.service,
            method: FRAME_METHOD_DATA,
            headers,
            payload_encoding: None,
            payload_type: None,
            payload: Some(response_payload.to_vec()),
            log_id_new: data_frame.log_id_new.clone(),
        };
        resp.encode_to_vec()
    }

    /// WebSocket listen loop with reconnection.
    /// Feishu WS sends ONLY binary protobuf frames — text frames are ignored.
    pub async fn ws_listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        let mut backoff_secs = WS_INITIAL_BACKOFF_SECS;

        loop {
            if *shutdown_rx.borrow() {
                ulog_info!("[feishu] Shutdown signal, exiting WS loop");
                break;
            }

            // Get WebSocket endpoint
            let ws_url = match self.get_ws_endpoint().await {
                Ok(url) => {
                    backoff_secs = WS_INITIAL_BACKOFF_SECS;
                    url
                }
                Err(e) => {
                    ulog_error!("[feishu] Failed to get WS endpoint: {}", e);
                    tokio::select! {
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        _ = shutdown_rx.changed() => {
                            if *shutdown_rx.borrow() { break; }
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
                    continue;
                }
            };

            ulog_info!(
                "[feishu] Connecting to WebSocket: {}...",
                &ws_url[..ws_url.len().min(80)]
            );

            // Connect
            let ws_stream = match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => {
                    ulog_info!("[feishu] WebSocket connected");
                    backoff_secs = WS_INITIAL_BACKOFF_SECS;
                    stream
                }
                Err(e) => {
                    ulog_error!("[feishu] WebSocket connection failed: {}", e);
                    tokio::select! {
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        _ = shutdown_rx.changed() => {
                            if *shutdown_rx.borrow() { break; }
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
                    continue;
                }
            };

            let (mut ws_write, mut ws_read) = futures::StreamExt::split(ws_stream);

            // Track last received data to detect dead connections.
            let mut last_activity = tokio::time::Instant::now();

            // Client-side ping to keep NAT/firewall mappings alive.
            // Without this, idle TCP connections get silently dropped by middleboxes,
            // and the server's protobuf pings never reach us.
            let mut ping_interval =
                tokio::time::interval(std::time::Duration::from_secs(WS_PING_INTERVAL_SECS));
            ping_interval.tick().await; // skip immediate tick

            // Read messages — Feishu uses ONLY binary protobuf frames
            loop {
                let timeout_at =
                    last_activity + std::time::Duration::from_secs(WS_READ_TIMEOUT_SECS);
                // biased: prioritize read over timeout to avoid false "dead connection"
                // when data arrives at the same instant the timeout fires.
                tokio::select! {
                    biased;
                    msg = futures::StreamExt::next(&mut ws_read) => {
                        match msg {
                            Some(Ok(WsMessage::Binary(data))) => {
                                last_activity = tokio::time::Instant::now();

                                // Decode protobuf frame
                                let frame = match WsFrame::decode(data.as_ref()) {
                                    Ok(f) => f,
                                    Err(e) => {
                                        ulog_warn!("[feishu] Failed to decode protobuf frame: {}", e);
                                        continue;
                                    }
                                };

                                let msg_type = Self::get_frame_header(&frame, "type").unwrap_or("");

                                match frame.method {
                                    FRAME_METHOD_CONTROL => {
                                        // Control frame: handle ping/pong
                                        if msg_type == "ping" {
                                            let pong_data = Self::build_pong_frame(&frame);
                                            if let Err(e) = ws_write.send(WsMessage::Binary(pong_data.into())).await {
                                                ulog_warn!("[feishu] Failed to send pong: {}", e);
                                            }
                                        }
                                        // "pong" — ignore (shouldn't receive from server)
                                    }
                                    FRAME_METHOD_DATA => {
                                        // Data frame: extract payload and process event
                                        if msg_type != "event" {
                                            ulog_debug!("[feishu] Ignoring data frame type: {}", msg_type);
                                            continue;
                                        }

                                        // Respond to the data frame immediately to prevent replay on reconnect.
                                        // Must include a JSON response payload per the official Feishu WS protocol.
                                        let resp_data = Self::build_response_frame(&frame);
                                        if let Err(e) = ws_write.send(WsMessage::Binary(resp_data.into())).await {
                                            ulog_warn!("[feishu] Failed to send response for seq_id={}: {}", frame.seq_id, e);
                                        }

                                        // Check for fragmentation (sum = total parts, seq = part index)
                                        let sum: usize = Self::get_frame_header(&frame, "sum")
                                            .and_then(|v| v.parse().ok())
                                            .unwrap_or(1);
                                        if sum > 1 {
                                            // Fragmented message — skip for MVP
                                            ulog_warn!("[feishu] Fragmented message (sum={}), skipping", sum);
                                            continue;
                                        }

                                        if let Some(payload_bytes) = &frame.payload {
                                            // Payload is JSON bytes containing the event data
                                            let payload_str = match std::str::from_utf8(payload_bytes) {
                                                Ok(s) => s,
                                                Err(e) => {
                                                    ulog_warn!("[feishu] Invalid UTF-8 in payload: {}", e);
                                                    continue;
                                                }
                                            };
                                            self.handle_event_payload(payload_str).await;
                                        }
                                    }
                                    _ => {
                                        ulog_debug!("[feishu] Unknown frame method: {}", frame.method);
                                    }
                                }
                            }
                            Some(Ok(WsMessage::Ping(data))) => {
                                last_activity = tokio::time::Instant::now();
                                // WebSocket-level ping (unlikely for Feishu, but handle it)
                                let _ = ws_write.send(WsMessage::Pong(data)).await;
                            }
                            Some(Ok(WsMessage::Close(_))) => {
                                ulog_info!("[feishu] WebSocket closed by server");
                                break;
                            }
                            Some(Err(e)) => {
                                ulog_warn!("[feishu] WebSocket error: {}", e);
                                break;
                            }
                            None => {
                                ulog_info!("[feishu] WebSocket stream ended");
                                break;
                            }
                            _ => {
                                last_activity = tokio::time::Instant::now();
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(timeout_at) => {
                        ulog_warn!(
                            "[feishu] No data received for {}s (dead connection detected), reconnecting...",
                            WS_READ_TIMEOUT_SECS
                        );
                        // Best-effort Close with short timeout — the connection is likely
                        // dead, so don't block reconnection waiting for a send that may
                        // never complete (kernel send buffer full → TCP retransmit timeout).
                        let _ = tokio::time::timeout(
                            Duration::from_secs(3),
                            ws_write.send(WsMessage::Close(None)),
                        ).await;
                        break;
                    }
                    _ = ping_interval.tick() => {
                        if let Err(e) = ws_write.send(WsMessage::Ping(vec![])).await {
                            ulog_warn!("[feishu] WS ping send failed: {}", e);
                            break;
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            ulog_info!("[feishu] Shutdown signal, closing WebSocket");
                            let _ = ws_write.send(WsMessage::Close(None)).await;
                            return;
                        }
                    }
                }
            }

            // Disconnected — reconnect with backoff
            ulog_info!("[feishu] Reconnecting in {}s...", backoff_secs);
            tokio::select! {
                _ = sleep(Duration::from_secs(backoff_secs)) => {}
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() { break; }
                }
            }
            backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
        }

        ulog_info!("[feishu] WS listen loop exited");
    }

    // ===== Approval card operations =====

    /// Send an interactive approval card for a permission request.
    /// Returns the message_id of the card message on success.
    pub async fn send_approval_card(
        &self,
        chat_id: &str,
        _request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);

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

        let card = json!({
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "tag": "plain_text", "content": "🔒 工具使用请求" },
                "template": "orange"
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": format!("**工具**: {}\n**内容**: {}", tool_name, display_input)
                    }
                },
                {
                    "tag": "hr"
                },
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": "回复「**允许**」允许执行\n回复「**始终允许**」本次会话全部允许\n回复「**拒绝**」拒绝执行"
                    }
                }
            ]
        });
        let card_str = serde_json::to_string(&card).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": card_str,
        });

        match self.api_call("POST", &url, Some(&body)).await {
            Ok(resp) => {
                let msg_id = resp["data"]["message_id"].as_str().map(String::from);
                ulog_info!("[feishu] Approval card sent: msg_id={:?}", msg_id);
                Ok(msg_id)
            }
            Err(e) => {
                ulog_warn!("[feishu] Approval card failed: {}, falling back to text", e);
                // Fallback: send as plain text message with instructions
                let fallback_text = format!(
                    "🔒 工具使用请求\n\n工具: {}\n内容: {}\n\n回复「允许」允许执行\n回复「始终允许」本次会话全部允许\n回复「拒绝」拒绝执行",
                    tool_name, display_input
                );
                self.send_text_message(chat_id, &fallback_text).await
            }
        }
    }

    /// Update an approval card to show resolved status.
    /// Uses PATCH API (card updates use PATCH, text uses PUT).
    pub async fn update_approval_status(
        &self,
        message_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);

        let (emoji, label, template) = if status == "denied" {
            ("❌", "已拒绝", "red")
        } else {
            ("✅", "已允许", "green")
        };

        let card = json!({
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "tag": "plain_text", "content": format!("🔒 工具使用请求 — {} {}", emoji, label) },
                "template": template
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": format!("{} 此请求已{}", emoji, label)
                    }
                }
            ]
        });
        let card_str = serde_json::to_string(&card).unwrap_or_default();
        let body = json!({ "content": card_str });

        self.api_call("PATCH", &url, Some(&body)).await?;
        Ok(())
    }

    fn question_answer_key(question: &AskUserQuestionItem, idx: usize) -> String {
        question.id.clone().unwrap_or_else(|| idx.to_string())
    }

    fn format_question_content(
        payload: &AskUserQuestionPayload,
        source_type: &ImSourceType,
    ) -> String {
        let mut lines = vec!["请回答下面的问题。".to_string()];
        if payload.questions.iter().any(|q| q.is_secret) {
            let scope = if matches!(source_type, ImSourceType::Group) {
                "群聊"
            } else {
                "IM"
            };
            lines.push(format!(
                "其中包含敏感输入，{} 不支持安全收集。请取消后在桌面端继续。",
                scope
            ));
            return lines.join("\n");
        }
        for (idx, q) in payload.questions.iter().enumerate() {
            lines.push(format!(
                "\n**{}. {}**\n{}{}",
                idx + 1,
                q.header,
                q.question,
                if q.required { "" } else { "\n（可跳过）" },
            ));
            if q.options.is_empty() {
                lines.push("请直接回复文本。".to_string());
            } else {
                let option_lines = q
                    .options
                    .iter()
                    .enumerate()
                    .map(|(opt_idx, opt)| {
                        if opt.description.is_empty() {
                            format!("{}. {}", opt_idx + 1, opt.label)
                        } else {
                            format!("{}. {} — {}", opt_idx + 1, opt.label, opt.description)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                lines.push(option_lines);
                if q.multi_select {
                    lines.push("多选请回复编号或选项名，用逗号分隔。".to_string());
                } else {
                    lines.push("请回复编号或选项名。".to_string());
                }
            }
        }
        if payload.questions.len() > 1 {
            lines.push("\n多题请按顺序逐行回复；可选题留空表示跳过。".to_string());
        }
        lines.push("回复「取消」可取消本次提问。".to_string());
        lines.join("\n")
    }

    /// Send a native AskUserQuestion card for Feishu.
    pub async fn send_question_card(
        &self,
        chat_id: &str,
        payload: &AskUserQuestionPayload,
        source_type: &ImSourceType,
    ) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let mut elements = vec![json!({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": Self::format_question_content(payload, source_type),
            }
        })];

        if payload.questions.len() == 1
            && !payload.questions[0].multi_select
            && !payload.questions[0].options.is_empty()
            && !(matches!(source_type, ImSourceType::Group) && payload.questions[0].is_secret)
        {
            let q = &payload.questions[0];
            let key = Self::question_answer_key(q, 0);
            let mut actions = q
                .options
                .iter()
                .take(8)
                .map(|opt| {
                    let mut answers = serde_json::Map::new();
                    answers.insert(key.clone(), Value::String(opt.label.clone()));
                    json!({
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": opt.label },
                        "type": "primary",
                        "value": {
                            "kind": "ask_user_question",
                            "rid": payload.request_id,
                            "action": "answer",
                            "answers": Value::Object(answers),
                        }
                    })
                })
                .collect::<Vec<_>>();
            actions.push(json!({
                "tag": "button",
                "text": { "tag": "plain_text", "content": "取消" },
                "type": "default",
                "value": {
                    "kind": "ask_user_question",
                    "rid": payload.request_id,
                    "action": "cancel",
                }
            }));
            elements.push(json!({ "tag": "action", "actions": actions }));
        }

        let card = json!({
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "tag": "plain_text", "content": "请选择或填写" },
                "template": "blue"
            },
            "elements": elements,
        });
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": serde_json::to_string(&card).unwrap_or_default(),
        });

        match self.api_call("POST", &url, Some(&body)).await {
            Ok(resp) => {
                let msg_id = resp["data"]["message_id"].as_str().map(String::from);
                ulog_info!("[feishu] AskUserQuestion card sent: msg_id={:?}", msg_id);
                Ok(msg_id)
            }
            Err(e) => {
                ulog_warn!(
                    "[feishu] AskUserQuestion card failed: {}, falling back to text",
                    e
                );
                self.send_text_message(
                    chat_id,
                    &format!(
                        "请选择或填写\n\n{}",
                        Self::format_question_content(payload, source_type)
                    ),
                )
                .await
            }
        }
    }

    pub async fn update_question_status(
        &self,
        message_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        let (template, label) = match status {
            "submitted" => ("green", "已提交"),
            "cancelled" => ("grey", "已取消"),
            "expired" => ("grey", "已失效"),
            _ => ("grey", "已处理"),
        };
        let card = json!({
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "tag": "plain_text", "content": format!("提问{}", label) },
                "template": template,
            },
            "elements": [{
                "tag": "div",
                "text": { "tag": "lark_md", "content": format!("本次提问{}", label) },
            }],
        });
        let body = json!({ "content": serde_json::to_string(&card).unwrap_or_default() });
        self.api_call("PATCH", &url, Some(&body)).await?;
        Ok(())
    }

    /// Parse group lifecycle events: bot added/removed from group chats.
    async fn parse_group_event(&self, event: &Value) -> Option<GroupEvent> {
        let event_type = event["header"]["event_type"].as_str()?;
        match event_type {
            "im.chat.member.bot.added_v1" => {
                let event_data = event.get("event")?;
                let chat_id = event_data["chat_id"].as_str()?.to_string();
                let operator_id = event_data["operator_id"]["open_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();

                // Fetch group name via API
                let chat_title = match self.get_chat_info(&chat_id).await {
                    Ok(name) => name,
                    Err(e) => {
                        ulog_warn!("[feishu] Failed to get chat info for {}: {}", chat_id, e);
                        "Unknown Group".to_string()
                    }
                };

                // Resolve operator name from open_id
                let added_by_name = if !operator_id.is_empty() {
                    self.get_user_name(&operator_id).await.or(Some(operator_id))
                } else {
                    None
                };

                ulog_info!("[feishu] Bot added to group: {} ({})", chat_title, chat_id);
                Some(GroupEvent::BotAdded {
                    chat_id,
                    chat_title,
                    platform: ImPlatform::Feishu,
                    added_by_name,
                })
            }
            "im.chat.member.bot.deleted_v1" => {
                let event_data = event.get("event")?;
                let chat_id = event_data["chat_id"].as_str()?.to_string();
                ulog_info!("[feishu] Bot removed from group: {}", chat_id);
                Some(GroupEvent::BotRemoved {
                    chat_id,
                    platform: ImPlatform::Feishu,
                })
            }
            _ => None,
        }
    }

    /// Get chat/group name by chat_id.
    async fn get_chat_info(&self, chat_id: &str) -> Result<String, String> {
        let url = format!("{}/im/v1/chats/{}", FEISHU_API_BASE, chat_id);
        let resp = self.api_call("GET", &url, None).await?;
        let name = resp["data"]["name"].as_str().unwrap_or("Unknown Group");
        Ok(name.to_string())
    }

    /// Get user display name by open_id, with LRU cache (1000 entries, 24h TTL).
    async fn get_user_name(&self, open_id: &str) -> Option<String> {
        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
        const MAX_CACHE_SIZE: usize = 1000;

        // Check cache first
        {
            let cache = self.user_name_cache.lock().await;
            if let Some((name, fetched_at)) = cache.get(open_id) {
                if fetched_at.elapsed() < CACHE_TTL {
                    return Some(name.clone());
                }
            }
        }

        // Cache miss or expired — call API
        let url = format!(
            "{}/contact/v3/users/{}?user_id_type=open_id",
            FEISHU_API_BASE, open_id
        );
        match self.api_call("GET", &url, None).await {
            Ok(resp) => {
                let user = &resp["data"]["user"];
                let name = user["nickname"]
                    .as_str()
                    .or_else(|| user["en_name"].as_str())
                    .or_else(|| user["name"].as_str())
                    .map(|s| s.to_string());
                if let Some(ref n) = name {
                    let mut cache = self.user_name_cache.lock().await;
                    // Evict oldest entry if at capacity
                    if cache.len() >= MAX_CACHE_SIZE && !cache.contains_key(open_id) {
                        if let Some(oldest_key) = cache
                            .iter()
                            .min_by_key(|(_, (_, t))| *t)
                            .map(|(k, _)| k.clone())
                        {
                            cache.remove(&oldest_key);
                        }
                    }
                    cache.insert(open_id.to_string(), (n.clone(), std::time::Instant::now()));
                }
                name
            }
            Err(e) => {
                ulog_warn!("[feishu] Failed to fetch user name for {}: {}", open_id, e);
                None
            }
        }
    }

    /// Parse a card.action.trigger event into an ApprovalCallback.
    fn parse_card_action(&self, event: &Value) -> Option<ApprovalCallback> {
        let event_type = event["header"]["event_type"].as_str()?;
        if event_type != "card.action.trigger" {
            return None;
        }

        let action = &event["event"]["action"];
        let value = &action["value"];
        let request_id = value["rid"].as_str()?.to_string();
        let decision = value["action"].as_str()?.to_string();
        let user_id = event["event"]["operator"]["open_id"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Some(ApprovalCallback {
            request_id,
            decision,
            user_id,
        })
    }

    fn parse_question_card_action(&self, event: &Value) -> Option<QuestionCallback> {
        let event_type = event["header"]["event_type"].as_str()?;
        if event_type != "card.action.trigger" {
            return None;
        }

        let action = &event["event"]["action"];
        let value = &action["value"];
        if value["kind"].as_str() != Some("ask_user_question") {
            return None;
        }
        let request_id = value["rid"].as_str()?.to_string();
        let user_id = event["event"]["operator"]["open_id"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let answers = if value["action"].as_str() == Some("cancel") {
            None
        } else {
            let mut map = HashMap::new();
            if let Some(obj) = value["answers"].as_object() {
                for (key, val) in obj {
                    if let Some(s) = val.as_str() {
                        map.insert(key.clone(), s.to_string());
                    }
                }
            }
            Some(map)
        };

        Some(QuestionCallback {
            request_id,
            answers,
            user_id,
        })
    }

    /// Handle event payload extracted from a protobuf data frame.
    /// The payload is a JSON string containing the Feishu event data.
    async fn handle_event_payload(&self, payload_str: &str) {
        // The payload can be either:
        // 1. Direct event JSON with "header" at top level
        // 2. Wrapped format: { "type": "event", "data": "<stringified JSON>" }
        let json: Value = match serde_json::from_str(payload_str) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[feishu] Failed to parse event payload JSON: {}", e);
                return;
            }
        };

        // Extract the actual event object
        let event: Value = if json.get("header").is_some() {
            // Direct event format
            json
        } else if let Some(data) = json.get("data") {
            // Wrapped format: data is a JSON string
            if let Some(data_str) = data.as_str() {
                match serde_json::from_str(data_str) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        ulog_warn!("[feishu] Failed to parse nested data string: {}", e);
                        return;
                    }
                }
            } else if data.is_object() && data.get("header").is_some() {
                data.clone()
            } else {
                ulog_debug!("[feishu] Unrecognized event payload structure");
                return;
            }
        } else {
            ulog_debug!("[feishu] No header or data in event payload");
            return;
        };

        // Handle group lifecycle events (bot added/removed)
        if let Some(ge) = self.parse_group_event(&event).await {
            match &ge {
                GroupEvent::BotAdded { chat_id, .. } => {
                    self.known_groups.lock().await.insert(chat_id.clone());
                }
                GroupEvent::BotRemoved { chat_id, .. } => {
                    self.known_groups.lock().await.remove(chat_id);
                }
            }
            if self.group_event_tx.send(ge).await.is_err() {
                ulog_error!("[feishu] Group event channel closed");
            }
            return;
        }

        // Handle card.action.trigger (AskUserQuestion / approval button clicks)
        if let Some(cb) = self.parse_question_card_action(&event) {
            ulog_info!(
                "[feishu] AskUserQuestion card action: rid={}",
                &cb.request_id[..cb.request_id.len().min(16)]
            );
            if self.question_tx.send(cb).await.is_err() {
                ulog_error!("[feishu] question callback channel closed");
            }
            return;
        }
        if let Some(cb) = self.parse_card_action(&event) {
            ulog_info!(
                "[feishu] Card action: decision={}, rid={}",
                cb.decision,
                &cb.request_id[..cb.request_id.len().min(16)]
            );
            if self.approval_tx.send(cb).await.is_err() {
                ulog_error!("[feishu] Approval channel closed");
            }
            return;
        }

        if let Some(msg) = self.parse_im_event(&event).await {
            // Dedup check: skip if message_id was seen within TTL (72h, disk-persisted)
            let persist_snapshot = {
                let mut cache = self.dedup_cache.lock().await;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                // Periodic cleanup: remove expired entries
                if cache.len() > DEDUP_MAX_SIZE || cache.len() % 100 == 0 {
                    cache.retain(|_, ts| now.saturating_sub(*ts) < DEDUP_TTL_SECS);
                }
                if let Some(prev) = cache.get(&msg.message_id) {
                    if now.saturating_sub(*prev) < DEDUP_TTL_SECS {
                        ulog_debug!(
                            "[feishu] Dedup: skipping duplicate message {}",
                            msg.message_id
                        );
                        return;
                    }
                }
                cache.insert(msg.message_id.clone(), now);
                // Debounced persist: snapshot the cache if enough time elapsed since last write.
                // Dedup hits (duplicates) return early above — only new messages reach here,
                // so burst writes only occur on first startup with empty cache, not on reconnect replay.
                if self.dedup_persist_path.is_some() {
                    let now_ms = now * 1000;
                    let last_ms = self.dedup_last_persist_ms.load(Ordering::Relaxed);
                    if now_ms.saturating_sub(last_ms) >= DEDUP_PERSIST_INTERVAL_MS {
                        self.dedup_last_persist_ms.store(now_ms, Ordering::Relaxed);
                        Some(cache.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            }; // Mutex released here — IO happens outside the lock

            // Persist to disk via blocking thread pool (non-blocking for async runtime)
            if let (Some(snapshot), Some(path)) =
                (persist_snapshot, self.dedup_persist_path.clone())
            {
                tokio::task::spawn_blocking(move || {
                    save_dedup_cache_to_disk(&path, &snapshot);
                });
            }

            // Auto-discover groups from incoming group messages (same pattern as DingTalk).
            // Feishu's im.chat.member.bot.added_v1 event requires explicit subscription and
            // may not fire for groups where the bot was already present before app setup.
            // This ensures groups are discovered as soon as any message arrives.
            if msg.source_type == ImSourceType::Group {
                let mut groups = self.known_groups.lock().await;
                if !groups.contains(&msg.chat_id) {
                    groups.insert(msg.chat_id.clone());
                    drop(groups); // Release lock before async call

                    let chat_title = match self.get_chat_info(&msg.chat_id).await {
                        Ok(name) => name,
                        Err(_) => "Unknown Group".to_string(),
                    };
                    ulog_info!(
                        "[feishu] New group detected from message: {} ({})",
                        chat_title,
                        msg.chat_id
                    );
                    if self
                        .group_event_tx
                        .send(GroupEvent::BotAdded {
                            chat_id: msg.chat_id.clone(),
                            chat_title,
                            platform: ImPlatform::Feishu,
                            added_by_name: None,
                        })
                        .await
                        .is_err()
                    {
                        ulog_error!("[feishu] Group event channel closed");
                    }
                }
            }

            // Check bind code (plain text BIND_xxx in private chat)
            let is_bind_request =
                msg.text.starts_with("BIND_") && msg.source_type == ImSourceType::Private;

            if !is_bind_request && !self.is_allowed(&msg.sender_id).await {
                ulog_debug!(
                    "[feishu] Rejected message from non-whitelisted user: {}",
                    msg.sender_id
                );
                return;
            }

            ulog_info!(
                "[feishu] Dispatching message {} from {} (chat {}): {} chars",
                msg.message_id,
                msg.sender_id,
                msg.chat_id,
                msg.text.len(),
            );

            if self.msg_tx.send(msg).await.is_err() {
                ulog_error!("[feishu] Message channel closed");
            }
        }
    }
}

// ── ImAdapter trait implementation ─────────────────────────

impl super::adapter::ImAdapter for FeishuAdapter {
    async fn verify_connection(&self) -> super::adapter::AdapterResult<String> {
        let name = self.get_bot_info().await?;
        Ok(name)
    }

    async fn register_commands(&self) -> super::adapter::AdapterResult<()> {
        // Feishu doesn't have BotFather-style command registration
        Ok(())
    }

    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        self.ws_listen_loop(shutdown_rx).await;
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> super::adapter::AdapterResult<()> {
        self.send_text_message(chat_id, text).await.map(|_| ())
    }

    async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP (no emoji reaction equivalent)
    }

    async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP
    }

    async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP
    }

    async fn send_typing(&self, _chat_id: &str) {
        // No-op for Feishu (no typing indicator API)
    }
}

// ── ImStreamAdapter trait implementation ─────────────────────────

impl super::adapter::ImStreamAdapter for FeishuAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<Option<String>> {
        // Streaming first-send: always Post (first chunk rarely contains tables)
        self.send_post_message(chat_id, text).await
    }

    async fn edit_message(
        &self,
        _chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.edit_text_message(message_id, text).await
    }

    async fn delete_message(
        &self,
        _chat_id: &str,
        message_id: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.delete_text_message(message_id).await
    }

    fn max_message_length(&self) -> usize {
        FEISHU_SPLIT_THRESHOLD
    }

    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        if should_use_card(text) {
            // Send-before-delete: new Card first, then delete old Post.
            // If Card fails, fall back to editing the Post in place.
            match self.send_card_message(chat_id, text).await {
                Ok(_) => {
                    if let Err(e) = self.delete_text_message(message_id).await {
                        ulog_warn!("[feishu] Card sent but failed to delete old Post: {}", e);
                    }
                    Ok(())
                }
                Err(e) => {
                    ulog_warn!(
                        "[feishu] Card send failed, falling back to Post edit: {}",
                        e
                    );
                    self.edit_text_message(message_id, text).await
                }
            }
        } else {
            self.edit_text_message(message_id, text).await
        }
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
        _chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.update_approval_status(message_id, status).await
    }

    async fn send_question_card(
        &self,
        chat_id: &str,
        payload: &AskUserQuestionPayload,
        source_type: &ImSourceType,
    ) -> super::adapter::AdapterResult<Option<String>> {
        self.send_question_card(chat_id, payload, source_type).await
    }

    async fn update_question_status(
        &self,
        _chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.update_question_status(message_id, status).await
    }

    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        _caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        let image_key = self.upload_image(data, filename).await?;
        self.send_image_message(chat_id, &image_key).await
    }

    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        _mime_type: &str,
        _caption: Option<&str>,
    ) -> super::adapter::AdapterResult<Option<String>> {
        let ext = std::path::Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("stream");
        let file_type = Self::ext_to_feishu_file_type(ext);
        let file_key = self.upload_file(data, filename, file_type).await?;
        self.send_file_message(chat_id, &file_key).await
    }
}
