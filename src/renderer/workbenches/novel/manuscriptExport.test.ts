import { describe, expect, it } from "vitest";

import { buildManuscriptExportMarkdown, sanitizeExportFileName } from "./manuscriptExport";
import { createNovelRepository } from "./repository";
import { createEmptyNovelStorage } from "./testStorage";

describe("buildManuscriptExportMarkdown", () => {
  async function projectWithChapters() {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    let project = await repository.load();
    await repository.createChapter(project, { title: "第一章" });
    project = await repository.load();
    await repository.createChapter(project, { title: "第二章" });
    project = await repository.load();
    const first = project.chapters.find(
      (chapter) => chapter.number === 1,
    )!;
    const second = project.chapters.find(
      (chapter) => chapter.number === 2,
    )!;
    storage.setExternalText(first.path, "第一章正文。");
    storage.setExternalText(second.path, "第二章正文。");
    return repository.load();
  }

  it("按章节顺序拼接书名与正文", async () => {
    const project = await projectWithChapters();
    const markdown = buildManuscriptExportMarkdown(project);

    expect(markdown).toContain("# 测试小说");
    expect(markdown.indexOf("第 1 章 第一章")).toBeLessThan(
      markdown.indexOf("第 2 章 第二章"),
    );
    expect(markdown).toContain("第一章正文。");
    expect(markdown).toContain("第二章正文。");
  });

  it("包含目录标题并保持层级顺序", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const initial = await repository.load();
    const volumeId = await repository.createDirectory(
      initial,
      null,
      "volume",
      "第一卷",
    );
    const withDirectory = await repository.load();
    await repository.createChapter(withDirectory, {
      title: "开篇",
      directoryId: volumeId.id,
    });
    const loaded = await repository.load();
    const chapter = loaded.chapters[0]!;
    storage.setExternalText(chapter.path, "开篇正文。");

    const markdown = buildManuscriptExportMarkdown(await repository.load());
    expect(markdown).toContain("## 第一卷");
    expect(markdown.indexOf("## 第一卷")).toBeLessThan(
      markdown.indexOf("第 1 章 开篇"),
    );
  });

  it("空章节（planned）不产生空行噪声", async () => {
    const project = await projectWithChapters();
    const markdown = buildManuscriptExportMarkdown(project);
    expect(markdown).not.toMatch(/\n\n\n{2,}/u);
  });
});

describe("sanitizeExportFileName", () => {
  it("去掉 Windows 非法字符", () => {
    expect(sanitizeExportFileName('我:的"书"？')).toBe("我的书？");
    expect(sanitizeExportFileName("   ")).toBe("未命名");
  });
});
