//! Centralized child process utilities for GUI applications.
//!
//! **All** child processes spawned from the app MUST use `process_cmd::new()`
//! instead of raw `std::process::Command::new()`. This guarantees
//! `CREATE_NO_WINDOW` (0x08000000) is set on Windows, preventing console
//! windows from flashing when spawning background processes (e.g., bun.exe
//! Sidecars, Plugin Bridge, `bun init`/`bun add`). Long-lived processes that
//! may create descendants MUST additionally use [`spawn_tree`], so the owner
//! retains exact descendant authority until shutdown.
//!
//! This follows the same "pit of success" pattern as [`crate::local_http`]:
//! the correct platform behavior is the default — callers don't need to
//! remember per-platform flags.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::process_cmd;
//!
//! let mut cmd = process_cmd::new("bun");
//! cmd.arg("run").arg("script.ts");
//! let child_tree = process_cmd::spawn_tree(&mut cmd)?;
//! ```

use std::ffi::OsStr;
use std::ops::{Deref, DerefMut};
use std::process::{Child, Command};
#[cfg(unix)]
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

const GRACEFUL_TREE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Create a new [`Command`] with platform-specific GUI flags applied.
///
/// On Windows: Sets `CREATE_NO_WINDOW` (0x08000000) to prevent visible
/// console windows for background child processes.
///
/// On other platforms: Equivalent to `Command::new(program)`.
pub fn new<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)] // mut needed on Windows for creation_flags()
    #[allow(clippy::disallowed_methods)] // this IS the wrapper — see clippy.toml
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// A long-lived child plus the platform containment authority for every
/// descendant it creates.
///
/// - Unix: the child is born as a process-group leader; termination targets
///   that exact PGID.
/// - Windows: the child is born suspended, assigned to a kill-on-close Job
///   Object, then resumed. This closes the spawn-before-assign race and keeps
///   descendants contained even when `cmd.exe` / `npx.cmd` exits early.
///
/// Dropping the owner starts bounded exact-tree termination. Unix sends
/// SIGTERM before bounded SIGKILL escalation; Windows terminates the retained
/// Job Object because GUI children have no reliable console signal channel.
/// Call [`ChildTree::kill`] when the owning workflow requires an immediate
/// force stop.
pub(crate) struct ChildTree {
    child: Child,
    #[cfg(target_os = "windows")]
    job: windows_job::Job,
    termination_started: bool,
}

impl ChildTree {
    /// Start bounded shutdown for the exact owned tree. The call is
    /// non-blocking so it is safe from synchronous Drop paths.
    pub(crate) fn terminate(&mut self) -> std::io::Result<()> {
        if self.termination_started {
            return Ok(());
        }

        #[cfg(unix)]
        let result = terminate_unix_group(self.child.id(), false);

        #[cfg(target_os = "windows")]
        let result = self.job.terminate().or_else(|_| self.child.kill());

        #[cfg(not(any(unix, target_os = "windows")))]
        let result = self.child.kill();

        if result.is_ok() {
            self.termination_started = true;
        }
        result
    }

    /// Force-stop the exact owned tree immediately.
    pub(crate) fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        let result = terminate_unix_group(self.child.id(), true);

        #[cfg(target_os = "windows")]
        let result = self.job.terminate().or_else(|_| self.child.kill());

        #[cfg(not(any(unix, target_os = "windows")))]
        let result = self.child.kill();

        if result.is_ok() {
            self.termination_started = true;
        }
        result
    }

    /// Force-stop this exact contained tree and wait until it can no longer
    /// execute. Replacement paths use this before spawning the next generation
    /// so autonomous work from old and new processes cannot overlap.
    pub(crate) fn kill_and_wait(&mut self) -> std::io::Result<()> {
        let pid = self.child.id();
        self.kill()?;
        let started = std::time::Instant::now();
        loop {
            let root_exited = self.child.try_wait()?.is_some();
            #[cfg(unix)]
            let tree_exited = !unix_group_exists(-(pid as i32));
            #[cfg(not(unix))]
            let tree_exited = root_exited;

            if root_exited && tree_exited {
                return Ok(());
            }
            if started.elapsed() >= GRACEFUL_TREE_SHUTDOWN_TIMEOUT {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("process tree {pid} did not exit after force-stop"),
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// Wait until every Unix graceful-termination worker has either observed the
/// exact process group exit or dispatched its bounded SIGKILL escalation.
/// The app exit owner calls this after dropping all long-lived process owners,
/// so the Rust process cannot disappear before an escalation worker runs.
pub(crate) fn settle_pending_tree_terminations() {
    #[cfg(unix)]
    {
        let barrier = termination_barrier();
        let mut pending = barrier
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while *pending > 0 {
            pending = barrier
                .settled
                .wait(pending)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

impl Deref for ChildTree {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl DerefMut for ChildTree {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for ChildTree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// Spawn a long-lived process under construction-time descendant containment.
///
/// The caller remains the lifecycle owner by retaining the returned
/// [`ChildTree`]. A containment setup failure aborts the child instead of
/// falling back to an unowned process or a later whole-machine scan.
pub(crate) fn spawn_tree(command: &mut Command) -> std::io::Result<ChildTree> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = command.spawn()?;
        Ok(ChildTree {
            child,
            termination_started: false,
        })
    }

    #[cfg(target_os = "windows")]
    {
        let (child, job) = windows_job::spawn_suspended_in_job(command)?;
        Ok(ChildTree {
            child,
            job,
            termination_started: false,
        })
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let child = command.spawn()?;
        Ok(ChildTree {
            child,
            termination_started: false,
        })
    }
}

#[cfg(unix)]
fn terminate_unix_group(pid: u32, force: bool) -> std::io::Result<()> {
    let pgid = -(pid as i32);
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(pgid, signal) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }

    if !force {
        let barrier = termination_barrier();
        {
            let mut pending = barrier
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            *pending += 1;
        }
        std::thread::spawn(move || {
            let _settlement = TerminationSettlement;
            let started = std::time::Instant::now();
            let mut root_exited_at = None;
            loop {
                let mut status = 0;
                let wait = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
                if wait != 0 && root_exited_at.is_none() {
                    root_exited_at = Some(std::time::Instant::now());
                }
                if !unix_group_exists(pgid) {
                    return;
                }
                let wrapper_grace_elapsed = root_exited_at
                    .is_some_and(|exited| exited.elapsed() >= Duration::from_millis(500));
                if wrapper_grace_elapsed || started.elapsed() >= GRACEFUL_TREE_SHUTDOWN_TIMEOUT {
                    unsafe {
                        libc::kill(pgid, libc::SIGKILL);
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
    }

    Ok(())
}

#[cfg(unix)]
struct TerminationBarrier {
    pending: Mutex<usize>,
    settled: Condvar,
}

#[cfg(unix)]
fn termination_barrier() -> &'static TerminationBarrier {
    static BARRIER: OnceLock<TerminationBarrier> = OnceLock::new();
    BARRIER.get_or_init(|| TerminationBarrier {
        pending: Mutex::new(0),
        settled: Condvar::new(),
    })
}

#[cfg(unix)]
struct TerminationSettlement;

#[cfg(unix)]
impl Drop for TerminationSettlement {
    fn drop(&mut self) {
        let barrier = termination_barrier();
        let mut pending = barrier
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *pending = pending.saturating_sub(1);
        barrier.settled.notify_all();
    }
}

#[cfg(unix)]
fn unix_group_exists(pgid: i32) -> bool {
    let result = unsafe { libc::kill(pgid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(target_os = "windows")]
mod windows_job {
    use super::{Child, Command, CREATE_NO_WINDOW};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub(super) struct Job {
        handle: OwnedHandle,
    }

    impl Job {
        fn create_kill_on_close() -> std::io::Result<Self> {
            let raw = unsafe { CreateJobObjectW(null(), null()) };
            if raw.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self { handle })
        }

        fn raw(&self) -> HANDLE {
            self.handle.as_raw_handle()
        }

        pub(super) fn terminate(&self) -> std::io::Result<()> {
            let terminated = unsafe { TerminateJobObject(self.raw(), 1) };
            if terminated == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    pub(super) fn spawn_suspended_in_job(command: &mut Command) -> std::io::Result<(Child, Job)> {
        let job = Job::create_kill_on_close()?;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command.spawn()?;

        let assigned = unsafe { AssignProcessToJobObject(job.raw(), child.as_raw_handle()) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        if let Err(error) = resume_initial_thread(child.id()) {
            let _ = job.terminate();
            let _ = child.wait();
            return Err(error);
        }

        Ok((child, job))
    }

    fn resume_initial_thread(pid: u32) -> std::io::Result<()> {
        let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot_raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot_raw) };
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;

        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return Err(std::io::Error::last_os_error());
        }

        loop {
            if entry.th32OwnerProcessID == pid {
                let thread_raw =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread_raw.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread_raw) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(std::io::Error::last_os_error());
                }
                return Ok(());
            }
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                break;
            }
        }

        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("suspended process {pid} has no discoverable initial thread"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::time::Instant;

    fn wait_until_processes_exit(pids: &[u32], timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if crate::process_cleanup::find_live_processes_by_pid(pids).is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        crate::process_cleanup::find_live_processes_by_pid(pids).is_empty()
    }

    #[cfg(unix)]
    #[test]
    fn owned_unix_tree_terminates_parent_and_descendant() {
        let mut command = new("sh");
        command
            .args(["-c", "sleep 60 & child=$!; echo $child; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tree = spawn_tree(&mut command).expect("spawn owned process tree");
        let parent_pid = tree.id();
        let child_pid = {
            let stdout = tree.stdout.take().expect("child pid stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read child pid");
            line.trim().parse::<u32>().expect("parse child pid")
        };

        assert_eq!(
            crate::process_cleanup::find_live_processes_by_pid(&[parent_pid, child_pid]).len(),
            2,
            "test setup must produce one live parent and one live descendant"
        );

        tree.terminate().expect("terminate owned process group");
        drop(tree);
        settle_pending_tree_terminations();

        assert!(
            wait_until_processes_exit(&[parent_pid, child_pid], Duration::from_secs(2)),
            "dropping the owner must terminate the direct child and its descendant"
        );
    }

    #[cfg(unix)]
    #[test]
    fn force_stop_waits_for_the_exact_tree_before_returning() {
        let mut command = new("sh");
        command
            .args(["-c", "sleep 60 & child=$!; echo $child; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tree = spawn_tree(&mut command).expect("spawn owned process tree");
        let parent_pid = tree.id();
        let child_pid = {
            let stdout = tree.stdout.take().expect("child pid stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read child pid");
            line.trim().parse::<u32>().expect("parse child pid")
        };

        tree.kill_and_wait().expect("force-stop exact process tree");
        assert!(
            crate::process_cleanup::find_live_processes_by_pid(&[parent_pid, child_pid]).is_empty(),
            "replacement may spawn only after the old tree can no longer execute"
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminating_owned_tree_preserves_unrelated_same_argv_process() {
        let mut unrelated = new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn unrelated same-argv process");
        let unrelated_pid = unrelated.id();

        let mut command = new("sleep");
        command
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut owned = spawn_tree(&mut command).expect("spawn owned same-argv process");
        let owned_pid = owned.id();

        owned.terminate().expect("terminate exact owned tree");
        drop(owned);
        settle_pending_tree_terminations();

        assert!(
            wait_until_processes_exit(&[owned_pid], Duration::from_secs(2)),
            "owned process must terminate"
        );
        assert_eq!(
            crate::process_cleanup::find_live_processes_by_pid(&[unrelated_pid]).len(),
            1,
            "same argv is not process ownership"
        );

        let _ = unrelated.kill();
        let _ = unrelated.wait();
    }

    #[cfg(unix)]
    #[test]
    fn exit_settlement_dispatches_force_for_sigterm_resistant_tree() {
        let mut command = new("sh");
        command
            .args(["-c", "trap '' TERM; sleep 60 & child=$!; echo $child; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tree = spawn_tree(&mut command).expect("spawn resistant process tree");
        let parent_pid = tree.id();
        let child_pid = {
            let stdout = tree.stdout.take().expect("child pid stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read child pid");
            line.trim().parse::<u32>().expect("parse child pid")
        };

        tree.terminate().expect("start bounded termination");
        drop(tree);
        settle_pending_tree_terminations();

        assert!(
            wait_until_processes_exit(&[parent_pid, child_pid], Duration::from_secs(2)),
            "app-exit settlement must not return before SIGKILL is dispatched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn owned_unix_group_remains_authoritative_after_wrapper_exit() {
        let mut command = new("sh");
        command
            .args(["-c", "sleep 60 & echo $!"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tree = spawn_tree(&mut command).expect("spawn owned wrapper process tree");
        let child_pid = {
            let stdout = tree.stdout.take().expect("descendant pid stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read descendant pid");
            line.trim().parse::<u32>().expect("parse descendant pid")
        };
        tree.wait().expect("wrapper exits normally");

        assert_eq!(
            crate::process_cleanup::find_live_processes_by_pid(&[child_pid]).len(),
            1,
            "test setup must leave the wrapper's descendant running"
        );

        tree.kill()
            .expect("process group remains authoritative after leader exit");
        drop(tree);

        assert!(
            wait_until_processes_exit(&[child_pid], Duration::from_secs(2)),
            "the retained process-group authority must terminate descendants after wrapper exit"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn owned_windows_job_terminates_parent_and_descendant() {
        let mut command = new("powershell");
        command
            .args([
                "-NoProfile",
                "-Command",
                "$child = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output $child.Id",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tree = spawn_tree(&mut command).expect("spawn owned Windows Job");
        let parent_pid = tree.id();
        let child_pid = {
            let stdout = tree.stdout.take().expect("child pid stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read child pid");
            line.trim().parse::<u32>().expect("parse child pid")
        };
        tree.wait().expect("PowerShell wrapper exits normally");

        tree.kill().expect("terminate owned Windows Job");
        drop(tree);

        assert!(
            wait_until_processes_exit(&[parent_pid, child_pid], Duration::from_secs(5)),
            "Job termination must include descendants even after command wrappers exit"
        );
    }
}
