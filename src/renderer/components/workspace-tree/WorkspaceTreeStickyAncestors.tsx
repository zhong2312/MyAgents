import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";

import { FileIcon } from "@/components/file-icon";

import { STICKY_DROP_PREFIX } from "./dropTarget";
import { OverflowNameTooltip } from "./OverflowNameTooltip";
import type { StickyAncestor } from "./treeTypes";

interface WorkspaceTreeStickyAncestorsProps {
  ancestors: StickyAncestor[];
  rowHeight: number;
  /** The resolved drop target (internal drag OR external drag), for highlight. */
  dropHighlightPath: string | null;
  /** Chevron click → collapse that folder. */
  onClosePath: (path: string) => void;
  /** Row click → jump to (select + scroll to) that folder, VS Code style. */
  onJumpToPath: (path: string) => void;
  /** Right-click → the folder's own context menu. Pre-fix the right-click
   *  fell through to the tree container, which treated it as "empty area"
   *  and opened the ROOT menu — so 「新建笔记」 on what the user perceived
   *  as a folder created the note at the workspace root. */
  onPathContextMenu: (path: string, event: React.MouseEvent) => void;
  /** Wheel events would otherwise die on the overlay (it is a SIBLING of the
   *  Virtuoso scroller, so nothing scrollable sits in its bubble path) —
   *  forward them so the bar isn't a scroll dead zone. */
  onWheel: (event: React.WheelEvent) => void;
}

/** One breadcrumb row. Split out so each row can register its own droppable:
 *  the bar visually owns the top of the viewport, and without an explicit
 *  droppable the collision detection hit the INVISIBLE rows covered by the
 *  bar — dropping "on the breadcrumb folder" landed somewhere else.
 *  `data-tree-row` / `data-tree-path` make external (OS / browser) drags and
 *  the container's empty-area checks see this row like any tree row. */
const StickyAncestorRow = memo(function StickyAncestorRow({
  ancestor,
  rowHeight,
  isDropTarget,
  onClosePath,
  onJumpToPath,
  onPathContextMenu,
}: {
  ancestor: StickyAncestor;
  rowHeight: number;
  isDropTarget: boolean;
  onClosePath: (path: string) => void;
  onJumpToPath: (path: string) => void;
  onPathContextMenu: (path: string, event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation("app");
  const { setNodeRef } = useDroppable({
    id: `${STICKY_DROP_PREFIX}${ancestor.path}`,
  });

  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      data-tree-row
      data-tree-path={ancestor.path}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 text-sm font-medium transition-colors ${
        isDropTarget
          ? "ring-1 ring-inset ring-[var(--accent)]/40 bg-[var(--accent)]/8 text-[var(--ink)]"
          : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
      }`}
      style={{
        height: rowHeight,
        paddingLeft: `${12 + ancestor.depth * 16}px`,
      }}
      onClick={() => onJumpToPath(ancestor.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          // Without stopPropagation the event reaches the tree container's
          // key handler, which re-runs `activate` against the (stale)
          // focused row — a second action on top of the jump.
          e.stopPropagation();
          onJumpToPath(ancestor.path);
        }
      }}
      onContextMenu={(e) => onPathContextMenu(ancestor.path, e)}
    >
      <button
        type="button"
        title={t("workspaceTree.collapseFolder")}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        onClick={(e) => {
          e.stopPropagation();
          onClosePath(ancestor.path);
        }}
        // Keyboard activation must stay on the chevron: without this the
        // keydown bubbles to the row, whose handler preventDefaults (killing
        // the button's native click) and jumps instead of collapsing.
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
          }
        }}
      >
        <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
      </button>
      <FileIcon name={ancestor.name} nodeKind="directory" expanded />
      <OverflowNameTooltip
        label={ancestor.name}
        className="min-w-0 flex-1 truncate text-left"
      />
    </div>
  );
});

export const WorkspaceTreeStickyAncestors = memo(
  function WorkspaceTreeStickyAncestors({
    ancestors,
    rowHeight,
    dropHighlightPath,
    onClosePath,
    onJumpToPath,
    onPathContextMenu,
    onWheel,
  }: WorkspaceTreeStickyAncestorsProps) {
    if (ancestors.length === 0) {
      return null;
    }

    return (
      <div
        className="absolute left-0 right-0 top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] shadow-xs"
        // VS Code-style push transition: the viewport writes the sub-row
        // scroll fraction into `--tree-sticky-push` (pure DOM write, no
        // re-render) and the bar slides up as the deepest folder's subtree
        // ends; the tree container's overflow-hidden clips the exiting rows.
        style={{
          transform: "translateY(calc(-1 * var(--tree-sticky-push, 0px)))",
        }}
        onWheel={onWheel}
      >
        {ancestors.map((ancestor) => (
          <StickyAncestorRow
            key={ancestor.path}
            ancestor={ancestor}
            rowHeight={rowHeight}
            isDropTarget={dropHighlightPath === ancestor.path}
            onClosePath={onClosePath}
            onJumpToPath={onJumpToPath}
            onPathContextMenu={onPathContextMenu}
          />
        ))}
      </div>
    );
  },
);
