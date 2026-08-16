import { describe, expect, it } from "vitest";

import { mapGenerationLevelIds } from "./mapGenerationScope";

const library = {
  meta: {
    levelTypes: [
      {
        id: "world",
        name: "世界",
        description: "",
        icon: "globe",
        mapKind: "cosmic-region" as const,
        source: "builtin" as const,
        suggestedParentTypeIds: [],
        suggestedChildTypeIds: ["continent"],
      },
      {
        id: "continent",
        name: "大陆",
        description: "",
        icon: "land",
        mapKind: "geographic-area" as const,
        source: "builtin" as const,
        suggestedParentTypeIds: ["world"],
        suggestedChildTypeIds: ["city"],
      },
      {
        id: "city",
        name: "城市",
        description: "",
        icon: "city",
        mapKind: "settlement-point" as const,
        source: "builtin" as const,
        suggestedParentTypeIds: ["continent"],
        suggestedChildTypeIds: [],
      },
    ],
  },
  spatialTree: {
    nodes: [
      {
        id: "world-root",
        parentId: null,
        name: "九州界",
        typeId: "world",
        order: 0,
      },
      {
        id: "northern-continent",
        parentId: "world-root",
        name: "北陆",
        typeId: "continent",
        order: 0,
      },
      {
        id: "snow-city",
        parentId: "northern-continent",
        name: "雪原城",
        typeId: "city",
        order: 0,
      },
    ],
  },
};

describe("mapGenerationLevelIds", () => {
  it("世界范围可生成其后代的大陆和城市层级", () => {
    expect(mapGenerationLevelIds(library, "world-root")).toEqual([
      "continent",
      "city",
    ]);
  });

  it("叶子大陆自身也是可生成层级，并保留其下级选择", () => {
    expect(mapGenerationLevelIds(library, "northern-continent")).toEqual([
      "continent",
      "city",
    ]);
  });

  it("叶子城市可直接作为定居点地图生成目标", () => {
    expect(mapGenerationLevelIds(library, "snow-city")).toEqual(["city"]);
  });

  it("只有世界根时可初始化第一张地图", () => {
    expect(
      mapGenerationLevelIds(
        {
          ...library,
          spatialTree: {
            nodes: [library.spatialTree.nodes[0]!],
          },
        },
        "world-root",
      ),
    ).toEqual(["continent", "city"]);
  });
});
