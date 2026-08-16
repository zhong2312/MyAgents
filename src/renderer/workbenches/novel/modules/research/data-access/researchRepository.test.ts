import { describe, expect, it } from "vitest";

import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { createResearchRepository } from "./researchRepository";

function createStorage() {
  return new NovelMemoryStorage({
    "research/index.json": '{"schemaVersion":1,"sources":[]}',
    "research/trash/index.json": '{"schemaVersion":1,"items":[]}',
    "research/notes/考据.md": "# 考据\n\n正文资料",
    "research/legacy.md": "# 旧资料\n\n兼容内容",
  });
}

describe("ResearchRepository", () => {
  it("loads indexed notes and discovers legacy root markdown files", async () => {
    const storage = createStorage();
    const library = await createResearchRepository(storage).load();

    expect(library.sources.map((source) => source.path)).toEqual([
      "research/notes/考据.md",
      "research/legacy.md",
    ]);
    expect(library.sources.every((source) => source.exists)).toBe(true);
    expect(storage.getText("research/trash/index.json")).toContain('"items"');
  });

  it("uses the loaded disk content as the save CAS baseline", async () => {
    const storage = createStorage();
    const repository = createResearchRepository(storage);
    const library = await repository.load();
    const source = library.sources[0];
    if (!source) throw new Error("missing source");
    const document = await repository.loadSource(source);

    storage.setExternalText(source.path, "# 外部版本\n");
    await expect(
      repository.saveSource(library, source, "# 我的版本\n", document.content),
    ).rejects.toThrow();
    expect(storage.getText(source.path)).toBe("# 外部版本\n");
  });

  it("rejects deletion when the document changed after its disk snapshot", async () => {
    const storage = createStorage();
    const repository = createResearchRepository(storage);
    const library = await repository.load();
    const source = library.sources[0];
    if (!source) throw new Error("missing source");
    storage.setExternalText(source.path, "# 外部版本\n");

    await expect(repository.deleteSource(library, source)).rejects.toThrow(
      "资料已被外部修改",
    );
    expect(storage.getText(source.path)).toBe("# 外部版本\n");
    expect(storage.getText("research/trash/index.json")).toContain('"items"');
  });

  it("rolls back a newly created source when the index CAS cannot commit", async () => {
    const storage = createStorage();
    const repository = createResearchRepository(storage);
    const library = await repository.load();
    storage.failWritePathOnce = "research/index.json";

    await expect(
      repository.createSource(library, "未登记资料"),
    ).rejects.toThrow("Injected write failure");
    expect(storage.getText("research/notes/未登记资料.md")).toBeUndefined();
  });

  it("moves deleted sources to the app recycle bin and restores them", async () => {
    const storage = createStorage();
    const repository = createResearchRepository(storage);
    const library = await repository.load();
    const source = library.sources[0];
    if (!source) throw new Error("missing source");

    const deleted = await repository.deleteSource(library, source);
    expect(storage.getText(source.path)).toBeUndefined();
    expect(deleted.trash).toHaveLength(1);
    const trashItem = deleted.trash[0];
    if (!trashItem) throw new Error("missing trash item");
    expect(storage.getText(trashItem.trashPath)).toContain("考据");

    const restored = await repository.restoreSource(deleted, trashItem);
    expect(storage.getText(source.path)).toContain("正文资料");
    expect(restored.sources.some((item) => item.path === source.path)).toBe(
      true,
    );
    expect(restored.trash).toHaveLength(0);
  });

  it("does not lose the source when the active index changes during deletion", async () => {
    const storage = createStorage();
    const repository = createResearchRepository(storage);
    const library = await repository.load();
    const source = library.sources[0];
    if (!source) throw new Error("missing source");
    storage.setExternalText(
      "research/index.json",
      '{"schemaVersion":1,"sources":[{"id":"external","path":"research/external.md","title":"外部","createdAt":"2026-01-01T00:00:00.000Z"}]}',
    );

    await expect(repository.deleteSource(library, source)).rejects.toThrow();
    expect(storage.getText(source.path)).toContain("正文资料");
    expect(
      JSON.parse(storage.getText("research/trash/index.json") ?? "{}"),
    ).toEqual({
      schemaVersion: 1,
      items: [],
    });
  });
});
