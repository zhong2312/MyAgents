import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import type { SessionMetadata } from '../types/session';

/** Resolve the effective Claude SDK identity without treating it as resume proof. */
export function resolveBuiltinSdkSessionId(meta: SessionMetadata): string | undefined {
  return meta.sdkSessionId ?? (meta.unifiedSession ? meta.id : undefined);
}

/**
 * `managed-provider` is not a generic source: it is the ownership marker for
 * MyAgents-managed Codex. Older Agent-level runtime comparison could freeze an
 * impossible `builtin/managed-provider` pair into session metadata. Repair that
 * contradiction at the storage read boundary so every consumer sees one
 * canonical identity; the next ordinary metadata write persists the repair.
 */
export function normalizeSessionRuntimeIdentity(session: SessionMetadata): SessionMetadata {
  if (session.runtimeSource !== 'managed-provider' || session.runtime === 'codex') {
    return session;
  }

  const normalized: SessionMetadata = {
    ...session,
    runtime: 'codex',
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
  };
  delete normalized.providerRoute;
  delete normalized.providerEnvJson;
  if (normalized.providerExecutionIdentity?.runtimeSource !== 'managed-provider'
      || normalized.providerExecutionIdentity.runtime !== 'codex') {
    delete normalized.providerExecutionIdentity;
  }
  return normalized;
}
