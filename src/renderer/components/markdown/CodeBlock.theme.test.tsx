import { render } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

const syntaxCapture = vi.hoisted(() => ({ styles: [] as Array<Record<string, CSSProperties>> }));

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ style, children }: { style: Record<string, CSSProperties>; children: string }) => {
    syntaxCapture.styles.push(style);
    return <pre data-testid="syntax">{children}</pre>;
  },
}));

import CodeBlock from './CodeBlock';

describe('CodeBlock Theme adapter', () => {
  it('switches Prism styles with the resolved Theme without retaining synthetic values', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <CodeBlock language="ts">const answer = 42;</CodeBlock>
      </ThemeRuntimeProvider>,
    );

    expect(syntaxCapture.styles.at(-1)?.['code[class*="language-"]']?.color).toBe('#21002f');

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}
      >
        <CodeBlock language="ts">const answer = 42;</CodeBlock>
      </ThemeRuntimeProvider>,
    );

    expect(syntaxCapture.styles.at(-1)?.['code[class*="language-"]']?.color).not.toBe('#21002f');
  });
});
