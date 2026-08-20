import { describe, expect, it } from "vitest";

import {
  MANUSCRIPT_TRACKING_INDEX_PATH,
  MANUSCRIPT_TRACKING_LEGACY_PATH,
  manuscriptTrackingBatchPath,
} from "../../../shared/workbenches/novel/manuscriptTrackingStorage";
import {
  createEmptyNovelStorage,
  NovelMemoryStorage,
} from "./shared/infrastructure/testStorage";
import type { ManuscriptTrackingBatch } from "./manuscriptTrackingSchema";
import {
  createManuscriptTrackingRepository,
  hashManuscriptContent,
} from "./manuscriptTrackingRepository";
import { createNovelRepository } from "./repository";

const NOW = "2026-08-09T00:00:00.000Z";

function batch(id: string): ManuscriptTrackingBatch {
  return {
    id,
    chapterId: "chapter-000001",
    chapterContentHash: "fnv1a-12345678",
    summary: "第一章连续性",
    status: "proposed",
    createdAt: NOW,
    appliedAt: null,
    revertedAt: null,
    changes: [],
    mutations: [],
  };
}

describe("ManuscriptTrackingRepository 目录存储", () => {
  it("初始化根索引和全局基线文件", async () => {
    const storage = new NovelMemoryStorage({});
    const loaded = await createManuscriptTrackingRepository(storage).load();
    expect(
      JSON.parse(storage.getText(MANUSCRIPT_TRACKING_INDEX_PATH) ?? "{}"),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        storageVersion: 1,
        batches: [],
      }),
    );
    expect(loaded.ledger.batches).toEqual([]);
  });

  it("修改批次时差量写对应记录并最后提交根索引", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [batch("tracking-batch-one")],
    });
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.save(loaded, {
      ...loaded.ledger,
      batches: loaded.ledger.batches.map((value) => ({
        ...value,
        summary: "更新后的摘要",
      })),
    });

    expect(writes).toEqual([
      manuscriptTrackingBatchPath("tracking-batch-one"),
      MANUSCRIPT_TRACKING_INDEX_PATH,
    ]);
    expect(saved.ledger.batches[0]?.summary).toBe("更新后的摘要");
  });

  it("批次被外部修改后拒绝覆盖", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [batch("tracking-batch-one")],
    });
    const path = manuscriptTrackingBatchPath("tracking-batch-one");
    storage.setExternalText(
      path,
      `${JSON.stringify({ ...loaded.ledger.batches[0], summary: "外部修改" }, null, 2)}\n`,
    );
    await expect(repository.save(loaded, loaded.ledger)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("删除批次后清理孤立记录", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [batch("tracking-batch-one")],
    });
    loaded = await repository.save(loaded, { ...loaded.ledger, batches: [] });
    expect(
      storage.getText(manuscriptTrackingBatchPath("tracking-batch-one")),
    ).toBeUndefined();
    expect(loaded.ledger.batches).toEqual([]);
  });

  it("拒绝静默接管旧单文件账本", async () => {
    const storage = new NovelMemoryStorage({
      [MANUSCRIPT_TRACKING_LEGACY_PATH]: JSON.stringify({
        schemaVersion: 3,
        updatedAt: NOW,
        baselines: {},
        batches: [],
      }),
    });
    await expect(
      createManuscriptTrackingRepository(storage).load(),
    ).rejects.toThrow("不兼容且不迁移");
  });

  it("确认批次时以索引指向的磁盘正文校验事实源", async () => {
    const storage = new NovelMemoryStorage({
      "manuscript/index.json": `${JSON.stringify(
        {
          schemaVersion: 1,
          nextChapterNumber: 2,
          chapters: [
            {
              id: "chapter-000001",
              number: 1,
              title: "第一章",
              path: "manuscript/chapters/000001.md",
              status: "draft",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "manuscript/chapters/000001.md": "磁盘事实源已经被外部编辑。",
    });
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    const proposed = {
      ...batch("tracking-batch-disk-source"),
      chapterContentHash: hashManuscriptContent("分析时的旧正文。"),
      changes: [
        {
          id: "tracking-change-disk-source",
          domain: "continuity" as const,
          entityId: null,
          title: "主角抵达",
          before: null,
          after: "主角已抵达城门",
          evidence: "抵达城门",
          operation: { kind: "continuity-fact" as const, key: "hero-arrival" },
        },
      ],
    };
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [proposed],
    });

    await expect(
      repository.applyBatchSelection(loaded, proposed.id, [
        proposed.changes[0]!.id,
      ]),
    ).rejects.toThrow("章节正文已经变化，请重新执行连续性分析");
  });

  it("确认批次时拒绝缺少人物引用的状态变化", async () => {
    const storage = createEmptyNovelStorage();
    const novelRepository = createNovelRepository(storage);
    const project = await novelRepository.load();
    const chapter = await novelRepository.createChapter(project);
    const content = "他终于踏入筑基期。";
    storage.setExternalText(chapter.path, content);
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    const proposed: ManuscriptTrackingBatch = {
      ...batch("tracking-batch-missing-character"),
      chapterId: chapter.id,
      chapterContentHash: hashManuscriptContent(content),
      changes: [
        {
          id: "tracking-change-missing-character",
          domain: "character-state",
          entityId: null,
          title: "缺少人物引用",
          before: null,
          after: "进入筑基期",
          evidence: "踏入筑基期",
          operation: { kind: "character-field", field: "currentRealm" },
        },
      ],
    };
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [proposed],
    });

    await expect(
      repository.applyBatchSelection(loaded, proposed.id, [
        proposed.changes[0]!.id,
      ]),
    ).rejects.toThrow("缺少关联人物");
  });

  it("部分采纳时保留未选变化为新的待审阅批次", async () => {
    const storage = createEmptyNovelStorage();
    const novelRepository = createNovelRepository(storage);
    const project = await novelRepository.load();
    const chapter = await novelRepository.createChapter(project);
    const content = "雨夜里，主角抵达旧港。";
    storage.setExternalText(chapter.path, content);
    const repository = createManuscriptTrackingRepository(storage);
    let loaded = await repository.load();
    const proposed: ManuscriptTrackingBatch = {
      ...batch("tracking-batch-partial"),
      chapterContentHash: hashManuscriptContent(content),
      changes: [
        {
          id: "tracking-change-first",
          domain: "continuity",
          entityId: null,
          title: "主角抵达旧港",
          before: null,
          after: "主角已抵达旧港",
          evidence: "主角抵达旧港",
          operation: { kind: "continuity-fact", key: "arrival" },
        },
        {
          id: "tracking-change-second",
          domain: "continuity",
          entityId: null,
          title: "旧港下雨",
          before: null,
          after: "旧港正在下雨",
          evidence: "雨夜",
          operation: { kind: "continuity-fact", key: "rain" },
        },
      ],
    };
    loaded = await repository.save(loaded, {
      ...loaded.ledger,
      batches: [proposed],
    });

    const next = await repository.applyBatchSelection(loaded, proposed.id, [
      "tracking-change-first",
    ]);
    const applied = next.ledger.batches.find(
      (item) => item.status === "applied",
    );
    const remaining = next.ledger.batches.find(
      (item) => item.status === "proposed",
    );
    expect(applied?.changes.map((change) => change.id)).toEqual([
      "tracking-change-first",
    ]);
    expect(remaining?.changes.map((change) => change.id)).toEqual([
      "tracking-change-second",
    ]);
    expect(remaining?.chapterId).toBe(chapter.id);
  });
});
