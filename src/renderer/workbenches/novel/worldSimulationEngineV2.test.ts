import { describe, expect, it } from "vitest";

import {
  applyWorldDomainCommands,
  advanceWorldSimulation,
  buildEpochNarrationPrompt,
  buildDecisionPrompts,
  buildDecisionPrompt,
  commitCouncilOptionToBranch,
  compareSimulationBranches,
  createCouncilSession,
  createSimulationReport,
  createNaturalEvolutionComparisonBranch,
  createWorldSimulationRun,
  forkSimulationBranch,
  forkSimulationBranchWithGuardrail,
  forkSimulationBranchWithLead,
  getActiveSimulationBranch,
  getSimulationEndSortKey,
  parseEpochNarrationCandidate,
  switchSimulationBranch,
  type ModelDecisionSubmission,
} from "./worldSimulationEngineV2";
import { durationToDays, scaleToDays } from "./worldSimulationTime";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  createDefaultWorldSimulationScenario,
  type CharacterProjection,
  type FactionProjection,
  type ItemProjection,
  type RegionProjection,
  type WorldSimulationRun,
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
  it("只在从章节后继续时重放章节事实，重演与无章节模式保持隔离", () => {
    const chapterFact = {
      id: "chapter-fact-1",
      timelineEventId: "event-chapter-fact-1",
      chapterId: "chapter-000001",
      chapterOrder: 0,
      batchId: "tracking-batch-1",
      changeIds: ["tracking-change-1"],
      title: "顾长夜离世",
      summary: "顾长夜已经离世。",
      time: {
        calendarId: calendar.id,
        sortKey: "0",
        precision: "exact" as const,
        displayText: "第 0 日",
      },
      authority: "actual" as const,
      characterIds: ["character-1"],
      factionIds: [],
      locationIds: ["region-1"],
      itemIds: [],
      chapterIds: ["chapter-000001"],
      causeEventIds: [],
      stateChanges: [
        {
          entityType: "character" as const,
          entityId: "character-1",
          before: "在世",
          after: "死亡",
          note: "正文逐字证据",
        },
      ],
      sourceRefs,
    };
    const chapter = {
      id: "chapter-000001",
      title: "第一章",
      displayNumber: 1,
      status: "complete",
      content: "顾长夜离世。",
      narrativeChapterId: null,
      linkedTimelineEventIds: [],
      sourceRefs,
    } as const;
    const afterScenario = scenario({
      chapterContext: { mode: "after", chapterId: chapter.id },
    });
    const beforeScenario = scenario({
      chapterContext: { mode: "before", chapterId: chapter.id },
    });
    const afterRun = createWorldSimulationRun(
      baseline(afterScenario, {
        chapters: [chapter],
        chapterFacts: [chapterFact],
      }),
      afterScenario,
    );
    const beforeRun = createWorldSimulationRun(
      baseline(beforeScenario, {
        chapters: [chapter],
        chapterFacts: [chapterFact],
      }),
      beforeScenario,
    );

    expect(getActiveSimulationBranch(afterRun).state.characters[0]?.alive).toBe(
      false,
    );
    expect(
      getActiveSimulationBranch(beforeRun).state.characters[0]?.alive,
    ).toBe(true);
  });

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
  });

  it("严格按每轮跨度推进，并在最后一轮截断到总终点", () => {
    const scenarioValue = scenario({
      duration: { amount: "25", unit: "day" },
      roundSpan: { amount: "10", unit: "day" },
      maxSteps: 3,
    });
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
    expect(
      branch.checkpoints.map(
        (checkpoint) => checkpoint.state.currentTime.sortKey,
      ),
    ).toEqual(["0", "10", "20", "25"]);
  });

  it("在千亿年尺度保存可重放的宇宙纪元聚合状态", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "hundred-billion-years" },
      roundSpan: { amount: "1", unit: "hundred-billion-years" },
      outputScales: ["hundred-billion-years"],
      maxSteps: 1,
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
      "2026-08-03T00:00:00.000Z",
    );
    const evolved = advanceWorldSimulation(run, { toEnd: true });
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.status).toBe("completed");
    expect(branch.state.epoch.stage).toBe("cosmic");
    expect(branch.state.epoch.lastScale).toBe("hundred-billion-years");
    expect(branch.ledger.some((entry) => entry.kind === "epoch")).toBe(true);
    expect(new Set(branch.ledger.map((entry) => entry.id)).size).toBe(
      branch.ledger.length,
    );
    const replayed = advanceWorldSimulation(structuredClone(run), {
      toEnd: true,
    });
    const replayedBranch = getActiveSimulationBranch(replayed);
    expect(replayedBranch.ledger).toEqual(branch.ledger);
    expect(replayedBranch.state).toEqual(branch.state);
    expect(replayedBranch.observations).toEqual(branch.observations);
  });

  it("在万亿年尺度进入终局阶段并记录纪元里程碑", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "trillion-years" },
      roundSpan: { amount: "1", unit: "trillion-years" },
      outputScales: ["trillion-years"],
      maxSteps: 1,
    });
    const branch = getActiveSimulationBranch(
      advanceWorldSimulation(
        createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
        { toEnd: true },
      ),
    );
    expect(branch.state.epoch.stage).toBe("terminal");
    expect(branch.state.epoch.lastScale).toBe("trillion-years");
    expect(branch.state.epoch.lawStability).toBeLessThan(100);
    expect(
      branch.ledger.filter((entry) => entry.kind === "epoch"),
    ).toHaveLength(1);
  });

  it("将纪元模型叙事限制在已记录的纪元事件并保存为报告章节", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "trillion-years" },
      roundSpan: { amount: "1", unit: "trillion-years" },
      outputScales: ["trillion-years"],
      maxSteps: 1,
      intelligence: { mode: "assisted", cadence: "milestones" },
    });
    const run = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { toEnd: true },
    );
    const branch = getActiveSimulationBranch(run);
    const epochEvent = branch.ledger.find((event) => event.kind === "epoch");
    if (!epochEvent) throw new Error("缺少纪元事件");
    const prompt = buildEpochNarrationPrompt(run);
    expect(prompt).toContain("纪元状态");
    const narration = parseEpochNarrationCandidate(
      JSON.stringify({
        title: "终局前的法则衰变",
        summary: "法则稳定度下降，世界进入统计意义上的终局阶段。",
        findings: ["该结论来自万亿年聚合周期。"],
        eventIds: [epochEvent.id, "event-not-in-ledger"],
      }),
    );
    const withReport = createSimulationReport(
      run,
      undefined,
      null,
      "2026-08-03T00:00:00.000Z",
      narration,
    );
    const report = withReport.reports.at(-1)!;
    const section = report.sections.find((item) => item.kind === "narrative");
    expect(report.generatedBy).toBe("model");
    expect(section?.eventIds).toEqual([epochEvent.id]);
  });
});

describe("world simulation V2 deterministic evolution", () => {
  it("跳过草稿人物，但让未定位人物完成不依赖空间的生命周期结算", () => {
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
              ageYears: 99,
              lifespanYears: 100,
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
    expect(branch.ledger).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        characterIds: ["character-unplaced"],
        regionIds: [],
      }),
    );
    expect(branch.state.characters).toContainEqual(
      expect.objectContaining({ id: "character-unplaced", alive: false }),
    );
    expect(branch.state.characters).toContainEqual(
      expect.objectContaining({ id: "character-draft", alive: true }),
    );
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
    expect([...strategyCounts.values()].every((count) => count === 1)).toBe(
      true,
    );
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

  it("沿传播图继续排程多跳影响，并在达到跳数上限后停止", () => {
    const baseRegions = regions();
    const firstConnection = {
      ...baseRegions[0]!.connections[0]!,
      bidirectional: false,
      attenuation: 0,
      capacity: 100,
    };
    const secondConnection = {
      id: "road-2-3",
      fromRegionId: "region-2",
      toRegionId: "region-3",
      kind: "information" as const,
      travelDays: "5",
      capacity: 100,
      attenuation: 0,
      bidirectional: false,
      sourceRefs,
    };
    const chainRegions: RegionProjection[] = [
      { ...baseRegions[0]!, connections: [firstConnection] },
      {
        ...baseRegions[1]!,
        connections: [firstConnection, secondConnection],
      },
      {
        id: "region-3",
        name: "东海",
        type: "州",
        parentId: null,
        summary: "第三跳目标地域",
        rulerFactionIds: [],
        activeFactionIds: [],
        residentCharacterIds: [],
        itemIds: [],
        culture: [],
        rules: [],
        connections: [secondConnection],
        sourceRefs,
      },
    ];
    const scenarioValue = scenario({
      duration: { amount: "30", unit: "day" },
      roundSpan: { amount: "5", unit: "day" },
      maxSteps: 8,
      maxPropagationHops: 2,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, { regions: chainRegions }),
        scenarioValue,
      ),
      { steps: 6 },
    );
    const ledger = getActiveSimulationBranch(evolved).ledger;
    expect(
      ledger.some(
        (event) =>
          event.kind === "propagation" &&
          event.regionIds.includes("region-3") &&
          event.propagationContext?.hop === 2,
      ),
    ).toBe(true);
    expect(
      ledger.some(
        (event) =>
          event.kind === "propagation" &&
          event.propagationContext?.hop !== undefined &&
          event.propagationContext.hop > 2,
      ),
    ).toBe(false);
  });

  it("按空间通道容量限制传播知识载荷并缩放压力影响", () => {
    const baseRegions = regions();
    const limitedConnection = {
      ...baseRegions[0]!.connections[0]!,
      capacity: 20,
      attenuation: 0,
      bidirectional: false,
    };
    const limitedRegions: RegionProjection[] = [
      { ...baseRegions[0]!, connections: [limitedConnection] },
      { ...baseRegions[1]!, connections: [limitedConnection] },
    ];
    const source = character({
      knowledge: [
        {
          id: "knowledge-a",
          statement: "甲",
          authority: "fact",
          confidence: 1,
          sourceEventId: null,
        },
        {
          id: "knowledge-b",
          statement: "乙",
          authority: "fact",
          confidence: 1,
          sourceEventId: null,
        },
        {
          id: "knowledge-c",
          statement: "丙",
          authority: "fact",
          confidence: 1,
          sourceEventId: null,
        },
      ],
    });
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
      maxPropagationHops: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [source],
          regions: limitedRegions,
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const propagation = getActiveSimulationBranch(evolved).ledger.find(
      (event) => event.kind === "propagation" && event.title.includes("开始"),
    );
    const effect = propagation?.commands.find(
      (command) => command.type === "effect.schedule",
    );
    expect(propagation?.summary).toContain("通道容量 20%");
    expect(effect).toEqual(
      expect.objectContaining({
        type: "effect.schedule",
        effect: expect.objectContaining({
          pressureDelta: 1,
          hop: 1,
          knowledgeIds: expect.any(Array),
        }),
      }),
    );
    expect(
      effect?.type === "effect.schedule"
        ? effect.effect.knowledgeIds?.length
        : undefined,
    ).toBeLessThanOrEqual(2);
  });

  it("按稳定哈希过滤高衰减连接上的谣言载荷", () => {
    const baseRegions = regions();
    const rumorConnection = {
      ...baseRegions[0]!.connections[0]!,
      attenuation: 1,
      capacity: 100,
      bidirectional: false,
    };
    const rumorRegions: RegionProjection[] = [
      { ...baseRegions[0]!, connections: [rumorConnection] },
      { ...baseRegions[1]!, connections: [rumorConnection] },
    ];
    const source = character({
      knowledge: [
        {
          id: "knowledge-rumor",
          statement: "敌军将在今夜渡河",
          authority: "rumor",
          confidence: 0.8,
          sourceEventId: null,
        },
      ],
    });
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
      maxPropagationHops: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [source],
          regions: rumorRegions,
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const propagation = getActiveSimulationBranch(evolved).ledger.find(
      (event) => event.kind === "propagation" && event.title.includes("开始"),
    );
    expect(propagation?.summary).toContain("谣言发生失真");
    expect(propagation?.propagationContext).toMatchObject({
      hop: 1,
      distortedKnowledgeCount: 1,
      knowledgeIds: [],
    });
  });

  it("在固定轮次终点聚合已到期的旅行抵达", () => {
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
    expect(arrived.state.currentTime.sortKey).toBe("20");
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
      duration: { amount: "200", unit: "day" },
      roundSpan: { amount: "100", unit: "day" },
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
          arrivalSortKey: "110",
        },
      ],
      confidence: 0.8,
    };

    const departed = advanceWorldSimulation(source, {
      steps: 1,
      modelCandidate: candidate,
    });
    expect(
      getActiveSimulationBranch(departed).state.characters[0],
    ).toMatchObject({
      locationId: "route-a",
      travel: { toRegionId: "route-c", arrivalSortKey: "110" },
    });
    const arrived = getActiveSimulationBranch(
      advanceWorldSimulation(departed, { steps: 1 }),
    );
    expect(arrived.state.currentTime.sortKey).toBe("200");
    expect(arrived.state.characters[0]).toMatchObject({
      locationId: "route-c",
      travel: null,
    });
    expect(
      arrived.ledger.find((event) =>
        event.commands.some((command) => command.type === "character.arrive"),
      )?.evidence[0]?.detail,
    ).toContain("route-a → route-b → route-c");

    expect(() =>
      advanceWorldSimulation(source, {
        steps: 1,
        modelCandidate: {
          ...candidate,
          commands: [{ ...candidate.commands[0]!, arrivalSortKey: "109" }],
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

  it("按周期规则聚合千年窗口，而不逐年生成节庆事件", () => {
    const scenarioValue = scenario({
      duration: { amount: "1000", unit: "year" },
      roundSpan: { amount: "1000", unit: "year" },
      maxSteps: 1,
      scope: {
        ...createDefaultWorldSimulationScenario().scope,
        regionIds: ["region-1"],
        adjacencyDepth: 0,
      },
    });
    const festivalRule = {
      id: "rule-festival",
      title: "元宵灯会",
      description: "每年举行一次元宵灯会。",
      severity: "soft" as const,
      regionId: "region-1",
      kind: "periodic" as const,
      intervalDays: scaleToDays("year", scenarioValue.calendar).toString(),
      aggregationLabel: "按窗口聚合节庆与民间生活",
      sourceRefs,
    };
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [],
          factions: [],
          regions: [
            {
              ...regions()[0]!,
              rulerFactionIds: [],
              activeFactionIds: [],
              residentCharacterIds: [],
              rules: [festivalRule.id],
            },
          ],
          rules: [festivalRule],
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const matches = getActiveSimulationBranch(evolved).ledger.filter((event) =>
      event.title.includes("元宵灯会"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.summary).toContain("发生 1000 次");
    expect(matches[0]?.commands).toContainEqual(
      expect.objectContaining({ type: "region.metric", metric: "stability" }),
    );
  });

  it("长跨度把代际与新势力保存在分支运行态，而不伪装成正式资料", () => {
    const scenarioValue = scenario({
      duration: { amount: "500", unit: "year" },
      roundSpan: { amount: "500", unit: "year" },
      maxSteps: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, {
          characters: [],
          factions: [],
          regions: [
            {
              ...regions()[0]!,
              rulerFactionIds: [],
              activeFactionIds: [],
              residentCharacterIds: [],
              rules: ["long-scale-process"],
            },
          ],
        }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.state.emergentEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "character", regionId: "region-1" }),
        expect.objectContaining({ kind: "faction", regionId: "region-1" }),
      ]),
    );
    expect(
      branch.ledger.some((event) => event.title.includes("代际承接")),
    ).toBe(true);
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

  it("enforces the configured branch budget", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      maxBranches: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const eventId = getActiveSimulationBranch(evolved).ledger.at(-1)?.id;
    expect(eventId).toBeDefined();
    expect(() => forkSimulationBranch(evolved, eventId!)).toThrow(
      "已达到分支预算（1）",
    );
  });

  it("keeps an author guardrail isolated in a new branch", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const source = getActiveSimulationBranch(evolved);
    const eventId = source.ledger.at(-1)?.id;
    if (!eventId) throw new Error("测试运行缺少事件");

    const withGuardrail = forkSimulationBranchWithGuardrail(
      evolved,
      eventId,
      "张三在下一轮不得离开当前地域",
    );
    const branch = getActiveSimulationBranch(withGuardrail);
    expect(branch.guardrails).toEqual(["张三在下一轮不得离开当前地域"]);
    expect(
      withGuardrail.branches.find((item) => item.id === source.id)?.guardrails,
    ).toEqual([]);
  });

  it("keeps an author lead in a new branch without promoting it to world fact", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const source = getActiveSimulationBranch(evolved);
    const eventId = source.ledger.at(-1)?.id;
    if (!eventId) throw new Error("测试运行缺少事件");

    const withLead = forkSimulationBranchWithLead(
      evolved,
      eventId,
      "旧井底的残卷可能与北境灵脉异动有关",
    );
    const branch = getActiveSimulationBranch(withLead);
    expect(branch.authorLeads).toEqual([
      "旧井底的残卷可能与北境灵脉异动有关",
    ]);
    expect(
      withLead.branches.find((item) => item.id === source.id)?.authorLeads,
    ).toEqual([]);
    expect(branch.ledger).toEqual(source.ledger);

    const prompt = buildDecisionPrompt(withLead, {
      type: "character",
      id: "character-1",
    });
    expect(prompt).toContain("作者投递线索");
    expect(prompt).toContain("旧井底的残卷可能与北境灵脉异动有关");
    expect(prompt).toContain("不是当前事实");
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

  it("pauses when a strict structured constraint observes a forbidden command", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const constraint = {
      id: "strict-no-death",
      kind: "story-arc" as const,
      title: "主角不得牺牲",
      content: "",
      mode: "strict" as const,
      entityIds: ["character-1"],
      sourceRefs,
      requiredOutcomes: [],
      forbiddenOutcomes: [
        {
          id: "death",
          kind: "command" as const,
          commandType: "character.life" as const,
          entityType: "character" as const,
          entityId: "character-1",
          field: "alive",
          operator: "equals" as const,
          value: false,
        },
      ],
      flexibility: 0,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { narrativeConstraints: [constraint] }),
      scenarioValue,
    );
    const paused = advanceWorldSimulation(run, {
      steps: 1,
      modelCandidates: [
        {
          subject: { type: "character", id: "character-1" },
          candidate: {
            title: "牺牲",
            summary: "主角以生命换取封印稳定。",
            kind: "lifecycle",
            characterIds: ["character-1"],
            factionIds: [],
            regionIds: ["region-1"],
            itemIds: [],
            commands: [
              {
                type: "character.life",
                characterId: "character-1",
                alive: false,
                status: "已牺牲",
              },
            ],
            confidence: 1,
          },
        },
      ],
    });
    const branch = getActiveSimulationBranch(paused);
    expect(branch.status).toBe("paused");
    expect(branch.ledger.at(-1)?.title).toBe("剧情不可实现，推演已暂停");
    expect(branch.warnings.at(-1)).toContain("禁止结果");
  });

  it("checks required structured outcomes only when their time window ends", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const constraint = {
      id: "strict-required-intent",
      kind: "plot-line" as const,
      title: "必须发起调查",
      content: "",
      mode: "strict" as const,
      entityIds: ["character-1"],
      sourceRefs,
      timeWindow: { startSortKey: "0", endSortKey: "360" },
      requiredOutcomes: [
        {
          id: "investigate",
          kind: "command" as const,
          commandType: "character.intent" as const,
          entityType: "character" as const,
          entityId: "character-1",
          field: "intent",
          operator: "equals" as const,
          value: "调查封印",
        },
      ],
      forbiddenOutcomes: [],
      flexibility: 0,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { narrativeConstraints: [constraint] }),
      scenarioValue,
    );
    const paused = advanceWorldSimulation(run, { steps: 1 });
    const branch = getActiveSimulationBranch(paused);
    expect(branch.status).toBe("paused");
    expect(branch.warnings.at(-1)).toContain("必需结果");
  });

  it("checks required outcomes at the end even when a step emits no events", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "day" },
      maxSteps: 1,
    });
    const constraint = {
      id: "strict-empty-step",
      kind: "chapter-plan" as const,
      title: "必须出现调查命令",
      content: "",
      mode: "strict" as const,
      entityIds: [],
      sourceRefs,
      requiredOutcomes: [
        {
          id: "missing-intent",
          kind: "command" as const,
          commandType: "character.intent" as const,
          entityType: "character" as const,
          entityId: "character-1",
          field: "intent",
          operator: "exists" as const,
          value: null,
        },
      ],
      forbiddenOutcomes: [],
      flexibility: 0,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [],
        factions: [],
        regions: [],
        narrativeConstraints: [constraint],
      }),
      scenarioValue,
    );
    const paused = advanceWorldSimulation(run, { steps: 1 });
    expect(getActiveSimulationBranch(paused).status).toBe("paused");
    expect(getActiveSimulationBranch(paused).warnings.at(-1)).toContain(
      "必需结果",
    );
  });

  it("ignores structured outcomes outside their configured time window", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const constraint = {
      id: "future-forbidden",
      kind: "plot-line" as const,
      title: "未来窗口禁令",
      content: "",
      mode: "strict" as const,
      entityIds: ["character-1"],
      sourceRefs,
      timeWindow: { startSortKey: "999999", endSortKey: "1000000" },
      requiredOutcomes: [],
      forbiddenOutcomes: [
        {
          id: "future-death",
          kind: "command" as const,
          commandType: "character.life" as const,
          entityType: "character" as const,
          entityId: "character-1",
          field: "alive",
          operator: "equals" as const,
          value: false,
        },
      ],
      flexibility: 0,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { narrativeConstraints: [constraint] }),
      scenarioValue,
    );
    const evolved = advanceWorldSimulation(run, {
      steps: 1,
      modelCandidates: [
        {
          subject: { type: "character", id: "character-1" },
          candidate: {
            title: "提前牺牲",
            summary: "窗口外的候选。",
            kind: "lifecycle",
            characterIds: ["character-1"],
            factionIds: [],
            regionIds: ["region-1"],
            itemIds: [],
            commands: [
              {
                type: "character.life",
                characterId: "character-1",
                alive: false,
                status: "已牺牲",
              },
            ],
            confidence: 1,
          },
        },
      ],
    });
    expect(getActiveSimulationBranch(evolved).status).not.toBe("paused");
  });

  it("reports structured narrative attainment", () => {
    const scenarioValue = scenario({ duration: { amount: "1", unit: "year" } });
    const constraint = {
      id: "observe-intent",
      kind: "plot-line" as const,
      title: "观察调查",
      content: "",
      mode: "observe" as const,
      entityIds: ["character-1"],
      sourceRefs,
      requiredOutcomes: [],
      forbiddenOutcomes: [],
      flexibility: 50,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { narrativeConstraints: [constraint] }),
      scenarioValue,
    );
    const report = createSimulationReport(run).reports.at(-1)!;
    const narrative = report.sections.find(
      (section) => section.kind === "narrative",
    );
    expect(narrative?.findings[0]).toContain("达成度");
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

  it("persists character memory across domain commands and exposes only remembered knowledge", () => {
    const scenarioValue = scenario({
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [
          character({
            knowledge: [
              {
                id: "knowledge-local",
                statement: "北坡灵气异常",
                authority: "fact",
                confidence: 0.4,
                sourceEventId: "fact-1",
              },
              {
                id: "knowledge-secret",
                statement: "封印将在今夜崩坏",
                authority: "secret",
                confidence: 1,
                sourceEventId: null,
              },
            ],
          }),
        ],
      }),
      scenarioValue,
    );
    const origin = getActiveSimulationBranch(run);
    const originCharacter = origin.state.characters[0]!;
    expect(originCharacter.memory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: "knowledge-local",
          strength: 40,
        }),
      ]),
    );

    const recalledState = applyWorldDomainCommands(origin.state, [
      {
        type: "character.knowledge",
        characterId: "character-1",
        knowledgeId: "knowledge-local",
      },
    ]);
    const recalled = recalledState.characters[0]!;
    expect(
      recalled.memory?.find((entry) => entry.knowledgeId === "knowledge-local"),
    ).toMatchObject({
      strength: 50,
      lastRecalledSortKey: "0",
    });

    const restrictedState = {
      ...recalledState,
      characters: recalledState.characters.map((character) =>
        character.id === "character-1"
          ? {
              ...character,
              knowledgeIds: ["knowledge-local"],
              memory: character.memory?.filter(
                (entry) => entry.knowledgeId === "knowledge-local",
              ),
            }
          : character,
      ),
    };
    const memoryRun: WorldSimulationRun = {
      ...run,
      branches: run.branches.map((branch) =>
        branch.id === run.activeBranchId
          ? { ...branch, state: restrictedState }
          : branch,
      ),
    };
    const prompt = buildDecisionPrompt(memoryRun, {
      type: "character",
      id: "character-1",
    });
    expect(prompt).toContain("北坡灵气异常");
    expect(prompt).toContain('"memory"');
    expect(prompt).toContain('"knowledgeId":"knowledge-local"');
    expect(prompt).not.toContain("封印将在今夜崩坏");
  });

  it("按固定半衰期衰减记忆但保留知识索引", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      intelligence: { mode: "deterministic", cadence: "milestones" },
    });
    const source = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [
          character({
            knowledge: [
              {
                id: "knowledge-fading",
                statement: "会逐渐淡忘的线索",
                authority: "fact",
                confidence: 0.4,
                sourceEventId: null,
              },
            ],
          }),
        ],
      }),
      scenarioValue,
    );
    const evolved = advanceWorldSimulation(source, { steps: 1 });
    const runtime = getActiveSimulationBranch(evolved).state.characters[0]!;
    expect(runtime.knowledgeIds).toContain("knowledge-fading");
    const oneYearStrength = runtime.memory?.find(
      (entry) => entry.knowledgeId === "knowledge-fading",
    )?.strength;
    expect(oneYearStrength).toBeGreaterThan(0);
    expect(
      buildDecisionPrompt(evolved, { type: "character", id: runtime.id }),
    ).toContain("会逐渐淡忘的线索");

    const longScenario = scenarioValue;
    const longRun = createWorldSimulationRun(
      baseline(longScenario, {
        characters: [
          character({
            knowledge: [
              {
                id: "knowledge-fading",
                statement: "会逐渐淡忘的线索",
                authority: "fact",
                confidence: 0.4,
                sourceEventId: null,
              },
            ],
          }),
        ],
      }),
      longScenario,
    );
    const veryLongRun = advanceWorldSimulation(
      {
        ...longRun,
        scenario: {
          ...longRun.scenario,
          duration: { amount: "100", unit: "year" },
          roundSpan: { amount: "100", unit: "year" },
        },
      },
      { steps: 1 },
    );
    const forgotten =
      getActiveSimulationBranch(veryLongRun).state.characters[0]!;
    expect(
      forgotten.memory?.find(
        (entry) => entry.knowledgeId === "knowledge-fading",
      )?.strength,
    ).toBe(0);
    expect(
      buildDecisionPrompt(veryLongRun, { type: "character", id: forgotten.id }),
    ).not.toContain("会逐渐淡忘的线索");
  });

  it("通过通用领域命令原子扣除和补充人物资源", () => {
    const scenarioValue = scenario({ duration: { amount: "1", unit: "day" } });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [
          character({
            cultivation: {
              ...character().cultivation,
              resourceBalances: { spirit: 5 },
            },
          }),
        ],
      }),
      scenarioValue,
    );
    const state = getActiveSimulationBranch(run).state;
    const spent = applyWorldDomainCommands(state, [
      {
        type: "character.resource",
        characterId: "character-1",
        resourceId: "spirit",
        delta: -2,
      },
    ]);
    expect(spent.characters[0]?.resourceBalances).toEqual({ spirit: 3 });
    const recovered = applyWorldDomainCommands(spent, [
      {
        type: "character.resource",
        characterId: "character-1",
        resourceId: "spirit",
        delta: 1,
      },
    ]);
    expect(recovered.characters[0]?.resourceBalances).toEqual({ spirit: 4 });
    expect(() =>
      applyWorldDomainCommands(recovered, [
        {
          type: "character.resource",
          characterId: "character-1",
          resourceId: "spirit",
          delta: -5,
        },
      ]),
    ).toThrow("人物资源不足");
  });

  it("从基线初始化人物与势力关系，并按领域命令更新运行态", () => {
    const scenarioValue = scenario({ duration: { amount: "1", unit: "day" } });
    const first = character({
      relations: [
        {
          targetId: "character-2",
          type: "同门",
          tone: "positive",
          summary: "共同守门",
        },
      ],
    });
    const second = character({
      id: "character-2",
      name: "次席人物",
      locationId: "region-1",
      factionIds: [],
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [first, second],
      }),
      scenarioValue,
    );
    const initial = getActiveSimulationBranch(run).state;
    expect(initial.characters[0]?.relations).toContainEqual({
      targetCharacterId: "character-2",
      affinity: 50,
      trust: 50,
      status: "active",
    });
    expect(initial.factions[0]?.relations).toContainEqual({
      targetFactionId: "faction-2",
      sentiment: -50,
      status: "active",
    });

    const next = applyWorldDomainCommands(initial, [
      {
        type: "character.relation",
        characterId: "character-1",
        targetCharacterId: "character-2",
        affinityDelta: 30,
        trustDelta: -60,
        status: "strained",
      },
      {
        type: "faction.relation",
        factionId: "faction-1",
        targetFactionId: "faction-2",
        sentimentDelta: 70,
        status: "suspended",
      },
    ]);
    expect(next.characters[0]?.relations).toContainEqual({
      targetCharacterId: "character-2",
      affinity: 80,
      trust: -10,
      status: "strained",
    });
    expect(next.factions[0]?.relations).toContainEqual({
      targetFactionId: "faction-2",
      sentiment: 20,
      status: "suspended",
    });
  });

  it("拒绝关系目标不存在、自身关系和越界关系数值", () => {
    const scenarioValue = scenario({ duration: { amount: "1", unit: "day" } });
    const second = character({
      id: "character-2",
      name: "次席人物",
      locationId: "region-1",
      factionIds: [],
    });
    const state = getActiveSimulationBranch(
      createWorldSimulationRun(
        baseline(scenarioValue, { characters: [character(), second] }),
        scenarioValue,
      ),
    ).state;
    expect(() =>
      applyWorldDomainCommands(state, [
        {
          type: "character.relation",
          characterId: "character-1",
          targetCharacterId: "missing",
          affinityDelta: 1,
          trustDelta: 1,
        },
      ]),
    ).toThrow("关系目标人物不存在");
    expect(() =>
      applyWorldDomainCommands(state, [
        {
          type: "character.relation",
          characterId: "character-1",
          targetCharacterId: "character-1",
          affinityDelta: 1,
          trustDelta: 1,
        },
      ]),
    ).toThrow("人物关系不能指向自身");
    expect(() =>
      applyWorldDomainCommands(state, [
        {
          type: "faction.relation",
          factionId: "faction-1",
          targetFactionId: "faction-2",
          sentimentDelta: 101,
        },
      ]),
    ).toThrow("势力关系变化必须是有限且范围合理的数值");
  });

  it("拒绝同一时间边界写入同一人物关系键的并发候选", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      maxModelCalls: 2,
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const second = character({
      id: "character-2",
      name: "次席人物",
      locationId: "region-1",
      factionIds: [],
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [character(), second],
        factions: [],
        regions: regions().map((region) => ({
          ...region,
          activeFactionIds: [],
          rulerFactionIds: [],
          residentCharacterIds: ["character-1", "character-2"],
        })),
      }),
      scenarioValue,
    );
    const makeCandidate = (
      title: string,
      delta: number,
    ): ModelDecisionSubmission => ({
      subject: { type: "character", id: "character-1" },
      rawModelOutput: title,
      candidate: {
        title,
        summary: title,
        kind: "diplomacy",
        characterIds: ["character-1", "character-2"],
        factionIds: [],
        regionIds: ["region-1"],
        itemIds: [],
        commands: [
          {
            type: "character.relation",
            characterId: "character-1",
            targetCharacterId: "character-2",
            affinityDelta: delta,
            trustDelta: delta,
          },
        ],
        confidence: 0.8,
      },
    });
    const evolved = advanceWorldSimulation(run, {
      steps: 1,
      modelCallsUsed: 2,
      modelCandidates: [
        makeCandidate("先到的关系提案", 4),
        makeCandidate("后到的关系提案", 6),
      ],
    });
    const branch = getActiveSimulationBranch(evolved);
    expect(
      branch.ledger.filter((event) => event.generatedBy === "model"),
    ).toHaveLength(1);
    expect(branch.warnings.some((warning) => warning.includes("写入键"))).toBe(
      true,
    );
    const relation = branch.state.characters[0]?.relations?.[0];
    expect([4, 6]).toContain(relation?.affinity);
    expect(relation?.trust).toBe(relation?.affinity);
  });

  it("确定性敌对势力事件会更新运行态外交关系", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
      { steps: 1 },
    );
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.ledger.some((event) => event.kind === "conflict")).toBe(true);
    expect(branch.state.factions[0]?.relations).toContainEqual(
      expect.objectContaining({ targetFactionId: "faction-2", sentiment: -58 }),
    );
  });

  it("传播到达时只刷新目标人物基线中存在的知识", () => {
    const scenarioValue = scenario({
      duration: { amount: "2", unit: "year" },
      maxSteps: 2,
    });
    const targetKnowledge = {
      id: "knowledge-local",
      statement: "北坡灵气异常",
      authority: "fact" as const,
      confidence: 0.4,
      sourceEventId: "fact-1",
    };
    const target = character({
      id: "character-target",
      name: "河西观察者",
      locationId: "region-2",
      factionIds: [],
      knowledge: [targetKnowledge],
    });
    const evolved = advanceWorldSimulation(
      createWorldSimulationRun(
        baseline(scenarioValue, { characters: [character(), target] }),
        scenarioValue,
      ),
      { steps: 1 },
    );
    const arrived = advanceWorldSimulation(evolved, { steps: 1 });
    const arrival = getActiveSimulationBranch(arrived).ledger.find((event) =>
      event.title.includes("影响抵达"),
    );
    expect(arrival?.characterIds).toContain("character-target");
    expect(arrival?.commands).toContainEqual({
      type: "character.knowledge",
      characterId: "character-target",
      knowledgeId: "knowledge-local",
    });
    const targetRuntime = getActiveSimulationBranch(
      arrived,
    ).state.characters.find((item) => item.id === "character-target");
    expect(
      targetRuntime?.memory?.find(
        (entry) => entry.knowledgeId === "knowledge-local",
      )?.strength,
    ).toBeGreaterThan(40);
  });

  it("按稳定主体顺序裁定同一时间边界的冲突候选", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      maxModelCalls: 2,
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const secondCharacter = character({
      id: "character-2",
      name: "次席人物",
      factionIds: [],
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [character(), secondCharacter],
        factions: [],
        regions: regions().map((region) => ({
          ...region,
          activeFactionIds: [],
          rulerFactionIds: [],
          residentCharacterIds: ["character-1", "character-2"],
        })),
      }),
      scenarioValue,
    );
    const makeCandidate = (
      characterId: string,
      title: string,
      delta: number,
    ): ModelDecisionSubmission => ({
      subject: { type: "character", id: characterId },
      rawModelOutput: `{"title":"${title}"}`,
      candidate: {
        title,
        summary: title,
        kind: "conflict",
        characterIds: [characterId],
        factionIds: [],
        regionIds: ["region-1"],
        itemIds: [],
        commands: [
          {
            type: "region.metric",
            regionId: "region-1",
            metric: "pressure",
            delta,
          },
        ],
        confidence: 0.7,
        objective: "压制边境风险",
        perceivedFacts: ["knowledge-local"],
        assumptions: ["对手暂未增援"],
        expectedUtility: 72,
        risks: ["局势可能进一步升级"],
      },
    });
    const evolved = advanceWorldSimulation(run, {
      steps: 1,
      modelCallsUsed: 2,
      modelCandidates: [
        makeCandidate("character-2", "次席候选", 8),
        makeCandidate("character-1", "首席候选", 10),
      ],
    });
    const branch = getActiveSimulationBranch(evolved);
    const modelEvents = branch.ledger.filter(
      (event) => event.generatedBy === "model",
    );
    expect(modelEvents).toHaveLength(1);
    expect(modelEvents[0]?.characterIds).toEqual(["character-1"]);
    expect(modelEvents[0]?.decisionAudit).toEqual({
      subject: { type: "character", id: "character-1" },
      objective: "压制边境风险",
      perceivedFacts: ["knowledge-local"],
      assumptions: ["对手暂未增援"],
      expectedUtility: 72,
      risks: ["局势可能进一步升级"],
    });
    expect(modelEvents[0]?.rawModelOutput).toContain("首席候选");
    expect(branch.warnings.some((warning) => warning.includes("写入键"))).toBe(
      true,
    );
    expect(branch.state.regions[0]?.pressure).toBe(30);

    const independent = advanceWorldSimulation(run, {
      steps: 1,
      modelCallsUsed: 2,
      modelCandidates: [
        {
          ...makeCandidate("character-1", "首席意图", 10),
          candidate: {
            ...makeCandidate("character-1", "首席意图", 10).candidate,
            commands: [
              {
                type: "character.intent",
                characterId: "character-1",
                intent: "观察局势",
                status: "观察",
              },
            ],
          },
        },
        makeCandidate("character-2", "次席压力", 8),
      ],
    });
    const independentEvents = getActiveSimulationBranch(
      independent,
    ).ledger.filter((event) => event.generatedBy === "model");
    expect(independentEvents).toHaveLength(2);
    expect(new Set(independentEvents.map((event) => event.id)).size).toBe(2);
  });

  it("only injects timeline facts known by the decision subject", () => {
    const scenarioValue = scenario();
    const visibleFact = {
      id: "fact-visible",
      title: "北山封印松动",
      summary: "顾长夜亲眼确认北山封印出现裂痕。",
      time: {
        calendarId: calendar.id,
        sortKey: "1",
        precision: "day" as const,
        displayText: "第 1 日",
      },
      authority: "actual" as const,
      characterIds: ["character-1"],
      factionIds: ["faction-1"],
      locationIds: ["region-1"],
      itemIds: [],
      chapterIds: [],
      causeEventIds: [],
      stateChanges: [],
      sourceRefs,
    };
    const hiddenFact = {
      ...visibleFact,
      id: "fact-hidden",
      title: "赤霄门密令",
      summary: "赤霄门将在三日后偷袭北山。",
      characterIds: ["character-secret"],
      factionIds: ["faction-2"],
    };
    const protagonist = character({
      knowledge: [
        {
          id: "knowledge-visible",
          statement: visibleFact.summary,
          authority: "fact",
          confidence: 1,
          sourceEventId: visibleFact.id,
        },
      ],
    });
    const informedFaction = faction("faction-1", "faction-2");
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [protagonist],
        factions: [informedFaction, faction("faction-2", "faction-1")],
        timelineFacts: [visibleFact, hiddenFact],
      }),
      scenarioValue,
    );

    const characterPrompt = buildDecisionPrompt(run, {
      type: "character",
      id: protagonist.id,
    });
    const factionPrompt = buildDecisionPrompt(run, {
      type: "faction",
      id: informedFaction.id,
    });

    for (const prompt of [characterPrompt, factionPrompt]) {
      expect(prompt).toContain(visibleFact.title);
      expect(prompt).not.toContain(hiddenFact.title);
      expect(prompt).not.toContain(hiddenFact.summary);
    }
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

  it("replays actual baseline facts into runtime state before the first step", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const fact = {
      id: "fact-death",
      title: "顾长夜离世",
      summary: "顾长夜已离世，遗物留在河西。",
      time: { ...baseline(scenarioValue).anchor, displayText: "第 0 日" },
      authority: "actual" as const,
      characterIds: ["character-1"],
      factionIds: [],
      locationIds: ["region-2"],
      itemIds: [],
      chapterIds: [],
      causeEventIds: [],
      stateChanges: [
        {
          entityType: "character" as const,
          entityId: "character-1",
          before: "在世",
          after: "已离世",
          note: "事实基线",
        },
      ],
      sourceRefs,
    };
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { timelineFacts: [fact] }),
      scenarioValue,
    );
    expect(getActiveSimulationBranch(run).state.characters[0]).toMatchObject({
      alive: false,
      locationId: "region-2",
      status: "已离世",
    });
  });

  it("rejects a cultivation breakthrough when required resources are absent", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const cultivating = character({
      status: "修炼中",
      cultivation: {
        ...character().cultivation,
        systemId: "system-1",
        levelId: "level-1",
        levelName: "炼气",
        levelOrder: 1,
      },
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        characters: [cultivating],
        cultivationSystems: [
          {
            id: "system-1",
            name: "灵气修行",
            kind: "修炼",
            summary: "",
            levels: [
              {
                id: "level-1",
                name: "炼气",
                order: 1,
                trackId: "track-1",
                breakthroughConditions: [],
                resourceIds: [],
              },
              {
                id: "level-2",
                name: "筑基",
                order: 2,
                trackId: "track-1",
                breakthroughConditions: ["需要筑基丹"],
                resourceIds: ["resource-pill"],
              },
            ],
            transitions: [],
            hardConstraints: [],
            sourceRefs,
          },
        ],
      }),
      scenarioValue,
    );
    expect(() =>
      advanceWorldSimulation(run, {
        steps: 1,
        modelCandidate: {
          title: "强行筑基",
          summary: "没有筑基丹仍尝试突破。",
          kind: "cultivation",
          characterIds: ["character-1"],
          factionIds: [],
          regionIds: ["region-1"],
          itemIds: [],
          commands: [
            {
              type: "character.cultivate",
              characterId: "character-1",
              progressDelta: 1,
              nextLevelId: "level-2",
            },
          ],
          confidence: 0.5,
        },
      }),
    ).toThrow("突破资源不足");
  });

  it("emits a world-process event only when a region has structured process evidence", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, {
        factions: [],
        regions: regions().map((region) =>
          region.id === "region-1"
            ? { ...region, rules: ["灵气随稳定度变化"] }
            : region,
        ),
      }),
      scenarioValue,
    );
    const branch = getActiveSimulationBranch(
      advanceWorldSimulation(run, { steps: 1 }),
    );
    expect(branch.ledger.some((event) => event.kind === "world-process")).toBe(
      true,
    );
    expect(
      branch.ledger.find((event) => event.kind === "world-process")?.evidence[0]
        ?.type,
    ).toBe("fact");
  });

  it("evaluates multiple active factions in one time step and pauses at the event budget", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      maxEvents: 1,
    });
    const branch = getActiveSimulationBranch(
      advanceWorldSimulation(
        createWorldSimulationRun(baseline(scenarioValue), scenarioValue),
        { steps: 1 },
      ),
    );
    expect(branch.ledger.length).toBeLessThanOrEqual(1);
    expect(branch.status).toBe("paused");
    expect(
      branch.warnings.some((warning) => warning.includes("事件预算")),
    ).toBe(true);
  });

  it("counts actual model requests instead of only accepted candidates", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
      maxModelCalls: 2,
      intelligence: { mode: "assisted", cadence: "each-step" },
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue, { factions: [] }),
      scenarioValue,
    );
    const evolved = advanceWorldSimulation(run, {
      steps: 1,
      modelCallsUsed: 2,
      modelCandidates: [
        {
          subject: { type: "character", id: "character-1" },
          candidate: {
            title: "暂缓出行",
            summary: "先维持现有位置并观察局势。",
            kind: "character-action",
            characterIds: ["character-1"],
            factionIds: [],
            regionIds: ["region-1"],
            itemIds: [],
            commands: [
              {
                type: "character.intent",
                characterId: "character-1",
                intent: "观察局势",
                status: "观察",
              },
            ],
            confidence: 0.7,
          },
        },
      ],
    });
    const branch = getActiveSimulationBranch(evolved);
    expect(branch.modelCallCount).toBe(2);
    expect(branch.status).toBe("paused");
    expect(
      branch.warnings.some((warning) => warning.includes("模型调用预算")),
    ).toBe(true);
  });

  it("generates isolated prompts for each active subject and excludes dissolved factions", () => {
    const scenarioValue = scenario({
      duration: { amount: "1", unit: "year" },
      maxSteps: 1,
    });
    const run = createWorldSimulationRun(
      baseline(scenarioValue),
      scenarioValue,
    );
    const prompts = buildDecisionPrompts(run);
    expect(prompts.map((item) => item.subject)).toEqual(
      expect.arrayContaining([
        { type: "character", id: "character-1" },
        { type: "faction", id: "faction-1" },
      ]),
    );
    expect(
      prompts.find((item) => item.subject.type === "character")?.prompt,
    ).toContain('"type":"character"');

    const dissolved = {
      ...run,
      branches: run.branches.map((branch) => ({
        ...branch,
        state: {
          ...branch.state,
          factions: branch.state.factions.map((faction) => ({
            ...faction,
            lifecycle: "dissolved" as const,
          })),
        },
      })),
    };
    expect(
      buildDecisionPrompts(dissolved).some(
        (item) => item.subject.type === "faction",
      ),
    ).toBe(false);
  });
});
