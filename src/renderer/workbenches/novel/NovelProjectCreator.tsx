import {
  BookOpen,
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Popover, type WorkbenchProjectCreatorProps } from "@/workbench-sdk";
import { createNovelProjectInitialization } from "./projectInitialization";
import { NOVEL_GENRE_GROUPS } from "./novelGenres";

const DEFAULT_TARGET_WORD_COUNT_WAN = "100";

function sanitizeFolderName(value: string): string {
  const withoutControls = Array.from(value.trim())
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  return withoutControls
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/-{2,}/g, "-");
}

function joinPath(parent: string, child: string): string {
  const trimmedParent = parent.trim().replace(/[\\/]+$/g, "");
  const separator = trimmedParent.includes("\\") ? "\\" : "/";
  return trimmedParent ? `${trimmedParent}${separator}${child}` : child;
}

export default function NovelProjectCreator({
  defaultParentPath,
  onPickDirectory,
  onCreate,
  onClose,
}: WorkbenchProjectCreatorProps) {
  const [title, setTitle] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderWasEdited, setFolderWasEdited] = useState(false);
  const [parentPath, setParentPath] = useState(defaultParentPath);
  const [genres, setGenres] = useState<string[]>(["玄幻"]);
  const [targetWordCountWan, setTargetWordCountWan] = useState(
    DEFAULT_TARGET_WORD_COUNT_WAN,
  );
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genreTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isCreating) return;
      if (genreMenuOpen) {
        setGenreMenuOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [genreMenuOpen, isCreating, onClose]);

  const normalizedFolderName = sanitizeFolderName(folderName || title);
  const workspacePath = useMemo(
    () => joinPath(parentPath, normalizedFolderName),
    [normalizedFolderName, parentPath],
  );
  const parsedTargetWordCountWan = Number(targetWordCountWan);
  const hasValidTargetWordCount =
    targetWordCountWan.trim().length > 0 &&
    Number.isFinite(parsedTargetWordCountWan) &&
    parsedTargetWordCountWan > 0 &&
    parsedTargetWordCountWan <= 10_000;
  const genreSummary =
    genres.length <= 2
      ? genres.join("、")
      : `${genres.slice(0, 2).join("、")} 等 ${genres.length} 项`;
  const canCreate =
    title.trim().length > 0 &&
    normalizedFolderName.length > 0 &&
    parentPath.trim().length > 0 &&
    genres.length > 0 &&
    hasValidTargetWordCount &&
    !isCreating;

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!folderWasEdited) setFolderName(sanitizeFolderName(value));
  };

  const handlePick = async () => {
    setIsPicking(true);
    try {
      const selected = await onPickDirectory();
      if (selected) setParentPath(selected);
    } finally {
      setIsPicking(false);
    }
  };

  const toggleGenre = (genre: string) => {
    setGenres((current) =>
      current.includes(genre)
        ? current.filter((item) => item !== genre)
        : [...current, genre],
    );
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    setError(null);
    setIsCreating(true);
    try {
      const createdAt = new Date().toISOString();
      await onCreate({
        workspacePath,
        displayName: title.trim(),
        icon: "📖",
        route: "overview",
        initialization: createNovelProjectInitialization({
          projectId: crypto.randomUUID(),
          title: title.trim(),
          genres,
          targetWordCount: Math.round(parsedTargetWordCountWan * 10_000),
          createdAt,
        }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isCreating) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="max-h-[calc(100vh-32px)] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-[var(--line-subtle)] px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-[var(--ink)]">
                新建小说
              </h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                创建独立目录与小说工作台
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
            title="关闭"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          <div>
            <label
              htmlFor="novel-title"
              className="mb-2 block text-sm font-medium text-[var(--ink)]"
            >
              小说名称
            </label>
            <input
              id="novel-title"
              autoFocus
              value={title}
              onChange={(event) => handleTitleChange(event.target.value)}
              placeholder="例如：长夜行"
              className="h-11 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-base text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
          </div>

          <div>
            <label
              htmlFor="novel-parent-path"
              className="mb-2 block text-sm font-medium text-[var(--ink)]"
            >
              保存位置
            </label>
            <div className="flex gap-2">
              <input
                id="novel-parent-path"
                value={parentPath}
                onChange={(event) => setParentPath(event.target.value)}
                className="h-10 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              />
              <button
                type="button"
                onClick={handlePick}
                disabled={isPicking || isCreating}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                title="选择文件夹"
                aria-label="选择文件夹"
              >
                {isPicking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="novel-folder-name"
              className="mb-2 block text-sm font-medium text-[var(--ink)]"
            >
              项目目录
            </label>
            <input
              id="novel-folder-name"
              value={folderName}
              onChange={(event) => {
                setFolderWasEdited(true);
                setFolderName(event.target.value);
              }}
              placeholder="跟随小说名称"
              className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
            <p
              className="mt-2 truncate font-mono text-xs text-[var(--ink-muted)]"
              title={workspacePath}
            >
              {workspacePath || "选择保存位置后显示完整路径"}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div>
              <span
                id="novel-genre-label"
                className="mb-2 block text-sm font-medium text-[var(--ink)]"
              >
                题材
              </span>
              <button
                ref={genreTriggerRef}
                type="button"
                aria-labelledby="novel-genre-label"
                aria-haspopup="listbox"
                aria-expanded={genreMenuOpen}
                onClick={() => setGenreMenuOpen((current) => !current)}
                className="flex h-10 w-full items-center justify-between rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)]"
              >
                <span
                  className={
                    genres.length > 0
                      ? "truncate"
                      : "truncate text-[var(--ink-subtle)]"
                  }
                >
                  {genreSummary || "请选择题材"}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition-transform ${genreMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              <Popover
                open={genreMenuOpen}
                onClose={() => setGenreMenuOpen(false)}
                anchorRef={genreTriggerRef}
                placement="bottom-start"
                offset={6}
                className="w-[min(34rem,calc(100vw-2rem))]"
              >
                <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
                  <span className="text-sm font-medium text-[var(--ink)]">
                    小说题材
                  </span>
                  <span className="text-xs text-[var(--ink-muted)]">
                    已选 {genres.length} 项
                  </span>
                </div>
                <div
                  role="listbox"
                  aria-multiselectable="true"
                  aria-labelledby="novel-genre-label"
                  className="max-h-[min(28rem,calc(100vh-12rem))] overflow-y-auto"
                >
                  {NOVEL_GENRE_GROUPS.map((group) => (
                    <section key={group.label} aria-label={group.label}>
                      <div className="border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-2 text-xs font-semibold text-[var(--ink-muted)]">
                        {group.label}
                      </div>
                      <div className="flex flex-wrap gap-1.5 border-b border-[var(--line-subtle)] bg-[var(--paper-inset)]/55 px-3 py-2.5">
                        {group.options.map((option) => {
                          const selected = genres.includes(option);
                          return (
                            <button
                              key={option}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => toggleGenre(option)}
                              className={`flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors ${
                                selected
                                  ? "border-[var(--accent-warm)] bg-[var(--accent-warm-muted)] font-medium text-[var(--accent-warm)]"
                                  : "border-transparent bg-[var(--paper-elevated)] text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                              }`}
                            >
                              <span
                                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                                  selected
                                    ? "border-[var(--accent-warm)] bg-[var(--accent-warm)] text-white"
                                    : "border-[var(--line-strong)] text-transparent"
                                }`}
                              >
                                <Check className="h-3 w-3" />
                              </span>
                              {option}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setGenres([])}
                    disabled={genres.length === 0}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
                  >
                    <X className="h-3.5 w-3.5" />
                    清空
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenreMenuOpen(false)}
                    className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                  >
                    <Check className="h-3.5 w-3.5" />
                    完成
                  </button>
                </div>
              </Popover>
            </div>

            <div>
              <label
                htmlFor="novel-target-word-count"
                className="mb-2 block text-sm font-medium text-[var(--ink)]"
              >
                目标字数
              </label>
              <div className="relative">
                <input
                  id="novel-target-word-count"
                  type="number"
                  min="0.1"
                  max="10000"
                  step="0.1"
                  inputMode="decimal"
                  value={targetWordCountWan}
                  onChange={(event) =>
                    setTargetWordCountWan(event.target.value)
                  }
                  aria-invalid={!hasValidTargetWordCount}
                  className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 pr-14 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)] aria-invalid:border-[var(--error)]"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-[var(--ink-muted)]">
                  万字
                </span>
              </div>
            </div>
          </div>

          {error && (
            <div
              className="rounded-md bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]"
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--line-subtle)] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="rounded-md px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="flex min-w-28 items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isCreating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isCreating ? "创建中..." : "创建并打开"}
          </button>
        </footer>
      </form>
    </div>
  );
}
