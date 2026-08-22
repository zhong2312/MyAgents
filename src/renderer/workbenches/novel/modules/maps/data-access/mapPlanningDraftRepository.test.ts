import { describe, expect, it } from "vitest";

import { createMapPlanningDraftRepository } from "./mapPlanningDraftRepository";
import type { MapGenerationPlan } from "../../../../../../shared/workbenches/novel/mapGenerationPlan";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

const plan: MapGenerationPlan = {
  schemaVersion: 1,
  styleId: "xuanhuan-zh",
  worldSourceHash: "a".repeat(64),
  scope: {
    worldNodeId: "world",
    nodeIds: ["world"],
    nodePath: "九州",
    generationLevelTypeId: "continent",
    generationLevelName: "大陆",
  },
  azgaar: {
    heightmapTemplate: "east-asia",
    landmassCount: 1,
    regionCount: 3,
    riverCount: 2,
    states: 2,
    cultures: 1,
    religions: 0,
    precipitation: 180,
  },
  spatialLayers: [
    {
      id: "layer-world",
      name: "九州",
      worldNodeId: "world",
      parentId: null,
      levelTypeId: "continent",
      role: "realm",
      zone: "center",
      climate: [],
      terrain: ["平原", "河网"],
      anchor: null,
      notes: "世界核心区域。",
    },
  ],
  entities: [],
  relations: [],
  visual: {
    paperPreset: "parchment",
    labelHierarchy: "balanced",
    borderStyle: "ink",
    reliefStyle: "ink-peaks",
    waterStyle: "indigo-ripple",
    terrainMaterials: ["grassland"],
    ornaments: [],
    notes: "玄幻舆图。",
  },
  rationale: "测试规划。",
};

function draft(phase: "planning" | "visual") {
  return JSON.stringify({
    schemaVersion: 1,
    domain: "maps",
    draftId: `draft-${phase}`,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    source: {
      promptId: "novel.maps.fantasy",
      promptVersion: "1.0.0",
      sessionId: "session-map",
    },
    validation: null,
    submittedProposalId: null,
    payload: {
      phase,
      title: "九州玄幻地图规划",
      description: "规划审阅内容。",
      generationPlan: plan,
      operations: [],
    },
  });
}

describe("createMapPlanningDraftRepository", () => {
  it("只加载待确认的地图规划草稿", async () => {
    const storage = new NovelMemoryStorage({
      "world/maps/drafts/draft-planning/draft.json": draft("planning"),
      "world/maps/drafts/draft-visual/draft.json": draft("visual"),
    });
    const result = await createMapPlanningDraftRepository(storage).list();

    expect(result.errors).toEqual([]);
    expect(result.drafts).toEqual([
      expect.objectContaining({
        draftId: "draft-planning",
        title: "九州玄幻地图规划",
        generationPlan: plan,
        source: {
          promptId: "novel.maps.fantasy",
          promptVersion: "1.0.0",
          sessionId: "session-map",
        },
      }),
    ]);
  });

  it("把损坏草稿作为局部诊断，不阻止其他规划显示", async () => {
    const storage = new NovelMemoryStorage({
      "world/maps/drafts/draft-planning/draft.json": draft("planning"),
      "world/maps/drafts/draft-bad/draft.json": "{ invalid json",
    });
    const result = await createMapPlanningDraftRepository(storage).list();

    expect(result.drafts).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ draftId: "draft-bad" }),
    ]);
  });

  it("以文件内容 CAS 确认规划并推进到视觉阶段", async () => {
    const path = "world/maps/drafts/draft-planning/draft.json";
    const storage = new NovelMemoryStorage({ [path]: draft("planning") });
    const repository = createMapPlanningDraftRepository(storage);

    const confirmed = await repository.confirm("draft-planning");

    expect(confirmed).toMatchObject({
      draftId: "draft-planning",
      revision: 2,
    });
    const persisted = JSON.parse(storage.getText(path)!);
    expect(persisted.revision).toBe(2);
    expect(persisted.payload.phase).toBe("visual");
    expect((await repository.list()).drafts).toEqual([]);
  });

  it("拒绝重复确认并报告外部修改冲突", async () => {
    const path = "world/maps/drafts/draft-planning/draft.json";
    const storage = new NovelMemoryStorage({ [path]: draft("planning") });
    const repository = createMapPlanningDraftRepository(storage);

    await repository.confirm("draft-planning");
    await expect(repository.confirm("draft-planning")).rejects.toThrow(
      "已经确认",
    );

    class ExternalChangeOnReadStorage extends NovelMemoryStorage {
      private changed = false;

      override async readText(readPath: string) {
        const file = await super.readText(readPath);
        if (!this.changed) {
          this.changed = true;
          this.setExternalText(
            readPath,
            JSON.stringify({
              ...JSON.parse(file.content),
              updatedAt: "2026-01-03T00:00:00.000Z",
            }),
          );
        }
        return file;
      }
    }

    const planningStorage = new ExternalChangeOnReadStorage({
      [path]: draft("planning"),
    });
    const planningRepository =
      createMapPlanningDraftRepository(planningStorage);
    await expect(planningRepository.confirm("draft-planning")).rejects.toThrow(
      "File changed externally",
    );
  });
});
