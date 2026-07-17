/**
 * MCP OAuth Token Manager
 *
 * Token consumption stays Session-scoped, while proactive maintenance is
 * owned by the Global Sidecar. All processes coordinate through the existing
 * state-store and refresh locks; Session processes only observe non-secret
 * credential revisions.
 */

import { join } from 'path';
import {
  getOAuthConfigDir,
  getServerState,
  loadStateStore,
  setServerTokenIfRevision,
} from './state-store';
import type {
  McpOAuthState,
  OAuthCredentialChange,
  OAuthCredentialChangeListener,
  OAuthCredentialStatus,
  OAuthTokenData,
  RefreshTokenOutcome,
} from './types';
import { ensureDirSync } from '../utils/fs-utils';
import { withFileLock } from '../utils/file-lock';
import { fetchWithGeneralProxy } from '../utils/cancellation';

const LEGACY_PROACTIVE_REFRESH_LEAD_MS = 5 * 60 * 1000;
const LEGACY_INLINE_REFRESH_LEAD_MS = 60 * 1000;
const SCHEDULER_STORE_RESCAN_MS = 5 * 1000;
const PROACTIVE_FAILURE_RETRY_MS = 60 * 1000;
const MIN_SCHEDULER_DELAY_MS = 250;
const CREDENTIAL_OBSERVER_INTERVAL_MS = 5 * 1000;
const REFRESH_LOCK_TIMEOUT_MS = 20 * 1000;
const REFRESH_LOCK_STALE_MS = 30 * 1000;
const REFRESH_LOCK_RETRY_MS = 100;

type RefreshIntent = 'inline' | 'proactive' | 'manual';

// ===== Credential revision observer (Session Sidecars only) =====

interface CredentialSnapshot {
  tokenRevision: number;
  status: OAuthCredentialStatus;
  expiresAt?: number;
}

const credentialListeners = new Set<OAuthCredentialChangeListener>();
let credentialObserverStarted = false;
let credentialObserverTimer: ReturnType<typeof setTimeout> | null = null;
let observedCredentials = new Map<string, CredentialSnapshot>();

function credentialSnapshot(
  state: McpOAuthState | undefined,
  now = Date.now(),
): CredentialSnapshot {
  const token = state?.token;
  const status: OAuthCredentialStatus = !token
    ? 'missing'
    : token.expiresAt !== undefined && token.expiresAt <= now
      ? 'expired'
      : 'available';
  return {
    tokenRevision: Number.isSafeInteger(state?.tokenRevision) && (state?.tokenRevision ?? 0) >= 0
      ? state?.tokenRevision ?? 0
      : 0,
    status,
    expiresAt: token?.expiresAt,
  };
}

function snapshotCredentialStore(now = Date.now()): Map<string, CredentialSnapshot> {
  return new Map(
    Object.entries(loadStateStore(true)).map(([serverId, state]) => [
      serverId,
      credentialSnapshot(state, now),
    ]),
  );
}

function emitCredentialChange(change: OAuthCredentialChange): void {
  console.log(
    `[mcp-oauth] Credential changed: server=${change.serverId} revision=${change.tokenRevision} status=${change.status}`,
  );
  for (const listener of credentialListeners) {
    try {
      listener(change);
    } catch (err) {
      console.error('[mcp-oauth] Credential listener error:', err);
    }
  }
}

/** Register the process-local consumer of persisted credential revisions. */
export function onOAuthCredentialChange(listener: OAuthCredentialChangeListener): () => void {
  credentialListeners.add(listener);
  return () => credentialListeners.delete(listener);
}

/**
 * Compare the persisted store with this Session's baseline.
 * Exported only so deterministic tests do not have to wait for wall-clock polling.
 */
export function pollOAuthCredentialChanges(): void {
  const nextCredentials = snapshotCredentialStore();
  const serverIds = new Set([...observedCredentials.keys(), ...nextCredentials.keys()]);

  for (const serverId of serverIds) {
    const previous = observedCredentials.get(serverId) ?? { tokenRevision: 0, status: 'missing' as const };
    const next = nextCredentials.get(serverId) ?? { tokenRevision: 0, status: 'missing' as const };
    if (
      previous.tokenRevision !== next.tokenRevision
      || previous.status !== next.status
      || previous.expiresAt !== next.expiresAt
    ) {
      emitCredentialChange({ serverId, ...next });
    }
  }

  observedCredentials = nextCredentials;
}

function scheduleCredentialObserverPoll(): void {
  if (!credentialObserverStarted) return;
  credentialObserverTimer = setTimeout(() => {
    credentialObserverTimer = null;
    pollOAuthCredentialChanges();
    scheduleCredentialObserverPoll();
  }, CREDENTIAL_OBSERVER_INTERVAL_MS);
  credentialObserverTimer.unref?.();
}

/** Baseline the full store synchronously before Session initialization. */
export function startTokenRevisionObserver(): void {
  if (credentialObserverStarted) return;
  observedCredentials = snapshotCredentialStore();
  credentialObserverStarted = true;
  scheduleCredentialObserverPoll();
  console.log(`[mcp-oauth] Credential revision observer started: entries=${observedCredentials.size}`);
}

export function stopTokenRevisionObserver(): void {
  credentialObserverStarted = false;
  if (credentialObserverTimer) {
    clearTimeout(credentialObserverTimer);
    credentialObserverTimer = null;
  }
  observedCredentials.clear();
}

// ===== Token refresh =====

const refreshInFlight = new Map<string, Promise<RefreshTokenOutcome>>();

function lockNameForServer(serverId: string): string {
  return encodeURIComponent(serverId).replace(/%/g, '_');
}

async function withRefreshLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const locksDir = join(getOAuthConfigDir(), 'mcp_oauth_locks');
  const lockDir = join(locksDir, `${lockNameForServer(serverId)}.lock`);
  ensureDirSync(locksDir);
  return await withFileLock({
    lockPath: lockDir,
    timeoutMs: REFRESH_LOCK_TIMEOUT_MS,
    staleMs: REFRESH_LOCK_STALE_MS,
    pollMs: REFRESH_LOCK_RETRY_MS,
  }, fn);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Derive a lead that cannot consume more than half of a short-lived token. */
export function getRefreshLeadMs(token: OAuthTokenData, intent: Exclude<RefreshIntent, 'manual'>): number {
  if (!token.lifetimeMs || token.lifetimeMs <= 0) {
    return intent === 'proactive'
      ? LEGACY_PROACTIVE_REFRESH_LEAD_MS
      : LEGACY_INLINE_REFRESH_LEAD_MS;
  }

  const proportionalLead = token.lifetimeMs * 0.1;
  const boundedLead = intent === 'proactive'
    ? clamp(proportionalLead, 5_000, 5 * 60_000)
    : clamp(proportionalLead, 1_000, 60_000);
  return Math.min(boundedLead, token.lifetimeMs * 0.5);
}

function tokenFromOutcome(outcome: RefreshTokenOutcome): OAuthTokenData | null {
  if (outcome.kind === 'refreshed_by_self' || outcome.kind === 'observed_after_lock') {
    return outcome.token;
  }
  return outcome.kind === 'discarded_after_conflict' ? outcome.token ?? null : null;
}

/** Whether an observed credential is usable for the caller that requested refresh. */
function tokenIsFreshForIntent(
  token: OAuthTokenData,
  intent: RefreshIntent,
  now = Date.now(),
): boolean {
  if (token.expiresAt === undefined) return true;
  const leadMs = intent === 'manual' ? 0 : getRefreshLeadMs(token, intent);
  return token.expiresAt > now + leadMs;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logRefreshOutcome(serverId: string, intent: RefreshIntent, outcome: RefreshTokenOutcome): void {
  const revision = outcome.kind === 'refreshed_by_self'
    || outcome.kind === 'observed_after_lock'
    || outcome.kind === 'discarded_after_conflict'
    ? outcome.tokenRevision
    : undefined;
  const token = outcome.kind === 'refreshed_by_self'
    || outcome.kind === 'observed_after_lock'
    || outcome.kind === 'discarded_after_conflict'
    ? outcome.token
    : undefined;
  const http = outcome.kind === 'refreshed_by_self' || outcome.kind === 'discarded_after_conflict'
    ? 'success'
    : outcome.kind === 'observed_after_lock' || outcome.kind === 'not_refreshable'
      ? 'not_sent'
      : outcome.http;
  const commit = outcome.kind === 'refreshed_by_self'
    ? 'committed'
    : outcome.kind === 'discarded_after_conflict' ? 'conflict_discarded' : 'none';
  console.log(
    `[mcp-oauth] Refresh outcome: server=${serverId} intent=${intent} outcome=${outcome.kind}`
      + ` revision=${revision ?? '-'} pid=${process.pid}`
      + ` role=${process.env.MYAGENTS_SIDECAR_ROLE ?? 'unknown'}`
      + ` http=${http} commit=${commit}`
      + ` expiresAt=${token?.expiresAt ?? '-'} lifetimeMs=${token?.lifetimeMs ?? '-'}`,
  );
}

/** Refresh a token, distinguishing a real POST from a credential observed after lock acquisition. */
export async function refreshToken(
  serverId: string,
  intent: RefreshIntent = 'inline',
): Promise<RefreshTokenOutcome> {
  const existing = refreshInFlight.get(serverId);
  if (existing) return existing;

  const promise = refreshTokenInner(serverId, intent).catch((error): RefreshTokenOutcome => ({
    kind: 'failed',
    error: safeErrorMessage(error),
    http: 'not_sent',
  }));
  refreshInFlight.set(serverId, promise);
  try {
    const outcome = await promise;
    logRefreshOutcome(serverId, intent, outcome);
    return outcome;
  } finally {
    refreshInFlight.delete(serverId);
  }
}

async function refreshTokenInner(
  serverId: string,
  intent: RefreshIntent,
): Promise<RefreshTokenOutcome> {
  const observedRevision = loadStateStore(true)[serverId]?.tokenRevision ?? 0;
  return await withRefreshLock(serverId, async () => {
    const state = loadStateStore(true)[serverId];
    if (!state?.token) {
      return { kind: 'not_refreshable', reason: 'missing_token' };
    }

    const currentToken = state.token;
    const refreshBaseRevision = state.tokenRevision ?? 0;
    if (
      (state.tokenRevision ?? 0) !== observedRevision
      && tokenIsFreshForIntent(currentToken, intent)
    ) {
      return {
        kind: 'observed_after_lock',
        token: currentToken,
        tokenRevision: state.tokenRevision ?? 0,
      };
    }
    if (intent !== 'manual' && tokenIsFreshForIntent(currentToken, intent)) {
      return {
        kind: 'observed_after_lock',
        token: currentToken,
        tokenRevision: state.tokenRevision ?? 0,
      };
    }

    if (!currentToken.refreshToken) {
      return { kind: 'not_refreshable', reason: 'missing_refresh_token' };
    }

    const clientId = state.registration?.clientId ?? state.manualConfig?.clientId;
    const tokenEndpoint = state.manualConfig?.tokenUrl ?? state.discovery?.tokenEndpoint;
    if (!tokenEndpoint) {
      return { kind: 'not_refreshable', reason: 'missing_token_endpoint' };
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentToken.refreshToken,
    });
    if (clientId) body.set('client_id', clientId);
    const clientSecret = state.registration?.clientSecret ?? state.manualConfig?.clientSecret;
    if (clientSecret) body.set('client_secret', clientSecret);

    let response: Response;
    try {
      response = await fetchWithGeneralProxy(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { kind: 'failed', error: safeErrorMessage(error), http: 'failed' };
    }

    if (!response.ok) {
      return { kind: 'failed', error: `HTTP ${response.status}`, http: 'failed' };
    }

    let data: {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    try {
      data = await response.json() as typeof data;
    } catch (error) {
      return { kind: 'failed', error: safeErrorMessage(error), http: 'success' };
    }
    if (!data.access_token) {
      return { kind: 'failed', error: 'Token response missing access_token', http: 'success' };
    }

    const lifetimeMs = data.expires_in && data.expires_in > 0
      ? data.expires_in * 1000
      : undefined;
    const newToken: OAuthTokenData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || currentToken.refreshToken,
      tokenType: data.token_type || 'Bearer',
      expiresAt: lifetimeMs ? Date.now() + lifetimeMs : undefined,
      lifetimeMs,
      scope: data.scope || currentToken.scope,
    };

    let tokenRevision: number | null;
    try {
      tokenRevision = await setServerTokenIfRevision(
        serverId,
        refreshBaseRevision,
        newToken,
      );
    } catch (error) {
      return { kind: 'failed', error: safeErrorMessage(error), http: 'success' };
    }
    if (tokenRevision === null) {
      const latestState = loadStateStore(true)[serverId];
      if (!latestState?.token) {
        return {
          kind: 'discarded_after_conflict',
          reason: 'credential_missing',
          tokenRevision: latestState?.tokenRevision ?? refreshBaseRevision,
        };
      }
      if (tokenIsFreshForIntent(latestState.token, intent)) {
        return {
          kind: 'discarded_after_conflict',
          reason: 'credential_replaced',
          token: latestState.token,
          tokenRevision: latestState.tokenRevision ?? 0,
        };
      }
      return {
        kind: 'discarded_after_conflict',
        reason: 'credential_replaced',
        tokenRevision: latestState.tokenRevision ?? 0,
      };
    }
    return { kind: 'refreshed_by_self', token: newToken, tokenRevision };
  });
}

// ===== resolveAuthHeaders — the single token consumption entry point =====

export async function resolveAuthHeaders(serverId: string): Promise<Record<string, string>> {
  const state = getServerState(serverId);
  if (!state?.token) return {};

  const token = state.token;
  if (
    token.expiresAt !== undefined
    && token.expiresAt < Date.now() + getRefreshLeadMs(token, 'inline')
  ) {
    if (token.refreshToken) {
      const refreshed = tokenFromOutcome(await refreshToken(serverId, 'inline'));
      if (refreshed) {
        return { Authorization: `${refreshed.tokenType || 'Bearer'} ${refreshed.accessToken}` };
      }
    }
    return {};
  }

  return { Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}` };
}

// ===== Global proactive refresh scheduler =====

let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerGeneration = 0;
const proactiveRetryCooldowns = new Map<string, { tokenRevision: number; retryAt: number }>();

function hasTokenEndpoint(state: McpOAuthState): boolean {
  return Boolean(state.manualConfig?.tokenUrl ?? state.discovery?.tokenEndpoint);
}

function proactiveRetryAt(serverId: string, state: McpOAuthState): number | undefined {
  const cooldown = proactiveRetryCooldowns.get(serverId);
  if (!cooldown) return undefined;
  if (cooldown.tokenRevision !== (state.tokenRevision ?? 0)) {
    proactiveRetryCooldowns.delete(serverId);
    return undefined;
  }
  return cooldown.retryAt;
}

function nextSchedulerDelay(now = Date.now()): number {
  let earliestDeadline = Number.POSITIVE_INFINITY;
  for (const [serverId, state] of Object.entries(loadStateStore(true))) {
    const token = state.token;
    if (!token?.refreshToken || token.expiresAt === undefined || !hasTokenEndpoint(state)) continue;
    const retryAt = proactiveRetryAt(serverId, state);
    earliestDeadline = Math.min(
      earliestDeadline,
      Math.max(token.expiresAt - getRefreshLeadMs(token, 'proactive'), retryAt ?? 0),
    );
  }

  if (!Number.isFinite(earliestDeadline) || earliestDeadline <= now) {
    return SCHEDULER_STORE_RESCAN_MS;
  }
  return Math.max(
    MIN_SCHEDULER_DELAY_MS,
    Math.min(SCHEDULER_STORE_RESCAN_MS, earliestDeadline - now),
  );
}

function scheduleNextRefreshCycle(generation: number): void {
  if (!schedulerStarted || generation !== schedulerGeneration) return;
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    void runRefreshCycle(generation);
  }, nextSchedulerDelay());
  schedulerTimer.unref?.();
}

async function runRefreshCycle(generation: number): Promise<void> {
  if (!schedulerStarted || generation !== schedulerGeneration) return;

  const now = Date.now();
  const tasks: Promise<RefreshTokenOutcome>[] = [];
  for (const [serverId, state] of Object.entries(loadStateStore(true))) {
    const token = state.token;
    if (!token?.refreshToken || token.expiresAt === undefined || !hasTokenEndpoint(state)) continue;
    const refreshDeadline = token.expiresAt - getRefreshLeadMs(token, 'proactive');
    const retryAt = proactiveRetryAt(serverId, state);
    if (refreshDeadline <= now && (retryAt === undefined || retryAt <= now)) {
      tasks.push(refreshToken(serverId, 'proactive').then(outcome => {
        if (outcome.kind === 'failed' || outcome.kind === 'not_refreshable') {
          proactiveRetryCooldowns.set(serverId, {
            tokenRevision: state.tokenRevision ?? 0,
            retryAt: Date.now() + PROACTIVE_FAILURE_RETRY_MS,
          });
        } else {
          proactiveRetryCooldowns.delete(serverId);
        }
        return outcome;
      }));
    }
  }

  if (tasks.length > 0) await Promise.all(tasks);
  scheduleNextRefreshCycle(generation);
}

/** Start the one proactive scheduler owned by the Global Sidecar. */
export function startTokenRefreshScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const generation = ++schedulerGeneration;
  console.log('[mcp-oauth] Global token refresh scheduler started');
  void runRefreshCycle(generation);
}

export function stopTokenRefreshScheduler(): void {
  schedulerStarted = false;
  schedulerGeneration += 1;
  proactiveRetryCooldowns.clear();
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
