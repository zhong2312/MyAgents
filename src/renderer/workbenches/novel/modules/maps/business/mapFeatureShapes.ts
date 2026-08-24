import type { MapScenePoint } from "../entities/mapSchema";
import type { MapAreaShape, MapBrushPointCurve } from "./mapCanvasSession";

const SHAPE_SEGMENTS = 32;
const DEFAULT_SHAPE_RADIUS = 48;

/** 根据一次拖拽的包围盒生成规则画笔区域；闭合和多边形由调用方保留轨迹。 */
export function createMapAreaShapePoints(
  shape: Exclude<MapAreaShape, "closed" | "polygon" | "freehand">,
  start: MapScenePoint,
  end: MapScenePoint,
): MapScenePoint[] {
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  const center = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
  const radius = Math.max(DEFAULT_SHAPE_RADIUS, width / 2, height / 2);
  const radiusX = Math.max(DEFAULT_SHAPE_RADIUS, width / 2);
  const radiusY = Math.max(DEFAULT_SHAPE_RADIUS, height / 2);
  const currentRadiusX = shape === "circle" ? radius : radiusX;
  const currentRadiusY = shape === "circle" ? radius : radiusY;

  return Array.from({ length: SHAPE_SEGMENTS }, (_, index) => {
    const angle = (index / SHAPE_SEGMENTS) * Math.PI * 2;
    return {
      x: center.x + Math.cos(angle) * currentRadiusX,
      y: center.y + Math.sin(angle) * currentRadiusY,
    };
  });
}

function distance(a: MapScenePoint, b: MapScenePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points: readonly MapScenePoint[], closed: boolean): number {
  if (points.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1]!, points[index]!);
  }
  if (closed) length += distance(points[points.length - 1]!, points[0]!);
  return length;
}

function pointAtDistance(
  points: readonly MapScenePoint[],
  target: number,
  closed: boolean,
): MapScenePoint {
  const total = pathLength(points, closed);
  if (points.length === 0) return { x: 0, y: 0 };
  if (total <= 0) return { ...points[0]! };
  let travelled = 0;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const length = distance(start, end);
    if (travelled + length >= target || index === segmentCount - 1) {
      const ratio = length > 0 ? (target - travelled) / length : 0;
      return {
        x: start.x + (end.x - start.x) * Math.max(0, Math.min(1, ratio)),
        y: start.y + (end.y - start.y) * Math.max(0, Math.min(1, ratio)),
      };
    }
    travelled += length;
  }
  return { ...points[points.length - 1]! };
}

function catmullRom(
  p0: MapScenePoint,
  p1: MapScenePoint,
  p2: MapScenePoint,
  p3: MapScenePoint,
  ratio: number,
): MapScenePoint {
  const t2 = ratio * ratio;
  const t3 = t2 * ratio;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * ratio +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * ratio +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * 判断开放轨迹是否几乎落在同一条直线上。真实指针事件通常会产生很多
 * 共线采样点；如果只对“恰好两个点”做弧线处理，用户拖出一条直线后
 * 选择弧线仍会得到直线，造成弧线选项看起来没有生效。
 */
function isNearlyStraightPath(points: readonly MapScenePoint[]): boolean {
  if (points.length < 3) return true;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return true;
  // 指针采样不可避免会带来轻微抖动。1.2% 只适合程序生成的理想直线，
  // 真实拖拽会因此绕过“弧线”分支，最终看起来仍是一条折线。把阈值设为
  // 4.5% 只吸收小幅抖动，明显偏离主方向的自由轨迹仍交给 Catmull-Rom。
  const tolerance = Math.max(1.5, length * 0.045);
  return points
    .slice(1, -1)
    .every(
      (point) =>
        Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) /
          length <=
        tolerance,
    );
}

function smoothControlPoints(
  points: readonly MapScenePoint[],
  closed: boolean,
): MapScenePoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  // 两个触点也必须能表达“弧线”语义。实际拖动很短或采样频率较低时，
  // 原始轨迹可能只有起点和终点；直接退化为折线会让弧线选项看起来失效。
  // 用稳定的法向偏移构造二次贝塞尔控制点，端点仍保持作者实际落笔位置。
  if (!closed && isNearlyStraightPath(points)) {
    const start = points[0]!;
    const end = points[points.length - 1]!;
    const dx = end!.x - start!.x;
    const dy = end!.y - start!.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0) return points.map((point) => ({ ...point }));
    // 弧线是作者主动选择的绘制模式，不能只做几像素的平滑而在画布上
    // 看起来仍像直线。这个偏移只作用于“几乎共线”的轨迹，真实曲线
    // 仍由 Catmull-Rom 采样，保证自由手绘不会被强行改成固定圆弧。
    // 弧线是显式的绘制模式，不能只产生几像素的平滑偏移；否则在
    // 画布缩放或选中虚线下会再次看起来像直线。这个弯曲比例只作用于
    // 原始轨迹近似共线的情况，真实自由曲线仍保留作者的轨迹形状。
    const bend = Math.min(Math.max(length * 0.32, 20), 160);
    const control = {
      x: (start!.x + end!.x) / 2 - (dy / length) * bend,
      y: (start!.y + end!.y) / 2 + (dx / length) * bend,
    };
    const result: MapScenePoint[] = [];
    const samples = 24;
    for (let index = 0; index <= samples; index += 1) {
      const ratio = index / samples;
      const inverse = 1 - ratio;
      result.push({
        x:
          inverse * inverse * start!.x +
          2 * inverse * ratio * control.x +
          ratio * ratio * end!.x,
        y:
          inverse * inverse * start!.y +
          2 * inverse * ratio * control.y +
          ratio * ratio * end!.y,
      });
    }
    return result;
  }
  const segments = closed ? points.length : points.length - 1;
  const result: MapScenePoint[] = [];
  const samplesPerSegment = 12;
  for (let index = 0; index < segments; index += 1) {
    const p0 = closed
      ? points[(index - 1 + points.length) % points.length]!
      : points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = closed
      ? points[(index + 1) % points.length]!
      : points[Math.min(points.length - 1, index + 1)]!;
    const p3 = closed
      ? points[(index + 2) % points.length]!
      : points[Math.min(points.length - 1, index + 2)]!;
    const limit = closed || index < segments - 1 ? samplesPerSegment : 1;
    for (let sample = 0; sample < limit; sample += 1) {
      result.push(catmullRom(p0, p1, p2, p3, sample / samplesPerSegment));
    }
  }
  if (!closed) result.push({ ...points[points.length - 1]! });
  return result;
}

/**
 * 将画笔控制点转换为实际渲染/命中使用的弧线采样点。
 *
 * MapDocument 只保存作者控制点，不能把渲染器自己的中间采样点写回事实
 * 源。所有画布、地形合成和导出都必须通过这一个函数消费 `curve`，否则
 * 工具栏虽然保存了“弧线”，最终成图仍可能按原始折线绘制。
 */
export function mapBrushCurvePoints(
  points: readonly MapScenePoint[],
  curve: MapBrushPointCurve = "line",
  closed = false,
): MapScenePoint[] {
  if (curve !== "arc" || points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const source =
    closed && points.length > 2 && distance(points[0]!, points.at(-1)!) < 0.001
      ? points.slice(0, -1)
      : points;
  const sampled = smoothControlPoints(source, closed);
  return sampled.length > 1 ? sampled : source.map((point) => ({ ...point }));
}

/**
 * 统一重采样画笔触点。直线模式沿原始折线等距取样，弧线模式先用
 * Catmull-Rom 生成平滑中心线再等距取样；闭合区域不重复保存首点。
 */
export function resampleMapBrushPoints(
  points: readonly MapScenePoint[],
  count: number,
  curve: MapBrushPointCurve = "line",
  closed = false,
): MapScenePoint[] {
  const source = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }));
  if (source.length <= 1) return source;
  const withoutDuplicateEnd =
    closed && source.length > 2 && distance(source[0]!, source.at(-1)!) < 0.001
      ? source.slice(0, -1)
      : source;
  const safeCount = Math.max(closed ? 3 : 2, Math.round(count));
  const sampledSource =
    curve === "arc"
      ? smoothControlPoints(withoutDuplicateEnd, closed)
      : withoutDuplicateEnd;
  const total = pathLength(sampledSource, closed);
  if (total <= 0) return sampledSource.slice(0, safeCount);
  return Array.from({ length: safeCount }, (_, index) => {
    // 端点是作者实际落笔位置，不能因为 Catmull-Rom 的浮点误差变成
    // `4e-15` 这样的近似值；这也保证闭合检测和后续编辑的端点契约稳定。
    if (!closed && index === 0) return { ...sampledSource[0]! };
    if (!closed && index === safeCount - 1) {
      return { ...sampledSource[sampledSource.length - 1]! };
    }
    return pointAtDistance(
      sampledSource,
      (total * index) / (closed ? safeCount : safeCount - 1),
      closed,
    );
  });
}

/** 按笔刷间距重采样开放路径，保证素材/河流/橡皮盖印触点均匀。 */
export function resampleMapBrushPointsBySpacing(
  points: readonly MapScenePoint[],
  spacing: number,
  curve: MapBrushPointCurve = "line",
): MapScenePoint[] {
  const total = pathLength(points, false);
  const count = Math.max(2, Math.ceil(total / Math.max(1, spacing)) + 1);
  return resampleMapBrushPoints(points, count, curve, false);
}

/** 画笔轨迹首尾足够接近时视为闭合，可在检查器中转成陆地/水域区域。 */
export function isMapBrushPathClosed(
  points: readonly MapScenePoint[],
  tolerance = 24,
): boolean {
  // 仅凭首尾距离会把所有短开放笔画误判成闭合区域：当笔画总长度本身
  // 还没有超过闭合容差时，用户实际上不可能可靠地区分“回到起点”和
  // “画了一小段弯线”。先要求有足够的轨迹长度，再沿用首尾接近规则。
  const minimumPathLength = Math.max(0, tolerance);
  return (
    points.length >= 3 &&
    pathLength(points, false) > minimumPathLength &&
    distance(points[0]!, points.at(-1)!) <= tolerance
  );
}
