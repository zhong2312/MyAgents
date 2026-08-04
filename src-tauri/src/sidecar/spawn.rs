use super::*;

// ============= Core Functions =============

/// Kill a child process (non-blocking)
///
/// - Unix: sends SIGTERM, then spawns a background thread to wait for graceful
///   shutdown and escalate to SIGKILL if the process doesn't exit in time.
/// - Windows: uses `taskkill /T /F` to immediately kill the entire process tree
///   (including SDK subprocess and MCP servers). No background wait needed.
///
/// Returns immediately, making it suitable for use in Drop implementations.
pub(super) fn kill_process(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();

    #[cfg(unix)]
    {
        // Kill the entire process group (negative PID) so SDK CLI + MCP servers are also signaled
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // taskkill /T kills the entire process tree (including SDK subprocess and MCP servers)
        // taskkill /F forces termination
        // process_cmd::new applies CREATE_NO_WINDOW automatically, replacing
        // the previous manual creation_flags() call.
        let result = crate::process_cmd::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
        match result {
            Ok(output) => {
                if !output.status.success() {
                    // taskkill failed (process may have already exited), fallback to child.kill()
                    let _ = child.kill();
                }
            }
            Err(_) => {
                // taskkill command not available, fallback
                let _ = child.kill();
            }
        }
    }

    // Spawn a background thread to wait for graceful shutdown
    // This ensures we don't block the caller (important for UI responsiveness)
    // The thread will force kill if the process doesn't exit within timeout
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            // taskkill /T /F already synchronously terminated the process tree,
            // no need for background polling on Windows
            let _ = pid; // suppress unused variable
            return;
        }

        #[cfg(unix)]
        {
            let timeout = Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
            let start = std::time::Instant::now();

            loop {
                // Use waitpid with WNOHANG to check without blocking
                let mut status: i32 = 0;
                let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };

                if result > 0 {
                    // Direct child exited; give group members a brief grace period then SIGKILL the group
                    ulog_debug!(
                        "[sidecar] Process {} exited gracefully, cleaning up process group",
                        pid
                    );
                    std::thread::sleep(Duration::from_millis(500));
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                    return;
                } else if result < 0 {
                    // Error (process might already be gone)
                    ulog_debug!("[sidecar] Process {} already gone or error", pid);
                    return;
                }
                // result == 0 means process still running

                if start.elapsed() > timeout {
                    ulog_warn!("[sidecar] Process {} didn't exit after SIGTERM, force killing process group", pid);
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                    return;
                }

                thread::sleep(Duration::from_millis(50));
            }
        }
    });

    Ok(())
}

/// Check if a port is available
pub(super) fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Normalize a path for use with external processes.
///
/// On Windows, Tauri's `resource_dir()` and Rust's `current_exe()` / `canonicalize()`
/// return paths with the `\\?\` extended-length prefix. Most external tools (Bun, Node,
/// npm) cannot handle this prefix — they silently hang or fail.
///
/// This function strips the prefix on Windows; on other platforms it's a no-op.
pub(crate) fn normalize_external_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// Diagnose why Node executable was not found and return a user-friendly error message.
pub(super) fn diagnose_node_not_found<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    let mut details = Vec::new();

    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            details.push(format!("resource_dir: {:?}", resource_dir));
            let expected = node_path_in_resources(&resource_dir);
            if !expected.exists() {
                details.push(format!(
                    "bundled Node.js missing at {:?} — build scripts may not have run scripts/download_nodejs.sh",
                    expected
                ));
            }
        }
        Err(e) => {
            details.push(format!("resource_dir() failed: {}", e));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        details.push(format!("current_exe: {:?}", exe_path));
    }

    let diag = details.join("; ");
    let msg = format!(
        "Node.js runtime not found. {} | \
         Possible causes: (1) Bundled Node not downloaded — run scripts/download_nodejs.sh. \
         (2) Antivirus quarantined node.exe on Windows — check Windows Security > Protection History. \
         (3) Installation is corrupted — try reinstalling. \
         Workaround: install Node.js manually from https://nodejs.org (v20+).",
        diag
    );
    ulog_error!("[sidecar] {}", msg);
    msg
}

/// Diagnose why bun process exited immediately and return a user-friendly error message.
pub(super) fn diagnose_immediate_exit(
    status: &std::process::ExitStatus,
    node_path: &std::path::Path,
) -> String {
    let status_str = format!("{:?}", status);

    #[cfg(target_os = "windows")]
    {
        // On Windows, ExitStatus wraps the process exit code.
        // 0xc0000135 (STATUS_DLL_NOT_FOUND) = missing DLL (e.g., VCRUNTIME140.dll)
        // 0xc0000142 (STATUS_DLL_INIT_FAILED) = DLL initialization failed
        let code = status.code().unwrap_or(0) as u32;
        let hint = match code {
            0xc0000135 => {
                "Missing system DLL (likely VCRUNTIME140.dll). \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000142 => {
                "DLL initialization failed. \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000005 => {
                "STATUS_ACCESS_VIOLATION — bundled bun.exe may require AVX2 instructions \
                 (unsupported in many virtual machines and older CPUs). \
                 Install bun globally via: powershell -c \"irm bun.sh/install.ps1 | iex\" \
                 (or: npm install -g bun). Both auto-select a compatible baseline build. \
                 The app will fall back to the system-installed bun on the next attempt."
            }
            0xc0000022 => {
                "Access denied — antivirus may be blocking bun.exe. \
                 Check Windows Security > Protection History, or add the install directory to exclusions."
            }
            1 => {
                "Node exited with code 1. Check if Git for Windows is installed \
                 (required by Claude Agent SDK): https://git-scm.com/downloads/win"
            }
            _ => "",
        };

        let msg = if hint.is_empty() {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). node_path: {:?}",
                status_str, code, node_path
            )
        } else {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). {} | node_path: {:?}",
                status_str, code, hint, node_path
            )
        };
        ulog_error!("[sidecar] {}", msg);
        return msg;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let msg = format!(
            "Node process exited immediately with status: {}. node_path: {:?}",
            status_str, node_path
        );
        ulog_error!("[sidecar] {}", msg);
        msg
    }
}

/// Find the Node.js executable path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
pub(super) fn find_node_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_node_executable_inner(app_handle).map(normalize_external_path)
}

/// Public wrapper for find_node_executable (used by im::bridge module).
pub fn find_node_executable_pub<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_node_executable(app_handle)
}

/// Build the canonical Node.js path relative to a given resources directory.
/// macOS/Linux: <resources>/nodejs/bin/node
/// Windows:     <resources>\nodejs\node.exe
pub(super) fn node_path_in_resources(resources: &std::path::Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        resources.join("nodejs").join("node.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        resources.join("nodejs").join("bin").join("node")
    }
}

pub(super) fn find_node_executable_inner<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // Bundled Node.js lives under resource_dir/nodejs/ (shipped by build_*.sh
    // via scripts/download_nodejs.sh). Unlike the prior Bun externalBin
    // flow, Node.js is a binary + lib directory combo that can't ride
    // Tauri's externalBin — it's a plain resource copy.
    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            ulog_info!("[sidecar] resource_dir resolved to: {:?}", resource_dir);

            let bundled = node_path_in_resources(&resource_dir);
            if bundled.exists() {
                if is_node_crashed(&bundled) {
                    ulog_warn!("Skipping crashed bundled node: {:?}", bundled);
                } else {
                    ulog_info!("Using bundled node: {:?}", bundled);
                    return Some(bundled);
                }
            }
        }
        Err(e) => {
            ulog_warn!(
                "[sidecar] resource_dir() failed: {}, will try exe-relative fallback",
                e
            );
        }
    }

    // Fallback: find node relative to the current executable (most reliable on Windows
    // installer layouts where resource_dir returns something unexpected).
    if let Ok(exe_path) = std::env::current_exe() {
        ulog_info!("[sidecar] current_exe: {:?}", exe_path);
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "macos")]
            let layouts: [PathBuf; 2] = [
                // Inside the .app bundle: Contents/Resources/nodejs/bin/node
                exe_dir
                    .parent()
                    .map(|p| p.join("Resources").join("nodejs").join("bin").join("node"))
                    .unwrap_or_else(|| {
                        exe_dir
                            .join("Resources")
                            .join("nodejs")
                            .join("bin")
                            .join("node")
                    }),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];
            #[cfg(target_os = "windows")]
            let layouts: [PathBuf; 2] = [
                exe_dir.join("resources").join("nodejs").join("node.exe"),
                exe_dir.join("nodejs").join("node.exe"),
            ];
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            let layouts: [PathBuf; 2] = [
                exe_dir
                    .join("resources")
                    .join("nodejs")
                    .join("bin")
                    .join("node"),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];

            for candidate in &layouts {
                if candidate.exists() {
                    ulog_info!("Using bundled node (exe-relative): {:?}", candidate);
                    return Some(candidate.clone());
                }
            }
        }
    }

    // Last resort: system Node.js from PATH. Dev-mode fallback so `npm run dev` /
    // `./start_dev.sh` works on machines where bundled Node hasn't been downloaded yet.
    #[cfg(target_os = "windows")]
    {
        if let Some(path) =
            crate::system_binary::find("node.exe").or_else(|| crate::system_binary::find("node"))
        {
            ulog_info!("Using system node: {:?}", path);
            return Some(path);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path) = crate::system_binary::find("node") {
            ulog_info!("Using system node: {:?}", path);
            return Some(path);
        }
    }

    ulog_error!("[sidecar] Node executable not found in any location. Checked: resource_dir, exe-relative, PATH");
    None
}

/// Find the server script path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
pub(super) fn find_server_script<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_server_script_inner(app_handle).map(normalize_external_path)
}

pub(super) fn find_server_script_inner<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    ulog_info!(
        "[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)"
    );

    #[cfg(not(debug_assertions))]
    {
        match _app_handle.path().resource_dir() {
            Ok(resource_dir) => {
                let bundled_script = resource_dir.join("server-dist.js");
                if bundled_script.exists() {
                    ulog_info!(
                        "Using bundled server script (bundled): {:?}",
                        bundled_script
                    );
                    return Some(bundled_script);
                }

                // Legacy check: Check for server/index.ts (Development / Legacy)
                let legacy_script = resource_dir.join("server").join("index.ts");
                if legacy_script.exists() {
                    ulog_info!("Using bundled server script (legacy): {:?}", legacy_script);
                    return Some(legacy_script);
                }
            }
            Err(e) => {
                ulog_warn!("[sidecar] resource_dir() failed for script search: {}", e);
            }
        }

        // Fallback: find server-dist.js relative to current executable
        #[cfg(target_os = "windows")]
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let script = exe_dir.join("server-dist.js");
                if script.exists() {
                    ulog_info!("[sidecar] Using server script from exe_dir: {:?}", script);
                    return Some(script);
                }
            }
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                ulog_info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                ulog_info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    ulog_error!("[sidecar] Server script not found in any location");
    None
}
