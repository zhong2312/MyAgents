import {
  MAP_CANVAS_HEIGHT,
  MAP_CANVAS_WIDTH,
  type MapDocument,
  type MapScenePoint,
} from "../entities/mapSchema";
import { getMapBackgroundImageContentPlacement } from "./mapBackgrounds";
import { getMapArtworkStampAsset } from "./mapArtwork";
import {
  getMapLabelLayout,
  getMapLabelStyle,
  mapFeatureHasLabel,
} from "./mapLabels";
import {
  getMapRiverStyle,
  hasMapRiverAppearance,
  smoothMapPath,
} from "./mapHydrography";
import { getMapRouteStyle, mapRouteStrokeLayers } from "./mapRoutes";
import { mapArtworkBrushMaxLateralSpread } from "./mapTerrainBrush";

export const MAP_CANVAS_CONTENT_PADDING = 160;
const CANVAS_EXTENSION = MAP_CANVAS_CONTENT_PADDING;
const EDGE_EPSILON = 1;
const GENERATED_FEATURE_GENERATOR_PATTERN =
  /^(?:fantasy-map|fantasy-map-tool|red-blob|agent-azgaar|azgaar|azgaar-runtime)$/u;
const GENERATED_SCENE_LAYER_PATTERN =
  /^scene-generator-(?:fantasy-map|fantasy-map-tool|red-blob|agent-azgaar|azgaar|azgaar-runtime)$/u;

type MapCanvasContentBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type MapCanvasContentExpansion = {
  readonly map: MapDocument;
  /** 左上扩展时，所有持久化坐标统一增加的偏移量。 */
  readonly translation: MapScenePoint;
};

/**
 * 判断地图是否已经包含可落图的事实。
 *
 * 预设背景和空图层不算内容：它们只是工作区外观；导入底图则是地图事实。
 * 该判断同时服务首次构图和后续扩展逻辑，避免由各个工具各自猜测“地图是否为空”。
 */
export function mapDocumentHasContent(map: MapDocument): boolean {
  return (
    map.features.length > 0 ||
    Boolean(map.canvas.backgroundImage || map.canvas.backgroundAssetPath) ||
    map.artwork.layers.some((layer) => layer.stamps.length > 0) ||
    Boolean(
      map.scene?.layers.some(
        (layer) => layer.regions.length > 0 || layer.strokes.length > 0,
      ),
    )
  );
}

/** 仅在空地图首次出现实际内容时请求相机自动构图。 */
export function mapDocumentGainedContent(
  previous: MapDocument,
  next: MapDocument,
): boolean {
  return !mapDocumentHasContent(previous) && mapDocumentHasContent(next);
}

/** 识别由地图生成工具写入的事实，供提案落盘时复用首次构图契约。 */
export function mapDocumentHasGeneratedContent(map: MapDocument): boolean {
  return (
    map.features.some((feature) =>
      GENERATED_FEATURE_GENERATOR_PATTERN.test(feature.props.generator ?? ""),
    ) ||
    map.scene?.layers.some((layer) =>
      GENERATED_SCENE_LAYER_PATTERN.test(layer.id),
    ) === true
  );
}

/** 识别所有生成器输出，供打开地图时决定是否按内容自动构图。 */
export function mapDocumentHasGeneratorOutput(map: MapDocument): boolean {
  return (
    map.features.some((feature) =>
      GENERATED_FEATURE_GENERATOR_PATTERN.test(feature.props.generator ?? ""),
    ) ||
    map.scene?.layers.some((layer) =>
      GENERATED_SCENE_LAYER_PATTERN.test(layer.id),
    ) === true
  );
}

function emptyBounds(): MapCanvasContentBounds {
  return {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
}

function includePoint(
  bounds: MapCanvasContentBounds,
  point: MapScenePoint,
  radius = 0,
): MapCanvasContentBounds {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return bounds;
  const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  return {
    left: Math.min(bounds.left, point.x - safeRadius),
    right: Math.max(bounds.right, point.x + safeRadius),
    top: Math.min(bounds.top, point.y - safeRadius),
    bottom: Math.max(bounds.bottom, point.y + safeRadius),
  };
}

function includePoints(
  bounds: MapCanvasContentBounds,
  points: readonly MapScenePoint[],
  radius = 0,
): MapCanvasContentBounds {
  return points.reduce(
    (nextBounds, point) => includePoint(nextBounds, point, radius),
    bounds,
  );
}

function includeRectangle(
  bounds: MapCanvasContentBounds,
  rectangle: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): MapCanvasContentBounds {
  return includePoint(
    includePoint(bounds, { x: rectangle.x, y: rectangle.y }),
    {
      x: rectangle.x + rectangle.width,
      y: rectangle.y + rectangle.height,
    },
  );
}

function numericProp(
  props: Readonly<Record<string, string>>,
  key: string,
  fallback = 0,
): number {
  const parsed = Number.parseFloat(props[key] ?? "");
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function featureRadius(props: Readonly<Record<string, string>>): number {
  const widths = [
    props.lineWidth,
    props.routeWidth,
    props.sourceWidth,
    props.mouthWidth,
  ]
    .map((value) => Number.parseFloat(value ?? "0"))
    .filter(Number.isFinite);
  return Math.max(0, ...widths) / 2;
}

function artworkAssetDimensions(
  map: MapDocument,
  assetId: string,
): { readonly width: number; readonly height: number } | null {
  const projectAsset = map.artwork.assets.find((asset) => asset.id === assetId);
  if (projectAsset) {
    return { width: projectAsset.width, height: projectAsset.height };
  }
  const builtinAsset = getMapArtworkStampAsset(assetId);
  return builtinAsset
    ? { width: builtinAsset.width, height: builtinAsset.height }
    : null;
}

function clampStampScale(scale: number): number {
  return Math.max(0.05, Math.min(20, scale));
}

function stampRadius(
  map: MapDocument,
  stamp: { readonly assetId: string; readonly scale: number },
): number {
  const dimensions = artworkAssetDimensions(map, stamp.assetId);
  if (!dimensions) return 32 * clampStampScale(stamp.scale);
  const baseScale = Math.min(
    1,
    150 / Math.max(dimensions.width, dimensions.height),
  );
  const width = dimensions.width * baseScale * clampStampScale(stamp.scale);
  const height = dimensions.height * baseScale * clampStampScale(stamp.scale);
  // 旋转后的四角都落在以锚点为中心的这个外接圆内。
  return Math.hypot(width, height) / 2;
}

function artworkBrushRadius(
  map: MapDocument,
  stroke: {
    readonly brushAssetId: string | null;
    readonly width: number;
    readonly spacing: number;
    readonly scatter: number;
    readonly shape: "round" | "organic";
  },
): number {
  if (!stroke.brushAssetId) {
    return stroke.shape === "organic" ? stroke.width * 0.58 : stroke.width / 2;
  }
  const dimensions = artworkAssetDimensions(map, stroke.brushAssetId);
  if (!dimensions) return stroke.width / 2;
  const height = (stroke.width * dimensions.height) / dimensions.width;
  const halfDiagonal = Math.hypot(stroke.width, height) / 2;
  const scatterReach = mapArtworkBrushMaxLateralSpread({
    assetId: stroke.brushAssetId,
    width: stroke.width,
    scatter: stroke.scatter,
  });
  const longitudinalReach = Math.min(
    stroke.spacing * 0.28,
    stroke.width * 0.16,
  );
  return halfDiagonal * 1.1 + scatterReach + longitudinalReach;
}

function featureGeometryRadius(
  map: MapDocument,
  feature: MapDocument["features"][number],
): number {
  if (feature.kind === "area") {
    return Math.max(
      featureRadius(feature.props),
      numericProp(feature.props, "radius"),
    );
  }
  if (feature.kind === "marker") {
    const component = feature.props.component;
    if (!component) return Math.max(6, featureRadius(feature.props));
    const dimensions = artworkAssetDimensions(map, component);
    if (!dimensions) return Math.max(6, featureRadius(feature.props));
    const maximum = Math.max(dimensions.width, dimensions.height);
    const width = Math.min(72, Math.max(30, maximum * 0.42));
    const height = (width * dimensions.height) / dimensions.width;
    return Math.hypot(width, height) / 2;
  }
  if (hasMapRiverAppearance(feature)) {
    const style = getMapRiverStyle(feature);
    return style.mouthWidth / 2 + style.bankWidth * 2;
  }
  const routeStyle = getMapRouteStyle(feature);
  if (routeStyle) {
    return Math.max(
      featureRadius(feature.props),
      ...mapRouteStrokeLayers(routeStyle).map((layer) => layer.width / 2),
    );
  }
  if (feature.kind === "node")
    return Math.max(48, featureRadius(feature.props));
  return featureRadius(feature.props);
}

function includeFeatureLabel(
  bounds: MapCanvasContentBounds,
  feature: MapDocument["features"][number],
): MapCanvasContentBounds {
  if (!mapFeatureHasLabel(feature)) return bounds;
  const style = getMapLabelStyle(feature);
  const layout = getMapLabelLayout(feature);
  const characterCount = Math.max(1, Array.from(feature.name).length);
  const width = characterCount * style.fontSize + style.haloWidth * 2;
  const height = style.fontSize + style.haloWidth * 2;
  return includePoint(
    bounds,
    {
      x: layout.anchor.x + style.offsetX,
      y: layout.anchor.y + style.offsetY,
    },
    Math.hypot(width, height) / 2,
  );
}

function collectContentBounds(
  map: MapDocument,
  options: { readonly includeBackground?: boolean } = {},
): MapCanvasContentBounds {
  let bounds = emptyBounds();
  const backgroundWidth = map.canvas.backgroundImageWidth;
  const backgroundHeight = map.canvas.backgroundImageHeight;
  const hasBackground = Boolean(
    map.canvas.backgroundImage || map.canvas.backgroundAssetPath,
  );
  // Azgaar 的 SVG 是完整渲染矩形，通常比转换后的可编辑几何大很多。
  // 生成几何已经是 MapDocument 的事实；把整张 SVG 当作边界会让首张地图
  // 固定在 1600x1000，并保留大量无法编辑的空海域。普通导入底图仍默认
  // 参与边界，只有生成器输出明确要求按几何包络构图时才跳过它。
  const includeBackground =
    options.includeBackground ??
    (!mapDocumentHasGeneratedContent(map) ||
      map.canvas.backgroundImagePlacement?.source === "author");
  // 普通导入底图也是 MapDocument 的内容。其 placement 一旦生成便是世界
  // 事实，因而必须与地形、要素一起参与四向扩展，不能在左上扩展后留在旧
  // 原点；生成器底图按上面的几何包络规则处理。
  if (
    includeBackground &&
    hasBackground &&
    map.canvas.backgroundImagePlacement
  ) {
    bounds = includeRectangle(bounds, map.canvas.backgroundImagePlacement);
  } else if (
    includeBackground &&
    hasBackground &&
    typeof backgroundWidth === "number" &&
    Number.isFinite(backgroundWidth) &&
    typeof backgroundHeight === "number" &&
    Number.isFinite(backgroundHeight)
  ) {
    const placement = getMapBackgroundImageContentPlacement(
      map.canvas,
      backgroundWidth,
      backgroundHeight,
    );
    if (placement) {
      bounds = includeRectangle(bounds, placement);
    }
  }
  map.features.forEach((feature) => {
    const renderedPoints =
      feature.kind === "route" &&
      (hasMapRiverAppearance(feature) || getMapRouteStyle(feature)?.id !== "plain")
        ? smoothMapPath(feature.points)
        : feature.points;
    bounds = includePoints(
      bounds,
      renderedPoints,
      featureGeometryRadius(map, feature),
    );
    bounds = includeFeatureLabel(bounds, feature);
  });
  map.scene?.layers.forEach((layer) => {
    layer.regions.forEach((region) => {
      bounds = includePoints(bounds, region.points, region.edgeWidth / 2);
    });
    layer.strokes.forEach((stroke) => {
      bounds = includePoints(
        bounds,
        stroke.points,
        artworkBrushRadius(map, stroke),
      );
    });
  });
  map.artwork.layers.forEach((layer) => {
    layer.stamps.forEach((stamp) => {
      bounds = includePoint(bounds, stamp, stampRadius(map, stamp));
    });
  });
  return bounds;
}

function translatePoints(
  points: readonly MapScenePoint[],
  translation: MapScenePoint,
): MapScenePoint[] {
  return points.map((point) => ({
    x: point.x + translation.x,
    y: point.y + translation.y,
  }));
}

function translateMapDocument(
  map: MapDocument,
  translation: MapScenePoint,
): MapDocument {
  const backgroundWidth = map.canvas.backgroundImageWidth;
  const backgroundHeight = map.canvas.backgroundImageHeight;
  const hasBackground = Boolean(
    map.canvas.backgroundImage || map.canvas.backgroundAssetPath,
  );
  const backgroundPlacement =
    map.canvas.backgroundImagePlacement ??
    (hasBackground &&
    typeof backgroundWidth === "number" &&
    Number.isFinite(backgroundWidth) &&
    typeof backgroundHeight === "number" &&
    Number.isFinite(backgroundHeight)
      ? getMapBackgroundImageContentPlacement(
          map.canvas,
          backgroundWidth,
          backgroundHeight,
        )
      : null);
  const generatedAutomaticPlacement =
    !map.canvas.backgroundImagePlacement &&
    mapDocumentHasGeneratedContent(map) &&
    backgroundPlacement
      ? { source: "automatic" as const }
      : {};
  if (translation.x === 0 && translation.y === 0 && !backgroundPlacement) {
    return map;
  }
  return {
    ...map,
    canvas: backgroundPlacement
      ? {
          ...map.canvas,
          backgroundImagePlacement: {
            ...backgroundPlacement,
            ...generatedAutomaticPlacement,
            x: backgroundPlacement.x + translation.x,
            y: backgroundPlacement.y + translation.y,
          },
        }
      : map.canvas,
    features: map.features.map((feature) => ({
      ...feature,
      points: translatePoints(feature.points, translation),
    })),
    scene: map.scene
      ? {
          ...map.scene,
          layers: map.scene.layers.map((layer) => ({
            ...layer,
            regions: layer.regions.map((region) => ({
              ...region,
              points: translatePoints(region.points, translation),
            })),
            strokes: layer.strokes.map((stroke) => ({
              ...stroke,
              points: translatePoints(stroke.points, translation),
            })),
          })),
        }
      : map.scene,
    artwork: {
      ...map.artwork,
      layers: map.artwork.layers.map((layer) => ({
        ...layer,
        stamps: layer.stamps.map((stamp) => ({
          ...stamp,
          x: stamp.x + translation.x,
          y: stamp.y + translation.y,
        })),
      })),
    },
  };
}

function expandedAxisSize(
  currentSize: number,
  contentEnd: number,
  leadingExtension: number,
  extension: number,
): number {
  const shiftedSize = currentSize + leadingExtension;
  // 左、上方向会在内容距边缘不足 extension 时平移全部事实。右、下方向
  // 必须遵守相同不变量，不能等内容已经越界才扩展；否则作者把山脉或城镇
  // 拖到边缘附近时，视觉画布仍保持旧尺寸，下一笔操作才突然生长。
  const requiredSize = Math.ceil(contentEnd + extension);
  if (requiredSize <= shiftedSize + EDGE_EPSILON) return shiftedSize;
  return requiredSize;
}

/**
 * 依据全部地图事实向四个方向扩展文档画布。
 *
 * 每个方向都必须给内容保留 `extension` 的成图留白。右侧和底部可直接
 * 增加尺寸；左侧和顶部没有独立 origin 字段，因此会把所有坐标整体平移到
 * 新留白之后。调用方可用 translation 补偿本地相机，持久化模型始终保持
 * 兼容的左上角为 (0, 0)。画布只会扩展，不会因删除内容自动缩小。
 */
export function expandMapCanvasToContentWithTranslation(
  map: MapDocument,
  extension = CANVAS_EXTENSION,
): MapCanvasContentExpansion {
  const bounds = collectContentBounds(map);
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) {
    return { map, translation: { x: 0, y: 0 } };
  }

  const safeExtension = Math.max(32, Math.round(extension));
  const translation = {
    // 不能只处理负坐标。内容即使刚好落在 0 处，也需要向左/上生长出
    // 可继续绘制的海面或陆地，避免生成地图贴着成图边缘。
    x: bounds.left < safeExtension ? Math.ceil(safeExtension - bounds.left) : 0,
    y: bounds.top < safeExtension ? Math.ceil(safeExtension - bounds.top) : 0,
  };
  const width = expandedAxisSize(
    map.canvas.width,
    bounds.right + translation.x,
    translation.x,
    safeExtension,
  );
  const height = expandedAxisSize(
    map.canvas.height,
    bounds.bottom + translation.y,
    translation.y,
    safeExtension,
  );
  if (
    translation.x === 0 &&
    translation.y === 0 &&
    width === map.canvas.width &&
    height === map.canvas.height
  ) {
    return { map, translation };
  }

  const translated = translateMapDocument(map, translation);
  return {
    map: {
      ...translated,
      canvas: {
        ...translated.canvas,
        width,
        height,
      },
    },
    translation,
  };
}

/** 保持原有调用方的直接返回值契约。 */
export function expandMapCanvasToContent(
  map: MapDocument,
  extension = CANVAS_EXTENSION,
): MapDocument {
  return expandMapCanvasToContentWithTranslation(map, extension).map;
}

/**
 * 将空地图首次接收的生成结果收束到实际内容包络。
 *
 * 默认画布是作者开始手绘时的工作区，不应成为生成地图的永久空白边界。
 * 该函数只允许从“无事实”到“首次生成事实”的过渡使用；已有地图一律返回
 * 原对象，后续编辑仍只走 expandMapCanvasToContent，保证作者手工留白不会
 * 因为一次生成或删除被重写。普通导入底图仍保留底图矩形作为世界事实；
 * 生成器的可编辑几何则优先决定首张地图包络，完整 SVG 只作为成图底稿裁切到
 * 这个包络内，避免固定的渲染矩形制造不可编辑空白。
 */
export function fitMapCanvasToContentWhenEmpty(
  previous: MapDocument,
  next: MapDocument,
  extension = CANVAS_EXTENSION,
): MapDocument {
  if (mapDocumentHasContent(previous) || !mapDocumentHasContent(next)) {
    return next;
  }

  const generatedGeometry = mapDocumentHasGeneratedContent(next);
  if (
    !generatedGeometry &&
    (next.canvas.backgroundImage || next.canvas.backgroundAssetPath)
  ) {
    return next;
  }

  return fitMapCanvasToGeneratedContentBounds(
    next,
    generatedGeometry,
    extension,
  );
}

function fitMapCanvasToGeneratedContentBounds(
  next: MapDocument,
  generatedGeometry: boolean,
  extension: number,
): MapDocument {
  const bounds = collectContentBounds(next, {
    // 生成器的完整 SVG 首次构图时仍按可编辑几何收束；一旦作者明确
    // 写入 placement，底图矩形就成为可编辑的世界事实，必须参与边界。
    includeBackground:
      !generatedGeometry ||
      next.canvas.backgroundImagePlacement?.source === "author",
  });
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.bottom)
  ) {
    return next;
  }

  // 首次内容本身已经完全位于默认工作区之外时，作者或调用方表达的是
  // “向那个方向扩展”，而不是把世界坐标重新收进中心。只有和初始画布
  // 相交的首批内容才需要消除默认 1600 x 1000 空白并按内容构图。
  const intersectsInitialCanvas =
    bounds.right >= 0 &&
    bounds.bottom >= 0 &&
    bounds.left <= next.canvas.width &&
    bounds.top <= next.canvas.height;
  if (!intersectsInitialCanvas) return next;

  const safeExtension = Math.max(32, Math.round(extension));
  const contentWidth = Math.max(0, bounds.right - bounds.left);
  const contentHeight = Math.max(0, bounds.bottom - bounds.top);
  // 初始尺寸只是空白工作区的临时默认值，不能成为有内容地图的隐式边界。
  // 第一次落图后，MapDocument 的尺寸精确由内容包络与四周留白推导；随后
  // 只允许 expandMapCanvasToContent 向外生长。这样小型群岛、单个聚落等
  // 不会被固定在一片巨大的空海域中，也不存在人工设置的最大尺寸。
  const width = Math.max(1, Math.ceil(contentWidth + safeExtension * 2));
  const height = Math.max(1, Math.ceil(contentHeight + safeExtension * 2));
  const leadingMarginX = safeExtension;
  const leadingMarginY = safeExtension;
  const translation = {
    x: Math.ceil(leadingMarginX - bounds.left),
    y: Math.ceil(leadingMarginY - bounds.top),
  };
  const translated = translateMapDocument(next, translation);
  return {
    ...translated,
    canvas: {
      ...translated.canvas,
      width,
      height,
    },
  };
}

/**
 * 将旧版仍使用默认尺寸的地图迁移到内容包络。
 *
 * 空白地图的 1600×1000 只属于新建时的临时交互工作区，并非作者显式定义的
 * 成图范围。旧版无论是 Agent 生成还是手工落下组件，只要仍保留该默认尺寸，
 * 打开时都应依据事实内容收束。已经向外扩展过的地图不满足尺寸条件，继续
 * 遵守只扩展不收缩；普通导入底图仍以其完整矩形作为作者定义的成图范围。
 */
export function fitMapCanvasToDefaultContent(
  map: MapDocument,
  extension = CANVAS_EXTENSION,
): MapDocument {
  if (
    map.canvas.width !== MAP_CANVAS_WIDTH ||
    map.canvas.height !== MAP_CANVAS_HEIGHT ||
    !mapDocumentHasContent(map)
  ) {
    return map;
  }
  const generatedGeometry = mapDocumentHasGeneratedContent(map);
  if (
    !generatedGeometry &&
    (map.canvas.backgroundImage || map.canvas.backgroundAssetPath)
  ) {
    return map;
  }
  return fitMapCanvasToGeneratedContentBounds(
    map,
    generatedGeometry,
    extension,
  );
}

/**
 * 兼容旧调用方：历史名称只表达最初的生成器迁移场景，实际契约已经扩展为
 * 所有仍使用默认空白尺寸的有内容地图。
 */
export function fitMapCanvasToGeneratedContent(
  map: MapDocument,
  extension = CANVAS_EXTENSION,
): MapDocument {
  return fitMapCanvasToDefaultContent(map, extension);
}
