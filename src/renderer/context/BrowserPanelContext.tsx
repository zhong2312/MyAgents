import { createContext, useCallback, useContext } from 'react';

import { openExternal } from '@/utils/openExternal';

export interface BrowserPanelContextValue {
  /** Open a URL in the embedded browser panel */
  openUrl: (url: string) => void;
}

export const BrowserPanelContext = createContext<BrowserPanelContextValue | null>(null);

/** Returns the browser panel context, or null when not inside a Chat page */
export function useBrowserPanel(): BrowserPanelContextValue | null {
  return useContext(BrowserPanelContext);
}

/**
 * The primary action for a web link inside product UI.
 *
 * Chat provides BrowserPanelContext, so ordinary HTTP(S) links stay inside
 * MyAgents. Surfaces outside Chat — and explicit Cmd/Ctrl clicks — fall back to
 * the system handler. Mail links are never valid BrowserPanel navigation.
 */
export function useOpenWebLink(): (url: string, options?: { forceExternal?: boolean }) => void {
  const browserPanel = useBrowserPanel();
  return useCallback((url: string, options?: { forceExternal?: boolean }) => {
    if (!options?.forceExternal && browserPanel && /^https?:\/\//i.test(url)) {
      browserPanel.openUrl(url);
      return;
    }
    void openExternal(url);
  }, [browserPanel]);
}
