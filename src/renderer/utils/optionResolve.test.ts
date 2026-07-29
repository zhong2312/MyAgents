import { describe, expect, it } from 'vitest';

import {
  canResumeProviderHistoryForSwitch,
  isExistingSessionSwitch,
  isPinnedProviderUnavailable,
  isResetSessionBirth,
  resolveBuiltinPermissionMode,
  resolveCurrentProviderForSession,
  resolveLegacyBuiltinSnapshotProviderId,
  resolveLauncherProvider,
  shouldBlockSendForLabsDisabledExternalRuntime,
  shouldDegradedLoad,
  shouldResetModelOnProviderChange,
  shouldReuseSseSubscriptionForSessionChange,
  shouldSkipSnapshotWrite,
} from './optionResolve';
import { MANAGED_CODEX_PROVIDER, SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import { toProviderExecutionIntent } from '../../shared/providerExecution';

describe('resolveCurrentProviderForSession (#401)', () => {
  const pinned = { id: 'zhipu' };
  const fallback = { id: 'deepseek' };

  it('uses first-available fallback for fresh/unlocked sessions', () => {
    expect(
      resolveCurrentProviderForSession({
        sessionSnapshotOwnsConfig: false,
        selectedProviderId: 'zhipu',
        selectedProvider: undefined,
        selectedProviderAvailable: false,
        fallbackProvider: fallback,
      }),
    ).toBe(fallback);
  });

  it('does not let owned sessions treat fallback as current provider', () => {
    expect(
      resolveCurrentProviderForSession({
        sessionSnapshotOwnsConfig: true,
        selectedProviderId: 'zhipu',
        selectedProvider: pinned,
        selectedProviderAvailable: false,
        fallbackProvider: fallback,
      }),
    ).toBeUndefined();
  });

  it('returns the exact pinned provider for owned sessions when available', () => {
    expect(
      resolveCurrentProviderForSession({
        sessionSnapshotOwnsConfig: true,
        selectedProviderId: 'zhipu',
        selectedProvider: pinned,
        selectedProviderAvailable: true,
        fallbackProvider: fallback,
      }),
    ).toBe(pinned);
  });
});

describe('shouldBlockSendForLabsDisabledExternalRuntime', () => {
  it('blocks user-managed external CLI sessions when Labs runtime mode is off', () => {
    expect(shouldBlockSendForLabsDisabledExternalRuntime({
      sessionRuntime: 'codex',
      sessionRuntimeSource: 'system-cli',
      multiAgentRuntimeEnabled: false,
    })).toBe(true);
  });

  it('does not block Managed Codex Provider sessions when Labs runtime mode is off', () => {
    expect(shouldBlockSendForLabsDisabledExternalRuntime({
      sessionRuntime: 'codex',
      sessionRuntimeSource: 'managed-provider',
      multiAgentRuntimeEnabled: false,
    })).toBe(false);
  });

  it('does not block builtin sessions or Labs-enabled external sessions', () => {
    expect(shouldBlockSendForLabsDisabledExternalRuntime({
      sessionRuntime: 'builtin',
      sessionRuntimeSource: undefined,
      multiAgentRuntimeEnabled: false,
    })).toBe(false);
    expect(shouldBlockSendForLabsDisabledExternalRuntime({
      sessionRuntime: 'codex',
      sessionRuntimeSource: 'system-cli',
      multiAgentRuntimeEnabled: true,
    })).toBe(false);
  });
});

describe('resolveLegacyBuiltinSnapshotProviderId', () => {
  const providers = [
    {
      id: 'volcengine-api',
      type: 'api' as const,
      models: [{ model: 'doubao-seed-2-0-pro-260215' }],
    },
    {
      id: SUBSCRIPTION_PROVIDER_ID,
      type: 'subscription' as const,
      models: [{ model: 'claude-opus-4-7' }],
    },
    {
      id: 'anthropic-api',
      type: 'api' as const,
      models: [{ model: 'claude-opus-4-7' }],
    },
  ];

  it('keeps an explicit snapshot providerId when the provider owns the snapshot model', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotProviderId: 'volcengine-api',
      snapshotModel: 'doubao-seed-2-0-pro-260215',
      providers,
    })).toBe('volcengine-api');
  });

  it('does not keep an explicit snapshot providerId when the model belongs to another provider', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotProviderId: 'anthropic-api',
      snapshotModel: 'doubao-seed-2-0-pro-260215',
      providers,
    })).toBeUndefined();
  });

  it('keeps an explicit disabled providerId so the UI can report provider unavailable instead of guessing', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotProviderId: 'volcengine-api',
      snapshotModel: 'doubao-seed-2-0-pro-260215',
      providers: providers.map(provider => provider.id === 'volcengine-api'
        ? { ...provider, enabled: false }
        : provider),
    })).toBe('volcengine-api');
  });

  it('recovers a missing providerId when exactly one credential-configured provider owns the snapshot model', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotModel: 'doubao-seed-2-0-pro-260215',
      providers,
      apiKeys: { 'volcengine-api': 'secret' },
    })).toBe('volcengine-api');
  });

  it('does not use the current selected provider to break same-model family ambiguity', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotModel: 'claude-opus-4-7',
      selectedProviderId: 'anthropic-api',
      providers,
      apiKeys: { 'anthropic-api': 'secret' },
      providerVerifyStatus: {
        [SUBSCRIPTION_PROVIDER_ID]: {
          status: 'invalid',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          accountEmail: 'user@example.com',
        },
      },
    })).toBeUndefined();
  });

  it('treats subscription account evidence as credential-configured', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotModel: 'claude-opus-4-7',
      providers,
      providerVerifyStatus: {
        [SUBSCRIPTION_PROVIDER_ID]: {
          status: 'invalid',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          accountEmail: 'user@example.com',
        },
      },
    })).toBe(SUBSCRIPTION_PROVIDER_ID);
  });

  it('does not guess when the model has no credential-configured provider', () => {
    expect(resolveLegacyBuiltinSnapshotProviderId({
      snapshotModel: 'claude-opus-4-7',
      providers,
    })).toBeUndefined();
  });
});

describe('canResumeProviderHistoryForSwitch', () => {
  it('does not force a new session for unrecoverable legacy snapshot identity', () => {
    expect(canResumeProviderHistoryForSwitch({
      legacyCurrentProviderUnknown: true,
      nextProviderEnv: {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
        model: 'deepseek-v4-pro',
      },
    })).toBe(true);
  });

  it('allows known portable third-party providers to cross transport protocols', () => {
    expect(canResumeProviderHistoryForSwitch({
      legacyCurrentProviderUnknown: false,
      currentProviderEnv: {
        providerId: 'volcengine-api',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
        apiProtocol: 'openai',
        model: 'doubao-seed-2-0-pro-260215',
      },
      nextProviderEnv: {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
        model: 'deepseek-v4-pro',
      },
    })).toBe(true);
  });

  it('treats Managed Codex as a runtime-backed provider boundary', () => {
    const builtin = toProviderExecutionIntent({ id: 'deepseek' }, 'deepseek-v4-pro');
    const codex = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');

    expect(canResumeProviderHistoryForSwitch({
      currentIntent: builtin,
      nextIntent: codex,
      legacyCurrentProviderUnknown: false,
    })).toBe(false);
  });

  it('allows Managed Codex model changes inside the same runtime-backed provider family', () => {
    expect(canResumeProviderHistoryForSwitch({
      currentIntent: toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex'),
      nextIntent: toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.5-codex'),
      legacyCurrentProviderUnknown: false,
    })).toBe(true);
  });
});

describe('isPinnedProviderUnavailable (#300)', () => {
  const base = {
    isOwnedSession: true,
    isExternalRuntime: false,
    selectedProviderId: 'skywork-ai',
    resolvedProviderId: 'deepseek', // resolveProvider fell back to first-available
    providersLoaded: true,
  };

  it('flags the bug: owned session pinned skywork-ai but resolver fell back to deepseek', () => {
    expect(isPinnedProviderUnavailable(base)).toBe(true);
  });

  it('is false when the resolved provider matches the pinned one (available)', () => {
    expect(isPinnedProviderUnavailable({ ...base, resolvedProviderId: 'skywork-ai' })).toBe(false);
  });

  it('does NOT false-positive while config is still loading (no providers yet)', () => {
    // providers empty + nothing resolved would otherwise look like a fallback.
    expect(
      isPinnedProviderUnavailable({ ...base, providersLoaded: false, resolvedProviderId: undefined }),
    ).toBe(false);
  });

  it('does not apply to fresh/unlocked tabs — they keep the first-available fallback', () => {
    expect(isPinnedProviderUnavailable({ ...base, isOwnedSession: false })).toBe(false);
  });

  it('does not apply to external runtimes (no providerId to pin)', () => {
    expect(isPinnedProviderUnavailable({ ...base, isExternalRuntime: true })).toBe(false);
  });

  it('is false when the session pinned no provider', () => {
    expect(
      isPinnedProviderUnavailable({ ...base, selectedProviderId: undefined, resolvedProviderId: 'deepseek' }),
    ).toBe(false);
  });

  it('treats "nothing resolved" (no provider available at all) as unavailable for a pinned owned session', () => {
    expect(isPinnedProviderUnavailable({ ...base, resolvedProviderId: undefined })).toBe(true);
  });
});

describe('shouldResetModelOnProviderChange (#300)', () => {
  it('does NOT reset a still-valid pinned model (the availability-flip regression)', () => {
    // unavailable→available flip re-resolves currentProvider to the pinned skywork
    // provider; skywork-ai/skyclaw-v1 IS in its list → must not be stomped.
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['skywork-ai/skyclaw-v1', 'skywork-ai/skyclaw-mini'],
        selectedModel: 'skywork-ai/skyclaw-v1',
      }),
    ).toBe(false);
  });

  it('resets when the selected model is genuinely absent from the provider', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
        selectedModel: 'skywork-ai/skyclaw-v1', // not a deepseek model
      }),
    ).toBe(true);
  });

  it('never resets for subscription providers (cannot validate)', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'subscription',
        providerModels: undefined,
        selectedModel: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('never resets when the provider has no known model list', () => {
    expect(
      shouldResetModelOnProviderChange({ providerType: 'thirdParty', providerModels: [], selectedModel: 'x' }),
    ).toBe(false);
    expect(
      shouldResetModelOnProviderChange({ providerType: 'thirdParty', providerModels: undefined, selectedModel: 'x' }),
    ).toBe(false);
  });

  it('does not reset when no model is selected yet', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['a', 'b'],
        selectedModel: undefined,
      }),
    ).toBe(false);
  });
});

describe('resolveBuiltinPermissionMode (#244)', () => {
  it('falls back to the agent config before the project sync runs (the bug)', () => {
    // Fresh tab: state still holds the mount-time 'auto' default, config has
    // just loaded with fullAgency. Must NOT ship 'auto'.
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: 'fullAgency',
        projectPermissionMode: 'plan',
        defaultPermissionMode: 'auto',
      }),
    ).toBe('fullAgency');
  });

  it('prefers project, then global default, when agent has none', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: undefined,
        projectPermissionMode: 'plan',
      }),
    ).toBe('plan');
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        defaultPermissionMode: 'fullAgency',
      }),
    ).toBe('fullAgency');
  });

  it('trusts state once synced (covers user toggle + session snapshot)', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: true,
        statePermissionMode: 'plan',
        agentPermissionMode: 'fullAgency',
      }),
    ).toBe('plan');
  });

  it('falls back to state when nothing is configured', () => {
    expect(
      resolveBuiltinPermissionMode({ projectSynced: false, statePermissionMode: 'auto' }),
    ).toBe('auto');
  });
});

describe('resolveLauncherProvider (#234)', () => {
  it('uses the agent default when it diverges from the stale cache (the bug)', () => {
    // User changed Agent default MiniMax → DeepSeek; launcherLastUsed still
    // remembers MiniMax. Agent default must win, and the stale MiniMax model
    // must be dropped.
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('keeps the cached provider+model when consistent with the agent', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'deepseek',
      lastUsedModel: 'deepseek-v4-pro',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    // user's explicit launcher model choice survives within the same provider
    expect(r.model).toBe('deepseek-v4-pro');
  });

  it('honors the cache when the agent has no explicit provider', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: undefined,
      workspaceProviderId: 'deepseek',
    });
    expect(r.providerId).toBe('minimax');
    expect(r.model).toBe('MiniMax-M2.7');
  });

  it('falls back agent → workspace → cache → global when no cache match', () => {
    expect(
      resolveLauncherProvider({ agentProviderId: 'openai' }).providerId,
    ).toBe('openai');
    expect(
      resolveLauncherProvider({ workspaceProviderId: 'deepseek' }).providerId,
    ).toBe('deepseek');
    expect(
      resolveLauncherProvider({ defaultProviderId: 'anthropic' }).providerId,
    ).toBe('anthropic');
  });
});

describe('shouldDegradedLoad (#235)', () => {
  const base = {
    mounted: true,
    currentSessionId: 's1',
    target: 's1',
    connectedSseSessionId: null as string | null,
    alreadyLoaded: false,
    prevSessionId: 's0' as string | null | undefined,
    sessionActiveOrStreaming: false,
  };

  it('fires when SSE never attached and the session is unchanged (the bug)', () => {
    expect(shouldDegradedLoad(base)).toBe(true);
  });

  it('does not fire while the session is mid-turn (active/streaming)', () => {
    expect(shouldDegradedLoad({ ...base, sessionActiveOrStreaming: true })).toBe(false);
  });

  it('can fire during an explicit history switch even if the previous session looked active', () => {
    expect(shouldDegradedLoad({
      ...base,
      sessionActiveOrStreaming: true,
      allowWhileActive: true,
    })).toBe(true);
  });

  it('does not fire after unmount', () => {
    expect(shouldDegradedLoad({ ...base, mounted: false })).toBe(false);
  });

  it('does not fire if the user switched sessions while waiting', () => {
    expect(shouldDegradedLoad({ ...base, currentSessionId: 's2' })).toBe(false);
  });

  it('does not fire if SSE attached after all', () => {
    expect(shouldDegradedLoad({ ...base, connectedSseSessionId: 's1' })).toBe(false);
  });

  it('does not fire if the session was already loaded', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's1' })).toBe(false);
  });

  it('still fires if alreadyLoaded but for a different prior session', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's0' })).toBe(true);
  });
});

describe('session-load transition classification (#255)', () => {
  it('recognizes only the exact backend-minted reset session as reset birth', () => {
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    })).toBe(true);

    // Regression: a stale new-session flag must not make a history click look
    // like resetSession's own id upgrade.
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'history-session',
    })).toBe(false);
  });

  it('preserves reset birth after sendMessage clears the stale-event guard', () => {
    const resetBirth = isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    });
    expect(resetBirth).toBe(true);
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: resetBirth,
    })).toBe(false);
  });

  it('treats persisted real-to-real transitions as existing-session switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(true);
  });

  it('treats initial null-to-persisted adoption as an existing-session load', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(true);
  });

  it('does not treat pending upgrades or reset births as history switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: true,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(false);

    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: true,
    })).toBe(false);
  });
});

describe('SSE session binding handover (#491)', () => {
  it('reuses the active subscription only for pending-to-real materialization', () => {
    expect(shouldReuseSseSubscriptionForSessionChange({
      attachedSessionId: 'pending-session',
      nextSessionId: 'real-session',
      isAttachedSessionPending: true,
      isNextSessionPending: false,
    })).toBe(true);
  });

  it('replaces the subscription for every real-session switch', () => {
    expect(shouldReuseSseSubscriptionForSessionChange({
      attachedSessionId: 'session-a',
      nextSessionId: 'session-b',
      isAttachedSessionPending: false,
      isNextSessionPending: false,
    })).toBe(false);
  });
});

describe('shouldSkipSnapshotWrite (#305)', () => {
  // v0.2.39: desktop Tab edits are explicit desktop-owner intent. Even a
  // pure IM-sourced session must be promoted to a session snapshot when the
  // user changes config from the Tab; IM live-follow resumes only after the
  // channel creates a new session.

  it('writes snapshot when sessionMeta is still loading (loadSession in flight)', () => {
    // This is the reported #305 race: Windows + slow disk, user reaches model picker
    // before TabProvider.loadSession resolves; sessionMeta is still null.
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: null,
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: false,
    })).toBe(false);
  });

  it('writes snapshot for a loaded Desktop session', () => {
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'desktop',
      sessionMetaConfigSnapshotAt: '2026-06-04T00:00:00.000Z',
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for a loaded legacy session with no source (auto-migrates)', () => {
    // Pre-v0.1.69 sessions had no `source` field. The PATCH endpoint stamps
    // configSnapshotAt on first snapshot write, lazily promoting them to owned.
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: undefined,
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for a PURE-IM private session opened in a desktop Tab', () => {
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'feishu_private',
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for a PURE-IM group session opened in a desktop Tab', () => {
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'dingtalk_group',
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for OpenClaw channel sources following the *_private/_group convention', () => {
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'discord_group',
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'wechat_private',
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for a desktop-to-IM handover session (PRD 0.2.14: snapshot survives handover)', () => {
    // Codex caught this in the dual-review pass: a desktop session handed over
    // to an IM channel acquires an IM-shaped `source` but keeps its
    // configSnapshotAt. The IM bridge then resolves "desktop-handover snapshot
    // wins" on turn delivery (server/index.ts ~8593). If the Tab edits this
    // session's model/permission, we MUST write the snapshot — otherwise the
    // IM turn keeps using the old frozen values.
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'feishu_private',
      sessionMetaConfigSnapshotAt: '2026-06-04T00:00:00.000Z',
      sessionMetaLoaded: true,
    })).toBe(false);
    // Same for other IM platforms.
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'dingtalk_group',
      sessionMetaConfigSnapshotAt: '2026-06-04T00:00:00.000Z',
      sessionMetaLoaded: true,
    })).toBe(false);
  });

  it('writes snapshot for an unknown non-IM-shaped source (defensive default)', () => {
    // A future source like 'cron' or 'api' that doesn't follow the IM convention
    // should default to "write" — IM detection is opt-in by suffix.
    expect(shouldSkipSnapshotWrite({
      sessionMetaSource: 'cron',
      sessionMetaConfigSnapshotAt: null,
      sessionMetaLoaded: true,
    })).toBe(false);
  });
});
