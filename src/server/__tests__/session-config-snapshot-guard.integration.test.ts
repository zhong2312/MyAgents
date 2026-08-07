// Regression for #327 — IM Channel model/provider/permission override must NOT
// clobber a snapshotted (desktop-owned) session's live config.
//
// Scenario: a desktop Chat session (snapshotted: deepseek-v4-pro[1m], DeepSeek
// provider) shares ONE sidecar with a Feishu IM Channel (handover binds the IM
// peer to the desktop session_id). When the IM router (re)warms that sidecar it
// POSTs the channel's overrides — /api/model/set(astron-code-latest),
// /api/provider/set(Xunfei), /api/session/permission-mode — straight into the
// process-global setters. Before the fix:
//   - setSessionModel had NO snapshot guard → currentModel := astron →
//     lookupModelContextLength(undefined) → context-usage window collapses to
//     the SDK 200K default (the desktop tab's ring jumps to 100%).
//   - setSessionProviderEnv mutated currentProviderEnv BEFORE its snapshot check
//     (which only skipped the restart) → live provider became Xunfei while the
//     model resolved back to DeepSeek → real upstream 500 (Model Not Found).
//   - setSessionPermissionMode had no guard → an IM channel on fullAgency could
//     silently downgrade the desktop session's plan-mode gate.
//
// The fix makes the snapshot authoritative at the setter boundary: an IM-router
// config sync (model carries `imConfigSync:true`; provider/permission endpoints
// are Rust-IM-router-only) is ignored when the session is snapshotted. Desktop's
// own model push (no `imConfigSync`) stays authoritative, and pure IM / cron
// (live-follow, no snapshot) sessions keep applying channel config.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control isCurrentSessionSnapshotted() by mocking the metadata source. Keep all
// other SessionStore exports real so agent-session's import graph is intact.
vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return { ...actual, getSessionMetadata: vi.fn() };
});

import { getSessionMetadata } from '../SessionStore';
import {
  setSessionModel,
  getSessionModel,
  setSessionProviderEnv,
  getSessionProviderEnv,
  setSessionPermissionMode,
  getSessionPermissionMode,
  getMcpServers,
  setMcpServers,
} from '../agent-session';
import {
  drainDeferredRestart,
  hasDeferredRestart,
  resetConfigForTest,
  setCurrentMcpServers,
} from '../builtin-session/config';
import { setQuerySession, setSessionProcessing } from '../builtin-session/lifecycle';
import { resetProductSessionBinding } from '../session-engine/product-session-binding';

const getMeta = vi.mocked(getSessionMetadata);

beforeEach(() => {
  // This fixture exercises Session-sidecar setters directly, outside the real
  // bootstrap that normally establishes the product Session binding. Importing
  // shared server modules no longer mints that identity on Global's behalf.
  resetProductSessionBinding({ sessionId: 'snapshot-guard-session' });
});

function markSnapshotted(snapshotted: boolean): void {
  // Only `configSnapshotAt` is consulted by isCurrentSessionSnapshotted().
  getMeta.mockReturnValue(
    (snapshotted ? { configSnapshotAt: '2026-06-09T00:00:00Z' } : {}) as never,
  );
}

afterEach(() => {
  getMeta.mockReset();
});

describe('#327 — snapshot authority for IM config sync (setSessionModel)', () => {
  it('ignores an IM-config-sync model override on a snapshotted session', () => {
    markSnapshotted(true);
    const before = getSessionModel();
    setSessionModel('astron-code-latest', { imConfigSync: true });
    expect(getSessionModel()).toBe(before);
    expect(getSessionModel()).not.toBe('astron-code-latest');
  });

  it('applies a desktop (non-imConfigSync) model push even on a snapshotted session', () => {
    markSnapshotted(true);
    // Desktop picker is authoritative — it updates the snapshot itself, so its
    // push (no imConfigSync flag) MUST still reach the live session.
    setSessionModel('desktop-authoritative-model', { imConfigSync: false });
    expect(getSessionModel()).toBe('desktop-authoritative-model');
  });

  it('applies an IM-config-sync model override on a NON-snapshotted (pure IM) session', () => {
    markSnapshotted(false);
    setSessionModel('pure-im-live-follow-model', { imConfigSync: true });
    expect(getSessionModel()).toBe('pure-im-live-follow-model');
  });
});

describe('#327 — snapshot authority for IM config sync (setSessionProviderEnv)', () => {
  it('ignores a channel provider override on a snapshotted session (no live mutation)', () => {
    markSnapshotted(true);
    const before = getSessionProviderEnv();
    setSessionProviderEnv({ baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com', apiKey: 'k' });
    // The whole point: currentProviderEnv must be UNCHANGED — previously it was
    // mutated to Xunfei before the (restart-only) snapshot check.
    expect(getSessionProviderEnv()).toBe(before);
    expect(getSessionProviderEnv()?.baseUrl ?? '').not.toContain('xf-yun.com');
  });
});

describe('#327 — snapshot authority for IM config sync (setSessionPermissionMode)', () => {
  it('ignores a channel permission override on a snapshotted session', () => {
    markSnapshotted(true);
    const before = getSessionPermissionMode();
    const target = before === 'plan' ? 'fullAgency' : 'plan';
    setSessionPermissionMode(target);
    expect(getSessionPermissionMode()).toBe(before);
  });
});

describe('#512 — layered MCP snapshot authority', () => {
  it('keeps snapshot IDs, refreshes definitions, and honors the global disable lever', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-snapshot-'));
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const previousHome = process.env[envKey];
    process.env[envKey] = scratch;
    const writeConfig = (enabledIds: string[], ownedCommand: string): void => {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [
          { id: 'owned', name: 'Owned', type: 'stdio', command: ownedCommand, isBuiltin: false },
          { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
        ],
        mcpEnabledServers: enabledIds,
      }), 'utf8');
    };

    getMeta.mockReturnValue({
      configSnapshotAt: '2026-08-05T00:00:00.000Z',
      mcpEnabledServers: ['owned'],
    } as never);
    resetConfigForTest();
    setCurrentMcpServers([
      { id: 'owned', name: 'Owned', type: 'stdio', command: 'stale-command', isBuiltin: false },
    ]);
    setQuerySession({} as never);
    setSessionProcessing(true);

    try {
      writeConfig(['owned', 'workspace-default'], 'current-command');
      setMcpServers([
        { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
      ]);
      expect(getMcpServers()).toEqual([
        expect.objectContaining({ id: 'owned', command: 'current-command' }),
      ]);
      expect(hasDeferredRestart()).toBe(true);
      expect(drainDeferredRestart()).toBe('mcp');

      // Definition and selection changes can be coalesced in one disk read.
      // The global security lever must win without letting workspace defaults
      // replace the owned Session's snapshotted ID selection.
      writeConfig(['workspace-default'], 'newer-but-disabled-command');
      setMcpServers([
        { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
      ]);
      expect(getMcpServers()).toEqual([]);
      expect(drainDeferredRestart()).toBe('mcp');
    } finally {
      setQuerySession(null);
      setSessionProcessing(false);
      resetConfigForTest();
      if (previousHome === undefined) delete process.env[envKey];
      else process.env[envKey] = previousHome;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
