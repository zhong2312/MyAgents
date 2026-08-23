use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::device_identity::{current_device_identity, DeviceIdentity};
use crate::workspace_files::path_safety::validate_workspace_root;

use super::{
    authorized_json_data_request, authorized_multipart_data_request, ensure_space_available,
    normalized_avatar_upload_part, optional_value_string, read_current_session,
    read_current_session_for_base_url, require_session, required_value_string, safe_local_name,
    session_space_id, session_space_segment, session_user_id, space_base_url,
    space_base_urls_equal, space_data_dir, try_upsert_space_user_device, url_component,
    value_string_array, with_json_file_lock, write_private_json_unlocked, SpaceCommandResult,
    SpaceRuntimeScope, SpaceSession, MAX_CLOUD_ISSUE_INSTRUCTION_CHARS, MAX_PROFILE_AVATAR_BYTES,
};

const LOCAL_AGENTS_FILE: &str = "registered_agents.json";
const MAX_AGENT_AVATAR_BYTES: u64 = MAX_PROFILE_AVATAR_BYTES;
static SPACE_AGENT_LIFECYCLES: LazyLock<crate::keyed_lifecycle::KeyedLifecycleRegistry> =
    LazyLock::new(crate::keyed_lifecycle::KeyedLifecycleRegistry::new);

pub(super) async fn acquire_space_agent_lifecycle(
    base_url: &str,
    registered_agent_id: &str,
) -> crate::keyed_lifecycle::KeyedLifecycleGuard {
    let identity = format!(
        "{}\0{}",
        base_url.trim().trim_end_matches('/'),
        registered_agent_id.trim()
    );
    SPACE_AGENT_LIFECYCLES.acquire(&[&identity]).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceIssueSubscriptionRunMode {
    SingleSession,
    NewSession,
}

impl Default for SpaceIssueSubscriptionRunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

fn default_issue_subscription_run_mode() -> SpaceIssueSubscriptionRunMode {
    SpaceIssueSubscriptionRunMode::SingleSession
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceGoalSubscriptionSummary {
    pub id: String,
    pub space_id: String,
    pub actor_type: String,
    pub actor_id: String,
    pub goal_id: String,
    #[serde(default = "default_true")]
    pub include_subtree: bool,
    #[serde(default = "default_agent_state_filter")]
    pub state_filter: Vec<String>,
    #[serde(default)]
    pub goal_path_label: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRegisteredAgent {
    pub id: String,
    #[serde(default)]
    pub base_url: String,
    pub space_id: String,
    #[serde(default)]
    pub owner_user_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_platform: Option<String>,
    #[serde(default)]
    pub device_os_version: Option<String>,
    #[serde(default)]
    pub device_app_version: Option<String>,
    #[serde(default)]
    pub device_last_seen_at: Option<String>,
    #[serde(default)]
    pub local_workspace_id: Option<String>,
    #[serde(default)]
    pub local_agent_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub instruction_revision: i64,
    pub workspace_path: String,
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub avatar_source: Option<String>,
    #[serde(default)]
    pub avatar_preset_id: Option<String>,
    #[serde(default)]
    pub avatar_urls: Option<Value>,
    #[serde(default)]
    pub subscriptions: Vec<SpaceGoalSubscriptionSummary>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub goal_path_label: Option<String>,
    #[serde(default = "default_agent_state_filter")]
    pub state_filter: Vec<String>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub delivery_session_id: Option<String>,
    #[serde(default = "default_issue_subscription_run_mode")]
    pub issue_subscription_run_mode: SpaceIssueSubscriptionRunMode,
    #[serde(default)]
    pub issue_session_ids: BTreeMap<String, String>,
    pub token: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUserDeviceSummary {
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRegisteredAgentPublic {
    pub id: String,
    pub base_url: String,
    pub space_id: String,
    pub owner_user_id: Option<String>,
    pub device_id: Option<String>,
    pub client_id: Option<String>,
    pub device_name: Option<String>,
    pub device: Option<SpaceUserDeviceSummary>,
    pub is_local: Option<bool>,
    pub local_workspace_id: Option<String>,
    pub local_agent_id: Option<String>,
    pub workspace_id: Option<String>,
    pub display_name: String,
    pub instruction: Option<String>,
    pub instruction_revision: i64,
    pub workspace_path: String,
    pub workspace_label: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_source: Option<String>,
    pub avatar_preset_id: Option<String>,
    pub avatar_urls: Option<Value>,
    pub subscriptions: Vec<SpaceGoalSubscriptionSummary>,
    pub goal_id: Option<String>,
    pub goal_path_label: Option<String>,
    pub state_filter: Vec<String>,
    pub goal_md: Option<String>,
    pub delivery_session_id: Option<String>,
    pub issue_subscription_run_mode: SpaceIssueSubscriptionRunMode,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence: Option<String>,
    pub last_online_at: Option<String>,
    pub online_until: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<LocalRegisteredAgent> for LocalRegisteredAgentPublic {
    fn from(agent: LocalRegisteredAgent) -> Self {
        let device = agent_device_summary(&agent);
        Self {
            id: agent.id,
            base_url: agent.base_url,
            space_id: agent.space_id,
            owner_user_id: agent.owner_user_id,
            device_id: agent.device_id,
            client_id: agent.client_id,
            device_name: agent
                .device_name
                .or_else(|| device.as_ref().and_then(|item| item.device_name.clone())),
            device,
            is_local: None,
            local_workspace_id: agent.local_workspace_id,
            local_agent_id: agent.local_agent_id,
            workspace_id: agent.workspace_id,
            display_name: agent.display_name,
            instruction: agent.instruction,
            instruction_revision: agent.instruction_revision,
            workspace_path: agent.workspace_path,
            workspace_label: agent.workspace_label,
            avatar_url: agent.avatar_url,
            avatar_source: agent.avatar_source,
            avatar_preset_id: agent.avatar_preset_id,
            avatar_urls: agent.avatar_urls,
            subscriptions: agent.subscriptions,
            goal_id: agent.goal_id,
            goal_path_label: agent.goal_path_label,
            state_filter: agent.state_filter,
            goal_md: agent.goal_md,
            delivery_session_id: agent.delivery_session_id,
            issue_subscription_run_mode: agent.issue_subscription_run_mode,
            status: agent.status,
            presence: None,
            last_online_at: None,
            online_until: None,
            created_at: agent.created_at,
            updated_at: agent.updated_at,
        }
    }
}

fn value_issue_subscription_run_mode(
    value: &Value,
    key: &str,
) -> Option<SpaceIssueSubscriptionRunMode> {
    value
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn first_subscription_from_data(data: &Value) -> Option<&Value> {
    data.get("subscription").or_else(|| {
        data.get("subscriptions")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
    })
}

fn subscription_summary_from_value(value: &Value) -> Option<SpaceGoalSubscriptionSummary> {
    Some(SpaceGoalSubscriptionSummary {
        id: optional_value_string(value, "id")?,
        space_id: optional_value_string(value, "spaceId")?,
        actor_type: optional_value_string(value, "actorType")?,
        actor_id: optional_value_string(value, "actorId")?,
        goal_id: optional_value_string(value, "goalId")?,
        include_subtree: value
            .get("includeSubtree")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        state_filter: value_string_array(value, "stateFilter")
            .filter(|items| !items.is_empty())
            .unwrap_or_else(default_agent_state_filter),
        goal_path_label: optional_value_string(value, "goalPathLabel"),
        created_at: optional_value_string(value, "createdAt").unwrap_or_default(),
    })
}

fn subscriptions_from_data(data: &Value) -> Vec<SpaceGoalSubscriptionSummary> {
    if let Some(items) = data.get("subscriptions").and_then(Value::as_array) {
        return items
            .iter()
            .filter_map(subscription_summary_from_value)
            .collect();
    }
    data.get("subscription")
        .and_then(subscription_summary_from_value)
        .into_iter()
        .collect()
}

fn apply_registered_agent_contract(agent: &mut LocalRegisteredAgent, registered: &Value) {
    if registered.get("instruction").is_some() {
        agent.instruction = optional_value_string(registered, "instruction");
    }
    if let Some(revision) = registered
        .get("instructionRevision")
        .and_then(Value::as_i64)
    {
        agent.instruction_revision = revision.max(0);
    }
}

fn apply_subscriptions_to_local_agent(agent: &mut LocalRegisteredAgent, data: &Value) {
    let subscriptions = subscriptions_from_data(data);
    if data.get("subscription").is_none() && data.get("subscriptions").is_none() {
        return;
    }
    agent.subscriptions = subscriptions;
    agent.goal_id = agent.subscriptions.first().map(|item| item.goal_id.clone());
    agent.goal_path_label = agent
        .subscriptions
        .first()
        .and_then(|item| item.goal_path_label.clone());
    agent.state_filter = agent
        .subscriptions
        .first()
        .map(|item| item.state_filter.clone())
        .unwrap_or_else(default_agent_state_filter);
}

fn apply_cloud_avatar_to_local_agent(agent: &mut LocalRegisteredAgent, registered: &Value) {
    if registered.get("avatarUrl").is_some() {
        agent.avatar_url = optional_value_string(registered, "avatarUrl");
    }
    if registered.get("avatarSource").is_some() {
        agent.avatar_source = optional_value_string(registered, "avatarSource");
    }
    if registered.get("avatarPresetId").is_some() {
        agent.avatar_preset_id = optional_value_string(registered, "avatarPresetId");
    }
    if registered.get("avatarUrls").is_some() {
        agent.avatar_urls = registered
            .get("avatarUrls")
            .filter(|value| value.is_object())
            .cloned();
    }
}

fn agent_device_summary(agent: &LocalRegisteredAgent) -> Option<SpaceUserDeviceSummary> {
    let device_id = agent.device_id.as_deref()?.trim();
    if device_id.is_empty() {
        return None;
    }
    Some(SpaceUserDeviceSummary {
        device_id: device_id.to_string(),
        device_name: agent.device_name.clone(),
        platform: agent.device_platform.clone(),
        os_version: agent.device_os_version.clone(),
        app_version: agent.device_app_version.clone(),
        status: None,
        last_seen_at: agent.device_last_seen_at.clone(),
    })
}

fn device_summary_from_cloud(
    registered: &Value,
    fallback: Option<&LocalRegisteredAgent>,
    local_identity: Option<&DeviceIdentity>,
) -> Option<SpaceUserDeviceSummary> {
    let device_value = registered.get("device").filter(|value| value.is_object());
    let device_id = optional_value_string(registered, "deviceId")
        .or_else(|| device_value.and_then(|value| optional_value_string(value, "deviceId")))
        .or_else(|| fallback.and_then(|agent| agent.device_id.clone()))
        .or_else(|| local_identity.map(|identity| identity.device_id.clone()))?;
    let device_name = optional_value_string(registered, "deviceName")
        .or_else(|| device_value.and_then(|value| optional_value_string(value, "deviceName")))
        .or_else(|| fallback.and_then(|agent| agent.device_name.clone()))
        .or_else(|| local_identity.and_then(|identity| identity.device_name.clone()));
    Some(SpaceUserDeviceSummary {
        device_id,
        device_name,
        platform: device_value
            .and_then(|value| optional_value_string(value, "platform"))
            .or_else(|| fallback.and_then(|agent| agent.device_platform.clone()))
            .or_else(|| local_identity.map(|identity| identity.platform.clone())),
        os_version: device_value
            .and_then(|value| optional_value_string(value, "osVersion"))
            .or_else(|| fallback.and_then(|agent| agent.device_os_version.clone()))
            .or_else(|| local_identity.and_then(|identity| identity.os_version.clone())),
        app_version: device_value
            .and_then(|value| optional_value_string(value, "appVersion"))
            .or_else(|| fallback.and_then(|agent| agent.device_app_version.clone()))
            .or_else(|| local_identity.map(|identity| identity.app_version.clone())),
        status: device_value.and_then(|value| optional_value_string(value, "status")),
        last_seen_at: device_value
            .and_then(|value| optional_value_string(value, "lastSeenAt"))
            .or_else(|| fallback.and_then(|agent| agent.device_last_seen_at.clone())),
    })
}

fn local_registered_agent_public_from_cloud(
    session: &SpaceSession,
    registered: &Value,
    subscription: Option<&Value>,
    fallback: Option<&LocalRegisteredAgent>,
) -> Result<LocalRegisteredAgentPublic, String> {
    let device = device_summary_from_cloud(registered, fallback, None);
    let state_filter = subscription
        .and_then(|value| value_string_array(value, "stateFilter"))
        .filter(|items| !items.is_empty())
        .or_else(|| fallback.map(|agent| agent.state_filter.clone()))
        .unwrap_or_else(default_agent_state_filter);
    Ok(LocalRegisteredAgentPublic {
        id: required_value_string(registered, "id")?,
        base_url: session.base_url.clone(),
        space_id: required_value_string(registered, "spaceId")
            .or_else(|_| required_value_string(&session.space, "id"))?,
        owner_user_id: optional_value_string(registered, "ownerUserId")
            .or_else(|| fallback.and_then(|agent| agent.owner_user_id.clone()))
            .or_else(|| session_user_id(session)),
        device_id: device.as_ref().map(|device| device.device_id.clone()),
        client_id: optional_value_string(registered, "clientId")
            .or_else(|| fallback.and_then(|agent| agent.client_id.clone())),
        device_name: optional_value_string(registered, "deviceName")
            .or_else(|| device.as_ref().and_then(|item| item.device_name.clone())),
        device,
        is_local: None,
        local_workspace_id: optional_value_string(registered, "localWorkspaceId")
            .or_else(|| fallback.and_then(|agent| agent.local_workspace_id.clone())),
        local_agent_id: optional_value_string(registered, "localAgentId")
            .or_else(|| fallback.and_then(|agent| agent.local_agent_id.clone())),
        workspace_id: optional_value_string(registered, "localWorkspaceId")
            .or_else(|| fallback.and_then(|agent| agent.workspace_id.clone())),
        display_name: required_value_string(registered, "displayName")?,
        instruction: if registered.get("instruction").is_some() {
            optional_value_string(registered, "instruction")
        } else {
            fallback.and_then(|agent| agent.instruction.clone())
        },
        instruction_revision: registered
            .get("instructionRevision")
            .and_then(Value::as_i64)
            .or_else(|| fallback.map(|agent| agent.instruction_revision))
            .unwrap_or(0),
        workspace_path: optional_value_string(registered, "workspacePath")
            .or_else(|| fallback.map(|agent| agent.workspace_path.clone()))
            .unwrap_or_default(),
        workspace_label: registered
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| fallback.and_then(|agent| agent.workspace_label.clone())),
        avatar_url: optional_value_string(registered, "avatarUrl")
            .or_else(|| fallback.and_then(|agent| agent.avatar_url.clone())),
        avatar_source: optional_value_string(registered, "avatarSource")
            .or_else(|| fallback.and_then(|agent| agent.avatar_source.clone())),
        avatar_preset_id: optional_value_string(registered, "avatarPresetId")
            .or_else(|| fallback.and_then(|agent| agent.avatar_preset_id.clone())),
        avatar_urls: registered
            .get("avatarUrls")
            .filter(|value| value.is_object())
            .cloned()
            .or_else(|| fallback.and_then(|agent| agent.avatar_urls.clone())),
        subscriptions: subscription
            .and_then(subscription_summary_from_value)
            .map(|item| vec![item])
            .or_else(|| fallback.map(|agent| agent.subscriptions.clone()))
            .unwrap_or_default(),
        goal_id: subscription
            .and_then(|value| optional_value_string(value, "goalId"))
            .or_else(|| fallback.and_then(|agent| agent.goal_id.clone())),
        goal_path_label: subscription
            .and_then(|value| optional_value_string(value, "goalPathLabel"))
            .or_else(|| fallback.and_then(|agent| agent.goal_path_label.clone())),
        state_filter,
        goal_md: optional_value_string(registered, "goalMd")
            .or_else(|| fallback.and_then(|agent| agent.goal_md.clone())),
        delivery_session_id: fallback.and_then(|agent| agent.delivery_session_id.clone()),
        issue_subscription_run_mode: value_issue_subscription_run_mode(
            registered,
            "issueSubscriptionRunMode",
        )
        .or_else(|| fallback.map(|agent| agent.issue_subscription_run_mode))
        .unwrap_or_default(),
        status: required_value_string(registered, "status")?,
        presence: Some(
            optional_value_string(registered, "presence").unwrap_or_else(|| "offline".to_string()),
        ),
        last_online_at: optional_value_string(registered, "lastOnlineAt"),
        online_until: optional_value_string(registered, "onlineUntil"),
        created_at: required_value_string(registered, "createdAt")
            .or_else(|_| Ok::<String, String>(chrono::Utc::now().to_rfc3339()))?,
        updated_at: required_value_string(registered, "updatedAt")
            .or_else(|_| Ok::<String, String>(chrono::Utc::now().to_rfc3339()))?,
    })
}

fn default_agent_state_filter() -> Vec<String> {
    vec!["todo".to_string()]
}

pub(super) fn normalize_registered_agent_instruction(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("instruction is required".to_string());
    }
    if trimmed.chars().count() > MAX_CLOUD_ISSUE_INSTRUCTION_CHARS {
        return Err(format!(
            "instruction must be at most {} Unicode characters",
            MAX_CLOUD_ISSUE_INSTRUCTION_CHARS
        ));
    }
    Ok(trimmed.to_string())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRegisteredAgentsFile {
    items: Vec<LocalRegisteredAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRegisterAgentInput {
    pub display_name: String,
    pub instruction: String,
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_label: Option<String>,
    pub goal_id: String,
    #[serde(default)]
    pub state_filter: Option<Vec<String>>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub issue_subscription_run_mode: Option<SpaceIssueSubscriptionRunMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateRegisteredAgentInput {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub expected_instruction_revision: Option<i64>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub state_filter: Option<Vec<String>>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub issue_subscription_run_mode: Option<SpaceIssueSubscriptionRunMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateRegisteredAgentAvatarInput {
    pub id: String,
    #[serde(default)]
    pub avatar_file_path: Option<String>,
    #[serde(default)]
    pub avatar_preset_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRegisteredAgentIdInput {
    pub id: String,
}

pub(super) async fn register_agent(
    input: SpaceRegisterAgentInput,
) -> SpaceCommandResult<(LocalRegisteredAgentPublic, bool)> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::register_agent(input)
            .map(|agent| (agent, false))
            .map_err(Into::into);
    }
    ensure_space_available()?;
    let workspace_root = validate_workspace_root(&input.workspace_path)?;
    let workspace_path = workspace_root.to_string_lossy().to_string();
    let session = require_session()?;
    let capability = ensure_space_available()?;
    let identity = current_device_identity()?;
    try_upsert_space_user_device(&session, &identity).await;
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("displayName is required".into());
    }
    let instruction = normalize_registered_agent_instruction(&input.instruction)?;
    let goal_id = input.goal_id.trim();
    if goal_id.is_empty() {
        return Err("goalId is required".into());
    }
    let state_filter = normalize_agent_state_filter(input.state_filter);
    let goal_md = input.goal_md.clone();
    let issue_subscription_run_mode = input.issue_subscription_run_mode.unwrap_or_default();
    let client_id = capability
        .public_client_id
        .clone()
        .unwrap_or_else(|| "myagents-desktop".to_string());
    let local_agent_id = stable_local_agent_id(&input.workspace_id);
    let body = serde_json::json!({
        "clientId": client_id,
        "deviceId": identity.device_id,
        "deviceName": identity.device_name,
        "platform": identity.platform,
        "osVersion": identity.os_version,
        "appVersion": identity.app_version,
        "localWorkspaceId": input.workspace_id,
        "localAgentId": local_agent_id,
        "displayName": display_name,
        "instruction": instruction.clone(),
        "workspacePath": workspace_path,
        "workspaceLabel": input.workspace_label,
        "goalId": goal_id,
        "stateFilter": state_filter,
        "goalMd": goal_md,
        "issueSubscriptionRunMode": issue_subscription_run_mode,
    });
    let path = format!(
        "/api/spaces/{}/registered-agents",
        session_space_segment(&session)
    );
    let data =
        authorized_json_data_request(&session, &path, reqwest::Method::POST, Some(body)).await?;
    let registered = data
        .get("registeredAgent")
        .cloned()
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    let subscription = data.get("subscription").cloned().unwrap_or(Value::Null);
    let device = device_summary_from_cloud(&registered, None, Some(&identity));
    let token = data
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Space API response missing Registered Agent token".to_string())?
        .to_string();
    let agent = LocalRegisteredAgent {
        id: required_value_string(&registered, "id")?,
        base_url: session.base_url.clone(),
        space_id: required_value_string(&registered, "spaceId")?,
        owner_user_id: optional_value_string(&registered, "ownerUserId")
            .or_else(|| session_user_id(&session)),
        device_id: device
            .as_ref()
            .map(|item| item.device_id.clone())
            .or(Some(identity.device_id.clone())),
        client_id: optional_value_string(&registered, "clientId").or(Some(client_id)),
        device_name: device
            .as_ref()
            .and_then(|item| item.device_name.clone())
            .or_else(|| identity.device_name.clone()),
        device_platform: device
            .as_ref()
            .and_then(|item| item.platform.clone())
            .or(Some(identity.platform.clone())),
        device_os_version: device
            .as_ref()
            .and_then(|item| item.os_version.clone())
            .or_else(|| identity.os_version.clone()),
        device_app_version: device
            .as_ref()
            .and_then(|item| item.app_version.clone())
            .or(Some(identity.app_version.clone())),
        device_last_seen_at: device.as_ref().and_then(|item| item.last_seen_at.clone()),
        local_workspace_id: optional_value_string(&registered, "localWorkspaceId")
            .or(Some(input.workspace_id.clone())),
        local_agent_id: optional_value_string(&registered, "localAgentId").or(Some(local_agent_id)),
        workspace_id: Some(input.workspace_id),
        display_name: required_value_string(&registered, "displayName")?,
        instruction: Some(instruction),
        instruction_revision: registered
            .get("instructionRevision")
            .and_then(Value::as_i64)
            .unwrap_or(1),
        workspace_path,
        workspace_label: registered
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        avatar_url: optional_value_string(&registered, "avatarUrl"),
        avatar_source: optional_value_string(&registered, "avatarSource"),
        avatar_preset_id: optional_value_string(&registered, "avatarPresetId"),
        avatar_urls: registered
            .get("avatarUrls")
            .filter(|value| value.is_object())
            .cloned(),
        subscriptions: subscription_summary_from_value(&subscription)
            .into_iter()
            .collect(),
        goal_id: optional_value_string(&subscription, "goalId").or(Some(goal_id.to_string())),
        goal_path_label: optional_value_string(&subscription, "goalPathLabel"),
        state_filter: value_string_array(&subscription, "stateFilter")
            .filter(|items| !items.is_empty())
            .unwrap_or_else(default_agent_state_filter),
        goal_md: input.goal_md,
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        issue_subscription_run_mode,
        issue_session_ids: BTreeMap::new(),
        token,
        status: required_value_string(&registered, "status")?,
        created_at: required_value_string(&registered, "createdAt")?,
        updated_at: required_value_string(&registered, "updatedAt")?,
    };
    upsert_local_agent(agent.clone())?;
    Ok((agent.into(), true))
}

pub(super) async fn update_registered_agent(
    input: SpaceUpdateRegisteredAgentInput,
) -> SpaceCommandResult<(LocalRegisteredAgentPublic, bool)> {
    ensure_space_available()?;
    let session = require_session()?;
    let identity = current_device_identity()?;
    try_upsert_space_user_device(&session, &identity).await;
    // Settings and delivery admission share one per-Agent lifecycle boundary.
    // Once a disable or run-mode mutation completes, no later admission can
    // still act on the pre-mutation local snapshot.
    let _agent_lifecycle = acquire_space_agent_lifecycle(&session.base_url, &input.id).await;
    let mut agent = read_current_local_agents()?
        .into_iter()
        .find(|agent| agent.id == input.id);
    let can_update_local_binding = agent
        .as_ref()
        .map(|agent| local_agent_matches_current_identity(agent, &session, &identity.device_id))
        .unwrap_or(false);
    let mut body = serde_json::Map::new();
    if can_update_local_binding {
        body.insert(
            "deviceId".to_string(),
            Value::String(identity.device_id.clone()),
        );
        if let Some(device_name) = identity.device_name.clone() {
            body.insert("deviceName".to_string(), Value::String(device_name));
        }
        body.insert(
            "platform".to_string(),
            Value::String(identity.platform.clone()),
        );
        if let Some(os_version) = identity.os_version.clone() {
            body.insert("osVersion".to_string(), Value::String(os_version));
        }
        body.insert(
            "appVersion".to_string(),
            Value::String(identity.app_version.clone()),
        );
    }

    if let Some(display_name) = input.display_name {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("displayName is required".into());
        }
        body.insert(
            "displayName".to_string(),
            Value::String(display_name.to_string()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.display_name = display_name.to_string();
        }
    }
    if let Some(instruction) = input.instruction {
        let instruction = normalize_registered_agent_instruction(&instruction)?;
        let expected_revision = input.expected_instruction_revision.ok_or_else(|| {
            "expectedInstructionRevision is required when updating instruction".to_string()
        })?;
        if expected_revision < 0 {
            return Err("expectedInstructionRevision must be non-negative".into());
        }
        body.insert(
            "instruction".to_string(),
            Value::String(instruction.clone()),
        );
        body.insert(
            "expectedInstructionRevision".to_string(),
            Value::Number(expected_revision.into()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.instruction = Some(instruction);
        }
    } else if input.expected_instruction_revision.is_some() {
        return Err("instruction is required when expectedInstructionRevision is provided".into());
    }
    if let Some(workspace_id) = input.workspace_id {
        if !can_update_local_binding {
            return Err("workspace binding can only be changed from the registered device".into());
        }
        let workspace_id = workspace_id.trim();
        if workspace_id.is_empty() {
            return Err("workspaceId is required".into());
        }
        let local_agent_id = stable_local_agent_id(workspace_id);
        body.insert(
            "localWorkspaceId".to_string(),
            Value::String(workspace_id.to_string()),
        );
        body.insert(
            "localAgentId".to_string(),
            Value::String(local_agent_id.clone()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.local_workspace_id = Some(workspace_id.to_string());
            agent.workspace_id = Some(workspace_id.to_string());
            agent.local_agent_id = Some(local_agent_id);
        }
    }
    if let Some(workspace_path) = input.workspace_path {
        if !can_update_local_binding {
            return Err("workspace binding can only be changed from the registered device".into());
        }
        let workspace_root = validate_workspace_root(&workspace_path)?;
        let workspace_path = workspace_root.to_string_lossy().to_string();
        body.insert(
            "workspacePath".to_string(),
            Value::String(workspace_path.clone()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.workspace_path = workspace_path;
        }
    }
    if let Some(workspace_label) = input.workspace_label {
        if !can_update_local_binding {
            return Err("workspace binding can only be changed from the registered device".into());
        }
        let workspace_label = workspace_label.trim();
        if workspace_label.is_empty() {
            body.insert("workspaceLabel".to_string(), Value::Null);
            if let Some(agent) = agent.as_mut() {
                agent.workspace_label = None;
            }
        } else {
            body.insert(
                "workspaceLabel".to_string(),
                Value::String(workspace_label.to_string()),
            );
            if let Some(agent) = agent.as_mut() {
                agent.workspace_label = Some(workspace_label.to_string());
            }
        }
    }
    if let Some(goal_id) = input.goal_id {
        let goal_id = goal_id.trim();
        if goal_id.is_empty() {
            return Err("goalId is required".into());
        }
        if agent.as_ref().and_then(|agent| agent.goal_id.as_deref()) != Some(goal_id) {
            if let Some(agent) = agent.as_mut() {
                agent.goal_path_label = None;
            }
        }
        if let Some(agent) = agent.as_mut() {
            agent.goal_id = Some(goal_id.to_string());
            agent.goal_path_label = None;
        }
        body.insert("goalId".to_string(), Value::String(goal_id.to_string()));
    }
    if let Some(state_filter) = input.state_filter {
        let state_filter = normalize_agent_state_filter(Some(state_filter));
        body.insert(
            "stateFilter".to_string(),
            Value::Array(state_filter.iter().cloned().map(Value::String).collect()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.state_filter = state_filter;
        }
    }
    if let Some(goal_md) = input.goal_md {
        let goal_md = goal_md.trim();
        if goal_md.is_empty() {
            return Err("goalMd is required".into());
        }
        body.insert("goalMd".to_string(), Value::String(goal_md.to_string()));
        if let Some(agent) = agent.as_mut() {
            agent.goal_md = Some(goal_md.to_string());
        }
    }
    if let Some(status) = input.status {
        let status = status.trim();
        if !matches!(status, "active" | "disabled") {
            return Err("Registered Agent status must be active or disabled".into());
        }
        body.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(agent) = agent.as_mut() {
            agent.status = status.to_string();
        }
    }
    if let Some(issue_subscription_run_mode) = input.issue_subscription_run_mode {
        body.insert(
            "issueSubscriptionRunMode".to_string(),
            serde_json::to_value(issue_subscription_run_mode)
                .map_err(|e| format!("Invalid issueSubscriptionRunMode: {}", e))?,
        );
        if let Some(agent) = agent.as_mut() {
            agent.issue_subscription_run_mode = issue_subscription_run_mode;
            agent.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }

    if body.is_empty() {
        let Some(agent) = agent else {
            return Err("No Registered Agent changes provided".into());
        };
        let merged = merge_managed_agent_snapshot_at_path(agent, registered_agents_path()?)?;
        return Ok((merged.into(), true));
    }

    let data = authorized_json_data_request(
        &session,
        &format!("/api/registered-agents/{}", url_component(&input.id)),
        reqwest::Method::PATCH,
        Some(Value::Object(body)),
    )
    .await?;
    if let Some(registered) = data.get("registeredAgent") {
        if let Some(agent) = agent.as_mut() {
            agent.display_name = required_value_string(registered, "displayName")?;
            apply_registered_agent_contract(agent, registered);
            agent.owner_user_id = optional_value_string(registered, "ownerUserId")
                .or_else(|| agent.owner_user_id.clone())
                .or_else(|| session_user_id(&session));
            let local_identity = if can_update_local_binding {
                Some(&identity)
            } else {
                None
            };
            if let Some(device) = device_summary_from_cloud(registered, Some(agent), local_identity)
            {
                agent.device_id = Some(device.device_id);
                agent.device_name = device.device_name;
                agent.device_platform = device.platform;
                agent.device_os_version = device.os_version;
                agent.device_app_version = device.app_version;
                agent.device_last_seen_at = device.last_seen_at;
            }
            agent.workspace_label = registered
                .get("workspaceLabel")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            agent.client_id =
                optional_value_string(registered, "clientId").or_else(|| agent.client_id.clone());
            agent.local_workspace_id = optional_value_string(registered, "localWorkspaceId")
                .or_else(|| agent.local_workspace_id.clone());
            agent.local_agent_id = optional_value_string(registered, "localAgentId")
                .or_else(|| agent.local_agent_id.clone());
            agent.workspace_id = agent
                .local_workspace_id
                .clone()
                .or_else(|| agent.workspace_id.clone());
            if let Some(workspace_path) = optional_value_string(registered, "workspacePath") {
                agent.workspace_path = workspace_path;
            }
            if let Some(issue_subscription_run_mode) =
                value_issue_subscription_run_mode(registered, "issueSubscriptionRunMode")
            {
                agent.issue_subscription_run_mode = issue_subscription_run_mode;
            }
            apply_cloud_avatar_to_local_agent(agent, registered);
            agent.status = required_value_string(registered, "status")?;
            agent.updated_at = required_value_string(registered, "updatedAt")?;
        }
    } else if let Some(agent) = agent.as_mut() {
        agent.updated_at = chrono::Utc::now().to_rfc3339();
    }
    let subscription = first_subscription_from_data(&data);
    if let Some(agent) = agent.as_mut() {
        apply_subscriptions_to_local_agent(agent, &data);
        let merged =
            merge_managed_agent_snapshot_at_path(agent.clone(), registered_agents_path()?)?;
        return Ok((merged.into(), true));
    }
    let registered = data
        .get("registeredAgent")
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    Ok((
        local_registered_agent_public_from_cloud(&session, registered, subscription, None)?,
        false,
    ))
}

pub(super) async fn update_registered_agent_avatar(
    input: SpaceUpdateRegisteredAgentAvatarInput,
) -> SpaceCommandResult<(LocalRegisteredAgentPublic, bool)> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::update_registered_agent_avatar(input)
            .map(|agent| (agent, false))
            .map_err(Into::into);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let _agent_lifecycle = acquire_space_agent_lifecycle(&session.base_url, &input.id).await;
    let mut agent = read_current_local_agents()?
        .into_iter()
        .find(|agent| agent.id == input.id);
    let form = registered_agent_avatar_form(&input)?;
    let data = authorized_multipart_data_request(
        &session,
        &format!("/api/registered-agents/{}/avatar", url_component(&input.id)),
        form,
    )
    .await?;
    let registered = data
        .get("registeredAgent")
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    if let Some(agent) = agent.as_mut() {
        apply_cloud_avatar_to_local_agent(agent, registered);
        agent.updated_at = required_value_string(registered, "updatedAt")
            .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
        let merged =
            merge_managed_agent_snapshot_at_path(agent.clone(), registered_agents_path()?)?;
        return Ok((merged.into(), true));
    }
    Ok((
        local_registered_agent_public_from_cloud(
            &session,
            registered,
            first_subscription_from_data(&data),
            None,
        )?,
        false,
    ))
}

#[tauri::command]
pub async fn cmd_space_revoke_registered_agent(
    input: SpaceRegisteredAgentIdInput,
) -> SpaceCommandResult<LocalRegisteredAgentPublic> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::revoke_agent(&input.id).map_err(Into::into);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let _agent_lifecycle = acquire_space_agent_lifecycle(&session.base_url, &input.id).await;
    let mut agent = read_current_local_agents()?
        .into_iter()
        .find(|agent| agent.id == input.id);
    let data = authorized_json_data_request(
        &session,
        &format!("/api/registered-agents/{}/revoke", url_component(&input.id)),
        reqwest::Method::POST,
        None,
    )
    .await?;
    if let Some(agent) = agent.as_mut() {
        if let Some(registered) = data.get("registeredAgent") {
            agent.status = required_value_string(registered, "status")?;
            agent.updated_at = required_value_string(registered, "updatedAt")?;
        } else {
            agent.status = "revoked".to_string();
            agent.updated_at = chrono::Utc::now().to_rfc3339();
        }
        let merged =
            merge_managed_agent_snapshot_at_path(agent.clone(), registered_agents_path()?)?;
        return Ok(merged.into());
    }
    let registered = data
        .get("registeredAgent")
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    Ok(local_registered_agent_public_from_cloud(
        &session,
        registered,
        first_subscription_from_data(&data),
        None,
    )?)
}

#[tauri::command]
pub async fn cmd_space_list_local_agents() -> Result<Vec<LocalRegisteredAgentPublic>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::list_local_agents());
    }
    ensure_space_available()?;
    Ok(read_current_local_agents()?
        .into_iter()
        .map(Into::into)
        .collect())
}

pub(super) fn registered_agents_path_in_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCAL_AGENTS_FILE)
}

pub fn registered_agents_path() -> Result<PathBuf, String> {
    Ok(registered_agents_path_in_dir(&space_data_dir()?))
}

fn read_local_agents_from_path(path: &Path) -> Result<LocalRegisteredAgentsFile, String> {
    read_local_agents_unlocked(path)
}

pub(super) fn read_current_local_agents() -> Result<Vec<LocalRegisteredAgent>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::list_local_agents()
            .into_iter()
            .map(|agent| LocalRegisteredAgent {
                id: agent.id.clone(),
                base_url: agent.base_url.clone(),
                space_id: agent.space_id.clone(),
                owner_user_id: agent.owner_user_id.clone(),
                device_id: agent.device_id.clone(),
                client_id: agent.client_id.clone(),
                device_name: agent.device_name.clone(),
                device_platform: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.platform.clone()),
                device_os_version: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.os_version.clone()),
                device_app_version: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.app_version.clone()),
                device_last_seen_at: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.last_seen_at.clone()),
                local_workspace_id: agent.local_workspace_id.clone(),
                local_agent_id: agent.local_agent_id.clone(),
                workspace_id: agent.workspace_id.clone(),
                display_name: agent.display_name.clone(),
                instruction: agent.instruction.clone(),
                instruction_revision: agent.instruction_revision,
                workspace_path: agent.workspace_path.clone(),
                workspace_label: agent.workspace_label.clone(),
                avatar_url: agent.avatar_url.clone(),
                avatar_source: agent.avatar_source.clone(),
                avatar_preset_id: agent.avatar_preset_id.clone(),
                avatar_urls: agent.avatar_urls.clone(),
                subscriptions: agent.subscriptions.clone(),
                goal_id: agent.goal_id.clone(),
                goal_path_label: agent.goal_path_label.clone(),
                state_filter: agent.state_filter.clone(),
                goal_md: agent.goal_md.clone(),
                delivery_session_id: agent.delivery_session_id.clone(),
                issue_subscription_run_mode: agent.issue_subscription_run_mode.clone(),
                issue_session_ids: BTreeMap::new(),
                token: format!("mock-token-{}", agent.id),
                status: agent.status.clone(),
                created_at: agent.created_at.clone(),
                updated_at: agent.updated_at.clone(),
            })
            .collect());
    }
    let configured_base_url = space_base_url()?;
    read_current_local_agents_for_base_url(&configured_base_url, &space_data_dir()?)
}

fn read_current_local_agents_for_base_url(
    base_url: &str,
    data_dir: &Path,
) -> Result<Vec<LocalRegisteredAgent>, String> {
    let agents_path = registered_agents_path_in_dir(data_dir);
    let mut agents = read_local_agents_from_path(&agents_path)?
        .items
        .into_iter()
        .filter(|agent| space_base_urls_equal(&agent.base_url, base_url))
        .collect::<Vec<_>>();

    if let Some(session) = read_current_session_for_base_url(base_url, data_dir)? {
        let identity = current_device_identity()?;
        for agent in agents.iter_mut() {
            if normalize_legacy_local_agent_identity(agent, &session, &identity) {
                upsert_local_agent_at_path(agent.clone(), agents_path.clone())?;
            }
        }
    }

    Ok(agents)
}

fn upsert_local_agent(agent: LocalRegisteredAgent) -> Result<(), String> {
    upsert_local_agent_at_path(agent, registered_agents_path()?)
}

fn upsert_local_agent_at_path(agent: LocalRegisteredAgent, path: PathBuf) -> Result<(), String> {
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&path)?;
        file.items.retain(|existing| {
            existing.id != agent.id || !space_base_urls_equal(&existing.base_url, &agent.base_url)
        });
        file.items.push(agent);
        write_private_json_unlocked(&path, &file)
    })
}

fn merge_managed_agent_snapshot_at_path(
    mut managed: LocalRegisteredAgent,
    path: PathBuf,
) -> Result<LocalRegisteredAgent, String> {
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&path)?;
        if let Some(latest) = file.items.iter().find(|candidate| {
            candidate.id == managed.id
                && space_base_urls_equal(&candidate.base_url, &managed.base_url)
        }) {
            // Session allocation is connector-owned and may finish while a
            // Cloud settings request is in flight. A management response must
            // not erase those runtime identities. Likewise, retain a newer
            // instruction snapshot observed by the poller.
            managed.delivery_session_id = latest.delivery_session_id.clone();
            managed.issue_session_ids = latest.issue_session_ids.clone();
            if latest.instruction_revision > managed.instruction_revision {
                managed.instruction = latest.instruction.clone();
                managed.instruction_revision = latest.instruction_revision;
            }
        }
        file.items.retain(|existing| {
            existing.id != managed.id
                || !space_base_urls_equal(&existing.base_url, &managed.base_url)
        });
        file.items.push(managed.clone());
        write_private_json_unlocked(&path, &file)?;
        Ok(managed)
    })
}

pub(super) fn merge_polled_agent_contract_at_path(
    polled_agent: &LocalRegisteredAgent,
    instruction: Option<String>,
    instruction_revision: i64,
    path: PathBuf,
) -> Result<Option<LocalRegisteredAgent>, String> {
    let agent_id = polled_agent.id.clone();
    let base_url = polled_agent.base_url.clone();
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&path)?;
        let Some(latest) = file.items.iter_mut().find(|candidate| {
            candidate.id == agent_id && space_base_urls_equal(&candidate.base_url, &base_url)
        }) else {
            return Ok(None);
        };

        // Poll context may have been read before a concurrent instruction
        // CAS completed. Only advance this Cloud-owned snapshot; all local
        // settings remain owned by the disk-latest record.
        if instruction_revision >= latest.instruction_revision {
            latest.instruction = instruction;
            latest.instruction_revision = instruction_revision;
        }
        let merged = latest.clone();
        write_private_json_unlocked(&path, &file)?;
        Ok(Some(merged))
    })
}

pub(super) fn require_local_agent(id: &str) -> Result<LocalRegisteredAgent, String> {
    ensure_space_available()?;
    read_current_runnable_local_agents()?
        .into_iter()
        .find(|agent| agent.id == id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", id))
}

fn read_current_runnable_local_agents() -> Result<Vec<LocalRegisteredAgent>, String> {
    let Some(session) = read_current_session()? else {
        return Ok(Vec::new());
    };
    let local_device_id = crate::device_identity::get_or_create_device_id()?;
    Ok(read_current_local_agents()?
        .into_iter()
        .filter(|agent| agent.status == "active")
        .filter(|agent| local_agent_matches_connector_identity(agent, &session, &local_device_id))
        .collect())
}

pub(super) fn read_current_runnable_local_agents_for_scope(
    scope: &SpaceRuntimeScope,
) -> Result<Vec<LocalRegisteredAgent>, String> {
    let Some(session) = read_current_session_for_base_url(&scope.base_url, &scope.data_dir)? else {
        return Ok(Vec::new());
    };
    let local_device_id = crate::device_identity::get_or_create_device_id()?;
    Ok(
        read_current_local_agents_for_base_url(&scope.base_url, &scope.data_dir)?
            .into_iter()
            .filter(|agent| agent.status == "active")
            .filter(|agent| {
                local_agent_matches_connector_identity(agent, &session, &local_device_id)
            })
            .collect(),
    )
}

fn local_agent_matches_connector_identity(
    agent: &LocalRegisteredAgent,
    session: &SpaceSession,
    local_device_id: &str,
) -> bool {
    let Some(current_user_id) = session_user_id(session) else {
        return false;
    };
    agent
        .owner_user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        == Some(current_user_id.as_str())
        && agent
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            == Some(local_device_id)
}

fn local_agent_matches_current_identity(
    agent: &LocalRegisteredAgent,
    session: &SpaceSession,
    local_device_id: &str,
) -> bool {
    let Some(current_user_id) = session_user_id(session) else {
        return false;
    };
    let Some(current_space_id) = session_space_id(session) else {
        return false;
    };
    agent.space_id.trim() == current_space_id
        && agent
            .owner_user_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            == Some(current_user_id.as_str())
        && agent
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            == Some(local_device_id)
}

fn normalize_legacy_local_agent_identity(
    agent: &mut LocalRegisteredAgent,
    session: &SpaceSession,
    identity: &DeviceIdentity,
) -> bool {
    let Some(current_user_id) = session_user_id(session) else {
        return false;
    };
    let owner_user_id = agent
        .owner_user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if owner_user_id != Some(current_user_id.as_str()) {
        return false;
    }

    let mut changed = false;
    let device_id_missing = agent
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none();
    if device_id_missing {
        agent.device_id = Some(identity.device_id.clone());
        changed = true;
    }

    if agent.device_id.as_deref() == Some(identity.device_id.as_str()) {
        if agent
            .device_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
        {
            if let Some(device_name) = identity.device_name.clone() {
                agent.device_name = Some(device_name);
                changed = true;
            }
        }
        if agent
            .device_platform
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
        {
            agent.device_platform = Some(identity.platform.clone());
            changed = true;
        }
        if agent
            .device_os_version
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
        {
            if let Some(os_version) = identity.os_version.clone() {
                agent.device_os_version = Some(os_version);
                changed = true;
            }
        }
        if agent
            .device_app_version
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
        {
            agent.device_app_version = Some(identity.app_version.clone());
            changed = true;
        }
    }

    changed
}

fn read_local_agents_unlocked(path: &Path) -> Result<LocalRegisteredAgentsFile, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Invalid local Space agents file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(LocalRegisteredAgentsFile::default())
        }
        Err(e) => Err(format!("Failed to read local Space agents file: {}", e)),
    }
}

fn normalize_agent_state_filter(input: Option<Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    for state in input.unwrap_or_else(default_agent_state_filter) {
        let state = state.trim();
        if state.is_empty() || out.iter().any(|existing| existing == state) {
            continue;
        }
        out.push(state.to_string());
    }
    if out.is_empty() {
        default_agent_state_filter()
    } else {
        out
    }
}

fn stable_local_agent_id(workspace_id: &str) -> String {
    format!("local-agent-{}", safe_local_name(workspace_id))
}

pub(super) fn read_local_agent_at_path(
    agents_path: &Path,
    base_url: &str,
    registered_agent_id: &str,
) -> Result<Option<LocalRegisteredAgent>, String> {
    Ok(read_local_agents_from_path(agents_path)?
        .items
        .into_iter()
        .find(|candidate| {
            candidate.id == registered_agent_id
                && space_base_urls_equal(&candidate.base_url, base_url)
        }))
}

pub(super) fn ensure_agent_delivery_session_at_path(
    agent: LocalRegisteredAgent,
    agents_path: PathBuf,
) -> Result<LocalRegisteredAgent, String> {
    if agent
        .delivery_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return Ok(agent);
    }
    let agent_id = agent.id.clone();
    let base_url = agent.base_url.clone();
    let lock_path = agents_path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&agents_path)?;
        let latest = file.items.iter_mut().find(|candidate| {
            candidate.id == agent_id && space_base_urls_equal(&candidate.base_url, &base_url)
        });
        let Some(latest) = latest else {
            return Err(format!(
                "Registered Agent disappeared before Session allocation: {agent_id}"
            ));
        };
        if latest
            .delivery_session_id
            .as_deref()
            .is_none_or(str::is_empty)
        {
            latest.delivery_session_id = Some(uuid::Uuid::new_v4().to_string());
            latest.updated_at = chrono::Utc::now().to_rfc3339();
            let updated = latest.clone();
            write_private_json_unlocked(&agents_path, &file)?;
            return Ok(updated);
        }
        Ok(latest.clone())
    })
}

pub(super) fn ensure_agent_issue_session_at_path(
    agent: &mut LocalRegisteredAgent,
    issue_id: &str,
    agents_path: &Path,
) -> Result<String, String> {
    let agent_id = agent.id.clone();
    let base_url = agent.base_url.clone();
    let issue_id = issue_id.to_string();
    let path = agents_path.to_path_buf();
    let lock_path = path.clone();
    let (latest, session_id) = with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&path)?;
        let latest = file.items.iter_mut().find(|candidate| {
            candidate.id == agent_id && space_base_urls_equal(&candidate.base_url, &base_url)
        });
        let Some(latest) = latest else {
            return Err(format!(
                "Registered Agent disappeared before Issue Session allocation: {agent_id}"
            ));
        };
        if latest.status != "active" {
            return Err(format!("Registered Agent is no longer active: {agent_id}"));
        }
        if let Some(session_id) = latest
            .issue_session_ids
            .get(&issue_id)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
        {
            return Ok((latest.clone(), session_id));
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        latest
            .issue_session_ids
            .insert(issue_id, session_id.clone());
        latest.updated_at = chrono::Utc::now().to_rfc3339();
        let updated = latest.clone();
        write_private_json_unlocked(&path, &file)?;
        Ok((updated, session_id))
    })?;
    *agent = latest;
    Ok(session_id)
}

pub(super) fn effective_space_workspace_id(agent: &LocalRegisteredAgent) -> Option<&str> {
    agent
        .local_workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            agent
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
}

fn registered_agent_avatar_form(
    input: &SpaceUpdateRegisteredAgentAvatarInput,
) -> Result<reqwest::multipart::Form, String> {
    let avatar_preset_id = input
        .avatar_preset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let avatar_file_path = input
        .avatar_file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if avatar_preset_id.is_some() && avatar_file_path.is_some() {
        return Err("Choose either an avatar file or an avatar preset".to_string());
    }
    let mut form = reqwest::multipart::Form::new();
    if let Some(preset_id) = avatar_preset_id {
        return Ok(form.text("avatarPresetId", preset_id.to_string()));
    }
    let Some(path) = avatar_file_path else {
        return Err("Avatar file or preset is required".to_string());
    };
    let file_path = PathBuf::from(path);
    form = form.part(
        "avatar",
        normalized_avatar_upload_part(&file_path, MAX_AGENT_AVATAR_BYTES)?,
    );
    Ok(form)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::space_cloud::tests::{test_registered_agent, test_space_session};
    use crate::space_cloud::SpaceUserCredential;

    fn test_device_identity() -> DeviceIdentity {
        DeviceIdentity {
            device_id: "device_current".to_string(),
            device_name: Some("Current Mac".to_string()),
            platform: "darwin-aarch64".to_string(),
            os_version: Some("macOS Test".to_string()),
            app_version: "0.2.46-test".to_string(),
        }
    }

    #[test]
    fn local_agent_store_keeps_independent_instances_for_the_same_workspace() {
        let dir = tempfile::tempdir().expect("agent store tempdir");
        let path = dir.path().join("registered_agents.json");
        let first = test_registered_agent(Some("usr_current"), Some("device_current"));
        let mut second = first.clone();
        second.id = "rag_second".to_string();
        second.display_name = "Second instance".to_string();
        second.instruction = Some("Implement eligible fixes.".to_string());
        second.delivery_session_id = Some("session_second".to_string());
        second.token = "token-second".to_string();

        upsert_local_agent_at_path(first.clone(), path.clone())
            .expect("first Agent should persist");
        upsert_local_agent_at_path(second.clone(), path.clone())
            .expect("second Agent sharing the workspace should persist independently");

        let stored = read_local_agents_from_path(&path)
            .expect("agent store should read")
            .items;
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().any(|agent| {
            agent.id == first.id
                && agent.workspace_id == first.workspace_id
                && agent.delivery_session_id == first.delivery_session_id
                && agent.token == first.token
        }));
        assert!(stored.iter().any(|agent| {
            agent.id == second.id
                && agent.workspace_id == first.workspace_id
                && agent.delivery_session_id == second.delivery_session_id
                && agent.token == second.token
        }));
    }

    #[test]
    fn poll_contract_merge_preserves_newer_local_agent_authority() {
        let dir = tempfile::tempdir().expect("agent store tempdir");
        let path = dir.path().join("registered_agents.json");
        let mut stale = test_registered_agent(Some("usr_current"), Some("device_current"));
        stale.instruction = Some("old instruction".to_string());
        stale.instruction_revision = 1;

        let mut latest = stale.clone();
        latest.status = "disabled".to_string();
        latest.workspace_path = "/tmp/new-workspace".to_string();
        latest.issue_subscription_run_mode = SpaceIssueSubscriptionRunMode::NewSession;
        latest.instruction = Some("newer instruction".to_string());
        latest.instruction_revision = 3;
        upsert_local_agent_at_path(latest.clone(), path.clone()).unwrap();

        let merged = merge_polled_agent_contract_at_path(
            &stale,
            Some("stale instruction".to_string()),
            2,
            path.clone(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(merged.status, "disabled");
        assert_eq!(merged.workspace_path, "/tmp/new-workspace");
        assert_eq!(
            merged.issue_subscription_run_mode,
            SpaceIssueSubscriptionRunMode::NewSession
        );
        assert_eq!(merged.instruction.as_deref(), Some("newer instruction"));
        assert_eq!(merged.instruction_revision, 3);

        let merged = merge_polled_agent_contract_at_path(
            &stale,
            Some("fresh instruction".to_string()),
            4,
            path,
        )
        .unwrap()
        .unwrap();
        assert_eq!(merged.status, "disabled");
        assert_eq!(merged.instruction.as_deref(), Some("fresh instruction"));
        assert_eq!(merged.instruction_revision, 4);
    }

    #[test]
    fn managed_agent_merge_preserves_connector_owned_runtime_state() {
        let dir = tempfile::tempdir().expect("agent store tempdir");
        let path = dir.path().join("registered_agents.json");
        let mut managed = test_registered_agent(Some("usr_current"), Some("device_current"));
        managed.delivery_session_id = Some("stale-shared-session".to_string());
        managed.instruction = Some("stale instruction".to_string());
        managed.instruction_revision = 1;

        let mut latest = managed.clone();
        latest.delivery_session_id = Some("current-shared-session".to_string());
        latest
            .issue_session_ids
            .insert("issue-1".to_string(), "issue-session-1".to_string());
        latest.instruction = Some("current instruction".to_string());
        latest.instruction_revision = 3;
        upsert_local_agent_at_path(latest, path.clone()).unwrap();

        managed.status = "disabled".to_string();
        let merged = merge_managed_agent_snapshot_at_path(managed, path.clone()).unwrap();
        assert_eq!(merged.status, "disabled");
        assert_eq!(
            merged.delivery_session_id.as_deref(),
            Some("current-shared-session")
        );
        assert_eq!(
            merged.issue_session_ids.get("issue-1").map(String::as_str),
            Some("issue-session-1")
        );
        assert_eq!(merged.instruction.as_deref(), Some("current instruction"));
        assert_eq!(merged.instruction_revision, 3);
    }

    #[tokio::test]
    async fn delivery_admission_reloads_state_after_settings_lifecycle_commit() {
        let dir = tempfile::tempdir().expect("agent store tempdir");
        let path = dir.path().join("registered_agents.json");
        let mut agent = test_registered_agent(Some("usr_current"), Some("device_current"));
        agent.id = format!("rag_{}", uuid::Uuid::new_v4());
        agent.base_url = "https://space.lifecycle.test/".to_string();
        upsert_local_agent_at_path(agent.clone(), path.clone()).unwrap();

        let settings_guard = acquire_space_agent_lifecycle(&agent.base_url, &agent.id).await;
        let admission_path = path.clone();
        let admission_id = agent.id.clone();
        let admission_acquired = std::sync::Arc::new(AtomicBool::new(false));
        let admission_acquired_in_task = admission_acquired.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let admission = tauri::async_runtime::spawn(async move {
            let _ = started_tx.send(());
            let _admission_guard =
                acquire_space_agent_lifecycle("https://space.lifecycle.test", &admission_id).await;
            admission_acquired_in_task.store(true, Ordering::SeqCst);
            read_local_agent_at_path(
                &admission_path,
                "https://space.lifecycle.test",
                &admission_id,
            )
            .unwrap()
            .unwrap()
        });
        started_rx.await.expect("admission task should start");
        tokio::task::yield_now().await;
        assert!(
            !admission_acquired.load(Ordering::SeqCst),
            "delivery admission must wait for the settings lifecycle commit"
        );

        agent.status = "disabled".to_string();
        agent.issue_subscription_run_mode = SpaceIssueSubscriptionRunMode::NewSession;
        upsert_local_agent_at_path(agent, path).unwrap();
        drop(settings_guard);

        let observed = admission.await.expect("admission task should complete");
        assert_eq!(observed.status, "disabled");
        assert_eq!(
            observed.issue_subscription_run_mode,
            SpaceIssueSubscriptionRunMode::NewSession
        );
    }

    #[test]
    fn issue_session_allocation_merges_into_disk_latest_agent() {
        let dir = tempfile::tempdir().expect("agent store tempdir");
        let path = dir.path().join("registered_agents.json");
        let mut stale = test_registered_agent(Some("usr_current"), Some("device_current"));
        let mut latest = stale.clone();
        latest.workspace_path = "/tmp/new-workspace".to_string();
        latest.issue_subscription_run_mode = SpaceIssueSubscriptionRunMode::NewSession;
        upsert_local_agent_at_path(latest, path.clone()).unwrap();

        let session_id = ensure_agent_issue_session_at_path(&mut stale, "issue-1", &path)
            .expect("Issue Session should be allocated");
        assert_eq!(stale.workspace_path, "/tmp/new-workspace");
        assert_eq!(
            stale.issue_subscription_run_mode,
            SpaceIssueSubscriptionRunMode::NewSession
        );
        assert_eq!(
            stale.issue_session_ids.get("issue-1").map(String::as_str),
            Some(session_id.as_str())
        );

        let stored = read_local_agents_from_path(&path).unwrap();
        let stored = stored
            .items
            .into_iter()
            .find(|agent| agent.id == stale.id)
            .unwrap();
        assert_eq!(stored.workspace_path, "/tmp/new-workspace");
        assert_eq!(
            stored.issue_session_ids.get("issue-1").map(String::as_str),
            Some(session_id.as_str())
        );
    }

    #[test]
    fn normalize_legacy_local_agent_identity_fills_missing_device_for_current_user() {
        let mut session = test_space_session("usr_current");
        let invalidated_binding = session.session_binding_id();
        session.user_credential = SpaceUserCredential::ReauthRequired {
            invalidated_session_binding_id: invalidated_binding,
        };
        let identity = test_device_identity();
        let mut agent = test_registered_agent(Some("usr_current"), None);

        assert!(normalize_legacy_local_agent_identity(
            &mut agent, &session, &identity
        ));
        assert_eq!(agent.device_id.as_deref(), Some("device_current"));
        assert_eq!(agent.device_name.as_deref(), Some("Current Mac"));
        assert_eq!(agent.device_platform.as_deref(), Some("darwin-aarch64"));
        assert_eq!(agent.device_os_version.as_deref(), Some("macOS Test"));
        assert_eq!(agent.device_app_version.as_deref(), Some("0.2.46-test"));
        assert!(local_agent_matches_current_identity(
            &agent,
            &session,
            "device_current"
        ));
    }

    #[test]
    fn local_agent_identity_requires_current_space() {
        let session = test_space_session("usr_current");
        let mut agent = test_registered_agent(Some("usr_current"), Some("device_current"));

        assert!(local_agent_matches_current_identity(
            &agent,
            &session,
            "device_current"
        ));

        agent.space_id = "space_other".to_string();
        assert!(!local_agent_matches_current_identity(
            &agent,
            &session,
            "device_current"
        ));
    }

    #[test]
    fn connector_identity_keeps_current_device_agents_across_spaces() {
        let mut session = test_space_session("usr_current");
        let invalidated_binding = session.session_binding_id();
        session.user_credential = SpaceUserCredential::ReauthRequired {
            invalidated_session_binding_id: invalidated_binding,
        };
        let mut current_space_agent =
            test_registered_agent(Some("usr_current"), Some("device_current"));
        let mut other_space_agent = current_space_agent.clone();
        other_space_agent.space_id = "space_other".to_string();

        assert!(local_agent_matches_connector_identity(
            &current_space_agent,
            &session,
            "device_current"
        ));
        assert!(local_agent_matches_connector_identity(
            &other_space_agent,
            &session,
            "device_current"
        ));
        assert!(session.authenticated_token().is_none());

        current_space_agent.owner_user_id = Some("usr_other".to_string());
        assert!(!local_agent_matches_connector_identity(
            &current_space_agent,
            &session,
            "device_current"
        ));
    }

    #[test]
    fn normalize_legacy_local_agent_identity_does_not_claim_unknown_owner() {
        let session = test_space_session("usr_current");
        let identity = test_device_identity();
        let mut agent = test_registered_agent(None, None);

        assert!(!normalize_legacy_local_agent_identity(
            &mut agent, &session, &identity
        ));
        assert_eq!(agent.device_id, None);
        assert!(!local_agent_matches_current_identity(
            &agent,
            &session,
            "device_current"
        ));
    }

    #[test]
    fn normalize_legacy_local_agent_identity_does_not_claim_other_user() {
        let session = test_space_session("usr_current");
        let identity = test_device_identity();
        let mut agent = test_registered_agent(Some("usr_other"), None);

        assert!(!normalize_legacy_local_agent_identity(
            &mut agent, &session, &identity
        ));
        assert_eq!(agent.device_id, None);
        assert!(!local_agent_matches_current_identity(
            &agent,
            &session,
            "device_current"
        ));
    }

    #[test]
    fn device_summary_from_cloud_does_not_invent_device_without_explicit_local_identity() {
        let registered = serde_json::json!({
            "id": "rag_legacy",
            "spaceId": "space_test",
            "displayName": "Legacy",
            "status": "active",
            "createdAt": "2026-07-03T00:00:00.000Z",
            "updatedAt": "2026-07-03T00:00:00.000Z"
        });
        let fallback = test_registered_agent(Some("usr_current"), None);

        assert!(device_summary_from_cloud(&registered, Some(&fallback), None).is_none());

        let identity = test_device_identity();
        let device = device_summary_from_cloud(&registered, Some(&fallback), Some(&identity))
            .expect("current local identity should be an explicit fallback only");
        assert_eq!(device.device_id, "device_current");
    }
}
