import { getMapBackgroundPreset } from "../business/mapBackgrounds";
import type { MapDocument } from "../entities/mapSchema";
import type { MapBackgroundImagePlacement } from "../business/mapBackgrounds";

/**
 * 不依赖有限画布尺寸的确定性噪声。坐标可为负数，因此连续工作区在四个
 * 方向平移时仍会显示同一片星空或纸张颗粒，而不是越过旧导出边缘后变空。
 */
function coordinateRandom(x: number, y: number, channel: number): number {
  let value =
    Math.imul(Math.floor(x), 374_761_393) ^
    Math.imul(Math.floor(y), 668_265_263) ^
    Math.imul(channel, 2_246_822_519);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
}

function proceduralCellSize(
  width: number,
  height: number,
  baseCellSize: number,
  maximumCells = 5_000,
): number {
  const area = Math.max(0, width) * Math.max(0, height);
  const baseArea = baseCellSize * baseCellSize;
  const scale = Math.max(
    1,
    Math.sqrt(area / Math.max(1, baseArea * maximumCells)),
  );
  return baseCellSize * Math.ceil(scale);
}

function forEachVisibleCell(
  left: number,
  top: number,
  right: number,
  bottom: number,
  cellSize: number,
  visit: (cellX: number, cellY: number) => void,
): void {
  const startX = Math.floor(left / cellSize);
  const startY = Math.floor(top / cellSize);
  const endX = Math.ceil(right / cellSize);
  const endY = Math.ceil(bottom / cellSize);
  for (let cellY = startY; cellY <= endY; cellY += 1) {
    for (let cellX = startX; cellX <= endX; cellX += 1) {
      visit(cellX, cellY);
    }
  }
}

export interface MapSceneBackgroundSlice {
  /** 世界坐标中的左上角。 */
  readonly x: number;
  readonly y: number;
  /** 当前需要重绘的世界区域尺寸。 */
  readonly width: number;
  readonly height: number;
  /**
   * 背景纹理的稳定坐标系尺寸。
   *
   * 编辑器可以在导出范围之外继续绘制，因此这不是当前绘制切片的裁切边界。
   * 它只用于让渐变、星点和颗粒在相机平移时维持同一套坐标。
   */
  readonly worldWidth: number;
  readonly worldHeight: number;
}

/**
 * 画布和导出器共用的背景合成。背景仍只来自 `MapDocument.canvas`；波纹、
 * 星点和纸张颗粒均是实时可重建的表现层，不保存像素事实。切片参数允许
 * 交互画布只生成当前视口对应的世界区域，避免无限工作区时扫描整张地图。
 *
 * `worldWidth / worldHeight` 是纹理锚点，不能用来裁掉切片：编辑中的内容
 * 可以暂时位于导出边界之外，松开手势后才会统一扩展 MapDocument。
 */
export function drawMapSceneBackgroundSlice(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  slice: MapSceneBackgroundSlice,
): void {
  const worldWidth = Math.max(1, slice.worldWidth);
  const worldHeight = Math.max(1, slice.worldHeight);
  // 交互预览可以暂时越过旧文档的任一边界；这些坐标会在手势提交后由
  // MapDocument 统一扩展或平移回导出空间，因此背景必须无条件覆盖切片。
  const left = slice.x;
  const top = slice.y;
  const right = slice.x + Math.max(0, slice.width);
  const bottom = slice.y + Math.max(0, slice.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return;

  const preset = getMapBackgroundPreset(mapDocument.canvas.backgroundPreset);
  context.fillStyle = mapDocument.canvas.backgroundColor || preset.color;
  context.fillRect(left, top, width, height);

  const gradient = context.createLinearGradient(0, 0, worldWidth, worldHeight);
  switch (preset.id) {
    case "ocean":
      gradient.addColorStop(0, "#2a6b7c");
      gradient.addColorStop(1, "#153a58");
      break;
    case "starfield":
      gradient.addColorStop(0, "#101a3e");
      gradient.addColorStop(1, "#090d20");
      break;
    case "continents":
      gradient.addColorStop(0, "#a8bea1");
      gradient.addColorStop(1, "#628172");
      break;
    case "volcanic":
      gradient.addColorStop(0, "#513632");
      gradient.addColorStop(1, "#271f27");
      break;
    case "parchment":
      gradient.addColorStop(0, "#f6f1e6");
      gradient.addColorStop(1, "#ebe1cf");
      break;
  }
  context.save();
  context.globalAlpha = 0.88;
  context.fillStyle = gradient;
  context.fillRect(left, top, width, height);
  context.restore();

  if (preset.id === "starfield") {
    const cellSize = proceduralCellSize(width, height, 64);
    forEachVisibleCell(left, top, right, bottom, cellSize, (cellX, cellY) => {
      // 低密度的确定性分布，避免放大时出现规则点阵。
      if (coordinateRandom(cellX, cellY, 1) > 0.82) return;
      const x =
        (cellX + 0.12 + coordinateRandom(cellX, cellY, 2) * 0.76) * cellSize;
      const y =
        (cellY + 0.12 + coordinateRandom(cellX, cellY, 3) * 0.76) * cellSize;
      const radius = 0.45 + coordinateRandom(cellX, cellY, 4) * 1.15;
      context.globalAlpha = 0.34 + coordinateRandom(cellX, cellY, 5) * 0.62;
      context.fillStyle =
        coordinateRandom(cellX, cellY, 6) > 0.86 ? "#9ad6ff" : "#fff8d2";
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    });
  } else if (preset.id === "ocean") {
    context.strokeStyle = "#b9e1dd";
    context.lineWidth = 1;
    const firstWaveY = 26 + Math.max(0, Math.floor((top - 26) / 38)) * 38;
    const firstWaveX = -24 + Math.floor((left + 24) / 48) * 48;
    for (let y = firstWaveY; y < bottom; y += 38) {
      context.globalAlpha = 0.08 + ((y / 38) % 3) * 0.025;
      context.beginPath();
      for (let x = firstWaveX; x < right + 24; x += 48) {
        context.moveTo(x, y);
        context.quadraticCurveTo(x + 12, y - 4, x + 24, y);
      }
      context.stroke();
    }
  } else {
    context.fillStyle =
      preset.id === "volcanic"
        ? "#d49b54"
        : preset.id === "continents"
          ? "#d7c792"
          : "#8b806f";
    const cellSize = proceduralCellSize(width, height, 72);
    forEachVisibleCell(left, top, right, bottom, cellSize, (cellX, cellY) => {
      if (coordinateRandom(cellX, cellY, 9) > 0.7) return;
      const x =
        (cellX + 0.08 + coordinateRandom(cellX, cellY, 10) * 0.84) * cellSize;
      const y =
        (cellY + 0.08 + coordinateRandom(cellX, cellY, 11) * 0.84) * cellSize;
      context.globalAlpha = 0.035 + coordinateRandom(cellX, cellY, 12) * 0.055;
      context.fillRect(
        x,
        y,
        1 + coordinateRandom(cellX, cellY, 13) * 1.4,
        1 + coordinateRandom(cellX, cellY, 14) * 1.4,
      );
    });
  }
  context.globalAlpha = 1;
}

export function drawMapSceneBackground(
  context: CanvasRenderingContext2D,
  mapDocument: MapDocument,
  width: number,
  height: number,
): void {
  drawMapSceneBackgroundSlice(context, mapDocument, {
    x: 0,
    y: 0,
    width,
    height,
    worldWidth: width,
    worldHeight: height,
  });
}

export function drawContainedMapBackgroundImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  opacity: number,
  placement?: MapBackgroundImagePlacement | null,
): void {
  if (imageWidth <= 0 || imageHeight <= 0) return;
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const renderedWidth = placement?.width ?? imageWidth * scale;
  const renderedHeight = placement?.height ?? imageHeight * scale;
  const renderedX = placement?.x ?? (width - renderedWidth) / 2;
  const renderedY = placement?.y ?? (height - renderedHeight) / 2;
  context.save();
  context.globalAlpha = opacity;
  context.drawImage(image, renderedX, renderedY, renderedWidth, renderedHeight);
  context.restore();
}
