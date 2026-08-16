import type {
  MapScenePoint,
  MapTerrainBrushShape,
} from "../entities/mapSchema";

export type MapTerrainBrushInput = {
  readonly id: string;
  readonly points: readonly MapScenePoint[];
  readonly width: number;
  readonly spacing: number;
  readonly shape: MapTerrainBrushShape;
};

export type MapTerrainBrushDab = {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
};

/** 连续素材笔刷派生的单次盖印；它是从笔触事实重建的，不写进地图 JSON。 */
export type MapArtworkBrushDab = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
  readonly index: number;
};

function hashText(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function unitNoise(seed: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 2_246_822_519);
  value ^= value >>> 13;
  value = Math.imul(value, 3_266_489_917);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_295;
}

function distance(a: MapScenePoint, b: MapScenePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samplePath(
  points: readonly MapScenePoint[],
  spacing: number,
): MapScenePoint[] {
  if (points.length <= 1) return points.map((point) => ({ ...point }));
  const samples: MapScenePoint[] = [{ ...points[0]! }];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const steps = Math.max(1, Math.ceil(distance(start, end) / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      samples.push({
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      });
    }
  }
  return samples;
}

/**
 * 以笔触 id 为种子的有机轮廓。它返回一组矢量圆形笔触，画布、离屏合成
 * 和 PNG 导出复用同一组圆，因此缩放、重开和导出不会出现随机跳变。
 */
export function mapTerrainBrushDabs(
  input: MapTerrainBrushInput,
  widthMultiplier = 1,
): readonly MapTerrainBrushDab[] {
  if (input.shape !== "organic" || input.points.length === 0) return [];
  const radius = Math.max(0.5, (input.width * widthMultiplier) / 2);
  const sampleSpacing = Math.max(
    4,
    Math.min(input.spacing, Math.max(6, radius * 0.45)),
  );
  const seed = hashText(input.id);
  const dabs: MapTerrainBrushDab[] = [];
  samplePath(input.points, sampleSpacing).forEach((point, sampleIndex) => {
    dabs.push({ x: point.x, y: point.y, radius: radius * 0.7 });
    for (let fringeIndex = 0; fringeIndex < 5; fringeIndex += 1) {
      const base = seed + sampleIndex * 37 + fringeIndex * 97;
      const angle = unitNoise(base) * Math.PI * 2;
      const reach = radius * (0.54 + unitNoise(base + 11) * 0.28);
      dabs.push({
        x: point.x + Math.cos(angle) * reach,
        y: point.y + Math.sin(angle) * reach,
        radius: radius * (0.18 + unitNoise(base + 29) * 0.16),
      });
    }
  });
  return dabs;
}

/**
 * 把一条素材笔触展开为稳定的散布场。散布为零时仍保留沿路径的主素材；
 * 提高散布会在路径两侧生成小型辅助素材，使森林和山脉能形成自然片区，
 * 而不是一条规则的图标队列。
 */
export function mapArtworkBrushDabs(input: {
  readonly id: string;
  readonly points: readonly MapScenePoint[];
  readonly width: number;
  readonly spacing: number;
  readonly scatter: number;
  /** 横向素材（如山脉）沿当前笔势稳定旋转，默认保持素材的固有朝向。 */
  readonly followPath?: boolean;
}): readonly MapArtworkBrushDab[] {
  if (input.points.length === 0) return [];
  const spacing = Math.max(4, input.spacing);
  const scatter = Math.max(0, Math.min(1, input.scatter));
  const seed = hashText(input.id);
  const samples = samplePath(input.points, spacing);
  const dabs: MapArtworkBrushDab[] = [];

  samples.forEach((sample, sampleIndex) => {
    const previous = samples[Math.max(0, sampleIndex - 1)]!;
    const next = samples[Math.min(samples.length - 1, sampleIndex + 1)]!;
    const direction = Math.atan2(next.y - previous.y, next.x - previous.x);
    const normal = { x: -Math.sin(direction), y: Math.cos(direction) };
    const tangent = { x: Math.cos(direction), y: Math.sin(direction) };
    const appendDab = (
      variantIndex: number,
      sideSpread: number,
      scaleFloor: number,
      scaleRange: number,
    ) => {
      const base = seed + sampleIndex * 4_099 + variantIndex * 911;
      const lateral = (unitNoise(base + 1) * 2 - 1) * sideSpread;
      const longitudinal =
        (unitNoise(base + 2) * 2 - 1) *
        Math.min(spacing * 0.28, input.width * 0.16);
      dabs.push({
        x: sample.x + normal.x * lateral + tangent.x * longitudinal,
        y: sample.y + normal.y * lateral + tangent.y * longitudinal,
        scale: scaleFloor + unitNoise(base + 3) * scaleRange,
        rotation:
          (input.followPath ? direction : 0) +
          (unitNoise(base + 4) * 2 - 1) * 0.1,
        index: dabs.length,
      });
    };

    appendDab(0, input.width * scatter * 0.08, 0.82, 0.28);
    const secondaryCount = Math.round(scatter * 2);
    for (
      let secondaryIndex = 0;
      secondaryIndex < secondaryCount;
      secondaryIndex += 1
    ) {
      appendDab(
        secondaryIndex + 1,
        input.width * scatter * (0.22 + secondaryIndex * 0.1),
        0.38,
        0.38,
      );
    }
  });

  return dabs;
}
