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

export type MapArtworkBrushSpreadInput = {
  readonly assetId?: string;
  readonly width: number;
  readonly scatter: number;
};

type MapArtworkBrushProfile = {
  /** 主素材沿笔势的横向扩散比例。 */
  readonly primarySpread: number;
  /** 散布素材相对主素材的数量。 */
  readonly secondaryDensity: number;
  /** 散布素材的横向扩散比例。 */
  readonly secondarySpread: number;
  readonly primaryScaleFloor: number;
  readonly primaryScaleRange: number;
  readonly secondaryScaleFloor: number;
  readonly secondaryScaleRange: number;
  /** 沿笔势的抖动比例，避免每种素材都形成机械等距队列。 */
  readonly longitudinalJitter: number;
};

const DEFAULT_ARTWORK_BRUSH_PROFILE: MapArtworkBrushProfile = Object.freeze({
  primarySpread: 0.08,
  secondaryDensity: 2,
  secondarySpread: 0.22,
  primaryScaleFloor: 0.82,
  primaryScaleRange: 0.28,
  secondaryScaleFloor: 0.38,
  secondaryScaleRange: 0.38,
  longitudinalJitter: 0.16,
});

const ARTWORK_BRUSH_PROFILES: Readonly<Record<string, MapArtworkBrushProfile>> =
  Object.freeze({
    // 山脉是沿脊线排列的少量大构件，不能像森林一样铺成密集地毯。
    "mountain-range": Object.freeze({
      primarySpread: 0.045,
      secondaryDensity: 1.25,
      secondarySpread: 0.16,
      primaryScaleFloor: 0.72,
      primaryScaleRange: 0.38,
      secondaryScaleFloor: 0.5,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.2,
    }),
    // 断崖同样沿走向排列，但层次应更紧密，避免变成独立山峰的重复排列。
    cliff: Object.freeze({
      primarySpread: 0.035,
      secondaryDensity: 0.8,
      secondarySpread: 0.12,
      primaryScaleFloor: 0.76,
      primaryScaleRange: 0.28,
      secondaryScaleFloor: 0.48,
      secondaryScaleRange: 0.26,
      longitudinalJitter: 0.12,
    }),
    dunes: Object.freeze({
      primarySpread: 0.17,
      secondaryDensity: 3.5,
      secondarySpread: 0.34,
      primaryScaleFloor: 0.5,
      primaryScaleRange: 0.36,
      secondaryScaleFloor: 0.28,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.3,
    }),
    glacier: Object.freeze({
      primarySpread: 0.09,
      secondaryDensity: 1.5,
      secondarySpread: 0.2,
      primaryScaleFloor: 0.66,
      primaryScaleRange: 0.32,
      secondaryScaleFloor: 0.4,
      secondaryScaleRange: 0.28,
      longitudinalJitter: 0.16,
    }),
    "boulder-field": Object.freeze({
      primarySpread: 0.2,
      secondaryDensity: 3.2,
      secondarySpread: 0.42,
      primaryScaleFloor: 0.38,
      primaryScaleRange: 0.42,
      secondaryScaleFloor: 0.22,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.34,
    }),
    // 林地以宽而不规则的冠层片区为主，次级素材更多、尺寸更分散。
    forest: Object.freeze({
      primarySpread: 0.14,
      secondaryDensity: 4,
      secondarySpread: 0.3,
      primaryScaleFloor: 0.64,
      primaryScaleRange: 0.42,
      secondaryScaleFloor: 0.34,
      secondaryScaleRange: 0.48,
      longitudinalJitter: 0.22,
    }),
    "broadleaf-grove": Object.freeze({
      primarySpread: 0.18,
      secondaryDensity: 4.8,
      secondarySpread: 0.36,
      primaryScaleFloor: 0.58,
      primaryScaleRange: 0.48,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.46,
      longitudinalJitter: 0.3,
    }),
    jungle: Object.freeze({
      primarySpread: 0.18,
      secondaryDensity: 5,
      secondarySpread: 0.36,
      primaryScaleFloor: 0.58,
      primaryScaleRange: 0.5,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.5,
      longitudinalJitter: 0.28,
    }),
    "pine-grove": Object.freeze({
      primarySpread: 0.12,
      secondaryDensity: 3,
      secondarySpread: 0.24,
      primaryScaleFloor: 0.62,
      primaryScaleRange: 0.36,
      secondaryScaleFloor: 0.4,
      secondaryScaleRange: 0.4,
      longitudinalJitter: 0.18,
    }),
    "bamboo-grove": Object.freeze({
      primarySpread: 0.16,
      secondaryDensity: 4.2,
      secondarySpread: 0.32,
      primaryScaleFloor: 0.48,
      primaryScaleRange: 0.36,
      secondaryScaleFloor: 0.28,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.26,
    }),
    // 枯木需要留出空隙，避免渲染成另一块实心森林。
    deadwood: Object.freeze({
      primarySpread: 0.1,
      secondaryDensity: 1.35,
      secondarySpread: 0.28,
      primaryScaleFloor: 0.58,
      primaryScaleRange: 0.42,
      secondaryScaleFloor: 0.34,
      secondaryScaleRange: 0.4,
      longitudinalJitter: 0.3,
    }),
    wetland: Object.freeze({
      primarySpread: 0.2,
      secondaryDensity: 3.5,
      secondarySpread: 0.42,
      primaryScaleFloor: 0.46,
      primaryScaleRange: 0.4,
      secondaryScaleFloor: 0.26,
      secondaryScaleRange: 0.42,
      longitudinalJitter: 0.34,
    }),
    "reed-bed": Object.freeze({
      primarySpread: 0.22,
      secondaryDensity: 4.5,
      secondarySpread: 0.42,
      primaryScaleFloor: 0.4,
      primaryScaleRange: 0.34,
      secondaryScaleFloor: 0.22,
      secondaryScaleRange: 0.32,
      longitudinalJitter: 0.3,
    }),
    mangrove: Object.freeze({
      primarySpread: 0.16,
      secondaryDensity: 3.2,
      secondarySpread: 0.34,
      primaryScaleFloor: 0.54,
      primaryScaleRange: 0.38,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.36,
      longitudinalJitter: 0.24,
    }),
    grassland: Object.freeze({
      primarySpread: 0.16,
      secondaryDensity: 4.5,
      secondarySpread: 0.34,
      primaryScaleFloor: 0.42,
      primaryScaleRange: 0.34,
      secondaryScaleFloor: 0.24,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.25,
    }),
    shrubland: Object.freeze({
      primarySpread: 0.21,
      secondaryDensity: 5,
      secondarySpread: 0.42,
      primaryScaleFloor: 0.4,
      primaryScaleRange: 0.42,
      secondaryScaleFloor: 0.22,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.36,
    }),
    "coral-reef": Object.freeze({
      primarySpread: 0.22,
      secondaryDensity: 4,
      secondarySpread: 0.44,
      primaryScaleFloor: 0.44,
      primaryScaleRange: 0.38,
      secondaryScaleFloor: 0.24,
      secondaryScaleRange: 0.34,
      longitudinalJitter: 0.32,
    }),
    "seaweed-bed": Object.freeze({
      primarySpread: 0.24,
      secondaryDensity: 4.8,
      secondarySpread: 0.46,
      primaryScaleFloor: 0.38,
      primaryScaleRange: 0.38,
      secondaryScaleFloor: 0.22,
      secondaryScaleRange: 0.3,
      longitudinalJitter: 0.36,
    }),
    "sea-foam": Object.freeze({
      primarySpread: 0.1,
      secondaryDensity: 1.8,
      secondarySpread: 0.2,
      primaryScaleFloor: 0.56,
      primaryScaleRange: 0.28,
      secondaryScaleFloor: 0.34,
      secondaryScaleRange: 0.2,
      longitudinalJitter: 0.12,
    }),
    "ice-floe": Object.freeze({
      primarySpread: 0.18,
      secondaryDensity: 2.5,
      secondarySpread: 0.38,
      primaryScaleFloor: 0.5,
      primaryScaleRange: 0.44,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.38,
      longitudinalJitter: 0.36,
    }),
    farmland: Object.freeze({
      primarySpread: 0.14,
      secondaryDensity: 3,
      secondarySpread: 0.3,
      primaryScaleFloor: 0.52,
      primaryScaleRange: 0.26,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.24,
      longitudinalJitter: 0.1,
    }),
    terraces: Object.freeze({
      primarySpread: 0.12,
      secondaryDensity: 2.5,
      secondarySpread: 0.26,
      primaryScaleFloor: 0.52,
      primaryScaleRange: 0.3,
      secondaryScaleFloor: 0.32,
      secondaryScaleRange: 0.22,
      longitudinalJitter: 0.16,
    }),
    archipelago: Object.freeze({
      primarySpread: 0.2,
      secondaryDensity: 2.5,
      secondarySpread: 0.5,
      primaryScaleFloor: 0.54,
      primaryScaleRange: 0.48,
      secondaryScaleFloor: 0.3,
      secondaryScaleRange: 0.42,
      longitudinalJitter: 0.38,
    }),
  });

function artworkBrushProfile(
  assetId: string | undefined,
): MapArtworkBrushProfile {
  if (assetId) {
    return ARTWORK_BRUSH_PROFILES[assetId] ?? DEFAULT_ARTWORK_BRUSH_PROFILE;
  }
  return DEFAULT_ARTWORK_BRUSH_PROFILE;
}

/**
 * 返回 profile 可能产生的最大横向散布距离。
 *
 * 边界计算和实际盖印必须共享这个结果，否则宽幅森林/湿地笔刷可能在
 * 画布边缘只扩展到中心路径，却把最外侧素材裁掉。
 */
export function mapArtworkBrushMaxLateralSpread(
  input: MapArtworkBrushSpreadInput,
): number {
  const profile = artworkBrushProfile(input.assetId);
  const width = Math.max(0, Number.isFinite(input.width) ? input.width : 0);
  const scatter = Math.max(
    0,
    Math.min(1, Number.isFinite(input.scatter) ? input.scatter : 0),
  );
  const secondaryCount = Math.round(scatter * profile.secondaryDensity);
  const secondarySpread =
    secondaryCount > 0
      ? profile.secondarySpread + (secondaryCount - 1) * 0.08
      : profile.primarySpread;
  return width * scatter * Math.max(profile.primarySpread, secondarySpread);
}

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
 * 返回一笔地形的连续覆盖采样。圆形笔刷沿路径补点，有机笔刷直接复用稳定
 * 盖印；交互预览、陆地命中判断和地表合成由此共享同一份覆盖语义。
 */
export function mapTerrainBrushCoverageDabs(
  input: MapTerrainBrushInput,
): readonly MapTerrainBrushDab[] {
  if (input.points.length === 0) return [];
  if (input.shape === "organic") return mapTerrainBrushDabs(input);
  const radius = Math.max(0.5, input.width / 2);
  const spacing = Math.max(4, Math.min(input.spacing, radius * 0.5));
  return samplePath(input.points, spacing).map((point) => ({
    x: point.x,
    y: point.y,
    radius,
  }));
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
  /** 资产身份只用于选择稳定的视觉 profile，不写入笔触事实。 */
  readonly assetId?: string;
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
  const profile = artworkBrushProfile(input.assetId);
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
        Math.min(spacing * 0.28, input.width * profile.longitudinalJitter);
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

    appendDab(
      0,
      input.width * scatter * profile.primarySpread,
      profile.primaryScaleFloor,
      profile.primaryScaleRange,
    );
    const secondaryCount = Math.round(scatter * profile.secondaryDensity);
    for (
      let secondaryIndex = 0;
      secondaryIndex < secondaryCount;
      secondaryIndex += 1
    ) {
      appendDab(
        secondaryIndex + 1,
        input.width *
          scatter *
          (profile.secondarySpread + secondaryIndex * 0.08),
        profile.secondaryScaleFloor,
        profile.secondaryScaleRange,
      );
    }
  });

  return dabs;
}
