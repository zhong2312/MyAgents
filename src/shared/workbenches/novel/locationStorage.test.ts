import { describe, expect, it } from "vitest";

import {
  LOCATION_INDEX_PATH,
  createLocationFiles,
  loadLocationFiles,
  locationRecordPath,
} from "./locationStorage";

function location(id: string, name: string) {
  return {
    id,
    nodeId: "world-root",
    parentLocationId: null,
    name,
    aliases: [],
    type: "区域",
    status: "planned",
    summary: "",
    appearanceNote: "",
    description: "",
    order: 0,
  };
}

describe("locationStorage", () => {
  it("将逻辑地点库拆成根索引与独立记录", () => {
    const files = createLocationFiles({
      schemaVersion: 1,
      locations: [location("cloud-city", "云城")],
    });
    const index = JSON.parse(
      files.find((file) => file.path === LOCATION_INDEX_PATH)?.content ?? "{}",
    ) as Record<string, unknown>;

    expect(index).toEqual({
      schemaVersion: 1,
      storageVersion: 1,
      locations: [
        {
          id: "cloud-city",
          path: "world/locations/records/cloud-city.json",
        },
      ],
    });
    expect(files.at(-1)?.path).toBe(LOCATION_INDEX_PATH);
  });

  it("严格聚合根索引引用的记录", async () => {
    const source = new Map(
      createLocationFiles({
        schemaVersion: 1,
        locations: [location("cloud-city", "云城")],
      }).map((file) => [file.path, file.content]),
    );
    const loaded = await loadLocationFiles(async (path) => {
      const content = source.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });

    expect(loaded.library.locations[0]?.name).toBe("云城");
    expect(loaded.files.has(locationRecordPath("cloud-city"))).toBe(true);
  });

  it("拒绝旧内嵌地点数组", async () => {
    await expect(
      loadLocationFiles(async () =>
        JSON.stringify({ schemaVersion: 1, locations: [] }),
      ),
    ).rejects.toThrow("旧单文件地点库不兼容且不迁移");
  });

  it("拒绝索引路径与 id 不一致", async () => {
    await expect(
      loadLocationFiles(async (path) => {
        if (path === LOCATION_INDEX_PATH) {
          return JSON.stringify({
            schemaVersion: 1,
            storageVersion: 1,
            locations: [
              {
                id: "cloud-city",
                path: "world/locations/records/other.json",
              },
            ],
          });
        }
        throw new Error(`unexpected ${path}`);
      }),
    ).rejects.toThrow("world/locations/records/cloud-city.json");
  });
});
