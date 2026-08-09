import { describe, expect, it } from "vitest";

import {
  TIMELINE_INDEX_PATH,
  createTimelineFiles,
  loadTimelineFiles,
  serializeTimelineFileSnapshot,
  timelineFileMap,
  timelineRecordPath,
  type TimelineStorageAggregate,
} from "./timelineStorage";

function fixture(): TimelineStorageAggregate {
  return {
    schemaVersion: 1,
    calendars: [{ id: "calendar-main", name: "主历" }],
    periods: [{ id: "period-main", name: "主纪元" }],
    views: [{ id: "view-main", name: "主视图" }],
    storyStartEventId: "event-main",
    factsThroughEventId: null,
    branches: [{ id: "branch-main", name: "主线" }],
    events: [{ id: "event-main", title: "开端", description: "完整正文" }],
  };
}

describe("时间线目录存储", () => {
  it("根索引只保存引用并可递归聚合五类记录", async () => {
    const files = timelineFileMap(createTimelineFiles(fixture()));
    const index = JSON.parse(files.get(TIMELINE_INDEX_PATH) ?? "{}") as Record<
      string,
      unknown
    >;

    expect(index).toMatchObject({
      schemaVersion: 1,
      storageVersion: 1,
      events: [
        {
          id: "event-main",
          path: "timeline/events/records/event-main.json",
        },
      ],
    });
    expect(JSON.stringify(index)).not.toContain("完整正文");
    expect(files.get(timelineRecordPath("events", "event-main"))).toContain(
      "完整正文",
    );
    const loaded = await loadTimelineFiles(async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    });
    expect(loaded.library).toEqual(fixture());
  });

  it("拒绝旧单文件格式和不规范记录路径", async () => {
    await expect(
      loadTimelineFiles(async () =>
        JSON.stringify({ ...fixture(), storageVersion: undefined }),
      ),
    ).rejects.toThrow("旧单文件时间线不兼容且不迁移");

    const files = timelineFileMap(createTimelineFiles(fixture()));
    const index = JSON.parse(files.get(TIMELINE_INDEX_PATH) ?? "{}") as {
      events: Array<{ path: string }>;
    };
    index.events[0]!.path = "timeline/events/event-main.json";
    const changed = new Map(files).set(
      TIMELINE_INDEX_PATH,
      `${JSON.stringify(index, null, 2)}\n`,
    );
    await expect(
      loadTimelineFiles(async (path) => changed.get(path) ?? ""),
    ).rejects.toThrow("timeline/events/records/event-main.json");
  });

  it("目录快照不受 Map 插入顺序影响", () => {
    expect(
      serializeTimelineFileSnapshot(
        new Map([
          ["b", "2"],
          ["a", "1"],
        ]),
      ),
    ).toBe(
      serializeTimelineFileSnapshot(
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    );
  });
});
