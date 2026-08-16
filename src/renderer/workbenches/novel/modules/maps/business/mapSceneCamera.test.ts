import { describe, expect, it } from "vitest";

import {
  autoPanMapSceneCameraAtEdge,
  fitMapSceneCameraToBounds,
  panMapSceneCamera,
  rebaseMapSceneCamera,
  zoomMapSceneCameraAt,
} from "./mapSceneCamera";

describe("mapSceneCamera", () => {
  it("以连续屏幕增量平移，不会在第二次移动时被地图坐标反算抵消", () => {
    const initial = { x: 40, y: 72, zoom: 1.5, fitted: true };
    const first = panMapSceneCamera(
      initial,
      { x: 300, y: 220 },
      { x: 340, y: 205 },
    );
    const second = panMapSceneCamera(
      first,
      { x: 340, y: 205 },
      { x: 385, y: 248 },
    );

    expect(first).toMatchObject({ x: 80, y: 57 });
    expect(second).toMatchObject({ x: 125, y: 100 });
  });

  it("拖动内容抵达视口边沿时，按方向自动推动世界坐标继续延展", () => {
    const camera = { x: 120, y: 80, zoom: 1.5, fitted: true };
    const viewport = { width: 1_000, height: 600 };

    const southeast = autoPanMapSceneCameraAtEdge(
      camera,
      { x: 990, y: 590 },
      viewport,
    );
    const northwest = autoPanMapSceneCameraAtEdge(
      camera,
      { x: 10, y: 10 },
      viewport,
    );

    expect(southeast.x).toBeLessThan(camera.x);
    expect(southeast.y).toBeLessThan(camera.y);
    expect(northwest.x).toBeGreaterThan(camera.x);
    expect(northwest.y).toBeGreaterThan(camera.y);
  });

  it("指针不在边缘区或视口无效时不移动相机", () => {
    const camera = { x: 120, y: 80, zoom: 1.5, fitted: true };

    expect(
      autoPanMapSceneCameraAtEdge(
        camera,
        { x: 500, y: 300 },
        {
          width: 1_000,
          height: 600,
        },
      ),
    ).toBe(camera);
    expect(
      autoPanMapSceneCameraAtEdge(
        camera,
        { x: 0, y: 0 },
        {
          width: 0,
          height: 600,
        },
      ),
    ).toBe(camera);
  });

  it("围绕光标缩放时保留光标下的地图坐标", () => {
    const camera = { x: 120, y: 40, zoom: 1.25, fitted: true };
    const anchor = { x: 640, y: 360 };
    const worldBefore = {
      x: (anchor.x - camera.x) / camera.zoom,
      y: (anchor.y - camera.y) / camera.zoom,
    };
    const zoomed = zoomMapSceneCameraAt(camera, anchor, 1.4);
    const worldAfter = {
      x: (anchor.x - zoomed.x) / zoomed.zoom,
      y: (anchor.y - zoomed.y) / zoomed.zoom,
    };

    expect(zoomed.zoom).toBeCloseTo(1.75);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it("文档在左上方向扩展并重定位坐标后保持屏幕位置不变", () => {
    const camera = { x: 72, y: 48, zoom: 1.5, fitted: true };
    const before = { x: 240, y: 180 };
    const translation = { x: 220, y: 180 };
    const rebased = rebaseMapSceneCamera(camera, translation);
    const screenBefore = {
      x: before.x * camera.zoom + camera.x,
      y: before.y * camera.zoom + camera.y,
    };
    const screenAfter = {
      x: (before.x + translation.x) * rebased.zoom + rebased.x,
      y: (before.y + translation.y) * rebased.zoom + rebased.y,
    };

    expect(screenAfter).toEqual(screenBefore);
  });

  it("按实际内容而不是整张画布居中适配相机", () => {
    const fitted = fitMapSceneCameraToBounds(
      { x: 0, y: 0, zoom: 1, fitted: false },
      { left: 1_200, right: 1_500, top: 80, bottom: 380 },
      { width: 1_000, height: 700 },
    );

    expect(fitted.zoom).toBeCloseTo(604 / 300);
    expect(1_350 * fitted.zoom + fitted.x).toBeCloseTo(500);
    expect(230 * fitted.zoom + fitted.y).toBeCloseTo(350);
    expect(fitted.fitted).toBe(true);
  });

  it("无效范围或视口保持当前相机，避免把画布跳到原点", () => {
    const camera = { x: 72, y: 48, zoom: 1.5, fitted: true };

    expect(
      fitMapSceneCameraToBounds(
        camera,
        { left: 10, right: 5, top: 0, bottom: 10 },
        { width: 800, height: 600 },
      ),
    ).toBe(camera);
    expect(
      fitMapSceneCameraToBounds(
        camera,
        { left: 0, right: 100, top: 0, bottom: 100 },
        { width: 0, height: 600 },
      ),
    ).toBe(camera);
  });
});
