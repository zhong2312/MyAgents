import { z } from "zod";

export const CULTIVATION_ECOLOGY_SCHEMA_VERSION = 6 as const;

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);
const textSchema = z.string();
const nameSchema = z.string().trim().min(1);
export const cultivationOrbStyleSchema = z.enum([
  "plasma",
  "orbit",
  "solar",
  "corona",
  "halo",
  "vortex",
]);

const namedSchema = z.object({
  id: idSchema,
  name: nameSchema,
  summary: textSchema,
});

const worldOriginManifestationSchema = namedSchema.extend({
  type: z.enum([
    "division",
    "law",
    "energy",
    "authority",
    "information",
    "medium",
  ]),
  definition: textSchema,
  sourceId: idSchema.nullable(),
  scope: textSchema,
  access: textSchema,
  generation: textSchema,
  conversion: textSchema,
  risks: z.array(textSchema),
  orbStyle: cultivationOrbStyleSchema.optional(),
});

const worldOriginRelationSchema = namedSchema.extend({
  sourceId: idSchema,
  targetId: idSchema,
  sourceHandleId: textSchema.optional(),
  targetHandleId: textSchema.optional(),
  relation: z.enum([
    "differentiate",
    "manifest",
    "generate",
    "convert",
    "constrain",
    "project",
    "conflict",
  ]),
  conditions: z.array(textSchema),
  cost: textSchema,
  loss: textSchema,
});

export const worldOriginSchema = namedSchema.extend({
  kind: textSchema,
  ontologyStatement: textSchema,
  status: z.enum(["stable", "fragmented", "incomplete", "unstable"]),
  orbStyle: cultivationOrbStyleSchema.optional(),
  scopes: z.array(textSchema),
  constraints: z.array(textSchema),
  manifestations: z.array(worldOriginManifestationSchema),
  relations: z.array(worldOriginRelationSchema),
  canvasPositions: z
    .record(
      idSchema,
      z.object({
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .optional(),
});

export const cultivationProjectionSchema = z.object({
  originIds: z.array(idSchema),
  manifestationIds: z.array(idSchema),
  /** 体系对每个本源/显化节点的语义映射，兼容旧文件可暂不填写。 */
  originBindings: z
    .array(
      z.object({
        sourceId: idSchema,
        sourceHandleId: textSchema.optional(),
        targetHandleId: textSchema.optional(),
        role: z.enum(["primary", "secondary", "manifestation"]),
        purpose: textSchema,
        weight: textSchema,
        sideEffects: z.array(textSchema),
      }),
    )
    .optional(),
  access: textSchema,
  translation: textSchema,
  medium: textSchema,
  attenuation: textSchema,
});

export const theoryNodeSchema = namedSchema.extend({
  kind: textSchema,
  role: textSchema,
  capacity: textSchema,
  accessCondition: textSchema,
  invariant: textSchema,
  aliases: z.array(textSchema),
});

export const theoryModelSchema = z.object({
  statement: textSchema,
  summary: textSchema,
  nodeTypes: z.array(textSchema),
  invariants: z.array(textSchema),
  validationRules: z.array(textSchema),
  nodeCatalog: z.array(theoryNodeSchema),
});

export const metricSchema = namedSchema.extend({
  unit: textSchema,
  model: z.enum(["number", "range", "formula", "descriptive"]),
  direction: z.enum(["higher-better", "lower-better", "neutral"]),
  baseline: textSchema,
});

export const resourceRequirementSchema = z.object({
  resourceId: idSchema,
  purpose: z.enum(["train", "breakthrough", "activate", "maintain", "recover"]),
  quantity: textSchema,
  quality: textSchema,
  consumed: z.boolean(),
  substituteResourceIds: z.array(idSchema),
  missingConsequence: textSchema,
});

export const simulationRuleSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("approved"),
    enabled: z.boolean(),
    requiredMethodIds: z.array(idSchema),
    requiredAbilityIds: z.array(idSchema),
    forbiddenActiveConstraintIds: z.array(idSchema),
    requiredNarrativeMilestoneIds: z.array(idSchema),
  })
  .strict();

export const levelSubStageSchema = namedSchema.extend({
  order: z.number().int().nonnegative(),
  metricThresholds: z.array(
    z.object({ metricId: idSchema, threshold: textSchema }),
  ),
  entryConditions: z.array(textSchema),
  completionConditions: z.array(textSchema),
  resourceRequirements: z.array(resourceRequirementSchema),
  naturalAbilityIds: z.array(idSchema),
  methodIds: z.array(idSchema),
});

export const levelSchema = namedSchema.extend({
  order: z.number().int().nonnegative(),
  stageType: textSchema,
  metricThresholds: z.array(
    z.object({ metricId: idSchema, threshold: textSchema }),
  ),
  quality: textSchema,
  entryConditions: z.array(textSchema),
  maintenanceConditions: z.array(textSchema),
  breakthroughConditions: z.array(textSchema),
  breakthroughResult: textSchema,
  failureConsequences: z.array(textSchema),
  degeneration: textSchema,
  resourceRequirements: z.array(resourceRequirementSchema),
  naturalAbilityIds: z.array(idSchema),
  methodIds: z.array(idSchema),
  subStages: z.array(levelSubStageSchema).default([]),
  simulationBreakthroughRule: simulationRuleSchema.optional(),
});

export const transitionSchema = namedSchema.extend({
  fromLevelId: idSchema.nullable(),
  toLevelId: idSchema.nullable(),
  transitionType: z.enum([
    "breakthrough",
    "conversion",
    "awakening",
    "degeneration",
  ]),
  methodIds: z.array(idSchema),
  conditions: z.array(textSchema),
  resourceRequirements: z.array(resourceRequirementSchema),
  successRule: textSchema,
  successResult: textSchema,
  failureResult: textSchema,
  permanentConsequence: textSchema,
  reversible: z.boolean(),
  qualityInheritance: textSchema.optional(),
  degenerationState: textSchema.optional(),
  simulationRule: simulationRuleSchema.optional(),
});

export const narrativeMilestoneSchema = namedSchema.extend({
  category: z.enum([
    "trial",
    "choice",
    "revelation",
    "relationship",
    "loss",
    "achievement",
  ]),
  satisfiedBy: z
    .array(
      z
        .object({
          kind: z.enum(["timeline-event", "chapter-fact"]),
          id: idSchema,
        })
        .strict(),
    )
    .default([]),
});

export const progressionTrackSchema = namedSchema.extend({
  mode: textSchema,
  structure: z.enum(["ordered", "branching", "cyclic", "free"]),
  metrics: z.array(metricSchema),
  levels: z.array(levelSchema),
  transitions: z.array(transitionSchema),
});

export const trackInteractionSchema = z.object({
  id: idSchema,
  name: nameSchema,
  summary: textSchema,
  sourceTrackId: idSchema,
  targetTrackId: idSchema,
  kind: z.enum([
    "synchronization",
    "synergy",
    "imbalance",
    "cross-breakthrough",
    "resource-competition",
    "dependency",
  ]),
  rule: textSchema,
  conditions: z.array(textSchema),
  consequence: textSchema,
  resourcePolicy: textSchema,
  reversible: z.boolean(),
});

export const topologyNodeSchema = z.object({
  id: idSchema,
  theoryNodeId: idSchema,
  order: z.number().int().nonnegative(),
  role: textSchema,
  operation: textSchema,
  orbStyle: cultivationOrbStyleSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/iu)
    .optional(),
  position: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .optional(),
});

export const topologyEdgeSchema = z.object({
  id: idSchema,
  name: textSchema.optional(),
  fromNodeId: idSchema,
  toNodeId: idSchema,
  fromHandleId: textSchema.optional(),
  toHandleId: textSchema.optional(),
  order: z.number().int().nonnegative(),
  routeRule: textSchema,
  loss: textSchema,
});

export const operationTopologySchema = namedSchema.extend({
  nodes: z.array(topologyNodeSchema),
  edges: z.array(topologyEdgeSchema),
  cycleRule: textSchema,
  closureRule: textSchema,
  costModel: textSchema,
});

export const methodCourseSchema = z.object({
  id: idSchema,
  levelId: idSchema.nullable(),
  title: nameSchema,
  steps: z.array(textSchema),
  prerequisites: z.array(textSchema),
  resourceRequirements: z.array(resourceRequirementSchema),
  passCriteria: textSchema,
  failureRisk: textSchema,
});

export const cultivationMethodSchema = namedSchema.extend({
  kind: textSchema,
  theoryReference: textSchema,
  script: z.array(textSchema),
  formula: textSchema,
  coverage: z.object({
    startLevelId: idSchema.nullable(),
    stableLimitId: idSchema.nullable(),
    theoryLimitId: idSchema.nullable(),
    absoluteLimitId: idSchema.nullable(),
  }),
  effects: z.object({
    speed: textSchema,
    conversion: textSchema,
    quality: textSchema,
    breakthrough: textSchema,
    loss: textSchema,
  }),
  compatibility: z.array(textSchema),
  risks: z.array(textSchema),
  itemIds: z.array(idSchema).default([]),
  operationTopologies: z.array(operationTopologySchema),
  courses: z.array(methodCourseSchema),
});

export const abilitySchema = namedSchema.extend({
  acquisitionType: z.enum(["natural", "scripture"]),
  functionType: z.enum(["support", "mental", "offensive"]),
  unlockLevelId: idSchema.nullable(),
  scriptureSource: z
    .object({
      title: textSchema,
      methodId: idSchema.nullable(),
      itemIds: z.array(idSchema).default([]),
      summary: textSchema,
    })
    .nullable(),
  trainingRequirements: z.object({
    conditions: z.array(textSchema),
    methodIds: z.array(idSchema),
    resourceRequirements: z.array(resourceRequirementSchema),
    masteryFormula: textSchema,
  }),
  cast: z.object({
    energyLabel: textSchema,
    amount: textSchema,
    model: textSchema,
    cooldown: textSchema,
    reserve: textSchema.optional(),
    sustainedCost: textSchema.optional(),
    debtConsequence: textSchema.optional(),
    overloadThreshold: textSchema.optional(),
    fullPowerLevelId: idSchema.nullable().optional(),
    releaseCosts: z
      .array(
        z.object({
          label: textSchema,
          amount: textSchema,
          consumed: z.boolean(),
        }),
      )
      .optional(),
  }),
  effect: textSchema,
  amplificationModel: textSchema,
  range: textSchema,
  duration: textSchema,
  limitations: z.array(textSchema),
  counters: z.array(textSchema),
});

export const formationRingSchema = z.object({
  id: idSchema,
  name: nameSchema,
  radius: z.number().finite().min(40).max(1000),
  style: z.enum(["solid", "double", "dashed", "runic", "polygon"]),
  color: textSchema,
  strokeWidth: z.number().finite().min(0.5).max(12),
  rotation: z.number().finite(),
  rotating: z.boolean().default(false),
  runes: textSchema,
  visible: z.boolean(),
  order: z.number().int().nonnegative(),
});

export const formationBackdropLayerSchema = z.object({
  id: idSchema,
  name: nameSchema,
  type: z.enum([
    "ring",
    "rune-band",
    "polygon",
    "star",
    "radial-rays",
    "arc-petals",
    "ornament-ring",
    "core-symbol",
  ]),
  radius: z.number().finite().min(20).max(1000).default(320),
  innerRadius: z.number().finite().min(0).max(1000).default(80),
  count: z.number().int().min(1).max(96).default(1),
  spacing: z.number().finite().min(0).max(48).default(10),
  sides: z.number().int().min(3).max(24).default(6),
  step: z.number().int().min(1).max(12).default(1),
  innerRatio: z.number().finite().min(0.08).max(0.92).default(0.5),
  curvature: z.number().finite().min(0.1).max(1.5).default(0.65),
  symbol: z
    .enum([
      "circuit",
      "crystal",
      "gate",
      "diamond",
      "eye",
      "star",
      "seal",
      "void",
    ])
    .default("diamond"),
  text: textSchema.default(""),
  repeat: z.number().int().min(1).max(16).default(4),
  rotation: z.number().finite().min(-360).max(360).default(0),
  rotating: z.boolean().default(false),
  color: textSchema.default("#d9b86c"),
  secondaryColor: textSchema.default("#74aab7"),
  strokeWidth: z.number().finite().min(0.5).max(8).default(1.5),
  opacity: z.number().finite().min(0.05).max(1).default(0.72),
  visible: z.boolean().default(true),
  order: z.number().int().nonnegative(),
});

export const formationNodeSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: textSchema,
  role: textSchema,
  theoryNodeId: idSchema.nullable(),
  position: z.object({ x: z.number(), y: z.number() }),
  canvasPosition: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional(),
  ringId: idSchema.nullable().default(null),
  angle: z.number().finite().default(0),
  size: z.number().finite().min(36).max(140).default(72),
  color: textSchema.default("#d9b86c"),
  glyph: textSchema.default("阵"),
  element: z
    .enum(["source", "foundation", "pattern", "eye", "domain", "law"])
    .default("pattern"),
  nodeStyle: z.enum(["seal", "orb", "sigil"]).default("seal"),
});
export const formationEdgeSchema = z.object({
  id: idSchema,
  name: textSchema.default("灵流"),
  fromNodeId: idSchema,
  toNodeId: idSchema,
  fromHandleId: textSchema.optional(),
  toHandleId: textSchema.optional(),
  order: z.number().int().nonnegative(),
  rule: textSchema,
  flowType: textSchema.default("灵流"),
  lineStyle: z.enum(["straight", "bezier", "smoothstep"]).default("bezier"),
  color: textSchema.default("#d9b86c"),
  animated: z.boolean().default(true),
});

export const formationSchema = namedSchema.extend({
  category: textSchema,
  structure: z.enum(["planar", "spatial", "network", "mobile", "embedded"]),
  scale: textSchema,
  purpose: textSchema,
  theoryNodeIds: z.array(idSchema),
  requiredLevelIds: z.array(idSchema),
  methodIds: z.array(idSchema),
  operationTopologyIds: z.array(idSchema).optional(),
  abilityIds: z.array(idSchema),
  itemIds: z.array(idSchema).default([]),
  activationConditions: z.array(textSchema),
  resourceRequirements: z.array(resourceRequirementSchema),
  activation: textSchema,
  maintenance: textSchema,
  output: textSchema,
  boundary: textSchema,
  risks: z.array(textSchema),
  countermeasures: textSchema,
  sixElements: z
    .object({
      source: textSchema.default(""),
      foundation: textSchema.default(""),
      pattern: textSchema.default(""),
      eye: textSchema.default(""),
      domain: textSchema.default(""),
      law: textSchema.default(""),
    })
    .default({
      source: "",
      foundation: "",
      pattern: "",
      eye: "",
      domain: "",
      law: "",
    }),
  design: z
    .object({
      layout: z.enum(["free", "radial", "concentric"]).default("concentric"),
      canvasStyle: z.enum(["mystic", "technical"]).default("mystic"),
      presetId: z
        .enum(["classic", "emerald-eye", "ember-star", "azure-gates", "custom"])
        .default("classic"),
      backgroundColor: textSchema.default("#08070b"),
      palette: z
        .object({
          primary: textSchema.default("#d9b86c"),
          secondary: textSchema.default("#74aab7"),
          accent: textSchema.default("#b96c62"),
          glow: textSchema.default("#f2d791"),
        })
        .default({
          primary: "#d9b86c",
          secondary: "#74aab7",
          accent: "#b96c62",
          glow: "#f2d791",
        }),
      effects: z
        .object({
          glowStrength: z.number().finite().min(0).max(1).default(0.52),
          lineOpacity: z.number().finite().min(0.15).max(1).default(0.82),
          motion: z.enum(["still", "rotate", "pulse"]).default("still"),
        })
        .default({
          glowStrength: 0.52,
          lineOpacity: 0.82,
          motion: "still",
        }),
      backdropLayers: z.array(formationBackdropLayerSchema).max(48).default([]),
      rings: z.array(formationRingSchema).default([]),
    })
    .default({
      layout: "concentric",
      canvasStyle: "mystic",
      presetId: "classic",
      backgroundColor: "#08070b",
      palette: {
        primary: "#d9b86c",
        secondary: "#74aab7",
        accent: "#b96c62",
        glow: "#f2d791",
      },
      effects: {
        glowStrength: 0.52,
        lineOpacity: 0.82,
        motion: "still",
      },
      backdropLayers: [],
      rings: [],
    }),
  nodes: z.array(formationNodeSchema),
  edges: z.array(formationEdgeSchema),
});

export const resourceSchema = namedSchema.extend({
  category: textSchema,
  grades: z.array(
    z.object({
      id: idSchema,
      name: nameSchema,
      summary: textSchema,
      effect: textSchema.default(""),
    }),
  ),
  bestLevelId: idSchema.nullable(),
  usableLevelIds: z.array(idSchema),
  supply: textSchema,
  environment: textSchema,
  conversion: textSchema,
  shortageConsequence: textSchema,
});

export const foundationSchema = namedSchema.extend({
  factor: textSchema,
  value: textSchema,
  impact: textSchema,
  affectedTracks: z.array(idSchema),
  adjustment: textSchema,
  permanence: textSchema,
});
export const constraintSchema = namedSchema.extend({
  category: z.enum([
    "cost",
    "pollution",
    "backlash",
    "world-rule",
    "identity",
    "irreversible",
  ]),
  trigger: textSchema,
  consequence: textSchema,
  mitigation: textSchema,
  reversible: z.boolean(),
  target: textSchema.optional(),
  releaseMethod: textSchema.optional(),
  narrativePrompt: textSchema.optional(),
});
export const auditIssueSchema = z.object({
  id: idSchema,
  fingerprint: z.string().trim().min(1).optional(),
  severity: z.enum(["error", "warning", "suggestion"]),
  title: nameSchema,
  targetType: textSchema,
  targetId: idSchema.nullable(),
  message: textSchema,
  suggestion: textSchema,
  resolved: z.boolean(),
});

export const cultivationSystemSchema = namedSchema.extend({
  kind: textSchema,
  terminology: z.object({
    energy: textSchema,
    stage: textSchema,
    method: textSchema,
    ability: textSchema,
  }),
  projection: cultivationProjectionSchema,
  theoryModel: theoryModelSchema,
  progressionTracks: z.array(progressionTrackSchema),
  trackInteractions: z.array(trackInteractionSchema).default([]),
  resources: z.array(resourceSchema),
  methods: z.array(cultivationMethodSchema),
  abilities: z.array(abilitySchema),
  formations: z.array(formationSchema),
  foundations: z.array(foundationSchema),
  transitions: z.array(transitionSchema),
  constraints: z.array(constraintSchema),
  narrativeMilestones: z.array(narrativeMilestoneSchema).optional(),
  audit: z.array(auditIssueSchema),
});

export const crossSystemRelationSchema = namedSchema.extend({
  sourceSystemId: idSchema,
  targetSystemId: idSchema,
  relation: z.enum(["兼容", "克制", "转换", "依赖", "继承", "污染", "冲突"]),
  conversionRule: textSchema,
  conditions: z.array(textSchema),
  risk: textSchema,
  affectedAssetIds: z.array(idSchema).optional(),
  result: textSchema.optional(),
  boundary: textSchema.optional(),
});

export const cultivationEcologySchema = z.object({
  schemaVersion: z.literal(CULTIVATION_ECOLOGY_SCHEMA_VERSION),
  worldOrigins: z.array(worldOriginSchema),
  systems: z.array(cultivationSystemSchema),
  crossSystemRelations: z.array(crossSystemRelationSchema),
  updatedAt: z.string(),
});

export type CultivationEcology = z.infer<typeof cultivationEcologySchema>;
export type CultivationOrbStyle = z.infer<typeof cultivationOrbStyleSchema>;
export type CultivationSystem = z.infer<typeof cultivationSystemSchema>;
export type WorldOrigin = z.infer<typeof worldOriginSchema>;
export type WorldOriginManifestation = z.infer<
  typeof worldOriginManifestationSchema
>;
export type WorldOriginRelation = z.infer<typeof worldOriginRelationSchema>;
export type TheoryModel = z.infer<typeof theoryModelSchema>;
export type TheoryNode = z.infer<typeof theoryNodeSchema>;
export type ProgressionTrack = z.infer<typeof progressionTrackSchema>;
export type TrackInteraction = z.infer<typeof trackInteractionSchema>;
export type CultivationLevel = z.infer<typeof levelSchema>;
export type CultivationLevelSubStage = z.infer<typeof levelSubStageSchema>;
export type ResourceRequirement = z.infer<typeof resourceRequirementSchema>;
export type CultivationMethod = z.infer<typeof cultivationMethodSchema>;
export type MethodCourse = z.infer<typeof methodCourseSchema>;
export type OperationTopology = z.infer<typeof operationTopologySchema>;
export type Ability = z.infer<typeof abilitySchema>;
export type CultivationResource = z.infer<typeof resourceSchema>;
export type Formation = z.infer<typeof formationSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Foundation = z.infer<typeof foundationSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type NarrativeMilestone = z.infer<typeof narrativeMilestoneSchema>;
export type SimulationRule = NonNullable<
  z.infer<typeof transitionSchema>["simulationRule"]
>;
export type AuditIssue = z.infer<typeof auditIssueSchema>;

export function createEmptyCultivationEcology(): CultivationEcology {
  return {
    schemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION,
    worldOrigins: [],
    systems: [],
    crossSystemRelations: [],
    updatedAt: new Date().toISOString(),
  };
}
