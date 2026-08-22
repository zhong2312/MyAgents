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
  createMapComponentSurfaceBrushPoints,
  mapComponentPlacement,
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
  sceneLayerKindForComponentCategory,
  isMapTerrainMaskStroke,
  isMapTerrainMaterialStroke,
} from "../business/mapScene";
import {
  expandMapSelectableItemIds,
  findMapSelectableGroup,
  isMapSelectableGroupSelection,
  moveMapSelectableItems,
} from "../business/mapSelection";
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
import { MAP_CANVAS_CONTENT_PADDING } from "../business/mapCanvasBounds";
import {
  mapArtworkBrushDabs,
  mapTerrainBrushCoverageDabs,
  mapTerrainBrushDabs,
  type MapArtworkBrushDab,
} from "../business/mapTerrainBrush";
import { getMapTerrainMaterialPreset } from "../business/mapTerrainMaterials";
import {
  DEFAULT_MAP_RIVER_PROPS,
  isMapRiverFeature,
} from "../business/mapHydrography";
import {
  DEFAULT_MAP_FREEFORM_AREA_PROPS,
  getMapFeatureAreaStyle,
} from "../business/mapFeatureAreaStyle";
import {
  createMapAreaShapePoints,
  isMapBrushPathClosed,
  resampleMapBrushPoints,
  resampleMapBrushPointsBySpacing,
} from "../business/mapFeatureShapes";
import { resolveMapLabelPlacements } from "../business/mapLabels";
import {
  getMapBackgroundImagePlacement,
  isMapBackgroundImageVisible,
} from "../business/mapBackgrounds";
import {
  createMapTerrainComposite,
  mapTerrainCompositeIntersectsBrush,
  mapTerrainCompositeHasLandAt,
  mapTerrainCompositeHasSurfaceAt,
  mapTerrainCompositeSourceKey,
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
  drawMapBrushPath,
  drawMapStyledRoute,
  drawPath,
  drawTaperedRiver,
  featureVisible,
  mapFeatureBrushCurve,
  mapToCanvasPoint,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
} from "./mapSceneDrawing";
import { mapBrushCurvePoints } from "../business/mapFeatureShapes";
import { isMapFeatureFreeformArea } from "../entities/mapSchema";
import type {
  MapDocument,
  MapArtworkStamp,
  MapBrushPointCurve,
  MapFeature,
  MapFeatureKind,
  MapScenePoint,
  MapSceneRegion,
  MapSceneLayerKind,
  MapSceneStroke,
  MapTerrainMaterial,
} from "../entities/mapSchema";
import {
  DEFAULT_MAP_CANVAS_SETTINGS,
  type MapAreaShape,
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
  | "polygon"
  | "region"
  | "place-stamp"
  | "place-terrain-prefab"
  | "component-surface-brush"
  | "component-path-brush"
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

function terrainMaterialSurface(
  material: MapTerrainMaterial | null | undefined,
): "land" | "water" {
  return material ? getMapTerrainMaterialPreset(material).surface : "land";
}

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
  /** 绘制开始时锁定的几何模式，避免工具栏切换尚未提交时落笔使用旧值。 */
  readonly areaShape?: MapAreaShape;
  /**
   * 绘制开始时锁定的工具。自由画笔不能在松开鼠标时再回读工具栏，
   * 否则规则形状的会话状态可能把这一笔错误地解释为圆形或椭圆。
   */
  readonly drawTool?: MapCanvasTool;
  readonly curve?: MapBrushPointCurve;
  lastScreen?: MapScenePoint;
  last: MapScenePoint;
};

type MapSceneContextMenu = {
  readonly x: number;
  readonly y: number;
  readonly itemIds: readonly string[];
  readonly groupId: string | null;
  readonly isCompleteGroup: boolean;
  readonly materialLandPair: readonly [string, string] | null;
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
  extension = MAP_CANVAS_CONTENT_PADDING,
): MapScenePreviewBounds {
  const safeExtension = Math.max(
    32,
    Number.isFinite(extension)
      ? Math.round(extension)
      : MAP_CANVAS_CONTENT_PADDING,
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
  /** 把选区固化为一个一起变换的地图组合。 */
  readonly onCreateGroup?: (itemIds: readonly string[]) => void;
  /** 解除组合只删除组合引用，不改写成员事实。 */
  readonly onUngroup?: (groupId: string) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onComponentDrop: (
    componentId: string,
    point: MapScenePoint,
    gesture?: MapComponentPlacementGesture,
  ) => void;
  readonly onComponentSurface: (
    componentId: string,
    points: readonly MapScenePoint[],
    closed: boolean,
    curve: MapBrushPointCurve,
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
  readonly onTerrainMaterialRejected?: () => void;
  readonly onSceneStrokeMove: (
    strokeId: string,
    points: readonly MapScenePoint[],
  ) => void;
  readonly onSceneRegionCreate: (
    kind: MapSceneRegion["kind"],
    points: readonly MapScenePoint[],
    curve?: MapBrushPointCurve,
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

const MAP_POLYGON_CLOSE_TOLERANCE = 24;

function isPolygonClosePoint(
  points: readonly MapScenePoint[],
  point: MapScenePoint,
): boolean {
  return (
    points.length >= 3 &&
    distance(points[0]!, point) <= MAP_POLYGON_CLOSE_TOLERANCE
  );
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

function isWorldCircleVisible(
  point: MapScenePoint,
  radius: number,
  viewport: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
): boolean {
  const safeRadius = Math.max(0, radius);
  return (
    point.x + safeRadius >= viewport.left &&
    point.x - safeRadius <= viewport.right &&
    point.y + safeRadius >= viewport.top &&
    point.y - safeRadius <= viewport.bottom
  );
}

export function mapScenePointsIntersectViewport(
  points: readonly MapScenePoint[],
  viewport: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
  padding = 0,
): boolean {
  if (points.length === 0) return false;
  const safePadding = Math.max(0, padding);
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  points.forEach((point) => {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  });
  return (
    right + safePadding >= viewport.left &&
    left - safePadding <= viewport.right &&
    bottom + safePadding >= viewport.top &&
    top - safePadding <= viewport.bottom
  );
}

function mapSceneBoundsIntersectViewport(
  bounds: ReturnType<typeof regionBounds>,
  viewport: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
  padding: number,
): boolean {
  const safePadding = Math.max(0, padding);
  return (
    bounds.right + safePadding >= viewport.left &&
    bounds.left - safePadding <= viewport.right &&
    bounds.bottom + safePadding >= viewport.top &&
    bounds.top - safePadding <= viewport.bottom
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

type MapSceneNavigatorBackground = {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly placement?: ReturnType<typeof getMapBackgroundImagePlacement>;
};

type MapSceneNavigatorSize = {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

type MapSceneNavigatorContentCache = {
  readonly document: MapDocument;
  readonly terrainComposite: ReturnType<typeof createMapTerrainComposite>;
  readonly backgroundImage: CanvasImageSource | null;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly canvas: HTMLCanvasElement;
};

const mapSceneNavigatorContentCaches = new WeakMap<
  HTMLCanvasElement,
  MapSceneNavigatorContentCache
>();

function getMapSceneNavigatorSize(
  canvas: HTMLCanvasElement,
): MapSceneNavigatorSize | null {
  const bounds = canvas.getBoundingClientRect();
  const width = Number.isFinite(bounds.width) ? Math.round(bounds.width) : 0;
  const height = Number.isFinite(bounds.height) ? Math.round(bounds.height) : 0;
  if (width <= 0 || height <= 0) return null;
  const pixelRatio = window.devicePixelRatio || 1;
  return {
    width,
    height,
    pixelRatio,
    pixelWidth: Math.max(1, Math.round(width * pixelRatio)),
    pixelHeight: Math.max(1, Math.round(height * pixelRatio)),
  };
}

function getMapSceneNavigatorLayout(
  document: MapDocument,
  size: MapSceneNavigatorSize,
) {
  const mapWidth = Math.max(1, document.canvas.width);
  const mapHeight = Math.max(1, document.canvas.height);
  const scale = Math.min(size.width / mapWidth, size.height / mapHeight);
  return {
    mapWidth,
    mapHeight,
    scale,
    offsetX: (size.width - mapWidth * scale) / 2,
    offsetY: (size.height - mapHeight * scale) / 2,
  };
}

function drawMapSceneNavigatorContent(
  canvas: HTMLCanvasElement,
  document: MapDocument,
  terrainComposite: ReturnType<typeof createMapTerrainComposite>,
  background: MapSceneNavigatorBackground | null,
  size: MapSceneNavigatorSize,
): void {
  if (canvas.width !== size.pixelWidth) canvas.width = size.pixelWidth;
  if (canvas.height !== size.pixelHeight) canvas.height = size.pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  const { mapWidth, mapHeight, scale, offsetX, offsetY } =
    getMapSceneNavigatorLayout(document, size);

  context.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.fillStyle = "#fffaf1";
  context.fillRect(0, 0, size.width, size.height);
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
  if (
    background &&
    isMapBackgroundImageVisible(document.canvas) &&
    background.width > 0 &&
    background.height > 0
  ) {
    drawContainedMapBackgroundImage(
      context,
      background.image,
      background.width,
      background.height,
      mapWidth,
      mapHeight,
      background.opacity,
      background.placement,
    );
  }
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

  const layersById = new Map(document.layers.map((layer) => [layer.id, layer]));
  document.features.forEach((feature) => {
    const layer = layersById.get(feature.layerId);
    if (!layer?.visible || feature.points.length === 0) return;
    const layerOpacity = Math.max(0.2, Math.min(1, layer.opacity));
    const isArea = isMapFeatureFreeformArea(feature.kind);
    const isClosedPath = isArea || feature.props.closed === "true";
    const areaStyle = isArea ? getMapFeatureAreaStyle(feature) : null;
    context.globalAlpha = layerOpacity;
    context.strokeStyle = feature.props.color ?? "#6f5944";
    context.fillStyle = areaStyle?.fill ?? feature.props.color ?? "#6f5944";
    context.lineWidth = Math.max(3, Number(feature.props.lineWidth ?? 2));
    const first = feature.points[0]!;
    drawMapBrushPath(
      context,
      feature.points,
      { x: 0, y: 0, zoom: 1 },
      mapFeatureBrushCurve(feature),
      isClosedPath,
    );
    if (isArea) {
      context.globalAlpha = layerOpacity * (areaStyle?.opacity ?? 1);
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
  context.restore();
}

function renderMapSceneNavigator(
  canvas: HTMLCanvasElement,
  document: MapDocument,
  terrainComposite: ReturnType<typeof createMapTerrainComposite>,
  background: MapSceneNavigatorBackground | null,
  camera: MapSceneCamera,
  viewport: { readonly width: number; readonly height: number },
): void {
  const size = getMapSceneNavigatorSize(canvas);
  if (!size || typeof globalThis.document === "undefined") return;
  const cached = mapSceneNavigatorContentCaches.get(canvas);
  const backgroundImage = background?.image ?? null;
  const canReuseContent =
    cached?.document === document &&
    cached.terrainComposite === terrainComposite &&
    cached.backgroundImage === backgroundImage &&
    cached.width === size.width &&
    cached.height === size.height &&
    cached.pixelRatio === size.pixelRatio;
  const content = canReuseContent
    ? cached
    : (() => {
        const contentCanvas =
          cached?.canvas ?? globalThis.document.createElement("canvas");
        drawMapSceneNavigatorContent(
          contentCanvas,
          document,
          terrainComposite,
          background,
          size,
        );
        const next = {
          document,
          terrainComposite,
          backgroundImage,
          width: size.width,
          height: size.height,
          pixelRatio: size.pixelRatio,
          canvas: contentCanvas,
        };
        mapSceneNavigatorContentCaches.set(canvas, next);
        return next;
      })();
  if (canvas.width !== size.pixelWidth) canvas.width = size.pixelWidth;
  if (canvas.height !== size.pixelHeight) canvas.height = size.pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  const { mapWidth, mapHeight, scale, offsetX, offsetY } =
    getMapSceneNavigatorLayout(document, size);

  context.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(
    content.canvas,
    0,
    0,
    content.canvas.width,
    content.canvas.height,
    0,
    0,
    size.width,
    size.height,
  );
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);

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
    drawMapBrushPath(
      context,
      points,
      camera,
      mapFeatureBrushCurve(feature),
      isMapFeatureFreeformArea(feature.kind) || feature.props.closed === "true",
    );
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
  drawMapSceneRegionPath(context, points, camera, region.curve);
  context.fillStyle = region.fill;
  context.fill();
  context.clip();

  if (region.texture !== "water-ripple") {
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
    if (region.texture === "territory-hatch") {
      const step = 24;
      context.globalAlpha = opacity * 0.32;
      context.strokeStyle = "#70453c";
      context.lineWidth = Math.max(0.7, camera.zoom);
      for (
        let offset = Math.floor((bounds.left - bounds.bottom) / step) * step;
        offset <= bounds.right - bounds.top + step;
        offset += step
      ) {
        const start = mapToCanvasPoint(
          { x: bounds.left + offset, y: bounds.bottom },
          camera,
        );
        const end = mapToCanvasPoint(
          { x: bounds.right + offset, y: bounds.top },
          camera,
        );
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    }
    if (region.texture === "administrative-grid") {
      const step = 42;
      context.globalAlpha = opacity * 0.26;
      context.strokeStyle = "#5e4b38";
      context.lineWidth = Math.max(0.65, camera.zoom * 0.85);
      for (
        let x = Math.floor(bounds.left / step) * step;
        x <= bounds.right + step;
        x += step
      ) {
        const start = mapToCanvasPoint({ x, y: bounds.top }, camera);
        const end = mapToCanvasPoint({ x, y: bounds.bottom }, camera);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
      for (
        let y = Math.floor(bounds.top / step) * step;
        y <= bounds.bottom + step;
        y += step
      ) {
        const start = mapToCanvasPoint({ x: bounds.left, y }, camera);
        const end = mapToCanvasPoint({ x: bounds.right, y }, camera);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    }
    if (region.texture === "stellar-domain") {
      const step = 36;
      context.globalAlpha = opacity * 0.45;
      context.fillStyle = "#e6efff";
      for (
        let y = Math.floor(bounds.top / step) * step + (seed % 13);
        y <= bounds.bottom + step;
        y += step
      ) {
        for (
          let x = Math.floor(bounds.left / step) * step + ((seed >>> 7) % 19);
          x <= bounds.right + step;
          x += step
        ) {
          const point = mapToCanvasPoint(
            {
              x: x + ((Math.floor(y / step) * 17 + seed) % 11),
              y: y + ((Math.floor(x / step) * 11 + seed) % 9),
            },
            camera,
          );
          context.fillRect(
            point.x,
            point.y,
            Math.max(1, camera.zoom * 1.35),
            Math.max(1, camera.zoom * 1.35),
          );
        }
      }
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
  drawMapSceneRegionPath(context, points, camera, region.curve);
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
  onCreateGroup,
  onUngroup,
  onCreate,
  onComponentDrop,
  onComponentSurface,
  onSceneStroke,
  onSceneErase,
  onTerrainStroke,
  onTerrainMaterialStroke,
  onTerrainMaterialRejected,
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
  const [contextMenu, setContextMenu] = useState<MapSceneContextMenu | null>(
    null,
  );
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
  const polygonDraftRef = useRef<MapScenePoint[]>([]);
  const polygonHoverRef = useRef<MapScenePoint | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const assetCatalogRef = useRef(
    createMapArtworkAssetCatalog(document.artwork, projectArtworkSources),
  );
  const terrainCompositeRef = useRef<{
    readonly sourceKey: string;
    readonly width: number;
    readonly height: number;
    readonly composite: ReturnType<typeof createMapTerrainComposite>;
  } | null>(null);
  const terrainSourceKeyRef = useRef<{
    readonly scene: MapDocument["scene"];
    readonly sourceKey: string;
  } | null>(null);
  const artworkBrushDabsRef = useRef<
    WeakMap<
      MapSceneStroke,
      {
        readonly assetId: string;
        readonly followPath: boolean;
        readonly curve: MapBrushPointCurve | undefined;
        readonly dabs: readonly MapArtworkBrushDab[];
      }
    >
  >(new WeakMap());
  const featureRenderCacheRef = useRef<{
    readonly features: MapDocument["features"];
    readonly layers: MapDocument["layers"];
    readonly renderOrder: readonly MapFeature[];
    readonly boundsById: ReadonlyMap<string, ReturnType<typeof regionBounds>>;
    readonly layersById: ReadonlyMap<string, MapDocument["layers"][number]>;
  } | null>(null);
  const labelPlacementCacheRef = useRef<{
    readonly features: MapDocument["features"];
    readonly zoomBucket: number;
    readonly placements: ReturnType<typeof resolveMapLabelPlacements>;
  } | null>(null);
  const documentRef = useRef(document);
  const selectedIdRef = useRef(selectedFeatureId);
  const selectedIdsRef = useRef<ReadonlySet<string>>(
    new Set(
      expandMapSelectableItemIds(
        document,
        selectedFeatureIds.length > 0
          ? selectedFeatureIds
          : [selectedFeatureId].filter((id): id is string => Boolean(id)),
      ),
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
  const dropAutoPanFrameRef = useRef<number | null>(null);
  const dropScreenPointRef = useRef<MapScenePoint | null>(null);
  /**
   * 外部素材拖放只在当前指针下存活。它驱动落点预览，但绝不进入
   * MapDocument；实际落图仍由 onComponentDrop 统一处理。
   */
  const externalDragAssetIdRef = useRef<string | null>(null);
  const renderRequestRef = useRef<() => void>(() => undefined);
  const appliedDocumentRebaseRevisionRef = useRef(0);
  const lastFocusRequestRef = useRef(focusRequest);
  const pendingFocusRef = useRef(false);
  const navigatorPointerRef = useRef<number | null>(null);

  useEffect(() => {
    documentRef.current = document;
    selectedIdRef.current = selectedFeatureId;
    selectedIdsRef.current = new Set(
      expandMapSelectableItemIds(
        document,
        selectedFeatureIds.length > 0
          ? selectedFeatureIds
          : [selectedFeatureId].filter((id): id is string => Boolean(id)),
      ),
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
      const previewPoints = [
        ...pointerPreviewPoints(pointerRef.current),
        ...polygonDraftRef.current,
        ...(polygonHoverRef.current ? [polygonHoverRef.current] : []),
      ];
      const externalDragAssetId = externalDragAssetIdRef.current;
      const externalDragComponent = externalDragAssetId
        ? MAP_COMPONENT_PRESETS.find(
            (component) => component.id === externalDragAssetId,
          )
        : undefined;
      const externalDragPlacement = externalDragComponent
        ? mapComponentPlacement(externalDragComponent)
        : null;
      const externalDragAsset = externalDragAssetId
        ? assetCatalogRef.current.get(externalDragAssetId)
        : undefined;
      const externalDragAnchor = externalDragAssetId
        ? hoverPointRef.current
        : null;
      const isExternalPrefabPreview =
        externalDragPlacement === "terrain-prefab" ||
        externalDragPlacement === "path" ||
        externalDragPlacement === "overlay";
      const isExternalBrushPreview = Boolean(
        externalDragAnchor &&
          externalDragAsset?.brush &&
          !isExternalPrefabPreview,
      );
      const stampPlacementPointer = pointerRef.current;
      const stampPlacementAssetId =
        externalDragAnchor &&
        externalDragAsset &&
        !isExternalPrefabPreview &&
        !externalDragAsset.brush
          ? externalDragAsset.id
          : stampAssetRef.current;
      const stampPlacementAnchor =
        externalDragAnchor && stampPlacementAssetId === externalDragAsset?.id
          ? externalDragAnchor
          : stampPlacementPointer?.mode === "place-stamp"
            ? stampPlacementPointer.last
            : toolRef.current === "artwork-stamp" && stampPlacementAssetId
              ? hoverPointRef.current
              : null;
      if (stampPlacementAnchor && stampPlacementAssetId) {
        const placementAsset = assetCatalogRef.current.get(
          stampPlacementAssetId,
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
      const visibleWorldBounds = {
        left: visibleWorldLeft,
        right: visibleWorldRight,
        top: visibleWorldTop,
        bottom: visibleWorldBottom,
      };
      const backgroundImageSource = currentDocument.canvas.backgroundImage;
      const backgroundImage =
        backgroundImageSource &&
        isMapBackgroundImageVisible(currentDocument.canvas)
          ? getCachedImage(
              imageCacheRef.current,
              `background:${backgroundImageSource}`,
              backgroundImageSource,
              () => renderRequestRef.current(),
            )
          : null;
      const navigatorBackground = backgroundImage
        ? {
            image: backgroundImage,
            width: backgroundImage.naturalWidth,
            height: backgroundImage.naturalHeight,
            opacity: currentDocument.canvas.backgroundOpacity ?? 1,
            placement: getMapBackgroundImagePlacement(
              currentDocument.canvas,
              backgroundImage.naturalWidth,
              backgroundImage.naturalHeight,
            ),
          }
        : null;
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
      if (navigatorBackground) {
        drawContainedMapBackgroundImage(
          context,
          navigatorBackground.image,
          navigatorBackground.width,
          navigatorBackground.height,
          currentDocument.canvas.width,
          currentDocument.canvas.height,
          navigatorBackground.opacity,
          navigatorBackground.placement,
        );
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
      const framePointer = pointerRef.current;
      const frameSnappedPointer = framePointer
        ? snapPoint(framePointer.last, canvasSettings)
        : null;
      const frameSelectionDelta =
        framePointer?.mode === "move-selection" && framePointer.selectionIds
          ? {
              x: frameSnappedPointer!.x - framePointer.start.x,
              y: frameSnappedPointer!.y - framePointer.start.y,
            }
          : null;
      // 地形合成器是陆地、海域和材质的唯一渲染事实。批量移动预览期间，
      // 需要用临时平移后的文档重建合成器，否则底层陆地仍停在原位，
      // 覆盖材质会看起来像被单独拖走。
      const terrainPreviewMove =
        framePointer?.mode === "move-selection" &&
        framePointer.selectionIds &&
        frameSelectionDelta
          ? {
              ids: framePointer.selectionIds,
              delta: frameSelectionDelta,
            }
          : (framePointer?.mode === "move-stroke" ||
                framePointer?.mode === "move-region") &&
              framePointer.selectedId &&
              frameSnappedPointer
            ? {
                ids: [framePointer.selectedId],
                delta: {
                  x: frameSnappedPointer.x - framePointer.start.x,
                  y: frameSnappedPointer.y - framePointer.start.y,
                },
              }
            : null;
      const terrainPreviewDocument = terrainPreviewMove
        ? moveMapSelectableItems(
            currentDocument,
            terrainPreviewMove.ids,
            terrainPreviewMove.delta,
          )
        : currentDocument;
      const previewSelectionDelta = (itemId: string): MapScenePoint | null => {
        const pointer = framePointer;
        if (
          pointer?.mode !== "move-selection" ||
          !pointer.selectionIds?.includes(itemId) ||
          !frameSelectionDelta
        ) {
          return null;
        }
        return frameSelectionDelta;
      };
      const stampTransformForRender = (
        stamp: MapArtworkStamp,
      ): MapArtworkStampTransform => {
        const pointer = framePointer;
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
          const point = frameSnappedPointer!;
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
              const stampTransform = stampTransformForRender(stamp);
              const size = mapArtworkStampRenderSize(stampTransform, variant);
              if (
                !isWorldCircleVisible(
                  stampTransform,
                  Math.hypot(size.width, size.height) / 2,
                  visibleWorldBounds,
                )
              ) {
                return;
              }
              const image = getArtworkVariantImage(
                imageCacheRef.current,
                variant,
                () => renderRequestRef.current(),
              );
              if (!image) return;
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
      const cachedTerrainSource = terrainSourceKeyRef.current;
      const hasTerrainPreview = terrainPreviewDocument !== currentDocument;
      const terrainSourceKey = hasTerrainPreview
        ? `${mapTerrainCompositeSourceKey(terrainPreviewDocument)}:preview`
        : cachedTerrainSource && cachedTerrainSource.scene === scene
          ? cachedTerrainSource.sourceKey
          : mapTerrainCompositeSourceKey(currentDocument);
      if (!hasTerrainPreview && cachedTerrainSource?.scene !== scene) {
        terrainSourceKeyRef.current = { scene, sourceKey: terrainSourceKey };
      }
      const cachedTerrain = terrainCompositeRef.current;
      if (
        !cachedTerrain ||
        cachedTerrain.sourceKey !== terrainSourceKey ||
        cachedTerrain.width !== currentDocument.canvas.width ||
        cachedTerrain.height !== currentDocument.canvas.height
      ) {
        terrainCompositeRef.current = {
          sourceKey: terrainSourceKey,
          width: currentDocument.canvas.width,
          height: currentDocument.canvas.height,
          composite: createMapTerrainComposite(terrainPreviewDocument),
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
            const selectionDelta = previewSelectionDelta(region.id);
            const moving =
              pointer?.mode === "move-region" &&
              pointer.selectedId === region.id;
            if (
              moving ||
              selectionDelta ||
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
            const selectionDelta = previewSelectionDelta(region.id);
            const snappedPointer = pointer
              ? snapPoint(pointer.last, canvasSettings)
              : null;
            const delta = isMovingRegion
              ? {
                  x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
                  y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
                }
              : selectionDelta;
            const regionPoints = isMovingRegion
              ? pointer.sourcePoints.map((sourcePoint) => ({
                  x: sourcePoint.x + (delta?.x ?? 0),
                  y: sourcePoint.y + (delta?.y ?? 0),
                }))
              : selectionDelta
                ? region.points.map((sourcePoint) => ({
                    x: sourcePoint.x + selectionDelta.x,
                    y: sourcePoint.y + selectionDelta.y,
                  }))
                : isMovingRegionVertex
                  ? replaceMapGeometryVertex(
                      pointer.sourcePoints,
                      pointer.vertexIndex,
                      snapPoint(pointer.last, canvasSettings),
                      currentDocument.canvas,
                    )
                  : region.points;
            if (
              isMovingRegion ||
              selectionDelta ||
              region.id === selectedIdRef.current
            ) {
              drawRegionSelectionOverlay(
                context,
                region,
                regionPoints,
                camera,
                layer.opacity,
                Boolean(isMovingRegion || isMovingRegionVertex),
              );
              if (
                region.id === selectedIdRef.current &&
                !isMapSelectableGroupSelection(currentDocument, [
                  ...selectedIdsRef.current,
                ])
              ) {
                drawFeatureVertexHandles(context, regionPoints, camera);
              }
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
              const selectionDelta = previewSelectionDelta(stroke.id);
              if (
                stroke.id !== selectedIdRef.current &&
                !selectionDelta &&
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
                : selectionDelta;
              const strokePoints = isMovingStroke
                ? pointer.sourcePoints.map((sourcePoint) => ({
                    x: sourcePoint.x + (strokeDelta?.x ?? 0),
                    y: sourcePoint.y + (strokeDelta?.y ?? 0),
                  }))
                : selectionDelta
                  ? stroke.points.map((sourcePoint) => ({
                      x: sourcePoint.x + selectionDelta.x,
                      y: sourcePoint.y + selectionDelta.y,
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
                drawMapBrushPath(context, strokePoints, camera, stroke.curve);
                context.stroke();
              }
              context.restore();
              if (
                strokePoints.length > 1 &&
                !isMapSelectableGroupSelection(currentDocument, [
                  ...selectedIdsRef.current,
                ])
              ) {
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
            const selectionDelta = previewSelectionDelta(stroke.id);
            const snappedPointer = pointer
              ? snapPoint(pointer.last, canvasSettings)
              : null;
            const strokeDelta = isMovingStroke
              ? {
                  x: (snappedPointer?.x ?? pointer.last.x) - pointer.start.x,
                  y: (snappedPointer?.y ?? pointer.last.y) - pointer.start.y,
                }
              : selectionDelta;
            const strokePoints = isMovingStroke
              ? pointer.sourcePoints.map((sourcePoint) => ({
                  x: sourcePoint.x + (strokeDelta?.x ?? 0),
                  y: sourcePoint.y + (strokeDelta?.y ?? 0),
                }))
              : selectionDelta
                ? stroke.points.map((sourcePoint) => ({
                    x: sourcePoint.x + selectionDelta.x,
                    y: sourcePoint.y + selectionDelta.y,
                  }))
                : isMovingStrokeControlPoint
                  ? moveMapSceneStrokeControlPoint(
                      pointer.sourcePoints,
                      pointer.vertexIndex,
                      snapPoint(pointer.last, canvasSettings),
                      currentDocument.canvas,
                    )
                  : stroke.points;
            // 笔触事实保存的是作者控制点，实际盖印/描边必须先按 curve
            // 派生中心线，否则选择“弧线触点”只会改变 JSON 而不会改变画面。
            const renderedStrokePoints = mapBrushCurvePoints(
              strokePoints,
              stroke.curve,
            );
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
              const cachedDabs = artworkBrushDabsRef.current.get(stroke);
              const dabs =
                strokePoints === stroke.points &&
                cachedDabs?.assetId === asset.id &&
                cachedDabs.followPath === asset.brushFollowsPath &&
                cachedDabs.curve === stroke.curve
                  ? cachedDabs.dabs
                  : mapArtworkBrushDabs({
                      id: stroke.id,
                      assetId: asset.id,
                      points: renderedStrokePoints,
                      width: stroke.width,
                      spacing: stroke.spacing,
                      scatter: stroke.scatter,
                      followPath: asset.brushFollowsPath,
                    });
              if (strokePoints === stroke.points && dabs !== cachedDabs?.dabs) {
                artworkBrushDabsRef.current.set(stroke, {
                  assetId: asset.id,
                  followPath: asset.brushFollowsPath,
                  curve: stroke.curve,
                  dabs,
                });
              }
              dabs.forEach((dab) => {
                const variant = getMapArtworkAssetVariantWithColor(
                  asset,
                  mapArtworkVariantIndex(asset, `${stroke.id}:${dab.index}`),
                  stroke.color,
                );
                const size = stroke.width * dab.scale;
                const height = (size * variant.height) / variant.width;
                if (
                  !isWorldCircleVisible(
                    dab,
                    Math.hypot(size, height) / 2,
                    visibleWorldBounds,
                  )
                ) {
                  return;
                }
                if (
                  clipsToLand &&
                  terrainComposite &&
                  !mapTerrainCompositeHasLandAt(terrainComposite, dab)
                ) {
                  return;
                }
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
                    size,
                    height,
                    dab.rotation,
                  );
                }
              });
            } else {
              context.strokeStyle = stroke.color;
              context.lineWidth = Math.max(1, stroke.width * camera.zoom);
              context.lineCap = "round";
              context.lineJoin = "round";
              if (renderedStrokePoints.length === 1) {
                const point = mapToCanvasPoint(
                  renderedStrokePoints[0]!,
                  camera,
                );
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
                drawMapBrushPath(context, strokePoints, camera, stroke.curve);
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
              if (renderedStrokePoints.length === 1) {
                const point = mapToCanvasPoint(
                  renderedStrokePoints[0]!,
                  camera,
                );
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
                drawMapBrushPath(context, strokePoints, camera, stroke.curve);
                context.stroke();
              }
              context.restore();
              if (
                strokePoints.length > 1 &&
                !isMapSelectableGroupSelection(currentDocument, [
                  ...selectedIdsRef.current,
                ])
              ) {
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

      const surfacePointer = pointerRef.current;
      if (
        surfacePointer?.mode === "component-surface-brush" &&
        prefabComponentIdRef.current
      ) {
        const component = MAP_COMPONENT_PRESETS.find(
          (candidate) => candidate.id === prefabComponentIdRef.current,
        );
        if (
          component?.interaction === "surface" &&
          mapComponentPlacement(component) === "overlay"
        ) {
          const rawPoints = [
            ...surfacePointer.points,
            ...(distance(
              surfacePointer.points.at(-1) ?? surfacePointer.start,
              surfacePointer.last,
            ) >= 1
              ? [surfacePointer.last]
              : []),
          ];
          const closed = isMapBrushPathClosed(rawPoints);
          const sampledPoints = resampleMapBrushPoints(
            rawPoints,
            canvasSettings.brushPointCount,
            surfacePointer.curve ?? canvasSettings.brushPointCurve,
            closed,
          );
          const brushCurve =
            surfacePointer.curve ?? canvasSettings.brushPointCurve;
          const areaPoints = createMapComponentSurfaceBrushPoints({
            points: sampledPoints,
            width: canvasSettings.brushSize,
            closed,
          });
          if (areaPoints.length >= 3) {
            const previewFeature: MapFeature = {
              id: `surface-preview:${component.id}`,
              kind: "area",
              name: component.name,
              entityRef: null,
              layerId: activeLayerId,
              points: areaPoints,
              timeFrom: null,
              timeTo: null,
              props: {
                ...component.props,
                curve: brushCurve,
                freehand: "true",
                closed: "true",
              },
              description: component.description,
            };
            context.save();
            context.globalAlpha = 0.58;
            context.fillStyle =
              previewFeature.props.fill ??
              previewFeature.props.color ??
              "#a96d5c66";
            drawMapBrushPath(context, areaPoints, camera, brushCurve, true);
            context.fill();
            context.strokeStyle = previewFeature.props.color ?? "#8b6b4a";
            context.setLineDash([6, 4]);
            context.lineWidth = Math.max(1.5, 2 * camera.zoom);
            context.stroke();
            context.restore();
          }
        }
      }

      const prefabComponentId = isExternalPrefabPreview
        ? (externalDragComponent?.id ?? null)
        : prefabComponentIdRef.current;
      const prefabPointer = pointerRef.current;
      const prefabAnchor =
        isExternalPrefabPreview && externalDragAnchor
          ? externalDragAnchor
          : toolRef.current === "terrain-prefab" && prefabComponentId
            ? prefabPointer?.mode === "place-terrain-prefab"
              ? prefabPointer.last
              : hoverPointRef.current
            : null;
      if (prefabAnchor && prefabComponentId) {
        const component = MAP_COMPONENT_PRESETS.find(
          (candidate) => candidate.id === prefabComponentId,
        );
        if (
          component?.terrainPrefab &&
          mapComponentPlacement(component) === "terrain-prefab"
        ) {
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
              !isExternalPrefabPreview &&
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
              !isExternalPrefabPreview &&
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
            drawMapBrushPath(
              context,
              previewFeature.points,
              camera,
              mapFeatureBrushCurve(previewFeature),
              isMapFeatureFreeformArea(previewFeature.kind),
            );
            context.stroke();
          }
          context.restore();
        }
      }

      drawArtworkStampsForPhase("scene");

      const cachedFeatureRender = featureRenderCacheRef.current;
      const featureRender =
        cachedFeatureRender?.features === currentDocument.features &&
        cachedFeatureRender.layers === currentDocument.layers
          ? cachedFeatureRender
          : {
              features: currentDocument.features,
              layers: currentDocument.layers,
              renderOrder: mapFeaturesInRenderOrder(currentDocument),
              boundsById: new Map(
                currentDocument.features.map((feature) => [
                  feature.id,
                  regionBounds(feature.points),
                ]),
              ),
              layersById: new Map(
                currentDocument.layers.map((layer) => [layer.id, layer]),
              ),
            };
      if (featureRender !== cachedFeatureRender) {
        featureRenderCacheRef.current = featureRender;
      }
      const zoomBucket = Math.round(camera.zoom * 20) / 20;
      const cachedLabelPlacements = labelPlacementCacheRef.current;
      const labelPlacements =
        cachedLabelPlacements?.features === currentDocument.features &&
        cachedLabelPlacements.zoomBucket === zoomBucket
          ? cachedLabelPlacements.placements
          : resolveMapLabelPlacements(featureRender.renderOrder, {
              zoom: zoomBucket,
            });
      if (
        !cachedLabelPlacements ||
        cachedLabelPlacements.features !== currentDocument.features ||
        cachedLabelPlacements.zoomBucket !== zoomBucket
      ) {
        labelPlacementCacheRef.current = {
          features: currentDocument.features,
          zoomBucket,
          placements: labelPlacements,
        };
      }
      const hasAzgaarBaseMap = Boolean(
        isMapBackgroundImageVisible(currentDocument.canvas) &&
          (currentDocument.canvas.backgroundImage ||
            currentDocument.canvas.backgroundAssetPath),
      );
      featureRender.renderOrder.forEach((feature) => {
        const layer = featureRender.layersById.get(feature.layerId);
        if (
          !layer?.visible ||
          (timelineCursor !== null &&
            ((feature.timeFrom !== null && timelineCursor < feature.timeFrom) ||
              (feature.timeTo !== null && timelineCursor > feature.timeTo)))
        ) {
          return;
        }
        const opacity = layer.opacity;
        const pointer = framePointer;
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
        const delta = isMovingFeature
          ? {
              x: (frameSnappedPointer?.x ?? pointer.last.x) - pointer.start.x,
              y: (frameSnappedPointer?.y ?? pointer.last.y) - pointer.start.y,
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
                  frameSnappedPointer!,
                  currentDocument.canvas,
                )
              : feature.points;
        if (points.length === 0) return;
        const lineWidth = Number(feature.props.lineWidth ?? 0);
        const cullPadding =
          feature.kind === "label"
            ? 512
            : Math.max(
                96,
                (Number.isFinite(lineWidth) ? Math.max(0, lineWidth) : 0) / 2 +
                  32,
              );
        const usesPreviewGeometry = Boolean(
          isMovingFeature || movingSelectionDelta || isMovingFeatureVertex,
        );
        if (
          usesPreviewGeometry
            ? !mapScenePointsIntersectViewport(
                points,
                visibleWorldBounds,
                cullPadding,
              )
            : !mapSceneBoundsIntersectViewport(
                featureRender.boundsById.get(feature.id) ??
                  regionBounds(points),
                visibleWorldBounds,
                cullPadding,
              )
        ) {
          return;
        }
        const asset =
          feature.kind === "marker"
            ? assetCatalogRef.current.get(feature.props.component ?? "")
            : undefined;
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
          drawMapBrushPath(
            context,
            points,
            camera,
            mapFeatureBrushCurve(feature),
            isMapFeatureFreeformArea(feature.kind) ||
              feature.props.closed === "true",
          );
          if (isMapFeatureFreeformArea(feature.kind)) {
            const areaStyle = getMapFeatureAreaStyle(feature);
            context.closePath();
            context.fillStyle = areaStyle.fill;
            context.globalAlpha = opacity * areaStyle.opacity;
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
          drawMapFeatureLabel(
            context,
            feature,
            points,
            camera,
            opacity,
            labelPlacements.get(feature.id),
          );
        }
        if (feature.id === selectedIdRef.current) {
          drawMapFeatureSelectionOutline(context, feature, points, camera);
          if (
            isMapFeatureVertexEditable(feature.kind) &&
            !isMapSelectableGroupSelection(currentDocument, [
              ...selectedIdsRef.current,
            ])
          ) {
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
            if (
              !isMapSelectableGroupSelection(currentDocument, [
                ...selectedIdsRef.current,
              ])
            ) {
              drawArtworkStampTransform(context, stampTransform, size, camera);
            }
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
        currentDocument.scene?.layers.forEach((layer) => {
          layer.strokes.forEach((stroke) => {
            if (!selectedIds.has(stroke.id) || stroke.points.length === 0) {
              return;
            }
            const delta = previewSelectionDelta(stroke.id);
            const points = delta
              ? stroke.points.map((point) => ({
                  x: point.x + delta.x,
                  y: point.y + delta.y,
                }))
              : stroke.points;
            const bounds = regionBounds(points);
            const padding = Math.max(12, stroke.width / 2);
            includeBounds({
              left: bounds.left - padding,
              right: bounds.right + padding,
              top: bounds.top - padding,
              bottom: bounds.bottom + padding,
            });
          });
          layer.regions.forEach((region) => {
            if (!selectedIds.has(region.id) || region.points.length === 0) {
              return;
            }
            const delta = previewSelectionDelta(region.id);
            const points = delta
              ? region.points.map((point) => ({
                  x: point.x + delta.x,
                  y: point.y + delta.y,
                }))
              : region.points;
            includeBounds(regionBounds(points));
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
        externalDragAnchor && stampPlacementAssetId === externalDragAsset?.id
          ? externalDragAnchor
          : placementPointer?.mode === "place-stamp"
            ? placementPointer.last
            : toolRef.current === "artwork-stamp" && stampPlacementAssetId
              ? hoverPointRef.current
              : null;
      if (placementPoint && stampPlacementAssetId) {
        const asset = assetCatalogRef.current.get(stampPlacementAssetId);
        if (asset) {
          const variant = getMapArtworkAssetVariant(asset, 0);
          const placementGesture =
            stampPlacementAssetId !== externalDragAsset?.id &&
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
      const pointerCurve = pointer?.curve ?? canvasSettings.brushPointCurve;
      const pointerAreaShape = pointer?.areaShape ?? canvasSettings.areaShape;
      const polygonPoints =
        pointer?.mode === "polygon"
          ? [
              ...pointer.points,
              ...(distance(
                pointer.points.at(-1) ?? pointer.start,
                pointer.last,
              ) >= 1
                ? [pointer.last]
                : []),
            ]
          : [
              ...polygonDraftRef.current,
              ...(polygonHoverRef.current &&
              distance(
                polygonDraftRef.current.at(-1) ?? polygonHoverRef.current,
                polygonHoverRef.current,
              ) >= 1
                ? [polygonHoverRef.current]
                : []),
            ];
      const polygonPreviewClosed = isPolygonClosePoint(
        polygonPoints,
        polygonPoints.at(-1) ?? polygonPoints[0]!,
      );
      const polygonPreviewPoints = polygonPreviewClosed
        ? polygonPoints.slice(0, -1)
        : polygonPoints;
      if (
        toolRef.current === "polygon" &&
        polygonPreviewPoints.length >= 1 &&
        (polygonDraftRef.current.length > 0 || pointer?.mode === "polygon")
      ) {
        context.save();
        context.globalAlpha = 0.9;
        context.strokeStyle = "#c75436";
        context.lineWidth = 2;
        context.setLineDash([5, 4]);
        drawMapBrushPath(
          context,
          polygonPreviewPoints,
          camera,
          pointerCurve,
          polygonPreviewClosed,
        );
        context.stroke();
        context.setLineDash([]);
        polygonPreviewPoints.forEach((polygonPoint, index) => {
          const point = mapToCanvasPoint(polygonPoint, camera);
          context.beginPath();
          context.arc(
            point.x,
            point.y,
            index === polygonPreviewPoints.length - 1 ? 5 : 3.5,
            0,
            Math.PI * 2,
          );
          context.fillStyle =
            index === polygonPreviewPoints.length - 1
              ? "#c75436"
              : "#fffaf1";
          context.fill();
          context.strokeStyle = "#c75436";
          context.stroke();
        });
        context.restore();
      }
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
            assetId: asset.id,
            points: mapBrushCurvePoints(pointer.points, pointerCurve),
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
          const previewCurvePoints = mapBrushCurvePoints(
            previewPoints,
            pointerCurve,
          );
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
          if (pointer.mode === "terrain-material" && terrainComposite) {
            const materialSurface = terrainMaterialSurface(
              terrainMaterialRef.current,
            );
            mapTerrainBrushCoverageDabs({
              id: "terrain-brush-preview",
              points: previewCurvePoints,
              width: canvasSettings.brushSize,
              spacing: canvasSettings.brushSpacing,
              shape: canvasSettings.terrainBrushShape,
            }).forEach((dab) => {
              if (
                !mapTerrainCompositeHasSurfaceAt(
                  terrainComposite,
                  dab,
                  materialSurface,
                )
              ) {
                return;
              }
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
          } else if (canvasSettings.terrainBrushShape === "organic") {
            mapTerrainBrushDabs({
              id: "terrain-brush-preview",
              points: previewCurvePoints,
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
          } else if (previewCurvePoints.length === 1) {
            const point = mapToCanvasPoint(previewCurvePoints[0]!, camera);
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
            drawMapBrushPath(context, previewCurvePoints, camera, pointerCurve);
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
        const pointerTool = pointer.drawTool ?? toolRef.current;
        const isRegionPreview = pointer.mode === "region";
        const isAreaPreview =
          pointer.mode === "draw" &&
          (pointerTool === "area" || pointerTool === "freehand");
        const isRoutePreview =
          pointer.mode === "draw" &&
          (pointerTool === "route" || pointerTool === "river");
        const isLand = pointer.regionKind === "land";
        context.strokeStyle = isAreaPreview
          ? "#c75436"
          : isRegionPreview && isLand
            ? "#5c5038"
            : isRegionPreview
              ? "#2f6377"
              : "#c75436";
        context.lineWidth = 2;
        context.setLineDash([5, 4]);
        const areaShape = pointerAreaShape;
        const isFreehandAreaPreview =
          isAreaPreview &&
          (areaShape === "freehand" || pointerTool === "freehand");
        const previewUsesHandDrawnPath =
          isAreaPreview &&
          (pointerTool === "freehand" ||
            areaShape === "closed" ||
            areaShape === "freehand");
        const previewRawPoints = previewUsesHandDrawnPath
          ? [
              ...pointer.points,
              ...(distance(
                pointer.points.at(-1) ?? pointer.start,
                pointer.last,
              ) >= 1
                ? [pointer.last]
                : []),
            ]
          : pointer.points;
        const previewRoutePoints = isRoutePreview
          ? resampleMapBrushPoints(
              [
                ...pointer.points,
                ...(distance(
                  pointer.points.at(-1) ?? pointer.start,
                  pointer.last,
                ) >= 1
                  ? [pointer.last]
                  : []),
              ],
              canvasSettings.brushPointCount,
              pointerCurve,
              false,
            )
          : pointer.points;
        const freehandPreviewClosed =
          isFreehandAreaPreview && isMapBrushPathClosed(previewRawPoints);
        const areaPoints =
          isAreaPreview &&
          areaShape !== "closed" &&
          areaShape !== "polygon" &&
          areaShape !== "freehand"
            ? createMapAreaShapePoints(areaShape, pointer.start, pointer.last)
            : previewUsesHandDrawnPath
              ? resampleMapBrushPoints(
                  previewRawPoints,
                  canvasSettings.brushPointCount,
                  pointerCurve,
                  isMapBrushPathClosed(previewRawPoints),
                )
              : pointer.points;
        if (
          isAreaPreview &&
          areaPoints.length >= 3 &&
          (!isFreehandAreaPreview || freehandPreviewClosed)
        ) {
          drawMapBrushPath(context, areaPoints, camera, pointerCurve, true);
          context.fillStyle = "#c7543633";
          context.globalAlpha = 0.3;
          context.fill();
          context.globalAlpha = 0.8;
          context.stroke();
        } else if (isAreaPreview && areaPoints.length >= 2) {
          drawMapBrushPath(context, areaPoints, camera, pointerCurve);
          context.stroke();
        } else if (isRegionPreview && pointer.points.length >= 3) {
          drawMapSceneRegionPath(context, pointer.points, camera, pointerCurve);
          context.fillStyle = isLand ? "#b8ad7d" : "#5d92a5";
          context.globalAlpha = 0.36;
          context.fill();
          context.globalAlpha = 0.8;
          context.stroke();
        } else if (isRoutePreview && previewRoutePoints.length >= 2) {
          const previewFeature: MapFeature = {
            id: "route-preview",
            kind: "route",
            name: pointerTool === "river" ? "新河流" : "新路线",
            entityRef: null,
            layerId: activeLayerId,
            points: previewRoutePoints,
            timeFrom: null,
            timeTo: null,
            props:
              pointerTool === "river"
                ? {
                    ...DEFAULT_MAP_RIVER_PROPS,
                    curve: pointerCurve,
                  }
                : { curve: pointerCurve },
            description: "",
          };
          context.save();
          context.globalAlpha = 0.82;
          if (pointerTool === "river") {
            drawTaperedRiver(
              context,
              previewFeature,
              previewRoutePoints,
              camera,
              0.82,
            );
          } else {
            context.strokeStyle = "#c75436";
            context.lineWidth = 2;
            context.lineCap = "round";
            context.lineJoin = "round";
            drawMapBrushPath(context, previewRoutePoints, camera, pointerCurve);
            context.stroke();
          }
          context.restore();
        } else {
          drawPath(context, pointer.points, camera);
          context.stroke();
        }
        context.restore();
      }

      if (
        pointer?.mode === "component-path-brush" &&
        pointer.points.length > 0
      ) {
        const component = prefabComponentIdRef.current
          ? MAP_COMPONENT_PRESETS.find(
              (candidate) => candidate.id === prefabComponentIdRef.current,
            )
          : undefined;
        const previewPoints =
          distance(pointer.points[pointer.points.length - 1]!, pointer.last) >=
          1
            ? [...pointer.points, pointer.last]
            : pointer.points;
        const routePoints =
          previewPoints.length >= 2
            ? previewPoints
            : [
                previewPoints[0]!,
                { x: previewPoints[0]!.x + 1, y: previewPoints[0]!.y + 1 },
              ];
        const previewFeature: MapFeature = {
          id: "path-brush-preview",
          kind: "route",
          name: component ? `未命名${component.name}` : "新路线",
          entityRef: null,
          layerId: activeLayerId,
          points: routePoints,
          timeFrom: null,
          timeTo: null,
          props: {
            ...(component?.props ?? {}),
            // 预览必须与松开鼠标后保存的路线使用同一曲线模式，
            // 否则弧线选项只在提交后才突然改变形状。
            curve: pointerCurve,
          },
          description: component?.description ?? "",
        };
        context.save();
        context.globalAlpha = 0.8;
        if (
          !drawMapStyledRoute(context, previewFeature, routePoints, camera, 0.8)
        ) {
          context.strokeStyle = component?.props.color ?? "#7c684f";
          context.lineWidth = Math.max(
            1.5,
            Number(component?.props.lineWidth ?? 3) * camera.zoom,
          );
          context.lineCap = "round";
          context.lineJoin = "round";
          // 普通路径构件没有专用路线样式时，也必须走同一条曲线渲染链。
          // 之前这里直接连接原始触点，导致弧线模式只有松手后才改变，
          // 实际创作时看起来像弧线没有生效。
          drawMapBrushPath(context, routePoints, camera, pointerCurve);
          context.stroke();
        }
        context.restore();
      }

      const hoverPoint = hoverPointRef.current;
      if (
        !pointer &&
        hoverPoint &&
        (isExternalBrushPreview ||
          toolRef.current === "terrain-land" ||
          toolRef.current === "terrain-water" ||
          toolRef.current === "terrain-material" ||
          toolRef.current === "scene-eraser" ||
          toolRef.current === "artwork-brush")
      ) {
        const artworkBrushAsset = isExternalBrushPreview
          ? externalDragAsset
          : toolRef.current === "artwork-brush" && brushAssetRef.current
            ? assetCatalogRef.current.get(brushAssetRef.current)
            : undefined;
        if (artworkBrushAsset) {
          const clipsToLand = mapSceneLayerBrushClipsToLand(
            isExternalBrushPreview && externalDragComponent
              ? sceneLayerKindForComponentCategory(
                  externalDragComponent.category,
                )
              : brushLayerKindRef.current,
          );
          context.save();
          context.globalAlpha = 0.52 * canvasSettings.brushOpacity;
          mapArtworkBrushDabs({
            id: `brush-hover:${artworkBrushAsset.id}`,
            assetId: artworkBrushAsset.id,
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
              isExternalBrushPreview
                ? artworkBrushAsset.color
                : (brushColorRef.current ?? artworkBrushAsset.color),
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
          const materialSurface = terrainMaterialSurface(
            terrainMaterialRef.current,
          );
          mapTerrainBrushDabs({
            id: "terrain-brush-hover",
            points: [hoverPoint],
            width: canvasSettings.brushSize,
            spacing: canvasSettings.brushSpacing,
            shape: canvasSettings.terrainBrushShape,
          }).forEach((dab) => {
            if (
              toolRef.current === "terrain-material" &&
              terrainComposite &&
              !mapTerrainCompositeHasSurfaceAt(
                terrainComposite,
                dab,
                materialSurface,
              )
            ) {
              return;
            }
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
          navigatorBackground,
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
    if (tool !== "polygon") {
      polygonDraftRef.current = [];
      polygonHoverRef.current = null;
      if (pointerRef.current?.mode === "polygon") {
        pointerRef.current = null;
      }
    }
    if (tool !== "artwork-stamp" && tool !== "terrain-prefab") {
      hoverPointRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor =
        tool === "select"
          ? "default"
          : tool === "move" || tool === "pan"
            ? "grab"
            : "crosshair";
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
      dropScreenPointRef.current = null;
      externalDragAssetIdRef.current = null;
      if (dropAutoPanFrameRef.current !== null) {
        window.cancelAnimationFrame(dropAutoPanFrameRef.current);
        dropAutoPanFrameRef.current = null;
      }
    };
  }, [requestRender]);

  useEffect(() => {
    const cancelExternalDrop = () => {
      dropScreenPointRef.current = null;
      externalDragAssetIdRef.current = null;
      hoverPointRef.current = null;
      if (dropAutoPanFrameRef.current !== null) {
        window.cancelAnimationFrame(dropAutoPanFrameRef.current);
        dropAutoPanFrameRef.current = null;
      }
      renderRequestRef.current();
    };
    window.addEventListener("dragend", cancelExternalDrop);
    window.addEventListener("blur", cancelExternalDrop);
    return () => {
      window.removeEventListener("dragend", cancelExternalDrop);
      window.removeEventListener("blur", cancelExternalDrop);
    };
  }, []);

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
      pointer.mode === "component-path-brush" ||
      pointer.mode === "draw" ||
      pointer.mode === "region"
    ) {
      const nextPoint =
        pointer.mode === "draw" ||
        pointer.mode === "region" ||
        pointer.mode === "component-path-brush"
          ? snapPoint(point, settingsRef.current)
          : point;
      const drawTool = pointer.drawTool ?? toolRef.current;
      const isFixedAreaShape =
        pointer.mode === "draw" &&
        drawTool === "area" &&
        pointer.areaShape !== "closed" &&
        pointer.areaShape !== "freehand";
      // 自由画笔必须保留微小弯折；与普通路线共用 8 世界单位阈值会
      // 把小弯中间的指针点全部丢掉，最终只剩起点和终点。自由画笔
      // 只去除重复坐标，最终落地仍由 brushPointCount 控制数据规模。
      const isFreehandPath =
        pointer.mode === "draw" &&
        (drawTool === "freehand" || pointer.areaShape === "freehand");
      const previousPoint = pointer.points.at(-1) ?? pointer.start;
      if (
        !isFixedAreaShape &&
        (isFreehandPath
          ? distance(previousPoint, nextPoint) > 0
          : distance(pointer.last, nextPoint) >= 8)
      ) {
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

  const stopDropAutoPan = () => {
    dropScreenPointRef.current = null;
    if (dropAutoPanFrameRef.current === null) return;
    window.cancelAnimationFrame(dropAutoPanFrameRef.current);
    dropAutoPanFrameRef.current = null;
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

  const startDropAutoPan = () => {
    if (dropAutoPanFrameRef.current !== null) return;
    const tick = () => {
      dropAutoPanFrameRef.current = null;
      const screenPoint = dropScreenPointRef.current;
      const canvas = canvasRef.current;
      if (!screenPoint || !canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const width =
        Number.isFinite(bounds.width) && bounds.width > 0
          ? bounds.width
          : documentRef.current.canvas.width;
      const height =
        Number.isFinite(bounds.height) && bounds.height > 0
          ? bounds.height
          : documentRef.current.canvas.height;
      const nextCamera = autoPanMapSceneCameraAtEdge(
        cameraRef.current,
        screenPoint,
        { width, height },
      );
      if (nextCamera === cameraRef.current) return;
      cameraRef.current = nextCamera;
      const clientX =
        (Number.isFinite(bounds.left) ? bounds.left : 0) + screenPoint.x;
      const clientY =
        (Number.isFinite(bounds.top) ? bounds.top : 0) + screenPoint.y;
      hoverPointRef.current = pointFromEvent({ clientX, clientY });
      requestRender();
      dropAutoPanFrameRef.current = window.requestAnimationFrame(tick);
    };
    dropAutoPanFrameRef.current = window.requestAnimationFrame(tick);
  };

  const hitSelectedArtworkTransform = (point: MapScenePoint) => {
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const currentDocument = documentRef.current;
    if (
      isMapSelectableGroupSelection(currentDocument, [
        ...selectedIdsRef.current,
      ])
    ) {
      return null;
    }
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
    if (
      isMapSelectableGroupSelection(currentDocument, [
        ...selectedIdsRef.current,
      ])
    ) {
      return null;
    }
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
    if (
      isMapSelectableGroupSelection(currentDocument, [
        ...selectedIdsRef.current,
      ])
    ) {
      return null;
    }
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
    if (
      isMapSelectableGroupSelection(currentDocument, [
        ...selectedIdsRef.current,
      ])
    ) {
      return null;
    }
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

  const hitTestCandidates = (
    point: MapScenePoint,
  ): Array<{
    readonly type: "stamp" | "feature" | "stroke" | "region";
    readonly id: string;
    readonly sourcePoints?: readonly MapScenePoint[];
  }> => {
    const currentDocument = documentRef.current;
    const hits: Array<{
      readonly type: "stamp" | "feature" | "stroke" | "region";
      readonly id: string;
      readonly sourcePoints?: readonly MapScenePoint[];
    }> = [];
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
              hits.push({ type: "stamp", id: stamp.id });
            }
          }
        }
      }
    };
    hitArtworkStamps(["overlay", "feature"]);
    for (const feature of [
      ...mapFeaturesInRenderOrder(currentDocument),
    ].reverse()) {
      const layer = currentDocument.layers.find(
        (item) => item.id === feature.layerId,
      );
      if (!layer?.visible || layer.locked) continue;
      if (hitMapFeatureGeometry(feature, point, cameraRef.current.zoom)) {
        hits.push({
          type: "feature",
          id: feature.id,
          sourcePoints: feature.points,
        });
      }
    }
    hitArtworkStamps(["scene"]);
    if (currentDocument.scene) {
      for (const layer of [...currentDocument.scene.layers].reverse()) {
        if (!layer.visible || layer.locked) continue;
        for (const stroke of [...layer.strokes].reverse()) {
          const threshold = Math.max(10, stroke.width * 0.5 + 8);
          if (distanceToPath(point, stroke.points) <= threshold) {
            hits.push({
              type: "stroke",
              id: stroke.id,
              sourcePoints: stroke.points,
            });
          }
        }
        for (const region of [...layer.regions].reverse()) {
          if (pointInPolygon(point, region.points)) {
            hits.push({
              type: "region",
              id: region.id,
              sourcePoints: region.points,
            });
          }
        }
      }
    }
    hitArtworkStamps(["base"]);
    return hits;
  };

  const hitTest = (
    point: MapScenePoint,
  ): {
    readonly type: "stamp" | "feature" | "stroke" | "region";
    readonly id: string;
    readonly sourcePoints?: readonly MapScenePoint[];
  } | null => {
    return hitTestCandidates(point)[0] ?? null;
  };

  const setCanvasSelection = (
    ids: readonly string[],
    primaryId: string | null,
  ) => {
    const next = expandMapSelectableItemIds(documentRef.current, ids);
    const primary =
      primaryId && next.includes(primaryId) ? primaryId : (next.at(-1) ?? null);
    selectedIdsRef.current = new Set(next);
    // 父组件的选择回传是异步的，但下一次手势必须立即看到新的主选择及其顶点、变换手柄。
    selectedIdRef.current = primary;
    if (onSelectionChange) {
      onSelectionChange(next, primary);
    } else {
      onSelect(primary);
    }
    requestRender();
  };

  const findMaterialLandPair = (
    candidates: readonly { readonly id: string }[],
  ): readonly [string, string] | null => {
    const currentDocument = documentRef.current;
    const materialId = candidates.find((candidate) =>
      currentDocument.scene?.layers.some((layer) =>
        layer.strokes.some(
          (stroke) =>
            stroke.id === candidate.id &&
            isMapTerrainMaterialStroke(layer.kind, stroke),
        ),
      ),
    )?.id;
    if (!materialId) return null;
    const landId = candidates.find((candidate) => {
      if (candidate.id === materialId) return false;
      return currentDocument.scene?.layers.some(
        (layer) =>
          layer.regions.some(
            (region) => region.id === candidate.id && region.kind === "land",
          ) ||
          layer.strokes.some(
            (stroke) =>
              stroke.id === candidate.id &&
              stroke.tool === "paint" &&
              isMapTerrainMaskStroke(layer.kind, stroke),
          ),
      );
    })?.id;
    return landId ? [materialId, landId] : null;
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (toolRef.current === "polygon") {
      event.stopPropagation();
      if (polygonDraftRef.current.length > 0) {
        commitPolygonDraft(
          snapPoint(pointFromEvent(event), settingsRef.current),
        );
      }
      return;
    }
    const point = pointFromEvent(event);
    const hit = hitTest(point);
    if (!hit) {
      setContextMenu(null);
      setCanvasSelection([], null);
      return;
    }
    const selectedIds = selectedIdsRef.current;
    const itemIds = selectedIds.has(hit.id)
      ? [...selectedIds]
      : expandMapSelectableItemIds(documentRef.current, [hit.id]);
    if (!selectedIds.has(hit.id)) {
      setCanvasSelection(itemIds, hit.id);
    }
    const candidates = hitTestCandidates(point);
    const group = findMapSelectableGroup(documentRef.current, hit.id);
    const rootBounds = rootRef.current?.getBoundingClientRect();
    setContextMenu({
      x: Math.max(8, event.clientX - (rootBounds?.left ?? 0)),
      y: Math.max(8, event.clientY - (rootBounds?.top ?? 0)),
      itemIds,
      groupId: group?.id ?? null,
      isCompleteGroup: isMapSelectableGroupSelection(
        documentRef.current,
        itemIds,
      ),
      materialLandPair: findMaterialLandPair(candidates),
    });
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
    currentDocument.scene?.layers.forEach((layer) => {
      if (!isEditableLayer(layer)) return;
      layer.strokes.forEach((stroke) => {
        const padding = Math.max(12, stroke.width / 2);
        const candidate = regionBounds(stroke.points);
        if (
          intersects({
            left: candidate.left - padding,
            right: candidate.right + padding,
            top: candidate.top - padding,
            bottom: candidate.bottom + padding,
          })
        ) {
          ids.push(stroke.id);
        }
      });
      layer.regions.forEach((region) => {
        const candidate = regionBounds(region.points);
        if (intersects(candidate)) ids.push(region.id);
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
    if (toolRef.current === "move") {
      canvas.style.cursor = hitTest(point) ? "grab" : "default";
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
        curve: settingsRef.current.brushPointCurve,
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
    if (
      currentTool === "component-path-brush" &&
      prefabComponentIdRef.current &&
      event.button === 0
    ) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "component-path-brush",
        start: snappedPoint,
        last: snappedPoint,
        points: [snappedPoint],
        selectedId: null,
        curve: settingsRef.current.brushPointCurve,
      };
      requestRender();
      return;
    }
    if (
      currentTool === "component-surface-brush" &&
      prefabComponentIdRef.current &&
      event.button === 0
    ) {
      const component = MAP_COMPONENT_PRESETS.find(
        (candidate) => candidate.id === prefabComponentIdRef.current,
      );
      if (
        !component ||
        component.interaction !== "surface" ||
        mapComponentPlacement(component) !== "overlay"
      ) {
        return;
      }
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "component-surface-brush",
        start: snappedPoint,
        last: snappedPoint,
        points: [snappedPoint],
        selectedId: null,
        curve: settingsRef.current.brushPointCurve,
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
        curve: settingsRef.current.brushPointCurve,
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
        curve: settingsRef.current.brushPointCurve,
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
        curve: settingsRef.current.brushPointCurve,
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
        curve: settingsRef.current.brushPointCurve,
      };
      requestRender();
      return;
    }
    if (currentTool === "move") {
      if (event.button !== 0) return;
      const hit = hitTest(point);
      if (!hit) return;
      event.preventDefault();
      const selectedIds = selectedIdsRef.current;
      const hitGroupIds = expandMapSelectableItemIds(documentRef.current, [
        hit.id,
      ]);
      const movingSelection =
        Boolean(onBatchMove) &&
        ((selectedIds.size > 1 && selectedIds.has(hit.id)) ||
          hitGroupIds.length > 1);
      if (!selectedIds.has(hit.id)) {
        setCanvasSelection(hitGroupIds, hit.id);
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
        selectionIds: movingSelection
          ? selectedIds.has(hit.id)
            ? [...selectedIds]
            : hitGroupIds
          : undefined,
      };
      canvas.style.cursor = "grabbing";
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
        // 覆盖层与底层地貌可能命中同一点。Shift 点击时优先追加当前
        // 选区尚未包含的下一层对象，允许把材质笔触和陆地底稿一起选中；
        // 当该点的候选对象都已选中时，再按原语义移除最上层对象。
        const candidates = hitTestCandidates(point);
        const nextHit =
          candidates.find((candidate) => !selectedIds.has(candidate.id)) ?? hit;
        const nextHitGroupIds = new Set(
          expandMapSelectableItemIds(documentRef.current, [nextHit.id]),
        );
        const next = selectedIds.has(nextHit.id)
          ? [...selectedIds].filter((id) => !nextHitGroupIds.has(id))
          : [...selectedIds, ...nextHitGroupIds];
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
    if (currentTool === "polygon" && event.button === 0) {
      event.preventDefault();
      const snappedPoint = snapPoint(point, settingsRef.current);
      const draft = polygonDraftRef.current;
      if (isPolygonClosePoint(draft, snappedPoint)) {
        commitPolygonDraft(snappedPoint, true);
        return;
      }
      polygonHoverRef.current = snappedPoint;
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = {
        pointerId: event.pointerId,
        mode: "polygon",
        start: draft.at(-1) ?? snappedPoint,
        last: snappedPoint,
        points: [...draft],
        selectedId: null,
        curve: settingsRef.current.brushPointCurve,
      };
      requestRender();
      return;
    }
    if (
      event.button === 0 &&
      (currentTool === "marker" ||
        currentTool === "label" ||
        currentTool === "node" ||
        currentTool === "route" ||
        currentTool === "river" ||
        currentTool === "area" ||
        currentTool === "freehand")
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
        areaShape:
          currentTool === "freehand"
            ? "freehand"
            : settingsRef.current.areaShape,
        drawTool: currentTool,
        curve: settingsRef.current.brushPointCurve,
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
      } else if (
        toolRef.current === "polygon" &&
        polygonDraftRef.current.length > 0
      ) {
        polygonHoverRef.current = snapPoint(point, settingsRef.current);
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
    // 统一使用当前画笔的触点模式生成事实数据。此前这里硬编码为 line，
    // 导致弧线选项只写入了 curve 属性，而素材、地形和路径的落图仍是折线。
    // 渲染器仍会读取 curve 进行最终绘制，因此同一条笔触在预览、落图、导出
    // 和重新打开后保持一致。
    const controlPointCurve =
      pointer.curve ?? settingsRef.current.brushPointCurve;
    if (pointer.mode === "polygon") {
      const snappedPoint = snapPoint(point, settingsRef.current);
      const previous = polygonDraftRef.current.at(-1);
      if (!previous || distance(previous, snappedPoint) >= 3) {
        polygonDraftRef.current = [
          ...polygonDraftRef.current,
          snappedPoint,
        ];
      }
      polygonHoverRef.current = snappedPoint;
    } else if (pointer.mode === "brush" && brushAssetRef.current) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      onSceneStroke(
        brushAssetRef.current,
        resampleMapBrushPointsBySpacing(
          pointer.points,
          settingsRef.current.brushSpacing,
          controlPointCurve,
        ),
      );
    } else if (
      pointer.mode === "terrain-land" ||
      pointer.mode === "terrain-water"
    ) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      onTerrainStroke(
        pointer.mode === "terrain-water" ? "water" : "land",
        resampleMapBrushPointsBySpacing(
          pointer.points,
          settingsRef.current.brushSpacing,
          controlPointCurve,
        ),
      );
    } else if (
      pointer.mode === "terrain-material" &&
      terrainMaterialRef.current
    ) {
      if (distance(pointer.points[pointer.points.length - 1]!, point) >= 8) {
        pointer.points.push(point);
      }
      const points = resampleMapBrushPointsBySpacing(
        pointer.points,
        settingsRef.current.brushSpacing,
        controlPointCurve,
      );
      const materialCoveragePoints = resampleMapBrushPointsBySpacing(
        pointer.points,
        settingsRef.current.brushSpacing,
        controlPointCurve,
      );
      const scene = currentDocument.scene;
      const cachedTerrainSource = terrainSourceKeyRef.current;
      const terrainSourceKey =
        cachedTerrainSource && cachedTerrainSource.scene === scene
          ? cachedTerrainSource.sourceKey
          : mapTerrainCompositeSourceKey(currentDocument);
      if (cachedTerrainSource?.scene !== scene) {
        terrainSourceKeyRef.current = { scene, sourceKey: terrainSourceKey };
      }
      const cachedTerrain = terrainCompositeRef.current;
      const hasCachedTerrain = Boolean(
        cachedTerrain &&
          cachedTerrain.sourceKey === terrainSourceKey &&
          cachedTerrain.width === currentDocument.canvas.width &&
          cachedTerrain.height === currentDocument.canvas.height,
      );
      const terrainComposite = hasCachedTerrain
        ? cachedTerrain!.composite
        : createMapTerrainComposite(currentDocument);
      if (!hasCachedTerrain) {
        terrainCompositeRef.current = {
          sourceKey: terrainSourceKey,
          width: currentDocument.canvas.width,
          height: currentDocument.canvas.height,
          composite: terrainComposite,
        };
      }
      const materialSurface = terrainMaterialSurface(
        terrainMaterialRef.current,
      );
      const intersectsSurface =
        terrainComposite !== null &&
        mapTerrainCompositeIntersectsBrush(
          terrainComposite,
          {
            id: "terrain-material-preview",
            points: materialCoveragePoints,
            width: settingsRef.current.brushSize,
            spacing: settingsRef.current.brushSpacing,
            shape: settingsRef.current.terrainBrushShape,
          },
          materialSurface,
        );
      if (intersectsSurface) {
        onTerrainMaterialStroke(terrainMaterialRef.current, points);
      } else {
        onTerrainMaterialRejected?.();
      }
    } else if (pointer.mode === "erase") {
      if (
        pointer.points.length === 1 &&
        distance(pointer.points[0]!, point) >= 8
      ) {
        pointer.points.push(point);
      }
      onSceneErase(
        resampleMapBrushPointsBySpacing(
          pointer.points,
          settingsRef.current.brushSpacing,
          // 橡皮擦是一次性的命中操作，不会把轨迹保存进文档；这里直接
          // 使用弧线采样，保证擦除命中的是画布上实际看到的中心线。
          controlPointCurve,
        ),
      );
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
      pointer.mode === "component-path-brush" &&
      prefabComponentIdRef.current
    ) {
      const component = MAP_COMPONENT_PRESETS.find(
        (candidate) => candidate.id === prefabComponentIdRef.current,
      );
      if (component?.interaction === "path") {
        const snappedPoint = snapPoint(point, settingsRef.current);
        if (
          distance(pointer.points[pointer.points.length - 1]!, snappedPoint) >=
          8
        ) {
          pointer.points.push(snappedPoint);
        }
        const points = pointer.points.filter(
          (drawPoint, index, source) =>
            index === 0 || distance(drawPoint, source[index - 1]!) >= 4,
        );
        const sampledPoints = resampleMapBrushPoints(
          points,
          settingsRef.current.brushPointCount,
          controlPointCurve,
          false,
        );
        const routePoints =
          sampledPoints.length >= 2
            ? sampledPoints
            : [
                sampledPoints[0] ?? points[0]!,
                {
                  x: (sampledPoints[0] ?? points[0]!).x + 1,
                  y: (sampledPoints[0] ?? points[0]!).y + 1,
                },
              ];
        const componentProps: Record<string, string> = {
          ...component.props,
          curve: controlPointCurve,
        };
        onCreate({
          id: nextId("feature"),
          kind: "route",
          name: `未命名${component.name}`,
          entityRef: null,
          layerId: activeLayerId,
          points: routePoints,
          timeFrom: null,
          timeTo: null,
          props: componentProps,
          description: component.description,
        });
      }
    } else if (
      pointer.mode === "component-surface-brush" &&
      prefabComponentIdRef.current
    ) {
      const component = MAP_COMPONENT_PRESETS.find(
        (candidate) => candidate.id === prefabComponentIdRef.current,
      );
      if (
        component?.interaction === "surface" &&
        mapComponentPlacement(component) === "overlay"
      ) {
        const rawPoints = [
          ...pointer.points,
          ...(distance(pointer.points.at(-1) ?? pointer.start, point) >= 1
            ? [point]
            : []),
        ];
        const closed = isMapBrushPathClosed(rawPoints);
        const curve = controlPointCurve;
        const sampledPoints = resampleMapBrushPoints(
          rawPoints,
          settingsRef.current.brushPointCount,
          curve,
          closed,
        );
        if (sampledPoints.length >= 2) {
          onComponentSurface(component.id, sampledPoints, closed, curve);
        }
      }
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
        // 区域画笔和普通自由画笔共享同一份触点契约。此前这里直接把
        // 鼠标采样点写入区域，导致区域工具既不遵守触点数量，也不会
        // 使用弧线模式；预览和最终保存结果因此不一致。
        const sampledPoints =
          controlPointCurve === "arc"
            ? resampleMapBrushPoints(
                points,
                settingsRef.current.brushPointCount,
                controlPointCurve,
                true,
              )
            : points;
        onSceneRegionCreate(
          pointer.regionKind ?? "land",
          sampledPoints,
          controlPointCurve,
        );
      }
    } else if (pointer.mode === "draw") {
      const currentTool = pointer.drawTool ?? toolRef.current;
      const areaShape =
        currentTool === "freehand"
          ? "freehand"
          : (pointer.areaShape ?? settingsRef.current.areaShape);
      const usesFreehandShape =
        currentTool === "freehand" ||
        (currentTool === "area" && areaShape === "freehand");
      const rawPoints =
        currentTool === "area" &&
        areaShape !== "closed" &&
        areaShape !== "polygon" &&
        areaShape !== "freehand"
          ? createMapAreaShapePoints(areaShape, pointer.start, point)
          : [
              ...pointer.points,
              ...(distance(pointer.points.at(-1) ?? pointer.start, point) >= 1
                ? [point]
                : []),
            ];
      const freehandClosed =
        usesFreehandShape && isMapBrushPathClosed(rawPoints);
      const points =
        (currentTool === "area" && !usesFreehandShape) || freehandClosed
          ? resampleMapBrushPoints(
              rawPoints,
              settingsRef.current.brushPointCount,
              controlPointCurve,
              true,
            )
          : usesFreehandShape ||
              currentTool === "river" ||
              currentTool === "route"
            ? resampleMapBrushPoints(
                rawPoints,
                settingsRef.current.brushPointCount,
                controlPointCurve,
                false,
              )
            : rawPoints;
      const kind = usesFreehandShape
        ? freehandClosed
          ? "area"
          : "route"
        : currentToolToFeatureKind(currentTool);
      if (kind) {
        // 新建画笔显式保存直线或弧线，旧地图缺失该字段时仍沿用旧渲染。
        const curveProps: Record<string, string> =
          kind === "area" || kind === "route"
            ? { curve: controlPointCurve }
            : {};
        onCreate({
          id: nextId("feature"),
          kind,
          name:
            kind === "marker"
              ? "新地点"
              : kind === "label"
                ? "新标签"
                : kind === "route"
                  ? currentTool === "river"
                    ? "新河流"
                    : usesFreehandShape
                      ? "自由画笔"
                      : "新路线"
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
          props:
            currentTool === "river"
              ? { ...DEFAULT_MAP_RIVER_PROPS, ...curveProps }
              : currentTool === "area" && !usesFreehandShape
                ? {
                    ...DEFAULT_MAP_FREEFORM_AREA_PROPS,
                    ...curveProps,
                  }
                : usesFreehandShape
                  ? {
                      ...(freehandClosed
                        ? DEFAULT_MAP_FREEFORM_AREA_PROPS
                        : {}),
                      freehand: "true",
                      closed: freehandClosed ? "true" : "false",
                      ...curveProps,
                    }
                  : curveProps,
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

  const commitPolygonDraft = (
    finalPoint?: MapScenePoint,
    close = false,
  ) => {
    const points = [...polygonDraftRef.current];
    if (
      finalPoint &&
      (!points.at(-1) || distance(points.at(-1)!, finalPoint) >= 3)
    ) {
      points.push(finalPoint);
    }
    const closeAtStart = isPolygonClosePoint(points, points.at(-1)!);
    const shouldClose = close || closeAtStart;
    const uniquePoints = points.filter(
      (candidate, index) =>
        index === 0 || distance(candidate, points[index - 1]!) >= 3,
    );
    const committedPoints =
      shouldClose &&
      uniquePoints.length > 2 &&
      isPolygonClosePoint(uniquePoints, uniquePoints.at(-1)!)
        ? uniquePoints.slice(0, -1)
        : uniquePoints;
    const committedClosed = shouldClose && committedPoints.length >= 3;
    if (committedPoints.length >= 2) {
      onCreate({
        id: nextId("feature"),
        kind: "route",
        name: "多边形",
        entityRef: null,
        layerId: activeLayerId,
        points: committedPoints,
        timeFrom: null,
        timeTo: null,
        props: {
          polygonBrush: "true",
          closed: committedClosed ? "true" : "false",
          curve: settingsRef.current.brushPointCurve,
        },
        description: "",
      });
    }
    polygonDraftRef.current = [];
    polygonHoverRef.current = null;
    pointerRef.current = null;
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
      onPointerDown={(event) => {
        if (
          contextMenu &&
          !(event.target as HTMLElement).closest('[role="menu"]')
        ) {
          setContextMenu(null);
        }
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(MAP_COMPONENT_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        const assetId = event.dataTransfer.getData(MAP_COMPONENT_DRAG_MIME);
        if (assetId) externalDragAssetIdRef.current = assetId;
        const bounds = rootRef.current?.getBoundingClientRect();
        if (!bounds) return;
        dropScreenPointRef.current = {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        };
        hoverPointRef.current = pointFromEvent(event);
        startDropAutoPan();
        requestRender();
      }}
      onDragLeave={(event) => {
        const relatedTarget = event.relatedTarget;
        if (
          relatedTarget instanceof Node &&
          event.currentTarget.contains(relatedTarget)
        ) {
          return;
        }
        stopDropAutoPan();
        externalDragAssetIdRef.current = null;
        hoverPointRef.current = null;
        requestRender();
      }}
      onDrop={(event) => {
        const componentId = event.dataTransfer.getData(MAP_COMPONENT_DRAG_MIME);
        if (!componentId) {
          stopDropAutoPan();
          return;
        }
        event.preventDefault();
        stopDropAutoPan();
        externalDragAssetIdRef.current = null;
        hoverPointRef.current = null;
        onComponentDrop(componentId, pointFromEvent(event));
        requestRender();
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
        onContextMenu={handleContextMenu}
        onDoubleClick={(event) => {
          if (toolRef.current === "polygon") {
            event.preventDefault();
            event.stopPropagation();
            commitPolygonDraft(
              snapPoint(pointFromEvent(event), settingsRef.current),
            );
            return;
          }
          if (
            toolRef.current !== "select" &&
            toolRef.current !== "move" &&
            toolRef.current !== "pan"
          ) {
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
        onKeyDown={(event) => {
          if (toolRef.current !== "polygon") return;
          if (event.key === "Enter") {
            event.preventDefault();
            commitPolygonDraft();
          } else if (event.key === "Escape") {
            event.preventDefault();
            polygonDraftRef.current = [];
            polygonHoverRef.current = null;
            pointerRef.current = null;
            requestRender();
          }
        }}
        tabIndex={0}
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
      {contextMenu && (
        <div
          role="menu"
          aria-label="地图对象菜单"
          className="absolute z-30 min-w-44 overflow-hidden rounded-md border border-[#746b6038] bg-[#fffaf1] py-1 text-xs text-[#51483e] shadow-[0_8px_24px_rgba(55,47,39,0.18)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.materialLandPair &&
            contextMenu.itemIds.length === 1 &&
            onCreateGroup && (
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-[#eee8dc]"
                onClick={() => {
                  onCreateGroup(contextMenu.materialLandPair!);
                  setContextMenu(null);
                }}
              >
                与覆盖的陆地组合
              </button>
            )}
          {contextMenu.itemIds.length >= 2 &&
            !contextMenu.isCompleteGroup &&
            onCreateGroup && (
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-[#eee8dc]"
                onClick={() => {
                  onCreateGroup(contextMenu.itemIds);
                  setContextMenu(null);
                }}
              >
                组合所选对象（{contextMenu.itemIds.length}）
              </button>
            )}
          {contextMenu.groupId && onUngroup && (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left hover:bg-[#eee8dc]"
              onClick={() => {
                onUngroup(contextMenu.groupId!);
                setContextMenu(null);
              }}
            >
              解除当前组合
            </button>
          )}
        </div>
      )}
      {settings.snapEnabled && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs uppercase tracking-[0.18em] text-[#6e6256]">
          snap / {settings.snapGrid}px
        </div>
      )}
    </div>
  );
}

function currentToolToFeatureKind(tool: MapCanvasTool): MapFeatureKind | null {
  if (tool === "river") return "route";
  if (
    tool === "marker" ||
    tool === "label" ||
    tool === "area" ||
    tool === "route" ||
    tool === "node"
  ) {
    return tool;
  }
  return null;
}
