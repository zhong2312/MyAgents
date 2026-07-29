import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';

import { absolutelyThemeManifest } from './absolutely';
import { codexThemeManifest } from './codex';
import { linearThemeManifest } from './linear';
import { createPresetTheme } from './preset-theme';
import { proofThemeManifest } from './proof';
import { raycastThemeManifest } from './raycast';
import { sageThemeManifest } from './sage';

const manifests = [
  sageThemeManifest,
  absolutelyThemeManifest,
  linearThemeManifest,
  proofThemeManifest,
  codexThemeManifest,
  raycastThemeManifest,
] as const;

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((value >> 16) & 255)
    + 0.7152 * channel((value >> 8) & 255)
    + 0.0722 * channel(value & 255);
}

function contrast(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe('preset Theme construction', () => {
  it.each(manifests)('constructs $id from production-minified inline CSS', async (manifest) => {
    const { code: minifiedStylesheetText } = await transformWithEsbuild(
      manifest.stylesheetText,
      `${manifest.id}.css`,
      { loader: 'css', minify: true },
    );

    // This is the serialization Vite emits for `?inline` CSS in production.
    // The Theme contract is semantic, so optional package construction must
    // not depend on source-only quotes or whitespace surviving this step.
    expect(minifiedStylesheetText).toContain(`html[data-theme-id=${manifest.id}]{`);

    const definition = createPresetTheme({
      ...manifest,
      stylesheetText: minifiedStylesheetText,
    });

    expect(definition.id).toBe(manifest.id);
    expect(definition.schemes.light.monaco.data.colors['editor.background']).toBeTruthy();
    expect(definition.schemes.dark.widget.variables['--widget-accent']).toBeTruthy();
  });

  it('pairs light Prism colors with the Theme-owned light code surface', () => {
    const definition = createPresetTheme(absolutelyThemeManifest);
    const prism = definition.schemes.light.prism;
    expect(prism['pre[class*="language-"]']?.color).toBe('#46453f');
    expect(prism['code[class*="language-"]']?.color).toBe('#46453f');

    for (const [selector, style] of Object.entries(prism)) {
      if (!style.color?.startsWith('#')) continue;
      expect(
        contrast(style.color, '#f3f1ed'),
        `Claude light Prism ${selector}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
