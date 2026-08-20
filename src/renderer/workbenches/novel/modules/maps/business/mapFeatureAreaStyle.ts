import type { MapFeature } from "../entities/mapSchema";

export const DEFAULT_MAP_FREEFORM_AREA_PROPS = Object.freeze({
  color: "#8b6b4a",
  lineWidth: "2",
  fill: "#b26d45",
  fillOpacity: "0.25",
});

export type MapFeatureAreaStyle = {
  readonly fill: string;
  readonly opacity: number;
};

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const HEX_COLOR_WITH_ALPHA_PATTERN = /^#[0-9a-f]{8}$/iu;
const DEFAULT_FILL_OPACITY = Number(
  DEFAULT_MAP_FREEFORM_AREA_PROPS.fillOpacity,
);

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseOpacity(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampOpacity(parsed) : null;
}

/**
 * 普通画笔区域的填充样式只保存在 MapFeature.props。旧地图可以保留八位
 * 十六进制颜色中的 alpha，新地图则将颜色与透明度拆开保存，便于检查器编辑。
 */
export function getMapFeatureAreaStyle(
  feature: Pick<MapFeature, "props">,
): MapFeatureAreaStyle {
  const configuredFill = feature.props.fill?.trim();
  const configuredOpacity = parseOpacity(feature.props.fillOpacity);

  if (configuredFill && HEX_COLOR_WITH_ALPHA_PATTERN.test(configuredFill)) {
    return {
      fill: configuredFill.slice(0, 7),
      opacity:
        configuredOpacity ??
        Number.parseInt(configuredFill.slice(7, 9), 16) / 255,
    };
  }

  if (configuredFill && HEX_COLOR_PATTERN.test(configuredFill)) {
    return {
      fill: configuredFill,
      opacity: configuredOpacity ?? DEFAULT_FILL_OPACITY,
    };
  }

  if (configuredFill) {
    return {
      fill: configuredFill,
      // 非十六进制 CSS 颜色可能自带 alpha，未设置显式透明度时不再二次衰减。
      opacity: configuredOpacity ?? 1,
    };
  }

  return {
    fill: DEFAULT_MAP_FREEFORM_AREA_PROPS.fill,
    opacity: configuredOpacity ?? DEFAULT_FILL_OPACITY,
  };
}
