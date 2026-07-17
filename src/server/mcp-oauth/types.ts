/**
 * MCP OAuth 2.0 Types
 *
 * Centralized type definitions for the mcp-oauth module.
 * All types used across discovery, registration, authorization, and token management.
 */

// ===== State Store Types =====

/** Token data stored after successful authorization */
export interface OAuthTokenData {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;   // Unix ms
  /** Token lifetime returned by the authorization server. Used to derive safe refresh lead time. */
  lifetimeMs?: number;
  scope?: string;
}

/** Discovery result cache */
export interface DiscoveryCache {
  authServerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  discoveredAt: number;
}

/** Dynamic registration result */
export interface RegistrationData {
  clientId: string;
  clientSecret?: string;
  registeredAt: number;
  expiresAt?: number;
}

/** Manual OAuth config (fallback when dynamic registration unavailable) */
export interface ManualOAuthConfig {
  clientId: string;
  clientSecret?: string;
  callbackPort?: number;
  scopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
}

/** Per-server OAuth state (persisted) */
export interface McpOAuthState {
  discovery?: DiscoveryCache;
  registration?: RegistrationData;
  manualConfig?: ManualOAuthConfig;
  token?: OAuthTokenData;
  /** Monotonic, non-secret credential revision shared by all Sidecar processes. */
  tokenRevision?: number;
}

/** Full state store structure */
export type McpOAuthStateStore = Record<string, McpOAuthState>;

// ===== API Result Types =====

/** Result of probing an MCP server for OAuth requirements */
export type OAuthProbeResult =
  | { required: false }
  | { required: true; supportsDynamicRegistration: boolean; scopes?: string[] };

export type OAuthCredentialStatus = 'available' | 'expired' | 'missing';

/** Non-secret snapshot emitted when a persisted credential revision or status changes. */
export interface OAuthCredentialChange {
  serverId: string;
  tokenRevision: number;
  status: OAuthCredentialStatus;
  expiresAt?: number;
}

export type OAuthCredentialChangeListener = (change: OAuthCredentialChange) => void;

export type RefreshTokenOutcome =
  | { kind: 'refreshed_by_self'; token: OAuthTokenData; tokenRevision: number }
  | { kind: 'observed_after_lock'; token: OAuthTokenData; tokenRevision: number }
  | {
      kind: 'discarded_after_conflict';
      reason: 'credential_missing' | 'credential_replaced';
      tokenRevision: number;
      /** Present only when the replacement credential is usable for this caller. */
      token?: OAuthTokenData;
    }
  | { kind: 'not_refreshable'; reason: 'missing_token' | 'missing_refresh_token' | 'missing_token_endpoint' }
  | { kind: 'failed'; error: string; http: 'not_sent' | 'failed' | 'success' };

// ===== Internal Types =====

/** OAuth 2.0 Authorization Server Metadata (RFC 8414 subset) */
export interface OAuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/** PKCE pair for authorization code flow */
export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Configuration for starting an authorization flow */
export interface AuthorizationConfig {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes?: string[];
  callbackPort?: number;
}

/** Dynamic client registration response (RFC 7591) */
export interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/** Legacy token format (for migration from mcp_oauth_tokens.json) */
export interface LegacyOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
  serverUrl: string;
  clientId?: string;
}
