// ExecutionModeEditor — shared UI for picking how a task runs:
//   • mode: once / scheduled / recurring
//   • scheduled → datetime-local (→ task.dispatchAt)
//   • recurring → CronExpressionInput with 5-chip picker:
//       固定周期 (intervalMinutes) | 每天 | 工作日 | 每周 | 每月
//     plus an escape hatch to raw cron expression inside the child.
//   • recurring/loop → session strategy (new-session / single-session,
//     forced single-session for loop)
//
// Used by both the dispatch dialog (create flow) and the task detail overlay
// edit mode, so the two surfaces stay aligned on scheduling semantics.
//
// v0.1.69 refactor: the prior outer "简单 / 高级" toggle was removed — the
// "简单 = every N minutes" path is now the 固定周期 chip inside the same
// CronExpressionInput the "高级" path always used. One component, one chip
// row, one mental model.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Clock, Play, Timer } from 'lucide-react';

import type { TaskExecutionMode, TaskRunMode } from '@/../shared/types/task';
import CronExpressionInput from '@/components/scheduled-tasks/CronExpressionInput';
import { INPUT_CLS, PillButton, toLocalDateTimeString } from './controls';

export interface ExecutionModeState {
  executionMode: TaskExecutionMode;
  runMode: TaskRunMode;
  atDateTime: string;
  intervalMinutes: number;
  /** Empty string → simple (interval) mode; non-empty → cron expression. */
  cronExpression: string;
  cronTimezone: string;
}

export interface ExecutionModeEditorProps extends ExecutionModeState {
  setExecutionMode: (m: TaskExecutionMode) => void;
  setRunMode: (m: TaskRunMode) => void;
  setAtDateTime: (s: string) => void;
  setIntervalMinutes: (n: number) => void;
  setCronExpression: (s: string) => void;
  setCronTimezone: (s: string) => void;
  disabled?: boolean;
}

const EXECUTION_TABS: Array<{
  value: TaskExecutionMode;
  labelKey: string;
  icon: typeof Clock;
  descriptionKey: string;
}> = [
  {
    value: 'once',
    labelKey: 'execution.modes.once.label',
    icon: Play,
    descriptionKey: 'execution.modes.once.description',
  },
  {
    value: 'scheduled',
    labelKey: 'execution.modes.scheduled.label',
    icon: Calendar,
    descriptionKey: 'execution.modes.scheduled.description',
  },
  {
    value: 'recurring',
    labelKey: 'execution.modes.recurring.label',
    icon: Timer,
    descriptionKey: 'execution.modes.recurring.description',
  },
];

export function ExecutionModeEditor({
  executionMode,
  runMode,
  atDateTime,
  intervalMinutes,
  cronExpression,
  cronTimezone,
  setExecutionMode,
  setRunMode,
  setAtDateTime,
  setIntervalMinutes,
  setCronExpression,
  setCronTimezone,
  disabled,
}: ExecutionModeEditorProps) {
  const { t } = useTranslation('task');
  const isScheduled = executionMode === 'scheduled';
  const isRecurring = executionMode === 'recurring';
  const isLoop = executionMode === 'loop';
  const showSessionStrategy = true;

  // Seed the timezone on first render if the recurring task doesn't
  // have one yet — `CronExpressionInput` picks its displayed tz from
  // the `tz` prop, so a pristine task with empty tz would land on a
  // blank entry. This is a one-time nudge; subsequent user changes
  // flow through `handleCronChange`.
  useEffect(() => {
    if (isRecurring && !cronTimezone) {
      setCronTimezone(
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecurring]);

  const handleCronChange = useCallback(
    (expr: string, tz: string) => {
      setCronExpression(expr);
      setCronTimezone(tz);
    },
    [setCronExpression, setCronTimezone],
  );

  const currentDescription = useMemo(
    () => {
      const tab = EXECUTION_TABS.find((item) => item.value === executionMode);
      return tab ? t(tab.descriptionKey) : '';
    },
    [executionMode, t],
  );

  // Pinned "now + 60s" — lazy-init so the `<input type=datetime-local>`
  // `min` attribute is stable across renders without calling the impure
  // `Date.now()` directly inside render. A stale floor by a few minutes is
  // fine (real validation runs on submit).
  const [minAtDateTime] = useState(() =>
    toLocalDateTimeString(new Date(Date.now() + 60_000)),
  );

  return (
    <div>
      <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
        {EXECUTION_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = executionMode === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              disabled={disabled}
              onClick={() => setExecutionMode(tab.value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>
      <p className="mt-2.5 text-sm text-[var(--ink-muted)]">{currentDescription}</p>

      {isScheduled && (
        <div className="mt-5">
          <label className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
            {t('execution.scheduledTime')}
          </label>
          <input
            type="datetime-local"
            value={atDateTime}
            onChange={(e) => setAtDateTime(e.target.value)}
            min={minAtDateTime}
            disabled={disabled}
            className={INPUT_CLS}
          />
        </div>
      )}

      {isRecurring && (
        <div className="mt-5">
          {/* v0.1.69: the prior "简单 / 高级" outer toggle and its
              title row were collapsed — every recurring schedule is
              now picked through the same chip row inside
              CronExpressionInput. 「固定周期」 chip (5th) takes over
              what used to be "simple mode" (every N minutes);
              daily/weekdays/weekly/monthly remain as-is. The escape
              hatch to raw cron stays available via the child's
              internal "使用 Cron 表达式" button. */}
          <CronExpressionInput
            expr={cronExpression}
            tz={cronTimezone}
            onChange={handleCronChange}
            intervalMinutes={intervalMinutes}
            onIntervalChange={setIntervalMinutes}
          />
        </div>
      )}

      {showSessionStrategy && (
        <div className="mt-5">
          <label className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
            {t('execution.sessionStrategy')}
          </label>
          {isLoop ? (
            <p className="text-sm text-[var(--ink-muted)]">
              {t('execution.loopSessionStrategy')}
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <PillButton
                  selected={runMode === 'new-session'}
                  onClick={() => setRunMode('new-session')}
                  disabled={disabled}
                >
                  {t('execution.newSession')}
                </PillButton>
                <PillButton
                  selected={runMode === 'single-session'}
                  onClick={() => setRunMode('single-session')}
                  disabled={disabled}
                >
                  {t('execution.singleSession')}
                </PillButton>
              </div>
              <p className="mt-2 text-sm text-[var(--ink-muted)]">
                {runMode === 'new-session'
                  ? t('execution.newSessionDescription')
                  : t('execution.singleSessionDescription')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
