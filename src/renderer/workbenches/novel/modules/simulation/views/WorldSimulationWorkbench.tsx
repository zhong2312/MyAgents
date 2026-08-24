import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Ellipsis,
  Info,
  Loader2,
  Play,
  Plus,
  Route,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CustomSelect,
  type SelectOption,
  type WorkbenchAiRunProgress,
  type WorkbenchNavigationGuard,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  advanceSimulationRun,
  formatSimulationSpan,
  formatSimulationTime,
  simulationScaleDays,
  type SimulationBaselineChapterSnapshot,
  type SimulationCharacterSnapshot,
  type SimulationEngineInputs,
  type SimulationFactionSnapshot,
  type SimulationLocationSnapshot,
  type SimulationTimelineSnapshot,
} from "../business/simulationEngine";
import {
  buildSimulationAiPrompt,
  buildSimulationAiRepairPrompt,
  createSimulationAiInput,
  projectSimulationAiEvents,
  SimulationAiFormatError,
  SimulationAiJsonParseError,
  SimulationAiNoContentError,
} from "../business/simulationAiProjection";
import {
  createNovelSimulationRepository,
  type LoadedSimulationLibrary,
} from "../data-access/simulationRepository";
import {
  SIMULATION_DEFAULT_AI_TIMEOUT_MINUTES as DEFAULT_AI_TIMEOUT_MINUTES,
  SIMULATION_MAX_AI_TIMEOUT_MINUTES,
  SIMULATION_MIN_AI_TIMEOUT_MINUTES,
} from "../entities/simulationSchema";
import type {
  SimulationBaselineMode,
  SimulationEvent,
  SimulationObservationTarget,
  SimulationRound,
  SimulationRun,
  SimulationTimeScale,
} from "../entities/simulationSchema";
import { parseNovelChapterIndex } from "../../project/entities/projectSchema";
import "./WorldSimulationWorkbench.css";

interface WorldSimulationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly registerNavigationGuard?: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
  readonly onAiRun?: (request: SimulationAiRunRequest) => Promise<string>;
  readonly onCancelAiRun?: (runId: string) => Promise<void>;
}

export interface SimulationAiRunRequest {
  readonly sceneId: "simulation.advance";
  readonly runId: string;
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly executionProfile: "standard" | "extended";
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly streamOutput: boolean;
  readonly usesNovelContextTools: boolean;
  readonly onProgress?: (progress: WorkbenchAiRunProgress) => void;
}

class SimulationAiRunCancelledError extends Error {
  constructor() {
    super("本次世界推演已取消");
  }
}

interface SimulationSourceInputs extends SimulationEngineInputs {
  readonly sourceHash: string;
  readonly baselineLabel: string;
  readonly chapters: readonly SimulationChapterOption[];
}

interface SimulationChapterOption {
  readonly id: string;
  readonly displayNumber: number;
  readonly title: string;
  readonly path: string;
}

type SimulationTargetCandidate = SimulationObservationTarget & {
  readonly search: string;
};

type InspectorType = "characters" | "factions" | "regions" | "world";
type MobilePanel = "timeline" | "stage" | "inspector";

const SIMULATION_AI_FORMAT_TIMEOUT_MS = 60_000;

const TIME_UNIT_OPTIONS: readonly SelectOption[] = [
  { value: "day", label: "天" },
  { value: "month", label: "月" },
  { value: "year", label: "年" },
  { value: "ten-thousand-year", label: "万年" },
  { value: "ten-million-year", label: "千万年" },
  { value: "hundred-million-year", label: "亿年" },
];

const AI_TIMEOUT_OPTIONS: readonly SelectOption[] = Array.from(
  {
    length:
      SIMULATION_MAX_AI_TIMEOUT_MINUTES - SIMULATION_MIN_AI_TIMEOUT_MINUTES + 1,
  },
  (_, index) => {
    const minutes = SIMULATION_MIN_AI_TIMEOUT_MINUTES + index;
    return { value: String(minutes), label: `${minutes} 分钟` };
  },
);

function aiTimeoutMinutes(run: SimulationRun): number {
  return run.aiTimeoutMinutes ?? DEFAULT_AI_TIMEOUT_MINUTES;
}

function durationAmount(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(10_000, Math.max(1, Math.floor(parsed)));
}

function runHorizonLabel(run: SimulationRun): string {
  return run.endTimeAmount && run.endTimeUnit
    ? formatSimulationSpan(run.endTimeUnit, run.endTimeAmount)
    : formatSimulationTime(run.endTime);
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function optionalText(
  storage: WorkbenchStorage,
  path: string,
): Promise<string> {
  const [entry] = await storage.stat([path]);
  return entry?.exists && entry.kind === "file"
    ? (await storage.readText(path)).content
    : "";
}

function parseObject(content: string, path: string): Record<string, unknown> {
  if (!content) return {};
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} 必须是 JSON 对象`);
    }
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `${path} 读取失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function timelineTimeValue(value: unknown): number | null {
  if (typeof value === "number") return numberValue(value);
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function namedStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === "string" && item.trim()) return [item.trim()];
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const label = stringValue(record.name ?? record.label ?? record.id);
        return label ? [label] : [];
      })
    : [];
}

async function readSimulationInputs(
  storage: WorkbenchStorage,
): Promise<SimulationSourceInputs> {
  const paths = [
    "characters/index.json",
    "world/factions/index.json",
    "world/locations/index.json",
    "timeline/index.json",
    "world/setting-library/spatial-tree.json",
    "manuscript/index.json",
    "timeline/events.json",
  ] as const;
  const contents = await Promise.all(
    paths.map((path) => optionalText(storage, path)),
  );
  const characterIndex = parseObject(contents[0], paths[0]);
  const factionIndex = parseObject(contents[1], paths[1]);
  const locationIndex = parseObject(contents[2], paths[2]);
  const timelineIndex = parseObject(contents[3], paths[3]);
  const characterEntries = Array.isArray(characterIndex.characters)
    ? characterIndex.characters
    : [];
  const factionEntries = Array.isArray(factionIndex.factions)
    ? factionIndex.factions
    : [];
  const locationEntries = Array.isArray(locationIndex.locations)
    ? locationIndex.locations
    : [];
  const aggregateTimeline = parseObject(contents[6], paths[6]);
  const indexedTimelineEntries = Array.isArray(timelineIndex.events)
    ? timelineIndex.events
    : [];
  const aggregateTimelineEntries = Array.isArray(aggregateTimeline.events)
    ? aggregateTimeline.events
    : [];
  const recordPaths = [
    ...characterEntries.map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).recordPath
        : null,
    ),
    ...factionEntries.map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).path
        : null,
    ),
    ...locationEntries.map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).path
        : null,
    ),
    ...indexedTimelineEntries.map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).path
        : null,
    ),
  ].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  const recordContents = await Promise.all(
    recordPaths.map((path) => optionalText(storage, path)),
  );
  const records = new Map(
    recordPaths.map((path, index) => [
      path,
      parseObject(recordContents[index] ?? "", path),
    ]),
  );
  const characters: SimulationCharacterSnapshot[] = characterEntries.flatMap(
    (entry) => {
      if (!entry || typeof entry !== "object") return [];
      const indexEntry = entry as Record<string, unknown>;
      const id = stringValue(indexEntry.id);
      if (!id) return [];
      // 新版索引只保留摘要和 recordPath；旧版项目则把完整记录直接内嵌
      // 在 index.json。两种来源必须合并，独立记录优先覆盖旧摘要字段。
      const record = {
        ...indexEntry,
        ...(records.get(stringValue(indexEntry.recordPath)) ?? {}),
      };
      return [
        {
          id,
          name: stringValue(record?.name, stringValue(indexEntry.name, id)),
          currentLocationId:
            stringValue(record?.currentLocationId ?? record?.locationId, "") ||
            null,
          currentLocationLabel:
            stringValue(record?.currentLocation, "") || null,
          status: stringValue(record?.status, ""),
          age: stringValue(record?.age, ""),
          baseLifespan: stringValue(record?.baseLifespan, ""),
          goals: stringValue(record?.goals, ""),
          motivation: stringValue(record?.motivation, ""),
          factionId: stringValue(record?.factionId, "") || null,
          resources: namedStringList(record?.inventory),
          nextActionTime: numberValue(
            record?.nextActionTime ?? record?.actionCompletesAt,
          ),
          nextActionLabel:
            stringValue(record?.nextActionLabel ?? record?.currentAction, "") ||
            null,
          alive: record?.alive !== false && record?.status !== "dead",
        },
      ];
    },
  );
  const factions: SimulationFactionSnapshot[] = factionEntries.flatMap(
    (entry) => {
      if (!entry || typeof entry !== "object") return [];
      const indexEntry = entry as Record<string, unknown>;
      const id = stringValue(indexEntry.id);
      if (!id) return [];
      const record = {
        ...indexEntry,
        ...(records.get(stringValue(indexEntry.path)) ?? {}),
      };
      const territories = Array.isArray(record?.territories)
        ? record.territories
        : [];
      return [
        {
          id,
          name: stringValue(record?.name, stringValue(indexEntry.name, id)),
          status: stringValue(record?.status, ""),
          summary: stringValue(record?.summary, ""),
          territoryIds: territories
            .flatMap((item) =>
              item && typeof item === "object"
                ? [stringValue((item as Record<string, unknown>).worldNodeId)]
                : [],
            )
            .filter(Boolean),
          territoryLabels: territories
            .flatMap((item) =>
              item && typeof item === "object"
                ? [stringValue((item as Record<string, unknown>).name)]
                : [],
            )
            .filter(Boolean),
          resources: Array.isArray(record?.resources)
            ? record.resources
                .flatMap((item) =>
                  item && typeof item === "object"
                    ? [stringValue((item as Record<string, unknown>).name)]
                    : [],
                )
                .filter(Boolean)
            : [],
          strategy: stringValue(
            record?.strategy ?? record?.currentStrategy,
            "",
          ),
          nextActionTime: numberValue(
            record?.nextActionTime ?? record?.decisionDueAt,
          ),
          nextActionLabel:
            stringValue(record?.nextActionLabel ?? record?.currentAction, "") ||
            null,
          alive: record?.alive !== false && record?.status !== "dissolved",
        },
      ];
    },
  );
  const locations: SimulationLocationSnapshot[] = locationEntries.flatMap(
    (entry) => {
      if (!entry || typeof entry !== "object") return [];
      const indexEntry = entry as Record<string, unknown>;
      const id = stringValue(indexEntry.id);
      if (!id) return [];
      const record = {
        ...indexEntry,
        ...(records.get(stringValue(indexEntry.path)) ?? {}),
      };
      return [
        {
          id,
          name: stringValue(record?.name, stringValue(indexEntry.name, id)),
          parentId: stringValue(record?.parentLocationId, "") || null,
          nodeId: stringValue(record?.nodeId, "") || null,
        },
      ];
    },
  );
  const timelineCandidates = [
    ...indexedTimelineEntries,
    ...aggregateTimelineEntries,
  ];
  const seenTimelineIds = new Set<string>();
  const timelineEvents: SimulationTimelineSnapshot[] =
    timelineCandidates.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const indexEntry = entry as Record<string, unknown>;
      const item = {
        ...indexEntry,
        ...(records.get(stringValue(indexEntry.path)) ?? {}),
      };
      const id = stringValue(item.id);
      if (!id || seenTimelineIds.has(id)) return [];
      seenTimelineIds.add(id);
      return id
        ? [
            {
              id,
              title: stringValue(item.title, id),
              summary: stringValue(item.summary, ""),
              timeLabel: stringValue(item.timeLabel, ""),
              time: timelineTimeValue(
                item.time ??
                  item.worldTime ??
                  item.sortKey ??
                  item.worldSortKey,
              ),
              characterIds: stringList(item.characterIds),
              factionIds: stringList(item.factionIds),
              locationIds: stringList(item.locationIds),
            },
          ]
        : [];
    });
  const factsThroughEventId = stringValue(
    timelineIndex.factsThroughEventId,
    "",
  );
  const baselineEvent = timelineEvents.find(
    (event) => event.id === factsThroughEventId,
  );
  let spatial: {
    nodes?: readonly { id: string; name: string; parentId: string | null }[];
  } | null = null;
  if (contents[4]) {
    try {
      spatial = JSON.parse(contents[4]) as {
        nodes?: readonly {
          id: string;
          name: string;
          parentId: string | null;
        }[];
      };
    } catch (cause) {
      throw new Error(
        `空间树读取失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const root = spatial?.nodes?.find((node) => node.parentId === null);
  const diagnostics: string[] = [
    ...(characters.length === 0 && characterEntries.length > 0
      ? ["人物索引存在，但没有可用稳定 ID"]
      : []),
    ...(factions.length === 0 && factionEntries.length > 0
      ? ["势力索引存在，但没有可用稳定 ID"]
      : []),
    ...(locations.length === 0 && locationEntries.length > 0
      ? ["地点索引存在，但没有可用稳定 ID"]
      : []),
  ];
  let chapters: SimulationChapterOption[] = [];
  if (contents[5]) {
    try {
      const chapterIndex = parseNovelChapterIndex(contents[5]);
      chapters = chapterIndex.chapters
        .map((chapter) => ({
          id: chapter.id,
          displayNumber: chapter.displayNumber,
          title: chapter.title,
          path: chapter.path,
        }))
        .sort((left, right) => left.displayNumber - right.displayNumber);
    } catch (cause) {
      diagnostics.push(
        `章节索引读取失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return {
    characterCount: characters.length,
    factionCount: factions.length,
    locationCount: locations.length,
    timelineEventCount: timelineEvents.length,
    observationSpaceId: root?.id ?? null,
    observationSpaceLabel: root?.name ?? "当前世界范围",
    baselineLabel: baselineEvent
      ? `正式时间线至“${baselineEvent.title}”`
      : "当前正式时间线",
    characters,
    factions,
    locations,
    timelineEvents,
    diagnostics,
    chapters,
    sourceHash: hashText(
      [
        ...paths.map((path, index) => `${path}:${contents[index]}`),
        ...recordPaths.map((path, index) => `${path}:${recordContents[index]}`),
      ].join("\n"),
    ),
  };
}

function baselineModeLabel(
  mode: SimulationBaselineMode,
  chapter?: SimulationChapterOption | null,
): string {
  if (mode === "timeline-current") return "当前正式时间线";
  if (!chapter) return "章节基线（未选择章节）";
  const chapterLabel = `第 ${chapter.displayNumber} 章 · ${chapter.title}`;
  return mode === "after-chapter"
    ? `从${chapterLabel}之后继续`
    : mode === "before-chapter"
      ? `从${chapterLabel}之前重演`
      : `从${chapterLabel}处分支`;
}

function buildBaselineSourceHash(
  source: SimulationSourceInputs,
  mode: SimulationBaselineMode,
  chapter: SimulationBaselineChapterSnapshot | null,
): string {
  if (mode === "timeline-current") return source.sourceHash;
  if (!chapter) throw new Error("请选择有效章节作为推演起点");
  return hashText(
    [
      source.sourceHash,
      `baseline-mode:${mode}`,
      `chapter:${chapter.id}`,
      `chapter-path:${chapter.path}`,
      `chapter-content:${chapter.content}`,
    ].join("\n"),
  );
}

async function loadBaselineChapter(
  storage: WorkbenchStorage,
  source: SimulationSourceInputs,
  chapterId: string | null | undefined,
): Promise<SimulationBaselineChapterSnapshot | null> {
  if (!chapterId) return null;
  const chapter = source.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw new Error("所选章节不存在，请重新选择章节");
  const [entry] = await storage.stat([chapter.path]);
  if (!entry?.exists || entry.kind !== "file") {
    throw new Error(
      `第 ${chapter.displayNumber} 章正文不存在，无法作为推演起点`,
    );
  }
  return {
    ...chapter,
    content: (await storage.readText(chapter.path)).content,
  };
}

function scopeSimulationSource(
  source: SimulationSourceInputs,
  targets: readonly SimulationObservationTarget[] | undefined,
): SimulationSourceInputs {
  if (!targets?.length) return source;
  const characterIds = new Set(
    targets
      .filter((target) => target.type === "character")
      .map((target) => target.id),
  );
  const factionIds = new Set(
    targets
      .filter((target) => target.type === "faction")
      .map((target) => target.id),
  );
  const characters = (source.characters ?? []).filter((item) =>
    characterIds.has(item.id),
  );
  const factions = (source.factions ?? []).filter((item) =>
    factionIds.has(item.id),
  );
  const locationIds = new Set<string>([
    ...characters.flatMap((item) =>
      item.currentLocationId ? [item.currentLocationId] : [],
    ),
    ...factions.flatMap((item) => item.territoryIds ?? []),
    ...(source.observationSpaceId ? [source.observationSpaceId] : []),
  ]);
  const locations = (source.locations ?? []).filter((item) =>
    locationIds.has(item.id),
  );
  const timelineEvents = (source.timelineEvents ?? []).filter(
    (event) =>
      (event.characterIds ?? []).some((id) => characterIds.has(id)) ||
      (event.factionIds ?? []).some((id) => factionIds.has(id)) ||
      (event.locationIds ?? []).some((id) => locationIds.has(id)),
  );
  return {
    ...source,
    characterCount: characters.length,
    factionCount: factions.length,
    locationCount: locations.length,
    timelineEventCount: timelineEvents.length,
    characters,
    factions,
    locations,
    timelineEvents,
  };
}

function statusLabel(run: SimulationRun): string {
  return {
    draft: "草稿",
    ready: "运行已就绪",
    running: "AI 正在生成",
    paused: "已暂停",
    completed: "已完成",
    error: "异常",
  }[run.status];
}

function eventLabel(event: SimulationEvent): string {
  return {
    "world-process": "世界过程",
    "character-action": "人物行动",
    "faction-strategy": "势力策略",
    "life-cycle": "代际变化",
    propagation: "传播",
    resource: "资源",
    diagnostic: "诊断",
  }[event.kind];
}

function certaintyLabel(event: SimulationEvent): string {
  return {
    confirmed: "AI 推演",
    inferred: "AI 状态推演",
    uncertain: "AI 待确认",
    blocked: "AI 待补充",
    aggregated: "AI 尺度聚合",
  }[event.certainty];
}

function boundaryLabel(
  kind: NonNullable<SimulationRound["boundary"]>["kind"],
): string {
  return {
    "action-complete": "行动完成",
    "message-arrival": "消息到达",
    "resource-node": "资源或势力周期",
    cycle: "世界周期",
    "timeline-fact": "正式时间线事实",
    "scale-limit": "尺度上限",
    "run-end": "运行终点",
  }[kind];
}

function narrativeFromEvents(
  events: readonly SimulationEvent[],
  round: { readonly startTime: number; readonly endTime: number },
): string {
  const storyEvents = events.filter((event) => event.kind !== "diagnostic");
  if (!storyEvents.length) {
    return `这一轮从${formatSimulationTime(round.startTime)}推进到${formatSimulationTime(round.endTime)}。没有足够的结构化事实支持新的故事，世界保持在观察状态。`;
  }
  return storyEvents
    .map((event) => event.summary.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** 时间调度只负责边界和约束事实，故事内容只展示 AI 投影结果。 */
function isAiProjectionEvent(event: SimulationEvent): boolean {
  return event.source !== "rule" && event.source !== "system";
}

function eventGroup(
  event: SimulationEvent | undefined,
): "world" | "characters" | "factions" | "life" {
  if (!event) return "world";
  if (event.kind === "character-action") return "characters";
  if (event.kind === "faction-strategy" || event.kind === "resource")
    return "factions";
  if (event.kind === "life-cycle") return "life";
  return "world";
}

function choicesFor(
  event: SimulationEvent | undefined,
): readonly { id: string; label: string; detail: string }[] {
  if (!event)
    return [
      {
        id: "wait",
        label: "等待下一轮",
        detail: "保持观察，交给世界过程继续演化。",
      },
    ];
  if (event.kind === "faction-strategy" || event.kind === "resource")
    return [
      {
        id: "observe",
        label: "旁观局势",
        detail: "不做干预，记录势力策略的自然后果。",
      },
      {
        id: "negotiate",
        label: "发起会商",
        detail: "把当前冲突转为立场会商候选。",
      },
      {
        id: "counter",
        label: "准备反制",
        detail: "为下一轮建立一个可审阅的反制方案。",
      },
    ];
  if (event.kind === "character-action" || event.kind === "life-cycle")
    return [
      {
        id: "follow",
        label: "跟随行动",
        detail: "沿人物当前意图继续观察，不改变其选择。",
      },
      {
        id: "hint",
        label: "投递线索",
        detail: "提供一条作者候选线索，等待后续 AI 推演。",
      },
      {
        id: "hold",
        label: "保持沉默",
        detail: "不介入人物知识边界，让误判自然发生。",
      },
    ];
  return [
    {
      id: "study",
      label: "继续观测",
      detail: "记录世界过程，让影响在下一轮自然扩散。",
    },
    {
      id: "guard",
      label: "设置护栏",
      detail: "创建一条需要作者确认的 AI 推演护栏。",
    },
    {
      id: "branch",
      label: "创建分支",
      detail: "从这个时间点保存一个对照假设。",
    },
  ];
}

function SetupForm({
  projectTitle,
  source,
  onCreate,
  onCancel,
  isCreating,
  modal = false,
}: {
  readonly projectTitle: string;
  readonly source: SimulationSourceInputs | null;
  readonly onCreate: (input: {
    name: string;
    endUnit: SimulationTimeScale;
    endAmount: number;
    roundUnit: SimulationTimeScale;
    roundAmount: number;
    baselineMode: SimulationBaselineMode;
    baselineChapterId: string | null;
    observationTargets: readonly SimulationObservationTarget[];
  }) => Promise<void>;
  readonly onCancel?: () => void;
  readonly isCreating: boolean;
  readonly modal?: boolean;
}) {
  const [name, setName] = useState("北境灵脉演化");
  const [endAmount, setEndAmount] = useState("12");
  const [endUnit, setEndUnit] = useState<SimulationTimeScale>("year");
  const [roundAmount, setRoundAmount] = useState("1");
  const [roundUnit, setRoundUnit] = useState<SimulationTimeScale>("month");
  const [baselineMode, setBaselineMode] =
    useState<SimulationBaselineMode>("timeline-current");
  const [baselineChapterId, setBaselineChapterId] = useState<string | null>(
    null,
  );
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [targetKind, setTargetKind] = useState<"all" | "character" | "faction">(
    "all",
  );
  const [targetQuery, setTargetQuery] = useState("");
  const [observationTargets, setObservationTargets] = useState<
    SimulationObservationTarget[]
  >([]);
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false);
  const [chapterQuery, setChapterQuery] = useState("");
  const [chapterJump, setChapterJump] = useState("");
  const normalizedEndAmount = durationAmount(endAmount, 12);
  const normalizedRoundAmount = durationAmount(roundAmount, 1);
  const targetCandidates = useMemo<SimulationTargetCandidate[]>(() => {
    if (!source) return [];
    return [
      ...(source.characters ?? []).map((character) => ({
        type: "character" as const,
        id: character.id,
        label: character.name,
        search: [
          character.name,
          character.id,
          character.status,
          character.currentLocationLabel,
          character.goals,
        ]
          .filter(Boolean)
          .join(" "),
      })),
      ...(source.factions ?? []).map((faction) => ({
        type: "faction" as const,
        id: faction.id,
        label: faction.name,
        search: [
          faction.name,
          faction.id,
          faction.status,
          faction.summary,
          ...(faction.territoryLabels ?? []),
        ]
          .filter(Boolean)
          .join(" "),
      })),
    ];
  }, [source]);
  const filteredTargetCandidates = useMemo(() => {
    const query = targetQuery.trim().toLocaleLowerCase();
    return targetCandidates
      .filter(
        (candidate) => targetKind === "all" || candidate.type === targetKind,
      )
      .filter(
        (candidate) =>
          !query || candidate.search.toLocaleLowerCase().includes(query),
      )
      .slice(0, 50);
  }, [targetCandidates, targetKind, targetQuery]);
  const selectedTargetKey = (target: SimulationObservationTarget) =>
    `${target.type}:${target.id}`;
  const toObservationTarget = (
    target: SimulationTargetCandidate,
  ): SimulationObservationTarget => ({
    type: target.type,
    id: target.id,
    label: target.label,
  });
  const selectedChapter = source?.chapters.find(
    (chapter) => chapter.id === baselineChapterId,
  );
  const filteredChapters = useMemo(() => {
    if (!source) return [];
    const query = chapterQuery.trim().toLocaleLowerCase();
    const jump = Number(chapterJump);
    return source.chapters
      .filter((chapter) => {
        if (
          Number.isInteger(jump) &&
          jump > 0 &&
          chapter.displayNumber === jump
        )
          return true;
        return (
          !query ||
          String(chapter.displayNumber).includes(query) ||
          chapter.title.toLocaleLowerCase().includes(query)
        );
      })
      .slice(0, 50);
  }, [chapterJump, chapterQuery, source]);
  return (
    <section className="ws-setup-panel">
      <div className="ws-panel-head">
        <div>
          <h2>{modal ? "新建推演" : "建立一个可复现的世界运行"}</h2>
          <p>
            {modal
              ? "创建后会按当前资料自动建立基线，并直接进入文字舞台。"
              : "从当前正式资料建立基线，按时间边界观察人物、势力与世界过程。"}
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            className="ws-btn ws-btn-icon"
            aria-label="关闭推演设置"
            title="关闭"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="ws-form-section">
        <h3>基本信息</h3>
        <div className="ws-field-grid">
          <div className="ws-field ws-field-full">
            <label htmlFor={`${modal ? "modal-" : ""}simulation-name`}>
              推演名称
            </label>
            <input
              id={`${modal ? "modal-" : ""}simulation-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="ws-form-section">
        <h3>时间与轮次</h3>
        <div className="ws-field-grid">
          <div className="ws-field">
            <label>总推演范围</label>
            <div className="ws-duration-control">
              <input
                type="number"
                min={1}
                max={10_000}
                step={1}
                inputMode="numeric"
                aria-label="总推演范围数值"
                value={endAmount}
                onChange={(event) => setEndAmount(event.target.value)}
              />
              <CustomSelect
                className="ws-duration-unit"
                value={endUnit}
                options={[...TIME_UNIT_OPTIONS]}
                onChange={(value) => setEndUnit(value as SimulationTimeScale)}
                ariaLabel="总推演范围单位"
                size="md"
              />
            </div>
          </div>
          <div className="ws-field">
            <label>每轮时间跨度</label>
            <div className="ws-duration-control">
              <input
                type="number"
                min={1}
                max={10_000}
                step={1}
                inputMode="numeric"
                aria-label="每轮时间跨度数值"
                value={roundAmount}
                onChange={(event) => setRoundAmount(event.target.value)}
              />
              <CustomSelect
                className="ws-duration-unit"
                value={roundUnit}
                options={[...TIME_UNIT_OPTIONS]}
                onChange={(value) => setRoundUnit(value as SimulationTimeScale)}
                ariaLabel="每轮时间跨度单位"
                size="md"
              />
            </div>
          </div>
          <div className="ws-field ws-field-full">
            <span className="ws-field-help">
              数值和单位分别设置。调度器会在每轮跨度内寻找行动完成、消息到达、资源和世界周期等更早的有效边界。
            </span>
          </div>
        </div>
      </div>
      <div className="ws-form-section">
        <h3>观察对象</h3>
        <div className="ws-picker-field">
          <button
            type="button"
            className="ws-picker-trigger"
            aria-expanded={targetPickerOpen}
            onClick={() => setTargetPickerOpen((open) => !open)}
          >
            <span>
              <strong>
                {observationTargets.length
                  ? `已选择 ${observationTargets.length} 个主体`
                  : "全部人物与势力"}
              </strong>
              <small>
                {observationTargets.length
                  ? observationTargets
                      .slice(0, 3)
                      .map((target) => target.label)
                      .join("、") + (observationTargets.length > 3 ? " 等" : "")
                  : "不筛选主体，按世界切片观察"}
              </small>
            </span>
            {targetPickerOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {targetPickerOpen && (
            <div className="ws-picker-panel">
              <div className="ws-picker-toolbar">
                <input
                  value={targetQuery}
                  onChange={(event) => setTargetQuery(event.target.value)}
                  placeholder="搜索姓名、ID、地点或状态"
                  aria-label="搜索观察对象"
                />
                <span>
                  {targetCandidates.length.toLocaleString("zh-CN")} 个候选
                </span>
              </div>
              <div
                className="ws-picker-tabs"
                role="tablist"
                aria-label="观察对象类型"
              >
                {(["all", "character", "faction"] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    role="tab"
                    aria-selected={targetKind === kind}
                    className={
                      targetKind === kind
                        ? "ws-picker-tab ws-picker-tab-active"
                        : "ws-picker-tab"
                    }
                    onClick={() => setTargetKind(kind)}
                  >
                    {kind === "all"
                      ? "全部"
                      : kind === "character"
                        ? "人物"
                        : "势力"}
                  </button>
                ))}
                <button
                  type="button"
                  className="ws-picker-action"
                  onClick={() => {
                    setObservationTargets([]);
                  }}
                >
                  清空选择
                </button>
              </div>
              <div className="ws-picker-result-head">
                <span>
                  显示前 {filteredTargetCandidates.length} 条
                  {targetCandidates.length > 50
                    ? "，搜索或切换类型继续定位"
                    : ""}
                </span>
                <button
                  type="button"
                  className="ws-picker-action"
                  onClick={() => {
                    setObservationTargets((current) => {
                      const next = new Map(
                        current.map((target) => [
                          selectedTargetKey(target),
                          target,
                        ]),
                      );
                      filteredTargetCandidates.forEach((candidate) => {
                        if (next.size < 64) {
                          next.set(
                            selectedTargetKey(candidate),
                            toObservationTarget(candidate),
                          );
                        }
                      });
                      return [...next.values()];
                    });
                  }}
                >
                  选择当前结果
                </button>
              </div>
              <div className="ws-picker-list">
                {filteredTargetCandidates.map((candidate) => {
                  const checked = observationTargets.some(
                    (target) =>
                      selectedTargetKey(target) ===
                      selectedTargetKey(candidate),
                  );
                  return (
                    <label
                      className="ws-picker-row"
                      key={selectedTargetKey(candidate)}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          setObservationTargets((current) => {
                            const next = current.filter(
                              (target) =>
                                selectedTargetKey(target) !==
                                selectedTargetKey(candidate),
                            );
                            if (event.target.checked) {
                              if (current.length >= 64) return current;
                              next.push(toObservationTarget(candidate));
                            }
                            return next;
                          });
                        }}
                      />
                      <span>
                        <strong>{candidate.label}</strong>
                        <small>
                          {candidate.type === "character" ? "人物" : "势力"} ·{" "}
                          {candidate.id}
                        </small>
                      </span>
                    </label>
                  );
                })}
                {!filteredTargetCandidates.length && (
                  <span className="ws-picker-empty">没有匹配的主体</span>
                )}
              </div>
              <small className="ws-picker-help">
                最多选择 64 个主体，已选择项会保留在搜索结果之外。
              </small>
            </div>
          )}
        </div>
      </div>
      <div className="ws-form-section">
        <h3>章节起点</h3>
        <div className="ws-field-grid">
          <div className="ws-field">
            <label>基线方式</label>
            <CustomSelect
              value={baselineMode}
              options={[
                { value: "timeline-current", label: "当前正式时间线" },
                { value: "after-chapter", label: "从章节后继续" },
                { value: "before-chapter", label: "从章节前重演" },
                { value: "branch-from-chapter", label: "从章节处分支" },
              ]}
              onChange={(value) => {
                const next = value as SimulationBaselineMode;
                setBaselineMode(next);
                if (next === "timeline-current") setBaselineChapterId(null);
              }}
              ariaLabel="章节基线方式"
              size="md"
            />
          </div>
          <div className="ws-field">
            <span className="ws-field-help">
              章节正文只作为可追溯起点上下文，不会把章节计划自动写入正式时间线。
            </span>
          </div>
          {baselineMode !== "timeline-current" && (
            <div className="ws-field ws-field-full">
              <label>选择章节</label>
              <button
                type="button"
                className="ws-picker-trigger"
                aria-expanded={chapterPickerOpen}
                onClick={() => setChapterPickerOpen((open) => !open)}
              >
                <span>
                  <strong>
                    {selectedChapter
                      ? `第 ${selectedChapter.displayNumber} 章 · ${selectedChapter.title}`
                      : "请选择章节"}
                  </strong>
                  <small>
                    {source?.chapters.length.toLocaleString("zh-CN") ?? 0}{" "}
                    章可选 · 支持编号直达
                  </small>
                </span>
                {chapterPickerOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              {chapterPickerOpen && (
                <div className="ws-picker-panel">
                  <div className="ws-picker-toolbar ws-chapter-toolbar">
                    <input
                      type="number"
                      min={1}
                      value={chapterJump}
                      onChange={(event) => setChapterJump(event.target.value)}
                      placeholder="输入章节编号直达"
                      aria-label="章节编号直达"
                    />
                    <input
                      value={chapterQuery}
                      onChange={(event) => setChapterQuery(event.target.value)}
                      placeholder="或搜索章节标题"
                      aria-label="搜索章节标题"
                    />
                  </div>
                  <div className="ws-picker-result-head">
                    <span>
                      显示前 {filteredChapters.length} 条
                      {source && source.chapters.length > 50
                        ? "，输入编号或关键词继续定位"
                        : ""}
                    </span>
                  </div>
                  <div className="ws-picker-list ws-chapter-list">
                    {filteredChapters.map((chapter) => (
                      <button
                        type="button"
                        key={chapter.id}
                        className={
                          chapter.id === baselineChapterId
                            ? "ws-picker-row ws-picker-row-button ws-picker-row-active"
                            : "ws-picker-row ws-picker-row-button"
                        }
                        onClick={() => {
                          setBaselineChapterId(chapter.id);
                          setChapterPickerOpen(false);
                        }}
                      >
                        <strong>第 {chapter.displayNumber} 章</strong>
                        <span>{chapter.title}</span>
                      </button>
                    ))}
                    {!filteredChapters.length && (
                      <span className="ws-picker-empty">没有匹配的章节</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ws-form-section">
        <h3>叙事镜头</h3>
        <div className="ws-field-grid">
          <div className="ws-field">
            <label>叙事镜头</label>
            <CustomSelect
              value="ensemble"
              options={[{ value: "ensemble", label: "多主体世界切片" }]}
              onChange={() => undefined}
              ariaLabel="叙事镜头"
              size="md"
            />
          </div>
          <div className="ws-field">
            <span className="ws-field-help">
              选择普通凡人时，跨度超过其寿命会输出完整人生结局，而不是继续假设他永远存在。
            </span>
          </div>
        </div>
      </div>
      <div className="ws-auto-note">
        <b>自动推导</b>
        <span>
          AI
          会读取事实起点、观察范围、人物地点、时间边界、战争与资源响应、修炼条件和推演预算，生成可追溯的故事变化。没有完整资料也可以先开始推演。
        </span>
      </div>
      <div className="ws-scope-line" style={{ marginTop: 14 }}>
        <span className="ws-scope-tag">项目：{projectTitle}</span>
        <span className="ws-scope-tag">
          观察对象：
          {observationTargets.length
            ? `${observationTargets.length} 个主体`
            : "全部人物与势力"}
        </span>
        <span className="ws-scope-tag">
          空间：{source?.observationSpaceLabel ?? "读取中"}
        </span>
        <span className="ws-scope-tag">
          基线：{baselineModeLabel(baselineMode, selectedChapter)}
        </span>
        <span className="ws-scope-tag">
          总时长：{formatSimulationSpan(endUnit, normalizedEndAmount)}
        </span>
        <span className="ws-scope-tag">
          每轮：{formatSimulationSpan(roundUnit, normalizedRoundAmount)}
        </span>
        <span className="ws-scope-tag">
          快照：人物 {source?.characterCount ?? 0} · 势力{" "}
          {source?.factionCount ?? 0} · 地点 {source?.locationCount ?? 0}
        </span>
      </div>
      {source?.diagnostics?.length ? (
        <div className="ws-source-diagnostics">
          {source.diagnostics.map((diagnostic) => (
            <span key={diagnostic}>{diagnostic}</span>
          ))}
        </div>
      ) : null}
      <div className="ws-setup-actions">
        {onCancel && (
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            onClick={onCancel}
          >
            取消
          </button>
        )}
        <button
          type="button"
          className="ws-btn ws-btn-primary"
          disabled={
            isCreating ||
            !name.trim() ||
            (baselineMode !== "timeline-current" && !baselineChapterId)
          }
          onClick={() =>
            void onCreate({
              name,
              endUnit,
              endAmount: normalizedEndAmount,
              roundUnit,
              roundAmount: normalizedRoundAmount,
              baselineMode,
              baselineChapterId,
              observationTargets,
            })
          }
        >
          {isCreating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {isCreating ? "正在建立" : "创建并进入舞台"}
        </button>
      </div>
    </section>
  );
}

export default function WorldSimulationWorkbench({
  storage,
  projectTitle,
  isActive,
  registerNavigationGuard,
  onAiRun,
  onCancelAiRun,
}: WorldSimulationWorkbenchProps) {
  const repository = useMemo(
    () => createNovelSimulationRepository(storage),
    [storage],
  );
  const [loaded, setLoaded] = useState<LoadedSimulationLibrary | null>(null);
  const [source, setSource] = useState<SimulationSourceInputs | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isSavingRound, setIsSavingRound] = useState(false);
  const [isSavingTimeout, setIsSavingTimeout] = useState(false);
  const [aiProgress, setAiProgress] = useState("准备本轮推演");
  const [setupOpen, setSetupOpen] = useState(false);
  const [continuousOpen, setContinuousOpen] = useState(false);
  const [continuousCount, setContinuousCount] = useState(3);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [selectedRound, setSelectedRound] = useState(0);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [selectedType, setSelectedType] = useState<InspectorType>("characters");
  const [selectedChoice, setSelectedChoice] = useState("");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("timeline");
  const [drawer, setDrawer] = useState<"causal" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeAiRunIdsRef = useRef(new Set<string>());
  const aiCancelRequestedRef = useRef(false);
  const aiCommitStartedRef = useRef(false);
  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextLoaded, nextSource] = await Promise.all([
        repository.load(),
        readSimulationInputs(storage),
      ]);
      setLoaded(nextLoaded);
      setSource(nextSource);
      const active = nextLoaded.index.activeRunId
        ? nextLoaded.runs.get(nextLoaded.index.activeRunId)?.manifest
        : undefined;
      setSelectedRound(active?.roundsCompleted ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository, storage]);
  useEffect(() => {
    if (isActive) void reload();
  }, [isActive, reload]);
  useEffect(
    () => registerNavigationGuard?.({ confirmLeave: async () => !isSettling }),
    [isSettling, registerNavigationGuard],
  );
  const activeRun = loaded?.index.activeRunId
    ? loaded.runs.get(loaded.index.activeRunId)?.manifest
    : undefined;
  const activeFiles =
    activeRun && loaded ? loaded.runs.get(activeRun.id) : undefined;
  const rounds = useMemo(() => activeFiles?.rounds ?? [], [activeFiles]);
  const allEvents = useMemo(() => activeFiles?.events ?? [], [activeFiles]);
  const aiEvents = useMemo(
    () => allEvents.filter(isAiProjectionEvent),
    [allEvents],
  );
  const currentEvents = useMemo(
    () =>
      selectedRound === 0
        ? []
        : allEvents.filter(
            (event) =>
              rounds[selectedRound - 1]?.eventIds.includes(event.id) &&
              isAiProjectionEvent(event),
          ),
    [allEvents, rounds, selectedRound],
  );
  const selectedEvent = currentEvents[selectedEventIndex] ?? currentEvents[0];
  const selectedRoundRecord =
    selectedRound === 0 ? null : (rounds[selectedRound - 1] ?? null);
  const progress = activeRun
    ? Math.min(
        100,
        Math.round(
          (activeRun.currentTime / Math.max(1, activeRun.endTime)) * 100,
        ),
      )
    : 0;
  const createRun = async ({
    name,
    endUnit,
    endAmount,
    roundUnit,
    roundAmount,
    baselineMode,
    baselineChapterId,
    observationTargets,
  }: {
    name: string;
    endUnit: SimulationTimeScale;
    endAmount: number;
    roundUnit: SimulationTimeScale;
    roundAmount: number;
    baselineMode: SimulationBaselineMode;
    baselineChapterId: string | null;
    observationTargets: readonly SimulationObservationTarget[];
  }) => {
    if (!loaded || !source) return;
    setIsCreating(true);
    setError(null);
    try {
      const baselineChapter = await loadBaselineChapter(
        storage,
        source,
        baselineChapterId,
      );
      const selectedChapter = source.chapters.find(
        (chapter) => chapter.id === baselineChapterId,
      );
      const result = await repository.createRun(loaded, {
        name,
        baselineMode,
        baselineSourceHash: buildBaselineSourceHash(
          source,
          baselineMode,
          baselineChapter,
        ),
        baselineLabel:
          baselineMode === "timeline-current"
            ? source.baselineLabel
            : baselineModeLabel(baselineMode, selectedChapter),
        baselineChapterId,
        baselineChapterLabel: selectedChapter
          ? `第 ${selectedChapter.displayNumber} 章 · ${selectedChapter.title}`
          : null,
        endTime: simulationScaleDays(endUnit, endAmount),
        endTimeAmount: endAmount,
        endTimeUnit: endUnit,
        timeScale: roundUnit,
        timeStep: roundAmount,
        observationSpaceIds: source.observationSpaceId
          ? [source.observationSpaceId]
          : [],
        observationSpaceLabel: source.observationSpaceLabel ?? "当前世界范围",
        observer: "ensemble",
        observationTargets,
        seed: 20260822,
      });
      setLoaded(result.loaded);
      setSetupOpen(false);
      setSelectedRound(0);
      setNotice("已创建运行，基线已冻结");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsCreating(false);
    }
  };
  const advanceOne = async (
    current: LoadedSimulationLibrary,
  ): Promise<LoadedSimulationLibrary> => {
    // 连续推演的每一轮都有独立的提交阶段；上一轮保存完成后，下一轮必须重新开放取消。
    aiCommitStartedRef.current = false;
    setIsSavingRound(false);
    const throwIfCancelled = () => {
      if (aiCancelRequestedRef.current) {
        throw new SimulationAiRunCancelledError();
      }
    };
    const run = current.index.activeRunId
      ? current.runs.get(current.index.activeRunId)?.manifest
      : undefined;
    const files = run ? current.runs.get(run.id) : undefined;
    if (!run || !files || !source) {
      throw new Error("推演上下文未就绪，请重新加载世界推演");
    }
    if (!onAiRun) {
      throw new Error(
        "AI 推演当前不可用，请在 MyNovelStudio 桌面端配置模型场景后重试",
      );
    }
    setAiProgress("正在读取冻结的世界上下文");
    const currentSource = await readSimulationInputs(storage);
    throwIfCancelled();
    const baselineChapter = await loadBaselineChapter(
      storage,
      currentSource,
      run.baselineChapterId,
    );
    throwIfCancelled();
    if (
      buildBaselineSourceHash(
        currentSource,
        run.baselineMode,
        baselineChapter,
      ) !== run.baselineSourceHash
    ) {
      throw new Error(
        "正式世界事实已发生变化，当前运行的基线已过期；请重新加载并新建推演运行",
      );
    }
    setAiProgress("正在计算本轮时间边界");
    const scopedSource = scopeSimulationSource(
      {
        ...currentSource,
        baselineChapter,
      },
      run.observationTargets,
    );
    const result = advanceSimulationRun(run, scopedSource);
    const aiInput = createSimulationAiInput(result, files.events, scopedSource);
    setAiProgress("正在请求 AI 生成事件候选");
    const runId = `simulation-${run.id}-round-${result.round.index}`;
    const requestAi = (request: {
      readonly runId: string;
      readonly label: string;
      readonly prompt: string;
      readonly systemPrompt: string;
      readonly timeoutMs: number;
      readonly usesNovelContextTools: boolean;
      readonly streamOutput: boolean;
    }) => {
      throwIfCancelled();
      activeAiRunIdsRef.current.add(request.runId);
      return onAiRun({
        sceneId: "simulation.advance",
        runId: request.runId,
        label: request.label,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        executionProfile: "extended",
        timeoutMs: request.timeoutMs,
        maxTurns: request.usesNovelContextTools ? 6 : 1,
        streamOutput: request.streamOutput,
        usesNovelContextTools: request.usesNovelContextTools,
        onProgress: (progress) => {
          if (
            !aiCancelRequestedRef.current &&
            activeAiRunIdsRef.current.has(progress.runId)
          ) {
            setAiProgress(progress.message);
          }
        },
      })
        .then(
          (output) => {
            throwIfCancelled();
            return output;
          },
          (cause) => {
            if (aiCancelRequestedRef.current) {
              throw new SimulationAiRunCancelledError();
            }
            throw cause;
          },
        )
        .finally(() => {
          activeAiRunIdsRef.current.delete(request.runId);
        });
    };
    const aiOutput = await requestAi({
      runId,
      label: `世界推演 · ${run.name} · 第 ${result.round.index} 轮`,
      prompt: buildSimulationAiPrompt(aiInput),
      systemPrompt:
        "你是世界推演的 AI 故事生成层。时间调度只提供时间窗口和约束事实；本轮所有故事、人物行动、势力策略、生命代际、资源传播与世界变化都必须由 AI 依据已取得资料生成。narrative 是作者的主阅读内容，events 只是辅助审计账本；优先返回当前轮次的连续中文故事和可选事件 JSON，无法可靠构造事件字段时直接返回故事正文，不要因为 JSON 格式困难而拒答或返回空文本。不要直接写入任何正式事实；候选缺少正式触发事实时可以保留，但必须使用 uncertain 并说明事实缺口，不得虚构证据。",
      timeoutMs: aiTimeoutMinutes(run) * 60_000,
      streamOutput: true,
      usesNovelContextTools: true,
    });
    setAiProgress("正在校验 AI 事件候选");
    let projected: ReturnType<typeof projectSimulationAiEvents>;
    const assertUsableProjection = (
      candidate: ReturnType<typeof projectSimulationAiEvents>,
      rawOutput: string,
    ) => {
      if (candidate.narrative.trim() || candidate.events.length > 0) return;
      throw new SimulationAiFormatError(
        "AI 推演结果没有故事正文或可用事件候选",
        rawOutput,
      );
    };
    try {
      projected = projectSimulationAiEvents(aiOutput, aiInput);
      assertUsableProjection(projected, aiOutput);
    } catch (cause) {
      if (cause instanceof SimulationAiNoContentError) {
        throw cause;
      }
      if (
        !(cause instanceof SimulationAiJsonParseError) &&
        !(cause instanceof SimulationAiFormatError)
      ) {
        throw cause;
      }
      setAiProgress("AI 返回格式无法解析，正在请求格式整理");
      const repairedOutput = await requestAi({
        runId: `${runId}-format`,
        label: `世界推演 · ${run.name} · 第 ${result.round.index} 轮 · 格式整理`,
        prompt: buildSimulationAiRepairPrompt(
          aiInput,
          cause.rawOutput,
          cause.message,
        ),
        systemPrompt:
          "你只负责把已有的世界推演候选整理成 JSON。不得调用工具、读取资料或改变事实；格式不明时返回空 events 数组。",
        timeoutMs: SIMULATION_AI_FORMAT_TIMEOUT_MS,
        usesNovelContextTools: false,
        streamOutput: false,
      });
      setAiProgress("正在校验格式整理结果");
      try {
        projected = projectSimulationAiEvents(repairedOutput, aiInput);
        assertUsableProjection(projected, repairedOutput);
      } catch (repairCause) {
        if (
          repairCause instanceof SimulationAiJsonParseError ||
          repairCause instanceof SimulationAiFormatError
        ) {
          throw new Error("AI 推演结果格式整理失败，请重试");
        }
        throw repairCause;
      }
    }
    throwIfCancelled();
    const latestSource = await readSimulationInputs(storage);
    throwIfCancelled();
    const latestChapter = await loadBaselineChapter(
      storage,
      latestSource,
      run.baselineChapterId,
    );
    throwIfCancelled();
    if (
      buildBaselineSourceHash(latestSource, run.baselineMode, latestChapter) !==
      run.baselineSourceHash
    ) {
      throw new Error(
        "AI 推演期间正式世界事实发生变化，本轮结果未保存；请重新加载后重试",
      );
    }
    setAiProgress("正在保存本轮账本");
    throwIfCancelled();
    // 进入持久化提交后不再接受取消，避免出现“界面已取消但检查点已经落盘”的状态。
    aiCommitStartedRef.current = true;
    setIsSavingRound(true);
    const events = [...result.events, ...projected.events];
    const round = {
      ...result.round,
      eventIds: events.map((event) => event.id),
      narrative:
        projected.narrative.trim() ||
        narrativeFromEvents(projected.events, result.round),
    };
    const next = await repository.updateRun(
      current,
      run.id,
      {},
      {
        ...files,
        manifest: result.run,
        rounds: [...files.rounds, round],
        events: [...files.events, ...events],
      },
    );
    setSelectedRound(round.index);
    setSelectedEventIndex(0);
    setSelectedChoice("");
    return next;
  };
  const advance = async (count = 1) => {
    if (!loaded || isSettling || !activeRun || activeRun.status === "completed")
      return;
    setIsSettling(true);
    aiCancelRequestedRef.current = false;
    aiCommitStartedRef.current = false;
    activeAiRunIdsRef.current.clear();
    setIsCancelling(false);
    setIsSavingRound(false);
    // 取消属于整轮推演，而不只是已发出的模型请求；上下文读取阶段也应可中止。
    setAiProgress("准备本轮推演");
    setError(null);
    setNotice(null);
    try {
      let current = loaded;
      for (let index = 0; index < count; index += 1) {
        current = await advanceOne(current);
        setLoaded(current);
        if (
          current.index.activeRunId &&
          current.runs.get(current.index.activeRunId)?.manifest.status ===
            "completed"
        )
          break;
      }
      setNotice(
        count > 1
          ? `AI 已完成 ${Math.min(count, activeRun.roundsCompleted + count)} 轮推演`
          : "AI 已完成本轮推演，检查点已保存",
      );
    } catch (cause) {
      if (
        aiCancelRequestedRef.current ||
        cause instanceof SimulationAiRunCancelledError
      ) {
        setNotice("AI 推演已取消，未完成的本轮没有保存。");
        setAiProgress("本轮推演已取消");
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      activeAiRunIdsRef.current.clear();
      aiCancelRequestedRef.current = false;
      aiCommitStartedRef.current = false;
      setIsCancelling(false);
      setIsSavingRound(false);
      setIsSettling(false);
    }
  };
  const cancelAdvance = async () => {
    if (!isSettling || isCancelling || aiCommitStartedRef.current) return;
    const runIds = [...activeAiRunIdsRef.current];
    aiCancelRequestedRef.current = true;
    setIsCancelling(true);
    setAiProgress("正在取消 AI 推演");
    if (!runIds.length) return;
    // 没有宿主取消接口时仍保留本地取消护栏，返回结果会在保存前被丢弃。
    if (!onCancelAiRun) return;
    const results = await Promise.allSettled(
      runIds.map((runId) => onCancelAiRun(runId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      setIsCancelling(false);
      setError("取消请求未能送达；本地结果仍会丢弃，可再次尝试取消。");
    }
  };
  const switchRun = async (runId: string) => {
    if (!loaded || loaded.index.activeRunId === runId) {
      setSwitcherOpen(false);
      return;
    }
    try {
      const next = await repository.save(
        loaded,
        { ...loaded.index, activeRunId: runId },
        loaded.runs,
      );
      setLoaded(next);
      setSelectedRound(next.runs.get(runId)?.manifest.roundsCompleted ?? 0);
      setSwitcherOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const updateAiTimeout = async (value: string) => {
    if (!loaded || !activeRun || isSettling || isSavingTimeout) return;
    const minutes = Number(value);
    if (!Number.isInteger(minutes)) return;
    setIsSavingTimeout(true);
    setError(null);
    try {
      const next = await repository.updateRun(loaded, activeRun.id, {
        aiTimeoutMinutes: minutes,
      });
      setLoaded(next);
      setNotice(`AI 推演超时时间已设置为 ${minutes} 分钟`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSavingTimeout(false);
    }
  };
  const groupedEvents = useMemo(
    () => ({
      world: currentEvents.filter((event) => eventGroup(event) === "world"),
      characters: currentEvents.filter(
        (event) => eventGroup(event) === "characters",
      ),
      factions: currentEvents.filter(
        (event) => eventGroup(event) === "factions",
      ),
      life: currentEvents.filter((event) => eventGroup(event) === "life"),
    }),
    [currentEvents],
  );
  const pulseData = [
    { key: "world", label: "世界过程", events: groupedEvents.world },
    { key: "characters", label: "人物行动", events: groupedEvents.characters },
    { key: "factions", label: "势力策略", events: groupedEvents.factions },
    { key: "life", label: "生命与代际", events: groupedEvents.life },
  ] as const;

  const selectPulse = (pulse: (typeof pulseData)[number]) => {
    const event = pulse.events[0];
    if (event) {
      setSelectedEventIndex(
        currentEvents.findIndex((item) => item.id === event.id),
      );
    }
    setSelectedType(
      pulse.key === "characters"
        ? "characters"
        : pulse.key === "factions"
          ? "factions"
          : pulse.key === "life"
            ? "characters"
            : "regions",
    );
    setMobilePanel("inspector");
  };
  if (isLoading)
    return (
      <div className="world-simulation flex h-full items-center justify-center">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取世界推演
      </div>
    );
  if (error && !loaded)
    return (
      <div className="world-simulation flex h-full items-center justify-center p-6">
        <div className="ws-setup-panel max-w-lg">
          <p>{error}</p>
          <button
            type="button"
            className="ws-btn ws-btn-primary"
            onClick={() => void reload()}
          >
            重新读取
          </button>
        </div>
      </div>
    );
  if (!loaded) return null;
  if (!activeRun)
    return (
      <div className="world-simulation">
        <Topbar status="运行已就绪" />
        <div className="ws-setup-shell">
          <aside className="ws-setup-intro">
            <div className="ws-kicker">world simulation · v4</div>
            <h1>世界推演</h1>
            <p>让时间、空间、人物与势力在同一个可追溯的世界时钟里继续演化。</p>
            <div className="ws-run-library">
              <div className="ws-library-head">
                <strong>推演运行</strong>
                <span>{loaded.index.runs.length} 个运行</span>
              </div>
              {loaded.index.runs.length === 0 ? (
                <p className="ws-field-help">尚未建立运行。</p>
              ) : (
                loaded.index.runs.map((entry) => (
                  <div key={entry.id} className="ws-run-row">
                    <i className="ws-run-mark" />
                    <span className="ws-run-row-copy">
                      <strong>{entry.name}</strong>
                      <small>{entry.status}</small>
                    </span>
                    <em>{entry.status}</em>
                  </div>
                ))
              )}
            </div>
          </aside>
          <div>
            {error && (
              <div
                className="ws-auto-note"
                role="alert"
                style={{
                  margin: "0 0 14px",
                  borderLeft: 0,
                  borderBottom: "1px solid var(--ws-line)",
                  background: "var(--ws-warn-soft)",
                }}
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <SetupForm
              projectTitle={projectTitle}
              source={source}
              onCreate={createRun}
              isCreating={isCreating}
            />
          </div>
        </div>
      </div>
    );
  const runRows = loaded.index.runs
    .map((entry) => ({ entry, manifest: loaded.runs.get(entry.id)?.manifest }))
    .filter((item) => item.manifest);
  return (
    <div className="world-simulation">
      <Topbar
        status={onAiRun ? statusLabel(activeRun) : "AI 推演不可用"}
        isRunning={isSettling}
        progress={aiProgress}
        onNew={() => setSetupOpen(true)}
        onMore={() => setDrawer("more")}
      />
      {notice && (
        <div
          className="ws-auto-note"
          style={{
            margin: 0,
            borderLeft: 0,
            borderBottom: "1px solid var(--ws-line)",
          }}
        >
          <Check className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            onClick={() => setNotice(null)}
          >
            知道了
          </button>
        </div>
      )}
      {error && (
        <div
          className="ws-auto-note"
          style={{
            margin: 0,
            borderLeft: 0,
            borderBottom: "1px solid var(--ws-line)",
            background: "var(--ws-warn-soft)",
          }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="ws-workspace">
        <div className="ws-workspace-head">
          <div className="ws-workspace-context">
            <div className="ws-workspace-title">
              <h1>
                <button
                  type="button"
                  className="ws-switcher"
                  aria-expanded={switcherOpen}
                  onClick={() => setSwitcherOpen((value) => !value)}
                >
                  <span>{activeRun.name}</span>
                  <ChevronDown className="ws-switcher-caret h-4 w-4" />
                </button>
              </h1>
              <p>
                {activeRun.parentRunId
                  ? "分支 · 从当前时间点创建"
                  : `主推演分支 · 基线：${activeRun.baselineLabel}`}
              </p>
              {switcherOpen && (
                <div className="ws-run-switcher">
                  <div className="ws-run-switcher-head">
                    <strong>推演运行</strong>
                    <span>{runRows.length} 个运行</span>
                  </div>
                  {runRows.map(({ entry, manifest }) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`ws-run-option ${entry.id === activeRun.id ? "ws-run-option-active" : ""}`}
                      onClick={() => void switchRun(entry.id)}
                    >
                      <i className="ws-option-mark" />
                      <span className="ws-run-option-copy">
                        <strong>{manifest?.name}</strong>
                        <small>
                          {manifest
                            ? `${formatSimulationSpan(manifest.timeScale, manifest.timeStep)}一轮 · ${formatSimulationTime(manifest.currentTime)}`
                            : entry.status}
                        </small>
                      </span>
                      <em>{manifest ? statusLabel(manifest) : entry.status}</em>
                    </button>
                  ))}
                  <div className="ws-run-switcher-footer">
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      onClick={() => {
                        setSwitcherOpen(false);
                        setSetupOpen(true);
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      新建推演
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="ws-round-meta">
              <div className="ws-meta-block">
                <small>当前时间</small>
                <strong>{formatSimulationTime(activeRun.currentTime)}</strong>
              </div>
              <div className="ws-meta-block">
                <small>轮次跨度</small>
                <strong>
                  {formatSimulationSpan(
                    activeRun.timeScale,
                    activeRun.timeStep,
                  )}
                </strong>
              </div>
              <div className="ws-meta-block">
                <small>总推演范围</small>
                <strong>{runHorizonLabel(activeRun)}</strong>
              </div>
            </div>
          </div>
          <div className="ws-workspace-actions">
            <button
              type="button"
              className="ws-btn ws-btn-primary"
              disabled={
                isSettling || activeRun.status === "completed" || !onAiRun
              }
              title={
                onAiRun
                  ? "请求模型完成本轮世界推演"
                  : "AI 推演不可用，请配置模型场景"
              }
              onClick={() => void advance()}
            >
              {isSettling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isSettling ? "AI 推演中" : "AI 推演 1 轮"}
            </button>
            {isSettling && (
              <button
                type="button"
                className="ws-btn ws-btn-danger"
                disabled={isCancelling || isSavingRound}
                aria-label={
                  isSavingRound
                    ? "正在保存"
                    : isCancelling
                      ? "正在取消"
                      : "取消推演"
                }
                aria-busy={isCancelling || isSavingRound}
                title={
                  isSavingRound
                    ? "本轮结果正在保存"
                    : "停止当前 AI 推演；未完成的本轮不会保存"
                }
                onClick={() => void cancelAdvance()}
              >
                {isCancelling || isSavingRound ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                {isSavingRound
                  ? "正在保存"
                  : isCancelling
                    ? "正在取消"
                    : "取消推演"}
              </button>
            )}
            <button
              type="button"
              className="ws-btn"
              disabled={
                isSettling || activeRun.status === "completed" || !onAiRun
              }
              aria-expanded={continuousOpen}
              onClick={() => setContinuousOpen((value) => !value)}
            >
              <Activity className="h-4 w-4" />
              连续推演
            </button>
            {continuousOpen && (
              <div
                className="ws-continuous-popover"
                role="dialog"
                aria-label="连续推演设置"
              >
                <strong>连续推演</strong>
                <p>按当前轮次跨度顺序执行，完成一轮就保存一次。</p>
                <div className="ws-continuous-row">
                  <input
                    type="number"
                    min={1}
                    max={9}
                    value={continuousCount}
                    aria-label="连续推演轮数"
                    onChange={(event) =>
                      setContinuousCount(
                        Math.min(
                          9,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      )
                    }
                  />
                  <span>轮</span>
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={
                      isSettling || activeRun.status === "completed" || !onAiRun
                    }
                    onClick={() => {
                      setContinuousOpen(false);
                      void advance(continuousCount);
                    }}
                  >
                    开始
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              className="ws-btn ws-btn-icon"
              aria-label="更多运行操作"
              title="更多运行操作"
              onClick={() => setDrawer("more")}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="ws-ribbon">
          <span className="ws-ribbon-item">
            <i className="ws-status-dot" />
            基线 <strong>已冻结</strong>
          </span>
          <span className="ws-ribbon-item">
            观察 <strong>{activeRun.observationSpaceLabel}</strong>
          </span>
          <span className="ws-ribbon-item">
            输入{" "}
            <strong>
              {source?.characterCount ?? 0} 人 · {source?.factionCount ?? 0}{" "}
              势力 · {source?.locationCount ?? 0} 地点
            </strong>
          </span>
          <span className="ws-ribbon-item">
            预算{" "}
            <strong>
              {aiEvents.length} /{" "}
              {Math.max(1, activeRun.roundsCompleted + 1) * 5} 事件
            </strong>
          </span>
          <span className="ws-ribbon-item">
            检查点{" "}
            <strong>
              {activeRun.roundsCompleted
                ? `第 ${activeRun.roundsCompleted} 轮已保存`
                : "等待首轮"}
            </strong>
          </span>
          <span className="ws-ribbon-item ws-ribbon-item-warn">
            <i className="ws-status-dot" />0 个候选提案
          </span>
          <span className="ws-ribbon-item">
            推进率{" "}
            <span className="ws-progress">
              <i style={{ width: `${progress}%` }} />
            </span>
          </span>
        </div>
        <div
          className="ws-mobile-switch"
          role="tablist"
          aria-label="移动端工作台视图"
        >
          {(["timeline", "stage", "inspector"] as const).map((panel) => (
            <button
              key={panel}
              type="button"
              className={mobilePanel === panel ? "active" : ""}
              onClick={() => setMobilePanel(panel)}
            >
              {panel === "timeline"
                ? "轮次"
                : panel === "stage"
                  ? "舞台"
                  : "状态"}
            </button>
          ))}
        </div>
        <div className="ws-workspace-grid" data-mobile-panel={mobilePanel}>
          <aside className="ws-timeline-pane">
            <div className="ws-pane-title">
              <h2>推演时间线</h2>
              <span>{rounds.length} 轮已记录</span>
            </div>
            <div className="ws-timeline">
              <button
                type="button"
                className={`ws-round-item ${selectedRound === 0 ? "ws-round-item-active" : ""}`}
                onClick={() => {
                  setSelectedRound(0);
                  setSelectedEventIndex(0);
                }}
              >
                <span className="ws-round-main">
                  <strong>第 0 轮</strong>
                  <em>基线</em>
                </span>
                <small>{activeRun.baselineLabel}</small>
                <small>正式事实已冻结</small>
              </button>
              {rounds.map((round) => (
                <button
                  type="button"
                  key={round.id}
                  className={`ws-round-item ${selectedRound === round.index ? "ws-round-item-active" : ""}`}
                  onClick={() => {
                    setSelectedRound(round.index);
                    setSelectedEventIndex(0);
                  }}
                >
                  <span className="ws-round-main">
                    <strong>第 {round.index} 轮</strong>
                    <em>
                      {round.status === "completed" ? "已完成" : round.status}
                    </em>
                  </span>
                  <small>
                    {formatSimulationTime(round.startTime)} —{" "}
                    {formatSimulationTime(round.endTime)}
                  </small>
                  <small>{round.eventIds.length} 个事件 · 检查点已保存</small>
                </button>
              ))}
            </div>
          </aside>
          <main className="ws-stage-pane">
            <div className="ws-stage-head">
              <div>
                <div className="ws-kicker">
                  narrative stage · round{" "}
                  {String(selectedRound).padStart(2, "0")}
                </div>
                <h2>
                  {selectedRound === 0
                    ? "事实基线 · 当前世界"
                    : `第 ${selectedRound} 轮 · ${selectedEvent?.title ?? "世界继续演化"}`}
                </h2>
                <p>
                  {selectedRound === 0
                    ? activeRun.baselineLabel
                    : `${formatSimulationTime(selectedRoundRecord?.startTime ?? 0)} — ${formatSimulationTime(selectedRoundRecord?.endTime ?? activeRun.currentTime)}`}
                </p>
              </div>
              <div className="ws-stage-tools">
                <button
                  type="button"
                  className="ws-btn"
                  onClick={() => setDrawer("causal")}
                >
                  <Route className="h-4 w-4" />
                  因果链
                </button>
                <button
                  type="button"
                  className="ws-btn"
                  onClick={() =>
                    setNotice("候选提案已记录到当前运行的审阅队列")
                  }
                >
                  生成提案
                </button>
              </div>
            </div>
            <div className="ws-stage-summary">
              <strong>{currentEvents.length} 个事件</strong>
              <span>
                跨度{" "}
                {formatSimulationSpan(activeRun.timeScale, activeRun.timeStep)}{" "}
                · 观察 多主体世界
              </span>
              <span className="ws-status-chip">
                <i className="ws-status-dot" />
                {selectedRoundRecord?.status === "completed" ||
                selectedRound === 0
                  ? "已完成"
                  : "待推演"}
              </span>
            </div>
            <section className="ws-narrative-stage">
              <div className="ws-scene-bar">
                <span className="ws-scene-label">当前场景</span>
                <strong>
                  {formatSimulationTime(
                    selectedRoundRecord?.endTime ?? activeRun.currentTime,
                  )}
                </strong>
                <span className="ws-scene-live">
                  <i className="ws-status-dot" />
                  检查点已保存
                </span>
              </div>
              <section className="ws-pulse-panel">
                <div className="ws-pulse-head">
                  <strong>AI 推演变化</strong>
                  <span>{currentEvents.length} 条 AI 已接受变化</span>
                </div>
                <div className="ws-pulse-grid">
                  {pulseData.map((pulse) => {
                    const event = pulse.events[0];
                    return (
                      <div
                        key={pulse.key}
                        className={`ws-pulse ws-pulse-${pulse.key}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`查看${pulse.label} AI 推演变化`}
                        onClick={() => selectPulse(pulse)}
                        onKeyDown={(keyboardEvent) => {
                          if (
                            keyboardEvent.key === "Enter" ||
                            keyboardEvent.key === " "
                          ) {
                            keyboardEvent.preventDefault();
                            selectPulse(pulse);
                          }
                        }}
                      >
                        <div className="ws-pulse-title">
                          <strong>{pulse.label}</strong>
                          <span>{pulse.events.length} 条</span>
                        </div>
                        <p>
                          {event?.summary ??
                            "本轮 AI 尚未生成该类可审计变化，故事正文仍以 AI 叙事为准。"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className="ws-next-window">
                <div className="ws-next-window-mark">
                  <Clock3 className="h-5 w-5" />
                </div>
                <div>
                  <strong>
                    {selectedRoundRecord?.boundary
                      ? `本轮停在：${boundaryLabel(selectedRoundRecord.boundary.kind)}`
                      : activeRun.status === "completed"
                        ? "推演窗口已完成"
                        : "等待首个有意义边界"}
                  </strong>
                  <p>
                    {selectedRoundRecord?.boundary?.reason ??
                      (activeRun.status === "completed"
                        ? "当前运行已到达终止时间，未命中的未来事件不会被补写。"
                        : "系统会在下一个有意义边界唤醒，不按天循环空转。")}
                  </p>
                  {selectedRoundRecord?.boundary && (
                    <div className="ws-boundary-facts">
                      <span>
                        本轮时间：
                        {formatSimulationTime(
                          selectedRoundRecord.startTime,
                        )} → {formatSimulationTime(selectedRoundRecord.endTime)}
                      </span>
                      <span>
                        下一唤醒：
                        {selectedRoundRecord.nextBoundary
                          ? `${formatSimulationTime(selectedRoundRecord.nextBoundary.scheduledAt)} · ${selectedRoundRecord.nextBoundary.reason}`
                          : "当前运行已到终点"}
                      </span>
                    </div>
                  )}
                </div>
              </section>
              <article className="ws-story-panel">
                <div className="ws-story-eyebrow">本轮世界故事</div>
                <h3>
                  {selectedRoundRecord?.narrative
                    ? `第 ${selectedRound} 轮 · 世界继续演化`
                    : (selectedEvent?.title ?? "正式世界事实已冻结")}
                </h3>
                <p className="ws-story-narrative">
                  {selectedRoundRecord?.narrative ??
                    selectedEvent?.summary ??
                    "从这个时间点开始，推演只会在独立运行沙盒中记录变化，不会直接改写人物、势力、地点和时间线事实。"}
                </p>
                <div className="ws-story-facts">
                  {[
                    `${formatSimulationSpan(activeRun.timeScale, activeRun.timeStep)}一轮`,
                    "观察对象：多主体世界",
                    `发生时间：${formatSimulationTime(selectedEvent?.time ?? activeRun.currentTime)}`,
                    `AI 状态：${selectedEvent ? certaintyLabel(selectedEvent) : "基线"}`,
                  ].map((fact) => (
                    <span className="ws-story-fact" key={fact}>
                      {fact}
                    </span>
                  ))}
                </div>
                {selectedEvent && (
                  <details className="ws-evidence-details">
                    <summary>查看这段故事的推演依据</summary>
                    <div className="ws-event-evidence">
                      <div className="ws-evidence-block">
                        <small>主体与地点</small>
                        <strong>
                          {selectedEvent.actorRefs.length
                            ? selectedEvent.actorRefs
                                .map((ref) => ref.label)
                                .join("、")
                            : selectedEvent.entityRefs
                                .map((ref) => ref.label)
                                .join("、") || "未确定主体"}
                          {selectedEvent.locationRef
                            ? ` · ${selectedEvent.locationRef.label}`
                            : ""}
                        </strong>
                      </div>
                      <div className="ws-evidence-block">
                        <small>触发事实</small>
                        <strong>
                          {selectedEvent.triggerFacts.length
                            ? selectedEvent.triggerFacts
                                .map((fact) => `${fact.label}：${fact.value}`)
                                .join("；")
                            : "本轮 AI 依据时间边界与正式资料生成"}
                        </strong>
                      </div>
                      <div className="ws-evidence-block">
                        <small>AI 推演依据</small>
                        <strong>
                          {`AI ${selectedEvent.source === "character" ? "人物" : selectedEvent.source === "faction" ? "势力" : selectedEvent.source === "world" ? "世界过程" : "系统"} 推演`}
                          {selectedEvent.ruleIds.length
                            ? ` · 约束 ${selectedEvent.ruleIds.join("、")}`
                            : " · 无额外约束"}
                        </strong>
                      </div>
                      {(selectedEvent.decision || selectedEvent.action) && (
                        <div className="ws-evidence-block">
                          <small>决策与行动</small>
                          <strong>
                            {[selectedEvent.decision, selectedEvent.action]
                              .filter(Boolean)
                              .join(" → ")}
                          </strong>
                        </div>
                      )}
                      {selectedEvent.stateChanges.length > 0 && (
                        <div className="ws-evidence-block">
                          <small>状态变化</small>
                          <strong>
                            {selectedEvent.stateChanges
                              .map(
                                (change) =>
                                  `${change.entityRef.label} · ${change.field}：${change.before || "空"} → ${change.after}`,
                              )
                              .join("；")}
                          </strong>
                        </div>
                      )}
                      {selectedEvent.propagations.length > 0 && (
                        <div className="ws-evidence-block">
                          <small>传播链</small>
                          <strong>
                            {selectedEvent.propagations
                              .map(
                                (propagation) =>
                                  `${propagation.channel} → ${propagation.targetSpaceId}（${formatSimulationTime(propagation.arrivesAt)}，${propagation.status}）`,
                              )
                              .join("；")}
                          </strong>
                        </div>
                      )}
                      {selectedEvent.causeEventIds.length > 0 && (
                        <div className="ws-evidence-block">
                          <small>因果链</small>
                          <strong>
                            {selectedEvent.causeEventIds
                              .map(
                                (id) =>
                                  allEvents.find((event) => event.id === id)
                                    ?.title ?? id,
                              )
                              .join(" → ")}
                          </strong>
                        </div>
                      )}
                      {selectedEvent.uncertainty && (
                        <div className="ws-evidence-block ws-evidence-uncertain">
                          <small>未确定部分</small>
                          <strong>{selectedEvent.uncertainty}</strong>
                        </div>
                      )}
                    </div>
                  </details>
                )}
                <div className="ws-choice-heading">
                  <span>你要如何处理这一刻？</span>
                  <small>选择会记录为当前运行的作者干预候选</small>
                </div>
                <div className="ws-choice-list">
                  {choicesFor(selectedEvent).map((choice) => (
                    <button
                      type="button"
                      key={choice.id}
                      className={`ws-choice ${selectedChoice === choice.id ? "ws-choice-active" : ""}`}
                      onClick={() => {
                        setSelectedChoice(choice.id);
                        setNotice(
                          `已记录“${choice.label}”候选，不会直接改写正式事实`,
                        );
                      }}
                    >
                      <strong>{choice.label}</strong>
                      <span>{choice.detail}</span>
                    </button>
                  ))}
                </div>
                {selectedChoice && (
                  <p className="ws-choice-feedback">
                    <Check className="mr-1 inline h-3.5 w-3.5" />
                    已记录当前运行候选
                  </p>
                )}
              </article>
              <div>
                <div className="ws-activity-head">
                  <strong>本轮行动记录</strong>
                  <span>{currentEvents.length} 个结果 · 按时间边界生成</span>
                </div>
                <div className="ws-event-stream">
                  {currentEvents.length === 0 ? (
                    <div className="ws-field-help" style={{ padding: 12 }}>
                      选择已完成轮次查看事件，或推进一轮开始 AI 推演。
                    </div>
                  ) : (
                    currentEvents.map((event, index) => (
                      <button
                        type="button"
                        key={event.id}
                        className={`ws-event-card ${selectedEvent?.id === event.id ? "ws-event-card-active" : ""}`}
                        onClick={() => {
                          setSelectedEventIndex(index);
                          setSelectedType(
                            eventGroup(event) === "characters"
                              ? "characters"
                              : eventGroup(event) === "factions"
                                ? "factions"
                                : "regions",
                          );
                        }}
                      >
                        <span className="ws-event-seq">{index + 1}</span>
                        <span className="ws-event-copy">
                          <span className="ws-event-top">
                            {formatSimulationTime(event.time)}
                            <span className="ws-event-kind">
                              {eventLabel(event)}
                            </span>
                          </span>
                          <h3>{event.title}</h3>
                          <small className="ws-event-context">
                            {(event.actorRefs[0]?.label ??
                              event.entityRefs[0]?.label ??
                              "世界过程") +
                              (event.locationRef
                                ? ` · ${event.locationRef.label}`
                                : "")}
                            {` · ${certaintyLabel(event)}`}
                          </small>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </section>
          </main>
          <aside className="ws-inspector-pane">
            <div className="ws-inspector-head">
              <div>
                <h2>当前时间点</h2>
                <p>选择轮次或事件，查看该时刻可追溯的实体状态。</p>
              </div>
              <Info className="h-4 w-4 text-[var(--ws-ink-3)]" />
            </div>
            <div className="ws-state-time">
              <small>状态快照</small>
              <strong>
                {formatSimulationTime(
                  selectedEvent?.time ??
                    selectedRoundRecord?.endTime ??
                    activeRun.currentTime,
                )}{" "}
                · 第 {selectedRound} 轮结束
              </strong>
            </div>
            <div className="ws-inspector-focus">
              <small>
                当前焦点 ·{" "}
                {selectedEvent ? eventLabel(selectedEvent) : "世界状态"}
              </small>
              <strong>
                {selectedEvent?.entityRefs[0]?.label ??
                  activeRun.observationSpaceLabel}
              </strong>
              <span>
                {selectedEvent
                  ? `${selectedEvent.title}：${selectedEvent.summary}`
                  : "选择行动记录，查看这个时间点的可追溯状态。"}
              </span>
            </div>
            <div className="ws-inspector-tabs">
              {(["characters", "factions", "regions", "world"] as const).map(
                (type) => (
                  <button
                    type="button"
                    key={type}
                    className={`ws-inspector-tab ${selectedType === type ? "ws-inspector-tab-active" : ""}`}
                    onClick={() => setSelectedType(type)}
                  >
                    {type === "characters"
                      ? "人物"
                      : type === "factions"
                        ? "势力"
                        : type === "regions"
                          ? "地域"
                          : "世界"}
                  </button>
                ),
              )}
            </div>
            <InspectorBody
              type={selectedType}
              source={source}
              run={activeRun}
              event={selectedEvent}
            />
          </aside>
        </div>
      </div>
      {setupOpen && (
        <div
          className="ws-drawer-backdrop ws-setup-backdrop"
          role="presentation"
          onClick={() => setSetupOpen(false)}
        >
          <div
            className="ws-setup-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <SetupForm
              modal
              projectTitle={projectTitle}
              source={source}
              onCreate={createRun}
              onCancel={() => setSetupOpen(false)}
              isCreating={isCreating}
            />
          </div>
        </div>
      )}
      {drawer && (
        <>
          <div
            className="ws-drawer-backdrop"
            role="presentation"
            onClick={() => setDrawer(null)}
          />
          <aside className="ws-drawer">
            <div className="ws-drawer-head">
              <h2>{drawer === "causal" ? "本轮因果链" : "运行操作"}</h2>
              <button
                type="button"
                className="ws-btn ws-btn-icon"
                aria-label="关闭"
                onClick={() => setDrawer(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {drawer === "causal" ? (
              <>
                <p>
                  当前 AI
                  事件的因果证据按时间边界和正式资料展开，未确认的细节不会被补写。
                </p>
                <div className="ws-cause">
                  <small>前因事件</small>
                  <strong>
                    {selectedEvent?.causeEventIds
                      .map(
                        (id) =>
                          allEvents.find((event) => event.id === id)?.title ??
                          id,
                      )
                      .join("、") || "世界基线与当前时间边界"}
                  </strong>
                  <span>{activeRun.baselineLabel}</span>
                </div>
                <div className="ws-cause">
                  <small>AI 约束</small>
                  <strong>
                    {selectedEvent?.ruleIds.join("、") || "baseline"}
                  </strong>
                  <span>AI 来源：{selectedEvent?.source ?? "world"}。</span>
                </div>
              </>
            ) : (
              <>
                <p>这里管理当前运行的基线、AI 请求预算和候选输出。</p>
                <div className="ws-run-setting">
                  <div>
                    <strong>AI 请求超时</strong>
                    <span>首轮 AI 推演使用此时限；格式整理最多 60 秒</span>
                  </div>
                  <CustomSelect
                    value={String(aiTimeoutMinutes(activeRun))}
                    options={[...AI_TIMEOUT_OPTIONS]}
                    onChange={(value) => void updateAiTimeout(value)}
                    ariaLabel="AI 推演请求超时"
                    triggerIcon={<Clock3 className="h-3.5 w-3.5" />}
                    popoverMinWidth={112}
                    size="toolbar"
                    disabled={isSettling || isSavingTimeout}
                  />
                </div>
                <div className="ws-cause">
                  <small>基线哈希</small>
                  <strong>{activeRun.baselineSourceHash}</strong>
                  <span>正式事实保持只读，运行结果独立保存。</span>
                </div>
                <div className="ws-cause">
                  <small>运行种子</small>
                  <strong>{activeRun.seed}</strong>
                  <span>相同输入和种子可复现同一轮结果。</span>
                </div>
              </>
            )}
          </aside>
        </>
      )}
    </div>
  );
}

function Topbar({
  status,
  isRunning = false,
  progress,
  onNew,
  onMore,
}: {
  readonly status: string;
  readonly isRunning?: boolean;
  readonly progress?: string;
  readonly onNew?: () => void;
  readonly onMore?: () => void;
}) {
  return (
    <header className="ws-topbar">
      <div className="ws-topbar-left">
        <div className="ws-crumb">
          辅助 <span>/</span> <strong>世界推演</strong>
        </div>
        <div className="ws-top-title">世界推演</div>
      </div>
      <div className="ws-topbar-right">
        <span
          className={`ws-status-chip ${isRunning ? "ws-status-chip-running" : ""}`}
          {...(isRunning
            ? { role: "status", "aria-busy": true, "aria-live": "polite" }
            : {})}
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <i className="ws-status-dot" />
          )}
          <span>{isRunning ? `AI 推演${progress ?? ""}` : status}</span>
        </span>
        {onNew && (
          <button type="button" className="ws-btn ws-btn-quiet" onClick={onNew}>
            新建推演
          </button>
        )}
        {onMore && (
          <button
            type="button"
            className="ws-btn ws-btn-icon"
            aria-label="运行操作"
            title="运行操作"
            onClick={onMore}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}

function InspectorBody({
  type,
  source,
  run,
  event,
}: {
  readonly type: InspectorType;
  readonly source: SimulationSourceInputs | null;
  readonly run: SimulationRun;
  readonly event?: SimulationEvent;
}) {
  const focusedCharacter = event?.actorRefs.find(
    (ref) => ref.type === "character",
  );
  const focusedFaction = event?.actorRefs.find((ref) => ref.type === "faction");
  const focusedLocation = event?.locationRef;
  const data =
    type === "characters"
      ? [
          {
            name:
              focusedCharacter?.label ??
              source?.characters?.[0]?.name ??
              "活跃人物",
            state: focusedCharacter
              ? "本轮发生变化"
              : `${source?.characterCount ?? 0} 个主体`,
            meta: "人物投影 · 目标、知识与行动",
            stats: [
              ["主体数", String(source?.characterCount ?? 0)],
              ["观察时间", formatSimulationTime(run.currentTime)],
              [
                "当前地点",
                focusedLocation?.label ??
                  source?.characters?.[0]?.currentLocationLabel ??
                  "未提供",
              ],
              ["目标", source?.characters?.[0]?.goals || "未提供"],
              ["当前焦点", focusedCharacter?.label ?? "未选择"],
            ],
            meter: Math.min(100, (source?.characterCount ?? 0) * 10),
          },
        ]
      : type === "factions"
        ? [
            {
              name:
                focusedFaction?.label ??
                source?.factions?.[0]?.name ??
                "活跃势力",
              state: focusedFaction
                ? "本轮发生变化"
                : `${source?.factionCount ?? 0} 个主体`,
              meta: "势力投影 · 预算、关系与策略",
              stats: [
                ["主体数", String(source?.factionCount ?? 0)],
                ["状态", source?.factions?.[0]?.status || "未提供"],
                [
                  "领地",
                  source?.factions?.[0]?.territoryLabels?.join("、") ||
                    "未提供",
                ],
                ["风险偏好", "按正式资料与 AI 推演推断"],
                ["当前焦点", focusedFaction?.label ?? "未选择"],
              ],
              meter: Math.min(100, (source?.factionCount ?? 0) * 14),
            },
          ]
        : type === "regions"
          ? [
              {
                name: focusedLocation?.label ?? run.observationSpaceLabel,
                state: "观察范围",
                meta: "空间投影 · 传播边界与资源",
                stats: [
                  ["地点数", String(source?.locationCount ?? 0)],
                  ["空间节点", source?.locations?.[0]?.nodeId || "未提供"],
                  ["传播参考", "消息、旅行、贸易、政治"],
                  [
                    "当前焦点",
                    event?.entityRefs.find((ref) => ref.type === "location")
                      ?.label ?? "观察边界",
                  ],
                ],
                meter: Math.min(100, 35 + (source?.locationCount ?? 0) * 5),
              },
            ]
          : [
              {
                name: "当前纪元",
                state: "世界时钟",
                meta: "世界过程 · 时间、法则与周期",
                stats: [
                  ["正式事件", String(source?.timelineEventCount ?? 0)],
                  ["运行轮次", String(run.roundsCompleted)],
                  [
                    "推进率",
                    `${Math.round((run.currentTime / Math.max(1, run.endTime)) * 100)}%`,
                  ],
                ],
                meter: Math.round(
                  (run.currentTime / Math.max(1, run.endTime)) * 100,
                ),
              },
            ];
  return (
    <div>
      {data.map((entity) => (
        <section className="ws-entity-block" key={entity.name}>
          <div className="ws-entity-heading">
            <strong>{entity.name}</strong>
            <span>{entity.state}</span>
          </div>
          <div className="ws-entity-sub">{entity.meta}</div>
          <dl className="ws-stat-list">
            {entity.stats.map(([label, value]) => (
              <div className="ws-stat-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="ws-meter">
            <i style={{ width: `${entity.meter}%` }} />
          </div>
        </section>
      ))}
    </div>
  );
}
