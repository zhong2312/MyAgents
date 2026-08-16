import { describe, expect, it } from "vitest";

import { mapFeaturesInRenderOrder } from "./mapLayerOrder";

describe("mapLayerOrder", () => {
  it("按图层面板的前景到背景语义组织 Canvas 绘制顺序", () => {
    const document = {
      layers: [
        { id: "layer-foreground" },
        { id: "layer-middle" },
        { id: "layer-background" },
      ],
      features: [
        { id: "middle-first", layerId: "layer-middle" },
        { id: "foreground", layerId: "layer-foreground" },
        { id: "background", layerId: "layer-background" },
        { id: "middle-later", layerId: "layer-middle" },
      ],
    };

    expect(mapFeaturesInRenderOrder(document).map((item) => item.id)).toEqual([
      "background",
      "middle-first",
      "middle-later",
      "foreground",
    ]);
  });

  it("遇到旧数据中的未知图层时将要素放到最底层，避免遮挡有效内容", () => {
    const document = {
      layers: [{ id: "layer-main" }],
      features: [
        { id: "known", layerId: "layer-main" },
        { id: "unknown", layerId: "missing" },
      ],
    };

    expect(mapFeaturesInRenderOrder(document).map((item) => item.id)).toEqual([
      "unknown",
      "known",
    ]);
  });
});
