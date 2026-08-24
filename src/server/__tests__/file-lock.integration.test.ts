/**
 * Pattern 5 — file-lock helper regression tests.
 *
 * Covers:
 *  (a) basic withFileLock serializes two concurrent ops in the same process
 *  (b) confirmed-dead process owners bypass the age grace
 *  (c) live/unknown owners stay protected
 *  (d) unknown owner forms share one strict age-gated protocol
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withFileLock, FileBusyError } from '../utils/file-lock';

let scratch: string;

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('short-lived child did not expose a pid');
  await once(child, 'exit');
  return pid;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-file-lock-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('serializes two concurrent ops on the same lockPath', async () => {
    const lockPath = join(scratch, 'demo.lock');
    const trace: string[] = [];

    const op = (label: string, holdMs: number) =>
      withFileLock({ lockPath, timeoutMs: 2000, pollMs: 10 }, async () => {
        trace.push(`${label}-enter`);
        await new Promise(r => setTimeout(r, holdMs));
        trace.push(`${label}-exit`);
      });

    await Promise.all([op('A', 80), op('B', 20)]);

    // Strict ordering: whichever entered first must exit before the other enters.
    const enterIdx = (label: string) => trace.indexOf(`${label}-enter`);
    const exitIdx = (label: string) => trace.indexOf(`${label}-exit`);
    const first = enterIdx('A') < enterIdx('B') ? 'A' : 'B';
    const second = first === 'A' ? 'B' : 'A';
    expect(exitIdx(first)).toBeLessThan(enterIdx(second));
  });

  it('breaks an old ownerless lock after staleMs', async () => {
    const lockPath = join(scratch, 'stale.lock');
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    let ran = false;
    await withFileLock(
      { lockPath, timeoutMs: 2000, staleMs: 30_000, pollMs: 10 },
      async () => {
        ran = true;
      }
    );
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    ['legacy Node owner', (pid: number) => `node:${pid}`],
    ['current Node owner', (pid: number) => `node:${pid}:0`],
    ['legacy Rust owner', (pid: number) => `rust:${pid}`],
    ['current Rust owner', (pid: number) => `rust:${pid}:0`],
  ] as const)('breaks a fresh lock immediately when its %s pid is confirmed dead', async (_label, ownerForPid) => {
    const deadPid = await exitedChildPid();
    const lockPath = join(scratch, 'fresh-dead.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), `${ownerForPid(deadPid)}\n`, 'utf-8');

    let ran = false;
    await withFileLock(
      { lockPath, timeoutMs: 200, staleMs: 60_000, pollMs: 10 },
      async () => {
        ran = true;
      }
    );

    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a confirmed-dead owner even when wall-clock rollback leaves a future mtime', async () => {
    const deadPid = await exitedChildPid();
    const lockPath = join(scratch, 'future-dead.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), `node:${deadPid}:0\n`, 'utf-8');
    const future = new Date(Date.now() + 60_000);
    utimesSync(lockPath, future, future);

    await withFileLock(
      { lockPath, timeoutMs: 200, staleMs: 60_000, pollMs: 10 },
      async () => { /* acquired */ },
    );

    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not age-break a legacy lock whose owner pid is alive', async () => {
    const lockPath = join(scratch, 'old-live.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), `node:${process.pid}\n`, 'utf-8');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    await expect(withFileLock(
      { lockPath, timeoutMs: 100, staleMs: 0, pollMs: 10 },
      async () => { /* unreachable */ }
    )).rejects.toBeInstanceOf(FileBusyError);
  });

  it('retains a valid process owner when the liveness probe is inconclusive', async () => {
    const lockPath = join(scratch, 'unobservable-owner.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), 'node:123\n', 'utf-8');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      await expect(withFileLock(
        { lockPath, timeoutMs: 100, staleMs: 0, pollMs: 10 },
        async () => { /* unreachable */ }
      )).rejects.toBeInstanceOf(FileBusyError);
    } finally {
      killSpy.mockRestore();
    }
  });

  it.each([
    ['mismatched', '1'],
    ['maximum JS-safe', '9007199254740991'],
  ] as const)('retains a live owner with a %s v1 startMs even when the lock is old', async (_label, startMs) => {
    const lockPath = join(scratch, 'mismatched-start.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), `node:${process.pid}:${startMs}\n`, 'utf-8');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    await expect(withFileLock(
      { lockPath, timeoutMs: 100, staleMs: 0, pollMs: 10 },
      async () => { /* unreachable */ }
    )).rejects.toBeInstanceOf(FileBusyError);
  });

  it.each([
    ['missing owner', null],
    ['renderer owner', 'renderer:123'],
    ['extra field', `node:${process.pid}:1:extra`],
    ['signed pid', `node:+${process.pid}`],
    ['signed Rust pid', `rust:+${process.pid}:1`],
    ['signed startMs', `rust:${process.pid}:+1`],
    ['negative pid', 'node:-1'],
    ['zero pid', 'node:0'],
    ['empty pid', 'node:'],
    ['non-numeric pid', 'node:nope'],
    ['PID overflow', 'node:2147483648'],
    ['negative startMs', `rust:${process.pid}:-1`],
    ['empty startMs', `rust:${process.pid}:`],
    ['non-numeric startMs', `rust:${process.pid}:nope`],
    ['startMs overflow', `node:${process.pid}:9007199254740992`],
    ['unknown runtime', `other:${process.pid}`],
    ['BOM-prefixed token', `\uFEFFnode:${process.pid}`],
    ['vertical-tab-prefixed token', `\u000Bnode:${process.pid}`],
  ] as const)('age-gates %s instead of treating it as a process owner', async (_label, owner) => {
    const lockPath = join(scratch, 'malformed-owner.lock');
    mkdirSync(lockPath);
    if (owner !== null) {
      writeFileSync(join(lockPath, 'owner'), `${owner}\n`, 'utf-8');
    }

    await expect(withFileLock(
      { lockPath, timeoutMs: 100, staleMs: 60_000, pollMs: 10 },
      async () => { /* unreachable */ }
    )).rejects.toBeInstanceOf(FileBusyError);

    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    let ran = false;
    await withFileLock(
      { lockPath, timeoutMs: 200, staleMs: 60_000, pollMs: 10 },
      async () => {
        ran = true;
      }
    );
    expect(ran).toBe(true);
  });

  it('does not immediately reclaim a fresh dead-looking owner with an out-of-range startMs', async () => {
    const deadPid = await exitedChildPid();
    const lockPath = join(scratch, 'malformed-dead-owner.lock');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner'),
      `node:${deadPid}:9007199254740992\n`,
      'utf-8',
    );

    await expect(withFileLock(
      { lockPath, timeoutMs: 100, staleMs: 60_000, pollMs: 10 },
      async () => { /* unreachable */ }
    )).rejects.toBeInstanceOf(FileBusyError);
  });

  it('release does NOT delete a different holder when our lock was broken as stale', async () => {
    // Simulates: A acquires lock → A is paused past staleMs → B detects
    // stale + breaks + acquires its own lock → A resumes and releases. The
    // release path must NOT remove B's lock (different owner sentinel).
    const lockPath = join(scratch, 'broken.lock');

    let releaseFromA: () => void = () => { /* noop */ };
    const aReleased = new Promise<void>(r => { releaseFromA = r; });

    // A: acquire and hold.
    const aRun = withFileLock(
      { lockPath, timeoutMs: 2000, staleMs: 60_000, pollMs: 10 },
      async () => {
        // Simulate "broken-as-stale": overwrite the owner file to a
        // different token mid-flight, then wait for the test to release.
        writeFileSync(join(lockPath, 'owner'), 'node:1:9999999999\n', 'utf-8');
        await aReleased;
      },
    );

    // Yield to let A acquire + tamper.
    await new Promise(r => setTimeout(r, 30));
    expect(existsSync(lockPath)).toBe(true);
    // Sanity: owner is the different token now.
    expect(readFileSync(join(lockPath, 'owner'), 'utf-8').trim()).toBe('node:1:9999999999');

    // Release A — its release should detect the owner mismatch and skip the rm.
    releaseFromA();
    await aRun;

    // Lock dir is still present (held by the imaginary different owner).
    expect(existsSync(lockPath)).toBe(true);

    // Cleanup so afterEach can rm the scratch dir.
    rmSync(lockPath, { recursive: true, force: true });
  });

  it('throws FileBusyError when lock is held by an alive owner past timeoutMs', async () => {
    const lockPath = join(scratch, 'held.lock');
    // Hold the lock with a slow op for >300ms, then try to acquire with timeoutMs=100.
    let holderResolve: () => void;
    const holderDone = new Promise<void>(r => { holderResolve = r; });

    const holder = withFileLock({ lockPath, timeoutMs: 2000, pollMs: 10 }, async () => {
      await holderDone;
    });

    // Give the holder a tick to acquire.
    await new Promise(r => setTimeout(r, 30));

    let busy: unknown = null;
    try {
      await withFileLock(
        { lockPath, timeoutMs: 100, staleMs: 60_000, pollMs: 20 },
        async () => { /* unreachable */ }
      );
    } catch (err) {
      busy = err;
    }

    expect(busy).toBeInstanceOf(FileBusyError);
    expect((busy as FileBusyError).code).toBe('FILE_BUSY');

    // Release holder so its promise resolves cleanly.
    holderResolve!();
    await holder;
  });
});
