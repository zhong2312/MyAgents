import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_BOOTSTRAP_KEY } from './bootstrap';

const floatingMocks = vi.hoisted(() => ({
  listener: null as null | ((event: { payload: { themeId: string; appearanceMode: 'system' | 'light' | 'dark' } }) => void),
  loadAppConfig: vi.fn(async () => ({ themeId: 'myagents-default', appearanceMode: 'dark' })),
}));

vi.mock('@/config/services/appConfigService', () => ({
  loadAppConfig: floatingMocks.loadAppConfig,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: typeof floatingMocks.listener) => {
    floatingMocks.listener = handler;
    return vi.fn();
  }),
}));

import { FloatingThemeRuntime, useResolvedTheme } from './ThemeRuntime';

function Probe() {
  const theme = useResolvedTheme();
  return <output data-testid="floating-theme">{theme.key}</output>;
}

describe('FloatingThemeRuntime', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(THEME_BOOTSTRAP_KEY, JSON.stringify({
      version: 2,
      themeId: 'myagents-default',
      appearanceMode: 'light',
      themeSelectionExplicit: true,
    }));
    floatingMocks.listener = null;
    floatingMocks.loadAppConfig.mockClear();
    (window as Window & { __TAURI__?: object }).__TAURI__ = {};
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    delete (window as Window & { __TAURI__?: object }).__TAURI__;
    vi.unstubAllGlobals();
  });

  it('uses the bootstrap first frame, hydrates durable config, then accepts live main-window events', async () => {
    render(<FloatingThemeRuntime><Probe /></FloatingThemeRuntime>);

    expect(screen.getByTestId('floating-theme')).toHaveTextContent('myagents-default:light');
    await waitFor(() => expect(screen.getByTestId('floating-theme')).toHaveTextContent('myagents-default:dark'));
    await waitFor(() => expect(floatingMocks.listener).not.toBeNull());

    act(() => floatingMocks.listener?.({
      payload: { themeId: 'myagents-default', appearanceMode: 'light' },
    }));
    expect(screen.getByTestId('floating-theme')).toHaveTextContent('myagents-default:light');
    expect(document.documentElement.dataset.colorScheme).toBe('light');
  });

  it('registers live sync before hydration and never lets an older hydration overwrite a newer event', async () => {
    let resolveConfig!: (value: { themeId: string; appearanceMode: 'dark' }) => void;
    floatingMocks.loadAppConfig.mockImplementationOnce(() => new Promise(resolve => {
      resolveConfig = resolve;
    }));

    render(<FloatingThemeRuntime><Probe /></FloatingThemeRuntime>);

    await waitFor(() => expect(floatingMocks.listener).not.toBeNull());
    expect(floatingMocks.loadAppConfig).toHaveBeenCalledTimes(1);
    act(() => floatingMocks.listener?.({
      payload: { themeId: 'myagents-default', appearanceMode: 'light' },
    }));
    expect(screen.getByTestId('floating-theme')).toHaveTextContent('myagents-default:light');

    await act(async () => {
      resolveConfig({ themeId: 'myagents-default', appearanceMode: 'dark' });
      await Promise.resolve();
    });
    expect(screen.getByTestId('floating-theme')).toHaveTextContent('myagents-default:light');
  });
});
