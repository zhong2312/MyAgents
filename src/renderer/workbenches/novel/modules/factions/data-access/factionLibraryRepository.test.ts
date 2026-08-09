import { describe, expect, it } from "vitest";

import {
  FACTION_INDEX_PATH,
  factionRecordPath,
} from "../../../../../../shared/workbenches/novel/factionStorage";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { type FactionRecord } from "../entities/factionLibrarySchema";
import { createNovelFactionLibraryRepository } from "./factionLibraryRepository";

const NOW = "2026-08-09T00:00:00.000Z";

function faction(id: string, name: string): FactionRecord {
  return {
    id,
    name,
    type: "宗门",
    status: "active",
    summary: `${name}概要`,
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("NovelFactionLibraryRepository 目录存储", () => {
  it("初始化轻量根索引和 records 目录", async () => {
    const storage = new NovelMemoryStorage({});
    const loaded = await createNovelFactionLibraryRepository(storage).load();
    const index = JSON.parse(storage.getText(FACTION_INDEX_PATH) ?? "{}") as {
      storageVersion?: number;
      factions?: unknown[];
    };

    expect(index.storageVersion).toBe(1);
    expect(index.factions).toEqual([]);
    expect(loaded.library.factions).toEqual([]);
  });

  it("只修改势力正文时仅改写对应 record", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelFactionLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      factions: [faction("faction-a", "天门")],
    });
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.save(loaded, {
      ...loaded.library,
      factions: loaded.library.factions.map((entry) => ({
        ...entry,
        summary: "更新后的概要",
      })),
    });

    expect(writes).toEqual([factionRecordPath("faction-a")]);
    expect(saved.library.factions[0]?.summary).toBe("更新后的概要");
  });

  it("任一记录被外部修改后拒绝覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelFactionLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      factions: [faction("faction-a", "天门")],
    });
    const path = factionRecordPath("faction-a");
    const external = JSON.parse(storage.getText(path) ?? "{}") as Record<
      string,
      unknown
    >;
    external.summary = "外部修改";
    storage.setExternalText(path, `${JSON.stringify(external, null, 2)}\n`);

    await expect(repository.save(loaded, loaded.library)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("删除势力后先提交根索引再清理孤立 record", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelFactionLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      factions: [faction("faction-a", "天门")],
    });

    loaded = await repository.save(loaded, { ...loaded.library, factions: [] });

    expect(storage.getText(factionRecordPath("faction-a"))).toBeUndefined();
    expect(loaded.library.factions).toEqual([]);
  });

  it("不迁移旧 index.json 内嵌数组结构", async () => {
    const storage = new NovelMemoryStorage({});
    await storage.createText(
      FACTION_INDEX_PATH,
      `${JSON.stringify({ schemaVersion: 2, factions: [] }, null, 2)}\n`,
      { createParents: true },
    );

    await expect(
      createNovelFactionLibraryRepository(storage).load(),
    ).rejects.toThrow("旧单文件势力库不兼容且不迁移");
  });
});
