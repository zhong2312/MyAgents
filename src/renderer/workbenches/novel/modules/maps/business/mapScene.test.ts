import { describe, expect, it } from "vitest";

import {
  addMapSceneStroke,
  addMapSceneRegion,
  createMapSceneRegion,
  createMapSceneStroke,
  mapSceneHasLandSurface,
  mapSceneHasWaterSurface,
  isMapTerrainMaskStroke,
  isMapTerrainMaterialStroke,
  isMapTerrainWaterStroke,
  moveMapSceneLayer,
  removeMapSceneLayer,
  removeMapSceneRegion,
  removeMapSceneStroke,
  updateMapSceneRegion,
  updateMapSceneStroke,
  updateMapTerrainStyle,
  sceneLayerIdForKind,
  sceneLayerKindForComponentCategory,
} from "./mapScene";
import {
  createEmptyMapScene,
  mapSceneLayerSupportsRegion,
  mapSceneSchema,
  mapSceneStrokeSchema,
} from "../entities/mapSchema";

describe("mapScene", () => {
  it("保留生成区域的来源要素引用", () => {
    const region = createMapSceneRegion({
      id: "region-derived-land",
      layerId: "scene-terrain",
      sourceFeatureId: "feature-derived-land",
      kind: "land",
      points: [
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        { x: 120, y: 80 },
      ],
    });

    expect(region.sourceFeatureId).toBe("feature-derived-land");
  });

  it("制图修饰笔刷进入地图效果层，不污染地形层", () => {
    expect(sceneLayerKindForComponentCategory("cartography")).toBe("effects");
    expect(sceneLayerIdForKind("effects")).toBe("scene-effects");
  });

  it("只将真实海陆事实识别为可叠加材质的陆地表面", () => {
    const empty = createEmptyMapScene();
    expect(mapSceneHasLandSurface(empty)).toBe(false);

    const withLandRegion = addMapSceneRegion(
      empty,
      createMapSceneRegion({
        id: "material-land",
        layerId: "scene-terrain",
        kind: "land",
        points: [
          { x: 120, y: 160 },
          { x: 360, y: 180 },
          { x: 240, y: 340 },
        ],
      }),
    );
    expect(mapSceneHasLandSurface(withLandRegion)).toBe(true);

    const withHiddenLand = {
      ...withLandRegion,
      layers: withLandRegion.layers.map((layer) =>
        layer.id === "scene-terrain" ? { ...layer, visible: false } : layer,
      ),
    };
    expect(mapSceneHasLandSurface(withHiddenLand)).toBe(false);
  });

  it("仅将显式水域事实交给地表合成器，空白区域交给画布背景", () => {
    const empty = createEmptyMapScene();
    const waterStroke = createMapSceneStroke({
      id: "terrain-water",
      layerId: "scene-terrain",
      tool: "erase",
      points: [{ x: 180, y: 220 }],
      color: "#5d9caf",
      width: 96,
    });
    const waterRegion = createMapSceneRegion({
      id: "lake-region",
      layerId: "scene-water",
      kind: "water",
      points: [
        { x: 120, y: 160 },
        { x: 300, y: 180 },
        { x: 210, y: 320 },
      ],
    });

    expect(mapSceneHasWaterSurface(empty)).toBe(false);
    expect(isMapTerrainWaterStroke("terrain", waterStroke)).toBe(true);
    expect(mapSceneHasWaterSurface(addMapSceneStroke(empty, waterStroke))).toBe(
      true,
    );
    expect(mapSceneHasWaterSurface(addMapSceneRegion(empty, waterRegion))).toBe(
      true,
    );
  });

  it("按构件分类落到独立场景图层", () => {
    expect(sceneLayerKindForComponentCategory("mountain")).toBe("relief");
    expect(sceneLayerKindForComponentCategory("vegetation")).toBe("vegetation");
    expect(sceneLayerIdForKind("water")).toBe("scene-water");
  });

  it("允许视觉覆盖层调整前后景，但锚定地表和水域基础层", () => {
    const scene = createEmptyMapScene();
    const moved = moveMapSceneLayer(scene, "scene-vegetation", 1);

    expect(moved.layers.map((layer) => layer.id)).toEqual([
      "scene-terrain",
      "scene-water",
      "scene-relief",
      "scene-civilization",
      "scene-vegetation",
      "scene-labels",
      "scene-effects",
    ]);
    expect(moveMapSceneLayer(scene, "scene-terrain", 1)).toBe(scene);
    expect(moveMapSceneLayer(scene, "scene-relief", -1)).toBe(scene);
  });

  it("生成来源层可以移动和删除，不影响内置海陆层", () => {
    const scene = createEmptyMapScene();
    const sourceLayer = {
      id: "scene-generator-agent-azgaar",
      name: "Agent + Azgaar · 地形底稿",
      kind: "terrain" as const,
      visible: true,
      locked: false,
      opacity: 1,
      regions: [],
      strokes: [],
    };
    const withSource = {
      ...scene,
      layers: [
        ...scene.layers,
        {
          ...sourceLayer,
          regions: [
            createMapSceneRegion({
              id: "region-generated",
              layerId: sourceLayer.id,
              kind: "land",
              points: [
                { x: 1, y: 1 },
                { x: 2, y: 1 },
                { x: 1, y: 2 },
              ],
            }),
          ],
        },
      ],
    };

    const moved = moveMapSceneLayer(withSource, sourceLayer.id, -1);
    expect(moved.layers.map((layer) => layer.id)).toContain(sourceLayer.id);
    expect(moveMapSceneLayer(withSource, "scene-terrain", 1)).toBe(withSource);

    const removed = removeMapSceneLayer(moved, sourceLayer.id);
    expect(removed.layers.map((layer) => layer.id)).not.toContain(
      sourceLayer.id,
    );
    expect(removed.layers.map((layer) => layer.id)).toEqual(
      scene.layers.map((layer) => layer.id),
    );
    expect(removeMapSceneLayer(scene, "scene-terrain")).toBe(scene);
  });

  it("地形合成参数保存在场景中并可独立调整", () => {
    const scene = createEmptyMapScene();
    const next = updateMapTerrainStyle(scene, {
      waterColor: "#1f5c78",
      shelfWidth: 22,
      textureStrength: 0.8,
    });

    expect(next.terrainStyle).toMatchObject({
      landColor: "#b8ad7d",
      waterColor: "#1f5c78",
      shelfWidth: 22,
      textureStrength: 0.8,
    });
    expect(scene.terrainStyle.waterColor).toBe("#2c6a81");
  });

  it("笔刷动作作为一个可撤销的笔触对象保存", () => {
    const scene = createEmptyMapScene();
    const stroke = createMapSceneStroke({
      id: "stroke-forest-1",
      layerId: "scene-vegetation",
      brushAssetId: "forest",
      points: [
        { x: 120, y: 160 },
        { x: 180, y: 200 },
      ],
      color: "#3f7650",
      width: 96,
    });
    const next = addMapSceneStroke(scene, stroke);
    expect(
      next.layers.find((layer) => layer.id === "scene-vegetation")?.strokes,
    ).toEqual([
      expect.objectContaining({
        id: "stroke-forest-1",
        brushAssetId: "forest",
        spacing: 30.72,
        shape: "round",
      }),
    ]);
    const removed = removeMapSceneStroke(next, "stroke-forest-1");
    expect(
      removed.layers.find((layer) => layer.id === "scene-vegetation")?.strokes,
    ).toEqual([]);
    const edited = updateMapSceneStroke(next, "stroke-forest-1", {
      width: 128,
      opacity: 0.6,
      points: [{ x: 150, y: 190 }],
    });
    expect(
      edited.layers.find((layer) => layer.id === "scene-vegetation")
        ?.strokes[0],
    ).toEqual(
      expect.objectContaining({
        width: 128,
        opacity: 0.6,
        points: [{ x: 150, y: 190 }],
      }),
    );
  });

  it("素材笔刷的密度与散布作为笔触事实保存，编辑后可重建", () => {
    const scene = createEmptyMapScene();
    const brush = createMapSceneStroke({
      id: "stroke-forest-density",
      layerId: "scene-vegetation",
      brushAssetId: "forest",
      points: [
        { x: 120, y: 160 },
        { x: 320, y: 260 },
      ],
      color: "#3f7650",
      width: 96,
      spacing: 88,
      scatter: 0.2,
    });
    const edited = updateMapSceneStroke(
      addMapSceneStroke(scene, brush),
      brush.id,
      { spacing: 28, scatter: 0.75 },
    );

    expect(
      edited.layers.find((layer) => layer.id === "scene-vegetation")
        ?.strokes[0],
    ).toEqual(
      expect.objectContaining({
        brushAssetId: "forest",
        spacing: 28,
        scatter: 0.75,
      }),
    );
    expect(mapSceneSchema.safeParse(edited).success).toBe(true);
  });

  it("只有地形笔触和旧擦除笔触参与海陆遮罩", () => {
    const terrainPaint = createMapSceneStroke({
      id: "terrain-paint",
      layerId: "scene-terrain",
      points: [{ x: 120, y: 160 }],
      color: "#b8ad7d",
      width: 96,
    });
    const legacyErase = createMapSceneStroke({
      id: "legacy-erase",
      layerId: "scene-effects",
      tool: "erase",
      points: [{ x: 180, y: 200 }],
      color: "#000000",
      width: 64,
    });
    const forestBrush = createMapSceneStroke({
      id: "forest-brush",
      layerId: "scene-vegetation",
      brushAssetId: "forest",
      points: [{ x: 220, y: 240 }],
      color: "#3f7650",
      width: 72,
    });
    const desertMaterial = createMapSceneStroke({
      id: "desert-material",
      layerId: "scene-terrain",
      terrainMaterial: "desert",
      points: [{ x: 260, y: 280 }],
      color: "#c9a865",
      width: 120,
    });

    expect(isMapTerrainMaskStroke("terrain", terrainPaint)).toBe(true);
    expect(isMapTerrainMaskStroke("effects", legacyErase)).toBe(true);
    expect(isMapTerrainMaskStroke("vegetation", forestBrush)).toBe(false);
    expect(isMapTerrainMaskStroke("terrain", desertMaterial)).toBe(false);
    expect(isMapTerrainMaterialStroke("terrain", desertMaterial)).toBe(true);
    expect(isMapTerrainMaterialStroke("vegetation", desertMaterial)).toBe(
      false,
    );
  });

  it("旧笔触缺少材质字段时默认保持原有语义", () => {
    const parsed = mapSceneStrokeSchema.parse({
      id: "legacy-stroke",
      layerId: "scene-terrain",
      tool: "paint",
      brushAssetId: null,
      points: [{ x: 120, y: 160 }],
      color: "#b8ad7d",
      width: 96,
      opacity: 1,
      spacing: 32,
      scatter: 0,
    });

    expect(parsed.terrainMaterial).toBeNull();
    expect(parsed.shape).toBe("round");
  });

  it("材质笔触不能写入非地形层", () => {
    const scene = createEmptyMapScene();
    const materialStroke = createMapSceneStroke({
      id: "invalid-material-layer",
      layerId: "scene-vegetation",
      terrainMaterial: "forest",
      points: [{ x: 160, y: 180 }],
      color: "#667d55",
      width: 96,
    });
    const invalid = {
      ...scene,
      layers: scene.layers.map((layer) =>
        layer.id === "scene-vegetation"
          ? { ...layer, strokes: [materialStroke] }
          : layer,
      ),
    };

    expect(mapSceneSchema.safeParse(invalid).success).toBe(false);
  });

  it("海陆区域只可进入海陆底层，避免覆盖层改变海陆遮罩", () => {
    const scene = createEmptyMapScene();
    const invalidRegion = createMapSceneRegion({
      id: "invalid-land-overlay",
      layerId: "scene-vegetation",
      kind: "land",
      points: [
        { x: 120, y: 160 },
        { x: 260, y: 180 },
        { x: 220, y: 290 },
      ],
    });
    const invalid = {
      ...scene,
      layers: scene.layers.map((layer) =>
        layer.id === "scene-vegetation"
          ? { ...layer, regions: [invalidRegion] }
          : layer,
      ),
    };
    const waterRegion = createMapSceneRegion({
      id: "water-bottom-layer",
      layerId: "scene-water",
      kind: "water",
      points: [
        { x: 120, y: 160 },
        { x: 260, y: 180 },
        { x: 220, y: 290 },
      ],
    });

    expect(mapSceneLayerSupportsRegion("terrain", "land")).toBe(true);
    expect(mapSceneLayerSupportsRegion("terrain", "water")).toBe(true);
    expect(mapSceneLayerSupportsRegion("water", "water")).toBe(true);
    expect(mapSceneLayerSupportsRegion("water", "land")).toBe(false);
    expect(mapSceneSchema.safeParse(invalid).success).toBe(false);
    expect(addMapSceneRegion(scene, invalidRegion)).toBe(scene);
    expect(
      mapSceneSchema.safeParse(addMapSceneRegion(scene, waterRegion)).success,
    ).toBe(true);
  });

  it("连续海陆区域独立保存、可移动修改与删除", () => {
    const scene = createEmptyMapScene();
    const region = createMapSceneRegion({
      id: "region-land-1",
      layerId: "scene-terrain",
      kind: "land",
      points: [
        { x: 120, y: 160 },
        { x: 260, y: 180 },
        { x: 220, y: 290 },
      ],
    });
    const next = addMapSceneRegion(scene, region);
    expect(
      next.layers.find((layer) => layer.id === "scene-terrain")?.regions,
    ).toEqual([
      expect.objectContaining({
        id: "region-land-1",
        texture: "paper-land",
        edgeWidth: 3,
      }),
    ]);

    const edited = updateMapSceneRegion(next, "region-land-1", {
      fill: "#c9bc89",
      opacity: 0.7,
    });
    expect(
      edited.layers.find((layer) => layer.id === "scene-terrain")?.regions[0],
    ).toEqual(expect.objectContaining({ fill: "#c9bc89", opacity: 0.7 }));

    const removed = removeMapSceneRegion(edited, "region-land-1");
    expect(
      removed.layers.find((layer) => layer.id === "scene-terrain")?.regions,
    ).toEqual([]);
  });

  it("区域附加材质必须匹配海陆表面", () => {
    const scene = createEmptyMapScene();
    const landPoints = [
      { x: 120, y: 160 },
      { x: 260, y: 180 },
      { x: 220, y: 290 },
    ];
    const land = createMapSceneRegion({
      id: "material-land",
      layerId: "scene-terrain",
      kind: "land",
      points: landPoints,
      terrainMaterial: "forest",
    });
    const invalid = createMapSceneRegion({
      id: "material-land-water",
      layerId: "scene-terrain",
      kind: "land",
      points: landPoints,
      terrainMaterial: "deep-sea",
    });
    expect(addMapSceneRegion(scene, land)).not.toBe(scene);
    expect(addMapSceneRegion(scene, invalid)).toBe(scene);
    expect(
      mapSceneSchema.safeParse(addMapSceneRegion(scene, land)).success,
    ).toBe(true);

    const withLand = addMapSceneRegion(scene, land);
    expect(
      updateMapSceneRegion(withLand, "material-land", {
        terrainMaterial: "deep-sea",
      }),
    ).toBe(withLand);
  });
});
