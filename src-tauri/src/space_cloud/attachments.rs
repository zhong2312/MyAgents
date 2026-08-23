use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use reqwest::header::CONTENT_DISPOSITION;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::workspace_files::path_safety::{
    read_workspace_file_no_follow, validate_workspace_root, write_workspace_file_no_follow,
};

use super::{
    authorized_json_data_request, authorized_multipart_data_request,
    authorized_raw_request_with_credential, filename_from_content_disposition,
    inspect_local_file_no_follow, read_local_file_no_follow, require_session, safe_local_filename,
    safe_local_name, url_component, AuthenticatedSpaceSession, SpaceCommandError,
    SpaceCommandResult,
};

const MAX_ATTACHMENT_DOWNLOAD_BYTES: usize = 25 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_UPLOAD_COUNT: usize = 5;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCreateIssueWithAttachmentsInput {
    pub space_id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub parent_issue_id: Option<String>,
    #[serde(default)]
    pub human_only: Option<bool>,
    #[serde(default)]
    pub assignee: Option<Value>,
    #[serde(default)]
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCommentIssueWithAttachmentsInput {
    pub issue_id: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUploadIssueAttachmentsInput {
    pub issue_id: String,
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDownloadAttachmentInput {
    pub attachment_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub registered_agent_id: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDownloadAttachmentResult {
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub size_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInspectAttachmentDraftsInput {
    #[serde(default)]
    pub file_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceAttachmentDraftMetadata {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub mime_type: String,
}

#[derive(Debug)]
pub(super) struct PreparedAttachment {
    pub(super) path: PathBuf,
    pub(super) name: String,
    pub(super) mime_type: &'static str,
    pub(super) size_bytes: u64,
    pub(super) bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
enum AttachmentReadScope<'a> {
    ExplicitSelection,
    Workspace(&'a Path),
}

fn prepare_attachments(
    file_paths: &[String],
    scope: AttachmentReadScope<'_>,
    require_non_empty: bool,
) -> Result<Vec<PreparedAttachment>, String> {
    if require_non_empty && file_paths.is_empty() {
        return Err("ATTACHMENT_REQUIRED: Select at least one attachment.".to_string());
    }
    if file_paths.len() > MAX_ATTACHMENT_UPLOAD_COUNT {
        return Err(format!(
            "ATTACHMENT_COUNT_EXCEEDED: At most {} attachments can be uploaded at once.",
            MAX_ATTACHMENT_UPLOAD_COUNT
        ));
    }
    file_paths
        .iter()
        .map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("ATTACHMENT_PATH_INVALID: Attachment path is empty.".to_string());
            }
            let (path, bytes) = match scope {
                AttachmentReadScope::ExplicitSelection => {
                    let path = PathBuf::from(trimmed);
                    if !path.is_absolute() {
                        return Err("ATTACHMENT_PATH_INVALID: Attachment path must be absolute."
                            .to_string());
                    }
                    let bytes =
                        read_local_file_no_follow(&path, MAX_ATTACHMENT_UPLOAD_BYTES, "Attachment")
                            .map_err(|error| format!("ATTACHMENT_PATH_INVALID: {}", error))?;
                    (path, bytes)
                }
                AttachmentReadScope::Workspace(workspace_root) => read_workspace_file_no_follow(
                    workspace_root,
                    trimmed,
                    MAX_ATTACHMENT_UPLOAD_BYTES,
                )
                .map_err(|error| {
                    let code = if error.contains("exceeds") {
                        "ATTACHMENT_TOO_LARGE"
                    } else if error.contains("escapes") {
                        "ATTACHMENT_OUTSIDE_WORKSPACE"
                    } else if error.contains("symlink") {
                        "ATTACHMENT_SYMLINK_REJECTED"
                    } else if error.contains("regular file") {
                        "ATTACHMENT_NOT_FILE"
                    } else {
                        "ATTACHMENT_NOT_FOUND"
                    };
                    format!("{}: {}", code, error)
                })?,
            };
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(safe_local_filename)
                .unwrap_or_else(|| "attachment".to_string());
            Ok(PreparedAttachment {
                path: path.clone(),
                name,
                mime_type: attachment_mime_type(&path),
                size_bytes: bytes.len() as u64,
                bytes,
            })
        })
        .collect()
}

fn prepare_gui_attachments(file_paths: &[String]) -> Result<Vec<PreparedAttachment>, String> {
    prepare_attachments(file_paths, AttachmentReadScope::ExplicitSelection, true)
}

fn inspect_gui_attachments(
    file_paths: &[String],
) -> Result<Vec<SpaceAttachmentDraftMetadata>, String> {
    if file_paths.is_empty() {
        return Err("ATTACHMENT_REQUIRED: Select at least one attachment.".to_string());
    }
    if file_paths.len() > MAX_ATTACHMENT_UPLOAD_COUNT {
        return Err(format!(
            "ATTACHMENT_COUNT_EXCEEDED: At most {} attachments can be uploaded at once.",
            MAX_ATTACHMENT_UPLOAD_COUNT
        ));
    }
    file_paths
        .iter()
        .map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("ATTACHMENT_PATH_INVALID: Attachment path is empty.".to_string());
            }
            let path = PathBuf::from(trimmed);
            if !path.is_absolute() {
                return Err(
                    "ATTACHMENT_PATH_INVALID: Attachment path must be absolute.".to_string()
                );
            }
            let size_bytes =
                inspect_local_file_no_follow(&path, MAX_ATTACHMENT_UPLOAD_BYTES, "Attachment")
                    .map_err(|error| format!("ATTACHMENT_PATH_INVALID: {}", error))?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(safe_local_filename)
                .unwrap_or_else(|| "attachment".to_string());
            Ok(SpaceAttachmentDraftMetadata {
                path: path.to_string_lossy().to_string(),
                name,
                size_bytes,
                mime_type: attachment_mime_type(&path).to_string(),
            })
        })
        .collect()
}

fn attachment_form(
    payload: Value,
    attachments: Vec<PreparedAttachment>,
) -> Result<reqwest::multipart::Form, String> {
    let mut form = reqwest::multipart::Form::new().text("payload", payload.to_string());
    for attachment in attachments {
        let part = reqwest::multipart::Part::bytes(attachment.bytes)
            .file_name(attachment.name)
            .mime_str(attachment.mime_type)
            .map_err(|e| format!("Failed to build attachment upload part: {}", e))?;
        form = form.part("file", part);
    }
    Ok(form)
}

pub(super) fn mock_attachment_metadata(attachments: &[PreparedAttachment]) -> Vec<Value> {
    attachments
        .iter()
        .map(|attachment| {
            serde_json::json!({
                "name": attachment.name,
                "sizeBytes": attachment.size_bytes,
                "mimeType": attachment.mime_type,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn cmd_space_inspect_attachment_drafts(
    input: SpaceInspectAttachmentDraftsInput,
) -> Result<Vec<SpaceAttachmentDraftMetadata>, String> {
    inspect_gui_attachments(&input.file_paths)
}

#[tauri::command]
pub async fn cmd_space_upload_issue_attachments(
    input: SpaceUploadIssueAttachmentsInput,
) -> SpaceCommandResult<Value> {
    let issue_id = input.issue_id.trim();
    if issue_id.is_empty() {
        return Err("issueId is required".into());
    }
    let attachments = prepare_gui_attachments(&input.file_paths)?;
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::upload_issue_attachments(
            SpaceUploadIssueAttachmentsInput {
                issue_id: input.issue_id,
                file_paths: attachments
                    .iter()
                    .map(|attachment| attachment.path.to_string_lossy().to_string())
                    .collect(),
            },
        )?);
    }
    let session = require_session()?;
    let form = attachment_form(serde_json::json!({}), attachments)?;
    authorized_multipart_data_request(
        &session,
        &format!("/api/issues/{}/attachments", url_component(issue_id)),
        form,
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_create_issue_with_attachments(
    input: SpaceCreateIssueWithAttachmentsInput,
) -> SpaceCommandResult<Value> {
    let session = require_session()?;
    let space_id = input.space_id.trim();
    let title = input.title.trim();
    let body = input.body.trim();
    if space_id.is_empty() {
        return Err("Space id is required".into());
    }
    if title.is_empty() {
        return Err("Issue title is required".into());
    }
    if body.is_empty() {
        return Err("Issue body is required".into());
    }
    let mut payload = serde_json::json!({
        "title": title,
        "body": body,
        "goalId": input.goal_id,
        "parentIssueId": input.parent_issue_id,
        "humanOnly": input.human_only.unwrap_or(false),
        "assignee": input.assignee,
    });
    let path = format!("/api/spaces/{}/issues", url_component(space_id));
    if input.file_paths.is_empty() {
        return authorized_json_data_request(&session, &path, reqwest::Method::POST, Some(payload))
            .await;
    }
    let attachments = prepare_gui_attachments(&input.file_paths)?;
    if crate::space_cloud_mock::is_enabled() {
        payload["attachments"] = Value::Array(mock_attachment_metadata(&attachments));
        return Ok(crate::space_cloud_mock::api_data_request_with_token(
            "POST",
            &path,
            Some(session.session_token()),
            Some(payload),
        )?);
    }
    let form = attachment_form(payload, attachments)?;
    authorized_multipart_data_request(&session, &path, form).await
}

#[tauri::command]
pub async fn cmd_space_comment_issue_with_attachments(
    input: SpaceCommentIssueWithAttachmentsInput,
) -> SpaceCommandResult<Value> {
    let session = require_session()?;
    let issue_id = input.issue_id.trim();
    let body = input.body.trim();
    if issue_id.is_empty() {
        return Err("Issue id is required".into());
    }
    if body.is_empty() && input.file_paths.is_empty() {
        return Err("Comment text or at least one attachment is required".into());
    }
    let mut payload = serde_json::json!({ "body": body });
    let path = format!("/api/issues/{}/comments", url_component(issue_id));
    if input.file_paths.is_empty() {
        return authorized_json_data_request(&session, &path, reqwest::Method::POST, Some(payload))
            .await;
    }
    let attachments = prepare_gui_attachments(&input.file_paths)?;
    if crate::space_cloud_mock::is_enabled() {
        payload["attachments"] = Value::Array(mock_attachment_metadata(&attachments));
        return Ok(crate::space_cloud_mock::api_data_request_with_token(
            "POST",
            &path,
            Some(session.session_token()),
            Some(payload),
        )?);
    }
    let form = attachment_form(payload, attachments)?;
    authorized_multipart_data_request(&session, &path, form).await
}

fn attachment_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("txt" | "log") => "text/plain",
        Some("md" | "markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

pub(super) fn prepare_cli_attachments(
    workspace_root: &Path,
    file_paths: &[String],
) -> Result<Vec<PreparedAttachment>, String> {
    prepare_attachments(
        file_paths,
        AttachmentReadScope::Workspace(workspace_root),
        false,
    )
}

pub(super) fn cli_attachment_form(
    payload: Value,
    attachments: Vec<PreparedAttachment>,
) -> Result<reqwest::multipart::Form, String> {
    attachment_form(payload, attachments)
}

pub(super) async fn download_attachment_with_token(
    base_url: &str,
    token: &str,
    input: &SpaceDownloadAttachmentInput,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> SpaceCommandResult<SpaceDownloadAttachmentResult> {
    let workspace_root =
        validate_workspace_root(&input.workspace_path).map_err(SpaceCommandError::from)?;
    let response = authorized_raw_request_with_credential(
        base_url,
        &format!(
            "/api/attachments/{}/download",
            url_component(&input.attachment_id)
        ),
        token,
        space_id,
        user_session,
    )
    .await?;
    let headers = response.headers().clone();
    ensure_attachment_download_size(
        response.content_length(),
        0,
        0,
        MAX_ATTACHMENT_DOWNLOAD_BYTES,
    )
    .map_err(SpaceCommandError::from)?;
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_ATTACHMENT_DOWNLOAD_BYTES as u64) as usize,
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            SpaceCommandError::transport(format!("Attachment download failed: {e}"))
        })?;
        ensure_attachment_download_size(
            None,
            bytes.len(),
            chunk.len(),
            MAX_ATTACHMENT_DOWNLOAD_BYTES,
        )
        .map_err(SpaceCommandError::from)?;
        bytes.extend_from_slice(&chunk);
    }
    let name = input
        .file_name
        .as_deref()
        .map(safe_local_filename)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            filename_from_content_disposition(
                headers
                    .get(CONTENT_DISPOSITION)
                    .and_then(|v| v.to_str().ok()),
            )
        })
        .unwrap_or_else(|| format!("attachment-{}", input.attachment_id));
    let relative = if let Some(output) = input.output.as_deref().filter(|s| !s.trim().is_empty()) {
        output.trim().to_string()
    } else {
        let issue_part = input
            .issue_id
            .as_deref()
            .map(safe_local_name)
            .unwrap_or_else(|| "unknown-issue".to_string());
        format!(
            "myagents_files/space/issues/{}/attachments/{}/{}",
            issue_part,
            safe_local_name(&input.attachment_id),
            name
        )
    };
    let target = write_workspace_file_no_follow(&workspace_root, &relative, &bytes)
        .map_err(SpaceCommandError::from)?;
    Ok(SpaceDownloadAttachmentResult {
        name,
        relative_path: relative,
        full_path: target.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
    })
}

fn ensure_attachment_download_size(
    declared_length: Option<u64>,
    current_length: usize,
    next_chunk_length: usize,
    limit: usize,
) -> Result<(), String> {
    if declared_length.is_some_and(|length| length > limit as u64)
        || current_length.saturating_add(next_chunk_length) > limit
    {
        return Err(format!("Attachment exceeds {} bytes", limit));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_download_rejects_declared_content_length_above_limit_before_writing() {
        let workspace = tempfile::tempdir().expect("download workspace");
        let target = workspace.path().join("attachment.bin");
        assert_eq!(MAX_ATTACHMENT_DOWNLOAD_BYTES, 25 * 1024 * 1024);
        let error = ensure_attachment_download_size(
            Some(MAX_ATTACHMENT_DOWNLOAD_BYTES as u64 + 1),
            0,
            0,
            MAX_ATTACHMENT_DOWNLOAD_BYTES,
        )
        .expect_err("declared length above the limit must fail");
        assert!(error.contains(&MAX_ATTACHMENT_DOWNLOAD_BYTES.to_string()));
        assert!(
            !target.exists(),
            "size preflight must not create the destination"
        );
    }

    #[test]
    fn attachment_download_rejects_chunked_body_above_limit_before_writing() {
        let workspace = tempfile::tempdir().expect("download workspace");
        let target = workspace.path().join("attachment.bin");
        ensure_attachment_download_size(
            None,
            MAX_ATTACHMENT_DOWNLOAD_BYTES - 1,
            1,
            MAX_ATTACHMENT_DOWNLOAD_BYTES,
        )
        .expect("the exact limit remains valid");
        let error = ensure_attachment_download_size(
            None,
            MAX_ATTACHMENT_DOWNLOAD_BYTES,
            1,
            MAX_ATTACHMENT_DOWNLOAD_BYTES,
        )
        .expect_err("cumulative chunks above the limit must fail");
        assert!(error.contains(&MAX_ATTACHMENT_DOWNLOAD_BYTES.to_string()));
        assert!(
            !target.exists(),
            "stream rejection must happen before file commit"
        );
    }
}
