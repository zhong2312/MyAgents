import { describe, expect, it } from "vitest";

import { createDefaultItemLibraryMeta } from "../business/itemLibraryDefaults";
import {
  createNovelItemLibraryRepository,
  type LoadedItemLibrary,
} from "./itemLibraryRepository";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

function storageWithItem(id: string, name: string): NovelMemoryStorage {
  const storage = new NovelMemoryStorage({
    "world/items/meta.json": JSON.stringify(createDefaultItemLibraryMeta()),
    "world/items/index.json": JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id,
          name,
          categoryId: "uncategorized",
          status: "active",
          tags: [],
          summary: "",
          recordPath: `world/items/records/${id}.json`,
          pagePath: `world/items/pages/${id}.md`,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    [`world/items/records/${id}.json`]: JSON.stringify({
      schemaVersion: 1,
      id,
      name,
      aliases: [],
      categoryId: "uncategorized",
      status: "active",
      tags: [],
      summary: "",
      coverPath: null,
      values: {},
      itemFields: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    [`world/items/pages/${id}.md`]: `# ${name}\n\n描述内容`,
  });
  return storage;
}

describe("createNovelItemLibraryRepository.deleteItem", () => {
  it("从索引移除物品并删除 record/page 文件", async () => {
    const storage = storageWithItem("sword-1", "玄铁剑");
    const repository = createNovelItemLibraryRepository(storage);
    const loaded: LoadedItemLibrary = await repository.load();

    const next = await repository.deleteItem(loaded, "sword-1");

    expect(next.index.items).toHaveLength(0);
    expect(storage.getText("world/items/records/sword-1.json")).toBeUndefined();
    expect(storage.getText("world/items/pages/sword-1.md")).toBeUndefined();
  });

  it("删除不存在的物品时抛错且不写盘", async () => {
    const storage = storageWithItem("sword-1", "玄铁剑");
    const repository = createNovelItemLibraryRepository(storage);
    const loaded: LoadedItemLibrary = await repository.load();
    const before = storage.getText("world/items/index.json");

    await expect(repository.deleteItem(loaded, "missing-1")).rejects.toThrow(
      "物品不存在",
    );
    expect(storage.getText("world/items/index.json")).toBe(before);
  });
});
