import { randomUUID } from 'node:crypto';

import { isPendingSessionId } from '../../shared/constants';
import { originFromMaterializationScenario, type SessionOrigin } from '../../shared/session-origin';
import {
  deleteSession,
  getSessionMetadata,
  saveSessionMetadata,
  updateSessionMetadata,
} from '../SessionStore';
import { createSessionMetadata, type SessionMetadata } from '../types/session';

export type ProductSessionSnapshotPatch = Pick<
  SessionMetadata,
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'mcpEnabledServers'
  | 'enabledPluginIds'
  | 'enabledOfficialToolIds'
  | 'providerId'
  | 'providerRoute'
  | 'providerEnvJson'
>;

export type PendingProductSessionMaterialization = {
  priorSessionId: string;
  targetSessionId: string;
  reusingNativeSession: boolean;
  snapshotKind: string;
};

export type ProductSessionMaterializationResult = {
  success: boolean;
  sessionId?: string;
  metadata?: SessionMetadata;
  error?: string;
  status?: number;
};

// Importing the SessionEngine facade is not Session birth authority. Global
// Sidecars load shared SDK utilities too, so the binding stays empty until the
// Session bootstrap (initializeAgent) or an explicit adapter reset selects an
// identity.
export let currentProductSessionId = '';
let allowLazySessionMaterialization = true;
let pendingDesktopMaterialization: PendingProductSessionMaterialization | null = null;
let currentProductSessionContext = {
  workspacePath: '',
  hasInitialPrompt: false,
};

publishCurrentProductSessionEnv();

export function getCurrentProductSessionId(): string {
  return currentProductSessionId;
}

export function setCurrentProductSessionId(nextSessionId: string): void {
  currentProductSessionId = nextSessionId;
  publishCurrentProductSessionEnv();
}

export function resetProductSessionBinding(options?: {
  sessionId?: string;
  workspacePath?: string;
  hasInitialPrompt?: boolean;
  allowLazySessionMaterialization?: boolean;
}): string {
  const nextSessionId = options?.sessionId ?? randomUUID();
  setCurrentProductSessionId(nextSessionId);
  allowLazySessionMaterialization = options?.allowLazySessionMaterialization ?? true;
  pendingDesktopMaterialization = null;
  currentProductSessionContext = {
    workspacePath: options?.workspacePath ?? currentProductSessionContext.workspacePath,
    hasInitialPrompt: options?.hasInitialPrompt ?? false,
  };
  return nextSessionId;
}

export function setCurrentProductSessionContext(context: {
  workspacePath: string;
  hasInitialPrompt: boolean;
}): void {
  currentProductSessionContext = { ...context };
}

export function getCurrentProductSessionContext(): {
  workspacePath: string;
  hasInitialPrompt: boolean;
} {
  return { ...currentProductSessionContext };
}

export function isLazySessionMaterializationAllowed(): boolean {
  return allowLazySessionMaterialization;
}

export function setLazySessionMaterializationAllowed(allowed: boolean): void {
  allowLazySessionMaterialization = allowed;
}

export function getPendingProductSessionMaterialization(): PendingProductSessionMaterialization | null {
  return pendingDesktopMaterialization;
}

export function setPendingProductSessionMaterialization(
  pending: PendingProductSessionMaterialization | null,
): void {
  pendingDesktopMaterialization = pending;
}

export function clearPendingProductSessionMaterialization(): void {
  pendingDesktopMaterialization = null;
}

export function resetProductSessionMaterializationState(options?: {
  allowLazySessionMaterialization?: boolean;
}): void {
  allowLazySessionMaterialization = options?.allowLazySessionMaterialization ?? true;
  pendingDesktopMaterialization = null;
}

function publishCurrentProductSessionEnv(): void {
  if (currentProductSessionId) {
    process.env.MYAGENTS_SESSION_ID = currentProductSessionId;
  } else {
    delete process.env.MYAGENTS_SESSION_ID;
  }
}

function preparedMaterializationOwnsMetadata(
  prepared: PendingProductSessionMaterialization,
  metadata: SessionMetadata,
): boolean {
  return metadata.materializationState === 'prepared'
    && metadata.materializationSourceSessionId === prepared.priorSessionId;
}

export function applyProductSessionSnapshotPatch(
  metadata: SessionMetadata,
  patch: Partial<{
    [K in keyof ProductSessionSnapshotPatch]: ProductSessionSnapshotPatch[K] | null;
  }> | undefined,
): void {
  if (!patch) return;
  let wroteSnapshot = false;
  const apply = <K extends keyof ProductSessionSnapshotPatch>(
    key: K,
    value: ProductSessionSnapshotPatch[K] | null | undefined,
  ) => {
    if (value === undefined) return;
    if (value === null) {
      delete metadata[key];
    } else {
      metadata[key] = value as never;
    }
    wroteSnapshot = true;
  };
  apply('model', patch.model);
  apply('reasoningEffort', patch.reasoningEffort);
  apply('permissionMode', patch.permissionMode);
  apply('mcpEnabledServers', patch.mcpEnabledServers);
  apply('enabledPluginIds', patch.enabledPluginIds);
  apply('enabledOfficialToolIds', patch.enabledOfficialToolIds);
  apply('providerId', patch.providerId);
  apply('providerRoute', patch.providerRoute);
  apply('providerEnvJson', patch.providerEnvJson);
  if (wroteSnapshot) metadata.configSnapshotAt = new Date().toISOString();
}

function buildProductSessionSnapshotMetadataPatch(
  patch: Partial<{
    [K in keyof ProductSessionSnapshotPatch]: ProductSessionSnapshotPatch[K] | null;
  }> | undefined,
): Partial<ProductSessionSnapshotPatch> & Pick<SessionMetadata, 'configSnapshotAt'> | null {
  if (!patch) return null;
  const updates: Partial<ProductSessionSnapshotPatch> & Partial<Pick<SessionMetadata, 'configSnapshotAt'>> = {};
  let wroteSnapshot = false;
  const apply = <K extends keyof ProductSessionSnapshotPatch>(
    key: K,
    value: ProductSessionSnapshotPatch[K] | null | undefined,
  ) => {
    if (value === undefined) return;
    updates[key] = value === null ? undefined as never : value as never;
    wroteSnapshot = true;
  };
  apply('model', patch.model);
  apply('reasoningEffort', patch.reasoningEffort);
  apply('permissionMode', patch.permissionMode);
  apply('mcpEnabledServers', patch.mcpEnabledServers);
  apply('enabledPluginIds', patch.enabledPluginIds);
  apply('enabledOfficialToolIds', patch.enabledOfficialToolIds);
  apply('providerId', patch.providerId);
  apply('providerRoute', patch.providerRoute);
  apply('providerEnvJson', patch.providerEnvJson);
  if (!wroteSnapshot) return null;
  updates.configSnapshotAt = new Date().toISOString();
  return updates as Partial<ProductSessionSnapshotPatch> & Pick<SessionMetadata, 'configSnapshotAt'>;
}

export async function preparePendingProductSession(
  request: {
    snapshotPatch?: Partial<{
      [K in keyof ProductSessionSnapshotPatch]: ProductSessionSnapshotPatch[K] | null;
    }>;
    origin?: SessionOrigin;
  },
  options: {
    hasActiveWork: boolean;
    createPreparedMetadata: (priorSessionId: string) => {
      targetSessionId: string;
      reusingNativeSession: boolean;
      snapshotKind: string;
      metadata: SessionMetadata;
    };
  },
): Promise<ProductSessionMaterializationResult> {
  if (!currentProductSessionId) {
    return { success: false, error: 'No active session.', status: 400 };
  }
  if (options.hasActiveWork) {
    return {
      success: false,
      error: 'Pending session already has active work; refusing to remap it.',
      status: 409,
    };
  }

  const pending = pendingDesktopMaterialization;
  if (pending) {
    const metadata = getSessionMetadata(pending.targetSessionId);
    if (metadata) {
      if (!preparedMaterializationOwnsMetadata(pending, metadata)) {
        return {
          success: false,
          error: `Prepared session ${pending.targetSessionId} is not owned by the pending materialization.`,
          status: 409,
        };
      }
      const snapshotPatch = buildProductSessionSnapshotMetadataPatch(request.snapshotPatch);
      const preparedPatch = {
        ...(snapshotPatch ?? {}),
        ...(request.origin ? { origin: request.origin } : {}),
      };
      if (Object.keys(preparedPatch).length === 0) {
        return { success: true, sessionId: pending.targetSessionId, metadata };
      }
      const updated = await updateSessionMetadata(
        pending.targetSessionId,
        preparedPatch,
        current => preparedMaterializationOwnsMetadata(pending, current),
      );
      if (updated) return { success: true, sessionId: pending.targetSessionId, metadata: updated };
      const latest = getSessionMetadata(pending.targetSessionId);
      if (!latest) {
        pendingDesktopMaterialization = null;
        return {
          success: false,
          error: `Prepared session ${pending.targetSessionId} disappeared before prepare patch.`,
          status: 404,
        };
      }
      return {
        success: false,
        error: preparedMaterializationOwnsMetadata(pending, latest)
          ? `Failed to update prepared session ${pending.targetSessionId}.`
          : `Prepared session ${pending.targetSessionId} is not owned by the pending materialization.`,
        status: preparedMaterializationOwnsMetadata(pending, latest) ? 500 : 409,
      };
    }
    pendingDesktopMaterialization = null;
  }

  if (!isPendingSessionId(currentProductSessionId)) {
    const metadata = getSessionMetadata(currentProductSessionId);
    if (metadata) return { success: true, sessionId: currentProductSessionId, metadata };
    if (!allowLazySessionMaterialization) {
      return { success: false, error: 'Active session is not pending and has no metadata.', status: 404 };
    }
  }

  const prepared = options.createPreparedMetadata(currentProductSessionId);
  if (getSessionMetadata(prepared.targetSessionId)) {
    return { success: false, error: `Session ${prepared.targetSessionId} already exists.`, status: 409 };
  }
  applyProductSessionSnapshotPatch(prepared.metadata, request.snapshotPatch);
  if (request.origin) prepared.metadata.origin = request.origin;
  prepared.metadata.materializationState = 'prepared';
  prepared.metadata.materializationSourceSessionId = currentProductSessionId;
  await saveSessionMetadata(prepared.metadata);
  if (!getSessionMetadata(prepared.targetSessionId)) {
    return { success: false, error: `Failed to prepare session ${prepared.targetSessionId}.`, status: 500 };
  }
  pendingDesktopMaterialization = {
    priorSessionId: currentProductSessionId,
    targetSessionId: prepared.targetSessionId,
    reusingNativeSession: prepared.reusingNativeSession,
    snapshotKind: prepared.snapshotKind,
  };
  return { success: true, sessionId: prepared.targetSessionId, metadata: prepared.metadata };
}

export async function commitPendingProductSession(options: {
  preparedSessionId?: string;
  beforeBind?: (
    prepared: PendingProductSessionMaterialization,
    metadata: SessionMetadata,
  ) => Promise<void>;
  afterBind?: (
    prepared: PendingProductSessionMaterialization,
    metadata: SessionMetadata,
  ) => Promise<void> | void;
  bindSession?: (sessionId: string) => void;
} = {}): Promise<ProductSessionMaterializationResult> {
  if (!currentProductSessionId) {
    return { success: false, error: 'No active session.', status: 400 };
  }
  const prepared = pendingDesktopMaterialization;
  if (!prepared) {
    const metadata = !isPendingSessionId(currentProductSessionId)
      ? getSessionMetadata(currentProductSessionId)
      : null;
    if (
      metadata
      && metadata.materializationState !== 'prepared'
      && (!options.preparedSessionId || options.preparedSessionId === currentProductSessionId)
    ) {
      return { success: true, sessionId: currentProductSessionId, metadata };
    }
    return { success: false, error: 'No prepared pending materialization to commit.', status: 409 };
  }
  if (options.preparedSessionId && options.preparedSessionId !== prepared.targetSessionId) {
    return {
      success: false,
      error: `Prepared session mismatch: expected ${prepared.targetSessionId}, got ${options.preparedSessionId}.`,
      status: 409,
    };
  }
  if (
    currentProductSessionId !== prepared.priorSessionId
    && currentProductSessionId !== prepared.targetSessionId
  ) {
    return {
      success: false,
      error: `Active session changed before materialize commit: expected ${prepared.priorSessionId} or ${prepared.targetSessionId}, got ${currentProductSessionId}.`,
      status: 409,
    };
  }
  const metadata = getSessionMetadata(prepared.targetSessionId);
  if (!metadata) {
    pendingDesktopMaterialization = null;
    return {
      success: false,
      error: `Prepared session ${prepared.targetSessionId} disappeared before commit.`,
      status: 404,
    };
  }
  if (!preparedMaterializationOwnsMetadata(prepared, metadata)) {
    return {
      success: false,
      error: `Prepared session ${prepared.targetSessionId} is not owned by the pending materialization.`,
      status: 409,
    };
  }

  await options.beforeBind?.(prepared, metadata);
  const committedMetadata = await updateSessionMetadata(
    prepared.targetSessionId,
    {
      materializationState: undefined,
      materializationSourceSessionId: undefined,
    },
    current => preparedMaterializationOwnsMetadata(prepared, current),
  );
  if (!committedMetadata) {
    const latest = getSessionMetadata(prepared.targetSessionId);
    if (!latest) {
      pendingDesktopMaterialization = null;
      return {
        success: false,
        error: `Prepared session ${prepared.targetSessionId} disappeared before commit.`,
        status: 404,
      };
    }
    return {
      success: false,
      error: preparedMaterializationOwnsMetadata(prepared, latest)
        ? `Failed to durably commit prepared session ${prepared.targetSessionId}.`
        : `Prepared session ${prepared.targetSessionId} is not owned by the pending materialization.`,
      status: preparedMaterializationOwnsMetadata(prepared, latest) ? 500 : 409,
    };
  }

  (options.bindSession ?? setCurrentProductSessionId)(prepared.targetSessionId);
  allowLazySessionMaterialization = false;
  await options.afterBind?.(prepared, committedMetadata);
  pendingDesktopMaterialization = null;
  return {
    success: true,
    sessionId: prepared.targetSessionId,
    metadata: committedMetadata,
  };
}

export async function rollbackPendingProductSession(
  preparedSessionId?: string,
): Promise<ProductSessionMaterializationResult> {
  const prepared = pendingDesktopMaterialization;
  if (!prepared) {
    return preparedSessionId
      ? { success: false, error: 'No prepared pending materialization to roll back.', status: 409 }
      : { success: true };
  }
  const targetSessionId = preparedSessionId ?? prepared.targetSessionId;
  if (targetSessionId !== prepared.targetSessionId) {
    return {
      success: false,
      error: `Prepared session mismatch: expected ${prepared.targetSessionId}, got ${targetSessionId}.`,
      status: 409,
    };
  }
  const metadata = getSessionMetadata(targetSessionId);
  if (!metadata) {
    pendingDesktopMaterialization = null;
    return { success: true };
  }
  if (!preparedMaterializationOwnsMetadata(prepared, metadata)) {
    return {
      success: false,
      error: `Refusing to roll back non-owned materialization target ${targetSessionId}.`,
      status: 409,
    };
  }
  const deletion = await deleteSession(targetSessionId, {
    kind: 'prepared-materialization-rollback',
    sourceSessionId: prepared.priorSessionId,
  });
  if (deletion.deleted || !getSessionMetadata(targetSessionId)) {
    pendingDesktopMaterialization = null;
    return { success: true };
  }
  const latest = getSessionMetadata(targetSessionId)!;
  if (!preparedMaterializationOwnsMetadata(prepared, latest)) {
    return {
      success: false,
      error: `Refusing to roll back non-owned materialization target ${targetSessionId}.`,
      status: 409,
    };
  }
  if (deletion.reason === 'data-present' || deletion.reason === 'precondition-failed') {
    return {
      success: false,
      error: `Refusing to roll back prepared session ${targetSessionId}: ${deletion.reason}.`,
      status: 409,
    };
  }
  return {
    success: false,
    error: `Failed to delete prepared session ${targetSessionId}: ${deletion.reason}.`,
    status: 500,
  };
}

export async function freezeCurrentProductSessionMetadata(options: {
  workspacePath: string;
  snapshotPatch: Partial<SessionMetadata> & Pick<SessionMetadata, 'configSnapshotAt'>;
  allowMissingMetadata?: boolean;
}): Promise<ProductSessionMaterializationResult> {
  const targetSessionId = currentProductSessionId;
  if (!targetSessionId) return { success: false, error: 'No active session to freeze.' };
  const existing = getSessionMetadata(targetSessionId);
  if (existing?.configSnapshotAt) {
    if (!existing.origin) {
      const updated = await updateSessionMetadata(targetSessionId, {
        origin: originFromMaterializationScenario('agent-channel'),
      });
      if (!updated) {
        return { success: false, sessionId: targetSessionId, error: 'Failed to update session origin.' };
      }
      allowLazySessionMaterialization = false;
      return { success: true, sessionId: targetSessionId, metadata: updated };
    }
    allowLazySessionMaterialization = false;
    return { success: true, sessionId: targetSessionId, metadata: existing };
  }

  const patch = { ...options.snapshotPatch };
  if (!existing?.origin) patch.origin = originFromMaterializationScenario('agent-channel');
  if (existing) {
    const updated = await updateSessionMetadata(targetSessionId, patch);
    if (!updated) {
      return { success: false, sessionId: targetSessionId, error: 'Failed to update session metadata.' };
    }
    allowLazySessionMaterialization = false;
    return { success: true, sessionId: targetSessionId, metadata: updated };
  }
  if (!options.allowMissingMetadata) {
    return {
      success: false,
      sessionId: targetSessionId,
      error: `Session metadata not found for non-birth-pending IM session ${targetSessionId}.`,
    };
  }
  const metadata = createSessionMetadata(options.workspacePath, patch);
  metadata.id = targetSessionId;
  metadata.title = 'New Chat';
  await saveSessionMetadata(metadata);
  allowLazySessionMaterialization = false;
  return { success: true, sessionId: targetSessionId, metadata };
}

export async function publishCurrentProductSessionMetadata(
  createMetadata: (sessionId: string) => { metadata: SessionMetadata; snapshotKind: string },
): Promise<{ sessionId: string; metadata: SessionMetadata; snapshotKind: string }> {
  const targetSessionId = currentProductSessionId;
  const existing = getSessionMetadata(targetSessionId);
  if (existing) {
    allowLazySessionMaterialization = false;
    return { sessionId: targetSessionId, metadata: existing, snapshotKind: 'existing' };
  }
  const created = createMetadata(targetSessionId);
  await saveSessionMetadata(created.metadata);
  allowLazySessionMaterialization = false;
  return { sessionId: targetSessionId, ...created };
}
