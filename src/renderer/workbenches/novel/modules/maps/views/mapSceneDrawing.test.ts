import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import {
  drawAzgaarOverlayFeature,
  drawMapBrushPath,
  drawMapFeatureLabel,
  drawMapSceneRegionPath,
  drawMapSceneRegionEdge,
  drawMapStyledRoute,
  drawTaperedRiver,
  featureVisible,
  mapFeatureBrushCurve,
  samplePath,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
} from "./mapSceneDrawing";

describe("mapSceneDrawing", () => {
  it("区域画笔的弧线模式真正改变闭合轮廓，直线模式保留折点", () => {
    const createContext = () => {
      const lineTo = vi.fn();
      const quadraticCurveTo = vi.fn();
      return {
        context: {
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo,
          quadraticCurveTo,
          closePath: vi.fn(),
        } as unknown as CanvasRenderingContext2D,
        lineTo,
        quadraticCurveTo,
      };
    };
    const points = [
      { x: 20, y: 30 },
      { x: 180, y: 36 },
      { x: 140, y: 180 },
    ];
    const line = createContext();
    const arc = createContext();
    drawMapSceneRegionPath(line.context, points, { x: 0, y: 0, zoom: 1 }, "line");
    drawMapSceneRegionPath(arc.context, points, { x: 0, y: 0, zoom: 1 }, "arc");
    expect(line.lineTo).toHaveBeenCalledTimes(points.length - 1);
    expect(line.quadraticCurveTo).not.toHaveBeenCalled();
    expect(arc.quadraticCurveTo).toHaveBeenCalled();
  });

  it("地形区域弧线使用统一采样器，而不是只把原始顶点当控制点", () => {
    const quadraticCurveTo = vi.fn();
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      closePath: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const points = [
      { x: 0, y: 0 },
      { x: 180, y: 0 },
      { x: 180, y: 120 },
    ];

    drawMapSceneRegionPath(
      context,
      points,
      { x: 0, y: 0, zoom: 1 },
      "arc",
    );

    // 统一采样后，曲线段数量不再等于原始控制点数量；这能保证
    // 区域、画笔要素和离屏地表使用同一条弧线中心线。
    expect(quadraticCurveTo.mock.calls.length).toBeGreaterThan(
      points.length,
    );
  });

  it("弧线画笔使用贝塞尔路径而不是把控制点直接连成折线", () => {
    const quadraticCurveTo = vi.fn();
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      closePath: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    drawMapBrushPath(
      context,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      { x: 0, y: 0, zoom: 1 },
      "arc",
    );

    expect(quadraticCurveTo).toHaveBeenCalled();
    expect(mapFeatureBrushCurve({ props: { curve: "arc" } })).toBe("arc");
    expect(mapFeatureBrushCurve({ props: {} })).toBe("line");
  });

  it("弧线模式不会因指针产生多个共线采样点而退化成直线", () => {
    const quadraticCurveTo = vi.fn();
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      closePath: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    drawMapBrushPath(
      context,
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 160, y: 0 },
        { x: 240, y: 0 },
      ],
      { x: 0, y: 0, zoom: 1 },
      "arc",
    );

    expect(quadraticCurveTo).toHaveBeenCalled();
    const controlPoint = quadraticCurveTo.mock.calls[0]?.[0] as number;
    const controlY = quadraticCurveTo.mock.calls[0]?.[1] as number;
    expect(controlPoint).toBeTypeOf("number");
    expect(controlY).not.toBe(0);
  });

  it("闭合弧线画笔会平滑连接首尾，而不是用直线封口", () => {
    const quadraticCurveTo = vi.fn();
    const closePath = vi.fn();
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      closePath,
    } as unknown as CanvasRenderingContext2D;

    drawMapBrushPath(
      context,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      { x: 0, y: 0, zoom: 1 },
      "arc",
      true,
    );

    // 闭合弧线先经过统一采样，再用二次曲线连接；采样点数可以随控制点
    // 数量变化，契约是必须产生曲线段而不是固定为原始顶点数量。
    expect(quadraticCurveTo.mock.calls.length).toBeGreaterThan(4);
    expect(closePath).toHaveBeenCalledTimes(1);
  });

  it("沿路径按固定世界坐标间距取样并保留终点", () => {
    const samples = samplePath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      28,
    );

    expect(samples).toHaveLength(5);
    samples.forEach((point, index) => {
      expect(point.x).toBeCloseTo([0, 28, 56, 84, 100][index]!);
      expect(point.y).toBe(0);
    });
  });

  it("导出与交互画布共用图层及时间切片可见性", () => {
    const map = createEmptyMapDocument({
      id: "visibility-map",
      name: "可见性测试",
      projectionType: "continent",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    const feature = {
      id: "timed-river",
      kind: "route" as const,
      name: "旧河道",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      timeFrom: 120,
      timeTo: 240,
      props: {},
      description: "",
    };

    expect(featureVisible(map, feature, null)).toBe(true);
    expect(featureVisible(map, feature, 119)).toBe(false);
    expect(featureVisible(map, feature, 120)).toBe(true);
    expect(featureVisible(map, feature, 240)).toBe(true);
    expect(featureVisible(map, feature, 241)).toBe(false);
    map.layers[0]!.visible = false;
    expect(featureVisible(map, feature, 180)).toBe(false);
  });

  it("标签描边与正文按相同变换绘制", () => {
    const translate = vi.fn();
    const rotate = vi.fn();
    const strokeText = vi.fn();
    const fillText = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate,
      rotate,
      strokeText,
      fillText,
      globalAlpha: 1,
      font: "",
      textAlign: "start",
      textBaseline: "alphabetic",
      lineJoin: "miter",
      strokeStyle: "",
      lineWidth: 1,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const feature = {
      id: "label-drawing",
      kind: "label" as const,
      name: "苍风隘口",
      entityRef: null,
      layerId: "layer-main",
      points: [{ x: 20, y: 30 }],
      timeFrom: null,
      timeTo: null,
      props: {
        labelSize: "12",
        labelOffsetX: "5",
        labelOffsetY: "-4",
        labelRotation: "30",
        labelHaloWidth: "3",
      },
      description: "",
    };

    drawMapFeatureLabel(
      context,
      feature,
      feature.points,
      { x: 0, y: 0, zoom: 2 },
      0.8,
    );

    expect(translate).toHaveBeenCalledWith(50, 52);
    expect(rotate).toHaveBeenCalledWith(Math.PI / 6);
    expect(context.font).toContain("24px");
    expect(context.lineWidth).toBe(6);
    expect(strokeText).toHaveBeenCalledWith("苍风隘口", 0, 0);
    expect(fillText).toHaveBeenCalledWith("苍风隘口", 0, 0);
  });

  it("道路和城墙在单次路线事实上绘制出边缘与结构细节", () => {
    const stroke = vi.fn();
    const arc = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke,
      fill: vi.fn(),
      arc,
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const wall = {
      id: "wall-drawing",
      kind: "route" as const,
      name: "北境长墙",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 20, y: 30 },
        { x: 220, y: 120 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { routeStyle: "wall" },
      description: "",
    };

    expect(
      drawMapStyledRoute(
        context,
        wall,
        wall.points,
        { x: 0, y: 0, zoom: 1 },
        1,
      ),
    ).toBe(true);
    expect(stroke.mock.calls.length).toBeGreaterThan(2);
    expect(arc).toHaveBeenCalled();
  });

  it("路线与河流的弧线触点会改变实际成图路径", () => {
    const context = () => {
      const lineTo = vi.fn();
      return {
        context: {
          save: vi.fn(),
          restore: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo,
          stroke: vi.fn(),
          arc: vi.fn(),
          setLineDash: vi.fn(),
          globalAlpha: 1,
          strokeStyle: "",
          fillStyle: "",
          lineWidth: 1,
          lineCap: "butt",
          lineJoin: "miter",
        } as unknown as CanvasRenderingContext2D,
        lineTo,
      };
    };
    const points = [
      { x: 20, y: 30 },
      { x: 160, y: 42 },
      { x: 108, y: 160 },
    ];
    const route = {
      id: "arc-road",
      kind: "route" as const,
      name: "弧线道路",
      entityRef: null,
      layerId: "layer-main",
      points,
      timeFrom: null,
      timeTo: null,
      props: { routeStyle: "road", curve: "arc" },
      description: "",
    };
    const lineRoute = {
      ...route,
      id: "line-road",
      props: { ...route.props, curve: "line" },
    };
    const arcRouteContext = context();
    const lineRouteContext = context();
    drawMapStyledRoute(
      arcRouteContext.context,
      route,
      points,
      { x: 0, y: 0, zoom: 1 },
      1,
    );
    drawMapStyledRoute(
      lineRouteContext.context,
      lineRoute,
      points,
      { x: 0, y: 0, zoom: 1 },
      1,
    );
    expect(arcRouteContext.lineTo.mock.calls.length).toBeGreaterThan(
      lineRouteContext.lineTo.mock.calls.length,
    );

    const arcRiverContext = context();
    const lineRiverContext = context();
    const river = {
      ...route,
      id: "arc-river",
      props: {
        terrain: "river",
        curve: "arc",
      },
    };
    const lineRiver = {
      ...river,
      id: "line-river",
      props: { ...river.props, curve: "line" },
    };
    drawTaperedRiver(
      arcRiverContext.context,
      river,
      points,
      { x: 0, y: 0, zoom: 1 },
      1,
    );
    drawTaperedRiver(
      lineRiverContext.context,
      lineRiver,
      points,
      { x: 0, y: 0, zoom: 1 },
      1,
    );
    expect(arcRiverContext.lineTo.mock.calls.length).toBeGreaterThan(
      lineRiverContext.lineTo.mock.calls.length,
    );
  });

  it("只有起点和终点时，弧线仍会产生可见弯曲采样", () => {
    const lineTo = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo,
      stroke: vi.fn(),
      arc: vi.fn(),
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const feature = {
      id: "short-arc-river",
      kind: "route" as const,
      name: "短弧线河流",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 40, y: 80 },
        { x: 240, y: 80 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { terrain: "river", curve: "arc" },
      description: "",
    };
    drawTaperedRiver(
      context,
      feature,
      feature.points,
      { x: 0, y: 0, zoom: 1 },
      1,
    );
    expect(lineTo.mock.calls.length).toBeGreaterThan(2);
    expect(lineTo.mock.calls.some(([, y]) => y !== 80)).toBe(true);
  });

  it("Azgaar 行政区域仅叠加可编辑边界，不再次填满官方 SVG 底图", () => {
    const fill = vi.fn();
    const stroke = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill,
      stroke,
      arc: vi.fn(),
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const state = {
      id: "azgaar-state",
      kind: "polygon" as const,
      name: "北境",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 20, y: 30 },
        { x: 160, y: 42 },
        { x: 108, y: 160 },
      ],
      timeFrom: null,
      timeTo: null,
      props: {
        azgaarLayer: "state",
        color: "#aa5544",
        fill: "#aa554455",
        showLabel: "true",
      },
      description: "",
    };

    expect(
      drawAzgaarOverlayFeature(
        context,
        state,
        state.points,
        { x: 0, y: 0, zoom: 1 },
        1,
        true,
      ),
    ).toBe(true);
    expect(stroke).toHaveBeenCalledOnce();
    expect(fill).not.toHaveBeenCalled();
    expect(context.strokeStyle).toBe("#aa5544");
    expect(
      drawAzgaarOverlayFeature(
        context,
        state,
        state.points,
        { x: 0, y: 0, zoom: 1 },
        1,
        false,
      ),
    ).toBe(false);
    expect(shouldDrawMapFeatureTextOverlay(state, true)).toBe(false);
    expect(shouldDrawMapFeatureTextOverlay(state, false)).toBe(true);
    expect(
      shouldDrawMapFeatureTextOverlay(
        { ...state, props: { ...state.props, azgaarShowLabel: "true" } },
        true,
      ),
    ).toBe(true);
  });

  it("Azgaar 自由区域叠加也消费弧线控制点", () => {
    const quadraticCurveTo = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const state = {
      id: "azgaar-curved-state",
      kind: "area" as const,
      name: "弧线州域",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 20, y: 30 },
        { x: 160, y: 42 },
        { x: 108, y: 160 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { azgaarLayer: "state", curve: "arc" },
      description: "",
    };

    expect(
      drawAzgaarOverlayFeature(
        context,
        state,
        state.points,
        { x: 0, y: 0, zoom: 1 },
        1,
        true,
      ),
    ).toBe(true);
    expect(quadraticCurveTo).toHaveBeenCalled();
  });

  it("区域边线以相同的平滑路径进入成图渲染", () => {
    const stroke = vi.fn();
    const quadraticCurveTo = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo,
      closePath: vi.fn(),
      stroke,
      globalAlpha: 1,
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const region = {
      id: "region-edge",
      layerId: "scene-terrain",
      kind: "land" as const,
      points: [
        { x: 20, y: 30 },
        { x: 160, y: 42 },
        { x: 108, y: 160 },
      ],
      fill: "#b8ad7d",
      texture: "paper-land" as const,
      opacity: 0.7,
      edgeColor: "#4a3a2a",
      edgeWidth: 3,
    };

    drawMapSceneRegionEdge(
      context,
      region,
      region.points,
      { x: 10, y: 20, zoom: 2 },
      0.6,
    );

    expect(context.strokeStyle).toBe("#4a3a2a");
    expect(context.lineWidth).toBe(6);
    expect(quadraticCurveTo.mock.calls.length).toBeGreaterThan(3);
    expect(stroke).toHaveBeenCalledOnce();
  });

  it("合成地表只绘制陆地并集的海岸线，水域仍保留独立边界", () => {
    const land = {
      id: "land-region",
      layerId: "scene-terrain",
      kind: "land" as const,
      points: [
        { x: 20, y: 30 },
        { x: 160, y: 42 },
        { x: 108, y: 160 },
      ],
      fill: "#b8ad7d",
      texture: "paper-land" as const,
      opacity: 1,
      edgeColor: "#4a3a2a",
      edgeWidth: 3,
    };
    const water = { ...land, id: "water-region", kind: "water" as const };

    expect(shouldDrawMapSceneRegionEdge(land, false)).toBe(true);
    expect(shouldDrawMapSceneRegionEdge(land, true)).toBe(false);
    expect(shouldDrawMapSceneRegionEdge(water, true)).toBe(true);
  });
});
