import { createHash } from 'node:crypto';
import type { McpServerDefinition } from '../../../shared/config-types';
import type { RuntimeDiagnostics } from '../../../shared/types/runtime';
import { mcpConfigFingerprint } from '../../session-core/mcp-sync-policy';
import type {
  ManagedCodexExtensionSnapshot,
  ManagedCodexExtensionStatus,
} from '../managed-codex/extensions/contracts';

type ManagedCodexDurableExtensionApplyState =
  | 'applied'
  | 'pending_next_start'
  | 'deferred_until_idle'
  | 'failed';

let desiredSnapshot: ManagedCodexExtensionSnapshot | null = null;
let desiredApplyFingerprint: string | null = null;
let effectiveRevision: string | null = null;
let effectiveApplyFingerprint: string | null = null;
let effectiveProcessGeneration: string | null = null;
let applyState: ManagedCodexDurableExtensionApplyState = 'pending_next_start';
let lastFailure: string | null = null;
let sessionEnabledPluginIds: string[] | null = null;
let sessionMcpServers: McpServerDefinition[] | null = null;
let extensionRestartPending = false;
let pendingHostCatalogBirth: { fingerprint: string } | null = null;
let activeHostCatalog: { threadId: string; fingerprint: string } | null = null;
let runtimeDiagnostics: RuntimeDiagnostics | null = null;

function applyFingerprint(snapshot: ManagedCodexExtensionSnapshot): string {
  return createHash('sha256')
    .update(mcpConfigFingerprint(snapshot.mcpServers))
    .digest('hex');
}

function normalizedIds(ids: readonly string[] | null): string[] | null {
  return ids === null ? null : [...new Set(ids)].sort();
}

export function resolveManagedCodexMcpSelection(
  requestedIds: readonly string[],
  availableServers: readonly McpServerDefinition[],
): McpServerDefinition[] {
  const byId = new Map(availableServers.map(server => [server.id, server]));
  const unknownIds = requestedIds.filter(id => !byId.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown Managed Codex MCP selection: ${unknownIds.join(', ')}`);
  }
  return requestedIds.map(id => byId.get(id)!);
}

function statusComponents(snapshot: ManagedCodexExtensionSnapshot | null) {
  if (!snapshot) return [];
  return snapshot.components.map(result => {
    if (result.state !== 'applied') return result;
    if (applyState === 'pending_next_start' || applyState === 'deferred_until_idle') {
      return { ...result, state: applyState };
    }
    if (applyState === 'failed') {
      return {
        ...result,
        state: 'failed' as const,
        code: 'extension_reconcile_failed',
        ...(lastFailure ? { message: lastFailure } : {}),
      };
    }
    return result;
  });
}

export function getManagedCodexExtensionStatus(): ManagedCodexExtensionStatus {
  return {
    desiredRevision: desiredSnapshot?.revision ?? '',
    effectiveRevision,
    state: applyState,
    components: statusComponents(desiredSnapshot),
  };
}

export function getManagedCodexDesiredSnapshot(): ManagedCodexExtensionSnapshot | null {
  return desiredSnapshot;
}

export function setManagedCodexDesiredSnapshot(
  incomingSnapshot: ManagedCodexExtensionSnapshot,
  disposition: 'no-live-process' | 'idle-process' | 'busy-process',
): ManagedCodexExtensionStatus {
  const incomingApplyFingerprint = applyFingerprint(incomingSnapshot);
  const snapshot = desiredSnapshot?.revision === incomingSnapshot.revision
    && desiredApplyFingerprint === incomingApplyFingerprint
    && desiredSnapshot.hostToolDispatcher
    && !incomingSnapshot.hostToolDispatcher
    ? {
        ...incomingSnapshot,
        dynamicTools: [...desiredSnapshot.dynamicTools],
        hostToolDispatcher: desiredSnapshot.hostToolDispatcher,
        components: [
          ...incomingSnapshot.components.filter(result => result.component !== 'host_tools'),
          ...desiredSnapshot.components.filter(result => result.component === 'host_tools'),
        ],
      }
    : incomingSnapshot;
  const wasDesired = desiredSnapshot?.revision === snapshot.revision
    && desiredApplyFingerprint === incomingApplyFingerprint;
  desiredSnapshot = snapshot;
  desiredApplyFingerprint = incomingApplyFingerprint;
  lastFailure = null;
  let unchanged = false;
  if (
    snapshot.revision === effectiveRevision
    && incomingApplyFingerprint === effectiveApplyFingerprint
  ) {
    // `unchanged` describes this reconciliation operation, not the durable
    // generation state. Keeping the owner state `applied` prevents a repeated
    // config hydration from looking like a new runtime transition.
    unchanged = wasDesired;
    applyState = 'applied';
  } else if (disposition === 'busy-process') {
    applyState = 'deferred_until_idle';
  } else {
    applyState = 'pending_next_start';
  }
  const status = getManagedCodexExtensionStatus();
  if (!unchanged) return status;
  return {
    ...status,
    state: 'unchanged',
    components: status.components.map(component => (
      component.state === 'applied'
        ? { ...component, state: 'unchanged' as const }
        : component
    )),
  };
}

export function markManagedCodexExtensionEffective(
  snapshot: ManagedCodexExtensionSnapshot,
  processGeneration: string,
): ManagedCodexExtensionStatus {
  desiredSnapshot = snapshot;
  desiredApplyFingerprint = applyFingerprint(snapshot);
  effectiveRevision = snapshot.revision;
  effectiveApplyFingerprint = desiredApplyFingerprint;
  effectiveProcessGeneration = processGeneration;
  applyState = 'applied';
  lastFailure = null;
  return getManagedCodexExtensionStatus();
}

export function markManagedCodexExtensionFailed(message: string): ManagedCodexExtensionStatus {
  applyState = 'failed';
  lastFailure = message;
  return getManagedCodexExtensionStatus();
}

export function releaseManagedCodexExtensionGeneration(processGeneration?: string): void {
  if (processGeneration && effectiveProcessGeneration && processGeneration !== effectiveProcessGeneration) return;
  desiredSnapshot?.hostToolDispatcher?.dispose('Managed Codex process generation ended');
  effectiveRevision = null;
  effectiveApplyFingerprint = null;
  effectiveProcessGeneration = null;
  if (desiredSnapshot) applyState = 'pending_next_start';
}

export function setManagedCodexSessionEnabledPluginIds(ids: readonly string[] | null): void {
  sessionEnabledPluginIds = normalizedIds(ids);
}

export function getManagedCodexSessionEnabledPluginIds(): string[] | null {
  return sessionEnabledPluginIds ? [...sessionEnabledPluginIds] : null;
}

export function setManagedCodexSessionMcpServers(servers: readonly McpServerDefinition[]): void {
  sessionMcpServers = servers.map(server => ({
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  }));
}

export function getManagedCodexSessionMcpServers(): McpServerDefinition[] | null {
  return sessionMcpServers?.map(server => ({
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  })) ?? null;
}

export function setManagedCodexExtensionRestartPending(value: boolean): void {
  extensionRestartPending = value;
}

export function isManagedCodexExtensionRestartPending(): boolean {
  return extensionRestartPending;
}

function clearManagedCodexHostCatalogState(): void {
  pendingHostCatalogBirth = null;
  activeHostCatalog = null;
}

export function setPendingManagedCodexHostCatalogBirth(value: { fingerprint: string } | null): void {
  pendingHostCatalogBirth = value;
}

export function takePendingManagedCodexHostCatalogBirth(): { fingerprint: string } | null {
  const value = pendingHostCatalogBirth;
  pendingHostCatalogBirth = null;
  return value;
}

export function setActiveManagedCodexHostCatalog(value: { threadId: string; fingerprint: string } | null): void {
  activeHostCatalog = value;
}

export function getActiveManagedCodexHostCatalog(): { threadId: string; fingerprint: string } | null {
  return activeHostCatalog;
}

export function setManagedCodexRuntimeDiagnostics(value: RuntimeDiagnostics): void {
  runtimeDiagnostics = value;
}

export function getManagedCodexRuntimeDiagnostics(): RuntimeDiagnostics | null {
  return runtimeDiagnostics;
}

export function resetManagedCodexExtensionState(): void {
  desiredSnapshot?.hostToolDispatcher?.dispose('Managed Codex Product Session reset');
  desiredSnapshot = null;
  desiredApplyFingerprint = null;
  effectiveRevision = null;
  effectiveApplyFingerprint = null;
  effectiveProcessGeneration = null;
  applyState = 'pending_next_start';
  lastFailure = null;
  sessionEnabledPluginIds = null;
  sessionMcpServers = null;
  extensionRestartPending = false;
  runtimeDiagnostics = null;
  clearManagedCodexHostCatalogState();
}
