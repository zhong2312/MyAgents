import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CrashDiagnostics,
} from './crash-diagnostics';

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'myagents-crash-diagnostics-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('CrashDiagnostics', () => {
  it('does not materialize a crash artifact for a healthy Sidecar lifetime', () => {
    const crashDir = join(scratchDir(), 'crash');
    new CrashDiagnostics({ crashDir, pid: 101, now: () => 1_700_000_000_000 });

    expect(existsSync(crashDir)).toBe(false);
  });

  it('caps a process artifact at the configured single-file byte ceiling', () => {
    const crashDir = scratchDir();
    const diagnostics = new CrashDiagnostics({
      crashDir,
      pid: 102,
      now: () => 1_700_000_000_000,
      maxFileBytes: 64,
    });

    diagnostics.record('UNCAUGHT_EXCEPTION', 'x'.repeat(200));
    diagnostics.record('UNCAUGHT_EXCEPTION', 'must-not-grow');

    const [file] = readdirSync(crashDir);
    expect(readFileSync(join(crashDir, file))).toHaveLength(64);
  });

  it('uses a nonce so even a reused PID in the same millisecond cannot share a file', () => {
    const crashDir = scratchDir();
    const now = () => 1_700_000_000_000;

    new CrashDiagnostics({ crashDir, pid: 201, now }).record('STDIO_CLOSED', 'stdout EPIPE');
    new CrashDiagnostics({ crashDir, pid: 201, now }).record('STDIO_CLOSED', 'stdout EPIPE');

    const files = readdirSync(crashDir).filter(file => file.endsWith('.log'));
    expect(files).toHaveLength(2);
    expect(files.every(file => file.includes('-201-'))).toBe(true);
    expect(new Set(files).size).toBe(2);
  });

  it('rotates a long-lived writer by creation age instead of refreshed mtime', () => {
    const crashDir = scratchDir();
    let now = 1_700_000_000_000;
    const diagnostics = new CrashDiagnostics({
      crashDir,
      pid: 301,
      now: () => now,
      maxFileAgeMs: 100,
    });
    diagnostics.record('STDIO_CLOSED', 'first');
    const [firstFile] = readdirSync(crashDir);

    now += 100;
    diagnostics.record('STDIO_CLOSED', 'second');

    const files = readdirSync(crashDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(firstFile);
    expect(readFileSync(join(crashDir, files[0]), 'utf8')).toContain('second');
  });
});
