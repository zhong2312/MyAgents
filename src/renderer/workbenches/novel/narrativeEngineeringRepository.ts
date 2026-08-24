import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  NARRATIVE_ENGINEERING_INDEX_PATH,
  createNarrativeEngineeringFiles,
  loadNarrativeEngineeringFiles,
  narrativeFileMap,
  serializeNarrativeFileSnapshot,
} from "../../../shared/workbenches/novel/narrativeEngineeringStorage";
import {
  createEmptyNarrativeEngineering,
  parseNarrativeEngineering,
  serializeNarrativeEngineering,
  type NarrativeEngineering,
} from "./narrativeEngineeringSchema";
import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";

export interface LoadedNarrativeEngineering {
  readonly library: NarrativeEngineering;
  /** 已读取的整个剧情目录快照，用作 sourceHash 输入和保存 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface NarrativeEngineeringRepository {
  load(): Promise<LoadedNarrativeEngineering>;
  save(
    current: LoadedNarrativeEngineering,
    library: NarrativeEngineering,
  ): Promise<LoadedNarrativeEngineering>;
}

function parsedLibrary(value: unknown): NarrativeEngineering {
  return parseNarrativeEngineering(serializeNarrativeEngineering(value as NarrativeEngineering));
}

async function loadFiles(storage: WorkbenchStorage): Promise<LoadedNarrativeEngineering> {
  const loaded = await loadNarrativeEngineeringFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    library: parsedLibrary(loaded.library),
    content: serializeNarrativeFileSnapshot(loaded.files),
    files: loaded.files,
  });
}

export function createNarrativeEngineeringInitializationFiles(
  createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return createNarrativeEngineeringFiles(createEmptyNarrativeEngineering(createdAt));
}

export function createNarrativeEngineeringRepository(
  storage: WorkbenchStorage,
): NarrativeEngineeringRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("剧情工程仅在 MyNovelStudio 桌面端可用");
      }
      const [entry] = await storage.stat([NARRATIVE_ENGINEERING_INDEX_PATH]);
      if (!entry?.exists) {
        const transaction = createStorageTransaction(storage);
        for (const file of createNarrativeEngineeringFiles(
          createEmptyNarrativeEngineering(),
        )) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else if (entry.kind !== "file") {
        throw new Error(`${NARRATIVE_ENGINEERING_INDEX_PATH} 不是文件`);
      }
      return loadFiles(storage);
    },

    async save(
      current: LoadedNarrativeEngineering,
      library: NarrativeEngineering,
    ) {
      const onDisk = await loadNarrativeEngineeringFiles(
        async (path) => (await storage.readText(path)).content,
      );
      if (serializeNarrativeFileSnapshot(onDisk.files) !== current.content) {
        throw new Error("剧情工程事实源已被外部修改，请重新加载后再保存");
      }
      const normalized = parsedLibrary({
        ...library,
        updatedAt: new Date().toISOString(),
      });
      const nextFiles = narrativeFileMap(
        createNarrativeEngineeringFiles(normalized),
      );
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === NARRATIVE_ENGINEERING_INDEX_PATH) return 1;
        if (right === NARRATIVE_ENGINEERING_INDEX_PATH) return -1;
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
