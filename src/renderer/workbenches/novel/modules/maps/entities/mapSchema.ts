import { z } from "zod";

import {
  mapGenerationMetadataSchema,
  type MapGenerationMetadata,
} from "../../../../../../shared/workbenches/novel/mapGenerationPlan";

export const MAP_LIBRARY_SCHEMA_VERSION = 1 as const;
export const MAP_LIBRARY_PATH = "world/maps/index.json";
export const MAP_CANVAS_WIDTH = 1_600;
export const MAP_CANVAS_HEIGHT = 1_000;

export const MAP_BACKGROUND_PRESET_IDS = [
  "parchment",
  "ocean",
  "starfield",
  "continents",
  "volcanic",
] as const;

export const mapBackgroundPresetSchema = z.enum(MAP_BACKGROUND_PRESET_IDS);
export type MapBackgroundPreset = z.infer<typeof mapBackgroundPresetSchema>;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const textSchema = z.string();

export const mapProjectionTypeSchema = z.enum([
  "continent",
  "planet",
  "multiverse",
  "parallel",
]);

export type MapProjectionType = z.infer<typeof mapProjectionTypeSchema>;

/**
 * 拓扑路线以稳定节点 id 建立关系；控制点只是由端点实时派生的绘制缓存。
 * 将键名放在 MapDocument 契约层，避免画布、编辑器和校验器各自约定字符串。
 */
export const MAP_TOPOLOGY_SOURCE_NODE_PROP = "sourceNodeId";
export const MAP_TOPOLOGY_TARGET_NODE_PROP = "targetNodeId";

export const MAP_PROJECTION_LABELS: Readonly<
  Record<MapProjectionType, string>
> = Object.freeze({
  continent: "大陆平面图",
  planet: "星球投影",
  multiverse: "多元宇宙拓扑",
  parallel: "平行世界分支",
});

/** 要素可关联的实体种类（与 domainIndex 对齐的子集）。 */
export const mapEntityKindSchema = z.enum([
  "character",
  "event",
  "location",
  "faction",
  "item",
  "setting",
]);

export type MapEntityKind = z.infer<typeof mapEntityKindSchema>;

export const mapFeatureKindSchema = z.enum([
  "marker",
  "label",
  "area",
  /**
   * 历史地图兼容值。新建闭合区域一律写入 `area`，不能再把两种几何语义
   * 暴露为两个编辑工具。
   */
  "polygon",
  "route",
  "node",
]);

export type MapFeatureKind = z.infer<typeof mapFeatureKindSchema>;

/**
 * `polygon` 是早期闭合区域的存储值。读取旧地图时仍按自由圈定区域处理，
 * 但所有新的写入路径必须使用 `area`。
 */
export function isMapFeatureFreeformArea(kind: MapFeatureKind): boolean {
  return kind === "area" || kind === "polygon";
}

export const mapFeatureSchema = z
  .object({
    id: idSchema,
    kind: mapFeatureKindSchema,
    name: z.string().trim().min(1),
    /** 实体引用：名称/概要从资料库派生，地图不复制字段。 */
    entityRef: z
      .object({
        kind: mapEntityKindSchema,
        id: z.string().trim().min(1),
      })
      .nullable(),
    /** 图层 id。 */
    layerId: idSchema,
    /** 对象级锁定状态；旧地图缺失时按未锁定兼容读取。 */
    locked: z.boolean().optional(),
    /** 几何（按 kind 解释：marker/label=点坐标；route=点序列；其余=点序列围合）。 */
    points: z
      .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
      .min(1)
      .max(512),
    /** 时间有效范围（timeline 切片用）；null 表示长期或时间未知。 */
    timeFrom: z.number().finite().nullable(),
    timeTo: z.number().finite().nullable(),
    /** 附加展示字段（颜色、尺寸等视图偏好）。 */
    props: z.record(z.string(), z.string()),
    description: textSchema,
  })
  .strict()
  .superRefine((feature, context) => {
    const pointCount = feature.points.length;
    if (
      ["marker", "label", "node"].includes(feature.kind) &&
      pointCount !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["points"],
        message: "点状要素只能包含一个坐标点",
      });
    }
    if (feature.kind === "route" && pointCount < 2) {
      context.addIssue({
        code: "custom",
        path: ["points"],
        message: "路线至少需要两个坐标点",
      });
    }
    if (isMapFeatureFreeformArea(feature.kind) && pointCount < 3) {
      context.addIssue({
        code: "custom",
        path: ["points"],
        message: "自由圈定区域至少需要三个坐标点",
      });
    }
  });

export type MapFeature = z.infer<typeof mapFeatureSchema>;

export const mapLayerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    visible: z.boolean(),
    locked: z.boolean().default(false),
    opacity: z.number().finite().min(0).max(1).default(1),
  })
  .strict();

export type MapLayer = z.infer<typeof mapLayerSchema>;

export const mapArtworkLayerKindSchema = z.enum([
  "terrain",
  "water",
  "relief",
  "vegetation",
  "stamp",
  "label",
  "effect",
]);

export type MapArtworkLayerKind = z.infer<typeof mapArtworkLayerKindSchema>;

export const mapArtworkAssetMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type MapArtworkAssetMimeType = z.infer<
  typeof mapArtworkAssetMimeTypeSchema
>;

/**
 * 项目素材的可移植清单。图片字节固定在 `world/maps/assets/`，这里仅保存
 * 渲染所需的稳定引用和尺寸信息，绝不内嵌 data URL 或 base64。
 */
export const mapArtworkProjectAssetSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    path: z
      .string()
      .regex(
        /^world\/maps\/assets\/[a-z0-9][a-z0-9-]*\/artwork\/[a-z0-9][a-z0-9-]*\.(?:png|jpe?g|webp)$/iu,
      ),
    mimeType: mapArtworkAssetMimeTypeSchema,
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    /** 项目素材默认既能落图，也能作为散布笔刷使用。 */
    brush: z.boolean().default(true),
  })
  .strict();

export type MapArtworkProjectAsset = z.infer<
  typeof mapArtworkProjectAssetSchema
>;

export const mapArtworkStampSchema = z
  .object({
    id: idSchema,
    layerId: idSchema,
    /** 对象级锁定状态；旧地图缺失时按未锁定兼容读取。 */
    locked: z.boolean().optional(),
    /** 素材清单中的稳定 id；素材本体不写进地图 JSON。 */
    assetId: z.string().trim().min(1).max(160),
    x: z.number().finite(),
    y: z.number().finite(),
    /** 内置素材的稳定视觉变体；旧地图缺失时使用首个变体。 */
    variant: z.number().int().min(0).max(31).default(0),
    /** 设定驱动生成印章的来源 MapFeature；手工和旧地图可以省略。 */
    sourceFeatureId: z.string().trim().min(1).max(160).optional(),
    scale: z.number().finite().min(0.05).max(20).default(1),
    rotation: z.number().finite().default(0),
    opacity: z.number().finite().min(0).max(1).default(1),
    flipX: z.boolean().default(false),
    flipY: z.boolean().default(false),
  })
  .strict();

export type MapArtworkStamp = z.infer<typeof mapArtworkStampSchema>;

export const mapArtworkLayerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    kind: mapArtworkLayerKindSchema,
    visible: z.boolean(),
    locked: z.boolean().default(false),
    opacity: z.number().finite().min(0).max(1).default(1),
    stamps: z.array(mapArtworkStampSchema),
  })
  .strict();

export type MapArtworkLayer = z.infer<typeof mapArtworkLayerSchema>;

export const mapArtworkSchema = z
  .object({
    version: z.literal(1),
    assets: z.array(mapArtworkProjectAssetSchema).default([]),
    layers: z.array(mapArtworkLayerSchema).min(1),
  })
  .strict()
  .superRefine((artwork, context) => {
    const layerIds = new Set<string>();
    const stampIds = new Set<string>();
    const assetIds = new Set<string>();
    artwork.assets.forEach((asset, index) => {
      if (assetIds.has(asset.id)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "id"],
          message: "项目素材 id 不得重复",
        });
      }
      assetIds.add(asset.id);
    });
    artwork.layers.forEach((layer, layerIndex) => {
      if (layerIds.has(layer.id)) {
        context.addIssue({
          code: "custom",
          path: ["layers", layerIndex, "id"],
          message: "视觉图层 id 不得重复",
        });
      }
      layerIds.add(layer.id);
      layer.stamps.forEach((stamp, stampIndex) => {
        if (stampIds.has(stamp.id)) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "stamps", stampIndex, "id"],
            message: "素材印章 id 不得重复",
          });
        }
        stampIds.add(stamp.id);
        if (stamp.layerId !== layer.id) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "stamps", stampIndex, "layerId"],
            message: "素材印章必须引用所属视觉图层",
          });
        }
      });
    });
  });

export type MapArtwork = z.infer<typeof mapArtworkSchema>;

export function createEmptyMapArtwork(): MapArtwork {
  return {
    version: 1,
    assets: [],
    layers: [
      {
        id: "artwork-stamps",
        name: "素材印章",
        kind: "stamp",
        visible: true,
        locked: false,
        opacity: 1,
        stamps: [],
      },
    ],
  };
}

/** 独立绘图场景的图层类型；语义要素和绘图笔触不再共用同一渲染模型。 */
export const mapSceneLayerKindSchema = z.enum([
  "terrain",
  "water",
  "relief",
  "vegetation",
  "civilization",
  "labels",
  "effects",
]);

export type MapSceneLayerKind = z.infer<typeof mapSceneLayerKindSchema>;

export const mapScenePointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export type MapScenePoint = z.infer<typeof mapScenePointSchema>;

/** 海陆表面可混合材质；它只改变成图外观，不改变海陆形状。 */
export const mapTerrainMaterialSchema = z.enum([
  "grassland",
  "forest",
  "desert",
  "beach",
  "gravel-beach",
  "salt-flat",
  "badlands",
  "tundra",
  "snow",
  "snow-cover",
  "swamp",
  "volcanic",
  "volcanic-ash",
  "lava",
  "karst",
  "shallow-sea",
  "deep-sea",
]);

export type MapTerrainMaterial = z.infer<typeof mapTerrainMaterialSchema>;

export const mapTerrainMaterialSurfaceSchema = z.enum(["land", "water"]);
export type MapTerrainMaterialSurface = z.infer<
  typeof mapTerrainMaterialSurfaceSchema
>;

const WATER_TERRAIN_MATERIALS = new Set<MapTerrainMaterial>([
  "shallow-sea",
  "deep-sea",
]);

export function mapTerrainMaterialSurface(
  material: MapTerrainMaterial,
): MapTerrainMaterialSurface {
  return WATER_TERRAIN_MATERIALS.has(material) ? "water" : "land";
}

export function mapTerrainMaterialSupportsLayer(
  material: MapTerrainMaterial,
  layerKind: MapSceneLayerKind,
): boolean {
  return (
    (mapTerrainMaterialSurface(material) === "land" &&
      layerKind === "terrain") ||
    (mapTerrainMaterialSurface(material) === "water" && layerKind === "water")
  );
}

/** 地形笔触的轮廓；形状是可重建的矢量渲染参数，不保存像素。 */
export const mapTerrainBrushShapeSchema = z.enum(["round", "organic"]);
export type MapTerrainBrushShape = z.infer<typeof mapTerrainBrushShapeSchema>;

/** 笔触中心线的几何模式；旧地图缺失时按直线兼容读取。 */
export const mapBrushPointCurveSchema = z.enum(["line", "arc"]);
export type MapBrushPointCurve = z.infer<typeof mapBrushPointCurveSchema>;

export const mapSceneStrokeSchema = z
  .object({
    id: idSchema,
    layerId: idSchema,
    /** 对象级锁定状态；旧地图缺失时按未锁定兼容读取。 */
    locked: z.boolean().optional(),
    tool: z.enum(["paint", "erase"]),
    /** 笔刷素材 id；null 表示纯色地形笔触。 */
    brushAssetId: z.string().trim().min(1).max(160).nullable(),
    /** 非空时表示陆地表面材质笔触，不参与海陆遮罩增减。 */
    terrainMaterial: mapTerrainMaterialSchema.nullable().default(null),
    /** `organic` 由稳定笔触 id 派生不规则海岸，不保存栅格。 */
    shape: mapTerrainBrushShapeSchema.default("round"),
    /** 交互和导出都必须尊重同一条中心线几何。 */
    curve: mapBrushPointCurveSchema.optional(),
    points: z.array(mapScenePointSchema).min(1).max(8192),
    color: z.string().trim().min(1).max(32),
    width: z.number().finite().positive().max(8192),
    opacity: z.number().finite().min(0).max(1),
    spacing: z.number().finite().positive().max(2048),
    scatter: z.number().finite().min(0).max(1),
  })
  .strict();

export type MapSceneStroke = z.infer<typeof mapSceneStrokeSchema>;

/** 连续地形底稿；多边形由渲染器闭合，不在数据中重复首尾坐标。 */
export const mapSceneRegionKindSchema = z.enum(["land", "water"]);
export type MapSceneRegionKind = z.infer<typeof mapSceneRegionKindSchema>;

export const mapSceneRegionTextureSchema = z.enum([
  "paper-land",
  "water-ripple",
  "territory-hatch",
  "administrative-grid",
  "stellar-domain",
]);
export type MapSceneRegionTexture = z.infer<typeof mapSceneRegionTextureSchema>;

export const mapSceneRegionSchema = z
  .object({
    id: idSchema,
    layerId: idSchema,
    /** 对象级锁定状态；旧地图缺失时按未锁定兼容读取。 */
    locked: z.boolean().optional(),
    /**
     * 生成地图的海陆区域由同一份 MapFeature 派生。保留来源可让编辑器
     * 在作者改动该要素几何时同步更新最终可见地表，而不是留下旧底图。
     */
    sourceFeatureId: z.string().trim().min(1).max(160).optional(),
    kind: mapSceneRegionKindSchema,
    points: z.array(mapScenePointSchema).min(3).max(8192),
    fill: z.string().trim().min(1).max(32),
    texture: mapSceneRegionTextureSchema,
    opacity: z.number().finite().min(0).max(1),
    edgeColor: z.string().trim().min(1).max(32),
    edgeWidth: z.number().finite().positive().max(256),
    /** 区域闭合轮廓的控制点模式；旧地图缺失时沿用历史平滑弧线。 */
    curve: mapBrushPointCurveSchema.optional(),
    /** 闭合画笔确认后的区域材质；为空时沿用区域自身填充与纹理。 */
    terrainMaterial: mapTerrainMaterialSchema.nullable().optional(),
  })
  .strict();

export type MapSceneRegion = z.infer<typeof mapSceneRegionSchema>;

/**
 * 区域是海陆遮罩的唯一矢量事实，只能存在于地形或水系底层。陆地必须归属
 * 地形层；水域还可归属水系层，以保留独立水域图层的编辑语义。
 */
export function mapSceneLayerSupportsRegion(
  layerKind: MapSceneLayerKind,
  regionKind: MapSceneRegionKind,
): boolean {
  return (
    layerKind === "terrain" || (layerKind === "water" && regionKind === "water")
  );
}

/**
 * 地形合成器的视觉参数。它们描述“如何渲染”矢量海陆事实，
 * 不把栅格缓存写入地图 JSON，因此可以随时重建和导出。
 */
export const mapTerrainStyleSchema = z
  .object({
    landColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    waterColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    shallowWaterColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    beachColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    coastColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    textureStrength: z.number().finite().min(0).max(1),
    coastWidth: z.number().finite().min(0).max(64),
    shelfWidth: z.number().finite().min(0).max(128),
  })
  .strict();

export type MapTerrainStyle = z.infer<typeof mapTerrainStyleSchema>;

export const DEFAULT_MAP_TERRAIN_STYLE: MapTerrainStyle = Object.freeze({
  landColor: "#b8ad7d",
  waterColor: "#2c6a81",
  shallowWaterColor: "#5d9caf",
  beachColor: "#d7c58f",
  coastColor: "#655540",
  textureStrength: 0.62,
  coastWidth: 2.6,
  shelfWidth: 13,
});

export const mapSceneLayerSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    kind: mapSceneLayerKindSchema,
    visible: z.boolean(),
    locked: z.boolean().default(false),
    opacity: z.number().finite().min(0).max(1).default(1),
    /** 连续海岸、湖泊和大陆的底稿，永远先于该层笔触合成。 */
    regions: z.array(mapSceneRegionSchema).default([]),
    strokes: z.array(mapSceneStrokeSchema),
  })
  .strict();

export type MapSceneLayer = z.infer<typeof mapSceneLayerSchema>;

export const mapSceneSchema = z
  .object({
    version: z.literal(1),
    terrainStyle: mapTerrainStyleSchema.default(DEFAULT_MAP_TERRAIN_STYLE),
    layers: z.array(mapSceneLayerSchema).min(1),
  })
  .strict()
  .superRefine((scene, context) => {
    const layerIds = new Set<string>();
    const strokeIds = new Set<string>();
    const regionIds = new Set<string>();
    scene.layers.forEach((layer, layerIndex) => {
      if (layerIds.has(layer.id)) {
        context.addIssue({
          code: "custom",
          path: ["layers", layerIndex, "id"],
          message: "绘图场景图层 id 不得重复",
        });
      }
      layerIds.add(layer.id);
      layer.regions.forEach((region, regionIndex) => {
        if (regionIds.has(region.id)) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "regions", regionIndex, "id"],
            message: "地形区域 id 不得重复",
          });
        }
        regionIds.add(region.id);
        if (region.layerId !== layer.id) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "regions", regionIndex, "layerId"],
            message: "地形区域必须引用所属场景图层",
          });
        }
        if (!mapSceneLayerSupportsRegion(layer.kind, region.kind)) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "regions", regionIndex],
            message: "海陆区域只能写入地形层或水系层",
          });
        }
        if (
          region.terrainMaterial &&
          mapTerrainMaterialSurface(region.terrainMaterial) !== region.kind
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "layers",
              layerIndex,
              "regions",
              regionIndex,
              "terrainMaterial",
            ],
            message: "区域附加材质必须与区域的海陆表面一致",
          });
        }
      });
      layer.strokes.forEach((stroke, strokeIndex) => {
        if (strokeIds.has(stroke.id)) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "strokes", strokeIndex, "id"],
            message: "绘图笔触 id 不得重复",
          });
        }
        strokeIds.add(stroke.id);
        if (stroke.layerId !== layer.id) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "strokes", strokeIndex, "layerId"],
            message: "绘图笔触必须引用所属场景图层",
          });
        }
        if (
          stroke.terrainMaterial !== null &&
          (stroke.tool !== "paint" ||
            stroke.brushAssetId !== null ||
            !mapTerrainMaterialSupportsLayer(
              stroke.terrainMaterial,
              layer.kind,
            ))
        ) {
          context.addIssue({
            code: "custom",
            path: ["layers", layerIndex, "strokes", strokeIndex],
            message: "地貌材质笔触必须写入与材质表面匹配的地形或水系层",
          });
        }
      });
    });
  });

export type MapScene = z.infer<typeof mapSceneSchema>;

/**
 * 地图组合只保存既有可选对象的稳定 id。陆地、材质笔触、素材和普通要素
 * 仍然各自保有独立的几何与样式事实，组合只声明它们需要一起变换。
 */
export const mapObjectGroupSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    itemIds: z.array(idSchema).min(2).max(512),
  })
  .strict()
  .superRefine((group, context) => {
    const itemIds = new Set<string>();
    group.itemIds.forEach((itemId, index) => {
      if (itemIds.has(itemId)) {
        context.addIssue({
          code: "custom",
          path: ["itemIds", index],
          message: "组合成员不得重复",
        });
      }
      itemIds.add(itemId);
    });
  });

export type MapObjectGroup = z.infer<typeof mapObjectGroupSchema>;

export function createEmptyMapScene(): MapScene {
  const layers: readonly [
    MapSceneLayer,
    MapSceneLayer,
    MapSceneLayer,
    MapSceneLayer,
    MapSceneLayer,
    MapSceneLayer,
    MapSceneLayer,
  ] = [
    {
      id: "scene-terrain",
      name: "地形笔触",
      kind: "terrain",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-water",
      name: "水系笔触",
      kind: "water",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-relief",
      name: "地貌笔触",
      kind: "relief",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-vegetation",
      name: "植被笔触",
      kind: "vegetation",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-civilization",
      name: "文明笔触",
      kind: "civilization",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-labels",
      name: "地图标注",
      kind: "labels",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
    {
      id: "scene-effects",
      name: "地图效果",
      kind: "effects",
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    },
  ];
  return {
    version: 1,
    terrainStyle: { ...DEFAULT_MAP_TERRAIN_STYLE },
    layers: [...layers],
  };
}

export const mapDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    name: z.string().trim().min(1),
    projectionType: mapProjectionTypeSchema,
    canvas: z
      .object({
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
        /** 内置画布质感；自定义图片会在预设之上叠加。 */
        backgroundPreset: mapBackgroundPresetSchema.optional(),
        /** 可选的本地底图 data URL；不写入时保持纯色画布。 */
        backgroundImage: z.string().trim().nullable().optional(),
        /** 项目内底图资源路径；加载时由 Repository 解析为 backgroundImage。 */
        backgroundAssetPath: z
          .string()
          .regex(
            /^world\/maps\/(?:assets\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*|proposals\/[a-z0-9][a-z0-9-]*\/assets)\/[a-z0-9][a-z0-9-]*\.(?:svg|png|jpe?g|webp)$/iu,
          )
          .nullable()
          .optional(),
        /** 底图是可隐藏的参考层；隐藏不删除底图事实，也不改变自动边界。 */
        backgroundImageVisible: z.boolean().optional(),
        /**
         * 导入底图在地图世界坐标中的实际覆盖区域。缺失时兼容旧地图的
         * "按当前画布 contain" 规则；一旦地图因内容自动延展，边界计算会
         * 将旧规则物化为这个矩形，避免底图与地形发生相对位移。
         */
        backgroundImagePlacement: z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite().positive(),
            height: z.number().finite().positive(),
            /**
             * 自动生成的 SVG 底图需要随内容重定位以保持对齐，但初始完整
             * 渲染矩形不应重新主导画布尺寸；作者编辑变换后才参与边界。
             */
            source: z.enum(["automatic", "author"]).optional(),
          })
          .strict()
          .optional(),
        backgroundImageWidth: z.number().finite().positive().optional(),
        backgroundImageHeight: z.number().finite().positive().optional(),
        backgroundOpacity: z.number().finite().min(0).max(1).optional(),
        showGrid: z.boolean(),
      })
      .strict()
      .default({
        width: MAP_CANVAS_WIDTH,
        height: MAP_CANVAS_HEIGHT,
        backgroundColor: "#f3f0e8",
        backgroundPreset: "parchment",
        backgroundImage: null,
        backgroundAssetPath: null,
        backgroundImageVisible: true,
        backgroundOpacity: 1,
        showGrid: true,
      }),
    layers: z.array(mapLayerSchema).min(1),
    features: z.array(mapFeatureSchema),
    /** Wonderdraft 式视觉稿层；旧地图缺失时由默认空素材层补齐。 */
    artwork: mapArtworkSchema.default(createEmptyMapArtwork()),
    /** 独立绘图场景；旧地图缺失时由渲染器从 features/artwork 兼容投影。 */
    scene: mapSceneSchema.optional(),
    /** Agent 生成事实；地图几何和视觉结果必须可追溯到同一份规划。 */
    generation: mapGenerationMetadataSchema.optional(),
    /**
     * 组合只用于一起选择和变换，不能替代成员自身的地图事实。旧地图没有
     * 组合时保持缺省，首次创建组合后才写入该字段。
     */
    groups: z.array(mapObjectGroupSchema).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((map, context) => {
    const layerIds = new Set<string>();
    const featureIds = new Set<string>();
    map.layers.forEach((layer, index) => {
      if (layerIds.has(layer.id)) {
        context.addIssue({
          code: "custom",
          path: ["layers", index, "id"],
          message: "图层 id 不得重复",
        });
      }
      layerIds.add(layer.id);
    });
    map.features.forEach((feature, index) => {
      if (featureIds.has(feature.id)) {
        context.addIssue({
          code: "custom",
          path: ["features", index, "id"],
          message: "地图要素 id 不得重复",
        });
      }
      featureIds.add(feature.id);
      if (!layerIds.has(feature.layerId)) {
        context.addIssue({
          code: "custom",
          path: ["features", index, "layerId"],
          message: "要素引用的图层不存在",
        });
      }
      if (
        feature.timeFrom !== null &&
        feature.timeTo !== null &&
        feature.timeTo < feature.timeFrom
      ) {
        context.addIssue({
          code: "custom",
          path: ["features", index, "timeTo"],
          message: "时间区间无效（结束早于开始）",
        });
      }
      if (feature.kind === "node" && feature.props.linkedMapId === map.id) {
        context.addIssue({
          code: "custom",
          path: ["features", index, "props", "linkedMapId"],
          message: "拓扑节点不能关联当前地图本身",
        });
      }
    });

    if (
      map.projectionType === "multiverse" ||
      map.projectionType === "parallel"
    ) {
      const topologyNodeIds = new Set(
        map.features
          .filter((feature) => feature.kind === "node")
          .map((feature) => feature.id),
      );
      map.features.forEach((feature, index) => {
        if (feature.kind !== "route") return;
        const sourceId = feature.props[MAP_TOPOLOGY_SOURCE_NODE_PROP];
        const targetId = feature.props[MAP_TOPOLOGY_TARGET_NODE_PROP];
        if (!sourceId || !topologyNodeIds.has(sourceId)) {
          context.addIssue({
            code: "custom",
            path: ["features", index, "props", MAP_TOPOLOGY_SOURCE_NODE_PROP],
            message: "拓扑路线必须引用存在的来源节点",
          });
        }
        if (!targetId || !topologyNodeIds.has(targetId)) {
          context.addIssue({
            code: "custom",
            path: ["features", index, "props", MAP_TOPOLOGY_TARGET_NODE_PROP],
            message: "拓扑路线必须引用存在的目标节点",
          });
        }
        if (sourceId && targetId && sourceId === targetId) {
          context.addIssue({
            code: "custom",
            path: ["features", index, "props"],
            message: "拓扑路线不能连接节点自身",
          });
        }
      });
    }
    const selectableItemIds = new Set<string>([
      ...map.features.map((feature) => feature.id),
      ...map.artwork.layers.flatMap((layer) =>
        layer.stamps.map((stamp) => stamp.id),
      ),
      ...(map.scene?.layers.flatMap((layer) => [
        ...layer.strokes.map((stroke) => stroke.id),
        ...layer.regions.map((region) => region.id),
      ]) ?? []),
    ]);
    const groupIds = new Set<string>();
    const groupedItemIds = new Set<string>();
    (map.groups ?? []).forEach((group, groupIndex) => {
      if (groupIds.has(group.id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "id"],
          message: "地图组合 id 不得重复",
        });
      }
      groupIds.add(group.id);
      group.itemIds.forEach((itemId, itemIndex) => {
        if (!selectableItemIds.has(itemId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "itemIds", itemIndex],
            message: "组合成员必须引用存在的可选地图对象",
          });
        }
        if (groupedItemIds.has(itemId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "itemIds", itemIndex],
            message: "一个地图对象只能属于一个组合",
          });
        }
        groupedItemIds.add(itemId);
      });
    });

    const artworkPathPrefix = `world/maps/assets/${map.id}/artwork/`;
    map.artwork.assets.forEach((asset, index) => {
      if (!asset.path.startsWith(artworkPathPrefix)) {
        context.addIssue({
          code: "custom",
          path: ["artwork", "assets", index, "path"],
          message: "项目素材必须存放在当前地图的 assets/<map-id>/artwork 目录",
        });
      }
    });
  });

export type MapDocument = z.infer<typeof mapDocumentSchema>;
export type { MapGenerationMetadata };

export const mapIndexEntrySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    projectionType: mapProjectionTypeSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MapIndexEntry = z.infer<typeof mapIndexEntrySchema>;

export const mapLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(MAP_LIBRARY_SCHEMA_VERSION),
    maps: z.array(mapIndexEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    index.maps.forEach((entry, position) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["maps", position, "id"],
          message: "地图 id 不得重复",
        });
      }
      ids.add(entry.id);
    });
  });

export type MapLibraryIndex = z.infer<typeof mapLibraryIndexSchema>;

export class MapLibraryFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "MapLibraryFormatError";
  }
}

export function parseMapLibraryIndex(content: string): MapLibraryIndex {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new MapLibraryFormatError(
      MAP_LIBRARY_PATH,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = mapLibraryIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new MapLibraryFormatError(
      MAP_LIBRARY_PATH,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeMapLibraryIndex(index: MapLibraryIndex): string {
  return `${JSON.stringify(mapLibraryIndexSchema.parse(index), null, 2)}\n`;
}

export function mapRecordPath(mapId: string): string {
  if (!idSchema.safeParse(mapId).success) {
    throw new Error("地图 id 只能使用小写字母、数字和连字符");
  }
  return `world/maps/records/${mapId}.json`;
}

export function parseMapDocument(path: string, content: string): MapDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new MapLibraryFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = mapDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new MapLibraryFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeMapDocument(map: MapDocument): string {
  return `${JSON.stringify(mapDocumentSchema.parse(map), null, 2)}\n`;
}

/** 新建地图的默认文档结构。 */
export function createEmptyMapDocument(input: {
  readonly id: string;
  readonly name: string;
  readonly projectionType: MapProjectionType;
  readonly createdAt: string;
}): MapDocument {
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name.trim(),
    projectionType: input.projectionType,
    layers: [
      {
        id: "layer-main",
        name: "主图层",
        visible: true,
        locked: false,
        opacity: 1,
      },
    ],
    canvas: {
      width: MAP_CANVAS_WIDTH,
      height: MAP_CANVAS_HEIGHT,
      backgroundColor: "#f3f0e8",
      backgroundPreset: "parchment",
      backgroundImage: null,
      backgroundAssetPath: null,
      backgroundImageVisible: true,
      backgroundOpacity: 1,
      showGrid: true,
    },
    features: [],
    artwork: createEmptyMapArtwork(),
    scene: createEmptyMapScene(),
    groups: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
