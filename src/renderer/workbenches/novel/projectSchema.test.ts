import { describe, expect, it } from "vitest";

import {
  NovelProjectFormatError,
  parseNovelChapterIndex,
  parseNovelMetadata,
} from "./projectSchema";

describe("novel project schema", () => {
  it("accepts the initialized metadata and empty chapter index", () => {
    expect(
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "novel-1",
          workbenchId: "io.myagents.novel",
          title: "长夜行",
          genres: ["玄幻", "东方玄幻"],
          targetWordCount: 800_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toMatchObject({
      title: "长夜行",
      schemaVersion: 1,
      genres: ["玄幻", "东方玄幻"],
      targetWordCount: 800_000,
    });
    expect(
      parseNovelChapterIndex(
        JSON.stringify({
          schemaVersion: 1,
          nextChapterNumber: 1,
          chapters: [],
        }),
      ).chapters,
    ).toEqual([]);
  });

  it("normalizes legacy single-genre metadata without rewriting the file", () => {
    expect(
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "legacy-1",
          workbenchId: "io.myagents.novel",
          title: "旧项目",
          genre: "悬疑",
          form: "long",
          status: "writing",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toMatchObject({
      genres: ["悬疑"],
      targetWordCount: null,
    });
  });

  it("rejects duplicate genres", () => {
    expect(() =>
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "novel-duplicate",
          workbenchId: "io.myagents.novel",
          title: "重复题材",
          genres: ["玄幻", "玄幻"],
          targetWordCount: 100_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toThrow(/不得重复/);
  });

  it("accepts more than 20 selected genres", () => {
    const genres = Array.from(
      { length: 21 },
      (_, index) => `题材-${index + 1}`,
    );

    expect(
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "novel-many-genres",
          workbenchId: "io.myagents.novel",
          title: "多题材小说",
          genres,
          targetWordCount: 1_000_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ).genres,
    ).toEqual(genres);
  });

  it("rejects unsupported versions, traversal paths and duplicate chapter identities", () => {
    expect(() =>
      parseNovelMetadata(JSON.stringify({ schemaVersion: 2 })),
    ).toThrow(NovelProjectFormatError);
    expect(() =>
      parseNovelChapterIndex(
        JSON.stringify({
          schemaVersion: 1,
          nextChapterNumber: 2,
          chapters: [
            {
              id: "chapter-000001",
              number: 1,
              title: "一",
              path: "../escape.md",
              status: "draft",
            },
            {
              id: "chapter-000001",
              number: 1,
              title: "二",
              path: "manuscript/chapters/000001.md",
              status: "draft",
            },
          ],
        }),
      ),
    ).toThrow(NovelProjectFormatError);
  });

  it("rejects chapter ids and file paths that do not match the chapter number", () => {
    expect(() =>
      parseNovelChapterIndex(
        JSON.stringify({
          schemaVersion: 1,
          nextChapterNumber: 2,
          chapters: [
            {
              id: "chapter-000002",
              number: 1,
              title: "错配章节",
              path: "manuscript/chapters/000003.md",
              status: "draft",
            },
          ],
        }),
      ),
    ).toThrow(/必须与 number 使用同一六位编号/);
  });
});
