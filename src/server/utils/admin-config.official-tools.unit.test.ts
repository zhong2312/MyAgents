import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { IMAGE_UNDERSTANDING_TOOL_ID, type OfficialToolId } from '../../shared/official-tools';
import {
  getEffectiveOfficialToolIdsForSession,
  isImageUnderstandingToolCallable,
  listImageUnderstandingModelOptions,
  resolveImageUnderstandingToolAvailability,
  type AdminAppConfig,
} from './admin-config';
import { __resetModelCapabilityCacheForTests } from './model-capabilities';

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

  it('keeps a persisted custom model with omitted modalities callable as user-confirmed unknown', () => {
    const config = apiVisionConfig({
      officialToolSettings: {
        imageUnderstanding: {
          providerId: 'google-gemini',
          model: 'custom-vision-without-modality-metadata',
        },
      },
      presetCustomModels: {
        'google-gemini': [{
          model: 'custom-vision-without-modality-metadata',
          modelName: 'Custom Vision Without Metadata',
          modelSeries: 'custom',
        }],
      },
    });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: true,
      providerId: 'google-gemini',
      model: 'custom-vision-without-modality-metadata',
      modelEntry: { capabilityConfidence: 'unknown' },
    });
    expect(listImageUnderstandingModelOptions(config)).toContainEqual(expect.objectContaining({
      providerId: 'google-gemini',
      model: 'custom-vision-without-modality-metadata',
      capabilityConfidence: 'unknown',
    }));
  });

  it('treats an empty modality array as unknown rather than explicit text-only', () => {
    const config = apiVisionConfig({
      officialToolSettings: {
        imageUnderstanding: {
          providerId: 'google-gemini',
          model: 'custom-vision-with-empty-modalities',
        },
      },
      presetCustomModels: {
        'google-gemini': [{
          model: 'custom-vision-with-empty-modalities',
          modelName: 'Custom Vision With Empty Modalities',
          modelSeries: 'custom',
          inputModalities: [],
        }],
      },
    });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: true,
      modelEntry: { capabilityConfidence: 'unknown' },
    });
  });

  it('projects positive LiteLLM cache evidence as inferred for an unknown offering', () => {
    const previousHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'ma-vision-options-'));
    const cacheDir = join(tempHome, '.myagents', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'litellm_model_prices.json'),
      JSON.stringify({
        'catalog-provider/unique-litellm-vision-model': {
          mode: 'chat',
          supports_vision: true,
        },
      }),
    );
    try {
      process.env.HOME = tempHome;
      __resetModelCapabilityCacheForTests();
      const config = apiVisionConfig({
        presetCustomModels: {
          'google-gemini': [{
            model: 'unique-litellm-vision-model',
            modelName: 'Unique LiteLLM Vision Model',
            modelSeries: 'custom',
          }],
        },
      });

      expect(listImageUnderstandingModelOptions(config)).toContainEqual(expect.objectContaining({
        providerId: 'google-gemini',
        model: 'unique-litellm-vision-model',
        capabilityConfidence: 'inferred',
        capabilitySource: 'litellm',
      }));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      __resetModelCapabilityCacheForTests();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('does not let fallback data override an explicit text-only custom declaration', () => {
    const config = apiVisionConfig({
      officialToolSettings: {
        imageUnderstanding: {
          providerId: 'google-gemini',
          model: 'custom-explicit-text-only',
        },
      },
      presetCustomModels: {
        'google-gemini': [{
          model: 'custom-explicit-text-only',
          modelName: 'Custom Explicit Text Only',
          modelSeries: 'custom',
          inputModalities: ['text'],
        }],
      },
    });

    expect(resolveImageUnderstandingToolAvailability(config)).toMatchObject({
      ok: false,
      reason: 'model-not-image-capable',
    });
    expect(listImageUnderstandingModelOptions(config)).not.toContainEqual(expect.objectContaining({
      providerId: 'google-gemini',
      model: 'custom-explicit-text-only',
    }));
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
