import type { ManagedProviderCredential, ModelAliases } from '../shared/config-types';

/**
 * Runtime-neutral provider environment consumed across the Server provider domain.
 * Credential values remain process-local and are never part of a public wire type.
 */
export type ProviderEnv = {
  /** Provider registry id. Metadata only: not forwarded as an SDK env var. */
  providerId?: string;
  /** Provider display name. Analytics metadata only: not forwarded as an SDK env var. */
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  /** Model aliases used when SDK sub-agents select a built-in model family. */
  modelAliases?: ModelAliases;
  /** Non-secret owner reference. Bearers are resolved by the Bridge per request. */
  credentialSource?: ManagedProviderCredential;
};
