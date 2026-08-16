import {
  createMapArtworkAssetCatalog,
  getMapArtworkAssetVariant,
  getMapArtworkAssetVariantWithColor,
  mapArtworkVariantIndex,
  type MapArtworkAssetCatalog,
  type MapArtworkAssetVariant,
} from "../business/mapArtwork";
import { isMapRiverFeature } from "../business/mapHydrography";
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
import {
  drawImageAsset,
  drawAzgaarOverlayFeature,
  drawMapFeatureLabel,
  drawMapSceneRegionEdge,
  drawMapStyledRoute,
  drawPath,
  drawTaperedRiver,
  featureVisible,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
  type MapRenderCamera,
} from "./mapSceneDrawing";

export type MapPngExportResult = {
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
};

type LoadedMapImages = {
  readonly artwork: ReadonlyMap<string, HTMLImageElement>;
  readonly background: HTMLImageElement | null;
};

const EXPORT_CAMERA: MapRenderCamera = Object.freeze({ x: 0, y: 0, zoom: 1 });
const EMPTY_PROJECT_ARTWORK_SOURCES: ReadonlyMap<string, string> = new Map();

function createSurface(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
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
    mapDocument.canvas.backgroundImage
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
      if (asset) {
        const clipsToLand = mapSceneLayerBrushClipsToLand(layer.kind);
        mapArtworkBrushDabs({
          id: stroke.id,
          points: stroke.points,
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
        if (stroke.points.length === 1) {
          const point = stroke.points[0]!;
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
          drawPath(context, stroke.points, EXPORT_CAMERA);
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
  mapFeaturesInRenderOrder(mapDocument).forEach((feature) => {
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
      mapDocument.canvas.backgroundImage ||
        mapDocument.canvas.backgroundAssetPath,
    );
    context.save();
    if (
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
    } else if (isMapRiverFeature(feature)) {
      drawTaperedRiver(context, feature, points, EXPORT_CAMERA, opacity);
    } else if (
      drawMapStyledRoute(context, feature, points, EXPORT_CAMERA, opacity)
    ) {
      // 道路、城墙与疆界由分层路线渲染器接管。
    } else {
      drawPath(context, points, EXPORT_CAMERA);
      if (feature.kind === "polygon" || feature.kind === "area") {
        context.closePath();
        context.fillStyle = feature.props.fill ?? "#b26d4540";
        context.globalAlpha = opacity;
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
): Promise<HTMLCanvasElement> {
  const width = Math.max(1, Math.round(mapDocument.canvas.width));
  const height = Math.max(1, Math.round(mapDocument.canvas.height));
  const output = createSurface(width, height);
  const context = output.getContext("2d");
  if (!context) throw new Error("当前环境不支持地图 PNG 合成。");
  const assetCatalog = createMapArtworkAssetCatalog(
    mapDocument.artwork,
    projectArtworkSources,
  );
  const images = await loadMapImages(mapDocument, assetCatalog);

  drawMapSceneBackground(context, mapDocument, width, height);
  if (images.background) {
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

  const content = createSurface(width, height);
  const contentContext = content.getContext("2d");
  if (!contentContext) throw new Error("当前环境不支持地图图层合成。");
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
  context.drawImage(content, 0, 0);
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
