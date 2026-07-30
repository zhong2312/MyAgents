import { parseWorkbenchManifest } from "../../shared/workbench-sdk";
import type {
  WorkbenchDefinition,
  WorkbenchDefinitionOptions,
  WorkbenchRendererModule,
} from "./types";

export function defineWorkbench(
  manifest: unknown,
  load: () => Promise<WorkbenchRendererModule>,
  options: WorkbenchDefinitionOptions = {},
): WorkbenchDefinition {
  const launcher = options.launcher
    ? Object.freeze({ ...options.launcher })
    : undefined;
  const shell = options.shell ? Object.freeze({ ...options.shell }) : undefined;
  return Object.freeze({
    manifest: parseWorkbenchManifest(manifest),
    load,
    ...(launcher ? { launcher } : {}),
    ...(shell ? { shell } : {}),
    ...(options.loadAgentCompanion
      ? { loadAgentCompanion: options.loadAgentCompanion }
      : {}),
  });
}
