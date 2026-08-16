import { describe, expect, it } from "vitest";

import { createMapView } from "./MapCanvas";
import type { MapDocument } from "../entities/mapSchema";

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
