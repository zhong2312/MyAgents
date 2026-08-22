import { describe, expect, it } from "vitest";

import type { MapGenerationPlan } from "../../../../../../shared/workbenches/novel/mapGenerationPlan";
import {
  createEmptyMapDocument,
  type MapDocument,
} from "../entities/mapSchema";
import { validateMapGenerationProjection } from "./mapGenerationProjectionValidation";

const relationId = "originates-at:river-main:territory-sun:0";

const plan: MapGenerationPlan = {
  schemaVersion: 1,
  styleId: "xuanhuan-zh",
  worldSourceHash: "a".repeat(64),
  scope: {
    worldNodeId: "world",
    nodeIds: ["world"],
    nodePath: "九州",
    generationLevelTypeId: "continent",
    generationLevelName: "大陆",
  },
  azgaar: {
    heightmapTemplate: "east-asia",
    landmassCount: 1,
    regionCount: 3,
    riverCount: 2,
    states: 2,
    cultures: 1,
    religions: 0,
    precipitation: 180,
  },
  spatialLayers: [
    {
      id: "layer-world",
      name: "九州",
      worldNodeId: "world",
      parentId: null,
      levelTypeId: "continent",
      role: "realm",
      zone: "center",
      climate: [],
      terrain: ["平原"],
      anchor: null,
      notes: "世界核心区域。",
    },
  ],
  entities: [
    {
      id: "river-main",
      entityRef: null,
      name: "天河",
      role: "waterway",
      spatialLayerId: "layer-world",
      anchor: null,
      preferredTerrain: ["河网"],
      importance: 4,
      description: "贯穿九州的主河流。",
    },
  ],
  territories: [
    {
      id: "territory-sun",
      factionRef: { kind: "faction", id: "faction-sun" },
      name: "朝阳领",
      spatialLayerId: "layer-world",
      anchor: null,
      extent: 0.2,
      boundaryStyle: "ink",
      importance: 3,
      description: "朝阳宗的领地。",
    },
  ],
  relations: [
    {
      fromId: "river-main",
      toId: "territory-sun",
      type: "originates-at",
      description: "天河发源于朝阳领",
    },
  ],
  visual: {
    paperPreset: "parchment",
    labelHierarchy: "balanced",
    borderStyle: "ink",
    reliefStyle: "ink-peaks",
    waterStyle: "indigo-ripple",
    terrainMaterials: ["grassland"],
    ornaments: [],
    notes: "玄幻舆图。",
  },
  rationale: "测试规划。",
};

function generatedMap(): MapDocument {
  const map = createEmptyMapDocument({
    id: "map-generated",
    name: "九州",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const relationProps = { planRelations: JSON.stringify([relationId]) };
  return {
    ...map,
    generation: {
      plan,
      runtime: "compatibility-adapter",
      generatorAdapter: "fantasy-map-tool",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    features: [
      {
        id: "layer-world-feature",
        kind: "area",
        name: "九州",
        entityRef: null,
        layerId: "layer-main",
        points: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 300 },
          { x: 100, y: 300 },
        ],
        timeFrom: null,
        timeTo: null,
        props: {
          spatialLayerId: "layer-world",
          spatialRole: "realm",
          showLabel: "true",
        },
        description: "九州空间层。",
      },
      {
        id: "river-main-feature",
        kind: "route",
        name: "天河",
        entityRef: null,
        layerId: "layer-main",
        points: [
          { x: 200, y: 200 },
          { x: 420, y: 420 },
        ],
        timeFrom: null,
        timeTo: null,
        props: {
          planEntityId: "river-main",
          entityRole: "waterway",
          spatialLayerId: "layer-world",
          showLabel: "true",
          ...relationProps,
        },
        description: "天河主河道。",
      },
      {
        id: "territory-sun-feature",
        kind: "area",
        name: "朝阳领",
        entityRef: { kind: "faction", id: "faction-sun" },
        layerId: "layer-main",
        points: [
          { x: 150, y: 150 },
          { x: 250, y: 150 },
          { x: 250, y: 250 },
          { x: 150, y: 250 },
        ],
        timeFrom: null,
        timeTo: null,
        props: {
          planTerritoryId: "territory-sun",
          spatialLayerId: "layer-world",
          entityRefKind: "faction",
          entityRefId: "faction-sun",
          boundaryStyle: "ink",
          showLabel: "true",
          ...relationProps,
        },
        description: "朝阳领。",
      },
    ],
  };
}

describe("validateMapGenerationProjection", () => {
  it("不限制没有设定驱动元数据的普通地图", () => {
    const map = createEmptyMapDocument({
      id: "map-manual",
      name: "手工地图",
      projectionType: "continent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(validateMapGenerationProjection(map)).toEqual([]);
  });

  it("接受完整的空间层、实体、领地和河流关系投影", () => {
    expect(validateMapGenerationProjection(generatedMap())).toEqual([]);
  });

  it("阻止编辑破坏规划实体、势力引用和河流端点", () => {
    const map = generatedMap();
    const broken: MapDocument = {
      ...map,
      features: map.features.map((feature) =>
        feature.id === "river-main-feature"
          ? {
              ...feature,
              name: "改名河流",
              points: [
                { x: 420, y: 420 },
                { x: 520, y: 520 },
              ],
            }
          : feature.id === "territory-sun-feature"
            ? {
                ...feature,
                entityRef: { kind: "faction", id: "faction-other" },
                props: { ...feature.props, entityRefId: "faction-other" },
              }
            : feature,
      ),
    };

    const errors = validateMapGenerationProjection(broken);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("重要实体“天河”"),
        expect.stringContaining("势力 faction:faction-sun 的实体引用"),
        expect.stringContaining("未从“朝阳领”的规划锚点发源"),
      ]),
    );
  });

  it("要求规划地标拥有可回溯印章，并拒绝结构区域伪装成地标", () => {
    const base = generatedMap();
    const landmarkPlan: MapGenerationPlan = {
      ...plan,
      entities: [
        ...plan.entities,
        {
          id: "cloud-city",
          entityRef: { kind: "location", id: "cloud-city" },
          name: "云中城",
          role: "capital",
          spatialLayerId: "layer-world",
          anchor: null,
          preferredTerrain: ["高地"],
          importance: 5,
          description: "世界都城。",
        },
      ],
    };
    const landmarkFeature: MapDocument["features"][number] = {
      id: "cloud-city-feature",
      kind: "marker",
      name: "云中城",
      entityRef: { kind: "location", id: "cloud-city" },
      layerId: "layer-main",
      points: [{ x: 230, y: 210 }],
      timeFrom: null,
      timeTo: null,
      props: {
        planEntityId: "cloud-city",
        entityRole: "capital",
        spatialLayerId: "layer-world",
        component: "capital",
        showLabel: "true",
      },
      description: "云中城。",
    };
    const landmarkStamp = {
      id: "cloud-city-stamp",
      layerId: base.artwork.layers[0]!.id,
      assetId: "capital",
      sourceFeatureId: landmarkFeature.id,
      x: 230,
      y: 210,
      variant: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      flipX: false,
      flipY: false,
    };
    const valid: MapDocument = {
      ...base,
      generation: { ...base.generation!, plan: landmarkPlan },
      features: [...base.features, landmarkFeature],
      artwork: {
        ...base.artwork,
        layers: base.artwork.layers.map((layer, index) =>
          index === 0 ? { ...layer, stamps: [landmarkStamp] } : layer,
        ),
      },
    };
    expect(validateMapGenerationProjection(valid)).toEqual([]);

    const broken: MapDocument = {
      ...valid,
      features: valid.features.map((feature) =>
        feature.props.spatialRole === "realm"
          ? { ...feature, props: { ...feature.props, component: "city" } }
          : feature,
      ),
      artwork: {
        ...valid.artwork,
        layers: valid.artwork.layers.map((layer, index) =>
          index === 0
            ? {
                ...layer,
                stamps: [{ ...landmarkStamp, sourceFeatureId: undefined }],
              }
            : layer,
        ),
      },
    };
    const errors = validateMapGenerationProjection(broken);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("结构空间层“九州”"),
        expect.stringContaining("云中城”缺少可回溯到来源要素"),
      ]),
    );
  });
});
