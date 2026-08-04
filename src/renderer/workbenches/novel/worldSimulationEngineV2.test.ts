import { describe, expect, it } from "vitest";

import {
  applyWorldDomainCommands,
  advanceWorldSimulation,
  buildDecisionPrompt,
  commitCouncilOptionToBranch,
  compareSimulationBranches,
  createCouncilSession,
  createNaturalEvolutionComparisonBranch,
  createWorldSimulationRun,
  forkSimulationBranch,
  getActiveSimulationBranch,
  getSimulationEndSortKey,
  switchSimulationBranch,
} from "./worldSimulationEngineV2";
import {
  chooseAdaptiveStep,
  durationToDays,
  scaleToDays,
} from "./worldSimulationTime";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  createDefaultWorldSimulationScenario,
  type CharacterProjection,
  type FactionProjection,
  type ItemProjection,
  type RegionProjection,
  type WorldSimulationBaseline,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";

const calendar = createDefaultWorldSimulationScenario().calendar;
const sourceRefs = [
  {
    path: "fixture.json",
    sourceHash: "sha256:fixture",
    authority: "canon" as const,
  },
];

function character(
  overrides: Partial<CharacterProjection> = {},
): CharacterProjection {
  return {
    id: "character-1",
    name: "顾长夜",
    summary: "守住山门并查清灵潮来源",
    status: "在世",
    locationId: "region-1",
    factionIds: ["faction-1"],
    goals: ["守住山门"],
    personality: ["谨慎"],
    values: ["承诺"],
    strengths: ["耐心"],
    weaknesses: ["不信任陌生人"],
    fears: ["宗门覆灭"],
    motivation: ["保护同门"],
    innerConflict: ["个人求道与宗门责任冲突"],
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
    inventoryItemIds: [],
    knowledge: [
      {
        id: "knowledge-local",
        statement: "北坡灵气异常",
        authority: "fact",
        confidence: 0.9,
        sourceEventId: "fact-1",
      },
    ],
    sourceRefs,
    ...overrides,
  };
}

function faction(id: string, rivalId: string): FactionProjection {
  return {
    id,
    name: id === "faction-1" ? "青衡宗" : "赤霄门",
    type: "宗门",
    status: "active",
    summary: "争夺北境灵脉",
    goals: ["控制北境灵脉"],
    territoryIds: ["region-1"],
    leaderCharacterIds: id === "faction-1" ? ["character-1"] : [],
    memberCharacterIds: id === "faction-1" ? ["character-1"] : [],
    resources: [],
    relations: [
      {
        targetFactionId: rivalId,
        kind: "hostile",
        direction: "bilateral",
        status: "active",
        description: "长期敌对",
      },
    ],
    stateText: {
      governance: "稳固",
      military: "精锐",
      economy: "充足",
      publicSupport: "支持",
      territorialIntegrity: "统一",
    },
    sourceRefs,
  };
}

function regions(): RegionProjection[] {
  const connection = {
    id: "road-1-2",
    fromRegionId: "region-1",
    toRegionId: "region-2",
    kind: "road" as const,
    travelDays: "5",
    capacity: 60,
    attenuation: 0.4,
    bidirectional: true,
    sourceRefs,
  };
  return [
    {
      id: "region-1",
      name: "北境",
      type: "州",
      parentId: null,
      summary: "灵脉争夺地",
      rulerFactionIds: ["faction-1"],
      activeFactionIds: ["faction-1", "faction-2"],
      residentCharacterIds: ["character-1"],
      itemIds: [],
      culture: [],
      rules: [],
      connections: [connection],
      sourceRefs,
    },
    {
      id: "region-2",
      name: "河西",
      type: "州",
      parentId: null,
      summary: "北境邻地",
      rulerFactionIds: [],
      activeFactionIds: [],
      residentCharacterIds: [],
      itemIds: [],
      culture: [],
      rules: [],
      connections: [connection],
      sourceRefs,
    },
  ];
}

function scenario(
  overrides: Partial<WorldSimulationScenario> = {},
): WorldSimulationScenario {
  const base = createDefaultWorldSimulationScenario();
  return {
    ...base,
    duration: { amount: "100", unit: "year" },
    outputScales: ["day", "year", "century"],
    maxSteps: 48,
    intelligence: { mode: "deterministic", cadence: "milestones" },
    scope: { ...base.scope, regionIds: ["region-1"], adjacencyDepth: 0 },
    ...overrides,
  };
}

function baseline(
  scenarioValue: WorldSimulationScenario,
  overrides: Partial<WorldSimulationBaseline> = {},
): WorldSimulationBaseline {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    baselineId: "baseline-fixture",
    projectId: "project-1",
    projectTitle: "仙途",
    sourceRevision: "sha256:baseline",
    compiledAt: "2026-08-03T00:00:00.000Z",
    anchor: {
      calendarId: calendar.id,
      sortKey: "0",
      precision: "exact",
      displayText: "第 0 日",
    },
    factsThroughEventId: "fact-1",
    calendar: scenarioValue.calendar,
    characters: [character()],
    factions: [
      faction("faction-1", "faction-2"),
      faction("faction-2", "faction-1"),
    ],
    regions: regions(),
    items: [],
    cultivationSystems: [],
    rules: [],
    timelineFacts: [],
    timelinePlans: [
      {
        id: "future-plan",
        title: "百年后开战",
        summary: "尚未发生",
        time: {
          calendarId: calendar.id,
          sortKey: "36000",
          precision: "year",
          displayText: "第 100 年",
        },
        authority: "planned",
        characterIds: [],
        factionIds: ["faction-1", "faction-2"],
        locationIds: ["region-1"],
        itemIds: [],
        chapterIds: [],
        causeEventIds: [],
        stateChanges: [],
        sourceRefs: [{ ...sourceRefs[0], authority: "planned" }],
      },
    ],
    narrativeConstraints: [],
    chapters: [],
    diagnostics: [],
    sourceRefs,
    ...overrides,
  };
}

describe("world simulation V2 time kernel", () => {
  it("uses bigint coordinates for trillion-year spans and lands on the final boundary", () => {
    const trillionDays = durationToDays(
      { amount: "1", unit: "trillion-years" },
      calendar,
    );
    expect(trillionDays).toBe(
      scaleToDays("year", calendar) * 1_000_000_000_000n,
    );
    expect(
      durationToDays({ amount: "100000000", unit: "trillion-years" }, calendar),
    ).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(chooseAdaptiveStep("10", "123456789012345678901", 1, calendar)).toBe(
      123456789012345678891n,
    );
  });

  it("reaches the exact end even when adaptive scale buckets do not divide the window", () => {
    const scenarioValue = scenario();
    const run = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
      "2026-08-03T00:00:00.000Z",
    );
    const completed = advanceWorldSimulation(run, { toEnd: true });
    const branch = getActiveSimulationBranch(completed);
    expect(branch.status).toBe("completed");
    expect(branch.state.currentTime.sortKey).toBe(
      getSimulationEndSortKey(completed),
    );
    expect(branch.checkpoints.length).toBeLessThanOrEqual(
      scenarioValue.maxSteps + 1,
    );
  });
});

describe("world simulation V2 deterministic evolution", () => {
  it("仅推进时间，不为草稿、无地点主体或静默地域伪造事件", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      scope: {
        ...scenario().scope,
        characterIds: ["character-draft", "character-unplaced"],
      },
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [
            character({
              id: "character-draft",
              name: "草稿人物",
              status: "草稿",
            }),
            character({
              id: "character-unplaced",
              name: "未定位人物",
              locationId: null,
            }),
          ],
          factions: [],
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.state.currentTime.sortKey).toBe("360");
    expect(branch.ledger).toEqual([]);
  });

  it("拒绝没有状态提交的模型候选", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { factions: [] }),
      scenarioValue,
    );
    expect(() =>
      advanceWorldSimulation(run, {
        steps: 1,
        modelCandidate: {
          title: "没有落地的猜测",
          summary: "只给出叙述，未说明会改变什么。",
          kind: "character-action",
          characterIds: ["character-1"],
          factionIds: [],
          regionIds: ["region-1"],
          itemIds: [],
          commands: [],
          confidence: 0.5,
        },
      }),
    ).toThrow("模型候选没有可验证的状态提交");
  });

  it("replays the same seed into the same ledger, state and observations", () => {
    const scenarioValue = scenario({
      duration: { amount: "3", unit: "year" },
      maxSteps: 4,
    });
    const source = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
      "2026-08-03T00:00:00.000Z",
    );
    const left = getActiveSimulationBranch(
      advanceWorldSimulation(structuredClone(source), { toEnd: true }),
    );
    const right = getActiveSimulationBranch(
      advanceWorldSimulation(structuredClone(source), { toEnd: true }),
    );
    expect(left.ledger).toEqual(right.ledger);
    expect(left.state).toEqual(right.state);
    expect(left.observations).toEqual(right.observations);
  });

  it("不会在没有新证据时重复提交同一势力策略", () => {
    const scenarioValue = scenario({
      duration: { amount: "4", unit: "year" },
      maxSteps: 4,
    });
    const branch = getActiveSimulationBranch(
      advanceWorldSimulation(
        createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
        { toEnd: true },
      ),
    );
    const strategyCounts = new Map<string, number>();
    branch.ledger
      .flatMap((event) => event.commands)
      .filter((command) => command.type === "faction.strategy")
      .forEach((command) => {
        strategyCounts.set(
          command.factionId,
          (strategyCounts.get(command.factionId) ?? 0) + 1,
        );
      });
    expect([...strategyCounts.values()]).not.toHaveLength(0);
    expect([...strategyCounts.values()].every((count) => count === 1)).toBe(true);
  });

  it("propagates high-pressure conflicts through spatial connections with an explicit cause", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const ledger = getActiveSimulationBranch(evolved).ledger;
    const conflict = ledger.find((event) => event.kind === "conflict");
    const propagation = ledger.find((event) => event.kind === "propagation");
    expect(conflict).toBeDefined();
    expect(propagation?.causeEventIds).toEqual([conflict?.id]);
    expect(propagation?.regionIds).toEqual(["region-1", "region-2"]);
    expect(propagation?.commands).toContainEqual(
      expect.objectContaining({
        type: "effect.schedule",
        effect: expect.objectContaining({
          targetRegionId: "region-2",
          dueSortKey: "365",
        }),
      }),
    );
    const arrived = getActiveSimulationBranch(
      advanceWorldSimulation(evolved, { steps: 1 }),
    ).ledger.find((event) => event.title.includes("影响抵达"));
    expect(arrived?.commands).toContainEqual(
      expect.objectContaining({
        type: "region.metric",
        regionId: "region-2",
        metric: "pressure",
      }),
    );
  });

  it("uses travel arrival as the next time boundary instead of teleporting a character", () => {
    const scenarioValue = scenario({
      duration: { amount: "20", unit: "day" },
      maxSteps: 1,
    });
    const source = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
    );
    const origin = getActiveSimulationBranch(source);
    const departedState = applyWorldDomainCommands(origin.state, [
      {
        type: "character.move",
        characterId: "character-1",
        fromRegionId: "region-1",
        toRegionId: "region-2",
        arrivalSortKey: "5",
      },
    ]);
    const departed = {
      ...source,
      branches: source.branches.map((branch) =>
        branch.id === origin.id ? { ...branch, state: departedState } : branch,
      ),
    };
    const arrived = getActiveSimulationBranch(
      advanceWorldSimulation(departed, { steps: 1 }),
    );
    expect(arrived.state.currentTime.sortKey).toBe("5");
    expect(arrived.state.characters[0]).toMatchObject({
      locationId: "region-2",
      travel: null,
    });
    expect(
      arrived.ledger.some((event) =>
        event.commands.some((command) => command.type === "character.arrive"),
      ),
    ).toBe(true);
  });

  it("requires a complete traversable route and its minimum travel time for model movement", () => {
    const roadOne = {
      id: "road-a-b",
      fromRegionId: "route-a",
      toRegionId: "route-b",
      kind: "road" as const,
      travelDays: "4",
      capacity: 60,
      attenuation: 0.2,
      bidirectional: true,
      sourceRefs,
    };
    const roadTwo = {
      id: "road-b-c",
      fromRegionId: "route-b",
      toRegionId: "route-c",
      kind: "road" as const,
      travelDays: "6",
      capacity: 60,
      attenuation: 0.2,
      bidirectional: true,
      sourceRefs,
    };
    const pathRegions: RegionProjection[] = [
      {
        id: "route-a",
        name: "起点",
        type: "城",
        parentId: null,
        summary: "",
        rulerFactionIds: [],
        activeFactionIds: [],
        residentCharacterIds: ["character-1"],
        itemIds: [],
        culture: [],
        rules: [],
        connections: [roadOne],
        sourceRefs,
      },
      {
        id: "route-b",
        name: "驿站",
        type: "城",
        parentId: null,
        summary: "",
        rulerFactionIds: [],
        activeFactionIds: [],
        residentCharacterIds: [],
        itemIds: [],
        culture: [],
        rules: [],
        connections: [roadOne, roadTwo],
        sourceRefs,
      },
      {
        id: "route-c",
        name: "终点",
        type: "城",
        parentId: null,
        summary: "",
        rulerFactionIds: [],
        activeFactionIds: [],
        residentCharacterIds: [],
        itemIds: [],
        culture: [],
        rules: [],
        connections: [roadTwo],
        sourceRefs,
      },
    ];
    const scenarioValue = scenario({
      duration: { amount: "100", unit: "day" },
      maxSteps: 2,
      scope: {
        ...scenario().scope,
        regionIds: ["route-a", "route-b", "route-c"],
      },
    });
    const source = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [character({ locationId: "route-a" })],
        factions: [],
        regions: pathRegions,
      }),
      scenarioValue,
    );
    const candidate = {
      title: "前往终点",
      summary: "经驿站前往终点。",
      kind: "character-action" as const,
      characterIds: ["character-1"],
      factionIds: [],
      regionIds: ["route-a", "route-b", "route-c"],
      itemIds: [],
      commands: [
        {
          type: "character.move" as const,
          characterId: "character-1",
          fromRegionId: "route-a",
          toRegionId: "route-c",
          arrivalSortKey: "40",
        },
      ],
      confidence: 0.8,
    };

    const departed = advanceWorldSimulation(source, {
      steps: 1,
      modelCandidate: candidate,
    });
    expect(getActiveSimulationBranch(departed).state.characters[0]).toMatchObject({
      locationId: "route-a",
      travel: { toRegionId: "route-c", arrivalSortKey: "40" },
    });
    const arrived = getActiveSimulationBranch(
      advanceWorldSimulation(departed, { steps: 1 }),
    );
    expect(arrived.state.currentTime.sortKey).toBe("40");
    expect(arrived.state.characters[0]).toMatchObject({
      locationId: "route-c",
      travel: null,
    });
    expect(
      arrived.ledger
        .find((event) => event.commands.some((command) => command.type === "character.arrive"))
        ?.evidence[0]?.detail,
    ).toContain("route-a → route-b → route-c");

    expect(() =>
      advanceWorldSimulation(source, {
        steps: 1,
        modelCandidate: {
          ...candidate,
          commands: [{ ...candidate.commands[0]!, arrivalSortKey: "39" }],
        },
      }),
    ).toThrow("行程至少需要 10 日");
  });

  it("applies lifespan boundaries and keeps council knowledge actor-scoped", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 1,
    });
    const relic: ItemProjection = {
      id: "item-1",
      name: "旧剑",
      category: "法器",
      status: "持有",
      summary: "待继承的遗物",
      ownerType: "character",
      ownerId: "character-1",
      locationId: "region-1",
      capabilities: ["斩断封印"],
      sourceRefs,
    };
    const shortLived = character({
      ageYears: 99,
      lifespanYears: 100,
      inventoryItemIds: [relic.id],
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, { characters: [shortLived], items: [relic] }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.state.characters[0]?.alive).toBe(false);
    const lifecycle = branch.ledger.find((event) => event.kind === "lifecycle");
    expect(lifecycle?.title).toContain("寿命尽头");
    expect(lifecycle?.commands).toContainEqual(
      expect.objectContaining({
        type: "item.transfer",
        itemId: relic.id,
        status: "待继承",
      }),
    );
    expect(branch.state.items[0]).toMatchObject({
      ownerType: null,
      ownerId: null,
      status: "待继承",
    });

    const councilRun = createCouncilSession(
      evolved,
      lifecycle?.id ?? null,
      "是否改变传承安排？",
    );
    const stance = councilRun.councilSessions[0]?.stances.find(
      (item) => item.participantId === shortLived.id,
    );
    expect(stance?.knownFactIds).toEqual(["knowledge-local"]);
    expect(stance?.knownFactIds).not.toContain("future-plan");
  });

  it("forks by replaying elapsed time and commands without mutating the source branch", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const source = getActiveSimulationBranch(evolved);
    const lastEvent = source.ledger.at(-1)!;
    const forked = forkSimulationBranch(evolved, lastEvent.id, "另一种选择");
    const branch = getActiveSimulationBranch(forked);
    expect(branch.state).toEqual(source.state);
    expect(
      branch.observations.every((observation) =>
        observation.id.includes(branch.id),
      ),
    ).toBe(true);

    const returned = switchSimulationBranch(forked, source.id);
    const advancedSource = advanceWorldSimulation(returned, { steps: 1 });
    const untouchedFork = advancedSource.branches.find(
      (item) => item.id === branch.id,
    );
    expect(untouchedFork).toEqual(branch);
  });

  it("keeps causal references valid across every requested observation scale", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const branch = getActiveSimulationBranch(
      advanceWorldSimulation(
        createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
        { steps: 1 },
      ),
    );
    const eventIds = new Set(branch.ledger.map((event) => event.id));
    expect(
      branch.ledger
        .flatMap((event) => event.causeEventIds)
        .every((id) => eventIds.has(id)),
    ).toBe(true);
    expect(
      new Set(branch.observations.map((observation) => observation.scale)),
    ).toEqual(new Set(scenarioValue.outputScales));
    expect(
      branch.observations
        .flatMap((observation) => observation.eventIds)
        .every((id) => eventIds.has(id)),
    ).toBe(true);
  });

  it("creates a same-seed natural comparison branch without narrative constraints", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
    );
    const compared = createNaturalEvolutionComparisonBranch(run);
    const natural = getActiveSimulationBranch(compared);
    expect(natural.narrativePolicy).toBe("disabled");
    expect(natural.seed).toBe(run.branches[0]?.seed);
    expect(natural.ledger).toEqual([]);

    const configured = advanceWorldSimulation(
      switchSimulationBranch(compared, "branch-main"),
      { steps: 1 },
    );
    const comparison = compareSimulationBranches(
      configured,
      "branch-main",
      natural.id,
    );
    expect(comparison.leftBranchId).toBe("branch-main");
    expect(comparison.rightBranchId).toBe(natural.id);
  });

  it("keeps the source branch unchanged when a reviewed council option becomes an intervention branch", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const source = getActiveSimulationBranch(evolved);
    const sessionRun = createCouncilSession(
      evolved,
      source.ledger.at(-1)?.id ?? null,
      "应否调整行动？",
    );
    const session = sessionRun.councilSessions[0]!;
    const option = session.options[0]!;
    const committed = commitCouncilOptionToBranch(
      sessionRun,
      session.id,
      option.id,
    );
    const intervention = getActiveSimulationBranch(committed);
    expect(intervention.parentBranchId).toBe(source.id);
    expect(intervention.ledger.at(-1)?.title).toContain("会商干预");
    expect(
      committed.branches.find((branch) => branch.id === source.id),
    ).toEqual(source);
    expect(committed.councilSessions[0]?.status).toBe("committed");
  });

  it("pauses instead of violating a strict survival constraint", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 1,
    });
    const shortLived = character({ ageYears: 99, lifespanYears: 100 });
    const strictConstraint = {
      id: "strict-survival",
      kind: "story-arc" as const,
      title: "顾长夜必须存活",
      content: "顾长夜不得死亡，必须存活至故事弧结束。",
      mode: "strict" as const,
      entityIds: [shortLived.id],
      sourceRefs,
    };
    const paused = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [shortLived],
          narrativeConstraints: [strictConstraint],
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const branch = getActiveSimulationBranch(paused);
    expect(branch.status).toBe("paused");
    expect(
      branch.warnings.some((warning) => warning.startsWith("剧情不可实现：")),
    ).toBe(true);
    expect(branch.ledger.at(-1)?.title).toBe("剧情不可实现，推演已暂停");
  });

  it("applies distinct outside-range propagation policies", () => {
    const base = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const ignored = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline({
          ...base,
          scope: { ...base.scope, outsidePolicy: "ignore" },
        }),
        { ...base, scope: { ...base.scope, outsidePolicy: "ignore" } },
      ),
      { steps: 1 },
    );
    const approximated = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline({
          ...base,
          scope: { ...base.scope, outsidePolicy: "approximate" },
        }),
        { ...base, scope: { ...base.scope, outsidePolicy: "approximate" } },
      ),
      { steps: 1 },
    );
    expect(
      getActiveSimulationBranch(ignored).ledger.some(
        (event) => event.kind === "propagation",
      ),
    ).toBe(false);
    expect(
      getActiveSimulationBranch(approximated).ledger.some(
        (event) => event.kind === "propagation",
      ),
    ).toBe(true);
  });

  it("does not expose another character's private knowledge in a decision prompt", () => {
    const scenarioValue = scenario();
    const hidden = character({
      id: "character-secret",
      name: "隐修者",
      knowledge: [
        {
          id: "secret",
          statement: "封印将在今夜崩坏",
          authority: "secret",
          confidence: 1,
          sourceEventId: null,
        },
      ],
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { characters: [character(), hidden] }),
      scenarioValue,
    );
    const prompt = buildDecisionPrompt(run);
    expect(prompt).toContain("顾长夜");
    expect(prompt).not.toContain("封印将在今夜崩坏");
  });

  it("labels chapter context and future plans separately in the decision prompt", () => {
    const scenarioValue = scenario({
      chapterContext: { mode: "after", chapterId: "chapter-1" },
    });
    const chapter = {
      id: "chapter-1",
      title: "北山异动",
      displayNumber: 42,
      status: "planned",
      content: "章节中明确发生：封印边缘出现裂痕。",
      narrativeChapterId: null,
      linkedTimelineEventIds: [],
      sourceRefs,
    } as const;
    const planned = baseline(scenarioValue).timelinePlans[0]!;
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { chapters: [chapter] }),
      scenarioValue,
    );
    const prompt = buildDecisionPrompt(run);
    expect(prompt).toContain("北山异动");
    expect(prompt).not.toContain("章节中明确发生：封印边缘出现裂痕");
    expect(prompt).toContain("作者未来计划");
    expect(prompt).toContain(planned.title);
    expect(prompt).toContain("绝不能当作已发生");

    const unconstrained = createWorldSimulationRun(
      baseline(scenarioValue, { chapters: [chapter] }),
      {
        ...scenarioValue,
        narrativeContext: { ...scenarioValue.narrativeContext, mode: "off" },
      },
    );
    expect(buildDecisionPrompt(unconstrained)).not.toContain(planned.title);
  });

  it("rejects model and council attempts to transfer an unseen item", () => {
    const scenarioValue = scenario();
    const hidden = character({
      id: "character-secret",
      name: "隐修者",
      locationId: "region-2",
      inventoryItemIds: ["item-secret"],
    });
    const secretItem: ItemProjection = {
      id: "item-secret",
      name: "封天玉简",
      category: "秘宝",
      status: "持有",
      summary: "只由隐修者保管。",
      ownerType: "character",
      ownerId: "character-secret",
      locationId: "region-2",
      capabilities: [],
      sourceRefs,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [character(), hidden],
        items: [secretItem],
      }),
      scenarioValue,
    );
    const commands = [
      {
        type: "item.transfer" as const,
        itemId: "item-secret",
        ownerType: "character" as const,
        ownerId: "character-1",
        locationId: "region-1",
      },
    ];
    const modelCandidate = {
      title: "夺取玉简",
      summary: "未经情报确认便夺取隐修者持有的玉简。",
      kind: "character-action" as const,
      characterIds: ["character-1"],
      factionIds: [],
      regionIds: ["region-1"],
      itemIds: ["item-secret"],
      commands,
      confidence: 0.7,
    };

    expect(() =>
      advanceWorldSimulation(run, { steps: 1, modelCandidate }),
    ).toThrow("模型候选试图操作不可见物品");
    expect(() =>
      createCouncilSession(run, null, "谁该持有玉简？", {
        stances: [
          {
            participantType: "character",
            participantId: "character-1",
            knownFactIds: [],
            goal: "守住山门",
            position: "先保全本方。",
            risks: [],
            optionIds: ["option-secret"],
          },
        ],
        options: [
          {
            id: "option-secret",
            title: "夺取玉简",
            summary: "直接接管未知物品。",
            score: 80,
            costs: [],
            benefits: [],
            commands,
          },
        ],
      }),
    ).toThrow("会商方案试图操作不可见物品");
  });
});
