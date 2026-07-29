import { describe, expect, it } from 'vitest';

import { describeProxyScopeSummary } from './proxyScopePresentation';

describe('describeProxyScopeSummary', () => {
  it('describes all and disabled modes', () => {
    expect(describeProxyScopeSummary({
      enabled: false,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    }).key).toBe('proxy.scopeDisabledHint');
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    }).key).toBe('proxy.scopeAllSummary');
  });

  it('covers explicit zero and general-only custom scopes', () => {
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: false, providerIds: [] },
      selectedProviderNames: [],
    }).key).toBe('proxy.scopeCustomEmptySummary');
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: true, providerIds: [] },
      selectedProviderNames: [],
    }).key).toBe('proxy.scopeCustomGeneralOnlySummary');
  });

  it('distinguishes general on and off with selected providers', () => {
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub'] },
      selectedProviderNames: ['Anthropic'],
    })).toEqual({
      key: 'proxy.scopeCustomGeneralOnSummary',
      values: {
        providerSummaryKey: 'proxy.scopeProviderNames',
        names: 'Anthropic',
      },
    });
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'custom', generalRequests: false, providerIds: ['a', 'b', 'c', 'd'] },
      selectedProviderNames: ['A', 'B', 'C', 'D'],
    })).toEqual({
      key: 'proxy.scopeCustomGeneralOffSummary',
      values: {
        providerSummaryKey: 'proxy.scopeProviderCount',
        count: 4,
      },
    });
  });
});
