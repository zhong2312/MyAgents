import { describe, expect, it } from 'vitest';

import { createNovelRepository } from './repository';
import { createEmptyNovelStorage } from './testStorage';

describe('NovelRepository', () => {
  it('loads initialized project files and derives chapter word counts', async () => {
    const storage = createEmptyNovelStorage();
    const empty = await createNovelRepository(storage).load();
    const chapter = await createNovelRepository(storage).createChapter(empty);
    storage.setExternalText(chapter.path, '雾 起 了。');

    const loaded = await createNovelRepository(storage).load();

    expect(loaded.metadata.title).toBe('测试小说');
    expect(loaded.chapters).toHaveLength(1);
    expect(loaded.chapters[0]).toMatchObject({
      id: 'chapter-000001',
      number: 1,
      path: 'manuscript/chapters/000001.md',
      words: 4,
    });
  });

  it('rolls back a new chapter file when the index commit fails', async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    storage.failNextIndexWrite = true;

    await expect(repository.createChapter(project)).rejects.toThrow('Index write failed');
    expect(storage.getText('manuscript/chapters/000001.md')).toBeUndefined();
  });

  it('rejects saving over an externally modified chapter', async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty);
    const project = await repository.load();
    const chapter = project.chapters.find((item) => item.id === record.id)!;
    storage.setExternalText(chapter.path, '外部版本');

    await expect(repository.saveChapter(chapter, '本地草稿', chapter.content))
      .rejects.toThrow('File changed externally');
    expect(storage.getText(chapter.path)).toBe('外部版本');
  });

  it('renames a chapter in the JSON index without moving its stable Markdown path', async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty);
    const project = await repository.load();

    await repository.renameChapter(project, record.id, '雨夜来客');
    const reloaded = await repository.load();

    expect(reloaded.chapters[0]).toMatchObject({
      title: '雨夜来客',
      path: 'manuscript/chapters/000001.md',
    });
  });
});
