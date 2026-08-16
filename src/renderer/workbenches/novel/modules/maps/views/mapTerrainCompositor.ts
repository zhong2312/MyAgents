import type {
  MapDocument,
  MapScenePoint,
  MapSceneRegion,
  MapSceneStroke,
  MapTerrainStyle,
} from "../entities/mapSchema";
import {
  isMapTerrainMaskStroke,
  isMapTerrainMaterialStroke,
} from "../business/mapScene";
import {
  getMapTerrainMaterialPreset,
  MAP_TERRAIN_MATERIAL_PRESETS,
} from "../business/mapTerrainMaterials";
import { mapTerrainBrushDabs } from "../business/mapTerrainBrush";
import { sampleMapTerrainMaterialTexture } from "../business/mapTerrainMaterialTexture";
import { mapRegionTextureVariation } from "../business/mapTerrainTextures";

const MAX_SURFACE_EDGE = 2_048;

type Rgb = readonly [number, number, number];

type VisibleSceneRegion = {
  readonly region: MapSceneRegion;
  readonly opacity: number;
};

export interface MapTerrainComposite {
  readonly canvas: HTMLCanvasElement;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** 与合成画布一致的下采样陆地掩码，仅供当前渲染帧裁剪素材笔刷。 */
  readonly land: Uint8Array;
  readonly rasterWidth: number;
  readonly rasterHeight: number;
}

/**
 * 根据合成器已经计算出的海陆掩码判断一点是否落在陆地。边界点收束到最后一个
 * 像素，保证画布允许的 `canvas.width / height` 坐标不会被错误地判到范围外。
 */
export function mapTerrainCompositeHasLandAt(
  composite: MapTerrainComposite,
  point: MapScenePoint,
): boolean {
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > composite.worldWidth ||
    point.y > composite.worldHeight
  ) {
    return false;
  }
  const x = Math.min(
    composite.rasterWidth - 1,
    Math.max(
      0,
      Math.floor((point.x / composite.worldWidth) * composite.rasterWidth),
    ),
  );
  const y = Math.min(
    composite.rasterHeight - 1,
    Math.max(
      0,
      Math.floor((point.y / composite.worldHeight) * composite.rasterHeight),
    ),
  );
  return composite.land[y * composite.rasterWidth + x] !== 0;
}

function hexToRgb(value: string, fallback: Rgb): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (!match) return fallback;
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ];
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixColor(from: Rgb, to: Rgb, amount: number): Rgb {
  const ratio = Math.max(0, Math.min(1, amount));
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ];
}

function pixelNoise(x: number, y: number): number {
  let value = (x * 374_761_393 + y * 668_265_263) >>> 0;
  value = (value ^ (value >>> 13)) * 1_274_126_177;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
}

function smoothStep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - clamped * 2);
}

function valueNoise(worldX: number, worldY: number, cellSize: number): number {
  const safeCellSize = Math.max(1, cellSize);
  const sourceX = worldX / safeCellSize;
  const sourceY = worldY / safeCellSize;
  const baseX = Math.floor(sourceX);
  const baseY = Math.floor(sourceY);
  const x = smoothStep(sourceX - baseX);
  const y = smoothStep(sourceY - baseY);
  const top =
    pixelNoise(baseX, baseY) * (1 - x) + pixelNoise(baseX + 1, baseY) * x;
  const bottom =
    pixelNoise(baseX, baseY + 1) * (1 - x) +
    pixelNoise(baseX + 1, baseY + 1) * x;
  return top * (1 - y) + bottom * y;
}

/**
 * 可重建的地表起伏。它不是新的高度图事实，而是固定世界坐标上的多尺度
 * 值噪声，用于让未单独绘制山脉的陆地仍具备纸绘地图需要的明暗与等高线层次。
 */
export function sampleMapTerrainRelief(
  worldX: number,
  worldY: number,
): { readonly elevation: number; readonly contour: number } {
  const broad = valueNoise(worldX, worldY, 260);
  const middle = valueNoise(worldX + 61, worldY - 37, 112);
  const fine = valueNoise(worldX - 19, worldY + 83, 46);
  const elevation = Math.max(
    0,
    Math.min(1, broad * 0.52 + middle * 0.33 + fine * 0.15),
  );
  const contourPosition = Math.abs(((elevation * 6.2) % 1) - 0.5) * 2;
  return {
    elevation,
    contour: Math.max(0, Math.min(1, 1 - contourPosition / 0.13)),
  };
}

function drawClosedRegion(
  context: CanvasRenderingContext2D,
  points: readonly MapScenePoint[],
  scale: number,
): void {
  if (points.length < 3) return;
  const scaled = points.map((point) => ({
    x: point.x * scale,
    y: point.y * scale,
  }));
  const first = scaled[0]!;
  const last = scaled[scaled.length - 1]!;
  context.beginPath();
  context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  scaled.forEach((point, index) => {
    const next = scaled[(index + 1) % scaled.length]!;
    context.quadraticCurveTo(
      point.x,
      point.y,
      (point.x + next.x) / 2,
      (point.y + next.y) / 2,
    );
  });
  context.closePath();
}

function drawTerrainStroke(
  context: CanvasRenderingContext2D,
  stroke: MapSceneStroke,
  scale: number,
  widthMultiplier = 1,
): void {
  const points = stroke.points;
  if (points.length === 0) return;
  if (stroke.shape === "organic") {
    mapTerrainBrushDabs(stroke, widthMultiplier).forEach((dab) => {
      context.beginPath();
      context.arc(
        dab.x * scale,
        dab.y * scale,
        Math.max(0.5, dab.radius * scale),
        0,
        Math.PI * 2,
      );
      context.fill();
    });
    return;
  }
  const first = points[0]!;
  context.beginPath();
  if (points.length === 1) {
    context.arc(
      first.x * scale,
      first.y * scale,
      Math.max(0.5, (stroke.width * widthMultiplier * scale) / 2),
      0,
      Math.PI * 2,
    );
    context.fill();
    return;
  }
  context.moveTo(first.x * scale, first.y * scale);
  points.slice(1).forEach((point) => {
    context.lineTo(point.x * scale, point.y * scale);
  });
  context.lineWidth = Math.max(1, stroke.width * widthMultiplier * scale);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.stroke();
}

function createSurface(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function setPixel(
  data: Uint8ClampedArray,
  index: number,
  color: Rgb,
  grain: number,
  alpha: number,
): void {
  const offset = index * 4;
  data[offset] = clampChannel(color[0] + grain);
  data[offset + 1] = clampChannel(color[1] + grain);
  data[offset + 2] = clampChannel(color[2] + grain);
  data[offset + 3] = clampChannel(alpha);
}

function applyRegionTexture(
  color: Rgb,
  texture: "paper-land" | "water-ripple",
  x: number,
  y: number,
  opacity: number,
  textureStrength: number,
): Rgb {
  const variation = mapRegionTextureVariation(texture, x, y);
  if (variation === 0 || opacity <= 0 || textureStrength <= 0) return color;
  const amount = Math.min(
    texture === "paper-land" ? 0.16 : 0.2,
    Math.abs(variation) * opacity * textureStrength,
  );
  const tint: Rgb =
    texture === "paper-land"
      ? variation > 0
        ? [250, 241, 207]
        : [84, 69, 48]
      : [219, 243, 238];
  return mixColor(color, tint, amount);
}

function buildEdgeFields(
  land: Uint8Array,
  width: number,
  height: number,
  style: MapTerrainStyle,
  scale: number,
): { readonly shelf: Float32Array; readonly beach: Float32Array } {
  const shelf = new Float32Array(width * height);
  const beach = new Float32Array(width * height);
  const shelfRadius = Math.max(1, Math.round(style.shelfWidth * scale));
  const beachRadius = Math.max(1, Math.round((style.coastWidth + 4) * scale));
  const paintRadius = Math.max(shelfRadius, beachRadius);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (land[index] === 0) continue;
      const boundary =
        land[index - 1] === 0 ||
        land[index + 1] === 0 ||
        land[index - width] === 0 ||
        land[index + width] === 0;
      if (!boundary) continue;

      for (let offsetY = -paintRadius; offsetY <= paintRadius; offsetY += 1) {
        const targetY = y + offsetY;
        if (targetY < 0 || targetY >= height) continue;
        for (let offsetX = -paintRadius; offsetX <= paintRadius; offsetX += 1) {
          const targetX = x + offsetX;
          if (targetX < 0 || targetX >= width) continue;
          const distance = Math.hypot(offsetX, offsetY);
          const target = targetY * width + targetX;
          if (land[target] === 0 && distance <= shelfRadius) {
            shelf[target] = Math.max(
              shelf[target]!,
              1 - distance / shelfRadius,
            );
          } else if (land[target] !== 0 && distance <= beachRadius) {
            beach[target] = Math.max(
              beach[target]!,
              1 - distance / beachRadius,
            );
          }
        }
      }
    }
  }
  return { shelf, beach };
}

/**
 * 近似距离场仅由本次已合成的海陆遮罩派生。用于让海岸压暗和内陆地貌细节
 * 在岛屿边缘自然淡出，不把任何像素、高程或阴影写回 MapDocument。
 */
function buildLandDistanceField(
  land: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const distance = new Float32Array(width * height);
  const infinity = width + height + 1;
  for (let index = 0; index < distance.length; index += 1) {
    distance[index] = land[index] === 0 ? 0 : infinity;
  }
  const visit = (index: number, candidate: number) => {
    if (candidate < distance[index]!) distance[index] = candidate;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (land[index] === 0) continue;
      if (x > 0) visit(index, distance[index - 1]! + 1);
      if (y > 0) visit(index, distance[index - width]! + 1);
      if (x > 0 && y > 0) visit(index, distance[index - width - 1]! + 1.4);
      if (x < width - 1 && y > 0)
        visit(index, distance[index - width + 1]! + 1.4);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (land[index] === 0) continue;
      if (x < width - 1) visit(index, distance[index + 1]! + 1);
      if (y < height - 1) visit(index, distance[index + width]! + 1);
      if (x < width - 1 && y < height - 1)
        visit(index, distance[index + width + 1]! + 1.4);
      if (x > 0 && y < height - 1)
        visit(index, distance[index + width - 1]! + 1.4);
    }
  }
  return distance;
}

export function createMapTerrainComposite(
  mapDocument: MapDocument,
): MapTerrainComposite | null {
  const scene = mapDocument.scene;
  if (!scene || typeof globalThis.document === "undefined") return null;
  const visibleLayers = scene.layers.filter(
    (layer) => layer.visible && layer.opacity > 0,
  );
  const visibleRegions: readonly VisibleSceneRegion[] = visibleLayers.flatMap(
    (layer) =>
      layer.regions.map((region) => ({
        region,
        opacity: layer.opacity * region.opacity,
      })),
  );
  const landRegions = visibleRegions.filter(
    ({ region }) => region.kind === "land",
  );
  const terrainStrokes = visibleLayers.flatMap((layer) =>
    layer.strokes.filter((stroke) =>
      isMapTerrainMaskStroke(layer.kind, stroke),
    ),
  );
  const materialStrokes = visibleLayers.flatMap((layer) =>
    layer.strokes
      .filter((stroke) => isMapTerrainMaterialStroke(layer.kind, stroke))
      .map((stroke) => ({
        stroke,
        opacity: layer.opacity * stroke.opacity,
      })),
  );
  const hasRaisedLand = terrainStrokes.some(
    (stroke) => stroke.tool === "paint",
  );
  if (landRegions.length === 0 && !hasRaisedLand) return null;
  const waterRegions = visibleRegions.filter(
    ({ region }) => region.kind === "water",
  );
  const worldWidth = mapDocument.canvas.width;
  const worldHeight = mapDocument.canvas.height;
  const scale = Math.min(
    1,
    MAX_SURFACE_EDGE / Math.max(worldWidth, worldHeight),
  );
  const width = Math.max(1, Math.round(worldWidth * scale));
  const height = Math.max(1, Math.round(worldHeight * scale));
  const maskCanvas = createSurface(width, height);
  const colorCanvas = createSurface(width, height);
  const waterCanvas = createSurface(width, height);
  const landTextureCanvas = createSurface(width, height);
  const waterTextureCanvas = createSurface(width, height);
  const materialCanvas = createSurface(width, height);
  const materialIdCanvas = createSurface(width, height);
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  const colorContext = colorCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const waterContext = waterCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const landTextureContext = landTextureCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const waterTextureContext = waterTextureCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const materialContext = materialCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const materialIdContext = materialIdCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (
    !maskContext ||
    !colorContext ||
    !waterContext ||
    !landTextureContext ||
    !waterTextureContext ||
    !materialContext ||
    !materialIdContext
  )
    return null;

  maskContext.fillStyle = "#ffffff";
  landRegions.forEach(({ region, opacity }) => {
    drawClosedRegion(maskContext, region.points, scale);
    maskContext.fill();
    drawClosedRegion(colorContext, region.points, scale);
    colorContext.fillStyle = region.fill || scene.terrainStyle.landColor;
    colorContext.fill();
    if (region.texture === "paper-land") {
      landTextureContext.save();
      landTextureContext.globalAlpha = opacity;
      landTextureContext.fillStyle = "#ffffff";
      drawClosedRegion(landTextureContext, region.points, scale);
      landTextureContext.fill();
      landTextureContext.restore();
    }
  });
  waterRegions.forEach(({ region, opacity }) => {
    drawClosedRegion(maskContext, region.points, scale);
    maskContext.save();
    maskContext.globalCompositeOperation = "destination-out";
    maskContext.fill();
    maskContext.restore();
    drawClosedRegion(colorContext, region.points, scale);
    colorContext.save();
    colorContext.globalCompositeOperation = "destination-out";
    colorContext.fill();
    colorContext.restore();
    drawClosedRegion(waterContext, region.points, scale);
    waterContext.fillStyle =
      region.fill || scene.terrainStyle.shallowWaterColor;
    waterContext.fill();
    if (region.texture === "water-ripple") {
      waterTextureContext.save();
      waterTextureContext.globalAlpha = opacity;
      waterTextureContext.fillStyle = "#ffffff";
      drawClosedRegion(waterTextureContext, region.points, scale);
      waterTextureContext.fill();
      waterTextureContext.restore();
    }
  });
  terrainStrokes.forEach((stroke) => {
    const operation =
      stroke.tool === "erase" ? "destination-out" : "source-over";
    maskContext.save();
    maskContext.globalCompositeOperation = operation;
    maskContext.fillStyle = "#ffffff";
    maskContext.strokeStyle = "#ffffff";
    drawTerrainStroke(maskContext, stroke, scale);
    maskContext.restore();

    colorContext.save();
    colorContext.globalCompositeOperation = operation;
    colorContext.fillStyle = stroke.color || scene.terrainStyle.landColor;
    colorContext.strokeStyle = stroke.color || scene.terrainStyle.landColor;
    drawTerrainStroke(colorContext, stroke, scale);
    colorContext.restore();
  });
  materialStrokes.forEach(({ stroke, opacity }) => {
    const material = stroke.terrainMaterial;
    if (!material) return;
    const featherPasses = [
      { width: 1.28, alpha: 0.08 },
      { width: 1.2, alpha: 0.12 },
      { width: 1.13, alpha: 0.18 },
      { width: 1.07, alpha: 0.28 },
      { width: 1, alpha: 0.76 },
    ] as const;
    featherPasses.forEach((pass) => {
      materialContext.save();
      materialContext.globalAlpha = opacity * pass.alpha;
      materialContext.fillStyle = stroke.color;
      materialContext.strokeStyle = stroke.color;
      drawTerrainStroke(materialContext, stroke, scale, pass.width);
      materialContext.restore();
    });

    const materialIndex = MAP_TERRAIN_MATERIAL_PRESETS.findIndex(
      (preset) => preset.id === material,
    );
    materialIdContext.save();
    materialIdContext.fillStyle = `rgb(${materialIndex + 1}, 0, 0)`;
    materialIdContext.strokeStyle = `rgb(${materialIndex + 1}, 0, 0)`;
    drawTerrainStroke(materialIdContext, stroke, scale, 1.28);
    materialIdContext.restore();
  });

  const maskData = maskContext.getImageData(0, 0, width, height).data;
  const landColorData = colorContext.getImageData(0, 0, width, height).data;
  const lakeColorData = waterContext.getImageData(0, 0, width, height).data;
  const landTextureData = landTextureContext.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const waterTextureData = waterTextureContext.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const materialColorData = materialContext.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const materialIdData = materialIdContext.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const land = new Uint8Array(width * height);
  for (let index = 0; index < land.length; index += 1) {
    land[index] = maskData[index * 4 + 3]! > 48 ? 1 : 0;
  }
  const { shelf, beach } = buildEdgeFields(
    land,
    width,
    height,
    scene.terrainStyle,
    scale,
  );
  const landDistance = buildLandDistanceField(land, width, height);
  const output = createSurface(width, height);
  const outputContext = output.getContext("2d");
  if (!outputContext) return null;
  const image = outputContext.createImageData(width, height);
  const style = scene.terrainStyle;
  const fallbackLand = hexToRgb(style.landColor, [184, 173, 125]);
  const deepWater = hexToRgb(style.waterColor, [44, 106, 129]);
  const shallowWater = hexToRgb(style.shallowWaterColor, [93, 156, 175]);
  const beachColor = hexToRgb(style.beachColor, [215, 197, 143]);
  const coastColor = hexToRgb(style.coastColor, [101, 85, 64]);
  // 区域本身保持独立，海岸线却必须来自全部陆地的并集，否则相交大陆会
  // 出现不属于最终轮廓的内部接缝。宽度以世界坐标的地形成图参数为准。
  const coastlineWidth = Math.max(0, style.coastWidth * scale);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const worldX = x / scale;
      const worldY = y / scale;
      const noise = (pixelNoise(x, y) - 0.5) * 22 * style.textureStrength;
      const largeGrain =
        Math.sin(x * 0.035 + Math.sin(y * 0.021)) * 4 * style.textureStrength;
      if (land[index] !== 0) {
        const offset = index * 4;
        const regionTint: Rgb =
          landColorData[offset + 3]! > 0
            ? [
                landColorData[offset]!,
                landColorData[offset + 1]!,
                landColorData[offset + 2]!,
              ]
            : fallbackLand;
        let source = mixColor(fallbackLand, regionTint, 0.45);
        const rawMaterialOpacity = materialColorData[offset + 3]! / 255;
        const materialOpacity = Math.max(
          0,
          Math.min(
            1,
            rawMaterialOpacity +
              (pixelNoise(Math.floor(x / 3), Math.floor(y / 3)) - 0.5) *
                0.12 *
                (1 - rawMaterialOpacity),
          ),
        );
        if (materialOpacity > 0) {
          const materialPreset =
            MAP_TERRAIN_MATERIAL_PRESETS[materialIdData[offset]! - 1];
          if (materialPreset) {
            const materialBase: Rgb = [
              materialColorData[offset]!,
              materialColorData[offset + 1]!,
              materialColorData[offset + 2]!,
            ];
            const materialDetail = hexToRgb(
              getMapTerrainMaterialPreset(materialPreset.id).detailColor,
              materialBase,
            );
            const texture = sampleMapTerrainMaterialTexture(
              materialPreset.id,
              x,
              y,
            );
            const materialColor = mixColor(
              materialBase,
              materialDetail,
              texture.detail,
            );
            const texturedMaterial = mixColor(
              materialColor,
              [246, 239, 214],
              texture.highlight,
            );
            source = mixColor(
              source,
              texturedMaterial,
              Math.min(0.88, materialOpacity * 0.86),
            );
          }
        }
        const coastMix = Math.min(0.68, beach[index]! * 0.86);
        let color =
          beach[index]! > 0.72
            ? mixColor(source, coastColor, coastMix)
            : beach[index]! > 0
              ? mixColor(source, beachColor, beach[index]! * 0.42)
              : source;
        const distanceFromWater = landDistance[index]!;
        const coastFade = Math.max(
          0,
          Math.min(1, distanceFromWater / Math.max(2, 42 * scale)),
        );
        const coastShadow = Math.max(
          0,
          1 - distanceFromWater / Math.max(1, 10 * scale),
        );
        const relief = sampleMapTerrainRelief(worldX, worldY);
        const reliefStrength = 0.42 + style.textureStrength * 0.58;
        const elevation = Math.max(0, (relief.elevation - 0.34) / 0.66);
        color = mixColor(color, coastColor, coastShadow * 0.1);
        color = mixColor(
          color,
          [249, 241, 208],
          elevation * coastFade * 0.12 * reliefStrength,
        );
        color = mixColor(
          color,
          [93, 82, 59],
          relief.contour * coastFade * 0.075 * reliefStrength,
        );
        const textured = applyRegionTexture(
          color,
          "paper-land",
          worldX,
          worldY,
          landTextureData[offset + 3]! / 255,
          style.textureStrength,
        );
        const coastlineAlpha =
          coastlineWidth > 0
            ? Math.max(
                0,
                Math.min(
                  1,
                  (coastlineWidth + 0.4 - distanceFromWater) /
                    (coastlineWidth + 0.4),
                ),
              )
            : 0;
        const outlined = mixColor(textured, coastColor, coastlineAlpha * 0.82);
        setPixel(image.data, index, outlined, noise + largeGrain, 255);
        continue;
      }
      const offset = index * 4;
      const lakeColor: Rgb | null =
        lakeColorData[offset + 3]! > 0
          ? [
              lakeColorData[offset]!,
              lakeColorData[offset + 1]!,
              lakeColorData[offset + 2]!,
            ]
          : null;
      const shelfAmount = shelf[index]!;
      const color = lakeColor
        ? mixColor(shallowWater, lakeColor, 0.56)
        : shelfAmount > 0
          ? mixColor(deepWater, shallowWater, 0.28 + shelfAmount * 0.72)
          : deepWater;
      const wave =
        Math.sin(x * 0.16 + y * 0.045) > 0.94 && Math.sin(y * 0.11) > 0.2
          ? 6 * style.textureStrength
          : 0;
      const textured = applyRegionTexture(
        color,
        "water-ripple",
        worldX,
        worldY,
        waterTextureData[offset + 3]! / 255,
        style.textureStrength,
      );
      setPixel(image.data, index, textured, noise * 0.52 + wave, 246);
    }
  }
  outputContext.putImageData(image, 0, 0);
  return {
    canvas: output,
    worldWidth,
    worldHeight,
    land,
    rasterWidth: width,
    rasterHeight: height,
  };
}
