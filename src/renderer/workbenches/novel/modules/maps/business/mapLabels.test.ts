import { describe, expect, it } from "vitest";

import type { MapFeature } from "../entities/mapSchema";
import {
  getMapLabelLayout,
  getMapLabelStyle,
  mapFeatureHasLabel,
  mapLabelCanvasFont,
} from "./mapLabels";

function feature(patch: Partial<MapFeature> = {}): MapFeature {
  return {
    id: "feature-label-test",
    kind: "label",
    name: "北境",
    entityRef: null,
    layerId: "layer-main",
    points: [{ x: 20, y: 30 }],
    timeFrom: null,
    timeTo: null,
    props: {},
    description: "",
    ...patch,
  };
}

describe("mapLabels", () => {
  it("旧标签获得可导出的专业默认样式", () => {
    const source = feature();
    const style = getMapLabelStyle(source);

    expect(mapFeatureHasLabel(source)).toBe(true);
    expect(style.fontId).toBe("cartographer");
    expect(style.fontSize).toBe(20);
    expect(style.haloWidth).toBe(3);
    expect(mapLabelCanvasFont(style)).toContain("KaiTi");
  });

  it("显式样式会校验字体、数值范围和颜色", () => {
    const style = getMapLabelStyle(
      feature({
        props: {
          labelFont: "humanist",
          labelSize: "500",
          labelWeight: "650",
          labelColor: "invalid",
          labelHaloColor: "#112233",
          labelHaloWidth: "-4",
          labelOffsetX: "9999",
          labelRotation: "-240",
          labelItalic: "true",
        },
      }),
    );

    expect(style.fontId).toBe("humanist");
    expect(style.fontSize).toBe(96);
    expect(style.fontWeight).toBe(600);
    expect(style.color).toBe("#4b4034");
    expect(style.haloColor).toBe("#112233");
    expect(style.haloWidth).toBe(0);
    expect(style.offsetX).toBe(800);
    expect(style.rotation).toBe(-180);
    expect(style.italic).toBe(true);
  });

  it("区域名称使用多边形质心而不是第一个顶点", () => {
    const layout = getMapLabelLayout(
      feature({
        kind: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      }),
    );

    expect(layout.anchor).toEqual({ x: 50, y: 50 });
  });

  it("河流名称沿中段方向排列并保持正向可读", () => {
    const layout = getMapLabelLayout(
      feature({
        kind: "route",
        points: [
          { x: 100, y: 100 },
          { x: 0, y: 0 },
        ],
        props: { terrain: "river", showLabel: "true" },
      }),
    );

    expect(layout.anchor.x).toBeGreaterThan(35);
    expect(layout.anchor.x).toBeLessThan(55);
    expect(layout.pathRotation).toBeCloseTo(45);
  });

  it("普通要素只有显式开启后才渲染名称", () => {
    const marker = feature({ kind: "marker", props: {} });
    expect(mapFeatureHasLabel(marker)).toBe(false);
    expect(
      mapFeatureHasLabel({ ...marker, props: { showLabel: "true" } }),
    ).toBe(true);
  });
});
