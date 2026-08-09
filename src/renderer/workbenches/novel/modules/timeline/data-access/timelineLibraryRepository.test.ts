import { describe, expect, it } from "vitest";

import {
  TIMELINE_INDEX_PATH,
  timelineRecordPath,
} from "../../../../../../shared/workbenches/novel/timelineStorage";
import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";
import {
  MAIN_TIMELINE_BRANCH_ID,
  type TimelineEvent,
} from "../entities/timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";

const NOW = "2026-08-09T00:00:00.000Z";

function event(id: string, title: string): TimelineEvent {
  return {
    id,
    branchId: MAIN_TIMELINE_BRANCH_ID,
    timeLabel: "第一天",
    sortKey: 1,
    sortOrder: 0,
    endSortKey: null,
    timePrecision: "exact",
    timeExpressions: [],
    periodId: null,
    scope: "story",
    knowledgeScope: "public",
    narrativeOrder: null,
    title,
    kind: "event",
    summary: `${title}摘要`,
    description: `${title}正文`,
    characterIds: [],
    locationIds: [],
    chapterIds: [],
    factionIds: [],
    itemIds: [],
    causeEventIds: [],
    stateChanges: [],
    foreshadowings: [],
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("NovelTimelineLibraryRepository 目录存储", () => {
  it("初始化轻量根索引与五类记录目录", async () => {
    const storage = createEmptyNovelStorage();
    const loaded = await createNovelTimelineLibraryRepository(storage).load();
    const index = JSON.parse(storage.getText(TIMELINE_INDEX_PATH) ?? "{}") as {
      storageVersion?: number;
      branches?: Array<{ id: string; path: string }>;
      events?: unknown[];
    };

    expect(index.storageVersion).toBe(1);
    expect(index.events).toEqual([]);
    expect(index.branches).toEqual([
      {
        id: MAIN_TIMELINE_BRANCH_ID,
        path: "timeline/branches/records/branch-main.json",
      },
    ]);
    expect(loaded.library.branches[0]?.id).toBe(MAIN_TIMELINE_BRANCH_ID);
  });

  it("只修改事件正文时仅改写对应 record", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelTimelineLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      events: [event("event-a", "开端")],
    });
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.save(loaded, {
      ...loaded.library,
      events: loaded.library.events.map((entry) => ({
        ...entry,
        description: "更新后的事件正文",
      })),
    });

    expect(writes).toEqual([timelineRecordPath("events", "event-a")]);
    expect(saved.library.events[0]?.description).toBe("更新后的事件正文");
  });

  it("任一记录被外部修改后拒绝覆盖", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelTimelineLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      events: [event("event-a", "开端")],
    });
    const path = timelineRecordPath("events", "event-a");
    const external = JSON.parse(storage.getText(path) ?? "{}") as Record<
      string,
      unknown
    >;
    external.description = "外部修改";
    storage.setExternalText(path, `${JSON.stringify(external, null, 2)}\n`);

    await expect(repository.save(loaded, loaded.library)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("删除事件后先提交根索引再清理孤立 record", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelTimelineLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      events: [event("event-a", "开端")],
    });

    loaded = await repository.save(loaded, { ...loaded.library, events: [] });

    expect(
      storage.getText(timelineRecordPath("events", "event-a")),
    ).toBeUndefined();
    expect(loaded.library.events).toEqual([]);
  });

  it("不迁移旧 index.json 内嵌数组结构", async () => {
    const storage = createEmptyNovelStorage();
    await storage.createText(
      TIMELINE_INDEX_PATH,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          calendars: [],
          periods: [],
          views: [],
          storyStartEventId: null,
          factsThroughEventId: null,
          branches: [],
          events: [],
        },
        null,
        2,
      )}\n`,
      { createParents: true },
    );

    await expect(
      createNovelTimelineLibraryRepository(storage).load(),
    ).rejects.toThrow("旧单文件时间线不兼容且不迁移");
  });
});
