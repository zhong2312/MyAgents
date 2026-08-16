import { describe, expect, it } from "vitest";

import {
  addMapSceneStroke,
  addMapSceneRegion,
  createMapSceneRegion,
  createMapSceneStroke,
  isMapTerrainMaskStroke,
  isMapTerrainMaterialStroke,
  moveMapSceneLayer,
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
  mapSceneSchema,
  mapSceneStrokeSchema,
} from "../entities/mapSchema";

describe("mapScene", () => {
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
});
