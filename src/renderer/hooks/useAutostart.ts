// Hook for managing autostart functionality
// Uses tauri-plugin-autostart to enable/disable launch on system startup

import { useCallback, useEffect, useState } from 'react';
import { isTauriEnvironment } from '@/utils/browserMock';

// Types for autostart plugin
interface AutostartPlugin {
  isEnabled: () => Promise<boolean>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

let autostartPlugin: AutostartPlugin | null = null;

// Lazy load the autostart plugin
async function getAutostartPlugin(): Promise<AutostartPlugin | null> {
  if (!isTauriEnvironment()) {
    return null;
  }

  if (autostartPlugin) {
    return autostartPlugin;
  }

  try {
    const plugin = await import('@tauri-apps/plugin-autostart');
    autostartPlugin = plugin;
    return plugin;
  } catch (error) {
    console.error('[useAutostart] Failed to load autostart plugin:', error);
    return null;
  }
}

export function useAutostart(enabled = true) {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check current autostart status
  const checkStatus = useCallback(async () => {
    const plugin = await getAutostartPlugin();
    if (!plugin) {
      setIsLoading(false);
      return;
    }

    try {
      const enabled = await plugin.isEnabled();
      setIsEnabled(enabled);
    } catch (error) {
      console.error('[useAutostart] Failed to check status:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Enable autostart
  const enable = useCallback(async (): Promise<boolean> => {
    const plugin = await getAutostartPlugin();
    if (!plugin) {
      return false;
    }

    try {
      await plugin.enable();
      setIsEnabled(true);
      console.log('[useAutostart] Autostart enabled');
      return true;
    } catch (error) {
      console.error('[useAutostart] Failed to enable:', error);
      return false;
    }
  }, []);

  // Disable autostart
  const disable = useCallback(async (): Promise<boolean> => {
    const plugin = await getAutostartPlugin();
    if (!plugin) {
      return false;
    }

    try {
      await plugin.disable();
      setIsEnabled(false);
      console.log('[useAutostart] Autostart disabled');
      return true;
    } catch (error) {
      console.error('[useAutostart] Failed to disable:', error);
      return false;
    }
  }, []);

  // Toggle autostart
  const toggle = useCallback(async (): Promise<boolean> => {
    if (isEnabled) {
      return disable();
    } else {
      return enable();
    }
  }, [isEnabled, enable, disable]);

  // Set autostart state
  const setAutostart = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (enabled) {
      return enable();
    } else {
      return disable();
    }
  }, [enable, disable]);

  // Check status on mount
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    checkStatus();
  }, [checkStatus, enabled]);

  return {
    isEnabled,
    isLoading,
    enable,
    disable,
    toggle,
    setAutostart,
    checkStatus,
  };
}
