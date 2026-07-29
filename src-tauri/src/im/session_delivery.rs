use std::sync::Arc;

use super::{adapter, types::ImSourceType, AnyAdapter, ManagedAgents, ManagedImBots};

#[derive(Clone)]
pub(crate) struct SessionChannelTarget {
    pub adapter: Arc<AnyAdapter>,
    pub chat_id: String,
    pub channel_id: String,
    pub source_type: ImSourceType,
}

type ChannelSnapshot = (
    String,
    Arc<AnyAdapter>,
    Arc<tokio::sync::Mutex<super::router::SessionRouter>>,
);

async fn find_in_snapshots(
    snapshots: Vec<ChannelSnapshot>,
    session_id: &str,
) -> Option<SessionChannelTarget> {
    for (channel_id, adapter, router) in snapshots {
        let router = router.lock().await;
        let peer = router
            .peer_sessions_iter()
            .find(|peer| peer.session_id == session_id)
            .map(|peer| (peer.source_id.clone(), peer.source_type.clone()));
        drop(router);
        if let Some((chat_id, source_type)) = peer {
            return Some(SessionChannelTarget {
                adapter,
                chat_id,
                channel_id,
                source_type,
            });
        }
    }
    None
}

async fn bound_ids_in_snapshots(snapshots: Vec<ChannelSnapshot>) -> Vec<String> {
    let mut session_ids = Vec::new();
    for (_, _, router) in snapshots {
        session_ids.extend(router.lock().await.bound_session_ids());
    }
    session_ids.sort();
    session_ids.dedup();
    session_ids
}

fn configured_channel_health_paths() -> Vec<std::path::PathBuf> {
    let mut paths = super::config_store::read_agent_configs_from_disk()
        .into_iter()
        .flat_map(|agent| {
            agent.channels.into_iter().map(move |channel| {
                super::health::agent_channel_health_path(&agent.id, &channel.id)
            })
        })
        .collect::<Vec<_>>();
    paths.extend(
        super::config_store::read_im_configs_from_disk()
            .into_iter()
            .map(|(bot_id, _)| super::health::bot_health_path(&bot_id)),
    );
    paths
}

fn persisted_bound_session_ids(paths: impl IntoIterator<Item = std::path::PathBuf>) -> Vec<String> {
    let mut session_ids = paths
        .into_iter()
        .flat_map(|path| super::health::persisted_active_session_ids(&path))
        .collect::<Vec<_>>();
    session_ids.sort();
    session_ids.dedup();
    session_ids
}

fn configured_bound_session_ids() -> Vec<String> {
    persisted_bound_session_ids(configured_channel_health_paths())
}

pub(crate) fn configured_session_binding_exists(session_id: &str) -> bool {
    configured_bound_session_ids()
        .iter()
        .any(|bound_id| bound_id == session_id)
}

pub(crate) async fn has_session_binding(
    agents: &ManagedAgents,
    im_bots: &ManagedImBots,
    session_id: &str,
) -> bool {
    configured_session_binding_exists(session_id)
        || find_channel_for_session(Some(agents), Some(im_bots), session_id)
            .await
            .is_some()
}

/// Resolve the live IM channel bound to a session without holding an outer
/// ManagedAgents/ManagedImBots lock across router awaits.
pub(crate) async fn find_channel_for_session(
    agents: Option<&ManagedAgents>,
    im_bots: Option<&ManagedImBots>,
    session_id: &str,
) -> Option<SessionChannelTarget> {
    if let Some(agents) = agents {
        let snapshots = {
            let agents = agents.lock().await;
            agents
                .values()
                .flat_map(|agent| {
                    agent.channels.iter().map(|(channel_id, channel)| {
                        (
                            channel_id.clone(),
                            Arc::clone(&channel.bot_instance.adapter),
                            Arc::clone(&channel.bot_instance.router),
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        if let Some(target) = find_in_snapshots(snapshots, session_id).await {
            return Some(target);
        }
    }

    if let Some(im_bots) = im_bots {
        let snapshots = {
            let bots = im_bots.lock().await;
            bots.iter()
                .map(|(bot_id, bot)| {
                    (
                        bot_id.clone(),
                        Arc::clone(&bot.adapter),
                        Arc::clone(&bot.router),
                    )
                })
                .collect::<Vec<_>>()
        };
        return find_in_snapshots(snapshots, session_id).await;
    }

    None
}

/// Snapshot every Session identity retained by an IM channel binding.
/// Bindings remain authoritative in channel health state while a channel is
/// stopped or temporarily detached for replacement, so neither an absent live
/// router nor an absent `SidecarOwner::Agent` permits transcript deletion.
pub(crate) async fn bound_session_ids(
    agents: &ManagedAgents,
    im_bots: &ManagedImBots,
) -> Vec<String> {
    let mut snapshots = {
        let agents = agents.lock().await;
        agents
            .values()
            .flat_map(|agent| {
                agent.channels.iter().map(|(channel_id, channel)| {
                    (
                        channel_id.clone(),
                        Arc::clone(&channel.bot_instance.adapter),
                        Arc::clone(&channel.bot_instance.router),
                    )
                })
            })
            .collect::<Vec<_>>()
    };
    {
        let bots = im_bots.lock().await;
        snapshots.extend(bots.iter().map(|(bot_id, bot)| {
            (
                bot_id.clone(),
                Arc::clone(&bot.adapter),
                Arc::clone(&bot.router),
            )
        }));
    }
    let mut session_ids = bound_ids_in_snapshots(snapshots).await;
    session_ids.extend(configured_bound_session_ids());
    session_ids.sort();
    session_ids.dedup();
    session_ids
}

/// Push one completed assistant response through the original session's IM
/// channel. Returns false for desktop-only sessions.
pub(crate) async fn push_assistant_text_for_session(
    agents: Option<&ManagedAgents>,
    im_bots: Option<&ManagedImBots>,
    session_id: &str,
    text: &str,
) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Ok(false);
    }
    let Some(target) = find_channel_for_session(agents, im_bots, session_id).await else {
        return Ok(false);
    };
    push_assistant_text(&target, text).await?;
    Ok(true)
}

pub(crate) async fn push_assistant_text(
    target: &SessionChannelTarget,
    text: &str,
) -> Result<(), String> {
    if should_suppress_silent_reply(&target.source_type, text) {
        return Ok(());
    }
    adapter::push_text_preferring_stream(target.adapter.as_ref(), &target.chat_id, text)
        .await
        .map_err(|error| {
            format!(
                "failed to push assistant response to channel {}: {}",
                target.channel_id, error
            )
        })
}

fn should_suppress_silent_reply(source_type: &ImSourceType, text: &str) -> bool {
    matches!(source_type, ImSourceType::Group) && matches!(text.trim(), "<NO_REPLY>" | "NO_REPLY")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_silent_reply_is_not_delivered() {
        assert!(should_suppress_silent_reply(
            &ImSourceType::Group,
            " <NO_REPLY> "
        ));
        assert!(!should_suppress_silent_reply(
            &ImSourceType::Private,
            "<NO_REPLY>"
        ));
        assert!(!should_suppress_silent_reply(
            &ImSourceType::Group,
            "Progress update"
        ));
    }

    #[test]
    fn persisted_bindings_survive_a_detached_channel_window() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let mut state = super::super::types::ImHealthState::default();
        state.active_sessions = vec![super::super::types::ImActiveSession {
            session_key: "agent:a:weixin:private:u1".to_string(),
            session_id: "detached-session".to_string(),
            source_type: ImSourceType::Private,
            source_id: Some("u1".to_string()),
            source_display_name: None,
            last_sender_name: None,
            workspace_path: "/tmp/workspace".to_string(),
            message_count: 1,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: chrono::Utc::now().to_rfc3339(),
        }];
        std::fs::write(&path, serde_json::to_vec(&state).expect("serialize state"))
            .expect("write state");

        assert_eq!(
            persisted_bound_session_ids([path]),
            vec!["detached-session".to_string()]
        );
    }
}
