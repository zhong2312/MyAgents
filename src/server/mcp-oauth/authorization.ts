/**
 * MCP OAuth Authorization Flow
 *
 * Handles the OAuth 2.0 Authorization Code Flow with PKCE:
 * - PKCE code challenge generation (RFC 7636, S256)
 * - Local HTTP callback server for authorization code receipt
 * - Authorization URL construction
 * - Code-to-token exchange
 * - 5-minute timeout with auto-cleanup
 *
 * Security:
 * - Callback server binds to 127.0.0.1 only
 * - State parameter for CSRF protection
 * - All HTML output XSS-escaped
 */

import { createHash, randomBytes } from 'crypto';
import http from 'http';
import type { AuthorizationConfig, OAuthTokenData, PKCEPair } from './types';
import { fetchWithGeneralProxy } from '../utils/cancellation';

// ===== Pending Flows =====

interface PendingFlow {
  serverId: string;
  config: AuthorizationConfig;
  pkce: PKCEPair;
  callbackPort: number;
  callbackServer: http.Server;
  state: string;
  resolve: (token: OAuthTokenData | null) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  phase: 'waiting' | 'exchanging' | 'committing' | 'settled';
  settled: Promise<void>;
  resolveSettled: () => void;
  startOwner: symbol;
}

const pendingFlows = new Map<string, PendingFlow>();
const flowStartOwners = new Map<string, symbol>();

/** Check if a flow is pending for a server */
export function isFlowPending(serverId: string): boolean {
  return pendingFlows.has(serverId);
}

// ===== PKCE =====

function generatePKCE(): PKCEPair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ===== HTML Escaping =====

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCallbackHtml(success: boolean, message: string): string {
  const color = success ? '#22c55e' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MyAgents OAuth</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{text-align:center;padding:2rem;border-radius:12px;background:#171717;border:1px solid #262626}
.icon{font-size:3rem;color:${color}}.msg{margin-top:1rem;font-size:1.1rem}</style></head>
<body><div class="card"><div class="icon">${icon}</div><div class="msg">${message}</div>
<p style="color:#737373;font-size:0.9rem;margin-top:1rem">You can close this tab now.</p></div></body></html>`;
}

// ===== Token Exchange =====

async function exchangeCodeForToken(
  code: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string | undefined,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokenData> {
  // Security: only allow https token endpoints (prevent credential leak over plain HTTP)
  // Exception: localhost for local dev servers
  const parsedUrl = new URL(tokenUrl);
  if (parsedUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
    throw new Error(`Refusing non-HTTPS token endpoint: ${tokenUrl}`);
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetchWithGeneralProxy(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status})`);
  }

  const data = await response.json() as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  const lifetimeMs = data.expires_in && data.expires_in > 0
    ? data.expires_in * 1000
    : undefined;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: lifetimeMs ? Date.now() + lifetimeMs : undefined,
    lifetimeMs,
    scope: data.scope,
  };
}

// ===== Callback Server =====

/**
 * Bind a bare HTTP server to a local port.
 * No request handler — caller installs one later.
 * Exported for use by index.ts to get a port before dynamic registration (avoids TOCTOU).
 */
export function bindCallbackServer(
  port: number,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', (err) => {
      reject(new Error(`Callback server error: ${err.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get callback server address'));
      }
    });
  });
}

// ===== Cleanup =====

function cleanupFlow(flow: PendingFlow): void {
  if (flow.phase === 'settled') return;
  flow.phase = 'settled';
  clearTimeout(flow.timeoutHandle);
  try { flow.callbackServer.close(); } catch { /* noop */ }
  if (pendingFlows.get(flow.serverId) === flow) {
    pendingFlows.delete(flow.serverId);
  }
  if (flowStartOwners.get(flow.serverId) === flow.startOwner) {
    flowStartOwners.delete(flow.serverId);
  }
  flow.resolveSettled();
}

async function settlePendingFlow(serverId: string): Promise<void> {
  const flow = pendingFlows.get(serverId);
  if (!flow) return;

  // Once durable commit begins it is the current flow's linearization point.
  // Let it settle before a replacement flow becomes current; before that
  // point, cancellation can safely make an in-flight exchange stale.
  if (flow.phase === 'committing') {
    await flow.settled;
    return;
  }

  flow.resolve(null);
  cleanupFlow(flow);
}

/** Cancel both a materialized flow and any callback-server start still in flight. */
export async function cancelFlow(serverId: string): Promise<void> {
  flowStartOwners.delete(serverId);
  await settlePendingFlow(serverId);
}

// ===== Main Authorization Flow =====

/**
 * Start the OAuth 2.0 Authorization Code Flow with PKCE.
 *
 * If existingServer is provided, reuses it (bound by caller via bindCallbackServer).
 * Otherwise creates a new callback server on the configured port.
 * The browser is told the flow succeeded only after `commitToken` durably
 * persists the credential.
 *
 * @returns authUrl to open in browser + waitForToken promise
 */
export async function startAuthorizationFlow(
  serverId: string,
  config: AuthorizationConfig,
  commitToken: (token: OAuthTokenData) => Promise<void>,
  existingServer?: { server: http.Server; port: number },
): Promise<{ authUrl: string; waitForToken: Promise<OAuthTokenData | null> }> {
  const startOwner = Symbol(serverId);
  flowStartOwners.set(serverId, startOwner);

  // Cancel any existing flow
  await settlePendingFlow(serverId);
  if (flowStartOwners.get(serverId) !== startOwner) {
    try { existingServer?.server.close(); } catch { /* noop */ }
    throw new Error(`Authorization start superseded for ${serverId}`);
  }

  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');

  // Use existing server or bind a new one
  let boundServer: { server: http.Server; port: number };
  try {
    boundServer = existingServer ?? await bindCallbackServer(config.callbackPort || 0);
  } catch (error) {
    if (flowStartOwners.get(serverId) === startOwner) {
      flowStartOwners.delete(serverId);
    }
    throw error;
  }
  const { server: srv, port: srvPort } = boundServer;
  if (flowStartOwners.get(serverId) !== startOwner) {
    try { srv.close(); } catch { /* noop */ }
    throw new Error(`Authorization start superseded for ${serverId}`);
  }

  console.log(`[mcp-oauth] Callback server for ${serverId} on port ${srvPort}`);

  const redirectUri = `http://127.0.0.1:${srvPort}/callback`;

  // Create token promise — resolved when callback is received
  let flow!: PendingFlow;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const tokenPromise = new Promise<OAuthTokenData | null>((resolveToken) => {
    // Install the request handler on the server
    srv.removeAllListeners('request');
    srv.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/callback') {
        if (flow.phase !== 'waiting') {
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(false, 'Authorization callback is already being processed.'));
          return;
        }

        const code = url.searchParams.get('code');
        const reqState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          const desc = url.searchParams.get('error_description') || error;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildCallbackHtml(false, `Authorization failed: ${escapeHtml(desc)}`));
          cleanupFlow(flow);
          resolveToken(null);
          return;
        }

        if (code && reqState) {
          if (reqState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildCallbackHtml(false, 'Authorization failed: state parameter mismatch'));
            cleanupFlow(flow);
            resolveToken(null);
            return;
          }

          flow.phase = 'exchanging';
          void (async () => {
            try {
              const token = await exchangeCodeForToken(
                code,
                config.tokenEndpoint,
                config.clientId,
                config.clientSecret,
                pkce.codeVerifier,
                redirectUri,
              );
              if (pendingFlows.get(serverId) !== flow) {
                res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(buildCallbackHtml(false, 'Authorization was superseded by a newer attempt.'));
                resolveToken(null);
                return;
              }

              // No await is allowed between the exact-owner check and this
              // phase transition. A replacement flow will now await `settled`
              // instead of cancelling a credential commit already in progress.
              flow.phase = 'committing';
              await commitToken(token);
              console.log(`[mcp-oauth] Token obtained and persisted for ${serverId}`);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(buildCallbackHtml(true, 'Authorization successful! You can close this tab.'));
              resolveToken(token);
            } catch (err) {
              console.error(`[mcp-oauth] Authorization finalization failed for ${serverId}:`, err);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(buildCallbackHtml(false, 'Authorization failed while saving credentials. Return to MyAgents and try again.'));
              resolveToken(null);
            } finally {
              cleanupFlow(flow);
            }
          })();
          return;
        }

        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code or state parameter');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Auto-cleanup timer — stored on flow so cancelFlow() can clear it
    // (prevents stale timer from cancelling a restarted flow for the same serverId)
    const timeoutHandle = setTimeout(() => {
      if (pendingFlows.has(serverId)) {
        console.warn(`[mcp-oauth] Authorization flow timed out for ${serverId}`);
        const timedOutFlow = pendingFlows.get(serverId);
        if (timedOutFlow === flow) {
          flow.resolve(null);
          cleanupFlow(flow);
        }
      }
    }, 5 * 60 * 1000);

    flow = {
      serverId,
      config,
      pkce,
      callbackPort: srvPort,
      callbackServer: srv,
      state,
      resolve: resolveToken,
      timeoutHandle,
      phase: 'waiting',
      settled,
      resolveSettled,
      startOwner,
    };
    pendingFlows.set(serverId, flow);
  });

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.scopes?.length) {
    params.set('scope', config.scopes.join(' '));
  }

  const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;
  console.log(`[mcp-oauth] Authorization flow started for ${serverId}`);

  return { authUrl, waitForToken: tokenPromise };
}
