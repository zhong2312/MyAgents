import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  atomicModifyConfig,
  CONFIG_CHANGED_EVENT,
  ensureManagedCodexProviderDevGateDefault,
} from './appConfigService';

// Issue #303: env-only edits (e.g. user saves MINERU_API_KEY via Settings) used
// to land on disk silently. ConfigProvider's React state never refreshed, so
// Chat's effect couldn't react to mcpServerEnv changes and the live sidecar
// kept a stale `currentMcpServers` (no env) until the user manually switched
// tabs. atomicModifyConfig is the single chokepoint for renderer writes — it
// MUST fire CONFIG_CHANGED_EVENT after a real diff so all consumers re-sync.
//
// Runs in jsdom (DOM pool); browser-dev-mode (localhost hostname) short-circuits
// the Tauri lock path. The behavior under withConfigLock is identical — see
// the production branch in appConfigService.atomicModifyConfig.

describe('atomicModifyConfig — CONFIG_CHANGED_EVENT dispatch (issue #303)', () => {
  let received: Array<{ reason: string } | null>;
  let handler: (e: Event) => void;

  beforeEach(() => {
    localStorage.clear();
    received = [];
    handler = (e: Event) => {
      const ce = e as CustomEvent;
      received.push(ce.detail ?? null);
    };
    window.addEventListener(CONFIG_CHANGED_EVENT, handler);
  });

  afterEach(() => {
    window.removeEventListener(CONFIG_CHANGED_EVENT, handler);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('dispatches CONFIG_CHANGED_EVENT after a write that actually mutates the config', async () => {
    await atomicModifyConfig(c => ({
      ...c,
      mcpServerEnv: { ...(c.mcpServerEnv ?? {}), mineru: { MINERU_API_KEY: 'k1' } },
    }));

    expect(received.length).toBe(1);
    expect(received[0]?.reason).toBe('atomicModifyConfig');
  });

  it('does NOT include AppConfig in event detail (would leak providerApiKeys / mcpServerEnv to window listeners)', async () => {
    await atomicModifyConfig(c => ({
      ...c,
      mcpServerEnv: { ...(c.mcpServerEnv ?? {}), mineru: { MINERU_API_KEY: 'secret-leak-check' } },
    }));

    expect(received.length).toBe(1);
    // Only the trigger reason — never the secret-bearing payload.
    expect(Object.keys(received[0] ?? {})).toEqual(['reason']);
  });

  it('does NOT dispatch when the modifier returns an unchanged config (no-op write)', async () => {
    // First write seeds disk so the second pass observes "no change".
    await atomicModifyConfig(c => ({
      ...c,
      mcpServerEnv: { ...(c.mcpServerEnv ?? {}), mineru: { MINERU_API_KEY: 'k1' } },
    }));
    received.length = 0;

    // Identity modifier — the function should short-circuit and stay silent.
    await atomicModifyConfig(c => c);

    expect(received.length).toBe(0);
  });

  it('allows a composite transaction to defer notification until its final disk state', async () => {
    await atomicModifyConfig(c => ({ ...c, defaultPermissionMode: 'plan' }), {
      notification: 'deferred',
    });

    expect(received).toEqual([]);
  });

  it('fires once per actual mutation across back-to-back writes', async () => {
    // Use a sequence guaranteed to differ from DEFAULT_CONFIG and from each
    // preceding value, so every write is a real diff and fires the event.
    await atomicModifyConfig(c => ({ ...c, defaultPermissionMode: 'plan' }));
    await atomicModifyConfig(c => ({ ...c, defaultPermissionMode: 'fullAgency' }));
    await atomicModifyConfig(c => ({ ...c, defaultPermissionMode: 'auto' }));

    expect(received.length).toBe(3);
    expect(received.every(d => d?.reason === 'atomicModifyConfig')).toBe(true);
  });

  it.each(['light', 'dark', 'system'] as const)('heals legacy theme=%s on the next real locked-style write', async (legacyMode) => {
    localStorage.setItem('myagents:config', JSON.stringify({ theme: legacyMode }));

    const result = await atomicModifyConfig(config => ({
      ...config,
      defaultPermissionMode: 'plan',
    }));

    expect(result.appearanceMode).toBe(legacyMode);
    expect(result.themeId).toBe('myagents-light');
    expect(result.themeSelectionExplicit).toBe(false);
    const stored = JSON.parse(localStorage.getItem('myagents:config') ?? '{}') as Record<string, unknown>;
    expect(stored.theme).toBeUndefined();
    expect(stored.appearanceMode).toBe(legacyMode);
    expect(stored.themeId).toBe('myagents-light');
    expect(stored.themeSelectionExplicit).toBe(false);
  });
});

describe('ensureManagedCodexProviderDevGateDefault', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists the release default as an explicit true when the raw config omits it', async () => {
    localStorage.setItem('myagents:config', JSON.stringify({ theme: 'dark' }));

    await ensureManagedCodexProviderDevGateDefault();

    const stored = JSON.parse(localStorage.getItem('myagents:config') ?? '{}') as Record<string, unknown>;
    expect(stored.theme).toBeUndefined();
    expect(stored.themeId).toBe('myagents-light');
    expect(stored.themeSelectionExplicit).toBe(false);
    expect(stored.appearanceMode).toBe('dark');
    expect(stored.managedCodexProviderDevGate).toBe(true);
    expect(stored.defaultPermissionMode).toBeUndefined();
  });

  it('preserves an explicit false so users can keep the provider hidden', async () => {
    localStorage.setItem('myagents:config', JSON.stringify({
      theme: 'dark',
      managedCodexProviderDevGate: false,
    }));

    await ensureManagedCodexProviderDevGateDefault();

    const stored = JSON.parse(localStorage.getItem('myagents:config') ?? '{}') as Record<string, unknown>;
    expect(stored.managedCodexProviderDevGate).toBe(false);
    // No write occurs when the explicit flag already exists, so disk healing
    // correctly waits for the next real config mutation.
    expect(stored.theme).toBe('dark');
    expect(stored.themeId).toBeUndefined();
    expect(stored.appearanceMode).toBeUndefined();
  });
});
