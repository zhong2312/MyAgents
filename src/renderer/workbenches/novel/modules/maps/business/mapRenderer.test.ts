import { describe, expect, it } from "vitest";

import { mapRendererForProjection } from "./mapRenderer";

describe("mapRendererForProjection", () => {
  it("大陆和星球使用地理画布", () => {
    expect(mapRendererForProjection("continent")).toBe("geographic");
    expect(mapRendererForProjection("planet")).toBe("geographic");
  });

  it("多元宇宙和平行世界使用拓扑画布", () => {
    expect(mapRendererForProjection("multiverse")).toBe("topology");
    expect(mapRendererForProjection("parallel")).toBe("topology");
  });
});
