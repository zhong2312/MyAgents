// ===== Sidecar stderr classification =====
//
// Node.js writes to stderr from a few intentional informational paths
// (startup beacon, log-retention sweep audit, sdk-shim warnings). The
// pre-existing default of "stderr ⇒ ERROR" surfaced these as red lines in
// the unified log and broke `grep ERROR` for monitoring. Recognise the
// known prefixes and downgrade.
//
// NOTE on adding new entries: only demote messages that are unconditionally
// non-actionable. If a prefix EVER signals a real problem, leave it on
// ERROR — false negatives in this table are far worse than the noise.

#[derive(Clone, Copy)]
pub(crate) enum SidecarStderrLevel {
    Info,
    Warn,
    Error,
}

pub(crate) fn classify_sidecar_stderr(line: &str) -> SidecarStderrLevel {
    // Anchor the prefix match. `contains()` would silently demote any
    // genuine ERROR line that happens to embed one of these brackets in a
    // user-content echo (e.g., `Failed to validate '[log-retention]' user
    // input`). Sidecar / bridge stderr lines from the producers below
    // start with the prefix unconditionally — leading whitespace is the
    // only natural variation, so trim before matching. Cross-review of
    // dev/0.2.9 flagged the substring-match risk.
    let head = line.trim_start();
    // INFO: pure progress / audit output that just happens to land on
    // stderr because the sidecar logger writes there before unified
    // logging is wired up.
    //   - `[startup]` startupBeacon, fired before stdout drain is hooked.
    //   - `[log-retention]` daily / on-demand sweep audit (deleted N old
    //     files, etc.) — see `src/server/log-retention.ts::safeStderr`.
    if head.starts_with("[startup]") || head.starts_with("[log-retention]") {
        return SidecarStderrLevel::Info;
    }
    // WARN: real warnings the sidecar emits via `console.warn`. The
    // `[sdk-shim]` "not implemented in Bridge mode" lines warn that an
    // openclaw plugin reached for an SDK method the bridge doesn't
    // implement. They are expected (the shim is intentionally partial)
    // but worth keeping visible at WARN level for plugin developers.
    if head.starts_with("[sdk-shim]") {
        return SidecarStderrLevel::Warn;
    }
    SidecarStderrLevel::Error
}

#[cfg(test)]
mod stderr_classifier_tests {
    use super::*;

    #[test]
    fn anchored_prefixes_demote_only_when_at_line_start() {
        assert!(matches!(
            classify_sidecar_stderr("[startup] init"),
            SidecarStderrLevel::Info
        ));
        assert!(matches!(
            classify_sidecar_stderr("[log-retention] sweep done"),
            SidecarStderrLevel::Info
        ));
        assert!(matches!(
            classify_sidecar_stderr("[sdk-shim] foo() not implemented"),
            SidecarStderrLevel::Warn
        ));
        // Leading whitespace OK.
        assert!(matches!(
            classify_sidecar_stderr("  [startup] foo"),
            SidecarStderrLevel::Info
        ));
        // Embedded prefix in a real error MUST stay ERROR.
        assert!(matches!(
            classify_sidecar_stderr("Error: failed to parse '[log-retention]' user input"),
            SidecarStderrLevel::Error
        ));
        assert!(matches!(
            classify_sidecar_stderr("uncaught: missing [sdk-shim] field in payload"),
            SidecarStderrLevel::Error
        ));
        // Default = ERROR.
        assert!(matches!(
            classify_sidecar_stderr("ReferenceError: x is not defined"),
            SidecarStderrLevel::Error
        ));
    }
}
