import { z } from "zod";

// V4 is a new world-simulation contract. Older simulation scenarios and runs
// are intentionally rejected instead of migrated.
export const WORLD_SIMULATION_SCHEMA_VERSION = 4 as const;
export const WORLD_SIMULATION_RUN_STORAGE_VERSION = 1 as const;
export const WORLD_SIMULATION_ENGINE_VERSION = "world-kernel-1" as const;
export const WORLD_SIMULATION_RULESET_VERSION = "ruleset-1" as const;
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
  | "ten-day"
  | "month"
  | "quarter"
  | "three-month"
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

export interface WorldSimulationObserver {
  readonly kind: "ensemble" | "character" | "faction" | "mortal";
  readonly entityId: string | null;
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
  /** 每轮严格推进的世界时间跨度；最后一轮可以在总范围终点截断。 */
  readonly roundSpan: WorldDuration;
  /** 叙事镜头，不改变世界状态的推进范围。 */
  readonly observer: WorldSimulationObserver;
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
  /** 运行允许保留的最大分支数，包含主分支。 */
  readonly maxBranches?: number;
  readonly maxEvents?: number;
  readonly maxDecisions?: number;
  readonly maxModelCalls?: number;
  /** 同一时间边界内允许并发发出的主体模型请求数。 */
  readonly maxModelConcurrency?: number;
  /** 传播影响最多经过的空间跳数；缺省为 3，避免传播图环路无限排程。 */
  readonly maxPropagationHops?: number;
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
  /** 编译后的世界架构语义。旧基线缺失时按 hard-boundary 处理。 */
  readonly kind?:
    | "periodic"
    | "conditional"
    | "lifecycle"
    | "hard-boundary"
    | "world-process";
  /** 周期规则的间隔，使用世界日 bigint 字符串，避免长尺度溢出。 */
  readonly intervalDays?: string;
  /** 周期规则的聚合说明，供舞台和报告使用。 */
  readonly aggregationLabel?: string;
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

/**
 * 经作者应用、逐字证据仍有效的正文状态批次。它与正式时间线事件并列，
 * 但只会在启用章节上下文时按章节模式进入该次沙盒基线。
 */
export interface ChapterFactProjection extends TimelineEventProjection {
  readonly authority: "actual";
  readonly timelineEventId: string;
  readonly chapterId: string;
  readonly chapterOrder: number;
  readonly batchId: string;
  readonly changeIds: readonly string[];
}

export interface NarrativeConstraintProjection {
  readonly id: string;
  readonly kind: "plot-line" | "story-arc" | "outline" | "chapter-plan";
  readonly title: string;
  readonly content: string;
  readonly mode: "observe" | "guide" | "strict";
  readonly entityIds: readonly string[];
  /** 旧基线可能没有地域关联，读取时按空数组兼容。 */
  readonly regionIds?: readonly string[];
  readonly timeWindow?: {
    readonly startSortKey: string | null;
    readonly endSortKey: string | null;
  };
  readonly requiredOutcomes?: readonly NarrativeOutcomeProjection[];
  readonly forbiddenOutcomes?: readonly NarrativeOutcomeProjection[];
  /** 旧基线缺失时按 50 处理，仅影响观察评分，不改变旧约束文本语义。 */
  readonly flexibility?: number;
  readonly sourceRefs: readonly SimulationSourceRef[];
}

export type NarrativeOutcomeProjection =
  | {
      readonly id: string;
      readonly kind: "event";
      readonly eventKind: SimulationEventKind;
      readonly entityIds: readonly string[];
      readonly regionIds: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "command";
      readonly commandType: WorldDomainCommand["type"];
      readonly entityType: "character" | "faction" | "region" | "item" | null;
      readonly entityId: string | null;
      readonly field: string | null;
      readonly operator: "exists" | "equals" | "contains";
      readonly value: string | number | boolean | null;
    };

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
  /** 旧 V3 基线缺省时按空数组读取，避免为新增投影字段拒绝历史运行。 */
  readonly chapterFacts?: readonly ChapterFactProjection[];
  readonly narrativeConstraints: readonly NarrativeConstraintProjection[];
  readonly chapters: readonly ChapterProjection[];
  readonly diagnostics: readonly SimulationDiagnostic[];
  readonly sourceRefs: readonly SimulationSourceRef[];
}

/**
 * 人物在运行分支中的长期记忆索引。正文知识仍由基线提供内容，
 * 运行态只保存记忆强度和时间游标，保证跨检查点重放时不复制事实源。
 */
export interface CharacterMemoryState {
  readonly knowledgeId: string;
  readonly strength: number;
  readonly firstKnownSortKey: string;
  readonly lastRecalledSortKey: string;
}

/** 人物关系在运行分支中的可重放数值与生命周期状态。 */
export interface CharacterRelationRuntimeState {
  readonly targetCharacterId: string;
  readonly affinity: number;
  readonly trust: number;
  readonly status: "active" | "strained" | "ended";
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
  readonly resourceBalances?: Readonly<Record<string, number>>;
  readonly knowledgeIds: readonly string[];
  readonly relations?: readonly CharacterRelationRuntimeState[];
  /** 旧运行清单可能没有该字段，读取时由内核从 knowledgeIds 兼容补齐。 */
  readonly memory?: readonly CharacterMemoryState[];
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
  /** 运行态外交关系；基线关系仍由 FactionProjection 提供事实来源。 */
  readonly relations?: readonly FactionRelationRuntimeState[];
}

export interface FactionRelationRuntimeState {
  readonly targetFactionId: string;
  readonly sentiment: number;
  readonly status: "active" | "suspended" | "ended";
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
  /** 从最初触发事件开始计数；旧运行缺失时按 0 兼容。 */
  readonly hop?: number;
  /**
   * 传播到达后可被目标地域人物回忆的既有知识索引。
   * 只允许引用人物基线中已经存在的 knowledge id，不能借传播凭空创造事实。
   */
  readonly knowledgeIds?: readonly string[];
}

export type EpochStage =
  | "regional"
  | "civilizational"
  | "world-law"
  | "cosmic"
  | "terminal";

/**
 * 长尺度运行态的可重放聚合。当前项目资料没有真实人口统计，
 * 因此 populationIndex/civilizationIndex 明确表示 0-100 聚合指数，
 * 不能被解释为精确人口或文明数量。
 */
export interface EpochRuntimeState {
  readonly stage: EpochStage;
  readonly cycle: string;
  readonly populationIndex: number;
  readonly civilizationIndex: number;
  readonly lawStability: number;
  readonly lastScale: TimeScale;
}

/**
 * 长尺度推演生成的沙盒主体。它们只属于当前运行分支，绝不自动写回人物库或势力库。
 */
export interface EmergentWorldEntityRuntimeState {
  readonly id: string;
  readonly kind: "character" | "faction" | "institution";
  readonly name: string;
  readonly regionId: string | null;
  readonly origin: string;
  readonly createdAtSortKey: string;
  readonly status: string;
}

export interface WorldRuntimeState {
  readonly currentTime: WorldInstant;
  readonly characters: readonly CharacterRuntimeState[];
  readonly factions: readonly FactionRuntimeState[];
  readonly regions: readonly RegionRuntimeState[];
  readonly items: readonly ItemRuntimeState[];
  readonly scheduledEffects: readonly ScheduledWorldEffect[];
  /** 旧运行缺失时按空数组读取；它们是运行态候选，不是正式资料。 */
  readonly emergentEntities?: readonly EmergentWorldEntityRuntimeState[];
  readonly entropy: number;
  readonly epoch: EpochRuntimeState;
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
      readonly resourceCosts?: Readonly<Record<string, number>>;
    }
  | {
      /** 一般行动对人物资源余额的增减；修炼突破仍使用 cultivate.resourceCosts。 */
      readonly type: "character.resource";
      readonly characterId: string;
      readonly resourceId: string;
      readonly delta: number;
    }
  | {
      readonly type: "character.relation";
      readonly characterId: string;
      readonly targetCharacterId: string;
      readonly affinityDelta: number;
      readonly trustDelta: number;
      readonly status?: CharacterRelationRuntimeState["status"];
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
      readonly type: "faction.relation";
      readonly factionId: string;
      readonly targetFactionId: string;
      readonly sentimentDelta: number;
      readonly status?: FactionRelationRuntimeState["status"];
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
      /** 仅内核可创建的长尺度沙盒主体，必须通过事件账本重放。 */
      readonly type: "world.emergent";
      readonly entity: EmergentWorldEntityRuntimeState;
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
  readonly degradedReason?: string;
  /** 模型候选的结构化决策审计，不等同于已接受的世界事实。 */
  readonly decisionAudit?: SimulationDecisionAudit;
  /** 经 Host 返回的原始模型文本，仅用于审计和重放诊断。 */
  readonly rawModelOutput?: string;
  /** 传播事件的可重放载荷，用于多跳传播时延续已筛选的知识。 */
  readonly propagationContext?: {
    readonly hop: number;
    readonly knowledgeIds: readonly string[];
    readonly distortedKnowledgeCount?: number;
  };
}

export interface SimulationDecisionAudit {
  readonly subject: {
    readonly type: "character" | "faction";
    readonly id: string;
  } | null;
  readonly objective: string;
  readonly perceivedFacts: readonly string[];
  readonly assumptions: readonly string[];
  readonly expectedUtility: number;
  readonly risks: readonly string[];
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
  /** 作者从舞台确认后才进入该分支的软护栏；不回写原运行。 */
  readonly guardrails?: readonly string[];
  /** 作者投递给候选层的未来线索，不是已发生事实或人物知识。 */
  readonly authorLeads?: readonly string[];
  readonly seed: string;
  readonly status: "ready" | "running" | "paused" | "completed" | "cancelled";
  readonly state: WorldRuntimeState;
  readonly ledger: readonly SimulationEvent[];
  readonly observations: readonly ObservationPoint[];
  readonly checkpoints: readonly SimulationCheckpoint[];
  readonly warnings: readonly string[];
  readonly decisionCount?: number;
  readonly modelCallCount?: number;
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

export type SimulationAdoptionAuthority =
  | "planned"
  | "author-secret"
  | "actual";

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
  readonly guardrails?: readonly string[];
  readonly authorLeads?: readonly string[];
  readonly seed: string;
  readonly status: SimulationBranch["status"];
  readonly warnings: readonly string[];
  /**
   * 运行计数属于分支清单元数据，必须和事件账本一起持久化，
   * 否则暂停后恢复会重新计算预算并破坏运行契约。
   */
  readonly decisionCount: number;
  readonly modelCallCount: number;
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
  readonly engineVersion: typeof WORLD_SIMULATION_ENGINE_VERSION;
  readonly rulesetVersion: typeof WORLD_SIMULATION_RULESET_VERSION;
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
  /**
   * 运行切换器只读取索引，不能为了展示每一项而加载完整账本。
   * 这些字段是可重建的展示摘要，不参与推演或重放。
   */
  readonly anchorDisplayText?: string;
  readonly duration?: WorldSimulationScenario["duration"];
  readonly roundSpan?: WorldSimulationScenario["roundSpan"];
  readonly branches?: readonly SimulationRunIndexBranchEntry[];
}

export interface SimulationRunIndexBranchEntry {
  readonly id: string;
  readonly name: string;
  readonly parentBranchId: string | null;
  readonly status: SimulationBranch["status"];
  readonly currentSortKey: string;
  readonly currentTimeDisplayText: string;
  readonly eventCount: number;
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
  "ten-day",
  "month",
  "quarter",
  "three-month",
  "year",
  "century",
  "millennium",
  "ten-thousand-years",
  "hundred-billion-years",
  "trillion-years",
]);

export const worldSimulationScenarioSchema: z.ZodType<WorldSimulationScenario> =
  z
    .object({
      schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
      id: idSchema,
      name: z.string().trim().min(1),
      objective: z.string(),
      start: z
        .object({
          mode: z.enum(["facts-anchor", "custom"]),
          sortKey: integerStringSchema,
        })
        .strict(),
      duration: z
        .object({
          amount: integerStringSchema.refine((value) => BigInt(value) > 0n),
          unit: z.enum([...timeScaleSchema.options, "era"]),
        })
        .strict(),
      roundSpan: z
        .object({
          amount: integerStringSchema.refine((value) => BigInt(value) > 0n),
          unit: z.enum([...timeScaleSchema.options, "era"]),
        })
        .strict(),
      observer: z
        .object({
          kind: z.enum(["ensemble", "character", "faction", "mortal"]),
          entityId: idSchema.nullable(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.kind === "ensemble" && value.entityId !== null) {
            context.addIssue({
              code: "custom",
              message: "多主体镜头不能绑定实体",
              path: ["entityId"],
            });
          }
          if (value.kind !== "ensemble" && value.entityId === null) {
            context.addIssue({
              code: "custom",
              message: "指定镜头必须选择观察对象",
              path: ["entityId"],
            });
          }
        }),
      outputScales: z.array(timeScaleSchema).min(1),
      calendar: z
        .object({
          id: idSchema,
          name: z.string().trim().min(1),
          daysPerMonth: z.number().int().positive().max(10_000),
          monthsPerYear: z.number().int().positive().max(10_000),
          eraYears: integerStringSchema.refine((value) => BigInt(value) > 0n),
        })
        .strict(),
      chapterContext: z
        .object({
          mode: z.enum(["none", "after", "before", "branch"]),
          chapterId: idSchema.nullable(),
        })
        .strict(),
      narrativeContext: z
        .object({
          mode: z.enum(["off", "observe", "guide", "strict"]),
          usePlotLines: z.boolean(),
          useStoryArcs: z.boolean(),
          useDirectoryOutline: z.boolean(),
          useChapterPlans: z.boolean(),
          selectedPlotLineIds: z.array(idSchema),
          selectedStoryArcIds: z.array(idSchema),
          selectedDirectoryIds: z.array(idSchema),
          selectedChapterPlanIds: z.array(idSchema),
        })
        .strict(),
      scope: z
        .object({
          regionIds: z.array(idSchema),
          includeDescendants: z.boolean(),
          adjacencyDepth: z.number().int().min(0).max(8),
          characterIds: z.array(idSchema),
          factionIds: z.array(idSchema),
          autoIncludeCounterparts: z.boolean(),
          outsidePolicy: z.enum(["ignore", "respond", "approximate", "full"]),
        })
        .strict(),
      authorConstraints: z.array(z.string().trim().min(1)),
      intelligence: z
        .object({
          mode: z.enum(["assisted", "deterministic"]),
          cadence: z.enum(["each-step", "milestones"]),
        })
        .strict(),
      seed: z.string().trim().min(1),
      maxSteps: z.number().int().min(1).max(512),
      maxBranches: z.number().int().min(1).max(128).optional(),
      maxEvents: z.number().int().min(1).max(100_000).optional(),
      maxDecisions: z.number().int().min(1).max(100_000).optional(),
      maxModelCalls: z.number().int().min(0).max(10_000).optional(),
      maxModelConcurrency: z.number().int().min(1).max(32).optional(),
      maxPropagationHops: z.number().int().min(0).max(8).optional(),
    })
    .strict();

const scenarioFileSchema: z.ZodType<SimulationScenarioFile> = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    scenarios: z.array(worldSimulationScenarioSchema),
    activeScenarioId: idSchema.nullable(),
  })
  .strict();

const runIndexDurationSchema = z
  .object({
    amount: integerStringSchema.refine((value) => BigInt(value) > 0n),
    unit: z.enum([...timeScaleSchema.options, "era"]),
  })
  .strict();

const runIndexBranchSchema: z.ZodType<SimulationRunIndexBranchEntry> = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    parentBranchId: idSchema.nullable(),
    status: z.enum(["ready", "running", "paused", "completed", "cancelled"]),
    currentSortKey: integerStringSchema,
    currentTimeDisplayText: z.string().trim().min(1),
    eventCount: z.number().int().nonnegative(),
  })
  .strict();

const runIndexSchema: z.ZodType<SimulationRunIndexFile> = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    runs: z.array(
      z
        .object({
          id: idSchema,
          projectId: idSchema,
          name: z.string().trim().min(1),
          scenarioId: idSchema,
          activeBranchId: idSchema,
          status: z.enum([
            "ready",
            "running",
            "paused",
            "completed",
            "cancelled",
          ]),
          currentSortKey: integerStringSchema,
          eventCount: z.number().int().nonnegative(),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
          anchorDisplayText: z.string().trim().min(1).optional(),
          duration: runIndexDurationSchema.optional(),
          roundSpan: runIndexDurationSchema.optional(),
          branches: z.array(runIndexBranchSchema).optional(),
        })
        .strict(),
    ),
    activeRunId: idSchema.nullable(),
  })
  .strict();

export function createDefaultWorldSimulationScenario(): WorldSimulationScenario {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    id: "scenario-natural-evolution",
    name: "自然演化观察",
    objective:
      "从事实终点开始，观察目标地域中的人物、势力与世界过程如何相互作用。",
    start: { mode: "facts-anchor", sortKey: "0" },
    duration: { amount: "100", unit: "year" },
    roundSpan: { amount: "1", unit: "year" },
    observer: { kind: "ensemble", entityId: null },
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
    maxBranches: 8,
    maxEvents: 2_048,
    maxDecisions: 1_024,
    maxModelCalls: 128,
    maxModelConcurrency: 4,
    maxPropagationHops: 3,
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
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    runs: [],
    activeRunId: null,
  };
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(
      `${label}无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export function parseSimulationScenarioFile(
  content: string,
): SimulationScenarioFile {
  const result = scenarioFileSchema.safeParse(
    parseJson(content, "世界推演方案"),
  );
  if (!result.success) {
    throw new Error(
      `世界推演方案格式无效：${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`,
    );
  }
  return result.data;
}

export function parseSimulationRunIndex(
  content: string,
): SimulationRunIndexFile {
  const result = runIndexSchema.safeParse(
    parseJson(content, "世界推演运行索引"),
  );
  if (!result.success) {
    throw new Error(
      `世界推演运行索引格式无效：${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`,
    );
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
  if (
    !candidate.id ||
    !candidate.projectId ||
    !candidate.scenario ||
    !candidate.baseline ||
    !Array.isArray(candidate.branches)
  ) {
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

export function worldSimulationBranchRoot(
  runId: string,
  branchId: string,
): string {
  return `${worldSimulationRunRoot(runId)}/branches/${assertSimulationPathId(branchId, "推演分支 id")}`;
}

export function worldSimulationBranchStatePath(
  runId: string,
  branchId: string,
): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/state.json`;
}

export function worldSimulationBranchEventLedgerPath(
  runId: string,
  branchId: string,
): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/${WORLD_SIMULATION_PATHS.branchEventLedgerFile}`;
}

export function worldSimulationBranchObservationsPath(
  runId: string,
  branchId: string,
): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/observations.json`;
}

export function worldSimulationBranchCheckpointsPath(
  runId: string,
  branchId: string,
): string {
  return `${worldSimulationBranchRoot(runId, branchId)}/${WORLD_SIMULATION_PATHS.branchCheckpointsFile}`;
}

export function createWorldSimulationRunManifest(
  run: WorldSimulationRun,
): WorldSimulationRunManifest {
  const branches = run.branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    parentBranchId: branch.parentBranchId,
    forkEventId: branch.forkEventId,
    narrativePolicy: branch.narrativePolicy,
    guardrails: branch.guardrails ?? [],
    authorLeads: branch.authorLeads ?? [],
    seed: branch.seed,
    status: branch.status,
    warnings: branch.warnings,
    decisionCount: branch.decisionCount ?? 0,
    modelCallCount: branch.modelCallCount ?? 0,
    statePath: worldSimulationBranchStatePath(run.id, branch.id),
    eventLedgerPath: worldSimulationBranchEventLedgerPath(run.id, branch.id),
    observationsPath: worldSimulationBranchObservationsPath(run.id, branch.id),
    checkpointsPath: worldSimulationBranchCheckpointsPath(run.id, branch.id),
  }));
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    storageVersion: WORLD_SIMULATION_RUN_STORAGE_VERSION,
    engineVersion: WORLD_SIMULATION_ENGINE_VERSION,
    rulesetVersion: WORLD_SIMULATION_RULESET_VERSION,
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

function assertManifestPath(
  actual: unknown,
  expected: string,
  label: string,
): void {
  if (actual !== expected) throw new Error(`${label} 必须是 ${expected}`);
}

export function parseWorldSimulationRunManifest(
  content: string,
): WorldSimulationRunManifest {
  const value = parseJson(content, "世界推演运行清单");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("世界推演运行清单格式无效：根节点必须是对象");
  }
  const candidate = value as Partial<WorldSimulationRunManifest>;
  if (candidate.schemaVersion !== WORLD_SIMULATION_SCHEMA_VERSION) {
    throw new Error("世界推演运行清单版本无效；当前版本不读取旧版推演数据");
  }
  if (candidate.storageVersion !== WORLD_SIMULATION_RUN_STORAGE_VERSION) {
    throw new Error(
      "世界推演运行清单存储版本无效；当前版本不读取单文件运行数据",
    );
  }
  if (
    candidate.engineVersion !== WORLD_SIMULATION_ENGINE_VERSION ||
    candidate.rulesetVersion !== WORLD_SIMULATION_RULESET_VERSION
  ) {
    throw new Error("推演运行清单的引擎或规则集版本不兼容");
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
    throw new Error(
      `世界推演运行清单方案格式无效：${scenario.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`,
    );
  }
  assertManifestPath(
    candidate.baselinePath,
    worldSimulationRunBaselinePath(runId),
    "baselinePath",
  );
  assertManifestPath(
    candidate.councilPath,
    worldSimulationRunCouncilPath(runId),
    "councilPath",
  );
  assertManifestPath(
    candidate.reportsPath,
    worldSimulationRunReportsPath(runId),
    "reportsPath",
  );
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
      (branch.guardrails !== undefined &&
        (!Array.isArray(branch.guardrails) ||
          branch.guardrails.some(
            (item: unknown) => typeof item !== "string",
          ))) ||
      (branch.authorLeads !== undefined &&
        (!Array.isArray(branch.authorLeads) ||
          branch.authorLeads.some(
            (item: unknown) => typeof item !== "string",
          ))) ||
      !["ready", "running", "paused", "completed", "cancelled"].includes(
        branch.status,
      ) ||
      !Array.isArray(branch.warnings) ||
      branch.warnings.some((warning: unknown) => typeof warning !== "string") ||
      (branch.decisionCount !== undefined &&
        (!Number.isInteger(branch.decisionCount) ||
          branch.decisionCount < 0)) ||
      (branch.modelCallCount !== undefined &&
        (!Number.isInteger(branch.modelCallCount) || branch.modelCallCount < 0))
    ) {
      throw new Error(
        `世界推演运行清单格式无效：branches.${index} 缺少分支元数据`,
      );
    }
    if (branchIds.has(branchId))
      throw new Error(`世界推演运行清单包含重复分支：${branchId}`);
    branchIds.add(branchId);
    assertManifestPath(
      branch.statePath,
      worldSimulationBranchStatePath(runId, branchId),
      `branches.${index}.statePath`,
    );
    assertManifestPath(
      branch.eventLedgerPath,
      worldSimulationBranchEventLedgerPath(runId, branchId),
      `branches.${index}.eventLedgerPath`,
    );
    assertManifestPath(
      branch.observationsPath,
      worldSimulationBranchObservationsPath(runId, branchId),
      `branches.${index}.observationsPath`,
    );
    assertManifestPath(
      branch.checkpointsPath,
      worldSimulationBranchCheckpointsPath(runId, branchId),
      `branches.${index}.checkpointsPath`,
    );
  }
  if (!branchIds.has(candidate.activeBranchId)) {
    throw new Error("世界推演运行清单的当前分支不存在");
  }
  return {
    ...candidate,
    scenario: scenario.data,
    // V3 初期运行清单没有计数元数据时，从零开始兼容读取；新写入总会显式保存。
    branches: candidate.branches.map((branch) => ({
      ...branch,
      authorLeads: branch.authorLeads ?? [],
      decisionCount: branch.decisionCount ?? 0,
      modelCallCount: branch.modelCallCount ?? 0,
    })),
  } as WorldSimulationRunManifest;
}

export function serializeWorldSimulation(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function worldSimulationRunPath(runId: string): string {
  return `${worldSimulationRunRoot(runId)}/run.json`;
}
