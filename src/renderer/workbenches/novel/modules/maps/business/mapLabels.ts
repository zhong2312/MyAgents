import { isMapRiverFeature, smoothMapPath } from "./mapHydrography";
import { isMapFeatureFreeformArea } from "../entities/mapSchema";
import type { MapFeature, MapScenePoint } from "../entities/mapSchema";

export const MAP_LABEL_FONT_OPTIONS = Object.freeze([
  {
    id: "atlas-serif",
    name: "典籍衬线",
    family: '"Noto Serif SC", "Songti SC", SimSun, serif',
  },
  {
    id: "cartographer",
    name: "地图手书",
    family: 'KaiTi, STKaiti, "Noto Serif SC", serif',
  },
  {
    id: "humanist",
    name: "清晰黑体",
    family: '"Microsoft YaHei", "Noto Sans SC", sans-serif',
  },
] as const);

export type MapLabelFontId = (typeof MAP_LABEL_FONT_OPTIONS)[number]["id"];
export type MapLabelWritingMode = "horizontal" | "vertical";
export type MapLabelFrame = "none" | "cartouche" | "seal";

export const MAP_LABEL_STYLE_PRESETS = Object.freeze([
  {
    id: "region",
    name: "区域标题",
    props: {
      labelFont: "atlas-serif",
      labelSize: "28",
      labelWeight: "700",
      labelColor: "#3a3329",
      labelHaloColor: "#f6eddb",
      labelHaloWidth: "4",
      labelOffsetX: "0",
      labelOffsetY: "0",
      labelRotation: "0",
      labelItalic: "false",
      labelFollowPath: "false",
    },
  },
  {
    id: "settlement",
    name: "聚落地名",
    props: {
      labelFont: "humanist",
      labelSize: "14",
      labelWeight: "700",
      labelColor: "#302c27",
      labelHaloColor: "#fffaf1",
      labelHaloWidth: "4",
      labelOffsetX: "0",
      labelOffsetY: "-24",
      labelRotation: "0",
      labelItalic: "false",
      labelFollowPath: "false",
    },
  },
  {
    id: "water",
    name: "水系名称",
    props: {
      labelFont: "cartographer",
      labelSize: "16",
      labelWeight: "600",
      labelColor: "#284f62",
      labelHaloColor: "#edf3ed",
      labelHaloWidth: "4",
      labelOffsetX: "0",
      labelOffsetY: "-10",
      labelRotation: "0",
      labelItalic: "true",
      labelFollowPath: "true",
    },
  },
  {
    id: "annotation",
    name: "地图注记",
    props: {
      labelFont: "cartographer",
      labelSize: "18",
      labelWeight: "600",
      labelColor: "#4b4034",
      labelHaloColor: "#fffaf1",
      labelHaloWidth: "3",
      labelOffsetX: "0",
      labelOffsetY: "0",
      labelRotation: "0",
      labelItalic: "false",
      labelFollowPath: "false",
    },
  },
  {
    id: "vertical-title",
    name: "竖排题签",
    props: {
      labelFont: "atlas-serif",
      labelSize: "22",
      labelWeight: "700",
      labelColor: "#3a3329",
      labelHaloColor: "#f6eddb",
      labelHaloWidth: "2",
      labelOffsetX: "0",
      labelOffsetY: "0",
      labelRotation: "0",
      labelItalic: "false",
      labelFollowPath: "false",
      labelWritingMode: "vertical",
      labelFrame: "cartouche",
    },
  },
  {
    id: "seal",
    name: "朱印落款",
    props: {
      labelFont: "cartographer",
      labelSize: "16",
      labelWeight: "700",
      labelColor: "#fffaf1",
      labelHaloColor: "#fffaf1",
      labelHaloWidth: "0",
      labelOffsetX: "0",
      labelOffsetY: "0",
      labelRotation: "0",
      labelItalic: "false",
      labelFollowPath: "false",
      labelWritingMode: "vertical",
      labelFrame: "seal",
    },
  },
] as const);

export type MapLabelStyle = {
  readonly fontId: MapLabelFontId;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: 400 | 600 | 700;
  readonly color: string;
  readonly haloColor: string;
  readonly haloWidth: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly rotation: number;
  readonly italic: boolean;
  readonly followPath: boolean;
  readonly writingMode: MapLabelWritingMode;
  readonly frame: MapLabelFrame;
};

export type MapLabelLayout = {
  readonly anchor: MapScenePoint;
  /** 只包含路径方向；作者设置的旋转角度由渲染器叠加。 */
  readonly pathRotation: number;
};

export type MapLabelPlacement = {
  readonly visible: boolean;
  readonly layout: MapLabelLayout;
  readonly offsetX: number;
  readonly offsetY: number;
};

export type MapLabelPlacementOptions = {
  /** 仅用于缩放级别筛选，不会改变 MapDocument 中的标签事实。 */
  readonly zoom?: number;
  readonly padding?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback;
}

function color(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function fontOption(id: string | undefined) {
  return (
    MAP_LABEL_FONT_OPTIONS.find((option) => option.id === id) ??
    MAP_LABEL_FONT_OPTIONS[0]
  );
}

function writingMode(value: string | undefined): MapLabelWritingMode {
  return value === "vertical" ? "vertical" : "horizontal";
}

function frame(value: string | undefined): MapLabelFrame {
  if (value === "cartouche" || value === "seal") return value;
  return "none";
}

function defaultStyle(
  feature: MapFeature,
): Omit<MapLabelStyle, "fontFamily" | "writingMode" | "frame"> {
  const role = feature.props.entityRole;
  if (
    role === "sect" ||
    role === "holy-land" ||
    role === "secret-realm" ||
    role === "forbidden-land" ||
    role === "ruin" ||
    role === "demon-den" ||
    role === "portal" ||
    role === "battlefield"
  ) {
    return {
      fontId: "cartographer",
      fontSize: 16,
      fontWeight: 600,
      color: "#5a382c",
      haloColor: "#f6eddb",
      haloWidth: 4,
      offsetX: 0,
      offsetY: -34,
      rotation: 0,
      italic: false,
      followPath: false,
    };
  }
  if (isMapRiverFeature(feature)) {
    return {
      fontId: "cartographer",
      fontSize: 16,
      fontWeight: 600,
      color: "#284f62",
      haloColor: "#edf3ed",
      haloWidth: 4,
      offsetX: 0,
      offsetY: -10,
      rotation: 0,
      italic: true,
      followPath: true,
    };
  }
  if (isMapFeatureFreeformArea(feature.kind)) {
    return {
      fontId: "atlas-serif",
      fontSize: 22,
      fontWeight: 700,
      color: "#3a3329",
      haloColor: "#f6eddb",
      haloWidth: 4,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      italic: false,
      followPath: false,
    };
  }
  if (feature.kind === "label") {
    return {
      fontId: "cartographer",
      fontSize: 20,
      fontWeight: 600,
      color: "#4b4034",
      haloColor: "#fffaf1",
      haloWidth: 3,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      italic: false,
      followPath: false,
    };
  }
  if (feature.kind === "route") {
    return {
      fontId: "atlas-serif",
      fontSize: 14,
      fontWeight: 600,
      color: "#4b4034",
      haloColor: "#fffaf1",
      haloWidth: 4,
      offsetX: 0,
      offsetY: -10,
      rotation: 0,
      italic: false,
      followPath: true,
    };
  }
  return {
    fontId: "humanist",
    fontSize: 14,
    fontWeight: 700,
    color: "#302c27",
    haloColor: "#fffaf1",
    haloWidth: 4,
    offsetX: 0,
    offsetY: feature.props.component ? -40 : -22,
    rotation: 0,
    italic: false,
    followPath: false,
  };
}

export function mapFeatureHasLabel(feature: MapFeature): boolean {
  return feature.kind === "label" || feature.props.showLabel === "true";
}

export function getMapLabelStyle(feature: MapFeature): MapLabelStyle {
  const fallback = defaultStyle(feature);
  const font = fontOption(feature.props.labelFont ?? fallback.fontId);
  const weight = finiteNumber(
    feature.props.labelWeight,
    fallback.fontWeight,
    400,
    700,
  );
  return {
    fontId: font.id,
    fontFamily: font.family,
    fontSize: finiteNumber(feature.props.labelSize, fallback.fontSize, 8, 96),
    fontWeight: weight >= 700 ? 700 : weight >= 600 ? 600 : 400,
    color: color(feature.props.labelColor, fallback.color),
    haloColor: color(feature.props.labelHaloColor, fallback.haloColor),
    haloWidth: finiteNumber(
      feature.props.labelHaloWidth,
      fallback.haloWidth,
      0,
      12,
    ),
    offsetX: finiteNumber(
      feature.props.labelOffsetX,
      fallback.offsetX,
      -800,
      800,
    ),
    offsetY: finiteNumber(
      feature.props.labelOffsetY,
      fallback.offsetY,
      -800,
      800,
    ),
    rotation: finiteNumber(
      feature.props.labelRotation,
      fallback.rotation,
      -180,
      180,
    ),
    italic:
      feature.props.labelItalic === undefined
        ? fallback.italic
        : feature.props.labelItalic === "true",
    followPath:
      feature.props.labelFollowPath === undefined
        ? fallback.followPath
        : feature.props.labelFollowPath === "true",
    writingMode: writingMode(feature.props.labelWritingMode),
    frame: frame(feature.props.labelFrame),
  };
}

export function mapLabelCanvasFont(style: MapLabelStyle, scale = 1): string {
  const size = Math.max(1, style.fontSize * scale);
  return `${style.italic ? "italic " : ""}${style.fontWeight} ${size}px ${style.fontFamily}`;
}

function averagePoint(points: readonly MapScenePoint[]): MapScenePoint {
  if (points.length === 0) return { x: 0, y: 0 };
  const total = points.reduce(
    (result, point) => ({ x: result.x + point.x, y: result.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function polygonCentroid(points: readonly MapScenePoint[]): MapScenePoint {
  if (points.length < 3) return averagePoint(points);
  let signedAreaTwice = 0;
  let weightedX = 0;
  let weightedY = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]!;
    const cross = point.x * next.y - next.x * point.y;
    signedAreaTwice += cross;
    weightedX += (point.x + next.x) * cross;
    weightedY += (point.y + next.y) * cross;
  });
  if (Math.abs(signedAreaTwice) < 0.0001) return averagePoint(points);
  return {
    x: weightedX / (3 * signedAreaTwice),
    y: weightedY / (3 * signedAreaTwice),
  };
}

function uprightAngle(angle: number): number {
  let normalized = ((((angle + 180) % 360) + 360) % 360) - 180;
  if (normalized > 90) normalized -= 180;
  if (normalized < -90) normalized += 180;
  return normalized;
}

function pointAlongPath(
  points: readonly MapScenePoint[],
  ratio: number,
): MapLabelLayout {
  if (points.length < 2) {
    return { anchor: points[0] ?? { x: 0, y: 0 }, pathRotation: 0 };
  }
  const lengths = points
    .slice(1)
    .map((point, index) =>
      Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y),
    );
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (totalLength <= 0) return { anchor: points[0]!, pathRotation: 0 };
  const target = totalLength * clamp(ratio, 0, 1);
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (travelled + length < target && index < lengths.length - 1) {
      travelled += length;
      continue;
    }
    const from = points[index]!;
    const to = points[index + 1]!;
    const progress = length <= 0 ? 0 : (target - travelled) / length;
    return {
      anchor: {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
      },
      pathRotation: uprightAngle(
        (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      ),
    };
  }
  return { anchor: points[points.length - 1]!, pathRotation: 0 };
}

export function getMapLabelLayout(
  feature: MapFeature,
  points: readonly MapScenePoint[] = feature.points,
): MapLabelLayout {
  const style = getMapLabelStyle(feature);
  if (feature.kind === "route") {
    const path = isMapRiverFeature(feature) ? smoothMapPath(points) : points;
    const layout = pointAlongPath(
      path,
      isMapRiverFeature(feature) ? 0.56 : 0.5,
    );
    return style.followPath ? layout : { ...layout, pathRotation: 0 };
  }
  if (isMapFeatureFreeformArea(feature.kind)) {
    return { anchor: polygonCentroid(points), pathRotation: 0 };
  }
  return { anchor: points[0] ?? { x: 0, y: 0 }, pathRotation: 0 };
}

type LabelRect = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

const LABEL_COLLISION_CELL_SIZE = 128;

function labelTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    width += /[\u2e80-\u9fff\uff00-\uffef]/u.test(character)
      ? fontSize
      : fontSize * 0.58;
  }
  return Math.max(fontSize, width);
}

export function mapLabelLines(
  text: string,
  style: Pick<MapLabelStyle, "writingMode">,
): readonly string[] {
  if (style.writingMode !== "vertical") return [text];
  return Array.from(text).filter((character) => !/\s/u.test(character));
}

export function mapLabelText(
  text: string,
  style: Pick<MapLabelStyle, "writingMode">,
): string {
  return mapLabelLines(text, style).join("\n");
}

export type MapLabelTextDimensions = {
  readonly width: number;
  readonly height: number;
};

export function getMapLabelTextDimensions(
  text: string,
  style: Pick<MapLabelStyle, "fontSize" | "writingMode" | "frame">,
): MapLabelTextDimensions {
  const lines = mapLabelLines(text, style);
  const textWidth =
    style.writingMode === "vertical"
      ? style.fontSize
      : labelTextWidth(text, style.fontSize);
  const textHeight =
    style.writingMode === "vertical"
      ? Math.max(1, lines.length) * style.fontSize * 1.15
      : style.fontSize * 1.24;
  if (style.frame === "cartouche") {
    return {
      width: textWidth + style.fontSize * 0.9,
      height: textHeight + style.fontSize * 0.7,
    };
  }
  if (style.frame === "seal") {
    const diameter = Math.max(textWidth, textHeight) + style.fontSize * 0.8;
    return { width: diameter, height: diameter };
  }
  return { width: textWidth, height: textHeight };
}

export type MapLabelFrameStyle = {
  readonly fill: string;
  readonly stroke: string;
  readonly lineWidth: number;
};

export function getMapLabelFrameStyle(
  style: Pick<MapLabelStyle, "frame" | "color" | "haloColor">,
): MapLabelFrameStyle | null {
  if (style.frame === "cartouche") {
    return { fill: "#f6eddbdd", stroke: style.color, lineWidth: 1.2 };
  }
  if (style.frame === "seal") {
    return { fill: "#9b3329", stroke: "#f6eddb", lineWidth: 1.5 };
  }
  return null;
}

function labelPriority(feature: MapFeature): number {
  const explicit = Number(
    feature.props.labelPriority ?? feature.props.importance,
  );
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 10);
  if (feature.kind === "label" || isMapFeatureFreeformArea(feature.kind))
    return 5;
  if (
    feature.props.entityRole === "capital" ||
    feature.props.entityRole === "realm"
  )
    return 5;
  if (feature.props.entityRole) return 4;
  if (isMapRiverFeature(feature)) return 3;
  return 2;
}

function intersects(
  left: LabelRect,
  right: LabelRect,
  padding: number,
): boolean {
  return !(
    left.right + padding < right.left ||
    right.right + padding < left.left ||
    left.bottom + padding < right.top ||
    right.bottom + padding < left.top
  );
}

function collisionCellRange(rect: LabelRect, padding: number) {
  return {
    left: Math.floor((rect.left - padding) / LABEL_COLLISION_CELL_SIZE),
    right: Math.floor((rect.right + padding) / LABEL_COLLISION_CELL_SIZE),
    top: Math.floor((rect.top - padding) / LABEL_COLLISION_CELL_SIZE),
    bottom: Math.floor((rect.bottom + padding) / LABEL_COLLISION_CELL_SIZE),
  };
}

function collisionCellKey(column: number, row: number): string {
  return `${column}:${row}`;
}

/**
 * 标签避让只需与相邻空间格中的矩形比较。格子由候选矩形和 padding 同时
 * 扩展，因而不会遗漏跨格碰撞，同时避免大地图中的全量线性扫描。
 */
function createLabelCollisionIndex(padding: number) {
  const cells = new Map<string, LabelRect[]>();

  return {
    intersects(rect: LabelRect): boolean {
      const range = collisionCellRange(rect, padding);
      const checked = new Set<LabelRect>();
      for (let column = range.left; column <= range.right; column += 1) {
        for (let row = range.top; row <= range.bottom; row += 1) {
          const candidates = cells.get(collisionCellKey(column, row));
          if (!candidates) continue;
          for (const candidate of candidates) {
            if (checked.has(candidate)) continue;
            checked.add(candidate);
            if (intersects(rect, candidate, padding)) return true;
          }
        }
      }
      return false;
    },
    add(rect: LabelRect): void {
      const range = collisionCellRange(rect, padding);
      for (let column = range.left; column <= range.right; column += 1) {
        for (let row = range.top; row <= range.bottom; row += 1) {
          const key = collisionCellKey(column, row);
          const bucket = cells.get(key);
          if (bucket) bucket.push(rect);
          else cells.set(key, [rect]);
        }
      }
    },
  };
}

/**
 * 为所有标签做一次确定性的避让。排版是渲染派生值：同一批要素、同一
 * 缩放级别始终得到同一结果，作者仍然只需要编辑原始点和标签样式。
 */
export function resolveMapLabelPlacements(
  features: readonly MapFeature[],
  options: MapLabelPlacementOptions = {},
): ReadonlyMap<string, MapLabelPlacement> {
  const zoom = Number.isFinite(options.zoom) ? Math.max(0.1, options.zoom!) : 1;
  const padding = Number.isFinite(options.padding)
    ? Math.max(0, options.padding!)
    : 6;
  const candidates = features
    .filter((feature) => mapFeatureHasLabel(feature) && feature.name.trim())
    .map((feature) => {
      const style = getMapLabelStyle(feature);
      const layout = getMapLabelLayout(feature);
      return {
        feature,
        style,
        layout,
        priority: labelPriority(feature),
      };
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.style.fontSize - left.style.fontSize ||
        left.feature.id.localeCompare(right.feature.id),
    );
  const occupied = createLabelCollisionIndex(padding);
  const result = new Map<string, MapLabelPlacement>();
  for (const candidate of candidates) {
    const { feature, style, layout, priority } = candidate;
    // 低缩放时保留区域、都城和高重要度玄幻地点，避免整张图被次要村镇
    // 和短路线名称覆盖。放大后所有显式标签仍会重新参与布局。
    if (zoom < 0.55 && priority < 4) {
      result.set(feature.id, {
        visible: false,
        layout,
        offsetX: 0,
        offsetY: 0,
      });
      continue;
    }
    if (zoom < 0.78 && priority < 2.5) {
      result.set(feature.id, {
        visible: false,
        layout,
        offsetX: 0,
        offsetY: 0,
      });
      continue;
    }
    const dimensions = getMapLabelTextDimensions(feature.name, style);
    const halfWidth = dimensions.width / 2;
    const halfHeight = dimensions.height / 2;
    const offsetCandidates: readonly [number, number][] = [
      [style.offsetX, style.offsetY],
      [style.offsetX, style.offsetY - style.fontSize * 1.35],
      [style.offsetX + halfWidth + padding, style.offsetY],
      [style.offsetX - halfWidth - padding, style.offsetY],
      [style.offsetX, style.offsetY + style.fontSize * 1.35],
    ];
    let placement: MapLabelPlacement | null = null;
    for (const [offsetX, offsetY] of offsetCandidates) {
      const anchor = {
        x: layout.anchor.x + offsetX,
        y: layout.anchor.y + offsetY,
      };
      const rect = {
        left: anchor.x - halfWidth,
        right: anchor.x + halfWidth,
        top: anchor.y - halfHeight,
        bottom: anchor.y + halfHeight,
      };
      if (occupied.intersects(rect)) continue;
      occupied.add(rect);
      placement = {
        visible: true,
        layout: { ...layout, anchor },
        offsetX: 0,
        offsetY: 0,
      };
      break;
    }
    result.set(
      feature.id,
      placement ?? { visible: false, layout, offsetX: 0, offsetY: 0 },
    );
  }
  return result;
}
