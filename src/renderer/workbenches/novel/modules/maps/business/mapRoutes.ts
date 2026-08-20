import { isMapRiverFeature } from "./mapHydrography";
import type { MapFeature } from "../entities/mapSchema";

export const MAP_ROUTE_STYLE_OPTIONS = Object.freeze([
  { id: "plain", name: "普通线" },
  { id: "road", name: "土石道路" },
  { id: "paved", name: "石板大道" },
  { id: "trail", name: "林间小径" },
  { id: "wall", name: "城墙防线" },
  { id: "border", name: "疆域边界" },
  { id: "bank", name: "河岸线" },
  { id: "fjord", name: "峡湾" },
  { id: "bay", name: "港湾" },
  { id: "undercurrent", name: "暗流" },
  { id: "ice", name: "海冰" },
  { id: "dirt", name: "土路" },
  { id: "trade", name: "商路" },
  { id: "mountain-pass", name: "山道" },
  { id: "boardwalk", name: "栈道" },
  { id: "canal", name: "运河" },
  { id: "railway", name: "铁路" },
  { id: "magic-rail", name: "魔导轨道" },
  { id: "ley-line", name: "灵脉" },
  { id: "rift", name: "裂谷" },
  { id: "canyon", name: "峡谷" },
  { id: "magic-rift", name: "魔法裂隙" },
  { id: "current", name: "洋流" },
  { id: "sea-route", name: "航线" },
  { id: "stellar-route", name: "星际航线" },
  { id: "contour", name: "等高线" },
  { id: "bathymetric", name: "海图水深线" },
  { id: "fog-wall", name: "雾墙" },
  { id: "barrier", name: "结界" },
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
    bank: {
      id: "bank",
      color: "#4a8690",
      casingColor: "#2f5962",
      width: 4,
      casingWidth: 1.2,
      dash: null,
      decoration: "none",
    },
    fjord: {
      id: "fjord",
      color: "#4f8192",
      casingColor: "#2b5665",
      width: 10,
      casingWidth: 1.8,
      dash: null,
      decoration: "none",
    },
    bay: {
      id: "bay",
      color: "#578da0",
      casingColor: "#315f70",
      width: 8,
      casingWidth: 1.4,
      dash: null,
      decoration: "none",
    },
    undercurrent: {
      id: "undercurrent",
      color: "#3f718e",
      casingColor: "#284c66",
      width: 3,
      casingWidth: 0,
      dash: [3, 8],
      decoration: "none",
    },
    ice: {
      id: "ice",
      color: "#a6d2d8",
      casingColor: "#4a7f8c",
      width: 7,
      casingWidth: 1.2,
      dash: [10, 4],
      decoration: "none",
    },
    dirt: {
      id: "dirt",
      color: "#a8845d",
      casingColor: "#674934",
      width: 5,
      casingWidth: 1.2,
      dash: [2, 5],
      decoration: "none",
    },
    trade: {
      id: "trade",
      color: "#bd8150",
      casingColor: "#6d4838",
      width: 6,
      casingWidth: 1.5,
      dash: [12, 4],
      decoration: "stones",
    },
    "mountain-pass": {
      id: "mountain-pass",
      color: "#806b58",
      casingColor: "#4f4035",
      width: 4,
      casingWidth: 1,
      dash: [8, 5],
      decoration: "none",
    },
    boardwalk: {
      id: "boardwalk",
      color: "#9b754f",
      casingColor: "#5c422f",
      width: 5,
      casingWidth: 1.1,
      dash: [1, 7],
      decoration: "stones",
    },
    canal: {
      id: "canal",
      color: "#538b98",
      casingColor: "#315e6a",
      width: 8,
      casingWidth: 1.2,
      dash: null,
      decoration: "none",
    },
    railway: {
      id: "railway",
      color: "#6b6662",
      casingColor: "#343231",
      width: 5,
      casingWidth: 1.5,
      dash: [2, 6],
      decoration: "none",
    },
    "magic-rail": {
      id: "magic-rail",
      color: "#806ac1",
      casingColor: "#44376e",
      width: 5,
      casingWidth: 1.5,
      dash: [4, 4],
      decoration: "none",
    },
    "ley-line": {
      id: "ley-line",
      color: "#9c65bd",
      casingColor: "#563d70",
      width: 3,
      casingWidth: 0,
      dash: [2, 7],
      decoration: "none",
    },
    rift: {
      id: "rift",
      color: "#6d4b42",
      casingColor: "#3f2d2b",
      width: 3,
      casingWidth: 0,
      dash: [5, 5],
      decoration: "none",
    },
    canyon: {
      id: "canyon",
      color: "#8c6044",
      casingColor: "#50382d",
      width: 4,
      casingWidth: 1,
      dash: null,
      decoration: "none",
    },
    "magic-rift": {
      id: "magic-rift",
      color: "#a85ac4",
      casingColor: "#56316e",
      width: 4,
      casingWidth: 1,
      dash: [2, 6],
      decoration: "none",
    },
    current: {
      id: "current",
      color: "#8bbfd2",
      casingColor: "#416f83",
      width: 2,
      casingWidth: 0,
      dash: [11, 7],
      decoration: "none",
    },
    "sea-route": {
      id: "sea-route",
      color: "#6b9eb5",
      casingColor: "#365a6e",
      width: 3,
      casingWidth: 0,
      dash: [8, 8],
      decoration: "none",
    },
    "stellar-route": {
      id: "stellar-route",
      color: "#9caed1",
      casingColor: "#4e5879",
      width: 3,
      casingWidth: 0,
      dash: [4, 8],
      decoration: "none",
    },
    contour: {
      id: "contour",
      color: "#887b63",
      casingColor: "#887b63",
      width: 1.5,
      casingWidth: 0,
      dash: [6, 6],
      decoration: "none",
    },
    bathymetric: {
      id: "bathymetric",
      color: "#648e9a",
      casingColor: "#648e9a",
      width: 1.5,
      casingWidth: 0,
      dash: [4, 6],
      decoration: "none",
    },
    "fog-wall": {
      id: "fog-wall",
      color: "#7d8b8b",
      casingColor: "#4d5e61",
      width: 12,
      casingWidth: 2,
      dash: [2, 9],
      decoration: "none",
    },
    barrier: {
      id: "barrier",
      color: "#7f72c2",
      casingColor: "#4d407d",
      width: 4,
      casingWidth: 1,
      dash: [9, 4],
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
  const terrainAlias = MAP_ROUTE_STYLE_OPTIONS.find(
    (option) => option.id === feature.props.terrain,
  );
  if (terrainAlias) return terrainAlias.id;
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
