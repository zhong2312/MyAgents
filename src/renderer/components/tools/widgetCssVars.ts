/**
 * CSS variable bridge for Generative UI widgets.
 *
 * Sandbox iframes cannot inherit parent CSS variables, so the resolved Theme
 * adapter supplies literal values that we inject into the iframe's :root.
 * Widget code uses --widget-* variables that map to MyAgents design tokens.
 *
 * Covers: text, background, border, accent, semantic, radius.
 * Values never come from getComputedStyle(): child render precedes the parent
 * runtime's layout effect, so DOM reads can observe the previous scheme.
 */

import type { ResolvedTheme } from '@/theme';

export function buildWidgetCssVars(theme: ResolvedTheme): string {
  const variables = Object.entries(theme.adapters.widget.variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  return `:root {
${variables}
  color-scheme: ${theme.resolvedColorScheme};
}`;
}
