// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { RuntimeEnvPolicy } from '../../shared/types/runtime';
import { getShellEnv, getShellPath, getDetectedTerminalProxyEnv } from '../utils/shell';

const PROXY_KEYS_UPPER = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;
const PROXY_KEYS_LOWER = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const;
const PROXY_KEYS_ALL = [...PROXY_KEYS_UPPER, ...PROXY_KEYS_LOWER] as const;

/**
 * Lightweight PATH-based command lookup, used by external-runtime adapters.
 *
 * On Windows, honours PATHEXT (.EXE, .CMD, .BAT, etc.) so .cmd shims from
 * npm-global installs are found. Absolute paths bypass PATH and are verified
 * via `statSync` directly.
 */
function which(command: string, opts?: { PATH?: string }): string | null {
  const pathStr = opts?.PATH ?? process.env.PATH ?? '';
  if (!pathStr) return null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  // Absolute path bypass: if caller passed an absolute executable, just verify it.
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    try {
      if (statSync(command).isFile()) return command;
    } catch { /* not found */ }
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* skip */ }
    }
  }
  return null;
}



/**
 * Build an augmented env for spawning external CLI runtimes (claude, codex).
 *
 * Delegates to getShellEnv() which already handles:
 * - Windows: system PATH + npm global (%APPDATA%\npm), Git, Bun, Node.js
 * - macOS: shell -l PATH detection + homebrew, NVM, pnpm, Bun
 * - PATH key normalization (Windows Path vs Unix PATH)
 *
 * Previously this function had its own hardcoded Unix-only PATH augmentation,
 * which missed Windows paths like %APPDATA%\npm → "Executable not found". See: #70
 *
 * NOTE: The Sidecar process already has NO_PROXY injected by Rust's
 * proxy_config::apply_to_subprocess(). getShellEnv() spreads process.env,
 * so external CLI subprocesses spawned here are also protected.
 *
 * Issue #194 — `policy.proxy` selects how proxy env reaches the runtime:
 *  - `myagents` (default): inherit Sidecar's process.env proxy vars (Rust
 *    injects MyAgents-configured proxy into the Sidecar's env at spawn).
 *  - `terminal`: replace the inherited proxy vars with whatever the user's
 *    interactive shell exports (detected during shell.ts warmup). If warmup
 *    found nothing, all proxy vars are stripped — that's terminal parity for
 *    users who don't export proxies in their rc, which also serves the
 *    Clash-TUN / VPN case (system-level routing handles networking, no
 *    application proxy needed).
 *
 * 0.2.16 dev briefly shipped a third `'direct'` literal that unconditionally
 * stripped all proxy vars. Removed before release — `terminal` covers the
 * same TUN/VPN case for users whose shell has no proxy set. Existing disk
 * `'direct'` values fall through validation and default to `'myagents'`.
 */
export function augmentedProcessEnv(
  policy?: RuntimeEnvPolicy,
): Record<string, string | undefined> {
  const env = getShellEnv();

  // Defense-in-depth: only act on the explicit allowlist. An unknown value
  // (forward-compat: a future policy literal not yet implemented here, a
  // deprecated literal like the removed `'direct'`, or a malformed config
  // that slipped past upstream validation) MUST behave as `'myagents'` —
  // i.e. don't strip the user's proxy env on a guess.
  const rawPolicy = policy?.proxy;
  const proxyPolicy: 'myagents' | 'terminal' =
    rawPolicy === 'terminal' ? 'terminal' : 'myagents';

  if (proxyPolicy === 'myagents') {
    // Legacy / default — leave inherited proxy vars in place. Rust's
    // `apply_to_subprocess` already populated them in the Sidecar's env.
    return env;
  }

  // 'terminal' — strip every inherited proxy var, then restore whatever the
  // user's interactive shell would set. Drop the MyAgents-injected marker
  // too so downstream code doesn't mistake a stripped env for a MyAgents-
  // controlled one.
  for (const k of PROXY_KEYS_ALL) delete env[k];
  delete env.MYAGENTS_PROXY_INJECTED;

  const detected = getDetectedTerminalProxyEnv();
  if (detected) {
    for (const [k, v] of Object.entries(detected)) {
      // Skip empty values — those mean "user has the var unset". The strip
      // above already removed inherited values, so leaving them out is the
      // correct terminal-parity outcome (and also serves Clash-TUN / VPN
      // users whose shell typically has no proxy set).
      if (v && v.length > 0) {
        env[k] = v;
      }
    }
  }
  // If warmup hasn't completed yet, `detected` is null → env stays stripped.
  // Caller (codex.ts / claude-code.ts) can choose to await `ensureShellPath()`
  // beforehand to guarantee the terminal proxy is loaded; production already
  // does this on first spawn ~5–6s into Sidecar startup.

  return env;
}

/**
 * Read `agent.runtimeConfig.envPolicy` from disk for a workspace, validate the
 * `proxy` literal against the explicit allowlist, and return a clean
 * `RuntimeEnvPolicy` (or `undefined` when nothing is set).
 *
 * Validation is mandatory at every entry point that reaches `augmentedProcessEnv`
 * via this disk source — without it, a malformed `proxy: 'inherit'` typo would
 * propagate to the diagnostic surface as if it were valid, and the user has no
 * way to discover the misconfiguration. `augmentedProcessEnv` itself does
 * defense-in-depth (unknown → `myagents`), so behaviour stays safe, but the
 * visible mismatch is confusing.
 *
 * Best-effort: any error reading config is swallowed and returns `undefined`,
 * so the caller path can't break on a malformed `agent.json`.
 *
 * Used by `external-session.ts` (live session start) and `admin-api.ts`
 * (CLI `runtime diagnose` handler) — keep them in lockstep by funnelling
 * through this one helper.
 */
export async function resolveAgentEnvPolicy(
  workspacePath: string,
): Promise<RuntimeEnvPolicy | undefined> {
  try {
    const { findProjectAgentByWorkspacePath } = await import('../utils/admin-config');
    const agent = findProjectAgentByWorkspacePath(workspacePath);
    const raw = (agent?.runtimeConfig as Record<string, unknown> | undefined)?.envPolicy;
    if (!raw || typeof raw !== 'object') return undefined;
    const policyObj = raw as Record<string, unknown>;
    const proxyRaw = policyObj.proxy;
    const proxy: 'myagents' | 'terminal' | undefined =
      proxyRaw === 'myagents' || proxyRaw === 'terminal'
        ? proxyRaw
        : undefined;
    if (proxyRaw !== undefined && proxy === undefined) {
      // Covers legacy `'direct'` from 0.2.16 dev (removed before release) and
      // any other malformed value (`'inherit'` typo, `true` from wrong UI
      // wire). Silent fallback to the safe default — UI will re-render
      // showing `'MyAgents 代理'` selected and user can pick `'terminal'` if
      // they previously relied on stripping proxy.
      console.warn(
        `[env-utils] Ignoring unsupported envPolicy.proxy=${JSON.stringify(proxyRaw)} for ${workspacePath} — defaulting to 'myagents'`,
      );
    }
    return { proxy };
  } catch (err) {
    console.warn(
      `[env-utils] resolveAgentEnvPolicy(${workspacePath}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/**
 * Resolve an external CLI command to its full executable path.
 *
 * Uses our local `which()` with the augmented PATH (from `getShellPath()`)
 * on ALL platforms.
 *
 * Why this is needed everywhere (not just Windows):
 * - Windows: npm global installs create `.cmd` wrappers; `spawn()` via libuv
 *   doesn't resolve PATH extensions (.CMD/.BAT) → ENOENT. See: #70
 * - macOS/Linux: `spawn()` uses posix_spawnp which searches the CALLER's PATH,
 *   not the env passed to the child. GUI apps (Tauri/Finder) have minimal PATH
 *   that lacks NVM/fnm/volta/asdf paths. Even though augmentedProcessEnv() builds
 *   a correct PATH, the bare command name won't be found by posix_spawnp.
 *   Pre-resolving to a full path bypasses PATH lookup entirely.
 */
export function resolveCommand(command: string): string {
  const resolved = which(command, { PATH: getShellPath() });
  if (resolved) return resolved;
  // Fallback: return as-is and let spawn fail with a clear error
  return command;
}

// eslint-disable-next-line no-control-regex -- Intentional ANSI escape code stripping for log output
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI terminal escape codes (color/style) from a string.
 * External CLI tools (codex, claude) emit colored stderr — raw ANSI codes
 * appear as garbage like `[2m`, `[31m` in unified log files.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
