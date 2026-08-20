import type { MapTerrainMaterial } from "../entities/mapSchema";

export type MapTerrainMaterialTextureSample = {
  /** 向材质细节色靠拢的强度，用来表现沟壑、林冠、裂隙等阴影结构。 */
  readonly detail: number;
  /** 向亮色靠拢的强度，用来表现沙脊、雪纹、水面或被风吹亮的表面。 */
  readonly highlight: number;
};

export type MapTerrainMaterialVisualProfile = {
  /** 材质细节色的最大混合强度。 */
  readonly detailStrength: number;
  /** 材质高光纹理的最大混合强度。 */
  readonly highlightStrength: number;
  /** 材质贴近其它材质或裸地时保留的最低覆盖比例。 */
  readonly edgeBlend: number;
};

const MATERIAL_VISUAL_PROFILES: Readonly<
  Record<MapTerrainMaterial, MapTerrainMaterialVisualProfile>
> = Object.freeze({
  grassland: { detailStrength: 0.78, highlightStrength: 0.72, edgeBlend: 0.42 },
  forest: { detailStrength: 0.96, highlightStrength: 0.62, edgeBlend: 0.52 },
  desert: { detailStrength: 0.88, highlightStrength: 0.98, edgeBlend: 0.6 },
  beach: { detailStrength: 0.64, highlightStrength: 0.92, edgeBlend: 0.78 },
  "gravel-beach": {
    detailStrength: 0.92,
    highlightStrength: 0.48,
    edgeBlend: 0.76,
  },
  "salt-flat": {
    detailStrength: 0.78,
    highlightStrength: 0.96,
    edgeBlend: 0.58,
  },
  badlands: { detailStrength: 1, highlightStrength: 0.72, edgeBlend: 0.7 },
  tundra: { detailStrength: 0.72, highlightStrength: 0.7, edgeBlend: 0.44 },
  snow: { detailStrength: 0.62, highlightStrength: 0.94, edgeBlend: 0.34 },
  "snow-cover": {
    detailStrength: 0.52,
    highlightStrength: 1,
    edgeBlend: 0.28,
  },
  swamp: { detailStrength: 0.84, highlightStrength: 0.58, edgeBlend: 0.46 },
  volcanic: { detailStrength: 1, highlightStrength: 0.65, edgeBlend: 0.76 },
  "volcanic-ash": {
    detailStrength: 0.9,
    highlightStrength: 0.4,
    edgeBlend: 0.72,
  },
  lava: { detailStrength: 0.95, highlightStrength: 0.86, edgeBlend: 0.82 },
  karst: { detailStrength: 0.88, highlightStrength: 0.68, edgeBlend: 0.62 },
  "shallow-sea": {
    detailStrength: 0.42,
    highlightStrength: 0.96,
    edgeBlend: 0.52,
  },
  "deep-sea": { detailStrength: 0.7, highlightStrength: 0.7, edgeBlend: 0.44 },
});

export function getMapTerrainMaterialVisualProfile(
  material: MapTerrainMaterial,
): MapTerrainMaterialVisualProfile {
  return MATERIAL_VISUAL_PROFILES[material];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function hash(x: number, y: number, salt: number): number {
  let value =
    (Math.floor(x) * 374_761_393 +
      Math.floor(y) * 668_265_263 +
      salt * 1_442_695_041) >>
    0;
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
}

function band(value: number, center: number, width: number): number {
  const distance = Math.abs(value - center);
  return clamp(1 - distance / Math.max(0.0001, width));
}

function ridge(value: number, threshold: number, softness: number): number {
  return clamp((value - threshold) / Math.max(0.0001, softness));
}

function grasslandTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const meadow = hash(x / 18, y / 14, 3);
  const blades = Math.sin(x * 0.46 + Math.sin(y * 0.16) * 1.9);
  const blade = ridge(blades, 0.84, 0.16) * (0.35 + meadow * 0.65);
  const lowland = ridge(hash(x / 42, y / 42, 7), 0.76, 0.24) * 0.24;
  return {
    detail: clamp(blade * 0.56 + lowland),
    highlight: ridge(Math.sin(x * 0.12 - y * 0.045), 0.86, 0.14) * 0.16,
  };
}

function forestTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const cellWidth = 19;
  const cellHeight = 17;
  const cellX = Math.floor(x / cellWidth);
  const cellY = Math.floor(y / cellHeight);
  const offsetX = 0.22 + hash(cellX, cellY, 11) * 0.56;
  const offsetY = 0.2 + hash(cellX, cellY, 13) * 0.58;
  const localX = positiveModulo(x, cellWidth) / cellWidth;
  const localY = positiveModulo(y, cellHeight) / cellHeight;
  const canopy = Math.hypot(localX - offsetX, localY - offsetY);
  const radius = 0.18 + hash(cellX, cellY, 17) * 0.16;
  const canopyShade = ridge(radius - canopy, 0, radius) * 0.82;
  const canopyRim = band(canopy, radius, 0.045) * 0.3;
  return {
    detail: clamp(canopyShade + canopyRim),
    highlight:
      ridge(hash(cellX, cellY, 23), 0.76, 0.24) *
      ridge(radius - canopy, radius * 0.36, radius * 0.28) *
      0.26,
  };
}

function desertTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const warpedY =
    y + Math.sin(x * 0.052) * 8 + Math.sin(x * 0.013 + y * 0.021) * 5;
  const wave = (Math.sin(warpedY * 0.235) + 1) / 2;
  const crest = ridge(wave, 0.87, 0.13);
  const trough = ridge(0.22 - wave, 0, 0.22);
  return {
    detail: clamp(trough * 0.52 + crest * 0.2),
    highlight: crest * 0.62,
  };
}

/**
 * 沙滩以细密、近似平行的潮痕为主，并混入少量贝壳和砾石颗粒。它与荒漠的
 * 大尺度风蚀沙丘分开，避免海岸材质放大后仍像内陆沙漠。
 */
function beachTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const tideY =
    y + Math.sin(x * 0.045) * 5 + Math.sin(x * 0.011 + y * 0.028) * 3;
  const tide = (Math.sin(tideY * 0.39) + 1) / 2;
  const ripple = ridge(tide, 0.91, 0.09);
  const pebbles = ridge(hash(x / 8, y / 8, 53), 0.965, 0.035);
  return {
    detail: clamp(ridge(0.17 - tide, 0, 0.17) * 0.31 + pebbles * 0.32),
    highlight: clamp(
      ripple * 0.52 + ridge(hash(x / 17, y / 17, 59), 0.985, 0.015) * 0.18,
    ),
  };
}

function gravelBeachTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const pebble = hash(x / 7, y / 7, 61);
  const wetness = (Math.sin(y * 0.18 + Math.sin(x * 0.03)) + 1) / 2;
  return {
    detail: ridge(pebble, 0.72, 0.28) * 0.86,
    highlight: ridge(wetness, 0.8, 0.2) * 0.36,
  };
}

function saltFlatTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const crack = Math.abs(
    Math.sin(x * 0.08 + Math.sin(y * 0.03)) *
      Math.sin(y * 0.11 - Math.sin(x * 0.04)),
  );
  return {
    detail: ridge(0.16 - crack, 0, 0.16) * 0.82,
    highlight: ridge(hash(x / 23, y / 23, 67), 0.7, 0.3) * 0.55,
  };
}

function badlandsTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const strata =
    (Math.sin(x * 0.13 - y * 0.17 + Math.sin(y * 0.047) * 1.8) + 1) / 2;
  const channel =
    (Math.sin(x * 0.041 + y * 0.22 + Math.sin(x * 0.09) * 1.5) + 1) / 2;
  return {
    detail: clamp(
      ridge(strata, 0.83, 0.17) * 0.58 + ridge(channel, 0.9, 0.1) * 0.28,
    ),
    highlight: ridge(0.17 - strata, 0, 0.17) * 0.34,
  };
}

function tundraTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const fold =
    (Math.sin(x * 0.11 + y * 0.045) + Math.sin(y * 0.14 - x * 0.032) + 2) / 4;
  const frost = hash(x / 23, y / 19, 29);
  return {
    detail: clamp(
      ridge(fold, 0.81, 0.19) * 0.42 + ridge(frost, 0.82, 0.18) * 0.22,
    ),
    highlight: ridge(0.18 - fold, 0, 0.18) * 0.24,
  };
}

function snowTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const drift =
    (Math.sin((y + x * 0.28 + Math.sin(x * 0.06) * 7) * 0.21) + 1) / 2;
  const sparkle = hash(x / 11, y / 11, 31);
  return {
    detail: ridge(0.19 - drift, 0, 0.19) * 0.22,
    highlight: clamp(
      ridge(drift, 0.9, 0.1) * 0.38 + ridge(sparkle, 0.975, 0.025) * 0.34,
    ),
  };
}

function snowCoverTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const drift =
    (Math.sin((y + x * 0.42 + Math.sin(x * 0.04) * 11) * 0.16) + 1) / 2;
  return {
    detail: ridge(0.22 - drift, 0, 0.22) * 0.18,
    highlight: ridge(drift, 0.72, 0.28) * 0.82,
  };
}

function swampTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const cellWidth = 31;
  const cellHeight = 24;
  const cellX = Math.floor(x / cellWidth);
  const cellY = Math.floor(y / cellHeight);
  const localX = positiveModulo(x, cellWidth) / cellWidth;
  const localY = positiveModulo(y, cellHeight) / cellHeight;
  const poolX = 0.25 + hash(cellX, cellY, 37) * 0.5;
  const poolY = 0.28 + hash(cellX, cellY, 41) * 0.42;
  const pool = Math.hypot((localX - poolX) * 0.82, localY - poolY);
  const reeds = ridge(Math.sin(x * 0.72 + Math.sin(y * 0.18)), 0.93, 0.07);
  return {
    detail: clamp(ridge(0.31 - pool, 0, 0.31) * 0.72 + reeds * 0.22),
    highlight: band(pool, 0.26, 0.045) * 0.3,
  };
}

function volcanicTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const fractureA = Math.abs(
    Math.sin(x * 0.17 + y * 0.071 + Math.sin(y * 0.04)),
  );
  const fractureB = Math.abs(Math.sin(x * 0.048 - y * 0.21));
  const crack = ridge(0.09 - Math.min(fractureA, fractureB), 0, 0.09);
  const rock = hash(x / 15, y / 15, 43);
  return {
    detail: clamp(crack * 0.88 + ridge(rock, 0.8, 0.2) * 0.26),
    highlight: ridge(hash(x / 33, y / 33, 47), 0.93, 0.07) * 0.2,
  };
}

function volcanicAshTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const ash = hash(x / 12, y / 12, 71);
  const gust = (Math.sin(x * 0.09 + y * 0.04) + 1) / 2;
  return {
    detail: ridge(ash, 0.66, 0.34) * 0.62,
    highlight: ridge(gust, 0.9, 0.1) * 0.15,
  };
}

function lavaTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const crack = Math.min(
    Math.abs(Math.sin(x * 0.14 + y * 0.07)),
    Math.abs(Math.sin(x * 0.05 - y * 0.19)),
  );
  const heat = hash(x / 25, y / 25, 73);
  return {
    detail: ridge(0.12 - crack, 0, 0.12) * 0.92,
    highlight: ridge(heat, 0.82, 0.18) * 0.62,
  };
}

function karstTexture(x: number, y: number): MapTerrainMaterialTextureSample {
  const sinkhole = hash(x / 17, y / 17, 79);
  const ridgeBand = (Math.sin(x * 0.12 + y * 0.08) + 1) / 2;
  return {
    detail: ridge(sinkhole, 0.76, 0.24) * 0.58,
    highlight: ridge(ridgeBand, 0.84, 0.16) * 0.3,
  };
}

function shallowSeaTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const wave = (Math.sin(y * 0.18 + x * 0.035) + 1) / 2;
  return {
    detail: ridge(0.18 - wave, 0, 0.18) * 0.2,
    highlight: ridge(wave, 0.78, 0.22) * 0.82,
  };
}

function deepSeaTexture(
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  const current = (Math.sin(x * 0.05 - y * 0.09) + 1) / 2;
  return {
    detail: ridge(0.23 - current, 0, 0.23) * 0.42,
    highlight: ridge(current, 0.88, 0.12) * 0.42,
  };
}

/**
 * 为地貌材质派生稳定、可缩放的图案强度。
 *
 * 坐标使用地图世界坐标，而不是屏幕或下采样栅格坐标；因此同一份
 * `MapSceneStroke` 在画布缩放、自动扩展、重新打开和 PNG 导出时都能获得
 * 相同的纹理结构。
 */
export function sampleMapTerrainMaterialTexture(
  material: MapTerrainMaterial,
  x: number,
  y: number,
): MapTerrainMaterialTextureSample {
  switch (material) {
    case "grassland":
      return grasslandTexture(x, y);
    case "forest":
      return forestTexture(x, y);
    case "desert":
      return desertTexture(x, y);
    case "beach":
      return beachTexture(x, y);
    case "gravel-beach":
      return gravelBeachTexture(x, y);
    case "salt-flat":
      return saltFlatTexture(x, y);
    case "badlands":
      return badlandsTexture(x, y);
    case "tundra":
      return tundraTexture(x, y);
    case "snow":
      return snowTexture(x, y);
    case "snow-cover":
      return snowCoverTexture(x, y);
    case "swamp":
      return swampTexture(x, y);
    case "volcanic":
      return volcanicTexture(x, y);
    case "volcanic-ash":
      return volcanicAshTexture(x, y);
    case "lava":
      return lavaTexture(x, y);
    case "karst":
      return karstTexture(x, y);
    case "shallow-sea":
      return shallowSeaTexture(x, y);
    case "deep-sea":
      return deepSeaTexture(x, y);
  }
}
