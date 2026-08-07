// TaskCenter — single-instance tab combining Thought stream (left) and Task list (right).
// PRD §5 / §6.

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThoughtPanel } from '@/components/task-center/ThoughtPanel';
import { TaskListPanel } from '@/components/task-center/TaskListPanel';
import { DispatchTaskDialog } from '@/components/task-center/DispatchTaskDialog';
import { taskCenterAvailable } from '@/api/taskCenter';
import { track } from '@/analytics';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import type { Thought } from '@/../shared/types/thought';
import type { Task } from '@/../shared/types/task';

interface Props {
  isActive?: boolean;
  /** Canonical Session id of the Chat tab from which Task Center was opened. */
  currentSessionId?: string | null;
  /** Most recent OPEN_TASK_CENTER event payload. Forwarded to `TaskListPanel`
   *  so navigation with `{ autofocusSearch: true }` can open the task-list
   *  search input without the user touching the UI a second time. `nonce`
   *  forces the consumer's effect to re-fire when the same intent is sent
   *  back-to-back (e.g. user clicking the Launcher search icon twice). */
  pendingIntent?: { autofocusSearch?: boolean; nonce: number } | null;
}

export default function TaskCenter({ isActive, pendingIntent, currentSessionId }: Props) {
  const { t } = useTranslation('task');
  const [dispatching, setDispatching] = useState<Thought | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Child panels react to `isActive` transitions on their own (via refreshKey
  // derived from it below). We do NOT setState in an effect here — the lint
  // rule `react-hooks/set-state-in-effect` flags that. `isActive` itself is
  // passed down as the refresh signal.
  //
  // Tabs stay mounted with `content-visibility: hidden` when inactive, so
  // panels need to know "I just became active again" to reload. Passing
  // `isActive` straight through accomplishes that without a derived counter.

  const handleDispatch = useCallback((t: Thought) => {
    setDispatching(t);
  }, []);

  const handleDiscuss = useCallback((t: Thought, workspaceId: string) => {
    track('task_align_discuss', {});
    // Hand off to App.tsx which owns tab creation. The workspace was picked
    // explicitly via the card's workspace popover, so we carry its id through
    // the event; App.tsx uses it instead of running a smart-default guess.
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
        detail: {
          thoughtId: t.id,
          content: t.content,
          tags: t.tags,
          workspaceId,
        },
      }),
    );
  }, []);

  const handleDispatched = useCallback((task: Task) => {
    track('task_create', {
      source: 'desktop',
      origin: 'thought_dispatch',
      has_workspace: !!task.workspacePath,
    });
    setDispatching(null);
    setRefreshKey((k) => k + 1);
  }, []);

  // The DispatchTaskDialog returns the full Task, but for Phase 4 we only need
  // to know "something changed" to re-fetch both panels. Future Phase 5 hook:
  // pass the task down so the newly created one can be highlighted/scrolled to.

  if (!taskCenterAvailable()) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] px-8 text-center">
        <div className="max-w-md text-sm leading-relaxed text-[var(--ink-muted)]">
          <p className="font-medium text-[var(--ink-secondary)]">{t('center.title')}</p>
          <p className="mt-2">
            {t('center.desktopOnly')}
          </p>
          <p className="mt-2 text-[var(--ink-muted)]/70">
            {t('center.desktopUnavailable')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--paper)]">
      {/* Page title — v0.1.69 polish:
            • breadcrumb "沉淀想法 › 派发任务 › 让 AI 执行" removed
              (it was scene-setting copy, redundant once the user is in
              the tab)
            • title bumped to 20px (type-scale §2.2 --text-xl) so it
              reads as the page heading it is, a tier above the 14px
              section headers inside the panels below
            • bottom border removed; vertical breathing room (pt/pb)
              replaces the hairline as the divider, continuing the
              "layout over rules" direction set in the review  */}
      <div className="flex shrink-0 items-center px-5 pt-5 pb-3">
        <h1 className="text-xl font-semibold text-[var(--ink)]">
          {t('center.title')}
        </h1>
      </div>

      {/* Two-column body — each panel renders its own section header
          (icon + label + collapsible 🔍 search toggle). */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Thought stream */}
        <div className="flex w-[480px] shrink-0 flex-col overflow-hidden">
          <ThoughtPanel
            onDispatchThought={handleDispatch}
            onDiscussThought={handleDiscuss}
            refreshKey={`${refreshKey}:${isActive ? '1' : '0'}`}
            // Suppress thought-input autofocus when the user arrived via
            // the Launcher 「我的任务」 search icon — in that flow the
            // caret belongs in the TaskListPanel search field, not the
            // ThoughtInput. Both would otherwise `requestAnimationFrame`
            // a focus call on the same tick, the right panel's effect
            // wins by render order but the user sees a momentary caret
            // flicker on the thought input. (v0.1.69 cross-review W4)
            autoFocusInput={!!isActive && !pendingIntent?.autofocusSearch}
          />
        </div>

        {/* Divider — weaker line-subtle (6% ink) so the two panels feel
            like a continuous surface rather than two pages cut apart.
            A full --line (10%) reads heavier than the card borders, which
            made the split feel over-emphasized. */}
        <div className="w-px bg-[var(--line-subtle)]" />

        {/* Right: Task list */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TaskListPanel
            refreshKey={`${refreshKey}:${isActive ? '1' : '0'}`}
            pendingIntent={pendingIntent ?? null}
            currentSessionId={currentSessionId ?? null}
          />
        </div>
      </div>

      {dispatching && (
        <DispatchTaskDialog
          thought={dispatching}
          currentSessionId={currentSessionId ?? null}
          onClose={() => setDispatching(null)}
          onDispatched={handleDispatched}
        />
      )}
    </div>
  );
}
