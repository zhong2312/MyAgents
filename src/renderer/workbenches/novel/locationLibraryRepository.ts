import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  LOCATION_LIBRARY_PATH,
  LOCATION_LIBRARY_SCHEMA_VERSION,
  parseLocationLibraryIndex,
  serializeLocationLibraryIndex,
  type LocationLibraryIndex,
} from "./locationLibrarySchema";

export interface LoadedLocationLibrary {
  readonly index: LocationLibraryIndex;
  readonly content: string;
}

export interface NovelLocationLibraryRepository {
  load(): Promise<LoadedLocationLibrary>;
  save(
    library: LoadedLocationLibrary,
    index: LocationLibraryIndex,
  ): Promise<LoadedLocationLibrary>;
}

function emptyLocationLibraryContent(): string {
  return serializeLocationLibraryIndex({
    schemaVersion: LOCATION_LIBRARY_SCHEMA_VERSION,
    locations: [],
  });
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

export function createLocationLibraryInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: LOCATION_LIBRARY_PATH,
      content: emptyLocationLibraryContent(),
    },
  ];
}

export function createNovelLocationLibraryRepository(
  storage: WorkbenchStorage,
): NovelLocationLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("地点库仅在 MyAgents 桌面端可用");
      }
      const file = await ensureTextFile(
        storage,
        LOCATION_LIBRARY_PATH,
        emptyLocationLibraryContent(),
      );
      return Object.freeze({
        index: parseLocationLibraryIndex(file.content),
        content: file.content,
      });
    },

    async save(
      library: LoadedLocationLibrary,
      index: LocationLibraryIndex,
    ) {
      const content = serializeLocationLibraryIndex(index);
      const file = await storage.writeText(LOCATION_LIBRARY_PATH, content, {
        expectedContent: library.content,
      });
      return Object.freeze({
        index: parseLocationLibraryIndex(file.content),
        content: file.content,
      });
    },
  });
}
