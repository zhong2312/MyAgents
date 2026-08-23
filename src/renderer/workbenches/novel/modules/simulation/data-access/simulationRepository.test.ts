import { describe, expect, it } from "vitest";

import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { advanceSimulationRun } from "../business/simulationEngine";
import { createNovelSimulationRepository } from "./simulationRepository";

const createInput = {
  id: "run-test",
  name: "测试世界运行",
  baselineMode: "timeline-current" as const,
  baselineSourceHash: "fnv1a-test",
  baselineLabel: "当前正式事实",
  endTime: 365,
  timeScale: "year" as const,
  observationSpaceIds: ["world-root"],
  observationSpaceLabel: "测试世界",
  observer: "ensemble" as const,
  seed: 7,
  now: "2026-01-01T00:00:00.000Z",
};

describe("NovelSimulationRepository", () => {
  it("初始化并持久化运行、轮次和事件", async () => {
    const storage = new NovelMemoryStorage({
      "characters/index.json": '{"characters":[{"id":"hero"}]}\n',
      "world/factions/index.json": '{"factions":[{"id":"guild"}]}\n',
    });
    const repository = createNovelSimulationRepository(storage);
    let loaded = await repository.load();
    const created = await repository.createRun(loaded, createInput);
    loaded = created.loaded;

    const result = advanceSimulationRun(
      created.run,
      {
        characterCount: 1,
        factionCount: 1,
        locationCount: 1,
        timelineEventCount: 0,
        observationSpaceId: "world-root",
        observationSpaceLabel: "测试世界",
      },
      "2026-01-02T00:00:00.000Z",
    );
    loaded = await repository.updateRun(
      loaded,
      created.run.id,
      {},
      {
        manifest: result.run,
        rounds: [result.round],
        events: result.events,
      },
    );

    expect(loaded.index.activeRunId).toBe("run-test");
    expect(loaded.runs.get("run-test")?.rounds).toHaveLength(1);
    expect(loaded.runs.get("run-test")?.events.length).toBeGreaterThan(0);
    expect(loaded.index.runs[0]).toMatchObject({ status: "completed" });
    expect(storage.getText("characters/index.json")).toBe(
      '{"characters":[{"id":"hero"}]}\n',
    );
    expect(storage.getText("world/factions/index.json")).toBe(
      '{"factions":[{"id":"guild"}]}\n',
    );
  });

  it("检测到运行文件外部修改时拒绝覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelSimulationRepository(storage);
    const loaded = await repository.load();
    const created = await repository.createRun(loaded, createInput);
    const indexPath = "world/simulations/index.json";
    storage.setExternalText(indexPath, `${storage.getText(indexPath)}\n`);

    await expect(
      repository.save(
        created.loaded,
        created.loaded.index,
        created.loaded.runs,
      ),
    ).rejects.toThrow("已被外部修改");
  });

  it("持久化多主体观察对象和章节基线引用", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelSimulationRepository(storage);
    const loaded = await repository.load();
    const created = await repository.createRun(loaded, {
      ...createInput,
      id: "run-targets",
      baselineMode: "after-chapter",
      baselineSourceHash: "fnv1a-chapter",
      baselineLabel: "从第 10000 章之后继续",
      baselineChapterId: "chapter-010000",
      baselineChapterLabel: "第 10000 章 · 潮汐之后",
      observationTargets: [
        { type: "character", id: "hero", label: "沈照夜" },
        { type: "faction", id: "guild", label: "赤霄宗" },
      ],
    });

    expect(created.run.observationTargets).toEqual([
      { type: "character", id: "hero", label: "沈照夜" },
      { type: "faction", id: "guild", label: "赤霄宗" },
    ]);
    expect(created.run.baselineChapterId).toBe("chapter-010000");
    expect(created.run.baselineChapterLabel).toBe("第 10000 章 · 潮汐之后");
    const manifestPath = created.loaded.index.runs[0]?.path;
    const manifest = JSON.parse(storage.getText(manifestPath ?? "") ?? "{}");
    expect(manifest.observationTargets).toHaveLength(2);
    expect(manifest.baselineChapterId).toBe("chapter-010000");
  });
});
