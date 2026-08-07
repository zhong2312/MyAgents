import { describe, expect, it } from 'vitest';

import {
  LEGACY_THEME_BOOTSTRAP_KEY,
  parseThemeBootstrapSnapshot,
  readThemeBootstrapSelection,
  THEME_BOOTSTRAP_KEY,
  writeThemeBootstrapSnapshot,
} from './bootstrap';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe('Theme bootstrap snapshot', () => {
  it('parses the current non-sensitive version and preserves a registered-later ID', () => {
    expect(parseThemeBootstrapSnapshot(JSON.stringify({
      version: 1,
      themeId: 'partner-theme',
      appearanceMode: 'dark',
    }))).toEqual({
      version: 2,
      themeId: 'partner-theme',
      appearanceMode: 'dark',
      themeSelectionExplicit: true,
    });
  });

  it('rejects malformed JSON and stale versions', () => {
    expect(parseThemeBootstrapSnapshot('{')).toBeNull();
    expect(parseThemeBootstrapSnapshot(JSON.stringify({ version: 0 }))).toBeNull();
  });

  it('re-resolves an implicit snapshot against the current product default', () => {
    expect(parseThemeBootstrapSnapshot(JSON.stringify({
      version: 2,
      themeId: 'myagents-default',
      appearanceMode: 'light',
      themeSelectionExplicit: false,
    }))).toEqual({
      version: 2,
      themeId: 'myagents-light',
      appearanceMode: 'light',
      themeSelectionExplicit: false,
    });
  });

  it('uses the one-release legacy appearance key only when no current snapshot exists', () => {
    const legacy = memoryStorage({ [LEGACY_THEME_BOOTSTRAP_KEY]: 'dark' });
    expect(readThemeBootstrapSelection(legacy)).toEqual({
      themeId: 'myagents-light',
      appearanceMode: 'dark',
      themeSelectionExplicit: false,
    });

    const current = memoryStorage({
      [LEGACY_THEME_BOOTSTRAP_KEY]: 'light',
      [THEME_BOOTSTRAP_KEY]: JSON.stringify({ version: 1, themeId: 'partner-theme', appearanceMode: 'dark' }),
    });
    expect(readThemeBootstrapSelection(current)).toEqual({
      themeId: 'partner-theme',
      appearanceMode: 'dark',
      themeSelectionExplicit: true,
    });
  });

  it('writes explicit selection state and removes the legacy key', () => {
    const storage = memoryStorage({ [LEGACY_THEME_BOOTSTRAP_KEY]: 'light' });
    writeThemeBootstrapSnapshot(storage, {
      themeId: 'myagents-default',
      appearanceMode: 'system',
      themeSelectionExplicit: true,
    });

    expect(JSON.parse(storage.values.get(THEME_BOOTSTRAP_KEY) ?? '{}')).toEqual({
      version: 2,
      themeId: 'myagents-default',
      appearanceMode: 'system',
      themeSelectionExplicit: true,
    });
    expect(storage.values.has(LEGACY_THEME_BOOTSTRAP_KEY)).toBe(false);
  });
});
