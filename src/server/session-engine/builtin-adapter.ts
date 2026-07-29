import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelQueuedTurnsByOwner,
  cancelImRequest as cancelBuiltinImRequest,
  applyMcpOverrideAndAwaitReady,
  configureWorkbenchToolset as configureBuiltinWorkbenchToolset,
  enqueueUserMessage,
  forkSession,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getAgents,
  getAgentState,
  getBuiltinLiveSessionSnapshot,
  getBuiltinSessionCompletionTerminal,
  getLastBuiltinAssistantText,
  getMcpServers,
  getMessages,
  getPendingInteractiveRequests,
  getQueueStatus,
  getCurrentTurnIdentity as getBuiltinCurrentTurnIdentity,
  getDispatchedTurnIdentity as getBuiltinDispatchedTurnIdentity,
  hasQueuedTurnByOwner as hasBuiltinQueuedTurnByOwner,
  getSessionId,
  getSessionModel,
  getSessionPermissionMode,
  getSessionEnabledOfficialToolIds,
  getSessionProviderEnv,
  getSessionProviderId,
  getSessionReasoningEffort,
  getStreamingAssistantId,
  getSystemInitInfo,
  handleAskUserQuestionResponse,
  handlePermissionResponse,
  interruptCurrentResponse,
  isSessionBusy,
  freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession as materializeBuiltinPendingDesktopSession,
  resetSession,
  rewindSession,
  setAgents,
  setBackgroundAgentPermissionMode,
  setInteractionScenario,
  setMcpServers,
  setSessionModel,
  setSessionPermissionMode,
  setSessionEnabledOfficialToolIds,
  setSessionProviderEnv,
  setProxyConfig,
  setSessionReasoningEffort,
  stripPlaywrightResults,
  switchToSession,
  waitForSessionIdle,
} from '../agent-session';
import type { MessageWire, PermissionMode, ProviderEnv } from '../agent-session';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CancelReason } from '../utils/cancellation';
import { createConcreteProviderRoute, isConcreteProviderRoute, type ProviderRoute } from '../../shared/providerRoute';
import { getEffectiveOfficialToolIdsForSession, materializeProviderRouteEnv, resolveSubscriptionAuthKind, resolveWorkspaceConfig } from '../utils/admin-config';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngineReplayMessage,
  SessionEngine,
} from './types';
import { decideBuiltinInjectedTurnResult } from '../session-core/turn-result-policy';
import type { DispatchGuard, TurnTerminalOutcome } from '../session-core/turn-queue';
import {
  ensureRegisteredAgentSessionOrigin,
  getPersistedSessionOrigin,
  getSessionData,
} from '../SessionStore';
import type { SessionMessage } from '../types/session';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';
import {
  DESKTOP_CHANNEL_DELIVERY,
  IM_CHANNEL_DELIVERY,
  SESSION_BOUND_CHANNEL_DELIVERY,
  injectedTurnChannelDelivery,
} from '../session-core/channel-delivery';

function waitForDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// runInjectedTurn requires an explicit promotion acknowledgement even when no
// domain guard is present. MCP readiness is intentionally not part of it.
const acceptInjectedTurnDispatch: DispatchGuard = async () => ({ accepted: true });

function providerEnvForRouteRequest(request: {
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  model?: string;
}): { providerEnv: ProviderEnv | 'subscription' | undefined; model?: string; error?: string; status?: number } {
  if (!request.providerRoute) {
    return { providerEnv: request.providerEnv, model: request.model };
  }
  if (!isConcreteProviderRoute(request.providerRoute)) {
    return {
      providerEnv: undefined,
      error: 'Provider/model selection is incomplete. Select a provider-model pair before sending.',
      status: 409,
    };
  }
  if (request.model && request.model !== request.providerRoute.model) {
    return {
      providerEnv: undefined,
      error: `ProviderRoute/model mismatch: route model "${request.providerRoute.model}" does not match request model "${request.model}".`,
      status: 409,
    };
  }
  if (request.providerRoute.kind === 'subscription') {
    const authKind = resolveSubscriptionAuthKind(request.providerRoute.providerId);
    if (authKind === 'sdk-native') {
      return { providerEnv: 'subscription', model: request.providerRoute.model };
    }
    if (authKind !== 'host-managed-oauth') {
      return {
        providerEnv: undefined,
        error: `Subscription provider '${request.providerRoute.providerId}' cannot execute in builtin runtime`,
        status: 409,
      };
    }
  }
  const providerEnv = materializeProviderRouteEnv(request.providerRoute);
  if (!providerEnv) {
    return {
      providerEnv: undefined,
      error: `Provider "${request.providerRoute.providerId}" is unavailable or missing an API key.`,
      status: 409,
    };
  }
  return { providerEnv, model: request.providerRoute.model };
}

function getLatestBuiltinResult(): string {
  let latestResult = getLastBuiltinAssistantText();
  if (!latestResult.trim()) {
    const data = getSessionData(getSessionId());
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function getBuiltinWorkspacePath(): string | null {
  const state = getAgentState();
  return typeof state.agentDir === 'string' && state.agentDir.length > 0
    ? state.agentDir
    : null;
}

function messageWireToReplayMessage(message: MessageWire | SessionMessage): SessionEngineReplayMessage {
  const strippedContent = typeof message.content !== 'string'
    ? stripPlaywrightResults(message.content)
    : message.content;
  const content = shrinkReplayContentForClient(strippedContent);
  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments,
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

export function createBuiltinSessionEngine(): SessionEngine {
  return {
    kind: 'builtin',

    isBusy() {
      return isSessionBusy();
    },

    getRuntimeIdentity() {
      return {
        kind: 'builtin',
        runtime: 'builtin',
        sessionId: getSessionId(),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getAgentState().sessionState,
        isBusy: isSessionBusy(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getSessionId(),
        latestResult: getLatestBuiltinResult(),
      };
    },

    getStreamReplaySnapshot() {
      const sessionId = getSessionId();
      const liveSnapshot = getBuiltinLiveSessionSnapshot(sessionId);
      const streamingId = getStreamingAssistantId();
      const replayMessages = getMessages()
        .filter(message => !(streamingId && message.id === streamingId))
        .map(messageWireToReplayMessage);
      const systemInitInfo = getSystemInitInfo();
      return {
        sessionId,
        initState: getAgentState(),
        replayMessages,
        liveStreamingMessage: liveSnapshot?.liveStreamingMessage
          ? messageWireToReplayMessage(liveSnapshot.liveStreamingMessage)
          : null,
        systemInitPayload: systemInitInfo ? { info: systemInitInfo } : undefined,
        pendingInteractiveRequests: getPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const model = getSessionModel();
      const providerId = getSessionProviderId();
      const mcpServers = getMcpServers();
      const agents = getAgents();
      const sessionId = getSessionId();
      const session = getSessionData(sessionId);
      const workspacePath = getBuiltinWorkspacePath();
      const enabledOfficialToolIds = workspacePath
        ? getEffectiveOfficialToolIdsForSession(
          workspacePath,
          session,
          getSessionEnabledOfficialToolIds(),
        )
        : [];
      return {
        success: true,
        runtime: 'builtin',
        model: model ?? null,
        mcpServerIds: mcpServers?.map(s => s.id) ?? null,
        agentNames: agents ? Object.keys(agents) : null,
        enabledOfficialToolIds,
        permissionMode: getSessionPermissionMode(),
        providerId,
        providerRoute: model && providerId ? createConcreteProviderRoute(providerId, model) : null,
        reasoningEffort: getSessionReasoningEffort() ?? 'default',
      };
    },

    getCurrentSessionContext() {
      const sessionId = getSessionId();
      return {
        runtime: 'builtin',
        sessionId: sessionId || null,
        workspacePath: getBuiltinWorkspacePath(),
        sessionMeta: sessionId ? getSessionData(sessionId) : null,
      };
    },

    getSessionOrigin(sessionId) {
      return getPersistedSessionOrigin(sessionId);
    },

    ensureRegisteredAgentSessionOrigin(sessionId, expected) {
      return ensureRegisteredAgentSessionOrigin(sessionId, expected);
    },

    getHeldImConfigSnapshot() {
      return {
        model: getSessionModel() ?? undefined,
        permissionMode: getSessionPermissionMode(),
        providerEnv: getSessionProviderEnv(),
        reasoningEffort: getSessionReasoningEffort(),
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      const snapshot = getBuiltinLiveSessionSnapshot(sessionId);
      if (!snapshot) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: 'builtin',
        ...snapshot,
      };
    },

    getCurrentTurnIdentity() {
      return getBuiltinCurrentTurnIdentity();
    },

    getSessionCompletionTerminal() {
      return getBuiltinSessionCompletionTerminal();
    },

    hasQueuedTurnOwnedBy(owner) {
      return hasBuiltinQueuedTurnByOwner(owner);
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      await setInteractionScenario(request.scenario);
      if (request.backgroundAgentPermissionMode) {
        setBackgroundAgentPermissionMode(request.backgroundAgentPermissionMode);
      }
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        { source: 'desktop' },
        undefined,
        undefined,
        request.analyticsSource,
        request.analyticsOrigin,
        {
          fromDesktopChatSend: true,
          sessionBirthOrigin: request.birthOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch: request.beforeDispatch,
          channelDelivery: DESKTOP_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 429 };
      }
      return {
        success: true,
        queued: result.queued,
        queueId: result.queueId,
        isInFlight: result.isInFlight,
        deliveryMode: result.deliveryMode,
        dispatchAcceptance: result.dispatchAcceptance,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.message,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        request.requestId,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch: request.beforeDispatch,
          channelDelivery: IM_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    cancelImRequest(requestId, reason) {
      return cancelBuiltinImRequest(requestId, reason as CancelReason | undefined);
    },

    async enqueueBackgroundMessage(request) {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    async enqueueInboxMessage(request) {
      const scenario = request.scenario ?? { type: 'desktop' as const };
      await setInteractionScenario(scenario);
      return enqueueUserMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        request.inboxMeta,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.allowLazySessionMaterialization === true,
          sessionBirthOrigin: request.birthOrigin,
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
    },

    async ensureGoalSessionConfig() {
      if (getMcpServers() !== null) return { success: true };
      const sessionId = getSessionId();
      const workspacePath = getBuiltinWorkspacePath();
      if (!workspacePath) {
        return { success: false, error: 'Goal session has no workspace path' };
      }
      const resolved = resolveWorkspaceConfig(
        workspacePath,
        sessionId ? getSessionData(sessionId) : null,
        { includeMcp: true },
      );
      await applyMcpOverrideAndAwaitReady(resolved.mcpServers);
      return { success: true };
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const deadline = Date.now() + request.timeoutMs;
      await setInteractionScenario(request.scenario);
      getAndClearLastAgentError();
      const queueId = request.queueId ?? randomUUID();
      let observedOutcome: TurnTerminalOutcome | undefined;
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, enqueued: false, error: routed.error, status: routed.status };
      }
      const beforeDispatch = request.beforeDispatch ?? acceptInjectedTurnDispatch;
      const enqueueAttempt = enqueueUserMessage(
        request.prompt,
        [],
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
          queueId,
          turnOwner: request.turnOwner,
          onTerminal: async (outcome) => {
            observedOutcome = outcome;
            try {
              await request.onTerminal?.(outcome);
            } finally {
              resolveTerminal(outcome);
            }
          },
          queueResponseModeOverride: 'turn',
          beforeDispatch,
          channelDelivery: injectedTurnChannelDelivery(request.assistantChannelDelivery),
        },
      );
      const enqueueResult = await waitForDeadline(
        enqueueAttempt,
        Math.max(0, deadline - Date.now()),
      );
      if (!enqueueResult) {
        await cancelQueueItem(queueId);
        return {
          success: false,
          enqueued: false,
          error: 'Builtin injected turn timed out before enqueue admission',
          status: 408,
        };
      }
      if (enqueueResult.error) {
        beforeDispatch.cancel?.();
        return { success: false, enqueued: false, error: enqueueResult.error, status: 503 };
      }
      const dispatchAcceptance = enqueueResult.dispatchAcceptance
        ? await waitForDeadline(enqueueResult.dispatchAcceptance, Math.max(0, deadline - Date.now()))
        : null;
      if (!dispatchAcceptance) {
        // Queue cancellation owns the exact guard rollback and does not return
        // until the domain owner acknowledges it.
        const cancelResult = await cancelQueueItem(queueId);
        const dispatchAccepted = getBuiltinDispatchedTurnIdentity()?.queueId === queueId;
        const terminationUnconfirmed = dispatchAccepted
          && cancelResult.status !== 'cancelled'
          && !await interruptCurrentResponse('timeout');
        return {
          success: false,
          enqueued: dispatchAccepted,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
          error: dispatchAccepted
            ? 'Builtin injected turn timed out during dispatch admission'
            : 'Builtin injected turn timed out before dispatch',
          status: 408,
        };
      }
      if (!dispatchAcceptance.accepted) {
        return {
          success: false,
          enqueued: false,
          error: dispatchAcceptance.error ?? 'Injected turn was rejected before dispatch',
          status: 409,
        };
      }
      const outcome = await waitForDeadline(terminal, Math.max(0, deadline - Date.now()));
      if (!outcome) {
        const cancelResult = await cancelQueueItem(queueId);
        if (observedOutcome) {
          const settledOutcome = await terminal;
          return {
            ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome: settledOutcome }),
            enqueued: true,
          };
        }
        let terminationUnconfirmed = false;
        if (cancelResult.status !== 'cancelled') {
          if (getBuiltinDispatchedTurnIdentity()?.queueId === queueId) {
            terminationUnconfirmed = !await interruptCurrentResponse('timeout');
          } else if (cancelResult.status !== 'not_found') {
            terminationUnconfirmed = true;
          }
        }
        return {
          ...decideBuiltinInjectedTurnResult({ idleCompleted: false }),
          enqueued: true,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
        };
      }
      return { ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome }), enqueued: true };
    },

    async stopTurn() {
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    async stopOwnedTurn(owner) {
      const canceled = await cancelQueuedTurnsByOwner(owner);
      const current = getBuiltinCurrentTurnIdentity();
      if (!current || current.owner.kind !== owner.kind || current.owner.id !== owner.id) {
        return { success: true, alreadyStopped: canceled === 0 };
      }
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    cancelQueuedMessage(queueId) {
      return cancelQueueItem(queueId);
    },

    forceQueuedMessage(queueId) {
      return forceExecuteQueueItem(queueId);
    },

    getQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForSessionIdle(timeoutMs, pollMs);
    },

    async updateModel(model, opts) {
      setSessionModel(model, opts);
      return { success: true };
    },

    async updatePermissionMode(mode) {
      setSessionPermissionMode(mode as PermissionMode);
      return { success: true };
    },

    async updateReasoningEffort(effort) {
      setSessionReasoningEffort(effort);
      return { success: true };
    },

    async updateOfficialToolIds(ids) {
      setSessionEnabledOfficialToolIds(ids);
      return { success: true };
    },

    async updateProxyConfig(proxySettings) {
      await setProxyConfig(proxySettings);
      return { success: true };
    },

    materializePendingDesktopSession(request) {
      return materializeBuiltinPendingDesktopSession({
        phase: request.phase,
        preparedSessionId: request.preparedSessionId,
        snapshotPatch: request.snapshotPatch,
        origin: request.origin,
      });
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
    },

    async updateRuntimeConfig() {
      return {
        success: false,
        error: 'Runtime config endpoint is only for external runtimes',
      };
    },

    async prewarm() {
      return { success: false, error: 'Pre-warm is only for external runtimes' };
    },

    restoreInitialSession() {
      return false;
    },

    async respondPermission(requestId, decision) {
      return handlePermissionResponse(requestId, decision);
    },

    async respondAskUserQuestion(requestId, answers) {
      return handleAskUserQuestionResponse(requestId, answers);
    },

    rewindToUserMessage(userMessageId) {
      return rewindSession(userMessageId);
    },

    async retryLastExternalUserMessage() {
      return {
        success: false,
        status: 400,
        error: 'external-retry is only for external runtimes; builtin uses /chat/rewind',
      };
    },

    forkAtAssistantMessage(messageId) {
      return forkSession(messageId);
    },

    async updateProviderEnv(providerEnv) {
      setSessionProviderEnv(providerEnv);
      return { success: true };
    },

    async updateMcpServers(servers) {
      setMcpServers(servers);
      return { success: true, servers: servers.map(s => s.id) };
    },

    configureWorkbenchToolset(toolset) {
      return configureBuiltinWorkbenchToolset(toolset);
    },

    async updateAgents(agents) {
      setAgents(agents as Record<string, AgentDefinition>);
      return { success: true };
    },

    async updateDesktopInteractionScenario(scenario) {
      await setInteractionScenario(scenario);
      return { success: true };
    },

    async switchToExistingSession(sessionId) {
      const success = await switchToSession(sessionId);
      return success
        ? { success: true, sessionId }
        : { success: false, error: 'Session not found.', status: 404 };
    },

    async resetForNewDesktopSession() {
      await resetSession();
      return { success: true, sessionId: getSessionId() };
    },

    async resetForNewImSession(_workspacePath, options) {
      const freeze = await freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
      if (!freeze.success) {
        return { success: false, error: freeze.error ?? 'Failed to freeze current IM session before reset' };
      }
      await resetSession();
      await materializeCurrentSessionMetadataForPublishedReset();
      return { success: true, sessionId: getSessionId() };
    },
  };
}
