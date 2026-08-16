import {
  Download,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToastOptional } from "@/components/Toast";

import {
  MAP_COMPONENT_DRAG_MIME,
  MAP_COMPONENT_PRESETS,
  createMapComponentPrefabFeature,
  createMapComponentPrefabRegions,
  type MapComponentPlacementGesture,
} from "../business/mapComponents";
import {
  createMapArtworkAssetCatalog,
  getMapArtworkAssetVariant,
  getMapArtworkAssetVariantWithColor,
  mapArtworkVariantIndex,
  type MapArtworkAssetCatalog,
  type MapArtworkAssetVariant,
} from "../business/mapArtwork";
import {
  hitMapArtworkTransformHandle,
  mapArtworkStampRenderSize,
  mapArtworkStampPlacementTransform,
  mapArtworkTransformHandles,
  rotateMapArtworkStampFromPointer,
  scaleMapArtworkStampFromPointer,
  type MapArtworkStampPlacementGesture,
  type MapArtworkStampSize,
  type MapArtworkStampTransform,
} from "../business/mapArtworkTransform";
import {
  findMapGeometryVertexHandle,
  hitMapFeatureGeometry,
  isMapFeatureVertexEditable,
  replaceMapGeometryVertex,
} from "../business/mapGeometryEdit";
import { mapFeaturesInRenderOrder } from "../business/mapLayerOrder";
import {
  mapArtworkLayersInRenderOrder,
  type MapArtworkRenderPhase,
} from "../business/mapArtworkLayerOrder";
import {
  mapSceneLayerBrushClipsToLand,
  isMapTerrainMaskStroke,
  isMapTerrainMaterialStroke,
} from "../business/mapScene";
import {
  findMapSceneStrokeControlPointHandle,
  mapSceneStrokeControlPoints,
  moveMapSceneStrokeControlPoint,
} from "../business/mapSceneStrokeEdit";
import {
  autoPanMapSceneCameraAtEdge,
  fitMapSceneCameraToBounds,
  panMapSceneCamera,
  rebaseMapSceneCamera,
  type MapSceneBounds,
  type MapSceneCamera,
  zoomMapSceneCameraAt,
} from "../business/mapSceneCamera";
import {
  mapArtworkBrushDabs,
  mapTerrainBrushDabs,
} from "../business/mapTerrainBrush";
import { getMapTerrainMaterialPreset } from "../business/mapTerrainMaterials";
import { isMapRiverFeature } from "../business/mapHydrography";
import { getMapBackgroundImagePlacement } from "../business/mapBackgrounds";
import {
  createMapTerrainComposite,
  mapTerrainCompositeHasLandAt,
} from "./mapTerrainCompositor";
import { downloadMapDocumentPng } from "./mapSceneExporter";
import {
  drawContainedMapBackgroundImage,
  drawMapSceneBackgroundSlice,
} from "./mapSceneBackground";
import {
  drawImageAsset,
  drawAzgaarOverlayFeature,
  drawMapFeatureLabel,
  drawMapSceneRegionEdge,
  drawMapSceneRegionPath,
  drawMapStyledRoute,
  drawPath,
  drawTaperedRiver,
  featureVisible,
  mapToCanvasPoint,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
} from "./mapSceneDrawing";
import type {
  MapDocument,
  MapArtworkStamp,
  MapFeature,
  MapFeatureKind,
  MapScenePoint,
  MapSceneRegion,
  MapSceneLayerKind,
  MapTerrainMaterial,
} from "../entities/mapSchema";
import {
  DEFAULT_MAP_CANVAS_SETTINGS,
  type MapCanvasSettings,
  type MapCanvasTool,
} from "../business/mapCanvasSession";

type SceneMode =
  | "pan"
  | "brush"
  | "erase"
  | "terrain-land"
  | "terrain-water"
  | "terrain-material"
  | "draw"
  | "region"
  | "place-stamp"
  | "place-terrain-prefab"
  | "move-stamp"
  | "scale-stamp"
  | "rotate-stamp"
  | "move-feature"
  | "move-feature-vertex"
  | "move-stroke"
  | "move-stroke-control-point"
  | "move-region"
  | "move-region-vertex"
  | "marquee"
  | "move-selection";

const EMPTY_PROJECT_ARTWORK_SOURCES: ReadonlyMap<string, string> = new Map();

function isEditableLayer(
  layer: { readonly visible: boolean; readonly locked: boolean } | undefined,
): boolean {
  return Boolean(layer?.visible && !layer.locked);
}

type PointerState = {
  readonly pointerId: number;
  readonly mode: SceneMode;
  readonly start: MapScenePoint;
  readonly points: MapScenePoint[];
  readonly selectedId: string | null;
  readonly regionKind?: MapSceneRegion["kind"];
  readonly vertexIndex?: number;
  readonly sourcePoints?: readonly MapScenePoint[];
  readonly sourceStamp?: MapArtworkStampTransform;
  readonly selectionIds?: readonly string[];
  readonly additiveSelection?: boolean;
  lastScreen?: MapScenePoint;
  last: MapScenePoint;
};

export type MapScenePreviewBounds = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

/**
 * 计算交互预览期间的临时世界范围。
 *
 * 这不是 MapDocument 的事实边界，只让当前笔触/拖动在越过旧边界时仍能
 * 被看见。手势提交后仍由 mapCanvasBounds 统一计算并持久化真实尺寸。
 */
export function getMapScenePreviewBounds(
  document: MapDocument,
  points: readonly MapScenePoint[],
  extension = 160,
): MapScenePreviewBounds {
  const safeExtension = Math.max(
    32,
    Number.isFinite(extension) ? Math.round(extension) : 160,
  );
  let left = 0;
  let right = document.canvas.width;
  let top = 0;
  let bottom = document.canvas.height;
  points.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (point.x < 0) left = Math.min(left, Math.floor(point.x - safeExtension));
    if (point.x > document.canvas.width)
      right = Math.max(right, Math.ceil(point.x + safeExtension));
    if (point.y < 0) top = Math.min(top, Math.floor(point.y - safeExtension));
    if (point.y > document.canvas.height)
      bottom = Math.max(bottom, Math.ceil(point.y + safeExtension));
  });
  return { left, right, top, bottom };
}

function pointerPreviewPoints(pointer: PointerState | null): MapScenePoint[] {
  if (!pointer) return [];
  const points = [...pointer.points, pointer.start, pointer.last];
  if (pointer.sourcePoints && pointer.sourcePoints.length > 0) {
    const delta = {
      x: pointer.last.x - pointer.start.x,
      y: pointer.last.y - pointer.start.y,
    };
    points.push(
      ...pointer.sourcePoints.map((point) => ({
        x: point.x + delta.x,
        y: point.y + delta.y,
      })),
    );
  }
  if (pointer.sourceStamp) {
    points.push({ x: pointer.last.x, y: pointer.last.y });
  }
  return points;
}

interface MapSceneCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly settings?: MapCanvasSettings;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  readonly selectedFeatureIds?: readonly string[];
  readonly focusRequest?: number;
  /** 文档因左上扩展产生的坐标平移，用于一次性补偿本地相机。 */
  readonly documentRebase?: {
    readonly revision: number;
    readonly translation: MapScenePoint;
  } | null;
  readonly timelineCursor: number | null;
  readonly artworkBrushAssetId?: string | null;
  readonly artworkBrushColor?: string | null;
  readonly artworkBrushLayerKind?: MapSceneLayerKind;
  readonly activeStampAssetId?: string | null;
  /** 当前点击后可直接落图的预制件（海陆区域或路径组件）。 */
  readonly activePrefabComponentId?: string | null;
  readonly activeTerrainMaterial?: MapTerrainMaterial | null;
  /** 已解析的项目素材 URL；源文件本身仍保存在工作区 assets 目录。 */
  readonly projectArtworkSources?: ReadonlyMap<string, string>;
  readonly onSelect: (featureId: string | null) => void;
  readonly onSelectionChange?: (
    featureIds: readonly string[],
    primaryFeatureId: string | null,
  ) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onComponentDrop: (
    componentId: string,
    point: MapScenePoint,
    gesture?: MapComponentPlacementGesture,
  ) => void;
  readonly onSceneStroke: (
    assetId: string,
    points: readonly MapScenePoint[],
  ) => void;
  readonly onSceneErase: (points: readonly MapScenePoint[]) => void;
  readonly onTerrainStroke: (
    kind: MapSceneRegion["kind"],
    points: readonly MapScenePoint[],
  ) => void;
  readonly onTerrainMaterialStroke: (
    material: MapTerrainMaterial,
    points: readonly MapScenePoint[],
  ) => void;
  readonly onSceneStrokeMove: (
    strokeId: string,
    points: readonly MapScenePoint[],
  ) => void;
  readonly onSceneRegionCreate: (
    kind: MapSceneRegion["kind"],
    points: readonly MapScenePoint[],
  ) => void;
  readonly onSceneRegionMove: (
    regionId: string,
    points: readonly MapScenePoint[],
  ) => void;
  readonly onArtworkStampMove: (stampId: string, point: MapScenePoint) => void;
  readonly onArtworkStampTransform: (
    stampId: string,
    patch: Pick<MapArtworkStamp, "rotation" | "scale">,
  ) => void;
  readonly onArtworkStampPlace: (
    assetId: string,
    point: MapScenePoint,
    gesture?: MapArtworkStampPlacementGesture,
  ) => void;
  readonly onGeometryChange: (
    featureId: string,
    points: MapFeature["points"],
    props?: MapFeature["props"],
  ) => void;
  readonly onBatchMove?: (
    featureIds: readonly string[],
    delta: MapScenePoint,
  ) => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function drawMapSceneWorldGrid(
  context: CanvasRenderingContext2D,
  camera: MapSceneCamera,
  worldWidth: number,
  worldHeight: number,
  worldLeft: number,
  worldTop: number,
  visibleWorld: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
): void {
  const smallestVisibleStep = 14;
  const baseStep = 32;
  const step =
    baseStep *
    Math.max(1, Math.ceil(smallestVisibleStep / (baseStep * camera.zoom)));
  const firstX = Math.floor(visibleWorld.left / step) * step;
  const firstY = Math.floor(visibleWorld.top / step) * step;
  context.save();
  context.beginPath();
  context.rect(
    camera.x + worldLeft * camera.zoom,
    camera.y + worldTop * camera.zoom,
    worldWidth * camera.zoom,
    worldHeight * camera.zoom,
  );
  context.clip();
  context.strokeStyle = "#685f5224";
  context.lineWidth = 1;
  for (let x = firstX; x <= visibleWorld.right; x += step) {
    const screenX = camera.x + x * camera.zoom;
    context.beginPath();
    context.moveTo(screenX, camera.y + worldTop * camera.zoom);
    context.lineTo(screenX, camera.y + (worldTop + worldHeight) * camera.zoom);
    context.stroke();
  }
  for (let y = firstY; y <= visibleWorld.bottom; y += step) {
    const screenY = camera.y + y * camera.zoom;
    context.beginPath();
    context.moveTo(camera.x + worldLeft * camera.zoom, screenY);
    context.lineTo(camera.x + (worldLeft + worldWidth) * camera.zoom, screenY);
    context.stroke();
  }
  context.restore();
}

function snapPoint(
  point: MapScenePoint,
  settings: MapCanvasSettings,
): MapScenePoint {
  if (!settings.snapEnabled) return point;
  const grid = Math.max(1, settings.snapGrid);
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  };
}

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
  const ratio = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    0,
    1,
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

function canvasToMapPoint(
  point: MapScenePoint,
  camera: MapSceneCamera,
): MapScenePoint {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

function regionBounds(points: readonly MapScenePoint[]): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} {
  return points.reduce(
    (bounds, point) => ({
      left: Math.min(bounds.left, point.x),
      right: Math.max(bounds.right, point.x),
      top: Math.min(bounds.top, point.y),
      bottom: Math.max(bounds.bottom, point.y),
    }),
    {
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
}

function extendSceneBounds(
  current: MapSceneBounds | null,
  points: readonly MapScenePoint[],
  radius = 0,
): MapSceneBounds | null {
  if (points.length === 0) return current;
  const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const bounds = regionBounds(points);
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.bottom)
  ) {
    return current;
  }
  const next = {
    left: bounds.left - safeRadius,
    right: bounds.right + safeRadius,
    top: bounds.top - safeRadius,
    bottom: bounds.bottom + safeRadius,
  };
  return current
    ? {
        left: Math.min(current.left, next.left),
        right: Math.max(current.right, next.right),
        top: Math.min(current.top, next.top),
        bottom: Math.max(current.bottom, next.bottom),
      }
    : next;
}

function stampFocusRadius(
  stamp: MapArtworkStamp,
  assets: MapArtworkAssetCatalog,
): number {
  const asset = assets.get(stamp.assetId);
  if (!asset) return 48 * Math.max(0.05, Math.min(20, stamp.scale));
  const size = mapArtworkStampRenderSize(
    stamp,
    getMapArtworkAssetVariant(asset, stamp.variant),
  );
  // 旋转不会影响外接圆，因此无需额外保存转换后的四角。
  return Math.hypot(size.width, size.height) / 2;
}

/**
 * 计算“聚焦内容”要使用的视觉范围。选中对象存在时只聚焦选区；否则聚焦
 * 所有可见地图内容。结果只服务相机，绝不回写 MapDocument。
 */
export function getMapSceneFocusBounds(
  document: MapDocument,
  selectedIds: readonly string[] = [],
  assets: MapArtworkAssetCatalog = createMapArtworkAssetCatalog(
    document.artwork,
  ),
): MapSceneBounds | null {
  const selection = new Set(selectedIds.filter(Boolean));
  const selectionOnly = selection.size > 0;
  const includes = (id: string) => !selectionOnly || selection.has(id);
  let bounds: MapSceneBounds | null = null;

  document.features.forEach((feature) => {
    const layer = document.layers.find((item) => item.id === feature.layerId);
    if (!layer?.visible || !includes(feature.id)) return;
    const lineWidth = Number.parseFloat(feature.props.lineWidth ?? "0");
    const radius =
      feature.points.length === 1
        ? Math.max(28, Number.isFinite(lineWidth) ? lineWidth * 2 : 0)
        : Math.max(2, Number.isFinite(lineWidth) ? lineWidth / 2 : 0);
    bounds = extendSceneBounds(bounds, feature.points, radius);
  });

  document.artwork.layers.forEach((layer) => {
    if (!layer.visible) return;
    layer.stamps.forEach((stamp) => {
      if (!includes(stamp.id)) return;
      bounds = extendSceneBounds(
        bounds,
        [stamp],
        stampFocusRadius(stamp, assets),
      );
    });
  });

  document.scene?.layers.forEach((layer) => {
    if (!layer.visible) return;
    layer.regions.forEach((region) => {
      if (!includes(region.id)) return;
      bounds = extendSceneBounds(bounds, region.points, region.edgeWidth / 2);
    });
    layer.strokes.forEach((stroke) => {
      if (!includes(stroke.id)) return;
      bounds = extendSceneBounds(bounds, stroke.points, stroke.width / 2);
    });
  });

  return bounds;
}

/** 将缩略导航的屏幕落点转换为地图世界坐标，自动处理非等比留白。 */
export function mapSceneNavigatorPointAt(
  document: MapDocument,
  navigator: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  point: { readonly x: number; readonly y: number },
): MapScenePoint | null {
  if (
    !Number.isFinite(navigator.width) ||
    !Number.isFinite(navigator.height) ||
    navigator.width <= 0 ||
    navigator.height <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    navigator.width / document.canvas.width,
    navigator.height / document.canvas.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = (navigator.width - document.canvas.width * scale) / 2;
  const offsetY = (navigator.height - document.canvas.height * scale) / 2;
  const normalizeEdge = (value: number, maximum: number) => {
    const clamped = clamp(value, 0, maximum);
    if (clamped <= 0.000001) return 0;
    if (clamped >= maximum - 0.000001) return maximum;
    return clamped;
  };
  return {
    x: normalizeEdge(
      (point.x - navigator.left - offsetX) / scale,
      document.canvas.width,
    ),
    y: normalizeEdge(
      (point.y - navigator.top - offsetY) / scale,
      document.canvas.height,
    ),
  };
}

function renderMapSceneNavigator(
  canvas: HTMLCanvasElement,
  document: MapDocument,
  terrainComposite: ReturnType<typeof createMapTerrainComposite>,
  camera: MapSceneCamera,
  viewport: { readonly width: number; readonly height: number },
): void {
  const bounds = canvas.getBoundingClientRect();
  const width = Number.isFinite(bounds.width) ? Math.round(bounds.width) : 0;
  const height = Number.isFinite(bounds.height) ? Math.round(bounds.height) : 0;
  if (width <= 0 || height <= 0) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * pixelRatio));
  const pixelHeight = Math.max(1, Math.round(height * pixelRatio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  const mapWidth = Math.max(1, document.canvas.width);
  const mapHeight = Math.max(1, document.canvas.height);
  const scale = Math.min(width / mapWidth, height / mapHeight);
  const offsetX = (width - mapWidth * scale) / 2;
  const offsetY = (height - mapHeight * scale) / 2;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fffaf1";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  drawMapSceneBackgroundSlice(context, document, {
    x: 0,
    y: 0,
    width: mapWidth,
    height: mapHeight,
    worldWidth: mapWidth,
    worldHeight: mapHeight,
  });
  if (terrainComposite) {
    context.globalAlpha = 0.98;
    context.drawImage(
      terrainComposite.canvas,
      0,
      0,
      terrainComposite.worldWidth,
      terrainComposite.worldHeight,
    );
  }

  document.features.forEach((feature) => {
    const layer = document.layers.find((item) => item.id === feature.layerId);
    if (!layer?.visible || feature.points.length === 0) return;
    context.globalAlpha = Math.max(0.2, Math.min(1, layer.opacity));
    context.strokeStyle = feature.props.color ?? "#6f5944";
    context.fillStyle = feature.props.fill ?? feature.props.color ?? "#6f5944";
    context.lineWidth = Math.max(3, Number(feature.props.lineWidth ?? 2));
    context.beginPath();
    const first = feature.points[0]!;
    context.moveTo(first.x, first.y);
    feature.points
      .slice(1)
      .forEach((point) => context.lineTo(point.x, point.y));
    if (feature.kind === "polygon" || feature.kind === "area") {
      context.closePath();
      context.globalAlpha *= 0.42;
      context.fill();
    }
    if (feature.points.length > 1) context.stroke();
    if (feature.points.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, 12, 0, Math.PI * 2);
      context.fill();
    }
  });

  document.artwork.layers.forEach((layer) => {
    if (!layer.visible || layer.opacity <= 0) return;
    context.globalAlpha = Math.max(0.25, Math.min(1, layer.opacity));
    layer.stamps.forEach((stamp) => {
      context.fillStyle = "#9a4e38";
      context.beginPath();
      context.arc(
        stamp.x,
        stamp.y,
        Math.max(8, 14 * stamp.scale),
        0,
        Math.PI * 2,
      );
      context.fill();
    });
  });

  context.globalAlpha = 0.88;
  context.strokeStyle = "#c75436";
  context.lineWidth = Math.max(4, 2 / scale);
  const visibleLeft = Math.max(0, Math.min(mapWidth, -camera.x / camera.zoom));
  const visibleTop = Math.max(0, Math.min(mapHeight, -camera.y / camera.zoom));
  const visibleRight = Math.max(
    visibleLeft,
    Math.min(mapWidth, (viewport.width - camera.x) / camera.zoom),
  );
  const visibleBottom = Math.max(
    visibleTop,
    Math.min(mapHeight, (viewport.height - camera.y) / camera.zoom),
  );
  context.strokeRect(
    visibleLeft,
    visibleTop,
    Math.max(1, visibleRight - visibleLeft),
    Math.max(1, visibleBottom - visibleTop),
  );
  context.globalAlpha = 1;
  context.strokeStyle = "#746b60a8";
  context.lineWidth = Math.max(1, 1 / scale);
  context.strokeRect(0, 0, mapWidth, mapHeight);
  context.restore();
}

function drawFeatureVertexHandles(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  camera: MapSceneCamera,
): void {
  if (points.length < 2) return;
  const size = 8;
  context.save();
  context.globalAlpha = 0.98;
  context.fillStyle = "#fffaf1";
  context.strokeStyle = "#c75436";
  context.lineWidth = 1.5;
  points.forEach((point) => {
    const target = mapToCanvasPoint(point, camera);
    context.fillRect(target.x - size / 2, target.y - size / 2, size, size);
    context.strokeRect(target.x - size / 2, target.y - size / 2, size, size);
  });
  context.restore();
}

function drawMapFeatureSelectionOutline(
  context: CanvasRenderingContext2D,
  feature: MapFeature,
  points: readonly MapScenePoint[],
  camera: MapSceneCamera,
): void {
  if (points.length === 0) return;
  context.save();
  context.strokeStyle = "#c75436";
  context.lineWidth = 2;
  context.setLineDash([6, 4]);
  context.beginPath();
  if (points.length === 1) {
    const point = mapToCanvasPoint(points[0]!, camera);
    context.arc(point.x, point.y, 16, 0, Math.PI * 2);
  } else {
    drawPath(context, points, camera);
    if (feature.kind === "polygon" || feature.kind === "area") {
      context.closePath();
    }
  }
  context.stroke();
  context.restore();
}

function seedFromId(id: string): number {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed * 31 + id.charCodeAt(index)) >>> 0;
  }
  return seed;
}

function drawRegionSelectionOverlay(
  context: CanvasRenderingContext2D,
  region: MapSceneRegion,
  points: readonly MapScenePoint[],
  camera: MapSceneCamera,
  layerOpacity: number,
  selected: boolean,
): void {
  if (points.length < 3) return;
  const opacity = layerOpacity * region.opacity;
  const bounds = regionBounds(points);
  const seed = seedFromId(region.id);

  context.save();
  context.globalAlpha = opacity;
  drawMapSceneRegionPath(context, points, camera);
  context.fillStyle = region.fill;
  context.fill();
  context.clip();

  if (region.texture === "paper-land") {
    const step = 34;
    context.globalAlpha = opacity * 0.18;
    context.fillStyle = "#fff6d6";
    for (
      let y = Math.floor(bounds.top / step) * step + (seed % 11);
      y <= bounds.bottom + step;
      y += step
    ) {
      for (
        let x = Math.floor(bounds.left / step) * step + ((seed >>> 5) % 19);
        x <= bounds.right + step;
        x += step
      ) {
        const point = mapToCanvasPoint(
          {
            x: x + ((Math.floor(y / step) * 13 + seed) % 9),
            y: y + ((Math.floor(x / step) * 7 + seed) % 7),
          },
          camera,
        );
        context.fillRect(
          point.x,
          point.y,
          Math.max(1, camera.zoom),
          Math.max(1, camera.zoom),
        );
      }
    }
    context.globalAlpha = opacity * 0.12;
    context.strokeStyle = "#6d6246";
    context.lineWidth = Math.max(0.5, camera.zoom * 0.7);
    for (
      let y = Math.floor(bounds.top / 52) * 52 + (seed % 17);
      y <= bounds.bottom + 52;
      y += 52
    ) {
      context.beginPath();
      for (
        let x = Math.floor(bounds.left / 78) * 78;
        x <= bounds.right + 78;
        x += 78
      ) {
        const start = mapToCanvasPoint({ x: x + 12, y }, camera);
        context.moveTo(start.x, start.y);
        context.lineTo(start.x + 14 * camera.zoom, start.y - 2 * camera.zoom);
      }
      context.stroke();
    }
  } else {
    const verticalStep = 36;
    const horizontalStep = 56;
    context.globalAlpha = opacity * 0.3;
    context.strokeStyle = "#edf6ed";
    context.lineWidth = Math.max(0.75, camera.zoom);
    for (
      let y =
        Math.floor(bounds.top / verticalStep) * verticalStep + (seed % 13);
      y <= bounds.bottom + verticalStep;
      y += verticalStep
    ) {
      context.beginPath();
      for (
        let x = Math.floor(bounds.left / horizontalStep) * horizontalStep;
        x <= bounds.right + horizontalStep;
        x += horizontalStep
      ) {
        const start = mapToCanvasPoint({ x: x + 8, y }, camera);
        context.moveTo(start.x, start.y);
        context.quadraticCurveTo(
          start.x + 10 * camera.zoom,
          start.y - 4 * camera.zoom,
          start.x + 21 * camera.zoom,
          start.y,
        );
      }
      context.stroke();
    }
  }
  context.restore();

  context.save();
  context.globalAlpha = opacity;
  drawMapSceneRegionPath(context, points, camera);
  context.strokeStyle = region.edgeColor;
  context.lineWidth = Math.max(1, region.edgeWidth * camera.zoom);
  context.lineJoin = "round";
  context.stroke();
  if (selected) {
    context.globalAlpha = 0.95;
    context.strokeStyle = "#c75436";
    context.lineWidth = Math.max(2, 2.5 * camera.zoom);
    context.setLineDash([7, 4]);
    context.stroke();
  }
  context.restore();
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

function getArtworkVariantImage(
  cache: Map<string, HTMLImageElement>,
  variant: MapArtworkAssetVariant,
  requestRender: () => void,
): HTMLImageElement | null {
  const cached = cache.get(variant.cacheKey);
  if (cached) {
    return cached.complete && cached.naturalWidth > 0 ? cached : null;
  }
  const image = new Image();
  image.src = variant.imageSrc;
  image.onload = requestRender;
  cache.set(variant.cacheKey, image);
  return null;
}

function getCachedImage(
  cache: Map<string, HTMLImageElement>,
  cacheKey: string,
  source: string,
  requestRender: () => void,
): HTMLImageElement | null {
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.complete && cached.naturalWidth > 0 ? cached : null;
  }
  const image = new Image();
  image.src = source;
  image.onload = requestRender;
  cache.set(cacheKey, image);
  return null;
}

function drawSelectionOutline(
  context: CanvasRenderingContext2D,
  bounds: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
  camera: MapSceneCamera,
): void {
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.bottom)
  ) {
    return;
  }
  const topLeft = mapToCanvasPoint({ x: bounds.left, y: bounds.top }, camera);
  const bottomRight = mapToCanvasPoint(
    { x: bounds.right, y: bounds.bottom },
    camera,
  );
  const left = Math.min(topLeft.x, bottomRight.x);
  const top = Math.min(topLeft.y, bottomRight.y);
  const width = Math.max(16, Math.abs(bottomRight.x - topLeft.x));
  const height = Math.max(16, Math.abs(bottomRight.y - topLeft.y));
  context.save();
  context.globalAlpha = 0.95;
  context.strokeStyle = "#c75436";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.strokeRect(left, top, width, height);
  context.restore();
}

function drawArtworkStampTransform(
  context: CanvasRenderingContext2D,
  stamp: MapArtworkStampTransform,
  size: MapArtworkStampSize,
  camera: MapSceneCamera,
): void {
  const handles = mapArtworkTransformHandles(stamp, size, camera.zoom);
  const corners = handles
    .filter((handle) => handle.id !== "rotate")
    .map((handle) => mapToCanvasPoint(handle.point, camera));
  const rotateHandle = handles.find((handle) => handle.id === "rotate");
  if (corners.length !== 4 || !rotateHandle) return;
  const rotatePoint = mapToCanvasPoint(rotateHandle.point, camera);
  const topMidpoint = {
    x: (corners[0]!.x + corners[1]!.x) / 2,
    y: (corners[0]!.y + corners[1]!.y) / 2,
  };
  const handleSize = 8;

  context.save();
  context.globalAlpha = 0.96;
  context.strokeStyle = "#c75436";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(corners[0]!.x, corners[0]!.y);
  corners.slice(1).forEach((point) => context.lineTo(point.x, point.y));
  context.closePath();
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(topMidpoint.x, topMidpoint.y);
  context.lineTo(rotatePoint.x, rotatePoint.y);
  context.stroke();
  context.fillStyle = "#fffaf1";
  corners.forEach((point) => {
    context.fillRect(
      point.x - handleSize / 2,
      point.y - handleSize / 2,
      handleSize,
      handleSize,
    );
    context.strokeRect(
      point.x - handleSize / 2,
      point.y - handleSize / 2,
      handleSize,
      handleSize,
    );
  });
  context.beginPath();
  context.arc(rotatePoint.x, rotatePoint.y, 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export default function MapSceneCanvas({
  document,
  tool,
  settings = DEFAULT_MAP_CANVAS_SETTINGS,
  activeLayerId,
  selectedFeatureId,
  selectedFeatureIds = [],
  focusRequest = 0,
  documentRebase = null,
  timelineCursor,
  artworkBrushAssetId = null,
  artworkBrushColor = null,
  artworkBrushLayerKind = "vegetation",
  activeStampAssetId = null,
  activePrefabComponentId = null,
  activeTerrainMaterial = null,
  projectArtworkSources = EMPTY_PROJECT_ARTWORK_SOURCES,
  onSelect,
  onSelectionChange,
  onCreate,
  onComponentDrop,
  onSceneStroke,
  onSceneErase,
  onTerrainStroke,
  onTerrainMaterialStroke,
  onSceneStrokeMove,
  onSceneRegionCreate,
  onSceneRegionMove,
  onArtworkStampMove,
  onArtworkStampTransform,
  onArtworkStampPlace,
  onGeometryChange,
  onBatchMove,
}: MapSceneCanvasProps) {
  const toast = useToastOptional();
  const [isExporting, setIsExporting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigatorCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MapSceneCamera>({
    x: 0,
    y: 0,
    zoom: 1,
    fitted: false,
  });
  const pointerRef = useRef<PointerState | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const assetCatalogRef = useRef(
    createMapArtworkAssetCatalog(document.artwork, projectArtworkSources),
  );
  const terrainCompositeRef = useRef<{
    readonly scene: MapDocument["scene"];
    readonly width: number;
    readonly height: number;
    readonly composite: ReturnType<typeof createMapTerrainComposite>;
  } | null>(null);
  const documentRef = useRef(document);
  const selectedIdRef = useRef(selectedFeatureId);
  const selectedIdsRef = useRef<ReadonlySet<string>>(
    new Set(
      selectedFeatureIds.length > 0
        ? selectedFeatureIds
        : [selectedFeatureId].filter((id): id is string => Boolean(id)),
    ),
  );
  const toolRef = useRef(tool);
  const brushAssetRef = useRef(artworkBrushAssetId);
  const brushColorRef = useRef(artworkBrushColor);
  const brushLayerKindRef = useRef<MapSceneLayerKind>(artworkBrushLayerKind);
  const stampAssetRef = useRef(activeStampAssetId);
  const prefabComponentIdRef = useRef(activePrefabComponentId);
  const terrainMaterialRef = useRef(activeTerrainMaterial);
  const settingsRef = useRef(settings);
  const spacePressedRef = useRef(false);
  const hoverPointRef = useRef<MapScenePoint | null>(null);
  const requestFrameRef = useRef<number | null>(null);
  const edgeAutoPanFrameRef = useRef<number | null>(null);
  const renderRequestRef = useRef<() => void>(() => undefined);
  const appliedDocumentRebaseRevisionRef = useRef(0);
  const lastFocusRequestRef = useRef(focusRequest);
  const pendingFocusRef = useRef(false);
  const navigatorPointerRef = useRef<number | null>(null);

  useEffect(() => {
    documentRef.current = document;
    selectedIdRef.current = selectedFeatureId;
    selectedIdsRef.current = new Set(
      selectedFeatureIds.length > 0
        ? selectedFeatureIds
        : [selectedFeatureId].filter((id): id is string => Boolean(id)),
    );
    toolRef.current = tool;
    brushAssetRef.current = artworkBrushAssetId;
    brushColorRef.current = artworkBrushColor;
    brushLayerKindRef.current = artworkBrushLayerKind;
    stampAssetRef.current = activeStampAssetId;
    prefabComponentIdRef.current = activePrefabComponentId;
    terrainMaterialRef.current = activeTerrainMaterial;
    settingsRef.current = settings;
  }, [
    activeStampAssetId,
    activePrefabComponentId,
    activeTerrainMaterial,
    artworkBrushAssetId,
    artworkBrushColor,
    artworkBrushLayerKind,
    document,
    selectedFeatureId,
    selectedFeatureIds,
    settings,
    tool,
  ]);

  const requestRender = useCallback(() => {
    if (requestFrameRef.current !== null) return;
    requestFrameRef.current = window.requestAnimationFrame(() => {
      requestFrameRef.current = null;
      const canvas = canvasRef.current;
      const root = rootRef.current;
      if (!canvas || !root) return;
      const bounds = root.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      if (canvas.width !== Math.round(width * pixelRatio)) {
        canvas.width = Math.round(width * pixelRatio);
      }
      if (canvas.height !== Math.round(height * pixelRatio)) {
        canvas.height = Math.round(height * pixelRatio);
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      const currentDocument = documentRef.current;
      const camera = cameraRef.current;
      if (!camera.fitted || camera.zoom <= 0) {
        const focusedBounds = pendingFocusRef.current
          ? getMapSceneFocusBounds(
              currentDocument,
              [...selectedIdsRef.current],
              assetCatalogRef.current,
            )
          : null;
        if (focusedBounds) {
          Object.assign(
            camera,
            fitMapSceneCameraToBounds(
              camera,
              focusedBounds,
              { width, height },
              48,
            ),
          );
        } else {
          camera.zoom = Math.min(
            (width - 36) / currentDocument.canvas.width,
            (height - 36) / currentDocument.canvas.height,
          );
          camera.zoom = clamp(camera.zoom, 0.08, 8);
          camera.x = (width - currentDocument.canvas.width * camera.zoom) / 2;
          camera.y = (height - currentDocument.canvas.height * camera.zoom) / 2;
          camera.fitted = true;
        }
        pendingFocusRef.current = false;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const scene = currentDocument.scene;
      const canvasSettings = settingsRef.current;
      const previewPoints = pointerPreviewPoints(pointerRef.current);
      const stampPlacementPointer = pointerRef.current;
      const stampPlacementAnchor =
        stampPlacementPointer?.mode === "place-stamp"
          ? stampPlacementPointer.last
          : toolRef.current === "artwork-stamp" && stampAssetRef.current
            ? hoverPointRef.current
            : null;
      if (stampPlacementAnchor && stampAssetRef.current) {
        const placementAsset = assetCatalogRef.current.get(
          stampAssetRef.current,
        );
        if (placementAsset) {
          const placementVariant = getMapArtworkAssetVariant(placementAsset, 0);
          const placementGesture =
            stampPlacementPointer?.mode === "place-stamp" &&
            distance(stampPlacementPointer.start, stampPlacementPointer.last) >=
              8
              ? {
                  start: stampPlacementPointer.start,
                  end: snapPoint(stampPlacementPointer.last, canvasSettings),
                }
              : undefined;
          const placementTransform = mapArtworkStampPlacementTransform({
            anchor: snapPoint(stampPlacementAnchor, canvasSettings),
            defaultScale: canvasSettings.stampScale,
            variant: placementVariant,
            gesture: placementGesture,
          });
          const placementSize = mapArtworkStampRenderSize(
            placementTransform,
            placementVariant,
          );
          const previewHandles = mapArtworkTransformHandles(
            placementTransform,
            placementSize,
            1,
          );
          previewPoints.push(
            ...previewHandles.slice(0, 4).map((handle) => handle.point),
          );
        }
      }
      const previewBounds = getMapScenePreviewBounds(
        currentDocument,
        previewPoints,
        Math.max(160, canvasSettings.brushSize * 0.65),
      );
      // 编辑视图本身是连续工作区，而不是被当前导出尺寸裁切的一块画板。
      // 预览内容或相机进入原有边界之外时，背景会立即覆盖到那里；确认手势
      // 后，父级再以 MapDocument 为唯一事实源扩展实际导出尺寸。
      const visibleWorldLeftFromCamera = -camera.x / camera.zoom;
      const visibleWorldTopFromCamera = -camera.y / camera.zoom;
      const visibleWorldRightFromCamera = (width - camera.x) / camera.zoom;
      const visibleWorldBottomFromCamera = (height - camera.y) / camera.zoom;
      const worldLeft = Math.min(
        previewBounds.left,
        visibleWorldLeftFromCamera,
      );
      const worldTop = Math.min(previewBounds.top, visibleWorldTopFromCamera);
      const worldRight = Math.max(
        worldLeft + 1,
        previewBounds.right,
        visibleWorldRightFromCamera,
      );
      const worldBottom = Math.max(
        worldTop + 1,
        previewBounds.bottom,
        visibleWorldBottomFromCamera,
      );
      const worldWidth = Math.max(1, worldRight - worldLeft);
      const worldHeight = Math.max(1, worldBottom - worldTop);
      const visibleWorldLeft = visibleWorldLeftFromCamera;
      const visibleWorldTop = visibleWorldTopFromCamera;
      const visibleWorldRight = visibleWorldRightFromCamera;
      const visibleWorldBottom = visibleWorldBottomFromCamera;
      context.save();
      context.translate(camera.x, camera.y);
      context.scale(camera.zoom, camera.zoom);
      drawMapSceneBackgroundSlice(context, currentDocument, {
        x: visibleWorldLeft,
        y: visibleWorldTop,
        width: visibleWorldRight - visibleWorldLeft,
        height: visibleWorldBottom - visibleWorldTop,
        // 使用持久化尺寸锚定纹理，而不是随平移变化的可见窗口，避免海浪、
        // 颗粒和渐变在相机移动时发生跳变。
        worldWidth: currentDocument.canvas.width,
        worldHeight: currentDocument.canvas.height,
      });
      const backgroundImageSource = currentDocument.canvas.backgroundImage;
      if (backgroundImageSource) {
        const image = getCachedImage(
          imageCacheRef.current,
          `background:${backgroundImageSource}`,
          backgroundImageSource,
          () => renderRequestRef.current(),
        );
        if (image) {
          const backgroundPlacement = getMapBackgroundImagePlacement(
            currentDocument.canvas,
            image.naturalWidth,
            image.naturalHeight,
          );
          drawContainedMapBackgroundImage(
            context,
            image,
            image.naturalWidth,
            image.naturalHeight,
            currentDocument.canvas.width,
            currentDocument.canvas.height,
            currentDocument.canvas.backgroundOpacity ?? 1,
            backgroundPlacement,
          );
        }
      }
      context.restore();
      if (currentDocument.canvas.showGrid) {
        drawMapSceneWorldGrid(
          context,
          camera,
          worldWidth,
          worldHeight,
          worldLeft,
          worldTop,
          {
            left: visibleWorldLeft,
            right: visibleWorldRight,
            top: visibleWorldTop,
            bottom: visibleWorldBottom,
          },
        );
      }
      const previewSelectionDelta = (itemId: string): MapScenePoint | null => {
        const pointer = pointerRef.current;
        if (
          pointer?.mode !== "move-selection" ||
          !pointer.selectionIds?.includes(itemId)
        ) {
          return null;
        }
        const snappedPointer = snapPoint(pointer.last, canvasSettings);
        return {
          x: snappedPointer.x - pointer.start.x,
          y: snappedPointer.y - pointer.start.y,
        };
      };
      const stampTransformForRender = (
        stamp: MapArtworkStamp,
      ): MapArtworkStampTransform => {
        const pointer = pointerRef.current;
        const selectionDelta = previewSelectionDelta(stamp.id);
        if (selectionDelta) {
          return {
            x: stamp.x + selectionDelta.x,
            y: stamp.y + selectionDelta.y,
            scale: stamp.scale,
            rotation: stamp.rotation,
          };
        }
        if (!pointer || pointer.selectedId !== stamp.id) return stamp;
        if (pointer.mode === "move-stamp") {
          const point = snapPoint(pointer.last, canvasSettings);
          return {
            x: point.x,
            y: point.y,
            scale: stamp.scale,
            rotation: stamp.rotation,
          };
        }
        if (!pointer.sourceStamp) return stamp;
        if (pointer.mode === "scale-stamp") {
          return {
            ...pointer.sourceStamp,
            scale: scaleMapArtworkStampFromPointer(
              pointer.sourceStamp,
              pointer.start,
              pointer.last,
            ),
          };
        }
        if (pointer.mode === "rotate-stamp") {
          return {
            ...pointer.sourceStamp,
            rotation: rotateMapArtworkStampFromPointer(
              pointer.sourceStamp,
              pointer.start,
              pointer.last,
            ),
          };
        }
        return stamp;
      };
      const drawArtworkStampsForPhase = (phase: MapArtworkRenderPhase) => {
        mapArtworkLayersInRenderOrder(currentDocument.artwork, phase).forEach(
          (layer) => {
            if (!layer.visible || layer.opacity <= 0) return;
            layer.stamps.forEach((stamp) => {
              const asset = assetCatalogRef.current.get(stamp.assetId);
              if (!asset) return;
              const variant = getMapArtworkAssetVariant(asset, stamp.variant);
              const image = getArtworkVariantImage(
                imageCacheRef.current,
                variant,
                () => renderRequestRef.current(),
              );
              if (!image) return;
              const stampTransform = stampTransformForRender(stamp);
              const size = mapArtworkStampRenderSize(stampTransform, variant);
              drawImageAsset(
                context,
                image,
                stampTransform,
                camera,
                size.width,
                size.height,
                (stampTransform.rotation * Math.PI) / 180,
                layer.opacity * stamp.opacity,
                stamp.flipX,
                stamp.flipY,
              );
            });
          },
        );
      };
      const cachedTerrain = terrainCompositeRef.current;
      if (
        !cachedTerrain ||
        cachedTerrain.scene !== scene ||
        cachedTerrain.width !== currentDocument.canvas.width ||
        cachedTerrain.height !== currentDocument.canvas.height
      ) {
        terrainCompositeRef.current = {
          scene,
          width: currentDocument.canvas.width,
          height: currentDocument.canvas.height,
          composite: createMapTerrainComposite(currentDocument),
        };
      }
      const terrainComposite = terrainCompositeRef.current?.composite ?? null;
      if (terrainComposite) {
        context.save();
        context.imageSmoothingEnabled = true;
        context.drawImage(
          terrainComposite.canvas,
          camera.x,
          camera.y,
          terrainComposite.worldWidth * camera.zoom,
          terrainComposite.worldHeight * camera.zoom,
        );
        context.restore();
      }
      drawArtworkStampsForPhase("base");
      if (scene) {
        // 先合成连续海陆底稿，再叠加山脉、森林、河流等局部笔触。
        scene.layers.forEach((layer) => {
          if (!layer.visible || layer.opacity <= 0) return;
          layer.regions.forEach((region) => {
            const pointer = pointerRef.current;
            const moving =
              pointer?.mode === "move-region" &&
              pointer.selectedId === region.id;
            if (
              moving ||
              region.id === selectedIdRef.current ||
              !shouldDrawMapSceneRegionEdge(region, Boolean(terrainComposite))
            ) {
              return;
            }
            drawMapSceneRegionEdge(
              context,
              region,
              region.points,
              camera,
              layer.opacity * region.opacity,
            );
          });
        });
        scene.layers.forEach((layer) => {
          if (!layer.visible || layer.opacity <= 0) return;
          layer.regions.forEach((region) => {
            const pointer = pointerRef.current;
            const isMovingRegion =
              pointer?.mode === "move-region" &&
              pointer.selectedId === region.id &&
              pointer.sourcePoints;
            const isMovingRegionVertex =
              pointer?.mode === "move-region-vertex" &&
              pointer.selectedId === region.id &&
              pointer.sourcePoints &&
              pointer.vertexIndex !== undefined;
            const snappedPointer = pointer
              ? snapPoint(pointer.last, canvasSettings)
              : null;
            const delta = isMovingRegion
              ? {
                  x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
                  y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
                }
              : null;
            const regionPoints = isMovingRegion
              ? pointer.sourcePoints.map((sourcePoint) => ({
                  x: sourcePoint.x + (delta?.x ?? 0),
                  y: sourcePoint.y + (delta?.y ?? 0),
                }))
              : isMovingRegionVertex
                ? replaceMapGeometryVertex(
                    pointer.sourcePoints,
                    pointer.vertexIndex,
                    snapPoint(pointer.last, canvasSettings),
                    currentDocument.canvas,
                  )
                : region.points;
            if (isMovingRegion || region.id === selectedIdRef.current) {
              drawRegionSelectionOverlay(
                context,
                region,
                regionPoints,
                camera,
                layer.opacity,
                Boolean(isMovingRegion || isMovingRegionVertex),
              );
              drawFeatureVertexHandles(context, regionPoints, camera);
            }
          });
        });
        scene.layers.forEach((layer) => {
          if (!layer.visible || layer.opacity <= 0) return;
          layer.strokes.forEach((stroke) => {
            const isTerrainCompositeStroke =
              isMapTerrainMaskStroke(layer.kind, stroke) ||
              isMapTerrainMaterialStroke(layer.kind, stroke);
            if (isTerrainCompositeStroke) {
              const pointer = pointerRef.current;
              const isMovingStroke =
                pointer?.mode === "move-stroke" &&
                pointer.selectedId === stroke.id &&
                pointer.sourcePoints;
              const isMovingStrokeControlPoint =
                pointer?.mode === "move-stroke-control-point" &&
                pointer.selectedId === stroke.id &&
                pointer.sourcePoints &&
                pointer.vertexIndex !== undefined;
              if (
                stroke.id !== selectedIdRef.current &&
                !isMovingStroke &&
                !isMovingStrokeControlPoint
              ) {
                return;
              }
              const snappedPointer = pointer
                ? snapPoint(pointer.last, canvasSettings)
                : null;
              const strokeDelta = isMovingStroke
                ? {
                    x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
                    y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
                  }
                : null;
              const strokePoints = isMovingStroke
                ? pointer.sourcePoints.map((sourcePoint) => ({
                    x: sourcePoint.x + (strokeDelta?.x ?? 0),
                    y: sourcePoint.y + (strokeDelta?.y ?? 0),
                  }))
                : isMovingStrokeControlPoint
                  ? moveMapSceneStrokeControlPoint(
                      pointer.sourcePoints,
                      pointer.vertexIndex,
                      snapPoint(pointer.last, canvasSettings),
                      currentDocument.canvas,
                    )
                  : stroke.points;
              context.save();
              context.globalCompositeOperation = "source-over";
              context.globalAlpha = 0.94;
              context.strokeStyle = stroke.terrainMaterial
                ? getMapTerrainMaterialPreset(stroke.terrainMaterial)
                    .detailColor
                : "#c75436";
              context.lineWidth = Math.max(2, 2.5 * camera.zoom);
              context.setLineDash([7, 4]);
              if (strokePoints.length === 1) {
                const point = mapToCanvasPoint(strokePoints[0]!, camera);
                context.beginPath();
                context.arc(
                  point.x,
                  point.y,
                  Math.max(10, stroke.width * camera.zoom * 0.5),
                  0,
                  Math.PI * 2,
                );
                context.stroke();
              } else {
                drawPath(context, strokePoints, camera);
                context.stroke();
              }
              context.restore();
              if (strokePoints.length > 1) {
                drawFeatureVertexHandles(
                  context,
                  mapSceneStrokeControlPoints(strokePoints),
                  camera,
                );
              }
              return;
            }
            const pointer = pointerRef.current;
            const isMovingStroke =
              pointer?.mode === "move-stroke" &&
              pointer.selectedId === stroke.id &&
              pointer.sourcePoints;
            const isMovingStrokeControlPoint =
              pointer?.mode === "move-stroke-control-point" &&
              pointer.selectedId === stroke.id &&
              pointer.sourcePoints &&
              pointer.vertexIndex !== undefined;
            const snappedPointer = pointer
              ? snapPoint(pointer.last, canvasSettings)
              : null;
            const strokeDelta = isMovingStroke
              ? {
                  x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
                  y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
                }
              : null;
            const strokePoints = isMovingStroke
              ? pointer.sourcePoints.map((sourcePoint) => ({
                  x: sourcePoint.x + (strokeDelta?.x ?? 0),
                  y: sourcePoint.y + (strokeDelta?.y ?? 0),
                }))
              : isMovingStrokeControlPoint
                ? moveMapSceneStrokeControlPoint(
                    pointer.sourcePoints,
                    pointer.vertexIndex,
                    snapPoint(pointer.last, canvasSettings),
                    currentDocument.canvas,
                  )
                : stroke.points;
            context.save();
            context.globalAlpha = layer.opacity * stroke.opacity;
            if (stroke.tool === "erase") {
              context.globalCompositeOperation = "destination-out";
            }
            const asset = stroke.brushAssetId
              ? assetCatalogRef.current.get(stroke.brushAssetId)
              : undefined;
            if (asset) {
              const clipsToLand = mapSceneLayerBrushClipsToLand(layer.kind);
              mapArtworkBrushDabs({
                id: stroke.id,
                points: strokePoints,
                width: stroke.width,
                spacing: stroke.spacing,
                scatter: stroke.scatter,
                followPath: asset.brushFollowsPath,
              }).forEach((dab) => {
                if (
                  clipsToLand &&
                  terrainComposite &&
                  !mapTerrainCompositeHasLandAt(terrainComposite, dab)
                ) {
                  return;
                }
                const variant = getMapArtworkAssetVariantWithColor(
                  asset,
                  mapArtworkVariantIndex(asset, `${stroke.id}:${dab.index}`),
                  stroke.color,
                );
                const image = getArtworkVariantImage(
                  imageCacheRef.current,
                  variant,
                  () => renderRequestRef.current(),
                );
                if (image) {
                  const size = stroke.width * dab.scale;
                  drawImageAsset(
                    context,
                    image,
                    dab,
                    camera,
                    size,
                    (size * variant.height) / variant.width,
                    dab.rotation,
                  );
                }
              });
            } else {
              context.strokeStyle = stroke.color;
              context.lineWidth = Math.max(1, stroke.width * camera.zoom);
              context.lineCap = "round";
              context.lineJoin = "round";
              if (strokePoints.length === 1) {
                const point = mapToCanvasPoint(strokePoints[0]!, camera);
                context.beginPath();
                context.arc(
                  point.x,
                  point.y,
                  Math.max(0.5, context.lineWidth / 2),
                  0,
                  Math.PI * 2,
                );
                context.fillStyle = stroke.color;
                context.fill();
              } else {
                drawPath(context, strokePoints, camera);
                context.stroke();
              }
            }
            if (stroke.id === selectedIdRef.current) {
              context.save();
              context.globalCompositeOperation = "source-over";
              context.globalAlpha = 0.9;
              context.strokeStyle = "#c75436";
              context.lineWidth = Math.max(2, 2.5 * camera.zoom);
              context.setLineDash([7, 4]);
              if (strokePoints.length === 1) {
                const point = mapToCanvasPoint(strokePoints[0]!, camera);
                context.beginPath();
                context.arc(
                  point.x,
                  point.y,
                  Math.max(10, stroke.width * camera.zoom * 0.5),
                  0,
                  Math.PI * 2,
                );
                context.stroke();
              } else {
                drawPath(context, strokePoints, camera);
                context.stroke();
              }
              context.restore();
              if (strokePoints.length > 1) {
                drawFeatureVertexHandles(
                  context,
                  mapSceneStrokeControlPoints(strokePoints),
                  camera,
                );
              }
            }
            context.restore();
          });
        });
      }

      const prefabComponentId = prefabComponentIdRef.current;
      const prefabPointer = pointerRef.current;
      const prefabAnchor =
        toolRef.current === "terrain-prefab" && prefabComponentId
          ? prefabPointer?.mode === "place-terrain-prefab"
            ? prefabPointer.last
            : hoverPointRef.current
          : null;
      if (prefabAnchor && prefabComponentId) {
        const component = MAP_COMPONENT_PRESETS.find(
          (candidate) => candidate.id === prefabComponentId,
        );
        if (component?.terrainPrefab) {
          const layerId =
            component.terrainPrefab.kind === "water"
              ? "scene-water"
              : "scene-terrain";
          createMapComponentPrefabRegions({
            component,
            id: `terrain-prefab-preview:${component.id}`,
            layerId,
            anchor: snapPoint(prefabAnchor, canvasSettings),
            canvas: currentDocument.canvas,
            gesture:
              prefabPointer?.mode === "place-terrain-prefab" &&
              distance(prefabPointer.start, prefabPointer.last) >= 8
                ? {
                    start: prefabPointer.start,
                    end: snapPoint(prefabPointer.last, canvasSettings),
                  }
                : undefined,
          }).forEach((region) => {
            drawRegionSelectionOverlay(
              context,
              region,
              region.points,
              camera,
              0.52,
              false,
            );
          });
        } else if (component) {
          const previewFeature = createMapComponentPrefabFeature({
            component,
            id: `path-prefab-preview:${component.id}`,
            layerId: activeLayerId,
            anchor: snapPoint(prefabAnchor, canvasSettings),
            canvas: currentDocument.canvas,
            gesture:
              prefabPointer?.mode === "place-terrain-prefab" &&
              distance(prefabPointer.start, prefabPointer.last) >= 8
                ? {
                    start: prefabPointer.start,
                    end: snapPoint(prefabPointer.last, canvasSettings),
                  }
                : undefined,
          });
          context.save();
          context.globalAlpha = 0.62;
          if (
            !drawMapStyledRoute(
              context,
              previewFeature,
              previewFeature.points,
              camera,
              0.62,
            )
          ) {
            context.strokeStyle = previewFeature.props.color ?? "#7c684f";
            context.lineWidth = Math.max(
              1.5,
              Number(previewFeature.props.lineWidth ?? 2) * camera.zoom,
            );
            context.lineCap = "round";
            context.lineJoin = "round";
            drawPath(context, previewFeature.points, camera);
            context.stroke();
          }
          context.restore();
        }
      }

      drawArtworkStampsForPhase("scene");

      mapFeaturesInRenderOrder(currentDocument).forEach((feature) => {
        if (!featureVisible(currentDocument, feature, timelineCursor)) return;
        const layer = currentDocument.layers.find(
          (item) => item.id === feature.layerId,
        );
        const opacity = layer?.opacity ?? 1;
        const pointer = pointerRef.current;
        const isMovingFeature =
          pointer?.mode === "move-feature" &&
          pointer.selectedId === feature.id &&
          pointer.sourcePoints;
        const movingSelectionDelta = previewSelectionDelta(feature.id);
        const isMovingFeatureVertex =
          pointer?.mode === "move-feature-vertex" &&
          pointer.selectedId === feature.id &&
          pointer.sourcePoints &&
          pointer.vertexIndex !== undefined;
        const snappedPointer = pointer
          ? snapPoint(pointer.last, canvasSettings)
          : null;
        const delta = isMovingFeature
          ? {
              x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
              y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
            }
          : movingSelectionDelta;
        const points = isMovingFeature
          ? pointer.sourcePoints.map((sourcePoint) => ({
              x: sourcePoint.x + (delta?.x ?? 0),
              y: sourcePoint.y + (delta?.y ?? 0),
            }))
          : movingSelectionDelta
            ? feature.points.map((sourcePoint) => ({
                x: sourcePoint.x + movingSelectionDelta.x,
                y: sourcePoint.y + movingSelectionDelta.y,
              }))
            : isMovingFeatureVertex
              ? replaceMapGeometryVertex(
                  pointer.sourcePoints,
                  pointer.vertexIndex,
                  snapPoint(pointer.last, canvasSettings),
                  currentDocument.canvas,
                )
              : feature.points;
        if (points.length === 0) return;
        const asset =
          feature.kind === "marker"
            ? assetCatalogRef.current.get(feature.props.component ?? "")
            : undefined;
        const hasAzgaarBaseMap = Boolean(
          currentDocument.canvas.backgroundImage ||
            currentDocument.canvas.backgroundAssetPath,
        );
        if (
          drawAzgaarOverlayFeature(
            context,
            feature,
            points,
            camera,
            opacity,
            hasAzgaarBaseMap,
          )
        ) {
          // Azgaar SVG 已是成图底稿；这里只绘制可编辑边界与低存在感提示。
        } else if (asset && points[0]) {
          const variant = getMapArtworkAssetVariant(
            asset,
            mapArtworkVariantIndex(asset, feature.id),
          );
          const image = getArtworkVariantImage(
            imageCacheRef.current,
            variant,
            () => renderRequestRef.current(),
          );
          if (image) {
            const size = Math.min(
              72,
              Math.max(30, Math.max(variant.width, variant.height) * 0.42),
            );
            drawImageAsset(
              context,
              image,
              points[0],
              camera,
              size,
              (size * variant.height) / variant.width,
              0,
              opacity,
            );
          }
        } else if (isMapRiverFeature(feature)) {
          drawTaperedRiver(context, feature, points, camera, opacity);
        } else if (
          drawMapStyledRoute(context, feature, points, camera, opacity)
        ) {
          // 道路、城墙与疆界由分层路线渲染器接管。
        } else {
          drawPath(context, points, camera);
          if (feature.kind === "polygon" || feature.kind === "area") {
            context.closePath();
            context.fillStyle = feature.props.fill ?? "#b26d4540";
            context.globalAlpha = opacity;
            context.fill();
          }
          if (feature.kind !== "marker" && feature.kind !== "label") {
            context.strokeStyle = feature.props.color ?? "#8b6b4a";
            context.globalAlpha = opacity;
            context.lineWidth =
              Number(feature.props.lineWidth ?? 2) * camera.zoom;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.stroke();
          }
          if (feature.kind === "marker") {
            const point = mapToCanvasPoint(points[0]!, camera);
            context.beginPath();
            context.arc(point.x, point.y, 6, 0, Math.PI * 2);
            context.fillStyle = feature.props.color ?? "#8b6b4a";
            context.globalAlpha = opacity;
            context.fill();
          }
        }
        if (shouldDrawMapFeatureTextOverlay(feature, hasAzgaarBaseMap)) {
          drawMapFeatureLabel(context, feature, points, camera, opacity);
        }
        if (feature.id === selectedIdRef.current) {
          drawMapFeatureSelectionOutline(context, feature, points, camera);
          if (isMapFeatureVertexEditable(feature.kind)) {
            drawFeatureVertexHandles(context, points, camera);
          }
        }
      });

      drawArtworkStampsForPhase("feature");
      drawArtworkStampsForPhase("overlay");

      const selectedId = selectedIdRef.current;
      if (selectedId) {
        let selectionBounds:
          | {
              readonly left: number;
              readonly right: number;
              readonly top: number;
              readonly bottom: number;
            }
          | undefined;
        const selectedFeature = currentDocument.features.find(
          (feature) => feature.id === selectedId,
        );
        if (selectedFeature) {
          const points = selectedFeature.points;
          selectionBounds = regionBounds(points);
          if (points.length === 1) {
            const point = points[0]!;
            selectionBounds = {
              left: point.x - 24,
              right: point.x + 24,
              top: point.y - 24,
              bottom: point.y + 24,
            };
          }
        } else {
          const selectedStamp = currentDocument.artwork.layers
            .flatMap((layer) => layer.stamps)
            .find((stamp) => stamp.id === selectedId);
          if (selectedStamp) {
            const asset = assetCatalogRef.current.get(selectedStamp.assetId);
            const variant = asset
              ? getMapArtworkAssetVariant(asset, selectedStamp.variant)
              : undefined;
            const stampTransform = stampTransformForRender(selectedStamp);
            const size = variant
              ? mapArtworkStampRenderSize(stampTransform, variant)
              : {
                  width: 64 * stampTransform.scale,
                  height: 64 * stampTransform.scale,
                };
            drawArtworkStampTransform(context, stampTransform, size, camera);
          } else {
            const selectedStroke = currentDocument.scene?.layers
              .flatMap((layer) => layer.strokes)
              .find((stroke) => stroke.id === selectedId);
            const selectedRegion = currentDocument.scene?.layers
              .flatMap((layer) => layer.regions)
              .find((region) => region.id === selectedId);
            if (selectedStroke) {
              selectionBounds = regionBounds(selectedStroke.points);
              const padding = selectedStroke.width * 0.5;
              selectionBounds = {
                left: selectionBounds.left - padding,
                right: selectionBounds.right + padding,
                top: selectionBounds.top - padding,
                bottom: selectionBounds.bottom + padding,
              };
            } else if (selectedRegion) {
              selectionBounds = regionBounds(selectedRegion.points);
            }
          }
        }
        if (selectionBounds) {
          drawSelectionOutline(context, selectionBounds, camera);
        }
      }

      const selectedIds = selectedIdsRef.current;
      if (selectedIds.size > 1) {
        let combinedBounds:
          | {
              left: number;
              right: number;
              top: number;
              bottom: number;
            }
          | undefined;
        const includeBounds = (bounds: {
          readonly left: number;
          readonly right: number;
          readonly top: number;
          readonly bottom: number;
        }) => {
          combinedBounds = combinedBounds
            ? {
                left: Math.min(combinedBounds.left, bounds.left),
                right: Math.max(combinedBounds.right, bounds.right),
                top: Math.min(combinedBounds.top, bounds.top),
                bottom: Math.max(combinedBounds.bottom, bounds.bottom),
              }
            : { ...bounds };
        };
        currentDocument.features.forEach((feature) => {
          if (!selectedIds.has(feature.id)) return;
          const delta = previewSelectionDelta(feature.id);
          const points = delta
            ? feature.points.map((point) => ({
                x: point.x + delta.x,
                y: point.y + delta.y,
              }))
            : feature.points;
          if (points.length === 1) {
            const point = points[0]!;
            includeBounds({
              left: point.x - 24,
              right: point.x + 24,
              top: point.y - 24,
              bottom: point.y + 24,
            });
          } else if (points.length > 1) {
            includeBounds(regionBounds(points));
          }
        });
        currentDocument.artwork.layers.forEach((layer) => {
          layer.stamps.forEach((stamp) => {
            if (!selectedIds.has(stamp.id)) return;
            const asset = assetCatalogRef.current.get(stamp.assetId);
            const variant = asset
              ? getMapArtworkAssetVariant(asset, stamp.variant)
              : undefined;
            const transformed = stampTransformForRender(stamp);
            const size = variant
              ? mapArtworkStampRenderSize(transformed, variant)
              : {
                  width: 64 * transformed.scale,
                  height: 64 * transformed.scale,
                };
            const radius = Math.hypot(size.width, size.height) / 2;
            includeBounds({
              left: transformed.x - radius,
              right: transformed.x + radius,
              top: transformed.y - radius,
              bottom: transformed.y + radius,
            });
          });
        });
        if (combinedBounds) {
          drawSelectionOutline(context, combinedBounds, camera);
        }
      }

      const marqueePointer = pointerRef.current;
      if (marqueePointer?.mode === "marquee") {
        const start = mapToCanvasPoint(marqueePointer.start, camera);
        const end = mapToCanvasPoint(marqueePointer.last, camera);
        context.save();
        context.fillStyle = "#c7543620";
        context.strokeStyle = "#c75436";
        context.lineWidth = 1;
        context.setLineDash([5, 3]);
        context.fillRect(
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y),
        );
        context.strokeRect(
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y),
        );
        context.restore();
      }

      const placementPointer = pointerRef.current;
      const placementPoint =
        placementPointer?.mode === "place-stamp"
          ? placementPointer.last
          : toolRef.current === "artwork-stamp" && stampAssetRef.current
            ? hoverPointRef.current
            : null;
      if (placementPoint && stampAssetRef.current) {
        const asset = assetCatalogRef.current.get(stampAssetRef.current);
        if (asset) {
          const variant = getMapArtworkAssetVariant(asset, 0);
          const placementGesture =
            placementPointer?.mode === "place-stamp" &&
            distance(placementPointer.start, placementPointer.last) >= 8
              ? {
                  start: placementPointer.start,
                  end: snapPoint(placementPointer.last, canvasSettings),
                }
              : undefined;
          const placementTransform = mapArtworkStampPlacementTransform({
            anchor: snapPoint(placementPoint, canvasSettings),
            defaultScale: canvasSettings.stampScale,
            variant,
            gesture: placementGesture,
          });
          const image = getArtworkVariantImage(
            imageCacheRef.current,
            variant,
            () => renderRequestRef.current(),
          );
          if (image) {
            const size = mapArtworkStampRenderSize(placementTransform, variant);
            drawImageAsset(
              context,
              image,
              placementTransform,
              camera,
              size.width,
              size.height,
              (placementTransform.rotation * Math.PI) / 180,
              0.52 * canvasSettings.stampOpacity,
            );
            const point = mapToCanvasPoint(placementTransform, camera);
            context.save();
            context.globalAlpha = 0.85;
            context.strokeStyle = "#c75436";
            context.lineWidth = 1.5;
            context.setLineDash([5, 4]);
            context.beginPath();
            if (placementGesture) {
              const start = mapToCanvasPoint(placementGesture.start, camera);
              const end = mapToCanvasPoint(placementGesture.end, camera);
              context.beginPath();
              context.moveTo(start.x, start.y);
              context.lineTo(end.x, end.y);
              context.stroke();
              context.beginPath();
              context.arc(point.x, point.y, 6, 0, Math.PI * 2);
            } else {
              context.beginPath();
              context.arc(
                point.x,
                point.y,
                Math.max(
                  14,
                  Math.max(size.width, size.height) * camera.zoom * 0.36,
                ),
                0,
                Math.PI * 2,
              );
            }
            context.stroke();
            context.restore();
          }
        }
      }

      const pointer = pointerRef.current;
      if (pointer?.mode === "brush" && brushAssetRef.current) {
        const asset = assetCatalogRef.current.get(brushAssetRef.current);
        if (asset) {
          const clipsToLand = mapSceneLayerBrushClipsToLand(
            brushLayerKindRef.current,
          );
          context.save();
          context.globalAlpha = 0.48 * canvasSettings.brushOpacity;
          mapArtworkBrushDabs({
            id: `brush-preview:${asset.id}`,
            points: pointer.points,
            width: canvasSettings.brushSize,
            spacing: canvasSettings.brushSpacing,
            scatter: canvasSettings.brushScatter,
            followPath: asset.brushFollowsPath,
          }).forEach((dab) => {
            if (
              clipsToLand &&
              terrainComposite &&
              !mapTerrainCompositeHasLandAt(terrainComposite, dab)
            ) {
              return;
            }
            const variant = getMapArtworkAssetVariantWithColor(
              asset,
              mapArtworkVariantIndex(asset, `preview:${dab.index}`),
              brushColorRef.current ?? asset.color,
            );
            const image = getArtworkVariantImage(
              imageCacheRef.current,
              variant,
              () => renderRequestRef.current(),
            );
            if (image) {
              drawImageAsset(
                context,
                image,
                dab,
                camera,
                canvasSettings.brushSize * dab.scale,
                (canvasSettings.brushSize * dab.scale * variant.height) /
                  variant.width,
                dab.rotation,
              );
            }
          });
          context.restore();
        }
      }
      if (
        (pointer?.mode === "draw" ||
          pointer?.mode === "brush" ||
          pointer?.mode === "erase" ||
          pointer?.mode === "terrain-land" ||
          pointer?.mode === "terrain-water" ||
          pointer?.mode === "terrain-material" ||
          pointer?.mode === "region") &&
        pointer.points.length > 0
      ) {
        context.save();
        const isTerrainBrush =
          pointer.mode === "terrain-land" ||
          pointer.mode === "terrain-water" ||
          pointer.mode === "terrain-material" ||
          pointer.mode === "erase";
        if (isTerrainBrush) {
          const previewPoints =
            distance(
              pointer.points[pointer.points.length - 1]!,
              pointer.last,
            ) >= 1
              ? [...pointer.points, pointer.last]
              : pointer.points;
          const color =
            pointer.mode === "terrain-material" && terrainMaterialRef.current
              ? getMapTerrainMaterialPreset(terrainMaterialRef.current).color
              : pointer.mode === "terrain-land"
                ? (currentDocument.scene?.terrainStyle.landColor ?? "#b8ad7d")
                : (currentDocument.scene?.terrainStyle.shallowWaterColor ??
                  "#5d9caf");
          context.globalAlpha =
            pointer.mode === "terrain-material"
              ? 0.24 + canvasSettings.brushOpacity * 0.32
              : 0.42;
          context.strokeStyle = color;
          context.fillStyle = color;
          context.lineWidth = Math.max(
            2,
            canvasSettings.brushSize * camera.zoom,
          );
          context.lineCap = "round";
          context.lineJoin = "round";
          if (canvasSettings.terrainBrushShape === "organic") {
            mapTerrainBrushDabs({
              id: "terrain-brush-preview",
              points: previewPoints,
              width: canvasSettings.brushSize,
              spacing: canvasSettings.brushSpacing,
              shape: canvasSettings.terrainBrushShape,
            }).forEach((dab) => {
              const point = mapToCanvasPoint(dab, camera);
              context.beginPath();
              context.arc(
                point.x,
                point.y,
                Math.max(1, dab.radius * camera.zoom),
                0,
                Math.PI * 2,
              );
              context.fill();
            });
          } else if (previewPoints.length === 1) {
            const point = mapToCanvasPoint(previewPoints[0]!, camera);
            context.beginPath();
            context.arc(
              point.x,
              point.y,
              context.lineWidth / 2,
              0,
              Math.PI * 2,
            );
            context.fill();
          } else {
            drawPath(context, previewPoints, camera);
            context.stroke();
          }
          const cursorPoint = mapToCanvasPoint(pointer.last, camera);
          context.globalAlpha = 0.92;
          context.strokeStyle = "#fffaf1";
          context.lineWidth = 1.5;
          context.setLineDash([5, 4]);
          context.beginPath();
          context.arc(
            cursorPoint.x,
            cursorPoint.y,
            Math.max(8, (canvasSettings.brushSize * camera.zoom) / 2),
            0,
            Math.PI * 2,
          );
          context.stroke();
          context.restore();
          return;
        }
        context.globalAlpha = 0.65;
        const isRegionPreview = pointer.mode === "region";
        const isLand = pointer.regionKind === "land";
        context.strokeStyle =
          isRegionPreview && isLand
            ? "#5c5038"
            : isRegionPreview
              ? "#2f6377"
              : "#c75436";
        context.lineWidth = 2;
        context.setLineDash([5, 4]);
        if (isRegionPreview && pointer.points.length >= 3) {
          drawMapSceneRegionPath(context, pointer.points, camera);
          context.fillStyle = isLand ? "#b8ad7d" : "#5d92a5";
          context.globalAlpha = 0.36;
          context.fill();
          context.globalAlpha = 0.8;
          context.stroke();
        } else {
          drawPath(context, pointer.points, camera);
          context.stroke();
        }
        context.restore();
      }

      const hoverPoint = hoverPointRef.current;
      if (
        !pointer &&
        hoverPoint &&
        (toolRef.current === "terrain-land" ||
          toolRef.current === "terrain-water" ||
          toolRef.current === "terrain-material" ||
          toolRef.current === "scene-eraser" ||
          toolRef.current === "artwork-brush")
      ) {
        const artworkBrushAsset =
          toolRef.current === "artwork-brush" && brushAssetRef.current
            ? assetCatalogRef.current.get(brushAssetRef.current)
            : undefined;
        if (artworkBrushAsset) {
          const clipsToLand = mapSceneLayerBrushClipsToLand(
            brushLayerKindRef.current,
          );
          context.save();
          context.globalAlpha = 0.52 * canvasSettings.brushOpacity;
          mapArtworkBrushDabs({
            id: `brush-hover:${artworkBrushAsset.id}`,
            points: [hoverPoint],
            width: canvasSettings.brushSize,
            spacing: canvasSettings.brushSpacing,
            scatter: canvasSettings.brushScatter,
            followPath: artworkBrushAsset.brushFollowsPath,
          }).forEach((dab) => {
            if (
              clipsToLand &&
              terrainComposite &&
              !mapTerrainCompositeHasLandAt(terrainComposite, dab)
            ) {
              return;
            }
            const variant = getMapArtworkAssetVariantWithColor(
              artworkBrushAsset,
              mapArtworkVariantIndex(artworkBrushAsset, `hover:${dab.index}`),
              brushColorRef.current ?? artworkBrushAsset.color,
            );
            const image = getArtworkVariantImage(
              imageCacheRef.current,
              variant,
              () => renderRequestRef.current(),
            );
            if (!image) return;
            drawImageAsset(
              context,
              image,
              dab,
              camera,
              canvasSettings.brushSize * dab.scale,
              (canvasSettings.brushSize * dab.scale * variant.height) /
                variant.width,
              dab.rotation,
            );
          });
          context.restore();
        }
        const point = mapToCanvasPoint(hoverPoint, camera);
        context.save();
        context.globalAlpha = 0.86;
        context.strokeStyle = "#fffaf1";
        context.lineWidth = 1.5;
        context.setLineDash([5, 4]);
        if (
          canvasSettings.terrainBrushShape === "organic" &&
          (toolRef.current === "terrain-land" ||
            toolRef.current === "terrain-water" ||
            toolRef.current === "terrain-material" ||
            toolRef.current === "scene-eraser")
        ) {
          mapTerrainBrushDabs({
            id: "terrain-brush-hover",
            points: [hoverPoint],
            width: canvasSettings.brushSize,
            spacing: canvasSettings.brushSpacing,
            shape: canvasSettings.terrainBrushShape,
          }).forEach((dab) => {
            const dabPoint = mapToCanvasPoint(dab, camera);
            context.beginPath();
            context.arc(
              dabPoint.x,
              dabPoint.y,
              Math.max(1, dab.radius * camera.zoom),
              0,
              Math.PI * 2,
            );
            context.stroke();
          });
        } else {
          context.beginPath();
          context.arc(
            point.x,
            point.y,
            Math.max(8, (canvasSettings.brushSize * camera.zoom) / 2),
            0,
            Math.PI * 2,
          );
          context.stroke();
        }
        context.restore();
      }

      const navigatorCanvas = navigatorCanvasRef.current;
      if (navigatorCanvas) {
        renderMapSceneNavigator(
          navigatorCanvas,
          currentDocument,
          terrainComposite,
          camera,
          { width, height },
        );
      }
    });
  }, [activeLayerId, timelineCursor]);

  useEffect(() => {
    renderRequestRef.current = requestRender;
  }, [requestRender]);

  useEffect(() => {
    if (tool !== "artwork-stamp" && tool !== "terrain-prefab") {
      hoverPointRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor =
        tool === "select" ? "default" : tool === "pan" ? "grab" : "crosshair";
    }
    requestRender();
  }, [requestRender, tool]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      spacePressedRef.current = false;
    };
  }, []);

  useEffect(() => {
    assetCatalogRef.current = createMapArtworkAssetCatalog(
      document.artwork,
      projectArtworkSources,
    );
    requestRender();
  }, [document.artwork, projectArtworkSources, requestRender]);

  useEffect(() => {
    if (
      !documentRebase ||
      documentRebase.revision <= appliedDocumentRebaseRevisionRef.current
    ) {
      return;
    }
    cameraRef.current = rebaseMapSceneCamera(
      cameraRef.current,
      documentRebase.translation,
    );
    appliedDocumentRebaseRevisionRef.current = documentRebase.revision;
    requestRender();
  }, [documentRebase, requestRender]);

  useEffect(() => {
    if (focusRequest !== lastFocusRequestRef.current) {
      pendingFocusRef.current = true;
      lastFocusRequestRef.current = focusRequest;
    }
    cameraRef.current.fitted = false;
    requestRender();
  }, [document.id, focusRequest, requestRender]);

  useEffect(() => {
    requestRender();
  }, [
    artworkBrushColor,
    activePrefabComponentId,
    document,
    requestRender,
    selectedFeatureId,
    settings,
    tool,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => requestRender());
    observer?.observe(root);
    const onResize = () => requestRender();
    window.addEventListener("resize", onResize);
    requestRender();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      if (requestFrameRef.current !== null) {
        window.cancelAnimationFrame(requestFrameRef.current);
        requestFrameRef.current = null;
      }
      if (edgeAutoPanFrameRef.current !== null) {
        window.cancelAnimationFrame(edgeAutoPanFrameRef.current);
        edgeAutoPanFrameRef.current = null;
      }
    };
  }, [requestRender]);

  const screenPointFromEvent = (event: {
    clientX: number;
    clientY: number;
  }): {
    readonly point: MapScenePoint;
    readonly width: number;
    readonly height: number;
  } => {
    const canvas = canvasRef.current;
    const map = documentRef.current;
    if (!canvas) {
      return {
        point: { x: map.canvas.width / 2, y: map.canvas.height / 2 },
        width: map.canvas.width,
        height: map.canvas.height,
      };
    }
    const bounds = canvas.getBoundingClientRect();
    const width =
      Number.isFinite(bounds.width) && bounds.width > 0
        ? bounds.width
        : map.canvas.width;
    const height =
      Number.isFinite(bounds.height) && bounds.height > 0
        ? bounds.height
        : map.canvas.height;
    const left = Number.isFinite(bounds.left) ? bounds.left : 0;
    const top = Number.isFinite(bounds.top) ? bounds.top : 0;
    return {
      point: {
        x: Number.isFinite(event.clientX) ? event.clientX - left : width / 2,
        y: Number.isFinite(event.clientY) ? event.clientY - top : height / 2,
      },
      width,
      height,
    };
  };

  const pointFromEvent = (event: { clientX: number; clientY: number }) => {
    const map = documentRef.current;
    const screen = screenPointFromEvent(event);
    const canvasPoint = screen.point;
    const camera = cameraRef.current;
    if (!camera.fitted || !Number.isFinite(camera.zoom) || camera.zoom <= 0) {
      return {
        x: (canvasPoint.x / screen.width) * map.canvas.width,
        y: (canvasPoint.y / screen.height) * map.canvas.height,
      };
    }
    const point = canvasToMapPoint(canvasPoint, camera);
    return {
      x: Number.isFinite(point.x) ? point.x : map.canvas.width / 2,
      y: Number.isFinite(point.y) ? point.y : map.canvas.height / 2,
    };
  };

  const navigatorPointFromEvent = (event: {
    clientX: number;
    clientY: number;
  }): MapScenePoint | null => {
    const navigatorCanvas = navigatorCanvasRef.current;
    const map = documentRef.current;
    if (!navigatorCanvas) return null;
    const bounds = navigatorCanvas.getBoundingClientRect();
    return mapSceneNavigatorPointAt(
      map,
      {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
      { x: event.clientX, y: event.clientY },
    );
  };

  const centerCameraAtNavigatorPoint = (point: MapScenePoint) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const width =
      bounds.width > 0 ? bounds.width : documentRef.current.canvas.width;
    const height =
      bounds.height > 0 ? bounds.height : documentRef.current.canvas.height;
    const current = cameraRef.current;
    const zoom =
      Number.isFinite(current.zoom) && current.zoom > 0 ? current.zoom : 1;
    cameraRef.current = {
      ...current,
      x: width / 2 - point.x * zoom,
      y: height / 2 - point.y * zoom,
      zoom,
      fitted: true,
    };
    requestRender();
  };

  const handleNavigatorPointerDown = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.button !== 0) return;
    const point = navigatorPointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    navigatorPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    centerCameraAtNavigatorPoint(point);
  };

  const handleNavigatorPointerMove = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    if (navigatorPointerRef.current !== event.pointerId) return;
    const point = navigatorPointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    centerCameraAtNavigatorPoint(point);
  };

  const releaseNavigatorPointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    if (navigatorPointerRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    navigatorPointerRef.current = null;
  };

  const appendPointerPreviewPoint = (
    pointer: PointerState,
    point: MapScenePoint,
  ) => {
    if (
      pointer.mode === "brush" ||
      pointer.mode === "erase" ||
      pointer.mode === "terrain-land" ||
      pointer.mode === "terrain-water" ||
      pointer.mode === "terrain-material" ||
      pointer.mode === "draw" ||
      pointer.mode === "region"
    ) {
      const nextPoint =
        pointer.mode === "draw" || pointer.mode === "region"
          ? snapPoint(point, settingsRef.current)
          : point;
      if (distance(pointer.last, nextPoint) >= 8) {
        pointer.points.push(nextPoint);
      }
    }
    pointer.last = point;
  };

  const stopEdgeAutoPan = () => {
    if (edgeAutoPanFrameRef.current === null) return;
    window.cancelAnimationFrame(edgeAutoPanFrameRef.current);
    edgeAutoPanFrameRef.current = null;
  };

  const startEdgeAutoPan = () => {
    if (edgeAutoPanFrameRef.current !== null) return;
    const tick = () => {
      edgeAutoPanFrameRef.current = null;
      const pointer = pointerRef.current;
      const canvas = canvasRef.current;
      const screenPoint = pointer?.lastScreen;
      if (!pointer || pointer.mode === "pan" || !canvas || !screenPoint) {
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      const map = documentRef.current;
      const width =
        Number.isFinite(bounds.width) && bounds.width > 0
          ? bounds.width
          : map.canvas.width;
      const height =
        Number.isFinite(bounds.height) && bounds.height > 0
          ? bounds.height
          : map.canvas.height;
      const nextCamera = autoPanMapSceneCameraAtEdge(
        cameraRef.current,
        screenPoint,
        { width, height },
      );
      if (nextCamera === cameraRef.current) return;

      cameraRef.current = nextCamera;
      const point = pointFromEvent({
        clientX:
          (Number.isFinite(bounds.left) ? bounds.left : 0) + screenPoint.x,
        clientY: (Number.isFinite(bounds.top) ? bounds.top : 0) + screenPoint.y,
      });
      appendPointerPreviewPoint(pointer, point);
      requestRender();
      edgeAutoPanFrameRef.current = window.requestAnimationFrame(tick);
    };
    edgeAutoPanFrameRef.current = window.requestAnimationFrame(tick);
  };

  const hitSelectedArtworkTransform = (point: MapScenePoint) => {
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const currentDocument = documentRef.current;
    const layer = currentDocument.artwork.layers.find((candidate) =>
      candidate.stamps.some((stamp) => stamp.id === selectedId),
    );
    if (!layer?.visible || layer.locked) return null;
    const stamp = layer.stamps.find((candidate) => candidate.id === selectedId);
    if (!stamp) return null;
    const asset = assetCatalogRef.current.get(stamp.assetId);
    const variant = asset
      ? getMapArtworkAssetVariant(asset, stamp.variant)
      : undefined;
    const size = variant
      ? mapArtworkStampRenderSize(stamp, variant)
      : { width: 64 * stamp.scale, height: 64 * stamp.scale };
    const handles = mapArtworkTransformHandles(
      stamp,
      size,
      cameraRef.current.zoom,
    );
    const handle = hitMapArtworkTransformHandle(
      point,
      handles,
      cameraRef.current.zoom,
    );
    return handle ? { handle, stamp } : null;
  };

  const hitSelectedFeatureVertex = (point: MapScenePoint) => {
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const currentDocument = documentRef.current;
    const feature = currentDocument.features.find(
      (candidate) => candidate.id === selectedId,
    );
    if (
      !feature ||
      !isMapFeatureVertexEditable(feature.kind) ||
      feature.points.length < 2
    ) {
      return null;
    }
    const layer = currentDocument.layers.find(
      (candidate) => candidate.id === feature.layerId,
    );
    if (!layer?.visible || layer.locked) return null;
    const index = findMapGeometryVertexHandle(
      feature.points,
      point,
      cameraRef.current.zoom,
    );
    return index === null ? null : { feature, index };
  };

  const hitSelectedSceneRegionVertex = (point: MapScenePoint) => {
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const currentDocument = documentRef.current;
    for (const layer of currentDocument.scene?.layers ?? []) {
      if (!layer.visible || layer.locked) continue;
      const region = layer.regions.find(
        (candidate) => candidate.id === selectedId,
      );
      if (!region) continue;
      const index = findMapGeometryVertexHandle(
        region.points,
        point,
        cameraRef.current.zoom,
      );
      return index === null ? null : { region, index };
    }
    return null;
  };

  const hitSelectedSceneStrokeControlPoint = (point: MapScenePoint) => {
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const currentDocument = documentRef.current;
    for (const layer of currentDocument.scene?.layers ?? []) {
      if (!layer.visible || layer.locked) continue;
      const stroke = layer.strokes.find(
        (candidate) => candidate.id === selectedId,
      );
      if (!stroke || stroke.points.length < 2) continue;
      const index = findMapSceneStrokeControlPointHandle(
        stroke.points,
        point,
        cameraRef.current.zoom,
      );
      return index === null ? null : { stroke, index };
    }
    return null;
  };

  const hitTest = (
    point: MapScenePoint,
  ): {
    readonly type: "stamp" | "feature" | "stroke" | "region";
    readonly id: string;
    readonly sourcePoints?: readonly MapScenePoint[];
  } | null => {
    const currentDocument = documentRef.current;
    const hitArtworkStamps = (phases: readonly MapArtworkRenderPhase[]) => {
      for (const phase of phases) {
        for (const layer of [
          ...mapArtworkLayersInRenderOrder(currentDocument.artwork, phase),
        ].reverse()) {
          if (!layer.visible || layer.locked) continue;
          for (const stamp of [...layer.stamps].reverse()) {
            const asset = assetCatalogRef.current.get(stamp.assetId);
            const variant = asset
              ? getMapArtworkAssetVariant(asset, stamp.variant)
              : undefined;
            const radius = variant
              ? Math.max(variant.width, variant.height) *
                Math.min(1, 150 / Math.max(variant.width, variant.height)) *
                stamp.scale *
                0.55
              : 32;
            if (distance(point, stamp) <= Math.max(26, radius)) {
              return { type: "stamp" as const, id: stamp.id };
            }
          }
        }
      }
      return null;
    };
    const foregroundArtworkHit = hitArtworkStamps(["overlay", "feature"]);
    if (foregroundArtworkHit) return foregroundArtworkHit;
    for (const feature of [
      ...mapFeaturesInRenderOrder(currentDocument),
    ].reverse()) {
      const layer = currentDocument.layers.find(
        (item) => item.id === feature.layerId,
      );
      if (!layer?.visible || layer.locked) continue;
      if (hitMapFeatureGeometry(feature, point, cameraRef.current.zoom)) {
        return {
          type: "feature",
          id: feature.id,
          sourcePoints: feature.points,
        };
      }
    }
    const sceneArtworkHit = hitArtworkStamps(["scene"]);
    if (sceneArtworkHit) return sceneArtworkHit;
    if (currentDocument.scene) {
      for (const layer of [...currentDocument.scene.layers].reverse()) {
        if (!layer.visible || layer.locked) continue;
        for (const stroke of [...layer.strokes].reverse()) {
          const threshold = Math.max(10, stroke.width * 0.5 + 8);
          if (distanceToPath(point, stroke.points) <= threshold) {
            return {
              type: "stroke",
              id: stroke.id,
              sourcePoints: stroke.points,
            };
          }
        }
        for (const region of [...layer.regions].reverse()) {
          if (pointInPolygon(point, region.points)) {
            return {
              type: "region",
              id: region.id,
              sourcePoints: region.points,
            };
          }
        }
      }
    }
    return hitArtworkStamps(["base"]);
  };

  const setCanvasSelection = (
    ids: readonly string[],
    primaryId: string | null,
  ) => {
    const next = [...new Set(ids)];
    selectedIdsRef.current = new Set(next);
    // 父组件的选择回传是异步的，但下一次手势必须立即看到新的主选择及其顶点、变换手柄。
    selectedIdRef.current = primaryId;
    if (onSelectionChange) {
      onSelectionChange(next, primaryId);
    } else {
      onSelect(primaryId);
    }
    requestRender();
  };

  const selectableIdsInBounds = (
    start: MapScenePoint,
    end: MapScenePoint,
  ): string[] => {
    const bounds = {
      left: Math.min(start.x, end.x),
      right: Math.max(start.x, end.x),
      top: Math.min(start.y, end.y),
      bottom: Math.max(start.y, end.y),
    };
    const intersects = (candidate: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly bottom: number;
    }) =>
      candidate.left <= bounds.right &&
      candidate.right >= bounds.left &&
      candidate.top <= bounds.bottom &&
      candidate.bottom >= bounds.top;
    const currentDocument = documentRef.current;
    const ids: string[] = [];
    mapFeaturesInRenderOrder(currentDocument).forEach((feature) => {
      if (!featureVisible(currentDocument, feature, timelineCursor)) return;
      const layer = currentDocument.layers.find(
        (candidate) => candidate.id === feature.layerId,
      );
      if (!isEditableLayer(layer)) return;
      const candidateBounds =
        feature.points.length === 1
          ? {
              left: feature.points[0]!.x - 24,
              right: feature.points[0]!.x + 24,
              top: feature.points[0]!.y - 24,
              bottom: feature.points[0]!.y + 24,
            }
          : regionBounds(feature.points);
      if (intersects(candidateBounds)) ids.push(feature.id);
    });
    currentDocument.artwork.layers.forEach((layer) => {
      if (!isEditableLayer(layer)) return;
      layer.stamps.forEach((stamp) => {
        const asset = assetCatalogRef.current.get(stamp.assetId);
        const variant = asset
          ? getMapArtworkAssetVariant(asset, stamp.variant)
          : undefined;
        const size = variant
          ? mapArtworkStampRenderSize(stamp, variant)
          : { width: 64 * stamp.scale, height: 64 * stamp.scale };
        const radius = Math.hypot(size.width, size.height) / 2;
        if (
          intersects({
            left: stamp.x - radius,
            right: stamp.x + radius,
            top: stamp.y - radius,
            bottom: stamp.y + radius,
          })
        ) {
          ids.push(stamp.id);
        }
      });
    });
    return ids;
  };

  const updateCanvasCursor = (point: MapScenePoint) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (toolRef.current === "select") {
      const transformHit = hitSelectedArtworkTransform(point);
      if (transformHit?.handle === "rotate") {
        canvas.style.cursor = "grab";
      } else if (transformHit) {
        canvas.style.cursor = "nwse-resize";
      } else if (hitSelectedFeatureVertex(point)) {
        canvas.style.cursor = "grab";
      } else if (hitSelectedSceneRegionVertex(point)) {
        canvas.style.cursor = "grab";
      } else if (hitSelectedSceneStrokeControlPoint(point)) {
        canvas.style.cursor = "grab";
      } else {
        canvas.style.cursor = hitTest(point) ? "move" : "default";
      }
      return;
    }
    if (toolRef.current === "pan") {
      canvas.style.cursor = "grab";
      return;
    }
    canvas.style.cursor = "crosshair";
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentTool = toolRef.current;
    // 空格临时平移和中键平移优先于当前绘图工具，避免按住空格时
    // 误落一笔；这也是素材笔刷、地形笔刷之间唯一不含糊的导航动作。
    if (
      currentTool === "pan" ||
      spacePressedRef.current ||
      event.button === 1
    ) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "pan",
        start: point,
        last: point,
        lastScreen: screenPointFromEvent(event).point,
        points: [],
        selectedId: null,
      };
      canvas.style.cursor = "grabbing";
      return;
    }
    if (
      currentTool === "artwork-brush" &&
      brushAssetRef.current &&
      event.button === 0
    ) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "brush",
        start: point,
        last: point,
        points: [point],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (
      currentTool === "artwork-stamp" &&
      stampAssetRef.current &&
      event.button === 0
    ) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      hoverPointRef.current = snappedPoint;
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "place-stamp",
        start: snappedPoint,
        last: snappedPoint,
        points: [],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (
      currentTool === "terrain-prefab" &&
      prefabComponentIdRef.current &&
      event.button === 0
    ) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      hoverPointRef.current = snappedPoint;
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "place-terrain-prefab",
        start: snappedPoint,
        last: snappedPoint,
        points: [],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (currentTool === "scene-eraser" && event.button === 0) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "erase",
        start: point,
        last: point,
        points: [point],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (
      (currentTool === "terrain-land" || currentTool === "terrain-water") &&
      event.button === 0
    ) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: currentTool,
        start: point,
        last: point,
        points: [point],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (
      (currentTool === "terrain-region-land" ||
        currentTool === "terrain-region-water") &&
      event.button === 0
    ) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "region",
        regionKind: currentTool === "terrain-region-water" ? "water" : "land",
        start: snappedPoint,
        last: snappedPoint,
        points: [snappedPoint],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (
      currentTool === "terrain-material" &&
      terrainMaterialRef.current &&
      event.button === 0
    ) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "terrain-material",
        start: point,
        last: point,
        points: [point],
        selectedId: null,
      };
      requestRender();
      return;
    }
    if (currentTool === "select") {
      if (event.button !== 0) return;
      const transformHit = hitSelectedArtworkTransform(point);
      if (transformHit) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        pointerRef.current = {
          pointerId: event.pointerId,
          mode:
            transformHit.handle === "rotate" ? "rotate-stamp" : "scale-stamp",
          start: point,
          last: point,
          points: [],
          selectedId: transformHit.stamp.id,
          sourceStamp: {
            x: transformHit.stamp.x,
            y: transformHit.stamp.y,
            scale: transformHit.stamp.scale,
            rotation: transformHit.stamp.rotation,
          },
        };
        canvas.style.cursor =
          transformHit.handle === "rotate" ? "grabbing" : "nwse-resize";
        requestRender();
        return;
      }
      const vertexHit = hitSelectedFeatureVertex(point);
      if (vertexHit) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        pointerRef.current = {
          pointerId: event.pointerId,
          mode: "move-feature-vertex",
          start: point,
          last: point,
          points: [],
          selectedId: vertexHit.feature.id,
          sourcePoints: vertexHit.feature.points,
          vertexIndex: vertexHit.index,
        };
        canvas.style.cursor = "grabbing";
        requestRender();
        return;
      }
      const regionVertexHit = hitSelectedSceneRegionVertex(point);
      if (regionVertexHit) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        pointerRef.current = {
          pointerId: event.pointerId,
          mode: "move-region-vertex",
          start: point,
          last: point,
          points: [],
          selectedId: regionVertexHit.region.id,
          sourcePoints: regionVertexHit.region.points,
          vertexIndex: regionVertexHit.index,
        };
        canvas.style.cursor = "grabbing";
        requestRender();
        return;
      }
      const strokeControlPointHit = hitSelectedSceneStrokeControlPoint(point);
      if (strokeControlPointHit) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        pointerRef.current = {
          pointerId: event.pointerId,
          mode: "move-stroke-control-point",
          start: point,
          last: point,
          points: [],
          selectedId: strokeControlPointHit.stroke.id,
          sourcePoints: strokeControlPointHit.stroke.points,
          vertexIndex: strokeControlPointHit.index,
        };
        canvas.style.cursor = "grabbing";
        requestRender();
        return;
      }
      const hit = hitTest(point);
      if (!hit) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        pointerRef.current = {
          pointerId: event.pointerId,
          mode: "marquee",
          start: point,
          last: point,
          points: [],
          selectedId: null,
          additiveSelection: event.shiftKey,
        };
        canvas.style.cursor = "crosshair";
        requestRender();
        return;
      }
      event.preventDefault();
      const selectedIds = selectedIdsRef.current;
      if (event.shiftKey) {
        const next = selectedIds.has(hit.id)
          ? [...selectedIds].filter((id) => id !== hit.id)
          : [...selectedIds, hit.id];
        setCanvasSelection(next, next.at(-1) ?? null);
        canvas.style.cursor = "default";
        return;
      }
      const movingSelection =
        selectedIds.size > 1 && selectedIds.has(hit.id) && Boolean(onBatchMove);
      const isSingleSelected =
        selectedIds.size === 1 && selectedIds.has(hit.id);
      if (!movingSelection && !isSingleSelected) {
        setCanvasSelection([hit.id], hit.id);
        // 选择和移动是两个独立手势，避免切换对象时的轻微误拖，也让下一次手势的
        // 顶点与变换手柄行为保持明确。
        canvas.style.cursor = "move";
        requestRender();
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: movingSelection
          ? "move-selection"
          : hit.type === "stamp"
            ? "move-stamp"
            : hit.type === "feature"
              ? "move-feature"
              : hit.type === "stroke"
                ? "move-stroke"
                : "move-region",
        start: point,
        last: point,
        points: [],
        selectedId: hit.id,
        sourcePoints: hit.sourcePoints,
        selectionIds: movingSelection ? [...selectedIds] : undefined,
      };
      return;
    }
    if (
      event.button === 0 &&
      (currentTool === "marker" ||
        currentTool === "label" ||
        currentTool === "node" ||
        currentTool === "route" ||
        currentTool === "polygon" ||
        currentTool === "area")
    ) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "draw",
        start: snappedPoint,
        last: snappedPoint,
        points: [snappedPoint],
        selectedId: null,
      };
      requestRender();
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    let point = pointFromEvent(event);
    if (!pointer || pointer.pointerId !== event.pointerId) {
      updateCanvasCursor(point);
      if (toolRef.current === "artwork-stamp" && stampAssetRef.current) {
        hoverPointRef.current = snapPoint(point, settingsRef.current);
        requestRender();
      } else if (
        toolRef.current === "terrain-prefab" &&
        prefabComponentIdRef.current
      ) {
        hoverPointRef.current = snapPoint(point, settingsRef.current);
        requestRender();
      } else if (
        toolRef.current === "terrain-land" ||
        toolRef.current === "terrain-water" ||
        toolRef.current === "terrain-material" ||
        toolRef.current === "scene-eraser" ||
        toolRef.current === "artwork-brush"
      ) {
        hoverPointRef.current = point;
        requestRender();
      }
      return;
    }
    if (pointer.mode === "pan") {
      stopEdgeAutoPan();
      const nextScreen = screenPointFromEvent(event).point;
      cameraRef.current = panMapSceneCamera(
        cameraRef.current,
        pointer.lastScreen ?? nextScreen,
        nextScreen,
      );
      pointer.lastScreen = nextScreen;
    } else {
      const screen = screenPointFromEvent(event);
      pointer.lastScreen = screen.point;
      const autoPannedCamera = autoPanMapSceneCameraAtEdge(
        cameraRef.current,
        screen.point,
        screen,
      );
      if (autoPannedCamera !== cameraRef.current) {
        cameraRef.current = autoPannedCamera;
        // 相机改变后必须重新反算同一屏幕位置，避免预览停在旧世界坐标。
        point = pointFromEvent(event);
        startEdgeAutoPan();
      } else {
        stopEdgeAutoPan();
      }
    }
    appendPointerPreviewPoint(pointer, point);
    requestRender();
  };

  const handlePointerLeave = () => {
    if (!pointerRef.current) {
      hoverPointRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = "default";
      requestRender();
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    stopEdgeAutoPan();
    const point = pointFromEvent(event);
    const currentDocument = documentRef.current;
    const hasDragged = distance(pointer.start, point) >= 3;
    if (pointer.mode === "brush" && brushAssetRef.current) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      onSceneStroke(brushAssetRef.current, [...pointer.points]);
    } else if (
      pointer.mode === "terrain-land" ||
      pointer.mode === "terrain-water"
    ) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      onTerrainStroke(pointer.mode === "terrain-water" ? "water" : "land", [
        ...pointer.points,
      ]);
    } else if (
      pointer.mode === "terrain-material" &&
      terrainMaterialRef.current
    ) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      onTerrainMaterialStroke(terrainMaterialRef.current, [...pointer.points]);
    } else if (pointer.mode === "erase") {
      if (
        pointer.points.length === 1 &&
        distance(pointer.points[0]!, point) >= 8
      ) {
        pointer.points.push(point);
      }
      onSceneErase([...pointer.points]);
    } else if (pointer.mode === "place-stamp" && stampAssetRef.current) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const gesture =
        distance(pointer.start, snappedPoint) >= 8
          ? {
              start: pointer.start,
              end: snappedPoint,
            }
          : undefined;
      onArtworkStampPlace(
        stampAssetRef.current,
        {
          x: snappedPoint.x,
          y: snappedPoint.y,
        },
        gesture,
      );
    } else if (
      pointer.mode === "place-terrain-prefab" &&
      prefabComponentIdRef.current
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const gesture =
        distance(pointer.start, snappedPoint) >= 8
          ? {
              start: pointer.start,
              end: snappedPoint,
            }
          : undefined;
      onComponentDrop(
        prefabComponentIdRef.current,
        {
          x: snappedPoint.x,
          y: snappedPoint.y,
        },
        gesture,
      );
    } else if (pointer.mode === "marquee") {
      if (hasDragged) {
        const enclosed = selectableIdsInBounds(pointer.start, point);
        const next = pointer.additiveSelection
          ? [...new Set([...selectedIdsRef.current, ...enclosed])]
          : enclosed;
        setCanvasSelection(next, next.at(-1) ?? null);
      } else if (!pointer.additiveSelection) {
        setCanvasSelection([], null);
      }
    } else if (
      pointer.mode === "move-selection" &&
      pointer.selectionIds &&
      hasDragged
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      onBatchMove?.(pointer.selectionIds, {
        x: snappedPoint.x - pointer.start.x,
        y: snappedPoint.y - pointer.start.y,
      });
    } else if (
      pointer.mode === "move-stamp" &&
      pointer.selectedId &&
      hasDragged
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      onArtworkStampMove(pointer.selectedId, {
        x: snappedPoint.x,
        y: snappedPoint.y,
      });
    } else if (
      pointer.mode === "scale-stamp" &&
      pointer.selectedId &&
      pointer.sourceStamp &&
      hasDragged
    ) {
      onArtworkStampTransform(pointer.selectedId, {
        scale: scaleMapArtworkStampFromPointer(
          pointer.sourceStamp,
          pointer.start,
          point,
        ),
        rotation: pointer.sourceStamp.rotation,
      });
    } else if (
      pointer.mode === "rotate-stamp" &&
      pointer.selectedId &&
      pointer.sourceStamp &&
      hasDragged
    ) {
      const rotation = rotateMapArtworkStampFromPointer(
        pointer.sourceStamp,
        pointer.start,
        point,
      );
      onArtworkStampTransform(pointer.selectedId, {
        scale: pointer.sourceStamp.scale,
        rotation,
      });
    } else if (
      pointer.mode === "move-feature" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      hasDragged
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const delta = {
        x: snappedPoint.x - pointer.start.x,
        y: snappedPoint.y - pointer.start.y,
      };
      onGeometryChange(
        pointer.selectedId,
        pointer.sourcePoints.map((sourcePoint) => ({
          x: sourcePoint.x + delta.x,
          y: sourcePoint.y + delta.y,
        })),
      );
    } else if (
      pointer.mode === "move-feature-vertex" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      pointer.vertexIndex !== undefined &&
      hasDragged
    ) {
      onGeometryChange(
        pointer.selectedId,
        replaceMapGeometryVertex(
          pointer.sourcePoints,
          pointer.vertexIndex,
          snapPoint(point, settingsRef.current),
          currentDocument.canvas,
        ),
      );
    } else if (
      pointer.mode === "move-stroke" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      hasDragged
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const delta = {
        x: snappedPoint.x - pointer.start.x,
        y: snappedPoint.y - pointer.start.y,
      };
      onSceneStrokeMove(
        pointer.selectedId,
        pointer.sourcePoints.map((sourcePoint) => ({
          x: sourcePoint.x + delta.x,
          y: sourcePoint.y + delta.y,
        })),
      );
    } else if (
      pointer.mode === "move-stroke-control-point" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      pointer.vertexIndex !== undefined &&
      hasDragged
    ) {
      onSceneStrokeMove(
        pointer.selectedId,
        moveMapSceneStrokeControlPoint(
          pointer.sourcePoints,
          pointer.vertexIndex,
          snapPoint(point, settingsRef.current),
          currentDocument.canvas,
        ),
      );
    } else if (
      pointer.mode === "move-region" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      hasDragged
    ) {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const delta = {
        x: snappedPoint.x - pointer.start.x,
        y: snappedPoint.y - pointer.start.y,
      };
      onSceneRegionMove(
        pointer.selectedId,
        pointer.sourcePoints.map((sourcePoint) => ({
          x: sourcePoint.x + delta.x,
          y: sourcePoint.y + delta.y,
        })),
      );
    } else if (
      pointer.mode === "move-region-vertex" &&
      pointer.selectedId &&
      pointer.sourcePoints &&
      pointer.vertexIndex !== undefined &&
      hasDragged
    ) {
      onSceneRegionMove(
        pointer.selectedId,
        replaceMapGeometryVertex(
          pointer.sourcePoints,
          pointer.vertexIndex,
          snapPoint(point, settingsRef.current),
          currentDocument.canvas,
        ),
      );
    } else if (pointer.mode === "region") {
      const snappedPoint = snapPoint(point, settingsRef.current);
      if (
        distance(pointer.points[pointer.points.length - 1]!, snappedPoint) >= 8
      ) {
        pointer.points.push(snappedPoint);
      }
      const points = pointer.points.filter(
        (drawPoint, index, points) =>
          index === 0 || distance(drawPoint, points[index - 1]!) >= 4,
      );
      if (points.length >= 3) {
        onSceneRegionCreate(pointer.regionKind ?? "land", points);
      }
    } else if (pointer.mode === "draw") {
      const points = pointer.points.length > 0 ? pointer.points : [point];
      const kind = currentToolToFeatureKind(toolRef.current);
      if (kind) {
        onCreate({
          id: nextId("feature"),
          kind,
          name:
            kind === "marker"
              ? "新地点"
              : kind === "label"
                ? "新标签"
                : kind === "route"
                  ? "新路线"
                  : kind === "node"
                    ? "新节点"
                    : "新区域",
          entityRef: null,
          layerId: activeLayerId,
          points:
            kind === "marker" || kind === "label" || kind === "node"
              ? [points[0]!]
              : points.length >= 3
                ? points
                : [
                    points[0]!,
                    points[points.length - 1]!,
                    {
                      x: point.x + 1,
                      y: point.y + 1,
                    },
                  ],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        });
      }
    }
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    pointerRef.current = null;
    updateCanvasCursor(point);
    requestRender();
  };

  const handlePointerCancel = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    stopEdgeAutoPan();
    // 系统手势、窗口切换或触控中断不代表作者确认了这笔操作；
    // 取消时只释放捕获并丢弃临时笔触，避免留下半条河流或半个印章。
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    pointerRef.current = null;
    updateCanvasCursor(pointFromEvent(event));
    requestRender();
  };

  const adjustZoom = (delta: number) => {
    const canvas = canvasRef.current;
    const bounds = canvas?.getBoundingClientRect();
    const anchor = {
      x:
        bounds && Number.isFinite(bounds.width) && bounds.width > 0
          ? bounds.width / 2
          : document.canvas.width / 2,
      y:
        bounds && Number.isFinite(bounds.height) && bounds.height > 0
          ? bounds.height / 2
          : document.canvas.height / 2,
    };
    cameraRef.current = zoomMapSceneCameraAt(
      cameraRef.current,
      anchor,
      delta > 0 ? 1.15 : 1 / 1.15,
    );
    requestRender();
  };

  const fitCanvas = () => {
    pendingFocusRef.current = false;
    cameraRef.current.fitted = false;
    requestRender();
  };

  const focusContent = () => {
    pendingFocusRef.current = true;
    cameraRef.current.fitted = false;
    requestRender();
  };

  const exportCurrentView = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const result = await downloadMapDocumentPng(
        document,
        timelineCursor,
        projectArtworkSources,
      );
      toast?.success(`已导出 ${result.width} × ${result.height} PNG`);
    } catch (error) {
      console.error("Failed to export map PNG", error);
      toast?.error(
        error instanceof Error ? error.message : "地图 PNG 导出失败。",
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="map-canvas relative h-full min-h-0 w-full overflow-hidden"
      aria-label="地图设计画布"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(MAP_COMPONENT_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const componentId = event.dataTransfer.getData(MAP_COMPONENT_DRAG_MIME);
        if (!componentId) return;
        event.preventDefault();
        onComponentDrop(componentId, pointFromEvent(event));
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[1] touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onDoubleClick={(event) => {
          if (toolRef.current !== "select" && toolRef.current !== "pan") {
            return;
          }
          event.preventDefault();
          cameraRef.current = zoomMapSceneCameraAt(
            cameraRef.current,
            screenPointFromEvent(event).point,
            1.35,
          );
          requestRender();
        }}
        onWheel={(event) => {
          event.preventDefault();
          cameraRef.current = zoomMapSceneCameraAt(
            cameraRef.current,
            screenPointFromEvent(event).point,
            event.deltaY < 0 ? 1.1 : 0.9,
          );
          requestRender();
        }}
        aria-label="地图绘图层"
      />
      <canvas
        ref={navigatorCanvasRef}
        className="absolute bottom-3 right-3 z-10 h-28 w-44 touch-none cursor-crosshair rounded border border-[#746b6038] bg-[#fffaf1] shadow-sm"
        aria-label="地图缩略导航"
        onPointerDown={handleNavigatorPointerDown}
        onPointerMove={handleNavigatorPointerMove}
        onPointerUp={releaseNavigatorPointer}
        onPointerCancel={releaseNavigatorPointer}
      />
      <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-md border border-[#746b6038] bg-[#fffaf1] shadow-sm">
        <button
          type="button"
          onClick={() => adjustZoom(1)}
          title="放大地图"
          aria-label="放大地图"
          className="grid h-8 w-8 place-items-center text-[#51483e] hover:bg-[#eee8dc]"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => adjustZoom(-1)}
          title="缩小地图"
          aria-label="缩小地图"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={fitCanvas}
          title="适配画布"
          aria-label="适配画布"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={focusContent}
          title="聚焦内容"
          aria-label="聚焦地图内容"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
        >
          <LocateFixed className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void exportCurrentView()}
          disabled={isExporting}
          title={`导出高清 PNG（${Math.round(document.canvas.width)} × ${Math.round(document.canvas.height)}）`}
          aria-label="导出高清 PNG"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc] disabled:cursor-wait disabled:opacity-55"
        >
          {isExporting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
      </div>
      {settings.snapEnabled && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs uppercase tracking-[0.18em] text-[#6e6256]">
          snap / {settings.snapGrid}px
        </div>
      )}
    </div>
  );
}

function currentToolToFeatureKind(tool: MapCanvasTool): MapFeatureKind | null {
  if (
    tool === "marker" ||
    tool === "label" ||
    tool === "area" ||
    tool === "polygon" ||
    tool === "route" ||
    tool === "node"
  ) {
    return tool;
  }
  return null;
}
