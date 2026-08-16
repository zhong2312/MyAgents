import { describe, expect, it } from "vitest";

import { createNovelRepository, type NovelRepository } from "./repository";
import { createNarrativeEngineeringRepository } from "../../../narrativeEngineeringRepository";
import { hashManuscriptContent } from "../../../manuscriptTrackingRepository";
import { createManuscriptVersionRepository } from "../../../manuscriptVersionRepository";
import {
  createEmptyNovelStorage,
  type NovelMemoryStorage,
} from "../../../shared/infrastructure/testStorage";

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
      writingPerspective: "third-person-omniscient",
    });

    const metadata = JSON.parse(storage.getText("novel.json") ?? "{}");
    expect(metadata).toMatchObject({
      projectName: "test-novel-01",
      title: "新的书名",
      genres: ["科幻", "悬疑"],
      targetWordCountMin: 400_000,
      targetWordCountMax: 600_000,
      chapterWordCount: 2_000,
      writingPerspective: "third-person-omniscient",
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

  it("拒绝正文变化后的提炼结果，且不写入任一事实源", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty, { title: "第一章" });
    const project = await repository.load();
    const chapter = project.chapters.find((item) => item.id === record.id)!;
    storage.setExternalText(chapter.path, "外部修改后的正文");

    await expect(
      repository.extractChaptersToNarrative(project, [
        {
          chapterId: chapter.id,
          sourceContentHash: hashManuscriptContent(chapter.content),
          targetNarrativeChapterId: null,
          title: "提炼后的第一章",
          description: "正文实际发生的事件。",
          sections: [],
        },
      ]),
    ).rejects.toThrow("正文在提炼结果生成后发生变化");

    const reloaded = await repository.load();
    expect(reloaded.narrative.library.chapters).toHaveLength(0);
    expect(reloaded.chapters[0]?.narrativeChapterId).toBeNull();
  });

  it("批量提炼在一次提交中闭合正文与剧情工程的关联", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    let project = await repository.load();
    await repository.createChapter(project, { title: "第一章" });
    project = await repository.load();
    await repository.createChapter(project, { title: "第二章" });
    project = await repository.load();

    await repository.extractChaptersToNarrative(
      project,
      project.chapters.map((chapter) => ({
        chapterId: chapter.id,
        sourceContentHash: hashManuscriptContent(chapter.content),
        targetNarrativeChapterId: null,
        title: `${chapter.title}提炼`,
        description: `${chapter.title}的实际剧情。`,
        sections: [{ title: "场景", description: "发生的关键行动。" }],
      })),
    );

    const reloaded = await repository.load();
    expect(reloaded.narrative.library.chapters).toHaveLength(2);
    reloaded.narrative.library.chapters.forEach((plan) => {
      expect(plan.manuscriptChapterId).toBeTruthy();
      expect(
        reloaded.chapters.find(
          (chapter) => chapter.id === plan.manuscriptChapterId,
        )?.narrativeChapterId,
      ).toBe(plan.id);
    });
  });

  it("正文索引提交失败时不会提前写入剧情工程", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty, { title: "第一章" });
    const project = await repository.load();
    const chapter = project.chapters.find((item) => item.id === record.id)!;
    storage.failNextIndexWrite = true;

    await expect(
      repository.extractChaptersToNarrative(project, [
        {
          chapterId: chapter.id,
          sourceContentHash: hashManuscriptContent(chapter.content),
          targetNarrativeChapterId: null,
          title: "不会落盘的提炼",
          description: "索引写入失败时不应保存。",
          sections: [],
        },
      ]),
    ).rejects.toThrow("Index write failed");

    const reloaded = await repository.load();
    expect(reloaded.narrative.library.chapters).toHaveLength(0);
    expect(reloaded.chapters[0]?.narrativeChapterId).toBeNull();
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

describe("synchronizeNarrative 双向关联排他", () => {
  async function setupWithPlans(
    planManuscriptChapterId: string | null,
  ): Promise<{ storage: NovelMemoryStorage; repository: NovelRepository }> {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    let project = await repository.load();
    await repository.createChapter(project, { title: "第一章" });
    project = await repository.load();
    await repository.createChapter(project, { title: "第二章" });
    project = await repository.load();
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const current = await narrativeRepository.load();
    const plan = {
      id: "narrative-chapter-a",
      directoryId: null,
      manuscriptChapterId: planManuscriptChapterId,
      title: "规划章节 A",
      description: "",
      status: "drafting" as const,
      order: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      lineIds: [],
      arcIds: [],
      sections: [],
    };
    await narrativeRepository.save(current, {
      ...current.library,
      chapters: [plan],
    });
    return { storage, repository };
  }

  async function loadPlanManuscriptChapterId(
    storage: NovelMemoryStorage,
  ): Promise<string | null> {
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const loaded = await narrativeRepository.load();
    return loaded.library.chapters[0]?.manuscriptChapterId ?? null;
  }

  it("换绑后旧正文解除关联，新正文建立关联", async () => {
    const { storage, repository } = await setupWithPlans("chapter-000001");
    let project = await repository.load();
    await repository.synchronizeNarrative(project, "merged");
    project = await repository.load();
    expect(
      project.chapters.find((chapter) => chapter.id === "chapter-000001")
        ?.narrativeChapterId,
    ).toBe("narrative-chapter-a");

    // 剧情工程侧把 plan 换绑到第二章
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const current = await narrativeRepository.load();
    await narrativeRepository.save(current, {
      ...current.library,
      chapters: current.library.chapters.map((plan) => ({
        ...plan,
        manuscriptChapterId: "chapter-000002",
      })),
    });
    await repository.synchronizeNarrative(project, "merged");
    project = await repository.load();

    expect(
      project.chapters.find((chapter) => chapter.id === "chapter-000001")
        ?.narrativeChapterId,
    ).toBeNull();
    expect(
      project.chapters.find((chapter) => chapter.id === "chapter-000002")
        ?.narrativeChapterId,
    ).toBe("narrative-chapter-a");
  });

  it("剧情工程侧取消关联后正文侧同步解绑", async () => {
    const { storage, repository } = await setupWithPlans("chapter-000001");
    let project = await repository.load();
    await repository.synchronizeNarrative(project, "merged");
    project = await repository.load();
    expect(
      project.chapters.find((chapter) => chapter.id === "chapter-000001")
        ?.narrativeChapterId,
    ).toBe("narrative-chapter-a");

    // 剧情工程侧显式选择“暂不关联正文”
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const current = await narrativeRepository.load();
    await narrativeRepository.save(current, {
      ...current.library,
      chapters: current.library.chapters.map((plan) => ({
        ...plan,
        manuscriptChapterId: null,
      })),
    });
    await repository.synchronizeNarrative(project, "merged");
    project = await repository.load();

    expect(
      project.chapters.find((chapter) => chapter.id === "chapter-000001")
        ?.narrativeChapterId,
    ).toBeNull();
    expect(await loadPlanManuscriptChapterId(storage)).toBeNull();
  });

  it("正常关联在同步后保持双向一致", async () => {
    const { storage, repository } = await setupWithPlans("chapter-000001");
    const project = await repository.load();
    await repository.synchronizeNarrative(project, "merged");
    const reloaded = await repository.load();
    expect(
      reloaded.chapters.find((chapter) => chapter.id === "chapter-000001")
        ?.narrativeChapterId,
    ).toBe("narrative-chapter-a");
    expect(await loadPlanManuscriptChapterId(storage)).toBe("chapter-000001");
  });
});

describe("structureMode legacy free 不被隐式改写", () => {
  it("自动同步保留 legacy free，不升级为 merged", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    expect(project.chapterIndex.structureMode).toBe("free");

    // 首次同步允许完成 v1→v4 的格式迁移，但结构模式必须保留 free
    const firstSynchronization = await repository.synchronizeNarrative(
      project,
      project.chapterIndex.structureMode,
    );
    expect(firstSynchronization).toEqual({ changed: true });
    const afterFirst = JSON.parse(storage.getText("manuscript/index.json")!);
    expect(afterFirst.structureMode).toBe("free");

    // 稳定态（v4 + free）下再次同步不应产生任何写盘
    const reloaded = await repository.load();
    expect(reloaded.chapterIndex.structureMode).toBe("free");
    const beforeSecond = storage.getText("manuscript/index.json");
    const stableSynchronization = await repository.synchronizeNarrative(
      reloaded,
      reloaded.chapterIndex.structureMode,
    );
    expect(stableSynchronization).toEqual({ changed: false });
    expect(storage.getText("manuscript/index.json")).toBe(beforeSecond);
  });

  it("显式 setStructureMode 才迁移为 merged", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();

    await repository.setStructureMode(project, "merged");

    const onDisk = JSON.parse(storage.getText("manuscript/index.json")!);
    expect(onDisk.structureMode).toBe("merged");
    // 加载后结构模式与磁盘一致，且行为仍按解锁同步处理
    const reloaded = await repository.load();
    expect(reloaded.chapterIndex.structureMode).toBe("merged");
    expect(reloaded.chapters).toEqual([]);
  });
});

describe("deleteChapterPermanently 回收站彻底删除", () => {
  it("移除回收站记录、正文文件与历史版本", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    let project = await repository.load();
    const chapter = await repository.createChapter(project, {
      title: "第一章",
    });
    project = await repository.load();
    await repository.deleteChapter(project, chapter.id, "");
    project = await repository.load();
    expect(project.chapterIndex.trash).toHaveLength(1);

    const versionRepository = createManuscriptVersionRepository(storage);
    await versionRepository.create(
      { id: chapter.id, title: "第一章" },
      "待删除内容",
      "manual-save",
    );

    const deletionId = project.chapterIndex.trash[0]!.deletionId;
    await repository.deleteChapterPermanently(project, deletionId);

    const reloaded = await repository.load();
    expect(reloaded.chapterIndex.trash).toHaveLength(0);
    expect(
      storage.getText(`manuscript/trash/${deletionId}/000001.md`),
    ).toBeUndefined();
    expect(await versionRepository.list(chapter.id)).toHaveLength(0);
  });

  it("删除不存在的回收站记录时抛错且不写盘", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const before = storage.getText("manuscript/index.json");

    await expect(
      repository.deleteChapterPermanently(project, "deletion-missing"),
    ).rejects.toThrow("回收站记录不存在");
    expect(storage.getText("manuscript/index.json")).toBe(before);
  });
});
