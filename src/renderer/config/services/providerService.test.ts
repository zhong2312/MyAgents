import { describe, expect, it } from 'vitest';

import {
    CODEX_SUBSCRIPTION_PROVIDER_ID,
    DEFAULT_CONFIG,
    MANAGED_CODEX_PROVIDER,
    SUBSCRIPTION_PROVIDER_ID,
    applyProviderEnablementAndOrder,
    type Provider,
} from '../types';
import {
    getFirstAvailableProvider,
    isProviderAvailable,
    resolveBuiltinSelection,
    resolveProvider,
} from './providerService';

const makeProvider = (id: string, primaryModel = `${id}-model`): Provider => ({
    id,
    name: id,
    vendor: 'Test',
    cloudProvider: 'Test',
    type: 'api',
    primaryModel,
    isBuiltin: false,
    authType: 'api_key',
    config: { baseUrl: `https://${id}.example/v1` },
    models: [{ model: primaryModel, modelName: `${id} Model`, modelSeries: 'test' }],
});

describe('provider availability with enablement', () => {
    it('treats disabled providers as unavailable even when they have credentials', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta')],
            { disabledProviderIds: ['alpha'] },
        );
        const alpha = providers.find(provider => provider.id === 'alpha');

        expect(alpha).toBeDefined();
        expect(isProviderAvailable(alpha!, { alpha: 'configured-key' }, {})).toBe(false);
    });

    it('first available provider follows user ordering and skips disabled providers', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta'), makeProvider('gamma')],
            {
                providerOrder: ['gamma', 'alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );

        expect(getFirstAvailableProvider(providers, {
            alpha: 'alpha-key',
            beta: 'beta-key',
            gamma: 'gamma-key',
        }, {})?.id).toBe('gamma');
    });

    it('builtin selection falls through from a disabled default provider', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta', 'beta-primary')],
            {
                providerOrder: ['alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );
        const selection = resolveBuiltinSelection(
            {},
            { ...DEFAULT_CONFIG, defaultProviderId: 'alpha' },
            providers,
            {
                alpha: 'alpha-key',
                beta: 'beta-key',
            },
            {},
        );

        expect(selection?.provider.id).toBe('beta');
        expect(selection?.model).toBe('beta-primary');
    });

    it('falls back to an available provider that can serve the desired model', () => {
        const providers = [
            makeProvider('volcengine-api', 'api-primary'),
            {
                ...makeProvider('volcengine', 'deepseek-v4-flash-260425'),
                models: [
                    {
                        model: 'deepseek-v4-flash-260425',
                        modelName: 'deepseek-v4-flash',
                        modelSeries: 'volcengine',
                    },
                ],
            },
            makeProvider('other', 'other-primary'),
        ];
        const selection = resolveBuiltinSelection(
            {
                agent: {
                    id: 'agent-1',
                    name: 'Novel',
                    workspacePath: '/tmp/novel',
                    providerId: 'volcengine-api',
                    model: 'deepseek-v4-flash-260425',
                } as never,
            },
            DEFAULT_CONFIG,
            providers,
            {
                // Preferred provider has no key; sibling volcengine does.
                volcengine: 'volc-key',
                other: 'other-key',
            },
            {},
        );

        expect(selection?.provider.id).toBe('volcengine');
        expect(selection?.model).toBe('deepseek-v4-flash-260425');
    });

    it('requires runtime-backed providers to be ready and have discovered models', () => {
        expect(isProviderAvailable(
            MANAGED_CODEX_PROVIDER,
            {},
            { [CODEX_SUBSCRIPTION_PROVIDER_ID]: { status: 'valid', verifiedAt: '2026-06-26T00:00:00.000Z' } },
        )).toBe(false);

        expect(isProviderAvailable(
            { ...MANAGED_CODEX_PROVIDER, runtimeReady: true },
            {},
            {},
        )).toBe(false);

        expect(isProviderAvailable(
            {
                ...MANAGED_CODEX_PROVIDER,
                runtimeReady: true,
                primaryModel: 'gpt-5',
                models: [{ model: 'gpt-5', modelName: 'GPT-5', modelSeries: 'codex' }],
            },
            {},
            {},
        )).toBe(true);

        expect(isProviderAvailable(
            {
                ...MANAGED_CODEX_PROVIDER,
                enabled: false,
                runtimeReady: true,
                primaryModel: 'gpt-5',
                models: [{ model: 'gpt-5', modelName: 'GPT-5', modelSeries: 'codex' }],
            },
            {},
            {},
        )).toBe(false);
    });

    it('treats auth-required subscription verify status as unavailable', () => {
        const provider: Provider = {
            id: SUBSCRIPTION_PROVIDER_ID,
            name: 'Anthropic (订阅)',
            vendor: 'Anthropic',
            cloudProvider: '官方',
            type: 'subscription',
            primaryModel: 'claude-sonnet-4-6',
            isBuiltin: true,
            config: {},
            models: [{ model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude' }],
        };

        expect(isProviderAvailable(provider, {}, {
            [SUBSCRIPTION_PROVIDER_ID]: {
                status: 'invalid',
                verifiedAt: '2026-07-02T00:00:00.000Z',
                invalidReason: 'auth_required',
            },
        })).toBe(false);
    });

    it('does not fallback from an unavailable runtime-backed provider to an API provider', () => {
        const providers = [
            { ...MANAGED_CODEX_PROVIDER, enabled: false },
            makeProvider('deepseek'),
        ];

        expect(resolveProvider(
            CODEX_SUBSCRIPTION_PROVIDER_ID,
            providers,
            { deepseek: 'deepseek-key' },
            {},
        )).toBeUndefined();
    });
});
