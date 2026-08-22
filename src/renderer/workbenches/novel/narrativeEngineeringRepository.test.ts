import { describe, expect, it } from "vitest";

import { narrativeRecordPath } from "../../../shared/workbenches/novel/narrativeEngineeringStorage";
import {
  createEmptyNarrativeEngineering,
  narrativeSimulationConstraintSchema,
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

  it("保存并读回结构化剧情约束", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNarrativeEngineeringRepository(storage);
    const initialized = await repository.load();
    const constrainedLine: PlotLine = {
      ...line("line-main", "北境主线"),
      simulationConstraint: {
        timeWindow: { startSortKey: "10", endSortKey: "90" },
        requiredActorIds: ["char-a"],
        requiredRegionIds: ["region-north"],
        requiredOutcomes: [
          {
            id: "outcome-war",
            kind: "event",
            eventKind: "conflict",
            entityIds: ["faction-cloud"],
            regionIds: ["region-north"],
          },
        ],
        forbiddenOutcomes: [
          {
            id: "outcome-no-dissolve",
            kind: "command",
            commandType: "faction.strategy",
            entityType: "faction",
            entityId: "faction-cloud",
            field: "strategy",
            operator: "contains",
            value: "解体",
          },
        ],
        flexibility: 25,
      },
    };

    const saved = await repository.save(initialized, {
      ...initialized.library,
      lines: [constrainedLine],
    });

    expect(saved.library.lines[0]?.simulationConstraint).toEqual(
      constrainedLine.simulationConstraint,
    );
    expect(
      (await storage.readText(narrativeRecordPath("lines", "line-main")))
        .content,
    ).toContain('"simulationConstraint"');
  });

  it("拒绝无效时间窗和不完整命令谓词", () => {
    expect(() =>
      narrativeSimulationConstraintSchema.parse({
        timeWindow: { startSortKey: "90", endSortKey: "10" },
      }),
    ).toThrow("时间窗结束坐标不能早于开始坐标");
    expect(() =>
      narrativeSimulationConstraintSchema.parse({
        requiredOutcomes: [
          {
            id: "outcome-invalid-entity",
            kind: "command",
            commandType: "item.transfer",
            entityType: "item",
            entityId: null,
            field: null,
            operator: "exists",
            value: null,
          },
        ],
      }),
    ).toThrow("指定实体类型时必须提供实体 id");
    expect(() =>
      narrativeSimulationConstraintSchema.parse({
        forbiddenOutcomes: [
          {
            id: "outcome-invalid-value",
            kind: "command",
            commandType: "character.resource",
            entityType: "character",
            entityId: "char-a",
            field: null,
            operator: "equals",
            value: null,
          },
        ],
      }),
    ).toThrow("equals/contains 谓词必须同时提供字段和值");
  });
});
