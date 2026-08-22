import { describe, expect, it } from "vitest";

import {
  azgaarRuntimeConfigured,
  createAzgaarRuntimeClient,
} from "./azgaar-runtime";
import { convertAzgaarExportToFeatures } from "../../shared/workbenches/novel/azgaarExportAdapter";
import {
  bindFantasyPlanToFeatures,
  type FantasyFeature,
} from "../../shared/workbenches/novel/fantasyMapGenerator";
import { localizeFantasyMapFeatures } from "../../shared/workbenches/novel/fantasyMapStyle";
import type { MapGenerationPlan } from "../../shared/workbenches/novel/mapGenerationPlan";

function integrationPlan(): MapGenerationPlan {
  return {
    schemaVersion: 1,
    styleId: "xuanhuan-zh",
    worldSourceHash: "a".repeat(64),
    scope: {
      worldNodeId: "world",
      nodeIds: ["world", "north"],
      nodePath: "九州",
      generationLevelTypeId: "continent",
      generationLevelName: "大陆",
    },
    azgaar: {
      heightmapTemplate: "continents",
      landmassCount: 1,
      regionCount: 4,
      riverCount: 3,
      states: 4,
      cultures: 4,
      religions: 2,
      precipitation: 100,
    },
    spatialLayers: [
      {
        id: "north",
        name: "北荒",
        worldNodeId: "north",
        parentId: null,
        levelTypeId: "region",
        role: "region",
        zone: "north",
        climate: ["寒冷"],
        terrain: ["雪岭"],
        anchor: { x: 0.25, y: 0.22 },
        notes: "北境雪岭。",
      },
    ],
    entities: [
      {
        id: "north-city",
        entityRef: null,
        name: "北荒城",
        role: "city",
        spatialLayerId: "north",
        anchor: { x: 0.28, y: 0.3 },
        preferredTerrain: ["河网"],
        importance: 4,
        description: "北荒交通中心。",
      },
    ],
    territories: [
      {
        id: "frost-domain",
        factionRef: { kind: "faction", id: "frost-sect" },
        name: "霜原宗疆域",
        spatialLayerId: "north",
        anchor: { x: 0.22, y: 0.2 },
        extent: 0.2,
        boundaryStyle: "dashed",
        importance: 4,
        description: "霜原宗镇守北荒。",
      },
    ],
    relations: [
      {
        fromId: "north-city",
        toId: "north",
        type: "contains",
        description: "北荒城位于北荒。",
      },
      {
        fromId: "frost-domain",
        toId: "north",
        type: "controls",
        description: "霜原宗疆域位于北荒。",
      },
    ],
    visual: {
      paperPreset: "parchment",
      labelHierarchy: "balanced",
      borderStyle: "ink",
      reliefStyle: "ink-peaks",
      waterStyle: "indigo-ripple",
      terrainMaterials: ["snow"],
      ornaments: ["compass"],
      notes: "北荒玄幻舆图。",
    },
    rationale: "用北荒空间层承载真实 Runtime 的可编辑对象。",
  };
}

const runtimeIt = azgaarRuntimeConfigured() ? it : it.skip;

describe("Azgaar Runtime 官方 Full JSON 集成", () => {
  runtimeIt(
    "导出可重建编辑边界的 pack cells 与 vertices",
    async () => {
      const runtime = createAzgaarRuntimeClient({ timeoutMs: 120_000 });
      try {
        const exported = await runtime.generate({
          seed: "azgaar-runtime-full-json-integration",
          width: 960,
          height: 640,
          world: {
            sourceHash: "a".repeat(64),
            files: { "world/setting-library/settings.json": "{}" },
            summary: "Azgaar Full JSON 集成测试",
            constraints: {
              spatialNames: ["北境", "南境"],
              placeNames: ["云城", "河湾"],
              factionNames: ["霜原王国"],
              terrainKeywords: ["山脉", "河流"],
            },
          },
          options: {
            heightmapTemplate: "continents",
            states: 4,
            cultures: 4,
            religions: 2,
            precipitation: 100,
          },
        });
        const value = JSON.parse(exported.content) as {
          pack?: { cells?: unknown; vertices?: unknown };
        };
        expect(exported.format).toBe("json");
        expect(exported.previewSvg).toMatch(/<svg[\s>]/iu);
        expect(Array.isArray(value.pack?.cells)).toBe(true);
        expect(Array.isArray(value.pack?.vertices)).toBe(true);
        const features = convertAzgaarExportToFeatures({
          value,
          width: 960,
          height: 640,
          layerId: "layer-main",
        });
        expect(
          features.some((feature) => feature.props.azgaarLayer === "state"),
        ).toBe(true);
        expect(
          features.some((feature) => feature.props.azgaarLayer === "province"),
        ).toBe(true);
        expect(
          features.some((feature) => feature.props.azgaarLayer === "biome"),
        ).toBe(true);
      } finally {
        await runtime.dispose?.();
      }
    },
    120_000,
  );

  runtimeIt(
    "把真实 Full JSON 转换后继续投影为同一份中文 MapDocument 要素",
    async () => {
      const runtime = createAzgaarRuntimeClient({ timeoutMs: 120_000 });
      try {
        const plan = integrationPlan();
        const exported = await runtime.generate({
          seed: "azgaar-runtime-plan-projection-integration",
          width: 960,
          height: 640,
          world: {
            sourceHash: plan.worldSourceHash,
            files: { "world/setting-library/settings.json": "{}" },
            summary: "Azgaar 规划投影集成测试",
            generationPlan: plan,
          },
          options: plan.azgaar,
        });
        const converted = convertAzgaarExportToFeatures({
          value: JSON.parse(exported.content) as unknown,
          width: 960,
          height: 640,
          layerId: "layer-main",
        });
        const localized = localizeFantasyMapFeatures(
          converted,
          "azgaar-runtime-plan-projection-integration",
        );
        const projected = bindFantasyPlanToFeatures({
          features: localized as readonly FantasyFeature[],
          plan,
          width: 960,
          height: 640,
          layerId: "layer-main",
        });
        const territory = projected.find(
          (feature) => feature.props.planTerritoryId === "frost-domain",
        );
        const region = projected.find(
          (feature) =>
            feature.props.spatialLayerId === "north" &&
            feature.props.spatialRole === "region",
        );
        const city = projected.find(
          (feature) => feature.props.planEntityId === "north-city",
        );
        expect(exported.format).toBe("json");
        expect(region).toMatchObject({
          name: "北荒",
          kind: "area",
          entityRef: { kind: "setting", id: "north" },
        });
        expect(territory).toMatchObject({
          name: "霜原宗疆域",
          kind: "area",
          entityRef: { kind: "faction", id: "frost-sect" },
          props: {
            entityRole: "territory",
            boundaryStyle: "dashed",
          },
        });
        expect(city).toMatchObject({ name: "北荒城" });
        expect(territory?.points.length).toBeGreaterThanOrEqual(3);
        expect(city?.points.length).toBeGreaterThan(0);
        expect(
          projected.every((feature) => !/[A-Za-z]/u.test(feature.name)),
        ).toBe(true);
      } finally {
        await runtime.dispose?.();
      }
    },
    120_000,
  );
});
