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
  if (!enabled) return { key: 'general.proxyScopeDisabledHint' };
  if (scope.mode === 'all') return { key: 'general.proxyScopeAllSummary' };

  const generalRequests = scope.generalRequests === true;
  if (!generalRequests && selectedProviderNames.length === 0) {
    return { key: 'general.proxyScopeCustomEmptySummary' };
  }
  if (generalRequests && selectedProviderNames.length === 0) {
    return { key: 'general.proxyScopeCustomGeneralOnlySummary' };
  }

  const providerSummary: ProxyScopeSummaryDescriptor = selectedProviderNames.length <= 3
    ? { key: 'general.proxyScopeProviderNames', values: { names: selectedProviderNames.join(', ') } }
    : { key: 'general.proxyScopeProviderCount', values: { count: selectedProviderNames.length } };
  return {
    key: generalRequests
      ? 'general.proxyScopeCustomGeneralOnSummary'
      : 'general.proxyScopeCustomGeneralOffSummary',
    values: {
      providerSummaryKey: providerSummary.key,
      ...providerSummary.values,
    },
  };
}
