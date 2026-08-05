use crate::workspace_files::path_safety::validate_workspace_root;

use super::{inbound_refs, list_entities, rebuild, EntityRow, RefRow};

#[tauri::command]
pub async fn cmd_novel_projection_rebuild(workspace: String) -> Result<(usize, usize), String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    tauri::async_runtime::spawn_blocking(move || rebuild(&workspace_root))
        .await
        .map_err(|error| format!("小说投影重建任务失败：{error}"))?
}

#[tauri::command]
pub async fn cmd_novel_projection_list_entities(
    workspace: String,
    kind: Option<String>,
) -> Result<Vec<EntityRow>, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    tauri::async_runtime::spawn_blocking(move || list_entities(&workspace_root, kind.as_deref()))
        .await
        .map_err(|error| format!("小说实体查询任务失败：{error}"))?
}

#[tauri::command]
pub async fn cmd_novel_projection_inbound_refs(
    workspace: String,
    kind: String,
    id: String,
) -> Result<Vec<RefRow>, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    tauri::async_runtime::spawn_blocking(move || inbound_refs(&workspace_root, &kind, &id))
        .await
        .map_err(|error| format!("小说反向引用查询任务失败：{error}"))?
}
