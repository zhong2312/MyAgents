import { describe, expect, it } from "vitest";

import { createMapView, geometryFromFeature } from "./MapCanvas";
import type { MapDocument } from "../entities/mapSchema";
import LineString from "ol/geom/LineString";
import Polygon from "ol/geom/Polygon";
import CircleGeometry from "ol/geom/Circle";

describe("地理地图视图", () => {
  it("按本地像素坐标适配画布，而不是按 Web Mercator 缩成中心小点", () => {
    const canvas: MapDocument["canvas"] = {
      width: 1_600,
      height: 1_000,
      backgroundColor: "#9bb9c4",
      showGrid: true,
    };
    const view = createMapView(canvas);

    view.fit([0, 0, canvas.width, canvas.height], {
      size: [1_560, 900],
      padding: [28, 28, 28, 28],
    });

    expect(view.getProjection().getUnits()).toBe("pixels");
    expect(view.getResolution()).toBeLessThan(2);
    expect(view.getZoom()).toBeGreaterThan(0);
  });
});

describe("map canvas freehand compatibility", () => {
  it("keeps a closed freehand area as a polygon instead of a circle", () => {
    const feature = {
      id: "freehand-area",
      kind: "area" as const,
      name: "freehand area",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 100, y: 100 },
        { x: 260, y: 110 },
        { x: 220, y: 250 },
        { x: 90, y: 210 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { freehand: "true", closed: "true", curve: "arc" },
      description: "",
    };

    const geometry = geometryFromFeature(feature, 800, 600);
    expect(geometry).toBeInstanceOf(Polygon);
    expect(geometry).not.toBeInstanceOf(CircleGeometry);
    expect((geometry as Polygon).getCoordinates()[0]?.length).toBeGreaterThan(
      feature.points.length,
    );
  });

  it("renders an open arc route with derived curve samples", () => {
    const feature = {
      id: "freehand-route",
      kind: "route" as const,
      name: "freehand route",
      entityRef: null,
      layerId: "layer-main",
      points: [
        { x: 80, y: 120 },
        { x: 300, y: 120 },
      ],
      timeFrom: null,
      timeTo: null,
      props: { freehand: "true", closed: "false", curve: "arc" },
      description: "",
    };

    const geometry = geometryFromFeature(feature, 800, 600);
    expect(geometry).toBeInstanceOf(LineString);
    const points = (geometry as LineString).getCoordinates();
    expect(points.length).toBeGreaterThan(feature.points.length);
    expect(points.some(([, y]) => y !== 480)).toBe(true);
  });

  it("preserves legacy circle features that explicitly contain radius", () => {
    const feature = {
      id: "legacy-circle",
      kind: "area" as const,
      name: "legacy circle",
      entityRef: null,
      layerId: "layer-main",
      points: [{ x: 240, y: 180 }],
      timeFrom: null,
      timeTo: null,
      props: { radius: "64" },
      description: "",
    };

    expect(geometryFromFeature(feature, 800, 600)).toBeInstanceOf(
      CircleGeometry,
    );
  });
});
