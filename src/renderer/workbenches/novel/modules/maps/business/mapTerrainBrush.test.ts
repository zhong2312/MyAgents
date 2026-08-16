import { describe, expect, it } from "vitest";

import { mapArtworkBrushDabs, mapTerrainBrushDabs } from "./mapTerrainBrush";

describe("mapTerrainBrush", () => {
  const input = {
    id: "terrain-organic-1",
    points: [
      { x: 100, y: 140 },
      { x: 320, y: 180 },
    ],
    width: 96,
    spacing: 36,
    shape: "organic" as const,
  };

  it("从稳定笔触事实派生可重复的有机边缘笔触", () => {
    const first = mapTerrainBrushDabs(input);
    const second = mapTerrainBrushDabs(input);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(6);
    expect(first[0]).toMatchObject({ x: 100, y: 140 });
    expect(first[0]?.radius).toBeCloseTo(33.6, 8);
    expect(first.some((dab) => dab.radius < 20)).toBe(true);
  });

  it("圆形笔锋不派生附加笔触，保留旧地图的平滑轮廓", () => {
    expect(mapTerrainBrushDabs({ ...input, shape: "round" })).toEqual([]);
  });

  it("从同一素材笔触稳定派生有比例变化的片状散布", () => {
    const artworkInput = {
      id: "forest-stroke-1",
      points: [
        { x: 100, y: 140 },
        { x: 320, y: 180 },
      ],
      width: 84,
      spacing: 48,
      scatter: 1,
    };
    const first = mapArtworkBrushDabs(artworkInput);
    const second = mapArtworkBrushDabs(artworkInput);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(10);
    expect(new Set(first.map((dab) => dab.scale)).size).toBeGreaterThan(1);
    expect(first.some((dab) => Math.abs(dab.y - 140) > 12)).toBe(true);
    expect(mapArtworkBrushDabs({ ...artworkInput, scatter: 0 })).toHaveLength(
      6,
    );
  });

  it("素材笔触的持久化间距和散布会直接决定重建密度", () => {
    const input = {
      id: "forest-density-1",
      points: [
        { x: 100, y: 140 },
        { x: 340, y: 180 },
      ],
      width: 96,
      scatter: 0.75,
    };

    const sparse = mapArtworkBrushDabs({ ...input, spacing: 96 });
    const dense = mapArtworkBrushDabs({ ...input, spacing: 24 });
    const narrow = mapArtworkBrushDabs({ ...input, spacing: 48, scatter: 0 });

    expect(dense.length).toBeGreaterThan(sparse.length);
    expect(dense).toEqual(mapArtworkBrushDabs({ ...input, spacing: 24 }));
    expect(narrow.length).toBeLessThan(dense.length);
  });

  it("需要沿路径定向的素材会随笔势稳定旋转", () => {
    const input = {
      id: "mountain-ridge-1",
      width: 96,
      spacing: 48,
      scatter: 0,
      followPath: true,
    };
    const horizontal = mapArtworkBrushDabs({
      ...input,
      points: [
        { x: 100, y: 140 },
        { x: 340, y: 140 },
      ],
    });
    const vertical = mapArtworkBrushDabs({
      ...input,
      points: [
        { x: 100, y: 140 },
        { x: 100, y: 380 },
      ],
    });

    expect(horizontal).toEqual(
      mapArtworkBrushDabs({
        ...input,
        points: [
          { x: 100, y: 140 },
          { x: 340, y: 140 },
        ],
      }),
    );
    expect(Math.abs(horizontal[0]?.rotation ?? Number.NaN)).toBeLessThan(0.11);
    expect(
      Math.abs((vertical[0]?.rotation ?? Number.NaN) - Math.PI / 2),
    ).toBeLessThan(0.11);
  });
});
