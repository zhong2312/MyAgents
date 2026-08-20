import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../../../shared/workbenches/novel/characterLibrarySchema";

import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./modules/characters";
import {
  createEmptyFactionLibrary,
  type FactionRecord,
} from "./modules/factions/entities/factionLibrarySchema";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "./modules/locations/data-access/locationLibraryRepository";
import { MAIN_TIMELINE_BRANCH_ID } from "./timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import { createEmptyNovelStorage } from "./testStorage";
import {
  createWorldSimulationAdoptionFileProposalRepository,
  createWorldSimulationAdoptionProposal,
  WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY,
} from "./worldSimulationAdoptionV2";
import {
  createWorldSimulationRun,
  getActiveSimulationBranch,
} from "./worldSimulationEngineV2";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  createDefaultWorldSimulationScenario,
  type CharacterProjection,
  type SimulationEvent,
  type WorldSimulationBaseline,
  type WorldSimulationRun,
} from "./worldSimulationV2Schema";

const now = "2026-08-03T00:00:00.000Z";
const sourceRefs = [
  {
    path: "fixture.json",
    sourceHash: "sha256:fixture",
    authority: "canon" as const,
  },
];

function character(
  id: string,
  name: string,
  itemId: string | null,
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
    hometown: "",
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
    inventory: itemId
      ? [
          {
            id: `inventory-${itemId}`,
            itemId,
            name: "镇界印",
            quantity: 1,
            unit: "件",
            description: "原持有者",
          },
        ]
      : [],
  };
}

function faction(): FactionRecord {
  return {
    id: "faction-1",
    name: "北境盟",
    type: "联盟",
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
    createdAt: now,
    updatedAt: now,
  };
}

function characterProjection(
  id: string,
  name: string,
  itemIds: readonly string[],
): CharacterProjection {
  return {
    id,
    name,
    summary: "",
    status: "在世",
    locationId: null,
    factionIds: [],
    goals: [],
    personality: [],
    values: [],
    strengths: [],
    weaknesses: [],
    fears: [],
    motivation: [],
    innerConflict: [],
    relations: [],
    cultivation: {
      systemId: null,
      trackId: null,
      levelId: null,
      levelName: "凡人",
      levelOrder: 0,
      methodIds: [],
      abilityIds: [],
      resourceBalances: {},
      activeConstraintIds: [],
    },
    ageYears: 20,
    lifespanYears: null,
    lifespanLossYears: 0,
    inventoryItemIds: itemIds,
    knowledge: [],
    sourceRefs,
  };
}

function transferEvent(
  id: string,
  sequence: number,
  ownerType: "character" | "faction" | null,
  ownerId: string | null,
): SimulationEvent {
  return {
    id,
    sequence,
    time: {
      calendarId: "novel-calendar",
      sortKey: String(sequence),
      precision: "exact",
      displayText: `第 ${sequence} 日`,
    },
    scale: "day",
    kind: "character-action",
    title: "镇界印易主",
    summary: "镇界印的持有关系发生变化。",
    characterIds: ownerType === "character" && ownerId ? [ownerId] : [],
    factionIds: ownerType === "faction" && ownerId ? [ownerId] : [],
    regionIds: [],
    itemIds: ["item-1"],
    causeEventIds: [],
    evidence: [],
    commands: [
      {
        type: "item.transfer",
        itemId: "item-1",
        ownerType,
        ownerId,
        locationId: null,
        status: "传承",
      },
    ],
    narrativeConstraintIds: [],
    generatedBy: "kernel",
    confidence: 1,
  };
}

function futureTimelinePlan(id: string, sortKey: number) {
  return {
    id,
    branchId: MAIN_TIMELINE_BRANCH_ID,
    timeLabel: `第 ${sortKey} 日`,
    sortKey,
    worldSortKey: String(sortKey),
    sortOrder: sortKey,
    endSortKey: null,
    timePrecision: "exact" as const,
    timeExpressions: [],
    periodId: null,
    scope: "story" as const,
    knowledgeScope: "public" as const,
    narrativeOrder: null,
    title: "既有未来计划",
    kind: "event" as const,
    summary: "尚未发生的既有计划",
    description: "用于校验事实采纳不得跨越计划。",
    characterIds: [],
    locationIds: [],
    chapterIds: [],
    factionIds: [],
    itemIds: [],
    causeEventIds: [],
    stateChanges: [],
    foreshadowings: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function seedRun(): Promise<{
  storage: ReturnType<typeof createEmptyNovelStorage>;
  run: WorldSimulationRun;
}> {
  const storage = createEmptyNovelStorage();
  const characterRepository = createNovelCharacterLibraryRepository(storage);
  const characterLibrary = await characterRepository.load();
  let savedCharacters = characterLibrary;
  for (const record of [
    character("character-1", "沈砚", "item-1"),
    character("character-2", "陆昭", null),
  ]) {
    savedCharacters = await characterRepository.saveCharacter(
      savedCharacters,
      record,
    );
  }
  const itemRepository = createNovelItemLibraryRepository(storage);
  const itemLibrary = await itemRepository.load();
  await itemRepository.createItem(itemLibrary, {
    id: "item-1",
    name: "镇界印",
    categoryId: "key-items",
    summary: "能够稳定界壁的古印。",
  });
  const factionRepository = createNovelFactionLibraryRepository(storage);
  const factionLibrary = await factionRepository.load();
  await factionRepository.save(factionLibrary, {
    ...createEmptyFactionLibrary(),
    factions: [faction()],
  });

  const scenario = {
    ...createDefaultWorldSimulationScenario(),
    id: "scenario-1",
    scope: { ...createDefaultWorldSimulationScenario().scope, regionIds: [] },
  };
  const baseline: WorldSimulationBaseline = {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    baselineId: "baseline-1",
    projectId: "novel-test",
    projectTitle: "测试小说",
    sourceRevision: "sha256:baseline",
    compiledAt: now,
    anchor: {
      calendarId: scenario.calendar.id,
      sortKey: "0",
      precision: "exact",
      displayText: "第 0 日",
    },
    factsThroughEventId: null,
    calendar: scenario.calendar,
    characters: [
      characterProjection("character-1", "沈砚", ["item-1"]),
      characterProjection("character-2", "陆昭", []),
    ],
    factions: [
      {
        id: "faction-1",
        name: "北境盟",
        type: "联盟",
        status: "active",
        summary: "",
        goals: [],
        territoryIds: [],
        leaderCharacterIds: [],
        memberCharacterIds: [],
        resources: [],
        relations: [],
        stateText: {
          governance: "",
          military: "",
          economy: "",
          publicSupport: "",
          territorialIntegrity: "",
        },
        sourceRefs,
      },
    ],
    regions: [],
    items: [
      {
        id: "item-1",
        name: "镇界印",
        category: "关键道具",
        status: "active",
        summary: "能够稳定界壁的古印。",
        ownerType: "character",
        ownerId: "character-1",
        locationId: null,
        capabilities: [],
        sourceRefs,
      },
    ],
    cultivationSystems: [],
    rules: [],
    timelineFacts: [],
    timelinePlans: [],
    narrativeConstraints: [],
    chapters: [],
    diagnostics: [],
    sourceRefs,
  };
  const initial = createWorldSimulationRun(baseline, scenario, now);
  const branch = getActiveSimulationBranch(initial);
  return {
    storage,
    run: {
      ...initial,
      branches: [
        {
          ...branch,
          ledger: [
            transferEvent("event-to-faction", 1, "faction", "faction-1"),
            transferEvent("event-to-character", 2, "character", "character-2"),
          ],
        },
      ],
    },
  };
}

describe("WorldSimulationAdoptionV2", () => {
  it("按事件顺序把物品从人物经势力转移至另一人物", async () => {
    const { storage, run } = await seedRun();
    const proposalId = await createWorldSimulationAdoptionProposal(
      storage,
      run,
      ["event-to-faction", "event-to-character"],
      "actual",
    );
    const repository =
      createWorldSimulationAdoptionFileProposalRepository(storage);
    const listed = await repository.list();
    const proposal = listed.proposals.find(
      (item) => item.manifest.proposalId === proposalId,
    );
    expect(proposal?.changes.map((change) => change.targetPath)).toEqual([
      "characters/records/character-1.json",
      "characters/records/character-2.json",
      "world/items/records/item-1.json",
      "world/factions/index.json",
      "timeline/index.json",
    ]);

    await repository.apply(
      proposalId,
      proposal?.changes.map((change) => change.id) ?? [],
      "测试小说",
    );

    const characterRepository = createNovelCharacterLibraryRepository(storage);
    const characterLibrary = await characterRepository.load();
    const characters = await loadCharacterRecords(
      characterRepository,
      characterLibrary,
    );
    const factions = await createNovelFactionLibraryRepository(storage).load();
    const items = await createNovelItemLibraryRepository(storage).load();
    const itemEntry = items.index.items.find((item) => item.id === "item-1")!;
    const item =
      await createNovelItemLibraryRepository(storage).loadItem(itemEntry);
    expect(
      characters.find((item) => item.id === "character-1")?.inventory,
    ).toEqual([]);
    expect(
      characters.find((item) => item.id === "character-2")?.inventory,
    ).toMatchObject([{ itemId: "item-1", name: "镇界印", quantity: 1 }]);
    expect(factions.library.factions[0]?.resources).toEqual([]);
    expect(item.record.status).toBe("active");
  });

  it("将人物关系与势力外交关系采纳回正式资料契约", async () => {
    const { storage, run } = await seedRun();
    const characterRepository = createNovelCharacterLibraryRepository(storage);
    const characterLibrary = await characterRepository.load();
    const characterEntry = characterLibrary.index.characters.find(
      (entry) => entry.id === "character-1",
    )!;
    const loadedCharacter =
      await characterRepository.loadCharacter(characterEntry);
    await characterRepository.saveCharacter(characterLibrary, {
      ...loadedCharacter.record,
      relations: [
        {
          targetId: "character-2",
          type: "同门",
          tone: "neutral",
          summary: "原有关系",
        },
      ],
    });

    const factionRepository = createNovelFactionLibraryRepository(storage);
    const factionLibrary = await factionRepository.load();
    const factionTwo: FactionRecord = {
      ...faction(),
      id: "faction-2",
      name: "南境盟",
    };
    await factionRepository.save(factionLibrary, {
      ...factionLibrary.library,
      factions: [
        {
          ...factionLibrary.library.factions[0]!,
          relations: [
            {
              id: "relation-faction-2",
              targetFactionId: "faction-2",
              kind: "hostile",
              direction: "outbound",
              status: "active",
              startedAt: "第 0 日",
              endedAt: "",
              description: "原有敌对关系",
            },
          ],
        },
        factionTwo,
      ],
    });

    const event: SimulationEvent = {
      ...transferEvent("event-relations", 3, null, null),
      kind: "diplomacy",
      title: "关系缓和",
      summary: "人物与势力的关系发生变化。",
      characterIds: ["character-1"],
      factionIds: ["faction-1"],
      itemIds: [],
      commands: [
        {
          type: "character.relation",
          characterId: "character-1",
          targetCharacterId: "character-2",
          affinityDelta: 20,
          trustDelta: 20,
          status: "active",
        },
        {
          type: "faction.relation",
          factionId: "faction-1",
          targetFactionId: "faction-2",
          sentimentDelta: 10,
          status: "suspended",
        },
      ],
    };
    const runWithEvent: WorldSimulationRun = {
      ...run,
      branches: run.branches.map((branch) => ({
        ...branch,
        ledger: [...branch.ledger, event],
      })),
    };
    const proposalId = await createWorldSimulationAdoptionProposal(
      storage,
      runWithEvent,
      [event.id],
      "actual",
    );
    const proposalRepository =
      createWorldSimulationAdoptionFileProposalRepository(storage);
    const proposal = (await proposalRepository.list()).proposals.find(
      (item) => item.manifest.proposalId === proposalId,
    )!;
    await proposalRepository.apply(
      proposalId,
      proposal.changes.map((change) => change.id),
      "测试小说",
    );

    const savedCharacterLibrary = await characterRepository.load();
    const savedCharacters = await loadCharacterRecords(
      characterRepository,
      savedCharacterLibrary,
    );
    const savedCharacter = savedCharacters.find(
      (item) => item.id === "character-1",
    )!;
    expect(savedCharacter.relations).toContainEqual(
      expect.objectContaining({
        targetId: "character-2",
        type: "同门",
        tone: "positive",
      }),
    );
    expect(savedCharacter.relations[0]?.summary).toContain("信任 20");

    const savedFactions = await factionRepository.load();
    const savedFaction = savedFactions.library.factions.find(
      (item) => item.id === "faction-1",
    )!;
    expect(savedFaction.relations).toContainEqual(
      expect.objectContaining({
        targetFactionId: "faction-2",
        kind: "hostile",
        status: "suspended",
      }),
    );
    expect(savedFaction.relations[0]?.description).toContain("外交态度 10");
  });

  it("将未来计划或作者秘密采纳时不预先修改当前人物和势力状态", async () => {
    const { storage, run } = await seedRun();
    const proposalId = await createWorldSimulationAdoptionProposal(
      storage,
      run,
      ["event-to-faction"],
      "planned",
    );
    const repository =
      createWorldSimulationAdoptionFileProposalRepository(storage);
    const proposal = (await repository.list()).proposals.find(
      (item) => item.manifest.proposalId === proposalId,
    )!;

    expect(proposal.changes.map((change) => change.targetPath)).toEqual([
      "timeline/index.json",
    ]);
    await repository.apply(
      proposalId,
      proposal.changes.map((change) => change.id),
      "测试小说",
    );

    const characterRepository = createNovelCharacterLibraryRepository(storage);
    const characterLibrary = await characterRepository.load();
    const characters = await loadCharacterRecords(
      characterRepository,
      characterLibrary,
    );
    const factions = await createNovelFactionLibraryRepository(storage).load();
    const timeline = await createNovelTimelineLibraryRepository(storage).load();
    expect(
      characters.find((item) => item.id === "character-1")?.inventory,
    ).toMatchObject([{ itemId: "item-1" }]);
    expect(factions.library.factions[0]?.resources).toEqual([]);
    expect(timeline.library.factsThroughEventId).toBeNull();
  });

  it("拒绝把推演结果采纳为跨越既有未来计划的事实", async () => {
    const { storage, run } = await seedRun();
    const timelineRepository = createNovelTimelineLibraryRepository(storage);
    const current = await timelineRepository.load();
    await timelineRepository.save(current, {
      ...current.library,
      events: [futureTimelinePlan("future-plan", 1)],
    });

    await expect(
      createWorldSimulationAdoptionProposal(
        storage,
        run,
        ["event-to-character"],
        "actual",
      ),
    ).rejects.toThrow("会跨越未来计划");
  });

  it("提案审计保存失败时回滚已写入的正式资料", async () => {
    const { storage, run } = await seedRun();
    const proposalId = await createWorldSimulationAdoptionProposal(
      storage,
      run,
      ["event-to-faction"],
      "planned",
    );
    const proposal = (
      await createWorldSimulationAdoptionFileProposalRepository(storage).list()
    ).proposals[0]!;
    const beforeCharacters = storage.getText("characters/index.json");
    const beforeFactions = storage.getText("world/factions/index.json");
    const beforeTimeline = storage.getText("timeline/index.json");
    storage.failWritePathOnce = `${WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;

    await expect(
      createWorldSimulationAdoptionFileProposalRepository(storage).apply(
        proposalId,
        proposal.changes.map((change) => change.id),
        "测试小说",
      ),
    ).rejects.toThrow("Injected write failure");

    expect(storage.getText("characters/index.json")).toBe(beforeCharacters);
    expect(storage.getText("world/factions/index.json")).toBe(beforeFactions);
    expect(storage.getText("timeline/index.json")).toBe(beforeTimeline);
  });

  it("通过地点目录 Repository 采纳地域过程记录并保留地点层级", async () => {
    const { storage, run } = await seedRun();
    const locationRepository = createNovelLocationLibraryRepository(storage);
    const currentLocations = await locationRepository.load();
    await locationRepository.save(currentLocations, {
      ...currentLocations.index,
      locations: [
        {
          id: "location-1",
          nodeId: "region-1",
          parentLocationId: null,
          name: "北山村",
          aliases: [],
          type: "村落",
          status: "appeared",
          summary: "北山脚下的村落。",
          appearanceNote: "",
          description: "",
          order: 0,
        },
      ],
    });
    const event: SimulationEvent = {
      id: "event-region-metric",
      sequence: 3,
      time: {
        calendarId: "novel-calendar",
        sortKey: "3",
        precision: "exact",
        displayText: "第 3 日",
      },
      scale: "day",
      kind: "world-process",
      title: "北山村生态恢复",
      summary: "北山村周边生态逐步恢复。",
      characterIds: [],
      factionIds: [],
      regionIds: ["region-1"],
      itemIds: [],
      causeEventIds: [],
      evidence: [],
      commands: [
        {
          type: "region.metric",
          regionId: "region-1",
          metric: "ecology",
          delta: 3,
        },
      ],
      narrativeConstraintIds: [],
      generatedBy: "kernel",
      confidence: 1,
    };
    const runWithEvent: WorldSimulationRun = {
      ...run,
      branches: run.branches.map((branch) => ({
        ...branch,
        ledger: [...branch.ledger, event],
      })),
    };
    const proposalId = await createWorldSimulationAdoptionProposal(
      storage,
      runWithEvent,
      [event.id],
      "actual",
    );
    const proposal = (
      await createWorldSimulationAdoptionFileProposalRepository(storage).list()
    ).proposals.find((item) => item.manifest.proposalId === proposalId)!;
    expect(proposal.changes.map((change) => change.targetPath)).toEqual([
      "world/locations/records/location-1.json",
      "timeline/index.json",
    ]);

    await createWorldSimulationAdoptionFileProposalRepository(storage).apply(
      proposalId,
      proposal.changes.map((change) => change.id),
      "测试小说",
    );
    const savedLocations = await locationRepository.load();
    const saved = savedLocations.index.locations.find(
      (location) => location.id === "location-1",
    )!;
    expect(saved.nodeId).toBe("region-1");
    expect(saved.parentLocationId).toBeNull();
    expect(saved.appearanceNote).toContain("生态上升 3");
  });
});
