import { z } from "zod";

import {
  simulationEventKindSchema,
  simulationEntityRefSchema,
  simulationEventSchema,
  simulationPropagationSchema,
  type SimulationEvent,
  type SimulationEntityRef,
  type SimulationEventKind,
  type SimulationRound,
  type SimulationRun,
} from "../entities/simulationSchema";
import type {
  SimulationAdvanceResult,
  SimulationEngineInputs,
} from "./simulationEngine";

const safeIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const aiPropagationSchema = z
  .object({
    targetSpaceId: safeIdSchema,
    channel: z.enum(["message", "travel", "trade", "politics", "ecology"]),
    arrivesAt: z.number().int().nonnegative(),
    status: z.enum(["pending", "arrived", "blocked"]),
    summary: z.string(),
  })
  .strict();

const aiEventSchema = z
  .object({
    kind: simulationEventKindSchema,
    title: z.string().trim().min(1),
    summary: z.string(),
    time: z.number().int().nonnegative(),
    certainty: z.enum(["inferred", "uncertain", "blocked", "aggregated"]),
    source: z.enum(["character", "faction", "world", "system"]),
    entityRefs: z.array(simulationEntityRefSchema).default([]),
    actorRefs: z.array(simulationEntityRefSchema).default([]),
    locationRef: simulationEntityRefSchema.nullable().default(null),
    targetRefs: z.array(simulationEntityRefSchema).default([]),
    triggerFacts: z
      .array(
        z
          .object({
            id: safeIdSchema,
            label: z.string().trim().min(1),
            value: z.string(),
            sourcePath: z.string().trim().min(1).nullable().default(null),
          })
          .strict(),
      )
      .default([]),
    decision: z.string().default(""),
    action: z.string().default(""),
    stateChanges: z
      .array(
        z
          .object({
            entityRef: simulationEntityRefSchema,
            field: z.string().trim().min(1),
            before: z.string(),
            after: z.string(),
          })
          .strict(),
      )
      .default([]),
    uncertainty: z.string().default(""),
    causeEventIds: z.array(safeIdSchema).default([]),
    propagations: z.array(aiPropagationSchema).default([]),
    ruleIds: z.array(safeIdSchema).default([]),
  })
  .strict();

const aiPayloadSchema = z
  .object({
    narrative: z.string().default(""),
    events: z.array(aiEventSchema).max(8).default([]),
  })
  .strict();

export interface SimulationAiProjectionInput {
  readonly run: SimulationRun;
  readonly round: SimulationRound;
  readonly hardEvents: readonly SimulationEvent[];
  readonly historicalEvents: readonly SimulationEvent[];
  readonly source: SimulationEngineInputs;
}

export interface SimulationAiProjectionResult {
  readonly events: readonly SimulationEvent[];
  readonly narrative: string;
  readonly rawOutput: string;
  /** 被兼容归一化丢弃的事件数量；故事正文仍可独立保存。 */
  readonly droppedEventCount: number;
}

export class SimulationAiJsonParseError extends Error {
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.name = "SimulationAiJsonParseError";
    this.rawOutput = rawOutput;
  }
}

export class SimulationAiFormatError extends Error {
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.name = "SimulationAiFormatError";
    this.rawOutput = rawOutput;
  }
}

const missingTriggerFactsUncertainty =
  "缺少可引用的正式触发事实，本事件仅作为 AI 候选，仍需后续资料或剧情确认。";

type RawRecord = Record<string, unknown>;
type EntityRefType = SimulationEntityRef["type"];
type EventSource = SimulationEvent["source"];

const eventKindAliases: Readonly<Record<string, SimulationEvent["kind"]>> = {
  world: "world-process",
  "world-process": "world-process",
  character: "character-action",
  "character-action": "character-action",
  faction: "faction-strategy",
  "faction-strategy": "faction-strategy",
  life: "life-cycle",
  lifecycle: "life-cycle",
  "life-cycle": "life-cycle",
  propagation: "propagation",
  resource: "resource",
  diagnostic: "diagnostic",
};

const eventSourceAliases: Readonly<Record<string, EventSource>> = {
  character: "character",
  "character-action": "character",
  person: "character",
  faction: "faction",
  "faction-strategy": "faction",
  organization: "faction",
  world: "world",
  "world-process": "world",
  rule: "system",
  system: "system",
};

const entityTypeAliases: Readonly<Record<string, EntityRefType>> = {
  character: "character",
  person: "character",
  faction: "faction",
  organization: "faction",
  location: "location",
  place: "location",
  world: "world",
  "world-process": "world",
};

const certaintyAliases: Readonly<
  Record<string, "inferred" | "uncertain" | "blocked" | "aggregated">
> = {
  confirmed: "inferred",
  inferred: "inferred",
  likely: "inferred",
  uncertain: "uncertain",
  possible: "uncertain",
  blocked: "blocked",
  aggregated: "aggregated",
};

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayField(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.replace(/^\uFEFF/u, "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    // A few providers JSON-encode the object one extra time, especially when
    // a formatting pass is routed through a generic text-completion model.
    if (typeof parsed === "string") {
      return JSON.parse(parsed) as unknown;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["result", "output", "payload", "data"]) {
        const nested = record[key];
        if (
          nested &&
          typeof nested === "object" &&
          !Array.isArray(nested) &&
          ("events" in nested || "narrative" in nested)
        ) {
          return nested;
        }
      }
    }
    return parsed;
  } catch (cause) {
    const extracted = extractJsonObject(jsonText);
    if (extracted && extracted !== jsonText) {
      try {
        return JSON.parse(extracted) as unknown;
      } catch {
        // Preserve the original parse failure below so callers can decide
        // whether a single no-tool formatting retry is appropriate.
      }
    }
    throw new Error(
      `AI 推演结果不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function parsePayload(
  output: string,
  input: SimulationAiProjectionInput,
): {
  readonly payload: z.infer<typeof aiPayloadSchema>;
  readonly droppedEventCount: number;
} {
  const parsed = parseJsonOutput(output);
  const record = asRecord(parsed);
  if (!record) {
    throw new SimulationAiFormatError(
      "AI 推演结果格式无效：root: 必须是对象",
      output,
    );
  }
  const refs = allowedEntityRefs(input);
  const knownFacts = new Map<string, SimulationEvent["triggerFacts"][number]>();
  [...input.hardEvents, ...input.historicalEvents].forEach((event) => {
    event.triggerFacts.forEach((fact) => {
      if (!knownFacts.has(fact.id)) knownFacts.set(fact.id, fact);
    });
  });
  const knownEventIds = new Set([
    ...input.hardEvents.map((event) => event.id),
    ...input.historicalEvents.map((event) => event.id),
  ]);
  const knownRuleIds = new Set(input.hardEvents.flatMap((event) => event.ruleIds));
  const rawEvents = arrayField(record.events);
  const eventsToNormalize = rawEvents.slice(0, 8);
  let droppedEventCount = Math.max(0, rawEvents.length - eventsToNormalize.length);
  const events = eventsToNormalize.flatMap((event) => {
    const normalized = normalizeAiEvent(event, {
      refs,
      knownFacts,
      knownEventIds,
      knownRuleIds,
      round: input.round,
    });
    if (!normalized) droppedEventCount += 1;
    return normalized ? [normalized] : [];
  });
  const narrative =
    textField(record.narrative) ||
    textField(record.story) ||
    textField(record.content);
  const normalizedPayload = { narrative, events };
  const result = aiPayloadSchema.safeParse(normalizedPayload);
  if (!result.success) {
    throw new SimulationAiFormatError(
      `AI 推演结果格式无效：${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
      output,
    );
  }
  return { payload: result.data, droppedEventCount };
}

function allowedEntityRefs(
  input: SimulationAiProjectionInput,
): ReadonlyMap<EntityRefType, ReadonlyMap<string, SimulationEntityRef>> {
  const characters = new Map<string, SimulationEntityRef>();
  (input.source.characters ?? []).forEach((item) => {
    characters.set(item.id, {
      type: "character",
      id: item.id,
      label: item.name,
    });
  });
  if (!characters.size) {
    characters.set("active-characters", {
      type: "character",
      id: "active-characters",
      label: "当前人物集合",
    });
  }

  const factions = new Map<string, SimulationEntityRef>();
  (input.source.factions ?? []).forEach((item) => {
    factions.set(item.id, {
      type: "faction",
      id: item.id,
      label: item.name,
    });
  });
  if (!factions.size) {
    factions.set("active-factions", {
      type: "faction",
      id: "active-factions",
      label: "当前势力集合",
    });
  }

  const locations = new Map<string, SimulationEntityRef>();
  (input.source.locations ?? []).forEach((item) => {
    locations.set(item.id, {
      type: "location",
      id: item.id,
      label: item.name,
    });
  });
  (input.source.factions ?? []).forEach((faction) => {
    (faction.territoryIds ?? []).forEach((id, index) => {
      if (!locations.has(id)) {
        locations.set(id, {
          type: "location",
          id,
          label: faction.territoryLabels?.[index] ?? id,
        });
      }
    });
  });
  if (input.source.observationSpaceId && !locations.has(input.source.observationSpaceId)) {
    locations.set(input.source.observationSpaceId, {
      type: "location",
      id: input.source.observationSpaceId,
      label: input.source.observationSpaceLabel ?? input.source.observationSpaceId,
    });
  }
  if (!locations.size) {
    locations.set("observed-space", {
      type: "location",
      id: "observed-space",
      label: input.source.observationSpaceLabel ?? "观测空间",
    });
  }

  const world = new Map<string, SimulationEntityRef>([
    ["world-process", { type: "world", id: "world-process", label: "世界过程" }],
    ["annual-cycle", { type: "world", id: "annual-cycle", label: "年度周期" }],
  ]);
  return new Map([
    ["character", characters],
    ["faction", factions],
    ["location", locations],
    ["world", world],
  ]);
}

function allowedEntityIds(
  input: SimulationAiProjectionInput,
): ReadonlyMap<EntityRefType, ReadonlySet<string>> {
  return new Map(
    [...allowedEntityRefs(input)].map(([type, refs]) => [
      type,
      new Set(refs.keys()),
    ]),
  );
}

function normalizeEntityType(value: unknown): EntityRefType | null {
  const type = textField(value);
  return entityTypeAliases[type] ?? null;
}

function resolveEntityRef(
  value: unknown,
  refs: ReadonlyMap<EntityRefType, ReadonlyMap<string, SimulationEntityRef>>,
  preferredTypes: readonly EntityRefType[] = [],
): SimulationEntityRef | null {
  const record = asRecord(value);
  const id = textField(typeof value === "string" ? value : record?.id);
  if (!id) return null;
  const explicitType = normalizeEntityType(record?.type);
  const types: EntityRefType[] = [
    ...(explicitType ? [explicitType] : []),
    ...preferredTypes,
    "character",
    "faction",
    "location",
    "world",
  ];
  const seen = new Set<EntityRefType>();
  for (const type of types) {
    if (seen.has(type)) continue;
    seen.add(type);
    const resolved = refs.get(type)?.get(id);
    if (resolved) return resolved;
  }
  return null;
}

function normalizeRefs(
  value: unknown,
  refs: ReadonlyMap<EntityRefType, ReadonlyMap<string, SimulationEntityRef>>,
  preferredTypes: readonly EntityRefType[] = [],
): SimulationEntityRef[] {
  return arrayField(value).flatMap((item) => {
    const resolved = resolveEntityRef(item, refs, preferredTypes);
    return resolved ? [resolved] : [];
  });
}

function normalizeFacts(
  value: unknown,
  knownFacts: ReadonlyMap<string, SimulationEvent["triggerFacts"][number]>,
): SimulationEvent["triggerFacts"] {
  return arrayField(value).flatMap((item) => {
    if (typeof item === "string") {
      const known = knownFacts.get(item.trim());
      return known ? [known] : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const id = textField(record.id);
    const label = textField(record.label);
    if (!id || !label) return [];
    const sourcePath =
      record.sourcePath === null || record.sourcePath === undefined
        ? null
        : textField(record.sourcePath) || null;
    return [
      {
        id,
        label,
        value: typeof record.value === "string" ? record.value : "",
        sourcePath,
      },
    ];
  });
}

function normalizeStateChanges(
  value: unknown,
  refs: ReadonlyMap<EntityRefType, ReadonlyMap<string, SimulationEntityRef>>,
): SimulationEvent["stateChanges"] {
  return arrayField(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const entityRef = resolveEntityRef(
      record.entityRef ?? record.entity,
      refs,
    );
    const field = textField(record.field);
    const before = typeof record.before === "string" ? record.before : record.from;
    const after = typeof record.after === "string" ? record.after : record.to;
    if (!entityRef || !field || typeof before !== "string" || typeof after !== "string") {
      return [];
    }
    return [{ entityRef, field, before, after }];
  });
}

function normalizePropagations(
  value: unknown,
  refs: ReadonlyMap<EntityRefType, ReadonlyMap<string, SimulationEntityRef>>,
  round: SimulationRound,
): z.infer<typeof aiPropagationSchema>[] {
  const channels = new Set(["message", "travel", "trade", "politics", "ecology"]);
  const statuses = new Set(["pending", "arrived", "blocked"]);
  return arrayField(value).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const targetSpaceId = textField(record.targetSpaceId);
    const channel = textField(record.channel);
    const status = textField(record.status);
    const arrivesAt = record.arrivesAt;
    if (
      !targetSpaceId ||
      !refs.get("location")?.has(targetSpaceId) ||
      !channels.has(channel) ||
      !statuses.has(status) ||
      typeof arrivesAt !== "number" ||
      !Number.isInteger(arrivesAt) ||
      arrivesAt < round.startTime ||
      arrivesAt > round.endTime
    ) {
      return [];
    }
    return [
      {
        targetSpaceId,
        channel: channel as z.infer<typeof aiPropagationSchema>["channel"],
        arrivesAt,
        status: status as z.infer<typeof aiPropagationSchema>["status"],
        summary: typeof record.summary === "string" ? record.summary : "",
      },
    ];
  });
}

function normalizeAiEvent(
  value: unknown,
  context: {
    readonly refs: ReadonlyMap<
      EntityRefType,
      ReadonlyMap<string, SimulationEntityRef>
    >;
    readonly knownFacts: ReadonlyMap<
      string,
      SimulationEvent["triggerFacts"][number]
    >;
    readonly knownEventIds: ReadonlySet<string>;
    readonly knownRuleIds: ReadonlySet<string>;
    readonly round: SimulationRound;
  },
): z.infer<typeof aiEventSchema> | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = eventKindAliases[textField(record.kind)];
  const source = eventSourceAliases[textField(record.source)];
  const title = textField(record.title);
  const time = record.time;
  if (
    !kind ||
    !source ||
    !title ||
    typeof time !== "number" ||
    !Number.isInteger(time) ||
    time < context.round.startTime ||
    time > context.round.endTime
  ) {
    return null;
  }
  const preferredActorTypes: EntityRefType[] =
    source === "character"
      ? ["character"]
      : source === "faction"
        ? ["faction"]
        : source === "world"
          ? ["world", "location"]
          : ["world", "location"];
  const certainty = certaintyAliases[textField(record.certainty)] ?? "uncertain";
  const normalized = {
    kind,
    title,
    summary: typeof record.summary === "string" ? record.summary : "",
    time,
    certainty,
    source,
    entityRefs: normalizeRefs(record.entityRefs, context.refs, preferredActorTypes),
    actorRefs: normalizeRefs(record.actorRefs, context.refs, preferredActorTypes),
    locationRef: resolveEntityRef(record.locationRef, context.refs, ["location"]),
    targetRefs: normalizeRefs(record.targetRefs, context.refs),
    triggerFacts: normalizeFacts(record.triggerFacts, context.knownFacts),
    decision: typeof record.decision === "string" ? record.decision : "",
    action: typeof record.action === "string" ? record.action : "",
    stateChanges: normalizeStateChanges(record.stateChanges, context.refs),
    uncertainty:
      typeof record.uncertainty === "string" ? record.uncertainty : "",
    causeEventIds: arrayField(record.causeEventIds).filter(
      (id): id is string =>
        typeof id === "string" && context.knownEventIds.has(id.trim()),
    ),
    propagations: normalizePropagations(
      record.propagations,
      context.refs,
      context.round,
    ),
    ruleIds: arrayField(record.ruleIds).filter(
      (id): id is string =>
        typeof id === "string" && context.knownRuleIds.has(id.trim()),
    ),
  };
  const result = aiEventSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

function projectionPromptContext(input: SimulationAiProjectionInput): string {
  const locationIds = [
    ...(input.source.locations?.map((item) => item.id) ?? []),
    ...(input.source.factions?.flatMap((item) => item.territoryIds ?? []) ??
      []),
    ...(input.source.observationSpaceId
      ? [input.source.observationSpaceId]
      : []),
  ];
  return JSON.stringify(
    {
      run: {
        id: input.run.id,
        currentTime: input.run.currentTime,
        endTime: input.run.endTime,
        endTimeAmount: input.run.endTimeAmount,
        endTimeUnit: input.run.endTimeUnit,
        timeScale: input.run.timeScale,
        timeStep: input.run.timeStep,
        observationSpaceIds: input.run.observationSpaceIds,
        observationSpaceLabel: input.run.observationSpaceLabel,
        observer: input.run.observer,
        observationTargets: input.run.observationTargets ?? [],
        baselineChapterId: input.run.baselineChapterId ?? null,
        baselineChapterLabel: input.run.baselineChapterLabel ?? null,
      },
      round: {
        index: input.round.index,
        startTime: input.round.startTime,
        endTime: input.round.endTime,
      },
      source: {
        characterCount: input.source.characterCount,
        factionCount: input.source.factionCount,
        locationCount: input.source.locationCount,
        timelineEventCount: input.source.timelineEventCount,
        observationSpaceId: input.source.observationSpaceId,
        observationSpaceLabel: input.source.observationSpaceLabel,
        baselineChapter: input.source.baselineChapter
          ? {
              id: input.source.baselineChapter.id,
              displayNumber: input.source.baselineChapter.displayNumber,
              title: input.source.baselineChapter.title,
              path: input.source.baselineChapter.path,
              content: input.source.baselineChapter.content.slice(0, 12_000),
            }
          : null,
        diagnostics: input.source.diagnostics ?? [],
        characters: (input.source.characters ?? []).slice(0, 64),
        factions: (input.source.factions ?? []).slice(0, 64),
        locations: (input.source.locations ?? []).slice(0, 96),
        timelineEvents: (input.source.timelineEvents ?? []).slice(-32),
      },
      hardEvents: input.hardEvents.map((event) => ({
        id: event.id,
        kind: event.kind,
        title: event.title,
        summary: event.summary,
        time: event.time,
        ruleIds: event.ruleIds,
      })),
      recentEvents: input.historicalEvents.slice(-12).map((event) => ({
        id: event.id,
        kind: event.kind,
        title: event.title,
        summary: event.summary,
        time: event.time,
      })),
      allowedEntityRefs: {
        character: input.source.characters?.length
          ? input.source.characters.map((item) => item.id)
          : ["active-characters"],
        faction: input.source.factions?.length
          ? input.source.factions.map((item) => item.id)
          : ["active-factions"],
        location: locationIds.length ? locationIds : ["observed-space"],
        world: ["world-process", "annual-cycle"],
      },
    },
    null,
    2,
  );
}

export function buildSimulationAiPrompt(
  input: SimulationAiProjectionInput,
): string {
  return [
    "你是小说工作台的 AI 故事生成层。请依据小说工作台内置工具读取正式人物、势力、世界、时间线和修行事实，再为当前轮次生成事件候选。",
    "时间调度只提供当前轮次的时间窗口和硬约束事实；你不能改写时间、创建未被资料支持的稳定实体，也不能把推测写成 confirmed。",
    '只返回 JSON，不要 Markdown、解释或代码围栏。格式必须是 {"narrative":"故事正文","events":[...]}，events 最多 8 项。',
    "narrative 是给作者直接阅读的中文故事，不是字段清单：按时间顺序连贯叙述人物发生了什么、冲突如何出现、人物做了什么决策、势力如何反应、世界过程如何变化、是否诞生了新人物或新势力、他们接下来可能如何行动，以及当地人民的生活状态变化。只写本轮窗口内有依据的结果；没有依据的内容使用‘可能’‘尚未确认’，即使某个候选没有可引用的正式触发事实也可以保留，但必须让故事语气保持不确定，不要把事件数组逐条机械复述。",
    "只读工具最多调用 10 次；工具达到调用上限、返回空结果或调用失败时，不要向作者解释原因，立即依据已经取得的资料返回 JSON。资料不足以形成结构化事件时，仍要根据已经读取到的正式事实返回 narrative；此时 events 可以为空，但 narrative 必须说明当前人物、势力、世界过程或民生正在发生的、可被事实支持的变化。只有完全没有可用事实时，才返回 narrative 为空且 events 为空。不得输出拒绝说明或自然语言。",
    "每个事件必须包含 kind、title、summary、time、certainty、source、entityRefs、actorRefs、locationRef、targetRefs、triggerFacts、decision、action、stateChanges、uncertainty、causeEventIds、propagations、ruleIds。每条非诊断事件至少要有一个真实 actorRef 或 world/location 引用，并且 summary 要写出具体主体、地点和行动；没有真实主体时返回空 events。certainty 只能使用 inferred、uncertain、blocked、aggregated；没有证据时使用 uncertain。triggerFacts 可以为空：有正式事实时填写 {id,label,value,sourcePath}，没有可引用事实时保持空数组，不得为了通过校验虚构事实；此时 certainty 使用 uncertain，并在 uncertainty 中说明事实缺口。",
    "time 必须位于当前轮次 startTime 和 endTime（含边界）之间。entityRefs、actorRefs、targetRefs、locationRef 和 stateChanges.entityRef 只能使用上下文提供的 allowedEntityRefs；不确定主体请留空，不要伪造 ID。causeEventIds 只能引用 hardEvents 或 recentEvents 中列出的 ID；ruleIds 只能引用 hardEvents 中列出的规则 ID。",
    "propagations 可以为空；若填写，只写 targetSpaceId、channel、arrivesAt、status、summary，arrivesAt 必须落在本轮时间窗口内。",
    "以下是本轮最小上下文：",
    projectionPromptContext(input),
  ].join("\n\n");
}

export function buildSimulationAiRepairPrompt(
  input: SimulationAiProjectionInput,
  rawOutput: string,
  validationError?: string,
): string {
  const characterRefs =
    input.source.characters?.map((item) => ({
      type: "character" as const,
      id: item.id,
      label: item.name,
    })) ?? [];
  if (!characterRefs.length) {
    characterRefs.push({
      type: "character",
      id: "active-characters",
      label: "当前人物集合",
    });
  }
  const factionRefs =
    input.source.factions?.map((item) => ({
      type: "faction" as const,
      id: item.id,
      label: item.name,
    })) ?? [];
  if (!factionRefs.length) {
    factionRefs.push({
      type: "faction",
      id: "active-factions",
      label: "当前势力集合",
    });
  }
  const locationRefs = [
    ...(input.source.locations?.map((item) => ({
      type: "location" as const,
      id: item.id,
      label: item.name,
    })) ?? []),
    ...(input.source.factions?.flatMap(
      (item) =>
        item.territoryIds?.map((id) => ({
          type: "location" as const,
          id,
          label: id,
        })) ?? [],
    ) ?? []),
  ];
  if (!locationRefs.length) {
    locationRefs.push({
      type: "location",
      id: input.source.observationSpaceId ?? "observed-space",
      label: input.source.observationSpaceLabel ?? "观测空间",
    });
  }
  const referenceContext = {
    allowedEntityRefs: {
      character: characterRefs,
      faction: factionRefs,
      location: locationRefs,
      world: [
        { type: "world", id: "world-process", label: "世界过程" },
        { type: "world", id: "annual-cycle", label: "年度周期" },
      ],
    },
    allowedCauseEventIds: [
      ...input.hardEvents.map((event) => event.id),
      ...input.historicalEvents.map((event) => event.id),
    ],
    allowedRuleIds: input.hardEvents.flatMap((event) => event.ruleIds),
  };
  return [
    "你是世界推演结果的 JSON 格式整理器。不要调用任何工具，不要读取新资料，不要补造原始输出没有表达的事实。只保留能够使用下方允许引用和当前契约完整校验的事件；缺少 triggerFacts 不是格式错误，应保留事件并使用 certainty=uncertain，在 uncertainty 中说明事实缺口；真正无法安全转换的事件才直接丢弃，不要为了保留它而编造 ID。",
    '只返回一个 JSON 对象，格式必须是 {"narrative":"故事正文","events":[...]}；如果原始输出包含基于已取得事实的连续故事，即使没有明确事件字段，也要把故事原文放入 narrative 并令 events 为空；只有原始输出是拒绝、说明、道歉或没有任何可用事实时，才返回 {"narrative":"","events":[]}。不要 Markdown、代码围栏或解释。',
    `当前轮次时间窗口：${input.round.startTime} 至 ${input.round.endTime}。每个事件必须使用当前契约：kind 只能是 world-process、character-action、faction-strategy、life-cycle、propagation、resource、diagnostic；source 只能是 character、faction、world、system；entityRefs、actorRefs、targetRefs、locationRef 和 stateChanges.entityRef 必须是下方允许的 {type,id,label} 对象，不能是字符串；triggerFacts 可以为空，有事实时每项必须是 {id,label,value,sourcePath} 对象，没有事实时保持 []，不要虚构；无事实事件使用 certainty=uncertain，并在 uncertainty 说明事实缺口；stateChanges 必须是 {entityRef,field,before,after}，把 from/to 改为 before/after，把 entity 改为 entityRef。旧 kind 如 world、character、faction、life 分别转换为 world-process、character-action、faction-strategy、life-cycle；旧 source world-process、character-action、faction-strategy 转换为 world、character、faction。事件时间和传播到达时间必须在窗口内；causeEventIds、ruleIds 只能使用允许列表。真正无法满足这些约束的事件才不要输出。`,
    `允许使用的引用和 ID：\n${JSON.stringify(referenceContext, null, 2)}`,
    validationError
      ? `上一次本地校验失败，必须修复这些问题：${validationError}`
      : "",
    "以下是第一次运行的原始模型输出，仅把其中已经明确存在的事件整理成 JSON：",
    `<raw-model-output>\n${rawOutput.trim().slice(0, 24_000)}\n</raw-model-output>`,
  ].join("\n\n");
}

function assertKnownRef(
  ref: SimulationEntityRef,
  allowed: ReadonlyMap<SimulationEntityRef["type"], ReadonlySet<string>>,
): void {
  if (!allowed.get(ref.type)?.has(ref.id)) {
    throw new Error(`AI 推演引用了未授权实体：${ref.type}/${ref.id}`);
  }
}

export function projectSimulationAiEvents(
  output: string,
  input: SimulationAiProjectionInput,
): SimulationAiProjectionResult {
  let payload: z.infer<typeof aiPayloadSchema>;
  let droppedEventCount = 0;
  try {
    const parsed = parsePayload(output, input);
    payload = parsed.payload;
    droppedEventCount = parsed.droppedEventCount;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("不是有效 JSON")) {
      throw new SimulationAiJsonParseError(cause.message, output);
    }
    throw cause;
  }
  const allowedRefs = allowedEntityIds(input);
  const hasConcreteEntityFacts = [
    ...(input.source.characters ?? []).map(
      (item) =>
        item.name !== item.id ||
        Boolean(
          item.goals ||
            item.motivation ||
            item.status ||
            item.currentLocationId,
        ),
    ),
    ...(input.source.factions ?? []).map(
      (item) => item.name !== item.id || Boolean(item.summary || item.status),
    ),
    ...(input.source.locations ?? []).map((item) => item.name !== item.id),
  ].some(Boolean);
  const events = payload.events.flatMap((candidate, position) => {
    // 归一化已经过滤了未知引用、越界时间和非法传播边。剩余的业务
    // 约束如果仍不满足，只丢弃该候选，避免让一条坏事件阻断故事正文。
    const hasSubject =
      candidate.actorRefs.length > 0 ||
      candidate.entityRefs.length > 0 ||
      Boolean(candidate.locationRef);
    if (
      candidate.kind !== "diagnostic" &&
      !hasSubject &&
      hasConcreteEntityFacts
    ) {
      droppedEventCount += 1;
      return [];
    }
    if (
      (candidate.kind === "character-action" ||
        candidate.kind === "faction-strategy") &&
      hasConcreteEntityFacts &&
      candidate.actorRefs.length === 0
    ) {
      droppedEventCount += 1;
      return [];
    }
    if (
      candidate.kind === "propagation" &&
      (candidate.causeEventIds.length === 0 ||
        candidate.propagations.length === 0)
    ) {
      droppedEventCount += 1;
      return [];
    }
    candidate.entityRefs.forEach((ref) => assertKnownRef(ref, allowedRefs));
    candidate.actorRefs.forEach((ref) => assertKnownRef(ref, allowedRefs));
    candidate.targetRefs.forEach((ref) => assertKnownRef(ref, allowedRefs));
    if (candidate.locationRef) assertKnownRef(candidate.locationRef, allowedRefs);
    candidate.stateChanges.forEach((change) =>
      assertKnownRef(change.entityRef, allowedRefs),
    );
    const id = `${input.run.id}-r${input.round.index}-ai${position}`;
    const hasTriggerFacts = candidate.triggerFacts.length > 0;
    const certainty =
      !hasTriggerFacts && candidate.certainty === "inferred"
        ? "uncertain"
        : candidate.certainty;
    const uncertainty =
      !hasTriggerFacts && !candidate.uncertainty.trim()
        ? missingTriggerFactsUncertainty
        : candidate.uncertainty;
    const event = simulationEventSchema.parse({
      id,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      time: candidate.time,
      certainty,
      source: candidate.source,
      entityRefs: candidate.entityRefs,
      actorRefs: candidate.actorRefs,
      locationRef: candidate.locationRef,
      targetRefs: candidate.targetRefs,
      triggerFacts: candidate.triggerFacts,
      decision: candidate.decision,
      action: candidate.action,
      stateChanges: candidate.stateChanges,
      uncertainty,
      causeEventIds: candidate.causeEventIds,
      propagations: candidate.propagations.map(
        (propagation, propagationIndex) =>
          simulationPropagationSchema.parse({
            id: `${id}-p${propagationIndex}`,
            sourceEventId: id,
            sourceSpaceId: input.source.observationSpaceId ?? null,
            ...propagation,
          }),
      ),
      ruleIds: candidate.ruleIds,
    });
    return [event];
  });
  return {
    events,
    narrative: payload.narrative.trim(),
    rawOutput: output,
    droppedEventCount,
  };
}

export function describeSimulationAiInput(input: SimulationAiProjectionInput): {
  readonly prompt: string;
  readonly allowedKinds: readonly SimulationEventKind[];
} {
  return {
    prompt: buildSimulationAiPrompt(input),
    allowedKinds: simulationEventKindSchema.options,
  };
}

export function createSimulationAiInput(
  result: SimulationAdvanceResult,
  historicalEvents: readonly SimulationEvent[],
  source: SimulationEngineInputs,
): SimulationAiProjectionInput {
  return {
    run: result.run,
    round: result.round,
    hardEvents: result.events,
    historicalEvents,
    source,
  };
}
