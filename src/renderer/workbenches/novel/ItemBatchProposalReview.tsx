import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  PackagePlus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ConfirmDialog,
  ProposalReviewSurface,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  createNovelItemBatchProposalRepository,
  type ItemBatchProposalLoadError,
  type LoadedItemBatchProposal,
} from "./itemBatchProposalRepository";
import type { ItemBatchProposalCandidate } from "./itemBatchProposalSchema";
import {
  createNovelItemLibraryRepository,
  type LoadedItemLibrary,
} from "./itemLibraryRepository";
import { getEffectiveCategoryFields } from "./itemLibrarySchema";

interface ItemBatchProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly beforeMutate: () => Promise<boolean>;
  readonly onApplied: () => void | Promise<void>;
  readonly onClose: () => void;
}

const STATUS_LABELS: Record<ItemBatchProposalCandidate["status"], string> = {
  pending: "待审阅",
  applied: "已创建",
  rejected: "已拒绝",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceProposal(
  proposals: readonly LoadedItemBatchProposal[],
  next: LoadedItemBatchProposal,
): readonly LoadedItemBatchProposal[] {
  return proposals.map((proposal) =>
    proposal.manifest.proposalId === next.manifest.proposalId ? next : proposal,
  );
}

function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return value.join("、") || "未填写";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined || value === "") return "未填写";
  return String(value);
}

export default function ItemBatchProposalReview({
  storage,
  projectTitle,
  beforeMutate,
  onApplied,
  onClose,
}: ItemBatchProposalReviewProps) {
  const repository = useMemo(
    () => createNovelItemBatchProposalRepository(storage),
    [storage],
  );
  const itemRepository = useMemo(
    () => createNovelItemLibraryRepository(storage),
    [storage],
  );
  const [proposals, setProposals] = useState<
    readonly LoadedItemBatchProposal[]
  >([]);
  const [loadErrors, setLoadErrors] = useState<
    readonly ItemBatchProposalLoadError[]
  >([]);
  const [library, setLibrary] = useState<LoadedItemLibrary | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<"apply" | "reject" | "delete" | null>(
    null,
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [proposalResult, nextLibrary] = await Promise.all([
        repository.list(),
        itemRepository.load(),
      ]);
      setProposals(proposalResult.proposals);
      setLoadErrors(proposalResult.errors);
      setLibrary(nextLibrary);
      setSelectedProposalId((current) =>
        proposalResult.proposals.some(
          (proposal) => proposal.manifest.proposalId === current,
        )
          ? current
          : (proposalResult.proposals[0]?.manifest.proposalId ?? ""),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [itemRepository, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProposal =
    proposals.find(
      (proposal) => proposal.manifest.proposalId === selectedProposalId,
    ) ?? proposals[0];

  useEffect(() => {
    if (!selectedProposal) {
      setSelectedIds(new Set());
      setSelectedCandidateId("");
      return;
    }
    const pending = selectedProposal.manifest.items.filter(
      (item) => item.status === "pending",
    );
    setSelectedIds(new Set());
    setSelectedCandidateId((current) =>
      selectedProposal.manifest.items.some(
        (item) => item.candidateId === current,
      )
        ? current
        : (pending[0]?.candidateId ??
          selectedProposal.manifest.items[0]?.candidateId ??
          ""),
    );
  }, [selectedProposal]);

  const selectedCandidate =
    selectedProposal?.manifest.items.find(
      (item) => item.candidateId === selectedCandidateId,
    ) ?? selectedProposal?.manifest.items[0];
  const pendingItems = selectedProposal?.manifest.items.filter(
    (item) => item.status === "pending",
  );
  const selectedPendingIds = (pendingItems ?? [])
    .filter((item) => selectedIds.has(item.candidateId))
    .map((item) => item.candidateId);
  const allPendingSelected =
    (pendingItems?.length ?? 0) > 0 &&
    pendingItems?.every((item) => selectedIds.has(item.candidateId));
  const category = library?.meta.categories.find(
    (item) => item.id === selectedProposal?.manifest.categoryId,
  );
  const fields =
    library && selectedProposal
      ? getEffectiveCategoryFields(
          library.meta,
          selectedProposal.manifest.categoryId,
        )
      : [];

  const toggleCandidate = (candidate: ItemBatchProposalCandidate) => {
    if (candidate.status !== "pending") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidate.candidateId)) next.delete(candidate.candidateId);
      else next.add(candidate.candidateId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of pendingItems ?? []) {
        if (allPendingSelected) next.delete(item.candidateId);
        else next.add(item.candidateId);
      }
      return next;
    });
  };

  const applySelected = async () => {
    if (!selectedProposal || selectedPendingIds.length === 0) return;
    if (!(await beforeMutate())) return;
    setAction("apply");
    setError(null);
    try {
      const next = await repository.apply(
        selectedProposal.manifest.proposalId,
        selectedPendingIds,
      );
      setProposals((current) => replaceProposal(current, next));
      await onApplied();
      setLibrary(await itemRepository.load());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const rejectSelected = async () => {
    if (!selectedProposal || selectedPendingIds.length === 0) return;
    if (!(await beforeMutate())) return;
    setAction("reject");
    setError(null);
    try {
      const next = await repository.reject(
        selectedProposal.manifest.proposalId,
        selectedPendingIds,
      );
      setProposals((current) => replaceProposal(current, next));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const deleteSelectedProposal = async () => {
    if (!selectedProposal) return;
    if (!(await beforeMutate())) return;
    setAction("delete");
    setError(null);
    try {
      await repository.deleteProposals([selectedProposal.manifest.proposalId]);
      setDeleteConfirmOpen(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  return (
    <>
      <ProposalReviewSurface
        title="批量物品提案"
        subtitle={`${projectTitle} · ${proposals.length} 份提案`}
        sideBySide={false}
        showViewModeControl={false}
        isRefreshing={isLoading}
        error={error}
        onSideBySideChange={() => undefined}
        onRefresh={() => void load()}
        onClose={onClose}
      >
        {isLoading && proposals.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取物品提案
          </div>
        ) : !selectedProposal ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <PackagePlus className="h-9 w-9 text-[var(--ink-subtle)]" />
            <p className="mt-3 text-sm text-[var(--ink-muted)]">
              暂无批量物品提案
            </p>
            {loadErrors.length > 0 && (
              <p className="mt-2 text-xs text-[var(--error)]">
                有 {loadErrors.length} 份提案无法读取
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 max-md:flex-col">
              <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-inset)] max-md:h-40 max-md:w-full max-md:border-b max-md:border-r-0">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-3 text-xs font-semibold text-[var(--ink-muted)]">
                  <span>提案列表</span>
                  <button
                    type="button"
                    aria-label="删除当前物品提案"
                    title="删除提案"
                    onClick={() => setDeleteConfirmOpen(true)}
                    className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {proposals.map((proposal) => {
                    const active =
                      proposal.manifest.proposalId ===
                      selectedProposal.manifest.proposalId;
                    const pendingCount = proposal.manifest.items.filter(
                      (item) => item.status === "pending",
                    ).length;
                    return (
                      <button
                        key={proposal.manifest.proposalId}
                        type="button"
                        onClick={() =>
                          setSelectedProposalId(proposal.manifest.proposalId)
                        }
                        className={`block w-full border-b border-[var(--line-subtle)] px-3 py-3 text-left ${
                          active
                            ? "bg-[var(--selected-bg)]"
                            : "hover:bg-[var(--hover-bg)]"
                        }`}
                      >
                        <span className="block truncate text-sm font-medium">
                          {proposal.manifest.title}
                        </span>
                        <span className="mt-1 block text-xs text-[var(--ink-muted)]">
                          {proposal.manifest.items.length} 件 · {pendingCount}{" "}
                          待审阅
                        </span>
                      </button>
                    );
                  })}
                  {loadErrors.map((loadError) => (
                    <div
                      key={loadError.proposalId}
                      title={loadError.message}
                      className="border-b border-[var(--line-subtle)] px-3 py-3 text-xs text-[var(--error)]"
                    >
                      <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                      {loadError.proposalId}
                    </div>
                  ))}
                </div>
              </aside>

              <section className="flex w-72 shrink-0 flex-col border-r border-[var(--line)] max-md:h-56 max-md:w-full max-md:border-b max-md:border-r-0">
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3">
                  <button
                    type="button"
                    aria-pressed={Boolean(allPendingSelected)}
                    onClick={toggleAll}
                    className="flex h-6 w-6 items-center justify-center rounded border border-[var(--line-strong)]"
                  >
                    {allPendingSelected && <Check className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-xs font-semibold text-[var(--ink-muted)]">
                    {category?.name ?? selectedProposal.manifest.categoryId}
                  </span>
                  <span className="ml-auto text-xs text-[var(--ink-subtle)]">
                    {selectedPendingIds.length}/{pendingItems?.length ?? 0}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {selectedProposal.manifest.items.map((candidate) => {
                    const active =
                      candidate.candidateId === selectedCandidate?.candidateId;
                    const checked = selectedIds.has(candidate.candidateId);
                    return (
                      <div
                        key={candidate.candidateId}
                        className={`flex border-b border-[var(--line-subtle)] ${
                          active ? "bg-[var(--selected-bg)]" : ""
                        }`}
                      >
                        <button
                          type="button"
                          aria-pressed={checked}
                          disabled={candidate.status !== "pending"}
                          onClick={() => toggleCandidate(candidate)}
                          className="flex w-9 shrink-0 items-center justify-center disabled:opacity-40"
                        >
                          <span className="flex h-4 w-4 items-center justify-center rounded border border-[var(--line-strong)]">
                            {checked && <Check className="h-3 w-3" />}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedCandidateId(candidate.candidateId)
                          }
                          className="min-w-0 flex-1 px-1 py-3 pr-3 text-left"
                        >
                          <span className="block truncate text-sm font-medium">
                            {candidate.name}
                          </span>
                          <span className="mt-1 block text-xs text-[var(--ink-muted)]">
                            {STATUS_LABELS[candidate.status]}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <main className="min-w-0 flex-1 overflow-y-auto px-5 py-5 max-sm:px-4">
                {selectedCandidate && (
                  <div className="mx-auto max-w-3xl">
                    <h2 className="text-lg font-semibold">
                      {selectedCandidate.name}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
                      {selectedCandidate.summary || "暂无摘要"}
                    </p>
                    <div className="mt-5 grid grid-cols-2 gap-4 text-xs max-sm:grid-cols-1">
                      <div>
                        <span className="text-[var(--ink-subtle)]">别名</span>
                        <p className="mt-1 text-[var(--ink)]">
                          {selectedCandidate.aliases.join("、") || "未填写"}
                        </p>
                      </div>
                      <div>
                        <span className="text-[var(--ink-subtle)]">标签</span>
                        <p className="mt-1 text-[var(--ink)]">
                          {selectedCandidate.tags.join("、") || "未填写"}
                        </p>
                      </div>
                      {Object.entries(selectedCandidate.values).map(
                        ([fieldId, value]) => (
                          <div key={fieldId}>
                            <span className="text-[var(--ink-subtle)]">
                              {fields.find((field) => field.id === fieldId)
                                ?.label ?? fieldId}
                            </span>
                            <p className="mt-1 text-[var(--ink)]">
                              {valueLabel(value)}
                            </p>
                          </div>
                        ),
                      )}
                    </div>
                    <div className="mt-6 border-t border-[var(--line-subtle)] pt-4">
                      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
                        <FileText className="h-3.5 w-3.5" /> Markdown 描述
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[var(--ink)]">
                        {selectedCandidate.description}
                      </pre>
                    </div>
                  </div>
                )}
              </main>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 max-sm:flex-col max-sm:items-stretch">
              <span className="text-xs text-[var(--ink-muted)]">
                已选择 {selectedPendingIds.length} 件待审阅物品
              </span>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void rejectSelected()}
                  disabled={selectedPendingIds.length === 0 || action !== null}
                  className="h-8 rounded-md border border-[var(--line)] px-3 text-xs disabled:opacity-45"
                >
                  {action === "reject" ? "处理中" : "拒绝选中"}
                </button>
                <button
                  type="button"
                  onClick={() => void applySelected()}
                  disabled={selectedPendingIds.length === 0 || action !== null}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-xs font-medium text-white disabled:opacity-45"
                >
                  {action === "apply" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PackagePlus className="h-3.5 w-3.5" />
                  )}
                  创建选中物品
                </button>
              </div>
            </footer>
          </>
        )}
      </ProposalReviewSurface>

      {deleteConfirmOpen && selectedProposal && (
        <ConfirmDialog
          title="删除批量物品提案"
          message={`将永久删除“${selectedProposal.manifest.title}”及其候选记录，已经创建的正式物品不会回滚。`}
          confirmText="删除提案"
          confirmVariant="danger"
          loading={action === "delete"}
          onConfirm={() => void deleteSelectedProposal()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </>
  );
}
