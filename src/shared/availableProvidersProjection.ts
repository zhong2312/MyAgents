import type { Provider, ProviderVerifyStatus } from './config-types';
import { isProviderEnabled } from './config-types';
import { isBuiltinExecutionProvider } from './providerExecution';

export interface AvailableProviderProjection {
  id: string;
  name: string;
  primaryModel?: string;
  baseUrl?: string;
  authType?: Provider['authType'];
  apiProtocol?: Provider['apiProtocol'];
  apiKey?: string;
  models: Array<{ model: string; modelName: string }>;
}

interface AvailableProviderProjectionInput {
  providers: readonly Provider[];
  apiKeys: Readonly<Record<string, string>>;
  verifyStatus: Readonly<Record<string, ProviderVerifyStatus>>;
  primaryModels?: Readonly<Record<string, string>>;
}

/**
 * Build the derived provider projection consumed by Rust IM commands.
 *
 * Provider discovery/merging remains process-owned because renderer and
 * Sidecar read files through different adapters. Availability and wire-shape
 * policy live here once so every writer persists the same derived cache.
 */
export function buildAvailableProvidersProjection({
  providers,
  apiKeys,
  verifyStatus,
  primaryModels,
}: AvailableProviderProjectionInput): AvailableProviderProjection[] {
  return providers
    .filter(provider => {
      if (!isBuiltinExecutionProvider(provider) || !isProviderEnabled(provider)) return false;
      if (provider.type === 'subscription') {
        return verifyStatus[provider.id]?.status === 'valid';
      }
      return (apiKeys[provider.id]?.trim().length ?? 0) > 0;
    })
    .map(provider => {
      const models = (Array.isArray(provider.models) ? provider.models : [])
        .flatMap(model => {
          const modelId = typeof model?.model === 'string' ? model.model.trim() : '';
          if (!modelId) return [];
          const modelName = typeof model.modelName === 'string' && model.modelName.trim()
            ? model.modelName
            : modelId;
          return [{ model: modelId, modelName }];
        });
      const configuredPrimary = primaryModels?.[provider.id];
      const declaredPrimary = typeof provider.primaryModel === 'string'
        ? provider.primaryModel
        : models[0]?.model;
      const primaryModel = configuredPrimary && models.some(model => model.model === configuredPrimary)
        ? configuredPrimary
        : declaredPrimary;
      const baseUrl = typeof provider.config?.baseUrl === 'string'
        ? provider.config.baseUrl
        : undefined;
      return {
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : provider.id,
        primaryModel,
        baseUrl,
        authType: provider.authType,
        apiProtocol: provider.apiProtocol,
        apiKey: provider.type !== 'subscription' ? apiKeys[provider.id] : undefined,
        models,
      };
    });
}

export function buildAvailableProvidersJson(
  input: AvailableProviderProjectionInput,
): string | undefined {
  const projection = buildAvailableProvidersProjection(input);
  return projection.length > 0 ? JSON.stringify(projection) : undefined;
}
