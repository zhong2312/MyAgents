import { describe, expect, it } from "vitest";

import {
  findInboundReferences,
  validateFactionCrossReferences,
  validateTimelineCrossReferences,
} from "./crossLibraryReferences";
import {
  createEmptyNovelChapterIndex,
  serializeNovelChapterIndex,
  type NovelChapterRecord,
} from "../../modules/project/entities/projectSchema";
import {
  serializeFactionLibrary,
  type FactionLibrary,
  type FactionMember,
  type FactionRecord,
} from "../../factionLibrarySchema";
import { NovelMemoryProjection, NovelMemoryStorage } from "../infrastructure/testStorage";
import {
  createEmptyTimelineLibrary,
  serializeTimelineLibrary,
  type TimelineEvent,
  type TimelineLibrary,
} from "../../timelineLibrarySchema";

const NOW = "2026-01-01T00:00:00.000Z";

function characterFiles(
  characters: readonly {
    readonly id: string;
    readonly name: string;
    readonly inventory?: readonly { readonly itemId: string | null }[];
  }[],
): Record<string, string> {
  const records = characters.map((character) => ({
      id: character.id,
      name: character.name,
      alias: "",
      roleWeight: "npc",
      archetype: "",
      alignment: "",
      status: "active",
      summary: "",
      identities: [],
      age: "",
      currentRealm: "",
      realmProgressNodes: [],
      baseLifespan: "",
      lifespanLoss: "",
      spiritRoot: "",
      daoBody: "",
      cultivationMethod: "",
      gender: "",
      raceId: "",
      soulId: "",
      groupIds: [],
      hometown: "",
      appearance: "",
      personality: "",
      values: "",
      strengths: "",
      weaknesses: "",
      fears: "",
      motivation: "",
      goals: "",
      innerConflict: "",
      background: "",
      abilities: "",
      speechStyle: "",
      habits: "",
      signatureItem: "",
      storyRole: "",
      arc: "",
      firstAppearance: "",
      completeness: 0,
      relations: [],
      appearances: [],
      arcStages: [],
      inventory:
        character.inventory?.map((entry, index) => ({
          id: `inv-${index}`,
          itemId: entry.itemId,
          name: "物品",
          quantity: 1,
          unit: "",
          description: "",
        })) ?? [],
    }));
  return {
    "characters/index.json": JSON.stringify({
      schemaVersion: 1,
      characters: records.map((record) => ({
        id: record.id,
        name: record.name,
        raceId: null,
        groupIds: [],
        summary: record.summary,
        recordPath: `characters/records/${record.id}.json`,
        updatedAt: NOW,
      })),
    }),
    ...Object.fromEntries(
      records.map((record) => [
        `characters/records/${record.id}.json`,
        JSON.stringify({ schemaVersion: 1, ...record }),
      ]),
    ),
  };
}

function factionRecord(overrides: Partial<FactionRecord>): FactionRecord {
  return {
    id: "faction-1",
    name: "青云宗",
    type: "宗门",
    status: "active",
    summary: "",
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function factionFile(factions: readonly FactionRecord[]): string {
  return serializeFactionLibrary({
    schemaVersion: 2,
    factions: [...factions],
  });
}

function itemFile(
  items: readonly { readonly id: string; readonly name: string }[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      categoryId: "uncategorized",
      status: "active",
      tags: [],
      summary: "",
      recordPath: `world/items/records/${item.id}.json`,
      pagePath: `world/items/pages/${item.id}.md`,
      updatedAt: NOW,
    })),
  });
}

function locationFile(
  locations: readonly { readonly id: string; readonly name: string }[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    locations: locations.map((location) => ({
      id: location.id,
      nodeId: "node-root",
      parentLocationId: null,
      name: location.name,
      aliases: [],
      type: "区域",
      status: "planned",
      summary: "",
      appearanceNote: "",
      description: "",
      order: 0,
    })),
  });
}

function chapterFile(chapters: readonly NovelChapterRecord[]): string {
  return serializeNovelChapterIndex({
    ...createEmptyNovelChapterIndex(),
    nextChapterNumber: Math.max(
      ...chapters.map((chapter) => chapter.number),
      0,
    ) + 1,
    chapters: [...chapters],
  });
}

function chapterRecord(id: string): NovelChapterRecord {
  const number = Number(id.replace("chapter-", ""));
  return {
    id,
    number,
    title: `第 ${number} 章`,
    path: `manuscript/chapters/${String(number).padStart(6, "0")}.md`,
    status: "draft",
    directoryId: null,
    order: 0,
    narrativeChapterId: null,
    trackingStatus: "idle",
    lastTrackedAt: null,
    displayNumber: number,
    planningMode: "reference",
  };
}

function timelineWithEvent(
  event: Partial<TimelineEvent>,
): TimelineLibrary {
  const library = createEmptyTimelineLibrary(NOW);
  return {
    ...library,
    events: [
      {
        id: "event-1",
        branchId: "branch-main",
        timeLabel: "第一天",
        sortKey: 1,
        sortOrder: 0,
        endSortKey: null,
        timePrecision: "exact",
        timeExpressions: [],
        periodId: null,
        scope: "story",
        knowledgeScope: "public",
        narrativeOrder: null,
        title: "测试事件",
        kind: "event",
        summary: "",
        description: "",
        characterIds: [],
        locationIds: [],
        chapterIds: [],
        factionIds: [],
        itemIds: [],
        causeEventIds: [],
        stateChanges: [],
        foreshadowings: [],
        tags: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...event,
      },
    ],
  };
}

function timelineFile(library: TimelineLibrary): string {
  return serializeTimelineLibrary(library);
}

function storageWith(files: Record<string, string>): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "novel.json": JSON.stringify({
      schemaVersion: 1,
      projectId: "novel-test",
      workbenchId: "io.myagents.novel",
      projectName: "test-novel-01",
      title: "测试小说",
      genres: ["玄幻"],
      status: "planning",
      language: "zh-CN",
      createdAt: NOW,
      updatedAt: NOW,
    }),
    ...files,
  });
}

describe("validateTimelineCrossReferences", () => {
  it("拒绝关联不存在角色的时间线事件", async () => {
    const storage = storageWith({});
    const library = timelineWithEvent({ characterIds: ["char-missing"] });
    await expect(
      validateTimelineCrossReferences(storage, library),
    ).rejects.toThrow(/关联了不存在的角色：char-missing/);
  });

  it("拒绝关联不存在势力/物品/地点/正文章节的事件", async () => {
    const storage = storageWith({
      ...characterFiles([
        { id: "char-1", name: "张三" },
      ]),
    });
    const library = timelineWithEvent({
      factionIds: ["faction-missing"],
      itemIds: ["item-missing"],
      locationIds: ["loc-missing"],
      chapterIds: ["chapter-999999"],
    });
    await expect(
      validateTimelineCrossReferences(storage, library),
    ).rejects.toThrow(/存在失效的关联/);
  });

  it("全部引用存在时保存通过", async () => {
    const storage = storageWith({
      ...characterFiles([
        { id: "char-1", name: "张三" },
      ]),
      "world/factions/index.json": factionFile([factionRecord({})]),
      "world/items/index.json": itemFile([{ id: "item-1", name: "剑" }]),
      "world/locations/index.json": locationFile([{ id: "loc-1", name: "山门" }]),
      "manuscript/index.json": chapterFile([chapterRecord("chapter-000001")]),
    });
    const library = timelineWithEvent({
      characterIds: ["char-1"],
      factionIds: ["faction-1"],
      itemIds: ["item-1"],
      locationIds: ["loc-1"],
      chapterIds: ["chapter-000001"],
    });
    await expect(
      validateTimelineCrossReferences(storage, library),
    ).resolves.toBeUndefined();
  });

  it("伏笔埋设章节不存在时拒绝保存", async () => {
    const storage = storageWith({});
    const library = timelineWithEvent({
      foreshadowings: [
        {
          id: "foreshadow-1",
          title: "伏笔",
          status: "planted",
          plantedChapterId: "chapter-000002",
          payoffEventId: null,
          note: "",
        },
      ],
    });
    await expect(
      validateTimelineCrossReferences(storage, library),
    ).rejects.toThrow(/埋设章节不存在/);
  });

  it("没有任何设定库文件的空项目可正常保存", async () => {
    const storage = storageWith({});
    const library = timelineWithEvent({});
    await expect(
      validateTimelineCrossReferences(storage, library),
    ).resolves.toBeUndefined();
  });
});

describe("validateFactionCrossReferences", () => {
  it("拒绝关联不存在角色的势力成员", async () => {
    const storage = storageWith({});
    const member: FactionMember = {
      id: "member-1",
      name: "首席弟子",
      characterId: "char-missing",
      role: "弟子",
      count: 1,
      description: "",
    };
    const library: FactionLibrary = {
      schemaVersion: 2,
      factions: [factionRecord({ members: [member] })],
    };
    await expect(
      validateFactionCrossReferences(storage, library),
    ).rejects.toThrow(/成员“首席弟子”关联了不存在的角色/);
  });

  it("拒绝关联不存在物品的势力资源", async () => {
    const storage = storageWith({});
    const library: FactionLibrary = {
      schemaVersion: 2,
      factions: [
        factionRecord({
          resources: [
            {
              id: "resource-1",
              name: "灵石矿脉",
              kind: "资源",
              control: "",
              controlLevel: "owned",
              worldNodeId: null,
              itemId: "item-missing",
              competingFactionIds: [],
              history: [],
              description: "",
            },
          ],
        }),
      ],
    };
    await expect(
      validateFactionCrossReferences(storage, library),
    ).rejects.toThrow(/资源“灵石矿脉”关联了不存在的物品/);
  });

  it("角色链接指向不存在的角色时拒绝保存", async () => {
    const storage = storageWith({});
    const library: FactionLibrary = {
      schemaVersion: 2,
      factions: [
        factionRecord({
          links: [
            {
              id: "link-1",
              kind: "character",
              targetId: "char-missing",
              label: "掌门",
              description: "",
            },
          ],
        }),
      ],
    };
    await expect(
      validateFactionCrossReferences(storage, library),
    ).rejects.toThrow(/链接“掌门”关联了不存在的角色/);
  });
});

describe("findInboundReferences", () => {
  it("投影可用时通过反向引用查询返回删除保护命中", async () => {
    const projection = new NovelMemoryProjection([], [{
      fromKind: "event",
      fromId: "event-1",
      toKind: "faction",
      toId: "faction-1",
      field: "关联势力",
    }]);
    const hits = await findInboundReferences(
      storageWith({}),
      "faction",
      "faction-1",
      projection,
    );
    expect(hits).toEqual([{ library: "时间线", location: "时间线事件“event-1”的关联势力" }]);
  });

  it("投影不可用时保留文件扫描路径", async () => {
    const storage = storageWith({
      "timeline/index.json": timelineFile(
        timelineWithEvent({ factionIds: ["faction-1"] }),
      ),
    });
    const hits = await findInboundReferences(
      storage,
      "faction",
      "faction-1",
      new NovelMemoryProjection([], [], false),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("时间线");
  });

  it("势力被时间线事件引用时命中", async () => {
    const storage = storageWith({
      "timeline/index.json": timelineFile(
        timelineWithEvent({ factionIds: ["faction-1"] }),
      ),
    });
    const hits = await findInboundReferences(storage, "faction", "faction-1");
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("时间线");
  });

  it("角色被势力成员引用时命中", async () => {
    const storage = storageWith({
      "world/factions/index.json": factionFile([
        factionRecord({
          members: [
            {
              id: "member-1",
              name: "首席弟子",
              characterId: "char-1",
              role: "弟子",
              count: 1,
              description: "",
            },
          ],
        }),
      ]),
    });
    const hits = await findInboundReferences(storage, "character", "char-1");
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("势力组织");
  });

  it("物品被角色物品栏引用时命中", async () => {
    const storage = storageWith({
      ...characterFiles([
        { id: "char-1", name: "张三", inventory: [{ itemId: "item-1" }] },
      ]),
    });
    const hits = await findInboundReferences(storage, "item", "item-1");
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("人物库");
  });

  it("物品被修炼体系深层 itemIds 引用时命中", async () => {
    const storage = storageWith({
      "world/cultivation-ecology.json": JSON.stringify({
        schemaVersion: 6,
        updatedAt: NOW,
        worldOrigins: [],
        crossSystemRelations: [],
        systems: [
          {
            id: "sys-1",
            name: "玄门正宗",
            summary: "",
            kind: "修仙",
            terminology: { energy: "", stage: "", method: "", ability: "" },
            projection: { originIds: [], manifestationIds: [] },
            theoryModel: { statement: "", summary: "", nodeTypes: [], invariants: [], validationRules: [], nodeCatalog: [] },
            progressionTracks: [],
            resources: [],
            methods: [
              {
                id: "method-1",
                name: "太虚吐纳",
                summary: "",
                kind: "",
                theoryReference: "",
                script: [],
                formula: "",
                coverage: { startLevelId: null, stableLimitId: null, theoryLimitId: null, absoluteLimitId: null },
                effects: { speed: "", conversion: "", quality: "", breakthrough: "", loss: "" },
                compatibility: [],
                risks: [],
                itemIds: ["item-1"],
                operationTopologies: [],
                courses: [],
              },
            ],
            abilities: [],
            formations: [],
            foundations: [],
            transitions: [],
            constraints: [],
            audit: [],
          },
        ],
      }),
    });
    const hits = await findInboundReferences(storage, "item", "item-1");
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("修炼体系");
    expect(hits[0].location).toContain("太虚吐纳");
  });

  it("修炼体系事实源损坏时按 fail-closed 阻止删除", async () => {
    const storage = storageWith({
      "world/cultivation-ecology.json": "{ not valid json",
    });
    const hits = await findInboundReferences(storage, "item", "item-1");
    expect(hits).toHaveLength(1);
    expect(hits[0].library).toBe("修炼体系");
    expect(hits[0].location).toContain("无法解析");
  });

  it("无引用时返回空数组", async () => {
    const storage = storageWith({});
    const hits = await findInboundReferences(storage, "character", "char-1");
    expect(hits).toEqual([]);
  });
});
