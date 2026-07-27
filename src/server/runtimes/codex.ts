// CodexRuntime — drives the Codex CLI as a subprocess via app-server (v0.1.60)
//
// Communication: JSON-RPC 2.0 over stdio (codex app-server)
// Process lifecycle: persistent across turns (unlike CC's -p mode)
// Permission: Server-initiated Requests with RPC Responses
// System prompt: thread/start → developerInstructions
// Session: thread/start (new) / thread/resume (continuing)

import { spawn, type Subprocess, type SubprocessStdin } from '../utils/subprocess';
import { writeFileSync , existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type {
  RuntimeDetection, RuntimeModelInfo, RuntimePermissionMode, RuntimeType,
  RuntimeAuthStatus, RuntimeFeatureFlag, RuntimeMcpServerInfo, RuntimeAppInfo,
  RuntimeDiagnostics, RuntimeDiagnosticsStatus, RuntimeEffectiveEnv,
  RuntimeProxyPolicy, RuntimeDiagnosticIssue,
  RuntimeSource,
} from '../../shared/types/runtime';
import type { McpServerDefinition } from '../../shared/config-types';
import { CODEX_PERMISSION_MODES } from '../../shared/types/runtime';
import { coerceFileChanges, formatFileChangeForResult } from '../../shared/fileChange';
import type { AgentPlanTodo, AgentRuntime, RuntimeConfigCapabilities, RuntimeProcess, SessionStartOptions, UnifiedEvent, UnifiedEventCallback, ResolvedImagePayload, SubAgentScope } from './types';
import { StaleRuntimeSessionError } from './types';
import type { InteractionScenario } from '../system-prompt';
import { shouldDisallowAskUserQuestion } from '../host-interaction';
import { mapCodexTokenUsage, type CodexThreadTokenUsage } from './codex-token-usage';
import { stripAnsi } from './env-utils';
import { resolveCodexCommandContext, type CodexCommandContext } from './codex-command-context';
import { ensureDirSync } from '../utils/fs-utils';
import { getBundledCusePath } from '../utils/runtime';
import { resolveNpxMcpInvocation } from '../utils/mcp-command';
import { killWithEscalation } from './utils/kill-with-escalation';
import { withLogContext } from '../logger-context';
import { trySyncProjectUserConfigFiles } from '../utils/project-user-config-sync';
import {
  saveToolAttachment,
  makePlaceholderAttachment,
  makeErrorAttachment,
  trackInFlightSave,
  type AttachmentSource,
  type SaveContext,
} from './tool-attachments';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import { MCP_PREWARM_GRACE_MS } from '../session-core/mcp-prewarm-policy';

type CodexDecision = 'deny' | 'allow_once' | 'always_allow';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | { granular: Record<string, boolean> };
type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
    type: 'workspaceWrite';
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

export const CODEX_INITIALIZE_CAPABILITIES = Object.freeze({
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    'remoteControl/status/changed',
    'thread/goal/cleared',
  ],
});

export function buildCodexInitializeParams(): Record<string, unknown> {
  return {
    clientInfo: { name: 'MyAgents', title: null, version: process.env.MYAGENTS_VERSION || '0.1.60' },
    capabilities: CODEX_INITIALIZE_CAPABILITIES,
  };
}

const CODEX_PROJECT_DOC_FALLBACK_CONFIG = 'project_doc_fallback_filenames=["CLAUDE.md"]';
const CODEX_FILE_AUTH_CONFIG = 'cli_auth_credentials_store="file"';
const MANAGED_CODEX_HTTP_PROVIDER_ID = 'myagents_managed_http';
const CODEX_MCP_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]';
const CODEX_MCP_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;
const CODEX_MCP_TEMPLATE_RE = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;
const CODEX_MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_MCP_SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/i;
const CODEX_MCP_INLINE_SECRET_RE = /(?:api[-_]?key|token|secret|password|authorization|access[-_]?token|refresh[-_]?token)\s*[:=]\s*[^,\s]+/i;
const CODEX_MCP_SENSITIVE_FLAG_RE = /^-{1,2}(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|authorization|auth-token)(?:$|[=:])/i;
const CODEX_MCP_PARENT_ENV_DENY = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'MYAGENTS_RUNTIME_SOURCE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
]);
export type CodexMcpStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';

export interface CodexMcpStartupStatusNotification {
  threadId: string | null;
  name: string;
  status: CodexMcpStartupState;
  error: string | null;
  failureReason: string | null;
}

export interface CodexMcpServerStatus {
  name: string;
  tools: Record<string, { name?: string } | undefined>;
  resources?: unknown[];
  authStatus: unknown;
}

function codexMcpAuthStatusText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  return typeof status.status === 'string'
    ? status.status
    : typeof status.kind === 'string'
      ? status.kind
      : undefined;
}

function isCodexMcpAuthUnavailable(value: unknown): boolean {
  const status = codexMcpAuthStatusText(value)?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return status === 'notloggedin'
    || status.includes('unauthenticated')
    || status.includes('failed')
    || status.includes('error')
    || status.includes('needs')
    || status.includes('required');
}

/** Build the UI-facing catalog from tools Codex reports on explicitly ready servers. */
export function buildCodexMcpToolCatalog(
  servers: readonly CodexMcpServerStatus[],
  readyServerNames: ReadonlySet<string>,
): string[] {
  const catalog = new Set<string>();
  for (const server of servers) {
    if (!readyServerNames.has(server.name) || isCodexMcpAuthUnavailable(server.authStatus)) continue;
    for (const [key, tool] of Object.entries(server.tools ?? {})) {
      const toolName = typeof tool?.name === 'string' && tool.name ? tool.name : key;
      if (server.name && toolName) catalog.add(`mcp__${server.name}__${toolName}`);
    }
  }
  return [...catalog].sort();
}

type CodexMcpServerStatusPage = {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
};

/** Read the complete tool catalog for the active Codex thread. */
export async function listCodexMcpServerStatuses(
  rpc: Pick<JsonRpcClient, 'call'>,
  threadId: string,
): Promise<CodexMcpServerStatus[]> {
  const servers: CodexMcpServerStatus[] = [];
  let cursor: string | null = null;
  do {
    const page = await rpc.call('mcpServerStatus/list', {
      threadId,
      detail: 'toolsAndAuthOnly',
      ...(cursor ? { cursor } : {}),
    }, 5_000) as CodexMcpServerStatusPage;
    servers.push(...(page.data ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return servers;
}

export interface CodexMcpStartupResult {
  outcome: 'ready' | 'degraded';
  reason?: 'terminal_status' | 'timeout';
  states: Record<string, CodexMcpStartupState>;
  pendingNames: string[];
  elapsedMs: number;
}

/**
 * Runtime-native startup barrier for the MCP servers MyAgents injected into a
 * managed Codex process. Unknown Codex-owned servers are intentionally ignored:
 * this owner can only wait on configuration it owns.
 */
export function createCodexMcpStartupBarrier(expectedNames: readonly string[]): {
  observe(notification: CodexMcpStartupStatusNotification): void;
  arm(): void;
  fail(error: Error): void;
  wait(): Promise<CodexMcpStartupResult>;
} {
  let startedAt: number | null = null;
  let deadlineAt: number | null = null;
  const expected = new Set(expectedNames);
  const states = new Map<string, CodexMcpStartupState>();
  let failure: Error | null = null;
  let resolveComplete!: () => void;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  let completed = expected.size === 0;
  if (completed) resolveComplete();

  const snapshot = (timedOut: boolean): CodexMcpStartupResult => {
    const pending = pendingNames();
    const stateSnapshot = Object.fromEntries(
      [...states.entries()].filter(([name]) => expected.has(name)),
    );
    const unhealthy = Object.values(stateSnapshot)
      .some(state => state === 'failed' || state === 'cancelled');
    const degraded = timedOut || pending.length > 0 || unhealthy;
    return {
      outcome: degraded ? 'degraded' : 'ready',
      ...(degraded ? { reason: timedOut || pending.length > 0 ? 'timeout' as const : 'terminal_status' as const } : {}),
      states: stateSnapshot,
      pendingNames: pending,
      elapsedMs: startedAt === null ? 0 : Math.max(0, Date.now() - startedAt),
    };
  };

  const pendingNames = (): string[] => [...expected].filter((name) => {
    const state = states.get(name);
    return state === undefined || state === 'starting';
  });

  return {
    observe(notification) {
      if (!expected.has(notification.name) || completed) return;
      states.set(notification.name, notification.status);
      const allTerminal = [...expected].every((name) => {
        const state = states.get(name);
        return state === 'ready' || state === 'failed' || state === 'cancelled';
      });
      if (allTerminal) {
        completed = true;
        resolveComplete();
      }
    },
    arm() {
      if (startedAt !== null) return;
      startedAt = Date.now();
      deadlineAt = startedAt + MCP_PREWARM_GRACE_MS;
    },
    fail(error) {
      if (completed) return;
      failure = error;
      completed = true;
      resolveComplete();
    },
    async wait() {
      if (expected.size > 0 && deadlineAt === null) {
        throw new Error('Managed Codex MCP startup barrier was not armed at thread startup');
      }
      let timedOut = false;
      if (!completed) {
        const remainingMs = deadlineAt! - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
        } else {
          const settled = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), remainingMs);
            void complete.then(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          timedOut = !settled;
        }
      }
      if (failure) throw failure;
      return snapshot(timedOut);
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values);
  return `{${entries.map(([key, value]) => `${tomlKey(key)}=${tomlString(value)}`).join(',')}}`;
}

function codexMcpServerName(id: string): string | null {
  const normalized = id.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || null;
}

function codexMcpEnvVarName(serverName: string, key: string): string {
  const safeServer = serverName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const safeKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `MYAGENTS_MCP_${safeServer}_${safeKey}`.slice(0, 180);
}

function uniqueCodexMcpEnvVarName(
  serverName: string,
  key: string,
  used: Set<string>,
): string {
  const base = codexMcpEnvVarName(serverName, key);
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `_${i}`;
    candidate = `${base.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function hasCodexMcpTemplate(value: string): boolean {
  return CODEX_MCP_TEMPLATE_RE.test(value);
}

function resolveMcpTemplateValue(
  value: string,
  env: Record<string, string> | undefined,
): string | null {
  let missing = false;
  const resolved = value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, key: string) => {
    const replacement = env?.[key];
    if (replacement === undefined) {
      missing = true;
      return '';
    }
    return replacement;
  });
  return missing ? null : resolved;
}

function unsafeCodexMcpStdioValueReason(value: string): string | null {
  if (hasCodexMcpTemplate(value)) return 'contains MyAgents env placeholder';
  if (CODEX_MCP_SECRET_VALUE_RE.test(value)) return 'contains inline secret-looking value';
  if (/bearer\s+\S+/i.test(value)) return 'contains inline bearer token';
  if (CODEX_MCP_INLINE_SECRET_RE.test(value)) return 'contains inline credential assignment';
  return null;
}

function unsafeCodexMcpStdioArgsReason(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const valueReason = unsafeCodexMcpStdioValueReason(arg);
    if (valueReason) return `arg[${i}] ${valueReason}`;
    if (CODEX_MCP_SENSITIVE_FLAG_RE.test(arg.trim())) {
      return `arg[${i}] uses a credential flag`;
    }
    const previous = args[i - 1]?.trim();
    if (previous && CODEX_MCP_SENSITIVE_FLAG_RE.test(previous)) {
      return `arg[${i}] follows a credential flag`;
    }
  }
  return null;
}

function unsafeCodexMcpUrlReason(rawUrl: string): string | null {
  if (hasCodexMcpTemplate(rawUrl)) return 'contains MyAgents env placeholder';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.username || parsed.password) return 'contains URL userinfo';
  if (parsed.search || parsed.hash) {
    return 'contains query string or fragment that would enter argv';
  }
  if (CODEX_MCP_SECRET_VALUE_RE.test(parsed.pathname)) {
    return 'contains secret-looking path segment';
  }
  return null;
}

function canExposeMcpEnvKeyToCodexParent(key: string): boolean {
  if (!CODEX_MCP_ENV_NAME_RE.test(key)) return false;
  const upper = key.toUpperCase();
  if (upper.startsWith('CODEX_') || upper.startsWith('OPENAI_')) return false;
  if (CODEX_MCP_PARENT_ENV_DENY.has(upper)) return false;
  if ((CODEX_MCP_PROXY_ENV_KEYS as readonly string[]).some(proxyKey => proxyKey.toUpperCase() === upper)) {
    return false;
  }
  return true;
}

function pushCodexConfigArg(target: string[], key: string, valueToml: string): void {
  target.push('-c', `${key}=${valueToml}`);
}

export function resolveCodexSkillExtraRoots(workspacePath: string): string[] {
  const projectSkillsDir = join(workspacePath, '.claude', 'skills');
  try {
    if (!existsSync(projectSkillsDir)) return [];
    if (!statSync(projectSkillsDir).isDirectory()) return [];
    return [projectSkillsDir];
  } catch {
    return [];
  }
}

export async function configureCodexSkillExtraRoots(
  rpc: Pick<JsonRpcClient, 'call'>,
  workspacePath: string,
  timeoutMs = 5_000,
): Promise<string[]> {
  const extraRoots = resolveCodexSkillExtraRoots(workspacePath);
  if (extraRoots.length === 0) return [];

  try {
    await rpc.call('skills/extraRoots/set', { extraRoots }, timeoutMs);
    console.log(`[codex] skills extra roots injected: ${extraRoots.join(',')}`);
    return extraRoots;
  } catch (err) {
    console.warn(
      '[codex] skills extra roots injection failed; continuing without .claude/skills:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function buildManagedCodexMcpConfigArgs(
  servers: readonly McpServerDefinition[] | undefined,
  codexEnv: Record<string, string | undefined>,
): { args: string[]; serverNames: string[] } {
  if (!servers || servers.length === 0) return { args: [], serverNames: [] };

  const args: string[] = [];
  const usedNames = new Set<string>();
  const usedGeneratedEnvNames = new Set<string>();
  let skipped = 0;

  codexEnv.NO_PROXY = CODEX_MCP_NO_PROXY_VAL;
  codexEnv.no_proxy = CODEX_MCP_NO_PROXY_VAL;

  for (const server of servers) {
    const name = codexMcpServerName(server.id);
    if (!name || usedNames.has(name)) {
      skipped += 1;
      console.warn(`[codex] managed MCP skipped id=${server.id}: invalid or duplicate Codex MCP server name`);
      continue;
    }

    if (server.type === 'stdio') {
      let command = server.command;
      if (command === '__builtin__') {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: SDK in-process MCP cannot be passed to Codex app-server`);
        continue;
      }
      if (command === '__bundled_cuse__') {
        command = getBundledCusePath() ?? undefined;
        if (!command) {
          skipped += 1;
          console.warn(`[codex] managed MCP ${server.id} skipped: bundled cuse binary not found`);
          continue;
        }
      }
      if (!command) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: missing stdio command`);
        continue;
      }
      let stdioArgs = Array.isArray(server.args) ? [...server.args] : [];
      if (command === 'npx') {
        const invocation = resolveNpxMcpInvocation(stdioArgs, {
          pinPresetPackages: server.isBuiltin === true,
        });
        command = invocation.command;
        stdioArgs = invocation.args;
        console.log(`[codex] managed MCP ${server.id}: resolved npx via ${invocation.source} (${command})`);
      }
      const commandReason = unsafeCodexMcpStdioValueReason(command);
      if (commandReason) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: stdio command ${commandReason}`);
        continue;
      }
      const argsReason = unsafeCodexMcpStdioArgsReason(stdioArgs);
      if (argsReason) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: stdio args unsafe for Codex argv (${argsReason})`);
        continue;
      }

      const serverEnv = Object.entries(server.env ?? {});
      const unsafeEnvKeys = serverEnv
        .map(([key]) => key)
        .filter(key => !canExposeMcpEnvKeyToCodexParent(key));
      if (unsafeEnvKeys.length > 0) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: env keys cannot be exposed to Codex parent process (${unsafeEnvKeys.join(', ')})`);
        continue;
      }

      usedNames.add(name);
      pushCodexConfigArg(args, `mcp_servers.${name}.command`, tomlString(command));
      pushCodexConfigArg(args, `mcp_servers.${name}.args`, tomlArray(stdioArgs));

      const envVars = new Set<string>();
      for (const key of CODEX_MCP_PROXY_ENV_KEYS) {
        if (codexEnv[key]) envVars.add(key);
      }
      envVars.add('NO_PROXY');
      envVars.add('no_proxy');
      for (const [key, value] of serverEnv) {
        if (!key || value === undefined) continue;
        codexEnv[key] = value;
        envVars.add(key);
      }
      pushCodexConfigArg(args, `mcp_servers.${name}.env_vars`, tomlArray([...envVars].sort()));
      pushCodexConfigArg(
        args,
        `mcp_servers.${name}.startup_timeout_sec`,
        String(MCP_PREWARM_GRACE_MS / 1_000),
      );
      continue;
    }

    if (server.type === 'http') {
      if (!server.url) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: missing HTTP MCP URL`);
        continue;
      }
      const urlReason = unsafeCodexMcpUrlReason(server.url);
      if (urlReason) {
        skipped += 1;
        console.warn(`[codex] managed MCP ${server.id} skipped: HTTP MCP URL unsafe for Codex argv (${urlReason})`);
        continue;
      }

      const envHeaderMap: Record<string, string> = {};
      const pendingHeaderEnv: Record<string, string> = {};
      let headerConfigInvalid = false;
      if (server.headers && Object.keys(server.headers).length > 0) {
        for (const [header, value] of Object.entries(server.headers)) {
          if (!header || value === undefined) continue;
          const resolvedHeaderValue = resolveMcpTemplateValue(value, server.env);
          if (resolvedHeaderValue === null) {
            skipped += 1;
            console.warn(`[codex] managed MCP ${server.id} skipped: HTTP header ${header} references missing env placeholder`);
            headerConfigInvalid = true;
            break;
          }
          const envName = uniqueCodexMcpEnvVarName(name, header, usedGeneratedEnvNames);
          pendingHeaderEnv[envName] = resolvedHeaderValue;
          envHeaderMap[header] = envName;
        }
      }
      if (headerConfigInvalid) continue;

      usedNames.add(name);
      Object.assign(codexEnv, pendingHeaderEnv);
      pushCodexConfigArg(args, `mcp_servers.${name}.url`, tomlString(server.url));
      if (Object.keys(envHeaderMap).length > 0) {
        pushCodexConfigArg(args, `mcp_servers.${name}.env_http_headers`, tomlInlineStringMap(envHeaderMap));
      }
      pushCodexConfigArg(
        args,
        `mcp_servers.${name}.startup_timeout_sec`,
        String(MCP_PREWARM_GRACE_MS / 1_000),
      );
      continue;
    }

    skipped += 1;
    console.warn(`[codex] managed MCP ${server.id} skipped: Codex app-server does not support MyAgents MCP type ${server.type}`);
  }

  if (args.length > 0 || skipped > 0) {
    console.log(`[codex] managed MCP startup config: injected=${usedNames.size} skipped=${skipped}`);
  }
  return { args, serverNames: [...usedNames] };
}

export function buildCodexAppServerLaunchConfig(args: {
  commandPath: string;
  runtimeSource: RuntimeSource;
  codexEnv: Record<string, string | undefined>;
  mcpServers?: readonly McpServerDefinition[];
}): { args: string[]; mcpServerNames: string[]; modelProvider?: string } {
  const codexArgs = [
    args.commandPath,
    '-c', CODEX_PROJECT_DOC_FALLBACK_CONFIG,
  ];
  let mcpServerNames: string[] = [];
  let modelProvider: string | undefined;
  if (args.runtimeSource === 'managed-provider') {
    codexArgs.push('-c', CODEX_FILE_AUTH_CONFIG);
    modelProvider = MANAGED_CODEX_HTTP_PROVIDER_ID;
    pushCodexConfigArg(codexArgs, 'model_provider', tomlString(modelProvider));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.name`, tomlString('OpenAI'));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.wire_api`, tomlString('responses'));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.requires_openai_auth`, 'true');
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.supports_websockets`, 'false');
    const mcpConfig = buildManagedCodexMcpConfigArgs(args.mcpServers, args.codexEnv);
    codexArgs.push(...mcpConfig.args);
    mcpServerNames = mcpConfig.serverNames;
  }
  codexArgs.push('app-server');
  return { args: codexArgs, mcpServerNames, modelProvider };
}

export function resolveCodexThreadModelProvider(
  launchModelProvider: string | undefined,
  resumeSessionId: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!launchModelProvider) return undefined;
  if (!resumeSessionId || model?.trim()) return launchModelProvider;

  // A legacy thread can carry a different persisted model/provider pair. When
  // MyAgents has no authoritative model snapshot, let Codex restore that pair
  // together instead of overriding only its provider and resetting the model.
  return undefined;
}

export function buildCodexAppServerArgs(args: {
  commandPath: string;
  runtimeSource: RuntimeSource;
  codexEnv: Record<string, string | undefined>;
  mcpServers?: readonly McpServerDefinition[];
}): string[] {
  return buildCodexAppServerLaunchConfig(args).args;
}

export const KNOWN_CODEX_SERVER_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
] as const);

type KnownCodexServerRequestMethod = (typeof KNOWN_CODEX_SERVER_REQUEST_METHODS)[number];
type JsonRpcRequestId = number | string;

export type PendingCodexRequest =
  | { kind: 'command_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'file_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'tool_user_input'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'mcp_elicitation'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'permissions_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> };

type CodexResponseAction =
  | { type: 'result'; result: unknown }
  | { type: 'error'; code: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function codexUserMessageClientId(item: Record<string, unknown>): string | undefined {
  return stringValue(item.clientId)
    ?? stringValue(item.client_id)
    ?? stringValue(item.clientUserMessageId)
    ?? stringValue(item.client_user_message_id);
}

function codexTraceId(params: Record<string, unknown>, fallbackItemId?: string, suffix?: string): string | undefined {
  const itemId = stringValue(params.itemId) ?? fallbackItemId;
  if (!itemId) return undefined;
  const threadId = stringValue(params.threadId);
  return [threadId, itemId, suffix].filter((part): part is string => !!part).join('::');
}

export function buildCodexFileChangeResultContent(changes: unknown): string {
  const normalized = coerceFileChanges(changes);
  return normalized.length > 0
    ? normalized.map(formatFileChangeForResult).join('\n\n')
    : 'File changed';
}

export function buildCodexStartedFileChangeInput(
  changes: unknown,
  cwd?: string,
): Record<string, unknown> | undefined {
  const firstChange = Array.isArray(changes) ? changes[0] : undefined;
  const firstPath = firstChange
    && typeof firstChange === 'object'
    && !Array.isArray(firstChange)
    && typeof (firstChange as { path?: unknown }).path === 'string'
    ? (firstChange as { path: string }).path
    : undefined;
  const input: Record<string, unknown> = {
    ...(firstPath ? { file_path: firstPath } : {}),
    ...(cwd ? { cwd } : {}),
  };
  return Object.keys(input).length > 0 ? input : undefined;
}

export function buildCodexCompletedFileChangeInput(
  changes: unknown,
  cwd?: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const normalized = coerceFileChanges(changes);
  if (
    normalized.length !== changes.length
    || normalized.some((change) => !change.path?.trim())
  ) return undefined;
  return {
    file_path: normalized[0].path,
    ...(cwd ? { cwd } : {}),
    changes: normalized,
  };
}

// ─── Temp image directory for Codex (which requires file paths, not base64) ───
const TEMP_IMG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.myagents', 'tmp', 'codex-images',
);

/**
 * Write base64 image to a temp file and return its path.
 * Codex CLI accepts `localImage` input with file paths.
 */
function writeImageToTempFile(img: ResolvedImagePayload): string {
  if (!existsSync(TEMP_IMG_DIR)) {
    ensureDirSync(TEMP_IMG_DIR);
  }
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length === 0) throw new Error('Empty image data');
  const subtype = img.mimeType.split('/')[1]?.split('+')[0] || 'png';  // 'jpeg' from 'image/jpeg', 'svg' from 'image/svg+xml'
  const ext = subtype === 'jpeg' ? 'jpg' : subtype;
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = join(TEMP_IMG_DIR, filename);
  writeFileSync(filepath, buf);
  return filepath;
}

/**
 * Clean up stale temp images older than 1 hour.
 * Called at session start to prevent unbounded directory growth.
 */
function cleanupStaleTempImages(): void {
  try {
    if (!existsSync(TEMP_IMG_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const file of readdirSync(TEMP_IMG_DIR)) {
      const filepath = join(TEMP_IMG_DIR, file);
      try {
        if (statSync(filepath).mtimeMs < cutoff) unlinkSync(filepath);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore cleanup errors */ }
}

/**
 * Build Codex input array with optional images.
 * Images are written to temp files and referenced via `localImage` type.
 */
function buildCodexInput(text: string, images?: ResolvedImagePayload[]): unknown[] {
  const input: unknown[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      const filepath = writeImageToTempFile(img);
      input.push({ type: 'localImage', path: filepath });
    }
  }
  input.push({ type: 'text', text, text_elements: [] });
  return input;
}

export async function initializeCodexRpc(
  rpc: Pick<JsonRpcClient, 'call' | 'notify'>,
  timeoutMs = 10_000,
): Promise<void> {
  await rpc.call('initialize', buildCodexInitializeParams(), timeoutMs);
  rpc.notify('initialized');
}

export function buildCodexSandboxPolicy(
  sandbox: CodexSandboxMode,
  workspacePath: string,
): CodexSandboxPolicy {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [workspacePath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

export function buildCodexTurnStartParams(args: {
  threadId: string;
  input: unknown[];
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  model?: string | null;
  /** #324 — reasoning effort level; falsy = omit (Codex default applies).
   *  Schema: TurnStartParams.effort "Override the reasoning effort for this
   *  turn and subsequent turns" (codex app-server v2). */
  reasoningEffort?: string | null;
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    input: args.input,
    cwd: args.cwd,
    approvalPolicy: args.approvalPolicy,
    sandboxPolicy: buildCodexSandboxPolicy(args.sandbox, args.cwd),
    model: args.model || null,
    summary: 'concise',
    // Omit when default — an explicit null is "no override" per schema, but
    // omitting is the conservative shape older codex builds also accept.
    ...(args.reasoningEffort ? { effort: args.reasoningEffort } : {}),
  };
}

export function buildCodexTurnSteerParams(args: {
  threadId: string;
  input: unknown[];
  expectedTurnId: string;
  clientUserMessageId?: string | null;
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    input: args.input,
    expectedTurnId: args.expectedTurnId,
    ...(args.clientUserMessageId ? { clientUserMessageId: args.clientUserMessageId } : {}),
  };
}

function isKnownCodexServerRequestMethod(method: string): method is KnownCodexServerRequestMethod {
  return (KNOWN_CODEX_SERVER_REQUEST_METHODS as readonly string[]).includes(method);
}

function splitAnswerString(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function shouldDenyCodexStructuredUserInput(proc: {
  runtimeSource?: RuntimeSource;
  scenario: InteractionScenario;
}): boolean {
  return proc.runtimeSource === 'managed-provider' || shouldDisallowAskUserQuestion(proc.scenario);
}

function answerList(value: unknown, opts: { splitComma: boolean }): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  if (opts.splitComma) return splitAnswerString(value);
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function hasAnswerValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => String(entry).trim().length > 0);
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}

function pickAnswer(
  answers: Record<string, unknown>,
  key: string,
  idx: number,
): { value: unknown; provided: boolean } {
  if (Object.prototype.hasOwnProperty.call(answers, key)) {
    return { value: answers[key], provided: hasAnswerValue(answers[key]) };
  }
  const legacyKey = String(idx);
  if (Object.prototype.hasOwnProperty.call(answers, legacyKey)) {
    return { value: answers[legacyKey], provided: hasAnswerValue(answers[legacyKey]) };
  }
  return { value: undefined, provided: false };
}

function getAnswersFromUpdatedInput(updatedInput?: Record<string, unknown>): Record<string, unknown> {
  return objectValue(updatedInput?.answers);
}

function commandDecisionForMethod(
  method: KnownCodexServerRequestMethod,
  decision: CodexDecision,
  interrupt = false,
): string {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (decision === 'deny') return interrupt ? 'abort' : 'denied';
    return decision === 'always_allow' ? 'approved_for_session' : 'approved';
  }
  if (decision === 'deny') return interrupt ? 'cancel' : 'decline';
  return decision === 'always_allow' ? 'acceptForSession' : 'accept';
}

function buildToolUserInputResponse(
  pending: Extract<PendingCodexRequest, { kind: 'tool_user_input' }>,
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> {
  const answers = getAnswersFromUpdatedInput(updatedInput);
  const questions = arrayValue(pending.params.questions);
  const answerMap: Record<string, { answers: string[] }> = {};
  questions.forEach((q, idx) => {
    const question = objectValue(q);
    const id = stringValue(question.id) || String(idx);
    answerMap[id] = {
      answers: answerList(answers[id] ?? answers[String(idx)], { splitComma: false }),
    };
  });
  return { answers: answerMap };
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((v, idx) => ({
      value: String(v),
      label: String(names[idx] ?? v),
    }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((entry) => objectValue(entry))
      .filter((entry) => typeof entry.const === 'string')
      .map((entry) => ({
        value: String(entry.const),
        label: String(entry.title ?? entry.const),
      }));
  }
  const items = objectValue(schema.items);
  if (Array.isArray(items.enum)) {
    return items.enum.map((v) => ({ value: String(v), label: String(v) }));
  }
  if (Array.isArray(items.anyOf)) {
    return items.anyOf
      .map((entry) => objectValue(entry))
      .filter((entry) => typeof entry.const === 'string')
      .map((entry) => ({
        value: String(entry.const),
        label: String(entry.title ?? entry.const),
      }));
  }
  return [];
}

function answerLabelToEnumValue(schema: Record<string, unknown>, answer: string): string {
  const match = enumOptions(schema).find((opt) => opt.label === answer || opt.value === answer);
  return match?.value ?? answer;
}

function defaultForSchema(schema: Record<string, unknown>): unknown {
  if ('default' in schema) return schema.default;
  return undefined;
}

function coerceMcpAnswer(
  schema: Record<string, unknown>,
  answer: unknown,
): unknown {
  const schemaOptions = enumOptions(schema);
  const selected = schema.type === 'array'
    ? answerList(answer, { splitComma: true })
    : answerList(answer, { splitComma: false });
  if (selected.length === 0) return defaultForSchema(schema);
  switch (schema.type) {
    case 'boolean': {
      const v = selected[0]?.toLowerCase();
      return v === 'true' || v === 'yes' || v === '1' || v === '是';
    }
    case 'integer':
    case 'number': {
      const n = Number(selected[0]);
      return Number.isFinite(n) ? n : defaultForSchema(schema);
    }
    case 'array':
      return selected.map((v) => answerLabelToEnumValue(schema, v));
    default:
      return schemaOptions.length > 0
        ? answerLabelToEnumValue(schema, selected[0] ?? '')
        : selected[0] ?? defaultForSchema(schema);
  }
}

function buildMcpElicitationContent(
  params: Record<string, unknown>,
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (params.mode !== 'form' && params.mode !== 'openai/form') return null;
  const requestedSchema = objectValue(params.requestedSchema);
  const properties = objectValue(requestedSchema.properties);
  const required = new Set(arrayValue(requestedSchema.required).filter((v): v is string => typeof v === 'string'));
  const answers = getAnswersFromUpdatedInput(updatedInput);
  const content: Record<string, unknown> = {};
  Object.entries(properties).forEach(([key, schemaValue], idx) => {
    const schema = objectValue(schemaValue);
    const picked = pickAnswer(answers, key, idx);
    if (!picked.provided) {
      if ('default' in schema) {
        content[key] = schema.default;
      }
      return;
    }
    const value = coerceMcpAnswer(schema, picked.value);
    if (value !== undefined) {
      content[key] = value;
    }
  });
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(content, key)) return null;
  }
  return content;
}

function buildGrantedPermissionProfile(params: Record<string, unknown>): Record<string, unknown> {
  const requested = objectValue(params.permissions);
  const granted: Record<string, unknown> = {};
  if (requested.network != null) granted.network = requested.network;
  if (requested.fileSystem != null) granted.fileSystem = requested.fileSystem;
  return granted;
}

export function serializeCodexPermissionResponse(
  pending: PendingCodexRequest,
  decision: CodexDecision,
  updatedInput?: Record<string, unknown>,
  interrupt = false,
): CodexResponseAction {
  switch (pending.kind) {
    case 'command_approval':
    case 'file_approval':
      return {
        type: 'result',
        result: {
          decision: commandDecisionForMethod(pending.method, decision, interrupt),
        },
      };
    case 'tool_user_input':
      if (decision === 'deny') {
        return { type: 'result', result: { answers: {} } };
      }
      return {
        type: 'result',
        result: buildToolUserInputResponse(pending, updatedInput),
      };
    case 'mcp_elicitation': {
      if (decision === 'deny') {
        return {
          type: 'result',
          result: {
            action: interrupt ? 'cancel' : 'decline',
            content: null,
            _meta: null,
          },
        };
      }
      const content = buildMcpElicitationContent(pending.params, updatedInput);
      if ((pending.params.mode === 'form' || pending.params.mode === 'openai/form') && content === null) {
        return {
          type: 'error',
          code: -32000,
          message: 'Missing required MCP elicitation answers',
        };
      }
      return {
        type: 'result',
        result: {
          action: 'accept',
          content,
          _meta: null,
        },
      };
    }
    case 'permissions_approval':
      if (decision === 'deny') {
        return {
          type: 'error',
          code: -32000,
          message: 'User denied Codex permission request',
        };
      }
      return {
        type: 'result',
        result: {
          permissions: buildGrantedPermissionProfile(pending.params),
          scope: decision === 'always_allow' ? 'session' : 'turn',
        },
      };
  }
}

function toolRequestUserInputToAskUserQuestion(params: Record<string, unknown>): Record<string, unknown> {
  const questions = arrayValue(params.questions).map((raw, idx) => {
    const q = objectValue(raw);
    const options = arrayValue(q.options).map((rawOpt) => {
      if (typeof rawOpt === 'string') {
        return { label: rawOpt, description: '' };
      }
      const opt = objectValue(rawOpt);
      return {
        label: String(opt.label ?? ''),
        description: String(opt.description ?? ''),
      };
    }).filter((opt) => opt.label || opt.description);
    return {
      id: stringValue(q.id) || String(idx),
      header: stringValue(q.header) || `Question ${idx + 1}`,
      question: stringValue(q.question) || '',
      options,
      multiSelect: q.multiSelect === true,
      required: q.required === false || q.optional === true ? false : true,
      isSecret: q.isSecret === true,
    };
  });
  return { questions, metadata: { source: 'codex_tool_request_user_input' } };
}

function mcpElicitationToAskUserQuestion(params: Record<string, unknown>): Record<string, unknown> {
  const schema = objectValue(params.requestedSchema);
  const properties = objectValue(schema.properties);
  const required = new Set(arrayValue(schema.required).filter((v): v is string => typeof v === 'string'));
  const questions = Object.entries(properties).map(([key, schemaValue]) => {
    const prop = objectValue(schemaValue);
    const options = prop.type === 'boolean'
      ? [
          { label: 'true', description: '是' },
          { label: 'false', description: '否' },
        ]
      : enumOptions(prop).map((opt) => ({ label: opt.label, description: opt.value }));
    return {
      id: key,
      header: stringValue(prop.title) || key,
      question: stringValue(prop.description) || stringValue(params.message) || key,
      options,
      multiSelect: prop.type === 'array',
      required: required.has(key),
      isSecret: prop.format === 'password' || prop.writeOnly === true,
    };
  });
  return {
    questions,
    metadata: { source: 'codex_mcp_elicitation', serverName: params.serverName },
  };
}

function isCodexMcpApprovalElicitation(params: Record<string, unknown>): boolean {
  const meta = objectValue(params._meta);
  return meta.codex_approval_kind === 'mcp_tool_call'
    || meta.codexApprovalKind === 'mcp_tool_call';
}

function resolvedServerRequestId(params: Record<string, unknown>): string | null {
  const candidates = [
    params.requestId,
    params.serverRequestId,
    params.rpcId,
    params.id,
    objectValue(params.request).id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate);
    }
  }
  return null;
}

// ─── Sub-agent (collab-agent) thread correlation ───
//
// Codex sub-agents are SEPARATE threads multiplexed over the one app-server
// stdio connection; every item/started + item/completed notification carries a
// top-level `threadId`. A spawnAgent `collabAgentToolCall` links a parent thread
// to its child thread(s) via `receiverThreadIds`. We use these to nest a
// sub-agent's tool calls under the spawn card that created it — mirroring how the
// builtin SDK nests `parent_tool_use_id` tools under the `Task` card.

/**
 * Resolve a Codex thread to the TOP-LEVEL `spawnAgent` card it should nest under.
 *
 * A sub-agent can itself spawn deeper sub-agents (`thread_spawn.depth > 0`). The
 * renderer nests ONE level only (a spawn card holds a flat list of descendant
 * tools), so every descendant tool is attributed to its first-level ancestor
 * spawn card. We walk the `parent_thread_id` chain to the root and return the
 * card of the highest ancestor thread that has one.
 *
 * @param threadId        the thread that emitted the item
 * @param threadToCard    child threadId → spawnAgent collabAgentToolCall id (from receiverThreadIds)
 * @param threadToParent  child threadId → its immediate parent thread id (from thread/started subagent source)
 * @returns the spawn card id to nest under, or null when threadId maps to no
 *          spawn card (main-thread tools, or unknown thread → render flat).
 */
export function resolveTopLevelSpawnCard(
  threadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
): string | null {
  const visited = new Set<string>();
  let current: string | undefined = threadId;
  let topCard: string | null = null;
  while (current && !visited.has(current)) {
    visited.add(current);
    const card = threadToCard.get(current);
    if (card) topCard = card; // keep the highest-ancestor card seen so far
    current = threadToParent.get(current);
  }
  return topCard;
}

/**
 * Notification methods that drive the MAIN MyAgents session and carry a
 * top-level `threadId`. When such an event comes from a spawned sub-agent
 * thread it must be ignored (see the guard in parseNotification). Two reasons a
 * method belongs here:
 *   - LIFECYCLE (turn/*, thread/status|closed): a child's turn/completed would
 *     finalize the user's turn early + resetTurnAccumulators() mid-fan-out.
 *     A child's turn/plan/updated would also overwrite the main AgentStatusPanel
 *     todo snapshot.
 *   - USAGE (thread/tokenUsage/updated): a child's token usage would otherwise
 *     flow through as a `usage` event and pollute the MAIN session's context
 *     indicator + persisted lastContextUsage (external-session attributes every
 *     `usage` event to the main turn). Codex sends { threadId, turnId, tokenUsage }.
 * Item notifications are deliberately excluded — those are the sub-agent tools we
 * want to surface/nest.
 */
const CHILD_GATED_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'thread/status/changed',
  'thread/closed',
  'thread/tokenUsage/updated',
]);
export function isChildThreadGatedMethod(method: string): boolean {
  return CHILD_GATED_METHODS.has(method);
}

/**
 * Extract `{ parentThreadId, nickname, role }` from a Codex Thread's `source`
 * when it is a sub-agent thread-spawn, else null. Best-effort: Codex 0.135.0
 * does NOT emit `thread/started` for spawned children on the app-server
 * connection (verified live), so this currently only fires on future/other
 * Codex versions that do — the primary card↔child link is the spawnAgent
 * `receiverThreadIds` (populated at item/completed). Tolerant of BOTH the v2
 * app-server casing (`subagent`) and the legacy root-schema casing (`subAgent`),
 * plus the snake_case spawn fields (ts-rs emits Rust names verbatim).
 */
export function parseSubAgentThreadSource(thread: unknown): {
  parentThreadId: string;
  nickname?: string;
  role?: string;
} | null {
  if (!isRecord(thread)) return null;
  const source = thread.source;
  if (!isRecord(source)) return null;
  const subagent = isRecord(source.subagent) ? source.subagent : (isRecord(source.subAgent) ? source.subAgent : undefined);
  if (!isRecord(subagent)) return null;
  const spawn = subagent.thread_spawn;
  if (!isRecord(spawn)) return null;
  const parentThreadId = stringValue(spawn.parent_thread_id);
  if (!parentThreadId) return null;
  return {
    parentThreadId,
    // Prefer the spawn-source names; fall back to the Thread-level fields.
    nickname: stringValue(spawn.agent_nickname) ?? stringValue(thread.agentNickname),
    role: stringValue(spawn.agent_role) ?? stringValue(thread.agentRole),
  };
}

/**
 * Record `spawnAgent` child threads → this spawn card id. ONLY `spawnAgent`
 * creates the parent/child relationship; `wait`/`closeAgent`/`sendInput`
 * reference existing children and must NOT remap them (that would re-parent a
 * sub-agent's tools under the wait card). Idempotent.
 */
export function recordSpawnAgentChildThreads(
  proc: { subThreadToCard: Map<string, string> },
  tool: string | undefined,
  cardId: string,
  receiverThreadIds: string[] | undefined,
): void {
  if (tool !== 'spawnAgent' || !Array.isArray(receiverThreadIds)) return;
  for (const childId of receiverThreadIds) {
    if (typeof childId === 'string' && childId) {
      proc.subThreadToCard.set(childId, cardId);
    }
  }
}

/**
 * Decide the sub-agent scope for an item notification's tool events from its
 * `threadId`. Returns null for main-thread items and for threads that map to no
 * spawn card (→ render flat). Pure — the single tagging decision, unit-tested.
 */
export function computeSubAgentScope(
  itemThreadId: string | undefined,
  mainThreadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
  threadMeta: ReadonlyMap<string, { nickname?: string; role?: string }>,
): SubAgentScope | null {
  if (!itemThreadId || itemThreadId === mainThreadId) return null;
  const parentToolUseId = resolveTopLevelSpawnCard(itemThreadId, threadToCard, threadToParent);
  if (!parentToolUseId) return null;
  const meta = threadMeta.get(itemThreadId);
  return { parentToolUseId, nickname: meta?.nickname, role: meta?.role };
}

/**
 * Resolve non-spawn collab-agent control actions (`wait`, `sendInput`,
 * `closeAgent`, future control tools) to the spawn card(s) they operate on.
 *
 * These actions are emitted on the MAIN thread, so thread-based scoping returns
 * null. Their `receiverThreadIds` are references to already-spawned child
 * threads; use those references to nest the control action inside the existing
 * spawn trace instead of rendering a second top-level CollabAgent card.
 */
export function resolveCollabAgentControlParents(
  tool: string | undefined,
  receiverThreadIds: string[] | undefined,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
): string[] {
  if (!tool || tool === 'spawnAgent' || !Array.isArray(receiverThreadIds)) return [];

  const parents: string[] = [];
  const seen = new Set<string>();
  for (const receiverThreadId of receiverThreadIds) {
    if (typeof receiverThreadId !== 'string' || !receiverThreadId) continue;
    const parentToolUseId = resolveTopLevelSpawnCard(receiverThreadId, threadToCard, threadToParent);
    if (!parentToolUseId || seen.has(parentToolUseId)) continue;
    seen.add(parentToolUseId);
    parents.push(parentToolUseId);
  }
  return parents;
}

export function subagentControlToolUseId(toolUseId: string, parentToolUseId: string): string {
  return `${toolUseId}::subagent-control::${parentToolUseId}`;
}

type CollabAgentItemLike = {
  id: string;
  tool?: string;
  status?: string;
  prompt?: string;
  model?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
};

function isCollabAgentError(item: CollabAgentItemLike): boolean {
  return item.status === 'failed';
}

function buildCollabAgentInput(item: CollabAgentItemLike): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  if (item.tool) input.tool = item.tool;
  if (item.status) input.status = item.status;
  if (item.prompt) input.prompt = item.prompt;
  if (item.model) input.model = item.model;
  if (item.senderThreadId) input.senderThreadId = item.senderThreadId;
  if (Array.isArray(item.receiverThreadIds)) input.receiverThreadIds = item.receiverThreadIds;
  return Object.keys(input).length > 0 ? input : undefined;
}

function buildCollabAgentResultContent(item: CollabAgentItemLike): string {
  const parts: string[] = [];
  if (item.tool) parts.push(`Tool: ${item.tool}`);
  if (item.status) parts.push(`Status: ${item.status}`);
  if (item.prompt) parts.push(`Prompt: ${item.prompt}`);
  if (item.model) parts.push(`Model: ${item.model}`);
  if (item.senderThreadId) parts.push(`From: ${item.senderThreadId}`);
  if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0) {
    parts.push(`To: ${item.receiverThreadIds.join(', ')}`);
  }
  return parts.join('\n') || 'Collab agent invoked';
}

export function buildCollabAgentControlStartEvents(
  item: CollabAgentItemLike,
  parentToolUseIds: readonly string[],
): UnifiedEvent[] {
  if (item.tool === 'spawnAgent' || parentToolUseIds.length === 0) return [];
  const input = buildCollabAgentInput(item);
  return parentToolUseIds.map((parentToolUseId) => ({
    kind: 'tool_use_start' as const,
    toolUseId: subagentControlToolUseId(item.id, parentToolUseId),
    toolName: 'CollabAgent',
    input,
    subAgent: { parentToolUseId },
  }));
}

export function buildCollabAgentControlCompletedEvents(
  item: CollabAgentItemLike,
  parentToolUseIds: readonly string[],
  options: { includeStart?: boolean } = {},
): UnifiedEvent[] {
  const input = buildCollabAgentInput(item);
  const content = buildCollabAgentResultContent(item);
  const isError = isCollabAgentError(item) ? true : undefined;
  if (item.tool === 'spawnAgent' || parentToolUseIds.length === 0) {
    return [
      { kind: 'tool_use_start', toolUseId: item.id, toolName: 'CollabAgent', input },
      { kind: 'tool_use_stop', toolUseId: item.id },
      { kind: 'tool_result', toolUseId: item.id, content, isError },
    ];
  }

  const includeStart = options.includeStart ?? true;
  return parentToolUseIds.flatMap((parentToolUseId) => {
    const toolUseId = subagentControlToolUseId(item.id, parentToolUseId);
    const subAgent: SubAgentScope = { parentToolUseId };
    return [
      ...(includeStart ? [{ kind: 'tool_use_start' as const, toolUseId, toolName: 'CollabAgent', input, subAgent }] : []),
      { kind: 'tool_use_stop' as const, toolUseId, subAgent },
      { kind: 'tool_result' as const, toolUseId, content, subAgent, isError },
    ];
  });
}

export function resolveCollabControlCompletionRoute(
  latchedParents: readonly string[] | undefined,
  resolvedParents: readonly string[],
): { parentToolUseIds: string[]; includeStart: boolean } {
  if (latchedParents && latchedParents.length > 0) {
    return { parentToolUseIds: [...latchedParents], includeStart: false };
  }
  return { parentToolUseIds: [...resolvedParents], includeStart: true };
}

/** UnifiedEvent kinds eligible for sub-agent scoping. */
function isSubAgentScopedEvent(
  event: UnifiedEvent,
): event is Extract<UnifiedEvent, { subAgent?: SubAgentScope }> {
  return event.kind === 'text_delta'
    || event.kind === 'text_stop'
    || event.kind === 'thinking_start'
    || event.kind === 'thinking_delta'
    || event.kind === 'thinking_stop'
    || event.kind === 'tool_use_start'
    || event.kind === 'tool_input_delta'
    || event.kind === 'tool_use_stop'
    || event.kind === 'tool_result_delta'
    || event.kind === 'tool_result';
}

// ─── Model cache ───

const modelCache = new Map<string, { models: RuntimeModelInfo[]; timestamp: number }>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function codexModelCacheKey(runtimeSource: RuntimeSource, context: CodexCommandContext): string {
  if (runtimeSource === 'managed-provider') {
    return `${runtimeSource}:${context.version ?? 'unknown'}:${context.commandPath}`;
  }
  return runtimeSource;
}

// ─── JSON-RPC 2.0 Client ───

/**
 * Lightweight JSON-RPC 2.0 client for Codex app-server.
 *
 * Handles three message types:
 * - Client → Server Requests (call): send request, await response by matching id
 * - Server → Client Notifications (no id): dispatched via onNotification callback
 * - Server → Client Requests (with id): dispatched via onServerRequest, client must respond
 */
export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest: ((id: JsonRpcRequestId, method: string, params: unknown) => void) | null = null;
  private encoder = new TextEncoder();
  private sink: SubprocessStdin;
  private reading = false;

  constructor(
    private proc: Subprocess,
  ) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('stdin not available');
    this.sink = stdin;
  }

  /** Register notification handler (server → client, no id) */
  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.onNotification = handler;
  }

  /** Register server-request handler (server → client, with id, expects response) */
  setServerRequestHandler(handler: (id: JsonRpcRequestId, method: string, params: unknown) => void): void {
    this.onServerRequest = handler;
  }

  /** Send a JSON-RPC request and wait for the matching response */
  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.write(msg);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Clear timeout on resolution
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); orig.resolve(r); },
        reject: (e) => { clearTimeout(timer); orig.reject(e); },
      });
    });
  }

  /** Send a JSON-RPC notification (client → server, no id) */
  notify(method: string, params?: unknown): void {
    const msg = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.write(msg);
  }

  /** Send a JSON-RPC response (for server-initiated requests) */
  respond(id: JsonRpcRequestId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Send a JSON-RPC error response */
  respondError(id: JsonRpcRequestId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Start the background reader loop. Must be called once after construction. */
  async startReading(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const stdout = this.proc.stdout;
    if (!stdout) return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (err) {
      // Stream closed or process exited
      if (String(err).includes('cancel') || String(err).includes('closed')) return;
      console.error('[codex-rpc] Reader error:', err);
    } finally {
      reader.releaseLock();
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error('app-server process exited'));
      }
      this.pending.clear();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Non-JSON output, ignore
    }

    // Response to our request (has id + result/error, no method)
    if ('id' in msg && !('method' in msg)) {
      const id = msg.id as number;
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { code: number; message: string; data?: { details?: string } };
          // Carry err.data.details into the message so downstream stale-session
          // detection (and humans reading logs) see the actionable diagnostic,
          // not just the generic JSON-RPC "Internal error" wrapper.
          const details = typeof err.data?.details === 'string' ? `: ${err.data.details}` : '';
          handler.reject(new Error(`RPC error ${err.code}: ${err.message}${details}`));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    // Server notification (has method, no id)
    if ('method' in msg && !('id' in msg)) {
      this.onNotification?.(msg.method as string, msg.params);
      return;
    }

    // Server-initiated request (has method AND id)
    if ('method' in msg && 'id' in msg) {
      this.onServerRequest?.(msg.id as JsonRpcRequestId, msg.method as string, msg.params);
      return;
    }
  }

  private write(msg: unknown): void {
    // Fire-and-forget. sink.write() returns a Promise; back-pressure is
    // absorbed by Node's internal buffer. Rejection (e.g. stdin closed)
    // is swallowed — JSON-RPC layer detects liveness via process exit.
    void this.sink.write(this.encoder.encode(JSON.stringify(msg) + '\n')).catch(() => { /* stdin may be closed */ });
  }

  /** Clean up: reject all pending requests */
  destroy(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error('Client destroyed'));
    }
    this.pending.clear();
  }
}

// ─── CodexProcess wrapper ───

class CodexProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  private proc: Subprocess;

  // Codex-specific state
  rpc: JsonRpcClient;
  threadId = '';
  currentTurnId = '';
  agentMessageTextById = new Map<string, string>();
  pendingRequests = new Map<string, PendingCodexRequest>();

  // ── Sub-agent (collab-agent) thread correlation ──
  // Child threadId → the spawnAgent collabAgentToolCall id that created it
  // (from `receiverThreadIds`). The card a sub-agent's tools nest under.
  subThreadToCard = new Map<string, string>();
  // Child threadId → its immediate parent thread id (from thread/started
  // subagent source). Used to walk depth>1 chains up to the top-level card.
  subThreadToParent = new Map<string, string>();
  // Child threadId → { nickname, role } (from thread/started). Decorative labels.
  subThreadMeta = new Map<string, { nickname?: string; role?: string }>();
  // Non-spawn collab control tool id → resolved parent spawn card ids. Started
  // notifications may have receiverThreadIds while completed notifications may
  // omit them (or vice versa), so latch the route for the item lifetime.
  collabControlToolParents = new Map<string, string[]>();

  workspacePath = '';
  scenario: InteractionScenario = { type: 'desktop' };
  runtimeSource: RuntimeSource = 'system-cli';
  model = '';
  approvalPolicy: CodexApprovalPolicy = 'on-request';
  sandbox: CodexSandboxMode = 'workspace-write';
  permissionMode = '';
  defaultPermissionMode = 'full-auto';
  /** #324 — NORMALIZED effort level ('' = Codex default). Carried on every
   *  turn/start (its `effort` overrides "this turn and subsequent turns"),
   *  which is also what makes setReasoningEffort an in-place update. */
  reasoningEffort = '';

  /** MyAgents sessionId (from SessionStartOptions). Used as the attachment scope key
   *  so refPath /api/attachment/tool/<sessionId>/<turnId>/<file> stays consistent
   *  across runtime resumes within the same MyAgents session. */
  sessionId = '';
  // True when the startSession catch-handler killed the process itself (stale
  // resume, init failure, etc.). Suppresses the synthetic "Codex process
  // exited with code 143" session_complete emitted by proc.exited.then — the
  // caller already owns the error surface. Issue #105.
  intentionalKillDuringStartup = false;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
    this.rpc = new JsonRpcClient(proc);
  }

  async writeLine(_line: string): Promise<void> {
    // For Codex, messages go through RPC, not raw stdin.
    // This is kept for interface compliance; actual messaging uses rpc.call().
    throw new Error('Codex uses JSON-RPC, not raw stdin. Use rpc.call() instead.');
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15);
    } catch { /* already dead */ }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  /** Close stdin to signal the process to finish (awaits EOF flush). */
  async closeStdin(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      await stdin.end();
    } catch { /* already closed / EPIPE */ }
  }
}

// ─── Permission mode mapping ───

function mapPermissionMode(mode: string): { approval: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
  switch (mode) {
    case 'suggest':
      return { approval: 'untrusted', sandbox: 'read-only' };
    case 'auto-edit':
      return { approval: 'on-request', sandbox: 'workspace-write' };
    case 'full-auto':
      return { approval: 'never', sandbox: 'workspace-write' };
    case 'no-restrictions':
      return { approval: 'never', sandbox: 'danger-full-access' };
    default:
      return { approval: 'on-request', sandbox: 'workspace-write' };
  }
}

// ─── Stderr error classification (issue #194) ───
//
// Conservative pattern matcher: forwards a small set of high-signal failures
// to the UnifiedEvent log stream so the renderer/IM bus can surface them.
// Anything not matching here still ends up in the unified log via console.error.
//
// Adding patterns: prefer specific phrases over broad terms. A false-positive
// log line in the renderer is annoying; a false-negative just means the user
// sees the unified log instead — same baseline as today.

interface StderrPattern {
  /** Regex tested against the stripped stderr line. */
  re: RegExp;
  /** Mapped severity in the UnifiedEvent. */
  level: 'warn' | 'error';
  /** Human-readable summary prefix shown to the user. */
  prefix: string;
}

const CODEX_STDERR_PATTERNS: StderrPattern[] = [
  // App / MCP discovery transport — direct repro of issue #194.
  { re: /rmcp::transport::worker.*worker quit/i, level: 'error', prefix: 'Codex MCP transport failed' },
  { re: /error sending request for url \(([^)]+)\)/i, level: 'error', prefix: 'Codex HTTP request failed' },
  // App-server lifecycle.
  { re: /app-server process exited/i, level: 'error', prefix: 'Codex app-server exited' },
  // Auth failures — these break tool access silently otherwise.
  { re: /not (signed in|logged in|authenticated)|authentication required|please sign in/i, level: 'error', prefix: 'Codex authentication required' },
  { re: /(401|403)\b.*?(unauthor|forbid)/i, level: 'error', prefix: 'Codex authorization rejected' },
  // Network / proxy diagnostics.
  { re: /proxyconnect tcp: dial tcp 127\.[0-9.]+:\d+: connect: operation not permitted/i, level: 'error', prefix: 'Codex sandbox blocks MyAgents proxy' },
  { re: /(connection (refused|reset)|tls handshake|dns (failure|resolve))/i, level: 'error', prefix: 'Codex network error' },
];

function classifyAndForwardCodexStderr(text: string, onEvent: UnifiedEventCallback): void {
  // Many stderr writes are multi-line. Process each line independently — one
  // matching line should fire one event, not block the rest of the chunk.
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const p of CODEX_STDERR_PATTERNS) {
      const m = trimmed.match(p.re);
      if (!m) continue;
      // Keep the message short — the renderer shows these as toast/log lines.
      // The full stderr line still went to console.error / unified log.
      const detail = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
      onEvent({
        kind: 'log',
        level: p.level,
        message: `[codex] ${p.prefix}: ${detail}`,
      });
      break; // first match wins per line
    }
  }
}

export function mapCodexTurnCompletedNotification(
  turnValue: unknown,
): Extract<UnifiedEvent, { kind: 'turn_complete' }> {
  const turn = objectValue(turnValue);
  const status = stringValue(turn.status) ?? 'completed';
  const error = objectValue(turn.error);
  const errorMessage = stringValue(error.message);

  return {
    kind: 'turn_complete',
    status,
    ...(errorMessage ? { error: errorMessage, result: errorMessage } : {}),
    ...(status !== 'completed' && !errorMessage ? { result: `Turn ended with status ${status}` } : {}),
  };
}

function normalizeCodexPlanStatus(status: unknown): AgentPlanTodo['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    case 'pending':
    default:
      return 'pending';
  }
}

export function mapCodexTurnPlanUpdatedNotification(
  params: unknown,
): Extract<UnifiedEvent, { kind: 'agent_plan_update' }> {
  const p = objectValue(params);
  const todos = arrayValue(p.plan)
    .map((raw, idx): AgentPlanTodo | null => {
      const step = objectValue(raw);
      const content = stringValue(step.step)?.trim();
      if (!content) return null;
      return {
        key: `codex-plan-${idx}`,
        content,
        activeForm: content,
        status: normalizeCodexPlanStatus(step.status),
      };
    })
    .filter((todo): todo is AgentPlanTodo => todo !== null);

  return { kind: 'agent_plan_update', todos };
}

// ─── Diagnostic helpers (issue #194) ───

/**
 * Mask credentials in a proxy URL before exposing to the renderer.
 * `http://user:pass@proxy:7890` → `http://***@proxy:7890`. Falls back to the
 * raw string if parsing fails (better to render an opaque blob than to leak
 * partially-decoded credentials).
 */
function sanitizeProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return url.includes('@') ? '[masked-proxy]' : url;
  }
}

/**
 * Build the sanitized effective-env snapshot for the diagnostic payload.
 * NEVER include secret values — only sanitized URLs and presence-only booleans
 * for sensitive vars. See `RuntimeEffectiveEnv` doc comment for the contract.
 */
function buildEffectiveEnvSnapshot(
  env: Record<string, string | undefined>,
  cwd: string,
  proxyPolicy: RuntimeProxyPolicy = 'myagents',
): RuntimeEffectiveEnv {
  const path = env.PATH || env.Path || '';
  const pathHead = path.split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .slice(0, 5);
  return {
    cwd,
    proxy: {
      http: sanitizeProxyUrl(env.HTTP_PROXY || env.http_proxy),
      https: sanitizeProxyUrl(env.HTTPS_PROXY || env.https_proxy),
      all: sanitizeProxyUrl(env.ALL_PROXY || env.all_proxy),
      no: env.NO_PROXY || env.no_proxy || undefined,
    },
    // Reflects the agent's runtimeConfig.envPolicy.proxy resolved at session
    // start (issue #194). 'myagents' = MyAgents-configured proxy is injected;
    // 'terminal' = inherited from user's interactive shell.
    proxyPolicy,
    pathHead,
    myagentsProxyInjected: env.MYAGENTS_PROXY_INJECTED === '1',
    hasOpenaiApiKey: !!(env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0),
    hasAnthropicApiKey: !!(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0),
    hasCodexHome: !!(env.CODEX_HOME && env.CODEX_HOME.length > 0),
    hasXdgConfigHome: !!(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0),
  };
}

function parseLoopbackProxyTarget(env: Record<string, string | undefined>): { displayUrl: string; host: string; port: number } | null {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const isLoopback = host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.startsWith('127.');
    if (!isLoopback) return null;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      displayUrl: sanitizeProxyUrl(raw) ?? raw,
      host,
      port,
    };
  } catch {
    return null;
  }
}

async function probeCodexLoopbackProxy(
  rpc: JsonRpcClient,
  env: Record<string, string | undefined>,
  cwd: string,
  sandboxPolicy?: CodexSandboxPolicy,
): Promise<RuntimeEffectiveEnv['codexSandbox'] | undefined> {
  const target = parseLoopbackProxyTarget(env);
  if (!target) return undefined;
  const script = `
const net = require('node:net');
const host = process.argv[1];
const port = Number(process.argv[2]);
const result = {
  detected: !!process.env.CODEX_SANDBOX,
  networkDisabled: process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1',
  proxyProbe: { url: process.argv[3], reachable: false }
};
const sock = net.connect({ host, port, timeout: 800 }, () => {
  result.proxyProbe.reachable = true;
  console.log(JSON.stringify(result));
  sock.destroy();
});
sock.on('timeout', () => {
  result.proxyProbe.error = 'timeout';
  console.log(JSON.stringify(result));
  sock.destroy();
});
sock.on('error', (err) => {
  result.proxyProbe.error = err && err.message ? err.message : String(err);
  console.log(JSON.stringify(result));
});
`;
  try {
    const result = await rpc.call('command/exec', {
      command: [process.execPath, '-e', script, target.host, String(target.port), target.displayUrl],
      cwd,
      timeoutMs: 3_000,
      outputBytesCap: 4_096,
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }, 5_000) as { exitCode?: number; stdout?: string; stderr?: string };
    const lines = String(result.stdout ?? '').trim().split('\n').filter(Boolean);
    const parsed = lines.length > 0 ? JSON.parse(lines[lines.length - 1]!) as RuntimeEffectiveEnv['codexSandbox'] : undefined;
    return parsed ?? {
      detected: false,
      proxyProbe: {
        url: target.displayUrl,
        reachable: false,
        error: result.stderr || `probe exited ${result.exitCode ?? 'unknown'}`,
      },
    };
  } catch (err) {
    return {
      detected: false,
      proxyProbe: {
        url: target.displayUrl,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Best-effort RPC fan-out: collect Codex's view of auth / features / MCP
 * servers / apps. Each call has its own 5s timeout and is captured as either
 * `'ok'`, `'unsupported'` (RPC `-32601` Method not found), or `{ error }`.
 *
 * Why parallel + Promise.allSettled: we never block the user's first turn on
 * diagnostics — the call site is fire-and-forget after thread/start has
 * already returned. Each RPC failure is independent and degrades gracefully.
 */
async function collectCodexDiagnostics(
  rpc: JsonRpcClient,
  env: Record<string, string | undefined>,
  cwd: string,
  /**
   * Codex thread id for `app/list` feature gating. `null` for the standalone
   * (CLI-driven) path where no thread has been started — Codex's schema
   * declares this nullable. Earlier code passed `''`, which serde could reject.
   */
  threadId: string | null,
  proxyPolicy: RuntimeProxyPolicy = 'myagents',
  sandboxPolicy?: CodexSandboxPolicy,
  runtimeSource: import('../../shared/types/runtime').RuntimeSource = 'system-cli',
): Promise<RuntimeDiagnostics> {
  const status: RuntimeDiagnosticsStatus = {};
  const issues: RuntimeDiagnosticIssue[] = [];

  // Helper: returns ['ok', value] | ['unsupported'] | ['error', reason]
  type CallResult<T> = ['ok', T] | ['unsupported'] | ['error', string];
  const tryCall = async <T>(method: string, params: unknown): Promise<CallResult<T>> => {
    try {
      const v = await rpc.call(method, params, 5_000) as T;
      return ['ok', v];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // RPC -32601: Method not found → unsupported on this Codex version.
      // We don't want to flag old Codex as broken just because it lacks the
      // newer experimentalFeature/list — render 'unsupported' instead.
      if (/(-32601|Method not (found|supported))/i.test(msg)) return ['unsupported'];
      return ['error', msg.slice(0, 200)];
    }
  };

  // Fire all four in parallel — they're independent.
  const [authR, featuresR, mcpR, appsR] = await Promise.all([
    tryCall<{ authMethod: string | null; authToken?: string | null; requiresOpenaiAuth?: boolean | null }>(
      'getAuthStatus', {}),
    tryCall<{ data: Array<{ name: string; stage: string; enabled: boolean; defaultEnabled: boolean }> }>(
      'experimentalFeature/list', {}),
    tryCall<{ data: CodexMcpServerStatus[] }>(
      'mcpServerStatus/list', {}),
    tryCall<{ data: Array<{ id: string; name?: string; description?: string | null; isAccessible: boolean; isEnabled: boolean; installUrl?: string | null }> }>(
      'app/list', { threadId }),
  ]);

  // Process auth.
  //
  // `requiresOpenaiAuth` is a **meta** flag — it means "this Codex product needs
  // OpenAI-backed auth to work" (true for all current Codex builds backed by
  // ChatGPT/OpenAI). It is NOT a per-user state. A logged-in user with a
  // working ChatGPT account also sees `requiresOpenaiAuth: true`.
  // Live probe of a healthy logged-in user returns:
  //   { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true }
  // The user-state signal is `authMethod`: null ⇒ no credential of any kind
  // (apikey / chatgpt / chatgptAuthTokens / agentIdentity), so the user must
  // sign in. Earlier code derived requiresLogin from `requiresOpenaiAuth`
  // alone, which flagged every authed Codex user as needing login — surfacing
  // a false-positive "需要登录 Codex" banner in MyAgents (cross-bugfix #1).
  let auth: RuntimeAuthStatus | undefined;
  if (authR[0] === 'ok') {
    status.auth = 'ok';
    const hasAuth = !!authR[1].authMethod;
    auth = {
      authMethod: authR[1].authMethod,
      // Treat the meta flag as a gate: even if `authMethod` is null, login is
      // only "required" when the Codex build actually needs OpenAI auth.
      // (Defensive — Codex could ship a build mode where neither is required.)
      requiresLogin: !hasAuth && authR[1].requiresOpenaiAuth === true,
    };
    if (auth.requiresLogin) {
      issues.push({
        code: 'codex_auth_required',
        severity: 'error',
        title: 'Codex requires login',
        message: 'Codex reported no active auth method for this runtime session.',
        hint: runtimeSource === 'managed-provider'
          ? 'Open Settings → Model Providers → Codex (订阅), then log in again.'
          : 'Run `codex login` in a terminal, then retry from MyAgents.',
      });
    }
  } else if (authR[0] === 'unsupported') {
    status.auth = 'unsupported';
  } else {
    status.auth = { error: authR[1] };
    issues.push({
      code: 'codex_auth_status_failed',
      severity: 'warn',
      title: 'Codex auth status failed',
      message: authR[1],
    });
  }

  // Process features — keep only enabled OR user-toggled (defaultEnabled !== enabled).
  // Renderer doesn't need 80 disabled-by-default entries; the actionable signal
  // is "what's actually on right now" + "what the user explicitly chose".
  let features: RuntimeFeatureFlag[] | undefined;
  if (featuresR[0] === 'ok') {
    status.features = 'ok';
    features = featuresR[1].data
      .filter(f => f.enabled || f.defaultEnabled !== f.enabled)
      .map(f => ({
        name: f.name,
        enabled: f.enabled,
        defaultEnabled: f.defaultEnabled,
        stage: f.stage,
      }));
  } else if (featuresR[0] === 'unsupported') {
    status.features = 'unsupported';
  } else {
    status.features = { error: featuresR[1] };
    issues.push({
      code: 'codex_feature_status_failed',
      severity: 'warn',
      title: 'Codex feature status failed',
      message: featuresR[1],
    });
  }

  // Process MCP servers
  let mcpServers: RuntimeMcpServerInfo[] | undefined;
  if (mcpR[0] === 'ok') {
    status.mcpServers = 'ok';
    mcpServers = mcpR[1].data.map(s => {
      // authStatus shape varies — render the stringified status when it's a
      // known marker, otherwise just flag whether MCP is auth'd.
      const authStatusStr = codexMcpAuthStatusText(s.authStatus);
      // Derive `state` from authStatus so the diagnostic banner has a single
      // field to filter on (its existing `state === 'failed'` check would
      // never fire if we only populated authStatus). Known unhealthy markers
      // — explicit failure plus auth-required states the user must act on —
      // surface as 'failed' so the banner highlights them.
      return {
        name: s.name,
        toolCount: Object.keys(s.tools ?? {}).length,
        resourceCount: s.resources?.length ?? 0,
        state: isCodexMcpAuthUnavailable(s.authStatus) ? 'failed' : undefined,
        authStatus: authStatusStr,
      };
    });
  } else if (mcpR[0] === 'unsupported') {
    status.mcpServers = 'unsupported';
  } else {
    status.mcpServers = { error: mcpR[1] };
    issues.push({
      code: 'codex_mcp_status_failed',
      severity: 'warn',
      title: 'Codex MCP status failed',
      message: mcpR[1],
    });
  }

  // Process apps — this is the artifact-tool diagnostic signal.
  let apps: RuntimeAppInfo[] | undefined;
  if (appsR[0] === 'ok') {
    status.apps = 'ok';
    apps = appsR[1].data.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description ?? undefined,
      isAccessible: a.isAccessible,
      isEnabled: a.isEnabled,
      installUrl: a.installUrl ?? null,
    }));
  } else if (appsR[0] === 'unsupported') {
    status.apps = 'unsupported';
  } else {
    status.apps = { error: appsR[1] };
    issues.push({
      code: 'codex_app_status_failed',
      severity: 'warn',
      title: 'Codex app discovery failed',
      message: appsR[1],
    });
  }

  if (mcpServers) {
    const failed = mcpServers.filter((s) => s.state === 'failed');
    if (failed.length > 0) {
      issues.push({
        code: 'codex_mcp_server_failed',
        severity: 'warn',
        title: 'Codex MCP server failed',
        message: `Failed MCP server(s): ${failed.map((s) => s.name).join(', ')}`,
      });
    }
  }

  if (apps) {
    const inaccessible = apps.filter((app) => app.isEnabled && !app.isAccessible);
    if (inaccessible.length > 0) {
      issues.push({
        code: 'codex_app_not_accessible',
        severity: 'warn',
        title: 'Codex app inaccessible',
        message: `Enabled but inaccessible app(s): ${inaccessible.map((app) => app.id).join(', ')}`,
      });
    }
  }

  const effectiveEnv = buildEffectiveEnvSnapshot(env, cwd, proxyPolicy);
  const sandboxProbe = await probeCodexLoopbackProxy(rpc, env, cwd, sandboxPolicy);
  if (sandboxProbe) {
    effectiveEnv.codexSandbox = sandboxProbe;
    const proxyProbe = sandboxProbe.proxyProbe;
    if (proxyProbe && !proxyProbe.reachable && (sandboxProbe.detected || sandboxProbe.networkDisabled)) {
      issues.push({
        code: 'codex_sandbox_blocks_myagents_proxy',
        severity: 'error',
        title: 'Codex sandbox blocks the MyAgents proxy',
        message: `Codex could not connect to loopback proxy ${proxyProbe.url}: ${proxyProbe.error ?? 'unreachable'}`,
        hint: 'Use Codex no-restrictions mode, switch runtime proxy policy to terminal shell behavior, or use a proxy reachable from the Codex sandbox.',
      });
    }
  }

  return {
    runtime: 'codex',
    runtimeSource,
    effectiveEnv,
    auth,
    features,
    mcpServers,
    apps,
    status,
    issues: issues.length > 0 ? issues : undefined,
    timestamp: new Date().toISOString(),
  };
}

// ─── CodexRuntime ───

export class CodexRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'codex';

  async detect(): Promise<RuntimeDetection> {
    try {
      const context = resolveCodexCommandContext({ source: 'system-cli' });
      const command = context.commandPath;
      const proc = spawn([command, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: context.env,
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return {
          installed: true,
          version: text.trim().replace(/^codex-cli\s*/i, ''),
          path: command,
        };
      }
    } catch { /* not installed */ }
    return { installed: false };
  }

  async queryModels(options: { runtimeSource?: RuntimeSource } = {}): Promise<RuntimeModelInfo[]> {
    const runtimeSource = options.runtimeSource ?? 'system-cli';
    let context: CodexCommandContext;
    try {
      context = resolveCodexCommandContext({ source: runtimeSource });
    } catch (err) {
      console.error(`[codex] Failed to resolve model runtime for source=${runtimeSource}:`, err);
      return [];
    }
    const cacheKey = codexModelCacheKey(runtimeSource, context);
    // Return cached if fresh
    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    try {
      const models = await this.queryModelsViaAppServer(runtimeSource, context);
      modelCache.set(cacheKey, { models, timestamp: Date.now() });
      return models;
    } catch (err) {
      console.error(`[codex] Failed to query models for source=${runtimeSource}:`, err);
      // Return cached even if stale, or empty
      return cached?.models ?? [];
    }
  }

  private async queryModelsViaAppServer(
    runtimeSource: RuntimeSource,
    context: CodexCommandContext,
  ): Promise<RuntimeModelInfo[]> {
    // Spawn a temporary app-server to query model/list
    const codexEnv = context.env;
    const proc = spawn(buildCodexAppServerArgs({
      commandPath: context.commandPath,
      runtimeSource,
      codexEnv,
    }), {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      env: codexEnv,
    });

    const rpc = new JsonRpcClient(proc);
    // Start reader in background (awaited in finally block below)
    const readerDone = rpc.startReading();

    try {
      await initializeCodexRpc(rpc, 10_000);

      // Query model list
      const result = await rpc.call('model/list', {}, 10_000) as {
        data: Array<{
          id: string;
          displayName: string;
          description: string;
          hidden: boolean;
          isDefault: boolean;
        }>;
      };

      return result.data
        .filter(m => !m.hidden)
        .map(m => ({
          value: m.id,
          displayName: m.displayName || m.id,
          description: m.description,
          isDefault: m.isDefault,
        }));
    } finally {
      rpc.destroy();
      try { proc.kill(); } catch { /* ignore */ }
      await readerDone.catch(() => {});
    }
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return CODEX_PERMISSION_MODES;
  }

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'next_turn_state',
      permissionMode: 'next_turn_state',
      reasoningEffort: 'next_turn_state',
    };
  }

  /**
   * Standalone diagnostic run (issue #194 — used by `myagents diagnose runtime
   * codex`). Spawns a short-lived `codex app-server`, runs initialize, fans
   * out the four diagnostic RPCs, and tears down. Does NOT start a thread —
   * the three core RPCs (`getAuthStatus`, `experimentalFeature/list`,
   * `mcpServerStatus/list`) don't need one, and `app/list` accepts
   * `threadId: null`. This makes the command cheap (no agent.md scan, no
   * sandbox spawn for tools).
   *
   * Uses the SAME spawn env / envPolicy / cwd as a real session so the
   * snapshot reflects what production Codex would see. Pass `envPolicy` from
   * the same `agent.runtimeConfig.envPolicy` that the real session would
   * resolve — otherwise the diagnostic would silently report the legacy
   * `myagents` proxy view even when the agent is set to `terminal`/`direct`
   * (Codex review #3 catch).
   */
  async runStandaloneDiagnostics(
    workspacePath?: string,
    envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy,
  ): Promise<RuntimeDiagnostics> {
    const context = resolveCodexCommandContext({ source: 'system-cli', envPolicy });
    const env = context.env;
    const cwd = workspacePath || env.HOME || process.cwd();

    const proc = spawn([context.commandPath, 'app-server'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd,
      env,
      // Same detached/windowsHide treatment as the real session spawn —
      // diverging here would mean the diagnostic env didn't match production.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    // Drain stderr to /dev/null so a verbose Codex doesn't block the pipe.
    // Errors land in unified log via the standard sidecar capture; the
    // diagnostic report's `status` covers actionable failures.
    if (proc.stderr) {
      void (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        try { while (true) { const { done } = await reader.read(); if (done) break; } }
        catch { /* ignore */ }
        finally { reader.releaseLock(); }
      })();
    }

    const rpc = new JsonRpcClient(proc);
    const readerDone = rpc.startReading();

    try {
      await initializeCodexRpc(rpc, 10_000);

      // No thread for the standalone path. `app/list` accepts `threadId: null`
      // per Codex's TS schema (AppsListParams.threadId is optional/nullable).
      // The other three RPCs don't take a threadId at all. Pass null explicitly
      // — earlier draft passed '' here which Codex's serde could reject as
      // "not a valid thread id" instead of treating it as absent (Codex
      // review #4 catch).
      return await collectCodexDiagnostics(
        rpc,
        env,
        cwd,
        null,
        envPolicy?.proxy ?? 'myagents',
        buildCodexSandboxPolicy('workspace-write', cwd),
        'system-cli',
      );
    } finally {
      rpc.destroy();
      try { proc.kill(); } catch { /* ignore */ }
      await readerDone.catch(() => {});
    }
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    // Clean up stale temp images from previous sessions
    cleanupStaleTempImages();
    trySyncProjectUserConfigFiles(options.workspacePath, {}, 'codex');

    // Cross-runtime workspace protocol: make Codex natively discover CLAUDE.md
    // when no AGENTS.md is present. The -c flag overrides config.toml at runtime
    // without modifying any external config files. Codex's search order becomes:
    // AGENTS.override.md → AGENTS.md → CLAUDE.md (per directory, first found wins).
    // Capture the env we hand to Codex so the diagnostic snapshot reflects what
    // the subprocess actually saw (issue #194). The env policy is resolved by
    // the session caller from the agent's runtimeConfig.envPolicy.
    const runtimeSource = options.runtimeSource ?? 'system-cli';
    const context = resolveCodexCommandContext({
      source: runtimeSource,
      envPolicy: options.envPolicy,
    });
    const codexEnv = context.env;
    // Issue #194 — pin PWD to workspacePath so any Codex-internal tool that
    // consults `$PWD` (vs. the kernel-level cwd Rust's spawn passes) sees the
    // workspace, not the sidecar's launch directory. Codex review SM finding.
    codexEnv.PWD = options.workspacePath;
    codexEnv.MYAGENTS_SESSION_ID = options.sessionId;
    const launchConfig = buildCodexAppServerLaunchConfig({
      commandPath: context.commandPath,
      runtimeSource,
      codexEnv,
      mcpServers: options.mcpServers,
    });
    const mcpStartup = createCodexMcpStartupBarrier(launchConfig.mcpServerNames);
    console.log(
      `[codex] spawn source=${runtimeSource} version=${context.version ?? 'system-cli'} ` +
      `platform=${context.platform ?? process.platform} codexHome=${context.codexHome ? '<managed>' : '<default>'}`,
    );
    const proc = spawn(launchConfig.args, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd: options.workspacePath,
      env: codexEnv,
      // Detached → child becomes its own process-group leader on POSIX so
      // killWithEscalation({ killTree: true }) below can take down the entire
      // model/tool tree, not just the wrapper.
      //
      // Windows: `detached: true` + stdio:'pipe' breaks parent's stdout reads
      // — the JSON-RPC `initialize` call hangs forever (issue #170 #3). Windows
      // doesn't have process groups; tree-kill uses `taskkill /F /T /PID` which
      // works regardless of detached. `windowsHide: true` suppresses the console
      // window flash from cmd.exe wrapping the codex.cmd shim.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const codexProc = new CodexProcess(proc);
    codexProc.sessionId = options.sessionId;
    codexProc.workspacePath = options.workspacePath;
    codexProc.scenario = options.scenario;
    codexProc.runtimeSource = runtimeSource;

    // Dedup guard: prevent double session_complete from notification + process exit
    let sessionCompleteEmitted = false;
    // Pattern 6: every event delivery is wrapped in an ALS frame stamped
    // with `runtime: 'codex'` so any nested console.* (in onEvent or its
    // downstream handlers) is correlated. Frames are short-lived (one per
    // event) which keeps ALS overhead bounded.
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') {
        if (sessionCompleteEmitted) return; // Already emitted, skip duplicate
        sessionCompleteEmitted = true;
      }
      withLogContext({ runtime: 'codex', runtimeSource }, () => onEvent(event));
    };

    const readyMcpServerNames = new Set<string>();
    let lastMcpToolCatalog: string[] = [];
    let mcpCatalogRevision = 0;
    let mcpCatalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const publishMcpToolCatalog = (tools: string[]): void => {
      if (
        tools.length === lastMcpToolCatalog.length
        && tools.every((tool, index) => tool === lastMcpToolCatalog[index])
      ) return;
      lastMcpToolCatalog = tools;
      wrappedOnEvent({ kind: 'runtime_tool_catalog', tools });
    };
    const emitMcpToolCatalog = (servers: readonly CodexMcpServerStatus[]): void => {
      publishMcpToolCatalog(buildCodexMcpToolCatalog(servers, readyMcpServerNames));
    };
    const scheduleMcpToolCatalogRefresh = (): void => {
      if (!codexProc.threadId || codexProc.exited || mcpCatalogRefreshTimer) return;
      // Startup notifications arrive in a burst. One short coalescing window
      // avoids redundant list calls while keeping discovery off the first-turn path.
      mcpCatalogRefreshTimer = setTimeout(() => {
        mcpCatalogRefreshTimer = null;
        if (codexProc.exited) return;
        const revision = mcpCatalogRevision;
        void listCodexMcpServerStatuses(codexProc.rpc, codexProc.threadId)
          .then((servers) => {
            if (codexProc.exited || revision !== mcpCatalogRevision) return;
            emitMcpToolCatalog(servers);
          })
          .catch((err) => {
            console.warn('[codex] MCP tool catalog refresh failed:', err instanceof Error ? err.message : String(err));
          });
      }, 100);
    };

    // Wire up notification handler to emit UnifiedEvents
    codexProc.rpc.setNotificationHandler((method, params) => {
      const p = params as Record<string, unknown> | undefined;
      if (method === 'mcpServer/startupStatus/updated') {
        const status = params as CodexMcpStartupStatusNotification;
        const belongsToActiveThread = status.threadId === null
          || !codexProc.threadId
          || status.threadId === codexProc.threadId;
        if (belongsToActiveThread) {
          mcpStartup.observe(status);
          if (status.status === 'ready') {
            readyMcpServerNames.add(status.name);
          } else {
            readyMcpServerNames.delete(status.name);
            const prefix = `mcp__${status.name}__`;
            publishMcpToolCatalog(lastMcpToolCatalog.filter(tool => !tool.startsWith(prefix)));
          }
          mcpCatalogRevision += 1;
          scheduleMcpToolCatalogRefresh();
        }
      }
      // Skip noisy notifications from logging: deltas, legacy duplicates, account events
      const isNoisy = method.startsWith('codex/event/') || method.startsWith('account/')
        || method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta'
        || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta';
      if (!isNoisy) {
        let detail = '';
        if (method === 'item/started' || method === 'item/completed') {
          const item = p?.item as Record<string, unknown> | undefined;
          if (item) {
            detail = ` type=${item.type}`;
            if (item.id) detail += ` id=${(item.id as string).slice(0, 12)}`;
            // PRD 0.2.27 — log threadId so sub-agent items are distinguishable
            // from main-thread items in production triage (Codex carries it; we
            // previously dropped it from logs, making this class of issue opaque).
            if (typeof p?.threadId === 'string') detail += ` thread=${p.threadId.slice(0, 12)}`;
            // Tool-specific context
            if (item.type === 'commandExecution' && item.command) detail += ` cmd=${(item.command as string).slice(0, 80)}`;
            if (item.type === 'fileChange' && Array.isArray(item.changes)) {
              const paths = coerceFileChanges(item.changes).map((change) => change.path).filter(Boolean);
              if (paths.length > 0) detail += ` files=${paths.join(',')}`;
            }
            if ((item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') && item.tool) detail += ` tool=${item.tool}`;
            if (item.type === 'agentMessage' && typeof item.text === 'string') detail += ` text=${(item.text as string).length}chars`;
            if (item.type === 'userMessage') {
              const clientId = codexUserMessageClientId(item) ?? codexUserMessageClientId(p ?? {});
              if (clientId) detail += ` client=${clientId.slice(0, 16)}`;
            }
            // Exit code / error for completed items
            if (method === 'item/completed') {
              if (item.exitCode != null) detail += ` exit=${item.exitCode}`;
              if (item.error) detail += ` error=${((item.error as Record<string, unknown>).message as string || '')}`;
            }
          }
        } else if (method === 'turn/completed') {
          const turn = p?.turn as Record<string, unknown> | undefined;
          detail = turn ? ` status=${turn.status}` : '';
          if (turn?.error) detail += ` error=${((turn.error as Record<string, unknown>).message as string || '')}`;
        } else if (method === 'thread/tokenUsage/updated') {
          const usage = (p?.tokenUsage as Record<string, unknown>)?.total as Record<string, unknown> | undefined;
          if (usage) detail = ` in=${usage.inputTokens} out=${usage.outputTokens}`;
        } else if (method === 'thread/status/changed') {
          const status = p?.status as Record<string, unknown> | undefined;
          if (status) detail = ` type=${status.type}`;
        } else if (method === 'thread/started') {
          const thread = p?.thread as Record<string, unknown> | undefined;
          if (thread?.id) detail = ` threadId=${thread.id}`;
        } else if (method === 'mcpServer/startupStatus/updated') {
          detail = ` name=${String(p?.name ?? '(unknown)')} status=${String(p?.status ?? '(unknown)')}`;
        }
        withLogContext({ runtime: 'codex', runtimeSource }, () => {
          console.log(`[codex] ${method}${detail}`);
        });
      }
      const result = this.parseNotification(codexProc, method, params, wrappedOnEvent);
      if (!result) return;
      // parseNotification may return one event or an array (e.g., tool_use_stop + tool_result)
      const events = Array.isArray(result) ? result : [result];
      // PRD 0.2.27 — sub-agent scoping (single tagging point). Codex multiplexes
      // spawned sub-agent threads over this one stream; every item notification
      // carries a top-level `threadId`. When an item comes from a spawned
      // sub-agent thread, stamp its tool events with the spawn card to nest under
      // — so external-session routes them to chat:subagent-* instead of flat.
      // The top-level spawnAgent card itself is emitted on the MAIN thread, so
      // the `!== threadId` guard naturally leaves it untagged (it IS the parent).
      const notifParams = params as Record<string, unknown> | undefined;
      const scope = computeSubAgentScope(
        stringValue(notifParams?.threadId),
        codexProc.threadId,
        codexProc.subThreadToCard,
        codexProc.subThreadToParent,
        codexProc.subThreadMeta,
      );
      if (scope) {
        for (const event of events) {
          if (isSubAgentScopedEvent(event) && !event.subAgent) event.subAgent = scope;
        }
      }
      for (const event of events) wrappedOnEvent(event);
    });

    // Wire up server-request handler for approval requests
    codexProc.rpc.setServerRequestHandler((id, method, params) => {
      this.handleServerRequest(codexProc, id, method, params, wrappedOnEvent);
    });

    // Start background reader (runs for lifetime of session)
    codexProc.rpc.startReading();

    // Track process exit — emit session_complete if not already emitted by protocol.
    // Skipped when the startup catch-handler killed the process itself (e.g. stale
    // `thread/resume`): the caller's error surface already names the real cause,
    // and emitting a synthetic "exited with code 143" here would layer a noisy
    // SIGTERM echo on top. See issue #105.
    proc.exited.then((code) => {
      codexProc.exited = true;
      if (mcpCatalogRefreshTimer) {
        clearTimeout(mcpCatalogRefreshTimer);
        mcpCatalogRefreshTimer = null;
      }
      mcpStartup.fail(new Error(`Codex process exited during MCP startup with code ${code}`));
      if (codexProc.intentionalKillDuringStartup) return;
      wrappedOnEvent({
        kind: 'session_complete',
        result: code === 0 ? '' : `Codex process exited with code ${code}`,
        subtype: code === 0 ? 'success' : 'error',
      });
    });

    // Read stderr in background.
    //
    // Two concerns:
    //   1. Verbose unified-log capture (console.error) — every line, for triage.
    //   2. Issue #194 — classify a small set of "user-actionable" error patterns
    //      and re-emit them as UnifiedEvent log entries so the renderer/IM bus
    //      gets a one-line summary instead of the user having to grep
    //      unified-log. Pattern set is small + conservative — we only forward
    //      lines that name an actual failure mode, not Codex's noisy info
    //      messages.
    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const raw = decoder.decode(value, { stream: true }).trim();
            if (!raw) continue;
            const text = stripAnsi(raw);
            withLogContext({ runtime: 'codex', runtimeSource }, () => {
              console.error(`[codex-stderr] ${text}`);
            });
            classifyAndForwardCodexStderr(text, wrappedOnEvent);
          }
        } catch { /* ignore */ } finally {
          reader.releaseLock();
        }
      })();
    }

    try {
      // 1. Initialize handshake
      await initializeCodexRpc(codexProc.rpc, 15_000);
      await configureCodexSkillExtraRoots(codexProc.rpc, options.workspacePath);

      // 2. Determine permission mode
      const isHeadlessAutomation =
        options.scenario.type === 'im'
        || options.scenario.type === 'agent-channel'
        || options.scenario.type === 'cron'
        || options.scenario.type === 'registeredAgent';
      const defaultPermissionMode = isHeadlessAutomation ? 'no-restrictions' : 'full-auto';
      const permMode = options.permissionMode || defaultPermissionMode;
      const { approval, sandbox } = mapPermissionMode(permMode);
      const threadModelProvider = resolveCodexThreadModelProvider(
        launchConfig.modelProvider,
        options.resumeSessionId,
        options.model,
      );
      codexProc.defaultPermissionMode = defaultPermissionMode;
      codexProc.permissionMode = permMode;
      codexProc.approvalPolicy = approval;
      codexProc.sandbox = sandbox;
      codexProc.model = options.model || '';
      codexProc.reasoningEffort = options.reasoningEffort || '';

      // 3. Start or resume thread. The MCP window begins at this native
      // startup boundary, not at process spawn/initialize.
      if (launchConfig.mcpServerNames.length > 0) {
        mcpStartup.arm();
      }
      if (options.resumeSessionId) {
        // Resume existing thread
        const resumeParams = {
          threadId: options.resumeSessionId,
          cwd: options.workspacePath,
          model: options.model || null,
          ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
          approvalPolicy: approval,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
        };
        console.log(`[codex] RPC thread/resume: ${JSON.stringify(resumeParams)}`);
        const result = await codexProc.rpc.call('thread/resume', resumeParams, 30_000) as { thread: { id: string } };
        codexProc.threadId = result.thread.id;

        // Emit synthetic session_init — thread/resume doesn't trigger notifications
        // but external-session needs it for session ID sync and frontend needs
        // chat:system-init for model/tools info after Sidecar restart
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: options.model || '',
          tools: [],
        });
        scheduleMcpToolCatalogRefresh();
      } else {
        // New thread
        const startParams = {
          cwd: options.workspacePath,
          model: options.model || null,
          ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
          approvalPolicy: approval,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
          ephemeral: false,
        };
        console.log(`[codex] RPC thread/start: ${JSON.stringify(startParams)}`);
        const result = await codexProc.rpc.call('thread/start', startParams, 30_000) as { thread: { id: string }; model: string };
        codexProc.threadId = result.thread.id;

        // Emit session_init so external-session.ts captures threadId
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: result.model || '',
          tools: [],
        });
        scheduleMcpToolCatalogRefresh();
      }

      // Managed Codex owns one soft MCP startup window for this runtime
      // session. Native startup_timeout_sec uses the same policy budget, so
      // turn/start cannot inherit Codex's longer default hidden wait.
      if (launchConfig.mcpServerNames.length > 0) {
        const startup = await mcpStartup.wait();
        const serverStates = launchConfig.mcpServerNames.map(name => (
          `${name}:${startup.states[name] ?? 'pending'}`
        ));
        console.log(
          `[codex] managed MCP pre-warm terminal outcome=${startup.outcome}`
          + `${startup.reason ? ` reason=${startup.reason}` : ''}`
          + ` elapsedMs=${startup.elapsedMs} budgetMs=${MCP_PREWARM_GRACE_MS}`
          + ` servers=[${serverStates.join(',')}]`,
        );
      }
      if (codexProc.exited) {
        throw new Error('Codex process exited before startup completed');
      }

      // 4. Send initial message if provided
      if (options.initialMessage) {
        const input = buildCodexInput(options.initialMessage, options.initialImages);
        const turnResult = await codexProc.rpc.call('turn/start', buildCodexTurnStartParams({
          threadId: codexProc.threadId,
          input,
          cwd: options.workspacePath,
          approvalPolicy: approval,
          sandbox,
          model: options.model || null,
          reasoningEffort: codexProc.reasoningEffort || null,
        }), 15_000) as { turn: { id: string } };
        codexProc.currentTurnId = turnResult.turn.id;
      }

      // 5. Fire-and-forget diagnostic fan-out (issue #194). Never block startup
      // or the user's first turn — even if all four RPCs hang they only
      // surface a missing diagnostic strip, not a failed session. Failures are
      // captured into the diagnostic `status` per-call.
      void (async () => {
        try {
          const diagnostics = await collectCodexDiagnostics(
            codexProc.rpc,
            codexEnv,
            options.workspacePath,
            codexProc.threadId,
            options.envPolicy?.proxy ?? 'myagents',
            buildCodexSandboxPolicy(sandbox, options.workspacePath),
            runtimeSource,
          );
          // Session-life gate: tab close / runtime teardown can race against
          // the 5–10s diagnostic fan-out. Without this guard, a diagnostic
          // resolving after the user switched tabs would broadcast into the
          // already-torn-down session — TabProvider's setRuntimeDiagnostics(null)
          // on session switch protects the NEXT session, but the stale event
          // can still flash into the switched-away tab if SSE flushes faster
          // than React commit.
          if (codexProc.exited || codexProc.intentionalKillDuringStartup) {
            return;
          }
          wrappedOnEvent({ kind: 'runtime_diagnostics', diagnostics });
        } catch (err) {
          // collectCodexDiagnostics already degrades per-call; reaching here
          // means an unexpected error in the helper itself.
          console.warn('[codex] collectDiagnostics failed:', err instanceof Error ? err.message : String(err));
        }
      })();
    } catch (err) {
      // Clean up on startup failure.
      if (mcpCatalogRefreshTimer) {
        clearTimeout(mcpCatalogRefreshTimer);
        mcpCatalogRefreshTimer = null;
      }
      // Flag must be set BEFORE proc.kill so proc.exited.then observes it.
      codexProc.intentionalKillDuringStartup = true;
      try { proc.kill(); } catch { /* ignore */ }
      codexProc.exited = true;

      // Detect the specific "rollout was dropped" failure so the caller can
      // invalidate the stale threadId and retry fresh instead of looping on a
      // dead pointer forever. Codex worded this slightly differently across
      // CLI versions (observed on v0.122.0-alpha.1) — match loosely.
      const msg = err instanceof Error ? err.message : String(err);
      if (options.resumeSessionId && /no rollout found|thread not found|conversation not found/i.test(msg)) {
        throw new StaleRuntimeSessionError(options.resumeSessionId, msg);
      }
      throw err;
    }

    return codexProc;
  }

  async sendMessage(process: RuntimeProcess, message: string, images?: ResolvedImagePayload[]): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');

    const input = buildCodexInput(message, images);
    const turnResult = await codexProc.rpc.call('turn/start', buildCodexTurnStartParams({
      threadId: codexProc.threadId,
      input,
      cwd: codexProc.workspacePath,
      approvalPolicy: codexProc.approvalPolicy,
      sandbox: codexProc.sandbox,
      model: codexProc.model || null,
      reasoningEffort: codexProc.reasoningEffort || null,
    }), 15_000) as { turn: { id: string } };
    codexProc.currentTurnId = turnResult.turn.id;
  }

  async steerMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string },
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    if (!codexProc.currentTurnId) {
      throw new Error('Codex has no active turn to steer');
    }

    const input = buildCodexInput(message, images);
    const result = await codexProc.rpc.call('turn/steer', buildCodexTurnSteerParams({
      threadId: codexProc.threadId,
      input,
      expectedTurnId: codexProc.currentTurnId,
      clientUserMessageId: options?.clientUserMessageId,
    }), 15_000) as { turnId?: string };
    if (result.turnId && result.turnId !== codexProc.currentTurnId) {
      codexProc.currentTurnId = result.turnId;
    }
  }

  /**
   * Codex carries model on every turn/start. Updating process state at the
   * session layer's turn boundary is enough; the active turn has already
   * received its turn/start payload and is not affected.
   */
  async setModel(process: RuntimeProcess, model: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    codexProc.model = model ?? '';
  }

  /**
   * Codex permission mode is also a turn/start payload. Keep the original
   * human-readable mode for diagnostics and update the derived approval/sandbox
   * pair used by the next sendMessage().
   */
  async setPermissionMode(process: RuntimeProcess, mode: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    const nextMode = mode || codexProc.defaultPermissionMode;
    const { approval, sandbox } = mapPermissionMode(nextMode);
    codexProc.permissionMode = nextMode;
    codexProc.approvalPolicy = approval;
    codexProc.sandbox = sandbox;
  }

  /**
   * #324 — in-place reasoning-effort switch. turn/start.effort overrides
   * "this turn and subsequent turns", so recording the value on process
   * state is sufficient: the next sendMessage carries it. No RPC needed.
   */
  async setReasoningEffort(process: RuntimeProcess, effort: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    codexProc.reasoningEffort = effort ?? '';
  }

  /**
   * Interrupt the current turn WITHOUT closing stdin (process stays alive). The app-server
   * emits `turn/completed` (non-failed status) → unified `turn_complete` → the session goes
   * idle, so the queued message can run next. Used by force-send. No-op if no turn is active.
   */
  async interruptTurn(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited || !codexProc.currentTurnId) return;
    await codexProc.rpc.call('turn/interrupt', {
      threadId: codexProc.threadId,
      turnId: codexProc.currentTurnId,
    }, 3_000).catch(() => { /* turn may already be ending; the turn/completed event drives idle */ });
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    _reason?: string,
    _suggestions?: unknown[],
    updatedInput?: Record<string, unknown>,
    interrupt?: boolean,
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;

    const pending = codexProc.pendingRequests.get(requestId);
    if (!pending) {
      console.error('[codex] Unknown approval requestId:', requestId);
      return;
    }
    codexProc.pendingRequests.delete(requestId);

    const action = serializeCodexPermissionResponse(pending, decision, updatedInput, interrupt);
    if (action.type === 'error') {
      codexProc.rpc.respondError(pending.rpcId, action.code, action.message);
      return;
    }
    codexProc.rpc.respond(pending.rpcId, action.result);
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;

    try {
      // 1. Interrupt current turn if any
      if (codexProc.currentTurnId) {
        await codexProc.rpc.call('turn/interrupt', {
          threadId: codexProc.threadId,
          turnId: codexProc.currentTurnId,
        }, 3_000).catch(() => {});
      }
      // 2. Close stdin — signals app-server to shut down (like CC's closeStdin)
      await codexProc.closeStdin();
    } catch { /* ignore */ }

    try {
      await killWithEscalation(codexProc, {
        gracefulMs: 3_000,
        hardMs: 2_000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') {
            console.warn(`[codex] Process pid=${info.pid} did not exit after SIGKILL; continuing with orphan risk`);
          }
        },
      });
    } catch { /* ignore */ } finally {
      codexProc.pendingRequests.clear();
      codexProc.rpc.destroy();
    }
  }

  // ─── Notification parsing (v2 typed notifications) ───

  /**
   * Schedule an async tool attachment save and broadcast a `tool_attachment_update`
   * UnifiedEvent when it resolves. Returns a placeholder attachment to embed in
   * the synchronous `tool_result` emit. PRD 0.2.15 §4.7.1.
   */
  private scheduleAttachmentSave(
    source: AttachmentSource,
    ctx: SaveContext,
    asyncEmit: UnifiedEventCallback,
  ): ToolAttachment {
    const { attachment, pendingId } = makePlaceholderAttachment(ctx);
    // Wrap in a tracked promise so `persistTurnResult` can await all in-flight
    // saves before snapshotting currentContentBlocks. queueMicrotask ensures
    // the synchronous tool_result emit lands first, then this fulfills the
    // placeholder. Codex review SM1.
    const tracked = (async (): Promise<void> => {
      try {
        const real = await saveToolAttachment(source, ctx);
        asyncEmit({
          kind: 'tool_attachment_update',
          toolUseId: ctx.toolUseId,
          pendingId,
          attachment: real,
        });
      } catch (err) {
        // Verbose detail to server log; safe enum code travels over SSE.
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[codex] saveToolAttachment failed (toolUseId=${ctx.toolUseId}): ${reason}`);
        asyncEmit({
          kind: 'tool_attachment_update',
          toolUseId: ctx.toolUseId,
          pendingId,
          attachment: makeErrorAttachment(ctx, err, pendingId),
        });
      }
    })();
    trackInFlightSave(tracked);
    return attachment;
  }

  private parseNotification(
    codexProc: CodexProcess,
    method: string,
    params: unknown,
    asyncEmit: UnifiedEventCallback,
  ): UnifiedEvent | UnifiedEvent[] | null {
    const p = params as Record<string, unknown>;

    // PRD 0.2.27 — sub-agent threads run their OWN turns/lifecycle multiplexed
    // over this connection (verified live: a spawned child emits its own
    // turn/started + turn/completed with isMain=false, plus thread lifecycle).
    // Those MUST NOT drive the MAIN MyAgents session: a child's turn/completed
    // would otherwise finalize the user's turn early and resetTurnAccumulators()
    // mid-fan-out — wiping currentContentBlocks (the spawn card + its nested
    // calls) and breaking both turn integrity and the nesting itself.
    // PRD 0.2.32 — thread/tokenUsage/updated is gated here for the same reason:
    // a child's usage would otherwise become a `usage` event and pollute the
    // MAIN context indicator + persisted lastContextUsage (cross-review codex HIGH).
    // Child ITEM notifications (the tools we nest) are intentionally NOT gated here.
    if (isChildThreadGatedMethod(method)) {
      const evtThreadId = stringValue(p.threadId);
      if (evtThreadId && codexProc.threadId && evtThreadId !== codexProc.threadId) {
        return null; // ignore child-thread event; only the main thread drives the session
      }
    }

    switch (method) {
      // ── Thread lifecycle ──
      case 'thread/started': {
        // Thread started — no UnifiedEvent needed (session_init already emitted).
        // SIDE EFFECT (best-effort): if a spawned sub-agent thread ever emits
        // thread/started here, record its parent link + nickname/role for richer
        // labels + depth>1 chains. NOTE: Codex 0.135.0 does NOT emit child
        // thread/started on the app-server connection (verified live) — so this
        // is currently inert; the PRIMARY card↔child link is the spawnAgent
        // item's receiverThreadIds (populated at item/completed). Kept for
        // forward-compat with Codex versions that do surface it.
        const sub = parseSubAgentThreadSource(p.thread);
        const childId = stringValue(objectValue(p.thread).id);
        if (sub && childId) {
          codexProc.subThreadToParent.set(childId, sub.parentThreadId);
          if (sub.nickname || sub.role) {
            codexProc.subThreadMeta.set(childId, { nickname: sub.nickname, role: sub.role });
          }
        }
        return null;
      }

      case 'thread/status/changed': {
        const status = p.status as { type: string } | undefined;
        if (!status) return null;
        // Thread status describes the persistent Codex thread, not the user
        // turn. Resume can report `idle` after the turn owner accepted a query;
        // only the external turn lifecycle may drive running/idle.
        if (status.type === 'systemError') return { kind: 'status_change', state: 'error' };
        return null;
      }

      case 'thread/closed':
        return { kind: 'session_complete', result: '', subtype: 'success' };

      // ── Turn lifecycle ──
      case 'turn/started': {
        const turnId = stringValue(p.turnId)
          ?? stringValue(objectValue(p.turn).id);
        if (turnId) {
          codexProc.currentTurnId = turnId;
        }
        return [
          { kind: 'turn_started' },
          { kind: 'status_change', state: 'running' },
          { kind: 'agent_plan_update', todos: [] },
        ];
      }

      case 'turn/completed': {
        const turn = p.turn;
        // PRD 0.2.27 — sub-agent threads live within a turn; clear correlation
        // maps at turn end so a stale child threadId can't re-parent next turn's
        // tools and the maps don't grow unbounded across a long session.
        codexProc.subThreadToCard.clear();
        codexProc.subThreadToParent.clear();
        codexProc.subThreadMeta.clear();
        codexProc.collabControlToolParents.clear();
        return [
          mapCodexTurnCompletedNotification(turn),
          { kind: 'agent_plan_update', todos: [] },
        ];
      }

      // ── Text streaming ──
      case 'item/agentMessage/delta': {
        const itemId = (p.itemId as string) || '';
        const text = (p.delta as string) || '';
        if (itemId && text) {
          codexProc.agentMessageTextById.set(itemId, (codexProc.agentMessageTextById.get(itemId) || '') + text);
        }
        return { kind: 'text_delta', text, traceId: codexTraceId(p, itemId) };
      }

      // ── Reasoning streaming ──
      case 'item/reasoning/summaryTextDelta':
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: (p.summaryIndex as number) || 0,
          traceId: codexTraceId(p, undefined, `summary:${(p.summaryIndex as number) || 0}`),
        };

      case 'item/reasoning/textDelta':
        // Raw reasoning content — also map to thinking for display
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: (p.contentIndex as number) || 0,
          traceId: codexTraceId(p, undefined, `content:${(p.contentIndex as number) || 0}`),
        };

      // ── Plan streaming ──
      case 'item/plan/delta':
        // Map plan to thinking display
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: 0,
          traceId: codexTraceId(p, undefined, 'plan'),
        };

      // ── Tool/item lifecycle ──
      // Tool name mapping: Codex item types → existing frontend badge names
      // (Bash, Edit, Grep, Read, Write, WebFetch, Glob, etc.)
      case 'item/started': {
        const item = p.item as {
          type: string; id: string;
          command?: string; cwd?: string; tool?: string; server?: string;
          text?: string; query?: string; arguments?: unknown;
          path?: string; revisedPrompt?: string; mcpAppResourceUri?: string;
          changes?: Array<{ path: string }>;
          commandActions?: unknown[];
          source?: string; namespace?: string | null;
          senderThreadId?: string; receiverThreadIds?: string[]; prompt?: string; model?: string; status?: string;
          clientUserMessageId?: string; client_user_message_id?: string; clientId?: string; client_id?: string;
        } | undefined;
        if (!item) return null;
        switch (item.type) {
          case 'commandExecution': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Bash',
              input: {
                command: item.command ?? '',
                ...(item.cwd ? { cwd: item.cwd } : {}),
                ...(item.source ? { source: item.source } : {}),
                ...(Array.isArray(item.commandActions) ? { commandActions: item.commandActions } : {}),
              },
            };
          }
          case 'fileChange': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Edit',
              input: buildCodexStartedFileChangeInput(item.changes, item.cwd),
            };
          }
          case 'mcpToolCall': {
            // Prefix with mcp__ to match frontend MCP tool badge patterns
            const toolName = item.server && item.tool ? `mcp__${item.server}__${item.tool}` : (item.tool || 'MCP Tool');
            const baseInput: Record<string, unknown> = (item.arguments && typeof item.arguments === 'object')
              ? { ...(item.arguments as Record<string, unknown>) }
              : {};
            if (item.mcpAppResourceUri) baseInput.mcpAppResourceUri = item.mcpAppResourceUri;
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName,
              input: Object.keys(baseInput).length > 0 ? baseInput : undefined,
            };
          }
          case 'dynamicToolCall': {
            const baseInput: Record<string, unknown> = (item.arguments && typeof item.arguments === 'object')
              ? { ...(item.arguments as Record<string, unknown>) }
              : {};
            if (item.namespace) baseInput.namespace = item.namespace;
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: item.tool || 'Tool',
              input: Object.keys(baseInput).length > 0 ? baseInput : undefined,
            };
          }
          case 'collabAgentToolCall': {
            // PRD 0.2.15 — surface collab agent invocation as a tool card.
            // PRD 0.2.27 — record the spawn card↔child-thread link so the child's
            // tools nest under THIS card. receiverThreadIds is often empty at
            // started; item/completed is authoritative. Only `spawnAgent` creates
            // the relationship (wait/closeAgent/sendInput reference existing ones).
            recordSpawnAgentChildThreads(codexProc, item.tool, item.id, item.receiverThreadIds);
            const controlParents = resolveCollabAgentControlParents(
              item.tool,
              item.receiverThreadIds,
              codexProc.subThreadToCard,
              codexProc.subThreadToParent,
            );
            if (controlParents.length > 0) {
              codexProc.collabControlToolParents.set(item.id, controlParents);
              return buildCollabAgentControlStartEvents(item, controlParents);
            }
            if (item.tool && item.tool !== 'spawnAgent') {
              // Defer unresolved control actions until item/completed. Completion
              // can either resolve and nest them, or emit one complete flat card
              // when Codex never reports receiverThreadIds.
              return null;
            }
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'CollabAgent',
              input: buildCollabAgentInput(item),
            };
          }
          case 'plan':
            // PRD 0.2.15 — `plan` items stream via item/plan/delta as thinking_delta.
            // We need a thinking_start so the frontend opens a thinking block.
            return { kind: 'thinking_start', index: 0, traceId: codexTraceId(p, item.id, 'plan') };
          case 'webSearch': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'WebSearch',
              input: { query: item.query ?? '' },
            };
          }
          case 'imageView': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Read',
              input: item.path ? { file_path: item.path } : undefined,
            };
          }
          case 'imageGeneration':
            return { kind: 'tool_use_start', toolUseId: item.id, toolName: 'ImageGeneration' };
          case 'reasoning':
            return { kind: 'thinking_start', index: 0, traceId: codexTraceId(p, item.id, 'reasoning') };
          case 'agentMessage':
          case 'contextCompaction':
            return null;
          case 'userMessage':
            return {
              kind: 'user_message_accepted',
              clientUserMessageId: codexUserMessageClientId(item) ?? codexUserMessageClientId(p),
            };
          case 'enteredReviewMode':
          case 'exitedReviewMode':
          case 'hookPrompt':
            // Handled in item/completed (transition events, no started-side render).
            return null;
          default:
            // Codex review W4 — silent drop hides newly-added item types from
            // future Codex versions. Log so production triage has a breadcrumb.
            console.warn(`[codex] item/started: unhandled item.type=${(item as { type?: string }).type}`);
            return null;
        }
      }

      case 'item/completed': {
        const item = p.item as {
          type: string; id: string;
          command?: string; aggregatedOutput?: string; exitCode?: number; durationMs?: number; cwd?: string; processId?: string; status?: string;
          changes?: unknown;
          tool?: string; server?: string; mcpAppResourceUri?: string;
          arguments?: unknown; namespace?: string | null;
          result?: unknown; error?: { message: string };
          text?: string; summary?: string[];
          query?: string; action?: { type: string; url?: string; queries?: string[]; pattern?: string };
          path?: string; revisedPrompt?: string; savedPath?: string;
          contentItems?: Array<{ type: string; text?: string; imageUrl?: string }>;
          success?: boolean; review?: string;
          senderThreadId?: string; receiverThreadIds?: string[];
          prompt?: string; model?: string;
        } | undefined;
        if (!item) return null;

        // Attachment save context — shared by image-producing case branches below.
        // turnId comes from Codex; if Codex never emitted one yet (shouldn't happen
        // at item/completed time) we fall back to the item id to preserve uniqueness.
        const attachCtx = (mimeType: string, caption?: string, producedBy?: string): SaveContext => ({
          sessionId: codexProc.sessionId || 'unknown-session',
          turnId: codexProc.currentTurnId || item.id,
          toolUseId: item.id,
          mimeType,
          caption,
          producedBy,
        });

        // For tool items, emit tool_use_stop + tool_result as a pair
        // (frontend expects stop before result, matching CC's content_block_stop → tool_result)
        switch (item.type) {
          case 'commandExecution':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: item.aggregatedOutput || '',
                isError: item.exitCode != null && item.exitCode !== 0,
                metadata: {
                  exitCode: item.exitCode ?? null,
                  durationMs: item.durationMs ?? null,
                  cwd: item.cwd,
                  processId: item.processId ?? null,
                  status: item.status,
                },
              },
            ];
          case 'fileChange': {
            // Show file paths and diffs for each changed file, plus terminal status
            // (inProgress / completed / failed / declined) — `declined` matters
            // because user-rejected patches look identical to other states without it.
            const details = buildCodexFileChangeResultContent(item.changes);
            const isFailedPatch = item.status === 'failed' || item.status === 'declined';
            const statusPrefix = item.status && item.status !== 'completed'
              ? `[${item.status}]\n`
              : '';
            const finalInput = buildCodexCompletedFileChangeInput(item.changes, item.cwd);
            return [
              { kind: 'tool_use_stop', toolUseId: item.id, ...(finalInput ? { input: finalInput } : {}) },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: statusPrefix + details,
                isError: isFailedPatch,
                metadata: { status: item.status },
              },
            ];
          }
          case 'mcpToolCall': {
            // Walk MCP ContentBlock[] per spec: text/image/audio/resource/resource_link.
            // Text joins into the human-readable content string; image/audio land as
            // ToolAttachment[] for unified rendering.
            const contentArr = ((item.result as { content?: Array<Record<string, unknown>> })?.content) || [];
            const texts: string[] = [];
            const attachments: ToolAttachment[] = [];
            for (const block of contentArr) {
              const ty = block.type as string | undefined;
              if (ty === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
              } else if (ty === 'image' && typeof block.data === 'string') {
                const mime = (typeof block.mimeType === 'string' ? block.mimeType : 'image/png');
                const ctx = attachCtx(mime, undefined, `codex.mcp.${item.server ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: block.data as string },
                  ctx,
                  asyncEmit,
                ));
              } else if (ty === 'audio' && typeof block.data === 'string') {
                const mime = (typeof block.mimeType === 'string' ? block.mimeType : 'audio/mpeg');
                const ctx = attachCtx(mime, undefined, `codex.mcp.${item.server ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: block.data as string },
                  ctx,
                  asyncEmit,
                ));
              } else if (ty === 'resource_link' && typeof block.uri === 'string') {
                texts.push(`[resource] ${block.uri}`);
              }
            }
            const fallbackText = texts.length === 0 && attachments.length === 0
              ? JSON.stringify(item.result ?? '')
              : '';
            const content = item.error?.message || texts.join('\n') || fallbackText;
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content,
                isError: !!item.error,
                attachments: attachments.length > 0 ? attachments : undefined,
              },
            ];
          }
          case 'dynamicToolCall': {
            const texts: string[] = [];
            const attachments: ToolAttachment[] = [];
            for (const ci of item.contentItems ?? []) {
              if (ci.type === 'inputText' && typeof ci.text === 'string') {
                texts.push(ci.text);
              } else if (ci.type === 'inputImage' && typeof ci.imageUrl === 'string') {
                // imageUrl is typically a data URL or https URL — saveToolAttachment
                // handles both branches (data: routes through base64).
                const ctx = attachCtx('image/png', undefined, `codex.dynamic.${item.namespace ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'url', url: ci.imageUrl },
                  ctx,
                  asyncEmit,
                ));
              }
            }
            const content = texts.length === 0 && attachments.length === 0
              ? JSON.stringify(item.result ?? '')
              : texts.join('\n');
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content,
                isError: item.success === false,
                attachments: attachments.length > 0 ? attachments : undefined,
                metadata: { durationMs: item.durationMs ?? null },
              },
            ];
          }
          case 'webSearch': {
            const parts: string[] = [];
            if (item.query) parts.push(`Query: ${item.query}`);
            const action = item.action;
            if (action) {
              if (action.type === 'search' && Array.isArray(action.queries) && action.queries.length > 0) {
                parts.push(`Queries: ${action.queries.join(' | ')}`);
              } else if (action.type === 'openPage' && action.url) {
                parts.push(`URL: ${action.url}`);
              } else if (action.type === 'findInPage') {
                if (action.url) parts.push(`URL: ${action.url}`);
                if (action.pattern) parts.push(`Pattern: ${action.pattern}`);
              }
            }
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: parts.join('\n') || 'Search completed' },
            ];
          }
          case 'imageView':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: item.path || 'Image viewed' },
            ];
          case 'imageGeneration': {
            // PRD 0.2.15 — the core fix. Prior code only read revisedPrompt/status
            // and dropped the actual image bytes on the floor.
            //
            // Sources, in preference order:
            //   1. savedPath (Codex v0.117+ auto-saved file in its cache) → zero-copy reference
            //   2. result (base64 image bytes from OpenAI image_generation_call) → decode + write
            const attachments: ToolAttachment[] = [];
            const caption = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined;
            const mime = 'image/png';

            if (typeof item.savedPath === 'string' && item.savedPath) {
              attachments.push(this.scheduleAttachmentSave(
                { kind: 'externalPath', sourcePath: item.savedPath },
                attachCtx(mime, caption, 'codex.image_generation'),
                asyncEmit,
              ));
            } else if (typeof (item as Record<string, unknown>).result === 'string') {
              const b64 = (item as Record<string, unknown>).result as string;
              if (b64) {
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: b64 },
                  attachCtx(mime, caption, 'codex.image_generation'),
                  asyncEmit,
                ));
              }
            }

            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: caption || item.status || 'Image generated',
                attachments: attachments.length > 0 ? attachments : undefined,
              },
            ];
          }
          case 'plan': {
            // PRD 0.2.15 — Codex `plan` items were previously dropped (parsed as
            // null in the default branch). They mirror CC's thinking blocks, so
            // re-map: started → thinking_start (synthesized at parseNotification
            // started branch below), completed → thinking_stop here. Text comes
            // through item/plan/delta as thinking_delta already.
            return { kind: 'thinking_stop', index: 0, traceId: codexTraceId(p, item.id, 'plan') };
          }
          case 'collabAgentToolCall': {
            // PRD 0.2.15 — multi-agent collab tool was completely dropped before.
            // PRD 0.2.27 — authoritative spawn card↔child-thread link (receiverThreadIds
            // is populated by completion time).
            recordSpawnAgentChildThreads(codexProc, item.tool, item.id, item.receiverThreadIds);
            const resolvedParents = resolveCollabAgentControlParents(
              item.tool,
              item.receiverThreadIds,
              codexProc.subThreadToCard,
              codexProc.subThreadToParent,
            );
            const route = resolveCollabControlCompletionRoute(
              codexProc.collabControlToolParents.get(item.id),
              resolvedParents,
            );
            codexProc.collabControlToolParents.delete(item.id);

            if (item.tool && item.tool !== 'spawnAgent') {
              return buildCollabAgentControlCompletedEvents(item, route.parentToolUseIds, {
                includeStart: route.includeStart,
              });
            }

            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: buildCollabAgentResultContent(item),
                isError: isCollabAgentError(item) ? true : undefined,
              },
            ];
          }
          case 'enteredReviewMode':
          case 'exitedReviewMode': {
            // PRD 0.2.15 — surface review-mode transitions as log events so the
            // user sees them in the chat log panel; no tool card needed.
            return {
              kind: 'log',
              level: 'info',
              message: `[codex] ${item.type === 'enteredReviewMode' ? 'Entered' : 'Exited'} review mode${item.review ? `: ${item.review}` : ''}`,
            };
          }
          case 'hookPrompt': {
            // Codex hooks inject prompt fragments at session boundaries. Surface
            // as a log line so the user knows extra context was injected.
            return { kind: 'log', level: 'info', message: '[codex] Hook prompt fragment injected' };
          }
          case 'reasoning':
            return { kind: 'thinking_stop', index: 0, traceId: codexTraceId(p, item.id, 'reasoning') };
          case 'agentMessage': {
            const finalText = typeof item.text === 'string' ? item.text : '';
            const streamedText = codexProc.agentMessageTextById.get(item.id) || '';
            codexProc.agentMessageTextById.delete(item.id);

            if (finalText) {
              if (!streamedText) {
                console.log(`[codex] agentMessage completed without delta; backfilling ${finalText.length} chars`);
                return [
                  { kind: 'text_delta', text: finalText, traceId: codexTraceId(p, item.id) },
                  { kind: 'text_stop', traceId: codexTraceId(p, item.id) },
                ];
              }

              if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
                const tail = finalText.slice(streamedText.length);
                console.log(`[codex] agentMessage completed with missing tail; backfilling ${tail.length} chars`);
                return [
                  { kind: 'text_delta', text: tail, traceId: codexTraceId(p, item.id) },
                  { kind: 'text_stop', traceId: codexTraceId(p, item.id) },
                ];
              }
            }

            return { kind: 'text_stop', traceId: codexTraceId(p, item.id) };
          }
          case 'userMessage':
          case 'contextCompaction':
            // Mirror item/started: these are transition events that we
            // intentionally don't render. Without an explicit case they
            // fall through to the warning default and spam the unified log
            // ~20+ times per session (issue #192).
            return null;
          default:
            // Codex review W4 — log unknown item types so future Codex versions
            // are visible in production triage.
            console.warn(`[codex] item/completed: unhandled item.type=${(item as { type?: string }).type}`);
            return null;
        }
      }

      // ── Command execution output ──
      case 'item/commandExecution/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── File change output ──
      case 'item/fileChange/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── Token usage ──
      // PRD 0.2.32 — `inputTokens`/`semantics:'running_total'` 维持原样（external watchdog 依赖
      // 累计值）；新增 `contextOccupiedTokens`（= last.inputTokens，最近一次调用）+ runtime 窗口
      // 给 context 用量指示器。解析逻辑见纯函数 mapCodexTokenUsage（schema 随版本漂移，单独可测）。
      case 'thread/tokenUsage/updated': {
        const mapped = mapCodexTokenUsage(p.tokenUsage as CodexThreadTokenUsage | undefined);
        if (!mapped) return null;
        return {
          kind: 'usage',
          inputTokens: mapped.runningTotalInputTokens,
          outputTokens: mapped.runningTotalOutputTokens,
          semantics: 'running_total',
          contextOccupiedTokens: mapped.contextOccupiedTokens,
          runtimeContextWindow: mapped.runtimeContextWindow,
        };
      }

      // ── Errors ──
      case 'error': {
        const error = p.error as { message: string } | undefined;
        return { kind: 'log', level: 'error', message: error?.message || 'Unknown error' };
      }

      // ── Thread name / diff / plan updates ──
      case 'model/rerouted': {
        const model = typeof p.model === 'string'
          ? p.model
          : typeof p.routedModel === 'string'
            ? p.routedModel
            : typeof p.to === 'string'
              ? p.to
              : typeof p.newModel === 'string'
                ? p.newModel
                : '';
        return model ? { kind: 'model_update', model } : null;
      }

      case 'thread/name/updated':
      case 'turn/diff/updated':
      case 'remoteControl/status/changed':
      case 'thread/goal/cleared':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/terminalInteraction':
      case 'deprecationNotice':
      case 'configWarning':
      case 'skills/changed':
      case 'account/updated':
      case 'account/rateLimits/updated':
      case 'account/login/completed':
      case 'app/list/updated':
      case 'item/mcpToolCall/progress':
      case 'thread/compacted':
      case 'thread/archived':
      case 'thread/unarchived':
        // Not relevant to our event stream — ignore
        return null;

      case 'turn/plan/updated':
        return mapCodexTurnPlanUpdatedNotification(p);

      case 'serverRequest/resolved': {
        const requestId = resolvedServerRequestId(p);
        if (!requestId) return null;
        const pending = codexProc.pendingRequests.get(requestId);
        if (!pending) return null;
        codexProc.pendingRequests.delete(requestId);
        return { kind: 'interactive_request_resolved', requestId };
      }

      default: {
        // Legacy codex/event/* notifications — ignore (we use v2 typed notifications)
        if (method.startsWith('codex/event/')) return null;
        // Realtime/Windows — ignore
        if (method.startsWith('thread/realtime/') || method.startsWith('windows/')) return null;
        if (method.startsWith('mcpServer/') || method.startsWith('fuzzyFileSearch/')) return null;
        // Unknown notification
        console.log(`[codex] Unhandled notification: ${method}`);
        return null;
      }
    }
  }

  // ─── Server-initiated request handling (approval) ───

  private handleServerRequest(
    codexProc: CodexProcess,
    rpcId: JsonRpcRequestId,
    method: string,
    params: unknown,
    onEvent: UnifiedEventCallback,
  ): void {
    const p = params as Record<string, unknown>;
    if (!isKnownCodexServerRequestMethod(method)) {
      console.warn(`[codex] Unhandled future server request: ${method}`);
      codexProc.rpc.respondError(rpcId, -32601, `Method not supported: ${method}`);
      return;
    }
    const requestId = String(rpcId);
    const track = (pending: PendingCodexRequest): void => {
      codexProc.pendingRequests.set(requestId, pending);
    };

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        track({ kind: 'command_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'Shell',
          toolUseId: (p.itemId as string) || '',
          input: {
            command: (p.command as string) || '',
            cwd: (p.cwd as string) || '',
            reason: (p.reason as string) || undefined,
          },
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        track({ kind: 'file_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'FileEdit',
          toolUseId: (p.itemId as string) || '',
          input: {
            reason: (p.reason as string) || '',
            grantRoot: (p.grantRoot as string) || undefined,
          },
        });
        break;
      }

      case 'item/tool/requestUserInput': {
        if (shouldDenyCodexStructuredUserInput(codexProc)) {
          const action = serializeCodexPermissionResponse(
            { kind: 'tool_user_input', rpcId, method, params: p },
            'deny',
            undefined,
            true,
          );
          codexProc.rpc.respond(rpcId, action.type === 'result' ? action.result : null);
          break;
        }
        track({ kind: 'tool_user_input', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'AskUserQuestion',
          toolUseId: (p.itemId as string) || '',
          input: toolRequestUserInputToAskUserQuestion(p),
        });
        break;
      }

      case 'mcpServer/elicitation/request': {
        const requestedSchema = objectValue(p.requestedSchema);
        const hasFormFields = Object.keys(objectValue(requestedSchema.properties)).length > 0;
        if ((p.mode === 'form' || p.mode === 'openai/form') && hasFormFields) {
          if (shouldDenyCodexStructuredUserInput(codexProc)) {
            const action = serializeCodexPermissionResponse(
              { kind: 'mcp_elicitation', rpcId, method, params: p },
              'deny',
              undefined,
              true,
            );
            if (action.type === 'error') {
              codexProc.rpc.respondError(rpcId, action.code, action.message);
            } else {
              codexProc.rpc.respond(rpcId, action.result);
            }
            break;
          }
          track({ kind: 'mcp_elicitation', rpcId, method, params: p });
          onEvent({
            kind: 'permission_request',
            requestId,
            toolName: 'AskUserQuestion',
            toolUseId: stringValue(p.turnId) || requestId,
            input: mcpElicitationToAskUserQuestion(p),
          });
          break;
        }
        track({ kind: 'mcp_elicitation', rpcId, method, params: p });
        const isToolApproval = isCodexMcpApprovalElicitation(p);
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: p.mode === 'url' ? 'MCP URL Approval' : isToolApproval ? 'MCP Tool Approval' : 'MCP Elicitation',
          toolUseId: stringValue(p.turnId) || requestId,
          input: {
            serverName: p.serverName,
            message: p.message,
            mode: p.mode,
            ...(p.mode === 'url' ? { url: p.url, elicitationId: p.elicitationId } : {}),
          },
        });
        break;
      }

      case 'item/permissions/requestApproval': {
        track({ kind: 'permissions_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'Codex Permissions',
          toolUseId: stringValue(p.itemId) || requestId,
          input: {
            reason: p.reason,
            cwd: p.cwd,
            permissions: p.permissions,
          },
        });
        break;
      }

      case 'execCommandApproval':
      case 'applyPatchApproval': {
        track({ kind: method === 'execCommandApproval' ? 'command_approval' : 'file_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: method === 'execCommandApproval' ? 'Shell' : 'FileEdit',
          toolUseId: stringValue(p.itemId) || stringValue(p.callId) || requestId,
          input: p,
        });
        break;
      }

      case 'item/tool/call':
        codexProc.rpc.respondError(rpcId, -32000, 'Codex dynamic tool host is not supported by MyAgents yet');
        break;

      case 'account/chatgptAuthTokens/refresh':
        codexProc.rpc.respondError(rpcId, -32000, 'MyAgents does not refresh Codex ChatGPT tokens; run `codex login` in a terminal');
        break;

      case 'attestation/generate':
        codexProc.rpc.respondError(rpcId, -32000, 'MyAgents did not request Codex attestation');
        break;

      case 'currentTime/read':
        codexProc.rpc.respond(rpcId, { currentTimeAt: Math.floor(Date.now() / 1000) });
        break;

      default: {
        const _exhaustive: never = method;
        codexProc.rpc.respondError(rpcId, -32601, `Method not supported: ${_exhaustive}`);
        break;
      }
    }
  }
}
