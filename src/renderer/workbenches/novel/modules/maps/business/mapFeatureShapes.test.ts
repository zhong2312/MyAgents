import { describe, expect, it } from "vitest";

import {
  isMapBrushPathClosed,
  mapBrushCurvePoints,
  resampleMapBrushPoints,
  resampleMapBrushPointsBySpacing,
} from "./mapFeatureShapes";

describe("地图画笔触点重采样", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ] as const;

  it("直线模式返回指定数量且沿路径等距", () => {
    const points = resampleMapBrushPoints(path, 5, "line");
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual(path[0]);
    expect(points.at(-1)).toEqual(path.at(-1));
    expect(points[1]!.x).toBeCloseTo(50, 0);
    expect(points[1]!.y).toBeCloseTo(0, 0);
  });

  it("弧线模式返回指定数量且开放路径端点保持稳定", () => {
    const points = resampleMapBrushPoints(path, 7, "arc");
    expect(points).toHaveLength(7);
    expect(points[0]).toEqual(path[0]);
    expect(points.at(-1)).toEqual(path.at(-1));
    expect(points.some((point) => point.y !== 0)).toBe(true);
  });

  it("弧线模式对只有起终点的短笔划也不会退化成直线", () => {
    const points = resampleMapBrushPoints(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      9,
      "arc",
    );
    expect(points).toHaveLength(9);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 200, y: 0 });
    expect(Math.max(...points.map((point) => Math.abs(point.y)))).toBeGreaterThan(
      24,
    );
  });

  it("弧线模式对多个共线指针采样仍生成可见曲率", () => {
    const points = resampleMapBrushPoints(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 120, y: 0 },
        { x: 180, y: 0 },
      ],
      9,
      "arc",
    );

    expect(points).toHaveLength(9);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual(
      expect.objectContaining({
        x: expect.closeTo(180),
        y: expect.closeTo(0),
      }),
    );
    expect(points.slice(1, -1).some((point) => point.y !== 0)).toBe(true);
  });

  it("弧线模式会吸收真实拖拽的小幅抖动，而不是退化为近似直线", () => {
    const points = resampleMapBrushPoints(
      [
        { x: 0, y: 0 },
        { x: 60, y: 3 },
        { x: 120, y: -2 },
        { x: 180, y: 1 },
      ],
      9,
      "arc",
    );

    expect(points).toHaveLength(9);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual(
      expect.objectContaining({
        x: expect.closeTo(180),
        y: expect.closeTo(1),
      }),
    );
    expect(
      points.slice(1, -1).some((point) => Math.abs(point.y) > 8),
    ).toBe(true);
  });

  it("渲染采样与保存采样共用弧线算法，闭合区域不会退化为原始多边形", () => {
    const source = [
      { x: 0, y: 0 },
      { x: 140, y: 0 },
      { x: 120, y: 110 },
      { x: 0, y: 90 },
    ] as const;
    const line = mapBrushCurvePoints(source, "line", true);
    const arc = mapBrushCurvePoints(source, "arc", true);
    expect(line).toEqual(source);
    expect(arc.length).toBeGreaterThan(source.length);
    expect(
      arc.some(
        (point, index) =>
          point.x !== source[index % source.length]!.x ||
          point.y !== source[index % source.length]!.y,
      ),
    ).toBe(true);
  });

  it("闭合路径不重复首点，spacing 会生成均匀数量", () => {
    const closed = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 0 },
    ];
    const points = resampleMapBrushPoints(closed, 8, "line", true);
    expect(points).toHaveLength(8);
    expect(points.at(-1)).not.toEqual(points[0]);
    expect(isMapBrushPathClosed(closed, 1)).toBe(true);

    const spaced = resampleMapBrushPointsBySpacing(path, 25);
    expect(spaced.length).toBe(9);
    const distances = spaced
      .slice(1)
      .map((point, index) =>
        Math.hypot(point.x - spaced[index]!.x, point.y - spaced[index]!.y),
      );
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.01);
  });
});
