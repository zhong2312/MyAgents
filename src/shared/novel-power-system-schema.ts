import { z } from "zod";

export const NOVEL_POWER_SYSTEM_SCHEMA_VERSION = 2 as const;

export const powerIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const textSchema = z.string();
const trimmedTextSchema = z.string().trim();
const nonEmptyTextSchema = z.string().trim().min(1);

export const powerSourceReferenceSchema = z
  .object({
    id: powerIdSchema,
    label: nonEmptyTextSchema,
    path: trimmedTextSchema,
    anchor: trimmedTextSchema,
    note: textSchema,
  })
  .strict();

export const powerTruthMetadataSchema = z
  .object({
    settingLevel: trimmedTextSchema,
    domainCategories: z.array(nonEmptyTextSchema),
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

export type PowerSourceReference = z.infer<typeof powerSourceReferenceSchema>;
export type PowerTruthMetadata = z.infer<typeof powerTruthMetadataSchema>;

export const powerCatalogKindSchema = z.enum([
  "foundation",
  "medium",
  "principle",
  "resource",
  "theory",
  "method",
  "capability",
]);

export const powerSystemEntityKindSchema = z.enum([
  "system",
  "track",
  "state",
  "transition",
  "quality-dimension",
  "boundary-dimension",
]);

export const powerExternalKindSchema = z.enum([
  "actor",
  "location",
  "faction",
  "item",
  "event",
  "external",
]);

export const powerCatalogReferenceSchema = z
  .object({
    namespace: z.literal("catalog"),
    kind: powerCatalogKindSchema,
    targetId: powerIdSchema,
  })
  .strict();

export const powerSystemReferenceSchema = z
  .object({
    namespace: z.literal("system"),
    systemId: powerIdSchema,
    kind: powerSystemEntityKindSchema,
    targetId: powerIdSchema,
  })
  .strict();

export const powerExternalReferenceSchema = z
  .object({
    namespace: z.literal("external"),
    kind: powerExternalKindSchema,
    targetId: powerIdSchema,
  })
  .strict();

export const powerEntityReferenceSchema = z.discriminatedUnion("namespace", [
  powerCatalogReferenceSchema,
  powerSystemReferenceSchema,
  powerExternalReferenceSchema,
]);

export type PowerCatalogKind = z.infer<typeof powerCatalogKindSchema>;
export type PowerSystemEntityKind = z.infer<typeof powerSystemEntityKindSchema>;
export type PowerExternalKind = z.infer<typeof powerExternalKindSchema>;
export type PowerCatalogReference = z.infer<typeof powerCatalogReferenceSchema>;
export type PowerSystemReference = z.infer<typeof powerSystemReferenceSchema>;
export type PowerExternalReference = z.infer<
  typeof powerExternalReferenceSchema
>;
export type PowerEntityReference = z.infer<typeof powerEntityReferenceSchema>;

const catalogEntityBaseShape = {
  id: powerIdSchema,
  name: nonEmptyTextSchema,
  aliases: z.array(nonEmptyTextSchema).default([]),
  subtypeId: trimmedTextSchema,
  summary: textSchema,
  tags: z.array(nonEmptyTextSchema).default([]),
  metadata: powerTruthMetadataSchema,
} as const;

export const powerFoundationSchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("foundation"),
    foundationType: z.enum([
      "natural",
      "biological",
      "psychic",
      "divine",
      "technological",
      "social",
      "conceptual",
      "extradimensional",
      "unknown",
    ]),
    availability: z.enum([
      "universal",
      "regional",
      "innate",
      "granted",
      "manufactured",
      "institutional",
      "event-bound",
      "unknown",
    ]),
    manifestation: textSchema,
  })
  .strict();

export const powerMediumSchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("medium"),
    mediumType: z.enum([
      "energy",
      "substance",
      "field",
      "network",
      "body",
      "mind",
      "soul",
      "symbolic",
      "device",
      "authority",
      "environment",
      "unknown",
    ]),
    carrier: textSchema,
    circulation: textSchema,
    storage: textSchema,
    loss: textSchema,
  })
  .strict();

export const powerPrincipleSchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("principle"),
    principleType: z.enum([
      "invariant",
      "prohibition",
      "boundary",
      "conversion",
      "priority",
      "axiom",
      "custom",
    ]),
    scope: z.enum(["universe", "world", "domain", "system", "local"]),
    statements: z.array(nonEmptyTextSchema),
    conditions: z.array(nonEmptyTextSchema),
    exceptions: z.array(nonEmptyTextSchema),
    priority: z.number().int().min(0).max(9999),
  })
  .strict();

export const powerResourceSchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("resource"),
    resourceType: z.enum([
      "fuel",
      "material",
      "catalyst",
      "environment",
      "information",
      "permission",
      "emotion",
      "biological",
      "time",
      "other",
    ]),
    measurement: z.enum(["numeric", "ordinal", "descriptive", "unknown"]),
    unit: trimmedTextSchema,
    qualityDimensions: z.array(nonEmptyTextSchema),
    replenishment: textSchema,
    scarcity: textSchema,
  })
  .strict();

export const powerTheoryOperationSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    operationType: z.enum([
      "circulate",
      "aggregate",
      "compress",
      "refine",
      "split",
      "convert",
      "resonate",
      "synchronize",
      "encode",
      "inscribe",
      "project",
      "self-organize",
      "feedback",
      "sample",
      "custom",
    ]),
    input: textSchema,
    output: textSchema,
    rule: textSchema,
  })
  .strict();

export const powerRepresentationTypeSchema = z.enum([
  "sequence",
  "graph",
  "modular",
  "spatial-field",
  "symbolic",
  "dynamic-system",
  "rule-system",
  "probabilistic",
  "embodied",
  "emotional",
  "unknown",
]);

const cognitiveLoadSchema = z.enum([
  "low",
  "medium",
  "high",
  "extreme",
  "unknown",
]);

export const powerTheorySchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("theory"),
    representationType: powerRepresentationTypeSchema,
    substrateRefs: z.array(powerEntityReferenceSchema),
    topology: z
      .object({
        spatialDimensions: z.number().int().min(0).max(16).nullable(),
        nodeDefinition: textSchema,
        connectionDefinition: textSchema,
        structure: textSchema,
      })
      .strict(),
    operations: z.array(powerTheoryOperationSchema),
    controlStrategy: textSchema,
    complexity: z
      .object({
        memory: cognitiveLoadSchema,
        parallelism: cognitiveLoadSchema,
        abstraction: cognitiveLoadSchema,
        dynamism: cognitiveLoadSchema,
      })
      .strict(),
    assumptions: z.array(nonEmptyTextSchema),
    invariants: z.array(nonEmptyTextSchema),
    failureModes: z.array(nonEmptyTextSchema),
  })
  .strict();

export const powerMethodPhaseSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    order: z.number().int().nonnegative(),
    goal: textSchema,
    operations: z.array(nonEmptyTextSchema),
    requirements: z.array(nonEmptyTextSchema),
    outputs: z.array(nonEmptyTextSchema),
  })
  .strict();

export const powerMethodSchema = z
  .object({
    ...catalogEntityBaseShape,
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
    roles: z.array(
      z.enum([
        "advance",
        "stabilize",
        "refine",
        "recover",
        "transform",
        "awaken",
        "control",
        "adapt",
      ]),
    ),
    theoryRefs: z.array(powerCatalogReferenceSchema),
    procedure: textSchema,
    phases: z.array(powerMethodPhaseSchema),
    outputs: z.array(nonEmptyTextSchema),
    failureConsequences: z.array(nonEmptyTextSchema),
  })
  .strict()
  .superRefine((method, context) => {
    method.theoryRefs.forEach((reference, index) => {
      if (reference.kind !== "theory") {
        context.addIssue({
          code: "custom",
          path: ["theoryRefs", index, "kind"],
          message: "发展方法只能引用理论模型",
        });
      }
    });
  });

export const powerCapabilitySchema = z
  .object({
    ...catalogEntityBaseShape,
    kind: z.literal("capability"),
    capabilityType: z.enum([
      "intrinsic",
      "technique",
      "spell",
      "superpower",
      "sense",
      "transformation",
      "authority",
      "technology",
      "custom",
    ]),
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
    costs: z.array(nonEmptyTextSchema),
    limitations: z.array(nonEmptyTextSchema),
    sideEffects: z.array(nonEmptyTextSchema),
    countermeasures: z.array(nonEmptyTextSchema),
  })
  .strict();

export type PowerFoundation = z.infer<typeof powerFoundationSchema>;
export type PowerMedium = z.infer<typeof powerMediumSchema>;
export type PowerPrinciple = z.infer<typeof powerPrincipleSchema>;
export type PowerResource = z.infer<typeof powerResourceSchema>;
export type PowerTheoryOperation = z.infer<typeof powerTheoryOperationSchema>;
export type PowerRepresentationType = z.infer<
  typeof powerRepresentationTypeSchema
>;
export type PowerTheory = z.infer<typeof powerTheorySchema>;
export type PowerMethodPhase = z.infer<typeof powerMethodPhaseSchema>;
export type PowerMethod = z.infer<typeof powerMethodSchema>;
export type PowerCapability = z.infer<typeof powerCapabilitySchema>;

export const powerCatalogEntitySchema = z.discriminatedUnion("kind", [
  powerFoundationSchema,
  powerMediumSchema,
  powerPrincipleSchema,
  powerResourceSchema,
  powerTheorySchema,
  powerMethodSchema,
  powerCapabilitySchema,
]);

export type PowerCatalogEntity = z.infer<typeof powerCatalogEntitySchema>;

export const powerConditionOperatorSchema = z.enum([
  "equals",
  "not-equals",
  "contains",
  "not-contains",
  "greater-than",
  "less-than",
  "at-least",
  "at-most",
  "exists",
  "not-exists",
  "matches",
]);

export const powerConditionClauseSchema = z
  .object({
    id: powerIdSchema,
    subjectRef: powerEntityReferenceSchema.nullable(),
    subject: textSchema,
    field: trimmedTextSchema,
    operator: powerConditionOperatorSchema,
    value: textSchema,
    note: textSchema,
  })
  .strict();

export const powerConditionGroupSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    clauses: z.array(powerConditionClauseSchema),
  })
  .strict();

export type PowerConditionOperator = z.infer<
  typeof powerConditionOperatorSchema
>;
export type PowerConditionClause = z.infer<typeof powerConditionClauseSchema>;
export type PowerConditionGroup = z.infer<typeof powerConditionGroupSchema>;

export const powerMetricDimensionSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    category: z.enum(["quality", "boundary"]),
    measurement: z.enum(["numeric", "ordinal", "descriptive"]),
    unit: trimmedTextSchema,
    lowLabel: trimmedTextSchema,
    highLabel: trimmedTextSchema,
    description: textSchema,
  })
  .strict();

export const powerMetricValueSchema = z
  .object({
    dimensionId: powerIdSchema,
    value: z.union([z.number().finite(), z.string(), z.null()]),
    note: textSchema,
  })
  .strict();

export const powerCognitiveModelSchema = z
  .object({
    representationType: powerRepresentationTypeSchema,
    description: textSchema,
    memoryLoad: cognitiveLoadSchema,
    parallelism: cognitiveLoadSchema,
    abstraction: cognitiveLoadSchema,
    dynamism: cognitiveLoadSchema,
    spatialDimensions: z.number().int().min(0).max(16).nullable(),
    requiredSkills: z.array(nonEmptyTextSchema),
    breakthroughInsight: textSchema,
  })
  .strict();

export const powerStateContractSchema = z
  .object({
    entryConditions: powerConditionGroupSchema,
    maintenanceConditions: powerConditionGroupSchema,
    exitConditions: powerConditionGroupSchema,
    baseQualities: z.array(powerMetricValueSchema),
    baseBoundaries: z.array(powerMetricValueSchema),
    cognition: powerCognitiveModelSchema,
    stability: textSchema,
    risks: z.array(nonEmptyTextSchema),
  })
  .strict();

export const powerProgressionStateSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    aliases: z.array(nonEmptyTextSchema),
    stateType: z.enum([
      "stage",
      "rank",
      "form",
      "control",
      "version",
      "permission",
      "condition",
      "custom",
    ]),
    summary: textSchema,
    order: z.number().int().nonnegative(),
    contract: powerStateContractSchema,
    metadata: powerTruthMetadataSchema,
  })
  .strict();

export const powerProgressionTransitionSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    fromStateId: powerIdSchema.nullable(),
    toStateId: powerIdSchema,
    transitionType: z.enum([
      "advance",
      "branch",
      "merge",
      "regress",
      "transform",
      "recover",
      "awaken",
      "event",
    ]),
    conditions: powerConditionGroupSchema,
    qualityCarryover: z.enum([
      "preserve",
      "reset",
      "transform",
      "partial",
      "custom",
    ]),
    qualityRule: textSchema,
    outcomes: z.array(nonEmptyTextSchema),
    failureModes: z.array(nonEmptyTextSchema),
    reversible: z.boolean(),
  })
  .strict();

export const powerProgressionTrackSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
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
    states: z.array(powerProgressionStateSchema),
    transitions: z.array(powerProgressionTransitionSchema),
    metadata: powerTruthMetadataSchema,
  })
  .strict()
  .superRefine((track, context) => {
    const stateIds = new Set<string>();
    track.states.forEach((state, index) => {
      if (stateIds.has(state.id)) {
        context.addIssue({
          code: "custom",
          path: ["states", index, "id"],
          message: "成长状态 id 不得重复",
        });
      }
      stateIds.add(state.id);
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
      if (
        transition.fromStateId !== null &&
        !stateIds.has(transition.fromStateId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "fromStateId"],
          message: "转换起点状态不存在",
        });
      }
      if (!stateIds.has(transition.toStateId)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "toStateId"],
          message: "转换目标状态不存在",
        });
      }
    });
  });

export type PowerMetricDimension = z.infer<typeof powerMetricDimensionSchema>;
export type PowerMetricValue = z.infer<typeof powerMetricValueSchema>;
export type PowerCognitiveModel = z.infer<typeof powerCognitiveModelSchema>;
export type PowerStateContract = z.infer<typeof powerStateContractSchema>;
export type PowerProgressionState = z.infer<typeof powerProgressionStateSchema>;
export type PowerProgressionTransition = z.infer<
  typeof powerProgressionTransitionSchema
>;
export type PowerProgressionTrack = z.infer<typeof powerProgressionTrackSchema>;

export const powerDesignContractSchema = z
  .object({
    explanation: z.enum(["explicit", "partial", "mysterious"]),
    progression: z.enum([
      "none",
      "single-track",
      "multi-track",
      "event-driven",
    ]),
    costPolicy: z.enum(["required", "recommended", "optional"]),
    comparison: z.enum(["stable", "contextual", "incomparable"]),
    theoryPolicy: z.enum(["explicit", "partial", "unknown"]),
  })
  .strict();

export const powerSystemRecordSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    aliases: z.array(nonEmptyTextSchema),
    typeId: powerIdSchema,
    status: z.enum(["draft", "active", "archived"]),
    summary: textSchema,
    designContract: powerDesignContractSchema,
    tracks: z.array(powerProgressionTrackSchema),
    dimensions: z.array(powerMetricDimensionSchema),
    metadata: powerTruthMetadataSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    const ids = new Set<string>([record.id]);
    record.dimensions.forEach((dimension, index) => {
      if (ids.has(dimension.id)) {
        context.addIssue({
          code: "custom",
          path: ["dimensions", index, "id"],
          message: "体系内稳定 id 不得重复",
        });
      }
      ids.add(dimension.id);
    });
    record.tracks.forEach((track, trackIndex) => {
      if (ids.has(track.id)) {
        context.addIssue({
          code: "custom",
          path: ["tracks", trackIndex, "id"],
          message: "体系内稳定 id 不得重复",
        });
      }
      ids.add(track.id);
      track.states.forEach((state, stateIndex) => {
        if (ids.has(state.id)) {
          context.addIssue({
            code: "custom",
            path: ["tracks", trackIndex, "states", stateIndex, "id"],
            message: "体系内稳定 id 不得重复",
          });
        }
        ids.add(state.id);
        [
          ...state.contract.baseQualities,
          ...state.contract.baseBoundaries,
        ].forEach((value, valueIndex) => {
          if (
            !record.dimensions.some((item) => item.id === value.dimensionId)
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "tracks",
                trackIndex,
                "states",
                stateIndex,
                "contract",
                valueIndex,
              ],
              message: "状态指标引用了不存在的质量或边界维度",
            });
          }
        });
      });
      track.transitions.forEach((transition, transitionIndex) => {
        if (ids.has(transition.id)) {
          context.addIssue({
            code: "custom",
            path: ["tracks", trackIndex, "transitions", transitionIndex, "id"],
            message: "体系内稳定 id 不得重复",
          });
        }
        ids.add(transition.id);
      });
    });
  });

export type PowerDesignContract = z.infer<typeof powerDesignContractSchema>;
export type PowerSystemRecord = z.infer<typeof powerSystemRecordSchema>;

export const powerMetricModifierSchema = z
  .object({
    dimensionId: powerIdSchema,
    operation: z.enum(["set", "add", "multiply", "minimum", "maximum"]),
    value: z.union([z.number().finite(), z.string()]),
    note: textSchema,
  })
  .strict();

const powerConnectionBaseShape = {
  id: powerIdSchema,
  source: powerEntityReferenceSchema,
  target: powerEntityReferenceSchema,
  conditions: powerConditionGroupSchema,
  note: textSchema,
  metadata: powerTruthMetadataSchema,
} as const;

export const powerAssociationSchema = z
  .object({
    ...powerConnectionBaseShape,
    kind: z.literal("association"),
    relation: z.enum([
      "governs",
      "uses",
      "adopts",
      "expresses",
      "requires",
      "compatible-with",
      "counters",
      "forbidden-by",
      "depends-on",
      "converts-into",
    ]),
    compatibility: z.enum(["native", "adapted", "conditional", "forbidden"]),
  })
  .strict();

export const powerMethodApplicationSchema = z
  .object({
    ...powerConnectionBaseShape,
    kind: z.literal("method-application"),
    role: z.enum([
      "advance",
      "stabilize",
      "refine",
      "recover",
      "transform",
      "awaken",
      "control",
      "adapt",
    ]),
    compatibility: z.enum(["native", "adapted", "conditional", "forbidden"]),
    theoryRef: powerCatalogReferenceSchema.nullable(),
    executionModel: textSchema,
    efficiency: z
      .object({
        mode: z.enum(["qualitative", "multiplier", "formula"]),
        value: z.union([z.number().finite(), z.string(), z.null()]),
        note: textSchema,
      })
      .strict(),
    qualityEffects: z.array(powerMetricModifierSchema),
    boundaryEffects: z.array(powerMetricModifierSchema),
    outcomes: z.array(nonEmptyTextSchema),
    failureModes: z.array(nonEmptyTextSchema),
  })
  .strict()
  .superRefine((application, context) => {
    if (
      application.source.namespace !== "catalog" ||
      application.source.kind !== "method"
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "方法应用的来源必须是发展方法",
      });
    }
    if (
      application.target.namespace !== "system" ||
      !["system", "state", "transition"].includes(application.target.kind)
    ) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "方法应用目标必须是体系、状态或转换",
      });
    }
    if (application.theoryRef && application.theoryRef.kind !== "theory") {
      context.addIssue({
        code: "custom",
        path: ["theoryRef"],
        message: "方法应用只能引用理论模型",
      });
    }
  });

export const powerResourceRequirementSchema = z
  .object({
    ...powerConnectionBaseShape,
    kind: z.literal("resource-requirement"),
    purpose: z.enum([
      "develop",
      "advance",
      "maintain",
      "activate",
      "recover",
      "transform",
    ]),
    amount: z
      .object({
        mode: z.enum(["numeric", "range", "rate", "descriptive"]),
        minimum: z.number().finite().nullable(),
        maximum: z.number().finite().nullable(),
        value: textSchema,
        unit: trimmedTextSchema,
      })
      .strict(),
    quality: textSchema,
    consumed: z.boolean(),
    substituteRefs: z.array(powerCatalogReferenceSchema),
    shortageConsequence: textSchema,
  })
  .strict()
  .superRefine((requirement, context) => {
    if (
      requirement.source.namespace !== "catalog" ||
      requirement.source.kind !== "resource"
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "资源需求的来源必须是资源",
      });
    }
    requirement.substituteRefs.forEach((reference, index) => {
      if (reference.kind !== "resource") {
        context.addIssue({
          code: "custom",
          path: ["substituteRefs", index],
          message: "替代项必须引用资源",
        });
      }
    });
  });

export const powerCapabilityAccessSchema = z
  .object({
    ...powerConnectionBaseShape,
    kind: z.literal("capability-access"),
    accessMode: z.enum([
      "intrinsic",
      "learnable",
      "method-grant",
      "awakening",
      "equipped",
      "contracted",
      "authorized",
      "conditional",
      "forbidden",
    ]),
    mastery: z.enum([
      "available",
      "basic",
      "proficient",
      "mastered",
      "variable",
    ]),
  })
  .strict()
  .superRefine((access, context) => {
    if (
      access.target.namespace !== "catalog" ||
      access.target.kind !== "capability"
    ) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "能力准入的目标必须是能力",
      });
    }
  });

export const powerSystemInteractionSchema = z
  .object({
    ...powerConnectionBaseShape,
    kind: z.literal("system-interaction"),
    interaction: z.enum([
      "compatible",
      "conversion",
      "suppression",
      "amplification",
      "interference",
      "exclusion",
      "fusion",
    ]),
    effect: textSchema,
  })
  .strict()
  .superRefine((interaction, context) => {
    for (const [key, endpoint] of [
      ["source", interaction.source],
      ["target", interaction.target],
    ] as const) {
      if (endpoint.namespace !== "system" || endpoint.kind !== "system") {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "体系交互两端必须引用力量体系",
        });
      }
    }
  });

export const powerConnectionSchema = z.discriminatedUnion("kind", [
  powerAssociationSchema,
  powerMethodApplicationSchema,
  powerResourceRequirementSchema,
  powerCapabilityAccessSchema,
  powerSystemInteractionSchema,
]);

export type PowerMetricModifier = z.infer<typeof powerMetricModifierSchema>;
export type PowerAssociation = z.infer<typeof powerAssociationSchema>;
export type PowerMethodApplication = z.infer<
  typeof powerMethodApplicationSchema
>;
export type PowerResourceRequirement = z.infer<
  typeof powerResourceRequirementSchema
>;
export type PowerCapabilityAccess = z.infer<typeof powerCapabilityAccessSchema>;
export type PowerSystemInteraction = z.infer<
  typeof powerSystemInteractionSchema
>;
export type PowerConnection = z.infer<typeof powerConnectionSchema>;

export const powerCatalogSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    foundations: z.array(powerFoundationSchema),
    mediums: z.array(powerMediumSchema),
    principles: z.array(powerPrincipleSchema),
    resources: z.array(powerResourceSchema),
    theories: z.array(powerTheorySchema),
    methods: z.array(powerMethodSchema),
    capabilities: z.array(powerCapabilitySchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    const collections: readonly [string, readonly { readonly id: string }[]][] =
      [
        ["foundations", catalog.foundations],
        ["mediums", catalog.mediums],
        ["principles", catalog.principles],
        ["resources", catalog.resources],
        ["theories", catalog.theories],
        ["methods", catalog.methods],
        ["capabilities", catalog.capabilities],
      ];
    for (const [name, values] of collections) {
      values.forEach((value, index) => {
        if (ids.has(value.id)) {
          context.addIssue({
            code: "custom",
            path: [name, index, "id"],
            message: "共享力量目录中的稳定 id 不得重复",
          });
        }
        ids.add(value.id);
      });
    }
    catalog.methods.forEach((method, methodIndex) => {
      method.theoryRefs.forEach((reference, referenceIndex) => {
        if (!catalog.theories.some((item) => item.id === reference.targetId)) {
          context.addIssue({
            code: "custom",
            path: ["methods", methodIndex, "theoryRefs", referenceIndex],
            message: "发展方法引用了不存在的理论模型",
          });
        }
      });
    });
  });

export const powerConnectionsSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_POWER_SYSTEM_SCHEMA_VERSION),
    connections: z.array(powerConnectionSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    document.connections.forEach((connection, index) => {
      if (ids.has(connection.id)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "id"],
          message: "连接 id 不得重复",
        });
      }
      ids.add(connection.id);
    });
  });

export type PowerCatalog = z.infer<typeof powerCatalogSchema>;
export type PowerConnections = z.infer<typeof powerConnectionsSchema>;

export const powerSystemTypeSchema = z
  .object({
    id: powerIdSchema,
    name: nonEmptyTextSchema,
    description: textSchema,
    icon: nonEmptyTextSchema,
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
    name: nonEmptyTextSchema,
    typeId: powerIdSchema,
    status: z.enum(["draft", "active", "archived"]),
    summary: textSchema,
    recordPath: nonEmptyTextSchema,
    pagePath: nonEmptyTextSchema,
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
