import type { ProxyScopeSettings } from '../../../shared/config-types';

export interface ProxyScopeSummaryDescriptor {
  key: string;
  values?: Record<string, string | number>;
}

export function describeProxyScopeSummary(args: {
  enabled: boolean;
  scope: ProxyScopeSettings;
  selectedProviderNames: string[];
}): ProxyScopeSummaryDescriptor {
  const { enabled, scope, selectedProviderNames } = args;
  if (!enabled) return { key: 'proxy.scopeDisabledHint' };
  if (scope.mode === 'all') return { key: 'proxy.scopeAllSummary' };

  const generalRequests = scope.generalRequests === true;
  if (!generalRequests && selectedProviderNames.length === 0) {
    return { key: 'proxy.scopeCustomEmptySummary' };
  }
  if (generalRequests && selectedProviderNames.length === 0) {
    return { key: 'proxy.scopeCustomGeneralOnlySummary' };
  }

  const providerSummary: ProxyScopeSummaryDescriptor = selectedProviderNames.length <= 3
    ? { key: 'proxy.scopeProviderNames', values: { names: selectedProviderNames.join(', ') } }
    : { key: 'proxy.scopeProviderCount', values: { count: selectedProviderNames.length } };
  return {
    key: generalRequests
      ? 'proxy.scopeCustomGeneralOnSummary'
      : 'proxy.scopeCustomGeneralOffSummary',
    values: {
      providerSummaryKey: providerSummary.key,
      ...providerSummary.values,
    },
  };
}
