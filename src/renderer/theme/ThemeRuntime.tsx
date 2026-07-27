import React, {
  createContext,
  useContext,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useConfig } from '@/hooks/useConfig';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import {
  normalizeAppearanceMode,
  normalizeThemeId,
  type ThemeSelection,
} from '../../shared/theme';
import { readThemeBootstrapSelection, writeThemeBootstrapSnapshot } from './bootstrap';
import { ThemeRegistry, themeRegistry } from './registry';
import type { ResolvedTheme } from './types';

export const THEME_SELECTION_CHANGED_EVENT = 'theme:selection-changed';

function getSystemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function subscribeSystemColorScheme(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onStoreChange);
  return () => media.removeEventListener('change', onStoreChange);
}

const ThemeRuntimeContext = createContext<ResolvedTheme | null>(null);

function normalizeSelection(selection: ThemeSelection): ThemeSelection {
  return {
    themeId: normalizeThemeId(selection.themeId),
    appearanceMode: normalizeAppearanceMode(selection.appearanceMode),
  };
}

function applyRootTheme(resolvedTheme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.themeId = resolvedTheme.themeId;
  root.dataset.colorScheme = resolvedTheme.resolvedColorScheme;
  root.classList.toggle('dark', resolvedTheme.resolvedColorScheme === 'dark');
  root.style.colorScheme = resolvedTheme.resolvedColorScheme;
}

function syncMainWindowBackground(): void {
  if (!isTauriEnvironment()) return;

  const currentWindow = getCurrentWindow();
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  void currentWindow.setBackgroundColor(paper)
    .catch(error => console.warn('[theme] Failed to sync native window background:', error));
}

const ACTIVE_THEME_STYLESHEET_ID = 'myagents-active-theme-stylesheet';

function activateThemeStylesheet(resolvedTheme: ResolvedTheme): void {
  let style = document.getElementById(ACTIVE_THEME_STYLESHEET_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = ACTIVE_THEME_STYLESHEET_ID;
    document.head.appendChild(style);
  }
  if (style.dataset.themeId !== resolvedTheme.themeId) {
    // ThemeDefinition owns the exact source that registration validated.
    // This runtime projection makes a package complete even when its CSS is
    // not statically present in the entry bundle. The canonical Theme still
    // imports CSS statically to protect the pre-React first frame.
    style.textContent = resolvedTheme.definition.stylesheetText;
    style.dataset.themeId = resolvedTheme.themeId;
  }
}

/**
 * Activates the last validated snapshot before React creates its first tree.
 * Optional packages stay side-effect free at module evaluation; this explicit
 * bootstrap closes the canonical-to-preset gap before the first React paint.
 */
export function primeThemeRuntimeFromBootstrap(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null =
    typeof localStorage === 'undefined' ? null : localStorage,
  registry: ThemeRegistry = themeRegistry,
): ResolvedTheme {
  const selection = readThemeBootstrapSelection(storage);
  const resolvedTheme = registry.resolve(
    selection.themeId,
    selection.appearanceMode,
    getSystemPrefersDark(),
  );
  activateThemeStylesheet(resolvedTheme);
  applyRootTheme(resolvedTheme);
  return resolvedTheme;
}

export interface ThemeRuntimeProviderProps {
  children: React.ReactNode;
  /** null keeps the pre-React snapshot authoritative until durable config loads. */
  selection: ThemeSelection | null;
  /** Whether the durable selection was explicitly chosen by the user. */
  selectionExplicit?: boolean;
  registry?: ThemeRegistry;
  broadcastSelection?: boolean;
  persistBootstrapSnapshot?: boolean;
  syncNativeWindowBackground?: boolean;
}

export function ThemeRuntimeProvider({
  children,
  selection,
  selectionExplicit = true,
  registry = themeRegistry,
  broadcastSelection = false,
  persistBootstrapSnapshot = true,
  syncNativeWindowBackground = false,
}: ThemeRuntimeProviderProps) {
  const [bootstrapSelection] = useState(() => readThemeBootstrapSelection(
    typeof localStorage === 'undefined' ? null : localStorage,
  ));
  const effectiveSelection = useMemo(
    () => normalizeSelection(selection ?? bootstrapSelection),
    [bootstrapSelection, selection],
  );
  const effectiveSelectionExplicit = selection === null
    ? bootstrapSelection.themeSelectionExplicit
    : selectionExplicit;
  const systemPrefersDark = useSyncExternalStore(
    subscribeSystemColorScheme,
    getSystemPrefersDark,
    () => false,
  );

  const resolvedTheme = useMemo(
    () => registry.resolve(
      effectiveSelection.themeId,
      effectiveSelection.appearanceMode,
      systemPrefersDark,
    ),
    [effectiveSelection.appearanceMode, effectiveSelection.themeId, registry, systemPrefersDark],
  );

  useInsertionEffect(() => {
    activateThemeStylesheet(resolvedTheme);
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    applyRootTheme(resolvedTheme);
    if (syncNativeWindowBackground) syncMainWindowBackground();
  }, [resolvedTheme, syncNativeWindowBackground]);

  useEffect(() => {
    // Only the durable main-window selection replaces the bootstrap snapshot.
    // During ConfigProvider load, selection=null preserves the last-known
    // correct first frame; floating windows must not become config owners.
    if (selection === null || !persistBootstrapSnapshot) return;
    // Persist the resolved ID, not a missing/unknown requested ID. This makes
    // whole-Theme fallback authoritative on the next pre-React frame too.
    writeThemeBootstrapSnapshot(localStorage, {
      themeId: resolvedTheme.themeId,
      appearanceMode: effectiveSelection.appearanceMode,
      themeSelectionExplicit: effectiveSelectionExplicit,
    });
  }, [
    effectiveSelection.appearanceMode,
    effectiveSelectionExplicit,
    persistBootstrapSnapshot,
    resolvedTheme.themeId,
    selection,
  ]);

  useEffect(() => {
    if (!broadcastSelection || selection === null || !isTauriEnvironment()) return;
    void emit(THEME_SELECTION_CHANGED_EVENT, effectiveSelection)
      .catch(error => console.warn('[theme] Failed to broadcast Theme selection:', error));
  }, [broadcastSelection, effectiveSelection, selection]);

  return (
    <ThemeRuntimeContext.Provider value={resolvedTheme}>
      {children}
    </ThemeRuntimeContext.Provider>
  );
}

export function ConfiguredThemeRuntime({ children }: { children: React.ReactNode }) {
  const { config, isLoading } = useConfig();
  const selection = useMemo<ThemeSelection | null>(() => isLoading ? null : ({
    themeId: config.themeId,
    appearanceMode: config.appearanceMode,
  }), [config.appearanceMode, config.themeId, isLoading]);
  return (
    <ThemeRuntimeProvider
      selection={selection}
      selectionExplicit={config.themeSelectionExplicit === true}
      broadcastSelection
      syncNativeWindowBackground
    >
      {children}
    </ThemeRuntimeProvider>
  );
}

export function FloatingThemeRuntime({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<ThemeSelection>(() => readThemeBootstrapSelection(
    typeof localStorage === 'undefined' ? null : localStorage,
  ));

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();
    let liveEventRevision = 0;

    void (async () => {
      // Register first. An event emitted before registration is represented by
      // the durable disk-first config loaded below; an event observed after
      // registration is newer than that hydration result and must win.
      if (isTauriEnvironment()) {
        await listenWithCleanup<ThemeSelection>(THEME_SELECTION_CHANGED_EVENT, event => {
          liveEventRevision += 1;
          if (!cancelled) setSelection(normalizeSelection(event.payload));
        }, abortController.signal);
      }
      if (cancelled) return;

      try {
        const { loadAppConfig } = await import('@/config/services/appConfigService');
        const config = await loadAppConfig();
        if (!cancelled && liveEventRevision === 0) {
          setSelection(normalizeSelection(config));
        }
      } catch (error) {
        console.warn('[theme] Floating window config hydration failed:', error);
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, []);

  return (
    <ThemeRuntimeProvider selection={selection} persistBootstrapSnapshot={false}>
      {children}
    </ThemeRuntimeProvider>
  );
}

export function useResolvedTheme(): ResolvedTheme {
  const theme = useContext(ThemeRuntimeContext);
  if (!theme) {
    throw new Error('[theme] useResolvedTheme must be used within ThemeRuntimeProvider');
  }
  return theme;
}
