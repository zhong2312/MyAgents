import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import { normalizeRuntime, type RuntimeSource, type RuntimeType } from '../../shared/types/runtime';

// Runtime normalization remains re-exported for renderer callers. Session
// navigation itself no longer compares runtimes because existing Sessions never
// hot-swap the current Tab's process identity.
export { normalizeRuntime, resolveEffectiveRuntime } from '../../shared/types/runtime';

export interface SessionOpenTabState {
  id: string;
  sessionId: string | null;
}

export interface SessionRuntimeIdentity {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
}

export interface SessionRuntimeMetadataForOpen {
  runtime?: string | null;
  runtimeSource?: RuntimeSource | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
}

export type SessionOpenPlan =
  | { type: 'jump-to-tab'; tabId: string }
  | { type: 'open-new-tab' };

export interface SessionOpenPlanInput {
  tabs: readonly SessionOpenTabState[];
  targetSessionId: string;
}

function normalizeRuntimeSourceForIdentity(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | null | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

export function sessionRuntimeIdentityFromMetadataForOpen(
  metadata: SessionRuntimeMetadataForOpen | null | undefined,
  fallbackRuntime: RuntimeType,
): SessionRuntimeIdentity {
  const runtimeBackedIdentity = metadata?.providerExecutionIdentity;
  if (runtimeBackedIdentity?.kind === 'runtime-backed-provider') {
    return {
      runtime: runtimeBackedIdentity.runtime,
      runtimeSource: runtimeBackedIdentity.runtimeSource,
    };
  }

  const runtime = metadata?.runtime ? normalizeRuntime(metadata.runtime) : fallbackRuntime;
  return {
    runtime,
    runtimeSource: normalizeRuntimeSourceForIdentity(runtime, metadata?.runtimeSource),
  };
}

export function planSessionOpen(input: SessionOpenPlanInput): SessionOpenPlan {
  const existingTab = input.tabs.find((tab) => tab.sessionId === input.targetSessionId);
  if (existingTab) {
    return { type: 'jump-to-tab', tabId: existingTab.id };
  }

  return { type: 'open-new-tab' };
}
