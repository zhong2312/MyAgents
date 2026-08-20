import {
  addWorldTicks,
  createWorldInstant,
  durationToDays,
  parseWorldTick,
  resolveEventScale,
  scaleToDays,
} from "./worldSimulationTime";
import { resolveWorldSimulationRegionScope } from "./worldSimulationScope";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  type CharacterProjection,
  type CharacterMemoryState,
  type CharacterRelationRuntimeState,
  type CharacterRuntimeState,
  type KnowledgeProjection,
  type CouncilOption,
  type CouncilSession,
  type CouncilStance,
  type EpochRuntimeState,
  type EpochStage,
  type EmergentWorldEntityRuntimeState,
  type FactionProjection,
  type FactionRelationRuntimeState,
  type ObservationPoint,
  type RegionProjection,
  type SimulationBranch,
  type SimulationCheckpoint,
  type SimulationEvent,
  type SimulationEventKind,
  type SimulationEvidence,
  type SimulationReport,
  type SimulationReportKind,
  type SimulationReportSection,
  type SpatialConnection,
  type TimeScale,
  type TimelineEventProjection,
  type NarrativeOutcomeProjection,
  type WorldDomainCommand,
  type WorldRuntimeState,
  type WorldSimulationBaseline,
  type WorldSimulationRun,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";

const MAX_DOMAIN_DELTA = 100;
/** 记忆衰减的固定半衰期（十年），使用整数比例以保证跨平台重放一致。 */
const MEMORY_HALF_LIFE_DAYS = 3_650n;

function decayMemoryStrength(strength: number, elapsedDays: bigint): number {
  if (strength <= 0 || elapsedDays <= 0n) return clamp(Math.round(strength));
  // 逐个半衰期处理，剩余天数按线性比例插值；全程 BigInt，避免超长纪元转 Number 溢出。
  const periods = elapsedDays / MEMORY_HALF_LIFE_DAYS;
  const remainder = elapsedDays % MEMORY_HALF_LIFE_DAYS;
  let result = BigInt(clamp(Math.round(strength)));
  if (periods >= 7n) return 0;
  for (let index = 0n; index < periods; index += 1n) {
    result = result / 2n;
    if (result === 0n) return 0;
  }
  if (remainder > 0n && result > 0n) {
    const numerator = result * (MEMORY_HALF_LIFE_DAYS - remainder);
    result = (numerator + MEMORY_HALF_LIFE_DAYS / 2n) / MEMORY_HALF_LIFE_DAYS;
  }
  return Number(result);
}

function decayCharacterMemory(
  runtime: CharacterRuntimeState,
  elapsedDays: bigint,
): CharacterRuntimeState {
  if (!runtime.memory || runtime.memory.length === 0 || elapsedDays <= 0n)
    return runtime;
  return {
    ...runtime,
    memory: runtime.memory.map((entry) => ({
      ...entry,
      strength: decayMemoryStrength(entry.strength, elapsedDays),
    })),
  };
}

function averageIndex(values: readonly number[], fallback = 50): number {
  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function initialEpochRuntimeState(
  regions: readonly { readonly population: number }[],
  factions: readonly {
    readonly governance: number;
    readonly military: number;
    readonly economy: number;
    readonly publicSupport: number;
    readonly territorialIntegrity: number;
  }[],
): EpochRuntimeState {
  return {
    stage: "regional",
    cycle: "0",
    populationIndex: clamp(
      averageIndex(regions.map((region) => region.population)),
    ),
    civilizationIndex: clamp(
      averageIndex(
        factions.map((faction) =>
          averageIndex([
            faction.governance,
            faction.military,
            faction.economy,
            faction.publicSupport,
            faction.territorialIntegrity,
          ]),
        ),
      ),
    ),
    lawStability: 100,
    lastScale: "day",
  };
}

function epochStageForScale(scale: TimeScale, current: EpochStage): EpochStage {
  if (scale === "trillion-years") return "terminal";
  if (scale === "hundred-billion-years") return "cosmic";
  if (scale === "ten-thousand-years") return "world-law";
  if (scale === "millennium" || scale === "century") {
    return current === "regional" ? "civilizational" : current;
  }
  return current;
}

function advanceEpochRuntimeState(
  epoch: EpochRuntimeState,
  stepDays: bigint,
  scale: TimeScale,
  calendar: WorldSimulationScenario["calendar"],
  runtimeRegions: readonly { readonly population: number }[],
  runtimeFactions: readonly {
    readonly governance: number;
    readonly military: number;
    readonly economy: number;
    readonly publicSupport: number;
    readonly territorialIntegrity: number;
  }[],
  entropy: number,
): EpochRuntimeState {
  const boundary = scaleToDays(scale, calendar);
  const cycles = stepDays / boundary;
  const cycleIncrement = cycles > 0n ? cycles : 1n;
  const targetPopulation = averageIndex(
    runtimeRegions.map((region) => region.population),
  );
  const targetCivilization = averageIndex(
    runtimeFactions.map((faction) =>
      averageIndex([
        faction.governance,
        faction.military,
        faction.economy,
        faction.publicSupport,
        faction.territorialIntegrity,
      ]),
    ),
  );
  const scaleRate =
    scale === "trillion-years"
      ? 0.4
      : scale === "hundred-billion-years"
        ? 0.3
        : scale === "ten-thousand-years"
          ? 0.2
          : 0.1;
  const lawDrift =
    scale === "trillion-years"
      ? -8
      : scale === "hundred-billion-years"
        ? -4
        : scale === "ten-thousand-years"
          ? -1
          : 0;
  return {
    stage: epochStageForScale(scale, epoch.stage),
    cycle: (parseWorldTick(epoch.cycle) + cycleIncrement).toString(),
    populationIndex: clamp(
      epoch.populationIndex +
        (targetPopulation - epoch.populationIndex) * scaleRate,
    ),
    civilizationIndex: clamp(
      epoch.civilizationIndex +
        (targetCivilization - epoch.civilizationIndex) * scaleRate,
    ),
    lawStability: clamp(epoch.lawStability + lawDrift - entropy / 100),
    lastScale: scale,
  };
}

export interface ModelDecisionCandidate {
  readonly title: string;
  readonly summary: string;
  readonly kind: SimulationEventKind;
  readonly characterIds: readonly string[];
  readonly factionIds: readonly string[];
  readonly regionIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly commands: readonly WorldDomainCommand[];
  readonly confidence: number;
  /** 候选主体认为本次行动要达成的目标。缺失时回退为方案总目标。 */
  readonly objective?: string;
  /** 候选实际依据的已知事实或知识 id，供事件账本审计。 */
  readonly perceivedFacts?: readonly string[];
  /** 候选中尚未被内核验证的前提。 */
  readonly assumptions?: readonly string[];
  /** 候选对收益的主观估计，限制为 0 到 100。 */
  readonly expectedUtility?: number;
  /** 候选显式识别的风险。 */
  readonly risks?: readonly string[];
}

export interface SimulationDecisionSubject {
  readonly type: "character" | "faction";
  readonly id: string;
}

export interface ModelDecisionSubmission {
  readonly subject: SimulationDecisionSubject | null;
  readonly candidate: ModelDecisionCandidate;
  /** Host 返回的原始文本，仅保留在已接受模型事件中用于审计。 */
  readonly rawModelOutput?: string;
}

export interface CouncilModelCandidate {
  readonly stances: readonly CouncilStance[];
  readonly options: readonly CouncilOption[];
}

export interface SimulationReportCandidate {
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly Omit<SimulationReportSection, "id">[];
}

export interface EpochNarrationCandidate {
  readonly title: string;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly eventIds: readonly string[];
}

const clamp = (value: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));
const clampSigned = (value: number) => clamp(value, -100, 100);

function relationToneValue(tone: "positive" | "negative" | "neutral"): number {
  return tone === "positive" ? 50 : tone === "negative" ? -50 : 0;
}

function initialCharacterRelations(
  character: CharacterProjection,
): readonly CharacterRelationRuntimeState[] {
  return character.relations.map((relation) => ({
    targetCharacterId: relation.targetId,
    affinity: relationToneValue(relation.tone),
    trust: relationToneValue(relation.tone),
    status: "active",
  }));
}

function initialFactionRelations(
  faction: FactionProjection,
): readonly FactionRelationRuntimeState[] {
  return faction.relations.map((relation) => ({
    targetFactionId: relation.targetFactionId,
    sentiment:
      relation.kind === "hostile" || relation.kind === "competitive"
        ? -50
        : relation.kind === "alliance" || relation.kind === "subordinate"
          ? 50
          : 0,
    status:
      relation.status === "ended"
        ? "ended"
        : relation.status === "suspended"
          ? "suspended"
          : "active",
  }));
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const code of new TextEncoder().encode(value)) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

interface PropagationKnowledgeSelection {
  readonly knowledgeIds: readonly string[];
  readonly distortedCount: number;
  readonly capacityDroppedCount: number;
}

/**
 * 传播载荷必须在每一条空间连接上重新裁定：容量限制载荷规模，
 * 谣言则按连接衰减和跳数用稳定哈希决定是否失真，保证重放不依赖随机源。
 */
function selectPropagationKnowledge(
  run: WorldSimulationRun,
  knowledgeIds: readonly string[],
  connection: SpatialConnection,
  hop: number,
  salt: string,
): PropagationKnowledgeSelection {
  const capacity = Math.max(
    0,
    Math.min(
      100,
      Number.isFinite(connection.capacity) ? connection.capacity : 0,
    ),
  );
  const uniqueIds = [...new Set(knowledgeIds)].sort();
  const capacityLimit = Math.max(1, Math.floor(capacity / 10));
  const candidates = uniqueIds.slice(0, capacityLimit);
  const capacityDroppedCount = Math.max(
    0,
    uniqueIds.length - candidates.length,
  );
  const retained: string[] = [];
  let distortedCount = 0;
  const knowledgeById = new Map(
    run.baseline.characters.flatMap((character) =>
      character.knowledge.map(
        (knowledge) => [knowledge.id, knowledge] as const,
      ),
    ),
  );
  candidates.forEach((knowledgeId) => {
    const knowledge = knowledgeById.get(knowledgeId);
    if (!knowledge) return;
    if (knowledge.authority === "rumor") {
      const retention = Math.max(
        0,
        Math.min(1, 1 - connection.attenuation - Math.max(0, hop - 1) * 0.15),
      );
      const roll =
        stableHash(
          `${run.scenario.seed}:rumor:${salt}:${connection.id}:${hop}:${knowledgeId}`,
        ) % 100;
      if (roll >= Math.round(retention * 100)) {
        distortedCount += 1;
        return;
      }
    }
    retained.push(knowledgeId);
  });
  return { knowledgeIds: retained, distortedCount, capacityDroppedCount };
}

function signalMetric(...values: readonly string[]): number {
  const text = values.join(" ");
  let score = 50;
  if (/强盛|稳固|繁荣|充足|精锐|鼎盛|支持|统一/u.test(text)) score += 20;
  if (/衰弱|混乱|匮乏|腐败|分裂|低迷|反对|失控/u.test(text)) score -= 20;
  if (/战争|争夺|危机|动荡|敌对/u.test(text)) score -= 10;
  return clamp(score);
}

function activeChapterFacts(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
) {
  const selectedChapterId = scenario.chapterContext.chapterId;
  if (scenario.chapterContext.mode === "none" || !selectedChapterId) return [];
  const selectedChapter = baseline.chapters.find(
    (chapter) => chapter.id === selectedChapterId,
  );
  if (!selectedChapter) return [];
  const selectedOrder = baseline.chapters.findIndex(
    (chapter) => chapter.id === selectedChapter.id,
  );
  if (selectedOrder < 0) return [];
  return (baseline.chapterFacts ?? []).filter((fact) =>
    scenario.chapterContext.mode === "after"
      ? fact.chapterOrder <= selectedOrder
      : fact.chapterOrder < selectedOrder,
  );
}

function observedChapterFacts(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
) {
  if (
    (scenario.chapterContext.mode !== "before" &&
      scenario.chapterContext.mode !== "branch") ||
    !scenario.chapterContext.chapterId
  )
    return [];
  return (baseline.chapterFacts ?? []).filter(
    (fact) => fact.chapterId === scenario.chapterContext.chapterId,
  );
}

function baselineFacts(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
): readonly TimelineEventProjection[] {
  const formalTimelineIds = new Set(
    baseline.timelineFacts.map((fact) => fact.id),
  );
  return [
    ...baseline.timelineFacts,
    ...activeChapterFacts(baseline, scenario).filter(
      (fact) => !formalTimelineIds.has(fact.timelineEventId),
    ),
  ];
}

function applyBaselineFacts(
  state: WorldRuntimeState,
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
): WorldRuntimeState {
  const anchor = parseWorldTick(baseline.anchor.sortKey);
  const facts = baselineFacts(baseline, scenario)
    .filter(
      (fact) =>
        fact.authority === "actual" &&
        parseWorldTick(fact.time.sortKey) <= anchor,
    )
    .slice()
    .sort((left, right) => {
      const time =
        parseWorldTick(left.time.sortKey) - parseWorldTick(right.time.sortKey);
      return time === 0n ? left.id.localeCompare(right.id) : time < 0n ? -1 : 1;
    });
  return facts.reduce((current, fact) => {
    const namedStatus = `${fact.title} ${fact.summary}`.trim();
    const dead = /死亡|陨落|离世|灭亡|消亡/u.test(namedStatus);
    const alive = /复活|归来|存活|在世/u.test(namedStatus);
    const locationId = fact.locationIds[0] ?? null;
    let next = current;
    if (fact.characterIds.length > 0) {
      next = {
        ...next,
        characters: next.characters.map((character) => {
          if (!fact.characterIds.includes(character.id)) return character;
          const change = fact.stateChanges.find(
            (item) =>
              item.entityType === "character" && item.entityId === character.id,
          );
          const changeText = change ? `${change.before} ${change.after}` : "";
          return {
            ...character,
            ...(locationId ? { locationId } : {}),
            ...(dead || /死亡|陨落|离世/u.test(changeText)
              ? { alive: false, status: change?.after || "已离世", intent: "" }
              : alive || /存活|在世/u.test(changeText)
                ? { alive: true, status: change?.after || character.status }
                : {}),
          };
        }),
      };
    }
    if (fact.factionIds.length > 0) {
      next = {
        ...next,
        factions: next.factions.map((faction) => {
          if (!fact.factionIds.includes(faction.id)) return faction;
          const change = fact.stateChanges.find(
            (item) =>
              item.entityType === "faction" && item.entityId === faction.id,
          );
          const text = `${namedStatus} ${change?.after ?? ""}`;
          return {
            ...faction,
            lifecycle: /灭亡|解散|消亡/u.test(text)
              ? "dissolved"
              : /衰弱|衰退/u.test(text)
                ? "declining"
                : faction.lifecycle,
          };
        }),
      };
    }
    if (fact.itemIds.length > 0) {
      next = {
        ...next,
        items: next.items.map((item) => {
          if (!fact.itemIds.includes(item.id)) return item;
          const change = fact.stateChanges.find(
            (candidate) =>
              candidate.entityType === "item" && candidate.entityId === item.id,
          );
          const text = `${change?.before ?? ""} ${change?.after ?? ""}`;
          const ownerCharacter = baseline.characters.find((candidate) =>
            text.includes(candidate.id),
          );
          const ownerFaction = baseline.factions.find((candidate) =>
            text.includes(candidate.id),
          );
          const ownerCleared = /无主|失去所有权/u.test(text);
          return {
            ...item,
            ...(locationId ? { locationId } : {}),
            ...(ownerCleared
              ? { ownerType: null, ownerId: null }
              : ownerCharacter
                ? {
                    ownerType: "character" as const,
                    ownerId: ownerCharacter.id,
                  }
                : ownerFaction
                  ? { ownerType: "faction" as const, ownerId: ownerFaction.id }
                  : {}),
            ...(dead ? { status: "已损毁" } : {}),
          };
        }),
      };
    }
    return next;
  }, state);
}

function initialCharacterMemory(
  character: CharacterProjection,
  anchorSortKey: string,
): readonly CharacterMemoryState[] {
  return character.knowledge.map((knowledge) => ({
    knowledgeId: knowledge.id,
    strength: clamp(Math.round(Math.max(0.01, knowledge.confidence) * 100)),
    firstKnownSortKey: anchorSortKey,
    lastRecalledSortKey: anchorSortKey,
  }));
}

/**
 * 兼容旧运行：memory 缺失时从已有 knowledgeIds 构造临时索引；
 * 新运行则以 memory 为准，并保留尚未写入记忆索引的旧知识 ID。
 */
function memoryEntriesForRuntime(
  runtime: Pick<CharacterRuntimeState, "knowledgeIds" | "memory">,
  currentSortKey: string,
): readonly CharacterMemoryState[] {
  const entries = new Map(
    (runtime.memory ?? []).map((entry) => [entry.knowledgeId, entry]),
  );
  runtime.knowledgeIds.forEach((knowledgeId) => {
    if (entries.has(knowledgeId)) return;
    entries.set(knowledgeId, {
      knowledgeId,
      strength: 100,
      firstKnownSortKey: currentSortKey,
      lastRecalledSortKey: currentSortKey,
    });
  });
  return [...entries.values()].sort(
    (left, right) =>
      right.strength - left.strength ||
      left.knowledgeId.localeCompare(right.knowledgeId),
  );
}

function rememberedKnowledgeIds(
  runtime: Pick<CharacterRuntimeState, "knowledgeIds" | "memory"> | undefined,
  currentSortKey: string,
): ReadonlySet<string> {
  if (!runtime) return new Set();
  return new Set(
    memoryEntriesForRuntime(runtime, currentSortKey)
      .filter((entry) => entry.strength > 0)
      .map((entry) => entry.knowledgeId),
  );
}

function visibleKnowledgeForCharacter(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  characterId: string,
): readonly KnowledgeProjection[] {
  const character = run.baseline.characters.find(
    (candidate) => candidate.id === characterId,
  );
  const runtime = branch.state.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character || !runtime) return [];
  const knownIds = rememberedKnowledgeIds(
    runtime,
    branch.state.currentTime.sortKey,
  );
  return character.knowledge.filter((knowledge) => knownIds.has(knowledge.id));
}

function rememberKnowledge(
  runtime: CharacterRuntimeState,
  knowledgeId: string,
  sortKey: string,
): Pick<CharacterRuntimeState, "knowledgeIds" | "memory"> {
  const entries = memoryEntriesForRuntime(runtime, sortKey);
  const remembered = entries.some((entry) => entry.knowledgeId === knowledgeId)
    ? entries.map((entry) =>
        entry.knowledgeId === knowledgeId
          ? {
              ...entry,
              strength: clamp(entry.strength + 10),
              lastRecalledSortKey: sortKey,
            }
          : entry,
      )
    : [
        ...entries,
        {
          knowledgeId,
          strength: 100,
          firstKnownSortKey: sortKey,
          lastRecalledSortKey: sortKey,
        },
      ];
  return {
    knowledgeIds: [...new Set([...runtime.knowledgeIds, knowledgeId])],
    memory: remembered,
  };
}

function upsertCharacterRelation(
  relations: readonly CharacterRelationRuntimeState[],
  targetCharacterId: string,
  affinityDelta: number,
  trustDelta: number,
  status: CharacterRelationRuntimeState["status"] | undefined,
): readonly CharacterRelationRuntimeState[] {
  const existing = relations.find(
    (relation) => relation.targetCharacterId === targetCharacterId,
  );
  const next = {
    targetCharacterId,
    affinity: clampSigned((existing?.affinity ?? 0) + affinityDelta),
    trust: clampSigned((existing?.trust ?? 0) + trustDelta),
    status: status ?? existing?.status ?? "active",
  } satisfies CharacterRelationRuntimeState;
  return existing
    ? relations.map((relation) =>
        relation.targetCharacterId === targetCharacterId ? next : relation,
      )
    : [...relations, next];
}

function upsertFactionRelation(
  relations: readonly FactionRelationRuntimeState[],
  targetFactionId: string,
  sentimentDelta: number,
  status: FactionRelationRuntimeState["status"] | undefined,
): readonly FactionRelationRuntimeState[] {
  const existing = relations.find(
    (relation) => relation.targetFactionId === targetFactionId,
  );
  const next = {
    targetFactionId,
    sentiment: clampSigned((existing?.sentiment ?? 0) + sentimentDelta),
    status: status ?? existing?.status ?? "active",
  } satisfies FactionRelationRuntimeState;
  return existing
    ? relations.map((relation) =>
        relation.targetFactionId === targetFactionId ? next : relation,
      )
    : [...relations, next];
}

function initialRuntimeState(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
): WorldRuntimeState {
  const yearDays = scaleToDays("year", baseline.calendar);
  const initial: WorldRuntimeState = {
    currentTime: baseline.anchor,
    characters: baseline.characters.map((character) => ({
      id: character.id,
      alive: !/死亡|陨落|失踪|离世/u.test(character.status),
      status: character.status || "等待",
      locationId: character.locationId,
      intent: "观察局势",
      ageDays:
        character.ageYears === null
          ? "0"
          : (
              BigInt(Math.max(0, Math.round(character.ageYears))) * yearDays
            ).toString(),
      cultivationProgress: 0,
      levelId: character.cultivation.levelId,
      resourceBalances: { ...character.cultivation.resourceBalances },
      knowledgeIds: character.knowledge.map((knowledge) => knowledge.id),
      relations: initialCharacterRelations(character),
      memory: initialCharacterMemory(character, baseline.anchor.sortKey),
      travel: null,
    })),
    factions: baseline.factions.map((faction) => ({
      id: faction.id,
      lifecycle:
        faction.status === "declining"
          ? "declining"
          : faction.status === "dissolved"
            ? "dissolved"
            : "rising",
      strategy: faction.goals[0] ?? "存续与巩固",
      governance: signalMetric(faction.stateText.governance),
      military: signalMetric(faction.stateText.military),
      economy: signalMetric(faction.stateText.economy),
      publicSupport: signalMetric(faction.stateText.publicSupport),
      territorialIntegrity: signalMetric(
        faction.stateText.territorialIntegrity,
      ),
      relations: initialFactionRelations(faction),
    })),
    regions: baseline.regions.map((region) => ({
      id: region.id,
      pressure: region.activeFactionIds.length > 1 ? 45 : 20,
      stability:
        region.rulerFactionIds.length === 1
          ? 65
          : region.rulerFactionIds.length > 1
            ? 35
            : 50,
      economy: 50,
      population: 50,
      cultivation: region.rules.length > 0 ? 60 : 50,
      ecology: 60,
      controllingFactionIds: [...region.rulerFactionIds],
    })),
    items: baseline.items.map((item) => ({
      id: item.id,
      status: item.status,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      locationId: item.locationId,
    })),
    scheduledEffects: [],
    emergentEntities: [],
    entropy: 0,
    epoch: {
      stage: "regional",
      cycle: "0",
      populationIndex: 50,
      civilizationIndex: 50,
      lawStability: 100,
      lastScale: "day",
    },
  };
  return applyBaselineFacts(
    {
      ...initial,
      epoch: initialEpochRuntimeState(initial.regions, initial.factions),
    },
    baseline,
    scenario,
  );
}

export function getActiveSimulationBranch(
  run: WorldSimulationRun,
): SimulationBranch {
  const branch = run.branches.find((item) => item.id === run.activeBranchId);
  if (!branch) throw new Error("当前推演分支不存在");
  return branch;
}

export function getSimulationEndSortKey(run: WorldSimulationRun): string {
  return addWorldTicks(
    run.baseline.anchor.sortKey,
    durationToDays(run.scenario.duration, run.scenario.calendar),
  );
}

export function createWorldSimulationRun(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
  now = new Date().toISOString(),
): WorldSimulationRun {
  if (baseline.projectId.length === 0) throw new Error("推演基线缺少项目身份");
  if (
    baseline.diagnostics.some(
      (diagnostic) => diagnostic.severity === "blocking",
    )
  ) {
    throw new Error(
      `基线检查未通过：${baseline.diagnostics
        .filter((diagnostic) => diagnostic.severity === "blocking")
        .map((diagnostic) => diagnostic.title)
        .join("、")}`,
    );
  }
  const state = initialRuntimeState(baseline, scenario);
  const idSuffix = `${Date.now().toString(36)}-${stableHash(`${baseline.sourceRevision}:${scenario.seed}`).toString(36)}`;
  const runId = `run-${idSuffix}`;
  const branch: SimulationBranch = {
    id: "branch-main",
    name: "主推演分支",
    parentBranchId: null,
    forkEventId: null,
    narrativePolicy: "configured",
    guardrails: [],
    authorLeads: [],
    seed: scenario.seed,
    status: "ready",
    state,
    ledger: [],
    observations: [],
    checkpoints: [
      {
        id: "checkpoint-origin",
        label: "事实基线",
        eventSequence: 0,
        createdAt: now,
        state,
      },
    ],
    warnings: baseline.diagnostics
      .filter((diagnostic) => diagnostic.severity !== "info")
      .map((diagnostic) => diagnostic.title),
  };
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    id: runId,
    projectId: baseline.projectId,
    name: scenario.name,
    scenario,
    baseline,
    activeBranchId: branch.id,
    branches: [branch],
    councilSessions: [],
    reports: [],
    createdAt: now,
    updatedAt: now,
  };
}

function updateById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string,
  update: (value: T) => T,
  label: string,
): readonly T[] {
  let found = false;
  const result = values.map((value) => {
    if (value.id !== id) return value;
    found = true;
    return update(value);
  });
  if (!found) throw new Error(`${label}不存在：${id}`);
  return result;
}

function assertFiniteDelta(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_DOMAIN_DELTA)
    throw new Error(`${label}必须是有限且范围合理的数值`);
}

function validateRuntimeCommand(
  state: WorldRuntimeState,
  command: WorldDomainCommand,
): void {
  const character =
    "characterId" in command
      ? state.characters.find((item) => item.id === command.characterId)
      : undefined;
  const faction =
    "factionId" in command
      ? state.factions.find((item) => item.id === command.factionId)
      : undefined;
  const region =
    "regionId" in command
      ? state.regions.find((item) => item.id === command.regionId)
      : undefined;
  if ("characterId" in command && !character)
    throw new Error(`人物不存在：${command.characterId}`);
  if ("factionId" in command && !faction)
    throw new Error(`势力不存在：${command.factionId}`);
  if ("regionId" in command && !region)
    throw new Error(`地域不存在：${command.regionId}`);
  switch (command.type) {
    case "character.intent":
      if (!character!.alive) throw new Error("已离世人物不能继续行动");
      if (!command.intent.trim() || !command.status.trim())
        throw new Error("人物意图和状态不能为空");
      return;
    case "character.move":
      if (!character!.alive) throw new Error("已离世人物不能移动");
      if (character!.travel)
        throw new Error(
          `人物正在前往${character!.travel.toRegionId}，不能重复出发`,
        );
      if (character!.locationId !== command.fromRegionId)
        throw new Error("人物出发地与当前地点不一致");
      if (!state.regions.some((item) => item.id === command.toRegionId))
        throw new Error(`目标地域不存在：${command.toRegionId}`);
      if (
        parseWorldTick(command.arrivalSortKey) <=
        parseWorldTick(state.currentTime.sortKey)
      )
        throw new Error("人物到达时间必须晚于当前世界时间");
      return;
    case "character.arrive":
      if (
        !character!.travel ||
        character!.travel.toRegionId !== command.toRegionId
      )
        throw new Error("人物当前旅行目标与抵达命令不一致");
      if (
        parseWorldTick(character!.travel.arrivalSortKey) >
        parseWorldTick(state.currentTime.sortKey)
      )
        throw new Error("人物尚未到达预定时间");
      return;
    case "character.cultivate": {
      if (!character!.alive) throw new Error("已离世人物不能修炼");
      assertFiniteDelta(command.progressDelta, "修炼进度变化");
      const next = character!.cultivationProgress + command.progressDelta;
      if (next < 0 || next > 100)
        throw new Error("修炼进度必须保持在 0 到 100 之间");
      for (const [resourceId, cost] of Object.entries(
        command.resourceCosts ?? {},
      )) {
        assertFiniteDelta(cost, "修炼资源消耗");
        if (cost < 0 || (character!.resourceBalances?.[resourceId] ?? 0) < cost)
          throw new Error(`修炼资源不足：${resourceId}`);
      }
      return;
    }
    case "character.resource": {
      if (!character!.alive) throw new Error("已离世人物不能变更资源");
      if (!command.resourceId.trim()) throw new Error("资源引用不能为空");
      assertFiniteDelta(command.delta, "人物资源变化");
      const nextBalance =
        (character!.resourceBalances?.[command.resourceId] ?? 0) +
        command.delta;
      if (nextBalance < 0)
        throw new Error(`人物资源不足：${command.resourceId}`);
      return;
    }
    case "character.relation": {
      if (!character!.alive) throw new Error("已离世人物不能改变关系");
      if (command.characterId === command.targetCharacterId)
        throw new Error("人物关系不能指向自身");
      const target = state.characters.find(
        (item) => item.id === command.targetCharacterId,
      );
      if (!target)
        throw new Error(`关系目标人物不存在：${command.targetCharacterId}`);
      assertFiniteDelta(command.affinityDelta, "人物好感变化");
      assertFiniteDelta(command.trustDelta, "人物信任变化");
      const existing = character!.relations?.find(
        (relation) => relation.targetCharacterId === command.targetCharacterId,
      );
      if (
        Math.abs((existing?.affinity ?? 0) + command.affinityDelta) > 100 ||
        Math.abs((existing?.trust ?? 0) + command.trustDelta) > 100
      )
        throw new Error("人物关系数值必须保持在 -100 到 100 之间");
      return;
    }
    case "character.life":
      if (!command.status.trim()) throw new Error("生命状态不能为空");
      return;
    case "character.knowledge":
      if (!character!.alive) throw new Error("已离世人物不能获得知识");
      if (!command.knowledgeId.trim()) throw new Error("知识引用不能为空");
      return;
    case "faction.strategy":
      if (faction!.lifecycle === "dissolved")
        throw new Error("已解散势力不能采取策略");
      if (!command.strategy.trim()) throw new Error("势力策略不能为空");
      return;
    case "faction.metric":
      assertFiniteDelta(command.delta, "势力指标变化");
      return;
    case "faction.relation": {
      if (faction!.lifecycle === "dissolved")
        throw new Error("已解散势力不能改变外交关系");
      if (command.factionId === command.targetFactionId)
        throw new Error("势力关系不能指向自身");
      if (!state.factions.some((item) => item.id === command.targetFactionId))
        throw new Error(`关系目标势力不存在：${command.targetFactionId}`);
      assertFiniteDelta(command.sentimentDelta, "势力关系变化");
      const existing = faction!.relations?.find(
        (relation) => relation.targetFactionId === command.targetFactionId,
      );
      if (Math.abs((existing?.sentiment ?? 0) + command.sentimentDelta) > 100)
        throw new Error("势力关系数值必须保持在 -100 到 100 之间");
      return;
    }
    case "region.metric":
      assertFiniteDelta(command.delta, "地域指标变化");
      return;
    case "region.control":
      if (
        command.factionIds.some(
          (id) => !state.factions.some((item) => item.id === id),
        )
      )
        throw new Error("地域控制引用了不存在的势力");
      return;
    case "item.transfer":
      if (!state.items.some((item) => item.id === command.itemId))
        throw new Error(`物品不存在：${command.itemId}`);
      if (
        command.ownerType === "character" &&
        (!command.ownerId ||
          !state.characters.some((item) => item.id === command.ownerId))
      )
        throw new Error("物品归属人物不存在");
      if (
        command.ownerType === "faction" &&
        (!command.ownerId ||
          !state.factions.some((item) => item.id === command.ownerId))
      )
        throw new Error("物品归属势力不存在");
      if (command.ownerType === null && command.ownerId !== null)
        throw new Error("无主物品不得指定归属主体");
      if (
        command.locationId !== null &&
        !state.regions.some((item) => item.id === command.locationId)
      )
        throw new Error("物品地点不存在");
      return;
    case "world.emergent":
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(command.entity.id))
        throw new Error("新生世界主体 id 格式无效");
      if (!command.entity.name.trim() || !command.entity.origin.trim())
        throw new Error("新生世界主体必须说明名称与来源");
      if (
        command.entity.regionId !== null &&
        !state.regions.some((item) => item.id === command.entity.regionId)
      )
        throw new Error("新生世界主体引用了不存在的地域");
      if (
        (state.emergentEntities ?? []).some(
          (item) => item.id === command.entity.id,
        )
      )
        throw new Error(`新生世界主体重复：${command.entity.id}`);
      return;
    case "effect.schedule":
      if (
        parseWorldTick(command.effect.dueSortKey) <=
        parseWorldTick(state.currentTime.sortKey)
      )
        throw new Error("空间影响到达时间必须晚于当前世界时间");
      return;
    case "effect.consume":
      return;
    default:
      throw new Error("领域命令类型无效");
  }
}

export function applyWorldDomainCommands(
  state: WorldRuntimeState,
  commands: readonly WorldDomainCommand[],
): WorldRuntimeState {
  return commands.reduce<WorldRuntimeState>((current, command) => {
    validateRuntimeCommand(current, command);
    switch (command.type) {
      case "character.intent":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              intent: command.intent,
              status: command.status,
            }),
            "人物",
          ),
        };
      case "character.move":
        if (!current.regions.some((region) => region.id === command.toRegionId))
          throw new Error(`目标地域不存在：${command.toRegionId}`);
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => {
              if (character.travel)
                throw new Error(
                  `人物正在前往${character.travel.toRegionId}，不能重复出发`,
                );
              if (character.locationId !== command.fromRegionId)
                throw new Error("人物出发地与当前地点不一致");
              if (
                parseWorldTick(command.arrivalSortKey) <=
                parseWorldTick(current.currentTime.sortKey)
              )
                throw new Error("人物到达时间必须晚于当前世界时间");
              return {
                ...character,
                status: "旅行中",
                travel: {
                  fromRegionId: command.fromRegionId,
                  toRegionId: command.toRegionId,
                  arrivalSortKey: command.arrivalSortKey,
                },
              };
            },
            "人物",
          ),
        };
      case "character.arrive":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => {
              if (!character.travel)
                throw new Error("人物当前不在旅行中，不能抵达");
              if (character.travel.toRegionId !== command.toRegionId)
                throw new Error("人物抵达目标与旅行目标不一致");
              if (
                parseWorldTick(character.travel.arrivalSortKey) >
                parseWorldTick(current.currentTime.sortKey)
              )
                throw new Error("人物尚未到达预定时间");
              return {
                ...character,
                locationId: command.toRegionId,
                status: "行动中",
                travel: null,
              };
            },
            "人物",
          ),
        };
      case "character.cultivate":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              cultivationProgress: clamp(
                character.cultivationProgress + command.progressDelta,
              ),
              levelId: command.nextLevelId ?? character.levelId,
              resourceBalances: Object.fromEntries(
                Object.entries(character.resourceBalances ?? {}).map(
                  ([id, balance]) => [
                    id,
                    balance - (command.resourceCosts?.[id] ?? 0),
                  ],
                ),
              ),
            }),
            "人物",
          ),
        };
      case "character.resource":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              resourceBalances: {
                ...(character.resourceBalances ?? {}),
                [command.resourceId]:
                  (character.resourceBalances?.[command.resourceId] ?? 0) +
                  command.delta,
              },
            }),
            "人物",
          ),
        };
      case "character.relation":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              relations: upsertCharacterRelation(
                character.relations ?? [],
                command.targetCharacterId,
                command.affinityDelta,
                command.trustDelta,
                command.status,
              ),
            }),
            "人物",
          ),
        };
      case "character.life":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              alive: command.alive,
              status: command.status,
              intent: command.alive ? character.intent : "",
            }),
            "人物",
          ),
        };
      case "character.knowledge":
        return {
          ...current,
          characters: updateById(
            current.characters,
            command.characterId,
            (character) => ({
              ...character,
              ...rememberKnowledge(
                character,
                command.knowledgeId,
                current.currentTime.sortKey,
              ),
            }),
            "人物",
          ),
        };
      case "faction.strategy":
        return {
          ...current,
          factions: updateById(
            current.factions,
            command.factionId,
            (faction) => ({
              ...faction,
              strategy: command.strategy,
              lifecycle: command.lifecycle ?? faction.lifecycle,
            }),
            "势力",
          ),
        };
      case "faction.metric":
        return {
          ...current,
          factions: updateById(
            current.factions,
            command.factionId,
            (faction) => ({
              ...faction,
              [command.metric]: clamp(faction[command.metric] + command.delta),
            }),
            "势力",
          ),
        };
      case "faction.relation":
        return {
          ...current,
          factions: updateById(
            current.factions,
            command.factionId,
            (faction) => ({
              ...faction,
              relations: upsertFactionRelation(
                faction.relations ?? [],
                command.targetFactionId,
                command.sentimentDelta,
                command.status,
              ),
            }),
            "势力",
          ),
        };
      case "region.metric":
        return {
          ...current,
          regions: updateById(
            current.regions,
            command.regionId,
            (region) => ({
              ...region,
              [command.metric]: clamp(region[command.metric] + command.delta),
            }),
            "地域",
          ),
        };
      case "region.control":
        command.factionIds.forEach((factionId) => {
          if (!current.factions.some((faction) => faction.id === factionId))
            throw new Error(`控制势力不存在：${factionId}`);
        });
        return {
          ...current,
          regions: updateById(
            current.regions,
            command.regionId,
            (region) => ({
              ...region,
              controllingFactionIds: [...command.factionIds],
            }),
            "地域",
          ),
        };
      case "item.transfer":
        return {
          ...current,
          items: updateById(
            current.items,
            command.itemId,
            (item) => ({
              ...item,
              ownerType: command.ownerType,
              ownerId: command.ownerId,
              locationId: command.locationId,
              status: command.status ?? item.status,
            }),
            "物品",
          ),
        };
      case "world.emergent":
        return {
          ...current,
          emergentEntities: [
            ...(current.emergentEntities ?? []),
            command.entity,
          ],
        };
      case "effect.schedule":
        if (
          parseWorldTick(command.effect.dueSortKey) <=
          parseWorldTick(current.currentTime.sortKey)
        )
          throw new Error("空间影响到达时间必须晚于当前世界时间");
        if (
          !current.regions.some(
            (region) => region.id === command.effect.originRegionId,
          ) ||
          !current.regions.some(
            (region) => region.id === command.effect.targetRegionId,
          )
        )
          throw new Error("空间影响引用了不存在的地域");
        if (
          current.scheduledEffects.some(
            (effect) => effect.id === command.effect.id,
          )
        )
          throw new Error(`空间影响重复排程：${command.effect.id}`);
        return {
          ...current,
          scheduledEffects: [...current.scheduledEffects, command.effect],
        };
      case "effect.consume": {
        const effect = current.scheduledEffects.find(
          (item) => item.id === command.effectId,
        );
        if (!effect)
          throw new Error(`待抵达的空间影响不存在：${command.effectId}`);
        if (
          parseWorldTick(effect.dueSortKey) >
          parseWorldTick(current.currentTime.sortKey)
        )
          throw new Error("空间影响尚未到达预定时间");
        return {
          ...current,
          scheduledEffects: current.scheduledEffects.filter(
            (item) => item.id !== command.effectId,
          ),
        };
      }
      default:
        throw new Error("领域命令类型无效");
    }
  }, state);
}

function advanceRuntimeClock(
  state: WorldRuntimeState,
  time: WorldRuntimeState["currentTime"],
  calendar: WorldSimulationScenario["calendar"],
  scale?: TimeScale,
): WorldRuntimeState {
  const elapsedDays =
    parseWorldTick(time.sortKey) - parseWorldTick(state.currentTime.sortKey);
  if (elapsedDays < 0n) throw new Error("推演事件时间不得倒退");
  if (elapsedDays === 0n) return { ...state, currentTime: time };
  const effectiveScale = scale ?? resolveEventScale(elapsedDays, calendar);
  const entropy = clamp(
    state.entropy +
      Math.log10(
        Number(elapsedDays > 10_000_000n ? 10_000_000n : elapsedDays) + 1,
      ) /
        20,
    0,
    100,
  );
  return {
    ...state,
    currentTime: time,
    characters: state.characters.map((character) =>
      decayCharacterMemory(
        {
          ...character,
          ageDays: addWorldTicks(character.ageDays, elapsedDays),
        },
        elapsedDays,
      ),
    ),
    entropy,
    epoch: advanceEpochRuntimeState(
      state.epoch,
      elapsedDays,
      effectiveScale,
      calendar,
      state.regions,
      state.factions,
      entropy,
    ),
  };
}

function replaySimulationLedger(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
  ledger: readonly SimulationEvent[],
): WorldRuntimeState {
  return ledger.reduce(
    (state, entry) => {
      const timedState = advanceRuntimeClock(
        state,
        entry.time,
        baseline.calendar,
        entry.scale,
      );
      return applyWorldDomainCommands(timedState, entry.commands);
    },
    initialRuntimeState(baseline, scenario),
  );
}

function selectedRegionIds(
  baseline: WorldSimulationBaseline,
  scenario: WorldSimulationScenario,
): Set<string> {
  return resolveWorldSimulationRegionScope(baseline.regions, scenario.scope);
}

function activeCharacters(
  run: WorldSimulationRun,
  branch: SimulationBranch,
): readonly CharacterProjection[] {
  const regionIds = selectedRegionIds(run.baseline, run.scenario);
  const selectedIds = new Set(run.scenario.scope.characterIds);
  const selectedFactionIds = new Set(run.scenario.scope.factionIds);
  return run.baseline.characters.filter((character) => {
    const runtime = branch.state.characters.find(
      (item) => item.id === character.id,
    );
    // 草稿和归档人物不能参与推演。未定位人物仍需参与生命周期、关系和
    // 非空间行动；只有移动等空间命令需要真实可达路径。
    if (
      !runtime?.alive ||
      runtime.travel ||
      /draft|archived|草稿|归档/iu.test(character.status)
    )
      return false;
    if (selectedIds.size > 0 && selectedIds.has(character.id)) return true;
    if (selectedFactionIds.size > 0)
      return character.factionIds.some((id) => selectedFactionIds.has(id));
    return (
      selectedIds.size === 0 &&
      (runtime.locationId === null || regionIds.has(runtime.locationId))
    );
  });
}

function activeFactions(
  run: WorldSimulationRun,
  branch: SimulationBranch,
): readonly FactionProjection[] {
  const regionIds = selectedRegionIds(run.baseline, run.scenario);
  const selectedIds = new Set(run.scenario.scope.factionIds);
  const direct = run.baseline.factions.filter((faction) => {
    const runtime = branch.state.factions.find(
      (item) => item.id === faction.id,
    );
    if (/draft|archived|草稿|归档|dissolved|解散|灭亡/iu.test(faction.status))
      return false;
    if (runtime?.lifecycle === "dissolved") return false;
    return selectedIds.size > 0
      ? selectedIds.has(faction.id)
      : faction.territoryIds.some((id) => regionIds.has(id));
  });
  if (
    !run.scenario.scope.autoIncludeCounterparts ||
    run.scenario.scope.outsidePolicy === "ignore"
  )
    return direct;
  const allIds = new Set(direct.map((faction) => faction.id));
  direct.forEach((faction) =>
    faction.relations.forEach((relation) =>
      allIds.add(relation.targetFactionId),
    ),
  );
  return run.baseline.factions.filter(
    (faction) =>
      allIds.has(faction.id) &&
      !/draft|archived|草稿|归档|dissolved|解散|灭亡/iu.test(faction.status) &&
      branch.state.factions.find((item) => item.id === faction.id)
        ?.lifecycle !== "dissolved",
  );
}

function activeNarrativeConstraints(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  timeSortKey = branch.state.currentTime.sortKey,
): readonly WorldSimulationBaseline["narrativeConstraints"][number][] {
  if (branch.narrativePolicy === "disabled") return [];
  const time = parseWorldTick(timeSortKey);
  return run.baseline.narrativeConstraints.filter((constraint) => {
    const start = constraint.timeWindow?.startSortKey;
    const end = constraint.timeWindow?.endSortKey;
    if (start && time < parseWorldTick(start)) return false;
    if (end && time > parseWorldTick(end)) return false;
    return true;
  });
}

function activeAuthorConstraints(
  run: WorldSimulationRun,
  branch: SimulationBranch,
): readonly string[] {
  return [...run.scenario.authorConstraints, ...(branch.guardrails ?? [])];
}

function activeAuthorLeads(branch: SimulationBranch): readonly string[] {
  return branch.authorLeads ?? [];
}

function commandEntity(command: WorldDomainCommand): {
  readonly type: "character" | "faction" | "region" | "item";
  readonly id: string;
} | null {
  switch (command.type) {
    case "character.intent":
    case "character.move":
    case "character.arrive":
    case "character.cultivate":
    case "character.resource":
    case "character.relation":
    case "character.life":
    case "character.knowledge":
      return { type: "character", id: command.characterId };
    case "faction.strategy":
    case "faction.metric":
    case "faction.relation":
      return { type: "faction", id: command.factionId };
    case "region.metric":
    case "region.control":
      return { type: "region", id: command.regionId };
    case "item.transfer":
      return { type: "item", id: command.itemId };
    case "world.emergent":
    case "effect.schedule":
    case "effect.consume":
      return null;
  }
}

function valueMatches(
  actual: unknown,
  operator: "exists" | "equals" | "contains",
  expected: string | number | boolean | null,
): boolean {
  if (operator === "exists") return actual !== undefined;
  if (expected === null || actual === undefined) return false;
  if (operator === "equals") return Object.is(actual, expected);
  if (Array.isArray(actual))
    return actual.some((item) => Object.is(item, expected));
  return typeof actual === "string" && actual.includes(String(expected));
}

function outcomeMatchesEvent(
  outcome: NarrativeOutcomeProjection,
  event: SimulationEvent,
): boolean {
  if (outcome.kind === "event") {
    return (
      outcome.eventKind === event.kind &&
      outcome.entityIds.every((id) =>
        [...event.characterIds, ...event.factionIds, ...event.itemIds].includes(
          id,
        ),
      ) &&
      outcome.regionIds.every((id) => event.regionIds.includes(id))
    );
  }
  if (outcome.commandType === undefined) return false;
  return event.commands.some((command) => {
    if (command.type !== outcome.commandType) return false;
    const target = commandEntity(command);
    if (
      outcome.entityId &&
      (!target ||
        target.id !== outcome.entityId ||
        target.type !== outcome.entityType)
    )
      return false;
    const actual = outcome.field
      ? (command as unknown as Record<string, unknown>)[outcome.field]
      : command;
    return valueMatches(actual, outcome.operator, outcome.value);
  });
}

interface NarrativeConstraintEvaluation {
  readonly constraint: WorldSimulationBaseline["narrativeConstraints"][number];
  readonly requiredCount: number;
  readonly requiredSatisfied: number;
  readonly forbiddenCount: number;
  readonly forbiddenMatched: number;
  readonly score: number;
  readonly complete: boolean;
}

function evaluateNarrativeConstraints(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  ledger: readonly SimulationEvent[] = branch.ledger,
): readonly NarrativeConstraintEvaluation[] {
  const constraints =
    branch.narrativePolicy === "disabled"
      ? []
      : run.baseline.narrativeConstraints;
  return constraints.map((constraint) => {
    const inWindow = ledger.filter((entry) => {
      const sortKey = parseWorldTick(entry.time.sortKey);
      const start = constraint.timeWindow?.startSortKey;
      const end = constraint.timeWindow?.endSortKey;
      return (
        (!start || sortKey >= parseWorldTick(start)) &&
        (!end || sortKey <= parseWorldTick(end))
      );
    });
    const required = constraint.requiredOutcomes ?? [];
    const forbidden = constraint.forbiddenOutcomes ?? [];
    const requiredSatisfied = required.filter((outcome) =>
      inWindow.some((entry) => outcomeMatchesEvent(outcome, entry)),
    ).length;
    const forbiddenMatched = forbidden.filter((outcome) =>
      inWindow.some((entry) => outcomeMatchesEvent(outcome, entry)),
    ).length;
    const flexibility = Math.max(
      0,
      Math.min(100, constraint.flexibility ?? 50),
    );
    const requiredThreshold = Math.ceil(
      (required.length * (100 - flexibility)) / 100,
    );
    const requiredScore =
      required.length === 0 ? 100 : (requiredSatisfied / required.length) * 100;
    const forbiddenPenalty = forbidden.length
      ? (forbiddenMatched / forbidden.length) * (100 - flexibility)
      : 0;
    return {
      constraint,
      requiredCount: required.length,
      requiredSatisfied,
      forbiddenCount: forbidden.length,
      forbiddenMatched,
      score: Math.max(
        0,
        Math.min(100, Math.round(requiredScore - forbiddenPenalty)),
      ),
      complete:
        requiredSatisfied >= requiredThreshold && forbiddenMatched === 0,
    };
  });
}

function evidenceFor(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  actor: CharacterProjection | FactionProjection | null,
  regionId: string | null,
  label: string,
): SimulationEvidence[] {
  const evidence: SimulationEvidence[] = [];
  if (actor)
    evidence.push({
      type: "goal",
      label: "主体目标",
      detail: actor.goals[0] ?? actor.summary,
      authority: "canon",
      sourceRefs: actor.sourceRefs,
    });
  const rule = run.baseline.rules.find(
    (candidate) =>
      candidate.regionId === null || candidate.regionId === regionId,
  );
  if (rule)
    evidence.push({
      type: "world-rule",
      label: rule.title,
      detail: rule.description,
      authority: "canon",
      sourceRefs: rule.sourceRefs,
    });
  const narrativeConstraints = activeNarrativeConstraints(run, branch);
  const narrative =
    narrativeConstraints.find((constraint) =>
      constraint.entityIds.includes(actor?.id ?? ""),
    ) ?? narrativeConstraints[0];
  if (narrative)
    evidence.push({
      type: "narrative-constraint",
      label: narrative.title,
      detail:
        narrative.mode === "observe"
          ? "仅观察偏离，不改变裁定"
          : narrative.content,
      authority: narrative.mode === "strict" ? "constraint" : "planned",
      sourceRefs: narrative.sourceRefs,
    });
  evidence.push({
    type: "random-seed",
    label: "可重放种子",
    detail: label,
    authority: "simulated",
    sourceRefs: [],
  });
  return evidence;
}

function findCauseIds(
  ledger: readonly SimulationEvent[],
  actorIds: readonly string[],
  regionIds: readonly string[],
): string[] {
  const event = ledger
    .slice()
    .reverse()
    .find(
      (candidate) =>
        candidate.characterIds.some((id) => actorIds.includes(id)) ||
        candidate.factionIds.some((id) => actorIds.includes(id)) ||
        candidate.regionIds.some((id) => regionIds.includes(id)),
    );
  return event ? [event.id] : [];
}

function event(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  timeSortKey: string,
  scale: TimeScale,
  input: Omit<
    SimulationEvent,
    "id" | "sequence" | "time" | "scale" | "causeEventIds"
  > & { readonly causeEventIds?: readonly string[] },
): SimulationEvent {
  const sequence = branch.ledger.length + 1;
  return {
    ...input,
    id: `event-${branch.id}-${String(sequence).padStart(5, "0")}`,
    sequence,
    time: createWorldInstant(
      timeSortKey,
      run.scenario.calendar,
      scale === "day"
        ? "day"
        : scale === "month"
          ? "month"
          : scale === "year"
            ? "year"
            : "era",
    ),
    scale,
    causeEventIds: [
      ...(input.causeEventIds ??
        findCauseIds(
          branch.ledger,
          [...input.characterIds, ...input.factionIds],
          input.regionIds,
        )),
    ],
  };
}

function nextReachableRegionId(
  connection: SpatialConnection,
  originRegionId: string,
): string | null {
  if (connection.fromRegionId === originRegionId) return connection.toRegionId;
  if (connection.bidirectional && connection.toRegionId === originRegionId)
    return connection.fromRegionId;
  return null;
}

function isPropagationConnection(connection: SpatialConnection): boolean {
  // 包含关系只描述地域层级，不能被误当成道路或传播通道。
  return connection.kind !== "containment";
}

function isTravelConnection(connection: SpatialConnection): boolean {
  return (
    connection.kind === "adjacent" ||
    connection.kind === "road" ||
    connection.kind === "trade" ||
    connection.kind === "teleport"
  );
}

interface SpatialRoute {
  readonly regionIds: readonly string[];
  readonly connections: readonly SpatialConnection[];
  readonly travelDays: bigint;
}

function routeSignature(route: SpatialRoute): string {
  return route.connections.map((connection) => connection.id).join("/");
}

function findSpatialRoute(
  baseline: WorldSimulationBaseline,
  originRegionId: string,
  targetRegionId: string,
): SpatialRoute | null {
  if (originRegionId === targetRegionId) return null;
  const start: SpatialRoute = {
    regionIds: [originRegionId],
    connections: [],
    travelDays: 0n,
  };
  const best = new Map<string, SpatialRoute>([[originRegionId, start]]);
  const pending: SpatialRoute[] = [start];
  while (pending.length > 0) {
    pending.sort((left, right) => {
      if (left.travelDays !== right.travelDays)
        return left.travelDays < right.travelDays ? -1 : 1;
      return routeSignature(left).localeCompare(routeSignature(right));
    });
    const current = pending.shift()!;
    const currentRegionId = current.regionIds.at(-1)!;
    const bestCurrent = best.get(currentRegionId);
    if (
      bestCurrent?.travelDays !== current.travelDays ||
      routeSignature(bestCurrent) !== routeSignature(current)
    )
      continue;
    if (currentRegionId === targetRegionId) return current;
    const region = baseline.regions.find((item) => item.id === currentRegionId);
    if (!region) continue;
    [...region.connections]
      .filter(isTravelConnection)
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((connection) => {
        const nextRegionId = nextReachableRegionId(connection, currentRegionId);
        if (!nextRegionId || current.regionIds.includes(nextRegionId)) return;
        const rawDuration = parseWorldTick(connection.travelDays);
        const travelDays = rawDuration > 0n ? rawDuration : 1n;
        const next: SpatialRoute = {
          regionIds: [...current.regionIds, nextRegionId],
          connections: [...current.connections, connection],
          travelDays: current.travelDays + travelDays,
        };
        const previous = best.get(nextRegionId);
        if (
          previous &&
          (previous.travelDays < next.travelDays ||
            (previous.travelDays === next.travelDays &&
              routeSignature(previous).localeCompare(routeSignature(next)) <=
                0))
        )
          return;
        best.set(nextRegionId, next);
        pending.push(next);
      });
  }
  return null;
}

function travelArrivalSortKey(
  departureSortKey: string,
  travelDays: string,
): string {
  const duration = parseWorldTick(travelDays);
  return addWorldTicks(departureSortKey, duration > 0n ? duration : 1n);
}

function assertCharacterMoveHasSpatialPath(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  command: Extract<WorldDomainCommand, { readonly type: "character.move" }>,
  visibleRegionIds: ReadonlySet<string>,
  departureSortKey: string,
  source: string,
): SpatialRoute {
  if (!visibleRegionIds.has(command.toRegionId))
    throw new Error(`${source}试图移动到范围外地域`);
  const runtime = branch.state.characters.find(
    (character) => character.id === command.characterId,
  );
  if (
    !runtime ||
    runtime.travel ||
    !runtime.locationId ||
    command.fromRegionId !== runtime.locationId
  ) {
    throw new Error(`${source}的移动缺少可达空间路径`);
  }
  const route = findSpatialRoute(
    run.baseline,
    runtime.locationId,
    command.toRegionId,
  );
  if (
    !route ||
    route.regionIds.some((regionId) => !visibleRegionIds.has(regionId))
  )
    throw new Error(`${source}的移动缺少可达空间路径`);
  const earliestArrival = addWorldTicks(departureSortKey, route.travelDays);
  if (
    parseWorldTick(command.arrivalSortKey) < parseWorldTick(earliestArrival)
  ) {
    throw new Error(
      `${source}的移动行程至少需要 ${route.travelDays.toString()} 日，不能提前抵达。`,
    );
  }
  return route;
}

function characterEvent(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  character: CharacterProjection,
  nextSortKey: string,
  stepDays: bigint,
  scale: TimeScale,
): SimulationEvent | null {
  const runtime = branch.state.characters.find(
    (item) => item.id === character.id,
  )!;
  const yearDays = scaleToDays("year", run.scenario.calendar);
  const ageAtBoundary = parseWorldTick(runtime.ageDays) + stepDays;
  const lifespanDays =
    character.lifespanYears === null
      ? null
      : BigInt(
          Math.max(
            0,
            Math.round(character.lifespanYears - character.lifespanLossYears),
          ),
        ) * yearDays;
  if (lifespanDays !== null && ageAtBoundary >= lifespanDays) {
    const regionId = runtime.locationId;
    const regionState = regionId
      ? branch.state.regions.find((item) => item.id === regionId)
      : undefined;
    const hasCloseTie = character.relations.some(
      (relation) => relation.tone === "positive",
    );
    const hasIllnessRisk = [
      ...character.weaknesses,
      ...character.fears,
      character.status,
    ].some((value) => /伤|病|疾|衰|残/u.test(value));
    const calamityThreshold =
      stableHash(
        `${branch.seed}:life-calamity:${character.id}:${nextSortKey}`,
      ) % 100;
    const cause =
      regionState && regionState.pressure >= 70
        ? {
            title: `${character.name}死于地域劫难`,
            summary: `${character.name}所在的${run.baseline.regions.find((item) => item.id === regionId)?.name ?? "地域"}长期承受高压，秩序崩解最终越过其寿命边界。他未能等到安稳晚年，遗物与记忆将由地方继续承接。`,
            status: "死于劫难",
          }
        : regionState && regionState.stability <= 30
          ? {
              title: `${character.name}在颠沛中走完一生`,
              summary: `${character.name}在${run.baseline.regions.find((item) => item.id === regionId)?.name ?? "动荡之地"}的低稳定度中辗转求生，最终未能留下稳定居所。其遗物、熟人记忆与未竟意图会成为后续世界过程的一部分。`,
              status: "颠沛病逝",
            }
          : hasIllnessRisk
            ? {
                title: `${character.name}病衰离世`,
                summary: `${character.name}带着既有的伤病与衰老走到生命尽头。世界不会把寿命结算简化成数字清零；其关系、遗物与在地影响仍留在后续因果中。`,
                status: "病衰离世",
              }
            : calamityThreshold < (regionState?.pressure ?? 0) / 2
              ? {
                  title: `${character.name}未能避开乱世余波`,
                  summary: `${character.name}在生命末段遭遇持续动荡的余波，未能平静终老。该结局由地域压力、世界时间与运行种子共同裁定，后续镜头会转向其遗物或地方记忆。`,
                  status: "乱世离世",
                }
              : {
                  title: `${character.name}安稳终老`,
                  summary: hasCloseTie
                    ? `${character.name}在既有关系与地域秩序中度过余生，最终安稳离世。其亲友、遗物和曾经参与的地方生活将继续留在世界的后续变化里。`
                    : `${character.name}在既有地域度过余生，最终自然终老。其遗物与地方记忆会作为后续世界影响继续保留。`,
                  status: "安稳终老",
                };
    return event(run, branch, nextSortKey, scale, {
      kind: "lifecycle",
      title: `${cause.title}（寿命尽头）`,
      summary: cause.summary,
      characterIds: [character.id],
      factionIds: [...character.factionIds],
      regionIds: regionId ? [regionId] : [],
      itemIds: [...character.inventoryItemIds],
      evidence: evidenceFor(
        run,
        branch,
        character,
        regionId,
        `${branch.seed}:life:${character.id}:${nextSortKey}`,
      ),
      commands: [
        {
          type: "character.life",
          characterId: character.id,
          alive: false,
          status: cause.status,
        },
        ...character.inventoryItemIds.map((itemId) => ({
          type: "item.transfer" as const,
          itemId,
          ownerType: null,
          ownerId: null,
          locationId: regionId,
          status: "待继承",
        })),
        ...(regionId
          ? [
              {
                type: "region.metric" as const,
                regionId,
                metric: "stability" as const,
                delta: -4,
              },
            ]
          : []),
      ],
      narrativeConstraintIds: activeNarrativeConstraints(run, branch)
        .filter((constraint) => constraint.entityIds.includes(character.id))
        .map((constraint) => constraint.id),
      generatedBy: "kernel",
      confidence: 0.96,
    });
  }

  const system = character.cultivation.systemId
    ? run.baseline.cultivationSystems.find(
        (item) => item.id === character.cultivation.systemId,
      )
    : undefined;
  const hasActionBasis = Boolean(
    character.goals[0] ||
      character.motivation[0] ||
      character.knowledge[0] ||
      system,
  );
  const isExplicitlyCultivating =
    /修炼|闭关|突破/iu.test(runtime.status) ||
    [...character.goals, ...character.motivation].some((value) =>
      /修炼|闭关|突破/iu.test(value),
    );
  if (system && hasActionBasis && isExplicitlyCultivating) {
    const progressDelta = clamp(
      Math.round(
        Number(
          stepDays > yearDays * 100n ? 35n : stepDays > yearDays ? 18n : 8n,
        ),
      ),
      1,
      45,
    );
    const currentLevel = system.levels.find(
      (level) => level.id === runtime.levelId,
    );
    const nextLevel = system.levels
      .filter(
        (level) => !currentLevel || level.trackId === currentLevel.trackId,
      )
      .sort((left, right) => left.order - right.order)
      .find((level) => !currentLevel || level.order > currentLevel.order);
    const hasBreakthroughResources = Boolean(
      nextLevel &&
        nextLevel.resourceIds.every(
          (resourceId) => (runtime.resourceBalances?.[resourceId] ?? 0) >= 1,
        ),
    );
    const breakthrough =
      runtime.cultivationProgress + progressDelta >= 100 &&
      Boolean(nextLevel) &&
      hasBreakthroughResources;
    return event(run, branch, nextSortKey, scale, {
      kind: "cultivation",
      title: breakthrough
        ? `${character.name}完成一次境界跃迁`
        : `${character.name}推进${system.name}修行`,
      summary: breakthrough
        ? `${character.name}满足阶段性条件，从${currentLevel?.name ?? "旧阶段"}迈入${nextLevel?.name ?? "新阶段"}。`
        : `${character.name}在既有资源与约束下积累修行进度，尚未越过下一道门槛。`,
      characterIds: [character.id],
      factionIds: [...character.factionIds],
      regionIds: runtime.locationId ? [runtime.locationId] : [],
      itemIds: [...character.inventoryItemIds],
      evidence: evidenceFor(
        run,
        branch,
        character,
        runtime.locationId,
        `${branch.seed}:cultivate:${character.id}:${nextSortKey}`,
      ),
      commands: [
        {
          type: "character.intent",
          characterId: character.id,
          intent: breakthrough
            ? `稳固${nextLevel?.name ?? "新境界"}`
            : "继续修行并补足突破资源",
          status: "修行中",
        },
        {
          type: "character.cultivate",
          characterId: character.id,
          progressDelta: breakthrough
            ? -runtime.cultivationProgress
            : progressDelta,
          nextLevelId: breakthrough ? (nextLevel?.id ?? null) : null,
          ...(breakthrough && nextLevel && nextLevel.resourceIds.length > 0
            ? {
                resourceCosts: Object.fromEntries(
                  nextLevel.resourceIds.map((resourceId) => [resourceId, 1]),
                ),
              }
            : {}),
        },
        ...(runtime.locationId
          ? [
              {
                type: "region.metric" as const,
                regionId: runtime.locationId,
                metric: "cultivation" as const,
                delta: breakthrough ? -2 : -0.3,
              },
            ]
          : []),
      ],
      narrativeConstraintIds: activeNarrativeConstraints(run, branch)
        .filter((constraint) => constraint.entityIds.includes(character.id))
        .map((constraint) => constraint.id),
      generatedBy: "fallback",
      confidence: 0.78,
      ...(run.scenario.intelligence.mode === "assisted"
        ? { degradedReason: "未提供模型候选，使用确定性修炼策略" }
        : {}),
    });
  }

  // 目标、性格和随机种子不足以证明某人具体移动或影响一片地域。
  // 这类下一步应交给受控模型候选，并由命令校验器验证后才进入账本。
  return null;
}

function factionEvent(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  faction: FactionProjection,
  nextSortKey: string,
  scale: TimeScale,
): SimulationEvent | null {
  const runtime = branch.state.factions.find((item) => item.id === faction.id)!;
  const hostile = faction.relations.find(
    (relation) =>
      relation.status === "active" &&
      (relation.kind === "hostile" || relation.kind === "competitive"),
  );
  const contested = faction.resources.find(
    (resource) =>
      resource.controlLevel === "contested" ||
      resource.competingFactionIds.length > 0,
  );
  // 没有明确敌对关系或争夺资源时，不能把“例行治理”伪装成一次世界事件。
  if (!hostile && !contested) return null;
  const hasAlreadyReacted = branch.ledger.some((event) =>
    event.commands.some(
      (command) =>
        command.type === "faction.strategy" && command.factionId === faction.id,
    ),
  );
  // 同一组已知关系或资源争夺只触发一次基线反应。后续升级需要新的事实、
  // 已排程影响或通过校验的智能候选，不能在每个时间步重复“决定开战”。
  if (hasAlreadyReacted) return null;
  const candidateRegionId =
    contested?.regionId ??
    faction.territoryIds[0] ??
    run.scenario.scope.regionIds[0] ??
    run.baseline.regions[0]?.id ??
    null;
  const scopedRegions = selectedRegionIds(run.baseline, run.scenario);
  const regionId =
    candidateRegionId && scopedRegions.has(candidateRegionId)
      ? candidateRegionId
      : run.scenario.scope.outsidePolicy === "respond" ||
          run.scenario.scope.outsidePolicy === "approximate"
        ? ([...scopedRegions][0] ?? candidateRegionId)
        : candidateRegionId;
  const aggressive = Boolean(hostile || contested) && runtime.military >= 35;
  const lifecycle =
    runtime.governance < 25 || runtime.territorialIntegrity < 25
      ? "fragmented"
      : runtime.economy > 70 && runtime.military > 65
        ? "peak"
        : runtime.economy < 35
          ? "declining"
          : runtime.lifecycle;
  const strategy = aggressive
    ? hostile
      ? `牵制${run.baseline.factions.find((item) => item.id === hostile.targetFactionId)?.name ?? "对手"}`
      : `争夺${contested?.name ?? "关键资源"}`
    : runtime.economy < 45
      ? "休养生息并恢复生产"
      : "整合内部派系与边境控制";
  const kind: SimulationEventKind = aggressive
    ? "conflict"
    : hostile
      ? "diplomacy"
      : "faction-strategy";
  const commands: WorldDomainCommand[] = [
    { type: "faction.strategy", factionId: faction.id, strategy, lifecycle },
    ...(hostile
      ? [
          {
            type: "faction.relation" as const,
            factionId: faction.id,
            targetFactionId: hostile.targetFactionId,
            sentimentDelta: aggressive ? -8 : 3,
            status: "active" as const,
          },
        ]
      : []),
    {
      type: "faction.metric",
      factionId: faction.id,
      metric: aggressive ? "military" : "governance",
      delta: aggressive ? -3 : 2,
    },
    {
      type: "faction.metric",
      factionId: faction.id,
      metric: "economy",
      delta: aggressive ? -2 : 1.5,
    },
    ...(regionId
      ? [
          {
            type: "region.metric" as const,
            regionId,
            metric: "pressure" as const,
            delta: aggressive ? 8 : -2,
          },
          {
            type: "region.metric" as const,
            regionId,
            metric: "stability" as const,
            delta: aggressive ? -5 : 2,
          },
        ]
      : []),
  ];
  return event(run, branch, nextSortKey, scale, {
    kind,
    title: `${faction.name}选择“${strategy}”`,
    summary: aggressive
      ? `${faction.name}将资源投入外部博弈，目标地域的军事与政治压力同步上升。`
      : `${faction.name}根据治理、经济和领土状态调整本阶段策略。`,
    characterIds: [...faction.leaderCharacterIds],
    factionIds: [
      faction.id,
      ...(hostile ? [hostile.targetFactionId] : []),
      ...(contested?.competingFactionIds ?? []),
    ],
    regionIds: regionId ? [regionId] : [],
    itemIds: contested?.itemId ? [contested.itemId] : [],
    evidence: evidenceFor(
      run,
      branch,
      faction,
      regionId,
      `${branch.seed}:faction:${faction.id}:${nextSortKey}`,
    ),
    commands,
    narrativeConstraintIds: activeNarrativeConstraints(run, branch)
      .filter((constraint) => constraint.entityIds.includes(faction.id))
      .map((constraint) => constraint.id),
    generatedBy: "fallback",
    confidence: 0.8,
    ...(run.scenario.intelligence.mode === "assisted"
      ? { degradedReason: "未提供模型候选，使用确定性势力策略" }
      : {}),
  });
}

function periodicRuleHitCount(
  startSortKey: string,
  endSortKey: string,
  intervalDays: string,
): bigint {
  const interval = parseWorldTick(intervalDays);
  if (interval <= 0n) return 0n;
  const start = parseWorldTick(startSortKey);
  const end = parseWorldTick(endSortKey);
  if (end <= start) return 0n;
  return end / interval - start / interval;
}

function periodicRuleEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  scale: TimeScale,
): readonly SimulationEvent[] {
  const visibleRegions = selectedRegionIds(run.baseline, run.scenario);
  const startSortKey = branch.state.currentTime.sortKey;
  let eventBranch = branch;
  const events: SimulationEvent[] = [];
  run.baseline.rules
    .filter(
      (rule) =>
        rule.kind === "periodic" &&
        Boolean(rule.intervalDays) &&
        (rule.regionId === null || visibleRegions.has(rule.regionId)),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((rule) => {
      const hitCount = periodicRuleHitCount(
        startSortKey,
        nextSortKey,
        rule.intervalDays!,
      );
      if (hitCount <= 0n) return;
      const region = rule.regionId
        ? run.baseline.regions.find((item) => item.id === rule.regionId)
        : null;
      const text = `${rule.title}\n${rule.description}`;
      const isFestival = /节|庆典|祭祀|集会|风俗/u.test(text);
      const isOpening = /秘境|遗迹|洞天|宝库|开启|降临|现世/u.test(text);
      const isConflict = /战争|战事|争夺|冲突/u.test(text);
      const impact = Number(hitCount > 8n ? 8n : hitCount);
      const commands: WorldDomainCommand[] = region
        ? isFestival
          ? [
              {
                type: "region.metric",
                regionId: region.id,
                metric: "stability",
                delta: Math.min(6, Math.max(1, impact)),
              },
              {
                type: "region.metric",
                regionId: region.id,
                metric: "economy",
                delta: Math.min(4, Math.max(1, impact / 2)),
              },
            ]
          : isOpening
            ? [
                {
                  type: "region.metric",
                  regionId: region.id,
                  metric: "cultivation",
                  delta: Math.min(8, Math.max(1, impact)),
                },
                {
                  type: "region.metric",
                  regionId: region.id,
                  metric: "pressure",
                  delta: Math.min(5, Math.max(1, impact)),
                },
              ]
            : isConflict
              ? [
                  {
                    type: "region.metric",
                    regionId: region.id,
                    metric: "pressure",
                    delta: Math.min(12, Math.max(2, impact * 2)),
                  },
                  {
                    type: "region.metric",
                    regionId: region.id,
                    metric: "stability",
                    delta: -Math.min(8, Math.max(1, impact)),
                  },
                ]
              : [
                  {
                    type: "region.metric",
                    regionId: region.id,
                    metric: "stability",
                    delta: Math.min(3, Math.max(1, impact)),
                  },
                ]
        : [];
      const countText = hitCount.toString();
      const subject = isFestival
        ? "节庆与民间秩序"
        : isOpening
          ? "开启、传承与资源流向"
          : isConflict
            ? "周期性冲突"
            : "世界过程";
      const periodicEvent = event(run, eventBranch, nextSortKey, scale, {
        kind: isConflict ? "conflict" : "world-process",
        title: `${rule.title}在本轮命中 ${countText} 次`,
        summary: `${region?.name ?? "世界范围"}在本轮时间窗口内按“${rule.title}”发生 ${countText} 次。内核以一次聚合裁定呈现${subject}，不会把每一次重复过程展开为独立事件。${rule.aggregationLabel ? ` ${rule.aggregationLabel}。` : ""}`,
        characterIds: [],
        factionIds: region
          ? [
              ...new Set([
                ...region.activeFactionIds,
                ...region.rulerFactionIds,
              ]),
            ]
          : [],
        regionIds: region ? [region.id] : [],
        itemIds: [],
        evidence: [
          {
            type: "world-rule",
            label: rule.title,
            detail: `规则间隔 ${rule.intervalDays} 世界日；窗口 ${startSortKey} 至 ${nextSortKey}，命中 ${countText} 次。${rule.description}`,
            authority: "canon",
            sourceRefs: rule.sourceRefs,
          },
        ],
        commands,
        narrativeConstraintIds: [],
        generatedBy: "kernel",
        confidence: 0.94,
      });
      events.push(periodicEvent);
      eventBranch = {
        ...eventBranch,
        ledger: [...eventBranch.ledger, periodicEvent],
      };
    });
  return events;
}

function worldProcessEventForRegion(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  stepDays: bigint,
  scale: TimeScale,
  region: RegionProjection,
): SimulationEvent | null {
  const baselineFactionIds = new Set(
    run.baseline.factions.map((faction) => faction.id),
  );
  const runtime = branch.state.regions.find((item) => item.id === region.id);
  if (!runtime) return null;
  const years = stepDays / scaleToDays("year", run.scenario.calendar);
  const coarseYears = years > 0n ? Number(years > 1000n ? 1000n : years) : 0;
  const pressureDirection =
    runtime.pressure >= 60 ? 1 : runtime.pressure <= 25 ? -1 : 0;
  const stabilityDelta =
    pressureDirection > 0
      ? -Math.max(1, Math.min(8, coarseYears + 1))
      : pressureDirection < 0
        ? Math.max(1, Math.min(5, coarseYears + 1))
        : 0;
  const populationDelta =
    stabilityDelta < 0
      ? -Math.max(1, Math.min(6, Math.abs(stabilityDelta)))
      : stabilityDelta > 0
        ? Math.max(1, Math.min(4, stabilityDelta))
        : 0;
  const economyDelta =
    runtime.controllingFactionIds.length > 0
      ? stabilityDelta < 0
        ? -2
        : 1
      : -1;
  const cultivationDelta = region.rules.some((rule) =>
    /灵气|修炼|灵脉|法则/u.test(rule),
  )
    ? stabilityDelta < 0
      ? -1
      : 2
    : 0;
  const ecologyDelta = stabilityDelta < 0 ? -2 : stabilityDelta > 0 ? 1 : 0;
  const commands: WorldDomainCommand[] = [
    ...(stabilityDelta
      ? [
          {
            type: "region.metric" as const,
            regionId: region.id,
            metric: "stability" as const,
            delta: stabilityDelta,
          },
        ]
      : []),
    ...(populationDelta
      ? [
          {
            type: "region.metric" as const,
            regionId: region.id,
            metric: "population" as const,
            delta: populationDelta,
          },
        ]
      : []),
    ...(economyDelta
      ? [
          {
            type: "region.metric" as const,
            regionId: region.id,
            metric: "economy" as const,
            delta: economyDelta,
          },
        ]
      : []),
    ...(cultivationDelta
      ? [
          {
            type: "region.metric" as const,
            regionId: region.id,
            metric: "cultivation" as const,
            delta: cultivationDelta,
          },
        ]
      : []),
    ...(ecologyDelta
      ? [
          {
            type: "region.metric" as const,
            regionId: region.id,
            metric: "ecology" as const,
            delta: ecologyDelta,
          },
        ]
      : []),
  ];
  if (commands.length === 0) return null;
  const latestCause = branch.ledger
    .slice()
    .reverse()
    .find((entry) => entry.regionIds.includes(region.id));
  return event(run, branch, nextSortKey, scale, {
    kind: "world-process",
    title: `${region.name}的世界过程发生变化`,
    summary: `${region.name}依据已编译的地域规则、控制关系和当前稳定度，人口、经济、生态及修炼环境出现可追溯变化。`,
    characterIds: [],
    factionIds: [
      ...new Set(
        [...region.activeFactionIds, ...region.rulerFactionIds].filter((id) =>
          baselineFactionIds.has(id),
        ),
      ),
    ],
    regionIds: [region.id],
    itemIds: [],
    causeEventIds: latestCause ? [latestCause.id] : [],
    evidence: [
      {
        type: "fact",
        label: "地域过程依据",
        detail:
          [region.summary, ...region.rules].filter(Boolean).join("；") ||
          "已登记的地域控制关系",
        authority: "canon",
        sourceRefs: region.sourceRefs,
      },
    ],
    commands,
    narrativeConstraintIds: [],
    generatedBy: "kernel",
    confidence: 0.72,
  });
}

function worldProcessEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  stepDays: bigint,
  scale: TimeScale,
): readonly SimulationEvent[] {
  const baselineFactionIds = new Set(
    run.baseline.factions.map((faction) => faction.id),
  );
  const regions = run.baseline.regions
    .filter((region) =>
      selectedRegionIds(run.baseline, run.scenario).has(region.id),
    )
    .filter(
      (region) =>
        region.rules.length > 0 ||
        region.rulerFactionIds.some((id) => baselineFactionIds.has(id)) ||
        region.activeFactionIds.some((id) => baselineFactionIds.has(id)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  let eventBranch = branch;
  const events: SimulationEvent[] = [];
  for (const region of regions) {
    const event = worldProcessEventForRegion(
      run,
      eventBranch,
      nextSortKey,
      stepDays,
      scale,
      region,
    );
    if (!event) continue;
    events.push(event);
    eventBranch = { ...eventBranch, ledger: [...eventBranch.ledger, event] };
  }
  const yearDays = scaleToDays("year", run.scenario.calendar);
  const elapsedYears = stepDays / yearDays;
  if (elapsedYears >= 80n && regions.length > 0) {
    const birthRegion = regions.slice().sort((left, right) => {
      const leftPopulation =
        branch.state.regions.find((item) => item.id === left.id)?.population ??
        0;
      const rightPopulation =
        branch.state.regions.find((item) => item.id === right.id)?.population ??
        0;
      return (
        rightPopulation - leftPopulation || left.id.localeCompare(right.id)
      );
    })[0]!;
    const idSuffix = `${branch.id}-${nextSortKey.replace(/-/gu, "m")}`;
    const entities: EmergentWorldEntityRuntimeState[] = [
      {
        id: `emergent-character-${idSuffix}`,
        kind: "character",
        name: `${birthRegion.name}新生一代`,
        regionId: birthRegion.id,
        origin: `本轮跨越 ${elapsedYears.toString()} 年，由人口、稳定度与地方秩序的聚合结果生成。`,
        createdAtSortKey: nextSortKey,
        status: "成长中",
      },
      ...(elapsedYears >= 500n
        ? [
            {
              id: `emergent-faction-${idSuffix}`,
              kind: "faction" as const,
              name: `${birthRegion.name}新兴组织`,
              regionId: birthRegion.id,
              origin: "长尺度的人口、资源与地方秩序变化促成新的组织力量。",
              createdAtSortKey: nextSortKey,
              status: "形成中",
            },
          ]
        : []),
    ];
    const emergence = event(run, eventBranch, nextSortKey, scale, {
      kind: "world-process",
      title: `${birthRegion.name}出现代际承接`,
      summary: `本轮跨越 ${elapsedYears.toString()} 年，${birthRegion.name}出现新生一代${entities.length > 1 ? "与新的组织力量" : ""}。它们只属于当前推演分支，用于承接死亡人物、地方记忆与资源秩序的后续因果，不会自动写入正式人物或势力资料。`,
      characterIds: [],
      factionIds: [],
      regionIds: [birthRegion.id],
      itemIds: [],
      evidence: [
        {
          type: "world-rule",
          label: "长尺度代际聚合",
          detail: `跨度 ${elapsedYears.toString()} 年；人口与地域秩序只按尺度级结论处理，不逐年虚构人物行动。`,
          authority: "simulated",
          sourceRefs: birthRegion.sourceRefs,
        },
      ],
      commands: entities.map((entity) => ({
        type: "world.emergent" as const,
        entity,
      })),
      narrativeConstraintIds: [],
      generatedBy: "kernel",
      confidence: 0.82,
    });
    events.push(emergence);
    eventBranch = {
      ...eventBranch,
      ledger: [...eventBranch.ledger, emergence],
    };
  }
  const epochStage = epochStageForScale(scale, branch.state.epoch.stage);
  if (
    [
      "millennium",
      "ten-thousand-years",
      "hundred-billion-years",
      "trillion-years",
    ].includes(scale)
  ) {
    const scaleBoundary = scaleToDays(scale, run.scenario.calendar);
    const cycleIncrement =
      stepDays / scaleBoundary > 0n ? stepDays / scaleBoundary : 1n;
    const nextCycle = (
      parseWorldTick(branch.state.epoch.cycle) + cycleIncrement
    ).toString();
    const sourceRefs = [
      ...run.baseline.regions
        .filter((region) =>
          selectedRegionIds(run.baseline, run.scenario).has(region.id),
        )
        .flatMap((region) => region.sourceRefs),
      ...run.baseline.rules.flatMap((rule) => rule.sourceRefs),
    ].slice(0, 12);
    events.push(
      event(run, eventBranch, nextSortKey, scale, {
        kind: "epoch",
        title: `世界进入${epochStage}纪元阶段`,
        summary: `长尺度推进完成第 ${nextCycle} 个聚合周期；人口指数、文明指数和法则稳定度已由确定性内核更新。该里程碑不代表精确人口或逐日事件。`,
        characterIds: [],
        factionIds: [],
        regionIds: regions.map((region) => region.id).slice(0, 8),
        itemIds: [],
        causeEventIds: events.length > 0 ? [events.at(-1)!.id] : [],
        evidence: [
          {
            type: "world-rule",
            label: "纪元聚合规则",
            detail: `尺度=${scale}；阶段=${epochStage}；周期=${nextCycle}`,
            authority: "simulated",
            sourceRefs,
          },
        ],
        commands: [],
        narrativeConstraintIds: [],
        generatedBy: "kernel",
        confidence: 0.7,
      }),
    );
    eventBranch = {
      ...eventBranch,
      ledger: [...eventBranch.ledger, events.at(-1)!],
    };
  }
  return events;
}

function propagationEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  source: SimulationEvent | undefined,
  nextSortKey: string,
  scale: TimeScale,
): readonly SimulationEvent[] {
  if (!source) return [];
  const isInitialPressure = source.commands.some(
    (command) =>
      command.type === "region.metric" &&
      command.metric === "pressure" &&
      command.delta >= 5,
  );
  const isArrivedPropagation =
    source.kind === "propagation" &&
    source.propagationContext !== undefined &&
    source.commands.some((command) => command.type === "effect.consume");
  if (!isInitialPressure && !isArrivedPropagation) return [];
  const sourceHop = source.propagationContext?.hop ?? 0;
  const maxPropagationHops = run.scenario.maxPropagationHops ?? 3;
  if (sourceHop >= maxPropagationHops) return [];
  const originId = source.regionIds.at(-1);
  if (!originId) return [];
  const origin = run.baseline.regions.find((region) => region.id === originId);
  if (!origin) return [];
  const scopedRegionIds = selectedRegionIds(run.baseline, run.scenario);
  const result: SimulationEvent[] = [];
  let eventBranch = branch;
  const propagatedKnowledgeIds = new Set(
    source.propagationContext?.knowledgeIds ?? [],
  );
  if (!source.propagationContext) {
    const sourceCharacterIds = new Set(
      source.characterIds.length > 0
        ? source.characterIds
        : branch.state.characters
            .filter(
              (character) =>
                character.alive && character.locationId === originId,
            )
            .map((character) => character.id),
    );
    sourceCharacterIds.forEach((characterId) => {
      const runtime = branch.state.characters.find(
        (character) => character.id === characterId,
      );
      rememberedKnowledgeIds(runtime, branch.state.currentTime.sortKey).forEach(
        (knowledgeId) => propagatedKnowledgeIds.add(knowledgeId),
      );
    });
    source.commands.forEach((command) => {
      if (command.type === "character.knowledge")
        propagatedKnowledgeIds.add(command.knowledgeId);
    });
  }
  const nextHop = sourceHop + 1;
  const emittedConnectionIds = new Set<string>();
  [...origin.connections]
    .filter(isPropagationConnection)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((connection) => {
      if (emittedConnectionIds.has(connection.id)) return;
      emittedConnectionIds.add(connection.id);
      const targetId = nextReachableRegionId(connection, originId);
      if (!targetId) return;
      const targetIsInScope = scopedRegionIds.has(targetId);
      if (!targetIsInScope && run.scenario.scope.outsidePolicy === "ignore")
        return;
      const connectionCapacity = Math.max(
        0,
        Math.min(
          100,
          Number.isFinite(connection.capacity) ? connection.capacity : 0,
        ),
      );
      if (connectionCapacity <= 0) return;
      const boundaryFactor =
        !targetIsInScope && run.scenario.scope.outsidePolicy === "approximate"
          ? 0.45
          : 1;
      const capacityFactor = connectionCapacity / 100;
      const delta = Math.max(
        1,
        Math.round(
          5 * (1 - connection.attenuation) * boundaryFactor * capacityFactor,
        ),
      );
      const selection = selectPropagationKnowledge(
        run,
        [...propagatedKnowledgeIds],
        connection,
        nextHop,
        source.id,
      );
      const dueSortKey = travelArrivalSortKey(
        nextSortKey,
        connection.travelDays,
      );
      const targetName =
        run.baseline.regions.find((region) => region.id === targetId)?.name ??
        "相邻地域";
      const propagation = event(run, eventBranch, nextSortKey, scale, {
        kind: "propagation",
        title: `${source.title}的影响开始向${targetName}传播`,
        summary: `事件沿${connection.kind}通道前往${targetName}，预计${createWorldInstant(dueSortKey, run.scenario.calendar).displayText}抵达，这是第 ${nextHop} 跳；通道容量 ${Math.round(connectionCapacity)}%，载荷${selection.capacityDroppedCount > 0 ? `因容量舍弃 ${selection.capacityDroppedCount} 条知识` : "未超限"}${selection.distortedCount > 0 ? `，其中 ${selection.distortedCount} 条谣言发生失真` : ""}。${!targetIsInScope && run.scenario.scope.outsidePolicy === "approximate" ? "范围外地域按统计近似处理。" : ""}`,
        characterIds: source.characterIds,
        factionIds: source.factionIds,
        regionIds: [originId, targetId],
        itemIds: source.itemIds,
        causeEventIds: [source.id],
        evidence: [
          {
            type: "spatial-path",
            label: "传播路径",
            detail: `${originId} → ${targetId}，行程 ${connection.travelDays} 日，衰减 ${Math.round(connection.attenuation * 100)}%`,
            authority: "canon",
            sourceRefs: connection.sourceRefs,
          },
        ],
        commands: [
          {
            type: "effect.schedule",
            effect: {
              id: `effect-${source.id}-${connection.id}`,
              kind: "propagation",
              dueSortKey,
              sourceEventId: source.id,
              connectionId: connection.id,
              originRegionId: originId,
              targetRegionId: targetId,
              pressureDelta: delta,
              stabilityDelta: -Math.max(1, Math.round(delta / 2)),
              hop: nextHop,
              ...(selection.knowledgeIds.length > 0
                ? { knowledgeIds: selection.knowledgeIds }
                : {}),
            },
          },
        ],
        narrativeConstraintIds: source.narrativeConstraintIds,
        generatedBy: "kernel",
        confidence: 0.9,
        propagationContext: {
          hop: nextHop,
          knowledgeIds: selection.knowledgeIds,
          ...(selection.distortedCount > 0
            ? { distortedKnowledgeCount: selection.distortedCount }
            : {}),
        },
      });
      result.push(propagation);
      eventBranch = {
        ...eventBranch,
        ledger: [...eventBranch.ledger, propagation],
      };
    });
  return result;
}

function scheduledArrivalEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  scale: TimeScale,
): readonly SimulationEvent[] {
  let eventBranch = branch;
  const result: SimulationEvent[] = [];
  branch.state.characters
    .filter(
      (character) =>
        character.travel !== null &&
        parseWorldTick(character.travel.arrivalSortKey) <=
          parseWorldTick(nextSortKey),
    )
    .forEach((runtime) => {
      if (!runtime.travel) return;
      const character = run.baseline.characters.find(
        (item) => item.id === runtime.id,
      );
      if (!character) return;
      const departure = eventBranch.ledger
        .slice()
        .reverse()
        .find((entry) =>
          entry.commands.some(
            (command) =>
              command.type === "character.move" &&
              command.characterId === character.id &&
              command.arrivalSortKey === runtime.travel?.arrivalSortKey,
          ),
        );
      const route = runtime.travel.fromRegionId
        ? findSpatialRoute(
            run.baseline,
            runtime.travel.fromRegionId,
            runtime.travel.toRegionId,
          )
        : null;
      const routeText = route
        ? `${route.regionIds.join(" → ")}，行程 ${route.travelDays.toString()} 日`
        : `${runtime.travel.fromRegionId} → ${runtime.travel.toRegionId}`;
      const arrival = event(run, eventBranch, nextSortKey, scale, {
        kind: "character-action",
        title: `${character.name}抵达${run.baseline.regions.find((region) => region.id === runtime.travel?.toRegionId)?.name ?? "目标地域"}`,
        summary: `${character.name}完成跨地域行动，旅行期间未参与其它主体决策。`,
        characterIds: [character.id],
        factionIds: [...character.factionIds],
        regionIds: [
          runtime.travel.fromRegionId,
          runtime.travel.toRegionId,
        ].filter((value): value is string => Boolean(value)),
        itemIds: [...character.inventoryItemIds],
        causeEventIds: departure ? [departure.id] : [],
        evidence: [
          {
            type: "spatial-path",
            label: "人物旅行",
            detail: routeText,
            authority: "canon",
            sourceRefs: route
              ? route.connections.flatMap((connection) => connection.sourceRefs)
              : character.sourceRefs,
          },
        ],
        commands: [
          {
            type: "character.arrive",
            characterId: character.id,
            toRegionId: runtime.travel.toRegionId,
          },
        ],
        narrativeConstraintIds: activeNarrativeConstraints(run, branch)
          .filter((constraint) => constraint.entityIds.includes(character.id))
          .map((constraint) => constraint.id),
        generatedBy: "kernel",
        confidence: 1,
      });
      result.push(arrival);
      eventBranch = {
        ...eventBranch,
        ledger: [...eventBranch.ledger, arrival],
      };
    });
  return result;
}

function scheduledEffectArrivalEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  scale: TimeScale,
): readonly SimulationEvent[] {
  let eventBranch = branch;
  const result: SimulationEvent[] = [];
  // 固定轮跨度下，已在本轮窗口内到期的影响统一在轮次终点结算。
  // 这不会提前生效，也不会因为终点没有恰好落在传播日而永久滞留。
  branch.state.scheduledEffects
    .filter(
      (effect) =>
        parseWorldTick(effect.dueSortKey) <= parseWorldTick(nextSortKey),
    )
    .forEach((effect) => {
      const target = run.baseline.regions.find(
        (region) => region.id === effect.targetRegionId,
      );
      const propagationHop = effect.hop ?? 1;
      const rememberedKnowledgeIdsAtTarget = new Set(effect.knowledgeIds ?? []);
      const recipients = run.baseline.characters.filter((character) => {
        const runtime = branch.state.characters.find(
          (candidate) => candidate.id === character.id,
        );
        if (!runtime?.alive) return false;
        const isAtTarget =
          runtime.locationId === effect.targetRegionId ||
          (runtime.travel !== null &&
            parseWorldTick(runtime.travel.arrivalSortKey) <=
              parseWorldTick(nextSortKey) &&
            runtime.travel.toRegionId === effect.targetRegionId);
        return (
          isAtTarget &&
          character.knowledge.some((knowledge) =>
            rememberedKnowledgeIdsAtTarget.has(knowledge.id),
          )
        );
      });
      const knowledgeCommands = recipients.flatMap((character) =>
        character.knowledge
          .filter((knowledge) =>
            rememberedKnowledgeIdsAtTarget.has(knowledge.id),
          )
          .map(
            (knowledge) =>
              ({
                type: "character.knowledge",
                characterId: character.id,
                knowledgeId: knowledge.id,
              }) as const,
          ),
      );
      const arrival = event(run, eventBranch, nextSortKey, scale, {
        kind: "propagation",
        title: `影响抵达${target?.name ?? "目标地域"}`,
        summary: `来自${effect.originRegionId}的影响沿${effect.connectionId}抵达（第 ${propagationHop} 跳），压力与稳定度变化现在才生效${knowledgeCommands.length > 0 ? `；${recipients.length} 名目标地域人物已更新可回忆知识` : ""}。`,
        characterIds: recipients.map((character) => character.id),
        factionIds: [],
        regionIds: [effect.originRegionId, effect.targetRegionId],
        itemIds: [],
        causeEventIds: [effect.sourceEventId],
        evidence: [
          {
            type: "spatial-path",
            label: "传播到达",
            detail: `${effect.originRegionId} → ${effect.targetRegionId}`,
            authority: "canon",
            sourceRefs: target?.sourceRefs ?? [],
          },
        ],
        commands: [
          {
            type: "region.metric",
            regionId: effect.targetRegionId,
            metric: "pressure",
            delta: effect.pressureDelta,
          },
          {
            type: "region.metric",
            regionId: effect.targetRegionId,
            metric: "stability",
            delta: effect.stabilityDelta,
          },
          ...knowledgeCommands,
          { type: "effect.consume", effectId: effect.id },
        ],
        narrativeConstraintIds: [],
        generatedBy: "kernel",
        confidence: 1,
        propagationContext: {
          hop: propagationHop,
          knowledgeIds: [...rememberedKnowledgeIdsAtTarget].sort(),
        },
      });
      result.push(arrival);
      eventBranch = {
        ...eventBranch,
        ledger: [...eventBranch.ledger, arrival],
      };
    });
  return result;
}

function visibleItemIds(
  run: WorldSimulationRun,
  characterIds: ReadonlySet<string>,
  factionIds: ReadonlySet<string>,
): Set<string> {
  return new Set([
    ...run.baseline.characters
      .filter((character) => characterIds.has(character.id))
      .flatMap((character) => character.inventoryItemIds),
    ...run.baseline.factions
      .filter((faction) => factionIds.has(faction.id))
      .flatMap((faction) =>
        faction.resources.flatMap((resource) =>
          resource.itemId ? [resource.itemId] : [],
        ),
      ),
  ]);
}

function validateItemTransferCommand(
  run: WorldSimulationRun,
  command: Extract<WorldDomainCommand, { readonly type: "item.transfer" }>,
  access: {
    readonly itemIds: ReadonlySet<string>;
    readonly characterIds: ReadonlySet<string>;
    readonly factionIds: ReadonlySet<string>;
    readonly regionIds: ReadonlySet<string>;
  },
  source: "模型候选" | "会商方案",
): void {
  if (!access.itemIds.has(command.itemId)) {
    throw new Error(`${source}试图操作不可见物品`);
  }
  if (command.ownerType === "character") {
    if (!command.ownerId || !access.characterIds.has(command.ownerId)) {
      throw new Error(`${source}试图把物品交给不可见人物`);
    }
  } else if (command.ownerType === "faction") {
    if (!command.ownerId || !access.factionIds.has(command.ownerId)) {
      throw new Error(`${source}试图把物品交给不可见势力`);
    }
  } else if (command.ownerId !== null) {
    throw new Error(`${source}将无主物品错误地绑定到主体`);
  }
  if (
    command.locationId !== null &&
    !access.regionIds.has(command.locationId)
  ) {
    throw new Error(`${source}试图把物品放入范围外地域`);
  }
}

function validateCommandsAgainstWorld(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  commands: readonly WorldDomainCommand[],
  eventTimeSortKey: string,
  source: string,
): void {
  const visibleRegions = selectedRegionIds(run.baseline, run.scenario);
  const timedState = advanceRuntimeClock(
    branch.state,
    createWorldInstant(eventTimeSortKey, run.scenario.calendar),
    run.scenario.calendar,
  );
  let state = timedState;
  for (const command of commands) {
    if (command.type === "region.metric" || command.type === "region.control") {
      if (source !== "内核事件" && !visibleRegions.has(command.regionId))
        throw new Error(`${source}操作了范围外地域`);
    }
    if (command.type === "character.move") {
      assertCharacterMoveHasSpatialPath(
        run,
        { ...branch, state },
        command,
        visibleRegions,
        eventTimeSortKey,
        source,
      );
      const targetRules = run.baseline.rules.filter(
        (rule) =>
          rule.severity === "hard" &&
          rule.regionId === command.toRegionId &&
          /禁止|不可|不能|封闭|无法.{0,4}(进入|跨越|移动)/u.test(
            rule.description,
          ),
      );
      if (targetRules.length > 0)
        throw new Error(
          `${source}违反地域硬规则：${targetRules.map((rule) => rule.title).join("、")}`,
        );
    }
    if (command.type === "character.cultivate" && command.nextLevelId) {
      const character = run.baseline.characters.find(
        (item) => item.id === command.characterId,
      );
      const runtime = state.characters.find(
        (item) => item.id === command.characterId,
      );
      const system = character?.cultivation.systemId
        ? run.baseline.cultivationSystems.find(
            (item) => item.id === character.cultivation.systemId,
          )
        : undefined;
      const currentLevel = system?.levels.find(
        (level) =>
          level.id === (runtime?.levelId ?? character?.cultivation.levelId),
      );
      const nextLevel = system?.levels.find(
        (level) => level.id === command.nextLevelId,
      );
      if (!nextLevel || (currentLevel && nextLevel.order <= currentLevel.order))
        throw new Error(`${source}的修炼境界跃迁顺序无效`);
      for (const resourceId of nextLevel.resourceIds) {
        if ((runtime?.resourceBalances?.[resourceId] ?? 0) < 1)
          throw new Error(`${source}突破资源不足：${resourceId}`);
        if ((command.resourceCosts?.[resourceId] ?? 0) < 1)
          throw new Error(`${source}的突破没有提交资源消耗：${resourceId}`);
      }
      const hardConstraints = [
        ...(system?.hardConstraints ?? []),
        ...nextLevel.breakthroughConditions,
      ];
      if (
        hardConstraints.some(
          (condition) =>
            /禁止|不得|不能/u.test(condition) &&
            /突破|修炼|跃迁/u.test(condition),
        )
      ) {
        throw new Error(`${source}违反修炼硬规则`);
      }
    }
    validateRuntimeCommand(state, command);
    state = applyWorldDomainCommands(state, [command]);
  }
}

function validateModelCandidate(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  candidate: ModelDecisionCandidate,
  eventTimeSortKey = branch.state.currentTime.sortKey,
  subject: SimulationDecisionSubject | null = null,
): void {
  if (!candidate.title.trim() || !candidate.summary.trim())
    throw new Error("模型候选缺少标题或摘要");
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  )
    throw new Error("模型候选置信度必须在 0 到 1 之间");
  if (
    candidate.expectedUtility !== undefined &&
    (!Number.isFinite(candidate.expectedUtility) ||
      candidate.expectedUtility < 0 ||
      candidate.expectedUtility > 100)
  )
    throw new Error("模型候选预期效用必须在 0 到 100 之间");
  if (candidate.commands.length === 0)
    throw new Error("模型候选没有可验证的状态提交");
  if (candidate.characterIds.length + candidate.factionIds.length === 0)
    throw new Error("模型候选没有关联当前可行动主体");
  const characters = new Set(run.baseline.characters.map((item) => item.id));
  const factions = new Set(run.baseline.factions.map((item) => item.id));
  const regions = new Set(run.baseline.regions.map((item) => item.id));
  const items = new Set(run.baseline.items.map((item) => item.id));
  if (
    candidate.characterIds.some((id) => !characters.has(id)) ||
    candidate.factionIds.some((id) => !factions.has(id)) ||
    candidate.regionIds.some((id) => !regions.has(id)) ||
    candidate.itemIds.some((id) => !items.has(id))
  ) {
    throw new Error("模型候选引用了基线中不存在的实体");
  }
  const visibleCharacters = activeCharacters(run, branch);
  const visibleFactions = activeFactions(run, branch);
  const visibleCharacterIds = new Set(
    visibleCharacters.map((character) => character.id),
  );
  const visibleFactionIds = new Set(
    visibleFactions.map((faction) => faction.id),
  );
  const visibleItems = visibleItemIds(
    run,
    visibleCharacterIds,
    visibleFactionIds,
  );
  const visibleRegions = selectedRegionIds(run.baseline, run.scenario);
  if (
    candidate.characterIds.some((id) => !visibleCharacterIds.has(id)) ||
    candidate.factionIds.some((id) => !visibleFactionIds.has(id))
  ) {
    throw new Error("模型候选超出了当前主体的知识与行动边界");
  }
  if (
    subject &&
    (subject.type === "character"
      ? !candidate.characterIds.includes(subject.id)
      : !candidate.factionIds.includes(subject.id))
  ) {
    throw new Error("模型候选没有关联其受限决策主体");
  }
  if (candidate.itemIds.some((id) => !visibleItems.has(id))) {
    throw new Error("模型候选试图操作不可见物品");
  }
  const visibleKnowledge = new Map(
    visibleCharacters.map((character) => [
      character.id,
      new Set(
        visibleKnowledgeForCharacter(run, branch, character.id).map(
          (knowledge) => knowledge.id,
        ),
      ),
    ]),
  );
  candidate.commands.forEach((command) => {
    if (
      command.type === "character.arrive" ||
      command.type === "effect.schedule" ||
      command.type === "effect.consume" ||
      command.type === "world.emergent"
    ) {
      throw new Error("模型候选不得直接提交旅行、空间传播或新生主体内部命令");
    }
    if (
      command.type === "character.knowledge" &&
      !visibleKnowledge.get(command.characterId)?.has(command.knowledgeId)
    ) {
      throw new Error("模型候选试图让人物获得其尚未掌握的知识");
    }
    if (
      command.type === "character.relation" &&
      !visibleCharacterIds.has(command.targetCharacterId)
    ) {
      throw new Error("模型候选操作了不可见的人物关系目标");
    }
    if (
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
        command.type === "character.resource" ||
        command.type === "character.relation" ||
        command.type === "character.life" ||
        command.type === "character.knowledge") &&
      !visibleCharacterIds.has(command.characterId)
    )
      throw new Error("模型候选操作了不可见人物");
    if (
      subject?.type === "character" &&
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
        command.type === "character.resource" ||
        command.type === "character.relation" ||
        command.type === "character.life" ||
        command.type === "character.knowledge") &&
      command.characterId !== subject.id
    ) {
      throw new Error("人物模型候选不能替其它人物提交命令");
    }
    if (
      command.type === "faction.relation" &&
      !visibleFactionIds.has(command.targetFactionId)
    ) {
      throw new Error("模型候选操作了不可见的势力关系目标");
    }
    if (
      (command.type === "faction.strategy" ||
        command.type === "faction.metric" ||
        command.type === "faction.relation") &&
      !visibleFactionIds.has(command.factionId)
    )
      throw new Error("模型候选操作了不可见势力");
    if (
      subject?.type === "faction" &&
      (command.type === "faction.strategy" ||
        command.type === "faction.metric" ||
        command.type === "faction.relation") &&
      command.factionId !== subject.id
    ) {
      throw new Error("势力模型候选不能替其它势力提交命令");
    }
    if (
      subject?.type === "character" &&
      (command.type === "faction.strategy" ||
        command.type === "faction.metric" ||
        command.type === "faction.relation")
    ) {
      throw new Error("人物模型候选不能直接提交势力命令");
    }
    if (
      subject?.type === "faction" &&
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
        command.type === "character.resource" ||
        command.type === "character.relation" ||
        command.type === "character.life" ||
        command.type === "character.knowledge")
    ) {
      throw new Error("势力模型候选不能直接提交人物命令");
    }
    if (
      (command.type === "region.metric" || command.type === "region.control") &&
      !visibleRegions.has(command.regionId)
    )
      throw new Error("模型候选操作了范围外地域");
    if (command.type === "character.move") {
      assertCharacterMoveHasSpatialPath(
        run,
        branch,
        command,
        visibleRegions,
        eventTimeSortKey,
        "模型候选",
      );
    }
    if (command.type === "item.transfer") {
      validateItemTransferCommand(
        run,
        command,
        {
          itemIds: visibleItems,
          characterIds: visibleCharacterIds,
          factionIds: visibleFactionIds,
          regionIds: visibleRegions,
        },
        "模型候选",
      );
    }
  });
  applyWorldDomainCommands(
    {
      ...branch.state,
      currentTime: createWorldInstant(eventTimeSortKey, run.scenario.calendar),
    },
    candidate.commands,
  );
  validateCommandsAgainstWorld(
    run,
    branch,
    candidate.commands,
    eventTimeSortKey,
    "模型候选",
  );
}

function modelEvent(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  scale: TimeScale,
  candidate: ModelDecisionCandidate,
  subject: SimulationDecisionSubject | null,
  rawModelOutput?: string,
): SimulationEvent {
  validateModelCandidate(run, branch, candidate, nextSortKey, subject);
  const {
    objective,
    perceivedFacts,
    assumptions,
    expectedUtility,
    risks,
    ...eventCandidate
  } = candidate;
  return event(run, branch, nextSortKey, scale, {
    ...eventCandidate,
    evidence: [
      {
        type: "knowledge",
        label: "受控智能候选",
        detail: "候选已通过实体、命令和状态边界校验。",
        authority: "simulated",
        sourceRefs: [],
      },
      ...(activeAuthorConstraints(run, branch).length > 0
        ? [
            {
              type: "narrative-constraint" as const,
              label: "作者约束",
              detail: activeAuthorConstraints(run, branch).join("；"),
              authority: "constraint" as const,
              sourceRefs: [],
            },
          ]
        : []),
    ],
    narrativeConstraintIds: activeNarrativeConstraints(run, branch)
      .filter((constraint) =>
        [...candidate.characterIds, ...candidate.factionIds].some((id) =>
          constraint.entityIds.includes(id),
        ),
      )
      .map((constraint) => constraint.id),
    generatedBy: "model",
    confidence: clamp(candidate.confidence, 0, 1),
    decisionAudit: {
      subject,
      objective: objective?.trim() || run.scenario.objective,
      perceivedFacts: [...(perceivedFacts ?? [])],
      assumptions: [...(assumptions ?? [])],
      expectedUtility: clamp(expectedUtility ?? candidate.confidence * 100),
      risks: [...(risks ?? [])],
    },
    ...(rawModelOutput ? { rawModelOutput } : {}),
  });
}

function commandWriteKeys(command: WorldDomainCommand): readonly string[] {
  switch (command.type) {
    case "character.intent":
      return [`character:${command.characterId}:intent`];
    case "character.move":
      return [`character:${command.characterId}:location`];
    case "character.arrive":
      return [`character:${command.characterId}:location`];
    case "character.cultivate":
      return [
        `character:${command.characterId}:cultivation`,
        ...Object.keys(command.resourceCosts ?? {}).map(
          (resourceId) =>
            `character:${command.characterId}:resource:${resourceId}`,
        ),
      ];
    case "character.resource":
      return [
        `character:${command.characterId}:resource:${command.resourceId}`,
      ];
    case "character.relation":
      return [
        `character:${command.characterId}:relation:${command.targetCharacterId}`,
      ];
    case "character.life":
      return [`character:${command.characterId}:life`];
    case "character.knowledge":
      return [
        `character:${command.characterId}:knowledge:${command.knowledgeId}`,
      ];
    case "faction.strategy":
      return [`faction:${command.factionId}:strategy`];
    case "faction.metric":
      return [`faction:${command.factionId}:metric:${command.metric}`];
    case "faction.relation":
      return [
        `faction:${command.factionId}:relation:${command.targetFactionId}`,
      ];
    case "region.metric":
      return [`region:${command.regionId}:metric:${command.metric}`];
    case "region.control":
      return [`region:${command.regionId}:control`];
    case "item.transfer":
      return [`item:${command.itemId}:ownership`];
    case "world.emergent":
      return [`world:emergent:${command.entity.id}`];
    case "effect.schedule":
      return [`effect:${command.effect.id}`];
    case "effect.consume":
      return [`effect:${command.effectId}`];
    default:
      return [];
  }
}

function candidateWriteKeys(
  candidate: ModelDecisionCandidate,
): readonly string[] {
  return candidate.commands.flatMap(commandWriteKeys);
}

function candidateSortKey(submission: ModelDecisionSubmission): string {
  const subject = submission.subject
    ? `${submission.subject.type}:${submission.subject.id}`
    : "unknown:";
  return `${subject}:${submission.candidate.title}`;
}

function aggregateObservations(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  ledger: readonly SimulationEvent[],
): ObservationPoint[] {
  const start = parseWorldTick(run.baseline.anchor.sortKey);
  const observations: ObservationPoint[] = [];
  run.scenario.outputScales.forEach((scale) => {
    const bucketSize = scaleToDays(scale, run.scenario.calendar);
    const groups = new Map<string, SimulationEvent[]>();
    ledger.forEach((entry) => {
      const bucket = (
        (parseWorldTick(entry.time.sortKey) - start) /
        bucketSize
      ).toString();
      groups.set(bucket, [...(groups.get(bucket) ?? []), entry]);
    });
    groups.forEach((events, bucket) => {
      const bucketStart = start + BigInt(bucket) * bucketSize;
      const pressure = events
        .flatMap((entry) => entry.commands)
        .filter(
          (
            command,
          ): command is Extract<
            WorldDomainCommand,
            { type: "region.metric" }
          > =>
            command.type === "region.metric" && command.metric === "pressure",
        )
        .reduce((sum, command) => sum + command.delta, 0);
      const kinds = new Set(events.map((entry) => entry.kind));
      observations.push({
        id: `observation-${branch.id}-${scale}-${bucket}`,
        scale,
        startSortKey: bucketStart.toString(),
        endSortKey: (bucketStart + bucketSize).toString(),
        title:
          events.length === 1
            ? events[0]!.title
            : `${events.length} 个事件共同改变世界状态`,
        summary: events
          .map((entry) => entry.summary)
          .slice(0, 3)
          .join(" "),
        eventIds: events.map((entry) => entry.id),
        dominantRegionIds: [
          ...new Set(events.flatMap((entry) => entry.regionIds)),
        ].slice(0, 4),
        dominantActorIds: [
          ...new Set(
            events.flatMap((entry) => [
              ...entry.characterIds,
              ...entry.factionIds,
            ]),
          ),
        ].slice(0, 6),
        trend: kinds.has("epoch")
          ? "transforming"
          : Math.abs(pressure) >= 8
            ? "volatile"
            : pressure > 0
              ? "rising"
              : pressure < 0
                ? "falling"
                : "stable",
      });
    });
  });
  return observations.sort((left, right) =>
    left.startSortKey === right.startSortKey
      ? run.scenario.outputScales.indexOf(left.scale) -
        run.scenario.outputScales.indexOf(right.scale)
      : parseWorldTick(left.startSortKey) < parseWorldTick(right.startSortKey)
        ? -1
        : 1,
  );
}

function strictNarrativeViolation(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  events: readonly SimulationEvent[],
  currentTimeSortKey?: string,
): string | null {
  const strictConstraints = (
    branch.narrativePolicy === "disabled"
      ? []
      : run.baseline.narrativeConstraints
  ).filter((constraint) => constraint.mode === "strict");
  if (strictConstraints.length === 0) return null;
  for (const event of events) {
    const activeAtEvent = strictConstraints.filter((constraint) => {
      const sortKey = parseWorldTick(event.time.sortKey);
      const start = constraint.timeWindow?.startSortKey;
      const end = constraint.timeWindow?.endSortKey;
      return (
        (!start || sortKey >= parseWorldTick(start)) &&
        (!end || sortKey <= parseWorldTick(end))
      );
    });
    for (const constraint of activeAtEvent) {
      const forbidden = constraint.forbiddenOutcomes ?? [];
      const forbiddenOutcome = forbidden.find((outcome) =>
        outcomeMatchesEvent(outcome, event),
      );
      if (forbiddenOutcome) {
        return `剧情不可实现：强约束“${constraint.title}”禁止结果“${forbiddenOutcome.id}”在${event.time.displayText}发生。`;
      }
    }
    for (const command of event.commands) {
      if (command.type !== "character.life" || command.alive) continue;
      const character = run.baseline.characters.find(
        (item) => item.id === command.characterId,
      );
      const constraint = strictConstraints.find((item) => {
        const eventTime = parseWorldTick(event.time.sortKey);
        const start = item.timeWindow?.startSortKey;
        const end = item.timeWindow?.endSortKey;
        if (start && eventTime < parseWorldTick(start)) return false;
        if (end && eventTime > parseWorldTick(end)) return false;
        const mentionsCharacter =
          item.entityIds.includes(command.characterId) ||
          Boolean(character && item.content.includes(character.name));
        return (
          mentionsCharacter &&
          /(存活|活着|不得.{0,4}(死亡|离世|陨落)|不能.{0,4}(死亡|离世|陨落))/u.test(
            item.content,
          )
        );
      });
      if (constraint)
        return `剧情不可实现：强约束“${constraint.title}”要求${character?.name ?? command.characterId}存活，但寿命或规则裁定要求其离世。`;
    }
  }
  const ledger = [...branch.ledger, ...events];
  const cursor =
    currentTimeSortKey ??
    events.at(-1)?.time.sortKey ??
    branch.state.currentTime.sortKey;
  const endSortKey = getSimulationEndSortKey(run);
  for (const evaluation of evaluateNarrativeConstraints(run, branch, ledger)) {
    const end = evaluation.constraint.timeWindow?.endSortKey ?? endSortKey;
    if (parseWorldTick(cursor) < parseWorldTick(end)) continue;
    const threshold = Math.ceil(
      (evaluation.requiredCount *
        (100 -
          Math.max(
            0,
            Math.min(100, evaluation.constraint.flexibility ?? 50),
          ))) /
        100,
    );
    if (evaluation.requiredSatisfied < threshold) {
      return `剧情不可实现：强约束“${evaluation.constraint.title}”在时间窗结束时仅达成 ${evaluation.requiredSatisfied}/${evaluation.requiredCount} 项必需结果。`;
    }
  }
  return null;
}

function pauseForStrictNarrativeViolation(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  message: string,
): SimulationBranch {
  const diagnostic = event(
    run,
    branch,
    branch.state.currentTime.sortKey,
    "day",
    {
      kind: "world-process",
      title: "剧情不可实现，推演已暂停",
      summary: message,
      characterIds: [],
      factionIds: [],
      regionIds: [],
      itemIds: [],
      evidence: [
        {
          type: "narrative-constraint",
          label: "强剧情约束冲突",
          detail: message,
          authority: "constraint",
          sourceRefs: [],
        },
      ],
      commands: [],
      narrativeConstraintIds: activeNarrativeConstraints(run, branch)
        .filter((constraint) => constraint.mode === "strict")
        .map((constraint) => constraint.id),
      generatedBy: "kernel",
      confidence: 1,
    },
  );
  const ledger = [...branch.ledger, diagnostic].map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
  return {
    ...branch,
    status: "paused",
    ledger,
    observations: aggregateObservations(run, branch, ledger),
    warnings: branch.warnings.includes(message)
      ? branch.warnings
      : [...branch.warnings, message],
  };
}

function advanceSingleStep(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  externalCandidates: readonly ModelDecisionSubmission[] = [],
  modelCallsUsed = 0,
): SimulationBranch {
  if (!Number.isInteger(modelCallsUsed) || modelCallsUsed < 0) {
    throw new Error("本步模型调用计数必须是非负整数");
  }
  if (branch.warnings.some((warning) => warning.startsWith("剧情不可实现：")))
    return { ...branch, status: "paused" };
  const configuredMaxEvents =
    run.scenario.maxEvents ?? Number.POSITIVE_INFINITY;
  const configuredMaxDecisions =
    run.scenario.maxDecisions ?? Number.POSITIVE_INFINITY;
  const modelCallLimit = run.scenario.maxModelCalls ?? Number.POSITIVE_INFINITY;
  if ((branch.modelCallCount ?? 0) + modelCallsUsed > modelCallLimit) {
    throw new Error(
      `本步模型调用会超过预算（${modelCallLimit}），请在请求模型前停止推演`,
    );
  }
  if (branch.ledger.length >= configuredMaxEvents) {
    const warning = `已达到事件预算（${configuredMaxEvents}），推演已暂停并保存检查点。`;
    return {
      ...branch,
      status: "paused",
      warnings: branch.warnings.includes(warning)
        ? branch.warnings
        : [...branch.warnings, warning],
    };
  }
  if ((branch.decisionCount ?? 0) >= configuredMaxDecisions) {
    const warning = `已达到主体决策预算（${configuredMaxDecisions}），推演已暂停并保存检查点。`;
    return {
      ...branch,
      status: "paused",
      warnings: branch.warnings.includes(warning)
        ? branch.warnings
        : [...branch.warnings, warning],
    };
  }
  if (
    run.scenario.intelligence.mode === "assisted" &&
    (branch.modelCallCount ?? 0) >= modelCallLimit
  ) {
    const warning = `已达到模型调用预算（${modelCallLimit}），推演已暂停并保存检查点。`;
    return {
      ...branch,
      status: "paused",
      warnings: branch.warnings.includes(warning)
        ? branch.warnings
        : [...branch.warnings, warning],
    };
  }
  const endSortKey = getSimulationEndSortKey(run);
  const current = parseWorldTick(branch.state.currentTime.sortKey);
  const end = parseWorldTick(endSortKey);
  if (current >= end) return { ...branch, status: "completed" };
  // V4 的一轮是用户设置的固定时间跨度。内部不再按 maxSteps 自适应切片，
  // 这样单轮、连续运行、时间线和重放使用同一个时间契约。
  const roundSpanDays = durationToDays(
    run.scenario.roundSpan,
    run.scenario.calendar,
  );
  const nextSortKey = (
    current + roundSpanDays > end ? end : current + roundSpanDays
  ).toString();
  const actualStepDays = parseWorldTick(nextSortKey) - current;
  const scale = resolveEventScale(actualStepDays, run.scenario.calendar);
  const scheduledEvents = [
    ...scheduledArrivalEvents(run, branch, nextSortKey, scale),
    ...scheduledEffectArrivalEvents(run, branch, nextSortKey, scale),
  ];
  const periodicEvents = periodicRuleEvents(
    run,
    { ...branch, ledger: [...branch.ledger, ...scheduledEvents] },
    nextSortKey,
    scale,
  );
  const characters = activeCharacters(run, branch)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const factions = activeFactions(run, branch)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const maxDecisions = run.scenario.maxDecisions ?? Number.POSITIVE_INFINITY;
  let decisionsUsed = branch.decisionCount ?? 0;
  const constrainedIds = new Set(
    activeNarrativeConstraints(run, branch)
      .filter(
        (constraint) =>
          constraint.mode === "guide" || constraint.mode === "strict",
      )
      .flatMap((constraint) => constraint.entityIds),
  );
  const orderedCharacters = characters.slice().sort((left, right) => {
    const leftGuided = constrainedIds.has(left.id) ? 0 : 1;
    const rightGuided = constrainedIds.has(right.id) ? 0 : 1;
    return leftGuided - rightGuided || left.id.localeCompare(right.id);
  });
  const orderedFactions = factions.slice().sort((left, right) => {
    const leftGuided = constrainedIds.has(left.id) ? 0 : 1;
    const rightGuided = constrainedIds.has(right.id) ? 0 : 1;
    return leftGuided - rightGuided || left.id.localeCompare(right.id);
  });
  const events: SimulationEvent[] = [...scheduledEvents, ...periodicEvents];
  let workingBranch: SimulationBranch = {
    ...branch,
    ledger: [...branch.ledger, ...scheduledEvents, ...periodicEvents],
  };
  for (const character of orderedCharacters) {
    if (decisionsUsed >= maxDecisions) break;
    decisionsUsed += 1;
    const characterAction = characterEvent(
      run,
      workingBranch,
      character,
      nextSortKey,
      actualStepDays,
      scale,
    );
    if (characterAction) {
      events.push(characterAction);
      workingBranch = {
        ...workingBranch,
        ledger: [...workingBranch.ledger, characterAction],
      };
    }
  }
  for (const faction of orderedFactions) {
    if (decisionsUsed >= maxDecisions) break;
    decisionsUsed += 1;
    const factionAction = factionEvent(
      run,
      workingBranch,
      faction,
      nextSortKey,
      scale,
    );
    if (factionAction) {
      events.push(factionAction);
      workingBranch = {
        ...workingBranch,
        ledger: [...workingBranch.ledger, factionAction],
      };
    }
  }
  const worldEvents = worldProcessEvents(
    run,
    workingBranch,
    nextSortKey,
    actualStepDays,
    scale,
  );
  if (worldEvents.length > 0) {
    events.push(...worldEvents);
    workingBranch = {
      ...workingBranch,
      ledger: [...workingBranch.ledger, ...worldEvents],
    };
  }
  const arbitrationTime = createWorldInstant(
    nextSortKey,
    run.scenario.calendar,
    scale === "day"
      ? "day"
      : scale === "month"
        ? "month"
        : scale === "year"
          ? "year"
          : "era",
  );
  let arbitrationState = advanceRuntimeClock(
    branch.state,
    arbitrationTime,
    run.scenario.calendar,
    scale,
  );
  for (const entry of events) {
    arbitrationState = applyWorldDomainCommands(
      arbitrationState,
      entry.commands,
    );
  }
  const candidateValidationState = arbitrationState;
  const occupiedWriteKeys = new Set(
    events.flatMap((entry) => entry.commands.flatMap(commandWriteKeys)),
  );
  const arbitrationWarnings: string[] = [];
  const orderedCandidates = externalCandidates
    .slice()
    .sort((left, right) =>
      candidateSortKey(left).localeCompare(candidateSortKey(right)),
    );
  for (const {
    candidate: externalCandidate,
    subject,
    rawModelOutput,
  } of orderedCandidates) {
    // 所有同一时间边界的候选先针对同一个“确定性事件后状态”校验，
    // 再由稳定写入键裁定冲突；这样模型返回顺序不会改变世界结果。
    const model = modelEvent(
      run,
      {
        ...workingBranch,
        // 候选之间共享同一确定性基线状态；ledger 则保留已接受候选，
        // 让事件 ID 和因果引用仍按稳定顺序递增。
        state: candidateValidationState,
      },
      nextSortKey,
      scale,
      externalCandidate,
      subject,
      rawModelOutput,
    );
    const writeKeys = candidateWriteKeys(externalCandidate);
    const conflictKey = writeKeys.find((key) => occupiedWriteKeys.has(key));
    if (conflictKey) {
      arbitrationWarnings.push(
        `同一时间边界的模型候选“${externalCandidate.title}”因写入键 ${conflictKey} 与稳定顺序更高的候选冲突，已拒绝该候选。`,
      );
      continue;
    }
    arbitrationState = applyWorldDomainCommands(
      arbitrationState,
      model.commands,
    );
    writeKeys.forEach((key) => occupiedWriteKeys.add(key));
    events.push(model);
    workingBranch = {
      ...workingBranch,
      ledger: [...workingBranch.ledger, model],
    };
  }
  const propagationBranch: SimulationBranch = {
    ...workingBranch,
    // 传播必须读取本时间边界已经衰减并应用主体候选后的状态，
    // 否则长时间跳步会把已遗忘的知识错误地传播出去。
    state: arbitrationState,
  };
  const propagationSources = events.filter(
    (entry) =>
      entry.kind === "conflict" ||
      (entry.kind === "propagation" &&
        entry.propagationContext !== undefined &&
        entry.commands.some((command) => command.type === "effect.consume")),
  );
  const propagations: SimulationEvent[] = [];
  let propagationWorkingBranch = propagationBranch;
  propagationSources.forEach((source) => {
    const emitted = propagationEvents(
      run,
      propagationWorkingBranch,
      source,
      nextSortKey,
      scale,
    );
    if (emitted.length === 0) return;
    propagations.push(...emitted);
    propagationWorkingBranch = {
      ...propagationWorkingBranch,
      ledger: [...propagationWorkingBranch.ledger, ...emitted],
    };
  });
  if (propagations.length > 0) {
    events.push(...propagations);
    workingBranch = {
      ...propagationWorkingBranch,
      ledger: [...workingBranch.ledger, ...propagations],
    };
  }
  const maxEvents = run.scenario.maxEvents ?? Number.POSITIVE_INFINITY;
  const remainingEvents = Math.max(0, maxEvents - branch.ledger.length);
  const acceptedEvents = events.slice(0, remainingEvents);
  const eventBudgetExceeded = acceptedEvents.length < events.length;
  const strictViolation = strictNarrativeViolation(
    run,
    branch,
    acceptedEvents,
    nextSortKey,
  );
  if (strictViolation)
    return pauseForStrictNarrativeViolation(run, branch, strictViolation);

  const agedState = advanceRuntimeClock(
    branch.state,
    createWorldInstant(
      nextSortKey,
      run.scenario.calendar,
      scale === "day"
        ? "day"
        : scale === "month"
          ? "month"
          : scale === "year"
            ? "year"
            : "era",
    ),
    run.scenario.calendar,
    scale,
  );
  let validatedState = agedState;
  for (const entry of acceptedEvents) {
    const validationState: SimulationBranch = {
      ...branch,
      state: validatedState,
    };
    validateCommandsAgainstWorld(
      run,
      validationState,
      entry.commands,
      nextSortKey,
      "内核事件",
    );
    validatedState = applyWorldDomainCommands(validatedState, entry.commands);
  }
  const nextState = validatedState;
  const ledger = [...branch.ledger, ...acceptedEvents].map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
  const checkpoint: SimulationCheckpoint = {
    id: `checkpoint-${String(branch.checkpoints.length).padStart(4, "0")}`,
    label: nextState.currentTime.displayText,
    eventSequence: ledger.length,
    createdAt: new Date().toISOString(),
    state: nextState,
  };
  const nextModelCallCount = (branch.modelCallCount ?? 0) + modelCallsUsed;
  const nextBranch: SimulationBranch = {
    ...branch,
    status:
      eventBudgetExceeded ||
      decisionsUsed >= maxDecisions ||
      nextModelCallCount >= modelCallLimit
        ? "paused"
        : parseWorldTick(nextSortKey) >= end
          ? "completed"
          : "paused",
    state: nextState,
    ledger,
    checkpoints: [...branch.checkpoints, checkpoint],
    observations: [],
    decisionCount: decisionsUsed,
    modelCallCount: nextModelCallCount,
    warnings: [
      ...branch.warnings,
      ...arbitrationWarnings,
      ...(run.scenario.intelligence.mode === "assisted" &&
      externalCandidates.length === 0 &&
      !branch.warnings.includes(
        "本步未注入模型候选，主体行动使用确定性降级策略。",
      )
        ? ["本步未注入模型候选，主体行动使用确定性降级策略。"]
        : []),
      ...(eventBudgetExceeded
        ? [`已达到事件预算（${maxEvents}），推演已暂停并保存检查点。`]
        : []),
      ...(decisionsUsed >= maxDecisions
        ? [`已达到主体决策预算（${maxDecisions}），推演已暂停并保存检查点。`]
        : []),
      ...(run.scenario.intelligence.mode === "assisted" &&
      nextModelCallCount >= modelCallLimit
        ? [`已达到模型调用预算（${modelCallLimit}），推演已暂停并保存检查点。`]
        : []),
    ],
  };
  return {
    ...nextBranch,
    observations: aggregateObservations(run, nextBranch, ledger),
  };
}

export function advanceWorldSimulation(
  run: WorldSimulationRun,
  options: {
    readonly steps?: number;
    readonly toEnd?: boolean;
    /**
     * 本次推进实际向模型场景发出的请求数。它独立于候选是否有效，
     * 因此解析失败、复核失败或被内核拒绝的请求也会消耗预算。
     */
    readonly modelCallsUsed?: number;
    /** @deprecated 使用 modelCandidates；保留给现有内核调用方。 */
    readonly modelCandidate?: ModelDecisionCandidate;
    readonly modelCandidates?: readonly ModelDecisionSubmission[];
  } = {},
): WorldSimulationRun {
  let branch = getActiveSimulationBranch(run);
  if (branch.status === "cancelled" || branch.status === "completed")
    return run;
  const externalCandidates =
    options.modelCandidates ??
    (options.modelCandidate
      ? [{ subject: null, candidate: options.modelCandidate }]
      : []);
  const modelCallsUsed = options.modelCallsUsed ?? externalCandidates.length;
  const requestedSteps = options.toEnd
    ? run.scenario.maxSteps
    : Math.max(1, options.steps ?? 1);
  for (let index = 0; index < requestedSteps; index += 1) {
    branch = advanceSingleStep(
      run,
      { ...branch, status: "running" },
      index === 0 ? externalCandidates : [],
      index === 0 ? modelCallsUsed : 0,
    );
    if (branch.status === "completed") break;
  }
  return {
    ...run,
    branches: run.branches.map((item) =>
      item.id === branch.id ? branch : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function setSimulationBranchStatus(
  run: WorldSimulationRun,
  status: Extract<SimulationBranch["status"], "paused" | "cancelled">,
): WorldSimulationRun {
  return {
    ...run,
    branches: run.branches.map((branch) =>
      branch.id === run.activeBranchId ? { ...branch, status } : branch,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function forkSimulationBranch(
  run: WorldSimulationRun,
  eventId: string,
  name = "假设分支",
  guardrails: readonly string[] = [],
  authorLeads: readonly string[] = [],
): WorldSimulationRun {
  const source = getActiveSimulationBranch(run);
  const eventIndex = source.ledger.findIndex((entry) => entry.id === eventId);
  if (eventIndex < 0) throw new Error("无法从不存在的事件创建分支");
  assertBranchBudget(run);
  const ledger = source.ledger.slice(0, eventIndex + 1);
  const state = replaySimulationLedger(run.baseline, run.scenario, ledger);
  const id = `branch-${Date.now().toString(36)}-${source.id.replace(/^branch-/u, "")}`;
  const branch: SimulationBranch = {
    id,
    name,
    parentBranchId: source.id,
    forkEventId: eventId,
    narrativePolicy: source.narrativePolicy,
    guardrails: [
      ...(source.guardrails ?? []),
      ...guardrails.map((item) => item.trim()).filter(Boolean),
    ],
    authorLeads: [
      ...(source.authorLeads ?? []),
      ...authorLeads.map((item) => item.trim()).filter(Boolean),
    ],
    seed: `${source.seed}:${eventId}`,
    status: "paused",
    state,
    ledger,
    observations: [],
    checkpoints: [
      {
        id: `checkpoint-${id}-origin`,
        label: `从${source.ledger[eventIndex]!.title}分歧`,
        eventSequence: ledger.length,
        createdAt: new Date().toISOString(),
        state,
      },
    ],
    warnings: [],
  };
  const replayedBranch = {
    ...branch,
    observations: aggregateObservations(run, branch, ledger),
  };
  return {
    ...run,
    activeBranchId: replayedBranch.id,
    branches: [...run.branches, replayedBranch],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 从当前事件建立一个带作者软护栏的候选分支。
 * 护栏只写入新分支的运行快照，原分支和已完成轮次保持不变。
 */
export function forkSimulationBranchWithGuardrail(
  run: WorldSimulationRun,
  eventId: string,
  guardrail: string,
): WorldSimulationRun {
  const value = guardrail.trim();
  if (!value) throw new Error("护栏内容不能为空");
  return forkSimulationBranch(
    run,
    eventId,
    `护栏分支 · ${value.slice(0, 18)}`,
    [value],
  );
}

/**
 * 作者线索是未来可能性，不是已发生事实。它只进入新分支的候选层输入，
 * 不能自动写成事件、人物知识或规则命中。
 */
export function forkSimulationBranchWithLead(
  run: WorldSimulationRun,
  eventId: string,
  lead: string,
): WorldSimulationRun {
  const value = lead.trim();
  if (!value) throw new Error("线索内容不能为空");
  return forkSimulationBranch(
    run,
    eventId,
    `线索分支 · ${value.slice(0, 18)}`,
    [],
    [value],
  );
}

export function switchSimulationBranch(
  run: WorldSimulationRun,
  branchId: string,
): WorldSimulationRun {
  if (!run.branches.some((branch) => branch.id === branchId))
    throw new Error("目标推演分支不存在");
  return {
    ...run,
    activeBranchId: branchId,
    updatedAt: new Date().toISOString(),
  };
}

function assertBranchBudget(run: WorldSimulationRun): void {
  const maxBranches = run.scenario.maxBranches ?? 8;
  if (run.branches.length >= maxBranches) {
    throw new Error(`已达到分支预算（${maxBranches}），无法创建新的推演分支`);
  }
}

export interface SimulationBranchComparison {
  readonly leftBranchId: string;
  readonly rightBranchId: string;
  readonly firstDivergence: {
    readonly leftEventId: string | null;
    readonly rightEventId: string | null;
    readonly summary: string;
  } | null;
  readonly stateDifferences: readonly string[];
  readonly narrativeDifference: string;
}

function branchComparisonKey(
  event: SimulationEvent | undefined,
): string | null {
  return event
    ? JSON.stringify({
        kind: event.kind,
        title: event.title,
        commands: event.commands,
      })
    : null;
}

export function compareSimulationBranches(
  run: WorldSimulationRun,
  leftBranchId: string,
  rightBranchId: string,
): SimulationBranchComparison {
  const left = run.branches.find((branch) => branch.id === leftBranchId);
  const right = run.branches.find((branch) => branch.id === rightBranchId);
  if (!left || !right) throw new Error("无法比较不存在的推演分支");
  const limit = Math.max(left.ledger.length, right.ledger.length);
  let firstDivergence: SimulationBranchComparison["firstDivergence"] = null;
  for (let index = 0; index < limit; index += 1) {
    const leftEvent = left.ledger[index];
    const rightEvent = right.ledger[index];
    if (branchComparisonKey(leftEvent) !== branchComparisonKey(rightEvent)) {
      firstDivergence = {
        leftEventId: leftEvent?.id ?? null,
        rightEventId: rightEvent?.id ?? null,
        summary:
          leftEvent && rightEvent
            ? `第 ${index + 1} 个事件开始分歧：${leftEvent.title} / ${rightEvent.title}`
            : `第 ${index + 1} 个事件开始，仅有${leftEvent ? left.name : right.name}继续演化。`,
      };
      break;
    }
  }
  const stateDifferences = [
    ...left.state.characters.flatMap((item) => {
      const counterpart = right.state.characters.find(
        (candidate) => candidate.id === item.id,
      );
      return counterpart &&
        (item.alive !== counterpart.alive ||
          item.status !== counterpart.status ||
          item.locationId !== counterpart.locationId ||
          item.levelId !== counterpart.levelId)
        ? [`人物 ${item.id}：${item.status} / ${counterpart.status}`]
        : [];
    }),
    ...left.state.factions.flatMap((item) => {
      const counterpart = right.state.factions.find(
        (candidate) => candidate.id === item.id,
      );
      return counterpart &&
        (item.strategy !== counterpart.strategy ||
          item.lifecycle !== counterpart.lifecycle ||
          item.military !== counterpart.military)
        ? [`势力 ${item.id}：${item.strategy} / ${counterpart.strategy}`]
        : [];
    }),
    ...left.state.regions.flatMap((item) => {
      const counterpart = right.state.regions.find(
        (candidate) => candidate.id === item.id,
      );
      return counterpart &&
        (item.pressure !== counterpart.pressure ||
          item.stability !== counterpart.stability ||
          item.cultivation !== counterpart.cultivation)
        ? [
            `地域 ${item.id}：压力 ${Math.round(item.pressure)} / ${Math.round(counterpart.pressure)}`,
          ]
        : [];
    }),
  ].slice(0, 12);
  const leftNarrativeHits = left.ledger.reduce(
    (total, event) => total + event.narrativeConstraintIds.length,
    0,
  );
  const rightNarrativeHits = right.ledger.reduce(
    (total, event) => total + event.narrativeConstraintIds.length,
    0,
  );
  return {
    leftBranchId,
    rightBranchId,
    firstDivergence,
    stateDifferences,
    narrativeDifference: `${left.name}命中 ${leftNarrativeHits} 次剧情约束；${right.name}命中 ${rightNarrativeHits} 次剧情约束。`,
  };
}

export function createNaturalEvolutionComparisonBranch(
  run: WorldSimulationRun,
): WorldSimulationRun {
  const existing = run.branches.find(
    (branch) =>
      branch.narrativePolicy === "disabled" &&
      branch.parentBranchId === "branch-main",
  );
  if (existing) return switchSimulationBranch(run, existing.id);
  assertBranchBudget(run);
  const source =
    run.branches.find((branch) => branch.id === "branch-main") ??
    getActiveSimulationBranch(run);
  const origin =
    source.checkpoints.find((checkpoint) => checkpoint.eventSequence === 0) ??
    source.checkpoints[0];
  if (!origin) throw new Error("主推演分支缺少可重放的事实基线检查点");
  const id = `branch-natural-${Date.now().toString(36)}`;
  const branch: SimulationBranch = {
    id,
    name: "自然演化对照",
    parentBranchId: source.id,
    forkEventId: null,
    narrativePolicy: "disabled",
    guardrails: [],
    seed: source.seed,
    status: "paused",
    state: origin.state,
    ledger: [],
    observations: [],
    checkpoints: [
      {
        ...origin,
        id: `checkpoint-${id}-origin`,
        label: "事实基线 · 无剧情约束",
      },
    ],
    warnings: ["本分支关闭剧情工程，仅保留事实、世界规则与主体约束。"],
  };
  return {
    ...run,
    activeBranchId: id,
    branches: [...run.branches, branch],
    updatedAt: new Date().toISOString(),
  };
}

function negateCommand(command: WorldDomainCommand): WorldDomainCommand | null {
  if (command.type === "faction.metric" || command.type === "region.metric")
    return { ...command, delta: -command.delta / 2 };
  if (command.type === "faction.strategy")
    return { ...command, strategy: `暂缓：${command.strategy}` };
  if (command.type === "character.intent")
    return {
      ...command,
      intent: `重新评估：${command.intent}`,
      status: "观望",
    };
  return null;
}

function validateCouncilOptionCommands(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  participantIds: ReadonlySet<string>,
  commands: readonly WorldDomainCommand[],
  knownRegionIds: readonly string[] = [],
): void {
  const characterIds = new Set(
    run.baseline.characters
      .filter((character) => participantIds.has(character.id))
      .map((character) => character.id),
  );
  const factionIds = new Set(
    run.baseline.factions
      .filter((faction) => participantIds.has(faction.id))
      .map((faction) => faction.id),
  );
  const regionIds = selectedRegionIds(run.baseline, run.scenario);
  knownRegionIds.forEach((id) => regionIds.add(id));
  const itemIds = visibleItemIds(run, characterIds, factionIds);
  const knowledgeByCharacter = new Map(
    run.baseline.characters
      .filter((character) => characterIds.has(character.id))
      .map((character) => [
        character.id,
        new Set(
          visibleKnowledgeForCharacter(run, branch, character.id).map(
            (knowledge) => knowledge.id,
          ),
        ),
      ]),
  );
  commands.forEach((command) => {
    if (
      command.type === "character.arrive" ||
      command.type === "effect.schedule" ||
      command.type === "effect.consume" ||
      command.type === "world.emergent"
    ) {
      throw new Error("会商方案不得直接提交旅行、空间传播或新生主体内部命令");
    }
    if (
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
        command.type === "character.resource" ||
        command.type === "character.relation" ||
        command.type === "character.life" ||
        command.type === "character.knowledge") &&
      !characterIds.has(command.characterId)
    ) {
      throw new Error("会商方案试图操作非参与人物");
    }
    if (
      command.type === "character.knowledge" &&
      !knowledgeByCharacter.get(command.characterId)?.has(command.knowledgeId)
    ) {
      throw new Error("会商方案试图使用人物未知知识");
    }
    if (
      command.type === "character.relation" &&
      !characterIds.has(command.targetCharacterId)
    ) {
      throw new Error("会商方案试图操作非参与人物关系目标");
    }
    if (
      (command.type === "faction.strategy" ||
        command.type === "faction.metric" ||
        command.type === "faction.relation") &&
      !factionIds.has(command.factionId)
    ) {
      throw new Error("会商方案试图操作非参与势力");
    }
    if (
      command.type === "faction.relation" &&
      !factionIds.has(command.targetFactionId)
    ) {
      throw new Error("会商方案试图操作非参与势力关系目标");
    }
    if (
      (command.type === "region.metric" || command.type === "region.control") &&
      !regionIds.has(command.regionId)
    ) {
      throw new Error("会商方案试图操作范围外地域");
    }
    if (command.type === "character.move") {
      assertCharacterMoveHasSpatialPath(
        run,
        branch,
        command,
        regionIds,
        branch.state.currentTime.sortKey,
        "会商方案",
      );
    }
    if (
      command.type === "region.control" &&
      command.factionIds.some((id) => !factionIds.has(id))
    ) {
      throw new Error("会商方案试图把地域交给非参与势力");
    }
    if (command.type === "item.transfer") {
      validateItemTransferCommand(
        run,
        command,
        {
          itemIds,
          characterIds,
          factionIds,
          regionIds,
        },
        "会商方案",
      );
    }
  });
  applyWorldDomainCommands(branch.state, commands);
  validateCommandsAgainstWorld(
    run,
    branch,
    commands,
    branch.state.currentTime.sortKey,
    "会商方案",
  );
}

export function createCouncilSession(
  run: WorldSimulationRun,
  eventId: string | null,
  question: string,
  candidate?: CouncilModelCandidate,
  degradedReason: string | null = null,
): WorldSimulationRun {
  const branch = getActiveSimulationBranch(run);
  const target = eventId
    ? branch.ledger.find((entry) => entry.id === eventId)
    : branch.ledger.at(-1);
  const participantIds = [
    ...new Set(
      target
        ? [...target.characterIds, ...target.factionIds]
        : [
            ...activeCharacters(run, branch).map((character) => character.id),
            ...activeFactions(run, branch).map((faction) => faction.id),
          ],
    ),
  ];
  const characterStances: CouncilStance[] = run.baseline.characters
    .filter((character) => participantIds.includes(character.id))
    .map((character) => ({
      participantType: "character",
      participantId: character.id,
      knownFactIds: visibleKnowledgeForCharacter(run, branch, character.id).map(
        (knowledge) => knowledge.id,
      ),
      goal: character.goals[0] ?? character.motivation[0] ?? "保护自身利益",
      position: `基于${character.name}掌握的信息，优先维护“${character.goals[0] ?? "既有目标"}”。`,
      risks: [...character.fears, ...character.weaknesses].slice(0, 3),
      optionIds: ["option-support", "option-delay"],
    }));
  const factionStances: CouncilStance[] = run.baseline.factions
    .filter((faction) => participantIds.includes(faction.id))
    .map((faction) => ({
      participantType: "faction",
      participantId: faction.id,
      knownFactIds: [],
      goal: faction.goals[0] ?? "维持组织存续",
      position: `${faction.name}会按资源、关系和领土状态评估成本，不共享作者全知信息。`,
      risks: faction.resources
        .filter((resource) => resource.controlLevel === "contested")
        .map((resource) => `${resource.name}仍在争夺中`)
        .slice(0, 3),
      optionIds: ["option-support", "option-redirect"],
    }));
  // 会商锚点事件已经包含在 retainedLedger 中。只保留“下一步意图”类命令，
  // 避免重复执行原事件的数值、移动、排程和物品归属变化。
  const actionCommandSource = target?.commands.some(
    (command) =>
      command.type === "character.intent" ||
      command.type === "faction.strategy",
  )
    ? target
    : branch.ledger
        .slice()
        .reverse()
        .find((event) =>
          event.commands.some(
            (command) =>
              command.type === "character.intent" ||
              command.type === "faction.strategy",
          ),
        );
  const baseCommands: readonly WorldDomainCommand[] = (
    actionCommandSource?.commands ?? []
  ).filter(
    (command) =>
      command.type === "character.intent" ||
      command.type === "faction.strategy",
  );
  const options: CouncilOption[] = [
    {
      id: "option-support",
      title: target ? `推进：${target.title}` : "维持既定行动",
      summary: "按当前因果链继续推进，保留原有成本与收益。",
      score: 72,
      costs: ["承担既定资源消耗"],
      benefits: ["延续当前战略主动权"],
      commands: baseCommands,
    },
    {
      id: "option-delay",
      title: "延迟行动，换取更多信息",
      summary: "降低短期风险，但可能让对手完成部署。",
      score: 58,
      costs: ["失去部分时机"],
      benefits: ["提高情报完整度"],
      commands: baseCommands.flatMap((command) => negateCommand(command) ?? []),
    },
    {
      id: "option-redirect",
      title: "改变路径，转向间接博弈",
      summary: "不正面执行原方案，改以外交、资源或代理人施压。",
      score: 46,
      costs: ["结果更不确定"],
      benefits: ["减少直接冲突"],
      commands: baseCommands
        .filter(
          (command) =>
            command.type === "faction.metric" ||
            command.type === "region.metric",
        )
        .map((command) => ({ ...command, delta: command.delta / 3 })),
    },
  ].filter((option) => option.commands.length > 0);
  const allowedCharacters = new Map(
    run.baseline.characters
      .filter((character) => participantIds.includes(character.id))
      .map((character) => [
        character.id,
        new Set(
          visibleKnowledgeForCharacter(run, branch, character.id).map(
            (knowledge) => knowledge.id,
          ),
        ),
      ]),
  );
  const allowedFactions = new Set(
    run.baseline.factions
      .filter((faction) => participantIds.includes(faction.id))
      .map((faction) => faction.id),
  );
  let resolvedStances = [...characterStances, ...factionStances];
  let resolvedOptions = options;
  if (candidate) {
    const optionIds = new Set<string>();
    resolvedOptions = candidate.options.map((option) => {
      if (!option.id || optionIds.has(option.id))
        throw new Error("会商模型返回了重复或为空的方案 id");
      optionIds.add(option.id);
      if (option.commands.length === 0)
        throw new Error("会商模型返回了没有状态提交的方案");
      validateCouncilOptionCommands(
        run,
        branch,
        new Set(participantIds),
        option.commands,
        target?.regionIds ?? [],
      );
      return { ...option, score: clamp(option.score) };
    });
    if (resolvedOptions.length === 0)
      throw new Error("会商模型没有返回候选方案");
    resolvedStances = candidate.stances.flatMap((stance) => {
      if (stance.participantType === "character") {
        const known = allowedCharacters.get(stance.participantId);
        if (!known) return [];
        return [
          {
            ...stance,
            knownFactIds: stance.knownFactIds.filter((id) => known.has(id)),
            optionIds: stance.optionIds.filter((id) => optionIds.has(id)),
          },
        ];
      }
      if (!allowedFactions.has(stance.participantId)) return [];
      return [
        {
          ...stance,
          knownFactIds: [],
          optionIds: stance.optionIds.filter((id) => optionIds.has(id)),
        },
      ];
    });
    if (resolvedStances.length === 0)
      throw new Error("会商模型没有返回当前局势中的有效参与方");
  }
  const session: CouncilSession = {
    id: `council-${Date.now().toString(36)}`,
    branchId: branch.id,
    eventId: target?.id ?? null,
    question: question.trim() || "各方下一步会如何选择？",
    createdAt: new Date().toISOString(),
    status: "draft",
    generatedBy: candidate ? "model" : "fallback",
    degradedReason: candidate ? null : degradedReason,
    stances: resolvedStances,
    options: resolvedOptions,
    selectedOptionId: null,
  };
  return {
    ...run,
    councilSessions: [...run.councilSessions, session],
    updatedAt: new Date().toISOString(),
  };
}

export function selectCouncilOption(
  run: WorldSimulationRun,
  sessionId: string,
  optionId: string,
): WorldSimulationRun {
  return {
    ...run,
    councilSessions: run.councilSessions.map((session) => {
      if (session.id !== sessionId) return session;
      if (!session.options.some((option) => option.id === optionId))
        throw new Error("会商方案不存在");
      return { ...session, selectedOptionId: optionId, status: "reviewed" };
    }),
    updatedAt: new Date().toISOString(),
  };
}

export function commitCouncilOptionToBranch(
  run: WorldSimulationRun,
  sessionId: string,
  optionId: string,
): WorldSimulationRun {
  const session = run.councilSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error("会商记录不存在");
  const option = session.options.find((item) => item.id === optionId);
  if (!option) throw new Error("会商方案不存在");
  if (option.commands.length === 0)
    throw new Error("会商方案没有可提交的状态变化");
  const source = run.branches.find((branch) => branch.id === session.branchId);
  if (!source) throw new Error("会商所属分支不存在");
  assertBranchBudget(run);
  const targetEventId = session.eventId ?? source.ledger.at(-1)?.id ?? null;
  const retainedLedger = targetEventId
    ? source.ledger.slice(
        0,
        source.ledger.findIndex((event) => event.id === targetEventId) + 1,
      )
    : [];
  if (targetEventId && retainedLedger.length === 0)
    throw new Error("会商锚点事件已不在所属分支中");
  const discussionEvent = targetEventId
    ? (source.ledger.find((event) => event.id === targetEventId) ?? null)
    : null;
  const state = targetEventId
    ? replaySimulationLedger(run.baseline, run.scenario, retainedLedger)
    : (source.checkpoints[0]?.state ?? source.state);
  const id = `branch-council-${Date.now().toString(36)}`;
  const seed = `${source.seed}:council:${session.id}:${option.id}`;
  const branchAtFork: SimulationBranch = {
    id,
    name: `会商干预 · ${option.title}`,
    parentBranchId: source.id,
    forkEventId: targetEventId,
    narrativePolicy: source.narrativePolicy,
    guardrails: source.guardrails ?? [],
    seed,
    status: "paused",
    state,
    ledger: retainedLedger,
    observations: [],
    checkpoints: [
      {
        id: `checkpoint-${id}-origin`,
        label: targetEventId
          ? `会商介入：${targetEventId}`
          : "会商介入：事实基线",
        eventSequence: retainedLedger.length,
        createdAt: new Date().toISOString(),
        state,
      },
    ],
    warnings: [],
  };
  validateCouncilOptionCommands(
    run,
    branchAtFork,
    new Set(session.stances.map((stance) => stance.participantId)),
    option.commands,
    discussionEvent?.regionIds ?? [],
  );
  const intervention = event(
    run,
    branchAtFork,
    state.currentTime.sortKey,
    "day",
    {
      kind: "diplomacy",
      title: `会商干预：${option.title}`,
      summary: option.summary,
      characterIds: [],
      factionIds: [],
      regionIds: [],
      itemIds: [],
      evidence: [
        {
          type: "knowledge",
          label: "立场会商",
          detail: `作者选择方案“${option.title}”，作为该分支的初始干预。`,
          authority: "simulated",
          sourceRefs: [],
        },
      ],
      commands: option.commands,
      narrativeConstraintIds: [],
      generatedBy: "kernel",
      confidence: 1,
    },
  );
  const strictViolation = strictNarrativeViolation(run, branchAtFork, [
    intervention,
  ]);
  if (strictViolation) throw new Error(strictViolation);
  const nextState = applyWorldDomainCommands(state, option.commands);
  const ledger = [...retainedLedger, intervention].map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
  const branch: SimulationBranch = {
    ...branchAtFork,
    state: nextState,
    ledger,
    checkpoints: [
      ...branchAtFork.checkpoints,
      {
        id: `checkpoint-${id}-intervention`,
        label: option.title,
        eventSequence: ledger.length,
        createdAt: new Date().toISOString(),
        state: nextState,
      },
    ],
    observations: aggregateObservations(run, branchAtFork, ledger),
  };
  return {
    ...run,
    activeBranchId: branch.id,
    branches: [...run.branches, branch],
    councilSessions: run.councilSessions.map((item) =>
      item.id === sessionId
        ? { ...item, selectedOptionId: optionId, status: "committed" }
        : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function listSimulationDecisionSubjects(
  run: WorldSimulationRun,
): readonly SimulationDecisionSubject[] {
  const branch = getActiveSimulationBranch(run);
  return [
    ...activeCharacters(run, branch).map((character) => ({
      type: "character" as const,
      id: character.id,
    })),
    ...activeFactions(run, branch).map((faction) => ({
      type: "faction" as const,
      id: faction.id,
    })),
  ].sort(
    (left, right) =>
      left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
  );
}

function visibleTimelineFactsForSubject(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  subject: SimulationDecisionSubject | null,
) {
  if (!subject) return [];
  const characterIds =
    subject.type === "character"
      ? [subject.id]
      : (run.baseline.factions.find((faction) => faction.id === subject.id)
          ?.memberCharacterIds ?? []);
  const knownFactIds = new Set(
    characterIds.flatMap((characterId) => {
      const character = run.baseline.characters.find(
        (candidate) => candidate.id === characterId,
      );
      const runtime = branch.state.characters.find(
        (candidate) => candidate.id === characterId,
      );
      if (!character || !runtime) return [];
      const activeKnowledgeIds = rememberedKnowledgeIds(
        runtime,
        branch.state.currentTime.sortKey,
      );
      return character.knowledge.flatMap((knowledge) =>
        activeKnowledgeIds.has(knowledge.id) && knowledge.sourceEventId
          ? [knowledge.sourceEventId]
          : [],
      );
    }),
  );
  return baselineFacts(run.baseline, run.scenario).filter((fact) =>
    knownFactIds.has(fact.id),
  );
}

export function buildDecisionPrompt(
  run: WorldSimulationRun,
  requestedSubject?: SimulationDecisionSubject,
): string {
  const branch = getActiveSimulationBranch(run);
  const subjects = listSimulationDecisionSubjects(run);
  const subject = requestedSubject ?? subjects[0] ?? null;
  if (
    requestedSubject &&
    !subjects.some(
      (candidate) =>
        candidate.type === requestedSubject.type &&
        candidate.id === requestedSubject.id,
    )
  ) {
    throw new Error("模型决策主体当前不可行动");
  }
  const character =
    subject?.type === "character"
      ? run.baseline.characters.find((item) => item.id === subject.id)
      : undefined;
  const faction =
    subject?.type === "faction"
      ? run.baseline.factions.find((item) => item.id === subject.id)
      : undefined;
  const characterRuntime = character
    ? branch.state.characters.find((item) => item.id === character.id)
    : undefined;
  const factionRuntime = faction
    ? branch.state.factions.find((item) => item.id === faction.id)
    : undefined;
  const visibleTimelineFacts = visibleTimelineFactsForSubject(
    run,
    branch,
    subject,
  );
  const visibleTimelineFactIds = new Set(
    visibleTimelineFacts.map((fact) => fact.id),
  );
  const activeChapterFactIds = new Set(
    activeChapterFacts(run.baseline, run.scenario).map((fact) => fact.id),
  );
  const observationFactIds = observedChapterFacts(
    run.baseline,
    run.scenario,
  ).map((fact) => fact.id);
  const chapter = run.scenario.chapterContext.chapterId
    ? run.baseline.chapters.find(
        (item) => item.id === run.scenario.chapterContext.chapterId,
      )
    : undefined;
  const chapterContext =
    chapter && run.scenario.chapterContext.mode !== "none"
      ? {
          mode: run.scenario.chapterContext.mode,
          title: chapter.title,
          // 正文只通过已应用且逐字证据仍有效的章节事实，或正式时间线事件
          // 进入决策输入。整段章节文本可能包含梦境、传闻或角色误判，不能
          // 被模型自行提升为世界事实。
          confirmedFactIds: baselineFacts(run.baseline, run.scenario)
            .filter(
              (event) =>
                (event.chapterIds.includes(chapter.id) ||
                  activeChapterFactIds.has(event.id)) &&
                visibleTimelineFactIds.has(event.id),
            )
            .map((event) => event.id),
          observationFactIds,
        }
      : null;
  const usesNarrativePlans =
    run.scenario.narrativeContext.mode !== "off" &&
    (run.scenario.narrativeContext.usePlotLines ||
      run.scenario.narrativeContext.useStoryArcs ||
      run.scenario.narrativeContext.useDirectoryOutline ||
      run.scenario.narrativeContext.useChapterPlans);
  const visibleCharacterKnowledge = character
    ? visibleKnowledgeForCharacter(run, branch, character.id)
    : [];
  const visibleMemory = characterRuntime
    ? memoryEntriesForRuntime(
        characterRuntime,
        branch.state.currentTime.sortKey,
      )
    : [];
  const perspective = character
    ? {
        type: "character",
        id: character.id,
        name: character.name,
        goals: character.goals,
        locationId: character.locationId,
        knowledge: visibleCharacterKnowledge.map((knowledge) => ({
          id: knowledge.id,
          statement: knowledge.statement,
          authority: knowledge.authority,
        })),
        memory: visibleMemory.map((entry) => ({
          knowledgeId: entry.knowledgeId,
          strength: entry.strength,
          lastRecalledSortKey: entry.lastRecalledSortKey,
        })),
        relations: characterRuntime?.relations ?? [],
        resources: {
          items: character.inventoryItemIds,
          balances: characterRuntime?.resourceBalances ?? {},
        },
      }
    : faction
      ? {
          type: "faction",
          id: faction.id,
          name: faction.name,
          goals: faction.goals,
          resources: faction.resources,
          relations: faction.relations.map((relation) => ({
            ...relation,
            runtime:
              factionRuntime?.relations?.find(
                (candidate) =>
                  candidate.targetFactionId === relation.targetFactionId,
              ) ?? null,
          })),
          knownFacts: visibleTimelineFacts.map((fact) => ({
            id: fact.id,
            title: fact.title,
            summary: fact.summary,
          })),
        }
      : null;
  return `你是小说世界推演的单一主体智能候选层。当前输入只包含一个主体的视角，绝不能猜测其它人物或势力的私有知识；只能提出一个候选事件，不能直接改写事实。候选必须关联当前主体；人物只能提交自己的角色命令，势力只能提交自己的势力命令。\n\n当前时间：${branch.state.currentTime.displayText}\n作者目标：${run.scenario.objective}\n作者硬约束（必须逐条遵守，不能把未来计划当作事实）：${JSON.stringify(activeAuthorConstraints(run, branch))}\n作者投递线索（只表示希望未来可能出现的倾向，不是当前事实、人物知识或必然结果；只有满足已有事实和规则时才可采用）：${JSON.stringify(activeAuthorLeads(branch))}\n章节上下文（仅在配置启用时提供）：${JSON.stringify(chapterContext)}\n当前主体：${JSON.stringify(perspective)}\n可见地域：${JSON.stringify(
    run.baseline.regions
      .filter((region) =>
        selectedRegionIds(run.baseline, run.scenario).has(region.id),
      )
      .slice(0, 8)
      .map((region) => ({
        id: region.id,
        name: region.name,
        connections: region.connections
          .filter(isTravelConnection)
          .map((connection) => nextReachableRegionId(connection, region.id))
          .filter((value): value is string => Boolean(value)),
      })),
  )}\n已发生事实（仅限当前主体已知事实）：${JSON.stringify(visibleTimelineFacts.slice(-12).map((item) => ({ id: item.id, time: item.time.displayText, title: item.title, summary: item.summary })))}\n作者未来计划（仅在剧情工程启用时作为计划或约束；绝不能当作已发生）：${JSON.stringify(usesNarrativePlans ? run.baseline.timelinePlans.slice(0, 12).map((item) => ({ id: item.id, time: item.time.displayText, title: item.title, summary: item.summary })) : [])}\n硬规则：${JSON.stringify(run.baseline.rules.slice(0, 8).map((rule) => ({ id: rule.id, title: rule.title, description: rule.description })))}\n剧情约束：${JSON.stringify(activeNarrativeConstraints(run, branch).map((constraint) => ({ id: constraint.id, mode: constraint.mode, title: constraint.title, content: constraint.content, timeWindow: constraint.timeWindow ?? null, requiredOutcomes: constraint.requiredOutcomes ?? [], forbiddenOutcomes: constraint.forbiddenOutcomes ?? [], flexibility: constraint.flexibility ?? 50 })))}\n\n只输出 JSON：{"title":string,"summary":string,"kind":"character-action|faction-strategy|conflict|diplomacy|cultivation|lifecycle|propagation|world-process|epoch","characterIds":string[],"factionIds":string[],"regionIds":string[],"itemIds":string[],"commands":WorldDomainCommand[],"confidence":0..1,"objective":string,"perceivedFacts":string[],"assumptions":string[],"expectedUtility":0..100,"risks":string[]}`;
}

export function buildDecisionPrompts(run: WorldSimulationRun): readonly {
  readonly subject: SimulationDecisionSubject;
  readonly prompt: string;
}[] {
  return listSimulationDecisionSubjects(run).map((subject) => ({
    subject,
    prompt: buildDecisionPrompt(run, subject),
  }));
}

export function parseModelDecisionCandidate(
  output: string,
): ModelDecisionCandidate {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? output;
  let value: unknown;
  try {
    value = JSON.parse(fenced.trim());
  } catch (cause) {
    throw new Error(
      `模型候选不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("模型候选根节点必须是对象");
  const candidate = value as Partial<ModelDecisionCandidate>;
  const allowedKinds: readonly SimulationEventKind[] = [
    "character-action",
    "faction-strategy",
    "conflict",
    "diplomacy",
    "cultivation",
    "lifecycle",
    "propagation",
    "world-process",
    "epoch",
  ];
  const isStringList = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string" ||
    !allowedKinds.includes(candidate.kind as SimulationEventKind) ||
    !Array.isArray(candidate.characterIds) ||
    !Array.isArray(candidate.factionIds) ||
    !Array.isArray(candidate.regionIds) ||
    !Array.isArray(candidate.itemIds) ||
    !Array.isArray(candidate.commands) ||
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    (candidate.objective !== undefined &&
      typeof candidate.objective !== "string") ||
    (candidate.perceivedFacts !== undefined &&
      !isStringList(candidate.perceivedFacts)) ||
    (candidate.assumptions !== undefined &&
      !isStringList(candidate.assumptions)) ||
    (candidate.expectedUtility !== undefined &&
      (!Number.isFinite(candidate.expectedUtility) ||
        candidate.expectedUtility < 0 ||
        candidate.expectedUtility > 100)) ||
    (candidate.risks !== undefined && !isStringList(candidate.risks))
  ) {
    throw new Error("模型候选缺少必要字段");
  }
  return candidate as ModelDecisionCandidate;
}

export function buildResolutionPrompt(
  run: WorldSimulationRun,
  candidate: ModelDecisionCandidate,
): string {
  const branch = getActiveSimulationBranch(run);
  return `你是小说世界推演的候选复核层。检查候选是否违反实体存在性、人物知识边界、空间距离、资源成本、寿命、修炼前置、世界硬规则和剧情硬护栏。不得直接写入世界状态；需要修正时返回修正后的同结构候选。\n\n当前时间：${branch.state.currentTime.displayText}\n作者硬约束：${JSON.stringify(activeAuthorConstraints(run, branch))}\n作者投递线索（只可作为候选的软倾向，不能补充事实、绕过规则或视为人物已知信息）：${JSON.stringify(activeAuthorLeads(branch))}\n候选：${JSON.stringify(candidate)}\n硬规则：${JSON.stringify(run.baseline.rules.filter((rule) => rule.severity === "hard").map((rule) => ({ id: rule.id, title: rule.title, description: rule.description })))}\n剧情硬护栏：${JSON.stringify(
    activeNarrativeConstraints(run, branch)
      .filter((constraint) => constraint.mode === "strict")
      .map((constraint) => ({
        id: constraint.id,
        title: constraint.title,
        content: constraint.content,
        timeWindow: constraint.timeWindow ?? null,
        requiredOutcomes: constraint.requiredOutcomes ?? [],
        forbiddenOutcomes: constraint.forbiddenOutcomes ?? [],
        flexibility: constraint.flexibility ?? 50,
      })),
  )}\n当前状态：${JSON.stringify(branch.state)}\n\n只输出与输入相同结构的 JSON 候选；无法成立时把 commands 置空，并在 summary 中说明拒绝原因。`;
}

export function buildCouncilPrompt(
  run: WorldSimulationRun,
  eventId: string | null,
  question: string,
): string {
  const branch = getActiveSimulationBranch(run);
  const target = eventId
    ? branch.ledger.find((entry) => entry.id === eventId)
    : branch.ledger.at(-1);
  const participantIds = new Set(
    target
      ? [...target.characterIds, ...target.factionIds]
      : [
          ...activeCharacters(run, branch).map((character) => character.id),
          ...activeFactions(run, branch).map((faction) => faction.id),
        ],
  );
  const characters = run.baseline.characters
    .filter((character) => participantIds.has(character.id))
    .map((character) => ({
      participantType: "character",
      participantId: character.id,
      name: character.name,
      goals: character.goals,
      risks: [...character.fears, ...character.weaknesses],
      knowledge: visibleKnowledgeForCharacter(run, branch, character.id).map(
        (knowledge) => ({
          id: knowledge.id,
          statement: knowledge.statement,
          authority: knowledge.authority,
        }),
      ),
      resources: {
        cultivation: character.cultivation,
        items: character.inventoryItemIds,
      },
    }));
  const factions = run.baseline.factions
    .filter((faction) => participantIds.has(faction.id))
    .map((faction) => ({
      participantType: "faction",
      participantId: faction.id,
      name: faction.name,
      goals: faction.goals,
      resources: faction.resources,
      relations: faction.relations,
      state: faction.stateText,
    }));
  return `你主持一次小说世界局势会商。每方只能依据自己的知识、目标、资源、关系和风险发言，不得共享作者秘密或其它人物私有知识。会商只提出候选，不修改世界。\n\n问题：${question.trim() || "各方下一步会如何选择？"}\n局势事件：${JSON.stringify(target ?? null)}\n人物席位：${JSON.stringify(characters)}\n势力席位：${JSON.stringify(factions)}\n世界硬规则：${JSON.stringify(run.baseline.rules.filter((rule) => rule.severity === "hard"))}\n\n只输出 JSON：{"stances":[{"participantType":"character|faction","participantId":string,"knownFactIds":string[],"goal":string,"position":string,"risks":string[],"optionIds":string[]}],"options":[{"id":string,"title":string,"summary":string,"score":0..100,"costs":string[],"benefits":string[],"commands":WorldDomainCommand[]}]}`;
}

export interface CouncilParticipantPrompt {
  readonly participantType: "character" | "faction";
  readonly participantId: string;
  readonly prompt: string;
}

export function buildCouncilParticipantPrompts(
  run: WorldSimulationRun,
  eventId: string | null,
  question: string,
): readonly CouncilParticipantPrompt[] {
  const branch = getActiveSimulationBranch(run);
  const target = eventId
    ? branch.ledger.find((entry) => entry.id === eventId)
    : branch.ledger.at(-1);
  const participantIds = new Set(
    target
      ? [...target.characterIds, ...target.factionIds]
      : [
          ...activeCharacters(run, branch).map((character) => character.id),
          ...activeFactions(run, branch).map((faction) => faction.id),
        ],
  );
  const publicSituation = target
    ? {
        id: target.id,
        time: target.time,
        title: target.title,
        summary: target.summary,
        kind: target.kind,
        regionIds: target.regionIds,
      }
    : { time: branch.state.currentTime, summary: "当前世界状态" };
  const hardRules = run.baseline.rules
    .filter((rule) => rule.severity === "hard")
    .map((rule) => ({
      id: rule.id,
      title: rule.title,
      description: rule.description,
    }));
  const prompts: CouncilParticipantPrompt[] = [];
  run.baseline.characters
    .filter((character) => participantIds.has(character.id))
    .forEach((character) => {
      const perspective = {
        participantType: "character",
        participantId: character.id,
        name: character.name,
        goals: character.goals,
        risks: [...character.fears, ...character.weaknesses],
        knowledge: visibleKnowledgeForCharacter(run, branch, character.id),
        memory: memoryEntriesForRuntime(
          branch.state.characters.find(
            (runtime) => runtime.id === character.id,
          ) ?? {
            knowledgeIds: [],
          },
          branch.state.currentTime.sortKey,
        ),
        resources: {
          cultivation: character.cultivation,
          items: character.inventoryItemIds,
        },
      };
      prompts.push({
        participantType: "character",
        participantId: character.id,
        prompt: `你只代表“${character.name}”参加小说世界局势会商。不得根据未提供的信息推断其它人的秘密，也不得替其它参与方发言。会商只给出候选，不修改世界。\n\n问题：${question.trim() || "各方下一步会如何选择？"}\n公开局势：${JSON.stringify(publicSituation)}\n你的视角：${JSON.stringify(perspective)}\n世界硬规则：${JSON.stringify(hardRules)}\n\n只输出 JSON：{"stances":[{"participantType":"character","participantId":"${character.id}","knownFactIds":string[],"goal":string,"position":string,"risks":string[],"optionIds":string[]}],"options":[{"id":string,"title":string,"summary":string,"score":0..100,"costs":string[],"benefits":string[],"commands":WorldDomainCommand[]}]}`,
      });
    });
  run.baseline.factions
    .filter((faction) => participantIds.has(faction.id))
    .forEach((faction) => {
      const perspective = {
        participantType: "faction",
        participantId: faction.id,
        name: faction.name,
        goals: faction.goals,
        resources: faction.resources,
        relations: faction.relations,
        state: faction.stateText,
        knownFacts: visibleTimelineFactsForSubject(run, branch, {
          type: "faction",
          id: faction.id,
        }).map((fact) => ({
          id: fact.id,
          title: fact.title,
          summary: fact.summary,
        })),
      };
      prompts.push({
        participantType: "faction",
        participantId: faction.id,
        prompt: `你只代表“${faction.name}”参加小说世界局势会商。不得根据未提供的信息推断其它人物或势力的秘密，也不得替其它参与方发言。会商只给出候选，不修改世界。\n\n问题：${question.trim() || "各方下一步会如何选择？"}\n公开局势：${JSON.stringify(publicSituation)}\n你的视角：${JSON.stringify(perspective)}\n世界硬规则：${JSON.stringify(hardRules)}\n\n只输出 JSON：{"stances":[{"participantType":"faction","participantId":"${faction.id}","knownFactIds":[],"goal":string,"position":string,"risks":string[],"optionIds":string[]}],"options":[{"id":string,"title":string,"summary":string,"score":0..100,"costs":string[],"benefits":string[],"commands":WorldDomainCommand[]}]}`,
      });
    });
  return prompts;
}

export function parseCouncilModelCandidate(
  output: string,
): CouncilModelCandidate {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? output;
  let value: unknown;
  try {
    value = JSON.parse(fenced.trim());
  } catch (cause) {
    throw new Error(
      `会商结果不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("会商结果根节点必须是对象");
  const candidate = value as Partial<CouncilModelCandidate>;
  if (!Array.isArray(candidate.stances) || !Array.isArray(candidate.options))
    throw new Error("会商结果缺少立场或方案");
  const validStance = candidate.stances.every(
    (stance) =>
      stance &&
      (stance.participantType === "character" ||
        stance.participantType === "faction") &&
      typeof stance.participantId === "string" &&
      typeof stance.goal === "string" &&
      typeof stance.position === "string" &&
      Array.isArray(stance.knownFactIds) &&
      Array.isArray(stance.risks) &&
      Array.isArray(stance.optionIds),
  );
  const validOptions = candidate.options.every(
    (option) =>
      option &&
      typeof option.id === "string" &&
      typeof option.title === "string" &&
      typeof option.summary === "string" &&
      typeof option.score === "number" &&
      Array.isArray(option.costs) &&
      Array.isArray(option.benefits) &&
      Array.isArray(option.commands),
  );
  if (!validStance || !validOptions) throw new Error("会商结果字段格式无效");
  return candidate as CouncilModelCandidate;
}

function mostFrequent(
  values: readonly string[],
  limit: number,
): readonly string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([value]) => value);
}

function deterministicReportSections(
  run: WorldSimulationRun,
  branch: SimulationBranch,
): SimulationReportSection[] {
  const latestEvents = branch.ledger.slice(-8);
  const warnings = [
    ...branch.warnings,
    ...run.baseline.diagnostics
      .filter((item) => item.severity !== "info")
      .map((item) => item.title),
  ];
  const actorIds = mostFrequent(
    branch.ledger.flatMap((entry) => entry.characterIds),
    6,
  );
  const factionIds = mostFrequent(
    branch.ledger.flatMap((entry) => entry.factionIds),
    6,
  );
  const regionIds = mostFrequent(
    branch.ledger.flatMap((entry) => entry.regionIds),
    6,
  );
  const causal = branch.ledger
    .filter((entry) => entry.causeEventIds.length > 0)
    .slice(-8);
  const narrativeEvents = branch.ledger.filter(
    (entry) => entry.narrativeConstraintIds.length > 0,
  );
  const narrativeEvaluations = evaluateNarrativeConstraints(run, branch);
  const sections: SimulationReportSection[] = [
    {
      id: "report-section-world",
      kind: "world-overview",
      title: "世界总览",
      summary:
        branch.ledger.length === 0
          ? "世界仍停留在事实锚点，尚未产生推演事件。"
          : `世界从${run.baseline.anchor.displayText}推进到${branch.state.currentTime.displayText}，形成 ${branch.ledger.length} 个可追溯事件。`,
      findings: latestEvents.map(
        (entry) => `${entry.time.displayText}：${entry.title}`,
      ),
      eventIds: latestEvents.map((entry) => entry.id),
      entityIds: [...actorIds, ...factionIds, ...regionIds],
      severity: "info",
    },
    {
      id: "report-section-scale",
      kind: "multi-scale",
      title: "多尺度观察",
      summary: `${branch.observations.length} 个观察节点来自同一条因果分支，不是互相矛盾的平行结果。`,
      findings: run.scenario.outputScales.map(
        (scale) =>
          `${TIME_SCALE_LABELS_FOR_REPORT[scale]}：${branch.observations.filter((item) => item.scale === scale).length} 个阶段`,
      ),
      eventIds: [
        ...new Set(branch.observations.flatMap((item) => item.eventIds)),
      ],
      entityIds: [
        ...new Set(
          branch.observations.flatMap((item) => item.dominantActorIds),
        ),
      ],
      severity: "info",
    },
    {
      id: "report-section-actors",
      kind: "actors",
      title: "人物命运",
      summary: actorIds.length
        ? `${actorIds.length} 个重点人物持续影响世界变化。`
        : "当前窗口没有人物成为主要驱动力。",
      findings: actorIds.map(
        (id) =>
          `${run.baseline.characters.find((item) => item.id === id)?.name ?? id}：参与 ${branch.ledger.filter((entry) => entry.characterIds.includes(id)).length} 个事件`,
      ),
      eventIds: branch.ledger
        .filter((entry) =>
          entry.characterIds.some((id) => actorIds.includes(id)),
        )
        .map((entry) => entry.id),
      entityIds: actorIds,
      severity: "info",
    },
    {
      id: "report-section-factions",
      kind: "factions",
      title: "势力兴衰",
      summary: factionIds.length
        ? `${factionIds.length} 个势力构成当前博弈主轴。`
        : "当前窗口没有势力成为主要驱动力。",
      findings: factionIds.map((id) => {
        const state = branch.state.factions.find((item) => item.id === id);
        return `${run.baseline.factions.find((item) => item.id === id)?.name ?? id}：${state?.strategy ?? "未形成策略"}，生命周期 ${state?.lifecycle ?? "未知"}`;
      }),
      eventIds: branch.ledger
        .filter((entry) =>
          entry.factionIds.some((id) => factionIds.includes(id)),
        )
        .map((entry) => entry.id),
      entityIds: factionIds,
      severity: "info",
    },
    {
      id: "report-section-regions",
      kind: "regions",
      title: "空间传播",
      summary: `${branch.ledger.filter((entry) => entry.kind === "propagation").length} 次影响沿地域关系传播。`,
      findings: regionIds.map((id) => {
        const state = branch.state.regions.find((item) => item.id === id);
        return `${run.baseline.regions.find((item) => item.id === id)?.name ?? id}：压力 ${Math.round(state?.pressure ?? 0)}，稳定 ${Math.round(state?.stability ?? 0)}`;
      }),
      eventIds: branch.ledger
        .filter((entry) => entry.regionIds.some((id) => regionIds.includes(id)))
        .map((entry) => entry.id),
      entityIds: regionIds,
      severity: branch.state.regions.some((item) => item.pressure >= 80)
        ? "critical"
        : "info",
    },
    {
      id: "report-section-causal",
      kind: "causal",
      title: "关键因果",
      summary: causal.length
        ? `${causal.length} 个近期事件能够追溯到明确前因。`
        : "当前事件仍以独立世界过程为主。",
      findings: causal.map(
        (entry) => `${entry.title} ← ${entry.causeEventIds.join("、")}`,
      ),
      eventIds: causal.map((entry) => entry.id),
      entityIds: [
        ...new Set(
          causal.flatMap((entry) => [
            ...entry.characterIds,
            ...entry.factionIds,
            ...entry.regionIds,
          ]),
        ),
      ],
      severity: "info",
    },
    {
      id: "report-section-narrative",
      kind: "narrative",
      title: "剧情工程对照",
      summary:
        run.scenario.narrativeContext.mode === "off"
          ? "本次运行未使用剧情工程约束。"
          : `${narrativeEvents.length} 个事件受到剧情工程的观察、引导或护栏影响。`,
      findings:
        narrativeEvaluations.length > 0
          ? narrativeEvaluations.map(
              (evaluation) =>
                `${evaluation.constraint.title}：达成度 ${evaluation.score}%；必需结果 ${evaluation.requiredSatisfied}/${evaluation.requiredCount}，禁止结果命中 ${evaluation.forbiddenMatched}/${evaluation.forbiddenCount}`,
            )
          : run.baseline.narrativeConstraints.map(
              (constraint) =>
                `${constraint.title}：${branch.ledger.filter((entry) => entry.narrativeConstraintIds.includes(constraint.id)).length} 次命中`,
            ),
      eventIds: narrativeEvents.map((entry) => entry.id),
      entityIds: [
        ...new Set(
          run.baseline.narrativeConstraints.flatMap(
            (constraint) => constraint.entityIds,
          ),
        ),
      ],
      severity: narrativeEvaluations.some((evaluation) => !evaluation.complete)
        ? "warning"
        : "info",
    },
    {
      id: "report-section-risk",
      kind: "risk",
      title: "风险与降级",
      summary: warnings.length
        ? `${warnings.length} 项资料或模型风险需要作者复核。`
        : "未发现阻断性风险；推演结果仍然只是候选。",
      findings: warnings.length
        ? warnings
        : ["推演结果未写入正式事实", "采纳前仍需检查当前正式资料是否变化"],
      eventIds: branch.ledger
        .filter((entry) => entry.generatedBy === "fallback")
        .map((entry) => entry.id),
      entityIds: [],
      severity: warnings.length ? "warning" : "info",
    },
  ];
  return sections;
}

const TIME_SCALE_LABELS_FOR_REPORT: Readonly<Record<TimeScale, string>> = {
  day: "日",
  "ten-day": "十日",
  month: "月",
  quarter: "季度",
  "three-month": "三月",
  year: "年",
  century: "百年",
  millennium: "千年",
  "ten-thousand-years": "万年",
  "hundred-billion-years": "千亿年",
  "trillion-years": "万亿年",
};

export function buildReportPrompt(run: WorldSimulationRun): string {
  const branch = getActiveSimulationBranch(run);
  const sections = deterministicReportSections(run, branch);
  return `你是小说世界推演报告编辑。基于事件账本、观察层和确定性初稿，生成精炼、可追溯的报告。不得补造账本中不存在的事实；所有 eventIds 和 entityIds 必须来自输入。\n\n运行：${run.name}\n分支：${branch.name}\n确定性初稿：${JSON.stringify(sections)}\n事件账本：${JSON.stringify(branch.ledger)}\n\n只输出 JSON：{"title":string,"summary":string,"sections":[{"kind":"world-overview|multi-scale|actors|factions|regions|causal|narrative|risk","title":string,"summary":string,"findings":string[],"eventIds":string[],"entityIds":string[],"severity":"info|warning|critical"}]}`;
}

export function buildEpochNarrationPrompt(run: WorldSimulationRun): string {
  const branch = getActiveSimulationBranch(run);
  const epochEvents = branch.ledger
    .filter((entry) => entry.kind === "epoch")
    .slice(-12);
  return `你是小说世界推演的纪元叙事编辑。只能根据确定性内核已经记录的纪元事件、聚合状态和观察节点，解释长尺度世界如何变化；不能补造未出现在输入中的人物、地点、文明或法则事实。输出应明确这是统计聚合叙事，不是精确人口或逐日历史。\n\n运行：${run.name}\n分支：${branch.name}\n当前时间：${branch.state.currentTime.displayText}\n纪元状态：${JSON.stringify(branch.state.epoch)}\n纪元事件：${JSON.stringify(epochEvents)}\n观察节点：${JSON.stringify(branch.observations.filter((item) => ["millennium", "ten-thousand-years", "hundred-billion-years", "trillion-years"].includes(item.scale)).slice(-12))}\n\n只输出 JSON：{"title":string,"summary":string,"findings":string[],"eventIds":string[]}`;
}

export function parseEpochNarrationCandidate(
  output: string,
): EpochNarrationCandidate {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? output;
  let value: unknown;
  try {
    value = JSON.parse(fenced.trim());
  } catch (cause) {
    throw new Error(
      `纪元叙事不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("纪元叙事根节点必须是对象");
  const candidate = value as Partial<EpochNarrationCandidate>;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string" ||
    !Array.isArray(candidate.findings) ||
    !candidate.findings.every((finding) => typeof finding === "string") ||
    !Array.isArray(candidate.eventIds) ||
    !candidate.eventIds.every((eventId) => typeof eventId === "string")
  ) {
    throw new Error("纪元叙事缺少必要字段");
  }
  return {
    title: candidate.title.trim(),
    summary: candidate.summary.trim(),
    findings: candidate.findings
      .map((finding) => finding.trim())
      .filter(Boolean),
    eventIds: candidate.eventIds,
  };
}

export function parseSimulationReportCandidate(
  output: string,
): SimulationReportCandidate {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? output;
  let value: unknown;
  try {
    value = JSON.parse(fenced.trim());
  } catch (cause) {
    throw new Error(
      `推演报告不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("推演报告根节点必须是对象");
  const candidate = value as Partial<SimulationReportCandidate>;
  const kinds: readonly SimulationReportKind[] = [
    "world-overview",
    "multi-scale",
    "actors",
    "factions",
    "regions",
    "causal",
    "narrative",
    "risk",
  ];
  const validSections =
    Array.isArray(candidate.sections) &&
    candidate.sections.every(
      (section) =>
        section &&
        kinds.includes(section.kind) &&
        typeof section.title === "string" &&
        typeof section.summary === "string" &&
        Array.isArray(section.findings) &&
        Array.isArray(section.eventIds) &&
        Array.isArray(section.entityIds) &&
        ["info", "warning", "critical"].includes(section.severity),
    );
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string" ||
    !validSections
  )
    throw new Error("推演报告缺少必要字段");
  return candidate as SimulationReportCandidate;
}

export function createSimulationReport(
  run: WorldSimulationRun,
  candidate?: SimulationReportCandidate,
  degradedReason: string | null = null,
  now = new Date().toISOString(),
  epochNarrative?: EpochNarrationCandidate,
): WorldSimulationRun {
  const branch = getActiveSimulationBranch(run);
  const knownEventIds = new Set(branch.ledger.map((entry) => entry.id));
  const knownEntityIds = new Set([
    ...run.baseline.characters.map((item) => item.id),
    ...run.baseline.factions.map((item) => item.id),
    ...run.baseline.regions.map((item) => item.id),
    ...run.baseline.items.map((item) => item.id),
  ]);
  const fallbackSections = deterministicReportSections(run, branch);
  const narrativeSection: Omit<SimulationReportSection, "id"> | null =
    epochNarrative
      ? {
          kind: "narrative",
          title: epochNarrative.title,
          summary: epochNarrative.summary,
          findings: epochNarrative.findings,
          eventIds: epochNarrative.eventIds,
          entityIds: [],
          severity: "info",
        }
      : null;
  const baseSections = (candidate?.sections ?? fallbackSections).filter(
    (section) => !narrativeSection || section.kind !== "narrative",
  );
  const rawSections = [
    ...baseSections,
    ...(narrativeSection ? [narrativeSection] : []),
  ];
  const sections = rawSections.map((section, index) => ({
    ...section,
    id: `report-section-${String(index + 1).padStart(2, "0")}`,
    eventIds: section.eventIds.filter((id) => knownEventIds.has(id)),
    entityIds: section.entityIds.filter((id) => knownEntityIds.has(id)),
  }));
  const report: SimulationReport = {
    id: `report-${branch.id}-${String(run.reports.length + 1).padStart(3, "0")}`,
    branchId: branch.id,
    title: candidate?.title.trim() || `${run.name} · ${branch.name}报告`,
    summary:
      candidate?.summary.trim() ||
      epochNarrative?.summary ||
      sections.find((section) => section.kind === "world-overview")?.summary ||
      "当前分支报告",
    generatedAt: now,
    generatedBy: candidate || epochNarrative ? "model" : "fallback",
    degradedReason: candidate ? null : degradedReason,
    throughEventSequence: branch.ledger.length,
    sections,
  };
  return { ...run, reports: [...run.reports, report], updatedAt: now };
}
