import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  INSPIRATION_INDEX_PATH,
  createInspirationFiles,
  inspirationFileMap,
  loadInspirationFiles,
  serializeInspirationFileSnapshot,
} from "../../../../../../shared/workbenches/novel/inspirationStorage";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";
import {
  createEmptyInspirationLibrary,
  parseInspirationLibrary,
  serializeInspirationLibrary,
  type InspirationLibrary,
} from "../entities/inspirationSchema";

export interface LoadedInspirationProject {
  readonly library: InspirationLibrary;
  /** 已读取的整个灵感目录快照，用作 sourceHash 输入和保存 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface NovelInspirationRepository {
  load(): Promise<LoadedInspirationProject>;
  save(
    current: LoadedInspirationProject,
    value: InspirationLibrary,
  ): Promise<LoadedInspirationProject>;
}

export function createInspirationInitializationFiles(
  createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return createInspirationFiles({
    ...createEmptyInspirationLibrary(createdAt),
  });
}

async function loadFiles(
  storage: WorkbenchStorage,
): Promise<LoadedInspirationProject> {
  const loaded = await loadInspirationFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    library: parseInspirationLibrary(JSON.stringify(loaded.library)),
    content: serializeInspirationFileSnapshot(loaded.files),
    files: loaded.files,
  });
}

export function createNovelInspirationRepository(
  storage: WorkbenchStorage,
): NovelInspirationRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("灵感仅在 MyAgents 桌面端可用");
      }
      const [entry] = await storage.stat([INSPIRATION_INDEX_PATH]);
      if (!entry?.exists) {
        const transaction = createStorageTransaction(storage);
        for (const file of createInspirationInitializationFiles(
          new Date().toISOString(),
        )) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else if (entry.kind !== "file") {
        throw new Error(`${INSPIRATION_INDEX_PATH} 不是文件`);
      }
      return loadFiles(storage);
    },

    async save(current: LoadedInspirationProject, value: InspirationLibrary) {
      const parsed = parseInspirationLibrary(
        serializeInspirationLibrary({
          ...value,
          updatedAt: new Date().toISOString(),
        }),
      );
      const onDisk = await loadInspirationFiles(
        async (path) => (await storage.readText(path)).content,
      );
      if (serializeInspirationFileSnapshot(onDisk.files) !== current.content) {
        throw new Error("灵感事实源已被外部修改，请重新加载后再保存");
      }
      const nextFiles = inspirationFileMap(createInspirationFiles(parsed));
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === INSPIRATION_INDEX_PATH) return 1;
        if (right === INSPIRATION_INDEX_PATH) return -1;
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
