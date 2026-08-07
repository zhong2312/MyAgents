import type { WorkbenchStorage, WorkbenchStorageEntry } from "@/workbench-sdk";

import {
  createNarrativeEngineeringRepository,
  type LoadedNarrativeEngineering,
} from "../../../narrativeEngineeringRepository";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";
import type {
  NarrativeChapterPlan,
  NarrativeDirectory,
  NarrativeEngineering,
} from "../../../narrativeEngineeringSchema";
import {
  orderManuscriptChapters,
  parseNovelChapterIndex,
  parseNovelMetadata,
  serializeNovelChapterIndex,
  type DeletedNovelChapter,
  type ManuscriptDirectory,
  type ManuscriptDirectoryKind,
  type ManuscriptPlanningMode,
  type ManuscriptStructureMode,
  type ManuscriptTypography,
  type NovelChapterIndex,
  type NovelChapterRecord,
  type NovelChapterStatus,
  type NovelMetadata,
} from "../entities/projectSchema";
import { createManuscriptTrackingRepository } from "../../../manuscriptTrackingRepository";

const NOVEL_METADATA_PATH = "novel.json";
const CHAPTER_INDEX_PATH = "manuscript/index.json";
const CHAPTER_TRASH_ROOT = "manuscript/trash";
const FREE_CONTENT_DIRECTORY_ID = "directory-free-content";

// 原子性契约：novel.json（元数据）与 manuscript/index.json（章节索引）互不依赖，
// 每次写操作以各自文件为 CAS 单元（expectedContent）。涉及多文件的复合操作
// （章节文件 + 索引 + 追踪批次 + 剧情关联）遵循“先写主文件，失败时逐级反向
// 补偿”的编排：补偿无法完成时抛错并提示重新加载检查，而不是静默半提交。

export interface LoadedNovelChapter extends NovelChapterRecord {
  readonly content: string;
  readonly words: number;
}

export interface LoadedNovelProject {
  readonly metadata: NovelMetadata;
  readonly metadataContent: string;
  readonly chapterIndex: NovelChapterIndex;
  readonly chapterIndexContent: string;
  readonly chapterIndexNeedsMigration: boolean;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly narrative: LoadedNarrativeEngineering;
}

export interface CreateNovelChapterOptions {
  readonly directoryId?: string | null;
  readonly narrativeChapterId?: string | null;
  readonly displayNumber?: number;
  readonly title?: string;
  readonly status?: NovelChapterStatus;
}

export interface UpdateNovelChapterInput {
  readonly displayNumber?: number;
  readonly title?: string;
  readonly status?: NovelChapterStatus;
  readonly directoryId?: string | null;
  readonly order?: number;
  readonly trackingStatus?: NovelChapterRecord["trackingStatus"];
  readonly lastTrackedAt?: string | null;
  readonly planningMode?: ManuscriptPlanningMode;
}

export interface UpdateNovelProjectSettingsInput {
  readonly title: string;
  readonly genres: readonly string[];
  readonly targetWordCountMin: number;
  readonly targetWordCountMax: number;
  readonly chapterWordCount: number;
  readonly language?: string;
  readonly description?: string;
}

interface UpdatedChapterIndex {
  readonly chapterIndex: NovelChapterIndex;
  readonly chapterIndexContent: string;
}

export interface NarrativeSynchronizationResult {
  /** 本次同步是否产生了任何写盘（索引、正文文件、批次顺序或剧情工程）。 */
  readonly changed: boolean;
}

export interface NovelRepository {
  load(): Promise<LoadedNovelProject>;
  saveProjectSettings(
    project: LoadedNovelProject,
    input: UpdateNovelProjectSettingsInput,
  ): Promise<{ metadata: NovelMetadata; metadataContent: string }>;
  saveKnowledgeGraphEnabled(
    project: LoadedNovelProject,
    enabled: boolean,
  ): Promise<{ metadata: NovelMetadata; metadataContent: string }>;
  createChapter(
    project: LoadedNovelProject,
    options?: CreateNovelChapterOptions,
  ): Promise<NovelChapterRecord>;
  updateChapter(
    project: LoadedNovelProject,
    chapterId: string,
    input: UpdateNovelChapterInput,
  ): Promise<UpdatedChapterIndex>;
  renameChapter(
    project: LoadedNovelProject,
    chapterId: string,
    title: string,
  ): Promise<UpdatedChapterIndex>;
  linkChapterToNarrative(
    project: LoadedNovelProject,
    chapterId: string,
    narrativeChapterId: string | null,
  ): Promise<void>;
  createDirectory(
    project: LoadedNovelProject,
    parentId: string | null,
    kind: ManuscriptDirectoryKind,
    title: string,
  ): Promise<ManuscriptDirectory>;
  updateDirectory(
    project: LoadedNovelProject,
    directoryId: string,
    input: {
      readonly title?: string;
      readonly parentId?: string | null;
      readonly kind?: ManuscriptDirectoryKind;
      readonly order?: number;
      readonly narrativeDirectoryId?: string | null;
    },
  ): Promise<UpdatedChapterIndex>;
  deleteDirectory(
    project: LoadedNovelProject,
    directoryId: string,
  ): Promise<UpdatedChapterIndex>;
  setStructureMode(
    project: LoadedNovelProject,
    mode: ManuscriptStructureMode,
  ): Promise<void>;
  /**
   * 将剧情工程结构同步到正文索引。`changed` 表示本次是否真的写盘，
   * 调用方据此决定要不要重新加载，避免稳定态下的无谓全量读取。
   */
  synchronizeNarrative(
    project: LoadedNovelProject,
    mode?: ManuscriptStructureMode,
  ): Promise<NarrativeSynchronizationResult>;
  saveTypography(
    project: LoadedNovelProject,
    typography: ManuscriptTypography,
  ): Promise<UpdatedChapterIndex>;
  deleteChapter(
    project: LoadedNovelProject,
    chapterId: string,
    expectedContent: string,
  ): Promise<void>;
  restoreChapter(
    project: LoadedNovelProject,
    deletionId: string,
  ): Promise<void>;
  saveChapter(
    chapter: LoadedNovelChapter,
    content: string,
    expectedContent: string,
  ): Promise<LoadedNovelChapter>;
  deleteChapterPermanently(
    project: LoadedNovelProject,
    deletionId: string,
  ): Promise<UpdatedChapterIndex>;
}

export function countNovelWords(content: string): number {
  return Array.from(content).filter((character) => !/\s/u.test(character))
    .length;
}

function chapterFileName(number: number): string {
  return `${String(number).padStart(6, "0")}.md`;
}

function createStableId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.toLowerCase()}`;
}

function sourceSchemaVersion(content: string): number | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const value = (parsed as Record<string, unknown>).schemaVersion;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function assertMutableStructure(project: LoadedNovelProject): void {
  if (project.chapterIndex.structureMode === "locked") {
    throw new Error("结构锁定后，目录与章节结构只能由剧情工程同步");
  }
}

function normalizeDirectoryOrders(
  directories: readonly ManuscriptDirectory[],
): ManuscriptDirectory[] {
  const grouped = new Map<string, ManuscriptDirectory[]>();
  directories.forEach((directory) => {
    const key = directory.parentId ?? "root";
    grouped.set(key, [...(grouped.get(key) ?? []), directory]);
  });
  const result: ManuscriptDirectory[] = [];
  grouped.forEach((items) => {
    items
      .sort((left, right) => left.order - right.order)
      .forEach((item, order) => result.push({ ...item, order }));
  });
  return result;
}

function normalizeChapterOrders(
  chapters: readonly NovelChapterRecord[],
): NovelChapterRecord[] {
  const grouped = new Map<string, NovelChapterRecord[]>();
  chapters.forEach((chapter) => {
    const key = chapter.directoryId ?? "root";
    grouped.set(key, [...(grouped.get(key) ?? []), chapter]);
  });
  const result: NovelChapterRecord[] = [];
  grouped.forEach((items) => {
    items
      .sort(
        (left, right) => left.order - right.order || left.number - right.number,
      )
      .forEach((item, order) => result.push({ ...item, order }));
  });
  return result;
}

function chapterDisplayScope(
  chapter: Pick<NovelChapterRecord, "narrativeChapterId">,
): "narrative" | "free" {
  return chapter.narrativeChapterId ? "narrative" : "free";
}

function nextDisplayNumber(
  chapters: readonly Pick<
    NovelChapterRecord,
    "displayNumber" | "narrativeChapterId"
  >[],
  scope: "narrative" | "free",
): number {
  return (
    chapters
      .filter((chapter) => chapterDisplayScope(chapter) === scope)
      .reduce(
        (highest, chapter) => Math.max(highest, chapter.displayNumber),
        0,
      ) + 1
  );
}

function assertAvailableDisplayNumber(
  chapters: readonly NovelChapterRecord[],
  chapterId: string,
  narrativeChapterId: string | null,
  displayNumber: number,
): void {
  if (!Number.isInteger(displayNumber) || displayNumber < 1) {
    throw new Error("章节显示编号必须是正整数");
  }
  const scope = chapterDisplayScope({ narrativeChapterId });
  const duplicate = chapters.find(
    (chapter) =>
      chapter.id !== chapterId &&
      chapterDisplayScope(chapter) === scope &&
      chapter.displayNumber === displayNumber,
  );
  if (duplicate) {
    throw new Error(
      `该${scope === "narrative" ? "剧情工程" : "自由正文"}序列已使用编号 ${displayNumber}`,
    );
  }
}

function narrativeDirectoryKind(
  directory: NarrativeDirectory,
): ManuscriptDirectoryKind {
  if (directory.kind === "volume") return "volume";
  if (directory.kind === "part") return "part";
  return "folder";
}

function narrativeChapterStatus(
  plan: NarrativeChapterPlan,
): NovelChapterStatus {
  if (plan.status === "complete") return "complete";
  if (plan.status === "drafting") return "draft";
  return "planned";
}

function replaceNarrativeChapterLinks(
  library: NarrativeEngineering,
  links: ReadonlyMap<string, string>,
): NarrativeEngineering {
  return {
    ...library,
    chapters: library.chapters.map((plan) => ({
      ...plan,
      manuscriptChapterId: links.get(plan.id) ?? null,
    })),
  };
}

export function createNovelRepository(
  storage: WorkbenchStorage,
): NovelRepository {
  const narrativeRepository = createNarrativeEngineeringRepository(storage);
  const trackingRepository = createManuscriptTrackingRepository(storage);

  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const rollbackIndex = async (
    project: LoadedNovelProject,
    committedContent: string,
  ): Promise<boolean> => {
    try {
      await storage.writeText(CHAPTER_INDEX_PATH, project.chapterIndexContent, {
        expectedContent: committedContent,
      });
      return true;
    } catch {
      return false;
    }
  };

  const moveFile = async (
    sourcePath: string,
    targetDirectory: string,
    message: string,
  ): Promise<void> => {
    const result = await storage.move([sourcePath], targetDirectory);
    if (result.errors.length || result.transfers.length !== 1) {
      throw new Error(result.errors[0] ?? message);
    }
  };

  const restoreMovedFile = async (
    sourcePath: string,
    targetDirectory: string,
    fallbackPath: string,
    fallbackContent: string,
  ): Promise<void> => {
    const [fallbackInfo] = await storage.stat([fallbackPath]);
    if (fallbackInfo?.exists) return;
    try {
      await moveFile(sourcePath, targetDirectory, "文件补偿移动失败");
      return;
    } catch {
      const [afterMove] = await storage.stat([fallbackPath]);
      if (afterMove?.exists) return;
    }
    await storage.createText(fallbackPath, fallbackContent, {
      createParents: true,
    });
  };

  const throwWithRecovery = (
    error: unknown,
    recoveryErrors: readonly unknown[],
  ): never => {
    if (!recoveryErrors.length) throw error;
    throw new Error(
      `${errorText(error)}；自动恢复未完全成功：${recoveryErrors
        .map(errorText)
        .join("；")}`,
    );
  };

  const writeIndex = async (
    project: LoadedNovelProject,
    chapterIndex: NovelChapterIndex,
  ): Promise<UpdatedChapterIndex> => {
    const chapterIndexContent = serializeNovelChapterIndex(chapterIndex);
    await storage.writeText(CHAPTER_INDEX_PATH, chapterIndexContent, {
      expectedContent: project.chapterIndexContent,
    });
    return Object.freeze({ chapterIndex, chapterIndexContent });
  };

  const writeStructureIndex = async (
    project: LoadedNovelProject,
    chapterIndex: NovelChapterIndex,
  ): Promise<UpdatedChapterIndex> => {
    const updated = await writeIndex(project, chapterIndex);
    try {
      await trackingRepository.reorderAppliedBatches(
        project.chapterIndex,
        chapterIndex,
      );
      return updated;
    } catch (error) {
      if (!(await rollbackIndex(project, updated.chapterIndexContent))) {
        throw new Error(
          `${errorText(error)}；正文结构已提交且无法自动回滚，请重新加载后检查状态顺序`,
        );
      }
      throw error;
    }
  };

  const writeMetadata = async (
    project: LoadedNovelProject,
    update: (raw: Record<string, unknown>) => void,
  ): Promise<{ metadata: NovelMetadata; metadataContent: string }> => {
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(project.metadataContent);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("novel.json 必须是 JSON 对象");
      }
      raw = { ...(parsed as Record<string, unknown>) };
    } catch (error) {
      throw new Error(
        `读取 novel.json 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    update(raw);
    raw.updatedAt = new Date().toISOString();
    const metadataContent = `${JSON.stringify(raw, null, 2)}\n`;
    const metadata = parseNovelMetadata(metadataContent);
    await storage.writeText(NOVEL_METADATA_PATH, metadataContent, {
      expectedContent: project.metadataContent,
    });
    return Object.freeze({ metadata, metadataContent });
  };

  const repository: NovelRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("小说项目存储仅在 MyAgents 桌面端可用");
      }
      const [metadataFile, chapterIndexFile, narrative] = await Promise.all([
        storage.readText(NOVEL_METADATA_PATH),
        storage.readText(CHAPTER_INDEX_PATH),
        narrativeRepository.load(),
      ]);
      const metadata = parseNovelMetadata(metadataFile.content);
      const chapterIndex = parseNovelChapterIndex(chapterIndexFile.content);
      const chapters = await Promise.all(
        chapterIndex.chapters.map(
          async (record): Promise<LoadedNovelChapter> => {
            const file = await storage.readText(record.path);
            return Object.freeze({
              ...record,
              content: file.content,
              words: countNovelWords(file.content),
            });
          },
        ),
      );
      const orderedChapters = orderManuscriptChapters(
        chapterIndex.directories,
        chapters,
      );
      return Object.freeze({
        metadata,
        metadataContent: metadataFile.content,
        chapterIndex,
        chapterIndexContent: chapterIndexFile.content,
        chapterIndexNeedsMigration:
          sourceSchemaVersion(chapterIndexFile.content) !==
          chapterIndex.schemaVersion,
        chapters: Object.freeze(orderedChapters),
        narrative,
      });
    },

    async saveProjectSettings(project, input) {
      return writeMetadata(project, (raw) => {
        raw.projectName = project.metadata.projectName;
        raw.title = input.title.trim();
        raw.genres = [...input.genres];
        raw.targetWordCountMin = input.targetWordCountMin;
        raw.targetWordCountMax = input.targetWordCountMax;
        raw.chapterWordCount = input.chapterWordCount;
        if (input.language?.trim()) raw.language = input.language.trim();
        if (input.description?.trim()) raw.description = input.description.trim();
        else delete raw.description;
        delete raw.targetWordCount;
      });
    },

    async saveKnowledgeGraphEnabled(project, enabled) {
      return writeMetadata(project, (raw) => {
        raw.knowledgeGraph = { enabled };
      });
    },

    async createChapter(project, options = {}) {
      assertMutableStructure(project);
      if (
        options.directoryId &&
        !project.chapterIndex.directories.some(
          (directory) => directory.id === options.directoryId,
        )
      ) {
        throw new Error("目标目录不存在");
      }
      const currentNarrative = options.narrativeChapterId
        ? await narrativeRepository.load()
        : null;
      if (options.narrativeChapterId) {
        const plan = currentNarrative?.library.chapters.find(
          (item) => item.id === options.narrativeChapterId,
        );
        if (!plan) throw new Error("章节规划不存在或已被删除");
        if (
          plan.manuscriptChapterId ||
          project.chapterIndex.chapters.some(
            (chapter) =>
              chapter.narrativeChapterId === options.narrativeChapterId,
          )
        ) {
          throw new Error("该章节规划已经关联正文");
        }
      }
      const number = project.chapterIndex.nextChapterNumber;
      const serial = String(number).padStart(6, "0");
      const directories = [...project.chapterIndex.directories];
      let directoryId = options.directoryId ?? null;
      if (!directoryId && options.narrativeChapterId && currentNarrative) {
        const plan = currentNarrative.library.chapters.find(
          (item) => item.id === options.narrativeChapterId,
        );
        directoryId = plan?.directoryId
          ? (directories.find(
              (directory) =>
                directory.narrativeDirectoryId === plan.directoryId,
            )?.id ?? null)
          : null;
      }
      if (!directoryId) {
        const rootDirectories = directories
          .filter((directory) => directory.parentId === null)
          .sort((left, right) => left.order - right.order);
        directoryId =
          rootDirectories.find((directory) => directory.narrativeDirectoryId)
            ?.id ??
          rootDirectories[0]?.id ??
          FREE_CONTENT_DIRECTORY_ID;
      }
      if (!directories.some((directory) => directory.id === directoryId)) {
        directories.push({
          id: FREE_CONTENT_DIRECTORY_ID,
          parentId: null,
          kind: "folder",
          title: "自由内容",
          order: directories.filter((directory) => directory.parentId === null)
            .length,
          narrativeDirectoryId: null,
        });
      }
      const displayNumber =
        options.displayNumber ??
        nextDisplayNumber(
          project.chapterIndex.chapters,
          options.narrativeChapterId ? "narrative" : "free",
        );
      assertAvailableDisplayNumber(
        project.chapterIndex.chapters,
        `chapter-${serial}`,
        options.narrativeChapterId ?? null,
        displayNumber,
      );
      const record: NovelChapterRecord = {
        id: `chapter-${serial}`,
        number,
        displayNumber,
        title: options.title?.trim() || `第 ${displayNumber} 章`,
        path: `manuscript/chapters/${chapterFileName(number)}`,
        status: options.status ?? "draft",
        directoryId,
        order: project.chapterIndex.chapters.filter(
          (chapter) => chapter.directoryId === directoryId,
        ).length,
        narrativeChapterId: options.narrativeChapterId ?? null,
        planningMode: "reference",
        trackingStatus: "idle",
        lastTrackedAt: null,
      };
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        nextChapterNumber: number + 1,
        directories: normalizeDirectoryOrders(directories),
        chapters: [...project.chapterIndex.chapters, record],
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      const creation = createStorageTransaction(storage);
      creation.createText(record.path, "");
      creation.writeText(
        CHAPTER_INDEX_PATH,
        nextIndexContent,
        project.chapterIndexContent,
      );
      await creation.commit();

      const rollbackCreation = async (): Promise<void> => {
        const rollback = createStorageTransaction(storage);
        rollback.writeText(
          CHAPTER_INDEX_PATH,
          project.chapterIndexContent,
          nextIndexContent,
        );
        rollback.remove(record.path);
        await rollback.commit();
      };
      try {
        await trackingRepository.reorderAppliedBatches(
          project.chapterIndex,
          nextIndex,
        );
      } catch (error) {
        try {
          await rollbackCreation();
        } catch (rollbackCause) {
          throw new AggregateError(
            [error, rollbackCause],
            "新章节创建后的状态重排失败，且文件恢复未完全成功",
          );
        }
        throw error;
      }
      if (currentNarrative && options.narrativeChapterId) {
        try {
          await narrativeRepository.save(currentNarrative, {
            ...currentNarrative.library,
            chapters: currentNarrative.library.chapters.map((plan) =>
              plan.id === options.narrativeChapterId
                ? { ...plan, manuscriptChapterId: record.id }
                : plan,
            ),
          });
        } catch (error) {
          const recoveryErrors: unknown[] = [];
          await trackingRepository
            .reorderAppliedBatches(nextIndex, project.chapterIndex)
            .catch((cause) => recoveryErrors.push(cause));
          if (recoveryErrors.length) {
            throwWithRecovery(error, recoveryErrors);
          }
          try {
            await rollbackCreation();
          } catch (rollbackCause) {
            await trackingRepository
              .reorderAppliedBatches(project.chapterIndex, nextIndex)
              .catch(() => undefined);
            throw new AggregateError(
              [error, rollbackCause],
              "剧情关联保存失败，且新章节文件恢复未完全成功",
            );
          }
          throw error;
        }
      }
      return Object.freeze(record);
    },

    async updateChapter(project, chapterId, input) {
      if (input.directoryId !== undefined || input.order !== undefined) {
        assertMutableStructure(project);
      }
      if (input.directoryId === null) {
        throw new Error("正文必须归属一个目录");
      }
      const position = project.chapterIndex.chapters.findIndex(
        (chapter) => chapter.id === chapterId,
      );
      if (position < 0) throw new Error(`章节不存在：${chapterId}`);
      if (
        input.directoryId &&
        !project.chapterIndex.directories.some(
          (directory) => directory.id === input.directoryId,
        )
      ) {
        throw new Error("目标目录不存在");
      }
      const current = project.chapterIndex.chapters[position];
      const title = input.title?.trim();
      if (input.title !== undefined && !title) {
        throw new Error("章节标题不能为空");
      }
      if (input.displayNumber !== undefined) {
        assertAvailableDisplayNumber(
          project.chapterIndex.chapters,
          chapterId,
          current.narrativeChapterId,
          input.displayNumber,
        );
      }
      const updatedChapter: NovelChapterRecord = {
        ...current,
        ...(input.displayNumber !== undefined
          ? { displayNumber: input.displayNumber }
          : {}),
        ...(title ? { title } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.directoryId !== undefined
          ? { directoryId: input.directoryId }
          : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.trackingStatus
          ? { trackingStatus: input.trackingStatus }
          : {}),
        ...(input.lastTrackedAt !== undefined
          ? { lastTrackedAt: input.lastTrackedAt }
          : {}),
        ...(input.planningMode ? { planningMode: input.planningMode } : {}),
      };
      const remaining = project.chapterIndex.chapters.filter(
        (chapter) => chapter.id !== chapterId,
      );
      const targetSiblings = remaining
        .filter((chapter) => chapter.directoryId === updatedChapter.directoryId)
        .sort(
          (left, right) =>
            left.order - right.order || left.number - right.number,
        );
      const requestedOrder =
        input.order ??
        (updatedChapter.directoryId === current.directoryId
          ? current.order
          : targetSiblings.length);
      targetSiblings.splice(
        Math.min(Math.max(0, requestedOrder), targetSiblings.length),
        0,
        updatedChapter,
      );
      const nextIndex = {
        ...project.chapterIndex,
        chapters: normalizeChapterOrders([
          ...remaining.filter(
            (chapter) => chapter.directoryId !== updatedChapter.directoryId,
          ),
          ...targetSiblings,
        ]),
      };
      return input.directoryId !== undefined || input.order !== undefined
        ? writeStructureIndex(project, nextIndex)
        : writeIndex(project, nextIndex);
    },

    async renameChapter(project, chapterId, title) {
      return repository.updateChapter(project, chapterId, { title });
    },

    async linkChapterToNarrative(project, chapterId, narrativeChapterId) {
      const chapter = project.chapterIndex.chapters.find(
        (item) => item.id === chapterId,
      );
      if (!chapter) throw new Error(`章节不存在：${chapterId}`);
      if (project.chapterIndex.structureMode === "locked") {
        throw new Error("结构锁定后，正文关联由剧情工程同步");
      }
      const currentNarrative = await narrativeRepository.load();
      if (
        narrativeChapterId &&
        !currentNarrative.library.chapters.some(
          (plan) => plan.id === narrativeChapterId,
        )
      ) {
        throw new Error("章节规划不存在或已被删除");
      }
      const occupied = narrativeChapterId
        ? currentNarrative.library.chapters.find(
            (plan) =>
              plan.id === narrativeChapterId &&
              plan.manuscriptChapterId &&
              plan.manuscriptChapterId !== chapterId,
          )
        : undefined;
      if (occupied) throw new Error("该章节规划已经关联其它正文");

      const targetPlan = narrativeChapterId
        ? currentNarrative.library.chapters.find(
            (plan) => plan.id === narrativeChapterId,
          )
        : undefined;
      const directories = [...project.chapterIndex.directories];
      let targetDirectoryId = targetPlan?.directoryId
        ? (project.chapterIndex.directories.find(
            (directory) =>
              directory.narrativeDirectoryId === targetPlan.directoryId,
          )?.id ?? null)
        : chapter.directoryId;
      if (!narrativeChapterId) {
        targetDirectoryId = FREE_CONTENT_DIRECTORY_ID;
        if (
          !directories.some((directory) => directory.id === targetDirectoryId)
        ) {
          directories.push({
            id: FREE_CONTENT_DIRECTORY_ID,
            parentId: null,
            kind: "folder",
            title: "自由内容",
            order: directories.filter(
              (directory) => directory.parentId === null,
            ).length,
            narrativeDirectoryId: null,
          });
        }
      }
      if (narrativeChapterId && targetPlan?.directoryId && !targetDirectoryId) {
        throw new Error("剧情目录尚未同步到正文目录，请先同步剧情工程");
      }
      const targetOrder =
        targetDirectoryId === chapter.directoryId
          ? chapter.order
          : project.chapterIndex.chapters.filter(
              (item) =>
                item.id !== chapterId && item.directoryId === targetDirectoryId,
            ).length;
      const targetScope = narrativeChapterId ? "narrative" : "free";
      const targetDisplayNumber =
        chapterDisplayScope(chapter) === targetScope
          ? chapter.displayNumber
          : nextDisplayNumber(project.chapterIndex.chapters, targetScope);

      const chapters = project.chapterIndex.chapters.map((item) => ({
        ...item,
        ...(item.id === chapterId
          ? {
              narrativeChapterId,
              directoryId: targetDirectoryId,
              order: targetOrder,
              displayNumber: targetDisplayNumber,
            }
          : item.narrativeChapterId === narrativeChapterId
            ? { narrativeChapterId: null }
            : {}),
      }));
      const nextIndex = {
        ...project.chapterIndex,
        directories: normalizeDirectoryOrders(directories),
        chapters: normalizeChapterOrders(chapters),
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
        expectedContent: project.chapterIndexContent,
      });
      try {
        await narrativeRepository.save(currentNarrative, {
          ...currentNarrative.library,
          chapters: currentNarrative.library.chapters.map((plan) => ({
            ...plan,
            manuscriptChapterId:
              plan.id === narrativeChapterId
                ? chapterId
                : plan.manuscriptChapterId === chapterId
                  ? null
                  : plan.manuscriptChapterId,
          })),
        });
      } catch (error) {
        if (!(await rollbackIndex(project, nextIndexContent))) {
          throw new Error(
            `${errorText(error)}；正文索引已提交且无法自动回滚，请重新加载后检查剧情关联`,
          );
        }
        throw error;
      }
    },

    async createDirectory(project, parentId, kind, title) {
      assertMutableStructure(project);
      const normalizedTitle = title.trim();
      if (!normalizedTitle) throw new Error("目录名称不能为空");
      if (
        parentId &&
        !project.chapterIndex.directories.some(
          (directory) => directory.id === parentId,
        )
      ) {
        throw new Error("父目录不存在");
      }
      const directory: ManuscriptDirectory = {
        id: createStableId("directory"),
        parentId,
        kind,
        title: normalizedTitle,
        order: project.chapterIndex.directories.filter(
          (item) => item.parentId === parentId,
        ).length,
        narrativeDirectoryId: null,
      };
      await writeIndex(project, {
        ...project.chapterIndex,
        directories: [...project.chapterIndex.directories, directory],
      });
      return Object.freeze(directory);
    },

    async updateDirectory(project, directoryId, input) {
      assertMutableStructure(project);
      const directory = project.chapterIndex.directories.find(
        (item) => item.id === directoryId,
      );
      if (!directory) throw new Error("目录不存在");
      const title = input.title?.trim();
      if (input.title !== undefined && !title) {
        throw new Error("目录名称不能为空");
      }
      if (input.parentId === directoryId) {
        throw new Error("目录不能成为自己的父目录");
      }
      if (
        input.parentId &&
        !project.chapterIndex.directories.some(
          (item) => item.id === input.parentId,
        )
      ) {
        throw new Error("目标父目录不存在");
      }
      const descendants = new Set<string>();
      const collect = (parentId: string) => {
        project.chapterIndex.directories
          .filter((item) => item.parentId === parentId)
          .forEach((item) => {
            descendants.add(item.id);
            collect(item.id);
          });
      };
      collect(directoryId);
      if (input.parentId && descendants.has(input.parentId)) {
        throw new Error("目录不能移动到自己的子目录中");
      }
      if (
        input.narrativeDirectoryId &&
        !project.narrative.library.directories.some(
          (item) => item.id === input.narrativeDirectoryId,
        )
      ) {
        throw new Error("剧情目录不存在或已被删除");
      }
      if (
        input.narrativeDirectoryId &&
        project.chapterIndex.directories.some(
          (item) =>
            item.id !== directoryId &&
            item.narrativeDirectoryId === input.narrativeDirectoryId,
        )
      ) {
        throw new Error("该剧情目录已经关联其它正文目录");
      }
      const updatedDirectory: ManuscriptDirectory = {
        ...directory,
        ...(title ? { title } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.narrativeDirectoryId !== undefined
          ? { narrativeDirectoryId: input.narrativeDirectoryId }
          : {}),
      };
      const remaining = project.chapterIndex.directories.filter(
        (item) => item.id !== directoryId,
      );
      const targetSiblings = remaining
        .filter((item) => item.parentId === updatedDirectory.parentId)
        .sort((left, right) => left.order - right.order);
      const requestedOrder =
        input.order ??
        (updatedDirectory.parentId === directory.parentId
          ? directory.order
          : targetSiblings.length);
      targetSiblings.splice(
        Math.min(Math.max(0, requestedOrder), targetSiblings.length),
        0,
        updatedDirectory,
      );
      return writeStructureIndex(project, {
        ...project.chapterIndex,
        directories: normalizeDirectoryOrders([
          ...remaining.filter(
            (item) => item.parentId !== updatedDirectory.parentId,
          ),
          ...targetSiblings,
        ]),
      });
    },

    async deleteDirectory(project, directoryId) {
      assertMutableStructure(project);
      if (
        project.chapterIndex.directories.some(
          (item) => item.parentId === directoryId,
        ) ||
        project.chapterIndex.chapters.some(
          (chapter) => chapter.directoryId === directoryId,
        )
      ) {
        throw new Error("请先移动目录内的子目录和章节");
      }
      return writeIndex(project, {
        ...project.chapterIndex,
        directories: normalizeDirectoryOrders(
          project.chapterIndex.directories.filter(
            (item) => item.id !== directoryId,
          ),
        ),
      });
    },

    async setStructureMode(project, mode) {
      // Keep legacy values readable, but expose one unlocked state in the UI.
      // 显式切换是唯一的迁移时机：非 locked 一律落盘为 merged。
      await repository.synchronizeNarrative(
        project,
        mode === "locked" ? "locked" : "merged",
      );
    },

    async synchronizeNarrative(
      project,
      mode = project.chapterIndex.structureMode,
    ) {
      // `free` is a legacy persisted value. It now behaves as unlocked sync.
      // effectiveMode 只决定行为分支；写盘保留 mode 原值，
      // 避免旧项目在自动同步（每次加载都会执行）时被隐式改写磁盘。
      const effectiveMode = mode === "locked" ? "locked" : "merged";
      const narrative = await narrativeRepository.load();
      if (effectiveMode === "locked") {
        const unlinkedDirectory = project.chapterIndex.directories.find(
          (directory) => !directory.narrativeDirectoryId,
        );
        const unlinkedChapter = project.chapterIndex.chapters.find(
          (chapter) => !chapter.narrativeChapterId,
        );
        if (unlinkedDirectory || unlinkedChapter) {
          throw new Error(
            `进入结构锁定前，请先在解锁状态关联或移除未规划的${unlinkedDirectory ? `目录“${unlinkedDirectory.title}”` : `章节“${unlinkedChapter?.title ?? "未知章节"}”`}`,
          );
        }
      }
      const existingDirectoryByNarrativeId = new Map(
        project.chapterIndex.directories
          .filter((item) => item.narrativeDirectoryId)
          .map((item) => [item.narrativeDirectoryId!, item]),
      );
      const directoryIdByNarrativeId = new Map<string, string>();
      narrative.library.directories.forEach((directory) => {
        directoryIdByNarrativeId.set(
          directory.id,
          existingDirectoryByNarrativeId.get(directory.id)?.id ??
            `directory-narrative-${directory.id}`,
        );
      });
      const lockedRootDirectoryId =
        narrative.library.directories
          .filter((directory) => directory.parentId === null)
          .sort((left, right) => left.order - right.order)
          .map((directory) => directoryIdByNarrativeId.get(directory.id))
          .find((directoryId): directoryId is string => Boolean(directoryId)) ??
        null;
      if (
        effectiveMode === "locked" &&
        narrative.library.chapters.some((chapter) => !chapter.directoryId) &&
        !lockedRootDirectoryId
      ) {
        throw new Error("剧情工程中存在未归属卷目录的章节，无法锁定正文结构");
      }
      const syncedDirectories: ManuscriptDirectory[] =
        narrative.library.directories.map((directory) => ({
          id: directoryIdByNarrativeId.get(directory.id)!,
          parentId: directory.parentId
            ? (directoryIdByNarrativeId.get(directory.parentId) ?? null)
            : null,
          kind: narrativeDirectoryKind(directory),
          title: directory.title,
          order: directory.order,
          narrativeDirectoryId: directory.id,
        }));
      const manualDirectories = project.chapterIndex.directories.filter(
        (directory) => !directory.narrativeDirectoryId,
      );
      const finalDirectoryIds = new Set([
        ...manualDirectories.map((directory) => directory.id),
        ...syncedDirectories.map((directory) => directory.id),
      ]);
      const preservedManualDirectories = manualDirectories.map((directory) =>
        directory.parentId && !finalDirectoryIds.has(directory.parentId)
          ? { ...directory, parentId: null }
          : directory,
      );

      const existingByNarrativeId = new Map(
        project.chapterIndex.chapters
          .filter((chapter) => chapter.narrativeChapterId)
          .map((chapter) => [chapter.narrativeChapterId!, chapter]),
      );
      const existingById = new Map(
        project.chapterIndex.chapters.map((chapter) => [chapter.id, chapter]),
      );
      const links = new Map<string, string>();
      const usedChapterIds = new Set<string>();
      const syncedChapters: NovelChapterRecord[] = [];
      const createdRecords: NovelChapterRecord[] = [];
      let nextChapterNumber = project.chapterIndex.nextChapterNumber;
      let nextNarrativeDisplayNumber = nextDisplayNumber(
        project.chapterIndex.chapters,
        "narrative",
      );

      orderManuscriptChapters(
        narrative.library.directories,
        narrative.library.chapters,
      ).forEach((plan) => {
        const linkedByPlan = plan.manuscriptChapterId
          ? existingById.get(plan.manuscriptChapterId)
          : undefined;
        // 剧情工程侧的声明优先：plan 显式选择“暂不关联正文”（null）时，
        // 不采用正文侧旧关联兜底，使取消关联在同步后真正解除双向链接。
        // locked 模式由剧情工程完全驱动，正文侧不可改关联，保留兜底。
        const existing =
          linkedByPlan ??
          (effectiveMode !== "locked" && plan.manuscriptChapterId === null
            ? undefined
            : existingByNarrativeId.get(plan.id));
        // 显式取消关联的规划不参与正文同步：既不保留旧关联，也不创建新章节。
        if (!existing && effectiveMode !== "locked" && plan.manuscriptChapterId === null) {
          return;
        }
        let record: NovelChapterRecord;
        if (existing && !usedChapterIds.has(existing.id)) {
          record = {
            ...existing,
            title: effectiveMode === "locked" ? plan.title : existing.title,
            directoryId: plan.directoryId
              ? (directoryIdByNarrativeId.get(plan.directoryId) ?? null)
              : effectiveMode === "locked"
                ? lockedRootDirectoryId
                : null,
            order: plan.order,
            narrativeChapterId: plan.id,
            planningMode: existing.planningMode,
          };
        } else {
          const number = nextChapterNumber++;
          const serial = String(number).padStart(6, "0");
          record = {
            id: `chapter-${serial}`,
            number,
            displayNumber: nextNarrativeDisplayNumber++,
            title: plan.title,
            path: `manuscript/chapters/${serial}.md`,
            status: narrativeChapterStatus(plan),
            directoryId: plan.directoryId
              ? (directoryIdByNarrativeId.get(plan.directoryId) ?? null)
              : effectiveMode === "locked"
                ? lockedRootDirectoryId
                : null,
            order: plan.order,
            narrativeChapterId: plan.id,
            planningMode: "reference",
            trackingStatus: "idle",
            lastTrackedAt: null,
          };
          createdRecords.push(record);
        }
        usedChapterIds.add(record.id);
        links.set(plan.id, record.id);
        syncedChapters.push(record);
      });

      const narrativeChapterIds = new Set(
        narrative.library.chapters.map((plan) => plan.id),
      );
      const removedLockedChapters =
        effectiveMode === "locked"
          ? project.chapterIndex.chapters.filter(
              (chapter) => !usedChapterIds.has(chapter.id),
            )
          : [];
      const lockedDeletions: {
        readonly chapter: LoadedNovelChapter;
        readonly deleted: DeletedNovelChapter;
      }[] = [];
      try {
        for (const record of removedLockedChapters) {
          const chapter = project.chapters.find(
            (item) => item.id === record.id,
          );
          if (!chapter) throw new Error(`无法读取待归档正文：${record.title}`);
          const rollbackBatchIds = await trackingRepository.revertChapter(
            chapter.id,
          );
          const deletionId = createStableId("deletion");
          const trashPath = `${CHAPTER_TRASH_ROOT}/${deletionId}/${chapterFileName(chapter.number)}`;
          lockedDeletions.push({
            chapter,
            deleted: {
              deletionId,
              deletedAt: new Date().toISOString(),
              id: chapter.id,
              number: chapter.number,
              displayNumber: chapter.displayNumber,
              title: chapter.title,
              status: chapter.status,
              directoryId: chapter.directoryId,
              order: chapter.order,
              narrativeChapterId: chapter.narrativeChapterId,
              planningMode: chapter.planningMode,
              trackingStatus: chapter.trackingStatus,
              lastTrackedAt: chapter.lastTrackedAt,
              originalPath: chapter.path,
              trashPath,
              rollbackBatchIds: [...rollbackBatchIds],
            },
          });
        }
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        for (const item of [...lockedDeletions].reverse()) {
          await trackingRepository
            .restoreBatches(item.deleted.rollbackBatchIds)
            .catch((cause) => recoveryErrors.push(cause));
        }
        throwWithRecovery(error, recoveryErrors);
      }
      const unlinkedChapters =
        effectiveMode === "locked"
          ? []
          : project.chapterIndex.chapters
              .filter((chapter) => !usedChapterIds.has(chapter.id))
              .map((chapter) => ({
                ...chapter,
                directoryId:
                  chapter.directoryId &&
                  finalDirectoryIds.has(chapter.directoryId)
                    ? chapter.directoryId
                    : null,
                // 仅当对应章节规划仍然指向该正文时才保留双向关联，否则清空，
                // 避免剧情工程侧换绑后正文侧残留旧关联造成双向不一致。
                narrativeChapterId:
                  chapter.narrativeChapterId &&
                  narrativeChapterIds.has(chapter.narrativeChapterId) &&
                  narrative.library.chapters.some(
                    (plan) =>
                      plan.id === chapter.narrativeChapterId &&
                      plan.manuscriptChapterId === chapter.id,
                  )
                    ? chapter.narrativeChapterId
                    : null,
              }));
      let directoriesForNext = [
        ...preservedManualDirectories,
        ...syncedDirectories,
      ];
      let chaptersForNext = [...syncedChapters, ...unlinkedChapters];
      const hasRootChapter = chaptersForNext.some(
        (chapter) => chapter.directoryId === null,
      );
      if (hasRootChapter) {
        if (effectiveMode === "locked") {
          throw new Error("结构锁定后，每章正文都必须归属剧情工程目录");
        }
        let freeContentDirectory = directoriesForNext.find(
          (directory) => directory.id === FREE_CONTENT_DIRECTORY_ID,
        );
        if (!freeContentDirectory) {
          freeContentDirectory = {
            id: FREE_CONTENT_DIRECTORY_ID,
            parentId: null,
            kind: "folder",
            title: "自由内容",
            order: directoriesForNext.filter(
              (directory) => directory.parentId === null,
            ).length,
            narrativeDirectoryId: null,
          };
          directoriesForNext = [...directoriesForNext, freeContentDirectory];
        }
        chaptersForNext = chaptersForNext.map((chapter) =>
          chapter.directoryId
            ? chapter
            : {
                ...chapter,
                directoryId: freeContentDirectory!.id,
              },
        );
      }
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        nextChapterNumber,
        // 保留调用方声明的结构模式（自动同步传磁盘原值时，legacy free 不被改写）。
        structureMode: mode,
        directories: normalizeDirectoryOrders(directoriesForNext),
        chapters: normalizeChapterOrders(chaptersForNext),
        trash: [
          ...lockedDeletions.map((item) => item.deleted),
          ...project.chapterIndex.trash,
        ],
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      const createdPaths: string[] = [];
      const movedLockedDeletions: (typeof lockedDeletions)[number][] = [];
      const restoreLockedDeletions = async (errors: unknown[]) => {
        for (const item of [...movedLockedDeletions].reverse()) {
          await restoreMovedFile(
            item.deleted.trashPath,
            "manuscript/chapters",
            item.deleted.originalPath,
            item.chapter.content,
          ).catch((cause) => errors.push(cause));
        }
        for (const item of [...lockedDeletions].reverse()) {
          await trackingRepository
            .restoreBatches(item.deleted.rollbackBatchIds)
            .catch((cause) => errors.push(cause));
        }
      };
      try {
        for (const item of lockedDeletions) {
          await storage.createDirectory(
            `${CHAPTER_TRASH_ROOT}/${item.deleted.deletionId}`,
          );
          await moveFile(
            item.chapter.path,
            `${CHAPTER_TRASH_ROOT}/${item.deleted.deletionId}`,
            "严格同步归档正文失败",
          );
          movedLockedDeletions.push(item);
        }
        for (const record of createdRecords) {
          await storage.createText(record.path, "", { createParents: true });
          createdPaths.push(record.path);
        }
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        await Promise.all(
          createdPaths.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
        await restoreLockedDeletions(recoveryErrors);
        throwWithRecovery(error, recoveryErrors);
      }
      let indexCommitted = false;
      try {
        if (nextIndexContent !== project.chapterIndexContent) {
          await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
            expectedContent: project.chapterIndexContent,
          });
          indexCommitted = true;
        }
        await trackingRepository.reorderAppliedBatches(
          project.chapterIndex,
          nextIndex,
        );
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        if (
          indexCommitted &&
          !(await rollbackIndex(project, nextIndexContent))
        ) {
          recoveryErrors.push(new Error("正文结构索引未能回滚"));
        }
        await Promise.all(
          createdPaths.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
        await restoreLockedDeletions(recoveryErrors);
        throwWithRecovery(error, recoveryErrors);
      }
      let narrativeCommitted = false;
      try {
        const nextNarrative = replaceNarrativeChapterLinks(
          narrative.library,
          links,
        );
        if (
          JSON.stringify(nextNarrative) !== JSON.stringify(narrative.library)
        ) {
          await narrativeRepository.save(narrative, nextNarrative);
          narrativeCommitted = true;
        }
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        await trackingRepository
          .reorderAppliedBatches(nextIndex, project.chapterIndex)
          .catch((cause) => recoveryErrors.push(cause));
        if (recoveryErrors.length) {
          throwWithRecovery(error, recoveryErrors);
        }
        const indexRolledBack = await rollbackIndex(project, nextIndexContent);
        if (!indexRolledBack) {
          await trackingRepository
            .reorderAppliedBatches(project.chapterIndex, nextIndex)
            .catch(() => undefined);
          throw new Error(
            `${errorText(error)}；同步后的正文索引已提交且无法自动回滚，请重新加载后检查剧情关联`,
          );
        }
        await Promise.all(
          createdPaths.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
        await restoreLockedDeletions(recoveryErrors);
        throwWithRecovery(error, recoveryErrors);
      }
      // reorderAppliedBatches 仅在章节顺序表变化时写盘，而顺序变化必然伴随
      // 索引内容变化，因此 indexCommitted 已覆盖该写入，无需单独跟踪。
      return Object.freeze({
        changed:
          indexCommitted ||
          narrativeCommitted ||
          createdPaths.length > 0 ||
          movedLockedDeletions.length > 0,
      });
    },

    async saveTypography(project, typography) {
      return writeIndex(project, { ...project.chapterIndex, typography });
    },

    async deleteChapter(project, chapterId, expectedContent) {
      assertMutableStructure(project);
      const chapter = project.chapters.find((item) => item.id === chapterId);
      if (!chapter) throw new Error(`章节不存在：${chapterId}`);
      await storage.writeText(chapter.path, chapter.content, {
        expectedContent,
      });
      const rollbackBatchIds =
        await trackingRepository.revertChapter(chapterId);
      const deletionId = createStableId("deletion");
      const trashDirectory = `${CHAPTER_TRASH_ROOT}/${deletionId}`;
      const trashPath = `${trashDirectory}/${chapterFileName(chapter.number)}`;
      try {
        await storage.createDirectory(trashDirectory);
        await moveFile(chapter.path, trashDirectory, "章节移入回收站失败");
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        await restoreMovedFile(
          trashPath,
          "manuscript/chapters",
          chapter.path,
          chapter.content,
        ).catch((cause) => recoveryErrors.push(cause));
        await trackingRepository
          .restoreBatches(rollbackBatchIds)
          .catch((cause) => recoveryErrors.push(cause));
        throwWithRecovery(error, recoveryErrors);
      }
      const deleted: DeletedNovelChapter = {
        deletionId,
        deletedAt: new Date().toISOString(),
        id: chapter.id,
        number: chapter.number,
        displayNumber: chapter.displayNumber,
        title: chapter.title,
        status: chapter.status,
        directoryId: chapter.directoryId,
        order: chapter.order,
        narrativeChapterId: chapter.narrativeChapterId,
        planningMode: chapter.planningMode,
        trackingStatus: chapter.trackingStatus,
        lastTrackedAt: chapter.lastTrackedAt,
        originalPath: chapter.path,
        trashPath,
        rollbackBatchIds: [...rollbackBatchIds],
      };
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        chapters: normalizeChapterOrders(
          project.chapterIndex.chapters.filter((item) => item.id !== chapterId),
        ),
        trash: [deleted, ...project.chapterIndex.trash],
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      let indexCommitted = false;
      try {
        await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
          expectedContent: project.chapterIndexContent,
        });
        indexCommitted = true;
        await trackingRepository.reorderAppliedBatches(
          project.chapterIndex,
          nextIndex,
        );
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        if (
          indexCommitted &&
          !(await rollbackIndex(project, nextIndexContent))
        ) {
          throw new Error(
            `${errorText(error)}；章节删除索引已提交且无法自动回滚，请重新加载后检查状态顺序`,
          );
        }
        await restoreMovedFile(
          trashPath,
          "manuscript/chapters",
          chapter.path,
          chapter.content,
        ).catch((cause) => recoveryErrors.push(cause));
        await trackingRepository
          .restoreBatches(rollbackBatchIds)
          .catch((cause) => recoveryErrors.push(cause));
        throwWithRecovery(error, recoveryErrors);
      }

      if (chapter.narrativeChapterId) {
        try {
          const currentNarrative = await narrativeRepository.load();
          if (
            currentNarrative.library.chapters.some(
              (plan) =>
                plan.id === chapter.narrativeChapterId &&
                plan.manuscriptChapterId === chapter.id,
            )
          ) {
            await narrativeRepository.save(currentNarrative, {
              ...currentNarrative.library,
              chapters: currentNarrative.library.chapters.map((plan) =>
                plan.id === chapter.narrativeChapterId
                  ? { ...plan, manuscriptChapterId: null }
                  : plan,
              ),
            });
          }
        } catch (error) {
          const recoveryErrors: unknown[] = [];
          await trackingRepository
            .reorderAppliedBatches(nextIndex, project.chapterIndex)
            .catch((cause) => recoveryErrors.push(cause));
          if (recoveryErrors.length) {
            throwWithRecovery(error, recoveryErrors);
          }
          const indexRolledBack = await rollbackIndex(
            project,
            nextIndexContent,
          );
          if (!indexRolledBack) {
            await trackingRepository
              .reorderAppliedBatches(project.chapterIndex, nextIndex)
              .catch(() => undefined);
            throw new Error(
              `${errorText(error)}；章节删除已提交且无法自动回滚，请重新加载后修复剧情关联`,
            );
          }
          await restoreMovedFile(
            trashPath,
            "manuscript/chapters",
            chapter.path,
            chapter.content,
          ).catch((cause) => recoveryErrors.push(cause));
          await trackingRepository
            .restoreBatches(rollbackBatchIds)
            .catch((cause) => recoveryErrors.push(cause));
          throwWithRecovery(error, recoveryErrors);
        }
      }
    },

    async restoreChapter(project, deletionId) {
      assertMutableStructure(project);
      const deleted = project.chapterIndex.trash.find(
        (item) => item.deletionId === deletionId,
      );
      if (!deleted) throw new Error("回收站记录不存在");
      const [targetInfo] = await storage.stat([deleted.originalPath]);
      if (targetInfo?.exists) throw new Error("原章节路径已被占用，无法恢复");
      const trashFile = await storage.readText(deleted.trashPath);
      const currentNarrative = deleted.narrativeChapterId
        ? await narrativeRepository.load()
        : null;
      const narrativePlan = deleted.narrativeChapterId
        ? currentNarrative?.library.chapters.find(
            (plan) => plan.id === deleted.narrativeChapterId,
          )
        : undefined;
      const canRestoreNarrativeLink = Boolean(
        narrativePlan &&
          (!narrativePlan.manuscriptChapterId ||
            narrativePlan.manuscriptChapterId === deleted.id),
      );
      const restoreFileToTrash = () =>
        restoreMovedFile(
          deleted.originalPath,
          `${CHAPTER_TRASH_ROOT}/${deletionId}`,
          deleted.trashPath,
          trashFile.content,
        );
      const restoredNarrativeChapterId = canRestoreNarrativeLink
        ? deleted.narrativeChapterId
        : null;
      const restoredScope = restoredNarrativeChapterId ? "narrative" : "free";
      const restoredDisplayNumber = project.chapterIndex.chapters.some(
        (chapter) =>
          chapterDisplayScope(chapter) === restoredScope &&
          chapter.displayNumber === deleted.displayNumber,
      )
        ? nextDisplayNumber(project.chapterIndex.chapters, restoredScope)
        : deleted.displayNumber;
      const restored: NovelChapterRecord = {
        id: deleted.id,
        number: deleted.number,
        displayNumber: restoredDisplayNumber,
        title: deleted.title,
        path: deleted.originalPath,
        status: deleted.status,
        directoryId: project.chapterIndex.directories.some(
          (directory) => directory.id === deleted.directoryId,
        )
          ? deleted.directoryId
          : null,
        order: deleted.order,
        narrativeChapterId: restoredNarrativeChapterId,
        planningMode: deleted.planningMode,
        trackingStatus: deleted.trackingStatus,
        lastTrackedAt: deleted.lastTrackedAt,
      };
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        chapters: normalizeChapterOrders([
          ...project.chapterIndex.chapters,
          restored,
        ]),
        trash: project.chapterIndex.trash.filter(
          (item) => item.deletionId !== deletionId,
        ),
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      try {
        await moveFile(
          deleted.trashPath,
          "manuscript/chapters",
          "章节恢复失败",
        );
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        await restoreFileToTrash().catch((cause) => recoveryErrors.push(cause));
        throwWithRecovery(error, recoveryErrors);
      }
      let indexCommitted = false;
      try {
        await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
          expectedContent: project.chapterIndexContent,
        });
        indexCommitted = true;
        await trackingRepository.reorderAppliedBatches(
          project.chapterIndex,
          nextIndex,
        );
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        if (
          indexCommitted &&
          !(await rollbackIndex(project, nextIndexContent))
        ) {
          throw new Error(
            `${errorText(error)}；章节恢复索引已提交且无法自动回滚，请重新加载后检查状态顺序`,
          );
        }
        await restoreFileToTrash().catch((cause) => recoveryErrors.push(cause));
        throwWithRecovery(error, recoveryErrors);
      }
      try {
        await trackingRepository.restoreBatches(deleted.rollbackBatchIds);
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        await trackingRepository
          .reorderAppliedBatches(nextIndex, project.chapterIndex)
          .catch((cause) => recoveryErrors.push(cause));
        if (recoveryErrors.length) {
          throwWithRecovery(error, recoveryErrors);
        }
        if (!(await rollbackIndex(project, nextIndexContent))) {
          await trackingRepository
            .reorderAppliedBatches(project.chapterIndex, nextIndex)
            .catch(() => undefined);
          throw new Error(
            `${errorText(error)}；章节索引已恢复但状态批次失败，且索引无法自动回滚`,
          );
        }
        await restoreFileToTrash().catch((cause) => recoveryErrors.push(cause));
        throwWithRecovery(error, recoveryErrors);
      }
      if (
        restored.narrativeChapterId &&
        currentNarrative &&
        narrativePlan?.manuscriptChapterId !== restored.id
      ) {
        try {
          await narrativeRepository.save(currentNarrative, {
            ...currentNarrative.library,
            chapters: currentNarrative.library.chapters.map((item) => ({
              ...item,
              manuscriptChapterId:
                item.id === restored.narrativeChapterId
                  ? restored.id
                  : item.manuscriptChapterId === restored.id
                    ? null
                    : item.manuscriptChapterId,
            })),
          });
        } catch (error) {
          const recoveryErrors: unknown[] = [];
          try {
            await trackingRepository.revertBatches(deleted.rollbackBatchIds);
          } catch (cause) {
            throwWithRecovery(error, [cause]);
          }
          try {
            await trackingRepository.reorderAppliedBatches(
              nextIndex,
              project.chapterIndex,
            );
          } catch (cause) {
            recoveryErrors.push(cause);
            await trackingRepository
              .restoreBatches(deleted.rollbackBatchIds)
              .catch((restoreCause) => recoveryErrors.push(restoreCause));
            throwWithRecovery(error, recoveryErrors);
          }
          const indexRolledBack = await rollbackIndex(
            project,
            nextIndexContent,
          );
          if (!indexRolledBack) {
            await trackingRepository
              .reorderAppliedBatches(project.chapterIndex, nextIndex)
              .catch((cause) => recoveryErrors.push(cause));
            await trackingRepository
              .restoreBatches(deleted.rollbackBatchIds)
              .catch((cause) => recoveryErrors.push(cause));
            throwWithRecovery(
              new Error(
                `${errorText(error)}；章节恢复已提交且索引无法自动回滚，请重新加载后检查剧情关联`,
              ),
              recoveryErrors,
            );
          }
          await restoreFileToTrash().catch((cause) =>
            recoveryErrors.push(cause),
          );
          throwWithRecovery(error, recoveryErrors);
        }
      }
    },

    async saveChapter(chapter, content, expectedContent) {
      await storage.writeText(chapter.path, content, { expectedContent });
      return Object.freeze({
        ...chapter,
        content,
        words: countNovelWords(content),
      });
    },

    async deleteChapterPermanently(project, deletionId) {
      const deleted = project.chapterIndex.trash.find(
        (item) => item.deletionId === deletionId,
      );
      if (!deleted) throw new Error("回收站记录不存在");
      // 先移除回收站记录（CAS 保护），成功后再删文件；
      // 索引失败时文件未动，删除不产生不一致状态。
      const nextIndex: NovelChapterIndex = {
        ...project.chapterIndex,
        trash: project.chapterIndex.trash.filter(
          (item) => item.deletionId !== deletionId,
        ),
      };
      const nextIndexContent = serializeNovelChapterIndex(nextIndex);
      await storage.writeText(CHAPTER_INDEX_PATH, nextIndexContent, {
        expectedContent: project.chapterIndexContent,
      });
      // 删除正文文件与回收站目录
      await storage
        .remove(deleted.trashPath, { permanent: true })
        .catch(() => false);
      await storage
        .remove(`manuscript/trash/${deletionId}`, { permanent: true })
        .catch(() => false);
      // 顺带清理该章的历史版本（否则成为孤儿数据）
      const versionDirectory = `manuscript/versions/${deleted.id}`;
      const entries = await storage
        .list(versionDirectory)
        .catch(() => [] as readonly WorkbenchStorageEntry[]);
      await Promise.all(
        entries
          .filter((entry) => entry.kind === "file")
          .map((entry) =>
            storage.remove(entry.path, { permanent: true }).catch(() => false),
          ),
      );
      await storage
        .remove(versionDirectory, { permanent: true })
        .catch(() => false);
      return Object.freeze({
        chapterIndex: nextIndex,
        chapterIndexContent: nextIndexContent,
      });
    },
  };
  return Object.freeze(repository);
}
