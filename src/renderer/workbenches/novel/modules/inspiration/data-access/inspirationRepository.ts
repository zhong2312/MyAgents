import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createEmptyInspirationLibrary,
  INSPIRATION_LIBRARY_PATH,
  parseInspirationLibrary,
  serializeInspirationLibrary,
  type InspirationLibrary,
} from "../entities/inspirationSchema";

export interface LoadedInspirationProject {
  readonly library: InspirationLibrary;
  readonly content: string;
}

export interface NovelInspirationRepository {
  load(): Promise<LoadedInspirationProject>;
  save(
    current: LoadedInspirationProject,
    value: InspirationLibrary,
  ): Promise<LoadedInspirationProject>;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([INSPIRATION_LIBRARY_PATH]);
  if (info?.exists) return storage.readText(INSPIRATION_LIBRARY_PATH);
  try {
    return await storage.createText(INSPIRATION_LIBRARY_PATH, content, {
      createParents: true,
    });
  } catch {
    return storage.readText(INSPIRATION_LIBRARY_PATH);
  }
}

export function createInspirationInitializationFile(createdAt: string): {
  readonly path: string;
  readonly content: string;
} {
  return {
    path: INSPIRATION_LIBRARY_PATH,
    content: serializeInspirationLibrary(createEmptyInspirationLibrary(createdAt)),
  };
}

export function createNovelInspirationRepository(
  storage: WorkbenchStorage,
): NovelInspirationRepository {
  const repository: NovelInspirationRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("灵感仅在 MyAgents 桌面端可用");
      }
      const initial = createInspirationInitializationFile(
        new Date().toISOString(),
      );
      const file = await ensureTextFile(storage, initial.content);
      return Object.freeze({
        library: parseInspirationLibrary(file.content),
        content: file.content,
      });
    },

    async save(current, value) {
      const nextValue = { ...value, updatedAt: new Date().toISOString() };
      const content = serializeInspirationLibrary(nextValue);
      const file = await storage.writeText(INSPIRATION_LIBRARY_PATH, content, {
        expectedContent: current.content,
      });
      return Object.freeze({
        library: parseInspirationLibrary(file.content),
        content: file.content,
      });
    },
  };
  return Object.freeze(repository);
}
