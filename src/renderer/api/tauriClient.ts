// Tauri IPC client for communicating with the Rust backend
// Handles sidecar lifecycle and provides server URL for HTTP communication

import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '@/utils/browserMock';

/** Sidecar status returned from Rust backend */
export interface SidecarStatus {
    running: boolean;
    port: number;
    agent_dir: string;
}

/** Check if we're running in Tauri environment */
export function isTauri(): boolean {
    return isTauriEnvironment();
}

/** Cache for server URL to avoid repeated IPC calls */
let cachedServerUrl: string | null = null;

/**
 * Start the sidecar for a project
 * @param agentDir - The directory for the agent workspace
 * @param initialPrompt - Optional initial prompt to start with
 * @returns Sidecar status with port and agent directory
 */
export async function startSidecar(
    agentDir: string,
    initialPrompt?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch API to change directory
        console.debug('[tauriClient] Browser mode: calling /agent/switch API');
        try {
            const response = await fetch('/agent/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentDir, initialPrompt }),
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to switch agent directory');
            }
            console.debug('[tauriClient] Switched to:', result.agentDir);
            return {
                running: true,
                port: 3000,
                agent_dir: result.agentDir,
            };
        } catch (error) {
            console.error('[tauriClient] Failed to switch agent:', error);
            // Fallback to mock on error
            return {
                running: true,
                port: 3000,
                agent_dir: agentDir,
            };
        }
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_sidecar', {
            agentDir,
            initialPrompt: initialPrompt ?? null,
        });

        // Update cached URL
        cachedServerUrl = `http://127.0.0.1:${status.port}`;

        return status;
    } catch (error) {
        console.error('Failed to start sidecar:', error);
        throw error;
    }
}

/**
 * Stop the running sidecar
 */
export async function stopSidecar(): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_sidecar');
        cachedServerUrl = null;
    } catch (error) {
        console.error('Failed to stop sidecar:', error);
        throw error;
    }
}

/**
 * Get the current sidecar status
 * @returns Sidecar status or null if not in Tauri
 */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_sidecar_status');
    } catch (error) {
        console.error('Failed to get sidecar status:', error);
        return null;
    }
}

/**
 * Get the backend server URL
 * Uses cached value if available, otherwise queries from Tauri
 * Returns empty string in browser mode so requests use relative paths (Vite proxy)
 * 
 * IMPORTANT: This does NOT cache failed URLs - each call will retry if sidecar is not running
 */
export async function getServerUrl(): Promise<string> {
    // Browser mode: return empty string so API calls use relative paths
    // This allows Vite's proxy to forward requests to localhost:3000
    if (!isTauri()) {
        console.debug('[tauriClient] Browser mode: using relative URLs (Vite proxy)');
        return '';
    }

    // Return cached URL if available
    if (cachedServerUrl) {
        return cachedServerUrl;
    }

    try {
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch (error) {
        // Don't cache failed URL - let next call retry
        console.warn('[tauriClient] Sidecar not running:', error);
        throw new Error('Sidecar is not running');
    }
}

/**
 * Get server URL, auto-restarting sidecar if needed
 * This is the preferred method for resilient connections
 */
export async function getServerUrlWithAutoRestart(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    try {
        // First, try to get the URL normally
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch {
        // Sidecar not running, try to ensure it's running
        console.debug('[tauriClient] Sidecar not running, attempting auto-restart...');
        try {
            const status = await invoke<SidecarStatus>('cmd_ensure_sidecar_running');
            if (status.running) {
                const url = `http://127.0.0.1:${status.port}`;
                cachedServerUrl = url;
                console.debug('[tauriClient] Sidecar auto-restarted:', url);
                return url;
            }
        } catch (restartError) {
            console.error('[tauriClient] Auto-restart failed:', restartError);
        }
        throw new Error('Sidecar is not running and could not be restarted');
    }
}

/**
 * Restart the sidecar process
 */
export async function restartSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_restart_sidecar');
}

/**
 * Ensure sidecar is running, restart if needed
 */
export async function ensureSidecarRunning(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_ensure_sidecar_running');
}

/**
 * Check if sidecar process is still alive (real-time check)
 */
export async function checkSidecarAlive(): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        return await invoke<boolean>('cmd_check_sidecar_alive');
    } catch {
        return false;
    }
}

/**
 * Build a full API URL for the given endpoint
 * @param endpoint - The API endpoint (e.g., '/chat/send')
 */
export async function getApiUrl(endpoint: string): Promise<string> {
    const baseUrl = await getServerUrl();
    return `${baseUrl}${endpoint}`;
}

/**
 * Reset the cached server URL (useful when stopping/restarting sidecar)
 */
export function resetServerUrlCache(): void {
    cachedServerUrl = null;
}

/** HTTP response from Rust proxy */
interface ProxyHttpResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
    /** True if body is base64 encoded (for binary responses like images) */
    is_base64: boolean;
    // Pattern 2 §2.3.4: when the upstream body exceeded ~1 MiB the Rust proxy
    // streamed it to a sidecar-side ref file instead of returning bytes
    // through IPC. The renderer fetches the body from `ref_url` (a
    // `/refs/<id>` URL on the same sidecar) and re-emits a Response.
    ref_url?: string;
    ref_mimetype?: string;
    ref_size_bytes?: number;
}

// ── Pattern 6 (Renderer correlation headers) — FIXED resolver model ──
// TabProvider used to overwrite a single `activeTabId` on mount, so the
// last-mounted tab won regardless of where the user actually was. With N
// concurrent tabs, requests fired from tab A would carry tab B's id in
// `X-MyAgents-Tab-Id` whenever B mounted later — breaking PRD §6.4
// "any error log can be filtered by tabId".
//
// New model: App.tsx owns the active tab across every surface, and
// TabProvider supplies mounted Chat tab/session context as a fallback.
// `proxyFetch` calls `resolveCorrelation()`, which prefers App's active tab,
// then focused/mounted Chat context as a last resort. Multiple TabProviders
// coexist without clobbering Launcher/Settings/TaskCenter correlation.
const mountedTabs = new Map<string, { sessionId?: string }>();
const appTabs = new Map<string, { sessionId?: string }>();
let focusedTabId: string | undefined;
let activeAppTabId: string | undefined;
let lastMountedTabId: string | undefined;

interface CorrelationContext { tabId?: string; sessionId?: string }

function isKnownCorrelationTab(tabId: string | undefined): boolean {
    return !!tabId && (mountedTabs.has(tabId) || appTabs.has(tabId));
}

function resolveFallbackCorrelationTabId(): string | undefined {
    if (activeAppTabId && appTabs.has(activeAppTabId)) return activeAppTabId;
    if (lastMountedTabId && mountedTabs.has(lastMountedTabId)) return lastMountedTabId;
    return (appTabs.keys().next().value as string | undefined)
        ?? (mountedTabs.keys().next().value as string | undefined);
}

/**
 * App.tsx owns the actual active tab across Launcher / Settings / TaskCenter /
 * Chat. TabProvider only exists for Chat tabs, so it cannot be the sole source
 * for renderer correlation.
 */
export function setAppActiveCorrelation(opts: {
    tabId?: string | null;
    sessionId?: string | null;
    tabs?: readonly { id: string; sessionId?: string | null }[];
}): void {
    appTabs.clear();
    for (const tab of opts.tabs ?? []) {
        appTabs.set(tab.id, { sessionId: tab.sessionId ?? undefined });
    }
    activeAppTabId = opts.tabId ?? undefined;
    if (activeAppTabId) {
        const existing = appTabs.get(activeAppTabId) ?? {};
        appTabs.set(activeAppTabId, {
            sessionId: opts.sessionId ?? existing.sessionId,
        });
        focusedTabId = activeAppTabId;
    } else if (!isKnownCorrelationTab(focusedTabId)) {
        focusedTabId = undefined;
    }
}

/**
 * TabProvider calls this on mount with `mounted: true` and on unmount with
 * `mounted: false`. The first mounted tab also claims focus until a focus
 * event explicitly moves it.
 */
export function setActiveCorrelation(opts: { tabId?: string; sessionId?: string; mounted?: boolean }): void {
    const mounted = opts.mounted !== false; // default: mounted=true (legacy callers without `mounted` field expect mount semantics)
    if (!opts.tabId) {
        // Legacy callsite passed only sessionId — apply to whichever tab is
        // currently focused. (Existing behaviour preserved.)
        if (focusedTabId && opts.sessionId !== undefined) {
            const slot = mountedTabs.get(focusedTabId) ?? {};
            slot.sessionId = opts.sessionId;
            mountedTabs.set(focusedTabId, slot);
        }
        return;
    }

    if (mounted) {
        const slot = mountedTabs.get(opts.tabId) ?? {};
        if (opts.sessionId !== undefined) slot.sessionId = opts.sessionId;
        mountedTabs.set(opts.tabId, slot);
        lastMountedTabId = opts.tabId;
        if (!isKnownCorrelationTab(focusedTabId)) {
            focusedTabId = opts.tabId;
        }
    } else {
        mountedTabs.delete(opts.tabId);
        if (focusedTabId === opts.tabId) {
            focusedTabId = resolveFallbackCorrelationTabId();
        }
        if (lastMountedTabId === opts.tabId) {
            lastMountedTabId = mountedTabs.keys().next().value as string | undefined;
        }
    }
}

/** Mark `tabId` as currently focused (TabProvider focus event). */
export function setFocusedCorrelationTabId(tabId: string | undefined): void {
    if (tabId === undefined) return; // don't clobber on blur — keep the last-focused
    focusedTabId = tabId;
    if (!mountedTabs.has(tabId)) {
        mountedTabs.set(tabId, {});
        lastMountedTabId = tabId;
    }
}

function resolveCorrelation(): CorrelationContext {
    let tabId: string | undefined;
    if (activeAppTabId && appTabs.has(activeAppTabId)) tabId = activeAppTabId;
    else if (isKnownCorrelationTab(focusedTabId)) tabId = focusedTabId;
    else tabId = resolveFallbackCorrelationTabId();

    const sessionId = tabId ? (mountedTabs.get(tabId)?.sessionId ?? appTabs.get(tabId)?.sessionId) : undefined;
    return { tabId, sessionId };
}

export function getActiveTabId(): string | undefined {
    return resolveCorrelation().tabId;
}

/**
 * Proxy HTTP request through Rust to bypass WebView CORS
 * Falls back to native fetch in browser mode
 *
 * `options.signal` (AbortSignal) is honoured both at the front edge (already
 * aborted → throw immediately, never invoke Rust) and at the catch site
 * (aborted between request and failure → throw AbortError silently, no
 * "Sidecar gone" log noise). The underlying Tauri `invoke` cannot itself
 * be interrupted, but post-hoc filtering still lets callers — typically
 * useEffect cleanup paths fired by tab close — hide the expected
 * lifecycle warning that would otherwise spam the unified log.
 */
export async function proxyFetch(
    url: string,
    options?: RequestInit
): Promise<Response> {
    const signal = options?.signal;
    // Pre-check: caller already aborted (e.g., useEffect cleanup ran before
    // we got the chance to invoke). Throw AbortError without touching Rust.
    if (signal?.aborted) {
        throw new DOMException('proxyFetch aborted before dispatch', 'AbortError');
    }

    // Browser mode: use native fetch (Vite proxy handles CORS)
    if (!isTauri()) {
        return fetch(url, options);
    }

    // GUARD: In Tauri mode, URLs MUST be absolute (http://127.0.0.1:PORT/...).
    // Relative URLs (e.g., "/api/something") happen when the sidecar port could not
    // be resolved (race condition: sidecar died between URL construction and send).
    // Without this guard, reqwest fails with "relative URL without a base" which
    // cascades into SSE disconnect → Global Sidecar restart → full UI re-render. (#78)
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        const truncated = url.length > 100 ? url.slice(0, 100) + '...' : url;
        const error = new Error(
            `[proxyFetch] Blocked relative URL: "${truncated}". ` +
            'Sidecar port may not be resolved yet. This request will be dropped to prevent cascading failures.'
        );
        console.warn(error.message);
        throw error;
    }

    const method = options?.method || 'GET';
    const body = options?.body ? String(options.body) : undefined;

    // Extract headers
    const headers: Record<string, string> = {};
    if (options?.headers) {
        if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
                headers[key] = value;
            });
        } else {
            Object.assign(headers, options.headers);
        }
    }

    // Pattern 6: stamp correlation headers (renderer → sidecar). Don't
    // overwrite explicit ones the caller already set. Resolver prefers
    // App-active tab > focused Chat tab > mounted fallback.
    const correlation = resolveCorrelation();
    if (correlation.tabId && !headers['X-MyAgents-Tab-Id'] && !headers['x-myagents-tab-id']) {
        headers['X-MyAgents-Tab-Id'] = correlation.tabId;
    }
    if (correlation.sessionId && !headers['X-MyAgents-Session-Id'] && !headers['x-myagents-session-id']) {
        headers['X-MyAgents-Session-Id'] = correlation.sessionId;
    }

    try {
        const result = await invoke<ProxyHttpResponse>('proxy_http_request', {
            request: {
                url,
                method,
                body,
                headers: Object.keys(headers).length > 0 ? headers : null,
            }
        });

        // Pattern 2 §2.3.4 / §E — Large body via sidecar ref. Rust streamed
        // the upstream straight to disk; we fetch it back via plain HTTP
        // (Tauri's `connect-src` allows 127.0.0.1 already; the sidecar's
        // /refs/:id route is keep-alive and streams from disk). This path
        // skips the atob-byte-loop completely — the browser's native Response
        // does the binary decode on its own thread.
        //
        // CRITICAL: this is a NATIVE WebKit fetch, not Tauri IPC. That means
        // the sidecar's `/refs/:id` response MUST include
        // `Access-Control-Allow-Origin: *` — without it, WKWebView treats the
        // response as opaque cross-origin and rejects with the notoriously
        // diagnostic-free `TypeError: Load failed`, which previously broke
        // every >1MB workspace load (issue #109). Verified at
        // src/server/index.ts (the `/refs/:id` handler).
        if (result.ref_url) {
            const refResp = await fetch(result.ref_url);
            // Re-stamp headers from the original upstream so callers that
            // sniff content-type / etag continue to work, but the freshly
            // fetched response carries Content-Length itself.
            const headers = new Headers(refResp.headers);
            for (const [k, v] of Object.entries(result.headers)) {
                if (!headers.has(k)) headers.set(k, v);
            }
            return new Response(refResp.body, {
                status: result.status,
                headers,
            });
        }

        // Handle base64 encoded binary responses (small bodies only — the
        // Rust proxy now streams >1 MiB into refs above).
        if (result.is_base64) {
            // Single-line base64 → bytes; faster than the manual byte loop.
            const bytes = Uint8Array.from(atob(result.body), c => c.charCodeAt(0));
            return new Response(bytes, {
                status: result.status,
                headers: result.headers,
            });
        }

        // Create a Response-like object for text responses
        return new Response(result.body, {
            status: result.status,
            headers: result.headers,
        });
    } catch (error) {
        // If the caller aborted while the invoke was in flight, the Tauri
        // task may still complete server-side, but the renderer-side
        // promise should resolve as AbortError without polluting the log.
        // This is the common tab-close case: Cmd+W triggered useEffect
        // cleanup → controller.abort() → request was already on the wire
        // hitting a sidecar port that just died. The Rust side already
        // logs that at WARN ("[proxy] Request failed ..."); duplicating it
        // here as a renderer "Sidecar gone" line is pure noise.
        if (signal?.aborted) {
            throw new DOMException('proxyFetch aborted', 'AbortError');
        }

        // Classify lifecycle vs genuine fault — mirrors the Rust side
        // (sse_proxy.rs `proxy_http_request`), which already downgrades
        // localhost connect/send-class errors from ERROR to WARN. Without
        // this symmetric classification on the renderer side, every Tab
        // close / Sidecar replace produces a "REACT ERROR" line in the
        // unified log even though the matching Rust line is WARN, undoing
        // the noise reduction. The substring match leans on reqwest's
        // stable error format ("error sending request for url ..."),
        // which is what surfaces here via Tauri invoke's error
        // serialization.
        const msg = error instanceof Error ? error.message : String(error);
        const isLifecycleClass =
            msg.includes('error sending request') ||
            msg.includes('Connection refused') ||
            msg.includes('Connection reset') ||
            msg.includes('SendRequest');
        if (isLifecycleClass) {
            console.warn('[proxyFetch] (lifecycle) Sidecar gone:', msg);
        } else {
            console.error('[proxyFetch] Error:', error);
        }
        throw error;
    }
}

/**
 * POST JSON through Rust proxy
 */
export async function proxyPostJson<T>(endpoint: string, data: unknown): Promise<T> {
    const baseUrl = await getServerUrl();
    const url = `${baseUrl}${endpoint}`;

    const response = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

/**
 * POST JSON with automatic sidecar restart on failure
 * This is the resilient version that handles sidecar crashes
 * 
 * @param endpoint - API endpoint
 * @param data - Request payload
 * @param maxRetries - Maximum retry attempts (default: 1)
 */
export async function proxyPostJsonWithRetry<T>(
    endpoint: string,
    data: unknown,
    maxRetries: number = 1
): Promise<T> {
    // Browser mode: use normal fetch without retry logic
    if (!isTauri()) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Use auto-restart URL getter for resilience
            const baseUrl = await getServerUrlWithAutoRestart();
            const url = `${baseUrl}${endpoint}`;

            const response = await proxyFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            return await response.json();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[tauriClient] Request failed (attempt ${attempt + 1}/${maxRetries + 1}):`, lastError.message);

            if (attempt < maxRetries) {
                // Clear cache and try to restart sidecar before next attempt
                resetServerUrlCache();
                console.debug('[tauriClient] Attempting sidecar restart before retry...');
                try {
                    await ensureSidecarRunning();
                    // Wait a bit for sidecar to be fully ready
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (restartError) {
                    console.error('[tauriClient] Sidecar restart failed:', restartError);
                }
            }
        }
    }

    throw lastError || new Error('Request failed after retries');
}

// ============= Multi-instance Sidecar API =============
// These functions support per-Tab Sidecar instances

/** Cache for per-Tab server URLs */
const tabServerUrls = new Map<string, string>();

/**
 * De-duplication map for in-flight `getTabServerUrl` polls.
 *
 * `getTabServerUrl` is the single point where Tab-scoped HTTP / SSE clients
 * discover which port their Sidecar lives on. During the Sidecar boot
 * window (≈650ms cold start, up to a few seconds with MCP pre-warm), the
 * Rust `cmd_get_tab_server_url` command returns an error because the
 * `ManagedSidecar` map doesn't have an entry for this tab yet.
 *
 * Consumers of that boot window — `apiGet`, `apiPost`, `SseConnection`,
 * `DirectoryPanel.refresh`, `loadAgents`, `/api/model/set`, etc. —
 * can fire *concurrently* the moment a tab mounts. Without dedup, each
 * consumer would start its own poll (same IPC question, multiplied N-fold).
 *
 * This map keys the pending promise by tabId so concurrent callers share
 * a single poll; on resolve/reject the entry is removed and the port is
 * cached in `tabServerUrls` for all subsequent lookups to hit instantly.
 */
const tabServerUrlPending = new Map<string, Promise<string>>();

/**
 * Wait-for-Sidecar-ready backoff schedule (milliseconds between attempts).
 *
 * Chosen so the total budget (~33s) covers Rust `ensure_session_sidecar`'s
 * `/health/ready` timeout (30s). `getSessionPort(sessionId)` intentionally
 * hides `Starting` ports, so early Tab-scoped callers must be able to wait for
 * the same readiness window instead of failing before Rust's ensure completes.
 *
 * Shape front-loads short delays so the common case (boot finishes in
 * 200–800ms) resolves within 1–2 attempts; later attempts stretch out so
 * we don't hammer the IPC layer if the Sidecar is taking longer to come up.
 */
const TAB_SERVER_URL_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1500, 2000, 3000, 5000, 5000, 5000, 5000, 5000];

/**
 * Start a Sidecar for a specific Tab
 * @param tabId - Unique Tab identifier
 * @param agentDir - Optional agent directory (null for global sidecar)
 */
export async function startTabSidecar(
    tabId: string,
    agentDir?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch for compatibility
        if (agentDir) {
            try {
                const response = await fetch('/agent/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentDir }),
                });
                const result = await response.json();
                if (result.success) {
                    tabServerUrls.set(tabId, '');
                    return { running: true, port: 3000, agent_dir: result.agentDir };
                }
            } catch (error) {
                console.error('[tauriClient] Browser mode switch failed:', error);
            }
        }
        tabServerUrls.set(tabId, '');
        return { running: true, port: 3000, agent_dir: agentDir || '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_tab_sidecar', {
            tabId,
            agentDir: agentDir ?? null,
        });
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set(tabId, url);
        console.debug(`[tauriClient] Tab ${tabId} sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error(`[tauriClient] Failed to start sidecar for tab ${tabId}:`, error);
        throw error;
    }
}

/**
 * Stop a Sidecar for a specific Tab
 * @param tabId - Tab identifier
 */
export async function stopTabSidecar(tabId: string): Promise<void> {
    tabServerUrls.delete(tabId);
    // Don't leak in-flight readiness polls past a tab teardown. The poll
    // itself can't be aborted (IPC is already in flight) but clearing the
    // dedup entry lets the next call for this tabId start fresh rather
    // than latch onto the old tab's promise.
    tabServerUrlPending.delete(tabId);

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_tab_sidecar', { tabId });
        console.debug(`[tauriClient] Tab ${tabId} sidecar stopped`);
    } catch (error) {
        console.error(`[tauriClient] Failed to stop sidecar for tab ${tabId}:`, error);
        // Don't throw - cleanup should be best-effort
    }
}

/**
 * Stop SSE proxy for a specific Tab
 * Should be called BEFORE stopping the Sidecar to avoid EOF errors
 * @param tabId - Tab identifier
 */
export async function stopSseProxy(tabId: string): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('stop_sse_proxy', { connectionKey: tabId });
        console.debug(`[tauriClient] Tab ${tabId} SSE proxy stopped`);
    } catch (error) {
        console.error(`[tauriClient] Failed to stop SSE proxy for tab ${tabId}:`, error);
        // Don't throw - cleanup should be best-effort
    }
}

/**
 * Get server URL for a specific Tab, waiting for the Sidecar to become ready.
 *
 * This is the central "where does my Sidecar live?" primitive — every
 * Tab-scoped HTTP call (`apiGet`, `apiPost`) and SSE connection routes
 * through here. Making readiness waiting the DEFAULT behaviour means
 * every consumer is automatically correct during the boot window without
 * needing to remember retry logic, cascade hooks, or gate effects on
 * `isConnected`. This is the "pit of success" for Tab-scoped calls:
 * the only way to get a server URL is to wait until the Sidecar is
 * actually serving it.
 *
 * Behaviour:
 *   • Cache hit → returns immediately (hot path, no IPC).
 *   • Cache miss, Sidecar up → one IPC round-trip, then cached.
 *   • Cache miss, Sidecar still booting → polls with backoff until the
 *     Rust `cmd_get_tab_server_url` resolves or the ~33s budget is
 *     exhausted. Concurrent callers for the same tab share one poll
 *     via `tabServerUrlPending` (no IPC amplification).
 *   • Budget exhausted → throws `"No running sidecar for tab <id>: <cause>"`
 *     (including the underlying Rust IPC error) so genuine failures (Sidecar
 *     crashed, never spawned, IPC bridge broken) surface with debuggable
 *     context. The budget is deliberately longer than any normal boot so
 *     this error really does mean "something is wrong", not "you were early".
 *
 * Why polling here, not in Rust?
 *   The four pit-of-success modules in the codebase (`local_http`, `process_cmd`,
 *   `proxy_config`, `system_binary`) all live in Rust. This one sits in
 *   TypeScript because making Rust block would require rewriting the
 *   `ManagedSidecarManager` lock model (sync `Mutex` → async with `tokio::Notify`
 *   to avoid blocking the runtime). The JS poll gives us the same caller-facing
 *   guarantee (invoke+await, no consumer-level retry) with zero Rust churn.
 *   A future Rust-side wait primitive (event-driven, zero polling) is the
 *   ideal end state — tracked as follow-up.
 *
 * Asymmetry note: `getGlobalServerUrl` / `getGlobalServerUrlWithWait` use a
 * separate event-driven mechanism (`globalSidecarReadyPromise`). The Global
 * Sidecar boots at App mount and races are rare there, but unifying the
 * three readiness styles (cache, polling, event) is tracked as follow-up.
 *
 * @param tabId - Tab identifier
 */
export async function getTabServerUrl(tabId: string): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    const cached = tabServerUrls.get(tabId);
    if (cached !== undefined) {
        return cached;
    }

    // Dedup concurrent callers — share one poll per tabId. Without this,
    // a tab-mount burst (apiGet + apiPost + SSE connect + DirectoryPanel
    // refresh + loadAgents + ...) would fan out into N parallel IPC
    // poll loops all asking the same question.
    const inflight = tabServerUrlPending.get(tabId);
    if (inflight !== undefined) {
        return inflight;
    }

    // Holder pattern so the closure can self-reference for the
    // "still-authoritative" guard. If `stopTabSidecar` / `resetTabServerUrlCache`
    // fires mid-poll, it clears `tabServerUrlPending[tabId]`; when our poll
    // eventually resolves, we must NOT (a) write a stale URL into the cache,
    // nor (b) delete a fresh successor poll's pending entry.
    const ref: { poll?: Promise<string> } = {};
    ref.poll = (async (): Promise<string> => {
        let lastError: unknown;
        // One initial attempt + retries per the backoff schedule.
        for (let attempt = 0; attempt <= TAB_SERVER_URL_RETRY_DELAYS_MS.length; attempt++) {
            if (attempt > 0 && tabServerUrlPending.get(tabId) !== ref.poll) {
                throw new Error(`No running sidecar for tab ${tabId}: lookup cancelled`);
            }
            try {
                const url = await invoke<string>('cmd_get_tab_server_url', { tabId });
                // Commit only if we are still the authoritative poll. A stop /
                // reset during the IPC means the tab either died (url now dead
                // port) or restarted on a new port (url possibly OK but a new
                // poll should decide, not us).
                if (tabServerUrlPending.get(tabId) !== ref.poll) {
                    throw new Error(`No running sidecar for tab ${tabId}: lookup cancelled`);
                }
                tabServerUrls.set(tabId, url);
                if (attempt > 0) {
                    console.debug(`[tauriClient] Sidecar for tab ${tabId} ready after ${attempt} retry(ies)`);
                }
                return url;
            } catch (error) {
                lastError = error;
                if (tabServerUrlPending.get(tabId) !== ref.poll) {
                    throw new Error(`No running sidecar for tab ${tabId}: lookup cancelled`);
                }
                const delay = TAB_SERVER_URL_RETRY_DELAYS_MS[attempt];
                if (delay === undefined) break;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        const cause = lastError instanceof Error ? lastError.message : String(lastError);
        console.warn(
            `[tauriClient] No sidecar for tab ${tabId} after ${TAB_SERVER_URL_RETRY_DELAYS_MS.length + 1} attempts:`,
            lastError,
        );
        throw new Error(`No running sidecar for tab ${tabId}: ${cause}`);
    })();

    tabServerUrlPending.set(tabId, ref.poll);
    try {
        return await ref.poll;
    } finally {
        // Conditional cleanup — mirror of the authoritative-write guard above.
        // A stop/reset between pending-set and finally would have installed a
        // replacement poll; blindly deleting here would wipe it.
        if (tabServerUrlPending.get(tabId) === ref.poll) {
            tabServerUrlPending.delete(tabId);
        }
    }
}

/**
 * Get sidecar status for a specific Tab
 * @param tabId - Tab identifier
 */
export async function getTabSidecarStatus(tabId: string): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_tab_sidecar_status', { tabId });
    } catch (error) {
        console.error(`[tauriClient] Failed to get status for tab ${tabId}:`, error);
        return null;
    }
}

/**
 * Start the global Sidecar (used by Settings page)
 */
export async function startGlobalSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_global_sidecar');
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set('__global__', url);
        console.debug(`[tauriClient] Global sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error('[tauriClient] Failed to start global sidecar:', error);
        throw error;
    }
}

/** Promise that resolves when global sidecar is ready */
let globalSidecarReadyPromise: Promise<void> | null = null;
let globalSidecarReadyResolve: (() => void) | null = null;

const GLOBAL_SERVER_URL_RETRY_DELAYS_MS: readonly number[] = [
    50, 100, 200, 400, 800, 1500, 2000, 3000, 5000, 5000, 5000, 5000, 5000,
];

function describeInvokeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function readGlobalServerUrlFromRust(): Promise<string | null> {
    try {
        const url = await invoke<string>('cmd_get_global_server_url');
        tabServerUrls.set('__global__', url);
        return url;
    } catch {
        return null;
    }
}

/**
 * Initialize the global sidecar ready promise
 * Called from App.tsx before starting the sidecar
 */
export function initGlobalSidecarReadyPromise(): void {
    if (!globalSidecarReadyPromise) {
        globalSidecarReadyPromise = new Promise<void>((resolve) => {
            globalSidecarReadyResolve = resolve;
        });
    }
}

/**
 * Mark global sidecar as ready
 * Called from App.tsx after sidecar starts successfully
 */
export function markGlobalSidecarReady(): void {
    if (globalSidecarReadyResolve) {
        globalSidecarReadyResolve();
        globalSidecarReadyResolve = null;
    }
}

/**
 * Wait for global sidecar to be ready (with timeout)
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 60000)
 * Note: Timeout is set higher to accommodate macOS permission dialogs
 * that may appear on first launch and require user interaction
 */
export async function waitForGlobalSidecar(timeoutMs: number = 60000): Promise<void> {
    if (!isTauri()) {
        return;
    }

    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) return;

    // The ready promise is only a same-webview hint. Floating ball windows are
    // separate WebViews, so Rust's sidecar registry is the cross-window source
    // of truth. Probe it first, then keep polling it until the timeout.
    const immediate = await readGlobalServerUrlFromRust();
    if (immediate) return;

    if (!globalSidecarReadyPromise) {
        initGlobalSidecarReadyPromise();
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 1;
    let delayIndex = 0;

    console.info(`[tauriClient] Waiting for global sidecar readiness (timeout=${timeoutMs}ms)`);
    while (Date.now() < deadline) {
        const delay = GLOBAL_SERVER_URL_RETRY_DELAYS_MS[
            Math.min(delayIndex, GLOBAL_SERVER_URL_RETRY_DELAYS_MS.length - 1)
        ];
        delayIndex++;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const delayPromise = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now())));
        });
        await delayPromise;
        if (timer) clearTimeout(timer);

        attempts++;
        const url = await readGlobalServerUrlFromRust();
        if (url) {
            console.info(
                `[tauriClient] Global sidecar ready after ${Date.now() - startedAt}ms (attempts=${attempts})`,
            );
            return;
        }
    }

    let lastError = 'not running';
    try {
        await invoke<string>('cmd_get_global_server_url');
    } catch (error) {
        lastError = describeInvokeError(error);
    }
    throw new Error(
        `Global sidecar startup timeout after ${timeoutMs}ms (attempts=${attempts}, last=${lastError})`,
    );
}

/**
 * Get global sidecar server URL (for Settings page)
 */
export async function getGlobalServerUrl(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    try {
        const url = await invoke<string>('cmd_get_global_server_url');
        tabServerUrls.set('__global__', url);
        return url;
    } catch (error) {
        console.warn('[tauriClient] Global sidecar not running:', error);
        throw new Error('Global sidecar is not running');
    }
}

/**
 * Get global sidecar server URL, waiting for it to be ready if needed
 * This is the preferred method for components that need the global sidecar
 */
export async function getGlobalServerUrlWithWait(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    // First check cache
    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    const immediate = await readGlobalServerUrlFromRust();
    if (immediate) return immediate;

    // Wait for sidecar to be ready
    await waitForGlobalSidecar();

    // Now get the URL
    return getGlobalServerUrl();
}

/**
 * Stop all Sidecar instances (for app exit)
 */
export async function stopAllSidecars(): Promise<void> {
    tabServerUrls.clear();
    // F4: mirror the clear on pending polls so app-exit doesn't leave an
    // orphan poll that could repopulate `tabServerUrls` after the supposed
    // global stop. In-flight IPC can't be cancelled, but pending-map
    // clearance guarantees any poll that completes post-clear is non-auth
    // (via the guard in getTabServerUrl) and won't commit to cache.
    tabServerUrlPending.clear();

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_all_sidecars');
        console.debug('[tauriClient] All sidecars stopped');
    } catch (error) {
        console.error('[tauriClient] Failed to stop all sidecars:', error);
    }
}

/**
 * Reset Tab server URL cache for a specific Tab
 */
export function resetTabServerUrlCache(tabId: string): void {
    tabServerUrls.delete(tabId);
    tabServerUrlPending.delete(tabId);
}

/**
 * Update Global Sidecar server URL cache
 * Called when the Rust health monitor auto-restarts the Global Sidecar on a new port
 */
export function updateGlobalServerUrl(url: string): void {
    tabServerUrls.set('__global__', url);
}

/** Drop a stale Global Sidecar URL after a transport-level failure. */
export function resetGlobalServerUrlCache(): void {
    tabServerUrls.delete('__global__');
}

// ============= Session Activation API =============
// These functions support Session singleton constraint

/** Session activation information */
export interface SessionActivation {
    session_id: string;
    tab_id: string | null;
    task_id: string | null;  // If activated by cron task, contains the task ID
    port: number;
    workspace_path: string;
    is_cron_task: boolean;
}

/** Sidecar info for a workspace */
export interface SidecarInfo {
    port: number;
    workspace_path: string;
    is_healthy: boolean;
}

/**
 * Get activation status for a session
 * @param sessionId - Session identifier
 * @returns SessionActivation if session is activated, null if not
 */
export async function getSessionActivation(sessionId: string): Promise<SessionActivation | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SessionActivation | null>('cmd_get_session_activation', { sessionId });
    } catch (error) {
        console.error(`[tauriClient] Failed to get session activation for ${sessionId}:`, error);
        return null;
    }
}

/**
 * Activate a session (mark it as in-use by a Tab/Sidecar)
 * @param sessionId - Session identifier
 * @param tabId - Tab that owns this session (null for cron tasks)
 * @param port - Sidecar port
 * @param workspacePath - Workspace directory path
 * @param isCronTask - Whether this is a cron task activation
 */
export async function activateSession(
    sessionId: string,
    tabId: string | null,
    taskId: string | null,
    port: number,
    workspacePath: string,
    isCronTask: boolean = false
): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_activate_session', {
            sessionId,
            tabId: tabId ?? null,
            taskId: taskId ?? null,
            port,
            workspacePath,
            isCronTask,
        });
        console.debug(`[tauriClient] Session ${sessionId} activated by tab ${tabId || 'cron'}, task: ${taskId || 'none'}`);
    } catch (error) {
        console.error(`[tauriClient] Failed to activate session ${sessionId}:`, error);
        throw error;
    }
}

/**
 * Deactivate a session (mark it as no longer in-use)
 * @param sessionId - Session identifier
 */
export async function deactivateSession(sessionId: string): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_deactivate_session', { sessionId });
        console.debug(`[tauriClient] Session ${sessionId} deactivated`);
    } catch (error) {
        console.error(`[tauriClient] Failed to deactivate session ${sessionId}:`, error);
        // Don't throw - deactivation should be best-effort
    }
}

/**
 * Update a session's owning Tab (for Tab switching within same Sidecar)
 * @param sessionId - Session identifier
 * @param newTabId - New Tab identifier
 */
export async function updateSessionTab(sessionId: string, newTabId: string | null | undefined): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_update_session_tab', { sessionId, newTabId: newTabId ?? null });
        console.debug(`[tauriClient] Session ${sessionId} transferred to tab ${newTabId ?? 'none'}`);
    } catch (error) {
        console.error(`[tauriClient] Failed to update session tab for ${sessionId}:`, error);
        throw error;
    }
}


// ============= Session-Centric Sidecar API (v0.1.11) =============
// These functions support the new Owner model where Sidecar lifecycle
// is tied to Sessions, not Tabs.

/** Result from ensureSessionSidecar */
export interface EnsureSidecarResult {
    port: number;
    isNew: boolean;
}

/**
 * Ensure a Session has a Sidecar running, adding the specified owner.
 * If the Session already has a healthy Sidecar, just adds the owner.
 * If no Sidecar exists, creates a new one with the owner.
 *
 * @param sessionId - Session identifier
 * @param workspacePath - Workspace directory path
 * @param ownerType - Renderer surface owner type
 * @param ownerId - Stable surface ID
 * @returns {port, isNew} where isNew is true if a new Sidecar was started
 */
export async function ensureSessionSidecar(
    sessionId: string,
    workspacePath: string,
    ownerType: 'tab' | 'companion',
    ownerId: string
): Promise<EnsureSidecarResult> {
    if (!isTauri()) {
        return { port: 3000, isNew: false };
    }

    try {
        const result = await invoke<EnsureSidecarResult>('cmd_ensure_session_sidecar', {
            sessionId,
            workspacePath,
            ownerType,
            ownerId,
        });
        console.debug(`[tauriClient] ensureSessionSidecar: session=${sessionId}, owner=${ownerType}:${ownerId}, port=${result.port}, isNew=${result.isNew}`);
        return result;
    } catch (error) {
        console.error(`[tauriClient] Failed to ensure session sidecar for ${sessionId}:`, error);
        throw error;
    }
}

/**
 * Release an owner from a Session's Sidecar.
 * If this was the last owner, the Sidecar is stopped.
 *
 * @param sessionId - Session identifier
 * @param ownerType - Renderer surface owner type
 * @param ownerId - Stable surface ID
 * @returns true if the Sidecar was stopped (no more owners)
 */
export async function releaseSessionSidecar(
    sessionId: string,
    ownerType: 'tab' | 'companion',
    ownerId: string
): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    try {
        const stopped = await invoke<boolean>('cmd_release_session_sidecar', {
            sessionId,
            ownerType,
            ownerId,
        });
        console.debug(`[tauriClient] releaseSessionSidecar: session=${sessionId}, owner=${ownerType}:${ownerId}, stopped=${stopped}`);
        return stopped;
    } catch (error) {
        console.error(`[tauriClient] Failed to release session sidecar for ${sessionId}:`, error);
        // Don't throw - release should be best-effort
        return false;
    }
}

/**
 * Get the ready port for a Session's Sidecar.
 *
 * This is for callers that will immediately issue HTTP/SSE requests to the
 * returned port. Rust intentionally returns null while a sidecar is still
 * Starting so renderer code falls back to the tab URL waiter instead of racing
 * Node's bind/readiness window.
 *
 * @param sessionId - Session identifier
 * @returns Port number if Session has a ready Sidecar, null otherwise
 */
export async function getSessionPort(sessionId: string): Promise<number | null> {
    if (!isTauri()) {
        return 3000;
    }

    try {
        const port = await invoke<number | null>('cmd_get_session_port', { sessionId });
        return port;
    } catch (error) {
        console.warn(`[tauriClient] Failed to get session port for ${sessionId}:`, error);
        return null;
    }
}

/**
 * Check whether Rust currently has a live Session Sidecar entry.
 *
 * This is a presence/lifecycle check, not a transport URL primitive: Starting
 * sidecars count as present, but callers must still use getSessionPort or
 * ensureSessionSidecar before issuing HTTP requests.
 */
export async function hasSessionSidecar(sessionId: string): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        return await invoke<boolean>('cmd_has_session_sidecar', { sessionId });
    } catch (error) {
        console.warn(`[tauriClient] Failed to check session sidecar for ${sessionId}:`, error);
        return false;
    }
}

/**
 * Strict sidecar presence check for destructive operations.
 *
 * Unlike hasSessionSidecar(), this does not convert IPC failures to "absent":
 * callers such as session deletion must fail closed when Rust cannot confirm
 * that no ownerful sidecar is still alive.
 */
export async function hasSessionSidecarOrThrow(sessionId: string): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    return invoke<boolean>('cmd_has_session_sidecar', { sessionId });
}

/**
 * Get Rust's current sidecar generation for a session.
 *
 * Generation identifies a concrete sidecar instance. It remains the safest
 * stale-event discriminator because a same-session relaunch gets a fresh
 * generation even if that replacement is currently dead and awaiting recovery.
 */
export async function getSessionGeneration(sessionId: string): Promise<number | null> {
    if (!isTauri()) {
        return 1;
    }

    try {
        return await invoke<number | null>('cmd_get_session_generation', { sessionId });
    } catch (error) {
        console.warn(`[tauriClient] Failed to get session generation for ${sessionId}:`, error);
        return null;
    }
}

/**
 * Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
 * This updates HashMap keys in Rust without stopping the Sidecar.
 *
 * @param oldSessionId - The old session ID (typically "pending-{tabId}")
 * @param newSessionId - The new real session ID
 * @returns true if the upgrade was successful
 */
export async function upgradeSessionId(
    oldSessionId: string,
    newSessionId: string
): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        const upgraded = await invoke<boolean>('cmd_upgrade_session_id', {
            oldSessionId,
            newSessionId,
        });
        console.debug(`[tauriClient] upgradeSessionId: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
        return upgraded;
    } catch (error) {
        console.error(`[tauriClient] Failed to upgrade session ID from ${oldSessionId} to ${newSessionId}:`, error);
        return false;
    }
}

/**
 * Check whether a session identity must stay stable after a Tab releases it.
 * Rust includes live persistent owners and persisted running scheduler tasks
 * before their first Sidecar tick.
 */
export async function sessionHasPersistentOwners(sessionId: string): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        return await querySessionHasPersistentOwners(sessionId);
    } catch (error) {
        // This query protects session identity from hot-swap. Unknown owner
        // state must keep the current Sidecar key stable rather than risk
        // renaming a Cron/Goal/IM-owned process into another session.
        console.error(`[tauriClient] Failed to query persistent owners for ${sessionId}:`, error);
        return true;
    }
}

/** Raw owner query for user mutations that must preserve transport failures. */
export async function querySessionHasPersistentOwners(sessionId: string): Promise<boolean> {
    if (!isTauri()) return false;
    return await invoke<boolean>('cmd_session_has_persistent_owners', { sessionId });
}

export type SessionDeleteFailureReason =
    | 'in-use'
    | 'not-found'
    | 'protected-session'
    | 'invalid-session-id'
    | 'authority-unavailable'
    | 'transition-in-progress'
    | 'activity-unavailable'
    | 'unexpected';

export type SessionDeleteResult =
    | { deleted: true }
    | { deleted: false; reason: SessionDeleteFailureReason };

/**
 * Atomically delete after releasing only the mounted Tab owners named by App.
 * Any other owner keeps the Session protected.
 */
export async function deleteSessionIfUnowned(
    sessionId: string,
    releasableTabIds: readonly string[] = [],
): Promise<SessionDeleteResult> {
    if (!isTauri()) return { deleted: false, reason: 'authority-unavailable' };
    try {
        return await invoke<SessionDeleteResult>('cmd_delete_session_if_unowned', {
            sessionId,
            releasableTabIds: [...releasableTabIds],
        });
    } catch (error) {
        console.error(`[tauriClient] Failed to delete session ${sessionId}:`, error);
        return { deleted: false, reason: 'unexpected' };
    }
}

/** Atomically release a Tab owner and preserve/deactivate scheduler activation. */
export async function releaseTabSession(
    sessionId: string,
    tabId: string,
): Promise<boolean> {
    if (!isTauri()) return false;
    return await invoke<boolean>('cmd_release_tab_session', { sessionId, tabId });
}

export interface UserSchedulerLifecycleSnapshot {
    runningTaskCount: number;
    /** Exact non-Tab owner projection used by the Rust deletion boundary. */
    deleteProtectedSessionIds: string[];
}

/**
 * Lifecycle truth for user exit and Session deletion affordances. The running
 * count excludes hidden managed jobs; deletion protection includes every
 * persistent owner because it mirrors the Rust mutation boundary.
 */
export async function getUserSchedulerLifecycleSnapshot(): Promise<UserSchedulerLifecycleSnapshot> {
    if (!isTauri()) return { runningTaskCount: 0, deleteProtectedSessionIds: [] };
    try {
        return await invoke<UserSchedulerLifecycleSnapshot>('cmd_get_user_scheduler_lifecycle_snapshot');
    } catch (error) {
        console.error('[tauriClient] Failed to query user scheduler lifecycle:', error);
        throw error;
    }
}

/**
 * Lazy validation for tab restore (Issue #232 / PRD 0.2.25). Returns true iff
 * the session still exists in sessions.json AND its workspace dir still exists
 * on disk. Read-only; does not require the global sidecar. Returns false on any
 * error so a stale restored tab is dropped rather than resurrected as empty.
 * In the browser dev harness (non-Tauri) there's no on-disk index, so we
 * optimistically allow the restore to proceed.
 */
export async function canRestoreSession(sessionId: string, agentDir: string): Promise<boolean> {
    if (!isTauri()) return true;
    try {
        return await invoke<boolean>('cmd_can_restore_session', { sessionId, agentDir });
    } catch {
        return false;
    }
}

// ============= Background Session Completion API =============

/** Result from startBackgroundCompletion */
export interface BackgroundCompletionResult {
    started: boolean;
    sessionId: string;
}

/**
 * Start background completion for a session.
 * If the AI is actively generating a response, adds a BackgroundCompletion owner
 * to keep the Sidecar alive and spawns a polling thread to monitor completion.
 *
 * @param sessionId - Session identifier
 * @returns { started: true } if AI is running and background completion started,
 *          { started: false } if AI is authoritatively idle
 */
export async function startBackgroundCompletion(
    sessionId: string
): Promise<BackgroundCompletionResult> {
    if (!isTauri()) {
        return { started: false, sessionId };
    }

    try {
        const result = await invoke<BackgroundCompletionResult>('cmd_start_background_completion', {
            sessionId,
        });
        console.debug(`[tauriClient] startBackgroundCompletion: session=${sessionId}, started=${result.started}`);
        return result;
    } catch (error) {
        console.error(`[tauriClient] Failed to start background completion for ${sessionId}:`, error);
        return { started: false, sessionId };
    }
}

/**
 * Destructive handoff variant. Unlike the convenience wrapper above, this
 * preserves transport and activity-check failures so deletion can keep the
 * mounted Tab instead of mistaking uncertainty for idle.
 */
export async function startBackgroundCompletionForDeletion(
    sessionId: string
): Promise<BackgroundCompletionResult> {
    if (!isTauri()) {
        throw new Error('Session deletion activity authority is unavailable outside Tauri');
    }
    return await invoke<BackgroundCompletionResult>('cmd_start_background_completion', {
        sessionId,
    });
}

/**
 * Cancel background completion for a session.
 * Removes the BackgroundCompletion owner so the polling thread exits gracefully.
 * Used when user reconnects to a session that's completing in the background.
 *
 * @param sessionId - Session identifier
 * @returns true if a BackgroundCompletion owner was found and removed
 */
export async function cancelBackgroundCompletion(
    sessionId: string
): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    try {
        const cancelled = await invoke<boolean>('cmd_cancel_background_completion', {
            sessionId,
        });
        console.debug(`[tauriClient] cancelBackgroundCompletion: session=${sessionId}, cancelled=${cancelled}`);
        return cancelled;
    } catch (error) {
        console.error(`[tauriClient] Failed to cancel background completion for ${sessionId}:`, error);
        return false;
    }
}
