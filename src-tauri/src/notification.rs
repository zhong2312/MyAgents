// OS notification with reliable click-to-foreground + navigation deep-link.
//
// Architectural rationale (see CLAUDE.md "结构保证优于流程约束"):
//
// `tauri-plugin-notification` on desktop is fire-and-forget — its JS shim
// replaces `window.Notification` with a pure invoke proxy that returns no
// handle, and its desktop backend (`notify-rust`) doesn't surface any click
// callback. Relying on `window.onFocusChanged` to detect "user clicked toast"
// works on macOS by accident (OS auto-activates the app) but silently fails
// on Windows — toast clicks go through WinRT's in-process Activated event,
// not a fresh process spawn, so single-instance and focus-changed handlers
// never fire.
//
// This module owns the OS notification surface end-to-end with **two
// platform-exclusive paths** that don't share state:
//
//   ┌──────────────┬─────────────────────────────────────────────────────┐
//   │ Windows      │ `tauri-winrt-notification::Toast::on_activated`     │
//   │              │ closure captures the navigation target directly. No │
//   │              │ global queue, no focus-edge consumption. The click  │
//   │              │ handler is in-process and deterministic.            │
//   ├──────────────┼─────────────────────────────────────────────────────┤
//   │ macOS/Linux  │ Three-state global latch                            │
//   │              │ (Empty/Single/Ambiguous). `Single` is consumed when │
//   │              │ the front-end signals window-activation; `Ambiguous`│
//   │              │ (≥2 unconsumed notifications stacked up) raises the │
//   │              │ window but **refuses to deep-link** — wrong-tab     │
//   │              │ navigation is a worse UX than no-deep-link.         │
//   └──────────────┴─────────────────────────────────────────────────────┘
//
// What this REPLACES:
//   - `pendingNavigation` Map + 2-second time window in
//     `notificationService.ts` (fragile; could miss clicks past the window).
//   - `wasHidden` closure flag in `useTrayEvents.ts` (broke when user wasn't
//     minimized to tray — alt-tab away then click toast).
//   - `notification:show` Tauri event hop (Rust → JS → plugin-notification);
//     now Rust calls plugin-notification directly via builder API.
//
// Why mutually exclusive paths matter (review-time finding): an earlier
// draft populated the global latch on Windows too "as a fallback". That
// caused a double-emit bug — the WinRT closure emitted `notification:click`
// directly, then `onFocusChanged(true)` invoked `cmd_consume_notification_click`
// which drained the same entry and emitted a *second* identical event. The
// strict cfg-split below makes the bug structurally unrepresentable.

#[cfg(not(target_os = "windows"))]
use std::sync::Mutex;
#[cfg(not(target_os = "windows"))]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
// `NotificationExt` powers `show_via_plugin` (the macOS / Linux toast
// path). Windows goes through `tauri_winrt_notification::Toast` directly.
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;

use crate::notification_badge::NotificationBadgeIncrement;
#[cfg(target_os = "windows")]
use crate::ulog_error;
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_info, ulog_warn};

/// How long an unconsumed deep-link target stays valid on macOS / Linux.
///
/// Only relevant for the non-Windows fallback path. Windows consumes
/// synchronously inside the WinRT `on_activated` callback, so this constant
/// is unused there.
///
/// 30 seconds bounds "user notices toast → finishes current task → clicks"
/// without letting truly stale entries linger.
#[cfg(not(target_os = "windows"))]
const PENDING_CLICK_TTL: Duration = Duration::from_secs(30);

#[cfg(not(target_os = "windows"))]
struct PendingClick {
    navigation: NotificationNavigation,
    queued_at: Instant,
}

/// Three-state latch for the macOS/Linux fallback path.
///
/// `Ambiguous` is the load-bearing piece: when two notifications stack up
/// without an intervening focus-regain, we can't tell *which* one the user
/// clicked, so we refuse to deep-link. The user still gets the window raised
/// (`notification:click` is simply not emitted), which is the no-data-loss
/// degradation.
#[cfg(not(target_os = "windows"))]
enum PendingState {
    Empty,
    Single(PendingClick),
    /// Two-or-more notifications stacked unconsumed. Tracked timestamp is
    /// the *earliest* queue entry's `queued_at` so TTL still expires the
    /// state.
    Ambiguous {
        queued_at: Instant,
    },
}

#[cfg(not(target_os = "windows"))]
static PENDING_CLICK: Mutex<PendingState> = Mutex::new(PendingState::Empty);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationNavigation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

impl NotificationNavigation {
    pub fn new(
        tab_id: Option<String>,
        session_id: Option<String>,
        workspace_path: Option<String>,
    ) -> Option<Self> {
        let navigation = Self {
            tab_id: clean_optional_string(tab_id),
            session_id: clean_optional_string(session_id),
            workspace_path: clean_optional_string(workspace_path),
        };
        if navigation.tab_id.is_none()
            && (navigation.session_id.is_none() || navigation.workspace_path.is_none())
        {
            None
        } else {
            Some(navigation)
        }
    }

    pub fn from_tab_id(tab_id: Option<String>) -> Option<Self> {
        Self::new(tab_id, None, None)
    }

    pub fn for_session(
        tab_id: Option<String>,
        session_id: String,
        workspace_path: String,
    ) -> Option<Self> {
        Self::new(tab_id, Some(session_id), Some(workspace_path))
    }

    fn describe(&self) -> String {
        format!(
            "tab_id={:?} session_id={:?} workspace_path={:?}",
            self.tab_id, self.session_id, self.workspace_path
        )
    }
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClickPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionTurnOwner {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionOrigin {
    pub kind: String,
    pub surface: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionCompletionStatus {
    Complete,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionTerminal {
    pub session_id: String,
    pub workspace_path: String,
    pub turn_id: String,
    #[serde(default)]
    pub turn_owner: Option<SessionCompletionTurnOwner>,
    pub origin: SessionCompletionOrigin,
    pub status: SessionCompletionStatus,
}

fn is_generic_session_completion_eligible(terminal: &SessionCompletionTerminal) -> bool {
    if matches!(
        terminal
            .turn_owner
            .as_ref()
            .map(|owner| owner.kind.as_str()),
        Some("task" | "goal")
    ) {
        return false;
    }
    !matches!(
        (
            terminal.origin.kind.as_str(),
            terminal.origin.surface.as_str()
        ),
        ("agent-channel", _)
            | ("automation", _)
            | (
                _,
                "channel_message" | "channel_heartbeat" | "memory_update" | "cron" | "task_run"
            )
    )
}

fn should_show_session_completion<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|window| {
            !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false)
        })
        .unwrap_or(true)
}

pub fn completion_terminal_from_sse_data(data: &str) -> Option<SessionCompletionTerminal> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let payload = value.get("payload").unwrap_or(&value);
    serde_json::from_value(payload.get("completionTerminal")?.clone()).ok()
}

pub(crate) fn submit_session_completion<R: Runtime>(
    app: &AppHandle<R>,
    terminal: SessionCompletionTerminal,
    _claim: crate::sidecar::SessionCompletionClaim,
) {
    if !is_generic_session_completion_eligible(&terminal) {
        ulog_debug!(
            "[Notification] Generic session completion suppressed by owner/origin: session={} turn={} owner={:?} origin={:?}",
            terminal.session_id,
            terminal.turn_id,
            terminal.turn_owner,
            terminal.origin,
        );
        return;
    }
    if !should_show_session_completion(app) {
        ulog_debug!(
            "[Notification] Session completion toast suppressed while main window is focused: session={} turn={}",
            terminal.session_id,
            terminal.turn_id,
        );
        return;
    }

    let locale = crate::i18n::current_locale();
    let (title_key, body_key) = match terminal.status {
        SessionCompletionStatus::Complete => (
            "notification.sessionCompleteTitle",
            "notification.sessionCompleteBody",
        ),
        SessionCompletionStatus::Stopped => (
            "notification.sessionStoppedTitle",
            "notification.sessionStoppedBody",
        ),
        SessionCompletionStatus::Error => (
            "notification.sessionErrorTitle",
            "notification.sessionErrorBody",
        ),
    };
    let navigation = NotificationNavigation::for_session(
        None,
        terminal.session_id.clone(),
        terminal.workspace_path.clone(),
    );
    show_with_navigation_target_and_badge(
        app,
        crate::i18n::t(title_key, locale),
        crate::i18n::t(body_key, locale),
        navigation,
        Some(NotificationBadgeIncrement {
            id: format!(
                "session-completion:{}:{}",
                terminal.session_id, terminal.turn_id
            ),
            source: "session-completion".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id: terminal.session_id,
                workspace_path: terminal.workspace_path,
            },
        }),
    );
}

/// Send an OS notification.
///
/// `tab_id` (when supplied) is the legacy fast-path deep-link target consumed
/// when the user clicks the notification. Use `show_with_navigation_target`
/// when the target may need to open a session that has no live Tab yet.
///
/// Sound is gated by the `notificationSound` user preference, read disk-first
/// from `~/.myagents/config.json` (defaults to enabled if missing). The
/// preference flows through to the platform-specific sound API:
///   - Windows: `Toast::sound(None)` for silent, `Sound::Default` for default.
///   - macOS: `NSUserNotificationDefaultSoundName` (default mac chime).
///   - Linux: `message-new-instant` (XDG sound theme; widely supported).
///
/// Best-effort: any OS-level failure is logged but never propagated to the
/// caller — a silent notification is strictly better than failing the cron
/// task / chat turn that triggered it.
pub fn show_with_navigation<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    tab_id: Option<String>,
) {
    show_with_navigation_target(
        app,
        title,
        body,
        NotificationNavigation::from_tab_id(tab_id),
    );
}

/// Send an OS notification with an optional navigation target.
///
/// Prefer this for background surfaces (cron / task execution) where the target
/// may not have a live Tab yet. A tab-only target can only switch an existing
/// tab; a session target lets the renderer open the corresponding chat session
/// through its cron-aware session-open planner.
pub fn show_with_navigation_target<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, None);
}

pub fn show_with_navigation_target_and_badge<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, badge_increment);
}

fn show_with_navigation_target_inner<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    let prefs = read_notification_prefs();
    if !prefs.os_notifications {
        ulog_debug!(
            "[Notification] Suppressed by user preference (osNotifications=false): title='{}'",
            title
        );
        return;
    }
    let silent = !prefs.notification_sound;
    ulog_info!(
        "[Notification] Showing toast title='{}' navigation={:?} silent={}",
        title,
        navigation.as_ref().map(NotificationNavigation::describe),
        silent
    );

    if prefs.notification_badge {
        if let Some(increment) = badge_increment {
            crate::notification_badge::emit_badge_increment(app, increment);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Pure closure-capture path — no global state, no consumer command.
        if let Err(e) = show_windows_toast(app, title, body, navigation, silent) {
            ulog_error!(
                "[Notification] WinRT toast rendering failed entirely: {}. \
                 Notification will not be displayed; click activation \
                 unavailable. Likely cause: AUMID mismatch or missing \
                 Start Menu shortcut.",
                e
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Render first; only stash on success. Stashing eagerly would let
        // failed renders pollute the latch for 30s.
        if let Err(e) = show_via_plugin(app, title, body, silent) {
            ulog_warn!("[Notification] plugin-notification show failed: {}", e);
            return;
        }
        if let Some(target) = navigation {
            queue_pending_click(target);
        }
    }
}

/// Render via the cross-platform `tauri-plugin-notification` builder API.
///
/// `plugin-notification`'s desktop backend (`notify-rust`) routes the `sound`
/// field through to `mac-notification-sys` on macOS and the freedesktop
/// notification spec's `sound-name` hint on Linux. Not calling `.sound()` at
/// all on these platforms means notify-rust never sets the sound key, which
/// produces a *silent* notification — that's why the silent path takes the
/// no-op branch and the audible path needs an explicit name.
#[cfg(not(target_os = "windows"))]
fn show_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    silent: bool,
) -> tauri_plugin_notification::Result<()> {
    let mut builder = app.notification().builder().title(title).body(body);
    if !silent {
        if let Some(sound_name) = default_sound_name() {
            builder = builder.sound(sound_name);
        }
    }
    builder.show()
}

/// Per-platform default sound identifier passed to `notify-rust`.
///
/// macOS: `NSUserNotificationDefaultSoundName` is the documented sentinel for
/// "play the system's default notification chime" (see Apple's
/// NSUserNotification docs). `mac-notification-sys` recognizes any other
/// string as a custom sound name (e.g. "Ping", "Blow") in `/System/Library/Sounds/`.
///
/// Linux: `message-new-instant` is part of the freedesktop sound theme spec
/// and is supported by GNOME / KDE / XFCE / Cinnamon notification daemons.
/// Notification daemons that don't understand it fall back to no sound.
#[cfg(target_os = "macos")]
fn default_sound_name() -> Option<&'static str> {
    Some("NSUserNotificationDefaultSoundName")
}

#[cfg(target_os = "linux")]
fn default_sound_name() -> Option<&'static str> {
    Some("message-new-instant")
}

/// User notification preferences read from `~/.myagents/config.json`.
///
/// Both fields default to `true` (fail-open) when the config file is missing
/// or unparseable — silently disabling notifications because we couldn't read
/// a JSON file would look like a regression. Read overhead is negligible:
/// notifications are low-frequency events, and the file is small.
struct NotificationPrefs {
    /// Master switch: when false, no OS notification is rendered at all
    /// (covers all 6 trigger sites — cron / task / message complete /
    /// permission request / ask-user-question / plan-mode review).
    os_notifications: bool,
    /// Sound flag: when true, the platform default chime plays alongside
    /// the toast.
    notification_sound: bool,
    /// Badge flag: when true, native app icon badges mirror unseen notification
    /// work. Defaults off while the feature is still being validated.
    notification_badge: bool,
}

fn read_notification_prefs() -> NotificationPrefs {
    #[derive(Debug, serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct PartialAppConfig {
        os_notifications: Option<bool>,
        /// Pre-0.2.14 master toggle. Read as a fallback so users who
        /// deliberately set `cronNotifications: false` keep notifications
        /// suppressed BEFORE the renderer's migrateOsNotificationsField
        /// runs and rewrites the field on disk. Otherwise: launch app,
        /// notification fires before they open Settings, surprise.
        cron_notifications: Option<bool>,
        notification_sound: Option<bool>,
        notification_badge: Option<bool>,
    }

    // Use the project-canonical data-dir helper rather than `dirs::home_dir()`
    // so future dev/prod isolation in `app_dirs.rs` reaches us automatically.
    let parsed: Option<PartialAppConfig> = crate::app_dirs::myagents_data_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|content| serde_json::from_str(strip_bom(&content)).ok());

    NotificationPrefs {
        os_notifications: parsed
            .as_ref()
            .and_then(|c| c.os_notifications.or(c.cron_notifications))
            .unwrap_or(true),
        notification_sound: parsed
            .as_ref()
            .and_then(|c| c.notification_sound)
            .unwrap_or(true),
        notification_badge: parsed.and_then(|c| c.notification_badge).unwrap_or(false),
    }
}

/// Direct WinRT toast with `on_activated` click handler. Compiled only on
/// Windows.
///
/// Two-tier rendering: try the bundle identifier (matches NSIS Start-Menu
/// shortcut AUMID); on failure (portable EXE, custom install, missing
/// shortcut) retry with PowerShell's well-known AUMID. The retry preserves
/// `on_activated`, so click activation still works — the only visible
/// difference is the toast attribution ("PowerShell" instead of "MyAgents").
/// This beats falling back to plugin-notification, which would render a toast
/// with *no* click handler at all.
#[cfg(target_os = "windows")]
fn show_windows_toast<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::Toast;

    let primary_app_id = resolve_windows_app_id(app);
    let primary_is_powershell = primary_app_id == Toast::POWERSHELL_APP_ID;

    match build_and_show_toast(
        app,
        &primary_app_id,
        title,
        body,
        navigation.clone(),
        silent,
    ) {
        Ok(()) => Ok(()),
        Err(e) if primary_is_powershell => Err(e),
        Err(e) => {
            ulog_warn!(
                "[Notification] WinRT toast with AUMID '{}' failed: {}; \
                 retrying with PowerShell AUMID (click handler preserved).",
                primary_app_id,
                e
            );
            build_and_show_toast(
                app,
                Toast::POWERSHELL_APP_ID,
                title,
                body,
                navigation,
                silent,
            )
        }
    }
}

#[cfg(target_os = "windows")]
fn build_and_show_toast<R: Runtime>(
    app: &AppHandle<R>,
    app_id: &str,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Sound, Toast};

    let app_handle = app.clone();
    // `Sound::Default` produces an empty `<audio>` element — WinRT then plays
    // the toast template's default chime. `None` injects `<audio silent="true"/>`,
    // suppressing sound entirely.
    let sound = if silent { None } else { Some(Sound::Default) };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .duration(ToastDuration::Short)
        .sound(sound)
        .on_activated(move |_action| {
            // _action is non-empty only when an action button is clicked;
            // we don't render buttons, so any activation is the toast body.
            // navigation is closure-captured per-toast — no global queue lookup.
            handle_toast_click(&app_handle, navigation.clone());
            Ok(())
        })
        .show()
}

/// Resolve the primary AUMID for our toast.
///
/// In production: `app.config().identifier` matches the AUMID NSIS sets on
/// the Start Menu shortcut via `SetLnkAppUserModelId` — required for WinRT
/// to render a toast attributed to MyAgents.
///
/// In dev (`cargo run`, `tauri dev`): `tauri::is_dev()` is true and we use
/// PowerShell's AUMID — toast still shows but attributed to PowerShell.
///
/// Uses `tauri::is_dev()` (compile-time const) rather than path-suffix
/// heuristics that break under non-standard `CARGO_TARGET_DIR` or monorepo
/// layouts. The `tauri-plugin-notification` desktop backend uses path
/// suffix matching for the same purpose — `is_dev` is the cleaner equivalent
/// (#review-finding-3, CC).
#[cfg(target_os = "windows")]
fn resolve_windows_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri_winrt_notification::Toast;

    if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Toast click handler (Windows in-process Activated callback).
///
/// Intentionally **does not** consult the global pending-click latch — that
/// latch is non-Windows only. The closure captures the per-toast navigation
/// target at render time, eliminating multi-toast misroute.
#[cfg(target_os = "windows")]
fn handle_toast_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    ulog_info!(
        "[Notification] Toast clicked; navigation={:?}",
        navigation.as_ref().map(NotificationNavigation::describe)
    );
    crate::tray::show_main_window(app);
    emit_click(app, navigation);
}

/// macOS / Linux fallback: when the user activates our app via an external
/// trigger (single-instance second launch, focus regain after a banner
/// click), drain the pending latch.
///
/// **Tradeoff (acknowledged)**: any external activation drains the latch,
/// not strictly toast clicks — alt-tab back to MyAgents within 30s of a
/// notification will navigate to the queued tab even though the user didn't
/// click the toast. Mitigations:
///   - The latch is `Ambiguous` (no-route) when ≥2 notifications stacked
///     up unconsumed, so the worst case is a single-toast wrong-tab nudge.
///   - The `Single`-state path is the most common notification flow (one
///     completion, user reacts to it), where this behavior is what the user
///     wants anyway.
///
/// Real fix on macOS would require an `NSUserNotificationCenterDelegate`
/// hooked through Tauri (not currently exposed); on Linux, dbus action
/// callbacks. Both are out of scope for this fix and tracked separately.
#[cfg(not(target_os = "windows"))]
pub fn on_window_activated_externally<R: Runtime>(app: &AppHandle<R>) -> bool {
    if let Some(navigation) = take_pending_click() {
        ulog_info!(
            "[Notification] External activation consumed pending click {}",
            navigation.describe()
        );
        emit_click(app, Some(navigation));
        return true;
    }
    false
}

/// Windows variant: no global latch, so external activation has nothing to
/// consume. Defined as a no-op so the call site in `lib.rs::single_instance`
/// stays platform-agnostic.
#[cfg(target_os = "windows")]
pub fn on_window_activated_externally<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

fn emit_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    let Some(navigation) = navigation else {
        return;
    };
    if let Err(e) = app.emit(
        "notification:click",
        NotificationClickPayload {
            tab_id: navigation.tab_id,
            session_id: navigation.session_id,
            workspace_path: navigation.workspace_path,
        },
    ) {
        ulog_warn!("[Notification] Failed to emit notification:click: {}", e);
    }
}

#[cfg(not(target_os = "windows"))]
fn queue_pending_click(navigation: NotificationNavigation) {
    let described = navigation.describe();
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let now = Instant::now();
    *guard = match std::mem::replace(&mut *guard, PendingState::Empty) {
        // First entry — straightforward.
        PendingState::Empty => PendingState::Single(PendingClick {
            navigation,
            queued_at: now,
        }),
        // Promote to Ambiguous: we now have ≥2 unconsumed notifications
        // and can't tell which one the user will click. Keep the older
        // queued_at so TTL bounds the ambiguous window correctly.
        //
        // Boundary fix (review-by-codex): if the old `Single` is itself
        // already past TTL (notification fired ≥30s ago, never clicked),
        // the user has clearly abandoned it — treat it as Empty for the
        // promotion. Otherwise we'd build an Ambiguous state seeded with
        // an already-expired timestamp, and `take_pending_click` doesn't
        // apply TTL to Ambiguous → the latch stays stuck refusing routes
        // until the next queue flushes it. v0.2.14 dogfood scenario:
        // queue A, leave window unfocused 31s, queue B, click B → gets
        // no deep-link forever.
        PendingState::Single(prev) if prev.queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(PendingClick {
                navigation,
                queued_at: now,
            })
        }
        PendingState::Single(prev) => PendingState::Ambiguous {
            queued_at: prev.queued_at,
        },
        // Same TTL hygiene for an already-Ambiguous entry: if its anchor
        // is past TTL when a new notification arrives, reset to Single on
        // the fresh entry. The user's previous batch is no longer the one
        // being clicked.
        PendingState::Ambiguous { queued_at } if queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(PendingClick {
                navigation,
                queued_at: now,
            })
        }
        PendingState::Ambiguous { queued_at } => PendingState::Ambiguous { queued_at },
    };
    ulog_info!("[Notification] Pending click queued {}", described);
}

#[cfg(not(target_os = "windows"))]
fn take_pending_click() -> Option<NotificationNavigation> {
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let state = std::mem::replace(&mut *guard, PendingState::Empty);
    match state {
        PendingState::Empty => None,
        PendingState::Single(entry) => {
            if entry.queued_at.elapsed() > PENDING_CLICK_TTL {
                ulog_debug!(
                    "[Notification] Pending click for {} expired",
                    entry.navigation.describe()
                );
                None
            } else {
                Some(entry.navigation)
            }
        }
        PendingState::Ambiguous { queued_at: _ } => {
            // Refusing to route is the safe choice: deep-linking to the
            // *wrong* tab is worse than leaving the user on the current
            // tab after raising the window.
            ulog_debug!(
                "[Notification] Pending click was Ambiguous; raising window without deep-link"
            );
            None
        }
    }
}

// ============ Tauri Commands ============

/// Front-end entry point. Replaces direct calls to
/// `@tauri-apps/plugin-notification`'s `sendNotification` so that:
///   1. all OS notifications go through one Rust function
///   2. the click handler is always wired (no caller can "forget")
///   3. the deep-link tab routing is structural rather than a JS-side
///      time-window race
#[tauri::command]
pub fn cmd_show_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    tab_id: Option<String>,
    session_id: Option<String>,
    workspace_path: Option<String>,
) {
    let body = body.unwrap_or_default();
    ulog_info!(
        "[Notification] cmd_show_notification title='{}' tab_id={:?} session_id={:?} workspace_path={:?}",
        title,
        tab_id,
        session_id,
        workspace_path
    );
    show_with_navigation_target_inner(
        &app,
        &title,
        &body,
        NotificationNavigation::new(tab_id, session_id, workspace_path),
        None,
    );
}

/// Front-end hook for macOS / Linux focus-regain. On Windows this is a
/// no-op — the WinRT in-process callback already handled click routing
/// synchronously, and consulting the (non-existent) global latch would
/// cause a double-emit (#review-finding-1).
#[tauri::command]
pub fn cmd_consume_notification_click<R: Runtime>(app: AppHandle<R>) -> bool {
    let consumed = on_window_activated_externally(&app);
    ulog_info!(
        "[Notification] cmd_consume_notification_click consumed={}",
        consumed
    );
    consumed
}

// ============ Tests ============

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    /// All tests in this module touch the same global latch. Run them in a
    /// single `#[test]` so they don't race when `cargo test` parallelizes.
    #[test]
    fn pending_click_state_machine() {
        // 0. Reset (tests share the static; reset to Empty between phases).
        let reset = || {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Empty;
        };
        reset();

        // 1. Empty → take returns None.
        assert_eq!(take_pending_click(), None);

        // 2. queue + take returns the value once.
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-1".into())).unwrap());
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-1".into()))
        );
        assert_eq!(take_pending_click(), None, "single-consumer semantics");

        // 3. Two queues without a take in between → Ambiguous → take None.
        reset();
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-A".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-B".into())).unwrap());
        assert_eq!(
            take_pending_click(),
            None,
            "Ambiguous must refuse to deep-link"
        );

        // 4. Three queues → still Ambiguous → still None.
        reset();
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-A".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-B".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-C".into())).unwrap());
        assert_eq!(take_pending_click(), None);

        // 5. After Ambiguous is consumed, state resets and a fresh Single
        //    can route normally.
        queue_pending_click(
            NotificationNavigation::for_session(
                None,
                "session-fresh".into(),
                "/tmp/workspace".into(),
            )
            .unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::for_session(
                None,
                "session-fresh".into(),
                "/tmp/workspace".into(),
            )
        );

        // 6. TTL expiry on Single — synthesize an old entry directly.
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(PendingClick {
                navigation: NotificationNavigation::from_tab_id(Some("tab-stale".into())).unwrap(),
                queued_at: Instant::now() - Duration::from_secs(31),
            });
        }
        assert_eq!(take_pending_click(), None, "TTL must drop stale Single");

        // 7. queue → wait past TTL → queue → take must route to the LATER
        //    notification (not stick on Ambiguous-with-stale-anchor). This
        //    is the boundary fix from the v0.2.14 codex review.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(PendingClick {
                navigation: NotificationNavigation::from_tab_id(Some("tab-old".into())).unwrap(),
                queued_at: Instant::now() - Duration::from_secs(31),
            });
        }
        queue_pending_click(
            NotificationNavigation::from_tab_id(Some("tab-fresh-after-stale".into())).unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-fresh-after-stale".into())),
            "stale Single must not poison the Ambiguous promotion",
        );

        // 8. Pre-existing Ambiguous past TTL + new queue → resets to Single
        //    on the fresh entry rather than refusing forever.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Ambiguous {
                queued_at: Instant::now() - Duration::from_secs(31),
            };
        }
        queue_pending_click(
            NotificationNavigation::from_tab_id(Some("tab-after-ambiguous".into())).unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-after-ambiguous".into())),
            "stale Ambiguous must not poison subsequent routes",
        );
    }
}

#[cfg(test)]
mod session_completion_tests {
    use super::*;

    fn terminal(
        session_id: &str,
        turn_id: &str,
        owner: Option<&str>,
        origin_kind: &str,
        origin_surface: &str,
    ) -> SessionCompletionTerminal {
        SessionCompletionTerminal {
            session_id: session_id.to_string(),
            workspace_path: "/tmp/workspace".to_string(),
            turn_id: turn_id.to_string(),
            turn_owner: owner.map(|kind| SessionCompletionTurnOwner {
                kind: kind.to_string(),
                id: "owner-1".to_string(),
            }),
            origin: SessionCompletionOrigin {
                kind: origin_kind.to_string(),
                surface: origin_surface.to_string(),
            },
            status: SessionCompletionStatus::Complete,
        }
    }

    #[test]
    fn generic_completion_policy_uses_owner_and_origin() {
        assert!(is_generic_session_completion_eligible(&terminal(
            "desktop",
            "turn-1",
            None,
            "desktop",
            "launcher_input",
        )));
        assert!(is_generic_session_completion_eligible(&terminal(
            "space",
            "turn-1",
            None,
            "registered-agent",
            "space_issue_delivery",
        )));
        assert!(is_generic_session_completion_eligible(&terminal(
            "inbox",
            "turn-1",
            None,
            "session-inbox",
            "session_send",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "task",
            "turn-1",
            Some("task"),
            "automation",
            "task_run",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "goal",
            "turn-1",
            Some("goal"),
            "desktop",
            "assistant",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "channel",
            "turn-1",
            None,
            "agent-channel",
            "channel_message",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "memory",
            "turn-1",
            None,
            "automation",
            "memory_update",
        )));
    }

    #[test]
    fn extracts_terminal_from_plain_and_live_payloads() {
        let raw = serde_json::json!({
            "completionTerminal": {
                "sessionId": "session-1",
                "workspacePath": "/tmp/workspace",
                "turnId": "turn-1",
                "origin": { "kind": "desktop", "surface": "launcher_input" },
                "status": "complete"
            }
        });
        assert_eq!(
            completion_terminal_from_sse_data(&raw.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );

        let live = serde_json::json!({
            "sessionId": "session-1",
            "liveRevision": 3,
            "payload": raw,
        });
        assert_eq!(
            completion_terminal_from_sse_data(&live.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );
    }
}
