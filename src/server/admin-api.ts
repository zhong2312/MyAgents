/**
 * Admin API — Self-Configuration endpoints for the CLI tool.
 *
 * All handlers follow the same pattern:
 *   1. Validate input
 *   2. If dry-run → return preview
 *   3. Write config (atomicModifyConfig)
 *   4. Update Sidecar in-memory state
 *   5. Broadcast SSE event for frontend sync
 *   6. Return result
 */

import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { cp as fsCp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { splitProviderModelInput, type McpServerDefinition, type ProxySettings } from '../shared/config-types';
import { deriveCliToolKind, type CliToolRegistryEntry } from '../shared/types/cliTools';
import { workspacePathsEqual } from '../shared/workspacePath';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../shared/official-tools';
import { removeProviderFromProxySettingsScope } from '../shared/proxyScope';
import { removeCustomMcpServerCascade, McpRemovalError } from './services/mcp-removal';
import { SDK_RESERVED_MCP_NAMES } from './agent-session';
import {
  findMissingEnvKeys,
  findPathCollision,
  getCliToolsBinDir,
  getCliToolsDir,
  assertCliToolTreeSelfContained,
  modifyCliToolsRegistry,
  readCliToolManifest,
  readCliToolsRegistry,
  removeCliToolDir,
  removeCliToolShim,
  writeCliToolShim,
} from './utils/cli-tools-registry';
import {
  loadConfig,
  atomicModifyConfig,
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadProjects,
  atomicModifyProjects,
  redactSecret,
  findProvider,
  getAllEffectiveProviders,
  isProviderDisabled,
  getProvidersDir,
  isCliToolRegistryEnabled,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ChannelConfigSlim,
  type ProjectSlim,
} from './utils/admin-config';
import { cancellableFetch, fetchWithGeneralProxy } from './utils/cancellation';
import { ensureShellPath } from './utils/shell';
import { buildCronScope } from './utils/cron-scope';
import { readLoopbackJson } from './utils/loopback-response';
import { ADMIN_LOOPBACK_TIMEOUT_MS, managementApi } from './utils/management-api-client';
import { getCuseDiagnostics } from './utils/cuse-diagnostics';
import { getSessionEngine } from './session-engine';

// Long-running sidecar operations need their own budget. Anchored to the
// sidecar's internal `FETCH_TIMEOUT_MS` (300s for tarball download) plus a
// 30s buffer so the inner timeout always wins. Used by skill install routes.
const SKILL_INSTALL_LOOPBACK_TIMEOUT_MS = 330_000;
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { ensureDirSync } from './utils/fs-utils';
import { resolve } from 'path';
import { setMcpServers, setAgents, getMcpServers, getAgentState, getSidecarPort, forceReloadActiveSession } from './agent-session';
import { loadEnabledAgents } from './agents/agent-loader';
import { getHomeDirOrNull } from './utils/platform';
import { join } from 'path';
import { broadcast } from './sse';
import { getCronTaskContext, markCronTaskExitRequested, CRON_TASK_EXIT_TEXT } from './tools/cron-tools';
import { getImCronContext, getSessionCronContext } from './tools/im-cron-tool';
import { getImMediaContext } from './tools/im-media-tool';
import { buildReadMeContent } from './tools/generative-ui-tool';
import { WIDGET_TRIGGER_GUIDANCE } from './system-prompt-cli-tools';
import { assertSafeFilePath } from './utils/safe-file-path';
import {
  VALID_RUNTIMES,
  RUNTIME_DISPLAY_NAMES,
  getRuntimePermissionModes,
  getDefaultRuntimePermissionMode,
  buildRuntimeChangePatch,
  type RuntimeType,
  type RecoveryHint,
  type RuntimePermissionMode,
  type RuntimeModelInfo,
  type RuntimeDetection,
  type RuntimeConfig,
} from '../shared/types/runtime';
import { getExternalRuntime, isRuntimeSupported } from './runtimes/factory';
import { queryRuntimeModels } from './runtimes/external-session';
import { trackServer } from './analytics';

/**
 * Infer the analytics `source` for a CLI-originated request.
 *
 * - `MYAGENTS_PORT` is injected into AI subproc env by `buildClaudeSessionEnv()`
 *   (cli_architecture.md). When it's set, the caller is an AI agent invoking
 *   the CLI as a tool (`cli_agent`). Otherwise it's the user typing in their
 *   terminal (`cli`).
 *
 * Same logic that `handleTaskUpdateStatus` already uses for the persisted
 * `actor` field — extracted so every CLI handler can tag analytics events
 * consistently without re-deriving the heuristic.
 */
function cliSource(): 'cli' | 'cli_agent' {
  return process.env.MYAGENTS_PORT ? 'cli_agent' : 'cli';
}

// ---------------------------------------------------------------------------
// Sidecar self-loopback (for thin wrappers over existing /api/skill/* routes)
// ---------------------------------------------------------------------------

async function sidecarSelf(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sidecarPort = getSidecarPort();
  if (!sidecarPort) {
    return { status: 500, json: { success: false, error: 'Sidecar port not initialized' } };
  }
  const url = `http://127.0.0.1:${sidecarPort}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, {
      timeoutMs: opts?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,
    });
    // Issue #114 — defensive read via shared helper. Map to this caller's
    // legacy {status, json} shape (sidecarSelf has callers that branch on
    // status code, so we preserve that envelope rather than collapsing to
    // a flat error object).
    const json = await readLoopbackJson(resp, 'Sidecar self-call');
    return { status: resp.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, json: { success: false, error: `Sidecar self-call failed: ${msg}` } };
  }
}

/**
 * Build an AdminResponse error from a Management API failure, preserving any
 * `recoveryHint` the helper attached (currently: unreachable-backend cases).
 *
 * Use this instead of `{ success: false, error: String(resp.error ?? 'X') }`
 * in handlers that transform the shape (e.g. list handlers that unwrap
 * `resp.tasks` / `resp.runs`) — those bypass `wrapMgmtResponse` but still
 * deserve the hint propagation. Sites that already go through
 * `wrapMgmtResponse` don't need to change.
 */
function mgmtError(resp: Record<string, unknown>, fallbackMsg: string): AdminResponse {
  const response: AdminResponse = {
    success: false,
    error: String(resp.error ?? fallbackMsg),
  };
  for (const field of ['code', 'suggestion', 'suggestedCommand'] as const) {
    if (typeof resp[field] === 'string' && resp[field]) response[field] = resp[field];
  }
  const hint = resp.recoveryHint;
  if (hint && typeof hint === 'object' && !Array.isArray(hint)) {
    response.recoveryHint = hint as RecoveryHint;
  }
  return response;
}

/** Convert Management API response ({ ok, ... }) to Admin API response ({ success, data, error }) */
function wrapMgmtResponse(mgmt: Record<string, unknown>): AdminResponse {
  if (mgmt.ok) {
    const { ok: _ok, recoveryHint: _rh, ...rest } = mgmt;
    return { success: true, data: rest };
  }
  const response: AdminResponse = {
    success: false,
    error: String(mgmt.error ?? 'Unknown error'),
  };
  for (const field of ['code', 'suggestion', 'suggestedCommand'] as const) {
    if (typeof mgmt[field] === 'string' && mgmt[field]) response[field] = mgmt[field];
  }
  // Propagate the `recoveryHint` if the Management API helper attached one
  // (currently only for unreachable-backend scenarios — see `managementApi`).
  const maybeHint = mgmt.recoveryHint;
  if (maybeHint && typeof maybeHint === 'object' && !Array.isArray(maybeHint)) {
    response.recoveryHint = maybeHint as RecoveryHint;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Free-form success tip ("Server added.", "Restart required."). Purely
   * informational — distinct from `recoveryHint` which is a structured,
   * actionable recovery path for a failed request.
   */
  hint?: string;
  /**
   * Scope descriptor for workspace-scoped list/status reads (cron). The list
   * silently filters to the caller's workspace (a security boundary), so a
   * `{data: []}` / `Total: 0` result is easy for an Agent consumer to misread
   * as "nothing exists anywhere". Echo the scope so it can tell "empty within
   * this workspace" apart from "empty everywhere". Pair with `hint` (the
   * human/LLM-readable note). See `buildCronScope`.
   */
  scope?: { workspacePath: string; source: 'explicit' | 'default'; visibility: string };
  /**
   * Structured recovery path for recoverable errors. The CLI renders this
   * under the error line as `→ Run: <command>` so the caller (AI or human)
   * can copy-paste to correct course without digging through --help.
   *
   * Pair a `recoveryHint` with `success: false` + `error` — never emit one
   * on a success path; use `hint` there.
   */
  recoveryHint?: RecoveryHint;
  dryRun?: boolean;
  preview?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP Handlers
// ---------------------------------------------------------------------------

export function handleMcpList(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = new Set(getEnabledMcpServerIds(config));

  const data = allServers.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: enabledIds.has(s.id),
    isBuiltin: s.isBuiltin,
    command: s.command,
    url: s.url,
    requiresConfig: s.requiresConfig,
    hasEnv: !!(s.env && Object.keys(s.env).length > 0),
  }));

  return { success: true, data };
}

/**
 * `myagents mcp show <id>` — details for a single MCP server.
 *
 * Mirrors handleAgentShow: parses user-facing config + workspace enable state
 * into one consolidated payload the AI / user can inspect without dumping the
 * whole list. Env values are redacted so an AI transcript never leaks API keys
 * (same redaction rule the model-list endpoint already uses).
 */
export async function handleMcpShow(payload: { id?: string }): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <mcp-id>',
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const server = allServers.find(s => s.id === id);
  if (!server) {
    return {
      success: false,
      error: `MCP server '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }

  const globalEnabled = new Set(getEnabledMcpServerIds(config));
  const workspacePath = getCurrentWorkspacePath();
  let projectEnabled: boolean | null = null;
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find(p => workspacePathsEqual(p.path, workspacePath));
    projectEnabled = new Set(project?.mcpEnabledServers ?? []).has(id);
  }

  // Redact env values — mirrors what `model list` does for provider api keys.
  const env = server.env ? Object.fromEntries(
    Object.entries(server.env).map(([k, v]) => [k, redactSecret(v)]),
  ) : undefined;

  const cuseDiagnostics = server.command === '__bundled_cuse__'
    ? await getCuseDiagnostics({ workspacePath, includeR2Latest: false })
    : undefined;

  return {
    success: true,
    data: {
      id: server.id,
      name: server.name,
      type: server.type,
      description: server.description,
      isBuiltin: !!server.isBuiltin,
      requiresConfig: !!server.requiresConfig,
      websiteUrl: server.websiteUrl,
      command: server.command,
      resolvedCommand: cuseDiagnostics?.bundled.path,
      args: server.args,
      url: server.url,
      // Headers (for http/sse) and env (for stdio) — redacted values only.
      headers: server.headers ? Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [k, redactSecret(v)]),
      ) : undefined,
      env,
      enabled: {
        global: globalEnabled.has(id),
        // null = no current workspace session → project scope n/a.
        project: projectEnabled,
      },
      workspacePath: workspacePath ?? null,
      diagnostics: cuseDiagnostics ? { cuse: cuseDiagnostics } : undefined,
    },
  };
}

export async function handleMcpAdd(payload: {
  server: Partial<McpServerDefinition>;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const { dryRun } = payload;
  const s = payload.server;

  // Validate required fields
  if (!s.id) return { success: false, error: 'Missing required field: id' };
  if (!s.type) return { success: false, error: 'Missing required field: type' };

  // Reject SDK reserved MCP names — these cause the Claude Agent SDK to crash (exit code 1)
  // with "Invalid MCP configuration: X is a reserved MCP name."
  const normalizedId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (SDK_RESERVED_MCP_NAMES.includes(normalizedId)) {
    return { success: false, error: `MCP ID "${s.id}" 与 Claude SDK 内置保留名冲突，请使用其他名称（如 "my-${s.id}"）` };
  }

  if (s.type === 'stdio' && !s.command) {
    return { success: false, error: 'stdio type requires "command" field' };
  }
  if ((s.type === 'sse' || s.type === 'http') && !s.url) {
    return { success: false, error: `${s.type} type requires "url" field` };
  }

  const server: McpServerDefinition = {
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    description: s.description,
    command: s.command,
    // Defensive: CLI may send non-array args (boolean, string) due to parsing edge cases
    args: Array.isArray(s.args) ? s.args : undefined,
    env: s.env,
    url: s.url,
    headers: s.headers,
    isBuiltin: false,
    requiresConfig: s.requiresConfig,
    websiteUrl: s.websiteUrl,
    configHint: s.configHint,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: server };
  }

  await atomicModifyConfig(c => ({
    ...c,
    mcpServers: [...(c.mcpServers || []).filter(x => x.id !== server.id), server],
  }));

  notifyMcpChange('add', server.id);
  return {
    success: true,
    data: { id: server.id, name: server.name },
    hint: 'Server added. Use "myagents mcp enable" to activate.',
  };
}

export async function handleMcpRemove(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const result = await removeCustomMcpServerCascade(id);
    notifyMcpChange('remove', id);
    return { success: true, data: result, hint: 'Server removed.' };
  } catch (err) {
    const response: AdminResponse = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    if (err instanceof McpRemovalError && err.recoveryHint && typeof err.recoveryHint === 'object') {
      response.recoveryHint = err.recoveryHint as RecoveryHint;
    }
    return response;
  }
}

export async function handleMcpEnable(payload: { id: string; scope?: string }): Promise<AdminResponse> {
  const { id } = payload;
  const scope = parseMcpScope(payload.scope);
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!scope) {
    return { success: false, error: "Invalid scope. Use 'global', 'project', or 'both'." };
  }

  // Verify server exists
  const allServers = getAllMcpServers();
  if (!allServers.find(s => s.id === id)) {
    return { success: false, error: `MCP server '${id}' not found` };
  }

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.add(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  let projectMutation: ProjectMcpMutationResult | null = null;
  if (scope === 'project' || scope === 'both') {
    projectMutation = await enableMcpForCurrentProject(id);
    if (scope === 'project' && projectMutation.status !== 'updated') {
      return projectMcpMutationFailure('enable', id, projectMutation);
    }
  }

  notifyMcpChange('enable', id);
  const scopeLabel = scope === 'both' ? 'global + project' : scope;
  const skipHint = projectMutation && projectMutation.status !== 'updated'
    ? ` Project scope skipped: ${projectMcpMutationReason(projectMutation)}.`
    : '';
  return {
    success: true,
    data: { id, scope: scopeLabel, projectScope: projectMutation?.status },
    hint: `Enabled ${id} (${scopeLabel}).${skipHint}`,
  };
}

export async function handleMcpDisable(payload: { id: string; scope?: string }): Promise<AdminResponse> {
  const { id } = payload;
  const scope = parseMcpScope(payload.scope);
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!scope) {
    return { success: false, error: "Invalid scope. Use 'global', 'project', or 'both'." };
  }

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.delete(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  let projectMutation: ProjectMcpMutationResult | null = null;
  if (scope === 'project' || scope === 'both') {
    projectMutation = await disableMcpForCurrentProject(id);
    if (scope === 'project' && projectMutation.status !== 'updated') {
      return projectMcpMutationFailure('disable', id, projectMutation);
    }
  }

  notifyMcpChange('disable', id);
  const skipHint = projectMutation && projectMutation.status !== 'updated'
    ? ` Project scope skipped: ${projectMcpMutationReason(projectMutation)}.`
    : '';
  return {
    success: true,
    data: { id, projectScope: projectMutation?.status },
    hint: `Disabled ${id}.${skipHint}`,
  };
}

export async function handleMcpEnv(payload: {
  id: string;
  action: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): Promise<AdminResponse> {
  const { id, action, env } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (action === 'get') {
    const config = loadConfig();
    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};
    // Redact values for safety
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverEnv)) {
      redacted[k] = redactSecret(v);
    }
    return { success: true, data: { id, env: redacted } };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    await atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, keys: Object.keys(env) }, hint: 'Environment variables updated.' };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    await atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      if (mcpServerEnv[id]) {
        // Deep-copy per-server env to avoid mutating the original config object
        const serverEnv = { ...mcpServerEnv[id] };
        for (const key of Object.keys(env)) {
          delete serverEnv[key];
        }
        if (Object.keys(serverEnv).length === 0) {
          delete mcpServerEnv[id];
        } else {
          mcpServerEnv[id] = serverEnv;
        }
      }
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, deletedKeys: Object.keys(env) } };
  }

  return { success: false, error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.` };
}

export async function handleMcpTest(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { success: false, error: `MCP server '${id}' not found` };

  // Validate config completeness
  if (server.type === 'stdio' && !server.command) {
    return { success: false, error: `MCP server '${id}' has no command configured` };
  }
  if ((server.type === 'sse' || server.type === 'http') && !server.url) {
    return { success: false, error: `MCP server '${id}' has no URL configured` };
  }

  // Built-in MCP: delegate to registry.
  // getBuiltinMcpInstance() force-loads the tool module (SDK+zod+server
  // construction) on first hit; it returns undefined only when the id isn't
  // registered in META. META is registered via agent-session.ts's side-effect
  // import of './tools/builtin-mcp-meta', which already ran before any admin
  // handler can fire — no need to force-import META here.
  if (server.command === '__builtin__') {
    const { getBuiltinMcpInstance } = await import('./tools/builtin-mcp-registry');
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      return { success: false, error: `Built-in MCP '${server.id}' not registered` };
    }
    // Don't swallow factory/import errors — a failing `myagents mcp test` must
    // surface as "failure" so users/agents diagnose the actual issue instead of
    // getting a false "validated" green light while the session keeps breaking.
    try {
      const entry = await entryPromise;
      if (entry.validate) {
        const validationError = await entry.validate(server.env || {});
        if (validationError) {
          const errMsg = typeof validationError === 'string' ? validationError : JSON.stringify(validationError);
          return { success: false, error: errMsg };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: `Built-in MCP '${server.id}' load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { success: true, data: { id, type: 'builtin' }, hint: 'Built-in MCP validated.' };
  }

  // Bundled cuse (computer-use) binary: resolve via runtime helper and skip
  // the generic `which` preflight because __bundled_cuse__ is a sentinel, not
  // a real PATH lookup. The diagnostic response intentionally exposes the
  // resolved bundled path/version so `myagents mcp show/test cuse` can
  // distinguish the app-owned binary from any stale skill-local cache.
  if (server.command === '__bundled_cuse__') {
    const cuse = await getCuseDiagnostics({
      workspacePath: getCurrentWorkspacePath(),
      includeR2Latest: true,
    });
    if (!cuse.bundled.path) {
      return {
        success: false,
        error: `cuse 二进制未安装 (platform=${process.platform})。macOS/Windows 构建会自动包含；开发环境请运行 scripts/download_cuse.sh。`,
        data: { id, type: 'stdio', cuse },
      };
    }
    if (!cuse.bundled.exists || cuse.bundled.error) {
      return {
        success: false,
        error: `Bundled cuse validation failed: ${cuse.bundled.error ?? 'resolved path does not exist'}`,
        data: { id, type: 'stdio', cuse },
      };
    }
    const warningHint = cuse.warnings.length > 0
      ? `\nWarnings:\n${cuse.warnings.map(w => `- ${w}`).join('\n')}`
      : '';
    return {
      success: true,
      data: { id, type: 'stdio', cuse },
      hint: `Bundled cuse validated: ${cuse.bundled.rawVersion ?? cuse.bundled.version ?? 'version unknown'}.${warningHint}`,
    };
  }

  // SSE/HTTP: test URL reachability
  if (server.type === 'sse' || server.type === 'http') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // Inject stored OAuth token if no explicit Authorization header
      const { resolveAuthHeaders } = await import('./mcp-oauth');
      const configHeaders = server.headers || {};
      const hasExplicitAuth = Object.keys(configHeaders).some(k => k.toLowerCase() === 'authorization');
      const oauthHeaders = hasExplicitAuth ? {} : await resolveAuthHeaders(server.id);

      const headers: Record<string, string> = {
        'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
        'Accept-Encoding': 'identity',
        ...configHeaders,
        ...oauthHeaders,
      };

      const resp = server.type === 'http'
        ? await fetchWithGeneralProxy(server.url!, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'MyAgents', version: '1.0' } } }),
            signal: controller.signal,
          })
        : await fetchWithGeneralProxy(server.url!, { method: 'GET', headers, signal: controller.signal });

      clearTimeout(timeout);

      if (resp.status === 401 || resp.status === 403) {
        const hint = oauthHeaders['Authorization']
          ? 'OAuth token may be expired or revoked. Try re-authorizing.'
          : 'This server may require OAuth authorization. Use Settings UI or `myagents mcp oauth start`.';
        return { success: false, error: `Authentication failed (HTTP ${resp.status}). ${hint}` };
      }
      if (!resp.ok) {
        return { success: false, error: `Server returned HTTP ${resp.status}` };
      }

      return { success: true, data: { id, type: server.type, status: resp.status }, hint: `Connection OK (HTTP ${resp.status}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) return { success: false, error: 'Connection timed out (15s).' };
      return { success: false, error: `Connection failed: ${msg}` };
    }
  }

  // stdio: check command exists in PATH
  if (server.type === 'stdio' && server.command && server.command !== '__builtin__') {
    try {
      const { getShellEnv } = await import('./utils/shell');
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const { spawn } = await import('child_process');
      const code = await new Promise<number | null>(resolve => {
        const proc = spawn(checkCmd, [server.command!], { stdio: 'ignore', env: getShellEnv() });
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });
      if (code === 0) {
        return { success: true, data: { id, type: 'stdio', command: server.command }, hint: `Command '${server.command}' found.` };
      }
      return { success: false, error: `Command '${server.command}' not found in PATH.` };
    } catch (err) {
      return { success: false, error: `Failed to check command: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { success: true, data: { id, type: server.type }, hint: 'Configuration valid.' };
}

// ---------------------------------------------------------------------------
// MCP OAuth Handlers (CLI-facing wrappers around mcp-oauth module)
// ---------------------------------------------------------------------------

/** Resolve MCP server URL from config by ID */
function getMcpServerUrl(id: string): { url: string } | { error: string } {
  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { error: `MCP server '${id}' not found` };
  if (server.type !== 'sse' && server.type !== 'http') {
    return { error: `MCP server '${id}' is type '${server.type}' — OAuth only applies to sse/http servers.` };
  }
  if (!server.url) return { error: `MCP server '${id}' has no URL configured` };
  return { url: server.url };
}

export async function handleMcpOAuthDiscover(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { probeOAuthRequirement } = await import('./mcp-oauth');
    const result = await probeOAuthRequirement(id, resolved.url, true);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStart(payload: {
  id: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  callbackPort?: number;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { authorizeServer } = await import('./mcp-oauth');
    const manualConfig = payload.clientId ? {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      scopes: payload.scopes ? payload.scopes.split(/[,\s]+/).filter(Boolean) : undefined,
      callbackPort: payload.callbackPort,
    } : undefined;

    const { authUrl, waitForCompletion } = await authorizeServer(id, resolved.url, manualConfig);

    // Fire-and-forget: log completion but don't block the HTTP response.
    // CLI should poll `mcp oauth status <id>` to check completion.
    waitForCompletion.then(ok => {
      console.log(`[admin] OAuth ${ok ? 'completed' : 'failed/cancelled'} for MCP ${id}`);
    });

    return { success: true, data: { id, authUrl }, hint: 'Authorization started. Complete in browser, then check with `mcp oauth status`.' };
  } catch (err) {
    return { success: false, error: `OAuth start failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStatus(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { getOAuthStatus } = await import('./mcp-oauth');
    const result = getOAuthStatus(id);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth status check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthRevoke(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { revokeAuthorization } = await import('./mcp-oauth');
    await revokeAuthorization(id);
    return { success: true, data: { id }, hint: 'OAuth authorization revoked.' };
  } catch (err) {
    return { success: false, error: `OAuth revoke failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Official Vision CLI Tool Handlers
// ---------------------------------------------------------------------------

export async function handleVisionReadme(): Promise<AdminResponse> {
  const { getVisionToolReadme } = await import('./official-tools/vision');
  return { success: true, data: { text: getVisionToolReadme() } };
}

export async function handleVisionAnalyze(payload: {
  images?: unknown;
  image?: unknown;
  prompt?: unknown;
  promptFile?: unknown;
}): Promise<AdminResponse> {
  const rawImages = Array.isArray(payload.images)
    ? payload.images
    : (payload.image !== undefined ? [payload.image] : []);
  const images = rawImages.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const promptFile = typeof payload.promptFile === 'string' ? payload.promptFile : undefined;
  const { analyzeImages, visionErrorResponse } = await import('./official-tools/vision');
  try {
    const sessionContext = getSessionEngine().getCurrentSessionContext();
    const result = await analyzeImages({
      workspacePath: sessionContext.workspacePath ?? getCurrentWorkspacePath(),
      sessionMeta: sessionContext.sessionMeta ?? null,
      images,
      prompt,
      promptFile,
    });
    trackServer('official_tool_vision_analyze', {
      tool_id: IMAGE_UNDERSTANDING_TOOL_ID,
      image_count: result.images.length,
      provider_id: result.providerId,
      model: result.model,
    });
    return { success: true, data: result };
  } catch (error) {
    const { status, error: message, recoveryHint } = visionErrorResponse(error);
    return { success: false, error: message, data: { status }, recoveryHint };
  }
}

// ---------------------------------------------------------------------------
// Model Provider Handlers
// ---------------------------------------------------------------------------

export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};

  const allProviders = getAllEffectiveProviders(config);
  const data = allProviders.map(p => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    return {
      id,
      name: String(p.name),
      vendor: p.vendor ? String(p.vendor) : undefined,
      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,
      isBuiltin: !!p.isBuiltin,
      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',
      enabled: p.enabled !== false,
      hasApiKey: !!apiKeys[id],
      status: (verifyStatus[id] as unknown as Record<string, unknown>)?.status ?? 'not-set',
    };
  });

  return { success: true, data };
}

export async function handleModelSetKey(payload: { id: string; apiKey: string }): Promise<AdminResponse> {
  const { id, apiKey } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!apiKey) return { success: false, error: 'Missing required field: apiKey' };

  await atomicModifyConfig(c => ({
    ...c,
    providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },
  }));

  broadcast('config:changed', { section: 'model', action: 'set-key', id });
  return { success: true, data: { id }, hint: `API key saved for ${id}.` };
}

export async function handleModelSetDefault(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (isProviderDisabled(id)) {
    return { success: false, error: `Provider '${id}' is disabled. Re-enable it before setting it as default.` };
  }

  await atomicModifyConfig(c => ({
    ...c,
    defaultProviderId: id,
  }));

  broadcast('config:changed', { section: 'model', action: 'set-default', id });
  return { success: true, data: { id }, hint: `Default provider set to ${id}.` };
}

export async function handleModelVerify(payload: { id: string; model?: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const apiKey = (config.providerApiKeys ?? {})[id];
  if (!apiKey) {
    return { success: false, error: `No API key set for provider '${id}'. Use 'myagents model set-key' first.` };
  }

  // Look up provider config (preset or custom)
  const provider = findProvider(id);
  if (!provider) {
    return { success: false, error: `Provider '${id}' not found in presets or custom providers.` };
  }

  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(providerConfig.baseUrl ?? '');
  const authType = String(provider.authType ?? 'both');
  const apiProtocol = provider.apiProtocol as 'anthropic' | 'openai' | undefined;
  const userPrimary = (config.providerPrimaryModels as Record<string, string> | undefined)?.[id];
  const verifyModel = payload.model ?? userPrimary ?? String(provider.primaryModel ?? '');

  try {
    const { verifyProviderViaSdk } = await import('./provider-verify');
    const result = await verifyProviderViaSdk(
      id,
      baseUrl, apiKey, authType, verifyModel,
      apiProtocol,
      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,
      provider.maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,
    );

    if (result.success) {
      // Persist verify status
      await atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
          ...(c.providerVerifyStatus ?? {}),
          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },
        },
      }));
      broadcast('config:changed', { section: 'model', action: 'verify', id });
      return { success: true, data: { id, model: verifyModel }, hint: 'Verification successful.' };
    }

    return { success: false, error: result.error ?? 'Verification failed', data: { id, detail: result.detail } };
  } catch (err) {
    return { success: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleModelAdd(payload: {
  provider: Record<string, unknown>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const p = payload.provider;

  // Validate required fields
  if (!p.id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(String(p.id))) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };
  if (!p.name) return { success: false, error: 'Missing required field: name' };
  if (!p.baseUrl) return { success: false, error: 'Missing required field: baseUrl (API endpoint)' };
  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {
    return { success: false, error: 'Missing required field: models (at least one model ID required)' };
  }

  // Build model entities
  const modelSeries = (p.modelSeries as string) || String(p.id);
  const expandedModelIds = (p.models as unknown[]).flatMap(model => splitProviderModelInput(String(model)));
  if (expandedModelIds.length === 0) {
    return { success: false, error: 'Missing required field: models (at least one model ID required)' };
  }
  const modelNameInputs = Array.isArray(p.modelNames)
    ? (p.modelNames as unknown[]).map(name => String(name).trim())
    : [];
  const seenModelIds = new Set<string>();
  const uniqueModelRefs = expandedModelIds.flatMap((model, expandedIndex) => {
    if (seenModelIds.has(model)) return [];
    seenModelIds.add(model);
    return [{ model, expandedIndex }];
  });
  const modelNamesUseExpandedIndex = modelNameInputs.length === expandedModelIds.length;
  const models = uniqueModelRefs.map(({ model, expandedIndex }, uniqueIndex) => {
    const modelName = modelNamesUseExpandedIndex
      ? modelNameInputs[expandedIndex]
      : modelNameInputs[uniqueIndex];
    return {
      model,
      modelName: modelName || model,
      modelSeries,
    };
  });
  const modelIds = models.map(model => model.model);

  // Build aliases
  let modelAliases: Record<string, string> | undefined;
  if (p.aliases && typeof p.aliases === 'object') {
    modelAliases = p.aliases as Record<string, string>;
  } else if (modelIds.length > 0) {
    // Default: map fable/sonnet/opus/haiku to first model
    modelAliases = { fable: modelIds[0], sonnet: modelIds[0], opus: modelIds[0], haiku: modelIds[0] };
  }

  const providerObj = {
    id: String(p.id),
    name: String(p.name),
    vendor: String(p.vendor ?? p.name),
    cloudProvider: String(p.cloudProvider ?? ''),
    type: 'api' as const,
    primaryModel: p.primaryModel ? String(p.primaryModel).trim() || modelIds[0] : modelIds[0],
    isBuiltin: false,
    config: {
      baseUrl: String(p.baseUrl),
      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),
      ...(p.disableNonessential ? { disableNonessential: true } : {}),
    },
    authType: String(p.authType ?? 'auth_token'),
    ...(p.protocol === 'openai' || p.apiProtocol === 'openai' ? {
      apiProtocol: 'openai' as const,
      ...(p.maxOutputTokens ? { maxOutputTokens: Number(p.maxOutputTokens) } : {}),
      ...(p.maxOutputTokensParamName ? { maxOutputTokensParamName: String(p.maxOutputTokensParamName) } : {}),
      upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as 'chat_completions' | 'responses',
    } : {}),
    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,
    models,
    modelAliases,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: providerObj };
  }

  // Write to ~/.myagents/providers/{id}.json
  saveCustomProviderFile(providerObj);
  broadcast('config:changed', { section: 'model', action: 'add', id: providerObj.id });
  return {
    success: true,
    data: { id: providerObj.id, name: providerObj.name, models: modelIds },
    hint: `Provider added. Use 'myagents model set-key ${providerObj.id} <key>' to set API key.`,
  };
}

export async function handleModelRemove(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(id)) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };

  // Check if it's a preset
  const provider = findProvider(id);
  if (provider?.isBuiltin) {
    return { success: false, error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.` };
  }

  // Delete provider file
  if (!deleteCustomProviderFile(id)) {
    return { success: false, error: `Custom provider '${id}' not found.` };
  }

  // Clean up API key, verify status, and enablement/order stale IDs
  await atomicModifyConfig(c => {
    const apiKeys = { ...(c.providerApiKeys ?? {}) };
    delete apiKeys[id];
    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };
    delete verifyStatus[id];
    // If this was the default provider, clear it
    const defaultId = c.defaultProviderId === id ? undefined : c.defaultProviderId;
    // Strip the deleted id from providerOrder / disabledProviderIds so disk
    // state doesn't grow unbounded across delete-and-re-add cycles.
    const providerOrder = c.providerOrder?.filter(pid => pid !== id);
    const disabledProviderIds = c.disabledProviderIds?.filter(pid => pid !== id);
    const currentProxySettings = c.proxySettings && typeof c.proxySettings === 'object' && !Array.isArray(c.proxySettings)
      ? c.proxySettings as ProxySettings
      : undefined;
    const proxySettings = removeProviderFromProxySettingsScope(currentProxySettings, id);
    return {
      ...c,
      providerApiKeys: apiKeys,
      providerVerifyStatus: verifyStatus,
      defaultProviderId: defaultId,
      providerOrder: providerOrder && providerOrder.length > 0 ? providerOrder : undefined,
      disabledProviderIds: disabledProviderIds && disabledProviderIds.length > 0 ? disabledProviderIds : undefined,
      ...(proxySettings ? { proxySettings } : {}),
    };
  });

  broadcast('config:changed', { section: 'model', action: 'remove', id });
  return { success: true, data: { id }, hint: 'Provider removed.' };
}

// ---------------------------------------------------------------------------
// Agent Handlers
// ---------------------------------------------------------------------------

function findProjectForAgent(
  projects: ProjectSlim[],
  agent: AgentConfigSlim,
): { index: number; project: ProjectSlim } | null {
  const index = projects.findIndex(project => (
    project.agentId === agent.id ||
    (!!project.path && !!agent.workspacePath && workspacePathsEqual(project.path, agent.workspacePath))
  ));
  return index >= 0 ? { index, project: projects[index] } : null;
}

function isProjectArchivedSlim(project: { archivedAt?: unknown } | null | undefined): boolean {
  return typeof project?.archivedAt === 'string' && project.archivedAt.length > 0;
}

function normalizeAgentLifecycleFilter(value: unknown): 'all' | 'active' | 'archived' {
  if (value === 'active' || value === 'archived') return value;
  return 'all';
}

function getArchivedProjectForAgent(agent: AgentConfigSlim): ProjectSlim | undefined {
  const project = findProjectForAgent(loadProjects(), agent)?.project;
  return isProjectArchivedSlim(project) ? project : undefined;
}

export function handleAgentList(payload: { lifecycle?: string } = {}): AdminResponse {
  const config = loadConfig();
  const projects = loadProjects();
  const lifecycle = normalizeAgentLifecycleFilter(payload.lifecycle);
  const agents = (config.agents ?? [])
    .map(a => {
      const projectEntry = findProjectForAgent(projects, a);
      const project = projectEntry?.project;
      const archived = isProjectArchivedSlim(project);
      return {
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        archived,
        archivedAt: archived ? project?.archivedAt : undefined,
        workspacePath: a.workspacePath,
        projectId: project?.id,
        channelCount: (a.channels ?? []).length,
        channels: (a.channels ?? []).map(ch => ({
          id: ch.id,
          type: ch.type,
          name: ch.name,
          enabled: ch.enabled,
        })),
      };
    })
    .filter(agent => {
      if (lifecycle === 'active') return !agent.archived;
      if (lifecycle === 'archived') return agent.archived;
      return true;
    });
  return { success: true, data: agents };
}

export async function handleAgentEnable(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === id);
  if (agent && getArchivedProjectForAgent(agent)) {
    return {
      success: false,
      error: `Agent '${id}' belongs to an archived workspace.`,
      recoveryHint: {
        recoveryCommand: `myagents agent unarchive ${id}`,
        message: 'Unarchive the Agent workspace before enabling proactive channels.',
      },
    };
  }
  return modifyAgent(id, agent => ({ ...agent, enabled: true }), 'enable');
}

export async function handleAgentDisable(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: false }), 'disable');
}

export async function handleAgentArchive(payload: { id?: string }): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }

  let archivedAt = '';
  let projectId = '';
  let agentEnabledBeforeArchive = false;
  let alreadyArchived = false;
  const wasEnabled = agent.enabled === true;
  await atomicModifyProjects(projects => {
    const entry = findProjectForAgent(projects, agent);
    if (!entry) return projects;
    const next = [...projects];
    projectId = entry.project.id;
    alreadyArchived = isProjectArchivedSlim(entry.project);
    archivedAt = alreadyArchived
      ? String(entry.project.archivedAt)
      : new Date().toISOString();
    agentEnabledBeforeArchive = alreadyArchived
      ? entry.project.archivedAgentEnabledBeforeArchive === true
      : wasEnabled;
    next[entry.index] = {
      ...entry.project,
      archivedAt,
      archivedAgentEnabledBeforeArchive: agentEnabledBeforeArchive,
      pinnedAt: undefined,
    };
    return next;
  });

  if (!projectId) {
    return {
      success: false,
      error: `Agent '${id}' has no linked workspace project.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'Archive works on Agent workspaces registered in projects.json.',
      },
    };
  }

  if (wasEnabled) {
    await modifyAgent(id, current => ({ ...current, enabled: false }), 'archive');
  }

  const stopResult = wasEnabled
    ? await managementApi('/api/agent/stop-channels', 'POST', { agentId: id })
    : { ok: true, stoppedChannels: 0 };
  if (!wasEnabled) {
    broadcast('config:changed', { section: 'project', action: 'archive', id });
  }

  const stopOk = stopResult.ok !== false;
  return {
    success: true,
    data: {
      id,
      projectId,
      archivedAt,
      agentEnabledBeforeArchive,
      alreadyArchived,
      stoppedChannels: stopOk ? (stopResult.stoppedChannels ?? 0) : 0,
      stopWarning: stopOk ? undefined : String(stopResult.error ?? 'Failed to stop running channels'),
    },
    hint: stopOk
      ? 'Agent workspace archived.'
      : `Agent workspace archived, but running channels may stop after restart: ${String(stopResult.error ?? 'unknown error')}`,
  };
}

export async function handleAgentUnarchive(payload: { id?: string }): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list --archived',
        message: 'See archived agent ids.',
      },
    };
  }

  const projectEntry = findProjectForAgent(loadProjects(), agent);
  const projectId = projectEntry?.project.id ?? '';
  const alreadyActive = !!projectEntry && !isProjectArchivedSlim(projectEntry.project);
  const shouldRestoreAgent = projectEntry?.project.archivedAgentEnabledBeforeArchive === true;

  if (!projectId) {
    return {
      success: false,
      error: `Agent '${id}' has no linked workspace project.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list --archived',
        message: 'Unarchive works on Agent workspaces registered in projects.json.',
      },
    };
  }

  if (alreadyActive) {
    return {
      success: true,
      data: {
        id,
        projectId,
        restoredAgentEnabled: false,
        alreadyActive: true,
      },
      hint: 'Agent workspace is already active.',
    };
  }

  let restoredAgentConfig = false;
  if (shouldRestoreAgent) {
    const restoreResult = await modifyAgent(id, current => ({ ...current, enabled: true }), 'unarchive');
    if (!restoreResult.success) return restoreResult;
    restoredAgentConfig = true;
  }

  try {
    await atomicModifyProjects(projects => {
      const entry = findProjectForAgent(projects, agent);
      if (!entry || !isProjectArchivedSlim(entry.project)) return projects;
      const next = [...projects];
      const {
        archivedAt: _archivedAt,
        archivedAgentEnabledBeforeArchive: _archivedAgentEnabledBeforeArchive,
        ...rest
      } = entry.project;
      next[entry.index] = rest;
      return next;
    });
  } catch (err) {
    if (restoredAgentConfig) {
      await modifyAgent(id, current => ({ ...current, enabled: false }), 'unarchive-rollback');
    }
    throw err;
  }

  broadcast('config:changed', { section: 'project', action: 'unarchive', id });

  return {
    success: true,
    data: {
      id,
      projectId,
      restoredAgentEnabled: shouldRestoreAgent,
    },
    hint: shouldRestoreAgent
      ? 'Agent workspace unarchived. Enabled channels will restart automatically shortly.'
      : 'Agent workspace unarchived.',
  };
}

export async function handleAgentSet(payload: { id: string; key: string; value: unknown }): Promise<AdminResponse> {
  const { id, key, value } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect sensitive/structural fields
  const protectedFields = ['id', 'channels'];
  if (protectedFields.includes(key)) {
    return { success: false, error: `Cannot directly set field '${key}'. Use specific commands instead.` };
  }

  if (key === 'enabled' && value === true) {
    const agent = (loadConfig().agents ?? []).find(a => a.id === id);
    if (agent && getArchivedProjectForAgent(agent)) {
      return {
        success: false,
        error: `Agent '${id}' belongs to an archived workspace.`,
        recoveryHint: {
          recoveryCommand: `myagents agent unarchive ${id}`,
          message: 'Unarchive the Agent workspace before setting enabled=true.',
        },
      };
    }
  }

  // `runtime` field has a cross-runtime scrub policy (see
  // buildRuntimeChangePatch doc in shared/types/runtime.ts). A blind spread
  // here would leak the previous runtime's model/permissionMode/additionalArgs
  // into the new runtime — Codex CLI then rejects e.g. a Gemini model with
  // "model is not supported when using ChatGPT account". Route through the
  // helper so the CLI `myagents agent set <id> runtime codex` path stays in
  // lockstep with the Chat / Settings / Launcher in-app paths.
  if (key === 'runtime') {
    if (typeof value !== 'string') {
      return { success: false, error: 'runtime must be a string' };
    }
    if (!VALID_RUNTIMES.includes(value as RuntimeType)) {
      return {
        success: false,
        error: `Unknown runtime: '${value}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
      };
    }
    return modifyAgent(
      id,
      agent => {
        const patch = buildRuntimeChangePatch(
          agent.runtimeConfig as RuntimeConfig | undefined,
          value as RuntimeType,
        );
        return { ...agent, runtime: patch.runtime, runtimeConfig: patch.runtimeConfig };
      },
      'set',
    );
  }

  return modifyAgent(id, agent => ({ ...agent, [key]: value }), 'set');
}

export function handleAgentChannelList(payload: { agentId: string }): AdminResponse {
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === payload.agentId);
  if (!agent) return { success: false, error: `Agent '${payload.agentId}' not found` };

  return { success: true, data: (agent.channels ?? []).map(ch => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
  })) };
}

export async function handleAgentChannelAdd(payload: {
  agentId: string;
  channel: Record<string, unknown>;
}): Promise<AdminResponse> {
  const { agentId, channel } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channel.type) return { success: false, error: 'Missing required field: channel.type' };

  const channelId = channel.id as string || crypto.randomUUID();
  const newChannel: ChannelConfigSlim = {
    ...channel,        // user-provided fields first
    id: channelId,     // override with guaranteed values
    type: channel.type as string,
    name: channel.name as string || `${channel.type} channel`,
    enabled: channel.enabled !== undefined ? !!channel.enabled : true,
  };

  const result = await modifyAgent(agentId, agent => ({
    ...agent,
    channels: [...(agent.channels ?? []), newChannel],
  }), 'channel-add');
  if (result.success) {
    trackServer('agent_channel_create', {
      source: cliSource(),
      platform: newChannel.type,
    });
  }
  return result;
}

export async function handleAgentChannelRemove(payload: { agentId: string; channelId: string }): Promise<AdminResponse> {
  const { agentId, channelId } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channelId) return { success: false, error: 'Missing required field: channelId' };

  // Capture platform BEFORE the channel is removed — once `modifyAgent`
  // commits, the channel is gone and we can't read its type. Best-effort:
  // if the lookup fails (agent missing, channel missing) we still attempt
  // the remove and report `platform: 'unknown'` rather than skipping
  // analytics entirely.
  let platform = 'unknown';
  try {
    const config = loadConfig();
    const agent = (config.agents ?? []).find(a => a.id === agentId);
    const ch = agent?.channels?.find(c => c.id === channelId);
    if (ch?.type) platform = ch.type;
  } catch {
    // Silent — analytics must not affect the main flow.
  }

  const result = await modifyAgent(agentId, agent => ({
    ...agent,
    channels: (agent.channels ?? []).filter(ch => ch.id !== channelId),
  }), 'channel-remove');
  if (result.success) {
    trackServer('agent_channel_remove', { source: cliSource(), platform });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config Handlers
// ---------------------------------------------------------------------------

export function handleConfigGet(payload: { key: string }): AdminResponse {
  const { key } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  const config = loadConfig();
  const value = getNestedValue(config, key);
  if (value === undefined) {
    return { success: false, error: `Config key '${key}' not found` };
  }

  // Redact sensitive fields recursively
  const redacted = redactSensitiveValues(key, value);
  return { success: true, data: { key, value: redacted } };
}

export async function handleConfigSet(payload: { key: string; value: unknown; dryRun?: boolean }): Promise<AdminResponse> {
  const { key, value, dryRun } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Reject dangerous key paths (prototype pollution)
  if (hasDangerousKeySegment(key)) {
    return { success: false, error: 'Invalid key path' };
  }

  if (key.split('.')[0] === 'cliToolRegistryEnabled') {
    return {
      success: false,
      error: "Cannot set 'cliToolRegistryEnabled' via config set. Enable it from Settings → About & Feedback → Lab.",
    };
  }

  // Protect structural/sensitive keys that have dedicated commands
  const protectedKeys = ['providerApiKeys', 'providerVerifyStatus', 'agents', 'mcpServers', 'mcpEnabledServers', 'mcpServerEnv', 'mcpServerArgs', 'imBotConfigs', 'cliToolEnv'];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'myagents mcp', 'myagents agent', 'myagents model set-key').` };
  }

  if (dryRun) {
    return { success: true, dryRun: true, preview: { key, value } };
  }

  await atomicModifyConfig(c => setNestedValue(c, key, value));
  broadcast('config:changed', { section: 'config', action: 'set', key });
  return { success: true, data: { key }, hint: `Config '${key}' updated.` };
}

// ---------------------------------------------------------------------------
// Status & Reload
// ---------------------------------------------------------------------------

export function handleStatus(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = getEnabledMcpServerIds(config);
  const currentMcp = getMcpServers();

  return {
    success: true,
    data: {
      mcpServers: { total: allServers.length, enabled: enabledIds.length },
      activeMcpInSession: currentMcp ? currentMcp.length : 0,
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}

function resolveEffectiveMcpServersForWorkspace(
  config: AdminAppConfig,
  workspacePath: string | undefined,
  source: string,
): McpServerDefinition[] {
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));
  const globallyEnabledServers = () => allServers.filter(s => globalEnabled.has(s.id));

  if (!workspacePath) {
    return globallyEnabledServers();
  }

  const projects = loadProjects();
  const project = projects.find(p => typeof p.path === 'string' && workspacePathsEqual(p.path, workspacePath));
  if (!project) {
    // Treat an unregistered workspace like the no-workspace branch. The admin
    // API should not destructively clear the active session's MCP set just
    // because project metadata is temporarily missing or path identity drifted.
    console.warn(
      `[admin-api] ${source}: workspace ${workspacePath} not found in projects; falling back to global MCP set`,
    );
    return globallyEnabledServers();
  }

  const projectEnabled = new Set(project.mcpEnabledServers ?? []);
  return allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
}

export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read config from disk and push effective MCP + sub-agents to in-memory state.
  // Workspace resolution: prefer explicit arg → fall back to the session's agentDir.
  // Without this fallback, sub-agent reload would only see global agents.
  const effectiveWorkspace = workspacePath || getCurrentWorkspacePath();

  const config = loadConfig();
  const effectiveServers = resolveEffectiveMcpServersForWorkspace(config, effectiveWorkspace, 'handleReload');

  // Sub-agent reload: re-scan the .md files on disk so edits to frontmatter
  // (model, description, tools) take effect without restarting the app.
  // Mirror /api/agents/enabled's resolution — project dir (if any) + user dir.
  //
  // We read BOTH sources of truth (MCP from config.json + agents from .md files)
  // before mutating any in-memory state, so a scan failure doesn't leave the
  // caller with a half-applied reload (MCP pushed but agents stale).
  const home = getHomeDirOrNull();
  const userAgentsBaseDir = home ? join(home, '.myagents', 'agents') : '';
  const projAgentsDir = effectiveWorkspace ? join(effectiveWorkspace, '.claude', 'agents') : '';
  let agents: ReturnType<typeof loadEnabledAgents>;
  try {
    agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin-api] handleReload: sub-agent re-scan failed:', err);
    return {
      success: false,
      error: `Failed to reload sub-agents from disk: ${msg}`,
    };
  }

  // Both sources loaded cleanly — now commit the in-memory state atomically
  // (well, as atomically as two module-level setters allow) and trigger the
  // forced restart that applies them.
  setMcpServers(effectiveServers);
  setAgents(agents);
  const agentCount = Object.keys(agents).length;

  // Force a session restart even for snapshotted (Tab / Cron / Background)
  // sessions — reload is an explicit request, not noise from React state
  // sync. Without this the in-memory config is refreshed but the running
  // SDK subprocess keeps delegating to the old sub-agent definitions (#98).
  forceReloadActiveSession('agents');

  broadcast('config:changed', { section: 'all', action: 'reload' });
  return {
    success: true,
    hint: `Configuration reloaded (MCP: ${effectiveServers.length}, sub-agents: ${agentCount}). The session will restart on the next turn to apply changes.`,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

// Build the runtime enum line from the single source of truth (VALID_RUNTIMES).
// This prevents silent drift between docs and validator — if a runtime is
// added to the RuntimeType union, `--help` picks it up automatically.
const RUNTIMES_ENUM_LINE = VALID_RUNTIMES.join(' | ');

const CLI_TOOL_REGISTRY_DISABLED_HELP = `myagents tool — CLI tool registry

This experimental feature is currently disabled.

Enable it from Settings → About & Feedback → Lab → CLI tool registry before
using 'myagents tool ...'. The stable built-in myagents CLI commands
(cron, thought, im, widget, task, runtime, etc.) remain available.`;

const HELP_TEXTS: Record<string, string> = {
  mcp: `myagents mcp — Manage MCP tool servers

Commands:
  list                     List all MCP servers
  show <id>                Show one MCP server's config + enable state (env/headers redacted; cuse includes resolved binary diagnostics)
  add                      Add a new MCP server
  remove <id>              Remove a custom MCP server
  enable <id>              Enable an MCP server
  disable <id>             Disable an MCP server
  test <id>                Validate MCP server connectivity (cuse also checks resolved binary version)
  env <id> <action>        Manage environment variables
  oauth <action> <id>      Manage OAuth for HTTP/SSE servers

Options for 'add':
  --id          Server ID (required)
  --name        Display name (defaults to id)
  --type        stdio | sse | http (default: stdio)
  --command     Command to run (for stdio)
  --args        Arguments (repeatable)
  --url         Endpoint URL (for sse/http)
  --env         KEY=VALUE (repeatable)
  --headers     KEY=VALUE (repeatable, for sse/http)

Options for 'enable' / 'disable':
  --scope       global | project | both (default: both)

Options for 'env':
  set KEY=VALUE [KEY2=VALUE2 ...]
  get
  delete KEY [KEY2 ...]

OAuth subcommands:
  oauth discover <id>      Probe server for OAuth requirements
  oauth start <id>         Start OAuth authorization (opens browser)
  oauth status <id>        Check OAuth status
  oauth revoke <id>        Revoke stored OAuth token

Options for 'oauth start' (manual mode):
  --client-id      OAuth client ID (skip for auto mode)
  --client-secret  OAuth client secret
  --scopes         Scopes (comma or space separated)
  --callback-port  Local callback port`,

  vision: `myagents vision — Official image-understanding helper

Commands:
  readme                   Show the full image-understanding tool guide
  analyze                  Analyze one or more local workspace image paths

Options for 'analyze':
  --image <path>           Image path inside the current MyAgents workspace (repeatable)
  --prompt-file <path>     Workspace-relative text file with the inspection request
  --prompt '<text>'        Short literal request authored by the agent
  --json                   Output machine-readable JSON

Examples:
  myagents vision readme
  myagents vision analyze --image @myagents_files/screenshot.png --prompt-file inspect.txt

Use --prompt-file for user-provided, multiline, quoted, or shell-sensitive text.
The configured image-understanding model is selected in Settings -> Toolbox.`,

  model: `myagents model — Manage model providers

Commands:
  list                     List all providers (preset + custom)
  add                      Add a custom provider
  remove <id>              Remove a custom provider
  set-key <id> <api-key>   Set API key for a provider
  verify <id> [--model m]  Verify API key (sends a test message)
  set-default <id>         Set default provider

Options for 'add':
  --id            Provider ID (required)
  --name          Display name (required)
  --base-url      API endpoint URL (required)
  --models        Model IDs (repeatable, at least one)
  --model-names   Display names for models (repeatable)
  --primary-model Default model (default: first in --models)
  --auth-type     auth_token | api_key | both (default: auth_token)
  --protocol      anthropic | openai (default: anthropic)
  --upstream-format  chat_completions | responses (openai only)
  --max-output-tokens  Max output limit (openai only)
  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model
  --vendor        Vendor name
  --website-url   Provider website`,

  config: `myagents config — Read/write application config

Commands:
  get <key>               Read a config value
  set <key> <value>       Set a config value`,

  cron: `myagents cron — Manage scheduled tasks

Commands:
  list                     List all cron tasks
  add                      Create a new cron task
  start <id>               Start a stopped task
  stop <id>                Stop a running task
  remove <id>              Delete a task
  update <id>              Update task fields
  runs <id>                View execution history
  status                   Show cron task summary

Options for 'add':
  --name         Task name
  --prompt       AI prompt (required; alias: --message)
  --prompt-file  Read prompt body from a file (preferred for multi-line /
                 quoted / backtick content; max 1 MB)
  --schedule     Either a cron expression (e.g. "*/30 * * * *") OR a JSON
                 CronSchedule object:
                   '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
                   '{"kind":"every","minutes":30}'
                   '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                 On create, non-JSON cron input is stored with the local IANA
                 timezone. JSON "tz" is optional; use it for a different
                 timezone or explicit UTC.
  --every        Interval in minutes (alternative to --schedule)
  --workspace    Workspace path. Defaults to the current session workspace.

Options for 'update' <id>:
  Same flags as add (plus --model, --permissionMode). --message is also
  accepted as an alias for --prompt here.

See 'myagents cron readme' for long-form usage + exit-from-task flow.`,

  goal: `myagents goal — Manage the current session Goal Mode

Goal Mode turns the current MyAgents session into a long-running objective. MyAgents
keeps starting the next turn with the current session context until the Goal is
complete, blocked, or canceled by the user.

Use it when the User explicitly asks to start / enter / use Goal Mode, Goal
Loop, 目标模式, 设立目标, or to keep a goal running continuously until completion.
Do not infer Goal Mode from an ordinary complex request.

Commands:
  get | list                               Show the current session Goal
  create --objective-file <path>            Create a Goal from workspace text
  update --status complete                  Mark the active Goal complete
  update --status blocked                   Mark the active Goal blocked

Use --reason-file <path> when a terminal reason is needed. Goal objective and
reason text are file-only inputs so arbitrary user text never enters a shell
command line.

When to call:
  get
    Use when the user asks what Goal is active, or before making a state change.
    Effect: returns the current session Goal, or null if none is active.

  create
    Use only when the User explicitly asks to start Goal Mode / Goal Loop /
    目标模式 / 设立目标 / continuous goal execution. If this session already has an
    unfinished Goal, creation fails instead of replacing it.
    Effect: creates a current-session Goal and starts automatic continuation.

  update --status complete
    Use only when current evidence proves every requirement in the Goal has
    been satisfied and no required work remains.
    Effect: stops automatic continuation, marks the Goal complete, and notifies
    the user if notifications are enabled.

  update --status blocked
    Use only when the same blocker has repeated for at least three consecutive
    Goal turns and you cannot make meaningful progress without user input or an
    external-state change.
    Effect: stops automatic continuation, marks the Goal blocked, and surfaces
    the reason to the user.

Rules:
  - Do not create a Goal just because a task is long, hard, or multi-step.
  - Do not use update to pause, resume, cancel, or replace a Goal; those are
    controlled by the user/system.
  - Do not mark complete for partial progress, a stopped turn, or a plausible
    final answer without evidence.

Examples:
  myagents goal get
  myagents goal create --objective-file myagents_files/goal-objective.txt
  myagents goal update --status complete
  myagents goal update --status blocked`,

  plugin: `myagents plugin — Manage OpenClaw channel plugins (IM adapters from npm)

Commands:
  list                     List installed plugins
  install <npm-spec>       Install a plugin from npm
  remove <plugin-id>       Uninstall a plugin

Note: for Claude plugins (Anthropic plugin protocol — skills + agents + MCP
+ hooks bundled as a directory), use 'myagents cc-plugin' instead.`,

  'cc-plugin': `myagents cc-plugin — Manage Claude plugins (PRD 0.2.17)

Commands:
  list                                       List installed plugins + enabled state
  install <source>                           Install from owner/repo, github URL,
                                             .zip URL, or file:///abs/path
  uninstall <name|--id ID> [--purgeData]     Remove plugin; data dir kept unless --purgeData
  enable <name|--id ID>                      Enable an installed plugin
  disable <name|--id ID>                     Disable without uninstalling
  show <name|--id ID>                        Show manifest + component inventory

Examples:
  myagents cc-plugin install anthropics/example-plugin
  myagents cc-plugin install https://github.com/foo/bar/tree/v1.0/sub/plugin
  myagents cc-plugin install file:///Users/me/dev/my-plugin
  myagents cc-plugin enable my-plugin
  myagents cc-plugin show my-plugin
  myagents cc-plugin uninstall my-plugin --purgeData

Plugins land in ~/.myagents/plugins/<name>/ and are activated on next session
pre-warm (~1s). Different concept from OpenClaw channel plugins above —
unrelated storage, unrelated semantics.`,

  runtime: `myagents runtime — Inspect Agent Runtimes (v0.1.69+)

Commands:
  list                            List all known runtimes + install status
  describe <runtime>              Show models + permission modes for a runtime

Valid runtimes: ${RUNTIMES_ENUM_LINE}

Examples:
  myagents runtime list                       # which runtimes are installed?
  myagents runtime list --json
  myagents runtime describe codex             # models + permission modes for codex
  myagents runtime describe gemini --json

Why this exists:
  'runtime describe' is the command to consult BEFORE choosing values for
  'task create-direct --runtime / --model / --permissionMode'. The help text
  for those flags intentionally does NOT list models or modes — values depend
  on which CLI you have installed and are dynamic. Use this command instead.`,

  space: `myagents space — Discover Cloud Goals and work with Space Issues

IDENTITY AND SPACE SELECTION
  Start with \`myagents space list --json\`. Every Space business command
  requires an explicit canonical \`--space <slug>\`; there is no implicit
  default. If the current workspace is actively registered in that Space,
  commands act as that Registered Agent. Otherwise they act as the signed-in
  User with the same permissions as the UI. A delivery-bound Session refuses
  identity or workspace mismatches instead of silently falling back to User.
  Run \`myagents space whoami --space <slug> --json\` when identity is unclear.

COMMANDS
  list                                          List available Space slugs
  whoami --space <slug>                         Resolve the actor for this workspace
  goal list --space <slug>                      List Cloud Space Goals and stable IDs
  assignee list --space <slug>                  List valid typed assignee IDs
  issue create --space <slug> ...               Create an Issue, optionally with files
  issue list --space <slug> [filters]           List Issues
  issue view <id> --space <slug> --comments     Read current Issue + latest 5 comments
  issue update <id> --space <slug> ...          Edit title/body/Goal/human-only metadata
  issue comments <id> --space <slug>            Read older comments by cursor
  issue comment get <id> <commentId> ...        Read one complete comment
  issue comment <id> --space <slug> ...         Post text and/or files atomically
  issue attachment add <id> --space <slug> ... Add top-level Issue attachments now
  issue claim|complete|close|status ...          Change Issue state where permitted
  attachment download <id> --space <slug>       Download attachment bytes safely

DISCOVERY FLOW FOR AGENTS
  1. myagents space list --json
  2. myagents space whoami --space <slug> --json
  3. myagents space goal list --space <slug> --json
     myagents space assignee list --space <slug> --json
  4. Create/update using returned stable IDs
  5. myagents space issue view <issueId> --space <slug> --json

GOAL NAMESPACES
  myagents goal ...             Local Session Goal Mode
  myagents space goal list ...  Cloud Space organization Goals

HELP
  Run the exact command with --help for its Agent-oriented contract, for example:
  myagents space goal list --help
  myagents space issue update --help`,

  'space/issue': `myagents space issue — Read and mutate Cloud Space Issues

Commands:
  create                         Publish a new Issue; omit --goal for Inbox
  list                           Discover Issues by Goal, Inbox, state, or text
  view <issueId>                 Read authoritative Issue detail
  update <issueId>               Edit title/body/Goal/human-only metadata
  comments | comment get         Read comments without mutation
  comment | attachment add       Add discussion or top-level evidence
  claim | status | close | complete | cancel-claim
                                 Separate responsibility/workflow mutations

Run an exact leaf with --help before acting. Goal discovery is:
  myagents space goal list --space <slug> --json`,

  'space/list': `myagents space list — Discover canonical Space slugs

WHEN TO CALL
  Before any Space operation when the target slug is unknown or stale.
EFFECT
  Refreshes memberships from Cloud and returns only slug, name, and role.
REQUIRED CONTEXT
  A signed-in MyAgents Space session. This discovery command needs no --space.
OPTIONS
  --json  Return {items:[{slug,name,role}]} for reliable selection.
ACTOR AND PERMISSIONS
  Runs as the signed-in User and exposes only that User's memberships.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  Canonical slugs accepted by every other Space command.
EXAMPLES
  myagents space list --json
RECOVERY
  If the expected Space is absent, verify membership in the Space UI and retry.`,

  'space/whoami': `myagents space whoami — Resolve the effective Space actor

WHEN TO CALL
  Before a mutation when you are unsure whether this workspace acts as User or Registered Agent.
EFFECT
  Resolves and reports the actor, Space, role, and binding source without exposing tokens.
REQUIRED CONTEXT
  --space <slug> is required. Run from the intended workspace.
OPTIONS
  --workspacePath <path>  Recovery override; current working directory is preferred.
  --json                  Return structured identity data.
ACTOR AND PERMISSIONS
  Active matching registration => Registered Agent; otherwise => signed-in User.
  Delivery-bound Sessions never fall back across a binding mismatch.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  Effective actor type/id/name, membership role, and binding source.
EXAMPLES
  myagents space whoami --space myagents --json
RECOVERY
  Run \`myagents space list --json\` if the slug is rejected; remove duplicate registrations if binding is ambiguous.`,

  'space/assignee/list': `myagents space assignee list — List valid assignee targets

WHEN TO CALL
  Before creating an Issue with --assignee.
EFFECT
  Returns all assignee targets the resolved actor may use; it does not mutate an Issue.
REQUIRED CONTEXT
  --space <slug> is required. Run from the intended workspace.
OPTIONS
  --json  Recommended; copy one returned assigneeId exactly.
ACTOR AND PERMISSIONS
  Results are permission-filtered. IDs are typed as agent:<id> or user:<id>;
  never substitute a display name because names may collide.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  items with assigneeId, type, name, isSelf, and Agent owner metadata when applicable.
EXAMPLES
  myagents space assignee list --space myagents --json
RECOVERY
  Run space whoami if expected candidates are missing; do not invent or strip the ID prefix.`,

  'space/goal/list': `myagents space goal list — List the Cloud Goal tree for one Space

WHEN TO CALL
  Before using --goal on space issue create, update, or list. Copy a stable active Goal ID; never guess from a title or path.
EFFECT
  Reads the selected Space's Goal tree only. By default archived Goals are omitted. It does not enter or modify Session Goal Mode.
REQUIRED CONTEXT
  --space <slug> is required. Run from the workspace whose User/Registered Agent identity should be used.
OPTIONS
  --include-archived  Include archived Goals for diagnosis; archived IDs cannot be assigned.
  --json              Recommended; copy one active data.items[].id exactly into --goal.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. It never falls back to User when an Agent binding or Space context is invalid.
FILE SAFETY
  Does not read, write, or upload local files.
OUTPUT
  The full Goal tree with stable id, parentGoalId, depth, context, archivedAt, and goalPathLabel. No pagination.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space goal list --space myagents --include-archived --json
RECOVERY
  Run space list for a valid slug and space whoami for identity. If a write rejects a Goal, list active Goals again and copy a current items[].id.

NOTE
  \`myagents goal ...\` controls local Session Goal Mode. \`myagents space goal list ...\` reads Cloud Space organization Goals; they are different resources.`,

  'space/issue/create': `myagents space issue create — Create a Space Issue atomically

WHEN TO CALL
  When the User or current Agent needs to publish a new request, problem, or work item. Run space goal list before choosing --goal.
EFFECT
  Creates one Issue with its body and optional attachments in one operation. Without --goal it enters Inbox; default is unassigned.
REQUIRED CONTEXT
  --space <slug>, --title <text>, and a non-empty --body or --body-file are required.
OPTIONS
  --goal <goalId>  Optional active ID returned by space goal list. --assignee agent:<id>|user:<id>  Optional typed target.
  --attachment <path>  Repeatable (alias: --file). --human-only  Mark human-only.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. Run assignee list before --assignee.
FILE SAFETY
  Files must be regular non-symlinks inside the current workspace; max 5 files, 25 MB each.
OUTPUT
  The created Issue including goalId, goalPathLabel, and top-level attachment metadata.
EXAMPLES
  myagents space issue create --space myagents --title "Inbox request" --body-file issue.md --json
  myagents space goal list --space myagents --json
  myagents space issue create --space myagents --title "Login fails" --body-file issue.md --goal goal_cli --attachment screenshot.png --json
RECOVERY
  For a rejected Goal, list active Goals again and copy data.items[].id; never guess from title/path. Run whoami for identity and assignee list for a rejected assignee ID.`,

  'space/issue/update': `myagents space issue update — Edit an existing Space Issue's metadata

WHEN TO CALL
  To edit title/body, move a published Issue to an active Space Goal, return it to Inbox, or change human-only metadata.
EFFECT
  Patches only the fields explicitly provided. It does not change workflow state, assignee, claim, comments, or attachments.
REQUIRED CONTEXT
  <issueId>, --space <slug>, and at least one update field are required. Read the current Issue first when acting on a delivery.
OPTIONS
  --title <text>
  --body <text> | --body-file <workspace-relative-path> | --stdin
  --goal <goalId> | --clear-goal
  --human-only <true|false>
  --json
  Goal and body alternatives are mutually exclusive. This command does not support --dry-run.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. Owner/Admin may edit; otherwise only the creator may edit while the Issue is open.
FILE SAFETY
  --body-file must resolve inside the current workspace and is read as text. This command does not upload files.
OUTPUT
  The authoritative updated Issue, including goalId, goalPathLabel, state, assignee, notificationVersion, and updatedAt.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space issue update iss_123 --space myagents --goal goal_cli --json
  myagents space issue update iss_123 --space myagents --clear-goal --json
  myagents space issue update iss_123 --space myagents --title "Updated title" --body-file issue.md --human-only false --json
RECOVERY
  For a rejected Goal, list active Goals again and copy data.items[].id. For a conflict, view the current Issue and retry intentionally. For permission errors, run space whoami.

NOTE
  Omit both --goal and --clear-goal to leave Goal unchanged. Use --clear-goal, never --goal null/inbox/empty, to move the Issue to Inbox.`,

  'space/issue/comment': `myagents space issue comment — Post a comment with optional attachments

WHEN TO CALL
  To add progress, evidence, a reply, or files to an existing Issue.
EFFECT
  Creates one comment and binds all supplied files to that comment atomically; files do not enter the top attachment list.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required. Provide text, files, or both.
OPTIONS
  --body <text> | --body-file <path> | --stdin. --attachment <path> is repeatable (alias: --file).
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent and normal Issue comment permissions.
FILE SAFETY
  Body/files resolve inside the workspace; attachment symlinks and files over 25 MB are rejected; max 5.
OUTPUT
  The created comment with nested attachment metadata.
EXAMPLES
  myagents space issue comment iss_123 --space myagents --body-file reply.md --attachment report.pdf --json
  myagents space issue comment iss_123 --space myagents --attachment evidence.zip --json
RECOVERY
  Use issue view to refresh state. If a file is rejected, choose a regular workspace file and retry the whole atomic operation.`,

  'space/issue/comment/get': `myagents space issue comment get — Read one complete comment

WHEN TO CALL
  When a delivery trigger says a comment is truncated or you need its exact attachment metadata.
EFFECT
  Reads one comment by stable ID without changing delivery or Issue state.
REQUIRED CONTEXT
  <issueId>, <commentId>, and --space <slug> are required.
OPTIONS
  --json  Recommended for body, author, and nested attachments.
ACTOR AND PERMISSIONS
  Uses the resolved actor and normal Issue read permission.
FILE SAFETY
  Does not download attachment bytes; use space attachment download explicitly.
OUTPUT
  One full comment with attachments.
EXAMPLES
  myagents space issue comment get iss_123 comment_456 --space myagents --json
RECOVERY
  Run issue view to verify current IDs if the Issue or comment is not found.`,

  'space/issue/complete': `myagents space issue complete — Complete an Issue with an optional result comment

WHEN TO CALL
  Only after the requested work is actually complete.
EFFECT
  Atomically completes Cloud state with optional result text/files, then safely marks --taskId done.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required. In attached work, pass the local --taskId.
OPTIONS
  --body-file <path>; --attachment <path> repeatable (alias: --file); --taskId <id>; --message <text>.
ACTOR AND PERMISSIONS
  Uses the resolved actor. The actor must own/hold the active assignment or have permitted completion rights.
FILE SAFETY
  Result files must be regular non-symlinks inside the workspace; max 5 files, 25 MB each.
OUTPUT
  Cloud completion, stable operation key, and local Task transition result.
EXAMPLES
  myagents space issue complete iss_123 --space myagents --taskId task_123 --body-file result.md --attachment artifact.zip --json
RECOVERY
  Treat an already-complete response as success. Rerun the same command if only the local Task transition failed.`,

  'space/issue/attachment/add': `myagents space issue attachment add — Add top-level files to a published Issue

WHEN TO CALL
  To supplement the Issue body itself after publication, not to attach files to a comment.
EFFECT
  Uploads files immediately as top-level Issue attachments and emits one Issue update/delivery.
REQUIRED CONTEXT
  <issueId>, --space <slug>, and at least one --file <path> are required.
OPTIONS
  --file <path>  Repeat up to five times. --json  Return attachment metadata.
ACTOR AND PERMISSIONS
  Uses the automatically resolved actor and normal Issue update permissions.
FILE SAFETY
  Each file must be a regular non-symlink inside the workspace and no larger than 25 MB.
OUTPUT
  Added top-level attachment metadata and updated Issue facts.
EXAMPLES
  myagents space issue attachment add iss_123 --space myagents --file report.pdf --file screenshot.png --json
RECOVERY
  Use issue comment instead when the files belong to a new comment.`,

  'space/attachment/download': `myagents space attachment download — Download one attachment

WHEN TO CALL
  After issue/comment metadata gives an attachment id and its bytes are needed.
EFFECT
  Downloads the attachment into the workspace without changing Issue state.
REQUIRED CONTEXT
  <attachmentId> and --space <slug> are required.
OPTIONS
  --output <workspace-relative-path>  Optional safe destination.
ACTOR AND PERMISSIONS
  Uses the resolved actor and verifies the attachment belongs to the selected Space.
FILE SAFETY
  Output stays inside the workspace; unsafe or escaping paths are rejected.
OUTPUT
  Name, relativePath, fullPath, and sizeBytes.
EXAMPLES
  myagents space attachment download att_123 --space myagents --output myagents_files/space/report.pdf --json
RECOVERY
  Re-read the Issue/comment for a current attachment id; verify --space with space list.`,

  'space/issue/list': `myagents space issue list — List Issues in one explicit Space

WHEN TO CALL
  To discover current Issue ids or filter work before reading one Issue.
EFFECT
  Reads Issues only; it does not claim or mutate them.
REQUIRED CONTEXT
  --space <slug> is required.
OPTIONS
  --goal <goalId>|inbox
  --include-subtree <true|false>  Defaults to true when filtering by a Goal ID.
  --state <state> --query <text> --limit <n> --cursor <cursor> --human-only.
  Copy <goalId> from space goal list. "inbox" is only a list filter; it is not the update clear syntax.
ACTOR AND PERMISSIONS
  Uses the resolved User or Registered Agent and returns only visible Issues.
FILE SAFETY
  Does not read or write local files.
OUTPUT
  A cursor-paged Issue list.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space issue list --space myagents --goal goal_product --include-subtree true --state todo --json
  myagents space issue list --space myagents --goal inbox --json
RECOVERY
  Run space list for a valid slug and goal list for a current Goal ID; set --include-subtree false to match only that exact Goal.`,

  'space/issue/get': `myagents space issue view — Read the current server state of one Issue

WHEN TO CALL
  Before acting on an Issue or after receiving a delivery trigger.
EFFECT
  Reads current Issue facts and optionally the latest five comments.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --comments includes the latest five comments; --comments-cursor continues from a known cursor.
ACTOR AND PERMISSIONS
  Uses the resolved actor; visibility matches that actor's Space permissions.
FILE SAFETY
  Returns attachment metadata only; use attachment download for bytes.
OUTPUT
  Issue detail including issue.goalId and issue.goalPathLabel, top-level attachments, latest comments, and claim facts. goalId=null means Inbox in human output.
EXAMPLES
  myagents space issue view iss_123 --space myagents --comments --json
RECOVERY
  List Issues again if the id is stale; Goal reference/context comes from this current server detail, not delivery metadata.`,

  'space/issue/comments': `myagents space issue comments — Page older Issue comments

WHEN TO CALL
  When issue view reports more comments beyond its latest-five window.
EFFECT
  Reads a cursor page without mutating the Issue.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --limit <n> and --cursor <opaque-cursor>.
ACTOR AND PERMISSIONS
  Uses the resolved actor and the same visibility as issue view.
FILE SAFETY
  Returns nested attachment metadata only.
OUTPUT
  Comment items plus hasMore/nextCursor.
EXAMPLES
  myagents space issue comments iss_123 --space myagents --limit 20 --json
RECOVERY
  Re-run issue view to obtain current pagination facts if a cursor is rejected.`,

  'space/issue/status': `myagents space issue status — Change an Issue workflow state

WHEN TO CALL
  Only when the requested workflow transition is intentional.
EFFECT
  Updates Issue state and triggers normal Cloud notification behavior.
REQUIRED CONTEXT
  <issueId>, <state>, and --space <slug> are required.
OPTIONS
  State is positional or --state; use the exact state accepted by Cloud.
ACTOR AND PERMISSIONS
  Uses the resolved actor; Cloud enforces role and ownership rules.
FILE SAFETY
  Does not read local files.
OUTPUT
  Updated state facts.
EXAMPLES
  myagents space issue status iss_123 todo --space myagents --json
RECOVERY
  Read the Issue again and choose a permitted transition; do not retry permission failures blindly.`,

  'space/issue/claim': `myagents space issue claim — Claim responsibility for an Issue

WHEN TO CALL
  When the current Registered Agent will own and process the Issue.
EFFECT
  Creates or reuses the Cloud claim; --create-attached also creates and links a local Task.
REQUIRED CONTEXT
  <issueId> and --space <slug>; delivery flows should also pass --deliveryId.
OPTIONS
  --create-attached plus task metadata links local execution after Cloud claim succeeds.
ACTOR AND PERMISSIONS
  Registered Agent claim rules are Cloud-enforced; User claim behavior follows User permissions.
FILE SAFETY
  Task markdown files must remain inside the workspace.
OUTPUT
  Claim facts and, when requested, the attached Task/session linkage.
EXAMPLES
  myagents space issue claim iss_123 --space myagents --deliveryId del_123 --json
RECOVERY
  Read the current Issue first; if attached Task creation fails, follow the returned rollback/recovery command.`,

  'space/issue/delivery/ignore': `myagents space issue delivery ignore — Ignore one subscription delivery

WHEN TO CALL
  When an unassigned subscription delivery is not relevant to this Registered Agent.
EFFECT
  Marks only that delivery ignored; it does not hide the Issue from other Agents.
REQUIRED CONTEXT
  <deliveryId> and --space <slug> are required.
OPTIONS
  --issueId may add an ownership cross-check when known.
ACTOR AND PERMISSIONS
  Must run as the Registered Agent targeted by the delivery.
FILE SAFETY
  Does not access local files.
OUTPUT
  Updated delivery status.
EXAMPLES
  myagents space issue delivery ignore del_123 --space myagents --issueId iss_123 --json
RECOVERY
  Do not ignore assignment deliveries; read the Issue and claim assigned work instead.`,

  'space/issue/close': `myagents space issue close — Close an Issue without a completion payload

WHEN TO CALL
  When Cloud workflow rules allow the resolved actor to close the Issue directly.
EFFECT
  Transitions the Issue to closed and emits normal updates/deliveries.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  No file options; use issue complete for result comments or attachments.
ACTOR AND PERMISSIONS
  Cloud enforces creator/admin/owner rules.
FILE SAFETY
  Does not read local files.
OUTPUT
  Closed Issue facts.
EXAMPLES
  myagents space issue close iss_123 --space myagents --json
RECOVERY
  Read the Issue and use comment or complete when close is not permitted.`,

  'space/issue/cancel-claim': `myagents space issue cancel-claim — Release the current claim

WHEN TO CALL
  For explicit rollback/recovery of a claim that should no longer be owned.
EFFECT
  Cancels the claim and lets Cloud reopen/refanout according to Issue rules.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --rollback and --expected-notification-version support attached-task recovery.
ACTOR AND PERMISSIONS
  Only the owning actor or an authorized Space role may cancel the claim.
FILE SAFETY
  Does not access local files.
OUTPUT
  Claim cancellation and reopened Issue facts.
EXAMPLES
  myagents space issue cancel-claim iss_123 --space myagents --rollback --json
RECOVERY
  Re-read the Issue if the notification version changed; never fabricate rollback values.`,

  task: `myagents task — Manage Task Center tasks (v0.1.69+)

Commands:
  list                            List tasks (filter via --workspaceId / --status / --tag)
  get <taskId>                    Task metadata + .task/ doc paths
  create-direct <name>            Create a task with inline task.md content
  create-from-alignment <sid>     Materialize a task from an alignment session
  create-attached                 Create a running task attached to the current AI session
  update <taskId>                 Patch task fields (schedule / notification /
                                  prompt / overrides). Rejected while running.
  update-status <taskId> <status> Transition state (running/verifying/done/blocked/stopped)
  append-session <taskId> <sid>   Link an SDK session id to a task
  run <taskId>                    Dispatch a todo task for execution
  rerun <taskId>                  Reset to 'todo' and dispatch
  archive <taskId>                Soft-archive (with 30d retention)
  delete <taskId>                 Hard delete (alias: 'remove' for cron-CLI parity)

Options for 'create-direct':
  --name               Task name (required; may also be the 1st positional)
  --executor           'agent' | 'user' (default: agent)
  --description        Short description
  --workspaceId        Workspace id (required)
  --workspacePath      Absolute workspace path (required)
  --taskMdFile <path>  Read task.md body from a file (preferred for multi-line
                       markdown — avoids shell-escape hell). Max 1 MB.
  --taskMdContent      Inline task.md body (use --taskMdFile instead when
                       content spans multiple lines / has backticks / quotes).
                       Exactly one of --taskMdFile / --taskMdContent must be set.
    --executionMode      'once' | 'scheduled' | 'recurring' (default: once)
  --runMode            'single-session' | 'new-session'
  --tags               Comma-separated tag list
  --sourceThoughtId    Link back to the originating thought

Scheduling (for executionMode = 'recurring' / 'scheduled'; omitting
--intervalMinutes on recurring silently defaults to 60 min — the CLI now
emits a warning when you do):
  --intervalMinutes <n>            Fixed interval in minutes (recurring; min 5)
  --cronExpression "0 */3 * * *"   Cron expression (recurring; takes precedence over interval)
  --cronTimezone Asia/Shanghai     IANA tz id for cronExpression; create-direct
                                  defaults to local timezone when omitted
  --dispatchAt 2026-06-01T09:00:00+08:00  Epoch-ms or ISO 8601 (scheduled mode;
                                          offset/Z required; offset MUST be
                                          +HH:MM, not +HH)

IM / desktop notification (forward to a bot configured via
\`myagents im channels\` — without --notificationBotChannelId the task runs
silently to disk, even if you set --notificationDesktop):
  --notificationBotChannelId <id>  IM bot id (see 'myagents im channels')
  --notificationBotThread <chat>   Override bot routing thread / channel id
  --notificationDesktop true|false Desktop notification toggle (default: true)
  --notificationEvents done,blocked,endCondition  Comma-separated events filter

Per-task RUNTIME overrides (all optional; omit to inherit workspace defaults):
  --runtime            Override runtime (${RUNTIMES_ENUM_LINE})
                       See: myagents runtime list
  --model              Override model — values depend on runtime
                       See: myagents runtime describe <runtime>
  --permissionMode     Override permission mode — values depend on runtime
                       See: myagents runtime describe <runtime>
  --runtimeConfig      JSON string for runtime-specific extra config
  --mcpEnabledServers  Comma-separated MCP ids; "" means explicit no MCP

Options for 'create-from-alignment' (identical override flags):
  Positional: <alignmentSessionId>
  --name               Task name (required)
  --executor --description --workspaceId --workspacePath
  --executionMode --runMode --tags --sourceThoughtId
  --runtime --model --permissionMode --runtimeConfig --mcpEnabledServers

Options for 'create-attached':
  --name                  Task name (required)
  --workspaceId           Workspace id (required)
  --workspacePath         Absolute workspace path (required)
  --taskMdFile <path>     Read task.md body from a file
  --taskMdContent-file <path>
                          Alias accepted by Space Issue workflows
  --taskMdContent         Inline task.md body
  --source space-issue    Required source kind (default: space-issue)
  --sourceIssueId <id>    Space Issue id (required)
  --sourceClaimId <id>    Space Issue claim id
  --sourceSpaceId <id>    Space id
  --sourceDeliveryId <id> Issue delivery id
  Must run inside a MyAgents AI session; current session id comes from
  MYAGENTS_SESSION_ID and is not guessed by the CLI.

Options for 'update' <taskId>:
  Accepts every create-direct flag (each optional; missing = leave unchanged).
  Additional flags for clearing overrides:
    --clearProviderOverride   Reset providerId + model to follow Agent
    --clearRuntimeOverride    Reset runtime + runtimeConfig to follow Agent
    --clearMcpOverride        Reset MCP override to follow Agent
  Update is rejected when the task is Running/Verifying.
  Notification semantics: --notification* flags MERGE with the existing
  config (CLI reads current state, overlays your values, then writes). So
  '--notificationDesktop false' preserves botChannelId / botThread / events.
  To clear bot routing entirely, recreate the task — empty values are
  rejected at the CLI boundary to catch typos.

Options for 'update-status':
  Positional: <taskId> <status>
  --message            Optional message attached to the transition

Output:
  - Default (human-readable) mode prints a compact summary + any override echo.
  - --json returns the full structured payload (task id, overrides, overridden[],
    inheritedFromWorkspace[], nextSteps.{dispatch,inspect,complete}).

Examples:
  myagents task list --workspaceId my-proj
  myagents task create-direct --name "review PR" \\
      --workspaceId my-proj --workspacePath /path/to/my-proj \\
      --taskMdContent "Review the latest PR and file findings in progress.md" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
  # Recurring + IM push — was GUI-only before issue #205
  myagents task create-direct --name "issue triage" \\
      --workspaceId my-proj --workspacePath /path/to/my-proj \\
      --taskMdFile /tmp/triage-prompt.md \\
      --executionMode recurring --intervalMinutes 180 \\
      --notificationBotChannelId feishu_main
  myagents task create-from-alignment sess_abc --name "Ship feature X" --runtime claude-code
  myagents task create-attached --name "Space Issue #123" \\
      --workspaceId my-proj --workspacePath /path/to/my-proj \\
      --taskMdContent-file task.md --source space-issue --sourceIssueId iss_123
  myagents task run t_abc123
  myagents task update t_abc123 --intervalMinutes 240   # change cadence after the fact
  myagents task update-status t_abc123 done --message "shipped in v0.1.70"

Related:
  myagents agent show <id>          Inspect an agent's effective defaults first,
                                    so you know what you are overriding.`,

  im: `myagents im — IM Bot capabilities (run 'myagents im readme' for long-form docs)

Commands:
  channels                            List configured IM bots (works anywhere)
  send-media --file <path> [--caption <text>]
                                      Send a file to the current IM chat (IM session only)
  wake [--text <text>]                Trigger a heartbeat wake (IM session only)
  readme                              Full reference + when-to-use guidance

Use 'myagents im channels' to discover bot ids for --notificationBotChannelId
on 'myagents task create-direct / update'.`,

  thought: `myagents thought — Inbox capture for the user's second brain
(run 'myagents thought readme' for long-form docs)

Commands:
  list                  List thoughts (filter via --tag / --query / --limit)
  create <content>      Capture a new thought (also: --content / --content-file)`,

  widget: `myagents widget — Generative UI widget design guidelines
(run 'myagents widget readme' for the full design system + modules)

Use to render inline charts / SVG / dashboards in desktop Chat replies.
IM bot sessions don't render widgets.`,

  skill: `myagents skill — Manage MyAgents skills (user skills live under ~/.myagents/skills/)

Commands:
  list                       List installed skills + enabled state
  info <name>                Show one skill's manifest + description
  add <url>                  Install from URL / file path
                             [--scope user|project] [--plugin <id>] [--skill <id>]
                             [--force] [--dry-run]
  remove <name>              Uninstall a skill   [--scope user|project]
  enable <name>              Enable an installed skill
  disable <name>             Disable without uninstalling
  sync                       Import skills from Claude Code (~/.claude/skills) into
                             MyAgents. Optional interop only — errors "directory not
                             found" when Claude Code is not installed; your own skills
                             always live under ~/.myagents/skills/ regardless.`,

  tool: `myagents tool — CLI tool registry (user tools live under ~/.myagents/tools/)

Registered tools get a shim on ~/.myagents/bin (already on PATH in every agent
session and terminal) and their description is injected into every new
session's context, so future AI sessions discover them automatically.
Create standards-compliant tools with the tool-creator skill.

Commands:
  list                       List registered tools + enabled state [--json]
  add <dir>                  Register a tool dir (must contain tool.json + entry)
                             [--dry-run]. Copies the dir into ~/.myagents/tools/
                             unless it is already there.
  remove <name>              Unregister (keeps the tool dir; --purge deletes it)
  enable <name>              Show the tool in new sessions' context
  disable <name>             Hide from context (shim stays on PATH)
  info <name>                Show manifest + enabled state + missing env keys
  readme <name>              Run the tool's readme subcommand (full usage doc)
  env <name> get             Show configured env (values redacted)
  env <name> set KEY=VALUE   Set per-tool env (API keys etc.; tool reads at launch)
  env <name> delete KEY      Remove env keys

Notes:
  - Tool names must not shadow existing commands (~/.myagents/bin precedes
    system paths on PATH) — add rejects collisions.
  - description in tool.json is capped at 800 chars (it goes into the system
    prompt of every session).
  - Registry changes affect other sessions at their next start.`,

  diagnose: `myagents diagnose — Diagnostic helpers

Commands:
  diagnose runtime <type>    Inspect why a runtime is not detected / responding.
                             Same as 'myagents runtime diagnose <type>'; the
                             top-level form is provided so AI guesses route
                             to a real handler (issue #194).`,

  agent: `myagents agent — Manage agents & channels

Commands:
  list [--active|--archived]      List all agents
  show <id>                       Show an agent's effective runtime/model/permissionMode defaults
  enable <id>                     Enable an agent
  disable <id>                    Disable an agent
  archive <id>                    Archive an Agent workspace and pause proactive channels
  unarchive <id>                  Restore an archived Agent workspace
  set <id> <key> <value>          Set agent config field
  runtime-status                  Runtime drift status across agents
  channel list <agent-id>         List channels
  channel add <agent-id>          Add a channel
  channel remove <a-id> <ch-id>   Remove a channel

Options for 'channel add':
  --type        telegram | feishu | dingtalk (required)
  --token       Bot token (for telegram)
  --app-id      App ID (for feishu/dingtalk)
  --app-secret  App Secret (for feishu/dingtalk)

Typical flow (AI preparing a task override):
  1. myagents agent show <id>          — learn current defaults
  2. myagents runtime describe <rt>    — see valid model + permission values
  3. myagents task create-direct ... --runtime <rt> --model <m>`,

  session: `myagents session — 跨 session 推送与监听 (PRD 0.2.37)

USAGE
  myagents session send <sessionId> -p "<prompt>" [OPTIONS]
  myagents session send <sessionId> --prompt-file <path> [OPTIONS]
  myagents session watch <sessionId>

DESCRIPTION
  MyAgents 提供跨 session 系统推送能力。所有返回到 AI 上下文里的跨
  session 事件都使用 <myagents-session-event> 协议块。

  send:
    把一条消息异步投送给另一个 session。CLI 立即返回投递结果,不等待
    目标处理。默认情况下,目标 session 本轮完成后,MyAgents 会把最终
    结果自动推送回当前 session,事件类型为 send.result。

    --no-reply 表示 one-way delivery:目标会收到请求或通知,但当前
    session 不会自动收到目标本轮结果。

  watch:
    监听另一个 session 当前/最近的工作结果。watch 不向目标 session
    注入新任务。目标正在运行时会注册 watcher,完成后推送 watch.completed;
    目标注册时已经 idle 时会立即返回 watch.already_idle 和最近结果。

WHEN TO USE
  ✓ 用户希望另一个 session 做新工作、收到通知、补充验证 → send
  ✓ 当前任务依赖另一个 session 的工作,或用户让你监听它 → watch
  ✓ 用户在对话里给了你一个 sessionId,让你与其交互或监听
  ✗ 想答复当前用户——直接回复就行,不要用这个工具
  ✗ 想给 IM peer 发消息——用 \`myagents im send-media\`,不是这个

OPTIONS
  send <sessionId>       目标 session 的 ID(必填)
  -p, --prompt TEXT      send 的消息内容(与 --prompt-file 二选一)
  --prompt-file PATH     send 的消息内容文件路径(适合多行 / 长文本)
  --no-reply             send 单向投递,不把目标结果推回当前 session
  watch <sessionId>      监听目标 session;不接受 prompt / then 参数

ABOUT IDENTITY
  系统会自动用 session 元数据作为对方看到的 label。不要手动指定身份。

PLATFORM NOTE
  Windows 上 cmd.exe 会把 -p 文本中的换行符当成命令边界截断,导致后续
  flag 全部丢失。本 CLI 在 -p 模式下检测到内容含 \\n 或长度 > 4KB 时
  会立即 fail-fast(exit 3),提示你切到 --prompt-file。所有平台行为
  一致——养成统一习惯,长 / 多行内容写到临时文件再传路径。

EXIT CODES
  0   投递成功
  1   sessionId 不存在 / 业务错误
  2   投递失败(目标 sidecar 不可达 / Rust 路由错误等)
  3   参数错误(包括 -p 含 \\n 或超长时的 fail-fast)

EXAMPLES
  # 让目标 session 处理一件事并把结果推回来(最常见,短文本)
  myagents session send sess_abc123 -p "用户希望加上 deepseek 也跑一遍"

  # 仅通知,不期待回应
  myagents session send sess_xyz789 -p "任务已完成,无需回应" --no-reply

  # 多行 / 长文本(必须用 --prompt-file,跨平台稳定)
  myagents session send sess_abc123 --prompt-file /tmp/inbox_msg.txt

  # 当前任务依赖另一个 session 的结果
  myagents session watch sess_abc123

SESSION EVENT NOTES
  你可能在当前 turn 的命令输出或后续系统推送中看到:

    <myagents-session-event type="send.result" ...>
    ...
    </myagents-session-event>

  或:

    <myagents-session-event type="watch.completed" ...>
    ...
    </myagents-session-event>

SEE ALSO
  myagents im send-media     给 IM peer 发消息(不是给 session)`,
};

export function handleHelp(payload: { path?: string[] }): AdminResponse {
  const path = (payload.path ?? []).map(part => part.trim()).filter(Boolean);
  const lookupPath = path[0] === 'space' && path[1] === 'issue' && path[2] === 'view'
    ? [...path.slice(0, 2), 'get', ...path.slice(3)]
    : path;
  const group = path[0];
  let matchedKey: string | undefined;
  for (let length = lookupPath.length; length > 0; length -= 1) {
    const candidate = lookupPath.slice(0, length).join('/');
    if (HELP_TEXTS[candidate]) {
      matchedKey = candidate;
      break;
    }
  }

  if (matchedKey) {
    if (group === 'tool' && !isCliToolRegistryEnabled()) {
      return { success: true, data: { text: CLI_TOOL_REGISTRY_DISABLED_HELP } };
    }
    return { success: true, data: { text: HELP_TEXTS[matchedKey] } };
  }

  // Derive the group list from HELP_TEXTS so it can't drift as new commands
  // are added (issue #205 gap #5: the previous hardcoded list claimed only
  // 8 groups existed and omitted im / task / runtime / cc-plugin / session,
  // turning `myagents im --help` into a misleading "use one of these
  // unrelated groups" message). Append the leaf commands that aren't in
  // HELP_TEXTS but are still valid top-level invocations.
  const groups = [...new Set(Object.keys(HELP_TEXTS).map(key => key.split('/')[0]))].sort();
  const leafCommands = ['status', 'reload', 'version'];
  const header = group
    ? `Unknown command group "${group}".`
    : 'myagents — Available commands';
  return {
    success: true,
    data: {
      text: `${header}

Command groups (run "myagents <group> --help" for details):
  ${groups.join(', ')}

Leaf commands:
  ${leafCommands.join(', ')}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

// Compile-time injected by esbuild (scripts/esbuild-bundle.mjs `define`).
// In dev (`npm run server` via tsx, no esbuild), the identifier is undefined
// at runtime — the `?? process.env.…` chain below reaches the env fallback.
declare const __MYAGENTS_VERSION__: string | undefined;

export function handleVersion(): AdminResponse {
  // Resolution order:
  //   1. esbuild-injected `__MYAGENTS_VERSION__` (production sidecar bundle).
  //   2. `npm_package_version` (set by npm in dev when launched via scripts).
  //   3. `MYAGENTS_VERSION` env override (build system / tests).
  //   4. 'dev' sentinel — visibly NOT a release version, so anyone reading
  //      `myagents version` knows they're on an un-stamped build instead of
  //      seeing a stale hardcoded number that lies about which build is
  //      installed (issue #149: users had no way to tell whether the dmg they
  //      reinstalled actually contained the patched CLI/sidecar — the old
  //      hardcoded '0.1.70' fallback shipped in every release).
  const version = (typeof __MYAGENTS_VERSION__ !== 'undefined' ? __MYAGENTS_VERSION__ : undefined)
    ?? process.env.npm_package_version
    ?? process.env.MYAGENTS_VERSION
    ?? 'dev';
  return { success: true, data: { version } };
}

// ---------------------------------------------------------------------------
// Cron Task forwarding (Admin API → Management API)
//
// Workspace-scoped trust boundary
// -------------------------------
// The Rust Management API treats every cron task as global — it has no
// knowledge of which Sidecar made the call, and `cron/list` without
// `workspacePath` returns ALL tasks across the system. Before v0.2.11 the
// `im-cron` MCP enforced a per-bot/per-workspace ownership guard inside its
// tool handler. Now that cron CRUD flows through `myagents cron …` CLI
// (auto-approved Bash in IM/cron sessions), the same guard MUST be applied
// here at the admin-api boundary. Otherwise a prompt-injected IM bot can
// list and mutate tasks belonging to other workspaces.
//
// The guard works in two parts:
//
//  1. `defaultCronWorkspace()` — derive the active sidecar's "scope
//     workspace" from current IM-cron / session-cron context, falling back
//     to the agentDir. List/create/status calls default to this when the
//     caller didn't pass `--workspace`, matching the old MCP behaviour.
//
//  2. `verifyTaskOwnership(taskId)` — gate mutating ops (update/delete/
//     run-now/start/stop/runs). Calls Rust `cron/list?workspacePath=<scope>`
//     and rejects if `taskId` isn't in the returned set. One extra round-trip
//     per mutation, but Rust is co-resident on loopback so it's <5ms.
//
// Renderer-initiated calls (Settings UI / TaskCenter) come in with explicit
// `workspacePath` and bypass the default; they trust the user, not the AI.
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace this Sidecar should treat as "current" for cron CRUD.
 * Used to default `workspacePath` on AI-initiated `myagents cron` invocations
 * when the AI didn't (or can't) supply one.
 *
 * Resolution order — most-specific to least:
 *   1. IM-cron context (`/api/im/enqueue` sets this for IM bot sessions)
 *   2. Session-cron context (regular non-IM cron-bearing sessions)
 *   3. Sidecar `agentDir` (last-resort default — every Sidecar has one)
 */
function defaultCronWorkspace(): string {
  const imCron = getImCronContext();
  if (imCron?.workspacePath) return imCron.workspacePath;
  const sessionCron = getSessionCronContext();
  if (sessionCron?.workspacePath) return sessionCron.workspacePath;
  return getAgentState().agentDir;
}

/**
 * Verify that `taskId` belongs to the current Sidecar's workspace. Returns
 * `null` on success, an `AdminResponse` rejection otherwise. Replaces the
 * deleted im-cron MCP `verifyTaskOwnership` helper with the same semantics.
 *
 * Performs a `cron/list?workspacePath=<scope>` round-trip and checks
 * membership. The list endpoint returns up to ~100s of rows; for our scale
 * this is cheaper than adding a new owner-check Rust endpoint.
 */
async function verifyCronTaskOwnership(taskId: string): Promise<AdminResponse | null> {
  const workspacePath = defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (!resp.ok) {
    return mgmtError(resp, 'Failed to verify task ownership');
  }
  const tasks = ((resp as Record<string, unknown>).tasks as Array<{ id?: string }> | undefined) ?? [];
  const owned = tasks.some(t => t.id === taskId);
  if (!owned) {
    return {
      success: false,
      error: `Task ${taskId} not found in current workspace. The current session can only manage cron tasks created in its own workspace.`,
    };
  }
  return null;
}

export async function handleCronList(payload: { workspacePath?: string }): Promise<AdminResponse> {
  // Default to current sidecar's workspace if caller didn't specify. Without
  // this, `myagents cron list` from an IM bot returns tasks across every
  // workspace on the system — see ownership-guard rationale above.
  const explicit = Boolean(payload.workspacePath);
  const workspacePath = payload.workspacePath ?? defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (resp.ok) {
    const { scope, hint } = buildCronScope(workspacePath, explicit);
    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [], scope, hint };
  }
  return mgmtError(resp, 'Failed to list cron tasks');
}

export async function handleCronCreate(payload: Record<string, unknown>): Promise<AdminResponse> {
  // Default workspacePath if caller didn't supply one. Rust requires the
  // field; without this default, every AI-issued `myagents cron add` would
  // 400 because the prompt examples (intentionally) don't mention --workspace.
  const resolvedWorkspacePath = (payload.workspacePath as string | undefined)
    || (payload.workspace_path as string | undefined)
    || defaultCronWorkspace();
  const finalPayload: Record<string, unknown> = (payload.workspacePath || payload.workspace_path)
    ? payload
    : { ...payload, workspacePath: resolvedWorkspacePath };
  const schedule = finalPayload.schedule as { kind?: unknown } | undefined;
  if (schedule?.kind === 'loop') {
    return {
      success: false,
      error: 'Loop schedules are Goal Mode tasks. Use myagents goal create --objective-file <path> after writing the objective to that file; do not use myagents cron add.',
    };
  }

  // Issue #149: --dry-run was silently ignored — the previous implementation
  // forwarded payload to Rust regardless, so `cron add --dry-run` would
  // actually write a task to disk. Honor the flag locally before any
  // mutation happens. The preview shape mirrors `mcp add`'s dry-run path
  // (printResult prints `[DRY RUN] Would apply:` when `dryRun: true`
  // appears alongside `preview`).
  if (finalPayload.dryRun) {
    // Strip the flag itself from the preview body so the user sees only
    // the task fields they're actually requesting.
    const { dryRun: _dryRun, ...preview } = finalPayload as Record<string, unknown>;
    return { success: true, dryRun: true, preview };
  }

  const resp = await managementApi('/api/cron/create', 'POST', finalPayload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStop(payload: { taskId: string }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/stop', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStart(payload: { taskId: string }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/run', 'POST', payload);
  return wrapMgmtResponse(resp);
}

/// PRD 0.2.5 R4 — fire one immediate execution without changing schedule.
/// Returns { taskId, sessionId, dispatchedAt } on success; { error, code } on
/// conflict (task currently executing).
export async function handleCronRunNow(payload: { taskId: string }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/trigger', 'POST', payload);
  if (resp.ok) {
    return {
      success: true,
      data: {
        taskId: (resp as Record<string, unknown>).taskId,
        sessionId: (resp as Record<string, unknown>).sessionId,
        dispatchedAt: (resp as Record<string, unknown>).dispatchedAt,
      },
    };
  }
  return mgmtError(resp, 'Failed to trigger cron');
}

export async function handleCronDelete(payload: { taskId: string }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/delete', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronUpdate(payload: { taskId: string; patch: Record<string, unknown> }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/update', 'POST', payload);
  if (resp.ok) {
    // Issue #115 — surface the post-update task summary so CLI can echo
    // `nextExecutionAt` (computed with tz) right after `✓ update`. Avoids
    // the "I just changed schedule, why does the next run show +1h" UX
    // confusion that strict-after-now causes when the user re-checks
    // later via `cron list`.
    return { success: true, data: (resp as Record<string, unknown>).task ?? null };
  }
  return mgmtError(resp, 'Failed to update cron task');
}

export async function handleCronRuns(payload: { taskId: string; limit?: number }): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const qs = `?taskId=${encodeURIComponent(payload.taskId)}${payload.limit ? `&limit=${payload.limit}` : ''}`;
  const resp = await managementApi(`/api/cron/runs${qs}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).runs ?? [] };
  }
  return mgmtError(resp, 'Failed to get cron runs');
}

export async function handleCronStatus(payload: { workspacePath?: string }): Promise<AdminResponse> {
  const explicit = Boolean(payload.workspacePath);
  const workspacePath = payload.workspacePath ?? defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/status${qs}`);
  const wrapped = wrapMgmtResponse(resp);
  // Same workspace-scoping as `cron list` → same "0 ≠ none anywhere" misread
  // guard. The issue's `cron status → Total tasks: 0` came from this path.
  if (wrapped.success) {
    const { scope, hint } = buildCronScope(workspacePath, explicit);
    wrapped.scope = scope;
    wrapped.hint = hint;
  }
  return wrapped;
}

function currentGoalContext(): { sessionId?: string; workspacePath: string; error?: string } {
  const sessionContext = getSessionEngine().getCurrentSessionContext();
  const sessionId = sessionContext.sessionId ?? process.env.MYAGENTS_SESSION_ID;
  if (!sessionId) {
    return {
      workspacePath: sessionContext.workspacePath ?? defaultCronWorkspace(),
      error: 'No current session. Run this command from inside a MyAgents AI session.',
    };
  }
  return {
    sessionId,
    workspacePath: sessionContext.workspacePath ?? defaultCronWorkspace(),
  };
}

export async function handleGoalGet(): Promise<AdminResponse> {
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const resp = await managementApi(`/api/goal/get${qsFrom({
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
  })}`);
  if (resp.ok) {
    return { success: true, data: { goal: (resp as Record<string, unknown>).goal ?? null } };
  }
  return mgmtError(resp, 'Failed to get Goal');
}

export async function handleGoalCreate(payload: { objective?: string }): Promise<AdminResponse> {
  const objective = payload.objective?.trim();
  if (!objective) return { success: false, error: 'Missing required field: objective' };
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const resp = await managementApi('/api/goal/create', 'POST', {
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    objective,
  });
  if (resp.ok) {
    return { success: true, data: { goal: (resp as Record<string, unknown>).goal } };
  }
  return mgmtError(resp, 'Failed to create Goal');
}

export async function handleGoalUpdate(payload: {
  status?: string;
  reason?: string;
}): Promise<AdminResponse> {
  const status = payload.status;
  if (status !== 'complete' && status !== 'blocked') {
    return { success: false, error: 'Goal status must be complete or blocked' };
  }
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const turn = getSessionEngine().getCurrentTurnIdentity();
  if (!turn || turn.owner.kind !== 'goal') {
    return { success: false, error: 'Goal terminal update requires the active Goal turn authority' };
  }
  const reason = payload.reason?.trim() || (status === 'complete' ? 'Goal achieved' : 'Goal blocked');
  const resp = await managementApi('/api/goal/update', 'POST', {
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    goalId: turn.owner.id,
    queueId: turn.queueId,
    status,
    reason,
  });
  if (resp.ok) {
    return { success: true, data: { goal: (resp as Record<string, unknown>).goal } };
  }
  return mgmtError(resp, 'Failed to update Goal');
}

// ---------------------------------------------------------------------------
// Task Center forwarding (v0.1.69)
//
// Trust-boundary note: the CLI stamps `actor` + `source` from its own env
// (AI subprocess = agent/cli, user terminal = user/cli) BEFORE posting here.
// We forward these fields verbatim to the Rust Management API. The renderer-
// originated path (Tauri IPC) never reaches this module — it goes through
// `cmd_task_update_status` in Rust which stamps `user/ui` authoritatively.
// ---------------------------------------------------------------------------

function qsFrom(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function handleTaskList(payload: {
  workspaceId?: string;
  status?: string;
  tag?: string;
  includeDeleted?: boolean;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/task/list${qsFrom(payload)}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [] };
  }
  return mgmtError(resp, 'Failed to list tasks');
}

export async function handleTaskGet(payload: { id: string }): Promise<AdminResponse> {
  const resp = await managementApi(`/api/task/get${qsFrom({ id: payload.id })}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).task };
  }
  return mgmtError(resp, 'Failed to get task');
}

export async function handleTaskCreateDirect(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const validationError = await validateTaskOverrides(payload);
  if (validationError) return validationError;

  const overridden = computeOverriddenFields(payload);
  const resp = await managementApi('/api/task/create-direct', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'manual',
      has_workspace: typeof payload.workspacePath === 'string' && payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

export async function handleTaskCreateFromAlignment(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const validationError = await validateTaskOverrides(payload);
  if (validationError) return validationError;

  const overridden = computeOverriddenFields(payload);
  const resp = await managementApi('/api/task/create-from-alignment', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'thought_dispatch',
      has_workspace: typeof payload.workspacePath === 'string' && payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

export async function handleTaskCreateAttached(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  if (typeof payload.currentSessionId !== 'string' || payload.currentSessionId.trim().length === 0) {
    return {
      success: false,
      error: 'currentSessionId is required; run this command from inside a MyAgents AI session',
    };
  }
  const resp = await managementApi('/api/task/create-attached', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, [], { attached: true });
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'space_issue_attached',
      has_workspace: typeof payload.workspacePath === 'string' && payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

/**
 * Read the task's `sessionIds.length` from Rust before kicking off a run.
 * Returns `null` if the read fails — analytics call sites then fall back to
 * `null` for `run_count` so we don't fabricate a count. Best-effort: a
 * failed pre-fetch does NOT abort the run itself.
 */
async function fetchTaskSessionCount(id: string): Promise<number | null> {
  try {
    const resp = await managementApi(`/api/task/get${qsFrom({ id })}`);
    if (!resp.ok) return null;
    const task = (resp as Record<string, unknown>).task as Record<string, unknown> | undefined;
    const sessions = task?.sessionIds;
    return Array.isArray(sessions) ? sessions.length : null;
  } catch {
    return null;
  }
}

export async function handleTaskRun(payload: { id: string }): Promise<AdminResponse> {
  // Fetch run count BEFORE the run so the analytics value matches the GUI's
  // `task.sessionIds.length + 1` semantic (i.e. "if this run succeeds, it'll
  // be the Nth"). Doing it after would over-count by 1 since the run
  // appends a new sessionId.
  const priorCount = await fetchTaskSessionCount(payload.id);
  const resp = await managementApi('/api/task/run', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_run', {
      source: cliSource(),
      run_count: priorCount !== null ? priorCount + 1 : null,
    });
  }
  return wrapped;
}

export async function handleTaskRerun(payload: { id: string }): Promise<AdminResponse> {
  const priorCount = await fetchTaskSessionCount(payload.id);
  const resp = await managementApi('/api/task/rerun', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_run', {
      source: cliSource(),
      run_count: priorCount !== null ? priorCount + 1 : null,
    });
  }
  return wrapped;
}

/**
 * Enrich a successful task-create response with:
 *   - the override values **as actually persisted** (read from the returned
 *     Task record, not echoed from the request — this proves the round-trip
 *     survived serde rather than just restating what the client sent);
 *   - `overridden` — the list of override fields the caller supplied that
 *     also show up on the persisted task (so "requested but dropped" is
 *     visible as a mismatch);
 *   - `nextSteps` — the next CLI commands the caller is most likely to run.
 *
 * No-op on failed responses (leaves the existing error / recoveryHint shape
 * untouched).
 */
function enrichTaskCreateResponse(
  response: AdminResponse,
  payload: Record<string, unknown>,
  requestedOverrides: string[],
  options: { attached?: boolean } = {},
): AdminResponse {
  if (!response.success) return response;
  const existing = (response.data ?? {}) as Record<string, unknown>;
  // Rust returns `{ task: {...} }` for task creation — unwrap so we can read
  // the authoritative persisted values.
  const persistedTask =
    (existing.task as Record<string, unknown> | undefined)
    ?? existing; // fallback for older Rust shapes that returned the task inline
  const taskId =
    typeof persistedTask.id === 'string'
      ? persistedTask.id
      : typeof existing.task_id === 'string'
        ? existing.task_id
        : typeof existing.taskId === 'string'
          ? existing.taskId
          : undefined;

  // Read the overrides from the persisted Task, NOT from the request payload.
  // If serde dropped a field (e.g., prior to v0.1.69 when `TaskCreateFromAlignmentInput`
  // lacked model/permission_mode), we want the mismatch to be visible here.
  const persistedOverrides = {
    runtime: (persistedTask.runtime as string | undefined) ?? null,
    model: (persistedTask.model as string | undefined) ?? null,
    permissionMode: (persistedTask.permissionMode as string | undefined) ?? null,
    runtimeConfig: persistedTask.runtimeConfig ?? null,
  };

  // The authoritative "overridden" list: fields the caller requested AND that
  // actually landed on the persisted task. If the two diverge, the extra
  // `overridesRequested` field (below) lets the caller detect the drop.
  const fieldsWithValue = Object.entries(persistedOverrides)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k]) => k);

  const enriched: Record<string, unknown> = {
    ...existing,
    overrides: persistedOverrides,
    overridden: fieldsWithValue,
    // If the client requested an override that didn't land, this exposes the
    // drift (a diff between these two arrays means "server silently dropped
    // a field you sent").
    overridesRequested: requestedOverrides,
    inheritedFromWorkspace:
      ['runtime', 'model', 'permissionMode'].filter(f => !fieldsWithValue.includes(f)),
  };
  if (taskId) {
    enriched.nextSteps = options.attached
      ? {
          inspect: `myagents task get ${taskId}`,
          complete: `myagents task update-status ${taskId} done --message "<summary>"`,
        }
      : {
          dispatch: `myagents task run ${taskId}`,
          inspect: `myagents task get ${taskId}`,
        };
  }
  return { ...response, data: enriched };
}

/**
 * Patch a Task's fields after creation. Rust handler reuses `TaskStore::update`,
 * which is rejected on Running/Verifying tasks and projects schedule /
 * notification / override changes back to the linked CronTask. The CLI accepts
 * the same flag set as `task create-direct`, and the same override validator
 * runs first so a bad `--runtime` / `--model` / `--permissionMode` is caught
 * before serde would silently drop it.
 *
 * The payload's `id` field is required by Rust (`TaskUpdateInput.id`); CLI
 * promotes the positional `taskId` into `id` so callers don't have to know
 * the wire field name.
 */
export async function handleTaskUpdate(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return { success: false, error: 'task id is required' };
  }
  const validationError = await validateTaskOverrides(payload);
  if (validationError) return validationError;
  const resp = await managementApi('/api/task/update', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskUpdateStatus(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  // Infer actor/source if caller omitted them:
  //   Inside an AI subprocess → MYAGENTS_PORT is set → actor=agent, source=cli.
  //   Otherwise (user ran `myagents` in their terminal) → actor=user, source=cli.
  // `MYAGENTS_PORT` is injected by `buildClaudeSessionEnv()` into SDK subproc
  // env (see cli_architecture.md); the user's own shell does NOT have it set
  // (the user's CLI binary reads `~/.myagents/sidecar.port` instead).
  if (payload.actor === undefined) {
    payload.actor = process.env.MYAGENTS_PORT ? 'agent' : 'user';
  }
  if (payload.source === undefined) {
    payload.source = 'cli';
  }
  const resp = await managementApi('/api/task/update-status', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  // Only `stopped` counts as a "stop" event in analytics terms — other
  // status transitions (running/done/blocked/etc) flow through the same
  // endpoint but aren't user-initiated stops.
  if (wrapped.success && payload.status === 'stopped') {
    trackServer('task_stop', { source: cliSource() });
  }
  return wrapped;
}

export async function handleTaskAppendSession(payload: {
  id: string;
  sessionId: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/append-session', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskArchive(payload: {
  id: string;
  message?: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/archive', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskDelete(payload: { id: string }): Promise<AdminResponse> {
  // Fetch the task's status BEFORE the delete so we can report it in the
  // analytics event. Best-effort — if the read fails (e.g. id doesn't exist),
  // we still attempt the delete and just report `status: 'unknown'`. We
  // accept the extra round-trip because delete is a low-frequency action
  // and the status field is the most useful dimension for understanding
  // what users are pruning (orphan todos vs. completed work etc.).
  let status = 'unknown';
  try {
    const fetched = await managementApi(`/api/task/get${qsFrom({ id: payload.id })}`);
    if (fetched.ok) {
      const task = (fetched as Record<string, unknown>).task as
        | Record<string, unknown>
        | undefined;
      if (task && typeof task.status === 'string') {
        status = task.status;
      }
    }
  } catch {
    // Silent — analytics must not affect the main flow.
  }
  const resp = await managementApi('/api/task/delete', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_delete', { source: cliSource(), status });
  }
  return wrapped;
}

/**
 * Read a task's markdown doc (`task.md` / `verify.md` / `progress.md` /
 * `alignment.md`). Missing files return `{ ok: true, content: "" }` so
 * CLI scripting is idempotent. Task docs live under `~/.myagents/tasks/<id>/`
 * since v0.1.69 — this endpoint is the agent-facing read path because the
 * AI runs in the workspace cwd and can't know the user-profile dir.
 */
export async function handleTaskReadDoc(payload: {
  id: string;
  doc: string;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    `/api/task/read-doc${qsFrom(payload)}`,
  );
  if (resp.ok) {
    return { success: true, data: { content: (resp as Record<string, unknown>).content ?? '' } };
  }
  return mgmtError(resp, 'Failed to read task doc');
}

/**
 * Write `task.md` or `verify.md`. `progress.md` is agent-appended during
 * runs and rejected here; `alignment.md` is written by the alignment
 * skill via direct file-system access (not through this API).
 */
export async function handleTaskWriteDoc(payload: {
  id: string;
  doc: string;
  content: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/write-doc', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleThoughtList(payload: {
  tag?: string;
  query?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/thought/list${qsFrom(payload)}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).thoughts ?? [] };
  }
  return mgmtError(resp, 'Failed to list thoughts');
}

export async function handleThoughtCreate(payload: {
  content: string;
  images?: string[];
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/thought/create', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    // No `location` for CLI — the field is GUI-specific (launcher vs
    // task_center surface). Set to null so the column type stays uniform.
    trackServer('thought_create', { source: cliSource(), location: null });
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Session-scoped capabilities for external runtimes (v0.1.67)
//
// These handlers expose Pattern 1 (context-injected) MCP tools to the `myagents`
// CLI so the AI running on external runtimes (Claude Code / Codex / Gemini CLI)
// can reach MyAgents-specific capabilities through plain shell tool calls
// instead of a Claude-Agent-SDK-only MCP protocol. See prd_0.1.67.
//
// Authorization model: Sidecar is session-scoped (1 Sidecar = 1 session), so
// most ambient context is already bound to the calling Sidecar. Commands that
// need a durable local Task/session link use MYAGENTS_SESSION_ID explicitly.
// ---------------------------------------------------------------------------

export function handleCronExit(payload: { reason?: string }): AdminResponse {
  const ctx = getCronTaskContext();
  if (!ctx.taskId) {
    return { success: false, error: 'No active cron task in this session. This command only works inside a cron task run.' };
  }
  if (!ctx.canExit) {
    return { success: false, error: 'This cron task has "Allow AI to exit" disabled — only the user can stop it from the UI.' };
  }
  const reason = payload.reason?.trim() || 'AI requested task exit';
  const request = markCronTaskExitRequested(reason) ?? {
    taskId: ctx.taskId,
    reason,
    timestamp: new Date().toISOString(),
  };
  return {
    success: true,
    data: { taskId: request.taskId, reason: request.reason },
    hint: `${CRON_TASK_EXIT_TEXT}. Reason: ${request.reason}`,
  };
}

/**
 * `myagents im wake [--text "..."]` — trigger a heartbeat wake on the current
 * IM bot. Used by AI to nudge itself into the next reasoning cycle when it
 * needs another turn (e.g., long-running task that just produced new state).
 *
 * Only meaningful inside an IM session — there is no "current bot" outside
 * one, so we reject early instead of silently no-oping.
 */
export async function handleImWake(payload: { text?: string }): Promise<AdminResponse> {
  const ctx = getImMediaContext();
  if (!ctx) {
    return {
      success: false,
      error: 'No IM context in this session. `myagents im wake` only works inside an IM Bot / Agent Channel session.',
    };
  }
  const resp = await managementApi('/api/im/wake', 'POST', {
    botId: ctx.botId,
    text: payload.text || undefined,
  });
  if (resp.ok) {
    return { success: true, hint: 'Heartbeat wake triggered.' };
  }
  return mgmtError(resp, 'Failed to trigger wake');
}

/**
 * `myagents im channels` — list all configured IM channels (Telegram /
 * Feishu / DingTalk / OpenClaw plugin bots). Useful for AI to discover what
 * delivery targets are available before creating a cron task that delivers
 * to IM. Works in any session — does not require an active IM context.
 */
export async function handleImChannels(): Promise<AdminResponse> {
  const resp = await managementApi('/api/im/channels');
  if (!resp.ok) {
    return mgmtError(resp, 'Failed to list IM channels');
  }
  // Defensive: Rust contract is `{ ok: true, channels: [...] }`, but a Rust
  // refactor could regress to `null` / object / missing without compile-time
  // help on our side. Validate explicitly so we don't propagate a broken
  // shape to CLI output.
  const channels = Array.isArray(resp.channels)
    ? (resp.channels as Array<Record<string, unknown>>)
    : [];
  return {
    success: true,
    data: { channels },
    hint: channels.length === 0
      ? 'No IM channels configured. The user needs to set up an Agent channel (Telegram/Feishu/DingTalk) in Settings first.'
      : `${channels.length} IM channel${channels.length === 1 ? '' : 's'} configured.`,
  };
}

export async function handleImSendMedia(payload: { filePath?: string; caption?: string }): Promise<AdminResponse> {
  if (!payload.filePath) {
    return { success: false, error: 'Missing required field: --file <absolute-path>' };
  }
  const ctx = getImMediaContext();
  if (!ctx) {
    return { success: false, error: 'No IM context in this session. This command only works inside an IM Bot / Agent Channel session.' };
  }
  // Path traversal guard: prompt-injected AI on an external runtime could be
  // steered into `myagents im send-media --file ~/.ssh/id_rsa` and exfiltrate
  // secrets to the chat peer. assertSafeFilePath canonicalises (dereferencing
  // symlinks) and requires the real path to live under workspace / tmp / the
  // myagents scratch dir. Any other location is rejected with a clear error.
  const { agentDir } = getAgentState();
  let safePath: string;
  try {
    safePath = assertSafeFilePath(payload.filePath, { workspacePath: agentDir });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await managementApi('/api/im/send-media', 'POST', {
    botId: ctx.botId,
    chatId: ctx.chatId,
    platform: ctx.platform,
    filePath: safePath,
    caption: payload.caption,
  });
  if (resp.ok) {
    return {
      success: true,
      data: {
        fileName: (resp as Record<string, unknown>).fileName,
        fileSize: (resp as Record<string, unknown>).fileSize,
      },
      hint: 'File sent to IM chat.',
    };
  }
  return mgmtError(resp, 'Failed to send media');
}

// ---------------------------------------------------------------------------
// Tool readme lookups — progressive disclosure (v0.1.67)
//
// Skill layer pre-injects BRIEF descriptions of these tools into the system
// prompt (system-prompt-cli-tools.ts). When the AI actually needs to use one,
// it calls `myagents X readme` to pull the full usage doc on demand.
// ---------------------------------------------------------------------------

const README_CRON = `myagents cron — Scheduled task management

WHAT
  Create, list, inspect, stop, and delete scheduled AI tasks (cron / interval /
  one-shot). Tasks run inside MyAgents regardless of which runtime the current
  chat uses. A task can deliver results to an IM channel.

TIME SEMANTICS
  MyAgents stores execution facts as absolute instants (UTC internally), but
  recurring wall-clock schedules are defined by cron expression + IANA timezone.

  For recurring "every day at 09:00" style tasks, the default create path is:
    --schedule "0 9 * * *"

  On create, a bare non-JSON --schedule is normalized to the current machine's
  IANA timezone (for example Asia/Shanghai). The timezone field is optional and
  only needed when the user wants a different wall-clock timezone or explicit
  UTC:
    '{"kind":"cron","expr":"0 9 * * *","tz":"America/New_York"}'
    '{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}'

  On update, a bare cron expression keeps the existing cron timezone when the
  previous schedule already had one.

  One-shot schedules are absolute timestamps. Use ISO 8601 with Z or an offset:
    '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'

  When auditing tasks, look at schedule.kind + schedule.expr + schedule.tz first.
  lastExecutedAt / nextExecutionAt are instants; convert them to the schedule's
  timezone before judging what the user configured.

COMMANDS
  list                            List tasks in the current workspace
  status                          Totals + next execution time
  add OPTIONS                     Create a new task
  start <taskId>                  Enable scheduled task (resume from stopped).
                                  Does NOT trigger immediate execution — use
                                  'cron run-now <taskId>' for that.
  run-now <taskId>                Fire one execution immediately without
                                  changing the task's schedule or status.
  stop <taskId>                   Pause a running task
  remove <taskId>                 Delete a task
  update <taskId> OPTIONS         Change name / prompt / schedule
  runs <taskId> [--limit N]       Show recent execution records (output
                                  truncated to 80 chars per row; pass --full
                                  for untruncated output)

STATUS VOCABULARY (in 'list' / 'status' output and --json)
  Two ORTHOGONAL concepts. Don't confuse them.

  status field — the persistent scheduler state:
    Running    Scheduler is enabled. The task fires at its next scheduled
               time (see the 'Next' column). NOT the same as "currently
               executing" — see currentlyExecuting below.
    Stopped    Scheduler is disabled. The task never fires while in this
               state, even when the schedule expression matches. Resume
               with 'cron start <taskId>'.

  currentlyExecuting field (--json) / '*' marker after the ID (plain text):
    A tick is firing this very instant — either a scheduled fire or a
    'cron run-now' invocation. Calling 'cron run-now' on a task whose
    marker is showing returns a busy error.

  status=Running  +  no '*' marker     →  scheduled, not firing right now
  status=Running  +  '*' marker        →  scheduled AND firing this instant
  status=Stopped  +  no '*' marker     →  disabled, not firing
  status=Stopped  +  '*' marker        →  rare; a scheduled tick was already
                                          in flight when the task got stopped

CREATE OPTIONS (myagents cron add ...)
  --name <text>                   Human-readable label (optional)
  --prompt <text>                 The prompt the AI runs each tick. For short
                                  prompts use this. For multi-line / complex
                                  prompts, prefer --prompt-file.
                                  (Alias: --message.)
  --prompt-file <path>            Read prompt body from a file (recommended for
                                  anything longer than ~80 chars — avoids shell
                                  escape issues with quotes, newlines, \`\`\`).
  --every <minutes>               Run every N minutes (min 5)
  --schedule <expr|json>          Either a cron expression, e.g. "0 9 * * *",
                                  OR a JSON CronSchedule object:
                                    '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
                                    '{"kind":"every","minutes":30}'
                                    '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                                  On create, non-JSON cron input is stored with
                                  the current machine's IANA timezone. JSON "tz"
                                  is optional; use it for a different timezone
                                  or explicit UTC.
  --workspace <path>              Workspace the task runs in. Defaults to the
                                  current session workspace.

UPDATE OPTIONS (myagents cron update <taskId> ...)
  --name / --prompt / --message / --schedule / --every / --model / --permissionMode
  (Same semantics as create. --message is an alias for --prompt.)

EXAMPLES
  # Short prompt, 30 min interval
  myagents cron add --name ping --prompt "ping example.com, report latency" --every 30

  # Long prompt from file (the recommended path)
  printf '%s\\n' 'Check the build log for new errors.' \\
    'If errors found, summarize and tag me.' > /tmp/cron-check.txt
  myagents cron add --name build-watch --prompt-file /tmp/cron-check.txt --every 15

  # Wall-clock daily run at 09:00 in this machine's local timezone
  myagents cron add --name daily-report --prompt "write daily report" \\
    --schedule "0 9 * * *"

  # Wall-clock daily run in an explicit non-local timezone
  myagents cron add --name ny-open --prompt "check market open news" \\
    --schedule '{"kind":"cron","expr":"30 9 * * 1-5","tz":"America/New_York"}'

  # Look at recent runs
  myagents cron list
  myagents cron runs <taskId> --limit 5

EXIT FROM INSIDE A TASK (cron scenario only)
  If you are currently running as a cron task AND the task creator enabled
  "Allow AI to exit", call:
    myagents cron exit --reason "goal achieved"
  to mark the task complete and stop future executions.

DO NOT
  Use system cron / crontab / at / launchctl — they can't see MyAgents state.
  Only \`myagents cron\` can create tasks inside MyAgents.`;

const README_IM = `myagents im — IM Bot capabilities

WHAT
  Commands that act on the current IM chat (Telegram / Feishu / DingTalk /
  OpenClaw plugin channels). Most commands only work inside an IM Bot
  session or Agent Channel session; \`channels\` works anywhere.

COMMANDS
  send-media --file <path> [--caption <text>]
      Send a file to the current chat. Images (jpg/png/gif/webp/svg — max
      10 MB) are sent as native photos; everything else (pdf/doc/xls/csv/json/
      audio/video/archives) as a file upload (max 50 MB).
      Write the file first using normal file-writing tools, then call this
      with the absolute path. Use for things the user explicitly wants to
      receive — not for intermediate work files. IM session only.

  wake [--text <text>]
      Trigger a heartbeat wake on the current IM bot. Use this when you've
      done work that produced new state and want to drive the next reasoning
      cycle yourself instead of waiting for the user. Optional --text adds
      a contextual hint into the wake message. IM session only.

  channels
      List configured IM channels (Telegram / Feishu / DingTalk / OpenClaw
      plugin bots) the user has set up. Useful before creating a cron task
      that should deliver results to a specific channel. Works in any
      session — does not require an active IM context.

EXAMPLES
  # Generate a CSV and send it
  myagents im send-media --file /tmp/report.csv --caption "Today's numbers"

  # Send a generated chart image
  myagents im send-media --file /tmp/chart.png

  # Discover available IM channels
  myagents im channels --json

  # Wake yourself with a hint
  myagents im wake --text "build finished, time to summarize"`;

const README_WIDGET = `myagents widget — Generative UI widget design guidelines

WHAT
  Returns the MyAgents widget design system (color palette, component specs, layout rules) and the output format you MUST use to embed an interactive widget in a chat reply. Widgets render inline in the conversation — charts, SVG diagrams, interactive explainers, dashboards.

WHEN TO CALL
  Before outputting your first <generative-ui-widget> tag in a desktop chat reply. Reach for a widget whenever ${WIDGET_TRIGGER_GUIDANCE}

WHEN NOT TO CALL
  - One-line answers, chitchat
  - User explicitly asked for plain text / code / markdown
  - IM bot sessions (widgets only render in the desktop client)

COMMAND
  myagents widget readme <module1> [<module2> ...]

MODULES
  chart         Chart.js line/bar/pie patterns, palette hex values, dashboards
  diagram       SVG flowcharts, architecture diagrams, connectors, markers
  interactive   Sliders, calculators, comparison cards, data records
  dashboard     Combines chart + interactive (multi-chart layouts + controls)
  art           SVG illustration / visual metaphor

EXAMPLES
  myagents widget readme chart
  myagents widget readme chart interactive
  myagents widget readme dashboard

The output begins with the required <generative-ui-widget> output format contract; do not skip reading it.`;

const README_THOUGHT = `myagents thought — Inbox capture for the user's second brain

WHAT
  Lightweight, unstructured idea / TODO entries the user surfaces
  mid-conversation. The full guidance lives in your system prompt's
  <myagents-cli-thought> section — that brief is sufficient. There is no
  expanded readme here (this command is intentionally minimal).

COMMANDS
  list [--tag X] [--limit N] [--json]
      Browse / search the inbox. Use BEFORE create to spot duplicates.

  create '<content>'              # primary form, single-quoted on Linux/macOS
  create --content "<content>"    # explicit flag, works in any shell
  create --content-file <path>    # read content from file (recommended for
                                    multi-line, CJK, or content with shell-
                                    special chars; bypasses any shell quoting
                                    quirk on Windows / pwsh)

  Tag inline with #xxx inside the content body — there is no separate
  --tag flag on create. Run \`myagents thought list\` to browse.

WHEN TO CALL
  Only when the user explicitly asks to record / save / note specific
  content for later ("记一下", "帮我记", "记下来", "remember this", etc.).
  Do not file FYI remarks, brainstorming, or unsolicited ideas.`;

async function spaceManagementResponse(path: string, payload: Record<string, unknown>, hint?: string): Promise<AdminResponse> {
  const resp = await managementApi(path, 'POST', enrichSpaceWorkspaceContext(payload));
  if (!resp.ok) return mgmtError(resp, 'Space command failed');
  return { success: true, data: resp.data, ...(hint ? { hint } : {}) };
}

function enrichSpaceWorkspaceContext(payload: Record<string, unknown>): Record<string, unknown> {
  const requestedPath = typeof payload.workspacePath === 'string' && payload.workspacePath.trim()
    ? payload.workspacePath.trim()
    : undefined;
  const currentPath = getCurrentWorkspacePath();
  const workspacePath = requestedPath ?? currentPath;
  if (!workspacePath) return payload;
  const project = loadProjects().find(item => workspacePathsEqual(item.path, workspacePath));
  return {
    ...payload,
    workspacePath,
    // An explicit id is identity evidence supplied by the caller. Preserve it
    // so Rust can fail closed when it disagrees with a delivery-bound Agent;
    // only enrich legacy/path-only requests that omitted the stable id.
    workspaceId: payload.workspaceId ?? project?.id,
  };
}

export async function handleSpaceList(): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/list', {});
}

export async function handleSpaceWhoami(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/whoami', payload);
}

export async function handleSpaceAssigneeList(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/assignee-list', payload);
}

export async function handleSpaceGoalList(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/goal-list',
    payload,
    'Copy an active data.items[].id into --goal; never use a title or goalPathLabel as the ID.',
  );
}

export async function handleSpaceIssueCreate(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-create', payload, 'Issue created in MyAgents Space.');
}

export async function handleSpaceIssueUpdate(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-update',
    payload,
    'Issue updated in MyAgents Space. Re-read it before the next stateful action.',
  );
}

export async function handleSpaceIssueGet(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-get', payload);
}

export async function handleSpaceIssueList(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-list', payload);
}

export async function handleSpaceIssueComment(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-comment', payload, 'Comment posted to MyAgents Space.');
}

export async function handleSpaceIssueComments(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-comments', payload);
}

export async function handleSpaceIssueCommentGet(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-comment-get', payload);
}

export async function handleSpaceIssueStatus(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-status', payload, 'Issue status updated.');
}

export async function handleSpaceIssueClaim(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-claim', payload, 'Issue claimed.');
}

export async function handleSpaceIssueDeliveryIgnore(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-delivery-ignore', payload, 'Issue delivery ignored.');
}

export async function handleSpaceIssueClose(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-close', payload, 'Issue closed.');
}

export async function handleSpaceIssueComplete(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-complete', payload, 'Issue completed.');
}

export async function handleSpaceIssueCancelClaim(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-cancel-claim', payload, 'Issue claim cancelled.');
}

export async function handleSpaceClaimLocalTask(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/claim-local-task', payload, 'Claim linked to local task.');
}

export async function handleSpaceAttachmentDownload(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/attachment-download', payload);
}

export async function handleSpaceAttachmentAdd(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/attachment-add', payload, 'Issue attachments added.');
}

export async function handleSpaceAttachmentInspect(payload: Record<string, unknown>): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/attachment-inspect', payload);
}

export function handleReadme(payload: { topic?: string; modules?: string[] }): AdminResponse {
  const topic = (payload.topic ?? '').toLowerCase();
  if (topic === 'cron') {
    return { success: true, data: { text: README_CRON } };
  }
  if (topic === 'im' || topic === 'im-media' || topic === 'media') {
    return { success: true, data: { text: README_IM } };
  }
  if (topic === 'thought') {
    return { success: true, data: { text: README_THOUGHT } };
  }
  if (topic === 'widget' || topic === 'generative-ui' || topic === 'ui') {
    const modules = (payload.modules ?? []).filter(m => typeof m === 'string' && m.length > 0);
    if (modules.length === 0) {
      // No modules passed → return the meta-readme describing modules
      return { success: true, data: { text: README_WIDGET } };
    }
    const text = buildReadMeContent(modules);
    // buildReadMeContent returns a generic "Unknown module(s). Available: ..."
    // sentinel when it can't resolve any of the given modules. Surface that as
    // a failure so the CLI exits non-zero and the AI gets a clear error.
    if (text.startsWith('Unknown module(s)')) {
      return { success: false, error: text };
    }
    return { success: true, data: { text } };
  }
  return {
    success: false,
    error: `Unknown readme topic "${payload.topic}". Available: cron, im, widget.`,
  };
}

// ---------------------------------------------------------------------------
// Plugin forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handlePluginList(): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/list');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugins ?? [] };
  }
  return mgmtError(resp, 'Failed to list plugins');
}

export async function handlePluginInstall(payload: { npmSpec: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/install', 'POST', payload);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugin, hint: 'Plugin installed successfully.' };
  }
  return mgmtError(resp, 'Failed to install plugin');
}

export async function handlePluginUninstall(payload: { pluginId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/uninstall', 'POST', payload);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Claude Plugin handlers (PRD 0.2.17) — thin wrappers over the Node Sidecar's
// /api/cc-plugin/* routes. Named "cc-plugin" END-TO-END (admin command, HTTP
// path, store module) to avoid collision with the pre-existing OpenClaw
// channel-plugin commands (`myagents plugin list/install/remove`) above
// which target the Rust Management API at /api/plugin/*. Concepts are
// unrelated: OpenClaw plugins are npm-packaged IM channel adapters, Claude
// plugins are the Anthropic-spec directories containing skills/agents/MCP/
// hooks. Diagnostic curls now resolve unambiguously per process.
//
// Read paths (list / detail) call the store module directly — same process,
// no need for the HTTP loopback hop. Write paths (install / uninstall /
// toggle) go through sidecarSelf so the existing route handler can
// broadcast SSE progress / trigger pre-warm restart; they get the
// skill-tier 330s timeout because a github tarball can easily exceed the
// default 10s.
// ---------------------------------------------------------------------------

export async function handleCcPluginList(): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  return { success: true, data: listInstalledPlugins() };
}

export async function handleCcPluginShow(payload: { id?: string; name?: string }): Promise<AdminResponse> {
  const { listInstalledPlugins, getPluginDetail } = await import('./plugins/store');
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find(p => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const item = getPluginDetail(id);
  if (!item) return { success: false, error: '插件未安装' };
  return { success: true, data: item };
}

export async function handleCcPluginInstall(payload: { sourceUrl?: string; url?: string }): Promise<AdminResponse> {
  const sourceUrl = payload.sourceUrl ?? payload.url;
  if (!sourceUrl) return { success: false, error: 'sourceUrl is required' };
  const { json } = await sidecarSelf(
    '/api/cc-plugin/install',
    'POST',
    { sourceUrl },
    { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
  );
  if (json.success) {
    return { success: true, data: json.entry, hint: 'Plugin installed. Active after the next session pre-warm.' };
  }
  return { success: false, error: typeof json.error === 'string' ? json.error : 'Failed to install plugin' };
}

export async function handleCcPluginUninstall(payload: { id?: string; name?: string; purgeData?: boolean }): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find(p => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const { json } = await sidecarSelf(
    '/api/cc-plugin/uninstall',
    'POST',
    { id, purgeData: !!payload.purgeData },
    // Bumped to skill-tier so directory removal on slow disks (e.g. spinning
    // rust with large node_modules data dirs) doesn't abort half-way.
    { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
  );
  if (json.success) {
    return { success: true, data: json.removed, hint: 'Plugin removed.' };
  }
  return { success: false, error: typeof json.error === 'string' ? json.error : 'Failed to uninstall plugin' };
}

export async function handleCcPluginToggle(payload: { id?: string; name?: string; enabled: boolean }): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find(p => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const { json } = await sidecarSelf('/api/cc-plugin/toggle', 'POST', { id, enabled: payload.enabled });
  if (json.success) {
    return { success: true, data: json.entry, hint: payload.enabled ? 'Plugin enabled.' : 'Plugin disabled.' };
  }
  return { success: false, error: typeof json.error === 'string' ? json.error : 'Failed to toggle plugin' };
}

// ---------------------------------------------------------------------------
// Skill handlers (thin wrappers over /api/skill/* self-loopback)
// ---------------------------------------------------------------------------

export async function handleSkillList(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skills?scope=all');
  if (json.success) {
    return { success: true, data: json.skills ?? [] };
  }
  return { success: false, error: String(json.error ?? 'Failed to list skills') };
}

export async function handleSkillInfo(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(`/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`);
  if (json.success) {
    return { success: true, data: json.skill ?? null };
  }
  return { success: false, error: String(json.error ?? 'Skill not found') };
}

export async function handleSkillAdd(payload: {
  url: string;
  scope?: 'user' | 'project';
  plugin?: string;
  skill?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  if (!payload.url) return { success: false, error: 'url is required' };

  // Step 1: probe (no confirmedSelection) to learn the mode
  const scope = payload.scope ?? 'user';
  const probe = await sidecarSelf('/api/skill/install-from-url', 'POST', {
    url: payload.url,
    scope,
  }, { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS });
  if (!probe.json.success) {
    return { success: false, error: String(probe.json.error ?? 'Install probe failed') };
  }

  const mode = probe.json.mode as string | undefined;

  // Already auto-installed (single, no conflict)
  if (mode === 'installed') {
    if (payload.dryRun) return { success: true, data: probe.json, hint: '[dry-run] would install the above' };
    return {
      success: true,
      data: probe.json,
      hint: `Installed ${(probe.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // Marketplace — require --plugin, install all skills in that plugin
  if (mode === 'marketplace') {
    const preview = probe.json.preview as {
      plugins: Array<{
        name: string;
        description: string;
        skills: Array<{ suggestedFolderName: string; name: string; conflict?: boolean }>;
      }>;
    };
    if (!payload.plugin) {
      return {
        success: false,
        error: '该仓库是 Claude Plugins 市场，请用 --plugin <name> 指定要安装的 plugin 合集',
        data: { availablePlugins: preview.plugins.map(p => ({ name: p.name, description: p.description, skillCount: p.skills.length })) },
      };
    }
    const plugin = preview.plugins.find(p => p.name === payload.plugin);
    if (!plugin) {
      return { success: false, error: `plugin "${payload.plugin}" 不存在` };
    }
    const conflicts = plugin.skills.filter(s => s.conflict).map(s => s.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return {
        success: false,
        error: `以下 skill 已存在：${conflicts.join(', ')}。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would install ${plugin.skills.length} skill(s) from plugin "${plugin.name}"`,
        data: { plugin: plugin.name, skills: plugin.skills.map(s => s.suggestedFolderName) },
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        pluginName: plugin.name,
        folderNames: plugin.skills.map(s => s.suggestedFolderName),
        overwrite: payload.force ? conflicts : [],
      },
    }, { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s) from ${plugin.name}`,
    };
  }

  // Multi — require --skill or install all
  if (mode === 'multi') {
    const preview = probe.json.preview as {
      candidates: Array<{ suggestedFolderName: string; name: string; conflict?: boolean }>;
    };
    let wanted = preview.candidates;
    if (payload.skill) {
      wanted = preview.candidates.filter(
        c => c.name === payload.skill || c.suggestedFolderName === payload.skill,
      );
      if (wanted.length === 0) {
        return {
          success: false,
          error: `未找到 skill "${payload.skill}"。可用：${preview.candidates.map(c => c.suggestedFolderName).join(', ')}`,
        };
      }
    }
    const conflicts = wanted.filter(c => c.conflict).map(c => c.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return { success: false, error: `已存在：${conflicts.join(', ')}。使用 --force 覆盖。` };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would install ${wanted.length} skill(s)`,
        data: { skills: wanted.map(c => c.suggestedFolderName) },
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        folderNames: wanted.map(c => c.suggestedFolderName),
        overwrite: payload.force ? conflicts : [],
      },
    }, { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // single-conflict — need --force to overwrite
  if (mode === 'single-conflict') {
    const preview = probe.json.preview as { skill: { suggestedFolderName: string; name: string } };
    if (!payload.force) {
      return {
        success: false,
        error: `技能 "${preview.skill.suggestedFolderName}" 已存在。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would overwrite "${preview.skill.suggestedFolderName}"`,
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        folderNames: [preview.skill.suggestedFolderName],
        overwrite: [preview.skill.suggestedFolderName],
      },
    }, { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return { success: true, data: commit.json, hint: `Overwrote "${preview.skill.suggestedFolderName}"` };
  }

  return { success: false, error: `未知的 install mode: ${mode}` };
}

export async function handleSkillRemove(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(
    `/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`,
    'DELETE',
  );
  if (json.success) return { success: true, data: { name: payload.name } };
  return { success: false, error: String(json.error ?? 'Failed to remove skill') };
}

export async function handleSkillToggle(payload: { name: string; enabled: boolean }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const { json } = await sidecarSelf('/api/skill/toggle-enable', 'POST', {
    folderName: payload.name,
    enabled: payload.enabled,
  });
  if (json.success) return { success: true, data: { name: payload.name, enabled: payload.enabled } };
  return { success: false, error: String(json.error ?? 'Failed to toggle skill') };
}

export async function handleSkillSync(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skill/sync-from-claude', 'POST', {});
  if (json.success) {
    return {
      success: true,
      data: { synced: json.synced ?? 0, failed: json.failed ?? 0 },
      hint: `Synced ${json.synced ?? 0} skill(s) from ~/.claude/skills`,
    };
  }
  return { success: false, error: String(json.error ?? 'Sync failed') };
}

// ---------------------------------------------------------------------------
// Agent runtime status forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleAgentRuntimeStatus(): Promise<AdminResponse> {
  const resp = await managementApi('/api/agent/runtime-status');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).agents ?? {} };
  }
  return mgmtError(resp, 'Failed to get agent runtime status');
}

// ---------------------------------------------------------------------------
// Runtime discovery handlers (v0.1.69+)
//
// Give AI agents (and humans) a way to answer "what am I allowed to pass to
// --runtime / --model / --permissionMode?" *before* they commit to creating
// a task. Without this, the only feedback loop is "task gets created, task
// fails at dispatch time" — the AI then has to unwind multiple async steps
// to figure out it filled the wrong value.
// ---------------------------------------------------------------------------

/** One row in `runtime list` output. */
interface RuntimeListRow {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
  /** Present when `installed=false` — suggests the install/inspect command. */
  notInstalledHint?: string;
}

/** Payload for `runtime describe <runtime>`. */
interface RuntimeDescribeResult {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  models: RuntimeModelInfo[];
  permissionModes: RuntimePermissionMode[];
  defaultPermissionMode: string;
}

/** Per-runtime detection timeout — a wedged `<cli> --version` binary shouldn't
 *  block the whole command. Race each detect() against this timeout. */
const RUNTIME_DETECT_TIMEOUT_MS = 2_000;

/**
 * Race a promise against a timeout; on timeout resolves to `fallback`.
 * Used by `handleRuntimeList` / `handleRuntimeDescribe` so one misbehaving
 * runtime CLI doesn't hang the whole Admin API request.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * List every runtime MyAgents knows about with its install status.
 *
 * Detection is best-effort and actually gated at `RUNTIME_DETECT_TIMEOUT_MS`
 * per runtime — each runtime's `detect()` spawns `<cli> --version`, and a
 * wedged binary would otherwise block the whole list. We *always* return the
 * full row list — even for not-installed runtimes — so the CLI reader sees
 * every valid `--runtime` value and can learn which ones need installing.
 */
export async function handleRuntimeList(): Promise<AdminResponse> {
  const rows: RuntimeListRow[] = [];
  for (const runtime of VALID_RUNTIMES) {
    if (runtime === 'builtin') {
      // builtin is always "installed" — it's the embedded Claude Agent SDK.
      rows.push({
        runtime,
        displayName: RUNTIME_DISPLAY_NAMES[runtime],
        installed: true,
      });
      continue;
    }
    let detection: RuntimeDetection = { installed: false };
    try {
      const rt = getExternalRuntime(runtime);
      detection = await raceWithTimeout(rt.detect(), RUNTIME_DETECT_TIMEOUT_MS, { installed: false });
    } catch {
      // Runtime not supported in this build (should not happen given
      // VALID_RUNTIMES ⊆ supported types, but keep defensive).
    }
    const row: RuntimeListRow = {
      runtime,
      displayName: RUNTIME_DISPLAY_NAMES[runtime],
      installed: detection.installed,
      version: detection.version,
      path: detection.path,
    };
    if (!detection.installed) {
      row.notInstalledHint = hintForMissingRuntime(runtime);
    }
    rows.push(row);
  }
  return { success: true, data: rows };
}

/**
 * Describe a single runtime — its installed state, available models, and
 * permission modes. This is the command the AI is supposed to consult
 * *before* choosing values for `--model` / `--permissionMode`.
 */
export async function handleRuntimeDescribe(payload: {
  runtime?: string;
}): Promise<AdminResponse> {
  const runtimeArg = payload.runtime;
  if (!runtimeArg) {
    return {
      success: false,
      error: 'Missing required argument: runtime',
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names.',
      },
    };
  }
  if (!isValidRuntimeType(runtimeArg)) {
    return {
      success: false,
      error: `Unknown runtime: '${runtimeArg}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names + install status.',
      },
    };
  }

  // builtin has no external CLI — models come from the configured provider,
  // not a spawnable CLI, so we intentionally return `models: []`. Permission
  // modes DO come from a static allowlist (PermissionMode enum) and are
  // surfaced so `runtime describe builtin` is as useful as `describe codex`.
  if (runtimeArg === 'builtin') {
    return {
      success: true,
      data: {
        runtime: runtimeArg,
        displayName: RUNTIME_DISPLAY_NAMES.builtin,
        installed: true,
        models: [],
        permissionModes: getRuntimePermissionModes('builtin'),
        defaultPermissionMode: getDefaultRuntimePermissionMode('builtin'),
        note:
          'Built-in runtime uses the configured provider + model from `myagents model list`. '
          + 'It does not have a runtime-specific model catalogue — override `--model` with any '
          + 'model id supported by the active provider.',
      } satisfies RuntimeDescribeResult & { note: string },
    };
  }

  let detection: RuntimeDetection = { installed: false };
  try {
    detection = await raceWithTimeout(
      getExternalRuntime(runtimeArg).detect(),
      RUNTIME_DETECT_TIMEOUT_MS,
      { installed: false },
    );
  } catch {
    /* detection returns installed:false below */
  }

  // Only query models when the CLI is actually installed — otherwise we'd
  // waste 10+ seconds trying to spawn a binary that doesn't exist.
  const models: RuntimeModelInfo[] = detection.installed
    ? ((await queryRuntimeModels(runtimeArg)) as RuntimeModelInfo[])
    : [];
  const permissionModes = getRuntimePermissionModes(runtimeArg);
  const defaultPermissionMode = getDefaultRuntimePermissionMode(runtimeArg);

  return {
    success: true,
    data: {
      runtime: runtimeArg,
      displayName: RUNTIME_DISPLAY_NAMES[runtimeArg],
      installed: detection.installed,
      version: detection.version,
      models,
      permissionModes,
      defaultPermissionMode,
    } satisfies RuntimeDescribeResult,
  };
}

/**
 * Run a one-shot runtime diagnostic — spawns a short-lived runtime process,
 * collects what it sees (auth, features, MCP, apps, effective env), and
 * returns the structured snapshot. Used by `myagents diagnose runtime <type>`
 * (issue #194) and the in-app "诊断" button.
 *
 * Codex: spawns `codex app-server`, no thread created.
 * Claude Code / Gemini / builtin: not yet implemented — returns
 * `unsupported` so the CLI can show a clear "not yet supported" message
 * without crashing.
 */
export async function handleRuntimeDiagnose(payload: {
  runtime?: string;
  workspacePath?: string;
}): Promise<AdminResponse> {
  const runtimeArg = payload.runtime;
  if (!runtimeArg) {
    return {
      success: false,
      error: 'Missing required argument: runtime',
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names.',
      },
    };
  }
  if (!isValidRuntimeType(runtimeArg)) {
    return {
      success: false,
      error: `Unknown runtime: '${runtimeArg}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
    };
  }

  // Codex is the only runtime with diagnostic RPCs today. Claude Code's
  // -p mode doesn't expose an equivalent surface (it's one-shot per turn);
  // Gemini's ACP has session-scoped state but no "list features / apps".
  if (runtimeArg !== 'codex') {
    return {
      success: false,
      error: `Diagnostic not yet implemented for runtime '${runtimeArg}'. Only 'codex' is currently supported.`,
      data: { runtime: runtimeArg, supported: false },
    };
  }

  let detection: RuntimeDetection = { installed: false };
  try {
    detection = await raceWithTimeout(
      getExternalRuntime(runtimeArg).detect(),
      RUNTIME_DETECT_TIMEOUT_MS,
      { installed: false },
    );
  } catch { /* falls through to installed:false */ }

  if (!detection.installed) {
    return {
      success: false,
      error: `Codex CLI not installed. ${hintForMissingRuntime('codex')}`,
      data: { runtime: 'codex', installed: false },
    };
  }

  // Resolve the agent's envPolicy so the diagnostic reflects the same proxy
  // policy the real session would use (Codex review #3 catch — without this,
  // CLI diagnose silently reports the legacy `myagents` view even when the
  // agent is configured to inherit terminal or skip proxy entirely).
  //
  // Funnel through the shared helper in `env-utils.ts` so this path validates
  // the `proxy` literal the same way `external-session.ts` does — without
  // shared validation, a malformed `envPolicy.proxy` on disk would silently
  // appear as `'myagents'` in the diagnostic banner, hiding the misconfig.
  const { resolveAgentEnvPolicy } = await import('./runtimes/env-utils');
  const envPolicy = payload.workspacePath
    ? await resolveAgentEnvPolicy(payload.workspacePath)
    : undefined;

  try {
    const rt = getExternalRuntime('codex');
    // Type-check the optional method — only CodexRuntime implements it today.
    if (typeof (rt as { runStandaloneDiagnostics?: unknown }).runStandaloneDiagnostics !== 'function') {
      return {
        success: false,
        error: 'Codex runtime adapter does not expose runStandaloneDiagnostics. Build is out of date.',
      };
    }
    const diagnose = (rt as unknown as {
      runStandaloneDiagnostics: (
        wp?: string,
        policy?: import('../shared/types/runtime').RuntimeEnvPolicy,
      ) => Promise<unknown>;
    }).runStandaloneDiagnostics;
    const diagnostics = await diagnose(payload.workspacePath, envPolicy);
    return {
      success: true,
      data: {
        runtime: 'codex',
        installed: true,
        version: detection.version,
        diagnostics,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Codex diagnostic failed: ${msg}`,
    };
  }
}

/**
 * Show one agent's effective defaults so the AI can decide whether a given
 * task override is a no-op (same as workspace default) or meaningful.
 */
export function handleAgentShow(payload: { id?: string }): AdminResponse {
  const id = payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <agent-id>',
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }

  // AgentConfigSlim is intentionally permissive (`[key: string]: unknown`) —
  // runtime / permissionMode / runtimeConfig exist on the full AgentConfig
  // but not on the slim shape. Extract defensively.
  const runtime = (agent.runtime as RuntimeType | undefined) ?? 'builtin';
  const agentPermissionMode = (agent.permissionMode as string | undefined) ?? '';
  const runtimeConfig = (agent.runtimeConfig as Record<string, unknown> | undefined) ?? undefined;

  // Per-runtime resolution of "effective" model / permissionMode
  // (cross-review fix, v0.1.69):
  //   - builtin       → read from agent.{model, permissionMode}
  //   - CC/Codex/Gemini → prefer agent.runtimeConfig.{model, permissionMode};
  //     fall back to the top-level agent fields only when absent.
  //
  // External runtimes use distinct permission-mode vocabularies (`suggest`,
  // `auto-edit`, `full-auto`, etc.) that do NOT intersect with the builtin
  // enum. Reporting `agent.permissionMode = 'fullAgency'` as the effective
  // value for a Codex agent would be actively misleading — the dispatch
  // path never consults that field.
  const isExternal = runtime !== 'builtin';
  const rcModel = isExternal ? (runtimeConfig?.model as string | undefined) : undefined;
  const rcPermissionMode = isExternal
    ? (runtimeConfig?.permissionMode as string | undefined)
    : undefined;
  const effectiveModel = rcModel ?? (agent.model as string | undefined);
  const effectivePermissionMode = rcPermissionMode ?? agentPermissionMode;

  return {
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      workspacePath: agent.workspacePath,
      effectiveDefaults: {
        runtime,
        model: effectiveModel || null,
        permissionMode: effectivePermissionMode || null,
        providerId: agent.providerId ?? null,
        runtimeConfig: runtimeConfig ?? null,
      },
      channelCount: (agent.channels ?? []).length,
    },
  };
}

/** Type guard for `runtime` string coming from CLI payloads. */
function isValidRuntimeType(runtime: unknown): runtime is RuntimeType {
  return typeof runtime === 'string' && (VALID_RUNTIMES as readonly string[]).includes(runtime);
}

/** Install guidance keyed by runtime. Shown when a runtime is NOT installed. */
function hintForMissingRuntime(runtime: RuntimeType): string {
  switch (runtime) {
    case 'claude-code':
      return 'Install the Claude Code CLI — see https://docs.anthropic.com/claude/docs/claude-code';
    case 'codex':
      return 'Install the OpenAI Codex CLI — `npm i -g @openai/codex` or see https://github.com/openai/codex';
    case 'gemini':
      return 'Install the Gemini CLI — `npm i -g @google/gemini-cli` or see https://github.com/google/gemini-cli';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Task-creation pre-flight validation (v0.1.69+)
//
// Reject bad runtime/model/permissionMode overrides *here* in Node admin-api,
// before the payload hits Rust. Three reasons:
//   1. We have first-class access to `RuntimeFactory.detect()` / queryModels,
//      Rust does not.
//   2. Error strings here can cite the exact CLI recovery command — across
//      the Rust boundary those would turn into opaque serde errors.
//   3. The CLI is the primary caller; keeping validation adjacent to the CLI
//      glue means changes to flag semantics and error copy land in one file.
// ---------------------------------------------------------------------------

/** Fields on a task-create payload that we validate as overrides. */
interface TaskOverrideFields {
  runtime?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  /** Workspace path — used to resolve the agent's default runtime when the
   *  caller passes --model / --permissionMode *without* --runtime. */
  workspacePath?: unknown;
  /** Workspace id — alternative identifier for the same lookup as workspacePath. */
  workspaceId?: unknown;
}

/**
 * Validate the runtime/model/permissionMode fields on a task-create payload.
 * Returns an error `AdminResponse` on first failure, or `null` if all fields
 * are present-and-valid or absent.
 *
 * Effective-runtime resolution (cross-review fix, v0.1.69):
 *   - If `payload.runtime` is set → use it.
 *   - Else if `payload.model` / `payload.permissionMode` is set → resolve the
 *     agent's default runtime from `workspacePath` so we can still validate
 *     the model/mode against the correct allowlist. Without this step a
 *     caller like `--model o3` with no `--runtime` would silently bypass
 *     validation and ship a garbage payload to Rust.
 *   - Else → no overrides at all; nothing to validate.
 */
async function validateTaskOverrides(
  payload: TaskOverrideFields,
): Promise<AdminResponse | null> {
  // Step 1: resolve the effective runtime that downstream checks should use.
  let effectiveRuntime: RuntimeType | undefined;
  if (payload.runtime !== undefined && payload.runtime !== null && payload.runtime !== '') {
    if (typeof payload.runtime !== 'string' || !isValidRuntimeType(payload.runtime)) {
      return {
        success: false,
        error: `Invalid --runtime value: '${String(payload.runtime)}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
        recoveryHint: {
          recoveryCommand: 'myagents runtime list',
          message: 'See valid runtimes + install status.',
        },
      };
    }
    effectiveRuntime = payload.runtime;
    if (effectiveRuntime !== 'builtin' && isRuntimeSupported(effectiveRuntime)) {
      try {
        const detection = await getExternalRuntime(effectiveRuntime).detect();
        if (!detection.installed) {
          return {
            success: false,
            error: `Runtime '${effectiveRuntime}' is not installed on this machine.`,
            recoveryHint: {
              recoveryCommand: 'myagents runtime list',
              message: 'See which runtimes are available + install hints.',
            },
          };
        }
      } catch {
        return {
          success: false,
          error: `Runtime '${effectiveRuntime}' detection failed.`,
          recoveryHint: {
            recoveryCommand: 'myagents runtime list',
            message: 'See which runtimes are available.',
          },
        };
      }
    }
  } else if (
    (payload.model !== undefined && payload.model !== null && payload.model !== '')
    || (payload.permissionMode !== undefined && payload.permissionMode !== null && payload.permissionMode !== '')
  ) {
    // --model / --permissionMode passed without --runtime: try to resolve the
    // workspace's agent default so we can still validate against the correct
    // allowlist. If resolution fails, reject rather than silently trust.
    const resolved = resolveAgentRuntimeFromWorkspace(payload);
    if (resolved === undefined) {
      return {
        success: false,
        error:
          '--model / --permissionMode requires either an explicit --runtime, '
          + 'or a resolvable workspace (via --workspacePath / --workspaceId matching an agent).',
        recoveryHint: {
          recoveryCommand: 'myagents agent list',
          message: 'Find your agent, then `myagents agent show <id>` to see its default runtime.',
        },
      };
    }
    effectiveRuntime = resolved;
  } else {
    // No overrides at all — nothing to validate.
    return null;
  }

  // Step 2: permissionMode is validated against the runtime's allowlist.
  // Works for both builtin (BUILTIN_PERMISSION_MODES: auto/plan/fullAgency/custom)
  // and external runtimes (CC/Codex/Gemini) — since `getRuntimePermissionModes`
  // returns an exhaustive list for every runtime including builtin, we don't
  // need a separate builtin escape hatch. Previously builtin was skipped on
  // the assumption that Rust validates it, but Rust stores the field as
  // `Option<String>` with no enum constraint, so a typo like `--permissionMode
  // fulAgency` would land silently.
  if (
    payload.permissionMode !== undefined
    && payload.permissionMode !== null
    && payload.permissionMode !== ''
  ) {
    if (typeof payload.permissionMode !== 'string') {
      return {
        success: false,
        error: `--permissionMode must be a string (got ${typeof payload.permissionMode}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes.',
        },
      };
    }
    const modes = getRuntimePermissionModes(effectiveRuntime);
    if (modes.length > 0 && !modes.some(m => m.value === payload.permissionMode)) {
      return {
        success: false,
        error: `--permissionMode '${payload.permissionMode}' is not valid for runtime '${effectiveRuntime}'. Valid: ${modes.map(m => m.value).join(', ')}.`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes for this runtime.',
        },
      };
    }
  }

  // Step 3: model is validated for *external* runtimes that expose a known
  // model list. External CLI model lists can be dynamic (Gemini calls the
  // server to discover them) so an empty list is treated as "can't validate,
  // trust the caller". builtin runtime model ids depend on the active
  // provider — out of scope for this validator.
  if (
    payload.model !== undefined
    && payload.model !== null
    && payload.model !== ''
    && effectiveRuntime !== 'builtin'
  ) {
    if (typeof payload.model !== 'string') {
      return {
        success: false,
        error: `--model must be a string (got ${typeof payload.model}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid model ids for this runtime.',
        },
      };
    }
    try {
      const models = (await queryRuntimeModels(effectiveRuntime)) as RuntimeModelInfo[];
      // Empty list means either "runtime is not installed" (handled above)
      // or "discovery failed transiently" — in both cases, don't block the
      // write. The Rust side will surface the real dispatch error if any.
      if (models.length > 0 && !models.some(m => m.value === payload.model)) {
        const examples = models.slice(0, 5).map(m => m.value).filter(Boolean).join(', ');
        return {
          success: false,
          error: `--model '${payload.model}' is not available for runtime '${effectiveRuntime}'. Examples: ${examples || '(none found)'}.`,
          recoveryHint: {
            recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
            message: 'See the full model list.',
          },
        };
      }
    } catch {
      /* swallow — same "trust and forward" rationale as above */
    }
  }

  return null;
}

/**
 * Compute which override fields the caller actually provided.
 * Surfaced in the success response so the AI can confirm its intent took
 * effect (vs. silently falling back to the workspace default).
 */
function computeOverriddenFields(payload: Record<string, unknown>): string[] {
  const fields = ['runtime', 'model', 'permissionMode', 'runtimeConfig'];
  return fields.filter(f => {
    const v = payload[f];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * Look up the workspace's agent from config and return the agent's default
 * runtime (falling back to 'builtin' when unset). Used by `validateTaskOverrides`
 * to decide which runtime's permission-mode / model allowlist to validate
 * against when the caller passes `--model` / `--permissionMode` without
 * `--runtime`.
 *
 * Returns `undefined` when neither `workspacePath` nor `workspaceId` matches
 * an agent — forces the validator to reject rather than guess.
 */
function resolveAgentRuntimeFromWorkspace(
  payload: { workspacePath?: unknown; workspaceId?: unknown },
): RuntimeType | undefined {
  const wsPath = typeof payload.workspacePath === 'string' ? payload.workspacePath : undefined;
  const wsId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
  if (!wsPath && !wsId) return undefined;

  const config = loadConfig();
  const agents = config.agents ?? [];
  // Match by workspacePath first (most specific), then by workspaceId.
  // #320 family: CLI/cron callers send POSIX-style paths while config agents
  // may keep native Windows backslashes — compare on the canonical identity.
  const agent =
    (wsPath && agents.find(a => workspacePathsEqual(a.workspacePath, wsPath)))
    ?? (wsId && agents.find(a => a.id === wsId))
    ?? undefined;
  if (!agent) return undefined;

  const raw = agent.runtime as unknown;
  if (typeof raw === 'string' && isValidRuntimeType(raw)) return raw;
  return 'builtin';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that an ID is safe for use as a filename (prevent path traversal) */
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** Reject dangerous property names to prevent prototype pollution */
function hasDangerousKeySegment(key: string): boolean {
  return key.split('.').some(p => p === '__proto__' || p === 'constructor' || p === 'prototype');
}

// ---------------------------------------------------------------------------
// Provider file I/O (~/.myagents/providers/{id}.json)
// ---------------------------------------------------------------------------

// findProvider, getProvidersDir, loadCustomProviderFiles → imported from admin-config.ts

/** Save a custom provider JSON file */
function saveCustomProviderFile(provider: Record<string, unknown>): void {
  const dir = getProvidersDir();
  ensureDirSync(dir);
  const filePath = resolve(dir, `${provider.id}.json`);
  writeFileSync(filePath, JSON.stringify(provider, null, 2), 'utf-8');
}

/** Delete a custom provider file. Returns true if file existed. */
function deleteCustomProviderFile(id: string): boolean {
  const filePath = resolve(getProvidersDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

type McpScope = 'global' | 'project' | 'both';

function parseMcpScope(scope: string | undefined): McpScope | null {
  if (scope === undefined || scope === '') return 'both';
  if (scope === 'global' || scope === 'project' || scope === 'both') return scope;
  return null;
}

/** Update Sidecar MCP state and notify frontend after config change.
 *  Respects project-scope: only servers enabled both globally AND in the
 *  current workspace project are pushed to the session. */
function notifyMcpChange(action: string, id: string): void {
  const workspacePath = getCurrentWorkspacePath();
  const config = loadConfig();
  const effectiveServers = resolveEffectiveMcpServersForWorkspace(config, workspacePath, 'notifyMcpChange');

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'mcp', action, id });
}

type ProjectMcpMutationResult =
  | { status: 'updated'; workspacePath: string }
  | { status: 'no-workspace' }
  | { status: 'project-not-found'; workspacePath: string };

function projectMcpMutationReason(result: ProjectMcpMutationResult): string {
  if (result.status === 'no-workspace') return 'current session has no workspace';
  if (result.status === 'project-not-found') {
    return `current workspace is not registered (${result.workspacePath})`;
  }
  return 'project updated';
}

function projectMcpMutationFailure(
  action: 'enable' | 'disable',
  id: string,
  result: ProjectMcpMutationResult,
): AdminResponse {
  return {
    success: false,
    error: `Cannot ${action} MCP server '${id}' for project scope: ${projectMcpMutationReason(result)}.`,
    recoveryHint: {
      recoveryCommand: `myagents mcp ${action} ${id} --scope global`,
      message: 'Use global scope, or open/register the target workspace before changing project-scoped MCP settings.',
    },
  };
}

/** Enable MCP for the current workspace project */
async function enableMcpForCurrentProject(serverId: string): Promise<ProjectMcpMutationResult> {
  // The workspace path is set via process-global; use it to find the project
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return { status: 'no-workspace' };

  let result: ProjectMcpMutationResult = { status: 'project-not-found', workspacePath };
  await atomicModifyProjects(projects => {
    const idx = projects.findIndex(p => typeof p.path === 'string' && workspacePathsEqual(p.path, workspacePath));
    if (idx < 0) return projects;

    const project = projects[idx];
    const enabled = new Set(project.mcpEnabledServers ?? []);
    enabled.add(serverId);
    const next = [...projects];
    next[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
    result = { status: 'updated', workspacePath };
    return next;
  });
  return result;
}

/** Disable MCP for the current workspace project */
async function disableMcpForCurrentProject(serverId: string): Promise<ProjectMcpMutationResult> {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return { status: 'no-workspace' };

  let result: ProjectMcpMutationResult = { status: 'project-not-found', workspacePath };
  await atomicModifyProjects(projects => {
    const idx = projects.findIndex(p => typeof p.path === 'string' && workspacePathsEqual(p.path, workspacePath));
    if (idx < 0) return projects;

    const project = projects[idx];
    const enabled = new Set(project.mcpEnabledServers ?? []);
    enabled.delete(serverId);
    const next = [...projects];
    next[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
    result = { status: 'updated', workspacePath };
    return next;
  });
  return result;
}

/** Get workspace path from agent-session (set during session init) */
function getCurrentWorkspacePath(): string | undefined {
  const state = getAgentState();
  return state.agentDir || undefined;
}

/** Modify an agent in config by ID */
async function modifyAgent(
  id: string,
  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,
  action: string,
): Promise<AdminResponse> {
  // Pre-check existence (fast-fail before acquiring write)
  const config = loadConfig();
  if (!(config.agents ?? []).some(a => a.id === id)) {
    return { success: false, error: `Agent '${id}' not found` };
  }

  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs
  await atomicModifyConfig(c => {
    const updated = [...(c.agents ?? [])];
    const freshIdx = updated.findIndex(a => a.id === id);
    if (freshIdx < 0) return c; // agent disappeared between reads — no-op
    updated[freshIdx] = modifier(updated[freshIdx]);
    return { ...c, agents: updated };
  });

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/** Keys and patterns that contain secrets and must be redacted in config get */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;
const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys', 'mcpServerEnv', 'cliToolEnv']);

/** Recursively redact sensitive values in config output */
function redactSensitiveValues(key: string, value: unknown): unknown {
  const rootKey = key.split('.')[0];

  // Top-level known sensitive maps
  if (SENSITIVE_TOP_KEYS.has(rootKey) && typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  // Any key path containing sensitive patterns
  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {
    return redactSecret(value);
  }

  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)
  if (typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  return value;
}

/** Recursively walk an object and redact string values whose keys match sensitive patterns */
function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepRedact(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {
        result[k] = redactSecret(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = deepRedact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

/** Get nested value from object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object by dot-separated key */
function setNestedValue(obj: AdminAppConfig, key: string, value: unknown): AdminAppConfig {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }
  const [first, ...rest] = parts;
  const child = (obj[first] ?? {}) as Record<string, unknown>;
  return { ...obj, [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value) };
}

// ---------------------------------------------------------------------------
// CLI tool registry (PRD 0.2.36 cli_first_tool_registry)
//
// `myagents tool …` + Settings 工具箱 both land here. Registry truth lives on
// disk (~/.myagents/tools/), per-tool env lives in config.cliToolEnv (same
// shape as mcpServerEnv). Prompt injection reads the registry independently
// (system-prompt-cli-tools.ts) — these handlers only mutate disk state, and
// changes take effect for other sessions at their next start / pre-warm.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function requireCliToolRegistryEnabled(): AdminResponse | null {
  if (isCliToolRegistryEnabled()) return null;
  return {
    success: false,
    error: 'CLI tool registry is disabled. Enable it in Settings → About & Feedback → Lab first.',
    recoveryHint: {
      message: '打开「设置 → 关于&反馈 → 实验室 → CLI 工具注册表」后再使用 myagents tool。',
    },
  };
}

/** Registry entry + derived display state (kind badge, unconfigured env keys) */
function enrichCliTool(entry: CliToolRegistryEntry, config?: AdminAppConfig) {
  const cfg = config ?? loadConfig();
  return {
    ...entry,
    kind: deriveCliToolKind(entry.envKeys),
    missingEnvKeys: findMissingEnvKeys(entry, cfg.cliToolEnv),
  };
}

export function handleToolList(): AdminResponse {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const registry = readCliToolsRegistry();
  const config = loadConfig();
  return {
    success: true,
    data: { tools: registry.tools.map((t) => enrichCliTool(t, config)) },
    hint: registry.tools.length === 0
      ? 'No CLI tools registered yet. Create one with the tool-creator skill, then `myagents tool add <dir>`.'
      : undefined,
  };
}

export function handleToolInfo(payload: { name?: string }): AdminResponse {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: { recoveryCommand: 'myagents tool list', message: 'See registered tools.' },
    };
  }
  return { success: true, data: { tool: enrichCliTool(entry) } };
}

export async function handleToolAdd(payload: { dir?: string; dryRun?: boolean }): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { dir, dryRun } = payload;
  if (!dir) {
    return {
      success: false,
      error: 'Missing required field: dir (path to the tool directory containing tool.json)',
      recoveryHint: {
        recoveryCommand: 'myagents tool add ~/.myagents/tools/<name>',
        message: 'The dir must contain tool.json + the entry script (see the tool-creator skill).',
      },
    };
  }
  const srcDir = resolve(dir);

  const read = readCliToolManifest(srcDir);
  if (!read.ok) {
    return {
      success: false,
      error: `[${read.code}] ${read.error}`,
      recoveryHint: read.recovery ? { message: read.recovery } : undefined,
    };
  }
  const manifest = read.manifest;
  try {
    assertCliToolTreeSelfContained(srcDir);
  } catch (e) {
    return {
      success: false,
      error: `[TOOL_DIR_NOT_SELF_CONTAINED] ${(e as Error).message}`,
      recoveryHint: { message: 'Replace symlinks with real files inside the tool directory, then re-run tool add.' },
    };
  }
  const destDir = resolve(join(getCliToolsDir(), manifest.name));
  const needsCopy = srcDir !== destDir;
  const toolDir = needsCopy ? destDir : srcDir;
  const entryPath = join(toolDir, manifest.entry);

  // Re-add of an already-registered name from its canonical dir = REFRESH:
  // re-read manifest into the registry entry (description/version/envKeys/deps),
  // keep enabled + registeredAt + cliToolEnv, rewrite the shim. This is the
  // edit-then-re-add flow; without it the only path was remove→add, which by
  // design drops the tool's stored API keys.
  const existing = readCliToolsRegistry().tools.find((t) => t.name === manifest.name);
  if (existing) {
    if (srcDir !== destDir && srcDir !== resolve(existing.dir)) {
      return {
        success: false,
        error: `CLI tool '${manifest.name}' is already registered (dir: ${existing.dir})`,
        recoveryHint: {
          recoveryCommand: `myagents tool info ${manifest.name}`,
          message: `To update it, edit the tool at ${existing.dir} and re-run tool add there; to replace it, remove first (note: remove drops stored env keys).`,
        },
      };
    }
    if (dryRun) {
      return { success: true, dryRun: true, preview: { name: manifest.name, action: 'refresh', dir: existing.dir } };
    }
    let refreshed: CliToolRegistryEntry | undefined;
    await modifyCliToolsRegistry((reg) => {
      const idx = reg.tools.findIndex((t) => t.name === manifest.name);
      if (idx === -1) return null;
      const tools = [...reg.tools];
      refreshed = {
        ...tools[idx],
        description: manifest.description,
        version: manifest.version,
        envKeys: manifest.envKeys,
        deps: manifest.deps,
        entryPath: join(tools[idx].dir, manifest.entry),
      };
      tools[idx] = refreshed;
      // 锁内重写 shim：与并发 remove 的 shim 删除在同一锁下互斥
      writeCliToolShim(manifest.name, refreshed.entryPath);
      return { ...reg, tools };
    });
    if (!refreshed) {
      return { success: false, error: `CLI tool '${manifest.name}' disappeared during refresh (concurrent remove?)`, recoveryHint: { recoveryCommand: 'myagents tool add ' + srcDir, message: 'Re-run to register it fresh.' } };
    }
    return {
      success: true,
      data: { tool: enrichCliTool(refreshed), refreshed: true },
      hint: 'Refreshed manifest data (description/version/envKeys) and rewrote the shim. Stored env keys and enabled state preserved.',
    };
  }

  // PATH shadow check: ~/.myagents/bin precedes system paths in agent sessions,
  // so a colliding name silently hijacks an existing command everywhere.
  // ensureShellPath(): the sidecar's own PATH is the launchd minimal set under
  // GUI launch — it misses /opt/homebrew/bin etc. and would let brew-installed
  // commands (ffmpeg/jq/gh) slip through the check.
  const collision = findPathCollision(manifest.name, await ensureShellPath());
  if (collision) {
    return {
      success: false,
      error: `[NAME_SHADOWS] Tool name '${manifest.name}' collides with an existing executable (${collision}); registering it would shadow that command in every agent session and terminal`,
      recoveryHint: { message: 'Rename the tool with a domain prefix (update tool.json "name") and re-run tool add.' },
    };
  }

  if (needsCopy) {
    // lstat probe (not existsSync): a broken symlink at dest reads as "absent"
    // to existsSync and then crashes recursive copy (CLAUDE.md v0.2.5 red line).
    let destOccupied = false;
    try {
      lstatSync(destDir);
      destOccupied = true;
    } catch {
      destOccupied = false;
    }
    if (destOccupied) {
      return {
        success: false,
        error: `[DEST_OCCUPIED] ${destDir} already exists but '${manifest.name}' is not registered (leftover from a failed add?)`,
        recoveryHint: { message: `Inspect/remove ${destDir} manually, or register in place by running tool add on that directory.` },
      };
    }
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      preview: {
        name: manifest.name,
        dir: toolDir,
        wouldCopy: needsCopy,
        shim: join(getCliToolsBinDir(), process.platform === 'win32' ? `${manifest.name}.cmd` : manifest.name),
        envKeys: manifest.envKeys ?? [],
      },
    };
  }

  const entry: CliToolRegistryEntry = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    envKeys: manifest.envKeys,
    deps: manifest.deps,
    dir: toolDir,
    entryPath,
    enabled: true,
    registeredAt: new Date().toISOString(),
  };

  let tempDir: string | null = null;
  if (needsCopy) {
    tempDir = join(getCliToolsDir(), `.import-${manifest.name}-${Date.now()}-${crypto.randomUUID()}`);
    try {
      mkdirSync(getCliToolsDir(), { recursive: true });
      await fsCp(srcDir, tempDir, {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
      // Second pass closes the TOCTOU window: if a symlink appeared while fs.cp
      // was walking the source, the staged payload is rejected before publish.
      assertCliToolTreeSelfContained(tempDir);
    } catch (e) {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      return {
        success: false,
        error: `[COPY_FAILED] Failed to stage tool dir for ${destDir}: ${(e as Error).message}`,
        recoveryHint: { message: 'Check the source dir is readable and contains no symlinks, then re-run tool add.' },
      };
    }
  }

  // Publish only after the payload has been staged and re-validated. The
  // duplicate check, final rename, shim write, and registry write stay under the
  // same registry lock so concurrent adds cannot interleave into destDir.
  let duplicate = false;
  let renamedToDest = false;
  let publishError: Error | null = null;
  try {
    await modifyCliToolsRegistry((reg) => {
      if (reg.tools.some((t) => t.name === manifest.name)) {
        duplicate = true;
        return null;
      }
      try {
        if (needsCopy) {
          try {
            lstatSync(destDir);
            publishError = new Error(`${destDir} already exists but '${manifest.name}' is not registered`);
            return null;
          } catch {
            // Absent is the expected publish path.
          }
          renameSync(tempDir!, destDir);
          renamedToDest = true;
          tempDir = null;
        }
        writeCliToolShim(manifest.name, entryPath);
        return { ...reg, tools: [...reg.tools, entry] };
      } catch (e) {
        publishError = e as Error;
        return null;
      }
    });
  } catch (e) {
    publishError = e as Error;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (duplicate) {
    return {
      success: false,
      error: `CLI tool '${manifest.name}' is already registered`,
      recoveryHint: { recoveryCommand: `myagents tool info ${manifest.name}`, message: 'Remove it first if you want to re-register.' },
    };
  }
  if (publishError) {
    removeCliToolShim(manifest.name);
    if (renamedToDest) removeCliToolDir(manifest.name);
    return {
      success: false,
      error: publishError.message.startsWith('[')
        ? publishError.message
        : `[PUBLISH_FAILED] Failed to publish tool '${manifest.name}': ${publishError.message}`,
      recoveryHint: { message: 'Re-run tool add after inspecting the destination directory.' },
    };
  }

  const envHint = (manifest.envKeys ?? []).length > 0
    ? ` It declares env keys [${(manifest.envKeys ?? []).join(', ')}] — set them via \`myagents tool env ${manifest.name} set KEY=value\`.`
    : '';
  return {
    success: true,
    data: { tool: enrichCliTool(entry) },
    hint: `Registered. '${manifest.name}' is on PATH now; other sessions discover it on their next start.${envHint} Tell the user it is manageable under 设置 → 工具箱.`,
  };
}

export async function handleToolRemove(payload: { name?: string; purge?: boolean }): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name, purge } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  let removed: CliToolRegistryEntry | undefined;
  await modifyCliToolsRegistry((reg) => {
    removed = reg.tools.find((t) => t.name === name);
    if (!removed) return null;
    // shim 删除收进同一把锁：与并发 add/refresh 的 shim 写入互斥，
    // 防止 remove 误删一个刚被并发 add 重建的 shim
    removeCliToolShim(name);
    return { ...reg, tools: reg.tools.filter((t) => t.name !== name) };
  });
  if (!removed) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: { recoveryCommand: 'myagents tool list', message: 'See registered tools.' },
    };
  }
  // Drop stored env values with the registration — no stale secrets in config.
  await atomicModifyConfig((c) => {
    if (!c.cliToolEnv?.[name]) return c;
    const cliToolEnv = { ...c.cliToolEnv };
    delete cliToolEnv[name];
    return { ...c, cliToolEnv };
  });
  // Containment guard: only delete dirs at the canonical registry location.
  // entry.dir is invariantly ~/.myagents/tools/<name> today, but a registry
  // file edited by hand could point anywhere — never rm outside our dir.
  const canonicalDir = resolve(join(getCliToolsDir(), name));
  const purgeable = resolve(removed.dir) === canonicalDir;
  if (purge && purgeable) {
    removeCliToolDir(name);
  }
  return {
    success: true,
    data: { name, purged: Boolean(purge && purgeable) },
    hint: purge
      ? (purgeable ? undefined : `Tool dir ${removed.dir} is outside ~/.myagents/tools — not deleted; remove it manually if intended.`)
      : `Tool dir kept at ${removed.dir} (pass --purge to delete it too).`,
  };
}

async function setToolEnabled(name: string | undefined, enabled: boolean): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  if (!name) return { success: false, error: 'Missing required field: name' };
  let found = false;
  await modifyCliToolsRegistry((reg) => {
    const idx = reg.tools.findIndex((t) => t.name === name);
    if (idx === -1) return null;
    found = true;
    if (reg.tools[idx].enabled === enabled) return null;
    const tools = [...reg.tools];
    tools[idx] = { ...tools[idx], enabled };
    return { ...reg, tools };
  });
  if (!found) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: { recoveryCommand: 'myagents tool list', message: 'See registered tools.' },
    };
  }
  return {
    success: true,
    data: { name, enabled },
    hint: enabled
      ? 'Tool will appear in new sessions\' context. (It was on PATH the whole time.)'
      : 'Tool hidden from new sessions\' context; the shim stays on PATH for manual use.',
  };
}

export async function handleToolEnable(payload: { name?: string }): Promise<AdminResponse> {
  return setToolEnabled(payload.name, true);
}

export async function handleToolDisable(payload: { name?: string }): Promise<AdminResponse> {
  return setToolEnabled(payload.name, false);
}

/**
 * Run `<tool> readme` and return its stdout — feeds the Settings 工具箱 detail
 * view so humans read the exact doc the AI reads. Async execFile (never a sync
 * spawn: this runs on the sidecar event loop) with a hard timeout.
 */
export async function handleToolReadme(payload: { name?: string }): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: { recoveryCommand: 'myagents tool list', message: 'See registered tools.' },
    };
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [entry.entryPath, 'readme'], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    });
    return { success: true, data: { name, readme: stdout } };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      success: false,
      error: `Failed to run '${name} readme': ${(err.stderr || err.message || 'unknown error').slice(0, 500)}`,
      recoveryHint: { message: 'The tool may be broken — check its entry script, or remove and re-register it.' },
    };
  }
}

/** Same contract as handleMcpEnv, but against config.cliToolEnv. */
export async function handleToolEnv(payload: {
  name?: string;
  action?: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name, action, env } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: { recoveryCommand: 'myagents tool list', message: 'See registered tools.' },
    };
  }

  if (action === 'get' || action === undefined) {
    const config = loadConfig();
    const toolEnv = (config.cliToolEnv ?? {})[name] ?? {};
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(toolEnv)) {
      redacted[k] = redactSecret(v);
    }
    return {
      success: true,
      data: { name, env: redacted, declaredKeys: entry.envKeys ?? [], missingKeys: findMissingEnvKeys(entry, config.cliToolEnv) },
    };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    // The launcher merges these over process.env — overriding process-level
    // vars would confusingly break the tool's own subprocesses (PATH) or its
    // Node runtime (NODE_OPTIONS). No legitimate tool config needs them.
    const forbidden = Object.keys(env).filter((k) => ['PATH', 'NODE_OPTIONS', 'HOME', 'USERPROFILE'].includes(k.toUpperCase()));
    if (forbidden.length > 0) {
      return {
        success: false,
        error: `Refusing to set process-level variables for a tool: ${forbidden.join(', ')}`,
        recoveryHint: { message: 'Tool env is for API keys and tool-specific config declared in tool.json envKeys.' },
      };
    }
    await atomicModifyConfig((c) => {
      const cliToolEnv = { ...(c.cliToolEnv || {}) };
      cliToolEnv[name] = { ...(cliToolEnv[name] || {}), ...env };
      return { ...c, cliToolEnv };
    });
    return {
      success: true,
      data: { name, keys: Object.keys(env) },
      hint: 'Environment variables updated. The tool reads them at launch — no re-registration needed.',
    };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    await atomicModifyConfig((c) => {
      const cliToolEnv = { ...(c.cliToolEnv || {}) };
      if (cliToolEnv[name]) {
        const toolEnv = { ...cliToolEnv[name] };
        for (const key of Object.keys(env)) {
          delete toolEnv[key];
        }
        if (Object.keys(toolEnv).length === 0) {
          delete cliToolEnv[name];
        } else {
          cliToolEnv[name] = toolEnv;
        }
      }
      return { ...c, cliToolEnv };
    });
    return { success: true, data: { name, deletedKeys: Object.keys(env) } };
  }

  return { success: false, error: `Unknown action: ${String(action)}. Use 'set', 'get', or 'delete'.` };
}
