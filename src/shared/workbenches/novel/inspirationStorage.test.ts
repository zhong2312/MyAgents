import { describe, expect, it } from "vitest";

import {
  INSPIRATION_INDEX_PATH,
  createInspirationFiles,
  inspirationRecordPath,
  loadInspirationFiles,
} from "./inspirationStorage";

const NOW = "2026-08-09T00:00:00.000Z";

function item(id: string, title: string) {
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

describe("inspirationStorage", () => {
  it("将完整灵感库拆成根索引和独立记录", () => {
    const files = createInspirationFiles({
      schemaVersion: 1,
      updatedAt: NOW,
      items: [item("idea-rain", "雨夜相逢")],
    });
    expect(JSON.parse(files.at(-1)?.content ?? "{}")).toEqual({
      schemaVersion: 1,
      storageVersion: 1,
      updatedAt: NOW,
      items: [
        {
          id: "idea-rain",
          path: "inspiration/records/idea-rain.json",
        },
      ],
    });
    expect(files.at(-1)?.path).toBe(INSPIRATION_INDEX_PATH);
    expect(
      files.some((file) => file.path === inspirationRecordPath("idea-rain")),
    ).toBe(true);
  });

  it("从索引读取完整记录并保留多文件快照", async () => {
    const source = new Map(
      createInspirationFiles({
        schemaVersion: 1,
        updatedAt: NOW,
        items: [item("idea-rain", "雨夜相逢")],
      }).map((file) => [file.path, file.content]),
    );
    const loaded = await loadInspirationFiles(async (path) => {
      const content = source.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });
    expect(loaded.library.items[0]?.body).toBe("雨夜相逢正文");
    expect(loaded.files.has(inspirationRecordPath("idea-rain"))).toBe(true);
  });

  it("拒绝旧内嵌数组和非法记录路径", async () => {
    await expect(
      loadInspirationFiles(async () =>
        JSON.stringify({ schemaVersion: 1, updatedAt: NOW, items: [] }),
      ),
    ).rejects.toThrow("旧单文件灵感库不兼容且不迁移");

    await expect(
      loadInspirationFiles(async (path) => {
        if (path === INSPIRATION_INDEX_PATH) {
          return JSON.stringify({
            schemaVersion: 1,
            storageVersion: 1,
            updatedAt: NOW,
            items: [
              { id: "idea-rain", path: "inspiration/records/other.json" },
            ],
          });
        }
        throw new Error(`unexpected ${path}`);
      }),
    ).rejects.toThrow("inspiration/records/idea-rain.json");
  });
});
