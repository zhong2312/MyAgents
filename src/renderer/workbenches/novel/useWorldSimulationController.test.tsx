import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const buildBaselineMock = vi.hoisted(() => vi.fn());

vi.mock("./worldSimulationProjection", () => ({
  buildWorldSimulationBaseline: buildBaselineMock,
}));

import { NovelMemoryStorage } from "./shared/infrastructure/testStorage";
import { createWorldSimulationRepositoryV2 } from "./worldSimulationRepositoryV2";
import {
  useWorldSimulationController,
  type WorldSimulationModelScene,
} from "./useWorldSimulationController";
import type { WorldSimulationBaseline } from "./worldSimulationV2Schema";

function baseline(): WorldSimulationBaseline {
  return {
    projectId: "test-project",
    projectTitle: "测试小说",
    sourceRevision: "source-revision",
    sourceRefs: [],
    anchor: { displayText: "当前" },
    characters: [],
    factions: [],
    regions: [],
    rules: [],
    cultivationSystems: [],
    timelineFacts: [],
    narrativeConstraints: [],
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
});
