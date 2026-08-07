import { coerceReasoningEffortForRuntime, normalizeReasoningEffort } from '../../../shared/reasoningEffort';
import { coerceModelForRuntime, projectPermissionModeForRuntime, type RuntimeType } from '../../../shared/types/runtime';
import type { ExternalRuntimeConfigPatch } from '../types';
import { getSessionMetadata } from '../../SessionStore';
import {
  isRuntimeConfigPatchNoopAgainstDesired,
  runtimeConfigPatchKeys,
} from '../../session-core/runtime-config-policy';
import type { ExternalConfigSource } from './types';

let desiredModel = '';
let liveReportedModel = '';
let desiredPermissionMode = '';
let desiredReasoningEffort = '';

export function resetExternalRuntimeConfigState(): void {
  desiredModel = '';
  liveReportedModel = '';
  desiredPermissionMode = '';
  desiredReasoningEffort = '';
}

export function getExternalRuntimeDesiredModel(): string {
  return desiredModel;
}

export function getExternalRuntimeLiveReportedModel(): string {
  return liveReportedModel;
}

export function getExternalRuntimeDesiredPermissionMode(): string {
  return desiredPermissionMode;
}

export function getExternalRuntimeDesiredReasoningEffort(): string {
  return desiredReasoningEffort;
}

export function getExternalRuntimeDisplayModel(): string | null {
  return liveReportedModel || desiredModel || null;
}

export function getExternalRuntimeDisplayPermissionMode(): string | null {
  return desiredPermissionMode || null;
}

export function getExternalRuntimeDisplayReasoningEffort(): string | undefined {
  return desiredReasoningEffort || undefined;
}

export function setExternalRuntimeLiveReportedModel(model: string | null | undefined): void {
  liveReportedModel = typeof model === 'string' ? model : '';
}

export function coerceExternalRuntimeModel(
  model: string | null | undefined,
  runtime: RuntimeType,
  source: string,
  sessionId = '',
): string | undefined {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return undefined;
  const coerced = coerceModelForRuntime(trimmed, runtime);
  if (coerced === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale external runtime model='${trimmed}' on runtime='${runtime}' source=${source}; falling back to runtime default. sessionId=${sessionId || '(none)'}`,
    );
  }
  return coerced;
}

export function coerceExternalRuntimePermissionMode(
  mode: string | null | undefined,
  runtime: RuntimeType,
  source: string,
  sessionId = '',
): string | undefined {
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  if (!trimmed) return undefined;
  const coerced = projectPermissionModeForRuntime(trimmed, runtime);
  if (coerced === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale external runtime permissionMode='${trimmed}' on runtime='${runtime}' source=${source}; falling back to runtime default. sessionId=${sessionId || '(none)'}`,
    );
  }
  return coerced;
}

export function coerceExternalRuntimeReasoningEffort(
  effort: string | null | undefined,
  runtime: RuntimeType,
  source: string,
  sessionId = '',
): string | undefined {
  const normalized = normalizeReasoningEffort(effort);
  if (!normalized) return undefined;
  const coerced = coerceReasoningEffortForRuntime(normalized, runtime);
  if (coerced === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale external runtime reasoningEffort='${normalized}' on runtime='${runtime}' source=${source}; falling back to runtime default. sessionId=${sessionId || '(none)'}`,
    );
  }
  return coerced;
}

export function normalizeExternalRuntimeConfigPatch(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
  runtime: RuntimeType,
  sessionId = '',
): ExternalRuntimeConfigPatch {
  const normalized: ExternalRuntimeConfigPatch = {};
  if (patch.model !== undefined) {
    normalized.model = coerceExternalRuntimeModel(
      patch.model,
      runtime,
      source,
      sessionId,
    ) ?? '';
  }
  if (patch.permissionMode !== undefined) {
    normalized.permissionMode = coerceExternalRuntimePermissionMode(
      patch.permissionMode,
      runtime,
      source,
      sessionId,
    ) ?? '';
  }
  if (patch.reasoningEffort !== undefined) {
    normalized.reasoningEffort = coerceExternalRuntimeReasoningEffort(
      patch.reasoningEffort,
      runtime,
      source,
      sessionId,
    ) ?? '';
  }
  return normalized;
}

export function applyDesiredExternalRuntimeConfigPatch(patch: ExternalRuntimeConfigPatch): void {
  if (patch.model !== undefined) desiredModel = patch.model;
  if (patch.permissionMode !== undefined) desiredPermissionMode = patch.permissionMode;
  if (patch.reasoningEffort !== undefined) desiredReasoningEffort = patch.reasoningEffort;
}

export function isCurrentExternalSessionSnapshotted(sessionId: string): boolean {
  if (!sessionId) return false;
  const meta = getSessionMetadata(sessionId);
  return Boolean(meta?.configSnapshotAt);
}

export function isExternalRuntimeConfigPatchNoopAgainstDesired(
  patch: ExternalRuntimeConfigPatch,
  options: { allowLiveReportedModel: boolean },
): boolean {
  return isRuntimeConfigPatchNoopAgainstDesired(
    patch,
    {
      desiredModel,
      liveReportedModel,
      desiredPermissionMode,
      desiredReasoningEffort,
    },
    options,
  );
}

export function restoreExternalRuntimeConfigFromMetadata(params: {
  model?: string | null;
  permissionMode?: string | null;
  reasoningEffort?: string | null;
  runtimeReportedModel?: string | null;
  runtime: RuntimeType;
  sessionId: string;
}): void {
  liveReportedModel = params.runtimeReportedModel || '';
  if (params.model) {
    const restoredModel = coerceExternalRuntimeModel(
      params.model,
      params.runtime,
      'restore-metadata',
      params.sessionId,
    );
    if (restoredModel !== undefined) desiredModel = restoredModel;
  }
  if (params.permissionMode) {
    const restoredPermissionMode = coerceExternalRuntimePermissionMode(
      params.permissionMode,
      params.runtime,
      'restore-metadata',
      params.sessionId,
    );
    if (restoredPermissionMode !== undefined) desiredPermissionMode = restoredPermissionMode;
  }
  desiredReasoningEffort = coerceExternalRuntimeReasoningEffort(
    params.reasoningEffort ?? undefined,
    params.runtime,
    'restore-metadata',
    params.sessionId,
  ) ?? '';
}

export function runtimeConfigPatchHasKeys(patch: ExternalRuntimeConfigPatch): boolean {
  return runtimeConfigPatchKeys(patch).length > 0;
}
