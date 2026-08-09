import { describe, expect, it } from "vitest";

import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  createDefaultWorldSimulationScenario,
  type WorldSimulationRun,
} from "./worldSimulationV2Schema";
import { NovelMemoryStorage } from "./testStorage";
import { createWorldSimulationRepositoryV2 } from "./worldSimulationRepositoryV2";

function runFixture(): WorldSimulationRun {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    id: "run-materialized-files",
    projectId: "project-test",
    name: "物化文件测试",
    scenario: { ...createDefaultWorldSimulationScenario(), id: "scenario-test" },
    baseline: { projectId: "project-test" },
    activeBranchId: "branch-main",
    branches: [{
      id: "branch-main",
      name: "主分支",
      parentBranchId: null,
      forkEventId: null,
      narrativePolicy: "configured",
      seed: "test-seed",
      status: "ready",
      state: { currentTime: { sortKey: "0" } },
      ledger: [],
      observations: [],
      checkpoints: [],
      warnings: [],
    }],
    councilSessions: [],
    reports: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  } as unknown as WorldSimulationRun;
}

describe("WorldSimulationRepositoryV2", () => {
  it("不迁移或归档旧版方案与运行索引", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: 2, scenarios: [{ id: "legacy" }] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: 2, runs: [{ id: "legacy-run" }] })}\n`,
    });
    const repository = createWorldSimulationRepositoryV2(storage);

    await expect(repository.loadScenarios()).rejects.toThrow("世界推演方案格式无效");
    await expect(repository.loadRunIndex()).rejects.toThrow("世界推演运行索引格式无效");
    await expect(storage.readText("simulation/legacy/schema-v2/scenarios.json")).rejects.toThrow("File not found");
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

  it("以清单和模块文件保存运行，run.json 不再重复内嵌大型数据", async () => {
    const storage = new NovelMemoryStorage({});
    storage.requireExplicitParents = true;

    const repository = createWorldSimulationRepositoryV2(storage);
    await expect(repository.createRun(runFixture())).resolves.toMatchObject({
      run: { value: { id: "run-materialized-files" } },
    });
    const manifest = JSON.parse((await storage.readText("simulation/runs/run-materialized-files/run.json")).content);
    expect(manifest).toMatchObject({
      storageVersion: 1,
      id: "run-materialized-files",
      baselinePath: "simulation/runs/run-materialized-files/baseline.json",
      councilPath: "simulation/runs/run-materialized-files/council.json",
      reportsPath: "simulation/runs/run-materialized-files/reports/index.json",
      branches: [{
        id: "branch-main",
        statePath: "simulation/runs/run-materialized-files/branches/branch-main/state.json",
        eventLedgerPath: "simulation/runs/run-materialized-files/branches/branch-main/event-ledger.jsonl",
      }],
    });
    expect(manifest).not.toHaveProperty("baseline");
    expect(manifest.branches[0]).not.toHaveProperty("state");
    expect(manifest.branches[0]).not.toHaveProperty("ledger");
    await expect(storage.readText("simulation/runs/run-materialized-files/reports/index.json")).resolves.toBeDefined();
    await expect(storage.readText("simulation/runs/run-materialized-files/branches/branch-main/state.json")).resolves.toBeDefined();
    await expect(repository.loadRun("run-materialized-files", "project-test")).resolves.toMatchObject({
      value: { id: "run-materialized-files", branches: [{ id: "branch-main" }] },
    });
  });

  it("将事件账本与检查点以 JSONL 追加，保留既有行字节", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const created = await repository.createRun(runFixture());
    const firstRun = {
      ...created.run.value,
      branches: [{
        ...created.run.value.branches[0]!,
        ledger: [{ id: "event-1", sequence: 1, title: "第一事件" }],
        checkpoints: [{ id: "checkpoint-1", eventSequence: 1, label: "首次检查点" }],
      }],
    } as unknown as WorldSimulationRun;
    const firstSaved = await repository.saveRun(created.run, firstRun);
    const ledgerPath = "simulation/runs/run-materialized-files/branches/branch-main/event-ledger.jsonl";
    const checkpointsPath = "simulation/runs/run-materialized-files/branches/branch-main/checkpoints.jsonl";
    const firstLedgerLine = (await storage.readText(ledgerPath)).content;
    const firstCheckpointLine = (await storage.readText(checkpointsPath)).content;

    const secondRun = {
      ...firstSaved.run.value,
      branches: [{
        ...firstSaved.run.value.branches[0]!,
        ledger: [
          ...firstSaved.run.value.branches[0]!.ledger,
          { id: "event-2", sequence: 2, title: "第二事件" },
        ],
        checkpoints: [
          ...firstSaved.run.value.branches[0]!.checkpoints,
          { id: "checkpoint-2", eventSequence: 2, label: "第二检查点" },
        ],
      }],
    } as unknown as WorldSimulationRun;
    await repository.saveRun(firstSaved.run, secondRun);

    const ledger = (await storage.readText(ledgerPath)).content;
    const checkpoints = (await storage.readText(checkpointsPath)).content;
    expect(ledger.startsWith(firstLedgerLine)).toBe(true);
    expect(checkpoints.startsWith(firstCheckpointLine)).toBe(true);
    expect(ledger.trim().split("\n")).toHaveLength(2);
    expect(checkpoints.trim().split("\n")).toHaveLength(2);
  });

  it("用整个运行目录快照阻止外部修改被覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const created = await repository.createRun(runFixture());
    const statePath = "simulation/runs/run-materialized-files/branches/branch-main/state.json";
    storage.setExternalText(statePath, `${JSON.stringify({ currentTime: { sortKey: "99" } }, null, 2)}\n`);

    await expect(repository.saveRun(created.run, {
      ...created.run.value,
      name: "不应覆盖外部修改",
    })).rejects.toThrow("推演运行事实源已被外部修改");
    expect((await storage.readText(statePath)).content).toContain('"99"');
  });

  it("拒绝回退或改写已保存的事件账本", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const created = await repository.createRun(runFixture());
    const withEvent = await repository.saveRun(created.run, {
      ...created.run.value,
      branches: [{
        ...created.run.value.branches[0]!,
        ledger: [{ id: "event-1", sequence: 1, title: "第一事件" }],
      }],
    } as unknown as WorldSimulationRun);

    await expect(repository.saveRun(withEvent.run, {
      ...withEvent.run.value,
      branches: [{ ...withEvent.run.value.branches[0]!, ledger: [] }],
    })).rejects.toThrow("JSONL 账本不能回退或改写");
  });
});
