import { z } from "zod";

export const MAP_LIBRARY_SCHEMA_VERSION = 1 as const;
export const MAP_LIBRARY_PATH = "world/maps/index.json";
export const MAP_CANVAS_WIDTH = 1_600;
export const MAP_CANVAS_HEIGHT = 1_000;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const textSchema = z.string();

export const mapProjectionTypeSchema = z.enum([
  "continent",
  "planet",
  "multiverse",
  "parallel",
]);

export type MapProjectionType = z.infer<typeof mapProjectionTypeSchema>;

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
  "polygon",
  "route",
  "node",
]);

export type MapFeatureKind = z.infer<typeof mapFeatureKindSchema>;

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
    if (["marker", "label", "node"].includes(feature.kind) && pointCount !== 1) {
      context.addIssue({ code: "custom", path: ["points"], message: "点状要素只能包含一个坐标点" });
    }
    if (feature.kind === "route" && pointCount < 2) {
      context.addIssue({ code: "custom", path: ["points"], message: "路线至少需要两个坐标点" });
    }
    if (feature.kind === "polygon" && pointCount < 3) {
      context.addIssue({ code: "custom", path: ["points"], message: "多边形至少需要三个坐标点" });
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

export const mapDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    name: z.string().trim().min(1),
    projectionType: mapProjectionTypeSchema,
    canvas: z
      .object({
        width: z.number().finite().positive().max(100_000),
        height: z.number().finite().positive().max(100_000),
        backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
        /** 可选的本地底图 data URL；不写入时保持纯色画布。 */
        backgroundImage: z.string().trim().nullable().optional(),
        backgroundOpacity: z.number().finite().min(0).max(1).optional(),
        showGrid: z.boolean(),
      })
      .strict()
      .default({
        width: MAP_CANVAS_WIDTH,
        height: MAP_CANVAS_HEIGHT,
        backgroundColor: "#f3f0e8",
        backgroundImage: null,
        backgroundOpacity: 1,
        showGrid: true,
      }),
    layers: z.array(mapLayerSchema).min(1),
    features: z.array(mapFeatureSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((map, context) => {
    const layerIds = new Set<string>();
    const featureIds = new Set<string>();
    map.layers.forEach((layer, index) => {
      if (layerIds.has(layer.id)) {
        context.addIssue({ code: "custom", path: ["layers", index, "id"], message: "图层 id 不得重复" });
      }
      layerIds.add(layer.id);
    });
    map.features.forEach((feature, index) => {
      if (featureIds.has(feature.id)) {
        context.addIssue({ code: "custom", path: ["features", index, "id"], message: "地图要素 id 不得重复" });
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
    });
  });

export type MapDocument = z.infer<typeof mapDocumentSchema>;

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
      { id: "layer-main", name: "主图层", visible: true, locked: false, opacity: 1 },
    ],
    canvas: {
      width: MAP_CANVAS_WIDTH,
      height: MAP_CANVAS_HEIGHT,
      backgroundColor: "#f3f0e8",
      backgroundImage: null,
      backgroundOpacity: 1,
      showGrid: true,
    },
    features: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
