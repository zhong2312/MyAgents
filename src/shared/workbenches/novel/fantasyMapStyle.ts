import type { FantasyFeature } from "./fantasyMapGenerator";
import type { MapGenerationNaming } from "./mapGenerationPlan";

/** 地图生成的产品风格契约。它不是 Azgaar 的皮肤名称，而是导出适配层的稳定语义。 */
export const FANTASY_MAP_STYLE_ID = "xuanhuan-zh" as const;

type StyleFeature = Pick<FantasyFeature, "kind" | "name" | "props"> & {
  readonly id: string;
};

const HAN_PATTERN = /[\u3400-\u9fff]/u;

const NAME_POOLS: Readonly<Record<string, readonly string[]>> = {
  state: [
    "天阙神朝",
    "九霄仙域",
    "北冥玄国",
    "赤曜王庭",
    "太虚圣境",
    "幽都魔域",
  ],
  province: ["云州", "苍梧州", "玄冰道", "赤炎府", "沧澜郡", "万妖岭"],
  biome: [
    "青岚林海",
    "赤月荒原",
    "玄冰雪原",
    "幽冥湿地",
    "天火熔原",
    "星陨高地",
  ],
  burg: ["云中城", "天机城", "落星城", "万剑城", "青冥关", "龙门镇", "沧海港"],
  river: ["苍龙江", "星河", "沧澜水", "九曲玄河", "忘川", "天镜河"],
  lake: ["月镜湖", "天池", "瑶光湖", "玄女泽", "龙渊湖"],
  route: ["古仙道", "商旅道", "天关驿路", "龙脉通衢", "星舟航线"],
  marker: ["秘境", "灵脉节点", "上古遗迹", "封印之地", "天门关"],
  region: ["东境", "西荒", "南疆", "北原", "中州", "海外诸岛"],
};

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function layerKey(feature: Pick<StyleFeature, "kind" | "props">): string {
  const layer = feature.props.azgaarLayer;
  if (layer && NAME_POOLS[layer]) return layer;
  if (feature.props.terrain && NAME_POOLS[feature.props.terrain]) {
    return feature.props.terrain;
  }
  if (feature.kind === "route") return "route";
  if (feature.kind === "marker") return "marker";
  if (feature.kind === "area") return "region";
  return "marker";
}

function indexedName(
  key: string,
  seed: string,
  index: number,
  naming?: MapGenerationNaming,
): string {
  const plannedNames = naming?.entries.filter((entry) => entry.role === key);
  if (plannedNames && plannedNames.length > 0) {
    return plannedNames[
      stableHash(`${seed}:${key}:${index}`) % plannedNames.length
    ]!.name;
  }
  const pool = NAME_POOLS[key] ?? NAME_POOLS.marker;
  const value =
    pool[stableHash(`${seed}:${key}:${index}`) % pool.length] ?? pool[0]!;
  const duplicateIndex = Math.floor(index / pool.length);
  return duplicateIndex > 0 ? `${value}${duplicateIndex + 1}` : value;
}

function plannedName(
  key: string,
  seed: string,
  index: number,
  naming: MapGenerationNaming,
): string {
  const plannedNames = naming.entries.filter((entry) => entry.role === key);
  // 完整正式规划会由服务端保证每种基础地形类别均有命名。此处保留
  // 同一个确定性回退，仅保护独立样式函数被旧调用直接复用的场景。
  if (plannedNames.length === 0) return indexedName(key, seed, index);
  return plannedNames[
    stableHash(`${seed}:${key}:${index}`) % plannedNames.length
  ]!.name;
}

/** 中文名优先；仅对 Azgaar 的英文随机名或兼容生成器的占位名重命名。 */
export function fantasyChineseName(
  feature: Pick<StyleFeature, "kind" | "name" | "props">,
  seed: string,
  index: number,
  naming?: MapGenerationNaming,
): string {
  if (HAN_PATTERN.test(feature.name)) return feature.name;
  return indexedName(layerKey(feature), seed, index, naming);
}

function styleProps(
  feature: Pick<StyleFeature, "kind" | "props">,
  seed: string,
  index: number,
): Record<string, string> {
  const key = layerKey(feature);
  const role = feature.props.entityRole;
  const terrain = feature.props.terrain;
  const palette = ["#8d624c", "#6f8065", "#71618c", "#9a7545", "#567789"];
  const paletteIndex = stableHash(`${seed}:palette:${index}`) % palette.length;
  const isMysticSite = [
    "sect",
    "holy-land",
    "secret-realm",
    "forbidden-land",
    "ruin",
    "demon-den",
    "portal",
    "battlefield",
  ].includes(role ?? "");
  const label =
    role === "realm" || feature.props.spatialRole === "realm"
      ? { font: "atlas-serif", size: "30", weight: "700", priority: "6" }
      : role === "region" || feature.props.spatialRole === "region"
        ? { font: "atlas-serif", size: "24", weight: "700", priority: "5" }
        : role === "capital"
          ? { font: "atlas-serif", size: "20", weight: "700", priority: "5" }
          : isMysticSite
            ? { font: "cartographer", size: "16", weight: "600", priority: "4" }
            : role === "mountain" || role === "vein"
              ? {
                  font: "atlas-serif",
                  size: "18",
                  weight: "600",
                  priority: "4",
                }
              : role === "waterway" || terrain === "river"
                ? {
                    font: "cartographer",
                    size: "16",
                    weight: "600",
                    priority: "3",
                  }
                : key === "state"
                  ? {
                      font: "atlas-serif",
                      size: "25",
                      weight: "700",
                      priority: "5",
                    }
                  : key === "province" || key === "region"
                    ? {
                        font: "atlas-serif",
                        size: "17",
                        weight: "700",
                        priority: "4",
                      }
                    : key === "burg"
                      ? {
                          font: "humanist",
                          size: "13",
                          weight: "700",
                          priority: "3",
                        }
                      : {
                          font: "cartographer",
                          size: "11",
                          weight: "600",
                          priority: "2",
                        };
  const props: Record<string, string> = {
    ...feature.props,
    fantasyStyle: FANTASY_MAP_STYLE_ID,
    labelFont: label.font,
    labelColor: "#35271f",
    labelHaloColor: "#f4e5c6",
    labelSize: label.size,
    labelWeight: label.weight,
    labelPriority:
      feature.props.labelPriority ?? feature.props.importance ?? label.priority,
  };
  if (role === "waterway" || terrain === "river") {
    props.labelColor = "#284f62";
    props.labelHaloColor = "#edf3ed";
    props.labelItalic = "true";
    props.labelFollowPath = "true";
  }
  if (role === "mountain" || role === "vein") {
    props.labelFollowPath = "true";
  }
  if (feature.props.azgaarLayer) props.azgaarShowLabel = "true";
  switch (key) {
    case "region":
      if (terrain === "coast") {
        props.color = "#6f503d";
        props.fill = "#d8c49a";
        props.lineWidth = "2.2";
      } else {
        props.color = "#806348";
        props.fill = `${palette[paletteIndex]}38`;
        props.lineWidth = "1.2";
      }
      break;
    case "state":
      props.color = palette[paletteIndex]!;
      props.fill = `${palette[paletteIndex]}72`;
      props.lineWidth = "2";
      break;
    case "province":
      props.color = "#806348";
      props.fill = `${palette[paletteIndex]}38`;
      props.lineWidth = "1.4";
      break;
    case "river":
    case "lake":
      props.color = "#2e687a";
      props.lineWidth = key === "river" ? "3" : "2";
      break;
    case "biome":
      props.color = "#6e6049";
      props.fill = `${palette[paletteIndex]}30`;
      break;
    case "route":
      props.color = "#8c5a3a";
      props.lineWidth = "2.2";
      break;
    case "burg":
      props.color = "#743f2d";
      break;
    default:
      break;
  }
  return props;
}

/** 将兼容生成器或 Azgaar 适配器的要素统一为中文玄幻地图语义。 */
export function localizeFantasyMapFeatures<T extends StyleFeature>(
  features: readonly T[],
  seed: string,
  naming?: MapGenerationNaming,
): T[] {
  return features.map((feature, index) => {
    const { generatedName, ...persistedProps } = feature.props;
    const normalizedFeature = { ...feature, props: persistedProps };
    return {
      ...feature,
      name:
        generatedName === "true" && naming
          ? plannedName(layerKey(normalizedFeature), seed, index, naming)
          : fantasyChineseName(normalizedFeature, seed, index, naming),
      props: styleProps(normalizedFeature, seed, index),
    };
  });
}

/**
 * 官方 SVG 的标签和图例可能仍是英文。隐藏原生文字后由 MapDocument 的
 * 中文可编辑要素重新绘制标签，避免出现中英双层地名；同时把默认政治地图
 * 的高饱和色压回羊皮纸、靛青水域和赭石边界的玄幻地图色系。
 */
export function applyFantasyMapSvgStyle(svg: string): string {
  if (!/<svg[\s>]/iu.test(svg)) return svg;
  const style = `<style id="myagents-fantasy-map-style"><![CDATA[
    svg { background: #d8c49a !important; }
    text { display: none !important; font-family: "Noto Serif CJK SC", "Microsoft YaHei", serif !important; }
    #legend, #scaleBar, #coordinates { opacity: .46 !important; }
    #land, #land * { fill: #d8c49a !important; }
    #biomes path, #biomes polygon, #biomes rect { opacity: .34 !important; mix-blend-mode: multiply; }
    #ocean, #oceanLayers, #oceanLayers * { fill: #356f83 !important; stroke: #234f62 !important; }
    #states path, #states polygon { fill: #b28b66 !important; fill-opacity: .18 !important; stroke: #806348 !important; stroke-width: 1.1px !important; stroke-dasharray: 4 3 !important; }
    #provs path, #provs polygon { fill: #c6a471 !important; fill-opacity: .12 !important; stroke: #9a7956 !important; stroke-width: .8px !important; }
    #rivers path, #rivers path[id], #routes path { stroke: #2e687a !important; stroke-linecap: round !important; }
    #coastline path, #coastline { stroke: #6f503d !important; stroke-width: 2.2px !important; }
    #grid path, #graticule path { opacity: .16 !important; }
  ]]></style>`;
  return svg.replace(/(<svg\b[^>]*>)/iu, `$1${style}`);
}
