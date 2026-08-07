// SummaryCard — the preview-overlay "task at a glance" block.
//
// Replaces the previous two sections (`<Meta>` + `<RunStatsSection>`)
// with a single card whose information architecture matches the edit
// panel: schedule + workspace/agent + run stats + tags + end
// conditions, in priority order, with low-value fields hidden behind
// a "展开更多详情" fold.
//
// Why here (not inline in TaskDetailOverlay): the layout is long
// enough to warrant its own file, and the schedule readout needs its
// own local state (async cronstrue load) that's cleanest kept local.

import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  Heart,
  Play,
  Timer,
} from 'lucide-react';

import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { useConfig } from '@/hooks/useConfig';
import {
  summarizeSchedule,
  type ScheduleSummary,
} from '@/utils/scheduleSummary';
import { relativeTime } from '@/utils/taskCenterUtils';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import type { Task, TaskExecutionMode, TaskRunStats } from '@/../shared/types/task';
import { isSupportedLocale } from '@/../shared/i18n';

interface Props {
  task: Task;
  stats: TaskRunStats | null;
}

type IconComp = ComponentType<{ className?: string }>;
const MODE_META: Record<TaskExecutionMode, { icon: IconComp; labelKey: string }> = {
  once: { icon: Play, labelKey: 'badges.category.once' },
  scheduled: { icon: Calendar, labelKey: 'badges.category.scheduled' },
  recurring: { icon: Timer, labelKey: 'badges.category.recurring' },
  loop: { icon: Heart, labelKey: 'badges.category.loop' },
};

export function SummaryCard({ task, stats }: Props) {
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const { projects } = useConfig();
  const { statuses } = useAgentStatuses();
  const workspace = useMemo(
    () => projects.find((p) => workspacePathsEqual(p.path, task.workspacePath)) ?? null,
    [projects, task.workspacePath],
  );
  // Agent names are keyed by the Rust `agent.id` UUID on workspaces;
  // resolve to a human-readable name so the preview doesn't show a raw
  // `2c381cc2-…` string. Falls back to the id if the agent was deleted.
  const agentLabel = useMemo(() => {
    const id = workspace?.agentId;
    if (!id) return null;
    return statuses[id]?.agentName ?? id;
  }, [workspace?.agentId, statuses]);

  const [schedule, setSchedule] = useState<ScheduleSummary | null>(null);
  // Prefer the Rust-computed next fire (from `stats.nextExecutionAt`) so
  // the overlay and the scheduler agree on what "下次触发" means — avoids
  // cron-parser / tz drift between the two layers.
  const nextExecutionAt = stats?.nextExecutionAt;
  useEffect(() => {
    let cancelled = false;
    void summarizeSchedule(task, nextExecutionAt, locale).then((s) => {
      if (!cancelled) setSchedule(s);
    });
    return () => {
      cancelled = true;
    };
  }, [task, nextExecutionAt, locale]);

  const modeMeta = MODE_META[task.executionMode];
  const ScheduleIcon = modeMeta.icon;

  const showEndConditions =
    (task.executionMode === 'recurring' || task.executionMode === 'loop') &&
    !!(
      task.endConditions?.deadline ||
      task.endConditions?.maxExecutions ||
      task.endConditions?.aiCanExit === false
    );

  // Compact "最近" line combines last-run time + success/failure +
  // duration into one dd, so a task with all three doesn't eat three
  // separate rows.
  const lastRunCell: ReactNode | null = (() => {
    if (!task.lastExecutedAt) return null;
    return (
      <span className="flex flex-wrap items-center gap-x-2">
        <span>{relativeTime(task.lastExecutedAt, locale)}</span>
        {stats?.lastSuccess === true && (
          <span className="text-[var(--success)]">{t('summary.succeeded')}</span>
        )}
        {stats?.lastSuccess === false && (
          <span className="text-[var(--error)]">{t('summary.failed')}</span>
        )}
        {stats?.lastDurationMs != null && (
          <span className="text-[var(--ink-muted)]">
            {t('summary.duration')}
            {(stats.lastDurationMs / 1000).toFixed(1)}s
          </span>
        )}
      </span>
    );
  })();

  const endConditionCell: ReactNode | null = showEndConditions
    ? (() => {
        const bits: string[] = [];
        if (task.endConditions?.deadline) {
          bits.push(
            t('summary.deadline', {
              time: new Date(task.endConditions.deadline).toLocaleString(locale),
            }),
          );
        }
        if (task.endConditions?.maxExecutions) {
          bits.push(t('summary.maxExecutions', { count: task.endConditions.maxExecutions }));
        }
        if (task.endConditions?.aiCanExit === false) {
          bits.push(t('summary.aiCannotExit'));
        }
        return bits.join(' · ');
      })()
    : null;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const toggleDetails = useCallback(() => setDetailsOpen((v) => !v), []);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] px-4 py-3.5">
      {/* Headline — the single most important line, visually distinct
          from the key/value table below so the user scans schedule
          first, details second. */}
      <div className="flex items-start gap-2.5">
        <ScheduleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug text-[var(--ink)]">
            {schedule?.title ?? `${t(modeMeta.labelKey)} · ${t('summary.computing')}`}
          </div>
          {schedule?.next && (
            <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
              {schedule.next}
              {schedule.timezone && (
                <span className="ml-1 text-[var(--ink-muted)]/70">
                  · {schedule.timezone}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Key/value grid — the heart of the summary. Every row follows
          the same dt/dd rhythm: label in ink-muted, value in ink. The
          grid's `grid-cols-[auto_1fr]` keeps every label column the
          same width (aligned gutter), no prose-style mish-mash.
          Entries are rendered only when meaningful — new tasks don't
          show empty 「最近执行 —」 stubs.
          Removed rows (v0.1.69 polish): 「工作区」(redundant with
          Agent), 「调度器」(internal CronTask state, not a user fact). */}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t border-[var(--line-subtle)] pt-3 text-xs">
        {agentLabel && <MetaRow k="Agent" v={agentLabel} />}
        {(stats?.executionCount ?? 0) > 0 && (
          <MetaRow
            k={t('summary.executionCount')}
            v={t('summary.executionCountValue', { count: stats!.executionCount })}
          />
        )}
        {lastRunCell && <MetaRow k={t('summary.lastRun')} v={lastRunCell} />}
        {endConditionCell && <MetaRow k={t('summary.endConditions')} v={endConditionCell} />}
        {task.tags.length > 0 && (
          <MetaRow
            k={t('summary.tags')}
            v={
              <span className="flex flex-wrap gap-1">
                {task.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]"
                  >
                    #{t}
                  </span>
                ))}
              </span>
            }
          />
        )}
      </dl>

      {/* "展开更多详情" toggle — low-frequency fields behind a fold.
          Font size + spacing mirror the table above (12px, gap-y-1.5)
          so the fold reads as a natural continuation of the same row
          rhythm, not a visually demoted appendix. */}
      <button
        type="button"
        onClick={toggleDetails}
        className="mt-2.5 flex items-center gap-1 text-xs text-[var(--ink-muted)]/70 transition-colors hover:text-[var(--ink-muted)]"
      >
        {detailsOpen ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {detailsOpen ? t('summary.collapseDetails') : t('summary.expandDetails')}
      </button>

      {detailsOpen && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t border-[var(--line-subtle)] pt-2 text-xs">
          <MetaRow k={t('summary.createdAt')} v={new Date(task.createdAt).toLocaleString(locale)} />
          <MetaRow k={t('summary.updatedAt')} v={new Date(task.updatedAt).toLocaleString(locale)} />
          <MetaRow
            k={t('summary.workspace')}
            v={workspace?.displayName ?? workspace?.name ?? t('summary.unknownWorkspace')}
          />
          {workspace?.path && <MetaRow k={t('summary.workspacePath')} v={workspace.path} mono />}
          {task.runMode && (
            <MetaRow
              k={t('summary.runMode')}
              v={task.runMode === 'single-session' ? t('summary.runModeSingle') : t('summary.runModeNew')}
            />
          )}
          {task.runMode === 'single-session' && task.preselectedSessionId && (
            <MetaRow k={t('trigger.targetSession')} v={task.preselectedSessionId} mono />
          )}
          {task.model && <MetaRow k={t('summary.modelOverride')} v={task.model} mono />}
          {task.permissionMode && task.permissionMode !== 'auto' && (
            <MetaRow k={t('summary.permissionOverride')} v={task.permissionMode} mono />
          )}
          {task.runtime && task.runtime !== 'builtin' && (
            <MetaRow k="Runtime" v={task.runtime} mono />
          )}
          {stats?.schedulerStatus && (
            <MetaRow k={t('summary.scheduler')} v={stats.schedulerStatus} mono />
          )}
          {stats?.sessionCount != null && stats.sessionCount > 0 && (
            <MetaRow k={t('summary.sessionCount')} v={String(stats.sessionCount)} />
          )}
          {workspace?.agentId && (
            <MetaRow k="Agent ID" v={workspace.agentId} mono />
          )}
        </dl>
      )}
    </div>
  );
}

function MetaRow({
  k,
  v,
  mono,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="whitespace-nowrap text-[var(--ink-muted)]/70">{k}</dt>
      <dd
        className={`min-w-0 text-[var(--ink)] ${
          mono ? 'font-mono' : ''
        } ${typeof v === 'string' ? 'truncate' : ''}`}
      >
        {v}
      </dd>
    </>
  );
}

export default SummaryCard;
