import { describe, expect, it } from "vitest";

import {
  getMapRiverStyle,
  hasMapRiverAppearance,
  isMapRiverFeature,
  mapRiverWidthAt,
  reverseMapRiverFeature,
  smoothMapPath,
} from "./mapHydrography";
import type { MapFeature } from "../entities/mapSchema";

const river: MapFeature = {
  id: "river-1",
  kind: "route",
  name: "澜江",
  entityRef: null,
  layerId: "layer-main",
  points: [
    { x: 100, y: 120 },
    { x: 260, y: 210 },
    { x: 420, y: 140 },
    { x: 620, y: 320 },
  ],
  timeFrom: null,
  timeTo: null,
  props: {
    terrain: "river",
    color: "#3b83a5",
    lineWidth: "4",
    sourceWidth: "2",
    mouthWidth: "12",
  },
  description: "",
};

describe("地图水系几何", () => {
  it("保留首尾控制点并生成受上限约束的平滑曲线", () => {
    const smoothed = smoothMapPath(river.points, 80);

    expect(smoothed.length).toBeGreaterThan(river.points.length);
    expect(smoothed.length).toBeLessThanOrEqual(80);
    expect(smoothed[0]).toEqual(river.points[0]);
    expect(smoothed.at(-1)).toEqual(river.points.at(-1));
    expect(smoothed.some((point) => point.x > 260 && point.x < 420)).toBe(true);
  });

  it("超长手绘路径只降采样渲染输入，不突破样本上限", () => {
    const points = Array.from({ length: 2_000 }, (_, index) => ({
      x: index,
      y: 300 + Math.sin(index / 30) * 80,
    }));

    const smoothed = smoothMapPath(points, 128);

    expect(smoothed).toHaveLength(128);
    expect(smoothed[0]).toEqual(points[0]);
    expect(smoothed.at(-1)).toEqual(points.at(-1));
    expect(points).toHaveLength(2_000);
  });

  it("河流宽度从源头单调增加到河口", () => {
    const style = getMapRiverStyle(river);
    const widths = [0, 0.25, 0.5, 0.75, 1].map((progress) =>
      mapRiverWidthAt(style, progress),
    );

    expect(widths[0]).toBe(2);
    expect(widths.at(-1)).toBe(12);
    expect(widths).toEqual([...widths].sort((left, right) => left - right));
  });

  it("反转流向只反转控制点，不破坏河流属性", () => {
    const reversed = reverseMapRiverFeature(river);

    expect(isMapRiverFeature(reversed)).toBe(true);
    expect(reversed.points[0]).toEqual(river.points.at(-1));
    expect(reversed.points.at(-1)).toEqual(river.points[0]);
    expect(reversed.props).toEqual(river.props);
  });

  it("急流复用河流的渐宽、岸线和高光渲染契约", () => {
    const rapids: MapFeature = {
      ...river,
      id: "rapids-1",
      props: {
        terrain: "rapids",
        color: "#76c3d2",
        bankColor: "#3f8290",
        highlightColor: "#edffff",
        lineWidth: "5",
        sourceWidth: "3",
        mouthWidth: "7",
        bankWidth: "1.8",
      },
    };

    expect(isMapRiverFeature(rapids)).toBe(true);
    expect(getMapRiverStyle(rapids)).toMatchObject({
      sourceWidth: 3,
      mouthWidth: 7,
      bankWidth: 1.8,
      highlightColor: "#edffff",
    });
  });

  it("路线外观选择河流后才复用水文渲染，闭合自由画笔保持区域语义", () => {
    const freehandRoute = {
      ...river,
      id: "freehand-route",
      props: {
        freehand: "true",
        closed: "false",
        lineWidth: "4",
      },
    };
    const riverAppearanceRoute = {
      ...freehandRoute,
      id: "freehand-river-route",
      props: { ...freehandRoute.props, routeStyle: "river" },
    };
    const freehandArea = {
      ...freehandRoute,
      id: "freehand-area",
      kind: "area" as const,
      props: { freehand: "true", closed: "true" },
    };

    expect(hasMapRiverAppearance(freehandRoute)).toBe(false);
    expect(hasMapRiverAppearance(riverAppearanceRoute)).toBe(true);
    expect(getMapRiverStyle(riverAppearanceRoute)).toMatchObject({
      sourceWidth: 2.2,
      mouthWidth: 9,
    });
    expect(hasMapRiverAppearance(freehandArea)).toBe(false);
  });
});
