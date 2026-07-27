import { randomUUID } from 'node:crypto';
import { broadcast } from '../sse';
import {
  freezeCurrentSessionMetadataForImDetach,
  getAgentState,
  getSessionId,
  materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession as materializeBuiltinPendingDesktopSession,
  resetSession,
} from '../agent-session';
import {
  cancelExternalQueueItem,
  cancelExternalQueuedTurnsByOwner,
  cancelExternalImRequest,
  clearExternalTurnBinding,
  awaitExternalSessionStarting,
  enqueueExternalSendForDesktop,
  enqueueExternalSendForIm,
  forceExecuteExternalQueueItem,
  getActiveRuntimeSource,
  getActiveRuntimeType,
  getCurrentBoundSessionId,
  getExternalLiveSessionSnapshot,
  getExternalSessionCompletionTerminal,
  getExternalPendingInteractiveRequests,
  getExternalQueueStatus,
  getExternalSessionId,
  getExternalSessionModel,
  getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort,
  getExternalSessionState,
  getExternalSessionWorkspacePath,
  getExternalSystemInitPayload,
  getExternalCurrentTurnIdentity,
  getLastExternalAssistantText,
  handleExternalOfficialToolIdsChange,
  handleExternalProxyConfigChange,
  hasExternalQueuedTurnByOwner,
  hasExternalRuntimeProcess,
  isExternalSessionActive,
  isExternalSessionStateRestoredFor,
  isExternalTurnCurrent,
  popLastUserMessageForRetry,
  prewarmExternalSession,
  respondExternalAskUserQuestion,
  respondExternalPermission,
  restoreExternalSessionState,
  sendExternalMessage,
  setExternalModel,
  setExternalPermissionMode,
  setExternalReasoningEffort,
  stopExternalSession,
  updateExternalRuntimeConfig,
  waitForExternalSessionIdle,
} from '../runtimes/external-session';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngine,
} from './types';
import { decideExternalInjectedTurnResult } from '../session-core/turn-result-policy';
import type { TurnTerminalOutcome } from '../session-core/turn-queue';
import { getEffectiveOfficialToolIdsForSession } from '../utils/admin-config';
import {
  ensureRegisteredAgentSessionOrigin,
  getPersistedSessionOrigin,
  getSessionData,
  updateSessionMetadata,
} from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import {
  getProcessProxyEnvKey,
  getProviderProxyScopeKey,
  setProcessProxyConfig,
} from '../proxy-state';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';

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

function observeExternalDispatch(
  dispatch: Promise<{ queued: boolean; error?: string; terminationUnconfirmed?: boolean }>,
  queueId?: string,
): Promise<{ accepted: boolean; error?: string }> {
  return dispatch
    .then((result) => {
      if (!result.queued) {
        if (queueId && !result.terminationUnconfirmed) {
          clearExternalTurnBinding(queueId);
        }
        if (result.error) {
          console.error(`[chat] external send failed: ${result.error}`);
          broadcast('chat:agent-error', { message: result.error });
        }
        return result.terminationUnconfirmed
          ? { accepted: true }
          : { accepted: false, ...(result.error ? { error: result.error } : {}) };
      }
      return { accepted: true };
    })
    .catch((error) => {
      if (queueId) clearExternalTurnBinding(queueId);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[chat] external send threw: ${message}`);
      broadcast('chat:agent-error', { message });
      return { accepted: false, error: message };
    });
}

async function stopExternalTarget(): Promise<boolean> {
  const stopped = await stopExternalSession({ preserveQueue: true });
  return stopped || (!hasExternalRuntimeProcess() && !isExternalSessionActive());
}

function getRuntimeSessionId(): string {
  return getExternalSessionId() || getCurrentBoundSessionId() || getSessionId();
}

function getRuntimeWorkspacePath(): string {
  return getExternalSessionWorkspacePath() || getAgentState().agentDir || '';
}

function getLatestExternalResult(): string {
  const runtimeSessionId = getRuntimeSessionId();
  let latestResult = getLastExternalAssistantText();
  if (!latestResult.trim()) {
    const data = runtimeSessionId ? getSessionData(runtimeSessionId) : null;
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function normalizeExternalRuntimeSource(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

type ExternalFreezeSnapshotPatch = NonNullable<
  Parameters<typeof freezeCurrentSessionMetadataForImDetach>[0]
>;

function buildExternalFreezeSnapshotPatch(): ExternalFreezeSnapshotPatch {
  const runtime = getActiveRuntimeType();
  const runtimeSource = getActiveRuntimeSource();
  const model = getExternalSessionModel() ?? undefined;
  const permissionMode = getExternalSessionPermissionMode() ?? undefined;
  const reasoningEffort = getExternalSessionReasoningEffort() ?? undefined;
  const patch: ExternalFreezeSnapshotPatch = {
    runtime,
  };
  if (runtime !== 'builtin' && runtimeSource) patch.runtimeSource = runtimeSource;
  if (model) patch.model = model;
  if (permissionMode) patch.permissionMode = permissionMode;
  if (reasoningEffort) patch.reasoningEffort = reasoningEffort;
  if (runtime === 'codex' && runtimeSource === 'managed-provider' && model) {
    patch.providerExecutionIdentity = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID as RuntimeBackedProviderIdentity['providerId'],
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model,
    };
  }
  return patch;
}

export function createExternalSessionEngine(): SessionEngine {
  return {
    kind: 'external',

    isBusy() {
      return isExternalSessionActive();
    },

    getRuntimeIdentity() {
      const boundSessionId = getCurrentBoundSessionId();
      return {
        kind: 'external',
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        sessionId: getRuntimeSessionId(),
        ...(boundSessionId ? { boundSessionId } : {}),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getExternalSessionState(),
        isBusy: isExternalSessionActive(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getRuntimeSessionId(),
        latestResult: getLatestExternalResult(),
      };
    },

    getStreamReplaySnapshot() {
      const systemInitPayload = getExternalSystemInitPayload();
      return {
        initState: { ...getAgentState(), sessionState: getExternalSessionState() },
        replayMessages: [],
        systemInitPayload: systemInitPayload ?? undefined,
        pendingInteractiveRequests: getExternalPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const runtimeSessionId = getRuntimeSessionId();
      const session = runtimeSessionId ? getSessionData(runtimeSessionId) : null;
      const workspacePath = getRuntimeWorkspacePath();
      return {
        success: true,
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        model: getExternalSessionModel(),
        mcpServerIds: null,
        agentNames: null,
        enabledOfficialToolIds: workspacePath
          ? getEffectiveOfficialToolIdsForSession(workspacePath, session)
          : [],
        permissionMode: getExternalSessionPermissionMode(),
        providerId: session?.providerExecutionIdentity?.providerId ?? null,
        providerRoute: null,
        providerExecutionIdentity: session?.providerExecutionIdentity ?? null,
        reasoningEffort: getExternalSessionReasoningEffort() ?? 'default',
      };
    },

    getCurrentSessionContext() {
      const sessionId = getRuntimeSessionId();
      return {
        runtime: getActiveRuntimeType(),
        sessionId: sessionId || null,
        workspacePath: getRuntimeWorkspacePath() || null,
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
        model: getExternalSessionModel() ?? undefined,
        permissionMode: getExternalSessionPermissionMode() ?? undefined,
        reasoningEffort: getExternalSessionReasoningEffort() ?? undefined,
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      const snapshot = getExternalLiveSessionSnapshot(sessionId);
      if (!snapshot) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: getActiveRuntimeType(),
        ...snapshot,
      };
    },

    getCurrentTurnIdentity() {
      return getExternalCurrentTurnIdentity();
    },

    getSessionCompletionTerminal() {
      return getExternalSessionCompletionTerminal();
    },

    hasQueuedTurnOwnedBy(owner) {
      return hasExternalQueuedTurnByOwner(owner);
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      const sent = enqueueExternalSendForDesktop(
        request.text,
        request.images,
        request.permissionMode,
        request.model,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          analyticsSource: request.analyticsSource,
          analyticsOrigin: request.analyticsOrigin,
          birthOrigin: request.birthOrigin,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          turnBoundaryOnly: request.turnBoundaryOnly,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
        },
      );
      const dispatchAcceptance = observeExternalDispatch(sent.dispatch, request.queueId);
      return {
        success: true,
        queued: sent.queued,
        queueId: sent.queueId,
        isInFlight: sent.isInFlight,
        deliveryMode: sent.deliveryMode,
        canCancel: sent.canCancel,
        canForceExecute: sent.canForceExecute,
        dispatchAcceptance,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      const sent = enqueueExternalSendForIm(
        request.message,
        request.images,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          requestId: request.requestId,
          metadataBirthPending: request.metadataBirthPending === true,
          analyticsOrigin: request.analyticsOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
        },
      );
      const dispatchAcceptance = observeExternalDispatch(
        sent.dispatch,
        sent.queueId ?? request.queueId,
      );

      // A queueId means the existing external turn-boundary queue has taken
      // ownership. Return admission immediately; the request-scoped terminal
      // and Goal lifecycle stay attached to the queued operation until drain.
      if (sent.queueId) {
        return {
          success: true,
          queued: true,
          dispatchAcceptance,
        };
      }

      // Idle sends retain the adapter's existing admission result instead of
      // being reported as queue-owned. This preserves fail-loud startup/config
      // errors where the runtime reports them, without reintroducing the busy
      // wait that blocked Lark's same-chat ingress queue.
      const accepted = await dispatchAcceptance;
      if (!accepted.accepted) {
        return {
          success: false,
          error: accepted.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: true };
    },

    cancelImRequest(requestId, reason) {
      return cancelExternalImRequest(requestId, reason);
    },

    async enqueueBackgroundMessage(request) {
      const result = await sendExternalMessage(
        request.text,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          analyticsOrigin: request.analyticsOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.beforeDispatch ? { beforeDispatch: request.beforeDispatch } : {}),
        },
      );
      if (!result.queued) {
        if (result.terminationUnconfirmed) {
          return { success: true, queued: true };
        }
        if (request.queueId) clearExternalTurnBinding(request.queueId);
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    enqueueInboxMessage(request) {
      return sendExternalMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario ?? { type: 'desktop' },
          inboxMeta: request.inboxMeta,
          metadataBirthPending: request.allowLazySessionMaterialization === true,
          analyticsOrigin: request.analyticsOrigin,
          birthOrigin: request.birthOrigin,
        },
      );
    },

    async ensureGoalSessionConfig() {
      return { success: true };
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const deadline = Date.now() + request.timeoutMs;
      const queueId = request.queueId ?? `xq-${randomUUID()}`;
      let observedOutcome: TurnTerminalOutcome | undefined;
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      const sendPromise = sendExternalMessage(
        request.prompt,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          metadataBirthPending: request.metadataBirthPending === true,
          analyticsOrigin: request.analyticsOrigin,
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
          beforeDispatch: request.beforeDispatch,
        },
      );
      const result = await waitForDeadline(sendPromise, deadline - Date.now());
      if (!result) {
        request.beforeDispatch?.cancel?.();
        void sendPromise.catch(() => undefined);
        const dispatchAccepted = isExternalTurnCurrent(queueId);
        const stopped = !dispatchAccepted || await stopExternalTarget();
        if (stopped) clearExternalTurnBinding(queueId);
        return {
          success: false,
          enqueued: dispatchAccepted,
          ...(!stopped ? { terminationUnconfirmed: true } : {}),
          error: !dispatchAccepted
            ? 'External runtime turn timed out before dispatch'
            : stopped
              ? 'External runtime turn timed out during dispatch'
              : 'External runtime turn timed out and its process did not stop',
          status: 408,
        };
      }
      if (!result.queued) {
        if (result.terminationUnconfirmed) {
          return {
            success: false,
            enqueued: true,
            terminationUnconfirmed: true,
            error: result.error ?? 'External runtime dispatch acknowledgement failed and its process did not stop',
            status: 503,
          };
        }
        clearExternalTurnBinding(queueId);
        return {
          success: false,
          enqueued: false,
          error: result.error ?? 'Failed to start external runtime turn',
          status: 503,
        };
      }
      const outcome = await waitForDeadline(terminal, deadline - Date.now());
      if (!outcome) {
        request.beforeDispatch?.cancel?.();
        if (observedOutcome) {
          const settledOutcome = await terminal;
          const decision = decideExternalInjectedTurnResult({
            idleCompleted: true,
            turnSucceeded: settledOutcome.status === 'complete',
            text: settledOutcome.status === 'complete' ? settledOutcome.text : undefined,
            error: settledOutcome.error,
          });
          return { ...decision, enqueued: true };
        }
        const stopped = await stopExternalTarget();
        if (stopped) clearExternalTurnBinding(queueId);
        return {
          ...decideExternalInjectedTurnResult({ idleCompleted: false }),
          enqueued: true,
          ...(!stopped ? { terminationUnconfirmed: true } : {}),
          ...(!stopped
            ? { error: 'External runtime turn timed out and its process did not stop' }
            : {}),
        };
      }
      const decision = decideExternalInjectedTurnResult({
        idleCompleted: true,
        turnSucceeded: outcome.status === 'complete',
        text: outcome.status === 'complete' ? outcome.text : undefined,
        error: outcome.error,
      });
      return { ...decision, enqueued: true };
    },

    async stopTurn(options) {
      if (!isExternalSessionActive()) {
        return { success: true, alreadyStopped: true };
      }
      const stopped = options?.preserveQueue
        ? await stopExternalTarget()
        : await stopExternalSession();
      return stopped
        ? { success: true, alreadyStopped: false }
        : { success: false, error: 'External runtime process did not stop' };
    },

    async stopOwnedTurn(owner) {
      const admitted = getExternalCurrentTurnIdentity();
      if (
        admitted
        && admitted.owner.kind === owner.kind
        && admitted.owner.id === owner.id
        && isExternalTurnCurrent(admitted.queueId)
      ) {
        const stopped = await stopExternalTarget();
        return stopped
          ? { success: true, alreadyStopped: false }
          : { success: false, error: 'External runtime process did not stop' };
      }
      const canceled = cancelExternalQueuedTurnsByOwner(owner);
      const promotionSettlement = await canceled.promotion?.settled;
      if (promotionSettlement?.status === 'termination-unconfirmed') {
        return { success: false, error: 'External runtime process did not stop' };
      }
      if (
        promotionSettlement?.status === 'not-dispatched'
        || promotionSettlement?.status === 'terminated'
      ) {
        return { success: true, alreadyStopped: false };
      }
      const current = getExternalCurrentTurnIdentity();
      if (!current || current.owner.kind !== owner.kind || current.owner.id !== owner.id) {
        return { success: true, alreadyStopped: canceled.count === 0 };
      }
      const stopped = await stopExternalTarget();
      return stopped
        ? { success: true, alreadyStopped: false }
        : { success: false, error: 'External runtime process did not stop' };
    },

    async cancelQueuedMessage(queueId) {
      const cancellation = cancelExternalQueueItem(queueId);
      if (!cancellation) return { status: 'not_found' as const };
      const settlement = await cancellation.promotion?.settled;
      if (
        settlement
        && (settlement.status === 'termination-unconfirmed' || settlement.status === 'dispatched')
        && isExternalTurnCurrent(queueId)
      ) {
        return { status: 'not_cancelled' as const };
      }
      return { status: 'cancelled' as const, cancelledText: cancellation.cancelledText };
    },

    forceQueuedMessage(queueId) {
      return forceExecuteExternalQueueItem(queueId);
    },

    getQueueStatus: getExternalQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForExternalSessionIdle(timeoutMs, pollMs);
    },

    updateModel(model, opts) {
      return setExternalModel(model, opts);
    },

    updatePermissionMode(mode) {
      return setExternalPermissionMode(mode);
    },

    updateReasoningEffort(effort) {
      return setExternalReasoningEffort(effort);
    },

    updateOfficialToolIds(ids) {
      return handleExternalOfficialToolIdsChange(ids);
    },

    async updateProxyConfig(proxySettings) {
      const oldManagedProviderKey = getProviderProxyScopeKey(CODEX_SUBSCRIPTION_PROVIDER_ID);
      const oldProcessEnvKey = getProcessProxyEnvKey();
      await setProcessProxyConfig(proxySettings);
      const newManagedProviderKey = getProviderProxyScopeKey(CODEX_SUBSCRIPTION_PROVIDER_ID);
      const newProcessEnvKey = getProcessProxyEnvKey();
      return handleExternalProxyConfigChange({
        oldManagedProviderKey,
        newManagedProviderKey,
        oldProcessEnvKey,
        newProcessEnvKey,
      });
    },

    async materializePendingDesktopSession(request) {
      const runtimeSessionIdBefore = getExternalSessionId() || undefined;
      if (request.phase === 'commit' || request.phase === undefined) {
        await awaitExternalSessionStarting();
        if (hasExternalRuntimeProcess()) {
          await stopExternalSession();
        }
      }
      const result = await materializeBuiltinPendingDesktopSession({
        phase: request.phase,
        preparedSessionId: request.preparedSessionId,
        snapshotPatch: request.snapshotPatch,
        origin: request.origin,
      });
      if ((request.phase === 'commit' || request.phase === undefined) && result.success && result.sessionId) {
        if (runtimeSessionIdBefore && runtimeSessionIdBefore !== result.sessionId) {
          const updated = await updateSessionMetadata(result.sessionId, { runtimeSessionId: runtimeSessionIdBefore });
          if (!updated) {
            console.warn(`[session-engine] external materialize: failed to preserve runtimeSessionId for ${result.sessionId}`);
          }
        }
        restoreExternalSessionState(result.sessionId, request.workspacePath, { type: 'desktop' });
      }
      return result;
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentSessionMetadataForImDetach(
        buildExternalFreezeSnapshotPatch(),
        {
          allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
        },
      );
    },

    updateRuntimeConfig(patch, options) {
      return updateExternalRuntimeConfig(patch, { source: options?.source ?? 'runtime-config' });
    },

    async prewarm(options) {
      return prewarmExternalSession({
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        scenario: { type: 'desktop' },
        model: options.model,
        permissionMode: options.permissionMode,
      });
    },

    restoreInitialSession(sessionId, workspacePath) {
      restoreExternalSessionState(sessionId, workspacePath, { type: 'desktop' });
      return true;
    },

    async respondPermission(requestId, decision, reason) {
      return respondExternalPermission(requestId, decision, reason);
    },

    respondAskUserQuestion(requestId, answers) {
      return respondExternalAskUserQuestion(requestId, answers);
    },

    async rewindToUserMessage() {
      return {
        success: false,
        status: 400,
        error: 'Rewind is not supported for external runtimes (CC/Codex)',
      };
    },

    retryLastExternalUserMessage(userMessageId) {
      return popLastUserMessageForRetry(userMessageId);
    },

    async forkAtAssistantMessage() {
      return {
        success: false,
        status: 400,
        error: 'Fork is not supported for external runtimes (CC/Codex)',
      };
    },

    async updateProviderEnv() {
      return { success: true, skipped: 'external-runtime' };
    },

    async updateMcpServers(servers) {
      return { success: true, servers: servers.map(s => s.id), skipped: 'external-runtime' };
    },

    async updateAgents() {
      return { success: true, skipped: 'external-runtime' };
    },

    async updateDesktopInteractionScenario() {
      return { success: true, skipped: 'external-runtime' };
    },

    async switchToExistingSession(sessionId, workspacePath, getSessionMetadata) {
      if (getCurrentBoundSessionId() === sessionId && isExternalSessionStateRestoredFor(sessionId)) {
        return { success: true, sessionId };
      }

      await awaitExternalSessionStarting();
      if (getCurrentBoundSessionId() === sessionId && isExternalSessionStateRestoredFor(sessionId)) {
        return { success: true, sessionId };
      }

      const meta = getSessionMetadata(sessionId);
      if (!meta) {
        return { success: false, error: 'Session not found.', status: 404 };
      }
      const activeRuntime = getActiveRuntimeType();
      if (meta.runtime && meta.runtime !== activeRuntime) {
        return {
          success: false,
          error: `Session runtime mismatch: persisted=${meta.runtime}, current=${activeRuntime}`,
          status: 409,
        };
      }
      if (meta.runtime) {
        const activeRuntimeSource = normalizeExternalRuntimeSource(activeRuntime, getActiveRuntimeSource());
        const persistedRuntimeSource = normalizeExternalRuntimeSource(meta.runtime, meta.runtimeSource);
        if (persistedRuntimeSource !== activeRuntimeSource) {
          return {
            success: false,
            error: `Session runtime source mismatch: persisted=${persistedRuntimeSource ?? 'none'}, current=${activeRuntimeSource ?? 'none'}`,
            status: 409,
          };
        }
      }

      if (hasExternalRuntimeProcess()) {
        await stopExternalSession();
      }
      restoreExternalSessionState(sessionId, workspacePath, { type: 'desktop' });
      return { success: true, sessionId };
    },

    async resetForNewDesktopSession(workspacePath) {
      await awaitExternalSessionStarting();
      if (hasExternalRuntimeProcess()) {
        await stopExternalSession();
      }
      await resetSession();
      const newSessionId = getSessionId();
      if (newSessionId) {
        restoreExternalSessionState(newSessionId, workspacePath, { type: 'desktop' });
      }
      return { success: true, sessionId: newSessionId };
    },

    async resetForNewImSession(workspacePath, options) {
      await awaitExternalSessionStarting();
      const freeze = await freezeCurrentSessionMetadataForImDetach(
        buildExternalFreezeSnapshotPatch(),
        {
          allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
        },
      );
      if (!freeze.success) {
        return { success: false, error: freeze.error ?? 'Failed to freeze current IM session before reset' };
      }
      if (hasExternalRuntimeProcess()) {
        await stopExternalSession();
      }
      await resetSession();
      await materializeCurrentSessionMetadataForPublishedReset();
      const newSessionId = getSessionId();
      if (newSessionId) {
        restoreExternalSessionState(newSessionId, workspacePath, { type: 'desktop' });
      }
      return { success: true, sessionId: newSessionId };
    },
  };
}
