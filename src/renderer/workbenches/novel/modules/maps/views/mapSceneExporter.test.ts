import { describe, expect, it } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import { addMapSceneStroke, createMapSceneStroke } from "../business/mapScene";
import { createEmptyMapScene } from "../entities/mapSchema";
import { createMapArtworkAssetCatalog } from "../business/mapArtwork";
import {
  collectMapArtworkExportVariants,
  mapCanvasRenderSize,
  mapPngExportFileName,
} from "./mapSceneExporter";

describe("mapSceneExporter", () => {
  it("生成可下载的高清地图文件名", () => {
    expect(mapPngExportFileName("  北境：远征/终稿  ")).toBe(
      "北境：远征-终稿-高清.png",
    );
    expect(mapPngExportFileName("...")).toBe("地图-高清.png");
  });

  it("候选预览限制像素尺寸，但不改变地图世界坐标尺寸", () => {
    expect(
      mapCanvasRenderSize({ width: 3_200, height: 2_000 }, { maxEdge: 960 }),
    ).toEqual({
      worldWidth: 3_200,
      worldHeight: 2_000,
      outputWidth: 960,
      outputHeight: 600,
      scale: 0.3,
    });
    expect(
      mapCanvasRenderSize({ width: 640, height: 400 }, { maxEdge: 960 }),
    ).toEqual({
      worldWidth: 640,
      worldHeight: 400,
      outputWidth: 640,
      outputHeight: 400,
      scale: 1,
    });
  });

  it("预加载连续素材的改色变体，保证导出不丢失改色笔刷", () => {
    const document = createEmptyMapDocument({
      id: "export-brush-color",
      name: "导出改色笔刷",
      projectionType: "continent",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    const stroke = createMapSceneStroke({
      id: "stroke-forest-tinted",
      layerId: "scene-vegetation",
      brushAssetId: "forest",
      points: [
        { x: 120, y: 160 },
        { x: 360, y: 280 },
      ],
      color: "#234f38",
      width: 96,
    });
    const map = {
      ...document,
      scene: addMapSceneStroke(createEmptyMapScene(), stroke),
    };
    const variants = collectMapArtworkExportVariants(
      map,
      createMapArtworkAssetCatalog(map.artwork),
    );

    expect(
      variants.some((variant) => variant.cacheKey.startsWith("tint:forest:")),
    ).toBe(true);
  });
});
