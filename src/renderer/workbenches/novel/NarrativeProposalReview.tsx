import {
  Check,
  CheckCircle2,
  GitBranch,
  Loader2,
  Route,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ConfirmDialog,
  ProposalReviewSurface,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  createNarrativeProposalRepository,
  type LoadedNarrativeProposal,
  type NarrativeProposalRepository,
} from "./narrativeProposalRepository";
import type {
  NarrativeArcProposalCandidate,
  NarrativeLineProposalCandidate,
} from "./narrativeProposalSchema";

type Candidate =
  | ({ readonly kind: "line" } & NarrativeLineProposalCandidate)
  | ({ readonly kind: "arc" } & NarrativeArcProposalCandidate);

export interface NarrativeProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onClose: () => void;
  readonly onApplied?: () => void;
  readonly repositoryFactory?: (
    storage: WorkbenchStorage,
  ) => NarrativeProposalRepository;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function candidatesOf(proposal: LoadedNarrativeProposal): readonly Candidate[] {
  return [
    ...proposal.manifest.lines.map((candidate) => ({ ...candidate, kind: "line" as const })),
    ...proposal.manifest.arcs.map((candidate) => ({ ...candidate, kind: "arc" as const })),
  ];
}

function CandidateIcon({ kind }: { readonly kind: Candidate["kind"] }) {
  return kind === "line" ? (
    <Route className="h-3.5 w-3.5" />
  ) : (
    <GitBranch className="h-3.5 w-3.5" />
  );
}

export default function NarrativeProposalReview({
  storage,
  projectTitle,
  onClose,
  onApplied,
  repositoryFactory = createNarrativeProposalRepository,
}: NarrativeProposalReviewProps) {
  const repository = useMemo(() => repositoryFactory(storage), [repositoryFactory, storage]);
  const [proposals, setProposals] = useState<readonly LoadedNarrativeProposal[]>([]);
  const [errors, setErrors] = useState<readonly { proposalId: string; message: string }[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"apply" | "reject" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await repository.list();
      setProposals(loaded.proposals);
      setErrors(loaded.errors);
      setSelectedProposalId((current) =>
        loaded.proposals.some((proposal) => proposal.manifest.proposalId === current)
          ? current
          : (loaded.proposals[0]?.manifest.proposalId ?? ""),
      );
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => void refresh(), [refresh]);

  const proposal = proposals.find((item) => item.manifest.proposalId === selectedProposalId) ?? proposals[0] ?? null;
  const candidates = useMemo(() => (proposal ? candidatesOf(proposal) : []), [proposal]);
  const selectedCandidate = candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? candidates[0] ?? null;
  const pending = useMemo(() => candidates.filter((candidate) => candidate.status === "pending"), [candidates]);

  useEffect(() => {
    setSelectedCandidateId((current) =>
      candidates.some((candidate) => candidate.candidateId === current)
        ? current
        : (candidates[0]?.candidateId ?? ""),
    );
    setSelectedIds(new Set());
  }, [candidates, pending, proposal?.manifest.proposalId]);

  const replaceProposal = (next: LoadedNarrativeProposal) => {
    setProposals((current) => current.map((item) => item.manifest.proposalId === next.manifest.proposalId ? next : item));
  };

  const runAction = async (kind: "apply" | "reject") => {
    if (!proposal || selectedIds.size === 0) return;
    setAction(kind);
    try {
      const next = kind === "apply"
        ? await repository.apply(proposal.manifest.proposalId, [...selectedIds])
        : await repository.reject(proposal.manifest.proposalId, [...selectedIds]);
      replaceProposal(next);
      setSelectedIds(new Set());
      setError(null);
      if (kind === "apply") onApplied?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const deleteProposal = async () => {
    if (!proposal) return;
    setAction("delete");
    try {
      await repository.deleteProposals([proposal.manifest.proposalId]);
      setProposals((current) => current.filter((item) => item.manifest.proposalId !== proposal.manifest.proposalId));
      setSelectedProposalId("");
      setConfirmDelete(false);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  return (
    <>
      <ProposalReviewSurface
        title="剧情工程提案审阅"
        subtitle={`${projectTitle} · ${proposals.length} 份提案`}
        sideBySide={true}
        showViewModeControl={false}
        isRefreshing={loading}
        error={error}
        onSideBySideChange={() => undefined}
        onRefresh={() => void refresh()}
        onClose={onClose}
      >
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(220px,300px)_minmax(0,1fr)] max-md:grid-cols-[180px_minmax(180px,260px)_minmax(360px,1fr)]">
          <aside className="ne-panel-scroll border-r border-[var(--line)] bg-[var(--paper-elevated)]">
            <div className="border-b border-[var(--line)] px-3 py-3">
              <p className="text-xs font-semibold text-[var(--ink)]">待审提案</p>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">先选择一份提案，再逐项审核候选。</p>
            </div>
            {loading && proposals.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-8 text-xs text-[var(--ink-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取中</div>
            ) : proposals.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-[var(--ink-muted)]">暂无剧情提案</p>
            ) : proposals.map((item) => {
              const itemCandidates = candidatesOf(item);
              const count = itemCandidates.filter((candidate) => candidate.status === "pending").length;
              return (
                <button
                  key={item.manifest.proposalId}
                  type="button"
                  className={`w-full border-b border-[var(--line-subtle)] px-3 py-3 text-left ${item.manifest.proposalId === proposal?.manifest.proposalId ? "bg-[var(--accent-warm-muted)]" : "hover:bg-[var(--hover-bg)]"}`}
                  onClick={() => setSelectedProposalId(item.manifest.proposalId)}
                >
                  <span className="block truncate text-xs font-semibold">{item.manifest.title}</span>
                  <span className="mt-1 block text-xs text-[var(--ink-muted)]">{count} 项待审 · {itemCandidates.length} 项候选</span>
                </button>
              );
            })}
            {errors.map((item) => <p key={item.proposalId} className="border-b border-[var(--line-subtle)] px-3 py-3 text-xs text-[var(--error)]">{item.proposalId}<br />{item.message}</p>)}
          </aside>
          <section className="ne-panel-scroll border-r border-[var(--line)] bg-[var(--paper)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-3">
              <div><p className="text-xs font-semibold">候选清单</p><p className="mt-1 text-xs text-[var(--ink-muted)]">勾选后批量采纳或拒绝</p></div>
              {proposal && <button type="button" className="ns-icon-button" title="删除提案" aria-label="删除提案" onClick={() => setConfirmDelete(true)}><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
            {candidates.map((candidate) => (
              <div key={candidate.candidateId} className={`border-b border-[var(--line-subtle)] px-3 py-2 ${candidate.candidateId === selectedCandidate?.candidateId ? "bg-[var(--accent-cool-subtle)]" : ""}`}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" disabled={candidate.status !== "pending"} checked={selectedIds.has(candidate.candidateId)} onChange={(event) => setSelectedIds((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.candidateId); else next.delete(candidate.candidateId); return next; })} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedCandidateId(candidate.candidateId)}>
                    <span className="flex items-center gap-1.5 text-xs font-medium"><CandidateIcon kind={candidate.kind} />{candidate.value.title}</span>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">{candidate.kind === "line" ? "线路" : "故事弧"} · {candidate.status === "pending" ? "待审阅" : candidate.status === "applied" ? "已采纳" : "已拒绝"}</span>
                  </button>
                </div>
              </div>
            ))}
            {proposal && pending.length > 0 && <div className="sticky bottom-0 border-t border-[var(--line)] bg-[var(--paper-elevated)] p-3"><div className="flex gap-2"><button type="button" className="ns-button is-primary flex-1" disabled={action !== null || selectedIds.size === 0} onClick={() => void runAction("apply")}><Check className="h-3.5 w-3.5" />{action === "apply" ? "应用中" : `采纳 ${selectedIds.size} 项`}</button><button type="button" className="ns-button flex-1" disabled={action !== null || selectedIds.size === 0} onClick={() => void runAction("reject")}><X className="h-3.5 w-3.5" />拒绝</button></div></div>}
          </section>
          <section className="ne-panel-scroll bg-[var(--paper)] px-5 py-5">
            {!selectedCandidate ? <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">选择一个候选查看详情</div> : <>
              <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] pb-4"><div><p className="flex items-center gap-2 text-xs font-semibold text-[var(--accent-cool)]"><CandidateIcon kind={selectedCandidate.kind} />{selectedCandidate.kind === "line" ? "线路候选" : "故事弧候选"}</p><h2 className="mt-2 text-lg font-semibold">{selectedCandidate.value.title}</h2><p className="mt-1 text-xs text-[var(--ink-muted)]">{selectedCandidate.summary}</p></div>{selectedCandidate.status !== "pending" && <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-muted)]"><CheckCircle2 className="h-3.5 w-3.5" />{selectedCandidate.status === "applied" ? "已采纳" : "已拒绝"}</span>}</div>
              <div className="mt-5 grid gap-4"><div><p className="text-xs font-semibold">关键节点（{selectedCandidate.value.keyNodes.length}）</p><div className="mt-2 divide-y divide-[var(--line-subtle)] border-y border-[var(--line-subtle)]">{selectedCandidate.value.keyNodes.map((node) => <div key={node.id} className="py-3"><p className="text-sm font-medium">{node.title}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-[var(--ink-secondary)]">{node.content}</p><p className="mt-2 text-xs text-[var(--ink-muted)]">{node.locations.length ? `关联 ${node.locations.length} 个章节/节` : "暂未关联章节或节"}</p></div>)}</div></div><div><p className="text-xs font-semibold">概要内容</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-secondary)]">{selectedCandidate.value.content || "暂无内容"}</p></div></div>
            </>}
          </section>
        </div>
      </ProposalReviewSurface>
      {confirmDelete && <ConfirmDialog title="删除剧情提案" message="删除后只会移除提案记录，不会回滚已经采纳的线路或故事弧。确认继续？" confirmText="删除" confirmVariant="danger" loading={action === "delete"} onConfirm={() => void deleteProposal()} onCancel={() => setConfirmDelete(false)} />}
    </>
  );
}
