import { describe, expect, it } from "vitest";

import {
  expandMapCanvasToContent,
  expandMapCanvasToContentWithTranslation,
  mapDocumentGainedContent,
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

  it("内容远离边界时保持画布尺寸稳定", () => {
    const current = document();
    const next = expandMapCanvasToContent(current);
    expect(next).toBe(current);
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
});
