import {
  addWorldTicks,
  chooseAdaptiveStep,
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
  type CouncilOption,
  type CouncilSession,
  type CouncilStance,
  type FactionProjection,
  type ObservationPoint,
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
  type WorldDomainCommand,
  type WorldRuntimeState,
  type WorldSimulationBaseline,
  type WorldSimulationRun,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";

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

const clamp = (value: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const code of new TextEncoder().encode(value)) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function randomUnit(seed: string, label: string): number {
  return stableHash(`${seed}:${label}`) / 0xffffffff;
}

function pick<T>(
  values: readonly T[],
  seed: string,
  label: string,
): T | undefined {
  if (values.length === 0) return undefined;
  return values[
    Math.floor(randomUnit(seed, label) * values.length) % values.length
  ];
}

function signalMetric(...values: readonly string[]): number {
  const text = values.join(" ");
  let score = 50;
  if (/强盛|稳固|繁荣|充足|精锐|鼎盛|支持|统一/u.test(text)) score += 20;
  if (/衰弱|混乱|匮乏|腐败|分裂|低迷|反对|失控/u.test(text)) score -= 20;
  if (/战争|争夺|危机|动荡|敌对/u.test(text)) score -= 10;
  return clamp(score);
}

function initialRuntimeState(
  baseline: WorldSimulationBaseline,
): WorldRuntimeState {
  const yearDays = scaleToDays("year", baseline.calendar);
  return {
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
      knowledgeIds: character.knowledge.map((knowledge) => knowledge.id),
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
    entropy: 0,
  };
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
  const state = initialRuntimeState(baseline);
  const idSuffix = `${Date.now().toString(36)}-${stableHash(`${baseline.sourceRevision}:${scenario.seed}`).toString(36)}`;
  const runId = `run-${idSuffix}`;
  const branch: SimulationBranch = {
    id: "branch-main",
    name: "主推演分支",
    parentBranchId: null,
    forkEventId: null,
    narrativePolicy: "configured",
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

export function applyWorldDomainCommands(
  state: WorldRuntimeState,
  commands: readonly WorldDomainCommand[],
): WorldRuntimeState {
  return commands.reduce<WorldRuntimeState>((current, command) => {
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
                throw new Error(`人物正在前往${character.travel.toRegionId}，不能重复出发`);
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
                parseWorldTick(character.travel.arrivalSortKey) !==
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
              knowledgeIds: character.knowledgeIds.includes(command.knowledgeId)
                ? character.knowledgeIds
                : [...character.knowledgeIds, command.knowledgeId],
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
      case "effect.schedule":
        if (
          parseWorldTick(command.effect.dueSortKey) <=
          parseWorldTick(current.currentTime.sortKey)
        )
          throw new Error("空间影响到达时间必须晚于当前世界时间");
        if (
          !current.regions.some((region) => region.id === command.effect.originRegionId) ||
          !current.regions.some((region) => region.id === command.effect.targetRegionId)
        )
          throw new Error("空间影响引用了不存在的地域");
        if (current.scheduledEffects.some((effect) => effect.id === command.effect.id))
          throw new Error(`空间影响重复排程：${command.effect.id}`);
        return {
          ...current,
          scheduledEffects: [...current.scheduledEffects, command.effect],
        };
      case "effect.consume": {
        const effect = current.scheduledEffects.find(
          (item) => item.id === command.effectId,
        );
        if (!effect) throw new Error(`待抵达的空间影响不存在：${command.effectId}`);
        if (parseWorldTick(effect.dueSortKey) !== parseWorldTick(current.currentTime.sortKey))
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
): WorldRuntimeState {
  const elapsedDays =
    parseWorldTick(time.sortKey) - parseWorldTick(state.currentTime.sortKey);
  if (elapsedDays < 0n) throw new Error("推演事件时间不得倒退");
  if (elapsedDays === 0n) return { ...state, currentTime: time };
  return {
    ...state,
    currentTime: time,
    characters: state.characters.map((character) => ({
      ...character,
      ageDays: addWorldTicks(character.ageDays, elapsedDays),
    })),
    entropy: clamp(
      state.entropy +
        Math.log10(
          Number(elapsedDays > 10_000_000n ? 10_000_000n : elapsedDays) + 1,
        ) /
          20,
      0,
      100,
    ),
  };
}

function replaySimulationLedger(
  baseline: WorldSimulationBaseline,
  ledger: readonly SimulationEvent[],
): WorldRuntimeState {
  return ledger.reduce((state, entry) => {
    const timedState = advanceRuntimeClock(state, entry.time);
    return applyWorldDomainCommands(timedState, entry.commands);
  }, initialRuntimeState(baseline));
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
    // 草稿、归档和没有空间坐标的人物不是可执行主体。即使作者显式勾选，
    // 也必须先在人物库补齐其初始状态，避免内核替作者猜测人物在哪里。
    if (
      !runtime?.alive ||
      runtime.travel ||
      !runtime.locationId ||
      /draft|archived|草稿|归档/iu.test(character.status)
    )
      return false;
    if (selectedIds.size > 0 && selectedIds.has(character.id)) return true;
    if (selectedFactionIds.size > 0)
      return character.factionIds.some((id) => selectedFactionIds.has(id));
    return (
      selectedIds.size === 0 &&
      (!runtime.locationId || regionIds.has(runtime.locationId))
    );
  });
}

function activeFactions(run: WorldSimulationRun): readonly FactionProjection[] {
  const regionIds = selectedRegionIds(run.baseline, run.scenario);
  const selectedIds = new Set(run.scenario.scope.factionIds);
  const direct = run.baseline.factions.filter((faction) => {
    if (/draft|archived|草稿|归档|dissolved|解散|灭亡/iu.test(faction.status))
      return false;
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
      !/draft|archived|草稿|归档|dissolved|解散|灭亡/iu.test(faction.status),
  );
}

function activeNarrativeConstraints(
  run: WorldSimulationRun,
  branch: SimulationBranch,
): readonly WorldSimulationBaseline["narrativeConstraints"][number][] {
  return branch.narrativePolicy === "disabled"
    ? []
    : run.baseline.narrativeConstraints;
}

function guidedCharacter(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  characters: readonly CharacterProjection[],
  nextSortKey: string,
): CharacterProjection | undefined {
  const constrainedIds = new Set(
    activeNarrativeConstraints(run, branch)
      .filter(
        (constraint) =>
          constraint.mode === "guide" || constraint.mode === "strict",
      )
      .flatMap((constraint) => constraint.entityIds),
  );
  const guided = characters.filter((character) =>
    constrainedIds.has(character.id),
  );
  return pick(
    guided.length ? guided : characters,
    branch.seed,
    `character:${nextSortKey}`,
  );
}

function guidedFaction(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  factions: readonly FactionProjection[],
  nextSortKey: string,
): FactionProjection | undefined {
  const constrainedIds = new Set(
    activeNarrativeConstraints(run, branch)
      .filter(
        (constraint) =>
          constraint.mode === "guide" || constraint.mode === "strict",
      )
      .flatMap((constraint) => constraint.entityIds),
  );
  const guided = factions.filter((faction) => constrainedIds.has(faction.id));
  return pick(
    guided.length ? guided : factions,
    branch.seed,
    `faction:${nextSortKey}`,
  );
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
              routeSignature(previous).localeCompare(routeSignature(next)) <= 0))
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
  if (!route || route.regionIds.some((regionId) => !visibleRegionIds.has(regionId)))
    throw new Error(`${source}的移动缺少可达空间路径`);
  const earliestArrival = addWorldTicks(departureSortKey, route.travelDays);
  if (parseWorldTick(command.arrivalSortKey) < parseWorldTick(earliestArrival)) {
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
    return event(run, branch, nextSortKey, scale, {
      kind: "lifecycle",
      title: `${character.name}走到寿命尽头`,
      summary: `${character.name}的个人行动停止，其关系、传承与遗物开始转化为后续世界影响。`,
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
          status: "已离世",
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
    const breakthrough =
      runtime.cultivationProgress + progressDelta >= 100 && Boolean(nextLevel);
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
  });
}

function worldProcessEvent(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  stepDays: bigint,
  scale: TimeScale,
): SimulationEvent | null {
  // 没有被结构化规则、已排程影响或事实事件触发的“自然演化”，不能用
  // 伪随机数修改人口、经济、灵气等状态。时间仍会推进，空白就是资料不足。
  void run;
  void branch;
  void nextSortKey;
  void stepDays;
  void scale;
  return null;
}

function propagationEvents(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  source: SimulationEvent | undefined,
  nextSortKey: string,
  scale: TimeScale,
): readonly SimulationEvent[] {
  if (!source) return [];
  const originId = source.regionIds[0];
  if (
    !originId ||
    !source.commands.some(
      (command) =>
        command.type === "region.metric" &&
        command.metric === "pressure" &&
        command.delta >= 5,
    )
  )
    return [];
  const origin = run.baseline.regions.find((region) => region.id === originId);
  if (!origin) return [];
  const scopedRegionIds = selectedRegionIds(run.baseline, run.scenario);
  const result: SimulationEvent[] = [];
  let eventBranch = branch;
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
      const boundaryFactor =
        !targetIsInScope && run.scenario.scope.outsidePolicy === "approximate"
          ? 0.45
          : 1;
      const delta = Math.max(
        1,
        Math.round(5 * (1 - connection.attenuation) * boundaryFactor),
      );
      const dueSortKey = travelArrivalSortKey(nextSortKey, connection.travelDays);
      const targetName = run.baseline.regions.find(
        (region) => region.id === targetId,
      )?.name ?? "相邻地域";
      const propagation = event(run, eventBranch, nextSortKey, scale, {
        kind: "propagation",
        title: `${source.title}的影响开始向${targetName}传播`,
        summary: `事件沿${connection.kind}通道前往${targetName}，预计${createWorldInstant(dueSortKey, run.scenario.calendar).displayText}抵达，强度会在传播中衰减${!targetIsInScope && run.scenario.scope.outsidePolicy === "approximate" ? "，范围外地域按统计近似处理" : ""}。`,
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
            },
          },
        ],
        narrativeConstraintIds: source.narrativeConstraintIds,
        generatedBy: "kernel",
        confidence: 0.9,
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
    .filter((character) => character.travel?.arrivalSortKey === nextSortKey)
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
              command.arrivalSortKey === nextSortKey,
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
        regionIds: [runtime.travel.fromRegionId, runtime.travel.toRegionId].filter(
          (value): value is string => Boolean(value),
        ),
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
      eventBranch = { ...eventBranch, ledger: [...eventBranch.ledger, arrival] };
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
  branch.state.scheduledEffects
    .filter((effect) => effect.dueSortKey === nextSortKey)
    .forEach((effect) => {
      const target = run.baseline.regions.find(
        (region) => region.id === effect.targetRegionId,
      );
      const arrival = event(run, eventBranch, nextSortKey, scale, {
        kind: "propagation",
        title: `影响抵达${target?.name ?? "目标地域"}`,
        summary: `来自${effect.originRegionId}的影响沿${effect.connectionId}抵达，压力与稳定度变化现在才生效。`,
        characterIds: [],
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
          { type: "effect.consume", effectId: effect.id },
        ],
        narrativeConstraintIds: [],
        generatedBy: "kernel",
        confidence: 1,
      });
      result.push(arrival);
      eventBranch = { ...eventBranch, ledger: [...eventBranch.ledger, arrival] };
    });
  return result;
}

function nextScheduledBoundary(
  branch: SimulationBranch,
  currentSortKey: string,
  endSortKey: string,
): string | null {
  const current = parseWorldTick(currentSortKey);
  const end = parseWorldTick(endSortKey);
  const candidates = [
    ...branch.state.characters.flatMap((character) =>
      character.travel ? [character.travel.arrivalSortKey] : [],
    ),
    ...branch.state.scheduledEffects.map((effect) => effect.dueSortKey),
  ]
    .map(parseWorldTick)
    .filter((value) => value > current && value <= end)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return candidates[0]?.toString() ?? null;
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

function validateModelCandidate(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  candidate: ModelDecisionCandidate,
  eventTimeSortKey = branch.state.currentTime.sortKey,
): void {
  if (!candidate.title.trim() || !candidate.summary.trim())
    throw new Error("模型候选缺少标题或摘要");
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
  const visibleCharacters = activeCharacters(run, branch).slice(0, 1);
  const visibleFactions = activeFactions(run).slice(0, 1);
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
  if (candidate.itemIds.some((id) => !visibleItems.has(id))) {
    throw new Error("模型候选试图操作不可见物品");
  }
  const visibleKnowledge = new Map(
    visibleCharacters.map((character) => [
      character.id,
      new Set(character.knowledge.map((knowledge) => knowledge.id)),
    ]),
  );
  candidate.commands.forEach((command) => {
    if (
      command.type === "character.arrive" ||
      command.type === "effect.schedule" ||
      command.type === "effect.consume"
    ) {
      throw new Error("模型候选不得直接提交旅行抵达或空间传播内部命令");
    }
    if (
      command.type === "character.knowledge" &&
      !visibleKnowledge.get(command.characterId)?.has(command.knowledgeId)
    ) {
      throw new Error("模型候选试图让人物获得其尚未掌握的知识");
    }
    if (
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
        command.type === "character.life" ||
        command.type === "character.knowledge") &&
      !visibleCharacterIds.has(command.characterId)
    )
      throw new Error("模型候选操作了不可见人物");
    if (
      (command.type === "faction.strategy" ||
        command.type === "faction.metric") &&
      !visibleFactionIds.has(command.factionId)
    )
      throw new Error("模型候选操作了不可见势力");
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
      currentTime: createWorldInstant(
        eventTimeSortKey,
        run.scenario.calendar,
      ),
    },
    candidate.commands,
  );
}

function modelEvent(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  nextSortKey: string,
  scale: TimeScale,
  candidate: ModelDecisionCandidate,
): SimulationEvent {
  validateModelCandidate(run, branch, candidate, nextSortKey);
  return event(run, branch, nextSortKey, scale, {
    ...candidate,
    evidence: [
      {
        type: "knowledge",
        label: "受控智能候选",
        detail: "候选已通过实体、命令和状态边界校验。",
        authority: "simulated",
        sourceRefs: [],
      },
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
  });
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
): string | null {
  const strictConstraints = activeNarrativeConstraints(run, branch).filter(
    (constraint) => constraint.mode === "strict",
  );
  if (strictConstraints.length === 0) return null;
  for (const event of events) {
    for (const command of event.commands) {
      if (command.type !== "character.life" || command.alive) continue;
      const character = run.baseline.characters.find(
        (item) => item.id === command.characterId,
      );
      const constraint = strictConstraints.find((item) => {
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
  externalCandidate?: ModelDecisionCandidate,
): SimulationBranch {
  if (branch.warnings.some((warning) => warning.startsWith("剧情不可实现：")))
    return { ...branch, status: "paused" };
  const endSortKey = getSimulationEndSortKey(run);
  const current = parseWorldTick(branch.state.currentTime.sortKey);
  const end = parseWorldTick(endSortKey);
  if (current >= end) return { ...branch, status: "completed" };
  const usedSteps = Math.max(0, branch.checkpoints.length - 1);
  const stepDays = chooseAdaptiveStep(
    branch.state.currentTime.sortKey,
    endSortKey,
    Math.max(1, run.scenario.maxSteps - usedSteps),
    run.scenario.calendar,
  );
  const adaptiveNextSortKey = (
    current + stepDays > end ? end : current + stepDays
  ).toString();
  const scheduledSortKey = nextScheduledBoundary(
    branch,
    branch.state.currentTime.sortKey,
    endSortKey,
  );
  const nextSortKey = scheduledSortKey &&
    parseWorldTick(scheduledSortKey) < parseWorldTick(adaptiveNextSortKey)
    ? scheduledSortKey
    : adaptiveNextSortKey;
  const actualStepDays = parseWorldTick(nextSortKey) - current;
  const scale = resolveEventScale(actualStepDays, run.scenario.calendar);
  const scheduledEvents = [
    ...scheduledArrivalEvents(run, branch, nextSortKey, scale),
    ...scheduledEffectArrivalEvents(run, branch, nextSortKey, scale),
  ];
  const characters = activeCharacters(run, branch);
  const factions = activeFactions(run);
  const chosenCharacter = guidedCharacter(run, branch, characters, nextSortKey);
  const chosenFaction = guidedFaction(run, branch, factions, nextSortKey);
  const events: SimulationEvent[] = [...scheduledEvents];
  let workingBranch: SimulationBranch = {
    ...branch,
    ledger: [...branch.ledger, ...scheduledEvents],
  };
  if (chosenCharacter) {
      const characterAction = characterEvent(
        run,
        workingBranch,
        chosenCharacter,
        nextSortKey,
        actualStepDays,
        scale,
      );
      if (characterAction) {
        events.push(characterAction);
        workingBranch = { ...workingBranch, ledger: [...workingBranch.ledger, characterAction] };
      }
  }
  if (chosenFaction) {
    const factionAction = factionEvent(run, workingBranch, chosenFaction, nextSortKey, scale);
    if (factionAction) {
      events.push(factionAction);
      workingBranch = { ...workingBranch, ledger: [...workingBranch.ledger, factionAction] };
    }
  }
  const worldEvent = worldProcessEvent(
    run,
    workingBranch,
    nextSortKey,
    actualStepDays,
    scale,
  );
  if (worldEvent) {
    events.push(worldEvent);
    workingBranch = { ...workingBranch, ledger: [...workingBranch.ledger, worldEvent] };
  }
  if (externalCandidate) {
    const model = modelEvent(run, workingBranch, nextSortKey, scale, externalCandidate);
    events.push(model);
    workingBranch = { ...workingBranch, ledger: [...workingBranch.ledger, model] };
  }
  const propagations = propagationEvents(
    run,
    workingBranch,
    events.find((entry) => entry.kind === "conflict"),
    nextSortKey,
    scale,
  );
  if (propagations.length > 0) {
    events.push(...propagations);
    workingBranch = {
      ...workingBranch,
      ledger: [...workingBranch.ledger, ...propagations],
    };
  }
  const strictViolation = strictNarrativeViolation(run, branch, events);
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
  );
  const nextState = events.reduce(
    (state, entry) => applyWorldDomainCommands(state, entry.commands),
    agedState,
  );
  const ledger = [...branch.ledger, ...events].map((entry, index) => ({
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
  const nextBranch: SimulationBranch = {
    ...branch,
    status: parseWorldTick(nextSortKey) >= end ? "completed" : "paused",
    state: nextState,
    ledger,
    checkpoints: [...branch.checkpoints, checkpoint],
    observations: [],
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
    readonly modelCandidate?: ModelDecisionCandidate;
  } = {},
): WorldSimulationRun {
  let branch = getActiveSimulationBranch(run);
  if (branch.status === "cancelled" || branch.status === "completed")
    return run;
  const requestedSteps = options.toEnd
    ? run.scenario.maxSteps
    : Math.max(1, options.steps ?? 1);
  for (let index = 0; index < requestedSteps; index += 1) {
    branch = advanceSingleStep(
      run,
      { ...branch, status: "running" },
      index === 0 ? options.modelCandidate : undefined,
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
): WorldSimulationRun {
  const source = getActiveSimulationBranch(run);
  const eventIndex = source.ledger.findIndex((entry) => entry.id === eventId);
  if (eventIndex < 0) throw new Error("无法从不存在的事件创建分支");
  const ledger = source.ledger.slice(0, eventIndex + 1);
  const state = replaySimulationLedger(run.baseline, ledger);
  const id = `branch-${Date.now().toString(36)}-${source.id.replace(/^branch-/u, "")}`;
  const branch: SimulationBranch = {
    id,
    name,
    parentBranchId: source.id,
    forkEventId: eventId,
    narrativePolicy: source.narrativePolicy,
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
        new Set(character.knowledge.map((knowledge) => knowledge.id)),
      ]),
  );
  commands.forEach((command) => {
    if (
      command.type === "character.arrive" ||
      command.type === "effect.schedule" ||
      command.type === "effect.consume"
    ) {
      throw new Error("会商方案不得直接提交旅行抵达或空间传播排程命令");
    }
    if (
      (command.type === "character.intent" ||
        command.type === "character.move" ||
        command.type === "character.cultivate" ||
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
      (command.type === "faction.strategy" ||
        command.type === "faction.metric") &&
      !factionIds.has(command.factionId)
    ) {
      throw new Error("会商方案试图操作非参与势力");
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
            ...activeFactions(run).map((faction) => faction.id),
          ],
    ),
  ];
  const characterStances: CouncilStance[] = run.baseline.characters
    .filter((character) => participantIds.includes(character.id))
    .map((character) => ({
      participantType: "character",
      participantId: character.id,
      knownFactIds: character.knowledge.map((knowledge) => knowledge.id),
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
  const actionCommandSource =
    target?.commands.some(
      (command) =>
        command.type === "character.intent" || command.type === "faction.strategy",
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
    (command) => command.type === "character.intent" || command.type === "faction.strategy",
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
        new Set(character.knowledge.map((knowledge) => knowledge.id)),
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
    ? replaySimulationLedger(run.baseline, retainedLedger)
    : (source.checkpoints[0]?.state ?? source.state);
  const id = `branch-council-${Date.now().toString(36)}`;
  const seed = `${source.seed}:council:${session.id}:${option.id}`;
  const branchAtFork: SimulationBranch = {
    id,
    name: `会商干预 · ${option.title}`,
    parentBranchId: source.id,
    forkEventId: targetEventId,
    narrativePolicy: source.narrativePolicy,
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

export function buildDecisionPrompt(run: WorldSimulationRun): string {
  const branch = getActiveSimulationBranch(run);
  const character = activeCharacters(run, branch)[0];
  const faction = activeFactions(run)[0];
  const chapter = run.scenario.chapterContext.chapterId
    ? run.baseline.chapters.find(
        (item) => item.id === run.scenario.chapterContext.chapterId,
      )
    : undefined;
  const chapterContext = chapter && run.scenario.chapterContext.mode !== "none"
    ? {
        mode: run.scenario.chapterContext.mode,
        title: chapter.title,
        // 正文只通过已确认的时间线事件进入决策输入。整段章节文本可能
        // 包含梦境、传闻或角色误判，不能被模型自行提升为世界事实。
        confirmedFactIds: run.baseline.timelineFacts
          .filter((event) => event.chapterIds.includes(chapter.id))
          .map((event) => event.id),
      }
    : null;
  const usesNarrativePlans =
    run.scenario.narrativeContext.mode !== "off" &&
    (run.scenario.narrativeContext.usePlotLines ||
      run.scenario.narrativeContext.useStoryArcs ||
      run.scenario.narrativeContext.useDirectoryOutline ||
      run.scenario.narrativeContext.useChapterPlans);
  const perspective = character
    ? {
        type: "character",
        id: character.id,
        name: character.name,
        goals: character.goals,
        locationId: character.locationId,
        knowledge: character.knowledge.map((knowledge) => ({
          id: knowledge.id,
          statement: knowledge.statement,
          authority: knowledge.authority,
        })),
        resources: character.inventoryItemIds,
      }
    : faction
      ? {
          type: "faction",
          id: faction.id,
          name: faction.name,
          goals: faction.goals,
          resources: faction.resources,
          relations: faction.relations,
        }
      : null;
  return `你是小说世界推演的单一主体智能候选层。当前输入只包含一个主体的视角，绝不能猜测其它人物或势力的私有知识；只能提出一个候选事件，不能直接改写事实。\n\n当前时间：${branch.state.currentTime.displayText}\n作者目标：${run.scenario.objective}\n章节上下文（仅在配置启用时提供）：${JSON.stringify(chapterContext)}\n当前主体：${JSON.stringify(perspective)}\n可见地域：${JSON.stringify(
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
  )}\n已发生事实（只能把这些视为事实）：${JSON.stringify(run.baseline.timelineFacts.slice(-12).map((item) => ({ id: item.id, time: item.time.displayText, title: item.title, summary: item.summary })))}\n作者未来计划（仅在剧情工程启用时作为计划或约束；绝不能当作已发生）：${JSON.stringify(usesNarrativePlans ? run.baseline.timelinePlans.slice(0, 12).map((item) => ({ id: item.id, time: item.time.displayText, title: item.title, summary: item.summary })) : [])}\n硬规则：${JSON.stringify(run.baseline.rules.slice(0, 8).map((rule) => ({ id: rule.id, title: rule.title, description: rule.description })))}\n剧情约束：${JSON.stringify(activeNarrativeConstraints(run, branch).map((constraint) => ({ id: constraint.id, mode: constraint.mode, title: constraint.title, content: constraint.content })))}\n\n只输出 JSON：{"title":string,"summary":string,"kind":"character-action|faction-strategy|conflict|diplomacy|cultivation|lifecycle|propagation|world-process|epoch","characterIds":string[],"factionIds":string[],"regionIds":string[],"itemIds":string[],"commands":WorldDomainCommand[],"confidence":0..1}`;
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
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string" ||
    !allowedKinds.includes(candidate.kind as SimulationEventKind) ||
    !Array.isArray(candidate.characterIds) ||
    !Array.isArray(candidate.factionIds) ||
    !Array.isArray(candidate.regionIds) ||
    !Array.isArray(candidate.itemIds) ||
    !Array.isArray(candidate.commands) ||
    typeof candidate.confidence !== "number"
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
  return `你是小说世界推演的候选复核层。检查候选是否违反实体存在性、人物知识边界、空间距离、资源成本、寿命、修炼前置、世界硬规则和剧情硬护栏。不得直接写入世界状态；需要修正时返回修正后的同结构候选。\n\n当前时间：${branch.state.currentTime.displayText}\n候选：${JSON.stringify(candidate)}\n硬规则：${JSON.stringify(run.baseline.rules.filter((rule) => rule.severity === "hard").map((rule) => ({ id: rule.id, title: rule.title, description: rule.description })))}\n剧情硬护栏：${JSON.stringify(
    activeNarrativeConstraints(run, branch)
      .filter((constraint) => constraint.mode === "strict")
      .map((constraint) => ({
        id: constraint.id,
        title: constraint.title,
        content: constraint.content,
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
          ...activeFactions(run).map((faction) => faction.id),
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
      knowledge: character.knowledge.map((knowledge) => ({
        id: knowledge.id,
        statement: knowledge.statement,
        authority: knowledge.authority,
      })),
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
          ...activeFactions(run).map((faction) => faction.id),
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
        knowledge: character.knowledge,
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
      findings: run.baseline.narrativeConstraints.map(
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
      severity: "info",
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
  month: "月",
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
  const rawSections = candidate?.sections ?? fallbackSections;
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
      sections.find((section) => section.kind === "world-overview")?.summary ||
      "当前分支报告",
    generatedAt: now,
    generatedBy: candidate ? "model" : "fallback",
    degradedReason: candidate ? null : degradedReason,
    throughEventSequence: branch.ledger.length,
    sections,
  };
  return { ...run, reports: [...run.reports, report], updatedAt: now };
}
