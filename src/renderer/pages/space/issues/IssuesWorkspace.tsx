import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  UserRoundCheck,
  X,
} from "lucide-react";

import type { SpaceIssue } from "@/api/spaceCloud";
import CustomSelect, { type SelectOption } from "@/components/CustomSelect";
import { Popover } from "@/components/ui/Popover";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { SpaceIdentityLine } from "@/pages/space/SpaceAvatar";
import {
  ALL_ISSUE_STATE_FILTER,
  ACTIVE_ISSUE_STATE_FILTER,
  claimHandlerLabel,
  ISSUE_STATUSES,
  issueDisplayNumber,
  issueDisplayTitle,
  issueStatusLabel,
} from "@/pages/space/spaceHelpers";
import { recordSpaceMetric } from "@/pages/space/spaceMetrics";
import {
  SPACE_COLLECTION_FRAME_CLASS,
  SPACE_PRIMARY_TOOL_BUTTON_CLASS,
  SPACE_REFRESH_TOOL_BUTTON_CLASS,
  formatFullTime,
  formatTime,
  statusPillClass,
} from "@/pages/space/spaceUi";

export function IssuesWorkspace({
  admin,
  issues,
  issuesLoading,
  issueError,
  showingPreviousIssues,
  hasMore,
  issueQ,
  selectedGoalId,
  selectedStatus,
  selectedStatusPreset,
  relatedToMe,
  goalOptions,
  activeIssueId,
  onQueryChange,
  onGoalChange,
  onStatusChange,
  onRelatedToMeChange,
  onRefresh,
  onLoadMore,
  onCreate,
  onOpenIssue,
}: {
  admin: boolean;
  issues: SpaceIssue[];
  issuesLoading: boolean;
  issueError: string | null;
  showingPreviousIssues: boolean;
  hasMore: boolean;
  issueQ: string;
  selectedGoalId: string;
  selectedStatus: string;
  selectedStatusPreset: string;
  relatedToMe: boolean;
  goalOptions: SelectOption[];
  activeIssueId: string | null;
  onQueryChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRelatedToMeChange: (value: boolean) => void;
  onRefresh: () => Promise<void>;
  onLoadMore: () => Promise<void>;
  onCreate: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const { t } = useTranslation("app");
  const toolbarRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const statusMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const statusMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const searchActive = searchOpen || issueQ.trim().length > 0;
  const statusMenuOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: ACTIVE_ISSUE_STATE_FILTER,
        label: t("space.filters.incompleteIssues"),
      },
      ...ISSUE_STATUSES.map((status) => ({
        value: status,
        label: issueStatusLabel(status, t),
      })),
    ],
    [t],
  );
  const selectedStatusOption =
    statusMenuOptions.find((option) => option.value === selectedStatusPreset) ??
    statusMenuOptions[0];
  const statusModeActive = selectedStatus !== ALL_ISSUE_STATE_FILTER;

  const focusAdjacentToolbarControl = (direction: 1 | -1) => {
    const trigger = statusMenuTriggerRef.current;
    const toolbar = toolbarRef.current;
    if (!trigger || !toolbar) return;
    const controls = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const triggerIndex = controls.indexOf(trigger);
    controls[triggerIndex + direction]?.focus();
  };

  const closeStatusMenuAndRestoreFocus = () => {
    setStatusMenuOpen(false);
    statusMenuTriggerRef.current?.focus();
  };

  useCloseLayer(
    () => {
      if (!statusMenuOpen) return false;
      closeStatusMenuAndRestoreFocus();
      return true;
    },
    statusMenuOpen ? 260 : -1,
  );

  useEffect(() => {
    recordSpaceMetric("space_issue_list_render_count", {
      count: issues.length,
    });
  }, [issues.length]);

  useEffect(() => {
    if (!searchOpen) return;
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  useEffect(() => {
    if (!statusMenuOpen) return;
    const selectedIndex = Math.max(
      0,
      statusMenuOptions.findIndex(
        (option) => option.value === selectedStatusPreset,
      ),
    );
    const handle = window.setTimeout(
      () => statusMenuItemRefs.current[selectedIndex]?.focus(),
      0,
    );
    return () => window.clearTimeout(handle);
  }, [selectedStatusPreset, statusMenuOpen, statusMenuOptions]);

  useEffect(() => {
    setLoadMoreFailed(false);
  }, [issueQ, relatedToMe, selectedGoalId, selectedStatus]);

  useEffect(() => {
    if (!issueError) setLoadMoreFailed(false);
  }, [issueError]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      await onLoadMore();
    } catch {
      // The store owns the inline error state; keep the current page visible.
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <section
        ref={toolbarRef}
        className="flex min-h-12 min-w-0 flex-nowrap items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-2 backdrop-blur-md"
      >
        <div
          className={
            searchActive
              ? "flex w-72 min-w-24 shrink items-center max-xl:w-40 max-xl:min-w-40"
              : "flex shrink-0 items-center"
          }
        >
          {searchActive ? (
            <label className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
              <input
                ref={searchInputRef}
                value={issueQ}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (issueQ.trim()) {
                    onQueryChange("");
                  } else {
                    setSearchOpen(false);
                  }
                }}
                className="h-9 w-full rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/85 pl-9 pr-10 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
                placeholder={t("space.issues.searchPlaceholder")}
              />
              <button
                type="button"
                onClick={() => {
                  onQueryChange("");
                  setSearchOpen(false);
                }}
                className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                aria-label={t("space.issues.closeSearch")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </label>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t("space.issues.searchIssue")}
              title={t("space.issues.searchIssue")}
            >
              <Search className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div
            role="group"
            aria-label={t("space.filters.issueStatus")}
            className="flex h-9 w-52 shrink-0 rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]/80 p-0.5"
          >
            <button
              type="button"
              aria-pressed={selectedStatus === ALL_ISSUE_STATE_FILTER}
              onClick={() => onStatusChange(ALL_ISSUE_STATE_FILTER)}
              className={`w-20 shrink-0 rounded-lg px-2 text-sm font-medium transition-colors active:scale-[0.98] ${
                selectedStatus === ALL_ISSUE_STATE_FILTER
                  ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm"
                  : "text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]/55 hover:text-[var(--ink)]"
              }`}
            >
              {t("space.filters.allIssues")}
            </button>
            <div
              className={`flex min-w-0 flex-1 overflow-hidden rounded-lg transition-colors ${
                statusModeActive
                  ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm"
                  : "text-[var(--ink-muted)]"
              }`}
            >
              <button
                type="button"
                aria-pressed={statusModeActive}
                onClick={() => onStatusChange(selectedStatusPreset)}
                className={`min-w-0 flex-1 truncate px-2 text-sm font-medium transition-colors active:scale-[0.98] ${
                  statusModeActive
                    ? "text-[var(--ink)]"
                    : "hover:bg-[var(--paper-elevated)]/55 hover:text-[var(--ink)]"
                }`}
              >
                {selectedStatusOption.label}
              </button>
              <button
                ref={statusMenuTriggerRef}
                type="button"
                aria-label={t("space.filters.chooseIssueStatus")}
                aria-haspopup="menu"
                aria-expanded={statusMenuOpen}
                onClick={() => setStatusMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                    return;
                  }
                  event.preventDefault();
                  setStatusMenuOpen(true);
                }}
                className={`grid w-8 shrink-0 place-items-center border-l border-[var(--line-subtle)] transition-colors active:scale-[0.96] ${
                  statusModeActive
                    ? "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    : "hover:bg-[var(--paper-elevated)]/55 hover:text-[var(--ink)]"
                }`}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${statusMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
            </div>
          </div>
          <Popover
            open={statusMenuOpen}
            onClose={() => setStatusMenuOpen(false)}
            anchorRef={statusMenuTriggerRef}
            placement="bottom-end"
            className="min-w-44 py-1"
          >
            <div
              role="menu"
              aria-label={t("space.filters.issueStatus")}
              onKeyDown={(event) => {
                const currentIndex = statusMenuItemRefs.current.findIndex(
                  (item) => item === document.activeElement,
                );
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  const nextIndex =
                    currentIndex < 0
                      ? direction === 1
                        ? 0
                        : statusMenuOptions.length - 1
                      : (currentIndex + direction + statusMenuOptions.length) %
                        statusMenuOptions.length;
                  statusMenuItemRefs.current[nextIndex]?.focus();
                  return;
                }
                if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  const nextIndex =
                    event.key === "Home" ? 0 : statusMenuOptions.length - 1;
                  statusMenuItemRefs.current[nextIndex]?.focus();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeStatusMenuAndRestoreFocus();
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  setStatusMenuOpen(false);
                  focusAdjacentToolbarControl(event.shiftKey ? -1 : 1);
                }
              }}
            >
              {statusMenuOptions.map((option, index) => (
                <div key={option.value}>
                  {index === 1 ? (
                    <div className="my-1 border-t border-[var(--line-subtle)]" />
                  ) : null}
                  <button
                    ref={(node) => {
                      statusMenuItemRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === selectedStatusPreset}
                    tabIndex={
                      option.value === selectedStatusOption.value ? 0 : -1
                    }
                    onClick={() => {
                      onStatusChange(option.value);
                      closeStatusMenuAndRestoreFocus();
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      option.value === selectedStatusPreset
                        ? "text-[var(--accent-warm)]"
                        : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {option.value === selectedStatusPreset ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                </div>
              ))}
            </div>
          </Popover>
          <CustomSelect
            value={selectedGoalId}
            options={goalOptions}
            onChange={onGoalChange}
            size="toolbar"
            className="min-w-0 flex-1 max-w-[360px] max-xl:min-w-20"
          />
          <button
            type="button"
            onClick={() => onRelatedToMeChange(!relatedToMe)}
            aria-pressed={relatedToMe}
            className={`inline-flex h-9 min-w-fit shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition-colors max-xl:px-2 ${
              relatedToMe
                ? "border-[var(--accent-warm)]/35 bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                : "border-[var(--line)] bg-[var(--paper-elevated)]/70 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            }`}
          >
            <UserRoundCheck className="h-4 w-4" />
            <span className="max-xl:sr-only">
              {t("space.filters.relatedToMe")}
            </span>
          </button>
        </div>
        <div
          className={`ml-auto shrink-0 items-center gap-2.5 ${
            searchActive ? "flex max-xl:hidden" : "flex"
          }`}
        >
          <button
            type="button"
            onClick={onCreate}
            className={`${SPACE_PRIMARY_TOOL_BUTTON_CLASS} max-xl:px-3`}
          >
            <Plus className="h-4 w-4" />
            <span className="max-xl:sr-only">{t("space.common.create")}</span>
          </button>
          <button
            type="button"
            onClick={() => void onRefresh().catch(() => undefined)}
            className={SPACE_REFRESH_TOOL_BUTTON_CLASS}
            aria-label={t("space.common.refresh")}
            title={t("space.common.refresh")}
          >
            {issuesLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
        <section
          className={SPACE_COLLECTION_FRAME_CLASS}
          aria-label="Issue list"
        >
          {issueError && issues.length > 0 ? (
            <div
              role="alert"
              className="mb-2 flex min-h-10 items-center gap-2 rounded-xl border border-[var(--warning)]/20 bg-[var(--warning-bg)] px-3 text-sm text-[var(--warning)]"
            >
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 font-medium">
                {t("space.common.listRefreshFailed")}
              </span>
              <button
                type="button"
                onClick={() =>
                  void (loadMoreFailed ? loadMore() : onRefresh()).catch(
                    () => undefined,
                  )
                }
                className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold transition-colors hover:bg-[var(--paper-elevated)]/60"
              >
                {t("space.common.retry")}
              </button>
            </div>
          ) : showingPreviousIssues && issuesLoading ? (
            <div className="mb-2 flex min-h-9 items-center justify-center gap-2 rounded-xl bg-[var(--paper-elevated)]/55 px-3 text-xs font-semibold text-[var(--ink-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("space.common.updatingResults")}
            </div>
          ) : null}
          <div className="border-y border-[var(--line-subtle)]">
            {issues.length === 0 && issueError ? (
              <div
                role="alert"
                className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]"
              >
                <div className="text-center">
                  <CircleAlert className="mx-auto mb-2 h-6 w-6 text-[var(--warning)]" />
                  <p>{t("space.common.listRefreshFailed")}</p>
                  <button
                    type="button"
                    onClick={() => void onRefresh().catch(() => undefined)}
                    className="mt-3 inline-flex h-9 items-center rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                  >
                    {t("space.common.retry")}
                  </button>
                </div>
              </div>
            ) : issues.length === 0 && issuesLoading ? (
              <div className="grid gap-0">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="min-h-[68px] border-b border-[var(--line-subtle)] py-3 last:border-b-0"
                  >
                    <div className="h-3.5 w-44 rounded-md bg-[var(--paper-inset)]" />
                    <div className="mt-2 h-3 w-72 rounded-md bg-[var(--paper-inset)]" />
                  </div>
                ))}
              </div>
            ) : issues.length === 0 ? (
              <div className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]">
                <div className="text-center">
                  <p>
                    {relatedToMe
                      ? t("space.issues.emptyRelated")
                      : t("space.issues.empty")}
                  </p>
                  {admin && (
                    <button
                      type="button"
                      onClick={onCreate}
                      className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                    >
                      <Plus className="h-4 w-4" />
                      {t("space.issues.createIssue")}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              issues.map((issue, index) => (
                <IssueStreamRow
                  key={issue.id}
                  issue={issue}
                  active={activeIssueId === issue.id}
                  index={index}
                  onOpen={() => onOpenIssue(issue.id)}
                />
              ))
            )}
          </div>
          {hasMore && !showingPreviousIssues ? (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-4 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("space.common.loadMore")}
              </button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function IssueStreamRow({
  issue,
  active,
  index,
  onOpen,
}: {
  issue: SpaceIssue;
  active: boolean;
  index: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation("app");
  const displayTitle = issueDisplayTitle(issue);
  const displayNumber = issueDisplayNumber(issue);
  const author = issue.creator ?? issue.author ?? null;
  const handlerName = claimHandlerLabel(issue.claim);
  const goalLabel = issue.goalPathLabel || issue.goalId || null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animationDelay: `${index * 42}ms` }}
      className={`grid min-h-[68px] w-full border-b border-[var(--line-subtle)] px-1 py-3 text-left transition-colors last:border-b-0 sm:px-3 ${
        active
          ? "bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]"
          : "hover:bg-[var(--hover-bg)]"
      }`}
    >
      <span className="min-w-0">
        <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <span
            className={`inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 text-xs font-medium ${statusPillClass(issue.state)}`}
          >
            {issueStatusLabel(issue.state, t)}
          </span>
          <span className="truncate text-sm font-semibold leading-5 text-[var(--ink)]">
            {displayTitle}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-normal leading-5 text-[var(--ink-subtle)]">
          {displayNumber && (
            <>
              <span className="text-[var(--ink-muted)]">{displayNumber}</span>
              <span className="text-[var(--line-strong)]">·</span>
            </>
          )}
          <SpaceIdentityLine
            name={author?.name ?? author?.id ?? "owner"}
            avatarUrl={author?.avatarUrl}
            avatarSize={20}
            nameClassName="font-medium text-[var(--ink-subtle)]"
          />
          <span className="text-[var(--line-strong)]">·</span>
          <span title={formatFullTime(issue.updatedAt)}>
            {formatTime(issue.updatedAt)}
          </span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>
            {t("space.issues.comments", { count: issue.commentCount ?? 0 })}
          </span>
          {handlerName && (
            <>
              <span className="text-[var(--line-strong)]">·</span>
              <span className="rounded-md bg-[var(--warning-bg)]/70 px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                {t("space.issues.claimHandler", { name: handlerName })}
              </span>
            </>
          )}
          {goalLabel && (
            <>
              <span className="text-[var(--line-strong)]">·</span>
              <span className="inline-flex max-w-[46ch] truncate rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)]/45 px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                {goalLabel}
              </span>
            </>
          )}
          {issue.humanOnly && (
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
              {t("space.issues.humanOnly")}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
