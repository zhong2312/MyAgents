import type { MapBackgroundPreset, MapDocument } from "../entities/mapSchema";

type BackgroundPresetDefinition = {
  readonly id: MapBackgroundPreset;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly image: string;
  readonly size: string;
};

export type MapBackgroundImagePlacement = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 生成器底图的自动对齐矩形不参与再次收紧；作者变换后才是边界事实。 */
  readonly source?: "automatic" | "author";
};

export const MAP_BACKGROUND_PRESETS: readonly BackgroundPresetDefinition[] =
  Object.freeze([
    {
      id: "parchment",
      name: "羊皮纸",
      description: "适合手绘大陆和史书地图。",
      color: "#f3f0e8",
      image:
        "radial-gradient(#8b806f16 0.7px,#8b806f00 0.8px),linear-gradient(135deg,#f6f1e6 0%,#ebe1cf 100%)",
      size: "12px 12px,100% 100%",
    },
    {
      id: "ocean",
      name: "深海",
      description: "适合群岛、海图与大陆板块。",
      color: "#1f536a",
      image:
        "radial-gradient(ellipse at 18% 28%,#8cc5cd36 0 2px,#8cc5cd00 3px),radial-gradient(ellipse at 78% 72%,#b9e1dd26 0 2px,#b9e1dd00 3px),linear-gradient(160deg,#245f73,#153a58)",
      size: "42px 34px,58px 46px,100% 100%",
    },
    {
      id: "starfield",
      name: "宇宙星空",
      description: "适合宇宙、星系与星球投影。",
      color: "#0e142b",
      image:
        "radial-gradient(circle at 18% 22%,#fff8d2 0 1px,#fff8d200 1.6px),radial-gradient(circle at 72% 35%,#9ad6ff 0 1px,#9ad6ff00 1.8px),radial-gradient(circle at 42% 78%,#ffffff 0 0.8px,#ffffff00 1.5px),linear-gradient(145deg,#101a3e,#090d20)",
      size: "74px 68px,92px 86px,58px 54px,100% 100%",
    },
    {
      id: "continents",
      name: "大陆底色",
      description: "适合国家、山川和生态分区。",
      color: "#91a985",
      image:
        "radial-gradient(ellipse at 26% 34%,#d7c79244 0 11%,#d7c79200 12%),radial-gradient(ellipse at 74% 68%,#6a885c52 0 13%,#6a885c00 14%),linear-gradient(145deg,#a8bea1,#628172)",
      size: "100% 100%",
    },
    {
      id: "volcanic",
      name: "火山荒原",
      description: "适合魔域、熔岩带与灾变区域。",
      color: "#3e302e",
      image:
        "radial-gradient(circle at 30% 28%,#be674433 0 2px,#be674400 3px),radial-gradient(circle at 70% 64%,#d49b5433 0 1.5px,#d49b5400 2.5px),linear-gradient(145deg,#513632,#271f27)",
      size: "32px 32px,48px 48px,100% 100%",
    },
  ]);

export function getMapBackgroundPreset(
  preset: MapBackgroundPreset | undefined,
): BackgroundPresetDefinition {
  return (
    MAP_BACKGROUND_PRESETS.find((item) => item.id === preset) ??
    MAP_BACKGROUND_PRESETS[0]!
  );
}

export function mapCanvasBackgroundStyle(
  canvas: MapDocument["canvas"],
): Record<string, string> {
  const preset = getMapBackgroundPreset(canvas.backgroundPreset);
  return {
    backgroundColor: canvas.backgroundColor || preset.color,
    backgroundImage: preset.image,
    backgroundSize: preset.size,
  };
}

/** 底图显示状态只影响渲染；底图来源仍属于 MapDocument 的事实。 */
export function isMapBackgroundImageVisible(
  canvas: MapDocument["canvas"],
): boolean {
  return canvas.backgroundImageVisible !== false;
}

/**
 * 兼容没有世界坐标的旧底图。新写入的地图会保存 placement，使得画布扩展
 * 或左上重基准时底图不再随着导出尺寸重新缩放。
 */
export function getMapBackgroundImagePlacement(
  canvas: MapDocument["canvas"],
  imageWidth: number,
  imageHeight: number,
): MapBackgroundImagePlacement | null {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null;
  }
  if (canvas.backgroundImagePlacement) {
    return canvas.backgroundImagePlacement;
  }
  const scale = Math.min(
    canvas.width / imageWidth,
    canvas.height / imageHeight,
  );
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
    width,
    height,
  };
}

/**
 * 用于自动边界计算的底图矩形。旧地图若图片比当前画布大，原有 contain
 * 规则会把关键内容压缩到画布内；此处把它视为真实世界内容，先扩展画布，
 * 再由自动延展流程写入稳定 placement。较小的旧底图继续保持原有外观。
 */
export function getMapBackgroundImageContentPlacement(
  canvas: MapDocument["canvas"],
  imageWidth: number,
  imageHeight: number,
): MapBackgroundImagePlacement | null {
  if (canvas.backgroundImagePlacement) {
    return canvas.backgroundImagePlacement;
  }
  if (imageWidth > canvas.width || imageHeight > canvas.height) {
    return { x: 0, y: 0, width: imageWidth, height: imageHeight };
  }
  return getMapBackgroundImagePlacement(canvas, imageWidth, imageHeight);
}
