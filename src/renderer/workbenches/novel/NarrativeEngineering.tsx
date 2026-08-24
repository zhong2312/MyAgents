import "./NarrativeEngineering.css";

import {
  AlertTriangle,
  BookOpenText,
  ChartGantt,
  Check,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  ListChecks,
  ListTree,
  Loader2,
  RefreshCw,
  Route,
  Save,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  WorkbenchNavigationGuard,
  WorkbenchStorage,
} from "@/workbench-sdk";

import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./modules/characters";
import { type CharacterRecord } from "./modules/characters";
import NarrativeAudit, {
  buildNarrativeAuditFindings,
  type NarrativeAuditFinding,
  type NarrativeWorkspaceView,
} from "./NarrativeAudit";
import NarrativeAiDialog from "./NarrativeAiDialog";
import {
  buildNarrativeAiAgentRequest,
  type NarrativeAiAgentRequest,
  type NarrativeAiTaskId,
} from "./narrativeAi";
import NarrativeChapters from "./NarrativeChapters";
import type { NarrativeDirectorySelection } from "./NarrativeDirectoryTree";
import {
  applyNarrativeDuplicateRepair,
  hasNarrativeDuplicateRepair,
  planNarrativeDuplicateRepair,
} from "./narrativeDuplicateRepair";
import {
  createNarrativeEngineeringRepository,
  type LoadedNarrativeEngineering,
} from "./narrativeEngineeringRepository";
import type { NarrativeEngineering as NarrativeEngineeringData } from "./narrativeEngineeringSchema";
import NarrativeGantt from "./NarrativeGantt";
import NarrativeOutline from "./NarrativeOutline";
import NarrativeOverview from "./NarrativeOverview";
import SimulationProposalReview from "./SimulationProposalReview";
import WorldProposalReview from "./WorldProposalReview";
import { createNarrativeFileProposalRepository } from "./narrativeProposalRepository";
import NarrativeTracks from "./NarrativeTracks";
import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";
import type { DomainEntityRef } from "./domainIndex";
import type { LoadedNovelChapter } from "./repository";

interface NarrativeEngineeringProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly isActive: boolean;
  readonly onOpenAiAgent?: (request: NarrativeAiAgentRequest) => Promise<void>;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
  /** 外部实体定位请求（T3 消费：自动选中对应剧情规划章节）。 */
  readonly focus?: DomainEntityRef | null;
}

const VIEW_META: readonly [NarrativeWorkspaceView, string, LucideIcon][] = [
  ["overview", "总览", LayoutDashboard],
  ["lines", "线路", Route],
  ["arcs", "故事弧", GitBranch],
  ["outline", "大纲", ListTree],
  ["chapters", "章节", BookOpenText],
  ["schedule", "故事编排", ChartGantt],
  ["proposals", "推演候选", GitBranch],
  ["audit", "叙事检查", ListChecks],
];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function NarrativeEngineering({
  storage,
  projectTitle,
  chapters,
  isActive,
  onOpenAiAgent,
  focus,
  registerNavigationGuard,
}: NarrativeEngineeringProps) {
  const repository = useMemo(
    () => createNarrativeEngineeringRepository(storage),
    [storage],
  );
  const [loaded, setLoaded] = useState<LoadedNarrativeEngineering | null>(null);
  const [draft, setDraft] = useState<NarrativeEngineeringData | null>(null);
  const [characters, setCharacters] = useState<readonly CharacterRecord[]>([]);
  const [view, setView] = useState<NarrativeWorkspaceView>("overview");
  const [selectedLineId, setSelectedLineId] = useState("");
  const [selectedArcId, setSelectedArcId] = useState("");
  const [selectedDirectoryId, setSelectedDirectoryId] = useState("");
  const [chapterDirectory, setChapterDirectory] =
    useState<NarrativeDirectorySelection>("all");
  const [selectedChapterId, setSelectedChapterId] = useState("");

  // 外部实体定位：搜索结果应直接落到对应的剧情工程工作面。
  useEffect(() => {
    if (!focus || !draft) return;
    if (
      focus.kind === "narrativeChapter" &&
      draft.chapters.some((plan) => plan.id === focus.id)
    ) {
      setView("chapters");
      setSelectedChapterId(focus.id);
    } else if (
      focus.kind === "plotLine" &&
      draft.lines.some((line) => line.id === focus.id)
    ) {
      setView("lines");
      setSelectedLineId(focus.id);
    } else if (
      focus.kind === "storyArc" &&
      draft.arcs.some((arc) => arc.id === focus.id)
    ) {
      setView("arcs");
      setSelectedArcId(focus.id);
    } else if (
      focus.kind === "narrativeDirectory" &&
      draft.directories.some((directory) => directory.id === focus.id)
    ) {
      setView("outline");
      setSelectedDirectoryId(focus.id);
    }
  }, [focus, draft]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiDialogTask, setAiDialogTask] =
    useState<NarrativeAiTaskId>("current");
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const characterRepository =
        createNovelCharacterLibraryRepository(storage);
      const [next, characterLibrary] = await Promise.all([
        repository.load(),
        characterRepository.load(),
      ]);
      const nextCharacters = await loadCharacterRecords(
        characterRepository,
        characterLibrary,
      );
      setLoaded(next);
      setDraft(structuredClone(next.library));
      setCharacters(nextCharacters);
      setSelectedLineId(next.library.lines[0]?.id ?? "");
      setSelectedArcId(next.library.arcs[0]?.id ?? "");
      setSelectedDirectoryId(next.library.directories[0]?.id ?? "");
      setSelectedChapterId(
        [...next.library.chapters].sort(
          (left, right) => left.order - right.order,
        )[0]?.id ?? "",
      );
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [repository, storage]);

  useEffect(() => {
    if (isActive && !loaded && !loading) void load();
  }, [isActive, load, loaded, loading]);

  const dirty = Boolean(
    loaded && draft && JSON.stringify(loaded.library) !== JSON.stringify(draft),
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!loaded || !draft || saving) return !dirty;
    setSaving(true);
    try {
      const next = await repository.save(loaded, draft);
      setLoaded(next);
      setDraft(structuredClone(next.library));
      setError(null);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, loaded, repository, saving]);

  const findings = useMemo(
    () =>
      draft ? buildNarrativeAuditFindings(draft, characters, chapters) : [],
    [chapters, characters, draft],
  );
  const duplicateRepairPlan = useMemo(
    () => (draft ? planNarrativeDuplicateRepair(draft) : null),
    [draft],
  );
  const repairDuplicateRecords = useCallback(() => {
    if (!draft || !duplicateRepairPlan) return;
    const repaired = applyNarrativeDuplicateRepair(draft, duplicateRepairPlan);
    if (repaired === draft) return;
    setDraft(repaired);
    setError("已将重复记录合并到原有线路和故事弧。请确认后点击保存。");
  }, [draft, duplicateRepairPlan]);
  const errorCount = findings.filter(
    (finding) => finding.severity === "error",
  ).length;
  const warningCount = findings.filter(
    (finding) => finding.severity === "warning",
  ).length;
  const pendingSimulationProposalCount =
    draft?.simulationProposals.filter(
      (proposal) => proposal.status === "pending",
    ).length ?? 0;

  const openFinding = (finding: NarrativeAuditFinding) => {
    setView(finding.view);
    if (!finding.entityId || !draft) return;
    if (finding.view === "lines") setSelectedLineId(finding.entityId);
    if (finding.view === "arcs") setSelectedArcId(finding.entityId);
    if (finding.view === "outline") setSelectedDirectoryId(finding.entityId);
    if (finding.view === "chapters") {
      const chapter = draft.chapters.find(
        (candidate) => candidate.id === finding.entityId,
      );
      setSelectedChapterId(finding.entityId);
      setChapterDirectory(chapter?.directoryId ?? "unassigned");
    }
  };

  if (loading && !draft) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取剧情工程
      </div>
    );
  }
  if (!draft || !loaded) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-lg text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-[var(--warning)]" />
          <h2 className="mt-4 text-base font-semibold text-[var(--ink)]">
            无法打开剧情工程
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            {error ?? "剧情工程数据尚未就绪。"}
          </p>
          <button
            type="button"
            className="ns-button mx-auto mt-5"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新读取
          </button>
        </div>
      </div>
    );
  }

  const navigate = (nextView: NarrativeWorkspaceView) => {
    setView(nextView);
    if (nextView === "lines" && !selectedLineId) {
      setSelectedLineId(draft.lines[0]?.id ?? "");
    }
    if (nextView === "arcs" && !selectedArcId) {
      setSelectedArcId(draft.arcs[0]?.id ?? "");
    }
    if (nextView === "outline" && !selectedDirectoryId) {
      setSelectedDirectoryId(draft.directories[0]?.id ?? "");
    }
    if (nextView === "chapters" && !selectedChapterId) {
      setSelectedChapterId(
        [...draft.chapters].sort((left, right) => left.order - right.order)[0]
          ?.id ?? "",
      );
    }
  };

  const selectedEntity =
    view === "lines"
      ? (draft.lines.find((line) => line.id === selectedLineId)?.title ??
        "未选择线路")
      : view === "arcs"
        ? (draft.arcs.find((arc) => arc.id === selectedArcId)?.title ??
          "未选择故事弧")
        : view === "outline"
          ? (draft.directories.find(
              (directory) => directory.id === selectedDirectoryId,
            )?.title ?? "未选择目录")
          : view === "chapters"
            ? (draft.chapters.find(
                (chapter) => chapter.id === selectedChapterId,
              )?.title ??
              (chapterDirectory !== "all" && chapterDirectory !== "unassigned"
                ? (draft.directories.find(
                    (directory) => directory.id === chapterDirectory,
                  )?.title ?? "未选择章节目录")
                : chapterDirectory === "unassigned"
                  ? "未归类章节"
                  : "全部章节"))
            : view === "proposals"
              ? "推演候选"
              : view === "audit"
                ? "叙事检查"
                : "全书剧情工程";
  const viewLabel = VIEW_META.find(([id]) => id === view)?.[1] ?? "总览";
  const sectionCount = draft.chapters.reduce(
    (total, chapter) => total + chapter.sections.length,
    0,
  );
  const openAiDialog = (initialTask: NarrativeAiTaskId = "current") => {
    if (!onOpenAiAgent) return;
    setAiDialogTask(initialTask);
    setAiDialogOpen(true);
  };
  const submitAiTask = async (
    task: NarrativeAiTaskId,
    userInstruction: string,
  ) => {
    if (!onOpenAiAgent) return;
    const request = buildNarrativeAiAgentRequest({
      task,
      projectTitle,
      selection: {
        view,
        selectedLineId,
        selectedArcId,
        selectedDirectoryId:
          view === "chapters" &&
          chapterDirectory !== "all" &&
          chapterDirectory !== "unassigned"
            ? chapterDirectory
            : view === "chapters"
              ? ""
              : selectedDirectoryId,
        selectedChapterId,
      },
      userInstruction,
      hasUnsavedChanges: dirty,
    });
    setAiDialogOpen(false);
    try {
      await onOpenAiAgent(request);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <div className="narrative-engineering relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <NarrativeUnsavedChangesGuard
        dirty={dirty}
        label="剧情工程"
        registerNavigationGuard={registerNavigationGuard}
        onSave={save}
      />
      <header className="ne-header shrink-0 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="ne-blueprint flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[var(--line-strong)] bg-[var(--paper)] text-[var(--accent-warm)]">
            <GitMerge className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">剧情工程</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {saving ? "保存中" : dirty ? "待保存" : "已保存"}
            </p>
          </div>
        </div>
        <nav className="ne-top-nav" aria-label="剧情工程视图">
          {VIEW_META.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => navigate(id)}
              className={`ne-nav-item relative flex h-8 shrink-0 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${
                view === id
                  ? "is-active bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
              {id === "audit" && (errorCount > 0 || warningCount > 0) && (
                <span className="min-w-4 rounded-sm bg-[var(--warning-bg)] px-1 text-center text-xs text-[var(--warning)]">
                  {errorCount + warningCount}
                </span>
              )}
              {id === "proposals" && pendingSimulationProposalCount > 0 && (
                <span className="min-w-4 rounded-sm bg-[var(--accent-cool-subtle)] px-1 text-center text-xs text-[var(--accent-cool)]">
                  {pendingSimulationProposalCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="ne-header-actions">
          <button
            type="button"
            className="ns-button shrink-0"
            title="审阅 AI 生成的剧情提案"
            onClick={() => setProposalReviewOpen(true)}
          >
            <ListChecks className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
            提案审阅
          </button>
          <button
            type="button"
            className="ns-button shrink-0"
            disabled={!onOpenAiAgent}
            title={
              onOpenAiAgent
                ? "在 MyNovelStudio 对话中分析当前剧情工程"
                : "当前环境暂不支持 AI 共创"
            }
            onClick={() => openAiDialog()}
          >
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
            AI 共创
          </button>
          <button
            type="button"
            className="ns-button is-primary shrink-0"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : dirty ? (
              <Save className="h-3.5 w-3.5" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {saving ? "保存中" : dirty ? "保存" : "已保存"}
          </button>
        </div>
      </header>
      {error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          <span>{error}</span>
          <button
            type="button"
            className="font-medium underline"
            onClick={() => setError(null)}
          >
            关闭
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {view === "overview" && (
          <NarrativeOverview
            library={draft}
            manuscriptChapters={chapters}
            characters={characters}
            diagnostics={{
              errors: errorCount,
              warnings: warningCount,
              infos: findings.filter((finding) => finding.severity === "info")
                .length,
            }}
            onOpenChapters={() => navigate("chapters")}
            onOpenLines={() => navigate("lines")}
            onOpenArcs={() => navigate("arcs")}
            onOpenAudit={() => navigate("audit")}
          />
        )}
        {(view === "lines" || view === "arcs") && (
          <NarrativeTracks
            mode={view}
            library={draft}
            characters={characters}
            selectedId={view === "lines" ? selectedLineId : selectedArcId}
            onSelect={view === "lines" ? setSelectedLineId : setSelectedArcId}
            onChange={setDraft}
          />
        )}
        {view === "outline" && (
          <NarrativeOutline
            library={draft}
            selectedId={selectedDirectoryId}
            onSelect={setSelectedDirectoryId}
            onChange={setDraft}
            onOpenAi={() => openAiDialog("outline")}
          />
        )}
        {view === "chapters" && (
          <NarrativeChapters
            library={draft}
            manuscriptChapters={chapters}
            characters={characters}
            selectedDirectory={chapterDirectory}
            selectedChapterId={selectedChapterId}
            onSelectDirectory={setChapterDirectory}
            onSelectChapter={setSelectedChapterId}
            onChange={setDraft}
          />
        )}
        {view === "schedule" && (
          <NarrativeGantt
            library={draft}
            chapters={chapters}
            onSelect={(target) => {
              if (target.kind === "chapter") {
                const chapter = draft.chapters.find(
                  (candidate) => candidate.id === target.id,
                );
                setSelectedChapterId(target.id);
                setChapterDirectory(chapter?.directoryId ?? "unassigned");
                setView("chapters");
              } else if (target.kind === "line") {
                setSelectedLineId(target.id);
                setView("lines");
              } else {
                setSelectedArcId(target.id);
                setView("arcs");
              }
            }}
          />
        )}
        {view === "proposals" && (
          <SimulationProposalReview library={draft} onChange={setDraft} />
        )}
        {view === "audit" && (
          <NarrativeAudit
            findings={findings}
            onOpenFinding={openFinding}
            onRepairDuplicates={
              duplicateRepairPlan &&
              hasNarrativeDuplicateRepair(duplicateRepairPlan)
                ? repairDuplicateRecords
                : undefined
            }
          />
        )}
      </div>
      {aiDialogOpen && onOpenAiAgent && (
        <NarrativeAiDialog
          projectTitle={projectTitle}
          selectedEntity={selectedEntity}
          viewLabel={viewLabel}
          initialTask={aiDialogTask}
          counts={{
            lines: draft.lines.length,
            arcs: draft.arcs.length,
            directories: draft.directories.length,
            chapters: draft.chapters.length,
            sections: sectionCount,
            findings: findings.length,
          }}
          onClose={() => setAiDialogOpen(false)}
          onSubmit={submitAiTask}
        />
      )}
      {proposalReviewOpen && (
        <WorldProposalReview
          storage={storage}
          projectTitle={projectTitle}
          repositoryFactory={createNarrativeFileProposalRepository}
          reviewTitle="剧情工程提案"
          proposalSubject="剧情工程"
          onClose={() => setProposalReviewOpen(false)}
          onApplied={() => {
            if (dirty) {
              setError(
                "提案已应用；当前剧情工程仍有未保存草稿，请先关闭提案后重新读取页面。 ",
              );
              return;
            }
            void load();
          }}
        />
      )}
    </div>
  );
}
