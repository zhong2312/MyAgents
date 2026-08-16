import type { MapProjectionType } from "../entities/mapSchema";

export type MapRendererKind = "geographic" | "topology";

export function mapRendererForProjection(
  projectionType: MapProjectionType,
): MapRendererKind {
  return projectionType === "continent" || projectionType === "planet"
    ? "geographic"
    : "topology";
}
