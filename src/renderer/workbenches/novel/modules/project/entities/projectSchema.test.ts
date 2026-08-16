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
          projectName: "novel-longnight",
          title: "长夜行",
          genres: ["玄幻", "东方玄幻"],
          targetWordCountMin: 800_000,
          targetWordCountMax: 1_200_000,
          chapterWordCount: 3_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toMatchObject({
      title: "长夜行",
      projectName: "novel-longnight",
      schemaVersion: 1,
      genres: ["玄幻", "东方玄幻"],
      targetWordCountMin: 800_000,
      targetWordCountMax: 1_200_000,
      chapterWordCount: 3_000,
      writingPerspective: "third-person-limited",
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
      projectName: "旧项目",
      genres: ["悬疑"],
      targetWordCount: null,
      targetWordCountMin: null,
      targetWordCountMax: null,
      chapterWordCount: null,
      writingPerspective: "third-person-limited",
    });
  });

  it("normalizes the legacy single word target into an equal range", () => {
    expect(
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "legacy-target",
          workbenchId: "io.myagents.novel",
          title: "旧目标",
          genres: ["悬疑"],
          targetWordCount: 300_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toMatchObject({
      projectName: "旧目标",
      targetWordCountMin: 300_000,
      targetWordCountMax: 300_000,
    });
  });

  it("rejects a reversed target word range", () => {
    expect(() =>
      parseNovelMetadata(
        JSON.stringify({
          schemaVersion: 1,
          projectId: "invalid-range",
          workbenchId: "io.myagents.novel",
          projectName: "invalid-range",
          title: "错误区间",
          genres: ["悬疑"],
          targetWordCountMin: 500_000,
          targetWordCountMax: 300_000,
          chapterWordCount: 2_000,
          status: "planning",
          language: "zh-CN",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        }),
      ),
    ).toThrow(/下限不得大于上限/);
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

  it("migrates v2 manuscript display numbers in separate narrative and free sequences", () => {
    const index = parseNovelChapterIndex(
      JSON.stringify({
        schemaVersion: 2,
        nextChapterNumber: 5,
        structureMode: "free",
        directories: [
          {
            id: "directory-narrative",
            parentId: null,
            kind: "volume",
            title: "第一卷",
            order: 0,
            narrativeDirectoryId: "narrative-directory-1",
          },
          {
            id: "directory-free",
            parentId: null,
            kind: "folder",
            title: "自由内容",
            order: 1,
            narrativeDirectoryId: null,
          },
        ],
        chapters: [
          {
            id: "chapter-000001",
            number: 1,
            title: "关联第一章",
            path: "manuscript/chapters/000001.md",
            status: "draft",
            directoryId: "directory-narrative",
            order: 0,
            narrativeChapterId: "narrative-chapter-1",
            trackingStatus: "idle",
            lastTrackedAt: null,
          },
          {
            id: "chapter-000002",
            number: 2,
            title: "自由第一章",
            path: "manuscript/chapters/000002.md",
            status: "draft",
            directoryId: "directory-free",
            order: 0,
            narrativeChapterId: null,
            trackingStatus: "idle",
            lastTrackedAt: null,
          },
          {
            id: "chapter-000003",
            number: 3,
            title: "关联第二章",
            path: "manuscript/chapters/000003.md",
            status: "draft",
            directoryId: "directory-narrative",
            order: 1,
            narrativeChapterId: "narrative-chapter-2",
            trackingStatus: "idle",
            lastTrackedAt: null,
          },
          {
            id: "chapter-000004",
            number: 4,
            title: "自由第二章",
            path: "manuscript/chapters/000004.md",
            status: "draft",
            directoryId: "directory-free",
            order: 1,
            narrativeChapterId: null,
            trackingStatus: "idle",
            lastTrackedAt: null,
          },
        ],
        typography: {
          fontFamily: "system-serif",
          fontSize: 18,
          titleSize: 30,
          lineHeight: 1.9,
          paragraphSpacing: 12,
          firstLineIndent: 2,
          contentWidth: 760,
          textAlign: "left",
          paperTone: "warm",
        },
        trash: [],
      }),
    );

    expect(index.schemaVersion).toBe(4);
    expect(index.chapters.map((chapter) => chapter.displayNumber)).toEqual([
      1, 1, 2, 2,
    ]);
    expect(
      index.chapters.every((chapter) => chapter.planningMode === "reference"),
    ).toBe(true);
  });

  it("allows matching display numbers across scopes but not within one scope", () => {
    const shared = {
      schemaVersion: 3,
      nextChapterNumber: 3,
      structureMode: "free",
      directories: [],
      typography: {
        fontFamily: "system-serif",
        fontSize: 18,
        titleSize: 30,
        lineHeight: 1.9,
        paragraphSpacing: 12,
        firstLineIndent: 2,
        contentWidth: 760,
        textAlign: "left",
        paperTone: "warm",
      },
      trash: [],
    };
    const chapter = (number: number, narrativeChapterId: string | null) => ({
      id: `chapter-${String(number).padStart(6, "0")}`,
      number,
      displayNumber: 1,
      title: "章节",
      path: `manuscript/chapters/${String(number).padStart(6, "0")}.md`,
      status: "draft",
      directoryId: null,
      order: number - 1,
      narrativeChapterId,
      trackingStatus: "idle",
      lastTrackedAt: null,
    });

    expect(() =>
      parseNovelChapterIndex(
        JSON.stringify({
          ...shared,
          chapters: [chapter(1, "narrative-chapter-1"), chapter(2, null)],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseNovelChapterIndex(
        JSON.stringify({
          ...shared,
          chapters: [chapter(1, null), chapter(2, null)],
        }),
      ),
    ).toThrow(/显示编号不得重复/);
  });
});
