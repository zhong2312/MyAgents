import { describe, expect, it } from "vitest";

import {
  mapGenerationPlanSchema,
  parseMapGenerationPlan,
  type MapGenerationPlan,
} from "./mapGenerationPlan";

const plan: MapGenerationPlan = {
  schemaVersion: 1,
  styleId: "xuanhuan-zh",
  worldSourceHash: "a".repeat(64),
  scope: {
    worldNodeId: "world",
    nodeIds: ["world", "north", "center"],
    nodePath: "九州",
    generationLevelTypeId: "continent",
    generationLevelName: "大陆",
  },
  azgaar: {
    heightmapTemplate: "east-asia",
    landmassCount: 2,
    regionCount: 4,
    riverCount: 5,
    states: 3,
    cultures: 2,
    religions: 1,
    precipitation: 180,
  },
  spatialLayers: [
    {
      id: "layer-north",
      name: "北荒",
      worldNodeId: "north",
      parentId: null,
      levelTypeId: "region",
      role: "region",
      zone: "north",
      climate: ["寒冷"],
      terrain: ["雪岭", "森林"],
      anchor: { x: 0.2, y: 0.18 },
      notes: "北境寒冷，雪山灵脉贯穿其间。",
    },
    {
      id: "layer-center",
      name: "中州",
      worldNodeId: "center",
      parentId: "layer-north",
      levelTypeId: "region",
      role: "region",
      zone: "center",
      climate: ["温润"],
      terrain: ["河网", "平原"],
      anchor: { x: 0.52, y: 0.5 },
      notes: "河网密集，是神朝交通中心。",
    },
  ],
  entities: [
    {
      id: "setting-ice-palace",
      entityRef: { kind: "setting", id: "xuan-bing-palace" },
      name: "玄冰宫",
      role: "sect",
      spatialLayerId: "layer-north",
      anchor: { x: 0.18, y: 0.2 },
      preferredTerrain: ["雪山灵脉"],
      importance: 5,
      description: "镇守北荒雪岭。",
    },
    {
      id: "location-cloud-city",
      entityRef: { kind: "location", id: "cloud-city" },
      name: "云中城",
      role: "capital",
      spatialLayerId: "layer-center",
      anchor: { x: 0.5, y: 0.48 },
      preferredTerrain: ["河网", "平原"],
      importance: 5,
      description: "中州主城。",
    },
    {
      id: "secret-ruin",
      entityRef: null,
      name: "太古遗迹",
      role: "ruin",
      spatialLayerId: "layer-north",
      anchor: { x: 0.28, y: 0.3 },
      preferredTerrain: ["雪岭"],
      importance: 3,
      description: "封存古战场的遗迹。",
    },
  ],
  relations: [
    {
      fromId: "setting-ice-palace",
      toId: "layer-north",
      type: "located-near",
      description: "玄冰宫依托北荒雪岭。",
    },
    {
      fromId: "location-cloud-city",
      toId: "layer-center",
      type: "contains",
      description: "云中城位于中州。",
    },
  ],
  visual: {
    paperPreset: "parchment",
    labelHierarchy: "balanced",
    borderStyle: "ink",
    reliefStyle: "ink-peaks",
    waterStyle: "indigo-ripple",
    terrainMaterials: ["snow", "forest", "grassland"],
    ornaments: ["compass", "title-seal"],
    notes: "古典玄幻舆图。",
  },
  rationale: "北荒以雪山为骨，中州以河网为轴。",
};

describe("mapGenerationPlan", () => {
  it("接受含正式实体引用、空间层级和关系的完整规划", () => {
    expect(parseMapGenerationPlan(plan)).toEqual(plan);
  });

  it("拒绝引用范围外空间节点的规划", () => {
    const invalid = {
      ...plan,
      spatialLayers: [
        { ...plan.spatialLayers[0]!, worldNodeId: "outside" },
        plan.spatialLayers[1]!,
      ],
    };
    expect(mapGenerationPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it("允许空间层引用数组中后置出现的父级", () => {
    const reordered = {
      ...plan,
      spatialLayers: [plan.spatialLayers[1]!, plan.spatialLayers[0]!],
    };
    expect(mapGenerationPlanSchema.safeParse(reordered).success).toBe(true);
  });

  it("拒绝成环的空间层级", () => {
    const cyclic = {
      ...plan,
      spatialLayers: [
        { ...plan.spatialLayers[0]!, parentId: "layer-center" },
        plan.spatialLayers[1]!,
      ],
    };
    expect(mapGenerationPlanSchema.safeParse(cyclic).success).toBe(false);
  });

  it("拒绝重复或越出范围的空间节点", () => {
    const duplicate = {
      ...plan,
      scope: { ...plan.scope, nodeIds: ["world", "north", "north"] },
    };
    const outsideRoot = {
      ...plan,
      scope: { ...plan.scope, worldNodeId: "outside" },
    };
    expect(mapGenerationPlanSchema.safeParse(duplicate).success).toBe(false);
    expect(mapGenerationPlanSchema.safeParse(outsideRoot).success).toBe(false);
  });

  it("拒绝悬空实体关系", () => {
    const invalid = {
      ...plan,
      relations: [
        {
          fromId: "missing",
          toId: "layer-center",
          type: "located-near",
          description: "错误关系",
        },
      ],
    };
    expect(mapGenerationPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it("接受 Agent 提供的中文命名目录并拒绝重复条目", () => {
    const named = {
      ...plan,
      naming: {
        entries: [
          {
            id: "north-state-name",
            role: "state",
            name: "北荒道",
            rationale: "对应北方寒地的正式州域名称。",
          },
        ],
      },
    };
    const duplicate = {
      ...named,
      naming: {
        entries: [...named.naming.entries, named.naming.entries[0]!],
      },
    };
    expect(mapGenerationPlanSchema.safeParse(named).success).toBe(true);
    expect(mapGenerationPlanSchema.safeParse(duplicate).success).toBe(false);
  });

  it("接受正式势力领地，并拒绝重复或悬空空间层引用", () => {
    const withTerritory = {
      ...plan,
      territories: [
        {
          id: "great-qian-territory",
          factionRef: { kind: "faction" as const, id: "great-qian" },
          name: "大乾神朝疆域",
          spatialLayerId: "layer-center",
          anchor: { x: 0.54, y: 0.5 },
          extent: 0.3,
          boundaryStyle: "wash" as const,
          importance: 5,
          description: "中州河网平原上的神朝直辖疆域。",
        },
      ],
    };
    const duplicate = {
      ...withTerritory,
      territories: [
        ...withTerritory.territories,
        { ...withTerritory.territories[0]! },
      ],
    };
    const detachedLayer = {
      ...withTerritory,
      territories: [
        {
          ...withTerritory.territories[0]!,
          spatialLayerId: "missing-layer",
        },
      ],
    };

    expect(parseMapGenerationPlan(withTerritory).territories).toEqual(
      withTerritory.territories,
    );
    expect(mapGenerationPlanSchema.safeParse(duplicate).success).toBe(false);
    expect(mapGenerationPlanSchema.safeParse(detachedLayer).success).toBe(
      false,
    );
  });
});
