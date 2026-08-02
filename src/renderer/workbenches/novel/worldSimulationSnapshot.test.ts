import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "./testStorage";
import { buildWorldSimulationSnapshot } from "./worldSimulationSnapshot";

const NOW = "2026-01-01T00:00:00.000Z";

function timelineEvent(
  id: string,
  title: string,
  sortKey: number,
  causeEventIds: readonly string[] = [],
) {
  return {
    id,
    branchId: "branch-main",
    timeLabel: `第${sortKey}章`,
    sortKey,
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
    description: "",
    characterIds: [],
    locationIds: [],
    chapterIds: [],
    factionIds: [],
    itemIds: [],
    causeEventIds,
    stateChanges: [],
    foreshadowings: [],
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("buildWorldSimulationSnapshot", () => {
  it("只投影事实截止事件之前的事件及其因果引用", async () => {
    const storage = createEmptyNovelStorage();
    await storage.createText(
      "world/rules.json",
      `${JSON.stringify({ rules: [] }, null, 2)}\n`,
      { createParents: true },
    );
    await storage.createText(
      "timeline/index.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          calendars: [],
          periods: [],
          views: [],
          storyStartEventId: "event-1",
          factsThroughEventId: "event-2",
          branches: [
            {
              id: "branch-main",
              name: "主时间线",
              parentBranchId: null,
              forkEventId: null,
              description: "",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          events: [
            // 时间线允许编辑阶段暂存这种反向引用；快照不应把未来事件当作前因。
            timelineEvent("event-1", "入城", 1, ["event-2"]),
            timelineEvent("event-2", "戒严", 2, ["event-1"]),
            timelineEvent("event-3", "宗门封山", 3, ["event-2"]),
          ],
        },
        null,
        2,
      )}\n`,
      { createParents: true },
    );

    const snapshot = await buildWorldSimulationSnapshot(storage);

    expect(snapshot.timelineEvents.map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(snapshot.timelineEvents[0]?.causeEventIds).toEqual([]);
    expect(snapshot.timelineEvents[1]?.causeEventIds).toEqual(["event-1"]);
    expect(snapshot.anchor).toBe("第2章");
    expect(snapshot.timelineEvents.every((event) =>
      event.sourceRefs.every((source) => source.authority === "actual"),
    )).toBe(true);
  });
});
