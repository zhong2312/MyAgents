import { describe, expect, it } from "vitest";

import {
  MAP_ARTWORK_STAMP_ASSETS,
  addMapArtworkLayer,
  addMapArtworkStamp,
  createMapArtworkLayer,
  createMapArtworkStamp,
  createMapArtworkAssetCatalog,
  findMapArtworkLayer,
  findMapArtworkStamp,
  getMapArtworkAssetVariant,
  getMapArtworkAssetVariantWithColor,
  getMapArtworkStampAsset,
  mapArtworkVariantIndex,
  moveMapArtworkLayer,
  moveMapArtworkStampToLayer,
  removeMapArtworkLayer,
  removeMapArtworkStamp,
  updateMapArtworkLayer,
  updateMapArtworkStamp,
} from "./mapArtwork";
import { MAP_COMPONENT_PRESETS } from "./mapComponents";
import {
  createEmptyMapArtwork,
  createEmptyMapDocument,
  parseMapDocument,
} from "../entities/mapSchema";

describe("mapArtwork", () => {
  it("素材目录提供可直接渲染的图像和连续刷标记", () => {
    const forest = getMapArtworkStampAsset("forest");
    const city = getMapArtworkStampAsset("city");

    expect(forest?.imageSrc).toMatch(/^data:image\/svg\+xml/);
    expect(forest?.width).toBeGreaterThan(0);
    expect(forest?.height).toBeGreaterThan(0);
    expect(forest?.brush).toBe(true);
    expect(forest?.brushFollowsPath).toBe(false);
    expect(forest?.variants).toHaveLength(4);
    expect(
      new Set(forest?.variants.map((variant) => variant.imageSrc)).size,
    ).toBe(4);
    expect(city?.brush).toBe(false);
    expect(city?.variants).toHaveLength(3);
    expect(getMapArtworkStampAsset("mountain-range")?.brush).toBe(true);
    expect(getMapArtworkStampAsset("mountain-range")?.brushFollowsPath).toBe(
      true,
    );
  });

  it("每个构件预设都有真实矢量素材，不能退化为默认占位圆形", () => {
    expect(MAP_ARTWORK_STAMP_ASSETS.map((asset) => asset.id)).toEqual(
      MAP_COMPONENT_PRESETS.map((component) => component.id),
    );

    MAP_ARTWORK_STAMP_ASSETS.forEach((asset) => {
      const svg = decodeURIComponent(asset.imageSrc.split(",", 2)[1]!);
      expect(svg).toContain("<svg");
      expect(svg).not.toContain('<circle cx="64" cy="64" r="28"');
      expect(asset.variants.length).toBeGreaterThan(0);
      expect(
        asset.variants.every((variant) => variant.imageSrc.length > 0),
      ).toBe(true);
    });
  });

  it("世界之门与传送阵生成可解析的 SVG 素材", () => {
    for (const assetId of ["world-gate", "portal"]) {
      const asset = getMapArtworkStampAsset(assetId)!;
      const svg = decodeURIComponent(asset.imageSrc.split(",", 2)[1]!);

      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<ellipse[^>]*\bfill="[^"]*"[^>]*\bfill="/u);
    }
  });

  it("扩展地貌、水系、文明和奇幻地标均提供可直接绘制的素材语义", () => {
    const expected = [
      ["cliff", true, true],
      ["dunes", true, false],
      ["glacier", true, false],
      ["boulder-field", true, false],
      ["broadleaf-grove", true, false],
      ["bamboo-grove", true, false],
      ["shrubland", true, false],
      ["reed-bed", true, false],
      ["mangrove", true, false],
      ["coral-reef", true, false],
      ["seaweed-bed", true, false],
      ["sea-foam", true, true],
      ["ice-floe", true, false],
      ["farmland", true, false],
      ["terraces", true, false],
      ["village", true, false],
      ["town-district", false, false],
      ["fishing-village", false, false],
      ["lighthouse", false, false],
      ["graveyard", false, false],
      ["battlefield", false, false],
      ["rock-spires", false, false],
      ["camp", false, false],
      ["mine", false, false],
      ["shipyard", false, false],
      ["floating-island", false, false],
      ["world-tree", false, false],
      ["great-tree", false, false],
      ["underworld-gate", false, false],
      ["castle-cluster", false, false],
      ["farmland-field", true, false],
      ["deadwood-single", true, false],
      ["boundary-line", false, false],
      ["ring", false, false],
      ["coast-foam", true, true],
    ] as const;

    expected.forEach(([assetId, brush, brushFollowsPath]) => {
      const asset = getMapArtworkStampAsset(assetId)!;
      expect(asset).toMatchObject({ id: assetId, brush, brushFollowsPath });
      expect(asset.imageSrc).toMatch(/^data:image\/svg\+xml/u);
      expect(asset.variants.length).toBeGreaterThanOrEqual(3);
      expect(
        new Set(asset.variants.map((variant) => variant.imageSrc)).size,
      ).toBeGreaterThanOrEqual(3);
    });

    expect(getMapArtworkStampAsset("world-gate")?.variants).toHaveLength(3);
    expect(getMapArtworkStampAsset("portal")?.variants).toHaveLength(3);
  });

  it("新增文明构件与制图阴影使用独立轮廓，不复用泛用聚落占位图", () => {
    const signatures = {
      town: "M9 108V71",
      "town-district": "M12 20h156",
      "fishing-village": "M11 102c29-12",
      lighthouse: "M48 122",
      graveyard: "M24 103V72",
      battlefield: "m42 97 52-62",
      farmstead: "M13 106h144",
      "ruin-cluster": "M14 106h146",
      "castle-cluster": "M12 112V55",
      "farmland-field": "M13 104",
      "deadwood-single": "M61 124",
      "boundary-line": "M12 86C39 21",
      "great-tree": "M69 126V76",
      ring: '<ellipse cx="64" cy="67" rx="56"',
      hillshade: "M12 101 48 32",
    } as const;

    for (const [assetId, signature] of Object.entries(signatures)) {
      const asset = getMapArtworkStampAsset(assetId)!;
      const svg = decodeURIComponent(asset.imageSrc.split(",", 2)[1]!);
      expect(svg, assetId).toContain(signature);
    }
  });

  it("同一素材按稳定种子选择变体，并把越界编号归一化", () => {
    const mountains = getMapArtworkStampAsset("mountain-range")!;
    const first = mapArtworkVariantIndex(mountains, "stroke-1:8");

    expect(first).toBe(mapArtworkVariantIndex(mountains, "stroke-1:8"));
    expect(first).toBeLessThan(mountains.variants.length);
    expect(getMapArtworkAssetVariant(mountains, 9).index).toBe(1);
  });

  it("内置素材按笔触颜色生成可复用变体，项目图片保持原色", () => {
    const mountains = getMapArtworkStampAsset("mountain-range")!;
    const source = getMapArtworkAssetVariant(mountains, 1);
    const tinted = getMapArtworkAssetVariantWithColor(mountains, 1, "#2d5568");

    expect(tinted).not.toBe(source);
    expect(tinted.cacheKey).toBe("tint:mountain-range:1:#2d5568");
    expect(tinted.imageSrc).not.toBe(source.imageSrc);
    expect(getMapArtworkAssetVariantWithColor(mountains, 1, "#2D5568")).toBe(
      tinted,
    );

    const artwork = {
      ...createEmptyMapArtwork(),
      assets: [
        {
          id: "asset-pine-pack",
          name: "黑松密林",
          path: "world/maps/assets/project-map/artwork/asset-pine-pack.webp",
          mimeType: "image/webp" as const,
          width: 512,
          height: 384,
          brush: true,
        },
      ],
    };
    const projectAsset = createMapArtworkAssetCatalog(
      artwork,
      new Map([["asset-pine-pack", "data:image/webp;base64,AAAA"]]),
    ).get("asset-pine-pack")!;

    expect(getMapArtworkAssetVariantWithColor(projectAsset, 0, "#2d5568")).toBe(
      getMapArtworkAssetVariant(projectAsset, 0),
    );
  });

  it("项目素材只由清单和项目内图像 URL 共同解析，不把二进制写进地图", () => {
    const artwork = {
      ...createEmptyMapArtwork(),
      assets: [
        {
          id: "asset-forest-pack",
          name: "黑松密林",
          path: "world/maps/assets/project-map/artwork/asset-forest-pack.webp",
          mimeType: "image/webp" as const,
          width: 512,
          height: 384,
          brush: true,
        },
      ],
    };
    const catalog = createMapArtworkAssetCatalog(
      artwork,
      new Map([["asset-forest-pack", "data:image/webp;base64,AAAA"]]),
    );

    expect(catalog.get("asset-forest-pack")).toMatchObject({
      name: "黑松密林",
      brush: true,
      brushFollowsPath: false,
      width: 512,
      variants: [
        {
          cacheKey:
            "project:asset-forest-pack:world/maps/assets/project-map/artwork/asset-forest-pack.webp",
        },
      ],
    });
    expect(
      createMapArtworkAssetCatalog(artwork).get("asset-forest-pack"),
    ).toBeUndefined();
  });

  it("可以把素材印章写入默认视觉图层并更新位置", () => {
    const artwork = createEmptyMapArtwork();
    const layer = findMapArtworkLayer(artwork);
    expect(layer?.id).toBe("artwork-stamps");

    const stamp = createMapArtworkStamp({
      id: "stamp-city-1",
      layerId: layer!.id,
      assetId: "city",
      x: 240,
      y: 180,
    });
    const inserted = addMapArtworkStamp(artwork, stamp);
    expect(findMapArtworkStamp(inserted, stamp.id)).toMatchObject({
      assetId: "city",
      x: 240,
      y: 180,
      variant: 0,
    });

    const moved = updateMapArtworkStamp(inserted, stamp.id, {
      x: 520,
      y: 360,
      scale: 1.5,
    });
    expect(findMapArtworkStamp(moved, stamp.id)).toMatchObject({
      x: 520,
      y: 360,
      scale: 1.5,
    });
  });

  it("放置工具参数会随印章落图保存", () => {
    const layer = findMapArtworkLayer(createEmptyMapArtwork())!;
    const stamp = createMapArtworkStamp({
      id: "stamp-forest-brush",
      layerId: layer.id,
      assetId: "forest",
      x: 320,
      y: 240,
      variant: 2,
      scale: 1.8,
      opacity: 0.65,
      rotation: 12,
      flipX: true,
    });

    expect(stamp).toMatchObject({
      variant: 2,
      scale: 1.8,
      opacity: 0.65,
      rotation: 12,
      flipX: true,
      flipY: false,
    });
  });

  it("删除素材印章不会影响其他视觉图层", () => {
    const artwork = createEmptyMapArtwork();
    const layer = findMapArtworkLayer(artwork)!;
    const first = createMapArtworkStamp({
      id: "stamp-first",
      layerId: layer.id,
      assetId: "forest",
      x: 100,
      y: 100,
    });
    const second = createMapArtworkStamp({
      id: "stamp-second",
      layerId: layer.id,
      assetId: "river",
      x: 200,
      y: 200,
    });
    const withStamps = addMapArtworkStamp(
      addMapArtworkStamp(artwork, first),
      second,
    );
    const removed = removeMapArtworkStamp(withStamps, first.id);
    expect(findMapArtworkStamp(removed, first.id)).toBeUndefined();
    expect(findMapArtworkStamp(removed, second.id)?.assetId).toBe("river");
    expect(removed.layers).toHaveLength(1);
  });

  it("素材图层可以独立排序、管理并在删除时迁移印章", () => {
    const defaultArtwork = createEmptyMapArtwork();
    const foreground = createMapArtworkLayer({
      id: "artwork-foreground",
      name: "前景地标",
      kind: "effect",
    });
    const withForeground = addMapArtworkLayer(defaultArtwork, foreground);
    const sourceLayer = findMapArtworkLayer(withForeground)!;
    const stamp = createMapArtworkStamp({
      id: "stamp-foreground-city",
      layerId: sourceLayer.id,
      assetId: "city",
      x: 320,
      y: 260,
    });
    const withStamp = addMapArtworkStamp(withForeground, stamp);

    const movedStamp = moveMapArtworkStampToLayer(
      withStamp,
      stamp.id,
      foreground.id,
    );
    expect(
      findMapArtworkLayer(movedStamp, sourceLayer.id)?.stamps,
    ).toHaveLength(0);
    expect(findMapArtworkStamp(movedStamp, stamp.id)).toMatchObject({
      layerId: foreground.id,
    });

    const reordered = moveMapArtworkLayer(movedStamp, foreground.id, -1);
    expect(reordered.layers.map((layer) => layer.id)).toEqual([
      foreground.id,
      sourceLayer.id,
    ]);
    expect(
      updateMapArtworkLayer(reordered, foreground.id, {
        opacity: 0.6,
        locked: true,
      }).layers[0],
    ).toMatchObject({ opacity: 0.6, locked: true });

    const removed = removeMapArtworkLayer(
      movedStamp,
      foreground.id,
      sourceLayer.id,
    );
    expect(removed.layers.map((layer) => layer.id)).toEqual([sourceLayer.id]);
    expect(findMapArtworkStamp(removed, stamp.id)).toMatchObject({
      layerId: sourceLayer.id,
    });
  });

  it("缺少可用迁移目标时拒绝删除素材层，保留所有印章", () => {
    const artwork = createEmptyMapArtwork();
    const layer = findMapArtworkLayer(artwork)!;
    const stamp = createMapArtworkStamp({
      id: "stamp-only-layer",
      layerId: layer.id,
      assetId: "forest",
      x: 100,
      y: 120,
    });
    const withStamp = addMapArtworkStamp(artwork, stamp);

    expect(removeMapArtworkLayer(withStamp, layer.id, "missing-layer")).toEqual(
      withStamp,
    );
  });

  it("旧地图缺失 artwork 时解析为默认空素材层", () => {
    const parsed = parseMapDocument(
      "world/maps/records/legacy.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "legacy-map",
        name: "旧地图",
        projectionType: "continent",
        canvas: {
          width: 1600,
          height: 1000,
          backgroundColor: "#f3f0e8",
          showGrid: true,
        },
        layers: [
          {
            id: "layer-main",
            name: "主图层",
            visible: true,
            locked: false,
            opacity: 1,
          },
        ],
        features: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(parsed.artwork.layers[0]?.id).toBe("artwork-stamps");
    expect(parsed.artwork.layers[0]?.stamps).toEqual([]);
    expect(parsed.artwork.assets).toEqual([]);
  });

  it("旧素材印章缺失变体字段时兼容为首个变体", () => {
    const document = createEmptyMapDocument({
      id: "legacy-artwork-map",
      name: "旧素材地图",
      projectionType: "continent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const layer = findMapArtworkLayer(document.artwork)!;
    const json = JSON.parse(JSON.stringify(document)) as {
      artwork: { layers: Array<{ stamps: Array<Record<string, unknown>> }> };
    };
    json.artwork.layers[0]!.stamps.push({
      id: "legacy-stamp",
      layerId: layer.id,
      assetId: "forest",
      x: 200,
      y: 160,
      scale: 1,
      rotation: 0,
      opacity: 1,
      flipX: false,
      flipY: false,
    });

    const parsed = parseMapDocument(
      "legacy-artwork.json",
      JSON.stringify(json),
    );

    expect(parsed.artwork.layers[0]?.stamps[0]?.variant).toBe(0);
  });
});
