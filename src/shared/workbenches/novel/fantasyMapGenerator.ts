/**
 * Deterministic fantasy-map adapter shared by the Agent tool and the map UI.
 * It intentionally returns plain JSON-compatible values so the server never
 * needs to import renderer modules or own MapDocument persistence.
 */

import {
  FANTASY_MAP_STYLE_ID,
  localizeFantasyMapFeatures,
} from "./fantasyMapStyle";
import type {
  MapGenerationEntityRole,
  MapGenerationPlan,
  MapGenerationPlannedEntity,
  MapGenerationZone,
} from "./mapGenerationPlan";

export type FantasyFeatureKind = "marker" | "label" | "area" | "route";

export interface FantasyPoint {
  readonly x: number;
  readonly y: number;
}

export interface FantasyFeature {
  readonly id: string;
  readonly kind: FantasyFeatureKind;
  readonly name: string;
  readonly entityRef: {
    readonly kind:
      | "character"
      | "event"
      | "location"
      | "faction"
      | "item"
      | "setting";
    readonly id: string;
  } | null;
  readonly layerId: string;
  readonly points: readonly FantasyPoint[];
  readonly timeFrom: null;
  readonly timeTo: null;
  readonly props: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface FantasyMapGenerationInput {
  readonly seed: string;
  readonly width: number;
  readonly height: number;
  readonly layerId: string;
  readonly landmassCount?: number;
  readonly regionCount?: number;
  readonly riverCount?: number;
  readonly placeNames?: readonly string[];
  readonly factionNames?: readonly string[];
  readonly spatialNames?: readonly string[];
  readonly terrainKeywords?: readonly string[];
  /** Agent 对世界架构作出的完整空间规划；缺失时保留离线兼容生成行为。 */
  readonly plan?: MapGenerationPlan;
}

export interface FantasyMapGenerationResult {
  readonly seed: string;
  readonly title: string;
  readonly summary: string;
  readonly features: readonly FantasyFeature[];
}

export function bindFantasyPlanToFeatures(input: {
  readonly features: readonly FantasyFeature[];
  readonly plan: MapGenerationPlan;
  readonly width: number;
  readonly height: number;
  readonly layerId: string;
}): FantasyFeature[] {
  const coast = input.features
    .filter((feature) => feature.kind === "area" && feature.points.length >= 3)
    .sort((left, right) => right.points.length - left.points.length)[0]
    ?.points ?? [
    { x: 12, y: 12 },
    { x: input.width - 12, y: 12 },
    { x: input.width - 12, y: input.height - 12 },
    { x: 12, y: input.height - 12 },
  ];
  return applyGenerationPlan(
    {
      seed: `plan:${input.plan.worldSourceHash}`,
      width: input.width,
      height: input.height,
      layerId: input.layerId,
      plan: input.plan,
    },
    [...input.features],
    coast,
    seededRandom(`plan:${input.plan.worldSourceHash}`),
  );
}

type FantasyBiomeMaterial =
  | "grassland"
  | "forest"
  | "desert"
  | "badlands"
  | "tundra"
  | "snow"
  | "swamp"
  | "volcanic";

const FANTASY_BIOME_LABELS: Readonly<Record<FantasyBiomeMaterial, string>> =
  Object.freeze({
    grassland: "草原",
    forest: "林地",
    desert: "荒漠",
    badlands: "赤地",
    tundra: "冻土",
    snow: "雪原",
    swamp: "湿地",
    volcanic: "火山岩地",
  });

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

function safeId(prefix: string, value: string): string {
  const normalized = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 42);
  return `${prefix}-${normalized || "generated"}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function point(x: number, y: number): FantasyPoint {
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function pointInPolygon(
  candidate: FantasyPoint,
  polygon: readonly FantasyPoint[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const current = polygon[index]!;
    const last = polygon[previous]!;
    const cross =
      (candidate.x - current.x) * (last.y - current.y) -
      (candidate.y - current.y) * (last.x - current.x);
    const dot =
      (candidate.x - current.x) * (candidate.x - last.x) +
      (candidate.y - current.y) * (candidate.y - last.y);
    if (Math.abs(cross) < 0.01 && dot <= 0.01) return true;
    const crosses =
      current.y > candidate.y !== last.y > candidate.y &&
      candidate.x <
        ((last.x - current.x) * (candidate.y - current.y)) /
          (last.y - current.y || Number.EPSILON) +
          current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonBounds(polygon: readonly FantasyPoint[]): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} {
  return polygon.reduce(
    (bounds, candidate) => ({
      left: Math.min(bounds.left, candidate.x),
      right: Math.max(bounds.right, candidate.x),
      top: Math.min(bounds.top, candidate.y),
      bottom: Math.max(bounds.bottom, candidate.y),
    }),
    {
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
}

/** 在给定大陆范围内稳定采样一点；失败时返回多边形质心附近的锚点。 */
function randomLandPoint(
  random: () => number,
  polygon: readonly FantasyPoint[],
  fallback: FantasyPoint,
): FantasyPoint {
  const bounds = polygonBounds(polygon);
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const candidate = point(
      bounds.left + random() * (bounds.right - bounds.left),
      bounds.top + random() * (bounds.bottom - bounds.top),
    );
    if (pointInPolygon(candidate, polygon)) return candidate;
  }
  return fallback;
}

/** 将路径点收束到从锚点出发的大陆内部线段，避免河流或植被穿出海岸。 */
function projectInsidePolygon(
  candidate: FantasyPoint,
  anchor: FantasyPoint,
  polygon: readonly FantasyPoint[],
): FantasyPoint {
  if (pointInPolygon(candidate, polygon)) return candidate;
  let low = 0;
  let high = 1;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const middle = (low + high) / 2;
    const probe = point(
      anchor.x + (candidate.x - anchor.x) * middle,
      anchor.y + (candidate.y - anchor.y) * middle,
    );
    if (pointInPolygon(probe, polygon)) low = middle;
    else high = middle;
  }
  return point(
    anchor.x + (candidate.x - anchor.x) * low,
    anchor.y + (candidate.y - anchor.y) * low,
  );
}

function farthestCoastPoint(
  polygon: readonly FantasyPoint[],
  center: FantasyPoint,
  angle: number,
): FantasyPoint {
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  return polygon.reduce(
    (farthest, candidate) => {
      const distance =
        (candidate.x - center.x) * direction.x +
        (candidate.y - center.y) * direction.y;
      return distance > farthest.distance
        ? { point: candidate, distance }
        : farthest;
    },
    { point: polygon[0] ?? center, distance: Number.NEGATIVE_INFINITY },
  ).point;
}

function segmentIntersection(
  from: FantasyPoint,
  to: FantasyPoint,
  otherFrom: FantasyPoint,
  otherTo: FantasyPoint,
): FantasyPoint | null {
  const denominator =
    (to.x - from.x) * (otherTo.y - otherFrom.y) -
    (to.y - from.y) * (otherTo.x - otherFrom.x);
  if (Math.abs(denominator) < 0.000001) return null;
  const fromToOther = {
    x: otherFrom.x - from.x,
    y: otherFrom.y - from.y,
  };
  const along =
    (fromToOther.x * (otherTo.y - otherFrom.y) -
      fromToOther.y * (otherTo.x - otherFrom.x)) /
    denominator;
  const across =
    (fromToOther.x * (to.y - from.y) - fromToOther.y * (to.x - from.x)) /
    denominator;
  // 道路端点常常就是聚落或河岸，不把端点接触误判成桥梁。
  if (along <= 0.06 || along >= 0.94 || across <= 0.06 || across >= 0.94) {
    return null;
  }
  return point(
    from.x + (to.x - from.x) * along,
    from.y + (to.y - from.y) * along,
  );
}

function pathIntersectsPolygon(
  path: readonly FantasyPoint[],
  polygon: readonly FantasyPoint[],
): boolean {
  if (path.length < 2 || polygon.length < 3) return false;
  for (const candidate of path) {
    if (pointInPolygon(candidate, polygon)) return true;
  }
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]!;
    const to = path[index]!;
    for (let edge = 0; edge < polygon.length; edge += 1) {
      const edgeFrom = polygon[edge]!;
      const edgeTo = polygon[(edge + 1) % polygon.length]!;
      if (segmentIntersection(from, to, edgeFrom, edgeTo) !== null) {
        return true;
      }
    }
  }
  return false;
}

function firstPathIntersection(
  path: readonly FantasyPoint[],
  watercourses: readonly FantasyFeature[],
): FantasyPoint | null {
  for (let pathIndex = 1; pathIndex < path.length; pathIndex += 1) {
    const from = path[pathIndex - 1]!;
    const to = path[pathIndex]!;
    for (const watercourse of watercourses) {
      for (
        let waterIndex = 1;
        waterIndex < watercourse.points.length;
        waterIndex += 1
      ) {
        const crossing = segmentIntersection(
          from,
          to,
          watercourse.points[waterIndex - 1]!,
          watercourse.points[waterIndex]!,
        );
        if (crossing) return crossing;
      }
    }
  }
  return null;
}

function distanceSquared(from: FantasyPoint, to: FantasyPoint): number {
  const deltaX = from.x - to.x;
  const deltaY = from.y - to.y;
  return deltaX * deltaX + deltaY * deltaY;
}

function nearestPathPointIndex(
  path: readonly FantasyPoint[],
  target: FantasyPoint,
): number {
  return path.reduce(
    (best, candidate, index) =>
      distanceSquared(candidate, target) < distanceSquared(path[best]!, target)
        ? index
        : best,
    0,
  );
}

function withoutAdjacentDuplicates(
  points: readonly FantasyPoint[],
): FantasyPoint[] {
  return points.reduce<FantasyPoint[]>((result, candidate) => {
    const previous = result.at(-1);
    if (!previous || distanceSquared(previous, candidate) > 0.01) {
      result.push(candidate);
    }
    return result;
  }, []);
}

/**
 * 同一河系中的城镇不会凭空拉一条随机折线，而是沿河谷走向组织商路。
 * 河道仍是单独的水系事实：道路控制点只以稳定偏移派生，作者可以继续
 * 拖动任一点改写它。偏移也避免道路与河流在成图上完全重叠。
 */
function valleyRoadPath(input: {
  readonly roadId: string;
  readonly from: FantasyPoint;
  readonly to: FantasyPoint;
  readonly waterway: FantasyFeature;
  readonly coast: readonly FantasyPoint[];
  readonly width: number;
  readonly height: number;
}): FantasyPoint[] | null {
  const waterwayPoints = input.waterway.points;
  if (waterwayPoints.length < 3) return null;
  const fromIndex = nearestPathPointIndex(waterwayPoints, input.from);
  const toIndex = nearestPathPointIndex(waterwayPoints, input.to);
  if (Math.abs(toIndex - fromIndex) < 2) return null;

  const direction = toIndex > fromIndex ? 1 : -1;
  const lateralOffset = clamp(
    Math.min(input.width, input.height) * 0.012,
    10,
    22,
  );
  const startAnchor = waterwayPoints[fromIndex]!;
  const startBefore = waterwayPoints[Math.max(0, fromIndex - 1)]!;
  const startAfter =
    waterwayPoints[Math.min(waterwayPoints.length - 1, fromIndex + 1)]!;
  const startTangent = {
    x: startAfter.x - startBefore.x,
    y: startAfter.y - startBefore.y,
  };
  const startBank =
    startTangent.x * (input.from.y - startAnchor.y) -
    startTangent.y * (input.from.x - startAnchor.x);
  // 优先沿起始聚落所在河岸走，避免道路刚离开聚落就横跨河面；聚落恰好
  // 位于河道锚点时再使用稳定种子决定一侧。终点若在另一岸，下面的交叉
  // 检测会留下真实桥梁，而不是把跨河关系藏在路线属性中。
  const side =
    Math.abs(startBank) > 0.1
      ? Math.sign(startBank)
      : hashSeed(`${input.roadId}:valley`) % 2 === 0
        ? 1
        : -1;
  const valleyPoints: FantasyPoint[] = [];
  for (
    let index = fromIndex;
    direction > 0 ? index <= toIndex : index >= toIndex;
    index += direction
  ) {
    const anchor = waterwayPoints[index]!;
    const before = waterwayPoints[Math.max(0, index - 1)]!;
    const after =
      waterwayPoints[Math.min(waterwayPoints.length - 1, index + 1)]!;
    const deltaX = after.x - before.x;
    const deltaY = after.y - before.y;
    const length = Math.max(1, Math.hypot(deltaX, deltaY));
    const candidate = point(
      anchor.x + (-deltaY / length) * lateralOffset * side,
      anchor.y + (deltaX / length) * lateralOffset * side,
    );
    valleyPoints.push(projectInsidePolygon(candidate, anchor, input.coast));
  }
  return withoutAdjacentDuplicates([input.from, ...valleyPoints, input.to]);
}

function clipByBisector(
  polygon: readonly FantasyPoint[],
  site: FantasyPoint,
  other: FantasyPoint,
): FantasyPoint[] {
  if (polygon.length === 0) return [];
  const dx = other.x - site.x;
  const dy = other.y - site.y;
  const limit =
    (other.x * other.x +
      other.y * other.y -
      site.x * site.x -
      site.y * site.y) /
    2;
  const inside = (value: FantasyPoint) =>
    value.x * dx + value.y * dy <= limit + 0.0001;
  const intersection = (from: FantasyPoint, to: FantasyPoint): FantasyPoint => {
    const denominator = (to.x - from.x) * dx + (to.y - from.y) * dy;
    if (Math.abs(denominator) < 0.000001) return from;
    const ratio = (limit - from.x * dx - from.y * dy) / denominator;
    return point(
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
    );
  };
  const result: FantasyPoint[] = [];
  let previous = polygon[polygon.length - 1]!;
  let previousInside = inside(previous);
  for (const current of polygon) {
    const currentInside = inside(current);
    if (currentInside !== previousInside)
      result.push(intersection(previous, current));
    if (currentInside) result.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function coastline(
  random: () => number,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  phase: number,
  vertices = 72,
): FantasyPoint[] {
  const points: FantasyPoint[] = [];
  let lowFrequency = random() * Math.PI * 2;
  let highFrequency = random() * Math.PI * 2;
  for (let index = 0; index < vertices; index += 1) {
    const angle = (Math.PI * 2 * index) / vertices;
    lowFrequency += (random() - 0.5) * 0.22;
    highFrequency += (random() - 0.5) * 0.44;
    const wave =
      1 +
      Math.sin(angle * 3 + phase + lowFrequency) * 0.08 +
      Math.sin(angle * 7 + highFrequency) * 0.05 +
      (random() - 0.5) * 0.06;
    points.push(
      point(
        clamp(centerX + Math.cos(angle) * radiusX * wave, 12, width - 12),
        clamp(centerY + Math.sin(angle) * radiusY * wave, 12, height - 12),
      ),
    );
  }
  return points;
}

function feature(
  input: FantasyMapGenerationInput,
  kind: FantasyFeatureKind,
  id: string,
  name: string,
  points: readonly FantasyPoint[],
  props: Record<string, string>,
  description: string,
): FantasyFeature {
  return {
    id,
    kind,
    name,
    entityRef: null,
    layerId: input.layerId,
    points,
    timeFrom: null,
    timeTo: null,
    // 基础地形先以可识别的占位名生成，正式规划会在样式适配阶段用
    // naming 目录替换。标记不会被持久化进最终 MapDocument。
    props: { generator: "fantasy-map-tool", generatedName: "true", ...props },
    description,
  };
}

function nameAt(
  values: readonly string[] | undefined,
  index: number,
  fallback: string,
): string {
  return values?.[index % values.length] ?? fallback;
}

function featureCenter(points: readonly FantasyPoint[]): FantasyPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  return points.reduce(
    (center, candidate) => ({
      x: center.x + candidate.x / points.length,
      y: center.y + candidate.y / points.length,
    }),
    { x: 0, y: 0 },
  );
}

function roleFeatureMatch(
  feature: FantasyFeature,
  role: MapGenerationEntityRole,
): boolean {
  const terrain = feature.props.terrain;
  if (["realm", "region"].includes(role)) {
    return feature.kind === "area" && terrain === "region";
  }
  if (["mountain", "vein"].includes(role)) {
    return feature.kind === "route" && terrain === "mountain";
  }
  if (role === "waterway") {
    return (
      feature.kind === "route" &&
      (terrain === "river" || terrain === "tributary")
    );
  }
  if (role === "lake") {
    return feature.kind === "area" && terrain === "lake";
  }
  if (role === "biome") {
    return feature.kind === "area" && terrain === "biome";
  }
  return feature.kind === "marker";
}

export function artworkComponentForRole(
  role: MapGenerationEntityRole,
): string | null {
  switch (role) {
    case "sect":
      return "faction-seat";
    case "holy-land":
      return "temple";
    case "secret-realm":
      return "secret-realm";
    case "forbidden-land":
      return "magic-rift";
    case "ruin":
      return "ruins";
    case "demon-den":
      return "cave";
    case "portal":
      return "portal";
    case "battlefield":
      return "battlefield";
    case "pass":
      return "watchtower";
    case "capital":
      return "capital";
    case "port":
      return "port";
    case "city":
      return "city";
    case "settlement":
      return "town-district";
    // These roles already have structural geometry or terrain materials. A
    // point stamp would duplicate the fact and make the area look like a
    // landmark, so they deliberately have no artwork component.
    case "realm":
    case "region":
    case "lake":
    case "waterway":
    case "biome":
      return null;
    default:
      return null;
  }
}

function plannedEntityAreaTerrain(
  role: MapGenerationEntityRole,
): "region" | "lake" | "biome" | null {
  if (role === "realm" || role === "region") return "region";
  if (role === "lake") return "lake";
  if (role === "biome") return "biome";
  return null;
}

function plannedEntityRouteTerrain(
  role: MapGenerationEntityRole,
): "mountain" | "river" | null {
  if (role === "mountain" || role === "vein") return "mountain";
  if (role === "waterway") return "river";
  return null;
}

/** 没有可复用的 Azgaar 几何时，仍为山脉保留可编辑的连续路径。 */
function plannedMountainPath(
  source: FantasyPoint,
  random: () => number,
  coast: readonly FantasyPoint[],
): FantasyPoint[] {
  const angle = random() * Math.PI * 2;
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const length = Math.min(260, Math.max(120, coast.length * 4));
  return Array.from({ length: 5 }, (_, index) => {
    const progress = index / 4 - 0.5;
    const bend = Math.sin(index * 1.7) * Math.min(44, length * 0.16);
    return projectInsidePolygon(
      point(
        source.x + direction.x * progress * length + normal.x * bend,
        source.y + direction.y * progress * length + normal.y * bend,
      ),
      source,
      coast,
    );
  });
}

/** 将规划锚点投影至主大陆，避免计划坐标落海时破坏要素几何。 */
function plannedAnchorPoint(
  anchor: { readonly x: number; readonly y: number } | null,
  zone: MapGenerationZone,
  input: FantasyMapGenerationInput,
  coast: readonly FantasyPoint[],
  random: () => number,
): FantasyPoint {
  if (anchor) {
    return projectInsidePolygon(
      point(anchor.x * input.width, anchor.y * input.height),
      featureCenter(coast),
      coast,
    );
  }
  const zoneAnchors: Readonly<
    Record<Exclude<MapGenerationZone, "unknown">, FantasyPoint>
  > = {
    north: { x: 0.5, y: 0.18 },
    south: { x: 0.5, y: 0.82 },
    east: { x: 0.82, y: 0.5 },
    west: { x: 0.18, y: 0.5 },
    center: { x: 0.5, y: 0.5 },
    coast: { x: 0.8, y: 0.5 },
    island: { x: 0.78, y: 0.28 },
    highland: { x: 0.48, y: 0.24 },
    lowland: { x: 0.5, y: 0.7 },
  };
  const zoneAnchor = zone === "unknown" ? null : zoneAnchors[zone];
  if (zoneAnchor) {
    // 语义区域只决定大致方位，保留小幅确定性扰动以避免同一区域的
    // 多个空间层完全重叠；最终仍由主大陆边界约束。
    const spread = zone === "coast" || zone === "island" ? 0.08 : 0.12;
    const candidate = point(
      (zoneAnchor.x + (random() - 0.5) * spread) * input.width,
      (zoneAnchor.y + (random() - 0.5) * spread) * input.height,
    );
    return projectInsidePolygon(candidate, featureCenter(coast), coast);
  }
  return randomLandPoint(random, coast, featureCenter(coast));
}

function plannedEntityPoint(
  entity: MapGenerationPlannedEntity,
  input: FantasyMapGenerationInput,
  coast: readonly FantasyPoint[],
  random: () => number,
  zone: MapGenerationZone,
): FantasyPoint {
  return plannedAnchorPoint(entity.anchor, zone, input, coast, random);
}

function polygonInteriorPoint(polygon: readonly FantasyPoint[]): FantasyPoint {
  const center = featureCenter(polygon);
  if (pointInPolygon(center, polygon)) return center;
  const bounds = polygonBounds(polygon);
  let closest: FantasyPoint | null = null;
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const candidate = point(
        bounds.left + ((column + 0.5) / 16) * (bounds.right - bounds.left),
        bounds.top + ((row + 0.5) / 16) * (bounds.bottom - bounds.top),
      );
      if (
        pointInPolygon(candidate, polygon) &&
        (!closest ||
          distanceSquared(candidate, center) < distanceSquared(closest, center))
      ) {
        closest = candidate;
      }
    }
  }
  return closest ?? polygon[0] ?? center;
}

function constrainToSpatialParent(
  anchor: FantasyPoint,
  parent: FantasyFeature | undefined,
): FantasyPoint {
  if (!parent || parent.points.length < 3) return anchor;
  return projectInsidePolygon(
    anchor,
    polygonInteriorPoint(parent.points),
    parent.points,
  );
}

function orderedSpatialLayers(
  plan: MapGenerationPlan,
): readonly (typeof plan.spatialLayers)[number][] {
  const layersById = new Map(
    plan.spatialLayers.map((layer) => [layer.id, layer]),
  );
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const ordered: (typeof plan.spatialLayers)[number][] = [];
  const visit = (layer: (typeof plan.spatialLayers)[number]) => {
    if (resolved.has(layer.id) || visiting.has(layer.id)) return;
    visiting.add(layer.id);
    if (layer.parentId) {
      const parent = layersById.get(layer.parentId);
      if (parent) visit(parent);
    }
    visiting.delete(layer.id);
    resolved.add(layer.id);
    ordered.push(layer);
  };
  plan.spatialLayers.forEach(visit);
  return ordered;
}

/** 保留候选要素的形状，只将其几何中心平移到规划锚点。 */
function relocateFeatureToAnchor(
  feature: FantasyFeature,
  anchor: FantasyPoint,
  coast: readonly FantasyPoint[],
  spatialParent?: FantasyFeature,
): readonly FantasyPoint[] {
  if (feature.kind === "marker") return [anchor];
  const center = featureCenter(feature.points);
  const coastContained = feature.points.map((candidate) =>
    projectInsidePolygon(
      point(
        candidate.x + anchor.x - center.x,
        candidate.y + anchor.y - center.y,
      ),
      anchor,
      coast,
    ),
  );
  if (!spatialParent || spatialParent.points.length < 3) return coastContained;
  const parentAnchor = polygonInteriorPoint(spatialParent.points);
  return coastContained.map((candidate) =>
    projectInsidePolygon(candidate, parentAnchor, spatialParent.points),
  );
}

/** 关系投影使用实际保存的控制点，而非未约束的原始规划坐标。 */
function featureAnchor(feature: FantasyFeature): FantasyPoint | null {
  if (feature.points.length === 0) return null;
  if (feature.kind === "marker") return feature.points[0]!;
  const center = featureCenter(feature.points);
  return point(center.x, center.y);
}

function isPlannedWaterway(feature: FantasyFeature): boolean {
  return feature.kind === "route" && feature.props.entityRole === "waterway";
}

/** Azgaar 未返回对应河流时，仍生成可编辑的河道，不能退化成单点标记。 */
function plannedWaterwayPath(
  source: FantasyPoint,
  coast: readonly FantasyPoint[],
): FantasyPoint[] {
  const mouth = coast.reduce(
    (nearest, candidate) =>
      distanceSquared(candidate, source) < distanceSquared(nearest, source)
        ? candidate
        : nearest,
    coast[0] ?? source,
  );
  const deltaX = mouth.x - source.x;
  const deltaY = mouth.y - source.y;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const normal = { x: -deltaY / distance, y: deltaX / distance };
  return Array.from({ length: 6 }, (_, index) => {
    const progress = index / 5;
    if (index === 0) return source;
    if (index === 5) return mouth;
    const bend = Math.sin(progress * Math.PI) * Math.min(42, distance * 0.12);
    return projectInsidePolygon(
      point(
        source.x + deltaX * progress + normal.x * bend,
        source.y + deltaY * progress + normal.y * bend,
      ),
      source,
      coast,
    );
  });
}

function projectWaterwayRelations(
  features: readonly FantasyFeature[],
  plan: MapGenerationPlan,
): FantasyFeature[] {
  const featureByPlanId = new Map<string, FantasyFeature>();
  features.forEach((feature) => {
    for (const planId of [
      feature.props.planEntityId,
      feature.props.planTerritoryId,
    ]) {
      if (typeof planId === "string" && planId.length > 0) {
        featureByPlanId.set(planId, feature);
      }
    }
  });
  let projected = [...features];
  const replaceWaterwayPoints = (
    relation: (typeof plan.relations)[number],
    transform: (
      source: FantasyFeature,
      target: FantasyPoint,
    ) => readonly FantasyPoint[],
  ) => {
    const source = featureByPlanId.get(relation.fromId);
    const target = featureByPlanId.get(relation.toId);
    const targetAnchor = target ? featureAnchor(target) : null;
    if (!source || !targetAnchor || !isPlannedWaterway(source)) return;
    const points = transform(source, targetAnchor);
    const replacement = { ...source, points };
    featureByPlanId.set(relation.fromId, replacement);
    projected = projected.map((feature) =>
      feature.id === replacement.id ? replacement : feature,
    );
  };

  // 先固定河源，再投影途经点；输入关系的排列不应改变地图事实。
  plan.relations
    .filter((relation) => relation.type === "originates-at")
    .forEach((relation) => {
      replaceWaterwayPoints(relation, (source, target) => [
        target,
        ...source.points.slice(1),
      ]);
    });
  plan.relations
    .filter((relation) => relation.type === "flows-through")
    .forEach((relation) => {
      replaceWaterwayPoints(relation, (source, target) => {
        const insertAt = clamp(
          nearestPathPointIndex(source.points, target),
          1,
          source.points.length - 1,
        );
        return withoutAdjacentDuplicates([
          ...source.points.slice(0, insertAt),
          target,
          ...source.points.slice(insertAt),
        ]);
      });
    });
  return projected;
}

function relationTargetPoint(
  target: FantasyFeature,
  relationType: MapGenerationPlan["relations"][number]["type"],
): FantasyPoint | null {
  if (
    (relationType === "hidden-in" || relationType === "contains") &&
    target.kind === "area" &&
    target.points.length >= 3
  ) {
    return polygonInteriorPoint(target.points);
  }
  return featureAnchor(target);
}

function relationUsesContainment(
  relationType: MapGenerationPlan["relations"][number]["type"],
): boolean {
  return relationType === "hidden-in" || relationType === "contains";
}

/** 为不改变端点位置的拓扑关系生成独立可编辑路线。 */
function projectNonPositionalRelations(
  features: readonly FantasyFeature[],
  plan: MapGenerationPlan,
): FantasyFeature[] {
  const featureByPlanId = new Map<string, FantasyFeature>();
  for (const feature of features) {
    for (const planId of [
      feature.props.planEntityId,
      feature.props.planTerritoryId,
    ]) {
      if (typeof planId === "string" && planId.length > 0) {
        featureByPlanId.set(planId, feature);
      }
    }
    if (
      typeof feature.props.spatialLayerId === "string" &&
      typeof feature.props.spatialRole === "string"
    ) {
      featureByPlanId.set(feature.props.spatialLayerId, feature);
    }
  }

  return plan.relations.reduce<FantasyFeature[]>(
    (projected, relation, index) => {
      if (!["connected-to", "separated-by"].includes(relation.type)) {
        return projected;
      }
      const source = featureByPlanId.get(relation.fromId);
      const target = featureByPlanId.get(relation.toId);
      const sourceAnchor = source ? featureAnchor(source) : null;
      const targetAnchor = target ? featureAnchor(target) : null;
      if (!source || !target || !sourceAnchor || !targetAnchor)
        return projected;

      const relationId =
        relation.type +
        ":" +
        relation.fromId +
        ":" +
        relation.toId +
        ":" +
        index;
      const midpoint = point(
        (sourceAnchor.x + targetAnchor.x) / 2,
        (sourceAnchor.y + targetAnchor.y) / 2,
      );
      const routeStyle =
        relation.type === "connected-to" ? "ley-line" : "barrier";
      projected.push({
        id: safeId("plan-relation", relationId),
        kind: "route",
        name: relation.type === "connected-to" ? "灵脉连接" : "隔绝结界",
        entityRef: null,
        layerId: source.layerId,
        points: [sourceAnchor, midpoint, targetAnchor],
        timeFrom: null,
        timeTo: null,
        props: {
          generator: "fantasy-map-tool",
          planRelationId: relationId,
          planRelationType: relation.type,
          planRelationFromId: relation.fromId,
          planRelationToId: relation.toId,
          routeStyle,
          terrain: routeStyle,
          color: relation.type === "connected-to" ? "#9c65bd" : "#7f72c2",
          lineWidth: relation.type === "connected-to" ? "3" : "4",
          showLabel: "true",
        },
        description: relation.description,
      });
      return projected;
    },
    [...features],
  );
}

/** 将可定位的实体按关系移动，区域本身和领地边界不因关系被整体拖走。 */
function projectSpatialRelations(
  features: readonly FantasyFeature[],
  plan: MapGenerationPlan,
  coast: readonly FantasyPoint[],
  spatialLayerFeatures: ReadonlyMap<string, FantasyFeature>,
  width: number,
  height: number,
): FantasyFeature[] {
  const featureByPlanId = new Map<string, FantasyFeature>();
  features.forEach((feature) => {
    for (const planId of [
      feature.props.planEntityId,
      feature.props.planTerritoryId,
    ]) {
      if (typeof planId === "string" && planId.length > 0) {
        featureByPlanId.set(planId, feature);
      }
    }
    if (
      typeof feature.props.spatialLayerId === "string" &&
      typeof feature.props.spatialRole === "string"
    ) {
      featureByPlanId.set(feature.props.spatialLayerId, feature);
    }
  });

  let projected = [...features];
  const relationDistance = Math.max(12, Math.min(width, height) * 0.018);
  const supportedRelations = new Set([
    "located-near",
    "guards",
    "hidden-in",
    "contains",
  ]);
  for (const relation of plan.relations) {
    if (!supportedRelations.has(relation.type)) continue;
    const source = featureByPlanId.get(relation.fromId);
    const target = featureByPlanId.get(relation.toId);
    if (
      !source ||
      !target ||
      source.id === target.id ||
      source.points.length === 0 ||
      source.kind === "area" ||
      source.props.entityRole === "territory"
    ) {
      continue;
    }
    const targetPoint = relationTargetPoint(target, relation.type);
    if (!targetPoint) continue;
    const containment = relationUsesContainment(relation.type);
    const angle =
      ((hashSeed(`${relation.fromId}:${relation.toId}`) % 360) * Math.PI) / 180;
    const desired = containment
      ? targetPoint
      : point(
          targetPoint.x + Math.cos(angle) * relationDistance,
          targetPoint.y + Math.sin(angle) * relationDistance,
        );
    const spatialParentId = source.props.spatialLayerId;
    const spatialParent =
      typeof spatialParentId === "string"
        ? spatialLayerFeatures.get(spatialParentId)
        : undefined;
    const anchor = constrainToSpatialParent(
      projectInsidePolygon(desired, featureCenter(coast), coast),
      spatialParent,
    );
    const replacement: FantasyFeature = {
      ...source,
      points: relocateFeatureToAnchor(source, anchor, coast, spatialParent),
    };
    projected = projected.map((feature) =>
      feature.id === replacement.id ? replacement : feature,
    );
    featureByPlanId.set(relation.fromId, replacement);
  }
  return projected;
}

/**
 * 将 Agent 的空间规划投影到同一批可编辑要素上。
 *
 * 规划不是描述性元数据：区域、山脉、水系和玄幻地点都会绑定稳定实体
 * 引用，未被基础生成器命中的实体则补成可编辑标记，保证审阅时不会出现
 * “计划里有、地图上没有”的事实断层。
 */
function applyGenerationPlan(
  input: FantasyMapGenerationInput,
  features: FantasyFeature[],
  coast: readonly FantasyPoint[],
  random: () => number,
): FantasyFeature[] {
  const plan = input.plan;
  if (!plan) return features;

  const usedFeatureIds = new Set<string>();
  const spatialLayersById = new Map(
    plan.spatialLayers.map((layer) => [layer.id, layer]),
  );
  const spatialLayerMaterialById = new Map<string, FantasyBiomeMaterial>();
  const materialForSpatialLayer = (
    layer: (typeof plan.spatialLayers)[number],
  ): FantasyBiomeMaterial => {
    const cached = spatialLayerMaterialById.get(layer.id);
    if (cached) return cached;
    const terms = [...layer.climate, ...layer.terrain];
    const parent = layer.parentId
      ? spatialLayersById.get(layer.parentId)
      : undefined;
    const material =
      terms.length > 0
        ? fantasyBiomeMaterialFor(terms)
        : parent
          ? materialForSpatialLayer(parent)
          : "grassland";
    spatialLayerMaterialById.set(layer.id, material);
    return material;
  };
  const relationIdsByTarget = new Map<string, string[]>();
  plan.relations.forEach((relation, index) => {
    const relationId = `${relation.type}:${relation.fromId}:${relation.toId}:${index}`;
    for (const target of [relation.fromId, relation.toId]) {
      const ids = relationIdsByTarget.get(target) ?? [];
      ids.push(relationId);
      relationIdsByTarget.set(target, ids);
    }
  });

  let projected = features.map((feature) => ({ ...feature }));
  const spatialLayerFeatures = new Map<string, FantasyFeature>();
  orderedSpatialLayers(plan).forEach((layer, index) => {
    const spatialParent = layer.parentId
      ? spatialLayerFeatures.get(layer.parentId)
      : undefined;
    const candidate = projected.find(
      (feature) =>
        !usedFeatureIds.has(feature.id) &&
        feature.kind === "area" &&
        feature.props.terrain === "region",
    );
    if (!candidate) {
      const anchor = constrainToSpatialParent(
        plannedAnchorPoint(layer.anchor, layer.zone, input, coast, random),
        spatialParent,
      );
      const radius = Math.min(input.width, input.height) * 0.1;
      const generatedRegion: FantasyFeature = {
        id: safeId("planned-region", layer.id),
        kind: "area",
        name: layer.name,
        entityRef: { kind: "setting", id: layer.worldNodeId },
        layerId: input.layerId,
        points: coastline(
          random,
          input.width,
          input.height,
          anchor.x,
          anchor.y,
          radius,
          radius * 0.7,
          index,
          18,
        ),
        timeFrom: null,
        timeTo: null,
        props: {},
        description: layer.notes || "依据世界架构空间层级规划补充的区域。",
      };
      const points = relocateFeatureToAnchor(
        generatedRegion,
        anchor,
        coast,
        spatialParent,
      );
      const id = safeId("planned-region", layer.id);
      const feature: FantasyFeature = {
        ...generatedRegion,
        id,
        points,
        // 空间层来自世界架构节点，必须保留可导航的正式实体身份。
        props: {
          generator: "fantasy-map-tool",
          generatedName: "false",
          terrain: "region",
          spatialLayerId: layer.id,
          worldNodeId: layer.worldNodeId,
          entityRefKind: "setting",
          entityRefId: layer.worldNodeId,
          spatialRole: layer.role,
          zone: layer.zone,
          climate: layer.climate.join(","),
          terrainContext: layer.terrain.join(","),
          terrainMaterial: materialForSpatialLayer(layer),
          planRelations: JSON.stringify(
            relationIdsByTarget.get(layer.id) ?? [],
          ),
          fill: "#b28b6650",
          color: "#806348",
          lineWidth: "1.2",
          showLabel: "true",
        },
      };
      projected.push(feature);
      spatialLayerFeatures.set(layer.id, feature);
      usedFeatureIds.add(id);
      return;
    }
    usedFeatureIds.add(candidate.id);
    const anchor = plannedAnchorPoint(
      layer.anchor,
      layer.zone,
      input,
      coast,
      random,
    );
    const points = relocateFeatureToAnchor(
      candidate,
      constrainToSpatialParent(anchor, spatialParent),
      coast,
      spatialParent,
    );
    const replacement: FantasyFeature = {
      ...candidate,
      name: layer.name,
      entityRef: { kind: "setting", id: layer.worldNodeId },
      points,
      props: {
        ...candidate.props,
        generatedName: "false",
        worldNodeId: layer.worldNodeId,
        spatialLayerId: layer.id,
        entityRefKind: "setting",
        entityRefId: layer.worldNodeId,
        spatialRole: layer.role,
        zone: layer.zone,
        climate: layer.climate.join(","),
        terrainContext: layer.terrain.join(","),
        terrainMaterial: materialForSpatialLayer(layer),
        planRelations: JSON.stringify(relationIdsByTarget.get(layer.id) ?? []),
      },
      description: layer.notes || "依据世界架构空间层级规划的区域。",
    };
    projected = projected.map((feature) =>
      feature.id !== candidate.id ? feature : replacement,
    );
    spatialLayerFeatures.set(layer.id, replacement);
  });

  (plan.territories ?? []).forEach((territory, index) => {
    const spatialLayer = territory.spatialLayerId
      ? spatialLayersById.get(territory.spatialLayerId)
      : undefined;
    const anchor = constrainToSpatialParent(
      plannedAnchorPoint(
        territory.anchor,
        spatialLayer?.zone ?? "unknown",
        input,
        coast,
        random,
      ),
      territory.spatialLayerId
        ? spatialLayerFeatures.get(territory.spatialLayerId)
        : undefined,
    );
    const radius =
      Math.min(input.width, input.height) * territory.extent * 0.42;
    const territoryFeature: FantasyFeature = {
      id: safeId("territory", territory.id),
      kind: "area",
      name: territory.name,
      entityRef: territory.factionRef,
      layerId: input.layerId,
      points: coastline(
        random,
        input.width,
        input.height,
        anchor.x,
        anchor.y,
        radius,
        radius * 0.72,
        index + 31,
        16,
      ).map((candidate) =>
        constrainToSpatialParent(
          projectInsidePolygon(candidate, anchor, coast),
          territory.spatialLayerId
            ? spatialLayerFeatures.get(territory.spatialLayerId)
            : undefined,
        ),
      ),
      timeFrom: null,
      timeTo: null,
      props: {
        generator: "fantasy-map-tool",
        generatedName: "false",
        planTerritoryId: territory.id,
        entityRole: "territory",
        entityRefKind: "faction",
        entityRefId: territory.factionRef.id,
        spatialLayerId: territory.spatialLayerId ?? "",
        planRelations: JSON.stringify(
          relationIdsByTarget.get(territory.id) ?? [],
        ),
        terrain: "territory",
        component:
          territory.boundaryStyle === "hatch"
            ? "territory-hatch"
            : "territory-fill",
        boundaryStyle: territory.boundaryStyle,
        fill: "#9b6f5b30",
        color: "#806348",
        lineWidth: "1.4",
        showLabel: "true",
        importance: String(territory.importance),
      },
      description: territory.description || "依据势力规划生成的领地边界。",
    };
    projected.push(territoryFeature);
  });

  plan.entities.forEach((entity) => {
    const candidateIndex = projected.findIndex(
      (feature) =>
        !usedFeatureIds.has(feature.id) &&
        roleFeatureMatch(feature, entity.role),
    );
    const candidate = candidateIndex >= 0 ? projected[candidateIndex] : null;
    const relationIds = relationIdsByTarget.get(entity.id) ?? [];
    const component = artworkComponentForRole(entity.role);
    const spatialLayer = entity.spatialLayerId
      ? spatialLayersById.get(entity.spatialLayerId)
      : undefined;
    const spatialParent = entity.spatialLayerId
      ? spatialLayerFeatures.get(entity.spatialLayerId)
      : undefined;
    if (candidate) {
      usedFeatureIds.add(candidate.id);
      const anchor = constrainToSpatialParent(
        plannedEntityPoint(
          entity,
          input,
          coast,
          random,
          spatialLayer?.zone ?? "unknown",
        ),
        spatialParent,
      );
      const points =
        entity.anchor || spatialParent || spatialLayer
          ? relocateFeatureToAnchor(candidate, anchor, coast, spatialParent)
          : candidate.points;
      projected = projected.map((feature) =>
        feature.id !== candidate.id
          ? feature
          : {
              ...feature,
              name: entity.name,
              entityRef: entity.entityRef,
              points,
              props: {
                ...(() => {
                  const { component: _component, ...baseProps } = feature.props;
                  return baseProps;
                })(),
                generatedName: "false",
                planEntityId: entity.id,
                entityRole: entity.role,
                spatialLayerId: entity.spatialLayerId ?? "",
                ...(entity.entityRef
                  ? {
                      entityRefKind: entity.entityRef.kind,
                      entityRefId: entity.entityRef.id,
                    }
                  : {}),
                planRelations: JSON.stringify(relationIds),
                preferredTerrain: entity.preferredTerrain.join(","),
                ...(component ? { component } : {}),
              },
              description: entity.description || feature.description,
            },
      );
      return;
    }

    const anchor = constrainToSpatialParent(
      plannedEntityPoint(
        entity,
        input,
        coast,
        random,
        spatialLayer?.zone ?? "unknown",
      ),
      spatialParent,
    );
    const id = safeId("plan", entity.id);
    const areaTerrain = plannedEntityAreaTerrain(entity.role);
    const routeTerrain = plannedEntityRouteTerrain(entity.role);
    const isArea = areaTerrain !== null;
    const isRoute = routeTerrain !== null;
    const points = isArea
      ? coastline(
          random,
          input.width,
          input.height,
          anchor.x,
          anchor.y,
          Math.min(input.width, input.height) *
            (areaTerrain === "lake" ? 0.045 : 0.1),
          Math.min(input.width, input.height) *
            (areaTerrain === "lake" ? 0.03 : 0.07),
          random() * Math.PI * 2,
          areaTerrain === "lake" ? 18 : 20,
        ).map((candidate) =>
          constrainToSpatialParent(
            projectInsidePolygon(candidate, anchor, coast),
            spatialParent,
          ),
        )
      : isRoute
        ? (routeTerrain === "river"
            ? plannedWaterwayPath(anchor, coast)
            : plannedMountainPath(anchor, random, coast)
          ).map((candidate) =>
            constrainToSpatialParent(candidate, spatialParent),
          )
        : [anchor];
    projected.push({
      id,
      kind: isArea ? "area" : isRoute ? "route" : "marker",
      name: entity.name,
      entityRef: entity.entityRef,
      layerId: input.layerId,
      points,
      timeFrom: null,
      timeTo: null,
      props: {
        generator: "fantasy-map-tool",
        generatedName: "false",
        planEntityId: entity.id,
        entityRole: entity.role,
        spatialLayerId: entity.spatialLayerId ?? "",
        ...(isArea
          ? {
              terrain: areaTerrain,
              ...(areaTerrain === "biome"
                ? {
                    terrainMaterial: fantasyBiomeMaterialFor(
                      entity.preferredTerrain,
                    ),
                  }
                : {}),
            }
          : isRoute
            ? {
                terrain: routeTerrain,
                lineWidth: routeTerrain === "river" ? "2.4" : "3",
              }
            : { symbol: entity.role }),
        ...(component ? { component } : {}),
        showLabel: "true",
        importance: String(entity.importance),
        ...(entity.entityRef
          ? {
              entityRefKind: entity.entityRef.kind,
              entityRefId: entity.entityRef.id,
            }
          : {}),
        planRelations: JSON.stringify(relationIds),
        preferredTerrain: entity.preferredTerrain.join(","),
      },
      description: entity.description || "依据地图规划补充的玄幻地点候选。",
    });
  });
  return projectNonPositionalRelations(
    projectWaterwayRelations(
      projectSpatialRelations(
        projected,
        plan,
        coast,
        spatialLayerFeatures,
        input.width,
        input.height,
      ),
      plan,
    ),
    plan,
  );
}

/** 将世界设定中的气候词映射到编辑器已有的可重建地貌材质。 */
function biomeMaterialsFor(
  terrainKeywords: readonly string[],
): readonly FantasyBiomeMaterial[] {
  const terms = terrainKeywords.join(" ");
  const materials: FantasyBiomeMaterial[] = ["grassland", "forest"];
  const addWhenMatched = (material: FantasyBiomeMaterial, pattern: RegExp) => {
    if (pattern.test(terms) && !materials.includes(material)) {
      materials.push(material);
    }
  };
  addWhenMatched("desert", /沙漠|荒漠|旱地|desert|arid/iu);
  addWhenMatched("badlands", /赤地|红土|峡谷|badlands|canyon/iu);
  addWhenMatched("tundra", /冻土|苔原|tundra/iu);
  addWhenMatched("snow", /冰原|雪原|冰川|雪岭|冰封|snow|glacier|ice/iu);
  addWhenMatched("swamp", /沼泽|湿地|泥沼|swamp|wetland|marsh/iu);
  addWhenMatched("volcanic", /火山|熔岩|岩浆|volcanic|lava/iu);
  return materials;
}

/** 将空间层或实体的气候、地貌词解析为单一主材质，供场景区域使用。 */
export function fantasyBiomeMaterialFor(
  terrainKeywords: readonly string[],
): FantasyBiomeMaterial {
  const terms = terrainKeywords.join(" ");
  if (/冰原|雪原|冰川|雪岭|冰封|snow|glacier|ice/iu.test(terms)) {
    return "snow";
  }
  if (/火山|熔岩|岩浆|volcanic|lava/iu.test(terms)) {
    return "volcanic";
  }
  if (/沼泽|湿地|泥沼|swamp|wetland|marsh/iu.test(terms)) {
    return "swamp";
  }
  if (/沙漠|荒漠|旱地|desert|arid/iu.test(terms)) {
    return "desert";
  }
  if (/赤地|红土|峡谷|badlands|canyon/iu.test(terms)) {
    return "badlands";
  }
  if (/冻土|苔原|tundra/iu.test(terms)) {
    return "tundra";
  }
  if (
    /森林|林地|雨林|丛林|竹海|forest|woodland|rainforest|jungle/iu.test(terms)
  ) {
    return "forest";
  }
  return "grassland";
}

type FantasyReliefMarker = {
  readonly component: "volcano" | "snow-peak" | "foothills" | "mesa";
  readonly terrain: "volcano" | "mountain" | "hills" | "mesa";
  readonly fallbackName: string;
  readonly color: string;
  readonly count: number;
  readonly pattern: RegExp;
  readonly description: string;
};

/**
 * 世界架构中的高地词不能只影响一块材质底色。它们还应投影为能被作者选中、
 * 移动和替换的真实地形构件，使火山、雪峰、丘陵与台地成为地图骨架的一部分。
 */
function reliefMarkersFor(
  terrainKeywords: readonly string[],
): readonly FantasyReliefMarker[] {
  const terms = terrainKeywords.join(" ");
  const descriptors: readonly FantasyReliefMarker[] = [
    {
      component: "volcano",
      terrain: "volcano",
      fallbackName: "火山",
      color: "#78483c",
      count: 1,
      pattern: /火山|熔岩|岩浆|volcanic|lava/iu,
      description: "依据世界架构火山地貌生成的可编辑火山构件。",
    },
    {
      component: "snow-peak",
      terrain: "mountain",
      fallbackName: "雪峰",
      color: "#6b7273",
      count: 1,
      pattern: /冰峰|雪峰|雪岭|冰川|frost|snow|glacier/iu,
      description: "依据世界架构高寒地貌生成的可编辑雪峰构件。",
    },
    {
      component: "foothills",
      terrain: "hills",
      fallbackName: "丘陵",
      color: "#807057",
      count: 2,
      pattern: /丘陵|山麓|缓坡|hills?|foothills?/iu,
      description: "依据世界架构丘陵地貌生成的可编辑山麓构件。",
    },
    {
      component: "mesa",
      terrain: "mesa",
      fallbackName: "高原台地",
      color: "#986647",
      count: 1,
      pattern: /高原|台地|桌状山|plateau|mesa/iu,
      description: "依据世界架构高原地貌生成的可编辑台地构件。",
    },
  ];
  return descriptors.filter((descriptor) => descriptor.pattern.test(terms));
}

function terrainKeywordName(
  terrainKeywords: readonly string[],
  marker: FantasyReliefMarker,
): string {
  return (
    terrainKeywords.find((term) => marker.pattern.test(term)) ??
    marker.fallbackName
  );
}

function interiorLake(
  random: () => number,
  input: Pick<FantasyMapGenerationInput, "width" | "height">,
  coast: readonly FantasyPoint[],
  center: FantasyPoint,
): FantasyPoint[] {
  const contour = coastline(
    random,
    input.width,
    input.height,
    center.x,
    center.y,
    input.width * (0.024 + random() * 0.018),
    input.height * (0.018 + random() * 0.014),
    random() * Math.PI * 2,
    20,
  );
  return contour.map((candidate) =>
    projectInsidePolygon(candidate, center, coast),
  );
}

/** Generate a layered candidate: coast, political regions, rivers, terrain and settlements. */
export function generateFantasyMapCandidate(
  input: FantasyMapGenerationInput,
): FantasyMapGenerationResult {
  const seed = input.seed.trim() || "fantasy-map";
  const random = seededRandom(seed);
  const landmassCount = clamp(Math.round(input.landmassCount ?? 1), 1, 4);
  const regionCount = clamp(Math.round(input.regionCount ?? 6), 3, 12);
  const riverCount = clamp(Math.round(input.riverCount ?? 6), 2, 14);
  const names = input.spatialNames ?? [];
  const features: FantasyFeature[] = [];
  const mainCenter = { x: input.width * 0.5, y: input.height * 0.52 };
  const mainCoast = coastline(
    random,
    input.width,
    input.height,
    mainCenter.x,
    mainCenter.y,
    input.width * 0.39,
    input.height * 0.34,
    random() * 4,
  );
  features.push(
    feature(
      input,
      "area",
      safeId("landmass", `${seed}-main`),
      nameAt(names, 0, "主大陆"),
      mainCoast,
      {
        color: "#536b54",
        fill: "#d8c58f",
        lineWidth: "3",
        terrain: "coast",
        showLabel: "true",
      },
      "Fantasy Map Generator 生成的连续大陆海岸线。",
    ),
  );

  for (let index = 1; index < landmassCount; index += 1) {
    const island = coastline(
      random,
      input.width,
      input.height,
      input.width * (0.16 + random() * 0.68),
      input.height * (0.16 + random() * 0.68),
      input.width * (0.045 + random() * 0.07),
      input.height * (0.035 + random() * 0.065),
      random() * 4,
      36,
    );
    features.push(
      feature(
        input,
        "area",
        safeId("island", `${seed}-${index}`),
        `外岛 ${index}`,
        island,
        {
          color: "#64735b",
          fill: "#cdb57d",
          lineWidth: "2",
          terrain: "island",
        },
        "与主大陆分离的岛屿候选。",
      ),
    );
  }

  // Partition the landmass with deterministic Voronoi-like half-plane clips.
  // This produces non-overlapping political regions instead of radial wedges.
  const regionSites = Array.from({ length: regionCount }, () =>
    randomLandPoint(random, mainCoast, mainCenter),
  );
  for (let index = 0; index < regionSites.length; index += 1) {
    const center = regionSites[index]!;
    let region = [...mainCoast];
    for (let otherIndex = 0; otherIndex < regionSites.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      region = clipByBisector(region, center, regionSites[otherIndex]!);
      if (region.length < 3) break;
    }
    if (region.length < 3) continue;
    // 求交点会经过一位小数取整；最后再投回主大陆，避免边界舍入后出现
    // 只有几个像素的越界色块，导出时看起来像势力范围溢到海面。
    const containedRegion = region.map((candidate) =>
      projectInsidePolygon(candidate, center, mainCoast),
    );
    features.push(
      feature(
        input,
        "area",
        safeId("region", `${seed}-${index}`),
        nameAt(input.factionNames, index, `地域 ${index + 1}`),
        containedRegion,
        {
          color: ["#a64e3c", "#417b68", "#8064a2", "#b2833d", "#557d9b"][
            index % 5
          ],
          fill: [
            "#c9675540",
            "#54a47b40",
            "#9c7fc040",
            "#d0a75b40",
            "#7ca6c240",
          ][index % 5],
          lineWidth: "1",
          terrain: "region",
          showLabel: "true",
        },
        "依据世界架构空间与势力资料生成的区域候选。",
      ),
    );
  }

  // 先确定高地骨架，再由它决定湖泊与河源。这样山脉不再只是最后叠加的
  // 装饰线，而是整张地图水文和文明分布的空间起点。
  // 视觉规划中的材质是正式生成约束，不应只作为 metadata 留在
  // generationPlan。与世界正文、空间层地貌共同输入同一套材质推导，
  // 让兼容候选和 Runtime 降级候选都能生成对应的可编辑地貌要素。
  const terrainTerms = [
    ...(input.terrainKeywords ?? []),
    ...(input.plan?.visual.terrainMaterials ?? []),
    ...(input.plan?.spatialLayers.flatMap((layer) => layer.terrain) ?? []),
  ];
  const mountainName =
    terrainTerms.find((term) => /山|峰|岭|mountain|ridge/iu.test(term)) ??
    "山脉";
  const snowMountain = terrainTerms.some((term) =>
    /冰|雪|frost|snow|glacier/iu.test(term),
  );
  const mountainRanges: Array<{
    readonly feature: FantasyFeature;
    readonly headwaters: readonly FantasyPoint[];
  }> = [];
  for (
    let index = 0;
    index < Math.max(2, Math.ceil(regionCount / 3));
    index += 1
  ) {
    const anchor = randomLandPoint(random, mainCoast, mainCenter);
    const angle = (random() - 0.5) * Math.PI;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -direction.y, y: direction.x };
    const points = Array.from({ length: 7 }, (_, step) => {
      const progress = step / 6 - 0.5;
      const candidate = point(
        anchor.x +
          direction.x * progress * input.width * 0.18 +
          normal.x * Math.sin(step * 1.7) * input.height * 0.035,
        anchor.y +
          direction.y * progress * input.width * 0.18 +
          normal.y * Math.sin(step * 1.7) * input.height * 0.035,
      );
      return projectInsidePolygon(candidate, anchor, mainCoast);
    });
    const mountain = feature(
      input,
      "route",
      safeId("mountain", `${seed}-${index}`),
      `${mountainName} ${index + 1}`,
      points,
      {
        color: "#746657",
        lineWidth: "3",
        terrain: "mountain",
        symbol: snowMountain ? "snow-peaks" : "peaks",
        mountainStyle: snowMountain ? "snow" : "stone",
        showLabel: "true",
      },
      "依据世界架构地貌关键词生成的山脉候选。",
    );
    mountainRanges.push({
      feature: mountain,
      // 中段和两侧脊点都可以成为集水高地，确保多条河不会机械地从同一
      // 山峰出发。点本身复用山脉几何，来源关系可被作者直接追溯和编辑。
      headwaters: [points[1]!, points[3]!, points[5]!],
    });
  }

  const lakeCount = clamp(Math.round(riverCount / 4), 1, 3);
  const lakes = Array.from({ length: lakeCount }, (_, index) => {
    const mountain = mountainRanges[index % mountainRanges.length]!;
    const headwater =
      mountain.headwaters[index % mountain.headwaters.length] ?? mainCenter;
    // 湖泊靠近山脉高地，但不直接覆盖山脊；由此引出的河流具有可解释的
    // 集水区，而不是随机落在平原中央。
    const center = projectInsidePolygon(
      point(
        headwater.x + (random() - 0.5) * input.width * 0.065,
        headwater.y + (random() - 0.5) * input.height * 0.065,
      ),
      headwater,
      mainCoast,
    );
    const points = interiorLake(random, input, mainCoast, center);
    const id = safeId("lake", `${seed}-${index}`);
    features.push(
      feature(
        input,
        "area",
        id,
        `湖泊 ${index + 1}`,
        points,
        {
          color: "#2e6477",
          fill: "#5d9caf",
          lineWidth: "2",
          terrain: "lake",
          symbol: "lake",
          showLabel: "true",
          sourceMountainId: mountain.feature.id,
        },
        "由山地集水区形成的可编辑湖泊区域。",
      ),
    );
    return { id, center, points, sourceMountainId: mountain.feature.id };
  });

  const mainRivers: FantasyFeature[] = [];
  for (let index = 0; index < riverCount; index += 1) {
    const lake = index < lakes.length ? lakes[index] : undefined;
    const mountain = mountainRanges[index % mountainRanges.length]!;
    const mountainSource =
      mountain.headwaters[
        Math.floor(index / mountainRanges.length) % mountain.headwaters.length
      ] ?? mainCenter;
    const source = lake?.center ?? mountainSource;
    const sourceAngle = Math.atan2(
      source.y - mainCenter.y,
      source.x - mainCenter.x,
    );
    const mouth = farthestCoastPoint(
      mainCoast,
      mainCenter,
      sourceAngle + (random() - 0.5) * 0.56,
    );
    const delta = { x: mouth.x - source.x, y: mouth.y - source.y };
    const length = Math.max(1, Math.hypot(delta.x, delta.y));
    const normal = { x: -delta.y / length, y: delta.x / length };
    const points = Array.from({ length: 9 }, (_, step) => {
      const progress = step / 8;
      const meander =
        Math.sin(progress * Math.PI * (1.4 + random() * 0.7) + index) *
        input.width *
        0.018 *
        (1 - progress);
      const candidate = point(
        source.x + delta.x * progress + normal.x * meander,
        source.y + delta.y * progress + normal.y * meander,
      );
      return step === 0
        ? source
        : step === 8
          ? mouth
          : projectInsidePolygon(candidate, source, mainCoast);
    });
    const river = feature(
      input,
      "route",
      safeId("river", `${seed}-${index}`),
      `河流 ${index + 1}`,
      points,
      {
        color: "#4b87a0",
        lineWidth: "3",
        sourceWidth: "1.8",
        mouthWidth: "7.4",
        terrain: "river",
        riverRole: "main",
        sourceType: lake ? "lake" : "mountain",
        sourceMountainId: lake?.sourceMountainId ?? mountain.feature.id,
        ...(lake ? { sourceLakeId: lake.id } : {}),
      },
      "从山地集水区或内陆湖泊向海岸汇流的主河流候选。",
    );
    mainRivers.push(river);
    features.push(river);
  }
  // 支流终止于主河流，使候选水系保持可编辑的汇流关系。
  const tributaryCount = Math.max(1, Math.floor(riverCount / 2));
  for (let index = 0; index < tributaryCount; index += 1) {
    const river = mainRivers[index % mainRivers.length]!;
    const confluence = river.points[3 + ((index * 2) % 3)]!;
    const mountain =
      mountainRanges[(index + lakes.length) % mountainRanges.length]!;
    const source =
      mountain.headwaters[(index + 1) % mountain.headwaters.length] ??
      mainCenter;
    const delta = { x: confluence.x - source.x, y: confluence.y - source.y };
    const length = Math.max(1, Math.hypot(delta.x, delta.y));
    const normal = { x: -delta.y / length, y: delta.x / length };
    const points = Array.from({ length: 6 }, (_, step) => {
      const progress = step / 5;
      const meander =
        Math.sin(progress * Math.PI * 1.8 + index * 1.7) *
        input.width *
        0.012 *
        (1 - progress);
      const candidate = point(
        source.x + delta.x * progress + normal.x * meander,
        source.y + delta.y * progress + normal.y * meander,
      );
      return step === 0
        ? source
        : step === 5
          ? confluence
          : projectInsidePolygon(candidate, source, mainCoast);
    });
    features.push(
      feature(
        input,
        "route",
        safeId("tributary", `${seed}-${index}`),
        `支流 ${index + 1}`,
        points,
        {
          color: "#4b87a0",
          lineWidth: "1.8",
          sourceWidth: "1",
          mouthWidth: "3.6",
          terrain: "tributary",
          riverRole: "tributary",
          joinsRiverId: river.id,
          sourceType: "mountain",
          sourceMountainId: mountain.feature.id,
        },
        "从山地高处汇入主河流的可编辑支流候选。",
      ),
    );
  }
  const riverFeatures = mainRivers;
  const watercourseFeatures = features.filter(
    (candidate) =>
      candidate.kind === "route" &&
      (candidate.props.terrain === "river" ||
        candidate.props.terrain === "tributary"),
  );

  mountainRanges.forEach((range) => features.push(range.feature));

  const biomeMaterials = biomeMaterialsFor(terrainTerms);
  const biomeCount = Math.max(
    3,
    Math.min(8, biomeMaterials.length * 2 + (regionCount >= 8 ? 1 : 0)),
  );
  for (let index = 0; index < biomeCount; index += 1) {
    const material = biomeMaterials[index % biomeMaterials.length]!;
    const anchor = randomLandPoint(random, mainCoast, mainCenter);
    const rawPoints = coastline(
      random,
      input.width,
      input.height,
      anchor.x,
      anchor.y,
      input.width * 0.035,
      input.height * 0.025,
      random() * 4,
      18,
    );
    const points = rawPoints.map((candidate) =>
      projectInsidePolygon(candidate, anchor, mainCoast),
    );
    features.push(
      feature(
        input,
        "area",
        safeId("biome", `${seed}-${material}-${index}`),
        `${FANTASY_BIOME_LABELS[material]} ${index + 1}`,
        points,
        {
          color:
            material === "forest"
              ? "#567453"
              : material === "desert"
                ? "#a48142"
                : material === "snow"
                  ? "#91a7a6"
                  : "#6d765c",
          fill:
            material === "forest"
              ? "#6f9b6538"
              : material === "desert"
                ? "#c9a86548"
                : material === "snow"
                  ? "#d8ddd355"
                  : "#93a56f38",
          lineWidth: "1",
          terrain: material === "forest" ? "forest" : "biome",
          terrainMaterial: material,
          symbol: material === "forest" ? "forest" : "terrain",
          showLabel: "true",
        },
        `依据世界架构气候和地貌关键词生成的${FANTASY_BIOME_LABELS[material]}候选。`,
      ),
    );
  }

  const lakePolygons = lakes.map((lake) => lake.points);
  const isLakePoint = (candidate: FantasyPoint) =>
    lakePolygons.some((lake) => pointInPolygon(candidate, lake));
  const randomDryLandPoint = () => {
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const candidate = randomLandPoint(random, mainCoast, mainCenter);
      if (!isLakePoint(candidate)) return candidate;
    }
    return mainCenter;
  };

  reliefMarkersFor(terrainTerms).forEach((marker) => {
    const keywordName = terrainKeywordName(terrainTerms, marker);
    for (let index = 0; index < marker.count; index += 1) {
      const suffix = marker.count > 1 ? ` ${index + 1}` : "";
      features.push(
        feature(
          input,
          "marker",
          safeId(`relief-${marker.component}`, `${seed}-${index}`),
          `${keywordName}${suffix}`,
          [randomDryLandPoint()],
          {
            component: marker.component,
            terrain: marker.terrain,
            color: marker.color,
            symbol: marker.component,
            showLabel: "true",
          },
          marker.description,
        ),
      );
    }
  });

  const settlementCount = Math.max(4, Math.min(18, regionCount + 2));
  const settlements: Array<{
    readonly id: string;
    readonly point: FantasyPoint;
    readonly type: "capital" | "city" | "village" | "port";
    readonly waterwayId: string | null;
  }> = [];
  for (let index = 0; index < settlementCount; index += 1) {
    const river = riverFeatures[index % riverFeatures.length];
    const riverLandPoints =
      river?.points.filter(
        (candidate, pointIndex) => pointIndex > 0 && !isLakePoint(candidate),
      ) ?? [];
    const riverPoint =
      riverLandPoints[(index * 3) % Math.max(1, riverLandPoints.length)] ??
      river?.points.at(-1);
    const settlementType =
      index === 0
        ? "capital"
        : index === settlementCount - 1
          ? "port"
          : index % 3 === 0
            ? "village"
            : "city";
    const preferredSettlementPoint =
      settlementType === "port"
        ? (river?.points.at(-1) ??
          farthestCoastPoint(
            mainCoast,
            mainCenter,
            riverPoint
              ? Math.atan2(
                  riverPoint.y - mainCenter.y,
                  riverPoint.x - mainCenter.x,
                )
              : random() * Math.PI * 2,
          ))
        : riverPoint
          ? projectInsidePolygon(
              point(
                riverPoint.x + (random() - 0.5) * input.width * 0.035,
                riverPoint.y + (random() - 0.5) * input.height * 0.035,
              ),
              riverPoint,
              mainCoast,
            )
          : randomLandPoint(random, mainCoast, mainCenter);
    const settlementPoint = riverPoint
      ? ([
          preferredSettlementPoint,
          riverPoint,
          projectInsidePolygon(
            point(
              riverPoint.x + (random() - 0.5) * input.width * 0.045,
              riverPoint.y + (random() - 0.5) * input.height * 0.045,
            ),
            riverPoint,
            mainCoast,
          ),
        ].find((candidate) => !isLakePoint(candidate)) ?? riverPoint)
      : preferredSettlementPoint;
    const settlement = nameAt(input.placeNames, index, `聚落 ${index + 1}`);
    const settlementId = safeId("settlement", `${seed}-${index}`);
    const waterwayId = river?.id ?? null;
    settlements.push({
      id: settlementId,
      point: settlementPoint,
      type: settlementType,
      waterwayId,
    });
    features.push(
      feature(
        input,
        "marker",
        settlementId,
        settlement,
        [settlementPoint],
        {
          color:
            settlementType === "capital"
              ? "#81432f"
              : settlementType === "port"
                ? "#487887"
                : settlementType === "village"
                  ? "#94663b"
                  : "#9a4e38",
          showLabel: "true",
          component: settlementType,
          symbol: settlementType,
          settlementType,
          ...(waterwayId ? { waterwayId } : {}),
        },
        `从地点库或世界架构资料中抽取的${
          settlementType === "capital"
            ? "都城"
            : settlementType === "port"
              ? "港口"
              : settlementType === "village"
                ? "村镇"
                : "城镇"
        }候选。`,
      ),
    );
  }

  // 聚落之间形成一条可编辑的道路骨架。道路不替代作者手工规划，
  // 只提供一个贴合河流与聚落分布的第一版交通网络。每个新聚落连接到
  // 已出现聚落中最合适的交通节点，而不是按数组顺序生硬串成一条线。
  let bridgeCount = 0;
  for (let index = 1; index < settlements.length; index += 1) {
    const destination = settlements[index]!;
    const origin = settlements.slice(0, index).reduce((best, candidate) => {
      const score = (entry: (typeof settlements)[number]) => {
        const distance = Math.hypot(
          entry.point.x - destination.point.x,
          entry.point.y - destination.point.y,
        );
        // 同一水系的聚落天然共享河谷、渡口与商路；优先连接它们，可让
        // 交通图呈现多个局部网络再汇入都城，而不是随机折线。
        const sameWaterway =
          entry.waterwayId !== null &&
          entry.waterwayId === destination.waterwayId;
        const capitalBonus = entry.type === "capital" ? input.width * 0.055 : 0;
        return distance * (sameWaterway ? 0.74 : 1) - capitalBonus;
      };
      return score(candidate) < score(best) ? candidate : best;
    });
    const from = origin.point;
    const to = destination.point;
    const roadId = safeId("road", `${seed}-${index}`);
    const sharedWaterwayId =
      origin.waterwayId !== null && origin.waterwayId === destination.waterwayId
        ? origin.waterwayId
        : null;
    const followedWaterway = sharedWaterwayId
      ? watercourseFeatures.find((waterway) => waterway.id === sharedWaterwayId)
      : undefined;
    const delta = { x: to.x - from.x, y: to.y - from.y };
    const length = Math.max(1, Math.hypot(delta.x, delta.y));
    const normal = { x: -delta.y / length, y: delta.x / length };
    const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const randomBend = (distance: number) =>
      point(
        middle.x + normal.x * distance * (random() > 0.5 ? 1 : -1),
        middle.y + normal.y * distance * (random() > 0.5 ? 1 : -1),
      );
    const bendCandidates = [
      randomBend(input.height * 0.045),
      point(
        middle.x + normal.x * input.height * 0.085,
        middle.y + normal.y * input.height * 0.085,
      ),
      point(
        middle.x - normal.x * input.height * 0.085,
        middle.y - normal.y * input.height * 0.085,
      ),
      point(
        middle.x + normal.x * input.height * 0.14,
        middle.y + normal.y * input.height * 0.14,
      ),
      point(
        middle.x - normal.x * input.height * 0.14,
        middle.y - normal.y * input.height * 0.14,
      ),
    ];
    const bend =
      bendCandidates
        .map((candidate) => projectInsidePolygon(candidate, from, mainCoast))
        .find(
          (candidate) =>
            !lakePolygons.some((lake) =>
              pathIntersectsPolygon([from, candidate, to], lake),
            ),
        ) ?? projectInsidePolygon(bendCandidates[0]!, from, mainCoast);
    const valleyRoute = followedWaterway
      ? valleyRoadPath({
          roadId,
          from,
          to,
          waterway: followedWaterway,
          coast: mainCoast,
          width: input.width,
          height: input.height,
        })
      : null;
    const routePoints = valleyRoute ?? [from, bend, to];
    // 只有实际采用河谷控制点的道路才宣称跟随该水系。相邻聚落距离过近
    // 时回退为普通连接线，不能留下一个会误导 Agent 与作者的关联字段。
    const followsWaterwayId = valleyRoute ? sharedWaterwayId : null;
    features.push(
      feature(
        input,
        "route",
        roadId,
        `道路 ${index}`,
        routePoints,
        {
          color: "#b1875f",
          terrain: "road",
          routeStyle: "road",
          routeWidth: "6",
          routeColor: "#c49a69",
          routeCasingColor: "#654934",
          fromSettlementId: origin.id,
          toSettlementId: destination.id,
          ...(followsWaterwayId
            ? {
                followsWaterwayId,
                routing: routePoints.length > 3 ? "river-valley" : "direct",
              }
            : {}),
        },
        routePoints.length > 3
          ? "沿主河谷偏移生成的道路候选；控制点可继续独立拖动调整。"
          : "连接聚落、河谷与港口的道路候选，可继续拖动控制点调整。",
      ),
    );
    const bridgePoint = firstPathIntersection(routePoints, watercourseFeatures);
    if (bridgePoint) {
      bridgeCount += 1;
      features.push(
        feature(
          input,
          "marker",
          safeId("bridge", `${seed}-${index}`),
          `桥梁 ${bridgeCount}`,
          [bridgePoint],
          {
            component: "bridge",
            symbol: "bridge",
            terrain: "bridge",
            showLabel: "true",
            roadId,
          },
          "道路跨越河流时生成的可编辑桥梁候选。",
        ),
      );
    }
  }

  const plannedFeatures = applyGenerationPlan(
    input,
    features,
    mainCoast,
    random,
  );
  const styledFeatures = localizeFantasyMapFeatures(
    plannedFeatures,
    seed,
    input.plan?.naming,
  );
  return {
    seed,
    title: input.plan?.spatialLayers[0]?.name ?? names[0] ?? "九州玄幻地图候选",
    summary: `生成中文玄幻地图：1 个主大陆、${landmassCount - 1} 个外岛、${regionCount} 个区域、${lakes.length} 个湖泊、${riverCount} 条主河、${tributaryCount} 条支流、${biomeCount} 个地貌区、${settlementCount} 个分级聚落、${Math.max(0, settlementCount - 1)} 条道路和 ${bridgeCount} 座桥梁；已按${FANTASY_MAP_STYLE_ID}风格读取世界架构上下文，包含山脉、河流、灵脉、秘境、势力与聚落候选。`,
    features: styledFeatures,
  };
}
