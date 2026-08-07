import { interruptCurrentResponse } from '../agent-session';
import {
  getActiveRuntimeSource,
  getActiveRuntimeType,
  hasPendingExternalAskUserQuestion,
  isExternalSessionActive,
  popLastUserMessageForRetry,
  prewarmExternalSession,
  restoreExternalSessionState,
  shouldUseExternalRuntime,
  updateExternalRuntimeConfig,
} from '../runtimes/external-session';
import { createBuiltinSessionEngine } from './builtin-adapter';
import { createExternalSessionEngine } from './external-adapter';
import type { ExternalRuntimeConfigPatch } from '../runtimes/types';
import type {
  ExternalConfigSource,
  ExternalConfigUpdateResult,
} from '../runtimes/external-session';
import { isPermissionModeForRuntimeIdentity } from '../../shared/providerExecution';
import type { CapabilityOperationResult, SessionEngine, SessionEngineKind } from './types';
import type { TurnOwner } from '../session-core/turn-queue';
import { managementApi } from '../utils/management-api-client';
import { cancelTaskSessionBirth } from './task-session-birth';

const builtinEngine = createBuiltinSessionEngine();
const externalEngine = createExternalSessionEngine();

const EXTERNAL_CONFIG_SOURCES = new Set<ExternalConfigSource>([
  'runtime-config',
  'message-snapshot',
  'desktop',
  'im-sync',
  'cron-sync',
  'adopt-sync',
]);

function parseExternalConfigSource(value: unknown): ExternalConfigSource {
  return typeof value === 'string' && EXTERNAL_CONFIG_SOURCES.has(value as ExternalConfigSource)
    ? value as ExternalConfigSource
    : 'runtime-config';
}

type ExternalRuntimeConfigBody = {
  model?: string | null;
  permissionMode?: unknown;
  reasoningEffort?: string | null;
};

export async function updateExternalRuntimeConfigAtSelector(request: {
  runtime?: unknown;
  runtimeConfig: ExternalRuntimeConfigBody;
  source?: unknown;
}): Promise<{
  httpStatus: number;
  body: ExternalConfigUpdateResult | { success: false; error: string };
}> {
  if (!shouldUseExternalRuntime()) {
    return {
      httpStatus: 400,
      body: { success: false, error: 'Runtime config endpoint is only for external runtimes' },
    };
  }

  const activeRuntime = getActiveRuntimeType();
  if (request.runtime && request.runtime !== activeRuntime) {
    return {
      httpStatus: 400,
      body: { success: false, error: `Runtime mismatch: sidecar=${activeRuntime}, payload=${request.runtime}` },
    };
  }

  const requestedPermissionMode = request.runtimeConfig.permissionMode;
  if (requestedPermissionMode !== undefined && requestedPermissionMode !== null
      && typeof requestedPermissionMode !== 'string') {
    return {
      httpStatus: 400,
      body: { success: false, error: 'permissionMode must be a string or null' },
    };
  }
  if (typeof requestedPermissionMode === 'string' && requestedPermissionMode.trim()) {
    const runtimeSource = getActiveRuntimeSource();
    if (!isPermissionModeForRuntimeIdentity(requestedPermissionMode, activeRuntime, runtimeSource)) {
      return {
        httpStatus: 400,
        body: {
          success: false,
          error: `Invalid permissionMode '${requestedPermissionMode}' for ${runtimeSource ?? activeRuntime}`,
        },
      };
    }
  }

  const patch: ExternalRuntimeConfigPatch = {
    ...('model' in request.runtimeConfig ? { model: request.runtimeConfig.model ?? '' } : {}),
    ...('permissionMode' in request.runtimeConfig
      ? { permissionMode: (request.runtimeConfig.permissionMode as string | null) ?? '' }
      : {}),
    ...('reasoningEffort' in request.runtimeConfig
      ? { reasoningEffort: request.runtimeConfig.reasoningEffort ?? '' }
      : {}),
  };
  const result = await updateExternalRuntimeConfig(patch, {
    source: parseExternalConfigSource(request.source),
  });
  return { httpStatus: result.success ? 200 : 500, body: result };
}

export async function prewarmExternalRuntimeAtSelector(options: {
  sessionId: string;
  workspacePath: string;
  model?: string;
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!shouldUseExternalRuntime()) {
    return {
      httpStatus: 400,
      body: { success: false, error: 'Pre-warm is only for external runtimes' },
    };
  }
  if (!options.sessionId) {
    return {
      httpStatus: 400,
      body: { success: false, error: 'No sessionId available' },
    };
  }
  const result = await prewarmExternalSession({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    scenario: { type: 'desktop' },
    model: options.model,
  });
  return { httpStatus: 200, body: { success: true, ...result } };
}

export async function restoreInitialExternalSessionAtSelector(sessionId: string, workspacePath: string): Promise<boolean> {
  if (!shouldUseExternalRuntime()) return false;
  const restored = await restoreExternalSessionState(sessionId, workspacePath, { type: 'desktop' });
  if (!restored.success) throw new Error(restored.error ?? 'External Session restore failed');
  return true;
}

export function retryLastExternalUserMessageAtSelector(
  userMessageId: string,
): Promise<CapabilityOperationResult> {
  if (!shouldUseExternalRuntime()) {
    return Promise.resolve({
      success: false,
      status: 400,
      error: 'external-retry is only for external runtimes; builtin uses /chat/rewind',
    });
  }
  return popLastUserMessageForRetry(userMessageId);
}

export function getSessionEngine(): SessionEngine {
  return shouldUseExternalRuntime() ? externalEngine : builtinEngine;
}

export function getSessionEngineKind(): SessionEngineKind {
  return shouldUseExternalRuntime() ? 'external' : 'builtin';
}

export function getSessionRuntimeType(): ReturnType<typeof getActiveRuntimeType> {
  return getActiveRuntimeType();
}

/**
 * Historical stop behavior: when the external-runtime flag is on but no
 * external session is active yet, /chat/stop falls back to the builtin
 * interrupt path. Keep that compatibility outside either adapter so the
 * external adapter does not become a mixed owner.
 */
export async function stopActiveTurn(): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  const engine = getSessionEngine();
  const turn = engine.getCurrentTurnIdentity();
  if (turn?.owner.kind === 'goal') {
    const context = engine.getCurrentSessionContext();
    if (!context.sessionId || !context.workspacePath) {
      return { success: false, error: 'Active Goal turn has no Session context' };
    }
    const paused = await managementApi('/api/goal/turn/pause', 'POST', {
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      goalId: turn.owner.id,
      queueId: turn.queueId,
    });
    if (paused.ok !== true) {
      return { success: false, error: String(paused.error ?? 'Failed to pause active Goal') };
    }
    const pausedGoalStatus = paused.goal && typeof paused.goal === 'object'
      ? (paused.goal as { status?: unknown }).status
      : undefined;
    if (pausedGoalStatus === 'complete' || pausedGoalStatus === 'blocked') {
      return { success: true, alreadyStopped: true };
    }
    const stopped = await stopOwnedTurnByQueueId(turn.owner, turn.queueId);
    if (!stopped.success) return stopped;
    const settled = await managementApi('/api/goal/turn/abort', 'POST', {
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      goalId: turn.owner.id,
      queueId: turn.queueId,
    });
    return settled.ok === true
      ? stopped
      : { success: false, error: String(settled.error ?? 'Failed to settle paused Goal turn') };
  }
  if (shouldUseExternalRuntime()) {
    const externalResult = await externalEngine.stopTurn();
    if (!externalResult.success || !externalResult.alreadyStopped) return externalResult;
    const stopped = await interruptCurrentResponse();
    return stopped ? { success: true } : { success: true, alreadyStopped: true };
  }
  return builtinEngine.stopTurn();
}

export async function stopOwnedTurn(owner: TurnOwner): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  if (shouldUseExternalRuntime()) {
    const externalResult = await externalEngine.stopOwnedTurn(owner);
    if (!externalResult.success || !externalResult.alreadyStopped) return externalResult;
  }
  return builtinEngine.stopOwnedTurn(owner);
}

export async function stopOwnedTurnByQueueId(
  owner: TurnOwner,
  queueId: string,
): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  // A Task stop must also settle a `/cron/execute-sync` request that reached
  // Node but has not published Session metadata or registered a runtime queue
  // item yet. `not_found` is authoritative only after this barrier.
  const sessionBirthSettlement = owner.kind === 'task'
    ? cancelTaskSessionBirth(owner.id, queueId)
    : null;
  const engine = getSessionEngine();
  const canceled = await engine.cancelQueuedMessage(queueId);
  let result: { success: boolean; alreadyStopped?: boolean; error?: string };
  if (canceled.status === 'cancelled') {
    result = { success: true };
  } else {
    const current = engine.getCurrentTurnIdentity();
    if (
      current?.queueId === queueId
      && current.owner.kind === owner.kind
      && current.owner.id === owner.id
    ) {
      const stopped = await engine.stopTurn({ preserveQueue: true });
      result = stopped.success && stopped.alreadyStopped
        ? {
            success: false,
            error: 'Exact turn stop was not confirmed: the current runtime turn did not stop',
          }
        : stopped;
    } else if (canceled.status === 'not_found') {
      result = { success: true, alreadyStopped: true };
    } else {
      const reason = canceled.status === 'not_cancelled'
        ? 'the runtime already accepted the queued turn and did not cancel it'
        : canceled.status === 'unavailable'
          ? 'queue cancellation is unavailable for this session'
          : 'queue cancellation failed';
      result = {
        success: false,
        error: `Exact turn stop was not confirmed: ${reason}`,
      };
    }
  }
  await sessionBirthSettlement;
  return result;
}

/**
 * Permission prompts historically route to the external runtime only while an
 * external session is active; otherwise they fall back to builtin pending
 * requests. Keep that compatibility at the selector seam.
 */
export function getPermissionResponseEngine(): SessionEngine {
  return shouldUseExternalRuntime() && isExternalSessionActive()
    ? externalEngine
    : builtinEngine;
}

/**
 * AskUserQuestion ownership is tracked per request id. If an external request
 * is still pending, route back to that owner even if the process has just gone
 * away; the external handler preserves the pending entry and returns false so
 * the UI can surface retry/failure instead of silently losing the answer.
 */
export function getAskUserQuestionResponseEngine(requestId: string): SessionEngine {
  return shouldUseExternalRuntime() && hasPendingExternalAskUserQuestion(requestId)
    ? externalEngine
    : builtinEngine;
}
