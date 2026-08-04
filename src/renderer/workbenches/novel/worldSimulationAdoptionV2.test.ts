import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../../../shared/workbenches/novel/characterLibrarySchema";

import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import {
  createEmptyFactionLibrary,
  type FactionRecord,
} from "./factionLibrarySchema";
import { createNovelFactionLibraryRepository } from "./factionLibraryRepository";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
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
  await characterRepository.saveCharacters(characterLibrary, [
    character("character-1", "沈砚", "item-1"),
    character("character-2", "陆昭", null),
  ]);
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
      "characters/index.json",
      "world/factions/index.json",
      "timeline/index.json",
    ]);

    await repository.apply(
      proposalId,
      proposal?.changes.map((change) => change.id) ?? [],
      "测试小说",
    );

    const characters =
      await createNovelCharacterLibraryRepository(storage).load();
    const factions = await createNovelFactionLibraryRepository(storage).load();
    expect(
      characters.index.characters.find((item) => item.id === "character-1")
        ?.inventory,
    ).toEqual([]);
    expect(
      characters.index.characters.find((item) => item.id === "character-2")
        ?.inventory,
    ).toMatchObject([{ itemId: "item-1", name: "镇界印", quantity: 1 }]);
    expect(factions.library.factions[0]?.resources).toEqual([]);
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
    const proposal = (
      await repository.list()
    ).proposals.find((item) => item.manifest.proposalId === proposalId)!;

    expect(proposal.changes.map((change) => change.targetPath)).toEqual([
      "timeline/index.json",
    ]);
    await repository.apply(
      proposalId,
      proposal.changes.map((change) => change.id),
      "测试小说",
    );

    const characters =
      await createNovelCharacterLibraryRepository(storage).load();
    const factions = await createNovelFactionLibraryRepository(storage).load();
    const timeline = await createNovelTimelineLibraryRepository(storage).load();
    expect(
      characters.index.characters.find((item) => item.id === "character-1")
        ?.inventory,
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
});
