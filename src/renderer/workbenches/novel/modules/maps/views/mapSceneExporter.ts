import {
  createMapArtworkAssetCatalog,
  getMapArtworkAssetVariant,
  getMapArtworkAssetVariantWithColor,
  mapArtworkVariantIndex,
  type MapArtworkAssetCatalog,
  type MapArtworkAssetVariant,
} from "../business/mapArtwork";
import { hasMapRiverAppearance } from "../business/mapHydrography";
import {
  getTopologyNodeKindLabel,
  topologyNodeLabelVisible,
  getTopologyNodeStatus,
  getTopologyNodeStatusOption,
  getTopologyInvalidRouteDiagnostics,
  getTopologyRouteDirection,
  topologyRouteLabelVisible,
  getTopologyRouteRelation,
} from "../business/topologyMap";
import { getMapFeatureAreaStyle } from "../business/mapFeatureAreaStyle";
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
import { mapArtworkBrushDabs } from "../business/mapTerrainBrush";
import { getMapBackgroundImagePlacement } from "../business/mapBackgrounds";
import { isMapFeatureFreeformArea } from "../entities/mapSchema";
import type { MapDocument } from "../entities/mapSchema";
import {
  createMapTerrainComposite,
  mapTerrainCompositeHasLandAt,
  type MapTerrainComposite,
} from "./mapTerrainCompositor";
import {
  drawContainedMapBackgroundImage,
  drawMapSceneBackground,
} from "./mapSceneBackground";
import { isMapBackgroundImageVisible } from "../business/mapBackgrounds";
import {
  drawImageAsset,
  drawAzgaarOverlayFeature,
  drawMapBrushPath,
  drawMapFeatureLabel,
  drawMapSceneRegionEdge,
  drawMapStyledRoute,
  drawTaperedRiver,
  featureVisible,
  mapFeatureBrushCurve,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
  type MapRenderCamera,
} from "./mapSceneDrawing";
import { mapBrushCurvePoints } from "../business/mapFeatureShapes";

export type MapPngExportResult = {
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
};

/**
 * 与导出同源的渲染选项。预览可以限制最长边，避免为了弹窗中的小缩略图
 * 创建整张超大地图的 data URL；不传时仍保持高清导出的原始尺寸契约。
 */
export type MapCanvasRenderOptions = {
  readonly maxEdge?: number;
};

type LoadedMapImages = {
  readonly artwork: ReadonlyMap<string, HTMLImageElement>;
  readonly background: HTMLImageElement | null;
};

const EXPORT_CAMERA: MapRenderCamera = Object.freeze({ x: 0, y: 0, zoom: 1 });
const EMPTY_PROJECT_ARTWORK_SOURCES: ReadonlyMap<string, string> = new Map();
const TOPOLOGY_NODE_WIDTH = 176;
const TOPOLOGY_NODE_HEIGHT = 104;

function isTopologyProjection(mapDocument: MapDocument): boolean {
  return (
    mapDocument.projectionType === "multiverse" ||
    mapDocument.projectionType === "parallel"
  );
}

function topologyNodePort(
  point: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const center = {
    x: point.x + TOPOLOGY_NODE_WIDTH / 2,
    y: point.y + TOPOLOGY_NODE_HEIGHT / 2,
  };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: point.x + (dx >= 0 ? TOPOLOGY_NODE_WIDTH : 0),
      y: center.y,
    };
  }
  return {
    x: center.x,
    y: point.y + (dy >= 0 ? TOPOLOGY_NODE_HEIGHT : 0),
  };
}

function drawTopologyArrow(
  context: CanvasRenderingContext2D,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  color: string,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 7;
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6),
  );
  context.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6),
  );
  context.closePath();
  context.fill();
  context.restore();
}

function drawTopologyRoutes(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  timelineCursor: number | null,
): void {
  const nodes = new Map(
    mapDocument.features
      .filter((feature) => feature.kind === "node")
      .map((feature) => [feature.id, feature] as const),
  );
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(mapDocument, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  mapDocument.features.forEach((feature) => {
    if (
      feature.kind !== "route" ||
      invalidRouteIds.has(feature.id) ||
      !featureVisible(mapDocument, feature, timelineCursor)
    ) {
      return;
    }
    const sourceId = feature.props.sourceNodeId;
    const targetId = feature.props.targetNodeId;
    const source = sourceId ? nodes.get(sourceId) : undefined;
    const target = targetId ? nodes.get(targetId) : undefined;
    const sourcePoint = source?.points[0];
    const targetPoint = target?.points[0];
    if (
      !source ||
      !target ||
      !sourcePoint ||
      !targetPoint ||
      !featureVisible(mapDocument, source, timelineCursor) ||
      !featureVisible(mapDocument, target, timelineCursor)
    ) {
      return;
    }
    const layer = mapDocument.layers.find(
      (entry) => entry.id === feature.layerId,
    );
    const opacity = layer?.opacity ?? 1;
    const color = feature.props.color ?? "#8e6044";
    const start = topologyNodePort(sourcePoint, targetPoint);
    const end = topologyNodePort(targetPoint, sourcePoint);
    const lineWidth = Number(feature.props.lineWidth ?? 2);
    const relation = getTopologyRouteRelation(feature);
    const direction = getTopologyRouteDirection(feature);
    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = color;
    context.lineWidth =
      Number.isFinite(lineWidth) && lineWidth > 0 ? lineWidth : 2;
    context.lineCap = "round";
    context.setLineDash(
      relation === "branch"
        ? [8, 5]
        : relation === "portal"
          ? [3, 4]
          : relation === "rift"
            ? [12, 4, 3, 4]
            : [],
    );
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.setLineDash([]);
    if (direction === "one-way" || direction === "two-way") {
      drawTopologyArrow(context, start, end, color);
    }
    if (direction === "two-way") {
      drawTopologyArrow(context, end, start, color);
    }
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (topologyRouteLabelVisible(feature)) {
      context.font = "600 11px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = color;
      context.fillText(feature.name, midpoint.x, midpoint.y - 8);
    }
    context.restore();
  });
}

function drawTopologyNodes(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  timelineCursor: number | null,
): void {
  mapDocument.features.forEach((feature) => {
    if (
      feature.kind !== "node" ||
      !featureVisible(mapDocument, feature, timelineCursor) ||
      !feature.points[0]
    ) {
      return;
    }
    const layer = mapDocument.layers.find(
      (entry) => entry.id === feature.layerId,
    );
    const point = feature.points[0]!;
    const color = feature.props.color ?? "#507b88";
    const status = getTopologyNodeStatus(feature);
    const statusOption = getTopologyNodeStatusOption(status);
    context.save();
    context.globalAlpha =
      (layer?.opacity ?? 1) * (status === "destroyed" ? 0.62 : 1);
    context.fillStyle = "#fffaf1";
    context.strokeStyle = "#746b60";
    context.lineWidth = 1;
    context.fillRect(
      point.x,
      point.y,
      TOPOLOGY_NODE_WIDTH,
      TOPOLOGY_NODE_HEIGHT,
    );
    context.strokeRect(
      point.x + 0.5,
      point.y + 0.5,
      TOPOLOGY_NODE_WIDTH - 1,
      TOPOLOGY_NODE_HEIGHT - 1,
    );
    context.fillStyle = color;
    context.fillRect(point.x, point.y, 4, TOPOLOGY_NODE_HEIGHT);
    context.beginPath();
    context.arc(point.x + 18, point.y + 20, 10, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    if (topologyNodeLabelVisible(feature)) {
      context.fillStyle = "#42392f";
      context.font = "600 14px sans-serif";
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      context.fillText(feature.name.slice(0, 24), point.x + 36, point.y + 24);
    }
    context.fillStyle = "#756a5d";
    context.font = "11px sans-serif";
    context.fillText(
      getTopologyNodeKindLabel(feature),
      point.x + 10,
      point.y + 48,
    );
    context.fillStyle = statusOption.color;
    context.fillText(`● ${statusOption.label}`, point.x + 10, point.y + 66);
    const linkedMapId = feature.props.linkedMapId?.trim();
    if (linkedMapId) {
      context.fillStyle = "#8b755c";
      context.fillText(
        `地图 · ${linkedMapId.slice(0, 18)}`,
        point.x + 86,
        point.y + 66,
      );
    }
    context.restore();
  });
}

function createSurface(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 计算导出或预览画布的像素尺寸；世界坐标始终保持原尺寸。 */
export function mapCanvasRenderSize(
  canvas: Pick<MapDocument["canvas"], "width" | "height">,
  options: MapCanvasRenderOptions = {},
): {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly scale: number;
} {
  const worldWidth = Math.max(1, Math.round(canvas.width));
  const worldHeight = Math.max(1, Math.round(canvas.height));
  const requestedMaxEdge = options.maxEdge;
  const maxEdge =
    typeof requestedMaxEdge === "number" &&
    Number.isFinite(requestedMaxEdge) &&
    requestedMaxEdge > 0
      ? Math.max(1, Math.round(requestedMaxEdge))
      : null;
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(worldWidth, worldHeight))
    : 1;
  return {
    worldWidth,
    worldHeight,
    outputWidth: Math.max(1, Math.round(worldWidth * scale)),
    outputHeight: Math.max(1, Math.round(worldHeight * scale)),
    scale,
  };
}

/**
 * 导出前收集真正会被绘制的素材变体。连续内置素材可由笔触颜色派生 SVG，
 * 因此不能只预加载目录中的原色变体，否则编辑画布可见的改色森林 / 山脉
 * 会在 PNG 中被静默跳过。
 */
export function collectMapArtworkExportVariants(
  mapDocument: MapDocument,
  assetCatalog: MapArtworkAssetCatalog,
): readonly MapArtworkAssetVariant[] {
  const variants = new Map<string, MapArtworkAssetVariant>();
  mapDocument.scene?.layers.forEach((layer) => {
    layer.strokes.forEach((stroke) => {
      if (!stroke.brushAssetId) return;
      const asset = assetCatalog.get(stroke.brushAssetId);
      asset?.variants.forEach((variant) => {
        const colored = getMapArtworkAssetVariantWithColor(
          asset,
          variant.index,
          stroke.color,
        );
        variants.set(colored.cacheKey, colored);
      });
    });
  });
  mapDocument.features.forEach((feature) => {
    if (feature.kind !== "marker") return;
    const asset = assetCatalog.get(feature.props.component ?? "");
    if (!asset) return;
    const variant = getMapArtworkAssetVariant(
      asset,
      mapArtworkVariantIndex(asset, feature.id),
    );
    variants.set(variant.cacheKey, variant);
  });
  mapDocument.artwork.layers.forEach((layer) => {
    layer.stamps.forEach((stamp) => {
      const asset = assetCatalog.get(stamp.assetId);
      if (!asset) return;
      const variant = getMapArtworkAssetVariant(asset, stamp.variant);
      variants.set(variant.cacheKey, variant);
    });
  });
  return [...variants.values()];
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

async function loadMapImages(
  mapDocument: MapDocument,
  assetCatalog: MapArtworkAssetCatalog,
): Promise<LoadedMapImages> {
  const variants = collectMapArtworkExportVariants(mapDocument, assetCatalog);
  const [artworkEntries, background] = await Promise.all([
    Promise.all(
      variants.map(
        async (variant) =>
          [variant.cacheKey, await loadImage(variant.imageSrc)] as const,
      ),
    ),
    mapDocument.canvas.backgroundImage &&
    isMapBackgroundImageVisible(mapDocument.canvas)
      ? loadImage(mapDocument.canvas.backgroundImage)
      : Promise.resolve(null),
  ]);
  return {
    artwork: new Map(
      artworkEntries.filter(
        (entry): entry is readonly [string, HTMLImageElement] =>
          entry[1] !== null,
      ),
    ),
    background,
  };
}

function drawSceneStrokes(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  images: ReadonlyMap<string, HTMLImageElement>,
  assetCatalog: MapArtworkAssetCatalog,
  terrainComposite: MapTerrainComposite | null,
): void {
  mapDocument.scene?.layers.forEach((layer) => {
    if (!layer.visible || layer.opacity <= 0) return;
    layer.strokes.forEach((stroke) => {
      if (
        isMapTerrainMaskStroke(layer.kind, stroke) ||
        isMapTerrainMaterialStroke(layer.kind, stroke)
      ) {
        return;
      }
      context.save();
      context.globalAlpha = layer.opacity * stroke.opacity;
      if (stroke.tool === "erase") {
        context.globalCompositeOperation = "destination-out";
      }
      const asset = stroke.brushAssetId
        ? assetCatalog.get(stroke.brushAssetId)
        : undefined;
      const renderedStrokePoints = mapBrushCurvePoints(
        stroke.points,
        stroke.curve,
      );
      if (asset) {
        const clipsToLand = mapSceneLayerBrushClipsToLand(layer.kind);
        mapArtworkBrushDabs({
          id: stroke.id,
          assetId: asset.id,
          points: renderedStrokePoints,
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
          const image = images.get(variant.cacheKey);
          if (!image) return;
          const size = stroke.width * dab.scale;
          drawImageAsset(
            context,
            image,
            dab,
            EXPORT_CAMERA,
            size,
            (size * variant.height) / variant.width,
            dab.rotation,
          );
        });
      } else {
        context.strokeStyle = stroke.color;
        context.fillStyle = stroke.color;
        context.lineWidth = Math.max(1, stroke.width);
        context.lineCap = "round";
        context.lineJoin = "round";
        if (renderedStrokePoints.length === 1) {
          const point = renderedStrokePoints[0]!;
          context.beginPath();
          context.arc(
            point.x,
            point.y,
            Math.max(0.5, context.lineWidth / 2),
            0,
            Math.PI * 2,
          );
          context.fill();
        } else {
          drawMapBrushPath(
            context,
            stroke.points,
            EXPORT_CAMERA,
            stroke.curve,
          );
          context.stroke();
        }
      }
      context.restore();
    });
  });
}

function drawSceneRegionEdges(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  hasTerrainComposite: boolean,
): void {
  mapDocument.scene?.layers.forEach((layer) => {
    if (!layer.visible || layer.opacity <= 0) return;
    layer.regions.forEach((region) => {
      if (!shouldDrawMapSceneRegionEdge(region, hasTerrainComposite)) return;
      drawMapSceneRegionEdge(
        context,
        region,
        region.points,
        EXPORT_CAMERA,
        layer.opacity * region.opacity,
      );
    });
  });
}

function drawFeatures(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  images: ReadonlyMap<string, HTMLImageElement>,
  timelineCursor: number | null,
  assetCatalog: MapArtworkAssetCatalog,
): void {
  const topology = isTopologyProjection(mapDocument);
  // 拓扑通道必须先于节点卡片绘制，端点才不会穿过节点主体。节点和通道
  // 都直接从 MapDocument 读出，导出不依赖运行时的 React Flow 状态。
  if (topology) drawTopologyRoutes(context, mapDocument, timelineCursor);
  mapFeaturesInRenderOrder(mapDocument).forEach((feature) => {
    if (topology && (feature.kind === "node" || feature.kind === "route")) {
      return;
    }
    if (!featureVisible(mapDocument, feature, timelineCursor)) return;
    const layer = mapDocument.layers.find(
      (item) => item.id === feature.layerId,
    );
    const opacity = layer?.opacity ?? 1;
    const points = feature.points;
    if (points.length === 0) return;
    const asset =
      feature.kind === "marker"
        ? assetCatalog.get(feature.props.component ?? "")
        : undefined;
    const hasAzgaarBaseMap = Boolean(
      isMapBackgroundImageVisible(mapDocument.canvas) &&
        (mapDocument.canvas.backgroundImage ||
          mapDocument.canvas.backgroundAssetPath),
    );
    context.save();
    if (feature.props.sceneSurface === "true") {
      // 场景层已根据同一来源要素绘制海陆表面。
    } else if (
      drawAzgaarOverlayFeature(
        context,
        feature,
        points,
        EXPORT_CAMERA,
        opacity,
        hasAzgaarBaseMap,
      )
    ) {
      // Azgaar SVG 已包含完整底图，避免可编辑边界再次覆盖大块色带。
    } else if (asset && points[0]) {
      const variant = getMapArtworkAssetVariant(
        asset,
        mapArtworkVariantIndex(asset, feature.id),
      );
      const image = images.get(variant.cacheKey);
      if (image) {
        const size = Math.min(
          72,
          Math.max(30, Math.max(variant.width, variant.height) * 0.42),
        );
        drawImageAsset(
          context,
          image,
          points[0],
          EXPORT_CAMERA,
          size,
          (size * variant.height) / variant.width,
          0,
          opacity,
        );
      }
    } else if (hasMapRiverAppearance(feature)) {
      drawTaperedRiver(context, feature, points, EXPORT_CAMERA, opacity);
    } else if (
      drawMapStyledRoute(context, feature, points, EXPORT_CAMERA, opacity)
    ) {
      // 道路、城墙与疆界由分层路线渲染器接管。
    } else {
      drawMapBrushPath(
        context,
        points,
        EXPORT_CAMERA,
        mapFeatureBrushCurve(feature),
        isMapFeatureFreeformArea(feature.kind),
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
        context.lineWidth = Number(feature.props.lineWidth ?? 2);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke();
      }
      if (feature.kind === "marker") {
        const point = points[0]!;
        context.beginPath();
        context.arc(point.x, point.y, 6, 0, Math.PI * 2);
        context.fillStyle = feature.props.color ?? "#8b6b4a";
        context.globalAlpha = opacity;
        context.fill();
      }
    }
    if (shouldDrawMapFeatureTextOverlay(feature, hasAzgaarBaseMap)) {
      drawMapFeatureLabel(context, feature, points, EXPORT_CAMERA, opacity);
    }
    context.restore();
  });
  if (topology) drawTopologyNodes(context, mapDocument, timelineCursor);
}

function drawArtworkStamps(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  images: ReadonlyMap<string, HTMLImageElement>,
  assetCatalog: MapArtworkAssetCatalog,
  phase: MapArtworkRenderPhase,
): void {
  mapArtworkLayersInRenderOrder(mapDocument.artwork, phase).forEach((layer) => {
    if (!layer.visible || layer.opacity <= 0) return;
    layer.stamps.forEach((stamp) => {
      const asset = assetCatalog.get(stamp.assetId);
      if (!asset) return;
      const variant = getMapArtworkAssetVariant(asset, stamp.variant);
      const image = images.get(variant.cacheKey);
      if (!image) return;
      const scale =
        Math.min(1, 150 / Math.max(variant.width, variant.height)) *
        stamp.scale;
      drawImageAsset(
        context,
        image,
        stamp,
        EXPORT_CAMERA,
        variant.width * scale,
        variant.height * scale,
        (stamp.rotation * Math.PI) / 180,
        layer.opacity * stamp.opacity,
        stamp.flipX,
        stamp.flipY,
      );
    });
  });
}

export async function renderMapDocumentToCanvas(
  mapDocument: MapDocument,
  timelineCursor: number | null,
  projectArtworkSources: ReadonlyMap<
    string,
    string
  > = EMPTY_PROJECT_ARTWORK_SOURCES,
  options: MapCanvasRenderOptions = {},
): Promise<HTMLCanvasElement> {
  const {
    worldWidth: width,
    worldHeight: height,
    outputWidth,
    outputHeight,
    scale,
  } = mapCanvasRenderSize(mapDocument.canvas, options);
  const output = createSurface(outputWidth, outputHeight);
  const context = output.getContext("2d");
  if (!context) throw new Error("当前环境不支持地图 PNG 合成。");
  const assetCatalog = createMapArtworkAssetCatalog(
    mapDocument.artwork,
    projectArtworkSources,
  );
  const images = await loadMapImages(mapDocument, assetCatalog);

  context.scale(scale, scale);
  drawMapSceneBackground(context, mapDocument, width, height);
  if (images.background && isMapBackgroundImageVisible(mapDocument.canvas)) {
    const backgroundPlacement = getMapBackgroundImagePlacement(
      mapDocument.canvas,
      images.background.naturalWidth,
      images.background.naturalHeight,
    );
    drawContainedMapBackgroundImage(
      context,
      images.background,
      images.background.naturalWidth,
      images.background.naturalHeight,
      width,
      height,
      mapDocument.canvas.backgroundOpacity ?? 1,
      backgroundPlacement,
    );
  }

  const content = createSurface(output.width, output.height);
  const contentContext = content.getContext("2d");
  if (!contentContext) throw new Error("当前环境不支持地图图层合成。");
  contentContext.scale(scale, scale);
  const terrainComposite = createMapTerrainComposite(mapDocument);
  if (terrainComposite) {
    contentContext.imageSmoothingEnabled = true;
    contentContext.drawImage(
      terrainComposite.canvas,
      0,
      0,
      terrainComposite.worldWidth,
      terrainComposite.worldHeight,
    );
  }
  drawArtworkStamps(
    contentContext,
    mapDocument,
    images.artwork,
    assetCatalog,
    "base",
  );
  drawSceneRegionEdges(contentContext, mapDocument, Boolean(terrainComposite));
  drawSceneStrokes(
    contentContext,
    mapDocument,
    images.artwork,
    assetCatalog,
    terrainComposite,
  );
  drawArtworkStamps(
    contentContext,
    mapDocument,
    images.artwork,
    assetCatalog,
    "scene",
  );
  drawFeatures(
    contentContext,
    mapDocument,
    images.artwork,
    timelineCursor,
    assetCatalog,
  );
  drawArtworkStamps(
    contentContext,
    mapDocument,
    images.artwork,
    assetCatalog,
    "feature",
  );
  drawArtworkStamps(
    contentContext,
    mapDocument,
    images.artwork,
    assetCatalog,
    "overlay",
  );
  context.drawImage(content, 0, 0, width, height);
  return output;
}

export function mapPngExportFileName(mapName: string): string {
  const safeName =
    mapName
      .trim()
      .replace(/[<>:"/\\|?*]/gu, "-")
      .replace(/\p{Cc}/gu, "-")
      .replace(/\.+$/u, "") || "地图";
  return `${safeName}-高清.png`;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("地图 PNG 编码失败。"));
    }, "image/png");
  });
}

export async function downloadMapDocumentPng(
  mapDocument: MapDocument,
  timelineCursor: number | null,
  projectArtworkSources: ReadonlyMap<
    string,
    string
  > = EMPTY_PROJECT_ARTWORK_SOURCES,
): Promise<MapPngExportResult> {
  const canvas = await renderMapDocumentToCanvas(
    mapDocument,
    timelineCursor,
    projectArtworkSources,
  );
  const blob = await canvasToPngBlob(canvas);
  const url = URL.createObjectURL(blob);
  const fileName = mapPngExportFileName(mapDocument.name);
  const anchor = globalThis.document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { width: canvas.width, height: canvas.height, fileName };
}
