import { describe, expect, it } from "vitest";

import { narrativeRecordPath } from "../../../shared/workbenches/novel/narrativeEngineeringStorage";
import {
  createEmptyNarrativeEngineering,
  type PlotLine,
} from "./narrativeEngineeringSchema";
import { createNarrativeEngineeringRepository } from "./narrativeEngineeringRepository";
import { NovelMemoryStorage } from "./testStorage";

const createdAt = "2026-08-09T00:00:00.000Z";

function line(id: string, title: string): PlotLine {
  return {
    id,
    title,
    kind: "main",
    storyRole: "a",
    status: "active",
    color: "#123456",
    premise: `${title}的前提`,
    protagonistCharacterId: null,
    keyNodes: [],
    content: `${title}的正文`,
  };
}

describe("NarrativeEngineeringRepository", () => {
  it("根索引只保存记录引用，并聚合读回完整领域对象", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const current = await repository.load();
    const saved = await repository.save(current, {
      ...createEmptyNarrativeEngineering(createdAt),
      lines: [line("line-main", "主线"), line("line-second", "副线")],
    });

    const index = JSON.parse(
      (await storage.readText("narrative/index.json")).content,
    );
    expect(index).toMatchObject({
      storageVersion: 1,
      lines: [
        { id: "line-main", path: narrativeRecordPath("lines", "line-main") },
        {
          id: "line-second",
          path: narrativeRecordPath("lines", "line-second"),
        },
      ],
    });
    expect(index.lines[0]).not.toHaveProperty("content");
    expect(saved.library.lines.map((entry) => entry.title)).toEqual([
      "主线",
      "副线",
    ]);
  });

  it("修改单个对象时保持其它记录内容不变", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const initialized = await repository.load();
    const first = await repository.save(initialized, {
      ...initialized.library,
      lines: [line("line-main", "主线"), line("line-second", "副线")],
    });
    const secondPath = narrativeRecordPath("lines", "line-second");
    const secondBefore = (await storage.readText(secondPath)).content;

    await repository.save(first, {
      ...first.library,
      lines: first.library.lines.map((entry) =>
        entry.id === "line-main" ? { ...entry, content: "更新正文" } : entry,
      ),
    });

    expect((await storage.readText(secondPath)).content).toBe(secondBefore);
  });

  it("目录内任一记录被外部修改时阻止覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const initialized = await repository.load();
    const current = await repository.save(initialized, {
      ...initialized.library,
      lines: [line("line-main", "主线")],
    });
    const path = narrativeRecordPath("lines", "line-main");
    storage.setExternalText(
      path,
      `${JSON.stringify({ ...current.library.lines[0], content: "外部修改" }, null, 2)}\n`,
    );

    await expect(
      repository.save(current, {
        ...current.library,
        lines: [{ ...current.library.lines[0]!, content: "页面修改" }],
      }),
    ).rejects.toThrow("剧情工程事实源已被外部修改");
    expect((await storage.readText(path)).content).toContain("外部修改");
  });

  it("对象从聚合移除后清理其孤立记录", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const initialized = await repository.load();
    const current = await repository.save(initialized, {
      ...initialized.library,
      lines: [line("line-main", "主线")],
    });
    const path = narrativeRecordPath("lines", "line-main");

    await repository.save(current, { ...current.library, lines: [] });

    await expect(storage.readText(path)).rejects.toThrow("File not found");
  });

  it("往返持久化结构化世界推演约束", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const initialized = await repository.load();
    const saved = await repository.save(initialized, {
      ...initialized.library,
      lines: [
        {
          ...line("line-main", "主线"),
          simulationConstraint: {
            timeWindow: { startSortKey: "0", endSortKey: "360" },
            requiredActorIds: ["hero-1"],
            requiredRegionIds: ["region-1"],
            requiredOutcomes: [
              {
                id: "arrival",
                kind: "command",
                commandType: "character.arrive",
                entityType: "character",
                entityId: "hero-1",
                field: "toRegionId",
                operator: "equals",
                value: "region-1",
              },
            ],
            forbiddenOutcomes: [],
            flexibility: 15,
          },
        },
      ],
    });
    const reloaded = await repository.load();
    expect(reloaded.library.lines[0]?.simulationConstraint).toEqual(
      saved.library.lines[0]?.simulationConstraint,
    );
  });
});
