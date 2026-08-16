import type {
  MapArtwork,
  MapArtworkLayer,
  MapArtworkLayerKind,
} from "../entities/mapSchema";

/**
 * 素材层与地图其它内容的固定合成锚点。层内相对顺序仍由作者调整，
 * 从而避免地形、标注、特效互相遮挡时只能依赖偶然的创建先后。
 */
export const MAP_ARTWORK_RENDER_PHASES = [
  "base",
  "scene",
  "feature",
  "overlay",
] as const;

export type MapArtworkRenderPhase = (typeof MAP_ARTWORK_RENDER_PHASES)[number];

const LAYER_PHASE: Readonly<
  Record<MapArtworkLayerKind, MapArtworkRenderPhase>
> = Object.freeze({
  terrain: "base",
  water: "base",
  relief: "scene",
  vegetation: "scene",
  stamp: "feature",
  label: "overlay",
  effect: "overlay",
});

export function mapArtworkLayerRenderPhase(
  kind: MapArtworkLayerKind,
): MapArtworkRenderPhase {
  return LAYER_PHASE[kind];
}

/** 地图 JSON 的图层数组固定按背景到前景存储和绘制。 */
export function mapArtworkLayersInRenderOrder(
  artwork: MapArtwork,
  phase?: MapArtworkRenderPhase,
): readonly MapArtworkLayer[] {
  return phase
    ? artwork.layers.filter(
        (layer) => mapArtworkLayerRenderPhase(layer.kind) === phase,
      )
    : artwork.layers;
}

/** 编辑器面板从前景到背景展示，和普通图层面板的阅读方式一致。 */
export function mapArtworkLayersInPanelOrder(
  artwork: MapArtwork,
): readonly MapArtworkLayer[] {
  return [...artwork.layers].reverse();
}
