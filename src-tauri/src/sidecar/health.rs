use super::*;

/// Wait for a new sidecar to become healthy using TCP-level check.
/// For initial startup, TCP check is sufficient and more reliable because:
/// - Bun starts listening on TCP port before HTTP handler is fully ready
/// - TCP check has been proven stable in production
/// Note: For REUSING an existing sidecar, use check_sidecar_http_health() instead
///
/// `alive_check`: optional closure that returns `true` if the sidecar process is still alive.
/// Checked every 20 iterations (~10s) to detect early crashes (e.g., AVX2 0xC0000005 on Windows
/// VMs where Windows Defender delays the crash by 20-30s, bypassing the 50ms early exit check).
pub(super) fn wait_for_health(
    port: u16,
    alive_check: Option<Box<dyn Fn() -> bool>>,
) -> Result<(), String> {
    // Exponential backoff: 50, 100, 200, 400, 500, 500, 500, ... (cap).
    // See HEALTH_CHECK_DELAY_* constants for rationale.
    let delay_for = |attempt: u32| -> Duration {
        let ms = HEALTH_CHECK_DELAY_START_MS
            .saturating_mul(1u64 << attempt.saturating_sub(1).min(10))
            .min(HEALTH_CHECK_DELAY_CAP_MS);
        Duration::from_millis(ms)
    };

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        // Alive check: every 20 attempts in the slow-poll regime is ~10s. But
        // the early fast regime compresses 20 attempts to ~1.6s, still safe.
        // Catches crashes that happen after our initial try_wait (e.g. Windows
        // Defender holds node.exe for 20-30s then lets a crash happen).
        if attempt % 20 == 0 {
            if let Some(ref check) = alive_check {
                if !check() {
                    return Err(format!(
                        "Sidecar process exited during health check on port {} (detected at attempt {})",
                        port, attempt
                    ));
                }
            }
        }

        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                ulog_info!(
                    "[sidecar] TCP health check passed after {} attempts on port {}",
                    attempt,
                    port
                );
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay_for(attempt));
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed TCP health check after {} attempts on port {}",
        HEALTH_CHECK_MAX_ATTEMPTS, port
    ))
}

/// Pattern 4: wait for /health/ready (deferred init complete) after /health/live
/// passes. Returns Ok if the sidecar reports ready within `timeout_secs`,
/// Err with the structured failure phase + error if it reports `failed`, or
/// Err with a timeout message otherwise.
///
/// Tolerates older sidecar builds (no /health/ready) by treating a 404 as
/// "ready" (best-effort backward compat — older sidecars used the bare /health
/// as both signals).
pub(super) fn wait_for_readiness(
    port: u16,
    timeout_secs: u64,
    alive_check: Option<&dyn Fn() -> bool>,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health/ready", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("readiness client build failed: {}", e)),
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_phase: Option<String> = None;
    while std::time::Instant::now() < deadline {
        if let Some(check) = alive_check {
            if !check() {
                return Err(format!(
                    "Sidecar process exited during readiness check on port {}",
                    port
                ));
            }
        }
        match client.get(&url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::NOT_FOUND {
                    // Older sidecar; treat as ready.
                    return Ok(());
                }
                if status.is_success() {
                    return Ok(());
                }
                // 503 — try to surface phase / error from the structured body.
                let body = resp.text().unwrap_or_default();
                if body.contains("\"state\":\"failed\"") {
                    return Err(format!("sidecar deferred init failed: {}", body));
                }
                // Track the most recent phase for the timeout error message.
                if let Some(start) = body.find("\"phase\":\"") {
                    let rest = &body[start + 9..];
                    if let Some(end) = rest.find('"') {
                        last_phase = Some(rest[..end].to_string());
                    }
                }
            }
            Err(_) => {
                // Sidecar not yet listening, or transient error — try again.
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let phase_part = last_phase
        .map(|p| format!(" (last phase: {})", p))
        .unwrap_or_default();
    Err(format!(
        "sidecar /health/ready timed out after {}s{}",
        timeout_secs, phase_part
    ))
}

/// Quick HTTP health check for existing sidecar (non-blocking style with short timeout)
/// Returns true if the sidecar HTTP server is responsive
pub(super) fn check_sidecar_http_health(port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", port);

    // Short timeout for quick check - sidecar should respond immediately if healthy
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(HTTP_HEALTH_CHECK_TIMEOUT_MS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&health_url).send() {
        Ok(response) => response.status().is_success(),
        Err(e) => {
            ulog_warn!("[sidecar] HTTP health check failed on port {}: {}", port, e);
            false
        }
    }
}
