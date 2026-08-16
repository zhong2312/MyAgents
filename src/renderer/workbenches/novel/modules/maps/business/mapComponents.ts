import type {
  MapFeature,
  MapFeatureKind,
  MapScenePoint,
  MapSceneRegion,
} from "../entities/mapSchema";

export const MAP_COMPONENT_CATEGORIES = [
  { id: "celestial", name: "星球与天象" },
  { id: "landmass", name: "大陆板块" },
  { id: "mountain", name: "山川地貌" },
  { id: "vegetation", name: "植被生态" },
  { id: "water", name: "河流水系" },
  { id: "civilization", name: "文明道路" },
  { id: "landmark", name: "势力与地标" },
] as const;

export type MapComponentCategory =
  (typeof MAP_COMPONENT_CATEGORIES)[number]["id"];

export type MapComponentPreset = {
  readonly id: string;
  readonly category: MapComponentCategory;
  readonly name: string;
  readonly description: string;
  readonly drawKind: MapFeatureKind;
  readonly props: Readonly<Record<string, string>>;
  /** 构件在画布上的落地语义，避免“点击”和“拖入”写出不同类型的对象。 */
  readonly placement?: MapComponentPlacement;
  /** 大陆类构件直接生成 MapScene 海陆区域，而不是一层装饰多边形。 */
  readonly terrainPrefab?: MapComponentTerrainPrefab;
};

export type MapComponentPlacement = "stamp" | "path" | "terrain-prefab";

/** 从资产库拖到画布时用于确定预制件尺寸和方向的手势。 */
export type MapComponentPlacementGesture = {
  readonly start: MapScenePoint;
  readonly end: MapScenePoint;
};

export type MapComponentTerrainPrefab = {
  readonly kind: MapSceneRegion["kind"];
  readonly layout: "single" | "archipelago";
  readonly fill: string;
  readonly texture: MapSceneRegion["texture"];
  readonly edgeColor: string;
  readonly edgeWidth: number;
};

export const MAP_COMPONENT_DRAG_MIME =
  "application/x-myagents-map-component" as const;

const component = (
  id: string,
  category: MapComponentCategory,
  name: string,
  description: string,
  drawKind: MapFeatureKind,
  props: Readonly<Record<string, string>>,
  terrainPrefab?: MapComponentTerrainPrefab,
  placement?: MapComponentPlacement,
): MapComponentPreset => ({
  id,
  category,
  name,
  description,
  drawKind,
  props,
  placement,
  terrainPrefab,
});

export const MAP_COMPONENT_PRESETS: readonly MapComponentPreset[] =
  Object.freeze([
    component("star", "celestial", "恒星", "恒星、太阳或主光源。", "marker", {
      component: "star",
      symbol: "star",
      color: "#f7c948",
      showLabel: "true",
    }),
    component(
      "planet",
      "celestial",
      "行星",
      "行星、主世界或可居住天体。",
      "marker",
      {
        component: "planet",
        symbol: "planet",
        color: "#5aa0c8",
        showLabel: "true",
      },
    ),
    component(
      "ringed-planet",
      "celestial",
      "星环行星",
      "具有环带的巨型行星。",
      "marker",
      {
        component: "ringed-planet",
        symbol: "ringed-planet",
        color: "#c99a68",
        showLabel: "true",
      },
    ),
    component("moon", "celestial", "卫星", "月亮、卫星或伴生天体。", "marker", {
      component: "moon",
      symbol: "moon",
      color: "#c8d1d8",
      showLabel: "true",
    }),
    component(
      "nebula",
      "celestial",
      "星云",
      "发光星云、虚空风暴或能量云团。",
      "area",
      {
        component: "nebula",
        terrain: "nebula",
        color: "#a478b8",
        fill: "#a478b840",
        radius: "120",
        showLabel: "true",
      },
    ),
    component(
      "world-gate",
      "celestial",
      "世界之门",
      "跨世界通道或星际跃迁门。",
      "marker",
      {
        component: "world-gate",
        symbol: "portal",
        color: "#a770d6",
        showLabel: "true",
      },
    ),
    component(
      "continent",
      "landmass",
      "大陆板块",
      "连续大陆、主陆块或巨大浮陆。",
      "polygon",
      {
        component: "continent",
        terrain: "continent",
        color: "#627a55",
        fill: "#90a87a88",
        lineWidth: "2",
        showLabel: "true",
      },
      {
        kind: "land",
        layout: "single",
        fill: "#b8ad7d",
        texture: "paper-land",
        edgeColor: "#5c5038",
        edgeWidth: 3,
      },
    ),
    component(
      "archipelago",
      "landmass",
      "群岛",
      "群岛、岛链或碎裂陆架。",
      "area",
      {
        component: "archipelago",
        terrain: "islands",
        color: "#d7cf9a",
        fill: "#d7cf9a66",
        radius: "95",
        showLabel: "true",
      },
      {
        kind: "land",
        layout: "archipelago",
        fill: "#c5b986",
        texture: "paper-land",
        edgeColor: "#6a6047",
        edgeWidth: 2.2,
      },
    ),
    component(
      "rift",
      "landmass",
      "裂谷断层",
      "板块边界、裂谷或地壳断层。",
      "route",
      {
        component: "rift",
        terrain: "rift",
        color: "#6d4b42",
        lineWidth: "3",
        showLabel: "true",
      },
    ),
    component(
      "mountain-range",
      "mountain",
      "山脉",
      "山脉、龙脉或高原脊线。",
      "route",
      {
        component: "mountain-range",
        terrain: "mountain",
        symbol: "peaks",
        color: "#715f4d",
        lineWidth: "3",
        showLabel: "true",
      },
      undefined,
      "stamp",
    ),
    component(
      "snow-peak",
      "mountain",
      "雪峰",
      "孤立雪峰、极寒高山或世界屋脊。",
      "marker",
      {
        component: "snow-peak",
        terrain: "mountain",
        symbol: "snow-peak",
        color: "#716c66",
        showLabel: "true",
      },
    ),
    component(
      "foothills",
      "mountain",
      "丘陵",
      "低矮丘陵、山麓缓坡或起伏台地。",
      "marker",
      {
        component: "foothills",
        terrain: "hills",
        symbol: "hills",
        color: "#81735a",
        showLabel: "true",
      },
    ),
    component(
      "mesa",
      "mountain",
      "高原台地",
      "桌状山、高原边缘或风蚀台地。",
      "marker",
      {
        component: "mesa",
        terrain: "mesa",
        symbol: "mesa",
        color: "#9a6549",
        showLabel: "true",
      },
    ),
    component(
      "volcano",
      "mountain",
      "火山",
      "火山、火山口或熔岩核心。",
      "marker",
      {
        component: "volcano",
        terrain: "volcano",
        symbol: "volcano",
        color: "#b7533a",
        showLabel: "true",
      },
    ),
    component(
      "canyon",
      "mountain",
      "峡谷",
      "峡谷、天堑或地下裂隙入口。",
      "route",
      {
        component: "canyon",
        terrain: "canyon",
        color: "#8c6044",
        lineWidth: "4",
        showLabel: "true",
      },
    ),
    component(
      "forest",
      "vegetation",
      "森林",
      "森林、古林或妖兽栖地。",
      "area",
      {
        component: "forest",
        terrain: "forest",
        symbol: "forest",
        color: "#3f7650",
        fill: "#4d8a5466",
        radius: "92",
        showLabel: "true",
      },
    ),
    component(
      "pine-grove",
      "vegetation",
      "针叶林",
      "高寒针叶林、黑森林或山地林带。",
      "marker",
      {
        component: "pine-grove",
        terrain: "forest",
        symbol: "pine-grove",
        color: "#315f48",
        showLabel: "true",
      },
    ),
    component(
      "deadwood",
      "vegetation",
      "枯木林",
      "死寂林地、腐化森林或灾变遗迹。",
      "marker",
      {
        component: "deadwood",
        terrain: "deadwood",
        symbol: "deadwood",
        color: "#705d4d",
        showLabel: "true",
      },
    ),
    component(
      "jungle",
      "vegetation",
      "雨林",
      "雨林、密林或瘴气覆盖区。",
      "area",
      {
        component: "jungle",
        terrain: "jungle",
        color: "#246247",
        fill: "#397e4d77",
        radius: "90",
        showLabel: "true",
      },
    ),
    component("wetland", "vegetation", "湿地", "沼泽、湿地与水泽。", "area", {
      component: "wetland",
      terrain: "wetland",
      color: "#5e8e80",
      fill: "#74a89b66",
      radius: "86",
      showLabel: "true",
    }),
    component(
      "grassland",
      "vegetation",
      "草原",
      "草场、荒原或游牧地带。",
      "polygon",
      {
        component: "grassland",
        terrain: "grassland",
        color: "#97a858",
        fill: "#b8c57266",
        lineWidth: "2",
        showLabel: "true",
      },
    ),
    component("river", "water", "河流", "主河、灵河或地下河道。", "route", {
      component: "river",
      terrain: "river",
      color: "#3b83a5",
      bankColor: "#315d6c",
      highlightColor: "#c7edf1",
      lineWidth: "4",
      sourceWidth: "2",
      mouthWidth: "10",
      bankWidth: "1.7",
      showLabel: "true",
    }),
    component("lake", "water", "湖泊", "湖泊、内海或灵泉水域。", "area", {
      component: "lake",
      terrain: "lake",
      color: "#3f89a8",
      fill: "#68acd066",
      radius: "88",
      showLabel: "true",
    }),
    component(
      "waterfall",
      "water",
      "瀑布",
      "瀑布、飞瀑或水系落差。",
      "marker",
      {
        component: "waterfall",
        terrain: "waterfall",
        symbol: "waterfall",
        color: "#8fd0df",
        showLabel: "true",
      },
    ),
    component(
      "ocean-current",
      "water",
      "洋流",
      "洋流、海上航线或潮汐通道。",
      "route",
      {
        component: "ocean-current",
        terrain: "current",
        color: "#8bbfd2",
        lineWidth: "2",
        showLabel: "true",
      },
    ),
    component(
      "city",
      "civilization",
      "城市",
      "城市、城镇或聚落中心。",
      "marker",
      {
        component: "city",
        symbol: "city",
        color: "#865f4a",
        showLabel: "true",
      },
    ),
    component(
      "village",
      "civilization",
      "村镇",
      "村庄、小镇、驿站或边地聚落。",
      "marker",
      {
        component: "village",
        symbol: "village",
        color: "#8a684d",
        showLabel: "true",
      },
    ),
    component(
      "port",
      "civilization",
      "港口",
      "海港、河港、船坞或贸易口岸。",
      "marker",
      {
        component: "port",
        symbol: "port",
        color: "#486f79",
        showLabel: "true",
      },
    ),
    component(
      "watchtower",
      "civilization",
      "哨塔",
      "烽火台、边境哨塔或高地瞭望所。",
      "marker",
      {
        component: "watchtower",
        symbol: "watchtower",
        color: "#6e6258",
        showLabel: "true",
      },
    ),
    component(
      "bridge",
      "civilization",
      "桥梁",
      "跨河桥梁、古桥或战略渡口。",
      "marker",
      {
        component: "bridge",
        symbol: "bridge",
        color: "#826a52",
        showLabel: "true",
      },
    ),
    component(
      "capital",
      "civilization",
      "都城",
      "王都、帝都或核心城邦。",
      "marker",
      {
        component: "capital",
        symbol: "capital",
        color: "#b55a3e",
        showLabel: "true",
      },
    ),
    component(
      "fortress",
      "civilization",
      "要塞",
      "关隘、堡垒或军事节点。",
      "marker",
      {
        component: "fortress",
        symbol: "fortress",
        color: "#5c6668",
        showLabel: "true",
      },
    ),
    component(
      "road",
      "civilization",
      "道路",
      "商路、驿道或战略通路。",
      "route",
      {
        component: "road",
        terrain: "road",
        routeStyle: "road",
        routeWidth: "7",
        routeColor: "#c49a69",
        routeCasingColor: "#654934",
        showLabel: "true",
      },
    ),
    component(
      "wall",
      "civilization",
      "城墙",
      "城防墙、长城、关塞防线或隔绝结界。",
      "route",
      {
        component: "wall",
        terrain: "wall",
        routeStyle: "wall",
        routeWidth: "10",
        routeColor: "#a59780",
        routeCasingColor: "#3c3630",
        showLabel: "true",
      },
    ),
    component(
      "border",
      "civilization",
      "疆界",
      "国界、势力边界或封锁线。",
      "route",
      {
        component: "border",
        terrain: "border",
        routeStyle: "border",
        routeWidth: "2.5",
        routeColor: "#a74742",
        showLabel: "true",
      },
    ),
    component(
      "faction-seat",
      "landmark",
      "势力驻地",
      "宗门、家族、王庭或组织总部。",
      "marker",
      {
        component: "faction-seat",
        symbol: "faction",
        color: "#965c3e",
        showLabel: "true",
      },
    ),
    component(
      "secret-realm",
      "landmark",
      "秘境",
      "秘境、洞天、遗迹空间或试炼场。",
      "marker",
      {
        component: "secret-realm",
        symbol: "secret-realm",
        color: "#865ab4",
        showLabel: "true",
      },
    ),
    component(
      "ruins",
      "landmark",
      "遗迹",
      "古战场、废墟或文明残片。",
      "marker",
      {
        component: "ruins",
        symbol: "ruins",
        color: "#8d725b",
        showLabel: "true",
      },
    ),
    component(
      "portal",
      "landmark",
      "传送阵",
      "传送阵、界门或空间裂口。",
      "marker",
      {
        component: "portal",
        symbol: "portal",
        color: "#7c73d4",
        showLabel: "true",
      },
    ),
    component(
      "temple",
      "landmark",
      "圣地",
      "神殿、祭坛、灵脉或修行圣地。",
      "marker",
      {
        component: "temple",
        symbol: "temple",
        color: "#c49647",
        showLabel: "true",
      },
    ),
    component(
      "resource",
      "landmark",
      "资源点",
      "矿脉、药田、灵泉或战略资源。",
      "marker",
      {
        component: "resource",
        symbol: "resource",
        color: "#4f936f",
        showLabel: "true",
      },
    ),
    component(
      "cave",
      "landmark",
      "洞穴",
      "天然洞穴、地下入口或怪物巢穴。",
      "marker",
      {
        component: "cave",
        symbol: "cave",
        color: "#665a50",
        showLabel: "true",
      },
    ),
    component(
      "obelisk",
      "landmark",
      "方尖碑",
      "纪念碑、远古石柱或导航地标。",
      "marker",
      {
        component: "obelisk",
        symbol: "obelisk",
        color: "#7a7068",
        showLabel: "true",
      },
    ),
  ]);

/**
 * 预制件的视觉成图与语义对象在此处分流：海陆保留区域事实，路线保留控制点，
 * 其余构件使用可直接变换的成品印章。
 */
export function mapComponentPlacement(
  component: MapComponentPreset,
): MapComponentPlacement {
  if (component.placement) return component.placement;
  if (component.terrainPrefab) return "terrain-prefab";
  return component.drawKind === "route" ? "path" : "stamp";
}

export function mapComponentsInCategory(
  category: MapComponentCategory,
): readonly MapComponentPreset[] {
  return MAP_COMPONENT_PRESETS.filter((item) => item.category === category);
}

type PrefabPoint = readonly [number, number];

function hashPrefabSeed(seed: string): number {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function prefabNoise(seed: string, index: number): number {
  let value = (hashPrefabSeed(`${seed}:${index}`) + 0x6d2b79f5) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

/**
 * 以极坐标生成可重建的海岸线。端点保持在 x = +/- 0.5，保证拖拽
 * 手势仍然代表预制件的实际宽度；其余采样点通过多频率扰动形成海湾、
 * 半岛和不对称轮廓，而不是固定的规则多边形。
 */
function organicCoastline(
  seed: string,
  vertices: number,
  aspect = 1,
): readonly PrefabPoint[] {
  const count = Math.max(24, Math.round(vertices));
  const phase = prefabNoise(seed, 1) * Math.PI * 2;
  const secondaryPhase = prefabNoise(seed, 2) * Math.PI * 2;
  const points: PrefabPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    const isHorizontalAnchor = index === 0 || index === Math.round(count / 2);
    const low = Math.sin(angle * 2 + phase) * 0.1;
    const middle = Math.sin(angle * 5 + secondaryPhase) * 0.065;
    const high = (prefabNoise(seed, index + 10) - 0.5) * 0.09;
    const bay = Math.sin(angle * 3 + phase * 0.4) > 0.72 ? -0.12 : 0;
    const radius = isHorizontalAnchor
      ? 1
      : Math.max(0.62, Math.min(1.12, 0.92 + low + middle + high + bay));
    points.push([
      Math.cos(angle) * 0.5 * radius,
      Math.sin(angle) * 0.5 * radius * aspect,
    ]);
  }
  return points;
}

const PREFAB_SHAPES: Readonly<Record<string, readonly PrefabPoint[]>> = {
  continent: [
    [-0.5, -0.08],
    [-0.38, -0.38],
    [-0.08, -0.5],
    [0.12, -0.38],
    [0.42, -0.46],
    [0.5, -0.08],
    [0.34, 0.18],
    [0.4, 0.42],
    [0.05, 0.5],
    [-0.16, 0.34],
    [-0.46, 0.38],
  ],
  grassland: [
    [-0.48, -0.15],
    [-0.24, -0.44],
    [0.18, -0.48],
    [0.46, -0.2],
    [0.5, 0.25],
    [0.16, 0.46],
    [-0.25, 0.4],
    [-0.5, 0.12],
  ],
  river: [
    [-0.5, -0.42],
    [-0.28, -0.2],
    [-0.34, 0.04],
    [-0.02, 0.22],
    [0.16, 0.08],
    [0.34, 0.3],
    [0.5, 0.44],
  ],
  "mountain-range": [
    [-0.5, 0.28],
    [-0.28, -0.18],
    [-0.08, 0.08],
    [0.12, -0.32],
    [0.32, -0.04],
    [0.5, -0.38],
  ],
  rift: [
    [-0.5, -0.32],
    [-0.22, -0.12],
    [-0.06, 0.14],
    [0.22, 0.02],
    [0.5, 0.32],
  ],
  canyon: [
    [-0.5, -0.1],
    [-0.22, -0.3],
    [0.02, 0.02],
    [0.26, -0.16],
    [0.5, 0.18],
  ],
  "ocean-current": [
    [-0.5, 0.18],
    [-0.25, -0.08],
    [0.02, -0.18],
    [0.28, -0.02],
    [0.5, -0.24],
  ],
  road: [
    [-0.5, 0.2],
    [-0.18, 0.04],
    [0.12, 0.08],
    [0.5, -0.18],
  ],
  wall: [
    [-0.5, 0.16],
    [-0.28, -0.08],
    [-0.02, 0.08],
    [0.22, -0.18],
    [0.5, 0.06],
  ],
  border: [
    [-0.5, -0.24],
    [-0.2, -0.1],
    [0.08, -0.22],
    [0.28, 0.08],
    [0.5, 0.2],
  ],
};

function prefabSize(component: MapComponentPreset): {
  readonly width: number;
  readonly height: number;
} {
  if (component.id === "continent") return { width: 440, height: 300 };
  if (component.id === "grassland") return { width: 280, height: 190 };
  if (component.drawKind === "route") return { width: 340, height: 180 };
  return { width: 180, height: 140 };
}

function placementAnchor(
  anchor: MapScenePoint,
  gesture: MapComponentPlacementGesture | undefined,
): MapScenePoint {
  if (!gesture) return anchor;
  return {
    x: (gesture.start.x + gesture.end.x) / 2,
    y: (gesture.start.y + gesture.end.y) / 2,
  };
}

function transformPrefabPoints(input: {
  readonly points: readonly MapScenePoint[];
  readonly anchor: MapScenePoint;
  readonly component: MapComponentPreset;
  readonly gesture?: MapComponentPlacementGesture;
}): MapScenePoint[] {
  const gesture = input.gesture;
  if (!gesture) return input.points.map((point) => ({ ...point }));
  const delta = {
    x: gesture.end.x - gesture.start.x,
    y: gesture.end.y - gesture.start.y,
  };
  const distance = Math.hypot(delta.x, delta.y);
  if (!Number.isFinite(distance) || distance < 8) {
    return input.points.map((point) => ({ ...point }));
  }
  const baseWidth =
    input.component.id === "archipelago"
      ? 440
      : prefabSize(input.component).width;
  const scale = Math.max(0.2, Math.min(8, distance / baseWidth));
  const angle = Math.atan2(delta.y, delta.x);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return input.points.map((point) => {
    const localX = (point.x - input.anchor.x) * scale;
    const localY = (point.y - input.anchor.y) * scale;
    return {
      x: Math.round(input.anchor.x + localX * cosine - localY * sine),
      y: Math.round(input.anchor.y + localX * sine + localY * cosine),
    };
  });
}

function defaultPrefabShape(
  component: MapComponentPreset,
): readonly PrefabPoint[] {
  if (component.drawKind === "polygon") {
    return [
      [-0.5, -0.18],
      [-0.2, -0.5],
      [0.32, -0.4],
      [0.5, 0.16],
      [0.12, 0.5],
      [-0.4, 0.34],
    ];
  }
  return [
    [-0.5, 0.2],
    [-0.12, -0.16],
    [0.22, 0.08],
    [0.5, -0.22],
  ];
}

function prefabPoints(input: {
  readonly component: MapComponentPreset;
  readonly id: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly gesture?: MapComponentPlacementGesture;
}): MapFeature["points"] {
  const { component } = input;
  const anchor = placementAnchor(input.anchor, input.gesture);
  const size = prefabSize(component);
  if (component.drawKind === "marker" || component.drawKind === "area") {
    return [
      {
        x: roundMapCoordinate(anchor.x),
        y: roundMapCoordinate(anchor.y),
      },
    ];
  }
  const shape =
    component.id === "continent"
      ? organicCoastline(`${input.id}:continent`, 64, 0.82)
      : PREFAB_SHAPES[component.id] ?? defaultPrefabShape(component);
  const points = shape.map(([x, y]) => ({
    x: roundMapCoordinate(anchor.x + x * size.width),
    y: roundMapCoordinate(anchor.y + y * size.height),
  }));
  return transformPrefabPoints({
    points,
    anchor,
    component,
    gesture: input.gesture,
  });
}

type ArchipelagoIsland = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
};

function organicArchipelagoLayout(seed: string): readonly ArchipelagoIsland[] {
  const count = 7;
  const angle = (prefabNoise(seed, 31) - 0.5) * 0.7;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1) - 0.5;
    const along = progress * 430 + (prefabNoise(seed, index + 40) - 0.5) * 34;
    const arc =
      Math.sin(progress * Math.PI) *
        (54 + prefabNoise(seed, index + 50) * 48) +
      (prefabNoise(seed, index + 60) - 0.5) * 38;
    return {
      x: along * cosine - arc * sine,
      y: along * sine + arc * cosine,
      // 保留一两座明显更大的岛屿，避免群岛退化为等距、等大的重复圆块。
      scale:
        0.15 +
        prefabNoise(seed, index + 70) * 0.16 +
        (index === 2 || index === 4 ? 0.08 : 0),
    };
  });
}

function archipelagoPoints(input: {
  readonly component: MapComponentPreset;
  readonly id: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly gesture?: MapComponentPlacementGesture;
}): readonly MapFeature["points"][] {
  const anchor = placementAnchor(input.anchor, input.gesture);
  return organicArchipelagoLayout(input.id).map((island, index) => {
    const shape = organicCoastline(
      `${input.id}:island:${index}`,
      40,
      0.82 + prefabNoise(`${input.id}:${island.x}:${island.y}`, 9) * 0.16,
    );
    const points = shape.map(([x, y]) => ({
      x: roundMapCoordinate(anchor.x + island.x + x * 440 * island.scale),
      y: roundMapCoordinate(anchor.y + island.y + y * 300 * island.scale),
    }));
    return transformPrefabPoints({
      points,
      anchor,
      component: input.component,
      gesture: input.gesture,
    });
  });
}

/** 将大陆与群岛预制件转换为真实海陆区域；其他构件保持语义要素。 */
export function createMapComponentPrefabRegions(input: {
  readonly component: MapComponentPreset;
  readonly id: string;
  readonly layerId: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly gesture?: MapComponentPlacementGesture;
}): readonly MapSceneRegion[] {
  const terrainPrefab = input.component.terrainPrefab;
  if (!terrainPrefab) return [];
  const pointSets =
    terrainPrefab.layout === "archipelago"
      ? archipelagoPoints(input)
      : [prefabPoints(input)];
  return pointSets
    .filter((points) => points.length >= 3)
    .map((points, index) => ({
      id: index === 0 ? input.id : `${input.id}-${index + 1}`,
      layerId: input.layerId,
      kind: terrainPrefab.kind,
      points,
      fill: terrainPrefab.fill,
      texture: terrainPrefab.texture,
      opacity: 1,
      edgeColor: terrainPrefab.edgeColor,
      edgeWidth: terrainPrefab.edgeWidth,
    }));
}

function roundMapCoordinate(value: number): number {
  // 四个方向均由 expandMapCanvasToContent 统一扩展，预制件必须保留原始轮廓。
  return Math.round(value);
}

export function createMapComponentPrefabFeature(input: {
  readonly component: MapComponentPreset;
  readonly id: string;
  readonly layerId: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly gesture?: MapComponentPlacementGesture;
}): MapFeature {
  const { component } = input;
  const points = prefabPoints(input);
  return {
    id: input.id,
    kind: component.drawKind,
    name: `未命名${component.name}`,
    entityRef: null,
    layerId: input.layerId,
    points,
    timeFrom: null,
    timeTo: null,
    props: {
      ...component.props,
    },
    description: component.description,
  };
}
