import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  FACTION_INDEX_PATH,
  createFactionFiles,
  factionFileMap,
  loadFactionFiles,
  serializeFactionFileSnapshot,
} from "../../../../../../shared/workbenches/novel/factionStorage";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";

import { validateFactionCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createEmptyFactionLibrary,
  parseFactionLibrary,
  serializeFactionLibrary,
  type FactionLibrary,
} from "../entities/factionLibrarySchema";

export interface LoadedFactionLibrary {
  readonly library: FactionLibrary;
  /** 已读取的整个势力目录快照，用作 sourceHash 输入和保存 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface NovelFactionLibraryRepository {
  load(): Promise<LoadedFactionLibrary>;
  save(
    current: LoadedFactionLibrary,
    library: FactionLibrary,
  ): Promise<LoadedFactionLibrary>;
}

export function createFactionLibraryInitializationFiles(
  _createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return createFactionFiles(createEmptyFactionLibrary());
}

async function loadFiles(
  storage: WorkbenchStorage,
): Promise<LoadedFactionLibrary> {
  const loaded = await loadFactionFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    library: parseFactionLibrary(JSON.stringify(loaded.library)),
    content: serializeFactionFileSnapshot(loaded.files),
    files: loaded.files,
  });
}

export function createNovelFactionLibraryRepository(
  storage: WorkbenchStorage,
): NovelFactionLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("势力组织仅在 MyNovelStudio 桌面端可用");
      }
      const [entry] = await storage.stat([FACTION_INDEX_PATH]);
      if (!entry?.exists) {
        const transaction = createStorageTransaction(storage);
        for (const file of createFactionFiles(createEmptyFactionLibrary())) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else if (entry.kind !== "file") {
        throw new Error(`${FACTION_INDEX_PATH} 不是文件`);
      }
      return loadFiles(storage);
    },
    async save(current: LoadedFactionLibrary, library: FactionLibrary) {
      await validateFactionCrossReferences(storage, library);
      const parsed = parseFactionLibrary(serializeFactionLibrary(library));
      const onDisk = await loadFactionFiles(
        async (path) => (await storage.readText(path)).content,
      );
      if (serializeFactionFileSnapshot(onDisk.files) !== current.content) {
        throw new Error("势力事实源已被外部修改，请重新加载后再保存");
      }
      const nextFiles = factionFileMap(createFactionFiles(parsed));
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === FACTION_INDEX_PATH) return 1;
        if (right === FACTION_INDEX_PATH) return -1;
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
