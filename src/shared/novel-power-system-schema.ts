import { z } from "zod";

export const NOVEL_POWER_SYSTEM_SCHEMA_VERSION = 1 as const;

export const powerIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const textSchema = z.string();
const trimmedTextSchema = z.string().trim();

export const powerReferenceSchema = z
  .object({
    systemId: powerIdSchema,
    kind: z.enum([
      "system",
      "origin",
      "resource",
      "method",
      "capability",
      "track",
      "state",
      "rule",
      "dimension",
    ]),
    targetId: powerIdSchema,
  })
  .strict();

export type PowerReference = z.infer<typeof powerReferenceSchema>;

export const powerSubjectResourceStateSchema = z
  .object({
    resourceId: powerIdSchema,
    value: z.union([z.number().finite(), z.string(), z.null()]),
    note: textSchema,
  })
  .strict();

export const powerSubjectProfileSchema = z
  .object({
    id: powerIdSchema,
    systemId: powerIdSchema,
    stateIds: z.array(powerIdSchema),
    methodIds: z.array(powerIdSchema),
    capabilityIds: z.array(powerIdSchema),
    resourceStates: z.array(powerSubjectResourceStateSchema),
    individualRules: z.array(z.string().trim().min(1)),
    note: textSchema,
  })
  .strict();

export type PowerSubjectResourceState = z.infer<
  typeof powerSubjectResourceStateSchema
>;
export type PowerSubjectProfile = z.infer<typeof powerSubjectProfileSchema>;

export const powerSourceReferenceSchema = z
  .object({
    id: powerIdSchema,
    label: z.string().trim().min(1),
    path: trimmedTextSchema,
    anchor: trimmedTextSchema,
    note: textSchema,
  })
  .strict();

export const powerTruthMetadataSchema = z
  .object({
    settingLevel: trimmedTextSchema,
    domainCategories: z.array(z.string().trim().min(1)),
    spatialScopeIds: z.array(powerIdSchema),
    timeScope: z
      .object({ from: trimmedTextSchema, to: trimmedTextSchema })
      .strict(),
    authority: z.enum(["hard", "default", "exception", "rumor"]),
    canon: z.enum(["draft", "provisional", "canon", "deprecated"]),
    revealStage: trimmedTextSchema,
    sourceRefs: z.array(powerSourceReferenceSchema),
  })
  .strict();

export type PowerTruthMetadata = z.infer<typeof powerTruthMetadataSchema>;

const elementBaseShape = {
  id: powerIdSchema,
  name: z.string().trim().min(1),
  subtypeId: trimmedTextSchema,
  summary: textSchema,
  metadata: powerTruthMetadataSchema,
} as const;

export const powerOriginSchema = z
  .object({
    ...elementBaseShape,
    kind: z.literal("origin"),
    availability: z.enum([
      "innate",
      "learned",
      "granted",
      "environmental",
      "manufactured",
      "institutional",
      "unknown",
    ]),
  })
  .strict();

export const powerResourceSchema = z
  .object({
    ...elementBaseShape,
    kind: z.literal("resource"),
    measurement: z.enum(["numeric", "ordinal", "descriptive", "unknown"]),
    unit: trimmedTextSchema,
    minimum: z.number().finite().nullable(),
    maximum: z.number().finite().nullable(),
    recovery: textSchema,
    depletion: textSchema,
  })
  .strict();

export const powerMethodSchema = z
  .object({
    ...elementBaseShape,
    kind: z.literal("method"),
    acquisition: z.enum([
      "training",
      "study",
      "inheritance",
      "awakening",
      "implantation",
      "contract",
      "ritual",
      "equipment",
      "authorization",
      "event",
      "unknown",
    ]),
    procedure: textSchema,
  })
  .strict();

export const powerCapabilitySchema = z
  .object({
    ...elementBaseShape,
    kind: z.literal("capability"),
    activation: z.enum([
      "active",
      "passive",
      "conditional",
      "toggle",
      "ritual",
      "collective",
      "automatic",
    ]),
    effect: textSchema,
    target: textSchema,
    range: textSchema,
    duration: textSchema,
  })
  .strict();

export const powerElementSchema = z.discriminatedUnion("kind", [
  powerOriginSchema,
  powerResourceSchema,
  powerMethodSchema,
  powerCapabilitySchema,
]);

export type PowerOrigin = z.infer<typeof powerOriginSchema>;
export type PowerResource = z.infer<typeof powerResourceSchema>;
export type PowerMethod = z.infer<typeof powerMethodSchema>;
export type PowerCapability = z.infer<typeof powerCapabilitySchema>;
export type PowerElement = z.infer<typeof powerElementSchema>;

export const powerConditionClauseSchema = z
  .object({
    id: powerIdSchema,
    subject: z.string().trim().min(1),
    operator: z.enum([
      "equals",
      "not-equals",
      "contains",
      "not-contains",
      "greater-than",
      "less-than",
      "exists",
      "not-exists",
      "matches",
    ]),
    value: textSchema,
  })
  .strict();

export const powerConditionGroupSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    clauses: z.array(powerConditionClauseSchema),
  })
  .strict();

export type PowerConditionClause = z.infer<typeof powerConditionClauseSchema>;
export type PowerConditionGroup = z.infer<typeof powerConditionGroupSchema>;

export const powerStateSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    summary: textSchema,
    order: z.number().int().nonnegative(),
    metadata: powerTruthMetadataSchema,
  })
  .strict();

export const powerTransitionSchema = z
  .object({
    id: powerIdSchema,
    fromStateId: powerIdSchema.nullable(),
    toStateId: powerIdSchema,
    kind: z.enum([
      "advance",
      "branch",
      "merge",
      "regress",
      "transform",
      "recover",
      "event",
    ]),
    conditions: powerConditionGroupSchema,
    costs: z.array(z.string().trim().min(1)),
    outcomes: z.array(z.string().trim().min(1)),
    failure: textSchema,
  })
  .strict();

export const powerStateTrackSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    subtypeId: trimmedTextSchema,
    summary: textSchema,
    mode: z.enum([
      "ordered",
      "branching",
      "coexisting",
      "cyclic",
      "threshold",
      "event-driven",
      "unordered",
    ]),
    states: z.array(powerStateSchema),
    transitions: z.array(powerTransitionSchema),
    metadata: powerTruthMetadataSchema,
  })
  .strict()
  .superRefine((track, context) => {
    const ids = new Set<string>();
    track.states.forEach((state, index) => {
      if (ids.has(state.id)) {
        context.addIssue({
          code: "custom",
          path: ["states", index, "id"],
          message: "状态 id 不得重复",
        });
      }
      ids.add(state.id);
    });
    const transitionIds = new Set<string>();
    track.transitions.forEach((transition, index) => {
      if (transitionIds.has(transition.id)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "id"],
          message: "状态转换 id 不得重复",
        });
      }
      transitionIds.add(transition.id);
      if (transition.fromStateId !== null && !ids.has(transition.fromStateId)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "fromStateId"],
          message: "转换起点状态不存在",
        });
      }
      if (!ids.has(transition.toStateId)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "toStateId"],
          message: "转换目标状态不存在",
        });
      }
    });
  });

export type PowerState = z.infer<typeof powerStateSchema>;
export type PowerTransition = z.infer<typeof powerTransitionSchema>;
export type PowerStateTrack = z.infer<typeof powerStateTrackSchema>;

export const powerRuleSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    summary: textSchema,
    priority: z.number().int().min(0).max(9999),
    conditions: powerConditionGroupSchema,
    effects: z.array(z.string().trim().min(1)),
    costs: z.array(z.string().trim().min(1)),
    exceptions: z.array(z.string().trim().min(1)),
    scopeElementIds: z.array(powerIdSchema),
    metadata: powerTruthMetadataSchema,
  })
  .strict();

export const powerConnectionSideSchema = z.enum([
  "top",
  "right",
  "bottom",
  "left",
]);

export type PowerConnectionSide = z.infer<typeof powerConnectionSideSchema>;

export const powerRelationSchema = z
  .object({
    id: powerIdSchema,
    fromId: powerIdSchema,
    toId: powerIdSchema,
    kind: z.enum([
      "produces",
      "stores",
      "converts",
      "consumes",
      "requires",
      "grants",
      "unlocks",
      "amplifies",
      "suppresses",
      "counters",
      "immune-to",
      "exclusive-with",
      "replaces",
      "depends-on",
      "bound-to",
    ]),
    summary: textSchema,
    fromHandle: powerConnectionSideSchema.optional(),
    toHandle: powerConnectionSideSchema.optional(),
  })
  .strict();

export const powerDimensionSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    measurement: z.enum(["numeric", "ordinal", "descriptive"]),
    unit: trimmedTextSchema,
    lowLabel: trimmedTextSchema,
    highLabel: trimmedTextSchema,
    description: textSchema,
  })
  .strict();

export const powerBenchmarkValueSchema = z
  .object({
    dimensionId: powerIdSchema,
    minimum: z.number().finite().nullable(),
    maximum: z.number().finite().nullable(),
    label: textSchema,
  })
  .strict();

export const powerBenchmarkSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    context: textSchema,
    values: z.array(powerBenchmarkValueSchema),
  })
  .strict();

export type PowerRule = z.infer<typeof powerRuleSchema>;
export type PowerRelation = z.infer<typeof powerRelationSchema>;
export type PowerDimension = z.infer<typeof powerDimensionSchema>;
export type PowerBenchmark = z.infer<typeof powerBenchmarkSchema>;

export const powerDesignContractSchema = z
  .object({
    explanation: z.enum(["explicit", "partial", "mysterious"]),
    quantification: z.enum(["numeric", "ordinal", "descriptive", "mixed"]),
    progression: z.enum([
      "none",
      "single-track",
      "multi-track",
      "event-driven",
    ]),
    costPolicy: z.enum(["required", "recommended", "optional"]),
    comparison: z.enum(["stable", "contextual", "incomparable"]),
    exceptionPolicy: z.enum(["strict", "limited", "mythic"]),
  })
  .strict();

export const powerSystemRecordSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    id: powerIdSchema,
    name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    typeId: powerIdSchema,
    status: z.enum(["draft", "active", "archived"]),
    summary: textSchema,
    designContract: powerDesignContractSchema,
    elements: z.array(powerElementSchema),
    tracks: z.array(powerStateTrackSchema),
    rules: z.array(powerRuleSchema),
    relations: z.array(powerRelationSchema),
    dimensions: z.array(powerDimensionSchema),
    benchmarks: z.array(powerBenchmarkSchema),
    metadata: powerTruthMetadataSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    const ids = new Set<string>();
    const collections: readonly [string, readonly { readonly id: string }[]][] =
      [
        ["elements", record.elements],
        ["tracks", record.tracks],
        ["rules", record.rules],
        ["dimensions", record.dimensions],
        ["benchmarks", record.benchmarks],
      ];
    for (const [key, values] of collections) {
      values.forEach((value, index) => {
        if (ids.has(value.id)) {
          context.addIssue({
            code: "custom",
            path: [key, index, "id"],
            message: "体系内稳定 id 不得重复",
          });
        }
        ids.add(value.id);
      });
    }
    const stateIds = new Set<string>();
    record.tracks.forEach((track, trackIndex) => {
      track.states.forEach((state, stateIndex) => {
        if (ids.has(state.id) || stateIds.has(state.id)) {
          context.addIssue({
            code: "custom",
            path: ["tracks", trackIndex, "states", stateIndex, "id"],
            message: "状态 id 必须在体系内唯一",
          });
        }
        stateIds.add(state.id);
      });
    });
    const graphIds = new Set([...ids, ...stateIds]);
    const relationIds = new Set<string>();
    record.relations.forEach((relation, index) => {
      if (relationIds.has(relation.id)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "id"],
          message: "关系 id 不得重复",
        });
      }
      relationIds.add(relation.id);
      if (!graphIds.has(relation.fromId) || !graphIds.has(relation.toId)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "关系引用了不存在的体系元素",
        });
      }
    });
    const dimensionIds = new Set(record.dimensions.map((item) => item.id));
    record.benchmarks.forEach((benchmark, benchmarkIndex) => {
      benchmark.values.forEach((value, valueIndex) => {
        if (!dimensionIds.has(value.dimensionId)) {
          context.addIssue({
            code: "custom",
            path: ["benchmarks", benchmarkIndex, "values", valueIndex],
            message: "标尺值引用了不存在的维度",
          });
        }
      });
    });
  });

export type PowerDesignContract = z.infer<typeof powerDesignContractSchema>;
export type PowerSystemRecord = z.infer<typeof powerSystemRecordSchema>;

export const powerSystemTypeSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    description: textSchema,
    icon: z.string().trim().min(1),
    builtin: z.boolean(),
  })
  .strict();

export const powerSystemMetaSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    systemTypes: z.array(powerSystemTypeSchema).min(1),
  })
  .strict();

export const powerSystemIndexEntrySchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    typeId: powerIdSchema,
    status: z.enum(["draft", "active", "archived"]),
    summary: textSchema,
    recordPath: z.string().trim().min(1),
    pagePath: z.string().trim().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const powerSystemIndexSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    systems: z.array(powerSystemIndexEntrySchema),
  })
  .strict();

export type PowerSystemType = z.infer<typeof powerSystemTypeSchema>;
export type PowerSystemMeta = z.infer<typeof powerSystemMetaSchema>;
export type PowerSystemIndexEntry = z.infer<typeof powerSystemIndexEntrySchema>;
export type PowerSystemIndex = z.infer<typeof powerSystemIndexSchema>;

export const crossSystemInteractionSchema = z
  .object({
    id: powerIdSchema,
    name: z.string().trim().min(1),
    left: powerReferenceSchema,
    right: powerReferenceSchema,
    kind: z.enum([
      "amplifies",
      "suppresses",
      "counters",
      "immune-to",
      "converts",
      "compatible",
      "exclusive",
      "incomparable",
    ]),
    conditions: powerConditionGroupSchema,
    summary: textSchema,
    metadata: powerTruthMetadataSchema,
  })
  .strict();

export const powerSystemInteractionsSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    interactions: z.array(crossSystemInteractionSchema),
  })
  .strict();

export type CrossSystemInteraction = z.infer<
  typeof crossSystemInteractionSchema
>;
export type PowerSystemInteractions = z.infer<
  typeof powerSystemInteractionsSchema
>;
