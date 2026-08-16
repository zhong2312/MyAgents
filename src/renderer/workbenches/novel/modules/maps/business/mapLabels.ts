import { isMapRiverFeature, smoothMapPath } from "./mapHydrography";
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
};

export type MapLabelLayout = {
  readonly anchor: MapScenePoint;
  /** 只包含路径方向；作者设置的旋转角度由渲染器叠加。 */
  readonly pathRotation: number;
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

function defaultStyle(feature: MapFeature): Omit<MapLabelStyle, "fontFamily"> {
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
  if (feature.kind === "polygon" || feature.kind === "area") {
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
  if (feature.kind === "polygon") {
    return { anchor: polygonCentroid(points), pathRotation: 0 };
  }
  if (feature.kind === "area") {
    return { anchor: points[0] ?? { x: 0, y: 0 }, pathRotation: 0 };
  }
  return { anchor: points[0] ?? { x: 0, y: 0 }, pathRotation: 0 };
}
