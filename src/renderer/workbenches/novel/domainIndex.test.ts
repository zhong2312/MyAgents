import { describe, expect, it } from "vitest";

import { buildDomainIndex, searchDomainIndex } from "./domainIndex";
import { createEmptyNarrativeEngineering } from "./narrativeEngineeringSchema";
import { NovelMemoryStorage } from "./testStorage";

function storageWithFixture(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "characters/index.json": JSON.stringify({
      schemaVersion: 1,
      characters: [
        {
          id: "char-luoyan",
          name: "洛言",
          alias: "洛公子",
          roleWeight: "main",
          archetype: "",
          alignment: "",
          status: "active",
          summary: "出身寒门的少年剑修",
          identities: ["青山剑派弟子"],
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
          inventory: [],
        },
      ],
    }),
    "world/factions/index.json": JSON.stringify({
      schemaVersion: 2,
      factions: [
        {
          id: "faction-1",
          name: "青云宗",
          type: "宗门",
          status: "active",
          summary: "正道魁首",
          state: { governance: "", military: "", economy: "", publicSupport: "", territorialIntegrity: "" },
          territories: [],
          members: [],
          assets: [],
          resources: [],
          organizationUnits: [],
          relations: [],
          rights: [],
          links: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "world/locations/index.json": JSON.stringify({
      schemaVersion: 1,
      locations: [
        {
          id: "loc-1",
          nodeId: "node-1",
          parentLocationId: null,
          name: "青山",
          aliases: ["大青山"],
          type: "山脉",
          status: "planned",
          summary: "剑派驻地",
          appearanceNote: "",
          description: "",
          order: 0,
        },
      ],
    }),
    "world/setting-library/spatial-tree.json": JSON.stringify({
      schemaVersion: 1,
      nodes: [{ id: "node-1", parentId: null, name: "九州", typeId: "continent", order: 0 }],
    }),
    "narrative/index.json": JSON.stringify(
      {
        ...createEmptyNarrativeEngineering("2026-01-01T00:00:00.000Z"),
        chapters: [
          {
            id: "narrative-chapter-1",
            directoryId: null,
            manuscriptChapterId: null,
            title: "初入江湖",
            description: "洛言下山后的第一场遭遇",
            status: "idea",
            order: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
            lineIds: [],
            arcIds: [],
            sections: [],
          },
        ],
      },
      null,
      2,
    ),
    "timeline/index.json": JSON.stringify({
      schemaVersion: 1,
      calendars: [],
      periods: [],
      views: [],
      storyStartEventId: null,
      factsThroughEventId: null,
      branches: [{ id: "branch-main", name: "主线", parentBranchId: null, forkEventId: null, description: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      events: [
        {
          id: "event-1",
          branchId: "branch-main",
          timeLabel: "第一年",
          sortKey: 1,
          sortOrder: 0,
          endSortKey: null,
          timePrecision: "exact",
          timeExpressions: [],
          periodId: null,
          scope: "story",
          knowledgeScope: "public",
          narrativeOrder: null,
          title: "剑派大比",
          kind: "event",
          summary: "决定外门弟子去留",
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
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "inspiration/index.json": JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          id: "insp-1",
          title: "以剑入道",
          body: "把剑修体系与心性考验结合的点子",
          state: "inbox",
          source: { kind: "manual", label: "随手记录", uri: "" },
          tags: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "research/世界观考据.md": "# 世界观考据\n\n参考设定",
  });
}

describe("buildDomainIndex", () => {
  it("投影全部领域实体并携带定位信息", async () => {
    const index = await buildDomainIndex(storageWithFixture());

    const kinds = index.entities.map((entity) => entity.kind).sort();
    expect(kinds).toContain("character");
    expect(kinds).toContain("faction");
    expect(kinds).toContain("location");
    expect(kinds).toContain("setting");
    expect(kinds).toContain("narrativeChapter");
    expect(kinds).toContain("event");
    expect(kinds).toContain("inspiration");
    expect(kinds).toContain("research");

    const character = index.entities.find(
      (entity) => entity.id === "char-luoyan",
    )!;
    expect(character).toMatchObject({
      name: "洛言",
      route: "characters",
      focus: { characterId: "char-luoyan" },
    });
    expect(character.aliases).toContain("洛公子");

    const research = index.entities.find(
      (entity) => entity.kind === "research",
    )!;
    expect(research.name).toBe("世界观考据");
    expect(research.sourcePath).toBe("research/世界观考据.md");
  });
});

describe("searchDomainIndex", () => {
  it("名称优先、别名与摘要其次，支持类型过滤", async () => {
    const index = await buildDomainIndex(storageWithFixture());

    const byName = searchDomainIndex(index, "青云");
    expect(byName[0]?.kind).toBe("faction");
    expect(byName[0]?.name).toBe("青云宗");

    const byAlias = searchDomainIndex(index, "大青山");
    expect(byAlias[0]?.name).toBe("青山");

    const bySummary = searchDomainIndex(index, "剑修");
    expect(bySummary.some((entity) => entity.name === "洛言")).toBe(true);

    const filtered = searchDomainIndex(index, "剑", ["character", "faction"]);
    expect(filtered.every((entity) => entity.kind !== "event")).toBe(true);
  });

  it("空查询返回全部（按名称排序）且受 limit 限制", async () => {
    const index = await buildDomainIndex(storageWithFixture());
    const all = searchDomainIndex(index, "");
    expect(all.length).toBeGreaterThanOrEqual(8);
    const limited = searchDomainIndex(index, "", undefined, 3);
    expect(limited).toHaveLength(3);
  });
});
