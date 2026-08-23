import {
  createEmptyMapScene,
  isMapFeatureFreeformArea,
  type MapDocument,
  type MapFeature,
  type MapTerrainMaterial,
} from "../entities/mapSchema";
import {
  addMapArtworkLayer,
  addMapArtworkStamp,
  createMapArtworkLayer,
  createMapArtworkStamp,
  getMapArtworkStampAsset,
  mapArtworkVariantIndex,
} from "./mapArtwork";
import { generateFantasyMapCandidate as generateFantasyMapCandidateCore } from "../../../../../../shared/workbenches/novel/fantasyMapGenerator";
import { mapGenerationRoleUsesLandmarkArtwork } from "../../../../../../shared/workbenches/novel/mapGenerationPlan";
import { getMapTerrainMaterialPreset } from "./mapTerrainMaterials";
import {
  addMapSceneRegion,
  addMapSceneStroke,
  createMapSceneRegion,
  createMapSceneStroke,
} from "./mapScene";
import {
  expandMapCanvasToContent,
  fitMapCanvasToContentWhenEmpty,
} from "./mapCanvasBounds";

export type MapGeneratorId =
  | "agent-azgaar"
  | "azgaar"
  | "fantasy-map"
  | "red-blob";

export interface MapGeneratorDescriptor {
  readonly id: MapGeneratorId;
  readonly name: string;
  readonly description: string;
  readonly supportedProjections: readonly MapDocument["projectionType"][];
  readonly mode: "agent" | "import" | "local";
}

export interface MapGeneratorCandidate {
  readonly generatorId: MapGeneratorId;
  readonly title: string;
  readonly summary: string;
  readonly seed: string | null;
  readonly canvas?: Partial<MapDocument["canvas"]>;
  readonly features: readonly MapFeature[];
}

const FANTASY_CONVERSION_COLORS: Readonly<Record<string, string>> =
  Object.freeze({
    coast: "#72543f",
    mountain: "#665546",
    forest: "#4d684e",
    desert: "#a57b4b",
    snow: "#819aa0",
    tundra: "#819aa0",
    swamp: "#596b59",
    volcanic: "#75463d",
    river: "#2e687a",
    region: "#8a694f",
  });

function fantasyConversionProps(feature: MapFeature): MapFeature["props"] {
  const terrain = feature.props.terrain ?? feature.props.terrainMaterial;
  const role = feature.props.entityRole;
  const color =
    FANTASY_CONVERSION_COLORS[terrain ?? ""] ??
    (feature.kind === "route" ? "#72543f" : "#665546");
  const isWater = terrain === "river" || terrain === "lake";
  const isRegion = isMapFeatureFreeformArea(feature.kind);
  const labelSize =
    role === "realm" || role === "capital"
      ? "28"
      : role === "region" || isRegion
        ? "22"
        : isWater
          ? "16"
          : "14";
  return {
    ...feature.props,
    generator: "fantasy-style-conversion",
    color,
    ...(isRegion && terrain !== "lake"
      ? { fill: feature.props.fill ?? "#b8ad7d77" }
      : {}),
    ...(feature.name.trim() ? { showLabel: "true" } : {}),
    labelFont: isWater
      ? "cartographer"
      : role === "realm"
        ? "atlas-serif"
        : "humanist",
    labelSize,
    labelWeight: role === "realm" || role === "capital" ? "700" : "600",
    labelColor: isWater ? "#284f62" : "#3a3329",
    labelHaloColor: "#f6eddb",
    labelHaloWidth: isWater ? "4" : "3",
    labelFollowPath: isWater || feature.kind === "route" ? "true" : "false",
  };
}

/**
 * 将既有地图复制成中文玄幻风格版本。只改渲染属性和标签规则，保留
 * 所有原始点、实体引用、场景和内置素材；项目图片素材不跨地图复制，
 * 以免新地图引用旧地图的 assets 路径。
 */
export function convertMapToFantasyStyleDocument(
  document: MapDocument,
  outputId: string,
  outputName: string,
): MapDocument {
  const projectAssetIds = new Set(
    document.artwork.assets.map((asset) => asset.id),
  );
  return {
    ...document,
    id: outputId,
    name: outputName.trim() || `${document.name} · 中文玄幻风格`,
    canvas: {
      ...document.canvas,
      backgroundColor: "#d8c49a",
      backgroundPreset: "parchment",
      backgroundImage: document.canvas.backgroundAssetPath
        ? null
        : document.canvas.backgroundImage,
      backgroundAssetPath: null,
      backgroundOpacity: document.canvas.backgroundOpacity ?? 1,
      showGrid: false,
    },
    features: document.features.map((feature) => ({
      ...feature,
      props: fantasyConversionProps(feature),
      description: feature.description
        ? `${feature.description}\n已由旧地图转换为中文玄幻风格。`
        : "已由旧地图转换为中文玄幻风格。",
    })),
    artwork: {
      ...document.artwork,
      assets: [],
      layers: document.artwork.layers.map((layer) => ({
        ...layer,
        stamps: layer.stamps.filter(
          (stamp) => !projectAssetIds.has(stamp.assetId),
        ),
      })),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 生成结果不属于作者当前选中的图层。来源图层 ID 是稳定契约：同一个
 * 生成器多次应用候选时复用同一组层，作者即可一次隐藏、锁定或删除该来源
 * 的全部结果，而不会影响手工图层。
 */
export function mapGeneratorSourceLayerIds(generatorId: MapGeneratorId): {
  readonly feature: string;
  readonly scene: string;
  /** 兼容旧版生成结果保留的来源素材层。 */
  readonly artwork: string;
  readonly relief: string;
  readonly vegetation: string;
  readonly civilization: string;
} {
  const suffix = generatorId.replace(/[^a-z0-9]+/giu, "-");
  return {
    feature: `layer-generator-${suffix}`,
    scene: `scene-generator-${suffix}`,
    artwork: `artwork-generator-${suffix}`,
    relief: `artwork-generator-${suffix}-relief`,
    vegetation: `artwork-generator-${suffix}-vegetation`,
    civilization: `artwork-generator-${suffix}-civilization`,
  };
}

function mapGeneratorSourceLabel(generatorId: MapGeneratorId): string {
  return (
    MAP_GENERATORS.find((generator) => generator.id === generatorId)?.name ??
    "地图生成器"
  );
}

export const MAP_GENERATORS: readonly MapGeneratorDescriptor[] = Object.freeze([
  {
    id: "agent-azgaar",
    name: "Agent + Azgaar",
    description:
      "Agent 读取已保存的世界架构、设定正文、词条、地点和势力，再调用 Azgaar 生成地图提案。",
    supportedProjections: ["continent", "planet"],
    mode: "agent",
  },
  {
    id: "azgaar",
    name: "导入 Azgaar 文件",
    description:
      "导入 Azgaar 官方导出的 Full/Minimal JSON、GeoJSON 或 SVG 地图。",
    supportedProjections: ["continent", "planet"],
    mode: "import",
  },
  {
    id: "fantasy-map",
    name: "离线简化草图",
    description:
      "不调用 Agent，也不读取世界架构；仅按种子生成可编辑的本地草图。",
    supportedProjections: ["continent", "planet"],
    mode: "local",
  },
]);

interface GeoJsonGeometry {
  readonly type?: unknown;
  readonly coordinates?: unknown;
}

interface GeoJsonFeature {
  readonly type?: unknown;
  readonly geometry?: GeoJsonGeometry | null;
  readonly properties?: Record<string, unknown> | null;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function polygonContainsPoint(
  point: { readonly x: number; readonly y: number },
  polygon: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const current = polygon[index]!;
    const last = polygon[previous]!;
    const intersects =
      current.y > point.y !== last.y > point.y &&
      point.x <
        ((last.x - current.x) * (point.y - current.y)) /
          (last.y - current.y || Number.EPSILON) +
          current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonArea(
  points: readonly { readonly x: number; readonly y: number }[],
): number {
  if (points.length < 3) return 0;
  return Math.abs(
    points.reduce((total, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return total + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

function pointDistance(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

type MountainStampPlacement = {
  readonly point: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly rotation: number;
};

/**
 * 将山脊路线投影成连续、但不规则的山体构件。
 *
 * 这不是新的地形事实：路线仍保留在 MapFeature 中，返回的每个位置只用来
 * 生成独立的 MapArtworkStamp。采样密度、变体和朝向均由稳定 feature id 与
 * 已保存控制点派生，因此重开地图、缩放画布和导出时不会随机跳变。
 */
function mountainStampPlacements(
  feature: MapFeature,
): readonly MountainStampPlacement[] {
  if (feature.points.length === 0) return [];
  const random = seededRandom(`mountain-stamps:${feature.id}`);
  if (feature.points.length === 1) {
    return [
      {
        point: feature.points[0]!,
        scale: 0.56 + random() * 0.36,
        rotation: 0,
      },
    ];
  }

  const segmentLengths = feature.points
    .slice(1)
    .map((point, index) => pointDistance(feature.points[index]!, point));
  const totalLength = segmentLengths.reduce(
    (sum, segmentLength) => sum + segmentLength,
    0,
  );
  if (totalLength <= Number.EPSILON) {
    return [
      {
        point: feature.points[0]!,
        scale: 0.56 + random() * 0.36,
        rotation: 0,
      },
    ];
  }

  // 以 68 个世界坐标为目标间距补齐长线段，同时每条可见山脊至少形成六座
  // 山体，避免控制点较少时再次退化成几个稀疏的地点标记。
  const placementCount = Math.min(
    40,
    Math.max(6, feature.points.length, Math.ceil(totalLength / 68) + 1),
  );
  const spacing = totalLength / Math.max(1, placementCount - 1);
  const placements: MountainStampPlacement[] = [];

  for (let index = 0; index < placementCount; index += 1) {
    const endpoint = index === 0 || index === placementCount - 1;
    const longitudinalJitter = endpoint
      ? 0
      : (random() * 2 - 1) * Math.min(12, spacing * 0.18);
    const targetDistance = Math.max(
      0,
      Math.min(totalLength, index * spacing + longitudinalJitter),
    );
    let traversed = 0;
    let segmentIndex = 0;
    while (
      segmentIndex < segmentLengths.length - 1 &&
      targetDistance > traversed + segmentLengths[segmentIndex]!
    ) {
      traversed += segmentLengths[segmentIndex]!;
      segmentIndex += 1;
    }
    const start = feature.points[segmentIndex]!;
    const end = feature.points[segmentIndex + 1]!;
    const segmentLength = segmentLengths[segmentIndex]!;
    const progress =
      segmentLength > Number.EPSILON
        ? Math.max(0, Math.min(1, (targetDistance - traversed) / segmentLength))
        : 0;
    const direction = Math.atan2(end.y - start.y, end.x - start.x);
    const normal = { x: -Math.sin(direction), y: Math.cos(direction) };
    const lateralJitter = endpoint
      ? 0
      : (random() * 2 - 1) * Math.min(26, 7 + spacing * 0.2);
    placements.push({
      point: {
        x: start.x + (end.x - start.x) * progress + normal.x * lateralJitter,
        y: start.y + (end.y - start.y) * progress + normal.y * lateralJitter,
      },
      scale: 0.56 + random() * 0.36,
      rotation: (direction * 180) / Math.PI + (random() * 2 - 1) * 4,
    });
  }
  return placements;
}

/**
 * 将森林区域投影为一组稳定的、可逐个编辑的树群印章。
 *
 * 生成器此前只在林地中心放置一两枚大图标，难以形成成片植被。这里按
 * 森林多边形面积采样，并保留每棵树为 MapArtwork 事实，作者可独立移动、
 * 删除或替换，而不是把树冠烘焙为不可编辑贴图。
 */
function forestStampPlacements(feature: MapFeature): readonly {
  readonly point: { readonly x: number; readonly y: number };
  readonly scale: number;
}[] {
  const polygon = feature.points;
  if (polygon.length === 0) return [];
  const random = seededRandom(`forest-stamps:${feature.id}`);
  const center = polygon.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  center.x /= polygon.length;
  center.y /= polygon.length;
  if (polygon.length < 3) {
    return [
      {
        point: polygon[0]!,
        scale: 0.34 + random() * 0.16,
      },
    ];
  }

  const bounds = polygon.reduce(
    (current, point) => ({
      left: Math.min(current.left, point.x),
      right: Math.max(current.right, point.x),
      top: Math.min(current.top, point.y),
      bottom: Math.max(current.bottom, point.y),
    }),
    {
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const targetCount = Math.max(
    5,
    Math.min(18, Math.round(polygonArea(polygon) / 1_800)),
  );
  const placements: {
    point: { x: number; y: number };
    scale: number;
  }[] = [
    {
      point: center,
      scale: 0.35 + random() * 0.12,
    },
  ];
  for (
    let attempt = 0;
    placements.length < targetCount && attempt < targetCount * 40;
    attempt += 1
  ) {
    const point = {
      x: bounds.left + random() * (bounds.right - bounds.left),
      y: bounds.top + random() * (bounds.bottom - bounds.top),
    };
    if (!polygonContainsPoint(point, polygon)) continue;
    placements.push({
      point,
      scale: 0.26 + random() * 0.23,
    });
  }
  while (placements.length < targetCount) {
    const anchor = polygon[placements.length % polygon.length]!;
    const ratio = 0.2 + random() * 0.58;
    placements.push({
      point: {
        x: center.x + (anchor.x - center.x) * ratio,
        y: center.y + (anchor.y - center.y) * ratio,
      },
      scale: 0.26 + random() * 0.23,
    });
  }
  return placements;
}

function safeId(prefix: string, value: unknown, index: number): string {
  const normalized = String(value ?? index)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `${prefix}-${normalized || index}`;
}

function numberPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function flattenPairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const direct = value
    .map(numberPair)
    .filter((pair): pair is [number, number] => pair !== null);
  if (direct.length > 0) return direct;
  return value.flatMap((entry) => flattenPairs(entry));
}

type CoordinateTransformer = (
  points: readonly [number, number][],
) => { x: number; y: number }[];

function createGeoJsonTransformer(
  points: readonly [number, number][],
  canvas: MapDocument["canvas"],
): CoordinateTransformer {
  if (points.length === 0) return () => [];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sourceWidth = Math.max(0.000001, maxX - minX);
  const sourceHeight = Math.max(0.000001, maxY - minY);
  const padding = Math.min(canvas.width, canvas.height) * 0.05;
  const availableWidth = Math.max(1, canvas.width - padding * 2);
  const availableHeight = Math.max(1, canvas.height - padding * 2);
  const scale = Math.min(
    availableWidth / sourceWidth,
    availableHeight / sourceHeight,
  );
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (canvas.width - renderedWidth) / 2;
  const offsetY = (canvas.height - renderedHeight) / 2;
  return (coordinates) =>
    coordinates.map(([x, y]) => ({
      x: offsetX + (x - minX) * scale,
      y: canvas.height - (offsetY + (y - minY) * scale),
    }));
}

function featureName(
  properties: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  for (const key of ["name", "title", "type", "group", "id"]) {
    const value = properties?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

function convertGeoJsonFeature(
  feature: GeoJsonFeature,
  index: number,
  document: MapDocument,
  layerId: string,
  transform: CoordinateTransformer,
): MapFeature[] {
  const geometryType = feature.geometry?.type;
  const properties = feature.properties;
  const color =
    typeof properties?.color === "string"
      ? properties.color
      : typeof properties?.stroke === "string"
        ? properties.stroke
        : "#7c684f";
  const fill =
    typeof properties?.fill === "string" ? properties.fill : "#8ba07a55";
  const base = {
    entityRef: null,
    layerId,
    timeFrom: null,
    timeTo: null,
    description: "",
  } as const;
  const idBase = safeId("generated", properties?.id, index);
  const name = featureName(properties, `生成要素 ${index + 1}`);

  if (geometryType === "Point") {
    const point = numberPair(feature.geometry?.coordinates);
    if (!point) return [];
    return [
      {
        ...base,
        id: idBase,
        kind: "marker",
        name,
        points: transform([point]),
        props: { color, showLabel: "true", generator: "azgaar" },
      },
    ];
  }
  if (geometryType === "LineString" || geometryType === "MultiLineString") {
    const points = transform(flattenPairs(feature.geometry?.coordinates));
    if (points.length < 2) return [];
    return [
      {
        ...base,
        id: idBase,
        kind: "route",
        name,
        points: points.slice(0, 512),
        props: { color, lineWidth: "2", generator: "azgaar" },
      },
    ];
  }
  if (geometryType === "Polygon" || geometryType === "MultiPolygon") {
    const rings = Array.isArray(feature.geometry?.coordinates)
      ? geometryType === "Polygon"
        ? [feature.geometry?.coordinates]
        : feature.geometry?.coordinates
      : [];
    return rings.flatMap((ring, ringIndex) => {
      const rawPoints = flattenPairs(ring);
      const closed =
        rawPoints.length > 2 &&
        rawPoints[0]?.[0] === rawPoints.at(-1)?.[0] &&
        rawPoints[0]?.[1] === rawPoints.at(-1)?.[1]
          ? rawPoints.slice(0, -1)
          : rawPoints;
      const points = transform(closed).slice(0, 512);
      if (points.length < 3) return [];
      return [
        {
          ...base,
          id: ringIndex === 0 ? idBase : `${idBase}-${ringIndex + 1}`,
          kind: "area" as const,
          name: ringIndex === 0 ? name : `${name} ${ringIndex + 1}`,
          points,
          props: { color, fill, lineWidth: "1", generator: "azgaar" },
        },
      ];
    });
  }
  return [];
}

function convertAzgaarPack(
  value: Record<string, unknown>,
  document: MapDocument,
  layerId: string,
): MapFeature[] {
  const pack = value.pack;
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return [];
  const source = pack as Record<string, unknown>;
  const features: MapFeature[] = [];
  const addPoint = (entry: unknown, index: number, prefix: string) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const item = entry as Record<string, unknown>;
    const point = numberPair([item.x, item.y]);
    if (!point) return;
    features.push({
      id: safeId(prefix, item.i, index),
      kind: "marker",
      name:
        typeof item.name === "string" ? item.name : `${prefix} ${index + 1}`,
      entityRef: null,
      layerId,
      // 不要把外部地图坐标裁到旧画布。MapEditor 会在应用候选时根据
      // 全部内容扩展画布，裁剪会让越界事实不可恢复。
      points: [{ x: point[0], y: point[1] }],
      timeFrom: null,
      timeTo: null,
      props: {
        color: typeof item.fill === "string" ? item.fill : "#7c684f",
        showLabel: "true",
        generator: "azgaar",
      },
      description: "",
    });
  };
  (Array.isArray(source.burgs) ? source.burgs : []).forEach((entry, index) =>
    addPoint(entry, index, "burg"),
  );
  (Array.isArray(source.markers) ? source.markers : []).forEach(
    (entry, index) => addPoint(entry, index, "marker"),
  );
  for (const collectionName of ["routes", "rivers"] as const) {
    (Array.isArray(source[collectionName])
      ? source[collectionName]
      : []
    ).forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const item = entry as Record<string, unknown>;
      const points = flattenPairs(item.points)
        .map(([x, y]) => ({ x, y }))
        .slice(0, 512);
      if (points.length < 2) return;
      features.push({
        id: safeId(collectionName.slice(0, -1), item.i, index),
        kind: "route",
        name:
          typeof item.name === "string"
            ? item.name
            : `${collectionName} ${index + 1}`,
        entityRef: null,
        layerId,
        points,
        timeFrom: null,
        timeTo: null,
        props: {
          color: collectionName === "rivers" ? "#4d8399" : "#7c684f",
          lineWidth: "2",
          generator: "azgaar",
        },
        description: "",
      });
    });
  }
  return features;
}

function deduplicateIds(features: readonly MapFeature[]): MapFeature[] {
  const used = new Set<string>();
  return features.map((feature) => {
    let id = feature.id;
    let suffix = 2;
    while (used.has(id)) id = `${feature.id}-${suffix++}`;
    used.add(id);
    return id === feature.id ? feature : { ...feature, id };
  });
}

function parseSvgNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSvgCanvasSize(
  content: string,
): { readonly width: number; readonly height: number } | null {
  const root = content.match(/<svg\b([^>]*)>/iu)?.[1];
  if (!root) return null;
  const attribute = (name: string) =>
    root.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu"))?.[1];
  const width = parseSvgNumber(attribute("width"));
  const height = parseSvgNumber(attribute("height"));
  if (width && height) {
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }
  const viewBox = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map((value) => Number.parseFloat(value));
  if (!viewBox || viewBox.length !== 4) return null;
  const viewBoxWidth = viewBox[2];
  const viewBoxHeight = viewBox[3];
  if (
    !Number.isFinite(viewBoxWidth) ||
    !Number.isFinite(viewBoxHeight) ||
    viewBoxWidth <= 0 ||
    viewBoxHeight <= 0
  ) {
    return null;
  }
  return {
    width: Math.ceil(viewBoxWidth),
    height: Math.ceil(viewBoxHeight),
  };
}

export function importAzgaarCandidate(input: {
  readonly fileName: string;
  readonly content: string;
  readonly document: MapDocument;
  readonly layerId: string;
}): MapGeneratorCandidate {
  if (input.fileName.toLocaleLowerCase("en-US").endsWith(".svg")) {
    if (!/<svg[\s>]/iu.test(input.content))
      throw new Error("所选文件不是有效的 SVG。");
    const encoded = btoa(unescape(encodeURIComponent(input.content)));
    const svgSize = parseSvgCanvasSize(input.content);
    return {
      generatorId: "azgaar",
      title: input.fileName,
      summary: "Azgaar SVG 将作为不可破坏的底图候选导入。",
      seed: null,
      canvas: {
        backgroundImage: `data:image/svg+xml;base64,${encoded}`,
        backgroundImageVisible: true,
        backgroundOpacity: 1,
        ...(svgSize
          ? {
              width: svgSize.width,
              height: svgSize.height,
              backgroundImageWidth: svgSize.width,
              backgroundImageHeight: svgSize.height,
            }
          : {}),
      },
      features: [],
    };
  }
  if (input.fileName.toLocaleLowerCase("en-US").endsWith(".map")) {
    throw new Error(
      "Azgaar 原生 .map 文件需要在独立 Fantasy Map Generator 运行时中打开后导出 Full/Minimal JSON、GeoJSON 或 SVG；当前导入器不会伪解析 .map。",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.content);
  } catch (error) {
    throw new Error(
      `无法解析 Azgaar JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Azgaar 导出内容必须是 JSON 对象。");
  }
  const record = value as Record<string, unknown>;
  const sourceGeoJsonFeatures =
    record.type === "FeatureCollection" && Array.isArray(record.features)
      ? (record.features as GeoJsonFeature[])
      : [];
  const geoJsonTransformer = createGeoJsonTransformer(
    sourceGeoJsonFeatures.flatMap((feature) =>
      flattenPairs(feature.geometry?.coordinates),
    ),
    input.document.canvas,
  );
  const geoJsonFeatures = sourceGeoJsonFeatures.flatMap((feature, index) =>
    convertGeoJsonFeature(
      feature,
      index,
      input.document,
      input.layerId,
      geoJsonTransformer,
    ),
  );
  const packFeatures = convertAzgaarPack(record, input.document, input.layerId);
  const features = deduplicateIds([...geoJsonFeatures, ...packFeatures]);
  if (features.length === 0) {
    throw new Error(
      "未识别到可导入的 Azgaar 要素。请导出 Full/Minimal JSON、GeoJSON 或 SVG。",
    );
  }
  const info =
    record.info &&
    typeof record.info === "object" &&
    !Array.isArray(record.info)
      ? (record.info as Record<string, unknown>)
      : null;
  return {
    generatorId: "azgaar",
    title: typeof info?.mapName === "string" ? info.mapName : input.fileName,
    summary: `已转换 ${features.length} 个地点、路线或区域要素。`,
    seed:
      typeof info?.seed === "string" || typeof info?.seed === "number"
        ? String(info.seed)
        : null,
    features,
  };
}

export function generateRedBlobCandidate(input: {
  readonly seed: string;
  readonly document: MapDocument;
  readonly layerId: string;
  readonly landmassCount: number;
}): MapGeneratorCandidate {
  const seed = input.seed.trim() || `map-${Date.now().toString(36)}`;
  const random = seededRandom(seed);
  const count = Math.max(1, Math.min(6, Math.round(input.landmassCount)));
  const margin =
    Math.min(input.document.canvas.width, input.document.canvas.height) * 0.08;
  const features: MapFeature[] = [];
  for (let index = 0; index < count; index += 1) {
    const centerX =
      margin + random() * (input.document.canvas.width - margin * 2);
    const centerY =
      margin + random() * (input.document.canvas.height - margin * 2);
    const baseRadius =
      Math.min(input.document.canvas.width, input.document.canvas.height) *
      (0.09 + random() * 0.12);
    const vertexCount = 18 + Math.floor(random() * 12);
    const points = Array.from({ length: vertexCount }, (_, vertexIndex) => {
      const angle = (Math.PI * 2 * vertexIndex) / vertexCount;
      const radius = baseRadius * (0.7 + random() * 0.55);
      return {
        x: Math.max(
          0,
          Math.min(
            input.document.canvas.width,
            centerX + Math.cos(angle) * radius * (0.85 + random() * 0.35),
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            input.document.canvas.height,
            centerY + Math.sin(angle) * radius * (0.7 + random() * 0.45),
          ),
        ),
      };
    });
    features.push({
      id: `generated-land-${hashSeed(`${seed}-${index}`).toString(36)}`,
      kind: "area",
      name: `大陆 ${index + 1}`,
      entityRef: null,
      layerId: input.layerId,
      points,
      timeFrom: null,
      timeTo: null,
      props: {
        color: "#6d765c",
        fill: index % 2 === 0 ? "#a5ad7cbb" : "#c0a46fbb",
        lineWidth: "2",
        generator: "red-blob",
        seed,
      },
      description: "本地地形生成候选，可继续逐点编辑。",
    });
  }
  return {
    generatorId: "red-blob",
    title: `地形种子 ${seed}`,
    summary: `生成 ${features.length} 块可编辑大陆轮廓。`,
    seed,
    features,
  };
}

export function generateFantasyMapCandidate(input: {
  readonly seed: string;
  readonly document: MapDocument;
  readonly layerId: string;
  readonly landmassCount?: number;
  readonly regionCount?: number;
  readonly riverCount?: number;
  readonly placeNames?: readonly string[];
  readonly factionNames?: readonly string[];
  readonly spatialNames?: readonly string[];
  readonly terrainKeywords?: readonly string[];
}): MapGeneratorCandidate {
  const generated = generateFantasyMapCandidateCore({
    seed: input.seed,
    width: input.document.canvas.width,
    height: input.document.canvas.height,
    layerId: input.layerId,
    landmassCount: input.landmassCount,
    regionCount: input.regionCount,
    riverCount: input.riverCount,
    placeNames: input.placeNames,
    factionNames: input.factionNames,
    spatialNames: input.spatialNames,
    terrainKeywords: input.terrainKeywords,
  });
  return {
    generatorId: "fantasy-map",
    title: generated.title,
    summary: generated.summary,
    seed: generated.seed,
    features: generated.features.map((feature) => ({
      ...feature,
      points: [...feature.points],
      props: { ...feature.props },
    })),
  };
}

export function applyGeneratorCandidate(
  document: MapDocument,
  candidate: MapGeneratorCandidate,
): MapDocument {
  const sourceLayerIds = mapGeneratorSourceLayerIds(candidate.generatorId);
  const sourceLabel = mapGeneratorSourceLabel(candidate.generatorId);
  const hasGeneratedGeometry = candidate.features.length > 0;
  const layers = hasGeneratedGeometry
    ? document.layers.some((layer) => layer.id === sourceLayerIds.feature)
      ? document.layers
      : [
          ...document.layers,
          {
            id: sourceLayerIds.feature,
            name: `${sourceLabel} · 生成结果`,
            visible: true,
            locked: false,
            opacity: 1,
          },
        ]
    : document.layers;
  const existingIds = new Set(document.features.map((feature) => feature.id));
  const landCandidates = candidate.features.filter(
    (feature) =>
      isMapFeatureFreeformArea(feature.kind) &&
      (feature.props.terrain === "coast" ||
        feature.props.terrain === "island" ||
        candidate.generatorId === "red-blob"),
  );
  const waterCandidates = candidate.features.filter(
    (feature) =>
      isMapFeatureFreeformArea(feature.kind) &&
      feature.props.terrain === "lake",
  );
  const features = candidate.features.map((feature) => {
      let id = feature.id;
      let suffix = 2;
      while (existingIds.has(id)) id = `${feature.id}-${suffix++}`;
      existingIds.add(id);
      const isSceneSurface =
        landCandidates.includes(feature) || waterCandidates.includes(feature);
      return {
        ...(id === feature.id ? feature : { ...feature, id }),
        layerId: sourceLayerIds.feature,
        ...(isSceneSurface
          ? {
              props: {
                ...feature.props,
                // 海陆轮廓同时驱动 MapFeature 与 MapScene；场景层只负责
                // 材质合成，不再持有一份无法编辑的独立地表事实。
                sceneSurface: "true",
              },
            }
          : {}),
      };
    });
  const initialScene = document.scene ?? createEmptyMapScene();
  const sceneWithSourceLayer = hasGeneratedGeometry
    ? initialScene.layers.some((layer) => layer.id === sourceLayerIds.scene)
      ? initialScene
      : {
          ...initialScene,
          layers: [
            ...initialScene.layers,
            {
              id: sourceLayerIds.scene,
              name: `${sourceLabel} · 地形底稿`,
              // 生成的区域和材质笔触共用一个来源层。场景合成器按区域
              // kind 处理海陆，因此该层使用 terrain 只表示它是可编辑
              // 底稿，不会把湖泊误判为陆地。
              kind: "terrain" as const,
              visible: true,
              locked: false,
              opacity: 1,
              regions: [],
              strokes: [],
            },
          ],
        }
    : initialScene;
  const sceneRegionIds = new Set(
    sceneWithSourceLayer.layers.flatMap((layer) =>
      layer.regions.map((region) => region.id),
    ),
  );
  const landScene = landCandidates.reduce((currentScene, feature, index) => {
    let regionId = `region-${feature.id}`;
    let suffix = 2;
    while (sceneRegionIds.has(regionId))
      regionId = `region-${feature.id}-${suffix++}`;
    sceneRegionIds.add(regionId);
    return addMapSceneRegion(
      currentScene,
      createMapSceneRegion({
        id: regionId,
        layerId: sourceLayerIds.scene,
        sourceFeatureId: feature.id,
        kind: "land",
        points: feature.points,
        fill: feature.props.fill ?? (index % 2 === 0 ? "#b8ad7d" : "#c9b983"),
        edgeColor: feature.props.color ?? "#5c5038",
        edgeWidth: Math.max(1, Number(feature.props.lineWidth ?? 3)),
      }),
    );
  }, sceneWithSourceLayer);
  const scene = waterCandidates.reduce((currentScene, feature) => {
    let regionId = `region-${feature.id}`;
    let suffix = 2;
    while (sceneRegionIds.has(regionId))
      regionId = `region-${feature.id}-${suffix++}`;
    sceneRegionIds.add(regionId);
    return addMapSceneRegion(
      currentScene,
      createMapSceneRegion({
        id: regionId,
        layerId: sourceLayerIds.scene,
        sourceFeatureId: feature.id,
        kind: "water",
        points: feature.points,
        fill: feature.props.fill ?? "#5d9caf",
        edgeColor: feature.props.color ?? "#2f6377",
        edgeWidth: Math.max(1, Number(feature.props.lineWidth ?? 2)),
      }),
    );
  }, landScene);

  // 森林候选不能只是一层半透明的业务多边形。将它投影成地形层中的
  // 可编辑材质笔触，地图画布和 PNG 导出就会经由同一个地表合成器表现
  // 林冠纹理；原始森林要素仍保留给标签、关联实体和后续手工编辑。
  let enhancedScene = scene;
  const sceneStrokeIds = new Set(
    enhancedScene.layers.flatMap((layer) =>
      layer.strokes.map((stroke) => stroke.id),
    ),
  );
  const generatedTerrainMaterial = (
    feature: MapFeature,
  ): MapTerrainMaterial | null => {
    if (feature.props.terrain === "forest") return "forest";
    if (feature.props.terrain !== "biome") return null;
    switch (feature.props.terrainMaterial) {
      case "grassland":
      case "forest":
      case "desert":
      case "badlands":
      case "tundra":
      case "snow":
      case "swamp":
      case "volcanic":
        return feature.props.terrainMaterial;
      default:
        return null;
    }
  };
  candidate.features.forEach((feature) => {
    const terrainMaterial = generatedTerrainMaterial(feature);
    if (!terrainMaterial || feature.points.length === 0) {
      return;
    }
    const terrainLayer = enhancedScene.layers.find(
      (layer) => layer.id === sourceLayerIds.scene,
    );
    if (!terrainLayer) return;
    const center = feature.points.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 },
    );
    center.x /= feature.points.length;
    center.y /= feature.points.length;
    const radius = Math.max(
      40,
      ...feature.points.map((point) =>
        Math.hypot(point.x - center.x, point.y - center.y),
      ),
    );
    const baseId = `generated-material-${feature.id}`;
    let strokeId = baseId;
    let suffix = 2;
    while (sceneStrokeIds.has(strokeId)) strokeId = `${baseId}-${suffix++}`;
    sceneStrokeIds.add(strokeId);
    const material = getMapTerrainMaterialPreset(terrainMaterial);
    enhancedScene = addMapSceneStroke(
      enhancedScene,
      createMapSceneStroke({
        id: strokeId,
        layerId: terrainLayer.id,
        terrainMaterial,
        shape: "organic",
        points: [center],
        color: material.color,
        width: Math.min(420, radius * 1.55),
        opacity: 0.74,
        spacing: Math.max(16, radius * 0.28),
      }),
    );
  });

  // 生成器的几何候选负责事实与拓扑；这些确定性的素材印章负责把候选
  // 直接提升到可继续编辑的成图质感。印章仍保存在 MapArtwork 中，作者
  // 可以像手工放置的素材一样移动、缩放、删除，不会把生成结果烘焙死。
  const artworkAssetForFeature = (feature: MapFeature): string | null => {
    const terrain = feature.props.terrain;
    if (terrain === "mountain") {
      return feature.props.mountainStyle === "snow"
        ? "snow-peak"
        : "mountain-range";
    }
    if (terrain === "forest") return "forest";
    const component = feature.props.component;
    if (
      feature.props.planEntityId &&
      mapGenerationRoleUsesLandmarkArtwork(feature.props.entityRole ?? "") &&
      component &&
      getMapArtworkStampAsset(component)
    ) {
      return component;
    }
    return null;
  };
  const artwork = hasGeneratedGeometry
    ? [
        {
          id: sourceLayerIds.relief,
          name: `${sourceLabel} · 山脉地貌`,
          kind: "relief" as const,
        },
        {
          id: sourceLayerIds.vegetation,
          name: `${sourceLabel} · 植被`,
          kind: "vegetation" as const,
        },
        {
          id: sourceLayerIds.civilization,
          name: `${sourceLabel} · 宗门与遗迹`,
          kind: "stamp" as const,
        },
      ].reduce(
        (currentArtwork, descriptor) =>
          currentArtwork.layers.some((layer) => layer.id === descriptor.id)
            ? currentArtwork
            : addMapArtworkLayer(
                currentArtwork,
                createMapArtworkLayer(descriptor),
              ),
        document.artwork,
      )
    : document.artwork;
  let nextArtwork = artwork;
  const artworkIds = new Set(
    artwork.layers.flatMap((layer) => layer.stamps.map((stamp) => stamp.id)),
  );
  const addGeneratedStamp = (
    feature: MapFeature,
    point: MapFeature["points"][number],
    index: number,
    style?: {
      readonly scale?: number;
      readonly opacity?: number;
      readonly rotation?: number;
    },
  ) => {
    const assetId = artworkAssetForFeature(feature);
    if (!assetId) return;
    const layerId =
      assetId === "mountain-range" || assetId === "snow-peak"
        ? sourceLayerIds.relief
        : assetId === "forest"
          ? sourceLayerIds.vegetation
          : sourceLayerIds.civilization;
    const baseId = `generated-artwork-${feature.id}-${index}`;
    let stampId = baseId;
    let suffix = 2;
    while (artworkIds.has(stampId)) stampId = `${baseId}-${suffix++}`;
    artworkIds.add(stampId);
    const defaultScale =
      assetId === "mountain-range" || assetId === "snow-peak"
        ? 0.72
        : assetId === "forest"
          ? 0.58
          : assetId === "port"
            ? 0.46
            : 0.44;
    const asset = getMapArtworkStampAsset(assetId);
    nextArtwork = addMapArtworkStamp(
      nextArtwork,
      createMapArtworkStamp({
        id: stampId,
        layerId,
        assetId,
        x: point.x,
        y: point.y,
        sourceFeatureId: feature.id,
        variant: asset
          ? mapArtworkVariantIndex(asset, `${feature.id}:${index}`)
          : 0,
        scale: style?.scale ?? defaultScale,
        rotation:
          style?.rotation ??
          ((assetId === "mountain-range" || assetId === "snow-peak") &&
          feature.points.length > 1
            ? (Math.atan2(
                (feature.points[Math.min(index + 1, feature.points.length - 1)]
                  ?.y ?? point.y) - point.y,
                (feature.points[Math.min(index + 1, feature.points.length - 1)]
                  ?.x ?? point.x) - point.x,
              ) *
                180) /
              Math.PI
            : 0),
        opacity: style?.opacity ?? 0.9,
      }),
    );
  };
  candidate.features.forEach((feature) => {
    const assetId = artworkAssetForFeature(feature);
    if (!assetId || feature.points.length === 0) return;
    if (assetId === "mountain-range" || assetId === "snow-peak") {
      mountainStampPlacements(feature).forEach((placement, index) => {
        addGeneratedStamp(feature, placement.point, index, {
          scale: placement.scale,
          opacity: 0.92,
          rotation: placement.rotation,
        });
      });
      return;
    }
    if (assetId === "forest") {
      forestStampPlacements(feature).forEach((placement, index) => {
        addGeneratedStamp(feature, placement.point, index, {
          scale: placement.scale,
          opacity: 0.86,
        });
      });
      return;
    }
    addGeneratedStamp(feature, feature.points[0]!, 0);
  });
  const applied = {
    ...document,
    canvas: { ...document.canvas, ...candidate.canvas },
    layers,
    features: [...document.features, ...features],
    // 即使候选只有地点、路线等语义要素，也保留对应的来源场景层，
    // 这样后续再次生成地形时仍能沿用同一来源层的显隐和锁定状态。
    scene: hasGeneratedGeometry ? enhancedScene : document.scene,
    artwork: nextArtwork,
  };
  // 所有生成器候选都必须遵守同一条首次构图契约。Azgaar JSON/GeoJSON
  // 候选在此前只会等到保存或重载时收束，导致“应用”后的即时画布仍保留
  // 默认 1600×1000 空白区域；已有作者内容则由 helper 原样保留。
  return fitMapCanvasToContentWhenEmpty(document, applied);
}

/**
 * 构造生成候选的只读预览文档。
 *
 * 预览与正式落地必须共享同一个候选投影；额外执行边界扩展是为了让
 * 越界导入或手工生成的候选在尚未写入 MapDocument 时也能完整显示。
 * 该函数只返回新文档，不触碰 Repository，也不会产生撤销历史。
 */
export function previewGeneratorCandidate(
  document: MapDocument,
  candidate: MapGeneratorCandidate,
): MapDocument {
  return expandMapCanvasToContent(applyGeneratorCandidate(document, candidate));
}
