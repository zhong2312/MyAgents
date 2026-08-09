import { describe, expect, it } from "vitest";

import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { inspirationRecordPath } from "../../../../../../shared/workbenches/novel/inspirationStorage";
import type { InspirationItem } from "../entities/inspirationSchema";
import { createNovelInspirationRepository } from "./inspirationRepository";

const NOW = "2026-08-09T00:00:00.000Z";

function item(id: string, title: string): InspirationItem {
  return {
    id,
    title,
    body: `${title}正文`,
    state: "inbox",
    source: { kind: "manual", label: "随手记录", uri: "" },
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("NovelInspirationRepository 目录存储", () => {
  it("初始化轻量根索引和 records 目录", async () => {
    const storage = new NovelMemoryStorage({});
    const loaded = await createNovelInspirationRepository(storage).load();
    expect(
      JSON.parse(storage.getText("inspiration/index.json") ?? "{}"),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        storageVersion: 1,
        items: [],
      }),
    );
    expect(loaded.library.items).toEqual([]);
  });

  it("只修改一条灵感时仅改写对应 record", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelInspirationRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      items: [item("idea-rain", "雨夜相逢")],
    });
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.save(loaded, {
      ...loaded.library,
      items: loaded.library.items.map((value) => ({
        ...value,
        body: "新正文",
      })),
    });

    expect(writes).toEqual([
      inspirationRecordPath("idea-rain"),
      "inspiration/index.json",
    ]);
    expect(saved.library.items[0]?.body).toBe("新正文");
  });

  it("记录被外部修改后拒绝覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelInspirationRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      items: [item("idea-rain", "雨夜相逢")],
    });
    const path = inspirationRecordPath("idea-rain");
    storage.setExternalText(
      path,
      `${JSON.stringify({ ...loaded.library.items[0], body: "外部修改" }, null, 2)}\n`,
    );
    await expect(repository.save(loaded, loaded.library)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("删除灵感后清理孤立 record", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createNovelInspirationRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.library,
      items: [item("idea-rain", "雨夜相逢")],
    });
    loaded = await repository.save(loaded, { ...loaded.library, items: [] });
    expect(storage.getText(inspirationRecordPath("idea-rain"))).toBeUndefined();
    expect(loaded.library.items).toEqual([]);
  });
});
