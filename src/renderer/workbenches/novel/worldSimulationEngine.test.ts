import { describe, expect, it } from "vitest";

import { advanceBy, advanceTo, advanceToNextEvent, compareTicks } from "./worldSimulationEngine";
import type { WorldSimulationState } from "./worldSimulationWorldSchema";

function state(): WorldSimulationState {
  return {
    schemaVersion: 1,
    projectId: "project-1",
    calendarId: "xian-tu",
    currentTick: "0",
    currentLabel: "第 0 天",
    timeUnit: "day",
    endTick: null,
    regions: [{ id: "region-1", name: "临渊城", parentId: null, activity: "quiet", pressure: 0, state: {} }],
    actors: [{ id: "actor-1", name: "小山村少年", kind: "character", locationId: "region-1", status: "idle", intent: "", state: {} }],
    scheduledEvents: [
      { id: "event-10", title: "主体行动", description: "行动开始", startTick: "10", endTick: null, regionIds: ["region-1"], actorIds: ["actor-1"], kind: "emergent", priority: 10, effects: [] },
      { id: "event-25", title: "封印衰减", description: "能量降低", startTick: "25", endTick: null, regionIds: ["region-1"], actorIds: [], kind: "milestone", priority: 0, effects: [{ targetType: "world", targetId: "world", field: "sealEnergy", operation: "set", value: "80", reason: "每日衰减达到阈值" }] },
    ],
    executedEvents: [],
    worldState: {},
  };
}

describe("worldSimulationEngine", () => {
  it("用字符串整数比较和推进超长时间", () => {
    expect(compareTicks("1000000000000", "999999999999")).toBe(1);
    expect(advanceBy(state(), "1000000000000").state.currentTick).toBe("1000000000000");
  });

  it("跳到目标时间时按发生时间顺序执行中间事件", () => {
    const result = advanceTo(state(), "100");
    expect(result.state.currentTick).toBe("100");
    expect(result.events.map((event) => event.tick)).toEqual(["10", "25"]);
    expect(result.state.worldState.sealEnergy).toBe("80");
    expect(result.state.actors[0]?.status).toBe("acting");
  });

  it("没有事件时推进到下一个边界并标记静默区间", () => {
    const result = advanceToNextEvent(state());
    expect(result.state.currentTick).toBe("10");
    expect(result.silent).toBe(false);
    const next = advanceBy(result.state, "1");
    expect(next.state.currentTick).toBe("11");
    expect(next.silent).toBe(true);
  });
});

