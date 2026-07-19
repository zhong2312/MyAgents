import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createEmptyTimelineLibrary,
  parseTimelineLibrary,
  serializeTimelineLibrary,
  TIMELINE_LIBRARY_PATH,
  type TimelineLibrary,
} from "./timelineLibrarySchema";

export interface LoadedTimelineLibrary {
  readonly library: TimelineLibrary;
  readonly content: string;
}

export interface NovelTimelineLibraryRepository {
  load(): Promise<LoadedTimelineLibrary>;
  save(
    current: LoadedTimelineLibrary,
    library: TimelineLibrary,
  ): Promise<LoadedTimelineLibrary>;
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

export function createTimelineLibraryInitializationFiles(
  createdAt: string,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: TIMELINE_LIBRARY_PATH,
      content: serializeTimelineLibrary(createEmptyTimelineLibrary(createdAt)),
    },
  ];
}

export function createNovelTimelineLibraryRepository(
  storage: WorkbenchStorage,
): NovelTimelineLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("时间线仅在 MyAgents 桌面端可用");
      }
      const file = await ensureTextFile(
        storage,
        TIMELINE_LIBRARY_PATH,
        serializeTimelineLibrary(
          createEmptyTimelineLibrary(new Date().toISOString()),
        ),
      );
      return Object.freeze({
        library: parseTimelineLibrary(file.content),
        content: file.content,
      });
    },

    async save(current: LoadedTimelineLibrary, library: TimelineLibrary) {
      const content = serializeTimelineLibrary(library);
      const parsed = parseTimelineLibrary(content);
      const file = await storage.writeText(TIMELINE_LIBRARY_PATH, content, {
        expectedContent: current.content,
      });
      return Object.freeze({ library: parsed, content: file.content });
    },
  });
}
