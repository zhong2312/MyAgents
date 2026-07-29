use super::*;

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
    pub(super) recovering_sidecars: HashMap<String, SessionSidecar>,

    // ===== Legacy Storage (kept for backward compatibility) =====
    /// Tab ID -> Sidecar Instance (legacy, used for Global Sidecar)
    pub(super) instances: HashMap<String, SidecarInstance>,
    /// Session ID -> Session Activation (tracks which session is active for Session singleton)
    pub(super) session_activations: HashMap<String, SessionActivation>,
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
            session_activations: HashMap::new(),
            port_counter: AtomicU16::new(BASE_PORT),
            sidecar_generations: HashMap::new(),
            // Start at 1 so callers using `0` as an "unknown / not present"
            // placeholder (see IM `sidecar_generation_initial.unwrap_or(0)`)
            // never collide with a real allocated generation.
            instance_counter: AtomicU64::new(1),
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
        (self.sidecars.contains_key(sidecar_id) || self.instances.contains_key(sidecar_id))
            && self.sidecar_generations.get(sidecar_id).copied() == Some(generation)
    }

    /// Allocate the next instance ID and stash it as this session's current
    /// generation. The ID comes from the process-global atomic counter, so
    /// it is unique for the whole process lifetime — repeated sidecars under
    /// the same session_id (e.g. IM idle release + rebuild) get distinct
    /// generations, which is what makes IM event-consumer reuse race-free.
    pub(super) fn next_generation(&mut self, session_id: &str) -> u64 {
        let id = self.instance_counter.fetch_add(1, Ordering::SeqCst);
        self.sidecar_generations.insert(session_id.to_string(), id);
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
        self.sidecars.clear(); // Session-centric Sidecars (Drop kills processes)
        self.recovering_sidecars.clear();
        self.instances.clear(); // Global Sidecar (Drop kills process)
        self.session_activations.clear();
        self.sidecar_generations.clear();
        // Remove port file so CLI knows the sidecar is down
        remove_global_port_file();
    }

    // ============= Session Activation Methods =============

    /// Get session activation by session ID
    pub fn get_session_activation(&self, session_id: &str) -> Option<&SessionActivation> {
        self.session_activations.get(session_id)
    }

    /// (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness across
    /// `session_activations`: at most one activation may have a given
    /// `tab_id == Some(T)` at any time. Called from `activate_session`
    /// and `update_session_tab` BEFORE writing the new tab_id.
    ///
    /// Why: `get_tab_server_url`'s priority-2 fallback iterates
    /// `session_activations.values().find(|a| a.tab_id == Some(tab_id))`
    /// and returns the first match. HashMap iteration order is non-
    /// deterministic, so two activations with the same tab_id mean a
    /// stop / queue-force / any other tab-keyed lookup may resolve to
    /// the wrong session's port → wrong Sidecar gets the request →
    /// wrong session aborted. Issue #169 reported 4 such cross-tab
    /// stop incidents in one day.
    ///
    /// The window where two activations briefly share a tab_id opens
    /// during tab→session switches: the renderer sequence is
    /// `update_session_tab(new_session, T)` → ... → `deactivate_session
    /// (old_session)`. Between those two awaits, both `new_session` and
    /// `old_session` carry `tab_id == Some(T)`. By proactively clearing
    /// the old binding here, we close that window unconditionally —
    /// regardless of whether the renderer remembers to call
    /// `deactivate_session` afterwards.
    ///
    /// Skips the entry whose key matches `keeper_session_id` (the
    /// caller's own session_id) so we don't clobber the write we're
    /// about to make.
    pub(super) fn clear_tab_id_from_other_activations(
        &mut self,
        keeper_session_id: &str,
        tab_id: &str,
    ) {
        let stale_session_ids: Vec<String> = self
            .session_activations
            .iter()
            .filter(|(sid, a)| {
                sid.as_str() != keeper_session_id && a.tab_id.as_deref() == Some(tab_id)
            })
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in stale_session_ids {
            if let Some(activation) = self.session_activations.get_mut(&sid) {
                ulog_info!(
                    "[sidecar] Clearing stale tab_id {:?} from session {} (now claimed by session {})",
                    tab_id, sid, keeper_session_id
                );
                activation.tab_id = None;
            }
        }
    }

    /// Activate a session (associate it with a Sidecar)
    pub fn activate_session(
        &mut self,
        session_id: String,
        tab_id: Option<String>,
        task_id: Option<String>,
        port: u16,
        workspace_path: String,
        is_cron_task: bool,
    ) {
        ulog_info!(
            "[sidecar] Activating session {} on port {}, tab: {:?}, task: {:?}, cron: {}",
            session_id,
            port,
            tab_id,
            task_id,
            is_cron_task
        );
        // (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness BEFORE
        // inserting the new activation, so the new entry's tab_id is the
        // only match for `find(|a| a.tab_id == Some(tab_id))`.
        if let Some(ref tid) = tab_id {
            self.clear_tab_id_from_other_activations(&session_id, tid);
        }
        self.session_activations.insert(
            session_id.clone(),
            SessionActivation {
                session_id,
                tab_id,
                task_id,
                port,
                workspace_path,
                is_cron_task,
            },
        );
    }

    /// Deactivate a session
    pub fn deactivate_session(&mut self, session_id: &str) -> Option<SessionActivation> {
        ulog_info!("[sidecar] Deactivating session {}", session_id);
        self.session_activations.remove(session_id)
    }

    /// Update session activation's tab_id (e.g., when a Tab connects to headless Sidecar)
    pub fn update_session_tab(&mut self, session_id: &str, tab_id: Option<String>) {
        // (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness BEFORE
        // mutating the target entry, so by the time the read below
        // finalizes, no other activation carries the same tab_id.
        // (Skipped when clearing — `tab_id == None` can't collide.)
        if let Some(ref tid) = tab_id {
            self.clear_tab_id_from_other_activations(session_id, tid);
        }
        if let Some(activation) = self.session_activations.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Updating session {} tab: {:?} -> {:?}",
                session_id,
                activation.tab_id,
                tab_id
            );
            activation.tab_id = tab_id;
            // If a tab connects, it's no longer a pure cron task session
            if activation.tab_id.is_some() {
                activation.is_cron_task = false;
            }
        }
    }

    /// Get all active sessions for a workspace
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn get_workspace_sessions(&self, workspace_path: &str) -> Vec<&SessionActivation> {
        self.session_activations
            .values()
            .filter(|a| a.workspace_path == workspace_path)
            .collect()
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

    /// Resolve the current ready Sidecar URL for a renderer-owned long-lived
    /// subscription. The Session hint gives an exact match during normal
    /// operation; the stable owner is the fallback after pending -> real key
    /// migration. Both reads stay inside the SidecarManager authority so SSE
    /// retry never caches or reconstructs a second owner -> port map.
    pub fn resolve_session_sidecar_url_for_frontend_owner(
        &mut self,
        session_id_hint: &str,
        owner: &SidecarOwner,
    ) -> Result<String, String> {
        if let Some(sidecar) = self.sidecars.get_mut(session_id_hint) {
            if !sidecar.owners.contains(owner) {
                return Err(format!(
                    "session hint {} is not owned by {:?}",
                    session_id_hint, owner
                ));
            }
            return if sidecar.is_ready_for_requests() {
                Ok(format!("http://127.0.0.1:{}", sidecar.port))
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

        let mut matches: Vec<(String, Option<u16>)> = Vec::new();
        for (session_id, sidecar) in &mut self.sidecars {
            if sidecar.owners.contains(owner) {
                let ready_port = sidecar.is_ready_for_requests().then_some(sidecar.port);
                matches.push((session_id.clone(), ready_port));
            }
        }
        for (session_id, sidecar) in &self.recovering_sidecars {
            if sidecar.owners.contains(owner) {
                matches.push((session_id.clone(), None));
            }
        }

        match matches.as_slice() {
            [(_session_id, Some(port))] => Ok(format!("http://127.0.0.1:{}", port)),
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

        self.insert_sidecar(
            session_id,
            SessionSidecar {
                process: process.spawn().expect("spawn test sidecar process"),
                port,
                session_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/sse-supervisor-test"),
                state: SidecarState::Healthy,
                owners: std::iter::once(owner).collect(),
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
            // send() returns Err only when there are no subscribers — fine, we
            // don't require anyone listening for sidecar removal to be valid.
            if event_policy.emit_stop {
                let _ = self.stop_events.send((session_id.to_string(), gen));
            }

            // Terminal = no owners remained. Health monitor only auto-restarts
            // when `is_dead() && !owners.is_empty()` (see `monitor_session_sidecars`
            // line 2356), so empty-owners ⇒ no restart attempt ⇒ any frontend
            // Tab binding to this session is now dangling and must be cleared.
            // Crash-with-owners stays silent here: the bound Tab keeps its
            // sessionId, and the existing `session-sidecar:restarted` Tauri
            // event drives transparent reconnection in TabProvider.
            if event_policy.emit_terminal {
                let _ = self.terminal_events.send((session_id.to_string(), gen));
            }
        }
        removed
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
            self.recovering_sidecars.remove(session_id);
            self.deactivate_session(session_id);
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
        has_persisted_scheduler_owner: bool,
    ) -> bool {
        let (owner_removed, sidecar_stopped) =
            self.remove_session_owner(session_id, &SidecarOwner::Tab(tab_id.to_string()));
        if !owner_removed {
            return false;
        }

        if self.session_has_persistent_owners(session_id) || has_persisted_scheduler_owner {
            self.update_session_tab(session_id, None);
        } else if !sidecar_stopped {
            self.deactivate_session(session_id);
        }
        sidecar_stopped
    }

    /// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
    /// This updates the key in both sidecars and session_activations HashMaps
    /// without stopping the Sidecar.
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
                || self.session_activations.contains_key(new_session_id);
        }

        let old_exists = self.sidecars.contains_key(old_session_id)
            || self.session_activations.contains_key(old_session_id);
        let new_exists = self.sidecars.contains_key(new_session_id)
            || self.session_activations.contains_key(new_session_id);
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

        // 1. Upgrade in sidecars HashMap
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

        // 3. Upgrade in session_activations HashMap
        if let Some(mut activation) = self.session_activations.remove(old_session_id) {
            // Update the session_id field in the activation itself
            activation.session_id = new_session_id.to_string();
            self.session_activations
                .insert(new_session_id.to_string(), activation);
            ulog_info!(
                "[sidecar] Upgraded session_activations HashMap: {} -> {}",
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
mod session_identity_upgrade_tests {
    use super::*;

    #[test]
    fn session_identity_upgrade_is_idempotent_and_conflict_safe() {
        let mut manager = SidecarManager::new();
        manager.activate_session(
            "pending-1".to_string(),
            Some("tab-1".to_string()),
            Some("goal-1".to_string()),
            31001,
            "/tmp/workspace".to_string(),
            true,
        );

        assert!(manager.upgrade_session_id("pending-1", "session-real"));
        assert!(manager.upgrade_session_id("pending-1", "session-real"));
        assert!(manager.session_activations.contains_key("session-real"));
        assert!(!manager.session_activations.contains_key("pending-1"));

        manager.activate_session(
            "pending-1".to_string(),
            Some("tab-2".to_string()),
            Some("goal-2".to_string()),
            31002,
            "/tmp/workspace".to_string(),
            true,
        );
        assert!(!manager.upgrade_session_id("pending-1", "session-real"));
        assert!(manager.session_activations.contains_key("session-real"));
        assert!(manager.session_activations.contains_key("pending-1"));
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
