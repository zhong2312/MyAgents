import type {
  MapFeatureKind,
  MapTerrainBrushShape,
} from "../entities/mapSchema";

/** 地图编辑会话可用的工具；选择态和相机态均不写入 MapDocument。 */
export type MapCanvasTool =
  | "select"
  | "move"
  | "pan"
  | "river"
  | "artwork-brush"
  | "artwork-stamp"
  /** 选定路径构件后自由拖绘，落图为带该构件样式的路线要素。 */
  | "component-path-brush"
  | "scene-eraser"
  | "terrain-land"
  | "terrain-water"
  | "terrain-region-land"
  | "terrain-region-water"
  | "terrain-prefab"
  | "terrain-material"
  /** 不预设表面语义的自由画笔；闭合后可在检查器提升为区域。 */
  | "freehand"
  /** 逐点创建开放路径，不把末点强制连接回起点。 */
  | "polygon"
  /** 选定表面构件后沿轨迹连续铺设该构件的区域语义。 */
  | "component-surface-brush"
  /** MapFeature 的历史 `polygon` 不作为新的画布工具暴露。 */
  | Exclude<MapFeatureKind, "polygon">;

/**
 * `closed` 是拖拽轨迹收口的闭合区域；`polygon` 是逐点创建的路径，
 * 可通过点击首点闭合，也可在任意位置确认保留为开放路径。
 */
export type MapAreaShape =
  | "closed"
  | "polygon"
  | "circle"
  | "ellipse"
  | "freehand";
export type MapBrushPointCurve = "line" | "arc";

/**
 * 画布工具的即时参数。它们属于编辑会话，不写入地图事实源；地理画布和
 * 拓扑画布可复用这份契约，而不依赖任一具体渲染组件。
 */
export interface MapCanvasSettings {
  readonly brushSize: number;
  readonly brushSpacing: number;
  readonly brushScatter: number;
  readonly brushOpacity: number;
  /** 画笔落地时的控制点数量；不保存到地图事实。 */
  readonly brushPointCount: number;
  /** 控制点重采样的几何方式。 */
  readonly brushPointCurve: MapBrushPointCurve;
  readonly terrainBrushShape: MapTerrainBrushShape;
  /** 画笔创建普通区域或开放多边形时的几何形状；只属于当前编辑会话。 */
  readonly areaShape: MapAreaShape;
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
  brushPointCount: 32,
  brushPointCurve: "line",
  terrainBrushShape: "organic",
  // “画笔”默认使用手绘轨迹；规则形状仅在作者主动切换时才生效。
  areaShape: "freehand",
  stampScale: 1,
  stampOpacity: 1,
  snapEnabled: false,
  snapGrid: 32,
});
