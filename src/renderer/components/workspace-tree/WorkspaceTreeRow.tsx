import { ChevronRight, Loader2 } from "lucide-react";
import { memo, useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";

import { FileIcon } from "@/components/file-icon";

import { OverflowNameTooltip } from "./OverflowNameTooltip";
import type { VisibleTreeRow } from "./treeTypes";

interface WorkspaceTreeRowProps {
  row: VisibleTreeRow;
  rowHeight: number;
  isDropTarget: boolean;
  isInternalDropTarget: boolean;
  /** Row lies INSIDE the current drop-target directory's subtree — the whole
   *  destination region tints so the user sees where items will land. */
  isInDropSubtree: boolean;
  isDragging: boolean;
  /** Keyboard focus (distinct from selection — VS Code semantics). */
  isFocused: boolean;
  /** On the clipboard in CUT mode — dimmed until pasted elsewhere. */
  isCut: boolean;
  /** DOM focus is inside the tree container. Selection renders ACTIVE
   *  (accent) only then; otherwise it dims (VS Code inactive selection) so
   *  the user can see the tree won't receive keyboard shortcuts — a Cmd+C
   *  while another pane (editor / embedded browser) owns the keys was
   *  previously indistinguishable from an armed selection. */
  treeActive: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const WorkspaceTreeRow = memo(function WorkspaceTreeRow({
  row,
  rowHeight,
  isDropTarget,
  isInternalDropTarget,
  isInDropSubtree,
  isDragging,
  isFocused,
  isCut,
  treeActive,
  onClick,
  onContextMenu,
}: WorkspaceTreeRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
  } = useDraggable({
    id: `drag:${row.path}`,
    data: row.data,
  });
  // Every row is droppable — FILE rows resolve to their parent directory in
  // the panel's drop-target resolver (VS Code semantics). Pre-fix file rows
  // were disabled, so dragging over them yielded `over=null`, which the panel
  // interpreted as "workspace root" → items silently moved to the root.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop:${row.path}`,
  });

  const mergedRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef],
  );

  // Single highlight source: the panel-resolved target (state). The raw
  // dnd-kit `isOver` is deliberately NOT used — it disagrees with the resolved
  // target for file rows (parent dir) and lags one frame behind, which read
  // as highlight flicker while dragging.
  const highlight = isDropTarget || isInternalDropTarget;

  const stateClasses = highlight
    ? "ring-1 ring-inset ring-[var(--accent)]/40 bg-[var(--accent)]/8"
    : isDragging
      ? "opacity-40"
      : `${
          isInDropSubtree
            ? "bg-[var(--accent)]/4 "
            : ""
        }${
          row.isSelected
            ? treeActive
              ? "bg-[var(--accent-warm-muted)] text-[var(--ink)]"
              : "bg-[var(--paper-inset)] text-[var(--ink)]"
            : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        }${isCut ? " opacity-50" : ""}`;

  return (
    <div
      ref={mergedRef}
      data-tree-row
      data-tree-path={row.path}
      {...attributes}
      {...listeners}
      className={`flex cursor-pointer items-center gap-2 px-3 text-sm transition-colors select-none ${stateClasses}${
        isFocused && treeActive
          ? " outline outline-1 -outline-offset-1 outline-[var(--accent)]/45"
          : ""
      }`}
      style={{
        height: rowHeight,
        paddingLeft: `${12 + row.depth * 16}px`,
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--ink-muted)]">
        {row.isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : row.isDir ? (
          <ChevronRight
            className={`h-3 w-3 transition-transform ${row.isOpen ? "rotate-90" : ""}`}
          />
        ) : null}
      </span>
      <FileIcon
        name={row.data.name}
        nodeKind={row.isDir ? "directory" : "file"}
        expanded={row.isOpen}
      />
      <OverflowNameTooltip
        label={row.data.name}
        className="min-w-0 flex-1 truncate font-medium"
      />
    </div>
  );
});
