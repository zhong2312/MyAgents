/**
 * Process-neutral Theme selection semantics.
 *
 * Keep this module free of renderer/Node/Rust dependencies: config readers in
 * every process use the same migration rules, while visual Theme definitions
 * remain renderer-owned.
 */

/**
 * Renderer-owned structural fallback. This package is always registered and
 * statically protects the pre-React frame when a requested package is invalid.
 */
export const CANONICAL_THEME_ID = 'myagents-default';

/** Product default for users who have never explicitly selected a Theme. */
export const DEFAULT_THEME_ID = 'myagents-light';
export const DEFAULT_APPEARANCE_MODE = 'system';

export type AppearanceMode = 'system' | 'light' | 'dark';
export type ResolvedColorScheme = 'light' | 'dark';
export type ThemeId = string;

export interface ThemeSelection {
  themeId: ThemeId;
  appearanceMode: AppearanceMode;
}

export interface ThemeConfigSelection extends ThemeSelection {
  /** False keeps following DEFAULT_THEME_ID as the product default evolves. */
  themeSelectionExplicit: boolean;
}

export function normalizeAppearanceMode(value: unknown): AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_APPEARANCE_MODE;
}

export function normalizeThemeId(value: unknown): ThemeId {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_THEME_ID;
}

/** Resolve an appearance preference against this window's media-query state. */
export function resolveColorScheme(
  appearanceMode: AppearanceMode,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  if (appearanceMode === 'light' || appearanceMode === 'dark') return appearanceMode;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Migrate/normalize Theme selection fields without writing them.
 *
 * `theme` is the pre-0.3.2 name for AppearanceMode. The current field wins
 * when valid; otherwise a valid legacy value is preserved. The legacy key is
 * always removed so the next real locked config write heals disk naturally.
 * Unknown explicit Theme IDs are deliberately preserved here: the renderer
 * registry performs whole-Theme fallback and emits a diagnostic without
 * destroying a value that may become available again in another build.
 * Historical auto-materialized canonical IDs migrate back to following the
 * independently evolvable product default.
 */
export function normalizeThemeConfigRecord<T extends object>(value: T): T & ThemeConfigSelection {
  const record = value as Record<string, unknown>;
  const appearanceMode = (
    record.appearanceMode === 'light'
    || record.appearanceMode === 'dark'
    || record.appearanceMode === 'system'
  )
    ? record.appearanceMode
    : normalizeAppearanceMode(record.theme);

  const storedThemeId = typeof record.themeId === 'string' && record.themeId.trim().length > 0
    ? record.themeId.trim()
    : undefined;
  const themeSelectionExplicit = storedThemeId !== undefined && (
    record.themeSelectionExplicit === true
    || (
      typeof record.themeSelectionExplicit !== 'boolean'
      && storedThemeId !== CANONICAL_THEME_ID
    )
  );

  const normalized = {
    ...value,
    appearanceMode,
    themeId: themeSelectionExplicit ? storedThemeId : DEFAULT_THEME_ID,
    themeSelectionExplicit,
  } as T & ThemeConfigSelection & { theme?: unknown };
  delete normalized.theme;
  return normalized;
}
