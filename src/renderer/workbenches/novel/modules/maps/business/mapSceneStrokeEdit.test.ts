import { describe, expect, it } from "vitest";

import {
  findMapSceneStrokeControlPointHandle,
  mapSceneStrokeControlPointIndexes,
  moveMapSceneStrokeControlPoint,
} from "./mapSceneStrokeEdit";

describe("mapSceneStrokeEdit", () => {
  it("从长笔触稳定派生有限且包含首尾的控制点", () => {
    const points = Array.from({ length: 37 }, (_, index) => ({
      x: index * 12,
      y: index * 3,
    }));

    expect(mapSceneStrokeControlPointIndexes(points)).toEqual([
      0, 5, 10, 15, 21, 26, 31, 36,
    ]);
    expect(mapSceneStrokeControlPointIndexes(points, 64)).toHaveLength(8);
    expect(findMapSceneStrokeControlPointHandle(points, points[21]!, 1)).toBe(
      21,
    );
  });

  it("拖动控制点平滑影响相邻采样，不改变远处笔触", () => {
    const points = Array.from({ length: 9 }, (_, index) => ({
      x: index * 10,
      y: 100,
    }));

    const moved = moveMapSceneStrokeControlPoint(
      points,
      4,
      { x: 40, y: 140 },
      { width: 300, height: 300 },
      3,
    );

    expect(moved[4]).toEqual({ x: 40, y: 140 });
    expect(moved[3]).toEqual({ x: 30, y: 120 });
    expect(moved[5]).toEqual({ x: 50, y: 120 });
    expect(moved[0]).toEqual(points[0]);
    expect(moved[8]).toEqual(points[8]);
  });
});
