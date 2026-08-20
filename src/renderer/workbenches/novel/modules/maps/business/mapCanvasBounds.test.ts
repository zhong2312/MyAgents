import { describe, expect, it } from "vitest";

import {
  expandMapCanvasToContent,
  expandMapCanvasToContentWithTranslation,
  fitMapCanvasToDefaultContent,
  fitMapCanvasToGeneratedContent,
  fitMapCanvasToContentWhenEmpty,
  mapDocumentGainedContent,
  mapDocumentHasGeneratedContent,
  mapDocumentHasGeneratorOutput,
  mapDocumentHasContent,
} from "./mapCanvasBounds";
import {
  createEmptyMapDocument,
  mapDocumentSchema,
} from "../entities/mapSchema";

function document() {
  return createEmptyMapDocument({
    id: "map-bounds",
    name: "边界测试",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("mapCanvasBounds", () => {
  it("只把实际地图事实视为内容，空图层和预设背景不触发首次构图", () => {
    const current = document();

    expect(mapDocumentHasContent(current)).toBe(false);
    expect(
      mapDocumentHasContent({
        ...current,
        canvas: { ...current.canvas, backgroundPreset: "ocean" },
      }),
    ).toBe(false);
    expect(
      mapDocumentHasContent({
        ...current,
        canvas: {
          ...current.canvas,
          backgroundImage: "data:image/png;base64,placeholder",
          backgroundImageWidth: 1_600,
          backgroundImageHeight: 1_000,
        },
      }),
    ).toBe(true);
    expect(
      mapDocumentHasContent({
        ...current,
        scene: {
          ...current.scene!,
          layers: current.scene!.layers.map((layer) =>
            layer.id === "scene-terrain"
              ? {
                  ...layer,
                  regions: [
                    {
                      id: "region-first-land",
                      layerId: layer.id,
                      kind: "land",
                      points: [
                        { x: 240, y: 180 },
                        { x: 360, y: 200 },
                        { x: 300, y: 320 },
                      ],
                      fill: "#b8ad7d",
                      texture: "paper-land",
                      opacity: 1,
                      edgeColor: "#655540",
                      edgeWidth: 3,
                    },
                  ],
                }
              : layer,
          ),
        },
      }),
    ).toBe(true);
  });

  it("只在首次落图时请求内容构图，不干扰后续连续创作", () => {
    const empty = document();
    const firstFeature = {
      ...empty,
      features: [
        {
          id: "feature-first-city",
          kind: "marker" as const,
          name: "首座城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 480, y: 360 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };

    expect(mapDocumentGainedContent(empty, firstFeature)).toBe(true);
    expect(mapDocumentGainedContent(firstFeature, firstFeature)).toBe(false);
  });

  it("内容触及右下边界时自动延展，且不改变既有坐标", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      features: [
        {
          id: "feature-edge",
          kind: "marker",
          name: "边缘",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: current.canvas.width, y: current.canvas.height }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    expect(next.canvas.width).toBe(current.canvas.width + 166);
    expect(next.canvas.height).toBe(current.canvas.height + 166);
    expect(next.features[0]?.points).toEqual([
      { x: current.canvas.width, y: current.canvas.height },
    ]);
  });

  it("内容接近右下边缘时预先延展，四个方向均保留继续创作的空间", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      features: [
        {
          id: "feature-near-southeast-edge",
          kind: "marker",
          name: "边境城",
          entityRef: null,
          layerId: "layer-main",
          // marker 的可见半径为 6px；它虽然还在旧画布以内，但右、下边缘
          // 已不足 160px，必须和左、上方向一样主动生长。
          points: [
            { x: current.canvas.width - 120, y: current.canvas.height - 120 },
          ],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    expect(next.canvas).toMatchObject({
      width: current.canvas.width + 46,
      height: current.canvas.height + 46,
    });
    expect(next.features[0]?.points).toEqual([
      { x: current.canvas.width - 120, y: current.canvas.height - 120 },
    ]);
  });

  it("路线和拓扑节点的视觉外沿也会触发画布延展", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      features: [
        {
          id: "feature-border-route",
          kind: "route",
          name: "边境路线",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: current.canvas.width - 40, y: 420 },
            { x: current.canvas.width - 20, y: 480 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { lineWidth: "36" },
          description: "",
        },
        {
          id: "feature-border-node",
          kind: "node",
          name: "边境节点",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: current.canvas.width - 40, y: 620 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    expect(next.canvas.width).toBeGreaterThan(current.canvas.width);
    expect(next.features.map((feature) => feature.points)).toEqual([
      [
        { x: current.canvas.width - 40, y: 420 },
        { x: current.canvas.width - 20, y: 480 },
      ],
      [{ x: current.canvas.width - 40, y: 620 }],
    ]);
  });

  it("内容远离边界时保持画布尺寸稳定", () => {
    const current = document();
    const next = expandMapCanvasToContent(current);
    expect(next).toBe(current);
  });

  it("空地图首次接收生成结果时按内容包络收紧画布并重定位坐标", () => {
    const current = document();
    const generated = {
      ...current,
      features: [
        {
          id: "generated-land",
          kind: "polygon" as const,
          name: "主大陆",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 420, y: 60 },
            { x: 860, y: 80 },
            { x: 780, y: 360 },
            { x: 460, y: 340 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { generator: "fantasy-map-tool", terrain: "coast" },
          description: "生成大陆",
        },
      ],
    };

    expect(mapDocumentHasGeneratedContent(generated)).toBe(true);
    expect(mapDocumentHasGeneratorOutput(generated)).toBe(true);
    const fitted = fitMapCanvasToContentWhenEmpty(current, generated);

    expect(fitted.canvas).toMatchObject({ width: 760, height: 620 });
    expect(fitted.features[0]?.points).toEqual([
      { x: 160, y: 160 },
      { x: 600, y: 180 },
      { x: 520, y: 460 },
      { x: 200, y: 440 },
    ]);
  });

  it("已有事实不收紧；普通底图保留矩形，生成底图按可编辑几何收紧", () => {
    const current = document();
    const generated = {
      ...current,
      features: [
        {
          id: "generated-city",
          kind: "marker" as const,
          name: "城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 200, y: 180 }],
          timeFrom: null,
          timeTo: null,
          props: { generator: "fantasy-map-tool" },
          description: "",
        },
      ],
    };

    const existing = {
      ...current,
      features: [
        {
          ...generated.features[0]!,
          id: "author-city",
          props: {},
        },
      ],
    };
    expect(fitMapCanvasToContentWhenEmpty(existing, generated)).toBe(generated);

    const withBackground = {
      ...generated,
      canvas: {
        ...generated.canvas,
        backgroundImage: "data:image/svg+xml;base64,placeholder",
        backgroundImageWidth: 1600,
        backgroundImageHeight: 1000,
      },
    };
    const fittedGeneratedBackground = fitMapCanvasToContentWhenEmpty(
      current,
      withBackground,
    );
    expect(fittedGeneratedBackground.canvas).toMatchObject({
      width: 332,
      height: 332,
    });
    expect(fittedGeneratedBackground.features[0]?.points).toEqual([
      // 单点标记的实际外沿为 6px，锚点因此位于 160px 留白以内。
      { x: 166, y: 166 },
    ]);
    expect(expandMapCanvasToContent(fittedGeneratedBackground)).toMatchObject({
      canvas: { width: 332, height: 332 },
    });

    const importedBackground = {
      ...current,
      canvas: {
        ...current.canvas,
        backgroundImage: "data:image/svg+xml;base64,placeholder",
        backgroundImageWidth: 1600,
        backgroundImageHeight: 1000,
      },
    };
    expect(fitMapCanvasToContentWhenEmpty(current, importedBackground)).toBe(
      importedBackground,
    );
    expect(
      mapDocumentHasGeneratedContent({
        ...withBackground,
        features: withBackground.features.map((feature) => ({
          ...feature,
          props: { generator: "azgaar-runtime" },
        })),
      }),
    ).toBe(true);
    expect(
      mapDocumentHasGeneratorOutput({
        ...withBackground,
        features: withBackground.features.map((feature) => ({
          ...feature,
          props: { generator: "azgaar-runtime" },
        })),
      }),
    ).toBe(true);
    for (const generator of ["agent-azgaar", "azgaar-runtime"] as const) {
      expect(
        mapDocumentHasGeneratedContent({
          ...current,
          features: withBackground.features.map((feature) => ({
            ...feature,
            props: { generator },
          })),
        }),
      ).toBe(true);
    }
    for (const layerId of [
      "scene-generator-agent-azgaar",
      "scene-generator-azgaar-runtime",
    ]) {
      expect(
        mapDocumentHasGeneratorOutput({
          ...current,
          scene: {
            ...current.scene!,
            layers: current.scene!.layers.map((layer) => ({
              ...layer,
              id: layer.id === "scene-terrain" ? layerId : layer.id,
            })),
          },
        }),
      ).toBe(true);
    }
  });

  it("旧版默认尺寸的生成地图只迁移一次，作者扩展过的地图不收缩", () => {
    const current = document();
    const generated = {
      ...current,
      features: [
        {
          id: "legacy-generated-land",
          kind: "polygon" as const,
          name: "旧生成大陆",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 120, y: 180 },
            { x: 760, y: 200 },
            { x: 720, y: 620 },
            { x: 160, y: 580 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { generator: "azgaar-runtime", azgaarLayer: "state" },
          description: "旧生成结果",
        },
      ],
    };
    const migrated = fitMapCanvasToGeneratedContent(generated);
    expect(migrated.canvas).toMatchObject({ width: 960, height: 760 });
    expect(migrated.features[0]?.points[0]).toEqual({ x: 160, y: 160 });
    expect(fitMapCanvasToGeneratedContent(migrated)).toBe(migrated);

    const manuallyExpanded = {
      ...generated,
      canvas: { ...generated.canvas, width: 2_000, height: 1_300 },
    };
    expect(fitMapCanvasToGeneratedContent(manuallyExpanded)).toBe(
      manuallyExpanded,
    );
  });

  it("旧版默认尺寸的手工地图也按真实内容收束，后续扩展过的地图保持原尺寸", () => {
    const current = document();
    const legacyManualMap = {
      ...current,
      scene: {
        ...current.scene!,
        layers: current.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "legacy-island",
                    layerId: layer.id,
                    kind: "land" as const,
                    points: [
                      { x: 280, y: 180 },
                      { x: 460, y: 200 },
                      { x: 390, y: 330 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land" as const,
                    opacity: 1,
                    edgeColor: "#655540",
                    edgeWidth: 4,
                  },
                ],
              }
            : layer,
        ),
      },
    };

    const fitted = fitMapCanvasToDefaultContent(legacyManualMap);
    expect(fitted.canvas).toMatchObject({ width: 504, height: 474 });
    expect(
      fitted.scene?.layers.find((layer) => layer.id === "scene-terrain")
        ?.regions[0]?.points,
    ).toEqual([
      { x: 162, y: 162 },
      { x: 342, y: 182 },
      { x: 272, y: 312 },
    ]);

    const expandedByAuthor = {
      ...legacyManualMap,
      canvas: { ...legacyManualMap.canvas, width: 1_920, height: 1_240 },
    };
    expect(fitMapCanvasToDefaultContent(expandedByAuthor)).toBe(
      expandedByAuthor,
    );
  });

  it("内容贴近左上边界时也会补足成图留白", () => {
    const current = document();
    const expansion = expandMapCanvasToContentWithTranslation({
      ...current,
      features: [
        {
          id: "feature-northwest-edge",
          kind: "marker",
          name: "北境岛屿",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 0, y: 0 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    // marker 具有 6px 的实际绘制半径，故以其可见外沿而不是锚点计算留白。
    expect(expansion.translation).toEqual({ x: 166, y: 166 });
    expect(expansion.map.canvas).toMatchObject({ width: 1_766, height: 1_166 });
    expect(expansion.map.features[0]?.points).toEqual([{ x: 166, y: 166 }]);
  });

  it("大陆区域贴近上边缘时会扩展海面而不是裁切区域", () => {
    const current = document();
    const expansion = expandMapCanvasToContentWithTranslation({
      ...current,
      scene: {
        ...current.scene!,
        layers: current.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "region-north-edge",
                    layerId: layer.id,
                    kind: "land",
                    points: [
                      { x: 480, y: 0 },
                      { x: 640, y: 0 },
                      { x: 560, y: 120 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land",
                    opacity: 1,
                    edgeColor: "#655540",
                    edgeWidth: 4,
                  },
                ],
              }
            : layer,
        ),
      },
    });

    expect(expansion.translation).toEqual({ x: 0, y: 162 });
    expect(expansion.map.canvas.height).toBe(1_162);
    expect(
      expansion.map.scene?.layers.find((layer) => layer.id === "scene-terrain")
        ?.regions[0]?.points,
    ).toEqual([
      { x: 480, y: 162 },
      { x: 640, y: 162 },
      { x: 560, y: 282 },
    ]);
  });

  it("保留超出旧尺寸的地形与素材坐标，并为视觉外沿补足边距", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      scene: {
        ...current.scene!,
        layers: current.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "region-edge",
                    layerId: layer.id,
                    kind: "land",
                    points: [
                      { x: 1_720, y: 1_040 },
                      { x: 1_840, y: 1_040 },
                      { x: 1_770, y: 1_150 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land",
                    opacity: 1,
                    edgeColor: "#655540",
                    edgeWidth: 3,
                  },
                ],
              }
            : layer,
        ),
      },
      artwork: {
        ...current.artwork,
        layers: current.artwork.layers.map((layer) => ({
          ...layer,
          stamps: [
            {
              id: "stamp-edge",
              layerId: layer.id,
              assetId: "mountain-range",
              x: 1_900,
              y: 1_200,
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
    });

    expect(next.canvas.width).toBeGreaterThan(2_000);
    expect(next.canvas.height).toBeGreaterThan(1_400);
  });

  it("宽幅素材笔刷的 profile 外沿也会参与自动延展", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      scene: {
        ...current.scene!,
        layers: current.scene!.layers.map((layer) =>
          layer.id === "scene-vegetation"
            ? {
                ...layer,
                strokes: [
                  {
                    id: "stroke-wetland-edge",
                    layerId: layer.id,
                    tool: "paint",
                    brushAssetId: "wetland",
                    terrainMaterial: null,
                    shape: "round",
                    points: [
                      { x: current.canvas.width - 40, y: 500 },
                      { x: current.canvas.width - 20, y: 520 },
                    ],
                    color: "#5e8e80",
                    width: 120,
                    opacity: 1,
                    spacing: 48,
                    scatter: 1,
                  },
                ],
              }
            : layer,
        ),
      },
    });

    expect(next.canvas.width).toBeGreaterThan(1_800);
  });

  it("内容越过左上边缘时平移全部事实并扩展对应方向", () => {
    const current = document();
    const expansion = expandMapCanvasToContentWithTranslation({
      ...current,
      features: [
        {
          id: "feature-northwest",
          kind: "marker",
          name: "北境",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: -40, y: -20 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
      scene: {
        ...current.scene!,
        layers: current.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                strokes: [
                  {
                    id: "stroke-northwest",
                    layerId: layer.id,
                    tool: "paint",
                    brushAssetId: null,
                    terrainMaterial: null,
                    shape: "round",
                    points: [{ x: -24, y: 64 }],
                    color: "#b8ad7d",
                    width: 24,
                    opacity: 1,
                    spacing: 8,
                    scatter: 0,
                  },
                ],
              }
            : layer,
        ),
      },
      artwork: {
        ...current.artwork,
        layers: current.artwork.layers.map((layer) => ({
          ...layer,
          stamps: [
            {
              id: "stamp-northwest",
              layerId: layer.id,
              assetId: "mountain-range",
              x: 480,
              y: 300,
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
    });

    expect(expansion.translation).toEqual({ x: 206, y: 186 });
    expect(expansion.map.canvas).toMatchObject({ width: 1_806, height: 1_186 });
    expect(expansion.map.features[0]?.points).toEqual([{ x: 166, y: 166 }]);
    expect(
      expansion.map.scene?.layers.find((layer) => layer.id === "scene-terrain")
        ?.strokes[0]?.points,
    ).toEqual([{ x: 182, y: 250 }]);
    expect(expansion.map.artwork.layers[0]?.stamps[0]).toMatchObject({
      x: 686,
      y: 486,
    });
  });

  it("超出旧固定上限时继续扩展逻辑画布而不截断内容", () => {
    const current = {
      ...document(),
      canvas: {
        ...document().canvas,
        width: 100_000,
        height: 100_000,
      },
      features: [
        {
          id: "feature-large-canvas",
          kind: "marker" as const,
          name: "远方",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 100_000, y: 100_000 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const next = expandMapCanvasToContent(current);

    expect(next.canvas).toMatchObject({ width: 100_166, height: 100_166 });
    expect(mapDocumentSchema.parse(next)).toEqual(next);
  });

  it("按印章真实尺寸扩展，旋转和放大后四角也不会被裁切", () => {
    const current = document();
    const expansion = expandMapCanvasToContentWithTranslation({
      ...current,
      artwork: {
        ...current.artwork,
        assets: [
          {
            id: "project-square",
            name: "大型正方形印章",
            path: "world/maps/assets/map-bounds/artwork/project-square.png",
            mimeType: "image/png",
            width: 150,
            height: 150,
            brush: true,
          },
        ],
        layers: current.artwork.layers.map((layer) => ({
          ...layer,
          stamps: [
            {
              id: "stamp-large-star",
              layerId: layer.id,
              assetId: "project-square",
              x: 0,
              y: 500,
              variant: 0,
              scale: 20,
              rotation: 45,
              opacity: 1,
              flipX: false,
              flipY: false,
            },
          ],
        })),
      },
    });

    const radius = Math.hypot(3_000, 3_000) / 2;
    expect(expansion.translation.x).toBeGreaterThan(2_080);
    expect(
      expansion.map.artwork.layers[0]?.stamps[0]?.x,
    ).toBeGreaterThanOrEqual(160 + radius);
  });

  it("标签的字号和偏移也会触发边缘延展", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      features: [
        {
          id: "feature-label-edge",
          kind: "label",
          name: "极北冰封长城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 1_590, y: 500 }],
          timeFrom: null,
          timeTo: null,
          props: { labelSize: "96", labelOffsetX: "48" },
          description: "",
        },
      ],
    });

    expect(next.canvas.width).toBeGreaterThan(current.canvas.width);
  });

  it("导入底图的实际尺寸也会被纳入自动边界", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      canvas: {
        ...current.canvas,
        backgroundImage: "data:image/png;base64,placeholder",
        backgroundImageWidth: 2_400,
        backgroundImageHeight: 1_500,
      },
    });

    expect(next.canvas).toMatchObject({ width: 2_720, height: 1_820 });
    expect(next.canvas.backgroundImagePlacement).toEqual({
      x: 160,
      y: 160,
      width: 2_400,
      height: 1_500,
    });
  });

  it("向左上延展时，底图与要素保持相同的世界坐标偏移", () => {
    const current = document();
    const expansion = expandMapCanvasToContentWithTranslation({
      ...current,
      canvas: {
        ...current.canvas,
        backgroundImage: "data:image/png;base64,placeholder",
        backgroundImageWidth: 1_600,
        backgroundImageHeight: 1_000,
      },
      features: [
        {
          id: "feature-outside-background",
          kind: "marker",
          name: "边境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: -40, y: -20 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    expect(expansion.translation).toEqual({ x: 206, y: 186 });
    expect(expansion.map.features[0]?.points).toEqual([{ x: 166, y: 166 }]);
    expect(expansion.map.canvas.backgroundImagePlacement).toEqual({
      x: 206,
      y: 186,
      width: 1_600,
      height: 1_000,
    });
  });

  it("已有底图世界矩形时，即使缺少原始尺寸也会参与自动延展", () => {
    const current = document();
    const next = expandMapCanvasToContent({
      ...current,
      canvas: {
        ...current.canvas,
        backgroundImage: "data:image/png;base64,legacy",
        backgroundImagePlacement: {
          x: -80,
          y: -40,
          width: 1_920,
          height: 1_280,
        },
      },
    });

    expect(next.canvas).toMatchObject({ width: 2_240, height: 1_600 });
    expect(next.canvas.backgroundImagePlacement).toEqual({
      x: 160,
      y: 160,
      width: 1_920,
      height: 1_280,
    });
  });

  it("生成器底图被作者明确变换后，矩形事实也参与首次构图", () => {
    const current = document();
    const generated = {
      ...current,
      canvas: {
        ...current.canvas,
        backgroundImage: "data:image/svg+xml;base64,generated",
        backgroundImageWidth: 1_800,
        backgroundImageHeight: 800,
        backgroundImagePlacement: {
          x: -80,
          y: 100,
          width: 1_800,
          height: 800,
          source: "author" as const,
        },
      },
      features: [
        {
          id: "generated-anchor",
          kind: "marker" as const,
          name: "生成锚点",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 420, y: 360 }],
          timeFrom: null,
          timeTo: null,
          props: { generator: "azgaar-runtime" },
          description: "",
        },
      ],
    };

    const fitted = fitMapCanvasToContentWhenEmpty(current, generated);

    expect(fitted.canvas).toMatchObject({ width: 2_120, height: 1_120 });
    expect(fitted.canvas.backgroundImagePlacement).toEqual({
      x: 160,
      y: 160,
      width: 1_800,
      height: 800,
      source: "author",
    });
    expect(fitted.features[0]?.points).toEqual([{ x: 660, y: 420 }]);
  });
});
