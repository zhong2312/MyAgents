import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileCheck2,
  FilePenLine,
  FilePlus2,
  GitCompareArrows,
  Loader2,
  Merge,
  RotateCcw,
  Trash2,
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

import {
  ConfirmDialog,
  DraggableDialogFrame,
  ProposalReviewSurface,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalLoadError,
  FileProposalRepository,
  FileProposalStatus,
} from "./fileProposal";
import { createNovelWorldProposalRepository } from "./worldProposalRepository";

const DiffViewer = lazy(() => import("@/workbench-sdk/DiffViewer"));
const MonacoEditor = lazy(() => import("@/components/MonacoEditor"));

export type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalLoadError,
  FileProposalRepository,
  FileProposalStatus,
} from "./fileProposal";

export interface WorldProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onClose: () => void;
  readonly repositoryFactory?: (
    storage: WorkbenchStorage,
  ) => FileProposalRepository;
  readonly reviewTitle?: string;
  readonly proposalSubject?: string;
  /** Runs after the domain repository has durably applied selected changes. */
  readonly onApplied?: () => void;
}

const STATUS_LABELS: Record<FileProposalStatus, string> = {
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
  proposals: readonly FileProposal[],
  next: FileProposal,
): readonly FileProposal[] {
  return proposals.map((proposal) =>
    proposal.manifest.proposalId === next.manifest.proposalId ? next : proposal,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFileProposalStatus(
  proposal: Pick<FileProposal, "manifest">,
): FileProposalStatus {
  const statuses = proposal.manifest.changes.map((change) => change.status);
  if (statuses.every((status) => status === "applied")) return "applied";
  if (statuses.every((status) => status === "rejected")) return "rejected";
  if (statuses.some((status) => status === "applied")) {
    return "partially-applied";
  }
  return "pending";
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

const MISSING_JSON_VALUE = Symbol("missing-json-value");
type MergeValue = JsonValue | typeof MISSING_JSON_VALUE;

interface MergeDraft {
  readonly content: string;
  readonly conflicts: readonly string[];
  readonly automatic: boolean;
}

function sameJsonValue(left: MergeValue, right: MergeValue): boolean {
  if (left === MISSING_JSON_VALUE || right === MISSING_JSON_VALUE) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(
  value: MergeValue,
): value is { readonly [key: string]: JsonValue } {
  return (
    value !== MISSING_JSON_VALUE &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isIdObjectArray(value: JsonValue[]): boolean {
  return value.every(
    (item) =>
      isJsonObject(item) &&
      typeof (item as { readonly id?: unknown }).id === "string",
  );
}

function mergeJsonValue(
  baseline: MergeValue,
  current: MergeValue,
  proposal: MergeValue,
  path: string,
  conflicts: string[],
): MergeValue {
  if (sameJsonValue(current, baseline)) return proposal;
  if (sameJsonValue(proposal, baseline) || sameJsonValue(current, proposal)) {
    return current;
  }

  if (
    isJsonObject(baseline) &&
    isJsonObject(current) &&
    isJsonObject(proposal)
  ) {
    const result: Record<string, JsonValue> = {};
    const keys = new Set([
      ...Object.keys(baseline),
      ...Object.keys(current),
      ...Object.keys(proposal),
    ]);
    for (const key of keys) {
      const merged = mergeJsonValue(
        Object.hasOwn(baseline, key) ? baseline[key] : MISSING_JSON_VALUE,
        Object.hasOwn(current, key) ? current[key] : MISSING_JSON_VALUE,
        Object.hasOwn(proposal, key) ? proposal[key] : MISSING_JSON_VALUE,
        path ? `${path}.${key}` : key,
        conflicts,
      );
      if (merged !== MISSING_JSON_VALUE) result[key] = merged;
    }
    return result;
  }

  if (
    Array.isArray(baseline) &&
    Array.isArray(current) &&
    Array.isArray(proposal) &&
    isIdObjectArray(baseline) &&
    isIdObjectArray(current) &&
    isIdObjectArray(proposal)
  ) {
    const byId = (items: JsonValue[]) =>
      new Map(
        items.map((item) => [
          String((item as { readonly id: string }).id),
          item,
        ]),
      );
    const baselineById = byId(baseline);
    const currentById = byId(current);
    const proposalById = byId(proposal);
    const ids = [
      ...currentById.keys(),
      ...[...proposalById.keys()].filter((id) => !currentById.has(id)),
    ];
    const result: JsonValue[] = [];
    for (const id of ids) {
      const merged = mergeJsonValue(
        baselineById.get(id) ?? MISSING_JSON_VALUE,
        currentById.get(id) ?? MISSING_JSON_VALUE,
        proposalById.get(id) ?? MISSING_JSON_VALUE,
        `${path}[id=${id}]`,
        conflicts,
      );
      if (merged !== MISSING_JSON_VALUE) result.push(merged);
    }
    return result;
  }

  conflicts.push(path || "根内容");
  return current;
}

function buildMergeDraft(change: FileProposalChange): MergeDraft {
  const current = change.currentContent ?? "";
  if (change.baseContentAvailable === false) {
    return {
      content: current || change.afterContent,
      conflicts: ["旧提案未保存对象级基准，请人工核对当前内容与提案内容"],
      automatic: false,
    };
  }
  if (!change.targetPath.endsWith(".json")) {
    return {
      content: current || change.afterContent,
      conflicts: ["文本文件需要人工合并"],
      automatic: false,
    };
  }
  try {
    const baseline = JSON.parse(change.beforeContent || "null") as JsonValue;
    const formal = JSON.parse(current || "null") as JsonValue;
    const proposal = JSON.parse(change.afterContent) as JsonValue;
    const conflicts: string[] = [];
    const merged = mergeJsonValue(baseline, formal, proposal, "", conflicts);
    return {
      content: `${JSON.stringify(merged, null, 2)}\n`,
      conflicts,
      automatic: true,
    };
  } catch {
    return {
      content: current || change.afterContent,
      conflicts: ["内容不是可自动合并的有效 JSON，请人工合并"],
      automatic: false,
    };
  }
}

interface ConflictMergeDialogProps {
  readonly change: FileProposalChange;
  readonly loading: boolean;
  readonly onApply: (content: string) => void;
  readonly onClose: () => void;
}

function ConflictMergeDialog({
  change,
  loading,
  onApply,
  onClose,
}: ConflictMergeDialogProps) {
  const initial = useMemo(() => buildMergeDraft(change), [change]);
  const [view, setView] = useState<"proposal" | "baseline" | "result">(
    "proposal",
  );
  const [draft, setDraft] = useState(initial.content);
  const [conflicts, setConflicts] = useState(initial.conflicts);

  const rebuildAutomaticDraft = () => {
    const next = buildMergeDraft(change);
    setDraft(next.content);
    setConflicts(next.conflicts);
    setView("result");
  };

  return (
    <DraggableDialogFrame
      ariaLabel={`合并冲突 ${change.targetPath}`}
      positioning="viewport"
      overlayClassName="bg-black/30 backdrop-blur-[1px]"
      className="h-[min(760px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))]"
      headerClassName="flex min-h-14 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4"
      header={
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
            <Merge className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">合并冲突</h2>
            <p className="truncate font-mono text-xs text-[var(--ink-muted)]">
              {change.targetPath}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭合并窗口"
            title="关闭"
            disabled={loading}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--paper)] px-3 py-2">
          <div className="flex items-center rounded-md bg-[var(--paper-inset)] p-1">
            <button
              type="button"
              onClick={() => setView("proposal")}
              className={`h-7 rounded px-3 text-xs ${
                view === "proposal"
                  ? "bg-[var(--paper-elevated)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              正式内容 ↔ 提案
            </button>
            <button
              type="button"
              disabled={change.baseContentAvailable === false}
              onClick={() => setView("baseline")}
              className={`h-7 rounded px-3 text-xs disabled:opacity-35 ${
                view === "baseline"
                  ? "bg-[var(--paper-elevated)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              生成基准 ↔ 正式内容
            </button>
            <button
              type="button"
              onClick={() => setView("result")}
              className={`h-7 rounded px-3 text-xs ${
                view === "result"
                  ? "bg-[var(--paper-elevated)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              合并结果
            </button>
          </div>
          <span className="min-w-0 flex-1" />
          <button
            type="button"
            title="重新生成自动合并初稿"
            onClick={rebuildAutomaticDraft}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs hover:bg-[var(--hover-bg)]"
          >
            <RotateCcw className="h-3.5 w-3.5" /> 自动合并
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(change.currentContent ?? "");
              setView("result");
            }}
            className="h-8 rounded-md border border-[var(--line)] px-2.5 text-xs hover:bg-[var(--hover-bg)]"
          >
            以正式内容为初稿
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(change.afterContent);
              setView("result");
            }}
            className="h-8 rounded-md border border-[var(--line)] px-2.5 text-xs hover:bg-[var(--hover-bg)]"
          >
            以提案为初稿
          </button>
        </div>
        {conflicts.length > 0 && (
          <div className="flex shrink-0 items-start gap-2 border-b border-[var(--line)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--warning)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              自动合并保留了正式内容，仍有 {conflicts.length} 处需要核对：
              {conflicts.slice(0, 4).join("、")}
              {conflicts.length > 4 ? "…" : ""}
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在载入编辑器
              </div>
            }
          >
            {view === "result" ? (
              <MonacoEditor
                value={draft}
                onChange={setDraft}
                language={languageForPath(change.targetPath)}
                className="h-full"
                autoFocus
              />
            ) : (
              <DiffViewer
                key={`${change.id}:${view}`}
                original={
                  view === "baseline"
                    ? change.beforeContent
                    : (change.currentContent ?? "")
                }
                modified={
                  view === "baseline"
                    ? (change.currentContent ?? "")
                    : change.afterContent
                }
                language={languageForPath(change.targetPath)}
                renderSideBySide
              />
            )}
          </Suspense>
        </div>
        <footer className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4">
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className="h-9 rounded-md border border-[var(--line)] px-4 text-xs font-medium hover:bg-[var(--hover-bg)] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading || !draft.trim()}
            onClick={() => onApply(draft)}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-4 text-xs font-medium text-white disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileCheck2 className="h-3.5 w-3.5" />
            )}
            应用合并结果
          </button>
        </footer>
      </div>
    </DraggableDialogFrame>
  );
}

function ChangeStatus({ change }: { readonly change: FileProposalChange }) {
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
  repositoryFactory = createNovelWorldProposalRepository,
  reviewTitle = "世界架构提案",
  proposalSubject = "世界架构",
  onApplied,
}: WorldProposalReviewProps) {
  const repository = useMemo(
    () => repositoryFactory(storage),
    [repositoryFactory, storage],
  );
  const [proposals, setProposals] = useState<readonly FileProposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [selectedProposalIds, setSelectedProposalIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectedChangeId, setSelectedChangeId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [proposalErrors, setProposalErrors] = useState<
    readonly FileProposalLoadError[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<
    "apply" | "reject" | "delete" | "delete-proposals" | "resolve" | null
  >(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [proposalDeleteConfirmOpen, setProposalDeleteConfirmOpen] =
    useState(false);
  const [conflictConfirm, setConflictConfirm] = useState<
    "keep-current" | "use-proposal" | null
  >(null);
  const [mergeChangeId, setMergeChangeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const loaded = await repository.list();
      setProposals(loaded.proposals);
      setProposalErrors(loaded.errors);
      const availableProposalIds = new Set([
        ...loaded.proposals.map((item) => item.manifest.proposalId),
        ...loaded.errors.map((item) => item.proposalId),
      ]);
      setSelectedProposalIds(
        (current) =>
          new Set([...current].filter((id) => availableProposalIds.has(id))),
      );
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
      if (
        event.key === "Escape" &&
        !mergeChangeId &&
        !conflictConfirm &&
        !deleteConfirmOpen &&
        !proposalDeleteConfirmOpen
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    conflictConfirm,
    deleteConfirmOpen,
    mergeChangeId,
    onClose,
    proposalDeleteConfirmOpen,
  ]);

  const selectedProposal =
    proposals.find(
      (proposal) => proposal.manifest.proposalId === selectedProposalId,
    ) ?? proposals[0];

  const proposalSelectionIds = [
    ...proposals.map((proposal) => proposal.manifest.proposalId),
    ...proposalErrors.map((proposalError) => proposalError.proposalId),
  ];
  const allProposalsSelected =
    proposalSelectionIds.length > 0 &&
    proposalSelectionIds.every((id) => selectedProposalIds.has(id));

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
  const mergeChange = selectedProposal?.changes.find(
    (change) => change.id === mergeChangeId,
  );

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

  const pendingChangeIds = selectedProposal
    ? selectedProposal.changes
        .filter((change) => change.status === "pending")
        .map((change) => change.id)
    : [];
  const allPendingChangesSelected =
    pendingChangeIds.length > 0 &&
    pendingChangeIds.every((id) => selectedIds.has(id));

  const toggleChange = (change: FileProposalChange) => {
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
      if (allPendingChangesSelected) {
        pendingChangeIds.forEach((id) => next.delete(id));
      } else {
        pendingChangeIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleProposal = (proposalId: string) => {
    setSelectedProposalIds((current) => {
      const next = new Set(current);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  };

  const toggleAllProposals = () => {
    setSelectedProposalIds((current) => {
      const next = new Set(current);
      if (allProposalsSelected) {
        proposalSelectionIds.forEach((id) => next.delete(id));
      } else {
        proposalSelectionIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleDeleteProposals = async () => {
    if (selectedProposalIds.size === 0) return;
    setAction("delete-proposals");
    setError(null);
    try {
      await repository.deleteProposals([...selectedProposalIds]);
      setSelectedProposalIds(new Set());
      setProposalDeleteConfirmOpen(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
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
      onApplied?.();
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

  const handleDelete = async () => {
    if (!selectedProposal || selectedPendingIds.length === 0) return;
    setAction("delete");
    setError(null);
    try {
      const next = await repository.delete(
        selectedProposal.manifest.proposalId,
        selectedPendingIds,
      );
      if (next) {
        setProposals((current) => replaceProposal(current, next));
      } else {
        setProposals((current) =>
          current.filter(
            (proposal) =>
              proposal.manifest.proposalId !==
              selectedProposal.manifest.proposalId,
          ),
        );
        setSelectedProposalId("");
      }
      setDeleteConfirmOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const handleKeepCurrent = async () => {
    if (!selectedProposal || !selectedChange?.conflict) return;
    setAction("resolve");
    setError(null);
    try {
      const next = await repository.reject(
        selectedProposal.manifest.proposalId,
        [selectedChange.id],
      );
      setProposals((current) => replaceProposal(current, next));
      setConflictConfirm(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const handleResolveConflict = async (
    resolution: FileProposalConflictResolution,
  ) => {
    if (!selectedProposal || !selectedChange?.conflict) return;
    setAction("resolve");
    setError(null);
    try {
      const next = await repository.resolveConflict(
        selectedProposal.manifest.proposalId,
        selectedChange.id,
        resolution,
        projectTitle,
      );
      setProposals((current) => replaceProposal(current, next));
      setConflictConfirm(null);
      setMergeChangeId("");
      onApplied?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  return (
    <>
      <ProposalReviewSurface
        title={reviewTitle}
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
            <p className="mt-3 text-sm">暂无{proposalSubject}提案</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 max-md:flex-col">
            <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-lg:w-72 max-md:h-64 max-md:w-full max-md:border-r-0 max-md:border-b">
              <div className="shrink-0 border-b border-[var(--line)] p-2">
                <div className="mb-1 flex h-7 items-center gap-2 px-1 text-xs">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      aria-label="全选提案"
                      checked={allProposalsSelected}
                      disabled={proposalSelectionIds.length === 0}
                      onChange={toggleAllProposals}
                      className="h-3.5 w-3.5 accent-[var(--accent-cool)]"
                    />
                    <span>提案列表</span>
                    <span className="font-normal text-[var(--ink-muted)]">
                      {selectedProposalIds.size}/{proposalSelectionIds.length}
                    </span>
                  </label>
                  <button
                    type="button"
                    aria-label="删除选中提案"
                    title="删除选中提案"
                    onClick={() => setProposalDeleteConfirmOpen(true)}
                    disabled={action !== null || selectedProposalIds.size === 0}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-30"
                  >
                    {action === "delete-proposals" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <div className="max-h-36 overflow-y-auto max-md:max-h-20">
                  {proposals.map((proposal) => {
                    const active =
                      proposal.manifest.proposalId ===
                      selectedProposal?.manifest.proposalId;
                    const status = getFileProposalStatus(proposal);
                    return (
                      <div
                        key={proposal.manifest.proposalId}
                        className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 ${
                          active
                            ? "bg-[var(--accent-cool-subtle)]"
                            : "hover:bg-[var(--hover-bg)]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`选择提案 ${proposal.manifest.title}`}
                          checked={selectedProposalIds.has(
                            proposal.manifest.proposalId,
                          )}
                          onChange={() =>
                            toggleProposal(proposal.manifest.proposalId)
                          }
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent-cool)]"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedProposalId(proposal.manifest.proposalId)
                          }
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
                      </div>
                    );
                  })}
                  {proposalErrors.map((proposalError) => (
                    <div
                      key={proposalError.proposalId}
                      className="mb-1 flex items-start gap-2 rounded-md bg-[var(--error-bg)] px-2 py-2 text-[var(--error)]"
                      title={proposalError.message}
                    >
                      <input
                        type="checkbox"
                        aria-label={`选择提案 ${proposalError.proposalId}`}
                        checked={selectedProposalIds.has(
                          proposalError.proposalId,
                        )}
                        onChange={() =>
                          toggleProposal(proposalError.proposalId)
                        }
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent-cool)]"
                      />
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
                      aria-label="全选待处理变更"
                      checked={allPendingChangesSelected}
                      disabled={pendingChangeIds.length === 0}
                      onChange={toggleAllChanges}
                      className="h-3.5 w-3.5 accent-[var(--accent-cool)]"
                    />
                    <span className="min-w-0 flex-1">全选待处理变更</span>
                    <span className="text-[var(--ink-muted)]">
                      {selectedPendingIds.length}/{pendingChangeIds.length}
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
                            <span className="flex min-w-0 items-center gap-1.5">
                              <OperationIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                              <strong
                                className="min-w-0 flex-1 truncate text-xs font-medium"
                                title={change.targetPath.split("/").at(-1)}
                              >
                                {change.targetPath.split("/").at(-1)}
                              </strong>
                              <span className="shrink-0 text-xs">
                                <ChangeStatus change={change} />
                              </span>
                              {change.inferred && (
                                <span className="shrink-0 rounded bg-[var(--paper-elevated)] px-1 py-0.5 text-xs text-[var(--ink-subtle)]">
                                  自动补录
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                              {change.summary}
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
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmOpen(true)}
                      disabled={
                        action !== null || selectedPendingIds.length === 0
                      }
                      className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--error)]/40 text-xs font-medium text-[var(--error)] disabled:opacity-40"
                    >
                      {action === "delete" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      删除选中
                    </button>
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
                  {selectedChange.conflict &&
                    selectedChange.status === "pending" &&
                    !selectedChange.loadError && (
                      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2">
                        <div className="mr-auto flex min-w-60 items-start gap-2 text-xs text-[var(--error)]">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            正式内容在提案生成后发生了变化。请选择保留一方，或核对差异后合并。
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={action !== null}
                          onClick={() => setConflictConfirm("keep-current")}
                          className="h-8 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-xs font-medium hover:bg-[var(--hover-bg)] disabled:opacity-40"
                        >
                          保留正式版本
                        </button>
                        <button
                          type="button"
                          disabled={action !== null}
                          onClick={() => setConflictConfirm("use-proposal")}
                          className="h-8 rounded-md border border-[var(--error)]/40 bg-[var(--paper)] px-3 text-xs font-medium text-[var(--error)] hover:bg-[var(--hover-bg)] disabled:opacity-40"
                        >
                          使用提案版本
                        </button>
                        <button
                          type="button"
                          disabled={action !== null}
                          onClick={() => setMergeChangeId(selectedChange.id)}
                          className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-3 text-xs font-medium text-white disabled:opacity-40"
                        >
                          <Merge className="h-3.5 w-3.5" /> 合并内容
                        </button>
                      </div>
                    )}
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
                          original={
                            selectedChange.conflict
                              ? (selectedChange.currentContent ?? "")
                              : selectedChange.beforeContent
                          }
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
      {mergeChange && (
        <ConflictMergeDialog
          change={mergeChange}
          loading={action === "resolve"}
          onClose={() => {
            if (action !== "resolve") setMergeChangeId("");
          }}
          onApply={(content) =>
            void handleResolveConflict({
              strategy: "merge",
              expectedCurrentContent: mergeChange.currentContent,
              content,
            })
          }
        />
      )}
      {conflictConfirm === "keep-current" && selectedChange?.conflict && (
        <ConfirmDialog
          title="保留正式版本"
          message="将保留当前正式内容，并把这项提案标记为已拒绝。提案记录仍会保留用于审计，是否继续？"
          confirmText="保留正式版本"
          cancelText="取消"
          confirmVariant="primary"
          loading={action === "resolve"}
          onConfirm={() => void handleKeepCurrent()}
          onCancel={() => setConflictConfirm(null)}
        />
      )}
      {conflictConfirm === "use-proposal" && selectedChange?.conflict && (
        <ConfirmDialog
          title="使用提案版本"
          message="将以提案内容替换当前正式内容。写入前会再次检查正式内容是否变化，并执行领域数据校验，是否继续？"
          confirmText="使用提案版本"
          cancelText="取消"
          confirmVariant="danger"
          loading={action === "resolve"}
          onConfirm={() =>
            void handleResolveConflict({
              strategy: "use-proposal",
              expectedCurrentContent: selectedChange.currentContent,
            })
          }
          onCancel={() => setConflictConfirm(null)}
        />
      )}
      {deleteConfirmOpen && selectedProposal && (
        <ConfirmDialog
          title="删除提案内容"
          message={
            selectedPendingIds.length === selectedProposal.changes.length
              ? "将永久删除整份未处理提案及其所有快照，是否继续？"
              : `将永久删除选中的 ${selectedPendingIds.length} 项提案内容及其快照，是否继续？`
          }
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
          loading={action === "delete"}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
      {proposalDeleteConfirmOpen && selectedProposalIds.size > 0 && (
        <ConfirmDialog
          title="删除提案"
          message={`将永久删除选中的 ${selectedProposalIds.size} 份提案记录及其快照。已经应用到小说的正式内容不会回滚，是否继续？`}
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
          loading={action === "delete-proposals"}
          onConfirm={() => void handleDeleteProposals()}
          onCancel={() => setProposalDeleteConfirmOpen(false)}
        />
      )}
    </>
  );
}
