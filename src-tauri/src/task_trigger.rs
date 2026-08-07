//! Task Activation Trigger domain.
//!
//! Configuration is embedded in the durable [`crate::task::Task`] row while
//! high-frequency detector state is owned by [`crate::task::TaskStore`] and
//! persisted beside the task documents as `trigger-state.json`.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

pub const DETECTOR_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_DETECTOR_TIMEOUT_MS: u64 = 30_000;
pub const MIN_DETECTOR_TIMEOUT_MS: u64 = 1_000;
pub const MAX_DETECTOR_TIMEOUT_MS: u64 = 300_000;
pub const MAX_DETECTOR_STDOUT_BYTES: usize = 256 * 1024;
pub const MAX_DETECTOR_STDERR_BYTES: usize = 64 * 1024;
pub const MAX_CHECKPOINT_BYTES: usize = 64 * 1024;
pub const MAX_HANDOFF_BYTES: usize = 128 * 1024;
const MAX_HANDOFF_TEXT_BYTES: usize = 32 * 1024;
const RECENT_EVENT_LIMIT: usize = 128;
const DETECTOR_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskTrigger {
    pub source: TaskTriggerSource,
    pub detector: TaskTriggerDetector,
}

impl Default for TaskTrigger {
    fn default() -> Self {
        Self {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Always,
        }
    }
}

impl TaskTrigger {
    pub fn is_command(&self) -> bool {
        matches!(self.detector, TaskTriggerDetector::Command { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum TaskTriggerSource {
    Time,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum TaskTriggerDetector {
    Always,
    Command {
        command: TaskTriggerCommand,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTriggerCommand {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

pub fn validate_task_trigger(trigger: &TaskTrigger) -> Result<(), String> {
    let TaskTriggerDetector::Command {
        command,
        timeout_ms,
    } = &trigger.detector
    else {
        return Ok(());
    };
    let executable = command.executable.trim();
    if executable.is_empty() {
        return Err("trigger command executable is empty".to_string());
    }
    if executable.contains('\0') || command.args.iter().any(|arg| arg.contains('\0')) {
        return Err("trigger command executable/args may not contain NUL".to_string());
    }
    if let Some(timeout_ms) = timeout_ms {
        if !(MIN_DETECTOR_TIMEOUT_MS..=MAX_DETECTOR_TIMEOUT_MS).contains(timeout_ms) {
            return Err(format!(
                "trigger timeoutMs must be between {MIN_DETECTOR_TIMEOUT_MS} and {MAX_DETECTOR_TIMEOUT_MS}"
            ));
        }
    }
    if let Some(cwd) = command.cwd.as_deref() {
        if cwd.contains('\0') {
            return Err("trigger command cwd may not contain NUL".to_string());
        }
        if cwd != cwd.trim() {
            return Err("trigger command cwd may not have surrounding whitespace".to_string());
        }
        let path = Path::new(cwd);
        if !path.is_absolute() {
            return Err("trigger command cwd must be an absolute directory".to_string());
        }
        if !path.is_dir() {
            return Err(format!(
                "trigger command cwd does not exist or is not a directory: {}",
                path.display()
            ));
        }
    }
    let path = Path::new(executable);
    if path.components().count() > 1 && !path.is_absolute() {
        return Err("trigger command executable must be a bare name or absolute path".to_string());
    }
    if path.is_absolute() && !path.is_file() {
        return Err(format!(
            "trigger command executable does not exist or is not a file: {}",
            path.display()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTriggerReason {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskActivationEvent {
    pub id: String,
    pub kind: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskActivationHandoff {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskActivationDeliveryState {
    Pending,
    Dispatching,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingTaskActivation {
    pub event: TaskActivationEvent,
    pub handoff: TaskActivationHandoff,
    pub reason: TaskTriggerReason,
    /// Why the Detector produced this durable outbox entry. Recovery must
    /// preserve this distinction: a scheduled activation is owned by the
    /// running scheduler, while check-now is a one-shot manual admission that
    /// remains recoverable even when the Task itself is stopped or blocked.
    #[serde(default = "scheduled_invocation_cause")]
    pub invocation_cause: DetectorInvocationCause,
    pub detected_at: i64,
    pub task_updated_at: i64,
    pub delivery_state: TaskActivationDeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskActivationPayload {
    pub event: TaskActivationEvent,
    pub handoff: TaskActivationHandoff,
    pub reason: TaskTriggerReason,
    pub detected_at: i64,
}

impl From<&PendingTaskActivation> for TaskActivationPayload {
    fn from(pending: &PendingTaskActivation) -> Self {
        Self {
            event: pending.event.clone(),
            handoff: pending.handoff.clone(),
            reason: pending.reason.clone(),
            detected_at: pending.detected_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentTaskActivation {
    pub id: String,
    pub settled_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskTriggerRuntimeOutcome {
    Quiet,
    Activate,
    Deduplicated,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTriggerError {
    pub code: String,
    pub message: String,
    pub occurred_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

impl TaskTriggerError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            occurred_at: Utc::now().timestamp_millis(),
            exit_code: None,
            signal: None,
            timed_out: None,
            stderr_tail: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTriggerRuntimeState {
    pub protocol_version: u32,
    pub checkpoint: Option<Map<String, Value>>,
    pub checkpoint_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_updated_at: Option<i64>,
    pub check_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<TaskTriggerRuntimeOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<TaskTriggerReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activated_at: Option<i64>,
    pub consecutive_failures: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backoff_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<TaskTriggerError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_activation: Option<PendingTaskActivation>,
    pub recent_event_ids: Vec<RecentTaskActivation>,
}

impl Default for TaskTriggerRuntimeState {
    fn default() -> Self {
        Self {
            protocol_version: DETECTOR_PROTOCOL_VERSION,
            checkpoint: None,
            checkpoint_revision: 0,
            checkpoint_updated_at: None,
            check_count: 0,
            last_checked_at: None,
            last_outcome: None,
            last_reason: None,
            last_activated_at: None,
            consecutive_failures: 0,
            backoff_until: None,
            last_error: None,
            pending_activation: None,
            recent_event_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectorInvocationCause {
    Scheduled,
    CheckNow,
    Test,
}

fn scheduled_invocation_cause() -> DetectorInvocationCause {
    DetectorInvocationCause::Scheduled
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorInvocationInput {
    protocol_version: u32,
    invocation: DetectorInvocationMetadata,
    checkpoint: DetectorCheckpointInput,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorInvocationMetadata {
    id: String,
    task_id: String,
    cause: DetectorInvocationCause,
    #[serde(skip_serializing_if = "Option::is_none")]
    scheduled_at: Option<String>,
    checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorCheckpointInput {
    revision: u64,
    value: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectorDecision {
    Quiet,
    Activate,
}

fn deserialize_present_nullable<'de, D>(
    deserializer: D,
) -> Result<Option<Option<Map<String, Value>>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<Map<String, Value>>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetectorProtocolOutput {
    protocol_version: u32,
    control: DetectorControlOutput,
    #[serde(default)]
    handoff: Option<TaskActivationHandoff>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetectorControlOutput {
    decision: DetectorDecision,
    reason: TaskTriggerReason,
    #[serde(default)]
    event: Option<TaskActivationEvent>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    next_checkpoint: Option<Option<Map<String, Value>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorRunSuccess {
    pub invocation_id: String,
    pub decision: DetectorDecision,
    pub reason: TaskTriggerReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<TaskActivationEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff: Option<TaskActivationHandoff>,
    /// `None` means omitted/unchanged; `Some(None)` means explicit null.
    pub next_checkpoint: Option<Option<Map<String, Value>>>,
    pub duration_ms: u64,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorRunFailure {
    pub error: Box<TaskTriggerError>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
}

impl DetectorRunFailure {
    pub fn from_message(code: impl Into<String>, message: impl Into<String>) -> Self {
        failure(code, message, 0, None)
    }
}

pub type DetectorRunResult = Result<DetectorRunSuccess, DetectorRunFailure>;

#[derive(Debug, Clone)]
pub struct DetectorCancellation {
    canceled: Arc<AtomicBool>,
}

impl DetectorCancellation {
    pub fn new() -> Self {
        Self {
            canceled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }
}

impl Default for DetectorCancellation {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct DetectorRunRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub trigger: TaskTrigger,
    pub cause: DetectorInvocationCause,
    pub scheduled_at: Option<i64>,
    pub checkpoint: Option<Map<String, Value>>,
    pub checkpoint_revision: u64,
    pub checkpoint_updated_at: Option<i64>,
}

fn detector_semaphore() -> &'static Arc<tokio::sync::Semaphore> {
    static SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(DETECTOR_CONCURRENCY)))
}

pub async fn run_command_detector<R: Runtime>(
    app_handle: &AppHandle<R>,
    request: DetectorRunRequest,
    cancellation: DetectorCancellation,
) -> DetectorRunResult {
    let command = match &request.trigger.detector {
        TaskTriggerDetector::Always => {
            return Err(failure(
                "detector_not_command",
                "always detector does not run a subprocess",
                0,
                None,
            ));
        }
        TaskTriggerDetector::Command { command, .. } => command.clone(),
    };
    let timeout_ms = match request.trigger.detector {
        TaskTriggerDetector::Command { timeout_ms, .. } => {
            timeout_ms.unwrap_or(DEFAULT_DETECTOR_TIMEOUT_MS)
        }
        TaskTriggerDetector::Always => DEFAULT_DETECTOR_TIMEOUT_MS,
    };
    let permit = loop {
        if cancellation.is_canceled() {
            return Err(failure(
                "detector_canceled",
                "Detector invocation was canceled",
                0,
                None,
            ));
        }
        match Arc::clone(detector_semaphore()).try_acquire_owned() {
            Ok(permit) => break permit,
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(tokio::sync::TryAcquireError::Closed) => {
                return Err(failure(
                    "detector_unavailable",
                    "Detector concurrency controller is unavailable",
                    0,
                    None,
                ));
            }
        }
    };

    let executable = match resolve_executable(app_handle, &command.executable) {
        Ok(path) => path,
        Err(error) => {
            drop(permit);
            return Err(failure("detector_executable_not_found", error, 0, None));
        }
    };
    let cwd = command
        .cwd
        .as_deref()
        .unwrap_or(&request.workspace_path)
        .to_string();
    let invocation_id = uuid::Uuid::new_v4().to_string();
    let checked_at = Utc::now();
    let input = DetectorInvocationInput {
        protocol_version: DETECTOR_PROTOCOL_VERSION,
        invocation: DetectorInvocationMetadata {
            id: invocation_id.clone(),
            task_id: request.task_id,
            cause: request.cause,
            scheduled_at: request.scheduled_at.and_then(format_timestamp),
            checked_at: checked_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        },
        checkpoint: DetectorCheckpointInput {
            revision: request.checkpoint_revision,
            value: request.checkpoint,
            updated_at: request.checkpoint_updated_at.and_then(format_timestamp),
        },
    };
    let stdin = match serde_json::to_vec(&input) {
        Ok(value) => value,
        Err(error) => {
            drop(permit);
            return Err(failure(
                "detector_input_serialize_failed",
                format!("Failed to serialize Detector input: {error}"),
                0,
                None,
            ));
        }
    };
    let args = command.args;
    let cancellation_for_worker = cancellation.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_command_blocking(
            executable,
            args,
            cwd,
            stdin,
            timeout_ms,
            cancellation_for_worker,
            invocation_id,
        )
    })
    .await
    .unwrap_or_else(|error| {
        Err(failure(
            "detector_worker_failed",
            format!("Detector worker failed: {error}"),
            0,
            None,
        ))
    });
    drop(permit);
    result
}

fn format_timestamp(timestamp_ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn resolve_executable<R: Runtime>(
    app_handle: &AppHandle<R>,
    executable: &str,
) -> Result<PathBuf, String> {
    let trimmed = executable.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower == "node" || lower == "node.exe" {
        return crate::sidecar::find_node_executable_pub(app_handle)
            .ok_or_else(|| "MyAgents bundled Node.js v24 was not found".to_string());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Ok(crate::sidecar::normalize_external_path(path));
    }
    crate::system_binary::find(trimmed)
        .map(crate::sidecar::normalize_external_path)
        .ok_or_else(|| format!("Executable was not found: {trimmed}"))
}

fn run_command_blocking(
    executable: PathBuf,
    args: Vec<String>,
    cwd: String,
    stdin_bytes: Vec<u8>,
    timeout_ms: u64,
    cancellation: DetectorCancellation,
    invocation_id: String,
) -> DetectorRunResult {
    let started = Instant::now();
    let cwd = crate::sidecar::normalize_external_path(PathBuf::from(cwd));
    if !cwd.is_dir() {
        return Err(failure(
            "detector_cwd_invalid",
            format!(
                "Detector cwd does not exist or is not a directory: {}",
                cwd.display()
            ),
            0,
            None,
        ));
    }
    let mut command = crate::process_cmd::new(&executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_detector_environment(&mut command);
    crate::proxy_config::apply_to_subprocess(&mut command);

    // App/update shutdown closes this creation gate before draining exact
    // owners. The Scheduler registered this invocation before entering the
    // blocking runner, so the permit only spans process birth and is released
    // immediately after the ChildTree becomes owner-visible.
    let lifecycle_spawn_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
        Ok(permit) => permit,
        Err(error) => {
            return Err(failure(
                "detector_spawn_blocked",
                format!("Detector process creation is blocked during shutdown: {error}"),
                started.elapsed().as_millis() as u64,
                None,
            ));
        }
    };
    let child = crate::process_cmd::spawn_tree(&mut command);
    drop(lifecycle_spawn_permit);
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            return Err(failure(
                "detector_spawn_failed",
                format!("Failed to spawn Detector: {error}"),
                0,
                None,
            ));
        }
    };
    let stdout = child.stdout.take().expect("stdout configured as piped");
    let stderr = child.stderr.take().expect("stderr configured as piped");
    let stdin = child.stdin.take().expect("stdin configured as piped");
    let stdout_overflow = Arc::new(AtomicBool::new(false));
    let stdout_overflow_reader = Arc::clone(&stdout_overflow);
    let stdout_thread = std::thread::spawn(move || {
        read_bounded(
            stdout,
            MAX_DETECTOR_STDOUT_BYTES,
            Some(stdout_overflow_reader),
        )
    });
    let stderr_thread = std::thread::spawn(move || read_tail(stderr, MAX_DETECTOR_STDERR_BYTES));
    let stdin_error = Arc::new(Mutex::new(None::<String>));
    let stdin_error_writer = Arc::clone(&stdin_error);
    let stdin_thread = std::thread::spawn(move || {
        let mut stdin = stdin;
        if let Err(error) = stdin.write_all(&stdin_bytes) {
            // A Detector may make a static decision and exit with a complete
            // protocol response without reading stdin. On Linux that valid
            // race reports EPIPE; the response and exit status remain the
            // authoritative outcome. Other write failures still surface.
            if error.kind() != std::io::ErrorKind::BrokenPipe {
                *stdin_error_writer.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(format!("Failed to write Detector stdin: {error}"));
            }
        }
        let _ = stdin.flush();
    });

    let mut timed_out = false;
    let mut canceled = false;
    let mut overflowed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let stderr_tail = join_utf8_tail(stderr_thread);
                let _ = stdout_thread.join();
                let _ = stdin_thread.join();
                return Err(failure(
                    "detector_wait_failed",
                    format!("Failed to wait for Detector: {error}"),
                    started.elapsed().as_millis() as u64,
                    stderr_tail,
                ));
            }
        }
        if cancellation.is_canceled() {
            canceled = true;
        } else if stdout_overflow.load(Ordering::SeqCst) {
            overflowed = true;
        } else if started.elapsed() >= Duration::from_millis(timeout_ms) {
            timed_out = true;
        }
        if canceled || overflowed || timed_out {
            let _ = child.terminate();
            let grace_started = Instant::now();
            let terminated_status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) if grace_started.elapsed() < Duration::from_secs(1) => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    _ => {
                        let _ = child.kill();
                        break child.wait().ok();
                    }
                }
            };
            break terminated_status;
        } else {
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    // Even a wrapper that exited successfully may have left descendants. The
    // retained process-group / Job authority owns and terminates that tree.
    let _ = child.terminate();
    let _ = stdin_thread.join();
    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let stderr_tail = join_utf8_tail(stderr_thread);
    // `ChildTree::terminate` is intentionally non-blocking for Drop callers.
    // A Detector lifecycle is stricter: Stop/Delete/App shutdown may return
    // only after graceful→hard escalation has actually run for descendants.
    crate::process_cmd::settle_pending_tree_terminations();
    overflowed |= stdout_overflow.load(Ordering::SeqCst);
    let duration_ms = started.elapsed().as_millis() as u64;
    let stdout_text = String::from_utf8(stdout_bytes.clone()).ok();

    if canceled {
        return Err(failure(
            "detector_canceled",
            "Detector invocation was canceled",
            duration_ms,
            stderr_tail,
        ));
    }
    if timed_out {
        let mut result = failure(
            "detector_timeout",
            format!("Detector exceeded timeoutMs={timeout_ms}"),
            duration_ms,
            stderr_tail,
        );
        result.error.timed_out = Some(true);
        return Err(result);
    }
    if overflowed || stdout_bytes.len() > MAX_DETECTOR_STDOUT_BYTES {
        return Err(failure(
            "detector_stdout_overflow",
            format!("Detector stdout exceeded {MAX_DETECTOR_STDOUT_BYTES} bytes"),
            duration_ms,
            stderr_tail,
        ));
    }
    if let Some(error) = stdin_error
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Err(failure(
            "detector_stdin_failed",
            error,
            duration_ms,
            stderr_tail,
        ));
    }
    let Some(status) = status else {
        return Err(failure(
            "detector_wait_failed",
            "Detector ended without an exit status",
            duration_ms,
            stderr_tail,
        ));
    };
    if !status.success() {
        let mut result = failure(
            "detector_nonzero_exit",
            format!("Detector exited unsuccessfully: {status}"),
            duration_ms,
            stderr_tail,
        );
        result.error.exit_code = status.code();
        result.error.signal = exit_signal(&status);
        result.stdout = stdout_text;
        return Err(result);
    }
    let stdout = match String::from_utf8(stdout_bytes) {
        Ok(stdout) => stdout,
        Err(error) => {
            return Err(failure(
                "detector_stdout_invalid_utf8",
                format!("Detector stdout is not UTF-8: {error}"),
                duration_ms,
                stderr_tail,
            ));
        }
    };
    let parsed = match parse_detector_output(stdout.as_bytes()) {
        Ok(parsed) => parsed,
        Err((code, message)) => {
            let mut result = failure(code, message, duration_ms, stderr_tail);
            result.stdout = Some(stdout);
            return Err(result);
        }
    };
    Ok(DetectorRunSuccess {
        invocation_id,
        decision: parsed.control.decision,
        reason: parsed.control.reason,
        event: parsed.control.event,
        handoff: parsed.handoff,
        next_checkpoint: parsed.control.next_checkpoint,
        duration_ms,
        exit_code: status.code().unwrap_or(0),
        stderr_tail,
    })
}

/// Build the deliberately small Detector environment. Detector scripts run as
/// the desktop user, but they are not Provider/Session subprocesses and must
/// never inherit API keys, MyAgents control ports, or arbitrary launch-shell
/// variables. Generic proxy/certificate variables remain part of the local
/// command baseline; the canonical proxy helper applies the configured policy
/// after this allowlist is installed.
fn apply_detector_environment(command: &mut std::process::Command) {
    const BASELINE_KEYS: &[&str] = &[
        "HOME",
        "USER",
        "LOGNAME",
        "USERPROFILE",
        "USERNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "ComSpec",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];

    command.env_clear();
    for key in BASELINE_KEYS {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", crate::system_binary::augmented_path())
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
}

fn read_bounded(mut reader: impl Read, limit: usize, overflow: Option<Arc<AtomicBool>>) -> Vec<u8> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(output.len());
                output.extend_from_slice(&chunk[..read.min(remaining)]);
                if read > remaining {
                    if let Some(overflow) = overflow.as_ref() {
                        overflow.store(true, Ordering::SeqCst);
                    }
                    break;
                }
            }
        }
    }
    output
}

fn read_tail(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut tail = VecDeque::with_capacity(limit);
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                for byte in &chunk[..read] {
                    if tail.len() == limit {
                        tail.pop_front();
                    }
                    tail.push_back(*byte);
                }
            }
        }
    }
    tail.into_iter().collect()
}

fn join_utf8_tail(thread: std::thread::JoinHandle<Vec<u8>>) -> Option<String> {
    let bytes = thread.join().unwrap_or_default();
    if bytes.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| signal.to_string())
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

fn parse_detector_output(bytes: &[u8]) -> Result<DetectorProtocolOutput, (String, String)> {
    let output: DetectorProtocolOutput = serde_json::from_slice(bytes).map_err(|error| {
        (
            "detector_protocol_invalid_json".to_string(),
            format!("Detector stdout is not one valid protocol object: {error}"),
        )
    })?;
    if output.protocol_version != DETECTOR_PROTOCOL_VERSION {
        return Err((
            "detector_protocol_version_mismatch".to_string(),
            format!(
                "Detector protocolVersion must be {DETECTOR_PROTOCOL_VERSION}, got {}",
                output.protocol_version
            ),
        ));
    }
    validate_reason(&output.control.reason)?;
    if let Some(checkpoint) = output.control.next_checkpoint.as_ref() {
        let bytes = serde_json::to_vec(checkpoint).map_err(|error| {
            (
                "detector_checkpoint_invalid".to_string(),
                format!("Failed to serialize nextCheckpoint: {error}"),
            )
        })?;
        if bytes.len() > MAX_CHECKPOINT_BYTES {
            return Err((
                "detector_checkpoint_too_large".to_string(),
                format!("nextCheckpoint exceeds {MAX_CHECKPOINT_BYTES} bytes"),
            ));
        }
    }
    match output.control.decision {
        DetectorDecision::Quiet => {
            if output.control.event.is_some() || output.handoff.is_some() {
                return Err((
                    "detector_quiet_payload_invalid".to_string(),
                    "quiet decision may not include event or handoff".to_string(),
                ));
            }
        }
        DetectorDecision::Activate => {
            let event = output.control.event.as_ref().ok_or_else(|| {
                (
                    "detector_activate_event_missing".to_string(),
                    "activate decision requires event".to_string(),
                )
            })?;
            validate_event(event)?;
            let handoff = output.handoff.as_ref().ok_or_else(|| {
                (
                    "detector_activate_handoff_missing".to_string(),
                    "activate decision requires handoff".to_string(),
                )
            })?;
            validate_handoff(handoff)?;
        }
    }
    Ok(output)
}

fn validate_reason(reason: &TaskTriggerReason) -> Result<(), (String, String)> {
    if !is_code(&reason.code, 64, false) {
        return Err((
            "detector_reason_code_invalid".to_string(),
            "reason.code must match [a-z0-9._-]{1,64}".to_string(),
        ));
    }
    let chars = reason.message.chars().count();
    if !(1..=2000).contains(&chars) {
        return Err((
            "detector_reason_message_invalid".to_string(),
            "reason.message must contain 1..=2000 Unicode characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_event(event: &TaskActivationEvent) -> Result<(), (String, String)> {
    if event.id.is_empty()
        || event.id.chars().count() > 256
        || event.id.chars().any(is_unicode_control_or_format)
    {
        return Err((
            "detector_event_id_invalid".to_string(),
            "event.id must contain 1..=256 characters without Unicode control or format code points"
                .to_string(),
        ));
    }
    if !is_code(&event.kind, 128, true) {
        return Err((
            "detector_event_kind_invalid".to_string(),
            "event.kind must match [a-zA-Z0-9._-]{1,128}".to_string(),
        ));
    }
    if !has_strict_rfc3339_offset_shape(&event.occurred_at) {
        return Err((
            "detector_event_time_invalid".to_string(),
            "event.occurredAt must use YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)".to_string(),
        ));
    }
    DateTime::parse_from_rfc3339(&event.occurred_at).map_err(|error| {
        (
            "detector_event_time_invalid".to_string(),
            format!("event.occurredAt must be RFC3339 with an explicit offset: {error}"),
        )
    })?;
    Ok(())
}

/// Chrono intentionally accepts several relaxed RFC3339 spellings (including
/// a space separator and `UTC`) that JavaScript's admission boundary rejects.
/// Lock the lexical v1 wire shape before using Chrono for calendar validation.
fn has_strict_rfc3339_offset_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || !bytes.iter().all(u8::is_ascii)
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || ![0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|index| bytes[index].is_ascii_digit())
    {
        return false;
    }
    // Chrono models leap seconds and therefore accepts `:60`; JavaScript's
    // admission boundary and this protocol intentionally do not.
    if (bytes[17] - b'0') * 10 + (bytes[18] - b'0') > 59 {
        return false;
    }

    let mut zone_start = 19;
    if bytes.get(zone_start) == Some(&b'.') {
        zone_start += 1;
        let fraction_start = zone_start;
        while bytes.get(zone_start).is_some_and(u8::is_ascii_digit) {
            zone_start += 1;
        }
        if zone_start == fraction_start {
            return false;
        }
    }
    match bytes.get(zone_start) {
        Some(b'Z') => zone_start + 1 == bytes.len(),
        Some(b'+') | Some(b'-') => {
            zone_start + 6 == bytes.len()
                && bytes[zone_start + 1].is_ascii_digit()
                && bytes[zone_start + 2].is_ascii_digit()
                && bytes[zone_start + 3] == b':'
                && bytes[zone_start + 4].is_ascii_digit()
                && bytes[zone_start + 5].is_ascii_digit()
        }
        _ => false,
    }
}

/// Match the protocol's cross-language `Unicode Cc | Cf` exclusion without
/// accepting invisible event identities in Rust that the Node boundary later
/// rejects. `char::is_control()` covers Cc; the ranges below are the Unicode
/// format controls (Cf) relevant to scalar values.
fn is_unicode_control_or_format(value: char) -> bool {
    if value.is_control() {
        return true;
    }
    matches!(
        value as u32,
        0x00AD
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x08E2
            | 0x180E
            | 0xFEFF
            | 0x110BD
            | 0x110CD
            | 0xE0001
            | 0x0600..=0x0605
            | 0x0890..=0x0891
            | 0x17B4..=0x17B5
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFFF9..=0xFFFB
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0020..=0xE007F
    )
}

fn validate_handoff(handoff: &TaskActivationHandoff) -> Result<(), (String, String)> {
    let summary_chars = handoff.summary.chars().count();
    if !(1..=2000).contains(&summary_chars) {
        return Err((
            "detector_handoff_summary_invalid".to_string(),
            "handoff.summary must contain 1..=2000 Unicode characters".to_string(),
        ));
    }
    if handoff
        .text
        .as_ref()
        .is_some_and(|text| text.len() > MAX_HANDOFF_TEXT_BYTES)
    {
        return Err((
            "detector_handoff_text_too_large".to_string(),
            format!("handoff.text exceeds {MAX_HANDOFF_TEXT_BYTES} UTF-8 bytes"),
        ));
    }
    let bytes = serde_json::to_vec(handoff).map_err(|error| {
        (
            "detector_handoff_invalid".to_string(),
            format!("Failed to serialize handoff: {error}"),
        )
    })?;
    if bytes.len() > MAX_HANDOFF_BYTES {
        return Err((
            "detector_handoff_too_large".to_string(),
            format!("handoff exceeds {MAX_HANDOFF_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn is_code(value: &str, max: usize, uppercase: bool) -> bool {
    let len = value.chars().count();
    (1..=max).contains(&len)
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || (uppercase && character.is_ascii_uppercase())
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

fn failure(
    code: impl Into<String>,
    message: impl Into<String>,
    duration_ms: u64,
    stderr_tail: Option<String>,
) -> DetectorRunFailure {
    let mut error = TaskTriggerError::new(code, message);
    error.stderr_tail = stderr_tail;
    DetectorRunFailure {
        error: Box::new(error),
        duration_ms,
        stdout: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerCommitDisposition {
    Quiet,
    Activate,
    Deduplicated,
}

#[derive(Debug, Clone)]
pub struct TriggerCommitResult {
    pub state: TaskTriggerRuntimeState,
    pub disposition: TriggerCommitDisposition,
    pub pending_activation: Option<PendingTaskActivation>,
}

#[cfg(test)]
fn forced_trigger_cleanup_failures() -> &'static Mutex<std::collections::HashSet<String>> {
    static FAILURES: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

#[cfg(test)]
pub(crate) struct ForcedTriggerCleanupFailure {
    task_id: String,
}

#[cfg(test)]
impl Drop for ForcedTriggerCleanupFailure {
    fn drop(&mut self) {
        forced_trigger_cleanup_failures()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.task_id);
    }
}

#[cfg(test)]
pub(crate) fn force_trigger_cleanup_failure(task_id: &str) -> ForcedTriggerCleanupFailure {
    forced_trigger_cleanup_failures()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(task_id.to_string());
    ForcedTriggerCleanupFailure {
        task_id: task_id.to_string(),
    }
}

impl crate::task::TaskStore {
    pub async fn read_trigger_state(
        &self,
        task_id: &str,
    ) -> Result<TaskTriggerRuntimeState, String> {
        crate::task::validate_safe_id(task_id, "taskId")?;
        let path = self.trigger_state_path(task_id)?;
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TaskTriggerRuntimeState::default());
            }
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        let state: TaskTriggerRuntimeState = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        if state.protocol_version != DETECTOR_PROTOCOL_VERSION {
            return Err(format!(
                "unsupported trigger state protocolVersion {}",
                state.protocol_version
            ));
        }
        Ok(state)
    }

    pub async fn remove_trigger_state(&self, task_id: &str) -> Result<(), String> {
        self.ensure_writable()?;
        self.remove_trigger_state_file(task_id)
    }

    pub(crate) fn remove_trigger_state_file(&self, task_id: &str) -> Result<(), String> {
        #[cfg(test)]
        if forced_trigger_cleanup_failures()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(task_id)
        {
            return Err(format!(
                "remove trigger state for {task_id}: injected cleanup failure"
            ));
        }
        let path = self.trigger_state_path(task_id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("remove {}: {error}", path.display())),
        }
    }

    pub async fn reset_trigger_checkpoint(
        &self,
        task_id: &str,
    ) -> Result<TaskTriggerRuntimeState, String> {
        self.ensure_writable()?;
        let mut state = self.read_trigger_state(task_id).await?;
        state.checkpoint = None;
        state.checkpoint_revision = state.checkpoint_revision.saturating_add(1);
        state.checkpoint_updated_at = Some(Utc::now().timestamp_millis());
        self.write_trigger_state(task_id, &state)?;
        Ok(state)
    }

    pub async fn commit_detector_success(
        &self,
        task: &crate::task::Task,
        success: &DetectorRunSuccess,
        invocation_cause: DetectorInvocationCause,
    ) -> Result<TriggerCommitResult, String> {
        self.ensure_writable()?;
        if invocation_cause == DetectorInvocationCause::Test {
            return Err("test Detector invocation cannot commit runtime state".to_string());
        }
        let mut state = self.read_trigger_state(&task.id).await?;
        let now = Utc::now().timestamp_millis();
        state.check_count = state.check_count.saturating_add(1);
        state.last_checked_at = Some(now);
        state.last_reason = Some(success.reason.clone());
        state.consecutive_failures = 0;
        state.backoff_until = None;
        state.last_error = None;
        if let Some(next_checkpoint) = success.next_checkpoint.clone() {
            state.checkpoint = next_checkpoint;
            state.checkpoint_revision = state.checkpoint_revision.saturating_add(1);
            state.checkpoint_updated_at = Some(now);
        }
        let (disposition, pending_activation) = match success.decision {
            DetectorDecision::Quiet => {
                state.last_outcome = Some(TaskTriggerRuntimeOutcome::Quiet);
                (TriggerCommitDisposition::Quiet, None)
            }
            DetectorDecision::Activate => {
                let event = success
                    .event
                    .clone()
                    .ok_or_else(|| "activate result is missing event".to_string())?;
                let duplicate = state
                    .pending_activation
                    .as_ref()
                    .is_some_and(|pending| pending.event.id == event.id)
                    || state
                        .recent_event_ids
                        .iter()
                        .any(|recent| recent.id == event.id);
                if duplicate {
                    state.last_outcome = Some(TaskTriggerRuntimeOutcome::Deduplicated);
                    (TriggerCommitDisposition::Deduplicated, None)
                } else {
                    if state.pending_activation.is_some() {
                        return Err(
                            "a different pending Activation Event must settle before a new check"
                                .to_string(),
                        );
                    }
                    let pending = PendingTaskActivation {
                        event,
                        handoff: success
                            .handoff
                            .clone()
                            .ok_or_else(|| "activate result is missing handoff".to_string())?,
                        reason: success.reason.clone(),
                        invocation_cause,
                        detected_at: now,
                        task_updated_at: task.updated_at,
                        delivery_state: TaskActivationDeliveryState::Pending,
                        queue_id: None,
                    };
                    state.last_outcome = Some(TaskTriggerRuntimeOutcome::Activate);
                    state.last_activated_at = Some(now);
                    state.pending_activation = Some(pending.clone());
                    (TriggerCommitDisposition::Activate, Some(pending))
                }
            }
        };
        self.write_trigger_state(&task.id, &state)?;
        Ok(TriggerCommitResult {
            state,
            disposition,
            pending_activation,
        })
    }

    pub async fn commit_detector_failure(
        &self,
        task_id: &str,
        error: TaskTriggerError,
    ) -> Result<TaskTriggerRuntimeState, String> {
        self.ensure_writable()?;
        let mut state = self.read_trigger_state(task_id).await?;
        let now = Utc::now().timestamp_millis();
        state.check_count = state.check_count.saturating_add(1);
        state.last_checked_at = Some(now);
        state.last_outcome = Some(TaskTriggerRuntimeOutcome::Error);
        state.last_reason = None;
        state.last_error = Some(error);
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        let exponent = state.consecutive_failures.saturating_sub(1).min(4);
        let backoff_minutes = (5_i64 * (1_i64 << exponent)).min(60);
        state.backoff_until = Some(now.saturating_add(backoff_minutes * 60_000));
        self.write_trigger_state(task_id, &state)?;
        Ok(state)
    }

    pub async fn bind_pending_activation_queue(
        &self,
        task_id: &str,
        event_id: &str,
        queue_id: &str,
    ) -> Result<PendingTaskActivation, String> {
        self.ensure_writable()?;
        let mut state = self.read_trigger_state(task_id).await?;
        let pending = state
            .pending_activation
            .as_mut()
            .filter(|pending| pending.event.id == event_id)
            .ok_or_else(|| format!("pending Activation Event not found: {event_id}"))?;
        if let Some(existing) = pending.queue_id.as_deref() {
            if existing != queue_id {
                return Err(format!(
                    "pending Activation Event is already bound to queueId {existing}"
                ));
            }
        }
        pending.queue_id = Some(queue_id.to_string());
        pending.delivery_state = TaskActivationDeliveryState::Dispatching;
        let pending = pending.clone();
        self.write_trigger_state(task_id, &state)?;
        Ok(pending)
    }

    pub async fn settle_pending_activation(
        &self,
        task_id: &str,
        event_id: &str,
    ) -> Result<TaskTriggerRuntimeState, String> {
        self.ensure_writable()?;
        let mut state = self.read_trigger_state(task_id).await?;
        let Some(pending) = state.pending_activation.as_ref() else {
            return Ok(state);
        };
        if pending.event.id != event_id {
            return Err(format!(
                "pending Activation Event id mismatch: expected {}, got {event_id}",
                pending.event.id
            ));
        }
        state.pending_activation = None;
        state.recent_event_ids.push(RecentTaskActivation {
            id: event_id.to_string(),
            settled_at: Utc::now().timestamp_millis(),
        });
        if state.recent_event_ids.len() > RECENT_EVENT_LIMIT {
            let overflow = state.recent_event_ids.len() - RECENT_EVENT_LIMIT;
            state.recent_event_ids.drain(0..overflow);
        }
        self.write_trigger_state(task_id, &state)?;
        Ok(state)
    }

    pub async fn cancel_pending_activation(
        &self,
        task_id: &str,
    ) -> Result<TaskTriggerRuntimeState, String> {
        self.ensure_writable()?;
        let mut state = self.read_trigger_state(task_id).await?;
        state.pending_activation = None;
        self.write_trigger_state(task_id, &state)?;
        Ok(state)
    }

    fn write_trigger_state(
        &self,
        task_id: &str,
        state: &TaskTriggerRuntimeState,
    ) -> Result<(), String> {
        let json = serde_json::to_string_pretty(state)
            .map_err(|error| format!("serialize trigger state: {error}"))?;
        crate::task::write_atomic_text(&self.trigger_state_path(task_id)?, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn command_task() -> crate::task::Task {
        serde_json::from_value(serde_json::json!({
            "id": "sensor-task",
            "name": "sensor",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": "session-real",
            "trigger": {
                "source": { "type": "time" },
                "detector": {
                    "type": "command",
                    "command": { "executable": "/bin/sh", "args": [] },
                    "timeoutMs": 30000
                }
            },
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 2,
            "executionCount": 0,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap()
    }

    fn quiet_success(checkpoint: Option<Option<Map<String, Value>>>) -> DetectorRunSuccess {
        DetectorRunSuccess {
            invocation_id: "invocation-1".to_string(),
            decision: DetectorDecision::Quiet,
            reason: TaskTriggerReason {
                code: "no_change".to_string(),
                message: "No change".to_string(),
            },
            event: None,
            handoff: None,
            next_checkpoint: checkpoint,
            duration_ms: 1,
            exit_code: 0,
            stderr_tail: None,
        }
    }

    fn activate_success(event_id: &str) -> DetectorRunSuccess {
        DetectorRunSuccess {
            invocation_id: "invocation-2".to_string(),
            decision: DetectorDecision::Activate,
            reason: TaskTriggerReason {
                code: "build_failed".to_string(),
                message: "Build failed".to_string(),
            },
            event: Some(TaskActivationEvent {
                id: event_id.to_string(),
                kind: "ci.build.failed".to_string(),
                occurred_at: "2026-07-31T02:00:00.000Z".to_string(),
            }),
            handoff: Some(TaskActivationHandoff {
                summary: "Build failed".to_string(),
                text: None,
                data: None,
            }),
            next_checkpoint: None,
            duration_ms: 1,
            exit_code: 0,
            stderr_tail: None,
        }
    }

    #[test]
    fn missing_trigger_defaults_to_always() {
        let task: crate::task::Task = serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp",
            "executionMode": "once",
            "sessionIds": [],
            "status": "todo",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "executionCount": 0,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        assert_eq!(task.effective_trigger(), TaskTrigger::default());
        assert!(task.trigger.is_none());
    }

    #[test]
    fn protocol_parser_distinguishes_omitted_and_null_checkpoint() {
        let omitted = parse_detector_output(
            br#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"no_change","message":"none"}}}"#,
        )
        .unwrap();
        assert_eq!(omitted.control.next_checkpoint, None);
        let cleared = parse_detector_output(
            br#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"no_change","message":"none"},"nextCheckpoint":null}}"#,
        )
        .unwrap();
        assert_eq!(cleared.control.next_checkpoint, Some(None));
    }

    #[test]
    fn protocol_parser_rejects_unknown_fields_and_third_decision() {
        let unknown = br#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"no_change","message":"none"},"typo":true}}"#;
        assert!(parse_detector_output(unknown).is_err());
        let third = br#"{"protocolVersion":1,"control":{"decision":"failure","reason":{"code":"failed","message":"bad"}}}"#;
        assert!(parse_detector_output(third).is_err());
    }

    #[test]
    fn protocol_parser_requires_activate_event_and_handoff() {
        let missing = br#"{"protocolVersion":1,"control":{"decision":"activate","reason":{"code":"changed","message":"changed"}}}"#;
        assert_eq!(
            parse_detector_output(missing).unwrap_err().0,
            "detector_activate_event_missing"
        );
    }

    #[test]
    fn protocol_parser_rejects_unicode_format_controls_in_event_ids() {
        let output = br#"{"protocolVersion":1,"control":{"decision":"activate","reason":{"code":"changed","message":"changed"},"event":{"id":"build\u200b319","kind":"ci.failed","occurredAt":"2026-08-03T09:30:00Z"}},"handoff":{"summary":"failed"}}"#;
        assert_eq!(
            parse_detector_output(output).unwrap_err().0,
            "detector_event_id_invalid"
        );
    }

    #[test]
    fn protocol_parser_uses_the_same_strict_event_time_shape_as_node() {
        let output = |occurred_at: &str| {
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "control": {
                    "decision": "activate",
                    "reason": { "code": "changed", "message": "changed" },
                    "event": {
                        "id": "build-319",
                        "kind": "ci.failed",
                        "occurredAt": occurred_at,
                    }
                },
                "handoff": { "summary": "failed" }
            }))
            .unwrap()
        };

        for valid in [
            "2026-08-03T12:34:56Z",
            "2026-08-03T12:34:56.123456+08:00",
            "2024-02-29T23:59:59-05:30",
        ] {
            assert!(parse_detector_output(&output(valid)).is_ok(), "{valid}");
        }
        for relaxed_chrono_only in [
            "2026-08-03 12:34:56UTC",
            "2026-08-03t12:34:56z",
            "2026-08-03T12:34:56UTC",
            "2026-08-03T12:34:56",
            "2026-08-03T23:59:60Z",
            "2026-02-30T12:00:00Z",
            "2026-04-31T12:00:00Z",
            "2026-08-03T24:00:00Z",
        ] {
            assert_eq!(
                parse_detector_output(&output(relaxed_chrono_only))
                    .unwrap_err()
                    .0,
                "detector_event_time_invalid",
                "{relaxed_chrono_only}"
            );
        }
    }

    #[test]
    fn packaged_task_automation_detector_examples_match_the_real_validators() {
        let skill = include_str!(
            "../../bundled-skills/myagents-task-automation/references/command-detector.md"
        );
        let index = include_str!("../../bundled-skills/myagents-task-automation/SKILL.md");
        assert!(index.contains("myagents task start <taskId>"));
        assert!(!index.contains("myagents cron start <taskId>"));
        let blocks = skill
            .split("```json")
            .skip(1)
            .filter_map(|tail| tail.split("```").next())
            .collect::<Vec<_>>();
        assert!(
            !blocks.is_empty(),
            "Task automation Detector reference must contain JSON examples"
        );
        let mut trigger_examples = 0;
        let mut output_examples = 0;
        for block in blocks {
            let value: serde_json::Value = serde_json::from_str(block.trim())
                .expect("every sensor Skill JSON block must parse");
            if value.get("source").is_some() && value.get("detector").is_some() {
                let trigger: TaskTrigger = serde_json::from_value(value).unwrap();
                validate_task_trigger(&trigger).unwrap();
                trigger_examples += 1;
            } else if value.get("control").is_some() {
                parse_detector_output(block.trim().as_bytes()).unwrap();
                output_examples += 1;
            }
        }
        assert_eq!(trigger_examples, 1);
        assert_eq!(output_examples, 2);
    }

    #[tokio::test]
    async fn trigger_state_survives_restart_and_preserves_checkpoint_on_failure() {
        let dir = tempdir().unwrap();
        let store_dir = dir.path().join("data");
        let store = crate::task::TaskStore::new(store_dir.clone());
        let task = command_task();
        let mut checkpoint = Map::new();
        checkpoint.insert("cursor".to_string(), Value::from(7));
        let committed = store
            .commit_detector_success(
                &task,
                &quiet_success(Some(Some(checkpoint.clone()))),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();
        assert_eq!(committed.state.checkpoint, Some(checkpoint.clone()));
        assert_eq!(committed.state.checkpoint_revision, 1);
        assert_eq!(committed.state.check_count, 1);

        let recovered = crate::task::TaskStore::new(store_dir);
        let state = recovered.read_trigger_state(&task.id).await.unwrap();
        assert_eq!(state.checkpoint, Some(checkpoint.clone()));
        let failure = TaskTriggerError::new("detector_timeout", "timed out");
        let failed = recovered
            .commit_detector_failure(&task.id, failure)
            .await
            .unwrap();
        assert_eq!(failed.checkpoint, Some(checkpoint));
        assert_eq!(failed.checkpoint_revision, 1);
        assert_eq!(failed.check_count, 2);
        assert_eq!(failed.consecutive_failures, 1);
        assert!(failed.backoff_until.is_some());
    }

    #[tokio::test]
    async fn checkpoint_omit_null_and_replace_have_distinct_durable_revisions() {
        let dir = tempdir().unwrap();
        let store = crate::task::TaskStore::new(dir.path().join("data"));
        let task = command_task();

        let mut first = Map::new();
        first.insert("cursor".to_string(), Value::from(7));
        let replaced = store
            .commit_detector_success(
                &task,
                &quiet_success(Some(Some(first.clone()))),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap()
            .state;
        assert_eq!(replaced.checkpoint.as_ref(), Some(&first));
        assert_eq!(replaced.checkpoint_revision, 1);
        assert!(replaced.checkpoint_updated_at.is_some());

        let omitted = store
            .commit_detector_success(
                &task,
                &quiet_success(None),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap()
            .state;
        assert_eq!(omitted.checkpoint.as_ref(), Some(&first));
        assert_eq!(omitted.checkpoint_revision, 1);
        assert_eq!(
            omitted.checkpoint_updated_at, replaced.checkpoint_updated_at,
            "omission preserves the exact checkpoint snapshot"
        );

        let cleared = store
            .commit_detector_success(
                &task,
                &quiet_success(Some(None)),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap()
            .state;
        assert_eq!(cleared.checkpoint, None);
        assert_eq!(cleared.checkpoint_revision, 2);
        assert!(cleared.checkpoint_updated_at.is_some());

        let mut second = Map::new();
        second.insert("cursor".to_string(), Value::from(9));
        let replaced_again = store
            .commit_detector_success(
                &task,
                &quiet_success(Some(Some(second.clone()))),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap()
            .state;
        assert_eq!(replaced_again.checkpoint, Some(second));
        assert_eq!(replaced_again.checkpoint_revision, 3);
    }

    #[test]
    fn checkpoint_protocol_accepts_64kib_and_rejects_one_byte_over() {
        fn output_with_checkpoint_size(target_bytes: usize) -> Vec<u8> {
            let mut checkpoint = Map::new();
            checkpoint.insert("v".to_string(), Value::String(String::new()));
            let overhead = serde_json::to_vec(&checkpoint).unwrap().len();
            checkpoint.insert(
                "v".to_string(),
                Value::String("x".repeat(target_bytes - overhead)),
            );
            assert_eq!(serde_json::to_vec(&checkpoint).unwrap().len(), target_bytes);
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "control": {
                    "decision": "quiet",
                    "reason": { "code": "no_change", "message": "none" },
                    "nextCheckpoint": checkpoint,
                }
            }))
            .unwrap()
        }

        assert!(parse_detector_output(&output_with_checkpoint_size(MAX_CHECKPOINT_BYTES)).is_ok());
        assert_eq!(
            parse_detector_output(&output_with_checkpoint_size(MAX_CHECKPOINT_BYTES + 1))
                .unwrap_err()
                .0,
            "detector_checkpoint_too_large"
        );
    }

    #[tokio::test]
    async fn activation_is_durable_bound_settled_and_deduplicated() {
        let dir = tempdir().unwrap();
        let store = crate::task::TaskStore::new(dir.path().join("data"));
        let task = command_task();
        let activated = store
            .commit_detector_success(
                &task,
                &activate_success("build-319"),
                DetectorInvocationCause::CheckNow,
            )
            .await
            .unwrap();
        assert_eq!(activated.disposition, TriggerCommitDisposition::Activate);
        assert_eq!(
            activated
                .state
                .pending_activation
                .as_ref()
                .map(|pending| pending.invocation_cause),
            Some(DetectorInvocationCause::CheckNow)
        );
        let mut legacy_pending =
            serde_json::to_value(activated.state.pending_activation.as_ref().unwrap()).unwrap();
        legacy_pending
            .as_object_mut()
            .unwrap()
            .remove("invocationCause");
        let legacy_pending: PendingTaskActivation = serde_json::from_value(legacy_pending).unwrap();
        assert_eq!(
            legacy_pending.invocation_cause,
            DetectorInvocationCause::Scheduled,
            "pre-origin outbox entries recover as scheduled"
        );
        assert_eq!(
            activated
                .state
                .pending_activation
                .as_ref()
                .map(|pending| pending.event.id.as_str()),
            Some("build-319")
        );
        let bound = store
            .bind_pending_activation_queue(&task.id, "build-319", "queue-1")
            .await
            .unwrap();
        assert_eq!(bound.queue_id.as_deref(), Some("queue-1"));
        store
            .settle_pending_activation(&task.id, "build-319")
            .await
            .unwrap();
        let duplicate = store
            .commit_detector_success(
                &task,
                &activate_success("build-319"),
                DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();
        assert_eq!(
            duplicate.disposition,
            TriggerCommitDisposition::Deduplicated
        );
        assert!(duplicate.state.pending_activation.is_none());
        assert_eq!(duplicate.state.recent_event_ids.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_uses_protocol_and_times_out() {
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let stdout = r#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"no_change","message":"none"}}}"#;
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), format!("printf '%s' '{stdout}'")],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(5_000),
            },
        };
        let result = run_command_detector(
            app.handle(),
            DetectorRunRequest {
                task_id: "runner-test".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            DetectorCancellation::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.decision, DetectorDecision::Quiet);

        let timeout_trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), "sleep 5".to_string()],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(1_000),
            },
        };
        let failure = run_command_detector(
            app.handle(),
            DetectorRunRequest {
                task_id: "runner-timeout".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger: timeout_trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            DetectorCancellation::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure.error.code, "detector_timeout");
        assert_eq!(failure.error.timed_out, Some(true));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_excludes_parent_secrets_and_sets_utf8_baseline() {
        const SENTINEL: &str = "MYAGENTS_DETECTOR_SECRET_SENTINEL";
        let previous = std::env::var_os(SENTINEL);
        std::env::set_var(SENTINEL, "must-not-leak");
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let script = concat!(
            "if [ -z \"${MYAGENTS_DETECTOR_SECRET_SENTINEL+x}\" ] ",
            "&& [ \"$PYTHONUTF8\" = 1 ] ",
            "&& [ \"$PYTHONIOENCODING\" = utf-8 ] ",
            "&& [ -n \"$PATH\" ]; then ",
            "printf '%s' '{\"protocolVersion\":1,\"control\":{\"decision\":\"quiet\",\"reason\":{\"code\":\"env_isolated\",\"message\":\"isolated\"}}}'; ",
            "else exit 17; fi"
        );
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), script.to_string()],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(5_000),
            },
        };
        let result = run_command_detector(
            app.handle(),
            DetectorRunRequest {
                task_id: "env-isolation".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            DetectorCancellation::new(),
        )
        .await;
        match previous {
            Some(value) => std::env::set_var(SENTINEL, value),
            None => std::env::remove_var(SENTINEL),
        }
        assert_eq!(result.unwrap().reason.code, "env_isolated");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_rejects_stdout_overflow() {
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        format!("head -c {} /dev/zero", MAX_DETECTOR_STDOUT_BYTES + 1),
                    ],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(5_000),
            },
        };

        let failure = run_command_detector(
            app.handle(),
            DetectorRunRequest {
                task_id: "runner-overflow".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            DetectorCancellation::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.error.code, "detector_stdout_overflow");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_keeps_only_the_bounded_stderr_tail() {
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        format!(
                            "head -c {} /dev/zero >&2; printf 'TAIL' >&2; exit 7",
                            MAX_DETECTOR_STDERR_BYTES + 100
                        ),
                    ],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(5_000),
            },
        };

        let failure = run_command_detector(
            app.handle(),
            DetectorRunRequest {
                task_id: "runner-stderr-tail".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            DetectorCancellation::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.error.code, "detector_nonzero_exit");
        assert_eq!(failure.error.exit_code, Some(7));
        let tail = failure.error.stderr_tail.expect("stderr tail");
        assert_eq!(tail.as_bytes().len(), MAX_DETECTOR_STDERR_BYTES);
        assert!(tail.ends_with("TAIL"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_cancellation_settles_the_process() {
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let cancellation = DetectorCancellation::new();
        let cancel_signal = cancellation.clone();
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), "sleep 30".to_string()],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(30_000),
            },
        };
        let request = DetectorRunRequest {
            task_id: "runner-cancel".to_string(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            trigger,
            cause: DetectorInvocationCause::Test,
            scheduled_at: None,
            checkpoint: None,
            checkpoint_revision: 0,
            checkpoint_updated_at: None,
        };
        let cancel = async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_signal.cancel();
        };
        let (result, ()) = tokio::join!(
            run_command_detector(app.handle(), request, cancellation),
            cancel
        );
        let failure = result.unwrap_err();

        assert_eq!(failure.error.code, "detector_canceled");
        assert!(failure.duration_ms < 5_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runner_cancellation_kills_descendants_before_returning() {
        let app = tauri::test::mock_app();
        let dir = tempdir().unwrap();
        let child_pid_path = dir.path().join("child.pid");
        let cancellation = DetectorCancellation::new();
        let cancel_signal = cancellation.clone();
        let trigger = TaskTrigger {
            source: TaskTriggerSource::Time,
            detector: TaskTriggerDetector::Command {
                command: TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        "sleep 30 & echo $! > \"$1\"; wait".to_string(),
                        "detector".to_string(),
                        child_pid_path.to_string_lossy().into_owned(),
                    ],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(30_000),
            },
        };

        let request = DetectorRunRequest {
            task_id: "runner-tree-cancel".to_string(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            trigger,
            cause: DetectorInvocationCause::Test,
            scheduled_at: None,
            checkpoint: None,
            checkpoint_revision: 0,
            checkpoint_updated_at: None,
        };
        let pid_path = child_pid_path.clone();
        let cancel_after_child_birth = async move {
            let child_pid = tokio::time::timeout(Duration::from_secs(10), async move {
                loop {
                    if let Ok(value) = std::fs::read_to_string(&pid_path) {
                        if !value.trim().is_empty() {
                            break value.trim().to_string();
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("Detector descendant must become observable before cancellation");
            cancel_signal.cancel();
            child_pid
        };
        let (result, child_pid) = tokio::join!(
            run_command_detector(app.handle(), request, cancellation),
            cancel_after_child_birth
        );
        assert_eq!(result.unwrap_err().error.code, "detector_canceled");

        let still_alive = crate::process_cmd::new("/bin/sh")
            .args(["-c", &format!("kill -0 {child_pid} 2>/dev/null")])
            .status()
            .expect("probe descendant")
            .success();
        assert!(
            !still_alive,
            "Detector descendant {child_pid} survived cancellation"
        );
    }
}
