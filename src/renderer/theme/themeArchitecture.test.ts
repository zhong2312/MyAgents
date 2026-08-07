import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectContractBlocks,
  collectDeclaredTokens,
  parseThemeStylesheet,
} from './stylesheet-contract';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function rendererSourceFiles(directory = resolve(root, 'src/renderer')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(path);
    if (!/\.(?:ts|tsx|css)$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

function ruleBodyAfter(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', selectorIndex);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThan(selectorIndex);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

function sourceSection(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return contents.slice(start, end);
}

describe('Theme architecture guardrails', () => {
  it.each([
    'src/renderer/components/TerminalPanel.tsx',
    'src/renderer/components/MonacoEditor.tsx',
    'src/renderer/components/markdown/MermaidDiagram.tsx',
    'src/renderer/components/markdown/CodeBlock.tsx',
    'src/renderer/components/tools/WidgetRenderer.tsx',
  ])('%s consumes the public Theme runtime and does not infer scheme from DOM mutations', (file) => {
    const contents = source(file);
    expect(contents).toContain("from '@/theme'");
    expect(contents).not.toContain('MutationObserver');
  });

  it('keeps palette ownership out of embedded visual consumers', () => {
    expect(source('src/renderer/components/TerminalPanel.tsx')).not.toMatch(/TERMINAL_(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/MonacoEditor.tsx')).not.toMatch(/(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/markdown/MermaidDiagram.tsx')).not.toMatch(/(LIGHT|DARK)_COLORS/);
    expect(source('src/renderer/components/markdown/CodeBlock.tsx')).not.toContain('oneDark');
  });

  it('keeps the test-only synthetic Theme out of the production registry and entry graph', () => {
    expect(source('src/renderer/theme/registry.ts')).not.toContain('synthetic-test-theme');
    expect(source('src/renderer/theme/index.ts')).not.toContain('syntheticTheme');
  });

  it('keeps every optional package scoped, side-effect free, and independent from Space', () => {
    const optionalThemeIds = [
      'myagents-light', 'default-black', 'sage', 'absolutely', 'linear', 'proof', 'codex', 'raycast',
    ];
    for (const themeId of optionalThemeIds) {
      const manifest = source(`src/renderer/theme/themes/${themeId}.ts`);
      const css = source(`src/renderer/theme/themes/${themeId}.css`);
      expect(manifest).toContain(`from './${themeId}.css?inline'`);
      expect(manifest).not.toContain(`import './${themeId}.css'`);
      expect(css).toContain(`html[data-theme-id='${themeId}'] {`);
      expect(css).toContain(`html[data-theme-id='${themeId}'][data-color-scheme='light'] {`);
      expect(css).toContain(`html[data-theme-id='${themeId}'][data-color-scheme='dark'] {`);
      expect(css).not.toContain(':root');
      expect(css).not.toContain('data-ui-theme');
      expect(css).not.toContain('@theme');
      expect(css).not.toContain('@font-face');
      expect(css).not.toMatch(/https?:\/\//);
    }
    expect(source('src/renderer/theme/themes/preset-theme.ts')).not.toContain('myagents-default');
  });

  it('keeps the global sidebar structural surface scoped to App Shell chrome', () => {
    const consumers = rendererSourceFiles()
      .filter(file => source(file.slice(root.length + 1)).includes('var(--global-sidebar-bg)'))
      .map(file => file.slice(root.length + 1));

    expect(consumers).toEqual([
      'src/renderer/components/CustomTitleBar.tsx',
      'src/renderer/components/TabBar.tsx',
      'src/renderer/components/global-sidebar/GlobalSidebar.tsx',
    ]);
  });

  it('keeps Default Black equal to canonical host tokens except its light primary button pair', () => {
    const canonicalStylesheet = parseThemeStylesheet(
      source('src/renderer/theme/themes/myagents-default.css'),
    );
    const variantStylesheet = parseThemeStylesheet(
      source('src/renderer/theme/themes/default-black.css'),
    );
    const canonicalRoot = "html[data-theme-id='myagents-default']";
    const variantRoot = "html[data-theme-id='default-black']";
    const collect = (
      stylesheet: ReturnType<typeof parseThemeStylesheet>,
      selector: string,
      allowedSelectorLists: string[][],
    ) => collectDeclaredTokens(collectContractBlocks(
      stylesheet.topLevelBlocks,
      selector,
      allowedSelectorLists,
      `Default Black equality selector ${selector}`,
    ));

    expect(collect(variantStylesheet, variantRoot, [[variantRoot]])).toEqual(
      collect(canonicalStylesheet, canonicalRoot, [[':root', canonicalRoot]]),
    );

    for (const scheme of ['light', 'dark'] as const) {
      const canonicalScheme = `${canonicalRoot}[data-color-scheme='${scheme}']`;
      const variantScheme = `${variantRoot}[data-color-scheme='${scheme}']`;
      const canonicalTokens = collect(
        canonicalStylesheet,
        canonicalScheme,
        [[`html[data-color-scheme='${scheme}']`, canonicalScheme]],
      );
      const variantTokens = collect(variantStylesheet, variantScheme, [[variantScheme]]);

      if (scheme === 'light') {
        canonicalTokens.set('--button-primary-bg', '#111111');
        canonicalTokens.set('--button-primary-bg-hover', '#2b2b2b');
      }
      expect(variantTokens).toEqual(canonicalTokens);
    }
  });

  it('keeps MyAgents Light equal to Claude except its light primary button pair', () => {
    const claudeStylesheet = parseThemeStylesheet(
      source('src/renderer/theme/themes/absolutely.css'),
    );
    const lightStylesheet = parseThemeStylesheet(
      source('src/renderer/theme/themes/myagents-light.css'),
    );
    const claudeRoot = "html[data-theme-id='absolutely']";
    const lightRoot = "html[data-theme-id='myagents-light']";
    const collect = (
      stylesheet: ReturnType<typeof parseThemeStylesheet>,
      selector: string,
    ) => collectDeclaredTokens(collectContractBlocks(
      stylesheet.topLevelBlocks,
      selector,
      [[selector]],
      `MyAgents Light equality selector ${selector}`,
    ));

    expect(collect(lightStylesheet, lightRoot)).toEqual(collect(claudeStylesheet, claudeRoot));

    for (const scheme of ['light', 'dark'] as const) {
      const claudeTokens = collect(
        claudeStylesheet,
        `${claudeRoot}[data-color-scheme='${scheme}']`,
      );
      const lightTokens = collect(
        lightStylesheet,
        `${lightRoot}[data-color-scheme='${scheme}']`,
      );

      if (scheme === 'light') {
        claudeTokens.set('--button-primary-bg', '#111111');
        claudeTokens.set('--button-primary-bg-hover', '#2b2b2b');
      }
      expect(lightTokens).toEqual(claudeTokens);
    }
  });

  it('reuses one Theme-owned product wordmark across Launcher, About, and the global sidebar', () => {
    const launcher = source('src/renderer/components/launcher/BrandSection.tsx');
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    const sidebar = source('src/renderer/components/global-sidebar/GlobalSidebar.tsx');
    expect(launcher).toContain('<h1 className="theme-product-wordmark theme-launcher-hero-title">');
    expect(settings).toContain('className="theme-product-wordmark theme-launcher-hero-title cursor-default select-none"');
    expect(sidebar).toContain('className="theme-product-wordmark global-sidebar-copy min-w-0 truncate text-sm font-medium"');
    expect(settings).not.toContain('className="brand-title');
  });

  it('keeps Space inside the app-level Theme scope', () => {
    for (const file of [
      'src/renderer/index.css',
      'src/renderer/pages/Space.tsx',
      'src/renderer/pages/space/SpaceChrome.tsx',
      'src/renderer/components/ui/Popover.tsx',
    ]) {
      const contents = source(file);
      expect(contents).not.toContain('data-ui-theme');
      expect(contents).not.toContain('space-mono');
    }
  });

  it('keeps a complete default visual fallback for unknown pre-React Theme IDs', () => {
    const css = source('src/renderer/theme/themes/myagents-default.css');
    expect(css).toContain(":root,\nhtml[data-theme-id='myagents-default']");
    expect(css).toContain('--font-body:');
    expect(css).toContain('--theme-radius-full:');
    expect(css).toContain("html[data-color-scheme='light']");
    expect(css).toContain("html[data-color-scheme='dark']");
    expect(css.match(/--theme-shadow-2xl:/g)).toHaveLength(2);
  });

  it('keeps Tailwind utility generation bridged to runtime Theme tokens', () => {
    const entry = source('src/renderer/index.css');
    const theme = source('src/renderer/theme/themes/myagents-default.css');
    expect(entry).toContain('@theme inline');
    expect(entry).toContain('--font-mono: var(--font-code)');
    expect(entry).toContain('--radius-full: var(--theme-radius-full)');
    expect(entry).toContain('--shadow-sm: var(--theme-shadow-sm)');
    expect(entry).toContain('--transition-duration-150: var(--duration-fast)');
    expect(theme).not.toContain('@theme');
  });

  it('keeps the restored warm default action palette aligned with embedded adapters', () => {
    const theme = source('src/renderer/theme/themes/myagents-default.css');
    const themeLight = ruleBodyAfter(theme, "html[data-color-scheme='light'],");
    const themeDark = ruleBodyAfter(theme, "html[data-color-scheme='dark'],");
    const expectedThemeByScheme = {
      light: [
        '--hover-bg: rgba(194, 109, 58, 0.07)',
        '--accent: #c26d3a', '--accent-warm: #c26d3a', '--accent-warm-hover: #e18a58',
        '--accent-warm-subtle: rgba(194, 109, 58, 0.08)',
        '--accent-warm-muted: rgba(194, 109, 58, 0.15)',
        '--accent-warm-subtle-a0: rgba(194, 109, 58, 0)', '--on-accent: #ffffff',
        '--button-primary-bg: #c26d3a', '--button-primary-bg-hover: #b05e2d',
        '--button-primary-text: var(--on-accent)', '--focus-border: #1c1612', '--toggle-thumb: #ffffff',
      ],
      dark: [
        '--hover-bg: rgba(194, 109, 58, 0.12)',
        '--accent: #d4803f', '--accent-warm: #d4803f', '--accent-warm-hover: #e89860',
        '--accent-warm-subtle: rgba(212, 128, 63, 0.12)',
        '--accent-warm-muted: rgba(212, 128, 63, 0.20)',
        '--accent-warm-subtle-a0: rgba(212, 128, 63, 0)', '--on-accent: #ffffff',
        '--button-primary-bg: #b05e2d', '--button-primary-bg-hover: #9c5027',
        '--button-primary-text: var(--on-accent)', '--focus-border: var(--accent)', '--toggle-thumb: #ffffff',
      ],
    } as const;
    for (const declaration of expectedThemeByScheme.light) {
      expect(themeLight).toContain(declaration);
    }
    for (const declaration of expectedThemeByScheme.dark) {
      expect(themeDark).toContain(declaration);
    }
    expect(themeDark).not.toContain('--accent: #c26d3a');
    expect(themeLight).not.toContain('--accent: #d4803f');
    const adapters = source('src/renderer/theme/themes/myagents-default.ts');
    const lightWidget = sourceSection(adapters, 'const lightWidgetVariables', 'const darkWidgetVariables');
    const darkWidget = sourceSection(adapters, 'const darkWidgetVariables', 'const light: ThemeSchemeDefinition');
    const lightAdapter = sourceSection(adapters, 'const light: ThemeSchemeDefinition', 'const dark: ThemeSchemeDefinition');
    const darkAdapter = sourceSection(adapters, 'const dark: ThemeSchemeDefinition', 'const noHeroBackground');
    for (const declaration of [
      "'--widget-accent': '#c26d3a'", "'--widget-accent-hover': '#e18a58'",
      "'--widget-accent-subtle': 'rgba(194, 109, 58, 0.08)'", "'--widget-primary-text': '#ffffff'",
    ]) expect(lightWidget).toContain(declaration);
    for (const declaration of [
      "'--widget-accent': '#d4803f'", "'--widget-accent-hover': '#e89860'",
      "'--widget-accent-subtle': 'rgba(212, 128, 63, 0.12)'", "'--widget-primary-text': '#ffffff'",
    ]) expect(darkWidget).toContain(declaration);
    for (const declaration of [
      "cursor: '#c26d3a'", "selectionBackground: 'rgba(194, 109, 58, 0.18)'",
      "selectionInactiveBackground: 'rgba(194, 109, 58, 0.10)'",
    ]) expect(lightAdapter).toContain(declaration);
    for (const declaration of [
      "cursor: '#c26d3a'", "selectionBackground: 'rgba(194, 109, 58, 0.25)'",
      "selectionInactiveBackground: 'rgba(194, 109, 58, 0.15)'",
    ]) expect(darkAdapter).toContain(declaration);
  });

  it('keeps action surfaces paired with their Theme-owned foreground tokens', () => {
    const forbiddenPairs = [
      /bg-\[var\(--(?:accent|accent-warm)\)\][^'"`]*\btext-white\b/,
      /\btext-white\b[^'"`]*bg-\[var\(--(?:accent|accent-warm)\)\]/,
      /bg-\[var\(--button-primary-bg\)\][^'"`]*text-\[var\(--button-dark-text\)\]/,
      /bg-\[var\(--button-dark-bg\)\][^'"`]*text-\[var\(--button-primary-text\)\]/,
      /background(?:-color)?\s*:\s*var\(--accent\)\s*;[^}]*color\s*:\s*#(?:fff|ffffff)\b/is,
      /background(?:-color)?\s*:\s*var\(--button-dark-bg\)[^}]*color\s*:\s*var\(--button-primary-text\)/is,
    ];
    const violations = rendererSourceFiles()
      .filter(file => forbiddenPairs.some(pattern => pattern.test(readFileSync(file, 'utf8'))));
    expect(violations).toEqual([]);

    const unvalidatedAccentHoverViolations = rendererSourceFiles()
      .filter(file => /bg-\[var\(--accent\)\][^'"`]*hover:brightness-/.test(readFileSync(file, 'utf8')));
    expect(unvalidatedAccentHoverViolations).toEqual([]);

    for (const primaryAction of [
      'src/renderer/components/chat-input/SimpleChatInput.tsx',
      'src/renderer/components/task-center/ThoughtInput.tsx',
      'src/renderer/components/task-center/editors/PanelChrome.tsx',
    ]) {
      const contents = source(primaryAction);
      expect(contents).toContain('bg-[var(--button-primary-bg)]');
      expect(contents).toContain('text-[var(--button-primary-text)]');
      expect(contents).toContain('hover:bg-[var(--button-primary-bg-hover)]');
    }

    const statusNames = ['success', 'error', 'warning', 'info'] as const;
    const statusViolations = rendererSourceFiles()
      .filter(file => {
        const contents = readFileSync(file, 'utf8');
        return statusNames.some(status => {
          const wrongForeground = `(?:white|\\[var\\(--on-(?!${status}\\b)[a-z-]+\\)\\])`;
          return new RegExp(`bg-\\[var\\(--${status}\\)\\][^'"\\x60]*text-${wrongForeground}`).test(contents)
            || new RegExp(`text-${wrongForeground}[^'"\\x60]*bg-\\[var\\(--${status}\\)\\]`).test(contents)
            || new RegExp(`background(?:-color)?\\s*:\\s*var\\(--${status}\\)\\s*;[^}]*color\\s*:\\s*var\\(--on-(?!${status}\\b)[a-z-]+\\)`, 'is').test(contents);
        });
      });
    expect(statusViolations).toEqual([]);

    expect(source('src/renderer/hooks/useChatSearch.ts')).toContain('color: var(--on-accent)');
    expect(source('src/renderer/index.css')).toContain('color: var(--button-dark-text)');
    const tip = source('src/renderer/components/Tip.tsx');
    expect(tip).toContain('text-[var(--button-dark-text)]/70');
    expect(tip).not.toContain('text-white');
    const floatingBall = source('src/renderer/floating-ball/fb.css');
    expect(floatingBall).toContain('color-mix(in srgb, var(--core-c) 45%, var(--fb-highlight-strong))');
    expect(floatingBall).toContain('background: var(--success);\n  color: var(--on-success);');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop { background: var(--button-dark-bg); color: var(--button-dark-text); }');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop:hover { background: var(--button-dark-bg-hover); }');
    expect(source('src/renderer/components/SettingsHelperInbox.tsx')).toContain('bg-[var(--ink)]/70 text-[var(--paper)]');
  });

  it('keeps Settings on the disk-first Theme and appearance write paths', () => {
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    expect(settings).toContain('updateConfig({ appearanceMode: mode })');
    expect(settings).toContain('themeSelectionExplicit: true');
    expect(settings).toContain("tSettings('general.themeTitle')");
    expect(settings).not.toContain("tSettings('about.developer.themeTitle')");
    expect(settings).not.toContain('updateConfig({ theme:');
    expect(settings).not.toContain('colorTheme');
  });

  it('keeps product default selection separate from canonical fallback', () => {
    const sharedTheme = source('src/shared/theme.ts');
    const registry = source('src/renderer/theme/registry.ts');
    expect(sharedTheme).toContain("CANONICAL_THEME_ID = 'myagents-default'");
    expect(sharedTheme).toContain("DEFAULT_THEME_ID = 'myagents-light'");
    expect(sharedTheme).toContain('themeSelectionExplicit');
    expect(registry).toContain('this.definitions.get(CANONICAL_THEME_ID)');
    expect(source('src/renderer/theme/bootstrap.ts')).toContain('THEME_BOOTSTRAP_VERSION = 2');
  });
});
