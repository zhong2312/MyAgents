// Hook for handling system tray events and window close behavior
// Manages minimize-to-tray functionality and exit confirmation

import { useEffect, useCallback, useRef } from 'react';
import { emit } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '@/utils/browserMock';
import { dismissTopmost } from '@/utils/closeLayer';
import {
  setWindowVisible,
  consumePendingNotificationClick,
} from '@/services/notificationService';
import { listenWithCleanup } from '@/utils/tauriListen';

interface TrayEventsOptions {
  /** Whether minimize to tray is enabled */
  minimizeToTray: boolean;
  /** Callback when settings should be opened */
  onOpenSettings?: () => void;
  /** Callback when exit is requested (for confirmation if cron tasks are running) */
  onExitRequested?: () => Promise<boolean>;
  /** Callback for Cmd+W close-tab action (after overlay dismissal).
   *  closeCurrentTab() auto-creates launcher on last tab; launcher is a no-op. */
  onCmdWCloseTab?: () => void;
  /** Callback when the main window regains focus. */
  onWindowFocused?: () => void;
  /** Synchronous projection of the native main-window focus state. */
  onWindowFocusChanged?: (focused: boolean) => void;
}

export function useTrayEvents(options: TrayEventsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Handle window hide (minimize to tray)
  const hideWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.hide();
      setWindowVisible(false);
      console.log('[useTrayEvents] Window hidden to tray');
    } catch (error) {
      console.error('[useTrayEvents] Failed to hide window:', error);
    }
  }, []);

  // Handle window close (either hide or exit)
  const closeWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error('[useTrayEvents] Failed to close window:', error);
    }
  }, []);

  // Confirm and exit the app
  const confirmExit = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      // Emit event to Rust to confirm exit
      await emit('tray:confirm-exit');
    } catch (error) {
      console.error('[useTrayEvents] Failed to emit exit event:', error);
    }
  }, []);

  // Setup event listeners
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenFocusChanged: (() => void) | null = null;
    const ac = new AbortController();

    const setupListeners = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();

        // window.onFocusChanged keeps the visibility tracker in sync (used by
        // `shouldNotify()`). It also fires on macOS / Linux when the user
        // clicks a banner that auto-activates the app — we ask Rust to flush
        // any pending toast-click deep-link, since on those platforms the
        // OS doesn't give us an in-process Activated callback. Windows
        // doesn't need this hop: `Toast::on_activated` already emitted
        // `notification:click` directly.
        //
        // window.onFocusChanged is a Tauri window API (not Tauri event API),
        // so it isn't covered by `listenWithCleanup`. The hook still benefits
        // from the AbortController for symmetry — we manually invoke the
        // returned unlisten in the cleanup branch.
        unlistenFocusChanged = await window.onFocusChanged(({ payload: focused }) => {
          if (ac.signal.aborted) return;
          optionsRef.current.onWindowFocusChanged?.(focused);
          console.debug('[useTrayEvents] Window focus changed:', focused);
          if (focused) {
            setWindowVisible(true);
            void (async () => {
              const consumedNotificationClick = await consumePendingNotificationClick();
              if (ac.signal.aborted) return;
              if (!consumedNotificationClick) {
                optionsRef.current.onWindowFocused?.();
              }
            })();
          } else {
            setWindowVisible(false);
          }
        });
        if (ac.signal.aborted) {
          unlistenFocusChanged?.();
          unlistenFocusChanged = null;
          return;
        }

        // ── Cmd+W handler (macOS custom menu item → window:cmd-w) ──
        // Separated from X button (CloseRequested). Cmd+W walks the close hierarchy:
        // overlay → split panel → tab → launcher (terminal state, never exits).
        void listenWithCleanup('window:cmd-w', () => {
          console.log('[useTrayEvents] Cmd+W received');
          // 1. Try dismissing topmost overlay/panel
          if (dismissTopmost()) {
            console.log('[useTrayEvents] Cmd+W: overlay dismissed');
            return;
          }
          // 2. Safety net: unregistered overlay visible → block (safe degradation)
          if (document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')) {
            console.log('[useTrayEvents] Cmd+W: unregistered overlay visible, blocked');
            return;
          }
          // 3. Close current tab (auto-creates launcher on last tab; launcher is no-op)
          optionsRef.current.onCmdWCloseTab?.();
          console.log('[useTrayEvents] Cmd+W: tab closed');
        }, ac.signal);

        // ── X button / system close (CloseRequested → window:close-requested) ──
        // Pure tray/exit behavior — no overlay/tab logic (that's Cmd+W's job).
        void listenWithCleanup('window:close-requested', async () => {
          console.log('[useTrayEvents] Window close requested (X button)');
          const { minimizeToTray } = optionsRef.current;

          if (minimizeToTray) {
            const win = getCurrentWindow();
            await win.hide();
            setWindowVisible(false);
            console.log('[useTrayEvents] Window hidden to tray');
          } else {
            const { onExitRequested } = optionsRef.current;
            if (onExitRequested) {
              const canExit = await onExitRequested();
              if (canExit) {
                await emit('tray:confirm-exit');
              }
            } else {
              await emit('tray:confirm-exit');
            }
          }
        }, ac.signal);

        // Listen for tray "open settings" menu click
        void listenWithCleanup('tray:open-settings', () => {
          console.log('[useTrayEvents] Open settings from tray');
          optionsRef.current.onOpenSettings?.();
        }, ac.signal);

        // Listen for tray "exit" menu click
        void listenWithCleanup('tray:exit-requested', async () => {
          console.log('[useTrayEvents] Exit requested from tray');
          const { onExitRequested } = optionsRef.current;
          if (onExitRequested) {
            const canExit = await onExitRequested();
            if (canExit) {
              await emit('tray:confirm-exit');
            }
          } else {
            await emit('tray:confirm-exit');
          }
        }, ac.signal);

        console.log('[useTrayEvents] Event listeners setup complete');
      } catch (error) {
        console.error('[useTrayEvents] Failed to setup listeners:', error);
      }
    };

    setupListeners();

    return () => {
      ac.abort();
      if (unlistenFocusChanged) unlistenFocusChanged();
    };
  }, []);

  return {
    hideWindow,
    closeWindow,
    confirmExit,
  };
}
