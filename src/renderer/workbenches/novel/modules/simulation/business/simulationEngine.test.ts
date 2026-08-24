import { describe, expect, it } from "vitest";

import { advanceSimulationRun } from "./simulationEngine";
import {
  simulationRunSchema,
  type SimulationRun,
} from "../entities/simulationSchema";

function run(overrides: Partial<SimulationRun> = {}): SimulationRun {
  return simulationRunSchema.parse({
    schemaVersion: 1,
    id: "run-test",
    name: "测试运行",
    status: "ready",
    baselineMode: "timeline-current",
    baselineSourceHash: "fnv1a-test",
    baselineLabel: "测试基线",
    parentRunId: null,
    forkRoundId: null,
    startTime: 0,
    currentTime: 0,
    endTime: 3650,
    timeScale: "month",
    observationSpaceIds: ["world-root"],
    observationSpaceLabel: "测试世界",
    observer: "ensemble",
    observerId: null,
    seed: 7,
    engineVersion: "simulation-engine/1",
    rulesetVersion: "world-rules/1",
    currentRoundId: null,
    roundsCompleted: 0,
    diagnostics: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const inputs = {
  characterCount: 2,
  factionCount: 1,
  locationCount: 3,
  timelineEventCount: 4,
  observationSpaceId: "world-root",
  observationSpaceLabel: "测试世界",
};

describe("advanceSimulationRun", () => {
  it("日尺度不凭空生成年度或千年世界过程", () => {
    const result = advanceSimulationRun(
      run({ timeScale: "day" }),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );

    expect(
      result.events.some((event) => event.ruleIds.includes("annual-festival")),
    ).toBe(false);
    expect(
      result.events.some((event) =>
        event.ruleIds.includes("secret-realm-cycle"),
      ),
    ).toBe(false);
    expect(result.events.map((event) => event.kind)).toEqual(["diagnostic"]);
    expect(result.events[0]).toMatchObject({
      certainty: "blocked",
      title: "本轮 AI 尚未生成具体事件",
    });
  });

  it("只在真实行动完成边界生成具体人物事件，不凭空生成传播", () => {
    const result = advanceSimulationRun(
      run({ timeScale: "month" }),
      {
        ...inputs,
        characters: [
          {
            id: "hero",
            name: "沈照夜",
            currentLocationId: "north",
            currentLocationLabel: "北山镇",
            goals: "完成闭关",
            motivation: "灵石耗尽前突破",
            nextActionTime: 18,
            nextActionLabel: "闭关准备",
          },
        ],
        locations: [{ id: "north", name: "北山镇" }],
        factions: [],
        characterCount: 1,
        factionCount: 0,
      },
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.round.endTime).toBe(18);
    expect(result.round.boundary).toMatchObject({
      kind: "action-complete",
      scheduledAt: 18,
      reason: "沈照夜的闭关准备完成",
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      title: "沈照夜完成闭关准备",
      actorRefs: [{ id: "hero" }],
      locationRef: { id: "north", label: "北山镇" },
      stateChanges: [
        {
          field: "currentAction",
          before: "闭关准备",
          after: "已完成",
        },
      ],
      propagations: [],
    });
  });

  it("年度边界生成年度世界过程", () => {
    const result = advanceSimulationRun(
      run({ timeScale: "year", endTime: 365 }),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.events[0]?.ruleIds).toContain("annual-festival");
    expect(result.run.currentTime).toBe(365);
  });

  it("千年尺度将秘境周期聚合为单一事件", () => {
    const result = advanceSimulationRun(
      run({ timeScale: "millennium", endTime: 365_000 }),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.events[0]).toMatchObject({
      kind: "world-process",
      certainty: "aggregated",
      ruleIds: ["secret-realm-cycle"],
    });
  });

  it("相同输入和时间可复现同一轮结果", () => {
    const first = advanceSimulationRun(
      run(),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );
    const second = advanceSimulationRun(
      run(),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );

    expect(second).toEqual(first);
  });

  it("按独立的跨度数值推进，并支持千万年单位", () => {
    const result = advanceSimulationRun(
      run({
        timeScale: "year",
        timeStep: 2,
        endTime: 1_000,
      }),
      inputs,
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.round.endTime).toBe(730);
    expect(
      advanceSimulationRun(
        run({
          timeScale: "ten-million-year",
          timeStep: 1,
          endTime: 3_650_000_000,
        }),
        inputs,
        "2026-01-02T00:00:00.000Z",
      ).round.endTime,
    ).toBe(3_650_000_000);
  });
});
