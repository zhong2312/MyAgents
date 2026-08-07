// browser.rs — Embedded browser panel (Tauri Multi-Webview)
//
// Manages child Webview instances for in-app web browsing.
// Each Chat Tab can have one browser Webview. The Webview floats
// above the React DOM at OS level, positioned by frontend coordinates.

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url,
};
use tokio::sync::Mutex;

use crate::{ulog_info, ulog_warn};
use std::path::Path;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

/// User-Agent for the embedded browser webview.
///
/// The default WebView UA on each platform is missing parts (macOS WKWebView
/// drops the `Version/X Safari/Y` suffix; Windows WebView2 advertises Edge
/// instead of Chrome; Linux WebKitGTK is rarer and frequently fingerprinted
/// as a bot) which several big sites — baidu.com main page is the canonical
/// case — flag and respond to with degraded/empty pages or redirect chains.
/// (A user session log showed baidu.com cycling at ~30 redirects/sec.)
///
/// We pretend to be a recent stable Chrome on each host OS rather than the
/// host engine's actual identity: most sites — especially the CN ecosystem —
/// optimize for Chrome and the recognition rate is highest there. The
/// tradeoff is that some UA-sniffing sites may serve Blink-only code paths
/// that the host engine (WebKit on macOS, WebKit2GTK on Linux) doesn't
/// implement identically. Worth it for the "things actually load" win.
#[cfg(target_os = "macos")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "windows")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "linux")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/// Document-start init script injected into every page in the embedded
/// browser. Two responsibilities:
///
/// 1. **`window.open` shim** — we don't have multi-tab; route programmatic
///    `window.open(url)` calls to the same page so the user actually sees
///    something happen instead of a silently-blocked popup. (WKWebView's
///    `javaScriptCanOpenWindowsAutomatically` defaults to false and isn't
///    exposed by wry, so non-user-gesture window.open never reaches our
///    on_new_window handler.) The `<a target="_blank">` path goes through
///    on_new_window → navigate-current-webview separately.
///
/// 2. **Cmd/Ctrl/middle-click escape hatch** — power users expect modifier+
///    click to open in the system browser. Since wry's on_new_window doesn't
///    surface modifier state, we intercept the click in JS and signal Rust
///    via a navigation to a custom `myagents-internal://open-external/?url=`
///    scheme. on_navigation parses the request, opens the target in the OS
///    default browser, and cancels the navigation so the current page stays.
///    An iframe is used so the trigger doesn't replace the visible page.
const BROWSER_INIT_SCRIPT: &str = r#"
(function() {
  if (window.__myagentsBrowserShimInstalled) return;
  window.__myagentsBrowserShimInstalled = true;

  // 1. Route window.open() to current page (no multi-tab support).
  var origOpen = window.open;
  window.open = function(url, target, features) {
    if (url && /^https?:/i.test(String(url))) {
      window.location.href = String(url);
      return window;
    }
    return origOpen ? origOpen.apply(this, arguments) : null;
  };

  // 2. Cmd/Ctrl/middle-click on links → external browser via custom scheme.
  function handleClick(e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.href;
    if (!href || !/^https?:/i.test(href)) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      var ifr = document.createElement('iframe');
      ifr.src = 'myagents-internal://open-external/?url=' + encodeURIComponent(href);
      ifr.style.display = 'none';
      (document.documentElement || document.body).appendChild(ifr);
      setTimeout(function() {
        if (ifr.parentNode) ifr.parentNode.removeChild(ifr);
      }, 100);
    }
  }
  document.addEventListener('click', handleClick, true);
  document.addEventListener('auxclick', handleClick, true);
})();
"#;

/// Spawn the OS default-browser opener for a URL. URL must already be
/// validated as http/https/mailto by the caller — we don't want to hand
/// arbitrary schemes (`file:`, `javascript:`, etc.) to the system opener.
///
/// `pub(crate)` so the main-window navigation handler (`lib.rs::setup`) can
/// reuse the same exec path when it intercepts an external-frame navigation
/// and reroutes it to the OS default browser.
pub(crate) fn spawn_external_open(url: &str) {
    // All three platform arms route through process_cmd::new for the
    // single-mental-model rule. The Windows arm in particular benefits —
    // `cmd /C start` is a console-subsystem binary, so CREATE_NO_WINDOW
    // (set inside process_cmd::new) actually suppresses a brief CMD window
    // flash that the previous raw Command::new spawn would have produced.
    // macOS `open` and Linux `xdg-open` are unaffected (CREATE_NO_WINDOW
    // is Windows-only).
    #[cfg(target_os = "macos")]
    let res = crate::process_cmd::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let res = shell_execute_open(url);
    #[cfg(target_os = "linux")]
    let res = crate::process_cmd::new("xdg-open").arg(url).spawn();

    if let Err(e) = res {
        ulog_info!("[browser] spawn_external_open failed for {}: {}", url, e);
    }
}

#[cfg(target_os = "windows")]
fn shell_execute_open(url: &str) -> Result<(), String> {
    let operation = wide_null_terminated("open");
    let target = wide_null_terminated(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "ShellExecuteW failed with code {}",
            result as isize
        ))
    }
}

#[cfg(target_os = "windows")]
fn wide_null_terminated(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A webview's container bounds are "degenerate" when width or height is
/// non-positive. The renderer positions the OS-level webview over a React div
/// via `getBoundingClientRect()`, and that div momentarily reports 0×N (or
/// 0×0 when `display:none`) while the split panel slides in behind a 300ms
/// width transition. Applying such bounds collapses the webview and floats it
/// over the chat area (issue #290). The renderer already filters these, but we
/// re-check here so no caller can poison the cached geometry that `SHOW`
/// restores from. NaN is non-finite, so it's caught too.
fn is_degenerate_bounds(width: f64, height: f64) -> bool {
    let usable = width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0;
    !usable
}

/// Parse a URL string that may be an absolute file path or an http(s) URL.
/// Handles both Unix (`/Users/...`) and Windows (`C:\Users\...`) paths.
fn parse_url_or_path(url: &str) -> Result<Url, String> {
    let path = Path::new(url);
    if path.is_absolute() {
        Url::from_file_path(path).map_err(|_| format!("Invalid file path: {}", url))
    } else {
        url.parse().map_err(|e| format!("Invalid URL: {e}"))
    }
}

/// Per-tab browser session.
struct BrowserSession {
    webview_label: String,
    #[allow(dead_code)]
    tab_id: String,
    visible: bool,
    /// Cache last-known position/size for show-after-hide restoration.
    last_x: f64,
    last_y: f64,
    last_width: f64,
    last_height: f64,
}

pub struct BrowserManager {
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

impl BrowserManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
}

// ──────────────────────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────────────────────

/// Create a child Webview for the given tab, positioned at (x, y) with (width, height).
#[tauri::command]
pub async fn cmd_browser_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _lifecycle_spawn_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    let label = format!("browser-{}", tab_id);

    ulog_info!(
        "[browser] cmd_browser_create: tab={} url={} pos=({},{}) size={}x{}",
        tab_id,
        url,
        x,
        y,
        width,
        height
    );

    // Clamp degenerate bounds up to a 1px floor so the OS webview is never born
    // collapsed and — critically — the cached `last_width/height` (which SHOW
    // restores from) can never be seeded with zeros (issue #290). The renderer
    // already defers creation until the container is laid out, so this only
    // fires for an unexpected/future caller; the post-create ResizeObserver
    // immediately corrects the size. NaN/non-finite are caught by the same
    // guard since they aren't `> 0.0`.
    let (width, height) = if is_degenerate_bounds(width, height) {
        ulog_info!(
            "[browser] cmd_browser_create: clamping degenerate bounds {}x{} to 1px floor for tab {}",
            width, height, tab_id
        );
        (width.max(1.0), height.max(1.0))
    } else {
        (width, height)
    };

    // Prevent duplicate creation
    {
        let sessions = state.sessions.lock().await;
        if sessions.contains_key(&tab_id) {
            ulog_info!("[browser] Duplicate creation blocked for tab {}", tab_id);
            return Err(format!("Browser already exists for tab {}", tab_id));
        }
    }

    let parsed_url = parse_url_or_path(&url)?;

    // Clone values for closures
    let app_nav = app.clone();
    let tab_id_nav = tab_id.clone();
    let app_load = app.clone();
    let tab_id_load = tab_id.clone();
    let app_new_win = app.clone();
    let label_new_win = label.clone();

    let builder = WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url.clone()))
        .scroll_bar_style(crate::webview_policy::scroll_bar_style())
        .user_agent(BROWSER_USER_AGENT)
        .initialization_script(BROWSER_INIT_SCRIPT)
        .on_navigation(move |nav_url| {
            let scheme = nav_url.scheme();
            // Security: block dangerous schemes; allow everything else.
            // file: is allowed — used for local HTML preview; the webview is
            // already sandboxed (browser.json zero Tauri permissions).
            if scheme == "javascript" {
                ulog_info!(
                    "[browser] on_navigation BLOCKED: {} (scheme: {})",
                    nav_url,
                    scheme
                );
                return false;
            }
            // Internal signaling channel: BROWSER_INIT_SCRIPT triggers an
            // iframe nav to myagents-internal://open-external/?url=… on
            // Cmd/Ctrl/middle-click. Hand the URL to the OS default browser
            // and cancel the navigation so the current page is undisturbed.
            if scheme == "myagents-internal" && nav_url.host_str() == Some("open-external") {
                let target_str = nav_url
                    .query_pairs()
                    .find(|(k, _)| k == "url")
                    .map(|(_, v)| v.into_owned());
                if let Some(target_str) = target_str {
                    if let Ok(target) = Url::parse(&target_str) {
                        if matches!(target.scheme(), "http" | "https" | "mailto") {
                            ulog_info!(
                                "[browser] open-external (Cmd/Ctrl/middle-click): {}",
                                target
                            );
                            spawn_external_open(target.as_str());
                        } else {
                            ulog_info!(
                                "[browser] open-external rejected non-allowlisted scheme: {}",
                                target.scheme()
                            );
                        }
                    }
                }
                return false;
            }
            // Emit URL changes for http/https/file (skip about:, data:, blob: noise)
            if scheme == "http" || scheme == "https" || scheme == "file" {
                ulog_info!("[browser] on_navigation ALLOW: {}", nav_url);
                let _ = app_nav.emit(
                    &format!("browser:url-changed:{}", tab_id_nav),
                    nav_url.to_string(),
                );
            } else {
                ulog_info!(
                    "[browser] on_navigation ALLOW (internal): {} (scheme: {})",
                    nav_url,
                    scheme
                );
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let url_str = payload.url().to_string();
            let event_name = format!("browser:loading:{}", tab_id_load);
            match payload.event() {
                PageLoadEvent::Started => {
                    ulog_info!("[browser] on_page_load STARTED: {}", url_str);
                    let _ = app_load.emit(&event_name, true);
                }
                PageLoadEvent::Finished => {
                    ulog_info!("[browser] on_page_load FINISHED: {}", url_str);
                    let _ = app_load.emit(&event_name, false);
                    // Use the load-event's payload URL — calling _webview.url()
                    // here panics inside wry's url_from_webview when WKWebView.URL
                    // is nil (notably for about:blank in transient states), which
                    // tao's stop_app_on_panic then escalates to a process crash.
                    let _ = app_load.emit(
                        &format!("browser:url-changed:{}", tab_id_load),
                        url_str.clone(),
                    );
                }
            }
        })
        .on_new_window(move |url, _features| {
            ulog_info!(
                "[browser] on_new_window: {} — redirecting to current webview",
                url
            );
            // Redirect target="_blank" / window.open() into the current webview
            let app = app_new_win.clone();
            let lbl = label_new_win.clone();
            let nav_url = url.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(webview) = app.get_webview(&lbl) {
                    let _ = webview.navigate(nav_url);
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

    // Get the Window (not WebviewWindow) to add a child webview
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

    ulog_info!(
        "[browser] Calling window.add_child for label='{}' url={}",
        label,
        parsed_url
    );
    window.add_child(builder, position, size).map_err(|e| {
        ulog_info!("[browser] add_child FAILED: {}", e);
        format!("Failed to create browser webview: {e}")
    })?;

    ulog_info!("[browser] add_child SUCCESS for label='{}'", label);

    // NOTE: do NOT call `app.get_webview(&label).url()` here as a "health check".
    // wry's url_from_webview unwraps WKWebView.URL which may be nil for a
    // freshly-created webview (especially about:blank), and that unwrap panic
    // crashes the whole event loop via tao's stop_app_on_panic. See
    // wry-0.54.4/src/wkwebview/mod.rs:1349. add_child returning Ok is itself
    // sufficient evidence that the webview was created.

    // Store session
    let mut sessions = state.sessions.lock().await;
    sessions.insert(
        tab_id.clone(),
        BrowserSession {
            webview_label: label.clone(),
            tab_id: tab_id.clone(),
            visible: true,
            last_x: x,
            last_y: y,
            last_width: width,
            last_height: height,
        },
    );

    ulog_info!(
        "[browser] Created webview '{}' for tab {} — session stored",
        label,
        tab_id
    );
    Ok(())
}

/// Navigate the existing browser webview to a new URL.
#[tauri::command]
pub async fn cmd_browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    ulog_info!("[browser] cmd_browser_navigate: tab={} url={}", tab_id, url);
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let parsed_url = parse_url_or_path(&url)?;
    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .navigate(parsed_url)
        .map_err(|e| format!("Navigation failed: {e}"))
}

/// Go back in browser history.
#[tauri::command]
pub async fn cmd_browser_go_back(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.back()")
        .map_err(|e| format!("Go back failed: {e}"))
}

/// Go forward in browser history.
#[tauri::command]
pub async fn cmd_browser_go_forward(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("Go forward failed: {e}"))
}

/// Reload the current page.
#[tauri::command]
pub async fn cmd_browser_reload(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview.reload().map_err(|e| format!("Reload failed: {e}"))
}

/// Update webview position and size.
#[tauri::command]
pub async fn cmd_browser_resize(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Drop degenerate resizes (width/height ≤ 0) instead of collapsing the
    // webview and caching zeros that a later SHOW would restore (issue #290).
    // Keep the last good geometry untouched so the next valid resize wins.
    if is_degenerate_bounds(width, height) {
        ulog_info!(
            "[browser] cmd_browser_resize: ignoring degenerate bounds for tab {} — pos=({},{}) size={}x{}",
            tab_id,
            x,
            y,
            width,
            height
        );
        return Ok(());
    }

    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    // Update cached position
    session.last_x = x;
    session.last_y = y;
    session.last_width = width;
    session.last_height = height;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Propagate (don't swallow) native geometry failures: the renderer's
    // reconciler marks bounds as synced when this command resolves, so a
    // silently-dropped set_position/set_size would park the OS webview at
    // stale bounds with no retry scheduled and zero diagnostic trail (issue
    // #339 post-mortem). Returning Err makes the renderer clear its synced
    // marker and retry on the next frame. Errors are exceptional (webview
    // teardown races), so the log cannot spam.
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| {
            ulog_warn!(
                "[browser] set_position({}, {}) failed for tab {}: {}",
                x,
                y,
                tab_id,
                e
            );
            format!("set_position failed: {e}")
        })?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| {
            ulog_warn!(
                "[browser] set_size({}x{}) failed for tab {}: {}",
                width,
                height,
                tab_id,
                e
            );
            format!("set_size failed: {e}")
        })?;
    Ok(())
}

/// Show the browser webview (restore from hidden state).
#[tauri::command]
pub async fn cmd_browser_show(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Restore position and show
    if let Err(e) = webview.set_position(LogicalPosition::new(session.last_x, session.last_y)) {
        ulog_warn!(
            "[browser] SHOW set_position failed for tab {}: {}",
            tab_id,
            e
        );
    }
    if let Err(e) = webview.set_size(LogicalSize::new(session.last_width, session.last_height)) {
        ulog_warn!("[browser] SHOW set_size failed for tab {}: {}", tab_id, e);
    }
    let _ = webview.show();
    session.visible = true;
    ulog_info!(
        "[browser] SHOW webview '{}' at ({},{}) {}x{}",
        session.webview_label,
        session.last_x,
        session.last_y,
        session.last_width,
        session.last_height
    );
    Ok(())
}

/// Hide the browser webview (move off-screen).
#[tauri::command]
pub async fn cmd_browser_hide(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if !session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.hide();
    session.visible = false;
    ulog_info!("[browser] HIDE webview '{}'", session.webview_label);
    Ok(())
}

/// Destroy the browser webview for a tab.
#[tauri::command]
pub async fn cmd_browser_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&tab_id) {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
        ulog_info!(
            "[browser] Closed webview '{}' for tab {}",
            session.webview_label,
            tab_id
        );
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────

/// Close all browser webviews (app exit cleanup).
pub async fn close_all_browsers(state: &Arc<BrowserManager>, app: &AppHandle) {
    let mut sessions = state.sessions.lock().await;
    let count = sessions.len();
    for (_tab_id, session) in sessions.drain() {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
    }
    if count > 0 {
        ulog_info!("[browser] Closed {} browser(s) on shutdown", count);
    }
}

#[cfg(test)]
mod tests {
    use super::is_degenerate_bounds;
    #[cfg(target_os = "windows")]
    use super::wide_null_terminated;

    // Issue #290: the renderer can hand us a 0-width container reading while
    // the split panel's width transition is mid-flight. These must be rejected
    // so the OS webview is never collapsed / mis-positioned over the chat.
    #[test]
    fn degenerate_bounds_are_rejected() {
        assert!(is_degenerate_bounds(0.0, 662.0)); // the exact bug read
        assert!(is_degenerate_bounds(640.0, 0.0));
        assert!(is_degenerate_bounds(0.0, 0.0));
        assert!(is_degenerate_bounds(-1.0, 600.0));
        assert!(is_degenerate_bounds(600.0, -1.0));
        assert!(is_degenerate_bounds(f64::NAN, 600.0));
    }

    #[test]
    fn real_bounds_are_accepted() {
        assert!(!is_degenerate_bounds(694.0, 662.0));
        assert!(!is_degenerate_bounds(1.0, 1.0));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_external_open_preserves_oauth_query_parameters() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=437924003108-example.apps.googleusercontent.com&response_type=code&scope=openid%20email&redirect_uri=https%3A%2F%2Fspace.myagents.io%2Fapi%2Fauth%2Fgoogle%2Fcallback&state=abc";
        let encoded = wide_null_terminated(url);
        assert_eq!(encoded.last().copied(), Some(0));
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
            url
        );
    }
}
