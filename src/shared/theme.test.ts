import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPEARANCE_MODE,
  DEFAULT_THEME_ID,
  normalizeThemeConfigRecord,
  resolveColorScheme,
} from './theme';

describe('Theme selection semantics', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('resolves %s with systemDark=%s to %s', (mode, systemDark, expected) => {
    expect(resolveColorScheme(mode, systemDark)).toBe(expected);
  });

  it.each(['light', 'dark', 'system'] as const)('migrates legacy theme=%s without loss', (legacyMode) => {
    expect(normalizeThemeConfigRecord({ theme: legacyMode, untouched: 42 })).toEqual({
      themeId: DEFAULT_THEME_ID,
      themeSelectionExplicit: false,
      appearanceMode: legacyMode,
      untouched: 42,
    });
  });

  it('keeps a valid current appearanceMode authoritative and removes the legacy key', () => {
    expect(normalizeThemeConfigRecord({
      theme: 'dark',
      themeId: 'partner-theme',
      themeSelectionExplicit: true,
      appearanceMode: 'light',
    })).toEqual({
      themeId: 'partner-theme',
      themeSelectionExplicit: true,
      appearanceMode: 'light',
    });
  });

  it('normalizes malformed selection fields without discarding an unknown non-empty Theme ID', () => {
    expect(normalizeThemeConfigRecord({ theme: 'sepia', appearanceMode: 1, themeId: ' future-theme ' })).toEqual({
      themeId: 'future-theme',
      themeSelectionExplicit: true,
      appearanceMode: DEFAULT_APPEARANCE_MODE,
    });
  });

  it('migrates the historical materialized canonical ID back to product-default tracking', () => {
    expect(normalizeThemeConfigRecord({ themeId: 'myagents-default' })).toMatchObject({
      themeId: DEFAULT_THEME_ID,
      themeSelectionExplicit: false,
    });
  });

  it('preserves an explicitly selected canonical Theme', () => {
    expect(normalizeThemeConfigRecord({
      themeId: 'myagents-default',
      themeSelectionExplicit: true,
    })).toMatchObject({
      themeId: 'myagents-default',
      themeSelectionExplicit: true,
    });
  });

  it('is idempotent', () => {
    const once = normalizeThemeConfigRecord({ theme: 'dark', other: true });
    expect(normalizeThemeConfigRecord(once)).toEqual(once);
  });
});
