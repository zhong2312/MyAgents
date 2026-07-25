import { z } from "zod";

export const CULTIVATION_ECOLOGY_SCHEMA_VERSION = 2 as const;

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);
const textSchema = z.string();
const nameSchema = z.string().trim().min(1);

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
});

const worldOriginRelationSchema = namedSchema.extend({
  sourceId: idSchema,
  targetId: idSchema,
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
  scopes: z.array(textSchema),
  constraints: z.array(textSchema),
  manifestations: z.array(worldOriginManifestationSchema),
  relations: z.array(worldOriginRelationSchema),
});

export const cultivationProjectionSchema = z.object({
  originIds: z.array(idSchema),
  manifestationIds: z.array(idSchema),
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
});

export const progressionTrackSchema = namedSchema.extend({
  mode: textSchema,
  structure: z.enum(["ordered", "branching", "cyclic", "free"]),
  metrics: z.array(metricSchema),
  levels: z.array(levelSchema),
  transitions: z.array(transitionSchema),
});

export const topologyNodeSchema = z.object({
  id: idSchema,
  theoryNodeId: idSchema,
  order: z.number().int().nonnegative(),
  role: textSchema,
  operation: textSchema,
});

export const topologyEdgeSchema = z.object({
  id: idSchema,
  fromNodeId: idSchema,
  toNodeId: idSchema,
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
  }),
  effect: textSchema,
  amplificationModel: textSchema,
  range: textSchema,
  duration: textSchema,
  limitations: z.array(textSchema),
  counters: z.array(textSchema),
});

export const formationNodeSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: textSchema,
  role: textSchema,
  theoryNodeId: idSchema.nullable(),
  position: z.object({ x: z.number(), y: z.number() }),
});
export const formationEdgeSchema = z.object({
  id: idSchema,
  fromNodeId: idSchema,
  toNodeId: idSchema,
  order: z.number().int().nonnegative(),
  rule: textSchema,
});

export const formationSchema = namedSchema.extend({
  category: textSchema,
  structure: z.enum(["planar", "spatial", "network", "mobile", "embedded"]),
  scale: textSchema,
  purpose: textSchema,
  theoryNodeIds: z.array(idSchema),
  requiredLevelIds: z.array(idSchema),
  methodIds: z.array(idSchema),
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
});
export const auditIssueSchema = z.object({
  id: idSchema,
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
  resources: z.array(resourceSchema),
  methods: z.array(cultivationMethodSchema),
  abilities: z.array(abilitySchema),
  formations: z.array(formationSchema),
  foundations: z.array(foundationSchema),
  transitions: z.array(transitionSchema),
  constraints: z.array(constraintSchema),
  audit: z.array(auditIssueSchema),
});

export const crossSystemRelationSchema = namedSchema.extend({
  sourceSystemId: idSchema,
  targetSystemId: idSchema,
  relation: z.enum(["兼容", "克制", "转换", "依赖", "污染", "冲突"]),
  conversionRule: textSchema,
  conditions: z.array(textSchema),
  risk: textSchema,
});

export const cultivationEcologySchema = z.object({
  schemaVersion: z.literal(CULTIVATION_ECOLOGY_SCHEMA_VERSION),
  worldOrigins: z.array(worldOriginSchema),
  systems: z.array(cultivationSystemSchema),
  crossSystemRelations: z.array(crossSystemRelationSchema),
  updatedAt: z.string(),
});

export type CultivationEcology = z.infer<typeof cultivationEcologySchema>;
export type CultivationSystem = z.infer<typeof cultivationSystemSchema>;
export type WorldOrigin = z.infer<typeof worldOriginSchema>;
export type WorldOriginManifestation = z.infer<
  typeof worldOriginManifestationSchema
>;
export type WorldOriginRelation = z.infer<typeof worldOriginRelationSchema>;
export type TheoryModel = z.infer<typeof theoryModelSchema>;
export type TheoryNode = z.infer<typeof theoryNodeSchema>;
export type ProgressionTrack = z.infer<typeof progressionTrackSchema>;
export type CultivationLevel = z.infer<typeof levelSchema>;
export type CultivationMethod = z.infer<typeof cultivationMethodSchema>;
export type OperationTopology = z.infer<typeof operationTopologySchema>;
export type Ability = z.infer<typeof abilitySchema>;
export type CultivationResource = z.infer<typeof resourceSchema>;
export type Formation = z.infer<typeof formationSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Foundation = z.infer<typeof foundationSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
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
