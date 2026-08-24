import { useCallback, useMemo } from "react";

import type { WorkbenchStorage } from "../../shared/workbench-sdk";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { listenWithCleanup } from "@/utils/tauriListen";
import { isTauriEnvironment } from "@/utils/browserMock";
import {
  createWorkbenchStorage,
  type WorkbenchStorageWatchFactory,
} from "./storageAdapter";

const BROWSER_WATCH_POLL_INTERVAL_MS = 2_000;

export function useWorkbenchStorage(workspacePath: string): WorkbenchStorage {
  const fileService = useWorkspaceFileService(workspacePath || null);

  const watchFactory = useCallback<WorkbenchStorageWatchFactory>(
    async (listener) => {
      if (!isTauriEnvironment()) {
        // Browser development has no Tauri event channel. Keep the public
        // coarse-change contract by polling only while a workbench subscribes.
        const intervalId = window.setInterval(
          listener,
          BROWSER_WATCH_POLL_INTERVAL_MS,
        );
        let disposed = false;
        return Object.freeze({
          async dispose() {
            if (disposed) return;
            disposed = true;
            window.clearInterval(intervalId);
          },
        });
      }

      const handle = await fileService.watchStart();
      const controller = new AbortController();
      const registration = await listenWithCleanup(
        `workspace:files-changed:${handle.eventKey}`,
        listener,
        controller.signal,
      );
      if (!registration.isRegistered()) {
        await fileService.watchStop({ token: handle.token }).catch(() => {});
        throw new Error("Failed to subscribe to workspace changes.");
      }

      let disposed = false;
      return Object.freeze({
        async dispose() {
          if (disposed) return;
          disposed = true;
          controller.abort();
          await fileService.watchStop({ token: handle.token });
        },
      });
    },
    [fileService],
  );

  return useMemo(
    () => createWorkbenchStorage(fileService, watchFactory),
    [fileService, watchFactory],
  );
}
