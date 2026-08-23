import { describe, expect, it } from "vitest";

import { NovelMemoryStorage } from "./shared/infrastructure/testStorage";
import {
  createManuscriptCommentRepository,
  MANUSCRIPT_COMMENT_INDEX_PATH,
} from "./manuscriptCommentRepository";

describe("manuscript comment repository", () => {
  it("initializes, persists quote and comment, and reloads it", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createManuscriptCommentRepository(storage);
    const initial = await repository.load();
    expect(initial.comments).toHaveLength(0);

    const saved = await repository.create(initial, {
      chapterId: "chapter-1",
      quote: "她推开门。",
      content: "这里需要补充环境压迫感。",
      start: 10,
      end: 16,
    });
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0]).toMatchObject({
      chapterId: "chapter-1",
      quote: "她推开门。",
      content: "这里需要补充环境压迫感。",
      start: 10,
      end: 16,
    });

    const reloaded = await repository.load();
    expect(reloaded.comments).toEqual(saved.comments);
    expect(
      (await storage.stat([MANUSCRIPT_COMMENT_INDEX_PATH]))[0]?.exists,
    ).toBe(true);

    const second = await repository.create(saved, {
      chapterId: "chapter-1",
      quote: "他回头。",
      content: "这里需要强化人物的犹豫。",
      start: 20,
      end: 24,
    });
    const removed = await repository.removeMany(second, [
      saved.comments[0].id,
      second.comments[1].id,
    ]);
    expect(removed.comments).toHaveLength(0);
    expect(
      (
        await storage.stat([
          `manuscript/comments/records/${saved.comments[0].id}.json`,
          `manuscript/comments/records/${second.comments[1].id}.json`,
        ])
      )[0]?.exists,
    ).toBe(false);
    await expect(
      repository.removeMany(removed, [saved.comments[0].id]),
    ).rejects.toThrow("评论不存在");
  });
});
