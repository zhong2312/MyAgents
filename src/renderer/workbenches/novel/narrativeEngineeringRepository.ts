import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createEmptyNarrativeEngineering,
  NARRATIVE_ENGINEERING_PATH,
  parseNarrativeEngineering,
  serializeNarrativeEngineering,
  type NarrativeEngineering,
} from "./narrativeEngineeringSchema";

export interface LoadedNarrativeEngineering {
  readonly library: NarrativeEngineering;
  readonly content: string;
}

export interface NarrativeEngineeringRepository {
  load(): Promise<LoadedNarrativeEngineering>;
  save(
    current: LoadedNarrativeEngineering,
    library: NarrativeEngineering,
  ): Promise<LoadedNarrativeEngineering>;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

export function createNarrativeEngineeringInitializationFiles(
  createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: NARRATIVE_ENGINEERING_PATH,
      content: serializeNarrativeEngineering(
        createEmptyNarrativeEngineering(createdAt),
      ),
    },
  ];
}

export function createNarrativeEngineeringRepository(
  storage: WorkbenchStorage,
): NarrativeEngineeringRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("剧情工程仅在 MyAgents 桌面端可用");
      }
      const file = await ensureTextFile(
        storage,
        NARRATIVE_ENGINEERING_PATH,
        serializeNarrativeEngineering(createEmptyNarrativeEngineering()),
      );
      return Object.freeze({
        library: parseNarrativeEngineering(file.content),
        content: file.content,
      });
    },

    async save(
      current: LoadedNarrativeEngineering,
      library: NarrativeEngineering,
    ) {
      const normalized: NarrativeEngineering = {
        ...library,
        updatedAt: new Date().toISOString(),
      };
      const content = serializeNarrativeEngineering(normalized);
      const parsed = parseNarrativeEngineering(content);
      const file = await storage.writeText(
        NARRATIVE_ENGINEERING_PATH,
        content,
        { expectedContent: current.content },
      );
      return Object.freeze({ library: parsed, content: file.content });
    },
  });
}
