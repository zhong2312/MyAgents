import { AlertTriangle, Check, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ConfirmDialog,
  ProposalReviewSurface,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  createNovelCharacterProposalRepository,
  type CharacterProposalLoadError,
  type LoadedCharacterProposal,
} from "../data-access/characterProposalRepository";
import type { CharacterProposalOperation } from "../entities/characterProposalSchema";

interface CharacterProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly beforeMutate: () => Promise<boolean>;
  readonly onApplied: () => void | Promise<void>;
  readonly onClose: () => void;
}

const KIND_LABELS: Record<CharacterProposalOperation["kind"], string> = {
  character: "角色",
  race: "种族",
  group: "角色分组",
  soul: "角色灵魂",
};

const STATUS_LABELS: Record<CharacterProposalOperation["status"], string> = {
  pending: "待审阅",
  applied: "已采纳",
  rejected: "已拒绝",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceProposal(
  proposals: readonly LoadedCharacterProposal[],
  next: LoadedCharacterProposal,
): readonly LoadedCharacterProposal[] {
  return proposals.map((proposal) =>
    proposal.manifest.proposalId === next.manifest.proposalId ? next : proposal,
  );
}

function operationValueId(
  operation: CharacterProposalOperation,
): string | null {
  const id =
    operation.action === "update" ? operation.targetId : operation.value.id;
  return typeof id === "string" ? id : null;
}

function stringIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function buildOperationDependencies(
  operations: readonly CharacterProposalOperation[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const creators = new Map<string, string>();
  for (const operation of operations) {
    if (operation.action !== "create") continue;
    const id = operationValueId(operation);
    if (id) creators.set(`${operation.kind}:${id}`, operation.candidateId);
  }
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const operation of operations) {
    const required = new Set<string>();
    if (operation.kind === "character") {
      const addCreator = (
        kind: CharacterProposalOperation["kind"],
        id: unknown,
      ) => {
        if (typeof id !== "string" || !id) return;
        const candidateId = creators.get(`${kind}:${id}`);
        if (candidateId && candidateId !== operation.candidateId) {
          required.add(candidateId);
        }
      };
      addCreator("race", operation.value.raceId);
      addCreator("soul", operation.value.soulId);
      stringIds(operation.value.groupIds).forEach((id) =>
        addCreator("group", id),
      );
      if (Array.isArray(operation.value.relations)) {
        operation.value.relations.forEach((relation) => {
          if (relation && typeof relation === "object") {
            addCreator(
              "character",
              (relation as Record<string, unknown>).targetId,
            );
          }
        });
      }
    }
    dependencies.set(operation.candidateId, required);
  }
  return dependencies;
}

function collectDependencies(
  candidateId: string,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  result = new Set<string>(),
): ReadonlySet<string> {
  if (result.has(candidateId)) return result;
  result.add(candidateId);
  for (const dependencyId of dependencies.get(candidateId) ?? []) {
    collectDependencies(dependencyId, dependencies, result);
  }
  return result;
}

function buildDependents(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const [candidateId, requiredIds] of dependencies) {
    for (const requiredId of requiredIds) {
      const dependents = result.get(requiredId) ?? new Set<string>();
      dependents.add(candidateId);
      result.set(requiredId, dependents);
    }
  }
  return result;
}

export default function CharacterProposalReview({
  storage,
  projectTitle,
  beforeMutate,
  onApplied,
  onClose,
}: CharacterProposalReviewProps) {
  const repository = useMemo(
    () => createNovelCharacterProposalRepository(storage),
    [storage],
  );
  const [proposals, setProposals] = useState<
    readonly LoadedCharacterProposal[]
  >([]);
  const [loadErrors, setLoadErrors] = useState<
    readonly CharacterProposalLoadError[]
  >([]);
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<"apply" | "reject" | "delete" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await repository.list();
      setProposals(result.proposals);
      setLoadErrors(result.errors);
      setSelectedProposalId((current) =>
        result.proposals.some(
          (proposal) => proposal.manifest.proposalId === current,
        )
          ? current
          : (result.proposals[0]?.manifest.proposalId ?? ""),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [repository]);

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
    const pending = selectedProposal.manifest.operations.filter(
      (operation) => operation.status === "pending",
    );
    setSelectedIds(new Set());
    setSelectedCandidateId((current) =>
      selectedProposal.manifest.operations.some(
        (operation) => operation.candidateId === current,
      )
        ? current
        : (pending[0]?.candidateId ??
          selectedProposal.manifest.operations[0]?.candidateId ??
          ""),
    );
  }, [selectedProposal]);

  const pendingOperations = selectedProposal?.manifest.operations.filter(
    (operation) => operation.status === "pending",
  );
  const selectedPendingIds = (pendingOperations ?? [])
    .filter((operation) => selectedIds.has(operation.candidateId))
    .map((operation) => operation.candidateId);
  const allPendingSelected =
    (pendingOperations?.length ?? 0) > 0 &&
    pendingOperations?.every((operation) =>
      selectedIds.has(operation.candidateId),
    );
  const selectedOperation =
    selectedProposal?.manifest.operations.find(
      (operation) => operation.candidateId === selectedCandidateId,
    ) ?? selectedProposal?.manifest.operations[0];

  const operationDependencies = useMemo(
    () =>
      buildOperationDependencies(selectedProposal?.manifest.operations ?? []),
    [selectedProposal?.manifest.operations],
  );
  const operationDependents = useMemo(
    () => buildDependents(operationDependencies),
    [operationDependencies],
  );
  const selectedDependencyIds = useMemo(() => {
    const result = new Set<string>();
    for (const candidateId of selectedIds) {
      for (const dependencyId of operationDependencies.get(candidateId) ?? []) {
        collectDependencies(dependencyId, operationDependencies, result);
      }
    }
    return result;
  }, [operationDependencies, selectedIds]);
  const dependencyCount = selectedDependencyIds.size;

  const toggleOperation = (operation: CharacterProposalOperation) => {
    if (operation.status !== "pending") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(operation.candidateId)) {
        const remove = new Set<string>([operation.candidateId]);
        const visitDependents = (candidateId: string) => {
          for (const dependentId of operationDependents.get(candidateId) ??
            []) {
            if (!next.has(dependentId) || remove.has(dependentId)) continue;
            remove.add(dependentId);
            visitDependents(dependentId);
          }
        };
        visitDependents(operation.candidateId);
        remove.forEach((candidateId) => next.delete(candidateId));
      } else {
        collectDependencies(
          operation.candidateId,
          operationDependencies,
        ).forEach((candidateId) => next.add(candidateId));
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
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const rejectSelected = async () => {
    if (!selectedProposal || selectedPendingIds.length === 0) return;
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

  const deleteProposal = async () => {
    if (!selectedProposal) return;
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
        title="角色设计提案"
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
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取角色提案
          </div>
        ) : !selectedProposal ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <Sparkles className="h-9 w-9 text-[var(--ink-subtle)]" />
            <p className="mt-3 text-sm text-[var(--ink-muted)]">
              暂无角色设计提案
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
              <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-inset)] max-md:h-40 max-md:w-full max-md:border-r-0 max-md:border-b">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-3 text-xs font-semibold text-[var(--ink-muted)]">
                  <span>提案列表</span>
                  <button
                    type="button"
                    aria-label="删除当前角色提案"
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
                    const pendingCount = proposal.manifest.operations.filter(
                      (operation) => operation.status === "pending",
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
                          {proposal.manifest.operations.length} 项 ·{" "}
                          {pendingCount} 待审阅
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

              <section className="flex w-72 shrink-0 flex-col border-r border-[var(--line)] max-md:h-56 max-md:w-full max-md:border-r-0 max-md:border-b">
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3">
                  <button
                    type="button"
                    aria-pressed={Boolean(allPendingSelected)}
                    aria-label={
                      allPendingSelected ? "取消选择全部候选" : "选择全部候选"
                    }
                    title={
                      allPendingSelected ? "取消选择全部候选" : "选择全部候选"
                    }
                    onClick={() => {
                      setSelectedIds(
                        allPendingSelected
                          ? new Set()
                          : new Set(
                              (pendingOperations ?? []).map(
                                (operation) => operation.candidateId,
                              ),
                            ),
                      );
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded border border-[var(--line-strong)]"
                  >
                    {allPendingSelected && <Check className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-xs font-semibold text-[var(--ink-muted)]">
                    候选变更
                  </span>
                  <span className="ml-auto text-xs text-[var(--ink-subtle)]">
                    {selectedPendingIds.length}/{pendingOperations?.length ?? 0}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {selectedProposal.manifest.operations.map((operation) => {
                    const active =
                      operation.candidateId === selectedOperation?.candidateId;
                    const checked = selectedIds.has(operation.candidateId);
                    const dependencySize =
                      operationDependencies.get(operation.candidateId)?.size ??
                      0;
                    const automaticallyIncluded =
                      checked &&
                      selectedDependencyIds.has(operation.candidateId);
                    return (
                      <div
                        key={operation.candidateId}
                        className={`flex border-b border-[var(--line-subtle)] ${
                          active ? "bg-[var(--selected-bg)]" : ""
                        }`}
                      >
                        <button
                          type="button"
                          aria-pressed={checked}
                          disabled={operation.status !== "pending"}
                          onClick={() => toggleOperation(operation)}
                          className="flex w-9 shrink-0 items-center justify-center disabled:opacity-40"
                        >
                          <span className="flex h-4 w-4 items-center justify-center rounded border border-[var(--line-strong)]">
                            {checked && <Check className="h-3 w-3" />}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedCandidateId(operation.candidateId)
                          }
                          className="min-w-0 flex-1 px-1 py-3 pr-3 text-left"
                        >
                          <span className="block truncate text-sm font-medium">
                            {KIND_LABELS[operation.kind]} ·{" "}
                            {operation.action === "create" ? "新增" : "更新"}
                          </span>
                          <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                            {operation.summary}
                          </span>
                          <span className="mt-1 block text-xs text-[var(--ink-subtle)]">
                            {STATUS_LABELS[operation.status]}
                            {automaticallyIncluded
                              ? " · 已随关联自动纳入"
                              : dependencySize > 0
                                ? ` · 需 ${dependencySize} 项前置候选`
                                : ""}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <main className="min-w-0 flex-1 overflow-y-auto px-5 py-5 max-sm:px-4">
                {selectedOperation && (
                  <div className="mx-auto max-w-3xl">
                    <h2 className="text-lg font-semibold">
                      {KIND_LABELS[selectedOperation.kind]}候选
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
                      {selectedOperation.summary}
                    </p>
                    <pre className="mt-5 overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--paper-inset)] p-4 text-xs leading-6 text-[var(--ink-secondary)]">
                      {JSON.stringify(selectedOperation.value, null, 2)}
                    </pre>
                  </div>
                )}
              </main>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 max-sm:flex-col max-sm:items-stretch">
              <span className="text-xs text-[var(--ink-muted)]">
                已选择 {selectedPendingIds.length} 项待审阅变更
                {dependencyCount > 0
                  ? `，其中包含 ${dependencyCount} 项自动关联依赖`
                  : ""}
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
                    <Check className="h-3.5 w-3.5" />
                  )}
                  采纳选中
                </button>
              </div>
            </footer>
          </>
        )}
      </ProposalReviewSurface>

      {deleteConfirmOpen && selectedProposal && (
        <ConfirmDialog
          title="删除角色设计提案"
          message={`将永久删除“${selectedProposal.manifest.title}”及其候选记录，已经采纳的正式变更不会回滚。`}
          confirmText="删除提案"
          confirmVariant="danger"
          loading={action === "delete"}
          onConfirm={() => void deleteProposal()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </>
  );
}
