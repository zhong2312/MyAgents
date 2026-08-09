import { describe, expect, it } from "vitest";

import {
  cultivationEcologySchema,
  type CultivationEcology,
} from "./cultivationEcologySchema";
import {
  CULTIVATION_ECOLOGY_INDEX_PATH,
  createCultivationEcologyFiles,
  loadCultivationEcologyFiles,
} from "./cultivationEcologyStorage";

function fixture(): CultivationEcology {
  return cultivationEcologySchema.parse({
    schemaVersion: 6,
    updatedAt: "2026-08-09T00:00:00.000Z",
    worldOrigins: [],
    crossSystemRelations: [],
    systems: [
      {
        id: "system-1",
        name: "玄门",
        summary: "测试体系",
        kind: "修仙",
        terminology: {
          energy: "灵气",
          stage: "境界",
          method: "功法",
          ability: "术法",
        },
        projection: {
          originIds: [],
          manifestationIds: [],
          access: "",
          translation: "",
          medium: "",
          attenuation: "",
        },
        theoryModel: {
          statement: "",
          summary: "",
          nodeTypes: [],
          invariants: [],
          validationRules: [],
          nodeCatalog: [
            {
              id: "node-1",
              name: "丹田",
              summary: "",
              kind: "",
              role: "",
              capacity: "",
              accessCondition: "",
              invariant: "",
              aliases: [],
            },
          ],
        },
        progressionTracks: [
          {
            id: "track-1",
            name: "主修",
            summary: "",
            mode: "",
            structure: "ordered",
            metrics: [],
            levels: [],
            transitions: [],
          },
        ],
        trackInteractions: [],
        resources: [],
        methods: [
          {
            id: "method-1",
            name: "吐纳法",
            summary: "",
            kind: "",
            theoryReference: "",
            script: [],
            formula: "",
            coverage: {
              startLevelId: null,
              stableLimitId: null,
              theoryLimitId: null,
              absoluteLimitId: null,
            },
            effects: {
              speed: "",
              conversion: "",
              quality: "",
              breakthrough: "",
              loss: "",
            },
            compatibility: [],
            risks: [],
            itemIds: [],
            operationTopologies: [],
            courses: [],
          },
        ],
        abilities: [],
        formations: [],
        foundations: [],
        transitions: [],
        constraints: [],
        audit: [],
      },
    ],
  });
}

describe("修炼体系目录 codec", () => {
  it("按体系模块和大型集合实体拆分，并可无损聚合", async () => {
    const ecology = fixture();
    const files = createCultivationEcologyFiles(ecology);
    const map = new Map(files.map((file) => [file.path, file.content]));

    expect(map.has(CULTIVATION_ECOLOGY_INDEX_PATH)).toBe(true);
    expect(map.has("world/cultivation/systems/system-1/system.json")).toBe(
      true,
    );
    expect(
      map.has("world/cultivation/systems/system-1/theory/nodes/node-1.json"),
    ).toBe(true);
    expect(
      map.has(
        "world/cultivation/systems/system-1/progression/records/track-1.json",
      ),
    ).toBe(true);
    expect(
      map.has(
        "world/cultivation/systems/system-1/methods/records/method-1.json",
      ),
    ).toBe(true);
    expect(
      map.get("world/cultivation/systems/system-1/system.json"),
    ).not.toContain('"methods": [');

    const loaded = await loadCultivationEcologyFiles(async (path) => {
      const content = map.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });
    expect(loaded.ecology).toEqual(ecology);
  });

  it("拒绝索引把实体路径指向修炼体系目录之外", async () => {
    const files = createCultivationEcologyFiles(fixture());
    const map = new Map(files.map((file) => [file.path, file.content]));
    const root = JSON.parse(
      map.get(CULTIVATION_ECOLOGY_INDEX_PATH) ?? "{}",
    ) as {
      systems: { path: string }[];
    };
    root.systems[0]!.path = "world/items/index.json";
    map.set(CULTIVATION_ECOLOGY_INDEX_PATH, JSON.stringify(root));

    await expect(
      loadCultivationEcologyFiles(async (path) => map.get(path) ?? ""),
    ).rejects.toThrow("world/cultivation/systems/system-1/system.json");
  });
});
