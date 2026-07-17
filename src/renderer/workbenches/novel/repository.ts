import type { WorkbenchStorage } from '@/workbench-sdk';

import {
  parseNovelChapterIndex,
  parseNovelMetadata,
  serializeNovelChapterIndex,
  type NovelChapterIndex,
  type NovelChapterRecord,
  type NovelMetadata,
} from './projectSchema';

const NOVEL_METADATA_PATH = 'novel.json';
const CHAPTER_INDEX_PATH = 'manuscript/index.json';
const OUTLINE_PATH = 'outline/outline.md';

export interface LoadedNovelChapter extends NovelChapterRecord {
  readonly content: string;
  readonly words: number;
}

export interface LoadedNovelProject {
  readonly metadata: NovelMetadata;
  readonly metadataContent: string;
  readonly chapterIndex: NovelChapterIndex;
  readonly chapterIndexContent: string;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly outlineContent: string;
}

export interface NovelRepository {
  load(): Promise<LoadedNovelProject>;
  createChapter(project: LoadedNovelProject): Promise<NovelChapterRecord>;
  renameChapter(
    project: LoadedNovelProject,
    chapterId: string,
    title: string,
  ): Promise<{ chapterIndex: NovelChapterIndex; chapterIndexContent: string }>;
  saveChapter(
    chapter: LoadedNovelChapter,
    content: string,
    expectedContent: string,
  ): Promise<LoadedNovelChapter>;
  saveOutline(content: string, expectedContent: string): Promise<string>;
}

export function countNovelWords(content: string): number {
  return Array.from(content).filter((character) => !/\s/u.test(character)).length;
}

function chapterFileName(number: number): string {
  return `${String(number).padStart(6, '0')}.md`;
}

export function createNovelRepository(storage: WorkbenchStorage): NovelRepository {
  const repository: NovelRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error('小说项目存储仅在 MyAgents 桌面端可用');
      }
      const [metadataFile, chapterIndexFile, outlineFile] = await Promise.all([
        storage.readText(NOVEL_METADATA_PATH),
        storage.readText(CHAPTER_INDEX_PATH),
        storage.readText(OUTLINE_PATH),
      ]);
      const metadata = parseNovelMetadata(metadataFile.content);
      const chapterIndex = parseNovelChapterIndex(chapterIndexFile.content);
      const chapters = await Promise.all(
        chapterIndex.chapters.map(async (record): Promise<LoadedNovelChapter> => {
          const file = await storage.readText(record.path);
          return Object.freeze({
            ...record,
            content: file.content,
            words: countNovelWords(file.content),
          });
        }),
      );
      chapters.sort((left, right) => left.number - right.number);
      return Object.freeze({
        metadata,
        metadataContent: metadataFile.content,
        chapterIndex,
        chapterIndexContent: chapterIndexFile.content,
        chapters: Object.freeze(chapters),
        outlineContent: outlineFile.content,
      });
    },

    async createChapter(project) {
      const number = project.chapterIndex.nextChapterNumber;
      const serial = String(number).padStart(6, '0');
      const record: NovelChapterRecord = {
        id: `chapter-${serial}`,
        number,
        title: `第 ${number} 章`,
        path: `manuscript/chapters/${chapterFileName(number)}`,
        status: 'draft',
      };
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        nextChapterNumber: number + 1,
        chapters: [...project.chapterIndex.chapters, record],
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      await storage.createText(record.path, '', { createParents: true });
      try {
        await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
          expectedContent: project.chapterIndexContent,
        });
      } catch (error) {
        await storage.remove(record.path, { permanent: true }).catch(() => false);
        throw error;
      }
      return Object.freeze(record);
    },

    async renameChapter(project, chapterId, title) {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) throw new Error('章节标题不能为空');
      const position = project.chapterIndex.chapters.findIndex(
        (chapter) => chapter.id === chapterId,
      );
      if (position < 0) throw new Error(`章节不存在：${chapterId}`);
      const chapters = [...project.chapterIndex.chapters];
      chapters[position] = { ...chapters[position], title: normalizedTitle };
      const chapterIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        chapters,
      };
      const chapterIndexContent = serializeNovelChapterIndex(chapterIndex);
      await storage.writeText(CHAPTER_INDEX_PATH, chapterIndexContent, {
        expectedContent: project.chapterIndexContent,
      });
      return Object.freeze({ chapterIndex, chapterIndexContent });
    },

    async saveChapter(chapter, content, expectedContent) {
      await storage.writeText(chapter.path, content, { expectedContent });
      return Object.freeze({
        ...chapter,
        content,
        words: countNovelWords(content),
      });
    },

    async saveOutline(content, expectedContent) {
      await storage.writeText(OUTLINE_PATH, content, { expectedContent });
      return content;
    },
  };
  return Object.freeze(repository);
}
