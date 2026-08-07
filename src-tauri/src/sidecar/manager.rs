use super::*;

const RECOVERY_FAST_RETRY_LIMIT: u32 = 5;
const RECOVERY_FAST_RETRY_DELAY: Duration = Duration::from_secs(15);
const RECOVERY_SLOW_RETRY_INITIAL_DELAY: Duration = Duration::from_secs(60);
const RECOVERY_SLOW_RETRY_MAX_DELAY: Duration = Duration::from_secs(5 * 60);

/// Manager-owned recovery authority for one logical Session.
///
/// The retained Sidecar remains the sole owner-token source while candidate
/// processes come and go. `epoch` identifies the logical recovery job;
/// `candidate_generation` identifies only the current process attempt and may
/// change many times without settling that job.
pub(super) struct RecoveringSessionSidecar {
    sidecar: SessionSidecar,
    pub(super) epoch: u64,
    pub(super) dead_generation: u64,
    pub(super) candidate_generation: Option<u64>,
    pub(super) failed_attempts: u32,
    pub(super) next_retry_at: std::time::Instant,
}

impl std::ops::Deref for RecoveringSessionSidecar {
    type Target = SessionSidecar;

    fn deref(&self) -> &Self::Target {
        &self.sidecar
    }
}

impl std::ops::DerefMut for RecoveringSessionSidecar {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.sidecar
    }
}

#[derive(Debug, Clone)]
pub(super) struct RecoveryRestartIdentity {
    pub(super) epoch: u64,
    pub(super) dead_generation: u64,
    pub(super) attempt: u32,
    pub(super) prior_candidate_generation: Option<u64>,
    pub(super) owner: SidecarOwner,
    pub(super) workspace_path: PathBuf,
    pub(super) runtime: Option<String>,
    pub(super) runtime_source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RecoveryFailure {
    pub(super) epoch: u64,
    pub(super) dead_generation: u64,
    pub(super) candidate_generation: Option<u64>,
    pub(super) failed_attempts: u32,
    pub(super) retry_after: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ReadySidecarCommit {
    pub(super) port: u16,
    pub(super) generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BackgroundPollBinding {
    pub(super) port: u16,
    pub(super) generation: u64,
}

/// Exact process identity selected for one renderer SSE transport attempt.
/// The logical Session ID comes from manager ownership resolution rather than
/// the caller's potentially stale hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontendSidecarBinding {
    management_id: String,
    port: u16,
    generation: u64,
}

impl FrontendSidecarBinding {
    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    #[cfg(test)]
    pub(crate) fn detached_test_value() -> Self {
        Self {
            management_id: "detached-test-session".to_string(),
            port: 1,
            generation: 1,
        }
    }
}

/// An admitted control request for one exact process generation. Holding this
/// value keeps replacement from terminating that process until the response
/// body has been consumed.
pub(crate) struct SidecarHttpDispatch {
    base_url: String,
    _lease: DispatchLease,
}

impl SidecarHttpDispatch {
    pub(crate) fn url_for_path(&self, path: &str) -> Result<String, String> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(format!(
                "Sidecar request path must start with one '/': {path}"
            ));
        }
        Ok(format!("{}{}", self.base_url, path))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BackgroundPollTarget {
    Current(BackgroundPollBinding),
    Recovering,
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BackgroundOwnerAttach {
    Attached(BackgroundPollBinding),
    Recovering,
    AlreadyOwned,
    Stale,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum BackgroundOwnerRelease {
    Released {
        sidecar_stopped: bool,
        completion_claim: Option<SessionCompletionClaim>,
    },
    Stale,
    Gone,
}

/// Process-local standing demand for the canonical Global Sidecar.
///
/// This is deliberately independent from `instances`: a failed process
/// candidate may disappear while the application still requires the Global
/// service to be restored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum GlobalSidecarIntent {
    #[default]
    Stopped,
    DesiredRunning,
}

/// Atomic manager snapshot consumed by the single Global health monitor.
/// `DesiredMissing` is recoverable work, not an idle/never-started state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GlobalMonitorSnapshot {
    Stopped,
    DesiredMissing,
    Present {
        port: u16,
        process_alive: bool,
        created_at: std::time::Instant,
    },
}

/// Multi-instance Sidecar Manager
/// Manages multiple Sidecar processes with Session singleton support
///
/// Architecture (v0.1.11 - Session-Centric):
/// - Sessions own Sidecars (1:1 relationship between Session and Sidecar)
/// - Multiple owners (Tabs, Tasks, Goals, Agents, background completion) can
///   share a Session's Sidecar
/// - Sidecar only stops when all owners release
///
/// Legacy support (v0.1.10):
/// - instances: per-Tab Sidecar instances (for backward compatibility)
pub struct SidecarManager {
    // ===== New Session-Centric Storage (v0.1.11) =====
    /// Session ID -> SessionSidecar (primary storage for Session-centric model)
    pub(super) sidecars: HashMap<String, SessionSidecar>,
    /// Dead process objects retained while the health monitor starts their
    /// replacement. Keeping the object manager-owned lets ordinary release
    /// calls mutate the same owner set during the restart wait.
    pub(super) recovering_sidecars: HashMap<String, RecoveringSessionSidecar>,

    // ===== Legacy Storage (kept for backward compatibility) =====
    /// Tab ID -> Sidecar Instance (legacy, used for Global Sidecar)
    pub(super) instances: HashMap<String, SidecarInstance>,
    /// Standing lifecycle demand for the canonical Global Sidecar. Candidate
    /// insertion/removal must not mutate this authority.
    global_sidecar_intent: GlobalSidecarIntent,
    /// Port counter for allocation (starts from BASE_PORT)
    pub(super) port_counter: AtomicU16,
    /// Session ID -> generation counter. The generation is the unique instance
    /// ID of the *current* sidecar bound to that session_id, drawn from the
    /// process-global `instance_counter` below. Used both for lock-gap HTTP
    /// health-check race detection AND for IM event-consumer cancellation
    /// matching (consumer entries store the generation they were spawned
    /// against; broadcast stop events carry the generation; matching is
    /// reuse-safe because the global counter never produces the same value
    /// twice).
    pub(super) sidecar_generations: HashMap<String, u64>,
    /// Process-global monotonic counter for sidecar instance IDs. Every
    /// `insert_sidecar` draws a fresh value via `fetch_add`. Crucially, this
    /// is **never** reset — even when `sidecar_generations.clear()` runs in
    /// `stop_all` or `clear_generation` removes one entry, the counter
    /// keeps climbing. Without this, a session_id reused after idle release
    /// (IM idle collector preserves session_id by design) would get
    /// generation=1 again and a stale stop event for the previous instance
    /// would falsely match. With this, IDs are unique for the lifetime of
    /// the process and reuse is impossible.
    pub(super) instance_counter: AtomicU64,
    /// Process-global monotonic identifier for logical recovery jobs. Unlike a
    /// process generation, an epoch survives reserve/spawn/readiness failures.
    pub(super) recovery_counter: AtomicU64,
    /// Broadcast sender — emits `(session_id, generation)` whenever a
    /// SessionSidecar is removed (last owner released, runtime drift kill,
    /// explicit stop, app shutdown). The generation is critical: a remove +
    /// recreate under the same `session_id` (e.g. IM idle collector preserves
    /// session_id, next message rebuilds sidecar) bumps generation, so a
    /// stale stop event from the previous instance no longer matches the
    /// fresh consumer entry. Used by IM ImEventConsumer registry to cancel
    /// its long-poll loop in lockstep with sidecar lifecycle, instead of
    /// letting orphan consumers hammer a dead port until the 60s idle
    /// collector or app shutdown notices.
    /// Channel capacity 64 — one event per sidecar removal; multi-IM setups
    /// have at most a few simultaneous removals during shutdown bursts; on
    /// `Lagged` subscribers do a full reconciliation sweep against
    /// `live_sidecar_set()`.
    pub(super) stop_events: tokio::sync::broadcast::Sender<(String, u64)>,
    /// Broadcast sender — fires `(session_id, generation)` only when a removal
    /// is *terminal* (no owners remained at the moment of removal). This is the
    /// signal the renderer needs: distinguishes "voluntary release / shutdown /
    /// terminal failure" (Tab binding now dangling, must be cleared) from
    /// "crash with owners still attached" (health monitor will auto-restart on
    /// the next 15-s cycle, Tab binding stays valid).
    ///
    /// Why a *second* channel and not a flag on `stop_events`: existing IM
    /// consumers want every stop regardless of recoverability, and changing
    /// the payload shape would ripple through the lock-gap reconciliation
    /// code. A dedicated channel keeps both concerns orthogonal.
    /// Capacity 64 mirrors `stop_events` — same burst envelope, same lag
    /// recovery story (subscribers reconcile against `live_sidecar_set()`).
    pub(super) terminal_events: tokio::sync::broadcast::Sender<(String, u64)>,
}

impl SidecarManager {
    pub fn new() -> Self {
        // Drop the initial receiver immediately — subscribers grab their own via
        // `subscribe_stop_events()`. broadcast::Sender keeps working even with
        // zero receivers (send returns Err which we discard at call sites).
        let (stop_events, _drop_initial_rx) = tokio::sync::broadcast::channel(64);
        let (terminal_events, _drop_terminal_rx) = tokio::sync::broadcast::channel(64);
        Self {
            sidecars: HashMap::new(),
            recovering_sidecars: HashMap::new(),
            instances: HashMap::new(),
            global_sidecar_intent: GlobalSidecarIntent::Stopped,
            port_counter: AtomicU16::new(BASE_PORT),
            sidecar_generations: HashMap::new(),
            // Start at 1 so callers using `0` as an "unknown / not present"
            // placeholder (see IM `sidecar_generation_initial.unwrap_or(0)`)
            // never collide with a real allocated generation.
            instance_counter: AtomicU64::new(1),
            recovery_counter: AtomicU64::new(1),
            stop_events,
            terminal_events,
        }
    }

    /// Subscribe to sidecar-stop events. The returned receiver yields
    /// `(session_id, generation)` of each removed SessionSidecar so the
    /// subscriber can clean up any per-session state it owns (e.g. IM
    /// ImEventConsumer registry). Generation distinguishes a fresh sidecar
    /// from a previous one bound to the same session_id.
    pub fn subscribe_stop_events(&self) -> tokio::sync::broadcast::Receiver<(String, u64)> {
        self.stop_events.subscribe()
    }

    /// Subscribe to *terminal* sidecar removal events — emitted only when the
    /// removed sidecar had no remaining owners (so the health monitor will not
    /// attempt auto-restart and any frontend Tab binding to this session is
    /// definitively dangling). Used by the lib.rs forwarder to drive the
    /// `session:sidecar-terminal` Tauri event so the renderer can reset stale
    /// Tab.sessionId bindings.
    pub fn subscribe_terminal_events(&self) -> tokio::sync::broadcast::Receiver<(String, u64)> {
        self.terminal_events.subscribe()
    }

    /// Snapshot of currently-live `(session_id, generation)` pairs. Subscribers
    /// use this to recover from broadcast `Lagged` (skipped events) by
    /// reconciling: any consumer entry whose `(session_id, generation)` is
    /// *not* in this set was either stopped during the lag window or was
    /// never installed against a live sidecar — either way, cancel it.
    pub fn live_sidecar_set(&self) -> HashSet<(String, u64)> {
        self.sidecars
            .keys()
            .map(|sid| {
                let gen = self.sidecar_generations.get(sid).copied().unwrap_or(0);
                (sid.clone(), gen)
            })
            .collect()
    }

    /// Public read of the generation (= unique instance ID) for a session,
    /// or `None` if no sidecar is currently bound to that session_id.
    /// Returning `Option` (not 0) makes "never existed" explicit at call sites.
    pub fn generation_for(&self, session_id: &str) -> Option<u64> {
        if self.sidecars.contains_key(session_id) {
            self.sidecar_generations.get(session_id).copied()
        } else {
            None
        }
    }

    /// True if a sidecar with this `(session_id, generation)` is currently
    /// in `sidecars` AND its recorded generation matches. Stronger predicate
    /// than `generation_for` alone: catches the case where the manager has a
    /// stale generation entry but the sidecar HashMap entry is gone.
    /// Used by IM `ensure_im_consumer` final-check.
    pub fn is_live(&self, session_id: &str, generation: u64) -> bool {
        self.sidecars.contains_key(session_id)
            && self.sidecar_generations.get(session_id).copied() == Some(generation)
    }

    /// Validate the process identity injected into either a Session Sidecar or
    /// the canonical Global Sidecar. Both process types consume the management
    /// API, while only Session Sidecars live in `sidecars`.
    pub fn is_live_process(&self, sidecar_id: &str, generation: u64) -> bool {
        let session_process_is_live = self.sidecars.iter().any(|(session_id, sidecar)| {
            sidecar.management_id == sidecar_id
                && self.sidecar_generations.get(session_id).copied() == Some(generation)
        });
        let global_process_is_live = self.instances.contains_key(sidecar_id)
            && self.sidecar_generations.get(sidecar_id).copied() == Some(generation);

        session_process_is_live || global_process_is_live
    }

    /// Allocate the next instance ID and stash it as this session's current
    /// generation. The ID comes from the process-global atomic counter, so
    /// it is unique for the whole process lifetime — repeated sidecars under
    /// the same session_id (e.g. IM idle release + rebuild) get distinct
    /// generations, which is what makes IM event-consumer reuse race-free.
    pub(super) fn next_generation(&mut self, session_id: &str) -> u64 {
        let id = self.instance_counter.fetch_add(1, Ordering::SeqCst);
        self.sidecar_generations.insert(session_id.to_string(), id);
        if let Some(recovery) = self.recovering_sidecars.get_mut(session_id) {
            recovery.candidate_generation = Some(id);
            ulog_info!(
                "[sidecar-recovery] action=reserve session={} epoch={} dead_generation={} candidate_generation={} attempt={}",
                session_id,
                recovery.epoch,
                recovery.dead_generation,
                id,
                recovery.failed_attempts.saturating_add(1)
            );
        }
        id
    }

    /// Get the current generation counter for a session (0 if never created
    /// or has been cleared). 0 is never a real generation (counter starts at 1).
    pub(super) fn current_generation(&self, session_id: &str) -> u64 {
        self.sidecar_generations
            .get(session_id)
            .copied()
            .unwrap_or(0)
    }

    fn next_recovery_epoch(&self) -> u64 {
        self.recovery_counter.fetch_add(1, Ordering::SeqCst)
    }

    fn recovery_retry_delay(failed_attempts: u32) -> Duration {
        if failed_attempts < RECOVERY_FAST_RETRY_LIMIT {
            return RECOVERY_FAST_RETRY_DELAY;
        }

        let slow_step = failed_attempts.saturating_sub(RECOVERY_FAST_RETRY_LIMIT);
        let multiplier = 1_u32.checked_shl(slow_step.min(3)).unwrap_or(u32::MAX);
        RECOVERY_SLOW_RETRY_INITIAL_DELAY
            .saturating_mul(multiplier)
            .min(RECOVERY_SLOW_RETRY_MAX_DELAY)
    }

    /// Get the next available port with max attempts to prevent infinite loop
    pub fn allocate_port(&self) -> Result<u16, String> {
        const MAX_ATTEMPTS: u32 = 200;

        for _ in 0..MAX_ATTEMPTS {
            let port = self.port_counter.fetch_add(1, Ordering::SeqCst);

            // Reset counter if we've gone past the range
            if port > BASE_PORT + PORT_RANGE {
                self.port_counter.store(BASE_PORT, Ordering::SeqCst);
            }

            if is_port_available(port) {
                return Ok(port);
            }
        }

        Err(format!(
            "No available port found after {} attempts",
            MAX_ATTEMPTS
        ))
    }

    /// Check if a Tab has a running instance
    #[allow(dead_code)]
    pub fn has_instance(&self, tab_id: &str) -> bool {
        self.instances.contains_key(tab_id)
    }

    /// Get instance status for a Tab
    pub fn get_instance(&self, tab_id: &str) -> Option<&SidecarInstance> {
        self.instances.get(tab_id)
    }

    /// Get mutable instance reference
    pub fn get_instance_mut(&mut self, tab_id: &str) -> Option<&mut SidecarInstance> {
        self.instances.get_mut(tab_id)
    }

    /// Insert a new instance
    pub fn insert_instance(&mut self, tab_id: String, instance: SidecarInstance) {
        self.instances.insert(tab_id, instance);
    }

    /// Express application demand for the canonical Global Sidecar. Callers
    /// must acquire lifecycle birth admission before invoking this method.
    pub(super) fn request_global_sidecar_running(&mut self, source: &str) {
        let previous = self.global_sidecar_intent;
        self.global_sidecar_intent = GlobalSidecarIntent::DesiredRunning;
        ulog_info!(
            "[sidecar-global] action=intent-running source={} previous={:?}",
            source,
            previous
        );
    }

    /// End standing Global demand at an explicit lifecycle stop boundary.
    pub(super) fn request_global_sidecar_stopped(&mut self, reason: &str) {
        let previous = self.global_sidecar_intent;
        self.global_sidecar_intent = GlobalSidecarIntent::Stopped;
        ulog_info!(
            "[sidecar-global] action=intent-stopped reason={} previous={:?}",
            reason,
            previous
        );
    }

    pub(super) fn global_sidecar_is_desired(&self) -> bool {
        self.global_sidecar_intent == GlobalSidecarIntent::DesiredRunning
    }

    /// Read standing demand and the current process candidate under one
    /// manager lock, so the monitor never infers intent from `Option` alone.
    pub(super) fn global_monitor_snapshot(&mut self) -> GlobalMonitorSnapshot {
        if !self.global_sidecar_is_desired() {
            return GlobalMonitorSnapshot::Stopped;
        }

        match self.instances.get_mut(GLOBAL_SIDECAR_ID) {
            Some(instance) => GlobalMonitorSnapshot::Present {
                port: instance.port,
                process_alive: instance.is_running(),
                created_at: instance.created_at,
            },
            None => GlobalMonitorSnapshot::DesiredMissing,
        }
    }

    /// Remove and return an instance (will be dropped, killing the process)
    pub fn remove_instance(&mut self, tab_id: &str) -> Option<SidecarInstance> {
        let removed = self.instances.remove(tab_id);
        if removed.is_some() {
            self.sidecar_generations.remove(tab_id);
        }
        removed
    }

    /// Get all Tab IDs
    #[allow(dead_code)]
    pub fn tab_ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }

    /// Iterate over all instances (tab_id, instance)
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn iter_instances(&self) -> impl Iterator<Item = (&String, &SidecarInstance)> {
        self.instances.iter()
    }

    /// Get all unique ports of running Sidecars (session-centric + legacy global).
    /// Used for broadcasting config changes (e.g. proxy hot-reload) to all Sidecars.
    pub fn get_all_active_ports(&mut self) -> Vec<u16> {
        let mut ports = Vec::new();
        // Session-centric sidecars (Tab/Task/Goal/Agent/BackgroundCompletion)
        for sc in self.sidecars.values_mut() {
            if !sc.is_dead() {
                ports.push(sc.port);
            }
        }
        // Legacy instances (Global Sidecar)
        for inst in self.instances.values_mut() {
            if inst.is_running() {
                ports.push(inst.port);
            }
        }
        ports.sort();
        ports.dedup();
        ports
    }

    /// Stop all instances (session sidecars and global sidecar)
    pub fn stop_all(&mut self) {
        ulog_info!(
            "[sidecar] Stopping all instances (sessions: {}, global: {})",
            self.sidecars.len(),
            self.instances.len()
        );
        // Broadcast stop for each live sidecar before clearing — covers callers
        // that invoke stop_all while IM bots are still running (e.g. exposed
        // `cmd_stop_all_sidecars` Tauri command). The app-exit path normally
        // signals IM shutdown_rx first, but we don't rely on caller ordering.
        let session_ids: HashSet<String> = self
            .sidecars
            .keys()
            .chain(self.recovering_sidecars.keys())
            .cloned()
            .collect();
        let to_broadcast: Vec<(String, u64)> = session_ids
            .into_iter()
            .map(|sid| {
                (
                    sid.clone(),
                    self.sidecar_generations.get(&sid).copied().unwrap_or(0),
                )
            })
            .collect();
        for ev in &to_broadcast {
            let _ = self.stop_events.send(ev.clone());
            // stop_all is unconditionally terminal — exposed via
            // `cmd_stop_all_sidecars` (debug/admin) and the app-exit path.
            // Either way no auto-restart will fire, so the renderer's tab
            // bindings should be cleared. (App-exit usually beats the
            // renderer's listener teardown to nothing, but `cmd_stop_all`
            // mid-session is a real path and the listener is alive there.)
            let _ = self.terminal_events.send(ev.clone());
        }
        self.request_global_sidecar_stopped("stop-all");
        self.sidecars.clear(); // Session-centric Sidecars (Drop kills processes)
        self.recovering_sidecars.clear();
        self.instances.clear(); // Global Sidecar (Drop kills process)
        self.sidecar_generations.clear();
        // Remove port file so CLI knows the sidecar is down
        remove_global_port_file();
    }

    /// Verify that an already-ensured Tab owns the current Session generation
    /// and retire the temporary BackgroundCompletion handoff owner.
    pub fn reconcile_session_tab_activation(&mut self, session_id: &str, tab_id: &str) -> bool {
        let tab_owner = SidecarOwner::Tab(tab_id.to_string());
        let owned = self
            .sidecars
            .get(session_id)
            .is_some_and(|sidecar| sidecar.is_reusable() && sidecar.owners.contains(&tab_owner));
        if !owned {
            return false;
        }

        let background_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
        self.remove_session_owner(session_id, &background_owner);
        true
    }

    // ============= Session-Centric Sidecar API (v0.1.11) =============

    /// Get the port for a Session's Sidecar only after it is ready to serve requests.
    ///
    /// Renderer HTTP/SSE callers treat this port as directly usable. Returning a
    /// `Starting` sidecar here exposes a port before Node has finished binding
    /// and `/health/ready`, which can strand restored tabs in a failed load.
    pub fn get_session_port(&mut self, session_id: &str) -> Option<u16> {
        self.sidecars.get_mut(session_id).and_then(|s| {
            if s.is_ready_for_requests() {
                Some(s.port)
            } else {
                None
            }
        })
    }

    /// Resolve the current ready Sidecar process for a renderer-owned
    /// long-lived subscription. The Session hint gives an exact match during normal
    /// operation; the stable owner is the fallback after pending -> real key
    /// migration. Both reads stay inside the SidecarManager authority so SSE
    /// retry never caches or reconstructs a second owner -> port map.
    pub(crate) fn resolve_session_sidecar_for_frontend_owner(
        &mut self,
        session_id_hint: &str,
        owner: &SidecarOwner,
    ) -> Result<FrontendSidecarBinding, String> {
        let hinted_generation = self.generation_for(session_id_hint);
        if let Some(sidecar) = self.sidecars.get_mut(session_id_hint) {
            if !sidecar.owners.contains(owner) {
                return Err(format!(
                    "session hint {} is not owned by {:?}",
                    session_id_hint, owner
                ));
            }
            return if sidecar.is_ready_for_requests() {
                hinted_generation
                    .map(|generation| FrontendSidecarBinding {
                        management_id: sidecar.management_id.clone(),
                        port: sidecar.port,
                        generation,
                    })
                    .ok_or_else(|| format!("session hint {} has no generation", session_id_hint))
            } else {
                Err(format!(
                    "session hint {} sidecar is not ready",
                    session_id_hint
                ))
            };
        }

        if let Some(sidecar) = self.recovering_sidecars.get(session_id_hint) {
            if !sidecar.owners.contains(owner) {
                return Err(format!(
                    "recovering session hint {} is not owned by {:?}",
                    session_id_hint, owner
                ));
            }
            return Err(format!(
                "session hint {} sidecar is recovering",
                session_id_hint
            ));
        }

        let generations = &self.sidecar_generations;
        let mut matches: Vec<(String, Option<FrontendSidecarBinding>)> = Vec::new();
        for (session_id, sidecar) in &mut self.sidecars {
            if sidecar.owners.contains(owner) {
                let ready_process = if sidecar.is_ready_for_requests() {
                    generations
                        .get(session_id)
                        .copied()
                        .map(|generation| FrontendSidecarBinding {
                            management_id: sidecar.management_id.clone(),
                            port: sidecar.port,
                            generation,
                        })
                } else {
                    None
                };
                matches.push((session_id.clone(), ready_process));
            }
        }
        for (session_id, sidecar) in &self.recovering_sidecars {
            if sidecar.owners.contains(owner) {
                matches.push((session_id.clone(), None));
            }
        }

        match matches.as_slice() {
            [(_session_id, Some(binding))] => Ok(binding.clone()),
            [(session_id, None)] => Err(format!(
                "owner {:?} sidecar {} is not ready",
                owner, session_id
            )),
            [] => Err(format!(
                "no session sidecar found for hint {} and owner {:?}",
                session_id_hint, owner
            )),
            _ => {
                let mut session_ids = matches
                    .into_iter()
                    .map(|(session_id, _)| session_id)
                    .collect::<Vec<_>>();
                session_ids.sort();
                Err(format!(
                    "owner {:?} ambiguously matches sessions {}",
                    owner,
                    session_ids.join(",")
                ))
            }
        }
    }

    /// Consume one completion identity only while the exact renderer-selected
    /// process generation remains authoritative.
    pub(crate) fn claim_frontend_session_completion(
        &mut self,
        expected: &FrontendSidecarBinding,
        completion_session_id: &str,
        turn_id: &str,
    ) -> Option<SessionCompletionClaim> {
        let generations = &self.sidecar_generations;
        let (session_id, sidecar) = self.sidecars.iter_mut().find(|(session_id, sidecar)| {
            sidecar.management_id == expected.management_id
                && sidecar.port == expected.port
                && generations.get(*session_id).copied() == Some(expected.generation)
        })?;
        if session_id.as_str() != completion_session_id
            || !sidecar
                .completion_claims
                .insert((completion_session_id.to_string(), turn_id.to_string()))
        {
            return None;
        }
        Some(SessionCompletionClaim::new())
    }

    pub(crate) fn acquire_frontend_session_dispatch(
        &mut self,
        session_id_hint: &str,
        owner: &SidecarOwner,
    ) -> Result<SidecarHttpDispatch, String> {
        let binding = self.resolve_session_sidecar_for_frontend_owner(session_id_hint, owner)?;
        let generations = &self.sidecar_generations;
        let sidecar = self
            .sidecars
            .iter_mut()
            .find(|(session_id, sidecar)| {
                sidecar.management_id == binding.management_id
                    && sidecar.port == binding.port
                    && generations.get(*session_id).copied() == Some(binding.generation)
            })
            .map(|(_, sidecar)| sidecar)
            .ok_or_else(|| {
                "Resolved Session Sidecar generation is no longer current".to_string()
            })?;
        let lease = DispatchGate::try_acquire(&sidecar.dispatch_gate)
            .ok_or_else(|| "Resolved Session Sidecar generation is draining".to_string())?;
        Ok(SidecarHttpDispatch {
            base_url: binding.base_url(),
            _lease: lease,
        })
    }

    pub(crate) fn acquire_global_dispatch(&mut self) -> Result<SidecarHttpDispatch, String> {
        let generation = self.current_generation(GLOBAL_SIDECAR_ID);
        if generation == 0 {
            return Err("Global Sidecar has no current generation".to_string());
        }
        let instance = self
            .instances
            .get_mut(GLOBAL_SIDECAR_ID)
            .ok_or_else(|| "Global Sidecar is not running".to_string())?;
        if !instance.is_running() {
            return Err("Global Sidecar is not ready".to_string());
        }
        let lease = DispatchGate::try_acquire(&instance.dispatch_gate)
            .ok_or_else(|| "Global Sidecar generation is draining".to_string())?;
        Ok(SidecarHttpDispatch {
            base_url: format!("http://127.0.0.1:{}", instance.port),
            _lease: lease,
        })
    }

    fn claim_session_completion_if_current(
        &mut self,
        session_id: &str,
        port: u16,
        generation: u64,
        completion_session_id: &str,
        turn_id: &str,
    ) -> Option<SessionCompletionClaim> {
        if session_id != completion_session_id
            || self.generation_for(session_id) != Some(generation)
        {
            return None;
        }
        let sidecar = self.sidecars.get_mut(session_id)?;
        if sidecar.port != port
            || !sidecar
                .completion_claims
                .insert((completion_session_id.to_string(), turn_id.to_string()))
        {
            return None;
        }
        Some(SessionCompletionClaim::new())
    }

    #[cfg(test)]
    pub(crate) fn insert_test_ready_frontend_sidecar(
        &mut self,
        session_id: &str,
        port: u16,
        owner: SidecarOwner,
    ) {
        #[cfg(windows)]
        let mut process = {
            let mut command = crate::process_cmd::new("powershell");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            command
        };
        #[cfg(not(windows))]
        let mut process = {
            let mut command = crate::process_cmd::new("sleep");
            command.arg("60");
            command
        };
        process
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        let process =
            crate::process_cmd::spawn_tree(&mut process).expect("spawn test sidecar process tree");

        self.insert_sidecar(
            session_id,
            SessionSidecar {
                process,
                port,
                session_id: session_id.to_string(),
                management_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/sse-supervisor-test"),
                state: SidecarState::Healthy,
                owners: std::iter::once(owner).collect(),
                completion_claims: HashSet::new(),
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
                runtime: None,
                runtime_source: None,
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn set_test_sidecar_port(&mut self, session_id: &str, port: u16) {
        self.sidecars
            .get_mut(session_id)
            .expect("test sidecar")
            .port = port;
    }

    /// Check if a Session has an active Sidecar (Starting or Healthy)
    pub fn has_session_sidecar(&mut self, session_id: &str) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            !sidecar.is_dead()
        } else {
            false
        }
    }

    /// Get SessionSidecar reference by session ID
    /// Reserved for future use (e.g., debugging, introspection)
    #[allow(dead_code)]
    pub fn get_session_sidecar(&self, session_id: &str) -> Option<&SessionSidecar> {
        self.sidecars.get(session_id)
    }

    /// Get mutable SessionSidecar reference by session ID
    /// Reserved for future use (e.g., advanced owner management)
    #[allow(dead_code)]
    pub fn get_session_sidecar_mut(&mut self, session_id: &str) -> Option<&mut SessionSidecar> {
        self.sidecars.get_mut(session_id)
    }

    /// Get session IDs that have a BackgroundCompletion owner
    /// Used by Task Center to show [后台] tags on sessions
    pub fn get_background_session_ids(&self) -> Vec<String> {
        self.sidecars
            .keys()
            .chain(self.recovering_sidecars.keys())
            .filter(|sid| {
                self.session_owners(sid)
                    .any(|owner| matches!(owner, SidecarOwner::BackgroundCompletion(_)))
            })
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect()
    }

    /// Insert a sidecar and auto-increment its generation counter.
    /// This ensures every creation is tracked for lock-gap race detection.
    #[cfg(test)]
    pub(crate) fn insert_sidecar(&mut self, session_id: &str, sidecar: SessionSidecar) {
        self.next_generation(session_id);
        self.sidecars.insert(session_id.to_string(), sidecar);
    }

    /// Insert a Sidecar after its generation was reserved before spawn so the
    /// child process can carry the same identity in Management API requests.
    pub(super) fn insert_sidecar_at_generation(
        &mut self,
        session_id: &str,
        generation: u64,
        sidecar: SessionSidecar,
    ) {
        debug_assert_eq!(self.current_generation(session_id), generation);
        self.sidecars.insert(session_id.to_string(), sidecar);
    }

    /// Remove a sidecar. Does NOT clear the generation counter — it must remain
    /// queryable across lock gaps (e.g. during HTTP health check windows).
    /// Broadcasts `(session_id, generation)` on `stop_events` when the entry
    /// actually existed, so subscribers (IM event-consumer registry) can
    /// cancel resources tied to *this specific* sidecar instance — a stale
    /// event from a previous instance won't match a freshly-recreated one.
    pub(super) fn remove_sidecar(&mut self, session_id: &str) -> Option<SessionSidecar> {
        let gen = self.current_generation(session_id);
        let removed = self.sidecars.remove(session_id);
        if let Some(ref sidecar) = removed {
            let event_policy = sidecar_removal_event_policy(&sidecar.owners);
            let retained_recovery_has_owners = self
                .recovering_sidecars
                .get(session_id)
                .is_some_and(|recovery| !recovery.owners.is_empty());
            // send() returns Err only when there are no subscribers — fine, we
            // don't require anyone listening for sidecar removal to be valid.
            if event_policy.emit_stop {
                let _ = self.stop_events.send((session_id.to_string(), gen));
            }

            // Terminal = no owners remain across both the candidate and the
            // retained recovery authority. A candidate can have an empty local
            // set after its selected owner releases while another retained
            // owner still keeps the logical Session recoverable.
            // Crash-with-owners stays silent here: the bound Tab keeps its
            // sessionId, and the existing `session-sidecar:restarted` Tauri
            // event drives transparent reconnection in TabProvider.
            if event_policy.emit_terminal && !retained_recovery_has_owners {
                let _ = self.terminal_events.send((session_id.to_string(), gen));
            }
        }
        removed
    }

    /// Move a displaced process into manager-owned recovery state so every
    /// existing owner remains authoritative while its replacement starts.
    /// Owner releases update both active and recovering entries, so the final
    /// transfer cannot resurrect an owner that left during readiness waits.
    pub(super) fn begin_session_sidecar_replacement(&mut self, session_id: &str) {
        let dead_generation = self.current_generation(session_id);
        let Some(mut displaced) = self.remove_sidecar(session_id) else {
            return;
        };
        displaced.dispatch_gate.close_and_wait();
        if let Some(recovering) = self.recovering_sidecars.get_mut(session_id) {
            recovering
                .owners
                .extend(std::mem::take(&mut displaced.owners));
        } else {
            let epoch = self.next_recovery_epoch();
            ulog_info!(
                "[sidecar-recovery] action=begin session={} epoch={} dead_generation={} candidate_generation=none attempt=0 next_retry_ms=0",
                session_id,
                epoch,
                dead_generation
            );
            self.recovering_sidecars.insert(
                session_id.to_string(),
                RecoveringSessionSidecar {
                    sidecar: displaced,
                    epoch,
                    dead_generation,
                    candidate_generation: None,
                    failed_attempts: 0,
                    next_retry_at: std::time::Instant::now(),
                },
            );
        }
    }

    /// Atomically commit a ready candidate. If another independently ensured
    /// candidate already became authoritative, return that current process as
    /// the equivalent winner instead of reviving the caller's stale result.
    pub(super) fn commit_ready_session_sidecar(
        &mut self,
        session_id: &str,
    ) -> Option<ReadySidecarCommit> {
        let current_generation = self.current_generation(session_id);
        let replacement = self.sidecars.get(session_id)?;
        if !matches!(replacement.state, SidecarState::Healthy) {
            return None;
        }

        if let Some(recovery) = self.recovering_sidecars.get(session_id) {
            if recovery.candidate_generation != Some(current_generation) {
                return None;
            }
        }

        let retained = self.recovering_sidecars.remove(session_id);
        let replacement = self.sidecars.get_mut(session_id)?;
        if let Some(mut retained) = retained {
            replacement
                .owners
                .extend(std::mem::take(&mut retained.owners));
            ulog_info!(
                "[sidecar-recovery] action=commit session={} epoch={} dead_generation={} candidate_generation={} attempt={} port={}",
                session_id,
                retained.epoch,
                retained.dead_generation,
                current_generation,
                retained.failed_attempts.saturating_add(1),
                replacement.port
            );
        }
        Some(ReadySidecarCommit {
            port: replacement.port,
            generation: current_generation,
        })
    }

    /// Discover due recovery work from both active and already-recovering
    /// entries. The monitor owns no queue; skipping this method during update
    /// quiesce therefore pauses dispatch without dropping logical work.
    pub(super) fn due_session_recoveries(&mut self, now: std::time::Instant) -> Vec<String> {
        let newly_dead = self
            .sidecars
            .iter_mut()
            .filter_map(|(session_id, sidecar)| {
                (sidecar.is_dead() && !sidecar.owners.is_empty()).then(|| session_id.clone())
            })
            .collect::<Vec<_>>();
        for session_id in newly_dead {
            self.begin_session_sidecar_replacement(&session_id);
        }
        // `begin_session_sidecar_replacement` timestamps newly discovered work
        // during this scan, so compare against a post-discovery instant as well
        // as the caller's injected clock.
        let due_now = now.max(std::time::Instant::now());

        let mut session_ids = self
            .recovering_sidecars
            .iter()
            .filter_map(|(session_id, recovery)| {
                (!recovery.owners.is_empty() && recovery.next_retry_at <= due_now)
                    .then(|| session_id.clone())
            })
            .collect::<Vec<_>>();
        session_ids.sort();
        session_ids
    }

    pub(super) fn recovery_restart_identity(
        &self,
        session_id: &str,
        now: std::time::Instant,
    ) -> Option<RecoveryRestartIdentity> {
        let recovery = self.recovering_sidecars.get(session_id)?;
        if recovery.owners.is_empty() || recovery.next_retry_at > now {
            return None;
        }
        let owner = recovery.owners.iter().next()?.clone();
        Some(RecoveryRestartIdentity {
            epoch: recovery.epoch,
            dead_generation: recovery.dead_generation,
            attempt: recovery.failed_attempts.saturating_add(1),
            prior_candidate_generation: recovery.candidate_generation,
            owner,
            workspace_path: recovery.workspace_path.clone(),
            runtime: recovery.runtime.clone(),
            runtime_source: recovery.runtime_source.clone(),
        })
    }

    pub(super) fn has_session_recovery(&self, session_id: &str) -> bool {
        self.recovering_sidecars.contains_key(session_id)
    }

    pub(super) fn recovery_attempt_is_authorized(
        &self,
        session_id: &str,
        expected_epoch: u64,
        owner: &SidecarOwner,
    ) -> bool {
        if let Some(recovery) = self.recovering_sidecars.get(session_id) {
            return recovery.epoch == expected_epoch && recovery.owners.contains(owner);
        }

        // An independent ensure may already have committed the same logical
        // recovery. Reusing that winner is valid only when it retained the
        // exact owner selected by this dispatch.
        self.sidecars
            .get(session_id)
            .is_some_and(|sidecar| sidecar.owners.contains(owner))
    }

    /// Record an unsuccessful ensure against the recovery epoch that still
    /// owns the Session. Candidate generation is diagnostic identity only and
    /// is deliberately not used as the recovery work key.
    pub(super) fn record_session_recovery_failure(
        &mut self,
        session_id: &str,
        expected_epoch: Option<u64>,
        now: std::time::Instant,
    ) -> Option<RecoveryFailure> {
        let recovery = self.recovering_sidecars.get_mut(session_id)?;
        if expected_epoch.is_some_and(|epoch| epoch != recovery.epoch) {
            return None;
        }
        recovery.failed_attempts = recovery.failed_attempts.saturating_add(1);
        let retry_after = Self::recovery_retry_delay(recovery.failed_attempts);
        recovery.next_retry_at = now + retry_after;
        Some(RecoveryFailure {
            epoch: recovery.epoch,
            dead_generation: recovery.dead_generation,
            candidate_generation: recovery.candidate_generation,
            failed_attempts: recovery.failed_attempts,
            retry_after,
        })
    }

    /// Runtime drift helper for the IM router (v0.1.66).
    ///
    /// Looks up the Sidecar for `session_id` and checks whether its spawn-time
    /// MYAGENTS_RUNTIME differs from `desired_runtime`. On drift, the kill
    /// decision depends on which owners are currently attached:
    ///
    ///   - Only `Agent(_)` owners → safe to kill: the IM router is the sole
    ///     stakeholder and it will regenerate the peer session_id anyway.
    ///     Kill + remove + clear generation counter.
    ///
    ///   - Any non-Agent owner (`Tab`, `Task`, `Goal`, `BackgroundCompletion`) →
    ///     the Sidecar is shared with a desktop-style caller whose session
    ///     would be orphaned by a kill (SSE stream dies, frontend can't
    ///     recover without reload). Skip the kill, leave the Sidecar alone,
    ///     but still return DriftDetected so the caller (IM router) can
    ///     regenerate the peer session_id and fork cleanly. The old Sidecar
    ///     keeps running under the old session_id for the desktop owner;
    ///     the IM peer gets a fresh Sidecar under the new session_id.
    ///
    /// `desired_runtime` follows the same normalization as everywhere else:
    /// `"builtin"` | `"claude-code"` | `"codex"` | `"gemini"`. Internally
    /// Sidecars spawned as builtin have `runtime = None` (no env var
    /// injected); this method treats that as equivalent to `"builtin"` for
    /// comparison.
    pub fn kill_sidecar_if_runtime_differs(
        &mut self,
        session_id: &str,
        desired_runtime: &str,
    ) -> RuntimeDriftResult {
        self.kill_sidecar_if_runtime_identity_differs(session_id, desired_runtime, None)
    }

    pub fn kill_sidecar_if_runtime_identity_differs(
        &mut self,
        session_id: &str,
        desired_runtime: &str,
        desired_runtime_source: Option<&str>,
    ) -> RuntimeDriftResult {
        let decision = match self.sidecars.get(session_id) {
            Some(sidecar) => decide_runtime_identity_drift_result(
                sidecar.runtime.as_deref(),
                sidecar.runtime_source.as_deref(),
                desired_runtime,
                desired_runtime_source,
                &sidecar.owners,
            ),
            None => RuntimeDriftResult::NoDrift,
        };
        if decision == RuntimeDriftResult::NoDrift {
            return decision;
        }
        if decision == RuntimeDriftResult::DetectedKeptAlive {
            ulog_info!(
                "[sidecar] Runtime drift on session {} detected but kept alive \
                 — non-Agent owner (Tab/Cron/BackgroundCompletion) still attached. \
                 Caller should fork via a fresh session_id.",
                session_id
            );
            return decision;
        }
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            sidecar.dispatch_gate.close_and_wait();
            let _ = sidecar.process.kill();
        }
        // Go through remove_sidecar() so stop_events is broadcast — a runtime
        // drift kill is exactly the kind of stop that orphan IM consumers
        // would otherwise miss.
        self.remove_sidecar(session_id);
        // Clear the generation counter too — the old session_id is now orphaned
        // and the peer map will never reference it again, so there's no TOCTOU
        // concern that kept it alive in the normal remove_sidecar path.
        self.sidecar_generations.remove(session_id);
        decision
    }

    /// Clear the generation counter for a session.
    /// Call only when the session is permanently done (last owner released).
    pub(super) fn clear_generation(&mut self, session_id: &str) {
        self.sidecar_generations.remove(session_id);
    }

    /// Add an owner to a Session's Sidecar
    /// Returns true if owner was added, false if session doesn't exist
    pub fn add_session_owner(&mut self, session_id: &str, owner: SidecarOwner) -> bool {
        let mut found = false;
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Adding owner {:?} to session {} (port {})",
                owner,
                session_id,
                sidecar.port
            );
            sidecar.add_owner(owner.clone());
            found = true;
        }
        if let Some(sidecar) = self.recovering_sidecars.get_mut(session_id) {
            sidecar.add_owner(owner);
            found = true;
        }
        found
    }

    pub(super) fn reusable_session_binding(
        &mut self,
        session_id: &str,
    ) -> Option<BackgroundPollBinding> {
        let generation = self.generation_for(session_id)?;
        let sidecar = self.sidecars.get_mut(session_id)?;
        if sidecar.is_dead() || !sidecar.is_reusable() {
            return None;
        }
        Some(BackgroundPollBinding {
            port: sidecar.port,
            generation,
        })
    }

    /// Attach BackgroundCompletion only if the exact process observed before
    /// the lock-free activity probe is still authoritative.
    pub(super) fn attach_background_owner_if_current(
        &mut self,
        session_id: &str,
        owner: SidecarOwner,
        expected: BackgroundPollBinding,
    ) -> BackgroundOwnerAttach {
        if self.generation_for(session_id) != Some(expected.generation) {
            return BackgroundOwnerAttach::Stale;
        }
        let Some(sidecar) = self.sidecars.get_mut(session_id) else {
            return BackgroundOwnerAttach::Stale;
        };
        if sidecar.port != expected.port || sidecar.is_dead() || !sidecar.is_reusable() {
            return BackgroundOwnerAttach::Stale;
        }
        if sidecar.owners.contains(&owner) {
            return BackgroundOwnerAttach::AlreadyOwned;
        }

        sidecar.add_owner(owner.clone());
        if let Some(recovering) = self.recovering_sidecars.get_mut(session_id) {
            recovering.add_owner(owner);
        }
        BackgroundOwnerAttach::Attached(expected)
    }

    /// Attach a BackgroundCompletion owner to the logical Session after a
    /// lock-free activity probe raced with replacement. The manager lock is
    /// the authority boundary: attach to the current reusable process, or
    /// retain the owner on the in-flight recovery epoch until it commits.
    pub(super) fn attach_background_owner_to_logical_session(
        &mut self,
        session_id: &str,
        owner: SidecarOwner,
    ) -> Option<BackgroundOwnerAttach> {
        if self.session_has_exact_owner(session_id, &owner) {
            return Some(BackgroundOwnerAttach::AlreadyOwned);
        }

        if let Some(binding) = self.reusable_session_binding(session_id) {
            return Some(self.attach_background_owner_if_current(session_id, owner, binding));
        }

        // The activity probe can observe busy immediately before the current
        // process exits. Do not wait for the periodic health monitor to move
        // that dead entry into recovery: the Tab/Agent owner may be released
        // first. This manager lock is the logical Session authority, so make
        // the dead -> recovering transition here and retain Background work
        // on the same recovery epoch.
        if !self.recovering_sidecars.contains_key(session_id)
            && self
                .sidecars
                .get_mut(session_id)
                .is_some_and(SessionSidecar::is_dead)
        {
            self.begin_session_sidecar_replacement(session_id);
        }

        let recovering = self.recovering_sidecars.get_mut(session_id)?;
        recovering.add_owner(owner);
        Some(BackgroundOwnerAttach::Recovering)
    }

    /// Resolve a logical BackgroundCompletion owner to the current process.
    /// A retained owner with no committed active process is an explicit wait
    /// state, not a missing Session.
    pub(super) fn background_poll_target(
        &mut self,
        session_id: &str,
        owner: &SidecarOwner,
    ) -> BackgroundPollTarget {
        if self
            .recovering_sidecars
            .get(session_id)
            .is_some_and(|recovery| recovery.owners.contains(owner))
        {
            // Even if a candidate is present in `sidecars`, it is not the
            // Session authority until readiness commit transfers retained
            // owners and settles the recovery epoch.
            return BackgroundPollTarget::Recovering;
        }
        let generation = self.generation_for(session_id);
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            if sidecar.owners.contains(owner) {
                if sidecar.is_dead() {
                    return BackgroundPollTarget::Recovering;
                }
                if let Some(generation) = generation {
                    return BackgroundPollTarget::Current(BackgroundPollBinding {
                        port: sidecar.port,
                        generation,
                    });
                }
            }
        }
        BackgroundPollTarget::Gone
    }

    pub(super) fn background_binding_is_current(
        &mut self,
        session_id: &str,
        owner: &SidecarOwner,
        expected: BackgroundPollBinding,
    ) -> bool {
        if self.generation_for(session_id) != Some(expected.generation) {
            return false;
        }
        self.sidecars.get_mut(session_id).is_some_and(|sidecar| {
            sidecar.port == expected.port && sidecar.owners.contains(owner) && !sidecar.is_dead()
        })
    }

    /// Release only when the response-authorizing process is still current.
    /// This closes the response/replacement lock gap without holding the
    /// manager mutex across HTTP.
    pub(super) fn release_background_owner_if_current(
        &mut self,
        session_id: &str,
        owner: &SidecarOwner,
        expected: BackgroundPollBinding,
        completion_identity: Option<(&str, &str)>,
    ) -> BackgroundOwnerRelease {
        if !self.background_binding_is_current(session_id, owner, expected) {
            return if self.session_has_exact_owner(session_id, owner) {
                BackgroundOwnerRelease::Stale
            } else {
                BackgroundOwnerRelease::Gone
            };
        }
        let completion_claim = completion_identity.and_then(|(completion_session_id, turn_id)| {
            self.claim_session_completion_if_current(
                session_id,
                expected.port,
                expected.generation,
                completion_session_id,
                turn_id,
            )
        });
        let (_, sidecar_stopped) = self.remove_session_owner(session_id, owner);
        BackgroundOwnerRelease::Released {
            sidecar_stopped,
            completion_claim,
        }
    }

    /// Atomically attach an owner to an already-healthy Session Sidecar and
    /// return its port. Callers hold the Session lifecycle fence while using
    /// this to prevent deletion between lookup and owner attachment.
    pub fn attach_owner_to_healthy_session(
        &mut self,
        session_id: &str,
        owner: SidecarOwner,
    ) -> Option<u16> {
        let sidecar = self.sidecars.get_mut(session_id)?;
        if !matches!(sidecar.state, SidecarState::Healthy) {
            return None;
        }
        let port = sidecar.port;
        sidecar.add_owner(owner);
        Some(port)
    }

    /// Remove an owner from a Session's Sidecar
    /// If this was the last owner, the Sidecar and its session identity are
    /// removed together (the process is killed via Drop).
    /// Returns (was_removed, sidecar_was_stopped)
    pub fn remove_session_owner(&mut self, session_id: &str, owner: &SidecarOwner) -> (bool, bool) {
        let mut removed = false;
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Removing owner {:?} from session {} (port {})",
                owner,
                session_id,
                sidecar.port
            );
            removed |= sidecar.remove_owner(owner).0;
        }
        if let Some(sidecar) = self.recovering_sidecars.get_mut(session_id) {
            removed |= sidecar.remove_owner(owner).0;
        }

        if !removed {
            return (false, false);
        }

        if !self.session_has_owners(session_id) {
            ulog_info!(
                "[sidecar] Last owner removed from session {}, stopping Sidecar",
                session_id
            );
            self.remove_sidecar(session_id);
            if let Some(recovery) = self.recovering_sidecars.remove(session_id) {
                ulog_info!(
                    "[sidecar-recovery] action=cancel session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} reason=owners-zero",
                    session_id,
                    recovery.epoch,
                    recovery.dead_generation,
                    recovery.candidate_generation,
                    recovery.failed_attempts.saturating_add(1)
                );
            }
            self.clear_generation(session_id);
            (true, true)
        } else {
            (true, false)
        }
    }

    pub fn release_tab_session(
        &mut self,
        session_id: &str,
        tab_id: &str,
        _has_persisted_scheduler_owner: bool,
    ) -> bool {
        let (owner_removed, sidecar_stopped) =
            self.remove_session_owner(session_id, &SidecarOwner::Tab(tab_id.to_string()));
        owner_removed && sidecar_stopped
    }

    /// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
    /// This updates the manager-owned Session identity without stopping the
    /// Sidecar.
    ///
    /// Returns true if the upgrade was successful.
    pub fn upgrade_session_id(&mut self, old_session_id: &str, new_session_id: &str) -> bool {
        ulog_info!(
            "[sidecar] Upgrading session ID: {} -> {}",
            old_session_id,
            new_session_id
        );

        if old_session_id == new_session_id {
            return self.sidecars.contains_key(new_session_id)
                || self.recovering_sidecars.contains_key(new_session_id);
        }

        let old_exists = self.sidecars.contains_key(old_session_id)
            || self.recovering_sidecars.contains_key(old_session_id);
        let new_exists = self.sidecars.contains_key(new_session_id)
            || self.recovering_sidecars.contains_key(new_session_id);
        match (old_exists, new_exists) {
            (false, true) => {
                ulog_debug!(
                    "[sidecar] Session ID upgrade already applied: {} -> {}",
                    old_session_id,
                    new_session_id
                );
                return true;
            }
            (true, true) => {
                ulog_error!(
                    "[sidecar] Refusing session ID upgrade because both identities exist: {} -> {}",
                    old_session_id,
                    new_session_id
                );
                return false;
            }
            (false, false) => return false,
            (true, false) => {}
        }

        let mut upgraded = false;

        // 1. Upgrade the mutable logical Session binding in sidecars HashMap.
        // `management_id` remains the immutable process-birth identity sent in
        // MYAGENTS_SIDECAR_ID, so management requests from this live process
        // remain valid across the rekey.
        // NOTE: Direct HashMap access (not insert_sidecar/remove_sidecar) because this is
        // a key rename, not a creation. Generation is migrated separately in step 2.
        if let Some(mut sidecar) = self.sidecars.remove(old_session_id) {
            // Update the session_id field in the sidecar itself
            sidecar.session_id = new_session_id.to_string();
            self.sidecars.insert(new_session_id.to_string(), sidecar);
            ulog_info!(
                "[sidecar] Upgraded sidecars HashMap: {} -> {}",
                old_session_id,
                new_session_id
            );
            upgraded = true;
        }

        // 2. Migrate generation counter
        if let Some(gen) = self.sidecar_generations.remove(old_session_id) {
            self.sidecar_generations
                .insert(new_session_id.to_string(), gen);
        }

        // Note: deliberately NOT broadcasting a stop event for
        // (old_session_id, generation) here, even though the manager's key
        // has rotated. An earlier iteration did broadcast and Codex r4
        // caught the race: Message B may have already reused the OLD
        // ImConsumerHandle and registered an in-flight ReplySlot before the
        // upgrade (Message A's terminal triggered it); cancelling the old
        // entry mid-flight strands B's slot in a router whose consumer was
        // just terminated.
        //
        // The correctness invariant is upheld instead via
        // `ensure_im_consumer`'s reuse-path `is_live` check: the next message
        // (post-upgrade) sees `is_live(old_sid, gen) == false`, falls through
        // to cancel + respawn against new_session_id. In-flight slots on the
        // old entry continue draining naturally — the underlying sidecar
        // process is alive, SSE keeps flowing, terminal events still reach
        // the old router. After all slots terminate, the next ensure_im_consumer
        // call replaces the entry. No leak, no premature cancellation.

        // 3. Rekey retained recovery authority when this lower-level helper is
        // used outside the renderer's stricter healthy-source adoption path.
        if let Some(mut recovering) = self.recovering_sidecars.remove(old_session_id) {
            recovering.session_id = new_session_id.to_string();
            self.recovering_sidecars
                .insert(new_session_id.to_string(), recovering);
            ulog_info!(
                "[sidecar] Upgraded recovering sidecar identity: {} -> {}",
                old_session_id,
                new_session_id
            );
            upgraded = true;
        }

        if !upgraded {
            ulog_debug!(
                "[sidecar] No entries found for session {} to upgrade",
                old_session_id
            );
        }

        upgraded
    }

    /// Renderer adoption is idempotent only when the exact Tab owns the source
    /// identity or the already-migrated target identity.
    pub fn upgrade_session_id_for_tab(
        &mut self,
        old_session_id: &str,
        new_session_id: &str,
        tab_id: &str,
    ) -> bool {
        let owner = SidecarOwner::Tab(tab_id.to_string());
        let old_recovering = self.recovering_sidecars.contains_key(old_session_id);
        let old_exists = self.sidecars.contains_key(old_session_id) || old_recovering;
        let new_exists = self.sidecars.contains_key(new_session_id)
            || self.recovering_sidecars.contains_key(new_session_id);

        if old_session_id == new_session_id {
            return new_exists && self.session_has_exact_owner(new_session_id, &owner);
        }
        if !old_exists && new_exists {
            return self.session_has_exact_owner(new_session_id, &owner);
        }
        if old_recovering {
            return false;
        }
        if !old_exists || !self.session_has_exact_owner(old_session_id, &owner) {
            return false;
        }
        self.upgrade_session_id(old_session_id, new_session_id)
    }

    pub fn session_id_upgrade_is_already_applied_for_tab(
        &self,
        old_session_id: &str,
        new_session_id: &str,
        tab_id: &str,
    ) -> bool {
        let old_exists = self.sidecars.contains_key(old_session_id)
            || self.recovering_sidecars.contains_key(old_session_id);
        let new_exists = self.sidecars.contains_key(new_session_id)
            || self.recovering_sidecars.contains_key(new_session_id);
        !old_exists
            && new_exists
            && self.session_has_exact_owner(new_session_id, &SidecarOwner::Tab(tab_id.to_string()))
    }

    /// Check if a session's Sidecar has an owner whose work remains bound to
    /// this session identity after a desktop Tab detaches.
    pub fn session_has_persistent_owners(&self, session_id: &str) -> bool {
        self.session_owners(session_id).any(|owner| {
            matches!(
                owner,
                SidecarOwner::Companion(_)
                    | SidecarOwner::Task(_)
                    | SidecarOwner::Goal(_)
                    | SidecarOwner::BackgroundCompletion(_)
                    | SidecarOwner::Agent(_)
            )
        })
    }

    /// Snapshot the Session identities protected by non-Tab Sidecar owners.
    /// Renderer deletion affordances use this as a projection only; the
    /// in-lock `session_has_owners` check remains the mutation authority.
    pub fn persistent_owner_session_ids(&self) -> Vec<String> {
        let mut session_ids = self
            .sidecars
            .keys()
            .chain(self.recovering_sidecars.keys())
            .filter(|session_id| self.session_has_persistent_owners(session_id))
            .cloned()
            .collect::<Vec<_>>();
        session_ids.sort();
        session_ids.dedup();
        session_ids
    }

    /// Check if a session's Sidecar currently has a frontend surface owner.
    ///
    /// IM uses this as a runtime-only config hold signal: while a desktop Tab or
    /// floating companion is attached, subsequent IM turns must keep using the
    /// live Sidecar config instead of following Agent defaults changed elsewhere.
    pub fn session_has_frontend_owner(&self, session_id: &str) -> bool {
        self.session_owners(session_id)
            .any(|owner| matches!(owner, SidecarOwner::Tab(_) | SidecarOwner::Companion(_)))
    }

    /// Ownership is independent of process liveness: a dead Sidecar entry with
    /// owners is restartable and still protects the session transcript.
    pub fn session_has_owners(&self, session_id: &str) -> bool {
        self.session_owners(session_id).next().is_some()
    }

    /// Whether deletion is blocked by any owner other than the exact mounted
    /// Tabs that App has authorized this transaction to release.
    pub fn session_has_unreleasable_owners(
        &self,
        session_id: &str,
        releasable_tab_ids: &std::collections::HashSet<String>,
    ) -> bool {
        self.session_owners(session_id).any(|owner| match owner {
            SidecarOwner::Tab(tab_id) => !releasable_tab_ids.contains(tab_id),
            _ => true,
        })
    }

    fn session_owners<'a>(&'a self, session_id: &'a str) -> impl Iterator<Item = &'a SidecarOwner> {
        self.sidecars
            .get(session_id)
            .into_iter()
            .flat_map(|sidecar| sidecar.owners.iter())
            .chain(
                self.recovering_sidecars
                    .get(session_id)
                    .into_iter()
                    .flat_map(|sidecar| sidecar.owners.iter()),
            )
    }

    pub(super) fn session_has_exact_owner(&self, session_id: &str, owner: &SidecarOwner) -> bool {
        self.session_owners(session_id)
            .any(|candidate| candidate == owner)
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure all processes are killed when manager is dropped
impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Thread-safe managed state wrapper
pub type ManagedSidecarManager = Arc<Mutex<SidecarManager>>;

/// Create a new managed sidecar manager
pub fn create_sidecar_manager() -> ManagedSidecarManager {
    Arc::new(Mutex::new(SidecarManager::new()))
}

// ============= Legacy compatibility types =============
// These are kept for backward compatibility during migration
//
// TODO(PRD 0.1.0): Remove legacy API after confirming all frontend code
// uses the new multi-instance API (startTabSidecar, stopTabSidecar, etc.)
//
// Legacy functions to remove:
// - start_sidecar, stop_sidecar, get_sidecar_status
// - restart_sidecar, ensure_sidecar_running, check_process_alive
// - cmd_start_sidecar, cmd_stop_sidecar, cmd_get_sidecar_status
// - cmd_get_server_url, cmd_restart_sidecar, cmd_ensure_sidecar_running
// - cmd_check_sidecar_alive

/// Legacy sidecar status (still used by existing commands)
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub agent_dir: String,
}

/// Legacy managed sidecar type alias
pub type ManagedSidecar = ManagedSidecarManager;

/// Legacy function: create_sidecar_state -> create_sidecar_manager
pub fn create_sidecar_state() -> ManagedSidecar {
    create_sidecar_manager()
}

#[cfg(test)]
mod completion_claim_tests {
    use super::*;

    #[test]
    fn frontend_and_background_paths_consume_one_generation_claim() {
        let mut manager = SidecarManager::new();
        let frontend_owner = SidecarOwner::Tab("tab-a".to_string());
        let background_owner = SidecarOwner::BackgroundCompletion("session-a".to_string());
        manager.insert_test_ready_frontend_sidecar("session-a", 32001, frontend_owner.clone());
        assert!(manager.add_session_owner("session-a", background_owner.clone()));

        let frontend_binding = manager
            .resolve_session_sidecar_for_frontend_owner("session-a", &frontend_owner)
            .expect("frontend binding");
        let background_binding = manager
            .reusable_session_binding("session-a")
            .expect("background binding");

        assert!(manager
            .claim_frontend_session_completion(&frontend_binding, "session-a", "turn-1")
            .is_some());
        assert_eq!(
            manager.release_background_owner_if_current(
                "session-a",
                &background_owner,
                background_binding,
                Some(("session-a", "turn-1")),
            ),
            BackgroundOwnerRelease::Released {
                sidecar_stopped: false,
                completion_claim: None,
            }
        );
        assert_eq!(
            manager
                .sidecars
                .get("session-a")
                .expect("live generation")
                .completion_claims,
            HashSet::from([("session-a".to_string(), "turn-1".to_string())])
        );
    }

    #[test]
    fn replacement_rejects_a_late_old_generation_claim() {
        let mut manager = SidecarManager::new();
        let owner = SidecarOwner::Tab("tab-a".to_string());
        manager.insert_test_ready_frontend_sidecar("session-a", 32001, owner.clone());
        let old_binding = manager
            .resolve_session_sidecar_for_frontend_owner("session-a", &owner)
            .expect("old binding");
        assert!(manager
            .claim_frontend_session_completion(&old_binding, "session-a", "turn-1")
            .is_some());

        manager.begin_session_sidecar_replacement("session-a");
        assert_eq!(
            manager
                .recovering_sidecars
                .get("session-a")
                .expect("retained old generation")
                .completion_claims
                .len(),
            1
        );
        manager.insert_test_ready_frontend_sidecar("session-a", 32002, owner.clone());
        manager
            .commit_ready_session_sidecar("session-a")
            .expect("replacement commit");

        assert!(manager
            .claim_frontend_session_completion(&old_binding, "session-a", "late-old-turn")
            .is_none());
        let new_binding = manager
            .resolve_session_sidecar_for_frontend_owner("session-a", &owner)
            .expect("new binding");
        assert!(manager
            .claim_frontend_session_completion(&new_binding, "session-a", "turn-1")
            .is_some());
    }

    #[test]
    fn pending_to_real_rekey_preserves_the_same_process_claim_authority() {
        let mut manager = SidecarManager::new();
        let owner = SidecarOwner::Tab("tab-a".to_string());
        manager.insert_test_ready_frontend_sidecar("pending-tab-a", 32001, owner.clone());
        let binding = manager
            .resolve_session_sidecar_for_frontend_owner("pending-tab-a", &owner)
            .expect("pending binding");

        assert!(manager.upgrade_session_id("pending-tab-a", "session-real"));
        assert!(manager
            .claim_frontend_session_completion(&binding, "pending-tab-a", "turn-1")
            .is_none());
        assert!(manager
            .claim_frontend_session_completion(&binding, "session-real", "turn-1")
            .is_some());
    }

    #[test]
    fn reclaimed_generations_leave_no_manager_owned_claims() {
        let mut manager = SidecarManager::new();
        let owner = SidecarOwner::Tab("tab-a".to_string());

        for index in 0..12 {
            let port = 32000 + index;
            manager.insert_test_ready_frontend_sidecar("session-a", port, owner.clone());
            let binding = manager
                .resolve_session_sidecar_for_frontend_owner("session-a", &owner)
                .expect("current binding");
            assert!(manager
                .claim_frontend_session_completion(&binding, "session-a", &format!("turn-{index}"),)
                .is_some());
            assert_eq!(
                manager
                    .sidecars
                    .values()
                    .map(|sidecar| sidecar.completion_claims.len())
                    .sum::<usize>(),
                1
            );

            drop(manager.remove_sidecar("session-a"));
            manager.clear_generation("session-a");
            assert!(manager.sidecars.is_empty());
            assert!(manager.recovering_sidecars.is_empty());
        }
    }
}

/// Legacy SidecarConfig with required agent_dir
#[derive(Debug, Clone)]
pub struct LegacySidecarConfig {
    #[allow(dead_code)]
    pub port: u16,
    pub agent_dir: PathBuf,
    #[allow(dead_code)]
    pub initial_prompt: Option<String>,
}
