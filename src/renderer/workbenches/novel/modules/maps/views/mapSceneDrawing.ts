import {
  getMapRiverStyle,
  mapRiverWidthAt,
  smoothMapPath,
} from "../business/mapHydrography";
import {
  getMapLabelLayout,
  getMapLabelStyle,
  mapFeatureHasLabel,
  mapLabelCanvasFont,
} from "../business/mapLabels";
import { getMapRouteStyle, mapRouteStrokeLayers } from "../business/mapRoutes";
import type {
  MapDocument,
  MapFeature,
  MapScenePoint,
  MapSceneRegion,
} from "../entities/mapSchema";

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

/** 使用平滑闭合路径绘制连续大陆、湖泊和行政区域的外沿。 */
export function drawMapSceneRegionPath(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  camera: MapRenderCamera,
): void {
  if (points.length < 3) return;
  const canvasPoints = points.map((point) => mapToCanvasPoint(point, camera));
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
  drawMapSceneRegionPath(context, points, camera);
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
  const smoothed = smoothMapPath(points);
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
  const smoothed = smoothMapPath(points);
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

/** 有 Azgaar SVG 底图时，保留 SVG 原生标注，避免叠出第二层地名。 */
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
    drawPath(context, points, camera);
    context.stroke();
    context.setLineDash([]);
    context.restore();
    return true;
  }

  if (points.length < 3) {
    context.restore();
    return true;
  }
  drawPath(context, points, camera);
  context.closePath();
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
