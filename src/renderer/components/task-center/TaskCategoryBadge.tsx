// TaskCategoryBadge — top-left chip on a task card signalling *how* the
// task runs (its execution mode). Designed to be the first thing the user
// scans: "this is Goal Mode" vs "this is a one-shot" vs "this is
// scheduled" vs "this is recurring" is the question the card needs to
// answer in one glance.
//
// Four categories, four icons, four color families — all reuse existing
// DESIGN.md tokens (no new colors introduced):
//
//   loop       → Flag    + --heartbeat   ("目标模式")
//   once       → Play    + --accent-warm ("一次性")
//   scheduled  → Clock   + --success     ("定时")
//   recurring  → Repeat  + --info        ("周期")
//
// Pair with <TaskStatusBadge> on the top-right: category answers "what
// kind", status answers "where in its lifecycle". The two chips never
// conflict because they carry orthogonal information.
//
// Historical Cron rows reuse their inferred execution category with a
// parenthetical "legacy" marker.

import { Clock, Flag, Play, Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskExecutionMode } from '@/../shared/types/task';

type Category = TaskExecutionMode;

interface CategoryStyle {
  icon: typeof Clock;
  bg: string;
  fg: string;
}

const CATEGORY_STYLE: Record<Category, CategoryStyle> = {
  loop: {
    icon: Flag,
    bg: 'bg-[var(--heartbeat-bg)]',
    fg: 'text-[var(--heartbeat)]',
  },
  once: {
    icon: Play,
    bg: 'bg-[var(--accent-warm-subtle)]',
    fg: 'text-[var(--accent-warm)]',
  },
  scheduled: {
    icon: Clock,
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
  },
  recurring: {
    icon: Repeat,
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
  },
};

interface Props {
  mode: TaskExecutionMode;
  /** Adds a "legacy" tail for historical Cron rows that could not migrate. */
  legacy?: boolean;
  compact?: boolean;
}

export function TaskCategoryBadge({ mode, legacy, compact }: Props) {
  const { t } = useTranslation('task');
  const style = CATEGORY_STYLE[mode];
  const Icon = style.icon;
  const size = 'text-xs'; // compact 与常规已同档（Part 1 合并 10→11→12 的遗留三元塌缩）
  // Height / padding mirror TaskStatusBadge so the two chips sit
  // perfectly aligned in the card's header row (see status-badge.tsx
  // for the rationale on leading-none + fixed h-5).
  const height = compact ? 'h-[18px]' : 'h-5';
  const padding = compact ? 'px-1.5' : 'px-2';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] font-medium leading-none ${style.bg} ${style.fg} ${padding} ${height} ${size}`}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={1.75} />
      {legacy && mode === 'loop'
        ? t('badges.category.legacyLoop')
        : t(`badges.category.${mode}`)}
      {legacy && (
        <span className="text-[var(--ink-muted)]/80" aria-label={t('badges.category.legacyTask')}>
          · {t('badges.category.legacy')}
        </span>
      )}
    </span>
  );
}

export default TaskCategoryBadge;
