import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useResolvedTheme } from '@/theme';


interface TerminalPanelProps {
  workspacePath: string;
  terminalId: string | null;
  onTerminalCreated: (id: string) => void;
  onTerminalExited: () => void;
  /** Whether this panel is currently the visible view (for fit-on-show) */
  isVisible?: boolean;
  /** Session ID for this Tab — used to resolve sidecar port for MYAGENTS_PORT env var */
  sessionId?: string | null;
}

export function TerminalPanel({
  workspacePath,
  terminalId,
  onTerminalCreated,
  onTerminalExited,
  isVisible = true,
  sessionId: sessionIdProp,
}: TerminalPanelProps) {
  const { adapters } = useResolvedTheme();
  const xtermTheme = adapters.xterm;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(terminalId);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastColsRef = useRef<number>(0);
  const lastRowsRef = useRef<number>(0);
  const transitionGuardRef = useRef(isVisible);
  const [geometryReady, setGeometryReady] = useState(false);
  useEffect(() => { terminalIdRef.current = terminalId; }, [terminalId]);

  // Arm the transition guard before passive Theme/PTY effects run. This is a
  // layout effect because a false -> true visibility render must not expose a
  // single frame where metric fitting can observe the expanding panel width.
  useLayoutEffect(() => {
    transitionGuardRef.current = isVisible;
  }, [isVisible]);


  // Stable callbacks via refs to avoid effect re-runs
  const onTerminalCreatedRef = useRef(onTerminalCreated);
  const onTerminalExitedRef = useRef(onTerminalExited);
  useEffect(() => { onTerminalCreatedRef.current = onTerminalCreated; }, [onTerminalCreated]);
  useEffect(() => { onTerminalExitedRef.current = onTerminalExited; }, [onTerminalExited]);

  // Mounted guard to prevent stale async callbacks
  const isMountedRef = useRef(true);
  // Store unlisten functions from create flow so they can be cleaned up on unmount.
  // Without this, each terminal open/close cycle leaks two Tauri event listeners.
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
    };
  }, []);

  // 1. Initialize xterm.js instance (once on mount)
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: xtermTheme.palette,
      fontFamily: xtermTheme.fontFamily,
      fontSize: xtermTheme.fontSize,
      lineHeight: xtermTheme.lineHeight,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      // macOS key handling
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      // Right-click: select word + show native context menu (Copy/Paste)
      rightClickSelectsWord: true,
      // Visual
      drawBoldTextInBrightColors: true,
      customGlyphs: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  // Theme changes update options in effect 1b without recreating the PTY.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Create PTY — "listeners first" pattern to prevent exit event loss.
  //    Frontend generates the terminal ID, registers listeners, THEN creates the PTY.
  //    This closes the race where a fast-exiting shell beats listener registration.
  const creatingRef = useRef(false); // In-flight guard prevents double creation

  useEffect(() => {
    if (terminalId !== null) return; // Already created
    if (!fitAddonRef.current) return; // xterm not ready yet
    if (!geometryReady) return; // Wait until the width transition has settled
    if (creatingRef.current) return; // Creation already in flight
    creatingRef.current = true;

    // Clear xterm buffer before creating new PTY — prevents zsh PROMPT_EOL_MARK (%)
    // from appearing when reusing the xterm instance after a previous shell exited
    if (xtermRef.current) {
      xtermRef.current.reset();
    }

    const dims = fitAddonRef.current.proposeDimensions();
    const rows = dims?.rows ?? 24;
    const cols = dims?.cols ?? 80;

    // Generate ID frontend-side so we can register listeners before PTY creation
    const preId = crypto.randomUUID();
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const create = async () => {
      // Step 1: Register listeners FIRST (before PTY exists)
      unlistenData = await listen<number[]>(`terminal:data:${preId}`, (event) => {
        if (xtermRef.current && event.payload) {
          xtermRef.current.write(new Uint8Array(event.payload));
        }
      });
      if (cancelled) { unlistenData(); creatingRef.current = false; return; }

      unlistenExit = await listen(`terminal:exit:${preId}`, () => {
        xtermRef.current?.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        onTerminalExitedRef.current();
      });
      if (cancelled) { unlistenExit(); unlistenData?.(); creatingRef.current = false; return; }

      // Step 2: Create PTY with pre-generated ID. Rust resolves the current
      // Session generation before injecting MYAGENTS_PORT.
      const id = await invoke<string>('cmd_terminal_create', {
        workspacePath, rows, cols,
        sessionId: sessionIdProp ?? null,
        terminalId: preId,
      });

      creatingRef.current = false;

      if (!isMountedRef.current || cancelled) {
        invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
        unlistenData?.();
        unlistenExit?.();
        return;
      }
      // Store unlisten functions in refs for cleanup on unmount (prevents listener leak)
      unlistenDataRef.current = unlistenData;
      unlistenExitRef.current = unlistenExit;
      onTerminalCreatedRef.current(id);
      // Auto-focus terminal after creation
      requestAnimationFrame(() => { xtermRef.current?.focus(); });
    };

    create().catch((err) => {
      creatingRef.current = false;
      // Clean up pre-registered listeners on failure to prevent leaks
      unlistenData?.();
      unlistenExit?.();
      console.error('[TerminalPanel] Failed to create terminal:', err);
      xtermRef.current?.write(`\r\nFailed to create terminal: ${err}\r\n`);
    });

    return () => {
      cancelled = true;
      // Listeners cleaned up inside create() on cancel, or will be cleaned up
      // by the next effect cycle when terminalId becomes non-null
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionIdProp: one-time env injection at creation
  }, [terminalId, workspacePath, geometryReady]);

  // 3. User input → PTY write
  useEffect(() => {
    if (!terminalId || !xtermRef.current) return;

    const disposable = xtermRef.current.onData((data: string) => {
      const encoded = Array.from(new TextEncoder().encode(data));
      invoke('cmd_terminal_write', { terminalId, data: encoded }).catch((err) => {
        console.error('[TerminalPanel] Write error:', err);
      });
    });

    return () => disposable.dispose();
  }, [terminalId]);

  // 5. Unified resize with geometry-settle suppression.
  //
  // ROOT CAUSE of prompt truncation: while the split width transitions, the terminal
  // container changes continuously. Fitting each intermediate width sends repeated
  // SIGWINCH events and redraws the prompt at stale columns.
  //
  // Theme owns transition durations, so this component must not duplicate one as a
  // timeout. ResizeObserver is the geometry owner: after 100ms without another size
  // observation, fit once at the actual stable width.
  const doFitAndResize = useCallback(() => {
    // Every fit path, including Theme-driven font metric updates, must respect
    // the panel-width transition. The final visibility timer applies the
    // latest options once the geometry is stable.
    if (transitionGuardRef.current) return;
    if (!fitAddonRef.current || !containerRef.current) return;
    // Skip if container is too narrow — still in CSS transition or hidden
    if (containerRef.current.clientWidth < 100) return;
    fitAddonRef.current.fit();
    const dims = fitAddonRef.current.proposeDimensions();
    if (!dims || !terminalIdRef.current) return;
    // Only send resize to PTY if dimensions actually changed
    if (dims.cols === lastColsRef.current && dims.rows === lastRowsRef.current) return;
    lastColsRef.current = dims.cols;
    lastRowsRef.current = dims.rows;
    invoke('cmd_terminal_resize', {
      terminalId: terminalIdRef.current,
      rows: dims.rows,
      cols: dims.cols,
    }).catch(() => {});
  }, []);

  const scheduleGeometrySettle = useCallback(() => {
    if (!isVisible) return;
    // Every new observation re-arms the guard. A Theme/font update that lands
    // inside this quiet window must not fit against intermediate geometry.
    transitionGuardRef.current = true;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      transitionGuardRef.current = false;
      doFitAndResize();
      setGeometryReady(true);
      xtermRef.current?.focus();
    }, 100);
  }, [doFitAndResize, isVisible]);

  // 1b. Update the existing xterm in place. Font metric changes invalidate
  // the grid geometry, so route them through the same fit + PTY resize owner
  // used by container resizes instead of leaving rows/cols stale until the
  // next incidental ResizeObserver event.
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme = xtermTheme.palette;
    xtermRef.current.options.fontFamily = xtermTheme.fontFamily;
    xtermRef.current.options.fontSize = xtermTheme.fontSize;
    xtermRef.current.options.lineHeight = xtermTheme.lineHeight;
    doFitAndResize();
  }, [xtermTheme, doFitAndResize]);

  // ResizeObserver — fires on container size changes (drag resize, window resize)
  // Suppressed during the visibility transition window to prevent intermediate resizes.
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      scheduleGeometrySettle();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [scheduleGeometrySettle]);

  // Visibility change arms geometry settling. Subsequent ResizeObserver callbacks
  // keep moving the quiet-window timer until the Theme-owned transition really ends.
  useEffect(() => {
    if (!isVisible) {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      setGeometryReady(false);
      return;
    }
    transitionGuardRef.current = true;
    setGeometryReady(false);
    scheduleGeometrySettle();
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      transitionGuardRef.current = false;
    };
  }, [isVisible, scheduleGeometrySettle]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full px-2 pb-1"
      style={{ background: xtermTheme.palette.background }}
    />
  );
}
