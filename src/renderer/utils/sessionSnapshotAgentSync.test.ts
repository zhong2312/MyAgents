import { describe, expect, it } from 'vitest';

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import { createRuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import { buildAgentPatchFromSessionSnapshot } from './sessionSnapshotAgentSync';

describe('buildAgentPatchFromSessionSnapshot', () => {
  it('syncs Managed Codex snapshots back as provider defaults, not legacy Codex CLI defaults', () => {
    const identity = createRuntimeBackedProviderIdentity({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.5-codex',
    });

    expect(buildAgentPatchFromSessionSnapshot({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      providerExecutionIdentity: identity,
      model: 'ignored-snapshot-model',
      permissionMode: 'full-auto',
      reasoningEffort: 'high',
      mcpEnabledServers: ['filesystem'],
    }, {
      runtimeConfig: {
        source: 'managed-provider',
        model: 'stale-runtime-model',
        additionalArgs: ['--legacy'],
        envPolicy: { proxy: 'terminal' },
        permissionMode: 'suggest',
      },
    })).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.5-codex',
      runtime: 'builtin',
      permissionMode: 'auto',
      runtimeConfig: {
        envPolicy: { proxy: 'terminal' },
        reasoningEffort: 'high',
      },
      mcpEnabledServers: ['filesystem'],
      enabledOfficialToolIds: undefined,
    });
  });

  it('repairs old Managed Codex snapshots that predate providerExecutionIdentity', () => {
    expect(buildAgentPatchFromSessionSnapshot({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtimeSource: 'managed-provider',
      model: 'gpt-5.4-codex',
      permissionMode: 'auto',
    }, {
      runtimeConfig: {
        source: 'managed-provider',
        model: 'stale-runtime-model',
      },
    })).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.4-codex',
      runtime: 'builtin',
      permissionMode: 'auto',
      runtimeConfig: undefined,
      mcpEnabledServers: undefined,
      enabledOfficialToolIds: undefined,
    });
  });

  it('keeps the existing builtin snapshot sync shape for ordinary providers', () => {
    expect(buildAgentPatchFromSessionSnapshot({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'auto',
      mcpEnabledServers: ['filesystem'],
    })).toEqual({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'auto',
      mcpEnabledServers: ['filesystem'],
    });
  });

  it('clears stale Managed Codex runtime projection when syncing an ordinary provider over it', () => {
    expect(buildAgentPatchFromSessionSnapshot({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'auto',
    }, {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtimeConfig: {
        source: 'managed-provider',
        model: 'gpt-5.5-codex',
        additionalArgs: ['--legacy'],
        envPolicy: { proxy: 'terminal' },
      },
    })).toEqual({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'auto',
      mcpEnabledServers: undefined,
      runtime: 'builtin',
      runtimeConfig: {
        envPolicy: { proxy: 'terminal' },
      },
    });
  });
});
