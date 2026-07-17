import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FilePenLine,
  FilePlus2,
  GitCompareArrows,
  Loader2,
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

import { ProposalReviewSurface, type WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelWorldProposalRepository,
  getWorldProposalStatus,
  type LoadedWorldProposal,
  type LoadedWorldProposalChange,
  type WorldProposalLoadError,
  type WorldProposalStatus,
} from "./worldProposalRepository";

const DiffViewer = lazy(() => import("@/workbench-sdk/DiffViewer"));

interface WorldProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onClose: () => void;
}

const STATUS_LABELS: Record<WorldProposalStatus, string> = {
  pending: "待审阅",
  "partially-applied": "部分应用",
  applied: "已应用",
  rejected: "已拒绝",
};

function languageForPath(path: string): string {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function replaceProposal(
  proposals: readonly LoadedWorldProposal[],
  next: LoadedWorldProposal,
): readonly LoadedWorldProposal[] {
  return proposals.map((proposal) =>
    proposal.manifest.proposalId === next.manifest.proposalId ? next : proposal,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ChangeStatus({
  change,
}: {
  readonly change: LoadedWorldProposalChange;
}) {
  if (change.loadError) {
    return <span className="text-[var(--error)]">快照缺失</span>;
  }
  if (change.conflict) {
    return <span className="text-[var(--error)]">文件冲突</span>;
  }
  if (change.status === "applied") {
    return <span className="text-[var(--success)]">已应用</span>;
  }
  if (change.status === "rejected") {
    return <span className="text-[var(--ink-subtle)]">已拒绝</span>;
  }
  return <span className="text-[var(--accent-cool)]">待处理</span>;
}

export default function WorldProposalReview({
  storage,
  projectTitle,
  onClose,
}: WorldProposalReviewProps) {
  const repository = useMemo(
    () => createNovelWorldProposalRepository(storage),
    [storage],
  );
  const [proposals, setProposals] = useState<readonly LoadedWorldProposal[]>(
    [],
  );
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedChangeId, setSelectedChangeId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [proposalErrors, setProposalErrors] = useState<
    readonly WorldProposalLoadError[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<"apply" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await repository.list();
      setProposals(loaded.proposals);
      setProposalErrors(loaded.errors);
      setSelectedProposalId((current) =>
        loaded.proposals.some((item) => item.manifest.proposalId === current)
          ? current
          : (loaded.proposals[0]?.manifest.proposalId ?? ""),
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedProposal =
    proposals.find(
      (proposal) => proposal.manifest.proposalId === selectedProposalId,
    ) ?? proposals[0];

  useEffect(() => {
    if (!selectedProposal) {
      setSelectedChangeId("");
      setSelectedIds(new Set());
      return;
    }
    const pending = selectedProposal.changes.filter(
      (change) =>
        change.status === "pending" && !change.conflict && !change.loadError,
    );
    setSelectedIds(new Set(pending.map((change) => change.id)));
    setSelectedChangeId((current) =>
      selectedProposal.changes.some((change) => change.id === current)
        ? current
        : (pending[0]?.id ?? selectedProposal.changes[0]?.id ?? ""),
    );
  }, [selectedProposal]);

  const selectedChange =
    selectedProposal?.changes.find(
      (change) => change.id === selectedChangeId,
    ) ?? selectedProposal?.changes[0];

  const selectedPendingIds = selectedProposal
    ? selectedProposal.changes
        .filter(
          (change) => selectedIds.has(change.id) && change.status === "pending",
        )
        .map((change) => change.id)
    : [];

  const selectedApplicableIds = selectedProposal
    ? selectedProposal.changes
        .filter(
          (change) =>
            selectedIds.has(change.id) &&
            change.status === "pending" &&
            !change.conflict &&
            !change.loadError,
        )
        .map((change) => change.id)
    : [];

  const selectableChangeIds = selectedProposal
    ? selectedProposal.changes
        .filter(
          (change) =>
            change.status === "pending" &&
            !change.conflict &&
            !change.loadError,
        )
        .map((change) => change.id)
    : [];
  const allSelectableChangesSelected =
    selectableChangeIds.length > 0 &&
    selectableChangeIds.every((id) => selectedIds.has(id));

  const toggleChange = (change: LoadedWorldProposalChange) => {
    if (change.status !== "pending") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(change.id)) next.delete(change.id);
      else next.add(change.id);
      return next;
    });
  };

  const toggleAllChanges = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allSelectableChangesSelected) {
        selectableChangeIds.forEach((id) => next.delete(id));
      } else {
        selectableChangeIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleApply = async () => {
    if (!selectedProposal || selectedApplicableIds.length === 0) return;
    setAction("apply");
    setError(null);
    try {
      const next = await repository.apply(
        selectedProposal.manifest.proposalId,
        selectedApplicableIds,
        projectTitle,
      );
      setProposals((current) => replaceProposal(current, next));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const handleReject = async () => {
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

  return (
    <ProposalReviewSurface
      title="世界架构提案"
      subtitle={`${projectTitle} · ${proposals.length} 份提案`}
      sideBySide={sideBySide}
      isRefreshing={isLoading}
      error={error}
      onSideBySideChange={setSideBySide}
      onRefresh={() => void load()}
      onClose={onClose}
    >
      {isLoading && proposals.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取提案
        </div>
      ) : !selectedProposal && proposalErrors.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-[var(--ink-muted)]">
          <GitCompareArrows className="h-7 w-7" />
          <p className="mt-3 text-sm">暂无世界架构提案</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-lg:w-72 max-md:h-64 max-md:w-full max-md:border-r-0 max-md:border-b">
            <div className="shrink-0 border-b border-[var(--line)] p-2">
              <div className="max-h-36 overflow-y-auto max-md:max-h-20">
                {proposals.map((proposal) => {
                  const active =
                    proposal.manifest.proposalId ===
                    selectedProposal?.manifest.proposalId;
                  const status = getWorldProposalStatus(proposal);
                  return (
                    <button
                      key={proposal.manifest.proposalId}
                      type="button"
                      onClick={() =>
                        setSelectedProposalId(proposal.manifest.proposalId)
                      }
                      className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${
                        active
                          ? "bg-[var(--accent-cool-subtle)]"
                          : "hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-xs font-medium">
                          {proposal.manifest.title}
                        </strong>
                        <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                          {proposal.manifest.changes.length} 个文件
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                        {STATUS_LABELS[status]}
                      </span>
                    </button>
                  );
                })}
                {proposalErrors.map((proposalError) => (
                  <div
                    key={proposalError.proposalId}
                    className="mb-1 flex gap-2 rounded-md bg-[var(--error-bg)] px-2.5 py-2 text-[var(--error)]"
                    title={proposalError.message}
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-xs font-medium">
                        {proposalError.proposalId}
                      </strong>
                      <span className="mt-0.5 block truncate text-xs">
                        {proposalError.message}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {selectedProposal ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <label className="flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b border-[var(--line)] px-3 text-xs font-medium">
                  <input
                    type="checkbox"
                    aria-label="全选可应用变更"
                    checked={allSelectableChangesSelected}
                    disabled={selectableChangeIds.length === 0}
                    onChange={toggleAllChanges}
                    className="h-3.5 w-3.5 accent-[var(--accent-cool)]"
                  />
                  <span className="min-w-0 flex-1">全选可应用变更</span>
                  <span className="text-[var(--ink-muted)]">
                    {selectedApplicableIds.length}/{selectableChangeIds.length}
                  </span>
                </label>
                <div className="min-h-0 flex-1 overflow-y-auto py-1">
                  {selectedProposal.changes.map((change) => {
                    const selected = change.id === selectedChange?.id;
                    const selectable = change.status === "pending";
                    const OperationIcon =
                      change.operation === "create" ? FilePlus2 : FilePenLine;
                    return (
                      <div
                        key={change.id}
                        className={`flex items-start gap-2 border-l-2 px-3 py-2.5 ${
                          selected
                            ? "border-[var(--accent-cool)] bg-[var(--paper-inset)]"
                            : "border-transparent hover:bg-[var(--hover-bg)]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`选择变更 ${change.summary}`}
                          checked={selectedIds.has(change.id)}
                          disabled={!selectable}
                          onChange={() => toggleChange(change)}
                          className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent-cool)]"
                        />
                        <button
                          type="button"
                          onClick={() => setSelectedChangeId(change.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-1.5">
                            <OperationIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                            <strong className="truncate text-xs font-medium">
                              {change.targetPath.split("/").at(-1)}
                            </strong>
                          </span>
                          <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                            {change.summary}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-xs">
                            <ChangeStatus change={change} />
                            {change.inferred && (
                              <span className="rounded bg-[var(--paper-elevated)] px-1 py-0.5 text-xs text-[var(--ink-subtle)]">
                                自动补录
                              </span>
                            )}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 px-4 py-5 text-xs text-[var(--ink-muted)]">
                没有可审阅的有效提案，请修复左侧无效提案后重新读取。
              </div>
            )}

            {selectedProposal && (
              <footer className="shrink-0 border-t border-[var(--line)] p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-[var(--ink-muted)]">
                  <span>
                    已选择 {selectedPendingIds.length} 项 · 可应用{" "}
                    {selectedApplicableIds.length} 项
                  </span>
                  <span>
                    {
                      selectedProposal.changes.filter(
                        (change) => change.conflict,
                      ).length
                    }{" "}
                    个冲突
                  </span>
                  <span>
                    {
                      selectedProposal.changes.filter(
                        (change) => change.loadError,
                      ).length
                    }{" "}
                    个缺失
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void handleReject()}
                    disabled={
                      action !== null || selectedPendingIds.length === 0
                    }
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] text-xs font-medium disabled:opacity-40"
                  >
                    {action === "reject" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                    拒绝选中
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={
                      action !== null || selectedApplicableIds.length === 0
                    }
                    className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-cool)] text-xs font-medium text-white disabled:opacity-40"
                  >
                    {action === "apply" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    应用选中
                  </button>
                </div>
              </footer>
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {selectedChange ? (
              <>
                <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate font-mono text-xs font-medium"
                      title={selectedChange.targetPath}
                    >
                      {selectedChange.targetPath}
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
                      {selectedChange.summary}
                    </p>
                  </div>
                  <span className="shrink-0 rounded bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-muted)]">
                    {selectedChange.operation === "create" ? "新增" : "修改"}
                  </span>
                  {selectedChange.conflict && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--error)]">
                      <AlertTriangle className="h-3.5 w-3.5" /> 正式文件已变化
                    </span>
                  )}
                  {selectedChange.status === "applied" && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--success)]">
                      <CheckCircle2 className="h-3.5 w-3.5" /> 已应用
                    </span>
                  )}
                </header>
                <div className="min-h-0 flex-1">
                  {selectedChange.loadError ? (
                    <div className="flex h-full items-center justify-center p-8">
                      <div className="max-w-2xl rounded-md border border-[var(--error)]/30 bg-[var(--error-bg)] p-4 text-sm text-[var(--error)]">
                        <div className="flex items-center gap-2 font-medium">
                          <AlertTriangle className="h-4 w-4 shrink-0" />
                          该变更缺少提案快照
                        </div>
                        <p className="mt-2 break-all font-mono text-xs leading-5">
                          {selectedChange.loadError}
                        </p>
                        <p className="mt-3 text-xs text-[var(--ink-muted)]">
                          其他有效变更仍可继续审阅；此项需要 Agent
                          补齐文件，或由作者拒绝。
                        </p>
                      </div>
                    </div>
                  ) : (
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          正在载入差异组件
                        </div>
                      }
                    >
                      <DiffViewer
                        key={`${selectedProposal.manifest.proposalId}:${selectedChange.id}`}
                        original={selectedChange.beforeContent}
                        modified={selectedChange.afterContent}
                        language={languageForPath(selectedChange.targetPath)}
                        renderSideBySide={sideBySide}
                      />
                    </Suspense>
                  )}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
                请选择一个文件
              </div>
            )}
          </main>
        </div>
      )}
    </ProposalReviewSurface>
  );
}
