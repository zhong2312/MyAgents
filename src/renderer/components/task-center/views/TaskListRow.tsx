// TaskListRow — dense single-line row used by the list view for fast scan +
// filter. No card chrome (no rounded corners, no shadow, no per-row border
// box) so the list reads as a table.
//
// Layout (left → right): status chip · category chip · name (flex-1) ·
// workspace · updated-at · overflow menu. Chip order mirrors the card view
// exactly so switching between the two layouts doesn't rearrange the
// visual vocabulary.

import type { Task, TaskExecutionMode } from '@/../shared/types/task';
import { useTranslation } from 'react-i18next';
import { relativeTime } from '@/utils/taskCenterUtils';
import { TaskCategoryBadge } from '../TaskCategoryBadge';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskTriggerBadge } from '../TaskTriggerBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import { ViewSessionButton } from './TaskCardItem';
import type { LegacyCronRow } from './types';
import { isSupportedLocale } from '@/../shared/i18n';

export interface TaskListRowProps {
  task?: Task;
  legacy?: LegacyCronRow;
  highlighted?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onEdit?: () => void;
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
}

export function TaskListRow(props: TaskListRowProps) {
  const { task, legacy, highlighted, busy, onOpen, onEdit, onRun, onStop, onRerun, onDelete } = props;
  const { i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null);
  const name = task?.name ?? legacy?.name ?? '—';
  const workspacePath = task?.workspacePath ?? legacy?.workspacePath;
  const workspace = workspacePath
    ? shortenPath(workspacePath)
    : '';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const category: TaskExecutionMode = task
    ? task.executionMode
    : inferLegacyCategory(legacy);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)] ${
        highlighted ? 'bg-[var(--accent-warm-subtle)]' : ''
      }`}
    >
      {/* Chip row — status first, category second. Wrapped in a
          fixed-width flex cluster so rows visually align: the name
          always starts at the same x-offset regardless of which chips
          are present. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex items-center gap-1">
          {task?.trigger?.detector.type === 'command' && <TaskTriggerBadge compact />}
          <TaskStatusBadge status={status} executionState={task?.executionState} compact />
        </div>
        <TaskCategoryBadge mode={category} legacy={isLegacy} compact />
      </div>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">
        {name}
      </span>
      {workspace && (
        <span className="hidden max-w-[110px] shrink-0 truncate text-xs text-[var(--ink-muted)] sm:block">
          {workspace}
        </span>
      )}
      <span className="w-[80px] shrink-0 text-right text-xs text-[var(--ink-muted)]/80">
        {relativeTime(updatedAt, locale)}
      </span>
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
    </button>
  );
}

/** Best guess at the "kind" of a legacy cron from its schedule shape —
 *  same logic as TaskCardItem; kept local so the two files stay
 *  independent of each other's internals. */
function inferLegacyCategory(legacy?: LegacyCronRow): TaskExecutionMode {
  if (!legacy) return 'once';
  const sched = (legacy.raw as { schedule?: { kind?: string } }).schedule;
  const kind = sched?.kind;
  if (kind === 'loop') return 'loop';
  if (kind === 'at') return 'scheduled';
  return 'recurring';
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
