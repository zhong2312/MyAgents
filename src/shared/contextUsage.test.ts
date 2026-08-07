import { describe, it, expect } from 'vitest';

import {
  BUILTIN_AUTO_COMPACT_PERCENT,
  computeBuiltinAutoCompactThreshold,
  computeContextUsage,
  stripModelSuffix,
  SDK_DEFAULT_CONTEXT_WINDOW,
} from './contextUsage';

describe('builtin auto-compaction policy', () => {
  it('projects the same 90% threshold injected into the SDK environment', () => {
    expect(BUILTIN_AUTO_COMPACT_PERCENT).toBe(90);
    expect(computeBuiltinAutoCompactThreshold(200_000)).toBe(180_000);
    expect(computeBuiltinAutoCompactThreshold(1_048_576)).toBe(943_718);
  });

  it('fails closed for invalid windows', () => {
    expect(computeBuiltinAutoCompactThreshold(0)).toBe(0);
    expect(computeBuiltinAutoCompactThreshold(Number.NaN)).toBe(0);
  });
});

describe('stripModelSuffix', () => {
  it('strips the [1m] suffix (case-insensitive)', () => {
    expect(stripModelSuffix('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(stripModelSuffix('deepseek-v4-pro[1M]')).toBe('deepseek-v4-pro');
  });
  it('leaves un-suffixed ids untouched', () => {
    expect(stripModelSuffix('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
  // #338 — users copy the `mimo-v2.5-pro[1m]` doc pattern but type a space
  // ("claude-sonnet-4-6 1m"). That malformed form must strip to the bare id too,
  // or the registry lookup misses and the window collapses to 200K (and the
  // space would leak to the upstream wire).
  it('strips the malformed space form " 1m" (case-insensitive)', () => {
    expect(stripModelSuffix('claude-sonnet-4-6 1m')).toBe('claude-sonnet-4-6');
    expect(stripModelSuffix('claude-opus-4-6 1M')).toBe('claude-opus-4-6');
  });
  it('trims trailing whitespace, incl. combined suffix + whitespace', () => {
    expect(stripModelSuffix('claude-sonnet-4-6 ')).toBe('claude-sonnet-4-6');
    expect(stripModelSuffix('claude-opus-4-6[1m] ')).toBe('claude-opus-4-6');
  });
  // The ` 1m` rule requires whitespace before `1m`, so a hyphenated id whose
  // real name ends in "-1m" must be preserved (no false strip).
  it('does NOT strip a hyphenated "-1m" that is part of the real id', () => {
    expect(stripModelSuffix('some-model-1m')).toBe('some-model-1m');
  });
  it('returns undefined for empty input', () => {
    expect(stripModelSuffix(undefined)).toBeUndefined();
    expect(stripModelSuffix(null)).toBeUndefined();
    expect(stripModelSuffix('')).toBeUndefined();
  });
});

describe('computeContextUsage', () => {
  const noLookup = () => null;

  it('prefers the runtime-reported window over registry', () => {
    const r = computeContextUsage({
      occupiedTokens: 50_000,
      runtimeWindow: 400_000,
      source: 'codex',
      model: 'gpt-5.4-codex',
      lookupWindow: () => 128_000, // registry would say 128K, but runtime wins
    });
    expect(r.contextWindow).toBe(400_000);
    expect(r.windowSource).toBe('runtime');
    expect(r.usedPercent).toBeCloseTo(12.5, 5);
  });

  it('falls back to registry when runtime window is null', () => {
    const r = computeContextUsage({
      occupiedTokens: 64_000,
      runtimeWindow: null,
      source: 'claude-code',
      model: 'deepseek-v4',
      lookupWindow: () => 128_000,
    });
    expect(r.contextWindow).toBe(128_000);
    expect(r.windowSource).toBe('registry');
    expect(r.usedPercent).toBeCloseTo(50, 5);
  });

  it('falls back to SDK default 200K when neither runtime nor registry knows', () => {
    const r = computeContextUsage({
      occupiedTokens: 100_000,
      runtimeWindow: null,
      source: 'gemini',
      model: 'some-custom-model',
      lookupWindow: noLookup,
    });
    expect(r.contextWindow).toBe(SDK_DEFAULT_CONTEXT_WINDOW);
    expect(r.windowSource).toBe('default');
    expect(r.usedPercent).toBeCloseTo(50, 5);
  });

  it('strips [1m] before the registry lookup', () => {
    const seen: (string | undefined)[] = [];
    const r = computeContextUsage({
      occupiedTokens: 10_000,
      runtimeWindow: null,
      source: 'builtin',
      model: 'claude-opus-4-6[1m]',
      lookupWindow: (m) => { seen.push(m); return 1_000_000; },
    });
    expect(seen).toEqual(['claude-opus-4-6']); // bare id, not the [1m] form
    expect(r.contextWindow).toBe(1_000_000);
    expect(r.windowSource).toBe('runtime' === r.windowSource ? r.windowSource : 'registry');
    expect(r.windowSource).toBe('registry');
  });

  it('caps usedPercent at 100 when occupancy exceeds the window', () => {
    const r = computeContextUsage({
      occupiedTokens: 250_000,
      runtimeWindow: 200_000,
      source: 'builtin',
      lookupWindow: noLookup,
    });
    expect(r.usedPercent).toBe(100);
    expect(r.contextTokens).toBe(250_000);
  });

  it('treats zero / negative / NaN occupancy as 0', () => {
    for (const bad of [0, -100, NaN]) {
      const r = computeContextUsage({
        occupiedTokens: bad,
        runtimeWindow: 200_000,
        source: 'builtin',
        lookupWindow: noLookup,
      });
      expect(r.contextTokens).toBe(0);
      expect(r.usedPercent).toBe(0);
    }
  });

  it('ignores non-positive runtime windows and falls through', () => {
    const r = computeContextUsage({
      occupiedTokens: 10_000,
      runtimeWindow: 0,
      source: 'codex',
      model: 'x',
      lookupWindow: () => 100_000,
    });
    expect(r.contextWindow).toBe(100_000);
    expect(r.windowSource).toBe('registry');
  });

  it('rounds fractional occupancy', () => {
    const r = computeContextUsage({
      occupiedTokens: 1234.7,
      runtimeWindow: 200_000,
      source: 'builtin',
      lookupWindow: noLookup,
    });
    expect(r.contextTokens).toBe(1235);
  });
});
