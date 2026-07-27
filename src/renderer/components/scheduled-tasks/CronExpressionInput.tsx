/**
 * CronExpressionInput — Visual schedule builder with advanced cron expression fallback.
 * Primary: frequency picker (每天/每周/每月) + time/day selectors
 * Advanced: raw cron expression input for power users
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Code2 } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import { isSupportedLocale } from '@/../shared/i18n';

interface CronExpressionInputProps {
  expr: string;
  tz: string;
  onChange: (expr: string, tz: string) => void;
  /**
   * When provided (together with `onIntervalChange`), renders an
   * additional "固定周期" chip alongside daily/weekdays/weekly/monthly.
   * Selecting it swaps the time/day pickers for a single "每 N 分钟"
   * numeric input and clears the cron expression via `onChange('', tz)`
   * so the backend's `schedule_from_task` falls back to its Every branch.
   *
   * This collapses Task Center's prior outer "简单 / 高级" toggle into
   * one unified chip row — every recurring schedule is now picked the
   * same way. Scheduled-task callers (Chat tab) don't pass this prop,
   * so the old 4-chip behaviour is preserved there.
   */
  intervalMinutes?: number;
  onIntervalChange?: (n: number) => void;
}

type Frequency = 'interval' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 10080; // 7 days in minutes
const DEFAULT_INTERVAL = 30;

const WEEKDAY_CRON = [1, 2, 3, 4, 5, 6, 0]; // cron weekday values (0=Sun, 1=Mon...)

/** Parse a cron expression into visual state, or null if not parseable */
function parseCronToVisual(expr: string): { freq: Frequency; hour: number; minute: number; weekdays: number[]; monthDay: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;

  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m)) return null;

  // 0 8 * * * → daily
  if (dom === '*' && dow === '*') return { freq: 'daily', hour: h, minute: m, weekdays: [], monthDay: 1 };
  // 0 8 * * 1-5 → weekdays
  if (dom === '*' && dow === '1-5') return { freq: 'weekdays', hour: h, minute: m, weekdays: [1, 2, 3, 4, 5], monthDay: 1 };
  // 0 8 * * 1,3,5 → weekly (specific days)
  if (dom === '*' && /^[\d,]+$/.test(dow)) {
    const days = dow.split(',').map(Number).filter(n => !isNaN(n));
    return { freq: 'weekly', hour: h, minute: m, weekdays: days, monthDay: 1 };
  }
  // 0 8 * * 1 → weekly (single day)
  if (dom === '*' && /^\d$/.test(dow)) {
    return { freq: 'weekly', hour: h, minute: m, weekdays: [parseInt(dow, 10)], monthDay: 1 };
  }
  // 0 8 15 * * → monthly
  if (/^\d+$/.test(dom) && dow === '*') {
    return { freq: 'monthly', hour: h, minute: m, weekdays: [], monthDay: parseInt(dom, 10) };
  }

  return null;
}

/** Build a cron expression from visual state */
function buildCronFromVisual(freq: Frequency, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  switch (freq) {
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(',') : '1';
      return `${minute} ${hour} * * ${days}`;
    }
    case 'monthly': return `${minute} ${hour} ${monthDay} * *`;
    default: return `${minute} ${hour} * * *`;
  }
}

const FREQUENCY_VALUES: Frequency[] = ['interval', 'daily', 'weekdays', 'weekly', 'monthly'];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i), label: String(i).padStart(2, '0'),
}));
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 30, 45].map(m => ({
  value: String(m), label: String(m).padStart(2, '0'),
}));
export default function CronExpressionInput({
  expr,
  tz,
  onChange,
  intervalMinutes,
  onIntervalChange,
}: CronExpressionInputProps) {
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const intervalEnabled = intervalMinutes !== undefined && onIntervalChange !== undefined;
  const visibleFreqOptions = useMemo(
    () => {
      const values = intervalEnabled
        ? FREQUENCY_VALUES
        : FREQUENCY_VALUES.filter((value) => value !== 'interval');
      return values.map((value) => ({
        value,
        label: t(`schedule.frequency.${value}`),
      }));
    },
    [intervalEnabled, t],
  );
  const weekdayLabels = useMemo(
    () => t('schedule.weekdays', { returnObjects: true }) as unknown as string[],
    [t],
  );
  const monthDayOptions = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        value: String(i + 1),
        label: t('schedule.monthDay', { day: i + 1 }),
      })),
    [t],
  );

  // Try to parse existing expr into visual mode. Initial freq priority:
  //   1. Caller opted into interval mode + expr is empty → 'interval'
  //   2. expr parseable into daily/weekdays/weekly/monthly → that freq
  //   3. Otherwise → 'custom' (raw cron textbox)
  const initial = useMemo(() => parseCronToVisual(expr), []);  // eslint-disable-line react-hooks/exhaustive-deps
  const initialFreq: Frequency = useMemo(() => {
    if (intervalEnabled && !expr.trim()) return 'interval';
    return initial?.freq ?? 'daily';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialMode: 'visual' | 'custom' = useMemo(() => {
    if (intervalEnabled && !expr.trim()) return 'visual';
    return initial ? 'visual' : 'custom';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [mode, setMode] = useState<'visual' | 'custom'>(initialMode);
  const [freq, setFreq] = useState<Frequency>(initialFreq);
  const [hour, setHour] = useState(initial?.hour ?? 8);
  const [minute, setMinute] = useState(initial?.minute ?? 0);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1]);
  const [monthDay, setMonthDay] = useState(initial?.monthDay ?? 1);
  const [customExpr, setCustomExpr] = useState(expr);
  // Local interval-minutes state — seeded from prop on mount. We keep a
  // local copy so clicking a non-interval chip can still preserve the
  // user's chosen N if they click back to 固定周期 later. Parent is
  // notified via `onIntervalChange`.
  const [intervalValue, setIntervalValue] = useState<number>(
    intervalMinutes ?? DEFAULT_INTERVAL,
  );

  // Description + next times (for both modes)
  const [description, setDescription] = useState('');
  const [parseError, setParseError] = useState('');
  const [nextTimes, setNextTimes] = useState<string[]>([]);

  // Stabilize `onChange` via a ref so the sync effect below doesn't depend
  // on consumer callback identity. Parents commonly pass inline
  // `setCronExpression={(v) => setDraft((d) => ({ ...d, cronExpression: v }))}`
  // style setters (e.g. `TaskEditPanel`) whose identity changes on every
  // parent render. Without this ref, `syncVisualToParent` re-created each
  // render → effect re-fires → calls `onChange` → parent re-renders →
  // infinite loop (React error #185 when the user interacts with the time
  // dropdown).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // When visual state changes, build cron and notify parent. The
  // 'interval' freq is special: it clears the cron expression (so the
  // backend falls through to `intervalMinutes`) and is *not* a cron
  // shape, so we never call `buildCronFromVisual` for it.
  const onIntervalChangeRef = useRef(onIntervalChange);
  useEffect(() => {
    onIntervalChangeRef.current = onIntervalChange;
  }, [onIntervalChange]);

  const syncVisualToParent = useCallback(() => {
    if (mode !== 'visual') return;
    if (freq === 'interval') {
      onChangeRef.current('', tz);
      onIntervalChangeRef.current?.(intervalValue);
      return;
    }
    const newExpr = buildCronFromVisual(freq, hour, minute, weekdays, monthDay);
    onChangeRef.current(newExpr, tz);
  }, [mode, freq, hour, minute, weekdays, monthDay, tz, intervalValue]);

  useEffect(() => { syncVisualToParent(); }, [syncVisualToParent]);

  // Parse cron for preview. Interval mode has no cron to parse — it
  // renders its own static hint ("每 N 分钟触发") and skips both the
  // cronstrue description and the next-3-times block.
  useEffect(() => {
    if (mode === 'visual' && freq === 'interval') {
      setDescription('');
      setParseError('');
      setNextTimes([]);
      return;
    }
    let cancelled = false;
    const currentExpr = mode === 'custom' ? customExpr : buildCronFromVisual(freq, hour, minute, weekdays, monthDay);

    async function parse() {
      try {
        const cronstrueModule = await import('cronstrue/i18n');
        const toStr = cronstrueModule.toString as (e: string, o?: Record<string, unknown>) => string;
        const desc = toStr(currentExpr, { locale: locale === 'zh-CN' ? 'zh_CN' : 'en' });
        if (!cancelled) { setDescription(desc); setParseError(''); }
      } catch {
        if (!cancelled) { setDescription(''); setParseError(t('schedule.invalidCron')); setNextTimes([]); return; }
      }

      try {
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(currentExpr, { tz });
        const times: string[] = [];
        for (let i = 0; i < 3; i++) {
          const next = interval.next();
          times.push(next.toDate().toLocaleString(locale, {
            month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
          }));
        }
        if (!cancelled) setNextTimes(times);
      } catch {
        if (!cancelled) setNextTimes([]);
      }
    }
    parse();
    return () => { cancelled = true; };
  }, [mode, customExpr, freq, hour, minute, weekdays, monthDay, tz, locale, t]);

  const handleFreqChange = useCallback((f: Frequency) => {
    setFreq(f);
  }, []);

  const handleIntervalInputChange = useCallback((raw: string) => {
    const n = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Number(raw) || MIN_INTERVAL));
    setIntervalValue(n);
    // Only notify the interval callback here. The `onChange('', tz)`
    // that previously sat below was a duplicate of what
    // `syncVisualToParent`'s effect emits on the next render (triggered
    // by the setIntervalValue above) — and when a consumer (e.g.
    // ScheduleTypeTabs) reacts to the empty-expr path by also re-
    // emitting a schedule, the stale-closure read of intervalMinutes
    // within the same event tick clobbered the new value. Letting the
    // effect handle the sync serialises the two calls across a commit
    // boundary so closures see the latest state.
    onIntervalChangeRef.current?.(n);
  }, []);

  const toggleWeekday = useCallback((day: number) => {
    setWeekdays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day];
      return next.length > 0 ? next : [day]; // At least one day
    });
  }, []);

  const handleCustomExprChange = useCallback((val: string) => {
    setCustomExpr(val);
    onChangeRef.current(val, tz);
  }, [tz]);

  const handleSwitchToCustom = useCallback(() => {
    const currentExpr = buildCronFromVisual(freq, hour, minute, weekdays, monthDay);
    setCustomExpr(currentExpr);
    setMode('custom');
    onChangeRef.current(currentExpr, tz);
  }, [freq, hour, minute, weekdays, monthDay, tz]);

  const [canSwitchToVisual, setCanSwitchToVisual] = useState(true);

  // Check if custom expr can be parsed to visual whenever it changes
  useEffect(() => {
    setCanSwitchToVisual(parseCronToVisual(customExpr) !== null);
  }, [customExpr]);

  const handleSwitchToVisual = useCallback(() => {
    const parsed = parseCronToVisual(customExpr);
    if (!parsed) return; // Can't represent this expression visually — stay in custom mode
    setFreq(parsed.freq);
    setHour(parsed.hour);
    setMinute(parsed.minute);
    setWeekdays(parsed.weekdays);
    setMonthDay(parsed.monthDay);
    setMode('visual');
  }, [customExpr]);

  const userTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const tzOptions = useMemo(() => {
    const zones = [userTimezone, 'Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
    return [...new Set(zones)].map(z => ({ value: z, label: z }));
  }, [userTimezone]);

  return (
    <div className="space-y-3">
      {mode === 'visual' ? (
        <>
          {/* Frequency selector — `固定周期` chip is only shown when the
              caller opted in via `intervalMinutes` + `onIntervalChange`.
              Chat tab's ScheduleTypeTabs passes it; pre-v0.1.69 callers
              that don't get the same 5th chip and keep the legacy 4. */}
          <div className="flex flex-wrap gap-1.5">
            {visibleFreqOptions.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleFreqChange(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  freq === opt.value
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Interval mode: single "每 N 分钟" input. Replaces the
              time/weekday/month pickers entirely — interval schedules
              fire every N minutes regardless of clock time, so those
              pickers are meaningless here. */}
          {freq === 'interval' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--ink-muted)]">{t('schedule.every')}</span>
              <input
                type="number"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                value={intervalValue}
                onChange={e => handleIntervalInputChange(e.target.value)}
                className="w-24 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
              />
              <span className="text-xs text-[var(--ink-muted)]">
                {t('schedule.intervalSuffix', { min: MIN_INTERVAL })}
              </span>
            </div>
          ) : (
            <>
              {/* Time picker — shared by daily / weekdays / weekly / monthly */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--ink-muted)]">{t('schedule.time')}</span>
                <CustomSelect value={String(hour)} options={HOUR_OPTIONS} onChange={v => setHour(Number(v))} compact className="w-20" />
                <span className="text-sm text-[var(--ink-muted)]">:</span>
                <CustomSelect value={String(minute)} options={MINUTE_OPTIONS} onChange={v => setMinute(Number(v))} compact className="w-20" />
              </div>

              {/* Weekly: day picker */}
              {freq === 'weekly' && (
                <div className="flex items-center gap-1.5">
                  <span className="mr-1 text-xs text-[var(--ink-muted)]">{t('schedule.weekday')}</span>
                  {weekdayLabels.map((label, i) => {
                    const cronDay = WEEKDAY_CRON[i];
                    const isSelected = weekdays.includes(cronDay);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => toggleWeekday(cronDay)}
                        className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                          isSelected
                            ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                            : 'bg-[var(--paper)] border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)]'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Monthly: day picker */}
              {freq === 'monthly' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--ink-muted)]">{t('schedule.date')}</span>
                  <CustomSelect value={String(monthDay)} options={monthDayOptions} onChange={v => setMonthDay(Number(v))} compact className="w-24" />
                </div>
              )}

              {/* Switch to custom — hidden in interval mode (cron has
                  no clean way to express "every N minutes" for N > 59). */}
              <button
                type="button"
                onClick={handleSwitchToCustom}
                className="flex items-center gap-1 text-xs text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)] transition-colors"
              >
                <Code2 className="h-3 w-3" />
                {t('schedule.useCron')}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          {/* Raw cron input */}
          <div>
            <input
              type="text"
              value={customExpr}
              onChange={e => handleCustomExprChange(e.target.value)}
              placeholder="0 8 * * 1-5"
              className={`w-full rounded-[var(--radius-sm)] border bg-transparent px-3 py-2 font-mono text-sm text-[var(--ink)] focus:outline-none transition-colors ${
                parseError ? 'border-[var(--error)]' : 'border-[var(--line)] focus:border-[var(--accent)]'
              }`}
            />
            {parseError && (
              <div className="mt-1.5 flex items-center gap-1 text-xs text-[var(--error)]">
                <AlertCircle className="h-3 w-3" />
                {parseError}
              </div>
            )}
          </div>

          {/* Switch back to visual */}
          <button
            type="button"
            onClick={handleSwitchToVisual}
            disabled={!canSwitchToVisual}
            className={`flex items-center gap-1 text-xs transition-colors ${
              canSwitchToVisual
                ? 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                : 'text-[var(--ink-subtle)] cursor-not-allowed'
            }`}
          >
            {canSwitchToVisual ? t('schedule.backToVisual') : t('schedule.unsupportedVisual')}
          </button>
        </>
      )}

      {/* Preview (cron description + next-3 times). Hidden in interval
          mode — there's no cron to describe and "next fire" depends on
          when the task was dispatched, not the clock. */}
      {mode === 'visual' && freq === 'interval' ? null : (
        description && !parseError && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
            <p className="text-sm font-medium text-[var(--ink-secondary)]">{description}</p>
            {nextTimes.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {nextTimes.map((time, i) => (
                  <span key={i} className="text-xs text-[var(--ink-muted)]">• {time}</span>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {/* Timezone — also irrelevant for interval mode (an N-minute
          cadence is timezone-independent). */}
      {!(mode === 'visual' && freq === 'interval') && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--ink-muted)]">{t('schedule.timezone')}</span>
          <CustomSelect value={tz} options={tzOptions} onChange={v => onChangeRef.current(mode === 'custom' ? customExpr : buildCronFromVisual(freq, hour, minute, weekdays, monthDay), v)} compact className="w-48" />
        </div>
      )}
    </div>
  );
}
