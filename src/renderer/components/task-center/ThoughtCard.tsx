// ThoughtCard — single thought row rendered in the left-column stream.
// Supports inline edit, an overflow "更多" menu for destructive actions,
// and a "dispatch to task" split-button entry.
//
// Two height regimes:
//   • View (非编辑态): long content clamps to `VIEW_CLAMP_LINES` lines and
//     surfaces a 展开/收起 toggle. The overflow flag is measured post-render
//     so the toggle only appears when content is actually clipped.
//   • Edit (编辑态): textarea auto-resizes with content up to
//     `EDIT_MAX_HEIGHT_PX`, beyond which it scrolls internally. This keeps
//     a single oversized draft from eating the whole panel.

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  Check,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
} from 'lucide-react';
import { thoughtDelete, thoughtSetArchived, thoughtUpdate } from '@/api/taskCenter';
import { Popover } from '@/components/ui/Popover';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useConfig } from '@/hooks/useConfig';
import { getFolderName } from '@/types/tab';
import { isProjectVisibleToUser, type Project } from '@/config/types';
import type { Thought } from '@/../shared/types/thought';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';
import {
  findHighlightRanges,
  renderTextWithHighlights,
} from '@/utils/highlightSearchMatches';
import { relativeTime } from '@/utils/taskCenterUtils';
import { isSupportedLocale } from '@/../shared/i18n';

interface Props {
  thought: Thought;
  onChanged: (t: Thought | null) => void;
  onDispatch?: (t: Thought) => void;
  /** Open a new chat tab with `/task-alignment` (PRD §8.3). The selected
   *  workspace is the one the user picked from the popover. */
  onDiscuss?: (t: Thought, workspaceId: string) => void;
  /** Click handler for inline tag chips — wires into the panel's tag filter. */
  onTagClick?: (tag: string) => void;
  /** Active search query from the panel — when non-empty, every match in the
   *  thought body is wrapped in a `<mark>` span. Tag pills stay tag-coloured
   *  and are not double-highlighted. */
  searchQuery?: string;
  /** When true, the card renders in selection-mode skin: hover actions are
   *  hidden, the entire body becomes a click target that toggles selection,
   *  and a checkbox is shown at the bottom-right corner. */
  selectMode?: boolean;
  /** Whether this card is currently in the selected set. */
  selected?: boolean;
  /** Called when the card body is clicked while `selectMode` is true. */
  onToggleSelect?: () => void;
  /** Called from the ⋯ menu's "多选" item — parent enters select mode and
   *  pre-selects this card. */
  onEnterSelectMode?: () => void;
}

const VIEW_CLAMP_LINES = 5;
const EDIT_MAX_HEIGHT_PX = 224; // ~8.75 行 @ text-base 16px × leading-[1.6] = 25.6px/行

export function ThoughtCard({
  thought,
  onChanged,
  onDispatch,
  onDiscuss,
  onTagClick,
  searchQuery,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelectMode,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thought.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';

  const viewRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const discussAnchorRef = useRef<HTMLButtonElement>(null);

  // Workspace list for the AI-discussion picker. Internal projects
  // (the ~/.myagents helper workspace) and hidden system presets are hidden —
  // a thought belongs to user work, not the diagnostic sandbox. Sorted by
  // most-recently opened so the user's current work bubbles up.
  const { projects } = useConfig();
  const pickableWorkspaces = useMemo<Project[]>(() => {
    return projects
      .filter(isProjectVisibleToUser)
      .slice()
      .sort((a, b) => {
        const ta = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
        const tb = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
        return tb - ta;
      });
  }, [projects]);

  // Smart default — match a thought tag against a workspace name so the
  // popover lands with the most likely pick highlighted. Falls back to
  // the first (most recent) workspace.
  const suggestedWorkspaceId = useMemo(() => {
    const lowerTags = thought.tags?.map((t) => t.toLowerCase()) ?? [];
    const matched = pickableWorkspaces.find((p) =>
      lowerTags.includes(p.name.toLowerCase()),
    );
    return (matched ?? pickableWorkspaces[0])?.id;
  }, [pickableWorkspaces, thought.tags]);

  // Overflow detection — measure only in collapsed state so flipping to
  // expanded doesn't reset the flag (clientHeight would grow to match).
  useLayoutEffect(() => {
    if (editing || expanded) return;
    const el = viewRef.current;
    if (!el) return;
    setHasOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [thought.content, editing, expanded]);

  // Auto-resize the edit textarea on every draft change, bounded by
  // EDIT_MAX_HEIGHT_PX. Beyond that the textarea scrolls internally.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_HEIGHT_PX)}px`;
  }, [draft, editing]);

  // Close, flip, and outside-click behaviour are handled by the `<Popover>`
  // primitive below — no hand-rolled `mousedown` / `keydown` / viewport
  // measurement here.

  const handleSave = useCallback(async () => {
    if (draft.trim() === thought.content.trim()) {
      setEditing(false);
      setExpanded(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtUpdate({ id: thought.id, content: draft });
      onChanged(updated);
      setEditing(false);
      // Return to collapsed state so the effect re-measures against the new
      // content; otherwise `hasOverflow` can stay stale from the pre-edit
      // body length.
      setExpanded(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, thought.content, thought.id, onChanged]);

  const handleDelete = useCallback(async () => {
    setShowMenu(false);
    setBusy(true);
    setError(null);
    try {
      await thoughtDelete(thought.id);
      onChanged(null);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [thought.id, onChanged]);

  const isArchived = thought.archived === true;
  const handleToggleArchive = useCallback(async () => {
    setShowMenu(false);
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtSetArchived(thought.id, !isArchived);
      // Returning the updated thought lets the panel filter it out of the
      // current view if the new archived state no longer matches viewMode.
      onChanged(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [thought.id, isArchived, onChanged]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(thought.content);
        setEditing(false);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
    },
    [thought.content, handleSave],
  );

  const enterEdit = useCallback(() => {
    setDraft(thought.content);
    setEditing(true);
    setExpanded(true); // opening edit always shows the full body
  }, [thought.content]);

  const convertedCount = thought.convertedTaskIds?.length ?? 0;

  // Multi-select skin — the entire card becomes a click target that toggles
  // selection. We render via `<div role="button">` rather than a real
  // `<button>` because the card already nests a textarea (in edit mode) and
  // a popover trigger; nesting interactive elements inside a `<button>` is
  // invalid HTML and causes accessibility-tree noise.
  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectMode) return;
    // Tag pills inside the body call `e.stopPropagation()` so they don't
    // toggle selection when filtering by tag — but in selectMode we want
    // the whole card to be a select target; the renderer above already
    // suppresses `onTagClick` in selectMode, so this branch only sees
    // bare clicks. Defensive guard for future divergence:
    if ((e.target as HTMLElement).closest('[data-thought-card-no-toggle]')) return;
    onToggleSelect?.();
  };

  return (
    // Card rhythm (DESIGN.md §6.2 compact card):
    //   p-4          — 16px all sides (border → inner content gutter)
    //   mb-2 between meta row and body — 8px, tight enough that the
    //                  meta row reads as part of the same card, not a
    //                  stray header.
    //   mt-3 between body and footer (expand toggle / inline-edit
    //                  action bar) — 12px, the larger step that visually
    //                  separates "read" from "act".
    <div
      onClick={handleCardClick}
      className={`group relative rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-4 transition-shadow hover:shadow-sm ${
        selectMode ? 'cursor-pointer' : ''
      } ${
        selected
          ? 'ring-1 ring-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]'
          : ''
      }`}
    >
      {/* Top meta row — time + derived-task count on the left, action
          cluster on the right. Moved from the bottom of the card (prior
          iteration) so status reads first, before the user commits to
          reading the full body.

          Row height is driven by the 12px text (≈ 20px row with the 14px
          icon). The `⋯` button is `h-5 w-5` (20px) rather than the
          toolbar default `h-6 w-6`; larger would force the whole row
          taller than the text needs, pushing the body down and making
          the top padding read as larger than the bottom `p-4` — the
          card felt lopsided.

          Always-rendered meta row (rendered in BOTH preview and edit
          modes — only the right-side action cluster hides in edit).
          Prior shape hid the whole row on `!editing`, which yanked the
          textarea up by ~24px on double-click — jitter the user saw
          as the card "jumping". Consistent structure across states
          means no reflow on mode transitions. */}
      <div className="mb-2 flex h-5 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-[var(--ink-muted)]/60">
          {relativeTime(thought.updatedAt, locale)}
          {convertedCount > 0 && (
            <span className="ml-2 text-[var(--accent-warm)]">
              {t('thoughts.derivedTasks', { count: convertedCount })}
            </span>
          )}
        </span>
        {!editing && !selectMode && (
          <div className="flex shrink-0 items-center gap-1">
            {/* Primary actions (AI 讨论 / 派发) — hover-only to keep the
                 resting card uncluttered. Each button owns a local
                 `group/btn-*` so its dark-pill tooltip doesn't inherit
                 the card-level `group-hover`. Native `title=` would
                 render the OS-default grey tooltip and break with the
                 WorkspaceCard tooltip language we use elsewhere. */}
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {onDiscuss && (
                <div className="group/discuss relative">
                  <button
                    ref={discussAnchorRef}
                    type="button"
                    onClick={() => setShowWorkspacePicker((v) => !v)}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)]"
                  >
                    <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.aiDiscuss')}
                  </button>
                  {!showWorkspacePicker && (
                    <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-lg transition-opacity group-hover/discuss:opacity-100">
                      {t('thoughts.aiDiscussTooltip')}
                    </span>
                  )}
                </div>
              )}
              {onDispatch && (
                <div className="group/dispatch relative">
                  <button
                    type="button"
                    onClick={() => onDispatch(thought)}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)]"
                  >
                    <Zap className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.dispatch')}
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-lg transition-opacity group-hover/dispatch:opacity-100">
                    {t('thoughts.dispatchTooltip')}
                  </span>
                </div>
              )}
            </div>
            {/* Workspace picker — rendered once per card; shows when the
                 AI 讨论 button is clicked. Portal'd via Popover so the
                 anchor's `overflow-hidden` card chrome can't clip it. */}
            {onDiscuss && (
              <Popover
                open={showWorkspacePicker}
                onClose={() => setShowWorkspacePicker(false)}
                anchorRef={discussAnchorRef}
                placement="bottom-end"
                className="min-w-[240px] max-w-[320px] py-1"
              >
                <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/70">
                  {t('thoughts.workspacePicker')}
                </div>
                <div className="max-h-[280px] overflow-y-auto py-1">
                  {pickableWorkspaces.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-[var(--ink-muted)]">
                      {t('thoughts.noWorkspace')}
                    </div>
                  ) : (
                    pickableWorkspaces.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setShowWorkspacePicker(false);
                          onDiscuss(thought, p.id);
                        }}
                        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--hover-bg)] ${
                          p.id === suggestedWorkspaceId ? 'bg-[var(--accent-warm-subtle)]' : ''
                        }`}
                      >
                        <WorkspaceIcon icon={p.icon} size={20} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--ink)]">
                            {p.displayName || getFolderName(p.path)}
                          </div>
                          <div className="truncate text-xs text-[var(--ink-muted)]/70">
                            {p.path}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </Popover>
            )}
            {/* "更多" — always visible so the user has a permanent
                 handle on secondary actions (编辑 / 删除) without having
                 to hover-discover. `h-5 w-5` matches the meta row's
                 text-driven height so the button never raises the row
                 above its 20px baseline. */}
            <button
              ref={menuAnchorRef}
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              disabled={busy}
              title={t('thoughts.moreActions')}
              className="flex h-5 w-5 items-center justify-center rounded-[var(--radius-md)] text-[var(--ink-muted)]/70 transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <Popover
              open={showMenu}
              onClose={() => setShowMenu(false)}
              anchorRef={menuAnchorRef}
              placement="bottom-end"
              className="min-w-[120px] py-1"
            >
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  enterEdit();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('common.edit')}
              </button>
              {onEnterSelectMode && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    onEnterSelectMode();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <CheckSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t('thoughts.multiSelect')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleToggleArchive()}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
              >
                {isArchived ? (
                  <>
                    <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.unarchive')}
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.archive')}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--error-bg)]"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('common.delete')}
              </button>
            </Popover>
          </div>
        )}
      </div>

      {/* Body — thought content or edit textarea. */}
      {editing ? (
        <textarea
          ref={editRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleEditKeyDown}
          autoFocus
          rows={2}
          style={{
            minHeight: '2.75rem',
            maxHeight: `${EDIT_MAX_HEIGHT_PX}px`,
            overflowY: 'auto',
          }}
          className="w-full resize-none rounded-[var(--radius-sm)] bg-transparent text-base leading-[1.6] text-[var(--ink)] focus:outline-none"
        />
      ) : (
        <div
          ref={viewRef}
          className="cursor-text whitespace-pre-wrap break-words text-base leading-[1.6] text-[var(--ink-secondary)]"
          style={
            expanded
              ? undefined
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: VIEW_CLAMP_LINES,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }
          }
          onDoubleClick={selectMode ? undefined : enterEdit}
        >
          {renderWithTagHighlights(
            thought.content,
            selectMode ? undefined : onTagClick,
            searchQuery,
          )}
        </div>
      )}

      {/* Bottom-right select indicator. Rendered only in selectMode so the
          resting card doesn't carry an extra glyph. The card body's onClick
          is the actual toggle target — the checkbox is a visual receipt
          (and a separate click target for users who specifically aim at it). */}
      {selectMode && (
        <div className="pointer-events-none absolute bottom-2 right-2">
          <div
            className={`flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
              selected
                ? 'border-[var(--accent-warm)] bg-[var(--accent-warm)] text-[var(--on-accent)]'
                : 'border-[var(--line-strong)] bg-[var(--paper-elevated)] text-transparent'
            }`}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </div>
        </div>
      )}

      {/* Expand/collapse toggle — only when the clamp actually clipped
          content. Sits directly below the body so it feels attached to it. */}
      {!editing && hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-[var(--accent-warm)] hover:underline"
        >
          {expanded ? t('thoughts.collapse') : t('thoughts.expand')}
        </button>
      )}

      {error && (
        <div className="mt-2 text-xs text-[var(--error)]">{error}</div>
      )}

      {/* Inline edit action bar — only in edit mode. Sits at the bottom
          so the edit flow reads top-down: textarea → save/cancel. */}
      {editing && (
        <div className="mt-3 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => {
              setDraft(thought.content);
              setEditing(false);
            }}
            disabled={busy}
            className="rounded-[var(--radius-md)] px-2 py-1 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy}
            className="rounded-[var(--radius-md)] bg-[var(--accent-warm)] px-2.5 py-1 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)]"
          >
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function renderWithTagHighlights(
  content: string,
  onTagClick?: (tag: string) => void,
  searchQuery?: string,
) {
  // Pill styling matches the ThoughtInput overlay — single source of truth
  // for what a `#tag` looks like across authoring & display. Parser is
  // shared with Rust (`thought.tags[]`) so highlight ≡ persisted tags.
  const parts = splitWithTagHighlights(content);
  const pillCls =
    'rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] px-1 text-[var(--accent-warm)]';
  // Search-keyword highlight is intentionally only applied to non-tag
  // segments. Tag pills are already a coloured block; layering a `<mark>`
  // inside them doubles the visual emphasis and looks broken.
  const q = searchQuery?.trim() ?? '';
  return parts.map((p, i) => {
    if (p.type === 'tag' && p.tag) {
      const body = p.tag;
      return onTagClick ? (
        <button
          key={i}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTagClick(body);
          }}
          className={`${pillCls} cursor-pointer transition-colors hover:bg-[var(--accent-warm-muted)]`}
        >
          {p.value}
        </button>
      ) : (
        <span key={i} className={pillCls}>
          {p.value}
        </span>
      );
    }
    if (q.length > 0) {
      const ranges = findHighlightRanges(p.value, q);
      if (ranges.length > 0) {
        return <span key={i}>{renderTextWithHighlights(p.value, ranges)}</span>;
      }
    }
    return <span key={i}>{p.value}</span>;
  });
}

export default ThoughtCard;
