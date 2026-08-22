import { z } from "zod";

export const MAP_GENERATION_PLAN_SCHEMA_VERSION = 1 as const;
export const MAP_GENERATION_STYLE_ID = "xuanhuan-zh" as const;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const mapGenerationEntityKindSchema = z.enum([
  "character",
  "event",
  "location",
  "faction",
  "item",
  "setting",
]);
export type MapGenerationEntityKind = z.infer<
  typeof mapGenerationEntityKindSchema
>;

export const mapGenerationEntityRefSchema = z
  .object({
    kind: mapGenerationEntityKindSchema,
    id: z.string().trim().min(1),
  })
  .strict();
export type MapGenerationEntityRef = z.infer<
  typeof mapGenerationEntityRefSchema
>;

export const mapGenerationZoneSchema = z.enum([
  "north",
  "south",
  "east",
  "west",
  "center",
  "coast",
  "island",
  "highland",
  "lowland",
  "unknown",
]);
export type MapGenerationZone = z.infer<typeof mapGenerationZoneSchema>;

export const mapGenerationSpatialLayerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    worldNodeId: idSchema,
    parentId: idSchema.nullable(),
    levelTypeId: idSchema.nullable(),
    role: z.enum(["realm", "region", "province", "island", "domain"]),
    zone: mapGenerationZoneSchema,
    climate: z.array(z.string().trim().min(1).max(80)).max(16),
    terrain: z.array(z.string().trim().min(1).max(80)).max(16),
    anchor: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      })
      .strict()
      .nullable(),
    notes: z.string().max(2_000),
  })
  .strict();
export type MapGenerationSpatialLayer = z.infer<
  typeof mapGenerationSpatialLayerSchema
>;

export const mapGenerationEntityRoleSchema = z.enum([
  "realm",
  "region",
  "mountain",
  "vein",
  "waterway",
  "lake",
  "settlement",
  "capital",
  "city",
  "port",
  "pass",
  "sect",
  "holy-land",
  "secret-realm",
  "forbidden-land",
  "ruin",
  "demon-den",
  "portal",
  "battlefield",
  "biome",
]);
export type MapGenerationEntityRole = z.infer<
  typeof mapGenerationEntityRoleSchema
>;

/** 规划中需要在地图上落一个可编辑地标印章的实体角色。 */
export const MAP_GENERATION_LANDMARK_ROLES: readonly MapGenerationEntityRole[] =
  [
    "settlement",
    "capital",
    "city",
    "port",
    "pass",
    "sect",
    "holy-land",
    "secret-realm",
    "forbidden-land",
    "ruin",
    "demon-den",
    "portal",
    "battlefield",
  ];

const landmarkRoleSet = new Set<string>(MAP_GENERATION_LANDMARK_ROLES);

export function mapGenerationRoleUsesLandmarkArtwork(role: string): boolean {
  return landmarkRoleSet.has(role);
}

export function mapGenerationRoleRequiresArtwork(role: string): boolean {
  return (
    mapGenerationRoleUsesLandmarkArtwork(role) ||
    role === "mountain" ||
    role === "vein"
  );
}

export const mapGenerationPlannedEntitySchema = z
  .object({
    id: idSchema,
    entityRef: mapGenerationEntityRefSchema.nullable(),
    name: z.string().trim().min(1).max(160),
    role: mapGenerationEntityRoleSchema,
    spatialLayerId: idSchema.nullable(),
    anchor: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      })
      .strict()
      .nullable(),
    preferredTerrain: z.array(z.string().trim().min(1).max(80)).max(12),
    importance: z.number().int().min(0).max(5),
    description: z.string().max(2_000),
  })
  .strict();
export type MapGenerationPlannedEntity = z.infer<
  typeof mapGenerationPlannedEntitySchema
>;

export const mapGenerationTerritorySchema = z
  .object({
    id: idSchema,
    factionRef: z
      .object({
        kind: z.literal("faction"),
        id: z.string().trim().min(1),
      })
      .strict(),
    name: z.string().trim().min(1).max(160),
    spatialLayerId: idSchema.nullable(),
    anchor: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      })
      .strict()
      .nullable(),
    extent: z.number().finite().min(0.02).max(0.8),
    boundaryStyle: z.enum(["ink", "dashed", "wash", "hatch"]),
    importance: z.number().int().min(0).max(5),
    description: z.string().max(2_000),
  })
  .strict();
export type MapGenerationTerritory = z.infer<
  typeof mapGenerationTerritorySchema
>;

export const mapGenerationRelationSchema = z
  .object({
    fromId: idSchema,
    toId: idSchema,
    type: z.enum([
      "contains",
      "located-near",
      "flows-through",
      "originates-at",
      "controls",
      "separated-by",
      "connected-to",
      "guards",
      "hidden-in",
    ]),
    description: z.string().max(500),
  })
  .strict();
export type MapGenerationRelation = z.infer<typeof mapGenerationRelationSchema>;

export const mapGenerationNamingRoleSchema = z.enum([
  "state",
  "province",
  "biome",
  "burg",
  "river",
  "lake",
  "route",
  "marker",
  "region",
]);
export type MapGenerationNamingRole = z.infer<
  typeof mapGenerationNamingRoleSchema
>;

export const mapGenerationNamingEntrySchema = z
  .object({
    id: idSchema,
    role: mapGenerationNamingRoleSchema,
    name: z.string().trim().min(1).max(160),
    rationale: z.string().max(500),
  })
  .strict();
export type MapGenerationNamingEntry = z.infer<
  typeof mapGenerationNamingEntrySchema
>;

/** Agent 为 Azgaar 基础地形预先给出的中文命名，避免运行时随机命名。 */
export const mapGenerationNamingSchema = z
  .object({
    entries: z.array(mapGenerationNamingEntrySchema).max(256),
  })
  .strict()
  .superRefine((naming, context) => {
    const ids = new Set<string>();
    naming.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "地图命名条目 id 不得重复",
        });
      }
      ids.add(entry.id);
    });
  });
export type MapGenerationNaming = z.infer<typeof mapGenerationNamingSchema>;

export const mapGenerationVisualSchema = z
  .object({
    paperPreset: z.enum(["parchment", "ink-wash", "star-chart"]),
    labelHierarchy: z.enum(["dense", "balanced", "sparse"]),
    borderStyle: z.enum(["ink", "dashed", "wash"]),
    reliefStyle: z.enum(["ink-peaks", "wash-peaks", "celestial"]),
    waterStyle: z.enum(["indigo-ripple", "jade-ripple", "dark-sea"]),
    terrainMaterials: z.array(z.string().trim().min(1).max(80)).max(24),
    ornaments: z.array(z.string().trim().min(1).max(80)).max(16),
    notes: z.string().max(2_000),
  })
  .strict();
export type MapGenerationVisual = z.infer<typeof mapGenerationVisualSchema>;

export const mapGenerationAzgaarOptionsSchema = z
  .object({
    heightmapTemplate: z.string().trim().min(1).max(80),
    landmassCount: z.number().int().min(1).max(4),
    regionCount: z.number().int().min(3).max(12),
    riverCount: z.number().int().min(2).max(14),
    states: z.number().int().min(0).max(100),
    cultures: z.number().int().min(1).max(100),
    religions: z.number().int().min(0).max(50),
    precipitation: z.number().min(0).max(500),
    temperatureEquator: z.number().min(20).max(35).optional(),
    temperatureNorthPole: z.number().min(-40).max(10).optional(),
    temperatureSouthPole: z.number().min(-40).max(10).optional(),
  })
  .strict();
export type MapGenerationAzgaarOptions = z.infer<
  typeof mapGenerationAzgaarOptionsSchema
>;

export const mapGenerationPlanSchema = z
  .object({
    schemaVersion: z.literal(MAP_GENERATION_PLAN_SCHEMA_VERSION),
    styleId: z.literal(MAP_GENERATION_STYLE_ID),
    worldSourceHash: sourceHashSchema,
    scope: z
      .object({
        worldNodeId: idSchema.nullable(),
        nodeIds: z.array(idSchema).min(1).max(512),
        nodePath: z.string().trim().min(1).max(500),
        generationLevelTypeId: idSchema.nullable(),
        generationLevelName: z.string().trim().min(1).max(120).nullable(),
      })
      .strict(),
    azgaar: mapGenerationAzgaarOptionsSchema,
    spatialLayers: z.array(mapGenerationSpatialLayerSchema).min(1).max(64),
    entities: z.array(mapGenerationPlannedEntitySchema).max(256),
    territories: z.array(mapGenerationTerritorySchema).max(128).optional(),
    relations: z.array(mapGenerationRelationSchema).max(512),
    naming: mapGenerationNamingSchema.optional(),
    visual: mapGenerationVisualSchema,
    rationale: z.string().max(4_000),
  })
  .strict()
  .superRefine((plan, context) => {
    if (new Set(plan.scope.nodeIds).size !== plan.scope.nodeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["scope", "nodeIds"],
        message: "地图生成范围的空间节点不得重复",
      });
    }
    if (
      plan.scope.worldNodeId !== null &&
      !plan.scope.nodeIds.includes(plan.scope.worldNodeId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope", "worldNodeId"],
        message: "地图根空间节点必须属于本次生成范围",
      });
    }
    const layerIds = new Set<string>();
    for (const [index, layer] of plan.spatialLayers.entries()) {
      if (layerIds.has(layer.id)) {
        context.addIssue({
          code: "custom",
          path: ["spatialLayers", index, "id"],
          message: "空间层 id 不得重复",
        });
      }
      layerIds.add(layer.id);
      if (!plan.scope.nodeIds.includes(layer.worldNodeId)) {
        context.addIssue({
          code: "custom",
          path: ["spatialLayers", index, "worldNodeId"],
          message: "空间层必须属于本次地图生成范围",
        });
      }
      if (layer.parentId && !layerIds.has(layer.parentId)) {
        const parentExists = plan.spatialLayers.some(
          (candidate) => candidate.id === layer.parentId,
        );
        if (!parentExists) {
          context.addIssue({
            code: "custom",
            path: ["spatialLayers", index, "parentId"],
            message: "空间层父级不存在",
          });
        }
      }
    }
    const spatialLayersById = new Map(
      plan.spatialLayers.map((layer) => [layer.id, layer]),
    );
    for (const [index, layer] of plan.spatialLayers.entries()) {
      const lineage = new Set([layer.id]);
      let parentId = layer.parentId;
      while (parentId) {
        if (lineage.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["spatialLayers", index, "parentId"],
            message: "空间层级不得形成环",
          });
          break;
        }
        lineage.add(parentId);
        parentId = spatialLayersById.get(parentId)?.parentId ?? null;
      }
    }
    const entityIds = new Set<string>();
    for (const [index, entity] of plan.entities.entries()) {
      if (entityIds.has(entity.id)) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "id"],
          message: "规划实体 id 不得重复",
        });
      }
      entityIds.add(entity.id);
      if (entity.spatialLayerId && !layerIds.has(entity.spatialLayerId)) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "spatialLayerId"],
          message: "规划实体引用的空间层不存在",
        });
      }
    }
    const territoryIds = new Set<string>();
    for (const [index, territory] of (plan.territories ?? []).entries()) {
      if (territoryIds.has(territory.id) || entityIds.has(territory.id)) {
        context.addIssue({
          code: "custom",
          path: ["territories", index, "id"],
          message: "势力领地 id 不得与其它规划对象重复",
        });
      }
      territoryIds.add(territory.id);
      if (territory.spatialLayerId && !layerIds.has(territory.spatialLayerId)) {
        context.addIssue({
          code: "custom",
          path: ["territories", index, "spatialLayerId"],
          message: "势力领地引用的空间层不存在",
        });
      }
    }
    plan.relations.forEach((relation, index) => {
      if (
        !entityIds.has(relation.fromId) &&
        !territoryIds.has(relation.fromId) &&
        !layerIds.has(relation.fromId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "fromId"],
          message: "关系来源必须引用规划实体或空间层",
        });
      }
      if (
        !entityIds.has(relation.toId) &&
        !territoryIds.has(relation.toId) &&
        !layerIds.has(relation.toId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "toId"],
          message: "关系目标必须引用规划实体或空间层",
        });
      }
    });
  });

export type MapGenerationPlan = z.infer<typeof mapGenerationPlanSchema>;

export function parseMapGenerationPlan(value: unknown): MapGenerationPlan {
  return mapGenerationPlanSchema.parse(value);
}

export const mapGenerationMetadataSchema = z
  .object({
    plan: mapGenerationPlanSchema,
    runtime: z.enum(["azgaar-http", "compatibility-adapter"]),
    generatorAdapter: z.string().trim().min(1).max(120),
    generatedAt: z.string().datetime(),
    runtimeError: z.string().max(2_000).nullable().optional(),
  })
  .strict();
export type MapGenerationMetadata = z.infer<typeof mapGenerationMetadataSchema>;
