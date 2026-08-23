use super::*;

// ============= Legacy Compatibility Functions =============
// These wrap the new multi-instance API to support existing code

/// Legacy: Start sidecar (uses "__legacy__" as tab ID)
pub fn start_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
    config: LegacySidecarConfig,
) -> Result<u16, String> {
    // Use legacy tab ID
    const LEGACY_TAB_ID: &str = "__legacy__";

    // Stop any existing legacy instance
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);

    // Start new instance
    start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(config.agent_dir))
}

/// Legacy: Stop sidecar
pub fn stop_sidecar(state: &ManagedSidecar) -> Result<(), String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    stop_tab_sidecar(state, LEGACY_TAB_ID)
}

/// Legacy: Get sidecar status
pub fn get_sidecar_status(state: &ManagedSidecar) -> Result<SidecarStatus, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    get_tab_sidecar_status(state, LEGACY_TAB_ID)
}

/// Legacy: Check if process is alive
pub fn check_process_alive(state: &ManagedSidecar) -> Result<bool, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    let mut manager_guard = state.lock().map_err(|e| e.to_string())?;

    if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
        Ok(instance.is_running())
    } else {
        Ok(false)
    }
}

/// Legacy: Restart sidecar
pub fn restart_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";

    // Get current config
    let agent_dir = {
        let manager_guard = state.lock().map_err(|e| e.to_string())?;
        manager_guard
            .get_instance(LEGACY_TAB_ID)
            .and_then(|i| i.agent_dir.clone())
    };

    // Stop and restart
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);

    if let Some(dir) = agent_dir {
        start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(dir))
    } else {
        Err("No previous agent_dir to restart with".to_string())
    }
}

/// Legacy: Ensure sidecar is running
pub fn ensure_sidecar_running<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";

    // Reusing a running legacy Global instance is still an admission: the
    // launcher may have been removed or replaced since this Sidecar was born.
    let running_port = {
        let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
            if instance.is_running() {
                Some(instance.port)
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some(port) = running_port {
        crate::cli::ensure_launcher()?;
        return Ok(port);
    }

    // Need to restart
    restart_sidecar(app_handle, state)
}
