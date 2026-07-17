import { describe, expect, it } from 'vitest';

import { describeProxyScopeSummary } from './proxyScopePresentation';

describe('describeProxyScopeSummary', () => {
  it('describes all and disabled modes', () => {
    expect(describeProxyScopeSummary({
      enabled: false,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    }).key).toBe('general.proxyScopeDisabledHint');
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    }).key).toBe('general.proxyScopeAllSummary');
  });

  it('covers explicit zero and general-only custom scopes', () => {
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: false, providerIds: [] },
      selectedProviderNames: [],
    }).key).toBe('general.proxyScopeCustomEmptySummary');
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: true, providerIds: [] },
      selectedProviderNames: [],
    }).key).toBe('general.proxyScopeCustomGeneralOnlySummary');
  });

  it('distinguishes general on and off with selected providers', () => {
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub'] },
      selectedProviderNames: ['Anthropic'],
    })).toEqual({
      key: 'general.proxyScopeCustomGeneralOnSummary',
      values: {
        providerSummaryKey: 'general.proxyScopeProviderNames',
        names: 'Anthropic',
      },
    });
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: false, providerIds: ['a', 'b', 'c', 'd'] },
      selectedProviderNames: ['A', 'B', 'C', 'D'],
    })).toEqual({
      key: 'general.proxyScopeCustomGeneralOffSummary',
      values: {
        providerSummaryKey: 'general.proxyScopeProviderCount',
        count: 4,
      },
    });
  });
});
