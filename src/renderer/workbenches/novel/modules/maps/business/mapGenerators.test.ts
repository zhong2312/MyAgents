import { describe, expect, it } from "vitest";

import {
  applyGeneratorCandidate,
  convertMapToFantasyStyleDocument,
  generateFantasyMapCandidate,
  generateRedBlobCandidate,
  importAzgaarCandidate,
  mapGeneratorSourceLayerIds,
  previewGeneratorCandidate,
} from "./mapGenerators";
import { expandMapCanvasToContent } from "./mapCanvasBounds";
import {
  createEmptyMapDocument,
  mapDocumentSchema,
  mapTerrainMaterialSchema,
  type MapDocument,
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

function distanceToSegment(
  point: { readonly x: number; readonly y: number },
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): number {
  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  const lengthSquared = horizontal * horizontal + vertical * vertical;
  if (lengthSquared <= Number.EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * horizontal + (point.y - start.y) * vertical) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + horizontal * projection),
    point.y - (start.y + vertical * projection),
  );
}

function distanceToPath(
  point: { readonly x: number; readonly y: number },
  path: readonly { readonly x: number; readonly y: number }[],
): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1)
    return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y);
  return path
    .slice(1)
    .reduce(
      (nearest, end, index) =>
        Math.min(nearest, distanceToSegment(point, path[index]!, end)),
      Number.POSITIVE_INFINITY,
    );
}

describe("mapGenerators", () => {
  it("旧地图转换为玄幻风格时保留几何和实体引用，并移除跨地图素材路径", () => {
    const source = document();
    const converted = convertMapToFantasyStyleDocument(
      {
        ...source,
        features: [
          {
            id: "location-cloud-city",
            kind: "marker",
            name: "云中城",
            entityRef: { kind: "location", id: "cloud-city" },
            layerId: "layer-main",
            points: [{ x: 120, y: 180 }],
            timeFrom: null,
            timeTo: null,
            props: { terrain: "city" },
            description: "旧城",
          },
        ],
        artwork: {
          ...source.artwork,
          assets: [
            {
              id: "old-project-asset",
              name: "旧素材",
              path: "world/maps/assets/map-1/artwork/old-project-asset.png",
              mimeType: "image/png",
              width: 64,
              height: 64,
              brush: true,
            },
          ],
          layers: source.artwork.layers.map((layer) => ({
            ...layer,
            stamps: [
              ...layer.stamps,
              {
                id: "old-stamp",
                layerId: layer.id,
                assetId: "old-project-asset",
                x: 10,
                y: 10,
                variant: 0,
                scale: 1,
                rotation: 0,
                opacity: 1,
                flipX: false,
                flipY: false,
              },
            ],
          })),
        },
      },
      "map-1-fantasy",
      "九州 · 中文玄幻风格",
    );
    expect(converted.id).toBe("map-1-fantasy");
    expect(converted.canvas.backgroundPreset).toBe("parchment");
    expect(converted.features[0]).toMatchObject({
      points: [{ x: 120, y: 180 }],
      entityRef: { kind: "location", id: "cloud-city" },
      props: {
        generator: "fantasy-style-conversion",
        showLabel: "true",
      },
    });
    expect(converted.artwork.assets).toHaveLength(0);
    expect(
      converted.artwork.layers.every((layer) => layer.stamps.length === 0),
    ).toBe(true);
    expect(mapDocumentSchema.parse(converted)).toEqual(converted);
  });

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
    expect(first.features.every((feature) => feature.kind === "area")).toBe(
      true,
    );
    const applied = applyGeneratorCandidate(document(), first);
    expect(mapDocumentSchema.parse(applied)).toEqual(applied);
    const sourceLayerIds = mapGeneratorSourceLayerIds("red-blob");
    expect(
      applied.scene?.layers.find((layer) => layer.id === sourceLayerIds.scene)
        ?.regions,
    ).toHaveLength(3);
    expect(
      applied.features.every(
        (feature) => feature.layerId === sourceLayerIds.feature,
      ),
    ).toBe(true);
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
      candidate.features
        .filter((feature) =>
          ["coast", "island", "region", "lake", "biome"].includes(
            feature.props.terrain ?? "",
          ),
        )
        .every((feature) => feature.kind === "area"),
    ).toBe(true);
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
    const sourceLayerIds = mapGeneratorSourceLayerIds("fantasy-map");
    expect(
      applied.scene?.layers
        .find((layer) => layer.id === sourceLayerIds.scene)
        ?.regions.filter((region) => region.kind === "land"),
    ).toHaveLength(2);
    const generatedArtwork = applied.artwork.layers
      .flatMap((layer) => layer.stamps)
      .filter((stamp) => stamp.id.startsWith("generated-artwork-"));
    const reliefLayer = applied.artwork.layers.find(
      (layer) => layer.id === sourceLayerIds.relief,
    );
    const vegetationLayer = applied.artwork.layers.find(
      (layer) => layer.id === sourceLayerIds.vegetation,
    );
    expect(reliefLayer).toMatchObject({ kind: "relief" });
    expect(vegetationLayer).toMatchObject({ kind: "vegetation" });
    expect(
      reliefLayer?.stamps.some((stamp) => stamp.assetId === "mountain-range"),
    ).toBe(true);
    expect(
      vegetationLayer?.stamps.some((stamp) => stamp.assetId === "forest"),
    ).toBe(true);
    const generatedForestFeatures = candidate.features.filter(
      (feature) => feature.props.terrain === "forest",
    );
    generatedForestFeatures.forEach((feature) => {
      const forestStamps = vegetationLayer?.stamps.filter(
        (stamp) =>
          stamp.assetId === "forest" &&
          stamp.id.startsWith(`generated-artwork-${feature.id}-`),
      );
      expect(forestStamps?.length).toBeGreaterThanOrEqual(5);
    });
    expect(
      generatedArtwork.some((stamp) =>
        ["capital", "city", "village", "port", "bridge"].includes(
          stamp.assetId,
        ),
      ),
    ).toBe(false);
    expect(
      applied.features
        .filter((feature) => feature.props.settlementType)
        .every(
          (feature) => feature.props.component === feature.props.settlementType,
        ),
    ).toBe(true);
    expect(
      applied.features.some((feature) => feature.props.component === "bridge"),
    ).toBe(true);
    expect(
      applied.artwork.layers.find(
        (layer) => layer.id === sourceLayerIds.artwork,
      ),
    ).toBeUndefined();
    expect(
      generatedArtwork.every((stamp) =>
        [sourceLayerIds.relief, sourceLayerIds.vegetation].includes(
          stamp.layerId,
        ),
      ),
    ).toBe(true);
    expect(
      applied.artwork.layers
        .filter(
          (layer) =>
            layer.id === sourceLayerIds.relief ||
            layer.id === sourceLayerIds.vegetation,
        )
        .every((layer) => layer.visible && !layer.locked),
    ).toBe(true);
    expect(
      applied.artwork.layers
        .filter(
          (layer) =>
            layer.id === sourceLayerIds.relief ||
            layer.id === sourceLayerIds.vegetation,
        )
        .map((layer) => layer.stamps.length)
        .every((count) => count > 0),
    ).toBe(true);
    expect(
      applied.scene?.layers
        .find((layer) => layer.id === sourceLayerIds.scene)
        ?.strokes.some(
          (stroke) =>
            stroke.terrainMaterial === "forest" && stroke.shape === "organic",
        ),
    ).toBe(true);
  });

  it("Fantasy Map 沿山脊生成稳定、连续且可独立编辑的山体", () => {
    const candidate = generateFantasyMapCandidate({
      seed: "snow-ridge-artwork",
      document: document(),
      layerId: "layer-main",
      landmassCount: 1,
      regionCount: 2,
      riverCount: 1,
      terrainKeywords: ["雪山"],
    });
    const first = applyGeneratorCandidate(document(), candidate);
    const second = applyGeneratorCandidate(document(), candidate);
    const sourceLayerIds = mapGeneratorSourceLayerIds(candidate.generatorId);
    const mountainFeatures = candidate.features.filter(
      (feature) => feature.props.terrain === "mountain",
    );

    expect(mountainFeatures.length).toBeGreaterThan(0);
    mountainFeatures.forEach((feature) => {
      const appliedRidge = first.features.find(
        (appliedFeature) => appliedFeature.id === feature.id,
      );
      const expectedAssetId =
        feature.props.mountainStyle === "snow" ? "snow-peak" : "mountain-range";
      const firstStamps = first.artwork.layers
        .flatMap((layer) => layer.stamps)
        .filter(
          (stamp) =>
            stamp.assetId === expectedAssetId &&
            stamp.id.startsWith(`generated-artwork-${feature.id}-`),
        );
      const secondStamps = second.artwork.layers
        .flatMap((layer) => layer.stamps)
        .filter((stamp) =>
          stamp.id.startsWith(`generated-artwork-${feature.id}-`),
        );

      expect(firstStamps.length).toBeGreaterThanOrEqual(
        Math.max(6, feature.points.length),
      );
      expect(secondStamps).toEqual(firstStamps);
      expect(
        firstStamps.every(
          (stamp) =>
            stamp.layerId === sourceLayerIds.relief &&
            stamp.sourceFeatureId === feature.id &&
            stamp.scale >= 0.56,
        ),
      ).toBe(true);
      expect(appliedRidge).toBeDefined();
      firstStamps.forEach((stamp) => {
        expect(distanceToPath(stamp, appliedRidge!.points)).toBeLessThanOrEqual(
          26.001,
        );
      });
    });
    expect(mapDocumentSchema.parse(first)).toEqual(first);
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
    const sourceLayerIds = mapGeneratorSourceLayerIds("fantasy-map");
    expect(
      applied.scene?.layers.find((layer) => layer.id === sourceLayerIds.scene)
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
      applied.features.some((feature) => feature.props.component === "bridge"),
    ).toBe(true);
    expect(
      applied.features.some((feature) => feature.props.symbol === "port"),
    ).toBe(true);
  });

  it("应用世界架构高地词时保留可选择的地貌构件，而不是只生成底色", () => {
    const candidate = generateFantasyMapCandidate({
      seed: "applied-relief-components",
      document: document(),
      layerId: "layer-main",
      regionCount: 6,
      riverCount: 5,
      terrainKeywords: ["熔岩火山", "雪岭", "丘陵", "高原台地"],
    });
    const applied = applyGeneratorCandidate(document(), candidate);
    const sourceLayerIds = mapGeneratorSourceLayerIds(candidate.generatorId);
    const reliefComponents = applied.features.filter(
      (feature) =>
        feature.kind === "marker" &&
        ["volcano", "snow-peak", "foothills", "mesa"].includes(
          feature.props.component ?? "",
        ),
    );

    expect(
      new Set(reliefComponents.map((feature) => feature.props.component)),
    ).toEqual(new Set(["volcano", "snow-peak", "foothills", "mesa"]));
    expect(reliefComponents).toHaveLength(5);
    expect(
      reliefComponents.every(
        (feature) => feature.layerId === sourceLayerIds.feature,
      ),
    ).toBe(true);
    expect(mapDocumentSchema.parse(applied)).toEqual(applied);
  });

  it("生成结果隔离到来源图层，作者图层状态保持独立", () => {
    const current = document();
    const candidate = generateFantasyMapCandidate({
      seed: "source-layer-contract",
      document: current,
      layerId: "layer-main",
      landmassCount: 1,
      regionCount: 2,
      riverCount: 1,
      terrainKeywords: ["森林", "山脉"],
    });
    const sourceLayerIds = mapGeneratorSourceLayerIds(candidate.generatorId);
    const applied = applyGeneratorCandidate(current, candidate);
    const hidden = {
      ...applied,
      layers: applied.layers.map((layer) =>
        layer.id === sourceLayerIds.feature
          ? { ...layer, visible: false, locked: true }
          : layer,
      ),
      scene: applied.scene
        ? {
            ...applied.scene,
            layers: applied.scene.layers.map((layer) =>
              layer.id === sourceLayerIds.scene
                ? { ...layer, visible: false, locked: true }
                : layer,
            ),
          }
        : applied.scene,
      artwork: {
        ...applied.artwork,
        layers: applied.artwork.layers.map((layer) =>
          layer.id === sourceLayerIds.relief ||
          layer.id === sourceLayerIds.vegetation
            ? { ...layer, visible: false, locked: true }
            : layer,
        ),
      },
    };

    expect(
      hidden.layers.find((layer) => layer.id === "layer-main"),
    ).toMatchObject({
      visible: true,
      locked: false,
    });
    expect(
      hidden.layers.find((layer) => layer.id === sourceLayerIds.feature),
    ).toMatchObject({ visible: false, locked: true });
    expect(
      hidden.scene?.layers.find((layer) => layer.id === sourceLayerIds.scene),
    ).toMatchObject({ visible: false, locked: true });
    [sourceLayerIds.relief, sourceLayerIds.vegetation].forEach((layerId) =>
      expect(
        hidden.artwork.layers.find((layer) => layer.id === layerId),
      ).toMatchObject({ visible: false, locked: true }),
    );
    expect(mapDocumentSchema.parse(hidden)).toEqual(hidden);
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
    const applied = applyGeneratorCandidate(document(), candidate);
    expect(mapDocumentSchema.parse(applied)).toBeTruthy();
    expect(applied.canvas.width).toBeLessThan(1_600);
    expect(applied.canvas.height).toBeLessThan(1_000);
  });

  it("导入 Azgaar 越界坐标时保留世界坐标并向内容方向扩展", () => {
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
    expect(expanded).not.toBe(applied);
    expect(expanded.canvas.width).toBeGreaterThan(current.canvas.width);
    expect(expanded.canvas.height).toBeGreaterThan(current.canvas.height);
    expect(expanded.features[0]?.points[0]).toEqual({
      x: 2_200,
      y: 1_500,
    });
    expect(expanded.features[0]?.points[0].x).toBeGreaterThanOrEqual(160);
    expect(expanded.features[0]?.points[0].y).toBeGreaterThanOrEqual(160);
    expect(expanded.features[0]?.points[0].x).toBeLessThan(
      expanded.canvas.width - 160,
    );
    expect(expanded.features[0]?.points[0].y).toBeLessThan(
      expanded.canvas.height - 160,
    );
  });

  it("候选预览复用正式应用结果，并在预览阶段覆盖越界内容", () => {
    const current: MapDocument = {
      ...document(),
      features: [
        {
          id: "hand-drawn-anchor",
          kind: "marker",
          name: "手绘锚点",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: { color: "#7c684f" },
          description: "",
        },
      ],
    };
    const candidate = importAzgaarCandidate({
      fileName: "preview-bounds.json",
      document: current,
      layerId: "layer-main",
      content: JSON.stringify({
        pack: {
          burgs: [{ i: 1, name: "预览边境", x: 2_200, y: 1_500 }],
        },
      }),
    });
    const applied = applyGeneratorCandidate(current, candidate);
    const preview = previewGeneratorCandidate(current, candidate);
    const previewFeature = preview.features.find(
      (feature) => feature.name === "预览边境",
    );

    expect(preview).toEqual(expandMapCanvasToContent(applied));
    expect(previewFeature?.points[0]).toEqual({
      x: 2_200,
      y: 1_500,
    });
    expect(preview.canvas.width).toBeGreaterThan(applied.canvas.width);
    expect(preview.canvas.height).toBeGreaterThan(applied.canvas.height);
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
