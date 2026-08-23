import { describe, it, expect } from 'vitest';

import { snapshotForForkedSession, snapshotForOwnedSession, snapshotForImSession } from './session-snapshot';
import type { SessionMetadata } from '../types/session';
import type { AgentConfig } from '../../shared/types/agent';

// #324 regression (cross-review Critical): owned desktop/cron sessions must
// FREEZE reasoningEffort at creation, with the same runtime-aware dispatch as
// model (issue #224) — otherwise later agent-level effort changes silently
// change old sessions, violating the D1 ownership contract.
function makeAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    name: 'A',
    enabled: true,
    permissionMode: 'auto',
    channels: [],
    ...overrides,
  };
}

describe('snapshotForOwnedSession — reasoning effort capture (#324)', () => {
  it('builtin: captures agent.reasoningEffort', () => {
    const snap = snapshotForOwnedSession(makeAgent({ reasoningEffort: 'max', model: 'claude-fable-5' }));
    expect(snap.reasoningEffort).toBe('max');
    expect(snap.model).toBe('claude-fable-5');
  });

  it('external: captures runtimeConfig.reasoningEffort, not the builtin field', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max', // stale builtin value must NOT leak (issue #224 class)
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'xhigh' },
    }));
    expect(snap.reasoningEffort).toBe('xhigh');
    expect(snap.model).toBe('gpt-5.2-codex');
  });

  it("external: preserves literal 'default' to pin a session back to runtime defaults", () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max',
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'default' },
    }));

    expect(snap.reasoningEffort).toBe('default');
  });

  it('runtime override snapshots the target runtime view instead of post-hoc mutating runtime', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'builtin',
      model: 'claude-opus-4-7',
      reasoningEffort: 'max',
      permissionMode: 'fullAgency',
      runtimeConfig: { model: 'gemini-3.1-pro-preview', reasoningEffort: 'xhigh', permissionMode: 'yolo' },
    }), { runtimeOverride: 'codex' });

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
    expect(snap.permissionMode).toBeUndefined();
    expect(snap.configSnapshotAt).toBeTruthy();
  });

  it('external: drops obviously foreign runtimeConfig fields before writing a snapshot', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      runtimeConfig: {
        model: 'claude-opus-4-7',
        reasoningEffort: 'max',
        permissionMode: 'fullAgency',
      },
    }));

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
    expect(snap.permissionMode).toBeUndefined();
  });

  it('absent on both → undefined (resolver falls back to agent at read time)', () => {
    expect(snapshotForOwnedSession(makeAgent({})).reasoningEffort).toBeUndefined();
  });

  it('IM live-follow snapshot stays effort-free (D4: re-resolves per turn)', () => {
    const snap = snapshotForImSession(makeAgent({ reasoningEffort: 'max' }));
    expect('reasoningEffort' in snap).toBe(false);
  });

  it('Managed Codex provider snapshots runtime-backed identity instead of builtin provider env', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      permissionMode: 'fullAgency',
      runtimeConfig: {
        model: 'stale-runtime-model',
        reasoningEffort: 'high',
      },
      mcpEnabledServers: ['myagents'],
    }), { managedCodexProviderReady: true });

    expect(snap).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.4-codex',
      },
      permissionMode: 'no-restrictions',
      reasoningEffort: 'high',
      mcpEnabledServers: ['myagents'],
    });
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('Managed Codex provider defaults are ignored until readiness is explicit', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: {
        model: 'gpt-5.5-codex',
        source: 'managed-provider',
      },
      providerEnvJson: '{"apiKey":"stale"}',
    }));

    expect(snap.runtime).toBe('builtin');
    expect(snap.runtimeSource).toBeUndefined();
    expect(snap.providerId).toBeUndefined();
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerExecutionIdentity).toBeUndefined();
    expect(snap.model).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('explicit runtime override is not hijacked by stale Managed Codex provider defaults', () => {
    const builtinSnap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { model: 'gpt-5.5-codex', source: 'system-cli' },
    }), { runtimeOverride: 'builtin' });

    expect(builtinSnap.runtime).toBe('builtin');
    expect(builtinSnap.runtimeSource).toBeUndefined();
    expect(builtinSnap.providerId).toBeUndefined();
    expect(builtinSnap.providerRoute).toBeUndefined();
    expect(builtinSnap.providerExecutionIdentity).toBeUndefined();
    expect(builtinSnap.model).toBeUndefined();
    expect(builtinSnap.providerEnvJson).toBeUndefined();

    const systemCliSnap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { model: 'gpt-5.5-codex', source: 'system-cli' },
    }), { runtimeOverride: 'codex' });

    expect(systemCliSnap.runtime).toBe('codex');
    expect(systemCliSnap.runtimeSource).toBe('system-cli');
    expect(systemCliSnap.providerExecutionIdentity).toBeUndefined();
    expect(systemCliSnap.providerId).toBeUndefined();
    expect(systemCliSnap.model).toBeUndefined();
  });

  it('implicit system Codex identity is not hijacked by a dormant managed provider id', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtime: 'codex',
      runtimeConfig: {
        source: 'system-cli',
        model: 'gpt-5.6-sol',
        permissionMode: 'full-auto',
      },
    }), { managedCodexProviderReady: true });

    expect(snap.runtime).toBe('codex');
    expect(snap.runtimeSource).toBe('system-cli');
    expect(snap.providerExecutionIdentity).toBeUndefined();
    expect(snap.model).toBe('gpt-5.6-sol');
    expect(snap.permissionMode).toBe('full-auto');
  });

  it('explicit managed-provider runtime override preserves Managed Codex provider identity', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      runtime: 'builtin',
      runtimeConfig: {
        source: 'system-cli',
        model: 'stale-system-codex-model',
        permissionMode: 'no-restrictions',
      },
    }), {
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    });

    expect(snap).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.5',
      },
    });
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('Managed Codex IM snapshot freezes only the runtime identity', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      permissionMode: 'fullAgency',
    }), { managedCodexProviderReady: true })).toEqual({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    });
  });

  it('Managed Codex IM snapshot also respects explicit runtime override', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { source: 'system-cli' },
    }), { runtimeOverride: 'codex' })).toEqual({
      runtime: 'codex',
      runtimeSource: 'system-cli',
    });
  });

  it('Managed Codex IM snapshot preserves explicit managed-provider runtime identity', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { source: 'system-cli' },
    }), {
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    })).toEqual({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    });
  });
});

describe('snapshotForForkedSession', () => {
  it('preserves the Managed Codex Host catalog identity on a Product Session fork', () => {
    const source = {
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      configSnapshotAt: '2026-08-08T00:00:00.000Z',
      managedCodexExtensionProtocolVersion: '0.146.0',
      managedCodexHostCatalogFingerprint: 'catalog-fingerprint',
    } as SessionMetadata;

    expect(snapshotForForkedSession(source)).toMatchObject({
      managedCodexExtensionProtocolVersion: '0.146.0',
      managedCodexHostCatalogFingerprint: 'catalog-fingerprint',
    });
  });
});
