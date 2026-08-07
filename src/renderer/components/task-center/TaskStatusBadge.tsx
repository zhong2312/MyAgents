// TaskStatusBadge — status chip for the top-right of a task card.
//
// Rewired to match the v0.1.69 mockup:
//   - running          → success (green)   — 进行中 (green + leading dot
//                                            = "actively in the pipeline".
//                                            The dot is what separates it
//                                            from `done` below, which
//                                            reuses the same green palette
//                                            but without a dot)
//   - verifying        → accent-warm       — 验收中 (orange, matches the
//                                            mockup's "verifying" chip —
//                                            not info, because verifying
//                                            is AI self-checking, which
//                                            is conceptually closer to a
//                                            warm "attention" state than
//                                            the cool "working" state)
//   - done             → success (green, no dot) — 已完成
//   - blocked          → warning (yellow)  — 已阻塞 (NOT error-red; the
//                                            mockup uses warning for
//                                            blocked because it's
//                                            "stuck, needs you" not "failed")
//   - stopped/archived → muted default
//   - todo             → muted default     — no latent-styling trick;
//                                            the left category chip
//                                            already carries the mode
//                                            distinction so todo cards
//                                            don't need an extra visual
//                                            downgrade
//
// Category (loop/once/scheduled/recurring) lives in <TaskCategoryBadge>
// on the top-left. Status (this component) and category are now two
// independent visual dimensions: left = "what kind of task", right =
// "where is it in its lifecycle".

import type { TaskExecutionState, TaskStatus } from '@/../shared/types/task';
import { useTranslation } from 'react-i18next';

interface StatusStyle {
  bg: string;
  fg: string;
  /** Optional leading dot — used on "active" states to nudge scanning. */
  dot?: string;
}

const STATUS_STYLE: Record<TaskStatus, StatusStyle> = {
  todo: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-muted)]' },
  running: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
    dot: 'bg-[var(--success)]',
  },
  verifying: {
    bg: 'bg-[var(--accent-warm-subtle)]',
    fg: 'text-[var(--accent-warm)]',
    dot: 'bg-[var(--accent-warm)]',
  },
  done: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
  },
  blocked: {
    bg: 'bg-[var(--warning-bg)]',
    fg: 'text-[var(--warning)]',
  },
  stopped: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  archived: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  // Pseudo-state (soft-deleted) — only surfaces in audit views.
  deleted: { bg: 'bg-[var(--error-bg)]', fg: 'text-[var(--error)]' },
};

interface Props {
  status: TaskStatus;
  executionState?: TaskExecutionState;
  compact?: boolean;
}

const EXECUTION_STYLE: Record<TaskExecutionState, StatusStyle> = {
  checking: {
    bg: 'bg-[var(--accent-soft)]',
    fg: 'text-[var(--accent)]',
    dot: 'bg-[var(--accent)]',
  },
  running: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
    dot: 'bg-[var(--success)]',
  },
  stopping: {
    bg: 'bg-[var(--warning-bg)]',
    fg: 'text-[var(--warning)]',
    dot: 'bg-[var(--warning)]',
  },
  stop_failed: {
    bg: 'bg-[var(--error-bg)]',
    fg: 'text-[var(--error)]',
  },
};

export function TaskStatusBadge({ status, executionState, compact }: Props) {
  const { t } = useTranslation('task');
  const style = executionState ? EXECUTION_STYLE[executionState] : STATUS_STYLE[status];
  const label = executionState
    ? t(`badges.execution.${executionState}`)
    : t(`badges.status.${status}`);
  const size = 'text-xs'; // compact 与常规已同档（Part 1 合并 10→11→12 的遗留三元塌缩）
  // Fixed height + leading-none so TaskStatusBadge and TaskCategoryBadge
  // render at identical pixel sizes side-by-side. TaskCategoryBadge
  // carries an h-3 icon which stretches its intrinsic line height; we
  // clamp both here so the row stays tidy.
  const height = compact ? 'h-[18px]' : 'h-5';
  const padding = compact ? 'px-1.5' : 'px-2';
  return (
    <span
      // `whitespace-nowrap` + `shrink-0` keep 2-character labels like
      // 「待启动」/「进行中」 on one line even when the parent row is a
      // tight flex layout (TaskDetailOverlay header with a long task
      // name). Without them CJK wraps as 待启\n动 when the row budget
      // is tight.
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] font-medium leading-none ${style.bg} ${style.fg} ${padding} ${height} ${size}`}
    >
      {style.dot && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

export default TaskStatusBadge;
