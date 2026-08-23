//! Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
//!
//! Uses the same owner-token and atomic-tombstone protocol as
//! `src/server/utils/file-lock.ts`. The lock primitive is atomic
//! `create_dir`; an `owner` file inside the lockdir holds the 3-tuple
//! `<runtime>:<pid>:<startMs>` (`rust:<pid>:<startMs>` here, `node:<pid>:<startMs>`
//! from Node) for compatibility and exact release fencing. The 2-tuple
//! `<runtime>:<pid>` shape is still understood for backwards compatibility
//! with locks written by older binaries. We delegate the actual blocking work
//! to `tokio::task::spawn_blocking` so the async runtime worker stays free.
//!
//! Rust stale-recovery rules:
//! - A valid process owner confirmed no longer alive is reclaimed immediately
//!   (unix: `nix::sys::signal::kill(pid, None)` returns ESRCH).
//! - A valid process owner is never age-broken while its liveness cannot be
//!   disproved. The v1 wall-clock `startMs` is not strong process-incarnation
//!   evidence, so a mismatch never authorizes eviction of a live pid.
//! - Missing, renderer, and malformed owners are reclaimed only after the age
//!   grace period.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ulog_warn;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_STALE: Duration = Duration::from_secs(30);
const DEFAULT_POLL: Duration = Duration::from_millis(50);
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub struct FileLockOptions {
    pub timeout: Duration,
    pub stale: Duration,
    pub poll: Duration,
}

impl Default for FileLockOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            stale: DEFAULT_STALE,
            poll: DEFAULT_POLL,
        }
    }
}

#[derive(Debug)]
pub enum FileLockError {
    /// Lock could not be acquired within `timeout`.
    Busy {
        lock_path: PathBuf,
        timeout: Duration,
    },
    /// Filesystem error while attempting to acquire / release the lock.
    Io(std::io::Error),
}

impl std::fmt::Display for FileLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileLockError::Busy { lock_path, timeout } => write!(
                f,
                "[file-lock] File busy: could not acquire lock {} within {}ms; retry",
                lock_path.display(),
                timeout.as_millis()
            ),
            FileLockError::Io(e) => write!(f, "[file-lock] I/O error: {}", e),
        }
    }
}

impl std::error::Error for FileLockError {}

impl From<FileLockError> for String {
    fn from(e: FileLockError) -> Self {
        e.to_string()
    }
}

/// Probe whether `pid` is alive. Unix-only via `nix::sys::signal::kill(pid, 0)`.
/// On Windows we open the process with limited query rights and inspect its
/// exit code; an openable process object may already be terminated while a
/// different handle keeps the object alive. Access failures remain unknown.
#[cfg(unix)]
fn is_pid_alive(pid: i32) -> Option<bool> {
    use nix::sys::signal;
    use nix::unistd::Pid;
    match signal::kill(Pid::from_raw(pid), None) {
        Ok(_) => Some(true),
        Err(nix::errno::Errno::ESRCH) => Some(false),
        Err(_) => None, // EPERM etc. — be conservative, don't break.
    }
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: i32) -> Option<bool> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        return match error {
            ERROR_INVALID_PARAMETER | ERROR_NOT_FOUND => Some(false),
            _ => None,
        };
    }
    // A terminated Windows process object can remain openable while another
    // handle still references it (including a retained std::process::Child).
    // OpenProcess alone therefore proves only that the object exists, not that
    // the process is still running.
    let mut exit_code = 0u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        None
    } else {
        Some(exit_code == STILL_ACTIVE as u32)
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn is_pid_alive(_pid: i32) -> Option<bool> {
    None
}

/// Best-effort: return the start time (epoch ms) of `pid`, or None if we
/// can't determine it on this platform. This value is retained only to write
/// the compatible v1 owner token; peers do not use it to evict a live pid.
///
/// - macOS:  `ps -p <pid> -o lstart=` (string date), parse as system time.
/// - Linux:  `/proc/<pid>/stat` field 22 (starttime in clock ticks) +
///           `/proc/uptime` to convert to absolute ms (assume HZ=100, the
///           same approximation the Node helper uses).
/// - Windows: `GetProcessTimes` via a limited-information process handle.
/// - Other platforms: unsupported; a valid process owner remains protected
///   when its start time cannot be verified.
#[cfg(target_os = "macos")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    let out = crate::process_cmd::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Format: "Thu Apr 25 10:23:45 2026". Use chrono if available; otherwise
    // fall back to a manual parse. We avoid adding chrono — manually parse
    // the canonical macOS format.
    parse_lstart_to_epoch_ms(&s)
}

/// Linux CLK_TCK lookup, cached for the process lifetime. Read at first
/// call via `sysconf(_SC_CLK_TCK)` (libc::sysconf), falling back to 100
/// (universal default) if the lookup fails. Without this, an HZ=250 /
/// HZ=1000 kernel would skew the diagnostic v1 token written by this process.
#[cfg(target_os = "linux")]
fn linux_clk_tck() -> f64 {
    use std::sync::OnceLock;
    static CACHED: OnceLock<f64> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // SAFETY: sysconf is a thread-safe libc function. _SC_CLK_TCK is the
        // standard sysconf constant for the clock-tick frequency.
        let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if v > 0 && v <= 10_000 {
            v as f64
        } else {
            100.0
        }
    })
}

#[cfg(target_os = "linux")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    // Field 2 is `(comm)` which can contain spaces — split after the closing paren.
    let close_paren = stat.rfind(')')?;
    let after = &stat[close_paren + 2..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // After the comm field: state=fields[0], ppid=fields[1], …
    // starttime is original index 22 → fields[19].
    let startticks: u64 = fields.get(19)?.parse().ok()?;
    let uptime_str = fs::read_to_string("/proc/uptime").ok()?;
    let uptime_sec: f64 = uptime_str.split_whitespace().next()?.parse().ok()?;
    let hz = linux_clk_tck();
    let start_sec_ago = uptime_sec - (startticks as f64) / hz;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let offset_ms = (start_sec_ago * 1000.0).round() as i128;
    let result = now_ms as i128 - offset_ms;
    if result < 0 {
        None
    } else {
        Some(result as u64)
    }
}

#[cfg(target_os = "windows")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        return None;
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    // FILETIME = 100ns intervals since 1601-01-01 UTC; convert to ms since 1970.
    let ft = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);
    const EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000; // 1601 → 1970 in 100ns
    if ft < EPOCH_OFFSET_100NS {
        return None;
    }
    Some((ft - EPOCH_OFFSET_100NS) / 10_000)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn get_pid_start_time_ms(_pid: i32) -> Option<u64> {
    // Other Unix-likes (FreeBSD etc.): not supported. Liveness remains the
    // conservative authority, so an existing process is not age-broken.
    None
}

/// Parse a macOS `ps -o lstart=` string (e.g. "Thu Apr 25 10:23:45 2026")
/// to epoch ms. Avoids pulling in chrono.
#[cfg(target_os = "macos")]
fn parse_lstart_to_epoch_ms(s: &str) -> Option<u64> {
    // Format pieces split by whitespace: [Day, Mon, Day, HH:MM:SS, Year]
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let mon = parts[1];
    let day: u32 = parts[2].parse().ok()?;
    let time_parts: Vec<&str> = parts[3].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: u32 = time_parts[0].parse().ok()?;
    let min: u32 = time_parts[1].parse().ok()?;
    let sec: u32 = time_parts[2].parse().ok()?;
    let year: i32 = parts[4].parse().ok()?;
    let month: u32 = match mon {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    // Compute days since Unix epoch using a Howard Hinnant-style civil_from_days
    // inverse. Avoids chrono.
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as i64;
    let d = day as i64;
    let doy: u64 = ((153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1) as u64;
    let doe: u64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch: i64 = era * 146097 + doe as i64 - 719468;
    let secs_since_epoch: i64 =
        days_since_epoch * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
    if secs_since_epoch < 0 {
        return None;
    }
    Some(secs_since_epoch as u64 * 1000)
}

/// Our own start time, computed once on first call. Retained in the v1
/// 3-tuple owner file `rust:<pid>:<startMs>` for compatibility and exact
/// release fencing; it is not authoritative process-incarnation evidence.
fn our_start_time_ms() -> u64 {
    use std::sync::OnceLock;
    static OUR_START: OnceLock<u64> = OnceLock::new();
    *OUR_START.get_or_init(|| {
        get_pid_start_time_ms(std::process::id() as i32).unwrap_or_else(|| {
            // Fall back to "now" so the compatibility token still has a
            // stable per-process value for exact release comparison.
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
    })
}

/// Race-safe break: atomically rename the lockdir to a per-process tombstone
/// path and then `remove_dir_all`. Two concurrent waiters detecting the lock
/// as stale can't both succeed — only the rename winner ends up with a
/// tombstone, so a third process that has by then taken a fresh lock under
/// the original path stays untouched. Mirrors `breakLockSafely` in
/// `src/server/utils/file-lock.ts`.
fn break_lock_safely(lock_path: &Path) -> bool {
    let nonce: u32 = {
        // Cheap, unique enough for collision avoidance between waiters in the
        // same millisecond — combine with our pid + a wall-clock millis stamp.
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        now_ns ^ (std::process::id() as u32)
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let tombstone = lock_path.with_file_name(format!(
        "{}.stale-{}-{}-{:08x}",
        lock_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("lock"),
        std::process::id(),
        now_ms,
        nonce,
    ));
    match fs::rename(lock_path, &tombstone) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&tombstone);
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Another waiter already broke (and may have re-acquired) it. From
            // our perspective the stale state is gone — caller should retry.
            true
        }
        Err(_) => false,
    }
}

fn has_confirmed_dead_pid_owner(liveness: Option<bool>) -> bool {
    liveness == Some(false)
}

/// Parse exactly the shared legacy/current process-owner protocol:
/// `<runtime>:<pid>` or `<runtime>:<pid>:<startMs>`, where runtime is Node or
/// Rust. Any missing, non-numeric, or extra field is an unknown owner and must
/// use the age grace period rather than process-owner recovery.
fn parse_process_owner(owner: &str) -> Option<(i32, Option<u64>)> {
    let rest = owner
        .strip_prefix("node:")
        .or_else(|| owner.strip_prefix("rust:"))?;
    let mut fields = rest.split(':');
    let raw_pid = fields.next()?;
    if raw_pid.is_empty() || !raw_pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let pid_value = raw_pid.parse::<u64>().ok()?;
    if pid_value == 0 || pid_value > i32::MAX as u64 {
        return None;
    }
    let pid = pid_value as i32;
    let declared_start = match fields.next() {
        Some(raw) => {
            if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let value = raw.parse::<u64>().ok()?;
            if value > MAX_JS_SAFE_INTEGER {
                return None;
            }
            Some(value)
        }
        None => None,
    };
    if fields.next().is_some() {
        return None;
    }
    Some((pid, declared_start))
}

fn lock_age_from_modified(modified: SystemTime) -> Duration {
    modified.elapsed().unwrap_or(Duration::ZERO)
}

/// Try to break a lockdir whose owner is no longer authoritative.
/// Confirmed-dead pid owners are reclaimed immediately; `stale` is the
/// grace period for missing, renderer, or malformed owners. A valid process
/// owner whose liveness cannot be disproved is retained conservatively.
/// Returns `true` if we removed it (caller should retry mkdir immediately).
fn try_break_stale_lock(lock_path: &Path, stale: Duration) -> bool {
    let metadata = match fs::metadata(lock_path) {
        Ok(m) => m,
        Err(_) => return true, // gone — retry mkdir
    };

    // Wall-clock rollback can leave a lock mtime in the future. Treat that as
    // age zero so age-gated owners remain protected while a confirmed-dead PID
    // can still be reclaimed independently of wall-clock state.
    let age = metadata
        .modified()
        .ok()
        .map(lock_age_from_modified)
        .unwrap_or(Duration::ZERO);
    let owner = fs::read_to_string(lock_path.join("owner"))
        .unwrap_or_default()
        .trim_ascii()
        .to_string();

    // Owner shapes:
    //   node:<pid>           (legacy 2-tuple)
    //   node:<pid>:<startMs> (current 3-tuple, written by Node fix #4)
    //   rust:<pid>           (legacy)
    //   rust:<pid>:<startMs> (current — Rust now also writes this)
    //   renderer:<ts>        (no observable pid; falls through to age-only break)
    //
    // For node:/rust: owners we probe pid liveness. The v1 start_time remains
    // part of the exact owner token but cannot safely distinguish PID reuse
    // from wall-clock adjustment, so a live or inconclusive PID is retained.
    if let Some((pid, _declared_start)) = parse_process_owner(&owner) {
        let liveness = is_pid_alive(pid);
        if !has_confirmed_dead_pid_owner(liveness) {
            return false;
        }
        ulog_warn!(
            "[file-lock] Breaking orphaned lock {} immediately (dead pid={} age={}ms)",
            lock_path.display(),
            pid,
            age.as_millis()
        );
        return break_lock_safely(lock_path);
    }
    // For renderer:<ts> or unrecognized owners we fall through and break by age.
    if age <= stale {
        return false;
    }

    ulog_warn!(
        "[file-lock] Breaking stale lock {} (age={}ms owner={})",
        lock_path.display(),
        age.as_millis(),
        if owner.is_empty() { "unknown" } else { &owner }
    );
    break_lock_safely(lock_path)
}

/// Build our own owner token: `rust:<pid>:<startMs>`. Used at acquisition
/// time to write the sentinel and at release time to verify we still own
/// the lock dir (cf. release-race fix below).
fn our_owner_token() -> String {
    format!("rust:{}:{}", std::process::id(), our_start_time_ms())
}

/// Synchronous lock acquisition + release wrapping `mutator`. Designed to be
/// called from `spawn_blocking` (or any blocking context). For async sites use
/// [`with_file_lock`] which delegates here under `spawn_blocking`.
pub fn with_file_lock_blocking<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError>,
{
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(FileLockError::Io)?;
    }

    let our_token = our_owner_token();

    let start = Instant::now();
    loop {
        match fs::create_dir(lock_path) {
            Ok(()) => {
                let owner_path = lock_path.join("owner");
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&owner_path)
                    .and_then(|mut f| writeln!(f, "{}", our_token));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if try_break_stale_lock(lock_path, opts.stale) {
                    continue; // retry mkdir immediately
                }
                if start.elapsed() >= opts.timeout {
                    return Err(FileLockError::Busy {
                        lock_path: lock_path.to_path_buf(),
                        timeout: opts.timeout,
                    });
                }
                std::thread::sleep(opts.poll);
            }
            Err(e) => return Err(FileLockError::Io(e)),
        }
    }

    let result = mutator();

    // Release-race guard (Pattern 5 fix #4): another process may have broken
    // our lock as stale (e.g. we paused past stale_ms) and acquired its own
    // lock under the same path. Verify ownership before removing — mirror of
    // Node `file-lock.ts` and required for cross-process parity.
    let owner_path = lock_path.join("owner");
    match fs::read_to_string(&owner_path) {
        Ok(s) if s.trim_ascii() == our_token => {
            let _ = fs::remove_dir_all(lock_path);
        }
        Ok(other) => {
            ulog_warn!(
                "[file-lock] our lock at {} was broken as stale; not deleting current holder's lock (owner={})",
                lock_path.display(),
                other.trim_ascii()
            );
        }
        Err(_) => {
            // Owner file missing or unreadable (lock dir may already be gone or
            // another process is mid-write). Treat as ours — best-effort cleanup
            // so we don't leak the dir. If the dir was already removed,
            // remove_dir_all returns NotFound which we ignore.
            let _ = fs::remove_dir_all(lock_path);
        }
    }
    result
}

/// Async wrapper — runs the blocking lock acquisition + the mutator on a tokio
/// blocking-thread so the async runtime stays free.
pub async fn with_file_lock<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError> + Send + 'static,
    T: Send + 'static,
{
    let lock_path = lock_path.to_path_buf();
    tokio::task::spawn_blocking(move || with_file_lock_blocking(&lock_path, opts, mutator))
        .await
        .map_err(|join_err| {
            FileLockError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("file-lock join error: {}", join_err),
            ))
        })?
}

#[cfg(test)]
mod tests {
    use super::{
        has_confirmed_dead_pid_owner, lock_age_from_modified, parse_process_owner,
        try_break_stale_lock,
    };
    use std::{
        fs,
        process::Stdio,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn live_or_unobservable_pid_owner_is_never_age_broken() {
        assert!(!has_confirmed_dead_pid_owner(Some(true)));
        assert!(!has_confirmed_dead_pid_owner(None));
    }

    #[test]
    fn only_dead_pid_is_confirmed_stale() {
        assert!(has_confirmed_dead_pid_owner(Some(false)));
    }

    #[test]
    fn process_owner_parser_requires_exact_legacy_or_current_shape() {
        assert_eq!(parse_process_owner(""), None);
        assert_eq!(parse_process_owner("node:42"), Some((42, None)));
        assert_eq!(parse_process_owner("node:42:0"), Some((42, Some(0))));
        assert_eq!(parse_process_owner("rust:42:1234"), Some((42, Some(1234))));
        assert_eq!(parse_process_owner("node:"), None);
        assert_eq!(parse_process_owner("node:nope"), None);
        assert_eq!(parse_process_owner("node:-1"), None);
        assert_eq!(parse_process_owner("rust:42:garbage"), None);
        assert_eq!(parse_process_owner("rust:42:"), None);
        assert_eq!(parse_process_owner("rust:42:-1"), None);
        assert_eq!(parse_process_owner("rust:42:1:extra"), None);
        assert_eq!(parse_process_owner("node:+42"), None);
        assert_eq!(parse_process_owner("rust:+42:1"), None);
        assert_eq!(parse_process_owner("rust:42:+1"), None);
        assert_eq!(parse_process_owner("rust:0"), None);
        assert_eq!(parse_process_owner("rust:2147483648"), None);
        assert_eq!(parse_process_owner("rust:42:9007199254740992"), None);
        assert_eq!(
            parse_process_owner("rust:42:9007199254740991"),
            Some((42, Some(9_007_199_254_740_991)))
        );
        assert_eq!(parse_process_owner("renderer:42"), None);
        assert_eq!(parse_process_owner("other:42"), None);
        assert_eq!(parse_process_owner("\u{feff}node:42"), None);
        assert_eq!(parse_process_owner("\u{000b}node:42"), None);
    }

    #[test]
    fn future_modified_time_is_age_zero_instead_of_blocking_dead_owner_recovery() {
        let future = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(lock_age_from_modified(future), Duration::ZERO);
    }

    #[test]
    fn confirmed_dead_pid_owner_bypasses_the_age_grace_period() {
        let mut command =
            crate::process_cmd::new(std::env::current_exe().expect("current test executable"));
        let mut child = command
            .arg("--list")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn short-lived child");
        let dead_pid = child.id();
        child.wait().expect("wait for child exit");

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("wall clock after unix epoch")
            .as_nanos();
        let scratch = std::env::temp_dir().join(format!(
            "myagents-file-lock-dead-owner-{}-{nonce}",
            std::process::id()
        ));
        for (label, owner) in [
            ("legacy-node", format!("node:{dead_pid}")),
            ("current-node", format!("node:{dead_pid}:0")),
            ("legacy-rust", format!("rust:{dead_pid}")),
            ("current-rust", format!("rust:{dead_pid}:0")),
        ] {
            let lock_path = scratch.join(format!("{label}.lock"));
            fs::create_dir_all(&lock_path).expect("create fresh lockdir");
            fs::write(lock_path.join("owner"), format!("{owner}\n"))
                .expect("write dead owner token");

            assert!(try_break_stale_lock(&lock_path, Duration::from_secs(60)));
            assert!(!lock_path.exists());
        }

        let _ = fs::remove_dir_all(scratch);
    }

    #[test]
    fn missing_renderer_and_malformed_owners_are_age_gated() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("wall clock after unix epoch")
            .as_nanos();
        let scratch = std::env::temp_dir().join(format!(
            "myagents-file-lock-malformed-owner-{}-{nonce}",
            std::process::id()
        ));
        for (label, owner) in [
            ("missing", None),
            ("renderer", Some("renderer:123".to_string())),
            (
                "malformed-extra",
                Some(format!("rust:{}:1:extra", std::process::id())),
            ),
            (
                "malformed-bom",
                Some(format!("\u{feff}node:{}", std::process::id())),
            ),
            (
                "malformed-vertical-tab",
                Some(format!("\u{000b}node:{}", std::process::id())),
            ),
        ] {
            let lock_path = scratch.join(format!("{label}.lock"));
            fs::create_dir_all(&lock_path).expect("create fresh lockdir");
            if let Some(owner) = owner {
                fs::write(lock_path.join("owner"), format!("{owner}\n"))
                    .expect("write owner token");
            }

            assert!(!try_break_stale_lock(&lock_path, Duration::from_secs(60)));
            assert!(lock_path.exists());
            std::thread::sleep(Duration::from_millis(2));
            assert!(try_break_stale_lock(&lock_path, Duration::ZERO));
            assert!(!lock_path.exists());
        }

        let _ = fs::remove_dir_all(scratch);
    }

    #[test]
    fn live_pid_with_mismatched_v1_start_time_is_retained() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("wall clock after unix epoch")
            .as_nanos();
        let scratch = std::env::temp_dir().join(format!(
            "myagents-file-lock-mismatched-start-owner-{}-{nonce}",
            std::process::id()
        ));
        let lock_path = scratch.join("fresh.lock");
        fs::create_dir_all(&lock_path).expect("create fresh lockdir");
        fs::write(
            lock_path.join("owner"),
            format!("rust:{}:1\n", std::process::id()),
        )
        .expect("write mismatched-start owner token");

        assert!(!try_break_stale_lock(&lock_path, Duration::ZERO));
        assert!(lock_path.exists());

        let _ = fs::remove_dir_all(scratch);
    }
}
