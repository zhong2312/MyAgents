import type {
  MapScene,
  MapSceneLayerKind,
  MapScenePoint,
  MapSceneRegion,
  MapSceneStroke,
  MapTerrainStyle,
} from "../entities/mapSchema";

export function updateMapTerrainStyle(
  scene: MapScene,
  patch: Partial<MapTerrainStyle>,
): MapScene {
  return {
    ...scene,
    terrainStyle: { ...scene.terrainStyle, ...patch },
  };
}

export function sceneLayerKindForComponentCategory(
  category: string,
): MapSceneLayerKind {
  switch (category) {
    case "water":
      return "water";
    case "mountain":
      return "relief";
    case "vegetation":
      return "vegetation";
    case "civilization":
      return "civilization";
    case "landmark":
      return "labels";
    default:
      return "terrain";
  }
}

export function sceneLayerIdForKind(kind: MapSceneLayerKind): string {
  return `scene-${kind}`;
}

/**
 * 连续素材笔刷属于地物时只应落在陆地表面。水系、标签和效果保留跨海绘制，
 * 以支持洋流、海上标记与全图氛围效果。实际陆地边界仍完全由区域和地形笔触
 * 派生，不能在此处另存一份遮罩事实。
 */
export function mapSceneLayerBrushClipsToLand(
  kind: MapSceneLayerKind,
): boolean {
  return (
    kind === "terrain" ||
    kind === "relief" ||
    kind === "vegetation" ||
    kind === "civilization"
  );
}

/**
 * 无素材的地形笔触直接参与海陆遮罩合成。旧版保存在效果层的擦除笔触
 * 也按地形削减处理，避免继续在最终画布上留下透明孔洞。
 */
export function isMapTerrainMaskStroke(
  layerKind: MapSceneLayerKind,
  stroke: MapSceneStroke,
): boolean {
  return (
    stroke.brushAssetId === null &&
    stroke.terrainMaterial === null &&
    (layerKind === "terrain" || stroke.tool === "erase")
  );
}

export function isMapTerrainMaterialStroke(
  layerKind: MapSceneLayerKind,
  stroke: MapSceneStroke,
): boolean {
  return (
    layerKind === "terrain" &&
    stroke.tool === "paint" &&
    stroke.brushAssetId === null &&
    stroke.terrainMaterial !== null
  );
}

export function createMapSceneStroke(input: {
  readonly id: string;
  readonly layerId: string;
  readonly tool?: MapSceneStroke["tool"];
  readonly brushAssetId?: string | null;
  readonly terrainMaterial?: MapSceneStroke["terrainMaterial"];
  readonly shape?: MapSceneStroke["shape"];
  readonly points: readonly MapScenePoint[];
  readonly color: string;
  readonly width: number;
  readonly opacity?: number;
  readonly spacing?: number;
  readonly scatter?: number;
}): MapSceneStroke {
  return {
    id: input.id,
    layerId: input.layerId,
    tool: input.tool ?? "paint",
    brushAssetId: input.brushAssetId ?? null,
    terrainMaterial: input.terrainMaterial ?? null,
    shape: input.shape ?? "round",
    points: input.points.map((point) => ({
      x: point.x,
      y: point.y,
    })),
    color: input.color,
    width: input.width,
    opacity: input.opacity ?? 1,
    spacing: input.spacing ?? Math.max(8, input.width * 0.32),
    scatter: input.scatter ?? 0,
  };
}

export function createMapSceneRegion(input: {
  readonly id: string;
  readonly layerId: string;
  readonly kind: MapSceneRegion["kind"];
  readonly points: readonly MapScenePoint[];
  readonly fill?: string;
  readonly texture?: MapSceneRegion["texture"];
  readonly opacity?: number;
  readonly edgeColor?: string;
  readonly edgeWidth?: number;
}): MapSceneRegion {
  const isLand = input.kind === "land";
  return {
    id: input.id,
    layerId: input.layerId,
    kind: input.kind,
    points: input.points.map((point) => ({ x: point.x, y: point.y })),
    fill: input.fill ?? (isLand ? "#b8ad7d" : "#5d92a5"),
    texture: input.texture ?? (isLand ? "paper-land" : "water-ripple"),
    opacity: input.opacity ?? 1,
    edgeColor: input.edgeColor ?? (isLand ? "#5c5038" : "#2f6377"),
    edgeWidth: input.edgeWidth ?? (isLand ? 3 : 2.5),
  };
}

export function addMapSceneStroke(
  scene: MapScene,
  stroke: MapSceneStroke,
): MapScene {
  const layerExists = scene.layers.some((layer) => layer.id === stroke.layerId);
  if (!layerExists) return scene;
  return {
    ...scene,
    layers: scene.layers.map((layer) =>
      layer.id === stroke.layerId
        ? { ...layer, strokes: [...layer.strokes, stroke] }
        : layer,
    ),
  };
}

export function addMapSceneRegion(
  scene: MapScene,
  region: MapSceneRegion,
): MapScene {
  const layerExists = scene.layers.some((layer) => layer.id === region.layerId);
  if (!layerExists) return scene;
  return {
    ...scene,
    layers: scene.layers.map((layer) =>
      layer.id === region.layerId
        ? { ...layer, regions: [...layer.regions, region] }
        : layer,
    ),
  };
}

/**
 * 场景图层的数组顺序就是绘制顺序。基础地表与水域必须保持在最底层，其他
 * 可视层允许互换位置，以控制山脉、植被、城镇、标签与特效的前后景关系。
 */
export function moveMapSceneLayer(
  scene: MapScene,
  layerId: string,
  direction: -1 | 1,
): MapScene {
  const index = scene.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return scene;
  const layer = scene.layers[index]!;
  if (layer.kind === "terrain" || layer.kind === "water") return scene;

  const firstOverlayIndex = scene.layers.findIndex(
    (candidate) => candidate.kind !== "terrain" && candidate.kind !== "water",
  );
  const target = index + direction;
  if (
    firstOverlayIndex < 0 ||
    target < firstOverlayIndex ||
    target >= scene.layers.length
  ) {
    return scene;
  }
  const layers = [...scene.layers];
  [layers[index], layers[target]] = [layers[target]!, layers[index]!];
  return { ...scene, layers };
}

export function removeMapSceneStroke(
  scene: MapScene,
  strokeId: string,
): MapScene {
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({
      ...layer,
      strokes: layer.strokes.filter((stroke) => stroke.id !== strokeId),
    })),
  };
}

export function removeMapSceneRegion(
  scene: MapScene,
  regionId: string,
): MapScene {
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({
      ...layer,
      regions: layer.regions.filter((region) => region.id !== regionId),
    })),
  };
}

export function updateMapSceneStroke(
  scene: MapScene,
  strokeId: string,
  patch: Partial<Omit<MapSceneStroke, "id" | "layerId">>,
): MapScene {
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({
      ...layer,
      strokes: layer.strokes.map((stroke) =>
        stroke.id === strokeId ? { ...stroke, ...patch } : stroke,
      ),
    })),
  };
}

export function updateMapSceneRegion(
  scene: MapScene,
  regionId: string,
  patch: Partial<Omit<MapSceneRegion, "id" | "layerId">>,
): MapScene {
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({
      ...layer,
      regions: layer.regions.map((region) =>
        region.id === regionId ? { ...region, ...patch } : region,
      ),
    })),
  };
}
