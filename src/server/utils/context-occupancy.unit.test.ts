import { describe, expect, it } from 'vitest';

import type { MessageUsage } from '../types/session';
import {
  chooseBuiltinContextUsageModel,
  inferContextWindowFromSdkModelTag,
  observedContextTokens,
  resolveContextOccupancyFromSdkBreakdown,
  resolveContextOccupancyTokens,
  resolveContextWindowFromSdkBreakdown,
} from './context-occupancy';

describe('observedContextTokens', () => {
  it('includes cache tokens and modelUsage entries', () => {
    const usage: MessageUsage = {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 200,
      cacheCreationTokens: 300,
      modelUsage: {
        'gpt-5.5': {
          inputTokens: 1_000,
          outputTokens: 0,
          cacheReadTokens: 2_000,
          cacheCreationTokens: 3_000,
        },
      },
    };

    expect(observedContextTokens(usage)).toBe(6_000);
  });

  it('reconstructs OpenAI total input from Bridge-normalized Anthropic partitions exactly once', () => {
    const usage: MessageUsage = {
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 400,
    };

    expect(observedContextTokens(usage)).toBe(2_600);
  });
});

describe('resolveContextOccupancyTokens (#323 — /compact must not show 100% / impossible tokens)', () => {
  // The bug: broadcastBuiltinContextUsage fell back to the turn-AGGREGATE
  // (currentTurnUsage, whose cacheReadTokens is summed across every API call in
  // the turn) when no per-message assistant usage was captured. A `/compact`
  // turn is exactly that case — a successful SDK result with a large aggregate
  // modelUsage but NO main-thread assistant message.usage — so the indicator
  // showed e.g. "20.40M / 1M tokens" at a capped 100%. The fix: occupancy comes
  // ONLY from the per-call snapshot; null ⟹ skip the broadcast (never substitute
  // the aggregate). The signature structurally bars the aggregate from being
  // passed; these tests pin the skip contract.
  it('returns null for a /compact-style turn with no per-call snapshot (skip — never the aggregate)', () => {
    // What broadcastBuiltinContextUsage passes on a compact turn: latestMainAssistantUsage === null.
    // It MUST resolve to null (skip), even though currentTurnUsage held a 20.40M aggregate.
    expect(resolveContextOccupancyTokens(null)).toBeNull();
    expect(resolveContextOccupancyTokens(undefined)).toBeNull();
  });

  it('returns null when the per-call usage sums to zero (no meaningless 0% flash)', () => {
    expect(resolveContextOccupancyTokens({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(resolveContextOccupancyTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });

  it('resolves a real per-call snapshot to input + cache (sane occupancy)', () => {
    const perCall: MessageUsage = {
      inputTokens: 50_000,
      outputTokens: 1_200,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 2_000,
    };
    // 50_000 + 8_000 + 2_000 (output excluded — it isn't context occupancy).
    expect(resolveContextOccupancyTokens(perCall)).toBe(60_000);
  });
});

describe('resolveContextOccupancyFromSdkBreakdown (#343 — fallback when provider omits per-message usage)', () => {
  // The bug: 火山方舟 MiniMax M3 (and other Anthropic-compat third-party providers) fill
  // `result.modelUsage` aggregate but omit `BetaMessage.usage` on streamed main-turn assistant
  // frames. resolveContextOccupancyTokens(latestMainAssistantUsage) → null → broadcast skipped
  // → context-usage ring permanently empty even though the SDK's own `/context` slash command
  // correctly displays 122.8k/512k. Fix: fall back to querySession.getContextUsage() and pull
  // totalTokens. This helper normalizes the SDK control response into the same number-or-null
  // contract resolveContextOccupancyTokens uses, so broadcastBuiltinContextUsage's two sources
  // share one downstream tail.
  it('returns null when the SDK response is missing or has no totalTokens (silently skip)', () => {
    expect(resolveContextOccupancyFromSdkBreakdown(null)).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown(undefined)).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({})).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: undefined })).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: null })).toBeNull();
  });

  it('returns null on non-numeric / non-finite / non-positive totalTokens (treat as untrusted)', () => {
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: 0 })).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: -5 })).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: Number.NaN })).toBeNull();
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: Number.POSITIVE_INFINITY })).toBeNull();
    // SDK's API typing claims `number` but we defensively widen for runtime safety.
    expect(
      resolveContextOccupancyFromSdkBreakdown({ totalTokens: '122800' as unknown as number }),
    ).toBeNull();
  });

  it('returns the rounded totalTokens for a valid SDK response (reporter #343 example)', () => {
    // Reporter's `/context` showed 122.8k / 512k (24%). The SDK's getContextUsage() would
    // return totalTokens ≈ 122_800 in that turn. Our broadcast should pin to that integer.
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: 122_800 })).toBe(122_800);
    expect(resolveContextOccupancyFromSdkBreakdown({ totalTokens: 122_812.7 })).toBe(122_813);
  });

  it('ignores unknown SDK response fields (forward-compat with SDK evolution)', () => {
    // SDK's full response shape has categories/apiUsage/messageBreakdown/etc. We only need
    // totalTokens; extra fields must not break us, and adding new fields in future SDK
    // versions must not change the contract.
    const response = {
      totalTokens: 42_000,
      maxTokens: 200_000,
      percentage: 21,
      categories: [{ name: 'tools', tokens: 10_000, color: '#aaa' }],
      apiUsage: {
        input_tokens: 30_000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 12_000,
      },
      model: 'minimax-m3',
    };
    expect(resolveContextOccupancyFromSdkBreakdown(response)).toBe(42_000);
  });
});

describe('resolveContextWindowFromSdkBreakdown', () => {
  it('returns null for missing or invalid SDK window fields', () => {
    expect(resolveContextWindowFromSdkBreakdown(null)).toBeNull();
    expect(resolveContextWindowFromSdkBreakdown({})).toBeNull();
    expect(resolveContextWindowFromSdkBreakdown({ maxTokens: 0 })).toBeNull();
    expect(resolveContextWindowFromSdkBreakdown({ maxTokens: Number.NaN })).toBeNull();
  });

  it('uses maxTokens before rawMaxTokens and rounds finite positive values', () => {
    expect(resolveContextWindowFromSdkBreakdown({ maxTokens: 1_000_000, rawMaxTokens: 200_000 })).toBe(1_000_000);
    expect(resolveContextWindowFromSdkBreakdown({ rawMaxTokens: 999_999.6 })).toBe(1_000_000);
  });
});

describe('chooseBuiltinContextUsageModel (#373 — SDK model aliases must not force a 200K window)', () => {
  const windows = new Map<string, number>([
    ['deepseek-v4-pro', 1_000_000],
    ['deepseek-v4-flash', 1_000_000],
  ]);
  const lookupWindow = (model?: string) => model ? windows.get(model.replace(/\[1m\]$/i, '')) : undefined;

  it('keeps a registry-known SDK result model', () => {
    expect(chooseBuiltinContextUsageModel({
      sdkResultModel: 'deepseek-v4-flash[1m]',
      configuredModel: 'deepseek-v4-pro',
      lookupWindow,
    })).toBe('deepseek-v4-flash[1m]');
  });

  it('falls back to the configured model when the SDK reports a provider-versioned alias', () => {
    expect(chooseBuiltinContextUsageModel({
      sdkResultModel: 'deepseek-v4-pro-260425[1m]',
      configuredModel: 'deepseek-v4-pro',
      lookupWindow,
    })).toBe('deepseek-v4-pro');
  });

  it('uses the configured model for compact/control turns with no result model', () => {
    expect(chooseBuiltinContextUsageModel({
      sdkResultModel: undefined,
      configuredModel: 'deepseek-v4-pro',
      lookupWindow,
    })).toBe('deepseek-v4-pro');
  });

  it('preserves an unknown SDK model when there is no known configured fallback', () => {
    expect(chooseBuiltinContextUsageModel({
      sdkResultModel: 'vendor-model-2026[1m]',
      configuredModel: 'custom-model',
      lookupWindow,
    })).toBe('vendor-model-2026[1m]');
  });
});

describe('inferContextWindowFromSdkModelTag', () => {
  it('mirrors the SDK [1m] tag as a last-resort runtime window hint', () => {
    expect(inferContextWindowFromSdkModelTag('deepseek-v4-pro-260425[1m]')).toBe(1_000_000);
    expect(inferContextWindowFromSdkModelTag('deepseek-v4-pro')).toBeNull();
    expect(inferContextWindowFromSdkModelTag(undefined)).toBeNull();
  });
});
