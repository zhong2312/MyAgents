import { z } from "zod";

// V3 removes the non-evidenced fallback evolution paths. Historical V2 runs
// may contain synthetic state changes and therefore must not be replayed.
export const WORLD_SIMULATION_SCHEMA_VERSION = 3 as const;
export const WORLD_SIMULATION_RUN_STORAGE_VERSION = 1 as const;
export const WORLD_SIMULATION_PATHS = Object.freeze({
  scenarios: "simulation/scenarios.json",
  runIndex: "simulation/runs/index.json",
  runRoot: "simulation/runs",
  branchEventLedgerFile: "event-ledger.jsonl",
  branchCheckpointsFile: "checkpoints.jsonl",
});

export type SimulationAuthority =
  | "actual"
  | "canon"
  | "constraint"
  | "planned"
  | "author-secret"
  | "simulated";

export type TimeScale =
  | "day"
  | "month"
  | "year"
  | "century"
  | "millennium"
  | "ten-thousand-years"
  | "hundred-billion-years"
  | "trillion-years";

export type WorldDurationUnit = TimeScale | "era";

export interface WorldInstant {
  readonly calendarId: string;
  readonly sortKey: string;
  readonly precision:
    | "exact"
    | "day"
    | "month"
    | "year"
    | "era"
    | "approximate";
  readonly displayText: string;
}

export interface WorldDuration {
  readonly amount: string;
  readonly unit: WorldDurationUnit;
}

export interface SimulationCalendar {
  readonly id: string;
  readonly name: string;
  readonly daysPerMonth: number;
  readonly monthsPerYear: number;
  readonly eraYears: string;
}

export interface SimulationSourceRef {
  readonly path: string;
  readonly sourceHash: string;
  readonly authority: SimulationAuthority;
  readonly entityId?: string;
  readonly excerpt?: string;
}

export interface SimulationDiagnostic {
  readonly id: string;
  readonly severity: "blocking" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export type ChapterContextMode = "none" | "after" | "before" | "branch";
export type NarrativeConstraintMode = "off" | "observe" | "guide" | "strict";

export interface WorldSimulationScenario {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly start: {
    readonly mode: "facts-anchor" | "custom";
    readonly sortKey: string;
  };
  readonly duration: WorldDuration;
  readonly outputScales: readonly TimeScale[];
  readonly calendar: SimulationCalendar;
  readonly chapterContext: {
    readonly mode: ChapterContextMode;
    readonly chapterId: string | null;
  };
  readonly narrativeContext: {
    readonly mode: NarrativeConstraintMode;
    readonly usePlotLines: boolean;
    readonly useStoryArcs: boolean;
    readonly useDirectoryOutline: boolean;
    readonly useChapterPlans: boolean;
    readonly selectedPlotLineIds: readonly string[];
    readonly selectedStoryArcIds: readonly string[];
    readonly selectedDirectoryIds: readonly string[];
    readonly selectedChapterPlanIds: readonly string[];
  };
  readonly scope: {
    readonly regionIds: readonly string[];
    readonly includeDescendants: boolean;
    readonly adjacencyDepth: number;
    readonly characterIds: readonly string[];
    readonly factionIds: readonly string[];
    readonly autoIncludeCounterparts: boolean;
    readonly outsidePolicy: "ignore" | "respond" | "approximate" | "full";
  };
  readonly authorConstraints: readonly string[];
  readonly intelligence: {
    readonly mode: "assisted" | "deterministic";
    readonly cadence: "each-step" | "milestones";
  };
  readonly seed: string;
  readonly maxSteps: number;
}

export interface KnowledgeProjection {
  readonly id: string;
  readonly statement: string;
  readonly authority: "fact" | "rumor" | "belief" | "secret";
  readonly confidence: number;
  readonly sourceEventId: string | null;
}

export interface CharacterProjection {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: string;
  readonly locationId: string | null;
  readonly factionIds: readonly string[];
  readonly goals: readonly string[];
  readonly personality: readonly string[];
  readonly values: readonly string[];
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly fears: readonly string[];
  readonly motivation: readonly string[];
  readonly innerConflict: readonly string[];
  readonly relations: readonly {
    readonly targetId: string;
    readonly type: string;
    readonly tone: "positive" | "negative" | "neutral";
    readonly summary: string;
  }[];
  readonly cultivation: {
    readonly systemId: string | null;
    readonly trackId: string | null;
    readonly levelId: string | null;
    readonly levelName: string;
    readonly levelOrder: number;
    readonly methodIds: readonly string[];
    readonly abilityIds: readonly string[];
    readonly resourceBalances: Readonly<Record<string, number>>;
    readonly activeConstraintIds: readonly string[];
  };
  readonly ageYears: number | null;
  readonly lifespanYears: number | null;
  readonly lifespanLossYears: number;
  readonly inventoryItemIds: readonly string[];
  readonly knowledge: readonly KnowledgeProjection[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface FactionProjection {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly summary: string;
  readonly goals: readonly string[];
  readonly territoryIds: readonly string[];
  readonly leaderCharacterIds: readonly string[];
  readonly memberCharacterIds: readonly string[];
  readonly resources: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly control: string;
    readonly controlLevel: string;
    readonly regionId: string | null;
    readonly itemId: string | null;
    readonly competingFactionIds: readonly string[];
  }[];
  readonly relations: readonly {
    readonly targetFactionId: string;
    readonly kind: string;
    readonly direction: string;
    readonly status: string;
    readonly description: string;
  }[];
  readonly stateText: {
    readonly governance: string;
    readonly military: string;
    readonly economy: string;
    readonly publicSupport: string;
    readonly territorialIntegrity: string;
  };
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export type SpatialConnectionKind =
  | "containment"
  | "adjacent"
  | "road"
  | "trade"
  | "teleport"
  | "information";

export interface SpatialConnection {
  readonly id: string;
  readonly fromRegionId: string;
  readonly toRegionId: string;
  readonly kind: SpatialConnectionKind;
  readonly travelDays: string;
  readonly capacity: number;
  readonly attenuation: number;
  readonly bidirectional: boolean;
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface RegionProjection {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly summary: string;
  readonly rulerFactionIds: readonly string[];
  readonly activeFactionIds: readonly string[];
  readonly residentCharacterIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly culture: readonly string[];
  readonly rules: readonly string[];
  readonly connections: readonly SpatialConnection[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface ItemProjection {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: string;
  readonly summary: string;
  readonly ownerType: "character" | "faction" | null;
  readonly ownerId: string | null;
  readonly locationId: string | null;
  readonly capabilities: readonly string[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface CultivationSystemProjection {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly summary: string;
  readonly levels: readonly {
    readonly id: string;
    readonly name: string;
    readonly order: number;
    readonly trackId: string;
    readonly breakthroughConditions: readonly string[];
    readonly resourceIds: readonly string[];
  }[];
  readonly transitions: readonly {
    readonly id: string;
    readonly fromLevelId: string | null;
    readonly toLevelId: string | null;
    readonly type: string;
    readonly conditions: readonly string[];
    readonly result: string;
  }[];
  readonly hardConstraints: readonly string[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface RuleProjection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: "hard" | "soft";
  readonly regionId: string | null;
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface TimelineEventProjection {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly time: WorldInstant;
  readonly authority: "actual" | "planned";
  readonly characterIds: readonly string[];
  readonly factionIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly chapterIds: readonly string[];
  readonly causeEventIds: readonly string[];
  readonly stateChanges: readonly {
    readonly entityType: "character" | "faction" | "item" | "location";
    readonly entityId: string;
    readonly before: string;
    readonly after: string;
    readonly note: string;
  }[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface NarrativeConstraintProjection {
  readonly id: string;
  readonly kind: "plot-line" | "story-arc" | "outline" | "chapter-plan";
  readonly title: string;
  readonly content: string;
  readonly mode: "observe" | "guide" | "strict";
  readonly entityIds: readonly string[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface ChapterProjection {
  readonly id: string;
  readonly title: string;
  readonly displayNumber: number;
  readonly status: string;
  readonly content: string;
  readonly narrativeChapterId: string | null;
  readonly linkedTimelineEventIds: readonly string[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface WorldSimulationBaseline {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly baselineId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly sourceRevision: string;
  readonly compiledAt: string;
  readonly anchor: WorldInstant;
  readonly factsThroughEventId: string | null;
  readonly calendar: SimulationCalendar;
  readonly characters: readonly CharacterProjection[];
  readonly factions: readonly FactionProjection[];
  readonly regions: readonly RegionProjection[];
  readonly items: readonly ItemProjection[];
  readonly cultivationSystems: readonly CultivationSystemProjection[];
  readonly rules: readonly RuleProjection[];
  readonly timelineFacts: readonly TimelineEventProjection[];
  readonly timelinePlans: readonly TimelineEventProjection[];
  readonly narrativeConstraints: readonly NarrativeConstraintProjection[];
  readonly chapters: readonly ChapterProjection[];
  readonly diagnostics: readonly SimulationDiagnostic[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export interface CharacterRuntimeState {
  readonly id: string;
  readonly alive: boolean;
  readonly status: string;
  readonly locationId: string | null;
  readonly travel: {
    readonly fromRegionId: string | null;
    readonly toRegionId: string;
    readonly arrivalSortKey: string;
  } | null;
  readonly intent: string;
  readonly ageDays: string;
  readonly cultivationProgress: number;
  readonly levelId: string | null;
  readonly knowledgeIds: readonly string[];
}

export interface FactionRuntimeState {
  readonly id: string;
  readonly lifecycle:
    | "rising"
    | "expanding"
    | "peak"
    | "stagnating"
    | "declining"
    | "fragmented"
    | "dissolved";
  readonly strategy: string;
  readonly governance: number;
  readonly military: number;
  readonly economy: number;
  readonly publicSupport: number;
  readonly territorialIntegrity: number;
}

export interface RegionRuntimeState {
  readonly id: string;
  readonly pressure: number;
  readonly stability: number;
  readonly economy: number;
  readonly population: number;
  readonly cultivation: number;
  readonly ecology: number;
  readonly controllingFactionIds: readonly string[];
}

export interface ItemRuntimeState {
  readonly id: string;
  readonly status: string;
  readonly ownerType: "character" | "faction" | null;
  readonly ownerId: string | null;
  readonly locationId: string | null;
}

/**
 * 已由确定性内核接受、但尚未抵达目标地域的影响。
 * 它与事件账本一起重放，不能由模型直接伪造到达结果。
 */
export interface ScheduledWorldEffect {
  readonly id: string;
  readonly kind: "propagation";
  readonly dueSortKey: string;
  readonly sourceEventId: string;
  readonly connectionId: string;
  readonly originRegionId: string;
  readonly targetRegionId: string;
  readonly pressureDelta: number;
  readonly stabilityDelta: number;
}

export interface WorldRuntimeState {
  readonly currentTime: WorldInstant;
  readonly characters: readonly CharacterRuntimeState[];
  readonly factions: readonly FactionRuntimeState[];
  readonly regions: readonly RegionRuntimeState[];
  readonly items: readonly ItemRuntimeState[];
  readonly scheduledEffects: readonly ScheduledWorldEffect[];
  readonly entropy: number;
}

export type WorldDomainCommand =
  | {
      readonly type: "character.intent";
      readonly characterId: string;
      readonly intent: string;
      readonly status: string;
    }
  | {
      readonly type: "character.move";
      readonly characterId: string;
      readonly fromRegionId: string | null;
      readonly toRegionId: string;
      readonly arrivalSortKey: string;
    }
  | {
      readonly type: "character.arrive";
      readonly characterId: string;
      readonly toRegionId: string;
    }
  | {
      readonly type: "character.cultivate";
      readonly characterId: string;
      readonly progressDelta: number;
      readonly nextLevelId: string | null;
    }
  | {
      readonly type: "character.life";
      readonly characterId: string;
      readonly alive: boolean;
      readonly status: string;
    }
  | {
      readonly type: "character.knowledge";
      readonly characterId: string;
      readonly knowledgeId: string;
    }
  | {
      readonly type: "faction.strategy";
      readonly factionId: string;
      readonly strategy: string;
      readonly lifecycle?: FactionRuntimeState["lifecycle"];
    }
  | {
      readonly type: "faction.metric";
      readonly factionId: string;
      readonly metric:
        | "governance"
        | "military"
        | "economy"
        | "publicSupport"
        | "territorialIntegrity";
      readonly delta: number;
    }
  | {
      readonly type: "region.metric";
      readonly regionId: string;
      readonly metric:
        | "pressure"
        | "stability"
        | "economy"
        | "population"
        | "cultivation"
        | "ecology";
      readonly delta: number;
    }
  | {
      readonly type: "region.control";
      readonly regionId: string;
      readonly factionIds: readonly string[];
    }
  | {
      readonly type: "item.transfer";
      readonly itemId: string;
      readonly ownerType: "character" | "faction" | null;
      readonly ownerId: string | null;
      readonly locationId: string | null;
      readonly status?: string;
    }
  | {
      readonly type: "effect.schedule";
      readonly effect: ScheduledWorldEffect;
    }
  | {
      readonly type: "effect.consume";
      readonly effectId: string;
    };

export interface SimulationEvidence {
  readonly type:
    | "world-rule"
    | "fact"
    | "knowledge"
    | "goal"
    | "resource"
    | "spatial-path"
    | "narrative-constraint"
    | "random-seed";
  readonly label: string;
  readonly detail: string;
  readonly authority: SimulationAuthority;
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export type SimulationEventKind =
  | "character-action"
  | "faction-strategy"
  | "conflict"
  | "diplomacy"
  | "cultivation"
  | "lifecycle"
  | "propagation"
  | "world-process"
  | "epoch";

export interface SimulationEvent {
  readonly id: string;
  readonly sequence: number;
  readonly time: WorldInstant;
  readonly scale: TimeScale;
  readonly kind: SimulationEventKind;
  readonly title: string;
  readonly summary: string;
  readonly characterIds: readonly string[];
  readonly factionIds: readonly string[];
  readonly regionIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly causeEventIds: readonly string[];
  readonly evidence: readonly SimulationEvidence[];
  readonly commands: readonly WorldDomainCommand[];
  readonly narrativeConstraintIds: readonly string[];
  readonly generatedBy: "kernel" | "model" | "fallback";
  readonly confidence: number;
}

export interface ObservationPoint {
  readonly id: string;
  readonly scale: TimeScale;
  readonly startSortKey: string;
  readonly endSortKey: string;
  readonly title: string;
  readonly summary: string;
  readonly eventIds: readonly string[];
  readonly dominantRegionIds: readonly string[];
  readonly dominantActorIds: readonly string[];
  readonly trend: "stable" | "rising" | "falling" | "volatile" | "transforming";
}

export interface SimulationCheckpoint {
  readonly id: string;
  readonly label: string;
  readonly eventSequence: number;
  readonly createdAt: string;
  readonly state: WorldRuntimeState;
}

export interface SimulationBranch {
  readonly id: string;
  readonly name: string;
  readonly parentBranchId: string | null;
  readonly forkEventId: string | null;
  /** 对照分支禁用剧情工程，仍共享同一事实基线与随机种子。 */
  readonly narrativePolicy: "configured" | "disabled";
  readonly seed: string;
  readonly status: "ready" | "running" | "paused" | "completed" | "cancelled";
  readonly state: WorldRuntimeState;
  readonly ledger: readonly SimulationEvent[];
  readonly observations: readonly ObservationPoint[];
  readonly checkpoints: readonly SimulationCheckpoint[];
  readonly warnings: readonly string[];
}

export interface CouncilOption {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
  readonly costs: readonly string[];
  readonly benefits: readonly string[];
  readonly commands: readonly WorldDomainCommand[];
}

export interface CouncilStance {
  readonly participantType: "character" | "faction";
  readonly participantId: string;
  readonly knownFactIds: readonly string[];
  readonly goal: string;
  readonly position: string;
  readonly risks: readonly string[];
  readonly optionIds: readonly string[];
}

export interface CouncilSession {
  readonly id: string;
  readonly branchId: string;
  readonly eventId: string | null;
  readonly question: string;
  readonly createdAt: string;
  readonly status: "draft" | "reviewed" | "committed";
  readonly generatedBy: "model" | "fallback";
  readonly degradedReason: string | null;
  readonly stances: readonly CouncilStance[];
  readonly options: readonly CouncilOption[];
  readonly selectedOptionId: string | null;
}

export type SimulationReportKind =
  | "world-overview"
  | "multi-scale"
  | "actors"
  | "factions"
  | "regions"
  | "causal"
  | "narrative"
  | "risk";

export interface SimulationReportSection {
  readonly id: string;
  readonly kind: SimulationReportKind;
  readonly title: string;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly eventIds: readonly string[];
  readonly entityIds: readonly string[];
  readonly severity: "info" | "warning" | "critical";
}

export interface SimulationReport {
  readonly id: string;
  readonly branchId: string;
  readonly title: string;
  readonly summary: string;
  readonly generatedAt: string;
  readonly generatedBy: "model" | "fallback";
  readonly degradedReason: string | null;
  readonly throughEventSequence: number;
  readonly sections: readonly SimulationReportSection[];
}

export type SimulationAdoptionAuthority = "planned" | "author-secret" | "actual";

export interface WorldSimulationRun {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly scenario: WorldSimulationScenario;
  readonly baseline: WorldSimulationBaseline;
  readonly activeBranchId: string;
  readonly branches: readonly SimulationBranch[];
  readonly councilSessions: readonly CouncilSession[];
  readonly reports: readonly SimulationReport[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorldSimulationRunManifestBranch {
  readonly id: string;
  readonly name: string;
  readonly parentBranchId: string | null;
  readonly forkEventId: string | null;
  readonly narrativePolicy: SimulationBranch["narrativePolicy"];
  readonly seed: string;
  readonly status: SimulationBranch["status"];
  readonly warnings: readonly string[];
  readonly statePath: string;
  readonly eventLedgerPath: string;
  readonly observationsPath: string;
  readonly checkpointsPath: string;
}

/**
 * run.json 只负责定位一次推演运行的模块文件。大型基线、状态和历史记录
 * 分别保存在其声明的文件中，不得再次内嵌到清单。
 */
export interface WorldSimulationRunManifest {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly storageVersion: typeof WORLD_SIMULATION_RUN_STORAGE_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly scenario: WorldSimulationScenario;
  readonly baselinePath: string;
  readonly activeBranchId: string;
  readonly branches: readonly WorldSimulationRunManifestBranch[];
  readonly councilPath: string;
  readonly reportsPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SimulationScenarioFile {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly scenarios: readonly WorldSimulationScenario[];
  readonly activeScenarioId: string | null;
}

export interface SimulationRunIndexEntry {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly activeBranchId: string;
  readonly status: SimulationBranch["status"];
  readonly currentSortKey: string;
  readonly eventCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SimulationRunIndexFile {
  readonly schemaVersion: typeof WORLD_SIMULATION_SCHEMA_VERSION;
  readonly runs: readonly SimulationRunIndexEntry[];
  readonly activeRunId: string | null;
}

const integerStringSchema = z.string().regex(/^-?\d+$/u);
const idSchema = z.string().trim().min(1);
const timeScaleSchema = z.enum([
  "day",
  "month",
  "year",
  "century",
  "millennium",
  "ten-thousand-years",
  "hundred-billion-years",
  "trillion-years",
]);

export const worldSimulationScenarioSchema: z.ZodType<WorldSimulationScenario> = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1),
    objective: z.string(),
    start: z.object({ mode: z.enum(["facts-anchor", "custom"]), sortKey: integerStringSchema }).strict(),
    duration: z.object({ amount: integerStringSchema.refine((value) => BigInt(value) > 0n), unit: z.enum([...timeScaleSchema.options, "era"]) }).strict(),
    outputScales: z.array(timeScaleSchema).min(1),
    calendar: z.object({
      id: idSchema,
      name: z.string().trim().min(1),
      daysPerMonth: z.number().int().positive().max(10_000),
      monthsPerYear: z.number().int().positive().max(10_000),
      eraYears: integerStringSchema.refine((value) => BigInt(value) > 0n),
    }).strict(),
    chapterContext: z.object({ mode: z.enum(["none", "after", "before", "branch"]), chapterId: idSchema.nullable() }).strict(),
    narrativeContext: z.object({
      mode: z.enum(["off", "observe", "guide", "strict"]),
      usePlotLines: z.boolean(),
      useStoryArcs: z.boolean(),
      useDirectoryOutline: z.boolean(),
      useChapterPlans: z.boolean(),
      selectedPlotLineIds: z.array(idSchema),
      selectedStoryArcIds: z.array(idSchema),
      selectedDirectoryIds: z.array(idSchema),
      selectedChapterPlanIds: z.array(idSchema),
    }).strict(),
    scope: z.object({
      regionIds: z.array(idSchema),
      includeDescendants: z.boolean(),
      adjacencyDepth: z.number().int().min(0).max(8),
      characterIds: z.array(idSchema),
      factionIds: z.array(idSchema),
      autoIncludeCounterparts: z.boolean(),
      outsidePolicy: z.enum(["ignore", "respond", "approximate", "full"]),
    }).strict(),
    authorConstraints: z.array(z.string().trim().min(1)),
    intelligence: z.object({
      mode: z.enum(["assisted", "deterministic"]),
      cadence: z.enum(["each-step", "milestones"]),
    }).strict(),
    seed: z.string().trim().min(1),
    maxSteps: z.number().int().min(1).max(512),
  })
  .strict();

const scenarioFileSchema: z.ZodType<SimulationScenarioFile> = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    scenarios: z.array(worldSimulationScenarioSchema),
    activeScenarioId: idSchema.nullable(),
  })
  .strict();

const runIndexSchema: z.ZodType<SimulationRunIndexFile> = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    runs: z.array(z.object({
      id: idSchema,
      projectId: idSchema,
      name: z.string().trim().min(1),
      scenarioId: idSchema,
      activeBranchId: idSchema,
      status: z.enum(["ready", "running", "paused", "completed", "cancelled"]),
      currentSortKey: integerStringSchema,
      eventCount: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }).strict()),
    activeRunId: idSchema.nullable(),
  })
  .strict();

export function createDefaultWorldSimulationScenario(): WorldSimulationScenario {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    id: "scenario-natural-evolution",
    name: "自然演化观察",
    objective: "从事实终点开始，观察目标地域中的人物、势力与世界过程如何相互作用。",
    start: { mode: "facts-anchor", sortKey: "0" },
    duration: { amount: "100", unit: "year" },
    outputScales: ["day", "year", "century"],
    calendar: {
      id: "cosmic",
      name: "世界纪年",
      daysPerMonth: 30,
      monthsPerYear: 12,
      eraYears: "100000000",
    },
    chapterContext: { mode: "none", chapterId: null },
    narrativeContext: {
      mode: "observe",
      usePlotLines: true,
      useStoryArcs: true,
      useDirectoryOutline: false,
      useChapterPlans: false,
      selectedPlotLineIds: [],
      selectedStoryArcIds: [],
      selectedDirectoryIds: [],
      selectedChapterPlanIds: [],
    },
    scope: {
      regionIds: [],
      includeDescendants: true,
      adjacencyDepth: 1,
      characterIds: [],
      factionIds: [],
      autoIncludeCounterparts: true,
      outsidePolicy: "respond",
    },
    authorConstraints: ["不得把未来规划当作已发生事实"],
    intelligence: { mode: "assisted", cadence: "milestones" },
    seed: "world-seed-1",
    maxSteps: 48,
  };
}

export function createEmptySimulationScenarioFile(): SimulationScenarioFile {
  const scenario = createDefaultWorldSimulationScenario();
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    scenarios: [scenario],
    activeScenarioId: scenario.id,
  };
}

export function createEmptySimulationRunIndex(): SimulationRunIndexFile {
  return { schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, runs: [], activeRunId: null };
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(`${label}无法解析：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function parseSimulationScenarioFile(content: string): SimulationScenarioFile {
  const result = scenarioFileSchema.safeParse(parseJson(content, "世界推演方案"));
  if (!result.success) {
    throw new Error(`世界推演方案格式无效：${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`);
  }
  return result.data;
}

export function parseSimulationRunIndex(content: string): SimulationRunIndexFile {
  const result = runIndexSchema.safeParse(parseJson(content, "世界推演运行索引"));
  if (!result.success) {
    throw new Error(`世界推演运行索引格式无效：${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`);
  }
  return result.data;
}

export function parseWorldSimulationRun(content: string): WorldSimulationRun {
  const value = parseJson(content, "世界推演运行");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("世界推演运行格式无效：根节点必须是对象");
  }
  const candidate = value as Partial<WorldSimulationRun>;
  if (candidate.schemaVersion !== WORLD_SIMULATION_SCHEMA_VERSION) {
    throw new Error("世界推演运行版本无效；当前版本不读取旧版推演数据");
  }
  if (!candidate.id || !candidate.projectId || !candidate.scenario || !candidate.baseline || !Array.isArray(candidate.branches)) {
    throw new Error("世界推演运行格式无效：缺少运行、基线或分支数据");
  }
  return candidate as WorldSimulationRun;
}

function assertSimulationPathId(id: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new Error(`${label} 只能使用小写字母、数字和连字符`);
  }
  return id;
}

export function worldSimulationRunRoot(runId: string): string {
  return `${WORLD_SIMULATION_PATHS.runRoot}/${assertSimulationPathId(runId, "推演运行 id")}`;
}

export function worldSimulationRunBaselinePath(runId: string): string {
  return `${worldSimulationRunRoot(runId)}/baseline.json`;
}

export function worldSimulationRunCouncilPath(runId: string): string {
  return `${worldSimulationRunRoot(runId)}/council.json`;
}

export function worldSimulationRunReportsPath(runId: string): string {
  return `${worldSimulationRunRoot(runId)}/reports/index.json`;
}

export function worldSimulationBranchRoot(runId: string, branchId: string): string {
  return `${worldSimulationRunRoot(runId)}/branches/${assertSimulationPathId(branchId, "推演分支 id")}`;
}

export function worldSimulationBranchStatePath(runId: string, branchId: string): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/state.json`;
}

export function worldSimulationBranchEventLedgerPath(runId: string, branchId: string): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/${WORLD_SIMULATION_PATHS.branchEventLedgerFile}`;
}

export function worldSimulationBranchObservationsPath(runId: string, branchId: string): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/observations.json`;
}

export function worldSimulationBranchCheckpointsPath(runId: string, branchId: string): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/${WORLD_SIMULATION_PATHS.branchCheckpointsFile}`;
}

export function createWorldSimulationRunManifest(run: WorldSimulationRun): WorldSimulationRunManifest {
  const branches = run.branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    parentBranchId: branch.parentBranchId,
    forkEventId: branch.forkEventId,
    narrativePolicy: branch.narrativePolicy,
    seed: branch.seed,
    status: branch.status,
    warnings: branch.warnings,
    statePath: worldSimulationBranchStatePath(run.id, branch.id),
    eventLedgerPath: worldSimulationBranchEventLedgerPath(run.id, branch.id),
    observationsPath: worldSimulationBranchObservationsPath(run.id, branch.id),
    checkpointsPath: worldSimulationBranchCheckpointsPath(run.id, branch.id),
  }));
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    storageVersion: WORLD_SIMULATION_RUN_STORAGE_VERSION,
    id: run.id,
    projectId: run.projectId,
    name: run.name,
    scenario: run.scenario,
    baselinePath: worldSimulationRunBaselinePath(run.id),
    activeBranchId: run.activeBranchId,
    branches,
    councilPath: worldSimulationRunCouncilPath(run.id),
    reportsPath: worldSimulationRunReportsPath(run.id),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function assertManifestPath(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} 必须是 ${expected}`);
}

export function parseWorldSimulationRunManifest(content: string): WorldSimulationRunManifest {
  const value = parseJson(content, "世界推演运行清单");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("世界推演运行清单格式无效：根节点必须是对象");
  }
  const candidate = value as Partial<WorldSimulationRunManifest>;
  if (candidate.schemaVersion !== WORLD_SIMULATION_SCHEMA_VERSION) {
    throw new Error("世界推演运行清单版本无效；当前版本不读取旧版推演数据");
  }
  if (candidate.storageVersion !== WORLD_SIMULATION_RUN_STORAGE_VERSION) {
    throw new Error("世界推演运行清单存储版本无效；当前版本不读取单文件运行数据");
  }
  if (
    !candidate.id ||
    !candidate.projectId ||
    !candidate.name ||
    !candidate.scenario ||
    !candidate.activeBranchId ||
    !Array.isArray(candidate.branches) ||
    !candidate.createdAt ||
    !candidate.updatedAt
  ) {
    throw new Error("世界推演运行清单格式无效：缺少运行身份、方案或分支目录");
  }
  const runId = assertSimulationPathId(candidate.id, "推演运行 id");
  const scenario = worldSimulationScenarioSchema.safeParse(candidate.scenario);
  if (!scenario.success) {
    throw new Error(`世界推演运行清单方案格式无效：${scenario.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`);
  }
  assertManifestPath(candidate.baselinePath, worldSimulationRunBaselinePath(runId), "baselinePath");
  assertManifestPath(candidate.councilPath, worldSimulationRunCouncilPath(runId), "councilPath");
  assertManifestPath(candidate.reportsPath, worldSimulationRunReportsPath(runId), "reportsPath");
  const branchIds = new Set<string>();
  for (const [index, branch] of candidate.branches.entries()) {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
      throw new Error(`世界推演运行清单格式无效：branches.${index} 必须是对象`);
    }
    const branchId = assertSimulationPathId(branch.id, `branches.${index}.id`);
    if (
      typeof branch.name !== "string" ||
      typeof branch.seed !== "string" ||
      !["configured", "disabled"].includes(branch.narrativePolicy) ||
      !["ready", "running", "paused", "completed", "cancelled"].includes(branch.status) ||
      !Array.isArray(branch.warnings) ||
      branch.warnings.some((warning: unknown) => typeof warning !== "string")
    ) {
      throw new Error(`世界推演运行清单格式无效：branches.${index} 缺少分支元数据`);
    }
    if (branchIds.has(branchId)) throw new Error(`世界推演运行清单包含重复分支：${branchId}`);
    branchIds.add(branchId);
    assertManifestPath(branch.statePath, worldSimulationBranchStatePath(runId, branchId), `branches.${index}.statePath`);
    assertManifestPath(branch.eventLedgerPath, worldSimulationBranchEventLedgerPath(runId, branchId), `branches.${index}.eventLedgerPath`);
    assertManifestPath(branch.observationsPath, worldSimulationBranchObservationsPath(runId, branchId), `branches.${index}.observationsPath`);
    assertManifestPath(branch.checkpointsPath, worldSimulationBranchCheckpointsPath(runId, branchId), `branches.${index}.checkpointsPath`);
  }
  if (!branchIds.has(candidate.activeBranchId)) {
    throw new Error("世界推演运行清单的当前分支不存在");
  }
  return { ...candidate, scenario: scenario.data } as WorldSimulationRunManifest;
}

export function serializeWorldSimulation(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function worldSimulationRunPath(runId: string): string {
  return `${worldSimulationRunRoot(runId)}/run.json`;
}
