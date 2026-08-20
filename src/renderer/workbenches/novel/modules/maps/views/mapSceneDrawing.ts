import { getMapRiverStyle, mapRiverWidthAt } from "../business/mapHydrography";
import { mapBrushCurvePoints } from "../business/mapFeatureShapes";
import {
  getMapLabelLayout,
  getMapLabelStyle,
  mapFeatureHasLabel,
  mapLabelCanvasFont,
} from "../business/mapLabels";
import { getMapRouteStyle, mapRouteStrokeLayers } from "../business/mapRoutes";
import type {
  MapDocument,
  MapBrushPointCurve,
  MapFeature,
  MapScenePoint,
  MapSceneRegion,
} from "../entities/mapSchema";

// 兼容现有视图/导出模块的导入路径；几何实现本身归属于业务层，避免
// 渲染器和持久化层各自维护一套弧线采样算法。
export { mapBrushCurvePoints } from "../business/mapFeatureShapes";

export type MapRenderCamera = {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
};

function distance(a: MapScenePoint, b: MapScenePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function samplePath(
  points: readonly MapScenePoint[],
  spacing: number,
): MapScenePoint[] {
  if (points.length < 2) return points.length === 1 ? [{ ...points[0]! }] : [];
  const result: MapScenePoint[] = [{ ...points[0]! }];
  let carry = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const segmentLength = distance(from, to);
    if (segmentLength <= 0) continue;
    let travelled = spacing - carry;
    while (travelled <= segmentLength) {
      const ratio = travelled / segmentLength;
      result.push({
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      });
      travelled += spacing;
    }
    carry = segmentLength - (travelled - spacing);
  }
  const last = points[points.length - 1]!;
  if (distance(result[result.length - 1]!, last) > spacing * 0.35) {
    result.push({ ...last });
  }
  return result;
}

export function featureVisible(
  document: MapDocument,
  feature: MapFeature,
  timelineCursor: number | null,
): boolean {
  const layer = document.layers.find((item) => item.id === feature.layerId);
  if (!layer?.visible) return false;
  if (timelineCursor === null) return true;
  return (
    (feature.timeFrom === null || timelineCursor >= feature.timeFrom) &&
    (feature.timeTo === null || timelineCursor <= feature.timeTo)
  );
}

export function mapToCanvasPoint(
  point: MapScenePoint,
  camera: MapRenderCamera,
): MapScenePoint {
  return {
    x: camera.x + point.x * camera.zoom,
    y: camera.y + point.y * camera.zoom,
  };
}

export function drawPath(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
): void {
  const first = points[0];
  if (!first) return;
  const start = mapToCanvasPoint(first, camera);
  context.beginPath();
  context.moveTo(start.x, start.y);
  points.slice(1).forEach((point) => {
    const next = mapToCanvasPoint(point, camera);
    context.lineTo(next.x, next.y);
  });
}

/**
 * 用二次贝塞尔曲线绘制画笔要素。
 *
 * 画笔的控制点仍然来自 MapFeature.points；曲线只是由这个事实派生的
 * 绘制结果。这样交互画布、导出器和缩略导航都可以复用同一条路径规则，
 * 也不会把额外的采样点写入地图文档。
 */
export function drawMapBrushPath(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  curve: "line" | "arc" = "line",
  closed = false,
): void {
  // 先用同一份采样结果作为所有渲染器的控制点，再使用 Canvas 的二次
  // 曲线 API 绘制。这样保留平滑端点，同时不会出现“主画布按原折线、
  // 素材/导出按弧线”的分裂行为。
  // 闭合区域继续以作者控制点作为曲线控制柄，保证边界编辑时每个
  // 触点仍对应一个可拖动顶点；开放路径则使用统一的弧线采样中心线。
  // 闭合区域也必须经过同一份弧线采样；此前闭合分支直接使用原始控制点，
  // 导致开放路线能看到弧线，而自由画笔闭合后看起来仍像多边形。
  const pathPoints = mapBrushCurvePoints(points, curve, closed);
  if (curve !== "arc" || pathPoints.length < 2) {
    drawPath(context, pathPoints, camera);
    if (closed && pathPoints.length >= 3) context.closePath();
    return;
  }
  const canvasPoints = pathPoints.map((point) =>
    mapToCanvasPoint(point, camera),
  );
  const midpoint = (a: MapScenePoint, b: MapScenePoint): MapScenePoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  context.beginPath();
  if (closed) {
    const first = canvasPoints[0]!;
    const last = canvasPoints[canvasPoints.length - 1]!;
    const start = midpoint(last, first);
    context.moveTo(start.x, start.y);
    canvasPoints.forEach((point, index) => {
      const next = canvasPoints[(index + 1) % canvasPoints.length]!;
      const end = midpoint(point, next);
      context.quadraticCurveTo(point.x, point.y, end.x, end.y);
    });
    context.closePath();
    return;
  }
  context.moveTo(canvasPoints[0]!.x, canvasPoints[0]!.y);
  for (let index = 1; index < canvasPoints.length - 1; index += 1) {
    const point = canvasPoints[index]!;
    const next = canvasPoints[index + 1]!;
    const end = midpoint(point, next);
    context.quadraticCurveTo(point.x, point.y, end.x, end.y);
  }
  const last = canvasPoints[canvasPoints.length - 1]!;
  context.quadraticCurveTo(last.x, last.y, last.x, last.y);
}

/** 从要素属性读取画笔曲线模式，旧数据默认保持折线语义。 */
export function mapFeatureBrushCurve(
  feature: Pick<MapFeature, "props">,
): "line" | "arc" {
  return feature.props.curve === "arc" ? "arc" : "line";
}

/** 使用平滑闭合路径绘制连续大陆、湖泊和行政区域的外沿。 */
export function drawMapSceneRegionPath(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  curve: MapBrushPointCurve = "arc",
): void {
  if (points.length < 3) return;
  if (curve === "line") {
    drawPath(context, points, camera);
    context.closePath();
    return;
  }
  // 区域本身保存的是作者控制点；弧线模式必须先经过与画笔要素、地表
  // 合成器和导出器相同的采样器。此前这里直接拿原始点做二次贝塞尔，
  // 检查器切换曲线后虽然调用了 quadraticCurveTo，但闭合区域的触点
  // 数量和曲率没有真正按统一契约变化，主画布与地表边界也会出现偏差。
  const renderedPoints = mapBrushCurvePoints(points, curve, true);
  const canvasPoints = renderedPoints.map((point) =>
    mapToCanvasPoint(point, camera),
  );
  const last = canvasPoints[canvasPoints.length - 1]!;
  const first = canvasPoints[0]!;
  context.beginPath();
  context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  canvasPoints.forEach((point, index) => {
    const next = canvasPoints[(index + 1) % canvasPoints.length]!;
    context.quadraticCurveTo(
      point.x,
      point.y,
      (point.x + next.x) / 2,
      (point.y + next.y) / 2,
    );
  });
  context.closePath();
}

/** 区域边线属于场景语义的一部分，交互画布与导出必须一致。 */
export function drawMapSceneRegionEdge(
  context: CanvasRenderingContext2D,
  region: MapSceneRegion,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
): void {
  if (points.length < 3 || opacity <= 0) return;
  context.save();
  context.globalAlpha = opacity;
  context.strokeStyle = region.edgeColor;
  context.lineWidth = Math.max(0.75, region.edgeWidth * camera.zoom);
  context.lineCap = "round";
  context.lineJoin = "round";
  drawMapSceneRegionPath(context, points, camera, region.curve);
  context.stroke();
  context.restore();
}

/**
 * 陆地填色由地表合成器按并集生成；合成结果存在时若仍逐个描边，会把两个
 * 相交大陆之间的内部边界画出来。水域则仍保留独立边线，用于清晰表达湖泊
 * 和内海。选中时的编辑轮廓由画布单独绘制，不受本规则影响。
 */
export function shouldDrawMapSceneRegionEdge(
  region: MapSceneRegion,
  hasTerrainComposite: boolean,
): boolean {
  return !hasTerrainComposite || region.kind !== "land";
}

export function drawTaperedRiver(
  context: CanvasRenderingContext2D,
  feature: MapFeature,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
): void {
  // 旧河流未保存触点模式，继续保持自然平滑；只有新画笔显式选择 line
  // 时才关闭平滑，避免打开旧地图后河道形状发生变化。
  const curve = feature.props.curve === "line" ? "line" : "arc";
  const smoothed = mapBrushCurvePoints(points, curve);
  if (smoothed.length < 2) return;
  const style = getMapRiverStyle(feature);

  const drawBand = (
    color: string,
    widthOffset: number,
    alpha: number,
    widthScale = 1,
  ) => {
    context.strokeStyle = color;
    context.globalAlpha = opacity * alpha;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (let index = 1; index < smoothed.length; index += 1) {
      const from = mapToCanvasPoint(smoothed[index - 1]!, camera);
      const to = mapToCanvasPoint(smoothed[index]!, camera);
      const progress = index / (smoothed.length - 1);
      context.lineWidth = Math.max(
        0.7,
        (mapRiverWidthAt(style, progress) * widthScale + widthOffset) *
          camera.zoom,
      );
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
  };

  context.save();
  drawBand(style.bankColor, style.bankWidth * 2, 0.74);
  drawBand(style.color, 0, 1);
  drawBand(style.highlightColor, 0, 0.38, 0.18);
  context.restore();
}

function drawRouteDecoration(
  context: CanvasRenderingContext2D,
  style: NonNullable<ReturnType<typeof getMapRouteStyle>>,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
): void {
  if (style.decoration === "none") return;
  const spacing = style.decoration === "wall" ? 20 : 18;
  const samples = samplePath(points, spacing);
  context.save();
  context.globalAlpha = opacity * (style.decoration === "wall" ? 0.64 : 0.42);
  context.strokeStyle =
    style.decoration === "wall" ? style.casingColor : "#f4dfb6";
  context.fillStyle = style.color;
  context.lineWidth = Math.max(0.8, 1.25 * camera.zoom);

  samples.forEach((point, index) => {
    const before = samples[Math.max(0, index - 1)]!;
    const after = samples[Math.min(samples.length - 1, index + 1)]!;
    const angle = Math.atan2(after.y - before.y, after.x - before.x);
    const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
    const perpendicular = { x: -tangent.y, y: tangent.x };
    const center = mapToCanvasPoint(point, camera);
    const halfWidth = style.width * camera.zoom * 0.34;

    context.beginPath();
    context.moveTo(
      center.x - perpendicular.x * halfWidth,
      center.y - perpendicular.y * halfWidth,
    );
    context.lineTo(
      center.x + perpendicular.x * halfWidth,
      center.y + perpendicular.y * halfWidth,
    );
    context.stroke();

    if (style.decoration === "wall" && index % 5 === 0) {
      const towerRadius = Math.max(2.5, (style.width * camera.zoom) / 2.3);
      context.beginPath();
      context.arc(center.x, center.y, towerRadius, 0, Math.PI * 2);
      context.globalAlpha = opacity * 0.9;
      context.fill();
      context.stroke();
      context.globalAlpha = opacity * 0.64;
    }
  });
  context.restore();
}

/** 绘制道路、城墙和疆界。返回 false 让普通路线走兼容的单线渲染。 */
export function drawMapStyledRoute(
  context: CanvasRenderingContext2D,
  feature: MapFeature,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
): boolean {
  const style = getMapRouteStyle(feature);
  if (!style || style.id === "plain") return false;
  // 样式路线也必须尊重画笔的直线/弧线选择，不能绕过通用触点契约。
  // 缺少 curve 的历史路线沿用原先的自然平滑。
  const curve = feature.props.curve === "line" ? "line" : "arc";
  const smoothed = mapBrushCurvePoints(points, curve);
  if (smoothed.length < 2) return false;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  mapRouteStrokeLayers(style).forEach((layer) => {
    context.globalAlpha = opacity;
    context.strokeStyle = layer.color;
    context.lineWidth = Math.max(0.8, layer.width * camera.zoom);
    context.setLineDash(
      layer.dash ? layer.dash.map((value) => value * camera.zoom) : [],
    );
    drawPath(context, smoothed, camera);
    context.stroke();
  });
  context.setLineDash([]);
  context.restore();

  drawRouteDecoration(context, style, smoothed, camera, opacity);
  return true;
}

type AzgaarOverlayLayer =
  | "state"
  | "province"
  | "biome"
  | "lake"
  | "burg"
  | "marker"
  | "river"
  | "route";

function azgaarOverlayLayer(feature: MapFeature): AzgaarOverlayLayer | null {
  switch (feature.props.azgaarLayer) {
    case "state":
      return "state";
    case "province":
      return "province";
    case "biome":
      return "biome";
    case "lake":
      return "lake";
    case "burg":
      return "burg";
    case "marker":
      return "marker";
    case "river":
      return "river";
    case "route":
      return "route";
    default:
      return null;
  }
}

/** Azgaar 的 SVG 已包含成图细节；MapDocument 只叠加可编辑的低存在感边界。 */
export function isAzgaarOverlayFeature(feature: MapFeature): boolean {
  return azgaarOverlayLayer(feature) !== null;
}

/** Azgaar SVG 的原生英文标签由样式适配层隐藏，中文可编辑要素负责重绘。 */
export function shouldDrawMapFeatureTextOverlay(
  feature: MapFeature,
  hasAzgaarBaseMap: boolean,
): boolean {
  return (
    !hasAzgaarBaseMap ||
    !isAzgaarOverlayFeature(feature) ||
    feature.props.azgaarShowLabel === "true"
  );
}

/**
 * 绘制附着在 Azgaar SVG 上的可编辑地理对象。
 *
 * 普通多边形的半透明填色会覆盖生成器已经绘制好的色带、阴影与纹理；这里
 * 仅保留可辨识的边界和低强度水域覆盖。选中轮廓仍由画布统一补绘。
 */
export function drawAzgaarOverlayFeature(
  context: CanvasRenderingContext2D,
  feature: MapFeature,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
  hasAzgaarBaseMap: boolean,
): boolean {
  const layer = azgaarOverlayLayer(feature);
  if (!layer || !hasAzgaarBaseMap) return false;
  if (points.length === 0 || opacity <= 0) return true;

  const color = feature.props.color ?? "#6f5944";
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (layer === "burg" || layer === "marker") {
    const point = mapToCanvasPoint(points[0]!, camera);
    context.globalAlpha = opacity * (layer === "burg" ? 0.72 : 0.56);
    context.fillStyle = color;
    context.beginPath();
    context.arc(point.x, point.y, layer === "burg" ? 3.5 : 2.5, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return true;
  }

  if (layer === "river" || layer === "route") {
    context.globalAlpha = opacity * (layer === "river" ? 0.52 : 0.38);
    context.strokeStyle = color;
    context.lineWidth = Math.max(
      0.75,
      Number(feature.props.lineWidth ?? 1) * camera.zoom,
    );
    if (layer === "route")
      context.setLineDash([4 * camera.zoom, 5 * camera.zoom]);
    drawMapBrushPath(context, points, camera, mapFeatureBrushCurve(feature));
    context.stroke();
    context.setLineDash([]);
    context.restore();
    return true;
  }

  if (points.length < 3) {
    context.restore();
    return true;
  }
  // Azgaar 的州、省、湖泊和生物群系覆盖也属于可编辑画笔要素。
  // 这里不能绕过统一曲线渲染，否则同一个自由画笔在普通地图上是弧线，
  // 一旦附着到生成器底图就又退化成折线。
  drawMapBrushPath(
    context,
    points,
    camera,
    mapFeatureBrushCurve(feature),
    true,
  );
  if (layer === "lake") {
    context.globalAlpha = opacity * 0.12;
    context.fillStyle = feature.props.fill ?? color;
    context.fill();
  }
  context.globalAlpha =
    opacity *
    (layer === "state"
      ? 0.58
      : layer === "province"
        ? 0.42
        : layer === "lake"
          ? 0.64
          : 0.2);
  context.strokeStyle = color;
  context.lineWidth = Math.max(
    0.7,
    Number(feature.props.lineWidth ?? (layer === "state" ? 1.5 : 1)) *
      camera.zoom,
  );
  if (layer === "province") {
    context.setLineDash([5 * camera.zoom, 4 * camera.zoom]);
  } else if (layer === "biome") {
    context.setLineDash([1.5 * camera.zoom, 5 * camera.zoom]);
  }
  context.stroke();
  context.setLineDash([]);
  context.restore();
  return true;
}

export function drawMapFeatureLabel(
  context: CanvasRenderingContext2D,
  feature: MapFeature,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
  opacity: number,
): void {
  if (!mapFeatureHasLabel(feature) || points.length === 0) return;
  const style = getMapLabelStyle(feature);
  const layout = getMapLabelLayout(feature, points);
  const anchor = mapToCanvasPoint(layout.anchor, camera);

  context.save();
  context.globalAlpha = opacity;
  context.translate(
    anchor.x + style.offsetX * camera.zoom,
    anchor.y + style.offsetY * camera.zoom,
  );
  context.rotate(((style.rotation + layout.pathRotation) * Math.PI) / 180);
  context.font = mapLabelCanvasFont(style, camera.zoom);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  if (style.haloWidth > 0) {
    context.strokeStyle = style.haloColor;
    context.lineWidth = style.haloWidth * camera.zoom;
    context.strokeText(feature.name, 0, 0);
  }
  context.fillStyle = style.color;
  context.fillText(feature.name, 0, 0);
  context.restore();
}

export function drawImageAsset(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  point: MapScenePoint,
  camera: MapRenderCamera,
  width: number,
  height: number,
  rotation = 0,
  opacity = 1,
  flipX = false,
  flipY = false,
): void {
  const target = mapToCanvasPoint(point, camera);
  context.save();
  context.globalAlpha = opacity;
  context.translate(target.x, target.y);
  context.rotate(rotation);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  context.drawImage(
    image,
    (-width * camera.zoom) / 2,
    (-height * camera.zoom) / 2,
    width * camera.zoom,
    height * camera.zoom,
  );
  context.restore();
}
