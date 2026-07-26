import type { Formation } from "../../../shared/novel-cultivation-ecology-schema";

// Preset colors are editable formation artwork data, not application-shell theme tokens.

export type FormationBackdropLayer =
  Formation["design"]["backdropLayers"][number];
export type FormationBackdropPresetId = Exclude<
  Formation["design"]["presetId"],
  "custom"
>;

export const FORMATION_BASE_CANVAS_SIZE = 1000;
export const FORMATION_MAX_RADIUS = 1000;

type LayerSeed = Omit<FormationBackdropLayer, "id" | "order">;

type FormationBackdropPreset = {
  id: FormationBackdropPresetId;
  name: string;
  description: string;
  backgroundColor: string;
  palette: Formation["design"]["palette"];
  effects: Formation["design"]["effects"];
  layers: readonly LayerSeed[];
};

const COMMON_LAYER: Pick<
  FormationBackdropLayer,
  | "innerRadius"
  | "count"
  | "spacing"
  | "sides"
  | "step"
  | "innerRatio"
  | "curvature"
  | "symbol"
  | "text"
  | "repeat"
  | "rotation"
  | "rotating"
  | "strokeWidth"
  | "opacity"
  | "visible"
> = {
  innerRadius: 80,
  count: 1,
  spacing: 10,
  sides: 6,
  step: 1,
  innerRatio: 0.5,
  curvature: 0.65,
  symbol: "diamond",
  text: "",
  repeat: 4,
  rotation: 0,
  rotating: false,
  strokeWidth: 1.5,
  opacity: 0.72,
  visible: true,
};

function layer(
  value: Partial<LayerSeed> &
    Pick<LayerSeed, "name" | "type" | "radius" | "color" | "secondaryColor">,
): LayerSeed {
  return { ...COMMON_LAYER, ...value };
}

export const FORMATION_BACKDROP_PRESETS: readonly FormationBackdropPreset[] = [
  {
    id: "classic",
    name: "经典",
    description: "同心阵环、六方阵格与中央阵印",
    backgroundColor: "#08070b",
    palette: {
      primary: "#d9b86c",
      secondary: "#74aab7",
      accent: "#b96c62",
      glow: "#f2d791",
    },
    effects: { glowStrength: 0.45, lineOpacity: 0.72, motion: "still" },
    layers: [
      layer({
        name: "十二方位",
        type: "radial-rays",
        radius: 448,
        innerRadius: 78,
        count: 12,
        color: "#cdb983",
        secondaryColor: "#74aab7",
        opacity: 0.24,
        strokeWidth: 1,
      }),
      layer({
        name: "六合阵界",
        type: "polygon",
        radius: 386,
        sides: 6,
        color: "#cdb983",
        secondaryColor: "#74aab7",
        opacity: 0.3,
      }),
      layer({
        name: "天地交泰",
        type: "polygon",
        radius: 270,
        sides: 6,
        step: 2,
        color: "#74aab7",
        secondaryColor: "#b96c62",
        opacity: 0.36,
      }),
      layer({
        name: "归元印",
        type: "core-symbol",
        radius: 70,
        symbol: "seal",
        color: "#d9c98f",
        secondaryColor: "#b96c62",
        opacity: 0.82,
      }),
    ],
  },
  {
    id: "emerald-eye",
    name: "魔眼",
    description: "符文回路、灵视之眼与瞳孔放射纹",
    backgroundColor: "#07100d",
    palette: {
      primary: "#35f486",
      secondary: "#7dffbd",
      accent: "#18b968",
      glow: "#52ff9d",
    },
    effects: { glowStrength: 0.78, lineOpacity: 0.9, motion: "pulse" },
    layers: [
      layer({
        name: "三重界环",
        type: "ring",
        radius: 442,
        count: 3,
        spacing: 14,
        color: "#35f486",
        secondaryColor: "#7dffbd",
        opacity: 0.92,
        strokeWidth: 2,
      }),
      layer({
        name: "外道回路",
        type: "ornament-ring",
        radius: 414,
        count: 24,
        symbol: "circuit",
        color: "#35f486",
        secondaryColor: "#7dffbd",
        opacity: 0.88,
        strokeWidth: 2.2,
      }),
      layer({
        name: "灵视铭文",
        type: "rune-band",
        radius: 354,
        text: "灵视洞玄 · 因果显影 · 真妄皆明 · ",
        repeat: 4,
        color: "#7dffbd",
        secondaryColor: "#35f486",
        opacity: 0.84,
      }),
      layer({
        name: "天目轮廓",
        type: "core-symbol",
        radius: 254,
        symbol: "eye",
        color: "#35f486",
        secondaryColor: "#7dffbd",
        opacity: 0.96,
        strokeWidth: 2.8,
      }),
      layer({
        name: "瞳光放射",
        type: "radial-rays",
        radius: 176,
        innerRadius: 44,
        count: 40,
        color: "#35f486",
        secondaryColor: "#7dffbd",
        opacity: 0.68,
        strokeWidth: 1.15,
      }),
      layer({
        name: "双极晶锚",
        type: "ornament-ring",
        radius: 378,
        count: 2,
        symbol: "crystal",
        rotation: 90,
        color: "#7dffbd",
        secondaryColor: "#35f486",
        opacity: 0.94,
        strokeWidth: 2,
      }),
    ],
  },
  {
    id: "ember-star",
    name: "星盘",
    description: "方形阵基、多重星芒与赤焰符文环",
    backgroundColor: "#110b08",
    palette: {
      primary: "#ff783d",
      secondary: "#ffc07a",
      accent: "#d94a22",
      glow: "#ff9b62",
    },
    effects: { glowStrength: 0.72, lineOpacity: 0.9, motion: "still" },
    layers: [
      layer({
        name: "赤焰界环",
        type: "ring",
        radius: 440,
        count: 3,
        spacing: 13,
        color: "#ff783d",
        secondaryColor: "#ffc07a",
        opacity: 0.94,
        strokeWidth: 2,
      }),
      layer({
        name: "炎文回路",
        type: "ornament-ring",
        radius: 410,
        count: 20,
        symbol: "circuit",
        color: "#ff783d",
        secondaryColor: "#ffc07a",
        opacity: 0.86,
        strokeWidth: 2,
      }),
      layer({
        name: "焚界铭文",
        type: "rune-band",
        radius: 350,
        text: "赤曜临天 · 炎轮归序 · 焚尽诸妄 · ",
        repeat: 4,
        color: "#ffc07a",
        secondaryColor: "#ff783d",
        opacity: 0.82,
      }),
      layer({
        name: "四象阵基",
        type: "polygon",
        radius: 250,
        sides: 4,
        rotation: 45,
        color: "#ffc07a",
        secondaryColor: "#ff783d",
        opacity: 0.76,
        strokeWidth: 2,
      }),
      layer({
        name: "十二曜星",
        type: "star",
        radius: 246,
        count: 12,
        innerRatio: 0.64,
        color: "#ff783d",
        secondaryColor: "#ffc07a",
        opacity: 0.82,
        strokeWidth: 1.8,
      }),
      layer({
        name: "内景星核",
        type: "star",
        radius: 104,
        count: 10,
        innerRatio: 0.62,
        color: "#ffc07a",
        secondaryColor: "#ff783d",
        opacity: 0.66,
      }),
      layer({
        name: "炎心阵印",
        type: "core-symbol",
        radius: 72,
        symbol: "seal",
        color: "#ff783d",
        secondaryColor: "#ffc07a",
        opacity: 0.9,
      }),
    ],
  },
  {
    id: "azure-gates",
    name: "八门",
    description: "八方门钉、交叠弧阵与中央六芒星",
    backgroundColor: "#071019",
    palette: {
      primary: "#54bfff",
      secondary: "#b5e4ff",
      accent: "#3888ca",
      glow: "#78cbff",
    },
    effects: { glowStrength: 0.74, lineOpacity: 0.88, motion: "still" },
    layers: [
      layer({
        name: "苍穹界环",
        type: "ring",
        radius: 420,
        count: 3,
        spacing: 15,
        color: "#54bfff",
        secondaryColor: "#b5e4ff",
        opacity: 0.9,
        strokeWidth: 2,
        rotating: true,
      }),
      layer({
        name: "八门镇钉",
        type: "ornament-ring",
        radius: 450,
        count: 8,
        symbol: "gate",
        color: "#54bfff",
        secondaryColor: "#b5e4ff",
        opacity: 0.92,
        strokeWidth: 2.2,
        rotating: true,
      }),
      layer({
        name: "八门符序",
        type: "ornament-ring",
        radius: 385,
        count: 16,
        symbol: "circuit",
        color: "#54bfff",
        secondaryColor: "#b5e4ff",
        opacity: 0.76,
        rotating: true,
      }),
      layer({
        name: "周天铭文",
        type: "rune-band",
        radius: 335,
        text: "休生伤杜 · 景死惊开 · 八门归位 · ",
        repeat: 4,
        color: "#b5e4ff",
        secondaryColor: "#54bfff",
        opacity: 0.8,
        rotating: true,
      }),
      layer({
        name: "交叠弧阵",
        type: "arc-petals",
        radius: 280,
        count: 4,
        curvature: 0.52,
        color: "#54bfff",
        secondaryColor: "#b5e4ff",
        opacity: 0.78,
        strokeWidth: 1.8,
        rotating: true,
      }),
      layer({
        name: "六芒阵心",
        type: "polygon",
        radius: 130,
        sides: 6,
        step: 2,
        color: "#b5e4ff",
        secondaryColor: "#54bfff",
        opacity: 0.9,
        strokeWidth: 2,
        rotating: true,
      }),
      layer({
        name: "虚空核心",
        type: "core-symbol",
        radius: 62,
        symbol: "void",
        color: "#54bfff",
        secondaryColor: "#b5e4ff",
        opacity: 0.84,
        rotating: true,
      }),
    ],
  },
] as const;

export function getFormationCanvasSize(design: Formation["design"]) {
  const backdropExtent = design.backdropLayers.reduce((maximum, layer) => {
    const repeatedRingExtent =
      layer.type === "ring"
        ? Math.min(
            FORMATION_MAX_RADIUS,
            layer.radius + ((Math.max(1, layer.count) - 1) * layer.spacing) / 2,
          )
        : layer.radius;
    return Math.max(maximum, repeatedRingExtent);
  }, 0);
  const ringExtent = design.rings.reduce(
    (maximum, ring) =>
      Math.max(maximum, ring.radius + (ring.style === "double" ? 8 : 0)),
    0,
  );
  const requiredDiameter = (Math.max(backdropExtent, ringExtent) + 40) * 2;
  return Math.max(
    FORMATION_BASE_CANVAS_SIZE,
    Math.ceil(requiredDiameter / 40) * 40,
  );
}

export const FORMATION_BACKDROP_PRESET_OPTIONS = [
  ...FORMATION_BACKDROP_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.name,
  })),
  { value: "custom", label: "自定义" },
] as const;

export const FORMATION_BACKDROP_LAYER_LABELS: Record<
  FormationBackdropLayer["type"],
  string
> = {
  ring: "阵环",
  "rune-band": "铭文",
  polygon: "多边",
  star: "星芒",
  "radial-rays": "放射",
  "arc-petals": "弧阵",
  "ornament-ring": "饰环",
  "core-symbol": "阵心",
};

export const FORMATION_BACKDROP_LAYER_TYPE_OPTIONS = Object.entries(
  FORMATION_BACKDROP_LAYER_LABELS,
).map(([value, label]) => ({ value, label }));

export const FORMATION_BACKDROP_SYMBOL_OPTIONS = [
  { value: "circuit", label: "回路" },
  { value: "crystal", label: "晶体" },
  { value: "gate", label: "门钉" },
  { value: "diamond", label: "菱印" },
  { value: "eye", label: "魔眼" },
  { value: "star", label: "星核" },
  { value: "seal", label: "阵印" },
  { value: "void", label: "虚空" },
] as const;

export function createFormationBackdropPreset(
  presetId: FormationBackdropPresetId,
  makeId: (index: number) => string,
): Pick<
  Formation["design"],
  "presetId" | "backgroundColor" | "palette" | "effects" | "backdropLayers"
> {
  const preset =
    FORMATION_BACKDROP_PRESETS.find((item) => item.id === presetId) ??
    FORMATION_BACKDROP_PRESETS[0];
  return {
    presetId: preset.id,
    backgroundColor: preset.backgroundColor,
    palette: { ...preset.palette },
    effects: { ...preset.effects },
    backdropLayers: preset.layers.map((item, index) => ({
      ...item,
      id: makeId(index),
      order: index,
    })),
  };
}

export function createDefaultFormationBackdropLayer(
  type: FormationBackdropLayer["type"],
  id: string,
  order: number,
  palette: Formation["design"]["palette"],
): FormationBackdropLayer {
  const names = FORMATION_BACKDROP_LAYER_LABELS;
  return {
    ...COMMON_LAYER,
    id,
    name: `新${names[type]}`,
    type,
    radius: type === "core-symbol" ? 72 : 320,
    color: palette.primary,
    secondaryColor: palette.secondary,
    order,
  };
}
