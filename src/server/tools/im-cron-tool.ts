// IM cron context — sidecar-side state for IM and regular cron sessions.
//
// Historical note: this module used to host an in-process MCP server
// (`im-cron`) that the AI used to manage scheduled tasks. The MCP was
// retired in v0.2.11 in favour of the universal `myagents cron …` CLI
// compatibility commands + the system prompt's <myagents-cli-task-automation> guidance (see
// system-prompt-cli-tools.ts). Cron CRUD now flows through admin-api.ts
// handlers (handleCronList / handleCronCreate / handleCronExit / etc.)
// which reach the same Rust Management API the old MCP did.
//
// What this file still owns: two context registries that downstream code
// reads to know "is the active session an IM session?" and "what bot/chat
// am I tied to?". These remain a sidecar-process singleton because each
// Sidecar maps 1:1 to a Session (see ARCHITECTURE «Sidecar Owner 模型»).

import type { RuntimeConfig, RuntimeType } from '../../shared/types/runtime';

// ===== IM Cron Context =====

interface ImCronContext {
  botId: string;
  chatId: string;
  platform: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  /** PRD 0.2.9 — DEPRECATED. New code SHOULD pass `providerId` so cron
   *  ticks live-resolve credentials from `~/.myagents/config.json` and
   *  rotation propagates. Kept for legacy callers. */
  providerEnv?: { providerId?: string; providerName?: string; baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string } };
  /** PRD 0.2.9 — Per-session provider id. When set, cron tasks created
   *  through this context get `providerId`-based live-resolution. */
  providerId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
}

let imCronContext: ImCronContext | null = null;

export function setImCronContext(ctx: ImCronContext): void {
  imCronContext = ctx;
  console.log(`[im-cron] Context set: botId=${ctx.botId}, chatId=${ctx.chatId}`);
}

export function clearImCronContext(): void {
  imCronContext = null;
  console.log('[im-cron] Context cleared');
}

export function getImCronContext(): ImCronContext | null {
  return imCronContext;
}

// ===== Session Cron Context (for non-IM sessions) =====

export interface SessionCronContext {
  sessionId: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  /** PRD 0.2.9 — DEPRECATED, see ImCronContext.providerEnv. */
  providerEnv?: { providerId?: string; providerName?: string; baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string } };
  /** PRD 0.2.9 — Per-session provider id; preferred over providerEnv. */
  providerId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
}

let sessionCronContext: SessionCronContext | null = null;

export function setSessionCronContext(ctx: SessionCronContext): void {
  sessionCronContext = ctx;
  console.log(`[im-cron] Session cron context set: sessionId=${ctx.sessionId}`);
}

export function clearSessionCronContext(): void {
  sessionCronContext = null;
  console.log('[im-cron] Session cron context cleared');
}

export function getSessionCronContext(): SessionCronContext | null {
  return sessionCronContext;
}
