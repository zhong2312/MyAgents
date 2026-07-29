// TaskDocBlock — read-only preview for one of a task's markdown
// documents (`task.md` / `verify.md` / `progress.md`).
//
// v0.1.69 refactor: the component used to host its own Monaco editor
// for inline edits. That parallel editor diverged visually and
// behaviourally from `TaskEditPanel`'s textarea — same content, two
// UIs, user confusion. Now: the block only previews content; the
// overlay header's single "编辑" button is the canonical edit entry
// (no per-block pencil, no notification pencil — one entry only, per
// the v0.1.69 preview polish).
//
// v0.2.4: docs can grow long (an active progress.md log easily hits
// kilobytes). The preview now collapses by default to a "more than
// half a screen" peek (`COLLAPSED_MAX_PX`) with a fade-out gradient
// and a "展开全部 / 收起" toggle. Short docs that already fit inside
// the cap keep the toggle hidden (we measure `scrollHeight` after
// render and only show the affordance when it's actually needed).
//
// `progress.md` callers set `hideWhenEmpty` so the block vanishes on
// new tasks that have no execution log yet.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, FolderOpen } from 'lucide-react';

import Markdown from '@/components/Markdown';
import { taskOpenDocsDir, taskReadDoc, type TaskDocName } from '@/api/taskCenter';
import type { Task } from '@/../shared/types/task';
import { extractErrorMessage } from './errors';

/** Collapsed preview height. ~"more than half a screen" on a typical
 *  laptop viewport, generous enough that short docs don't get clipped. */
const COLLAPSED_MAX_PX = 280;
/** Slack we add before declaring content "actually needs the toggle".
 *  Without this, content that just barely overflows would render the
 *  fade + button while showing all of it — confusing. */
const OVERFLOW_SLACK_PX = 24;

interface Props {
  task: Task;
  /** Which document — maps 1:1 to the filename stem. */
  doc: TaskDocName;
  title: string;
  /** Surfaced when the file is missing and `hideWhenEmpty` is false. */
  emptyHint: string;
  /** If true, render nothing when the file is empty (progress.md uses this
   *  so new tasks don't show a dashed empty-box). */
  hideWhenEmpty?: boolean;
  /** Signal: task refetched externally → reload content. */
  reloadKey?: unknown;
  onError: (msg: string) => void;
}

export function TaskDocBlock({
  task,
  doc,
  title,
  emptyHint,
  hideWhenEmpty = false,
  reloadKey,
  onError,
}: Props) {
  const { t } = useTranslation('task');
  const [content, setContent] = useState('');
  // "Loaded" is derived from a snapshot of the load keys: when task.id
  // / doc / reloadKey change, `loadedFor` no longer equals the current
  // triple → `loaded` flips to false until the fetch lands and writes
  // the new snapshot. Avoids a `setLoaded(false)` call inside the
  // effect (lint: react-hooks/set-state-in-effect).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadKey = `${task.id}|${doc}|${String(reloadKey ?? '')}`;
  const loaded = loadedFor === loadKey;

  // Collapse state:
  //   `expanded`        — user intent (false by default)
  //   `overflows`       — does the rendered content actually need the
  //                       toggle? Computed via scrollHeight after render.
  //                       New content (or reloadKey bump) resets it to
  //                       false until the next layout pass measures.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await taskReadDoc(task.id, doc);
        if (cancelled) return;
        setContent(body);
        setLoadedFor(loadKey);
        // Fresh content → collapse again so jumping to a new task
        // doesn't carry over the prior "expanded" state.
        setExpanded(false);
      } catch (e) {
        if (cancelled) return;
        onError(extractErrorMessage(e));
        setLoadedFor(loadKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, doc, reloadKey, loadKey, onError]);

  // After the markdown renders, measure whether it overflows the cap.
  // We defer to rAF so the setState fires from an async callback rather
  // than the effect body (lint: react-hooks/set-state-in-effect). Also
  // attaches a ResizeObserver to re-measure when the surrounding modal
  // resizes — Markdown content reflowed by viewport width can flip
  // between "fits" and "overflows".
  useEffect(() => {
    if (!loaded) return;
    const el = contentRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      const fits = el.scrollHeight <= COLLAPSED_MAX_PX + OVERFLOW_SLACK_PX;
      setOverflows(!fits);
    };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [loaded, content]);

  // The on-disk path is deterministic (`~/.myagents/tasks/<id>/<doc>.md`)
  // so we can surface it + an opener button right below the title —
  // same pattern as the edit panel's DocSectionHeader, so preview and
  // edit modes don't diverge visually. Declared before the
  // hideWhenEmpty short-circuit so the useCallback hook call order
  // stays stable across renders (rules-of-hooks).
  const path = `~/.myagents/tasks/${task.id}/${doc}.md`;
  const handleOpenFolder = useCallback(() => {
    void taskOpenDocsDir(task.id).catch((e) => onError(extractErrorMessage(e)));
  }, [task.id, onError]);

  // hideWhenEmpty short-circuit: a loaded but empty progress.md renders
  // nothing; an unloaded one renders the loading placeholder so users
  // see the block during initial fetch (prevents jumpy layout).
  if (hideWhenEmpty && loaded && !content) return null;

  const showCollapseAffordance = loaded && !!content && overflows;
  const showFade = showCollapseAffordance && !expanded;

  return (
    <section className="mt-4">
      {/* Title — text-sm(14px) semibold ink, matches the edit panel's section
          headers so the preview ↔ edit mental model is identical. */}
      <h3 className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
      {/* Path + 打开文件夹 on a dedicated row below the title. */}
      <div className="mb-2 mt-1 flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ink-muted)]/70"
          title={path}
        >
          {path}
        </span>
        <button
          type="button"
          onClick={handleOpenFolder}
          title={t('docBlock.openDocsDirTitle')}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <FolderOpen className="h-3 w-3" />
          {t('docBlock.openDocsDir')}
        </button>
      </div>

      {!loaded ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)] p-3 text-xs text-[var(--ink-muted)]">
          {t('docBlock.loading')}
        </div>
      ) : content ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)]">
          <div
            // `relative` so the fade gradient can position absolutely.
            // `overflow-hidden` guarantees the clip happens at this layer
            // even if the inner Markdown does its own positioning. We use
            // an explicit max-height with transition so expand/collapse
            // animates rather than snaps.
            className="relative overflow-hidden transition-[max-height] duration-200 ease-out"
            style={{
              maxHeight: showCollapseAffordance && !expanded ? COLLAPSED_MAX_PX : 9999,
            }}
          >
            <div ref={contentRef} className="p-4">
              {/* `compact` keeps the whole Markdown rhythm at the 14px density
                  used by the edit-mode textarea, so preview → edit does not
                  jump in either type size or vertical spacing. */}
              <Markdown compact>{content}</Markdown>
            </div>
            {showFade && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--paper)] to-[var(--paper-a0)]"
              />
            )}
          </div>
          {showCollapseAffordance && (
            <div className="flex items-center justify-center border-t border-[var(--line-subtle)]">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" />
                    {t('docBlock.collapse')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" />
                    {t('docBlock.expandAll')}
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--line)] bg-[var(--paper)] p-3 text-xs text-[var(--ink-muted)]">
          {emptyHint}
        </div>
      )}
    </section>
  );
}

export default TaskDocBlock;
