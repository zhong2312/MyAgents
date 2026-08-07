import { describe, expect, it } from 'vitest';

import { IMAGE_UNDERSTANDING_TOOL_ID, type OfficialToolId } from '../../shared/official-tools';
import {
  getEffectiveOfficialToolIdsForSession,
  isImageUnderstandingToolCallable,
  resolveImageUnderstandingToolAvailability,
  type AdminAppConfig,
} from './admin-config';

const ENABLED_OFFICIAL_TOOLS: OfficialToolId[] = [IMAGE_UNDERSTANDING_TOOL_ID];

function apiVisionConfig(overrides: Partial<AdminAppConfig> = {}): AdminAppConfig {
  return {
    enabledOfficialToolIds: ENABLED_OFFICIAL_TOOLS,
    officialToolSettings: {
      imageUnderstanding: {
        providerId: 'google-gemini',
        model: 'gemini-3.6-flash',
      },
    },
    providerApiKeys: { 'google-gemini': 'gemini-key' },
    ...overrides,
  };
}

describe('official image understanding availability', () => {
  it('keeps effective official tools only when the configured image model is callable', () => {
    const config = apiVisionConfig();

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: true,
      providerId: 'google-gemini',
      model: 'gemini-3.6-flash',
    });
    expect(isImageUnderstandingToolCallable(config)).toBe(true);
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      config,
    )).toEqual(ENABLED_OFFICIAL_TOOLS);
  });

  it('filters image understanding out when an API-backed provider has no key', () => {
    const config = apiVisionConfig({ providerApiKeys: {} });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: false,
      reason: 'missing-credential',
    });
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      config,
    )).toEqual([]);
  });

  it('filters image understanding out when the selected model is text-only', () => {
    const config = apiVisionConfig({
      officialToolSettings: {
        imageUnderstanding: {
          providerId: 'deepseek',
          model: 'deepseek-v4-pro',
        },
      },
      providerApiKeys: { deepseek: 'deepseek-key' },
    });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: false,
      reason: 'model-not-image-capable',
    });
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      config,
    )).toEqual([]);
  });

  it('filters image understanding out when the provider is globally disabled', () => {
    const config = apiVisionConfig({ disabledProviderIds: ['google-gemini'] });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: false,
      reason: 'provider-unavailable',
    });
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      config,
    )).toEqual([]);
  });

  it('requires subscription providers to be verified before injection', () => {
    const unverifiedConfig = apiVisionConfig({
      officialToolSettings: {
        imageUnderstanding: {
          providerId: 'anthropic-sub',
          model: 'claude-sonnet-4-6',
        },
      },
      providerApiKeys: {},
      providerVerifyStatus: {},
    });

    expect(resolveImageUnderstandingToolAvailability(unverifiedConfig)).toMatchObject({
      ok: false,
      reason: 'subscription-not-verified',
    });
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      unverifiedConfig,
    )).toEqual([]);

    const verifiedConfig = apiVisionConfig({
      officialToolSettings: unverifiedConfig.officialToolSettings,
      providerApiKeys: {},
      providerVerifyStatus: {
        'anthropic-sub': {
          status: 'valid',
          verifiedAt: '2026-06-28T00:00:00.000Z',
        },
      },
    });

    expect(resolveImageUnderstandingToolAvailability(verifiedConfig)).toMatchObject({
      ok: true,
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
    });
    expect(getEffectiveOfficialToolIdsForSession(
      '/workspace',
      null,
      ENABLED_OFFICIAL_TOOLS,
      verifiedConfig,
    )).toEqual(ENABLED_OFFICIAL_TOOLS);
  });
});
