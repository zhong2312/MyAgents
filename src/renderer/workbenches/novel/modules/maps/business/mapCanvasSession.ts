import type {
  MapFeatureKind,
  MapTerrainBrushShape,
} from "../entities/mapSchema";

/** 地图编辑会话可用的工具；选择态和相机态均不写入 MapDocument。 */
export type MapCanvasTool =
  | "select"
  | "pan"
  | "artwork-brush"
  | "artwork-stamp"
  | "scene-eraser"
  | "terrain-land"
  | "terrain-water"
  | "terrain-region-land"
  | "terrain-region-water"
  | "terrain-prefab"
  | "terrain-material"
  | MapFeatureKind;

/**
 * 画布工具的即时参数。它们属于编辑会话，不写入地图事实源；地理画布和
 * 拓扑画布可复用这份契约，而不依赖任一具体渲染组件。
 */
export interface MapCanvasSettings {
  readonly brushSize: number;
  readonly brushSpacing: number;
  readonly brushScatter: number;
  readonly brushOpacity: number;
  readonly terrainBrushShape: MapTerrainBrushShape;
  readonly stampScale: number;
  readonly stampOpacity: number;
  readonly snapEnabled: boolean;
  readonly snapGrid: number;
}

export const DEFAULT_MAP_CANVAS_SETTINGS: MapCanvasSettings = Object.freeze({
  brushSize: 96,
  brushSpacing: 36,
  brushScatter: 0.35,
  brushOpacity: 1,
  terrainBrushShape: "round",
  stampScale: 1,
  stampOpacity: 1,
  snapEnabled: false,
  snapGrid: 32,
});
