use std::path::Path;

use serde_json::Value;

fn sessions_path() -> Result<std::path::PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("sessions.json"))
        .ok_or_else(|| "无法定位 MyAgents 数据目录".to_string())
}

fn redact_session_metadata(mut session: Value) -> Option<Value> {
    let obj = session.as_object_mut()?;
    if obj
        .get("materializationState")
        .and_then(Value::as_str)
        .is_some_and(|state| state == "prepared")
    {
        return None;
    }
    if obj.contains_key("providerEnvJson") {
        obj.insert(
            "providerEnvJson".to_string(),
            Value::String("[redacted]".to_string()),
        );
    }
    if let Some(stats) = obj.get_mut("stats").and_then(Value::as_object_mut) {
        if let Some(turn_count) = stats.remove("messageCount") {
            stats.insert("turnCount".to_string(), turn_count);
        }
    }
    Some(session)
}

fn read_session_metadata(agent_dir: Option<String>) -> Result<Vec<Value>, String> {
    let path = sessions_path()?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(format!(
                "读取 sessions.json 失败：{} ({})",
                path.display(),
                e
            ))
        }
    };
    let sessions: Vec<Value> = serde_json::from_str(crate::utils::bom::strip_bom(&content))
        .map_err(|e| format!("解析 sessions.json 失败：{} ({})", path.display(), e))?;
    let sessions_dir = path.parent().unwrap_or(Path::new(".")).join("sessions");
    let agent_dir_identity = agent_dir
        .as_deref()
        .map(crate::cron_task::normalize_path)
        .filter(|value| !value.is_empty());

    let mut out = Vec::with_capacity(sessions.len());
    for session in sessions {
        if let Some(expected) = agent_dir_identity.as_deref() {
            let current = session
                .get("agentDir")
                .and_then(Value::as_str)
                .map(crate::cron_task::normalize_path);
            if current.as_deref() != Some(expected) {
                continue;
            }
        }
        if !crate::session_visibility::is_history_visible_session(&session, &sessions_dir) {
            continue;
        }
        if let Some(redacted) = redact_session_metadata(session) {
            out.push(redacted);
        }
    }
    Ok(out)
}

/// Lightweight launcher/history metadata read. This intentionally avoids the
/// global Node sidecar so the Launcher can show recent conversations before the
/// AI runtime finishes cold-starting.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_list_session_metadata(agentDir: Option<String>) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_session_metadata(agentDir))
        .await
        .map_err(|e| format!("读取会话元数据任务失败：{}", e))?
}

#[cfg(test)]
mod tests {
    use super::redact_session_metadata;
    use serde_json::{json, Value};

    #[test]
    fn redacts_provider_env_json() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "providerEnvJson": "{\"apiKey\":\"secret\"}"
        }));

        assert_eq!(
            value
                .and_then(|v| v.get("providerEnvJson").cloned())
                .and_then(|v| v.as_str().map(str::to_string))
                .as_deref(),
            Some("[redacted]"),
        );
    }

    #[test]
    fn projects_legacy_message_count_as_turn_count() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "stats": {
                "messageCount": 3,
                "totalInputTokens": 10,
                "totalOutputTokens": 2
            }
        }))
        .unwrap();

        assert_eq!(
            value.pointer("/stats/turnCount").and_then(Value::as_u64),
            Some(3)
        );
        assert!(value.pointer("/stats/messageCount").is_none());
    }

    #[test]
    fn filters_prepared_sessions() {
        let value = redact_session_metadata(json!({
            "id": "pending-session",
            "materializationState": "prepared"
        }));

        assert!(value.is_none());
    }
}
