import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCheck,
  FileDiff,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useWorkbenchStorage } from "@/workbench-host/useWorkbenchStorage";
import type { WorkbenchAgentCompanionProps } from "@/workbench-sdk";

import {
  createManuscriptProposalRepository,
  type LoadedManuscriptProposal,
} from "./manuscriptProposalRepository";

const DiffViewer = lazy(() => import("@/workbench-sdk/DiffViewer"));

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MODE_LABELS = {
  generate: "完整生成",
  continue: "续写",
  revise: "润色",
  expand: "扩写",
} as const;

export default function ManuscriptAgentCompanion({
  workspacePath,
  companionId,
  context,
  isAgentRunning,
}: WorkbenchAgentCompanionProps) {
  const storage = useWorkbenchStorage(workspacePath);
  const repository = useMemo(
    () => createManuscriptProposalRepository(storage),
    [storage],
  );
  const [loaded, setLoaded] = useState<LoadedManuscriptProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"apply" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialMode, setPartialMode] = useState(false);
  const [selectedParagraphs, setSelectedParagraphs] = useState<
    ReadonlySet<number>
  >(new Set());
  const runId = context.runId ?? "";
  const chapterId = context.chapterId ?? "";

  const load = useCallback(async () => {
    try {
      const proposals = await repository.list();
      const next =
        proposals.find(
          (entry) =>
            entry.proposal.runId === runId &&
            entry.proposal.source.chapterId === chapterId,
        ) ?? null;
      setLoaded(next);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [chapterId, repository, runId]);
  const isWaitingForProposal = loaded === null;

  useEffect(() => {
    void load();
    const delay = isAgentRunning || isWaitingForProposal ? 800 : 2500;
    const timer = window.setInterval(() => void load(), delay);
    return () => window.clearInterval(timer);
  }, [isAgentRunning, isWaitingForProposal, load]);

  const paragraphs = useMemo(
    () => splitParagraphs(loaded?.proposal.candidate.content ?? ""),
    [loaded?.proposal.candidate.content],
  );

  useEffect(() => {
    setPartialMode(false);
    setSelectedParagraphs(new Set(paragraphs.map((_, index) => index)));
  }, [loaded?.proposal.proposalId, paragraphs]);

  if (companionId !== "manuscript-review") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        未知的正文审阅面板
      </div>
    );
  }

  const apply = async () => {
    if (!loaded || acting) return;
    setActing("apply");
    setError(null);
    try {
      const selectedContent = partialMode
        ? paragraphs
            .filter((_, index) => selectedParagraphs.has(index))
            .join("\n\n")
        : undefined;
      setLoaded(await repository.apply(loaded, selectedContent));
    } catch (cause) {
      setError(errorMessage(cause));
      await load();
    } finally {
      setActing(null);
    }
  };

  const reject = async () => {
    if (!loaded || acting) return;
    setActing("reject");
    setError(null);
    try {
      setLoaded(await repository.reject(loaded));
    } catch (cause) {
      setError(errorMessage(cause));
      await load();
    } finally {
      setActing(null);
    }
  };

  if (loading && !loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在连接正文审阅区
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
        <header className="flex min-h-12 items-center gap-3 border-b border-[var(--line)] px-4">
          <FileDiff className="h-4 w-4 text-[var(--accent-warm)]" />
          <div className="min-w-0 flex-1">
            <strong className="block text-sm">正文差异审阅</strong>
            <span className="block truncate text-xs text-[var(--ink-muted)]">
              等待 Agent 提交候选
            </span>
          </div>
          <button
            type="button"
            aria-label="刷新正文候选"
            title="刷新"
            onClick={() => void load()}
            className="flex h-8 w-8 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
          <div className="max-w-sm">
            {isAgentRunning ? (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--accent-cool)]" />
            ) : (
              <FileDiff className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
            )}
            <h2 className="mt-4 text-sm font-semibold">
              {isAgentRunning ? "Agent 正在准备正文" : "尚未收到正文候选"}
            </h2>
            <p className="mt-2 text-xs leading-6 text-[var(--ink-muted)]">
              左侧会持续显示分析与工具调用；候选提交后，这里会原位切换为差异审阅。
            </p>
          </div>
        </div>
      </div>
    );
  }

  const proposal = loaded.proposal;
  const before = proposal.source.sourceContent.slice(
    proposal.source.rangeStart,
    proposal.source.rangeEnd,
  );
  const status = proposal.candidate.status;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
          <FileDiff className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{proposal.title}</strong>
          <span className="block truncate text-xs text-[var(--ink-muted)]">
            {proposal.source.chapterTitle} · {MODE_LABELS[proposal.source.mode]}
          </span>
        </div>
        {status === "applied" ? (
          <span className="flex items-center gap-1 text-xs text-[var(--success)]">
            <CheckCircle2 className="h-3.5 w-3.5" /> 已应用
          </span>
        ) : status === "rejected" ? (
          <span className="flex items-center gap-1 text-xs text-[var(--ink-muted)]">
            <X className="h-3.5 w-3.5" /> 已放弃
          </span>
        ) : null}
      </header>

      {error && (
        <div className="flex items-start gap-2 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {loaded.conflict && (
        <div className="flex items-start gap-2 border-b border-[var(--line)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>正文已在生成后变化，当前候选不能直接应用。</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {partialMode ? (
          <div className="grid h-full min-h-0 grid-cols-2 overflow-hidden max-md:grid-cols-1">
            <section className="min-h-0 overflow-auto border-r border-[var(--line)] bg-[var(--error-bg)] p-4 text-sm leading-7 whitespace-pre-wrap max-md:hidden">
              {before || "（插入位置）"}
            </section>
            <section className="min-h-0 overflow-auto bg-[var(--success-bg)] p-4">
              {paragraphs.map((paragraph, index) => (
                <label
                  key={index}
                  className="mb-3 grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] gap-2 text-sm leading-7"
                >
                  <input
                    type="checkbox"
                    className="mt-1.5 accent-[var(--success)]"
                    checked={selectedParagraphs.has(index)}
                    onChange={(event) =>
                      setSelectedParagraphs((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(index);
                        else next.delete(index);
                        return next;
                      })
                    }
                  />
                  <span>{paragraph}</span>
                </label>
              ))}
            </section>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在载入差异
              </div>
            }
          >
            <DiffViewer
              original={before}
              modified={proposal.candidate.content}
              language="plaintext"
              renderSideBySide
            />
          </Suspense>
        )}
      </div>

      {status === "pending" && (
        <footer className="flex min-h-14 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2">
          <button
            type="button"
            onClick={() => setPartialMode((current) => !current)}
            disabled={paragraphs.length < 2 || Boolean(acting)}
            className={`flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium hover:bg-[var(--hover-bg)] disabled:opacity-40 ${partialMode ? "bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]" : "text-[var(--ink-muted)]"}`}
          >
            <ClipboardCheck className="h-3.5 w-3.5" /> 逐段选择
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reject()}
              disabled={Boolean(acting)}
              className="flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-40"
            >
              {acting === "reject" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              放弃
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={
                Boolean(acting) ||
                loaded.conflict ||
                (partialMode && selectedParagraphs.size === 0)
              }
              className="flex h-8 items-center gap-1.5 bg-[var(--accent-warm)] px-3 text-xs font-semibold text-white hover:brightness-95 disabled:opacity-40"
            >
              {acting === "apply" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              应用为新修订
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
