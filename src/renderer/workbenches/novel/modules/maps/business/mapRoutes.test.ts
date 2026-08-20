import { describe, expect, it } from "vitest";

import type { MapFeature } from "../entities/mapSchema";
import {
  getMapRouteStyle,
  isMapStyledRoute,
  mapRouteStrokeLayers,
} from "./mapRoutes";

function route(props: Record<string, string>): MapFeature {
  return {
    id: "route-test",
    kind: "route",
    name: "西境古道",
    entityRef: null,
    layerId: "layer-main",
    points: [
      { x: 10, y: 10 },
      { x: 120, y: 80 },
    ],
    timeFrom: null,
    timeTo: null,
    props,
    description: "",
  };
}

describe("mapRoutes", () => {
  it("兼容旧道路和边界要素，并提供成图层次", () => {
    const road = getMapRouteStyle(route({ terrain: "road" }));
    const border = getMapRouteStyle(route({ terrain: "border" }));

    expect(road?.id).toBe("road");
    expect(road?.width).toBe(7);
    expect(mapRouteStrokeLayers(road!)).toEqual([
      { color: "#654934", width: 11.4, dash: null },
      { color: "#c49a69", width: 7, dash: null },
    ]);
    expect(border?.id).toBe("border");
    expect(border?.dash).toEqual([12, 8]);
  });

  it("城墙支持受限的自定义宽度与双边配色", () => {
    const wall = getMapRouteStyle(
      route({
        routeStyle: "wall",
        routeWidth: "200",
        routeColor: "#778899",
        routeCasingColor: "#112233",
      }),
    );

    expect(wall).toMatchObject({
      id: "wall",
      width: 64,
      color: "#778899",
      casingColor: "#112233",
      decoration: "wall",
    });
    expect(isMapStyledRoute(route({ routeStyle: "wall" }))).toBe(true);
    expect(isMapStyledRoute(route({ routeStyle: "plain" }))).toBe(false);
  });

  it("河流始终由水文渲染器接管", () => {
    expect(
      getMapRouteStyle(route({ terrain: "river", routeStyle: "wall" })),
    ).toBeNull();
  });

  it("新增水系、道路、奇幻边界和宇宙航线均解析为专用路线样式", () => {
    const cases = [
      ["bank", "bank"],
      ["fjord", "fjord"],
      ["dirt", "dirt"],
      ["trade", "trade"],
      ["magic-rail", "magic-rail"],
      ["ley-line", "ley-line"],
      ["magic-rift", "magic-rift"],
      ["sea-route", "sea-route"],
      ["stellar-route", "stellar-route"],
      ["contour", "contour"],
      ["bathymetric", "bathymetric"],
      ["barrier", "barrier"],
    ] as const;
    for (const [routeStyle, expectedId] of cases) {
      const style = getMapRouteStyle(route({ routeStyle }));
      expect(style?.id).toBe(expectedId);
      expect(isMapStyledRoute(route({ routeStyle }))).toBe(true);
      expect(mapRouteStrokeLayers(style!)).not.toHaveLength(0);
    }
    expect(getMapRouteStyle(route({ terrain: "canyon" }))?.id).toBe("canyon");
    expect(getMapRouteStyle(route({ terrain: "current" }))?.id).toBe("current");
  });
});
