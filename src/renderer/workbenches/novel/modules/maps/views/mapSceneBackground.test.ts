import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import {
  drawContainedMapBackgroundImage,
  drawMapSceneBackground,
  drawMapSceneBackgroundSlice,
} from "./mapSceneBackground";

function createMap(backgroundPreset: "ocean" | "parchment" | "starfield") {
  const map = createEmptyMapDocument({
    id: `background-${backgroundPreset}`,
    name: "背景测试",
    projectionType: "continent",
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  map.canvas.backgroundPreset = backgroundPreset;
  return map;
}

function createContext() {
  const gradient = { addColorStop: vi.fn() };
  return {
    gradient,
    context: {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      createLinearGradient: vi.fn(() => gradient),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D,
  };
}

describe("地图场景背景", () => {
  it("在编辑器与导出器可共用的画布上下文中绘制海图渐变和波纹", () => {
    const { context, gradient } = createContext();

    drawMapSceneBackground(context, createMap("ocean"), 240, 160);

    expect(context.createLinearGradient).toHaveBeenCalledWith(0, 0, 240, 160);
    expect(gradient.addColorStop).toHaveBeenCalledWith(0, "#2a6b7c");
    expect(context.quadraticCurveTo).toHaveBeenCalled();
    expect(context.globalAlpha).toBe(1);
  });

  it("以 contain 规则叠加作者导入的底图", () => {
    const { context } = createContext();
    const image = {} as CanvasImageSource;

    drawContainedMapBackgroundImage(context, image, 320, 160, 240, 160, 0.6);

    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 20, 240, 120);
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it("使用稳定世界坐标叠加已自动延展的底图", () => {
    const { context } = createContext();
    const image = {} as CanvasImageSource;

    drawContainedMapBackgroundImage(
      context,
      image,
      320,
      160,
      2_000,
      1_200,
      0.8,
      { x: 160, y: 160, width: 320, height: 160 },
    );

    expect(context.drawImage).toHaveBeenCalledWith(image, 160, 160, 320, 160);
  });

  it("按世界坐标切片绘制背景，避免扫描整张超大画布", () => {
    const { context, gradient } = createContext();

    drawMapSceneBackgroundSlice(context, createMap("ocean"), {
      x: 640,
      y: 320,
      width: 240,
      height: 160,
      worldWidth: 20_000,
      worldHeight: 12_000,
    });

    expect(context.createLinearGradient).toHaveBeenCalledWith(
      0,
      0,
      20_000,
      12_000,
    );
    expect(context.fillRect).toHaveBeenCalledWith(640, 320, 240, 160);
    expect(gradient.addColorStop).toHaveBeenCalledWith(0, "#2a6b7c");
  });

  it("编辑预览越过导出边界时，背景仍连续覆盖越界切片", () => {
    const { context } = createContext();

    drawMapSceneBackgroundSlice(context, createMap("ocean"), {
      x: -240,
      y: 1_080,
      width: 360,
      height: 180,
      worldWidth: 1_600,
      worldHeight: 1_000,
    });

    // worldWidth / worldHeight 仅锚定纹理坐标，不能把无限工作区裁回旧画布。
    expect(context.fillRect).toHaveBeenCalledWith(-240, 1_080, 360, 180);
  });

  it("星空在导出范围之外仍按世界坐标生成细节", () => {
    const { context } = createContext();

    drawMapSceneBackgroundSlice(context, createMap("starfield"), {
      x: -960,
      y: -640,
      width: 640,
      height: 480,
      worldWidth: 1_600,
      worldHeight: 1_000,
    });

    expect(context.fillRect).toHaveBeenCalledWith(-960, -640, 640, 480);
    expect(context.arc).toHaveBeenCalled();
  });
});
