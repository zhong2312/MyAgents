import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import { MAP_COMPONENT_DRAG_MIME } from "../business/mapComponents";
import { DEFAULT_MAP_CANVAS_SETTINGS } from "../business/mapCanvasSession";
import {
  createMapSceneRegion,
  createMapSceneStroke,
} from "../business/mapScene";
import MapSceneCanvas, {
  getMapSceneFocusBounds,
  getMapScenePreviewBounds,
  mapScenePointsIntersectViewport,
  mapSceneNavigatorPointAt,
} from "./MapSceneCanvas";

function createDocument() {
  return createEmptyMapDocument({
    id: "map-scene-canvas",
    name: "九州",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function renderSceneCanvas(
  overrides: Partial<React.ComponentProps<typeof MapSceneCanvas>> = {},
) {
  const callbacks = {
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onComponentDrop: vi.fn(),
    onComponentSurface: vi.fn(),
    onSceneStroke: vi.fn(),
    onSceneErase: vi.fn(),
    onTerrainStroke: vi.fn(),
    onTerrainMaterialStroke: vi.fn(),
    onSceneStrokeMove: vi.fn(),
    onSceneRegionCreate: vi.fn(),
    onSceneRegionMove: vi.fn(),
    onArtworkStampMove: vi.fn(),
    onArtworkStampTransform: vi.fn(),
    onArtworkStampPlace: vi.fn(),
    onGeometryChange: vi.fn(),
    onSelectionChange: vi.fn(),
    onBatchMove: vi.fn(),
  };
  render(
    <MapSceneCanvas
      document={createDocument()}
      tool="artwork-brush"
      activeLayerId="layer-main"
      selectedFeatureId={null}
      timelineCursor={null}
      artworkBrushAssetId="forest"
      {...callbacks}
      {...overrides}
    />,
  );
  const canvas = screen.getByLabelText("地图设计画布").querySelector("canvas");
  if (!canvas) throw new Error("地图设计画布缺少 Canvas 元素");
  Object.assign(canvas, {
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1600,
      bottom: 1000,
      width: 1600,
      height: 1000,
      toJSON: () => ({}),
    }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
  });
  return { canvas, ...callbacks };
}

function firePointer(
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  input: {
    readonly button: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly pointerId: number;
    readonly shiftKey?: boolean;
  },
) {
  const init = {
    button: input.button,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: input.clientX,
    clientY: input.clientY,
    shiftKey: input.shiftKey ?? false,
  };
  const event =
    type === "pointerdown"
      ? createEvent.pointerDown(canvas, init)
      : type === "pointermove"
        ? createEvent.pointerMove(canvas, init)
        : createEvent.pointerUp(canvas, init);
  Object.defineProperty(event, "pointerId", { value: input.pointerId });
  fireEvent(canvas, event);
}

describe("MapSceneCanvas 画布动作优先级", () => {
  it("只裁剪完全处于当前视口外的要素，并保留穿过视口的路径", () => {
    const viewport = { left: 100, right: 300, top: 100, bottom: 300 };

    expect(
      mapScenePointsIntersectViewport([{ x: 48, y: 48 }], viewport, 32),
    ).toBe(false);
    expect(
      mapScenePointsIntersectViewport([{ x: 72, y: 72 }], viewport, 32),
    ).toBe(true);
    expect(
      mapScenePointsIntersectViewport(
        [
          { x: 40, y: 200 },
          { x: 360, y: 200 },
        ],
        viewport,
      ),
    ).toBe(true);
  });

  it("聚焦范围优先使用选中内容，未选择时覆盖全部可见内容", () => {
    const base = createDocument();
    const document = {
      ...base,
      features: [
        {
          id: "feature-near",
          kind: "route" as const,
          name: "近处道路",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 180, y: 220 },
            { x: 320, y: 260 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { lineWidth: "8" },
          description: "",
        },
      ],
      artwork: {
        ...base.artwork,
        layers: base.artwork.layers.map((layer) =>
          layer.id === "artwork-stamps"
            ? {
                ...layer,
                stamps: [
                  {
                    id: "stamp-far",
                    layerId: layer.id,
                    assetId: "city",
                    x: 1_320,
                    y: 760,
                    variant: 0,
                    scale: 2,
                    rotation: 30,
                    opacity: 1,
                    flipX: false,
                    flipY: false,
                  },
                ],
              }
            : layer,
        ),
      },
      scene: {
        ...base.scene!,
        layers: base.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                strokes: [
                  {
                    id: "stroke-far",
                    layerId: layer.id,
                    tool: "paint" as const,
                    brushAssetId: null,
                    terrainMaterial: null,
                    shape: "round" as const,
                    points: [{ x: 1_420, y: 620 }],
                    color: "#b8ad7d",
                    width: 180,
                    opacity: 1,
                    spacing: 36,
                    scatter: 0,
                  },
                ],
              }
            : layer,
        ),
      },
    };

    expect(getMapSceneFocusBounds(document, ["feature-near"])).toEqual({
      left: 176,
      right: 324,
      top: 216,
      bottom: 264,
    });
    const allContent = getMapSceneFocusBounds(document);
    expect(allContent).toEqual(
      expect.objectContaining({
        left: 176,
        top: 216,
        right: expect.any(Number),
        bottom: expect.any(Number),
      }),
    );
    expect(allContent!.right).toBeGreaterThan(1_500);
    expect(allContent!.bottom).toBeGreaterThan(850);
  });

  it("缩略导航按实际地图比例换算落点，并在留白处收束到边界", () => {
    const document = createDocument();

    expect(
      mapSceneNavigatorPointAt(
        document,
        { left: 40, top: 20, width: 176, height: 112 },
        { x: 128, y: 76 },
      ),
    ).toEqual({ x: 800, y: 500 });
    expect(
      mapSceneNavigatorPointAt(
        document,
        { left: 40, top: 20, width: 112, height: 176 },
        { x: 40, y: 20 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("交互预览越过四边时扩展临时世界范围，未越界时保持文档尺寸", () => {
    const document = createDocument();
    expect(
      getMapScenePreviewBounds(document, [
        { x: 200, y: 200 },
        { x: 1_700, y: 1_100 },
        { x: -40, y: -20 },
      ]),
    ).toEqual({ left: -200, right: 1_860, top: -180, bottom: 1_260 });
    expect(getMapScenePreviewBounds(document, [{ x: 800, y: 500 }])).toEqual({
      left: 0,
      right: document.canvas.width,
      top: 0,
      bottom: document.canvas.height,
    });
  });

  it("大尺寸笔刷越界时按笔刷外沿扩展临时世界范围", () => {
    const document = createDocument();

    expect(
      getMapScenePreviewBounds(
        document,
        [{ x: document.canvas.width + 24, y: 480 }],
        1_024,
      ),
    ).toEqual({
      left: 0,
      right: document.canvas.width + 1_048,
      top: 0,
      bottom: document.canvas.height,
    });
  });

  it("四向越界预览保留原画布与手势外沿，供连续工作区即时显示", () => {
    const document = createDocument();

    expect(
      getMapScenePreviewBounds(
        document,
        [
          { x: -80, y: 480 },
          { x: 2_080, y: 1_160 },
        ],
        200,
      ),
    ).toEqual({
      left: -280,
      right: 2_280,
      top: 0,
      bottom: 1_360,
    });
  });

  it("按住空格时优先平移，不会在素材笔刷中误落一笔", () => {
    const { canvas, onSceneStroke } = renderSceneCanvas();

    fireEvent.keyDown(window, { code: "Space" });
    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 160,
      clientY: 120,
      pointerId: 1,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 300,
      clientY: 180,
      pointerId: 1,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 300,
      clientY: 180,
      pointerId: 1,
    });
    fireEvent.keyUp(window, { code: "Space" });

    expect(onSceneStroke).not.toHaveBeenCalled();
  });

  it("中键只负责平移，左键仍可提交一笔素材", () => {
    const { canvas, onSceneStroke } = renderSceneCanvas();

    firePointer(canvas, "pointerdown", {
      button: 1,
      clientX: 160,
      clientY: 120,
      pointerId: 2,
    });
    firePointer(canvas, "pointerup", {
      button: 1,
      clientX: 300,
      clientY: 180,
      pointerId: 2,
    });
    expect(onSceneStroke).not.toHaveBeenCalled();

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 160,
      clientY: 120,
      pointerId: 3,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 300,
      clientY: 180,
      pointerId: 3,
    });

    expect(onSceneStroke).toHaveBeenCalledWith(
      "forest",
      expect.arrayContaining([
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      ]),
    );
  });

  it("素材笔刷的弧线模式会把弧线触点提交给场景", () => {
    const { canvas, onSceneStroke } = renderSceneCanvas({
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushSpacing: 48,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 200,
      pointerId: 4,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 680,
      clientY: 200,
      pointerId: 4,
    });

    const points = onSceneStroke.mock.calls.at(-1)?.[1] as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(points?.length).toBeGreaterThan(2);
    expect(points?.some((point) => point.y !== 200)).toBe(true);
  });

  it("空白海域不会保存不可见的地貌材质笔触", () => {
    const onTerrainMaterialRejected = vi.fn();
    const { canvas, onTerrainMaterialStroke } = renderSceneCanvas({
      tool: "terrain-material",
      activeTerrainMaterial: "forest",
      artworkBrushAssetId: null,
      onTerrainMaterialRejected,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 360,
      clientY: 260,
      pointerId: 24,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 360,
      clientY: 260,
      pointerId: 24,
    });

    expect(onTerrainMaterialStroke).not.toHaveBeenCalled();
    expect(onTerrainMaterialRejected).toHaveBeenCalledTimes(1);
  });

  it("自由画笔首尾闭合时保存为可转换区域，并保留均匀触点", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 25,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 500,
      clientY: 200,
      pointerId: 25,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 500,
      clientY: 500,
      pointerId: 25,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 204,
      clientY: 204,
      pointerId: 25,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 204,
      clientY: 204,
      pointerId: 25,
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "area",
        props: expect.objectContaining({ freehand: "true", closed: "true" }),
        points: expect.any(Array),
      }),
    );
    const feature = onCreate.mock.calls.at(-1)?.[0];
    expect(feature?.points).toHaveLength(
      DEFAULT_MAP_CANVAS_SETTINGS.brushPointCount,
    );
  });

  it("自由画笔未闭合时保存为开放路线，不提供区域语义", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 26,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 500,
      clientY: 240,
      pointerId: 26,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 700,
      clientY: 280,
      pointerId: 26,
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({ freehand: "true", closed: "false" }),
      }),
    );
  });

  it("自由画笔会保留短距离内的微小弯曲", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 16,
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 300,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 304,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 308,
      clientY: 302,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 312,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 316,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 320,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 324,
      clientY: 300,
      pointerId: 27,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 328,
      clientY: 300,
      pointerId: 27,
    });

    const feature = onCreate.mock.calls.at(-1)?.[0];
    const points = feature?.points as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({ freehand: "true", closed: "false" }),
      }),
    );
    expect(points?.slice(1, -1).some((point) => point.y > 300.5)).toBe(true);
  });

  it("自由画笔不会过滤小于采样阈值的连续弯折", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 32,
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 400,
      clientY: 400,
      pointerId: 28,
    });
    for (let offset = 1; offset <= 30; offset += 1) {
      firePointer(canvas, "pointermove", {
        button: 0,
        clientX: 400 + offset,
        clientY: offset === 1 ? 401 : 400,
        pointerId: 28,
      });
    }
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 431,
      clientY: 400,
      pointerId: 28,
    });

    const feature = onCreate.mock.calls.at(-1)?.[0];
    const points = feature?.points as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(feature?.kind).toBe("route");
    expect(points?.some((point) => point.y > 400.1)).toBe(true);
  });

  it("自由画笔的短弯线不会被误判为闭合区域", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 8,
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 500,
      clientY: 500,
      pointerId: 30,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 504,
      clientY: 502,
      pointerId: 30,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 508,
      clientY: 500,
      pointerId: 30,
    });

    const feature = onCreate.mock.calls.at(-1)?.[0];
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({ freehand: "true", closed: "false" }),
      }),
    );
    expect(
      (feature?.points as readonly { readonly y: number }[] | undefined)?.some(
        (point) => point.y > 500.5,
      ),
    ).toBe(true);
  });

  it("独立自由画笔入口不受区域形状残留状态影响，并保留弧线模式", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "ellipse",
        brushPointCount: 9,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 220,
      clientY: 260,
      pointerId: 28,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 420,
      clientY: 320,
      pointerId: 28,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 620,
      clientY: 260,
      pointerId: 28,
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        points: expect.arrayContaining([
          expect.objectContaining({ x: expect.closeTo(220), y: 260 }),
          expect.objectContaining({ x: 620, y: 260 }),
        ]),
        props: expect.objectContaining({
          freehand: "true",
          closed: "false",
          curve: "arc",
        }),
      }),
    );
  });

  it("自由画笔只含起终点时，弧线模式也会生成弯曲控制点", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "freehand",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 9,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 29,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 700,
      clientY: 200,
      pointerId: 29,
    });

    const feature = onCreate.mock.calls.at(-1)?.[0];
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({
          freehand: "true",
          closed: "false",
          curve: "arc",
        }),
      }),
    );
    expect(feature?.points).toHaveLength(9);
    const points = feature?.points as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(
      points?.some((point, index) => index > 0 && index < 8 && point.y !== 200),
    ).toBe(true);
  });

  it("陆地区域画笔也遵守弧线触点和触点数量", () => {
    const { canvas, onSceneRegionCreate } = renderSceneCanvas({
      tool: "terrain-region-land",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 12,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 240,
      clientY: 240,
      pointerId: 30,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 560,
      clientY: 240,
      pointerId: 30,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 560,
      clientY: 560,
      pointerId: 30,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 244,
      clientY: 244,
      pointerId: 30,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 244,
      clientY: 244,
      pointerId: 30,
    });

    const points = onSceneRegionCreate.mock.calls.at(-1)?.[1] as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(points).toHaveLength(12);
    expect(points?.some((point) => point.x !== 240 && point.y !== 240)).toBe(
      true,
    );
    expect(onSceneRegionCreate.mock.calls.at(-1)?.[2]).toBe("arc");
  });

  it("画笔形状选择自由画笔时，弧线触点会作用于最终区域", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "area",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "freehand",
        brushPointCount: 12,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 240,
      clientY: 240,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 560,
      clientY: 240,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 560,
      clientY: 560,
      pointerId: 27,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 244,
      clientY: 244,
      pointerId: 27,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 244,
      clientY: 244,
      pointerId: 27,
    });

    const feature = onCreate.mock.calls.at(-1)?.[0];
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "area",
        props: expect.objectContaining({ freehand: "true", closed: "true" }),
      }),
    );
    expect(feature?.points).toHaveLength(12);
    const points = feature?.points as
      | readonly { readonly x: number; readonly y: number }[]
      | undefined;
    expect(
      points?.some(
        (point, index, points) =>
          index > 0 &&
          index < points.length - 1 &&
          point.x !== points[index - 1]!.x &&
          point.y !== points[index - 1]!.y,
      ),
    ).toBe(true);
  });

  it("点击路径构件后，在画布落点即可提交成品预制路线", () => {
    const { canvas, onComponentDrop } = renderSceneCanvas({
      tool: "terrain-prefab",
      activePrefabComponentId: "river",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 240,
      clientY: 180,
      pointerId: 12,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 720,
      clientY: 520,
      pointerId: 12,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 720,
      clientY: 520,
      pointerId: 12,
    });

    expect(onComponentDrop).toHaveBeenCalledTimes(1);
    expect(onComponentDrop).toHaveBeenCalledWith(
      "river",
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
      }),
      expect.objectContaining({
        start: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
        end: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      }),
    );
  });

  it("疆域覆盖层笔刷沿拖拽轨迹提交连续区域，而不是一次性预制件", () => {
    const { canvas, onComponentSurface, onComponentDrop } = renderSceneCanvas({
      tool: "component-surface-brush",
      activePrefabComponentId: "territory-fill",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 12,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 220,
      clientY: 240,
      pointerId: 14,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 520,
      clientY: 360,
      pointerId: 14,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 820,
      clientY: 260,
      pointerId: 14,
    });

    expect(onComponentDrop).not.toHaveBeenCalled();
    expect(onComponentSurface).toHaveBeenCalledTimes(1);
    expect(onComponentSurface).toHaveBeenCalledWith(
      "territory-fill",
      expect.any(Array),
      false,
      "arc",
    );
    const points = onComponentSurface.mock.calls[0]?.[1] as readonly {
      x: number;
      y: number;
    }[];
    expect(points).toHaveLength(12);
    expect(points.some((point) => point.y !== points[0]!.y)).toBe(true);
  });

  it("大陆预设拖动只提交预制区域放置，不会进入连续表面笔刷", () => {
    const { canvas, onComponentDrop, onComponentSurface } = renderSceneCanvas({
      tool: "terrain-prefab",
      activePrefabComponentId: "continent",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 220,
      clientY: 240,
      pointerId: 15,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 720,
      clientY: 440,
      pointerId: 15,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 720,
      clientY: 440,
      pointerId: 15,
    });

    expect(onComponentSurface).not.toHaveBeenCalled();
    expect(onComponentDrop).toHaveBeenCalledWith(
      "continent",
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
      }),
      expect.objectContaining({
        start: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
        end: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      }),
    );
  });

  it("大陆预设被错误设为连续笔刷时，画布不会提交带状区域", () => {
    const { canvas, onComponentDrop, onComponentSurface } = renderSceneCanvas({
      tool: "component-surface-brush",
      activePrefabComponentId: "continent",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 220,
      clientY: 240,
      pointerId: 16,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 720,
      clientY: 440,
      pointerId: 16,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 720,
      clientY: 440,
      pointerId: 16,
    });

    expect(onComponentSurface).not.toHaveBeenCalled();
    expect(onComponentDrop).not.toHaveBeenCalled();
  });

  it("拖动素材印章时把尺寸和方向手势传给放置回调", () => {
    const { canvas, onArtworkStampPlace } = renderSceneCanvas({
      tool: "artwork-stamp",
      activeStampAssetId: "city",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 240,
      pointerId: 13,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 580,
      clientY: 240,
      pointerId: 13,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 580,
      clientY: 240,
      pointerId: 13,
    });

    expect(onArtworkStampPlace).toHaveBeenCalledTimes(1);
    expect(onArtworkStampPlace).toHaveBeenCalledWith(
      "city",
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
      }),
      expect.objectContaining({
        start: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
        end: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      }),
    );
  });

  it("外部素材拖入时保留素材语义，并在落下后只提交一次组件放置", () => {
    const { onComponentDrop } = renderSceneCanvas({
      tool: "select",
      artworkBrushAssetId: null,
    });
    const canvasRoot = screen.getByLabelText("地图设计画布");
    const dataTransfer = {
      types: [MAP_COMPONENT_DRAG_MIME],
      dropEffect: "none",
      getData: vi.fn(() => "sea-foam"),
    };

    fireEvent.dragOver(canvasRoot, {
      clientX: 460,
      clientY: 280,
      dataTransfer,
    });

    expect(dataTransfer.dropEffect).toBe("copy");
    expect(dataTransfer.getData).toHaveBeenCalledWith(MAP_COMPONENT_DRAG_MIME);

    fireEvent.drop(canvasRoot, {
      clientX: 460,
      clientY: 280,
      dataTransfer,
    });

    expect(onComponentDrop).toHaveBeenCalledTimes(1);
    expect(onComponentDrop).toHaveBeenCalledWith(
      "sea-foam",
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
      }),
    );
  });

  it("右键不会启动标记、路线等语义绘制", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "marker",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 2,
      clientX: 160,
      clientY: 120,
      pointerId: 4,
    });
    firePointer(canvas, "pointerup", {
      button: 2,
      clientX: 160,
      clientY: 120,
      pointerId: 4,
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["terrain-region-land", "land"],
    ["terrain-region-water", "water"],
  ] as const)("拖动勾画 %s 时一次性创建 %s 区域", (tool, kind) => {
    const { canvas, onSceneRegionCreate } = renderSceneCanvas({
      tool,
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 120,
      clientY: 120,
      pointerId: 5,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 480,
      clientY: 120,
      pointerId: 5,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 480,
      clientY: 480,
      pointerId: 5,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 120,
      clientY: 480,
      pointerId: 5,
    });

    expect(onSceneRegionCreate).toHaveBeenCalledTimes(1);
    const [receivedKind, points] = onSceneRegionCreate.mock.calls[0]!;
    expect(receivedKind).toBe(kind);
    expect(points).toHaveLength(4);
  });

  it("闭合形状沿拖拽轨迹创建闭合 area 要素", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "area",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "closed",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 6,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 500,
      clientY: 180,
      pointerId: 6,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 440,
      clientY: 460,
      pointerId: 6,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 6,
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "area",
        points: expect.arrayContaining([
          expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        ]),
      }),
    );
    expect(onCreate.mock.calls[0]?.[0].points.length).toBeGreaterThanOrEqual(3);
  });

  it("多边形画笔逐点击落开放路径，双击确认时不强制闭合", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "polygon",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "polygon",
      },
    });

    for (const [clientX, clientY, pointerId] of [
      [180, 160, 31],
      [500, 180, 32],
    ] as const) {
      firePointer(canvas, "pointerdown", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
      firePointer(canvas, "pointerup", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
    }

    fireEvent.doubleClick(canvas, {
      button: 0,
      clientX: 440,
      clientY: 460,
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    const feature = onCreate.mock.calls[0]?.[0];
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "route",
        name: "多边形",
        props: expect.objectContaining({
          polygonBrush: "true",
          closed: "false",
        }),
      }),
    );
    expect(feature?.points).toHaveLength(3);
    expect(feature?.points[0]).toEqual({ x: 180, y: 160 });
    expect(feature?.points[1]).toEqual({ x: 500, y: 180 });
    expect(feature?.points[2]?.x).toBeCloseTo(440, 8);
    expect(feature?.points[2]?.y).toBeCloseTo(460, 8);
  });

  it("多边形画笔点击首点可以闭合路径", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "polygon",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "polygon",
      },
    });

    for (const [clientX, clientY, pointerId] of [
      [180, 160, 41],
      [500, 180, 42],
      [440, 460, 43],
    ] as const) {
      firePointer(canvas, "pointerdown", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
      firePointer(canvas, "pointerup", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
    }

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 44,
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    const feature = onCreate.mock.calls[0]?.[0];
    expect(feature).toEqual(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({
          polygonBrush: "true",
          closed: "true",
        }),
      }),
    );
    expect(feature?.points).toHaveLength(3);
    expect(feature?.points.at(-1)).not.toEqual(feature?.points[0]);
  });

  it("多边形画笔可以单击右键确认开放路径", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "polygon",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        areaShape: "polygon",
      },
    });

    for (const [clientX, clientY, pointerId] of [
      [180, 160, 51],
      [500, 180, 52],
    ] as const) {
      firePointer(canvas, "pointerdown", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
      firePointer(canvas, "pointerup", {
        button: 0,
        clientX,
        clientY,
        pointerId,
      });
    }

    fireEvent.contextMenu(canvas, {
      button: 2,
      clientX: 440,
      clientY: 460,
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        kind: "route",
        props: expect.objectContaining({
          polygonBrush: "true",
          closed: "false",
        }),
      }),
    );
    expect(onCreate.mock.calls[0]?.[0].points).toHaveLength(3);
  });

  it("画笔按指定数量使用弧线触点提交闭合区域", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "area",
      artworkBrushAssetId: null,
      settings: {
        ...DEFAULT_MAP_CANVAS_SETTINGS,
        brushPointCount: 8,
        brushPointCurve: "arc",
      },
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 19,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 520,
      clientY: 180,
      pointerId: 19,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 440,
      clientY: 460,
      pointerId: 19,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 19,
    });

    expect(onCreate.mock.calls[0]?.[0].points).toHaveLength(8);
  });

  it.each(["circle", "ellipse"] as const)(
    "画笔选择 %s 时按拖拽包围盒创建闭合区域",
    (areaShape) => {
      const { canvas, onCreate } = renderSceneCanvas({
        tool: "area",
        artworkBrushAssetId: null,
        settings: { ...DEFAULT_MAP_CANVAS_SETTINGS, areaShape },
      });

      firePointer(canvas, "pointerdown", {
        button: 0,
        clientX: 180,
        clientY: 160,
        pointerId: 11,
      });
      firePointer(canvas, "pointerup", {
        button: 0,
        clientX: 500,
        clientY: 360,
        pointerId: 11,
      });

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "area",
          points: expect.arrayContaining([
            expect.objectContaining({
              x: expect.any(Number),
              y: expect.any(Number),
            }),
          ]),
        }),
      );
      expect(onCreate.mock.calls[0]?.[0].points).toHaveLength(32);
    },
  );

  it("河流画笔直接创建带水文样式的路线", () => {
    const { canvas, onCreate } = renderSceneCanvas({
      tool: "river",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 160,
      pointerId: 12,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 500,
      clientY: 360,
      pointerId: 12,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 640,
      clientY: 420,
      pointerId: 12,
    });

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        name: "新河流",
        props: expect.objectContaining({
          terrain: "river",
          sourceWidth: "2",
          mouthWidth: "10",
        }),
      }),
    );
  });

  it("空白拖框会框选可独立变换的要素，并将主选择交给编辑器", () => {
    const document = {
      ...createDocument(),
      features: [
        {
          id: "feature-west",
          kind: "marker" as const,
          name: "西境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
        {
          id: "feature-east",
          kind: "marker" as const,
          name: "东境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 620, y: 420 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const { canvas, onSelectionChange } = renderSceneCanvas({
      document,
      tool: "select",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 180,
      clientY: 140,
      pointerId: 8,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 760,
      clientY: 560,
      pointerId: 8,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 760,
      clientY: 560,
      pointerId: 8,
    });

    expect(onSelectionChange).toHaveBeenCalledWith(
      ["feature-west", "feature-east"],
      "feature-east",
    );
  });

  it("首击只选中对象，第二次手势才移动对象", () => {
    const document = {
      ...createDocument(),
      features: [
        {
          id: "feature-west",
          kind: "marker" as const,
          name: "西境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const { canvas, onSelectionChange, onGeometryChange } = renderSceneCanvas({
      document,
      tool: "select",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 20,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 20,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 20,
    });

    expect(onSelectionChange).toHaveBeenCalledWith(
      ["feature-west"],
      "feature-west",
    );
    expect(onGeometryChange).not.toHaveBeenCalled();

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 21,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 21,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 21,
    });

    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onGeometryChange).toHaveBeenCalledWith("feature-west", [
      { x: 520, y: 340 },
    ]);
  });

  it("移动工具用一次拖拽选中并移动对象", () => {
    const document = {
      ...createDocument(),
      features: [
        {
          id: "feature-west",
          kind: "marker" as const,
          name: "西境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const { canvas, onGeometryChange, onSelectionChange } = renderSceneCanvas({
      document,
      tool: "move",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 22,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 22,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 520,
      clientY: 340,
      pointerId: 22,
    });

    expect(onSelectionChange).toHaveBeenCalledWith(
      ["feature-west"],
      "feature-west",
    );
    expect(onGeometryChange).toHaveBeenCalledWith("feature-west", [
      { x: 520, y: 340 },
    ]);
  });

  it("拖动选区内任一要素时，批量移动只在松手后提交一次", () => {
    const document = {
      ...createDocument(),
      features: [
        {
          id: "feature-west",
          kind: "marker" as const,
          name: "西境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
        {
          id: "feature-east",
          kind: "marker" as const,
          name: "东境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 620, y: 420 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const { canvas, onBatchMove } = renderSceneCanvas({
      document,
      tool: "select",
      artworkBrushAssetId: null,
      selectedFeatureId: "feature-east",
      selectedFeatureIds: ["feature-west", "feature-east"],
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 9,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 400,
      clientY: 300,
      pointerId: 9,
    });
    expect(onBatchMove).not.toHaveBeenCalled();
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 400,
      clientY: 300,
      pointerId: 9,
    });

    expect(onBatchMove).toHaveBeenCalledTimes(1);
    expect(onBatchMove).toHaveBeenCalledWith(
      ["feature-west", "feature-east"],
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("覆盖陆地的地貌材质可逐层追加选择并一起移动", () => {
    const base = createDocument();
    const document = {
      ...base,
      scene: {
        ...base.scene!,
        layers: base.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  createMapSceneRegion({
                    id: "land-continent",
                    layerId: layer.id,
                    kind: "land",
                    points: [
                      { x: 240, y: 180 },
                      { x: 680, y: 180 },
                      { x: 680, y: 460 },
                      { x: 240, y: 460 },
                    ],
                  }),
                ],
                strokes: [
                  createMapSceneStroke({
                    id: "material-desert",
                    layerId: layer.id,
                    terrainMaterial: "desert",
                    points: [
                      { x: 300, y: 320 },
                      { x: 620, y: 320 },
                    ],
                    color: "#c9a865",
                    width: 140,
                  }),
                ],
              }
            : layer,
        ),
      },
    };
    const { canvas, onBatchMove, onSelectionChange } = renderSceneCanvas({
      document,
      tool: "select",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 460,
      clientY: 320,
      pointerId: 31,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 460,
      clientY: 320,
      pointerId: 31,
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["material-desert"],
      "material-desert",
    );

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 460,
      clientY: 320,
      pointerId: 32,
      shiftKey: true,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 460,
      clientY: 320,
      pointerId: 32,
      shiftKey: true,
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["material-desert", "land-continent"],
      "land-continent",
    );

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 460,
      clientY: 320,
      pointerId: 33,
    });
    firePointer(canvas, "pointermove", {
      button: 0,
      clientX: 580,
      clientY: 380,
      pointerId: 33,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 580,
      clientY: 380,
      pointerId: 33,
    });

    expect(onBatchMove).toHaveBeenCalledTimes(1);
    const [ids, delta] = onBatchMove.mock.calls[0]!;
    expect(ids).toEqual(["material-desert", "land-continent"]);
    expect(delta?.x).toBeCloseTo(120);
    expect(delta?.y).toBeCloseTo(60);
  });

  it("Shift 点击可追加或移除独立要素选择", () => {
    const document = {
      ...createDocument(),
      features: [
        {
          id: "feature-west",
          kind: "marker" as const,
          name: "西境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
        {
          id: "feature-east",
          kind: "marker" as const,
          name: "东境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 620, y: 420 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    const { canvas, onSelectionChange } = renderSceneCanvas({
      document,
      tool: "select",
      artworkBrushAssetId: null,
    });

    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 10,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 320,
      clientY: 240,
      pointerId: 10,
    });
    firePointer(canvas, "pointerdown", {
      button: 0,
      clientX: 620,
      clientY: 420,
      pointerId: 11,
      shiftKey: true,
    });
    firePointer(canvas, "pointerup", {
      button: 0,
      clientX: 620,
      clientY: 420,
      pointerId: 11,
      shiftKey: true,
    });

    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["feature-west", "feature-east"],
      "feature-east",
    );
  });
});
