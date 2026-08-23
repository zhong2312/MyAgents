import {
  ArchiveRestore,
  Check,
  FilePlus2,
  FileText,
  Folder,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
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
import "./ResearchLibrary.css";

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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function documentSnippet(content: string | null): string {
  if (!content) return "暂无正文摘录";
  const text = content
    .replace(/^```[\s\S]*?```$/gmu, "")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/[*_`~>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text.slice(0, 96) : "暂无正文摘录";
}

function matchesSource(source: LoadedResearchSource, needle: string): boolean {
  if (!needle) return true;
  return `${source.title} ${source.path} ${source.diskContent ?? ""}`
    .toLocaleLowerCase("zh-CN")
    .includes(needle);
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
    if (!library || selectedPathRef.current || dirtyRef.current) return;
    const focusedPath =
      focus?.kind === "research" ? focus.focus.researchPath : null;
    const initialPath =
      focusedPath ?? library.sources.find((source) => source.exists)?.path;
    if (initialPath) void loadContent(initialPath);
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
      matchesSource(
        source.path === selectedPath
          ? { ...source, diskContent: content }
          : source,
        needle,
      ),
    );
  }, [content, library, query, selectedPath]);
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
  const selectedSource = library?.sources.find(
    (source) => source.path === selectedPath,
  );
  const sourceCount =
    library?.sources.filter((source) => source.exists).length ?? 0;

  return (
    <div
      className="research-library"
      data-sidebar-open={sidebarOpen ? "true" : "false"}
    >
      <NarrativeUnsavedChangesGuard
        dirty={dirty}
        label={selectedPath ?? "资料库"}
        registerNavigationGuard={registerNavigationGuard}
        onSave={saveAndLeave}
      />
      <header className="research-header">
        <button
          type="button"
          className="research-mobile-toggle"
          aria-label={sidebarOpen ? "收起资料列表" : "打开资料列表"}
          title={sidebarOpen ? "收起资料列表" : "打开资料列表"}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeftOpen className="h-4 w-4" />
          )}
        </button>
        <div className="research-brand">
          <span className="research-brand-icon">
            <FileText className="h-4 w-4" />
          </span>
          <span>
            <strong>资料库</strong>
            <small>{projectTitle}</small>
          </span>
        </div>
        <span className="research-header-summary">
          {sourceCount} 份资料 · Markdown 事实源
        </span>
        <span className="research-header-spacer" />
        <label className="research-search">
          <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、路径或正文"
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
          className="research-icon-button"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void createFile()}
          title="新建资料文件"
          className="research-primary-button"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          <span className="max-sm:hidden">新建资料</span>
        </button>
      </header>
      {error && <div className="research-alert is-error">{error}</div>}
      {externalModified && !error && (
        <div className="research-alert is-warning">
          磁盘内容已变化，请重新加载后再继续编辑。
        </div>
      )}
      <div className="research-body">
        <aside className="research-sidebar">
          <div className="research-sidebar-heading">
            <Folder className="h-3.5 w-3.5" />
            {showTrash ? "research/trash/" : "research/notes/"}
            <span className="research-count">
              {showTrash ? filteredTrash.length : filteredSources.length} 份
            </span>
          </div>
          <div className="research-view-switcher">
            <button
              type="button"
              className={!showTrash ? "is-active" : ""}
              onClick={() => setShowTrash(false)}
            >
              当前资料
            </button>
            <button
              type="button"
              className={showTrash ? "is-active" : ""}
              onClick={() => setShowTrash(true)}
            >
              回收站
            </button>
          </div>
          <div className="research-source-list">
            {isLoading ? (
              <div className="research-list-state">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : showTrash ? (
              filteredTrash.length === 0 ? (
                <p className="research-list-state">回收站为空</p>
              ) : (
                filteredTrash.map((item) => (
                  <div key={item.id} className="research-source-row is-trash">
                    <Trash2 className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                    <span
                      className="research-source-name"
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
                      className="research-row-action"
                    >
                      <ArchiveRestore className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )
            ) : filteredSources.length === 0 ? (
              <p className="research-list-state">
                {query ? "没有匹配的资料" : "暂无资料，点击右上角新建"}
              </p>
            ) : (
              filteredSources.map((source) => (
                <div
                  key={source.path}
                  className={`research-source-row ${selectedPath === source.path ? "is-selected" : ""} ${!source.exists ? "is-missing" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => void loadContent(source.path)}
                    className="research-source-trigger"
                    aria-label={source.title}
                    title={source.path}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                    <span className="research-source-copy">
                      <span className="research-source-name">
                        {source.title}
                      </span>
                      <span className="research-source-snippet">
                        {documentSnippet(source.diskContent)}
                      </span>
                    </span>
                    {!source.exists && (
                      <span className="research-missing-label">缺失</span>
                    )}
                  </button>
                  <button
                    type="button"
                    title="移入回收站"
                    aria-label={`删除${source.title}`}
                    onClick={() => setDeleteTarget(source)}
                    className="research-row-action is-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
        <button
          type="button"
          className="research-sidebar-scrim"
          aria-label="关闭资料列表"
          onClick={() => setSidebarOpen(false)}
        />
        <main className="research-editor-pane">
          {selectedPath ? (
            <>
              <div className="research-editor-context">
                <div className="research-editor-title-block">
                  <span>当前资料</span>
                  <h1>{selectedSource?.title ?? selectedPath}</h1>
                  <code>{selectedPath}</code>
                </div>
                <div className="research-editor-meta">
                  <span className={dirty ? "is-dirty" : "is-saved"}>
                    {dirty ? (
                      <span className="research-status-dot" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    {isSaving ? "保存中" : dirty ? "未保存" : "已保存"}
                  </span>
                  <span>{content.length.toLocaleString()} 字符</span>
                  {selectedSource?.createdAt && (
                    <span>{formatDate(selectedSource.createdAt)} 创建</span>
                  )}
                </div>
                <button
                  type="button"
                  className="research-editor-sidebar-toggle"
                  onClick={() => setSidebarOpen((open) => !open)}
                  aria-label={sidebarOpen ? "收起资料列表" : "打开资料列表"}
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </button>
              </div>
              <MarkdownVisualEditor
                pageId={`research.${selectedPath}`}
                label={selectedPath}
                value={content}
                onChange={setContent}
                onSave={() => void saveContent()}
                placeholder="记录研究资料、考据与设定来源……"
                fullWidth
                footer={
                  <span className="research-editor-footer">
                    {dirty
                      ? "修改会在保存前保留在当前草稿"
                      : "Markdown 将作为项目资料事实源保存"}
                  </span>
                }
              />
            </>
          ) : (
            <div className="research-empty-state">
              <span className="research-empty-icon">
                <Folder className="h-6 w-6" />
              </span>
              <h1>从一份资料开始</h1>
              <p>把考据、参考来源和世界资料整理成可持续编辑的 Markdown。</p>
              <button
                type="button"
                className="research-primary-button"
                onClick={() => void createFile()}
              >
                <FilePlus2 className="h-3.5 w-3.5" />
                新建资料
              </button>
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
