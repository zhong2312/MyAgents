// TaskCardItem — richer card rendered in the 2-column card view.
//
// v0.1.69 visual rebuild (driven by the mock in
// prd_0.1.69_task_center_visual_feedback.md v2):
//
//   Row 1  — [Category chip left]                       [Status chip + hover actions right]
//   Row 2  — [Title, 14px medium, clamp-2]
//   Row 3  — [📁 workspace · mode-aware meta · time/rounds]
// Left vertical stripe was removed — the status chip on the right + the
// category chip on the left already carry the "state" and "kind" axes;
// a third indicator in the form of a color stripe would triple-count
// the same signal. Legacy-cron identity collapses into the category
// chip as "目标模式 · 遗留" / "周期 · 遗留" etc., so the grid no longer
// needs a separate "遗留" pill — see <TaskCategoryBadge legacy />.

import { useEffect, useState } from 'react';
import { Folder, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { taskGetRunStats } from '@/api/taskCenter';
import type { Task, TaskExecutionMode, TaskRunStats } from '@/../shared/types/task';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { humanizeCron, relativeTime } from '@/utils/taskCenterUtils';
import { TaskCategoryBadge } from '../TaskCategoryBadge';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskTriggerBadge } from '../TaskTriggerBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import type { LegacyCronRow } from './types';
import { isSupportedLocale, type SupportedLocale } from '@/../shared/i18n';

type TaskTranslator = (key: string, options?: Record<string, unknown>) => string;

export interface TaskCardItemProps {
  task?: Task;
  legacy?: LegacyCronRow;
  highlighted?: boolean;
  busy?: boolean;
  onOpen: () => void;
  /** Menu "编辑" action — opens the detail overlay in edit mode. */
  onEdit?: () => void;
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
}

export function TaskCardItem(props: TaskCardItemProps) {
  const { task, legacy, highlighted, busy, onOpen, onEdit, onRun, onStop, onRerun, onDelete } = props;
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null);
  const name = task?.name ?? legacy?.name ?? '—';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const category = task ? task.executionMode : inferLegacyCategory(legacy);

  // Loop + recurring tasks surface "第 N 轮" / "已执行 N 次" from Task
  // execution history. RunStats remains a per-card fetch to keep the panel
  // model small.
  // One Tauri round-trip per card; negligible for dashboards < 50 cards
  // and localises the read (no panel-level Map to keep in sync).
  const [runStats, setRunStats] = useState<TaskRunStats | null>(null);
  const shouldFetchStats =
    !!task && (task.executionMode === 'loop' || task.executionMode === 'recurring');
  useEffect(() => {
    if (!shouldFetchStats || !task?.id) return;
    let cancelled = false;
    void taskGetRunStats(task.id)
      .then((s) => {
        if (!cancelled) setRunStats(s);
      })
      .catch(() => {
        /* silent — "第 N 轮" just doesn't render, card still works */
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetchStats, task?.id]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative flex w-full flex-col gap-2.5 rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-4 text-left transition-shadow hover:shadow-sm ${
        highlighted ? 'ring-1 ring-[var(--accent-warm)] shadow-xs' : ''
      }`}
    >
      {/* Row 1 — chips on the left, "…" pinned to the far right via
          `ml-auto` on the menu wrapper. `ml-auto` beats `justify-between`
          for this layout because it keeps working when the chip cluster
          ever grows a third element or when the row gets wrapped in
          another flex context during a refactor. */}
      <div className="flex w-full items-center gap-1.5">
        <div className="flex items-center gap-1.5">
          {task?.trigger?.detector.type === 'command' && <TaskTriggerBadge />}
          <TaskStatusBadge status={status} executionState={task?.executionState} />
        </div>
        <TaskCategoryBadge mode={category} legacy={isLegacy} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ViewSessionButton task={task} />
          <TaskItemActions
            variant={isLegacy ? 'legacy' : 'task'}
            status={status}
            executionState={task?.executionState}
            canRerun={task?.dispatchOrigin !== 'attached-session'}
            busy={busy}
            onRun={onRun}
            onStop={onStop}
            onRerun={onRerun}
            onOpenDetail={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>

      {/* Row 2 — title. 14px / weight 500 per the reference mock — the
          earlier text-base/semibold read too heavy next to the card's
          tiny meta row. Slight negative letter-spacing tightens the
          CJK rhythm so the title doesn't feel "plumped" at weight 500. */}
      <div
        className="line-clamp-2 text-sm font-medium leading-snug text-[var(--ink)]"
        style={{ letterSpacing: '-0.005em' }}
      >
        {name}
      </div>

      {/* Row 3 — meta: folder + workspace + · + mode-aware schedule/round + · + time */}
      <MetaRow
        task={task}
        legacy={legacy}
        category={category}
        executionCount={runStats?.executionCount ?? 0}
        updatedAt={updatedAt}
        locale={locale}
        t={t}
      />
    </button>
  );
}

/**
 * Meta row — one `·`-separated line describing *how this task runs*.
 * Content varies per category:
 *
 *   once       workspace · 一次性 · <updatedAt-relative>
 *   loop       workspace · 目标模式 · 第 N 轮
 *   scheduled  workspace · <formatted dispatch time>
 *   recurring  workspace · <interval or cron> [· 已执行 N 次]
 *
 * Legacy cron rows fall into whichever category their schedule kind maps
 * to; we don't have full schedule-detail access here, so we degrade to a
 * plain relative-time tail.
 */
function MetaRow({
  task,
  legacy,
  category,
  executionCount,
  updatedAt,
  locale,
  t,
}: {
  task?: Task;
  legacy?: LegacyCronRow;
  category: TaskExecutionMode;
  executionCount: number;
  updatedAt: number;
  locale: SupportedLocale;
  t: TaskTranslator;
}) {
  const workspace = workspaceName(task, legacy);
  const parts: string[] = [];
  // User-executor tasks render as "自己做" since they're the user's own
  // todo items rather than AI-dispatched work. Agent is the default and
  // stays implicit.
  if (task?.executor === 'user') parts.push(t('tasks.userExecutor'));

  switch (category) {
    case 'once':
      parts.push(t('badges.category.once'));
      if (updatedAt) parts.push(relativeTime(updatedAt, locale));
      break;
    case 'loop':
      parts.push(t('badges.category.loop'));
      if (executionCount > 0) parts.push(t('tasks.round', { count: executionCount }));
      else if (updatedAt) parts.push(relativeTime(updatedAt, locale));
      break;
    case 'scheduled': {
      const when = task?.dispatchAt ?? task?.endConditions?.deadline;
      if (when) parts.push(formatAbsolute(when, locale, t));
      else if (updatedAt) parts.push(relativeTime(updatedAt, locale));
      break;
    }
    case 'recurring': {
      const sched = formatRecurring(task, locale, t);
      if (sched) parts.push(sched);
      if (executionCount > 0) parts.push(t('tasks.executedCount', { count: executionCount }));
      break;
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
      <Folder className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{workspace}</span>
      {parts.map((p, i) => (
        <span key={i} className="contents">
          <MetaSep />
          <span className={i === parts.length - 1 ? 'truncate' : undefined}>{p}</span>
        </span>
      ))}
    </div>
  );
}

function MetaSep() {
  return (
    <span className="text-[var(--ink-muted)]/50" aria-hidden>
      ·
    </span>
  );
}

/** Best guess at the "kind" of a legacy cron from its schedule shape. */
function inferLegacyCategory(legacy?: LegacyCronRow): TaskExecutionMode {
  if (!legacy) return 'once';
  const sched = (legacy.raw as { schedule?: { kind?: string } }).schedule;
  const kind = sched?.kind;
  if (kind === 'loop') return 'loop';
  if (kind === 'at') return 'scheduled';
  // "every" / "cron" / undefined → recurring is the safe default for
  // legacy rows that don't have a resolvable schedule shape.
  return 'recurring';
}

function workspaceName(task?: Task, legacy?: LegacyCronRow): string {
  const raw = task?.workspacePath ?? legacy?.workspacePath ?? '';
  if (!raw) return '—';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function formatAbsolute(ts: number, locale: SupportedLocale, t: TaskTranslator): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale === 'en-US',
  }).format(d);
  if (sameDay) return t('tasks.todayAt', { time });
  // Tomorrow check — diff of 1 day, sensitive to DST transitions is fine
  // for a display string.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return t('tasks.tomorrowAt', { time });
  }
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(d);
  return t('tasks.dateAt', { date, time });
}

// Translate a recurring task's schedule into a one-line Chinese readout
// for the card's meta row. Previously we punted on cron by showing the
// raw `0 11 * * *` expression — users shouldn't have to know cron syntax
// to read their own task list. This formatter covers the five shapes
// the chip picker emits (daily / weekdays / specific weekdays / weekly /
// monthly) plus interval mode; anything else (custom cron the user typed)
// falls back to the raw string so we stay honest rather than mis-translate.
/**
 * Hover-only chip that opens the task's most-recent SDK session in a new
 * Chat tab. Renders nothing when the task has no recorded sessions yet
 * (PRD 0.2.4 §需求 5: 「无数据不渲染」). The "most recent" is the last
 * id appended to `task.sessionIds` — `task.rs::append_session` appends
 * in execution order so the tail is authoritative.
 *
 * Visual vocabulary mirrors the thought-card hover actions ("AI 讨论"
 * etc.): icon + label chip with a dark-pill tooltip on hover. Shared by
 * both TaskCardItem and TaskListRow so the affordance is placed
 * identically (immediately left of the ⋯ overflow trigger).
 */
export function ViewSessionButton({ task }: { task?: Task }) {
  const { t } = useTranslation('task');
  if (!task || task.sessionIds.length === 0) return null;
  const sessionId = task.sessionIds[task.sessionIds.length - 1];
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!task.workspacePath) return;
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: { sessionId, workspacePath: task.workspacePath, historyEntrySource: 'task_run_history' },
      }),
    );
  };
  return (
    <div className="group/view-session relative opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t('tasks.viewSessionTooltip')}
        className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)]"
      >
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
        {t('tasks.viewSession')}
      </button>
      <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-lg transition-opacity group-hover/view-session:opacity-100">
        {t('tasks.viewSessionTooltip')}
      </span>
    </div>
  );
}

function formatRecurring(task: Task | undefined, locale: SupportedLocale, t: TaskTranslator): string | null {
  if (!task) return null;
  if (task.cronExpression) {
    return humanizeCron(task.cronExpression, locale) ?? task.cronExpression;
  }
  if (task.intervalMinutes) {
    const m = task.intervalMinutes;
    if (m >= 1440 && m % 1440 === 0) {
      const count = m / 1440;
      return t(count === 1 ? 'tasks.intervalDay' : 'tasks.intervalDays', { count });
    }
    if (m >= 60 && m % 60 === 0) {
      const count = m / 60;
      return t(count === 1 ? 'tasks.intervalHour' : 'tasks.intervalHours', { count });
    }
    return t(m === 1 ? 'tasks.intervalMinute' : 'tasks.intervalMinutes', { count: m });
  }
  return null;
}
