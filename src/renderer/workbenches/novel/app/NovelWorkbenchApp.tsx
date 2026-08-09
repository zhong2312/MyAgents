import "../NovelControls.css";

import {
  AlertTriangle,
  ArrowRight,
  BookMarked,
  Check,
  ChevronRight,
  FileText,
  GitCompareArrows,
  Hash,
  Library,
  Loader2,
  Map,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  subscribeWorkbenchHostAction,
  WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
  WORKBENCH_AI_RUN_REQUEST_VERSION,
  type WorkbenchRendererProps,
} from "@/workbench-sdk";

import type { NovelChapterStatus, NovelMetadata } from "../projectSchema";
import NovelProjectSettingsDialog from "../NovelProjectSettingsDialog";
import { estimateChapterRange, formatWordCountInWan } from "../projectPlanning";
import {
  CharacterLibraryPrototype,
  type CharacterAiTarget,
} from "../modules/characters";
import NovelModelScenarioSettings from "../NovelModelScenarioSettings";
import PromptManager from "../PromptManager";
import { createNovelPromptLibraryRepository } from "../promptLibraryRepository";
import { resolveScenePromptOverride } from "../promptSceneOverride";
import ResearchLibrary from "../ResearchLibrary";
import {
  renderPromptTemplate,
  resolvePromptSet,
  selectPromptForExecution,
} from "../promptLibraryResolver";
import type { LoadedNovelChapter, LoadedNovelProject } from "../repository";
import SettingLibrary from "../SettingLibrary";
import ItemLibrary from "../ItemLibrary";
import FactionLibrary, {
  type FactionAiTarget,
} from "../modules/factions/views/FactionLibrary";
import CultivationEcologyWorkbench, {
  type CultivationAiRunRequest,
} from "../CultivationEcologyWorkbench";
import KnowledgeBase from "../KnowledgeBase";
import TimelineLibrary from "../TimelineLibrary";
import type { TimelineAiAgentRequest } from "../timelineAi";
import NarrativeEngineering from "../NarrativeEngineering";
import type { NarrativeAiAgentRequest } from "../narrativeAi";
import InspirationStudio from "../InspirationStudio";
import type { KnowledgeSourceRef } from "../knowledgeGraph";
import type { NovelAiAssistTarget } from "../aiAssistTypes";
import type { DomainEntityRef } from "../domainIndex";
import { useDomainIndex } from "../useDomainIndex";
import CommandPalette, { type QuickCreateKind } from "../CommandPalette";
import SearchPage from "../SearchPage";
import ManuscriptStudio, {
  type ManuscriptAiAgentRequest,
} from "../ManuscriptStudio";
import { createManuscriptAiSettingsRepository } from "../manuscriptAiSettingsRepository";
import MapEditor from "../MapEditor";
import WorldSimulationWorkbench, {
  type WorldSimulationView,
} from "../WorldSimulationWorkbench";
import WorldProposalReview from "../WorldProposalReview";
import { buildWorldProposalAgentInstructions } from "../worldProposalSchema";
import { useNovelProject } from "../useNovelProject";
import {
  getEffectiveModelSceneSelection,
  type NovelModelSceneId,
} from "../modelSceneSettings";
import { createNovelModelSceneSettingsRepository } from "../modelSceneSettingsRepository";
import { appendCultivationPlatformProtocol } from "../cultivationPromptProtocol";

const STATUS_LABELS: Record<NovelMetadata["status"], string> = {
  planning: "规划中",
  writing: "创作中",
  completed: "已完成",
  paused: "已暂停",
};

const CHAPTER_STATUS_LABELS: Record<NovelChapterStatus, string> = {
  draft: "草稿",
  revising: "修订中",
  complete: "完成",
  planned: "待写",
};

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
  onEditProject,
  isCreatingChapter,
}: {
  project: LoadedNovelProject;
  onOpenChapter: (chapterId: string) => void;
  onCreateChapter: () => void;
  onEditProject: () => void;
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
  const wordCountRange =
    project.metadata.targetWordCountMin !== null &&
    project.metadata.targetWordCountMax !== null
      ? `${formatWordCountInWan(project.metadata.targetWordCountMin)} 至 ${formatWordCountInWan(project.metadata.targetWordCountMax)} 万字`
      : "未设置";
  const estimatedChapters =
    project.metadata.targetWordCountMin !== null &&
    project.metadata.targetWordCountMax !== null &&
    project.metadata.chapterWordCount !== null
      ? estimateChapterRange({
          targetWordCountMin: project.metadata.targetWordCountMin,
          targetWordCountMax: project.metadata.targetWordCountMax,
          chapterWordCount: project.metadata.chapterWordCount,
        })
      : null;

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
          {project.metadata.description?.trim() && (
            <p className="mt-3 max-w-3xl whitespace-pre-line text-sm leading-6 text-[var(--ink-secondary)]">
              {project.metadata.description.trim()}
            </p>
          )}
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            项目 {project.metadata.projectName} · 共 {chapters.length} 章 ·
            已完成 {completed} 章 · {totalWords.toLocaleString()} 字
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch">
          <button
            type="button"
            onClick={onEditProject}
            className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
          >
            <Settings2 className="h-3.5 w-3.5" />
            编辑资料
          </button>
          <button
            type="button"
            onClick={() =>
              latestChapter
                ? onOpenChapter(latestChapter.id)
                : onCreateChapter()
            }
            disabled={isCreatingChapter}
            className="flex items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          >
            {isCreatingChapter ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PenLine className="h-3.5 w-3.5" />
            )}
            {latestChapter ? "继续写作" : "开始写作"}
          </button>
        </div>
      </header>

      <dl className="grid grid-cols-4 border-b border-[var(--line-subtle)] max-lg:grid-cols-2 max-sm:grid-cols-1">
        {[
          ["计划字数", wordCountRange],
          [
            "每章字数",
            project.metadata.chapterWordCount === null
              ? "未设置"
              : `${project.metadata.chapterWordCount.toLocaleString()} 字`,
          ],
          [
            "预计章节",
            estimatedChapters
              ? `${estimatedChapters.min.toLocaleString()} 至 ${estimatedChapters.max.toLocaleString()} 章`
              : "待设置",
          ],
          ["已写进度", `${totalWords.toLocaleString()} 字`],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={`py-5 ${index > 0 ? "border-l border-[var(--line-subtle)] pl-5 max-sm:border-l-0 max-sm:pl-0" : "pr-5"}`}
          >
            <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
            <dd className="mt-1 text-sm font-semibold text-[var(--ink)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>

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
                    第 {latestChapter.displayNumber} 章
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
                {String(chapter.displayNumber).padStart(2, "0")}
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
            第 {chapter.displayNumber} 章
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

function _Manuscript({
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
                aria-label={`第 ${chapter.displayNumber} 章 ${chapter.title}`}
                className={`mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors max-md:justify-center max-md:px-1 ${active ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                title={`第 ${chapter.displayNumber} 章 ${chapter.title}`}
              >
                <span
                  className={`mt-0.5 w-6 shrink-0 font-mono text-xs ${active ? "text-[var(--accent-warm)]" : "text-[var(--ink-subtle)]"}`}
                >
                  {String(chapter.displayNumber).padStart(2, "0")}
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
      title: chapter ? `第 ${chapter.displayNumber} 章` : "暂无章节",
    },
    lore: { icon: Users, label: "设定数据", title: "人物与世界" },
    map: { icon: Map, label: "地图数据", title: "世界空间模型" },
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
          <span className="text-[var(--ink-muted)]">计划字数</span>
          <span className="text-right text-[var(--ink)]">
            {project.metadata.targetWordCountMin === null ||
            project.metadata.targetWordCountMax === null
              ? "未设置"
              : `${formatWordCountInWan(project.metadata.targetWordCountMin)} 至 ${formatWordCountInWan(project.metadata.targetWordCountMax)} 万字`}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--ink-muted)]">每章字数</span>
          <span className="text-[var(--ink)]">
            {project.metadata.chapterWordCount === null
              ? "未设置"
              : `${project.metadata.chapterWordCount.toLocaleString()} 字`}
          </span>
        </div>
      </div>
      <div className="mt-6 border-t border-[var(--line-subtle)] pt-5">
        <SectionLabel>项目标识</SectionLabel>
        <p
          className="mt-3 truncate text-sm font-medium text-[var(--ink)]"
          title={project.metadata.projectName}
        >
          {project.metadata.projectName}
        </p>
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
  const domainIndex = useDomainIndex(
    context.storage,
    context.isActive,
    context.projection,
  );
  const [entityFocus, setEntityFocus] = useState<DomainEntityRef | null>(null);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [isWorldAgentLaunching, setIsWorldAgentLaunching] = useState(false);
  const [isItemAgentLaunching, setIsItemAgentLaunching] = useState(false);
  const [isCharacterAgentLaunching, setIsCharacterAgentLaunching] =
    useState(false);
  const [isCultivationAgentLaunching, setIsCultivationAgentLaunching] =
    useState(false);
  const [factionAgentLaunchMode, setFactionAgentLaunchMode] = useState<
    "single" | "batch" | null
  >(null);
  const [isProposalReviewOpen, setIsProposalReviewOpen] = useState(false);
  const [settingLibraryReloadKey, setSettingLibraryReloadKey] = useState(0);
  const [isItemProposalReviewOpen, setIsItemProposalReviewOpen] =
    useState(false);
  const [isCharacterProposalReviewOpen, setIsCharacterProposalReviewOpen] =
    useState(false);
  const [isCultivationProposalReviewOpen, setIsCultivationProposalReviewOpen] =
    useState(false);
  const [knowledgeSourceFocus, setKnowledgeSourceFocus] =
    useState<KnowledgeSourceRef | null>(null);
  const [factionWorldNodeFocusId, setFactionWorldNodeFocusId] = useState<
    string | null
  >(null);
  const project = controller.project;
  const navigateWorkbench = context.navigate;

  useEffect(
    () =>
      subscribeWorkbenchHostAction(
        {
          workbenchId: context.manifest.id,
          workspacePath: context.workspacePath,
          action: "open-proposal-review",
        },
        () => setIsProposalReviewOpen(true),
      ),
    [context.manifest.id, context.workspacePath],
  );

  useEffect(
    () =>
      subscribeWorkbenchHostAction(
        {
          workbenchId: context.manifest.id,
          workspacePath: context.workspacePath,
          action: "open-item-proposal-review",
        },
        () => {
          navigateWorkbench("items");
          setIsItemProposalReviewOpen(true);
        },
      ),
    [context.manifest.id, context.workspacePath, navigateWorkbench],
  );

  useEffect(
    () =>
      subscribeWorkbenchHostAction(
        {
          workbenchId: context.manifest.id,
          workspacePath: context.workspacePath,
          action: "open-character-proposal-review",
        },
        () => {
          navigateWorkbench("characters");
          setIsCharacterProposalReviewOpen(true);
        },
      ),
    [context.manifest.id, context.workspacePath, navigateWorkbench],
  );

  useEffect(
    () =>
      subscribeWorkbenchHostAction(
        {
          workbenchId: context.manifest.id,
          workspacePath: context.workspacePath,
          action: "open-cultivation-proposal-review",
        },
        () => {
          navigateWorkbench("powers");
          setIsCultivationProposalReviewOpen(true);
        },
      ),
    [context.manifest.id, context.workspacePath, navigateWorkbench],
  );

  const selectedChapter = useMemo(() => {
    if (!project?.chapters.length) return undefined;
    return (
      project.chapters.find((chapter) => chapter.id === selectedChapterId) ??
      [...project.chapters].sort((left, right) => right.number - left.number)[0]
    );
  }, [project, selectedChapterId]);
  const effectiveSelectedChapterId = selectedChapter?.id ?? "";

  const applyScenePromptOverride = useCallback(
    async (
      promptId: string,
      variables: Readonly<Record<string, string>>,
      buildFallback: () => Promise<string>,
      onResolvedVersion?: (version: string) => void,
    ): Promise<string> => {
      // 提示词库解析失败（如注册表损坏）时回退内置提示词，不阻断 AI 功能
      const override = await resolveScenePromptOverride(
        context.storage,
        promptId,
        project?.metadata.genres ?? [],
        variables,
      ).catch((error) => {
        // 提示词库损坏时保留内置回退，但启用副本冲突必须阻断请求，
        // 否则作者以为正在使用自定义提示词，实际却执行了另一套规则。
        if (
          error instanceof Error &&
          error.message.includes("存在多个启用副本")
        ) {
          throw error;
        }
        return null;
      });
      if (override?.status === "ready") {
        onResolvedVersion?.(override.version);
        return override.content;
      }
      return buildFallback();
    },
    [context.storage, project?.metadata.genres],
  );

  /** 面板快速新建：章节直接创建并定位；其余跳转模块页（模块自带新建入口）。 */
  const quickCreate = useCallback(
    (kind: QuickCreateKind) => {
      if (kind === "chapter") {
        void (async () => {
          setOperationError(null);
          try {
            const chapterId = await controller.createChapter();
            setSelectedChapterId(chapterId);
            context.navigate("manuscript");
          } catch (cause) {
            setOperationError(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
        })();
        return;
      }
      const route =
        kind === "character"
          ? "characters"
          : kind === "faction"
            ? "factions"
            : kind === "item"
              ? "items"
              : kind === "event"
                ? "timeline"
                : kind === "inspiration"
                  ? "inspiration"
                  : "map";
      context.navigate(route);
      setOperationError(null);
    },
    [context, controller],
  );

  /** 统一实体定位入口：跳转到对应 route 并尽力聚焦具体实体。 */
  const openEntity = useCallback(
    (ref: DomainEntityRef) => {
      if (ref.route === "manuscript" && ref.focus.chapterId) {
        setSelectedChapterId(ref.focus.chapterId);
      }
      setEntityFocus(ref);
      context.navigate(ref.route);
    },
    [context],
  );

  if (!project && controller.isLoading) return <ProjectLoadingState />;
  if (!project) {
    return (
      <ProjectErrorState
        error={controller.error ?? "项目文件不存在或无法读取"}
        onRetry={() => void controller.reload()}
      />
    );
  }

  const resolveSceneModelSelection = async (sceneId: NovelModelSceneId) => {
    const settings = await createNovelModelSceneSettingsRepository(
      context.storage,
    ).load();
    return getEffectiveModelSceneSelection(settings.settings, sceneId);
  };

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

  const openKnowledgeSource = (source: KnowledgeSourceRef) => {
    setKnowledgeSourceFocus(source);
    if (source.path.startsWith("manuscript/")) {
      const match = /^manuscript\/chapters\/(\d{6})\.md$/u.exec(source.path);
      if (match) setSelectedChapterId(`chapter-${match[1]}`);
      context.navigate("manuscript");
    } else if (source.path.startsWith("timeline/")) {
      context.navigate("timeline");
    } else if (source.path.startsWith("research/")) {
      context.navigate("research");
    } else if (source.path === "world/setting-library/meta.json") {
      context.navigate("lore-config");
    } else {
      context.navigate("lore");
    }
  };

  const openFactionWorldNode = (nodeId: string) => {
    setFactionWorldNodeFocusId(nodeId);
    context.navigate("lore");
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
            : "从一句话概念开始，通过多轮对话引导作者创建完整世界架构及区域地点",
          outputSchema: isTemplateMode
            ? "先逐步澄清模板覆盖范围，最终给出可审阅的 meta.json 变更方案"
            : "先逐步澄清作者选择，最终给出可审阅的层级类型、模板配置、空间树、区域地点与设定页变更方案",
          context:
            "正式世界事实不在提示词中展开；请按需调用小说工作台内置工具 novel_world_get_context 读取。",
          userInstruction: isTemplateMode
            ? "先请作者说明模板服务的世界层级或创作目标。一次只推进必要的关键决定；未获得作者确认前不要提交提案。"
            : "先请作者用一句话描述世界。一次只推进必要的关键决定；未获得作者确认前不要提交提案。",
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、"),
          dimension: isTemplateMode ? "设定模板配置" : "完整世界架构",
          worldContext:
            "正式世界事实不在提示词中展开；请按需调用小说工作台内置工具 novel_world_get_context 读取。",
          worldRulesContext: "",
          userHint: isTemplateMode
            ? "围绕层级类型、模板骨架和默认关联逐步完善配置。一次只推进必要的关键决定。"
            : "从一句话概念开始，通过多轮对话引导作者完成层级类型、模板配置、空间树、区域地点和设定页设计。一次只推进必要的关键决定。",
          isSummary: "",
          usesTone: "1",
          tone: "史诗且严谨",
          usesDetailLevel: "1",
          detailLevel: "详尽",
        },
      );
      const initialMessage = `${domainPrompt}\n\n${buildWorldProposalAgentInstructions()}`;
      const modelSelection = await resolveSceneModelSelection(
        isTemplateMode ? "world.template" : "world.architecture",
      );
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `${isTemplateMode ? "模板配置向导" : "世界架构向导"} · ${project.metadata.title}`,
        promptId: selection.activation.prompt.id,
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台任务。",
        presentation: "dialog",
        conversationKey: isTemplateMode
          ? "novel.world.template-config"
          : "novel.world.architecture",
        historyGroupPath: isTemplateMode
          ? ["设定模板", "模板配置"]
          : ["世界架构", "创建世界"],
        toolset: {
          id: "novel-world",
          context: {
            mode,
            promptId: selection.activation.prompt.id,
            promptVersion: selection.activation.prompt.version,
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsWorldAgentLaunching(false);
    }
  };

  const launchCharacterAgent = async (target: CharacterAiTarget) => {
    if (isCharacterAgentLaunching) return;
    if (!context.agentSessions.isAvailable) {
      throw new Error("MyAgents Agent Session 当前不可用");
    }
    const scopeLabels: Record<CharacterAiTarget["scope"], string> = {
      character: "角色设计",
      relationship: "关系与弧光设计",
      soul: "角色灵魂设计",
      race: "种族设计",
      group: "角色分组设计",
    };
    const sceneIds: Record<CharacterAiTarget["scope"], NovelModelSceneId> = {
      character: "characters.design",
      relationship: "characters.relationship",
      soul: "characters.soul",
      race: "characters.race",
      group: "characters.group",
    };
    const focus = scopeLabels[target.scope];
    setOperationError(null);
    setIsCharacterAgentLaunching(true);
    try {
      const initialMessage = await applyScenePromptOverride(
        "novel.characters.assist",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: `${focus}${target.requirements ? `；作者要求：${target.requirements}` : ""}`,
        },
        async () => `## 小说工作台人物库 AI 设计任务

你正在协助作者设计小说人物库。正式角色文件是事实源；你只能读取上下文并提交待审阅提案，绝对不能直接修改正式文件。

项目：${project.metadata.title}
创作题材：${project.metadata.genres.join("、") || "未设置"}
本次范围：${focus}
${target.targetCharacterId ? `当前角色 id：${target.targetCharacterId}` : "当前未指定已有角色。"}
作者要求：${target.requirements || "请先通过简洁对话确认本次设计的必要约束。"}

执行协议：
1. 首先调用 novel_characters_get_context，读取已有角色、种族、分组、灵魂，以及当前范围的必要信息；涉及角色修行、境界、法门、能力或修行限制时，再调用 novel_cultivation_get_context 读取稳定 ID 和规则，禁止用自由文本臆造修行引用。
2. 通过简洁对话确认叙事功能、避免重复的约束和本次生成数量；一次只追问影响结果的关键问题。若作者已给出充分要求，可直接生成候选。
3. 只生成与“${focus}”相关的候选。允许新增或更新，但禁止删除既有角色、种族、分组或灵魂。
4. 每次只处理少量候选。新角色、种族、分组和灵魂可先提交本次确认的字段，服务端会补齐可编辑的基础骨架；如需补充同一候选，使用同一个 candidateId 再次写入草稿。提交前仍必须补齐关系和物品引用：raceId、soulId、groupIds、关系 targetId 只能引用已有记录或同一草稿候选；物品栏关联物品库时 itemId 必须存在，不关联时设为 null。
5. 角色灵魂只能提供表达、心智模型和决策倾向；不得覆盖人物硬设定、当前剧情、角色认知和因果。发现冲突时，人物设定优先。
6. 作者确认后先调用 novel_characters_create_draft；再用 novel_characters_upsert_draft_operations 分批写入候选。工具中断或会话恢复时先调用 novel_characters_get_draft，继续同一草稿。
7. 完成后调用 novel_characters_validate_draft；只能使用返回的 validationToken 调用 novel_characters_submit_draft。随后调用 novel_characters_get_proposal_status，只有 exists=true 才能告知作者已提交。可按需使用普通命令和文件工具读取外部素材或处理辅助文件；正式角色变更仍必须通过上述提案协议。`,
      );
      const targetKey = `${target.scope}:${target.targetCharacterId ?? "library"}`;
      const modelSelection = await resolveSceneModelSelection(
        sceneIds[target.scope],
      );
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `${focus} · ${project.metadata.title}`,
        promptId: "novel.characters.assist",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台人物任务。",
        presentation: "dialog",
        conversationKey: `novel.characters.assist:${targetKey}`,
        forceNew: true,
        historyGroupPath: ["人物库", focus],
        toolset: {
          id: "novel-world",
          context: {
            mode: "characters",
            promptId: "novel.characters.assist",
            promptVersion: "1.0.0",
            targetScope: target.scope,
            targetCharacterId: target.targetCharacterId ?? "",
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } finally {
      setIsCharacterAgentLaunching(false);
    }
  };

  const launchCultivationAgent = async () => {
    if (isCultivationAgentLaunching) return;
    if (!context.agentSessions.isAvailable) {
      throw new Error("MyAgents Agent Session 当前不可用");
    }
    setOperationError(null);
    setIsCultivationAgentLaunching(true);
    try {
      let cultivationPromptVersion = "1.0.0";
      const cultivationPrompt = await applyScenePromptOverride(
        "novel.cultivation.assist",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: "修行体系逻辑审查与共创",
        },
        async () => `## 小说工作台修行体系逻辑审查与提案任务

你正在协助作者审查和共创修行生态。请把提示词当作工作方法引导，把正式事实和当前状态交给小说工作台内置工具读取。

执行引导：
1. 首先调用 novel_cultivation_get_context，读取当前修行生态和 sourceHash；不要用自由文本臆造体系、轨道、阶段、法门、能力、资源、阵法、跃迁或约束 ID。
2. 按“世界本源投影 -> 理论节点 -> 成长轨道/阶段 -> 资源与法门课程 -> 能力训练与释放 -> 阵法部署 -> 突破/转换 -> 体系约束 -> 角色引用”的逻辑链检查闭合关系。
3. 明确区分事实、结构问题、语义冲突和可选创作建议；每条问题写清影响对象、稳定 ID、原因和建议动作。
4. 重点检查阶段侧法门/能力/资源关联与资产侧 coverage、unlock、usableLevelIds 是否一致，运行拓扑是否只引用理论节点，跨体系关系是否声明转换规则、边界和风险。
5. 需要项目设定或外部素材时，先明确要解决的问题，再按需读取相关内容；不要为了遍历工具而无目的地扫描文件。`,
        (version) => {
          cultivationPromptVersion = version;
        },
      );
      const initialMessage = appendCultivationPlatformProtocol(cultivationPrompt);
      const modelSelection =
        await resolveSceneModelSelection("cultivation.assist");
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `修行体系逻辑共创 · ${project.metadata.title}`,
        promptId: "novel.cultivation.assist",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台修行体系任务。",
        presentation: "dialog",
        conversationKey: "novel.cultivation.assist",
        historyGroupPath: ["修行体系", "逻辑共创"],
        forceNew: true,
        toolset: {
          id: "novel-world",
          context: {
            mode: "cultivation",
            promptId: "novel.cultivation.assist",
            promptVersion: cultivationPromptVersion,
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsCultivationAgentLaunching(false);
    }
  };

  const launchFactionAgent = async (target: FactionAiTarget) => {
    if (factionAgentLaunchMode) return;
    if (!context.agentSessions.isAvailable) {
      throw new Error("MyAgents Agent Session 当前不可用");
    }
    const scopeLabels: Record<FactionAiTarget["scope"], string> = {
      organization: "组织架构设计",
      relations: "势力关系设计",
      resources: "资源与产业设计",
      rights: "权限与法统设计",
      history: "势力演化梳理",
    };
    const sceneIds: Record<FactionAiTarget["scope"], NovelModelSceneId> = {
      organization: "factions.organization",
      relations: "factions.relations",
      resources: "factions.resources",
      rights: "factions.rights",
      history: "factions.history",
    };
    const focus = scopeLabels[target.scope];
    setOperationError(null);
    setFactionAgentLaunchMode("single");
    try {
      const initialMessage = await applyScenePromptOverride(
        "novel.factions.assist",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: `${focus}${target.requirements ? `；作者要求：${target.requirements}` : ""}`,
        },
        async () => `## 小说工作台势力组织 AI 设计任务

你正在协助作者完善小说势力组织。当前目标是“${focus}”。

项目：${project.metadata.title}
创作题材：${project.metadata.genres.join("、") || "未设置"}
当前势力 id：${target.targetFactionId ?? "未指定"}
作者要求：${target.requirements || "先读取当前势力及直接关联势力，再给出可编辑的建议。"}

执行边界：
1. 只分析当前势力、它的直接关联势力、关联地盘、成员、资源与时间线事件；禁止对全库做 N×N 关系或冲突分析。
2. 组织层级必须区分势力内部单元与对外独立势力：堂口、分支、官署、商号归入内部组织树；隶属、联盟、敌对、竞争、依附使用势力关系。
3. 资源建议必须写清控制权等级、争夺方和变化原因；法统、名分、通行权、采购权等必须写明授予方、范围、条件和有效状态。
4. 势力库只保存当前状态快照；历史事件应建议作者关联或补充到时间线，不能制造第二份相互矛盾的历史。
5. 作者确认候选后调用 novel_factions_create_draft 创建草稿，用 novel_factions_upsert_draft_operations 分批写入候选，novel_factions_validate_draft 校验通过后用返回的 validationToken 调用 novel_factions_submit_draft；随后调用 novel_factions_get_proposal_status 确认 exists=true，再告知作者在势力组织页点击“审阅提案”。不得直接修改项目文件。`,
      );
      const modelSelection = await resolveSceneModelSelection(
        sceneIds[target.scope],
      );
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `${focus} · ${project.metadata.title}`,
        promptId: "novel.factions.assist",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台势力任务。",
        presentation: "dialog",
        conversationKey: `novel.factions.assist:${target.scope}:${target.targetFactionId ?? "library"}`,
        forceNew: true,
        historyGroupPath: ["势力组织", focus],
        toolset: {
          id: "novel-world",
          context: {
            mode: "factions",
            promptId: "novel.factions.assist",
            promptVersion: "1.0.0",
            targetScope: target.scope,
            targetFactionId: target.targetFactionId ?? "",
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } finally {
      setFactionAgentLaunchMode(null);
    }
  };

  const launchFactionBatchAgent = async () => {
    if (factionAgentLaunchMode) return;
    if (!context.agentSessions.isAvailable) {
      throw new Error("MyAgents Agent Session 当前不可用");
    }
    setOperationError(null);
    setFactionAgentLaunchMode("batch");
    try {
      const initialMessage = await applyScenePromptOverride(
        "novel.factions.batch",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: "势力批量设计",
        },
        async () => `## 小说工作台势力批量设计任务

你正在协助作者批量设计小说势力组织。只能提交待作者审阅的势力提案，绝对不能直接修改正式势力库文件。

项目：${project.metadata.title}
创作题材：${project.metadata.genres.join("、") || "未设置"}

执行协议：
1. 首先调用 novel_factions_get_context 读取现有势力摘要；再通过简洁对话确认本批需要新增或补充的势力类型、数量（1 至 10）、叙事阶段、地域范围和冲突方向；一次只追问影响结果的关键问题。
2. 设计时必须避开现有势力与同批候选的名称、功能和资源控制重复；优先补足世界格局中的空位，而不是机械堆叠组织。
3. 每个候选至少提供：名称、势力类型、当前状态、势力概要、核心目标、组织层级、关键成员类别、控制地盘或资源、对外关系、权限或名分，以及可接入时间线的演化钩子。
4. 势力内部单元与独立势力关系必须区分：堂口、官署、分号、支脉属于组织层级；隶属、联盟、敌对、竞争、依附属于势力关系。禁止做全库 N×N 关系或冲突分析。
5. 作者确认候选后调用 novel_factions_create_draft 创建草稿，用 novel_factions_upsert_draft_operations 分批写入候选，novel_factions_validate_draft 校验通过后用返回的 validationToken 调用 novel_factions_submit_draft；随后调用 novel_factions_get_proposal_status 确认 exists=true，再告知作者在势力组织页点击“审阅提案”。可按需使用普通命令和文件工具读取外部素材或处理辅助文件；正式势力变更仍必须通过上述提案协议。`,
      );
      const modelSelection = await resolveSceneModelSelection("factions.batch");
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `势力批量设计 · ${project.metadata.title}`,
        promptId: "novel.factions.batch",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台势力批量设计任务。",
        presentation: "dialog",
        conversationKey: "novel.factions.batch",
        forceNew: true,
        historyGroupPath: ["势力组织", "批量设计"],
        toolset: {
          id: "novel-world",
          context: {
            mode: "factions",
            promptId: "novel.factions.batch",
            promptVersion: "1.0.0",
            targetScope: "batch",
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } finally {
      setFactionAgentLaunchMode(null);
    }
  };

  const launchItemBatchAgent = async (preferredCategoryId?: string) => {
    if (isItemAgentLaunching) return;
    if (!context.agentSessions.isAvailable) {
      throw new Error("MyAgents Agent Session 当前不可用");
    }
    setOperationError(null);
    setIsItemAgentLaunching(true);
    try {
      const initialMessage = await applyScenePromptOverride(
        "novel.items.batch",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: preferredCategoryId
            ? `作者当前选中的分类 ID：${preferredCategoryId}`
            : "作者尚未指定目标分类。",
        },
        async () => `## 小说工作台物品批量生产向导

你正在协助作者批量设计并生产小说物品。使用完整 MyAgents 对话逐步确认需求，最终只能提交待审阅提案，不得直接修改正式物品库。

项目：${project.metadata.title}
${preferredCategoryId ? `作者当前选中的分类 ID：${preferredCategoryId}` : "作者尚未指定目标分类。"}

执行协议：
1. 首先调用 novel_items_get_context 读取分类与已有物品；若作者当前选中了分类，可优先围绕该分类询问，但不能替作者做最终选择。
2. 通过简洁对话确认目标分类、数量（1 至 20）、用途、风格和必要约束。一次只追问影响结果的关键问题。
3. 分类确认后，再调用 novel_items_get_context 并传入 categoryId，严格按照返回的继承字段生成候选。
4. 候选名称不得与已有物品或同批候选重复；字段只能使用返回的 fieldId，并遵守类型、选项和必填约束。
5. 每件候选应包含名称、别名、标签、一句话摘要、适用字段和完整 Markdown 描述。
6. 作者确认生成方向后，先调用 novel_items_create_draft，再用 novel_items_upsert_draft_items 分批写入候选。工具中断或会话恢复时必须先调用 novel_items_get_draft，继续同一草稿。
7. 完成后调用 novel_items_validate_draft；只能使用返回的 validationToken 调用 novel_items_submit_draft。随后调用 novel_items_get_proposal_status，只有 exists=true 才能说明候选已经提交，并提示作者回到物品库点击“审阅批量物品提案”。可按需使用普通命令和文件工具读取外部素材或处理辅助文件；正式物品变更仍必须通过上述提案协议。`,
      );
      const modelSelection = await resolveSceneModelSelection("items.batch");
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `物品批量生产 · ${project.metadata.title}`,
        promptId: "novel.items.batch",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台物品批量生产任务。",
        presentation: "dialog",
        conversationKey: "novel.items.batch",
        historyGroupPath: ["物品库", "批量生产"],
        toolset: {
          id: "novel-world",
          context: {
            mode: "items",
            promptId: "novel.items.batch",
            promptVersion: "1.0.0",
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } finally {
      setIsItemAgentLaunching(false);
    }
  };

  const runAiAssist = async (
    target: NovelAiAssistTarget,
    localContext?: unknown,
  ): Promise<string | null> => {
    if (!context.agentSessions.isAvailable) {
      setOperationError("MyAgents Agent Session 当前不可用");
      return null;
    }
    setOperationError(null);
    try {
      const hasUnsavedDraft = Boolean(
        localContext &&
          typeof localContext === "object" &&
          !Array.isArray(localContext) &&
          typeof (localContext as Record<string, unknown>).currentDraft ===
            "string",
      );
      const targetKey =
        target.kind === "setting-page" || target.kind === "spatial-children"
          ? `${target.kind}:${target.nodeId}${
              target.kind === "setting-page" ? `:${target.settingId}` : ""
            }`
          : target.kind === "world"
            ? "world"
            : `${target.kind}:${target.entityId}`;
      const initialMessage = await applyScenePromptOverride(
        "novel.ai-assist",
        {
          projectName: project.metadata.title,
          genres: project.metadata.genres.join("、") || "未设置",
          requirement: target.label,
        },
        async () => `## 小说工作台单项 AI 任务

作者已点击“AI 写作”，请直接为当前目标生成可审批候选，不要再次询问是否开始。

目标：${target.label}
目标标识：${JSON.stringify(target)}
${hasUnsavedDraft ? "当前页面存在未保存草稿；不得假设工具读取到该草稿，先请作者保存或明确放弃。" : "当前页面没有由工作台传入的未保存草稿。"}

执行规则：
1. 先调用 novel_world_get_context，按目标标识读取已保存的世界架构事实；只读取当前目标以及保证 settings.json 引用闭合所必需的关联文件，不扩展无关设定。
2. 如果当前页面存在未保存草稿，禁止继续创建草稿覆盖页面修改；请作者先保存页面或明确放弃草稿。
3. 现有文件使用 modify；虚拟设定页尚未落盘时，同时创建页面、词条文件并修改 settings.json 登记引用。
4. 先调用 novel_world_create_draft，再用 novel_world_upsert_draft_changes 写入候选；会话恢复或失败后先调用 novel_world_get_draft。
5. 生成完成后必须先调用 novel_world_validate_draft，再使用 validationToken 调用 novel_world_submit_draft，最后调用 novel_world_get_proposal_status 确认 exists=true。
6. 不得直接修改正式文件。提交成功后简要说明结果，并提示作者在小说工作台审阅提案。`,
      );
      const runId = `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const modelSelection = await resolveSceneModelSelection("world.assist");
      await context.agentSessions.open({
        version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
        title: `${target.label} · AI 写作`,
        promptId: "novel.ai-assist",
        systemPrompt: initialMessage,
        initialMessage: "请开始执行当前小说工作台设定任务。",
        presentation: "dock",
        conversationKey: `novel.ai-assist:${targetKey}:${runId}`,
        forceNew: true,
        historyGroupPath: ["世界架构", target.label],
        toolset: {
          id: "novel-world",
          context: {
            mode: "assist",
            promptId: "novel.ai-assist",
            promptVersion: "1.0.0",
            targetKind: target.kind,
            targetKey,
          },
        },
        ...(modelSelection ? { modelSelection } : {}),
      });
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    }
    return null;
  };

  const worldToolbarActions =
    context.route === "lore" || context.route === "lore-config" ? (
      <>
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
      </>
    ) : undefined;

  const cultivationToolbarActions = (
    <>
      <WorldAgentButton
        disabled={!context.agentSessions.isAvailable}
        isLaunching={isCultivationAgentLaunching}
        label="AI 逻辑共创"
        title="打开修行体系逻辑共创 Agent"
        onClick={() => void launchCultivationAgent()}
      />
      <button
        type="button"
        onClick={() => setIsCultivationProposalReviewOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
        title="审阅修行体系待审批提案"
      >
        <GitCompareArrows className="h-4 w-4" />
        <span className="max-lg:hidden">审阅提案</span>
      </button>
    </>
  );

  let content: ReactNode;
  switch (context.route) {
    case "manuscript":
      content = (
        <ManuscriptStudio
          storage={context.storage}
          project={project}
          selectedChapterId={effectiveSelectedChapterId}
          onSelectChapter={setSelectedChapterId}
          isCreatingChapter={controller.isCreatingChapter}
          onCreateChapter={controller.createChapter}
          onUpdateChapter={controller.updateChapter}
          onSaveChapter={controller.saveChapter}
          onRenameChapter={controller.renameChapter}
          onLinkChapterToNarrative={controller.linkChapterToNarrative}
          onCreateDirectory={controller.createDirectory}
          onUpdateDirectory={controller.updateDirectory}
          onDeleteDirectory={controller.deleteDirectory}
          onSetStructureMode={controller.setStructureMode}
          onSynchronizeNarrative={controller.synchronizeNarrative}
          onSaveTypography={controller.saveTypography}
          onDeleteChapter={controller.deleteChapter}
          onRestoreChapter={controller.restoreChapter}
          onDeleteChapterPermanently={controller.deleteChapterPermanently}
          onLoadManuscriptVersions={controller.loadManuscriptVersions}
          onLoadManuscriptVersionSettings={
            controller.loadManuscriptVersionSettings
          }
          onSaveManuscriptVersionLimit={controller.saveManuscriptVersionLimit}
          onRestoreManuscriptVersion={controller.restoreManuscriptVersion}
          onExtractChaptersToNarrative={controller.extractChaptersToNarrative}
          onAdoptSimulation={controller.adoptSimulationPath}
          onAiRun={
            context.aiRuns.isAvailable
              ? async (request) => {
                  const modelSelection = await resolveSceneModelSelection(
                    request.sceneId,
                  );
                  return (
                    await context.aiRuns.run({
                      version: WORKBENCH_AI_RUN_REQUEST_VERSION,
                      label: request.label,
                      prompt: request.prompt,
                      systemPrompt: request.systemPrompt,
                      ...(modelSelection ? { modelSelection } : {}),
                    })
                  ).output;
                }
              : undefined
          }
          onOpenAiAgent={
            context.agentSessions.isAvailable
              ? async (request: ManuscriptAiAgentRequest) => {
                  const [modelSelection, manuscriptAiSettings] =
                    await Promise.all([
                      resolveSceneModelSelection(request.sceneId),
                      createManuscriptAiSettingsRepository(
                        context.storage,
                      ).load(),
                    ]);
                  await context.agentSessions.open({
                    version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
                    title: request.title,
                    promptId: `novel.${request.sceneId}`,
                    systemPrompt: await applyScenePromptOverride(
                      `novel.${request.sceneId}`,
                      {
                        projectName: project.metadata.title,
                        genres: project.metadata.genres.join("、") || "未设置",
                        requirement: request.title,
                      },
                      async () => request.initialMessage,
                    ),
                    initialMessage: request.initialMessage,
                    presentation:
                      manuscriptAiSettings.settings.presentation ===
                      "compact-review"
                        ? "compact-review"
                        : "dialog",
                    conversationKey: request.conversationKey,
                    historyGroupPath: ["正文", request.chapterTitle],
                    forceNew: true,
                    toolset: {
                      id: "novel-world",
                      context: {
                        mode: "manuscript",
                        promptId: `novel.${request.sceneId}`,
                        promptVersion: "1.0.0",
                        runId: request.runId,
                        chapterId: request.chapterId,
                        sceneId: request.sceneId,
                      },
                    },
                    companion: {
                      id: "manuscript-review",
                      context: {
                        runId: request.runId,
                        chapterId: request.chapterId,
                        sceneId: request.sceneId,
                      },
                    },
                    ...(modelSelection ? { modelSelection } : {}),
                  });
                }
              : undefined
          }
          onOpenNarrative={() => context.navigate("narrative")}
          onOpenModelSettings={() => context.navigate("model-scenes")}
          registerNavigationGuard={context.registerNavigationGuard}
        />
      );
      break;
    case "inspiration": {
      content = (
        <InspirationStudio
          storage={context.storage}
          focus={entityFocus}
          isActive={context.isActive}
          projectTitle={project.metadata.title}
          onOpenAiAgent={
            context.agentSessions.isAvailable
              ? async (request) => {
                  const scenePromptId = `novel.${request.sceneId}`;
                  const modelSelection = await resolveSceneModelSelection(
                    request.sceneId,
                  );
                  await context.agentSessions.open({
                    version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
                    title: request.title,
                    promptId: scenePromptId,
                    systemPrompt: await applyScenePromptOverride(
                      scenePromptId,
                      {
                        projectName: project.metadata.title,
                        genres: project.metadata.genres.join("、") || "未设置",
                        requirement: request.title,
                      },
                      async () => request.systemPrompt,
                    ),
                    initialMessage: request.initialMessage,
                    presentation: "dialog",
                    conversationKey: request.conversationKey,
                    historyGroupPath: request.historyGroupPath,
                    forceNew: true,
                    toolset: {
                      id: "novel-world",
                      context: {
                        mode: "inspiration",
                        promptId: scenePromptId,
                        promptVersion: "1.0.0",
                      },
                    },
                    ...(modelSelection ? { modelSelection } : {}),
                  });
                }
              : undefined
          }
          registerNavigationGuard={context.registerNavigationGuard}
        />
      );
      break;
    }
    case "narrative":
      content = (
        <NarrativeEngineering
          storage={context.storage}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          chapters={project.chapters}
          isActive={context.isActive}
          onOpenAiAgent={
            context.agentSessions.isAvailable
              ? async (request: NarrativeAiAgentRequest) => {
                  const modelSelection =
                    await resolveSceneModelSelection("narrative.assist");
                  await context.agentSessions.open({
                    version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
                    title: request.title,
                    promptId: "novel.narrative.assist",
                    systemPrompt: await applyScenePromptOverride(
                      "novel.narrative.assist",
                      {
                        projectName: project.metadata.title,
                        genres: project.metadata.genres.join("、") || "未设置",
                        requirement: request.title,
                      },
                      async () => request.systemPrompt,
                    ),
                    initialMessage: request.initialMessage,
                    presentation: "dock",
                    conversationKey: request.conversationKey,
                    historyGroupPath: request.historyGroupPath,
                    forceNew: true,
                    toolset: {
                      id: "novel-world",
                      context: {
                        mode: "narrative",
                        promptId: "novel.narrative.assist",
                        promptVersion: "1.0.0",
                      },
                    },
                    ...(modelSelection ? { modelSelection } : {}),
                  });
                }
              : undefined
          }
          registerNavigationGuard={context.registerNavigationGuard}
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
            headerActions={worldToolbarActions}
            onAiAssist={runAiAssist}
            focusSource={knowledgeSourceFocus}
            focusNodeId={factionWorldNodeFocusId}
            reloadKey={settingLibraryReloadKey}
          />
          {isProposalReviewOpen && (
            <WorldProposalReview
              storage={context.storage}
              projectTitle={project.metadata.title}
              onClose={() => setIsProposalReviewOpen(false)}
              onApplied={() =>
                setSettingLibraryReloadKey((key) => key + 1)
              }
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
            headerActions={worldToolbarActions}
            onAiAssist={runAiAssist}
            reloadKey={settingLibraryReloadKey}
          />
          {isProposalReviewOpen && (
            <WorldProposalReview
              storage={context.storage}
              projectTitle={project.metadata.title}
              onClose={() => setIsProposalReviewOpen(false)}
              onApplied={() =>
                setSettingLibraryReloadKey((key) => key + 1)
              }
            />
          )}
        </div>
      );
      break;
    case "items":
      content = (
        <ItemLibrary
          storage={context.storage}
          projection={context.projection}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
          onAiRun={
            context.aiRuns.isAvailable
              ? async (request) => {
                  const modelSelection = await resolveSceneModelSelection(
                    request.sceneId,
                  );
                  return (
                    await context.aiRuns.run({
                      version: WORKBENCH_AI_RUN_REQUEST_VERSION,
                      ...request,
                      ...(modelSelection ? { modelSelection } : {}),
                    })
                  ).output;
                }
              : undefined
          }
          onOpenBatchAgent={
            context.agentSessions.isAvailable ? launchItemBatchAgent : undefined
          }
          isBatchAgentLaunching={isItemAgentLaunching}
          proposalReviewOpen={isItemProposalReviewOpen}
          onOpenProposalReview={() => setIsItemProposalReviewOpen(true)}
          onCloseProposalReview={() => setIsItemProposalReviewOpen(false)}
        />
      );
      break;
    case "factions":
      content = (
        <FactionLibrary
          storage={context.storage}
          projection={context.projection}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
          onOpenWorldNode={openFactionWorldNode}
          onOpenAiAgent={
            context.agentSessions.isAvailable ? launchFactionAgent : undefined
          }
          isAiAgentLaunching={factionAgentLaunchMode === "single"}
          onOpenBatchAgent={
            context.agentSessions.isAvailable
              ? launchFactionBatchAgent
              : undefined
          }
          isBatchAgentLaunching={factionAgentLaunchMode === "batch"}
        />
      );
      break;
    case "powers":
      content = (
        <div className="h-full min-h-0">
          <CultivationEcologyWorkbench
            storage={context.storage}
            projectTitle={project.metadata.title}
            headerActions={cultivationToolbarActions}
            onAiRun={
              context.aiRuns.isAvailable
                ? async (request: CultivationAiRunRequest) => {
                    const modelSelection = await resolveSceneModelSelection(
                      request.sceneId,
                    );
                    return (
                      await context.aiRuns.run({
                        version: WORKBENCH_AI_RUN_REQUEST_VERSION,
                        ...request,
                        ...(modelSelection ? { modelSelection } : {}),
                      })
                    ).output;
                  }
                : undefined
            }
            proposalReviewOpen={isCultivationProposalReviewOpen}
            onCloseProposalReview={() =>
              setIsCultivationProposalReviewOpen(false)
            }
            isActive={context.isActive}
            registerNavigationGuard={context.registerNavigationGuard}
          />
        </div>
      );
      break;
    case "characters":
      content = (
        <CharacterLibraryPrototype
          storage={context.storage}
          projection={context.projection}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
          onOpenAiAgent={
            context.agentSessions.isAvailable ? launchCharacterAgent : undefined
          }
          isAiAgentLaunching={isCharacterAgentLaunching}
          proposalReviewOpen={isCharacterProposalReviewOpen}
          onOpenProposalReview={() => setIsCharacterProposalReviewOpen(true)}
          onCloseProposalReview={() => setIsCharacterProposalReviewOpen(false)}
        />
      );
      break;
    case "knowledge":
      content = (
        <KnowledgeBase
          storage={context.storage}
          projectTitle={project.metadata.title}
          enabled={project.metadata.knowledgeGraph.enabled}
          onToggle={controller.saveKnowledgeGraphEnabled}
          onOpenSource={openKnowledgeSource}
        />
      );
      break;
    case "search":
      content = (
        <SearchPage
          index={domainIndex}
          search={context.search}
          onOpen={openEntity}
        />
      );
      break;
    case "map":
      content = (
        <MapEditor
          storage={context.storage}
          projection={context.projection}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
          registerNavigationGuard={context.registerNavigationGuard}
        />
      );
      break;
    case "simulation":
    case "simulation-console":
    case "simulation-lab":
    case "simulation-council": {
      const simulationView: WorldSimulationView =
        context.route === "simulation-lab"
          ? "lab"
          : context.route === "simulation-council"
            ? "council"
            : "console";
      content = (
        <WorldSimulationWorkbench
          storage={context.storage}
          isActive={context.isActive}
          view={simulationView}
          onNavigate={(view) =>
            context.navigate(
              view === "lab"
                ? "simulation-lab"
                : view === "council"
                  ? "simulation-council"
                  : "simulation-console",
            )
          }
          onOpenSetup={(route) => context.navigate(route)}
          onRunModelScene={
            context.aiRuns.isAvailable
              ? async (scene, prompt) => {
                  const modelSelection =
                    await resolveSceneModelSelection(scene);
                  const result = await context.aiRuns.run({
                    version: WORKBENCH_AI_RUN_REQUEST_VERSION,
                    label: "世界推演智能候选",
                    prompt,
                    ...(modelSelection ? { modelSelection } : {}),
                  });
                  return result.output;
                }
              : undefined
          }
        />
      );
      break;
    }
    case "timeline":
      content = (
        <TimelineLibrary
          storage={context.storage}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
          onOpenAiAgent={
            context.agentSessions.isAvailable
              ? async (request: TimelineAiAgentRequest) => {
                  const modelSelection =
                    await resolveSceneModelSelection("timeline.assist");
                  await context.agentSessions.open({
                    version: WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
                    title: request.title,
                    promptId: "novel.timeline.assist",
                    systemPrompt: await applyScenePromptOverride(
                      "novel.timeline.assist",
                      {
                        projectName: project.metadata.title,
                        genres: project.metadata.genres.join("、") || "未设置",
                        requirement: request.title,
                      },
                      async () => request.systemPrompt,
                    ),
                    initialMessage: request.initialMessage,
                    presentation: "dock",
                    conversationKey: request.conversationKey,
                    historyGroupPath: request.historyGroupPath,
                    forceNew: true,
                    toolset: {
                      id: "novel-world",
                      context: {
                        mode: "timeline",
                        promptId: "novel.timeline.assist",
                        promptVersion: "1.0.0",
                      },
                    },
                    ...(modelSelection ? { modelSelection } : {}),
                  });
                }
              : undefined
          }
        />
      );
      break;
    case "research":
      content = (
        <ResearchLibrary
          storage={context.storage}
          focus={entityFocus}
          projectTitle={project.metadata.title}
          isActive={context.isActive}
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
    case "settings":
    case "model-scenes":
      content = (
        <NovelModelScenarioSettings
          storage={context.storage}
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
          onEditProject={() => setIsProjectSettingsOpen(true)}
          isCreatingChapter={controller.isCreatingChapter}
        />
      );
  }

  const isImmersiveRoute = [
    "lore",
    "lore-config",
    "characters",
    "items",
    "factions",
    "powers",
    "knowledge",
    "map",
    "simulation",
    "simulation-lab",
    "simulation-console",
    "simulation-council",
    "timeline",
    "narrative",
    "inspiration",
    "ai-prompts",
    "settings",
    "model-scenes",
    "manuscript",
  ].includes(context.route);
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
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
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("myagents:novel-palette"))
            }
            title="搜索（Ctrl+K）"
            aria-label="搜索"
            className="ml-2 flex h-7 items-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">搜索</span>
            <kbd className="rounded border border-[var(--line)] px-1 text-xs">
              Ctrl K
            </kbd>
          </button>
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
      <CommandPalette
        index={domainIndex}
        isAvailable={context.search.isAvailable}
        onOpen={openEntity}
        onShowAll={() => context.navigate("search")}
        onCreate={quickCreate}
      />
      {isProjectSettingsOpen && (
        <NovelProjectSettingsDialog
          metadata={project.metadata}
          onSave={controller.saveProjectSettings}
          onClose={() => setIsProjectSettingsOpen(false)}
        />
      )}
    </div>
  );
}
