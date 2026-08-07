import type { RuntimeConfig, RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { agentUsesManagedCodexProvider } from '../../shared/providerExecution';

type AgentRuntimeDefaults = {
  providerId?: string | null;
  runtime?: RuntimeType | null;
  runtimeConfig?: RuntimeConfig | null;
};

export type RuntimeModelCatalogIdentity = {
  runtime: RuntimeType;
  source?: RuntimeSource;
};

export function runtimeModelCatalogPath(
  runtime: RuntimeType,
  source?: RuntimeSource,
): string {
  const params = new URLSearchParams({ type: runtime });
  if (runtime === 'codex') {
    params.set('source', source ?? 'system-cli');
  }
  return `/api/runtime/models?${params.toString()}`;
}

export function resolveRuntimeModelCatalogIdentity(
  runtimeOverride: RuntimeType | undefined,
  runtimeConfig: RuntimeConfig | undefined,
  inheritedIdentity: RuntimeModelCatalogIdentity,
): RuntimeModelCatalogIdentity {
  const runtime = runtimeOverride ?? inheritedIdentity.runtime;
  if (runtime !== 'codex') return { runtime };
  const source = runtimeOverride === undefined
    ? inheritedIdentity.source
    : runtimeConfig?.source;
  return { runtime, source: source ?? 'system-cli' };
}

export function resolveAgentRuntimeModelCatalogIdentity(
  agent: AgentRuntimeDefaults | null | undefined,
): RuntimeModelCatalogIdentity {
  if (agentUsesManagedCodexProvider(agent)) {
    return { runtime: 'codex', source: 'managed-provider' };
  }
  const runtime = agent?.runtime ?? 'builtin';
  return runtime === 'codex'
    ? { runtime, source: agent?.runtimeConfig?.source ?? 'system-cli' }
    : { runtime };
}

export function clearRuntimeModelOverride(
  runtimeConfig: RuntimeConfig | undefined,
): RuntimeConfig | undefined {
  if (!runtimeConfig?.model) return runtimeConfig;
  const next = { ...runtimeConfig };
  delete next.model;
  return Object.keys(next).length > 0 ? next : undefined;
}
