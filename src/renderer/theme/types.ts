import type { AppearanceMode, ResolvedColorScheme, ThemeId, ThemeSelection } from '../../shared/theme';
import type { MermaidThemeVariable, WidgetCssVariable } from './registry-contract';

export type CssPrimitive = string | undefined;
export type SyntaxStyle = Record<string, Record<string, CssPrimitive>>;

export interface XtermThemeAdapter {
  palette: Record<string, string | undefined>;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface MonacoThemeRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
}

export interface MonacoThemeAdapter {
  /** Stable suffix; runtime prefixes it with Theme ID to avoid collisions. */
  name: string;
  data: MonacoThemeData;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface MermaidThemeAdapter {
  theme: 'dark' | 'neutral';
  fontFamily: string;
  themeVariables: Record<MermaidThemeVariable, string>;
}

export interface WidgetThemeAdapter {
  /** iframe variable -> host CSS variable or literal CSS value. */
  variables: Record<WidgetCssVariable, string>;
}

export interface ThemeSchemeDefinition {
  xterm: XtermThemeAdapter;
  monaco: MonacoThemeAdapter;
  mermaid: MermaidThemeAdapter;
  prism: SyntaxStyle;
  widget: WidgetThemeAdapter;
}

export interface ThemeHeroBackground {
  assetUrl: string | null;
  position: string;
  size: string;
  repeat: string;
  mask: string | null;
}

export interface ThemeHeroDefinition {
  productName: string;
  slogans: Record<'zh-CN' | 'en-US', string>;
  backgrounds: Record<ResolvedColorScheme, ThemeHeroBackground>;
}

export interface ThemeDefinition {
  id: ThemeId;
  displayName: string;
  description: string;
  /**
   * The Theme's actual co-located stylesheet source. The concrete Theme module
   * also imports the same file for bundling; keeping the source here lets the
   * registry validate real declarations instead of trusting shadow metadata.
   */
  stylesheetText: string;
  hero: ThemeHeroDefinition;
  schemes: Record<ResolvedColorScheme, ThemeSchemeDefinition>;
}

export interface ThemePreviewSwatches {
  light: string;
  dark: string;
}

export interface ResolvedTheme extends ThemeSelection {
  requestedThemeId: ThemeId;
  resolvedColorScheme: ResolvedColorScheme;
  definition: ThemeDefinition;
  adapters: ThemeSchemeDefinition;
  hero: ThemeHeroDefinition & { background: ThemeHeroBackground };
  /** Stable key for adapter consumers; changes only on Theme/scheme changes. */
  key: string;
}

export interface ThemeRuntimeSelection {
  themeId: ThemeId;
  appearanceMode: AppearanceMode;
}
