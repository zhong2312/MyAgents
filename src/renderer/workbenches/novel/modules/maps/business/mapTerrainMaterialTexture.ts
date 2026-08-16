import type { MapTerrainMaterial } from "../entities/mapSchema";

export type MapTerrainMaterialTextureSample = {
  /** 向材质细节色靠拢的强度，用来表现沟壑、林冠、裂隙等阴影结构。 */
  readonly detail: number;
  /** 向亮色靠拢的强度，用来表现沙脊、雪纹、水面或被风吹亮的表面。 */
  readonly highlight: number;
};

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

/**
 * 为地貌材质派生稳定、可缩放的图案强度。
 *
 * 坐标使用合成器栅格坐标，而不是屏幕坐标；因此同一份 `MapSceneStroke`
 * 在画布缩放、重新打开和 PNG 导出时都能获得相同的纹理结构。
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
    case "badlands":
      return badlandsTexture(x, y);
    case "tundra":
      return tundraTexture(x, y);
    case "snow":
      return snowTexture(x, y);
    case "swamp":
      return swampTexture(x, y);
    case "volcanic":
      return volcanicTexture(x, y);
  }
}
