// GeminiRuntime — drives Google Gemini CLI in ACP mode (v0.1.66)
//
// Communication: JSON-RPC 2.0 over stdio (gemini --acp)
// Process lifecycle: persistent across turns, single process per session (like Codex app-server)
// Protocol: Agent Client Protocol (ACP) — same wire format as Codex but with session/* methods
// System prompt: merged "MyAgents 3-layer + Gemini official prompt" written to a tmp file,
//                injected via GEMINI_SYSTEM_MD environment variable at spawn time
// Session: session/new (fresh) / session/load (resume by sessionId)
// Authentication: entirely delegated to the user's local gemini CLI state (we do NOT manage API keys)

import { spawn, type Subprocess, type SubprocessStdin } from '../utils/subprocess';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import type {
  RuntimeDetection,
  RuntimeModelInfo,
  RuntimePermissionMode,
  RuntimeType,
} from '../../shared/types/runtime';
import { GEMINI_PERMISSION_MODES } from '../../shared/types/runtime';
import type {
  AgentRuntime,
  RuntimeConfigCapabilities,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEvent,
  UnifiedEventCallback,
  ResolvedImagePayload,
} from './types';
import { StaleRuntimeSessionError } from './types';
import { augmentedProcessEnv, resolveCommand, stripAnsi } from './env-utils';
import { resolveGeminiWorkspaceInstructions } from './workspace-instructions';
import { broadcast } from '../sse';
import { ensureDirSync } from '../utils/fs-utils';
import { killWithEscalation } from './utils/kill-with-escalation';
import { withLogContext } from '../logger-context';

// ─── Tmp directory layout for system prompt files ───

const TMP_ROOT = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.myagents', 'tmp', 'gemini-prompts',
);

/** Cached Gemini official system prompt path, keyed by CLI version. */
function baseSystemPromptPath(version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9.\-_]/g, '_') || 'unknown';
  return join(TMP_ROOT, `base-${safe}.md`);
}

/** Per-session merged system prompt path. */
function sessionSystemPromptPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return join(TMP_ROOT, `session-${safe}.md`);
}

/**
 * Ensure TMP_ROOT exists and delete session prompt files older than 1 hour.
 * Base cache files (base-<version>.md) are preserved between sessions.
 *
 * This is the ONLY place session-*.md files are deleted. We deliberately do
 * NOT unlink the file when the gemini Subprocess exits. Reasoning:
 *
 *   1. Windows launcher chain: `resolveCommand('gemini')` resolves to
 *      `gemini.cmd`, a .cmd wrapper that spawns node. The Bun Subprocess
 *      handle is the .cmd launcher, and `proc.exited` firing does NOT prove
 *      the grandchild node process has finished reading GEMINI_SYSTEM_MD
 *      (or even started reading it, on cold-start failure paths). Unlinking
 *      on proc.exited produced the "missing system prompt file" error seen
 *      in issue #95.
 *
 *   2. Filename reuse: `session-<sessionId>.md` is deterministic per session,
 *      so a late proc.exited.then from a failed attempt would delete the
 *      newly-written file of a retry that uses the same session id.
 *
 * Age-based cleanup is safe because Gemini reads GEMINI_SYSTEM_MD only during
 * chat-session init at `session/new`; once the ACP session is established
 * the file is no longer referenced, so letting it linger up to an hour has
 * no functional impact.
 */
function cleanupStaleSessionPrompts(): void {
  try {
    if (!existsSync(TMP_ROOT)) {
      ensureDirSync(TMP_ROOT);
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const file of readdirSync(TMP_ROOT)) {
      if (!file.startsWith('session-')) continue;
      const path = join(TMP_ROOT, file);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Extract Gemini CLI's official system prompt to a version-keyed cache.
 *
 * Strategy: spawn `gemini -p "."` with GEMINI_WRITE_SYSTEM_MD pointing at the cache file.
 * Gemini writes the file during startup (before the API call), so we can poll for it and
 * kill the process as soon as it appears — no token cost.
 *
 * Returns the file contents, or null on failure.
 */
async function extractGeminiBasePrompt(version: string): Promise<string | null> {
  const cachePath = baseSystemPromptPath(version);

  if (existsSync(cachePath)) {
    try {
      const content = readFileSync(cachePath, 'utf8');
      if (content.trim().length > 0) return content;
    } catch {
      /* fall through to extraction */
    }
  }

  ensureDirSync(TMP_ROOT);

  let proc: Subprocess | null = null;
  try {
    proc = spawn([resolveCommand('gemini'), '-p', '.'], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      env: {
        ...augmentedProcessEnv(),
        GEMINI_WRITE_SYSTEM_MD: cachePath,
      },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(cachePath)) {
        try {
          if (statSync(cachePath).size > 0) break;
        } catch {
          /* retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    console.warn('[gemini] extract spawn error:', err);
  } finally {
    if (proc) {
      await killWithEscalation({
        pid: proc.pid,
        kill: signal => proc?.kill(signal),
        waitForExit: () => proc?.exited ?? Promise.resolve(-1),
      }, {
        gracefulMs: 500,
        hardMs: 500,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') {
            console.warn(`[gemini] Base-prompt extraction pid=${info.pid} did not exit; orphan risk remains`);
          }
        },
      });
    }
  }

  if (existsSync(cachePath)) {
    try {
      const content = readFileSync(cachePath, 'utf8');
      if (content.trim().length > 0) {
        console.log(`[gemini] Extracted base system prompt (${content.length} bytes) for v${version}`);
        return content;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Build and write the per-session merged system prompt file.
 *
 * Layout:
 *   <header comment with session id + timestamp>
 *   <MyAgents three-layer prompt (verbatim from options.systemPromptAppend)>
 *   <workspace instructions — cross-runtime protocol, only when GEMINI.md absent>
 *   ---
 *   # Built-in Gemini CLI Guidelines
 *   <Gemini official system prompt verbatim, if extraction succeeded>
 *
 * Returns the path, or null if no MyAgents prompt was supplied (in which case we let
 * Gemini use its built-in default without GEMINI_SYSTEM_MD injection).
 */
async function writeSessionSystemPrompt(
  sessionId: string,
  myAgentsPrompt: string | undefined,
  geminiVersion: string,
  workspacePath?: string,
): Promise<string | null> {
  if (!myAgentsPrompt || myAgentsPrompt.trim().length === 0) return null;

  ensureDirSync(TMP_ROOT);
  const path = sessionSystemPromptPath(sessionId);

  const basePrompt = await extractGeminiBasePrompt(geminiVersion);
  const timestamp = new Date().toISOString();

  let content = `<!-- MyAgents Gemini runtime session prompt, generated at ${timestamp} -->\n`;
  content += `<!-- Session: ${sessionId} -->\n\n`;
  content += myAgentsPrompt.trim() + '\n\n';

  // Cross-runtime workspace protocol: inject workspace instruction files when
  // GEMINI.md is absent. Chain: CLAUDE.md + rules → AGENTS.md → nothing.
  // When GEMINI.md exists, Gemini loads it natively — we skip to avoid duplication.
  if (workspacePath) {
    const workspaceInstructions = resolveGeminiWorkspaceInstructions(workspacePath);
    if (workspaceInstructions) {
      console.log(`[gemini] Injecting workspace instructions (${workspaceInstructions.length} bytes)`);
      content += workspaceInstructions + '\n\n';
    }
  }

  if (basePrompt && basePrompt.trim().length > 0) {
    content += '---\n\n';
    content += '# Built-in Gemini CLI Guidelines\n\n';
    content +=
      'The sections below are the default Gemini CLI operational guidelines. Follow them for ' +
      'tool usage, safety, and tone unless they conflict with the MyAgents instructions above, ' +
      'in which case the MyAgents instructions take precedence.\n\n';
    content += basePrompt.trim() + '\n';
  } else {
    // Base prompt extraction failed (first-run spawn error, gemini CLI not on PATH,
    // or version mismatch). Gemini will run without its built-in tool conventions,
    // safety guidelines, and tone instructions — degrade loudly so operators notice
    // and the model itself has an in-context signal that its usual rails are missing.
    console.warn(
      '[gemini] Base prompt unavailable — Gemini will run without official tool ' +
      'conventions and safety guidelines. Check `gemini` CLI install and PATH.',
    );
    broadcast('chat:log', {
      level: 'warn',
      message:
        'Gemini built-in guidelines unavailable this session (base prompt extraction ' +
        'failed). Tool-use conventions may drift. Verify `gemini` CLI install.',
    });
    content += '---\n\n';
    content += '# Degraded Mode — Built-in Guidelines Unavailable\n\n';
    content +=
      'The default Gemini CLI guidelines could not be loaded for this session. ' +
      'Follow the MyAgents instructions above strictly, and fall back to conservative ' +
      'behavior for tool use and safety when they do not explicitly cover a case.\n';
  }

  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Build Gemini ACP prompt ContentBlock array with optional images.
 * ACP accepts `{ type: 'image', mimeType, data }` with base64 data natively —
 * simpler than Codex's localImage temp-file dance.
 */
function buildGeminiPrompt(text: string, images?: ResolvedImagePayload[]): unknown[] {
  const blocks: unknown[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }
  }
  if (text) {
    blocks.push({ type: 'text', text });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return blocks;
}

// ─── JSON-RPC 2.0 client ───

class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest: ((id: number, method: string, params: unknown) => void) | null = null;
  private encoder = new TextEncoder();
  private sink: SubprocessStdin;
  private reading = false;

  constructor(private proc: Subprocess) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('stdin not available');
    this.sink = stdin;
  }

  setNotificationHandler(h: (method: string, params: unknown) => void): void {
    this.onNotification = h;
  }

  setServerRequestHandler(h: (id: number, method: string, params: unknown) => void): void {
    this.onServerRequest = h;
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

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

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (err) {
      if (String(err).includes('cancel') || String(err).includes('closed')) return;
      console.error('[gemini-rpc] Reader error:', err);
    } finally {
      reader.releaseLock();
      for (const [, { reject }] of this.pending) {
        reject(new Error('gemini --acp process exited'));
      }
      this.pending.clear();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ('id' in msg && !('method' in msg)) {
      const id = msg.id as number;
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { code: number; message: string; data?: { details?: string } };
          // Carry err.data.details into the message: Gemini CLI puts the actionable
          // diagnostic (e.g. `Invalid session identifier "<uuid>"`) here while leaving
          // err.message as the generic "Internal error". Stale-session detection in
          // startSession's catch handler matches against this string.
          const details = typeof err.data?.details === 'string' ? `: ${err.data.details}` : '';
          handler.reject(new Error(`RPC error ${err.code}: ${err.message}${details}`));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    if ('method' in msg && !('id' in msg)) {
      this.onNotification?.(msg.method as string, msg.params);
      return;
    }

    if ('method' in msg && 'id' in msg) {
      this.onServerRequest?.(msg.id as number, msg.method as string, msg.params);
      return;
    }
  }

  private write(msg: unknown): void {
    // Fire-and-forget; Node stdin buffer + Promise completion handle back-pressure.
    void this.sink.write(this.encoder.encode(JSON.stringify(msg) + '\n')).catch(() => { /* stdin may be closed */ });
  }

  destroy(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error('Client destroyed'));
    }
    this.pending.clear();
  }
}

// ─── Per-session state ───

interface PendingToolCall {
  toolName: string;
  emittedStart: boolean;
  emittedStop: boolean;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

class GeminiProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  rpc: JsonRpcClient;
  sessionId = '';
  defaultMode = 'autoEdit';

  /** Callback registered by startSession() — sendMessage() routes async events through this. */
  wrappedOnEvent: UnifiedEventCallback | null = null;

  /** Dedup tool_use_start/stop across ACP's tool_call + tool_call_update + request_permission paths. */
  toolState = new Map<string, PendingToolCall>();

  /** Options snapshot for each in-flight permission request, keyed by JSON-RPC id. */
  pendingPermissionOptions = new Map<number, PermissionOption[]>();

  /** Thinking block tracking — agent_thought_chunk doesn't carry an index from Gemini. */
  thinkingIndex = 0;
  thinkingActive = false;

  /**
   * When true, session/update notifications are treated as replay from session/load
   * and are silently dropped. Set to true before session/load, flipped to false by
   * dispatchPrompt() right before the first live session/prompt is sent.
   *
   * Without this flag, Gemini's replay of the loaded session's user messages,
   * thinking chunks, tool calls, and tool results flow into external-session as
   * NEW content blocks, causing the loaded session's previous assistant message
   * to re-appear in the UI on resume (logged in
   * ~/Downloads/myagents-logs-2026-04-14T17-28-53.txt:169-173 where
   * user_message_chunk + tool_call arrived between session/load and set_mode).
   */
  replayMode = false;

  // True when the startSession catch-handler killed the process itself (stale
  // session/load, init failure, etc.). Suppresses the synthetic "Gemini
  // process exited with code …" session_complete emitted by proc.exited.then
  // — the caller already owns the error surface. Mirrors codex.ts #105 fix.
  intentionalKillDuringStartup = false;

  private proc: Subprocess;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
    this.rpc = new JsonRpcClient(proc);
  }

  async writeLine(_line: string): Promise<void> {
    throw new Error('Gemini uses JSON-RPC, not raw stdin. Use rpc.call() instead.');
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15);
    } catch {
      /* already dead */
    }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  async closeStdin(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      await stdin.end();
    } catch { /* already closed / EPIPE */ }
  }
}

// ─── Module-level model cache ───

let modelCache: { models: RuntimeModelInfo[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function geminiConfigDir(): string {
  const configHome = process.env.GEMINI_CLI_HOME
    || process.env.HOME
    || process.env.USERPROFILE
    || homedir();
  return join(configHome, '.gemini');
}

function hasNonEmptyEnv(name: string): boolean {
  const value = process.env[name]?.trim();
  return !!value && value !== '0' && value.toLowerCase() !== 'false';
}

function hasGeminiNonInteractiveAuthEnv(): boolean {
  if ([
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI',
  ].some(hasNonEmptyEnv)) return true;
  // GCA selects an auth flow; it is credential evidence only when the
  // non-interactive access token consumed by that flow is also present.
  return hasNonEmptyEnv('GOOGLE_GENAI_USE_GCA')
    && hasNonEmptyEnv('GOOGLE_CLOUD_ACCESS_TOKEN');
}

function hasGeminiOAuthCredentialEvidence(configDir: string): boolean {
  if (
    existsSync(join(configDir, 'gemini-credentials.json'))
    || existsSync(join(configDir, 'oauth_creds.json'))
  ) {
    return true;
  }
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s', 'gemini-cli-oauth',
      '-a', 'main-account',
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 1_500,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Guard temporary ACP discovery against Gemini CLI's interactive auth refresh.
 * We inspect only configuration shape and credential existence; secret contents
 * never enter process output or logs.
 */
export function assertGeminiModelDiscoveryAuthConfigured(): void {
  if (hasGeminiNonInteractiveAuthEnv()) return;

  const configDir = geminiConfigDir();
  let selectedType = '';
  try {
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    selectedType = typeof settings.security?.auth?.selectedType === 'string'
      ? settings.security.auth.selectedType.trim()
      : '';
  } catch {
    // Missing or unreadable settings are handled by the explicit error below.
  }

  if (!selectedType) {
    throw new Error(
      'Gemini model discovery requires an existing non-interactive authentication configuration. '
      + 'Run `gemini` in a normal terminal to authenticate, then retry.',
    );
  }
  if (selectedType === 'oauth-personal' && !hasGeminiOAuthCredentialEvidence(configDir)) {
    throw new Error(
      'Gemini OAuth is selected but no stored credential was found. '
      + 'Run `gemini` in a normal terminal to complete login before model discovery.',
    );
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Gemini model discovery aborted');
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** Build a RuntimeModelInfo[] from a Gemini ACP `session/new` (or `session/load`)
 *  response's `models` field. Shared by `queryModelsViaAcp` and `startSession` so
 *  the prewarm path can prime modelCache from its own session/new RPC, eliminating
 *  the second `gemini --acp` cold-start that /api/runtime/models would otherwise
 *  pay (see PRD perf note: scenario 2/3 of OPEN_AI_DISCUSSION + Launcher → Chat). */
function buildModelListFromAcpResponse(modelsField: {
  availableModels?: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId?: string;
} | undefined): RuntimeModelInfo[] {
  const available = modelsField?.availableModels ?? [];
  const currentId = modelsField?.currentModelId;
  // Only the empty "默认" entry is marked isDefault — matches CC_MODELS convention.
  // When value='' is sent to the runtime, gemini.ts skips session/set_model and
  // Gemini uses its own currentModelId automatically. The fact that the current
  // model is Gemini's own default is surfaced in the description, not as
  // isDefault=true, so the UI doesn't show two competing default markers.
  const defaultEntry: RuntimeModelInfo = { value: '', displayName: '默认', isDefault: true };
  const discovered: RuntimeModelInfo[] = available.map((m) => ({
    value: m.modelId,
    displayName: m.name || m.modelId,
    description:
      m.modelId === currentId
        ? `${m.description ? m.description + ' · ' : ''}Gemini CLI 内置默认`
        : m.description,
    isDefault: false,
  }));
  return [defaultEntry, ...discovered];
}

/**
 * Discover Gemini models through a short-lived ACP session without ever
 * delegating first-run login to a background process.
 */
export async function queryGeminiModelsViaAcp(signal?: AbortSignal): Promise<RuntimeModelInfo[]> {
  assertGeminiModelDiscoveryAuthConfigured();
  if (signal?.aborted) throw abortReason(signal);

  const cwd = process.env.HOME || process.env.USERPROFILE || homedir() || process.cwd();
  const proc = spawn([resolveCommand('gemini'), '--acp'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
    cwd,
    env: augmentedProcessEnv(),
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const geminiProc = new GeminiProcess(proc);
  const rpc = geminiProc.rpc;
  const readerDone = rpc.startReading();
  const stderrDone = drainGeminiStderr(proc, '[gemini-stderr/queryModels]');

  try {
    await raceWithAbort(new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    }), signal);
    await raceWithAbort(
      rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000),
      signal,
    );
    const result = (await raceWithAbort(rpc.call(
      'session/new',
      { cwd, mcpServers: [] },
      30_000,
    ), signal)) as {
      models?: {
        availableModels?: Array<{ modelId: string; name: string; description?: string }>;
        currentModelId?: string;
      };
    };
    const models = buildModelListFromAcpResponse(result.models);
    modelCache = { models, timestamp: Date.now() };
    return models;
  } finally {
    rpc.destroy();
    await boundedWait(geminiProc.closeStdin(), 250);
    await killWithEscalation(geminiProc, {
      gracefulMs: 1_000,
      hardMs: 1_000,
      killTree: true,
      onStep: (step, info) => {
        if (step === 'orphan') {
          console.warn(`[gemini] Temporary model discovery pid=${info.pid} did not exit; orphan risk remains`);
        }
      },
    });
    await Promise.all([
      boundedWait(readerDone, 1_000),
      boundedWait(stderrDone, 1_000),
    ]);
  }
}

// ─── Permission mode helpers ───

function mapPermissionMode(mode: string): string {
  switch (mode) {
    case 'auto':
      return 'autoEdit';
    case 'plan':
      return 'plan';
    case 'fullAgency':
      return 'yolo';
    case 'default':
    case 'autoEdit':
    case 'yolo':
      return mode;
    default:
      return 'autoEdit';
  }
}

/** Default mode by scenario: headless automation → YOLO (D6), desktop → Auto Edit (D5). */
function pickDefaultMode(scenarioType: string): string {
  const isHeadlessAutomation =
    scenarioType === 'im'
    || scenarioType === 'agent-channel'
    || scenarioType === 'cron'
    || scenarioType === 'registeredAgent';
  return isHeadlessAutomation ? 'yolo' : 'autoEdit';
}

/** Drain a `gemini --acp` subprocess's stderr to console.error.
 *
 *  REQUIRED on every spawn — not optional diagnostic plumbing. Gemini CLI
 *  writes OAuth refresh / proxy / debug lines during init; if no one reads
 *  the pipe, the OS buffer (~64KB on macOS/Linux) fills and gemini blocks
 *  on its next stderr write — silently hanging the `initialize` RPC until
 *  our 30s JSON-RPC timeout fires. Observed in practice when queryModels
 *  spawned without a stderr drain (commit history pre-fix). */
function drainGeminiStderr(proc: Subprocess, tag = '[gemini-stderr]'): Promise<void> {
  if (!proc.stderr) return Promise.resolve();
  return (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) console.error(`${tag} ${stripAnsi(text)}`);
      }
    } catch {
      /* ignore */
    } finally {
      reader.releaseLock();
    }
  })();
}

// ─── GeminiRuntime ───

export class GeminiRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'gemini';

  /** In-flight session/new promise from prewarm's startSession path. queryModels
   *  uses this to avoid spawning a duplicate `gemini --acp` when prewarm is
   *  already paying the ~10s cold-start cost — both calls then share the same
   *  RPC's availableModels result. Set at startSession step 7.5 (BEFORE the
   *  initialize handshake) so a queryModels arriving anywhere in
   *  [spawn → init → session/new] can coordinate; resolved when session/new
   *  succeeds, rejected from startSession's outer catch on any failure,
   *  always cleared in startSession's outer finally. */
  private currentSessionNewPromise: Promise<RuntimeModelInfo[]> | null = null;

  async detect(): Promise<RuntimeDetection> {
    try {
      const command = resolveCommand('gemini');
      const proc = spawn([command, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: augmentedProcessEnv(),
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return { installed: true, version: text.trim(), path: command };
      }
    } catch {
      /* not installed */
    }
    return { installed: false };
  }

  async queryModels(options: { signal?: AbortSignal } = {}): Promise<RuntimeModelInfo[]> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    // 1. Fresh cache hit
    if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
      return modelCache.models;
    }
    // 2. Prewarm's startSession is already in-flight on session/new — share its
    //    result instead of spawning a second `gemini --acp`. This is the key
    //    race-safe step: the GET /api/runtime/models and POST /api/runtime/prewarm
    //    arrive nearly simultaneously when a Tab Sidecar boots, and without this
    //    coordination both would pay independent cold-start costs (and contend
    //    with each other for CPU/auth refresh).
    if (this.currentSessionNewPromise) {
      try {
        return await raceWithAbort(this.currentSessionNewPromise, options.signal);
      } catch {
        // Fall through to spawn-temporary fallback if the prewarm RPC died.
      }
    }
    // 3. Tab-Sidecar race window — `06e7f82a` follow-up. queryModels and
    //    prewarm both fire on Tab boot (within ~200ms of each other). The
    //    original 06e7f82a fix made the share work for the prewarm-first
    //    ordering, but when queryModels arrives FIRST (also common — depends
    //    on React render order) we used to fall through to step 4 and spawn a
    //    duplicate `gemini --acp`. Verified in unified-2026-05-16.log at
    //    14:38:49 — `[gemini-stderr/queryModels]` tag confirmed a separate
    //    process spawned alongside prewarm's.
    //
    //    Poll briefly here so the late prewarm can claim
    //    `currentSessionNewPromise` and we share its result. Bounded so the
    //    Global Sidecar / Launcher path (no prewarm coming) only pays a short
    //    extra latency on its model-list fetch — which is non-blocking UI.
    //
    //    Async polling, not busy-wait: CLAUDE.md red-line `Atomics.wait` is
    //    about sync spin loops; this yields back to the event loop every
    //    iteration and is identical in shape to the `previewReqIdRef` async
    //    polling already used in DirectoryPanel.
    const RACE_DEADLINE_MS = 500;
    const POLL_INTERVAL_MS = 50;
    const deadline = Date.now() + RACE_DEADLINE_MS;
    while (Date.now() < deadline) {
      await raceWithAbort(new Promise<void>((r) => {
        const timer = setTimeout(r, POLL_INTERVAL_MS);
        timer.unref?.();
      }), options.signal);
      if (this.currentSessionNewPromise) {
        try {
          return await raceWithAbort(this.currentSessionNewPromise, options.signal);
        } catch {
          break; // Fall through to step 4
        }
      }
    }
    // 4. No prewarm arrived (Global Sidecar / Launcher path, or prewarm RPC
    //    died in step 2 / 3). Spawn a temporary process. queryModelsViaAcp
    //    writes modelCache itself before returning, so subsequent calls
    //    within the TTL skip this branch.
    try {
      return await queryGeminiModelsViaAcp(options.signal);
    } catch (err) {
      console.error('[gemini] Failed to query models:', err);
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (modelCache) return modelCache.models;
      throw err;
    }
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return GEMINI_PERMISSION_MODES;
  }

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'live_session_rpc',
      permissionMode: 'live_session_rpc',
      reasoningEffort: 'unsupported',
    };
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    cleanupStaleSessionPrompts();

    // 1. Extract Gemini CLI version to key the base prompt cache.
    const detection = await this.detect();
    const geminiVersion = detection.version || 'unknown';

    // 2. Write the per-session merged system prompt file BEFORE spawn.
    //    This is critical: GEMINI_SYSTEM_MD is read at spawn time, so we must have the
    //    path ready before calling spawn().
    const promptFile = await writeSessionSystemPrompt(
      options.sessionId,
      options.systemPromptAppend,
      geminiVersion,
      options.workspacePath,
    );

    // 3. Spawn gemini --acp with the system prompt env var (if we have a file).
    // Issue #194 — honor agent.runtimeConfig.envPolicy (proxy: myagents/terminal/direct).
    const spawnEnv: Record<string, string | undefined> = { ...augmentedProcessEnv(options.envPolicy) };
    spawnEnv.PWD = options.workspacePath;
    spawnEnv.MYAGENTS_SESSION_ID = options.sessionId;
    if (promptFile) {
      spawnEnv.GEMINI_SYSTEM_MD = promptFile;
    }

    const proc = spawn([resolveCommand('gemini'), '--acp'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd: options.workspacePath,
      env: spawnEnv,
      // Detached → child becomes its own pgroup leader on POSIX so
      // killWithEscalation({ killTree: true }) below can reach all of
      // gemini's tool-call subprocesses, not just the wrapper.
      //
      // Windows: `detached: true` + stdio:'pipe' prevents parent stdout reads
      // (same bug class as #170 #3/#5 for codex/claude). Windows tree-kill via
      // `taskkill /F /T /PID` works without detached. `windowsHide: true`
      // suppresses the cmd.exe console window flash for gemini.cmd shim.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const geminiProc = new GeminiProcess(proc);

    // 4. Wire up the event callback closure. sendMessage() reads this back through the
    //    process instance so it can emit turn_complete / usage from the RPC response.
    let sessionCompleteEmitted = false;
    // Pattern 6: stamp `runtime: 'gemini'` ambient on every event delivery
    // so nested console.* in onEvent / downstream handlers correlate.
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') {
        if (sessionCompleteEmitted) return;
        sessionCompleteEmitted = true;
      }
      withLogContext({ runtime: 'gemini' }, () => onEvent(event));
    };
    geminiProc.wrappedOnEvent = wrappedOnEvent;

    // 5. Wire notification + server-request handlers.
    geminiProc.rpc.setNotificationHandler((method, params) => {
      this.logNotification(method, params);
      const result = this.parseNotification(geminiProc, method, params);
      if (!result) return;
      const events = Array.isArray(result) ? result : [result];
      for (const event of events) wrappedOnEvent(event);
    });

    geminiProc.rpc.setServerRequestHandler((id, method, params) => {
      this.handleServerRequest(geminiProc, id, method, params, wrappedOnEvent);
    });

    geminiProc.rpc.startReading();

    // 6. Lifecycle: emit session_complete on process exit.
    //    The prompt file is NOT unlinked here — see cleanupStaleSessionPrompts
    //    for why deletion must be decoupled from the Bun Subprocess exit on
    //    Windows (.cmd launcher + node grandchild) and against retries that
    //    reuse the same session id.
    proc.exited.then((code) => {
      geminiProc.exited = true;
      // When the startup catch-handler killed the process itself (e.g. stale
      // `session/load`), suppress the synthetic session_complete so we don't
      // stack an "exited with code …" toast on top of the real RPC error that
      // the caller already broadcast. Issue #105.
      if (geminiProc.intentionalKillDuringStartup) return;
      wrappedOnEvent({
        kind: 'session_complete',
        result: code === 0 ? '' : `Gemini process exited with code ${code}`,
        subtype: code === 0 ? 'success' : 'error',
      });
    });

    // 7. Drain stderr — required to keep gemini's pipe buffer from filling.
    void drainGeminiStderr(proc);

    // 7.5 Race-coordinate with queryModels for the new-session path.
    //   /api/runtime/models and /api/runtime/prewarm fire in parallel from
    //   Chat.tsx. Without coordination, queryModels spawns its own
    //   `gemini --acp` and the two processes compete for OAuth refresh /
    //   network / Node-startup resources — observed to mutually time out
    //   on `initialize` (30s wait, both die, user-send falls through to a
    //   third spawn → ~40s total wait).
    //
    //   Set the in-flight promise BEFORE `initialize` so any concurrent
    //   queryModels arriving anywhere in [spawn → init → session/new]
    //   can await this single spawn instead of forking a duplicate. The
    //   resolve happens after session/new succeeds (where availableModels
    //   becomes known); reject + clear are bound to startSession's outer
    //   catch/finally so initialize / session/new failures both propagate.
    //
    //   Resume path doesn't set this: session/load doesn't return
    //   availableModels, so queryModels has nothing to share — it has to
    //   spawn its own (resolve/reject default to noop in that case and
    //   fire harmlessly below).
    let resolveModelsPromise: (m: RuntimeModelInfo[]) => void = () => {};
    let rejectModelsPromise: (e: unknown) => void = () => {};
    if (!options.resumeSessionId) {
      this.currentSessionNewPromise = new Promise<RuntimeModelInfo[]>((resolve, reject) => {
        resolveModelsPromise = resolve;
        rejectModelsPromise = reject;
      });
      // Pre-attach a noop catch so a startup failure rejection doesn't trip
      // Node's unhandled-rejection warning when no concurrent queryModels
      // happens to be listening. queryModels still observes via its await.
      this.currentSessionNewPromise.catch(() => {});
    }

    try {
      // 8. ACP initialize handshake.
      // Matches queryModels timeout: covers Gemini Node.js cold-start (3-8s)
      // + OAuth refresh. A tighter timeout here used to interact badly with
      // the prompt-file cleanup (see issue #95); cleanup is now age-based,
      // so a shorter budget only risks false-positive "timed out" toasts,
      // not missing-prompt-file failures.
      await geminiProc.rpc.call(
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
        30_000,
      );

      // 9. Determine mode + create/load session.
      const desiredMode = options.permissionMode
        ? mapPermissionMode(options.permissionMode)
        : pickDefaultMode(options.scenario.type);
      geminiProc.defaultMode = pickDefaultMode(options.scenario.type);

      if (options.resumeSessionId) {
        // Turn on replay-drop BEFORE session/load. Gemini emits the loaded session's
        // historical content as session/update notifications (user_message_chunk,
        // agent_thought_chunk, tool_call, tool_call_update, etc.) so clients can
        // rebuild their UI. MyAgents has its own SessionStore and does not want
        // these events persisted as new blocks — we drop them all until the first
        // live session/prompt fires.
        geminiProc.replayMode = true;

        const loadParams = {
          sessionId: options.resumeSessionId,
          cwd: options.workspacePath,
          mcpServers: [],
        };
        console.log(`[gemini] RPC session/load: ${JSON.stringify(loadParams)}`);
        const loadResult = (await geminiProc.rpc.call('session/load', loadParams, 30_000)) as {
          models?: { currentModelId?: string };
        } | undefined;
        geminiProc.sessionId = options.resumeSessionId;

        // Prefer the model Gemini reports as currently active on the loaded session
        // (usually the router id like 'auto-gemini-3'), fall back to the explicit
        // options.model the user selected, else empty string.
        const resumedModel = loadResult?.models?.currentModelId || options.model || '';
        onEvent({
          kind: 'session_init',
          sessionId: geminiProc.sessionId,
          model: resumedModel,
          tools: [],
        });
      } else {
        const newParams = { cwd: options.workspacePath, mcpServers: [] };
        console.log(`[gemini] RPC session/new: ${JSON.stringify(newParams)}`);

        const result = (await geminiProc.rpc.call('session/new', newParams, 30_000)) as {
          sessionId: string;
          modes?: { currentModeId?: string };
          models?: {
            currentModelId?: string;
            availableModels?: Array<{ modelId: string; name: string; description?: string }>;
          };
        };
        geminiProc.sessionId = result.sessionId;

        // Prime modelCache + resolve the queryModels coordination promise
        // (created at step 7.5, awaited by any concurrent queryModels call).
        // Reject path lives in startSession's outer catch so initialize
        // failures also propagate out.
        const models = buildModelListFromAcpResponse(result.models);
        modelCache = { models, timestamp: Date.now() };
        resolveModelsPromise(models);

        onEvent({
          kind: 'session_init',
          sessionId: result.sessionId,
          model: result.models?.currentModelId || options.model || '',
          tools: [],
        });
      }

      // 10. Apply desired mode if not default.
      if (desiredMode !== 'default') {
        try {
          await geminiProc.rpc.call(
            'session/set_mode',
            { sessionId: geminiProc.sessionId, modeId: desiredMode },
            5_000,
          );
          console.log(`[gemini] set_mode → ${desiredMode}`);
        } catch (err) {
          console.warn(`[gemini] set_mode failed (non-fatal):`, err);
        }
      }

      // 11. Apply model override (if non-empty).
      if (options.model && options.model.length > 0) {
        try {
          await geminiProc.rpc.call(
            'session/set_model',
            { sessionId: geminiProc.sessionId, modelId: options.model },
            5_000,
          );
          console.log(`[gemini] set_model → ${options.model}`);
        } catch (err) {
          console.warn(`[gemini] set_model failed (non-fatal):`, err);
        }
      }

      // 12. Send initial message if provided. This runs async — session/update
      //     notifications stream the response, and session/prompt resolves with
      //     { stopReason, _meta.quota } when done.
      //
      //     dispatchPrompt flips replayMode to false internally before sending
      //     the live prompt. When there's no initialTurn, we must flip it
      //     here instead, so the first user-sendMessage call doesn't race
      //     against any delayed replay notifications (an initialTurn-less
      //     startSession is used for pre-warm-style IM scenarios where the
      //     peer session is restored but the first user message hasn't
      //     arrived yet). Without this, session/update events arriving
      //     between startSession's return and sendMessage's first prompt
      //     dispatch would be silently dropped as replay.
      if (options.initialTurn) {
        this.dispatchPrompt(
          geminiProc,
          options.initialTurn.message,
          options.initialTurn.images,
          wrappedOnEvent,
        );
      } else {
        geminiProc.replayMode = false;
      }
    } catch (err) {
      // Propagate startup failure to any concurrent queryModels awaiting our
      // coordination promise (set at step 7.5). Without this, a queryModels
      // caller would hang on the never-resolved promise until the GC-ish
      // module-state cleanup. queryModels' own catch falls through to a
      // queryModelsViaAcp retry — appropriate, since this spawn is dead.
      rejectModelsPromise(err);
      // Flag must be set BEFORE proc.kill so proc.exited.then observes it.
      geminiProc.intentionalKillDuringStartup = true;
      try {
        // SIGKILL (9) over SIGTERM (15): the Windows launcher chain
        // (gemini.cmd → node) is slow to unwind on SIGTERM, and leaving a
        // zombie gemini subprocess around wastes OAuth token refreshes and
        // stderr bandwidth. Note: prompt-file cleanup is now age-based, so
        // an uncooperative grandchild reading GEMINI_SYSTEM_MD after this
        // point will still find a valid file.
        proc.kill(9);
      } catch {
        /* ignore */
      }
      geminiProc.exited = true;

      // Detect stale session/load failure so the caller can invalidate the
      // persisted runtimeSessionId and retry fresh. Match only phrasings
      // that unambiguously mean "the stored session is gone" — broader
      // matches like bare "invalid session" could false-trigger on unrelated
      // auth/format errors and destroy a resumable session unnecessarily.
      // `invalid session identifier "<uuid>"` is Gemini CLI's exact phrasing
      // for "no chat file with that uuid in ~/.gemini/tmp/<project>/chats"
      // (observed when the chats dir is GC'd or the project moves) and
      // matching the qualified form keeps false positives out.
      //
      // Cross-review Codex/cc Warning: log the full error message at every
      // resume-failure point so a future Gemini CLI error-string change is a
      // noisy log, not a silent data-loss regression. Whenever operators see
      // a "session reload failed, will retry fresh" without a matching
      // `StaleRuntimeSessionError`, they can tell the regex needs updating.
      const msg = err instanceof Error ? err.message : String(err);
      if (options.resumeSessionId) {
        if (/session not found|no conversation found|unknown session|session does not exist|invalid session identifier/i.test(msg)) {
          console.warn(
            `[gemini] Resume session ${options.resumeSessionId} reported stale, will retry fresh. Error: ${msg}`,
          );
          throw new StaleRuntimeSessionError(options.resumeSessionId, msg);
        }
        console.warn(
          `[gemini] Resume session ${options.resumeSessionId} failed with non-stale error (not treated as stale). ` +
          `If this should trigger a fresh retry, update the stale-session regex in gemini.ts. Error: ${msg}`,
        );
      }
      throw err;
    } finally {
      // Always clear the queryModels coordination promise so the next start
      // doesn't see a stale stalled promise. resolve/reject already fired
      // by this point (success path → resolved at session/new; failure path
      // → rejected in catch above), so observers have settled.
      this.currentSessionNewPromise = null;
    }

    return geminiProc;
  }

  async sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
  ): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) throw new Error('Gemini process has exited');

    // Reset per-turn thinking state; tool state is toolCallId-scoped and cleans itself up.
    geminiProc.thinkingActive = false;

    const cb = geminiProc.wrappedOnEvent;
    if (!cb) throw new Error('Gemini session has no event callback');
    this.dispatchPrompt(geminiProc, message, images, cb);
  }

  /**
   * Fire a session/prompt RPC and emit UnifiedEvents for its response + usage.
   * Notification events are emitted on their own track via the notification handler
   * registered in startSession. The RPC resolution only produces turn_complete + usage.
   */
  private dispatchPrompt(
    geminiProc: GeminiProcess,
    message: string,
    images: ResolvedImagePayload[] | undefined,
    emit: UnifiedEventCallback,
  ): void {
    // Live events begin now. Any session/update that arrives from here on is part
    // of the new turn, not replay from a prior session/load. See replayMode comment
    // on GeminiProcess for the full rationale.
    geminiProc.replayMode = false;

    const prompt = buildGeminiPrompt(message, images);
    geminiProc.rpc
      .call(
        'session/prompt',
        { sessionId: geminiProc.sessionId, prompt },
        0,  // No RPC timeout — watchdog handles hung processes
      )
      .then((result) => {
        const usage = extractUsage(result as PromptResponse);
        if (usage) emit(usage);
        const stopReason = (result as PromptResponse)?.stopReason || '';
        // Close any lingering thinking block
        if (geminiProc.thinkingActive) {
          emit({ kind: 'thinking_stop', index: geminiProc.thinkingIndex });
          geminiProc.thinkingActive = false;
        }
        emit({ kind: 'turn_complete', result: stopReason });
      })
      .catch((err) => {
        console.error('[gemini] session/prompt error:', err);
        emit({
          kind: 'session_complete',
          result: err instanceof Error ? err.message : String(err),
          subtype: 'error',
        });
      });
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    /* PRD #131 — interface-uniformity, see codex.ts respondPermission. */
    _reason?: string,
    _suggestions?: unknown[],
    _updatedInput?: Record<string, unknown>,
    _interrupt?: boolean,
  ): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) return;

    const rpcId = parseInt(requestId, 10);
    if (isNaN(rpcId)) {
      console.error('[gemini] Invalid approval requestId:', requestId);
      return;
    }

    const options = geminiProc.pendingPermissionOptions.get(rpcId);
    geminiProc.pendingPermissionOptions.delete(rpcId);

    const wantKind =
      decision === 'deny'
        ? 'reject_once'
        : decision === 'always_allow'
          ? 'allow_always'
          : 'allow_once';

    let optionId: string | undefined;
    if (options && options.length > 0) {
      optionId = options.find((o) => o.kind === wantKind)?.optionId;
      if (!optionId) {
        // Fallback to broader kind categories
        if (decision === 'deny') {
          optionId = options.find((o) => /reject|deny|cancel/i.test(o.kind || ''))?.optionId;
        } else {
          optionId = options.find((o) => /allow|proceed/i.test(o.kind || ''))?.optionId;
        }
      }
    }

    if (!optionId) {
      console.warn(
        `[gemini] No matching option for decision=${decision}, responding with cancelled outcome`,
      );
      geminiProc.rpc.respond(rpcId, { outcome: { outcome: 'cancelled' } });
      return;
    }

    geminiProc.rpc.respond(rpcId, { outcome: { outcome: 'selected', optionId } });
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) return;

    try {
      if (geminiProc.sessionId) {
        geminiProc.rpc.notify('session/cancel', { sessionId: geminiProc.sessionId });
      }
      await geminiProc.closeStdin();
    } catch {
      /* ignore */
    }

    try {
      await killWithEscalation(geminiProc, {
        gracefulMs: 3_000,
        hardMs: 2_000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') {
            console.warn(`[gemini] Process pid=${info.pid} did not exit after SIGKILL; continuing with orphan risk`);
          }
        },
      });
    } catch {
      /* ignore */
    } finally {
      geminiProc.rpc.destroy();
    }
  }

  /**
   * Switch the active session's model via ACP `session/set_model` RPC
   * (stable protocol method, see https://agentclientprotocol.com/protocol/schema).
   * Throws on failure so the caller can fall back to process restart.
   * Empty `model` is a no-op — the runtime keeps its currently selected model.
   */
  async setModel(process: RuntimeProcess, model: string | undefined): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) throw new Error('Gemini process has exited');
    if (!geminiProc.sessionId) throw new Error('Gemini session has no sessionId');
    if (!model) return;  // "" means "default" — leave Gemini's selection alone

    await geminiProc.rpc.call(
      'session/set_model',
      { sessionId: geminiProc.sessionId, modelId: model },
      5_000,
    );
    console.log(`[gemini] set_model (mid-session) → ${model}`);
  }

  async setPermissionMode(process: RuntimeProcess, mode: string | undefined): Promise<void> {
    const geminiProc = process as GeminiProcess;
    if (geminiProc.exited) throw new Error('Gemini process has exited');
    if (!geminiProc.sessionId) throw new Error('Gemini session has no sessionId');
    const modeId = mode ? mapPermissionMode(mode) : geminiProc.defaultMode;
    await geminiProc.rpc.call(
      'session/set_mode',
      { sessionId: geminiProc.sessionId, modeId },
      5_000,
    );
    console.log(`[gemini] set_mode (mid-session) → ${modeId}`);
  }

  // ─── Logging ───

  private logNotification(method: string, params: unknown): void {
    const upd = (params as { update?: { sessionUpdate?: string } } | undefined)?.update;
    const su = upd?.sessionUpdate;
    const isNoisy =
      su === 'agent_message_chunk' ||
      su === 'agent_thought_chunk' ||
      su === 'available_commands_update';
    if (isNoisy) return;

    let detail = '';
    if (su) detail += ` kind=${su}`;
    if (su === 'tool_call') {
      const u = upd as Record<string, unknown>;
      detail += ` id=${String(u.toolCallId || '').slice(0, 16)} title=${String(u.title || '').slice(0, 40)}`;
    } else if (su === 'tool_call_update') {
      const u = upd as Record<string, unknown>;
      detail += ` id=${String(u.toolCallId || '').slice(0, 16)} status=${u.status}`;
    }
    console.log(`[gemini] ${method}${detail}`);
  }

  // ─── Notification parsing ───

  private parseNotification(
    geminiProc: GeminiProcess,
    method: string,
    params: unknown,
  ): UnifiedEvent | UnifiedEvent[] | null {
    if (method !== 'session/update') return null;

    // Replay-drop: during session/load, Gemini replays the loaded session's history
    // as session/update notifications (user_message_chunk, tool_call, agent_thought_chunk,
    // tool_call_update, etc.). MyAgents already has its own SessionStore for the loaded
    // session and must not persist the replay as new content blocks. dispatchPrompt
    // flips this back to false just before sending the first live session/prompt.
    if (geminiProc.replayMode) return null;

    const p = params as { update?: Record<string, unknown> };
    const update = p.update;
    if (!update) return null;

    const su = update.sessionUpdate as string;

    switch (su) {
      // ── Text streaming ──
      case 'agent_message_chunk': {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? '';
        if (!text) return null;
        const events: UnifiedEvent[] = [];
        if (geminiProc.thinkingActive) {
          events.push({ kind: 'thinking_stop', index: geminiProc.thinkingIndex });
          geminiProc.thinkingActive = false;
        }
        events.push({ kind: 'text_delta', text });
        return events;
      }

      // ── Thinking streaming ──
      case 'agent_thought_chunk': {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? '';
        if (!text) return null;
        const events: UnifiedEvent[] = [];
        if (!geminiProc.thinkingActive) {
          geminiProc.thinkingIndex += 1;
          geminiProc.thinkingActive = true;
          events.push({ kind: 'thinking_start', index: geminiProc.thinkingIndex });
        }
        events.push({ kind: 'thinking_delta', text, index: geminiProc.thinkingIndex });
        return events;
      }

      // ── Tool call notification (pre-approval in autoEdit/yolo modes) ──
      case 'tool_call': {
        const toolCallId = String(update.toolCallId || '');
        if (!toolCallId) return null;
        const title = String(update.title || 'Tool');
        const kind = String(update.kind || '');
        const internalName = parseGeminiToolName(toolCallId);
        const toolName = mapGeminiInternalToolName(internalName, kind, title);
        const input = buildGeminiToolInput(
          internalName,
          title,
          kind,
          update.locations as Array<{ path: string; line?: number }> | undefined,
          update.content,
        );

        const existing = geminiProc.toolState.get(toolCallId);
        if (existing?.emittedStart) return null;
        geminiProc.toolState.set(toolCallId, {
          toolName,
          emittedStart: true,
          emittedStop: false,
        });

        return {
          kind: 'tool_use_start',
          toolUseId: toolCallId,
          toolName,
          input,
        };
      }

      // ── Tool completion ──
      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId || '');
        if (!toolCallId) return null;
        const status = String(update.status || '');
        const state = geminiProc.toolState.get(toolCallId);

        if (status === 'completed' || status === 'failed') {
          if (state?.emittedStop) return null;
          const resultText = extractToolResultText(update);
          const isError = status === 'failed';
          const events: UnifiedEvent[] = [];

          // Late-bind tool_use_start if we never saw one (default mode: request_permission
          // arrives before any tool_call notification fires)
          if (!state?.emittedStart) {
            const title = String(update.title || 'Tool');
            const kind = String(update.kind || '');
            const internalName = parseGeminiToolName(toolCallId);
            const toolName = mapGeminiInternalToolName(internalName, kind, title);
            const input = buildGeminiToolInput(
              internalName,
              title,
              kind,
              update.locations as Array<{ path: string; line?: number }> | undefined,
              update.content,
            );
            events.push({
              kind: 'tool_use_start',
              toolUseId: toolCallId,
              toolName,
              input,
            });
          }

          geminiProc.toolState.set(toolCallId, {
            toolName: state?.toolName || 'Tool',
            emittedStart: true,
            emittedStop: true,
          });

          events.push({ kind: 'tool_use_stop', toolUseId: toolCallId });
          const toolName = state?.toolName || mapGeminiInternalToolName(
            parseGeminiToolName(toolCallId),
            String(update.kind || ''),
            String(update.title || 'Tool'),
          );
          const fallbackResult = isError
            ? 'Tool execution failed'
            : getEmptyResultFallback(toolName);
          events.push({
            kind: 'tool_result',
            toolUseId: toolCallId,
            content: resultText || fallbackResult,
            isError,
          });
          return events;
        }
        // Other statuses (pending / in_progress) — ignore (no delta text to emit)
        return null;
      }

      // ── Plan updates — transparent raw passthrough until UI is built ──
      case 'plan':
        return { kind: 'raw', data: update };

      // ── IDE command menus — ignored ──
      case 'available_commands_update':
      case 'user_message_chunk':
        return null;

      default:
        console.log(`[gemini] Unhandled session/update kind: ${su}`);
        return null;
    }
  }

  // ─── Server-initiated requests ───

  private handleServerRequest(
    geminiProc: GeminiProcess,
    rpcId: number,
    method: string,
    params: unknown,
    onEvent: UnifiedEventCallback,
  ): void {
    switch (method) {
      case 'session/request_permission': {
        const p = params as {
          sessionId?: string;
          options?: PermissionOption[];
          toolCall?: {
            toolCallId?: string;
            title?: string;
            kind?: string;
            content?: unknown;
            locations?: Array<{ path: string; line?: number }>;
            status?: string;
          };
        };

        const toolCall = p.toolCall || {};
        const toolCallId = String(toolCall.toolCallId || '');
        const title = String(toolCall.title || 'Tool');
        const kind = String(toolCall.kind || '');
        const internalName = parseGeminiToolName(toolCallId);
        const toolName = mapGeminiInternalToolName(internalName, kind, title);
        const input = buildGeminiToolInput(internalName, title, kind, toolCall.locations, toolCall.content);

        if (p.options && p.options.length > 0) {
          geminiProc.pendingPermissionOptions.set(rpcId, p.options);
        }

        // Emit tool_use_start if we haven't already (default mode goes straight here
        // without a prior tool_call notification)
        if (toolCallId) {
          const state = geminiProc.toolState.get(toolCallId);
          if (!state?.emittedStart) {
            geminiProc.toolState.set(toolCallId, {
              toolName,
              emittedStart: true,
              emittedStop: false,
            });
            onEvent({
              kind: 'tool_use_start',
              toolUseId: toolCallId,
              toolName,
              input,
            });
          }
        }

        onEvent({
          kind: 'permission_request',
          requestId: String(rpcId),
          toolName,
          toolUseId: toolCallId,
          input,
        });
        break;
      }

      // fs/* and terminal/* — we do NOT declare these capabilities in `initialize`,
      // so Gemini CLI uses its own internal implementations. If it still asks, decline.
      default: {
        console.warn(`[gemini] Unhandled server request: ${method}`);
        geminiProc.rpc.respondError(rpcId, -32601, `Method not supported: ${method}`);
        break;
      }
    }
  }
}

// ─── Helpers ───

interface PromptResponse {
  stopReason?: string;
  _meta?: {
    quota?: {
      token_count?: { input_tokens?: number; output_tokens?: number };
      model_usage?: Array<{
        model: string;
        token_count: { input_tokens: number; output_tokens: number };
      }>;
    };
  };
}

/**
 * Parse Gemini's internal tool name from the `toolCallId` prefix.
 *
 * Gemini generates toolCallIds in the format `<tool_name>-<epoch_ms>-<seq>`, e.g.
 *   run_shell_command-1776189411556-1
 *   list_directory-1776189411617-2
 *   grep_search-1776189411621-3
 *   glob-1776189411655-4
 *
 * This is the only reliable way to identify the exact internal tool, because
 * Gemini ACP v0.37.2 does NOT populate the `rawInput` field on tool_call /
 * tool_call_update notifications (verified with /tmp/myagents-verify-gemini/
 * tool-input-probe.mjs across 4 tool types — all got `rawInput: undefined`).
 *
 * Returns the lowercase snake_case internal name, or empty string if the id
 * doesn't match the expected shape.
 */
function parseGeminiToolName(toolCallId: string): string {
  // Match <snake_case>-<13-digit epoch ms>-<seq>
  const match = toolCallId.match(/^([a-z_]+)-\d{10,}-\d+$/);
  return match ? match[1] : '';
}

/**
 * Map Gemini internal tool name (from toolCallId prefix) to the MyAgents
 * frontend badge name. The frontend's `toolBadgeConfig.tsx` switch-statement
 * is the source of truth for which tool names get custom icons + colors.
 *
 * Gemini tool catalog in v0.37.2 (from chunk-FNPZEX27.js ShellTool/EditTool/
 * WriteFileTool/ReadFileTool/GrepTool/RipGrepTool/GlobTool/LSTool/WebFetchTool/
 * WebSearchTool/SaveMemoryTool/ActivateSkillTool/AskUserTool, with Kind.X
 * mapping used here only as a FALLBACK for unknown tools):
 *
 *   run_shell_command           → Bash       (Kind.Execute)
 *   read_file                   → Read       (Kind.Read)
 *   read_many_files             → Read       (Kind.Read)
 *   write_file                  → Write      (Kind.Edit)
 *   replace                     → Edit       (Kind.Edit)
 *   grep / grep_search          → Grep       (Kind.Search)
 *   glob                        → Glob       (Kind.Search)
 *   list_directory              → Glob       (Kind.Search — reuse Glob badge; FE has no LS)
 *   web_fetch                   → WebFetch   (Kind.Fetch)
 *   google_web_search           → WebSearch  (Kind.Search)
 *   save_memory                 → Memory     (FE shows fallback badge)
 *   activate_skill              → Skill      (Kind.Other)
 *   ask_user                    → AskUser    (Kind.Other)
 *   update_topic                → UpdateTopic (Kind.Think)
 *   complete_task               → Task       (Kind.Other)
 */
function mapGeminiInternalToolName(
  internalName: string,
  fallbackKind: string,
  fallbackTitle: string,
): string {
  switch (internalName) {
    case 'run_shell_command':
      return 'Bash';
    case 'read_file':
    case 'read_many_files':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'replace':
      return 'Edit';
    case 'grep':
    case 'grep_search':
    case 'search_file_content':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'list_directory':
      // Frontend has no LS badge; reuse Glob (purple search family)
      return 'Glob';
    case 'web_fetch':
      return 'WebFetch';
    case 'google_web_search':
      return 'WebSearch';
    case 'save_memory':
      return 'Memory';
    case 'activate_skill':
      return 'Skill';
    case 'ask_user':
      return 'AskUser';
    case 'complete_task':
    case 'task_complete':
      return 'Task';
  }
  // Fall back to ACP kind for tools we don't recognize (MCP tools, plugins, etc.)
  switch (fallbackKind) {
    case 'execute': return 'Bash';
    case 'edit':    return 'Edit';
    case 'read':    return 'Read';
    case 'search':  return 'Grep';
    case 'fetch':   return 'WebFetch';
    case 'think':   return 'UpdateTopic';
  }
  // Last resort: internal name if we have one, else title, else 'Tool'
  return internalName || fallbackTitle || 'Tool';
}

/**
 * Convert a Gemini tool_call / tool_call_update notification into the structured
 * `input` object that MyAgents frontend expects.
 *
 * The returned object serves two roles:
 *   (1) It feeds `toolBadgeConfig.tsx::getToolLabel` for the collapsed row's
 *       secondary label — each component looks up canonical field names
 *       (command / file_path / pattern / query / url / ...).
 *   (2) It feeds the expanded-view specialized components (BashTool / ReadTool /
 *       EditTool / GrepTool / ...) which render rich Input+Output sections.
 *
 * Three important design points:
 *
 * - `_displayName` is set to Gemini's internal tool name (e.g. "run_shell_command",
 *   "grep_search", "glob"). `getToolMainLabel` / `getToolExpandedLabel` read this
 *   override and show it as the badge title, so users see Gemini's real tool
 *   identifier even though we route via tool.name='Bash' / 'Grep' / etc. for
 *   rich body rendering. Without this, the user loses visibility into which
 *   Gemini tool was actually invoked.
 *
 * - `rawInput` is NOT populated by Gemini ACP v0.37.2 (verified with real CLI).
 *   The `title` field is pre-formatted and is our only source of structured
 *   parameters. We pattern-match the title back into the frontend's field shape.
 *
 * - Meta fields like `cwd`, `locations`, and the original `title`/`kind` are
 *   preserved under underscore-prefixed keys so specialized components
 *   (e.g. BashTool's meta bar) can display them without conflicting with
 *   their own canonical fields.
 */
function buildGeminiToolInput(
  internalName: string,
  title: string,
  kind: string,
  locations: Array<{ path: string; line?: number }> | undefined,
  content: unknown,
): Record<string, unknown> {
  const loc0 = Array.isArray(locations) && locations[0] ? locations[0] : undefined;
  // displayName = the Gemini internal name when we can parse it, else a sensible
  // human-readable fallback. Always included so the UI surfaces the real tool.
  const displayName = internalName || (kind ? `${kind} (${title || 'tool'})` : title || 'tool');

  // Fields shared by every tool path — expanded components ignore keys they
  // don't recognize, so it's safe to pass extra metadata.
  const meta: Record<string, unknown> = {
    _displayName: displayName,
    _geminiKind: kind || undefined,
    _geminiTitle: title || undefined,
    ...(loc0 ? { _location: loc0 } : {}),
    ...(Array.isArray(locations) && locations.length > 1 ? { _locations: locations } : {}),
  };

  switch (internalName) {
    case 'run_shell_command': {
      // title IS the command (verified via real CLI: toolCallId=run_shell_command-…, title="pwd")
      return { ...meta, command: title || '' };
    }
    case 'read_file':
    case 'write_file':
    case 'replace': {
      // For file operations Gemini's title is usually the absolute path.
      const file_path = loc0?.path ?? title ?? '';
      return { ...meta, file_path };
    }
    case 'read_many_files': {
      return { ...meta, file_path: title || '', paths: title || '' };
    }
    case 'grep':
    case 'grep_search':
    case 'search_file_content': {
      // title format: `'pattern' in *.ext within ./path` — extract pattern
      const patternMatch = title.match(/^'([^']*)'/);
      const pattern = patternMatch ? patternMatch[1] : title;
      return { ...meta, pattern };
    }
    case 'glob': {
      // title format: `'*.md'` — strip single quotes
      const pattern = title.replace(/^'|'$/g, '');
      return { ...meta, pattern };
    }
    case 'list_directory': {
      const pattern = title || '.';
      return { ...meta, pattern };
    }
    case 'google_web_search': {
      return { ...meta, query: title || '' };
    }
    case 'web_fetch': {
      return { ...meta, url: title || '' };
    }
    case 'save_memory':
    case 'activate_skill':
    case 'ask_user':
    case 'update_topic':
    case 'complete_task':
    case 'task_complete': {
      return { ...meta, title, kind };
    }
  }
  // Unknown tool (MCP, plugins, new built-ins) — pass through whatever we have.
  return {
    ...meta,
    title,
    kind,
    ...(Array.isArray(content) ? { content } : {}),
  };
}

/**
 * Fallback result text when Gemini ACP returns empty content for a completed tool.
 * Some tools (Read, Glob, Grep) don't expose their output via ACP — the result
 * is consumed internally by Gemini. We show a tool-specific hint instead of
 * the generic "Tool executed".
 */
function getEmptyResultFallback(toolName: string): string {
  switch (toolName) {
    case 'Read':   return '(content consumed by Gemini internally)';
    case 'Grep':   return '(search results consumed by Gemini internally)';
    case 'Glob':   return '(file list consumed by Gemini internally)';
    case 'Bash':   return '(no output)';
    case 'Write':  return '(file written)';
    case 'Edit':   return '(file edited)';
    default:       return '(completed)';
  }
}

/** Extract text content from a tool_call_update's `content[]` array.
 *
 * Gemini ACP content items come in several shapes:
 *   - `{ text: "..." }` — plain text (e.g. Read result)
 *   - `{ content: { text: "..." } }` — nested text
 *   - `{ type: "diff", path, oldText, newText }` — file edits (Edit / Write)
 *   - `{ type: "output", text: "..." }` — shell output (Bash)
 */
function extractToolResultText(update: Record<string, unknown>): string {
  const content = update.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content) || content.length === 0) return '';
  const parts: string[] = [];
  for (const item of content) {
    // Nested text: { content: { text: "..." } }
    const inner = item.content as Record<string, unknown> | undefined;
    if (inner && typeof inner.text === 'string') {
      parts.push(inner.text);
    // Direct text: { text: "..." } or { type: "output", text: "..." }
    } else if (typeof item.text === 'string') {
      parts.push(item.text);
    // Diff content: { type: "diff", path, oldText, newText }
    } else if (item.type === 'diff' && typeof item.path === 'string') {
      const old = typeof item.oldText === 'string' ? item.oldText : '';
      const nw = typeof item.newText === 'string' ? item.newText : '';
      parts.push(`--- ${item.path}\n+++ ${item.path}\n${formatMinimalDiff(old, nw)}`);
    }
  }
  return parts.join('\n');
}

/** Produce a minimal unified-diff-style string from old/new text (line-level). */
function formatMinimalDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const ol = i < oldLines.length ? oldLines[i] : undefined;
    const nl = i < newLines.length ? newLines[i] : undefined;
    if (ol === nl) {
      out.push(` ${ol}`);
    } else {
      if (ol !== undefined) out.push(`-${ol}`);
      if (nl !== undefined) out.push(`+${nl}`);
    }
  }
  return out.join('\n');
}

/** Extract usage from a session/prompt RPC response's `_meta.quota`. */
function extractUsage(response: PromptResponse): UnifiedEvent | null {
  const quota = response._meta?.quota;
  if (!quota) return null;
  const total = quota.token_count;
  if (!total) return null;

  const modelUsage: Record<string, { inputTokens: number; outputTokens: number }> = {};
  if (Array.isArray(quota.model_usage)) {
    for (const m of quota.model_usage) {
      if (!m?.model) continue;
      modelUsage[m.model] = {
        inputTokens: m.token_count?.input_tokens ?? 0,
        outputTokens: m.token_count?.output_tokens ?? 0,
      };
    }
  }

  return {
    kind: 'usage',
    inputTokens: total.input_tokens ?? 0,
    outputTokens: total.output_tokens ?? 0,
    model: Object.keys(modelUsage)[0],
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
    semantics: 'delta',
    // PRD 0.2.32 — context 占用：Gemini 的 `_meta.quota.token_count.input_tokens` 是 per-request
    // 的提示词 token（含重发的整段上下文）= 当前占用。直接作为显式占用喂指示器。
    contextOccupiedTokens: total.input_tokens && total.input_tokens > 0 ? total.input_tokens : undefined,
  };
}
