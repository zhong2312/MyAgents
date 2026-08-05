import {
  FilePlus2,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ConfirmDialog,
  type WorkbenchStorage,
  type WorkbenchStorageEntry,
} from "@/workbench-sdk";

import MarkdownVisualEditor from "../../../MarkdownVisualEditor";
import type { DomainEntityRef } from "../../../shared/business/domainIndex";

interface ResearchLibraryProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly isActive: boolean;
  /** 外部实体定位请求（T3 消费：自动选中对应资料文件）。 */
  readonly focus?: DomainEntityRef | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMarkdownEntry(entry: WorkbenchStorageEntry): boolean {
  return entry.kind === "file" && entry.name.toLowerCase().endsWith(".md");
}

export default function ResearchLibrary({
  storage,
  projectTitle,
  isActive,
  focus,
}: ResearchLibraryProps) {
  const [entries, setEntries] = useState<WorkbenchStorageEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const all = await storage.list("research");
      setEntries(all.filter(isMarkdownEntry));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [storage]);

  useEffect(() => {
    if (!isActive) return;
    void loadEntries();
  }, [isActive, loadEntries]);

  useEffect(() => {
    void loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载时刷新一次
  }, []);

  const loadContent = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const file = await storage.readText(path);
        setSelectedPath(path);
        setContent(file.content);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [storage],
  );

  // 外部实体定位：焦点资料文件存在时自动选中（T3）
  useEffect(() => {
    if (!focus || focus.kind !== "research") return;
    const path = focus.focus.researchPath;
    if (path) void loadContent(path);
  }, [focus, loadContent]);

  const createFile = useCallback(async () => {
    const name = window.prompt("资料文件名（.md 自动补全）：", "新资料");
    if (!name?.trim()) return;
    const safeName = name.trim().replace(/\.md$/i, "");
    if (!/^[\w\u4e00-\u9fa5-]+$/u.test(safeName)) {
      setError("文件名只能使用中英文、数字、下划线与连字符");
      return;
    }
    const path = `research/${safeName}.md`;
    try {
      await storage.createText(path, `# ${safeName}\n\n`, {
        createParents: true,
      });
      await loadEntries();
      await loadContent(path);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [loadContent, loadEntries, storage]);

  const saveContent = useCallback(async (): Promise<boolean> => {
    if (!selectedPath) return true;
    setIsSaving(true);
    setError(null);
    try {
      await storage.writeText(selectedPath, content);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [content, selectedPath, storage]);

  const removeFile = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await storage.remove(deleteTarget, { permanent: true });
      if (selectedPath === deleteTarget) {
        setSelectedPath(null);
        setContent("");
      }
      await loadEntries();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, loadEntries, selectedPath, storage]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return entries;
    return entries.filter((entry) =>
      entry.name.toLocaleLowerCase("zh-CN").includes(needle),
    );
  }, [entries, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
        <strong className="text-sm">资料库</strong>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <label className="ml-auto flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 focus-within:border-[var(--accent-warm)]">
          <Search className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资料文件名"
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
          onClick={() => void loadEntries()}
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
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--line-subtle)]">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
            <Folder className="h-3.5 w-3.5" />
            research/
            <span className="ml-auto">{filtered.length} 份</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex h-24 items-center justify-center text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-[var(--ink-muted)]">
                {query ? "没有匹配的资料" : "暂无资料，点击右上角新建"}
              </p>
            ) : (
              filtered.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void loadContent(entry.path)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
                    selectedPath === entry.path
                      ? "bg-[var(--accent-warm-subtle)]"
                      : "hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.name.replace(/\.md$/i, "")}
                  </span>
                  {selectedPath === entry.path && (
                    <span
                      role="button"
                      title="删除资料"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(entry.path);
                      }}
                      className="shrink-0 rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  )}
                </button>
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
                  {isSaving ? "保存中…" : "修改后请点击保存"}
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
          title="删除资料"
          message={`确定要删除资料“${deleteTarget}”吗？此操作不可恢复。`}
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={() => void removeFile()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
