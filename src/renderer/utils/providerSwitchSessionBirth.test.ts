import { describe, expect, it } from 'vitest';

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '@/config/types';
import { createConcreteProviderRoute } from '../../shared/providerRoute';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../../shared/official-tools';
import type { ProviderExecutionIntent } from '../../shared/providerExecution';
import {
  buildProviderSwitchSessionBirth,
  buildRuntimeBackedInitialSessionBirth,
} from './providerSwitchSessionBirth';

describe('buildProviderSwitchSessionBirth', () => {
  it('carries managed Codex as session-scoped runtime-backed provider metadata', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.5-codex',
    };

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'ignored-by-runtime-backed-intent',
      permissionMode: 'auto',
      reasoningEffort: 'max',
      mcpEnabledServers: ['filesystem'],
      enabledPluginIds: ['plugin-a'],
    })).toEqual({
      runtime: 'codex',
      opts: {
        runtimeSource: 'managed-provider',
        providerExecutionIdentity: targetIntent,
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        model: 'gpt-5.5-codex',
        permissionMode: 'auto-edit',
        reasoningEffort: 'default',
        mcpEnabledServers: ['filesystem'],
        enabledPluginIds: ['plugin-a'],
      },
    });
  });

  it('creates builtin provider sessions without requiring a workspace template write', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'builtin-provider',
      route: createConcreteProviderRoute('openrouter', 'anthropic/claude-sonnet-4.6'),
    };

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'plan',
      reasoningEffort: 'default',
      mcpEnabledServers: [],
      enabledPluginIds: [],
    })).toEqual({
      runtime: 'builtin',
      opts: {
        providerId: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6',
        permissionMode: 'plan',
        reasoningEffort: 'default',
        mcpEnabledServers: [],
        enabledPluginIds: [],
      },
    });
  });

  it('carries official CLI tool selections into the new session snapshot', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'builtin-provider',
      route: createConcreteProviderRoute('anthropic', 'claude-sonnet-4-6'),
    };

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      reasoningEffort: 'default',
      mcpEnabledServers: [],
      enabledPluginIds: [],
      enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID],
    }).opts.enabledOfficialToolIds).toEqual([IMAGE_UNDERSTANDING_TOOL_ID]);
  });

  it('keeps target-runtime permission and effort values for managed Codex session birth', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.4-codex',
    };

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'ignored-by-runtime-backed-intent',
      permissionMode: 'fullAgency',
      reasoningEffort: 'xhigh',
      mcpEnabledServers: [],
      enabledPluginIds: [],
    }).opts).toMatchObject({
      permissionMode: 'no-restrictions',
      reasoningEffort: 'xhigh',
    });
  });

  it('maps Managed Codex Provider permission semantics onto Codex runtime permissions', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.4-codex',
    };

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'ignored-by-runtime-backed-intent',
      permissionMode: 'plan',
      reasoningEffort: 'default',
      mcpEnabledServers: [],
      enabledPluginIds: [],
    }).opts.permissionMode).toBe('suggest');

    expect(buildProviderSwitchSessionBirth({
      targetIntent,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'ignored-by-runtime-backed-intent',
      permissionMode: 'fullAgency',
      reasoningEffort: 'default',
      mcpEnabledServers: [],
      enabledPluginIds: [],
    }).opts.permissionMode).toBe('no-restrictions');
  });

  it('maps runtime-backed initial session permission before session metadata is created', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.5',
    };

    expect(buildRuntimeBackedInitialSessionBirth({
      identity: targetIntent,
      permissionMode: 'fullAgency',
      reasoningEffort: 'default',
      mcpEnabledServers: [],
      enabledPluginIds: [],
    })).toEqual({
      runtime: 'codex',
      opts: {
        runtimeSource: 'managed-provider',
        providerExecutionIdentity: targetIntent,
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        model: 'gpt-5.5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'default',
        mcpEnabledServers: [],
        enabledPluginIds: [],
      },
    });
  });

  it('does not invent a runtime-backed initial session permission when the caller omitted it', () => {
    const targetIntent: ProviderExecutionIntent = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.5',
    };

    expect(buildRuntimeBackedInitialSessionBirth({
      identity: targetIntent,
    }).opts.permissionMode).toBeUndefined();
  });
});
