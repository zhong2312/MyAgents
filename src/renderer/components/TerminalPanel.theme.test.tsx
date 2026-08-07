import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

const xtermCapture = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));
const fitCapture = vi.hoisted(() => ({
  instances: [] as Array<{
    fit: ReturnType<typeof vi.fn>;
    proposeDimensions: ReturnType<typeof vi.fn>;
  }>,
}));
const invokeMock = vi.hoisted(() => vi.fn(async (command: string) => (
  command === 'cmd_terminal_create' ? 'created-pty' : undefined
)));
let emitResize: (() => void) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    reset = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xtermCapture.instances.push(this);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ rows: 24, cols: 80 }));

    constructor() {
      fitCapture.instances.push(this);
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));

import { TerminalPanel } from './TerminalPanel';

describe('TerminalPanel Theme adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    xtermCapture.instances.length = 0;
    fitCapture.instances.length = 0;
    invokeMock.mockClear();
    emitResize = null;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        emitResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(): void { /* test drives observations explicitly */ }
      unobserve(): void { /* no-op */ }
      disconnect(): void { /* no-op */ }
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 640,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('updates xterm in place and defers metric fitting until the width transition settles', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId="existing-pty"
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(xtermCapture.instances).toHaveLength(1);
    const terminal = xtermCapture.instances[0];
    expect((terminal.options.theme as Record<string, string>).background).toBe('#fff0ff');
    expect(terminal.options.fontFamily).toBe("'synthetic-light-xterm-font', monospace");
    const fitAddon = fitCapture.instances[0];
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    fitAddon.proposeDimensions.mockReturnValue({ rows: 20, cols: 60 });

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'dark' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId="existing-pty"
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(xtermCapture.instances).toHaveLength(1);
    expect((terminal.options.theme as Record<string, string>).background).toBe('#120012');
    expect(terminal.options.fontSize).toBe(19);
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => {
      // A long Theme-owned width transition keeps producing observations;
      // none may unlock fitting until the geometry has been quiet for 100ms.
      vi.advanceTimersByTime(99);
      emitResize?.();
      vi.advanceTimersByTime(99);
      emitResize?.();
      vi.advanceTimersByTime(99);
    });

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    // Only the final visibility timer may fit and send Theme-metric SIGWINCH.
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_terminal_resize', {
      terminalId: 'existing-pty',
      rows: 20,
      cols: 60,
    });

    fitAddon.proposeDimensions.mockReturnValue({ rows: 18, cols: 55 });
    act(() => {
      emitResize?.();
    });
    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId="existing-pty"
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(terminal.options.fontSize).toBe(17);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_terminal_resize', {
      terminalId: 'existing-pty',
      rows: 18,
      cols: 55,
    });
  });

  it('defers first PTY creation until the panel geometry is stable', async () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId={null}
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(invokeMock).not.toHaveBeenCalledWith('cmd_terminal_create', expect.anything());

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith('cmd_terminal_create', {
      workspacePath: '/tmp/theme-test',
      rows: 24,
      cols: 80,
      sessionId: null,
      terminalId: expect.any(String),
    });
  });
});
