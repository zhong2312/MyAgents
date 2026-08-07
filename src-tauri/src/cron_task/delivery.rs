use super::*;
use std::sync::Arc;
use tauri::Manager;

/// Task Center adapter (v0.1.69) — deliver a Task status notification to an IM
/// Bot via the existing cron delivery pipeline. The caller supplies the bot
/// channel id and (optional) chat thread; platform is looked up on the fly.
///
/// Safe to call from outside `cron_task`; it handles the case where IM state
/// is missing, the bot isn't running, etc. — all errors are logged and swallowed.
pub async fn deliver_task_notification_to_bot(
    handle: &AppHandle,
    bot_channel_id: &str,
    bot_thread: Option<&str>,
    task_id: &str,
    summary: &str,
) {
    let _ = deliver_task_notification_to_bot_checked(
        handle,
        bot_channel_id,
        bot_thread,
        task_id,
        summary,
    )
    .await;
}

/// Same as `deliver_task_notification_to_bot` but returns `true` when the bot
/// lookup + dispatch happened, `false` when the bot wasn't registered /
/// offline / IM state missing. The Task Center uses the bool to decide
/// whether to fire a desktop fallback (PRD §12.6).
pub async fn deliver_task_notification_to_bot_checked(
    handle: &AppHandle,
    bot_channel_id: &str,
    bot_thread: Option<&str>,
    task_id: &str,
    summary: &str,
) -> bool {
    // Structural precheck — confirm the bot channel is actually registered
    // somewhere the router can reach. This catches the majority of failure
    // modes (bot offline, bot removed, IM state not yet initialized).
    let reachable = {
        let mut found = false;
        if let Some(agent_state) = handle.try_state::<crate::im::ManagedAgents>() {
            let agents_guard = agent_state.lock().await;
            for (_, agent) in agents_guard.iter() {
                if agent.channels.contains_key(bot_channel_id) {
                    found = true;
                    break;
                }
            }
        }
        if !found {
            if let Some(im_state) = handle.try_state::<crate::im::ManagedImBots>() {
                let guard = im_state.lock().await;
                if guard.contains_key(bot_channel_id) {
                    found = true;
                }
            }
        }
        found
    };
    if !reachable {
        ulog_warn!(
            "[CronTask] Task notification for {} targeted bot {} but channel is not registered",
            task_id,
            bot_channel_id
        );
        return false;
    }

    let delivery = CronDelivery {
        bot_id: bot_channel_id.to_string(),
        chat_id: bot_thread.unwrap_or("").to_string(),
        platform: "task-center".to_string(),
    };
    // Task Center task-completion notifications have no associated cron run,
    // so there is no session id to use as the follow-up anchor. Caller passes
    // None and the helper falls back to the legacy un-decorated prompt — the
    // IM Bot AI still sees the result, just without the `<inbox-message>`
    // envelope + `Source session id:` follow-up line (which would be wrong
    // here anyway: a `myagents session send` against the Task Center task id
    // wouldn't deliver to any session).
    deliver_cron_result_to_bot(handle, &delivery, task_id, summary, None).await
}

async fn resolve_cron_task_workspace(task_id: &str) -> Option<String> {
    if let Some(task) = crate::task::get_task_store()?.get(task_id).await {
        return Some(task.workspace_path);
    }
    get_cron_task_manager()
        .get_legacy_task(task_id)
        .await
        .map(|task| task.workspace_path)
}

async fn find_agent_id_for_delivery(
    agent_state: &crate::im::ManagedAgents,
    delivery_bot_id: &str,
    task_workspace: Option<&str>,
) -> Option<String> {
    let normalized_task_workspace = task_workspace.map(crate::cron_task::normalize_path);
    let agents_guard = agent_state.lock().await;
    let mut first_channel_match = None;

    for (agent_id, agent) in agents_guard.iter() {
        if !agent.channels.contains_key(delivery_bot_id) {
            continue;
        }
        if first_channel_match.is_none() {
            first_channel_match = Some(agent_id.clone());
        }
        if let Some(task_workspace) = normalized_task_workspace.as_ref() {
            if crate::cron_task::normalize_path(&agent.config.resolved_workspace_path)
                == *task_workspace
            {
                return Some(agent_id.clone());
            }
        }
    }

    first_channel_match
}

async fn append_pending_cron_event(
    pending_cron_events: &Arc<tokio::sync::Mutex<Vec<crate::im::types::PendingCronEvent>>>,
    bot_id: &str,
    target_session_key: Option<String>,
    task_id: &str,
    summary: &str,
    cron_from_session_id: Option<String>,
    cron_from_label: Option<String>,
) {
    // Cap to keep memory bounded if the bot is offline for an extended period.
    const MAX_PENDING_CRON_EVENTS: usize = 50;
    let mut pending = pending_cron_events.lock().await;
    while pending.len() >= MAX_PENDING_CRON_EVENTS {
        let evicted = pending.remove(0);
        ulog_warn!(
            "[CronTask] pending_cron_events at cap ({}) for bot {} — evicting oldest task_id={}",
            MAX_PENDING_CRON_EVENTS,
            bot_id,
            evicted.task_id
        );
    }
    pending.push(crate::im::types::PendingCronEvent {
        target_session_key,
        event: "cron_complete".to_string(),
        task_id: task_id.to_string(),
        content: summary.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis().max(0) as u64,
        from_session_id: cron_from_session_id,
        from_label: cron_from_label,
    });
    ulog_info!(
        "[CronTask] Appended cron event to bot {} pending (now {} pending)",
        bot_id,
        pending.len()
    );
}

async fn wake_heartbeat_for_cron(
    wake_tx: Option<&tokio::sync::mpsc::Sender<crate::im::types::HeartbeatWake>>,
    bot_id: &str,
    wake: crate::im::types::HeartbeatWake,
) {
    if let Some(wake_tx) = wake_tx {
        if let Err(e) = wake_tx.send(wake).await {
            ulog_warn!(
                "[CronTask] Failed to wake heartbeat for bot {}: {}",
                bot_id,
                e
            );
        } else {
            ulog_info!("[CronTask] Heartbeat wake sent for bot {}", bot_id);
        }
    } else {
        ulog_warn!(
            "[CronTask] Bot {} has no heartbeat_wake_tx — cron event will sit in \
             pending until next interval tick (up to heartbeat interval)",
            bot_id
        );
    }
}

/// Deliver cron task completion result to IM Bot.
///
/// **v0.2.4 redesign:** the cron event payload now lives in
/// `ImBotInstance.pending_cron_events` (Rust-side, durable across sidecar
/// process restarts). The heartbeat runner snapshots that vec on each cycle
/// and ships it to the sidecar via heartbeat HTTP body, then clears delivered
/// entries only after the IM platform actually accepted the relay. This makes
/// the cron→IM hand-off at-least-once — sidecar death, AI silent reply, and
/// `push_text_preferring_stream` failure all leave the entry pending for the
/// next heartbeat to retry.
///
/// Steps:
///   1. Append a `PendingCronEvent` to the bot's pending vec.
///   2. Wake the heartbeat runner (which will deliver it).
///
/// (The legacy POST `/api/im/system-event` + sidecar `systemEventQueue` path
/// is no longer used for cron events. Sidecar still accepts that endpoint for
/// other event kinds — body field takes precedence when both are present.)
pub(crate) async fn deliver_cron_result_to_bot(
    handle: &AppHandle,
    delivery: &CronDelivery,
    task_id: &str,
    summary: &str,
    // Session id of the cron run whose result is being delivered. Passed
    // explicitly (rather than looked up via task_id) so a concurrent
    // `trigger_now` that rotates the task's session_id between this run
    // finishing and delivery firing can't smuggle the wrong id into the
    // follow-up envelope. None means caller doesn't have a session anchor
    // (e.g. Task Center notification — no associated cron session); we
    // then fall back to the legacy un-decorated prompt.
    run_session_id: Option<&str>,
) -> bool {
    // PRD 0.2.18 Phase 3 — derive cron task session metadata (cron task name +
    // session id) for inbox-style envelope wrapping. Cron task fires *into* an
    // IM Bot session; the IM Bot AI sees the cron result as an `<inbox-message
    // from="Cron: <name>" reply_back="false">` prefix so it can later use
    // `myagents session send <from_session_id>` to follow up. Look-up is
    // best-effort — failures fall back to the legacy un-decorated cron prompt.
    // session id: caller-supplied (race-free); label: name lookup is stable
    // even if a concurrent rotate has updated session_id underneath.
    let (cron_from_session_id, cron_from_label) = match run_session_id {
        Some(sid) if !sid.is_empty() => {
            let label = resolve_cron_inbox_label(task_id).await;
            (Some(sid.to_string()), label)
        }
        _ => (None, None),
    };

    ulog_info!(
        "[CronTask] Delivering result for task {} to bot {} (platform: {})",
        task_id,
        delivery.bot_id,
        delivery.platform
    );

    let reason = crate::im::types::WakeReason::CronComplete {
        task_id: task_id.to_string(),
        summary: summary.to_string(),
    };

    let task_workspace = resolve_cron_task_workspace(task_id).await;
    if let Some(agent_state) = handle.try_state::<crate::im::ManagedAgents>() {
        if let Some(agent_id) =
            find_agent_id_for_delivery(&agent_state, &delivery.bot_id, task_workspace.as_deref())
                .await
        {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            let (route, _work_guard) = loop {
                match crate::im::resolve_agent_heartbeat_route(&agent_state, &agent_id).await {
                    crate::im::AgentHeartbeatRouteResolution::Target(route) => {
                        if let Some(guard) = route.model_work_gate.try_enter() {
                            break (route, guard);
                        }
                    }
                    crate::im::AgentHeartbeatRouteResolution::NoPrivateTarget
                    | crate::im::AgentHeartbeatRouteResolution::AgentMissing => {}
                }
                if tokio::time::Instant::now() >= deadline {
                    ulog_warn!(
                        "[CronTask] Agent {} unavailable during transport reconnect; task {} result stays in execution history",
                        agent_id,
                        task_id
                    );
                    return false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            };

            append_pending_cron_event(
                &route.pending_cron_events,
                &route.target.channel_id,
                Some(route.target.session_key.clone()),
                task_id,
                summary,
                cron_from_session_id,
                cron_from_label,
            )
            .await;
            let wake =
                crate::im::types::HeartbeatWake::targeted(reason, route.target.session_key.clone());
            wake_heartbeat_for_cron(route.wake_tx.as_ref(), &route.target.channel_id, wake).await;
            return true;
        }
    }

    let im_state: tauri::State<'_, crate::im::ManagedImBots> = match handle.try_state() {
        Some(s) => s,
        None => {
            ulog_warn!("[CronTask] Cannot deliver result: IM state not available");
            return false;
        }
    };

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    let (pending_cron_events, wake_tx, _work_guard) = loop {
        let candidate = {
            let im_guard = im_state.lock().await;
            im_guard.get(&delivery.bot_id).map(|instance| {
                (
                    std::sync::Arc::clone(&instance.pending_cron_events),
                    instance.heartbeat_wake_tx.clone(),
                    std::sync::Arc::clone(&instance.model_work_gate),
                )
            })
        };
        if let Some((pending, wake, gate)) = candidate {
            if let Some(guard) = gate.try_enter() {
                break (pending, wake, guard);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            ulog_warn!(
                "[CronTask] Cannot deliver result: Bot {} is unavailable during transport reconnect. Task result remains in execution history.",
                delivery.bot_id
            );
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };

    append_pending_cron_event(
        &pending_cron_events,
        &delivery.bot_id,
        None,
        task_id,
        summary,
        cron_from_session_id,
        cron_from_label,
    )
    .await;
    wake_heartbeat_for_cron(
        wake_tx.as_ref(),
        &delivery.bot_id,
        crate::im::types::HeartbeatWake::new(reason),
    )
    .await;
    true
}

/// PRD 0.2.18 Phase 3 — look up the user-visible label for the
/// `<inbox-message from="…">` wrap (e.g. `Cron: GitHub Issue 自动化处理`).
/// Returns None when task lookup fails (sidecar then falls back to the
/// legacy un-decorated cron prompt). Stable across concurrent
/// `rotate_new_session_id` writes because it reads `task.name`, not
/// `task.session_id`.
///
/// Why this lives separate from the session-id resolution: the session id
/// is now caller-supplied (see `deliver_cron_result_to_bot`'s
/// `run_session_id` parameter) precisely because looking it up here would
/// race with rotate. The label has no such concern.
///
/// TaskStore is authoritative for migrated/new tasks. The singleton legacy
/// facade is consulted only when a read-only historical row has no Task.
async fn resolve_cron_inbox_label(task_id: &str) -> Option<String> {
    if let Some(task) = crate::task::get_task_store()?.get(task_id).await {
        return Some(format!("Task: {}", task.name));
    }
    let task = get_cron_task_manager().get_legacy_task(task_id).await?;
    Some(
        task.name
            .map(|n| format!("Cron: {n}"))
            .unwrap_or_else(|| format!("Cron task {}", &task_id[..task_id.len().min(8)])),
    )
}
