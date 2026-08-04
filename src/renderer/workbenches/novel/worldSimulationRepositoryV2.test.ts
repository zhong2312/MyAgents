import { describe, expect, it } from "vitest";

import { WORLD_SIMULATION_SCHEMA_VERSION, type WorldSimulationRun } from "./worldSimulationV2Schema";
import { NovelMemoryStorage } from "./testStorage";
import { createWorldSimulationRepositoryV2 } from "./worldSimulationRepositoryV2";

function runFixture(): WorldSimulationRun {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    id: "run-materialized-files",
    projectId: "project-test",
    name: "物化文件测试",
    scenario: { id: "scenario-test" },
    baseline: {},
    activeBranchId: "branch-main",
    branches: [{
      id: "branch-main",
      status: "ready",
      state: { currentTime: { sortKey: "0" } },
      ledger: [],
      observations: [],
      checkpoints: [],
    }],
    councilSessions: [],
    reports: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  } as unknown as WorldSimulationRun;
}

describe("WorldSimulationRepositoryV2", () => {
  it("archives historical scenario and run indexes before starting V3", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: 2, scenarios: [{ id: "legacy" }] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: 2, runs: [{ id: "legacy-run" }] })}\n`,
    });
    const repository = createWorldSimulationRepositoryV2(storage);

    const scenarios = await repository.loadScenarios();
    const runs = await repository.loadRunIndex();

    expect(scenarios.value.schemaVersion).toBe(WORLD_SIMULATION_SCHEMA_VERSION);
    expect(scenarios.value.scenarios).toHaveLength(1);
    expect(scenarios.value.scenarios[0]?.id).not.toBe("legacy");
    expect(runs.value).toEqual({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, runs: [], activeRunId: null });
    await expect(storage.readText("simulation/legacy/schema-v2/scenarios.json")).resolves.toMatchObject({
      content: expect.stringContaining('"legacy"'),
    });
    await expect(storage.readText("simulation/legacy/schema-v2/runs/index.json")).resolves.toMatchObject({
      content: expect.stringContaining('"legacy-run"'),
    });
  });

  it("does not replace malformed current-version data as if it were legacy", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, scenarios: [] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, runs: [], activeRunId: null })}\n`,
    });

    await expect(createWorldSimulationRepositoryV2(storage).loadScenarios()).rejects.toThrow("世界推演方案格式无效");
  });

  it("rebases a stale scenario save onto the latest scenario file", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const original = await repository.loadScenarios();
    const scenario = original.value.scenarios[0]!;

    await repository.saveScenario(original, { ...scenario, name: "第一次保存" });

    const saved = await repository.saveScenario(original, { ...scenario, name: "冲突后重试" });

    expect(saved.value.scenarios).toContainEqual(expect.objectContaining({
      id: scenario.id,
      name: "冲突后重试",
    }));
  });

  it("creates run directories before writing its materialized files", async () => {
    const storage = new NovelMemoryStorage({});
    storage.requireExplicitParents = true;

    await expect(createWorldSimulationRepositoryV2(storage).createRun(runFixture())).resolves.toMatchObject({
      run: { value: { id: "run-materialized-files" } },
    });
    await expect(storage.readText("simulation/runs/run-materialized-files/reports/index.json")).resolves.toBeDefined();
    await expect(storage.readText("simulation/runs/run-materialized-files/branches/branch-main/state.json")).resolves.toBeDefined();
  });
});
