import { describe, expect, it } from "vitest";

import {
  applyGeneratorCandidate,
  generateFantasyMapCandidate,
  generateRedBlobCandidate,
  importAzgaarCandidate,
} from "./mapGenerators";
import { expandMapCanvasToContent } from "./mapCanvasBounds";
import {
  createEmptyMapDocument,
  mapDocumentSchema,
  mapTerrainMaterialSchema,
  type MapTerrainMaterial,
} from "../entities/mapSchema";

function document() {
  return createEmptyMapDocument({
    id: "map-1",
    name: "九州",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("mapGenerators", () => {
  it("Red Blob 同种子生成确定的合法大陆候选", () => {
    const first = generateRedBlobCandidate({
      seed: "jiuzhou",
      document: document(),
      layerId: "layer-main",
      landmassCount: 3,
    });
    const second = generateRedBlobCandidate({
      seed: "jiuzhou",
      document: document(),
      layerId: "layer-main",
      landmassCount: 3,
    });

    expect(first).toEqual(second);
    expect(first.features).toHaveLength(3);
    const applied = applyGeneratorCandidate(document(), first);
    expect(mapDocumentSchema.parse(applied)).toEqual(applied);
    expect(
      applied.scene?.layers.find((layer) => layer.id === "scene-terrain")
        ?.regions,
    ).toHaveLength(3);
  });

  it("Fantasy Map 候选生成连续大陆、区域、河流和聚落", () => {
    const candidate = generateFantasyMapCandidate({
      seed: "world-architecture",
      document: document(),
      layerId: "layer-main",
      landmassCount: 2,
      regionCount: 5,
      riverCount: 4,
      spatialNames: ["九州"],
      factionNames: ["天衡盟", "北境"],
      placeNames: ["云城", "临海关"],
      terrainKeywords: ["山脉"],
    });

    expect(candidate.generatorId).toBe("fantasy-map");
    expect(
      candidate.features.some((feature) => feature.props.terrain === "coast"),
    ).toBe(true);
    expect(
      candidate.features.filter(
        (feature) => feature.props.terrain === "region",
      ),
    ).toHaveLength(5);
    expect(
      candidate.features.filter((feature) => feature.props.terrain === "river"),
    ).toHaveLength(4);
    expect(
      candidate.features.some(
        (feature) =>
          feature.props.terrain === "road" &&
          feature.props.routeStyle === "road",
      ),
    ).toBe(true);
    expect(candidate.features.some((feature) => feature.name === "云城")).toBe(
      true,
    );
    expect(
      candidate.features.every((feature) => feature.points.length > 0),
    ).toBe(true);
    const applied = applyGeneratorCandidate(document(), candidate);
    expect(mapDocumentSchema.parse(applied)).toBeTruthy();
    expect(
      applied.scene?.layers.find((layer) => layer.id === "scene-terrain")
        ?.regions,
    ).toHaveLength(2);
    const generatedArtwork = applied.artwork.layers
      .flatMap((layer) => layer.stamps)
      .filter((stamp) => stamp.id.startsWith("generated-artwork-"));
    expect(
      generatedArtwork.some((stamp) => stamp.assetId === "mountain-range"),
    ).toBe(true);
    expect(generatedArtwork.some((stamp) => stamp.assetId === "forest")).toBe(
      true,
    );
    expect(generatedArtwork.some((stamp) => stamp.assetId === "city")).toBe(
      true,
    );
    expect(
      applied.scene?.layers
        .find((layer) => layer.id === "scene-terrain")
        ?.strokes.some(
          (stroke) =>
            stroke.terrainMaterial === "forest" && stroke.shape === "organic",
        ),
    ).toBe(true);
  });

  it("应用候选时把湖泊写入水系区域，并把世界气候写入可编辑材质", () => {
    const candidate = generateFantasyMapCandidate({
      seed: "world-biomes",
      document: document(),
      layerId: "layer-main",
      regionCount: 7,
      riverCount: 8,
      terrainKeywords: ["冰原", "沙漠", "湿地", "火山", "森林"],
    });
    expect(
      candidate.features.some((feature) => feature.props.terrain === "lake"),
    ).toBe(true);
    expect(
      candidate.features.some(
        (feature) => feature.props.terrain === "tributary",
      ),
    ).toBe(true);

    const applied = applyGeneratorCandidate(document(), candidate);
    expect(mapDocumentSchema.parse(applied)).toEqual(applied);
    expect(
      applied.scene?.layers.find((layer) => layer.id === "scene-water")
        ?.regions,
    ).not.toHaveLength(0);
    const materialIds = new Set<MapTerrainMaterial>(
      applied.scene?.layers
        .flatMap((layer) => layer.strokes)
        .map((stroke) => stroke.terrainMaterial)
        .filter(
          (material): material is MapTerrainMaterial =>
            mapTerrainMaterialSchema.safeParse(material).success,
        ),
    );
    ["desert", "snow", "swamp", "volcanic"].forEach((material) =>
      expect(materialIds.has(material as MapTerrainMaterial)).toBe(true),
    );
    expect(
      applied.artwork.layers
        .flatMap((layer) => layer.stamps)
        .some((stamp) => stamp.assetId === "snow-peak"),
    ).toBe(true);
    expect(
      applied.artwork.layers
        .flatMap((layer) => layer.stamps)
        .some((stamp) => stamp.assetId === "bridge"),
    ).toBe(true);
    expect(
      applied.features.some((feature) => feature.props.symbol === "port"),
    ).toBe(true);
  });

  it("导入 Azgaar Full/Minimal JSON 中的地点、标记和路线", () => {
    const candidate = importAzgaarCandidate({
      fileName: "nine-realms.json",
      document: document(),
      layerId: "layer-main",
      content: JSON.stringify({
        info: { mapName: "九州", seed: "42" },
        pack: {
          burgs: [{ i: 1, name: "天京", x: 320, y: 240 }],
          markers: [{ i: 1, x: 420, y: 340, fill: "#aa6633" }],
          routes: [
            {
              i: 1,
              name: "天路",
              points: [
                [320, 240, 1],
                [420, 340, 2],
              ],
            },
          ],
          rivers: [],
        },
      }),
    });

    expect(candidate.title).toBe("九州");
    expect(candidate.seed).toBe("42");
    expect(candidate.features.map((feature) => feature.kind)).toEqual([
      "marker",
      "marker",
      "route",
    ]);
    expect(
      mapDocumentSchema.parse(applyGeneratorCandidate(document(), candidate)),
    ).toBeTruthy();
  });

  it("导入 Azgaar 越界坐标时保留事实并允许画布随后扩展", () => {
    const current = document();
    const candidate = importAzgaarCandidate({
      fileName: "out-of-bounds.json",
      document: current,
      layerId: "layer-main",
      content: JSON.stringify({
        pack: {
          burgs: [{ i: 1, name: "边境城", x: 2_200, y: 1_500 }],
          routes: [
            {
              i: 2,
              points: [
                [1_700, 1_050],
                [2_400, 1_650],
              ],
            },
          ],
        },
      }),
    });

    expect(candidate.features[0]?.points[0]).toEqual({ x: 2_200, y: 1_500 });
    const applied = applyGeneratorCandidate(current, candidate);
    const expanded = expandMapCanvasToContent(applied);
    expect(expanded.canvas.width).toBeGreaterThan(2_200);
    expect(expanded.canvas.height).toBeGreaterThan(1_500);
    expect(expanded.features[0]?.points[0]).toEqual({ x: 2_200, y: 1_500 });
  });

  it("导入 Azgaar GeoJSON 并把经纬度归一化到本地画布", () => {
    const candidate = importAzgaarCandidate({
      fileName: "routes.geojson",
      document: document(),
      layerId: "layer-main",
      content: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: 1, name: "海路" },
            geometry: {
              type: "LineString",
              coordinates: [
                [-10, 20],
                [30, 40],
              ],
            },
          },
          {
            type: "Feature",
            properties: { id: 2, name: "港口" },
            geometry: { type: "Point", coordinates: [10, 30] },
          },
        ],
      }),
    });

    expect(candidate.features[0]).toMatchObject({
      kind: "route",
      name: "海路",
    });
    expect(candidate.features[1]?.points[0]).toEqual({ x: 800, y: 500 });
    for (const point of candidate.features[0]!.points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1600);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1000);
    }
  });

  it("SVG 作为底图候选导入且不复制地图事实", () => {
    const candidate = importAzgaarCandidate({
      fileName: "world.svg",
      document: document(),
      layerId: "layer-main",
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><path d="M0 0"/></svg>',
    });

    expect(candidate.features).toEqual([]);
    expect(candidate.canvas?.backgroundImage).toMatch(
      /^data:image\/svg\+xml;base64,/u,
    );
    expect(candidate.canvas).toMatchObject({
      width: 1600,
      height: 1000,
      backgroundImageWidth: 1600,
      backgroundImageHeight: 1000,
    });
  });

  it("SVG 缺少 width/height 时使用 viewBox 作为自动画布尺寸", () => {
    const candidate = importAzgaarCandidate({
      fileName: "viewbox.svg",
      document: document(),
      layerId: "layer-main",
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 1500"><path d="M0 0"/></svg>',
    });

    expect(candidate.canvas).toMatchObject({
      width: 2400,
      height: 1500,
      backgroundImageWidth: 2400,
      backgroundImageHeight: 1500,
    });
  });
});
