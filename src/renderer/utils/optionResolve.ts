/**
 * Pure resolvers for "which option value do we actually use" decisions that
 * are otherwise buried in giant components (Chat.tsx / Launcher.tsx). Extracted
 * as a Functional Core so the precedence rules can be unit-tested without
 * standing up React.
 */
import type { PermissionMode } from '@/config/types';
import {
  canResumeAcrossProviderBoundary,
  type ProviderHistoryEnv,
  type ProviderHistoryPolicy,
} from '../../shared/providerHistory';
import {
  canReuseSessionAcrossProviderExecutionBoundary,
  type ProviderExecutionIntent,
} from '../../shared/providerExecution';
import type { ProviderVerifyStatus } from '../../shared/config-types';
import {
  isConcreteProviderRoute,
  resolveLegacyModelOnlyProviderRoute,
} from '../../shared/providerRoute';

type ProviderWithModels = {
  id: string;
  type?: 'api' | 'subscription';
  enabled?: boolean;
  models?: ReadonlyArray<{ model?: string | null }>;
};

function nonEmpty(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function providerHasModel(provider: ProviderWithModels, model: string): boolean {
  return provider.models?.some(entry => entry.model === model) ?? false;
}

/**
 * #244 — permission mode for a builtin-runtime send/display.
 *
 * The `permissionMode` React state is seeded by a useState initializer that
 * runs while useConfig() is still loading (currentAgent/currentProject
 * undefined → 'auto' fallback). The one-time project-sync effect that corrects
 * it fires only AFTER first paint, so on a fresh tab a user can send before it
 * runs and ship the stale 'auto' instead of the workspace's configured mode.
 *
 * Until that sync has happened (`projectSynced=false`), resolve from config
 * directly: agent → project → global default. Once synced (or the user has
 * toggled the control, which also flips the flag), `statePermissionMode` is
 * authoritative — it already folds in user toggles and session snapshots.
 */
export function resolveBuiltinPermissionMode(args: {
  projectSynced: boolean;
  statePermissionMode: PermissionMode;
  agentPermissionMode?: string | null;
  projectPermissionMode?: string | null;
  defaultPermissionMode?: string | null;
}): PermissionMode {
  if (args.projectSynced) return args.statePermissionMode;
  return (
    (args.agentPermissionMode as PermissionMode | undefined) ??
    (args.projectPermissionMode as PermissionMode | undefined) ??
    (args.defaultPermissionMode as PermissionMode | undefined) ??
    args.statePermissionMode
  );
}

/**
 * #234 — provider/model the launcher should use for a NEW session.
 *
 * `launcherLastUsed` is a global, workspace-agnostic snapshot of the last
 * provider/model the user explicitly picked from the launcher. The launcher
 * restored it verbatim on mount, so after the user changed an Agent's default
 * provider in Settings (e.g. MiniMax → DeepSeek) the launcher kept opening
 * sessions on the stale MiniMax provider → request timeouts.
 *
 * Rule: `launcherLastUsed` is only trustworthy when it is consistent with the
 * selected agent/workspace's current default provider. If the agent has a
 * configured provider and it differs from the cached one, the agent default
 * wins (and the stale model is dropped with it — a model from another provider
 * is meaningless). When they agree, the cached model is kept (lets the user's
 * explicit model choice survive). Falls back through workspace → global.
 */
export function resolveLauncherProvider(args: {
  lastUsedProviderId?: string | null;
  lastUsedModel?: string | null;
  agentProviderId?: string | null;
  agentModel?: string | null;
  workspaceProviderId?: string | null;
  workspaceModel?: string | null;
  defaultProviderId?: string | null;
}): { providerId: string | undefined; model: string | undefined } {
  const agentProvider = args.agentProviderId ?? undefined;
  const cachedProvider = args.lastUsedProviderId ?? undefined;

  // The cached provider is honored only when it still matches the agent's
  // current default (or the agent has no explicit provider). Otherwise the
  // Settings change is newer than the cache → agent default wins.
  const cacheConsistent =
    !!cachedProvider && (!agentProvider || cachedProvider === agentProvider);

  if (cacheConsistent) {
    return {
      providerId: cachedProvider,
      model: args.lastUsedModel ?? args.agentModel ?? args.workspaceModel ?? undefined,
    };
  }

  const providerId =
    agentProvider ??
    args.workspaceProviderId ??
    cachedProvider ??
    args.defaultProviderId ??
    undefined;

  // Keep the cached model only if it belonged to the provider we're now using.
  const model =
    providerId === cachedProvider
      ? args.lastUsedModel ?? undefined
      : args.agentModel ?? args.workspaceModel ?? undefined;

  return { providerId: providerId ?? undefined, model };
}

/**
 * Resolve the provider object the Chat UI may treat as "current".
 *
 * New/unlocked sessions can use the first-available fallback as a template
 * convenience. Owned sessions cannot: falling back would present DeepSeek (or
 * any first available provider) as if it were the session-pinned Zhipu/SensNova
 * provider, and later model-only logic would persist the wrong provider.
 */
export function resolveCurrentProviderForSession<T>(args: {
  sessionSnapshotOwnsConfig: boolean;
  selectedProviderId: string | undefined;
  selectedProvider: T | undefined;
  selectedProviderAvailable: boolean;
  fallbackProvider: T | undefined;
}): T | undefined {
  if (!args.sessionSnapshotOwnsConfig) return args.fallbackProvider;
  if (!args.selectedProviderId) return undefined;
  return args.selectedProviderAvailable ? args.selectedProvider : undefined;
}

/**
 * v0.2.40 compatibility: some owned builtin snapshots were promoted with
 * `model + configSnapshotAt` but without `providerId`. Provider-scoped model
 * selection needs the missing provider identity, so recover it from the model
 * registry only when the answer is deterministic.
 */
export function resolveLegacyBuiltinSnapshotProviderId(args: {
  snapshotProviderId?: string | null;
  snapshotModel?: string | null;
  selectedProviderId?: string | null;
  providers: ReadonlyArray<ProviderWithModels>;
  apiKeys?: Record<string, string | null | undefined>;
  providerVerifyStatus?: Record<string, ProviderVerifyStatus | undefined>;
}): string | undefined {
  const explicitProviderId = nonEmpty(args.snapshotProviderId);
  const model = nonEmpty(args.snapshotModel);
  if (explicitProviderId) {
    const provider = args.providers.find(candidate => candidate.id === explicitProviderId);
    if (!provider) return undefined;
    if (model && (provider.models?.length ?? 0) > 0 && !providerHasModel(provider, model)) {
      return undefined;
    }
    return explicitProviderId;
  }

  if (!model) return undefined;
  const route = resolveLegacyModelOnlyProviderRoute({
    model,
    providers: args.providers.map(provider => ({
      ...provider,
      type: provider.type ?? 'api',
      models: provider.models?.map(entry => ({
        model: entry.model ?? '',
        modelName: entry.model ?? '',
        modelSeries: entry.model ?? '',
      })) ?? [],
    })),
    credentials: {
      apiKeys: args.apiKeys,
      verifyStatus: args.providerVerifyStatus,
    },
  });
  return isConcreteProviderRoute(route) ? route.providerId : undefined;
}

/**
 * Legacy snapshots with no recoverable provider are historical data with
 * incomplete identity, not proof that the transcript belongs to Anthropic's
 * signed-history family. The force-new-session dialog is a whitelist safety
 * mechanism; when the current boundary is unknown, do not invent a boundary.
 */
export function canResumeProviderHistoryForSwitch(args: {
  currentIntent?: ProviderExecutionIntent;
  nextIntent?: ProviderExecutionIntent;
  currentProviderEnv?: ProviderHistoryEnv;
  nextProviderEnv?: ProviderHistoryEnv;
  legacyCurrentProviderUnknown: boolean;
  policy?: ProviderHistoryPolicy;
}): boolean {
  if (args.currentIntent || args.nextIntent) {
    return canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent: args.currentIntent,
      nextIntent: args.nextIntent,
      currentProviderEnv: args.currentProviderEnv,
      nextProviderEnv: args.nextProviderEnv,
      legacyCurrentProviderUnknown: args.legacyCurrentProviderUnknown,
      policy: args.policy,
    });
  }
  if (args.legacyCurrentProviderUnknown && !args.currentProviderEnv) {
    return true;
  }
  return canResumeAcrossProviderBoundary(
    args.currentProviderEnv,
    args.nextProviderEnv,
    args.policy,
  );
}

/**
 * #235 — should the degraded-load fallback actually fire when its timer
 * elapses? The tab's SSE never (re)attached within the grace window, so we
 * want to load the session over HTTP — but only if the world hasn't moved on
 * while we waited. Pure so the bail conditions are unit-testable; the timer
 * plumbing stays in TabProvider.
 */
export function shouldDegradedLoad(args: {
  mounted: boolean;
  currentSessionId: string | null;
  target: string;
  connectedSseSessionId: string | null;
  alreadyLoaded: boolean;
  prevSessionId: string | null | undefined;
  /**
   * Session is mid-turn (system-init seen or chunks streaming). Mirrors the
   * unified session-load effect's "Do NOT call loadSession while AI is
   * responding" guard — refetching would clobber the live history (the
   * backend turn itself survives, since loadSession is read-only and a
   * same-session switch short-circuits, but the UI would flash). Keep the
   * invariant in one place rather than relying on that server-side mercy.
   */
  sessionActiveOrStreaming: boolean;
  /**
   * Explicit history switches are allowed to load even when the previous
   * session left a stale "active" ref behind. Without this, the fallback can
   * preserve the same split-brain as the primary load gate: the tab points at
   * the target session but visible/server state still belongs to the old one.
   */
  allowWhileActive?: boolean;
}): boolean {
  if (!args.mounted) return false;
  if (args.currentSessionId !== args.target) return false; // session switched away
  if (args.connectedSseSessionId === args.target) return false; // SSE attached after all
  if (args.alreadyLoaded && args.prevSessionId === args.target) return false; // already loaded
  if (args.sessionActiveOrStreaming && !args.allowWhileActive) return false; // don't reload mid-turn
  return true;
}

/**
 * #300 — an owned session pinned a provider, but `resolveProvider` had to fall
 * back to a DIFFERENT provider because the pinned one is unavailable (missing
 * API key / disabled / deleted). In that state the renderer must NOT:
 *   - silently route to / bill the fallback provider (the reported 402: the
 *     session was reset onto deepseek, whose balance the user had just fled), or
 *   - let the model-sync effects overwrite the pinned model with the fallback
 *     provider's primaryModel.
 *
 * Scoped deliberately:
 *   - `isOwnedSession` only — a fresh/unlocked tab intentionally keeps
 *     `resolveProvider`'s first-available fallback (a sane default when the
 *     agent's configured provider was deleted). The bug is specific to a session
 *     that *froze* its own provider choice.
 *   - builtin runtime only — external runtimes (Codex/CC/Gemini) carry no
 *     providerId, so there is nothing to pin or fall back from.
 *   - `providersLoaded` gate — during useConfig()'s async load `providers` is
 *     empty and `resolvedProviderId` is transiently undefined; without this gate
 *     every owned session would false-positive on first paint.
 */
export function isPinnedProviderUnavailable(args: {
  isOwnedSession: boolean;
  isExternalRuntime: boolean;
  selectedProviderId: string | undefined;
  resolvedProviderId: string | undefined;
  providersLoaded: boolean;
}): boolean {
  if (args.isExternalRuntime || !args.isOwnedSession) return false;
  if (!args.providersLoaded) return false;
  if (!args.selectedProviderId) return false;
  return args.resolvedProviderId !== args.selectedProviderId;
}

/**
 * Labs `multiAgentRuntime` only gates user-managed CLI runtimes. Managed Codex
 * Provider sessions are provider-owned and carry `runtimeSource=managed-provider`;
 * they must remain sendable when Labs is off.
 */
export function shouldBlockSendForLabsDisabledExternalRuntime(args: {
  sessionRuntime: string | null;
  sessionRuntimeSource: string | undefined;
  multiAgentRuntimeEnabled: boolean;
}): boolean {
  return args.sessionRuntime !== null
    && args.sessionRuntime !== 'builtin'
    && args.sessionRuntimeSource !== 'managed-provider'
    && !args.multiAgentRuntimeEnabled;
}

/**
 * #300 — should the deferred provider-change effect reset `selectedModel` to the
 * resolved provider's primaryModel?
 *
 * The old effect reset UNCONDITIONALLY on any `currentProvider.id` change, which
 * stomped a still-valid pinned model whenever `currentProvider` re-resolved —
 * notably on the credentials-load availability flip (`apiKeys` start empty, so a
 * pinned provider transiently resolves as unavailable→available and the effect
 * fired with a perfectly valid model). Reset ONLY when the selected model is
 * genuinely absent from the resolved provider's model list — the same validity
 * rule the model-validation effect uses, so the two agree. Subscription providers
 * and providers with no known model list are never reset (we can't validate, so
 * we must not clobber). Caller still gates on `!isPinnedProviderUnavailable` so a
 * fallback provider's model list is never used to judge the pinned model.
 */
export function shouldResetModelOnProviderChange(args: {
  providerType: string | undefined;
  providerModels: string[] | undefined;
  selectedModel: string | undefined;
}): boolean {
  if (args.providerType === 'subscription') return false;
  if (!args.providerModels || args.providerModels.length === 0) return false;
  if (!args.selectedModel) return false;
  return !args.providerModels.includes(args.selectedModel);
}

/**
 * True only for the backend-minted session that belongs to an explicit "new
 * chat" reset/adoption. This remains true even after sendMessage clears
 * `isNewSessionRef` before the backend emits system-init, so the first live
 * turn after reset is still treated as a birth rather than a history switch.
 */
export function isResetSessionBirth(args: {
  resetBirthSessionId: string | null;
  sessionId: string | null | undefined;
}): boolean {
  return Boolean(args.sessionId && args.resetBirthSessionId === args.sessionId);
}

/**
 * Pending -> real materialization is the only identity upgrade the generic
 * binding effect can prove from its own inputs. Explicit reset/migration owners
 * relabel their active attachment atomically when that operation is accepted;
 * every real -> real change reaching this helper is therefore a true switch.
 */
export function shouldReuseSseSubscriptionForSessionChange(args: {
  attachedSessionId: string | null;
  nextSessionId: string | null | undefined;
  isAttachedSessionPending: boolean;
  isNextSessionPending: boolean;
}): boolean {
  if (!args.attachedSessionId || !args.nextSessionId) return false;
  if (args.attachedSessionId === args.nextSessionId) return false;
  return args.isAttachedSessionPending && !args.isNextSessionPending;
}

/**
 * A real persisted-session switch must run loadSession, even if the renderer
 * still thinks the previous session is active. Pending->real and reset-birth
 * transitions are the live sidecar becoming durable; initial null->persisted
 * adoption and persisted real->real are history loads and need REST restore.
 */
export function isExistingSessionSwitch(args: {
  sessionChanged: boolean;
  wasPendingSession: boolean;
  isPendingSession: boolean;
  isResetSessionBirth: boolean;
}): boolean {
  return args.sessionChanged
    && !args.wasPendingSession
    && !args.isPendingSession
    && !args.isResetSessionBirth;
}

/**
 * Desktop Tab config writes always go to the session snapshot first.
 *
 * Earlier #305 logic skipped snapshot writes for pure IM sessions. That matched
 * the old "IM owns the session forever" model, but not the v0.2.39 owner rule:
 * once a desktop Tab opens an IM session and the user changes model / permission
 * / MCP / plugins, the Tab becomes an owner and the session must be promoted to
 * a self-contained snapshot. IM live-follow resumes only after that channel
 * creates a new session (`/new` or desktop "new conversation").
 *
 * Keep this as a named resolver because Chat still centralizes the policy here,
 * and the tests document the product invariant that prevents future regressions
 * back to "skip pure IM".
 */
export function shouldSkipSnapshotWrite(_args: {
  sessionMetaSource: string | null | undefined;
  sessionMetaConfigSnapshotAt: string | null | undefined;
  sessionMetaLoaded: boolean;
}): boolean {
  return false;
}
