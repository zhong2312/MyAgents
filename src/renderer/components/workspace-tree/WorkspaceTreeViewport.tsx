import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";
import type { Components, ContextProp } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import { useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";

import { runAfterNextPaint } from "@/utils/afterPaint";
import { EMPTY_HINT_DROP_PREFIX, ROOT_DROP_ID } from "./dropTarget";
import { WorkspaceTreeEditRow } from "./WorkspaceTreeEditRow";
import { WorkspaceTreeRow } from "./WorkspaceTreeRow";
import { WorkspaceTreeStickyAncestors } from "./WorkspaceTreeStickyAncestors";
import {
  computeStickyPushPx,
  MAX_STICKY_ANCESTOR_DEPTH,
  resolveStickyAncestors,
} from "./treeFlatten";
import type { StickyAncestor, TreeListItem } from "./treeTypes";

// Reveal waits this many frames for react-virtuoso's scroller to finish layout
// before giving up. scrollToIndex no-ops on an unmeasured scroller, which is
// exactly the state right after the conditional (search→tree) mount.
const REVEAL_READINESS_MAX_FRAMES = 20;

interface ViewportContext {
  footerHeight: number;
}

// CONSTANT bottom slack (`MAX_STICKY_ANCESTOR_DEPTH * rowHeight`). Two jobs:
// (1) the scroll-content height never changes, so `maxScroll` never moves and
// `scrollTop` stays a stable input for the sticky breadcrumb (no feedback
// loop at the bottom); (2) the last rows can scroll clear of the overlay
// breadcrumb bar, mirroring an editor's "scroll beyond last line".
//
// There is deliberately NO header spacer: the breadcrumb is an OVERLAY that
// covers the top rows (VS Code sticky-scroll semantics). The previous
// variable-height header spacer resized at every breadcrumb depth change and
// made the whole list jump by ±rowHeight while scrolling.
const TreeFooterSpacer = memo(function TreeFooterSpacer({
  context,
}: ContextProp<ViewportContext>) {
  if (context.footerHeight <= 0) {
    return null;
  }
  return <div aria-hidden="true" style={{ height: context.footerHeight }} />;
});

const TREE_COMPONENTS: Components<TreeListItem, ViewportContext> = {
  Footer: TreeFooterSpacer,
};

/** Synthetic row under an open, fully-loaded, EMPTY directory. It stands in
 *  for that directory: drops (internal via its droppable, external via
 *  `data-tree-path`) and right-clicks target the dir, not the root. */
const WorkspaceTreeEmptyHintRow = memo(function WorkspaceTreeEmptyHintRow({
  parentDir,
  depth,
  rowHeight,
  onContextMenu,
}: {
  parentDir: string;
  depth: number;
  rowHeight: number;
  onContextMenu: (path: string, event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation("app");
  const { setNodeRef } = useDroppable({
    id: `${EMPTY_HINT_DROP_PREFIX}${parentDir}`,
  });
  return (
    <div
      ref={setNodeRef}
      data-tree-row
      data-tree-path={parentDir}
      className="flex items-center gap-2 px-3 text-xs italic text-[var(--ink-subtle)] select-none"
      style={{ height: rowHeight, paddingLeft: `${12 + depth * 16 + 20}px` }}
      onContextMenu={(e) => onContextMenu(parentDir, e)}
    >
      {t("workspaceTree.emptyFolderHint")}
    </div>
  );
});

export interface WorkspaceTreeViewportHandle {
  /** Minimal-scroll "keep the focused row visible" (keyboard navigation). */
  scrollPathIntoView: (path: string) => void;
}

interface WorkspaceTreeViewportProps {
  items: TreeListItem[];
  rowHeight: number;
  dropTargetPath: string | null;
  internalDropTarget: string | null;
  activeDragPaths: readonly string[];
  /** Paths on the clipboard in CUT mode (rendered dimmed). */
  cutPaths: readonly string[];
  /** Keyboard-focused row path. */
  focusedPath: string | null;
  /** DOM focus is inside the tree container — selection renders active. */
  treeActive: boolean;
  initialScrollTop?: number;
  revealRequest?: { id: number; path: string } | null;
  onRevealHandled?: (id: number) => void;
  getStickyAncestors: (
    firstVisibleIndex: number,
    scrollTop: number,
  ) => StickyAncestor[];
  onCloseAncestorPath: (path: string) => void;
  /** Click on a sticky breadcrumb row → jump to (select + scroll to) that folder. */
  onJumpToAncestorPath: (path: string) => void;
  /** Right-click on a sticky breadcrumb / empty-hint row → the folder's menu. */
  onAncestorContextMenu: (path: string, event: React.MouseEvent) => void;
  onRowClick: (item: Extract<TreeListItem, { kind: "node" }>["row"], event: React.MouseEvent) => void;
  onRowContextMenu: (
    item: Extract<TreeListItem, { kind: "node" }>["row"],
    event: React.MouseEvent,
  ) => void;
  /** Inline editor (rename / create) callbacks. */
  onEditCommit: (name: string) => void;
  onEditCancel: () => void;
  onScrollTopChange?: (scrollTop: number) => void;
}

export const WorkspaceTreeViewport = memo(
  forwardRef<WorkspaceTreeViewportHandle, WorkspaceTreeViewportProps>(
    function WorkspaceTreeViewport(
      {
        items,
        rowHeight,
        dropTargetPath,
        internalDropTarget,
        activeDragPaths,
        cutPaths,
        focusedPath,
        treeActive,
        initialScrollTop = 0,
        revealRequest = null,
        onRevealHandled,
        getStickyAncestors,
        onCloseAncestorPath,
        onJumpToAncestorPath,
        onAncestorContextMenu,
        onRowClick,
        onRowContextMenu,
        onEditCommit,
        onEditCancel,
        onScrollTopChange,
      },
      ref,
    ) {
      // Scroll position quantized to whole rows. The sticky breadcrumb only
      // depends on `floor(scrollTop / rowHeight)`, so storing the quantized
      // value turns "re-render every scrolled pixel" into "re-render every
      // crossed row boundary" — the raw value still reaches `onScrollTopChange`
      // (a ref write in the parent) and the push-animation CSS variable on
      // every scroll event.
      const [topUnits, setTopUnits] = useState(() =>
        Math.max(0, Math.floor(initialScrollTop / rowHeight)),
      );
      const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
        null,
      );
      const virtuosoRef = useRef<VirtuosoHandle>(null);
      const lastRevealRequestIdRef = useRef<number | null>(null);
      // Live element ref (read inside async rAF callbacks without a stale closure).
      const scrollerElRef = useRef<HTMLElement | null>(null);
      // Wrapper element — carries the `--tree-sticky-push` CSS variable so the
      // push animation never enters React state.
      const wrapperElRef = useRef<HTMLDivElement | null>(null);
      // Latest items, so a deferred reveal recomputes its index after a
      // non-idempotent refresh may have reordered the list mid-flight.
      const itemsRef = useRef(items);
      useEffect(() => {
        itemsRef.current = items;
      }, [items]);
      const getStickyAncestorsRef = useRef(getStickyAncestors);
      useEffect(() => {
        getStickyAncestorsRef.current = getStickyAncestors;
      }, [getStickyAncestors]);
      // Cancel handle for an in-flight (deferred) reveal scroll.
      const revealCancelRef = useRef<(() => void) | null>(null);
      // initialScrollTop is a restore-on-mount, applied at most once (when the
      // scroller first attaches). Re-applying on later prop churn could clobber
      // a reveal scroll that just landed.
      const didRestoreScrollRef = useRef(false);

      useEffect(() => {
        if (!scrollerElement || didRestoreScrollRef.current) {
          return;
        }
        didRestoreScrollRef.current = true;
        // A pending reveal owns the scroll position — don't fight it with a restore.
        if (initialScrollTop > 0 && !revealRequest) {
          scrollerElement.scrollTo({ top: initialScrollTop });
        }
      }, [initialScrollTop, revealRequest, scrollerElement]);

      // Cancel any in-flight reveal rAF on unmount.
      useEffect(() => () => revealCancelRef.current?.(), []);

      useEffect(() => {
        if (!scrollerElement) {
          return;
        }

        const countAtUnit = (unit: number) => {
          const quantized = unit * rowHeight;
          return resolveStickyAncestors(
            quantized,
            rowHeight,
            MAX_STICKY_ANCESTOR_DEPTH,
            (firstVisibleIndex) =>
              getStickyAncestorsRef.current(firstVisibleIndex, quantized),
          ).length;
        };

        const handleScroll = () => {
          const nextScrollTop = scrollerElement.scrollTop;
          // Quantized setState: same value → React bails out, no re-render.
          setTopUnits(Math.max(0, Math.floor(nextScrollTop / rowHeight)));
          // VS Code-style push transition — pure DOM write per scroll event.
          const push = computeStickyPushPx(nextScrollTop, rowHeight, countAtUnit);
          wrapperElRef.current?.style.setProperty(
            "--tree-sticky-push",
            `${push}px`,
          );
          onScrollTopChange?.(nextScrollTop);
        };

        handleScroll();
        scrollerElement.addEventListener("scroll", handleScroll, {
          passive: true,
        });
        return () => {
          scrollerElement.removeEventListener("scroll", handleScroll);
        };
      }, [onScrollTopChange, rowHeight, scrollerElement]);

      // Sticky breadcrumb derived purely from the (quantized, stable) scroll
      // position — never from Virtuoso's rendered range, which is both a
      // feedback variable and offset from the visual top by the overscan. See
      // `resolveStickyAncestors` for the overlay-model derivation.
      const quantizedScrollTop = topUnits * rowHeight;
      const stickyAncestors = useMemo(
        () =>
          resolveStickyAncestors(
            quantizedScrollTop,
            rowHeight,
            MAX_STICKY_ANCESTOR_DEPTH,
            (firstVisibleIndex) =>
              getStickyAncestors(firstVisibleIndex, quantizedScrollTop),
          ),
        [getStickyAncestors, rowHeight, quantizedScrollTop],
      );
      const context = useMemo<ViewportContext>(
        () => ({ footerHeight: MAX_STICKY_ANCESTOR_DEPTH * rowHeight }),
        [rowHeight],
      );

      const handleScrollerRef = useCallback(
        (element: HTMLElement | null | Window) => {
          const el = element instanceof HTMLElement ? element : null;
          scrollerElRef.current = el;
          setScrollerElement(el);
        },
        [],
      );

      // Viewport-wide droppable = the workspace root. Dropping on blank space
      // below the last row lands at the root; rows themselves win over this
      // zone via the panel's collision detection (rows are checked first).
      const { setNodeRef: setRootDropRef } = useDroppable({ id: ROOT_DROP_ID });
      const mergedWrapperRef = useCallback(
        (el: HTMLDivElement | null) => {
          wrapperElRef.current = el;
          setRootDropRef(el);
        },
        [setRootDropRef],
      );

      // Forward wheel events from the sticky overlay to the scroller. The
      // overlay is a SIBLING of Virtuoso's scroller, so wheel events over it
      // have no scrollable ancestor and the top of the tree becomes a scroll
      // dead zone.
      const handleStickyWheel = useCallback((event: React.WheelEvent) => {
        scrollerElRef.current?.scrollBy({ top: event.deltaY });
      }, []);

      useImperativeHandle(
        ref,
        () => ({
          scrollPathIntoView: (path: string) => {
            const index = itemsRef.current.findIndex(
              (item) => item.kind === "node" && item.row.path === path,
            );
            if (index < 0) return;
            virtuosoRef.current?.scrollIntoView({ index, behavior: "auto" });
          },
        }),
        [],
      );

      // Scroll a requested path into view. The tree is conditionally rendered
      // (search ↔ tree), so a reveal coincides with a FRESH MOUNT of this
      // Virtuoso, whose scroller isn't measured yet during this mount-time
      // effect — `scrollToIndex` silently no-ops there. The old fire-once code
      // also consumed the request immediately (+ dedup ref), so it never
      // retried once the scroller was ready → the viewport stayed at the top.
      // Fix: claim the request, then scroll only AFTER paint and once the
      // scroller has a real height, recomputing the index against the latest
      // items.
      useEffect(() => {
        if (
          !revealRequest ||
          lastRevealRequestIdRef.current === revealRequest.id
        ) {
          return;
        }
        // Ancestors may still be (lazily) expanding — bail until the row
        // exists; the next `items` change re-runs this effect.
        if (
          items.findIndex(
            (item) => item.kind === "node" && item.row.path === revealRequest.path,
          ) < 0
        ) {
          return;
        }
        const { id, path } = revealRequest;
        lastRevealRequestIdRef.current = id;
        revealCancelRef.current?.(); // supersede any prior pending reveal

        let framesLeft = REVEAL_READINESS_MAX_FRAMES;
        let rafHandle = 0;
        const attempt = () => {
          const el = scrollerElRef.current;
          const index = itemsRef.current.findIndex(
            (item) => item.kind === "node" && item.row.path === path,
          );
          if (index >= 0 && el && el.clientHeight > 0) {
            // Instant (not 'smooth'): robust to a list refresh interrupting
            // the animation, and the right UX for a "jump to file" reveal.
            virtuosoRef.current?.scrollToIndex({
              index,
              align: "center",
              behavior: "auto",
            });
            onRevealHandled?.(id);
            revealCancelRef.current = null;
            return;
          }
          if (framesLeft-- <= 0) {
            onRevealHandled?.(id);
            revealCancelRef.current = null;
            return;
          }
          rafHandle = requestAnimationFrame(attempt);
        };
        const cancelFirst = runAfterNextPaint(attempt);
        revealCancelRef.current = () => {
          cancelFirst();
          if (rafHandle) cancelAnimationFrame(rafHandle);
        };
        // No cleanup-cancel: this effect re-runs on every `items` change (lazy
        // expand / refresh) and cancelling would abort an in-flight reveal.
        // Same-id re-runs bail at the top; unmount cancellation is the
        // dedicated effect above.
      }, [onRevealHandled, revealRequest, items]);

      const dropTargetDir = internalDropTarget ?? dropTargetPath;

      return (
        <div ref={mergedWrapperRef} className="h-full">
          <WorkspaceTreeStickyAncestors
            ancestors={stickyAncestors}
            rowHeight={rowHeight}
            dropHighlightPath={dropTargetDir}
            onClosePath={onCloseAncestorPath}
            onJumpToPath={onJumpToAncestorPath}
            onPathContextMenu={onAncestorContextMenu}
            onWheel={handleStickyWheel}
          />
          <Virtuoso
            ref={virtuosoRef}
            className="h-full overscroll-none"
            style={{ scrollbarGutter: "stable" }}
            components={TREE_COMPONENTS}
            computeItemKey={(_index, item) => item.key}
            context={context}
            data={items}
            fixedItemHeight={rowHeight}
            increaseViewportBy={{ bottom: rowHeight * 8, top: rowHeight * 4 }}
            scrollerRef={handleScrollerRef}
            itemContent={(_index, item) => {
              switch (item.kind) {
                case "edit":
                  return (
                    <WorkspaceTreeEditRow
                      editing={item.editing}
                      depth={item.depth}
                      rowHeight={rowHeight}
                      onCommit={onEditCommit}
                      onCancel={onEditCancel}
                    />
                  );
                case "empty-hint":
                  return (
                    <WorkspaceTreeEmptyHintRow
                      parentDir={item.parentDir}
                      depth={item.depth}
                      rowHeight={rowHeight}
                      onContextMenu={onAncestorContextMenu}
                    />
                  );
                case "node": {
                  const row = item.row;
                  return (
                    <WorkspaceTreeRow
                      row={row}
                      rowHeight={rowHeight}
                      isDropTarget={row.isDir && dropTargetPath === row.path}
                      isInternalDropTarget={
                        row.isDir && internalDropTarget === row.path
                      }
                      isInDropSubtree={
                        !!dropTargetDir &&
                        row.path.startsWith(`${dropTargetDir}/`)
                      }
                      isDragging={activeDragPaths.includes(row.path)}
                      isFocused={focusedPath === row.path}
                      isCut={cutPaths.includes(row.path)}
                      treeActive={treeActive}
                      onClick={(event) => onRowClick(row, event)}
                      onContextMenu={(event) => onRowContextMenu(row, event)}
                    />
                  );
                }
              }
            }}
          />
        </div>
      );
    },
  ),
);
