import {
  CANONICAL_THEME_ID,
  DEFAULT_APPEARANCE_MODE,
  DEFAULT_THEME_ID,
  normalizeAppearanceMode,
  normalizeThemeId,
  resolveColorScheme,
  type ResolvedColorScheme,
  type ThemeSelection,
} from '../../shared/theme';

export const THEME_BOOTSTRAP_KEY = 'myagents:theme-bootstrap';
export const LEGACY_THEME_BOOTSTRAP_KEY = 'theme';
export const THEME_BOOTSTRAP_VERSION = 2;

export interface ThemeBootstrapSelection extends ThemeSelection {
  themeSelectionExplicit: boolean;
}

export interface ThemeBootstrapSnapshot extends ThemeBootstrapSelection {
  version: typeof THEME_BOOTSTRAP_VERSION;
}

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function parseThemeBootstrapSnapshot(raw: string | null): ThemeBootstrapSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 && parsed.version !== THEME_BOOTSTRAP_VERSION) return null;
    const storedThemeId = typeof parsed.themeId === 'string' && parsed.themeId.trim().length > 0
      ? parsed.themeId.trim()
      : undefined;
    const themeSelectionExplicit = storedThemeId !== undefined && (
      parsed.version === THEME_BOOTSTRAP_VERSION
        ? parsed.themeSelectionExplicit === true
        : storedThemeId !== CANONICAL_THEME_ID
    );
    return {
      version: THEME_BOOTSTRAP_VERSION,
      themeId: themeSelectionExplicit ? normalizeThemeId(storedThemeId) : DEFAULT_THEME_ID,
      appearanceMode: normalizeAppearanceMode(parsed.appearanceMode),
      themeSelectionExplicit,
    };
  } catch {
    return null;
  }
}

export function readThemeBootstrapSelection(storage: ThemeStorage | null): ThemeBootstrapSelection {
  if (!storage) {
    return {
      themeId: DEFAULT_THEME_ID,
      appearanceMode: DEFAULT_APPEARANCE_MODE,
      themeSelectionExplicit: false,
    };
  }
  try {
    const current = parseThemeBootstrapSnapshot(storage.getItem(THEME_BOOTSTRAP_KEY));
    if (current) {
      return {
        themeId: current.themeId,
        appearanceMode: current.appearanceMode,
        themeSelectionExplicit: current.themeSelectionExplicit,
      };
    }

    // One-release compatibility path. The durable runtime removes this key as
    // soon as it publishes the versioned non-sensitive snapshot.
    const legacy = storage.getItem(LEGACY_THEME_BOOTSTRAP_KEY);
    return {
      themeId: DEFAULT_THEME_ID,
      appearanceMode: normalizeAppearanceMode(legacy),
      themeSelectionExplicit: false,
    };
  } catch {
    return {
      themeId: DEFAULT_THEME_ID,
      appearanceMode: DEFAULT_APPEARANCE_MODE,
      themeSelectionExplicit: false,
    };
  }
}

export function writeThemeBootstrapSnapshot(
  storage: ThemeStorage | null,
  selection: ThemeBootstrapSelection,
): void {
  if (!storage) return;
  try {
    const snapshot: ThemeBootstrapSnapshot = {
      version: THEME_BOOTSTRAP_VERSION,
      themeId: selection.themeSelectionExplicit
        ? normalizeThemeId(selection.themeId)
        : DEFAULT_THEME_ID,
      appearanceMode: normalizeAppearanceMode(selection.appearanceMode),
      themeSelectionExplicit: selection.themeSelectionExplicit,
    };
    storage.setItem(THEME_BOOTSTRAP_KEY, JSON.stringify(snapshot));
    storage.removeItem(LEGACY_THEME_BOOTSTRAP_KEY);
  } catch {
    // Storage may be disabled. Theme application must never block startup.
  }
}

export function resolveBootstrapScheme(
  selection: ThemeSelection,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  return resolveColorScheme(normalizeAppearanceMode(selection.appearanceMode), systemPrefersDark);
}
