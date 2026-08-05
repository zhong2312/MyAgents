import {
  AlertTriangle,
  Check,
  GitCompareArrows,
  Loader2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  ProposalReviewSurface,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  createNovelTimelineProposalRepository,
  type LoadedTimelineProposal,
} from "../data-access/timelineProposalRepository";
import type { TimelineProposalOperation } from "../entities/timelineProposalSchema";
import type { TimelineEvent } from "../entities/timelineLibrarySchema";

interface TimelineProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onApplied?: () => void;
  readonly onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventSummary(value: unknown): string {
  const event = value as Partial<TimelineEvent>;
  const parts = [
    event.timeLabel,
    event.kind === "event" ? "事件" : event.kind,
    event.summary,
  ].filter(Boolean);
  return parts.join(" · ");
}

function OperationCard({
  operation,
  onToggle,
  onApply,
  onReject,
  acting,
}: {
  readonly operation: TimelineProposalOperation;
  readonly onToggle: () => void;
  readonly onApply: () => void;
  readonly onReject: () => void;
  readonly acting: boolean;
}) {
  const event = operation.value as Partial<TimelineEvent>;
  return (
    <article
      className={`rounded-lg border p-4 transition-colors ${
        operation.status === "pending"
          ? "border-[var(--line-strong)] bg-[var(--paper-elevated)]"
          : operation.status === "applied"
            ? "border-[var(--success)] bg-[var(--success-bg)]/40"
            : "border-[var(--line)] bg-[var(--paper-inset)] opacity-60"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={operation.status === "pending"}
          disabled={operation.status !== "pending"}
          onChange={onToggle}
          aria-label={`选择 ${operation.summary}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm">
              {event.title ?? "（未命名事件）"}
            </strong>
            <span className="rounded-full bg-[var(--accent-cool-subtle)] px-2 py-0.5 text-xs text-[var(--accent-cool)]">
              {operation.action === "create" ? "新建" : "更新"}
            </span>
            <span className="truncate text-xs text-[var(--ink-muted)]">
              {operation.summary}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            {eventSummary(operation.value)}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--ink-subtle)]">
            <span>
              {event.characterIds?.length ?? 0} 角色 ·{" "}
              {event.factionIds?.length ?? 0} 势力 ·{" "}
              {event.itemIds?.length ?? 0} 物品 ·{" "}
              {event.locationIds?.length ?? 0} 地点 ·{" "}
              {event.chapterIds?.length ?? 0} 章节
            </span>
            {event.foreshadowings && event.foreshadowings.length > 0 && (
              <span>{event.foreshadowings.length} 伏笔</span>
            )}
          </div>
        </div>
        {operation.status === "pending" && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md bg-[var(--success)] px-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
              disabled={acting}
              onClick={onApply}
            >
              <Check className="h-3 w-3" /> 采纳
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md border border-[var(--line-strong)] px-2 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] disabled:opacity-40"
              disabled={acting}
              onClick={onReject}
            >
              <X className="h-3 w-3" /> 拒绝
            </button>
          </div>
        )}
        {operation.status === "applied" && (
          <span className="shrink-0 text-xs text-[var(--success)]">已采纳</span>
        )}
        {operation.status === "rejected" && (
          <span className="shrink-0 text-xs text-[var(--ink-subtle)]">已拒绝</span>
        )}
      </div>
    </article>
  );
}

export default function TimelineProposalReview({
  storage,
  projectTitle,
  onApplied,
  onClose,
}: TimelineProposalReviewProps) {
  const repository = createNovelTimelineProposalRepository(storage);
  const [proposals, setProposals] = useState<LoadedTimelineProposal[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await repository.list();
      setProposals([...result.proposals]);
      setLoadErrors(result.errors.map((entry) => entry.message));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await operation();
        await load();
        onApplied?.();
      } catch (cause) {
        setError(errorMessage(cause));
        await load();
      } finally {
        setActing(false);
        setSelected(new Set());
      }
    },
    [load, onApplied],
  );

  const pendingCount = proposals.reduce(
    (sum, proposal) =>
      sum +
      proposal.manifest.operations.filter(
        (operation) => operation.status === "pending",
      ).length,
    0,
  );

  return (
    <ProposalReviewSurface
      title="时间线提案审阅"
      subtitle={`${projectTitle} · ${pendingCount} 个待处理候选`}
      sideBySide={sideBySide}
      onSideBySideChange={setSideBySide}
      onRefresh={() => void load()}
      onClose={onClose}
      isRefreshing={acting}
      error={error}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadErrors.length > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]">
            <AlertTriangle className="h-3.5 w-3.5" />
            {loadErrors.join("；")}
          </div>
        )}
        {proposals.length === 0 && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
            <GitCompareArrows className="h-6 w-6" />
            <p>暂无时间线提案</p>
          </div>
        )}
        <div className="space-y-4">
          {proposals.map((proposal) => {
            const proposalSelected = proposal.manifest.operations.filter(
              (operation) =>
                operation.status === "pending" &&
                selected.has(operation.candidateId),
            );
            return (
              <section
                key={proposal.manifest.proposalId}
                className="rounded-xl border border-[var(--line)] bg-[var(--paper)]"
              >
                <header className="flex flex-wrap items-center gap-3 border-b border-[var(--line-subtle)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">
                      {proposal.manifest.title}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                      {new Date(
                        proposal.manifest.createdAt,
                      ).toLocaleString("zh-CN")}{" "}
                      ·{" "}
                      {
                        proposal.manifest.operations.filter(
                          (operation) => operation.status === "pending",
                        ).length
                      }{" "}
                      个待处理
                    </p>
                  </div>
                  {proposalSelected.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--success)] px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                        disabled={acting}
                        onClick={() =>
                          void run(() =>
                            repository.apply(
                              proposal.manifest.proposalId,
                              proposalSelected.map(
                                (operation) => operation.candidateId,
                              ),
                            ),
                          )
                        }
                      >
                        {acting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        批量采纳（{proposalSelected.length}）
                      </button>
                      <button
                        type="button"
                        className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-3 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] disabled:opacity-40"
                        disabled={acting}
                        onClick={() =>
                          void run(() =>
                            repository.reject(
                              proposal.manifest.proposalId,
                              proposalSelected.map(
                                (operation) => operation.candidateId,
                              ),
                            ),
                          )
                        }
                      >
                        批量拒绝
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-40"
                    disabled={acting}
                    title="删除整份提案"
                    onClick={() =>
                      void run(() =>
                        repository.deleteProposals([
                          proposal.manifest.proposalId,
                        ]),
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </header>
                <div className="space-y-2.5 p-4">
                  {proposal.manifest.operations.map((operation) => (
                    <OperationCard
                      key={operation.candidateId}
                      operation={operation}
                      acting={acting}
                      onToggle={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(operation.candidateId)) {
                            next.delete(operation.candidateId);
                          } else {
                            next.add(operation.candidateId);
                          }
                          return next;
                        })
                      }
                      onApply={() =>
                        void run(() =>
                          repository.apply(proposal.manifest.proposalId, [
                            operation.candidateId,
                          ]),
                        )
                      }
                      onReject={() =>
                        void run(() =>
                          repository.reject(proposal.manifest.proposalId, [
                            operation.candidateId,
                          ]),
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </ProposalReviewSurface>
  );
}
