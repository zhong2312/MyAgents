// ModeSegment — "任务 / 想法" mode declaration switcher.
// Shown above the input box on Launcher (the only current caller).
//
// v0.1.69 redesign: replaced the prior "text | text" pipe layout with the
// macOS-settings-style icon segmented control (variant F in the
// `specs/playgrounds/mode-segment.html` sandbox). The segmented control
// reads as one affordance rather than two free-floating buttons — it's
// clearer that these are mutually-exclusive modes of a single surface.
// (Chat surface previously used a "compact" variant; after the v0.1.69
// review round the Chat input bar was simplified and no longer mounts
// this component.)
//
// Icons:
//   • 对话 → Sparkles — "AI 执行感觉"; the left button is now named
//            "对话" (v0.1.69+ relabel) to reflect what actually happens
//            when the user hits Enter: a fresh Chat tab + AI invocation.
//            "任务" was misleading — Task Center tasks are a separate
//            concept; here we're just starting a conversation that may
//            or may not become a task.
//   • 想法 → Lightbulb (same as `ThoughtPanel` header) — ideation pairs
//            naturally with the Sparkles affordance.

import { Lightbulb, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { retainFocusOnMouseDown } from '@/utils/focusRetention';

export type InputMode = 'task' | 'thought';

interface ModeSegmentProps {
  value: InputMode;
  onChange: (mode: InputMode) => void;
  /** Optional slot on the right side (e.g. info tooltip). */
  suffix?: ReactNode;
  /**
   * When true, each button surfaces a `title` tooltip hinting that Tab
   * toggles the segment. Used on the Launcher where BrandSection binds
   * a page-level Tab handler; omit on surfaces without that binding so
   * we don't advertise a shortcut that doesn't work there.
   */
  tabSwitchHint?: boolean;
}

export function ModeSegment({
  value,
  onChange,
  suffix,
  tabSwitchHint = false,
}: ModeSegmentProps) {
  const { t } = useTranslation('chat');
  const taskTitle = tabSwitchHint ? t('input.mode.switchToThought') : undefined;
  const thoughtTitle = tabSwitchHint ? t('input.mode.switchToChat') : undefined;

  // Segment button — the `active` state gets a raised paper-elevated
  // background (so the whole row reads as a track with a sliding
  // thumb), `shadow-xs` for the subtle macOS-style lift, and full ink
  // for the label. Inactive state stays ink-muted and relies on a soft
  // hover → ink-secondary step for feedback.
  // v0.1.69 polish: sized down (px-3.5 → px-3,（v2.5 字阶合并后文字回到 ui 档 14px）
  // icons 3.5 → 3) so the toggle reads as an affordance above the
  // input rather than a second-tier headline competing with the brand
  // group above it.
  const baseBtn =
    'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1 text-sm font-medium transition-all duration-150';
  const activeBtn =
    'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs';
  const inactiveBtn =
    'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]';

  return (
    // `retainFocusOnMouseDown` on each segment button prevents the click
    // from transferring focus to the button itself, so any textarea the
    // user was typing in stays focused. This ALSO avoids a macOS WebKit
    // touchpad-tap bug where a subsequent `rAF(() => input.focus())`
    // would race the click-synthesis window and drop the click — see
    // `utils/focusRetention.ts` for the full write-up. Pit-of-success:
    // every future tab/toggle-style button should paste the same
    // `onMouseDown={retainFocusOnMouseDown}` so the reader immediately
    // recognises the intent and we can grep all call sites.
    <div className="inline-flex items-center">
      <div className="inline-flex gap-0.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-[3px]">
        <button
          type="button"
          onClick={() => onChange('task')}
          onMouseDown={retainFocusOnMouseDown}
          aria-pressed={value === 'task'}
          title={taskTitle}
          className={`${baseBtn} ${value === 'task' ? activeBtn : inactiveBtn}`}
        >
          <Sparkles className="h-3 w-3" strokeWidth={1.75} />
          {t('input.mode.chat')}
        </button>
        <button
          type="button"
          onClick={() => onChange('thought')}
          onMouseDown={retainFocusOnMouseDown}
          aria-pressed={value === 'thought'}
          title={thoughtTitle}
          className={`${baseBtn} ${value === 'thought' ? activeBtn : inactiveBtn}`}
        >
          <Lightbulb className="h-3 w-3" strokeWidth={1.75} />
          {t('input.mode.thought')}
        </button>
      </div>
      {suffix && <span className="ml-2 flex items-center">{suffix}</span>}
    </div>
  );
}

export default ModeSegment;
