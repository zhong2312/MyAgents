import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "./testStorage";
import { createManuscriptVersionRepository } from "./manuscriptVersionRepository";

describe("manuscript version repository", () => {
  it("uses 20 as the default retention limit", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createManuscriptVersionRepository(storage);

    await expect(repository.loadSettings()).resolves.toMatchObject({
      maxVersions: 20,
    });
    expect(storage.getText("settings/manuscript-version.json")).toContain(
      '"maxVersions": 20',
    );
  });

  it("keeps only the newest versions after applying the configured limit", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createManuscriptVersionRepository(storage);
    await repository.saveSettings(2);

    const chapter = { id: "chapter-1", title: "第一章" } as const;
    await repository.create(chapter, "正文一");
    await repository.create(chapter, "正文二");
    await repository.create(chapter, "正文三");

    const versions = await repository.list(chapter.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((item) => item.content)).toEqual(["正文三", "正文二"]);
  });

  it("creates a restore checkpoint before writing the selected version", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createManuscriptVersionRepository(storage);
    const chapter = { id: "chapter-1", title: "第一章", content: "当前正文" } as const;
    const target = await repository.create(chapter, "目标正文");
    let savedContent: string = chapter.content;

    await repository.restore(chapter, target, async (content, expected) => {
      expect(expected).toBe(chapter.content);
      savedContent = content;
    });

    expect(savedContent).toBe("目标正文");
    const versions = await repository.list(chapter.id);
    expect(versions.some((item) => item.source === "restore")).toBe(true);
  });
});
