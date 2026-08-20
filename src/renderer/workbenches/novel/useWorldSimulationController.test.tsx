import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const buildBaselineMock = vi.hoisted(() => vi.fn());

vi.mock("./worldSimulationProjection", () => ({
  buildWorldSimulationBaseline: buildBaselineMock,
}));

import { NovelMemoryStorage } from "./shared/infrastructure/testStorage";
import { createWorldSimulationRun } from "./worldSimulationEngineV2";
import { createWorldSimulationRepositoryV2 } from "./worldSimulationRepositoryV2";
import {
  useWorldSimulationController,
  type WorldSimulationModelScene,
} from "./useWorldSimulationController";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  createDefaultWorldSimulationScenario,
  type WorldSimulationBaseline,
} from "./worldSimulationV2Schema";

function baseline(): WorldSimulationBaseline {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    baselineId: "baseline-test",
    projectId: "test-project",
    projectTitle: "测试小说",
    sourceRevision: "source-revision",
    compiledAt: "2026-08-18T00:00:00.000Z",
    sourceRefs: [],
    anchor: {
      calendarId: "cosmic",
      sortKey: "0",
      precision: "exact",
      displayText: "第 0 日",
    },
    factsThroughEventId: null,
    calendar: {
      id: "cosmic",
      name: "世界纪年",
      daysPerMonth: 30,
      monthsPerYear: 12,
      eraYears: "100000000",
    },
    characters: [],
    factions: [],
    regions: [],
    items: [],
    rules: [],
    cultivationSystems: [],
    timelineFacts: [],
    timelinePlans: [],
    narrativeConstraints: [],
    chapters: [],
    diagnostics: [],
  } as unknown as WorldSimulationBaseline;
}

function baselineWithUnplacedActor(): WorldSimulationBaseline {
  return {
    ...baseline(),
    characters: [
      {
        id: "character-progress",
        name: "沈砚",
        summary: "守住眼前的生活",
        status: "在世",
        locationId: null,
        factionIds: [],
        goals: ["守住眼前的生活"],
        personality: ["谨慎"],
        values: [],
        strengths: [],
        weaknesses: [],
        fears: [],
        motivation: ["保护家人"],
        innerConflict: [],
        relations: [],
        cultivation: {
          systemId: null,
          trackId: null,
          levelId: null,
          levelName: "凡人",
          levelOrder: 0,
          methodIds: [],
          abilityIds: [],
          resourceBalances: {},
          activeConstraintIds: [],
        },
        ageYears: 20,
        lifespanYears: null,
        lifespanLossYears: 0,
        inventoryItemIds: [],
        knowledge: [],
        sourceRefs: [],
      },
    ],
  } as unknown as WorldSimulationBaseline;
}

describe("useWorldSimulationController", () => {
  it("切换方案前保存草稿并将目标方案持久化为活动方案", async () => {
    buildBaselineMock.mockResolvedValue(baseline());
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const initial = await repository.loadScenarios();
    const first = initial.value.scenarios[0];
    if (!first) throw new Error("缺少默认推演方案");
    const second = {
      ...first,
      id: "scenario-secondary",
      name: "备用方案",
      seed: "secondary-seed",
    };
    await repository.saveScenario(initial, second);

    const { result } = renderHook(() =>
      useWorldSimulationController({
        storage,
        isActive: false,
        onRunModelScene: async (_scene: WorldSimulationModelScene) => "",
      }),
    );

    await act(async () => {
      await result.current.selectScenario(first.id);
    });
    act(() => {
      result.current.updateScenario({
        ...result.current.scenario,
        name: "已保存的原方案",
      });
    });

    await act(async () => {
      await result.current.selectScenario(second.id);
    });

    await waitFor(() => {
      expect(result.current.scenario.id).toBe(second.id);
      expect(result.current.scenarioDirty).toBe(false);
    });
    const persisted = JSON.parse(
      storage.getText("simulation/scenarios.json") ?? "{}",
    ) as {
      activeScenarioId?: string;
      scenarios?: readonly { readonly id: string; readonly name: string }[];
    };
    expect(persisted.activeScenarioId).toBe(second.id);
    expect(
      persisted.scenarios?.find((scenario) => scenario.id === first.id)?.name,
    ).toBe("已保存的原方案");
  });

  it("创建运行时自动推导旧方案中的内部起点、范围和章节上下文", async () => {
    buildBaselineMock.mockResolvedValue(baseline());
    const storage = new NovelMemoryStorage({});
    const { result } = renderHook(() =>
      useWorldSimulationController({
        storage,
        isActive: false,
      }),
    );

    act(() => {
      result.current.updateScenario({
        ...result.current.scenario,
        start: { mode: "custom", sortKey: "480" },
        chapterContext: { mode: "after", chapterId: "chapter-legacy" },
        narrativeContext: {
          ...result.current.scenario.narrativeContext,
          mode: "strict",
          selectedPlotLineIds: ["line-legacy"],
        },
        scope: {
          ...result.current.scenario.scope,
          regionIds: ["region-legacy"],
          characterIds: ["character-legacy"],
          factionIds: ["faction-legacy"],
          adjacencyDepth: 6,
          outsidePolicy: "full",
        },
      });
    });

    await act(async () => {
      await result.current.createRun();
    });

    expect(buildBaselineMock).toHaveBeenLastCalledWith(
      storage,
      expect.objectContaining({
        start: { mode: "facts-anchor", sortKey: "0" },
        chapterContext: { mode: "none", chapterId: null },
        narrativeContext: expect.objectContaining({
          mode: "observe",
          selectedPlotLineIds: [],
        }),
        scope: expect.objectContaining({
          regionIds: [],
          characterIds: [],
          factionIds: [],
          adjacencyDepth: 1,
          outsidePolicy: "respond",
        }),
      }),
    );
    expect(result.current.run?.scenario.start).toEqual({
      mode: "facts-anchor",
      sortKey: "0",
    });
    expect(result.current.run?.scenario.chapterContext).toEqual({
      mode: "none",
      chapterId: null,
    });
  });

  it("等待主体模型候选时保留当前轮次的瞬态结算进度", async () => {
    buildBaselineMock.mockResolvedValue(baselineWithUnplacedActor());
    const storage = new NovelMemoryStorage({});
    let releaseActor: ((value: string) => void) | undefined;
    let releaseResolution: ((value: string) => void) | undefined;
    const actorOutput = new Promise<string>((resolve) => {
      releaseActor = resolve;
    });
    const resolutionOutput = new Promise<string>((resolve) => {
      releaseResolution = resolve;
    });
    const candidate = JSON.stringify({
      title: "守住眼前的日子",
      summary: "沈砚选择先照看家人，等待局势进一步明朗。",
      kind: "character-action",
      characterIds: ["character-progress"],
      factionIds: [],
      regionIds: [],
      itemIds: [],
      commands: [
        {
          type: "character.intent",
          characterId: "character-progress",
          intent: "照看家人并观察局势",
          status: "观察中",
        },
      ],
      confidence: 0.8,
      objective: "维持日常",
      perceivedFacts: [],
      assumptions: [],
      expectedUtility: 60,
      risks: [],
    });
    const { result } = renderHook(() =>
      useWorldSimulationController({
        storage,
        isActive: false,
        onRunModelScene: async (scene) => {
          if (scene === "simulation.actor") return actorOutput;
          if (scene === "simulation.resolve") return resolutionOutput;
          throw new Error(`未预期的模型场景：${scene}`);
        },
      }),
    );

    await act(async () => {
      await result.current.createRun();
    });

    let advancing: Promise<void> | undefined;
    act(() => {
      advancing = result.current.advanceOne();
    });
    await waitFor(() => {
      expect(result.current.progress).toMatchObject({
        roundIndex: 1,
        phase: "actors",
        from: "第 0 日",
        to: "第 1 年",
      });
    });
    releaseActor?.(candidate);
    await waitFor(() => {
      expect(result.current.progress?.phase).toBe("arbitrating");
    });
    releaseResolution?.(candidate);
    await act(async () => {
      await advancing;
    });

    expect(result.current.progress).toBeNull();
    expect(result.current.branch?.ledger).toHaveLength(1);
  });

  it("toEnd 首次完成后自动生成报告和纪元叙事，重复调用不重复生成", async () => {
    buildBaselineMock.mockResolvedValue(baseline());
    const storage = new NovelMemoryStorage({});
    const scenes: WorldSimulationModelScene[] = [];
    const { result } = renderHook(() =>
      useWorldSimulationController({
        storage,
        isActive: false,
        onRunModelScene: async (scene) => {
          scenes.push(scene);
          if (scene === "simulation.epoch-narration") {
            return JSON.stringify({
              title: "纪元叙事",
              summary: "长尺度聚合状态发生变化。",
              findings: ["该叙事仅解释确定性纪元事件。"],
              eventIds: [],
            });
          }
          if (scene === "simulation.report") {
            return JSON.stringify({
              title: "自动报告",
              summary: "推演已完成。",
              sections: [],
            });
          }
          throw new Error(`未预期的模型场景：${scene}`);
        },
      }),
    );

    act(() => {
      result.current.updateScenario({
        ...result.current.scenario,
        duration: { amount: "1", unit: "trillion-years" },
        roundSpan: { amount: "1", unit: "trillion-years" },
        outputScales: ["trillion-years"],
        maxSteps: 1,
        maxModelCalls: 2,
        intelligence: { mode: "assisted", cadence: "milestones" },
      });
    });
    await act(async () => {
      await result.current.createRun();
    });
    await waitFor(() => {
      expect(result.current.run).not.toBeNull();
    });
    await act(async () => {
      await result.current.runToEnd();
    });

    await waitFor(() => {
      expect(result.current.branch?.status).toBe("completed");
    });
    expect(scenes).toEqual(["simulation.epoch-narration", "simulation.report"]);
    expect(result.current.run?.reports).toHaveLength(1);
    expect(
      result.current.run?.reports[0]?.sections.some(
        (section) => section.kind === "narrative",
      ),
    ).toBe(true);

    await act(async () => {
      await result.current.runToEnd();
    });
    expect(scenes).toHaveLength(2);
    expect(result.current.run?.reports).toHaveLength(1);
  });

  it("运行基线保持锁定，重新编译只报告资料漂移且取消会终止当前分支", async () => {
    let compileCount = 0;
    buildBaselineMock.mockImplementation(async () => ({
      ...baseline(),
      sourceRevision: `source-revision-${++compileCount}`,
    }));
    const storage = new NovelMemoryStorage({});
    const { result } = renderHook(() =>
      useWorldSimulationController({
        storage,
        isActive: false,
      }),
    );

    await act(async () => {
      await result.current.createRun();
    });
    const lockedRevision = result.current.run?.baseline.sourceRevision;
    expect(lockedRevision).toBe("source-revision-1");

    await act(async () => {
      await result.current.rebuildBaseline();
    });
    expect(result.current.run?.baseline.sourceRevision).toBe(lockedRevision);
    expect(result.current.sourceDriftWarning).toContain("正式资料已变化");

    await act(async () => {
      await result.current.cancelRun();
    });
    expect(result.current.branch?.status).toBe("cancelled");
  });

  it("可以从另一个运行的分支摘要直接切换到对应世界", async () => {
    buildBaselineMock.mockResolvedValue(baseline());
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      id: "scenario-run-switch",
      name: "跨运行分支",
      seed: "run-switch-seed",
    };
    const source = createWorldSimulationRun(baseline(), scenario);
    const main = source.branches[0]!;
    const run = {
      ...source,
      branches: [
        main,
        {
          ...main,
          id: "branch-alternate",
          name: "北境假设分支",
          parentBranchId: main.id,
          status: "paused" as const,
          seed: main.seed + ":alternate",
        },
      ],
    };
    await repository.createRun(run);
    const { result } = renderHook(() =>
      useWorldSimulationController({ storage, isActive: false }),
    );

    await act(async () => {
      await result.current.selectRunBranch(run.id, "branch-alternate");
    });

    expect(result.current.run?.id).toBe(run.id);
    expect(result.current.branch?.id).toBe("branch-alternate");
    expect(result.current.scenario.id).toBe("scenario-run-switch");
    await expect(repository.loadRun(run.id)).resolves.toMatchObject({
      value: { activeBranchId: "branch-alternate" },
    });
  });
});
