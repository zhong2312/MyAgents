import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createEmptyFactionLibrary,
  FACTION_LIBRARY_PATH,
  parseFactionLibrary,
  serializeFactionLibrary,
  type FactionLibrary,
} from "./factionLibrarySchema";

export interface LoadedFactionLibrary {
  readonly library: FactionLibrary;
  readonly content: string;
}

export interface NovelFactionLibraryRepository {
  load(): Promise<LoadedFactionLibrary>;
  save(
    current: LoadedFactionLibrary,
    library: FactionLibrary,
  ): Promise<LoadedFactionLibrary>;
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

export function createNovelFactionLibraryRepository(
  storage: WorkbenchStorage,
): NovelFactionLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("势力组织仅在 MyAgents 桌面端可用");
      }
      const file = await ensureTextFile(
        storage,
        FACTION_LIBRARY_PATH,
        serializeFactionLibrary(createEmptyFactionLibrary()),
      );
      return Object.freeze({ library: parseFactionLibrary(file.content), content: file.content });
    },
    async save(current: LoadedFactionLibrary, library: FactionLibrary) {
      const content = serializeFactionLibrary(library);
      const parsed = parseFactionLibrary(content);
      const file = await storage.writeText(FACTION_LIBRARY_PATH, content, {
        expectedContent: current.content,
      });
      return Object.freeze({ library: parsed, content: file.content });
    },
  });
}
