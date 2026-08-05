import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../../../shared/workbenches/novel/characterLibrarySchema";

import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createNovelMapRepository } from "./mapRepository";
import {
  createEmptyNarrativeEngineering,
  serializeNarrativeEngineering,
} from "./narrativeEngineeringSchema";
import { createNovelProjectInitialization } from "./projectInitialization";
import { createNovelRepository } from "./repository";
import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";
import { MAIN_TIMELINE_BRANCH_ID, createEmptyTimelineLibrary, serializeTimelineLibrary } from "./timelineLibrarySchema";
import { NovelMemoryStorage } from "./testStorage";
import { buildWorldSimulationBaseline } from "./worldSimulationProjection";
import { createDefaultWorldSimulationScenario } from "./worldSimulationV2Schema";

const createdAt = "2026-08-03T00:00:00.000Z";

function initializedStorage() {
  const initialization = createNovelProjectInitialization({
    projectId: "project-1",
    projectName: "xiantu",
    title: "仙途",
    genres: ["玄幻"],
    targetWordCountMin: 100_000,
    targetWordCountMax: 200_000,
    chapterWordCount: 3_000,
    createdAt,
  });
  return new NovelMemoryStorage(Object.fromEntries(initialization.files.map((file) => [file.path, file.content])));
}

function character(
  id: string,
  name: string,
  hometown = "",
): CharacterRecord {
  return {
    id,
    name,
    status: "在世",
    summary: "",
    currentRealm: "凡人",
    goals: "",
    motivation: "",
    alias: "",
    roleWeight: "secondary",
    archetype: "",
    alignment: "",
    identities: [],
    age: "20",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    cultivationProfile: {
      systemId: null,
      trackId: null,
      levelId: null,
      methodIds: [],
      abilityIds: [],
      resourceBalances: {},
      activeConstraintIds: [],
      breakthroughHistory: [],
    },
    gender: "",
    raceId: "",
    soulId: "",
    groupIds: [],
    hometown,
    appearance: "",
    personality: "",
    values: "",
    strengths: "",
    weaknesses: "",
    fears: "",
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
  };
}

function timelineEvent(id: string, sortKey: number, chapterIds: readonly string[] = []) {
  return {
    id,
    branchId: MAIN_TIMELINE_BRANCH_ID,
    timeLabel: `第${sortKey}日`,
    sortKey,
    sortOrder: sortKey,
    endSortKey: null,
    timePrecision: "exact" as const,
    timeExpressions: [],
    periodId: null,
    scope: "story" as const,
    knowledgeScope: "public" as const,
    narrativeOrder: null,
    title: id === "fact-1" ? "主角醒来" : "未来战争",
    kind: "event" as const,
    summary: id === "fact-1" ? "已发生事实" : "未来计划",
    description: "时间线测试事件",
    characterIds: [],
    locationIds: [],
    chapterIds: [...chapterIds],
    factionIds: [],
    itemIds: [],
    causeEventIds: [],
    stateChanges: [],
    foreshadowings: [],
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };
}

async function writeTimeline(storage: ReturnType<typeof initializedStorage>, events: readonly ReturnType<typeof timelineEvent>[], factsThroughEventId: string | null) {
  const current = createEmptyTimelineLibrary(createdAt);
  storage.setExternalText("timeline/index.json", serializeTimelineLibrary({
    ...current,
    factsThroughEventId,
    events: [...events],
  }));
}

describe("buildWorldSimulationBaseline", () => {
  it("blocks a facts-anchor run when no fact endpoint is configured", async () => {
    const storage = initializedStorage();

    const baseline = await buildWorldSimulationBaseline(
      storage,
      createDefaultWorldSimulationScenario(),
    );

    expect(baseline.diagnostics).toContainEqual(expect.objectContaining({
      id: "timeline-facts-anchor-missing",
      severity: "blocking",
    }));
  });

  it("keeps a custom-start run explicit about the absence of facts", async () => {
    const storage = initializedStorage();
    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      start: { mode: "custom" as const, sortKey: "0" },
    };

    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.diagnostics).toContainEqual(expect.objectContaining({
      id: "timeline-facts-anchor-missing",
      severity: "warning",
    }));
  });

  it("blocks a run with no actionable character or faction even at a custom start", async () => {
    const storage = initializedStorage();
    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      start: { mode: "custom" as const, sortKey: "0" },
    };

    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.diagnostics).toContainEqual(expect.objectContaining({
      id: "actionable-subjects-missing",
      severity: "blocking",
    }));
  });

  it("includes descendants in the actionable-subject preflight scope", async () => {
    const storage = initializedStorage();
    const settingRepository = createNovelSettingLibraryRepository(storage);
    const settings = await settingRepository.load("仙途");
    const root = settings.spatialTree.nodes[0]!;
    await settingRepository.saveSpatialTree(settings, {
      ...settings.spatialTree,
      nodes: [
        ...settings.spatialTree.nodes,
        {
          id: "qinyun-city",
          parentId: root.id,
          name: "青云城",
          typeId: "planet",
          order: 0,
        },
      ],
    });
    const characterRepository = createNovelCharacterLibraryRepository(storage);
    const characters = await characterRepository.load();
    await characterRepository.saveCharacter(
      characters,
      character("hero-in-child", "沈砚", "青云城"),
    );

    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      start: { mode: "custom" as const, sortKey: "0" },
      scope: {
        ...createDefaultWorldSimulationScenario().scope,
        regionIds: [root.id],
        includeDescendants: true,
      },
    };
    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.characters.find((item) => item.id === "hero-in-child")?.locationId).toBe("qinyun-city");
    expect(baseline.diagnostics).not.toContainEqual(
      expect.objectContaining({ id: "actionable-subjects-missing" }),
    );
  });

  it("blocks a strict run when its selected narrative constraint was deleted", async () => {
    const storage = initializedStorage();
    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      start: { mode: "custom" as const, sortKey: "0" },
      narrativeContext: {
        ...createDefaultWorldSimulationScenario().narrativeContext,
        mode: "strict" as const,
        selectedPlotLineIds: ["deleted-line"],
      },
    };

    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "narrative-selection-missing-plot-line-deleted-line",
        severity: "blocking",
      }),
    );
  });

  it("only exposes events through factsThroughEventId as actual facts", async () => {
    const storage = initializedStorage();
    await writeTimeline(storage, [timelineEvent("fact-1", 1), timelineEvent("future-1", 100)], "fact-1");
    const scenario = createDefaultWorldSimulationScenario();

    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.factsThroughEventId).toBe("fact-1");
    expect(baseline.timelineFacts.map((event) => event.id)).toEqual(["fact-1"]);
    expect(baseline.timelinePlans.map((event) => event.id)).toEqual(["future-1"]);
    expect(baseline.timelinePlans[0]?.authority).toBe("planned");
    expect(baseline.anchor.sortKey).toBe("1");
  });

  it("does not leak later facts when a custom start is earlier than the fact anchor", async () => {
    const storage = initializedStorage();
    await writeTimeline(storage, [timelineEvent("fact-1", 10), timelineEvent("future-1", 100)], "fact-1");
    const scenario = { ...createDefaultWorldSimulationScenario(), start: { mode: "custom" as const, sortKey: "0" } };

    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(baseline.anchor.sortKey).toBe("0");
    expect(baseline.timelineFacts).toHaveLength(0);
    expect(baseline.timelinePlans.map((event) => event.id)).toEqual(["fact-1", "future-1"]);
  });

  it("supports before and after chapter anchors without rewriting the fact source", async () => {
    const storage = initializedStorage();
    const project = await createNovelRepository(storage).load();
    const chapter = await createNovelRepository(storage).createChapter(project);
    await writeTimeline(storage, [timelineEvent("chapter-before", 10, [chapter.id]), timelineEvent("chapter-after", 20, [chapter.id])], "chapter-after");

    const base = createDefaultWorldSimulationScenario();
    const before = await buildWorldSimulationBaseline(storage, { ...base, chapterContext: { mode: "before", chapterId: chapter.id } });
    const after = await buildWorldSimulationBaseline(storage, { ...base, chapterContext: { mode: "after", chapterId: chapter.id } });

    expect(before.timelineFacts).toHaveLength(0);
    expect(before.anchor.sortKey).toBe("9");
    expect(after.timelineFacts.map((event) => event.id)).toEqual(["chapter-before", "chapter-after"]);
    expect(after.anchor.sortKey).toBe("20");
    expect(after.timelineFacts.every((event) => event.authority === "actual")).toBe(true);
  });

  it("does not leak facts that occur after the selected chapter into an after-chapter baseline", async () => {
    const storage = initializedStorage();
    const project = await createNovelRepository(storage).load();
    const chapter = await createNovelRepository(storage).createChapter(project);
    await writeTimeline(
      storage,
      [
        timelineEvent("chapter-early", 10, [chapter.id]),
        timelineEvent("later-fact", 20),
      ],
      "later-fact",
    );

    const base = createDefaultWorldSimulationScenario();
    const after = await buildWorldSimulationBaseline(storage, {
      ...base,
      chapterContext: { mode: "after", chapterId: chapter.id },
    });
    const branch = await buildWorldSimulationBaseline(storage, {
      ...base,
      chapterContext: { mode: "branch", chapterId: chapter.id },
    });

    expect(after.anchor.sortKey).toBe("10");
    expect(after.factsThroughEventId).toBe("chapter-early");
    expect(after.timelineFacts.map((event) => event.id)).toEqual([
      "chapter-early",
    ]);
    expect(after.timelinePlans.map((event) => event.id)).toEqual([
      "later-fact",
    ]);
    expect(after.baselineId).not.toBe(branch.baselineId);
    expect(branch.anchor.sortKey).toBe("9");
    expect(branch.timelineFacts).toHaveLength(0);
    expect(branch.timelinePlans.map((event) => event.id)).toEqual([
      "chapter-early",
      "later-fact",
    ]);
  });

  it("includes participating chapter sources in the baseline revision", async () => {
    const storage = initializedStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const created = await repository.createChapter(project);
    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      chapterContext: { mode: "after" as const, chapterId: created.id },
    };
    await writeTimeline(
      storage,
      [timelineEvent("chapter-fact", 10, [created.id])],
      "chapter-fact",
    );

    const first = await buildWorldSimulationBaseline(storage, scenario);
    const reloaded = await repository.load();
    const chapter = reloaded.chapters.find((item) => item.id === created.id)!;
    await repository.saveChapter(
      chapter,
      "这是更新后的章节正文。",
      chapter.content,
    );
    const second = await buildWorldSimulationBaseline(storage, scenario);

    expect(first.sourceRefs.some((ref) => ref.path === chapter.path)).toBe(true);
    expect(first.sourceRefs.map((ref) => ref.path)).toEqual(
      expect.arrayContaining([
        "manuscript/index.json",
        "world/setting-library/meta.json",
        "world/setting-library/settings.json",
        "world/items/meta.json",
        "world/maps/index.json",
      ]),
    );
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(second.baselineId).not.toBe(first.baselineId);
  });

  it("resolves narrative plans to characters without treating narrative ids as world entities", async () => {
    const storage = initializedStorage();
    const characterRepository = createNovelCharacterLibraryRepository(storage);
    const characters = await characterRepository.load();
    await characterRepository.saveCharacter(
      characters,
      character("hero-1", "沈砚"),
    );
    const narrative = createEmptyNarrativeEngineering(createdAt);
    storage.setExternalText(
      "narrative/index.json",
      serializeNarrativeEngineering({
        ...narrative,
        lines: [
          {
            id: "hero-line",
            title: "主线",
            kind: "main",
            storyRole: "a",
            status: "active",
            color: "#123456",
            premise: "沈砚必须活下去。",
            protagonistCharacterId: "hero-1",
            keyNodes: [
              {
                id: "line-node",
                title: "开端",
                content: "踏入险境。",
                order: 0,
                locations: [
                  {
                    id: "line-node-location",
                    chapterId: "chapter-plan-1",
                    sectionId: "section-plan-1",
                  },
                ],
              },
            ],
            content: "主线护栏",
          },
        ],
        arcs: [
          {
            id: "hero-arc",
            title: "人物弧",
            kind: "character",
            characterId: "hero-1",
            characterArcStageId: null,
            characterArcStageTitle: "",
            lineIds: ["hero-line"],
            keyNodes: [],
            content: "人物成长",
          },
        ],
        directories: [
          {
            id: "volume-1",
            parentId: null,
            kind: "volume",
            title: "第一卷",
            description: "卷纲",
            status: "planned",
            order: 0,
          },
        ],
        chapters: [
          {
            id: "chapter-plan-1",
            directoryId: "volume-1",
            manuscriptChapterId: null,
            title: "第一章计划",
            description: "章节约束",
            status: "planned",
            order: 0,
            updatedAt: createdAt,
            lineIds: ["hero-line"],
            arcIds: ["hero-arc"],
            sections: [
              {
                id: "section-plan-1",
                order: 0,
                title: "开篇",
                description: "以沈砚视角展开。",
                povCharacterId: "hero-1",
                lineIds: ["hero-line"],
                arcIds: ["hero-arc"],
                paragraphs: [],
              },
            ],
          },
        ],
      }),
    );

    const scenario = {
      ...createDefaultWorldSimulationScenario(),
      narrativeContext: {
        ...createDefaultWorldSimulationScenario().narrativeContext,
        useDirectoryOutline: true,
        useChapterPlans: true,
      },
    };
    const baseline = await buildWorldSimulationBaseline(storage, scenario);

    expect(
      baseline.narrativeConstraints.map((constraint) => [
        constraint.id,
        constraint.entityIds,
      ]),
    ).toEqual([
      ["plot-line-hero-line", ["hero-1"]],
      ["story-arc-hero-arc", ["hero-1"]],
      ["outline-volume-1", ["hero-1"]],
      ["chapter-plan-chapter-plan-1", ["hero-1"]],
    ]);
  });

  it("projects parsed setting entries into regional rules and summaries", async () => {
    const storage = initializedStorage();
    const settingRepository = createNovelSettingLibraryRepository(storage);
    const settings = await settingRepository.load("仙途");
    const created = await settingRepository.createCustomSetting(settings, {
      id: "law-setting",
      nodeId: settings.spatialTree.nodes[0]!.id,
      name: "天道规则",
      group: "世界法则",
      skeleton: "任何突破都要付出代价。",
    });
    const completed = await settingRepository.updateSettingStatus(
      created.library,
      "law-setting",
      "completed",
    );
    await settingRepository.saveEntries(created.page, [
      {
        id: "law-entry",
        name: "突破代价",
        category: "修炼限制",
        aliases: ["天劫"],
        definition: "突破失败会损耗寿元。",
      },
    ]);

    const baseline = await buildWorldSimulationBaseline(
      storage,
      createDefaultWorldSimulationScenario(),
    );
    const rule = baseline.rules.find(
      (candidate) => candidate.id === "setting-rule-law-setting",
    )!;
    const rootRegion = baseline.regions.find(
      (region) => region.id === completed.spatialTree.nodes[0]!.id,
    )!;
    const setting = completed.settingsIndex.settings.find(
      (entry) => entry.id === "law-setting",
    )!;

    expect(rule.description).toContain("突破失败会损耗寿元");
    expect(rule.sourceRefs.map((ref) => ref.path)).toEqual(
      expect.arrayContaining([
        setting.pagePath,
        setting.entriesPath,
      ]),
    );
    expect(rootRegion.summary).toContain("突破失败会损耗寿元");
  });

  it("reports unreadable setting, map and item records instead of silently skipping them", async () => {
    const storage = initializedStorage();
    const settingRepository = createNovelSettingLibraryRepository(storage);
    const settings = await settingRepository.load("仙途");
    const savedSetting = await settingRepository.createCustomSetting(settings, {
      id: "broken-setting",
      nodeId: settings.spatialTree.nodes[0]!.id,
      name: "残缺设定",
      group: "世界规则",
      skeleton: "规则正文",
    });
    const setting = savedSetting.library.settingsIndex.settings.find(
      (entry) => entry.id === "broken-setting",
    )!;
    await storage.remove(setting.pagePath);
    await storage.remove(setting.entriesPath);

    const mapRepository = createNovelMapRepository(storage);
    await mapRepository.createMap({
      id: "broken-map",
      name: "残缺地图",
      projectionType: "continent",
    });
    await storage.remove("world/maps/records/broken-map.json");

    const itemRepository = createNovelItemLibraryRepository(storage);
    const items = await itemRepository.load();
    await itemRepository.createItem(items, {
      id: "broken-item",
      name: "残缺物品",
    });
    await storage.remove("world/items/records/broken-item.json");

    const baseline = await buildWorldSimulationBaseline(
      storage,
      createDefaultWorldSimulationScenario(),
    );

    expect(baseline.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "setting-page-unavailable-broken-setting" }),
        expect.objectContaining({ id: "setting-entries-unavailable-broken-setting" }),
        expect.objectContaining({ id: "map-record-unavailable-broken-map" }),
        expect.objectContaining({ id: "item-record-unavailable-broken-item" }),
      ]),
    );
    expect(baseline.sourceRefs.map((ref) => ref.path)).toEqual(
      expect.arrayContaining([
        setting.pagePath,
        setting.entriesPath,
        "world/maps/records/broken-map.json",
        "world/items/records/broken-item.json",
      ]),
    );
  });
});
