// TaskListPanel — right column of Task Center: task cards + filter bar.
// Three sections: active (running/verifying), pending (todo/blocked/stopped),
// finished (done/archived). PRD §7.2.
//
// Two render modes: a 2-column card view and a dense single-line list view
// (default, optimized for quick scan / filter). The choice is persisted in
// localStorage so returning users see their last-picked view.
//
// Unmigrated historical Cron rows remain visible as read-only diagnostics.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Folder, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  taskCenterAvailable,
  taskDelete,
  taskList,
  taskRerun,
  taskRun,
  taskUpdateStatus,
} from '@/api/taskCenter';
import { track } from '@/analytics';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { listenWithCleanup } from '@/utils/tauriListen';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { isProjectActiveForUser } from '@/config/types';
import { isManagedScheduledJob } from '@/../shared/managedScheduledJob';
import type { Task, TaskStatus } from '@/../shared/types/task';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '@/../shared/workspacePath';
import { DispatchTaskDialog } from './DispatchTaskDialog';
import { LegacyCronOverlay } from './LegacyCronOverlay';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskListRow } from './views/TaskListRow';
import { SearchPill } from './SearchPill';
import { shouldAddOrphanWorkspacePath } from './taskListPanelWorkspace';
import { ViewToggle, type TaskView } from './views/ViewToggle';
import type { LegacyCronRow } from './views/types';

/** Union of what the right-column list renders — a real Task or a legacy cron. */
type TaskCardLike =
  | { kind: 'task'; task: Task }
  | { kind: 'legacy-cron'; legacy: LegacyCronRow };

interface Props {
  highlightTaskId?: string | null;
  currentSessionId?: string | null;
  /** Bumped by parent to trigger re-fetch (tab activation, post-dispatch). */
  refreshKey?: unknown;
  /** Intent forwarded from `App.tsx`'s `OPEN_TASK_CENTER` event handler.
   *  `autofocusSearch: true` + a changing `nonce` tells this panel to
   *  programmatically focus the search input so the user can start typing
   *  immediately. Firing the same intent twice in a row (user clicks the
   *  Launcher search icon twice) requires the `nonce` to change — it's
   *  the dependency `useEffect` watches. */
  pendingIntent?: { autofocusSearch?: boolean; nonce: number } | null;
}

type Bucket = 'pending' | 'active' | 'finished';

// "进行中" 的产品语义是「应当被执行的任务」，不是字面"正在跑"。
// `stopped`（用户暂停）和 `blocked`（执行受阻）都是**临时子状态**，
// 任务本身仍被认为该跑 —— 徽章的黄/灰配色已经区分了子状态，列表聚合
// 不必再按这些小波动分桶。`规划中` 留给真正的新建未调度态（todo）——
// 任务已被构思并创建，但尚未被调度器首次触发。
const BUCKET_STATUSES: Record<Bucket, TaskStatus[]> = {
  active: ['running', 'verifying', 'stopped', 'blocked'],
  pending: ['todo'],
  finished: ['done', 'archived'],
};

const VIEW_STORAGE_KEY = 'myagents:task-center:view';

function loadStoredView(): TaskView {
  if (typeof window === 'undefined') return 'list';
  const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return raw === 'card' ? 'card' : 'list';
}

export function TaskListPanel({ highlightTaskId, refreshKey, pendingIntent, currentSessionId }: Props) {
  const toast = useToast();
  const { t } = useTranslation('task');
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  const { projects } = useConfig();
  // Serialize reload() calls. A trailing pending flag catches state changes
  // that arrive while the current read is in flight.
  const reloadInflightRef = useRef(false);
  const reloadPendingRef = useRef(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [legacy, setLegacy] = useState<LegacyCronRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  // Workspace filter — empty string = "全部" (no filter). Stored by
  // workspace path (same key the Task row uses), resolved to a
  // display name via `projects` in the option list below.
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // When set, `TaskDetailOverlay` opens already in edit mode — used by the
  // card/row "编辑" menu item so the user lands straight on the editor
  // instead of the read-only detail view.
  const [selectedTaskStartEditing, setSelectedTaskStartEditing] = useState(false);
  const [selectedLegacy, setSelectedLegacy] = useState<LegacyCronRow | null>(null);
  const [view, setView] = useState<TaskView>(loadStoredView);
  // Inline "新建任务" modal — opened by the header "+ 新建" button.
  // Renders `DispatchTaskDialog` without a `thought` prop so it enters
  // the dialog's blank-state branch (default once-mode).
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Per-id busy flag so only the affected card/row greys out during an action,
  // instead of locking the whole panel.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const updateView = useCallback((next: TaskView) => {
    setView(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    }
  }, []);

  const reload = useCallback(async () => {
    if (reloadInflightRef.current) {
      reloadPendingRef.current = true;
      return;
    }
    reloadInflightRef.current = true;
    reloadPendingRef.current = false;
    setLoading(true);
    try {
      const [nativeList, legacyList] = await Promise.all([
        taskList({}),
        fetchLegacyCronTasks(t('tasks.unnamedLegacyTask')),
      ]);
      setTasks(nativeList.filter((task) => !isManagedScheduledJob(task)));
      setLegacy(legacyList);
    } catch (err) {
      console.error('[TaskListPanel] load failed', err);
      setTasks([]);
      setLegacy([]);
    } finally {
      setLoading(false);
      reloadInflightRef.current = false;
      if (reloadPendingRef.current) {
        // A status change landed during this run — kick another pass so
        // we don't lose the state that arrived mid-flight.
        reloadPendingRef.current = false;
        void reloadRef.current?.();
      }
    }
  }, [t]);
  // Self-reference so the trailing re-kick above can call the latest
  // closure without adding `reload` to its own dep array.
  const reloadRef = useRef<typeof reload>(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  // Focus the search input when the parent forwards a `{ autofocusSearch:
  // true }` intent. Triggered by the Launcher "我的任务" tab's search
  // icon — it opens this tab and wants the user to start typing without
  // an extra click. `nonce` is the change signal so firing the same
  // intent twice (user clicks search icon again while the tab is open)
  // still re-runs the effect. `requestAnimationFrame` waits for the
  // layout pass that mounts the SearchPill input; focusing on the same
  // tick silently drops when the element isn't yet attached.
  const intentNonce = pendingIntent?.nonce ?? 0;
  const intentAutofocus = pendingIntent?.autofocusSearch ?? false;
  useEffect(() => {
    if (!intentAutofocus || intentNonce === 0) return;
    const raf = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [intentAutofocus, intentNonce]);


  // Lifecycle projections are transient, so every Task mutation event refetches
  // the authoritative Task + execution snapshot.
  // and refetch so every open TaskCenter tab stays in sync with the source of
  // truth. Guarded on Tauri because `listen` is a Tauri-only import.
  useEffect(() => {
    if (!taskCenterAvailable()) return;
    const ac = new AbortController();
    for (const event of ['task:status-changed', 'cron:execution-state-changed']) {
      void listenWithCleanup(event, () => {
        void reload();
      }, ac.signal);
    }
    void listenWithCleanup<{ taskId?: string }>('task:session-rebound', (event) => {
      void reload();
      if (event.payload?.taskId) {
        toastRef.current.success(t('tasks.sessionRecreated'));
      }
    }, ac.signal);
    return () => ac.abort();
  }, [reload, t]);

  // ── Per-task action handlers. Shared by card and list views via callbacks.
  // Each one toggles `pendingIds[id]` around the RPC so only that one card
  // disables its buttons while the request is in flight.
  const runAction = useCallback(
    async (taskId: string, label: string, fn: () => Promise<unknown>) => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      try {
        await fn();
        // SSE will trigger a reload and refresh the list in-place.
      } catch (e) {
        toastRef.current.error(t('tasks.actionFailed', { action: label, message: String(e) }));
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [t],
  );

  const handleRun = useCallback(
    (task: Task) =>
      runAction(task.id, t('tasks.actions.run'), async () => {
        const result = await taskRun(task.id);
        track('task_run', {
          source: 'desktop',
          run_count: result.attemptOrdinal,
        });
      }),
    [runAction, t],
  );
  const handleStop = useCallback(
    (task: Task) =>
      runAction(task.id, t('tasks.actions.stop'), async () => {
        track('task_stop', { source: 'desktop' });
        await taskUpdateStatus({ id: task.id, status: 'stopped', message: '用户手动中止' });
      }),
    [runAction, t],
  );
  const handleRerun = useCallback(
    (task: Task) =>
      runAction(task.id, t('tasks.actions.rerun'), async () => {
        const result = await taskRerun(task.id);
        track('task_run', {
          source: 'desktop',
          run_count: result.attemptOrdinal,
        });
      }),
    [runAction, t],
  );
  const handleDelete = useCallback(
    (task: Task) => {
      if (!window.confirm(t('tasks.deleteConfirm', { name: task.name }))) return;
      void runAction(task.id, t('tasks.actions.delete'), async () => {
        track('task_delete', { source: 'desktop', status: task.status });
        await taskDelete(task.id);
        // Optimistic removal — SSE will not fire a status-changed for delete.
        setTasks((prev) => prev.filter((x) => x.id !== task.id));
      });
    },
    [runAction, t],
  );

  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const nativeCards: TaskCardLike[] = tasks.map((t) => ({
      kind: 'task' as const,
      task: t,
    }));
    const legacyCards: TaskCardLike[] = legacy.map((l) => ({
      kind: 'legacy-cron' as const,
      legacy: l,
    }));
    const all = [...nativeCards, ...legacyCards];

    // Two-stage filter: workspace first (strict path equality), then
    // free-text query. Workspace defaults to '' = "全部". Path is the
    // authoritative key both Task and legacy CronTask carry.
    const afterWorkspace = workspaceFilter
      ? all.filter((c) =>
          c.kind === 'task'
            ? workspacePathsEqual(c.task.workspacePath, workspaceFilter)
            : workspacePathsEqual(c.legacy.workspacePath, workspaceFilter),
        )
      : all;

    const filtered = needle
      ? afterWorkspace.filter((c) => {
          if (c.kind === 'task') {
            const t = c.task;
            return (
              t.name.toLowerCase().includes(needle) ||
              t.description?.toLowerCase().includes(needle) ||
              t.tags.some((x) => x.toLowerCase().includes(needle))
            );
          }
          return c.legacy.name.toLowerCase().includes(needle);
        })
      : afterWorkspace;

    const out: Record<Bucket, TaskCardLike[]> = {
      active: [],
      pending: [],
      finished: [],
    };
    for (const c of filtered) {
      // Historical Cron rows are never live scheduler authorities. Keep them
      // in the finished bucket regardless of the status recorded in the old
      // file; the detail view still shows that original status verbatim.
      const status: TaskStatus =
        c.kind === 'task'
          ? c.task.status
          : 'archived';
      for (const [name, statuses] of Object.entries(BUCKET_STATUSES) as Array<
        [Bucket, typeof BUCKET_STATUSES[Bucket]]
      >) {
        if (statuses.includes(status)) {
          out[name].push(c);
          break;
        }
      }
    }
    // Sort each bucket by updatedAt desc.
    for (const bucket of Object.values(out)) {
      bucket.sort((a, b) => {
        const ta = a.kind === 'task' ? a.task.updatedAt : a.legacy.updatedAt;
        const tb = b.kind === 'task' ? b.task.updatedAt : b.legacy.updatedAt;
        return tb - ta;
      });
    }
    return out;
  }, [tasks, legacy, query, workspaceFilter]);

  const clearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.blur();
  }, []);

  // Options for the workspace filter — only show the workspaces that
  // actually appear in the user's task list, so the dropdown doesn't
  // list every project the app knows about (most of which may have
  // zero tasks). `'' → 全部` is the always-present first entry.
  const workspaceOptions: SelectOption[] = useMemo(() => {
    // Key membership by canonical identity, not raw string. A Task/CronTask
    // workspacePath is stored POSIX-style while a Project.path keeps the native
    // Windows form (backslashes) — comparing them with `Set.has(p.path)` made
    // every project drop out of the filter on Windows, leaving only "(已失效)"
    // orphan rows (#320).
    const taskPathIds = new Set<string>();
    for (const t of tasks) if (t.workspacePath) taskPathIds.add(normalizeWorkspacePathIdentity(t.workspacePath));
    for (const l of legacy) if (l.workspacePath) taskPathIds.add(normalizeWorkspacePathIdentity(l.workspacePath));
    const opts: SelectOption[] = [{ value: '', label: t('tasks.allWorkspaces') }];
    const coveredIds = new Set<string>();
    const knownProjectIds = new Set(projects.map((p) => normalizeWorkspacePathIdentity(p.path)));
    for (const p of projects) {
      if (!isProjectActiveForUser(p)) continue;
      const id = normalizeWorkspacePathIdentity(p.path);
      if (!taskPathIds.has(id)) continue;
      coveredIds.add(id);
      opts.push({
        value: p.path,
        label: p.displayName || p.name || p.path.split('/').pop() || p.path,
        icon: <WorkspaceIcon icon={p.icon} size={14} />,
      });
    }
    // Include any workspace present in tasks but NOT in `projects` (e.g. the
    // workspace was renamed / removed since the task was created) so users can
    // still filter to orphan tasks rather than being locked out. Dedupe by
    // identity and keep the original path form for the label/value.
    const seenOrphan = new Set<string>();
    const addOrphan = (path: string) => {
      const id = normalizeWorkspacePathIdentity(path);
      if (!shouldAddOrphanWorkspacePath(path, coveredIds, knownProjectIds, seenOrphan)) return;
      seenOrphan.add(id);
      opts.push({
        value: path,
        label: t('tasks.missingWorkspaceLabel', { name: path.split('/').pop() ?? path }),
      });
    };
    for (const t of tasks) if (t.workspacePath) addOrphan(t.workspacePath);
    for (const l of legacy) if (l.workspacePath) addOrphan(l.workspacePath);
    return opts;
  }, [tasks, legacy, projects, t]);

  // Guard against "zombie" filter state: if the user selected a
  // workspace, then every task in that workspace gets deleted, the
  // option vanishes from `workspaceOptions` but `workspaceFilter` would
  // still be set → the bucket memo filters everything out and the
  // panel goes blank with no visible control to clear it (the dropdown
  // itself hides when `workspaceOptions.length <= 2`). Reset the filter
  // back to "全部" whenever its current value is no longer selectable.
  useEffect(() => {
    if (
      workspaceFilter &&
      !workspaceOptions.some((o) => o.value === workspaceFilter)
    ) {
      setWorkspaceFilter('');
    }
  }, [workspaceFilter, workspaceOptions]);

  const totalCount = tasks.length + legacy.length;
  const searchActive = searchFocused || query.length > 0;

  const openTaskDetail = (t: Task) => {
    setSelectedTaskStartEditing(false);
    setSelectedTask(t);
  };
  const openTaskForEdit = (t: Task) => {
    setSelectedTaskStartEditing(true);
    setSelectedTask(t);
  };

  const renderCard = (c: TaskCardLike) => {
    if (c.kind === 'task') {
      const t = c.task;
      return (
        <TaskCardItem
          key={`t-${t.id}`}
          task={t}
          highlighted={highlightTaskId === t.id}
          busy={pendingIds.has(t.id)}
          onOpen={() => openTaskDetail(t)}
          onEdit={t.executionState ? undefined : () => openTaskForEdit(t)}
          onRun={() => handleRun(t)}
          onStop={() => handleStop(t)}
          onRerun={() => handleRerun(t)}
          onDelete={() => handleDelete(t)}
        />
      );
    }
    return (
      <TaskCardItem
        key={`l-${c.legacy.id}`}
        legacy={c.legacy}
        onOpen={() => setSelectedLegacy(c.legacy)}
      />
    );
  };

  const renderRow = (c: TaskCardLike) => {
    if (c.kind === 'task') {
      const t = c.task;
      return (
        <TaskListRow
          key={`t-${t.id}`}
          task={t}
          highlighted={highlightTaskId === t.id}
          busy={pendingIds.has(t.id)}
          onOpen={() => openTaskDetail(t)}
          onEdit={t.executionState ? undefined : () => openTaskForEdit(t)}
          onRun={() => handleRun(t)}
          onStop={() => handleStop(t)}
          onRerun={() => handleRerun(t)}
          onDelete={() => handleDelete(t)}
        />
      );
    }
    return (
      <TaskListRow
        key={`l-${c.legacy.id}`}
        legacy={c.legacy}
        onOpen={() => setSelectedLegacy(c.legacy)}
      />
    );
  };

  return (
    <div className="@container/task-panel flex h-full min-w-0 flex-col">
      {/* Section header — label + persistent search pill + view toggle.
          h-12 per DESIGN.md §7.4 (aligns with TaskCenter page header).
          v0.1.69 polish: bottom hairline removed; breathing room
          below replaces it as the separator, so the right column
          reads as a single continuous surface from header → buckets. */}
      <div className="flex h-12 items-center gap-2 px-4 @[720px]:gap-3">
        <div className={`${searchActive ? 'hidden @[720px]:flex' : 'flex'} shrink-0 items-center gap-2`}>
          {/* `relative top-[1px]` keeps optical centering consistent with
              ThoughtPanel's Lightbulb — see the comment there. */}
          <CheckSquare className="relative top-[1px] h-4 w-4 text-[var(--ink-muted)]" strokeWidth={1.5} />
          <span className="whitespace-nowrap text-base font-semibold text-[var(--ink)]">
            {t('tasks.title')}
          </span>
          {/* v0.1.69 — inline "+ 新建" entry point so users aren't forced
              to enter the Task Center flow via a thought first. Opens
              `DispatchTaskDialog` with no `thought` prop (dialog's
              "新建任务" branch, defaulting to once-mode). Visual matches
              the SearchPill's rounded-full pill + ghost treatment so
              both affordances read as one header row of toolbelt actions.
              Uses the same dark-pill tooltip pattern as ThoughtPanel's
              FolderOpen / ThoughtCard's AI讨论 / 派发 buttons — browser
              native `title=` was visually inconsistent with the rest of
              the task-center surface. */}
          <div className="group/newTask relative ml-1">
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              aria-label={t('tasks.newTask')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] @[720px]:w-auto @[720px]:gap-1 @[720px]:px-2.5"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only @[720px]:not-sr-only">{t('tasks.new')}</span>
            </button>
            <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--ink)] px-2 py-1 text-xs font-medium text-[var(--paper)] opacity-0 shadow-md transition-opacity duration-150 group-hover/newTask:opacity-100">
              {t('tasks.newTask')}
            </span>
          </div>
        </div>
        <div className={`${searchActive ? 'ml-0 flex-1 @[720px]:ml-auto @[720px]:flex-initial' : 'ml-auto'} flex min-w-0 items-center gap-1.5 @[720px]:gap-2`}>
          {/* Workspace filter — hidden when there's only one (or zero)
              workspaces producing tasks; the dropdown would be pointless
              in that case and would just eat header width. */}
          {workspaceOptions.length > 2 && (
            <CustomSelect
              className={`${searchActive ? 'hidden @[720px]:block' : 'block'} w-7 @[720px]:w-[160px] [&>button]:h-7 [&>button]:justify-center [&>button]:!rounded-full [&>button]:!border-transparent [&>button]:!bg-[var(--paper-inset)] [&>button]:!p-0 [&>button]:active:scale-[0.97] @[720px]:[&>button]:justify-start @[720px]:[&>button]:!rounded-lg @[720px]:[&>button]:!border-[var(--line)] @[720px]:[&>button]:!bg-[var(--paper)] @[720px]:[&>button]:!px-2 [&>button>span:nth-of-type(2)]:sr-only @[720px]:[&>button>span:nth-of-type(2)]:not-sr-only [&>button>svg]:hidden @[720px]:[&>button>svg]:block`}
              value={workspaceFilter}
              options={workspaceOptions}
              onChange={setWorkspaceFilter}
              compact
              placeholder={t('tasks.allWorkspaces')}
              triggerIcon={<Folder className="h-3.5 w-3.5" strokeWidth={1.5} />}
              popoverMinWidth={160}
            />
          )}
          <SearchPill
            inputRef={searchInputRef}
            value={query}
            onChange={setQuery}
            onClear={clearSearch}
            placeholder={t('tasks.searchPlaceholder')}
            collapseWhenNarrow
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          <div className={`${searchActive ? 'hidden @[720px]:block' : 'block'} shrink-0`}>
            <ViewToggle value={view} onChange={updateView} />
          </div>
        </div>
      </div>

      {/* Outer padding is now uniform across card / list views. Previously
          card used `px-4 py-3` on this wrapper while list used `px-3 pt-3`
          on each inner section header — a 4px horizontal delta that made
          the whole column visibly jump on view toggle. Both modes now
          share the same left/right gutter; the list row component
          (`TaskListRow`) keeps its own `px-3` for row-internal content. */}
      <div className="@container flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--ink-muted)]">
            {t('common.loading')}
          </div>
        ) : totalCount === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--ink-muted)]">
            {t('tasks.empty')}
          </div>
        ) : (
          // Order: 进行中 → 已完成 → 规划中. Current work and recent results
          // lead; long-tail scheduling sits at the bottom. (v0.1.69 polish)
          (['active', 'finished', 'pending'] as Bucket[]).map((b) => {
            const rows = buckets[b];
            if (rows.length === 0) return null;
            return view === 'card' ? (
              <section key={b} className="mb-6">
                <BucketHeader label={t(`tasks.groups.${b}`)} count={rows.length} />
                <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2 @[900px]:grid-cols-3">
                  {rows.map(renderCard)}
                </div>
              </section>
            ) : (
              <section key={b} className="mb-4">
                <BucketHeader label={t(`tasks.groups.${b}`)} count={rows.length} />
                <div>{rows.map(renderRow)}</div>
              </section>
            );
          })
        )}
      </div>

      {selectedTask && (
        <TaskDetailOverlay
          task={selectedTask}
          startEditing={selectedTaskStartEditing}
          onClose={() => {
            setSelectedTask(null);
            setSelectedTaskStartEditing(false);
          }}
          onChanged={(next) => {
            if (next === null) {
              setTasks((prev) =>
                prev.filter((x) => x.id !== selectedTask.id),
              );
              setSelectedTask(null);
              setSelectedTaskStartEditing(false);
            } else {
              setTasks((prev) =>
                prev.map((x) => (x.id === next.id ? next : x)),
              );
              setSelectedTask(next);
            }
          }}
        />
      )}

      {selectedLegacy && (
        <LegacyCronOverlay
          legacy={selectedLegacy.raw}
          onClose={() => setSelectedLegacy(null)}
        />
      )}

      {showCreateModal && (
        <DispatchTaskDialog
          currentSessionId={currentSessionId ?? null}
          onClose={() => setShowCreateModal(false)}
          onDispatched={(created) => {
            setShowCreateModal(false);
            track('task_create', {
              source: 'desktop',
              origin: 'manual',
              has_workspace: !!created.workspacePath,
            });
            toastRef.current.success(t('tasks.created', { name: created.name }));
            void reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Bucket header — 12px (text-xs) uppercase label + muted count + flex-1 hairline
 * rule, per the v0.1.69 visual mockup. Quiet enough to read as a
 * section divider rather than a page heading; the task cards below
 * carry the actual visual weight.
 */
function BucketHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
        {label}
      </span>
      <span className="text-xs tabular-nums text-[var(--ink-subtle)]">
        {count}
      </span>
      <span className="ml-1 h-px flex-1 bg-[var(--line-subtle)]" aria-hidden />
    </div>
  );
}

/**
 * The backend returns only historical rows without Task authority. Returns
 * `[]` when the Tauri environment is unavailable or the read fails.
 */
async function fetchLegacyCronTasks(unnamedLegacyTaskLabel: string): Promise<LegacyCronRow[]> {
  if (!taskCenterAvailable()) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const all = (await invoke<Record<string, unknown>[]>(
      'cmd_get_unmigrated_legacy_cron_tasks',
    )) as Array<Record<string, unknown>>;
    return all.map<LegacyCronRow>((t) => {
        const status = (t.status as string | undefined) === 'running' ? 'running' : 'stopped';
        const updatedAt =
          typeof t.updatedAt === 'string'
            ? Date.parse(t.updatedAt)
            : typeof t.createdAt === 'string'
              ? Date.parse(t.createdAt)
              : 0;
        return {
          id: String(t.id ?? ''),
          name: String(t.name ?? t.prompt ?? unnamedLegacyTaskLabel).slice(0, 80),
          status,
          raw: t,
          workspacePath: String(t.workspacePath ?? ''),
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        };
    });
  } catch (err) {
    console.warn('[TaskListPanel] fetchLegacyCronTasks failed', err);
    return [];
  }
}

export default TaskListPanel;
