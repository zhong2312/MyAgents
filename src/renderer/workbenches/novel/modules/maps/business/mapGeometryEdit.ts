import { isMapFeatureFreeformArea } from "../entities/mapSchema";
import type {
  MapFeature,
  MapFeatureKind,
  MapScenePoint,
} from "../entities/mapSchema";

function distance(a: MapScenePoint, b: MapScenePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(
  point: MapScenePoint,
  start: MapScenePoint,
  end: MapScenePoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return distance(point, start);
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return distance(point, {
    x: start.x + dx * ratio,
    y: start.y + dy * ratio,
  });
}

function distanceToPath(
  point: MapScenePoint,
  points: readonly MapScenePoint[],
): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return distance(point, points[0]!);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    nearest = Math.min(
      nearest,
      distanceToSegment(point, points[index - 1]!, points[index]!),
    );
  }
  return nearest;
}

function distanceToClosedPath(
  point: MapScenePoint,
  points: readonly MapScenePoint[],
): number {
  if (points.length < 3) return distanceToPath(point, points);
  return Math.min(
    distanceToPath(point, points),
    distanceToSegment(point, points[points.length - 1]!, points[0]!),
  );
}

function pointInPolygon(
  point: MapScenePoint,
  points: readonly MapScenePoint[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = points.length - 1;
    index < points.length;
    previous = index++
  ) {
    const current = points[index]!;
    const prior = points[previous]!;
    const intersects =
      current.y > point.y !== prior.y > point.y &&
      point.x <
        ((prior.x - current.x) * (point.y - current.y)) /
          (prior.y - current.y) +
          current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 只有可由多个控制点定义的要素才提供顶点级编辑。 */
export function isMapFeatureVertexEditable(kind: MapFeatureKind): boolean {
  return kind === "route" || isMapFeatureFreeformArea(kind);
}

/**
 * 命中要素真实几何，而不是仅命中首个锚点。
 * 命中余量保持屏幕像素恒定，避免缩放后难以选中细路线。
 */
export function hitMapFeatureGeometry(
  feature: MapFeature,
  target: MapScenePoint,
  zoom: number,
  screenRadius = 12,
): boolean {
  const radius = screenRadius / Math.max(0.08, zoom);
  if (feature.points.length === 0) return false;
  if (
    feature.kind === "marker" ||
    feature.kind === "label" ||
    feature.kind === "node"
  ) {
    return distance(target, feature.points[0]!) <= radius;
  }
  if (isMapFeatureFreeformArea(feature.kind)) {
    return (
      pointInPolygon(target, feature.points) ||
      distanceToClosedPath(target, feature.points) <= radius
    );
  }
  const declaredWidth = Number(
    feature.props.routeWidth ?? feature.props.lineWidth ?? 2,
  );
  const visualRadius = Number.isFinite(declaredWidth)
    ? Math.max(0, declaredWidth) / 2 + 4 / Math.max(0.08, zoom)
    : 0;
  const distanceToRoute =
    feature.kind === "route" && feature.props.closed === "true"
      ? distanceToClosedPath(target, feature.points)
      : distanceToPath(target, feature.points);
  return distanceToRoute <= Math.max(radius, visualRadius);
}

/** 以屏幕像素为准的顶点手柄命中，缩放不会改变可操作范围。 */
export function findMapGeometryVertexHandle(
  points: readonly MapScenePoint[],
  target: MapScenePoint,
  zoom: number,
  screenRadius = 9,
): number | null {
  const radius = screenRadius / Math.max(0.08, zoom);
  let nearestIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const pointDistance = distance(point, target);
    if (pointDistance <= radius && pointDistance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = pointDistance;
    }
  });
  return nearestIndex;
}

/** 只替换一个控制点；原数组保持不变，画布边界由文档层统一扩展。 */
export function replaceMapGeometryVertex(
  points: readonly MapScenePoint[],
  index: number,
  next: MapScenePoint,
  _canvas: { readonly width: number; readonly height: number },
): MapScenePoint[] {
  if (index < 0 || index >= points.length)
    return points.map((point) => ({ ...point }));
  return points.map((point, pointIndex) =>
    pointIndex === index ? { ...next } : { ...point },
  );
}
