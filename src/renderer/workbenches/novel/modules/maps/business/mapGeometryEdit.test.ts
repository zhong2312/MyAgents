import { describe, expect, it } from "vitest";

import {
  findMapGeometryVertexHandle,
  hitMapFeatureGeometry,
  isMapFeatureVertexEditable,
  replaceMapGeometryVertex,
} from "./mapGeometryEdit";

describe("mapGeometryEdit", () => {
  it("以恒定的屏幕命中半径选择最近顶点", () => {
    const points = [
      { x: 100, y: 100 },
      { x: 220, y: 100 },
      { x: 150, y: 220 },
    ];

    expect(findMapGeometryVertexHandle(points, { x: 104, y: 102 }, 1)).toBe(0);
    expect(
      findMapGeometryVertexHandle(points, { x: 105, y: 102 }, 2),
    ).toBeNull();
    expect(findMapGeometryVertexHandle(points, { x: 102, y: 101 }, 2)).toBe(0);
    expect(
      findMapGeometryVertexHandle(points, { x: 300, y: 300 }, 1),
    ).toBeNull();
  });

  it("只替换指定顶点并保留任意方向的越界坐标", () => {
    const source = [
      { x: 20, y: 30 },
      { x: 150, y: 80 },
      { x: 90, y: 200 },
    ];
    const moved = replaceMapGeometryVertex(
      source,
      1,
      { x: 980, y: -45 },
      { width: 640, height: 360 },
    );

    expect(moved).toEqual([
      { x: 20, y: 30 },
      { x: 980, y: -45 },
      { x: 90, y: 200 },
    ]);
    expect(source[1]).toEqual({ x: 150, y: 80 });
  });

  it("从真实路径或区域命中整体拖动，点状要素不提供伪顶点", () => {
    const route = {
      id: "route-1",
      kind: "route" as const,
      name: "商路",
      entityRef: null,
      layerId: "layer-1",
      points: [
        { x: 40, y: 60 },
        { x: 220, y: 60 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { routeWidth: "8" },
      description: "",
    };
    const area = {
      ...route,
      id: "area-1",
      kind: "area" as const,
      points: [
        { x: 80, y: 100 },
        { x: 260, y: 100 },
        { x: 160, y: 240 },
      ],
    };

    expect(hitMapFeatureGeometry(route, { x: 160, y: 66 }, 1)).toBe(true);
    expect(hitMapFeatureGeometry(route, { x: 160, y: 86 }, 1)).toBe(false);
    expect(hitMapFeatureGeometry(area, { x: 160, y: 140 }, 1)).toBe(true);
    expect(hitMapFeatureGeometry(area, { x: 160, y: 88 }, 1)).toBe(true);
    expect(hitMapFeatureGeometry(area, { x: 72, y: 108 }, 1)).toBe(true);

    expect(isMapFeatureVertexEditable("route")).toBe(true);
    expect(isMapFeatureVertexEditable("polygon")).toBe(true);
    expect(isMapFeatureVertexEditable("area")).toBe(true);
    expect(isMapFeatureVertexEditable("marker")).toBe(false);
    expect(isMapFeatureVertexEditable("label")).toBe(false);
    expect(isMapFeatureVertexEditable("node")).toBe(false);
  });
});
