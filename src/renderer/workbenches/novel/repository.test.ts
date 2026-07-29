import { describe, expect, it } from "vitest";

import { createNovelRepository } from "./repository";
import { createEmptyNovelStorage } from "./testStorage";

describe("NovelRepository", () => {
  it("loads initialized project files and derives chapter word counts", async () => {
    const storage = createEmptyNovelStorage();
    const empty = await createNovelRepository(storage).load();
    const chapter = await createNovelRepository(storage).createChapter(empty);
    storage.setExternalText(chapter.path, "雾 起 了。");

    const loaded = await createNovelRepository(storage).load();

    expect(loaded.metadata.title).toBe("测试小说");
    expect(loaded.chapters).toHaveLength(1);
    expect(loaded.chapters[0]).toMatchObject({
      id: "chapter-000001",
      number: 1,
      path: "manuscript/chapters/000001.md",
      words: 4,
    });
  });

  it("updates editable project settings without changing the fixed project name", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();

    await repository.saveProjectSettings(project, {
      title: "新的书名",
      genres: ["科幻", "悬疑"],
      targetWordCountMin: 400_000,
      targetWordCountMax: 600_000,
      chapterWordCount: 2_000,
    });

    const metadata = JSON.parse(storage.getText("novel.json") ?? "{}");
    expect(metadata).toMatchObject({
      projectName: "test-novel-01",
      title: "新的书名",
      genres: ["科幻", "悬疑"],
      targetWordCountMin: 400_000,
      targetWordCountMax: 600_000,
      chapterWordCount: 2_000,
    });
    expect(metadata).not.toHaveProperty("targetWordCount");
  });

  it("rolls back a new chapter file when the index commit fails", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    storage.failNextIndexWrite = true;

    await expect(repository.createChapter(project)).rejects.toThrow(
      "Index write failed",
    );
    expect(storage.getText("manuscript/chapters/000001.md")).toBeUndefined();
  });

  it("rejects saving over an externally modified chapter", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty);
    const project = await repository.load();
    const chapter = project.chapters.find((item) => item.id === record.id)!;
    storage.setExternalText(chapter.path, "外部版本");

    await expect(
      repository.saveChapter(chapter, "本地草稿", chapter.content),
    ).rejects.toThrow("File changed externally");
    expect(storage.getText(chapter.path)).toBe("外部版本");
  });

  it("renames a chapter in the JSON index without moving its stable Markdown path", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty);
    const project = await repository.load();

    await repository.renameChapter(project, record.id, "雨夜来客");
    const reloaded = await repository.load();

    expect(reloaded.chapters[0]).toMatchObject({
      title: "雨夜来客",
      path: "manuscript/chapters/000001.md",
    });
  });

  it("uses editable display numbers without changing the stable Markdown serial", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const first = await repository.createChapter(empty);
    const afterFirst = await repository.load();
    const second = await repository.createChapter(afterFirst);

    expect([first.displayNumber, second.displayNumber]).toEqual([1, 2]);

    await repository.updateChapter(await repository.load(), second.id, {
      displayNumber: 8,
    });
    const reloaded = await repository.load();
    const changed = reloaded.chapters.find(
      (chapter) => chapter.id === second.id,
    )!;

    expect(changed).toMatchObject({
      number: 2,
      displayNumber: 8,
      path: "manuscript/chapters/000002.md",
    });
    await expect(
      repository.updateChapter(reloaded, first.id, { displayNumber: 8 }),
    ).rejects.toThrow("自由正文序列已使用编号 8");
  });
});
