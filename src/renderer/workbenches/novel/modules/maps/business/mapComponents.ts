import type {
  MapFeature,
  MapFeatureKind,
  MapScenePoint,
  MapSceneRegion,
} from "../entities/mapSchema";
import { DEFAULT_MAP_RIVER_PROPS } from "./mapHydrography";

export const MAP_COMPONENT_CATEGORIES = [
  { id: "celestial", name: "星球与天象" },
  { id: "landmass", name: "大陆板块" },
  { id: "mountain", name: "山川地貌" },
  { id: "vegetation", name: "植被生态" },
  { id: "water", name: "河流水系" },
  { id: "civilization", name: "文明道路" },
  { id: "landmark", name: "势力与地标" },
  { id: "cartography", name: "制图修饰" },
] as const;

export type MapComponentCategory =
  (typeof MAP_COMPONENT_CATEGORIES)[number]["id"];

/** 所有构件只能通过这四种用户交互落图。 */
export const MAP_COMPONENT_INTERACTIONS = [
  { id: "surface", name: "区域/材质笔刷" },
  { id: "scatter", name: "素材笔刷" },
  { id: "path", name: "路径笔刷" },
  { id: "stamp", name: "独立印章" },
] as const;

export type MapComponentInteraction =
  (typeof MAP_COMPONENT_INTERACTIONS)[number]["id"];

export type MapComponentPreset = {
  readonly id: string;
  readonly category: MapComponentCategory;
  readonly name: string;
  readonly description: string;
  readonly interaction: MapComponentInteraction;
  readonly drawKind: MapFeatureKind;
  readonly props: Readonly<Record<string, string>>;
  /** 构件在画布上的落地语义，避免“点击”和“拖入”写出不同类型的对象。 */
  readonly placement?: MapComponentPlacement;
  /** 素材笔刷是否沿路径切线转向；未声明时保持素材自身朝向。 */
  readonly followsPath?: boolean;
  /** 大陆类构件直接生成 MapScene 海陆区域，而不是一层装饰多边形。 */
  readonly terrainPrefab?: MapComponentTerrainPrefab;
};

export type MapComponentPlacement =
  | "stamp"
  | "path"
  | "terrain-prefab"
  /** 不改变海陆事实的连续覆盖区域，落为 MapFeature area。 */
  | "overlay";

/** 从资产库拖到画布时用于确定预制件尺寸和方向的手势。 */
export type MapComponentPlacementGesture = {
  readonly start: MapScenePoint;
  readonly end: MapScenePoint;
};

export type MapComponentTerrainPrefab = {
  readonly kind: MapSceneRegion["kind"];
  readonly layout: "single" | "archipelago";
  /** 预制件的稳定轮廓语义；具体控制点由地图坐标重建，不保存像素。 */
  readonly shape?: MapComponentTerrainShape;
  readonly fill: string;
  readonly texture: MapSceneRegion["texture"];
  readonly edgeColor: string;
  readonly edgeWidth: number;
};

export type MapComponentTerrainShape =
  | "organic"
  | "archipelago"
  | "supercontinent"
  | "twin-lobe-continent"
  | "crescent-continent"
  | "ring-continent"
  | "peninsula-chain"
  | "rifted-continent"
  | "triangle-continent"
  | "fingered-coast"
  | "inland-sea-continent"
  | "shield-continent"
  | "longshore-continent"
  | "hook-continent"
  | "twin-continent"
  | "broken-continent"
  | "volcanic-islands"
  | "coral-islands"
  | "reef-ring"
  | "arc-islands"
  | "delta"
  | "lake"
  | "wetland"
  | "ice-sheet"
  | "shoal"
  | "inland-water"
  | "lagoon"
  | "crescent-bay"
  | "fjord-water"
  | "strait"
  | "lake-cluster"
  | "crater-lake"
  | "oxbow-lake"
  | "salt-lake"
  | "glacial-lake"
  | "marsh-lake"
  | "shelf-sea"
  | "coral-sea"
  | "deep-trench"
  | "tidal-flat";

// 交互语义的唯一默认来源。mapArtwork 只读取 component.interaction，避免
// 素材目录再维护一份 brush id 白名单。
const DEFAULT_SCATTER_COMPONENT_IDS = new Set([
  "mountain-range",
  "snow-peak",
  "foothills",
  "cliff",
  "dunes",
  "glacier",
  "boulder-field",
  "forest",
  "broadleaf-grove",
  "pine-grove",
  "bamboo-grove",
  "deadwood",
  "jungle",
  "wetland",
  "grassland",
  "shrubland",
  "reed-bed",
  "mangrove",
  "coral-reef",
  "seaweed-bed",
  "sea-foam",
  "ice-floe",
  "farmland",
  "terraces",
  "village",
]);

const DEFAULT_PATH_FOLLOW_COMPONENT_IDS = new Set([
  "mountain-range",
  "cliff",
  "sea-foam",
]);

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
  interaction?: MapComponentInteraction,
  followsPath = false,
): MapComponentPreset => ({
  id,
  category,
  name,
  description,
  interaction:
    interaction ??
    (terrainPrefab
      ? "surface"
      : placement === "path" || drawKind === "route"
        ? "path"
        : DEFAULT_SCATTER_COMPONENT_IDS.has(id)
          ? "scatter"
          : "stamp"),
  drawKind,
  props,
  placement,
  terrainPrefab,
  followsPath: followsPath || DEFAULT_PATH_FOLLOW_COMPONENT_IDS.has(id),
});

function simpleStamp(
  id: string,
  category: MapComponentCategory,
  name: string,
  description: string,
  color: string,
  symbol = id,
): MapComponentPreset {
  return component(
    id,
    category,
    name,
    description,
    "marker",
    { component: id, symbol, color, showLabel: "true" },
    undefined,
    "stamp",
    "stamp",
  );
}

function simpleScatter(
  id: string,
  category: MapComponentCategory,
  name: string,
  description: string,
  color: string,
  symbol = id,
  followsPath = false,
): MapComponentPreset {
  return component(
    id,
    category,
    name,
    description,
    "marker",
    { component: id, terrain: id, symbol, color, showLabel: "true" },
    undefined,
    "stamp",
    "scatter",
    followsPath,
  );
}

function simplePath(
  id: string,
  category: MapComponentCategory,
  name: string,
  description: string,
  color: string,
  props: Readonly<Record<string, string>> = {},
  followsPath = false,
): MapComponentPreset {
  return component(
    id,
    category,
    name,
    description,
    "route",
    {
      component: id,
      terrain: id,
      color,
      lineWidth: "3",
      showLabel: "true",
      ...props,
    },
    undefined,
    "path",
    "path",
    followsPath,
  );
}

function simpleSurface(
  id: string,
  category: MapComponentCategory,
  name: string,
  description: string,
  fill: string,
  texture: MapSceneRegion["texture"] = "paper-land",
  kind: MapSceneRegion["kind"] = "land",
  placement?: MapComponentPlacement,
  shape?: MapComponentTerrainShape,
): MapComponentPreset {
  return component(
    id,
    category,
    name,
    description,
    "area",
    {
      component: id,
      terrain: id,
      color: fill,
      fill: `${fill}88`,
      showLabel: "true",
    },
    {
      kind,
      layout: "single",
      ...(shape ? { shape } : {}),
      fill,
      texture,
      edgeColor: "#5c5038",
      edgeWidth: 2,
    },
    placement,
    "surface",
  );
}

type TerrainPrefabDefinition = {
  readonly id: string;
  readonly category: "landmass" | "water";
  readonly name: string;
  readonly description: string;
  readonly shape: MapComponentTerrainShape;
  readonly kind: MapSceneRegion["kind"];
  readonly layout?: MapComponentTerrainPrefab["layout"];
  readonly fill: string;
  readonly edgeColor: string;
  readonly edgeWidth?: number;
};

/**
 * 轮廓预设只保存可读的形状意图与表面样式；实际点位由下方的几何生成器
 * 按地图坐标重建，落图后仍只是可编辑的 MapSceneRegion。
 */
function terrainPrefabComponent(
  definition: TerrainPrefabDefinition,
): MapComponentPreset {
  return component(
    definition.id,
    definition.category,
    definition.name,
    definition.description,
    "area",
    {
      component: definition.id,
      terrain: definition.id,
      color: definition.fill,
      fill: `${definition.fill}88`,
      showLabel: "true",
    },
    {
      kind: definition.kind,
      layout: definition.layout ?? "single",
      shape: definition.shape,
      fill: definition.fill,
      texture: definition.kind === "water" ? "water-ripple" : "paper-land",
      edgeColor: definition.edgeColor,
      edgeWidth: definition.edgeWidth ?? 2.4,
    },
    "terrain-prefab",
    "surface",
  );
}

const LANDMASS_TERRAIN_PRESETS: readonly MapComponentPreset[] = [
  terrainPrefabComponent({
    id: "supercontinent",
    category: "landmass",
    name: "巨型大陆",
    description: "横跨大洋的主陆块，适合作为世界地图的核心大陆。",
    shape: "supercontinent",
    kind: "land",
    fill: "#b8ad7d",
    edgeColor: "#5c5038",
    edgeWidth: 3,
  }),
  terrainPrefabComponent({
    id: "twin-lobe-continent",
    category: "landmass",
    name: "双叶大陆",
    description: "由狭窄陆桥相连的双叶陆块，天然形成东西分区。",
    shape: "twin-lobe-continent",
    kind: "land",
    fill: "#bdad7a",
    edgeColor: "#5b503c",
  }),
  terrainPrefabComponent({
    id: "crescent-continent",
    category: "landmass",
    name: "弯月大陆",
    description: "环抱海湾的月牙形大陆，适合港湾文明与内海叙事。",
    shape: "crescent-continent",
    kind: "land",
    fill: "#c4b786",
    edgeColor: "#655942",
  }),
  terrainPrefabComponent({
    id: "ring-continent",
    category: "landmass",
    name: "环形大陆",
    description: "围绕中心内海的环形陆块，适合盆地、圣湖或世界之眼。",
    shape: "ring-continent",
    kind: "land",
    layout: "archipelago",
    fill: "#b8ad7d",
    edgeColor: "#5e513b",
  }),
  terrainPrefabComponent({
    id: "peninsula-chain",
    category: "landmass",
    name: "半岛链",
    description: "多条半岛伸入海洋，形成曲折海岸和多处天然港湾。",
    shape: "peninsula-chain",
    kind: "land",
    fill: "#c4b989",
    edgeColor: "#625841",
  }),
  terrainPrefabComponent({
    id: "rifted-continent",
    category: "landmass",
    name: "裂谷大陆",
    description: "被巨型裂谷切开的陆块，适合板块冲突与内陆水系。",
    shape: "rifted-continent",
    kind: "land",
    fill: "#b9a978",
    edgeColor: "#5a4d38",
  }),
  terrainPrefabComponent({
    id: "triangle-continent",
    category: "landmass",
    name: "三角大陆",
    description: "三向海岸汇聚的大陆轮廓，适合三大文明与交通枢纽。",
    shape: "triangle-continent",
    kind: "land",
    fill: "#c1b07d",
    edgeColor: "#615540",
  }),
  terrainPrefabComponent({
    id: "fingered-coast",
    category: "landmass",
    name: "指状海岸",
    description: "深切峡湾与长半岛交织的复杂海岸。",
    shape: "fingered-coast",
    kind: "land",
    fill: "#b5aa78",
    edgeColor: "#5f543f",
  }),
  terrainPrefabComponent({
    id: "inland-sea-continent",
    category: "landmass",
    name: "内海大陆",
    description: "以巨大内海为核心的陆块，适合环海诸国和航运网络。",
    shape: "inland-sea-continent",
    kind: "land",
    fill: "#bcae7e",
    edgeColor: "#5b503a",
  }),
  terrainPrefabComponent({
    id: "shield-continent",
    category: "landmass",
    name: "盾形大陆",
    description: "重心稳定、外缘厚实的古老大陆盾。",
    shape: "shield-continent",
    kind: "land",
    fill: "#c0b27f",
    edgeColor: "#625640",
  }),
  terrainPrefabComponent({
    id: "longshore-continent",
    category: "landmass",
    name: "长条大陆",
    description: "狭长横贯的大型陆带，适合气候带与长距离商路。",
    shape: "longshore-continent",
    kind: "land",
    fill: "#b8a878",
    edgeColor: "#5d513b",
  }),
  terrainPrefabComponent({
    id: "hook-continent",
    category: "landmass",
    name: "钩形大陆",
    description: "向海洋弯折的钩状陆块，能形成天然内湾与海峡。",
    shape: "hook-continent",
    kind: "land",
    fill: "#c1b481",
    edgeColor: "#625741",
  }),
  terrainPrefabComponent({
    id: "twin-continent",
    category: "landmass",
    name: "双大陆",
    description: "隔海相望的两块主陆地，适合设置海峡两岸文明。",
    shape: "twin-continent",
    kind: "land",
    layout: "archipelago",
    fill: "#b8ad7d",
    edgeColor: "#5c5038",
    edgeWidth: 2.8,
  }),
  terrainPrefabComponent({
    id: "broken-continent",
    category: "landmass",
    name: "破碎大陆",
    description: "被海水切割成数块的大型陆架与近海岛屿。",
    shape: "broken-continent",
    kind: "land",
    layout: "archipelago",
    fill: "#bdae7b",
    edgeColor: "#5d513c",
  }),
  terrainPrefabComponent({
    id: "volcanic-islands",
    category: "landmass",
    name: "火山群岛",
    description: "由火山弧串联的岛群，适合险峻海域与火山文明。",
    shape: "volcanic-islands",
    kind: "land",
    layout: "archipelago",
    fill: "#b59069",
    edgeColor: "#664d3e",
  }),
  terrainPrefabComponent({
    id: "coral-islands",
    category: "landmass",
    name: "珊瑚群岛",
    description: "低平珊瑚岛与浅海礁盘形成的温暖群岛。",
    shape: "coral-islands",
    kind: "land",
    layout: "archipelago",
    fill: "#d0c68d",
    edgeColor: "#6c6147",
    edgeWidth: 2,
  }),
  terrainPrefabComponent({
    id: "reef-ring-islands",
    category: "landmass",
    name: "礁环群岛",
    description: "环绕泻湖展开的岛礁链，适合失落环礁与航海秘境。",
    shape: "reef-ring",
    kind: "land",
    layout: "archipelago",
    fill: "#cbc18a",
    edgeColor: "#6a6048",
    edgeWidth: 2,
  }),
  terrainPrefabComponent({
    id: "island-arc",
    category: "landmass",
    name: "弧岛链",
    description: "沿板块边界弯曲延展的岛弧。",
    shape: "arc-islands",
    kind: "land",
    layout: "archipelago",
    fill: "#c2b780",
    edgeColor: "#645941",
    edgeWidth: 2.2,
  }),
];

const WATER_TERRAIN_PRESETS: readonly MapComponentPreset[] = [
  terrainPrefabComponent({
    id: "inland-sea",
    category: "water",
    name: "内海",
    description: "深入大陆腹地的大型海域或封闭海盆。",
    shape: "inland-water",
    kind: "water",
    fill: "#4f93ac",
    edgeColor: "#376c7c",
    edgeWidth: 2.8,
  }),
  terrainPrefabComponent({
    id: "lagoon",
    category: "water",
    name: "环礁湖",
    description: "被沙洲或礁环包围的宁静水域。",
    shape: "lagoon",
    kind: "water",
    fill: "#71b7bf",
    edgeColor: "#3f7d88",
  }),
  terrainPrefabComponent({
    id: "crescent-bay",
    category: "water",
    name: "弯月湾",
    description: "向陆地深处弯入的月牙形海湾。",
    shape: "crescent-bay",
    kind: "water",
    fill: "#5ba0b8",
    edgeColor: "#3a7283",
  }),
  terrainPrefabComponent({
    id: "fjord-basin",
    category: "water",
    name: "峡湾水域",
    description: "冰川侵蚀形成的狭长深水海湾。",
    shape: "fjord-water",
    kind: "water",
    fill: "#477f9b",
    edgeColor: "#315d76",
  }),
  terrainPrefabComponent({
    id: "strait-water",
    category: "water",
    name: "海峡",
    description: "连接两片海域的狭窄水道。",
    shape: "strait",
    kind: "water",
    fill: "#4d92ad",
    edgeColor: "#356d83",
  }),
  terrainPrefabComponent({
    id: "lake-cluster",
    category: "water",
    name: "湖群",
    description: "由多个相邻湖泊组成的高原或冰川湖区。",
    shape: "lake-cluster",
    kind: "water",
    layout: "archipelago",
    fill: "#5ca5bd",
    edgeColor: "#397487",
  }),
  terrainPrefabComponent({
    id: "crater-lake",
    category: "water",
    name: "火山口湖",
    description: "填满火山口或陨石坑的圆形深湖。",
    shape: "crater-lake",
    kind: "water",
    fill: "#397e9e",
    edgeColor: "#2d6077",
  }),
  terrainPrefabComponent({
    id: "oxbow-lake",
    category: "water",
    name: "牛轭湖",
    description: "河流改道后遗留的弯曲湖湾。",
    shape: "oxbow-lake",
    kind: "water",
    fill: "#62a9b6",
    edgeColor: "#3b7781",
  }),
  terrainPrefabComponent({
    id: "salt-lake",
    category: "water",
    name: "盐湖",
    description: "边缘干涸、轮廓不规则的内陆盐水湖。",
    shape: "salt-lake",
    kind: "water",
    fill: "#7db9bd",
    edgeColor: "#4c8586",
  }),
  terrainPrefabComponent({
    id: "glacial-lake",
    category: "water",
    name: "冰川湖",
    description: "冰川谷地与冰碛坝之间形成的狭长湖泊。",
    shape: "glacial-lake",
    kind: "water",
    fill: "#69b7c8",
    edgeColor: "#3f8492",
  }),
  terrainPrefabComponent({
    id: "marsh-lake",
    category: "water",
    name: "沼泽湖",
    description: "水道、浅潭和湿地交错的低地湖泊。",
    shape: "marsh-lake",
    kind: "water",
    fill: "#609d91",
    edgeColor: "#3f746b",
  }),
  terrainPrefabComponent({
    id: "shelf-sea",
    category: "water",
    name: "群岛浅海",
    description: "岛屿、沙洲与浅滩密布的大陆架海域。",
    shape: "shelf-sea",
    kind: "water",
    fill: "#78b8b6",
    edgeColor: "#488381",
  }),
  terrainPrefabComponent({
    id: "coral-sea",
    category: "water",
    name: "珊瑚礁海",
    description: "礁盘与泻湖交织的温暖浅海。",
    shape: "coral-sea",
    kind: "water",
    fill: "#6db9b0",
    edgeColor: "#438278",
  }),
  terrainPrefabComponent({
    id: "deep-trench",
    category: "water",
    name: "深海沟",
    description: "沿板块边界延展的狭长深海断陷。",
    shape: "deep-trench",
    kind: "water",
    fill: "#2f6f93",
    edgeColor: "#24536f",
  }),
  terrainPrefabComponent({
    id: "tidal-flat",
    category: "water",
    name: "潮汐滩",
    description: "潮沟与潮池组成的宽阔潮间带水域。",
    shape: "tidal-flat",
    kind: "water",
    fill: "#87b9ad",
    edgeColor: "#4f8279",
  }),
];

const EXTRA_MAP_COMPONENT_PRESETS: readonly MapComponentPreset[] = [
  simpleStamp(
    "isolated-peak",
    "mountain",
    "孤峰",
    "独立山峰、天柱峰或地图上的高点地标。",
    "#756453",
  ),
  simpleStamp(
    "volcanic-crater",
    "mountain",
    "火山口",
    "火山口、熔岩湖或沉睡火山的环形口。",
    "#b64f39",
  ),
  simpleStamp(
    "rock-pillar",
    "mountain",
    "岩柱",
    "孤立岩柱、天柱石或风蚀石塔。",
    "#8b7157",
  ),
  simpleScatter(
    "karst-peaks",
    "mountain",
    "喀斯特",
    "喀斯特峰林、溶洞地貌与石灰岩群峰。",
    "#7c8761",
  ),
  simpleScatter(
    "mushroom-grove",
    "vegetation",
    "蘑菇林",
    "巨型菌林、孢子林地或发光菌群。",
    "#936a78",
  ),
  simpleScatter(
    "tundra-vegetation",
    "vegetation",
    "苔原植被",
    "苔原灌丛、地衣与极地低矮植被。",
    "#778f82",
  ),
  simpleScatter(
    "stone-pile",
    "mountain",
    "石堆",
    "路标石堆、崩塌碎石或祭祀石阵。",
    "#82796d",
  ),
  simpleScatter(
    "ore-vein",
    "mountain",
    "矿脉",
    "露天矿脉、晶体矿层或灵矿露头。",
    "#5f8794",
  ),
  simpleScatter(
    "cactus",
    "vegetation",
    "仙人掌",
    "荒漠仙人掌、龙舌兰或耐旱植物群。",
    "#5e8458",
  ),
  simpleScatter(
    "sea-grass",
    "water",
    "海草与海藻",
    "浅海海草床、水下藻林或潮汐草甸。",
    "#4f8c72",
  ),
  simpleSurface(
    "ice-sheet",
    "water",
    "冰原",
    "极地冰原、冰盖或冻结海面。",
    "#b8dce3",
    "paper-land",
    "water",
    undefined,
    "ice-sheet",
  ),
  simpleSurface(
    "shoal",
    "water",
    "浅滩",
    "近岸浅滩、沙洲或水下陆架。",
    "#8ec3bd",
    "water-ripple",
    "water",
    undefined,
    "shoal",
  ),
  simplePath(
    "riverbank",
    "water",
    "河岸",
    "河岸线、堤岸或水陆交界线。",
    "#4a8690",
    { routeStyle: "bank", routeWidth: "4" },
  ),
  simplePath(
    "tributary",
    "water",
    "支流",
    "汇入主河的支流、溪流或分汊水道。",
    "#5597ab",
    { sourceWidth: "2", mouthWidth: "5", bankWidth: "1" },
  ),
  simplePath(
    "fjord",
    "water",
    "峡湾",
    "冰川切割的狭长海湾或深水峡谷。",
    "#4f8192",
    { routeStyle: "fjord", routeWidth: "10" },
  ),
  simplePath("bay", "water", "港湾", "天然港湾、海湾或隐蔽水域。", "#578da0", {
    routeStyle: "bay",
    routeWidth: "8",
  }),
  simpleScatter(
    "whirlpool",
    "water",
    "漩涡",
    "海上漩涡、魔法涡流或危险水眼。",
    "#507f9b",
  ),
  simplePath(
    "undercurrent",
    "water",
    "暗流",
    "水下暗流、深海流带或隐秘潮汐。",
    "#3f718e",
    { routeStyle: "undercurrent", routeWidth: "3" },
  ),
  simplePath(
    "sea-ice",
    "water",
    "海冰",
    "海冰边缘、冰封航道或浮冰带。",
    "#a6d2d8",
    { routeStyle: "ice", routeWidth: "7" },
  ),
  simpleScatter(
    "town",
    "civilization",
    "城镇",
    "中型城镇、行政驻地或区域集市。",
    "#90684e",
    "town",
  ),
  simpleStamp(
    "town-district",
    "civilization",
    "城镇街区",
    "城镇街区、坊市、住宅群或城市道路肌理。",
    "#956d52",
  ),
  simpleStamp(
    "fishing-village",
    "civilization",
    "渔村",
    "海湾渔村、河口聚落或沿岸船屋群。",
    "#5d7f86",
  ),
  simpleStamp(
    "lighthouse",
    "civilization",
    "灯塔",
    "海岸灯塔、导航塔或远洋信标。",
    "#b08a5b",
  ),
  simpleStamp(
    "graveyard",
    "civilization",
    "墓地",
    "墓园、祖陵、战死者安葬地或亡灵圣所。",
    "#6f6870",
  ),
  simpleStamp(
    "battlefield",
    "civilization",
    "战场",
    "古战场、冲突遗址或战争纪念地。",
    "#8d5b4e",
  ),
  simpleStamp(
    "farmstead",
    "civilization",
    "农庄",
    "农庄、牧场或乡村庄园。",
    "#a38b50",
  ),
  simpleStamp(
    "ruin-cluster",
    "landmark",
    "遗迹群",
    "成片遗迹、古文明废墟或失落城群。",
    "#88705b",
  ),
  simpleStamp(
    "castle-cluster",
    "civilization",
    "城堡群",
    "由主堡、城墙和附属建筑组成的城堡群。",
    "#866653",
  ),
  simpleScatter(
    "farmland-field",
    "vegetation",
    "农田",
    "可沿路径散布的田块、耕地和农作带。",
    "#a38b50",
    "farmland-field",
  ),
  simpleScatter(
    "deadwood-single",
    "vegetation",
    "枯木",
    "单株枯木、倒木和荒地上的残枝。",
    "#766454",
    "deadwood-single",
  ),
  simpleScatter(
    "coast-foam",
    "water",
    "海岸浪花",
    "海岸线、礁盘和浅滩边缘的白色浪花。",
    "#d8f1ec",
    "coast-foam",
    true,
  ),
  simplePath(
    "paved-road",
    "civilization",
    "石板路",
    "石板大道、古罗马式道路或城内铺路。",
    "#aa9477",
    { routeStyle: "paved", routeWidth: "8" },
  ),
  simplePath(
    "dirt-road",
    "civilization",
    "土路",
    "乡间土路、车辙路或泥泞道路。",
    "#a8845d",
    { routeStyle: "dirt", routeWidth: "5" },
  ),
  simplePath(
    "forest-trail",
    "civilization",
    "林间小径",
    "林间小径、猎人路或隐秘步道。",
    "#718452",
    { routeStyle: "trail", routeWidth: "3" },
  ),
  simplePath(
    "trade-route",
    "civilization",
    "商路",
    "跨区域商路、驿站线或贸易路线。",
    "#bd8150",
    { routeStyle: "trade", routeWidth: "6" },
  ),
  simplePath(
    "mountain-pass",
    "civilization",
    "山道",
    "山口、盘山道或高山通行线。",
    "#806b58",
    { routeStyle: "mountain-pass", routeWidth: "4" },
  ),
  simplePath(
    "boardwalk",
    "civilization",
    "栈道",
    "悬崖栈道、湿地木道或高空步道。",
    "#9b754f",
    { routeStyle: "boardwalk", routeWidth: "5" },
  ),
  simplePath(
    "canal",
    "civilization",
    "运河",
    "人工运河、灌溉水渠或城市水道。",
    "#538b98",
    { routeStyle: "canal", routeWidth: "8" },
  ),
  simplePath(
    "railway",
    "civilization",
    "铁路",
    "铁路、矿轨或工业运输线。",
    "#6b6662",
    { routeStyle: "railway", routeWidth: "5" },
  ),
  simplePath(
    "magic-rail",
    "civilization",
    "魔导轨道",
    "魔导列车线、能量轨道或超凡交通网。",
    "#806ac1",
    { routeStyle: "magic-rail", routeWidth: "5" },
  ),
  simplePath(
    "national-border",
    "civilization",
    "国界",
    "国家边界、关卡线或领土分界。",
    "#a74742",
    { routeStyle: "border", routeWidth: "2.5" },
  ),
  simplePath(
    "boundary-line",
    "civilization",
    "边界线",
    "不限定国家层级的区域边界、缓冲线或地图分界。",
    "#a74742",
    { routeStyle: "border", routeWidth: "2" },
  ),
  simplePath(
    "ley-line",
    "civilization",
    "灵脉",
    "地脉、灵脉或魔力流线。",
    "#9c65bd",
    { routeStyle: "ley-line", routeWidth: "3" },
    true,
  ),
  simpleSurface(
    "territory-fill",
    "civilization",
    "疆域填色",
    "势力控制区、领土范围或影响力投影。",
    "#a96d5c",
    "territory-hatch",
    "land",
    "overlay",
  ),
  simpleSurface(
    "administrative-pattern",
    "civilization",
    "行政区纹理",
    "行政分区、辖区纹理或治理网格。",
    "#a88965",
    "administrative-grid",
    "land",
    "overlay",
  ),
  simplePath(
    "sea-route",
    "water",
    "航线",
    "海上航线、船队通道或星际航线地面投影。",
    "#6b9eb5",
    { routeStyle: "sea-route", routeWidth: "3" },
  ),
  simpleStamp(
    "dragonbone-range",
    "landmark",
    "龙骨山脉",
    "形似巨龙骨骸的奇幻山脉。",
    "#80636f",
  ),
  simpleStamp(
    "world-tree-roots",
    "landmark",
    "世界树根系",
    "贯穿大陆的世界树根系或地底树网。",
    "#665b43",
  ),
  simpleStamp(
    "great-tree",
    "landmark",
    "巨树",
    "独立巨树、远古神木或可作为地标的世界树主干。",
    "#5c744b",
  ),
  simpleScatter(
    "floating-rocks",
    "landmark",
    "漂浮碎石",
    "环绕浮空岛的漂浮岩块与碎片。",
    "#7d8691",
  ),
  simpleStamp(
    "magic-storm",
    "landmark",
    "魔法风暴",
    "魔力风暴、元素暴走或天象灾害。",
    "#916ac7",
  ),
  simpleStamp(
    "forbidden-zone",
    "landmark",
    "禁地",
    "被封锁的禁区、危险区域或未知领域。",
    "#70575d",
  ),
  simplePath(
    "fog-wall",
    "landmark",
    "禁区雾墙",
    "遮蔽边界的迷雾墙或死亡雾海。",
    "#7d8b8b",
    { routeStyle: "fog-wall", routeWidth: "12" },
  ),
  simplePath(
    "barrier",
    "landmark",
    "结界",
    "结界边界、防护罩或封印线。",
    "#7f72c2",
    { routeStyle: "barrier", routeWidth: "4" },
  ),
  simpleStamp(
    "dungeon-entrance",
    "landmark",
    "地下城入口",
    "地下城、深渊或古代设施入口。",
    "#5e5360",
  ),
  simpleStamp(
    "spirit-spring",
    "landmark",
    "灵泉",
    "灵泉、圣水源或生命能量泉眼。",
    "#58a5a1",
  ),
  simpleStamp(
    "beast-nest",
    "landmark",
    "巨兽巢穴",
    "巨兽巢穴、龙巢或魔物领地。",
    "#815746",
  ),
  simpleStamp(
    "star-cluster",
    "celestial",
    "星团",
    "密集恒星群、星团或星海节点。",
    "#d7b86a",
  ),
  simpleStamp(
    "star-gate",
    "celestial",
    "星门",
    "连接星系的星门或宇宙跃迁门。",
    "#8f7bd0",
  ),
  simpleStamp(
    "ring",
    "celestial",
    "星环",
    "行星周围的星环、碎片环或轨道环带。",
    "#b79a68",
  ),
  simpleStamp(
    "wormhole",
    "celestial",
    "虫洞",
    "时空虫洞、折叠通道或虚空隧道。",
    "#815bb1",
  ),
  simpleSurface(
    "civilization-domain",
    "celestial",
    "文明疆域",
    "星际文明的势力范围或控制区。",
    "#718bb0",
    "stellar-domain",
    "land",
    "overlay",
  ),
  simplePath(
    "stellar-route",
    "celestial",
    "星际航线",
    "星际航线、跃迁航道或星系间贸易线。",
    "#9caed1",
    { routeStyle: "stellar-route", routeWidth: "3" },
  ),
  simpleStamp(
    "compass",
    "cartography",
    "罗盘",
    "地图方向罗盘与方位装饰。",
    "#a67b4d",
  ),
  simpleStamp(
    "scale-bar",
    "cartography",
    "比例尺",
    "地图比例尺与距离标尺。",
    "#705a47",
  ),
  simpleStamp(
    "scroll-frame",
    "cartography",
    "地图卷轴边框",
    "地图卷轴边缘、装饰边框或古地图外框。",
    "#9d774f",
  ),
  simpleScatter(
    "chart-wind",
    "cartography",
    "海图风纹",
    "海图风向纹、潮汐纹或航海装饰线。",
    "#7296a5",
    "chart-wind",
    true,
  ),
  simpleStamp(
    "mountain-banner",
    "cartography",
    "山名飘带",
    "山脉名称飘带与地形标题装饰。",
    "#866b52",
  ),
  simpleStamp(
    "danger-waters",
    "cartography",
    "危险水域标记",
    "暗礁、漩涡和危险海域警示标记。",
    "#b55b4d",
  ),
  simplePath(
    "contour-line",
    "cartography",
    "等高线",
    "地形等高线与高度层级纹理。",
    "#887b63",
    { routeStyle: "contour", routeWidth: "1.5" },
  ),
  simpleScatter(
    "hillshade",
    "cartography",
    "山体阴影",
    "山体阴影、地形明暗或坡向纹理。",
    "#776d68",
  ),
  simplePath(
    "bathymetric-line",
    "cartography",
    "海图水深线",
    "海底等深线与水深分层。",
    "#648e9a",
    { routeStyle: "bathymetric", routeWidth: "1.5" },
  ),
  simpleScatter(
    "cloud-layer",
    "cartography",
    "云层",
    "地图上空的云层、雾带或天气装饰。",
    "#b9c4c0",
  ),
  simpleScatter(
    "paper-stain",
    "cartography",
    "纸张污渍",
    "古地图纸张污渍、磨损和墨迹。",
    "#9b805f",
  ),
  simpleStamp(
    "map-frame",
    "cartography",
    "边框",
    "地图外框、装饰线框或章节地图边界。",
    "#8f6c4a",
  ),
  simpleStamp(
    "title-cartouche",
    "cartography",
    "题图",
    "地图标题牌、题图和图例装饰。",
    "#a7794e",
  ),
  simpleStamp(
    "region-number",
    "cartography",
    "区域编号",
    "区域编号、索引标记和地图检索点。",
    "#786b5d",
  ),
];

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
      "area",
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
        shape: "organic",
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
        shape: "archipelago",
        fill: "#c5b986",
        texture: "paper-land",
        edgeColor: "#6a6047",
        edgeWidth: 2.2,
      },
    ),
    ...LANDMASS_TERRAIN_PRESETS,
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
        routeStyle: "rift",
        routeWidth: "5",
        showLabel: "true",
      },
    ),
    component(
      "mountain-range",
      "mountain",
      "山脉脊线",
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
      "scatter",
      true,
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
      "台地",
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
        routeStyle: "canyon",
        routeWidth: "6",
        showLabel: "true",
      },
    ),
    component(
      "cliff",
      "mountain",
      "断崖",
      "陡峭断崖、海岸崖壁或峡谷崖面。",
      "marker",
      {
        component: "cliff",
        terrain: "cliff",
        symbol: "cliff",
        color: "#775f4d",
        showLabel: "true",
      },
    ),
    component(
      "dunes",
      "mountain",
      "沙丘",
      "流沙、沙海、风蚀丘陵或荒漠腹地。",
      "marker",
      {
        component: "dunes",
        terrain: "dunes",
        symbol: "dunes",
        color: "#c69b59",
        showLabel: "true",
      },
    ),
    component(
      "glacier",
      "mountain",
      "冰川",
      "冰川、冻原冰舌或极地雪原。",
      "marker",
      {
        component: "glacier",
        terrain: "glacier",
        symbol: "glacier",
        color: "#9fcbd5",
        showLabel: "true",
      },
    ),
    component(
      "rock-spires",
      "mountain",
      "石林",
      "石林、风蚀岩柱或奇峰群。",
      "marker",
      {
        component: "rock-spires",
        terrain: "rock-spires",
        symbol: "rock-spires",
        color: "#8c7159",
        showLabel: "true",
      },
    ),
    component(
      "boulder-field",
      "mountain",
      "乱石滩",
      "崩塌山坡、碎石荒原或巨石阵外围。",
      "marker",
      {
        component: "boulder-field",
        terrain: "boulder-field",
        symbol: "boulder-field",
        color: "#87745e",
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
      "broadleaf-grove",
      "vegetation",
      "阔叶林",
      "温带阔叶林、古橡树林或富饶谷地。",
      "marker",
      {
        component: "broadleaf-grove",
        terrain: "broadleaf-grove",
        symbol: "broadleaf-grove",
        color: "#55764a",
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
      "bamboo-grove",
      "vegetation",
      "竹林",
      "竹海、山谷灵竹或隐士居所周边。",
      "marker",
      {
        component: "bamboo-grove",
        terrain: "bamboo-grove",
        symbol: "bamboo-grove",
        color: "#66884b",
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
    simpleSurface(
      "wetland",
      "water",
      "湿地",
      "沼泽、湿地与水泽。",
      "#5e8e80",
      "water-ripple",
      "water",
      undefined,
      "wetland",
    ),
    component(
      "grassland",
      "vegetation",
      "草地",
      "草场、荒原或游牧地带。",
      "area",
      {
        component: "grassland",
        terrain: "grassland",
        color: "#97a858",
        fill: "#b8c57266",
        lineWidth: "2",
        showLabel: "true",
      },
    ),
    component(
      "shrubland",
      "vegetation",
      "灌木",
      "矮灌、荒野植被或林地边缘过渡带。",
      "marker",
      {
        component: "shrubland",
        terrain: "shrubland",
        symbol: "shrubland",
        color: "#748653",
        showLabel: "true",
      },
    ),
    component(
      "reed-bed",
      "water",
      "芦苇荡",
      "河湾芦苇、浅滩草洲或雾泽边缘。",
      "marker",
      {
        component: "reed-bed",
        terrain: "reed-bed",
        symbol: "reed-bed",
        color: "#718b52",
        showLabel: "true",
      },
    ),
    component(
      "mangrove",
      "vegetation",
      "红树林",
      "海湾红树林、潮间带密林或水陆交错林地。",
      "marker",
      {
        component: "mangrove",
        terrain: "mangrove",
        symbol: "mangrove",
        color: "#48705b",
        showLabel: "true",
      },
    ),
    component("river", "water", "河流", "主河、灵河或地下河道。", "route", {
      component: "river",
      ...DEFAULT_MAP_RIVER_PROPS,
    }),
    simpleSurface(
      "lake",
      "water",
      "湖泊",
      "湖泊、内海或灵泉水域。",
      "#3f89a8",
      "water-ripple",
      "water",
      undefined,
      "lake",
    ),
    component(
      "delta",
      "water",
      "三角洲",
      "河口三角洲、湿润冲积平原或分汊水网。",
      "area",
      {
        component: "delta",
        terrain: "delta",
        color: "#5e9eb4",
        fill: "#7bb5c466",
        lineWidth: "2",
        showLabel: "true",
      },
      {
        kind: "water",
        layout: "single",
        shape: "delta",
        fill: "#6fa9bc",
        texture: "water-ripple",
        edgeColor: "#376c7c",
        edgeWidth: 2.2,
      },
    ),
    ...WATER_TERRAIN_PRESETS,
    component(
      "rapids",
      "water",
      "急流",
      "山涧急流、险滩或瀑布下游。",
      "route",
      {
        component: "rapids",
        terrain: "rapids",
        color: "#76c3d2",
        bankColor: "#3f8290",
        highlightColor: "#edffff",
        lineWidth: "5",
        sourceWidth: "3",
        mouthWidth: "7",
        bankWidth: "1.8",
        showLabel: "true",
      },
    ),
    component(
      "coral-reef",
      "water",
      "珊瑚礁",
      "珊瑚礁、浅海礁盘或危险暗礁带。",
      "marker",
      {
        component: "coral-reef",
        terrain: "coral-reef",
        symbol: "coral-reef",
        color: "#d17f73",
        showLabel: "true",
      },
    ),
    component(
      "seaweed-bed",
      "water",
      "海藻床",
      "近岸海藻、湖底水草或暗流覆盖的水下植被。",
      "marker",
      {
        component: "seaweed-bed",
        terrain: "seaweed-bed",
        symbol: "seaweed-bed",
        color: "#4f8c72",
        showLabel: "true",
      },
    ),
    component(
      "sea-foam",
      "water",
      "海浪泡沫",
      "拍岸白沫、礁盘浪线或风暴海面。",
      "marker",
      {
        component: "sea-foam",
        terrain: "sea-foam",
        symbol: "sea-foam",
        color: "#d8f1ec",
        showLabel: "true",
      },
    ),
    component(
      "ice-floe",
      "water",
      "浮冰",
      "漂浮冰原、极地海冰或冰封航道。",
      "marker",
      {
        component: "ice-floe",
        terrain: "ice-floe",
        symbol: "ice-floe",
        color: "#b8dde3",
        showLabel: "true",
      },
    ),
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
        routeStyle: "current",
        routeWidth: "4",
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
      "farmland",
      "civilization",
      "农田纹理",
      "阡陌农田、梯田、庄园领地或粮仓腹地。",
      "marker",
      {
        component: "farmland",
        terrain: "farmland",
        symbol: "farmland",
        color: "#a9984e",
        showLabel: "true",
      },
    ),
    component(
      "terraces",
      "civilization",
      "梯田",
      "山地梯田、层叠药圃或阶地农耕区。",
      "marker",
      {
        component: "terraces",
        terrain: "terraces",
        symbol: "terraces",
        color: "#9e8754",
        showLabel: "true",
      },
    ),
    component(
      "camp",
      "civilization",
      "营地",
      "军营、商队营地、探险前哨或游牧营盘。",
      "marker",
      {
        component: "camp",
        symbol: "camp",
        color: "#90704c",
        showLabel: "true",
      },
    ),
    component(
      "mine",
      "civilization",
      "矿井",
      "矿洞、采石场、灵矿开采点或矿业聚落。",
      "marker",
      {
        component: "mine",
        symbol: "mine",
        color: "#6c7473",
        showLabel: "true",
      },
    ),
    component(
      "shipyard",
      "civilization",
      "船坞",
      "造船厂、舰队泊位或海军工坊。",
      "marker",
      {
        component: "shipyard",
        symbol: "shipyard",
        color: "#4f7d88",
        showLabel: "true",
      },
    ),
    simpleScatter(
      "village",
      "civilization",
      "村落",
      "村庄、小镇、驿站或边地聚落。",
      "#8a684d",
      "village",
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
      "瞭望塔",
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
      "神殿",
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
    component(
      "floating-island",
      "landmark",
      "浮空岛",
      "浮空陆块、天空城遗址或悬浮秘境。",
      "marker",
      {
        component: "floating-island",
        symbol: "floating-island",
        color: "#7b9b92",
        showLabel: "true",
      },
    ),
    component(
      "magic-rift",
      "landmark",
      "魔法裂隙",
      "魔力裂隙、虚空伤痕或不稳定传送通道。",
      "route",
      {
        component: "magic-rift",
        terrain: "magic-rift",
        color: "#a85ac4",
        lineWidth: "4",
        routeStyle: "magic-rift",
        routeWidth: "6",
        showLabel: "true",
      },
    ),
    component(
      "world-tree",
      "landmark",
      "世界树",
      "世界树、神木、灵脉母树或文明圣树。",
      "marker",
      {
        component: "world-tree",
        symbol: "world-tree",
        color: "#5a8d4b",
        showLabel: "true",
      },
    ),
    component(
      "underworld-gate",
      "landmark",
      "地下入口",
      "地下世界入口、深渊之门或亡者国度边界。",
      "marker",
      {
        component: "underworld-gate",
        symbol: "underworld-gate",
        color: "#604e73",
        showLabel: "true",
      },
    ),
    ...EXTRA_MAP_COMPONENT_PRESETS,
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

export function mapComponentInteraction(
  component: MapComponentPreset,
): MapComponentInteraction {
  return component.interaction;
}

export function mapComponentsInInteraction(
  interaction: MapComponentInteraction,
  category?: MapComponentCategory,
): readonly MapComponentPreset[] {
  return MAP_COMPONENT_PRESETS.filter(
    (item) =>
      item.interaction === interaction &&
      (category === undefined || item.category === category),
  );
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
  supercontinent: [
    [-0.5, -0.12], [-0.42, -0.38], [-0.16, -0.5], [0.08, -0.42],
    [0.28, -0.48], [0.5, -0.18], [0.42, 0.08], [0.5, 0.36],
    [0.22, 0.5], [-0.02, 0.38], [-0.22, 0.48], [-0.5, 0.28],
  ],
  "twin-lobe-continent": [
    [-0.5, -0.18], [-0.4, -0.42], [-0.16, -0.48], [-0.04, -0.18],
    [0.08, -0.42], [0.36, -0.46], [0.5, -0.12], [0.4, 0.28],
    [0.16, 0.44], [0.02, 0.18], [-0.14, 0.46], [-0.42, 0.36],
  ],
  "crescent-continent": [
    [-0.48, -0.26], [-0.28, -0.48], [0.02, -0.5], [0.32, -0.38],
    [0.5, -0.1], [0.36, 0.04], [0.12, -0.02], [-0.08, 0.14],
    [0.04, 0.38], [-0.2, 0.5], [-0.46, 0.3],
  ],
  "ring-continent": [
    [-0.5, -0.14], [-0.34, -0.42], [-0.06, -0.5], [0.24, -0.44],
    [0.48, -0.2], [0.5, 0.12], [0.3, 0.4], [0.02, 0.5],
    [-0.28, 0.42], [-0.48, 0.2], [-0.36, 0.08], [-0.14, 0.24],
    [0.08, 0.3], [0.28, 0.14], [0.26, -0.12], [0.04, -0.24],
    [-0.2, -0.2],
  ],
  "peninsula-chain": [
    [-0.5, -0.32], [-0.34, -0.48], [-0.2, -0.18], [-0.06, -0.5],
    [0.08, -0.2], [0.24, -0.46], [0.5, -0.2], [0.36, 0.04],
    [0.48, 0.36], [0.2, 0.5], [0.02, 0.26], [-0.2, 0.48], [-0.5, 0.24],
  ],
  "rifted-continent": [
    [-0.5, -0.24], [-0.32, -0.48], [-0.1, -0.38], [0.02, -0.08],
    [0.16, -0.42], [0.42, -0.46], [0.5, -0.1], [0.38, 0.2],
    [0.5, 0.44], [0.16, 0.5], [0.02, 0.22], [-0.18, 0.48], [-0.48, 0.36],
  ],
  "triangle-continent": [
    [-0.5, -0.34], [-0.08, -0.5], [0.5, -0.24], [0.4, 0.08],
    [0.5, 0.42], [0.06, 0.5], [-0.08, 0.24], [-0.42, 0.42],
    [-0.28, 0.02],
  ],
  "fingered-coast": [
    [-0.5, -0.42], [-0.24, -0.5], [-0.2, -0.18], [-0.04, -0.48],
    [0.08, -0.12], [0.24, -0.5], [0.5, -0.32], [0.4, -0.02],
    [0.5, 0.36], [0.22, 0.5], [0.08, 0.18], [-0.1, 0.48], [-0.24, 0.12], [-0.5, 0.36],
  ],
  "inland-sea-continent": [
    [-0.5, -0.1], [-0.38, -0.4], [-0.1, -0.48], [0.22, -0.42],
    [0.5, -0.16], [0.44, 0.32], [0.2, 0.5], [-0.12, 0.44], [-0.46, 0.3],
    [-0.28, 0.12], [-0.06, 0.2], [0.12, 0.1], [0.28, 0.24], [0.12, 0.36], [-0.12, 0.34],
  ],
  "shield-continent": [
    [-0.42, -0.4], [-0.12, -0.5], [0.2, -0.46], [0.44, -0.28],
    [0.5, 0.12], [0.34, 0.42], [0, 0.5], [-0.34, 0.4], [-0.5, 0.1],
  ],
  "longshore-continent": [
    [-0.5, -0.2], [-0.34, -0.42], [-0.02, -0.34], [0.24, -0.48],
    [0.5, -0.24], [0.38, 0.04], [0.5, 0.3], [0.2, 0.46], [-0.1, 0.36], [-0.36, 0.48], [-0.5, 0.24],
  ],
  "hook-continent": [
    [-0.5, -0.36], [-0.22, -0.5], [0.1, -0.38], [0.48, -0.5], [0.5, -0.18],
    [0.2, -0.02], [0.04, 0.2], [0.34, 0.28], [0.5, 0.46], [0.14, 0.5],
    [-0.08, 0.34], [-0.24, 0.08], [-0.5, 0.3],
  ],
  "twin-continent": [
    [-0.5, -0.32], [-0.34, -0.5], [-0.08, -0.44], [0.02, -0.18],
    [0.1, -0.42], [0.38, -0.46], [0.5, -0.2], [0.38, 0.22], [0.12, 0.46],
    [0.02, 0.2], [-0.16, 0.46], [-0.44, 0.34],
  ],
  "broken-continent": [
    [-0.5, -0.4], [-0.22, -0.48], [-0.08, -0.16], [0.08, -0.48],
    [0.36, -0.42], [0.5, -0.12], [0.3, 0.04], [0.48, 0.42], [0.18, 0.5],
    [0.02, 0.2], [-0.2, 0.46], [-0.5, 0.3], [-0.36, 0.02],
  ],
  "volcanic-islands": [
    [-0.5, -0.18], [-0.36, -0.42], [-0.12, -0.3], [0.02, -0.5], [0.2, -0.24],
    [0.42, -0.46], [0.5, -0.04], [0.3, 0.22], [0.5, 0.46], [0.18, 0.38],
    [-0.06, 0.5], [-0.2, 0.22], [-0.48, 0.4],
  ],
  "coral-islands": [
    [-0.5, -0.1], [-0.38, -0.34], [-0.1, -0.46], [0.14, -0.36], [0.42, -0.46],
    [0.5, -0.14], [0.34, 0.04], [0.5, 0.34], [0.2, 0.48], [-0.02, 0.32],
    [-0.28, 0.48], [-0.5, 0.26], [-0.36, 0.08],
  ],
  "reef-ring": [
    [-0.5, -0.06], [-0.4, -0.34], [-0.12, -0.5], [0.2, -0.42], [0.46, -0.24],
    [0.5, 0.08], [0.36, 0.36], [0.08, 0.5], [-0.24, 0.42], [-0.48, 0.24],
    [-0.34, 0.04], [-0.12, 0.24], [0.12, 0.3], [0.28, 0.1], [0.18, -0.16], [-0.08, -0.24],
  ],
  "arc-islands": [
    [-0.5, 0.18], [-0.38, -0.12], [-0.24, -0.34], [-0.02, -0.48], [0.22, -0.4],
    [0.42, -0.18], [0.5, 0.12], [0.42, 0.38], [0.16, 0.5], [-0.08, 0.4], [-0.3, 0.28],
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
  delta: [
    [-0.5, -0.26],
    [-0.28, -0.48],
    [0.02, -0.35],
    [0.22, -0.5],
    [0.5, -0.2],
    [0.36, 0.08],
    [0.5, 0.38],
    [0.12, 0.5],
    [-0.16, 0.28],
    [-0.44, 0.42],
  ],
  lake: [
    [-0.5, -0.12], [-0.34, -0.4], [-0.04, -0.5], [0.28, -0.38], [0.5, -0.08],
    [0.42, 0.24], [0.18, 0.48], [-0.16, 0.44], [-0.46, 0.26],
  ],
  wetland: [
    [-0.5, -0.24], [-0.3, -0.46], [-0.04, -0.32], [0.18, -0.5], [0.46, -0.28],
    [0.36, -0.02], [0.5, 0.24], [0.24, 0.46], [-0.04, 0.34], [-0.28, 0.5], [-0.5, 0.26],
  ],
  "ice-sheet": [
    [-0.5, -0.2], [-0.24, -0.48], [0.08, -0.4], [0.32, -0.5], [0.5, -0.18],
    [0.4, 0.18], [0.5, 0.44], [0.16, 0.36], [-0.1, 0.5], [-0.34, 0.34], [-0.5, 0.42],
  ],
  shoal: [
    [-0.5, 0.04], [-0.34, -0.32], [-0.08, -0.5], [0.22, -0.38], [0.5, -0.12],
    [0.38, 0.1], [0.5, 0.38], [0.2, 0.5], [-0.1, 0.36], [-0.36, 0.48], [-0.5, 0.24],
  ],
  "inland-sea": [
    [-0.5, -0.18], [-0.36, -0.44], [-0.08, -0.5], [0.2, -0.42], [0.48, -0.2],
    [0.42, 0.12], [0.5, 0.4], [0.18, 0.5], [-0.14, 0.4], [-0.42, 0.46], [-0.5, 0.2],
  ],
  lagoon: [
    [-0.5, -0.1], [-0.34, -0.4], [-0.04, -0.5], [0.28, -0.42], [0.5, -0.14],
    [0.34, 0.04], [0.5, 0.32], [0.26, 0.5], [-0.04, 0.42], [-0.3, 0.5], [-0.5, 0.24],
    [-0.3, 0.04], [-0.1, 0.22], [0.16, 0.18], [0.3, 0.02], [0.12, -0.18], [-0.14, -0.2],
  ],
  "crescent-bay": [
    [-0.5, -0.32], [-0.26, -0.5], [0.06, -0.44], [0.36, -0.26], [0.5, 0.02],
    [0.32, 0.12], [0.12, 0.02], [-0.04, 0.2], [0.1, 0.42], [-0.16, 0.5], [-0.42, 0.34],
  ],
  "fjord-water": [
    [-0.5, -0.42], [-0.3, -0.5], [-0.2, -0.18], [-0.04, -0.4], [0.12, -0.12],
    [0.28, -0.46], [0.5, -0.3], [0.36, -0.04], [0.5, 0.34], [0.24, 0.5], [0.08, 0.18], [-0.12, 0.48], [-0.3, 0.14], [-0.5, 0.36],
  ],
  strait: [
    [-0.5, -0.46], [-0.18, -0.5], [-0.04, -0.18], [0.14, -0.5], [0.5, -0.42],
    [0.38, -0.1], [0.5, 0.46], [0.16, 0.5], [0.02, 0.18], [-0.16, 0.5], [-0.5, 0.4], [-0.36, 0.02],
  ],
  "lake-cluster": [
    [-0.5, -0.24], [-0.34, -0.46], [-0.1, -0.34], [0.08, -0.5], [0.3, -0.32], [0.5, -0.42],
    [0.4, -0.08], [0.5, 0.26], [0.26, 0.46], [0.02, 0.32], [-0.18, 0.5], [-0.42, 0.34],
  ],
  "crater-lake": [
    [-0.5, -0.08], [-0.4, -0.36], [-0.12, -0.5], [0.2, -0.46], [0.46, -0.26], [0.5, 0.06],
    [0.36, 0.38], [0.06, 0.5], [-0.24, 0.42], [-0.48, 0.24], [-0.28, 0.04], [-0.08, 0.22], [0.18, 0.12], [0.24, -0.12], [0.04, -0.28], [-0.2, -0.22],
  ],
  "oxbow-lake": [
    [-0.5, -0.3], [-0.28, -0.48], [-0.02, -0.42], [0.18, -0.2], [0.46, -0.34], [0.5, -0.08],
    [0.26, 0.04], [0.12, 0.28], [0.32, 0.46], [0.06, 0.5], [-0.12, 0.28], [-0.34, 0.42], [-0.5, 0.2], [-0.28, 0.04], [-0.1, -0.14],
  ],
  "salt-lake": [
    [-0.5, -0.16], [-0.3, -0.44], [0.02, -0.5], [0.36, -0.4], [0.5, -0.08], [0.42, 0.24],
    [0.18, 0.5], [-0.16, 0.42], [-0.42, 0.48], [-0.5, 0.2],
  ],
  "glacial-lake": [
    [-0.5, -0.3], [-0.28, -0.44], [0.02, -0.3], [0.3, -0.48], [0.5, -0.22], [0.32, 0.02],
    [0.5, 0.3], [0.24, 0.46], [-0.04, 0.32], [-0.34, 0.5], [-0.5, 0.24], [-0.32, -0.02],
  ],
  "marsh-lake": [
    [-0.5, -0.2], [-0.3, -0.42], [-0.08, -0.32], [0.12, -0.5], [0.36, -0.34], [0.5, -0.08],
    [0.34, 0.08], [0.5, 0.4], [0.18, 0.5], [-0.06, 0.36], [-0.26, 0.5], [-0.5, 0.3], [-0.34, 0.06], [-0.18, 0.2],
  ],
  "shelf-sea": [
    [-0.5, -0.36], [-0.28, -0.5], [0.02, -0.4], [0.24, -0.5], [0.5, -0.28], [0.4, 0],
    [0.5, 0.34], [0.22, 0.5], [-0.1, 0.38], [-0.36, 0.5], [-0.5, 0.24],
  ],
  "coral-sea": [
    [-0.5, -0.18], [-0.36, -0.44], [-0.08, -0.5], [0.2, -0.4], [0.48, -0.22], [0.5, 0.12],
    [0.32, 0.38], [0.04, 0.5], [-0.24, 0.4], [-0.5, 0.28], [-0.3, 0.02], [-0.08, 0.2], [0.16, 0.12], [0.28, -0.08], [0.08, -0.26], [-0.18, -0.24],
  ],
  "deep-trench": [
    [-0.5, -0.42], [-0.3, -0.5], [-0.12, -0.22], [0.1, -0.46], [0.3, -0.28], [0.5, -0.42],
    [0.38, -0.04], [0.5, 0.42], [0.24, 0.5], [0.04, 0.22], [-0.18, 0.48], [-0.36, 0.24], [-0.5, 0.4], [-0.36, 0.02],
  ],
  "tidal-flat": [
    [-0.5, -0.28], [-0.34, -0.46], [-0.1, -0.38], [0.14, -0.5], [0.4, -0.3], [0.5, -0.04],
    [0.38, 0.12], [0.5, 0.42], [0.18, 0.5], [-0.04, 0.36], [-0.3, 0.5], [-0.5, 0.28],
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
  if (component.terrainPrefab?.kind === "land") {
    return { width: 440, height: 300 };
  }
  if (component.terrainPrefab?.kind === "water") {
    return { width: 300, height: 220 };
  }
  if (component.id === "continent") return { width: 440, height: 300 };
  if (component.id === "delta") return { width: 300, height: 220 };
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
  if (component.drawKind === "area" || component.drawKind === "polygon") {
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
  if (component.drawKind === "marker") {
    return [
      {
        x: roundMapCoordinate(anchor.x),
        y: roundMapCoordinate(anchor.y),
      },
    ];
  }
  const terrainShape = component.terrainPrefab?.shape;
  const shape =
    terrainShape === "organic"
      ? organicCoastline(`${input.id}:continent`, 64, 0.82)
      : (PREFAB_SHAPES[terrainShape ?? component.id] ??
        PREFAB_SHAPES[component.id] ??
        defaultPrefabShape(component));
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

const ARCHIPELAGO_LAYOUTS: Readonly<
  Partial<Record<MapComponentTerrainShape, readonly ArchipelagoIsland[]>>
> = {
  "twin-continent": [
    { x: -152, y: -18, scale: 0.58 },
    { x: 152, y: 18, scale: 0.58 },
  ],
  "broken-continent": [
    { x: -164, y: -44, scale: 0.38 },
    { x: -62, y: 76, scale: 0.28 },
    { x: 68, y: -68, scale: 0.42 },
    { x: 164, y: 50, scale: 0.3 },
    { x: 18, y: 116, scale: 0.2 },
  ],
  "volcanic-islands": [
    { x: -200, y: 82, scale: 0.18 },
    { x: -132, y: 12, scale: 0.25 },
    { x: -58, y: -54, scale: 0.34 },
    { x: 26, y: -84, scale: 0.24 },
    { x: 104, y: -52, scale: 0.29 },
    { x: 166, y: 14, scale: 0.2 },
    { x: 218, y: 86, scale: 0.15 },
  ],
  "coral-islands": [
    { x: -178, y: -50, scale: 0.18 },
    { x: -104, y: -94, scale: 0.13 },
    { x: -32, y: -48, scale: 0.22 },
    { x: 54, y: -88, scale: 0.15 },
    { x: 142, y: -34, scale: 0.2 },
    { x: -136, y: 74, scale: 0.16 },
    { x: -44, y: 52, scale: 0.12 },
    { x: 50, y: 84, scale: 0.2 },
    { x: 150, y: 62, scale: 0.14 },
  ],
  "reef-ring": [
    { x: 0, y: -100, scale: 0.18 },
    { x: 98, y: -62, scale: 0.14 },
    { x: 156, y: 8, scale: 0.2 },
    { x: 88, y: 74, scale: 0.15 },
    { x: 0, y: 106, scale: 0.18 },
    { x: -94, y: 70, scale: 0.13 },
    { x: -150, y: -2, scale: 0.2 },
    { x: -94, y: -66, scale: 0.15 },
  ],
  "arc-islands": [
    { x: -206, y: 94, scale: 0.16 },
    { x: -138, y: 26, scale: 0.21 },
    { x: -64, y: -28, scale: 0.25 },
    { x: 22, y: -56, scale: 0.2 },
    { x: 106, y: -40, scale: 0.24 },
    { x: 174, y: 18, scale: 0.17 },
    { x: 222, y: 88, scale: 0.13 },
  ],
  "lake-cluster": [
    { x: -126, y: -52, scale: 0.2 },
    { x: -26, y: -88, scale: 0.14 },
    { x: 88, y: -58, scale: 0.22 },
    { x: -92, y: 58, scale: 0.15 },
    { x: 14, y: 74, scale: 0.2 },
    { x: 126, y: 54, scale: 0.13 },
  ],
  "ring-continent": [
    { x: 0, y: -104, scale: 0.42 },
    { x: 104, y: 0, scale: 0.42 },
    { x: 0, y: 104, scale: 0.42 },
    { x: -104, y: 0, scale: 0.42 },
  ],
};

function organicArchipelagoLayout(
  seed: string,
  shape: MapComponentTerrainShape | undefined,
): readonly ArchipelagoIsland[] {
  const template = shape ? ARCHIPELAGO_LAYOUTS[shape] : undefined;
  if (template) {
    return template.map((island, index) => ({
      x: island.x + (prefabNoise(seed, index + 31) - 0.5) * 20,
      y: island.y + (prefabNoise(seed, index + 51) - 0.5) * 16,
      scale: island.scale * (0.88 + prefabNoise(seed, index + 71) * 0.22),
    }));
  }
  const count = 7;
  const angle = (prefabNoise(seed, 31) - 0.5) * 0.7;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1) - 0.5;
    const along = progress * 430 + (prefabNoise(seed, index + 40) - 0.5) * 34;
    const arc =
      Math.sin(progress * Math.PI) * (54 + prefabNoise(seed, index + 50) * 48) +
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
  const shape = input.component.terrainPrefab?.shape;
  return organicArchipelagoLayout(input.id, shape).map((island, index) => {
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

/**
 * 读取与画布预制件共用的归一化轮廓，供素材卡片生成真实形状预览。
 * 预览不参与地图事实，只是把同一套几何意图投影到素材目录尺寸中。
 */
export function getMapComponentTerrainPreviewShapes(
  componentId: string,
): readonly (readonly PrefabPoint[])[] {
  const component = MAP_COMPONENT_PRESETS.find((item) => item.id === componentId);
  const terrainPrefab = component?.terrainPrefab;
  if (!component || !terrainPrefab) return [];
  const shape = terrainPrefab.shape;
  if (terrainPrefab.layout === "archipelago") {
    const base =
      (shape ? PREFAB_SHAPES[shape] : undefined) ??
      PREFAB_SHAPES[component.id] ??
      PREFAB_SHAPES.continent;
    const islands =
      (shape ? ARCHIPELAGO_LAYOUTS[shape] : undefined) ??
      organicArchipelagoLayout(componentId, shape);
    return islands.map((island) =>
      base.map(([x, y]) => [
        island.x / 440 + x * island.scale,
        island.y / 300 + y * island.scale,
      ] as const),
    );
  }
  if (shape === "organic" || !shape) return [PREFAB_SHAPES.continent];
  return [
    PREFAB_SHAPES[shape] ??
      PREFAB_SHAPES[component.id] ??
      PREFAB_SHAPES.continent,
  ];
}

/**
 * 将连续表面笔刷的中心线扩展为可持久化的闭合区域。
 *
 * 闭合笔迹保留作者勾画的边界；开放笔迹则按当前笔刷宽度生成一条连续
 * 覆盖带。两种形式最后都只写入 MapDocument 的区域事实，而不是保存一串
 * 临时盖印或用视觉遮罩伪造表面。
 */
export function createMapComponentSurfaceBrushPoints(input: {
  readonly points: readonly MapScenePoint[];
  readonly width: number;
  readonly closed: boolean;
}): MapScenePoint[] {
  const points = input.points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: roundMapCoordinate(point.x), y: roundMapCoordinate(point.y) }));
  if (points.length === 0) return [];
  if (input.closed && points.length >= 3) return points;

  const radius = Math.max(12, Math.min(4096, input.width) / 2);
  if (points.length === 1) {
    const center = points[0]!;
    const segments = 20;
    return Array.from({ length: segments }, (_, index) => {
      const angle = (index / segments) * Math.PI * 2;
      return {
        x: roundMapCoordinate(center.x + Math.cos(angle) * radius),
        y: roundMapCoordinate(center.y + Math.sin(angle) * radius),
      };
    });
  }

  const normals = points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: -dy / length, y: dx / length };
  });
  const left = points.map((point, index) => ({
    x: roundMapCoordinate(point.x + normals[index]!.x * radius),
    y: roundMapCoordinate(point.y + normals[index]!.y * radius),
  }));
  const right = points.map((point, index) => ({
    x: roundMapCoordinate(point.x - normals[index]!.x * radius),
    y: roundMapCoordinate(point.y - normals[index]!.y * radius),
  }));
  return [...left, ...right.reverse()];
}

/** 以表面构件样式创建连续区域，供画布笔刷和其预览共用。 */
export function createMapComponentSurfaceBrushRegions(input: {
  readonly component: MapComponentPreset;
  readonly id: string;
  readonly layerId: string;
  readonly points: readonly MapScenePoint[];
  readonly width: number;
  readonly closed: boolean;
  readonly curve?: MapSceneRegion["curve"];
}): readonly MapSceneRegion[] {
  const terrainPrefab = input.component.terrainPrefab;
  if (
    !terrainPrefab ||
    mapComponentPlacement(input.component) !== "terrain-prefab"
  ) {
    return [];
  }
  const points = createMapComponentSurfaceBrushPoints(input);
  if (points.length < 3) return [];
  return [
    {
      id: input.id,
      layerId: input.layerId,
      kind: terrainPrefab.kind,
      points,
      fill: terrainPrefab.fill,
      texture: terrainPrefab.texture,
      opacity: 1,
      edgeColor: terrainPrefab.edgeColor,
      edgeWidth: terrainPrefab.edgeWidth,
      ...(input.curve ? { curve: input.curve } : {}),
    },
  ];
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
  // 只有真实地形预制件才能写入 MapSceneRegion。疆域填色、行政区纹理和
  // 文明疆域虽然复用同一套表面几何模板，但 placement=overlay，必须保留为
  // MapFeature 覆盖层，不能改变海陆事实。
  if (
    !terrainPrefab ||
    mapComponentPlacement(input.component) !== "terrain-prefab"
  ) {
    return [];
  }
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
    // 预制件是新建内容，不能继续写出早期的 polygon 区域值。
    kind: component.drawKind === "polygon" ? "area" : component.drawKind,
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
