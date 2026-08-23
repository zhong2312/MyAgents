import type { MapFeature, MapScenePoint } from "../entities/mapSchema";

export const DEFAULT_MAP_RIVER_PROPS = Object.freeze({
  terrain: "river",
  color: "#3b83a5",
  bankColor: "#315d6c",
  highlightColor: "#c7edf1",
  lineWidth: "4",
  sourceWidth: "2",
  mouthWidth: "10",
  bankWidth: "1.7",
  showLabel: "true",
});

/** 路线外观选择“河流”时复用河流渲染，不改变路线本身的几何语义。 */
export const MAP_RIVER_ROUTE_APPEARANCE = "river" as const;

export interface MapRiverStyle {
  readonly color: string;
  readonly bankColor: string;
  readonly highlightColor: string;
  readonly sourceWidth: number;
  readonly mouthWidth: number;
  readonly bankWidth: number;
}

function finiteNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

export function isMapRiverFeature(feature: MapFeature): boolean {
  return (
    feature.kind === "route" &&
    (feature.props.terrain === "river" ||
      feature.props.terrain === "tributary" ||
      feature.props.terrain === "rapids")
  );
}

export function hasMapRiverAppearance(feature: MapFeature): boolean {
  return (
    isMapRiverFeature(feature) ||
    (feature.kind === "route" &&
      (feature.props.routeStyle === MAP_RIVER_ROUTE_APPEARANCE ||
        (feature.props.routeAppearance === MAP_RIVER_ROUTE_APPEARANCE &&
          !feature.props.routeStyle)))
  );
}

export function getMapRiverStyle(feature: MapFeature): MapRiverStyle {
  const baseWidth = finiteNumber(feature.props.lineWidth, 4, 1, 64);
  const sourceWidth = finiteNumber(
    feature.props.sourceWidth,
    Math.max(1, baseWidth * 0.55),
    0.5,
    64,
  );
  const mouthWidth = Math.max(
    sourceWidth,
    finiteNumber(
      feature.props.mouthWidth,
      Math.max(sourceWidth, baseWidth * 2.25),
      0.5,
      96,
    ),
  );
  return {
    color: feature.props.color ?? "#3b83a5",
    bankColor: feature.props.bankColor ?? "#315d6c",
    highlightColor: feature.props.highlightColor ?? "#c7edf1",
    sourceWidth,
    mouthWidth,
    bankWidth: finiteNumber(feature.props.bankWidth, 1.7, 0, 12),
  };
}

export function mapRiverWidthAt(
  style: Pick<MapRiverStyle, "sourceWidth" | "mouthWidth">,
  progress: number,
): number {
  const ratio = Math.max(0, Math.min(1, progress));
  const eased = ratio ** 0.72;
  return style.sourceWidth + (style.mouthWidth - style.sourceWidth) * eased;
}

/**
 * Cardinal spline with a restrained tangent. It keeps author control points as
 * the fact source while producing a natural watercourse for every renderer.
 */
export function smoothMapPath(
  points: readonly MapScenePoint[],
  maximumSamples = 256,
): MapScenePoint[] {
  const sampleLimit = Math.max(2, Math.floor(maximumSamples));
  const controlPoints: readonly MapScenePoint[] =
    points.length > sampleLimit
      ? Array.from({ length: sampleLimit }, (_, index) => {
          const sourceIndex = Math.round(
            (index * (points.length - 1)) / (sampleLimit - 1),
          );
          return points[sourceIndex]!;
        })
      : points;
  if (controlPoints.length <= 2)
    return controlPoints.map((point) => ({ ...point }));
  const segmentCount = controlPoints.length - 1;
  const stepsPerSegment = Math.max(
    1,
    Math.min(10, Math.floor((sampleLimit - 1) / segmentCount)),
  );
  const tangentScale = 0.34;
  const result: MapScenePoint[] = [];

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const p0 = controlPoints[Math.max(0, segment - 1)]!;
    const p1 = controlPoints[segment]!;
    const p2 = controlPoints[segment + 1]!;
    const p3 = controlPoints[Math.min(controlPoints.length - 1, segment + 2)]!;
    const tangent1 = {
      x: (p2.x - p0.x) * tangentScale,
      y: (p2.y - p0.y) * tangentScale,
    };
    const tangent2 = {
      x: (p3.x - p1.x) * tangentScale,
      y: (p3.y - p1.y) * tangentScale,
    };

    for (let step = 0; step < stepsPerSegment; step += 1) {
      const t = step / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      result.push({
        x: h00 * p1.x + h10 * tangent1.x + h01 * p2.x + h11 * tangent2.x,
        y: h00 * p1.y + h10 * tangent1.y + h01 * p2.y + h11 * tangent2.y,
      });
    }
  }
  result.push({ ...controlPoints[controlPoints.length - 1]! });
  return result;
}

export function reverseMapRiverFeature(feature: MapFeature): MapFeature {
  if (!isMapRiverFeature(feature)) return feature;
  return {
    ...feature,
    points: [...feature.points].reverse().map((point) => ({ ...point })),
  };
}
