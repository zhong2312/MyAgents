import { describe, expect, it } from "vitest";

import { mapSceneLayerBrushClipsToLand } from "../business/mapScene";
import {
  createEmptyMapDocument,
  type MapDocument,
  type MapSceneStroke,
} from "../entities/mapSchema";
import type { MapTerrainComposite } from "./mapTerrainCompositor";
import {
  mapTerrainCompositeIntersectsBrush,
  mapTerrainCompositeHasLandAt,
  mapTerrainCompositeHasSurfaceAt,
  mapTerrainCompositeSourceKey,
  mapTerrainRegionColorMix,
  sampleMapTerrainRelief,
  sampleMapTerrainSurfaceTexture,
} from "./mapTerrainCompositor";

function createTerrainComposite(): MapTerrainComposite {
  const land = new Uint8Array(16);
  const water = new Uint8Array(16);
  land[1 * 4 + 1] = 1;
  land[3 * 4 + 3] = 1;
  water[0] = 1;
  return {
    canvas: {} as HTMLCanvasElement,
    worldWidth: 400,
    worldHeight: 400,
    land,
    water,
    rasterWidth: 4,
    rasterHeight: 4,
  };
}

function createDocument(): MapDocument {
  return createEmptyMapDocument({
    id: "terrain-composite-source",
    name: "地表缓存",
    projectionType: "continent",
    createdAt: "2026-08-17T00:00:00.000Z",
  });
}

function addSceneStroke(
  document: MapDocument,
  layerId: string,
  stroke: MapSceneStroke,
): MapDocument {
  const scene = document.scene;
  if (!scene) throw new Error("测试地图必须包含场景");
  return {
    ...document,
    scene: {
      ...scene,
      layers: scene.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, strokes: [...layer.strokes, stroke] }
          : layer,
      ),
    },
  };
}

describe("地图地表合成", () => {
  it("忽略不参与地表合成的植被素材笔触", () => {
    const document = createDocument();
    const withVegetation = addSceneStroke(document, "scene-vegetation", {
      id: "forest-stroke",
      layerId: "scene-vegetation",
      tool: "paint",
      brushAssetId: "forest",
      terrainMaterial: null,
      shape: "organic",
      points: [
        { x: 120, y: 180 },
        { x: 220, y: 230 },
      ],
      color: "#426a3f",
      width: 88,
      opacity: 1,
      spacing: 26,
      scatter: 0.4,
    });

    expect(mapTerrainCompositeSourceKey(withVegetation)).toBe(
      mapTerrainCompositeSourceKey(document),
    );
  });

  it("在海陆遮罩或地貌材质变化时更新合成输入键", () => {
    const document = createDocument();
    const withLand = addSceneStroke(document, "scene-terrain", {
      id: "land-stroke",
      layerId: "scene-terrain",
      tool: "paint",
      brushAssetId: null,
      terrainMaterial: null,
      shape: "organic",
      points: [
        { x: 120, y: 180 },
        { x: 220, y: 230 },
      ],
      color: "#b8ad7d",
      width: 88,
      opacity: 1,
      spacing: 26,
      scatter: 0.4,
    });
    const withMaterial = addSceneStroke(document, "scene-terrain", {
      id: "forest-material",
      layerId: "scene-terrain",
      tool: "paint",
      brushAssetId: null,
      terrainMaterial: "forest",
      shape: "round",
      points: [{ x: 180, y: 220 }],
      color: "#426a3f",
      width: 88,
      opacity: 1,
      spacing: 26,
      scatter: 0,
    });
    const sourceKey = mapTerrainCompositeSourceKey(document);

    expect(mapTerrainCompositeSourceKey(withLand)).not.toBe(sourceKey);
    expect(mapTerrainCompositeSourceKey(withMaterial)).not.toBe(sourceKey);
  });

  it("区域附加材质会进入合成输入键", () => {
    const document = createDocument();
    const scene = document.scene!;
    const withRegionMaterial: MapDocument = {
      ...document,
      scene: {
        ...scene,
        layers: scene.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "material-region",
                    layerId: layer.id,
                    kind: "land",
                    points: [
                      { x: 100, y: 100 },
                      { x: 260, y: 100 },
                      { x: 180, y: 260 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land",
                    opacity: 1,
                    edgeColor: "#5c5038",
                    edgeWidth: 3,
                    terrainMaterial: "forest",
                  },
                ],
              }
            : layer,
        ),
      },
    };

    expect(mapTerrainCompositeSourceKey(withRegionMaterial)).not.toBe(
      mapTerrainCompositeSourceKey(document),
    );
  });

  it("地形笔触切换弧线模式会使合成缓存失效", () => {
    const document = createDocument();
    const scene = document.scene!;
    const addTerrainStroke = (
      curve: "line" | "arc",
    ): MapDocument => ({
      ...document,
      scene: {
        ...scene,
        layers: scene.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                strokes: [
                  {
                    id: "curved-land",
                    layerId: layer.id,
                    tool: "paint",
                    brushAssetId: null,
                    terrainMaterial: null,
                    shape: "round",
                    curve,
                    points: [
                      { x: 80, y: 100 },
                      { x: 180, y: 220 },
                      { x: 280, y: 120 },
                    ],
                    color: "#b8ad7d",
                    width: 80,
                    opacity: 1,
                    spacing: 24,
                    scatter: 0,
                  },
                ],
              }
            : layer,
        ),
      },
    });

    expect(
      mapTerrainCompositeSourceKey(addTerrainStroke("line")),
    ).not.toBe(mapTerrainCompositeSourceKey(addTerrainStroke("arc")));
  });

  it("地形区域切换弧线模式会使填充合成缓存失效", () => {
    const document = createDocument();
    const scene = document.scene!;
    const withRegionCurve = (curve: "line" | "arc"): MapDocument => ({
      ...document,
      scene: {
        ...scene,
        layers: scene.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "curved-region",
                    layerId: layer.id,
                    kind: "land",
                    points: [
                      { x: 100, y: 100 },
                      { x: 260, y: 100 },
                      { x: 180, y: 260 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land",
                    opacity: 1,
                    edgeColor: "#5c5038",
                    edgeWidth: 3,
                    curve,
                    terrainMaterial: null,
                  },
                ],
              }
            : layer,
        ),
      },
    });

    expect(
      mapTerrainCompositeSourceKey(withRegionCurve("line")),
    ).not.toBe(mapTerrainCompositeSourceKey(withRegionCurve("arc")));
  });

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

  it("仅在地貌笔刷实际触及陆地时允许提交", () => {
    const composite = createTerrainComposite();

    expect(
      mapTerrainCompositeIntersectsBrush(composite, {
        id: "material-on-land",
        points: [{ x: 150, y: 150 }],
        width: 64,
        spacing: 24,
        shape: "round",
      }),
    ).toBe(true);
    expect(
      mapTerrainCompositeIntersectsBrush(composite, {
        id: "material-in-ocean",
        points: [{ x: 45, y: 45 }],
        width: 32,
        spacing: 20,
        shape: "organic",
      }),
    ).toBe(false);
  });

  it("水域材质使用水域掩码判定，而不是误用陆地掩码", () => {
    const composite = createTerrainComposite();

    expect(
      mapTerrainCompositeHasSurfaceAt(composite, { x: 50, y: 50 }, "water"),
    ).toBe(true);
    expect(
      mapTerrainCompositeHasSurfaceAt(composite, { x: 50, y: 50 }, "land"),
    ).toBe(false);
    expect(
      mapTerrainCompositeIntersectsBrush(
        composite,
        {
          id: "material-on-water",
          points: [{ x: 50, y: 50 }],
          width: 32,
          spacing: 20,
          shape: "round",
        },
        "water",
      ),
    ).toBe(true);
    expect(
      mapTerrainCompositeIntersectsBrush(composite, {
        id: "material-on-water-with-land-default",
        points: [{ x: 50, y: 50 }],
        width: 32,
        spacing: 20,
        shape: "round",
      }),
    ).toBe(false);
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

  it("纸纹、水面高光与材质过渡只依赖世界坐标，不依赖合成栅格", () => {
    const first = sampleMapTerrainSurfaceTexture(420.5, 260.25);
    const repeated = sampleMapTerrainSurfaceTexture(420.5, 260.25);
    const nearby = sampleMapTerrainSurfaceTexture(421.5, 260.25);

    expect(repeated).toEqual(first);
    expect(nearby).not.toEqual(first);
    expect(first.materialOpacityJitter).toBeGreaterThanOrEqual(-0.06);
    expect(first.materialOpacityJitter).toBeLessThanOrEqual(0.06);
  });

  it("区域透明度只影响颜色混合，不会以不透明颜色压住地表", () => {
    expect(mapTerrainRegionColorMix(1, 0.45)).toBeCloseTo(0.45, 8);
    expect(mapTerrainRegionColorMix(0.5, 0.45)).toBeCloseTo(0.225, 8);
    expect(mapTerrainRegionColorMix(0, 0.56)).toBe(0);
    expect(mapTerrainRegionColorMix(2, 0.56)).toBeCloseTo(0.56, 8);
  });
});
