import { describe, expect, it } from "vitest";

import {
  azgaarRuntimeConfigured,
  createAzgaarRuntimeClient,
} from "./azgaar-runtime";
import { convertAzgaarExportToFeatures } from "../../shared/workbenches/novel/azgaarExportAdapter";

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
});
