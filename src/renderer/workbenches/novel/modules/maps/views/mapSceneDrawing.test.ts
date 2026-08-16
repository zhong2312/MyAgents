import { describe, expect, it, vi } from "vitest";

import { createEmptyMapDocument } from "../entities/mapSchema";
import {
  drawAzgaarOverlayFeature,
  drawMapFeatureLabel,
  drawMapSceneRegionEdge,
  drawMapStyledRoute,
  featureVisible,
  samplePath,
  shouldDrawMapFeatureTextOverlay,
  shouldDrawMapSceneRegionEdge,
} from "./mapSceneDrawing";

describe("mapSceneDrawing", () => {
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

  it("区域边线以相同的平滑路径进入成图渲染", () => {
    const stroke = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
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
    expect(context.quadraticCurveTo).toHaveBeenCalledTimes(3);
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
