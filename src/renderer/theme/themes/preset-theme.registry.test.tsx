import { TextEncoder as NodeTextEncoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { ThemeRegistry } from '../registry';
import { absolutelyThemeManifest } from './absolutely';
import { codexThemeManifest } from './codex';
import { defaultBlackThemeManifest } from './default-black';
import { linearThemeManifest } from './linear';
import { myAgentsLightThemeManifest } from './myagents-light';
import { myAgentsDefaultTheme } from './myagents-default';
import { createPresetTheme } from './preset-theme';
import { proofThemeManifest } from './proof';
import { raycastThemeManifest } from './raycast';
import { sageThemeManifest } from './sage';

const manifests = [
  myAgentsLightThemeManifest,
  sageThemeManifest,
  absolutelyThemeManifest,
  linearThemeManifest,
  proofThemeManifest,
  codexThemeManifest,
  raycastThemeManifest,
] as const;

describe('production-minified preset Theme Registry', () => {
  it('registers and resolves the complete catalog after Vite CSS serialization', async () => {
    // JSDOM installs cross-realm binary constructors that violate esbuild's
    // startup invariant. Use the matching Node pair only at the production-
    // serialization boundary exercised by this test.
    vi.stubGlobal('TextEncoder', NodeTextEncoder);
    vi.stubGlobal('Uint8Array', new NodeTextEncoder().encode('').constructor);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { transformWithEsbuild } = await import('vite');
      const factories = await Promise.all(manifests.map(async manifest => {
        const { code: stylesheetText } = await transformWithEsbuild(
          manifest.stylesheetText,
          `${manifest.id}.css`,
          { loader: 'css', minify: true },
        );
        return {
          id: manifest.id,
          create: () => createPresetTheme({ ...manifest, stylesheetText }),
        };
      }));
      const { code: defaultBlackStylesheetText } = await transformWithEsbuild(
        defaultBlackThemeManifest.stylesheetText,
        'default-black.css',
        { loader: 'css', minify: true },
      );
      const registry = new ThemeRegistry(
        [myAgentsDefaultTheme],
        [
          {
            id: defaultBlackThemeManifest.id,
            create: () => ({
              ...defaultBlackThemeManifest,
              stylesheetText: defaultBlackStylesheetText,
              hero: myAgentsDefaultTheme.hero,
              schemes: myAgentsDefaultTheme.schemes,
            }),
          },
          ...factories,
        ],
        [
          myAgentsLightThemeManifest.id,
          myAgentsDefaultTheme.id,
          defaultBlackThemeManifest.id,
          ...manifests.slice(1).map(manifest => manifest.id),
        ],
      );

      expect(registry.getProductionIds()).toEqual([
        'myagents-light',
        'myagents-default',
        'default-black',
        ...manifests.slice(1).map(manifest => manifest.id),
      ]);
      expect(registry.resolve('default-black', 'light', false).themeId).toBe('default-black');
      for (const manifest of manifests) {
        expect(registry.resolve(manifest.id, 'light', false).themeId).toBe(manifest.id);
        expect(registry.resolve(manifest.id, 'dark', false).themeId).toBe(manifest.id);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
