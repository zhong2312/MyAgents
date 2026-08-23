import { describe, expect, it } from "vitest";

import type { MapFeature } from "../entities/mapSchema";
import {
  getMapLabelLayout,
  getMapLabelStyle,
  getMapLabelTextDimensions,
  mapLabelViewportCandidates,
  mapLabelLines,
  mapFeatureHasLabel,
  mapLabelCanvasFont,
  resolveMapLabelPlacements,
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

  it("将竖排题签和印章样式解析为稳定的共享版式", () => {
    const style = getMapLabelStyle(
      feature({
        name: "北荒",
        props: { labelWritingMode: "vertical", labelFrame: "seal" },
      }),
    );

    expect(style.writingMode).toBe("vertical");
    expect(style.frame).toBe("seal");
    expect(mapLabelLines("北荒", style)).toEqual(["北", "荒"]);
    expect(getMapLabelTextDimensions("北荒", style).width).toBe(
      getMapLabelTextDimensions("北荒", style).height,
    );
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

  it("按重要度为重叠标签选择不同的稳定偏移", () => {
    const primary = feature({
      id: "primary",
      name: "中州神朝",
      kind: "label",
      points: [{ x: 100, y: 100 }],
      props: { labelPriority: "8" },
    });
    const secondary = feature({
      id: "secondary",
      name: "中州神朝",
      kind: "marker",
      points: [{ x: 100, y: 100 }],
      props: { showLabel: "true", labelPriority: "1" },
    });
    const placements = resolveMapLabelPlacements([primary, secondary]);
    expect(placements.get("primary")?.visible).toBe(true);
    expect(placements.get("secondary")?.visible).toBe(true);
    expect(placements.get("secondary")?.layout.anchor).not.toEqual(
      placements.get("primary")?.layout.anchor,
    );
  });

  it("低缩放时隐藏低优先级标签但保留重要区域标题", () => {
    const region = feature({
      id: "region",
      kind: "area",
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
      ],
      props: { showLabel: "true", labelPriority: "5" },
    });
    const village = feature({
      id: "village",
      kind: "marker",
      points: [{ x: 40, y: 40 }],
      props: { showLabel: "true", labelPriority: "1" },
    });
    const placements = resolveMapLabelPlacements([region, village], {
      zoom: 0.5,
    });
    expect(placements.get("region")?.visible).toBe(true);
    expect(placements.get("village")?.visible).toBe(false);
  });

  it("只让当前视口附近的标签参与避让", () => {
    const nearby = feature({
      id: "nearby",
      kind: "marker",
      props: { showLabel: "true" },
      points: [{ x: 120, y: 80 }],
    });
    const approaching = feature({
      id: "approaching",
      kind: "marker",
      props: { showLabel: "true" },
      points: [{ x: 740, y: 80 }],
    });
    const distant = feature({
      id: "distant",
      kind: "marker",
      props: { showLabel: "true" },
      points: [{ x: 1_200, y: 80 }],
    });

    const candidates = mapLabelViewportCandidates(
      [nearby, approaching, distant],
      new Map([
        [nearby.id, { left: 120, right: 120, top: 80, bottom: 80 }],
        [approaching.id, { left: 740, right: 740, top: 80, bottom: 80 }],
        [distant.id, { left: 1_200, right: 1_200, top: 80, bottom: 80 }],
      ]),
      { left: 0, right: 240, top: 0, bottom: 200 },
      512,
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "nearby",
      "approaching",
    ]);
  });

  it("数百个中文标签在高密度地图中保持确定性避让", () => {
    const labels = Array.from({ length: 420 }, (_, index) =>
      feature({
        id: `label-${index}`,
        name: `第${index + 1}座仙城`,
        kind: "marker",
        points: [
          {
            x: 40 + (index % 30) * 52,
            y: 40 + Math.floor(index / 30) * 44,
          },
        ],
        props: {
          showLabel: "true",
          labelPriority: String(index % 6),
        },
      }),
    );

    const first = resolveMapLabelPlacements(labels);
    const second = resolveMapLabelPlacements(labels);

    expect(first.size).toBe(420);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(
      [...first.values()].filter((placement) => placement.visible).length,
    ).toBeGreaterThan(100);
  });
});
