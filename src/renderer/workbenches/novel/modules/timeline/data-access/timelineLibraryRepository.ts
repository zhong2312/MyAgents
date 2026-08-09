import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  TIMELINE_INDEX_PATH,
  createTimelineFiles,
  loadTimelineFiles,
  serializeTimelineFileSnapshot,
  timelineFileMap,
} from "../../../../../../shared/workbenches/novel/timelineStorage";

import { validateTimelineCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createEmptyTimelineLibrary,
  parseTimelineLibrary,
  serializeTimelineLibrary,
  type TimelineLibrary,
} from "../entities/timelineLibrarySchema";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";

export interface LoadedTimelineLibrary {
  readonly library: TimelineLibrary;
  /** 已读取的整个时间线目录快照，用作 sourceHash 输入和保存 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface NovelTimelineLibraryRepository {
  load(): Promise<LoadedTimelineLibrary>;
  save(
    current: LoadedTimelineLibrary,
    library: TimelineLibrary,
  ): Promise<LoadedTimelineLibrary>;
}

export function createTimelineLibraryInitializationFiles(
  createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return createTimelineFiles(createEmptyTimelineLibrary(createdAt));
}

function parsedLibrary(value: unknown): TimelineLibrary {
  return parseTimelineLibrary(
    serializeTimelineLibrary(value as TimelineLibrary),
  );
}

async function loadFiles(
  storage: WorkbenchStorage,
): Promise<LoadedTimelineLibrary> {
  const loaded = await loadTimelineFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    library: parsedLibrary(loaded.library),
    content: serializeTimelineFileSnapshot(loaded.files),
    files: loaded.files,
  });
}

export function createNovelTimelineLibraryRepository(
  storage: WorkbenchStorage,
): NovelTimelineLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("时间线仅在 MyAgents 桌面端可用");
      }
      const [entry] = await storage.stat([TIMELINE_INDEX_PATH]);
      if (!entry?.exists) {
        const transaction = createStorageTransaction(storage);
        for (const file of createTimelineFiles(
          createEmptyTimelineLibrary(new Date().toISOString()),
        )) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else if (entry.kind !== "file") {
        throw new Error(`${TIMELINE_INDEX_PATH} 不是文件`);
      }
      return loadFiles(storage);
    },

    async save(current: LoadedTimelineLibrary, library: TimelineLibrary) {
      await validateTimelineCrossReferences(storage, library);
      const parsed = parsedLibrary(library);
      const onDisk = await loadTimelineFiles(
        async (path) => (await storage.readText(path)).content,
      );
      if (serializeTimelineFileSnapshot(onDisk.files) !== current.content) {
        throw new Error("时间线事实源已被外部修改，请重新加载后再保存");
      }
      const nextFiles = timelineFileMap(createTimelineFiles(parsed));
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === TIMELINE_INDEX_PATH) return 1;
        if (right === TIMELINE_INDEX_PATH) return -1;
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
