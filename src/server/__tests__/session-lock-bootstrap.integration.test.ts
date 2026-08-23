/**
 * Issue #522 — compose the real SessionStore transcript lock with the single
 * deferred-init terminal owner. The HOME redirect must happen before the
 * dynamic imports because SessionStore binds its paths at module load.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../types/session';

type SessionStoreModule = typeof import('../SessionStore');
type ReadinessModule = typeof import('../readiness-state');

let testHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;
let readiness: ReadinessModule;

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('short-lived child did not expose a pid');
  await once(child, 'exit');
  return pid;
}

function transcriptPath(sessionId: string): string {
  return join(testHome, '.myagents', 'sessions', `${sessionId}.jsonl`);
}

function transcriptLockPath(sessionId: string): string {
  return join(testHome, '.myagents', 'session-locks', `${sessionId}.jsonl.lock`);
}

async function createSeededSession(): Promise<{ id: string; transcript: string }> {
  const session = await store.createSession(join(testHome, 'workspace'));
  const snapshot = await store.loadSessionTranscript(session.id);
  const message: SessionMessage = {
    id: 'issue-522-user-message',
    role: 'user',
    content: 'preserve this transcript',
    timestamp: '2026-08-07T00:00:00.000Z',
  };
  const appended = await store.appendSessionMessages(session.id, snapshot.cursor, [message]);
  expect(appended.ok).toBe(true);
  return { id: session.id, transcript: readFileSync(transcriptPath(session.id), 'utf8') };
}

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'myagents-issue-522-bootstrap-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  vi.resetModules();
  store = await import('../SessionStore');
  readiness = await import('../readiness-state');
});

afterEach(() => {
  readiness.__resetReadinessForTests();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

describe('issue #522 — replacement bootstrap transcript lock', () => {
  it('recovers a fresh dead-owner lock on the first SessionStore bootstrap attempt', async () => {
    const session = await createSeededSession();
    const deadPid = await exitedChildPid();
    const lockPath = transcriptLockPath(session.id);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'owner'), `node:${deadPid}\n`, 'utf8');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });

    try {
      let restoredMessages = 0;
      await readiness.runDeferredInit(
        async () => {
          restoredMessages = (await store.loadSessionTranscript(session.id)).messages.length;
        },
        () => 'session-restore',
      );
      await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));

      expect(restoredMessages).toBe(1);
      expect(readiness.getDeferredInitState()).toEqual({ kind: 'ready' });
      expect(existsSync(lockPath)).toBe(false);
      expect(readFileSync(transcriptPath(session.id), 'utf8')).toBe(session.transcript);
      expect(warnings.filter(line => line.includes('Breaking orphaned lock'))).toHaveLength(1);
      expect(warnings.some(line => line.includes('FileBusyError'))).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a live-owner lock and records one structured failed terminal', async () => {
    const session = await createSeededSession();
    const lockPath = transcriptLockPath(session.id);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'owner'), `node:${process.pid}:1\n`, 'utf8');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      await readiness.runDeferredInit(
        async () => {
          await store.loadSessionTranscript(session.id);
        },
        () => 'session-restore',
      );
      await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));

      expect(readiness.buildReadyResponseBody()).toMatchObject({
        status: 503,
        body: {
          state: 'failed',
          phase: 'session-restore',
          retryable: false,
        },
      });
      expect(String(readiness.buildReadyResponseBody().body.error)).toContain('File busy');
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(transcriptPath(session.id), 'utf8')).toBe(session.transcript);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      rmSync(lockPath, { recursive: true, force: true });
    }
  }, 15_000);
});
