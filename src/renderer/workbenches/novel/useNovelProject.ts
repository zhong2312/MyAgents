import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelRepository,
  type CreateNovelChapterOptions,
  type LoadedNovelChapter,
  type LoadedNovelProject,
  type NovelRepository,
  type UpdateNovelProjectSettingsInput,
  type UpdateNovelChapterInput,
} from "./repository";
import { createNarrativeEngineeringRepository } from "./narrativeEngineeringRepository";
import { createManuscriptVersionRepository } from "./manuscriptVersionRepository";
import type {
  ManuscriptVersionRecord,
  ManuscriptVersionSettings,
} from "./manuscriptVersionSchema";
import {
  orderManuscriptChapters,
  type ManuscriptDirectoryKind,
  type ManuscriptStructureMode,
  type ManuscriptTypography,
} from "./projectSchema";

export interface NovelProjectController {
  readonly project: LoadedNovelProject | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isCreatingChapter: boolean;
  saveProjectSettings(input: UpdateNovelProjectSettingsInput): Promise<void>;
  saveKnowledgeGraphEnabled(enabled: boolean): Promise<void>;
  reload(): Promise<LoadedNovelProject | null>;
  createChapter(options?: CreateNovelChapterOptions): Promise<string>;
  updateChapter(
    chapterId: string,
    input: UpdateNovelChapterInput,
  ): Promise<void>;
  renameChapter(chapterId: string, title: string): Promise<void>;
  linkChapterToNarrative(
    chapterId: string,
    narrativeChapterId: string | null,
  ): Promise<void>;
  createDirectory(
    parentId: string | null,
    kind: ManuscriptDirectoryKind,
    title: string,
  ): Promise<string>;
  updateDirectory(
    directoryId: string,
    input: {
      readonly title?: string;
      readonly parentId?: string | null;
      readonly kind?: ManuscriptDirectoryKind;
      readonly order?: number;
      readonly narrativeDirectoryId?: string | null;
    },
  ): Promise<void>;
  deleteDirectory(directoryId: string): Promise<void>;
  setStructureMode(mode: ManuscriptStructureMode): Promise<void>;
  synchronizeNarrative(): Promise<void>;
  saveTypography(typography: ManuscriptTypography): Promise<void>;
  deleteChapter(chapterId: string, expectedContent: string): Promise<void>;
  restoreChapter(deletionId: string): Promise<void>;
  deleteChapterPermanently(deletionId: string): Promise<void>;
  saveChapter(
    chapterId: string,
    content: string,
    expectedContent: string,
  ): Promise<void>;
  loadManuscriptVersions(
    chapterId: string,
  ): Promise<readonly ManuscriptVersionRecord[]>;
  loadManuscriptVersionSettings(): Promise<ManuscriptVersionSettings>;
  saveManuscriptVersionLimit(maxVersions: number): Promise<void>;
  restoreManuscriptVersion(chapterId: string, versionId: string): Promise<void>;
  extractChaptersToNarrative(input: {
    readonly extractions: readonly {
      readonly chapterId: string;
      readonly targetNarrativeChapterId: string | null;
      readonly title: string;
      readonly description: string;
      readonly sections: readonly {
        readonly title: string;
        readonly description: string;
      }[];
    }[];
  }): Promise<void>;
  adoptSimulationPath(input: {
    readonly title: string;
    readonly description: string;
    readonly premise: string;
    readonly sourceChapterPlanId: string | null;
    readonly sourceManuscriptChapterId: string | null;
    readonly agentRole: string;
    readonly coherence: number;
    readonly novelty: number;
    readonly risk: number;
    readonly riskLevel: "low" | "medium" | "high";
    readonly tags: readonly string[];
    readonly nodes: readonly {
      readonly offset: number;
      readonly title: string;
      readonly summary: string;
      readonly checkpoint: string;
    }[];
  }): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createProposalId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `simulation-proposal-${random.toLowerCase()}`;
}

function createNarrativeChapterId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `narrative-chapter-${random.toLowerCase()}`;
}

function createNarrativeSectionId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `narrative-section-${random.toLowerCase()}`;
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function useNovelProject(
  storage: WorkbenchStorage,
  isActive: boolean,
): NovelProjectController {
  const repository = useMemo(() => createNovelRepository(storage), [storage]);
  const versionRepository = useMemo(
    () => createManuscriptVersionRepository(storage),
    [storage],
  );
  const [project, setProject] = useState<LoadedNovelProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreatingChapter, setIsCreatingChapter] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (background: boolean): Promise<LoadedNovelProject | null> => {
      const requestId = ++requestIdRef.current;
      if (background) setIsRefreshing(true);
      else setIsLoading(true);
      try {
        let loaded = await repository.load();
        await repository.synchronizeNarrative(
          loaded,
          loaded.chapterIndex.structureMode,
        );
        loaded = await repository.load();
        if (requestId !== requestIdRef.current) return null;
        setProject(loaded);
        setError(null);
        return loaded;
      } catch (cause) {
        if (requestId === requestIdRef.current) setError(errorMessage(cause));
        return null;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [repository],
  );

  const reload = useCallback(() => load(project !== null), [load, project]);

  useEffect(() => {
    if (!isActive) return;
    void load(false);
  }, [isActive, load, storage.rootPath]);

  useEffect(() => {
    if (!isActive || !storage.isAvailable) return;
    let disposed = false;
    let refreshTimer: number | undefined;
    let refreshRunning = false;
    let refreshQueued = false;
    let subscription:
      | Awaited<ReturnType<WorkbenchStorage["watch"]>>
      | undefined;
    const refresh = async () => {
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }
      refreshRunning = true;
      setIsRefreshing(true);
      try {
        let loaded = await repository.load();
        await repository.synchronizeNarrative(
          loaded,
          loaded.chapterIndex.structureMode,
        );
        loaded = await repository.load();
        if (!disposed) {
          setProject(loaded);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause));
      } finally {
        refreshRunning = false;
        if (!disposed) setIsRefreshing(false);
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void refresh(), 150);
        }
      }
    };
    void storage
      .watch(() => {
        if (disposed) return;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void refresh();
        }, 150);
      })
      .then((value) => {
        if (disposed) void value.dispose();
        else subscription = value;
      })
      .catch((cause) => {
        if (!disposed)
          console.warn("[NovelWorkbench] File watch unavailable:", cause);
      });
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      if (subscription) void subscription.dispose();
    };
  }, [isActive, repository, storage]);

  const createChapter = useCallback(
    async (options?: CreateNovelChapterOptions): Promise<string> => {
      if (!project) throw new Error("小说项目尚未加载");
      setIsCreatingChapter(true);
      try {
        const chapter = await repository.createChapter(project, options);
        const loaded = await load(true);
        if (!loaded) throw new Error("章节已创建，但项目重新加载失败");
        return chapter.id;
      } finally {
        setIsCreatingChapter(false);
      }
    },
    [load, project, repository],
  );

  const updateChapter = useCallback(
    async (chapterId: string, input: UpdateNovelChapterInput) => {
      if (!project) throw new Error("小说项目尚未加载");
      const updated = await repository.updateChapter(project, chapterId, input);
      // 正文状态变更回流剧情工程：保持章计划状态与正文一致，
      // 消除"正文已写完但剧情工程仍显示规划中"的断点。
      const record = updated.chapterIndex.chapters.find(
        (chapter) => chapter.id === chapterId,
      );
      if (input.status && record?.narrativeChapterId) {
        const planStatus =
          input.status === "complete"
            ? ("complete" as const)
            : input.status === "planned"
              ? ("planned" as const)
              : ("drafting" as const);
        const narrativeRepository = createNarrativeEngineeringRepository(
          storage,
        );
        const currentNarrative = await narrativeRepository.load();
        const targetPlan = currentNarrative.library.chapters.find(
          (plan) => plan.id === record.narrativeChapterId,
        );
        if (targetPlan && targetPlan.status !== planStatus) {
          await narrativeRepository.save(currentNarrative, {
            ...currentNarrative.library,
            chapters: currentNarrative.library.chapters.map((plan) =>
              plan.id === record.narrativeChapterId
                ? { ...plan, status: planStatus, updatedAt: new Date().toISOString() }
                : plan,
            ),
          });
        }
      }
      if (await load(true)) return;
      setProject((current) => {
        if (
          !current ||
          !record ||
          current.chapterIndexContent !== project.chapterIndexContent
        )
          return current;
        const chapters = current.chapters.map((chapter) =>
          chapter.id === chapterId ? { ...chapter, ...record } : chapter,
        );
        return Object.freeze({
          ...current,
          chapterIndex: updated.chapterIndex,
          chapterIndexContent: updated.chapterIndexContent,
          chapters: Object.freeze(
            orderManuscriptChapters(updated.chapterIndex.directories, chapters),
          ),
        });
      });
    },
    [load, project, repository, storage],
  );

  const renameChapter = useCallback(
    async (chapterId: string, title: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.renameChapter(project, chapterId, title);
      if (!(await load(true))) {
        throw new Error("章节标题已更新，但项目重新加载失败");
      }
    },
    [load, project, repository],
  );

  const linkChapterToNarrative = useCallback(
    async (chapterId: string, narrativeChapterId: string | null) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.linkChapterToNarrative(
        project,
        chapterId,
        narrativeChapterId,
      );
      if (!(await load(true))) throw new Error("正文关联后重新加载失败");
    },
    [load, project, repository],
  );

  const createDirectory = useCallback(
    async (
      parentId: string | null,
      kind: ManuscriptDirectoryKind,
      title: string,
    ) => {
      if (!project) throw new Error("小说项目尚未加载");
      const directory = await repository.createDirectory(
        project,
        parentId,
        kind,
        title,
      );
      if (!(await load(true))) throw new Error("目录创建后重新加载失败");
      return directory.id;
    },
    [load, project, repository],
  );

  const updateDirectory = useCallback(
    async (
      directoryId: string,
      input: {
        readonly title?: string;
        readonly parentId?: string | null;
        readonly kind?: ManuscriptDirectoryKind;
        readonly order?: number;
        readonly narrativeDirectoryId?: string | null;
      },
    ) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.updateDirectory(project, directoryId, input);
      if (!(await load(true))) throw new Error("目录更新后重新加载失败");
    },
    [load, project, repository],
  );

  const deleteDirectory = useCallback(
    async (directoryId: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.deleteDirectory(project, directoryId);
      if (!(await load(true))) throw new Error("目录删除后重新加载失败");
    },
    [load, project, repository],
  );

  const setStructureMode = useCallback(
    async (mode: ManuscriptStructureMode) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.setStructureMode(project, mode);
      if (!(await load(true))) throw new Error("结构设置更新后重新加载失败");
    },
    [load, project, repository],
  );

  const synchronizeNarrative = useCallback(async () => {
    if (!project) throw new Error("小说项目尚未加载");
    await repository.synchronizeNarrative(project);
    if (!(await load(true))) throw new Error("剧情结构同步后重新加载失败");
  }, [load, project, repository]);

  const saveTypography = useCallback(
    async (typography: ManuscriptTypography) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.saveTypography(project, typography);
      if (!(await load(true))) throw new Error("排版保存后重新加载失败");
    },
    [load, project, repository],
  );

  const deleteChapter = useCallback(
    async (chapterId: string, expectedContent: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.deleteChapter(project, chapterId, expectedContent);
      if (!(await load(true))) throw new Error("章节删除后重新加载失败");
    },
    [load, project, repository],
  );

  const restoreChapter = useCallback(
    async (deletionId: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.restoreChapter(project, deletionId);
      if (!(await load(true))) throw new Error("章节恢复后重新加载失败");
    },
    [load, project, repository],
  );

  const deleteChapterPermanently = useCallback(
    async (deletionId: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      await repository.deleteChapterPermanently(project, deletionId);
      if (!(await load(true))) throw new Error("章节彻底删除后重新加载失败");
    },
    [load, project, repository],
  );

  const saveChapter = useCallback(
    async (chapterId: string, content: string, expectedContent: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      const chapter = project.chapters.find((item) => item.id === chapterId);
      if (!chapter) throw new Error(`章节不存在：${chapterId}`);
      const saved = await repository.saveChapter(
        chapter,
        content,
        expectedContent,
      );
      try {
        await versionRepository.create(chapter, content, "manual-save");
      } catch (cause) {
        await repository
          .saveChapter(saved, expectedContent, content)
          .catch(() => undefined);
        throw new Error(`正文已保存但历史版本创建失败：${errorMessage(cause)}`);
      }
      const trackingInvalidated =
        content !== expectedContent && chapter.trackingStatus !== "idle";
      let updatedIndex:
        | Awaited<ReturnType<NovelRepository["updateChapter"]>>
        | undefined;
      if (trackingInvalidated) {
        try {
          updatedIndex = await repository.updateChapter(project, chapterId, {
            trackingStatus: "stale",
            lastTrackedAt: null,
          });
        } catch (cause) {
          await repository
            .saveChapter(saved, expectedContent, content)
            .catch(() => undefined);
          throw cause;
        }
      }
      setProject((current) => {
        if (!current) return current;
        const nextChapter = trackingInvalidated
          ? { ...saved, trackingStatus: "stale" as const, lastTrackedAt: null }
          : saved;
        return Object.freeze({
          ...current,
          ...(updatedIndex
            ? {
                chapterIndex: updatedIndex.chapterIndex,
                chapterIndexContent: updatedIndex.chapterIndexContent,
              }
            : {}),
          chapters: Object.freeze(
            current.chapters.map(
              (item): LoadedNovelChapter =>
                item.id === chapterId ? nextChapter : item,
            ),
          ),
        });
      });
    },
    [project, repository, versionRepository],
  );

  const loadManuscriptVersions = useCallback(
    (chapterId: string) => versionRepository.list(chapterId),
    [versionRepository],
  );

  const loadManuscriptVersionSettings = useCallback(
    () => versionRepository.loadSettings(),
    [versionRepository],
  );

  const saveManuscriptVersionLimit = useCallback(
    async (maxVersions: number) => {
      await versionRepository.saveSettings(maxVersions);
    },
    [versionRepository],
  );

  const restoreManuscriptVersion = useCallback(
    async (chapterId: string, versionId: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      const chapter = project.chapters.find((item) => item.id === chapterId);
      if (!chapter) throw new Error(`章节不存在：${chapterId}`);
      const versions = await versionRepository.list(chapterId);
      const target = versions.find((item) => item.versionId === versionId);
      if (!target) throw new Error("历史版本不存在或已被清理");
      await versionRepository.restore(
        chapter,
        target,
        async (content, expected) => {
          await repository.saveChapter(chapter, content, expected);
          if (content !== expected && chapter.trackingStatus !== "idle") {
            await repository.updateChapter(project, chapterId, {
              trackingStatus: "stale",
              lastTrackedAt: null,
            });
          }
        },
      );
      if (!(await load(true))) throw new Error("版本恢复后重新加载失败");
    },
    [load, project, repository, versionRepository],
  );

  const extractChaptersToNarrative = useCallback(
    async (input: {
      readonly extractions: readonly {
        readonly chapterId: string;
        readonly targetNarrativeChapterId: string | null;
        readonly title: string;
        readonly description: string;
        readonly sections: readonly {
          readonly title: string;
          readonly description: string;
        }[];
      }[];
    }) => {
      if (!project) throw new Error("小说项目尚未加载");
      if (!input.extractions.length) throw new Error("请选择需要提炼的正文");
      const chapterIds = new Set<string>();
      input.extractions.forEach((item) => {
        if (!item.chapterId || chapterIds.has(item.chapterId)) {
          throw new Error("同一正文只能在本次抽纲中出现一次");
        }
        chapterIds.add(item.chapterId);
        if (
          !project.chapters.some((chapter) => chapter.id === item.chapterId)
        ) {
          throw new Error("待提炼正文不存在或已被删除");
        }
        if (!item.title.trim()) throw new Error("提炼后的剧情章节标题不能为空");
      });

      const narrativeRepository = createNarrativeEngineeringRepository(storage);
      const currentNarrative = await narrativeRepository.load();
      const targetIds = input.extractions
        .map((item) => item.targetNarrativeChapterId)
        .filter((id): id is string => Boolean(id));
      if (new Set(targetIds).size !== targetIds.length) {
        throw new Error("同一剧情章节不能同时接收多篇正文，请分别提炼");
      }
      const availableTargetIds = new Set(
        currentNarrative.library.chapters.map((plan) => plan.id),
      );
      if (targetIds.some((id) => !availableTargetIds.has(id))) {
        throw new Error("目标剧情章节不存在或已被删除，请重新提炼");
      }

      const sourceById = new Map(
        project.chapters.map((chapter) => [chapter.id, chapter]),
      );
      const nextPlanIdByChapter = new Map<string, string>();
      const now = new Date().toISOString();
      const updatedPlans = currentNarrative.library.chapters.map((plan) => {
        const extraction = input.extractions.find(
          (item) => item.targetNarrativeChapterId === plan.id,
        );
        if (!extraction) return plan;
        const source = sourceById.get(extraction.chapterId)!;
        if (
          plan.manuscriptChapterId &&
          plan.manuscriptChapterId !== source.id
        ) {
          throw new Error(`剧情章节“${plan.title}”已经关联其它正文`);
        }
        nextPlanIdByChapter.set(source.id, plan.id);
        return {
          ...plan,
          title: extraction.title.trim(),
          description: extraction.description.trim(),
          status:
            source.status === "complete"
              ? ("complete" as const)
              : ("drafting" as const),
          updatedAt: now,
          sections: extraction.sections
            .map((section, index) => ({
              id: createNarrativeSectionId(),
              order: index,
              title: section.title.trim() || `场景 ${index + 1}`,
              description: section.description.trim(),
              povCharacterId: null,
              lineIds: [],
              arcIds: [],
              paragraphs: [],
            }))
            .slice(0, 12),
        };
      });

      const nextOrderByDirectory = new Map<string, number>();
      const createdPlans = input.extractions.flatMap((extraction) => {
        if (extraction.targetNarrativeChapterId) return [];
        const source = sourceById.get(extraction.chapterId)!;
        const planId = createNarrativeChapterId();
        nextPlanIdByChapter.set(source.id, planId);
        const manuscriptDirectory = source.directoryId
          ? project.chapterIndex.directories.find(
              (directory) => directory.id === source.directoryId,
            )
          : undefined;
        const narrativeDirectoryId =
          manuscriptDirectory?.narrativeDirectoryId ?? null;
        const directoryKey = narrativeDirectoryId ?? "root";
        const order =
          nextOrderByDirectory.get(directoryKey) ??
          currentNarrative.library.chapters.filter(
            (plan) => plan.directoryId === narrativeDirectoryId,
          ).length;
        nextOrderByDirectory.set(directoryKey, order + 1);
        return [
          {
            id: planId,
            directoryId: narrativeDirectoryId,
            manuscriptChapterId: null,
            title: extraction.title.trim(),
            description: extraction.description.trim(),
            status:
              source.status === "complete"
                ? ("complete" as const)
                : ("drafting" as const),
            order,
            updatedAt: now,
            lineIds: [],
            arcIds: [],
            sections: extraction.sections
              .map((section, index) => ({
                id: createNarrativeSectionId(),
                order: index,
                title: section.title.trim() || `场景 ${index + 1}`,
                description: section.description.trim(),
                povCharacterId: null,
                lineIds: [],
                arcIds: [],
                paragraphs: [],
              }))
              .slice(0, 12),
          },
        ];
      });

      await narrativeRepository.save(currentNarrative, {
        ...currentNarrative.library,
        chapters: [...updatedPlans, ...createdPlans],
      });

      let workingProject = project;
      for (const extraction of input.extractions) {
        const narrativeChapterId = nextPlanIdByChapter.get(
          extraction.chapterId,
        );
        if (!narrativeChapterId) {
          throw new Error("剧情章节提炼失败，未生成关联目标");
        }
        await repository.linkChapterToNarrative(
          workingProject,
          extraction.chapterId,
          narrativeChapterId,
        );
        workingProject = await repository.load();
      }
      if (!(await load(true)))
        throw new Error("正文已提炼，但项目重新加载失败");
    },
    [load, project, repository, storage],
  );

  const adoptSimulationPath = useCallback(
    async (input: {
      readonly title: string;
      readonly description: string;
      readonly premise: string;
      readonly sourceChapterPlanId: string | null;
      readonly sourceManuscriptChapterId: string | null;
      readonly agentRole: string;
      readonly coherence: number;
      readonly novelty: number;
      readonly risk: number;
      readonly riskLevel: "low" | "medium" | "high";
      readonly tags: readonly string[];
      readonly nodes: readonly {
        readonly offset: number;
        readonly title: string;
        readonly summary: string;
        readonly checkpoint: string;
      }[];
    }) => {
      const narrativeRepository = createNarrativeEngineeringRepository(storage);
      const current = await narrativeRepository.load();
      const now = new Date().toISOString();
      const title = input.title.trim();
      if (!title) throw new Error("推演方案缺少标题，不能送入剧情工程");
      await narrativeRepository.save(current, {
        ...current.library,
        simulationProposals: [
          ...current.library.simulationProposals,
          {
            id: createProposalId(),
            title,
            description: input.description.trim(),
            premise: input.premise.trim(),
            sourceChapterPlanId: input.sourceChapterPlanId,
            sourceManuscriptChapterId: input.sourceManuscriptChapterId,
            agentRole: input.agentRole.trim(),
            coherence: boundedScore(input.coherence),
            novelty: boundedScore(input.novelty),
            risk: boundedScore(input.risk),
            riskLevel: input.riskLevel,
            tags: input.tags
              .map((tag) => tag.trim())
              .filter(Boolean)
              .slice(0, 6),
            nodes: input.nodes
              .flatMap((node) => {
                const nodeTitle = node.title.trim();
                if (!nodeTitle) return [];
                return [
                  {
                    offset: Math.max(1, Math.round(node.offset)),
                    title: nodeTitle,
                    summary: node.summary.trim(),
                    checkpoint: node.checkpoint.trim(),
                  },
                ];
              })
              .slice(0, 12),
            status: "pending",
            createdAt: now,
            reviewedAt: null,
          },
        ],
      });
      if (!(await load(true)))
        throw new Error("推演候选已写入，但项目重新加载失败");
    },
    [load, storage],
  );

  const saveKnowledgeGraphEnabled = useCallback(
    async (enabled: boolean) => {
      if (!project) throw new Error("小说项目尚未加载");
      const updated = await repository.saveKnowledgeGraphEnabled(
        project,
        enabled,
      );
      setProject((current) =>
        current
          ? Object.freeze({
              ...current,
              metadata: updated.metadata,
              metadataContent: updated.metadataContent,
            })
          : current,
      );
    },
    [project, repository],
  );

  const saveProjectSettings = useCallback(
    async (input: UpdateNovelProjectSettingsInput) => {
      if (!project) throw new Error("小说项目尚未加载");
      const updated = await repository.saveProjectSettings(project, input);
      setProject((current) =>
        current
          ? Object.freeze({
              ...current,
              metadata: updated.metadata,
              metadataContent: updated.metadataContent,
            })
          : current,
      );
    },
    [project, repository],
  );

  return Object.freeze({
    project,
    error,
    isLoading,
    isRefreshing,
    isCreatingChapter,
    saveProjectSettings,
    saveKnowledgeGraphEnabled,
    reload,
    createChapter,
    updateChapter,
    renameChapter,
    linkChapterToNarrative,
    createDirectory,
    updateDirectory,
    deleteDirectory,
    setStructureMode,
    synchronizeNarrative,
    saveTypography,
    deleteChapter,
    restoreChapter,
    deleteChapterPermanently,
    saveChapter,
    loadManuscriptVersions,
    loadManuscriptVersionSettings,
    saveManuscriptVersionLimit,
    restoreManuscriptVersion,
    extractChaptersToNarrative,
    adoptSimulationPath,
  });
}
