import { z } from "zod";

export const SIMULATION_SCHEMA_VERSION = 1 as const;
export const SIMULATION_STORAGE_VERSION = 1 as const;
export const SIMULATION_INDEX_PATH = "world/simulations/index.json";
export const SIMULATION_DEFAULT_AI_TIMEOUT_MINUTES = 5 as const;
export const SIMULATION_MIN_AI_TIMEOUT_MINUTES = 1 as const;
export const SIMULATION_MAX_AI_TIMEOUT_MINUTES = 10 as const;

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);
const dateSchema = z.string().datetime();

export const simulationTimeScaleSchema = z.enum([
  "day",
  "month",
  "year",
  // 保留旧运行的单位值，新的配置界面只提供下方六种用户单位。
  "century",
  "millennium",
  "era",
  "ten-thousand-year",
  "ten-million-year",
  "hundred-million-year",
]);
export type SimulationTimeScale = z.infer<typeof simulationTimeScaleSchema>;

export const simulationRunStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "error",
]);
export type SimulationRunStatus = z.infer<typeof simulationRunStatusSchema>;

export const simulationBaselineModeSchema = z.enum([
  "timeline-current",
  "after-chapter",
  "before-chapter",
  "branch-from-chapter",
]);
export type SimulationBaselineMode = z.infer<
  typeof simulationBaselineModeSchema
>;

export const simulationObserverSchema = z.enum([
  "ensemble",
  "character",
  "faction",
  "location",
]);
export type SimulationObserver = z.infer<typeof simulationObserverSchema>;

export const simulationEventKindSchema = z.enum([
  "world-process",
  "character-action",
  "faction-strategy",
  "life-cycle",
  "propagation",
  "resource",
  "diagnostic",
]);
export type SimulationEventKind = z.infer<typeof simulationEventKindSchema>;

export const simulationEventCertaintySchema = z.enum([
  "confirmed",
  "inferred",
  "uncertain",
  "blocked",
  "aggregated",
]);
export type SimulationEventCertainty = z.infer<
  typeof simulationEventCertaintySchema
>;

export const simulationEntityRefSchema = z
  .object({
    type: z.enum(["character", "faction", "location", "world"]),
    id: idSchema,
    label: z.string().trim().min(1),
  })
  .strict();
export type SimulationEntityRef = z.infer<typeof simulationEntityRefSchema>;

export const simulationObservationTargetSchema = z
  .object({
    type: z.enum(["character", "faction"]),
    id: idSchema,
    label: z.string().trim().min(1),
  })
  .strict();
export type SimulationObservationTarget = z.infer<
  typeof simulationObservationTargetSchema
>;

export const simulationPropagationSchema = z
  .object({
    id: idSchema,
    sourceEventId: idSchema,
    sourceSpaceId: idSchema.nullable(),
    targetSpaceId: idSchema,
    channel: z.enum(["message", "travel", "trade", "politics", "ecology"]),
    arrivesAt: z.number().int().nonnegative(),
    status: z.enum(["pending", "arrived", "blocked"]),
    summary: z.string(),
  })
  .strict();
export type SimulationPropagation = z.infer<typeof simulationPropagationSchema>;

const simulationFactSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1),
    value: z.string(),
    sourcePath: z.string().trim().min(1).nullable().default(null),
  })
  .strict();
export type SimulationFact = z.infer<typeof simulationFactSchema>;

const simulationStateChangeSchema = z
  .object({
    entityRef: simulationEntityRefSchema,
    field: z.string().trim().min(1),
    before: z.string(),
    after: z.string(),
  })
  .strict();
export type SimulationStateChange = z.infer<typeof simulationStateChangeSchema>;

export const simulationEventSchema = z
  .object({
    id: idSchema,
    kind: simulationEventKindSchema,
    title: z.string().trim().min(1),
    summary: z.string(),
    time: z.number().int().nonnegative(),
    certainty: simulationEventCertaintySchema,
    source: z.enum(["rule", "character", "faction", "world", "system"]),
    entityRefs: z.array(simulationEntityRefSchema),
    actorRefs: z.array(simulationEntityRefSchema).default([]),
    locationRef: simulationEntityRefSchema.nullable().default(null),
    targetRefs: z.array(simulationEntityRefSchema).default([]),
    triggerFacts: z.array(simulationFactSchema).default([]),
    decision: z.string().default(""),
    action: z.string().default(""),
    stateChanges: z.array(simulationStateChangeSchema).default([]),
    uncertainty: z.string().default(""),
    causeEventIds: z.array(idSchema),
    propagations: z.array(simulationPropagationSchema),
    ruleIds: z.array(idSchema),
  })
  .strict();
export type SimulationEvent = z.infer<typeof simulationEventSchema>;

export const simulationBoundaryKindSchema = z.enum([
  "action-complete",
  "message-arrival",
  "resource-node",
  "cycle",
  "timeline-fact",
  "scale-limit",
  "run-end",
]);
export type SimulationBoundaryKind = z.infer<
  typeof simulationBoundaryKindSchema
>;

export const simulationBoundarySchema = z
  .object({
    kind: simulationBoundaryKindSchema,
    reason: z.string().trim().min(1),
    scheduledAt: z.number().int().nonnegative(),
    sourceEntity: simulationEntityRefSchema.nullable(),
    sourceEventId: idSchema.nullable(),
  })
  .strict();
export type SimulationBoundary = z.infer<typeof simulationBoundarySchema>;

export const simulationRoundSchema = z
  .object({
    id: idSchema,
    index: z.number().int().nonnegative(),
    status: z.enum(["pending", "running", "completed", "error"]),
    startTime: z.number().int().nonnegative(),
    endTime: z.number().int().nonnegative(),
    eventIds: z.array(idSchema),
    narrative: z.string().default(""),
    boundary: simulationBoundarySchema.nullable().optional(),
    nextBoundary: simulationBoundarySchema.nullable().optional(),
    checkpoint: z.boolean(),
    createdAt: dateSchema,
    completedAt: dateSchema.nullable(),
  })
  .strict()
  .superRefine((round, context) => {
    if (round.endTime < round.startTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "轮次结束时间不能早于开始时间",
      });
    }
  });
export type SimulationRound = z.infer<typeof simulationRoundSchema>;

export const simulationDiagnosticsSchema = z
  .object({
    id: idSchema,
    severity: z.enum(["error", "warning", "info"]),
    code: idSchema,
    message: z.string(),
    sourcePath: z.string().nullable(),
  })
  .strict();
export type SimulationDiagnostic = z.infer<typeof simulationDiagnosticsSchema>;

export const simulationRunSchema = z
  .object({
    schemaVersion: z.literal(SIMULATION_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1),
    status: simulationRunStatusSchema,
    baselineMode: simulationBaselineModeSchema,
    baselineSourceHash: z.string().trim().min(1),
    baselineLabel: z.string().trim().min(1),
    parentRunId: idSchema.nullable(),
    forkRoundId: idSchema.nullable(),
    startTime: z.number().int().nonnegative(),
    currentTime: z.number().int().nonnegative(),
    endTime: z.number().int().positive(),
    timeScale: simulationTimeScaleSchema,
    timeStep: z.number().int().positive().max(10_000).default(1),
    /** 用户配置的总范围原始数值与单位；旧运行仅有 endTime 时保持兼容。 */
    endTimeAmount: z.number().int().positive().max(10_000).optional(),
    endTimeUnit: simulationTimeScaleSchema.optional(),
    /** 单次世界推演 AI 请求的超时时间，旧运行缺失时按默认值处理。 */
    aiTimeoutMinutes: z
      .number()
      .int()
      .min(SIMULATION_MIN_AI_TIMEOUT_MINUTES)
      .max(SIMULATION_MAX_AI_TIMEOUT_MINUTES)
      .optional(),
    observationSpaceIds: z.array(idSchema),
    observationSpaceLabel: z.string().trim().min(1),
    observer: simulationObserverSchema,
    observerId: idSchema.nullable(),
    /** 新运行使用稳定的人物/势力引用；旧运行缺少时表示不筛选。 */
    observationTargets: z
      .array(simulationObservationTargetSchema)
      .max(64)
      .optional(),
    /** 章节起点只保存可追溯引用，不将章节计划视为正式时间线事实。 */
    baselineChapterId: idSchema.optional(),
    baselineChapterLabel: z.string().trim().min(1).optional(),
    seed: z.number().int().nonnegative(),
    engineVersion: z.string().trim().min(1),
    rulesetVersion: z.string().trim().min(1),
    currentRoundId: idSchema.nullable(),
    roundsCompleted: z.number().int().nonnegative(),
    diagnostics: z.array(simulationDiagnosticsSchema),
    createdAt: dateSchema,
    updatedAt: dateSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.currentTime < run.startTime) {
      context.addIssue({
        code: "custom",
        path: ["currentTime"],
        message: "当前时间不能早于起始时间",
      });
    }
    if (run.endTime <= run.startTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "终止时间必须晚于起始时间",
      });
    }
    if (run.currentTime > run.endTime) {
      context.addIssue({
        code: "custom",
        path: ["currentTime"],
        message: "当前时间不能晚于终止时间",
      });
    }
  });
export type SimulationRun = z.infer<typeof simulationRunSchema>;

export const simulationIndexSchema = z
  .object({
    schemaVersion: z.literal(SIMULATION_SCHEMA_VERSION),
    storageVersion: z.literal(SIMULATION_STORAGE_VERSION),
    activeRunId: idSchema.nullable(),
    runs: z.array(
      z
        .object({
          id: idSchema,
          path: z.string(),
          name: z.string().trim().min(1),
          status: simulationRunStatusSchema,
          updatedAt: dateSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    index.runs.forEach((entry, position) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["runs", position, "id"],
          message: "运行 id 不得重复",
        });
      }
      ids.add(entry.id);
      if (entry.path !== `world/simulations/runs/${entry.id}/manifest.json`) {
        context.addIssue({
          code: "custom",
          path: ["runs", position, "path"],
          message: "运行 manifest 路径必须与运行 id 对应",
        });
      }
    });
    if (index.activeRunId && !ids.has(index.activeRunId)) {
      context.addIssue({
        code: "custom",
        path: ["activeRunId"],
        message: "活动运行不存在",
      });
    }
  });
export type SimulationIndex = z.infer<typeof simulationIndexSchema>;

export interface SimulationRunFiles {
  readonly manifest: SimulationRun;
  readonly rounds: readonly SimulationRound[];
  readonly events: readonly SimulationEvent[];
}

export function parseSimulationJson<T>(
  path: string,
  schema: z.ZodType<T>,
  content: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${path} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${path} 格式无效：${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return result.data;
}

export function serializeSimulationJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
