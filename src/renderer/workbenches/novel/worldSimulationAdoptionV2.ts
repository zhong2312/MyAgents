import { z } from "zod";

import type { WorkbenchStorage } from "@/workbench-sdk";

import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalRepository,
} from "./fileProposal";
import {
  CHARACTER_LIBRARY_PATHS,
  createNovelCharacterLibraryRepository,
} from "./modules/characters";
import {
  parseCharacterRecordFile,
  serializeCharacterLibraryFile,
  type CharacterRecord,
} from "./modules/characters";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import {
  FACTION_LIBRARY_PATH,
  parseFactionLibrary,
  serializeFactionLibrary,
  type FactionLibrary,
} from "./modules/factions/entities/factionLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import {
  MAIN_TIMELINE_BRANCH_ID,
  TIMELINE_LIBRARY_PATH,
  getTimelineBranchEvents,
  parseTimelineLibrary,
  serializeTimelineLibrary,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineLibrary,
  type TimelineStateChange,
} from "./timelineLibrarySchema";
import { getActiveSimulationBranch } from "./worldSimulationEngineV2";
import type {
  SimulationAdoptionAuthority,
  SimulationEvent,
  WorldDomainCommand,
  WorldSimulationRun,
} from "./worldSimulationV2Schema";

export const WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY =
  "simulation/adoption-proposals";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const adoptionChangeSchema = z
  .object({
    id: idSchema,
    targetPath: z.string().trim().min(1),
    operation: z.literal("modify"),
    summary: z.string().trim().min(1),
    status: z.enum(["pending", "applied", "rejected"]),
    beforeContent: z.string(),
    afterContent: z.string(),
  })
  .strict();

const adoptionManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    proposalId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    branchId: idSchema,
    eventIds: z.array(idSchema).min(1),
    authority: z.enum(["planned", "author-secret", "actual"]),
    title: z.string().trim().min(1),
    description: z.string(),
    createdAt: z.string().datetime(),
    changes: z.array(adoptionChangeSchema).min(1),
  })
  .strict();

type AdoptionManifest = z.infer<typeof adoptionManifestSchema>;
type AdoptionChange = z.infer<typeof adoptionChangeSchema>;
type CharacterDomainCommand = Extract<
  WorldDomainCommand,
  { readonly type: `character.${string}` }
>;
type FactionDomainCommand = Extract<
  WorldDomainCommand,
  { readonly type: `faction.${string}` }
>;

interface LoadedAdoptionManifest {
  readonly value: AdoptionManifest;
  readonly path: string;
  readonly content: string;
}

function manifestPath(proposalId: string): string {
  idSchema.parse(proposalId);
  return `${WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseManifest(path: string, content: string): AdoptionManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause) {
    throw new Error(
      `${path} 无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const result = adoptionManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${path} 格式无效：${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`,
    );
  }
  return result.data;
}

async function projectIdentity(storage: WorkbenchStorage): Promise<string> {
  const file = await storage.readText("novel.json");
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    throw new Error("novel.json 无法解析，不能创建或应用推演提案");
  }
  const projectId =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { readonly projectId?: unknown }).projectId
      : null;
  if (typeof projectId !== "string" || !idSchema.safeParse(projectId).success) {
    throw new Error("novel.json 缺少有效项目身份");
  }
  return projectId;
}

function authorityLabel(authority: SimulationAdoptionAuthority): string {
  if (authority === "actual") return "已确认发生的事实";
  if (authority === "author-secret") return "作者秘密";
  return "未来计划";
}

function timelineKind(event: SimulationEvent): TimelineEventKind {
  if (event.kind === "conflict") return "battle";
  if (event.kind === "cultivation" || event.kind === "propagation")
    return "discovery";
  if (event.kind === "lifecycle" || event.kind === "epoch")
    return "turning-point";
  return "event";
}

function saturatedTimelineSortKey(sortKey: string): number {
  const value = BigInt(sortKey);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit) return Number.MAX_SAFE_INTEGER;
  if (value < -limit) return -Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function commandDescription(command: WorldDomainCommand): string {
  switch (command.type) {
    case "character.intent":
      return `${command.characterId} 意图改为“${command.intent}”，状态为“${command.status}”`;
    case "character.move":
      return `${command.characterId} 从${command.fromRegionId ?? "未知地域"}出发，预计于${command.arrivalSortKey}抵达${command.toRegionId}`;
    case "character.arrive":
      return `${command.characterId} 抵达${command.toRegionId}`;
    case "character.cultivate":
      return `${command.characterId} 修行进度变化 ${command.progressDelta}，阶段 ${command.nextLevelId ?? "保持不变"}`;
    case "character.life":
      return `${command.characterId} 生命状态改为“${command.status}”`;
    case "character.knowledge":
      return `${command.characterId} 获知 ${command.knowledgeId}`;
    case "faction.strategy":
      return `${command.factionId} 采取“${command.strategy}”`;
    case "faction.metric":
      return `${command.factionId} 的 ${command.metric} 变化 ${command.delta}`;
    case "region.metric":
      return `${command.regionId} 的 ${command.metric} 变化 ${command.delta}`;
    case "region.control":
      return `${command.regionId} 的控制势力改为 ${command.factionIds.join("、") || "无"}`;
    case "item.transfer":
      return `${command.itemId} 的归属改为 ${command.ownerId ?? "无主"}`;
    case "effect.schedule":
      return `影响沿${command.effect.connectionId}传播，预计于${command.effect.dueSortKey}抵达${command.effect.targetRegionId}`;
    case "effect.consume":
      return `传播影响${command.effectId}抵达并生效`;
  }
}

function isCharacterDomainCommand(
  command: WorldDomainCommand,
): command is CharacterDomainCommand {
  return command.type.startsWith("character.");
}

function isFactionDomainCommand(
  command: WorldDomainCommand,
): command is FactionDomainCommand {
  return command.type.startsWith("faction.");
}

function stateChangeForCommand(
  event: SimulationEvent,
  command: WorldDomainCommand,
  index: number,
): TimelineStateChange | null {
  const base = {
    id: `sim-change-${event.sequence}-${index + 1}`,
    before: "推演基线状态",
    after: commandDescription(command),
    note: `来自世界推演事件 ${event.id}`,
  };
  if (isCharacterDomainCommand(command)) {
    return { ...base, entityType: "character", entityId: command.characterId };
  }
  if (isFactionDomainCommand(command)) {
    return { ...base, entityType: "faction", entityId: command.factionId };
  }
  if (command.type === "item.transfer") {
    return { ...base, entityType: "item", entityId: command.itemId };
  }
  return null;
}

function uniqueExisting(
  ids: readonly string[],
  existing: ReadonlySet<string>,
): string[] {
  return [...new Set(ids.filter((id) => existing.has(id)))];
}

function appendSimulationNote(current: string, note: string): string {
  const normalized = current.trim();
  return normalized ? `${normalized}\n${note}` : note;
}

function itemName(run: WorldSimulationRun, itemId: string): string {
  const item = run.baseline.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`推演引用了基线中不存在的物品：${itemId}`);
  return item.name;
}

function uniqueChildId(
  existingIds: ReadonlySet<string>,
  prefix: string,
): string {
  let candidate = prefix;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${prefix}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function assertTransferTarget(
  command: Extract<WorldDomainCommand, { readonly type: "item.transfer" }>,
  targets: ReadonlySet<string>,
  label: string,
): string | null {
  if (command.ownerType === null) {
    if (command.ownerId !== null)
      throw new Error("无主物品转移不得指定归属主体");
    return null;
  }
  if (command.ownerType !== label) return null;
  if (!command.ownerId)
    throw new Error(
      `物品 ${command.itemId} 的${label === "character" ? "人物" : "势力"}归属缺少目标`,
    );
  if (!targets.has(command.ownerId)) {
    throw new Error(
      `物品 ${command.itemId} 的目标${label === "character" ? "人物" : "势力"}已不存在，无法采纳`,
    );
  }
  return command.ownerId;
}

function updateCharacters(
  sourceCharacters: readonly CharacterRecord[],
  run: WorldSimulationRun,
  events: readonly SimulationEvent[],
): CharacterRecord[] {
  let characters = [...sourceCharacters];
  events.forEach((event) =>
    event.commands.forEach((command) => {
      if (isCharacterDomainCommand(command)) {
        const characterId = command.characterId;
        characters = characters.map((character) => {
          if (character.id !== characterId) return character;
          if (command.type === "character.intent")
            return { ...character, status: command.status };
          if (command.type === "character.life")
            return { ...character, status: command.status };
          if (command.type === "character.cultivate" && command.nextLevelId) {
            const level = run.baseline.cultivationSystems
              .flatMap((system) => system.levels)
              .find((candidate) => candidate.id === command.nextLevelId);
            return {
              ...character,
              currentRealm: level?.name ?? character.currentRealm,
              cultivationProfile: {
                ...character.cultivationProfile,
                levelId: command.nextLevelId,
              },
            };
          }
          return character;
        });
        return;
      }
      if (command.type !== "item.transfer") return;
      const targetId = assertTransferTarget(
        command,
        new Set(characters.map((character) => character.id)),
        "character",
      );
      const name = targetId ? itemName(run, command.itemId) : null;
      characters = characters.map((character) => {
        const inventory = character.inventory.filter(
          (entry) => entry.itemId !== command.itemId,
        );
        if (character.id !== targetId || !name) {
          return inventory.length === character.inventory.length
            ? character
            : { ...character, inventory };
        }
        const existingIds = new Set(inventory.map((entry) => entry.id));
        return {
          ...character,
          inventory: [
            ...inventory,
            {
              id: uniqueChildId(
                existingIds,
                `simulation-item-${command.itemId}`,
              ),
              itemId: command.itemId,
              name,
              quantity: 1,
              unit: "件",
              description: `[${event.time.displayText} 推演采纳] ${command.status ?? "获得该物品"}`,
            },
          ],
        };
      });
    }),
  );
  return characters;
}

const FACTION_METRIC_LABELS = {
  governance: "治理",
  military: "军事",
  economy: "经济",
  publicSupport: "民望",
  territorialIntegrity: "领土完整",
} as const;

function updateFactions(
  library: FactionLibrary,
  run: WorldSimulationRun,
  events: readonly SimulationEvent[],
): FactionLibrary {
  let factions = [...library.factions];
  events.forEach((event) =>
    event.commands.forEach((command) => {
      if (isFactionDomainCommand(command)) {
        factions = factions.map((faction) => {
          if (faction.id !== command.factionId) return faction;
          const updatedAt = new Date().toISOString();
          if (command.type === "faction.strategy") {
            const status =
              command.lifecycle === "dissolved"
                ? "dissolved"
                : command.lifecycle === "declining" ||
                    command.lifecycle === "fragmented"
                  ? "declining"
                  : faction.status;
            return {
              ...faction,
              status,
              summary: appendSimulationNote(
                faction.summary,
                `[${event.time.displayText}推演采纳] 当前策略：${command.strategy}`,
              ),
              updatedAt,
            };
          }
          if (command.type === "faction.metric") {
            const direction =
              command.delta > 0
                ? `上升 ${command.delta}`
                : command.delta < 0
                  ? `下降 ${Math.abs(command.delta)}`
                  : "保持不变";
            return {
              ...faction,
              state: {
                ...faction.state,
                [command.metric]: appendSimulationNote(
                  faction.state[command.metric],
                  `[${event.time.displayText}推演采纳] ${FACTION_METRIC_LABELS[command.metric]}${direction}`,
                ),
              },
              updatedAt,
            };
          }
          return faction;
        });
        return;
      }
      if (command.type !== "item.transfer") return;
      const targetId = assertTransferTarget(
        command,
        new Set(factions.map((faction) => faction.id)),
        "faction",
      );
      const name = targetId ? itemName(run, command.itemId) : null;
      factions = factions.map((faction) => {
        const existing = faction.resources.find(
          (resource) => resource.itemId === command.itemId,
        );
        if (faction.id !== targetId || !name) {
          if (!existing) return faction;
          return {
            ...faction,
            resources: faction.resources.filter(
              (resource) => resource.itemId !== command.itemId,
            ),
            updatedAt: new Date().toISOString(),
          };
        }
        const history = {
          id: `simulation-history-${event.id}`,
          timeLabel: event.time.displayText,
          summary: `世界推演采纳：${command.status ?? "获得该物品"}`,
        };
        if (existing) {
          return {
            ...faction,
            resources: faction.resources.map((resource) =>
              resource.itemId !== command.itemId
                ? resource
                : {
                    ...resource,
                    name,
                    control: "持有",
                    controlLevel: "owned",
                    worldNodeId: command.locationId,
                    history: [...resource.history, history],
                  },
            ),
            updatedAt: new Date().toISOString(),
          };
        }
        const existingIds = new Set(
          faction.resources.map((resource) => resource.id),
        );
        return {
          ...faction,
          resources: [
            ...faction.resources,
            {
              id: uniqueChildId(
                existingIds,
                `simulation-item-${command.itemId}`,
              ),
              name,
              kind: "物品",
              control: "持有",
              controlLevel: "owned",
              worldNodeId: command.locationId,
              itemId: command.itemId,
              competingFactionIds: [],
              history: [history],
              description: `[${event.time.displayText} 推演采纳] ${command.status ?? "获得该物品"}`,
            },
          ],
          updatedAt: new Date().toISOString(),
        };
      });
    }),
  );
  return { ...library, factions };
}

function timelineEventWorldSortKey(event: TimelineEvent): bigint {
  return BigInt(event.worldSortKey ?? Math.trunc(event.sortKey));
}

function compareTimelineEventsByWorldTime(
  left: TimelineEvent,
  right: TimelineEvent,
): number {
  const leftKey = timelineEventWorldSortKey(left);
  const rightKey = timelineEventWorldSortKey(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return left.id.localeCompare(right.id);
}

function assertActualAdoptionDoesNotCrossPlans(
  library: TimelineLibrary,
  events: readonly SimulationEvent[],
): void {
  if (events.length === 0) return;
  const latestAdoptedSortKey = events.reduce(
    (latest, event) => {
      const current = BigInt(event.time.sortKey);
      return current > latest ? current : latest;
    },
    BigInt(events[0]!.time.sortKey),
  );
  const mainTimeline = getTimelineBranchEvents(
    library,
    MAIN_TIMELINE_BRANCH_ID,
  ).map((entry) => entry.event);
  const factsThroughIndex = library.factsThroughEventId
    ? mainTimeline.findIndex((event) => event.id === library.factsThroughEventId)
    : -1;
  const crossedPlan = mainTimeline
    .slice(factsThroughIndex + 1)
    .find((event) => timelineEventWorldSortKey(event) <= latestAdoptedSortKey);
  if (crossedPlan) {
    throw new Error(
      `不能保存为已确认事实：会跨越未来计划“${crossedPlan.title}”。请先审阅该计划，或改为保存为未来计划 / 作者秘密。`,
    );
  }
}

function createTimelineEvents(
  library: TimelineLibrary,
  run: WorldSimulationRun,
  events: readonly SimulationEvent[],
  authority: SimulationAdoptionAuthority,
  now: string,
): TimelineLibrary {
  if (authority === "actual")
    assertActualAdoptionDoesNotCrossPlans(library, events);
  const characterIds = new Set(run.baseline.characters.map((item) => item.id));
  const factionIds = new Set(run.baseline.factions.map((item) => item.id));
  const itemIds = new Set(run.baseline.items.map((item) => item.id));
  const usedIds = new Set(library.events.map((event) => event.id));
  const startOrder =
    library.events.reduce(
      (maximum, event) => Math.max(maximum, event.sortOrder),
      -1,
    ) + 1;
  const created: TimelineEvent[] = events.map((event, index) => {
    let id = `sim-${run.id}-${event.sequence}`;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `sim-${run.id}-${event.sequence}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    const stateChanges = event.commands.flatMap((command, commandIndex) => {
      const change = stateChangeForCommand(event, command, commandIndex);
      if (!change) return [];
      const existing =
        change.entityType === "character"
          ? characterIds
          : change.entityType === "faction"
            ? factionIds
            : itemIds;
      return existing.has(change.entityId) ? [change] : [];
    });
    const evidence = event.evidence
      .map((entry) => `${entry.label}：${entry.detail}`)
      .join("\n");
    const commands = event.commands.map(commandDescription).join("\n");
    return {
      id,
      branchId: MAIN_TIMELINE_BRANCH_ID,
      timeLabel: event.time.displayText,
      sortKey: saturatedTimelineSortKey(event.time.sortKey),
      worldSortKey: event.time.sortKey,
      sortOrder: startOrder + index,
      endSortKey: null,
      timePrecision:
        event.time.precision === "exact" ||
        event.time.precision === "approximate"
          ? event.time.precision
          : "exact",
      timeExpressions: [],
      periodId: null,
      scope:
        event.scale === "day" ||
        event.scale === "month" ||
        event.scale === "year"
          ? "story"
          : "universe",
      knowledgeScope: authority === "author-secret" ? "observer" : "public",
      narrativeOrder: null,
      title: event.title,
      kind: timelineKind(event),
      summary: event.summary,
      description: [
        `采纳语义：${authorityLabel(authority)}`,
        `推演来源：${run.name} / ${getActiveSimulationBranch(run).name}`,
        event.causeEventIds.length
          ? `推演因果：${event.causeEventIds.join("、")}`
          : "推演因果：当前分支起点",
        evidence ? `证据：\n${evidence}` : "",
        commands ? `状态提交：\n${commands}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      characterIds: uniqueExisting(event.characterIds, characterIds),
      locationIds: [],
      chapterIds: [],
      factionIds: uniqueExisting(event.factionIds, factionIds),
      itemIds: uniqueExisting(event.itemIds, itemIds),
      causeEventIds: [],
      stateChanges,
      foreshadowings: [],
      tags: ["世界推演", authorityLabel(authority)],
      createdAt: now,
      updatedAt: now,
    };
  });
  const currentFactsThrough = library.factsThroughEventId
    ? library.events.find((event) => event.id === library.factsThroughEventId) ?? null
    : null;
  const factsThroughEventId =
    authority === "actual"
      ? [currentFactsThrough, ...created]
          .filter((event): event is TimelineEvent => event !== null)
          .sort(compareTimelineEventsByWorldTime)
          .at(-1)?.id ?? null
      : library.factsThroughEventId;
  return {
    ...library,
    events: [...library.events, ...created],
    factsThroughEventId,
  };
}

function proposalChange(
  id: string,
  targetPath: string,
  summary: string,
  beforeContent: string,
  afterContent: string,
): AdoptionChange | null {
  if (beforeContent === afterContent) return null;
  return {
    id,
    targetPath,
    operation: "modify",
    summary,
    status: "pending",
    beforeContent,
    afterContent,
  };
}

export async function createWorldSimulationAdoptionProposal(
  storage: WorkbenchStorage,
  run: WorldSimulationRun,
  eventIds: readonly string[],
  authority: SimulationAdoptionAuthority,
): Promise<string> {
  const currentProjectId = await projectIdentity(storage);
  if (run.projectId !== currentProjectId)
    throw new Error("推演运行不属于当前小说项目");
  const selectedIds = new Set(eventIds);
  const branch = getActiveSimulationBranch(run);
  const events = branch.ledger.filter((event) => selectedIds.has(event.id));
  if (events.length === 0)
    throw new Error("请至少选择一个推演事件生成采纳提案");

  const characterRepository = createNovelCharacterLibraryRepository(storage);
  const factionRepository = createNovelFactionLibraryRepository(storage);
  const timelineRepository = createNovelTimelineLibraryRepository(storage);
  const [characters, factions, timeline] = await Promise.all([
    characterRepository.load(),
    factionRepository.load(),
    timelineRepository.load(),
  ]);
  const loadedCharacters = await Promise.all(
    characters.index.characters.map((entry) =>
      characterRepository.loadCharacter(entry),
    ),
  );
  const sourceCharacters = loadedCharacters.map((loaded) => loaded.record);
  const now = new Date().toISOString();
  // 未来计划和作者秘密只能进入时间线；它们没有发生，不得提前改写
  // 人物或势力的当前正式状态。
  const nextCharacters =
    authority === "actual"
      ? updateCharacters(sourceCharacters, run, events)
      : sourceCharacters;
  const nextFactions =
    authority === "actual"
      ? updateFactions(factions.library, run, events)
      : factions.library;
  const nextTimeline = createTimelineEvents(
    timeline.library,
    run,
    events,
    authority,
    now,
  );
  const characterChanges = nextCharacters.flatMap((character) => {
    const current = loadedCharacters.find(
      (loaded) => loaded.record.id === character.id,
    );
    if (!current) return [];
    const content = serializeCharacterLibraryFile({
      schemaVersion: 1,
      ...character,
    });
    if (JSON.stringify(character) === JSON.stringify(current.record)) return [];
    const entry = characters.index.characters.find(
      (candidate) => candidate.id === character.id,
    );
    if (!entry) return [];
    return [
      proposalChange(
        `change-character-${character.id}`,
        entry.recordPath,
        `同步角色“${character.name}”的生命、状态、修行阶段与物品持有候选`,
        current.content,
        content,
      ),
    ];
  });
  const changes = [
    ...characterChanges,
    proposalChange(
      "change-factions",
      FACTION_LIBRARY_PATH,
      "同步势力策略、生命周期、状态摘要与物品资源候选",
      factions.content,
      serializeFactionLibrary(nextFactions),
    ),
    proposalChange(
      "change-timeline",
      TIMELINE_LIBRARY_PATH,
      `将推演事件保存为${authorityLabel(authority)}`,
      timeline.content,
      serializeTimelineLibrary(nextTimeline),
    ),
  ].filter((change): change is AdoptionChange => Boolean(change));
  if (changes.length === 0)
    throw new Error("所选事件没有可写入正式资料的候选变化");

  const proposalId = `simulation-${run.id}-${Date.now().toString(36)}`;
  const manifest: AdoptionManifest = {
    schemaVersion: 2,
    proposalId,
    projectId: run.projectId,
    runId: run.id,
    branchId: branch.id,
    eventIds: events.map((event) => event.id),
    authority,
    title: `${events[0]!.title}${events.length > 1 ? `等 ${events.length} 个事件` : ""} · 采纳提案`,
    description: `来自“${run.name} / ${branch.name}”，拟保存为${authorityLabel(authority)}。推演结果仍需逐项审阅。`,
    createdAt: now,
    changes,
  };
  await storage.createText(
    manifestPath(proposalId),
    serialize(adoptionManifestSchema.parse(manifest)),
    { createParents: true },
  );
  return proposalId;
}

async function loadManifest(
  storage: WorkbenchStorage,
  proposalId: string,
): Promise<LoadedAdoptionManifest> {
  const path = manifestPath(proposalId);
  const file = await storage.readText(path);
  const value = parseManifest(path, file.content);
  if (value.proposalId !== proposalId)
    throw new Error("推演提案目录与 proposalId 不一致");
  const currentProjectId = await projectIdentity(storage);
  if (value.projectId !== currentProjectId)
    throw new Error("推演提案不属于当前小说项目");
  return { value, path, content: file.content };
}

async function writeManifest(
  storage: WorkbenchStorage,
  current: LoadedAdoptionManifest,
  value: AdoptionManifest,
): Promise<LoadedAdoptionManifest> {
  const content = serialize(adoptionManifestSchema.parse(value));
  const file = await storage.writeText(current.path, content, {
    expectedContent: current.content,
  });
  return {
    value: parseManifest(current.path, file.content),
    path: current.path,
    content: file.content,
  };
}

async function currentContent(
  storage: WorkbenchStorage,
  targetPath: string,
): Promise<string | null> {
  const [info] = await storage.stat([targetPath]);
  return info?.exists ? (await storage.readText(targetPath)).content : null;
}

async function materialize(
  storage: WorkbenchStorage,
  loaded: LoadedAdoptionManifest,
): Promise<FileProposal> {
  const changes: FileProposalChange[] = await Promise.all(
    loaded.value.changes.map(async (change) => {
      try {
        const current = await currentContent(storage, change.targetPath);
        return {
          ...change,
          currentContent: current,
          baseContentAvailable: true,
          conflict: current !== change.beforeContent,
          loadError: current === null ? "正式目标文件不存在" : null,
        };
      } catch (cause) {
        return {
          ...change,
          currentContent: null,
          baseContentAvailable: true,
          conflict: true,
          loadError: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );
  return {
    manifest: {
      proposalId: loaded.value.proposalId,
      title: loaded.value.title,
      description: loaded.value.description,
      createdAt: loaded.value.createdAt,
      changes: loaded.value.changes.map((change) => ({
        status: change.status,
      })),
    },
    changes,
  };
}

async function writeValidatedTarget(
  storage: WorkbenchStorage,
  targetPath: string,
  expectedContent: string,
  content: string,
): Promise<void> {
  if (targetPath.startsWith(`${CHARACTER_LIBRARY_PATHS.records}/`)) {
    const repository = createNovelCharacterLibraryRepository(storage);
    const current = await repository.load();
    const entry = current.index.characters.find(
      (candidate) => candidate.recordPath === targetPath,
    );
    if (!entry) throw new Error("人物记录在审阅期间已被删除，请重新加载提案");
    const loaded = await repository.loadCharacter(entry);
    if (loaded.content !== expectedContent)
      throw new Error("人物库在审阅期间发生变化，请重新加载提案");
    const { schemaVersion: _schemaVersion, ...record } = parseCharacterRecordFile(
      targetPath,
      content,
    );
    await repository.saveCharacter(current, record);
    return;
  }
  if (targetPath === FACTION_LIBRARY_PATH) {
    const repository = createNovelFactionLibraryRepository(storage);
    const current = await repository.load();
    if (current.content !== expectedContent)
      throw new Error("势力库在审阅期间发生变化，请重新加载提案");
    await repository.save(current, parseFactionLibrary(content));
    return;
  }
  if (targetPath === TIMELINE_LIBRARY_PATH) {
    const repository = createNovelTimelineLibraryRepository(storage);
    const current = await repository.load();
    if (current.content !== expectedContent)
      throw new Error("时间线在审阅期间发生变化，请重新加载提案");
    await repository.save(current, parseTimelineLibrary(content));
    return;
  }
  throw new Error(`推演提案不允许写入目标：${targetPath}`);
}

async function rollbackTarget(
  storage: WorkbenchStorage,
  change: AdoptionChange,
  appliedContent: string,
): Promise<void> {
  await storage.writeText(change.targetPath, change.beforeContent, {
    expectedContent: appliedContent,
  });
}

function updateStatuses(
  manifest: AdoptionManifest,
  ids: ReadonlySet<string>,
  status: AdoptionChange["status"],
): AdoptionManifest {
  return {
    ...manifest,
    changes: manifest.changes.map((change) =>
      ids.has(change.id) && change.status === "pending"
        ? { ...change, status }
        : change,
    ),
  };
}

export function createWorldSimulationAdoptionFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  return Object.freeze({
    async list() {
      const [directory] = await storage.stat([
        WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY,
      ]);
      if (!directory?.exists) return { proposals: [], errors: [] };
      if (directory.kind !== "directory")
        throw new Error("世界推演采纳提案路径不是目录");
      const entries = await storage.list(
        WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY,
      );
      const proposals: FileProposal[] = [];
      const errors: { proposalId: string; message: string }[] = [];
      for (const entry of entries) {
        if (entry.kind !== "directory") continue;
        try {
          proposals.push(
            await materialize(storage, await loadManifest(storage, entry.name)),
          );
        } catch (cause) {
          errors.push({
            proposalId: entry.name,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      proposals.sort((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt),
      );
      return { proposals, errors };
    },

    async deleteProposals(proposalIds: readonly string[]) {
      for (const proposalId of new Set(proposalIds)) {
        idSchema.parse(proposalId);
        await storage.remove(
          `${WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY}/${proposalId}`,
          { permanent: true },
        );
      }
    },

    async apply(proposalId: string, changeIds: readonly string[]) {
      const loaded = await loadManifest(storage, proposalId);
      const selectedIds = new Set(changeIds);
      const selected = loaded.value.changes.filter(
        (change) => change.status === "pending" && selectedIds.has(change.id),
      );
      if (selected.length === 0) throw new Error("没有可采纳的推演变化");
      const applied: { change: AdoptionChange; content: string }[] = [];
      try {
        for (const change of selected) {
          const current = await currentContent(storage, change.targetPath);
          if (current !== change.beforeContent)
            throw new Error(
              `${change.targetPath} 与生成基准不一致，请先解决冲突`,
            );
          await writeValidatedTarget(
            storage,
            change.targetPath,
            change.beforeContent,
            change.afterContent,
          );
          applied.push({ change, content: change.afterContent });
        }
        const saved = await writeManifest(
          storage,
          loaded,
          updateStatuses(
            loaded.value,
            new Set(selected.map((change) => change.id)),
            "applied",
          ),
        );
        return materialize(storage, saved);
      } catch (cause) {
        for (const item of applied.reverse()) {
          await rollbackTarget(storage, item.change, item.content);
        }
        throw cause;
      }
    },

    async reject(proposalId: string, changeIds: readonly string[]) {
      const loaded = await loadManifest(storage, proposalId);
      const selectedIds = new Set(changeIds);
      if (
        !loaded.value.changes.some(
          (change) => change.status === "pending" && selectedIds.has(change.id),
        )
      )
        throw new Error("没有可拒绝的推演变化");
      return materialize(
        storage,
        await writeManifest(
          storage,
          loaded,
          updateStatuses(loaded.value, selectedIds, "rejected"),
        ),
      );
    },

    async delete(proposalId: string, changeIds: readonly string[]) {
      const loaded = await loadManifest(storage, proposalId);
      const selectedIds = new Set(changeIds);
      const changes = loaded.value.changes.filter(
        (change) => !selectedIds.has(change.id),
      );
      if (changes.length === loaded.value.changes.length)
        throw new Error("没有可删除的推演变化");
      if (changes.length === 0) {
        await storage.remove(
          `${WORLD_SIMULATION_ADOPTION_PROPOSALS_DIRECTORY}/${proposalId}`,
          { permanent: true },
        );
        return null;
      }
      return materialize(
        storage,
        await writeManifest(storage, loaded, { ...loaded.value, changes }),
      );
    },

    async resolveConflict(
      proposalId: string,
      changeId: string,
      resolution: FileProposalConflictResolution,
    ) {
      const loaded = await loadManifest(storage, proposalId);
      const change = loaded.value.changes.find(
        (item) => item.id === changeId && item.status === "pending",
      );
      if (!change) throw new Error("待解决的推演变化不存在");
      const current = await currentContent(storage, change.targetPath);
      if (current !== resolution.expectedCurrentContent)
        throw new Error("正式内容在冲突审阅期间再次变化，请重新加载");
      if (current === null)
        throw new Error("正式目标文件不存在，不能覆盖或合并");
      const content =
        resolution.strategy === "merge"
          ? resolution.content
          : change.afterContent;
      await writeValidatedTarget(storage, change.targetPath, current, content);
      try {
        const nextManifest = {
          ...loaded.value,
          changes: loaded.value.changes.map((item) =>
            item.id === change.id
              ? {
                  ...item,
                  status: "applied" as const,
                  beforeContent: current,
                  afterContent: content,
                }
              : item,
          ),
        };
        return materialize(
          storage,
          await writeManifest(storage, loaded, nextManifest),
        );
      } catch (cause) {
        await storage.writeText(change.targetPath, current, {
          expectedContent: content,
        });
        throw cause;
      }
    },
  });
}
