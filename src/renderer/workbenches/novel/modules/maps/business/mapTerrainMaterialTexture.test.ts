import { describe, expect, it } from "vitest";

import { sampleMapTerrainMaterialTexture } from "./mapTerrainMaterialTexture";

const SAMPLE_POINTS = [
  { x: 7, y: 11 },
  { x: 37, y: 53 },
  { x: 91, y: 29 },
  { x: 143, y: 117 },
  { x: 221, y: 79 },
] as const;

describe("地貌材质纹理", () => {
  it("对相同的世界坐标始终给出同一份纹理强度", () => {
    expect(sampleMapTerrainMaterialTexture("forest", 91, 29)).toEqual(
      sampleMapTerrainMaterialTexture("forest", 91, 29),
    );
  });

  it("所有材质都输出可安全叠加的归一化强度", () => {
    const materials = [
      "grassland",
      "forest",
      "desert",
      "badlands",
      "tundra",
      "snow",
      "swamp",
      "volcanic",
    ] as const;

    materials.forEach((material) => {
      SAMPLE_POINTS.forEach((point) => {
        const sample = sampleMapTerrainMaterialTexture(
          material,
          point.x,
          point.y,
        );
        expect(sample.detail).toBeGreaterThanOrEqual(0);
        expect(sample.detail).toBeLessThanOrEqual(1);
        expect(sample.highlight).toBeGreaterThanOrEqual(0);
        expect(sample.highlight).toBeLessThanOrEqual(1);
      });
    });
  });

  it("不同地貌不会退化为同一种颗粒噪声", () => {
    const signature = (
      material: Parameters<typeof sampleMapTerrainMaterialTexture>[0],
    ) =>
      SAMPLE_POINTS.map((point) => {
        const sample = sampleMapTerrainMaterialTexture(
          material,
          point.x,
          point.y,
        );
        return `${sample.detail.toFixed(3)}:${sample.highlight.toFixed(3)}`;
      }).join(",");

    expect(signature("forest")).not.toBe(signature("desert"));
    expect(signature("desert")).not.toBe(signature("volcanic"));
    expect(signature("swamp")).not.toBe(signature("snow"));
  });
});
