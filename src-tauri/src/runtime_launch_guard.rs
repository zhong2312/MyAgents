use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SDK_CHILD_PROBE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchAdmission {
    pub admitted: bool,
    pub error_code: Option<String>,
    pub retry_after_ms: u64,
    pub admission_epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOutcome {
    Ready,
    SpawnDenied,
    Released,
}

#[derive(Debug)]
struct BlockedExecutable {
    error_code: String,
    next_probe_at: Instant,
    failure_epoch: u64,
}

#[derive(Debug)]
struct RuntimeLaunchCircuit {
    probe_interval: Duration,
    current_identity: Option<String>,
    next_epoch: u64,
    blocked: Option<BlockedExecutable>,
}

impl RuntimeLaunchCircuit {
    fn new(probe_interval: Duration) -> Self {
        Self {
            probe_interval,
            current_identity: None,
            next_epoch: 1,
            blocked: None,
        }
    }

    fn admit(&mut self, identity: &str, now: Instant) -> LaunchAdmission {
        // An app update/reinstall changes the path metadata hash. Do not let a
        // failure or late settlement from the previous executable poison the
        // replacement.
        if self.current_identity.as_deref() != Some(identity) {
            self.current_identity = Some(identity.to_owned());
            self.blocked = None;
        }

        let admission_epoch = self.next_epoch;
        self.next_epoch = self.next_epoch.saturating_add(1);
        let Some(blocked) = self.blocked.as_mut() else {
            return admitted(admission_epoch);
        };

        // `next_probe_at` is a Rust-owned lease deadline, not a flag that a
        // dying Sidecar must release. If settlement is lost, exactly one new
        // probe becomes eligible in the next interval.
        if now >= blocked.next_probe_at {
            blocked.next_probe_at = now + self.probe_interval;
            return admitted(admission_epoch);
        }

        let retry_after_ms = blocked
            .next_probe_at
            .saturating_duration_since(now)
            .as_millis()
            .min(u64::MAX as u128) as u64;
        LaunchAdmission {
            admitted: false,
            error_code: Some(blocked.error_code.clone()),
            retry_after_ms: retry_after_ms.max(1),
            admission_epoch: None,
        }
    }

    fn settle(
        &mut self,
        identity: &str,
        admission_epoch: u64,
        outcome: LaunchOutcome,
        error_code: Option<&str>,
        now: Instant,
    ) {
        // A settlement from the executable replaced by an update is stale.
        if self.current_identity.as_deref() != Some(identity) {
            return;
        }
        // Once a newer failure epoch exists, an older success/failure cannot
        // clear or replace it. This is the circuit equivalent of the Session
        // generation fence used elsewhere in the app.
        if self
            .blocked
            .as_ref()
            .is_some_and(|blocked| blocked.failure_epoch > admission_epoch)
        {
            return;
        }

        match outcome {
            LaunchOutcome::Ready => {
                self.blocked = None;
            }
            LaunchOutcome::SpawnDenied => {
                self.blocked = Some(BlockedExecutable {
                    error_code: error_code.unwrap_or("EPERM").to_owned(),
                    next_probe_at: now + self.probe_interval,
                    failure_epoch: admission_epoch,
                });
            }
            LaunchOutcome::Released => {}
        }
    }
}

fn admitted(admission_epoch: u64) -> LaunchAdmission {
    LaunchAdmission {
        admitted: true,
        error_code: None,
        retry_after_ms: 0,
        admission_epoch: Some(admission_epoch),
    }
}

fn circuit() -> &'static Mutex<RuntimeLaunchCircuit> {
    static CIRCUIT: OnceLock<Mutex<RuntimeLaunchCircuit>> = OnceLock::new();
    CIRCUIT.get_or_init(|| Mutex::new(RuntimeLaunchCircuit::new(SDK_CHILD_PROBE_INTERVAL)))
}

pub fn admit_sdk_child(identity: &str) -> LaunchAdmission {
    let mut guard = circuit()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.admit(identity, Instant::now())
}

pub fn settle_sdk_child(
    identity: &str,
    admission_epoch: u64,
    outcome: LaunchOutcome,
    error_code: Option<&str>,
) {
    let mut guard = circuit()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.settle(
        identity,
        admission_epoch,
        outcome,
        error_code,
        Instant::now(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_failure_opens_one_probe_per_window() {
        let start = Instant::now();
        let mut circuit = RuntimeLaunchCircuit::new(Duration::from_secs(60));
        let initial = circuit.admit("exe-a", start);
        assert!(initial.admitted);

        circuit.settle(
            "exe-a",
            initial.admission_epoch.unwrap(),
            LaunchOutcome::SpawnDenied,
            Some("EPERM"),
            start,
        );
        let denied = circuit.admit("exe-a", start + Duration::from_secs(1));
        assert!(!denied.admitted);
        assert_eq!(denied.error_code.as_deref(), Some("EPERM"));
        assert_eq!(denied.retry_after_ms, 59_000);

        let probe = circuit.admit("exe-a", start + Duration::from_secs(60));
        assert!(probe.admitted);
        assert!(
            !circuit
                .admit("exe-a", start + Duration::from_secs(60))
                .admitted
        );

        // Lost settlement cannot wedge the circuit or produce a 0ms loop.
        let recovered_probe = circuit.admit("exe-a", start + Duration::from_secs(120));
        assert!(recovered_probe.admitted);
        let denied_again = circuit.admit("exe-a", start + Duration::from_secs(120));
        assert!(!denied_again.admitted);
        assert!(denied_again.retry_after_ms > 0);
    }

    #[test]
    fn executable_identity_change_and_ready_control_plane_clear_the_block() {
        let start = Instant::now();
        let mut circuit = RuntimeLaunchCircuit::new(Duration::from_secs(60));
        let first = circuit.admit("exe-a", start).admission_epoch.unwrap();
        circuit.settle(
            "exe-a",
            first,
            LaunchOutcome::SpawnDenied,
            Some("EACCES"),
            start,
        );

        let replacement = circuit.admit("exe-b", start + Duration::from_secs(1));
        assert!(replacement.admitted);

        circuit.settle(
            "exe-b",
            replacement.admission_epoch.unwrap(),
            LaunchOutcome::SpawnDenied,
            Some("ENOEXEC"),
            start,
        );
        let probe = circuit.admit("exe-b", start + Duration::from_secs(60));
        circuit.settle(
            "exe-b",
            probe.admission_epoch.unwrap(),
            LaunchOutcome::Ready,
            None,
            start + Duration::from_secs(1),
        );
        assert!(
            circuit
                .admit("exe-b", start + Duration::from_secs(61))
                .admitted
        );
    }

    #[test]
    fn stale_ready_cannot_clear_a_newer_failure_epoch() {
        let start = Instant::now();
        let mut circuit = RuntimeLaunchCircuit::new(Duration::from_secs(60));
        let older = circuit.admit("exe-a", start).admission_epoch.unwrap();
        let newer = circuit.admit("exe-a", start).admission_epoch.unwrap();
        circuit.settle(
            "exe-a",
            newer,
            LaunchOutcome::SpawnDenied,
            Some("EPERM"),
            start,
        );
        circuit.settle(
            "exe-a",
            older,
            LaunchOutcome::Ready,
            None,
            start + Duration::from_secs(1),
        );

        assert!(
            !circuit
                .admit("exe-a", start + Duration::from_secs(1))
                .admitted
        );
    }
}
