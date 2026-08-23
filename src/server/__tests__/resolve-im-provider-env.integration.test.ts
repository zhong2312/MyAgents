/**
 * Regression test for issue #237 — IM Channel environment used a stale
 * provider blob instead of re-resolving from the agent's canonical `providerId`.
 *
 * The fix added `resolveImProviderEnv(agentDir, channelId)` in
 * `src/server/utils/admin-config.ts` and wired it into `/api/im/enqueue`.
 * This test pins the contract of the helper so future refactors don't silently
 * regress back to "trust the blob": providerId > providerEnvJson, with channel
 * override winning over agent default.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

const AGENT_WORKSPACE = '/tmp/agent-237';

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(scratch, '.myagents', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-im-provider-'));
  const configDir = join(scratch, '.myagents');
  mkdirSync(configDir, { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('resolveImProviderEnv (#237)', () => {
  it('resolves agent providerId fresh — ignores stale agent.providerEnvJson blob', async () => {
    // User scenario from #237: agent.providerId is currently "deepseek", but
    // agent.providerEnvJson still holds a MiniMax blob from before the user
    // switched providers. The helper MUST resolve via providerId and never
    // touch the stale blob.
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        // Intentionally stale: looks valid but for the WRONG provider.
        providerEnvJson: JSON.stringify({
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'old-minimax-key',
          authType: 'auth_token',
          modelAliases: { sonnet: 'MiniMax-M2.7', opus: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7' },
        }),
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-test-deepseek' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    const env = resolveImProviderEnv(AGENT_WORKSPACE, undefined);

    expect(env).toBeDefined();
    expect(env!.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(env!.apiKey).toBe('sk-test-deepseek');
    // DeepSeek preset aliases from src/shared/config-types.ts, completed for
    // SDK sub-agent aliases by completeModelAliases().
    expect(env!.modelAliases).toEqual({
      fable: 'deepseek-v4-pro',
      sonnet: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-flash',
    });
  });

  it('honors channel.overrides.providerId when present (intentional per-channel override)', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [{
          id: 'channel-1',
          type: 'openclaw:wecom-openclaw-plugin',
          enabled: true,
          overrides: { providerId: 'minimax', model: 'MiniMax-M2.7' },
        }],
      }],
      providerApiKeys: { deepseek: 'sk-d', minimax: 'sk-m' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    // With channelId → channel override wins.
    const overrideEnv = resolveImProviderEnv(AGENT_WORKSPACE, 'channel-1');
    expect(overrideEnv?.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    // Without channelId → agent default.
    const defaultEnv = resolveImProviderEnv(AGENT_WORKSPACE, undefined);
    expect(defaultEnv?.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });

  it('returns undefined when providerId resolution fails (missing API key)', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
      // No providerApiKeys.deepseek — resolveProviderEnv returns undefined.
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    expect(resolveImProviderEnv(AGENT_WORKSPACE, undefined)).toBeUndefined();
  });

  it('falls back to config.defaultProviderId when agent has no providerId', async () => {
    writeConfig({
      defaultProviderId: 'deepseek',
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    const env = resolveImProviderEnv(AGENT_WORKSPACE, undefined);
    expect(env?.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });

  it('returns undefined when agent cannot be matched by workspacePath', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: '/other/path',
        providerId: 'deepseek',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    expect(resolveImProviderEnv(AGENT_WORKSPACE, undefined)).toBeUndefined();
  });

  it('Codex review-fix #1: does NOT fall through to defaultProviderId when no agent matches', async () => {
    // Regression guard: previously the helper fell through to
    // `config.defaultProviderId` whenever the agent lookup failed (legacy IM bot
    // / workspace-path drift). That would silently reroute every unmatched IM
    // call to the global default provider, which is strictly worse than the
    // stale-blob bug we set out to fix. Returning undefined here lets the
    // caller fall back to `payload.providerEnv`.
    writeConfig({
      defaultProviderId: 'minimax',
      agents: [{
        id: 'agent-other',
        name: 'Other',
        enabled: true,
        workspacePath: '/other/path', // does NOT match AGENT_WORKSPACE
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d', minimax: 'sk-m' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    expect(resolveImProviderEnv(AGENT_WORKSPACE, undefined)).toBeUndefined();
  });

  it('Codex review-fix #2: honors legacy channel root-level providerId (pre-bc06386)', async () => {
    // Pre-v0.1.45 the in-IM `/provider` command wrote the channel-root
    // `providerId` field directly (not via `overrides.providerId`). Rust still
    // honors that field — `ChannelConfigRust::to_im_config` at
    // src-tauri/src/im/types.rs:968 walks `overrides.provider_id → channel
    // provider_id → agent provider_id`. Skipping the legacy field here would
    // reroute those configs to the agent default on every IM message.
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [{
          id: 'channel-legacy',
          type: 'openclaw:wecom-openclaw-plugin',
          enabled: true,
          // Legacy root-level providerId — no overrides shape.
          providerId: 'minimax',
          overrides: { model: 'MiniMax-M2.7' },
        }],
      }],
      providerApiKeys: { deepseek: 'sk-d', minimax: 'sk-m' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    const env = resolveImProviderEnv(AGENT_WORKSPACE, 'channel-legacy');
    expect(env?.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(env?.apiKey).toBe('sk-m');
  });

  it('Codex review-fix #2b: overrides.providerId still wins over legacy channel-root providerId', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [{
          id: 'channel-mixed',
          type: 'openclaw:wecom-openclaw-plugin',
          enabled: true,
          providerId: 'minimax', // legacy root — should LOSE to overrides below
          overrides: { providerId: 'zhipu', model: 'glm-5.3' }, // post-bc06386 location — should WIN
        }],
      }],
      providerApiKeys: { deepseek: 'sk-d', minimax: 'sk-m', zhipu: 'sk-z' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    const env = resolveImProviderEnv(AGENT_WORKSPACE, 'channel-mixed');
    expect(env?.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('normalizes Windows workspace identity across separators, case, and trailing slash', async () => {
    const winPath = 'C:\\Users\\Test\\workspace\\';
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: winPath,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderEnv } = await import('../utils/admin-config');
    // Same Windows identity with forward slashes, different case, and no trailing slash should match.
    const fwdEnv = resolveImProviderEnv('c:/users/test/workspace', undefined);
    expect(fwdEnv?.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });

  it('resolves a validated ProviderRoute for pure IM builtin sessions', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderRouting } = await import('../utils/admin-config');
    const routing = resolveImProviderRouting(AGENT_WORKSPACE, undefined);

    expect(routing).toMatchObject({
      kind: 'provider-route',
      providerRoute: {
        kind: 'provider',
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
      },
    });
  });

  it('fails loud when providerId is known but Agent/Channel does not own a model', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderRouting, resolveImProviderEnv } = await import('../utils/admin-config');
    const routing = resolveImProviderRouting(AGENT_WORKSPACE, undefined);

    expect(routing).toMatchObject({
      kind: 'error',
      status: 409,
      reason: 'provider-route-unresolved',
      providerId: 'deepseek',
      providerRoute: {
        kind: 'unknown-legacy',
        reason: 'missing-model',
      },
    });
    expect(resolveImProviderEnv(AGENT_WORKSPACE, undefined)).toBeUndefined();
  });

  it('fails loud when ProviderRoute validation rejects the provider/model pair', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'MiniMax-M2.7',
        permissionMode: 'plan',
        channels: [],
      }],
      providerApiKeys: { deepseek: 'sk-d' },
    });

    const { resolveImProviderRouting } = await import('../utils/admin-config');
    const routing = resolveImProviderRouting(AGENT_WORKSPACE, undefined);

    expect(routing).toMatchObject({
      kind: 'error',
      status: 409,
      reason: 'provider-route-unresolved',
      providerRoute: {
        kind: 'unknown-legacy',
        reason: 'provider-model-mismatch',
      },
    });
  });

  it('fails loud for a known provider route with no live API key', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'plan',
        channels: [],
      }],
    });

    const { resolveImProviderRouting } = await import('../utils/admin-config');
    const routing = resolveImProviderRouting(AGENT_WORKSPACE, undefined);

    expect(routing).toMatchObject({
      kind: 'error',
      status: 409,
      reason: 'provider-env-unavailable',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    });
  });

  it('reports managed Codex provider as external-runtime, not builtin ProviderRoute', async () => {
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Mino',
        enabled: true,
        workspacePath: AGENT_WORKSPACE,
        providerId: 'codex-sub',
        model: 'gpt-5.4',
        permissionMode: 'plan',
        channels: [],
      }],
    });

    const { resolveImProviderRouting } = await import('../utils/admin-config');
    const routing = resolveImProviderRouting(AGENT_WORKSPACE, undefined, {
      managedCodexProviderReady: true,
    });

    expect(routing).toMatchObject({
      kind: 'external-runtime',
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      reason: 'managed-codex-provider',
      model: 'gpt-5.4',
    });
  });
});
