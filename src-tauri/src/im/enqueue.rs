use super::*;

// ===== IM Pipeline v2 — Pattern C helpers =====

/// Lazily ensure an `ImEventConsumer` task is running for `session_key`.
/// Detects Sidecar rotation (port change) and respawns when needed.
/// Returns the consumer handle so the caller can register a new ReplySlot.
///
/// `sidecar_manager` is consulted in a final-check inside the registry lock:
/// the (session_id, generation) captured by the caller must still be live
/// when we're about to insert. Otherwise (sidecar removed during the gap
/// between caller's `ensure_sidecar` and our lock acquisition) we abort the
/// insert and return a fresh-but-unregistered router — this avoids
/// installing an orphan consumer that hammers a dead port until the next
/// idle collector tick. The caller's next message will retry through a
/// fresh `ensure_sidecar` and re-enter this function with a new generation.
#[allow(clippy::too_many_arguments)]
// Single call site; refactoring into a
// struct would not improve readability and would obscure the lifetime
// relationships between borrowed parameters.
/// Returns `Some(router)` when a consumer is bound and ready (either
/// reused or freshly spawned). Returns `None` when the captured sidecar
/// identity `(session_id, generation)` is no longer live in the manager —
/// either the sidecar was removed during the gap between caller's
/// `ensure_sidecar` and our lock, or it was upgraded to a different
/// session_id key. Callers MUST treat `None` as "abort this message;
/// retry on next" rather than blindly proceeding to register/enqueue:
/// without a consumer in the registry, SSE events from the (possibly
/// recreated) sidecar have no listener and any registered ReplySlot
/// would leak.
pub(super) async fn ensure_im_consumer<A>(
    consumers: &ImConsumers,
    sidecar_manager: &ManagedSidecarManager,
    session_key: &str,
    sidecar_port: u16,
    sidecar_session_id: &str,
    sidecar_generation: u64,
    initial_replay_request_id: String,
    adapter: Arc<A>,
    pending_approvals: PendingApprovals,
    pending_questions: PendingQuestions,
    stream_client: Client,
    on_terminal: Arc<dyn Fn(String, reply_router::TerminalOutcome) + Send + Sync>,
) -> Option<reply_router::SharedReplyRouter>
where
    A: adapter::ImStreamAdapter + Send + Sync + 'static,
{
    let mut guard = consumers.lock().await;
    if let Some(existing) = guard.get(session_key) {
        // Reuse the existing entry only if EVERYTHING about the sidecar
        // identity matches: same session_id (catches `upgrade_session_id` —
        // SidecarManager rewrites its key while keeping the underlying
        // process; consumer would otherwise stay bound to the old logical id
        // and miss future stop broadcasts), same port, same generation (the
        // global instance ID), not already cancelled, AND the captured
        // identity is currently live in the manager. The last check closes
        // the upgrade-during-gap race: if `on_terminal` upgraded the
        // session_id between caller's capture and our lock, broadcast for
        // (old_sid, gen) is in flight — manager already shows old_sid as
        // not live, so we cancel + respawn against the latest captured info
        // instead of returning the stale entry.
        let identity_match = existing.sidecar_session_id == sidecar_session_id
            && existing.sidecar_port == sidecar_port
            && existing.sidecar_generation == sidecar_generation
            && !existing.cancel.load(std::sync::atomic::Ordering::SeqCst);
        let identity_live = identity_match
            && sidecar_manager
                .lock()
                .unwrap()
                .is_live(sidecar_session_id, sidecar_generation);
        if identity_live {
            return Some(Arc::clone(&existing.reply_router));
        }
        // Any drift OR captured identity no longer live — cancel old before
        // respawn. Falling through still hits the post-cancel final-check
        // below, which will return None if no live sidecar matches the
        // captured identity at all.
        existing
            .cancel
            .store(true, std::sync::atomic::Ordering::SeqCst);
        guard.remove(session_key);
    }

    // Final-check: is the *specific* sidecar instance still live? Use
    // `is_live` (not just `generation_for`) — `is_live` requires both the
    // sidecars HashMap entry to exist AND the generation to match the one
    // we captured. This catches the gap between caller's ensure_sidecar and
    // our lock: if a stop landed during that gap, the subscriber may not
    // have drained it yet and `sidecar_generations` may even still hold a
    // stale entry, but `sidecars.contains_key` would be false.
    {
        let mgr = sidecar_manager.lock().unwrap();
        if !mgr.is_live(sidecar_session_id, sidecar_generation) {
            ulog_warn!(
                "[im] ensure_im_consumer aborting insert for {} — sidecar instance {}@gen{} no longer live. Caller should abort and retry on next message.",
                session_key, sidecar_session_id, sidecar_generation
            );
            return None;
        }
    }

    let cancel: event_consumer::CancelFlag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reply_router = reply_router::shared_router(pending_approvals, pending_questions);
    let join = event_consumer::spawn_consumer(
        stream_client,
        sidecar_port,
        sidecar_session_id.to_string(),
        initial_replay_request_id,
        Arc::clone(&reply_router),
        adapter,
        Arc::clone(&cancel),
        on_terminal,
    );
    guard.insert(
        session_key.to_string(),
        ImConsumerHandle {
            cancel,
            reply_router: Arc::clone(&reply_router),
            sidecar_port,
            sidecar_session_id: sidecar_session_id.to_string(),
            sidecar_generation,
            _join: join,
        },
    );
    Some(reply_router)
}

/// Cancel + remove a consumer. Wired into shutdown / idle-collect / runtime-drift
/// (C3 fix): Tokio JoinHandles don't auto-cancel on drop, so the long-poll loop
/// would keep reconnecting against a dead Sidecar port if the AtomicBool isn't
/// flipped explicitly.
pub(super) async fn drop_im_consumer(consumers: &ImConsumers, session_key: &str) {
    let mut guard = consumers.lock().await;
    if let Some(handle) = guard.remove(session_key) {
        handle
            .cancel
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// POST /api/im/enqueue — synchronous enqueue, returns immediately.
/// Replaces `stream_to_im` for the new IM Pipeline v2 protocol. peer_lock
/// (held by the caller) wraps only this call (~ms), enabling concurrent
/// in-flight messages on the same chat_id.
pub(super) async fn enqueue_to_sidecar(
    client: &Client,
    port: u16,
    msg: &ImMessage,
    permission_mode: &str,
    provider_env: Option<&serde_json::Value>,
    model: Option<&str>,
    runtime: &str,
    runtime_config: Option<&serde_json::Value>,
    images: Option<&Vec<serde_json::Value>>,
    bot_id: Option<&str>,
    bot_name: Option<&str>,
    group_context: Option<&GroupStreamContext>,
    metadata_birth_pending: bool,
    config_held_by_frontend: bool,
    allowed_users: Option<&[String]>,
    adapter_bridge_context: Option<(u16, String, Vec<String>)>,
) -> Result<Option<String>, RouteError> {
    let source_owned;
    let source: &str = match (&msg.platform, &msg.source_type) {
        (ImPlatform::Telegram, ImSourceType::Private) => "telegram_private",
        (ImPlatform::Telegram, ImSourceType::Group) => "telegram_group",
        (ImPlatform::Feishu, ImSourceType::Private) => "feishu_private",
        (ImPlatform::Feishu, ImSourceType::Group) => "feishu_group",
        (ImPlatform::Dingtalk, ImSourceType::Private) => "dingtalk_private",
        (ImPlatform::Dingtalk, ImSourceType::Group) => "dingtalk_group",
        (ImPlatform::OpenClaw(ref id), ImSourceType::Private) => {
            source_owned = format!("{}_private", id);
            &source_owned
        }
        (ImPlatform::OpenClaw(ref id), ImSourceType::Group) => {
            source_owned = format!("{}_group", id);
            &source_owned
        }
    };
    let mut body = json!({
        "message": msg.text,
        "source": source,
        "sourceId": msg.chat_id,
        "senderName": msg.sender_name,
        "permissionMode": permission_mode,
        "requestId": msg.request_id,
        "metadataBirthPending": metadata_birth_pending,
        "configHeldByTab": config_held_by_frontend,
        "hostInteraction": HostInteractionCapability::for_platform(&msg.platform),
    });
    if !is_external_runtime_type(runtime) {
        if let Some(env) = provider_env {
            body["providerEnv"] = env.clone();
        }
        if let Some(m) = model {
            body["model"] = json!(m);
        }
    }
    body["runtime"] = json!(runtime);
    if let Some(config) = runtime_config {
        body["runtimeConfig"] = config.clone();
    }
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            body["images"] = json!(imgs);
        }
    }
    if let Some(bid) = bot_id {
        body["botId"] = json!(bid);
    }
    if let Some(bn) = bot_name {
        body["botName"] = json!(bn);
    }
    if let Some(gc) = group_context {
        body["sourceType"] = json!("group");
        body["groupName"] = json!(gc.group_name);
        body["groupPlatform"] = json!(match &gc.platform {
            ImPlatform::Telegram => "Telegram".to_string(),
            ImPlatform::Feishu => "飞书".to_string(),
            ImPlatform::Dingtalk => "钉钉".to_string(),
            ImPlatform::OpenClaw(id) => id.clone(),
        });
        body["groupActivation"] = json!(match gc.activation {
            GroupActivation::Mention => "mention",
            GroupActivation::Always => "always",
        });
        body["isFirstGroupTurn"] = json!(gc.is_first_turn);
        body["isMention"] = json!(gc.is_mention);
        body["messageCount"] = json!(gc.message_count);
        if let Some(ref history) = gc.pending_history {
            body["pendingHistory"] = json!(history);
        }
        if !gc.tools_deny.is_empty() {
            body["groupToolsDeny"] = json!(gc.tools_deny);
        }
    }
    if let Some(ref rtb) = msg.reply_to_body {
        if !rtb.is_empty() {
            body["replyToBody"] = json!(rtb);
        }
    }
    if let Some(ref gsp) = msg.group_system_prompt {
        if !gsp.is_empty() {
            body["groupSystemPrompt"] = json!(gsp);
        }
    }
    if let Some((bridge_port, bridge_plugin_id, tool_groups)) = adapter_bridge_context {
        body["bridgePort"] = json!(bridge_port);
        body["bridgePluginId"] = json!(bridge_plugin_id);
        body["bridgeEnabledToolGroups"] = json!(tool_groups);
        body["senderId"] = json!(msg.sender_id);
        if let Some(account_id) = msg.account_id.as_deref() {
            body["accountId"] = json!(account_id);
        }
        let is_owner = match allowed_users {
            Some(users) if !users.is_empty() => users.contains(&msg.sender_id),
            _ => false,
        };
        body["senderIsOwner"] = json!(is_owner);
    }

    let url = format!("http://127.0.0.1:{}/api/im/enqueue", port);
    let response = client
        .post(&url)
        .header("X-MyAgents-Request-Id", &msg.request_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| RouteError::Unavailable(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return Err(RouteError::Response(status, error_text));
    }

    // Parse response: { success, requestId, accepted, sessionId }
    let resp_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| RouteError::Unavailable(format!("enqueue parse: {}", e)))?;
    Ok(resp_body["sessionId"].as_str().map(String::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask_cap(platform: ImPlatform) -> String {
        HostInteractionCapability::for_platform(&platform).ask_user_question
    }

    #[test]
    fn host_interaction_only_marks_native_feishu_as_native_card() {
        assert_eq!(ask_cap(ImPlatform::Feishu), "native-card");
        assert_eq!(ask_cap(ImPlatform::OpenClaw("feishu".to_string())), "none");
        assert_eq!(ask_cap(ImPlatform::OpenClaw("lark".to_string())), "none");
        assert_eq!(ask_cap(ImPlatform::OpenClaw("qqbot".to_string())), "none");
        assert_eq!(ask_cap(ImPlatform::Telegram), "none");
    }
}
