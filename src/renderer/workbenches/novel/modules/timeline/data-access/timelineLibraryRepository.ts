import {
  ensureWorkbenchTextFile,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import { validateTimelineCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createEmptyTimelineLibrary,
  parseTimelineLibrary,
  serializeTimelineLibrary,
  TIMELINE_LIBRARY_PATH,
  type TimelineLibrary,
} from "../entities/timelineLibrarySchema";

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
      const file = await ensureWorkbenchTextFile(
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
      await validateTimelineCrossReferences(storage, library);
      const content = serializeTimelineLibrary(library);
      const parsed = parseTimelineLibrary(content);
      const file = await storage.writeText(TIMELINE_LIBRARY_PATH, content, {
        expectedContent: current.content,
      });
      return Object.freeze({ library: parsed, content: file.content });
    },
  });
}
