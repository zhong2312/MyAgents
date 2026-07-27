import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { themeRegistry } from './registry';

const STYLE_ID = 'space-theme-integration-test-styles';
const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const representativeVisualTokens = [
  '--font-body',
  '--paper',
  '--paper-elevated',
  '--paper-inset',
  '--ink',
  '--ink-muted',
  '--line',
  '--accent',
  '--button-primary-bg',
  '--button-primary-text',
  '--success',
  '--error',
  '--warning',
  '--theme-radius-xl',
  '--theme-shadow-sm',
] as const;

afterEach(() => {
  document.getElementById(STYLE_ID)?.remove();
  document.body.replaceChildren();
  document.documentElement.className = '';
  delete document.documentElement.dataset.themeId;
  delete document.documentElement.dataset.colorScheme;
});

describe('Space Theme integration', () => {
  it('keeps Space and portaled popovers inside the app-level Theme owner', () => {
    for (const file of [
      'src/renderer/pages/Space.tsx',
      'src/renderer/pages/space/SpaceChrome.tsx',
      'src/renderer/components/ui/Popover.tsx',
      'src/renderer/index.css',
    ]) {
      const contents = source(file);
      expect(contents).not.toContain('data-ui-theme');
      expect(contents).not.toContain('space-mono');
    }
  });

  it.each(['light', 'dark'] as const)(
    'exposes every representative %s visual token to Space from each production Theme',
    (scheme) => {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
      const themeSignatures = new Set<string>();

      for (const definition of themeRegistry.getAcceptedDefinitions()) {
        style.textContent = definition.stylesheetText;
        document.documentElement.dataset.themeId = definition.id;
        document.documentElement.dataset.colorScheme = scheme;
        document.documentElement.classList.toggle('dark', scheme === 'dark');

        const rootStyles = getComputedStyle(document.documentElement);
        const values = representativeVisualTokens.map(token => {
          const rootValue = rootStyles.getPropertyValue(token).trim();
          expect(rootValue, `${definition.id}.${scheme}.${token}`).not.toBe('');
          return rootValue;
        });
        themeSignatures.add(values.join('|'));
      }

      expect(themeSignatures.size).toBeGreaterThan(2);
    },
  );
});
