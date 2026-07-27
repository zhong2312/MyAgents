use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::space_cloud::{
    LocalRegisteredAgent, LocalRegisteredAgentPublic, SpaceApiRequestInput,
    SpaceDownloadAttachmentResult, SpaceGoalSubscriptionSummary, SpaceIssueSubscriptionRunMode,
    SpaceProcessDeliveryResult, SpaceRegisterAgentInput, SpaceSession, SpaceSessionPublic,
    SpaceSkillSourceMetaInput, SpaceUpdateProfileInput, SpaceUpdateRegisteredAgentAvatarInput,
    SpaceUpdateSpaceInput, SpaceUploadIssueAttachmentsInput, SpaceUploadSkillInput,
    MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT, MAX_SKILL_ZIP_BYTES,
};
use crate::workspace_files::path_safety::{
    atomic_write_file, resolve_inside_workspace, validate_workspace_root,
};

pub const MOCK_BASE_URL: &str = "https://space.mock.myagents.local";
const MOCK_SPACE_ID: &str = "space_mock_official";
const MOCK_ROOT_GOAL_ID: &str = "goal_mock_root";
const MOCK_OWNER_USER_ID: &str = "usr_mock_owner";
const MOCK_REMOTE_DEVICE_ID: &str = "mock-remote-device-windows";

fn mock_avatar_preset_url(kind: &str, preset_id: &str, size: u16) -> String {
    format!(
        "{}/mock-avatar/presets/{}/v1/{}/{}.webp",
        MOCK_BASE_URL, kind, preset_id, size
    )
}

fn mock_avatar_preset(kind: &str, preset_id: &str) -> Value {
    json!({
        "id": preset_id,
        "kind": kind,
        "version": "v1",
        "url": mock_avatar_preset_url(kind, preset_id, 128),
        "urls": {
            "64": mock_avatar_preset_url(kind, preset_id, 64),
            "128": mock_avatar_preset_url(kind, preset_id, 128),
            "256": mock_avatar_preset_url(kind, preset_id, 256)
        }
    })
}

fn mock_avatar_urls(kind: &str, preset_id: &str) -> Value {
    json!({
        "64": mock_avatar_preset_url(kind, preset_id, 64),
        "128": mock_avatar_preset_url(kind, preset_id, 128),
        "256": mock_avatar_preset_url(kind, preset_id, 256)
    })
}

pub fn avatar_presets() -> Result<Value, String> {
    Ok(json!({
        "people": (1..=16)
            .map(|index| mock_avatar_preset("people", &format!("person-{index:02}")))
            .collect::<Vec<_>>(),
        "agents": (1..=16)
            .map(|index| mock_avatar_preset("agents", &format!("agent-{index:02}")))
            .collect::<Vec<_>>()
    }))
}

#[derive(Clone)]
struct MockSkillRecord {
    skill: Value,
    revisions: Vec<Value>,
    current_revision: u64,
    files: Vec<Value>,
    file_content: HashMap<String, Value>,
}

#[derive(Clone)]
struct MockDevicePresence {
    last_online_at: String,
    online_until: String,
}

#[derive(Clone)]
struct MockState {
    user: Value,
    tags: Vec<Value>,
    goals: Vec<Value>,
    issues: Vec<Value>,
    comments: HashMap<String, Vec<Value>>,
    attachments: HashMap<String, Vec<Value>>,
    claims: HashMap<String, Value>,
    complete_operations: HashMap<String, Value>,
    skills: Vec<MockSkillRecord>,
    agents: Vec<LocalRegisteredAgent>,
    device_presence: HashMap<String, MockDevicePresence>,
    dispatches: Vec<Value>,
    deliveries: Vec<Value>,
    events: Vec<Value>,
    seq: u64,
}

#[derive(Clone)]
struct MockActor {
    actor_type: String,
    actor_id: String,
    actor_name: String,
    authenticated: bool,
}

static MOCK_STATE: OnceLock<Mutex<MockState>> = OnceLock::new();
#[cfg(test)]
static MOCK_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) struct MockSpaceTestGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for MockSpaceTestGuard {
    fn drop(&mut self) {
        std::env::remove_var("MYAGENTS_SPACE_MOCK_DATA");
    }
}

#[cfg(test)]
pub(crate) fn enable_for_test() -> MockSpaceTestGuard {
    let guard = MOCK_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("mock test lock poisoned");
    std::env::set_var("MYAGENTS_SPACE_MOCK_DATA", "true");
    reset();
    MockSpaceTestGuard { _guard: guard }
}

pub fn is_enabled() -> bool {
    if !cfg!(any(debug_assertions, test)) {
        return false;
    }
    std::env::var("MYAGENTS_SPACE_MOCK_DATA")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub fn session() -> SpaceSession {
    let user = state().lock().expect("mock state poisoned").user.clone();
    SpaceSession {
        base_url: MOCK_BASE_URL.to_string(),
        session_token: "mock-session-token".to_string(),
        expires_at: None,
        user,
        account_plan: mock_account_plan(),
        space: mock_space(),
        membership: mock_membership(),
        spaces: vec![mock_space_list_item()],
        last_active_space_id: Some(MOCK_SPACE_ID.to_string()),
        updated_at: "2026-06-24T09:00:00.000Z".to_string(),
    }
}

pub fn reset() {
    let mut state = state().lock().expect("mock state poisoned");
    *state = initial_state();
}

pub fn api_request(input: SpaceApiRequestInput) -> Result<Value, String> {
    let method = input.method.trim().to_ascii_uppercase();
    let url = parse_mock_url(&input.path)?;
    let data = handle_api_data_request(
        &method,
        url.path(),
        url.query_pairs().into_owned().collect(),
        input.body,
        None,
    )?;
    Ok(ok_envelope(data))
}

#[cfg(test)]
pub fn api_data_request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    api_data_request_with_token(method, path, None, body)
}

pub fn api_data_request_with_token(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = parse_mock_url(path)?;
    handle_api_data_request(
        &method.to_ascii_uppercase(),
        url.path(),
        url.query_pairs().into_owned().collect(),
        body,
        token,
    )
}

pub fn api_data_request_scoped_with_token(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    space_id: Option<&str>,
) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    let url = parse_mock_url(path)?;
    let segments = url.path().trim_matches('/').split('/').collect::<Vec<_>>();
    let requires_space_context = matches!(
        (method.as_str(), segments.as_slice()),
        ("GET", ["api", "spaces", "official", "goals"]) | ("PATCH", ["api", "issues", _])
    );
    if requires_space_context && space_id != Some(MOCK_SPACE_ID) {
        return Err(
            "SPACE_CONTEXT_MISMATCH: Mock scoped request is missing the selected Space context"
                .to_string(),
        );
    }
    handle_api_data_request(
        &method,
        url.path(),
        url.query_pairs().into_owned().collect(),
        body,
        token,
    )
}

pub fn list_local_agents() -> Vec<LocalRegisteredAgentPublic> {
    state()
        .lock()
        .expect("mock state poisoned")
        .agents
        .clone()
        .into_iter()
        .map(Into::into)
        .collect()
}

pub fn register_agent(
    input: SpaceRegisterAgentInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    let workspace_root = validate_workspace_root(&input.workspace_path)?;
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("displayName is required".to_string());
    }
    let instruction = input.instruction.trim();
    if instruction.is_empty() {
        return Err("instruction is required".to_string());
    }
    let goal_id = input.goal_id.trim();
    if goal_id.is_empty() {
        return Err("goalId is required".to_string());
    }
    let mut state = state().lock().expect("mock state poisoned");
    let goal_path_label = goal_label(&state, goal_id);
    let id = state.next_id("rag");
    let avatar_preset_id = format!("agent-{:02}", (state.seq % 16) + 1);
    let local_agent_id = format!("local-agent-{}", safe_local_name(&input.workspace_id));
    let agent = LocalRegisteredAgent {
        id: id.clone(),
        base_url: MOCK_BASE_URL.to_string(),
        space_id: MOCK_SPACE_ID.to_string(),
        owner_user_id: Some(MOCK_OWNER_USER_ID.to_string()),
        device_id: Some(mock_local_device_id()),
        client_id: Some("mock-public-client".to_string()),
        device_name: mock_local_device_name(),
        device_platform: Some(crate::device_identity::platform_identifier()),
        device_os_version: mock_local_device_os_version(),
        device_app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        device_last_seen_at: Some("2026-06-24T09:34:00.000Z".to_string()),
        local_workspace_id: Some(input.workspace_id.clone()),
        local_agent_id: Some(local_agent_id),
        workspace_id: Some(input.workspace_id),
        display_name: display_name.to_string(),
        instruction: Some(instruction.to_string()),
        instruction_revision: 1,
        workspace_path: workspace_root.to_string_lossy().to_string(),
        workspace_label: input.workspace_label.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        avatar_url: Some(mock_avatar_preset_url("agents", &avatar_preset_id, 128)),
        avatar_source: Some("preset".to_string()),
        avatar_preset_id: Some(avatar_preset_id.clone()),
        avatar_urls: Some(mock_avatar_urls("agents", &avatar_preset_id)),
        subscriptions: vec![SpaceGoalSubscriptionSummary {
            id: format!("subscription-{}", id),
            space_id: MOCK_SPACE_ID.to_string(),
            actor_type: "registered_agent".to_string(),
            actor_id: id.clone(),
            goal_id: goal_id.to_string(),
            include_subtree: true,
            state_filter: input
                .state_filter
                .clone()
                .unwrap_or_else(|| vec!["todo".to_string()]),
            goal_path_label: goal_path_label.clone(),
            created_at: "2026-06-24T09:34:00.000Z".to_string(),
        }],
        goal_id: Some(goal_id.to_string()),
        goal_path_label,
        state_filter: input
            .state_filter
            .unwrap_or_else(|| vec!["todo".to_string()]),
        goal_md: input.goal_md,
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        issue_subscription_run_mode: input.issue_subscription_run_mode.unwrap_or_default(),
        issue_session_ids: Default::default(),
        token: format!("mock-token-{}", id),
        status: "active".to_string(),
        created_at: "2026-06-24T09:34:00.000Z".to_string(),
        updated_at: "2026-06-24T09:34:00.000Z".to_string(),
    };
    state.agents.insert(0, agent.clone());
    Ok(agent.into())
}

fn normalize_mock_agent_state_filter(input: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for state in input {
        let state = state.trim();
        if state.is_empty() || out.iter().any(|existing| existing == state) {
            continue;
        }
        out.push(state.to_string());
    }
    if out.is_empty() {
        vec!["todo".to_string()]
    } else {
        out
    }
}

pub fn revoke_agent(id: &str) -> Result<LocalRegisteredAgentPublic, String> {
    let mut state = state().lock().expect("mock state poisoned");
    let agent = state
        .agents
        .iter_mut()
        .find(|agent| agent.id == id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", id))?;
    agent.status = "revoked".to_string();
    agent.updated_at = "2026-06-24T09:51:00.000Z".to_string();
    Ok(agent.clone().into())
}

pub fn update_registered_agent_avatar(
    input: SpaceUpdateRegisteredAgentAvatarInput,
) -> Result<LocalRegisteredAgentPublic, String> {
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
    if avatar_preset_id.is_none() && avatar_file_path.is_none() {
        return Err("Avatar file or preset is required".to_string());
    }
    let mut state = state().lock().expect("mock state poisoned");
    let next_upload_seq = state.seq + 1;
    let agent_index = state
        .agents
        .iter()
        .position(|agent| agent.id == input.id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", input.id))?;
    state.seq += 1;
    let agent = &mut state.agents[agent_index];
    if let Some(preset_id) = avatar_preset_id {
        agent.avatar_url = Some(mock_avatar_preset_url("agents", preset_id, 128));
        agent.avatar_source = Some("preset".to_string());
        agent.avatar_preset_id = Some(preset_id.to_string());
        agent.avatar_urls = Some(mock_avatar_urls("agents", preset_id));
    } else if let Some(path) = avatar_file_path {
        let file_path = PathBuf::from(path);
        if !file_path.is_absolute() {
            return Err("Avatar image path must be absolute".to_string());
        }
        let ext = file_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .ok_or_else(|| "Avatar image must be png, jpg, jpeg, or webp".to_string())?;
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            return Err("Avatar image must be png, jpg, jpeg, or webp".to_string());
        }
        let metadata = fs::symlink_metadata(&file_path)
            .map_err(|e| format!("Failed to inspect avatar image: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err("Avatar image path must not be a symlink".to_string());
        }
        if !metadata.is_file() {
            return Err("Avatar image path must be a file".to_string());
        }
        if metadata.len() > 5 * 1024 * 1024 {
            return Err("Avatar image exceeds 5242880 bytes".to_string());
        }
        agent.avatar_url = Some(format!(
            "{}/mock-avatar/agent-uploaded-{}.webp",
            MOCK_BASE_URL, next_upload_seq
        ));
        agent.avatar_source = Some("r2".to_string());
        agent.avatar_preset_id = None;
        agent.avatar_urls = None;
    }
    agent.updated_at = "2026-06-24T09:54:00.000Z".to_string();
    Ok(agent.clone().into())
}

#[cfg(test)]
pub(crate) fn delivery_by_id(delivery_id: &str) -> Option<Value> {
    state()
        .lock()
        .expect("mock state poisoned")
        .deliveries
        .iter()
        .find(|item| item.pointer("/delivery/id").and_then(Value::as_str) == Some(delivery_id))
        .cloned()
}

pub fn mark_dispatch_delivered(
    dispatch_id: &str,
    registered_agent_id: Option<&str>,
    local_task_id: Option<String>,
    local_run_id: Option<String>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    for item in &mut state.dispatches {
        if item.pointer("/dispatch/id").and_then(Value::as_str) == Some(dispatch_id) {
            if let Some(agent_id) = registered_agent_id {
                let dispatch_agent_id = item
                    .pointer("/dispatch/registeredAgentId")
                    .and_then(Value::as_str);
                if dispatch_agent_id != Some(agent_id) {
                    return Ok(err_envelope(format!(
                        "Dispatch {} does not belong to Registered Agent {}",
                        dispatch_id, agent_id
                    )));
                }
            }
            if let Some(dispatch) = item.get_mut("dispatch").and_then(Value::as_object_mut) {
                dispatch.insert("deliveryStatus".to_string(), json!("delivered"));
                dispatch.insert("updatedAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
                dispatch.insert("localTaskId".to_string(), json!(local_task_id));
                dispatch.insert("localRunId".to_string(), json!(local_run_id));
            }
            return Ok(ok_envelope(
                json!({ "delivered": true, "deliveredAt": "2026-06-24T09:45:00.000Z" }),
            ));
        }
    }
    Ok(err_envelope(format!("Dispatch not found: {}", dispatch_id)))
}

pub fn mark_delivery_delivered(
    delivery_id: &str,
    registered_agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    for item in &mut state.deliveries {
        if item.pointer("/delivery/id").and_then(Value::as_str) == Some(delivery_id) {
            if let Some(agent_id) = registered_agent_id {
                let delivery_agent_id = item
                    .pointer("/delivery/registeredAgentId")
                    .and_then(Value::as_str);
                if delivery_agent_id != Some(agent_id) {
                    return Ok(err_envelope(format!(
                        "Delivery {} does not belong to Registered Agent {}",
                        delivery_id, agent_id
                    )));
                }
            }
            if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
                delivery.insert("status".to_string(), json!("delivered"));
                delivery.insert("deliveredAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
                delivery.insert("deliveredToSessionId".to_string(), json!(session_id));
                delivery.insert("updatedAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
            }
            return Ok(ok_envelope(json!({
                "delivered": true,
                "deliveredAt": "2026-06-24T09:45:00.000Z"
            })));
        }
    }
    Ok(err_envelope(format!("Delivery not found: {}", delivery_id)))
}

pub fn process_deliveries_once() -> SpaceProcessDeliveryResult {
    let mut state = state().lock().expect("mock state poisoned");
    let fallback_sessions = state
        .agents
        .iter()
        .filter_map(|agent| {
            agent
                .delivery_session_id
                .as_ref()
                .map(|session_id| (agent.id.clone(), session_id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut processed = 0usize;
    for item in &mut state.deliveries {
        if item.pointer("/delivery/status").and_then(Value::as_str) == Some("pending") {
            if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
                let registered_agent_id = delivery
                    .get("registeredAgentId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let session_id = delivery
                    .get("targetSessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| fallback_sessions.get(registered_agent_id).cloned())
                    .unwrap_or_else(|| "mock-delivery-session".to_string());
                delivery.insert("status".to_string(), json!("delivered"));
                delivery.insert("deliveredAt".to_string(), json!("2026-06-24T09:46:00.000Z"));
                delivery.insert("deliveredToSessionId".to_string(), json!(session_id));
                delivery.insert("updatedAt".to_string(), json!("2026-06-24T09:46:00.000Z"));
            }
            processed += 1;
        }
    }
    let presence_agents = state
        .agents
        .iter()
        .filter(|agent| agent.status == "active" && agent.device_id.is_some())
        .cloned()
        .collect::<Vec<_>>();
    for agent in presence_agents {
        record_mock_device_presence(&mut state, &agent);
    }
    SpaceProcessDeliveryResult {
        processed,
        delivered: processed,
        errors: Vec::new(),
    }
}

pub fn upload_issue_attachments(input: SpaceUploadIssueAttachmentsInput) -> Result<Value, String> {
    upload_issue_attachments_with_actor(input, None)
}

pub fn upload_issue_attachments_as_registered_agent(
    input: SpaceUploadIssueAttachmentsInput,
    registered_agent_id: &str,
) -> Result<Value, String> {
    upload_issue_attachments_with_actor(input, Some(registered_agent_id))
}

fn upload_issue_attachments_with_actor(
    input: SpaceUploadIssueAttachmentsInput,
    registered_agent_id: Option<&str>,
) -> Result<Value, String> {
    if input.issue_id.trim().is_empty() {
        return Err("issueId is required".to_string());
    }
    if input.file_paths.is_empty() {
        return Err("No attachment selected".to_string());
    }
    if input.file_paths.len() > MAX_ATTACHMENT_UPLOAD_COUNT {
        return Err(format!(
            "At most {} attachments can be uploaded at once",
            MAX_ATTACHMENT_UPLOAD_COUNT
        ));
    }
    let file_paths = input
        .file_paths
        .iter()
        .map(|path| {
            let file_path = PathBuf::from(path.trim());
            if !file_path.is_absolute() {
                return Err("Attachment path must be absolute".to_string());
            }
            let metadata = fs::symlink_metadata(&file_path)
                .map_err(|e| format!("Failed to inspect attachment: {}", e))?;
            if metadata.file_type().is_symlink() {
                return Err("Attachment path must not be a symlink".to_string());
            }
            if !metadata.is_file() {
                return Err("Attachment path must be a file".to_string());
            }
            if metadata.len() > MAX_ATTACHMENT_UPLOAD_BYTES {
                return Err(format!(
                    "Attachment exceeds {} bytes: {}",
                    MAX_ATTACHMENT_UPLOAD_BYTES,
                    file_path.display()
                ));
            }
            Ok((file_path, metadata.len()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut state = state().lock().expect("mock state poisoned");
    let issue_id = input.issue_id.trim().to_string();
    if find_issue_index(&state.issues, &issue_id).is_none() {
        return Err(format!("Issue not found: {}", input.issue_id));
    }
    let mut new_attachments = Vec::new();
    for (file_path, size) in file_paths {
        let name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_local_filename)
            .unwrap_or_else(|| "attachment.txt".to_string());
        let attachment = json!({
            "id": state.next_id("att"),
            "name": name,
            "sizeBytes": size,
            "mimeType": mime_for_name(&name),
            "createdAt": "2026-06-24T09:36:00.000Z"
        });
        new_attachments.push(attachment);
    }
    state
        .attachments
        .entry(issue_id.clone())
        .or_default()
        .extend(new_attachments.clone());
    cancel_pending_issue_deliveries(&mut state, &issue_id);
    increment_issue_notification_version(&mut state, &issue_id);
    refresh_issue_counts(&mut state, &issue_id);
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id.as_str()))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let first_new_delivery = state.deliveries.len();
    route_mock_issue_deliveries(
        &mut state,
        &issue,
        "issue.attachments_added",
        registered_agent_id,
    )?;
    let actor = registered_agent_id
        .map(|id| json!({ "type": "registered_agent", "id": id, "name": "Mock Agent" }))
        .unwrap_or_else(|| json!({ "type": "user", "id": MOCK_OWNER_USER_ID, "name": "Ethan" }));
    for item in state.deliveries.iter_mut().skip(first_new_delivery) {
        if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
            delivery.insert(
                "updateSummary".to_string(),
                json!("Attachments added to Issue"),
            );
            delivery.insert(
                "trigger".to_string(),
                json!({
                    "updateId": format!("update_attachments_{}", issue_id),
                    "type": "issue.attachments_added",
                    "actor": actor,
                    "attachments": new_attachments,
                    "createdAt": "2026-07-12T10:02:00.000Z"
                }),
            );
        }
    }
    let event_id = state.next_id("evt");
    state.events.push(json!({
        "id": event_id,
        "type": "issue.attachments_added",
        "resourceType": "issue",
        "resourceId": issue_id,
        "actorType": actor.get("type").cloned().unwrap_or_else(|| json!("user")),
        "actorId": actor.get("id").cloned().unwrap_or_else(|| json!(MOCK_OWNER_USER_ID)),
        "targetRegisteredAgentId": null,
        "payload": { "attachments": new_attachments },
        "createdAt": "2026-07-12T10:02:00.000Z"
    }));
    Ok(json!({ "attachments": new_attachments }))
}

fn materialize_mock_attachment_metadata(state: &mut MockState, raw: &[Value]) -> Vec<Value> {
    raw.iter()
        .take(MAX_ATTACHMENT_UPLOAD_COUNT)
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(safe_local_filename)
                .unwrap_or_else(|| "attachment".to_string());
            json!({
                "id": state.next_id("att"),
                "name": name,
                "sizeBytes": item.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0),
                "mimeType": item.get("mimeType").and_then(Value::as_str).unwrap_or("application/octet-stream"),
                "createdAt": "2026-06-24T09:36:00.000Z"
            })
        })
        .collect()
}

pub fn update_profile(input: SpaceUpdateProfileInput) -> Result<SpaceSessionPublic, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Profile name is required".to_string());
    }
    if name.chars().count() > 40 {
        return Err("Profile name must be at most 40 characters".to_string());
    }
    let mut state = state().lock().expect("mock state poisoned");
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
    let avatar_url = if let Some(preset_id) = avatar_preset_id {
        Some(mock_avatar_preset_url("people", preset_id, 128))
    } else if let Some(path) = avatar_file_path {
        let file_path = PathBuf::from(path);
        if !file_path.is_absolute() {
            return Err("Avatar image path must be absolute".to_string());
        }
        let ext = file_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .ok_or_else(|| "Avatar image must be png, jpg, jpeg, or webp".to_string())?;
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            return Err("Avatar image must be png, jpg, jpeg, or webp".to_string());
        }
        let metadata = fs::symlink_metadata(&file_path)
            .map_err(|e| format!("Failed to inspect avatar image: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err("Avatar image path must not be a symlink".to_string());
        }
        if !metadata.is_file() {
            return Err("Avatar image path must be a file".to_string());
        }
        if metadata.len() > 5 * 1024 * 1024 {
            return Err("Avatar image exceeds 5242880 bytes".to_string());
        }
        Some(format!(
            "{}/mock-avatar/uploaded-{}.webp",
            MOCK_BASE_URL,
            state.seq + 1
        ))
    } else {
        None
    };
    state.seq += 1;
    if let Some(user) = state.user.as_object_mut() {
        user.insert("name".to_string(), json!(name));
        if let Some(url) = avatar_url.as_deref() {
            user.insert("avatarUrl".to_string(), json!(url));
            if let Some(preset_id) = avatar_preset_id {
                user.insert("avatarSource".to_string(), json!("preset"));
                user.insert("avatarPresetId".to_string(), json!(preset_id));
                user.insert(
                    "avatarUrls".to_string(),
                    mock_avatar_urls("people", preset_id),
                );
            } else {
                user.insert("avatarSource".to_string(), json!("r2"));
                user.insert("avatarPresetId".to_string(), Value::Null);
                user.insert("avatarUrls".to_string(), Value::Null);
            }
        }
    }
    let user_id = state
        .user
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(MOCK_OWNER_USER_ID)
        .to_string();
    let user_name = state
        .user
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(name)
        .to_string();
    let user_avatar = state.user.get("avatarUrl").cloned().unwrap_or(Value::Null);
    patch_mock_user_summaries(&mut state, &user_id, &user_name, &user_avatar);
    Ok(SpaceSession {
        base_url: MOCK_BASE_URL.to_string(),
        session_token: "mock-session-token".to_string(),
        expires_at: None,
        user: state.user.clone(),
        account_plan: mock_account_plan(),
        space: mock_space(),
        membership: mock_membership(),
        spaces: vec![mock_space_list_item()],
        last_active_space_id: Some(MOCK_SPACE_ID.to_string()),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
    .into())
}

pub fn update_space(input: SpaceUpdateSpaceInput) -> Result<SpaceSessionPublic, String> {
    if input.space_id.trim().is_empty() {
        return Err("Space id is required".to_string());
    }
    if let Some(name) = input.name.as_deref() {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Space name is required".to_string());
        }
        if trimmed.chars().count() > 80 {
            return Err("Space name must be at most 80 characters".to_string());
        }
    }
    if let Some(path) = input
        .avatar_file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let file_path = PathBuf::from(path);
        if !file_path.is_absolute() {
            return Err("Avatar image path must be absolute".to_string());
        }
        let ext = file_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .ok_or_else(|| "Avatar image must be png, jpg, jpeg, or webp".to_string())?;
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            return Err("Avatar image must be png, jpg, jpeg, or webp".to_string());
        }
    }
    Ok(session().into())
}

fn patch_actor_summary(value: &mut Value, user_id: &str, name: &str, avatar_url: &Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if object.get("id").and_then(Value::as_str) != Some(user_id) {
        return;
    }
    object.insert("name".to_string(), json!(name));
    object.insert("avatarUrl".to_string(), avatar_url.clone());
}

fn patch_mock_user_summaries(state: &mut MockState, user_id: &str, name: &str, avatar_url: &Value) {
    for issue in &mut state.issues {
        if let Some(creator) = issue.get_mut("creator") {
            patch_actor_summary(creator, user_id, name, avatar_url);
        }
        if let Some(author) = issue.get_mut("author") {
            patch_actor_summary(author, user_id, name, avatar_url);
        }
    }
    for comments in state.comments.values_mut() {
        for comment in comments {
            if let Some(author) = comment.get_mut("author") {
                patch_actor_summary(author, user_id, name, avatar_url);
            }
        }
    }
    for record in &mut state.skills {
        if let Some(uploader) = record.skill.get_mut("uploader") {
            patch_actor_summary(uploader, user_id, name, avatar_url);
        }
    }
}

fn skill_source_json(source: &SpaceSkillSourceMetaInput) -> Value {
    json!({
        "type": source.source_type.as_str(),
        "url": source.url.as_str(),
        "resolvedUrl": source.resolved_url.as_deref(),
        "owner": source.owner.as_deref(),
        "repo": source.repo.as_deref(),
        "ref": source.ref_name.as_deref(),
        "effectiveRef": source.effective_ref.as_deref(),
        "rootPath": source.root_path.as_deref(),
        "skillName": source.skill_name.as_deref(),
        "updatedAt": "2026-06-24T10:15:00.000Z"
    })
}

pub fn upload_skill(input: SpaceUploadSkillInput) -> Result<Value, String> {
    let file_path = PathBuf::from(input.file_path.trim());
    if !file_path.is_absolute() {
        return Err("Skill source path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|e| format!("Failed to inspect skill source: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Skill source path must not be a symlink".to_string());
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Skill source path must be a file or directory".to_string());
    }
    if metadata.is_file() && metadata.len() > MAX_SKILL_ZIP_BYTES as u64 {
        return Err(format!("Skill zip exceeds {} bytes", MAX_SKILL_ZIP_BYTES));
    }
    let mut state = state().lock().expect("mock state poisoned");
    let name = input
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            file_path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("uploaded-skill")
                .replace('-', " ")
        });
    let uploader = json!({
        "id": state.user.get("id").and_then(Value::as_str).unwrap_or(MOCK_OWNER_USER_ID),
        "name": state.user.get("name").and_then(Value::as_str).unwrap_or("Ethan"),
        "avatarUrl": state.user.get("avatarUrl").cloned().unwrap_or(Value::Null)
    });
    if let Some(skill_id) = input.skill_id {
        let record = state
            .skills
            .iter_mut()
            .find(|record| {
                record.skill.get("id").and_then(Value::as_str) == Some(skill_id.as_str())
            })
            .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
        let latest = record
            .skill
            .get("latestRevision")
            .and_then(Value::as_u64)
            .unwrap_or(record.current_revision)
            + 1;
        record.current_revision = latest;
        if let Some(object) = record.skill.as_object_mut() {
            object.insert("latestRevision".to_string(), json!(latest));
            object.insert("currentRevision".to_string(), json!(latest));
            object.insert("uploader".to_string(), uploader.clone());
            object.insert("updatedAt".to_string(), "2026-06-24T10:15:00.000Z".into());
            if let Some(source) = input.source.as_ref() {
                object.insert("source".to_string(), skill_source_json(source));
            }
        }
        record.revisions.insert(
            0,
            json!({
                "id": format!("sklr_{}_{}", skill_id, latest),
                "skillId": skill_id,
                "revision": latest,
                "version": format!("v{}", latest),
                "packageHash": format!("mockhash{}{:02}", safe_local_name(&name), latest),
                "isCurrent": true,
                "uploader": uploader,
                "createdAt": "2026-06-24T10:15:00.000Z"
            }),
        );
        for revision in &mut record.revisions {
            let is_current = revision.get("revision").and_then(Value::as_u64) == Some(latest);
            if let Some(object) = revision.as_object_mut() {
                object.insert("isCurrent".to_string(), json!(is_current));
            }
        }
        return Ok(json!({ "skill": record.skill.clone() }));
    }
    let id = state.next_id("skl");
    let mut skill = json!({
        "id": id,
        "name": title_case(&name),
        "slug": safe_local_name(&name),
        "description": input.description.unwrap_or_else(|| "Uploaded mock Skill package for UI verification.".to_string()),
        "latestRevision": 1,
        "currentRevision": 1,
        "uploader": uploader,
        "createdAt": "2026-06-24T09:37:00.000Z",
        "updatedAt": "2026-06-24T09:37:00.000Z"
    });
    if let (Some(source), Some(object)) = (input.source.as_ref(), skill.as_object_mut()) {
        object.insert("source".to_string(), skill_source_json(source));
    }
    let record = skill_record(
        skill.clone(),
        "Uploaded mock Skill package for UI verification.",
        "Use this mock package to verify upload and install flows without hitting the cloud.",
    );
    state
        .skills
        .retain(|existing| existing.skill.get("id") != skill.get("id"));
    state.skills.insert(0, record);
    Ok(json!({ "skill": skill }))
}

pub fn download_attachment(
    workspace_path: &str,
    attachment_id: &str,
    issue_id: Option<&str>,
    file_name: Option<&str>,
    output: Option<&str>,
) -> Result<SpaceDownloadAttachmentResult, String> {
    let workspace_root = validate_workspace_root(workspace_path)?;
    let state = state().lock().expect("mock state poisoned");
    let found = state
        .attachments
        .values()
        .flat_map(|items| items.iter())
        .find(|attachment| attachment.get("id").and_then(Value::as_str) == Some(attachment_id))
        .cloned()
        .ok_or_else(|| format!("Attachment not found: {}", attachment_id))?;
    let name = file_name
        .map(safe_local_filename)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            found
                .get("name")
                .and_then(Value::as_str)
                .map(safe_local_filename)
        })
        .unwrap_or_else(|| format!("attachment-{}.txt", attachment_id));
    let relative = output
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            format!(
                "myagents_files/space/issues/{}/attachments/{}/{}",
                issue_id.unwrap_or("mock-issue"),
                attachment_id,
                name
            )
        });
    let target = resolve_inside_workspace(&workspace_root, &relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create attachment dir: {}", e))?;
    }
    let bytes = format!(
        "Mock attachment {}\nGenerated by MyAgents Space mock data.\n",
        attachment_id
    )
    .into_bytes();
    atomic_write_file(&target, &bytes)?;
    Ok(SpaceDownloadAttachmentResult {
        name,
        relative_path: relative,
        full_path: target.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
    })
}

pub fn skill_package_bytes(skill_id: &str) -> Result<Vec<u8>, String> {
    let state = state().lock().expect("mock state poisoned");
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut bytes);
        let options = zip::write::SimpleFileOptions::default();
        for file in &record.files {
            if file.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("SKILL.md");
            let content = record
                .file_content
                .get(path)
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("Mock Skill file");
            zip.start_file(path, options)
                .map_err(|e| format!("Failed to write mock skill zip: {}", e))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write mock skill zip: {}", e))?;
        }
        zip.finish()
            .map_err(|e| format!("Failed to finish mock skill zip: {}", e))?;
    }
    Ok(bytes.into_inner())
}

fn handle_api_data_request(
    method: &str,
    path: &str,
    query: HashMap<String, String>,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    let actor = mock_actor_for_token(&state, token);
    let supplied_token = token.map(str::trim).filter(|value| !value.is_empty());
    if supplied_token.is_some()
        && supplied_token != Some("mock-session-token")
        && !actor.authenticated
    {
        return Err(
            "REGISTERED_AGENT_TOKEN_IS_INVALID_OR_REVOKED: Mock request token is invalid"
                .to_string(),
        );
    }
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        ("GET", ["api", "spaces"]) => Ok(mock_me(&state)),
        ("GET", ["api", "spaces", "official"]) => Ok(json!({
            "space": mock_space(),
            "membership": mock_membership(),
            "goals": active_goals(&state),
            "tags": state.tags,
            "usage": mock_usage(&state),
            "limits": mock_limits()
        })),
        ("PATCH", ["api", "spaces", "official"]) | ("PATCH", ["api", "spaces", MOCK_SPACE_ID]) => {
            Ok(json!({
                "space": mock_space(),
                "usage": mock_usage(&state),
                "limits": mock_limits()
            }))
        }
        ("GET", ["api", "me"]) => Ok(mock_me(&state)),
        ("POST", ["api", "me", "profile"]) => {
            Err("Mock profile updates must use cmd_space_update_profile".to_string())
        }
        ("GET", ["api", "spaces", "official", "usage"])
        | ("GET", ["api", "spaces", MOCK_SPACE_ID, "usage"]) => Ok(json!({
            "usage": mock_usage(&state),
            "limits": mock_limits()
        })),
        ("GET", ["api", "spaces", "official", "members"])
        | ("GET", ["api", "spaces", MOCK_SPACE_ID, "members"]) => Ok(json!({
            "members": [{
                "id": "mship_mock_owner",
                "spaceId": MOCK_SPACE_ID,
                "userId": MOCK_OWNER_USER_ID,
                "role": "owner",
                "createdAt": "2026-06-24T09:00:00.000Z",
                "user": state.user.clone()
            }],
            "joinRequests": [],
            "invitations": [],
            "usage": mock_usage(&state),
            "limits": mock_limits()
        })),
        ("GET", ["api", "spaces", "official", "goals"]) => Ok(list_goals(&state, &query)),
        ("POST", ["api", "spaces", "official", "goals"]) => create_goal(&mut state, body),
        ("PATCH", ["api", "goals", goal_id]) => update_goal(&mut state, goal_id, body),
        ("POST", ["api", "goals", goal_id, "archive"]) => archive_goal(&mut state, goal_id),
        ("POST", ["api", "spaces", "official", "tags"]) => create_tag(&mut state, body),
        ("GET", ["api", "spaces", "official", "assignee-candidates"]) => {
            Ok(mock_assignee_candidates(&state, &actor))
        }
        ("GET", ["api", "spaces", "official", "issues"]) => Ok(list_issues(&state, &query)),
        ("POST", ["api", "spaces", "official", "issues"]) => create_issue(&mut state, body, &actor),
        ("GET", ["api", "issues", issue_id]) => issue_detail(&state, issue_id, &query),
        ("GET", ["api", "issues", issue_id, "comments"]) => {
            issue_comments_page(&state, issue_id, &query)
        }
        ("GET", ["api", "issues", issue_id, "comments", comment_id]) => {
            get_issue_comment(&state, issue_id, comment_id)
        }
        ("PATCH", ["api", "issues", issue_id]) => update_issue(&mut state, issue_id, body, &actor),
        ("PUT", ["api", "issues", issue_id, "assignee"]) => {
            set_issue_assignee(&mut state, issue_id, body)
        }
        ("POST", ["api", "issues", issue_id, "assignee", "cancel"]) => {
            cancel_issue_assignee(&mut state, issue_id)
        }
        ("POST", ["api", "issues", issue_id, "comments"]) => {
            comment_issue(&mut state, issue_id, body, &actor)
        }
        ("POST", ["api", "issues", issue_id, "status"]) => {
            set_issue_status(&mut state, issue_id, body, &actor)
        }
        ("POST", ["api", "issues", issue_id, "claim"]) => {
            claim_issue(&mut state, issue_id, body, &actor)
        }
        ("POST", ["api", "issues", issue_id, "complete"]) => {
            complete_issue(&mut state, issue_id, body, &actor)
        }
        ("POST", ["api", "issues", issue_id, "cancel-claim"]) => {
            cancel_issue_claim(&mut state, issue_id, body, &actor)
        }
        ("POST", ["api", "issues", issue_id, "close"]) => transition_issue_state(
            &mut state,
            issue_id,
            "closed",
            "issue.state_changed",
            &actor,
        ),
        ("POST", ["api", "issues", issue_id, "close-own"]) => transition_issue_state(
            &mut state,
            issue_id,
            "closed",
            "issue.state_changed",
            &actor,
        ),
        ("POST", ["api", "issues", issue_id, "dispatch"]) => {
            dispatch_issue(&mut state, issue_id, body)
        }
        ("GET", ["api", "spaces", "official", "skills"]) => Ok(json!({
            "items": state.skills.iter().map(|record| record.skill.clone()).collect::<Vec<_>>()
        })),
        ("GET", ["api", "spaces", "official", "events"]) | ("GET", ["api", "events"]) => {
            Ok(list_events(&state, &query))
        }
        ("GET", ["api", "skills", skill_id]) => skill_detail(&state, skill_id),
        ("GET", ["api", "skills", skill_id, "revisions"]) => skill_revisions(&state, skill_id),
        ("GET", ["api", "skills", skill_id, "file-content"]) => skill_file(
            &state,
            skill_id,
            query.get("path").map(String::as_str).unwrap_or(""),
        ),
        ("POST", ["api", "skills", skill_id, "rollback"]) => {
            rollback_skill(&mut state, skill_id, body)
        }
        ("DELETE", ["api", "skills", skill_id]) => delete_skill(&mut state, skill_id),
        ("GET", ["api", "registered-agents", "me", "dispatches"]) => {
            let agent_id = require_registered_agent_actor(&actor)?;
            let items = state
                .dispatches
                .iter()
                .filter(|item| {
                    item.pointer("/dispatch/registeredAgentId")
                        .and_then(Value::as_str)
                        == Some(agent_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }))
        }
        ("GET", ["api", "registered-agents", "me", "deliveries"]) => {
            let agent_id = require_registered_agent_actor(&actor)?;
            let items = state
                .deliveries
                .iter()
                .filter(|item| {
                    item.pointer("/delivery/status").and_then(Value::as_str) == Some("pending")
                        && item
                            .pointer("/delivery/registeredAgentId")
                            .and_then(Value::as_str)
                            == Some(agent_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }))
        }
        ("POST", ["api", "registered-agents", "me", "device-presence"]) => {
            let agent_id = require_registered_agent_actor(&actor)?;
            let agent = state
                .agents
                .iter()
                .find(|agent| agent.id == agent_id)
                .cloned()
                .ok_or_else(|| "Registered Agent not found".to_string())?;
            if agent.device_id.is_none() {
                return Err("Registered Agent has no device binding".to_string());
            }
            let presence = record_mock_device_presence(&mut state, &agent);
            Ok(json!({
                "observedAt": presence.last_online_at,
                "onlineUntil": presence.online_until,
                "leaseSeconds": 390
            }))
        }
        ("POST", ["api", "devices", "upsert"]) => upsert_device(body),
        ("GET", ["api", "spaces", "official", "registered-agents"]) => {
            let items = state
                .agents
                .iter()
                .map(|agent| {
                    let public: LocalRegisteredAgentPublic = agent.clone().into();
                    let presence = mock_device_presence_for_agent(&state, agent);
                    let online = agent.status == "active" && presence.is_some();
                    json!({
                        "id": agent.id,
                        "spaceId": agent.space_id,
                        "ownerUserId": agent.owner_user_id.clone().unwrap_or_else(|| MOCK_OWNER_USER_ID.to_string()),
                        "deviceId": agent.device_id.clone(),
                        "device": public.device,
                        "clientId": agent.client_id.clone(),
                        "deviceName": public.device_name,
                        "localWorkspaceId": agent.local_workspace_id.clone(),
                        "localAgentId": agent.local_agent_id.clone(),
                        "displayName": agent.display_name,
                        "workspacePath": agent.workspace_path,
                        "workspaceLabel": agent.workspace_label.clone(),
                        "goalMd": agent.goal_md.clone(),
                        "issueSubscriptionRunMode": agent.issue_subscription_run_mode,
                        "status": agent.status,
                        "presence": if online { "online" } else { "offline" },
                        "lastOnlineAt": presence.map(|value| value.last_online_at.as_str()),
                        "onlineUntil": presence.map(|value| value.online_until.as_str()),
                        "createdAt": agent.created_at,
                        "updatedAt": agent.updated_at,
                        "subscriptions": agent.goal_id.as_ref().map(|goal_id| vec![json!({
                            "id": format!("sub_{}", agent.id),
                            "spaceId": agent.space_id,
                            "actorType": "registered_agent",
                            "actorId": agent.id,
                            "goalId": goal_id,
                            "includeSubtree": true,
                            "stateFilter": agent.state_filter.clone(),
                            "goalPathLabel": agent.goal_path_label.clone(),
                            "createdAt": agent.created_at
                        })]).unwrap_or_default()
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }))
        }
        ("PATCH", ["api", "registered-agents", agent_id]) => {
            update_agent_api(&mut state, agent_id, body)
        }
        ("POST", ["api", "registered-agents", agent_id, "revoke"]) => {
            let agent = state
                .agents
                .iter_mut()
                .find(|agent| agent.id == *agent_id)
                .ok_or_else(|| format!("Registered Agent not found locally: {}", agent_id))?;
            agent.status = "revoked".to_string();
            agent.updated_at = "2026-06-24T09:51:00.000Z".to_string();
            Ok(json!({ "revoked": true }))
        }
        ("POST", ["api", "dispatches", dispatch_id, "delivered"]) => {
            let agent_id = require_registered_agent_actor(&actor)?;
            drop(state);
            let data = mark_dispatch_delivered(dispatch_id, Some(&agent_id), None, None)?;
            Ok(data.get("data").cloned().unwrap_or(Value::Null))
        }
        ("POST", ["api", "deliveries", delivery_id, "delivered"]) => {
            let agent_id = require_registered_agent_actor(&actor)?;
            let session_id = body
                .as_ref()
                .and_then(|value| value.get("sessionId"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            drop(state);
            let data = mark_delivery_delivered(delivery_id, Some(&agent_id), session_id)?;
            if data.get("success").and_then(Value::as_bool) == Some(false) {
                return Err(data
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Mock Delivery ACK failed")
                    .to_string());
            }
            Ok(data.get("data").cloned().unwrap_or(Value::Null))
        }
        ("POST", ["api", "claims", claim_id, "local-task"]) => {
            claim_local_task(&mut state, claim_id, body, &actor)
        }
        _ => Err(format!(
            "Mock Space API route not implemented: {} {}",
            method, path
        )),
    }
}

fn mock_actor_for_token(state: &MockState, token: Option<&str>) -> MockActor {
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(agent) = state
            .agents
            .iter()
            .find(|agent| agent.token == token && agent.status == "active")
        {
            return MockActor {
                actor_type: "registered_agent".to_string(),
                actor_id: agent.id.clone(),
                actor_name: agent.display_name.clone(),
                authenticated: true,
            };
        }
    }
    MockActor {
        actor_type: "user".to_string(),
        actor_id: MOCK_OWNER_USER_ID.to_string(),
        actor_name: state
            .user
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Ethan")
            .to_string(),
        authenticated: false,
    }
}

fn require_registered_agent_actor(actor: &MockActor) -> Result<String, String> {
    if actor.authenticated && actor.actor_type == "registered_agent" {
        return Ok(actor.actor_id.clone());
    }
    Err("Registered Agent token required".to_string())
}

fn mock_device_presence_key(agent: &LocalRegisteredAgent) -> Option<String> {
    let owner_user_id = agent.owner_user_id.as_deref()?.trim();
    let device_id = agent.device_id.as_deref()?.trim();
    if owner_user_id.is_empty() || device_id.is_empty() {
        return None;
    }
    Some(format!("{}::{}", owner_user_id, device_id))
}

fn record_mock_device_presence(
    state: &mut MockState,
    agent: &LocalRegisteredAgent,
) -> MockDevicePresence {
    let observed_at = chrono::Utc::now();
    let presence = MockDevicePresence {
        last_online_at: observed_at.to_rfc3339(),
        online_until: (observed_at + chrono::Duration::seconds(390)).to_rfc3339(),
    };
    if let Some(key) = mock_device_presence_key(agent) {
        state.device_presence.insert(key, presence.clone());
    }
    presence
}

fn mock_device_presence_for_agent<'a>(
    state: &'a MockState,
    agent: &LocalRegisteredAgent,
) -> Option<&'a MockDevicePresence> {
    let key = mock_device_presence_key(agent)?;
    state.device_presence.get(&key).filter(|presence| {
        chrono::DateTime::parse_from_rfc3339(&presence.online_until)
            .map(|until| until.timestamp_millis() > chrono::Utc::now().timestamp_millis())
            .unwrap_or(false)
    })
}

fn state() -> &'static Mutex<MockState> {
    MOCK_STATE.get_or_init(|| Mutex::new(initial_state()))
}

fn initial_state() -> MockState {
    let user = json!({
        "id": MOCK_OWNER_USER_ID,
        "email": "myagents.io@gmail.com",
        "name": "Ethan",
        "avatarUrl": mock_avatar_preset_url("people", "person-01", 128),
        "avatarSource": "preset",
        "avatarPresetId": "person-01",
        "avatarUrls": mock_avatar_urls("people", "person-01")
    });
    let tags = vec![
        tag("bug", "Bug reports and regressions"),
        tag("feature", "Feature requests"),
        tag("ux", "Interaction and visual polish"),
        tag("docs", "Docs and PRD work"),
        tag("runtime", "Runtime and provider behavior"),
        tag("windows", "Windows platform validation"),
        tag("needs-agent", "Ready for a registered agent"),
    ];
    let goals = vec![
        goal(
            MOCK_ROOT_GOAL_ID,
            None,
            "MyAgents社区",
            "Root Goal for mock Space.",
        ),
        goal(
            "goal_mock_runtime",
            Some(MOCK_ROOT_GOAL_ID),
            "Runtime Delivery",
            "Runtime and provider regressions.",
        ),
        goal(
            "goal_mock_ui",
            Some(MOCK_ROOT_GOAL_ID),
            "UI Quality",
            "Interaction and visual polish.",
        ),
        goal(
            "goal_mock_docs",
            Some(MOCK_ROOT_GOAL_ID),
            "Docs Alignment",
            "Architecture and PRD documentation.",
        ),
    ];

    let issue_specs = vec![
        ("iss_mock_001", "评论发送失败时不要丢失输入内容", "open", vec!["bug", "ux"], "发送评论失败后输入框被错误清空会让处理记录丢失，需要保留草稿并给出清晰错误。"),
        ("iss_mock_002", "Space tab 切回来不应该整页重新加载", "triaged", vec!["ux"], "团队空间的数据应该稳定常驻，切 tab 只做静默 revalidate。"),
        ("iss_mock_003", "Codex Runtime 下图片附件需要统一渲染", "in_progress", vec!["runtime", "bug"], "不同 runtime 的工具附件应该进入同一附件管线，避免 UI 分支遗漏。"),
        ("iss_mock_004", "Windows WebView2 下 Skill 文件预览滚动条样式偏硬", "open", vec!["windows", "ux"], "Windows 上默认滚动条太重，需要检查 token 和 scrollbar 样式。"),
        ("iss_mock_005", "补齐 Cloud Space 架构文档中的 mock mode 说明", "resolved", vec!["docs"], "mock mode 属于 dev/test 能力，需要写清楚边界和不进入 release notes。"),
        ("iss_mock_006", "把 Issue 管理按钮改成只读概览", "closed", vec!["ux"], "没有管理动作时按钮不应该叫管理，避免用户误判。"),
        ("iss_mock_007", "插件 Bridge 失败日志需要带 request id", "declined", vec!["runtime"], "该问题和 Space 无直接关系，已转到 runtime backlog。"),
        ("iss_mock_008", "重复创建 issue 时 tag 默认保持当前选择", "duplicate", vec!["feature", "ux"], "与连续创建体验重复，合并到创建弹窗优化。"),
        ("iss_mock_009", "历史会话恢复时 Issue 口令要能被 Agent 读取", "archived", vec!["docs", "needs-agent"], "旧版 CLI 命令已保留兼容，归档记录。"),
        ("iss_mock_010", "Skill 上传成功后应该直接进入详情", "open", vec!["feature"], "上传成功后刷新列表并选择新 Skill，方便安装验证。"),
        ("iss_mock_011", "附件下载到 workspace 时目录名需要稳定", "triaged", vec!["bug"], "下载路径应包含 issue id 和 attachment id，便于 Agent 引用。"),
        ("iss_mock_012", "Registered Agent 离线时指派菜单要禁用", "open", vec!["needs-agent", "ux"], "下拉菜单可以显示 offline agent，但不能点击派发。"),
        ("iss_mock_013", "长标题在 Issue 列表里不能挤掉状态 badge 和 tag", "open", vec!["ux"], "这是一个特意很长很长的标题，用来验证列表行在窄屏和中等宽度下的截断、换行和 badge 布局是否稳定。"),
        ("iss_mock_014", "中文正文和英文 CLI 命令混排的阅读节奏", "in_progress", vec!["docs", "ux"], "详情页正文里会同时出现中文说明、`myagents space issue view iss_mock_014 --space myagents` 命令和较长段落，需要稳定行高。"),
        ("iss_mock_015", "权限不足时状态切换应为静态 badge", "resolved", vec!["bug"], "member 只能关闭自己创建的 issue，不能看到会失败的状态菜单。"),
        ("iss_mock_016", "Agent 执行完成后应回写处理记录", "open", vec!["needs-agent"], "派发后 Agent 需要通过 CLI comment/status 回写进展。"),
        ("iss_mock_017", "官方 Skill 列表空态不应该是大虚线卡片", "triaged", vec!["ux"], "列表空态也应该在底纸上，而不是浮起容器。"),
        ("iss_mock_018", "Space API 5xx 错误要展示人能看懂的摘要", "open", vec!["bug"], "toast 不应显示完整 URL 和 reqwest 原文，debug 信息进日志。"),
    ];

    let mut issues = Vec::new();
    let mut comments = HashMap::new();
    let mut attachments = HashMap::new();
    for (idx, (id, title, status, tag_names, body)) in issue_specs.into_iter().enumerate() {
        let created = format!(
            "2026-06-{:02}T{:02}:30:00.000Z",
            12 + (idx % 10),
            8 + (idx % 9)
        );
        let updated = format!(
            "2026-06-{:02}T{:02}:15:00.000Z",
            18 + (idx % 6),
            10 + (idx % 8)
        );
        let issue_tags = tags_for(&tags, &tag_names);
        let issue_comments = seeded_comments(id, idx);
        let issue_attachments = seeded_attachments(id, idx);
        let archived_at = (status == "archived").then(|| updated.clone());
        issues.push(json!({
            "id": id,
            "number": idx + 1,
            "spaceId": MOCK_SPACE_ID,
            "goalId": seeded_goal_id(idx),
            "parentIssueId": null,
            "title": title,
            "body": body,
            "state": legacy_status_to_state(status),
            "humanOnly": idx % 11 == 0,
            "status": status,
            "creator": {
                "id": if idx % 3 == 0 { MOCK_OWNER_USER_ID } else { "usr_lin" },
                "name": if idx % 3 == 0 { "Ethan" } else { "Lin Qiao" },
                "avatarUrl": if idx % 3 == 0 { "https://space.mock.myagents.local/mock-avatar/ethan.png" } else { "https://space.mock.myagents.local/mock-avatar/lin.png" }
            },
            "author": {
                "id": if idx % 3 == 0 { MOCK_OWNER_USER_ID } else { "usr_lin" },
                "name": if idx % 3 == 0 { "Ethan" } else { "Lin Qiao" },
                "avatarUrl": if idx % 3 == 0 { "https://space.mock.myagents.local/mock-avatar/ethan.png" } else { "https://space.mock.myagents.local/mock-avatar/lin.png" }
            },
            "notificationVersion": 1,
            "goalPathLabel": seeded_goal_label(idx),
            "tags": issue_tags,
            "commentCount": issue_comments.len(),
            "attachmentCount": issue_attachments.len(),
            "archivedAt": archived_at,
            "createdAt": created,
            "updatedAt": updated
        }));
        comments.insert(id.to_string(), issue_comments);
        attachments.insert(id.to_string(), issue_attachments);
    }
    let status_options = [
        "open",
        "triaged",
        "in_progress",
        "resolved",
        "closed",
        "declined",
        "duplicate",
        "archived",
    ];
    let generated_tag_sets: [&[&str]; 8] = [
        &["bug"],
        &["feature", "ux"],
        &["runtime"],
        &["docs"],
        &["windows", "bug"],
        &["needs-agent"],
        &["ux", "docs"],
        &["runtime", "needs-agent"],
    ];
    let generated_titles = [
        "Agent 派发后的处理记录需要更清晰",
        "Skill 安装到项目后应该展示目标路径",
        "Issue 筛选输入连续变更时不能阻塞",
        "附件下载失败时应保留右侧上下文",
        "Space 审计记录需要支持长资源 id 截断",
        "Registered Agent 列表要能扫读 pending 数量",
        "评论区空态和首条评论间距需要稳定",
        "多 tag issue 在窄屏下不能挤压标题",
    ];
    while issues.len() < 500 {
        let idx = issues.len();
        let offset = idx - 18;
        let id = format!("iss_mock_bulk_{:03}", offset + 1);
        let status = status_options[offset % status_options.len()];
        let title = format!(
            "{} #{}",
            generated_titles[offset % generated_titles.len()],
            offset + 1
        );
        let body = format!(
            "这是 mock mode 生成的真实感 Issue，用于验证 500 条列表、筛选、搜索、状态和 tag 的稳定性。\n\n场景编号：{}。\n命令示例：myagents space issue view {} --space myagents",
            offset + 1,
            id
        );
        let created = format!(
            "2026-05-{:02}T{:02}:{:02}:00.000Z",
            1 + (offset % 28),
            8 + (offset % 10),
            (offset * 3) % 60
        );
        let updated = format!(
            "2026-06-{:02}T{:02}:{:02}:00.000Z",
            1 + (offset % 24),
            9 + (offset % 9),
            (offset * 7) % 60
        );
        let tag_names = generated_tag_sets[offset % generated_tag_sets.len()].to_vec();
        let issue_tags = tags_for(&tags, &tag_names);
        let issue_comments = if offset % 9 == 0 {
            vec![json!({
                "id": format!("cmt_{}_seed", id),
                "author": { "id": "usr_lin", "type": "user" },
                "body": "补充：这个 mock issue 用来验证长列表下评论计数和详情刷新。",
                "createdAt": updated.clone()
            })]
        } else {
            Vec::new()
        };
        let issue_attachments = if offset % 13 == 0 {
            vec![attachment(
                &id,
                &format!("diagnostic-{:03}.log", offset + 1),
                8_192 + offset as u64,
                "text/plain",
            )]
        } else {
            Vec::new()
        };
        let archived_at = (status == "archived").then(|| updated.clone());
        issues.push(json!({
            "id": id,
            "number": idx + 1,
            "spaceId": MOCK_SPACE_ID,
            "goalId": seeded_goal_id(idx),
            "parentIssueId": null,
            "title": title,
            "body": body,
            "state": legacy_status_to_state(status),
            "humanOnly": offset % 17 == 0,
            "status": status,
            "creator": {
                "id": if offset % 2 == 0 { MOCK_OWNER_USER_ID } else { "usr_lin" },
                "name": if offset % 2 == 0 { "Ethan" } else { "Lin Qiao" },
                "avatarUrl": if offset % 2 == 0 { "https://space.mock.myagents.local/mock-avatar/ethan.png" } else { "https://space.mock.myagents.local/mock-avatar/lin.png" }
            },
            "author": {
                "id": if offset % 2 == 0 { MOCK_OWNER_USER_ID } else { "usr_lin" },
                "name": if offset % 2 == 0 { "Ethan" } else { "Lin Qiao" },
                "avatarUrl": if offset % 2 == 0 { "https://space.mock.myagents.local/mock-avatar/ethan.png" } else { "https://space.mock.myagents.local/mock-avatar/lin.png" }
            },
            "notificationVersion": 1,
            "goalPathLabel": seeded_goal_label(idx),
            "tags": issue_tags,
            "commentCount": issue_comments.len(),
            "attachmentCount": issue_attachments.len(),
            "archivedAt": archived_at,
            "createdAt": created,
            "updatedAt": updated
        }));
        comments.insert(id.clone(), issue_comments);
        attachments.insert(id, issue_attachments);
    }

    let mut skills = vec![
        skill_record(
            skill(
                "skl_mock_issue_triage",
                "Issue Triage Operator",
                "issue-triage",
                "Read Space issues, classify them, and prepare an action digest.",
                7,
            ),
            "Automates Space issue triage for maintainers.",
            "Use for scheduled issue review and digest generation.",
        ),
        skill_record(
            skill(
                "skl_mock_prd_writer",
                "PRD Writer",
                "prd-writer",
                "Turns converged product discussions into implementation-ready PRDs.",
                4,
            ),
            "Preserves user intent and technical ground truth.",
            "Use when a discussion needs to become a durable spec.",
        ),
        skill_record(
            skill(
                "skl_mock_frontend_taste",
                "Frontend Taste Review",
                "frontend-taste-review",
                "Reviews React UI for MyAgents design-system consistency.",
                3,
            ),
            "Checks spacing, token use, and fake controls.",
            "Use before shipping user-facing UI changes.",
        ),
        skill_record(
            skill(
                "skl_mock_release_helper",
                "Release Helper",
                "release-helper",
                "Prepares changelog, tags, and release notes for accepted builds.",
                5,
            ),
            "Coordinates release handoff.",
            "Use after acceptance.",
        ),
        skill_record(
            skill(
                "skl_mock_pdf_toolkit",
                "PDF Toolkit",
                "pdf-toolkit",
                "Extracts, renders, and validates PDF artifacts.",
                2,
            ),
            "PDF processing helper.",
            "Use for PDF workflows.",
        ),
        skill_record(
            skill(
                "skl_mock_xlsx_toolkit",
                "Spreadsheet Toolkit",
                "spreadsheet-toolkit",
                "Analyzes workbook data and creates polished spreadsheets.",
                6,
            ),
            "Spreadsheet workflow helper.",
            "Use for XLSX/CSV work.",
        ),
        skill_record(
            skill(
                "skl_mock_docx_editor",
                "Document Editor",
                "document-editor",
                "Edits professional DOCX documents with render verification.",
                2,
            ),
            "Document editing helper.",
            "Use for DOCX tasks.",
        ),
        skill_record(
            skill(
                "skl_mock_browser_automation",
                "Browser Automation",
                "browser-automation",
                "Drives local browser checks and screenshots.",
                8,
            ),
            "Browser QA helper.",
            "Use for UI smoke tests.",
        ),
        skill_record(
            skill(
                "skl_mock_runtime_probe",
                "Runtime Probe",
                "runtime-probe",
                "Investigates Codex, Claude Code, and Gemini runtime behavior.",
                3,
            ),
            "Runtime debugging helper.",
            "Use for runtime regressions.",
        ),
        skill_record(
            skill(
                "skl_mock_windows_sweep",
                "Windows Compatibility Sweep",
                "windows-compatibility-sweep",
                "Checks Windows paths, WebView, and process behavior.",
                4,
            ),
            "Windows validation helper.",
            "Use before Windows release checks.",
        ),
    ];

    while skills.len() < 50 {
        let idx = skills.len();
        let id = format!("skl_mock_generated_{:02}", idx + 1);
        let name = format!("Generated Space Skill {:02}", idx + 1);
        let slug = format!("generated-space-skill-{:02}", idx + 1);
        skills.push(skill_record(
            skill(
                &id,
                &name,
                &slug,
                "Generated mock skill for testing dense Skill lists, file preview, install actions, and revision metadata.",
                1 + (idx % 9) as u32,
            ),
            "Generated skill overview used by mock mode to validate dense lists and detail previews.",
            "This generated skill exists only in mock mode and exercises realistic metadata.",
        ));
    }

    let current_workspace = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string();
    let mut agents = vec![
        agent(
            "rag_mock_frontend",
            "Frontend Polisher",
            "active",
            &current_workspace,
            "MyAgents",
            "Handle UI polish, screenshots, and design-system regressions.",
        ),
        agent(
            "rag_mock_release",
            "Release Steward",
            "online",
            &current_workspace,
            "MyAgents Release",
            "Prepare release tasks and verify changelog completeness.",
        ),
        agent(
            "rag_mock_windows",
            "Windows QA Runner",
            "offline",
            "C:/Users/Ethan/Projects/MyAgents",
            "Windows VM",
            "Run Windows smoke checks when the VM is online.",
        ),
        agent(
            "rag_mock_docs",
            "Docs Curator",
            "active",
            "/Users/ethan/Docs/MyAgents",
            "Docs Workspace",
            "Keep PRDs, architecture docs, and guides aligned.",
        ),
        agent(
            "rag_mock_runtime",
            "Runtime Sentinel",
            "error",
            "/Users/ethan/RuntimeLab",
            "Runtime Lab",
            "Investigate multi-runtime failures and provider quirks.",
        ),
    ];
    let generated_agent_statuses = ["active", "disabled", "offline", "error", "active"];
    while agents.len() < 50 {
        let idx = agents.len();
        let status = generated_agent_statuses[idx % generated_agent_statuses.len()];
        let workspace_label = format!("Workspace {}", idx + 1);
        agents.push(agent(
            &format!("rag_mock_generated_{:02}", idx + 1),
            &format!("Generated Agent {:02}", idx + 1),
            status,
            &format!("/Users/ethan/MockWorkspaces/workspace-{:02}", idx + 1),
            &workspace_label,
            "Pick up assigned mock issues, read context first, and report next actions.",
        ));
    }

    let dispatches = vec![dispatch_item(
        "dsp_mock_001",
        &agents[0],
        &issues[2],
        "pending",
    )];
    let deliveries = vec![delivery_item(
        "del_mock_001",
        &agents[0],
        // Seed an Issue that actually matches this Agent's UI Goal + todo
        // subscription; human-only or out-of-scope fixtures must never appear
        // in an Agent inbox.
        &issues[10],
        "pending",
    )];
    let events = vec![
        mock_event(
            "evt_mock_001",
            "issue.created",
            "issue",
            "iss_mock_001",
            "2026-06-24T09:30:00.000Z",
        ),
        mock_event(
            "evt_mock_002",
            "comment.created",
            "issue",
            "iss_mock_002",
            "2026-06-24T09:35:00.000Z",
        ),
        mock_event(
            "evt_mock_003",
            "skill.updated",
            "skill",
            "skl_mock_prd_writer",
            "2026-06-24T09:40:00.000Z",
        ),
        mock_event(
            "evt_mock_004",
            "dispatch.created",
            "dispatch",
            "dsp_mock_001",
            "2026-06-24T09:45:00.000Z",
        ),
        mock_event(
            "evt_mock_005",
            "space.plan_changed",
            "space",
            MOCK_SPACE_ID,
            "2026-07-11T09:00:00.000Z",
        ),
    ];

    MockState {
        user,
        tags,
        goals,
        issues,
        comments,
        attachments,
        claims: HashMap::new(),
        complete_operations: HashMap::new(),
        skills,
        agents,
        device_presence: HashMap::new(),
        dispatches,
        deliveries,
        events,
        seq: 100,
    }
}

impl MockState {
    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{}_mock_{:03}", prefix, self.seq)
    }
}

fn issue_with_claim(state: &MockState, mut issue: Value) -> Value {
    let claim = issue
        .get("id")
        .and_then(Value::as_str)
        .and_then(|issue_id| state.claims.get(issue_id))
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(object) = issue.as_object_mut() {
        object.insert("claim".to_string(), claim);
    }
    issue
}

fn list_issues(state: &MockState, query: &HashMap<String, String>) -> Value {
    let q = query
        .get("q")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let tag = query
        .get("tag")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let status = query
        .get("state")
        .or_else(|| query.get("status"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let goal_id = query
        .get("goalId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let include_subtree = query
        .get("includeSubtree")
        .map(|value| value == "true")
        .unwrap_or(false);
    let human_only = query
        .get("humanOnly")
        .map(|value| value.trim().to_ascii_lowercase());
    let include_archived = query
        .get("includeArchived")
        .map(|value| value == "true")
        .unwrap_or(false);
    let related_to_me = query.get("related").map(String::as_str) == Some("me");
    let owned_agent_ids = state
        .agents
        .iter()
        .filter(|agent| agent.owner_user_id.as_deref() == Some(MOCK_OWNER_USER_ID))
        .map(|agent| agent.id.as_str())
        .collect::<HashSet<_>>();
    let cursor = query
        .get("cursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(30)
        .clamp(1, 100);
    let mut items = state
        .issues
        .iter()
        .filter(|issue| include_archived || !is_archived(issue))
        .filter(|issue| {
            let title = issue
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let body = issue
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let issue_status = issue
                .get("state")
                .or_else(|| issue.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let issue_goal_id = issue.get("goalId").and_then(Value::as_str).unwrap_or("");
            let issue_human_only = issue
                .get("humanOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tags = issue
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let matches_q = q
                .as_ref()
                .map(|q| title.contains(q) || body.contains(q))
                .unwrap_or(true);
            let matches_tag = tag
                .as_ref()
                .map(|tag| {
                    tags.iter().any(|item| {
                        let id_matches = item
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| id.eq_ignore_ascii_case(tag))
                            .unwrap_or(false);
                        let name_matches = item
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| name.eq_ignore_ascii_case(tag))
                            .unwrap_or(false);
                        id_matches || name_matches
                    })
                })
                .unwrap_or(true);
            let matches_status = match status.as_deref() {
                Some("all") => true,
                Some(status) => status.split(',').any(|item| item.trim() == issue_status),
                None => matches!(issue_status.as_str(), "open" | "todo" | "doing"),
            };
            let matches_goal = goal_id
                .as_ref()
                .map(|goal_id| {
                    if goal_id == "inbox" || goal_id == "null" {
                        issue_goal_id.is_empty()
                    } else if include_subtree {
                        goal_is_in_subtree(state, issue_goal_id, goal_id)
                    } else {
                        issue_goal_id == goal_id
                    }
                })
                .unwrap_or(true);
            let matches_human_only = human_only
                .as_ref()
                .map(|value| match value.as_str() {
                    "true" => issue_human_only,
                    "false" => !issue_human_only,
                    _ => true,
                })
                .unwrap_or(true);
            let issue_id = issue.get("id").and_then(Value::as_str).unwrap_or("");
            let creator_id = issue
                .get("creator")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str);
            let has_related_comment =
                state
                    .comments
                    .get(issue_id)
                    .into_iter()
                    .flatten()
                    .any(|comment| {
                        let author_id = comment.pointer("/author/id").and_then(Value::as_str);
                        author_id == Some(MOCK_OWNER_USER_ID)
                            || author_id.is_some_and(|id| owned_agent_ids.contains(id))
                    });
            let has_related_claim = state.claims.get(issue_id).is_some_and(|claim| {
                let actor_id = claim.get("actorId").and_then(Value::as_str);
                actor_id == Some(MOCK_OWNER_USER_ID)
                    || actor_id.is_some_and(|id| owned_agent_ids.contains(id))
            });
            let matches_related = !related_to_me
                || creator_id == Some(MOCK_OWNER_USER_ID)
                || creator_id.is_some_and(|id| owned_agent_ids.contains(id))
                || has_related_comment
                || has_related_claim;
            matches_q
                && matches_tag
                && matches_status
                && matches_goal
                && matches_human_only
                && matches_related
        })
        .cloned()
        .map(|issue| issue_with_claim(state, issue))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
    });
    let total = items.len();
    let page = items
        .into_iter()
        .skip(cursor)
        .take(limit)
        .collect::<Vec<_>>();
    let next = cursor + page.len();
    json!({
        "items": page,
        "hasMore": next < total,
        "nextCursor": if next < total { Some(next.to_string()) } else { None }
    })
}

fn create_issue(
    state: &mut MockState,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let raw_attachments = body
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        return Err("Issue title is required".to_string());
    }
    let body_text = body
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let tag_identities = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let goal_id = body
        .get("goalId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let goal_path_label = match goal_id.as_deref() {
        Some(goal_id) => {
            let goal = state
                .goals
                .iter()
                .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
                .ok_or_else(|| format!("Goal not found: {}", goal_id))?;
            if is_archived(goal) {
                return Err("Goal is archived".to_string());
            }
            goal_label(state, goal_id)
        }
        None => None,
    };
    let id = state.next_id("iss");
    let number = next_issue_number(state);
    let user_id = state
        .user
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(MOCK_OWNER_USER_ID);
    let user_name = state
        .user
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Ethan");
    let user_avatar = state.user.get("avatarUrl").cloned().unwrap_or(Value::Null);
    let (creator_id, creator_type, creator_name, creator_avatar) = if request_actor.authenticated {
        (
            request_actor.actor_id.as_str(),
            request_actor.actor_type.as_str(),
            request_actor.actor_name.as_str(),
            if request_actor.actor_type == "user" {
                user_avatar.clone()
            } else {
                Value::Null
            },
        )
    } else {
        (user_id, "user", user_name, user_avatar.clone())
    };
    let assignee = match body.get("assignee").filter(|value| !value.is_null()) {
        None => Value::Null,
        Some(requested) => {
            let assignee_type = requested
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| "assignee.type is required".to_string())?;
            let assignee_id = requested
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "assignee.id is required".to_string())?;
            match assignee_type {
                "registered_agent" => {
                    if body
                        .get("humanOnly")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        return Err("humanOnly Issues cannot be assigned to an Agent".to_string());
                    }
                    let agent = state
                        .agents
                        .iter()
                        .find(|agent| agent.id == assignee_id && agent.status == "active")
                        .ok_or_else(|| {
                            format!("Registered Agent not found or inactive: {}", assignee_id)
                        })?;
                    json!({
                        "type": "registered_agent",
                        "id": assignee_id,
                        "name": agent.display_name
                    })
                }
                "user" if assignee_id == user_id => json!({
                    "type": "user",
                    "id": assignee_id,
                    "name": user_name
                }),
                "user" => return Err(format!("Space member not found: {}", assignee_id)),
                other => return Err(format!("Unsupported assignee type: {}", other)),
            }
        }
    };
    let mut issue = json!({
        "id": id,
        "number": number,
        "spaceId": MOCK_SPACE_ID,
        "goalId": goal_id,
        "parentIssueId": body.get("parentIssueId").and_then(Value::as_str),
        "title": title,
        "body": body_text,
        "state": "open",
        "humanOnly": body.get("humanOnly").and_then(Value::as_bool).unwrap_or(false),
        "status": "open",
        "creator": { "id": creator_id, "type": creator_type, "name": creator_name, "avatarUrl": creator_avatar.clone() },
        "author": { "id": creator_id, "type": creator_type, "name": creator_name, "avatarUrl": creator_avatar },
        "assignee": assignee,
        "notificationVersion": 1,
        "goalPathLabel": goal_path_label,
        "tags": tags_for(&state.tags, &tag_identities),
        "commentCount": 0,
        "attachmentCount": 0,
        "createdAt": "2026-06-24T09:38:00.000Z",
        "updatedAt": "2026-06-24T09:38:00.000Z"
    });
    let issue_attachments = materialize_mock_attachment_metadata(state, &raw_attachments);
    issue["attachmentCount"] = json!(issue_attachments.len());
    state.comments.insert(id.clone(), Vec::new());
    state.attachments.insert(id, issue_attachments.clone());
    state.issues.insert(0, issue.clone());
    route_mock_issue_deliveries(state, &issue, "issue.created", None)?;
    Ok(json!({ "issue": issue, "attachments": issue_attachments }))
}

fn mock_assignee_candidates(state: &MockState, actor: &MockActor) -> Value {
    let mut agents = state
        .agents
        .iter()
        .filter(|agent| agent.status == "active")
        .map(|agent| {
            json!({
                "assigneeId": format!("agent:{}", agent.id),
                "type": "registered_agent",
                "name": agent.display_name,
                "avatarUrl": agent.avatar_url,
                "isSelf": actor.actor_type == "registered_agent" && actor.actor_id == agent.id,
                "owner": { "id": MOCK_OWNER_USER_ID, "name": state.user.get("name").cloned().unwrap_or(Value::Null) }
            })
        })
        .collect::<Vec<_>>();
    agents.sort_by_key(|item| !item.get("isSelf").and_then(Value::as_bool).unwrap_or(false));
    agents.push(json!({
        "assigneeId": format!("user:{}", MOCK_OWNER_USER_ID),
        "type": "user",
        "name": state.user.get("name").cloned().unwrap_or(Value::Null),
        "avatarUrl": state.user.get("avatarUrl").cloned().unwrap_or(Value::Null),
        "isSelf": actor.actor_type == "user" && actor.actor_id == MOCK_OWNER_USER_ID,
        "role": "owner"
    }));
    json!({ "items": agents })
}

fn list_events(state: &MockState, query: &HashMap<String, String>) -> Value {
    let cursor = query.get("cursor").map(String::as_str);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(50)
        .min(100);
    let filtered = state
        .events
        .iter()
        .filter(|event| event_after_cursor(event, cursor))
        .take(limit + 1)
        .cloned()
        .collect::<Vec<_>>();
    let items = filtered.iter().take(limit).cloned().collect::<Vec<_>>();
    let next_cursor = items
        .last()
        .and_then(encode_event_cursor)
        .map(Value::String)
        .unwrap_or(Value::Null);
    json!({
        "items": items,
        "hasMore": filtered.len() > limit,
        "nextCursor": next_cursor
    })
}

fn event_after_cursor(event: &Value, cursor: Option<&str>) -> bool {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let (cursor_created_at, cursor_id) = cursor
        .rsplit_once('|')
        .filter(|(created_at, event_id)| !created_at.is_empty() && !event_id.is_empty())
        .map(|(created_at, event_id)| (created_at, Some(event_id)))
        .unwrap_or((cursor, None));
    let Some(created_at) = event.get("createdAt").and_then(Value::as_str) else {
        return false;
    };
    if created_at > cursor_created_at {
        return true;
    }
    if created_at < cursor_created_at {
        return false;
    }
    match cursor_id {
        Some(cursor_id) => event
            .get("id")
            .and_then(Value::as_str)
            .map(|event_id| event_id > cursor_id)
            .unwrap_or(false),
        None => false,
    }
}

fn encode_event_cursor(event: &Value) -> Option<String> {
    Some(format!(
        "{}|{}",
        event.get("createdAt")?.as_str()?,
        event.get("id")?.as_str()?
    ))
}

fn create_tag(state: &mut MockState, body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err("Tag name is required".to_string());
    }
    let tag = json!({
        "id": state.next_id("tag"),
        "spaceId": MOCK_SPACE_ID,
        "name": name,
        "color": body.get("color").cloned().unwrap_or(Value::Null),
        "description": body.get("description").cloned().unwrap_or(Value::Null),
        "createdAt": "2026-06-24T09:37:00.000Z",
        "updatedAt": "2026-06-24T09:37:00.000Z"
    });
    state.tags.push(tag.clone());
    state.tags.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "tag": tag }))
}

fn list_goals(state: &MockState, query: &HashMap<String, String>) -> Value {
    let include_archived = query
        .get("includeArchived")
        .map(|value| value == "true")
        .unwrap_or(false);
    let mut items = state
        .goals
        .iter()
        .filter(|goal| include_archived || !is_archived(goal))
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        let depth = a
            .get("depth")
            .and_then(Value::as_u64)
            .cmp(&b.get("depth").and_then(Value::as_u64));
        if depth != std::cmp::Ordering::Equal {
            return depth;
        }
        a.get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("createdAt").and_then(Value::as_str).unwrap_or(""))
    });
    json!({ "items": items })
}

fn active_goals(state: &MockState) -> Vec<Value> {
    state
        .goals
        .iter()
        .filter(|goal| !is_archived(goal))
        .cloned()
        .collect()
}

fn create_goal(state: &mut MockState, body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let parent_goal_id = body
        .get("parentGoalId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "parentGoalId is required".to_string())?;
    let parent = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(parent_goal_id))
        .cloned()
        .ok_or_else(|| format!("Goal not found: {}", parent_goal_id))?;
    if is_archived(&parent) {
        return Err("Goal is archived".to_string());
    }
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "title is required".to_string())?;
    let context = body
        .get("context")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "context is required".to_string())?;
    let id = state.next_id("goal");
    let parent_path = parent
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("/")
        .to_string();
    let depth = parent.get("depth").and_then(Value::as_u64).unwrap_or(0) + 1;
    let goal = json!({
        "id": id,
        "spaceId": MOCK_SPACE_ID,
        "parentGoalId": parent_goal_id,
        "path": format!("{}{}/", parent_path, id),
        "depth": depth,
        "title": title,
        "context": context,
        "archivedAt": null,
        "createdAt": "2026-06-24T09:52:00.000Z",
        "updatedAt": "2026-06-24T09:52:00.000Z",
        "goalPathLabel": title
    });
    state.goals.push(goal);
    refresh_goal_labels(state);
    let created = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "goal": created }))
}

fn update_goal(state: &mut MockState, goal_id: &str, body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let index = state
        .goals
        .iter()
        .position(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
        .ok_or_else(|| format!("Goal not found: {}", goal_id))?;
    if is_archived(&state.goals[index]) {
        return Err("Goal is archived".to_string());
    }
    if let Some(goal) = state.goals[index].as_object_mut() {
        if let Some(title) = body.get("title").and_then(Value::as_str).map(str::trim) {
            if title.is_empty() {
                return Err("title is required".to_string());
            }
            goal.insert("title".to_string(), json!(title));
        }
        if let Some(context) = body.get("context").and_then(Value::as_str).map(str::trim) {
            if context.is_empty() {
                return Err("context is required".to_string());
            }
            goal.insert("context".to_string(), json!(context));
        }
        goal.insert("updatedAt".to_string(), json!("2026-06-24T09:53:00.000Z"));
    }
    refresh_goal_labels(state);
    let updated = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "goal": updated }))
}

fn archive_goal(state: &mut MockState, goal_id: &str) -> Result<Value, String> {
    let goal = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
        .cloned()
        .ok_or_else(|| format!("Goal not found: {}", goal_id))?;
    if goal.get("parentGoalId").and_then(Value::as_str).is_none() || goal_id == MOCK_ROOT_GOAL_ID {
        return Err("Root Goal cannot be archived".to_string());
    }
    let goal_path = goal
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let archived_ids = state
        .goals
        .iter()
        .filter(|item| {
            item.get("path")
                .and_then(Value::as_str)
                .map(|path| path.starts_with(&goal_path))
                .unwrap_or(false)
        })
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<HashSet<_>>();
    let has_active_claim = state.issues.iter().any(|issue| {
        let issue_id = issue.get("id").and_then(Value::as_str).unwrap_or("");
        issue
            .get("goalId")
            .and_then(Value::as_str)
            .map(|id| archived_ids.contains(id) && state.claims.contains_key(issue_id))
            .unwrap_or(false)
    });
    if has_active_claim {
        return Err("Goal has active issue claims".to_string());
    }
    for item in &mut state.goals {
        if item
            .get("id")
            .and_then(Value::as_str)
            .map(|id| archived_ids.contains(id))
            .unwrap_or(false)
        {
            if let Some(goal) = item.as_object_mut() {
                goal.insert("archivedAt".to_string(), json!("2026-06-24T09:54:00.000Z"));
                goal.insert("updatedAt".to_string(), json!("2026-06-24T09:54:00.000Z"));
            }
        }
    }
    for issue in &mut state.issues {
        if issue
            .get("goalId")
            .and_then(Value::as_str)
            .map(|id| archived_ids.contains(id))
            .unwrap_or(false)
        {
            if let Some(issue) = issue.as_object_mut() {
                issue.insert("state".to_string(), json!("closed"));
                issue.insert("status".to_string(), json!("closed"));
                issue.insert("archivedAt".to_string(), json!("2026-06-24T09:54:00.000Z"));
                issue.insert("updatedAt".to_string(), json!("2026-06-24T09:54:00.000Z"));
            }
        }
    }
    Ok(json!({
        "archived": true,
        "archivedAt": "2026-06-24T09:54:00.000Z"
    }))
}

fn issue_detail(
    state: &MockState,
    issue_id: &str,
    query: &HashMap<String, String>,
) -> Result<Value, String> {
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let limit = query
        .get("commentsLimit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .clamp(1, 20);
    let all_comments = state.comments.get(issue_id).cloned().unwrap_or_default();
    let before = query
        .get("commentsCursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(all_comments.len())
        .min(all_comments.len());
    let goal_reference = issue
        .get("goalId")
        .and_then(Value::as_str)
        .and_then(|goal_id| {
            state.goals.iter().find_map(|goal| {
                if goal.get("id").and_then(Value::as_str) != Some(goal_id) {
                    return None;
                }
                Some(json!({
                    "goalId": goal_id,
                    "goalPath": goal.get("path").cloned().unwrap_or(Value::Null),
                    "goalPathLabel": goal.get("goalPathLabel").cloned().unwrap_or(Value::Null),
                    "goalTitle": goal.get("title").cloned().unwrap_or(Value::Null),
                    "goalContext": goal.get("context").cloned().unwrap_or(Value::Null),
                }))
            })
        });
    let start = before.saturating_sub(limit);
    let page = all_comments[start..before].to_vec();
    Ok(json!({
        "issue": issue_with_claim(state, issue),
        "goalReference": goal_reference,
        "comments": {
            "items": page,
            "hasMore": start > 0,
            "hasMoreOlder": start > 0,
            "nextCursor": if start > 0 { Some(start.to_string()) } else { None },
            "limit": limit
        },
        "attachments": state.attachments.get(issue_id).cloned().unwrap_or_default(),
        "claim": state.claims.get(issue_id).cloned().unwrap_or(Value::Null)
    }))
}

fn issue_comments_page(
    state: &MockState,
    issue_id: &str,
    query: &HashMap<String, String>,
) -> Result<Value, String> {
    if find_issue_index(&state.issues, issue_id).is_none() {
        return Err(format!("Issue not found: {}", issue_id));
    }
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let all_comments = state.comments.get(issue_id).cloned().unwrap_or_default();
    let before = query
        .get("cursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(all_comments.len())
        .min(all_comments.len());
    let start = before.saturating_sub(limit);
    let items = all_comments[start..before].to_vec();
    Ok(json!({
        "items": items,
        "hasMore": start > 0,
        "hasMoreOlder": start > 0,
        "nextCursor": if start > 0 { Some(start.to_string()) } else { None },
        "limit": limit,
        "order": "oldest_first"
    }))
}

fn update_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let Some(index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    if body
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|title| title.trim().is_empty())
    {
        return Err("title is required".to_string());
    }
    if body
        .get("body")
        .and_then(Value::as_str)
        .is_some_and(|issue_body| issue_body.trim().is_empty())
    {
        return Err("body is required".to_string());
    }
    let goal_update = match body.get("goalId") {
        None => None,
        Some(Value::Null) => Some((Value::Null, Value::Null)),
        Some(Value::String(goal_id)) => {
            let goal_id = goal_id.trim();
            let goal = state
                .goals
                .iter()
                .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
                .ok_or_else(|| "GOAL_NOT_FOUND: Goal not found".to_string())?;
            if is_archived(goal) {
                return Err("GOAL_IS_ARCHIVED: Goal is archived".to_string());
            }
            Some((
                Value::String(goal_id.to_string()),
                goal.get("goalPathLabel").cloned().unwrap_or(Value::Null),
            ))
        }
        Some(_) => {
            return Err("GOAL_ID_INVALID: goalId must be a non-empty string or null".to_string())
        }
    };
    if body.get("humanOnly").and_then(Value::as_bool) == Some(true)
        && state.issues[index]
            .pointer("/assignee/type")
            .and_then(Value::as_str)
            == Some("registered_agent")
    {
        return Err(
            "An Issue assigned to a Registered Agent cannot become human-only; reassign or cancel first"
                .to_string(),
        );
    }
    cancel_pending_issue_deliveries(state, issue_id);
    if let Some(issue) = state.issues[index].as_object_mut() {
        if let Some(title) = body.get("title").and_then(Value::as_str).map(str::trim) {
            issue.insert("title".to_string(), json!(title));
        }
        if let Some(issue_body) = body.get("body").and_then(Value::as_str).map(str::trim) {
            issue.insert("body".to_string(), json!(issue_body));
        }
        if let Some((goal_id, goal_path_label)) = goal_update {
            issue.insert("goalId".to_string(), goal_id);
            issue.insert("goalPathLabel".to_string(), goal_path_label);
        }
        if let Some(human_only) = body.get("humanOnly").and_then(Value::as_bool) {
            issue.insert("humanOnly".to_string(), Value::Bool(human_only));
        }
        issue.insert("updatedAt".to_string(), json!("2026-06-24T09:55:00.000Z"));
    }
    increment_issue_notification_version(state, issue_id);
    let updated = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .unwrap_or(Value::Null);
    route_mock_issue_deliveries(
        state,
        &updated,
        "issue.updated",
        registered_agent_actor_id(request_actor),
    )?;
    Ok(json!({ "issue": issue_with_claim(state, updated) }))
}

fn set_issue_assignee(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let requested = body
        .as_ref()
        .and_then(|value| value.get("assignee"))
        .ok_or_else(|| "assignee is required".to_string())?;
    let assignee_type = requested
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "assignee.type is required".to_string())?;
    let assignee_id = requested
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "assignee.id is required".to_string())?;
    let name = match assignee_type {
        "registered_agent" => {
            if state
                .issues
                .iter()
                .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
                .and_then(|issue| issue.get("humanOnly"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err("humanOnly Issues cannot be assigned to an Agent".to_string());
            }
            state
                .agents
                .iter()
                .find(|agent| agent.id == assignee_id && agent.status == "active")
                .map(|agent| agent.display_name.clone())
                .ok_or_else(|| format!("Registered Agent not found or inactive: {}", assignee_id))?
        }
        "user" if assignee_id == MOCK_OWNER_USER_ID => state
            .user
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Mock member")
            .to_string(),
        "user" => return Err(format!("Space member not found: {}", assignee_id)),
        other => return Err(format!("Unsupported assignee type: {}", other)),
    };
    let Some(index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    if state.issues[index]
        .pointer("/assignee/type")
        .and_then(Value::as_str)
        == Some(assignee_type)
        && state.issues[index]
            .pointer("/assignee/id")
            .and_then(Value::as_str)
            == Some(assignee_id)
    {
        return Ok(json!({
            "issue": issue_with_claim(state, state.issues[index].clone()),
            "idempotent": true
        }));
    }
    cancel_pending_issue_deliveries(state, issue_id);
    state.claims.remove(issue_id);
    increment_issue_notification_version(state, issue_id);
    let updated = {
        let issue = state.issues[index]
            .as_object_mut()
            .ok_or_else(|| "Invalid mock Issue".to_string())?;
        issue.insert(
            "assignee".to_string(),
            json!({ "type": assignee_type, "id": assignee_id, "name": name }),
        );
        issue.insert("assignedAt".to_string(), json!("2026-07-12T10:00:00.000Z"));
        Value::Object(issue.clone())
    };
    route_mock_issue_deliveries(state, &updated, "issue.assigned", None)?;
    Ok(json!({ "issue": updated }))
}

fn cancel_issue_assignee(state: &mut MockState, issue_id: &str) -> Result<Value, String> {
    let Some(index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    if state.issues[index]
        .get("assignee")
        .is_none_or(Value::is_null)
    {
        return Ok(json!({
            "issue": issue_with_claim(state, state.issues[index].clone()),
            "idempotent": true
        }));
    }
    cancel_pending_issue_deliveries(state, issue_id);
    state.claims.remove(issue_id);
    increment_issue_notification_version(state, issue_id);
    let updated = {
        let issue = state.issues[index]
            .as_object_mut()
            .ok_or_else(|| "Invalid mock Issue".to_string())?;
        issue.insert("assignee".to_string(), Value::Null);
        issue.insert("assignedAt".to_string(), Value::Null);
        issue.insert("state".to_string(), json!("todo"));
        issue.insert("status".to_string(), json!("todo"));
        Value::Object(issue.clone())
    };
    route_mock_issue_deliveries(state, &updated, "issue.assignee_cancelled", None)?;
    Ok(json!({ "issue": updated }))
}

fn comment_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    if find_issue_index(&state.issues, issue_id).is_none() {
        return Err(format!("Issue not found: {}", issue_id));
    }
    let text = body
        .as_ref()
        .and_then(|value| value.get("body"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let raw_attachments = body
        .as_ref()
        .and_then(|value| value.get("attachments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if text.is_empty() && raw_attachments.is_empty() {
        return Err("Comment text or at least one attachment is required".to_string());
    }
    let comment_attachments = materialize_mock_attachment_metadata(state, &raw_attachments);
    let override_author_type = body
        .as_ref()
        .and_then(|value| value.get("authorType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let override_author_id = body
        .as_ref()
        .and_then(|value| value.get("authorId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (author_type, author_id, author_name) = if request_actor.authenticated
        || override_author_type.is_none()
        || override_author_id.is_none()
    {
        (
            request_actor.actor_type.as_str(),
            request_actor.actor_id.as_str(),
            request_actor.actor_name.as_str(),
        )
    } else {
        (
            override_author_type.unwrap_or("user"),
            override_author_id.unwrap_or("usr_mock_owner"),
            "Mock API",
        )
    };
    let author_avatar = if author_type == "user" && author_id == MOCK_OWNER_USER_ID {
        state.user.get("avatarUrl").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let comment = json!({
        "id": state.next_id("cmt"),
        "author": { "id": author_id, "type": author_type, "name": author_name, "avatarUrl": author_avatar },
        "body": text,
        "attachments": comment_attachments,
        "createdAt": "2026-06-24T09:39:00.000Z"
    });
    state
        .comments
        .entry(issue_id.to_string())
        .or_default()
        .push(comment.clone());
    cancel_pending_issue_deliveries(state, issue_id);
    increment_issue_notification_version(state, issue_id);
    refresh_issue_counts(state, issue_id);
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let first_new_delivery = state.deliveries.len();
    route_mock_issue_deliveries(
        state,
        &issue,
        "issue.commented",
        registered_agent_actor_id(request_actor),
    )?;
    for item in state.deliveries.iter_mut().skip(first_new_delivery) {
        if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
            delivery.insert(
                "updateSummary".to_string(),
                json!(match delivery.get("deliveryKind").and_then(Value::as_str) {
                    Some("claim_followup") => "New comment on claimed Issue",
                    Some("assignment") => "New comment on assigned Issue",
                    _ => "New comment on subscribed Issue",
                }),
            );
            delivery.insert(
                "trigger".to_string(),
                json!({
                    "updateId": format!("update_{}", comment["id"].as_str().unwrap_or("comment")),
                    "type": "issue.commented",
                    "actor": { "type": author_type, "id": author_id, "name": author_name },
                    "comment": {
                        "id": comment["id"],
                        "body": text,
                        "attachments": comment["attachments"],
                        "createdAt": comment["createdAt"]
                    },
                    "createdAt": comment["createdAt"]
                }),
            );
        }
    }
    Ok(json!({ "comment": comment }))
}

fn get_issue_comment(state: &MockState, issue_id: &str, comment_id: &str) -> Result<Value, String> {
    let comment = state
        .comments
        .get(issue_id)
        .and_then(|comments| {
            comments
                .iter()
                .find(|comment| comment.get("id").and_then(Value::as_str) == Some(comment_id))
        })
        .cloned()
        .ok_or_else(|| format!("Comment not found: {}", comment_id))?;
    Ok(json!({ "comment": comment }))
}

fn complete_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let operation_key = body
        .as_ref()
        .and_then(|value| value.get("operationKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if let Some(existing) = operation_key
        .as_ref()
        .and_then(|key| state.complete_operations.get(key))
    {
        if existing.get("issueId").and_then(Value::as_str) != Some(issue_id) {
            return Err("operationKey was already used for another Issue".to_string());
        }
        let mut result = existing
            .get("response")
            .cloned()
            .ok_or_else(|| "Invalid mock completion operation".to_string())?;
        if let Some(object) = result.as_object_mut() {
            object.insert("idempotent".to_string(), json!(true));
        }
        return Ok(result);
    }
    if state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .and_then(|issue| issue.get("state"))
        .and_then(Value::as_str)
        == Some("done")
    {
        return Ok(json!({
            "state": "done",
            "updatedAt": "2026-06-24T09:40:00.000Z",
            "commentId": null,
            "idempotent": true,
        }));
    }
    let result_comment = body
        .as_ref()
        .and_then(|value| value.get("resultComment"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let raw_attachments = body
        .as_ref()
        .and_then(|value| value.get("attachments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result_attachments = materialize_mock_attachment_metadata(state, &raw_attachments);
    let comment_id = if result_comment.is_some() || !result_attachments.is_empty() {
        let comment_id = state.next_id("cmt");
        let comment = json!({
            "id": comment_id,
            "author": {
                "id": request_actor.actor_id,
                "type": request_actor.actor_type,
                "name": request_actor.actor_name,
                "avatarUrl": null
            },
            "body": result_comment.unwrap_or_default(),
            "attachments": result_attachments,
            "createdAt": "2026-06-24T09:40:00.000Z"
        });
        state
            .comments
            .entry(issue_id.to_string())
            .or_default()
            .push(comment);
        Some(Value::String(comment_id))
    } else {
        None
    };
    cancel_pending_issue_deliveries(state, issue_id);
    set_issue_status_value(state, issue_id, "done")?;
    increment_issue_notification_version(state, issue_id);
    refresh_issue_counts(state, issue_id);
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    route_mock_issue_deliveries(
        state,
        &issue,
        "issue.completed",
        registered_agent_actor_id(request_actor),
    )?;
    state.claims.remove(issue_id);
    let response = json!({
        "state": "done",
        "updatedAt": "2026-06-24T09:40:00.000Z",
        "commentId": comment_id,
        "idempotent": false,
    });
    if let Some(operation_key) = operation_key {
        state.complete_operations.insert(
            operation_key,
            json!({ "issueId": issue_id, "response": response }),
        );
    }
    Ok(response)
}

fn set_issue_status(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let status = body
        .as_ref()
        .and_then(|value| value.get("state").or_else(|| value.get("status")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "state is required".to_string())?;
    transition_issue_state(
        state,
        issue_id,
        status,
        "issue.state_changed",
        request_actor,
    )
}

fn transition_issue_state(
    state: &mut MockState,
    issue_id: &str,
    status: &str,
    trigger_type: &str,
    request_actor: &MockActor,
) -> Result<Value, String> {
    cancel_pending_issue_deliveries(state, issue_id);
    let result = set_issue_status_value(state, issue_id, status)?;
    increment_issue_notification_version(state, issue_id);
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    route_mock_issue_deliveries(
        state,
        &issue,
        trigger_type,
        registered_agent_actor_id(request_actor),
    )?;
    if matches!(status, "done" | "closed") {
        state.claims.remove(issue_id);
    }
    Ok(result)
}

fn set_issue_status_value(
    state: &mut MockState,
    issue_id: &str,
    status: &str,
) -> Result<Value, String> {
    let Some(index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    if let Some(issue) = state.issues[index].as_object_mut() {
        issue.insert("status".to_string(), json!(status));
        issue.insert("state".to_string(), json!(status));
        issue.insert("updatedAt".to_string(), json!("2026-06-24T09:40:00.000Z"));
    }
    Ok(json!({ "state": status, "status": status, "updatedAt": "2026-06-24T09:40:00.000Z" }))
}

fn claim_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let Some(issue_index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    let delivery_id = body
        .as_ref()
        .and_then(|value| value.get("deliveryId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let (actor_type, actor_id, actor_name) =
        if request_actor.authenticated && request_actor.actor_type == "registered_agent" {
            if let Some(delivery_id) = delivery_id {
                let delivery = state
                    .deliveries
                    .iter()
                    .find(|item| {
                        item.pointer("/delivery/id").and_then(Value::as_str) == Some(delivery_id)
                    })
                    .ok_or_else(|| format!("Delivery not found: {}", delivery_id))?;
                let delivery_issue_id = delivery
                    .pointer("/delivery/issueId")
                    .and_then(Value::as_str);
                if delivery_issue_id != Some(issue_id) {
                    return Err(format!(
                        "Delivery {} does not belong to issue {}",
                        delivery_id, issue_id
                    ));
                }
                let delivery_agent_id = delivery
                    .pointer("/delivery/registeredAgentId")
                    .and_then(Value::as_str);
                if delivery_agent_id != Some(request_actor.actor_id.as_str()) {
                    return Err(format!(
                        "Delivery {} does not belong to Registered Agent {}",
                        delivery_id, request_actor.actor_id
                    ));
                }
            }
            (
                "registered_agent",
                request_actor.actor_id.clone(),
                request_actor.actor_name.clone(),
            )
        } else {
            ("user", "usr_mock_owner".to_string(), "Ethan".to_string())
        };

    if state.issues[issue_index]
        .get("humanOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && actor_type == "registered_agent"
    {
        return Err("Human-only Issues cannot be claimed by Agents".to_string());
    }
    if matches!(
        state.issues[issue_index]
            .get("state")
            .and_then(Value::as_str),
        Some("done" | "closed")
    ) {
        return Err("Completed or closed Issues cannot be claimed".to_string());
    }
    if actor_type == "registered_agent" {
        let agent = state
            .agents
            .iter()
            .find(|agent| agent.id == actor_id)
            .ok_or_else(|| format!("Registered Agent not found: {}", actor_id))?;
        let assignee = state.issues[issue_index]
            .get("assignee")
            .filter(|value| !value.is_null());
        let can_claim = match assignee {
            Some(assignee) => {
                assignee.get("type").and_then(Value::as_str) == Some("registered_agent")
                    && assignee.get("id").and_then(Value::as_str) == Some(actor_id.as_str())
            }
            None => mock_agent_can_read_issue(state, agent, &state.issues[issue_index]),
        };
        if !can_claim {
            return Err("This Registered Agent cannot claim this Issue".to_string());
        }
    }

    if let Some(existing) = state.claims.get(issue_id) {
        if existing.get("actorType").and_then(Value::as_str) == Some(actor_type)
            && existing.get("actorId").and_then(Value::as_str) == Some(actor_id.as_str())
        {
            let notification_version = existing
                .get("notificationVersion")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| {
                    state.issues[issue_index]
                        .get("notificationVersion")
                        .and_then(Value::as_i64)
                        .unwrap_or(1)
                });
            return Ok(json!({
                "claim": existing,
                "assigneeCreated": false,
                "notificationVersion": notification_version,
                "idempotent": true
            }));
        }
        return Err("Issue already has a different claim handler".to_string());
    }

    let assignee = state.issues[issue_index]
        .get("assignee")
        .filter(|value| !value.is_null())
        .cloned();
    let (origin, assignee_created) = match assignee {
        None => {
            let issue = state.issues[issue_index]
                .as_object_mut()
                .ok_or_else(|| "Invalid mock Issue".to_string())?;
            issue.insert(
                "assignee".to_string(),
                json!({ "type": actor_type, "id": actor_id, "name": actor_name }),
            );
            issue.insert("assignedAt".to_string(), json!("2026-06-24T09:47:00.000Z"));
            ("self_claim", true)
        }
        Some(current)
            if current.get("type").and_then(Value::as_str) == Some(actor_type)
                && current.get("id").and_then(Value::as_str) == Some(actor_id.as_str()) =>
        {
            ("assignment_confirmation", false)
        }
        Some(_) => return Err("Issue is assigned to another handler".to_string()),
    };
    cancel_pending_issue_deliveries(state, issue_id);
    increment_issue_notification_version(state, issue_id);
    let claim_id = state.next_id("claim");
    let notification_version = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .and_then(|issue| issue.get("notificationVersion"))
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let claim = json!({
            "id": claim_id,
            "spaceId": MOCK_SPACE_ID,
            "issueId": issue_id,
            "actorType": actor_type,
            "actorId": actor_id,
            "actorName": actor_name,
            "localTaskId": null,
            "localSessionId": null,
            "origin": origin,
            "notificationVersion": notification_version,
            "claimedAt": "2026-06-24T09:47:00.000Z",
            "updatedAt": "2026-06-24T09:47:00.000Z"
    });
    state.claims.insert(issue_id.to_string(), claim.clone());
    if let Some(delivery_id) = delivery_id {
        if let Some(item) = state
            .deliveries
            .iter_mut()
            .find(|item| item.pointer("/delivery/id").and_then(Value::as_str) == Some(delivery_id))
        {
            if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
                delivery.insert("status".to_string(), json!("claimed"));
                delivery.insert("claimId".to_string(), json!(claim_id));
            }
        }
    }
    Ok(json!({
        "claim": claim,
        "assigneeCreated": assignee_created,
        "notificationVersion": notification_version,
        "idempotent": false
    }))
}

fn cancel_issue_claim(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let claim = state
        .claims
        .get(issue_id)
        .cloned()
        .ok_or_else(|| "Active claim not found".to_string())?;
    let origin = claim
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("self_claim");
    let clears_assignment = origin == "self_claim";
    if let Some(request_agent_id) = registered_agent_actor_id(request_actor) {
        if claim.get("actorType").and_then(Value::as_str) != Some("registered_agent")
            || claim.get("actorId").and_then(Value::as_str) != Some(request_agent_id)
        {
            return Err("Only the claim actor can cancel this Agent claim".to_string());
        }
        if body
            .as_ref()
            .and_then(|value| value.get("rollback"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(
                "Registered Agents can only cancel a claim as a local setup rollback".to_string(),
            );
        }
    }
    if clears_assignment {
        let Some(issue_index) = find_issue_index(&state.issues, issue_id) else {
            return Err(format!("Issue not found: {}", issue_id));
        };
        if registered_agent_actor_id(request_actor).is_some() {
            let expected_version = body
                .as_ref()
                .and_then(|value| value.get("expectedNotificationVersion"))
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    "expectedNotificationVersion is required for claim rollback".to_string()
                })?;
            let issue_version = state.issues[issue_index]
                .get("notificationVersion")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let claim_version = claim
                .get("notificationVersion")
                .and_then(Value::as_i64)
                .unwrap_or(issue_version);
            let claim_actor_id = claim.get("actorId").and_then(Value::as_str);
            let assignee_type = state.issues[issue_index]
                .pointer("/assignee/type")
                .and_then(Value::as_str);
            let assignee_id = state.issues[issue_index]
                .pointer("/assignee/id")
                .and_then(Value::as_str);
            if expected_version != claim_version
                || expected_version != issue_version
                || assignee_type != Some("registered_agent")
                || assignee_id != claim_actor_id
                || assignee_id != registered_agent_actor_id(request_actor)
            {
                return Err(
                    "Issue responsibility changed after this claim; rollback rejected".to_string(),
                );
            }
        }
        cancel_pending_issue_deliveries(state, issue_id);
        increment_issue_notification_version(state, issue_id);
        let issue = state.issues[issue_index]
            .as_object_mut()
            .ok_or_else(|| "Invalid mock Issue".to_string())?;
        issue.insert("assignee".to_string(), Value::Null);
        issue.insert("assignedAt".to_string(), Value::Null);
        issue.insert("state".to_string(), json!("todo"));
        issue.insert("status".to_string(), json!("todo"));
    }
    state.claims.remove(issue_id);
    if clears_assignment {
        let issue = state
            .issues
            .iter()
            .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
            .cloned()
            .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
        route_mock_issue_deliveries(
            state,
            &issue,
            "issue.claim.cancelled",
            registered_agent_actor_id(request_actor),
        )?;
    }
    Ok(json!({
        "state": if clears_assignment { "todo" } else {
            state.issues
                .iter()
                .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
                .and_then(|issue| issue.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("todo")
        },
        "assigneeCleared": clears_assignment,
        "updatedAt": "2026-07-12T10:02:00.000Z"
    }))
}

fn claim_local_task(
    state: &mut MockState,
    claim_id: &str,
    body: Option<Value>,
    request_actor: &MockActor,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let local_task_id = body
        .get("localTaskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "localTaskId is required".to_string())?;
    let local_session_id = body
        .get("localSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "localSessionId is required".to_string())?;
    for claim in state.claims.values_mut() {
        if claim.get("id").and_then(Value::as_str) != Some(claim_id) {
            continue;
        }
        if request_actor.authenticated && request_actor.actor_type == "registered_agent" {
            let claim_actor_type = claim.get("actorType").and_then(Value::as_str);
            let claim_actor_id = claim.get("actorId").and_then(Value::as_str);
            if claim_actor_type != Some("registered_agent")
                || claim_actor_id != Some(request_actor.actor_id.as_str())
            {
                return Err(format!(
                    "Claim {} does not belong to Registered Agent {}",
                    claim_id, request_actor.actor_id
                ));
            }
        }
        if let Some(object) = claim.as_object_mut() {
            object.insert("localTaskId".to_string(), json!(local_task_id));
            object.insert("localSessionId".to_string(), json!(local_session_id));
            object.insert("updatedAt".to_string(), json!("2026-06-24T09:49:00.000Z"));
        }
        return Ok(json!({
            "updated": true,
            "localTaskId": local_task_id,
            "localSessionId": local_session_id,
            "updatedAt": "2026-06-24T09:49:00.000Z"
        }));
    }
    Err(format!("Claim not found: {}", claim_id))
}

fn cancel_pending_issue_deliveries(state: &mut MockState, issue_id: &str) {
    for item in &mut state.deliveries {
        if item.pointer("/delivery/issueId").and_then(Value::as_str) != Some(issue_id)
            || item.pointer("/delivery/status").and_then(Value::as_str) != Some("pending")
        {
            continue;
        }
        if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
            delivery.insert("status".to_string(), json!("cancelled"));
            delivery.insert("updatedAt".to_string(), json!("2026-07-12T10:01:00.000Z"));
        }
    }
}

fn route_mock_issue_deliveries(
    state: &mut MockState,
    issue: &Value,
    trigger_type: &str,
    excluded_registered_agent_id: Option<&str>,
) -> Result<(), String> {
    let _issue_id = issue
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid mock Issue id".to_string())?;
    if issue
        .get("humanOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let assignee = issue.get("assignee").filter(|value| !value.is_null());
    if let Some(assignee) = assignee {
        if assignee.get("type").and_then(Value::as_str) != Some("registered_agent") {
            return Ok(());
        }
        let agent_id = assignee
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid mock Agent assignee".to_string())?;
        if excluded_registered_agent_id == Some(agent_id) {
            return Ok(());
        }
        let Some(agent) = state.agents.iter().find(|agent| agent.id == agent_id) else {
            return Err(format!("Registered Agent not found: {}", agent_id));
        };
        if agent.status != "active" {
            return Ok(());
        }
        let agent = agent.clone();
        let delivery_id = state.next_id("del");
        let mut item = delivery_item(&delivery_id, &agent, issue, "pending");
        let active_claim = state.claims.get(_issue_id).filter(|claim| {
            claim.get("actorType").and_then(Value::as_str) == Some("registered_agent")
                && claim.get("actorId").and_then(Value::as_str) == Some(agent_id)
        });
        let claim_followup = active_claim.is_some();
        if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
            delivery.insert(
                "deliveryKind".to_string(),
                json!(if claim_followup {
                    "claim_followup"
                } else {
                    "assignment"
                }),
            );
            delivery.insert("subscriptionId".to_string(), Value::Null);
            delivery.insert(
                "updateSummary".to_string(),
                json!(if claim_followup {
                    "Assigned Issue updated"
                } else {
                    "Issue explicitly assigned to this Registered Agent"
                }),
            );
            delivery.insert(
                "cloudInstruction".to_string(),
                if claim_followup {
                    json!({
                        "id": "claim-followup-v1",
                        "text": "This is a follow-up delivery for a Space Issue assigned to this Registered Agent. Read the trigger and continue the existing work."
                    })
                } else {
                    json!({
                        "id": "assignment-v1",
                        "text": "This Space Issue has been explicitly assigned to this Registered Agent. Read the trigger and begin processing the assigned work."
                    })
                },
            );
            if claim_followup {
                delivery.insert(
                    "claimId".to_string(),
                    active_claim
                        .and_then(|claim| claim.get("id"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                delivery.insert(
                    "targetSessionId".to_string(),
                    active_claim
                        .and_then(|claim| claim.get("localSessionId"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
            if let Some(trigger) = delivery.get_mut("trigger").and_then(Value::as_object_mut) {
                trigger.insert("type".to_string(), json!(trigger_type));
            }
        }
        state.deliveries.push(item);
        return Ok(());
    }

    let targets = state
        .agents
        .iter()
        .filter(|agent| {
            mock_agent_can_read_issue(state, agent, issue)
                && excluded_registered_agent_id != Some(agent.id.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    for agent in targets {
        let delivery_id = state.next_id("del");
        let mut item = delivery_item(&delivery_id, &agent, issue, "pending");
        if let Some(trigger) = item
            .pointer_mut("/delivery/trigger")
            .and_then(Value::as_object_mut)
        {
            trigger.insert("type".to_string(), json!(trigger_type));
        }
        state.deliveries.push(item);
    }
    Ok(())
}

fn mock_agent_can_read_issue(
    state: &MockState,
    agent: &LocalRegisteredAgent,
    issue: &Value,
) -> bool {
    if agent.status != "active"
        || issue
            .get("humanOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || is_archived(issue)
    {
        return false;
    }
    if issue.pointer("/assignee/type").and_then(Value::as_str) == Some("registered_agent")
        && issue.pointer("/assignee/id").and_then(Value::as_str) == Some(agent.id.as_str())
    {
        return true;
    }
    let Some(issue_goal_id) = issue.get("goalId").and_then(Value::as_str) else {
        return false;
    };
    let Some(subscription_goal_id) = agent.goal_id.as_deref() else {
        return false;
    };
    let issue_goal_active = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(issue_goal_id))
        .is_some_and(|goal| !is_archived(goal));
    let subscription_goal_active = state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(subscription_goal_id))
        .is_some_and(|goal| !is_archived(goal));
    let issue_state = issue.get("state").and_then(Value::as_str).unwrap_or("todo");
    issue_goal_active
        && subscription_goal_active
        && agent.state_filter.iter().any(|state| state == issue_state)
        && goal_is_in_subtree(state, issue_goal_id, subscription_goal_id)
}

fn registered_agent_actor_id(actor: &MockActor) -> Option<&str> {
    (actor.authenticated && actor.actor_type == "registered_agent")
        .then_some(actor.actor_id.as_str())
}

fn increment_issue_notification_version(state: &mut MockState, issue_id: &str) {
    if let Some(index) = find_issue_index(&state.issues, issue_id) {
        if let Some(issue) = state.issues[index].as_object_mut() {
            let next = issue
                .get("notificationVersion")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                + 1;
            issue.insert("notificationVersion".to_string(), json!(next));
        }
    }
}

fn dispatch_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let registered_agent_id = body
        .as_ref()
        .and_then(|value| value.get("registeredAgentId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "registeredAgentId is required".to_string())?;
    let agent = state
        .agents
        .iter()
        .find(|agent| agent.id == registered_agent_id)
        .cloned()
        .ok_or_else(|| format!("Registered Agent not found: {}", registered_agent_id))?;
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let dispatch_id = state.next_id("dsp");
    let dispatch = dispatch_item(&dispatch_id, &agent, &issue, "pending");
    state.dispatches.insert(0, dispatch.clone());
    let _ = set_issue_status_value(state, issue_id, "in_progress")?;
    let system_comment = json!({
        "id": state.next_id("cmt"),
        "author": { "id": "system", "type": "system" },
        "body": format!("已指派给 Registered Agent：{}", agent.display_name),
        "createdAt": "2026-06-24T09:41:00.000Z"
    });
    state
        .comments
        .entry(issue_id.to_string())
        .or_default()
        .push(system_comment);
    refresh_issue_counts(state, issue_id);
    Ok(json!({
        "dispatch": dispatch.get("dispatch").cloned().unwrap_or(Value::Null)
    }))
}

fn skill_detail(state: &MockState, skill_id: &str) -> Result<Value, String> {
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    Ok(json!({
        "skill": record.skill,
        "revision": { "revision": record.current_revision },
        "files": record.files
    }))
}

fn skill_revisions(state: &MockState, skill_id: &str) -> Result<Value, String> {
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    Ok(json!({
        "skill": {
            "id": skill_id,
            "currentRevision": record.current_revision,
            "latestRevision": record.skill.get("latestRevision").cloned().unwrap_or(json!(record.current_revision))
        },
        "items": record.revisions
    }))
}

fn skill_file(state: &MockState, skill_id: &str, path: &str) -> Result<Value, String> {
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    record
        .file_content
        .get(path)
        .cloned()
        .ok_or_else(|| format!("Skill file not found: {}", path))
}

fn delete_skill(state: &mut MockState, skill_id: &str) -> Result<Value, String> {
    let before = state.skills.len();
    state
        .skills
        .retain(|record| record.skill.get("id").and_then(Value::as_str) != Some(skill_id));
    if state.skills.len() == before {
        return Err(format!("Skill not found: {}", skill_id));
    }
    Ok(json!({ "deleted": true }))
}

fn rollback_skill(
    state: &mut MockState,
    skill_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let revision = body
        .as_ref()
        .and_then(|value| value.get("revision"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "revision is required".to_string())?;
    let record = state
        .skills
        .iter_mut()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    if !record
        .revisions
        .iter()
        .any(|item| item.get("revision").and_then(Value::as_u64) == Some(revision))
    {
        return Err(format!("Skill revision not found: {}", revision));
    }
    record.current_revision = revision;
    if let Some(object) = record.skill.as_object_mut() {
        object.insert("currentRevision".to_string(), json!(revision));
        object.insert("updatedAt".to_string(), "2026-06-24T10:30:00.000Z".into());
        if let Some(current) = record
            .revisions
            .iter()
            .find(|item| item.get("revision").and_then(Value::as_u64) == Some(revision))
            .and_then(|item| item.get("uploader"))
            .cloned()
        {
            object.insert("uploader".to_string(), current);
        }
    }
    for item in &mut record.revisions {
        let is_current = item.get("revision").and_then(Value::as_u64) == Some(revision);
        if let Some(object) = item.as_object_mut() {
            object.insert("isCurrent".to_string(), json!(is_current));
        }
    }
    Ok(json!({ "skill": record.skill.clone() }))
}

fn update_agent_api(
    state: &mut MockState,
    agent_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let next_goal = if body.get("goalId").is_some() {
        let goal_id = body
            .get("goalId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "goalId is required".to_string())?;
        Some((goal_id.to_string(), goal_label(state, goal_id)))
    } else {
        None
    };
    let next_state_filter = body
        .get("stateFilter")
        .and_then(Value::as_array)
        .map(|items| {
            normalize_mock_agent_state_filter(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect(),
            )
        });
    let agent = state
        .agents
        .iter_mut()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", agent_id))?;
    let changes_local_binding = body.get("localWorkspaceId").is_some()
        || body.get("localAgentId").is_some()
        || body.get("workspacePath").is_some()
        || body.get("workspaceLabel").is_some();
    if changes_local_binding {
        let body_device_id = body
            .get("deviceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let agent_device_id = agent
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if body_device_id.is_none() || body_device_id != agent_device_id {
            return Err(
                "workspace binding can only be changed from the registered device".to_string(),
            );
        }
    }
    if let Some(display_name) = body.get("displayName").and_then(Value::as_str) {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("displayName is required".to_string());
        }
        agent.display_name = display_name.to_string();
    }
    if let Some(instruction) = body.get("instruction").and_then(Value::as_str) {
        let expected = body
            .get("expectedInstructionRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| "expectedInstructionRevision is required".to_string())?;
        if expected != agent.instruction_revision {
            return Err("REGISTERED_AGENT_INSTRUCTION_CONFLICT".to_string());
        }
        let instruction = instruction.trim();
        if instruction.is_empty() {
            return Err("instruction is required".to_string());
        }
        agent.instruction = Some(instruction.to_string());
        agent.instruction_revision += 1;
    }
    if let Some(local_workspace_id) = body.get("localWorkspaceId").and_then(Value::as_str) {
        let local_workspace_id = local_workspace_id.trim();
        if local_workspace_id.is_empty() {
            return Err("localWorkspaceId is required".to_string());
        }
        agent.local_workspace_id = Some(local_workspace_id.to_string());
        agent.workspace_id = Some(local_workspace_id.to_string());
    }
    if let Some(local_agent_id) = body.get("localAgentId").and_then(Value::as_str) {
        let local_agent_id = local_agent_id.trim();
        if local_agent_id.is_empty() {
            return Err("localAgentId is required".to_string());
        }
        agent.local_agent_id = Some(local_agent_id.to_string());
    }
    if let Some(workspace_path) = body.get("workspacePath").and_then(Value::as_str) {
        let workspace_root = validate_workspace_root(workspace_path)?;
        agent.workspace_path = workspace_root.to_string_lossy().to_string();
    }
    if body.get("workspaceLabel").is_some() {
        agent.workspace_label = body
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    if let Some(goal_md) = body.get("goalMd").and_then(Value::as_str) {
        let goal_md = goal_md.trim();
        if goal_md.is_empty() {
            return Err("goalMd is required".to_string());
        }
        agent.goal_md = Some(goal_md.to_string());
    }
    if let Some((goal_id, goal_path_label)) = next_goal {
        agent.goal_id = Some(goal_id);
        agent.goal_path_label = goal_path_label;
    }
    if let Some(state_filter) = next_state_filter {
        agent.state_filter = state_filter;
    }
    if let Some(status) = body.get("status").and_then(Value::as_str) {
        if !matches!(status, "active" | "disabled" | "revoked") {
            return Err("Registered Agent status is invalid".to_string());
        }
        agent.status = status.to_string();
    }
    if let Some(issue_subscription_run_mode) = body
        .get("issueSubscriptionRunMode")
        .cloned()
        .and_then(|value| serde_json::from_value::<SpaceIssueSubscriptionRunMode>(value).ok())
    {
        agent.issue_subscription_run_mode = issue_subscription_run_mode;
    }
    agent.updated_at = "2026-06-24T09:50:00.000Z".to_string();
    let public: LocalRegisteredAgentPublic = agent.clone().into();
    let subscription = agent
        .goal_id
        .as_ref()
        .map(|goal_id| {
            json!({
                "id": format!("sub_{}", agent.id.clone()),
                "spaceId": agent.space_id.clone(),
                "actorType": "registered_agent",
                "actorId": agent.id.clone(),
                "goalId": goal_id,
                "includeSubtree": true,
                "stateFilter": agent.state_filter.clone(),
                "goalPathLabel": agent.goal_path_label.clone(),
                "createdAt": agent.created_at.clone()
            })
        })
        .unwrap_or(Value::Null);
    Ok(json!({
        "registeredAgent": {
            "id": agent.id.clone(),
            "spaceId": agent.space_id.clone(),
            "ownerUserId": agent.owner_user_id.clone().unwrap_or_else(|| MOCK_OWNER_USER_ID.to_string()),
            "deviceId": agent.device_id.clone(),
            "device": public.device,
            "clientId": agent.client_id.clone(),
            "deviceName": public.device_name,
            "localWorkspaceId": agent.local_workspace_id.clone(),
            "localAgentId": agent.local_agent_id.clone(),
            "displayName": agent.display_name.clone(),
            "instruction": agent.instruction.clone(),
            "instructionRevision": agent.instruction_revision,
            "workspacePath": agent.workspace_path.clone(),
            "workspaceLabel": agent.workspace_label.clone(),
            "goalMd": agent.goal_md.clone(),
            "issueSubscriptionRunMode": agent.issue_subscription_run_mode,
            "status": agent.status.clone(),
            "createdAt": agent.created_at.clone(),
            "updatedAt": agent.updated_at.clone()
        },
        "subscription": subscription
    }))
}

fn refresh_issue_counts(state: &mut MockState, issue_id: &str) {
    let comment_count = state.comments.get(issue_id).map(Vec::len).unwrap_or(0);
    let comment_attachment_count = state
        .comments
        .get(issue_id)
        .map(|comments| {
            comments
                .iter()
                .map(|comment| {
                    comment
                        .get("attachments")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                })
                .sum::<usize>()
        })
        .unwrap_or(0);
    let attachment_count =
        state.attachments.get(issue_id).map(Vec::len).unwrap_or(0) + comment_attachment_count;
    if let Some(index) = find_issue_index(&state.issues, issue_id) {
        if let Some(issue) = state.issues[index].as_object_mut() {
            issue.insert("commentCount".to_string(), json!(comment_count));
            issue.insert("attachmentCount".to_string(), json!(attachment_count));
            issue.insert("updatedAt".to_string(), json!("2026-06-24T09:42:00.000Z"));
        }
    }
}

fn find_issue_index(issues: &[Value], issue_id: &str) -> Option<usize> {
    issues
        .iter()
        .position(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
}

fn next_issue_number(state: &MockState) -> u64 {
    state
        .issues
        .iter()
        .filter_map(|issue| issue.get("number").and_then(Value::as_u64))
        .max()
        .unwrap_or(0)
        + 1
}

fn tag(name: &str, description: &str) -> Value {
    json!({
        "id": format!("tag_{}", name.replace('-', "_")),
        "name": name,
        "color": null,
        "description": description
    })
}

fn goal(id: &str, parent_goal_id: Option<&str>, title: &str, context: &str) -> Value {
    let path = match parent_goal_id {
        Some(parent) => format!("/{}/{}/", parent, id),
        None => format!("/{}/", id),
    };
    json!({
        "id": id,
        "spaceId": MOCK_SPACE_ID,
        "parentGoalId": parent_goal_id,
        "path": path,
        "depth": if parent_goal_id.is_some() { 1 } else { 0 },
        "title": title,
        "context": context,
        "archivedAt": null,
        "createdAt": "2026-06-20T08:00:00.000Z",
        "updatedAt": "2026-06-24T08:00:00.000Z",
        "goalPathLabel": if parent_goal_id.is_some() { format!("MyAgents社区 / {}", title) } else { title.to_string() }
    })
}

fn seeded_goal_id(index: usize) -> &'static str {
    match index % 4 {
        1 => "goal_mock_runtime",
        2 => "goal_mock_ui",
        3 => "goal_mock_docs",
        _ => MOCK_ROOT_GOAL_ID,
    }
}

fn seeded_goal_label(index: usize) -> &'static str {
    match seeded_goal_id(index) {
        "goal_mock_runtime" => "MyAgents社区 / Runtime Delivery",
        "goal_mock_ui" => "MyAgents社区 / UI Quality",
        "goal_mock_docs" => "MyAgents社区 / Docs Alignment",
        _ => "MyAgents社区",
    }
}

fn legacy_status_to_state(status: &str) -> &'static str {
    match status {
        "triaged" => "todo",
        "in_progress" => "doing",
        "resolved" => "done",
        "declined" | "duplicate" | "archived" | "closed" => "closed",
        _ => "open",
    }
}

fn goal_label(state: &MockState, goal_id: &str) -> Option<String> {
    computed_goal_label(state, goal_id)
}

fn goal_is_in_subtree(state: &MockState, candidate_goal_id: &str, ancestor_goal_id: &str) -> bool {
    if candidate_goal_id.is_empty() {
        return false;
    }
    if candidate_goal_id == ancestor_goal_id {
        return true;
    }

    let mut current_id = candidate_goal_id.to_string();
    let mut visited = HashSet::new();
    for _ in 0..64 {
        if !visited.insert(current_id.clone()) {
            return false;
        }
        let Some(goal) = state
            .goals
            .iter()
            .find(|goal| goal.get("id").and_then(Value::as_str) == Some(current_id.as_str()))
        else {
            return false;
        };
        let Some(parent_goal_id) = goal.get("parentGoalId").and_then(Value::as_str) else {
            return false;
        };
        if parent_goal_id == ancestor_goal_id {
            return true;
        }
        current_id = parent_goal_id.to_string();
    }

    false
}

fn computed_goal_label(state: &MockState, goal_id: &str) -> Option<String> {
    let mut titles = Vec::new();
    let mut current_id = Some(goal_id.to_string());
    let mut guard = 0usize;
    while let Some(id) = current_id {
        guard += 1;
        if guard > 32 {
            break;
        }
        let goal = state
            .goals
            .iter()
            .find(|goal| goal.get("id").and_then(Value::as_str) == Some(id.as_str()))?;
        titles.push(goal.get("title").and_then(Value::as_str)?.to_string());
        current_id = goal
            .get("parentGoalId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }
    titles.reverse();
    if titles.is_empty() {
        None
    } else {
        Some(titles.join(" / "))
    }
}

fn refresh_goal_labels(state: &mut MockState) {
    let labels = state
        .goals
        .iter()
        .filter_map(|goal| {
            let id = goal.get("id").and_then(Value::as_str)?.to_string();
            let label = computed_goal_label(state, &id)?;
            Some((id, label))
        })
        .collect::<HashMap<_, _>>();
    for goal in &mut state.goals {
        let Some(id) = goal.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(label) = labels.get(id) else {
            continue;
        };
        if let Some(goal) = goal.as_object_mut() {
            goal.insert("goalPathLabel".to_string(), json!(label));
        }
    }
    for issue in &mut state.issues {
        let Some(goal_id) = issue.get("goalId").and_then(Value::as_str) else {
            continue;
        };
        let Some(label) = labels.get(goal_id) else {
            continue;
        };
        if let Some(issue) = issue.as_object_mut() {
            issue.insert("goalPathLabel".to_string(), json!(label));
        }
    }
}

fn is_archived(value: &Value) -> bool {
    !matches!(value.get("archivedAt"), None | Some(Value::Null))
}

fn tags_for(tags: &[Value], identities: &[&str]) -> Vec<Value> {
    identities
        .iter()
        .filter_map(|identity| {
            tags.iter()
                .find(|tag| {
                    let id_matches = tag
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == *identity)
                        .unwrap_or(false);
                    let name_matches = tag
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|value| value == *identity)
                        .unwrap_or(false);
                    id_matches || name_matches
                })
                .cloned()
        })
        .collect()
}

fn seeded_comments(issue_id: &str, idx: usize) -> Vec<Value> {
    if idx % 5 == 0 {
        return Vec::new();
    }
    let mut comments = vec![
        json!({
            "id": format!("cmt_{}_001", issue_id),
            "author": {
                "id": "usr_maya",
                "type": "user",
                "name": "Maya Chen",
                "avatarUrl": "https://space.mock.myagents.local/mock-avatar/maya.png"
            },
            "body": "我复现了一次，先记录环境和当前判断，后面再让 Agent 接手验证。",
            "createdAt": "2026-06-23T10:08:00.000Z"
        }),
        json!({
            "id": format!("cmt_{}_002", issue_id),
            "author": {
                "id": "rag_mock_frontend",
                "type": "registered_agent",
                "name": "Frontend Review Agent",
                "avatarUrl": null
            },
            "body": "已读取 issue 上下文。建议先确认预期交互，再做最小复现和回归测试。",
            "createdAt": "2026-06-23T11:18:00.000Z"
        }),
    ];
    if idx % 3 == 0 {
        comments.push(json!({
            "id": format!("cmt_{}_003", issue_id),
            "author": { "id": "system", "type": "system" },
            "body": "系统记录：状态已更新，等待下一轮处理。",
            "createdAt": "2026-06-23T12:30:00.000Z"
        }));
    }
    comments
}

fn seeded_attachments(issue_id: &str, idx: usize) -> Vec<Value> {
    match idx % 6 {
        1 => vec![attachment(
            issue_id,
            "screenshot-space-list.png",
            184_320,
            "image/png",
        )],
        2 => vec![
            attachment(issue_id, "runtime-trace.log", 41_984, "text/plain"),
            attachment(issue_id, "agent-output.md", 12_288, "text/markdown"),
        ],
        3 => vec![attachment(
            issue_id,
            "windows-webview-report.zip",
            3_467_264,
            "application/zip",
        )],
        _ => Vec::new(),
    }
}

fn attachment(issue_id: &str, name: &str, size: u64, mime: &str) -> Value {
    json!({
        "id": format!("att_{}_{}", issue_id, safe_local_name(name)),
        "name": name,
        "sizeBytes": size,
        "mimeType": mime,
        "createdAt": "2026-06-23T09:50:00.000Z"
    })
}

fn skill(id: &str, name: &str, slug: &str, description: &str, revision: u32) -> Value {
    json!({
        "id": id,
        "name": name,
        "slug": slug,
        "description": description,
        "latestRevision": revision,
        "currentRevision": revision,
        "uploader": {
            "id": MOCK_OWNER_USER_ID,
            "name": "Ethan",
            "avatarUrl": "https://space.mock.myagents.local/mock-avatar/ethan.png"
        },
        "createdAt": "2026-06-10T08:00:00.000Z",
        "updatedAt": format!("2026-06-{:02}T12:00:00.000Z", 12 + (revision % 10)),
        "source": {
            "type": "github",
            "url": format!("https://github.com/myagents/mock-skills/tree/main/{}", slug),
            "resolvedUrl": "https://codeload.github.com/myagents/mock-skills/zip/refs/heads/main",
            "owner": "myagents",
            "repo": "mock-skills",
            "ref": null,
            "effectiveRef": "main",
            "rootPath": slug,
            "skillName": slug,
            "updatedAt": "2026-06-10T08:00:00.000Z"
        }
    })
}

fn skill_record(skill: Value, overview: &str, readme: &str) -> MockSkillRecord {
    let id = skill
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("skl_mock");
    let slug = skill
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("mock-skill");
    let files = vec![
        file(id, "SKILL.md", "SKILL.md", "", false, 1200, "text/markdown"),
        file(
            id,
            "README.md",
            "README.md",
            "",
            false,
            860,
            "text/markdown",
        ),
        file(id, "scripts", "scripts", "", true, 0, "inode/directory"),
        file(
            id,
            "scripts/verify.ts",
            "verify.ts",
            "scripts",
            false,
            1340,
            "text/typescript",
        ),
        file(id, "assets", "assets", "", true, 0, "inode/directory"),
        file(
            id,
            "assets/sample-output.png",
            "sample-output.png",
            "assets",
            false,
            48200,
            "image/png",
        ),
    ];
    let mut file_content = HashMap::new();
    file_content.insert(
        "SKILL.md".to_string(),
        json!({
            "text": format!("---\nname: {}\ndescription: {}\n---\n\n# {}\n\n{}\n", slug, overview, skill.get("name").and_then(Value::as_str).unwrap_or("Mock Skill"), overview),
            "binary": false,
            "mimeType": "text/markdown",
            "sizeBytes": 1200
        }),
    );
    file_content.insert(
        "README.md".to_string(),
        json!({
            "text": format!("# {}\n\n{}\n", skill.get("name").and_then(Value::as_str).unwrap_or("Mock Skill"), readme),
            "binary": false,
            "mimeType": "text/markdown",
            "sizeBytes": 860
        }),
    );
    file_content.insert(
        "scripts/verify.ts".to_string(),
        json!({
            "text": "export function verify() {\n  return 'mock skill verification passed';\n}\n",
            "binary": false,
            "mimeType": "text/typescript",
            "sizeBytes": 1340
        }),
    );
    file_content.insert(
        "assets/sample-output.png".to_string(),
        json!({
            "binary": true,
            "mimeType": "image/png",
            "sizeBytes": 48200
        }),
    );
    let latest_revision = skill
        .get("latestRevision")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let current_revision = skill
        .get("currentRevision")
        .and_then(Value::as_u64)
        .unwrap_or(latest_revision);
    let revisions = (1..=latest_revision)
        .rev()
        .map(|revision| {
            json!({
                "id": format!("sklr_{}_{}", id, revision),
                "skillId": id,
                "revision": revision,
                "version": format!("v{}", revision),
                "packageHash": format!("mockhash{}{:02}", safe_local_name(id), revision),
                "isCurrent": revision == current_revision,
                "uploader": {
                    "id": MOCK_OWNER_USER_ID,
                    "name": "Ethan",
                    "avatarUrl": "https://space.mock.myagents.local/mock-avatar/ethan.png"
                },
                "createdAt": format!("2026-06-{:02}T11:00:00.000Z", 10 + (revision % 12))
            })
        })
        .collect::<Vec<_>>();
    MockSkillRecord {
        skill,
        revisions,
        current_revision,
        files,
        file_content,
    }
}

fn file(
    skill_id: &str,
    id_suffix: &str,
    name: &str,
    parent: &str,
    is_dir: bool,
    size: u64,
    mime: &str,
) -> Value {
    json!({
        "id": format!("file_{}_{}", skill_id, safe_local_name(id_suffix)),
        "path": id_suffix,
        "name": name,
        "parentPath": parent,
        "isDir": is_dir,
        "sizeBytes": size,
        "mimeType": mime,
        "createdAt": "2026-06-10T08:00:00.000Z"
    })
}

fn agent(
    id: &str,
    display_name: &str,
    status: &str,
    workspace_path: &str,
    workspace_label: &str,
    goal_md: &str,
) -> LocalRegisteredAgent {
    let goal_id = match id {
        "rag_mock_runtime" => "goal_mock_runtime",
        "rag_mock_docs" => "goal_mock_docs",
        _ => "goal_mock_ui",
    };
    let is_remote_device =
        matches!(id, "rag_mock_windows") || id.ends_with("_07") || id.ends_with("_13");
    let is_legacy_device = matches!(id, "rag_mock_runtime");
    let (
        device_id,
        device_name,
        device_platform,
        device_os_version,
        device_app_version,
        device_last_seen_at,
    ) = if is_legacy_device {
        (
            None,
            Some("Legacy Agent Device".to_string()),
            None,
            None,
            None,
            None,
        )
    } else if is_remote_device {
        (
            Some(MOCK_REMOTE_DEVICE_ID.to_string()),
            Some("Windows QA VM".to_string()),
            Some("windows-x86_64".to_string()),
            Some("Windows 11 Pro 24H2".to_string()),
            Some(env!("CARGO_PKG_VERSION").to_string()),
            Some("2026-06-23T22:10:00.000Z".to_string()),
        )
    } else {
        (
            Some(mock_local_device_id()),
            mock_local_device_name(),
            Some(crate::device_identity::platform_identifier()),
            mock_local_device_os_version(),
            Some(env!("CARGO_PKG_VERSION").to_string()),
            Some("2026-06-24T08:45:00.000Z".to_string()),
        )
    };
    let avatar_index = id
        .bytes()
        .fold(0usize, |acc, byte| acc.wrapping_add(byte as usize))
        % 16
        + 1;
    let avatar_preset_id = format!("agent-{avatar_index:02}");
    LocalRegisteredAgent {
        id: id.to_string(),
        base_url: MOCK_BASE_URL.to_string(),
        space_id: MOCK_SPACE_ID.to_string(),
        owner_user_id: Some(MOCK_OWNER_USER_ID.to_string()),
        device_id,
        client_id: Some("mock-public-client".to_string()),
        device_name,
        device_platform,
        device_os_version,
        device_app_version,
        device_last_seen_at,
        local_workspace_id: Some(format!("project_{}", safe_local_name(workspace_label))),
        local_agent_id: Some(format!(
            "local-agent-project_{}",
            safe_local_name(workspace_label)
        )),
        workspace_id: Some(format!("project_{}", safe_local_name(workspace_label))),
        display_name: display_name.to_string(),
        instruction: Some(goal_md.to_string()),
        instruction_revision: 1,
        workspace_path: workspace_path.to_string(),
        workspace_label: Some(workspace_label.to_string()),
        avatar_url: Some(mock_avatar_preset_url("agents", &avatar_preset_id, 128)),
        avatar_source: Some("preset".to_string()),
        avatar_preset_id: Some(avatar_preset_id.clone()),
        avatar_urls: Some(mock_avatar_urls("agents", &avatar_preset_id)),
        subscriptions: Vec::new(),
        goal_id: Some(goal_id.to_string()),
        goal_path_label: Some(
            match goal_id {
                "goal_mock_runtime" => "MyAgents社区 / Runtime Delivery",
                "goal_mock_docs" => "MyAgents社区 / Docs Alignment",
                _ => "MyAgents社区 / UI Quality",
            }
            .to_string(),
        ),
        state_filter: vec!["todo".to_string()],
        goal_md: Some(goal_md.to_string()),
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        issue_subscription_run_mode: Default::default(),
        issue_session_ids: Default::default(),
        token: format!("mock-token-{}", id),
        status: status.to_string(),
        created_at: "2026-06-14T08:00:00.000Z".to_string(),
        updated_at: "2026-06-24T08:45:00.000Z".to_string(),
    }
}

fn upsert_device(body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let device_id = body
        .get("deviceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("mock-local-device");
    Ok(json!({
        "device": {
            "userId": MOCK_OWNER_USER_ID,
            "deviceId": device_id,
            "deviceName": body.get("deviceName").cloned().unwrap_or(Value::Null),
            "platform": body.get("platform").cloned().unwrap_or(Value::Null),
            "osVersion": body.get("osVersion").cloned().unwrap_or(Value::Null),
            "appVersion": body.get("appVersion").cloned().unwrap_or(Value::Null),
            "status": "active",
            "lastSeenAt": "2026-06-24T09:52:00.000Z"
        }
    }))
}

fn mock_local_device_id() -> String {
    crate::device_identity::get_or_create_device_id()
        .unwrap_or_else(|_| "mock-local-device".to_string())
}

fn mock_local_device_name() -> Option<String> {
    crate::device_identity::local_device_name().or_else(|| Some("Mock Local Mac".to_string()))
}

fn mock_local_device_os_version() -> Option<String> {
    Some("mockOS 1.0".to_string())
}

fn dispatch_item(id: &str, agent: &LocalRegisteredAgent, issue: &Value, status: &str) -> Value {
    let issue_id = issue
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("iss_mock_001");
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Mock Issue");
    let issue_status = issue
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("open");
    let updated_at = issue
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or("2026-06-24T08:00:00.000Z");
    json!({
        "dispatch": {
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "issueId": issue_id,
            "registeredAgentId": agent.id,
            "deliveryStatus": status,
            "goalSnapshotMd": format!("请读取 Space Issue {}，理解上下文后与用户讨论下一步。", issue_id),
            "createdAt": "2026-06-24T08:50:00.000Z",
            "updatedAt": "2026-06-24T08:50:00.000Z"
        },
        "registeredAgent": {
            "id": agent.id,
            "displayName": agent.display_name,
            "goalMd": agent.goal_md.clone().unwrap_or_default()
        },
        "issueMeta": {
            "id": issue_id,
            "number": issue.get("number").and_then(Value::as_u64),
            "title": title,
            "status": issue_status,
            "updatedAt": updated_at
        }
    })
}

fn delivery_item(id: &str, agent: &LocalRegisteredAgent, issue: &Value, status: &str) -> Value {
    let issue_id = issue
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("iss_mock_001");
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Mock Issue");
    let issue_state = issue
        .get("state")
        .and_then(Value::as_str)
        .or_else(|| issue.get("status").and_then(Value::as_str))
        .unwrap_or("todo");
    let updated_at = issue
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or("2026-06-24T08:00:00.000Z");
    let goal_id = issue
        .get("goalId")
        .and_then(Value::as_str)
        .or(agent.goal_id.as_deref())
        .unwrap_or(MOCK_ROOT_GOAL_ID);
    json!({
        "delivery": {
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "deliveryKind": "subscription",
            "issueId": issue_id,
            "registeredAgentId": agent.id,
            "subscriptionId": format!("sub_{}", agent.id),
            "claimId": null,
            "notificationVersion": issue.get("notificationVersion").and_then(Value::as_i64).unwrap_or(1),
            "updateSummary": "Issue matched this Registered Agent goal subscription",
            "targetSessionId": null,
            "cloudInstruction": {
                "id": "subscription-v1",
                "text": "This is a subscription delivery for an unassigned Space Issue. Read the trigger and current Issue before deciding whether to dismiss or claim it."
            },
            "trigger": {
                "updateId": format!("update_{}", id),
                "type": "issue.created",
                "actor": { "type": "user", "id": MOCK_OWNER_USER_ID, "name": "Ethan" },
                "createdAt": "2026-06-24T08:55:00.000Z"
            },
            "status": status,
            "createdAt": "2026-06-24T08:55:00.000Z",
            "updatedAt": "2026-06-24T08:55:00.000Z",
            "deliveredToSessionId": null,
            "deliveredAt": null
        },
        "issueMeta": {
            "id": issue_id,
            "number": issue.get("number").and_then(Value::as_u64),
            "title": title,
            "state": issue_state,
            "assignee": issue.get("assignee").cloned().unwrap_or(Value::Null),
            "updatedAt": updated_at
        },
        "goalMeta": {
            "id": goal_id,
            "path": agent.goal_path_label.clone().unwrap_or_else(|| "MyAgents社区".to_string()),
            "title": agent.goal_path_label.clone().unwrap_or_else(|| "MyAgents社区".to_string())
        }
    })
}

fn mock_event(
    id: &str,
    event_type: &str,
    resource_type: &str,
    resource_id: &str,
    created_at: &str,
) -> Value {
    json!({
        "id": id,
        "type": event_type,
        "resourceType": resource_type,
        "resourceId": resource_id,
        "actorType": "user",
        "actorId": "usr_mock_owner",
        "targetRegisteredAgentId": null,
        "payload": null,
        "createdAt": created_at
    })
}

fn mock_space() -> Value {
    json!({
        "id": MOCK_SPACE_ID,
        "slug": "official",
        "name": "MyAgents社区",
        "joinPolicy": "open_join",
        "rootGoalId": MOCK_ROOT_GOAL_ID,
        "spaceKind": "official",
        "planTier": "free",
        "effectivePlanTier": "free",
        "planExpiresAt": null,
        "entitlement": {
            "source": "space_override",
            "key": "official",
            "displayName": "官方套餐",
            "expiresAt": null,
            "version": 1
        },
        "limits": mock_limits(),
        "quotaBypassed": false,
        "avatarUrl": null,
        "avatarSizeBytes": 0
    })
}

fn mock_account_plan() -> Value {
    if std::env::var("MYAGENTS_SPACE_MOCK_PLAN")
        .map(|value| value.eq_ignore_ascii_case("pro"))
        .unwrap_or(false)
    {
        return json!({
            "effectiveTier": "pro",
            "evaluatedAt": "2026-07-11T00:00:00.000Z",
            "membership": {
                "planTier": "pro",
                "status": "active",
                "startsAt": "2026-07-01T00:00:00.000Z",
                "expiresAt": "2026-10-11T00:00:00.000Z",
                "revokedAt": null,
                "source": "mock",
                "version": 1
            }
        });
    }
    json!({
        "effectiveTier": "free",
        "evaluatedAt": "2026-07-11T00:00:00.000Z",
        "membership": null
    })
}

fn mock_limits() -> Value {
    json!({
        "ownedSpacesMax": 1,
        "joinedMembersMax": null,
        "openIssuesMax": 10_000,
        "hostedSkillsMax": 1_000,
        "registeredAgentsMax": 100,
        "storageBytesMax": 100_u64 * 1024 * 1024 * 1024
    })
}

fn mock_usage(state: &MockState) -> Value {
    json!({
        "memberSeats": 0,
        "openIssues": state.issues.iter().filter(|issue| {
            matches!(issue.get("state").and_then(Value::as_str), Some("open" | "todo" | "doing"))
        }).count(),
        "hostedSkills": state.skills.len(),
        "registeredAgents": state.agents.iter().filter(|agent| agent.status != "revoked").count(),
        "storageBytes": 0
    })
}

fn mock_space_list_item() -> Value {
    json!({
        "id": MOCK_SPACE_ID,
        "slug": "official",
        "name": "MyAgents社区",
        "joinPolicy": "open_join",
        "rootGoalId": MOCK_ROOT_GOAL_ID,
        "spaceKind": "official",
        "planTier": "free",
        "effectivePlanTier": "free",
        "planExpiresAt": null,
        "entitlement": {
            "source": "space_override",
            "key": "official",
            "displayName": "官方套餐",
            "expiresAt": null,
            "version": 1
        },
        "quotaBypassed": false,
        "avatarUrl": null,
        "avatarSizeBytes": 0,
        "membership": mock_membership(),
        "canManage": true,
        "pendingJoinRequestCount": 0,
        "limits": mock_limits()
    })
}

fn mock_membership() -> Value {
    json!({
        "id": "mship_mock_owner",
        "role": std::env::var("MYAGENTS_SPACE_MOCK_ROLE").unwrap_or_else(|_| "owner".to_string())
    })
}

fn mock_me(state: &MockState) -> Value {
    json!({
        "user": state.user.clone(),
        "accountPlan": mock_account_plan(),
        "space": mock_space(),
        "membership": mock_membership(),
        "spaces": [mock_space_list_item()]
    })
}

fn ok_envelope(data: Value) -> Value {
    json!({ "success": true, "data": data, "requestId": "req_mock_success" })
}

fn err_envelope(error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": "MOCK_SPACE_ERROR",
        "requestId": "req_mock_error"
    })
}

fn parse_mock_url(path: &str) -> Result<reqwest::Url, String> {
    if !path.starts_with("/api/") && path != "/health" && path != "/" {
        return Err("Space API path must start with /api/".to_string());
    }
    reqwest::Url::parse(&format!("{}{}", MOCK_BASE_URL, path))
        .map_err(|e| format!("Invalid mock Space API path: {}", e))
}

fn mime_for_name(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".zip") {
        "application/zip"
    } else if name.ends_with(".md") {
        "text/markdown"
    } else {
        "text/plain"
    }
}

fn safe_local_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '.', '_']).to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

fn safe_local_filename(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '/'
            || ch == '\\'
            || ch == '\0'
            || matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_matches('.').to_string()
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_mock_state_has_commercial_fixture_volume() {
        let state = initial_state();

        assert!(state.issues.len() >= 500);
        assert!(state.skills.len() >= 50);
        assert!(state.agents.len() >= 50);
        assert!(state.issues.iter().any(|issue| issue
            .get("attachmentCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0));
        assert!(state.issues.iter().any(|issue| issue
            .get("commentCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0));
    }

    #[test]
    fn issue_list_missing_state_defaults_to_active_while_all_includes_terminal() {
        let state = initial_state();
        let terminal_title = "补齐 Cloud Space 架构文档中的 mock mode 说明";
        let closed_title = "把 Issue 管理按钮改成只读概览";
        let archived_title = "历史会话恢复时 Issue 口令要能被 Agent 读取";
        let active_title = "评论发送失败时不要丢失输入内容";

        let default_terminal = list_issues(
            &state,
            &HashMap::from([("q".to_string(), terminal_title.to_string())]),
        );
        assert_eq!(
            default_terminal
                .pointer("/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );

        let all_terminal = list_issues(
            &state,
            &HashMap::from([
                ("q".to_string(), terminal_title.to_string()),
                ("state".to_string(), "all".to_string()),
            ]),
        );
        assert_eq!(
            all_terminal
                .pointer("/items/0/state")
                .and_then(Value::as_str),
            Some("done")
        );

        let all_closed = list_issues(
            &state,
            &HashMap::from([
                ("q".to_string(), closed_title.to_string()),
                ("state".to_string(), "all".to_string()),
            ]),
        );
        assert_eq!(
            all_closed.pointer("/items/0/state").and_then(Value::as_str),
            Some("closed")
        );

        let all_archived = list_issues(
            &state,
            &HashMap::from([
                ("q".to_string(), archived_title.to_string()),
                ("state".to_string(), "all".to_string()),
            ]),
        );
        assert_eq!(
            all_archived
                .pointer("/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );

        let default_active = list_issues(
            &state,
            &HashMap::from([("q".to_string(), active_title.to_string())]),
        );
        assert_eq!(
            default_active
                .pointer("/items/0/state")
                .and_then(Value::as_str),
            Some("open")
        );
    }

    #[test]
    fn mock_delivery_router_respects_human_only_and_agent_self_suppression() {
        let mut state = initial_state();
        state.deliveries.clear();
        let agent = state
            .agents
            .iter()
            .find(|agent| agent.status == "active")
            .cloned()
            .expect("active Agent");
        let mut issue = json!({
            "id": "iss_delivery_policy",
            "goalId": agent.goal_id,
            "state": "todo",
            "humanOnly": true,
            "assignee": {
                "type": "registered_agent",
                "id": agent.id,
                "name": agent.display_name
            },
            "notificationVersion": 1
        });

        route_mock_issue_deliveries(&mut state, &issue, "issue.updated", None)
            .expect("human-only routing should be a no-op");
        assert!(state.deliveries.is_empty());

        issue["humanOnly"] = json!(false);
        route_mock_issue_deliveries(&mut state, &issue, "issue.updated", Some(agent.id.as_str()))
            .expect("self update routing should be a no-op");
        assert!(state.deliveries.is_empty());

        route_mock_issue_deliveries(&mut state, &issue, "issue.updated", None)
            .expect("another actor should notify the assigned Agent");
        assert_eq!(state.deliveries.len(), 1);
        assert_eq!(
            state.deliveries[0]
                .pointer("/delivery/deliveryKind")
                .and_then(Value::as_str),
            Some("assignment")
        );

        state.deliveries.clear();
        state
            .agents
            .iter_mut()
            .find(|candidate| candidate.id == agent.id)
            .expect("assigned Agent")
            .status = "disabled".to_string();
        route_mock_issue_deliveries(&mut state, &issue, "issue.updated", None)
            .expect("inactive assignees should produce no delivery, not fail the Issue update");
        assert!(state.deliveries.is_empty());
        state
            .agents
            .iter_mut()
            .find(|candidate| candidate.id == agent.id)
            .expect("assigned Agent")
            .status = "active".to_string();

        state.claims.insert(
            "iss_delivery_policy".to_string(),
            json!({
                "id": "claim_delivery_policy",
                "actorType": "registered_agent",
                "actorId": agent.id,
                "localSessionId": "session_delivery_policy"
            }),
        );
        route_mock_issue_deliveries(&mut state, &issue, "issue.updated", None)
            .expect("an active claim should receive a follow-up");
        assert_eq!(
            state.deliveries[0]
                .pointer("/delivery/deliveryKind")
                .and_then(Value::as_str),
            Some("claim_followup")
        );
    }

    #[test]
    fn revoked_agent_token_cannot_fall_back_to_user_for_scoped_issue_update() {
        let _mock = enable_for_test();
        let before = api_data_request("GET", "/api/issues/iss_mock_001", None)
            .expect("Issue before rejected update");
        api_data_request(
            "PATCH",
            "/api/registered-agents/rag_mock_frontend",
            Some(json!({ "status": "disabled" })),
        )
        .expect("disable mock Agent");

        let error = api_data_request_scoped_with_token(
            "PATCH",
            "/api/issues/iss_mock_001",
            Some("mock-token-rag_mock_frontend"),
            Some(json!({ "title": "Must not be written as User" })),
            Some(MOCK_SPACE_ID),
        )
        .expect_err("revoked Agent token must fail closed");
        assert!(error.starts_with("REGISTERED_AGENT_TOKEN_IS_INVALID_OR_REVOKED:"));
        let after = api_data_request("GET", "/api/issues/iss_mock_001", None)
            .expect("Issue after rejected update");
        assert_eq!(
            after.pointer("/issue/title"),
            before.pointer("/issue/title")
        );
    }

    #[test]
    fn mock_assignee_mutations_are_idempotent() {
        let mut state = initial_state();
        let agent = state
            .agents
            .iter()
            .find(|agent| agent.status == "active")
            .cloned()
            .expect("active Agent");
        let issue_id = state.issues[1]
            .get("id")
            .and_then(Value::as_str)
            .expect("Issue id")
            .to_string();
        state.issues[1]["humanOnly"] = json!(false);
        state.issues[1]["assignee"] = json!({
            "type": "registered_agent",
            "id": agent.id,
            "name": agent.display_name
        });
        let version_before = state.issues[1]["notificationVersion"]
            .as_i64()
            .expect("notification version");
        let deliveries_before = state.deliveries.len();

        let repeated = set_issue_assignee(
            &mut state,
            &issue_id,
            Some(json!({
                "assignee": { "type": "registered_agent", "id": agent.id }
            })),
        )
        .expect("repeated assignment should succeed");
        assert_eq!(
            repeated.get("idempotent").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            state.issues[1]["notificationVersion"].as_i64(),
            Some(version_before)
        );
        assert_eq!(state.deliveries.len(), deliveries_before);

        cancel_issue_assignee(&mut state, &issue_id).expect("first clear should succeed");
        let version_after_clear = state.issues[1]["notificationVersion"]
            .as_i64()
            .expect("notification version after clear");
        let deliveries_after_clear = state.deliveries.len();
        let repeated_clear =
            cancel_issue_assignee(&mut state, &issue_id).expect("repeated clear should succeed");
        assert_eq!(
            repeated_clear.get("idempotent").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            state.issues[1]["notificationVersion"].as_i64(),
            Some(version_after_clear)
        );
        assert_eq!(state.deliveries.len(), deliveries_after_clear);
    }

    #[test]
    fn mock_claim_rejects_human_only_and_terminal_issues() {
        let mut state = initial_state();
        let agent = state
            .agents
            .iter()
            .find(|agent| agent.status == "active")
            .cloned()
            .expect("active Agent");
        let actor = MockActor {
            actor_type: "registered_agent".to_string(),
            actor_id: agent.id,
            actor_name: agent.display_name,
            authenticated: true,
        };
        let issue_id = state.issues[0]
            .get("id")
            .and_then(Value::as_str)
            .expect("Issue id")
            .to_string();
        state.issues[0]["humanOnly"] = json!(true);
        state.issues[0]["assignee"] = Value::Null;

        let human_only = claim_issue(&mut state, &issue_id, None, &actor)
            .expect_err("Agent must not claim human-only Issue");
        assert!(human_only.contains("Human-only"));

        state.issues[0]["humanOnly"] = json!(false);
        state.issues[0]["state"] = json!("done");
        let terminal = claim_issue(&mut state, &issue_id, None, &actor)
            .expect_err("terminal Issue must not be claimable");
        assert!(terminal.contains("Completed or closed"));
    }

    #[test]
    fn mock_self_claim_rollback_refans_out_to_other_subscribers() {
        let mut state = initial_state();
        state.deliveries.clear();
        let active_indexes = state
            .agents
            .iter()
            .enumerate()
            .filter(|(_, agent)| agent.status == "active")
            .map(|(index, _)| index)
            .take(2)
            .collect::<Vec<_>>();
        assert_eq!(active_indexes.len(), 2);
        let actor_index = active_indexes[0];
        let subscriber_index = active_indexes[1];
        let goal_id = "goal_mock_ui".to_string();
        for index in &active_indexes {
            state.agents[*index].goal_id = Some(MOCK_ROOT_GOAL_ID.to_string());
            state.agents[*index].state_filter = vec!["todo".to_string()];
        }
        let actor_agent = state.agents[actor_index].clone();
        let subscriber_id = state.agents[subscriber_index].id.clone();
        let issue_id = "iss_rollback".to_string();
        state.issues.push(json!({
            "id": issue_id,
            "goalId": goal_id,
            "state": "in_progress",
            "status": "in_progress",
            "humanOnly": false,
            "assignee": {
                "type": "registered_agent",
                "id": actor_agent.id,
                "name": actor_agent.display_name
            },
            "notificationVersion": 2
        }));
        state.claims.insert(
            issue_id.clone(),
            json!({
                "id": "claim_rollback",
                "issueId": issue_id,
                "actorType": "registered_agent",
                "actorId": actor_agent.id,
                "actorName": actor_agent.display_name,
                "origin": "self_claim"
            }),
        );
        let actor = MockActor {
            actor_type: "registered_agent".to_string(),
            actor_id: actor_agent.id.clone(),
            actor_name: actor_agent.display_name,
            authenticated: true,
        };
        let other_actor = MockActor {
            actor_type: "registered_agent".to_string(),
            actor_id: subscriber_id.clone(),
            actor_name: state.agents[subscriber_index].display_name.clone(),
            authenticated: true,
        };
        let unauthorized = cancel_issue_claim(
            &mut state,
            &issue_id,
            Some(json!({ "rollback": true, "expectedNotificationVersion": 2 })),
            &other_actor,
        )
        .expect_err("another Agent must not rollback this claim");
        assert!(unauthorized.contains("claim actor"));

        let result = cancel_issue_claim(
            &mut state,
            &issue_id,
            Some(json!({ "rollback": true, "expectedNotificationVersion": 2 })),
            &actor,
        )
        .expect("self-claim rollback should succeed");
        assert_eq!(result.get("state").and_then(Value::as_str), Some("todo"));
        assert!(state.deliveries.iter().any(|item| {
            item.pointer("/delivery/registeredAgentId")
                .and_then(Value::as_str)
                == Some(subscriber_id.as_str())
        }));
        assert!(!state.deliveries.iter().any(|item| {
            item.pointer("/delivery/registeredAgentId")
                .and_then(Value::as_str)
                == Some(actor_agent.id.as_str())
        }));
    }

    #[test]
    fn mock_completion_operation_key_is_scoped_to_its_issue() {
        let mut state = initial_state();
        let actor = MockActor {
            actor_type: "user".to_string(),
            actor_id: MOCK_OWNER_USER_ID.to_string(),
            actor_name: "Ethan".to_string(),
            authenticated: false,
        };
        let first_issue_id = state.issues[1]["id"]
            .as_str()
            .expect("first Issue id")
            .to_string();
        let second_issue_id = state.issues[2]["id"]
            .as_str()
            .expect("second Issue id")
            .to_string();
        state.issues[1]["state"] = json!("todo");
        state.issues[2]["state"] = json!("todo");

        complete_issue(
            &mut state,
            &first_issue_id,
            Some(json!({ "operationKey": "op_shared" })),
            &actor,
        )
        .expect("first completion should succeed");
        let conflict = complete_issue(
            &mut state,
            &second_issue_id,
            Some(json!({ "operationKey": "op_shared" })),
            &actor,
        )
        .expect_err("same operation key must not complete another Issue");
        assert!(conflict.contains("another Issue"));
        assert_ne!(state.issues[2]["state"].as_str(), Some("done"));
    }

    #[test]
    fn mock_complete_and_close_use_one_versioned_state_mutation() {
        let mut state = initial_state();
        let actor = MockActor {
            actor_type: "user".to_string(),
            actor_id: MOCK_OWNER_USER_ID.to_string(),
            actor_name: "Ethan".to_string(),
            authenticated: false,
        };
        let complete_issue_id = state.issues[1]["id"]
            .as_str()
            .expect("complete Issue id")
            .to_string();
        state.issues[1]["state"] = json!("todo");
        state.issues[1]["status"] = json!("todo");
        state.issues[1]["notificationVersion"] = json!(7);
        let comment_count_before = state.issues[1]["commentCount"].as_u64().unwrap_or(0);
        let mut stale_delivery = delivery_item(
            "del_stale_complete",
            &state.agents[0],
            &state.issues[1],
            "pending",
        );
        stale_delivery["delivery"]["issueId"] = json!(complete_issue_id);
        state.deliveries.push(stale_delivery);

        let completed = complete_issue(
            &mut state,
            &complete_issue_id,
            Some(json!({ "resultComment": "Finished once" })),
            &actor,
        )
        .expect("completion should succeed");
        assert_eq!(completed.get("state").and_then(Value::as_str), Some("done"));
        assert_eq!(state.issues[1]["notificationVersion"].as_i64(), Some(8));
        assert_eq!(
            state.issues[1]["commentCount"].as_u64(),
            Some(comment_count_before + 1)
        );
        assert_eq!(
            state
                .deliveries
                .iter()
                .find(|item| item.pointer("/delivery/id").and_then(Value::as_str)
                    == Some("del_stale_complete"))
                .and_then(|item| item.pointer("/delivery/status"))
                .and_then(Value::as_str),
            Some("cancelled")
        );

        let close_issue_id = state.issues[2]["id"]
            .as_str()
            .expect("close Issue id")
            .to_string();
        state.issues[2]["state"] = json!("todo");
        state.issues[2]["status"] = json!("todo");
        state.issues[2]["notificationVersion"] = json!(3);
        transition_issue_state(
            &mut state,
            &close_issue_id,
            "closed",
            "issue.state_changed",
            &actor,
        )
        .expect("close should succeed");
        assert_eq!(state.issues[2]["state"].as_str(), Some("closed"));
        assert_eq!(state.issues[2]["notificationVersion"].as_i64(), Some(4));
    }

    #[test]
    fn mock_reclaim_preserves_original_version_and_rejects_stale_rollback() {
        let mut state = initial_state();
        let agent = state
            .agents
            .iter()
            .find(|agent| {
                agent.status == "active"
                    && agent.goal_id.as_deref() == Some("goal_mock_ui")
                    && agent.state_filter.iter().any(|state| state == "todo")
            })
            .cloned()
            .expect("eligible Agent");
        let actor = MockActor {
            actor_type: "registered_agent".to_string(),
            actor_id: agent.id.clone(),
            actor_name: agent.display_name.clone(),
            authenticated: true,
        };
        let issue_id = "iss_stale_rollback".to_string();
        state.issues.push(json!({
            "id": issue_id,
            "goalId": "goal_mock_ui",
            "title": "Stale rollback",
            "body": "Before update",
            "state": "todo",
            "status": "todo",
            "humanOnly": false,
            "assignee": null,
            "notificationVersion": 1
        }));

        let claimed = claim_issue(&mut state, &issue_id, None, &actor)
            .expect("initial self-claim should succeed");
        let claimed_version = claimed["notificationVersion"]
            .as_i64()
            .expect("claim version");
        assert_eq!(claimed_version, 2);
        let missing_rollback = cancel_issue_claim(
            &mut state,
            &issue_id,
            Some(json!({ "expectedNotificationVersion": claimed_version })),
            &actor,
        )
        .expect_err("Agent cancellation must declare local setup rollback");
        assert!(missing_rollback.contains("local setup rollback"));

        let user_actor = MockActor {
            actor_type: "user".to_string(),
            actor_id: MOCK_OWNER_USER_ID.to_string(),
            actor_name: "Ethan".to_string(),
            authenticated: false,
        };
        update_issue(
            &mut state,
            &issue_id,
            Some(json!({ "body": "Changed after claim" })),
            &user_actor,
        )
        .expect("post-claim update should succeed");

        let reclaimed = claim_issue(&mut state, &issue_id, None, &actor)
            .expect("idempotent re-claim should succeed");
        assert_eq!(
            reclaimed["notificationVersion"].as_i64(),
            Some(claimed_version)
        );
        let stale = cancel_issue_claim(
            &mut state,
            &issue_id,
            Some(json!({
                "rollback": true,
                "expectedNotificationVersion": claimed_version
            })),
            &actor,
        )
        .expect_err("stale rollback must be rejected");
        assert!(stale.contains("responsibility changed"));
        assert_eq!(
            state
                .issues
                .iter()
                .find(|issue| issue["id"].as_str() == Some(issue_id.as_str()))
                .and_then(|issue| issue.pointer("/assignee/id"))
                .and_then(Value::as_str),
            Some(agent.id.as_str())
        );
    }

    #[test]
    fn mock_contract_projects_account_plan_related_filter_and_presence() {
        let _mock = enable_for_test();
        let me = api_data_request("GET", "/api/me", None).expect("me should load");
        assert_eq!(
            me.pointer("/accountPlan/effectiveTier")
                .and_then(Value::as_str),
            Some("free")
        );

        let unrelated = api_data_request(
            "GET",
            "/api/spaces/official/issues?q=%E6%8A%8A%20Issue%20%E7%AE%A1%E7%90%86&related=me",
            None,
        )
        .expect("related issues should load");
        assert_eq!(
            unrelated
                .pointer("/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );

        let related = api_data_request(
            "GET",
            "/api/spaces/official/issues?q=Space%20tab&related=me",
            None,
        )
        .expect("Agent-comment relationship should load");
        assert_eq!(
            related.pointer("/items/0/id").and_then(Value::as_str),
            Some("iss_mock_002")
        );

        let (token, agent_id, disabled_token) = {
            let state = state().lock().expect("mock state poisoned");
            let agent = state
                .agents
                .iter()
                .find(|agent| agent.status == "active" && agent.device_id.is_some())
                .expect("active device-bound agent");
            let disabled_token = state
                .agents
                .iter()
                .find(|agent| agent.status != "active" && agent.device_id.is_some())
                .expect("disabled device-bound agent")
                .token
                .clone();
            (agent.token.clone(), agent.id.clone(), disabled_token)
        };
        let agents_before_touch =
            api_data_request("GET", "/api/spaces/official/registered-agents", None)
                .expect("registered agents should load before touch");
        let projected_before_touch = agents_before_touch
            .pointer("/items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(agent_id.as_str()))
            })
            .expect("projected agent before touch");
        assert_eq!(
            projected_before_touch
                .get("presence")
                .and_then(Value::as_str),
            Some("offline")
        );
        assert!(api_data_request_with_token(
            "POST",
            "/api/registered-agents/me/device-presence",
            Some(&disabled_token),
            Some(json!({})),
        )
        .is_err());
        let touched = api_data_request_with_token(
            "POST",
            "/api/registered-agents/me/device-presence",
            Some(&token),
            Some(json!({})),
        )
        .expect("presence touch should succeed");
        assert!(touched.get("onlineUntil").and_then(Value::as_str).is_some());

        let agents = api_data_request("GET", "/api/spaces/official/registered-agents", None)
            .expect("registered agents should load");
        let projected = agents
            .pointer("/items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(agent_id.as_str()))
            })
            .expect("projected agent");
        assert_eq!(
            projected.get("presence").and_then(Value::as_str),
            Some("online")
        );
        assert!(projected
            .get("lastOnlineAt")
            .and_then(Value::as_str)
            .is_some());

        {
            let mut state = state().lock().expect("mock state poisoned");
            let agent = state
                .agents
                .iter()
                .find(|agent| agent.id == agent_id)
                .cloned()
                .expect("touched agent");
            let key = mock_device_presence_key(&agent).expect("presence key");
            state.device_presence.insert(
                key,
                MockDevicePresence {
                    last_online_at: (chrono::Utc::now() - chrono::Duration::seconds(2))
                        .to_rfc3339(),
                    online_until: (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
                },
            );
        }
        let agents_after_expiry =
            api_data_request("GET", "/api/spaces/official/registered-agents", None)
                .expect("registered agents should load after expiry");
        let projected_after_expiry = agents_after_expiry
            .pointer("/items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(agent_id.as_str()))
            })
            .expect("projected agent after expiry");
        assert_eq!(
            projected_after_expiry
                .get("presence")
                .and_then(Value::as_str),
            Some("offline")
        );
    }

    #[test]
    fn event_cursor_advances_by_id_within_same_timestamp() {
        let event = mock_event(
            "evt_same_002",
            "issue.commented",
            "issue",
            "iss_same",
            "2026-06-24T10:00:00.000Z",
        );

        assert!(event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z|evt_same_001")
        ));
        assert!(!event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z|evt_same_002")
        ));
        assert!(!event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z")
        ));
    }

    #[test]
    fn goal_mutation_routes_create_update_and_archive_subtrees() {
        let _mock = enable_for_test();
        let official = api_data_request("GET", "/api/spaces/official", None)
            .expect("official space should load");
        let root_goal_id = official
            .pointer("/space/rootGoalId")
            .and_then(Value::as_str)
            .expect("root goal id");

        let created = api_data_request(
            "POST",
            "/api/spaces/official/goals",
            Some(json!({
                "parentGoalId": root_goal_id,
                "title": "Runtime Quality",
                "context": "Runtime acceptance work"
            })),
        )
        .expect("goal create should succeed");
        let child_id = created
            .pointer("/goal/id")
            .and_then(Value::as_str)
            .expect("created goal id")
            .to_string();
        assert_eq!(
            created
                .pointer("/goal/goalPathLabel")
                .and_then(Value::as_str),
            Some("MyAgents社区 / Runtime Quality")
        );

        let updated = api_data_request(
            "PATCH",
            &format!("/api/goals/{}", child_id),
            Some(json!({
                "title": "Runtime Reliability",
                "context": "Updated runtime acceptance work"
            })),
        )
        .expect("goal update should succeed");
        assert_eq!(
            updated.pointer("/goal/title").and_then(Value::as_str),
            Some("Runtime Reliability")
        );
        assert_eq!(
            updated
                .pointer("/goal/goalPathLabel")
                .and_then(Value::as_str),
            Some("MyAgents社区 / Runtime Reliability")
        );

        let linked_issue = api_data_request(
            "POST",
            "/api/spaces/official/issues",
            Some(json!({
                "goalId": child_id,
                "title": "Linked issue",
                "body": "Issue under archived goal"
            })),
        )
        .expect("linked issue should be created");
        let linked_issue_id = linked_issue
            .pointer("/issue/id")
            .and_then(Value::as_str)
            .expect("linked issue id")
            .to_string();

        let root_subtree_issues = api_data_request(
            "GET",
            &format!(
                "/api/spaces/official/issues?goalId={}&includeSubtree=true",
                root_goal_id
            ),
            None,
        )
        .expect("root subtree issues should list");
        let empty_subtree_issues = Vec::new();
        let root_subtree_issue_ids = root_subtree_issues
            .pointer("/items")
            .and_then(Value::as_array)
            .unwrap_or(&empty_subtree_issues)
            .iter()
            .filter_map(|issue| issue.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(root_subtree_issue_ids.contains(&linked_issue_id.as_str()));

        api_data_request(
            "POST",
            &format!("/api/issues/{}/claim", linked_issue_id),
            Some(json!({})),
        )
        .expect("linked issue should be claimable");
        let blocked_archive = api_data_request(
            "POST",
            &format!("/api/goals/{}/archive", child_id),
            Some(json!({})),
        );
        assert!(blocked_archive.is_err());
        api_data_request(
            "POST",
            &format!("/api/issues/{}/cancel-claim", linked_issue_id),
            Some(json!({})),
        )
        .expect("linked issue claim should be cancellable");

        let archived = api_data_request(
            "POST",
            &format!("/api/goals/{}/archive", child_id),
            Some(json!({})),
        )
        .expect("goal archive should succeed");
        assert_eq!(
            archived.pointer("/archived").and_then(Value::as_bool),
            Some(true)
        );

        let active_goals = api_data_request("GET", "/api/spaces/official/goals", None)
            .expect("active goals should list");
        let empty_active_goals = Vec::new();
        let active_ids = active_goals
            .pointer("/items")
            .and_then(Value::as_array)
            .unwrap_or(&empty_active_goals)
            .iter()
            .filter_map(|goal| goal.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(!active_ids.contains(&child_id.as_str()));

        let archived_goals = api_data_request(
            "GET",
            "/api/spaces/official/goals?includeArchived=true",
            None,
        )
        .expect("archived goals should list");
        let archived_child = archived_goals
            .pointer("/items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|goal| goal.get("id").and_then(Value::as_str) == Some(child_id.as_str()))
            })
            .expect("archived child remains queryable");
        assert!(archived_child.get("archivedAt").is_some());

        let issues = api_data_request(
            "GET",
            &format!("/api/spaces/official/issues?goalId={}", child_id),
            None,
        )
        .expect("archived goal issues should list as empty by default");
        assert_eq!(
            issues
                .pointer("/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );

        let create_under_archived = api_data_request(
            "POST",
            "/api/spaces/official/issues",
            Some(json!({
                "goalId": child_id,
                "title": "Should fail",
                "body": "Archived goal should reject new issues"
            })),
        );
        assert!(create_under_archived.is_err());

        let create_under_missing = api_data_request(
            "POST",
            "/api/spaces/official/issues",
            Some(json!({
                "goalId": "goal_missing",
                "title": "Should fail",
                "body": "Missing goal should reject new issues"
            })),
        );
        assert!(create_under_missing.is_err());

        let root_archive = api_data_request(
            "POST",
            &format!("/api/goals/{}/archive", root_goal_id),
            Some(json!({})),
        );
        assert!(root_archive.is_err());
    }
}
