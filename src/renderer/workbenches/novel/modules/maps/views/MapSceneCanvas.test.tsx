import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import MapSceneCanvas, {
  getMapSceneFocusBounds,
  getMapScenePreviewBounds,
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
