import { describe, expect, it } from "vitest";

import { DEFAULT_MAP_CANVAS_SETTINGS } from "./mapCanvasSession";
import { createMapAreaShapePoints } from "./mapFeatureShapes";

describe("地图画布会话默认值", () => {
  it("以有机笔锋开始新的地形、材质与橡皮操作", () => {
    expect(DEFAULT_MAP_CANVAS_SETTINGS.terrainBrushShape).toBe("organic");
  });

  it("画笔默认进入自由画笔，规则形状由工具栏主动切换", () => {
    expect(DEFAULT_MAP_CANVAS_SETTINGS.areaShape).toBe("freehand");
  });

  it("画笔可以生成稳定的圆形和椭圆区域", () => {
    const circle = createMapAreaShapePoints(
      "circle",
      { x: 100, y: 100 },
      { x: 300, y: 200 },
    );
    const ellipse = createMapAreaShapePoints(
      "ellipse",
      { x: 100, y: 100 },
      { x: 300, y: 200 },
    );
    expect(circle).toHaveLength(32);
    expect(ellipse).toHaveLength(32);
    expect(circle).toEqual(
      createMapAreaShapePoints(
        "circle",
        { x: 100, y: 100 },
        { x: 300, y: 200 },
      ),
    );
    expect(Math.max(...ellipse.map((point) => point.x))).toBeGreaterThan(
      Math.max(...ellipse.map((point) => point.y)),
    );
  });
});
