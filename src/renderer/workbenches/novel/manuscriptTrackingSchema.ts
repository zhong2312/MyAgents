import { z } from "zod";

import {
  MANUSCRIPT_TRACKING_INDEX_PATH,
  MANUSCRIPT_TRACKING_STORAGE_VERSION,
} from "../../../shared/workbenches/novel/manuscriptTrackingStorage";
import {
  MANUSCRIPT_CONTINUITY_INDEX_PATH,
  MANUSCRIPT_CONTINUITY_STORAGE_VERSION,
} from "../../../shared/workbenches/novel/manuscriptContinuityStorage";

export const MANUSCRIPT_TRACKING_SCHEMA_VERSION = 3 as const;
export const MANUSCRIPT_TRACKING_PATH = MANUSCRIPT_TRACKING_INDEX_PATH;
export const MANUSCRIPT_CONTINUITY_PATH = MANUSCRIPT_CONTINUITY_INDEX_PATH;
export { MANUSCRIPT_TRACKING_STORAGE_VERSION };
export { MANUSCRIPT_CONTINUITY_STORAGE_VERSION };

const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

export const manuscriptTrackingDomainSchema = z.enum([
  "timeline",
  "character-appearance",
  "character-state",
  "relationship",
  "inventory",
  "location",
  "faction",
  "foreshadow",
  "world-rule",
  "continuity",
]);
export type ManuscriptTrackingDomain = z.infer<
  typeof manuscriptTrackingDomainSchema
>;

export const manuscriptTrackingOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timeline-event"),
      eventKind: z.enum([
        "event",
        "turning-point",
        "battle",
        "discovery",
        "foreshadowing",
        "backstory",
      ]),
      timeLabel: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("character-appearance") }).strict(),
  z
    .object({
      kind: z.literal("character-field"),
      field: z.enum([
        "status",
        "currentRealm",
        "goals",
        "motivation",
        "hometown",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("relationship"),
      targetCharacterId: stableIdSchema,
      relationType: z.string().trim().min(1),
      tone: z.enum(["positive", "negative", "neutral"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inventory"),
      itemId: stableIdSchema.nullable(),
      name: z.string().trim().min(1),
      quantity: z.number().finite().min(0),
      unit: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("location-field"),
      field: z.enum(["status", "appearanceNote", "summary"]),
      status: z.enum(["planned", "appeared", "archived"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("faction-field"),
      field: z.enum([
        "status",
        "summary",
        "governance",
        "military",
        "economy",
        "publicSupport",
        "territorialIntegrity",
      ]),
      status: z
        .enum(["active", "neutral", "declining", "dissolved"])
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("foreshadow"),
      foreshadowingId: stableIdSchema.nullable().default(null),
      status: z.enum(["planted", "paid-off", "abandoned"]),
      payoffEventId: stableIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("continuity-fact"),
      key: stableIdSchema,
    })
    .strict(),
]);

export type ManuscriptTrackingOperation = z.infer<
  typeof manuscriptTrackingOperationSchema
>;

export const manuscriptTrackingChangeSchema = z
  .object({
    id: stableIdSchema,
    domain: manuscriptTrackingDomainSchema,
    entityId: stableIdSchema.nullable(),
    title: z.string().trim().min(1),
    before: z.string().nullable(),
    after: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    operation: manuscriptTrackingOperationSchema.nullable(),
  })
  .strict();

export type ManuscriptTrackingChange = z.infer<
  typeof manuscriptTrackingChangeSchema
>;

export interface ManuscriptTrackingReferenceCatalog {
  readonly characterIds?: ReadonlySet<string>;
  readonly itemIds?: ReadonlySet<string>;
  readonly locationIds?: ReadonlySet<string>;
  readonly factionIds?: ReadonlySet<string>;
  readonly foreshadowingIds?: ReadonlySet<string>;
}

/** 校验状态操作是否具备同步所需的实体引用；目录参数缺省时只校验结构。 */
export function getManuscriptTrackingReferenceIssue(
  change: Pick<ManuscriptTrackingChange, "title" | "entityId" | "operation">,
  catalog?: ManuscriptTrackingReferenceCatalog,
): string | null {
  const operation = change.operation;
  if (!operation) return `“${change.title}”缺少可执行的状态操作`;

  const requireEntity = (
    entityId: string | null,
    label: string,
    ids?: ReadonlySet<string>,
  ): string | null => {
    if (!entityId) return `“${change.title}”缺少关联${label}`;
    if (ids && !ids.has(entityId)) {
      return `“${change.title}”关联的${label}不存在：${entityId}`;
    }
    return null;
  };

  if (
    operation.kind === "character-appearance" ||
    operation.kind === "character-field" ||
    operation.kind === "relationship" ||
    operation.kind === "inventory"
  ) {
    const characterIssue = requireEntity(
      change.entityId,
      "人物",
      catalog?.characterIds,
    );
    if (characterIssue) return characterIssue;
    if (
      operation.kind === "relationship" &&
      catalog?.characterIds &&
      !catalog.characterIds.has(operation.targetCharacterId)
    ) {
      return `“${change.title}”关联的目标人物不存在：${operation.targetCharacterId}`;
    }
    if (
      operation.kind === "inventory" &&
      operation.itemId &&
      catalog?.itemIds &&
      !catalog.itemIds.has(operation.itemId)
    ) {
      return `“${change.title}”关联的物品不存在：${operation.itemId}`;
    }
    return null;
  }

  if (operation.kind === "location-field") {
    return requireEntity(change.entityId, "地点", catalog?.locationIds);
  }
  if (operation.kind === "faction-field") {
    return requireEntity(change.entityId, "势力", catalog?.factionIds);
  }
  if (operation.kind === "foreshadow" && operation.status !== "planted") {
    if (!operation.foreshadowingId) {
      return `“${change.title}”缺少要更新的伏笔 ID`;
    }
    if (
      catalog?.foreshadowingIds &&
      !catalog.foreshadowingIds.has(operation.foreshadowingId)
    ) {
      return `“${change.title}”关联的伏笔不存在：${operation.foreshadowingId}`;
    }
  }
  return null;
}

export const manuscriptTrackingMutationSchema = z
  .object({
    targetKey: z.string().trim().min(1),
    targetKind: z.enum([
      "timeline-event",
      "character-appearance",
      "character-field",
      "relationship",
      "inventory",
      "location-field",
      "faction-field",
      "continuity-fact",
    ]),
    entityId: stableIdSchema.nullable(),
    relatedId: stableIdSchema.nullable(),
    field: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  })
  .strict();

export type ManuscriptTrackingMutation = z.infer<
  typeof manuscriptTrackingMutationSchema
>;

export const manuscriptTrackingBatchSchema = z
  .object({
    id: stableIdSchema,
    chapterId: z.string().regex(/^chapter-[0-9]{6}$/u),
    chapterContentHash: z.string().trim().min(1),
    summary: z.string(),
    status: z.enum(["proposed", "applied", "reverted"]),
    createdAt: z.string().datetime(),
    appliedAt: z.string().datetime().nullable(),
    revertedAt: z.string().datetime().nullable(),
    /**
     * 正文叙事顺序不等于世界时间。只有作者确认的时间线事件可为该批
     * 事实提供世界坐标；旧批次缺省时保持未定时语义。
     */
    timeAnchorEventId: stableIdSchema.nullable().optional(),
    changes: z.array(manuscriptTrackingChangeSchema),
    mutations: z.array(manuscriptTrackingMutationSchema),
  })
  .strict();

export type ManuscriptTrackingBatch = z.infer<
  typeof manuscriptTrackingBatchSchema
>;

export const manuscriptTrackingLedgerSchema = z
  .object({
    schemaVersion: z.literal(MANUSCRIPT_TRACKING_SCHEMA_VERSION),
    updatedAt: z.string().datetime(),
    baselines: z.record(z.string(), z.unknown().nullable()),
    batches: z.array(manuscriptTrackingBatchSchema),
  })
  .strict()
  .superRefine((ledger, context) => {
    const ids = new Set<string>();
    const changeIds = new Set<string>();
    ledger.batches.forEach((batch, batchIndex) => {
      if (ids.has(batch.id)) {
        context.addIssue({
          code: "custom",
          path: ["batches", batchIndex, "id"],
          message: "状态批次 id 不得重复",
        });
      }
      ids.add(batch.id);
      batch.changes.forEach((change, changeIndex) => {
        if (changeIds.has(change.id)) {
          context.addIssue({
            code: "custom",
            path: ["batches", batchIndex, "changes", changeIndex, "id"],
            message: "状态变更 id 不得重复",
          });
        }
        changeIds.add(change.id);
      });
    });
  });

export type ManuscriptTrackingLedger = z.infer<
  typeof manuscriptTrackingLedgerSchema
>;

export const manuscriptContinuityFactSchema = z
  .object({
    id: stableIdSchema,
    domain: z.enum(["world-rule", "continuity"]),
    entityId: stableIdSchema.nullable(),
    title: z.string().trim().min(1),
    value: z.string(),
    evidence: z.string(),
    chapterId: z.string().regex(/^chapter-[0-9]{6}$/u),
    batchId: stableIdSchema,
    changeId: stableIdSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ManuscriptContinuityFact = z.infer<
  typeof manuscriptContinuityFactSchema
>;

export const manuscriptContinuityStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().datetime(),
    facts: z.array(manuscriptContinuityFactSchema),
  })
  .strict();

export type ManuscriptContinuityState = z.infer<
  typeof manuscriptContinuityStateSchema
>;

export function createEmptyManuscriptTrackingLedger(
  now = new Date().toISOString(),
): ManuscriptTrackingLedger {
  return {
    schemaVersion: MANUSCRIPT_TRACKING_SCHEMA_VERSION,
    updatedAt: now,
    baselines: {},
    batches: [],
  };
}

export function parseManuscriptTrackingLedger(
  content: string,
): ManuscriptTrackingLedger {
  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `正文状态账本无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = manuscriptTrackingLedgerSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `正文状态账本格式错误：${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return parsed.data;
}

export function serializeManuscriptTrackingLedger(
  ledger: ManuscriptTrackingLedger,
): string {
  const parsed = manuscriptTrackingLedgerSchema.parse(ledger);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function createEmptyManuscriptContinuityState(
  now = new Date().toISOString(),
): ManuscriptContinuityState {
  return { schemaVersion: 1, updatedAt: now, facts: [] };
}

export function parseManuscriptContinuityState(
  content: string,
): ManuscriptContinuityState {
  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `正文连续性状态无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = manuscriptContinuityStateSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `正文连续性状态格式错误：${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return parsed.data;
}

export function serializeManuscriptContinuityState(
  state: ManuscriptContinuityState,
): string {
  const parsed = manuscriptContinuityStateSchema.parse(state);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
