import type { MapSceneRegionTexture } from "../entities/mapSchema";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function noise(x: number, y: number): number {
  let value = (Math.floor(x) * 374_761_393 + Math.floor(y) * 668_265_263) >>> 0;
  value = (value ^ (value >>> 13)) * 1_274_126_177;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
}

function fade(value: number): number {
  return value * value * (3 - 2 * value);
}

function smoothNoise(
  x: number,
  y: number,
  scale: number,
  salt: number,
): number {
  const scaledX = x / scale + salt * 17.13;
  const scaledY = y / scale - salt * 11.71;
  const left = Math.floor(scaledX);
  const top = Math.floor(scaledY);
  const horizontal = fade(scaledX - left);
  const vertical = fade(scaledY - top);
  const topLeft = noise(left, top);
  const topRight = noise(left + 1, top);
  const bottomLeft = noise(left, top + 1);
  const bottomRight = noise(left + 1, top + 1);
  const topValue = topLeft + (topRight - topLeft) * horizontal;
  const bottomValue = bottomLeft + (bottomRight - bottomLeft) * horizontal;
  return topValue + (bottomValue - topValue) * vertical;
}

/**
 * 返回区域材质的稳定明暗变化。它只依赖地图坐标，所以缩放、重绘和导出
 * 始终得到同一张纸纤维或波纹，而不需要把任何纹理像素写回地图数据。
 */
export function mapRegionTextureVariation(
  texture: MapSceneRegionTexture,
  x: number,
  y: number,
): number {
  if (texture === "paper-land") {
    // 纸纤维是低频纸浆斑驳叠加各向异性的细颗粒，不应使用连续正弦线，
    // 否则陆地会像水面一样出现规则横向波纹。
    const pulp = (smoothNoise(x, y, 54, 1) - 0.5) * 0.36;
    const grain = (smoothNoise(x, y, 13, 2) - 0.5) * 0.16;
    const fibre =
      (noise(x / 4.8 + 43, y / 21.7 - 19) - 0.5) * 0.075 +
      (noise(x / 18.4 - 7, y / 5.6 + 31) - 0.5) * 0.045;
    const fleck = noise(x / 2.7 + 17, y / 2.7 - 11) > 0.992 ? -0.2 : 0;
    return clamp(pulp + grain + fibre + fleck, -0.42, 0.42);
  }

  if (texture === "territory-hatch") {
    const diagonal = Math.sin((x + y) * 0.16);
    const crossDiagonal = Math.sin((x - y) * 0.11);
    const hatch = Math.max(
      Math.abs(diagonal) > 0.9 ? 0.22 : 0,
      Math.abs(crossDiagonal) > 0.94 ? -0.14 : 0,
    );
    return hatch;
  }

  if (texture === "administrative-grid") {
    const vertical = Math.abs(Math.sin(x * 0.075));
    const horizontal = Math.abs(Math.sin(y * 0.075));
    const intersections = Math.min(vertical, horizontal);
    return clamp(
      (vertical > 0.94 ? 0.16 : 0) +
        (horizontal > 0.94 ? 0.12 : 0) -
        (intersections > 0.985 ? 0.08 : 0),
      -0.22,
      0.28,
    );
  }

  if (texture === "stellar-domain") {
    const nebula = smoothNoise(x, y, 72, 17);
    const star = noise(x / 5.2 + 31, y / 5.2 - 11) > 0.992 ? 0.3 : 0;
    return clamp((nebula - 0.48) * 0.45 + star, -0.28, 0.38);
  }

  const wave = Math.sin(y * 0.34 + Math.sin(x * 0.05) * 1.7);
  const crossWave = Math.sin(y * 0.82 - x * 0.037);
  if (wave > 0.89 && crossWave > -0.22) {
    return clamp((wave - 0.89) * 7.2 + 0.18, 0, 1);
  }
  return 0;
}
