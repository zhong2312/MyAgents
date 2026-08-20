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
    scenario: {
      ...createDefaultWorldSimulationScenario(),
      id: "scenario-test",
    },
    baseline: { projectId: "project-test" },
    activeBranchId: "branch-main",
    branches: [
      {
        id: "branch-main",
        name: "主分支",
        parentBranchId: null,
        forkEventId: null,
        narrativePolicy: "configured",
        guardrails: ["测试护栏"],
        authorLeads: ["测试线索"],
        seed: "test-seed",
        status: "ready",
        state: { currentTime: { sortKey: "0" } },
        ledger: [],
        observations: [],
        checkpoints: [],
        warnings: [],
      },
    ],
    councilSessions: [],
    reports: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  } as unknown as WorldSimulationRun;
}

describe("WorldSimulationRepositoryV2", () => {
  it("发现旧版方案或运行索引时直接建立 V4 空存储，不读取或迁移旧内容", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: 2, scenarios: [{ id: "legacy" }] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: 2, runs: [{ id: "legacy-run" }] })}\n`,
      "simulation/runs/legacy-run/run.json": `${JSON.stringify({ schemaVersion: 2, id: "legacy-run" })}\n`,
    });
    const repository = createWorldSimulationRepositoryV2(storage);

    await expect(repository.loadScenarios()).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        scenarios: [
          expect.objectContaining({ id: "scenario-natural-evolution" }),
        ],
      },
    });
    await expect(repository.loadRunIndex()).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs: [],
        activeRunId: null,
      },
    });
    await expect(
      storage.readText("simulation/runs/legacy-run/run.json"),
    ).rejects.toThrow("File not found");
  });

  it("多个工作台同时发现旧版存储时只完成一次幂等重建", async () => {
    class ConcurrentMemoryStorage extends NovelMemoryStorage {
      override async writeText(
        path: string,
        content: string,
        options: { expectedContent?: string } = {},
      ) {
        await Promise.resolve();
        return super.writeText(path, content, options);
      }
    }
    const storage = new ConcurrentMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: 1, scenarios: [] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: 1, runs: [] })}\n`,
    });
    const first = createWorldSimulationRepositoryV2(storage);
    const second = createWorldSimulationRepositoryV2(storage);

    await expect(
      Promise.all([first.loadScenarios(), second.loadRunIndex()]),
    ).resolves.toHaveLength(2);
    await expect(first.loadRunIndex()).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs: [],
        activeRunId: null,
      },
    });
  });

  it("发现缺失 schemaVersion 的旧运行索引时重建 V4 空存储", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({
        scenarios: [],
        activeScenarioId: null,
      })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({
        runs: [],
        activeRunId: null,
      })}\n`,
    });

    await expect(
      createWorldSimulationRepositoryV2(storage).loadRunIndex(),
    ).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs: [],
        activeRunId: null,
      },
    });
    await expect(
      createWorldSimulationRepositoryV2(storage).loadScenarios(),
    ).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        scenarios: [
          expect.objectContaining({ id: "scenario-natural-evolution" }),
        ],
      },
    });
  });

  it("does not replace malformed current-version data as if it were legacy", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, scenarios: [] })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, runs: [], activeRunId: null })}\n`,
    });

    await expect(
      createWorldSimulationRepositoryV2(storage).loadScenarios(),
    ).rejects.toThrow("世界推演方案格式无效");
  });

  it("发现顶层为 V4 但内部仍是旧版的方案文件时重建空 V4 存储", async () => {
    const storage = new NovelMemoryStorage({
      "simulation/scenarios.json": `${JSON.stringify({
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        scenarios: [{ schemaVersion: 3, id: "legacy-nested" }],
        activeScenarioId: "legacy-nested",
      })}\n`,
      "simulation/runs/index.json": `${JSON.stringify({
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs: [],
        activeRunId: null,
      })}\n`,
    });

    await expect(
      createWorldSimulationRepositoryV2(storage).loadScenarios(),
    ).resolves.toMatchObject({
      value: {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        scenarios: [
          expect.objectContaining({ id: "scenario-natural-evolution" }),
        ],
      },
    });
  });

  it("rebases a stale scenario save onto the latest scenario file", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const original = await repository.loadScenarios();
    const scenario = original.value.scenarios[0]!;

    await repository.saveScenario(original, {
      ...scenario,
      name: "第一次保存",
    });

    const saved = await repository.saveScenario(original, {
      ...scenario,
      name: "冲突后重试",
    });

    expect(saved.value.scenarios).toContainEqual(
      expect.objectContaining({
        id: scenario.id,
        name: "冲突后重试",
      }),
    );
  });

  it("以清单和模块文件保存运行，run.json 不再重复内嵌大型数据", async () => {
    const storage = new NovelMemoryStorage({});
    storage.requireExplicitParents = true;

    const repository = createWorldSimulationRepositoryV2(storage);
    await expect(repository.createRun(runFixture())).resolves.toMatchObject({
      run: { value: { id: "run-materialized-files" } },
    });
    const manifest = JSON.parse(
      (
        await storage.readText(
          "simulation/runs/run-materialized-files/run.json",
        )
      ).content,
    );
    expect(manifest).toMatchObject({
      storageVersion: 1,
      id: "run-materialized-files",
      baselinePath: "simulation/runs/run-materialized-files/baseline.json",
      councilPath: "simulation/runs/run-materialized-files/council.json",
      reportsPath: "simulation/runs/run-materialized-files/reports/index.json",
      branches: [
        {
          id: "branch-main",
          guardrails: ["测试护栏"],
          authorLeads: ["测试线索"],
          statePath:
            "simulation/runs/run-materialized-files/branches/branch-main/state.json",
          eventLedgerPath:
            "simulation/runs/run-materialized-files/branches/branch-main/event-ledger.jsonl",
        },
      ],
    });
    expect(manifest).not.toHaveProperty("baseline");
    expect(manifest.branches[0]).not.toHaveProperty("state");
    expect(manifest.branches[0]).not.toHaveProperty("ledger");
    await expect(
      storage.readText(
        "simulation/runs/run-materialized-files/reports/index.json",
      ),
    ).resolves.toBeDefined();
    await expect(
      storage.readText(
        "simulation/runs/run-materialized-files/branches/branch-main/state.json",
      ),
    ).resolves.toBeDefined();
    await expect(
      repository.loadRun("run-materialized-files", "project-test"),
    ).resolves.toMatchObject({
      value: {
        id: "run-materialized-files",
        branches: [
          {
            id: "branch-main",
            guardrails: ["测试护栏"],
            authorLeads: ["测试线索"],
          },
        ],
      },
    });
    await expect(repository.loadRunIndex()).resolves.toMatchObject({
      value: {
        runs: [
          expect.objectContaining({
            id: "run-materialized-files",
            anchorDisplayText: "世界日 0",
            duration: { amount: "100", unit: "year" },
            roundSpan: { amount: "1", unit: "year" },
            branches: [
              expect.objectContaining({
                id: "branch-main",
                currentTimeDisplayText: "世界日 0",
                eventCount: 0,
              }),
            ],
          }),
        ],
      },
    });
  });

  it("持久化并恢复分支的决策与模型调用计数", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const source = runFixture();
    const counted = {
      ...source,
      branches: source.branches.map((branch) => ({
        ...branch,
        decisionCount: 7,
        modelCallCount: 3,
      })),
    } as WorldSimulationRun;

    await repository.createRun(counted);
    const manifest = JSON.parse(
      (
        await storage.readText(
          "simulation/runs/run-materialized-files/run.json",
        )
      ).content,
    ) as {
      branches: readonly { decisionCount: number; modelCallCount: number }[];
    };
    expect(manifest.branches[0]).toMatchObject({
      decisionCount: 7,
      modelCallCount: 3,
    });
    await expect(
      repository.loadRun("run-materialized-files"),
    ).resolves.toMatchObject({
      value: {
        branches: [{ decisionCount: 7, modelCallCount: 3 }],
      },
    });
  });

  it("完整往返保存分支运行态中的人物长期记忆与关系", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const source = runFixture();
    const withMemory = {
      ...source,
      branches: source.branches.map((branch) => ({
        ...branch,
        state: {
          ...branch.state,
          characters: [
            {
              id: "character-1",
              alive: true,
              status: "行动中",
              locationId: "region-1",
              travel: null,
              intent: "观察",
              ageDays: "365",
              cultivationProgress: 0,
              levelId: null,
              resourceBalances: { spirit: 4 },
              knowledgeIds: ["knowledge-local"],
              relations: [
                {
                  targetCharacterId: "character-2",
                  affinity: 42,
                  trust: 35,
                  status: "strained",
                },
              ],
              memory: [
                {
                  knowledgeId: "knowledge-local",
                  strength: 37,
                  firstKnownSortKey: "0",
                  lastRecalledSortKey: "120",
                },
              ],
            },
          ],
          factions: [
            {
              id: "faction-1",
              lifecycle: "expanding",
              strategy: "交涉",
              governance: 60,
              military: 55,
              economy: 50,
              publicSupport: 65,
              territorialIntegrity: 70,
              relations: [
                {
                  targetFactionId: "faction-2",
                  sentiment: -25,
                  status: "suspended",
                },
              ],
            },
          ],
        },
      })),
    } as unknown as WorldSimulationRun;

    const created = await repository.createRun(withMemory);
    const loaded = await repository.loadRun(created.run.value.id);
    expect(loaded.value.branches[0]?.state).toEqual(
      withMemory.branches[0]?.state,
    );
  });

  it("将事件账本与检查点以 JSONL 追加，保留既有行字节", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const created = await repository.createRun(runFixture());
    const firstRun = {
      ...created.run.value,
      branches: [
        {
          ...created.run.value.branches[0]!,
          ledger: [{ id: "event-1", sequence: 1, title: "第一事件" }],
          checkpoints: [
            { id: "checkpoint-1", eventSequence: 1, label: "首次检查点" },
          ],
        },
      ],
    } as unknown as WorldSimulationRun;
    const firstSaved = await repository.saveRun(created.run, firstRun);
    const ledgerPath =
      "simulation/runs/run-materialized-files/branches/branch-main/event-ledger.jsonl";
    const checkpointsPath =
      "simulation/runs/run-materialized-files/branches/branch-main/checkpoints.jsonl";
    const firstLedgerLine = (await storage.readText(ledgerPath)).content;
    const firstCheckpointLine = (await storage.readText(checkpointsPath))
      .content;

    const secondRun = {
      ...firstSaved.run.value,
      branches: [
        {
          ...firstSaved.run.value.branches[0]!,
          ledger: [
            ...firstSaved.run.value.branches[0]!.ledger,
            { id: "event-2", sequence: 2, title: "第二事件" },
          ],
          checkpoints: [
            ...firstSaved.run.value.branches[0]!.checkpoints,
            { id: "checkpoint-2", eventSequence: 2, label: "第二检查点" },
          ],
        },
      ],
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
    const statePath =
      "simulation/runs/run-materialized-files/branches/branch-main/state.json";
    storage.setExternalText(
      statePath,
      `${JSON.stringify({ currentTime: { sortKey: "99" } }, null, 2)}\n`,
    );

    await expect(
      repository.saveRun(created.run, {
        ...created.run.value,
        name: "不应覆盖外部修改",
      }),
    ).rejects.toThrow("推演运行事实源已被外部修改");
    expect((await storage.readText(statePath)).content).toContain('"99"');
  });

  it("拒绝回退或改写已保存的事件账本", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    const created = await repository.createRun(runFixture());
    const withEvent = await repository.saveRun(created.run, {
      ...created.run.value,
      branches: [
        {
          ...created.run.value.branches[0]!,
          ledger: [{ id: "event-1", sequence: 1, title: "第一事件" }],
        },
      ],
    } as unknown as WorldSimulationRun);

    await expect(
      repository.saveRun(withEvent.run, {
        ...withEvent.run.value,
        branches: [{ ...withEvent.run.value.branches[0]!, ledger: [] }],
      }),
    ).rejects.toThrow("JSONL 账本不能回退或改写");
  });

  it("运行目录删除失败时恢复带 CAS 的运行索引", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createWorldSimulationRepositoryV2(storage);
    await repository.createRun(runFixture());
    storage.failRemovePathOnce = "simulation/runs/run-materialized-files";

    await expect(
      repository.removeRun("run-materialized-files"),
    ).rejects.toThrow("删除推演运行目录失败，已恢复运行索引");

    await expect(
      repository.loadRun("run-materialized-files"),
    ).resolves.toMatchObject({
      value: { id: "run-materialized-files" },
    });
    await expect(repository.loadRunIndex()).resolves.toMatchObject({
      value: {
        runs: [expect.objectContaining({ id: "run-materialized-files" })],
        activeRunId: "run-materialized-files",
      },
    });
  });
});
