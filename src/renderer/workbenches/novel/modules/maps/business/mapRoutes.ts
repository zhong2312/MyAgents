import { isMapRiverFeature } from "./mapHydrography";
import type { MapFeature } from "../entities/mapSchema";

export const MAP_ROUTE_STYLE_OPTIONS = Object.freeze([
  { id: "plain", name: "普通线" },
  { id: "road", name: "土石道路" },
  { id: "paved", name: "石板大道" },
  { id: "trail", name: "林间小径" },
  { id: "wall", name: "城墙防线" },
  { id: "border", name: "疆域边界" },
] as const);

export type MapRouteStyleId = (typeof MAP_ROUTE_STYLE_OPTIONS)[number]["id"];

export type MapRouteStyle = {
  readonly id: MapRouteStyleId;
  readonly color: string;
  readonly casingColor: string;
  readonly width: number;
  readonly casingWidth: number;
  readonly dash: readonly number[] | null;
  readonly decoration: "none" | "stones" | "wall";
};

export type MapRouteStrokeLayer = {
  readonly color: string;
  readonly width: number;
  readonly dash: readonly number[] | null;
};

type RouteStyleBase = Omit<MapRouteStyle, "width" | "color" | "casingColor"> & {
  readonly width: number;
  readonly color: string;
  readonly casingColor: string;
};

const ROUTE_STYLE_BASES: Readonly<Record<MapRouteStyleId, RouteStyleBase>> =
  Object.freeze({
    plain: {
      id: "plain",
      color: "#8b6b4a",
      casingColor: "#8b6b4a",
      width: 2,
      casingWidth: 0,
      dash: null,
      decoration: "none",
    },
    road: {
      id: "road",
      color: "#c49a69",
      casingColor: "#654934",
      width: 7,
      casingWidth: 2.2,
      dash: null,
      decoration: "stones",
    },
    paved: {
      id: "paved",
      color: "#c7bbab",
      casingColor: "#4f4b46",
      width: 10,
      casingWidth: 2.5,
      dash: null,
      decoration: "stones",
    },
    trail: {
      id: "trail",
      color: "#a2784f",
      casingColor: "#5e432f",
      width: 4,
      casingWidth: 1.2,
      dash: [2, 4],
      decoration: "none",
    },
    wall: {
      id: "wall",
      color: "#a59780",
      casingColor: "#3c3630",
      width: 10,
      casingWidth: 2.8,
      dash: null,
      decoration: "wall",
    },
    border: {
      id: "border",
      color: "#a74742",
      casingColor: "#a74742",
      width: 2.5,
      casingWidth: 0,
      dash: [12, 8],
      decoration: "none",
    },
  });

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

function routeStyleId(feature: MapFeature): MapRouteStyleId {
  const explicit = MAP_ROUTE_STYLE_OPTIONS.find(
    (option) => option.id === feature.props.routeStyle,
  );
  if (explicit) return explicit.id;
  if (feature.props.terrain === "road") return "road";
  if (feature.props.terrain === "border") return "border";
  if (feature.props.terrain === "wall") return "wall";
  return "plain";
}

export function getMapRouteStyle(feature: MapFeature): MapRouteStyle | null {
  if (feature.kind !== "route" || isMapRiverFeature(feature)) return null;
  const base = ROUTE_STYLE_BASES[routeStyleId(feature)];
  const customWidth =
    base.id === "plain" ? feature.props.lineWidth : feature.props.routeWidth;
  return {
    ...base,
    width: finiteNumber(customWidth, base.width, 1, 64),
    color: color(
      base.id === "plain" ? feature.props.color : feature.props.routeColor,
      base.color,
    ),
    casingColor: color(feature.props.routeCasingColor, base.casingColor),
  };
}

export function isMapStyledRoute(feature: MapFeature): boolean {
  const style = getMapRouteStyle(feature);
  return style !== null && style.id !== "plain";
}

export function mapRouteStrokeLayers(
  style: MapRouteStyle,
): readonly MapRouteStrokeLayer[] {
  const layers: MapRouteStrokeLayer[] = [];
  if (style.casingWidth > 0) {
    layers.push({
      color: style.casingColor,
      width: style.width + style.casingWidth * 2,
      dash: null,
    });
  }
  layers.push({
    color: style.color,
    width: style.width,
    dash: style.dash,
  });
  return layers;
}
