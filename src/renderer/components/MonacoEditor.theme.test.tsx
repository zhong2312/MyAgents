import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

const monacoCapture = vi.hoisted(() => ({
  defineTheme: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: monacoCapture.defineTheme,
    setTheme: monacoCapture.setTheme,
  },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: ({ beforeMount, theme }: { beforeMount?: (value: unknown) => void; theme?: string }) => {
    beforeMount?.({ editor: { defineTheme: monacoCapture.defineTheme } });
    return <div data-testid="monaco-editor" data-theme={theme} />;
  },
}));
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: class {} }));

import MonacoEditor from './MonacoEditor';

describe('MonacoEditor Theme adapter', () => {
  it('redefines and selects the new Theme without replacing the editor surface', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <MonacoEditor value="const x = 1" onChange={vi.fn()} language="typescript" />
      </ThemeRuntimeProvider>,
    );
    const editorSurface = view.getByTestId('monaco-editor');

    expect(monacoCapture.defineTheme).toHaveBeenCalledWith(
      'myagents-synthetic-test-theme-synthetic-light-monaco',
      syntheticTheme.schemes.light.monaco.data,
    );
    expect(monacoCapture.setTheme).toHaveBeenLastCalledWith(
      'myagents-synthetic-test-theme-synthetic-light-monaco',
    );

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'dark' }}
      >
        <MonacoEditor value="const x = 1" onChange={vi.fn()} language="typescript" />
      </ThemeRuntimeProvider>,
    );

    expect(view.getByTestId('monaco-editor')).toBe(editorSurface);
    expect(monacoCapture.defineTheme).toHaveBeenCalledWith(
      'myagents-synthetic-test-theme-synthetic-dark-monaco',
      syntheticTheme.schemes.dark.monaco.data,
    );
    expect(monacoCapture.setTheme).toHaveBeenLastCalledWith(
      'myagents-synthetic-test-theme-synthetic-dark-monaco',
    );

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}
      >
        <MonacoEditor value="const x = 1" onChange={vi.fn()} language="typescript" />
      </ThemeRuntimeProvider>,
    );

    expect(view.getByTestId('monaco-editor')).toBe(editorSurface);
    expect(monacoCapture.setTheme).toHaveBeenLastCalledWith('myagents-myagents-default-warm-light');
  });
});
