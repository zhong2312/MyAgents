import { describe, expect, it } from "vitest";

import type { WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";

import { analyzeActorInfluence } from "./worldLabAnalysis";

const snapshot = {
  schemaVersion: 1,
  projectId: "novel-test",
  title: "测试小说",
  sourceRevision: "sha256:test",
  anchor: "第一章",
  actors: [
    { id: "a1", name: "陆沉渊", kind: "character", summary: "", locationId: null, goals: [], traits: [], resources: [], knowledge: [], constraints: [], sourceRefs: [] },
    { id: "a2", name: "镇夜司", kind: "faction", summary: "", locationId: null, goals: [], traits: [], resources: [], knowledge: [], constraints: [], sourceRefs: [] },
    { id: "a3", name: "青衫客", kind: "character", summary: "", locationId: null, goals: [], traits: [], resources: [], knowledge: [], constraints: [], sourceRefs: [] },
    { id: "a4", name: "路人甲", kind: "character", summary: "", locationId: null, goals: [], traits: [], resources: [], knowledge: [], constraints: [], sourceRefs: [] },
  ],
  locations: [],
  rules: [],
  timelineEvents: [
    { id: "e1", title: "入城", summary: "", timeLabel: "一", actorIds: ["a1", "a2"], locationIds: [], sourceRefs: [] },
    { id: "e2", title: "对峙", summary: "", timeLabel: "二", actorIds: ["a1", "a2", "a3"], locationIds: [], sourceRefs: [] },
    { id: "e3", title: "和解", summary: "", timeLabel: "三", actorIds: ["a1", "a3"], locationIds: [], sourceRefs: [] },
  ],
} as WorkbenchSimulationWorldSnapshot;

describe("analyzeActorInfluence", () => {
  it("按参与事件数排序主体并统计关联连接数", () => {
    const result = analyzeActorInfluence(snapshot);

    // 陆沉渊参与 3 个事件，排第一；路人甲未参与被过滤。
    expect(result.actors[0]).toMatchObject({
      actorId: "a1",
      name: "陆沉渊",
      eventCount: 3,
    });
    expect(result.actors.some((item) => item.actorId === "a4")).toBe(false);
    // 陆沉渊与 a2/a3 各有连接。
    const lead = result.actors.find((item) => item.actorId === "a1");
    expect(lead?.connectionCount).toBe(2);
  });

  it("统计主体共现次数并降序", () => {
    const result = analyzeActorInfluence(snapshot);

    // a1-a2 共现 2 次（e1、e2）；a1-a3 共现 2 次（e2、e3）。
    const pair = result.cooccurrences.find(
      (item) => item.sourceId === "a1" && item.targetId === "a2",
    );
    expect(pair?.count).toBe(2);
    const pair13 = result.cooccurrences.find(
      (item) => item.sourceId === "a1" && item.targetId === "a3",
    );
    expect(pair13?.count).toBe(2);
  });
});
