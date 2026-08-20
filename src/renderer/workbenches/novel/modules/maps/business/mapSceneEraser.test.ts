import { describe, expect, it } from "vitest";

import { createEmptyMapScene, mapSceneSchema } from "../entities/mapSchema";
import {
  addMapSceneRegion,
  addMapSceneStroke,
  createMapSceneRegion,
  createMapSceneStroke,
} from "./mapScene";
import { eraseMapSceneContent } from "./mapSceneEraser";

describe("mapSceneEraser", () => {
  it("只裁切当前图层命中的笔触，不触碰其他绘图层", () => {
    const base = createEmptyMapScene();
    const terrain = base.layers.find((layer) => layer.id === "scene-terrain")!;
    const vegetation = base.layers.find(
      (layer) => layer.id === "scene-vegetation",
    )!;
    const material = createMapSceneStroke({
      id: "material-desert-band",
      layerId: terrain.id,
      terrainMaterial: "desert",
      points: [
        { x: 120, y: 220 },
        { x: 460, y: 220 },
      ],
      color: "#c9a865",
      width: 48,
      spacing: 24,
    });
    const forest = createMapSceneStroke({
      id: "forest-preserved",
      layerId: vegetation.id,
      brushAssetId: "forest",
      points: [{ x: 280, y: 220 }],
      color: "#3f7650",
      width: 72,
    });
    const scene = addMapSceneStroke(addMapSceneStroke(base, material), forest);

    const erased = eraseMapSceneContent(scene, {
      layerId: terrain.id,
      points: [{ x: 280, y: 220 }],
      width: 112,
    });

    const terrainStrokes = erased.layers.find(
      (layer) => layer.id === terrain.id,
    )!.strokes;
    expect(terrainStrokes).toHaveLength(2);
    expect(terrainStrokes.map((stroke) => stroke.id)).toContain(material.id);
    expect(
      erased.layers.find((layer) => layer.id === vegetation.id)?.strokes,
    ).toEqual([forest]);
    expect(mapSceneSchema.parse(erased)).toEqual(erased);
  });

  it("不生成水域、遮罩或新的擦除笔触", () => {
    const base = createEmptyMapScene();
    const terrain = base.layers.find((layer) => layer.id === "scene-terrain")!;
    const land = createMapSceneRegion({
      id: "existing-land-region",
      layerId: terrain.id,
      kind: "land",
      points: [
        { x: 120, y: 160 },
        { x: 420, y: 180 },
        { x: 220, y: 360 },
      ],
    });
    const stroke = createMapSceneStroke({
      id: "terrain-paint",
      layerId: terrain.id,
      points: [{ x: 220, y: 240 }],
      color: "#b8ad7d",
      width: 96,
    });
    const scene = addMapSceneStroke(addMapSceneRegion(base, land), stroke);

    const erased = eraseMapSceneContent(scene, {
      layerId: terrain.id,
      points: [{ x: 220, y: 240 }],
      width: 112,
    });

    const layer = erased.layers.find((item) => item.id === terrain.id)!;
    expect(layer.regions).toEqual([land]);
    expect(layer.strokes).toEqual([]);
    expect(
      erased.layers
        .flatMap((item) => item.regions)
        .filter((region) => region.kind === "water"),
    ).toEqual([]);
    expect(
      erased.layers
        .flatMap((item) => item.strokes)
        .some((item) => item.tool === "erase"),
    ).toBe(false);
  });

  it("无命中时保留当前图层的既有内容", () => {
    const base = createEmptyMapScene();
    const effects = base.layers.find((layer) => layer.id === "scene-effects")!;
    const stroke = createMapSceneStroke({
      id: "effect-retained",
      layerId: effects.id,
      points: [{ x: 700, y: 540 }],
      color: "#735d8b",
      width: 64,
    });
    const scene = addMapSceneStroke(base, stroke);

    const erased = eraseMapSceneContent(scene, {
      layerId: effects.id,
      points: [{ x: 260, y: 220 }],
      width: 112,
    });

    expect(
      erased.layers.find((layer) => layer.id === effects.id)?.strokes,
    ).toEqual([stroke]);
  });
});
