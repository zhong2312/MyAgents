import { describe, expect, it } from "vitest";

import { mapRegionTextureVariation } from "./mapTerrainTextures";

describe("mapRegionTextureVariation", () => {
  it("为纸纤维提供稳定且受限的明暗变化", () => {
    const first = mapRegionTextureVariation("paper-land", 238.4, 491.8);
    const repeated = mapRegionTextureVariation("paper-land", 238.4, 491.8);
    const nearby = mapRegionTextureVariation("paper-land", 269.4, 491.8);

    expect(first).toBe(repeated);
    expect(first).toBeGreaterThanOrEqual(-0.42);
    expect(first).toBeLessThanOrEqual(0.42);
    expect(nearby).not.toBe(first);
  });

  it("水面波纹只产生柔和高光，不引入随机结果", () => {
    const samples = Array.from({ length: 80 }, (_, index) =>
      mapRegionTextureVariation("water-ripple", index * 13.7, index * 7.3),
    );

    expect(samples.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(samples.some((value) => value > 0)).toBe(true);
    expect(samples).toEqual(
      Array.from({ length: 80 }, (_, index) =>
        mapRegionTextureVariation("water-ripple", index * 13.7, index * 7.3),
      ),
    );
  });
});
