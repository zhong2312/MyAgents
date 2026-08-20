import { describe, expect, it } from "vitest";

import {
  mapArtworkBrushDabs,
  mapArtworkBrushMaxLateralSpread,
  mapTerrainBrushDabs,
} from "./mapTerrainBrush";

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

  it("按素材类型使用不同的成片散布规则", () => {
    const base = {
      id: "profiled-stroke",
      points: [
        { x: 100, y: 140 },
        { x: 420, y: 190 },
      ],
      width: 120,
      spacing: 48,
      scatter: 1,
      followPath: false,
    } as const;
    const mountain = mapArtworkBrushDabs({
      ...base,
      assetId: "mountain-range",
      followPath: true,
    });
    const forest = mapArtworkBrushDabs({ ...base, assetId: "forest" });
    const wetland = mapArtworkBrushDabs({ ...base, assetId: "wetland" });

    expect(forest.length).toBeGreaterThan(mountain.length);
    expect(wetland.length).toBeGreaterThan(mountain.length);
    expect(
      Math.max(...forest.map((dab) => Math.abs(dab.y - 140))),
    ).toBeGreaterThan(
      Math.max(...mountain.map((dab) => Math.abs(dab.y - 140))),
    );
    expect(mountain).toEqual(
      mapArtworkBrushDabs({
        ...base,
        assetId: "mountain-range",
        followPath: true,
      }),
    );
  });

  it("新增笔刷为断崖、沙丘和珊瑚礁保留不同的稳定散布密度", () => {
    const base = {
      id: "expanded-brush-stroke",
      points: [
        { x: 100, y: 140 },
        { x: 420, y: 190 },
      ],
      width: 120,
      spacing: 48,
      scatter: 1,
    } as const;
    const cliff = mapArtworkBrushDabs({
      ...base,
      assetId: "cliff",
      followPath: true,
    });
    const dunes = mapArtworkBrushDabs({ ...base, assetId: "dunes" });
    const coral = mapArtworkBrushDabs({ ...base, assetId: "coral-reef" });

    expect(cliff).toEqual(
      mapArtworkBrushDabs({
        ...base,
        assetId: "cliff",
        followPath: true,
      }),
    );
    expect(dunes.length).toBeGreaterThan(cliff.length);
    expect(coral.length).toBeGreaterThan(cliff.length);
    expect(
      mapArtworkBrushMaxLateralSpread({
        assetId: "coral-reef",
        width: 120,
        scatter: 1,
      }),
    ).toBeGreaterThan(
      mapArtworkBrushMaxLateralSpread({
        assetId: "cliff",
        width: 120,
        scatter: 1,
      }),
    );
  });

  it("生态、海岸与文明笔刷使用各自稳定的散布轮廓", () => {
    const base = {
      id: "biome-brush-stroke",
      points: [
        { x: 100, y: 140 },
        { x: 420, y: 190 },
      ],
      width: 120,
      spacing: 48,
      scatter: 1,
    } as const;
    const broadleaf = mapArtworkBrushDabs({
      ...base,
      assetId: "broadleaf-grove",
    });
    const foam = mapArtworkBrushDabs({
      ...base,
      assetId: "sea-foam",
      followPath: true,
    });
    const terraces = mapArtworkBrushDabs({ ...base, assetId: "terraces" });

    expect(broadleaf).toEqual(
      mapArtworkBrushDabs({ ...base, assetId: "broadleaf-grove" }),
    );
    expect(broadleaf.length).toBeGreaterThan(terraces.length);
    expect(foam.length).toBeLessThan(broadleaf.length);
    expect(
      mapArtworkBrushMaxLateralSpread({
        assetId: "broadleaf-grove",
        width: 120,
        scatter: 1,
      }),
    ).toBeGreaterThan(
      mapArtworkBrushMaxLateralSpread({
        assetId: "sea-foam",
        width: 120,
        scatter: 1,
      }),
    );
  });

  it("边界半径使用与实际盖印相同的 profile 散布范围", () => {
    const mountain = mapArtworkBrushMaxLateralSpread({
      assetId: "mountain-range",
      width: 120,
      scatter: 1,
    });
    const wetland = mapArtworkBrushMaxLateralSpread({
      assetId: "wetland",
      width: 120,
      scatter: 1,
    });

    expect(wetland).toBeGreaterThan(mountain);
    expect(wetland).toBeCloseTo(120 * (0.42 + 3 * 0.08), 8);
  });
});
