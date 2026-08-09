import { describe, expect, it } from "vitest";

import {
  FACTION_INDEX_PATH,
  createFactionFiles,
  factionFileMap,
  factionRecordPath,
  loadFactionFiles,
  serializeFactionFileSnapshot,
  type FactionStorageAggregate,
} from "./factionStorage";

function fixture(): FactionStorageAggregate {
  return {
    schemaVersion: 2,
    factions: [
      {
        id: "faction-main",
        name: "天门",
        summary: "守护北境的宗门。",
        members: [{ id: "member-a", name: "执事", count: 10 }],
      },
    ],
  };
}

describe("势力目录存储", () => {
  it("根索引只保存引用并可递归聚合记录", async () => {
    const files = factionFileMap(createFactionFiles(fixture()));
    const index = JSON.parse(files.get(FACTION_INDEX_PATH) ?? "{}") as Record<
      string,
      unknown
    >;

    expect(index).toMatchObject({
      schemaVersion: 2,
      storageVersion: 1,
      factions: [
        {
          id: "faction-main",
          path: "world/factions/records/faction-main.json",
        },
      ],
    });
    expect(JSON.stringify(index)).not.toContain("守护北境");
    expect(files.get(factionRecordPath("faction-main"))).toContain("守护北境");

    const loaded = await loadFactionFiles(async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    });
    expect(loaded.library).toEqual(fixture());
  });

  it("拒绝旧单文件格式和不规范记录路径", async () => {
    await expect(
      loadFactionFiles(async () =>
        JSON.stringify({ schemaVersion: 2, factions: fixture().factions }),
      ),
    ).rejects.toThrow("旧单文件势力库不兼容且不迁移");

    const files = factionFileMap(createFactionFiles(fixture()));
    const index = JSON.parse(files.get(FACTION_INDEX_PATH) ?? "{}") as {
      factions: Array<{ path: string }>;
    };
    index.factions[0]!.path = "world/factions/faction-main.json";
    const changed = new Map(files).set(
      FACTION_INDEX_PATH,
      `${JSON.stringify(index, null, 2)}\n`,
    );
    await expect(
      loadFactionFiles(async (path) => changed.get(path) ?? ""),
    ).rejects.toThrow("world/factions/records/faction-main.json");
  });

  it("目录快照不受 Map 插入顺序影响", () => {
    expect(
      serializeFactionFileSnapshot(
        new Map([
          ["b", "2"],
          ["a", "1"],
        ]),
      ),
    ).toBe(
      serializeFactionFileSnapshot(
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    );
  });
});
