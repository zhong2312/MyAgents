import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

const mermaidCapture = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg><text>ok</text></svg>' })),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidCapture.initialize,
    render: mermaidCapture.render,
  },
}));

import MermaidDiagram from './MermaidDiagram';

describe('MermaidDiagram Theme adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mermaidCapture.initialize.mockClear();
    mermaidCapture.render.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it('re-renders unchanged source when the Theme key changes and keeps strict security', async () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const source = 'flowchart TD\n  A --> B';
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <MermaidDiagram>{source}</MermaidDiagram>
      </ThemeRuntimeProvider>,
    );

    await act(async () => vi.advanceTimersByTimeAsync(310));
    expect(view.container.querySelector('.markdown-code-block')).toHaveClass(
      'rounded-md',
      'border',
      'border-[var(--line)]',
      'bg-[var(--paper-inset)]/30',
    );
    expect(view.container.querySelector('.markdown-code-block')?.firstElementChild).toHaveClass(
      'bg-[var(--code-bg)]',
    );
    fireEvent.click(view.getByRole('button', { name: /code|代码/i }));
    expect(view.container.querySelector('.markdown-code-block pre')).toHaveClass('overflow-x-auto');
    expect(mermaidCapture.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: 'neutral',
      securityLevel: 'strict',
      fontFamily: "'synthetic-light-mermaid-font', serif",
      themeVariables: expect.objectContaining({ primaryColor: '#efd0f5' }),
    }));
    expect(mermaidCapture.render).toHaveBeenCalledTimes(1);

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'dark' }}
      >
        <MermaidDiagram>{source}</MermaidDiagram>
      </ThemeRuntimeProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(310));

    expect(mermaidCapture.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: "'synthetic-dark-mermaid-font', serif",
      themeVariables: expect.objectContaining({ primaryColor: '#240024' }),
    }));
    expect(mermaidCapture.render).toHaveBeenCalledTimes(2);
  });
});
