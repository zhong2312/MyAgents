import { describe, expect, it } from 'vitest';

import type { Provider } from './config-types';
import { buildAvailableProvidersProjection } from './availableProvidersProjection';

function provider(id: string, type: Provider['type'] = 'api'): Provider {
  return {
    id,
    name: `${id} name`,
    vendor: 'test',
    cloudProvider: 'test',
    type,
    primaryModel: `${id}-primary`,
    isBuiltin: false,
    config: { baseUrl: `https://${id}.example/v1` },
    authType: 'api_key',
    models: [
      { model: `${id}-primary`, modelName: 'Primary', modelSeries: id },
      { model: `${id}-secondary`, modelName: 'Secondary', modelSeries: id },
    ],
  };
}

describe('available provider projection', () => {
  it('owns credential filtering, primary overrides, and the IM wire shape', () => {
    const api = provider('api');
    const subscription = provider('subscription', 'subscription');
    const disabled = { ...provider('disabled'), enabled: false };
    const runtime = {
      ...provider('runtime'),
      execution: { kind: 'runtime-backed' as const, runtime: 'codex' as const, source: 'managed-provider' as const },
    };

    expect(buildAvailableProvidersProjection({
      providers: [api, subscription, disabled, runtime],
      apiKeys: { api: ' key ', disabled: 'key', runtime: 'key' },
      verifyStatus: {
        subscription: { status: 'valid', verifiedAt: '2026-07-23T00:00:00.000Z' },
      },
      primaryModels: { api: 'api-secondary' },
    })).toEqual([
      {
        id: 'api',
        name: 'api name',
        primaryModel: 'api-secondary',
        baseUrl: 'https://api.example/v1',
        authType: 'api_key',
        apiProtocol: undefined,
        apiKey: ' key ',
        models: [
          { model: 'api-primary', modelName: 'Primary' },
          { model: 'api-secondary', modelName: 'Secondary' },
        ],
      },
      {
        id: 'subscription',
        name: 'subscription name',
        primaryModel: 'subscription-primary',
        baseUrl: 'https://subscription.example/v1',
        authType: 'api_key',
        apiProtocol: undefined,
        apiKey: undefined,
        models: [
          { model: 'subscription-primary', modelName: 'Primary' },
          { model: 'subscription-secondary', modelName: 'Secondary' },
        ],
      },
    ]);
  });
});
