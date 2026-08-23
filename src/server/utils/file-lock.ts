/**
 * Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
 *
 * Uses atomic mkdir as the lock primitive — same approach as the renderer-side
 * acquireFileLock and the Rust with_config_lock. Each lockdir contains an
 * `owner` file (`node:<pid>:<startTime>`) used for stale-lock recovery and
 * release fencing.
 * Confirmed-dead process owners are reclaimed immediately;
 * missing, renderer, or malformed owners are reclaimed only after `staleMs`.
 * A process owner that still exists is never evicted based on age alone.
 *
 * Async polling only — no Atomics.wait / no SharedArrayBuffer / no busy-wait.
 * Throws FileBusyError on timeout (caller can choose to retry or surface).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { resolve } from 'path';

export interface FileLockOptions {
  /** Absolute path to the lock directory (e.g. `<file>.lock`). */
  lockPath: string;
  /** Max time to wait for lock acquisition before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** Grace period before recovering a lock with no valid process owner. Default 30000ms. */
  staleMs?: number;
  /** Polling interval while waiting. Default 50ms. */
  pollMs?: number;
}

export class FileBusyError extends Error {
  readonly code = 'FILE_BUSY';

  constructor(lockPath: string, timeoutMs: number) {
    super(`File busy: could not acquire lock ${lockPath} within ${timeoutMs}ms; retry`);
    this.name = 'FileBusyError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const DEFAULT_POLL_MS = 50;

/**
 * Process start time in epoch ms — retained in the v1 owner token for wire
 * compatibility and exact release fencing. It is not a strong cross-platform
 * process-incarnation identity: wall-clock adjustment can change a peer's
 * independently derived value.
 */
const PROCESS_START_TIME_MS = Math.round(Date.now() - process.uptime() * 1000);

/** Owner token retains the current v1 runtime/pid/start-time shape. */
function ourOwnerToken(): string {
  return `node:${process.pid}:${PROCESS_START_TIME_MS}`;
}

function delay(ms: number): Promise<void> {
  // NOTE: do NOT `.unref()` this timer. Unlike timers in cancellation.ts /
  // UnifiedLogger.ts that are background-polling, this timer is the ONLY
  // thing keeping a `withFileLock(...)` await alive when the lock is held by
  // someone else. Unrefing it would let the Node event loop exit between
  // polls, surfacing as "unsettled top-level await" warnings + zombie
  // processes that never acquire the lock.
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function trimAsciiWhitespace(value: string): string {
  const isProtocolWhitespace = (code: number) =>
    code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
  let start = 0;
  let end = value.length;
  while (start < end) {
    if (!isProtocolWhitespace(value.charCodeAt(start))) break;
    start += 1;
  }
  while (end > start) {
    if (!isProtocolWhitespace(value.charCodeAt(end - 1))) break;
    end -= 1;
  }
  return value.slice(start, end);
}

interface ProcessOwner {
  pid: number;
}

const MAX_PROCESS_PID = 0x7fffffff;

/** Parse the exact shared v1 process-owner grammar and numeric range. */
function parseProcessOwner(owner: string): ProcessOwner | null {
  const match = /^(node|rust):(\d+)(?::(\d+))?$/.exec(owner);
  if (!match) return null;

  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_PID) return null;

  const startMs = match[3] === undefined ? null : Number(match[3]);
  if (startMs !== null && (!Number.isSafeInteger(startMs) || startMs < 0)) return null;

  return { pid };
}

/**
 * Try to break an existing lock whose owner is no longer authoritative.
 *
 * Owner file format (Pattern 5 + fix #4):
 *   - `node:<pid>:<startMs>` / `rust:<pid>:<startMs>`  →
 *       check pid liveness via `process.kill(pid, 0)`. `startMs` remains part
 *       of the v1 release token, but is not strong PID-reuse evidence.
 *   - `node:<pid>` / `rust:<pid>`        → legacy 2-tuple, pid liveness only
 *   - `renderer:<ts>`                    → renderer pids aren't observable, skip
 *                                          pid check; only stale-by-age may break it.
 *
 * A confirmed-dead owner is safe to reclaim immediately. A process that is
 * alive or whose liveness is inconclusive is retained regardless of age. The
 * age grace period applies only when there is no valid process owner.
 *
 * Returns true if we forcibly removed the lockdir (caller should retry mkdir immediately).
 */
/**
 * Race-safe break: atomically `renameSync` the lockdir to a per-process
 * tombstone path before `rmSync`. Two waiters simultaneously detecting the
 * lock as stale can't both succeed — only the rename winner ends up holding
 * a tombstone, and even if a third process has by then taken a fresh lock
 * under the original path, it stays untouched. Mirrors the Rust release-race
 * fix in `crate::utils::file_lock` (Pattern 5 fix #4).
 */
function breakLockSafely(lockPath: string): boolean {
  const tombstone = `${lockPath}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(lockPath, tombstone);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Another waiter already broke (and possibly re-acquired) the lock — that
      // is success from our perspective: caller should retry mkdir.
      return true;
    }
    // EBUSY / EACCES / etc. — surface failure so the caller polls again.
    return false;
  }
  // We own the tombstone exclusively. Best-effort cleanup; if it fails the
  // GC sweep elsewhere (or a manual rm) handles it.
  try {
    rmSync(tombstone, { recursive: true, force: true });
  } catch { /* ignore */ }
  return true;
}

function tryBreakStaleLock(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
  } catch {
    // Lock disappeared between EEXIST and stat — caller will retry mkdir.
    return true;
  }

  // Read owner sentinel
  let owner = '';
  try {
    // Match Rust's trim_ascii framing exactly. In particular, U+FEFF/BOM is
    // protocol data, not whitespace, so a BOM-prefixed token stays malformed.
    owner = trimAsciiWhitespace(readFileSync(resolve(lockPath, 'owner'), 'utf-8'));
  } catch {
    // No owner file — treat as recoverable purely on age basis.
  }

  const processOwner = parseProcessOwner(owner);
  if (processOwner) {
    try {
      // Signal 0 = liveness probe. A live PID remains authoritative even if
      // its v1 startMs differs; wall-clock adjustment makes that mismatch
      // unsafe as process-incarnation evidence.
      process.kill(processOwner.pid, 0);
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = no such process. EPERM and every other failure may mean the
      // process exists but is not signalable, so retain the lock fail-safe.
      if (code !== 'ESRCH') {
        return false;
      }
    }

    console.warn(
      `[file-lock] Breaking orphaned lock ${lockPath} immediately (dead pid=${processOwner.pid} age=${ageMs}ms)`,
    );
    return breakLockSafely(lockPath);
  }
  // For renderer:<ts> or unrecognized owners we fall through to age-based break.

  if (ageMs <= staleMs) return false;

  console.warn(
    `[file-lock] Breaking stale lock ${lockPath} (age=${ageMs}ms owner=${owner || 'unknown'})`
  );
  return breakLockSafely(lockPath);
}

/**
 * Acquire `opts.lockPath` (a directory created via atomic mkdir), run `op`,
 * and always release the lock.
 *
 * Multiple async callers in the same process serialize naturally because
 * mkdirSync is atomic; cross-process callers serialize the same way. Stale
 * locks with a confirmed-dead owner are recovered immediately; missing,
 * renderer, or malformed owners are recovered after `staleMs`. A valid
 * process owner whose liveness cannot be disproved is retained conservatively.
 */
export async function withFileLock<T>(
  opts: FileLockOptions,
  op: () => Promise<T>
): Promise<T> {
  const lockPath = opts.lockPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const start = Date.now();
  let acquired = false;
  const ourToken = ourOwnerToken();
  while (!acquired) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      try {
        // Preserve the v1 owner shape for cross-version release fencing.
        writeFileSync(resolve(lockPath, 'owner'), `${ourToken}\n`, 'utf-8');
      } catch {
        // Missing owner metadata is non-fatal; peers protect it with staleMs.
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lockdir already exists — see if it's stale.
      if (tryBreakStaleLock(lockPath, staleMs)) {
        // Retry mkdir immediately — don't sleep.
        continue;
      }

      if (Date.now() - start >= timeoutMs) {
        throw new FileBusyError(lockPath, timeoutMs);
      }
      await delay(pollMs);
    }
  }

  try {
    return await op();
  } finally {
    // Pattern 5 fix #4 release race: another process may have broken our
    // lock as stale (e.g. our process paused past staleMs), then taken its
    // own lock under the same path. We must verify the lock dir still
    // belongs to us before deleting — otherwise we'd evict an unrelated
    // current holder.
    try {
      if (existsSync(lockPath)) {
        let currentOwner = '';
        try {
          currentOwner = trimAsciiWhitespace(readFileSync(resolve(lockPath, 'owner'), 'utf-8'));
        } catch {
          // Owner file missing — treat as ours and remove (failsafe so we
          // don't leak the dir; if it's unrelated and lacked an owner file,
          // that's a deeper bug).
          currentOwner = ourToken;
        }
        if (currentOwner === ourToken) {
          rmSync(lockPath, { recursive: true, force: true });
        } else {
          console.warn(
            `[file-lock] our lock at ${lockPath} was broken as stale; not deleting current holder's lock (owner=${currentOwner})`,
          );
        }
      }
    } catch {
      // Best-effort unlock; future timeouts will surface this.
    }
  }
}
