import { describe, expect, it } from "vitest";

import {
  createMapComponentPrefabFeature,
  createMapComponentPrefabRegions,
  MAP_COMPONENT_PRESETS,
  mapComponentPlacement,
  mapComponentsInCategory,
} from "./mapComponents";
import {
  getMapBackgroundPreset,
  mapCanvasBackgroundStyle,
} from "./mapBackgrounds";
import { createEmptyMapDocument } from "../entities/mapSchema";

describe("地图设计器构件库", () => {
  it("提供宇宙、地貌、生态、水系、文明和地标构件", () => {
    expect(MAP_COMPONENT_PRESETS.length).toBeGreaterThanOrEqual(30);
    expect(mapComponentsInCategory("celestial")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "planet" })]),
    );
    expect(mapComponentsInCategory("landmark")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "secret-realm" }),
        expect.objectContaining({ id: "cave" }),
        expect.objectContaining({ id: "obelisk" }),
      ]),
    );
    expect(mapComponentsInCategory("mountain")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "snow-peak" }),
        expect.objectContaining({ id: "foothills" }),
      ]),
    );
    expect(mapComponentsInCategory("civilization")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "village" }),
        expect.objectContaining({ id: "port" }),
        expect.objectContaining({ id: "bridge" }),
        expect.objectContaining({ id: "road" }),
        expect.objectContaining({ id: "wall" }),
      ]),
    );
  });

  it("将构件转换为保留现有地图要素契约的可保存要素", () => {
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const feature = createMapComponentPrefabFeature({
      component: river,
      id: "feature-river",
      layerId: "layer-main",
      anchor: { x: 800, y: 500 },
      canvas: { width: 1600, height: 1000 },
    });

    expect(feature).toMatchObject({
      id: "feature-river",
      kind: "route",
      layerId: "layer-main",
      props: {
        component: "river",
        terrain: "river",
        lineWidth: "4",
        sourceWidth: "2",
        mouthWidth: "10",
      },
    });
    expect(feature.points.length).toBeGreaterThan(2);
    expect(
      new Set(feature.points.map((point) => `${point.x},${point.y}`)).size,
    ).toBeGreaterThan(2);
  });

  it("默认羊皮纸背景可切换为宇宙星空预设", () => {
    const document = createEmptyMapDocument({
      id: "map-background",
      name: "星海",
      projectionType: "planet",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    expect(document.canvas.backgroundPreset).toBe("parchment");

    const starfield = getMapBackgroundPreset("starfield");
    expect(starfield.name).toBe("宇宙星空");
    expect(
      mapCanvasBackgroundStyle({
        ...document.canvas,
        backgroundPreset: "starfield",
        backgroundColor: starfield.color,
      }).backgroundImage,
    ).toContain("radial-gradient");
  });

  it("拖拽路径预制件会按起终点缩放并旋转，而不是固定尺寸落点", () => {
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const feature = createMapComponentPrefabFeature({
      component: river,
      id: "feature-drag-river",
      layerId: "layer-main",
      anchor: { x: 600, y: 400 },
      canvas: { width: 1600, height: 1000 },
      gesture: {
        start: { x: 200, y: 400 },
        end: { x: 1000, y: 400 },
      },
    });

    const xs = feature.points.map((point) => point.x);
    expect(Math.min(...xs)).toBe(200);
    expect(Math.max(...xs)).toBe(1000);
    expect(
      new Set(feature.points.map((point) => point.y)).size,
    ).toBeGreaterThan(1);
  });

  it("道路和城墙预制件保留路线样式事实", () => {
    const wall = MAP_COMPONENT_PRESETS.find((item) => item.id === "wall")!;
    const feature = createMapComponentPrefabFeature({
      component: wall,
      id: "feature-wall",
      layerId: "layer-main",
      anchor: { x: 800, y: 500 },
      canvas: { width: 1600, height: 1000 },
    });

    expect(feature).toMatchObject({
      kind: "route",
      props: {
        terrain: "wall",
        routeStyle: "wall",
        routeWidth: "10",
        routeColor: "#a59780",
      },
    });
  });

  it("按构件职责将海陆、路线和成品素材落为各自唯一的可编辑事实", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const river = MAP_COMPONENT_PRESETS.find((item) => item.id === "river")!;
    const mountains = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "mountain-range",
    )!;

    expect(mapComponentPlacement(continent)).toBe("terrain-prefab");
    expect(mapComponentPlacement(river)).toBe("path");
    expect(mapComponentPlacement(mountains)).toBe("stamp");
  });

  it("大陆和群岛预制件直接落为可编辑的海陆区域", () => {
    const canvas = { width: 1600, height: 1000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const archipelago = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "archipelago",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-continent",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });
    const islands = createMapComponentPrefabRegions({
      component: archipelago,
      id: "region-archipelago",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      kind: "land",
      texture: "paper-land",
      edgeWidth: 3,
    });
    expect(regions[0]?.points.length).toBeGreaterThan(8);
    expect(islands).toHaveLength(7);
    expect(islands.every((region) => region.points.length >= 3)).toBe(true);
  });

  it("大陆和群岛使用稳定但不规则的海岸线，而不是重复的规则多边形", () => {
    const canvas = { width: 1_600, height: 1_000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const archipelago = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "archipelago",
    )!;
    const input = {
      component: continent,
      id: "region-organic-coast",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    } as const;
    const first = createMapComponentPrefabRegions(input);
    const repeated = createMapComponentPrefabRegions(input);
    const alternate = createMapComponentPrefabRegions({
      ...input,
      id: "region-organic-coast-alternate",
    });
    const islands = createMapComponentPrefabRegions({
      component: archipelago,
      id: "region-organic-archipelago",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
    });

    expect(first[0]?.points).toHaveLength(64);
    expect(repeated[0]?.points).toEqual(first[0]?.points);
    expect(alternate[0]?.points).not.toEqual(first[0]?.points);
    expect(islands.every((region) => region.points.length === 40)).toBe(true);
    expect(
      new Set(islands.map((region) => JSON.stringify(region.points))).size,
    ).toBeGreaterThan(1);
  });

  it("拖拽大陆预制件会沿手势方向生成更大的可编辑区域", () => {
    const canvas = { width: 1600, height: 1000 };
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-drag-continent",
      layerId: "scene-terrain",
      anchor: { x: 800, y: 500 },
      canvas,
      gesture: {
        start: { x: 260, y: 480 },
        end: { x: 1340, y: 480 },
      },
    });
    const points = regions[0]?.points ?? [];
    expect(Math.min(...points.map((point) => point.x))).toBe(260);
    expect(Math.max(...points.map((point) => point.x))).toBe(1340);
  });

  it("靠近右下边缘放置大陆时保留完整轮廓，交由画布边界扩展", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-edge-continent",
      layerId: "scene-terrain",
      anchor: { x: 1_570, y: 970 },
      canvas: { width: 1_600, height: 1_000 },
    });

    const points = regions.flatMap((region) => region.points);
    expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(1_600);
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(1_000);
  });

  it("靠近左上边缘放置大陆时保留负向轮廓，交由画布统一重定位", () => {
    const continent = MAP_COMPONENT_PRESETS.find(
      (item) => item.id === "continent",
    )!;
    const regions = createMapComponentPrefabRegions({
      component: continent,
      id: "region-northwest-continent",
      layerId: "scene-terrain",
      anchor: { x: 40, y: 30 },
      canvas: { width: 1_600, height: 1_000 },
    });

    const points = regions.flatMap((region) => region.points);
    expect(Math.min(...points.map((point) => point.x))).toBeLessThan(0);
    expect(Math.min(...points.map((point) => point.y))).toBeLessThan(0);
  });
});
