import { describe, expect, it } from "vitest";

import { mapSceneLayerBrushClipsToLand } from "../business/mapScene";
import type { MapTerrainComposite } from "./mapTerrainCompositor";
import {
  mapTerrainCompositeHasLandAt,
  sampleMapTerrainRelief,
} from "./mapTerrainCompositor";

function createTerrainComposite(): MapTerrainComposite {
  const land = new Uint8Array(16);
  land[1 * 4 + 1] = 1;
  land[3 * 4 + 3] = 1;
  return {
    canvas: {} as HTMLCanvasElement,
    worldWidth: 400,
    worldHeight: 400,
    land,
    rasterWidth: 4,
    rasterHeight: 4,
  };
}

describe("地图地表合成", () => {
  it("使用与地表合成一致的陆地掩码判定素材笔刷落点", () => {
    const composite = createTerrainComposite();

    expect(mapTerrainCompositeHasLandAt(composite, { x: 150, y: 150 })).toBe(
      true,
    );
    expect(mapTerrainCompositeHasLandAt(composite, { x: 50, y: 150 })).toBe(
      false,
    );
    expect(mapTerrainCompositeHasLandAt(composite, { x: 400, y: 400 })).toBe(
      true,
    );
    expect(mapTerrainCompositeHasLandAt(composite, { x: -1, y: 120 })).toBe(
      false,
    );
  });

  it("只裁剪陆地语义图层，保留水系、标注和效果的跨水域能力", () => {
    expect(mapSceneLayerBrushClipsToLand("terrain")).toBe(true);
    expect(mapSceneLayerBrushClipsToLand("relief")).toBe(true);
    expect(mapSceneLayerBrushClipsToLand("vegetation")).toBe(true);
    expect(mapSceneLayerBrushClipsToLand("civilization")).toBe(true);
    expect(mapSceneLayerBrushClipsToLand("water")).toBe(false);
    expect(mapSceneLayerBrushClipsToLand("labels")).toBe(false);
    expect(mapSceneLayerBrushClipsToLand("effects")).toBe(false);
  });

  it("从稳定世界坐标派生可复现的内陆起伏和等高线强度", () => {
    const first = sampleMapTerrainRelief(420, 260);
    const repeated = sampleMapTerrainRelief(420, 260);
    const nearby = sampleMapTerrainRelief(421, 260);

    expect(repeated).toEqual(first);
    expect(first.elevation).toBeGreaterThanOrEqual(0);
    expect(first.elevation).toBeLessThanOrEqual(1);
    expect(first.contour).toBeGreaterThanOrEqual(0);
    expect(first.contour).toBeLessThanOrEqual(1);
    expect(nearby).not.toEqual(first);
  });
});
