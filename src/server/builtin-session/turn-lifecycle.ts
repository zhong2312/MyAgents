import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { InteractionScenario } from '../system-prompt';
import { trackServer as defaultTrackServer } from '../analytics';
import { shouldTitleCompletedTurn } from '../../shared/terminalReason';
import type { CancelReason } from '../utils/cancellation';
import {
  extractTurnUsageFromSdkResult,
  isEmptySuccessfulSdkResult,
  isRecoveredAssistantMessageError,
  isSuccessfulCompactControlTurn,
} from '../utils/sdk-turn-outcome';
import {
  classifyBuiltinSdkTerminalResult,
  decideTransientProviderTextRetry,
  type TransientProviderTextError,
  type TransientProviderTextRetryDecision,
} from '../session-core/turn-result-policy';
import { isSdkMissingResumeMessageError } from '../session-core/resume-error-recovery';
import { decideInFlightActionOnResult } from '../utils/inflight-terminal';
import type { ProviderEnv } from '../provider-types';
import type { InFlightMetadata, TurnProviderAnalytics } from './types';
import {
  getCurrentTurnText,
  getCurrentTurnInboxMeta,
  getCurrentTurnSourceItem,
  getCurrentTurnAnalyticsSource,
  getCurrentTurnAnalyticsOrigin,
  getCurrentTurnCompactResult,
  getCurrentTurnProviderAnalytics,
  getCurrentTurnStartTime,
  getCurrentTurnToolCount,
  getCurrentTurnUsage,
  getLastAssistantMessageError,
  peekPendingOutputOwner,
  hadAssistantMessageError,
  hasCurrentTurnImTerminalEmitted,
  hasCurrentTurnOutput,
  markCurrentTurnHasOutput,
  notifyCurrentTurnTerminalOutcome,
  recordCurrentTurnCompletionTerminal,
  replaceCurrentTurnUsage,
  sawCompactBoundary,
  setCurrentTurnImTerminalEmitted,
  setCurrentTurnInboxMeta,
  snapshotCurrentTurnTerminalOutcome,
  clearCurrentTurnTextBlocks,
  type PendingOutputOwner,
} from './turn';
import { originAnalyticsFields, originFromTurnAttribution } from '../../shared/session-origin';
import {
  withSessionCompletionTerminal,
  type SessionCompletionTerminal,
} from '../../shared/sessionCompletion';
import {
  getInFlightMetadata,
  getInFlightQueueId,
  getInterruptingInFlightQueueId,
  getForceSurfaceInFlightId,
} from './queue';
import { allocateMessageId, appendMessage, getMessages } from './transcript';
import {
  stampTurnUsageOnPendingAssistant,
} from './transcript-persistence';
import { shouldRecordTerminalActivity } from '../session-core/session-activity-policy';
import {
  buildImCancelledPayload,
  buildImCompletePayload,
  buildImErrorPayload,
} from '../utils/im-terminal-payload';
import { formatTextPreviewForLog } from '../utils/log-summary';

export type BuiltinTurnTraceSnapshot = {
  turnId: string;
  startMs: number;
  sessionId: string;
  requestId?: string;
};

export type BuiltinTurnTraceOptions = {
  status?: 'ok' | 'error' | 'timeout' | 'skipped';
  durationMs?: number;
  sizeBytes?: number;
  count?: number;
  detail?: Record<string, string | number | boolean | null | undefined>;
};

export type BuiltinSdkResultMessage = SDKResultMessage & {
  result?: string;
  errors?: string[];
};

export type BuiltinTurnLifecycleDeps = {
  getSessionId: () => string;
  getWorkspacePath: () => string;
  getCurrentScenario: () => InteractionScenario;
  getProviderEnv: () => ProviderEnv | undefined;
  getCurrentModel: () => string | undefined;
  getIsInterruptingResponse: () => boolean;
  didInFlightSurviveInterrupt: (queueId: string) => boolean | null;
  setStreamingMessage: (value: boolean) => void;
  resetInFlightToolCount: () => void;
  resetWatchdogFired: () => void;
  claimPostInterruptResultTerminal: () => void;
  terminalEventAppliesToCurrentInFlight: () => boolean;
  dropInFlightQueueItem: (reason: string, imTerminal?: 'cancelled' | 'failed') => string | null;
  preserveInFlightAfterTerminalBoundary: (reason: string) => void;
  surfaceInFlightQueueItem: (
    queueId: string,
    meta: InFlightMetadata | null,
    options: {
      sdkUuid?: string;
      midTurnBreak?: boolean;
      reason: string;
      awaitPersist?: boolean;
      schedulePersist?: boolean;
    },
  ) => Promise<void>;
  schedulePostTerminalQueueDrain: (reason: 'complete' | 'stopped' | 'error' | 'recovery') => void;
  endTurnAbort: (sessionId: string) => void;
  abortTurnAbort: (sessionId: string, reason: CancelReason) => void;
  clearAmbientTurnId: (sessionId: string) => void;
  takeCurrentOutputOwner: () => PendingOutputOwner | null;
  completeOutputOwnerAfterPersistence: (
    owner: PendingOutputOwner | null,
    data: unknown,
    persistence: Promise<unknown>,
    deliverSessionBoundAssistant: boolean,
  ) => void;
  failOutputOwner: (owner: PendingOutputOwner | null, data?: unknown) => void;
  cancelCurrentImRequest: (data?: unknown) => void;
  failCurrentImRequest: (data?: unknown) => void;
  clearMirrorState: () => void;
  clearStreamTurnMaps: () => void;
  clearCronTaskContext: () => void;
  hasQueuedOrInFlightWork: () => boolean;
  setSessionState: (state: 'idle' | 'starting' | 'running' | 'error') => void;
  persistTranscript: (targetMessageCount?: number, lastActiveAt?: string) => Promise<void>;
  snapshotTrace: () => BuiltinTurnTraceSnapshot | null;
  emitTrace: (
    phase: string,
    options?: BuiltinTurnTraceOptions,
    snapshot?: BuiltinTurnTraceSnapshot | null,
  ) => void;
  emitFirstDeltaTrace: (delta: string) => void;
  clearTrace: (snapshot?: BuiltinTurnTraceSnapshot | null) => void;
  nowMs: () => number;
  elapsedMs: (start: number) => number;
  broadcast: (event: string, data: unknown) => void;
  broadcastBuiltinContextUsage: () => Promise<void>;
  getCurrentTransientProviderRetryAttempt: () => number;
  scheduleTransientProviderRetry: (
    decision: Extract<TransientProviderTextRetryDecision, { retry: true }>,
  ) => boolean;
  retractTransientProviderTextOutput: (resultText: string) => Promise<void>;
  clearApiRetryStatus: () => void;
  trackServer?: typeof defaultTrackServer;
  firePostTurnTitleHook: (
    sessionId: string,
    runtime: 'builtin',
    model: string | undefined,
    providerEnv: ProviderEnv | undefined,
  ) => Promise<void> | void;
  appendTextChunk: (chunk: string) => boolean;
  stageAssistantChannelBlock: (text: string) => void;
  localizeImError: (rawError: string) => string;
  setLastAgentError: (error: string) => void;
  buildTurnProviderAnalytics: (providerEnv: ProviderEnv | undefined) => TurnProviderAnalytics;
  probeForkPersistenceIfReady: (resultMessage: BuiltinSdkResultMessage) => void;
  recoverInvalidResumeAnchorError: (rawError: string) => boolean;
  handleTerminalRecovery: (reason: 'image' | 'stale' | undefined) => void;
  applyDeferredRestartIfNeeded: () => void;
};

export type BuiltinTurnLifecycle = {
  handleSdkResult: (resultMessage: BuiltinSdkResultMessage) => Promise<void>;
  completeTurn: (
    durationMs?: number,
    terminalError?: string,
    afterPersist?: () => void,
    terminalKind?: 'complete' | 'cancelled',
  ) => void;
  stopTurn: () => SessionCompletionTerminal | null;
  failTurn: (error: string, localizedError?: string) => SessionCompletionTerminal | null;
  failAdmittedTurnSetup: (error: string) => SessionCompletionTerminal | null;
  getLastTurnEndPersist: () => Promise<unknown>;
};

export function createBuiltinTurnLifecycle(deps: BuiltinTurnLifecycleDeps): BuiltinTurnLifecycle {
  let lastTurnEndPersist: Promise<unknown> = Promise.resolve();
  const track = deps.trackServer ?? defaultTrackServer;

  const clearTerminalStreamState = (): void => {
    deps.clearMirrorState();
    deps.clearStreamTurnMaps();
    deps.clearCronTaskContext();
  };

  const finishTerminalCleanup = (terminal: 'complete' | 'stopped' | 'error'): void => {
    deps.schedulePostTerminalQueueDrain(terminal);
    const sid = deps.getSessionId();
    if (sid) {
      if (terminal === 'error') {
        deps.abortTurnAbort(sid, 'error');
      } else {
        deps.endTurnAbort(sid);
      }
      deps.clearAmbientTurnId(sid);
    }
    if (!deps.hasQueuedOrInFlightWork()) {
      deps.setSessionState('idle');
    }
  };

  const commonTerminalCleanup = (terminal: 'complete' | 'stopped' | 'error'): void => {
    clearTerminalStreamState();
    finishTerminalCleanup(terminal);
  };

  const terminalActivityAt = (outcome: ReturnType<typeof snapshotCurrentTurnTerminalOutcome>): string | undefined => {
    const facts = getCurrentTurnSourceItem()?.activityFacts;
    return facts && shouldRecordTerminalActivity(facts, outcome)
      ? new Date().toISOString()
      : undefined;
  };

  const recordCompletionTerminal = (
    status: 'complete' | 'stopped' | 'error',
  ): SessionCompletionTerminal | null => recordCurrentTurnCompletionTerminal({
    sessionId: deps.getSessionId(),
    workspacePath: deps.getWorkspacePath(),
    status,
  });

  const completeTurn = (
    durationMs?: number,
    terminalError?: string,
    afterPersist?: () => void,
    terminalKind: 'complete' | 'cancelled' = 'complete',
  ): void => {
    deps.setStreamingMessage(false);
    const turnStartTime = getCurrentTurnStartTime();
    const settledDurationMs = durationMs
      ?? (turnStartTime ? Date.now() - turnStartTime : undefined);
    let confirmedQueueTurnKeepStreaming = false;

    const inFlightQueueId = getInFlightQueueId();
    if (inFlightQueueId !== null) {
      const stale = inFlightQueueId;
      const meta = getInFlightMetadata();
      const interruptTargetMismatch = deps.getIsInterruptingResponse()
        && getInterruptingInFlightQueueId() !== stale;
      if (interruptTargetMismatch) {
        deps.preserveInFlightAfterTerminalBoundary(`interrupt result targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      } else {
        const forced = getForceSurfaceInFlightId() === stale;
        const survivedInterrupt = deps.didInFlightSurviveInterrupt(stale);
        const inFlightAction = decideInFlightActionOnResult({
          isInterrupting: deps.getIsInterruptingResponse(),
          forced,
          hasMeta: !!meta,
          survivedInterrupt,
        });
        if (inFlightAction === 'drop') {
          deps.dropInFlightQueueItem('graceful interrupt result before SDK consumption confirmation', 'cancelled');
        } else if (inFlightAction === 'surface' && meta) {
          void deps.surfaceInFlightQueueItem(stale, meta, {
            sdkUuid: stale,
            reason: forced ? 'force-send #289' : 'confirmed result handoff',
            awaitPersist: false,
          }).catch((error) => {
            console.error(`[agent] Failed to surface in-flight queue item ${stale} at result boundary:`, error);
          });
          confirmedQueueTurnKeepStreaming = true;
        } else if (inFlightAction === 'await-replay') {
          deps.preserveInFlightAfterTerminalBoundary(
            deps.getIsInterruptingResponse()
              ? survivedInterrupt === true
                ? 'interrupt receipt confirms queued survivor'
                : 'interrupt receipt unavailable; preserving queued item'
              : 'natural result',
          );
        }
      }
    }

    forceCloseOrphanThinkingBlocks('handleMessageComplete');

    const turnUsage = getCurrentTurnUsage();
    const turnToolCount = getCurrentTurnToolCount();
    stampTurnUsageOnPendingAssistant({
      usage: turnUsage,
      toolCount: turnToolCount,
      durationMs: settledDurationMs,
    });

    const terminalOutcome = snapshotCurrentTurnTerminalOutcome(
      terminalKind === 'cancelled' ? 'stopped' : (terminalError ? 'error' : 'complete'),
      {
        durationMs: settledDurationMs,
        ...(terminalKind === 'cancelled'
          ? { error: 'Execution stopped' }
          : (terminalError ? { error: terminalError } : {})),
      },
    );

    // Detach the SDK-yield owner at the result boundary, before persistence.
    // A later realtime yield can already be producing output while this turn's
    // transcript is still saving, so ownership cannot remain on the FIFO head.
    const outputOwnerClaimedByCancellation = terminalKind === 'cancelled';
    const outputOwner = outputOwnerClaimedByCancellation
      ? null
      : deps.takeCurrentOutputOwner();
    if (outputOwnerClaimedByCancellation && !hasCurrentTurnImTerminalEmitted()) {
      deps.cancelCurrentImRequest(buildImCancelledPayload());
    } else if (terminalError) {
      deps.failOutputOwner(outputOwner, buildImErrorPayload(deps.localizeImError(terminalError)));
    }
    // Runtime ownership ends at the SDK result, not when disk I/O finishes.
    // Finishing later can clear the abort/trace/stream state of a realtime
    // message that the persistent SDK has already started behind this turn.
    commonTerminalCleanup(
      terminalKind === 'cancelled' ? 'stopped' : (terminalError ? 'error' : 'complete'),
    );
    setCurrentTurnImTerminalEmitted(false);
    if (confirmedQueueTurnKeepStreaming) {
      deps.setStreamingMessage(true);
    }

    const persistTrace = deps.snapshotTrace();
    const persistTraceStarted = deps.nowMs();
    const persistTraceToolCount = turnToolCount;
    const persistTraceMessageCount = getMessages().length;
    lastTurnEndPersist = deps.persistTranscript(undefined, terminalActivityAt(terminalOutcome))
      .then(() => {
        deps.emitTrace('persist_done', {
          durationMs: deps.elapsedMs(persistTraceStarted),
          status: 'ok',
          count: persistTraceMessageCount,
          detail: { toolCount: persistTraceToolCount },
        }, persistTrace);
        deps.clearTrace(persistTrace);
      })
      .catch(err => {
        deps.emitTrace('persist_done', {
          durationMs: deps.elapsedMs(persistTraceStarted),
          status: 'error',
          count: persistTraceMessageCount,
          detail: { toolCount: persistTraceToolCount },
        }, persistTrace);
        deps.clearTrace(persistTrace);
        console.error('[agent] persistMessagesToStorage failed:', err);
        throw err;
      });
    if (afterPersist) {
      lastTurnEndPersist = lastTurnEndPersist.then(() => afterPersist());
    }
    if (!outputOwnerClaimedByCancellation && !terminalError) {
      // Reserve delivery order now; the owner implementation releases the
      // captured blocks only if this exact turn's finalization becomes durable.
      deps.completeOutputOwnerAfterPersistence(
        outputOwner,
        buildImCompletePayload(terminalOutcome.text),
        lastTurnEndPersist,
        terminalKind === 'complete',
      );
    }
    void lastTurnEndPersist.catch(() => undefined);
    notifyCurrentTurnTerminalOutcome(terminalOutcome, lastTurnEndPersist);
    if (terminalKind === 'cancelled') {
      deps.claimPostInterruptResultTerminal();
    }
  };

  const stopTurn = (): SessionCompletionTerminal | null => {
    deps.setStreamingMessage(false);
    const terminalOutcome = snapshotCurrentTurnTerminalOutcome('stopped', {
      error: 'Execution stopped',
    });
    const activityAt = terminalActivityAt(terminalOutcome);
    const completionTerminal = recordCompletionTerminal('stopped');
    const stoppedTrace = deps.snapshotTrace();
    deps.emitTrace('final', {
      status: 'error',
      detail: { source: 'message_stopped' },
    }, stoppedTrace);
    if (getInFlightQueueId() !== null) {
      if (deps.terminalEventAppliesToCurrentInFlight()) {
        deps.dropInFlightQueueItem('message stopped before SDK consumption confirmation', 'cancelled');
      } else {
        deps.preserveInFlightAfterTerminalBoundary(`stop targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      }
    }
    commonTerminalCleanup('stopped');
    if (!hasCurrentTurnImTerminalEmitted()) {
      deps.cancelCurrentImRequest(buildImCancelledPayload());
    }
    setCurrentTurnImTerminalEmitted(false);
    forceCloseOrphanThinkingBlocks('handleMessageStopped');
    lastTurnEndPersist = deps.persistTranscript(undefined, activityAt);
    void lastTurnEndPersist.catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
    notifyCurrentTurnTerminalOutcome(terminalOutcome, lastTurnEndPersist);
    deps.clearTrace(stoppedTrace);
    return completionTerminal;
  };

  const failTurn = (error: string, localizedError?: string): SessionCompletionTerminal | null => {
    deps.setStreamingMessage(false);
    const terminalOutcome = snapshotCurrentTurnTerminalOutcome('error', {
      error: localizedError ?? error,
    });
    const activityAt = terminalActivityAt(terminalOutcome);
    const completionTerminal = recordCompletionTerminal('error');
    const errorTrace = deps.snapshotTrace();
    deps.emitTrace('final', {
      status: 'error',
      detail: { source: 'message_error', error },
    }, errorTrace);
    if (getInFlightQueueId() !== null) {
      if (deps.terminalEventAppliesToCurrentInFlight()) {
        deps.dropInFlightQueueItem('message error before SDK consumption confirmation', 'failed');
      } else {
        deps.preserveInFlightAfterTerminalBoundary(`error targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      }
    }
    const isExpectedTermination =
      error.includes('SIGTERM') ||
      error.includes('SIGKILL') ||
      error.includes('SIGINT') ||
      error.includes('process terminated') ||
      error.includes('AbortError');

    if (!isExpectedTermination) {
      appendMessage({
        id: allocateMessageId(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log('[agent] Skipping error persistence for expected termination:', error);
    }
    lastTurnEndPersist = deps.persistTranscript(undefined, activityAt);
    void lastTurnEndPersist.catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
    notifyCurrentTurnTerminalOutcome(terminalOutcome, lastTurnEndPersist);
    commonTerminalCleanup('error');
    if (!hasCurrentTurnImTerminalEmitted()) {
      deps.failCurrentImRequest(buildImErrorPayload(localizedError ?? deps.localizeImError(error)));
    }
    setCurrentTurnImTerminalEmitted(false);
    deps.clearTrace(errorTrace);
    return completionTerminal;
  };

  const failAdmittedTurnSetup = (error: string): SessionCompletionTerminal | null => {
    const completionTerminal = failTurn(error);
    // This failure happens after active-owner transfer but before an SDK
    // dispatch/result exists. No outer SDK terminal caller will reach the
    // normal restart drain, so the lifecycle owner must do it here before a
    // replacement queue item can run on the stale Query/config snapshot.
    deps.applyDeferredRestartIfNeeded();
    return completionTerminal;
  };

  const handleSdkResult = async (resultMessage: BuiltinSdkResultMessage): Promise<void> => {
    deps.resetInFlightToolCount();
    deps.resetWatchdogFired();

    const resultText = resultMessage.result || '';
    const terminalDisposition = classifyBuiltinSdkTerminalResult({
      isError: resultMessage.is_error,
      terminalReason: resultMessage.terminal_reason,
    });
    const isAbortResult = terminalDisposition === 'stopped' || deps.getIsInterruptingResponse();
    const isTerminalFailure = terminalDisposition === 'error' && !isAbortResult;
    let terminalRecoveryReason: 'image' | 'stale' | undefined;

    const transientRetryDecision = decideTransientProviderTextRetry({
      resultText,
      isError: isTerminalFailure,
      isAbortResult,
      apiErrorStatus: 'api_error_status' in resultMessage ? resultMessage.api_error_status ?? null : null,
      toolUseCount: getCurrentTurnToolCount(),
      currentAttempt: deps.getCurrentTransientProviderRetryAttempt(),
    });
    let terminalTransientProviderError: TransientProviderTextError | null = null;
    let terminalTransientProviderRetryExhausted = false;
    let terminalTransientProviderMaxRetries = transientRetryDecision.maxRetries;
    if (transientRetryDecision.retry) {
      await deps.retractTransientProviderTextOutput(resultText);
      if (deps.scheduleTransientProviderRetry(transientRetryDecision)) {
        console.warn(
          `[agent][transient-provider-text] ${transientRetryDecision.error.kind}; ` +
          `auto-retry ${transientRetryDecision.attempt}/${transientRetryDecision.maxRetries} ` +
          `in ${transientRetryDecision.delayMs}ms`,
        );
        return;
      }
      console.warn('[agent][transient-provider-text] retry requested but no safe current turn source was available');
      terminalTransientProviderError = transientRetryDecision.error;
    }
    if (!transientRetryDecision.retry) {
      deps.clearApiRetryStatus();
      terminalTransientProviderError = transientRetryDecision.error;
      terminalTransientProviderRetryExhausted = transientRetryDecision.exhausted;
      terminalTransientProviderMaxRetries = transientRetryDecision.maxRetries;
    }

    if (terminalTransientProviderError) {
      await deps.retractTransientProviderTextOutput(resultText);
      const retrySuffix = terminalTransientProviderRetryExhausted
        ? `已自动重试 ${terminalTransientProviderMaxRetries} 次仍失败。`
        : '当前会话无法安全自动重试。';
      const finalError =
        `${terminalTransientProviderError.userMessage}${retrySuffix}` +
        '请稍后再试、减少并发，或切换 Provider。' +
        `\n\n原始错误：${terminalTransientProviderError.rawText}`;
      deps.setLastAgentError(finalError);
      deps.broadcast('chat:agent-error', { message: finalError });
      const completionTerminal = failTurn(finalError);
      deps.broadcast(
        'chat:message-error',
        withSessionCompletionTerminal(finalError, completionTerminal),
      );
      deps.handleTerminalRecovery(undefined);
      deps.applyDeferredRestartIfNeeded();
      return;
    }

    if (isTerminalFailure || isAbortResult) {
      const rawError = resultText || resultMessage.errors?.join('; ') || getLastAssistantMessageError() || '';
      if (isSdkMissingResumeMessageError(rawError) && deps.recoverInvalidResumeAnchorError(rawError)) {
        console.warn('[agent] SDK result rejected resumeSessionAt anchor; cleared stale anchor and restarting without surfacing user error');
        deps.clearApiRetryStatus();
        commonTerminalCleanup('error');
        return;
      }
      if (
        (rawError.includes('unknown variant') && rawError.includes('image')) ||
        (rawError.includes('image') && rawError.includes('exceed') && rawError.includes('max allowed size'))
      ) {
        terminalRecoveryReason = 'image';
      }
      if (rawError.includes('No conversation found')) {
        terminalRecoveryReason = 'stale';
      }
      if (peekPendingOutputOwner()?.requestId && isAbortResult) {
        console.log('[agent] Suppressing IM error forward for aborted turn (handleMessageComplete will finalize)');
      }
    }

    const turnUsage = extractTurnUsageFromSdkResult(resultMessage);
    replaceCurrentTurnUsage(turnUsage);
    if (!resultMessage.modelUsage && !resultMessage.usage) {
      console.warn('[agent] Result message has no usage data, token statistics may be incomplete');
    }

    const turnStartTime = getCurrentTurnStartTime();
    const durationMs = turnStartTime ? Date.now() - turnStartTime : 0;
    const currentTurnUsage = getCurrentTurnUsage();
    const providerAnalytics = getCurrentTurnProviderAnalytics() ?? deps.buildTurnProviderAnalytics(deps.getProviderEnv());
    const currentTurnToolCount = getCurrentTurnToolCount();
    stampTurnUsageOnPendingAssistant({
      usage: currentTurnUsage,
      toolCount: currentTurnToolCount,
      durationMs: durationMs || undefined,
      providerId: providerAnalytics.provider_id ?? undefined,
    });

    const hasResultText = resultText.trim().length > 0;
    const resultErrorText = (hasResultText ? resultText : '')
      || resultMessage.errors?.join('; ')
      || getLastAssistantMessageError()
      || '';
    const noOutputResultText = isTerminalFailure ? resultErrorText : (hasResultText ? resultText : '');
    if (noOutputResultText && !hasCurrentTurnOutput() && !getCurrentTurnToolCount() && !isAbortResult) {
      if (isTerminalFailure) {
        console.warn('[agent] SDK error result with no streamed output, showing as agent-error:', resultErrorText);
        deps.setLastAgentError(resultErrorText);
        deps.broadcast('chat:agent-error', { message: resultErrorText });
      } else if (resultText) {
        console.warn('[agent] SDK non-error result with no streamed output, showing as message:', resultText);
        deps.emitFirstDeltaTrace(resultText);
        if (deps.appendTextChunk(resultText)) {
          deps.broadcast('chat:message-chunk', resultText);
          markCurrentTurnHasOutput();
          deps.stageAssistantChannelBlock(resultText);
        }
      }
    }

    const finalTurnUsage = getCurrentTurnUsage();
    const finalTurnToolCount = getCurrentTurnToolCount();
    const finalTurnHasOutput = hasCurrentTurnOutput();
    const emptySuccessfulResult = isEmptySuccessfulSdkResult({
      isError: isTerminalFailure,
      result: resultText,
      terminalReason: resultMessage.terminal_reason,
      hasVisibleOutput: finalTurnHasOutput,
      toolCount: finalTurnToolCount,
      outputTokens: finalTurnUsage.outputTokens,
    });
    const successfulCompactControlTurn = isSuccessfulCompactControlTurn({
      emptySuccessfulResult,
      compactResult: getCurrentTurnCompactResult(),
      sawCompactBoundary: sawCompactBoundary(),
    });
    const recoveredAssistantMessageError = isRecoveredAssistantMessageError({
      hadAssistantMessageError: hadAssistantMessageError(),
      isError: resultMessage.is_error,
      terminalReason: resultMessage.terminal_reason,
      emptySuccessfulResult: emptySuccessfulResult && !successfulCompactControlTurn,
    });

    const lastAssistantMessageError = getLastAssistantMessageError();
    if (recoveredAssistantMessageError && lastAssistantMessageError) {
      console.log('[agent] SDK assistant message error recovered by successful result:', lastAssistantMessageError);
    }
    const terminalError = isTerminalFailure
      ? (resultErrorText || resultText || `turn ended with terminal reason ${resultMessage.terminal_reason ?? 'unknown'}`)
      : undefined;
    deps.emitTrace('final', {
      status: isTerminalFailure || (emptySuccessfulResult && !successfulCompactControlTurn) ? 'error' : 'ok',
      durationMs,
      count: finalTurnToolCount,
      detail: {
        terminalReason: resultMessage.terminal_reason ?? 'completed',
        hasOutput: finalTurnHasOutput,
        emptySuccessfulResult,
        successfulCompactControlTurn,
      },
    });

    const messages = getMessages();
    const lastMessage = messages[messages.length - 1];
    const lastAssistant = lastMessage?.role === 'assistant' ? lastMessage : null;

    if (resultMessage.terminal_reason && resultMessage.terminal_reason !== 'completed') {
      const scenario = deps.getCurrentScenario();
      console.log(`[agent][terminal_reason] ${resultMessage.terminal_reason} scenario=${scenario.type} model=${finalTurnUsage.model ?? 'unknown'} duration_ms=${durationMs} tool_count=${finalTurnToolCount}`);
    }

    if (emptySuccessfulResult && !successfulCompactControlTurn) {
      const emptyResultError = 'AI 未返回任何内容，但 SDK 将本轮标记为完成。请在当前会话重试；如果使用第三方兼容供应商，建议切换模型、减少上下文或压缩后重试。';
      console.warn(`[agent][empty_result] model=${finalTurnUsage.model ?? 'unknown'} terminal_reason=${resultMessage.terminal_reason ?? 'none'} input=${finalTurnUsage.inputTokens} output=${finalTurnUsage.outputTokens} duration_ms=${durationMs} provisional_error=${lastAssistantMessageError ?? 'none'}`);
      deps.setLastAgentError(emptyResultError);
      const completionTerminal = failTurn(emptyResultError);
      deps.broadcast(
        'chat:message-error',
        withSessionCompletionTerminal(emptyResultError, completionTerminal),
      );
      const replyText = getCurrentTurnText();
      const replyMeta = getCurrentTurnInboxMeta();
      if (replyMeta) {
        setCurrentTurnInboxMeta(undefined);
        void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
          deliverInboxReply(deps.getSessionId(), replyMeta, {
            text: replyText,
            error: {
              code: 'turn_failed',
              message: emptyResultError,
            },
          }),
        ).catch((err) =>
          console.error('[inbox] empty-result reply pushback failed:', err),
        );
      }
      clearCurrentTurnTextBlocks();
      void import('../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
        deliverSessionWatchEvents(deps.getSessionId(), {
          text: replyText,
          error: {
            code: 'turn_failed',
            message: emptyResultError,
          },
        }),
      ).catch((err) =>
        console.error('[session-watch] empty-result watch push failed:', err),
      );
    } else {
      const completionEvent = {
        model: finalTurnUsage.model,
        input_tokens: finalTurnUsage.inputTokens,
        output_tokens: finalTurnUsage.outputTokens,
        cache_read_tokens: finalTurnUsage.cacheReadTokens,
        cache_creation_tokens: finalTurnUsage.cacheCreationTokens,
        tool_count: finalTurnToolCount,
        duration_ms: durationMs,
        terminal_reason: resultMessage.terminal_reason,
        assistant_sdk_uuid: lastAssistant?.sdkUuid,
        assistant_message_id: lastAssistant?.id,
        compact_result: successfulCompactControlTurn ? 'success' : undefined,
      };

      const scenario = deps.getCurrentScenario();
      const turnAnalyticsSource = getCurrentTurnAnalyticsSource() ?? scenario.type;
      const turnOrigin = getCurrentTurnAnalyticsOrigin()
        ?? originFromTurnAttribution({
          source: turnAnalyticsSource,
          scenarioType: scenario.type,
          desktopSurface: scenario.type === 'desktop' ? scenario.surface : undefined,
        });
      if (terminalDisposition === 'complete' && !deps.getIsInterruptingResponse()) {
        track('ai_turn_complete', {
          source: turnAnalyticsSource,
          ...originAnalyticsFields(turnOrigin),
          session_id: deps.getSessionId(),
          platform: scenario.type === 'im' ? scenario.platform : null,
          runtime: 'builtin',
          runtime_source: null,
          model: finalTurnUsage.model ?? null,
          ...providerAnalytics,
          input_tokens: finalTurnUsage.inputTokens,
          output_tokens: finalTurnUsage.outputTokens,
          cache_read_tokens: finalTurnUsage.cacheReadTokens,
          cache_creation_tokens: finalTurnUsage.cacheCreationTokens,
          tool_count: finalTurnToolCount,
          duration_ms: durationMs,
        });
      }

      // Snapshot before completeTurn schedules persistence. The caller clears
      // the turn accumulator immediately afterwards, while the terminal
      // callback runs only after that async persistence completes.
      const composedAssistantText = getCurrentTurnText();
      completeTurn(
        durationMs,
        terminalError,
        () => {
          if (isAbortResult) {
            const completionTerminal = recordCompletionTerminal('stopped');
            deps.broadcast(
              'chat:message-stopped',
              withSessionCompletionTerminal(null, completionTerminal),
            );
          } else {
            console.log('[agent][sdk] Broadcasting chat:message-complete');
            const completionStatus = terminalError ? 'error' : 'complete';
            const completionTerminal = recordCompletionTerminal(completionStatus);
            if (composedAssistantText.trim()) {
              console.log(
                `[assistant-output] runtime=builtin status=${completionTerminal?.status ?? completionStatus} `
                  + formatTextPreviewForLog(composedAssistantText),
              );
            }
            deps.broadcast(
              'chat:message-complete',
              withSessionCompletionTerminal(completionEvent, completionTerminal),
            );
            void deps.broadcastBuiltinContextUsage();
          }
        },
        isAbortResult ? 'cancelled' : 'complete',
      );

      if (terminalDisposition === 'complete' && !deps.getIsInterruptingResponse()
        && shouldTitleCompletedTurn(resultMessage.is_error === true, resultMessage.terminal_reason)) {
        const titleSid = deps.getSessionId();
        const titleModel = deps.getCurrentModel();
        const titleProviderEnv = deps.getProviderEnv();
        void lastTurnEndPersist.then(
          () => deps.firePostTurnTitleHook(titleSid, 'builtin', titleModel, titleProviderEnv),
          () => undefined,
        );
      }

      const sessionEventText = getCurrentTurnText();
      const sessionEventError = isTerminalFailure
        ? {
            code: 'turn_failed',
            message:
              resultMessage.result ||
              (resultMessage.errors?.join('; ') ?? 'turn ended with error'),
          }
        : undefined;
      const replyMeta = getCurrentTurnInboxMeta();
      if (replyMeta) {
        setCurrentTurnInboxMeta(undefined);
        void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
          deliverInboxReply(deps.getSessionId(), replyMeta, {
            text: sessionEventText,
            error: sessionEventError,
          }),
        ).catch((err) =>
          console.error('[inbox] result-handler reply pushback failed:', err),
        );
      }
      clearCurrentTurnTextBlocks();
      void import('../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
        deliverSessionWatchEvents(deps.getSessionId(), {
          text: sessionEventText,
          error: sessionEventError,
        }),
      ).catch((err) =>
        console.error('[session-watch] result-handler watch push failed:', err),
      );
    }

    deps.probeForkPersistenceIfReady(resultMessage);
    deps.handleTerminalRecovery(terminalRecoveryReason);
    deps.applyDeferredRestartIfNeeded();
  };

  return {
    handleSdkResult,
    completeTurn,
    stopTurn,
    failTurn,
    failAdmittedTurnSetup,
    getLastTurnEndPersist: () => lastTurnEndPersist,
  };
}

function forceCloseOrphanThinkingBlocks(source: string): void {
  const messages = getMessages();
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant' || typeof lastMsg.content === 'string') return;
  let patched = false;
  lastMsg.content = lastMsg.content.map((block) => {
    if (block.type === 'thinking' && !block.isComplete) {
      patched = true;
      return {
        ...block,
        isComplete: true,
        thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined,
      };
    }
    return block;
  });
  if (patched && source === 'handleMessageComplete') {
    console.warn('[agent] Force-closed orphaned thinking block(s) in handleMessageComplete');
  }
}
