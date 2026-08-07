use super::*;

/// Atomically verify an ensured Tab owner and retire its temporary background
/// handoff owner.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_reconcile_session_tab_activation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.reconcile_session_tab_activation(&sessionId, &tabId))
}
