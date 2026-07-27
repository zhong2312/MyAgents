export {
  CANONICAL_THEME_ID,
  DEFAULT_APPEARANCE_MODE,
  DEFAULT_THEME_ID,
  normalizeAppearanceMode,
  normalizeThemeConfigRecord,
  normalizeThemeId,
  resolveColorScheme,
} from '../../shared/theme';
export type {
  AppearanceMode,
  ResolvedColorScheme,
  ThemeConfigSelection,
  ThemeId,
  ThemeSelection,
} from '../../shared/theme';
export {
  LEGACY_THEME_BOOTSTRAP_KEY,
  parseThemeBootstrapSnapshot,
  readThemeBootstrapSelection,
  resolveBootstrapScheme,
  THEME_BOOTSTRAP_KEY,
  THEME_BOOTSTRAP_VERSION,
  writeThemeBootstrapSnapshot,
} from './bootstrap';
export {
  REQUIRED_THEME_CSS_TOKENS,
  REQUIRED_WIDGET_CSS_VARIABLES,
  ThemeRegistry,
  themeRegistry,
  validateThemeDefinition,
} from './registry';
export {
  ConfiguredThemeRuntime,
  FloatingThemeRuntime,
  primeThemeRuntimeFromBootstrap,
  THEME_SELECTION_CHANGED_EVENT,
  ThemeRuntimeProvider,
  useResolvedTheme,
} from './ThemeRuntime';
export type {
  MermaidThemeAdapter,
  MonacoThemeAdapter,
  MonacoThemeData,
  ResolvedTheme,
  SyntaxStyle,
  ThemeDefinition,
  ThemeHeroBackground,
  ThemeHeroDefinition,
  ThemePreviewSwatches,
  ThemeRuntimeSelection,
  ThemeSchemeDefinition,
  WidgetThemeAdapter,
  XtermThemeAdapter,
} from './types';
