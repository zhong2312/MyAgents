import {
  AlertTriangle,
  ArrowRight,
  BookMarked,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  GitCompareArrows,
  Hash,
  Library,
  ListTree,
  Loader2,
  Map,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Users,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import {
  CompactAiRunWindow,
  WorkbenchHeaderActions,
  WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
  WORKBENCH_AI_RUN_REQUEST_VERSION,
  type WorkbenchRendererProps,
} from "@/workbench-sdk";

import type { NovelChapterStatus, NovelMetadata } from "./projectSchema";
import PromptManager from "./PromptManager";
import { createNovelPromptLibraryRepository } from "./promptLibraryRepository";
import {
  renderPromptTemplate,
  resolvePromptSet,
  selectPromptForExecution,
} from "./promptLibraryResolver";
import type { LoadedNovelChapter, LoadedNovelProject } from "./repository";
import SettingLibrary from "./SettingLibrary";
import type { NovelAiAssistTarget } from "./aiAssistTypes";
import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";
import WorldMapPrototype from "./WorldMapPrototype";
import WorldProposalReview from "./WorldProposalReview";
import { buildWorldProposalAgentInstructions } from "./worldProposalSchema";
import { useNovelProject } from "./useNovelProject";

const STATUS_LABELS: Record<NovelMetadata["status"], string> = {
  planning: "规划中",
  writing: "创作中",
  completed: "已完成",
  paused: "已暂停",
};

const CHAPTER_STATUS_LABELS: Record<NovelChapterStatus, string> = {
  draft: "草稿",
  complete: "完成",
  planned: "待写",
};

function formatTargetWordCount(targetWordCount: number): string {
  return (targetWordCount / 10_000).toLocaleString("zh-CN", {
    maximumFractionDigits: 1,
  });
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-[var(--ink-muted)]">
      {children}
    </h2>
  );
}

function WorldAgentButton({
  disabled,
  isLaunching,
  label = "AI 创建世界",
  title = "打开世界架构 Agent",
  onClick,
}: {
  readonly disabled: boolean;
  readonly isLaunching: boolean;
  readonly label?: string;
  readonly title?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLaunching}
      aria-label={isLaunching ? "正在启动 Agent" : label}
      title={disabled ? "MyAgents Agent Session 当前不可用" : title}
      className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isLaunching ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      <span className="max-lg:hidden">{isLaunching ? "正在启动" : label}</span>
    </button>
  );
}

function ProjectLoadingState() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      正在读取小说项目
    </div>
  );
}

function ProjectErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-lg text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-[var(--warning-bg)] text-[var(--warning)]">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-[var(--ink)]">
          无法打开小说项目
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mx-auto mt-5 flex items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新读取
        </button>
      </div>
    </div>
  );
}

function Overview({
  project,
  onOpenChapter,
  onCreateChapter,
  isCreatingChapter,
}: {
  project: LoadedNovelProject;
  onOpenChapter: (chapterId: string) => void;
  onCreateChapter: () => void;
  isCreatingChapter: boolean;
}) {
  const chapters = [...project.chapters].sort(
    (left, right) => right.number - left.number,
  );
  const latestChapter = chapters[0];
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
  const completed = chapters.filter(
    (chapter) => chapter.status === "complete",
  ).length;
  const drafts = chapters.filter(
    (chapter) => chapter.status === "draft",
  ).length;
  const planned = chapters.filter(
    (chapter) => chapter.status === "planned",
  ).length;

  return (
    <div className="mx-auto w-full max-w-6xl px-7 py-6 max-md:px-4">
      <header className="flex items-end justify-between gap-6 border-b border-[var(--line-subtle)] pb-6 max-md:items-start">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--ink-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
            {STATUS_LABELS[project.metadata.status]}
            <span className="text-[var(--ink-subtle)]">·</span>
            {project.metadata.genres.join(" · ")}
          </div>
          <h1 className="truncate text-3xl font-semibold text-[var(--ink)]">
            {project.metadata.title}
          </h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            共 {chapters.length} 章 · 已完成 {completed} 章 ·{" "}
            {totalWords.toLocaleString()} 字
            {project.metadata.targetWordCount !== null && (
              <>
                {" "}
                · 目标 {formatTargetWordCount(
                  project.metadata.targetWordCount,
                )}{" "}
                万字
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            latestChapter ? onOpenChapter(latestChapter.id) : onCreateChapter()
          }
          disabled={isCreatingChapter}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {isCreatingChapter ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PenLine className="h-3.5 w-3.5" />
          )}
          {latestChapter ? "继续写作" : "开始写作"}
        </button>
      </header>

      <section className="grid grid-cols-12 border-b border-[var(--line-subtle)] max-lg:block">
        <div className="col-span-8 border-r border-[var(--line-subtle)] py-6 pr-8 max-lg:border-r-0 max-lg:pr-0">
          <SectionLabel>{latestChapter ? "最近章节" : "正文"}</SectionLabel>
          {latestChapter ? (
            <button
              type="button"
              onClick={() => onOpenChapter(latestChapter.id)}
              className="group mt-4 w-full text-left"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-[var(--accent-warm)]">
                    第 {latestChapter.number} 章
                  </p>
                  <h3 className="mt-1 text-xl font-semibold text-[var(--ink)]">
                    {latestChapter.title}
                  </h3>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ink-subtle)] transition-transform group-hover:translate-x-1 group-hover:text-[var(--accent-warm)]" />
              </div>
              <p className="mt-4 max-w-3xl whitespace-pre-line border-l-2 border-[var(--line-strong)] pl-4 text-base leading-7 text-[var(--ink-secondary)]">
                {latestChapter.content.trim().slice(0, 120) || "正文尚未开始"}
              </p>
              <div className="mt-5 flex items-center gap-4 text-xs text-[var(--ink-muted)]">
                <span>{latestChapter.words.toLocaleString()} 字</span>
                <span>{CHAPTER_STATUS_LABELS[latestChapter.status]}</span>
              </div>
            </button>
          ) : (
            <div className="mt-5 py-6 text-sm text-[var(--ink-muted)]">
              暂无章节
            </div>
          )}
        </div>

        <div className="col-span-4 py-6 pl-8 max-lg:border-t max-lg:border-[var(--line-subtle)] max-lg:pl-0">
          <SectionLabel>章节状态</SectionLabel>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            {[
              ["草稿", drafts],
              ["完成", completed],
              ["待写", planned],
            ].map(([label, count]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
                <dd className="mt-1 text-xl font-semibold text-[var(--ink)]">
                  {count}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="py-6">
        <div className="flex items-center justify-between">
          <SectionLabel>全部章节</SectionLabel>
          <button
            type="button"
            onClick={onCreateChapter}
            disabled={isCreatingChapter}
            className="flex items-center gap-1 text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--accent-warm)] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> 新建章节
          </button>
        </div>
        <div className="mt-3 divide-y divide-[var(--line-subtle)]">
          {chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              onClick={() => onOpenChapter(chapter.id)}
              className="flex w-full items-center gap-4 rounded-md px-2 py-3 text-left transition-colors hover:bg-[var(--hover-bg)]"
            >
              <span className="w-8 shrink-0 text-xs font-medium text-[var(--ink-subtle)]">
                {String(chapter.number).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
                {chapter.title}
              </span>
              <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                {chapter.words.toLocaleString()} 字
              </span>
              <span
                className={`w-8 shrink-0 text-right text-xs ${chapter.status === "complete" ? "text-[var(--success)]" : "text-[var(--warning)]"}`}
              >
                {CHAPTER_STATUS_LABELS[chapter.status]}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ChapterEditor({
  chapter,
  onSave,
  onRename,
}: {
  chapter: LoadedNovelChapter;
  onSave: (content: string, expectedContent: string) => Promise<void>;
  onRename: (title: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(chapter.content);
  const [savedDraft, setSavedDraft] = useState(chapter.content);
  const [titleDraft, setTitleDraft] = useState(chapter.title);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalChanged, setExternalChanged] = useState(false);
  const isSaved = draft === savedDraft;

  useEffect(() => {
    if (chapter.content === savedDraft) return;
    if (draft === savedDraft) {
      setDraft(chapter.content);
      setSavedDraft(chapter.content);
      setExternalChanged(false);
    } else {
      setExternalChanged(true);
    }
  }, [chapter.content, draft, savedDraft]);

  const save = async () => {
    if (isSaved || isSaving) return;
    setError(null);
    setIsSaving(true);
    try {
      await onSave(draft, savedDraft);
      setSavedDraft(draft);
      setExternalChanged(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  };

  const commitTitle = async () => {
    const title = titleDraft.trim();
    if (!title) {
      setTitleDraft(chapter.title);
      return;
    }
    if (title === chapter.title) return;
    setError(null);
    try {
      await onRename(title);
    } catch (cause) {
      setTitleDraft(chapter.title);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <article className="flex min-w-0 flex-1 flex-col bg-[var(--paper)]">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-[var(--line-subtle)] px-5 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-[var(--ink-muted)]">
            第 {chapter.number} 章
          </span>
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTitleDraft(chapter.title);
                event.currentTarget.blur();
              }
            }}
            aria-label="章节标题"
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[var(--ink)] outline-none"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex rounded-md bg-[var(--paper-inset)] p-0.5">
            {(["edit", "preview"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${mode === item ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
              >
                {item === "edit" ? "编辑" : "预览"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSaved || isSaving}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-45"
            title={isSaved ? "已保存" : "保存"}
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isSaved ? (
              <Check className="h-3.5 w-3.5 text-[var(--success)]" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span className="max-sm:hidden">
              {isSaving ? "保存中" : isSaved ? "已保存" : "保存"}
            </span>
          </button>
        </div>
      </header>

      {(externalChanged || error) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line-subtle)] bg-[var(--warning-bg)] px-5 py-2 text-xs text-[var(--warning)]">
          <span>{error ?? "章节文件已在外部修改，本地草稿未被覆盖"}</span>
          {externalChanged && (
            <button
              type="button"
              onClick={() => {
                setDraft(chapter.content);
                setSavedDraft(chapter.content);
                setExternalChanged(false);
                setError(null);
              }}
              className="shrink-0 font-medium underline underline-offset-2"
            >
              载入磁盘版本
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "edit" ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            aria-label="章节正文"
            className="mx-auto block min-h-full w-full max-w-3xl resize-none bg-transparent px-10 py-9 text-base leading-[1.9] text-[var(--ink)] outline-none max-md:px-5"
          />
        ) : (
          <div className="mx-auto max-w-3xl whitespace-pre-wrap px-10 py-9 text-base leading-[1.9] text-[var(--ink)] max-md:px-5">
            {draft || (
              <span className="text-[var(--ink-subtle)]">正文为空</span>
            )}
          </div>
        )}
      </div>
      <footer className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-5 text-xs text-[var(--ink-muted)]">
        <span>{isSaved ? "本地已保存" : "有未保存修改"}</span>
        <span>
          {Array.from(draft)
            .filter((character) => !/\s/u.test(character))
            .length.toLocaleString()}{" "}
          字
        </span>
      </footer>
    </article>
  );
}

function Manuscript({
  chapters,
  selectedChapterId,
  onSelectChapter,
  onAddChapter,
  isCreatingChapter,
  onSaveChapter,
  onRenameChapter,
}: {
  chapters: readonly LoadedNovelChapter[];
  selectedChapterId: string;
  onSelectChapter: (id: string) => void;
  onAddChapter: () => void;
  isCreatingChapter: boolean;
  onSaveChapter: (
    chapterId: string,
    content: string,
    expectedContent: string,
  ) => Promise<void>;
  onRenameChapter: (chapterId: string, title: string) => Promise<void>;
}) {
  const orderedChapters = [...chapters].sort(
    (left, right) => right.number - left.number,
  );
  const selectedChapter = chapters.find(
    (chapter) => chapter.id === selectedChapterId,
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper-elevated)]/40 max-lg:w-48 max-md:w-16">
        <div className="flex h-12 items-center justify-between border-b border-[var(--line-subtle)] px-3 max-md:justify-center">
          <span className="text-sm font-semibold text-[var(--ink-muted)] max-md:hidden">
            章节
          </span>
          <button
            type="button"
            onClick={onAddChapter}
            disabled={isCreatingChapter}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
            title="新建章节"
            aria-label="新建章节"
          >
            {isCreatingChapter ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {orderedChapters.map((chapter) => {
            const active = chapter.id === selectedChapter?.id;
            return (
              <button
                key={chapter.id}
                type="button"
                onClick={() => onSelectChapter(chapter.id)}
                aria-label={`第 ${chapter.number} 章 ${chapter.title}`}
                className={`mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors max-md:justify-center max-md:px-1 ${active ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                title={`第 ${chapter.number} 章 ${chapter.title}`}
              >
                <span
                  className={`mt-0.5 w-6 shrink-0 font-mono text-xs ${active ? "text-[var(--accent-warm)]" : "text-[var(--ink-subtle)]"}`}
                >
                  {String(chapter.number).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 max-md:hidden">
                  <span className="block truncate text-sm font-medium">
                    {chapter.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--ink-subtle)]">
                    {chapter.words.toLocaleString()} 字
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {selectedChapter ? (
        <ChapterEditor
          key={selectedChapter.id}
          chapter={selectedChapter}
          onSave={(content, expectedContent) =>
            onSaveChapter(selectedChapter.id, content, expectedContent)
          }
          onRename={(title) => onRenameChapter(selectedChapter.id, title)}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <button
            type="button"
            onClick={onAddChapter}
            disabled={isCreatingChapter}
            className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
          >
            {isCreatingChapter ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            新建第一章
          </button>
        </div>
      )}
    </div>
  );
}

function OutlineEditor({
  content,
  onSave,
}: {
  content: string;
  onSave: (content: string, expectedContent: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(content);
  const [savedDraft, setSavedDraft] = useState(content);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [isSaving, setIsSaving] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSaved = draft === savedDraft;

  useEffect(() => {
    if (content === savedDraft) return;
    if (draft === savedDraft) {
      setDraft(content);
      setSavedDraft(content);
      setExternalChanged(false);
    } else {
      setExternalChanged(true);
    }
  }, [content, draft, savedDraft]);

  const save = async () => {
    if (isSaved || isSaving) return;
    setError(null);
    setIsSaving(true);
    try {
      await onSave(draft, savedDraft);
      setSavedDraft(draft);
      setExternalChanged(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line-subtle)] px-6 py-2">
        <div>
          <h1 className="text-base font-semibold text-[var(--ink)]">
            故事大纲
          </h1>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            outline/outline.md
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-[var(--paper-inset)] p-0.5">
            {(["edit", "preview"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${mode === item ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)]"}`}
              >
                {item === "edit" ? "编辑" : "预览"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSaved || isSaving}
            title={isSaved ? "已保存" : "保存大纲"}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-45"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isSaved ? (
              <Check className="h-3.5 w-3.5 text-[var(--success)]" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span className="max-sm:hidden">
              {isSaving ? "保存中" : isSaved ? "已保存" : "保存"}
            </span>
          </button>
        </div>
      </header>
      {(externalChanged || error) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line-subtle)] bg-[var(--warning-bg)] px-6 py-2 text-xs text-[var(--warning)]">
          <span>{error ?? "大纲文件已在外部修改，本地草稿未被覆盖"}</span>
          {externalChanged && (
            <button
              type="button"
              onClick={() => {
                setDraft(content);
                setSavedDraft(content);
                setExternalChanged(false);
                setError(null);
              }}
              className="shrink-0 font-medium underline underline-offset-2"
            >
              载入磁盘版本
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "edit" ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            aria-label="故事大纲"
            className="mx-auto block min-h-full w-full max-w-4xl resize-none bg-transparent px-10 py-9 font-mono text-sm leading-7 text-[var(--ink)] outline-none max-md:px-5"
          />
        ) : (
          <div className="mx-auto max-w-4xl whitespace-pre-wrap px-10 py-9 text-base leading-8 text-[var(--ink)] max-md:px-5">
            {draft}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyDomainView({
  icon: Icon,
  title,
  emptyText,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  emptyText: string;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-7 py-6 max-md:px-4">
      <header className="border-b border-[var(--line-subtle)] pb-5">
        <h1 className="text-xl font-semibold text-[var(--ink)]">{title}</h1>
      </header>
      <div className="flex min-h-80 flex-col items-center justify-center text-[var(--ink-muted)]">
        <Icon className="h-5 w-5" />
        <p className="mt-3 text-sm">{emptyText}</p>
      </div>
    </div>
  );
}

function ContextInspector({
  route,
  project,
  chapter,
  isRefreshing,
}: {
  route: string;
  project: LoadedNovelProject;
  chapter: LoadedNovelChapter | undefined;
  isRefreshing: boolean;
}) {
  const totalWords = project.chapters.reduce(
    (sum, item) => sum + item.words,
    0,
  );
  const routeMeta = {
    overview: {
      icon: BookMarked,
      label: "项目快照",
      title: project.metadata.genres.join(" · "),
    },
    manuscript: {
      icon: FileText,
      label: "章节信息",
      title: chapter ? `第 ${chapter.number} 章` : "暂无章节",
    },
    outline: { icon: ListTree, label: "大纲文件", title: "outline.md" },
    lore: { icon: Users, label: "设定数据", title: "人物与世界" },
    map: { icon: Map, label: "地图数据", title: "世界空间模型" },
    timeline: { icon: Clock3, label: "时间线数据", title: "事件与线索" },
    research: { icon: Library, label: "资料数据", title: "研究资料" },
  }[route] ?? { icon: Map, label: "当前上下文", title: project.metadata.title };
  const Icon = routeMeta.icon;

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-[var(--line-subtle)] bg-[var(--paper-elevated)]/55 px-5 py-5 max-xl:hidden">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-muted)]">
        <Icon className="h-4 w-4" />
        {routeMeta.label}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-[var(--ink)]">
        {routeMeta.title}
      </h2>
      <div className="mt-5 space-y-4 border-t border-[var(--line-subtle)] pt-5">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--ink-muted)]">文件状态</span>
          <span
            className={`inline-flex items-center gap-1 ${isRefreshing ? "text-[var(--ink-muted)]" : "text-[var(--success)]"}`}
          >
            {isRefreshing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {isRefreshing ? "刷新中" : "已读取"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--ink-muted)]">章节</span>
          <span className="text-[var(--ink)]">{project.chapters.length}</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--ink-muted)]">正文</span>
          <span className="text-[var(--ink)]">
            {totalWords.toLocaleString()} 字
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--ink-muted)]">目标</span>
          <span className="text-[var(--ink)]">
            {project.metadata.targetWordCount === null
              ? "未设置"
              : `${formatTargetWordCount(project.metadata.targetWordCount)} 万字`}
          </span>
        </div>
      </div>
      <div className="mt-6 border-t border-[var(--line-subtle)] pt-5">
        <SectionLabel>项目标识</SectionLabel>
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
          <Hash className="h-3.5 w-3.5" /> novel.schema/
          {project.metadata.schemaVersion}
        </div>
        <p
          className="mt-2 truncate font-mono text-xs text-[var(--ink-subtle)]"
          title={project.metadata.projectId}
        >
          {project.metadata.projectId}
        </p>
      </div>
    </aside>
  );
}

export default function NovelWorkbenchRenderer({
  context,
}: WorkbenchRendererProps) {
  const controller = useNovelProject(context.storage, context.isActive);
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [isWorldAgentLaunching, setIsWorldAgentLaunching] = useState(false);
  const [isProposalReviewOpen, setIsProposalReviewOpen] = useState(false);
  const [aiRun, setAiRun] = useState<{
    readonly target: NovelAiAssistTarget;
    readonly status: "preparing" | "running" | "ready" | "error";
    readonly output?: string;
    readonly error?: string;
  } | null>(null);
  const project = controller.project;

  const selectedChapter = useMemo(() => {
    if (!project?.chapters.length) return undefined;
    return (
      project.chapters.find((chapter) => chapter.id === selectedChapterId) ??
      [...project.chapters].sort((left, right) => right.number - left.number)[0]
    );
  }, [project, selectedChapterId]);
  const effectiveSelectedChapterId = selectedChapter?.id ?? "";

  if (!project && controller.isLoading) return <ProjectLoadingState />;
  if (!project) {
    return (
      <ProjectErrorState
        error={controller.error ?? "项目文件不存在或无法读取"}
        onRetry={() => void controller.reload()}
      />
    );
  }

  const createChapter = async () => {
    setOperationError(null);
    try {
      const chapterId = await controller.createChapter();
      setSelectedChapterId(chapterId);
      context.navigate("manuscript");
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openChapter = (chapterId: string) => {
    setSelectedChapterId(chapterId);
    context.navigate("manuscript");
  };

  const launchWorldAgent = async (mode: "world" | "template") => {
    if (isWorldAgentLaunching) return;
    setOperationError(null);
    setIsWorldAgentLaunching(true);
    try {
      const promptLibrary = await createNovelPromptLibraryRepository(
        context.storage,
      ).load();
      const selection = selectPromptForExecution(
        resolvePromptSet(promptLibrary.model, project.metadata.genres),
        "novel.world.guide",
      );
      if (selection.status === "missing") {
        throw new Error("未找到已配置的“世界架构向导”提示词");
      }
      if (selection.status === "inactive") {
        const reasons = selection.activations
          .map((activation) => activation.reason)
          .join("；");
        throw new Error(`“世界架构向导”当前不可执行：${reasons}`);
      }
      if (selection.status === "conflict") {
        throw new Error(
          "“世界架构向导”存在多个启用副本，请先在提示词的当前启用集中解决冲突",
        );
      }

      const isTemplateMode = mode === "template";
      const domainPrompt = renderPromptTemplate(
        selection.activation.prompt.content,
        {
          target: isTemplateMode
            ? "通过多轮对话完善层级类型、设定模板和类型模板关联"
            : "从一句话概念开始，通过多轮对话引导作者创建完整世界架构",
          outputSchema: isTemplateMode
            ? "先逐步澄清模板覆盖范围，最终给出可审阅的 meta.json 变更方案"
            : "先逐步澄清作者选择，最终给出可审阅的层级类型、模板配置、空间树与设定页变更方案",
          context: JSON.stringify(
            {
              title: project.metadata.title,
              genres: project.metadata.genres,
              projectRoot: ".",
              settingLibrary: "world/setting-library/",
              promptId: selection.activation.prompt.id,
              promptVersion: selection.activation.prompt.version,
            },
            null,
            2,
          ),
          userInstruction: isTemplateMode
            ? "先请作者说明模板服务的世界层级或创作目标。一次只推进必要的关键决定；未获得作者确认前不要提交提案。"
            : "先请作者用一句话描述世界。一次只推进必要的关键决定；未获得作者确认前不要提交提案。",
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、"),
          dimension: isTemplateMode ? "设定模板配置" : "完整世界架构",
          worldContext: JSON.stringify(
            {
              title: project.metadata.title,
              genres: project.metadata.genres,
              projectRoot: ".",
              settingLibrary: "world/setting-library/",
            },
            null,
            2,
          ),
          worldRulesContext: "",
          userHint: isTemplateMode
            ? "围绕层级类型、模板骨架和默认关联逐步完善配置。一次只推进必要的关键决定。"
            : "从一句话概念开始，通过多轮对话引导作者完成层级类型、模板配置、空间树和设定页设计。一次只推进必要的关键决定。",
          isSummary: "",
          usesTone: "1",
          tone: "史诗且严谨",
          usesDetailLevel: "1",
          detailLevel: "详尽",
        },
      );
      const initialMessage = `${domainPrompt}\n\n${buildWorldProposalAgentInstructions()}`;
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `${isTemplateMode ? "模板配置向导" : "世界架构向导"} · ${project.metadata.title}`,
        promptId: selection.activation.prompt.id,
        initialMessage,
        presentation: "dialog",
        conversationKey: isTemplateMode
          ? "novel.world.template-config"
          : "novel.world.architecture",
        toolset: {
          id: "novel-world",
          context: {
            mode,
            promptId: selection.activation.prompt.id,
            promptVersion: selection.activation.prompt.version,
          },
        },
      });
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsWorldAgentLaunching(false);
    }
  };

  const runAiAssist = async (
    target: NovelAiAssistTarget,
    localContext?: unknown,
  ): Promise<string | null> => {
    if (!context.aiRuns.isAvailable) {
      setOperationError("MyAgents 一次性 AI 生成接口当前不可用");
      return null;
    }
    setAiRun({ target, status: "preparing" });
    try {
      const library = await createNovelSettingLibraryRepository(
        context.storage,
      ).load(project.metadata.title);
      let currentPage: { path: string; content: string } | null = null;
      if (target.kind === "setting-page") {
        const setting = library.settingsIndex.settings.find(
          (item) =>
            item.nodeId === target.nodeId && item.id === target.settingId,
        );
        if (setting) {
          currentPage = {
            path: setting.pagePath,
            content: (await context.storage.readText(setting.pagePath)).content,
          };
        }
      }
      const injectedContext = {
        project: {
          title: project.metadata.title,
          genres: project.metadata.genres,
        },
        target,
        world: {
          meta: library.meta,
          spatialTree: library.spatialTree,
          settings: library.settingsIndex,
        },
        currentPage,
        localContext,
      };
      setAiRun({ target, status: "running" });
      const result = await context.aiRuns.run({
        version: WORKBENCH_AI_RUN_REQUEST_VERSION,
        label: target.label,
        systemPrompt:
          "你是小说工作台的字段生成助手。只生成当前目标可直接使用的候选内容，不修改文件，不扩展到无关设定。若目标是结构化实体，输出严格 JSON；若目标是设定页，输出 Markdown 正文。不要使用 Markdown 代码围栏，也不要附加解释。",
        prompt: `请为下列目标生成一个候选结果。\n\n${JSON.stringify(injectedContext, null, 2)}`,
      });
      setAiRun({ target, status: "ready", output: result.output });
      return result.output;
    } catch (cause) {
      setAiRun({
        target,
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
  };

  let content: ReactNode;
  switch (context.route) {
    case "manuscript":
      content = (
        <Manuscript
          chapters={project.chapters}
          selectedChapterId={effectiveSelectedChapterId}
          onSelectChapter={setSelectedChapterId}
          onAddChapter={() => void createChapter()}
          isCreatingChapter={controller.isCreatingChapter}
          onSaveChapter={controller.saveChapter}
          onRenameChapter={controller.renameChapter}
        />
      );
      break;
    case "outline":
      content = (
        <OutlineEditor
          content={project.outlineContent}
          onSave={controller.saveOutline}
        />
      );
      break;
    case "lore":
      content = (
        <div className="h-full min-h-0">
          <SettingLibrary
            storage={context.storage}
            projectTitle={project.metadata.title}
            mode="library"
            onAiAssist={runAiAssist}
          />
          {isProposalReviewOpen && (
            <WorldProposalReview
              storage={context.storage}
              projectTitle={project.metadata.title}
              onClose={() => setIsProposalReviewOpen(false)}
            />
          )}
        </div>
      );
      break;
    case "lore-config":
      content = (
        <div className="h-full min-h-0">
          <SettingLibrary
            storage={context.storage}
            projectTitle={project.metadata.title}
            mode="meta"
            onAiAssist={runAiAssist}
          />
          {isProposalReviewOpen && (
            <WorldProposalReview
              storage={context.storage}
              projectTitle={project.metadata.title}
              onClose={() => setIsProposalReviewOpen(false)}
            />
          )}
        </div>
      );
      break;
    case "map":
      content = <WorldMapPrototype />;
      break;
    case "timeline":
      content = (
        <EmptyDomainView
          icon={Clock3}
          title="时间线"
          emptyText="暂无时间线事件"
        />
      );
      break;
    case "research":
      content = (
        <EmptyDomainView
          icon={Library}
          title="资料库"
          emptyText="暂无研究资料"
        />
      );
      break;
    case "ai-prompts":
      content = (
        <PromptManager
          storage={context.storage}
          projectGenres={project.metadata.genres}
          isActive={context.isActive}
        />
      );
      break;
    default:
      content = (
        <Overview
          project={project}
          onOpenChapter={openChapter}
          onCreateChapter={() => void createChapter()}
          isCreatingChapter={controller.isCreatingChapter}
        />
      );
  }

  const isImmersiveRoute = [
    "lore",
    "lore-config",
    "map",
    "ai-prompts",
  ].includes(context.route);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      {(context.route === "lore" || context.route === "lore-config") && (
        <WorkbenchHeaderActions>
          <button
            type="button"
            aria-label="审阅提案"
            title="审阅 Agent 提交的世界设定变更"
            onClick={() => setIsProposalReviewOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium transition-colors hover:bg-[var(--hover-bg)]"
          >
            <GitCompareArrows className="h-4 w-4 text-[var(--accent-cool)]" />
            <span className="max-lg:hidden">审阅提案</span>
          </button>
          <WorldAgentButton
            disabled={!context.agentSessions.isAvailable}
            isLaunching={isWorldAgentLaunching}
            label={
              context.route === "lore-config" ? "AI 配置模板" : "AI 创建世界"
            }
            title={
              context.route === "lore-config"
                ? "打开模板配置 Agent"
                : "打开世界架构 Agent"
            }
            onClick={() =>
              void launchWorldAgent(
                context.route === "lore-config" ? "template" : "world",
              )
            }
          />
        </WorkbenchHeaderActions>
      )}
      {!isImmersiveRoute && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-5 text-xs text-[var(--ink-muted)]">
          <div className="flex min-w-0 items-center gap-2">
            <BookMarked className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
            <span className="truncate">{project.metadata.title}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ink-subtle)]" />
            <span className="shrink-0">本地项目</span>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-1 text-[var(--success)] max-md:hidden">
            {controller.isRefreshing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {controller.isRefreshing ? "正在刷新" : "文件已读取"}
          </div>
        </div>
      )}
      {(operationError || controller.error) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-xs text-[var(--error)]">
          <span>{operationError ?? controller.error}</span>
          <button
            type="button"
            onClick={() => {
              setOperationError(null);
              void controller.reload();
            }}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            重新读取
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">{content}</div>
        {!isImmersiveRoute && (
          <ContextInspector
            route={context.route}
            project={project}
            chapter={selectedChapter}
            isRefreshing={controller.isRefreshing}
          />
        )}
      </div>
      {aiRun && (
        <CompactAiRunWindow
          label={aiRun.target.label}
          status={aiRun.status}
          output={aiRun.output}
          error={aiRun.error}
          onRetry={() => void runAiAssist(aiRun.target)}
          onExpand={() =>
            void launchWorldAgent(
              context.route === "lore-config" ? "template" : "world",
            )
          }
          onClose={() => setAiRun(null)}
        />
      )}
    </div>
  );
}
