import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ThemeRuntimeProvider } from '@/theme';

/** Standard Theme owner for isolated renderer component tests. */
export function renderWithTheme(ui: ReactElement, options?: RenderOptions): RenderResult {
  return render(
    <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}>
      {ui}
    </ThemeRuntimeProvider>,
    options,
  );
}
