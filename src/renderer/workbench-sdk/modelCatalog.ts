import { useMemo } from "react";

import { useAvailableProviders } from "@/hooks/useAvailableProviders";
import { isRuntimeBackedProvider } from "../../shared/providerExecution";

export interface WorkbenchAvailableModel {
  readonly model: string;
  readonly modelName: string;
}

export interface WorkbenchAvailableProvider {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly primaryModel: string;
  readonly models: readonly WorkbenchAvailableModel[];
  readonly runtimeBacked: boolean;
}

/**
 * Stable Workbench projection of the host's usable provider catalogue.
 * Provider credentials and host-only configuration never cross this boundary.
 */
export function useWorkbenchAvailableProviders(): readonly WorkbenchAvailableProvider[] {
  const providers = useAvailableProviders();
  return useMemo(
    () =>
      providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        vendor: provider.vendor,
        primaryModel: provider.primaryModel,
        models: provider.models.map((model) => ({
          model: model.model,
          modelName: model.modelName,
        })),
        runtimeBacked: isRuntimeBackedProvider(provider),
      })),
    [providers],
  );
}
