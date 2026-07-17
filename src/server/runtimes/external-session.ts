// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { broadcast as broadcastSse, broadcastLive, flushPendingLiveEvents } from '../sse';
import { participatesInLiveRestore } from '../../shared/liveRevision';
import { killWithEscalation } from './utils/kill-with-escalation';
import { InactivityWatchdog } from '../utils/inactivity-watchdog';
import { buildSystemPromptAppend } from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import {
  getChannelInteractionDisallowedTools,
  shouldDisallowAskUserQuestion,
  shouldUseNonBypassForNativeAskUserQuestion,
  supportsAskUserQuestionNativeCard,
} from '../host-interaction';
import type {
  ExternalRuntimeConfigPatch,
  ExternalRuntimeConfigSnapshot,
  RuntimeConfigApplyMode,
  RuntimeConfigCapabilities,
  RuntimeProcess,
  UnifiedEvent,
  ImagePayload,
  ResolvedImagePayload,
} from './types';
import { StaleRuntimeSessionError } from './types';
import { awaitInFlightSaves, rebuildAttachmentRegistryFromBlocks, trackInFlightSave } from './tool-attachments';
import { messageAttachmentsFromImagePayloads, resolveImagePayloads } from './image-payload';
import { maybeSpill } from '../utils/large-value-store';
import type { AskUserQuestionInput, AskUserQuestion } from '../../shared/types/askUserQuestion';
import { withQuestionTextAnswerKeys } from '../../shared/types/askUserQuestion';
import {
  getExternalRuntime,
  getCurrentRuntimeSource,
  getCurrentRuntimeType,
  isExternalRuntime,
} from './factory';
import { resolveCodexWorkspaceInstructions } from './workspace-instructions';
import { RUNTIME_DISPLAY_NAMES, type RuntimeEnvPolicy, type RuntimeSource, type RuntimeType } from '../../shared/types/runtime';
import { deriveSessionTitle } from '../../shared/sessionTitle';
import { createLiveUserMessageReplay } from '../../shared/chatMessageReplay';
import {
  withSessionCompletionTerminal,
  type SessionCompletionTerminal,
} from '../../shared/sessionCompletion';
import { isPendingSessionId } from '../../shared/constants';
import {
  resolveChatQueueResponseMode,
  type TurnOwner,
  type TurnTerminalObserver,
} from '../session-core/turn-queue';
import {
  shouldRecordAdmissionActivity,
  shouldRecordTerminalActivity,
  type SessionActivityTurnFacts,
} from '../session-core/session-activity-policy';
import {
  commitPreparedSessionForFirstUserTurn,
  saveSessionMetadata,
  updateSessionMetadata,
  getSessionMetadata,
  getSessionData,
} from '../SessionStore';
import { firePostTurnTitleHook } from '../turn-hooks';
import {
  createMaterializedSessionMetadata,
  type SessionMaterializationScenario,
} from '../utils/session-materialization';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { findAgentByWorkspacePath, getEffectiveOfficialToolIdsForSession, isCliToolRegistryEnabled, loadConfig as loadAdminConfig, resolveWorkspaceConfig } from '../utils/admin-config';
import type { AgentConfig } from '../../shared/types/agent';
import type { MessageUsage, SessionMessage, TurnAnalyticsSource } from '../types/session';
import type { SystemInitInfo } from '../../shared/types/system';
import { trackServer } from '../analytics';
import {
  addUsageTotals,
  diffUsageTotals,
  getPrimaryModel,
  normalizeUsage,
  restoreRuntimeUsageTotals,
} from './usage-utils';
import {
  EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  externalRuntimeWatchdogTimeoutMs,
  estimatedContextTokensFromMessages,
} from './external-watchdog-policy';
import { observedContextTokens } from '../utils/context-occupancy';
import { computeContextUsage } from '../../shared/contextUsage';
import { lookupModelContextLength } from '../utils/model-capabilities';
import {
  filterRuntimeConfigPatchForSnapshot,
  getDefaultExternalConfigCapabilities,
  runtimeConfigPatchKeys as externalConfigPatchKeys,
  shouldApplySnapshotConfigUpdate,
  shouldDeferExternalConfigOperation,
} from '../session-core/runtime-config-policy';

export {
  filterRuntimeConfigPatchForSnapshot,
  getDefaultExternalConfigCapabilities,
  isExternalModelConfigNoop,
  mergeRuntimeConfigPatches as mergeExternalRuntimeConfigPatches,
  shouldDeferExternalConfigOperation,
} from '../session-core/runtime-config-policy';
import { elapsedMs, emitPerfTrace, nowMs } from '../utils/perf-trace';
import { queryRuntimeModelsSingleFlight } from './runtime-model-singleflight';
import {
  applyDesiredExternalRuntimeConfigPatch,
  coerceExternalRuntimeModel,
  coerceExternalRuntimePermissionMode,
  coerceExternalRuntimeReasoningEffort,
  getExternalRuntimeDesiredModel,
  getExternalRuntimeDesiredPermissionMode,
  getExternalRuntimeDesiredReasoningEffort,
  getExternalRuntimeDisplayModel,
  getExternalRuntimeDisplayPermissionMode,
  getExternalRuntimeDisplayReasoningEffort,
  getExternalRuntimeLiveReportedModel,
  isCurrentExternalSessionSnapshotted,
  isExternalRuntimeConfigPatchNoopAgainstDesired,
  normalizeExternalRuntimeConfigPatch,
  resetExternalRuntimeConfigState,
  restoreExternalRuntimeConfigFromMetadata,
  setExternalRuntimeLiveReportedModel,
} from './external-session/runtime-config';
import {
  canDrainExternalOperations,
  cancelExternalQueuedMessage,
  chainExternalDesktopSend,
  clearExternalQueueWithCancellation as clearExternalQueueOwnerWithCancellation,
  cancelExternalQueuedMessagesByOwner,
  consumeLeadingExternalConfigOps,
  enqueueExternalConfigOperation,
  enqueueExternalMessageOperation,
  getExternalOperationGeneration,
  getExternalOperationQueueLength,
  getExternalQueueStatusSnapshot,
  hasExternalQueuedMessageByOwner,
  hasExternalQueuedOperations,
  hasQueuedExternalConfigOperation,
  isCurrentExternalOperationGeneration,
  isExternalOperationDrainInFlight,
  isExternalQueueGenerationStaleError,
  moveExternalQueuedMessageToFront,
  nextExternalQueueId,
  nextExternalUserMessageId,
  releaseExternalDrainReservation,
  reserveExternalOperationForDrain,
  settleExternalMessageOperation,
  setExternalOperationDrainInFlight,
  shouldQueueExternalDesktopSend,
  unshiftExternalOperation,
} from './external-session/operation-queue';
import {
  awaitExternalLifecycleStarting,
  beginExternalLifecycleStart,
  bindExternalSessionContext as bindExternalLifecycleSessionContext,
  buildExternalSystemInitPayload,
  clearExternalActiveRuntimeProcess,
  clearExternalPrewarmingSession,
  clearExternalRuntimeSessionId,
  getCurrentExternalBoundSessionId,
  getExternalActivePair,
  getExternalActiveOfficialToolIds,
  getExternalActiveProcess,
  getExternalActiveRuntime,
  getExternalLifecycleAnalyticsOrigin,
  getExternalLifecycleAnalyticsSource,
  getExternalLifecycleScenario,
  getExternalLifecycleSessionId,
  getExternalLifecycleState,
  getExternalLifecycleWorkspacePath,
  getExternalRuntimeSessionId,
  getExternalSystemInitPayloadSnapshot,
  getExternalUserRequestedStop,
  getExternalLiveRevision,
  isExternalLifecycleRunning,
  isExternalLifecycleStarting,
  markExternalUserRequestedStop,
  nextExternalLiveRevision,
  resetExternalUserRequestedStop,
  resetExternalLifecycleState,
  setExternalActiveProcess,
  setExternalActiveRuntime,
  setExternalLifecycleAnalyticsOrigin,
  setExternalLifecycleAnalyticsSource,
  setExternalLifecycleRunning,
  setExternalLifecycleState,
  setExternalPrewarmingSession,
  setExternalRuntimeSessionId,
  setExternalSystemInitPayload,
  updateExternalLifecycleStartingSessionId,
} from './external-session/lifecycle';
import { originAnalyticsFields, originFromTurnAttribution } from '../../shared/session-origin';
import type { SessionOrigin } from '../../shared/session-origin';
import type { OfficialToolId } from '../../shared/official-tools';
import {
  buildImCancelledPayload,
  buildImCompletePayload,
  buildImErrorPayload,
} from '../utils/im-terminal-payload';
import {
  beginExternalTurnPromotion,
  cancelExternalTurnPromotion,
  cancelExternalTurnPromotionByOwner,
  cancelExternalTurnPromotionByQueueId,
  clearExternalTurnBinding,
  clearExternalTurnStartTime,
  clearExternalTurnActivityFacts,
  didExternalLastTurnSucceed,
  finishExternalTurnPromotion,
  bindExternalTurn,
  getExternalTurnTerminalGeneration,
  getExternalCurrentTurnContextUsage,
  getExternalCurrentTurnEstimatedInputTokens,
  getExternalCurrentTurnUsage,
  getExternalTurnStartTime,
  getExternalTurnActivityFacts,
  isExternalTurnCompleted,
  isExternalTurnFinalizationInFlight,
  isExternalTurnGenerationCurrent,
  isExternalTurnCurrent,
  isExternalTurnPromotionCurrent,
  isExternalTurnPromotionInFlight,
  markExternalSessionComplete,
  markExternalTurnComplete,
  markExternalTurnStarted,
  notifyExternalTurnOutcome,
  notifyExternalTurnStopped,
  recordExternalSessionCompletionTerminal,
  resetExternalTurnAccumulators,
  resetExternalTurnLifecycleState,
  setExternalCurrentTurnContextUsage,
  setExternalCurrentTurnEstimatedInputTokens,
  setExternalCurrentTurnUsage,
  setExternalLastTurnSucceeded,
  setExternalTurnCompleted,
  setExternalTurnActivityFacts,
  trackExternalTurnFinalization,
  updateExternalCurrentTurnUsageModel,
  waitForExternalTurnTerminalObserver,
  waitExternalTurnFinalization,
  type ExternalTurnPromotionToken,
} from './external-session/turn-lifecycle';
export {
  clearExternalTurnBinding,
  getExternalCurrentTurnIdentity,
  getExternalSessionCompletionTerminal,
  getExternalTurnTerminalGeneration,
  isExternalTurnCurrent,
  waitExternalTurnFinalization,
} from './external-session/turn-lifecycle';
import {
  activateExternalPendingThinking,
  appendExternalAssistantText,
  appendExternalSubagentTraceDelta as appendExternalSubagentTraceDeltaToContent,
  appendExternalPendingText,
  appendExternalPendingThinkingText,
  appendExternalToolResultDeltaToContent,
  appendExternalToolInputDelta,
  applyExternalReplayedToolResultToContent,
  applyExternalSubagentAttachmentUpdate,
  applyExternalSubagentToolResult as applyExternalSubagentToolResultToContent,
  applyExternalToolAttachmentUpdate,
  applyExternalToolResultToContent,
  buildCurrentExternalAssistantSnapshotContent,
  captureExternalTurnContentSnapshot,
  completeExternalSubagentTrace as completeExternalSubagentTraceContent,
  finalizeExternalSubagentToolInput as finalizeExternalSubagentToolInputContent,
  finalizeExternalToolUseInput,
  flushExternalPendingTextBlock,
  flushExternalPendingThinkingBlock,
  flushExternalPendingToolInputsForTurn,
  getExternalAssistantText,
  getExternalChildToolParent,
  getExternalContentBlockCount,
  getExternalContentBlockText,
  getExternalSubagentAttachmentParent,
  getExternalTurnContentSnapshotPersistedContent,
  getExternalTurnContentSnapshotText,
  getExternalTurnContentSnapshotToolCount,
  isExternalTurnContentSnapshotCurrent,
  isExternalPendingThinkingActive,
  replaceExternalToolUseInput,
  resetExternalContentState,
  resetExternalPendingThinking,
  startExternalSubagentToolUse,
  startExternalSubagentTraceTool,
  startExternalToolUseInput,
} from './external-session/content-blocks';
import {
  appendAndPersistExternalAssistantTurn,
  clearExternalSessionMessages,
  forEachExternalSessionMessage,
  getLastExternalAssistantTextFromTranscript,
  getExternalSessionMessageCount,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  getLastPersistedRuntimeUsageTotals,
  persistExternalUserMessageAppend,
  pushExternalSessionMessage,
  resetExternalTranscriptState,
  setExternalSessionMessages,
  setLastPersistedRuntimeUsageTotals,
  truncateExternalTranscriptForRetry,
} from './external-session/transcript-persistence';
import {
  addExternalTurnAttachmentHint,
  clearExternalInboxMetaOnRejection,
  clearExternalPermissionSuggestions,
  consumeExternalPermissionSuggestions,
  deleteExternalAskUserQuestion,
  deleteExternalInteractiveRequest,
  deliverExternalWatchError,
  finalizeExternalActiveRequest,
  fireExternalImCallback,
  getExternalActiveRequestId,
  getExternalAskUserQuestion,
  getExternalInteractiveRequest,
  getExternalInteractiveRequestEntries,
  getExternalInteractiveRequestsSnapshot,
  getExternalPermissionSuggestions,
  getExternalTurnInboxMeta,
  hasExternalAskUserQuestion,
  hasExternalInteractiveRequests,
  resetExternalInteractiveState,
  resetExternalTurnAttachmentHints,
  setExternalActiveRequestId,
  setExternalAskUserQuestion,
  setExternalInteractiveRequest,
  setExternalPermissionSuggestions,
  setExternalTurnInboxMeta,
  snapshotExternalTurnReplyState,
} from './external-session/interactive';
import type {
  ExternalConfigApplyResult,
  ExternalConfigSource,
  ExternalConfigUpdateResult,
  ExternalMetadataTurnPath,
  ExternalPendingInteractiveRequest,
  ExternalSendContext,
  ExternalSendResult,
  ExternalSessionState,
  ExternalTurnUsage,
  PendingExternalSessionBirth,
} from './external-session/types';

export type {
  ExternalAssistantSnapshotState,
  ExternalConfigApplyResult,
  ExternalConfigSource,
  ExternalConfigUpdateResult,
  ExternalMetadataTurnPath,
  ExternalPendingInteractiveRequest,
  ExternalQueuedConfigOperation,
  ExternalQueuedMessageOperation,
  ExternalSendContext,
  ExternalSendResult,
  ExternalSessionState,
  ExternalTurnOperation,
  ExternalTurnUsage,
  PendingExternalSessionBirth,
  PersistContentBlock,
  PersistSubagentCall,
} from './external-session/types';

type ExternalTurnBindingInput = {
  queueId: string;
  owner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
};

export { buildExternalAssistantSnapshotContent } from './external-session/content-blocks';
export {
  classifyExternalTurnFailureCleanup,
  isSuccessfulExternalTurnCompletion,
} from './external-session/turn-lifecycle';

// ─── Module state ───
// #307: set true while stopExternalSession() is tearing down the process (user
// pressed Stop / config-change restart / session takeover). When the killed
// subprocess then emits its terminal session_complete (subtype='error' from the
// non-zero exit, or an error_during_execution result), the session_complete
// handler consults this flag to SUPPRESS the chat:agent-error / chat:message-error
// banner — an abort we initiated is not a real failure. Mirrors the builtin path's
// isAbortedTerminalReason()/isInterruptingResponse gate. terminal_reason alone is
// insufficient here: CC `-p` has no mid-turn interrupt, so Stop = SIGTERM kill,
// whose synthetic session_complete carries no terminal_reason. Consumed (reset to
// false) the first time the handler reads it, with a backstop reset at session start.
function externalRuntimeProviderName(runtime: RuntimeType): string {
  return RUNTIME_DISPLAY_NAMES[runtime];
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;  // Hung process detection (suspension-aware interval)

let externalTurnSeq = 0;
let currentTurnTraceId = '';
let currentTurnTraceSessionId = '';
let currentTurnAnalyticsSource: TurnAnalyticsSource | null = null;
let currentTurnAnalyticsOrigin: SessionOrigin | null = null;
let currentTurnTraceRequestId: string | undefined;
let currentTurnTraceRuntime = '';
let currentTurnTraceStartMs = 0;
let firstDeltaTraceEmitted = false;
const activeToolTraceStarts = new Map<string, number>();
let activeExternalEnvPolicy: RuntimeEnvPolicy | undefined;
let pendingExternalProxyRestart = false;
let pendingExternalProxyRestartOriginalKey: string | null = null;
let pendingExternalOfficialToolsRestart = false;
let externalProcessConfigInvalidationInFlight: Promise<void> | null = null;

function clearPendingExternalProcessConfigRestarts(): void {
  pendingExternalProxyRestart = false;
  pendingExternalProxyRestartOriginalKey = null;
  pendingExternalOfficialToolsRestart = false;
}

function pendingExternalProcessConfigRestartReasons(): string[] {
  return [
    ...(pendingExternalProxyRestart ? ['proxy'] : []),
    ...(pendingExternalOfficialToolsRestart ? ['official-tools'] : []),
  ];
}

function applyPendingExternalProcessConfigInvalidation(): Promise<void> {
  if (externalProcessConfigInvalidationInFlight) {
    return externalProcessConfigInvalidationInFlight;
  }

  const reasons = pendingExternalProcessConfigRestartReasons();
  if (reasons.length === 0) return Promise.resolve();
  const proxyOriginalKey = pendingExternalProxyRestartOriginalKey;

  const operation = (async () => {
    // Clear before stopping so the process-exit notification cannot re-enter
    // this boundary. The in-flight promise remains observable to every send;
    // if termination cannot be confirmed, restore the latch before rejecting.
    clearPendingExternalProcessConfigRestarts();
    if (!hasExternalRuntimeProcess()) {
      console.log(`[external-session] External runtime config invalidation already satisfied by process exit: ${reasons.join(',')}`);
      return;
    }

    console.log(`[external-session] Applying external runtime config restart at idle boundary: ${reasons.join(',')}`);
    try {
      const stopped = await stopExternalSession({ reason: 'config-restart', preserveQueue: true });
      if (!stopped && hasExternalRuntimeProcess()) {
        throw new Error(`External runtime process did not stop for config change: ${reasons.join(',')}`);
      }
    } catch (error) {
      if (!hasExternalRuntimeProcess()) return;
      if (reasons.includes('proxy')) {
        pendingExternalProxyRestart = true;
        pendingExternalProxyRestartOriginalKey ??= proxyOriginalKey;
      }
      if (reasons.includes('official-tools')) {
        pendingExternalOfficialToolsRestart = true;
      }
      throw error;
    }
  })();

  externalProcessConfigInvalidationInFlight = operation;
  void operation.then(
    () => {
      if (externalProcessConfigInvalidationInFlight === operation) {
        externalProcessConfigInvalidationInFlight = null;
      }
    },
    () => {
      if (externalProcessConfigInvalidationInFlight === operation) {
        externalProcessConfigInvalidationInFlight = null;
      }
    },
  );
  return operation;
}

function scheduleExternalQueueDrainAfterTurnBoundary(): void {
  if (pendingExternalProcessConfigRestartReasons().length === 0) {
    setTimeout(() => drainExternalQueueAfterTurn(), 0);
    clearExternalTurnTrace();
    return;
  }

  const finalization = applyPendingExternalProcessConfigInvalidation()
    .then(() => {
      setTimeout(() => drainExternalQueueAfterTurn(), 0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[external-session] Deferred runtime config restart failed: ${message}`);
      broadcast('chat:agent-error', { message });
      clearExternalQueueWithCancellation();
    })
    .finally(() => {
      clearExternalTurnTrace();
    });
  trackExternalTurnFinalization(finalization);
}

// Set by sendExternalMessage when it pre-broadcasts the user message for instant display.
// Consumed by _doStartExternalSession / Case 3 to reuse the message (skip duplicate broadcast).
let earlyBroadcastedUserMsg: SessionMessage | null = null;
interface PendingRealtimeSteeredUserMessage {
  queueId: string;
  sessionId: string;
  userMsg: SessionMessage;
  text: string;
  activityFacts: SessionActivityTurnFacts;
}

const pendingRealtimeSteeredUserMessages: PendingRealtimeSteeredUserMessage[] = [];

function sessionMessageAttachmentsFromImages(
  sessionId: string | undefined,
  images: ImagePayload[] | undefined,
): SessionMessage['attachments'] | undefined {
  if (!sessionId || !images || images.length === 0) return undefined;
  try {
    const attachments = messageAttachmentsFromImagePayloads(sessionId, images).map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      path: att.relativePath,
    }));
    return attachments.length > 0 ? attachments : undefined;
  } catch (err) {
    console.error('[external-session] failed to prepare user image attachments:', err);
    return undefined;
  }
}

/**
 * Clear all queued desktop messages and broadcast queue:cancelled per item (so the renderer
 * removes the pills). MUST be called wherever the session is torn down or switched — a stale
 * queued item would otherwise (a) orphan its pill forever and (b) be drained into the NEW
 * session at its next turn end, injecting old text + old context (cross-session contamination).
 * Mirrors the builtin drainQueueWithCancellation (agent-session.ts).
 */
function clearExternalQueueWithCancellation(): void {
  for (const queueId of clearExternalQueueOwnerWithCancellation()) {
    broadcast('queue:cancelled', { queueId });
  }
  clearPendingRealtimeSteeredUserMessagesWithCancellation();
}

function clearPendingRealtimeSteeredUserMessagesWithCancellation(): void {
  while (pendingRealtimeSteeredUserMessages.length > 0) {
    const pending = pendingRealtimeSteeredUserMessages.shift();
    if (pending) broadcast('queue:cancelled', { queueId: pending.queueId });
  }
}

function registerPendingRealtimeSteeredUserMessage(entry: PendingRealtimeSteeredUserMessage): void {
  pendingRealtimeSteeredUserMessages.push(entry);
}

function forgetPendingRealtimeSteeredUserMessage(userMessageId: string): void {
  const index = pendingRealtimeSteeredUserMessages.findIndex((entry) => entry.userMsg.id === userMessageId);
  if (index !== -1) pendingRealtimeSteeredUserMessages.splice(index, 1);
}

function takePendingRealtimeSteeredUserMessage(clientUserMessageId?: string): PendingRealtimeSteeredUserMessage | undefined {
  if (clientUserMessageId) {
    const index = pendingRealtimeSteeredUserMessages.findIndex((entry) => entry.userMsg.id === clientUserMessageId);
    if (index !== -1) {
      const [entry] = pendingRealtimeSteeredUserMessages.splice(index, 1);
      return entry;
    }
    return undefined;
  }
  return pendingRealtimeSteeredUserMessages.shift();
}

function surfaceRealtimeSteeredUserMessage(entry: PendingRealtimeSteeredUserMessage): void {
  setExternalTurnActivityFacts(entry.activityFacts);
  const admissionActivityAt = shouldRecordAdmissionActivity(entry.activityFacts)
    ? new Date().toISOString()
    : undefined;
  pushExternalSessionMessage(entry.userMsg);
  void persistExternalUserMessageAppend(
    entry.sessionId,
    entry.userMsg.id,
    '[external-session] Failed to persist accepted realtime steered user message',
    admissionActivityAt,
  ).catch((err) => {
    console.error('[external-session] failed to persist accepted realtime steered user message:', err);
  });
  broadcast('queue:started', {
    queueId: entry.queueId,
    sessionId: entry.sessionId,
    midTurnBreak: true,
    userMessage: {
      id: entry.userMsg.id,
      role: entry.userMsg.role,
      content: entry.text,
      timestamp: entry.userMsg.timestamp,
      attachments: entry.userMsg.attachments,
    },
  });
}

function surfaceAcceptedRealtimeSteeredUserMessage(clientUserMessageId?: string): void {
  const entry = takePendingRealtimeSteeredUserMessage(clientUserMessageId);
  if (!entry) return;
  surfaceRealtimeSteeredUserMessage(entry);
}

function surfaceAllPendingRealtimeSteeredUserMessages(): void {
  while (pendingRealtimeSteeredUserMessages.length > 0) {
    const entry = pendingRealtimeSteeredUserMessages.shift();
    if (entry) surfaceRealtimeSteeredUserMessage(entry);
  }
}

function captureExternalRuntimeConfigSnapshot(
  model: string | undefined,
  permissionMode: string | undefined,
  context: ExternalSendContext,
): ExternalRuntimeConfigSnapshot {
  const runtime = getCurrentRuntimeType();
  return {
    model: coerceExternalRuntimeModel(model ?? context.model ?? getExternalRuntimeDesiredModel(), runtime, 'message-capture', context.sessionId),
    permissionMode: coerceExternalRuntimePermissionMode(
      permissionMode ?? context.permissionMode ?? getExternalRuntimeDesiredPermissionMode(),
      runtime,
      'message-capture',
      context.sessionId,
    ),
    reasoningEffort: coerceExternalRuntimeReasoningEffort(
      resolveTurnReasoningEffort(context),
      runtime,
      'message-capture',
      context.sessionId,
    ) ?? '',
  };
}

function applySnapshotToExternalSendContext(
  context: ExternalSendContext,
  snapshot: ExternalRuntimeConfigSnapshot,
): ExternalSendContext {
  return {
    ...context,
    model: snapshot.model,
    permissionMode: snapshot.permissionMode,
    reasoningEffort: snapshot.reasoningEffort === '' ? 'default' : snapshot.reasoningEffort,
  };
}
// Pre-warm can create a runtime thread before MyAgents has a durable
// sessions.json entry. Keep that narrow "birth" state explicit so the first
// real user turn may materialize metadata, while missing metadata for ordinary
// resume/delete races still fails closed.
let pendingExternalSessionBirth: PendingExternalSessionBirth | null = null;
function setExternalSessionState(state: ExternalSessionState): void {
  setExternalLifecycleState(state);
  broadcast('chat:status', { sessionState: state });
}

function bindExternalSessionContext(
  input: Parameters<typeof bindExternalLifecycleSessionContext>[0],
): void {
  if (getExternalLifecycleSessionId() !== input.sessionId) {
    flushPendingLiveEvents();
  }
  bindExternalLifecycleSessionContext(input);
}

function broadcast(event: string, data: unknown): void {
  const payloadSessionId = data && typeof data === 'object'
    && typeof (data as { sessionId?: unknown }).sessionId === 'string'
    ? (data as { sessionId: string }).sessionId
    : '';
  const sessionId = payloadSessionId || getExternalLifecycleSessionId();
  if (sessionId && participatesInLiveRestore(event, data)) {
    broadcastLive(event, data, {
      sessionId,
      nextRevision: nextExternalLiveRevision,
    });
    return;
  }
  broadcastSse(event, data);
}

type ExternalActivePair = NonNullable<ReturnType<typeof getExternalActivePair>>;
type SteerCapableActivePair = {
  runtime: ExternalActivePair['runtime'] & {
    steerMessage: NonNullable<ExternalActivePair['runtime']['steerMessage']>;
  };
  process: ExternalActivePair['process'];
};

function getExternalActiveSteerPair(): SteerCapableActivePair | null {
  const active = getExternalActivePair();
  if (!active || active.process.exited || !active.runtime.steerMessage) return null;
  if (getExternalLifecycleState() !== 'running') return null;
  if (isExternalTurnCompleted() || getExternalTurnStartTime() === 0) return null;
  return active as SteerCapableActivePair;
}

/** Reset all module-level state for a clean session transition.
 *  Prevents cross-session contamination when Sidecar is reused (Handover scenario 4). */
function resetModuleState(): void {
  resetExternalLifecycleState();
  resetExternalTurnLifecycleState();
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  currentWatchdogTimeoutMs = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;
  externalWatchdog.setTimeoutMs(EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS);
  resetExternalRuntimeConfigState();
  resetExternalTranscriptState();
  resetExternalContentState();
  pendingExternalToolInputTransports.clear();
  activeExternalEnvPolicy = undefined;
  clearPendingExternalProcessConfigRestarts();
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  clearExternalPermissionSuggestions();
  drainPendingInteractiveRequestsAsExpired('reset');
  resetExternalInteractiveState();
  earlyBroadcastedUserMsg = null;
  pendingExternalSessionBirth = null;
  // Issue #289-followup — a queued desktop message MUST NOT survive a session switch/reset:
  // it would otherwise drain into the new session with the old session's text + context.
  clearExternalQueueWithCancellation();
}

export function __resetExternalSessionForTests(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error('__resetExternalSessionForTests is only available in tests');
  }
  resetModuleState();
}

/**
 * PRD #131 (Codex review #4) — drain pending interactive requests by
 * broadcasting `*:expired` so the frontend modal clears before we wipe the
 * map. Mirrors the builtin handlers' lifecycle (handleAskUserQuestion's
 * timer/onAbort paths in agent-session.ts). Without this, an external
 * runtime stop / crash / watchdog kill leaves the AskUserQuestion card
 * visible; the user's late submit then routes to the builtin handler as
 * "Unknown request".
 *
 * `reason` is included in the SSE payload so the frontend (and a future
 * automated test) can distinguish stop-driven vs error-driven expiry.
 * Currently the frontend just clears the modal regardless, but keeping
 * the channel typed lets us add user-visible messaging later without a
 * second round-trip.
 */
function broadcastExternalInteractiveExpired(
  requestId: string,
  entry: ExternalPendingInteractiveRequest | undefined,
  reason: 'stop' | 'error' | 'reset' | 'resolved',
): void {
  if (!entry) return;
  const sessionId = entry.data.sessionId || getCurrentBoundSessionId() || undefined;
  if (entry.type === 'ask-user-question:request') {
    try {
      broadcast('ask-user-question:expired', { requestId, ...(sessionId ? { sessionId } : {}), reason });
    } catch (e) {
      console.warn(`[external-session] broadcast ask-user-question:expired for ${requestId} failed:`, e);
    }
    if (supportsAskUserQuestionNativeCard(getExternalLifecycleScenario())) {
      fireExternalImCallback('ask-user-question-expired', JSON.stringify({ requestId, reason }));
    }
    return;
  }
  if (entry.type === 'permission:request') {
    try {
      broadcast('permission:expired', { requestId, ...(sessionId ? { sessionId } : {}), reason });
    } catch (e) {
      console.warn(`[external-session] broadcast permission:expired for ${requestId} failed:`, e);
    }
  }
}

function drainPendingInteractiveRequestsAsExpired(reason: 'stop' | 'error' | 'reset'): void {
  // `pendingExternalInteractiveRequests` only ever holds
  // `ask-user-question:request` (structured wizard) or `permission:request`
  // (generic allow/deny card). External runtimes (CC / Codex / Gemini) don't
  // expose ExitPlanMode / EnterPlanMode tools today, so those `*:expired`
  // channels stay builtin-only. Filtering by entry.type keeps the broadcast
  // honest if a future runtime starts using those interactive types.
  for (const [requestId, entry] of getExternalInteractiveRequestEntries()) {
    deleteExternalAskUserQuestion(requestId);
    deleteExternalInteractiveRequest(requestId);
    consumeExternalPermissionSuggestions(requestId);
    broadcastExternalInteractiveExpired(requestId, entry, reason);
  }
}

// ─── Sub-agent (Codex collab-agent) tool routing (PRD 0.2.27) ───
// Mirrors the builtin SDK's chat:subagent-* path. A tool stamped with
// event.subAgent nests under its parent spawn card instead of the flat
// transcript. Reuses the existing subagent SSE events + frontend nesting +
// TaskTool render — no new SSE events, no new components.

/**
 * Nest a sub-agent tool under its parent spawn card. The routing is LATCHED here:
 * childToolToParent is set on start, and all later input/stop/result events route
 * purely off that map — so a tool can never flat-then-nest flip mid-stream.
 */
function handleSubagentToolUseStart(
  parentToolUseId: string,
  event: Extract<UnifiedEvent, { kind: 'tool_use_start' }>,
): void {
  startExternalSubagentToolUse({
    parentToolUseId,
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolInput: event.input,
  });
  broadcast('chat:subagent-tool-use', {
    parentToolUseId,
    tool: {
      id: event.toolUseId,
      name: event.toolName,
      input: event.input ?? {},
      // streamIndex is informational for nested calls; the frontend keys by id.
      streamIndex: 0,
    },
  });
  recordRuntimeActivity();
}

function finalizeSubagentToolInput(parentToolUseId: string, toolUseId: string): void {
  finalizeExternalSubagentToolInputContent(parentToolUseId, toolUseId);
}

function applySubagentToolResult(
  parentToolUseId: string,
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
): void {
  applyExternalSubagentToolResultToContent({
    parentToolUseId,
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // External runtimes deliver tool results as a single event (no streaming),
  // so go straight to *-complete (the frontend's -start/-complete both update
  // the same call; -complete also clears the loading spinner).
  broadcast('chat:subagent-tool-result-complete', {
    parentToolUseId,
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  recordRuntimeActivity();
}

type SubagentTraceName = 'AgentMessage' | 'Thinking';

function subagentTraceToolUseId(parentToolUseId: string, traceId: string, name: SubagentTraceName): string {
  return `${name}::${traceId}::${parentToolUseId}`;
}

function ensureSubagentTraceCall(
  parentToolUseId: string,
  toolUseId: string,
  name: SubagentTraceName,
): void {
  if (!startExternalSubagentTraceTool({ parentToolUseId, toolUseId, toolName: name })) return;
  broadcast('chat:subagent-tool-use', {
    parentToolUseId,
    tool: {
      id: toolUseId,
      name,
      input: {},
      streamIndex: 0,
    },
  });
  recordRuntimeActivity();
}

function appendSubagentTraceDelta(
  event: Extract<UnifiedEvent, { kind: 'text_delta' | 'thinking_delta' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(parentToolUseId, event.traceId, name);
  ensureSubagentTraceCall(parentToolUseId, toolUseId, name);
  appendExternalSubagentTraceDeltaToContent({ parentToolUseId, toolUseId, delta: event.text });

  broadcast('chat:subagent-tool-result-delta', {
    parentToolUseId,
    toolUseId,
    delta: event.text,
  });
  recordRuntimeActivity();
  return true;
}

function startSubagentTrace(
  event: Extract<UnifiedEvent, { kind: 'thinking_start' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(parentToolUseId, event.traceId, name);
  ensureSubagentTraceCall(parentToolUseId, toolUseId, name);
  return true;
}

function completeSubagentTrace(
  event: Extract<UnifiedEvent, { kind: 'text_stop' | 'thinking_stop' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(parentToolUseId, event.traceId, name);
  const completed = completeExternalSubagentTraceContent({ parentToolUseId, toolUseId });
  if (!completed) return true; // scoped stop with no emitted content; swallow it

  applySubagentToolResult(completed.latchedParentToolUseId, {
    kind: 'tool_result',
    toolUseId,
    content: completed.content,
  });
  return true;
}

/** Flush accumulated text into a text content block */
function flushPendingText(): void {
  flushExternalPendingTextBlock();
}

export function shouldCreateMissingExternalMetadataForRealUserTurn(
  turnPath: ExternalMetadataTurnPath,
  hasPendingBirth: boolean,
): boolean {
  void turnPath;
  return hasPendingBirth;
}

export function shouldTrackPendingExternalSessionBirth(params: {
  hasInitialMessage: boolean;
  hasResumeSessionId: boolean;
  hasMetadata: boolean;
}): boolean {
  return !params.hasInitialMessage && !params.hasResumeSessionId && !params.hasMetadata;
}

function materializationScenarioFromInteraction(
  scenario: InteractionScenario,
): SessionMaterializationScenario {
  return scenario.type;
}

function pendingBirthForSession(sessionId: string): PendingExternalSessionBirth | null {
  return pendingExternalSessionBirth?.sessionId === sessionId ? pendingExternalSessionBirth : null;
}

function clearPendingExternalSessionBirth(sessionId: string): void {
  if (pendingExternalSessionBirth?.sessionId === sessionId) {
    pendingExternalSessionBirth = null;
  }
}

async function persistUserMessageBeforeRuntimeDispatch(params: {
  sessionId: string;
  workspacePath: string;
  messageText: string;
  origin: string;
  scenario: InteractionScenario;
  turnPath: ExternalMetadataTurnPath;
  metadataBirthPending?: boolean;
  birthOrigin?: SessionOrigin;
  userMsg: SessionMessage;
  failureContext: string;
  lastActiveAt?: string;
}): Promise<void> {
  const metadataResult = await ensureExternalSessionMetadataForRealUserTurn({
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    messageText: params.messageText,
    origin: params.origin,
    scenario: params.scenario,
    turnPath: params.turnPath,
    metadataBirthPending: params.metadataBirthPending,
    birthOrigin: params.birthOrigin,
  });
  const { lastMessagePreview } = await persistExternalUserMessageAppend(
    params.sessionId,
    params.userMsg.id,
    params.failureContext,
    metadataResult.preparedExisting ? undefined : params.lastActiveAt,
    metadataResult.preparedExisting ? 'skip' : 'update',
  );

  if (metadataResult.preparedExisting) {
    try {
      const updated = await commitPreparedSessionForFirstUserTurn(params.sessionId, {
        messageText: params.messageText,
        runtimeSessionId: metadataResult.runtimeSessionId,
        origin: params.birthOrigin,
        lastActiveAt: params.lastActiveAt,
        lastMessagePreview,
      });
      if (!updated) {
        console.warn(`[external-session] prepared metadata commit skipped for ${params.sessionId}: metadata disappeared after user message persist`);
      }
    } catch (err) {
      console.warn('[external-session] prepared metadata commit after user message persist failed:', err);
    }
  }
}

/** Register a new session in SessionStore on the first real user message.
 *  Idempotent: no-op if metadata already exists. Used by the initial-message
 *  path and the post-pre-warm active-process path so snapshot policy cannot
 *  drift. Missing metadata is only materialized for true fresh starts or for
 *  an explicit pre-warm birth state; ordinary resume/delete races fail closed.
 */
async function ensureExternalSessionMetadataForRealUserTurn(params: {
  sessionId: string;
  workspacePath: string;
  messageText: string;
  origin: string;
  scenario: InteractionScenario;
  turnPath: ExternalMetadataTurnPath;
  metadataBirthPending?: boolean;
  birthOrigin?: SessionOrigin;
}): Promise<{ preparedExisting: boolean; runtimeSessionId?: string }> {
  const { sessionId, workspacePath, messageText, origin, scenario, turnPath } = params;
  if (!sessionId) {
    throw new Error(`[external-session] Cannot persist ${origin}: missing sessionId`);
  }

  const pendingBirth = pendingBirthForSession(sessionId);
  const existing = getSessionMetadata(sessionId);
  if (existing) {
    const runtimeSessionId = pendingBirth?.runtimeSessionId;
    if (existing.materializationState === 'prepared') {
      clearPendingExternalSessionBirth(sessionId);
      return { preparedExisting: true, runtimeSessionId };
    } else if (runtimeSessionId && existing.runtimeSessionId !== runtimeSessionId) {
      try {
        const updated = await updateSessionMetadata(sessionId, { runtimeSessionId });
        if (!updated) {
          console.warn(`[external-session] runtimeSessionId patch skipped for ${sessionId}: metadata disappeared during ${origin}`);
        }
      } catch (err) {
        console.warn('[external-session] runtimeSessionId patch failed:', err);
      }
    }
    clearPendingExternalSessionBirth(sessionId);
    return { preparedExisting: false };
  }

  const hasOwnedFreshStartAuthority =
    turnPath === 'fresh-start'
    && scenario.type !== 'im'
    && scenario.type !== 'agent-channel'
    && scenario.type !== 'registeredAgent';
  const hasMaterializationBirth =
    Boolean(pendingBirth)
    || params.metadataBirthPending === true
    || hasOwnedFreshStartAuthority;
  if (!shouldCreateMissingExternalMetadataForRealUserTurn(turnPath, hasMaterializationBirth)) {
    throw new Error(
      `[external-session] Refusing to create missing metadata for ${sessionId} during ${origin}; `
      + 'no pending pre-warm birth exists, so this may be a deleted or invalid resume session.',
    );
  }

  if (pendingBirth && (pendingBirth.workspacePath !== workspacePath || pendingBirth.scenario.type !== scenario.type)) {
    console.warn(
      `[external-session] pending birth context changed for ${sessionId}: `
      + `birth=${pendingBirth.workspacePath}/${pendingBirth.scenario.type}, `
      + `turn=${workspacePath}/${scenario.type}`,
    );
  }

  const agent = findAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
  const title = deriveSessionTitle(messageText.trim(), 40) || 'New Chat';
  const meta = createMaterializedSessionMetadata({
    agentDir: workspacePath,
    sessionId,
    scenario: materializationScenarioFromInteraction(scenario),
    agent,
    runtimeOverride: getCurrentRuntimeType(),
    runtimeSourceOverride: getCurrentRuntimeSource(),
    managedCodexProviderReady: isManagedCodexProviderReady(loadAdminConfig()),
    fallbackRuntime: getCurrentRuntimeType(),
    title,
    origin: params.birthOrigin,
  });
  if (pendingBirth?.runtimeSessionId) {
    meta.runtimeSessionId = pendingBirth.runtimeSessionId;
  }

  await saveSessionMetadata(meta);
  if (!getSessionMetadata(sessionId)) {
    throw new Error(`[external-session] Failed to materialize session metadata for ${sessionId} during ${origin}`);
  }
  clearPendingExternalSessionBirth(sessionId);
  console.log(`[external-session] session ${sessionId} persisted to SessionStore (${origin})`);
  return { preparedExisting: false };
}

function flushPendingThinking(forceComplete: boolean): void {
  flushExternalPendingThinkingBlock(forceComplete);
}

/** Flush any incomplete blocks (thinking/tool) at turn boundary — handles interrupts */
function flushAllPending(): void {
  flushPendingText();
  flushPendingThinking(true);
  for (const interrupted of flushExternalPendingToolInputsForTurn()) {
    applySubagentToolResult(interrupted.parentToolUseId, {
      kind: 'tool_result',
      toolUseId: interrupted.toolUseId,
      content: interrupted.content,
      isError: interrupted.isError,
    });
  }
}

// ─── Watchdog timer (10 min inactivity → kill hung process) ───
//
// Suspension-aware: an interval drives the check and credits process-suspension
// gaps (macOS sleep / App Nap) so they are not counted as inactivity — same
// fix as the builtin watchdog. See utils/inactivity-watchdog.ts. (Previously a
// reset-on-activity setTimeout, which fired on resume because its deadline
// elapsed in wall-clock during sleep — a turn the runtime never actually hung.)
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT = `<myagents-managed-codex-interaction-limits>
This session is running on Managed Codex. The structured user-input tools are intentionally disabled here.

Do not call request_user_input, AskUserQuestion, or MCP elicitation/form tools to ask the IM user a question.
If you need clarification or a choice from the user, ask it as normal chat text and wait for the user's next message.
</myagents-managed-codex-interaction-limits>`;

function isManagedCodexStructuredUserInputDisabled(
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): boolean {
  return runtimeType === 'codex' && runtimeSource === 'managed-provider';
}

function isChannelScenario(scenario: InteractionScenario): boolean {
  return scenario.type === 'im' || scenario.type === 'agent-channel';
}

function getRuntimeAwareChannelInteractionDisallowedTools(
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
  scenario: InteractionScenario,
): string[] {
  const tools = getChannelInteractionDisallowedTools(scenario);
  if (
    isChannelScenario(scenario)
    && isManagedCodexStructuredUserInputDisabled(runtimeType, runtimeSource)
    && !tools.includes('AskUserQuestion')
  ) {
    return ['AskUserQuestion', ...tools];
  }
  return tools;
}

function appendManagedCodexInteractionLimitPrompt(
  prompt: string,
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
  scenario: InteractionScenario,
): string {
  if (!isChannelScenario(scenario)) return prompt;
  if (!isManagedCodexStructuredUserInputDisabled(runtimeType, runtimeSource)) return prompt;
  return prompt
    ? `${prompt}\n\n${MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT}`
    : MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT;
}

const externalWatchdog = new InactivityWatchdog({
  timeoutMs: EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  intervalMs: WATCHDOG_INTERVAL_MS,
});
let currentWatchdogTimeoutMs = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;

function usageForWatchdogBudget(): MessageUsage | null {
  const estimatedInputTokens = getExternalCurrentTurnEstimatedInputTokens();
  const usage = getExternalCurrentTurnUsage() ?? getLastPersistedRuntimeUsageTotals();
  if (estimatedInputTokens <= 0) return usage;

  const observed = observedContextTokens(usage);
  if (observed >= estimatedInputTokens) return usage;

  return {
    ...(usage ?? { outputTokens: 0 }),
    inputTokens: Math.max(usage?.inputTokens ?? 0, estimatedInputTokens),
    outputTokens: usage?.outputTokens ?? 0,
    model: (usage?.model ?? getExternalRuntimeLiveReportedModel()) || getExternalRuntimeDesiredModel() || undefined,
  };
}

function refreshWatchdogTimeout(): void {
  const runtimeType = getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  const usageForBudget = usageForWatchdogBudget();
  const nextTimeoutMs = externalRuntimeWatchdogTimeoutMs(runtimeType, usageForBudget);
  if (nextTimeoutMs === currentWatchdogTimeoutMs) return;

  currentWatchdogTimeoutMs = nextTimeoutMs;
  externalWatchdog.setTimeoutMs(nextTimeoutMs);

  const minutes = Math.round(nextTimeoutMs / 60_000);
  const tokens = observedContextTokens(usageForBudget);
  console.log(`[external-session] Watchdog: timeout adjusted to ${minutes} minutes for ${runtimeType} contextTokens=${tokens}`);
}

/** Record runtime activity (and start the interval on the first call of a turn). */
function resetWatchdog(): void {
  refreshWatchdogTimeout();
  externalWatchdog.markActivity();
  if (watchdogTimer) return; // already armed — markActivity above is the reset
  externalWatchdog.reset();
  watchdogTimer = setInterval(() => {
    const { fire, suspendedMs } = externalWatchdog.evaluateTick();
    if (suspendedMs > 0) {
      console.log(`[external-session] Watchdog: credited ${Math.round(suspendedMs / 1000)}s process suspension (sleep/App Nap) — not counted as inactivity`);
    }
    // Paused on a human: pendingExternalInteractiveRequests holds the open
    // permission card / AskUserQuestion. The user's think time is not runtime
    // inactivity — re-baseline the idle clock so the post-answer budget is fresh
    // and skip the kill. evaluateTick already advanced lastTickAt, so the wait
    // ending produces no spurious suspension credit. (High-2, cross-review.)
    if (hasExternalInteractiveRequests()) {
      externalWatchdog.markActivity();
      return;
    }
    if (!fire) return;
    clearWatchdog();
    const minutes = Math.round(currentWatchdogTimeoutMs / 60_000);
    console.error(`[external-session] Watchdog: no runtime activity for ${minutes} minutes of active time, killing process`);
    broadcast('chat:agent-error', { message: `External runtime timed out (no activity for ${minutes} minutes)` });
    broadcast('chat:message-error', 'External runtime timed out');
    fireExternalImCallback('error', buildImErrorPayload('External runtime timed out'));
    void stopExternalSession();
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
}

function clearWatchdog(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function recordRuntimeActivity(): void {
  if (getExternalTurnStartTime() === 0 || isExternalTurnCompleted()) return;
  resetWatchdog();
}

function beginExternalTurnTrace(
  source: string,
  sessionId = getExternalLifecycleSessionId(),
  requestId: string | undefined = getExternalActiveRequestId() || undefined,
  runtime = getCurrentRuntimeType(),
): void {
  externalTurnSeq += 1;
  currentTurnTraceId = `external-${Date.now()}-${externalTurnSeq}`;
  currentTurnTraceSessionId = sessionId;
  currentTurnTraceRequestId = requestId;
  currentTurnTraceRuntime = runtime;
  currentTurnTraceStartMs = nowMs();
  firstDeltaTraceEmitted = false;
  activeToolTraceStarts.clear();
  emitPerfTrace({
    trace: 'turn',
    phase: 'turn_start',
    sessionId: currentTurnTraceSessionId || getExternalLifecycleSessionId() || undefined,
    requestId: currentTurnTraceRequestId,
    turnId: currentTurnTraceId,
    runtime: currentTurnTraceRuntime,
    status: 'ok',
    detail: { source },
  });
}

function emitExternalTurnTrace(
  phase: string,
  options: {
    status?: 'ok' | 'error' | 'timeout' | 'skipped';
    durationMs?: number;
    sizeBytes?: number;
    count?: number;
    detail?: Record<string, string | number | boolean | null | undefined>;
  } = {},
): void {
  if (!currentTurnTraceId) return;
  emitPerfTrace({
    trace: 'turn',
    phase,
    durationMs: options.durationMs ?? (currentTurnTraceStartMs ? elapsedMs(currentTurnTraceStartMs) : undefined),
    sessionId: currentTurnTraceSessionId || getExternalLifecycleSessionId() || undefined,
    requestId: currentTurnTraceRequestId,
    turnId: currentTurnTraceId,
    runtime: currentTurnTraceRuntime || getCurrentRuntimeType(),
    status: options.status ?? 'ok',
    sizeBytes: options.sizeBytes,
    count: options.count,
    detail: options.detail,
  });
}

function emitExternalFirstDeltaTrace(delta: string): void {
  if (firstDeltaTraceEmitted || !currentTurnTraceId) return;
  firstDeltaTraceEmitted = true;
  emitExternalTurnTrace('first_delta', { sizeBytes: Buffer.byteLength(delta, 'utf8') });
}

function emitExternalToolStartTrace(toolUseId: string, toolName: string, isSubAgent = false): void {
  if (!currentTurnTraceId) return;
  activeToolTraceStarts.set(toolUseId, nowMs());
  emitExternalTurnTrace('tool_start', {
    detail: { toolUseId, toolName, subAgent: isSubAgent },
  });
}

function emitExternalToolEndTrace(toolUseId: string, isError?: boolean): void {
  if (!currentTurnTraceId) return;
  const started = activeToolTraceStarts.get(toolUseId);
  activeToolTraceStarts.delete(toolUseId);
  emitExternalTurnTrace('tool_end', {
    status: isError ? 'error' : 'ok',
    durationMs: started ? elapsedMs(started) : undefined,
    detail: { toolUseId },
  });
}

function clearExternalTurnTrace(): void {
  currentTurnTraceId = '';
  currentTurnTraceSessionId = '';
  currentTurnTraceRequestId = undefined;
  currentTurnTraceRuntime = '';
  currentTurnTraceStartMs = 0;
  firstDeltaTraceEmitted = false;
  activeToolTraceStarts.clear();
}

// ─── Turn outcome tracking (stale text protection for cron/heartbeat) ───
function seedTurnWatchdogEstimate(extraText = ''): void {
  const runtimeType = getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  setExternalCurrentTurnEstimatedInputTokens(runtimeType === 'codex'
    ? estimatedContextTokensFromMessages(getExternalSessionMessagesSnapshot(), extraText)
    : 0);
}

/** Reset all per-turn accumulators */
function resetTurnAccumulators(): void {
  resetExternalContentState();
  resetExternalTurnAccumulators();
}

function rollbackReservedExternalTurnAfterDrainFailure(): void {
  resetTurnAccumulators();
  clearExternalTurnStartTime();
  setExternalTurnCompleted(true);
  earlyBroadcastedUserMsg = null;
  setExternalSessionState('idle');
  if (hasExternalQueuedOperations()) {
    setTimeout(drainExternalQueueAfterTurn, 0);
  }
}

function consumeExternalTurnUsage(): MessageUsage | undefined {
  const currentTurnUsage = getExternalCurrentTurnUsage();
  const fallbackModel = currentTurnUsage?.model
    || getExternalRuntimeLiveReportedModel()
    || getExternalRuntimeDesiredModel()
    || getPrimaryModel(currentTurnUsage?.modelUsage);

  if (!currentTurnUsage) {
    if (!fallbackModel) return undefined;
    return {
      inputTokens: 0,
      outputTokens: 0,
      model: fallbackModel,
    };
  }

  const normalizedCurrent = normalizeUsage({
    ...currentTurnUsage,
    model: fallbackModel,
  });
  if (!normalizedCurrent) return undefined;

  if (currentTurnUsage.semantics === 'running_total') {
    const delta = normalizeUsage(diffUsageTotals(getLastPersistedRuntimeUsageTotals(), normalizedCurrent));
    setLastPersistedRuntimeUsageTotals(normalizedCurrent);
    return delta ?? {
      inputTokens: 0,
      outputTokens: 0,
      model: fallbackModel,
    };
  }

  setLastPersistedRuntimeUsageTotals(addUsageTotals(getLastPersistedRuntimeUsageTotals(), normalizedCurrent));
  return normalizedCurrent;
}

function currentExternalTurnTextSnapshot(): string {
  const blockText = getExternalContentBlockText();
  return blockText || getExternalAssistantText().trim();
}

function consumeExternalTurnMetrics(): {
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
} {
  const turnStartTime = getExternalTurnStartTime();
  const durationMs = turnStartTime ? Math.max(0, Date.now() - turnStartTime) : undefined;
  const usage = consumeExternalTurnUsage();
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(usage ? {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    } : {}),
  };
}

function recordExternalCompletionTerminal(
  status: 'complete' | 'stopped' | 'error',
): SessionCompletionTerminal | null {
  return recordExternalSessionCompletionTerminal({
    sessionId: getExternalLifecycleSessionId(),
    workspacePath: getExternalLifecycleWorkspacePath(),
    status,
  });
}

function notifyFailedExternalTurn(
  terminalGeneration: number,
  text: string,
  error: string,
): SessionCompletionTerminal | null {
  const completionTerminal = recordExternalCompletionTerminal('error');
  const activityFacts = getExternalTurnActivityFacts();
  const finalization = persistExternalTerminalActivity(activityFacts, text)
    .finally(() => clearExternalTurnActivityFacts(activityFacts));
  trackExternalTurnFinalization(finalization);
  notifyExternalTurnOutcome(terminalGeneration, {
    success: false,
    text,
    error,
    ...consumeExternalTurnMetrics(),
  }, finalization);
  return completionTerminal;
}

function finalizeAcceptedExternalFailure(message: string): void {
  const terminalGenerationBefore = getExternalTurnTerminalGeneration();
  markExternalTurnComplete(
    { kind: 'turn_complete', status: 'failed', error: message },
    { intentionalStopInProgress: false },
  );
  const terminalGeneration = getExternalTurnTerminalGeneration();
  if (terminalGeneration > terminalGenerationBefore) {
    notifyFailedExternalTurn(
      terminalGeneration,
      currentExternalTurnTextSnapshot(),
      message,
    );
  }
}

function persistExternalTerminalActivity(
  activityFacts: SessionActivityTurnFacts | null,
  text: string,
): Promise<void> {
  const sessionId = getExternalLifecycleSessionId();
  const lastActiveAt = activityFacts && shouldRecordTerminalActivity(activityFacts, { text })
    ? new Date().toISOString()
    : undefined;
  if (!sessionId || !lastActiveAt) return Promise.resolve();
  return updateSessionMetadata(sessionId, { lastActiveAt })
    .then(() => undefined)
    .catch((error) => {
      console.error('[external-session] failed to persist terminal activity:', error);
    });
}

function finalizeStoppedExternalTurn(
  text: string,
  metrics: ReturnType<typeof consumeExternalTurnMetrics>,
  publishCompletion = true,
): SessionCompletionTerminal | null {
  const completionTerminal = publishCompletion
    ? recordExternalCompletionTerminal('stopped')
    : null;
  const activityFacts = getExternalTurnActivityFacts();
  const finalization = persistExternalTerminalActivity(activityFacts, text)
    .finally(() => clearExternalTurnActivityFacts(activityFacts));
  trackExternalTurnFinalization(finalization);
  notifyExternalTurnStopped(text, metrics, finalization);
  return completionTerminal;
}

// Mirrors agent-session.ts `isValidAskUserQuestionInput`. Malformed input would crash
// AskUserQuestionPrompt (which maps over `options` etc.); the fallback path on failure
// is the generic permission card, so the user at least sees a denial affordance.
function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;
  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      typeof question.multiSelect === 'boolean' &&
      (question.id === undefined || typeof question.id === 'string') &&
      (question.required === undefined || typeof question.required === 'boolean') &&
      (question.isSecret === undefined || typeof question.isSecret === 'boolean')
    );
  });
}

/**
 * Set the runtime's session ID (CC: from hook/system.init; Codex: from thread/start).
 * Used for session resume in multi-turn conversations.
 */
export function setRuntimeSessionId(id: string): void {
  setExternalRuntimeSessionId(id);
  console.log(`[external-session] Runtime session ID set: ${id}`);
}

/**
 * Restore module-level state after Sidecar restart (session resume).
 * Called from index.ts when an external runtime session is reopened from history.
 * Sets lastRuntimeSessionId so sendExternalMessage uses resume instead of new session.
 */
export function restoreExternalSessionState(
  sessionId: string,
  workspacePath: string,
  scenario: InteractionScenario,
): void {
  // If switching to a different session, reset all accumulated state to prevent contamination
  if (sessionId !== getExternalLifecycleSessionId()) {
    resetModuleState();
  }
  bindExternalSessionContext({ sessionId, workspacePath, scenario, analyticsSource: scenario.type });

  // Restore the runtime's own session ID from persisted metadata.
  // Four cases:
  // 0. Cross-runtime mismatch (session created by different external runtime) → fresh start
  // 1. Codex session with runtimeSessionId persisted → use it (threadId)
  // 2. CC session (no runtimeSessionId, but has runtime + messages) → sessionId (CC uses our ID)
  // 3. Brand new session (no messages, or no metadata) → empty string → sendExternalMessage hits Case 1 (fresh start)
  const meta = getSessionMetadata(sessionId);
  const data = getSessionData(sessionId);
  const hasExistingMessages = !!(data?.messages?.length);
  const currentRuntimeType = getCurrentRuntimeType();

  // Cross-runtime guard: session created by a different runtime (e.g., Codex session in CC Sidecar).
  // The other runtime's session ID / threadId is meaningless here — must start fresh.
  const isCrossRuntime = meta?.runtime && meta.runtime !== currentRuntimeType;

  if (isCrossRuntime) {
    clearExternalRuntimeSessionId(); // Different runtime — cannot resume
    console.log(`[external-session] Cross-runtime session: meta.runtime=${meta!.runtime}, current=${currentRuntimeType}, will start fresh`);
  } else if (meta?.runtimeSessionId) {
    setExternalRuntimeSessionId(meta.runtimeSessionId);
  } else if (meta?.runtime && meta.runtime !== 'builtin' && hasExistingMessages) {
    setExternalRuntimeSessionId(sessionId); // CC: session ID === runtime session ID
  } else {
    clearExternalRuntimeSessionId(); // New session: nothing to resume
  }

  // Load existing messages for correct incremental save (or clear stale in-memory state)
  setExternalSessionMessages(sessionId, hasExistingMessages ? data!.messages : []);

  // PRD 0.2.15 Review F2 — repopulate the external-path attachment registry
  // from persisted ContentBlock[] so /api/attachment/tool/... can still resolve
  // Codex savedPath attachments after a sidecar restart / Handover. Without
  // this rebuild, history replay shows broken images for any savedPath that
  // didn't land in our trusted root.
  if (hasExistingMessages) {
    forEachExternalSessionMessage((msg) => {
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') return;
      try {
        const blocks = JSON.parse(msg.content);
        if (Array.isArray(blocks)) {
          rebuildAttachmentRegistryFromBlocks(sessionId, blocks, msg.id);
        }
      } catch {
        // Plain-text assistant messages have no blocks — fine.
      }
    });
  }
  const sessionMessagesSnapshot = getExternalSessionMessagesSnapshot();
  setLastPersistedRuntimeUsageTotals(restoreRuntimeUsageTotals(
    currentRuntimeType,
    sessionMessagesSnapshot,
    meta?.runtimeUsageTotals,
  ));
  const restoredRuntimeReportedModel = meta?.runtimeUsageTotals?.model
    || sessionMessagesSnapshot
      .slice()
      .reverse()
      .find((msg) => msg.role === 'assistant' && msg.usage?.model)?.usage?.model
    || '';
  // Rehydrate model/permission from session snapshot so a Tab that joins an
  // idle external Sidecar via /sessions/switch can adopt the session's last
  // known config via /api/session/config. Without this, a fresh switch into
  // an existing session (sidecar process not yet running) leaves
  // runtime-config desired state empty and adoption silently no-ops.
  restoreExternalRuntimeConfigFromMetadata({
    model: meta?.model,
    permissionMode: meta?.permissionMode,
    reasoningEffort: meta?.reasoningEffort,
    runtimeReportedModel: restoredRuntimeReportedModel,
    runtime: currentRuntimeType,
    sessionId,
  });
  console.log(`[external-session] Restored state for session ${sessionId}, runtimeSessionId=${getExternalRuntimeSessionId()} (${getExternalSessionMessageCount()} messages), permissionMode=${getExternalRuntimeDesiredPermissionMode() || '(default)'}, model=${getExternalRuntimeDesiredModel() || '(default)'}, effort=${getExternalRuntimeDesiredReasoningEffort() || '(default)'}`);
}

// Pattern B — `setExternalImStreamCallback` removed. The /api/im/chat handler
// in index.ts subscribes to `imEventBus` directly and filters by requestId.
// This deletes the duplicate single-callback infrastructure that mirrored
// agent-session.ts; both builtin and external runtimes now share the same bus.

// ─── Config change handlers ───

export function isExternalModelFallbackRestartNeeded(
  nextModel: string,
  prevConfiguredModel: string,
  liveReportedModel: string,
): boolean {
  if (nextModel === prevConfiguredModel) return false;
  if (liveReportedModel && nextModel === liveReportedModel) return false;
  return true;
}

function getActiveRuntimeConfigCapabilities(): RuntimeConfigCapabilities {
  const runtime = getExternalActiveRuntime();
  return runtime?.getConfigCapabilities?.()
    ?? getDefaultExternalConfigCapabilities(runtime?.type ?? getCurrentRuntimeType());
}

async function applyRuntimeConfigFieldAtBoundary(
  key: keyof ExternalRuntimeConfigPatch,
  value: string | undefined,
  mode: RuntimeConfigApplyMode,
  warnings: string[],
): Promise<string | undefined> {
  const active = getExternalActivePair();
  if (!active || active.process.exited) return undefined;

  const run = async (setter: ((process: RuntimeProcess, value: string | undefined) => Promise<void>) | undefined) => {
    if (!setter) return;
    await setter.call(active.runtime, active.process, value || undefined);
  };

  try {
    switch (mode) {
      case 'next_turn_state':
        if (key === 'model') await run(active.runtime.setModel);
        if (key === 'permissionMode') await run(active.runtime.setPermissionMode);
        if (key === 'reasoningEffort') await run(active.runtime.setReasoningEffort);
        return undefined;
      case 'live_session_rpc':
        if (key === 'model') await run(active.runtime.setModel);
        if (key === 'permissionMode') await run(active.runtime.setPermissionMode);
        if (key === 'reasoningEffort') await run(active.runtime.setReasoningEffort);
        return undefined;
      case 'restart_when_idle':
        warnings.push(`${key} requires an idle restart for ${active.runtime.type}; restart is deferred until the runtime process exits`);
        console.warn(`[external-session] external-config restart_when_idle: field=${key} runtime=${active.runtime.type} sessionId=${getExternalLifecycleSessionId() || '(none)'}`);
        return undefined;
      case 'unsupported':
        warnings.push(`${key} is not supported by ${active.runtime.type}`);
        console.warn(`[external-session] external-config unsupported: field=${key} runtime=${active.runtime.type} sessionId=${getExternalLifecycleSessionId() || '(none)'}`);
        return undefined;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[external-session] external-config ${mode} failed: field=${key} runtime=${active.runtime.type ?? getCurrentRuntimeType()} sessionId=${getExternalLifecycleSessionId() || '(none)'} error=${message}`);
    if (mode === 'live_session_rpc' && (key === 'model' || key === 'permissionMode')) {
      return `${key} ${mode} failed: ${message}`;
    }
    warnings.push(`${key} ${mode} failed: ${message}`);
  }
  return undefined;
}

async function applyExternalRuntimeConfigToActiveProcess(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): Promise<ExternalConfigApplyResult> {
  const warnings: string[] = [];
  const capabilities = getActiveRuntimeConfigCapabilities();
  const keys = externalConfigPatchKeys(patch);

  for (const key of keys) {
    const error = await applyRuntimeConfigFieldAtBoundary(key, patch[key], capabilities[key], warnings);
    if (error) return { warnings, error };
  }

  console.log(
    `[external-session] external-config applied: sessionId=${getExternalLifecycleSessionId() || '(none)'} runtime=${getCurrentRuntimeType()} source=${source} keys=${keys.join(',') || '(none)'} modes=${keys.map((key) => `${key}:${capabilities[key]}`).join(',') || '(none)'}`,
  );
  return { warnings };
}

async function applyExternalRuntimeConfigAtBoundary(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): Promise<ExternalConfigApplyResult> {
  applyDesiredExternalRuntimeConfigPatch(patch);
  return applyExternalRuntimeConfigToActiveProcess(patch, source);
}

export async function updateExternalRuntimeConfig(
  patch: ExternalRuntimeConfigPatch,
  opts: { source?: ExternalConfigSource } = {},
): Promise<ExternalConfigUpdateResult> {
  await awaitExternalLifecycleStarting();

  const source = opts.source ?? 'runtime-config';
  const runtime = getCurrentRuntimeType();
  const lifecycleSessionId = getExternalLifecycleSessionId();
  const configSessionId = lifecycleSessionId || getCurrentBoundSessionId();
  const normalizedInput = normalizeExternalRuntimeConfigPatch(patch, source, runtime, configSessionId);
  const snapshotFiltered = filterRuntimeConfigPatchForSnapshot({
    patch: normalizedInput,
    source,
    isSnapshotted: isCurrentExternalSessionSnapshotted(configSessionId),
  });
  const normalized = snapshotFiltered.patch;
  const keys = externalConfigPatchKeys(normalized);
  const skippedWarnings = snapshotFiltered.skippedKeys.length > 0
    ? [`snapshot-authoritative fields skipped: ${snapshotFiltered.skippedKeys.join(',')}`]
    : [];
  if (snapshotFiltered.skippedKeys.length > 0) {
    console.warn(`[external-session] external-config skipped snapshot-owned fields: sessionId=${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} runtime=${runtime} source=${source} keys=${snapshotFiltered.skippedKeys.join(',')}`);
  }
  if (keys.length === 0) {
    console.log(`[external-session] external-config noop: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=(none)`);
    return { success: true, runtime, status: 'noop', warnings: skippedWarnings };
  }

  const shouldDefer = shouldDeferExternalConfigOperation(
    getExternalLifecycleState(),
    getExternalOperationQueueLength(),
    isExternalOperationDrainInFlight(),
    isExternalTurnFinalizationInFlight(),
  );
  const noop = isExternalRuntimeConfigPatchNoopAgainstDesired(
    normalized,
    { allowLiveReportedModel: !shouldDefer },
  );
  applyDesiredExternalRuntimeConfigPatch(normalized);
  if (noop) {
    console.log(`[external-session] external-config noop: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=${keys.join(',')}`);
    return { success: true, runtime, status: 'noop', warnings: skippedWarnings };
  }

  if (shouldDefer) {
    const position = enqueueExternalConfigOperation(normalized, source);
    console.log(`[external-session] external-config queued: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=${keys.join(',')} queuePosition=${position}`);
    if (getExternalLifecycleState() !== 'running' && isExternalTurnFinalizationInFlight()) {
      void waitExternalTurnFinalization(60_000).then(() => drainExternalQueueAfterTurn());
    }
    return { success: true, runtime, status: 'queued', warnings: skippedWarnings };
  }

  const result = await applyExternalRuntimeConfigAtBoundary(normalized, source);
  if (result.error) {
    return { success: false, runtime, status: 'applied', warnings: [...skippedWarnings, ...result.warnings], error: result.error };
  }
  return { success: true, runtime, status: 'applied', warnings: [...skippedWarnings, ...result.warnings] };
}

export async function setExternalModel(model: string, opts?: { imConfigSync?: boolean }): Promise<ExternalConfigUpdateResult> {
  const source: ExternalConfigSource = opts?.imConfigSync ? 'im-sync' : 'desktop';
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!shouldApplySnapshotConfigUpdate({
    field: 'model',
    source,
    isSnapshotted: isCurrentExternalSessionSnapshotted(lifecycleSessionId || getCurrentBoundSessionId()),
  })) {
    console.warn(`[external-session] IM config sync model '${model}' ignored — session ${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} is snapshotted (snapshot wins)`);
    return { success: true, runtime: getCurrentRuntimeType(), status: 'noop', warnings: [] };
  }
  return updateExternalRuntimeConfig({ model }, { source });
}

export async function setExternalPermissionMode(mode: string): Promise<ExternalConfigUpdateResult> {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!shouldApplySnapshotConfigUpdate({
    field: 'permissionMode',
    source: 'legacy-permission-mode-set',
    isSnapshotted: isCurrentExternalSessionSnapshotted(lifecycleSessionId || getCurrentBoundSessionId()),
  })) {
    console.warn(`[external-session] config sync permissionMode '${mode}' ignored — session ${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} is snapshotted (snapshot wins; legacy endpoint is Rust-IM-router-only by contract)`);
    return { success: true, runtime: getCurrentRuntimeType(), status: 'noop', warnings: [] };
  }
  return updateExternalRuntimeConfig({ permissionMode: mode }, { source: 'legacy-permission-mode-set' });
}

export async function setExternalReasoningEffort(setting: string): Promise<ExternalConfigUpdateResult> {
  return updateExternalRuntimeConfig(
    { reasoningEffort: setting },
    { source: 'desktop' },
  );
}

/** #324 — current normalized reasoning effort level, undefined = default. */
export function getExternalSessionReasoningEffort(): string | undefined {
  return getExternalRuntimeDisplayReasoningEffort();
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  return isExternalRuntime(getCurrentRuntimeType());
}

/**
 * Wait for any in-flight startExternalSession (notably pre-warm) to finish.
 * Used by callers that touch module state which the spawn path will write to —
 * /sessions/switch's external branch races against pre-warm post-spawn writes
 * if it doesn't serialize. updateExternalRuntimeConfig uses the same pattern
 * internally; this exported helper is for HTTP-route callers
 * that don't have direct access to `startingPromise`.
 */
export async function awaitExternalSessionStarting(): Promise<void> {
  await awaitExternalLifecycleStarting();
}

export function getExternalSessionState(): ExternalSessionState {
  return getExternalLifecycleState();
}

export function getExternalSystemInitPayload(): {
  info: SystemInitInfo;
  sessionId: string;
  prewarm?: boolean;
  runtime: RuntimeType;
  runtimeSource?: import('../../shared/types/runtime').RuntimeSource;
} | null {
  return getExternalSystemInitPayloadSnapshot();
}

export function getExternalPendingInteractiveRequests(): ExternalPendingInteractiveRequest[] {
  return getExternalInteractiveRequestsSnapshot();
}

export function getExternalSessionId(): string {
  return getExternalLifecycleSessionId();
}

export function isExternalSessionStateRestoredFor(sessionId: string): boolean {
  if (getExternalLifecycleSessionId() !== sessionId) return false;
  if (getExternalTranscriptSessionId() !== sessionId) return false;
  const diskMessages = getSessionData(sessionId)?.messages ?? [];
  const memoryMessages = getExternalSessionMessagesSnapshot();
  if (memoryMessages.length < diskMessages.length) return false;
  const diskMatchesMemoryPrefix = diskMessages.every((message, index) => memoryMessages[index]?.id === message.id);
  if (!diskMatchesMemoryPrefix) return false;
  if (memoryMessages.length === diskMessages.length) return true;

  // A longer in-memory transcript is valid only while the target session owns an
  // active/finalizing turn whose tail has not landed in SessionStore yet. Idle
  // tails are stale cross-session residue and must force restore instead.
  return getExternalLifecycleState() === 'running' || isExternalTurnFinalizationInFlight();
}

export function getExternalSessionWorkspacePath(): string {
  return getExternalLifecycleWorkspacePath();
}

/** The session this Sidecar is bound to right now — either already committed
 *  (lastSessionId, set by restoreExternalSessionState at boot or by a completed
 *  start) or about to be committed by an in-flight prewarm/start (startingSessionId).
 *  Used by /sessions/switch to detect a no-op switch (target matches the bound
 *  session) without awaiting the prewarm's CLI cold-start. */
export function getCurrentBoundSessionId(): string {
  return getCurrentExternalBoundSessionId();
}

export function getExternalSessionModel(): string | null {
  return getExternalRuntimeDisplayModel();
}

export function getExternalSessionPermissionMode(): string | null {
  return getExternalRuntimeDisplayPermissionMode();
}

function buildCurrentAssistantSnapshotContent(): string | null {
  return buildCurrentExternalAssistantSnapshotContent();
}

export function getExternalLiveAssistantMessage(): SessionMessage | null {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!lifecycleSessionId || getExternalLifecycleState() !== 'running') {
    return null;
  }
  const content = buildCurrentAssistantSnapshotContent();
  if (!content) {
    return null;
  }
  const turnStartTime = getExternalTurnStartTime() || Date.now();
  return {
    id: `external-live-${lifecycleSessionId}-${turnStartTime}`,
    role: 'assistant',
    content,
    timestamp: new Date(turnStartTime).toISOString(),
  };
}

function finalizeExternalLiveAssistantInMemory(): void {
  const message = getExternalLiveAssistantMessage();
  if (!message) return;
  const existing = getExternalSessionMessagesSnapshot().some(candidate => candidate.id === message.id);
  if (!existing) pushExternalSessionMessage(message);
}

export function getExternalLiveSessionSnapshot(targetSessionId: string): {
  snapshotRevision: number;
  inMemoryMessages: SessionMessage[];
  liveStreamingMessage: SessionMessage | null;
  liveSessionState: ExternalSessionState;
  pendingInteractiveRequests: ExternalPendingInteractiveRequest[];
} | null {
  if (targetSessionId !== getCurrentExternalBoundSessionId()) return null;
  flushPendingLiveEvents();
  const inMemoryMessages = getExternalTranscriptSessionId() === targetSessionId
    ? getExternalSessionMessagesSnapshot()
    : [];
  if (earlyBroadcastedUserMsg && !inMemoryMessages.some(message => message.id === earlyBroadcastedUserMsg?.id)) {
    inMemoryMessages.push(earlyBroadcastedUserMsg);
  }
  return structuredClone({
    snapshotRevision: getExternalLiveRevision(),
    inMemoryMessages,
    liveStreamingMessage: getExternalLiveAssistantMessage(),
    liveSessionState: getExternalLifecycleState(),
    pendingInteractiveRequests: getExternalInteractiveRequestsSnapshot(),
  });
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

export function getActiveRuntimeSource(): ReturnType<typeof getCurrentRuntimeSource> {
  return getCurrentRuntimeSource();
}

function isExternalTurnBusy(): boolean {
  return getExternalLifecycleState() === 'running' || isExternalTurnPromotionInFlight();
}

export async function handleExternalProxyConfigChange(input: {
  oldManagedProviderKey: string;
  newManagedProviderKey: string;
  oldProcessEnvKey: string;
  newProcessEnvKey: string;
}): Promise<{ success: boolean; error?: string; skipped?: string }> {
  const runtimeSource = getCurrentRuntimeSource();
  const runtimeType = getCurrentRuntimeType();
  const usesManagedProviderProxy =
    runtimeType === 'codex' && runtimeSource === 'managed-provider';
  const usesProcessProxyEnv =
    runtimeSource !== 'managed-provider' &&
    (activeExternalEnvPolicy?.proxy ?? 'myagents') === 'myagents';
  const oldKey = usesManagedProviderProxy
    ? input.oldManagedProviderKey
    : input.oldProcessEnvKey;
  const newKey = usesManagedProviderProxy
    ? input.newManagedProviderKey
    : input.newProcessEnvKey;

  if (!usesManagedProviderProxy && !usesProcessProxyEnv) {
    return { success: true, skipped: 'proxy-not-owned-by-myagents' };
  }
  if (oldKey === newKey) {
    return { success: true, skipped: 'unchanged' };
  }
  if (isExternalTurnBusy()) {
    if (!pendingExternalProxyRestart) {
      pendingExternalProxyRestartOriginalKey = oldKey;
    }
    if (newKey === pendingExternalProxyRestartOriginalKey) {
      pendingExternalProxyRestart = false;
      pendingExternalProxyRestartOriginalKey = null;
      console.log('[external-session] External runtime proxy changed back to in-flight value; deferred runtime restart cancelled');
      return { success: true, skipped: 'unchanged-after-defer' };
    }
    pendingExternalProxyRestart = true;
    console.log('[external-session] External runtime proxy changed; deferring runtime restart until current turn completes');
    return { success: true };
  }
  if (hasExternalRuntimeProcess()) {
    if (!pendingExternalProxyRestart) {
      pendingExternalProxyRestartOriginalKey = oldKey;
    }
    pendingExternalProxyRestart = true;
    try {
      await applyPendingExternalProcessConfigInvalidation();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { success: true };
}

function officialToolIdSetsEqual(
  left: readonly OfficialToolId[],
  right: readonly OfficialToolId[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Reconcile prompt-affecting official tools against the configuration that
 * actually created the live external process. Replayed renderer hydration is
 * a no-op; a real change restarts only at an idle turn boundary.
 */
export async function handleExternalOfficialToolIdsChange(
  ids: readonly OfficialToolId[] | null,
): Promise<{ success: boolean; error?: string; skipped?: string }> {
  await awaitExternalLifecycleStarting();

  const activeProcess = getExternalActiveProcess();
  if (!activeProcess || activeProcess.exited) {
    pendingExternalOfficialToolsRestart = false;
    return { success: true, skipped: 'no-live-process' };
  }

  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  const requestedIds = getEffectiveOfficialToolIdsForSession(
    workspacePath,
    sessionId ? getSessionMetadata(sessionId) : null,
    ids,
  );
  const appliedIds = getExternalActiveOfficialToolIds() ?? [];
  if (officialToolIdSetsEqual(appliedIds, requestedIds)) {
    pendingExternalOfficialToolsRestart = false;
    return { success: true, skipped: 'unchanged' };
  }

  if (isExternalTurnBusy()) {
    pendingExternalOfficialToolsRestart = true;
    console.log('[external-session] Official tool prompt changed; deferring runtime restart until current turn completes');
    return { success: true };
  }

  // The prompt belongs to the process that was born with it. Route idle
  // invalidation through the same owner as terminal-boundary invalidation so
  // an unconfirmed stop restores the latch and no later turn can reuse the
  // stale process.
  pendingExternalOfficialToolsRestart = true;
  try {
    await applyPendingExternalProcessConfigInvalidation();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeRuntimeSourceForRuntime(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

/**
 * Wait for external session to become idle.
 * Turn idleness is independent from process liveness. Persistent runtimes keep
 * a process alive while pre-warmed or between turns; those states are idle as
 * long as no real turn is in flight. A terminal turn still waits for its
 * transcript finalization before becoming observable as idle.
 * Returns true if completed within timeout, false otherwise.
 */
export async function waitForExternalSessionIdle(timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Cross-review 0.2.32 (Codex Critical 1): "idle" for our callers means "the
  // last assistant message is readable" (cron execute-sync, IM heartbeat and
  // memory-update all call getLastExternalAssistantText right after this
  // returns). The flags below only say the runtime EMITTED its terminal event;
  // the assistant push happens inside the fire-and-forget persistTurnResult.
  // So every idle exit additionally waits for finalization to settle, within
  // the caller's remaining deadline (a hung persist → not idle → the caller's
  // existing timeout handling applies, same as a hung turn).
  const finalized = () => waitExternalTurnFinalization(Math.max(1, deadline - Date.now()));
  // A known warm/running process with no turn is immediately idle. When there
  // is no lifecycle evidence at all, retain a brief grace period for callers
  // racing a fire-and-forget startExternalSession invocation before its
  // startingPromise has been installed.
  if (!isExternalLifecycleStarting() && !isExternalTurnBusy()) {
    if (isExternalLifecycleRunning() || getExternalActiveProcess()) {
      return finalized();
    }
    const graceMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (graceMs > 0) await new Promise(r => setTimeout(r, graceMs));
    if (!isExternalLifecycleStarting() && !isExternalTurnBusy()) return finalized();
  }
  while (Date.now() < deadline) {
    const activeProcess = getExternalActiveProcess();
    if (!isExternalLifecycleStarting() && !isExternalTurnBusy()) return finalized();
    if (!isExternalTurnPromotionInFlight()) {
      if (!isExternalLifecycleRunning() && !activeProcess) return finalized();
      if (activeProcess?.exited) return finalized();
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Check if the last external turn completed successfully.
 * Used by cron/heartbeat to avoid reading stale assistant text after a crash.
 */
export function didLastTurnSucceed(): boolean {
  return didExternalLastTurnSucceed();
}

/**
 * Get the last assistant message text from the current session.
 * Used by Cron handler and IM heartbeat to extract response text.
 * Handles both JSON ContentBlock[] and plain text formats.
 */
export function getLastExternalAssistantText(): string {
  return getLastExternalAssistantTextFromTranscript();
}

/**
 * Resolve the agent's envPolicy from disk. Thin wrapper over the shared
 * helper in `env-utils.ts` — kept as a local re-export so existing call
 * sites in this file stay 1-line. See `env-utils.resolveAgentEnvPolicy` for
 * validation contract.
 */
async function resolveAgentEnvPolicy(
  workspacePath: string,
): Promise<import('../../shared/types/runtime').RuntimeEnvPolicy | undefined> {
  const { resolveAgentEnvPolicy: shared } = await import('./env-utils');
  return shared(workspacePath);
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialImages?: ResolvedImagePayload[];
  model?: string;
  permissionMode?: string;
  /** #324 — NORMALIZED effort level, OR '' = explicit reset to the runtime
   *  default (records over a stale module value); absent = keep module state. */
  reasoningEffort?: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  resumeSessionId?: string;
  /** Issue #194 — per-agent env policy (proxy: myagents/terminal/direct). */
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
  /** IM-router birth marker; allows first-turn metadata materialization. */
  metadataBirthPending?: boolean;
  /** Internal: false when a per-message snapshot should not overwrite desired last* state. */
  recordConfigState?: boolean;
  dispatchPromotion?: ExternalTurnPromotionToken;
  activityFacts?: SessionActivityTurnFacts;
  turnBinding?: ExternalTurnBindingInput;
  onDispatchAccepted?: () => void;
  surfaceInitialUserMessage?: boolean;
}): Promise<void> {
  // Concurrency guard — wait for any in-flight start to finish
  await awaitExternalLifecycleStarting();
  if (isExternalLifecycleRunning()) {
    console.warn('[external-session] Session already running, ignoring start request');
    return;
  }

  // Wrap the body so concurrent callers serialize via startingPromise.
  // startingSessionId is set BEFORE _doStartExternalSession runs so that any
  // concurrent /sessions/switch into the same target can short-circuit even
  // while the spawn is still mid-flight (lastSessionId isn't written until
  // _doStartExternalSession reaches its session-context-bind step).
  const releaseStarting = beginExternalLifecycleStart(options.sessionId);

  try {
    await _doStartExternalSession(options);
  } finally {
    releaseStarting();
  }
}

/** Internal start implementation — called through concurrency guard above */
async function _doStartExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialImages?: ResolvedImagePayload[];
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  resumeSessionId?: string;
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
  metadataBirthPending?: boolean;
  recordConfigState?: boolean;
  dispatchPromotion?: ExternalTurnPromotionToken;
  activityFacts?: SessionActivityTurnFacts;
  turnBinding?: ExternalTurnBindingInput;
  onDispatchAccepted?: () => void;
  surfaceInitialUserMessage?: boolean;
}): Promise<void> {

  const runtimeType = getCurrentRuntimeType();
  const runtimeSource = getCurrentRuntimeSource();
  const runtime = getExternalRuntime(runtimeType);
  setExternalActiveRuntime(runtime);
  resetExternalUserRequestedStop();

  // Issue #194 — resolve agent envPolicy from disk if caller didn't pass it
  // explicitly. Most call sites (sendExternalMessage, prewarm) don't have
  // access to the agent config, so doing it here avoids N copies of the lookup.
  const resolvedEnvPolicy = options.envPolicy
    ?? await resolveAgentEnvPolicy(options.workspacePath);
  activeExternalEnvPolicy = resolvedEnvPolicy;

  // Build system prompt using MyAgents' three-layer architecture.
  // Pass the current runtime so L1 identity text reports the correct CLI
  // (e.g. "Google Gemini CLI" instead of the builtin default).
  //
  // cliToolsEnabled: true — teach the AI about `myagents cron …` / `myagents
  // im send-media` / `myagents im wake|channels` via a progressive-disclosure
  // appendix. v0.2.11+ also enables this on the builtin path (agent-session.ts)
  // because the corresponding in-process MCP servers (`cron-tools`, `im-cron`,
  // `im-media`) were retired in favour of the CLI surface — single source of
  // truth across builtin + external runtimes. See
  // prd_0.1.67_external_runtime_cli_skill.md for the original design.
  //
  // Generative-UI widget guidance is universal (no MCP equivalent) and is
  // injected unconditionally for desktop scenarios via buildWidgetSection().
  const existingMetadataAtStart = getSessionMetadata(options.sessionId);
  const enabledOfficialToolIds = getEffectiveOfficialToolIdsForSession(
    options.workspacePath,
    existingMetadataAtStart,
  );
  const baseSystemPrompt = buildSystemPromptAppend(options.scenario, {
    runtime: runtimeType,
    cliToolsEnabled: true,
    userCliToolsEnabled: isCliToolRegistryEnabled(),
    enabledOfficialToolIds,
  });

  // Cross-runtime workspace protocol: append workspace instruction files
  // so external runtimes receive the same project context as the builtin SDK.
  //   - Codex: only .claude/rules/*.md (CLAUDE.md is loaded natively via -c flag)
  //   - Gemini: full chain fallback (handled inside writeSessionSystemPrompt)
  //   - Claude Code: no injection needed (reads CLAUDE.md natively)
  const workspaceInstructions = runtimeType === 'codex'
    ? resolveCodexWorkspaceInstructions(options.workspacePath)
    : '';  // Gemini handles it in writeSessionSystemPrompt; CC reads natively
  if (workspaceInstructions) {
    console.log(`[external-session] Injecting workspace instructions for ${runtimeType} (${workspaceInstructions.length} bytes)`);
  }
  let systemPromptAppend = workspaceInstructions
    ? baseSystemPrompt + '\n\n' + workspaceInstructions
    : baseSystemPrompt;
  systemPromptAppend = appendManagedCodexInteractionLimitPrompt(
    systemPromptAppend,
    runtimeType,
    runtimeSource,
    options.scenario,
  );

  // External runtimes don't go through the SDK's session creation flow, so the
  // "pending-{tabId}" placeholder that the frontend assigns never gets upgraded
  // to a real UUID. A pending-prefixed ID in SessionStore breaks history reload
  // because the frontend's loadSession guard skips any session whose ID starts
  // with "pending-". Fix: mint a real UUID here on the first start (not resume).
  const originalSessionId = options.sessionId;
  if (isPendingSessionId(options.sessionId) && !options.resumeSessionId) {
    const realId = crypto.randomUUID();
    console.log(`[external-session] Upgrading pending session ID: ${options.sessionId} → ${realId}`);
    options.sessionId = realId;
    updateExternalLifecycleStartingSessionId(originalSessionId, realId);
  }
  const startModel = coerceExternalRuntimeModel(
    options.model,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const startPermissionMode = coerceExternalRuntimePermissionMode(
    options.permissionMode,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const startReasoningEffort = coerceExternalRuntimeReasoningEffort(
    options.reasoningEffort,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const runtimePermissionMode = shouldUseNonBypassForNativeAskUserQuestion(
    startPermissionMode,
    options.scenario,
  )
    ? 'auto'
    : startPermissionMode;

  const managedCodexMcpServers = runtimeType === 'codex' && runtimeSource === 'managed-provider'
    ? resolveWorkspaceConfig(options.workspacePath, existingMetadataAtStart, { includeMcp: true }).mcpServers
    : undefined;
  if (shouldTrackPendingExternalSessionBirth({
    hasInitialMessage: Boolean(options.initialMessage),
    hasResumeSessionId: Boolean(options.resumeSessionId),
    hasMetadata: Boolean(existingMetadataAtStart),
  })) {
    pendingExternalSessionBirth = {
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      scenario: options.scenario,
      runtimeSessionId: pendingBirthForSession(options.sessionId)?.runtimeSessionId,
    };
  } else if (existingMetadataAtStart) {
    clearPendingExternalSessionBirth(options.sessionId);
  }

  console.log(`[external-session] Starting ${runtimeType} session for ${options.sessionId}, model=${startModel || '(default)'}, permissionMode=${startPermissionMode || '(default)'}${runtimePermissionMode !== startPermissionMode ? ` -> runtime:${runtimePermissionMode}` : ''}, scenario=${options.scenario.type}, resume=${options.resumeSessionId || 'none'}`);
  // Detect pre-warm: prewarmExternalSession calls us with initialMessage=undefined.
  // Stamp this onto the session_init broadcast so the frontend doesn't enter the
  // "loading" state for a process that hasn't started processing any turn yet.
  setExternalPrewarmingSession(!options.initialMessage);
  setExternalTurnCompleted(false);
  setExternalLastTurnSucceeded(false);  // Reset — success only set after turn_complete
  resetTurnAccumulators();
  // Watchdog is per-turn, not per-process. Pre-warm (no initialMessage) leaves
  // the process idle awaiting a user message — starting a timer here would fire
  // a bogus "timed out" toast if the user takes >10 min to type. The real
  // watchdog is armed when the first turn begins (Case 3 in sendExternalMessage,
  // or the initialMessage block below).
  clearExternalTurnStartTime();
  // Track latest desired config for resume. Per-message snapshots (queued
  // message A followed by config B) deliberately opt out so the older message's
  // start options do not overwrite the newer desired state.
  if (options.recordConfigState !== false) {
    applyDesiredExternalRuntimeConfigPatch({
      ...(options.model !== undefined ? { model: startModel ?? '' } : {}),
      ...(options.permissionMode !== undefined ? { permissionMode: startPermissionMode ?? '' } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: startReasoningEffort ?? '' } : {}),
    });
  }
  // Only clear message history for new sessions, not resumes
  if (!options.resumeSessionId) {
    clearExternalSessionMessages(options.sessionId);
  }

  let turnAdmissionActivated = false;
  const admitInitialMessage = async (): Promise<void> => {
    if (!options.initialMessage || turnAdmissionActivated) return;
    assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
    const activityFacts = options.activityFacts ?? {
      origin: options.analyticsOrigin,
      inputText: options.initialMessage,
      systemMaintenanceKind: getSessionMetadata(options.sessionId)?.systemMaintenanceKind,
    };
    setExternalTurnActivityFacts(activityFacts);
    const admissionActivityAt = shouldRecordAdmissionActivity(activityFacts)
      ? new Date().toISOString()
      : undefined;
    const userMsg: SessionMessage = earlyBroadcastedUserMsg ?? {
      id: `user-${Date.now()}`,
      role: 'user',
      content: options.initialMessage,
      timestamp: new Date().toISOString(),
    };
    pushExternalSessionMessage(userMsg);
    resetTurnAccumulators();
    seedTurnWatchdogEstimate();
    resetWatchdog();
    markExternalTurnStarted();
    beginExternalTurnTrace('external_start_initial_message', options.sessionId);
    if (options.turnBinding) {
      bindExternalTurn(
        options.turnBinding.queueId,
        options.turnBinding.owner,
        options.turnBinding.onTerminal,
      );
    }
    if (options.surfaceInitialUserMessage || !earlyBroadcastedUserMsg) {
      broadcast('chat:message-replay', createLiveUserMessageReplay(options.sessionId, userMsg));
    }
    earlyBroadcastedUserMsg = null;
    options.onDispatchAccepted?.();
    turnAdmissionActivated = true;
    currentTurnAnalyticsSource = options.analyticsSource ?? options.scenario.type;
    currentTurnAnalyticsOrigin = options.analyticsOrigin ?? null;
    setExternalSessionState('running');

    // Register session in history index BEFORE the first message persist
    // (mirrors agent-session.ts enqueueUserMessage and the Case-3 pre-warm path).
    // SessionStore enforces the index⟺data invariant (issue #336): a JSONL is
    // never CREATED for a session without a sessions.json entry — persisting
    // first would get the write refused and drop the user's first message.
    await persistUserMessageBeforeRuntimeDispatch({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      messageText: options.initialMessage,
      origin: 'initial message',
      scenario: options.scenario,
      turnPath: options.resumeSessionId ? 'resume-start' : 'fresh-start',
      metadataBirthPending: options.metadataBirthPending,
      birthOrigin: options.birthOrigin,
      userMsg,
      failureContext: '[external-session] Failed to persist initial user message',
      lastActiveAt: admissionActivityAt,
    });
    assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
  };

  // Set session context BEFORE startSession so that events fired during startup
  // (e.g., Codex's synchronous session_init) can reference lastSessionId for persistence.
  bindExternalSessionContext({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    scenario: options.scenario,
    analyticsSource: options.analyticsSource ?? options.scenario.type,
    analyticsOrigin: options.analyticsOrigin ?? null,
  });
  if (!options.initialMessage) {
    currentTurnAnalyticsSource = null;
    currentTurnAnalyticsOrigin = null;
  }

  // Set isRunning BEFORE spawning — prevents waitForExternalSessionIdle from
  // seeing the pre-start state and returning true prematurely. Reset in catch.
  setExternalLifecycleRunning(true);
  const disallowedTools = getRuntimeAwareChannelInteractionDisallowedTools(
    runtimeType,
    runtimeSource,
    options.scenario,
  );

  const startOnce = (resumeId: string | undefined): Promise<RuntimeProcess> =>
    runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        // Guarded turns split process startup from prompt transport. This lets
        // Stop invalidate the promotion while initialize/resume is still
        // awaiting and before any runtime can consume the prompt.
        initialMessage: options.dispatchPromotion ? undefined : options.initialMessage,
        initialImages: options.dispatchPromotion ? undefined : options.initialImages,
        systemPromptAppend,
        model: startModel,
        permissionMode: runtimePermissionMode,
        reasoningEffort: startReasoningEffort,
        scenario: options.scenario,
        resumeSessionId: resumeId,
        disallowedTools,
        envPolicy: resolvedEnvPolicy,
        runtimeSource,
        mcpServers: managedCodexMcpServers,
      },
      handleUnifiedEvent,
    );

  let startedProcess: RuntimeProcess | null = null;
  let terminalSettledByStop = false;
  try {
    if (options.initialMessage) {
      await admitInitialMessage();
    }
    let process: RuntimeProcess;
    try {
      assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
      process = await startOnce(options.resumeSessionId);
    } catch (err) {
      // Stale resume recovery (issue #105): the runtime reports our persisted
      // runtimeSessionId is dead (Codex rollout GC'd, Gemini session dropped
      // across CLI upgrade, etc.). Invalidate both the in-memory pointer and
      // the on-disk metadata, then retry fresh once so the user's message
      // still lands instead of looping on the stale id forever. If the fresh
      // retry also fails, fall through to the normal error surface.
      if (err instanceof StaleRuntimeSessionError && options.resumeSessionId) {
        console.warn(`[external-session] ${runtimeType} resume rejected as stale (id=${err.runtimeSessionId}): ${err.message} — invalidating and retrying fresh`);
        clearExternalRuntimeSessionId();
        if (options.sessionId) {
          try {
            await updateSessionMetadata(options.sessionId, { runtimeSessionId: '' });
          } catch (metaErr) {
            console.warn('[external-session] Failed to clear stale runtimeSessionId on disk:', metaErr);
          }
        }
        // Also drop any pre-warm birth runtime pointer that belongs to a
        // now-dead resume — letting it survive would re-patch the stale id
        // onto the next metadata registration.
        if (
          pendingExternalSessionBirth?.sessionId === options.sessionId
          && pendingExternalSessionBirth.runtimeSessionId === err.runtimeSessionId
        ) {
          pendingExternalSessionBirth = {
            ...pendingExternalSessionBirth,
            runtimeSessionId: undefined,
          };
        }
        assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
        process = await startOnce(undefined);
        console.log(`[external-session] ${runtimeType} recovered via fresh start after stale resume`);
      } else {
        throw err;
      }
    }

    if (process.exited) {
      throw new Error(`${runtimeType} process exited before startup completed`);
    }
    startedProcess = process;
    setExternalActiveProcess(process, enabledOfficialToolIds);
    if (options.dispatchPromotion && !isExternalTurnPromotionCurrent(options.dispatchPromotion)) {
      throw new ExternalTurnPromotionCanceledError();
    }
    if (options.dispatchPromotion && options.initialMessage) {
      assertExternalTurnPromotionCurrent(options.dispatchPromotion);
      if (process.exited || getExternalActiveProcess() !== process) return;
      finishExternalTurnPromotion(options.dispatchPromotion, { status: 'dispatched' });
      await runtime.sendMessage(process, options.initialMessage, options.initialImages);
    }
    console.log(`[external-session] ${runtimeType} process started, pid=${process.pid}`);
  } catch (err) {
    const failure = options.dispatchPromotion?.signal.aborted
      && !(err instanceof ExternalTurnPromotionCanceledError)
      ? new ExternalTurnPromotionCanceledError()
      : err;
    if (startedProcess && !startedProcess.exited && getExternalActiveProcess() === startedProcess) {
      const stopped = await stopExternalSession({
        preserveQueue: failure instanceof ExternalTurnPromotionCanceledError
          ? options.dispatchPromotion?.preserveQueueOnCancel === true
          : true,
      });
      terminalSettledByStop = stopped;
      if (!stopped && hasExternalRuntimeProcess()) {
        console.error(`[external-session] Failed to confirm ${runtimeType} termination after guarded start failure`);
        if (options.turnBinding) {
          bindExternalTurn(
            options.turnBinding.queueId,
            options.turnBinding.owner,
            options.turnBinding.onTerminal,
          );
        }
        if (options.dispatchPromotion) {
          finishExternalTurnPromotion(options.dispatchPromotion, {
            status: 'termination-unconfirmed',
          });
        }
        throw new ExternalDispatchTerminationUnconfirmedError(failure);
      }
    }
    const activeAfterFailure = getExternalActiveProcess();
    if (!activeAfterFailure || activeAfterFailure.exited) {
      clearExternalActiveRuntimeProcess();
      activeExternalEnvPolicy = undefined;
      clearWatchdog();
    }
    if (options.dispatchPromotion && !turnAdmissionActivated) {
      finishExternalTurnPromotion(options.dispatchPromotion, {
        status: startedProcess ? 'terminated' : 'not-dispatched',
      });
    }
    const settledByConcurrentTerminal = turnAdmissionActivated
      && !terminalSettledByStop
      && (
        getExternalUserRequestedStop()
        || isExternalTurnGenerationCurrent(getExternalTurnTerminalGeneration())
        || (
          options.turnBinding !== undefined
          && !isExternalTurnCurrent(options.turnBinding.queueId)
        )
      );
    if (settledByConcurrentTerminal) {
      if (options.dispatchPromotion) {
        finishExternalTurnPromotion(options.dispatchPromotion, {
          status: startedProcess ? 'terminated' : 'not-dispatched',
        });
      }
      return;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    if (!(failure instanceof ExternalTurnPromotionCanceledError)) {
      console.error(`[external-session] Failed to start ${runtimeType}:`, message);
    }
    // Pre-warm failures are silent — the user didn't ask for this optimization
    // and shouldn't see an error toast for it. The next real user message will
    // retry via the normal send path; if that also fails, the error surfaces
    // there with full context (which runtime, which sessionId, etc).
    if (
      turnAdmissionActivated
      && !(failure instanceof ExternalTurnPromotionCanceledError)
      && !terminalSettledByStop
    ) {
      finalizeAcceptedExternalFailure(message);
      clearWatchdog();
      clearExternalTurnStartTime();
      resetTurnAccumulators();
      clearExternalTurnTrace();
      setExternalSessionState('error');
      broadcast('chat:agent-error', { message: `Failed to start ${runtimeType}: ${message}` });
    }
    if (options.dispatchPromotion && turnAdmissionActivated) {
      finishExternalTurnPromotion(options.dispatchPromotion, {
        status: startedProcess ? 'terminated' : 'not-dispatched',
      });
    }
    // Re-throw so the HTTP handler returns an error response
    throw failure;
  }
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 *
 * Modality scope (V1): the model-input-modality filter (see
 * `agent-session.ts::enqueueUserMessage` + `model-capabilities.ts::modelSupportsModality`)
 * lives only on the builtin Claude Agent SDK path. External runtimes (Claude
 * Code CLI / Codex / Gemini CLI) pass `images` through unfiltered here.
 * Rationale:
 *   - Each external runtime has its own modality contract (Codex blocks
 *     images, Gemini accepts image+video+audio, CC CLI accepts images).
 *   - External runtime models aren't in MyAgents' PRESET_PROVIDERS registry,
 *     so `lookupModelCapability` would return undefined → optimistic
 *     default-allow → effectively no filter, just runtime overhead.
 *   - The frontend toast in `SimpleChatInput` is gated behind
 *     `!isExternalRuntime` to keep UX honest (no false "will be filtered"
 *     promises on runtimes that pass images through).
 * If you ever wire modality lookups for external-runtime models, add the
 * filter here and lift the frontend gate.
 */
/**
 * #324 — resolve the effort to pass into startExternalSession for this turn.
 * Context-present = authoritative (raw setting; 'default' normalizes to ''
 * which startExternalSession records as "explicit default" and runtimes
 * treat as "omit the knob"). Context-absent = desktop / unmanaged → module
 * state (set by /api/reasoning-effort/set or snapshot restore).
 */
function resolveTurnReasoningEffort(context: ExternalSendContext | undefined): string | undefined {
  if (context?.reasoningEffort !== undefined) {
    return coerceExternalRuntimeReasoningEffort(
      context.reasoningEffort,
      getCurrentRuntimeType(),
      'turn-context',
      context.sessionId,
    ) ?? '';
  }
  return getExternalRuntimeDesiredReasoningEffort() || undefined;
}

async function evaluateExternalDispatchGuard(
  guard: ExternalSendContext['beforeDispatch'],
): Promise<{ accepted: true } | { accepted: false; error: string }> {
  if (!guard) return { accepted: true };
  try {
    const result = await guard();
    return result.accepted
      ? { accepted: true }
      : { accepted: false, error: result.error ?? result.code ?? 'Goal admission is stale' };
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

class ExternalTurnPromotionCanceledError extends Error {
  constructor() {
    super('External turn promotion was canceled before runtime dispatch');
    this.name = 'ExternalTurnPromotionCanceledError';
  }
}

class ExternalDispatchTerminationUnconfirmedError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`${message}; external runtime process termination could not be confirmed`);
    this.name = 'ExternalDispatchTerminationUnconfirmedError';
  }
}

function assertExternalTurnPromotionCurrent(token: ExternalTurnPromotionToken | null): void {
  if (token && !isExternalTurnPromotionCurrent(token)) {
    throw new ExternalTurnPromotionCanceledError();
  }
}

async function awaitDuringExternalTurnPromotion<T>(
  promise: Promise<T>,
  token: ExternalTurnPromotionToken | null,
): Promise<{ canceled: true } | { canceled: false; value: T }> {
  if (!token) return { canceled: false, value: await promise };
  if (token.signal.aborted) return { canceled: true };

  let onAbort!: () => void;
  const canceled = new Promise<{ canceled: true }>((resolve) => {
    onAbort = () => resolve({ canceled: true });
    token.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      promise.then(value => ({ canceled: false as const, value })),
      canceled,
    ]);
  } finally {
    token.signal.removeEventListener('abort', onAbort);
  }
}

export async function sendExternalMessage(
  text: string,
  images?: ImagePayload[],
  _permissionMode?: string,
  _model?: string,
  context?: ExternalSendContext,
  preBroadcasted?: SessionMessage,
  onDispatchAccepted?: () => void,
): Promise<ExternalSendResult> {
  const hasInputImages = images && images.length > 0;
  if (hasInputImages && !context?.sessionId) {
    return { queued: false, error: '图片附件缺少会话上下文，无法发送' };
  }
  let resolvedImages: ResolvedImagePayload[] | undefined;
  try {
    resolvedImages = context?.sessionId
      ? resolveImagePayloads(context.sessionId, images)
      : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[external-session] failed to resolve image attachments:', err);
    return { queued: false, error: message };
  }
  const hasImages = resolvedImages && resolvedImages.length > 0;
  const turnAnalyticsSource = context?.analyticsSource ?? context?.scenario.type ?? getExternalLifecycleAnalyticsSource();
  const turnAnalyticsOrigin = context?.analyticsOrigin
    ?? originFromTurnAttribution({
      source: turnAnalyticsSource,
      scenarioType: context?.scenario.type ?? getExternalLifecycleScenario().type,
      desktopSurface: context?.scenario.type === 'desktop' ? context.scenario.surface : undefined,
      inboxMeta: context?.inboxMeta,
    });
  const userAttachments = preBroadcasted?.attachments
    ?? sessionMessageAttachmentsFromImages(context?.sessionId, images);

  // Show ordinary user messages immediately. Guarded Goal messages stay local
  // until their final admission check succeeds, so a stale scheduler/user turn
  // cannot leak into UI or history while waiting for a turn boundary.
  // The message appears in the chat as soon as the user presses send, giving
  // responsive feedback even when the runtime takes 10-15s to cold-start.
  // Downstream code (Case 1/2/3) also calls broadcast('chat:message-replay')
  // for the same message — we set earlyBroadcastedUserMsg so they can skip
  // the redundant broadcast while still recording for persistence.
  //
  // Issue #188 — when the caller (enqueueExternalSendForDesktop) has already
  // broadcast the bubble synchronously so the renderer sees it immediately,
  // adopt that SessionMessage here instead of re-broadcasting. Without this,
  // the user's bubble would flash twice with different IDs.
  let earlyUserMsg: SessionMessage;
  let surfaceUserMessageAfterGuard = false;
  if (preBroadcasted) {
    earlyUserMsg = userAttachments && !preBroadcasted.attachments
      ? { ...preBroadcasted, attachments: userAttachments }
      : preBroadcasted;
  } else {
    earlyUserMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      attachments: userAttachments,
    };
    surfaceUserMessageAfterGuard = Boolean(context?.beforeDispatch);
  }
  earlyBroadcastedUserMsg = earlyUserMsg;
  if (!preBroadcasted && !surfaceUserMessageAfterGuard) {
    broadcast('chat:message-replay', createLiveUserMessageReplay(
      context?.sessionId ?? getExternalLifecycleSessionId(),
      earlyUserMsg,
    ));
  }

  // The promotion is the pre-dispatch identity for guarded Task/Goal turns.
  // Bind it before any lifecycle/busy wait so an exact queueId stop can cancel
  // this pending send without stopping the unrelated turn currently running.
  let dispatchPromotion = context?.beforeDispatch
    ? beginExternalTurnPromotion({
        queueId: context.queueId,
        owner: context.turnOwner,
        cancelDispatch: context.beforeDispatch.cancel,
      })
    : null;
  if (context?.beforeDispatch && !dispatchPromotion) {
    earlyBroadcastedUserMsg = null;
    return { queued: false, error: 'external_busy: another turn is being promoted' };
  }
  const canceledBeforeDispatch = (): { queued: false } => {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    earlyBroadcastedUserMsg = null;
    return { queued: false };
  };
  const ensureInitialDispatchPromotion = (): boolean => {
    if (dispatchPromotion) return true;
    dispatchPromotion = beginExternalTurnPromotion({
      queueId: context?.queueId,
      owner: context?.turnOwner,
    });
    return dispatchPromotion !== null;
  };

  // If a pre-warm (or other concurrent start) is still bringing the process
  // up, wait for it to finish before deciding which case to take. Without
  // this await, a user-send racing an in-flight pre-warm would see
  // `isRunning=true` but `activeProcess=null` — falling into Case 2's resume
  // path, which calls startExternalSession again, which then hits the
  // `if (isRunning) return` early-exit and silently drops the user's message.
  const lifecycleReady = await awaitDuringExternalTurnPromotion(
    awaitExternalLifecycleStarting(),
    dispatchPromotion,
  );
  if (lifecycleReady.canceled) return canceledBeforeDispatch();

  // Serialize against any in-flight turn. Persistent-process runtimes (Codex
  // app-server, Gemini --acp) accept one turn at a time — dispatching a
  // second user message while the first is still running can cause silent
  // drops or interleaved output. `turnCompleted=false && currentTurnStartTime
  // !== 0` means a previous user turn kicked off and hasn't finished. On
  // crash, session_complete resets currentTurnStartTime via
  // resetTurnAccumulators(), so this gate doesn't spuriously trip.
  //
  // Issue #188 — if the busy turn doesn't settle within the cap, do NOT fall
  // through to Case 3 and dispatch into a still-running runtime. That used to
  // silently drop the message (or interleave with the active turn). Return a
  // queue-style error so the caller can surface it to the user.
  const busyProcess = getExternalActiveProcess();
  if (!isExternalTurnCompleted() && getExternalTurnStartTime() !== 0 && busyProcess && !busyProcess.exited) {
    const idleWait = await awaitDuringExternalTurnPromotion(
      waitForExternalSessionIdle(5 * 60 * 1000, 100),
      dispatchPromotion,
    );
    if (idleWait.canceled) return canceledBeforeDispatch();
    const settled = idleWait.value;
    if (!settled) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      earlyBroadcastedUserMsg = null;
      // PRD 0.2.18 — busy reject BEFORE binding meta, so no leak risk here.
      // Caller (if inbox) gets a single signal via queued:false → drain handler
      // surfaces the error code; no need to also push a reply (cross-review CC:
      // double-signal causes duplicate / contradictory caller feedback).
      return { queued: false, error: 'external_busy: 上一个回合超过 5 分钟未完成，消息未发送，请稍后重试。' };
    }
  }

  // Cross-review 0.2.32 (Codex Critical 2): the busy gate above is SKIPPED the
  // moment turnCompleted flips true — but the previous turn's fire-and-forget
  // persistTurnResult may still be inside its await window. Proceeding now
  // would push this turn's user message ahead of the previous assistant
  // message (history order inversion) and run resetTurnAccumulators() under
  // the persist's feet, wiping the content blocks it still has to read — the
  // previous assistant reply would vanish from history/disk. Wait (bounded)
  // for finalization; on a pathological hang, proceed degraded rather than
  // blocking the user's send forever — persistTurnResult snapshots EVERY
  // turn-scoped field (inbox meta, hints, context usage, content blocks,
  // assistant text) before its first await and only resets accumulators it
  // still owns, so the worst case is a stale-ordering write, not message
  // loss (cross-review 0.2.33, Codex W1 closed the content-blocks gap).
  if (isExternalTurnFinalizationInFlight()) {
    const finalizationWait = await awaitDuringExternalTurnPromotion(
      waitExternalTurnFinalization(60_000),
      dispatchPromotion,
    );
    if (finalizationWait.canceled) return canceledBeforeDispatch();
    const settled = finalizationWait.value;
    if (!settled) {
      console.warn('[external-session] previous turn finalization still in flight after 60s — proceeding with send (degraded ordering)');
    }
  }

  const terminalObserverWait = await awaitDuringExternalTurnPromotion(
    waitForExternalTurnTerminalObserver(),
    dispatchPromotion,
  );
  if (terminalObserverWait.canceled) return canceledBeforeDispatch();

  const guardWait = await awaitDuringExternalTurnPromotion(
    evaluateExternalDispatchGuard(context?.beforeDispatch),
    dispatchPromotion,
  );
  if (guardWait.canceled) return canceledBeforeDispatch();
  const guarded = guardWait.value;
  if (!guarded.accepted) {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    earlyBroadcastedUserMsg = null;
    return { queued: false, error: guarded.error };
  }
  if (dispatchPromotion && !isExternalTurnPromotionCurrent(dispatchPromotion)) {
    return canceledBeforeDispatch();
  }

  // A previous config change may have reached a terminal boundary while the
  // old process could not be stopped. Never let a later send silently reuse
  // that invalid prompt/env owner: retry invalidation before selecting Case 3.
  if (
    externalProcessConfigInvalidationInFlight
    || pendingExternalProcessConfigRestartReasons().length > 0
  ) {
    try {
      await applyPendingExternalProcessConfigInvalidation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      earlyBroadcastedUserMsg = null;
      return {
        queued: false,
        error: `${message}; stale external runtime was not reused`,
      };
    }
    if (dispatchPromotion && !isExternalTurnPromotionCurrent(dispatchPromotion)) {
      return canceledBeforeDispatch();
    }
  }
  // Transfer ownership atomically from config invalidation to this turn before
  // the next await. A config update that starts first is awaited above; one
  // that starts after this claim observes a busy promotion and is deferred to
  // the turn boundary. Case 3 hands the claim to lifecycle state='running'
  // synchronously before its first persistence await.
  if (!ensureInitialDispatchPromotion()) {
    earlyBroadcastedUserMsg = null;
    return { queued: false, error: 'external_busy: another turn is being promoted' };
  }
  const activitySessionId = context?.sessionId ?? getExternalLifecycleSessionId();
  const activityFacts: SessionActivityTurnFacts = {
    origin: turnAnalyticsOrigin,
    inputText: text,
    systemMaintenanceKind: getSessionMetadata(activitySessionId)?.systemMaintenanceKind,
  };

  // PRD 0.2.18 Session Inbox — bind per-turn inbox meta + reset attachment hints
  // accumulator now that we know this turn is going to run. (After the busy
  // check, before kicking the runtime.) Cleared at persistTurnResult finally
  // OR via clearExternalInboxMetaOnRejection() below when sendExternalMessage rejects
  // before persistTurnResult ever runs.
  setExternalTurnInboxMeta(context?.inboxMeta ?? null);
  resetExternalTurnAttachmentHints();

  // Pattern B — set the active IM trace ID *after* the previous turn has
  // settled. Setting it earlier (pre-fix) caused tail deltas/complete events
  // from the running turn A to be tagged with turn B's requestId during the
  // wait window, mis-routing them to the wrong IM subscriber and breaking
  // cancellation attribution. session-end (session_complete /
  // stopExternalSession) clears it again. No-op when context.requestId is
  // undefined (desktop / cron paths).
  if (context?.requestId) {
    setExternalActiveRequestId(context.requestId);
  }
  emitPerfTrace({
    trace: 'turn',
    phase: 'enqueue',
    sessionId: context?.sessionId || getExternalLifecycleSessionId() || undefined,
    requestId: context?.requestId || getExternalActiveRequestId() || undefined,
    runtime: getCurrentRuntimeType(),
    status: 'ok',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    count: hasImages ? images?.length : 0,
    detail: {
      source: turnAnalyticsSource,
      hasImages: Boolean(hasInputImages),
      preBroadcasted: Boolean(preBroadcasted),
    },
  });

  // Case 1: No previous session — start fresh
  if (!getExternalRuntimeSessionId() && !isExternalLifecycleRunning()) {
    if (!context) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'no_context',
        errorMessage: 'No session context for first message',
      });
      return { queued: false, error: 'No session context for first message' };
    }
    if (!ensureInitialDispatchPromotion()) {
      earlyBroadcastedUserMsg = null;
      clearExternalInboxMetaOnRejection({
        sessionId: context.sessionId,
        errorCode: 'external_busy',
        errorMessage: 'Another external turn is being promoted',
      });
      return { queued: false, error: 'external_busy: another turn is being promoted' };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        initialImages: hasImages ? resolvedImages : undefined,
        model: context.model ?? getExternalRuntimeDesiredModel(),
        permissionMode: context.permissionMode ?? getExternalRuntimeDesiredPermissionMode(),
        reasoningEffort: resolveTurnReasoningEffort(context),
        scenario: context.scenario,
        analyticsSource: turnAnalyticsSource,
        analyticsOrigin: turnAnalyticsOrigin,
        birthOrigin: context.birthOrigin,
        metadataBirthPending: context.metadataBirthPending,
        recordConfigState: !hasQueuedExternalConfigOperation(),
        dispatchPromotion: dispatchPromotion ?? undefined,
        activityFacts,
        turnBinding: context.queueId ? {
          queueId: context.queueId,
          owner: context.turnOwner,
          onTerminal: context.onTerminal,
        } : undefined,
        onDispatchAccepted,
        surfaceInitialUserMessage: surfaceUserMessageAfterGuard,
      });
      return { queued: true };
    } catch (err) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      earlyBroadcastedUserMsg = null;  // Defensive: prevent stale msg leaking to next send
      if (err instanceof ExternalTurnPromotionCanceledError) return { queued: false };
      if (err instanceof ExternalDispatchTerminationUnconfirmedError) {
        return { queued: false, error: err.message, terminationUnconfirmed: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'start_failed',
        errorMessage: msg,
      });
      return { queued: false, error: msg };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  const activeProcess = getExternalActiveProcess();
  if (!activeProcess || activeProcess.exited) {
    // CC supports custom session IDs (--session-id) — resume with our MyAgents session ID.
    // Codex doesn't support custom IDs — resume with Codex's own threadId (lastRuntimeSessionId).
    const runtimeType = getCurrentRuntimeType();
    const lifecycleSessionId = getExternalLifecycleSessionId();
    const resumeId = runtimeType === 'claude-code' ? lifecycleSessionId : getExternalRuntimeSessionId();
    const nextScenario = context?.scenario ?? getExternalLifecycleScenario();
    const nextModel = context?.model ?? getExternalRuntimeDesiredModel();
    const nextPermissionMode = context?.permissionMode ?? getExternalRuntimeDesiredPermissionMode();
    console.log(`[external-session] Previous process exited, resuming ${runtimeType} session ${resumeId}`);
    if (!ensureInitialDispatchPromotion()) {
      earlyBroadcastedUserMsg = null;
      clearExternalInboxMetaOnRejection({
        sessionId: lifecycleSessionId,
        errorCode: 'external_busy',
        errorMessage: 'Another external turn is being promoted',
      });
      return { queued: false, error: 'external_busy: another turn is being promoted' };
    }
    try {
      await startExternalSession({
        sessionId: lifecycleSessionId,
        workspacePath: getExternalLifecycleWorkspacePath(),
        initialMessage: text,
        initialImages: hasImages ? resolvedImages : undefined,
        model: nextModel,
        permissionMode: nextPermissionMode,
        reasoningEffort: resolveTurnReasoningEffort(context), // #324
        scenario: nextScenario,
        analyticsSource: turnAnalyticsSource,
        analyticsOrigin: turnAnalyticsOrigin,
        birthOrigin: context?.birthOrigin,
        resumeSessionId: resumeId, // CC: --resume <myagents-session-id>; Codex: --resume <threadId>
        metadataBirthPending: context?.metadataBirthPending,
        recordConfigState: !hasQueuedExternalConfigOperation(),
        dispatchPromotion: dispatchPromotion ?? undefined,
        activityFacts,
        turnBinding: context?.queueId ? {
          queueId: context.queueId,
          owner: context.turnOwner,
          onTerminal: context.onTerminal,
        } : undefined,
        onDispatchAccepted,
        surfaceInitialUserMessage: surfaceUserMessageAfterGuard,
      });
      return { queued: true };
    } catch (err) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      earlyBroadcastedUserMsg = null;  // Defensive: prevent stale msg leaking to next send
      if (err instanceof ExternalTurnPromotionCanceledError) return { queued: false };
      if (err instanceof ExternalDispatchTerminationUnconfirmedError) {
        return { queued: false, error: err.message, terminationUnconfirmed: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'resume_failed',
        errorMessage: msg,
      });
      return { queued: false, error: msg };
    }
  }

  // Case 3: Process still running — send via runtime.sendMessage
  // This is the normal path for persistent-process runtimes like Codex app-server.
  const activeRuntime = getExternalActiveRuntime();
  if (!activeRuntime) {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'no_runtime',
      errorMessage: 'No active runtime',
    });
    if (dispatchPromotion) setExternalSessionState('idle');
    return { queued: false, error: 'No active runtime' };
  }
  let runtimeDispatchStarted = false;
  let turnAdmissionActivated = false;
  try {
    assertExternalTurnPromotionCurrent(dispatchPromotion);
    const applyResult = await applyExternalRuntimeConfigToActiveProcess(
      normalizeExternalRuntimeConfigPatch({
        model: _model ?? context?.model ?? getExternalRuntimeDesiredModel(),
        permissionMode: _permissionMode ?? context?.permissionMode ?? getExternalRuntimeDesiredPermissionMode(),
        reasoningEffort: resolveTurnReasoningEffort(context),
      }, 'message-snapshot', getCurrentRuntimeType(), getExternalLifecycleSessionId() || context?.sessionId || ''),
      'message-snapshot',
    );
    if (applyResult.error) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'config_apply_failed',
        errorMessage: applyResult.error,
      });
      setExternalSessionState('idle');
      return { queued: false, error: applyResult.error };
    }
    assertExternalTurnPromotionCurrent(dispatchPromotion);
    // Record user message for persistence. Reuse early-broadcast message if available
    // (sendExternalMessage already showed it to the user for instant feedback).
    const userMsg: SessionMessage = earlyBroadcastedUserMsg ?? {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      attachments: userAttachments,
    };
    const shouldSurfaceUserMessage = surfaceUserMessageAfterGuard || !earlyBroadcastedUserMsg;
    setExternalTurnActivityFacts(activityFacts);
    const admissionActivityAt = shouldRecordAdmissionActivity(activityFacts)
      ? new Date().toISOString()
      : undefined;
    pushExternalSessionMessage(userMsg);
    setExternalTurnCompleted(false);
    setExternalLastTurnSucceeded(false);  // Reset for this turn (prevents stale text on failure)
    resetTurnAccumulators();
    currentTurnAnalyticsSource = turnAnalyticsSource;
    currentTurnAnalyticsOrigin = turnAnalyticsOrigin;
    setExternalLifecycleAnalyticsSource(turnAnalyticsSource);
    setExternalLifecycleAnalyticsOrigin(turnAnalyticsOrigin);
    seedTurnWatchdogEstimate();
    resetWatchdog();  // Start watchdog for this turn (Case 3 bypasses startExternalSession)
    markExternalTurnStarted();
    beginExternalTurnTrace('external_send_message', getExternalLifecycleSessionId());
    if (context?.queueId) {
      bindExternalTurn(context.queueId, context.turnOwner, context.onTerminal);
    }
    if (dispatchPromotion) {
      finishExternalTurnPromotion(dispatchPromotion, { status: 'dispatched' });
    }
    if (shouldSurfaceUserMessage) {
      broadcast('chat:message-replay', createLiveUserMessageReplay(
        getExternalLifecycleSessionId(),
        userMsg,
      ));
    }
    earlyBroadcastedUserMsg = null;
    onDispatchAccepted?.();
    turnAdmissionActivated = true;
    setExternalSessionState('running');

    // First real user turn clears the pre-warm marker. Also strip it from the
    // cached system_init payload so SSE reconnect replay reflects the current
    // "actually processing a turn" state, not the stale "alive but idle" hint.
    clearExternalPrewarmingSession();

    // Register session metadata on first real message of a pre-warmed session.
    // Normally this happens inside startExternalSession's initialMessage block,
    // but pre-warm calls startExternalSession WITHOUT an initialMessage, so we
    // have to register here when the first actual message arrives via Case 3.
    await persistUserMessageBeforeRuntimeDispatch({
      sessionId: getExternalLifecycleSessionId(),
      workspacePath: getExternalLifecycleWorkspacePath(),
      messageText: text,
      origin: 'first message after pre-warm',
      scenario: getExternalLifecycleScenario(),
      turnPath: 'active-process',
      metadataBirthPending: context?.metadataBirthPending,
      birthOrigin: context?.birthOrigin,
      userMsg,
      failureContext: '[external-session] Failed to persist active-process user message',
      lastActiveAt: admissionActivityAt,
    });
    if (activeProcess.exited || getExternalActiveProcess() !== activeProcess) {
      return { queued: true };
    }
    runtimeDispatchStarted = true;
    await activeRuntime.sendMessage(activeProcess, text, hasImages ? resolvedImages : undefined);
    return { queued: true };
  } catch (err) {
    if (
      !runtimeDispatchStarted
      && turnAdmissionActivated
      && (
        getExternalUserRequestedStop()
        || getExternalActiveProcess() !== activeProcess
      )
    ) {
      return { queued: true };
    }
    if (err instanceof ExternalTurnPromotionCanceledError) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return { queued: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (runtimeDispatchStarted) {
      const stopped = await stopExternalSession({ preserveQueue: true });
      if (!stopped && hasExternalRuntimeProcess()) {
        if (dispatchPromotion) {
          finishExternalTurnPromotion(dispatchPromotion, {
            status: 'termination-unconfirmed',
          });
        }
        return {
          queued: false,
          error: `${msg}; external runtime process termination could not be confirmed`,
          terminationUnconfirmed: true,
        };
      }
      if (dispatchPromotion) {
        finishExternalTurnPromotion(dispatchPromotion, { status: 'terminated' });
      }
    } else if (turnAdmissionActivated) {
      finalizeAcceptedExternalFailure(msg);
      clearWatchdog();
      clearExternalTurnStartTime();
      resetTurnAccumulators();
      clearExternalTurnTrace();
      setExternalSessionState('error');
    } else if (dispatchPromotion) {
      finishExternalTurnPromotion(dispatchPromotion);
      clearExternalTurnActivityFacts(activityFacts);
    } else if (!runtimeDispatchStarted) {
      if (context?.queueId) clearExternalTurnBinding(context.queueId);
      clearExternalTurnActivityFacts(activityFacts);
    }
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'send_failed',
      errorMessage: msg,
    });
    return { queued: false, error: msg };
  }
}

async function steerExternalMessageForDesktop(input: {
  queueId: string;
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  userMsg: SessionMessage;
}): Promise<{ queued: boolean; error?: string }> {
  const active = getExternalActiveSteerPair();
  if (!active) {
    return sendExternalMessage(
      input.text,
      input.images,
      input.context.permissionMode,
      input.context.model,
      input.context,
      input.userMsg,
      () => {
        setExternalSessionState('running');
        broadcast('queue:started', {
          queueId: input.queueId,
          sessionId: input.context.sessionId,
          userMessage: {
            id: input.userMsg.id,
            role: input.userMsg.role,
            content: input.text,
            timestamp: input.userMsg.timestamp,
            attachments: input.userMsg.attachments,
          },
        });
      },
    );
  }

  let resolvedImages: ResolvedImagePayload[] | undefined;
  try {
    resolvedImages = resolveImagePayloads(input.context.sessionId, input.images);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[external-session] failed to resolve realtime steer image attachments:', err);
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { queued: false, error: message };
  }

  const guarded = await evaluateExternalDispatchGuard(input.context.beforeDispatch);
  if (!guarded.accepted) {
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { queued: false, error: guarded.error };
  }

  registerPendingRealtimeSteeredUserMessage({
    queueId: input.queueId,
    sessionId: input.context.sessionId,
    userMsg: input.userMsg,
    text: input.text,
    activityFacts: {
      origin: input.context.analyticsOrigin ?? originFromTurnAttribution({
        source: input.context.analyticsSource ?? input.context.scenario.type,
        scenarioType: input.context.scenario.type,
        desktopSurface: input.context.scenario.type === 'desktop'
          ? input.context.scenario.surface
          : undefined,
        inboxMeta: input.context.inboxMeta,
      }),
      inputText: input.text,
      systemMaintenanceKind: getSessionMetadata(input.context.sessionId)?.systemMaintenanceKind,
    },
  });
  try {
    await active.runtime.steerMessage(
      active.process,
      input.text,
      resolvedImages && resolvedImages.length > 0 ? resolvedImages : undefined,
      { clientUserMessageId: input.userMsg.id },
    );
    return { queued: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[external-session] realtime steer failed, retracting user message ${input.userMsg.id}: ${message}`);
    forgetPendingRealtimeSteeredUserMessage(input.userMsg.id);
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { queued: false, error: message };
  }
}

/**
 * Desktop /chat/send entry — fire-and-forget dispatch with proper serialization.
 *
 * Issue #188:
 *   sendExternalMessage internally awaits waitForExternalSessionIdle(5*60s)
 *   to serialize against an in-flight turn. The Rust SSE proxy's overall HTTP
 *   timeout is 120s, so directly awaiting sendExternalMessage from the HTTP
 *   handler made the request die with the proxy's generic "操作超时" error,
 *   which the renderer surfaced as "AI 调用失败：网络错误". This helper
 *   decouples the HTTP response from runtime dispatch:
 *
 *   1. Return a queue id synchronously so the renderer can show/reconcile a
 *      queue pill while dispatch happens outside the HTTP request lifetime.
 *   2. Chain the actual sendExternalMessage onto a module-level promise tail
 *      so concurrent desktop sends serialize against each other. Without this
 *      tail, multiple sends would all wake from the same turnCompleted gate
 *      simultaneously, overwrite earlyBroadcastedUserMsg, and double-write
 *      to the persistent-runtime stdin.
 *   3. Realtime Codex steering still promotes the pill only after Codex emits
 *      its native userMessage echo; turn/steer RPC success is transport ack,
 *      not runtime-consumption ack.
 *   4. Return the dispatch promise. Callers should fire-and-forget and
 *      surface failures via chat:agent-error since the HTTP response is
 *      already on its way back to the renderer.
 */
export function enqueueExternalSendForDesktop(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext,
): {
  queued: boolean;
  queueId?: string;
  isInFlight?: boolean;
  deliveryMode?: 'realtime' | 'turn';
  canCancel?: boolean;
  canForceExecute?: boolean;
  dispatch: Promise<ExternalSendResult>;
} {
  const queueResponseMode = context.turnBoundaryOnly
    ? 'turn'
    : resolveChatQueueResponseMode(loadAdminConfig().chatQueueResponseMode, true);
  const canSteerActiveTurn = getExternalActiveSteerPair() !== null;
  // Mid-turn defer: turn-level external runtimes hold this as a queue pill
  // instead of starting a 2nd turn. Codex app-server can append to the active
  // turn via turn/steer, but only in realtime mode and only when no earlier
  // queued work would be jumped.
  // Return the queueId SYNCHRONOUSLY so /chat/send can hand it back to the renderer, which
  // reconciles its optimistic `opt-` pill with this real queueId (exactly like the builtin
  // path) — without it the optimistic pill would orphan + a stray bubble would appear.
  if (shouldQueueExternalDesktopSend(getExternalLifecycleState(), {
    responseMode: queueResponseMode,
    canSteerActiveTurn,
  })) {
    const runtimeConfig = captureExternalRuntimeConfigSnapshot(model, permissionMode, context);
    const queued = enqueueExternalMessageOperation({
      text,
      images,
      context: applySnapshotToExternalSendContext(context, runtimeConfig),
      runtimeConfig,
      queueId: context.queueId,
    });
    if (!queued.queued) {
      return { queued: false, dispatch: Promise.resolve({ queued: false, error: queued.error }) };
    }
    const queueId = queued.queueId;
    broadcast('queue:added', {
      queueId,
      messageText: text.slice(0, 100),
      isInFlight: false,
      deliveryMode: 'turn',
      canCancel: true,
      canForceExecute: true,
    });
    return {
      queued: true,
      queueId,
      deliveryMode: 'turn',
      canCancel: true,
      canForceExecute: true,
      dispatch: queued.dispatchAcceptance,
    };
  }

  if (queueResponseMode === 'realtime' && canSteerActiveTurn) {
    const queueId = context.queueId ?? nextExternalQueueId();
    const userMsg: SessionMessage = {
      id: nextExternalUserMessageId(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      attachments: sessionMessageAttachmentsFromImages(context.sessionId, images),
    };
    broadcast('queue:added', {
      queueId,
      messageText: text.slice(0, 100),
      isInFlight: true,
      deliveryMode: 'realtime',
      canCancel: false,
      canForceExecute: false,
    });
    const generation = getExternalOperationGeneration();
    const dispatch = chainExternalDesktopSend(
      () => steerExternalMessageForDesktop({
        queueId,
        text,
        images,
        context: { ...context, queueId },
        userMsg,
      }),
      generation,
    ).catch((err) => {
      if (isExternalQueueGenerationStaleError(err)) {
        return { queued: false };
      }
      throw err;
    });
    return {
      queued: true,
      queueId,
      isInFlight: true,
      deliveryMode: 'realtime',
      canCancel: false,
      canForceExecute: false,
      dispatch,
    };
  }

  // Idle path: surface + send immediately (unchanged behavior). No queueId — this becomes a
  // bubble, not a pill (the renderer only created an optimistic pill while streaming).
  const userMsg: SessionMessage = {
    id: nextExternalUserMessageId(),
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
    attachments: sessionMessageAttachmentsFromImages(context.sessionId, images),
  };
  if (!context.beforeDispatch) {
    earlyBroadcastedUserMsg = userMsg;
    broadcast('chat:message-replay', createLiveUserMessageReplay(context.sessionId, userMsg));
  }

  const runtimeConfig = captureExternalRuntimeConfigSnapshot(model, permissionMode, context);
  const sendContext = applySnapshotToExternalSendContext(
    { ...context, queueId: context.queueId ?? nextExternalQueueId() },
    runtimeConfig,
  );
  const generation = getExternalOperationGeneration();
  const dispatch = chainExternalDesktopSend(
    () => sendExternalMessage(
      text,
      images,
      runtimeConfig.permissionMode,
      runtimeConfig.model,
      sendContext,
      context.beforeDispatch ? undefined : userMsg,
    ),
    generation,
  ).catch((err) => {
    if (isExternalQueueGenerationStaleError(err)) {
      return { queued: false };
    }
    throw err;
  });
  return { queued: true, dispatch };
}

/**
 * Turn-end drain (one item) — surface the next queued message as a bubble (queue:started) and
 * send it (a fresh turn). Guarded by canDrainExternalQueue so it only fires when idle with a
 * pending item. Called via setTimeout(0) right after the turn-end idle so it never races
 * chat:message-complete on the SSE wire (see persistTurnResult idle-ordering notes).
 */
function drainExternalQueueAfterTurn(): void {
  if (!canDrainExternalOperations(getExternalLifecycleState())) return;
  void drainExternalOperationsAfterTurn();
}

async function drainExternalOperationsAfterTurn(): Promise<void> {
  if (!canDrainExternalOperations(getExternalLifecycleState())) return;
  const drainGeneration = getExternalOperationGeneration();
  setExternalOperationDrainInFlight(true);
  let reservedItem: ReturnType<typeof reserveExternalOperationForDrain> | undefined;
  try {
    const leadingConfig = consumeLeadingExternalConfigOps();
    if (leadingConfig) {
      const applyResult = await applyExternalRuntimeConfigAtBoundary(leadingConfig.patch, leadingConfig.source);
      if (!isCurrentExternalOperationGeneration(drainGeneration)) {
        return;
      }
      if (applyResult.error) {
        const message = `External runtime config apply failed: ${applyResult.error}`;
        console.error(`[external-session] ${message}`);
        broadcast('chat:agent-error', { message });
        clearExternalQueueWithCancellation();
        setExternalSessionState('idle');
        return;
      }
    }

    const item = reserveExternalOperationForDrain();
    reservedItem = item;
    if (!item) return;
    if (!isCurrentExternalOperationGeneration(drainGeneration)) {
      return;
    }
    if (item.kind === 'config') {
      releaseExternalDrainReservation(item);
      reservedItem = undefined;
      unshiftExternalOperation(item);
      setTimeout(drainExternalQueueAfterTurn, 0);
      return;
    }

    const userMsg: SessionMessage = {
      id: nextExternalUserMessageId(),
      role: 'user',
      content: item.text,
      timestamp: new Date().toISOString(),
      attachments: sessionMessageAttachmentsFromImages(item.context.sessionId, item.images),
    };
    try {
      const result = await chainExternalDesktopSend(
        () => sendExternalMessage(
          item.text,
          item.images,
          item.runtimeConfig.permissionMode,
          item.runtimeConfig.model,
          item.context,
          userMsg,
          () => {
            setExternalSessionState('running');
            setExternalOperationDrainInFlight(false);
            broadcast('queue:started', {
              queueId: item.queueId,
              sessionId: item.context.sessionId,
              userMessage: {
                id: userMsg.id,
                role: 'user',
                content: item.text,
                timestamp: userMsg.timestamp,
                attachments: userMsg.attachments,
              },
            });
          },
        ),
        drainGeneration,
      );
      if (!isCurrentExternalOperationGeneration(drainGeneration)) return;
      settleExternalMessageOperation(item, result ?? { queued: false });
      if (result && !result.queued && !result.terminationUnconfirmed) {
        rollbackReservedExternalTurnAfterDrainFailure();
        broadcast('queue:cancelled', { queueId: item.queueId });
      }
    } catch (err) {
      if (isExternalQueueGenerationStaleError(err)) {
        settleExternalMessageOperation(item, { queued: false });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        settleExternalMessageOperation(item, { queued: false, error: message });
        rollbackReservedExternalTurnAfterDrainFailure();
        broadcast('queue:cancelled', { queueId: item.queueId });
      }
    }
    releaseExternalDrainReservation(item);
    reservedItem = undefined;
  } finally {
    releaseExternalDrainReservation(reservedItem);
    if (isExternalOperationDrainInFlight()) {
      setExternalOperationDrainInFlight(false);
    }
  }
}

/**
 * Force-execute a queued external item ("立即发送"): move it to the FRONT, then run it ASAP.
 * Three cases:
 *   - running + runtime CAN interrupt a turn (Codex `interruptTurn`): interrupt now → the
 *     resulting turn/completed → turn_complete → persistTurnResult → idle → drain runs it
 *     immediately (true force). Process stays alive.
 *   - running + runtime CANNOT interrupt mid-turn (Claude Code `-p`; Gemini until its
 *     session/cancel→turn-end flow is verified): DEGRADE to move-to-front — the item is now
 *     first, so the NATURAL turn-end drain runs it next (not truly "immediate", but it does
 *     run, ahead of everything else). drainExternalQueueAfterTurn() is a no-op here (state is
 *     'running'); the turn-end hook handles it.
 *   - idle (no turn in flight): drain directly now.
 * Mirrors the builtin forceExecuteQueueItem (move-to-front + interrupt; turn-end drain surfaces).
 */
export async function forceExecuteExternalQueueItem(queueId: string): Promise<boolean> {
  if (!moveExternalQueuedMessageToFront(queueId)) return false;
  const active = getExternalActivePair();
  if (getExternalLifecycleState() === 'running' && active && active.runtime.interruptTurn) {
    await active.runtime.interruptTurn(active.process);
  } else {
    // Idle → drain now. Running-without-interrupt → no-op; the moved-to-front item runs at the
    // next turn-end drain.
    drainExternalQueueAfterTurn();
  }
  return true;
}

export type ExternalQueueCancellation = {
  cancelledText: string;
  promotion?: ExternalTurnPromotionToken;
};

/** Cancel a queued external item (the pill ✕). Returns its settlement when startup is in flight. */
export function cancelExternalQueueItem(queueId: string): ExternalQueueCancellation | null {
  if (isExternalTurnCurrent(queueId)) return null;
  const text = cancelExternalQueuedMessage(queueId);
  if (text === null) {
    const promotion = cancelExternalTurnPromotionByQueueId(queueId, { preserveQueue: true });
    if (!promotion) return null;
    broadcast('queue:cancelled', { queueId });
    return { cancelledText: '', promotion };
  }
  broadcast('queue:cancelled', { queueId });
  return { cancelledText: text };
}

export function cancelExternalQueuedTurnsByOwner(
  owner: import('../session-core/turn-queue').TurnOwner,
): { count: number; promotion?: ExternalTurnPromotionToken } {
  const queueIds = cancelExternalQueuedMessagesByOwner(owner);
  const promotion = cancelExternalTurnPromotionByOwner(owner, { preserveQueue: true });
  for (const queueId of queueIds) broadcast('queue:cancelled', { queueId });
  return {
    count: queueIds.length + (promotion ? 1 : 0),
    ...(promotion ? { promotion } : {}),
  };
}

export function hasExternalQueuedTurnByOwner(
  owner: import('../session-core/turn-queue').TurnOwner,
): boolean {
  return hasExternalQueuedMessageByOwner(owner);
}

/** Current external queue (for /chat/queue/status). Mirrors builtin getQueueStatus shape. */
export function getExternalQueueStatus(): Array<{ id: string; messagePreview: string }> {
  return getExternalQueueStatusSnapshot();
}

/**
 * Respond to a permission request from the external runtime.
 * @param decision - 'deny' | 'allow_once' | 'always_allow'
 *   For CC: always_allow includes updatedPermissions from the original permission_suggestions
 *   so CC persists the rule and won't re-prompt for the same tool.
 */
export async function respondExternalPermission(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow',
  reason?: string,
): Promise<boolean> {
  const active = getExternalActivePair();
  if (!active) {
    console.warn('[external-session] No active process for permission response');
    return false;
  }
  const pending = getExternalInteractiveRequest(requestId);
  if (pending?.type !== 'permission:request') {
    console.warn(`[external-session] Unknown permission requestId: ${requestId}`);
    return false;
  }
  // Peek first; consume/delete only after runtime delivery succeeds so a transient
  // stdin/process write failure does not make the approval impossible to retry.
  const suggestions = getExternalPermissionSuggestions(requestId);
  console.log(`[external-session] Permission response: ${decision} for requestId=${requestId}${suggestions?.length ? `, with ${suggestions.length} suggestion(s)` : ''}`);
  await active.runtime.respondPermission(active.process, requestId, decision, reason, suggestions);
  consumeExternalPermissionSuggestions(requestId);
  deleteExternalInteractiveRequest(requestId);
  broadcastExternalInteractiveExpired(requestId, pending, 'resolved');
  return true;
}

/**
 * Whether an outstanding external AskUserQuestion request is tracked for this requestId.
 * Used by the HTTP layer to route /api/ask-user-question/respond to the external runtime
 * when the request originated from CC (rather than the builtin SDK handler).
 */
export function hasPendingExternalAskUserQuestion(requestId: string): boolean {
  return hasExternalAskUserQuestion(requestId);
}

/**
 * Deliver the user's AskUserQuestion answers (or a cancellation) back to the external runtime.
 * For CC: allow the tool call with `updatedInput = { ...original, answers }`, or deny on cancel.
 */
export async function respondExternalAskUserQuestion(
  requestId: string,
  answers: Record<string, string> | null,
): Promise<boolean> {
  const pending = getExternalAskUserQuestion(requestId);
  if (!pending) {
    console.warn(`[external-session] Unknown AskUserQuestion requestId: ${requestId}`);
    return false;
  }
  // Check process liveness BEFORE consuming the pending entry (cross-review C4):
  // previously we deleted up front, so a transient "process gone" state silently
  // discarded the answer and left the user with no affordance to retry. Keeping
  // the entry when we can't deliver lets the caller observe the failure and the
  // routing layer keep sending it to the external handler, not the builtin one.
  const active = getExternalActivePair();
  if (!active) {
    console.warn(`[external-session] No active process for AskUserQuestion response requestId=${requestId} — session likely stopped before user answered`);
    return false;
  }

  try {
    if (answers === null) {
      console.log(`[external-session] AskUserQuestion cancelled for requestId=${requestId}`);
      // PRD #131 — `interrupt: true` so AskUserQuestion cancel terminates
      // the whole assistant turn rather than only this single tool call.
      // Without it, CC keeps the turn alive and the model just calls
      // another tool, defeating the user's "I'm stopping this" intent.
      // Mirrors the builtin canUseTool path in agent-session.ts.
      await active.runtime.respondPermission(
        active.process,
        requestId,
        'deny',
        '用户取消了问答',
        undefined,
        undefined,
        true,
      );
    } else {
      console.log(`[external-session] AskUserQuestion answered for requestId=${requestId}`);
      // CC is the same SDK 0.3.158 binary as builtin: it looks answers up by
      // question TEXT, so alias the renderer's index-keyed answers (see
      // withQuestionTextAnswerKeys). The superset keeps the original id/index
      // keys intact, so Codex's own response builder (codex.ts) is unaffected.
      const askQuestions = (pending.input as { questions?: AskUserQuestion[] }).questions;
      const updatedInput = { ...pending.input, answers: withQuestionTextAnswerKeys(askQuestions, answers) };
      await active.runtime.respondPermission(active.process, requestId, 'allow_once', undefined, undefined, updatedInput);
    }
    // Delete only after successful delivery — if respondPermission throws
    // (e.g. stdin closed mid-write) the caller can retry.
    const interactiveRequest = getExternalInteractiveRequest(requestId);
    deleteExternalAskUserQuestion(requestId);
    deleteExternalInteractiveRequest(requestId);
    broadcastExternalInteractiveExpired(requestId, interactiveRequest, 'resolved');
    return true;
  } catch (err) {
    console.error(`[external-session] respondPermission failed for requestId=${requestId}:`, err);
    return false;
  }
}

/**
 * Pattern D — IM trace-id-targeted cancellation for external runtimes.
 * For CC/Codex/Gemini we don't have a per-request granularity (the runtime
 * processes turns sequentially), so cancellation degenerates to "stop the
 * active session if `requestId` matches `activeRequestId`". Returns
 * { aborted, mode } same shape as the builtin `cancelImRequest`.
 */
export async function cancelExternalImRequest(
  requestId: string,
  _reason: string = 'user',
): Promise<{ aborted: boolean; mode: 'running' | 'queued' | 'unknown' }> {
  if (getExternalActiveRequestId() === requestId && isExternalSessionActive()) {
    console.log(`[external-session] cancelExternalImRequest requestId=${requestId} mode=running`);
    const stopped = await stopExternalSession();
    return { aborted: stopped, mode: stopped ? 'running' : 'unknown' };
  }
  return { aborted: false, mode: 'unknown' };
}

type ExternalStopReason = 'user' | 'config-restart';

/**
 * Stop the active external session.
 */
export async function stopExternalSession(options?: {
  reason?: ExternalStopReason;
  preserveQueue?: boolean;
}): Promise<boolean> {
  clearWatchdog();
  const preserveQueue = options?.preserveQueue === true;
  const canceledPromotion = cancelExternalTurnPromotion({ preserveQueue });
  const active = getExternalActivePair();
  const reason = options?.reason ?? 'user';
  const isConfigRestart = reason === 'config-restart';
  if (!active) {
    if (!canceledPromotion) {
      clearPendingExternalProcessConfigRestarts();
      return false;
    }
    const settlement = await canceledPromotion.settled;
    if (settlement.status === 'termination-unconfirmed') return false;
    if (settlement.status === 'terminated') return true;
    if (settlement.status === 'dispatched') {
      return getExternalActivePair()
        ? stopExternalSession(options)
        : true;
    }
    earlyBroadcastedUserMsg = null;
    clearExternalActiveRuntimeProcess();
    activeExternalEnvPolicy = undefined;
    clearExternalTurnStartTime();
    setExternalTurnCompleted(true);
    resetTurnAccumulators();
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'session_aborted',
      errorMessage: 'external runtime turn promotion was stopped before dispatch',
    });
    finalizeExternalActiveRequest('failed');
    if (!preserveQueue) {
      clearExternalQueueWithCancellation();
    } else {
      clearPendingRealtimeSteeredUserMessagesWithCancellation();
    }
    setExternalSessionState('idle');
    const completionTerminal = finalizeStoppedExternalTurn('', {}, !isConfigRestart);
    if (!isConfigRestart) {
      broadcast(
        'chat:message-stopped',
        withSessionCompletionTerminal(null, completionTerminal),
      );
    }
    if (preserveQueue && !isConfigRestart) {
      setTimeout(drainExternalQueueAfterTurn, 0);
    }
    clearPendingExternalProcessConfigRestarts();
    return true;
  }
  const stopStarted = nowMs();
  const runtimeType = active.runtime.type;
  const pid = active.process.pid;
  emitPerfTrace({
    trace: 'runtime',
    phase: 'stop_start',
    runtime: runtimeType,
    sessionId: getExternalLifecycleSessionId() || undefined,
    status: 'ok',
    detail: { pid },
  });
  // #307: mark this teardown as intentional BEFORE killing the process, so the
  // session_complete the kill triggers is recognized as an abort (not a failure)
  // and its error banner is suppressed. Set before the await — the exit handler
  // can fire its session_complete during stopSession().
  markExternalUserRequestedStop();
  let gracefulError: unknown;
  try {
    await active.runtime.stopSession(active.process);
  } catch (err) {
    gracefulError = err;
    console.error('[external-session] Error stopping session:', err);
    emitPerfTrace({
      trace: 'runtime',
      phase: 'stop_escalated',
      durationMs: elapsedMs(stopStarted),
      runtime: runtimeType,
      sessionId: getExternalLifecycleSessionId() || undefined,
      status: 'error',
      detail: { pid, error: err instanceof Error ? err.message : String(err) },
    });
  }

  let confirmedStopped = active.process.exited;
  if (!confirmedStopped) {
    // Runtime stop either failed or returned before the process exited. Bound
    // the fallback via killWithEscalation: 2s graceful -> 1s hard -> orphan.
    const proc = active.process;
    const killResult = await killWithEscalation(
      {
        pid: proc.pid,
        exited: proc.exited,
        kill: (signal) => {
          // RuntimeProcess.kill accepts number; map signal names to SIGTERM/SIGKILL ints.
          const num = typeof signal === 'string'
            ? (signal === 'SIGKILL' ? 9 : 15)
            : (signal ?? 15);
          proc.kill(num);
        },
        waitForExit: () => proc.waitForExit(),
      },
      {
        gracefulMs: 2000,
        hardMs: 1000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') console.warn(`[external-session] catch fallback orphan pid=${info.pid}`);
        },
      },
    );
    emitPerfTrace({
      trace: 'runtime',
      phase: 'stop_fallback_done',
      durationMs: elapsedMs(stopStarted),
      runtime: runtimeType,
      sessionId: getExternalLifecycleSessionId() || undefined,
      status: killResult.exited ? 'ok' : 'error',
      detail: {
        pid,
        exited: killResult.exited,
        signalUsed: killResult.signalUsed ?? null,
        orphanRisk: killResult.orphanRisk,
        killElapsedMs: killResult.elapsedMs,
      },
    });
    confirmedStopped = killResult.exited;
  }

  if (!confirmedStopped) {
    console.error(
      `[external-session] Runtime process ${pid} is still alive after stop escalation`,
      gracefulError,
    );
    return false;
  }

  emitPerfTrace({
    trace: 'runtime',
    phase: 'stop_done',
    durationMs: elapsedMs(stopStarted),
    runtime: runtimeType,
    sessionId: getExternalLifecycleSessionId() || undefined,
    status: 'ok',
    detail: { pid },
  });
  const completionTerminal = finalizeStoppedExternalTurn(
    currentExternalTurnTextSnapshot(),
    consumeExternalTurnMetrics(),
    !isConfigRestart,
  );
  finalizeExternalLiveAssistantInMemory();
  resetTurnAccumulators();
  clearExternalActiveRuntimeProcess();
  clearPendingExternalProcessConfigRestarts();
  activeExternalEnvPolicy = undefined;
  // Any pre-warm that raced with a stop is no longer relevant. Keeping the
  // flag around would leak 'prewarm' into a subsequent session's session_init.
  clearExternalPrewarmingSession();
  clearExternalPermissionSuggestions();
  drainPendingInteractiveRequestsAsExpired('stop');
  setExternalSystemInitPayload(null);
  if (!isConfigRestart) {
    fireExternalImCallback('cancelled', buildImCancelledPayload());
    finalizeExternalActiveRequest('failed');
    deliverExternalWatchError({
      sessionId: getExternalLifecycleSessionId(),
      text: currentExternalTurnTextSnapshot(),
      errorCode: 'session_aborted',
      errorMessage: 'external runtime session was stopped before turn completed',
    });
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'session_aborted',
      errorMessage: 'external runtime session was stopped before turn completed',
    });
  }
  if (!preserveQueue) {
    clearExternalQueueWithCancellation();
  } else {
    clearPendingRealtimeSteeredUserMessagesWithCancellation();
  }
  setExternalSessionState('idle');
  if (!isConfigRestart) {
    broadcast(
      'chat:message-stopped',
      withSessionCompletionTerminal(null, completionTerminal),
    );
  }
  if (preserveQueue && !isConfigRestart) {
    setTimeout(drainExternalQueueAfterTurn, 0);
  }
  emitExternalTurnTrace('final', {
    status: isConfigRestart ? 'ok' : 'error',
    detail: { source: 'stop_external_session', reason },
  });
  clearExternalTurnTrace();
  return true;
}

/** True only while a real external-runtime turn is in flight. */
export function isExternalSessionActive(): boolean {
  return isExternalTurnBusy();
}

/**
 * True when an external runtime process is still alive, even if no turn is
 * currently running. Persistent runtimes such as Codex app-server keep an idle
 * process around after a turn completes; session-boundary operations must stop
 * that process too, not only `isExternalSessionActive()` running turns.
 */
export function hasExternalRuntimeProcess(): boolean {
  const process = getExternalActiveProcess();
  return Boolean(process && !process.exited);
}

/**
 * Truncate `allSessionMessages` at the given user message id and persist the
 * truncation. Returns the popped user message's content + attachments so the
 * caller can re-send.
 *
 * External-runtime equivalent of builtin `rewindSession()`. Used by the
 * retry button when the previous turn failed (e.g. model capacity). External
 * runtimes don't support /chat/rewind because there's no SDK resume anchor /
 * file checkpoint to roll back, but a "drop the failed user turn + resend"
 * semantic is still sound: the failed turn never produced an assistant
 * message (persistTurnResult only fires on subtype=success), so the local
 * history just has a dangling user message at the tail.
 *
 * Caller is responsible for invoking sendExternalMessage with the returned
 * content. We don't do the resend here so the existing send path's
 * MCP/agents/model wiring stays the single source of truth.
 *
 * Refuses if a turn is currently in flight — the user must abort first.
 */
export async function popLastUserMessageForRetry(userMessageId: string): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: SessionMessage['attachments'];
}> {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!lifecycleSessionId) {
    return { success: false, error: 'No active external session' };
  }
  if (isExternalSessionActive()) {
    return { success: false, error: 'Cannot retry while a turn is in progress' };
  }
  return truncateExternalTranscriptForRetry(lifecycleSessionId, userMessageId);
}

/**
 * Pre-warm an external runtime process so the first user message skips the
 * cold-start cost (spawn + `initialize` + `session/new` + prompt-file write).
 *
 * Called from the `/api/runtime/prewarm` HTTP endpoint when the frontend opens
 * a Chat tab whose runtime is Gemini or Codex (both persistent JSON-RPC
 * processes). Claude Code's `-p` mode exits after every turn, so pre-warming
 * it is wasted work — the endpoint gates that out before reaching this path.
 *
 * Flow:
 *   1. Bail out if a session is already active (pre-warm is idempotent).
 *   2. Call startExternalSession with NO initialMessage — the runtime spawns
 *      the CLI, does its handshake, opens a session, and then sits idle.
 *   3. First real user message hits sendExternalMessage Case 3 (process alive)
 *      and writes directly to stdin via activeRuntime.sendMessage — no cold
 *      boot.
 *
 * The startExternalSession `startingPromise` guard serializes pre-warm against
 * any concurrent send, so a user who sends a message before pre-warm finishes
 * spawning is safely queued behind it.
 */
/**
 * Resolve the permission mode pre-warm should resume an existing EXTERNAL session
 * with. The renderer fires `/api/runtime/prewarm` at Tab-open, often BEFORE its
 * session-snapshot→input-state sync has run — so the caller-supplied mode can be
 * a generic default (e.g. `'auto'`, which isn't even a Codex mode and maps to the
 * prompting `on-request` policy). For a session with a persisted snapshot, the
 * SESSION METADATA is the authority for what the resumed runtime process must run
 * at; trusting the racy caller value instead resumes the thread with the wrong
 * approval policy, and because pre-warm has already created the live process the
 * first user message reuses it (sendExternalMessage Case 3) without re-resuming —
 * so the wrong mode sticks while the UI pill later converges to the (correct)
 * snapshot. Prefer the snapshot; fall back to the caller's value only for
 * brand-new sessions with no persisted mode yet.
 *
 * (Builtin runtimes are handled separately via resolveWorkspaceConfig; this is
 * the external-runtime analog, scoped to external because Codex/Gemini modes
 * differ from the builtin auto/plan/fullAgency set.)
 */
export function resolvePrewarmPermissionMode(
  metaPermissionMode: string | undefined,
  callerPermissionMode: string | undefined,
): string | undefined {
  return metaPermissionMode ?? callerPermissionMode;
}

export async function prewarmExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  model?: string;
  permissionMode?: string;
}): Promise<{ prewarmed: boolean; reason?: string }> {
  const runtimeType = getCurrentRuntimeType();
  const start = nowMs();
  emitPerfTrace({
    trace: 'runtime',
    phase: 'prewarm_start',
    runtime: runtimeType,
    sessionId: options.sessionId,
  });
  // Only Gemini and Codex run as persistent JSON-RPC processes — pre-warming
  // CC's `-p` mode is wasted because the process exits after each turn.
  if (runtimeType !== 'gemini' && runtimeType !== 'codex') {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'not_persistent' },
    });
    return { prewarmed: false, reason: `Pre-warm not applicable for runtime=${runtimeType}` };
  }
  // Already running/starting a turn — pre-warm is advisory and must not interrupt it.
  if (isExternalSessionActive() || isExternalLifecycleRunning() || isExternalLifecycleStarting()) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'already_active_or_starting' },
    });
    return { prewarmed: false, reason: 'Session already active or starting' };
  }
  // Cross-runtime guard — refuse to warm a session whose persisted metadata
  // names a different runtime. Frontend Chat.tsx also guards this, but the
  // frontend's sessionRuntime is populated async via loadSession, so the
  // effect may fire before that state settles. Backend check uses the
  // authoritative source (SessionStore) and closes the race-window hole.
  const meta = getSessionMetadata(options.sessionId);
  if (meta?.runtime && meta.runtime !== runtimeType) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'runtime_mismatch' },
    });
    return { prewarmed: false, reason: `Session runtime mismatch: persisted=${meta.runtime}, current=${runtimeType}` };
  }
  if (meta?.runtime) {
    const persistedRuntimeSource = normalizeRuntimeSourceForRuntime(meta.runtime, meta.runtimeSource);
    const currentRuntimeSource = normalizeRuntimeSourceForRuntime(runtimeType, getCurrentRuntimeSource());
    if (persistedRuntimeSource !== currentRuntimeSource) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'prewarm_skipped',
        runtime: runtimeType,
        sessionId: options.sessionId,
        durationMs: elapsedMs(start),
        status: 'skipped',
        detail: { reason: 'runtime_source_mismatch' },
      });
      return {
        prewarmed: false,
        reason: `Session runtime source mismatch: persisted=${persistedRuntimeSource ?? 'none'}, current=${currentRuntimeSource ?? 'none'}`,
      };
    }
  }

  const activeProcess = getExternalActiveProcess();
  if (activeProcess && !activeProcess.exited) {
    if (isExternalSessionStateRestoredFor(options.sessionId)) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'prewarm_skipped',
        runtime: runtimeType,
        sessionId: options.sessionId,
        durationMs: elapsedMs(start),
        status: 'skipped',
        detail: { reason: 'already_warm' },
      });
      return { prewarmed: false, reason: 'Session already warm' };
    }
    await stopExternalSession();
  }

  // Pick resume ID if restoreExternalSessionState populated one — but only if
  // it actually belongs to this session. lastRuntimeSessionId is module-level
  // state that can carry over from a previous session in Handover scenario 4,
  // or simply be stale if restoreExternalSessionState hasn't run yet for this
  // sessionId. Using a mismatched resume ID would produce "No conversation
  // found" from the CLI and wipe user intent.
  const resumeSessionId = (getExternalLifecycleSessionId() === options.sessionId && getExternalRuntimeSessionId())
    ? getExternalRuntimeSessionId()
    : undefined;

  // The session snapshot is authoritative for the resumed process's permission
  // mode — NOT the renderer's racy prewarm payload (which can be a stale default
  // like 'auto' before the Tab's snapshot sync runs). Without this, pre-warm
  // resumes Codex with the wrong approvalPolicy and the first send reuses the
  // pre-warmed process (Case 3) without re-resuming, so it sticks.
  const effectivePermissionMode = resolvePrewarmPermissionMode(meta?.permissionMode, options.permissionMode);

  console.log(`[external-session] Pre-warming ${runtimeType} for session ${options.sessionId}${resumeSessionId ? ` (resume=${resumeSessionId})` : ' (fresh)'} permissionMode=${effectivePermissionMode ?? '(default)'}${meta?.permissionMode && meta.permissionMode !== options.permissionMode ? ` (snapshot override; caller sent ${options.permissionMode ?? '(none)'})` : ''}`);

  try {
    await startExternalSession({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      // initialMessage intentionally omitted — this is the pre-warm signal
      model: options.model,
      permissionMode: effectivePermissionMode,
      scenario: options.scenario,
      resumeSessionId,
    });
  } catch (error) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_done',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'error',
    });
    throw error;
  }

  emitPerfTrace({
    trace: 'runtime',
    phase: 'prewarm_done',
    runtime: runtimeType,
    sessionId: options.sessionId,
    durationMs: elapsedMs(start),
    status: 'ok',
  });

  return { prewarmed: true };
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(
  runtimeType: RuntimeType,
  options: { runtimeSource?: import('../../shared/types/runtime').RuntimeSource } = {},
): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  const runtimeSource = runtimeType === 'codex' ? options.runtimeSource : undefined;
  try {
    return await queryRuntimeModelsSingleFlight(runtimeType, async () => {
      const runtime = getExternalRuntime(runtimeType);
      return await runtime.queryModels({ runtimeSource });
    }, runtimeSource);
  } catch (err) {
    console.error(`[external-session] Failed to query models for ${runtimeType}:`, err);
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: shared turn finalization (used by both turn_complete and session_complete) ───

/** Flush accumulated content blocks, persist to SessionStore, and broadcast completion.
 * Called by both turn_complete (Codex) and session_complete (CC) to avoid duplication. */
async function persistTurnResult(terminalGeneration: number): Promise<void> {
  // Defense-in-depth: the `session_complete` handler reads `persistInFlight`
  // to decide whether to fire `setExternalSessionState('idle')` synchronously.
  // When persistInFlight=true, idle is deferred to this function. If we throw
  // BEFORE reaching the explicit setExternalSessionState('idle') below
  // (e.g. JSON.stringify on a circular currentContentBlocks, or
  // flushAllPending throws sync), the renderer would be stuck in `running`
  // forever for that session. Outer try/finally guarantees idle ALWAYS fires.
  // Caller still gets the error via the fire-and-forget `.catch` for logging.
  // v0.2.14 cross-bugfix follow-up.

  // PRD 0.2.18 Session Inbox — snapshot meta + hints SYNCHRONOUSLY at entry
  // and immediately clear the module slots, so a concurrent sendExternalMessage
  // arriving during the await chain below cannot overwrite them. Without this,
  // turn_complete sets turnCompleted=true and fires persistTurnResult
  // fire-and-forget; the busy gate at L1249 stops blocking; the next
  // sendExternalMessage runs L1265 (`currentTurnInboxMeta = next ?? null`)
  // before this turn's finally reads the meta — replying to the wrong caller
  // or losing the reply entirely (cross-review CC BLOCKER #1 + Codex Critical
  // #1 / Scenario 1+11).
  const { inboxMeta: turnInboxMeta, attachmentHints: turnAttachmentHints } = snapshotExternalTurnReplyState();
  const turnSucceededAtTerminal = didExternalLastTurnSucceed();
  const turnActivityFacts = getExternalTurnActivityFacts();
  const terminalActivityAt = turnActivityFacts
    && shouldRecordTerminalActivity(turnActivityFacts, { text: currentExternalTurnTextSnapshot() })
    ? new Date().toISOString()
    : undefined;
  // Terminal usage belongs to this turn. Consume it before the first await so
  // a degraded next-turn admission cannot reset or replace the mutable slot.
  const settledTurnUsage = consumeExternalTurnUsage();
  // PRD 0.2.32 — snapshot THIS turn's context usage at the SAME synchronous entry
  // as turnInboxMeta above, NOT after the `await awaitInFlightSaves()` further down.
  // turn_complete fires persistTurnResult fire-and-forget and flips turnCompleted;
  // the busy gate stops blocking, so a back-to-back sendExternalMessage can run
  // resetTurnAccumulators() (which nulls currentTurnContextUsage) inside this turn's
  // await window. Capturing here — before any await — makes it race-free, mirroring
  // the inbox-meta discipline. Null = no usage event this turn → persist must OMIT
  // the field (never write undefined, which would erase the prior persisted value).
  const turnContextUsage = getExternalCurrentTurnContextUsage();
  const turnAnalyticsSource = currentTurnAnalyticsSource ?? getExternalLifecycleAnalyticsSource();
  const lifecycleScenarioForOrigin = getExternalLifecycleScenario();
  const turnAnalyticsOrigin = currentTurnAnalyticsOrigin
    ?? getExternalLifecycleAnalyticsOrigin()
    ?? originFromTurnAttribution({
      source: turnAnalyticsSource,
      scenarioType: lifecycleScenarioForOrigin.type,
      desktopSurface: lifecycleScenarioForOrigin.type === 'desktop'
        ? lifecycleScenarioForOrigin.surface
        : undefined,
      inboxMeta: turnInboxMeta,
    });
  const persistTraceStarted = nowMs();
  let persistFailed = false;
  let persistFailureReason: string | undefined;
  let settledTurnDurationMs: number | undefined;
  let activityOwnedByTranscriptPersist = false;

  // PRD 0.2.18 Session Inbox — capture turn text BEFORE resetTurnAccumulators()
  // wipes it (cross-review CC + Architecture: the original impl read
  // `currentAssistantText` in the finally block AFTER reset → always empty for
  // structured-blocks turns, which is the common Codex/CC case). Build the
  // reply body from currentContentBlocks (preferred — captures all text blocks
  // even if streamed via deltas) with currentAssistantText as fallback.
  let capturedReplyText = '';
  try {
    const turnStartTime = getExternalTurnStartTime();
    const turnDurationMs = turnStartTime ? Date.now() - turnStartTime : undefined;
    settledTurnDurationMs = turnDurationMs;
    flushAllPending();

    // Cross-review 0.2.33 (Codex W1) — snapshot THIS turn's content blocks and
    // assistant text at the same synchronous discipline as the entry snapshots
    // above (here = after flushAllPending, still before the first await). A
    // degraded send (turnFinalization.settled timeout in sendExternalMessage)
    // runs resetTurnAccumulators() during the await below; these were the LAST
    // un-snapshotted fields, so the worst case was silent loss of the previous
    // assistant message, not just stale ordering. The array is captured by
    // REFERENCE on purpose: reset reassigns (`currentContentBlocks = []`), so
    // the snapshot survives it, while in-place attachment patches during
    // awaitInFlightSaves() still land in the captured blocks.
    const turnContentSnapshot = captureExternalTurnContentSnapshot();
    capturedReplyText = getExternalTurnContentSnapshotText(turnContentSnapshot);

    // PRD 0.2.15 Review A4 fix — drain in-flight attachment saves so the
    // placeholder attachments embedded in the turn's content blocks get patched
    // BEFORE we snapshot to disk. Without this await, large/slow saves land
    // their `tool_attachment_update` after `currentContentBlocks = []` reset
    // and the disk JSON keeps the "生成中" placeholder forever.
    await awaitInFlightSaves();

    const usageData = settledTurnUsage;
    const turnToolCount = getExternalTurnContentSnapshotToolCount(turnContentSnapshot);
    const runtimeType = getCurrentRuntimeType();
    const runtimeSource = getCurrentRuntimeSource();
    // turnContextUsage was snapshotted at the synchronous function entry (above) to
    // survive a concurrent turn's resetTurnAccumulators() during the await window.

    // PRD 0.2.18 / 0.2.37 — capture turn text BEFORE resetTurnAccumulators
    // clears the source. Inbox send.result and session watch.completed both
    // read this in finally.
    // Reset only what we still own: if a degraded concurrent send already ran
    // resetTurnAccumulators(), the module global points at the NEW turn's
    // array — resetting again would wipe that turn's accumulating state.
    const resetIfStillOurs = () => {
      if (isExternalTurnContentSnapshotCurrent(turnContentSnapshot)) resetTurnAccumulators();
    };

    const persistedContent = getExternalTurnContentSnapshotPersistedContent(turnContentSnapshot);
    const lifecycleSessionId = getExternalLifecycleSessionId();
    activityOwnedByTranscriptPersist = true;
    const persistResult = await appendAndPersistExternalAssistantTurn({
      sessionId: lifecycleSessionId,
      content: persistedContent,
      durationMs: turnDurationMs,
      usage: usageData,
      toolCount: turnToolCount,
      // PRD 0.2.32 — persist this turn's context snapshot only when the runtime
      // reported one. Null omits the metadata key, preserving the previous value.
      contextUsage: turnContextUsage,
      lastActiveAt: terminalActivityAt,
    });
    if (persistResult.appendedAssistant) {
      resetIfStillOurs();
    }
    if (!persistResult.ok) {
      persistFailed = true;
      persistFailureReason = persistResult.failureReason;
      console.error(`[external-session] Failed to save session messages: ${persistFailureReason ?? 'unknown error'}`);
    }
    emitExternalTurnTrace('persist_done', {
      durationMs: elapsedMs(persistTraceStarted),
      status: persistFailed ? 'error' : 'ok',
      count: persistResult.messageCount,
      detail: {
        toolCount: turnToolCount,
        ...(persistFailureReason ? { reason: persistFailureReason } : {}),
      },
    });

    const completionTerminal = recordExternalCompletionTerminal(
      turnSucceededAtTerminal && !persistFailed ? 'complete' : 'error',
    );
    if (persistFailed) {
      if (isExternalTurnGenerationCurrent(terminalGeneration)) {
        setExternalLastTurnSucceeded(false);
      }
      const message = persistFailureReason
        ? `Failed to persist external runtime turn: ${persistFailureReason}`
        : 'Failed to persist external runtime turn';
      broadcast('chat:agent-error', { message });
      broadcast(
        'chat:message-error',
        withSessionCompletionTerminal(message, completionTerminal),
      );
    } else {
      broadcast('chat:message-complete', withSessionCompletionTerminal({
        ...(usageData ? {
          model: usageData.model,
          input_tokens: usageData.inputTokens,
          output_tokens: usageData.outputTokens,
          cache_read_tokens: usageData.cacheReadTokens,
          cache_creation_tokens: usageData.cacheCreationTokens,
        } : {}),
        ...(turnToolCount > 0 ? { tool_count: turnToolCount } : {}),
        ...(turnDurationMs ? { duration_ms: turnDurationMs } : {}),
      }, completionTerminal));
    }
    // PRD 0.2.19 — session_id joins back to renderer session_new for full funnel.
    // `lastSessionId` is typed `string` and bootstrap-initialized to `''`, so we
    // coerce empty to null here. Analytics tolerates null and groups those as
    // "pre-session" (negligible volume — only first turn before any id lands).
    const analyticsScenario = getExternalLifecycleScenario();
    trackServer('ai_turn_complete', {
      source: turnAnalyticsSource,
      ...originAnalyticsFields(turnAnalyticsOrigin),
      session_id: lifecycleSessionId || null,
      platform: analyticsScenario.type === 'im' ? analyticsScenario.platform : null,
      runtime: runtimeType,
      runtime_source: runtimeSource ?? null,
      model: usageData?.model || getExternalRuntimeLiveReportedModel() || getExternalRuntimeDesiredModel() || null,
      provider_name: externalRuntimeProviderName(runtimeType),
      api_protocol: null,
      provider_base_url: null,
      provider_api_protocol: null,
      input_tokens: usageData?.inputTokens ?? 0,
      output_tokens: usageData?.outputTokens ?? 0,
      cache_read_tokens: usageData?.cacheReadTokens ?? 0,
      cache_creation_tokens: usageData?.cacheCreationTokens ?? 0,
      tool_count: turnToolCount,
      duration_ms: turnDurationMs ?? 0,
    });

    // #296 — backend-owned auto session titling for external runtimes. Gate on a
    // real successful turn (`lastTurnSucceeded`), not just "persistTurnResult ran".
    // Fired through the `turn-hooks` leaf slot (dependency inversion) — see
    // turn-hooks.ts. Non-blocking + best-effort. External runtimes use CLI-owned
    // auth, so no providerEnv is passed.
    if (turnSucceededAtTerminal && !persistFailed && lifecycleSessionId) {
      firePostTurnTitleHook(lifecycleSessionId, runtimeType, getExternalRuntimeDesiredModel() || undefined, undefined);
    }
  } catch (error) {
    persistFailed = true;
    persistFailureReason = error instanceof Error ? error.message : String(error);
    if (isExternalTurnGenerationCurrent(terminalGeneration)) {
      setExternalLastTurnSucceeded(false);
    }
    throw error;
  } finally {
    if (terminalActivityAt && !activityOwnedByTranscriptPersist) {
      try {
        const sessionId = getExternalLifecycleSessionId();
        if (sessionId) await updateSessionMetadata(sessionId, { lastActiveAt: terminalActivityAt });
      } catch (error) {
        console.error('[external-session] failed to persist terminal activity after finalization error:', error);
      }
    }
    const finalizedTurnSucceeded = turnSucceededAtTerminal && !persistFailed;
    // PRD 0.2.18 Session Inbox — reply pushback for external runtime.
    // Use the meta/hints snapshotted at entry (NOT module-level slots, which
    // may have been overwritten by a concurrent sendExternalMessage during
    // the await chain above).
    if (turnInboxMeta) {
      // Use captured-before-reset text (PRD 0.2.18 cross-review fix). If reset
      // didn't actually fire (early throw path), fall back to currentAssistantText.
      const replyText = capturedReplyText || getExternalAssistantText().trim();
      const replyError = finalizedTurnSucceeded
        ? undefined
        : {
            code: 'turn_failed',
            message: 'external runtime turn did not complete successfully',
          };
      const sid = getExternalLifecycleSessionId();
      void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
        deliverInboxReply(sid, turnInboxMeta, {
          text: replyText,
          error: replyError,
          attachmentHints: turnAttachmentHints.length > 0 ? turnAttachmentHints : undefined,
        }),
      ).catch((err) =>
        console.error('[inbox] external turn-end reply pushback failed:', err),
      );
    }
    const lifecycleSessionId = getExternalLifecycleSessionId();
    if (lifecycleSessionId) {
      const watchText = capturedReplyText || getExternalAssistantText().trim();
      const watchError = finalizedTurnSucceeded
        ? undefined
        : {
            code: 'turn_failed',
            message: persistFailureReason ?? 'external runtime turn did not complete successfully',
          };
      void import('../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
        deliverSessionWatchEvents(lifecycleSessionId, {
          text: watchText,
          error: watchError,
          attachmentHints: turnAttachmentHints.length > 0 ? turnAttachmentHints : undefined,
        }),
      ).catch((err) =>
        console.error('[session-watch] external turn-end watch push failed:', err),
      );
    }

    notifyExternalTurnOutcome(terminalGeneration, {
      success: finalizedTurnSucceeded,
      text: capturedReplyText || getExternalAssistantText().trim(),
      ...(settledTurnDurationMs !== undefined ? { durationMs: settledTurnDurationMs } : {}),
      ...(settledTurnUsage ? {
        usage: {
          inputTokens: settledTurnUsage.inputTokens,
          outputTokens: settledTurnUsage.outputTokens,
        },
      } : {}),
      ...(persistFailureReason ? { error: persistFailureReason } : {}),
    });
    clearExternalTurnActivityFacts(turnActivityFacts);

    // Always reach idle, even if the body above threw. The
    // session_complete handler counts on us to drain the deferred idle.
    setExternalSessionState('idle');
    if (finalizedTurnSucceeded) {
      fireExternalImCallback(
        'complete',
        buildImCompletePayload(capturedReplyText || getExternalAssistantText().trim()),
      );
    } else {
      fireExternalImCallback(
        'error',
        buildImErrorPayload(persistFailureReason ?? 'external runtime turn did not complete successfully'),
      );
    }
    // Pattern B/C: turn complete — clear active trace ID + unregister from registry.
    finalizeExternalActiveRequest(finalizedTurnSucceeded ? 'completed' : 'failed');
    await applyPendingExternalProcessConfigInvalidation();
    // Mid-turn queue drain: a turn just ended (completed OR interrupted via force) → surface +
    // send the next queued desktop message. Deferred to the next macrotask so queue:started
    // never races chat:message-complete / chat:status idle on the SSE wire.
    setTimeout(() => drainExternalQueueAfterTurn(), 0);
    clearExternalTurnTrace();
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

async function normalizeExternalToolResultForSse(
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
): Promise<Extract<UnifiedEvent, { kind: 'tool_result' }>> {
  const spilled = await maybeSpill(event.content, {
    mimetype: 'text/plain; charset=utf-8',
    sessionId: getExternalLifecycleSessionId() || undefined,
  });
  if ('inline' in spilled) {
    return event;
  }
  return {
    ...event,
    content: spilled.preview,
    metadata: {
      ...(event.metadata ?? {}),
      largeValueRef: spilled,
    },
  };
}

const EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES = 192 * 1024;
const pendingExternalToolInputTransports = new Map<string, Promise<void>>();

function broadcastExternalToolUseStop(
  event: Extract<UnifiedEvent, { kind: 'tool_use_stop' }>,
  parentToolUseId: string | undefined,
  toolName: string | null,
): void {
  const broadcastStop = (payload: { input?: Record<string, unknown>; inputRef?: unknown }): void => {
    if (parentToolUseId && toolName) {
      broadcast('chat:subagent-tool-use', {
        parentToolUseId,
        tool: {
          id: event.toolUseId,
          name: toolName,
          input: payload.input ?? {},
          streamIndex: 0,
        },
        ...(payload.inputRef ? { inputRef: payload.inputRef } : {}),
        finalInput: true,
      });
      return;
    }
    if (!parentToolUseId) {
      broadcast('chat:content-block-stop', {
        type: 'tool_use',
        toolId: event.toolUseId,
        ...payload,
      });
    }
  };

  if (!event.input) {
    broadcastStop({});
    return;
  }

  const serialized = JSON.stringify(event.input);
  if (Buffer.byteLength(serialized, 'utf-8') <= EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES) {
    broadcastStop({ input: event.input });
    return;
  }

  const transport = maybeSpill(serialized, {
    inlineMaxBytes: EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES,
    previewBytes: 0,
    mimetype: 'application/json; charset=utf-8',
    sessionId: getExternalLifecycleSessionId() || undefined,
  })
    .then((spilled) => {
      if ('inline' in spilled) {
        broadcastStop({ input: event.input });
        return;
      }
      broadcastStop({ inputRef: spilled });
    })
    .catch((err) => {
      console.error('[external-session] tool input spill failed:', err);
      // The full input is already persisted server-side. Complete the live
      // block without re-introducing an oversized SSE payload; history restore
      // remains authoritative if the local ref could not be written.
      broadcastStop({});
    });
  const tracked = transport.finally(() => {
    if (pendingExternalToolInputTransports.get(event.toolUseId) === tracked) {
      pendingExternalToolInputTransports.delete(event.toolUseId);
    }
  });
  pendingExternalToolInputTransports.set(event.toolUseId, tracked);
  trackInFlightSave(tracked);
}

function applyExternalToolResult(event: Extract<UnifiedEvent, { kind: 'tool_result' }>): void {
  // Update the matching tool_use block's result + attachments (PRD 0.2.15)
  applyExternalToolResultToContent({
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  broadcast('chat:tool-result-start', {
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // Emit complete immediately — external runtimes deliver tool results as a single event
  // (no streaming delta). Frontend needs this to clear tool loading spinner + trigger file refresh.
  broadcast('chat:tool-result-complete', {
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // PRD 0.2.18 — accumulate attachment hints for inbox reply pushback
  // (only when this turn has inbox binding to avoid memory accumulation
  // for non-inbox turns).
  if (getExternalTurnInboxMeta() && event.attachments && event.attachments.length > 0) {
    for (const a of event.attachments) {
      const hint = (a as { name?: string; path?: string; pendingId?: string }).name
        ?? (a as { path?: string }).path
        ?? '<attachment>';
      addExternalTurnAttachmentHint(hint);
    }
  }
  recordRuntimeActivity();
}

function dispatchExternalToolResult(
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
): Promise<void> {
  emitExternalToolEndTrace(event.toolUseId, event.isError);
  return normalizeExternalToolResultForSse(event)
    .then((normalized) => {
      const subParent = getExternalChildToolParent(normalized.toolUseId);
      if (subParent) applySubagentToolResult(subParent, normalized);
      else applyExternalToolResult(normalized);
    })
    .catch((err) => {
      console.error('[external-session] tool_result spill failed:', err);
      const fallback: Extract<UnifiedEvent, { kind: 'tool_result' }> = {
        ...event,
        content: event.content.slice(0, 8 * 1024),
        metadata: {
          ...(event.metadata ?? {}),
          status: event.metadata?.status ?? 'large-result-spill-failed',
        },
      };
      const subParent = getExternalChildToolParent(fallback.toolUseId);
      if (subParent) applySubagentToolResult(subParent, fallback);
      else applyExternalToolResult(fallback);
    });
}

function autoDenyNonInteractiveRequest(event: Extract<UnifiedEvent, { kind: 'permission_request' }>): boolean {
  const scenario = getExternalLifecycleScenario();
  if (scenario.type === 'desktop') return false;
  if (event.toolName !== 'AskUserQuestion') return false;
  const runtimeType = getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  const runtimeSource = runtimeType === 'codex' ? getCurrentRuntimeSource() : undefined;
  const managedCodexDisabled = isManagedCodexStructuredUserInputDisabled(runtimeType, runtimeSource);
  if (!managedCodexDisabled && !shouldDisallowAskUserQuestion(scenario)) return false;
  const reason = managedCodexDisabled
    ? `External runtime AskUserQuestion request was denied because Managed Codex structured user input is disabled.`
    : `External runtime AskUserQuestion request was denied because this ${scenario.type} host does not support native-card interaction.`;
  console.warn(`[external-session] ${reason} requestId=${event.requestId}`);
  fireExternalImCallback('error', buildImErrorPayload(reason));
  const active = getExternalActivePair();
  if (active) {
    void active.runtime.respondPermission(active.process, event.requestId, 'deny', reason, undefined, undefined, true)
      .catch((err) => console.error(`[external-session] auto-deny failed for requestId=${event.requestId}:`, err));
  }
  return true;
}

function autoAllowFullAgencyNativeCardRequest(event: Extract<UnifiedEvent, { kind: 'permission_request' }>): boolean {
  if (event.toolName === 'AskUserQuestion') return false;
  const scenario = getExternalLifecycleScenario();
  if (!shouldUseNonBypassForNativeAskUserQuestion(getExternalRuntimeDesiredPermissionMode(), scenario)) {
    return false;
  }
  const active = getExternalActivePair();
  if (!active) return false;
  console.log(`[external-session] native-card fullAgency fast-path: auto-approved ${event.toolName} requestId=${event.requestId}`);
  void active.runtime.respondPermission(active.process, event.requestId, 'allow_once')
    .catch((err) => console.error(`[external-session] fullAgency auto-allow failed for requestId=${event.requestId}:`, err));
  return true;
}

function handleUnifiedEvent(event: UnifiedEvent): void {
  recordRuntimeActivity();

  switch (event.kind) {
    case 'turn_started':
      if (!isExternalTurnCompleted() && getExternalTurnStartTime() === 0) {
        clearExternalPrewarmingSession();
        markExternalTurnStarted();
        beginExternalTurnTrace('external_runtime_turn_started', getExternalLifecycleSessionId());
        setExternalSessionState('running');
      }
      break;

    case 'text_delta':
      if (appendSubagentTraceDelta(event, 'AgentMessage')) {
        break;
      }
      emitExternalFirstDeltaTrace(event.text);
      appendExternalAssistantText(event.text);
      appendExternalPendingText(event.text);
      broadcast('chat:message-chunk', event.text);
      fireExternalImCallback('delta', event.text);
      break;

    case 'text_stop':
      if (completeSubagentTrace(event, 'AgentMessage')) {
        break;
      }
      // Text block ended — flush accumulated text into a content block
      console.log(`[external-session] text_stop: accumulated ${getExternalAssistantText().length} chars`);
      flushPendingText();
      // Mirror builtin: tell the renderer the trailing text block closed so it clears
      // `streamingTextActive` and the tail-fade stops (same bug class, sibling runtime
      // path). type:'text' is the discriminator; index is unused for the text case.
      broadcast('chat:content-block-stop', { index: -1, type: 'text' });
      fireExternalImCallback('block-end', '');
      break;

    case 'thinking_start':
      if (startSubagentTrace(event, 'Thinking')) {
        break;
      }
      flushPendingText();  // Close any open text block before thinking
      if (isExternalPendingThinkingActive()) {
        // Defensive close: a new reasoning block implies the previous one ended,
        // even if the runtime never sent an explicit stop.
        flushPendingThinking(true);
      }
      resetExternalPendingThinking({ index: event.index, active: true, startedAt: Date.now() });
      broadcast('chat:thinking-start', { index: event.index });
      fireExternalImCallback('activity', '');
      break;

    case 'thinking_delta':
      if (appendSubagentTraceDelta(event, 'Thinking')) {
        break;
      }
      if (!isExternalPendingThinkingActive()) {
        activateExternalPendingThinking(event.index);
      }
      appendExternalPendingThinkingText(event.text);
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', { index: event.index, delta: event.text });
      recordRuntimeActivity();
      break;

    case 'thinking_stop':
      if (completeSubagentTrace(event, 'Thinking')) {
        break;
      }
      flushPendingThinking(true);
      // Emit content-block-stop so frontend closes the thinking block
      broadcast('chat:content-block-stop', { index: event.index, type: 'thinking' });
      break;

    case 'tool_use_start':
      emitExternalToolStartTrace(event.toolUseId, event.toolName, !!event.subAgent);
      // PRD 0.2.27 — sub-agent tool nests under its spawn card. If the parent
      // card is still streaming, the call is cached and attached when the parent
      // tool_use block is finalized; known sub-agent events never render flat.
      if (event.subAgent) {
        handleSubagentToolUseStart(event.subAgent.parentToolUseId, event);
        break;
      }
      flushPendingText();  // Close any open text block before tool use
      startExternalToolUseInput({
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.input,
      });
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: event.input ?? {},
      });
      fireExternalImCallback('activity', '');
      break;

    case 'tool_input_delta': {
      // Route by the LATCHED map (set when the start nested), not by event.subAgent,
      // so all events for one tool stay on the same rendering path.
      const { parentToolUseId: parentForInput } = appendExternalToolInputDelta(event.toolUseId, event.delta);
      if (parentForInput) {
        broadcast('chat:subagent-tool-input-delta', {
          parentToolUseId: parentForInput,
          toolId: event.toolUseId,
          delta: event.delta,
        });
        recordRuntimeActivity();
        break;
      }
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      recordRuntimeActivity();  // Tool streaming is activity — prevent killing long-running tools
      break;
    }

    case 'tool_use_stop': {
      const finalToolName = event.input
        ? replaceExternalToolUseInput(event.toolUseId, event.input)
        : null;
      // PRD 0.2.27 — sub-agent tool: finalize its nested input, no flat block / stop.
      // Routed by the latched map (consistent with how the start was rendered).
      const parentForStop = getExternalChildToolParent(event.toolUseId);
      if (parentForStop) {
        finalizeSubagentToolInput(parentForStop, event.toolUseId);
        broadcastExternalToolUseStop(event, parentForStop, finalToolName);
        break;
      }
      // Finalize tool use block from accumulated input
      finalizeExternalToolUseInput(event.toolUseId);
      broadcastExternalToolUseStop(event, undefined, finalToolName);
      break;
    }

    case 'tool_result_delta': {
      const parentForResultDelta = getExternalChildToolParent(event.toolUseId);
      appendExternalToolResultDeltaToContent(event.toolUseId, event.delta);
      if (parentForResultDelta) {
        broadcast('chat:subagent-tool-result-delta', {
          parentToolUseId: parentForResultDelta,
          toolUseId: event.toolUseId,
          delta: event.delta,
        });
        recordRuntimeActivity();
        break;
      }
      broadcast('chat:tool-result-delta', {
        toolUseId: event.toolUseId,
        delta: event.delta,
      });
      recordRuntimeActivity();
      break;
    }

    case 'tool_result': {
      // Keep the stop→result order when a completion-owned tool input had to
      // spill before crossing SSE.
      const pendingInput = pendingExternalToolInputTransports.get(event.toolUseId);
      const dispatched = pendingInput
        ? pendingInput.then(() => dispatchExternalToolResult(event))
        : dispatchExternalToolResult(event);
      trackInFlightSave(dispatched);
      break;
    }

    case 'tool_attachment_update': {
      // Async fulfillment of a placeholder attachment (PRD 0.2.15 §4.7.1).
      // Cross-review (#0.2.29) — a sub-agent tool's attachment lives on a nested
      // SubagentToolCall, not a top-level block, so the scan below can't see it.
      // Route it to the owning sub-agent call (content owner checks both the
      // persisted parent block and the pending map) + a subagent-scoped broadcast.
      const subAttParent = getExternalSubagentAttachmentParent(event.toolUseId);
      if (subAttParent) {
        applyExternalSubagentAttachmentUpdate({
          parentToolUseId: subAttParent,
          toolUseId: event.toolUseId,
          pendingId: event.pendingId,
          attachment: event.attachment,
        });
        broadcast('chat:subagent-tool-attachment-update', {
          parentToolUseId: subAttParent,
          toolUseId: event.toolUseId,
          pendingId: event.pendingId,
          attachment: event.attachment,
        });
        recordRuntimeActivity();
        break;
      }
      // Find the persisted tool block and replace the matching placeholder in-place,
      // then broadcast the same shape so the frontend can patch the rendered gallery.
      applyExternalToolAttachmentUpdate({
        toolUseId: event.toolUseId,
        pendingId: event.pendingId,
        attachment: event.attachment,
      });
      broadcast('chat:tool-attachment-update', {
        toolUseId: event.toolUseId,
        pendingId: event.pendingId,
        attachment: event.attachment,
      });
      recordRuntimeActivity();
      break;
    }

    case 'permission_request': {
      if (autoDenyNonInteractiveRequest(event)) break;
      if (autoAllowFullAgencyNativeCardRequest(event)) break;
      // AskUserQuestion carries a structured payload (questions/options/previews) and
      // needs the dedicated wizard UI, not the generic allow/deny card. Route it through
      // the ask-user-question:request channel so the frontend mounts AskUserQuestionPrompt
      // and the user's answers flow back as CC `updatedInput.answers`.
      if (event.toolName === 'AskUserQuestion' && isAskUserQuestionInput(event.input)) {
        setExternalAskUserQuestion(event.requestId, { input: event.input as Record<string, unknown> });
        const questions = event.input.questions;
        const previewFormat: 'html' | 'markdown' = 'html';
        const requestPayload = {
          requestId: event.requestId,
          sessionId: getCurrentBoundSessionId() || undefined,
          questions,
          previewFormat,
        };
        setExternalInteractiveRequest(event.requestId, {
          type: 'ask-user-question:request',
          data: requestPayload,
        });
        broadcast('ask-user-question:request', requestPayload);
        if (supportsAskUserQuestionNativeCard(getExternalLifecycleScenario())) {
          fireExternalImCallback('ask-user-question-request', JSON.stringify(requestPayload));
        }
        break;
      }

      // Store suggestions so respondExternalPermission can echo them back for "always_allow"
      setExternalPermissionSuggestions(event.requestId, event.suggestions);
      const requestPayload = {
        requestId: event.requestId,
        sessionId: getCurrentBoundSessionId() || undefined,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: typeof event.input === 'object' ? JSON.stringify(event.input).slice(0, 500) : String(event.input ?? '').slice(0, 500),
      };
      setExternalInteractiveRequest(event.requestId, {
        type: 'permission:request',
        data: requestPayload,
      });
      broadcast('permission:request', requestPayload);
      fireExternalImCallback('permission-request', JSON.stringify({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
      }));
      break;
    }

    case 'interactive_request_resolved': {
      const pending = getExternalInteractiveRequest(event.requestId);
      deleteExternalAskUserQuestion(event.requestId);
      deleteExternalInteractiveRequest(event.requestId);
      consumeExternalPermissionSuggestions(event.requestId);
      broadcastExternalInteractiveExpired(event.requestId, pending, 'resolved');
      recordRuntimeActivity();
      break;
    }

    case 'session_init': {
      // Capture runtime's session ID for multi-turn resume
      // CC: session_id from hook; Codex: threadId from thread/start response; Gemini: from session/new
      if (event.sessionId) {
        setExternalRuntimeSessionId(event.sessionId);
        // Persist to SessionMetadata for cross-restart resume.
        // During pre-warm, metadata may not exist yet. Attempt update; if
        // metadata doesn't exist yet, store the ID in the pending birth record
        // so the first real user turn can materialize metadata with the
        // runtime thread id attached.
        const lifecycleSessionId = getExternalLifecycleSessionId();
        if (lifecycleSessionId && event.sessionId !== lifecycleSessionId) {
          // Eagerly schedule the patch with session affinity. If
          // updateSessionMetadata succeeds, clear the pending birth because
          // metadata already exists.
          // handleUnifiedEvent is a sync stream callback — fire-and-forget the
          // async lock-protected write.
          const targetSessionId = lifecycleSessionId;
          const targetRuntimeId = event.sessionId;
          if (pendingExternalSessionBirth?.sessionId === targetSessionId) {
            pendingExternalSessionBirth = {
              ...pendingExternalSessionBirth,
              runtimeSessionId: targetRuntimeId,
            };
          }
          void updateSessionMetadata(targetSessionId, {
            runtime: getCurrentRuntimeType(),
            runtimeSource: getCurrentRuntimeSource(),
            runtimeSessionId: targetRuntimeId,
          })
            .then((updated) => {
              if (
                updated
                && pendingExternalSessionBirth?.sessionId === targetSessionId
                && pendingExternalSessionBirth.runtimeSessionId === targetRuntimeId
              ) {
                // Metadata existed — persist succeeded; birth is no longer pending.
                pendingExternalSessionBirth = null;
              }
            })
            .catch((err) => console.warn('[external-session] runtimeSessionId persist failed:', err));
        }
      }
      const info: SystemInitInfo = {
        timestamp: new Date().toISOString(),
        session_id: event.sessionId,
        model: event.model,
        tools: event.tools,
      };
      if (event.model) {
        setExternalRuntimeLiveReportedModel(event.model);
      }
      // Match builtin broadcast shape: { info: {...}, sessionId } — top-level sessionId
      // is read by frontend for session ID sync (TabProvider).
      // `prewarm` preserves whether this initialization happened before a user
      // turn for runtime metadata/diagnostics. Renderer activity is owned by
      // chat:status and REST liveSessionState, never inferred from system-init.
      const systemInitPayload = buildExternalSystemInitPayload({
        info,
        runtime: getCurrentRuntimeType(),
        runtimeSource: getCurrentRuntimeSource(),
      });
      setExternalSystemInitPayload(systemInitPayload);
      broadcast('chat:system-init', systemInitPayload);
      break;
    }

    case 'model_update':
      if (event.model) {
        setExternalRuntimeLiveReportedModel(event.model);
        updateExternalCurrentTurnUsageModel(event.model);
      }
      break;

    case 'runtime_diagnostics': {
      // Issue #194: runtime's self-report (auth, features, MCP, apps, effective env).
      // Sidecar log keeps a snapshot for unified-log triage; renderer renders the
      // diagnostic strip / details panel.
      console.log(`[external-session] runtime_diagnostics: runtime=${event.diagnostics.runtime} features=${event.diagnostics.features?.length ?? 0} mcp=${event.diagnostics.mcpServers?.length ?? 0} apps=${event.diagnostics.apps?.length ?? 0} auth=${event.diagnostics.auth?.authMethod ?? 'none'}`);
      broadcast('chat:runtime-diagnostics', event.diagnostics);

      // Banner v2 only renders BLOCKING issues (auth.requiresLogin + total
      // RPC failure). Non-blocking signals — app/list 403, individual MCP
      // server failure, feature-flag query error — used to show up in the
      // yellow banner too; users (rightly) complained about chronic noise
      // from transient Codex backend hiccups. Route them through chat:log
      // instead so the Logs panel shows them but the chat header stays
      // clean. Sidecar console / unified log still has the full snapshot.
      const d = event.diagnostics;
      const emitDiagnosticLog = (level: 'warn' | 'error', message: string): void => {
        broadcast('chat:log', {
          source: 'bun',
          level,
          message,
          timestamp: new Date().toISOString(),
          runtime: getCurrentRuntimeType(),
        });
      };
      const errOf = (s: typeof d.status.auth): string | null =>
        s && typeof s === 'object' && 'error' in s ? String(s.error) : null;
      const authErr = errOf(d.status.auth);
      const appsErr = errOf(d.status.apps);
      const mcpErr = errOf(d.status.mcpServers);
      const featErr = errOf(d.status.features);
      // `error` for ones the banner would have considered "warn-tier" in v1;
      // `warn` for purely informational. Severity here drives Logs panel
      // sort/filter — it isn't what makes the banner appear.
      if (authErr) emitDiagnosticLog('error', `[codex-diag] auth status query failed: ${authErr.slice(0, 200)}`);
      if (appsErr) emitDiagnosticLog('warn', `[codex-diag] app/list failed: ${appsErr.slice(0, 200)}`);
      if (mcpErr) emitDiagnosticLog('warn', `[codex-diag] mcpServerStatus/list failed: ${mcpErr.slice(0, 200)}`);
      if (featErr) emitDiagnosticLog('warn', `[codex-diag] experimentalFeature/list failed: ${featErr.slice(0, 200)}`);
      if (d.apps) {
        const inaccessible = d.apps.filter(a => a.isEnabled && !a.isAccessible);
        if (inaccessible.length > 0) {
          emitDiagnosticLog(
            'warn',
            `[codex-diag] ${inaccessible.length} app(s) enabled but not accessible: ${inaccessible.map(a => a.id).slice(0, 5).join(', ')}`,
          );
        }
      }
      if (d.mcpServers) {
        const failed = d.mcpServers.filter(s => s.state === 'failed');
        if (failed.length > 0) {
          emitDiagnosticLog(
            'warn',
            `[codex-diag] MCP server(s) in failed state: ${failed.map(s => s.name).join(', ')}`,
          );
        }
      }
      if (d.issues) {
        for (const issue of d.issues) {
          emitDiagnosticLog(
            issue.severity === 'error' ? 'error' : 'warn',
            `[codex-diag] ${issue.code}: ${issue.message}`,
          );
        }
      }
      break;
    }

    case 'agent_plan_update': {
      broadcast('chat:agent-plan-update', {
        sessionId: getExternalLifecycleSessionId() || null,
        todos: event.todos,
      });
      break;
    }

    case 'user_message_accepted': {
      surfaceAcceptedRealtimeSteeredUserMessage(event.clientUserMessageId);
      break;
    }

    case 'status_change': {
      // Map runtime states to frontend session states (match builtin runtime behavior)
      const stateMap: Record<string, string> = { running: 'running', error: 'error', waiting_permission: 'running' };
      setExternalSessionState((stateMap[event.state ?? ''] ?? 'idle') as ExternalSessionState);
      break;
    }

    case 'turn_complete': {
      // Mark turn complete — session_complete will follow for CC -p mode
      clearWatchdog();
      // Defensive fallback: Codex should emit item/started userMessage for
      // accepted turn/steer input. If an older app-server does not, promote the
      // pending pill at the turn boundary rather than leaving it orphaned.
      surfaceAllPendingRealtimeSteeredUserMessages();
      const terminalGenerationBefore = getExternalTurnTerminalGeneration();
      const turnPlan = markExternalTurnComplete(event, {
        intentionalStopInProgress: getExternalUserRequestedStop(),
      });
      const terminalGeneration = getExternalTurnTerminalGeneration();

      if (turnPlan.kind !== 'persist-success') {
        const message = turnPlan.message;
        let completionTerminal: SessionCompletionTerminal | null = null;
        if (terminalGeneration > terminalGenerationBefore && turnPlan.kind === 'failure') {
          const terminalText = currentExternalTurnTextSnapshot();
          if (turnPlan.cleanup === 'stopped') {
            completionTerminal = finalizeStoppedExternalTurn(
              terminalText,
              consumeExternalTurnMetrics(),
            );
          } else {
            completionTerminal = notifyFailedExternalTurn(terminalGeneration, terminalText, message);
          }
        }
        console.warn(
          `[external-session] turn_complete: non-success status=${event.status ?? 'unknown'}, elapsed=${getExternalTurnStartTime() ? Date.now() - getExternalTurnStartTime() : 0}ms, message=${message}`,
        );
        if (turnPlan.kind === 'defer-to-stop') {
          console.log('[external-session] turn_complete arrived during intentional stop; deferring idle/drain cleanup to stopExternalSession');
          clearExternalPermissionSuggestions();
          drainPendingInteractiveRequestsAsExpired('stop');
          break;
        }

        const cleanup = turnPlan.cleanup;
        emitExternalTurnTrace('final', {
          status: 'error',
          detail: {
            source: 'turn_complete',
            turnStatus: event.status ?? 'unknown',
            error: message,
          },
        });
        if (cleanup !== 'stopped') {
          broadcast('chat:agent-error', { message });
          broadcast(
            'chat:message-error',
            withSessionCompletionTerminal(message, completionTerminal),
          );
        }
        fireExternalImCallback('error', buildImErrorPayload(message));
        finalizeExternalActiveRequest('failed');
        deliverExternalWatchError({
          sessionId: getExternalLifecycleSessionId(),
          text: currentExternalTurnTextSnapshot(),
          errorCode: cleanup === 'stopped' ? 'session_aborted' : 'turn_failed',
          errorMessage: message,
        });
        clearExternalInboxMetaOnRejection({
          sessionId: getExternalLifecycleSessionId(),
          errorCode: 'turn_failed',
          errorMessage: message,
        });
        finalizeExternalLiveAssistantInMemory();
        resetTurnAccumulators();
        clearExternalPermissionSuggestions();
        drainPendingInteractiveRequestsAsExpired('error');
        setExternalSessionState('idle');
        if (cleanup === 'stopped') {
          broadcast(
            'chat:message-stopped',
            withSessionCompletionTerminal(null, completionTerminal),
          );
        }
        scheduleExternalQueueDrainAfterTurnBoundary();
        break;
      }

      emitExternalTurnTrace('final', {
        status: 'ok',
        detail: {
          textChars: getExternalAssistantText().length,
          blocks: getExternalContentBlockCount(),
        },
      });
      console.log(`[external-session] turn_complete: text=${getExternalAssistantText().length}chars, blocks=${getExternalContentBlockCount()}, elapsed=${getExternalTurnStartTime() ? Date.now() - getExternalTurnStartTime() : 0}ms`);
      // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
      // Tracked by turnFinalization so idle-waiters / the next turn wait for the flush.
      trackExternalTurnFinalization(persistTurnResult(terminalGeneration).catch((err) => console.error('[external-session] persistTurnResult (turn_complete) failed:', err)));
      break;
    }

    case 'session_complete': {
      clearWatchdog();
      console.log(`[external-session] session_complete: subtype=${event.subtype}, result=${(event.result || '').length > 0 ? `${(event.result || '').length}chars` : 'empty'}, turnCompleted=${isExternalTurnCompleted()}, assistantText=${getExternalAssistantText().length}chars`);
      // Track whether persistTurnResult is in-flight (or was already fired by
      // turn_complete). When true, persistTurnResult will broadcast
      // chat:message-complete + setExternalSessionState('idle') itself, in
      // that order. We MUST NOT fire idle synchronously below, because
      // persistTurnResult is async (awaits disk writes) and the synchronous
      // idle would race ahead of message-complete on the SSE wire — the
      // renderer's chat:status idle handler clears isStreamingRef, and the
      // subsequent flushPendingChunks at message-complete bails its updater,
      // dropping every chunk that hadn't yet RAF-flushed. v0.2.14 cross-bugfix.
      //
      // Use the actual finalization gate rather than `turnCompleted`: a
      // non-success turn (Codex interrupted/cancelled) also reaches
      // turn_complete, but intentionally does not persist an assistant message.
      // Set this BEFORE the if/else so the error branch also honours the
      // in-flight contract.
      let persistInFlight = isExternalTurnFinalizationInFlight();
      const terminalGenerationBefore = getExternalTurnTerminalGeneration();
      const sessionPlan = markExternalSessionComplete(event, {
        hasAssistantText: !!getExternalAssistantText().trim(),
        isUserRequestedStop: getExternalUserRequestedStop,
      });
      const terminalGeneration = getExternalTurnTerminalGeneration();
      if (sessionPlan.kind === 'ignore-prewarm-exit') {
        console.log(`[external-session] Ignoring pre-warm exit (subtype=${event.subtype}) — no user turn was in flight; next send will start fresh`);
      } else if (sessionPlan.kind === 'success') {
        // CC slash commands (e.g. /context, /cost) return output directly in `result`
        // without streaming text_delta events. Only broadcast if NO turn completed
        // (turnCompleted means text was already streamed + persisted normally).
        if (event.result && sessionPlan.shouldFinalize && !getExternalAssistantText().trim()) {
          appendExternalAssistantText(event.result);
          appendExternalPendingText(event.result);
          broadcast('chat:message-chunk', event.result);
        }
        // Only finalize if turn_complete didn't already (Codex emits turn_complete; CC uses session_complete only)
        if (sessionPlan.shouldFinalize) {
          emitExternalTurnTrace('final', {
            status: 'ok',
            detail: {
              textChars: getExternalAssistantText().length,
              blocks: getExternalContentBlockCount(),
              source: 'session_complete',
            },
          });
          // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
          // Tracked by turnFinalization so idle-waiters / the next turn wait for the flush.
          trackExternalTurnFinalization(persistTurnResult(terminalGeneration).catch((err) => console.error('[external-session] persistTurnResult (session_complete) failed:', err)));
          persistInFlight = true;
        }
        // else: turn_complete already fired persistTurnResult — persistInFlight
        // was already initialized from the turnFinalization gate. The async
        // broadcast it emits after chat:message-complete is the authoritative
        // idle.
      } else {
        const errorMessage = sessionPlan.message;
        let completionTerminal: SessionCompletionTerminal | null = null;
        if (
          terminalGeneration > terminalGenerationBefore
          && !persistInFlight
          && sessionPlan.kind === 'failure'
        ) {
          completionTerminal = notifyFailedExternalTurn(
            terminalGeneration,
            currentExternalTurnTextSnapshot(),
            errorMessage,
          );
        }
        if (sessionPlan.kind === 'ignore-idle') {
          console.log(`[external-session] Ignoring idle-exit "${errorMessage}" — process was between turns; next message will auto-resume`);
        } else if (sessionPlan.kind === 'suppress-user-stop') {
          emitExternalTurnTrace('final', {
            status: 'error',
            detail: { source: 'user_stop', error: errorMessage },
          });
          console.log(`[external-session] Suppressing error banner for user-initiated stop (was: "${errorMessage}")`);
          deliverExternalWatchError({
            sessionId: getExternalLifecycleSessionId(),
            text: currentExternalTurnTextSnapshot(),
            errorCode: 'session_aborted',
            errorMessage: 'external runtime session was stopped before turn completed',
          });
          // stopExternalSession owns the stopped terminal snapshot. Keep the
          // partial text/usage intact until it consumes them after process exit.
        } else {
          emitExternalTurnTrace('final', {
            status: 'error',
            detail: { source: 'session_complete', error: errorMessage },
          });
          if (!isExternalTurnFinalizationInFlight()) finalizeExternalLiveAssistantInMemory();
          broadcast('chat:agent-error', { message: errorMessage });
          broadcast(
            'chat:message-error',
            withSessionCompletionTerminal(errorMessage, completionTerminal),
          );
          fireExternalImCallback('error', buildImErrorPayload(errorMessage));
          deliverExternalWatchError({
            sessionId: getExternalLifecycleSessionId(),
            text: currentExternalTurnTextSnapshot(),
            errorCode: 'turn_failed',
            errorMessage,
          });
          // Same finalization-ownership rule as the suppress branch above.
          if (!isExternalTurnFinalizationInFlight()) resetTurnAccumulators(); // Prevent stale content leaking into next turn
        }
      }
      clearExternalPermissionSuggestions();
      drainPendingInteractiveRequestsAsExpired('error');  // PRD #131 — runtime crash/watchdog kill: clear stale modals
      setExternalSystemInitPayload(null);
      // Only set idle synchronously when persistTurnResult is NOT going to
      // do it itself. Otherwise we'd race chat:status idle ahead of
      // chat:message-complete (see persistInFlight comment above).
      if (!persistInFlight) {
        setExternalSessionState('idle');
        // Drain queued desktop messages on a failed turn too, so pills don't stick (the next
        // item resumes a fresh process via sendExternalMessage Case 2 if needed).
        if (getExternalUserRequestedStop()) {
          setTimeout(() => drainExternalQueueAfterTurn(), 0);
          clearExternalTurnTrace();
        } else {
          scheduleExternalQueueDrainAfterTurnBoundary();
        }
      }
      // Clean up module state — prevents stuck sessions on CC crash
      clearExternalActiveRuntimeProcess();
      break;
    }

    case 'usage': {
      // Store latest token usage.
      // Codex emits running totals, while other runtimes may emit per-turn deltas.
      const previousUsage = getExternalCurrentTurnUsage();
      const nextUsage: ExternalTurnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        model: event.model || previousUsage?.model || getExternalRuntimeLiveReportedModel() || undefined,
        modelUsage: event.modelUsage,
        semantics: event.semantics,
      };
      setExternalCurrentTurnUsage(nextUsage);
      recordRuntimeActivity();

      // PRD 0.2.32 — 并发 context 用量快照。Codex 的 tokenUsage 通知在 turn 中流式到达
      // → 亚轮实时刷新；CC/Gemini 每轮一次。
      //
      // 占用**只用各 adapter 显式给出的 `contextOccupiedTokens`**（= 最近一次调用的 input 系
      // token），不从 `event.inputTokens` 推算——因为 `inputTokens` 的语义随 runtime 不同：
      // Codex 是 running_total（累计，watchdog 用），CC 的 result.usage 是整 turn 累计，只有
      // Gemini 才是 per-request。任一用作占用都会高估、让圆环钉死在 ~100%。所以三个 adapter
      // 各自设 `contextOccupiedTokens`（codex=last.inputTokens / gemini=per-request input /
      // cc=最近一条主轮 assistant message 的 input+cache），缺失时**不发**（宁可不显示也不显错）。
      const ctxOccupied = event.contextOccupiedTokens;
      const ctxRuntime = getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
      if (typeof ctxOccupied === 'number' && ctxOccupied > 0 && ctxRuntime !== 'builtin') {
        const ctxUsage = computeContextUsage({
          occupiedTokens: ctxOccupied,
          runtimeWindow: event.runtimeContextWindow ?? null,
          source: ctxRuntime,
          model: nextUsage.model,
          lookupWindow: lookupModelContextLength,
        });
        const ctxSessionId = currentTurnTraceSessionId || getExternalLifecycleSessionId() || undefined;
        broadcast('chat:context-usage', ctxSessionId ? { ...ctxUsage, sessionId: ctxSessionId } : ctxUsage);
        // PRD 0.2.32 — 留住本轮最新快照；Codex 亚轮会多次进这里，不每次写盘，turn 末
        // persistTurnResult 快照后写一次（单一数据源，供重开 seed）。
        setExternalCurrentTurnContextUsage(ctxUsage);
      }
      break;
    }

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else if (event.level === 'warn') {
        console.warn(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      // Issue #194: surface warn/error to the renderer so the user sees them
      // in the chat log panel rather than only the unified log. Info-level is
      // log-only — it's high-volume runtime noise (turn/tool lifecycle).
      // Shape MUST match LogEntry (src/renderer/types/log.ts) — the renderer's
      // `chat:log` handler discriminates on `source in data` and drops anything
      // without it. `source: 'bun'` is correct: the sidecar is the writer.
      if (event.level === 'warn' || event.level === 'error') {
        broadcast('chat:log', {
          source: 'bun',
          level: event.level,
          message: event.message,
          timestamp: new Date().toISOString(),
          runtime: getCurrentRuntimeType(),
        });
      }
      break;

    case 'message_replay': {
      // CC's --include-partial-messages outputs complete message objects alongside streaming.
      // Three categories:
      //   1. role=assistant — partial snapshots (SKIP: stream_event deltas already delivered content)
      //   2. role=user, content=string — real user message echo (SKIP if duplicate, REPLAY for resume)
      //   3. role=user, content=array — CC tool_result containers (SKIP as user msg, EXTRACT tool results)
      const replayRole = event.message.role;
      const replayContent = event.message.content;

      if (replayRole === 'user' && Array.isArray(replayContent)) {
        // CC sends tool results as type='user' messages with content=[{type:'tool_result',...}].
        // Don't broadcast as user message (creates ghost empty bubbles).
        // Instead, extract tool_result blocks and emit proper tool-result-complete events
        // so the frontend can close tool loading indicators.
        for (const block of replayContent as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<Record<string, unknown>>).map(b => (b.text as string) || '').join('\n')
                : (block.content != null ? JSON.stringify(block.content) : '');
            broadcast('chat:tool-result-complete', {
              toolUseId: block.tool_use_id,
              content: resultText.slice(0, 2000),  // Truncate for SSE
              isError: block.is_error === true,
            });
            // Update the already-persisted tool_use block with its result.
            // tool_use_stop already consumed pendingToolInputs and pushed to currentContentBlocks,
            // so we find the existing block and add the result (same pattern as tool_result handler).
            applyExternalReplayedToolResultToContent({
              toolUseId: String(block.tool_use_id),
              content: resultText,
              isError: block.is_error === true,
            });
            recordRuntimeActivity();
          }
        }
        break;
      }

      if (replayRole === 'user') {
        // Real user message replay (for session resume scenarios).
        // Skip during active streaming — we already broadcast user message from sendExternalMessage.
        if (isExternalLifecycleRunning() && getExternalSessionMessageCount() > 0) {
          break;
        }
        // Ensure timestamp exists for frontend rendering
        const replayMsg = event.message.timestamp
          ? event.message
          : { ...event.message, timestamp: new Date().toISOString() };
        // This is RESUME history replay (not a live send echo — those come from
        // sendExternalMessage above). Tag it cold-history so a REST-restored
        // session suppresses it (REST owns ordered history) without suppressing
        // the live user echo (#0608).
        broadcast('chat:message-replay', { message: replayMsg, replayKind: 'cold-history' });
      }
      // Assistant replay: normally dropped because stream_event deltas already delivered
      // the content. But if stream deltas were missing (short response, rate limiting,
      // API truncation), the replay is the only source of truth. Use it as fallback.
      if (replayRole === 'assistant' && !getExternalAssistantText().trim()) {
        const content = replayContent;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = (content as Array<Record<string, unknown>>)
            .filter(b => b.type === 'text')
            .map(b => (b.text as string) || '')
            .join('');
        }
        if (text.trim()) {
          console.log(`[external-session] Assistant message_replay fallback: stream had no text, using replay (${text.length} chars)`);
          broadcast('chat:message-chunk', text);
          appendExternalAssistantText(text);
          appendExternalPendingText(text);
          recordRuntimeActivity();
        }
      }
      break;
    }

    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}
