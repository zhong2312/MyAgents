import { z } from "zod";

export const MANUSCRIPT_TRACKING_SCHEMA_VERSION = 3 as const;
export const MANUSCRIPT_TRACKING_PATH = "manuscript/state-ledger.json";
export const MANUSCRIPT_CONTINUITY_PATH = "manuscript/continuity-state.json";

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

function migrateTrackingLedger(source: Record<string, unknown>): unknown {
  const rawBatches = Array.isArray(source.batches) ? source.batches : [];
  const batches = rawBatches.map((batch) => {
    if (!batch || typeof batch !== "object") return batch;
    const record = batch as Record<string, unknown>;
    return {
      ...record,
      mutations: Array.isArray(record.mutations) ? record.mutations : [],
      changes: Array.isArray(record.changes)
        ? record.changes.map((change) => {
            if (!change || typeof change !== "object") return change;
            const changeRecord = change as Record<string, unknown>;
            const operation = changeRecord.operation;
            return {
              ...changeRecord,
              operation:
                operation &&
                typeof operation === "object" &&
                !Array.isArray(operation) &&
                (operation as Record<string, unknown>).kind === "foreshadow"
                  ? {
                      ...(operation as Record<string, unknown>),
                      foreshadowingId:
                        (operation as Record<string, unknown>)
                          .foreshadowingId ?? null,
                    }
                  : source.schemaVersion === 1
                    ? null
                    : operation,
            };
          })
        : record.changes,
    };
  });
  const baselines: Record<string, unknown | null> = {};
  const orderedBatches = [...batches]
    .filter((batch): batch is Record<string, unknown> =>
      Boolean(batch && typeof batch === "object"),
    )
    .sort(
      (left, right) =>
        String(left.appliedAt ?? left.createdAt ?? "").localeCompare(
          String(right.appliedAt ?? right.createdAt ?? ""),
        ) ||
        String(left.createdAt ?? "").localeCompare(
          String(right.createdAt ?? ""),
        ),
    );
  for (const batch of orderedBatches) {
    if (!Array.isArray(batch.mutations)) continue;
    for (const candidate of batch.mutations) {
      if (!candidate || typeof candidate !== "object") continue;
      const mutation = candidate as Record<string, unknown>;
      const targetKey =
        typeof mutation.targetKey === "string" ? mutation.targetKey : "";
      if (targetKey && !(targetKey in baselines)) {
        baselines[targetKey] = mutation.before ?? null;
      }
    }
  }
  return {
    ...source,
    schemaVersion: MANUSCRIPT_TRACKING_SCHEMA_VERSION,
    baselines,
    batches,
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
  if (!parsed.success && source && typeof source === "object") {
    const legacy = source as {
      schemaVersion?: unknown;
      batches?: unknown;
    };
    if (
      (legacy.schemaVersion === 1 || legacy.schemaVersion === 2) &&
      Array.isArray(legacy.batches)
    ) {
      const migrated = manuscriptTrackingLedgerSchema.safeParse(
        migrateTrackingLedger(source as Record<string, unknown>),
      );
      if (migrated.success) return migrated.data;
    }
  }
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
