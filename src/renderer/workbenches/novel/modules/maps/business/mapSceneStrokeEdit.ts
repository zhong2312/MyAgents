import { findMapGeometryVertexHandle } from "./mapGeometryEdit";
import type { MapScenePoint } from "../entities/mapSchema";

const DEFAULT_MAX_CONTROL_POINTS = 8;

/**
 * 连续笔触的原始采样点可能很多。画布只派生有限控制点，不在文档中增加
 * 第二套几何数据，控制点始终对应某个真实采样点。
 */
export function mapSceneStrokeControlPointIndexes(
  points: readonly MapScenePoint[],
  maxControlPoints = DEFAULT_MAX_CONTROL_POINTS,
): number[] {
  if (points.length === 0) return [];
  const limit = Number.isFinite(maxControlPoints)
    ? Math.min(DEFAULT_MAX_CONTROL_POINTS, Math.floor(maxControlPoints))
    : DEFAULT_MAX_CONTROL_POINTS;
  if (limit <= 0) return [];
  if (points.length <= limit) {
    return points.map((_, index) => index);
  }
  if (limit === 1) return [0];
  const count = Math.max(2, limit);
  return Array.from({ length: count }, (_, controlIndex) =>
    Math.round((controlIndex * (points.length - 1)) / (count - 1)),
  );
}

export function mapSceneStrokeControlPoints(
  points: readonly MapScenePoint[],
  maxControlPoints = DEFAULT_MAX_CONTROL_POINTS,
): MapScenePoint[] {
  return mapSceneStrokeControlPointIndexes(points, maxControlPoints).map(
    (index) => points[index]!,
  );
}

/** 返回原始采样点下标，而不是控制点数组中的位置。 */
export function findMapSceneStrokeControlPointHandle(
  points: readonly MapScenePoint[],
  target: MapScenePoint,
  zoom: number,
  maxControlPoints = DEFAULT_MAX_CONTROL_POINTS,
): number | null {
  const indexes = mapSceneStrokeControlPointIndexes(points, maxControlPoints);
  const controlPointIndex = findMapGeometryVertexHandle(
    indexes.map((index) => points[index]!),
    target,
    zoom,
  );
  return controlPointIndex === null
    ? null
    : (indexes[controlPointIndex] ?? null);
}

/**
 * 将拖动从有限控制点展开回原始笔触。相邻控制点的中点是影响边界，使用
 * 线性衰减避免每 8px 的原始采样点出现突兀折角。
 */
export function moveMapSceneStrokeControlPoint(
  points: readonly MapScenePoint[],
  controlPointIndex: number,
  next: MapScenePoint,
  _canvas: { readonly width: number; readonly height: number },
  maxControlPoints = DEFAULT_MAX_CONTROL_POINTS,
): MapScenePoint[] {
  const current = points[controlPointIndex];
  if (!current) return points.map((point) => ({ ...point }));

  const indexes = mapSceneStrokeControlPointIndexes(points, maxControlPoints);
  const position = indexes.indexOf(controlPointIndex);
  if (position < 0) return points.map((point) => ({ ...point }));

  const delta = { x: next.x - current.x, y: next.y - current.y };
  const previous = indexes[position - 1] ?? controlPointIndex;
  const following = indexes[position + 1] ?? controlPointIndex;
  const from =
    position === 0
      ? controlPointIndex
      : Math.ceil((previous + controlPointIndex) / 2);
  const to =
    position === indexes.length - 1
      ? controlPointIndex
      : Math.floor((controlPointIndex + following) / 2);

  return points.map((point, index) => {
    const weight =
      index < from || index > to
        ? 0
        : index <= controlPointIndex
          ? (index - from) / Math.max(1, controlPointIndex - from)
          : (to - index) / Math.max(1, to - controlPointIndex);
    return {
      x: point.x + delta.x * weight,
      y: point.y + delta.y * weight,
    };
  });
}
