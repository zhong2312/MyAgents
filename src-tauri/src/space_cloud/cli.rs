use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::device_identity::current_device_identity;
use crate::workspace_files::path_safety::validate_workspace_root;

use super::attachments::{
    cli_attachment_form, download_attachment_with_token, mock_attachment_metadata,
    prepare_cli_attachments, PreparedAttachment, SpaceDownloadAttachmentInput,
    SpaceUploadIssueAttachmentsInput,
};
use super::registered_agents::{
    effective_space_workspace_id, read_current_local_agents, LocalRegisteredAgent,
};
use super::{
    authorized_json_data_request_scoped, authorized_multipart_method_data_request_scoped,
    commit_refreshed_session, ensure_space_available, read_current_session,
    refresh_session_from_cloud, require_session, session_user_id, url_component,
    AuthenticatedSpaceSession, SpaceSession,
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SpaceCliActor {
    User {
        id: String,
        name: Option<String>,
        role: String,
    },
    RegisteredAgent {
        id: String,
        name: String,
        owner_user_id: String,
        owner_name: Option<String>,
        owner_role: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpaceCliSessionBinding {
    UserFallback,
    RegisteredAgentSession,
    LegacyAgentId,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliRegisteredAgentOrigin {
    pub space_id: String,
    pub registered_agent_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct SpaceCliContext {
    base_url: String,
    space_id: String,
    space_slug: String,
    space_name: String,
    pub(super) actor: SpaceCliActor,
    token: String,
    workspace_id: Option<String>,
    workspace_path: PathBuf,
    session_binding: SpaceCliSessionBinding,
    pub(super) user_session: Option<AuthenticatedSpaceSession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueGetInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub comments_cursor: Option<String>,
    #[serde(default)]
    pub comments_limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueListInput {
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub include_subtree: Option<bool>,
    #[serde(default)]
    pub human_only: Option<bool>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueCommentInput {
    pub issue_id: String,
    pub body: String,
    pub space_slug: String,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueCommentsInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueCommentGetInput {
    pub issue_id: String,
    pub comment_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueStatusInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(alias = "status")]
    pub state: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueClaimInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueActionInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub result_comment: Option<String>,
    #[serde(default)]
    pub operation_key: Option<String>,
    #[serde(default)]
    pub operation_key_subject: Option<String>,
    #[serde(default)]
    pub rollback: Option<bool>,
    #[serde(default)]
    pub expected_notification_version: Option<i64>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliClaimLocalTaskInput {
    pub claim_id: String,
    pub local_task_id: String,
    pub local_session_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliAttachmentDownloadInput {
    pub attachment_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliContextInput {
    pub space_slug: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliGoalListInput {
    pub space_slug: String,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action")]
pub enum SpaceCliIssueGoalUpdate {
    #[serde(rename = "set")]
    Set {
        #[serde(rename = "goalId")]
        goal_id: String,
    },
    #[serde(rename = "clear")]
    Clear,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueUpdateInput {
    pub issue_id: String,
    pub space_slug: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub goal_update: Option<SpaceCliIssueGoalUpdate>,
    #[serde(default)]
    pub human_only: Option<bool>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueCreateInput {
    pub space_slug: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    #[serde(default)]
    pub human_only: Option<bool>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliAttachmentAddInput {
    pub space_slug: String,
    pub issue_id: String,
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_origin: Option<SpaceCliRegisteredAgentOrigin>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

pub async fn space_cli_space_list() -> Result<Value, String> {
    let session = refresh_cli_session().await?;
    let items = session
        .spaces
        .iter()
        .filter_map(|space| {
            Some(serde_json::json!({
                "slug": space.get("slug")?.as_str()?,
                "name": space.get("name").and_then(Value::as_str),
                "role": cli_space_role(space),
            }))
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "items": items }))
}

pub async fn space_cli_whoami(input: SpaceCliContextInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    Ok(space_cli_context_json(&context))
}

pub async fn space_cli_assignee_list(input: SpaceCliContextInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let data = authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/spaces/{}/assignee-candidates",
            url_component(&context.space_slug)
        ),
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await?;
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let assignee_id = item.get("assigneeId")?.as_str()?;
            let identity_type = item.get("type")?.as_str()?;
            let mut projected = serde_json::json!({
                "assigneeId": assignee_id,
                "type": identity_type,
                "name": item.get("name").cloned().unwrap_or(Value::Null),
                "isSelf": item.get("isSelf").and_then(Value::as_bool).unwrap_or(false),
            });
            if identity_type == "registered_agent" {
                projected["owner"] = serde_json::json!({
                    "name": item.pointer("/owner/name").cloned().unwrap_or(Value::Null),
                });
            }
            Some(projected)
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "items": items }))
}

pub async fn space_cli_goal_list(input: SpaceCliGoalListInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let archived_query = if input.include_archived {
        "?includeArchived=true"
    } else {
        ""
    };
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/spaces/{}/goals{}",
            url_component(&context.space_slug),
            archived_query
        ),
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

fn parse_cli_assignee(value: Option<&str>) -> Result<Option<Value>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let (kind, id) = value.split_once(':').ok_or_else(|| {
        "ASSIGNEE_ID_INVALID: Use a typed ID returned by `myagents space assignee list --json`, such as agent:<id> or user:<id>.".to_string()
    })?;
    if id.trim().is_empty() {
        return Err("ASSIGNEE_ID_INVALID: Assignee ID is empty.".to_string());
    }
    let actor_type = match kind {
        "agent" => "registered_agent",
        "user" => "user",
        _ => {
            return Err(
                "ASSIGNEE_ID_INVALID: Assignee ID must start with agent: or user:.".to_string(),
            )
        }
    };
    Ok(Some(
        serde_json::json!({ "type": actor_type, "id": id.trim() }),
    ))
}

pub async fn space_cli_issue_create(input: SpaceCliIssueCreateInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let mut payload = serde_json::json!({
        "title": input.title,
        "body": input.body,
        "goalId": input.goal_id,
        "assignee": parse_cli_assignee(input.assignee_id.as_deref())?,
        "humanOnly": input.human_only.unwrap_or(false),
    });
    let path = format!("/api/spaces/{}/issues", url_component(&context.space_slug));
    if input.file_paths.is_empty() {
        return authorized_json_data_request_scoped(
            &context.base_url,
            &path,
            &context.token,
            reqwest::Method::POST,
            Some(payload),
            Some(&context.space_id),
            context.user_session.as_ref(),
        )
        .await;
    }
    let attachments = prepare_cli_attachments(&context.workspace_path, &input.file_paths)?;
    if crate::space_cloud_mock::is_enabled() {
        payload["attachments"] = Value::Array(mock_attachment_metadata(&attachments));
        return crate::space_cloud_mock::api_data_request_with_token(
            "POST",
            &path,
            Some(&context.token),
            Some(payload),
        );
    }
    let form = cli_attachment_form(payload, attachments)?;
    authorized_multipart_method_data_request_scoped(
        reqwest::Method::POST,
        &context.base_url,
        &path,
        &context.token,
        form,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_attachment_add(input: SpaceCliAttachmentAddInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    if input.file_paths.is_empty() {
        return Err("ATTACHMENT_REQUIRED: Provide at least one --file <path>.".to_string());
    }
    let attachments = prepare_cli_attachments(&context.workspace_path, &input.file_paths)?;
    if crate::space_cloud_mock::is_enabled() {
        let mock_input = SpaceUploadIssueAttachmentsInput {
            issue_id: input.issue_id,
            file_paths: attachments
                .iter()
                .map(|attachment| attachment.path.to_string_lossy().to_string())
                .collect(),
        };
        return match &context.actor {
            SpaceCliActor::RegisteredAgent { id, .. } => {
                crate::space_cloud_mock::upload_issue_attachments_as_registered_agent(
                    mock_input, id,
                )
            }
            SpaceCliActor::User { .. } => {
                crate::space_cloud_mock::upload_issue_attachments(mock_input)
            }
        };
    }
    let form = cli_attachment_form(serde_json::json!({}), attachments)?;
    authorized_multipart_method_data_request_scoped(
        reqwest::Method::POST,
        &context.base_url,
        &format!(
            "/api/issues/{}/attachments",
            url_component(input.issue_id.trim())
        ),
        &context.token,
        form,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_attachment_inspect(
    input: SpaceCliAttachmentAddInput,
) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let attachments = prepare_cli_attachments(&context.workspace_path, &input.file_paths)?;
    Ok(serde_json::json!({
        "items": attachments.iter().map(|attachment| serde_json::json!({
            "path": attachment.path.to_string_lossy(),
            "name": attachment.name,
            "sizeBytes": attachment.size_bytes,
            "mimeType": attachment.mime_type,
        })).collect::<Vec<_>>()
    }))
}

pub async fn space_cli_issue_get(input: SpaceCliIssueGetInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let path = format!("/api/issues/{}", url_component(input.issue_id.trim()));
    authorized_json_data_request_scoped(
        &context.base_url,
        &path,
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

fn space_cli_issue_update_payload(input: &SpaceCliIssueUpdateInput) -> Result<Value, String> {
    let mut payload = serde_json::Map::new();
    if let Some(title) = &input.title {
        payload.insert("title".to_string(), Value::String(title.clone()));
    }
    if let Some(body) = &input.body {
        payload.insert("body".to_string(), Value::String(body.clone()));
    }
    if let Some(goal_update) = &input.goal_update {
        let goal_id = match goal_update {
            SpaceCliIssueGoalUpdate::Set { goal_id } => {
                let goal_id = goal_id.trim();
                if goal_id.is_empty() {
                    return Err(
                        "GOAL_ID_REQUIRED: --goal requires a non-empty Goal ID.".to_string()
                    );
                }
                Value::String(goal_id.to_string())
            }
            SpaceCliIssueGoalUpdate::Clear => Value::Null,
        };
        payload.insert("goalId".to_string(), goal_id);
    }
    if let Some(human_only) = input.human_only {
        payload.insert("humanOnly".to_string(), Value::Bool(human_only));
    }
    if payload.is_empty() {
        return Err(
            "ISSUE_UPDATE_EMPTY: Provide at least one Issue metadata field to update.".to_string(),
        );
    }
    Ok(Value::Object(payload))
}

pub async fn space_cli_issue_update(input: SpaceCliIssueUpdateInput) -> Result<Value, String> {
    let payload = space_cli_issue_update_payload(&input)?;
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!("/api/issues/{}", url_component(input.issue_id.trim())),
        &context.token,
        reqwest::Method::PATCH,
        Some(payload),
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_list(input: SpaceCliIssueListInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(goal_id) = input.goal_id.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("goalId".to_string(), goal_id.trim().to_string()));
    }
    if let Some(state) = input.state.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("state".to_string(), state.trim().to_string()));
    }
    if let Some(include_subtree) = input.include_subtree {
        params.push(("includeSubtree".to_string(), include_subtree.to_string()));
    }
    if let Some(human_only) = input.human_only {
        params.push(("humanOnly".to_string(), human_only.to_string()));
    }
    if let Some(query) = input.query.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("q".to_string(), query.trim().to_string()));
    }
    if let Some(cursor) = input.cursor.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("cursor".to_string(), cursor.trim().to_string()));
    }
    params.push((
        "limit".to_string(),
        input.limit.unwrap_or(30).clamp(1, 100).to_string(),
    ));
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{}={}", key, url_component(&value)))
        .collect::<Vec<_>>()
        .join("&");
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/spaces/{}/issues?{}",
            url_component(&context.space_slug),
            query
        ),
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_comment(input: SpaceCliIssueCommentInput) -> Result<Value, String> {
    if input.body.trim().is_empty() && input.file_paths.is_empty() {
        return Err(
            "COMMENT_CONTENT_REQUIRED: Provide comment text, at least one attachment, or both."
                .to_string(),
        );
    }
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let path = format!(
        "/api/issues/{}/comments",
        url_component(input.issue_id.trim())
    );
    if input.file_paths.is_empty() {
        return authorized_json_data_request_scoped(
            &context.base_url,
            &path,
            &context.token,
            reqwest::Method::POST,
            Some(serde_json::json!({ "body": input.body })),
            Some(&context.space_id),
            context.user_session.as_ref(),
        )
        .await;
    }
    let attachments = prepare_cli_attachments(&context.workspace_path, &input.file_paths)?;
    let mut payload = serde_json::json!({ "body": input.body });
    if crate::space_cloud_mock::is_enabled() {
        payload["attachments"] = Value::Array(mock_attachment_metadata(&attachments));
        return crate::space_cloud_mock::api_data_request_with_token(
            "POST",
            &path,
            Some(&context.token),
            Some(payload),
        );
    }
    let form = cli_attachment_form(payload, attachments)?;
    authorized_multipart_method_data_request_scoped(
        reqwest::Method::POST,
        &context.base_url,
        &path,
        &context.token,
        form,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_comments(input: SpaceCliIssueCommentsInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let mut path = format!(
        "/api/issues/{}/comments?limit={}",
        url_component(input.issue_id.trim()),
        input.limit.unwrap_or(20).clamp(1, 100)
    );
    if let Some(cursor) = input
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        path.push_str("&cursor=");
        path.push_str(&url_component(cursor));
    }
    authorized_json_data_request_scoped(
        &context.base_url,
        &path,
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_comment_get(
    input: SpaceCliIssueCommentGetInput,
) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/issues/{}/comments/{}",
            url_component(input.issue_id.trim()),
            url_component(input.comment_id.trim())
        ),
        &context.token,
        reqwest::Method::GET,
        None,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_status(input: SpaceCliIssueStatusInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/issues/{}/status",
            url_component(input.issue_id.trim())
        ),
        &context.token,
        reqwest::Method::POST,
        Some(serde_json::json!({ "state": input.state })),
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_claim(input: SpaceCliIssueClaimInput) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!("/api/issues/{}/claim", url_component(input.issue_id.trim())),
        &context.token,
        reqwest::Method::POST,
        Some(serde_json::json!({ "deliveryId": input.delivery_id })),
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_issue_close(input: SpaceCliIssueActionInput) -> Result<Value, String> {
    space_cli_issue_action(input, "close", None).await
}

pub async fn space_cli_issue_complete(input: SpaceCliIssueActionInput) -> Result<Value, String> {
    let body = serde_json::json!({
        "resultComment": input.result_comment.as_deref(),
        "operationKey": input.operation_key.as_deref(),
    });
    space_cli_issue_action(input, "complete", Some(body)).await
}

pub async fn space_cli_issue_cancel_claim(
    input: SpaceCliIssueActionInput,
) -> Result<Value, String> {
    let body = serde_json::json!({
        "rollback": input.rollback,
        "expectedNotificationVersion": input.expected_notification_version,
    });
    space_cli_issue_action(input, "cancel-claim", Some(body)).await
}

async fn space_cli_issue_action(
    input: SpaceCliIssueActionInput,
    action: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let path = format!(
        "/api/issues/{}/{}",
        url_component(input.issue_id.trim()),
        action
    );
    if action == "complete" && !input.file_paths.is_empty() {
        let attachments = prepare_cli_attachments(&context.workspace_path, &input.file_paths)?;
        let mut payload = body.unwrap_or_else(|| serde_json::json!({}));
        let base_operation_key = input
            .operation_key
            .as_deref()
            .or(input.operation_key_subject.as_deref())
            .ok_or_else(|| {
                "OPERATION_KEY_REQUIRED: Issue completion with attachments requires an idempotency subject."
                    .to_string()
            })?;
        let operation_key =
            complete_operation_key_for_attachments(base_operation_key, &attachments);
        payload["operationKey"] = Value::String(operation_key.clone());
        if crate::space_cloud_mock::is_enabled() {
            payload["attachments"] = Value::Array(mock_attachment_metadata(&attachments));
            let mut result = crate::space_cloud_mock::api_data_request_with_token(
                "POST",
                &path,
                Some(&context.token),
                Some(payload),
            )?;
            if let Some(object) = result.as_object_mut() {
                object.insert("operationKey".to_string(), Value::String(operation_key));
            }
            return Ok(result);
        }
        let form = cli_attachment_form(payload, attachments)?;
        let mut result = authorized_multipart_method_data_request_scoped(
            reqwest::Method::POST,
            &context.base_url,
            &path,
            &context.token,
            form,
            Some(&context.space_id),
            context.user_session.as_ref(),
        )
        .await?;
        if let Some(object) = result.as_object_mut() {
            object.insert("operationKey".to_string(), Value::String(operation_key));
        }
        return Ok(result);
    }
    authorized_json_data_request_scoped(
        &context.base_url,
        &path,
        &context.token,
        reqwest::Method::POST,
        body,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub(super) fn complete_operation_key_for_attachments(
    base_operation_key: &str,
    attachments: &[PreparedAttachment],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_operation_key.as_bytes());
    for attachment in attachments {
        hasher.update([0]);
        hasher.update(attachment.name.as_bytes());
        hasher.update((attachment.bytes.len() as u64).to_le_bytes());
        hasher.update(&attachment.bytes);
    }
    format!("desktop-complete-{:x}", hasher.finalize())
}

pub async fn space_cli_claim_local_task(
    input: SpaceCliClaimLocalTaskInput,
) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    authorized_json_data_request_scoped(
        &context.base_url,
        &format!(
            "/api/claims/{}/local-task",
            url_component(input.claim_id.trim())
        ),
        &context.token,
        reqwest::Method::POST,
        Some(serde_json::json!({
            "localTaskId": input.local_task_id,
            "localSessionId": input.local_session_id,
        })),
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await
}

pub async fn space_cli_attachment_download(
    input: SpaceCliAttachmentDownloadInput,
) -> Result<Value, String> {
    let context = resolve_space_cli_context(
        &input.space_slug,
        input.session_origin.as_ref(),
        input.workspace_id.as_deref(),
        input.workspace_path.as_deref(),
        input.agent_id.as_deref(),
    )
    .await?;
    let download = SpaceDownloadAttachmentInput {
        attachment_id: input.attachment_id.trim().to_string(),
        workspace_path: context.workspace_path.to_string_lossy().to_string(),
        issue_id: input.issue_id,
        file_name: None,
        registered_agent_id: None,
        output: input.output,
    };
    let result = download_attachment_with_token(
        &context.base_url,
        &context.token,
        &download,
        Some(&context.space_id),
        context.user_session.as_ref(),
    )
    .await?;
    serde_json::to_value(result)
        .map_err(|e| format!("Failed to serialize attachment result: {}", e))
}

fn canonical_workspace_paths_equal(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => {
            if cfg!(windows) {
                left.to_string_lossy()
                    .eq_ignore_ascii_case(&right.to_string_lossy())
            } else {
                left == right
            }
        }
        _ => false,
    }
}

pub(super) fn cli_workspace_matches(
    agent: &LocalRegisteredAgent,
    workspace_id: Option<&str>,
    workspace_root: &Path,
) -> bool {
    let requested_id = workspace_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let agent_id = effective_space_workspace_id(agent)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (requested_id, agent_id) {
        (Some(requested_id), Some(agent_id)) => return requested_id == agent_id,
        (None, Some(_)) => return false,
        // A caller-supplied stable id is identity evidence, not a hint. A
        // legacy registration without an id cannot satisfy it by path.
        (Some(_), None) => return false,
        (None, None) => {}
    }
    validate_workspace_root(&agent.workspace_path)
        .map(|candidate| canonical_workspace_paths_equal(&candidate, workspace_root))
        .unwrap_or(false)
}

pub(super) fn cli_agent_owner_binding_is_valid(
    agent: &LocalRegisteredAgent,
    user_id: &str,
    device_id: &str,
    role: &str,
) -> bool {
    agent.owner_user_id.as_deref() == Some(user_id)
        && agent.device_id.as_deref() == Some(device_id)
        && matches!(role, "owner" | "admin")
        && !agent.token.trim().is_empty()
}

fn cli_space_item<'a>(session: &'a SpaceSession, slug: &str) -> Option<&'a Value> {
    session
        .spaces
        .iter()
        .find(|item| item.get("slug").and_then(Value::as_str).map(str::trim) == Some(slug))
}

fn cli_space_role(space: &Value) -> String {
    space
        .get("membership")
        .and_then(|membership| membership.get("role"))
        .and_then(Value::as_str)
        .or_else(|| space.get("role").and_then(Value::as_str))
        .unwrap_or("member")
        .to_string()
}

async fn refresh_cli_session() -> Result<AuthenticatedSpaceSession, String> {
    let session = require_session()?;
    let refreshed = refresh_session_from_cloud(&session).await?;
    let refreshed = if !crate::space_cloud_mock::is_enabled() {
        commit_refreshed_session(refreshed).await?
    } else {
        refreshed
    };
    AuthenticatedSpaceSession::from_account(refreshed, session.session_path().to_path_buf())
}

pub(super) async fn resolve_space_cli_context(
    explicit_space_slug: &str,
    session_origin: Option<&SpaceCliRegisteredAgentOrigin>,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    legacy_agent_id: Option<&str>,
) -> Result<SpaceCliContext, String> {
    ensure_space_available()?;
    let slug = explicit_space_slug.trim();
    if slug.is_empty() {
        return Err("SPACE_REQUIRED: This command requires --space <slug>.".to_string());
    }
    let (session, user_session) = if session_origin.is_some() {
        let session = read_current_session()?
            .ok_or_else(|| "NOT_AUTHENTICATED: Not logged in to MyAgents Space.".to_string())?;
        (session, None)
    } else {
        let authenticated = refresh_cli_session().await?;
        (authenticated.account.clone(), Some(authenticated))
    };
    let space = cli_space_item(&session, slug).ok_or_else(|| {
        format!(
            "SPACE_NOT_AVAILABLE: Space '{}' is not available to the current user.",
            slug
        )
    })?;
    let space_id = space
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SPACE_CONTEXT_INVALID: Selected Space has no stable ID.".to_string())?
        .to_string();
    let space_name = space
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(slug)
        .to_string();
    let role = cli_space_role(space);
    let user_id = session_user_id(&session).ok_or_else(|| {
        "SPACE_CONTEXT_INVALID: Current Space session has no user ID.".to_string()
    })?;
    let user_name = session
        .user
        .get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let identity = current_device_identity()?;
    let agents = read_current_local_agents()?;
    let origin_agent_id = session_origin
        .map(|origin| origin.registered_agent_id.trim())
        .filter(|value| !value.is_empty());
    if session_origin.is_some() && origin_agent_id.is_none() {
        return Err(
            "SPACE_AGENT_BINDING_INVALID: Registered Agent Session origin has no stable Agent ID."
                .to_string(),
        );
    }
    let hinted_agent_id = origin_agent_id.or_else(|| {
        legacy_agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
    });
    let legacy_workspace = hinted_agent_id
        .map(str::trim)
        .and_then(|id| agents.iter().find(|agent| agent.id == id))
        .map(|agent| agent.workspace_path.as_str());
    let workspace = workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(legacy_workspace)
        .ok_or_else(|| {
            "WORKSPACE_REQUIRED: Space CLI commands require the current workspace path.".to_string()
        })?;
    let workspace_root = validate_workspace_root(workspace)?;

    if let Some(origin) = session_origin {
        let origin_space_id = origin.space_id.trim();
        if origin_space_id.is_empty() || origin_space_id != space_id {
            return Err("SPACE_AGENT_BINDING_INVALID: Registered Agent Session origin does not match the selected Space.".to_string());
        }
        let requested_agent_id = origin_agent_id.expect("validated above");
        if legacy_agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|legacy_id| legacy_id != requested_agent_id)
        {
            return Err("SPACE_AGENT_BINDING_INVALID: Explicit legacy Agent ID conflicts with the Registered Agent Session origin.".to_string());
        }
        let agent = agents
            .iter()
            .find(|agent| agent.id == requested_agent_id)
            .ok_or_else(|| "SPACE_AGENT_BINDING_INVALID: The Registered Agent from this Session origin is no longer present locally. Restore or re-register it; do not retry as the User actor.".to_string())?;
        let valid = agent.status == "active"
            && agent.space_id == space_id
            && cli_workspace_matches(agent, workspace_id, &workspace_root)
            && cli_agent_owner_binding_is_valid(agent, &user_id, &identity.device_id, &role);
        if !valid {
            return Err("SPACE_AGENT_BINDING_INVALID: This Session origin no longer matches an active Registered Agent for the selected Space and workspace. Do not retry as the User actor.".to_string());
        }
        return Ok(SpaceCliContext {
            base_url: session.base_url.clone(),
            space_id,
            space_slug: slug.to_string(),
            space_name,
            actor: SpaceCliActor::RegisteredAgent {
                id: agent.id.clone(),
                name: agent.display_name.clone(),
                owner_user_id: user_id,
                owner_name: user_name,
                owner_role: role,
            },
            token: agent.token.clone(),
            workspace_id: effective_space_workspace_id(agent).map(ToString::to_string),
            workspace_path: workspace_root,
            session_binding: SpaceCliSessionBinding::RegisteredAgentSession,
            user_session: None,
        });
    }

    let requested_agent_id = legacy_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let matches = requested_agent_id
        .map(|requested_agent_id| {
            agents
                .iter()
                .filter(|agent| {
                    agent.status == "active"
                        && agent.space_id == space_id
                        && agent.id == requested_agent_id
                        && cli_workspace_matches(agent, workspace_id, &workspace_root)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if requested_agent_id.is_some() && matches.is_empty() {
        return Err("SPACE_AGENT_BINDING_INVALID: The requested legacy Registered Agent does not match the selected Space and workspace.".to_string());
    }
    if let Some(agent) = matches.first() {
        if !cli_agent_owner_binding_is_valid(agent, &user_id, &identity.device_id, &role) {
            return Err("SPACE_AGENT_BINDING_INVALID: The active Registered Agent for this Space and workspace no longer matches the current owner, device, role, or token. Do not retry as the User actor.".to_string());
        }
        return Ok(SpaceCliContext {
            base_url: session.base_url.clone(),
            space_id,
            space_slug: slug.to_string(),
            space_name,
            actor: SpaceCliActor::RegisteredAgent {
                id: agent.id.clone(),
                name: agent.display_name.clone(),
                owner_user_id: user_id,
                owner_name: user_name,
                owner_role: role,
            },
            token: agent.token.clone(),
            workspace_id: effective_space_workspace_id(agent).map(ToString::to_string),
            workspace_path: workspace_root,
            session_binding: SpaceCliSessionBinding::LegacyAgentId,
            user_session: None,
        });
    }
    Ok(SpaceCliContext {
        base_url: session.base_url.clone(),
        space_id,
        space_slug: slug.to_string(),
        space_name,
        actor: SpaceCliActor::User {
            id: user_id,
            name: user_name,
            role,
        },
        token: user_session
            .as_ref()
            .map(AuthenticatedSpaceSession::session_token)
            .map(ToString::to_string)
            .ok_or_else(|| {
                "SPACE_REAUTH_REQUIRED: MyAgents Space login is required.".to_string()
            })?,
        workspace_id: workspace_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        workspace_path: workspace_root,
        session_binding: SpaceCliSessionBinding::UserFallback,
        user_session,
    })
}

fn space_cli_context_json(context: &SpaceCliContext) -> Value {
    let source = match context.session_binding {
        SpaceCliSessionBinding::UserFallback => "user_session",
        SpaceCliSessionBinding::RegisteredAgentSession => "registered_agent_session",
        SpaceCliSessionBinding::LegacyAgentId => "registered_agent_legacy_id",
    };
    let actor = match &context.actor {
        SpaceCliActor::User { id, name, role } => serde_json::json!({
            "type": "user",
            "id": id,
            "name": name,
            "source": source,
            "role": role,
        }),
        SpaceCliActor::RegisteredAgent {
            id,
            name,
            owner_user_id,
            owner_name,
            owner_role,
        } => serde_json::json!({
            "type": "registered_agent",
            "id": id,
            "name": name,
            "source": source,
            "owner": {
                "id": owner_user_id,
                "name": owner_name,
                "role": owner_role,
            },
        }),
    };
    serde_json::json!({
        "space": {
            "slug": context.space_slug,
            "name": context.space_name,
        },
        "actor": actor,
        "workspace": {
            "id": context.workspace_id,
            "path": context.workspace_path.to_string_lossy(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_issue_update_payload_preserves_missing_set_clear_and_false() {
        let empty = SpaceCliIssueUpdateInput {
            issue_id: "iss_test".to_string(),
            space_slug: "official".to_string(),
            title: None,
            body: None,
            goal_update: None,
            human_only: None,
            session_id: None,
            session_origin: None,
            workspace_id: None,
            workspace_path: None,
            agent_id: None,
        };
        assert!(space_cli_issue_update_payload(&empty)
            .expect_err("empty updates must fail locally")
            .starts_with("ISSUE_UPDATE_EMPTY:"));
        let empty_goal = SpaceCliIssueUpdateInput {
            goal_update: Some(SpaceCliIssueGoalUpdate::Set {
                goal_id: "  ".to_string(),
            }),
            ..empty
        };
        assert!(space_cli_issue_update_payload(&empty_goal)
            .expect_err("empty Goal IDs must fail locally")
            .starts_with("GOAL_ID_REQUIRED:"));

        let base = SpaceCliIssueUpdateInput {
            issue_id: "iss_test".to_string(),
            space_slug: "official".to_string(),
            title: Some("Updated title".to_string()),
            body: Some("Updated body".to_string()),
            goal_update: None,
            human_only: Some(false),
            session_id: None,
            session_origin: None,
            workspace_id: None,
            workspace_path: None,
            agent_id: None,
        };
        assert_eq!(
            space_cli_issue_update_payload(&base).expect("metadata payload"),
            serde_json::json!({
                "title": "Updated title",
                "body": "Updated body",
                "humanOnly": false
            })
        );

        let set = SpaceCliIssueGoalUpdate::Set {
            goal_id: " goal_current ".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&set).expect("tagged set serialization"),
            serde_json::json!({ "action": "set", "goalId": " goal_current " })
        );
        let set_input = SpaceCliIssueUpdateInput {
            title: None,
            body: None,
            goal_update: Some(set),
            human_only: None,
            ..base
        };
        assert_eq!(
            space_cli_issue_update_payload(&set_input).expect("set Goal payload"),
            serde_json::json!({ "goalId": "goal_current" })
        );

        let clear_input = SpaceCliIssueUpdateInput {
            title: None,
            body: None,
            goal_update: Some(SpaceCliIssueGoalUpdate::Clear),
            human_only: None,
            ..set_input
        };
        assert_eq!(
            space_cli_issue_update_payload(&clear_input).expect("clear Goal payload"),
            serde_json::json!({ "goalId": null })
        );
        assert_eq!(
            serde_json::to_value(SpaceCliIssueGoalUpdate::Clear)
                .expect("tagged clear serialization"),
            serde_json::json!({ "action": "clear" })
        );
    }
}
