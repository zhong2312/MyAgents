import { BookOpen, FolderOpen, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  CustomSelect,
  type WorkbenchProjectCreatorProps,
} from "@/workbench-sdk";
import NovelGenrePicker from "./NovelGenrePicker";
import { novelLanguageOptions } from "./novelGenres";
import NovelPlanningFields from "./NovelPlanningFields";
import { createNovelProjectInitialization } from "./projectInitialization";
import {
  DEFAULT_NOVEL_WRITING_PERSPECTIVE,
  NOVEL_WRITING_PERSPECTIVE_OPTIONS,
  type NovelWritingPerspective,
} from "./modules/project/business/writingPerspective";
import {
  DEFAULT_CHAPTER_WORD_COUNT,
  DEFAULT_TARGET_WORD_COUNT_MAX_WAN,
  DEFAULT_TARGET_WORD_COUNT_MIN_WAN,
  parseNovelPlanningInput,
} from "./projectPlanning";

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
  const [projectName, setProjectName] = useState("");
  const [title, setTitle] = useState("");
  const [parentPath, setParentPath] = useState(defaultParentPath);
  const [genres, setGenres] = useState<string[]>(["玄幻"]);
  const [targetWordCountMinWan, setTargetWordCountMinWan] = useState(
    DEFAULT_TARGET_WORD_COUNT_MIN_WAN,
  );
  const [targetWordCountMaxWan, setTargetWordCountMaxWan] = useState(
    DEFAULT_TARGET_WORD_COUNT_MAX_WAN,
  );
  const [chapterWordCount, setChapterWordCount] = useState(
    DEFAULT_CHAPTER_WORD_COUNT,
  );
  const [language, setLanguage] = useState("zh-CN");
  const [writingPerspective, setWritingPerspective] =
    useState<NovelWritingPerspective>(DEFAULT_NOVEL_WRITING_PERSPECTIVE);
  const [synopsis, setSynopsis] = useState("");
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const normalizedFolderName = sanitizeFolderName(projectName);
  const workspacePath = useMemo(
    () => joinPath(parentPath, normalizedFolderName),
    [normalizedFolderName, parentPath],
  );
  const planning = parseNovelPlanningInput(
    targetWordCountMinWan,
    targetWordCountMaxWan,
    chapterWordCount,
  );
  const canCreate =
    projectName.trim().length > 0 &&
    title.trim().length > 0 &&
    normalizedFolderName.length > 0 &&
    parentPath.trim().length > 0 &&
    genres.length > 0 &&
    planning !== null &&
    !isCreating;

  const handlePick = async () => {
    setIsPicking(true);
    try {
      const selected = await onPickDirectory();
      if (selected) setParentPath(selected);
    } finally {
      setIsPicking(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate || !planning) return;
    setError(null);
    setIsCreating(true);
    try {
      const createdAt = new Date().toISOString();
      await onCreate({
        workspacePath,
        displayName: projectName.trim(),
        icon: "📖",
        route: "overview",
        initialization: createNovelProjectInitialization({
          projectId: crypto.randomUUID(),
          projectName: projectName.trim(),
          title: title.trim(),
          genres,
          ...planning,
          language,
          writingPerspective,
          description: synopsis.trim(),
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="novel-project-creator-title"
        onSubmit={handleSubmit}
        className="max-h-[calc(100vh-32px)] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-[var(--line-subtle)] px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="novel-project-creator-title"
                className="text-lg font-semibold text-[var(--ink)]"
              >
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
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div>
              <label
                htmlFor="novel-project-name"
                className="mb-2 block text-sm font-medium text-[var(--ink)]"
              >
                项目名
              </label>
              <input
                id="novel-project-name"
                autoFocus
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="例如：长夜行-01"
                className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
              />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                固定代号，创建后不可修改
              </p>
            </div>
            <div>
              <label
                htmlFor="novel-title"
                className="mb-2 block text-sm font-medium text-[var(--ink)]"
              >
                书名
              </label>
              <input
                id="novel-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：长夜行"
                className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
              />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                可在总览页面自由修改
              </p>
            </div>
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
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">
              项目目录
            </span>
            <p
              className="flex h-10 items-center truncate rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)]/55 px-3 font-mono text-xs text-[var(--ink-muted)]"
              title={workspacePath}
            >
              {workspacePath || "填写项目名后生成目录"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
            <NovelGenrePicker
              id="novel-genre"
              genres={genres}
              open={genreMenuOpen}
              disabled={isCreating}
              onChange={setGenres}
              onOpenChange={setGenreMenuOpen}
            />

            <div>
              <span className="mb-2 block text-sm font-medium text-[var(--ink)]">
                创作语言
              </span>
              <CustomSelect
                value={language}
                options={novelLanguageOptions()}
                onChange={setLanguage}
                ariaLabel="创作语言"
                size="toolbar"
                disabled={isCreating}
              />
            </div>
            <div>
              <span className="mb-2 block text-sm font-medium text-[var(--ink)]">
                写作视角
              </span>
              <CustomSelect
                value={writingPerspective}
                options={NOVEL_WRITING_PERSPECTIVE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: item.label,
                }))}
                onChange={(value) =>
                  setWritingPerspective(value as NovelWritingPerspective)
                }
                ariaLabel="写作视角"
                size="toolbar"
                disabled={isCreating}
              />
            </div>
          </div>

          <div className="border-t border-[var(--line-subtle)] pt-5">
            <NovelPlanningFields
              idPrefix="novel-create"
              targetWordCountMinWan={targetWordCountMinWan}
              targetWordCountMaxWan={targetWordCountMaxWan}
              chapterWordCount={chapterWordCount}
              disabled={isCreating}
              onTargetWordCountMinWanChange={setTargetWordCountMinWan}
              onTargetWordCountMaxWanChange={setTargetWordCountMaxWan}
              onChapterWordCountChange={setChapterWordCount}
            />
          </div>

          <div className="border-t border-[var(--line-subtle)] pt-5">
            <label
              htmlFor="novel-synopsis"
              className="mb-2 block text-sm font-medium text-[var(--ink)]"
            >
              本书简介
            </label>
            <textarea
              id="novel-synopsis"
              value={synopsis}
              onChange={(event) => setSynopsis(event.target.value)}
              placeholder="一句话或一段话介绍本书的核心设定与看点"
              className="h-[100px] w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
            />
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
