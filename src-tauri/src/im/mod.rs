// IM Bot integration module
// Manages the Telegram Bot lifecycle, routing IM messages to AI Sidecars.

pub mod adapter;
pub(crate) mod agent_channel;
pub mod bridge;
pub mod buffer;
pub(crate) mod commands;
pub(crate) mod config_store;
pub mod dingtalk;
pub(crate) mod enqueue;
pub mod event_consumer;
pub mod feishu;
pub mod group_history;
pub mod handover;
pub mod health;
pub mod heartbeat;
pub mod reply_router;
pub mod router;
pub mod runtime_change;
pub(crate) mod session_delivery;
pub(crate) mod state;
pub mod telegram;
pub mod types;
mod util;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config_io::with_config_lock;
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
use reqwest::Client;
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{watch, Mutex, RwLock, Semaphore};
use tokio::task::JoinSet;

use tokio::sync::mpsc;

use crate::sidecar::ManagedSidecarManager;
use agent_channel::{
    agent_channel_lifecycle_lock, create_bot_instance, legacy_bot_lifecycle_lock,
    restart_agent_channel_instance, shutdown_bot_instance,
};
pub use agent_channel::{get_all_bots_status, get_im_bot_status, start_im_bot, stop_im_bot};
pub(crate) use agent_channel::{stop_agent_channel_runtime, stop_agent_channels_runtime};
use bridge::BridgeAdapter;
use buffer::MessageBuffer;
pub(crate) use commands::reload_agent_config_from_disk;
#[allow(unused_imports, deprecated)]
pub use commands::{
    cmd_add_im_bot_config, cmd_agent_channel_status, cmd_agent_status, cmd_all_agents_status,
    cmd_approve_group, cmd_get_im_bot_runtime_config, cmd_im_all_bots_status, cmd_im_bot_status,
    cmd_im_conversations, cmd_install_openclaw_plugin, cmd_list_openclaw_plugins,
    cmd_plugin_qr_login_start, cmd_plugin_qr_login_wait, cmd_plugin_restart_gateway,
    cmd_reject_group, cmd_remove_group, cmd_remove_im_bot_config,
    cmd_restart_channels_using_plugin, cmd_start_agent_channel, cmd_start_im_bot,
    cmd_stop_agent_channel, cmd_stop_im_bot, cmd_uninstall_openclaw_plugin,
    cmd_update_agent_config, cmd_update_im_bot_config,
};
use commands::{persist_bot_config_patch, read_available_providers_from_disk};
pub(crate) use config_store::read_agent_configs_from_disk;
use config_store::{
    missing_configured_channel_status, persist_agent_channel_model, persist_agent_config_patch,
    read_im_configs_from_disk, route_agent_heartbeat_once,
    should_report_missing_configured_channel,
};
pub use config_store::{monitor_agent_channels, schedule_agent_auto_start, schedule_auto_start};
pub(crate) use config_store::{resolve_agent_heartbeat_route, AgentHeartbeatRouteResolution};
use dingtalk::DingtalkAdapter;
use enqueue::{drop_im_consumer, enqueue_to_sidecar, ensure_im_consumer};
use feishu::FeishuAdapter;
use group_history::{GroupHistoryBuffer, GroupHistoryEntry};
use health::HealthManager;
use router::{create_sidecar_stream_client, RouteError, SessionRouter, GLOBAL_CONCURRENCY};
pub use state::{
    create_agent_state, create_im_bot_state, signal_all_agents_shutdown, signal_all_bots_shutdown,
    AgentInstance, ApprovalCallback, ChannelInstance, ImBotInstance, ManagedAgents, ManagedImBots,
    QuestionCallback,
};
use state::{
    ensure_sidecar_port_for_command, fallback_runtime_models, is_external_runtime_type,
    normalize_runtime_type, query_runtime_models_from_sidecar, runtime_config_string,
    runtime_config_with_string, runtime_display_name, runtime_permission_choices,
    sync_runtime_config_to_sidecars,
};
pub(crate) use state::{
    AgentChannelLink, AnyAdapter, ChannelModelWorkGate, ImConsumerHandle, ImConsumers, PeerLocks,
    PendingApproval, PendingApprovals, PendingQuestion, PendingQuestions, SharedAgentLink,
};
use telegram::TelegramAdapter;
use types::{
    AgentConfigPatch, AgentConfigRust, AgentStatus, AskUserQuestionItem, AskUserQuestionPayload,
    BotConfigPatch, ChannelConfigRust, ChannelStatus, GroupActivation, GroupEvent, GroupPermission,
    GroupPermissionStatus, HostInteractionCapability, ImAttachmentType, ImBotStatus, ImConfig,
    ImConversation, ImMessage, ImPlatform, ImSourceType, ImStatus, LastActiveChannel,
    LastActivePrivateTarget,
};

// ===== SSE Stream → IM Draft (legacy /api/im/chat path — deleted in C-7) ====

/// Consume Sidecar SSE stream, managing draft message lifecycle for any IM platform.
/// Group context passed to `stream_to_im` for group chat sessions (v0.1.28).
pub(crate) struct GroupStreamContext {
    pub(crate) group_name: String,
    pub(crate) platform: ImPlatform,
    pub(crate) activation: GroupActivation,
    pub(crate) is_first_turn: bool,
    pub(crate) pending_history: Option<String>,
    pub(crate) tools_deny: Vec<String>,
    pub(crate) is_mention: bool,
    pub(crate) message_count: u32,
}

/// Placeholder message sent when the AI's first response block is non-text (thinking/tool_use).
/// Gives users immediate feedback that the AI is processing their message.
pub(crate) const THINKING_PLACEHOLDER: &str = "思考中…";

/// Stop every running IM/Agent channel before handing control to the Windows
/// installer. Unlike the app-exit signal helpers, this removes instances from
/// managed state and awaits the normal bot shutdown path so OpenClaw bridge
/// processes, heartbeat tasks, buffers, and Sidecar owners are actually
/// released before NSIS attempts to overwrite bundled runtimes.
pub async fn shutdown_all_channels_for_update(
    im_state: &ManagedImBots,
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
) {
    let mut legacy_ids = im_state.lock().await.keys().cloned().collect::<Vec<_>>();
    legacy_ids.sort();
    let legacy_locks = legacy_ids
        .iter()
        .map(|bot_id| legacy_bot_lifecycle_lock(bot_id))
        .collect::<Vec<_>>();
    let mut _legacy_guards = Vec::with_capacity(legacy_locks.len());
    for lock in &legacy_locks {
        _legacy_guards.push(lock.lock().await);
    }

    let mut agent_channels = {
        let agents = agent_state.lock().await;
        agents
            .iter()
            .flat_map(|(agent_id, agent)| {
                agent
                    .channels
                    .keys()
                    .map(|channel_id| (agent_id.clone(), channel_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };
    agent_channels.sort();
    let agent_locks = agent_channels
        .iter()
        .map(|(agent_id, channel_id)| agent_channel_lifecycle_lock(agent_id, channel_id))
        .collect::<Vec<_>>();
    let mut _agent_guards = Vec::with_capacity(agent_locks.len());
    for lock in &agent_locks {
        _agent_guards.push(lock.lock().await);
    }

    let legacy_bots = {
        let mut guard = im_state.lock().await;
        std::mem::take(&mut *guard)
    };

    let agents = {
        let mut guard = agent_state.lock().await;
        std::mem::take(&mut *guard)
    };

    let mut legacy_count = 0usize;
    for (bot_id, instance) in legacy_bots {
        legacy_count += 1;
        if let Err(err) = shutdown_bot_instance(instance, sidecar_manager, &bot_id).await {
            ulog_warn!(
                "[im] Update shutdown: bot {} graceful shutdown failed: {}",
                bot_id,
                err
            );
        }
    }

    let mut agent_count = 0usize;
    let mut channel_count = 0usize;
    for (agent_id, mut agent) in agents {
        agent_count += 1;
        if let Some(handle) = agent.heartbeat_handle.take() {
            handle.abort();
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        }
        for (channel_id, channel) in agent.channels {
            channel_count += 1;
            if let Err(err) =
                shutdown_bot_instance(channel.bot_instance, sidecar_manager, &channel_id).await
            {
                ulog_warn!(
                    "[im] Update shutdown: channel {} of agent {} graceful shutdown failed: {}",
                    channel_id,
                    agent_id,
                    err
                );
            }
        }
    }

    ulog_info!(
        "[im] Update shutdown stopped {} legacy bot(s), {} agent(s), {} agent channel(s)",
        legacy_count,
        agent_count,
        channel_count
    );
}

/// Finalize a text block's draft message.
/// Uses adapter.max_message_length() to determine the platform's limit.
/// Detects draft mode from the draft_id string (`draft:xxx` prefix) rather than the adapter
/// trait method — this is safe even if `draft_fallback` flips mid-stream, because the decision
/// is based on the actual ID type of the current block, not global adapter state.
pub(crate) async fn finalize_block<A: adapter::ImStreamAdapter>(
    adapter: &A,
    chat_id: &str,
    draft_id: Option<String>,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    let is_draft_id = draft_id
        .as_ref()
        .map_or(false, |id| id.starts_with("draft:"));
    if is_draft_id {
        // Draft mode: delete draft (no-op for draft: IDs) + send permanent message.
        // `sendMessageDraft` cannot be "committed" — only `sendMessage` creates a real message.
        if let Some(ref did) = draft_id {
            if let Err(e) = adapter.delete_message(chat_id, did).await {
                ulog_warn!("[im-stream] delete_message (draft finalize) failed: {}", e);
            }
        }
        if let Err(e) = adapter.send_message(chat_id, text).await {
            ulog_warn!("[im-stream] send_message (draft finalize) failed: {}", e);
        }
    } else {
        // Standard mode: edit-in-place or delete+send
        let max_len = adapter.max_message_length();
        if let Some(ref did) = draft_id {
            if text.len() <= max_len {
                if let Err(e) = adapter.finalize_message(chat_id, did, text).await {
                    ulog_warn!("[im] Finalize edit failed: {}, sending as new message", e);
                    if let Err(e2) = adapter.send_message(chat_id, text).await {
                        ulog_warn!(
                            "[im-stream] send_message (finalize fallback) failed: {}",
                            e2
                        );
                    }
                }
            } else {
                // Too long for edit: delete draft → send_message (auto-splits)
                if let Err(e) = adapter.delete_message(chat_id, did).await {
                    ulog_warn!("[im-stream] delete_message (too-long draft) failed: {}", e);
                }
                if let Err(e) = adapter.send_message(chat_id, text).await {
                    ulog_warn!("[im-stream] send_message (too-long split) failed: {}", e);
                }
            }
        } else {
            // No draft created (very fast response) → send directly
            if let Err(e) = adapter.send_message(chat_id, text).await {
                ulog_warn!("[im-stream] send_message (no-draft direct) failed: {}", e);
            }
        }
    }
}

/// Schedule serialized IM/Agent transport reconnects after a general proxy
/// change. The lifecycle and durable reconciliation live in `config_store`;
/// this facade remains for the proxy command boundary.
pub async fn restart_channels_for_general_proxy_change(
    app_handle: &AppHandle,
    agent_state: &ManagedAgents,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
) -> u32 {
    config_store::schedule_general_proxy_channel_reconnects(
        app_handle,
        agent_state,
        im_state,
        sidecar_manager,
    )
    .await
}

/// Format draft display text (truncate if needed for platform limit).
/// `max_len` is the platform's message limit in bytes (e.g. 4096 for Telegram, 15000 for Feishu).
pub(crate) fn format_draft_text(text: &str, max_len: usize) -> String {
    // Reserve a small margin for the "..." truncation indicator
    let limit = max_len.saturating_sub(10);
    if text.len() > limit {
        // Find a char-boundary-safe truncation point
        let mut truncate_at = limit.min(text.len());
        while !text.is_char_boundary(truncate_at) && truncate_at > 0 {
            truncate_at -= 1;
        }
        format!("{}...", &text[..truncate_at])
    } else {
        text.to_string()
    }
}

/// Check if text has accumulated enough for a meaningful first send.
/// Triggers on sentence-ending punctuation or minimum length threshold.
/// Only affects first-send timing; subsequent edits use `preferred_throttle_ms`.
pub(crate) fn has_sentence_boundary(text: &str) -> bool {
    const MIN_FIRST_SEND_LEN: usize = 20;
    if text.chars().count() >= MIN_FIRST_SEND_LEN {
        return true;
    }
    let trimmed = text.trim_end();
    trimmed.ends_with('\n')
        || trimmed.ends_with('。')
        || trimmed.ends_with('，')
        || trimmed.ends_with('！')
        || trimmed.ends_with('？')
        || trimmed.ends_with('；')
        || trimmed.ends_with('：')
        || trimmed.ends_with(',')
        || trimmed.ends_with('.')
        || trimmed.ends_with('!')
        || trimmed.ends_with('?')
        || trimmed.ends_with(';')
        || trimmed.ends_with(':')
}

/// Translate plugin command descriptions to Chinese for /help display.
/// Falls back to the original English description if no translation is available.
fn translate_plugin_command_desc(name: &str, desc: &str) -> String {
    // Match by command name for known OpenClaw plugin commands
    match name {
        "feishu_diagnose" => "运行飞书插件诊断，检查配置、连接和权限".to_string(),
        "feishu_doctor" => "运行飞书插件诊断".to_string(),
        "feishu_auth" | "feishu auth" => "批量授权飞书用户权限".to_string(),
        "feishu" => "飞书插件命令（子命令：auth, doctor, start）".to_string(),
        _ => {
            if desc.is_empty() {
                "无描述".to_string()
            } else {
                desc.to_string()
            }
        }
    }
}

// `extract_sse_data` was used by the legacy `stream_to_im[_streaming]` SSE
// consumer. After Pattern C-7 deletion, the equivalent helper lives in
// `event_consumer::extract_data` (used by the new long-poll consumer task).

/// Generate a non-conflicting file path by appending _1, _2, etc.
fn auto_rename_path(path: &std::path::Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(path);
    for i in 1..100 {
        let new_name = format!("{}_{}{}", stem, i, ext);
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path;
        }
    }
    path.to_path_buf()
}
