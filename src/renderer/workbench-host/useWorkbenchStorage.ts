import { useCallback, useMemo } from "react";

import type { WorkbenchStorage } from "../../shared/workbench-sdk";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { listenWithCleanup } from "@/utils/tauriListen";
import {
  createWorkbenchStorage,
  type WorkbenchStorageWatchFactory,
} from "./storageAdapter";

export function useWorkbenchStorage(workspacePath: string): WorkbenchStorage {
  const fileService = useWorkspaceFileService(workspacePath || null);

  const watchFactory = useCallback<WorkbenchStorageWatchFactory>(
    async (listener) => {
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
