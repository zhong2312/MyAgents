import { describe, expect, it } from "vitest";

import {
  LOCATION_INDEX_PATH,
  locationRecordPath,
} from "../../../../../../shared/workbenches/novel/locationStorage";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import type { NovelLocation } from "../entities/locationLibrarySchema";
import { createNovelLocationLibraryRepository } from "./locationLibraryRepository";

function location(id: string, name: string): NovelLocation {
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

describe("NovelLocationLibraryRepository 目录存储", () => {
  it("初始化轻量根索引", async () => {
    const storage = new NovelMemoryStorage({});
    const loaded = await createNovelLocationLibraryRepository(storage).load();
    const index = JSON.parse(storage.getText(LOCATION_INDEX_PATH) ?? "{}") as {
      storageVersion?: number;
      locations?: unknown[];
    };

    expect(index.storageVersion).toBe(1);
    expect(index.locations).toEqual([]);
    expect(loaded.index.locations).toEqual([]);
  });

  it("只修改一个地点时仅改写对应记录", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelLocationLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.index,
      locations: [location("cloud-city", "云城")],
    });
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.save(loaded, {
      ...loaded.index,
      locations: loaded.index.locations.map((entry) => ({
        ...entry,
        summary: "更新后的概要",
      })),
    });

    expect(writes).toEqual([locationRecordPath("cloud-city")]);
    expect(saved.index.locations[0]?.summary).toBe("更新后的概要");
  });

  it("任一记录被外部修改后拒绝覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelLocationLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.index,
      locations: [location("cloud-city", "云城")],
    });
    const path = locationRecordPath("cloud-city");
    const external = JSON.parse(storage.getText(path) ?? "{}") as Record<
      string,
      unknown
    >;
    external.summary = "外部修改";
    storage.setExternalText(path, `${JSON.stringify(external, null, 2)}\n`);

    await expect(repository.save(loaded, loaded.index)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("删除地点后清理孤立记录", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelLocationLibraryRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.index,
      locations: [location("cloud-city", "云城")],
    });

    loaded = await repository.save(loaded, { ...loaded.index, locations: [] });

    expect(storage.getText(locationRecordPath("cloud-city"))).toBeUndefined();
    expect(loaded.index.locations).toEqual([]);
  });

  it("不迁移旧 index.json 内嵌数组结构", async () => {
    const storage = new NovelMemoryStorage({});
    await storage.createText(
      LOCATION_INDEX_PATH,
      `${JSON.stringify({ schemaVersion: 1, locations: [] }, null, 2)}\n`,
      { createParents: true },
    );

    await expect(
      createNovelLocationLibraryRepository(storage).load(),
    ).rejects.toThrow("旧单文件地点库不兼容且不迁移");
  });
});
