import {
  ArchiveRestore,
  FilePlus2,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ConfirmDialog,
  type WorkbenchNavigationGuard,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import MarkdownVisualEditor from "../../../MarkdownVisualEditor";
import NarrativeUnsavedChangesGuard from "../../../NarrativeUnsavedChangesGuard";
import type { DomainEntityRef } from "../../../shared/business/domainIndex";
import {
  createResearchRepository,
  type LoadedResearchLibrary,
  type LoadedResearchSource,
  type LoadedResearchTrash,
} from "../data-access/researchRepository";

interface ResearchLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly focus?: DomainEntityRef | null;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ResearchLibrary({
  storage,
  projectTitle,
  isActive,
  focus,
  registerNavigationGuard,
}: ResearchLibraryProps) {
  const repository = useMemo(
    () => createResearchRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedResearchLibrary | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalModified, setExternalModified] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LoadedResearchSource | null>(
    null,
  );
  const [showTrash, setShowTrash] = useState(false);
  const [restoreTarget, setRestoreTarget] =
    useState<LoadedResearchTrash | null>(null);

  const dirty = Boolean(selectedPath && content !== savedContent);
  const dirtyRef = useRef(dirty);
  const contentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  const selectedPathRef = useRef(selectedPath);
  const libraryRef = useRef(library);
  const disposedRef = useRef(false);

  useEffect(() => {
    dirtyRef.current = dirty;
    contentRef.current = content;
    savedContentRef.current = savedContent;
    selectedPathRef.current = selectedPath;
    libraryRef.current = library;
  }, [content, dirty, library, savedContent, selectedPath]);

  const loadLibrary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await repository.load();
      libraryRef.current = next;
      setLibrary(next);
      const currentPath = selectedPathRef.current;
      if (!currentPath || dirtyRef.current) return;
      const source = next.sources.find((item) => item.path === currentPath);
      if (!source?.exists) {
        setExternalModified(true);
        setError("当前资料已在磁盘上消失，请从回收站恢复或重新选择资料。");
        return;
      }
      const file = await repository.loadSource(source);
      setContent(file.content);
      setSavedContent(file.content);
      contentRef.current = file.content;
      savedContentRef.current = file.content;
      setExternalModified(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    if (!isActive) return;
    void loadLibrary();
  }, [isActive, loadLibrary]);

  useEffect(() => {
    if (!storage.isAvailable || !isActive) return;
    disposedRef.current = false;
    let subscription: { dispose: () => Promise<void> } | null = null;
    void storage
      .watch(() => {
        if (disposedRef.current) return;
        void (async () => {
          const path = selectedPathRef.current;
          if (!path) {
            await loadLibrary();
            return;
          }
          try {
            const next = await repository.load();
            if (disposedRef.current) return;
            libraryRef.current = next;
            setLibrary(next);
            const source = next.sources.find((item) => item.path === path);
            if (!source?.exists || source.diskContent === null) {
              setExternalModified(true);
              setError(
                "当前资料已在磁盘上消失，请从回收站恢复或重新选择资料。",
              );
              return;
            }
            if (source.diskContent === savedContentRef.current) return;
            if (dirtyRef.current) {
              setExternalModified(true);
              setError(
                "当前资料已被外部修改。请先复制需要保留的内容，再重新加载后保存。",
              );
            } else {
              setContent(source.diskContent);
              setSavedContent(source.diskContent);
              contentRef.current = source.diskContent;
              savedContentRef.current = source.diskContent;
              setExternalModified(false);
            }
          } catch (cause) {
            if (!disposedRef.current) setError(errorMessage(cause));
          }
        })();
      })
      .then((next) => {
        subscription = next;
      })
      .catch(() => undefined);
    return () => {
      disposedRef.current = true;
      const current = subscription;
      if (current) void current.dispose();
    };
  }, [isActive, loadLibrary, repository, storage]);

  const saveContent = useCallback(async (): Promise<boolean> => {
    const currentLibrary = libraryRef.current;
    const path = selectedPathRef.current;
    if (!currentLibrary || !path) return true;
    const source = currentLibrary.sources.find((item) => item.path === path);
    if (!source?.exists) {
      setError("当前资料不存在，无法保存。");
      return false;
    }
    setIsSaving(true);
    setError(null);
    try {
      const saved = await repository.saveSource(
        currentLibrary,
        source,
        contentRef.current,
        savedContentRef.current,
      );
      libraryRef.current = saved.library;
      savedContentRef.current = saved.content;
      setLibrary(saved.library);
      setSavedContent(saved.content);
      setExternalModified(false);
      return true;
    } catch (cause) {
      setExternalModified(true);
      setError(`资料保存失败：${errorMessage(cause)}。请重新加载后再保存。`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [repository]);

  const loadContent = useCallback(
    async (path: string): Promise<boolean> => {
      if (path === selectedPathRef.current) return true;
      if (dirtyRef.current && !(await saveContent())) return false;
      const source = libraryRef.current?.sources.find(
        (item) => item.path === path,
      );
      if (!source) {
        setError("资料不在当前索引中，请刷新资料库。");
        return false;
      }
      if (!source.exists) {
        setError("该资料文件已丢失，请从回收站恢复或刷新资料库。");
        return false;
      }
      setError(null);
      try {
        const file = await repository.loadSource(source);
        selectedPathRef.current = path;
        contentRef.current = file.content;
        savedContentRef.current = file.content;
        setSelectedPath(path);
        setContent(file.content);
        setSavedContent(file.content);
        setExternalModified(false);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      }
    },
    [repository, saveContent],
  );

  useEffect(() => {
    if (!focus || focus.kind !== "research") return;
    const path = focus.focus.researchPath;
    if (path && library) void loadContent(path);
  }, [focus, library, loadContent]);

  const createFile = useCallback(async () => {
    const name = window.prompt("资料文件名（.md 自动补全）：", "新资料");
    if (!name?.trim() || !libraryRef.current) return;
    if (dirtyRef.current && !(await saveContent())) return;
    try {
      const created = await repository.createSource(libraryRef.current, name);
      libraryRef.current = created.library;
      selectedPathRef.current = created.source.path;
      contentRef.current = created.content;
      savedContentRef.current = created.content;
      setLibrary(created.library);
      setSelectedPath(created.source.path);
      setContent(created.content);
      setSavedContent(created.content);
      setExternalModified(false);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [repository, saveContent]);

  const removeFile = useCallback(async () => {
    const target = deleteTarget;
    let currentLibrary = libraryRef.current;
    if (!target || !currentLibrary) return;
    if (target.path === selectedPathRef.current && dirtyRef.current) {
      if (!(await saveContent())) return;
      currentLibrary = libraryRef.current;
      if (!currentLibrary) return;
    }
    try {
      const currentTarget = currentLibrary.sources.find(
        (source) => source.path === target.path,
      );
      if (!currentTarget) {
        setError("资料已不在当前索引中，请刷新后重试。");
        return;
      }
      const next = await repository.deleteSource(currentLibrary, currentTarget);
      libraryRef.current = next;
      setLibrary(next);
      if (selectedPathRef.current === target.path) {
        selectedPathRef.current = null;
        contentRef.current = "";
        savedContentRef.current = "";
        setSelectedPath(null);
        setContent("");
        setSavedContent("");
        setExternalModified(false);
      }
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, repository, saveContent]);

  const restoreFile = useCallback(async () => {
    const target = restoreTarget;
    const currentLibrary = libraryRef.current;
    if (!target || !currentLibrary) return;
    try {
      const next = await repository.restoreSource(currentLibrary, target);
      libraryRef.current = next;
      setLibrary(next);
      setRestoreTarget(null);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [repository, restoreTarget]);

  const saveAndLeave = useCallback(() => saveContent(), [saveContent]);
  const filteredSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const sources = library?.sources ?? [];
    if (!needle) return sources;
    return sources.filter((source) =>
      `${source.title} ${source.path}`
        .toLocaleLowerCase("zh-CN")
        .includes(needle),
    );
  }, [library, query]);
  const filteredTrash = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const trash = library?.trash ?? [];
    if (!needle) return trash;
    return trash.filter((item) =>
      `${item.title} ${item.originalPath}`
        .toLocaleLowerCase("zh-CN")
        .includes(needle),
    );
  }, [library, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <NarrativeUnsavedChangesGuard
        dirty={dirty}
        label={selectedPath ?? "资料库"}
        registerNavigationGuard={registerNavigationGuard}
        onSave={saveAndLeave}
      />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
        <strong className="text-sm">资料库</strong>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <label className="ml-auto flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
          <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资料标题或路径"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ink-subtle)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
              className="text-[var(--ink-subtle)] hover:text-[var(--ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => void loadLibrary()}
          title="刷新资料列表"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void createFile()}
          title="新建资料文件"
          className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          <span className="max-sm:hidden">新建资料</span>
        </button>
      </div>
      {error && (
        <div className="shrink-0 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}
      {externalModified && !error && (
        <div className="shrink-0 border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-5 py-2 text-sm text-[var(--warning)]">
          磁盘内容已变化，请重新加载后再继续编辑。
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line-subtle)]">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
            <Folder className="h-3.5 w-3.5" />
            {showTrash ? "research/trash/" : "research/notes/"}
            <span className="ml-auto">
              {showTrash ? filteredTrash.length : filteredSources.length} 份
            </span>
          </div>
          <div className="flex shrink-0 gap-1 border-b border-[var(--line-subtle)] p-2">
            <button
              type="button"
              className={`flex-1 rounded px-2 py-1.5 text-xs ${!showTrash ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              onClick={() => setShowTrash(false)}
            >
              当前资料
            </button>
            <button
              type="button"
              className={`flex-1 rounded px-2 py-1.5 text-xs ${showTrash ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"}`}
              onClick={() => setShowTrash(true)}
            >
              回收站
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex h-24 items-center justify-center text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : showTrash ? (
              filteredTrash.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-[var(--ink-muted)]">
                  回收站为空
                </p>
              ) : (
                filteredTrash.map((item) => (
                  <div
                    key={item.id}
                    className="mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-[var(--hover-bg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={item.originalPath}
                    >
                      {item.title}
                    </span>
                    <button
                      type="button"
                      title={item.exists ? "恢复资料" : "资料文件已不存在"}
                      aria-label={`恢复${item.title}`}
                      disabled={!item.exists}
                      onClick={() => setRestoreTarget(item)}
                      className="shrink-0 rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)] disabled:opacity-40"
                    >
                      <ArchiveRestore className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )
            ) : filteredSources.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-[var(--ink-muted)]">
                {query ? "没有匹配的资料" : "暂无资料，点击右上角新建"}
              </p>
            ) : (
              filteredSources.map((source) => (
                <div
                  key={source.path}
                  className={`mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${selectedPath === source.path ? "bg-[var(--accent-warm-subtle)]" : "hover:bg-[var(--hover-bg)]"} ${!source.exists ? "opacity-60" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => void loadContent(source.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={source.path}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                    <span className="min-w-0 flex-1 truncate">
                      {source.title}
                    </span>
                    {!source.exists && (
                      <span className="text-xs text-[var(--error)]">缺失</span>
                    )}
                  </button>
                  <button
                    type="button"
                    title="移入回收站"
                    aria-label={`删除${source.title}`}
                    onClick={() => setDeleteTarget(source)}
                    className="shrink-0 rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
        <main className="flex min-h-0 flex-1 flex-col">
          {selectedPath ? (
            <MarkdownVisualEditor
              pageId={`research.${selectedPath}`}
              label={selectedPath}
              value={content}
              onChange={setContent}
              onSave={() => void saveContent()}
              placeholder="记录研究资料、考据与设定来源……"
              fullWidth
              footer={
                <span className="text-xs text-[var(--ink-muted)]">
                  {isSaving ? "保存中…" : dirty ? "有未保存修改" : "已保存"}
                </span>
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
              <Folder className="h-8 w-8 text-[var(--ink-subtle)]" />
              <p>选择左侧资料查看，或新建一份资料</p>
            </div>
          )}
        </main>
      </div>
      {deleteTarget && (
        <ConfirmDialog
          title="移入回收站"
          message={`资料“${deleteTarget.title}”会移入回收站，可随时恢复。确认继续吗？`}
          confirmText="移入回收站"
          confirmVariant="danger"
          onConfirm={() => void removeFile()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {restoreTarget && (
        <ConfirmDialog
          title="恢复资料"
          message={`将资料恢复到“${restoreTarget.originalPath}”，如果目标路径已存在则不会覆盖。确认继续吗？`}
          confirmText="恢复"
          onConfirm={() => void restoreFile()}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}
