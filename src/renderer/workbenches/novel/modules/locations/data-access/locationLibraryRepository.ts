import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  LOCATION_INDEX_PATH,
  createLocationFiles,
  loadLocationFiles,
  locationFileMap,
  serializeLocationFileSnapshot,
} from "../../../../../../shared/workbenches/novel/locationStorage";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";
import {
  LOCATION_LIBRARY_SCHEMA_VERSION,
  parseLocationLibraryIndex,
  serializeLocationLibraryIndex,
  type LocationLibraryIndex,
} from "../entities/locationLibrarySchema";

export interface LoadedLocationLibrary {
  readonly index: LocationLibraryIndex;
  /** 已读取的整个地点目录快照，用于保存 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface NovelLocationLibraryRepository {
  load(): Promise<LoadedLocationLibrary>;
  save(
    library: LoadedLocationLibrary,
    index: LocationLibraryIndex,
  ): Promise<LoadedLocationLibrary>;
}

export function createEmptyLocationLibrary(): LocationLibraryIndex {
  return {
    schemaVersion: LOCATION_LIBRARY_SCHEMA_VERSION,
    locations: [],
  };
}

export function createLocationLibraryInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return createLocationFiles(createEmptyLocationLibrary());
}

async function loadFiles(
  storage: WorkbenchStorage,
): Promise<LoadedLocationLibrary> {
  const loaded = await loadLocationFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    index: parseLocationLibraryIndex(JSON.stringify(loaded.library)),
    content: serializeLocationFileSnapshot(loaded.files),
    files: loaded.files,
  });
}

export function createNovelLocationLibraryRepository(
  storage: WorkbenchStorage,
): NovelLocationLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("地点库仅在 MyAgents 桌面端可用");
      }
      const [entry] = await storage.stat([LOCATION_INDEX_PATH]);
      if (!entry?.exists) {
        const transaction = createStorageTransaction(storage);
        for (const file of createLocationFiles(createEmptyLocationLibrary())) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else if (entry.kind !== "file") {
        throw new Error(`${LOCATION_INDEX_PATH} 不是文件`);
      }
      return loadFiles(storage);
    },

    async save(library: LoadedLocationLibrary, index: LocationLibraryIndex) {
      const parsed = parseLocationLibraryIndex(
        serializeLocationLibraryIndex(index),
      );
      const onDisk = await loadLocationFiles(
        async (path) => (await storage.readText(path)).content,
      );
      if (serializeLocationFileSnapshot(onDisk.files) !== library.content) {
        throw new Error("地点事实源已被外部修改，请重新加载后再保存");
      }
      const nextFiles = locationFileMap(createLocationFiles(parsed));
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === LOCATION_INDEX_PATH) return 1;
        if (right === LOCATION_INDEX_PATH) return -1;
        return left.localeCompare(right);
      });
      for (const path of orderedPaths) {
        const content = nextFiles.get(path);
        if (content === undefined) continue;
        const previous = onDisk.files.get(path);
        if (previous === content) continue;
        if (previous === undefined) transaction.createText(path, content);
        else transaction.writeText(path, content, previous);
      }
      await transaction.commit();
      const removedPaths = [...onDisk.files.keys()].filter(
        (path) => !nextFiles.has(path),
      );
      await Promise.allSettled(
        removedPaths.map((path) => storage.remove(path, { permanent: true })),
      );
      return loadFiles(storage);
    },
  });
}
