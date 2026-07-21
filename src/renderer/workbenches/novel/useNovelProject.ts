import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelRepository,
  type LoadedNovelChapter,
  type LoadedNovelProject,
} from "./repository";

export interface NovelProjectController {
  readonly project: LoadedNovelProject | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isCreatingChapter: boolean;
  saveKnowledgeGraphEnabled(enabled: boolean): Promise<void>;
  reload(): Promise<LoadedNovelProject | null>;
  createChapter(): Promise<string>;
  renameChapter(chapterId: string, title: string): Promise<void>;
  saveChapter(
    chapterId: string,
    content: string,
    expectedContent: string,
  ): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNovelProject(
  storage: WorkbenchStorage,
  isActive: boolean,
): NovelProjectController {
  const repository = useMemo(() => createNovelRepository(storage), [storage]);
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
        const loaded = await repository.load();
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
    let subscription:
      | Awaited<ReturnType<WorkbenchStorage["watch"]>>
      | undefined;
    void storage
      .watch(() => {
        if (disposed) return;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void load(true);
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
  }, [isActive, load, storage]);

  const createChapter = useCallback(async (): Promise<string> => {
    if (!project) throw new Error("小说项目尚未加载");
    setIsCreatingChapter(true);
    try {
      const chapter = await repository.createChapter(project);
      const loaded = await load(true);
      if (!loaded) throw new Error("章节已创建，但项目重新加载失败");
      return chapter.id;
    } finally {
      setIsCreatingChapter(false);
    }
  }, [load, project, repository]);

  const renameChapter = useCallback(
    async (chapterId: string, title: string) => {
      if (!project) throw new Error("小说项目尚未加载");
      const updated = await repository.renameChapter(project, chapterId, title);
      setProject((current) => {
        if (!current) return current;
        return Object.freeze({
          ...current,
          chapterIndex: updated.chapterIndex,
          chapterIndexContent: updated.chapterIndexContent,
          chapters: Object.freeze(
            current.chapters.map((chapter) =>
              chapter.id === chapterId
                ? Object.freeze({ ...chapter, title: title.trim() })
                : chapter,
            ),
          ),
        });
      });
    },
    [project, repository],
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
      setProject((current) => {
        if (!current) return current;
        return Object.freeze({
          ...current,
          chapters: Object.freeze(
            current.chapters.map(
              (item): LoadedNovelChapter =>
                item.id === chapterId ? saved : item,
            ),
          ),
        });
      });
    },
    [project, repository],
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

  return Object.freeze({
    project,
    error,
    isLoading,
    isRefreshing,
    isCreatingChapter,
    saveKnowledgeGraphEnabled,
    reload,
    createChapter,
    renameChapter,
    saveChapter,
  });
}
