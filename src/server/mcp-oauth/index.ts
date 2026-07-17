/**
 * MCP OAuth Module — Public API
 *
 * This is the ONLY entry point for the mcp-oauth module.
 * Other modules should only import from here.
 *
 * Exports:
 *   probeOAuthRequirement()    — Detect if an MCP server needs OAuth
 *   authorizeServer()          — Start OAuth flow (auto or manual)
 *   resolveAuthHeaders()       — Get valid Authorization headers (single token entry)
 *   revokeAuthorization()      — Revoke token for a server
 *   onOAuthCredentialChange()  — Observe persisted, non-secret credential revisions
 *   startTokenRefreshScheduler() — Start background refresh
 *   getOAuthStatus()           — Get current OAuth status for UI
 */

import { discoverOAuth } from './discovery';
import { dynamicRegister } from './registration';
import {
  bindCallbackServer,
  cancelFlow,
  isFlowPending,
  startAuthorizationFlow,
} from './authorization';
import {
  refreshToken,
  startTokenRefreshScheduler,
  startTokenRevisionObserver,
} from './token-manager';
import {
  clearServerToken,
  getServerState,
  updateServerState,
  isDiscoveryCacheValid,
  setServerToken,
} from './state-store';
import type { OAuthProbeResult, ManualOAuthConfig, OAuthTokenData } from './types';
import { fetchWithGeneralProxy } from '../utils/cancellation';
import type { SidecarRole } from '../sidecar-role';

// Re-export key functions from sub-modules
export {
  onOAuthCredentialChange,
  resolveAuthHeaders,
  startTokenRefreshScheduler,
  startTokenRevisionObserver,
  stopTokenRefreshScheduler,
  stopTokenRevisionObserver,
} from './token-manager';
export type {
  ManualOAuthConfig,
  OAuthCredentialChange,
  OAuthProbeResult,
  RefreshTokenOutcome,
} from './types';

/** Apply the OAuth maintenance owner contract selected at the process boundary. */
export function startOAuthMaintenanceForSidecarRole(role: SidecarRole): void {
  if (role === 'global') {
    startTokenRefreshScheduler();
  } else {
    // Baseline the full credential store before initializeAgent() can build
    // any MCP connection. Later config pushes never advance this baseline.
    startTokenRevisionObserver();
  }
}

/**
 * Probe an MCP server to detect if it requires OAuth.
 *
 * Uses cached discovery results (24h TTL) when available.
 * Forces re-discovery if forceRefresh is true.
 */
export async function probeOAuthRequirement(
  serverId: string,
  mcpUrl: string,
  forceRefresh = false,
): Promise<OAuthProbeResult> {
  // Check cached discovery result
  const state = getServerState(serverId);
  if (!forceRefresh && state?.discovery && isDiscoveryCacheValid(state.discovery)) {
    return {
      required: true,
      supportsDynamicRegistration: !!state.discovery.registrationEndpoint,
      scopes: state.discovery.scopesSupported,
    };
  }

  // Fresh discovery
  const discovery = await discoverOAuth(mcpUrl);
  if (!discovery) {
    return { required: false };
  }

  // Cache the result
  await updateServerState(serverId, { discovery });

  return {
    required: true,
    supportsDynamicRegistration: !!discovery.registrationEndpoint,
    scopes: discovery.scopesSupported,
  };
}

/**
 * Start OAuth authorization flow for an MCP server.
 *
 * Auto mode (no manualConfig): uses discovery + dynamic registration.
 * Manual mode (with manualConfig): uses user-provided credentials.
 *
 * @returns authUrl to open in browser + waitForCompletion promise
 */
export async function authorizeServer(
  serverId: string,
  mcpUrl: string,
  manualConfig?: ManualOAuthConfig,
): Promise<{ authUrl: string; waitForCompletion: Promise<boolean> }> {
  const state = getServerState(serverId);

  // Resolve discovery (from cache or fresh)
  let discovery = state?.discovery;
  if (!discovery || !isDiscoveryCacheValid(discovery)) {
    discovery = await discoverOAuth(mcpUrl) ?? undefined;
    if (discovery) {
      await updateServerState(serverId, { discovery });
    }
  }

  let clientId: string;
  let clientSecret: string | undefined;
  let authorizationEndpoint: string;
  let tokenEndpoint: string;
  let scopes: string[] | undefined;
  let callbackPort: number | undefined;
  let existingServer: { server: import('http').Server; port: number } | undefined;

  if (manualConfig?.clientId) {
    // === Manual mode ===
    clientId = manualConfig.clientId;
    clientSecret = manualConfig.clientSecret;
    authorizationEndpoint = manualConfig.authorizationUrl ?? discovery?.authorizationEndpoint ?? '';
    tokenEndpoint = manualConfig.tokenUrl ?? discovery?.tokenEndpoint ?? '';
    scopes = manualConfig.scopes;
    callbackPort = manualConfig.callbackPort;

    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error('Cannot resolve authorization/token endpoints. Please provide them manually or check the MCP server URL.');
    }

    // Persist manual config
    await updateServerState(serverId, { manualConfig });
  } else {
    // === Auto mode ===
    if (!discovery) {
      throw new Error('OAuth metadata not found. Please provide client credentials manually.');
    }

    authorizationEndpoint = discovery.authorizationEndpoint;
    tokenEndpoint = discovery.tokenEndpoint;
    scopes = discovery.scopesSupported;

    // Dynamic registration: bind callback server FIRST (keeps port alive),
    // then register with its actual port as redirect_uri.
    // This avoids the TOCTOU race of bind→close→register→rebind.
    if (discovery.registrationEndpoint) {
      const bound = await bindCallbackServer(0);
      const redirectUri = `http://127.0.0.1:${bound.port}/callback`;
      const registration = await dynamicRegister(
        discovery.registrationEndpoint,
        redirectUri,
        scopes,
      );
      await updateServerState(serverId, { registration });
      clientId = registration.clientId;
      clientSecret = registration.clientSecret;
      // Pass the already-bound server to startAuthorizationFlow (no re-bind needed)
      existingServer = bound;
    } else {
      throw new Error('Server does not support dynamic registration. Please provide Client ID manually.');
    }
  }

  // Start the authorization flow (reuse bound server if available)
  const { authUrl, waitForToken } = await startAuthorizationFlow(serverId, {
    clientId,
    clientSecret,
    authorizationEndpoint,
    tokenEndpoint,
    scopes,
    callbackPort,
  }, async (token) => {
    await setServerToken(serverId, token);
  }, existingServer);

  // The callback response is emitted only after this durable write succeeds.
  // A failed/superseded code exchange does not prove discovery metadata is
  // stale. Clearing shared discovery here can race a replacement flow and
  // remove the token endpoint that its newly committed credential needs.
  const waitForCompletion = waitForToken.then((token: OAuthTokenData | null) => Boolean(token));

  return { authUrl, waitForCompletion };
}

/**
 * Revoke OAuth authorization for an MCP server.
 * Attempts server-side token revocation (best effort), then clears local state.
 * Preserves discovery and registration data for re-authorization.
 */
export async function revokeAuthorization(serverId: string): Promise<void> {
  // Linearize revoke after any authorization flow already committing, or
  // cancel it before commit. The tombstone must be the final credential write.
  await cancelFlow(serverId);

  const state = getServerState(serverId);
  const token = state?.token;
  const discovery = state?.discovery;

  // Best-effort server-side revocation (RFC 7009)
  if (token?.accessToken && discovery?.tokenEndpoint) {
    try {
      // Derive revocation endpoint: replace /token with /revoke (common convention)
      const tokenUrl = new URL(discovery.tokenEndpoint);
      const revocationUrl = new URL(tokenUrl.href.replace(/\/token$/, '/revoke'));
      await fetchWithGeneralProxy(revocationUrl.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: token.accessToken,
          token_type_hint: 'access_token',
        }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[mcp-oauth] Server-side revocation attempted for ${serverId}`);
    } catch (err) {
      // Server-side revocation is best-effort — local cleanup always happens
      console.warn(`[mcp-oauth] Server-side revocation failed for ${serverId}:`, err);
    }
  }

  await clearServerToken(serverId);
  console.log(`[mcp-oauth] Authorization revoked for ${serverId}`);
}

/**
 * Get the OAuth status for a server (for UI display).
 */
export function getOAuthStatus(
  serverId: string,
): { status: 'disconnected' | 'connecting' | 'connected' | 'expired'; expiresAt?: number; scope?: string } {
  if (isFlowPending(serverId)) {
    return { status: 'connecting' };
  }

  const state = getServerState(serverId);
  if (!state?.token) {
    return { status: 'disconnected' };
  }

  if (state.token.expiresAt && state.token.expiresAt < Date.now()) {
    return { status: 'expired', expiresAt: state.token.expiresAt, scope: state.token.scope };
  }

  return { status: 'connected', expiresAt: state.token.expiresAt, scope: state.token.scope };
}

/**
 * Manually refresh token for a server (called from API endpoint).
 */
export async function manualRefreshToken(serverId: string): Promise<boolean> {
  const result = await refreshToken(serverId, 'manual');
  return result.kind === 'refreshed_by_self' || result.kind === 'observed_after_lock';
}
