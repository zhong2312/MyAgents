import {
  AtSign,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eye,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListChecks,
  LocateFixed,
  NotebookPen,
  Pencil,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  ExternalLink,
  TerminalSquare,
  Search,
  Globe,
  PanelRight,
  X,
} from "lucide-react";
import Tip from "@/components/Tip";
import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";

import { useTabApi } from "@/context/TabContext";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import type {
  DirectoryTreeNode,
  DirectoryTree,
  ExpandDirectoryResult,
} from "../../../shared/dir-types";
import {
  isImageFile,
  isPreviewable,
  isRichDocPreviewable,
  getRichDocKind,
} from "../../../shared/fileTypes";
import { getFileIcon } from "@/utils/fileIcons";
import { copyPlainText } from "@/utils/clipboard";

import { useImagePreview } from "@/context/ImagePreviewContext";
import { useToast } from "@/components/Toast";
import { isDebugMode } from "@/utils/debug";
import { useWorkspaceChangeSignal } from "@/hooks/useWorkspaceChangeSignal";
import { shortenPathForDisplay } from "@/utils/pathDetection";
import { isMarkdownFile } from "@/utils/languageUtils";

import ConfirmDialog from "../ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "../ContextMenu";
import type { FileMatchLine, FileSearchHit } from "@/api/searchClient";
import FileSearchResults from "../search/FileSearchResults";
import type { FilePreviewFocusTarget } from "@/types/filePreview";
import {
  ancestorDirectoryPaths,
  firstMatchLine,
} from "@/utils/workspaceSearchNavigation";
import { REVEAL_NODE_WAIT_FRAMES } from './constants';
import {
  getFolderName,
  waitForTreeFrame,
} from './pathDisplay';
import { useDirectorySearch } from './hooks/useDirectorySearch';
import AgentCapabilitiesPanel from "../AgentCapabilitiesPanel";
import WorkspaceSessionHistory from "./WorkspaceSessionHistory";
import WorkspaceIcon from "../launcher/WorkspaceIcon";
import { useWorkspaceTreeModel } from "../workspace-tree/useWorkspaceTreeModel";
import {
  WorkspaceTreeViewport,
  type WorkspaceTreeViewportHandle,
} from "../workspace-tree/WorkspaceTreeViewport";
import {
  findTypeAheadTarget,
  resolveTreeKeyAction,
} from "../workspace-tree/treeKeyboard";
import {
  baseNameOf,
  buildUndoPlan,
  pushUndoEntry,
  type UndoableOp,
} from "../workspace-tree/undoJournal";
import {
  parentDirOfPath,
  type TreeEditingState,
} from "../workspace-tree/treeTypes";
import {
  resolveExternalDropDir,
  resolveInternalDropTarget,
  ROOT_DROP_ID,
  STICKY_DROP_PREFIX,
} from "../workspace-tree/dropTarget";
import {
  applyChildrenMap,
  collectFreshUpdates,
  mergeLazyChildren,
  treeNodeEqual,
} from "../workspace-tree/treeMerge";
import type { VisibleTreeRow } from "../workspace-tree/treeTypes";
import type {
  ContextMenuState,
  DialogState,
  DirectoryPanelHandle,
  DirectoryPanelProps,
  FilePreview,
  TreeClipboard,
} from './types';

// Lazy load FilePreviewModal - it includes heavy SyntaxHighlighter
const FilePreviewModal = lazy(() => import("../FilePreviewModal"));

const DirectoryPanel = memo(
  forwardRef<DirectoryPanelHandle, DirectoryPanelProps>(function DirectoryPanel(
    {
      agentDir,
      projectIcon,
      projectDisplayName,
      currentSessionId,
      onSelectSession,
      provider: _provider,
      providers: _providers = [],
      onProviderChange: _onProviderChange,
      onCollapse,
      onOpenConfig,
      refreshTrigger,
      persistedTreeStateRef,
      onRefreshAll,
      isTauriDragActive = false,
      onInsertReference,
      onQuoteFile,
      onQuoteSelection,
      externalRevealRequest,
      onExternalRevealHandled,
      enabledAgents,
      enabledSkills,
      enabledCommands,
      globalSkillFolderNames,
      onInsertSlashCommand,
      onOpenSettings,
      onSyncSkillToGlobal,
      onFilePreviewExternal,
      onOpenTerminal,
      terminalAlive,
      onOpenBrowser,
    },
    ref,
  ) {
    // Seed from the per-tab persisted ref so reopening the panel restores the
    // previously-loaded tree instead of cold-loading collapsed. The mount
    // refresh (rawRefresh) then reconciles it with fresh data via mergeLazyChildren.
    const [directoryInfo, setDirectoryInfo] = useState<DirectoryTree | null>(
      () => persistedTreeStateRef?.current.directoryInfo ?? null,
    );
    const [error, setError] = useState<string | null>(null);
    // Multi-selection support
    const [selectedNodes, setSelectedNodes] = useState<DirectoryTreeNode[]>([]);
    const lastClickedPathRef = useRef<string | null>(null); // Anchor for shift-select
    const [isUploading, setIsUploading] = useState(false);
    const [preview, setPreview] = useState<FilePreview | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    // Monotonic counter for "latest preview request wins". Every async preview
    // path (text preview, image preview, search-result preview) bumps this on
    // entry and re-checks before committing state — old in-flight requests are
    // dropped silently so a slow file's response can't overwrite the fresh
    // click's result, double-fire toasts, or strand `isPreviewLoading=true`.
    // React `useState` is unsuitable as a concurrency lock because state
    // updates are async; two rapid clicks both pass a `if (isPreviewLoading)`
    // gate that closure-captured the pre-update value. `useRef` is the
    // sync-visible alternative the project's React-stability rules call for.
    const previewReqIdRef = useRef(0);
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);
    // Monotonic counter for "latest refresh wins". `rawRefresh` is async
    // (dirTree + cascade of dirExpand calls), and multiple triggers (fs
    // watcher, tool-complete bump, 120s polling, manual refresh) can
    // overlap. A stale in-flight refresh resolving after a newer one
    // would otherwise stamp stale data onto `directoryInfo`. Same pattern
    // as `previewReqIdRef` above.
    const refreshReqIdRef = useRef(0);
    // Bridge ref: `rawRefresh` is declared above `useWorkspaceTreeModel`
    // (which produces the canonical `getOpenPaths`). Reading the latest
    // openPaths through this ref keeps `rawRefresh`'s identity stable
    // and avoids re-ordering the entire component body.
    const getOpenPathsRef = useRef<() => ReadonlySet<string>>(
      () => new Set<string>(),
    );

    // Context menu and dialog states
    const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
    const [dialog, setDialog] = useState<DialogState>(null);
    const [importTargetDir, setImportTargetDir] = useState<string>("");

    // Keyboard focus (distinct from selection — VS Code tree semantics).
    const [focusedPath, setFocusedPath] = useState<string | null>(null);
    // Whether DOM focus is inside the tree container. Selection renders
    // DIMMED when it isn't — without this cue, a tree that lost focus (to
    // the editor pane / the embedded-browser OS webview) still LOOKS armed,
    // and the user can't tell their Cmd+C went somewhere else entirely
    // (实测 2026-06-11: 浏览器面板吞掉 Cmd+C, Cmd+V 落空且无从解释).
    const [isTreeFocusWithin, setIsTreeFocusWithin] = useState(false);
    // Inline create/rename editor state (synthetic row in the tree).
    const [editing, setEditing] = useState<TreeEditingState | null>(null);
    // Internal file clipboard (Cmd+C / Cmd+X / Cmd+V on tree nodes).
    const [clipboard, setClipboard] = useState<TreeClipboard>(null);
    // Refs for the document-level clipboard EVENT listeners (declared early;
    // mirrored after the handlers are defined). On macOS the native Edit
    // menu's ⌘C/⌘X/⌘V key equivalents are consumed by the MENU before the
    // WebView dispatches any keydown — what reaches the DOM is the standard
    // clipboard event (menu Copy → `copy:` selector → `copy` event). The
    // tree's clipboard must therefore hook these EVENTS; the keydown mapping
    // only serves platforms without a pre-empting native menu.
    const copySelectionRef = useRef<
      (
        mode: "copy" | "cut",
        opts?: { skipAsyncOsWrite?: boolean },
      ) => string | null
    >(() => null);
    const pasteFromClipboardRef = useRef<() => Promise<void>>(async () => {});
    const clipboardRef = useRef<TreeClipboard>(null);
    // The exact text we last wrote to the OS clipboard alongside an internal
    // file copy. On paste, a mismatch means the user has copied something
    // ELSE since (screenshot, Finder files, text) — the internal clipboard is
    // stale and must yield to the OS content instead of silently shadowing
    // it forever (cross-review 0.2.33, cc W2; VS Code does the same compare).
    // Null = no successful OS write recorded → can't judge staleness, keep
    // the internal clipboard authoritative (degrades to pre-fix behavior).
    const lastOsClipboardTextRef = useRef<string | null>(null);
    // Undo journal for reversible mutations (move/rename/create/paste).
    // Ref — pushing/popping must not re-render the tree.
    const undoJournalRef = useRef<readonly UndoableOp[]>([]);
    const typeAheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
      buffer: "",
      timer: null,
    });
    const viewportRef = useRef<WorkspaceTreeViewportHandle>(null);

    // External drag-drop state
    const [isExternalDrop, setIsExternalDrop] = useState(false);
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const dragCounterRef = useRef(0);

    // Internal drag-drop state (@dnd-kit pointer-events based)
    const [activeDragItem, setActiveDragItem] = useState<{
      paths: string[];
      name: string;
      icon: React.ElementType;
    } | null>(null);
    const [internalDropTarget, setInternalDropTarget] = useState<string | null>(
      null,
    );
    const internalDropTargetRef = useRef<string | null>(null);
    // Paths being dragged, mirrored into a ref so the (hot) drag-over handler
    // and the pure drop-target resolver read them without re-binding on every
    // drag start.
    const activeDragPathsRef = useRef<readonly string[]>([]);
    const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const treeScrollTopRef = useRef(0);

    const ROW_HEIGHT = 26;

    // Git branch state
    const [gitBranch, setGitBranch] = useState<string | null>(null);

    // Lazy loading state - track directories currently being loaded
    // Use ref to store actual data, state only for triggering UI updates
    const loadingDirsRef = useRef<Set<string>>(new Set());
    const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

    const previewFocusRequestIdRef = useRef(0);
    const {
      isSearchMode,
      setIsSearchMode,
      searchQuery,
      setSearchQuery,
      isSearching,
      isRefreshingSearch,
      searchResults,
      expandedFiles,
      setExpandedFiles,
      activeSearchTarget,
      setActiveSearchTarget,
      searchContextMenu,
      setSearchContextMenu,
      treeRevealRequest,
      setTreeRevealRequest,
      searchInputRef,
      treeRevealRequestIdRef,
      debouncedSearchQuery,
    } = useDirectorySearch(agentDir);

    // Image preview context
    const { openPreview } = useImagePreview();

    // Toast for notifications
    const toast = useToast();
    const { t } = useTranslation("chat");
    const tRef = useRef(t);
    tRef.current = t;
    const isMacPlatform =
      typeof navigator !== "undefined" &&
      navigator.platform.toLowerCase().includes("mac");
    const copyShortcut = isMacPlatform ? "Cmd+C" : "Ctrl+C";
    const pasteShortcut = isMacPlatform ? "Cmd+V" : "Ctrl+V";

    // Get Tab-scoped API functions and tabId
    // PRD 0.2.7 Phase D: useTabApi() return value is no longer destructured —
    // file IO has migrated entirely to `useWorkspaceFileService`. The TabApi
    // hook still wraps React subscription state, so keeping the call
    // ensures the component re-renders when Tab context changes (active /
    // inactive). If a future refactor proves the call has no observable
    // side effects, it can be dropped.
    useTabApi();
    // PRD 0.2.7 Phase D: workspace file IO migrated from sidecar HTTP to Rust
    // invoke. The hook is identical to the one SimpleChatInput uses, just with
    // the additional Phase D operations (dirTree, dirExpand, readPreview, etc.).
    const fileService = useWorkspaceFileService(agentDir ?? null);
    const workspaceChangeSignal = useWorkspaceChangeSignal(agentDir ?? null, fileService.isAvailable);

    // Narrow mode collapse state (for responsive layout)
    const [isNarrowMode, setIsNarrowMode] = useState(false);

    // ── Vertical drag: tree / capabilities ratio ──
    // Default 0.6 = tree 60%, capabilities 40%. Resets on tab close (local state).
    const [capRatio, setCapRatio] = useState(0.4);
    const capRatioRef = useRef(0.4);
    capRatioRef.current = capRatio;
    const isDraggingCapRef = useRef(false);
    const capDragMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
    const capDragUpRef = useRef<(() => void) | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(true); // Default collapsed in narrow mode
    const panelRef = useRef<HTMLDivElement>(null);

    // Detect narrow mode (when panel becomes full width, i.e. stacked layout)
    useEffect(() => {
      const checkNarrowMode = () => {
        // Check if we're in stacked/narrow layout by checking window width
        // Use CSS custom property --breakpoint-mobile (640px) for consistency
        const breakpoint = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--breakpoint-mobile",
          ) || "640",
          10,
        );
        const narrow = window.innerWidth < breakpoint;
        setIsNarrowMode(narrow);
        if (!narrow) {
          setIsCollapsed(false); // Always show in wide mode
        } else {
          setIsCollapsed(true); // Default collapsed in narrow mode
        }
      };

      checkNarrowMode();
      window.addEventListener("resize", checkNarrowMode);
      return () => window.removeEventListener("resize", checkNarrowMode);
    }, []);

    const folderName = getFolderName(agentDir);

    // Track previous item count to only log when changed
    const prevItemCountRef = useRef(-1);

    // Raw refresh — fetches the directory tree non-destructively.
    // Not debounced; used for initial load and explicit user actions (manual
    // refresh button). The debounced wrapper below coalesces watcher / tool /
    // polling triggers.
    //
    // Why non-destructive: `dirTree()` returns a depth-4 capped tree, and
    // `dirExpand()` returns at most depth=3 sub-trees. The renderer's
    // `directoryInfo` is built incrementally as the user expands deep folders.
    // A naive `setDirectoryInfo(data)` wipes those lazy patches and collapses
    // every previously-expanded depth-5+ branch on every refresh — which fires
    // every AI tool completion, every save, every fs watcher event, and every
    // 120s polling tick. See `treeMerge.ts` for the merge + re-fetch logic.
    //
    // MUST NOT invalidate the file search index here. This runs on every file
    // watcher event (AI tool completion, Monaco save, external edits), so
    // invalidating would thrash the Tantivy index and force a full rebuild of
    // ~1000+ files on every keystroke in the search box while the agent is
    // actively writing files. File search refreshes the index from the
    // foreground query path; background refreshes must not jump ahead of that
    // query on the Rust file-index queue.
    const rawRefresh = useCallback(() => {
      setError(null);
      const reqId = ++refreshReqIdRef.current;
      const isStillCurrent = () => reqId === refreshReqIdRef.current;
      void (async () => {
        try {
          const data = await fileService.dirTree();
          if (!isStillCurrent()) return; // superseded by newer refresh

          // Re-fetch the expansion frontier: for every `openPaths` entry that
          // sits at a `loaded:false` boundary in the fresh tree, kick a
          // dirExpand. Cascades across rounds until all open boundaries are
          // resolved (capped at maxIterations as a safety net).
          //
          // `isLoading` prevents racing with a user-driven `expandDir` on the
          // same path (the user click is in-flight; let it commit its own
          // result rather than double-fetching and risking a stale stomp).
          //
          // `shouldContinue` cancels the cascade when a newer refresh fires —
          // without it a slow cascade keeps burning IPCs after its result is
          // already dead.
          const openPaths = getOpenPathsRef.current();
          const updates =
            openPaths.size > 0
              ? await collectFreshUpdates(
                  data.tree,
                  openPaths,
                  fileService.dirExpand,
                  {
                    isLoading: (path) => loadingDirsRef.current.has(path),
                    shouldContinue: isStillCurrent,
                  },
                )
              : new Map<string, ExpandDirectoryResult>();
          if (!isStillCurrent()) return; // superseded mid-cascade

          // Single setState commits the combined result: new top-level skeleton
          // + stale fallback for any expanded branch we couldn't refetch +
          // fresh dirExpand patches on top.
          //
          // The reqId re-check inside the updater closes a React-19 concurrent-
          // rendering hole: setState updaters can be evaluated after a newer
          // refresh has already bumped `refreshReqIdRef`. Returning `prev` in
          // that window prevents a brief flash of stale data before the newer
          // refresh's updater runs.
          setDirectoryInfo((prev) => {
            if (!isStillCurrent()) return prev;
            const base = prev
              ? mergeLazyChildren(data.tree, prev.tree)
              : data.tree;
            const merged = applyChildrenMap(base, updates);
            // Idempotent commit: most refreshes (fs watcher on a file-content
            // edit, `.git`/temp churn, a change inside a collapsed subtree, the
            // 120s poll, a tool-complete bump) leave the *displayed* tree
            // unchanged even though `dirTree()` returned fresh objects. Keeping
            // the previous reference when nothing visible changed stops
            // `visibleRows` / react-virtuoso from reconciling an identical list
            // — the "frequent flicker" users saw while files were being written.
            // `DirectoryTreeNode` has no volatile fields, so structural equality
            // == display equality; the depth-capped `summary` moves with the
            // skeleton, so when the tree is equal we reuse `prev.tree` (stable
            // rows) and only refresh the lightweight summary if it shifted.
            if (prev && treeNodeEqual(prev.tree, merged)) {
              const summarySame =
                prev.summary.totalFiles === data.summary.totalFiles &&
                prev.summary.totalDirs === data.summary.totalDirs &&
                prev.truncated === data.truncated &&
                prev.root === data.root;
              return summarySame ? prev : { ...data, tree: prev.tree };
            }
            return { ...data, tree: merged };
          });

          const newCount = data.tree?.children?.length || 0;
          if (newCount !== prevItemCountRef.current) {
            console.log(
              `[DirectoryPanel] Directory tree refreshed: ${newCount} items`,
            );
            prevItemCountRef.current = newCount;
          }
        } catch (err) {
          if (!isStillCurrent()) return;
          // PRD 0.2.7 Phase D: switching from sidecar HTTP to Rust invoke
          // means we no longer have to wait for sidecar readiness before
          // refreshing — Rust commands are always live. A failure here is
          // genuine (workspace deleted, permission denied, etc).
          setError(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.directory.errors.loadDirectoryFailed"),
          );
          console.error("[DirectoryPanel] Failed to refresh:", err);
        }
      })();
    }, [fileService]);

    // Debounced refresh — coalesces rapid triggers (file watcher + tool completion
    // can fire within 500ms of each other) into a single API call.
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = useCallback(() => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        rawRefresh();
      }, 300);
    }, [rawRefresh]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
      return () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      };
    }, []);

    // Stable ref for refresh to avoid timer recreation
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;

    // Helper to update a specific node in the tree
    const updateNodeInTree = useCallback(
      (
        nodes: DirectoryTreeNode[],
        targetPath: string,
        updater: (node: DirectoryTreeNode) => DirectoryTreeNode,
      ): DirectoryTreeNode[] => {
        return nodes.map((node) => {
          if (node.path === targetPath) {
            return updater(node);
          }
          if (node.children && node.type === "dir") {
            return {
              ...node,
              children: updateNodeInTree(node.children, targetPath, updater),
            };
          }
          return node;
        });
      },
      [],
    );

    // Expand a directory that hasn't been fully loaded
    const expandDir = useCallback(
      async (dirPath: string) => {
        // Use ref to check loading status (stable reference, avoids dependency issues)
        if (loadingDirsRef.current.has(dirPath)) return; // Already loading

        // Update both ref and state
        loadingDirsRef.current.add(dirPath);
        setLoadingDirs(new Set(loadingDirsRef.current));

        try {
          const result = await fileService.dirExpand({ path: dirPath });

          setDirectoryInfo((prev: DirectoryTree | null) => {
            if (!prev) return prev;
            const updatedChildren = updateNodeInTree(
              prev.tree.children ?? [],
              dirPath,
              (node) => ({
                ...node,
                children: result.children,
                loaded: result.loaded,
              }),
            );
            return {
              ...prev,
              tree: {
                ...prev.tree,
                children: updatedChildren,
              },
            };
          });
        } catch (err) {
          console.error("[DirectoryPanel] Failed to expand directory:", err);
        } finally {
          // Update both ref and state
          loadingDirsRef.current.delete(dirPath);
          setLoadingDirs(new Set(loadingDirsRef.current));
        }
      },
      [fileService, updateNodeInTree],
    );

    // Workspace-scoped interaction state must not leak across an agentDir
    // swap (a tab's agentDir is fixed today, but the journal/clipboard hold
    // WORKSPACE-RELATIVE paths — replaying them against another workspace
    // would move/trash same-named files in the wrong workspace).
    const prevAgentDirRef = useRef(agentDir);
    useEffect(() => {
      if (prevAgentDirRef.current === agentDir) return;
      prevAgentDirRef.current = agentDir;
      setClipboard(null);
      undoJournalRef.current = [];
      setFocusedPath(null);
      setEditing(null);
    }, [agentDir]);

    useEffect(() => {
      rawRefresh(); // Initial load — no debounce needed
      // Clear old branch first to avoid flash, then fetch new
      setGitBranch(null);
      fileService.gitBranch()
        .then((data) => setGitBranch(data.branch))
        .catch(() => setGitBranch(null));
    }, [agentDir, fileService, rawRefresh]);

    // Respond to external refresh trigger (parent-driven, e.g. tool completion
    // fast-path). Uses debounced refresh to coalesce rapid triggers.
    useEffect(() => {
      if (refreshTrigger && refreshTrigger > 0) {
        refresh();
      }
    }, [refreshTrigger, refresh]);

    // PRD 0.2.7 Phase D: Tauri-side workspace fs watcher. The hook owns the
    // token lifecycle; this panel interprets the coarse signal as "refresh the
    // tree" and keeps the existing debounce.
    useEffect(() => {
      if (workspaceChangeSignal > 0) refreshRef.current();
    }, [workspaceChangeSignal]);

    // Safety-net polling: catch anything the file watcher might miss.
    // With the watcher active, this is a fallback — 120s is sufficient.
    useEffect(() => {
      const interval = setInterval(() => refreshRef.current(), 120_000);
      return () => clearInterval(interval);
    }, []);

    // Vertical divider drag handler (tree ↔ capabilities)
    const handleCapDividerMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingCapRef.current = true;
      const startY = e.clientY;
      const startRatio = capRatioRef.current;
      const containerHeight = (
        e.currentTarget.parentElement as HTMLElement
      ).getBoundingClientRect().height;
      if (containerHeight <= 0) return; // Guard against zero-height container (collapsed/hidden)

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDraggingCapRef.current) return;
        const dy = ev.clientY - startY;
        // dy > 0 = mouse moves down = capabilities shrinks
        const newRatio = Math.max(
          0.15,
          Math.min(0.65, startRatio - dy / containerHeight),
        );
        setCapRatio(newRatio);
      };
      const onMouseUp = () => {
        isDraggingCapRef.current = false;
        capDragMoveRef.current = null;
        capDragUpRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      capDragMoveRef.current = onMouseMove;
      capDragUpRef.current = onMouseUp;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    }, []); // stable — uses refs

    // Cleanup cap drag listeners on unmount (match Chat.tsx pattern: reset body styles too)
    useEffect(() => {
      return () => {
        if (capDragMoveRef.current)
          document.removeEventListener("mousemove", capDragMoveRef.current);
        if (capDragUpRef.current)
          document.removeEventListener("mouseup", capDragUpRef.current);
        isDraggingCapRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }, []);

    const treeData = useMemo(() => {
      return directoryInfo?.tree.children ?? [];
    }, [directoryInfo]);
    const selectedPaths = useMemo(
      () => selectedNodes.map((node) => node.path),
      [selectedNodes],
    );
    const {
      closePath,
      getOpenPaths,
      getRangeSelection,
      getStickyAncestors,
      isOpen,
      items,
      nodeMetaByPath,
      openPath,
      togglePath,
      visibleRows,
    } = useWorkspaceTreeModel({
      loadingPaths: loadingDirs,
      rootChildren: treeData,
      selectedPaths,
      editing,
      // Restore the previously-expanded folders when the panel remounts (read
      // once on mount; see WorkspaceTreePersistedState).
      initialOpenPaths: persistedTreeStateRef?.current.openPaths,
    });
    const nodeMetaByPathRef = useRef(nodeMetaByPath);
    useEffect(() => {
      nodeMetaByPathRef.current = nodeMetaByPath;
    }, [nodeMetaByPath]);

    const waitForNodeMeta = useCallback(
      async (path: string, requestId: number) => {
        for (let attempt = 0; attempt < REVEAL_NODE_WAIT_FRAMES; attempt += 1) {
          if (requestId !== treeRevealRequestIdRef.current) {
            return { status: "cancelled" as const };
          }
          const meta = nodeMetaByPathRef.current.get(path);
          if (meta) {
            return { status: "found" as const, meta };
          }
          await waitForTreeFrame();
        }
        return { status: "missing" as const };
      },
      [treeRevealRequestIdRef],
    );

    const handleRevealSearchResultInTree = useCallback(
      async (path: string, options?: { silentIfMissing?: boolean }) => {
        const requestId = ++treeRevealRequestIdRef.current;
        const ancestors = ancestorDirectoryPaths(path);
        // "Missing" is a real error for search/chat reveals (the file should
        // exist), but expected noise for just-created files whose watcher
        // refresh is slow — those callers pass silentIfMissing.
        const reportMissing = () => {
          if (!options?.silentIfMissing) {
            toast.error(tRef.current("workspaceFiles.directory.toasts.fileMissing"));
          }
        };

        for (const ancestor of ancestors) {
          const result = await waitForNodeMeta(ancestor, requestId);
          if (result.status === "cancelled") {
            return;
          }
          if (result.status !== "found" || result.meta.data.type !== "dir") {
            reportMissing();
            return;
          }

          const meta = result.meta;
          openPath(ancestor);
          if (meta.data.loaded === false) {
            await expandDir(ancestor);
          }
          await waitForTreeFrame();
        }

        const targetResult = await waitForNodeMeta(path, requestId);
        if (targetResult.status === "cancelled") {
          return;
        }
        // Accept files AND dirs — search hits are files, but the chat path menu
        // can reveal a directory too (locate + select + scroll, no auto-expand).
        if (targetResult.status !== "found") {
          reportMissing();
          return;
        }

        setIsSearchMode(false);
        setSearchContextMenu(null);
        setContextMenu(null);
        setSelectedNodes([targetResult.meta.data]);
        lastClickedPathRef.current = path;
        setTreeRevealRequest({ id: requestId, path });
      },
      [
        expandDir,
        openPath,
        setIsSearchMode,
        setSearchContextMenu,
        setTreeRevealRequest,
        toast,
        treeRevealRequestIdRef,
        waitForNodeMeta,
      ],
    );

    // External reveal (chat path context menu → Chat → here). Fires once per id.
    // handleRevealSearchResultInTree polls for node meta, so this is robust even
    // when the panel was just mounted by opening the workspace (tree still loading).
    const lastExternalRevealIdRef = useRef<number | null>(null);
    useEffect(() => {
      if (!externalRevealRequest || lastExternalRevealIdRef.current === externalRevealRequest.id) {
        return;
      }
      lastExternalRevealIdRef.current = externalRevealRequest.id;
      // Kick off the reveal (captures the path), then tell the host to clear the
      // request so a later panel reopen (which remounts this panel + resets the
      // dedup ref) doesn't replay this stale reveal.
      void handleRevealSearchResultInTree(externalRevealRequest.path);
      onExternalRevealHandled?.(externalRevealRequest.id);
    }, [externalRevealRequest, onExternalRevealHandled, handleRevealSearchResultInTree]);
    // Bridge: `rawRefresh` (declared above `useWorkspaceTreeModel`) reads
    // expansion state through this ref. Mirror via useEffect so we don't
    // write a ref during render — matches the project's other ref-mirror
    // sites (toastRef, onSavedRef, etc). Also mirror into the per-tab persisted
    // ref so the open set survives unmount/remount (getOpenPaths identity
    // changes on every expand/collapse, so this captures the latest set).
    useEffect(() => {
      getOpenPathsRef.current = getOpenPaths;
      if (persistedTreeStateRef) {
        persistedTreeStateRef.current.openPaths = new Set(getOpenPaths());
      }
    }, [getOpenPaths, persistedTreeStateRef]);

    // Mirror the loaded tree into the per-tab persisted ref so reopening the
    // panel restores it instantly (the mount refresh then reconciles).
    useEffect(() => {
      if (persistedTreeStateRef) {
        persistedTreeStateRef.current.directoryInfo = directoryInfo;
      }
    }, [directoryInfo, persistedTreeStateRef]);

    // Pending-selection paths — used by 「新建笔记」 to keep the synthetic
    // newly-created file selected through the brief window between
    // `setSelectedNodes` and the watcher-driven tree refresh that surfaces
    // the file in `nodeMetaByPath`. Without this guard, the reconciliation
    // below would prune the synthetic node before the refresh resolves
    // (Codex round-4 caught). Pending paths auto-evict after 5 s — if the
    // file truly never materialises (deleted externally mid-creation), we
    // fall back to the normal filter behaviour.
    const pendingSelectionPathsRef = useRef<Set<string>>(new Set());
    const markPendingSelection = useCallback((path: string) => {
      pendingSelectionPathsRef.current.add(path);
      setTimeout(() => pendingSelectionPathsRef.current.delete(path), 5000);
    }, []);

    useEffect(() => {
      setSelectedNodes((prev) => {
        const pending = pendingSelectionPathsRef.current;
        const next = prev.filter((node) =>
          nodeMetaByPath.has(node.path) || pending.has(node.path),
        );
        // Once a pending path materialises in nodeMetaByPath, drop it from
        // pending — the real node has taken over.
        for (const p of Array.from(pending)) {
          if (nodeMetaByPath.has(p)) pending.delete(p);
        }
        return next.length === prev.length ? prev : next;
      });
      if (
        lastClickedPathRef.current &&
        !nodeMetaByPath.has(lastClickedPathRef.current)
      ) {
        lastClickedPathRef.current = null;
      }
      // Keyboard focus and an in-flight rename must not point at vanished
      // nodes (deleted externally / refresh pruned them).
      setFocusedPath((prev) =>
        prev && !nodeMetaByPath.has(prev) && !pendingSelectionPathsRef.current.has(prev)
          ? null
          : prev,
      );
      setEditing((prev) =>
        prev?.mode === "rename" && !nodeMetaByPath.has(prev.path) ? null : prev,
      );
    }, [nodeMetaByPath]);

    const handlePreview = useCallback(async (node: DirectoryTreeNode) => {
      if (node.type !== "file") return;

      const myReq = ++previewReqIdRef.current;
      setIsPreviewLoading(true);

      try {
        const payload = await fileService.readPreview({ path: node.path });
        if (myReq !== previewReqIdRef.current) return; // superseded by newer click
        const fileData = { ...payload, path: node.path };
        if (onFilePreviewExternal) {
          onFilePreviewExternal(fileData);
        } else {
          setPreview(fileData);
          setPreviewError(null);
        }
      } catch (err) {
        if (myReq !== previewReqIdRef.current) return; // superseded; don't toast/commit stale error
        if (onFilePreviewExternal) {
          toast.error(tRef.current("workspaceFiles.directory.toasts.previewFailed"));
        } else {
          setPreview(null);
          setPreviewError(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.directory.toasts.previewFailed"),
          );
        }
      } finally {
        // Only the latest request controls the loading indicator. Stale
        // finalizers (a slow earlier request finishing after a newer one) skip
        // the setter so the UI keeps reflecting the fresh in-flight request.
        if (myReq === previewReqIdRef.current) setIsPreviewLoading(false);
      }
    }, [fileService, onFilePreviewExternal, toast]);

    /** Route a rich document (pdf/docx/xlsx/xls/pptx) to the read-only viewer.
     *  Unlike handlePreview, this does NOT call readPreview (binary → UTF-8
     *  fail) and does NOT fetch bytes here — RichDocViewer fetches them. The
     *  reqId bump invalidates any in-flight text/image preview so its async
     *  result can't stomp this one (and won't reset isPreviewLoading, so we
     *  clear it ourselves). */
    const handleRichDocPreview = useCallback((node: DirectoryTreeNode) => {
      if (node.type !== "file") return;
      const richDocKind = getRichDocKind(node.name);
      if (!richDocKind) return;
      previewReqIdRef.current++;
      // Clear loading regardless of branch: the reqId bump above means a prior
      // in-flight text/image preview's finally won't reset it, and the external
      // (split-view) branch must leave the state machine consistent too.
      setIsPreviewLoading(false);
      const fileData = {
        name: node.name,
        content: "",
        size: 0, // non-load-bearing for rich docs; RichDocViewer fetches bytes
        path: node.path,
        richDocKind,
      };
      if (onFilePreviewExternal) {
        onFilePreviewExternal(fileData);
      } else {
        setPreview(fileData);
        setPreviewError(null);
      }
    }, [onFilePreviewExternal]);

    /** Route a FILE node to the right preview (image / rich doc / text) —
     *  shared by row clicks and keyboard Enter. */
    const previewNode = useCallback(
      async (data: DirectoryTreeNode) => {
        if (isImageFile(data.name)) {
          // Image branch — same latest-wins pattern as handleImagePreview.
          // We don't delegate to it because this branch also drives
          // `isPreviewLoading` (for the inline modal's loading indicator),
          // which `handleImagePreview` doesn't touch.
          const myReq = ++previewReqIdRef.current;
          setIsPreviewLoading(true);
          try {
            const result = await fileService.downloadFile({ path: data.path });
            if (myReq !== previewReqIdRef.current) return;
            const dataUrl = `data:${result.mimeType};base64,${result.data}`;
            openPreview(dataUrl, data.name);
          } catch (err) {
            if (myReq !== previewReqIdRef.current) return;
            console.error("[DirectoryPanel] Failed to load image:", err);
            toast.error(tRef.current("workspaceFiles.directory.toasts.imageLoadFailed"));
          } finally {
            if (myReq === previewReqIdRef.current) {
              setIsPreviewLoading(false);
            }
          }
        } else if (isRichDocPreviewable(data.name)) {
          handleRichDocPreview(data);
        } else if (isPreviewable(data.name)) {
          void handlePreview(data);
        } else {
          toast.info(tRef.current("workspaceFiles.directory.toasts.unsupportedPreview"));
        }
      },
      [fileService, handlePreview, handleRichDocPreview, openPreview, toast],
    );

    const handleSearchItemClick = useCallback(
      async (path: string, focusTarget?: FilePreviewFocusTarget) => {
        const myReq = ++previewReqIdRef.current;
        setIsPreviewLoading(true);
        try {
          const payload = await fileService.readPreview({ path });
          if (myReq !== previewReqIdRef.current) return; // superseded
          const initialEditMode = !!focusTarget && isMarkdownFile(payload.name);
          const fileData = {
            ...payload,
            path,
            initialLineNumber: focusTarget?.lineNumber,
            focusTarget,
            initialEditMode,
          };
          if (onFilePreviewExternal) {
            onFilePreviewExternal(
              fileData,
              initialEditMode ? { initialEditMode: true } : undefined,
            );
          } else {
            setPreview(fileData);
            setPreviewError(null);
          }
        } catch (err) {
          if (myReq !== previewReqIdRef.current) return; // superseded
          if (onFilePreviewExternal) {
            toast.error(tRef.current("workspaceFiles.directory.toasts.previewFailed"));
          } else {
            setPreview(null);
            setPreviewError(
              err instanceof Error
                ? err.message
                : tRef.current("workspaceFiles.directory.toasts.previewFailed"),
            );
          }
        } finally {
          if (myReq === previewReqIdRef.current) setIsPreviewLoading(false);
        }
      },
      [fileService, onFilePreviewExternal, toast],
    );

    const createSearchFocusTarget = useCallback(
      (
        lineNumber: number,
        highlights?: [number, number][],
      ): FilePreviewFocusTarget => ({
        requestId: ++previewFocusRequestIdRef.current,
        lineNumber,
        query: debouncedSearchQuery.trim() || undefined,
        highlights,
      }),
      [debouncedSearchQuery],
    );

    const handlePreviewSearchHit = useCallback(
      (hit: FileSearchHit, match?: FileMatchLine) => {
        const targetLine = match?.lineNumber ?? firstMatchLine(hit);
        if (targetLine) {
          const focusTarget = createSearchFocusTarget(
            targetLine,
            match?.highlights ?? hit.matches[0]?.highlights,
          );
          setActiveSearchTarget({
            kind: "match",
            path: hit.path,
            lineNumber: targetLine,
            requestId: focusTarget.requestId,
          });
          void handleSearchItemClick(hit.path, focusTarget);
        } else {
          setActiveSearchTarget({ kind: "file", path: hit.path });
          void handleSearchItemClick(hit.path);
        }
      },
      [createSearchFocusTarget, handleSearchItemClick, setActiveSearchTarget],
    );

    const handleImagePreview = async (node: DirectoryTreeNode) => {
      if (node.type !== "file") return;
      const myReq = ++previewReqIdRef.current;
      try {
        // PRD 0.2.7 Phase D: pre-migration this fetched the sidecar's
        // /agent/download via Rust proxy, then converted the response Blob
        // to a data URL. Rust now returns base64 directly so we skip the
        // FileReader trip — `data:<mime>;base64,<body>` is the same thing
        // FileReader.readAsDataURL would have produced.
        const result = await fileService.downloadFile({ path: node.path });
        if (myReq !== previewReqIdRef.current) return; // superseded
        const dataUrl = `data:${result.mimeType};base64,${result.data}`;
        openPreview(dataUrl, node.name);
      } catch (err) {
        if (myReq !== previewReqIdRef.current) return; // superseded
        console.error("[DirectoryPanel] Failed to load image:", err);
        toast.error(tRef.current("workspaceFiles.directory.toasts.imageLoadFailed"));
      }
    };

    // Pre-PRD-0.2.7: a hidden <input type="file" multiple> fed File objects
    // here, which we wrapped in FormData and POSTed to /agent/import (cap
    // 500MB, streamed to disk by the sidecar). Tauri's IPC isn't built for
    // 500MB base64 payloads — encoding inflates ~33% AND we need to fit the
    // whole payload in renderer memory + IPC channel before Rust touches the
    // disk. Cross-review caught: the migration removed the 500MB cap without
    // adding a renderer-side equivalent, so picking a 4GB video would lock
    // up the renderer building the base64 string. We enforce a per-batch
    // size cap on the renderer side as a guardrail. Files needing larger
    // upload are expected to come through the path-based drag-drop flow
    // (handleTauriFileDrop → copyPaths) which has no IPC payload concern.
    const handleImport = async (files: FileList | null) => {
      if (!files || files.length === 0 || isUploading) return;
      const MAX_BATCH_BYTES = 100 * 1024 * 1024; // 100MB renderer cap
      const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_BATCH_BYTES) {
        const maxMb = MAX_BATCH_BYTES / 1024 / 1024;
        const currentMb = Math.round(totalBytes / 1024 / 1024);
        setError(
          tRef.current("workspaceFiles.directory.errors.batchUploadTooLarge", {
            maxMb,
            currentMb,
          }),
        );
        return;
      }
      setIsUploading(true);
      try {
        const base64Files = await Promise.all(
          Array.from(files).map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          })),
        );
        const result = await fileService.importBase64Files({
          files: base64Files,
          targetDir: importTargetDir || undefined,
        });
        if (!result.success) {
          throw new Error(tRef.current("workspaceFiles.directory.errors.importFailed"));
        }
        refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.importFailed"),
        );
      } finally {
        setIsUploading(false);
        setImportTargetDir("");
      }
    };

    // Helper function to convert File to base64
    const fileToBase64 = useCallback((file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix (e.g., "data:application/pdf;base64,")
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }, []);

    // External file drag-drop (browser File objects → no path → base64 path).
    const handleExternalFileDrop = useCallback(
      async (files: File[], targetDir: string = "") => {
        if (files.length === 0 || isUploading) {
          return;
        }
        setIsUploading(true);
        try {
          const base64Files = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              content: await fileToBase64(file),
            })),
          );
          const result = await fileService.importBase64Files({
            files: base64Files,
            targetDir: targetDir || undefined,
          });
          if (!result.success) {
            throw new Error(tRef.current("workspaceFiles.directory.errors.importFailed"));
          }
          refresh();
        } catch (err) {
          console.error("[DirectoryPanel] File upload error:", err);
          setError(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.directory.errors.importFailed"),
          );
        } finally {
          setIsUploading(false);
        }
      },
      [isUploading, refresh, fileService, fileToBase64],
    );

    // Tauri drag-drop (real OS paths → cp directly, no base64).
    const handleTauriFileDrop = useCallback(
      async (paths: string[], targetDir: string = "") => {
        if (paths.length === 0 || isUploading) {
          return;
        }
        setIsUploading(true);
        try {
          const result = await fileService.copyPaths({
            sourcePaths: paths,
            targetDir,
            autoRename: true,
          });
          if (!result.success) {
            throw new Error(tRef.current("workspaceFiles.directory.errors.copyFailed"));
          }
          // Per-file failures (blacklist reject, fs error) — surface like the
          // internal paste path does, instead of a silent no-op refresh.
          if (result.errors.length > 0) {
            toast.warning(
              tRef.current("workspaceFiles.directory.toasts.partialImportFailed", {
                error: result.errors[0],
              }),
            );
          }
          if (isDebugMode()) {
            console.log(
              "[DirectoryPanel] Tauri drop copied files:",
              result.copiedFiles,
            );
          }
          refresh();
        } catch (err) {
          console.error("[DirectoryPanel] Tauri file drop error:", err);
          setError(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.directory.errors.copyFailed"),
          );
        } finally {
          setIsUploading(false);
        }
      },
      [isUploading, refresh, fileService, toast],
    );

    // Expose imperative handle for parent to call
    useImperativeHandle(
      ref,
      () => ({
        handleFileDrop: async (
          paths: string[],
          position?: { x: number; y: number },
        ) => {
          let targetDir = "";
          const hitEl = position
            ? document
                .elementFromPoint(position.x, position.y)
                ?.closest?.("[data-tree-path]")
            : null;
          if (position) {
            // Desktop path: Tauri intercepts OS drags (HTML5 drag events never
            // fire), so the row-level targeting can't run — resolve from the
            // element under the DROP position instead. Pre-fix this used the
            // CURRENT SELECTION, so "dropping onto folder A" imported into
            // whatever was selected (or the root), regardless of the pointer.
            targetDir = resolveExternalDropDir(
              hitEl?.getAttribute("data-tree-path") ?? null,
              nodeMetaByPath,
            );
          } else {
            // No position (browser dev mode) — fall back to the selection
            // heuristic.
            const firstSelected = selectedNodes[0];
            if (firstSelected) {
              if (firstSelected.type === "dir") {
                targetDir = firstSelected.path;
              } else {
                const parts = firstSelected.path.split("/");
                parts.pop();
                targetDir = parts.join("/");
              }
            }
          }
          await handleTauriFileDrop(paths, targetDir);
        },
        refresh,
      }),
      [selectedNodes, handleTauriFileDrop, refresh, nodeMetaByPath],
    );

    // Check if a drag event contains external files
    const isExternalFileDrag = useCallback((e: React.DragEvent): boolean => {
      const types = e.dataTransfer?.types ?? [];
      return types.includes("Files");
    }, []);

    // Tree container drag handlers
    const handleTreeDragEnter = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!isExternalFileDrag(e)) {
          return;
        }

        dragCounterRef.current++;
        if (dragCounterRef.current === 1) {
          setIsExternalDrop(true);
        }
      },
      [isExternalFileDrag],
    );

    // Resolve the target dir of an external (HTML5) drag from whatever tree
    // element sits under the pointer. Attribute-based so it uniformly covers
    // tree rows AND sticky breadcrumb rows (both carry `data-tree-path`):
    // dir → itself, file → its parent, blank space → workspace root.
    const externalDropDirFromEventTarget = useCallback(
      (e: React.DragEvent): string => {
        const el = (e.target as HTMLElement).closest?.("[data-tree-path]");
        return resolveExternalDropDir(
          el?.getAttribute("data-tree-path") ?? null,
          nodeMetaByPath,
        );
      },
      [nodeMetaByPath],
    );

    const handleTreeDragOver = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!isExternalFileDrag(e)) return;

        e.dataTransfer.dropEffect = "copy";
        // Re-resolve continuously from the element under the pointer. The
        // previous enter/leave bookkeeping let the last-highlighted folder
        // stay the target when the pointer moved onto a file row or blank
        // space — the drop landed somewhere the pointer wasn't.
        const next = externalDropDirFromEventTarget(e);
        setDropTargetPath((prev) => (prev === next ? prev : next));
      },
      [externalDropDirFromEventTarget, isExternalFileDrag],
    );

    const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsExternalDrop(false);
        setDropTargetPath(null);
      }
    }, []);

    const handleTreeDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounterRef.current = 0;
        setIsExternalDrop(false);
        setDropTargetPath(null);

        // Resolve at DROP time from the element under the pointer — never
        // trust the (state-lagged) hover highlight for the actual write.
        const targetPath = externalDropDirFromEventTarget(e);

        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) {
          if (isDebugMode()) {
            console.log(
              "[DirectoryPanel] Dropped",
              files.length,
              "files to:",
              targetPath || "root",
            );
          }
          void handleExternalFileDrop(files, targetPath);
        }
      },
      [externalDropDirFromEventTarget, handleExternalFileDrop],
    );

    /** Silent auto-rename policy (用户决策 2026-06-11): collisions never
     *  block with a dialog — Rust renames (`a_1.txt` / `a (1).txt`) and we
     *  TELL the user via toast so the rename is no longer invisible. */
    const notifyAutoRenames = useCallback(
      (pairs: Array<{ from: string; to: string }>) => {
        if (pairs.length === 0) return;
        if (pairs.length === 1) {
          toast.info(
            tRef.current("workspaceFiles.directory.toasts.autoRenamedOne", {
              from: pairs[0].from,
              to: pairs[0].to,
            }),
          );
        } else {
          toast.info(
            tRef.current("workspaceFiles.directory.toasts.autoRenamedMany", {
              count: pairs.length,
            }),
          );
        }
      },
      [toast],
    );

    // Move handler (used by internal DnD, cut-paste and context menu).
    // Cross-review caught: pre-fix this ignored `result.errors`, so partial
    // failures (3 of 5 files moved, 2 errored due to permission / collision
    // exhaustion) silently dropped on the floor — user saw 2 files vanish
    // with no feedback. Surface partial failures via toast so the user knows
    // why some moves didn't happen.
    const handleMove = useCallback(
      async (sourcePaths: string[], targetDir: string) => {
        try {
          const result = await fileService.movePaths({ sourcePaths, targetDir });
          if (result.errors && result.errors.length > 0) {
            const moved = result.movedFiles?.length ?? 0;
            toast.warning(
              tRef.current("workspaceFiles.directory.toasts.movePartial", {
                moved,
                failed: result.errors.length,
                error: result.errors[0],
              }),
            );
          }
          if (result.movedFiles && result.movedFiles.length > 0) {
            undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
              kind: "move",
              moves: result.movedFiles.map((m) => ({
                from: m.oldPath,
                to: m.newPath,
              })),
            });
            notifyAutoRenames(
              result.movedFiles
                .filter((m) => baseNameOf(m.oldPath) !== baseNameOf(m.newPath))
                .map((m) => ({
                  from: baseNameOf(m.oldPath),
                  to: baseNameOf(m.newPath),
                })),
            );
          }
          refresh();
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.directory.errors.moveFailed"),
          );
        }
      },
      [fileService, notifyAutoRenames, refresh, toast],
    );

    // --- Internal DnD via @dnd-kit (pointer-events based, reliable in Tauri WebView) ---
    const updateDropTarget = useCallback((val: string | null) => {
      internalDropTargetRef.current = val;
      setInternalDropTarget(val);
    }, []);

    const clearAutoExpandTimer = useCallback(() => {
      if (autoExpandTimerRef.current !== null) {
        clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    }, []);

    // Lookup map for hit-testing during drag
    const nodeByPath = useMemo(() => {
      const map = new Map<string, DirectoryTreeNode>();
      for (const [path, meta] of nodeMetaByPath) {
        map.set(path, meta.data);
      }
      return map;
    }, [nodeMetaByPath]);

    const dndSensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );

    // Pointer-based collision with explicit z-order arbitration. `pointerWithin`
    // (vs the default rect-intersection) keys the target to where the POINTER
    // is, not where the floating overlay's rectangle happens to overlap —
    // rect-intersection made the highlight flip between adjacent folders
    // while dragging (the "拖拽晃动" jitter). pointerWithin is geometric, not
    // a DOM hit-test, so stacking must be arbitrated here:
    //   1. STICKY breadcrumb rows beat everything — they visually COVER the
    //      rows underneath, which are still registered droppables; without
    //      this, dropping "on the breadcrumb folder" landed in an invisible
    //      covered row.
    //   2. Tree rows beat the viewport-wide root zone (which geometrically
    //      contains every row).
    const dndCollisionDetection: CollisionDetection = useCallback((args) => {
      const within = pointerWithin(args);
      const stickyHits = within.filter((c) =>
        String(c.id).startsWith(STICKY_DROP_PREFIX),
      );
      if (stickyHits.length > 0) return stickyHits;
      const rowHits = within.filter((c) => c.id !== ROOT_DROP_ID);
      return rowHits.length > 0 ? rowHits : within;
    }, []);

    const handleDndDragStart = useCallback(
      (event: DragStartEvent) => {
        const data = event.active.data.current as DirectoryTreeNode | undefined;
        if (!data) return;
        // Multi-select: if dragged item is selected and there are multiple selections, drag all
        const paths =
          selectedNodes.some((n) => n.path === data.path) &&
          selectedNodes.length > 1
            ? selectedNodes.map((n) => n.path)
            : [data.path];
        const icon = data.type === "dir" ? Folder : getFileIcon(data.name);
        activeDragPathsRef.current = paths;
        setActiveDragItem({ paths, name: data.name, icon });
      },
      [selectedNodes],
    );

    const handleDndDragOver = useCallback(
      (event: DragOverEvent) => {
        // All target semantics live in the pure resolver: dir row → itself,
        // FILE row → its parent dir, root zone → "", outside the tree → null
        // (no drop). Pre-fix `over=null` was treated as "root", so releasing
        // over a file row or outside the panel silently moved items to the
        // workspace root.
        const overId = event.over ? String(event.over.id) : null;
        const target = resolveInternalDropTarget(
          overId,
          activeDragPathsRef.current,
          nodeMetaByPath,
        );
        if (internalDropTargetRef.current === target) return;
        updateDropTarget(target);
        clearAutoExpandTimer();
        if (!target) return; // null (no drop) or "" (root — nothing to expand)
        const meta = nodeMetaByPath.get(target);
        if (meta?.data.type !== "dir") return;
        // Auto-expand closed folder after 600ms hover
        autoExpandTimerRef.current = setTimeout(() => {
          if (meta.data.loaded === false) {
            void expandDir(target);
          }
          openPath(target);
        }, 600);
      },
      [updateDropTarget, clearAutoExpandTimer, nodeMetaByPath, expandDir, openPath],
    );

    const handleDndDragEnd = useCallback(
      (_event: DragEndEvent) => {
        const dragItem = activeDragItem;
        const targetPath = internalDropTargetRef.current;
        // Clean up state first
        setActiveDragItem(null);
        activeDragPathsRef.current = [];
        updateDropTarget(null);
        clearAutoExpandTimer();

        if (!dragItem || targetPath === null) return;
        const sourcePaths = dragItem.paths;
        // Belt-and-suspenders: the resolver already refuses these targets.
        if (sourcePaths.includes(targetPath)) return;
        if (
          targetPath &&
          sourcePaths.some((p) => targetPath.startsWith(p + "/"))
        )
          return;
        void handleMove(sourcePaths, targetPath);
      },
      [activeDragItem, handleMove, updateDropTarget, clearAutoExpandTimer],
    );

    const handleDndDragCancel = useCallback(() => {
      setActiveDragItem(null);
      activeDragPathsRef.current = [];
      updateDropTarget(null);
      clearAutoExpandTimer();
    }, [updateDropTarget, clearAutoExpandTimer]);

    // Clean up auto-expand timer on unmount
    useEffect(() => clearAutoExpandTimer, [clearAutoExpandTimer]);

    // Keyboard paste handler (Cmd/Ctrl+V)
    useEffect(() => {
      const handlePaste = async (e: ClipboardEvent) => {
        // Check if DirectoryPanel is focused or its children
        if (
          !panelRef.current?.contains(document.activeElement) &&
          document.activeElement !== panelRef.current
        ) {
          return;
        }

        // Check if it's a text input/textarea - don't intercept paste there
        const activeElement = document.activeElement as HTMLElement;
        if (
          activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA"
        ) {
          return;
        }

        // INTERNAL file clipboard takes precedence. On macOS ⌘V arrives ONLY
        // as this paste event (the native Edit menu consumes the keydown), so
        // the tree's own paste must be served here — the key handler never
        // gets a chance.
        //
        // …unless the OS clipboard has moved on since our copy (screenshot,
        // Finder files, text copied elsewhere): then the internal clipboard
        // is STALE and must yield, or it shadows the user's newer content
        // forever with no hint (cross-review 0.2.33, cc W2). Judged by
        // comparing e.clipboardData's text against the text we wrote
        // alongside the copy; null record = can't judge → internal wins.
        if (
          clipboardRef.current &&
          treeContainerRef.current?.contains(document.activeElement)
        ) {
          const lastWritten = lastOsClipboardTextRef.current;
          const osTextNow = e.clipboardData?.getData("text/plain") ?? "";
          if (lastWritten === null || osTextNow === lastWritten) {
            e.preventDefault();
            void pasteFromClipboardRef.current();
            return;
          }
          // Stale → drop it and fall through to the OS-clipboard file path.
          setClipboard(null);
          clipboardRef.current = null;
        }

        const items = e.clipboardData?.items;
        if (!items) {
          return;
        }

        const files: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) {
              files.push(file);
            }
          }
        }

        if (files.length === 0) {
          // Cmd+V reached the tree but NEITHER clipboard has files. Say so —
          // the silent path is exactly how a swallowed Cmd+C (tree wasn't
          // focused / embedded browser ate the keys) turns into an
          // unexplainable "粘贴没反应" (实测 2026-06-11).
          if (treeContainerRef.current?.contains(document.activeElement)) {
            toast.info(
              tRef.current("workspaceFiles.directory.toasts.clipboardNoFiles", {
                shortcut: copyShortcut,
              }),
            );
          }
          return;
        }

        e.preventDefault();

        // Determine target directory based on selection (use first selected item)
        let targetDir = "";
        const firstSelected = selectedNodes[0];
        if (firstSelected) {
          if (firstSelected.type === "dir") {
            targetDir = firstSelected.path;
          } else {
            // For files, use parent directory
            const parts = firstSelected.path.split("/");
            parts.pop();
            targetDir = parts.join("/");
          }
        }

        if (isDebugMode()) {
          console.log(
            "[DirectoryPanel] Pasting",
            files.length,
            "files to:",
            targetDir || "root",
          );
        }
        await handleExternalFileDrop(files, targetDir);
      };

      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }, [selectedNodes, handleExternalFileDrop, toast, copyShortcut]);

    const handleOpenInFinder = async (path: string) => {
      try {
        await fileService.openInFinder({ path });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.openFailed"),
        );
      }
    };

    const handleOpenSearchResultInFinder = async (path: string) => {
      try {
        await fileService.openInFinder({ path });
      } catch {
        toast.error(tRef.current("workspaceFiles.common.openFolderFailed"));
      }
    };

    const handleOpenWithDefault = async (path: string) => {
      try {
        await fileService.openWithDefault({ path });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.openFailed"),
        );
      }
    };

    // Tree node paths are workspace-relative (Rust `tree.rs` emits the relative
    // path; root node is ""). Join with the absolute `agentDir` to get the real
    // filesystem path users expect from "copy path". Mirrors Chat.tsx's join.
    const toAbsolutePath = useCallback(
      (relPath: string): string => {
        if (!agentDir) return relPath;
        if (!relPath) return agentDir;
        const sep = agentDir.includes("\\") ? "\\" : "/";
        return `${agentDir}${sep}${relPath}`;
      },
      [agentDir],
    );

    const handleCopyPath = (relPath: string, labelKey: string) => {
      copyPlainText(toAbsolutePath(relPath))
        .then(() => toast.success(tRef.current(labelKey)))
        .catch(() => toast.error(tRef.current("workspaceFiles.common.copyFailed")));
    };

    const getSearchResultContextMenuItems = (
      hit: FileSearchHit,
    ): ContextMenuItem[] => [
      {
        label: t("workspaceFiles.common.preview"),
        icon: <Eye className="h-4 w-4" />,
        onClick: () => handlePreviewSearchHit(hit),
      },
      {
        label: t("workspaceFiles.common.revealInTree"),
        icon: <LocateFixed className="h-4 w-4" />,
        onClick: () => void handleRevealSearchResultInTree(hit.path),
      },
      {
        label: t("workspaceFiles.common.openContainingFolder"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => void handleOpenSearchResultInFinder(hit.path),
      },
    ];

    const handleDelete = async (path: string) => {
      try {
        const result = await fileService.deleteFile({ path });
        if (result.deleted) {
          toast.success(tRef.current("workspaceFiles.common.trashMoved"));
        }
        refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.deleteFailed"),
        );
      }
    };

    /** Select + reveal a freshly-created file/folder. The synthetic node keeps
     *  the selection highlighted before the watcher-driven refresh surfaces
     *  the real node (`markPendingSelection` protects it from the
     *  reconciliation effect); the reveal expands ancestors and scrolls it
     *  into view — without it, creating inside a COLLAPSED folder gave no
     *  visible feedback and read as "the file went to the root". */
    const selectAndRevealCreated = useCallback(
      (relPath: string, type: "file" | "dir") => {
        markPendingSelection(relPath);
        setSelectedNodes([
          {
            id: relPath,
            name: relPath.split("/").pop() ?? relPath,
            path: relPath,
            type,
          },
        ]);
        lastClickedPathRef.current = relPath;
        setFocusedPath(relPath);
        // silentIfMissing: creation already succeeded — a slow watcher refresh
        // must not surface a scary "文件不存在或已删除" toast.
        void handleRevealSearchResultInTree(relPath, { silentIfMissing: true });
      },
      [markPendingSelection, handleRevealSearchResultInTree],
    );

    /** 「新建笔记」: pick the next free `note-YYYYMMDDHHMM[-N].md` slot in
     *  `parentDir`, create it empty, then open the preview directly in
     *  edit mode (Obsidian-like quick-capture flow). Local time — the
     *  user expects "now" to be wall-clock now, not UTC.
     *
     *  Collision handling: probe up to 30 candidates via `checkPaths`
     *  (single batched invoke), pick the first free one. The cap is
     *  arbitrary but well above any plausible "I created 30 notes in one
     *  minute" workflow; treats overflow as an error toast rather than
     *  silently dropping the click. */
    const handleNewNote = async (parentDir: string) => {
      if (!fileService.isAvailable) return;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}`;
      const baseStem = `note-${stamp}`;
      const candidates = [
        `${baseStem}.md`,
        ...Array.from({ length: 29 }, (_, i) => `${baseStem}-${i + 2}.md`),
      ];
      const probePaths = candidates.map((n) =>
        parentDir ? `${parentDir}/${n}` : n,
      );
      try {
        const probe = await fileService.checkPaths({ paths: probePaths });
        // Race-resilient creation: walk candidates in order, skip those
        // already known occupied, and on `newFile` "already exists" race
        // (another caller took the slot between probe and create — Codex
        // round-4 caught) fall through to the next candidate. In the
        // common case this is exactly one `newFile` call.
        let createdPath: string | null = null;
        let filename: string | null = null;
        for (let i = 0; i < candidates.length; i++) {
          if (probe.results[probePaths[i]]?.exists) continue;
          const candidate = candidates[i];
          try {
            const created = await fileService.newFile({
              parentDir,
              name: candidate,
            });
            createdPath = created.path;
            filename = candidate;
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/already exists/i.test(msg)) continue; // race — try next
            throw e;
          }
        }
        if (!createdPath || !filename) {
          setError(tRef.current("workspaceFiles.directory.errors.tooManyNotes"));
          return;
        }

        undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
          kind: "create",
          paths: [createdPath],
        });

        // Watcher refresh will surface the new file; we also kick a manual
        // refresh so the highlight + selection are immediate.
        refresh();

        // Select + expand ancestors + scroll into view. Creating inside a
        // COLLAPSED folder previously gave no visible feedback in the tree,
        // which users read as "the note went to the root".
        selectAndRevealCreated(createdPath, "file");

        // Open preview in edit mode. Split-view (Chat) routes via the
        // external callback; otherwise open the inline modal.
        const previewFile = {
          name: filename,
          content: "",
          size: 0,
          path: createdPath,
        };
        if (onFilePreviewExternal) {
          onFilePreviewExternal(previewFile, { initialEditMode: true });
        } else {
          setPreview({ ...previewFile, initialEditMode: true });
          setPreviewError(null);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.createFailed"),
        );
      }
    };

    /** Sibling names of `parentDir`'s current children — live collision
     *  feedback for the inline editor. Rust stays authoritative. */
    const siblingNamesOf = useCallback(
      (parentDir: string, excludeName?: string): Set<string> => {
        const children =
          parentDir === ""
            ? treeData
            : (nodeMetaByPath.get(parentDir)?.data.children ?? []);
        const names = new Set(children.map((c) => c.name));
        if (excludeName) names.delete(excludeName);
        return names;
      },
      [treeData, nodeMetaByPath],
    );

    /** F2 / context-menu rename → inline editor replacing the row in place. */
    const startRename = useCallback(
      (path: string) => {
        const meta = nodeMetaByPath.get(path);
        if (!meta) return;
        setContextMenu(null);
        setEditing({
          mode: "rename",
          path,
          initialName: meta.data.name,
          isDir: meta.data.type === "dir",
          siblingNames: siblingNamesOf(meta.parentPath ?? "", meta.data.name),
        });
      },
      [nodeMetaByPath, siblingNamesOf],
    );

    /** 新建文件/新建文件夹 → inline editor as the parent's first child. */
    const startCreate = useCallback(
      (parentDir: string, mode: "create-file" | "create-folder") => {
        setContextMenu(null);
        if (parentDir) {
          const meta = nodeMetaByPath.get(parentDir);
          if (!meta || meta.data.type !== "dir") return;
          openPath(parentDir);
          if (meta.data.loaded === false) void expandDir(parentDir);
        }
        setEditing({ mode, parentDir, siblingNames: siblingNamesOf(parentDir) });
      },
      [nodeMetaByPath, openPath, expandDir, siblingNamesOf],
    );

    const handleEditCancel = useCallback(() => {
      setEditing(null);
      treeContainerRef.current?.focus();
    }, []);

    const handleEditCommit = useCallback(
      async (name: string) => {
        const session = editing;
        if (!session) return;
        try {
          if (session.mode === "rename") {
            const result = await fileService.rename({
              oldPath: session.path,
              newName: name,
            });
            undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
              kind: "rename",
              from: session.path,
              to: result.newPath,
            });
            setEditing(null);
            markPendingSelection(result.newPath);
            setSelectedNodes([
              {
                id: result.newPath,
                name,
                path: result.newPath,
                type: session.isDir ? "dir" : "file",
              },
            ]);
            lastClickedPathRef.current = result.newPath;
            setFocusedPath(result.newPath);
          } else {
            const created =
              session.mode === "create-file"
                ? await fileService.newFile({
                    parentDir: session.parentDir,
                    name,
                  })
                : await fileService.newFolder({
                    parentDir: session.parentDir,
                    name,
                  });
            undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
              kind: "create",
              paths: [created.path],
            });
            setEditing(null);
            selectAndRevealCreated(
              created.path,
              session.mode === "create-file" ? "file" : "dir",
            );
          }
          refresh();
          treeContainerRef.current?.focus();
        } catch (err) {
          // Rust rejected (collision raced in, fs error). Close the editor —
          // its commit guard has already settled — and surface the reason.
          setEditing(null);
          toast.error(
            err instanceof Error
              ? err.message
              : tRef.current("workspaceFiles.common.operationFailed"),
          );
        }
      },
      [
        editing,
        fileService,
        markPendingSelection,
        refresh,
        selectAndRevealCreated,
        toast,
      ],
    );

    /** Cmd+C / Cmd+X — selection (or the focused row) onto the clipboard.
     *  ALWAYS confirms via toast: a Cmd+C swallowed by an unfocused tree /
     *  the embedded-browser OS webview is otherwise indistinguishable from
     *  success, and the user only finds out when Cmd+V silently does
     *  nothing (实测 2026-06-11). Also mirrors the absolute paths onto the
     *  OS clipboard so the copy is pasteable into a terminal / chat. */
    const copySelection = useCallback(
      (mode: "copy" | "cut", opts?: { skipAsyncOsWrite?: boolean }): string | null => {
        const nodes =
          selectedNodes.length > 0
            ? selectedNodes
            : focusedPath && nodeMetaByPath.has(focusedPath)
              ? [nodeMetaByPath.get(focusedPath)!.data]
              : [];
        if (nodes.length === 0) return null;
        setClipboard({ mode, paths: nodes.map((n) => n.path) });
        const actionKey =
          mode === "copy"
            ? "workspaceFiles.directory.toasts.copied"
            : "workspaceFiles.directory.toasts.cut";
        const what =
          nodes.length === 1
            ? tRef.current("workspaceFiles.directory.toasts.itemName", {
                name: nodes[0].name,
              })
            : tRef.current("workspaceFiles.directory.toasts.itemCount", {
                count: nodes.length,
              });
        toast.success(
          tRef.current("workspaceFiles.directory.toasts.copiedSelection", {
            action: tRef.current(actionKey),
            target: what,
            shortcut: pasteShortcut,
          }),
        );
        const osText = nodes.map((n) => toAbsolutePath(n.path)).join("\n");
        // The DOM copy/cut event path writes via the synchronous
        // e.clipboardData.setData and skips this async write — otherwise the
        // late-resolving writeText could clobber whatever the user copies in
        // the gap. Record the written text either way: paste compares it to
        // judge whether the internal clipboard has gone stale.
        if (opts?.skipAsyncOsWrite) {
          lastOsClipboardTextRef.current = osText;
        } else {
          void copyPlainText(osText)
            .then(() => {
              lastOsClipboardTextRef.current = osText;
            })
            .catch(() => {});
        }
        // Returned so the document `copy`/`cut` event handler can ALSO stuff
        // e.clipboardData synchronously (deterministic OS-clipboard write).
        return osText;
      },
      [selectedNodes, focusedPath, nodeMetaByPath, toAbsolutePath, toast, pasteShortcut],
    );

    /** Paste lands where a drop would: selected dir → itself, selected file →
     *  its parent, no selection → workspace root. */
    const pasteFromClipboard = useCallback(async () => {
      const clip = clipboard;
      if (!clip || clip.paths.length === 0) return;
      // Staleness guard for the keydown path (Win/Linux), which has no
      // ClipboardEvent to compare against — the macOS paste-event path
      // already checked synchronously in handlePaste. readText failure
      // (permission) → can't judge → internal clipboard stays authoritative.
      const lastWritten = lastOsClipboardTextRef.current;
      if (lastWritten !== null) {
        const osNow = await navigator.clipboard.readText().catch(() => null);
        if (osNow !== null && osNow !== lastWritten) {
          setClipboard(null);
          toast.info(
            tRef.current("workspaceFiles.directory.toasts.clipboardStale"),
          );
          return;
        }
      }
      const anchor =
        selectedNodes[0] ??
        (focusedPath ? nodeMetaByPath.get(focusedPath)?.data : undefined);
      const targetDir = !anchor
        ? ""
        : anchor.type === "dir"
          ? anchor.path
          : parentDirOfPath(anchor.path);
      try {
        if (clip.mode === "copy") {
          const result = await fileService.copyInternal({
            sourcePaths: clip.paths,
            targetDir,
          });
          if (result.errors.length > 0) {
            toast.warning(
              tRef.current("workspaceFiles.directory.toasts.pastePartialFailed", {
                error: result.errors[0],
              }),
            );
          }
          if (result.copiedFiles.length > 0) {
            undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
              kind: "copy",
              createdPaths: result.copiedFiles.map((f) => f.targetPath),
            });
            notifyAutoRenames(
              result.copiedFiles
                .filter((f) => f.renamed)
                .map((f) => ({
                  from: baseNameOf(f.sourcePath),
                  to: baseNameOf(f.targetPath),
                })),
            );
            const first = result.copiedFiles[0];
            const sourceType =
              nodeMetaByPath.get(first.sourcePath)?.data.type ?? "file";
            selectAndRevealCreated(first.targetPath, sourceType);
          }
        } else {
          // Cut → move; Rust skips already-in-target no-ops.
          const result = await fileService.movePaths({
            sourcePaths: clip.paths,
            targetDir,
          });
          if (result.errors && result.errors.length > 0) {
            toast.warning(
              tRef.current("workspaceFiles.directory.toasts.movePartialFailed", {
                error: result.errors[0],
              }),
            );
          }
          if (result.movedFiles.length > 0) {
            undoJournalRef.current = pushUndoEntry(undoJournalRef.current, {
              kind: "move",
              moves: result.movedFiles.map((m) => ({
                from: m.oldPath,
                to: m.newPath,
              })),
            });
            notifyAutoRenames(
              result.movedFiles
                .filter((m) => baseNameOf(m.oldPath) !== baseNameOf(m.newPath))
                .map((m) => ({
                  from: baseNameOf(m.oldPath),
                  to: baseNameOf(m.newPath),
                })),
            );
            const moved = result.movedFiles[0];
            const sourceType =
              nodeMetaByPath.get(moved.oldPath)?.data.type ?? "file";
            selectAndRevealCreated(moved.newPath, sourceType);
          }
          setClipboard(null);
        }
        refresh();
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.pasteFailed"),
        );
      }
    }, [
      clipboard,
      selectedNodes,
      focusedPath,
      nodeMetaByPath,
      fileService,
      notifyAutoRenames,
      refresh,
      selectAndRevealCreated,
      toast,
    ]);

    // Mirror the latest clipboard handlers into the early-declared refs used
    // by the document-level clipboard event listeners.
    useEffect(() => {
      copySelectionRef.current = copySelection;
      pasteFromClipboardRef.current = pasteFromClipboard;
      clipboardRef.current = clipboard;
    }, [copySelection, pasteFromClipboard, clipboard]);

    // Document-level `copy` / `cut` listeners — THE working path on macOS,
    // where the native Edit menu eats the ⌘C/⌘X keydown and only this DOM
    // event arrives (实测 2026-06-11: keydown-only made ⌘C silently dead on
    // macOS while ⌘V "worked" via the paste event). The keydown mapping in
    // handleTreeKeyDown stays for Windows/Linux; double-fire is impossible
    // because that path preventDefaults the key (suppressing the native copy
    // command) when it handles it.
    useEffect(() => {
      const handleClipboardEvent =
        (mode: "copy" | "cut") => (e: ClipboardEvent) => {
          const active = document.activeElement as HTMLElement | null;
          if (!treeContainerRef.current?.contains(active)) return;
          // The inline editor's input owns its own copy/cut.
          if (
            active &&
            (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
          ) {
            return;
          }
          // Yield to native copy ONLY for a text selection INSIDE the tree
          // (practically impossible — rows are select-none). Same rule as the
          // keydown path below: a stale selection in ANOTHER pane (markdown
          // preview, chat) must not beat an explicit file copy on the focused
          // tree. Cross-review 0.2.33 (cc W3): this handler — the ONLY ⌘C
          // path on macOS — yielded to any pane's selection while the keydown
          // path documented the opposite, so the documented rule was violated
          // exactly on the platform this handler serves.
          const sel = window.getSelection();
          if (
            sel &&
            !sel.isCollapsed &&
            sel.anchorNode &&
            treeContainerRef.current?.contains(sel.anchorNode)
          ) {
            return;
          }
          // setData below is the deterministic OS write — skip the async
          // writeText so it can't land late and clobber a newer OS copy.
          const osText = copySelectionRef.current(mode, {
            skipAsyncOsWrite: true,
          });
          if (osText !== null) {
            e.preventDefault();
            e.clipboardData?.setData("text/plain", osText);
          }
        };
      const onCopy = handleClipboardEvent("copy");
      const onCut = handleClipboardEvent("cut");
      document.addEventListener("copy", onCopy);
      document.addEventListener("cut", onCut);
      return () => {
        document.removeEventListener("copy", onCopy);
        document.removeEventListener("cut", onCut);
      };
    }, []);

    /** Cmd+Z — undo the last reversible mutation (move/rename/create/paste).
     *  Deletes are NOT here: they live in the OS trash (用户决策 2026-06-11,
     *  Finder「放回原处」owns restoration). Best-effort by design: the entry
     *  is popped up front (no retry), partial failures surface via toasts. */
    const undoInFlightRef = useRef(false);
    const executeUndo = useCallback(async () => {
      // Serialize: a held-down Cmd+Z would interleave two async plans over
      // the same paths.
      if (undoInFlightRef.current) return;
      const journal = undoJournalRef.current;
      const entry = journal[journal.length - 1];
      if (!entry) {
        toast.info(tRef.current("workspaceFiles.directory.toasts.undoEmpty"));
        return;
      }
      undoJournalRef.current = journal.slice(0, -1);
      undoInFlightRef.current = true;
      let renameBackFailures = 0;
      try {
        for (const step of buildUndoPlan(entry)) {
          if (step.op === "delete") {
            // Undo of create/paste — to the OS trash, never permanent.
            await fileService.deleteFile({ path: step.path });
          } else if (step.op === "rename") {
            await fileService.rename({
              oldPath: step.path,
              newName: step.newName,
            });
          } else {
            const res = await fileService.movePaths({
              sourcePaths: [step.sourcePath],
              targetDir: step.targetDir,
            });
            if (res.errors && res.errors.length > 0) {
              toast.warning(
                tRef.current("workspaceFiles.directory.toasts.undoPartialFailed", {
                  error: res.errors[0],
                }),
              );
            }
            const landed = res.movedFiles[0];
            if (landed && baseNameOf(landed.newPath) !== step.desiredName) {
              // The forward move auto-renamed; best-effort restore of the
              // original basename (a new occupant may block it — keep the
              // landed name then, but don't report unqualified success).
              await fileService
                .rename({ oldPath: landed.newPath, newName: step.desiredName })
                .catch(() => {
                  renameBackFailures += 1;
                });
            }
          }
        }
        if (renameBackFailures > 0) {
          toast.warning(
            tRef.current("workspaceFiles.directory.toasts.undoWithRenameFailures", {
              count: renameBackFailures,
            }),
          );
        } else {
          toast.success(tRef.current("workspaceFiles.directory.toasts.undone"));
        }
      } catch (err) {
        toast.error(
          err instanceof Error
            ? tRef.current("workspaceFiles.directory.toasts.undoFailed", {
                error: err.message,
              })
            : tRef.current("workspaceFiles.directory.toasts.undoFailedGeneric"),
        );
      } finally {
        undoInFlightRef.current = false;
      }
      refresh();
    }, [fileService, refresh, toast]);

    /** Move keyboard focus (arrow keys / Home / End / type-ahead). Plain
     *  moves also move the single selection (VS Code); Shift extends the
     *  range from the click/focus anchor. */
    const focusRow = useCallback(
      (path: string, extendSelection: boolean) => {
        setFocusedPath(path);
        const meta = nodeMetaByPath.get(path);
        if (meta) {
          if (extendSelection && lastClickedPathRef.current) {
            const rangePaths = getRangeSelection(
              lastClickedPathRef.current,
              path,
            );
            const rangeNodes = rangePaths
              .map((p) => nodeByPath.get(p))
              .filter((node): node is DirectoryTreeNode => !!node);
            setSelectedNodes(rangeNodes);
          } else {
            setSelectedNodes([meta.data]);
            lastClickedPathRef.current = path;
          }
        }
        viewportRef.current?.scrollPathIntoView(path);
      },
      [nodeMetaByPath, getRangeSelection, nodeByPath],
    );

    const handleTreeKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        // The inline editor's input owns its own keys (it also stops
        // propagation — this is belt-and-suspenders for portaled focus).
        const targetEl = e.target as HTMLElement;
        if (targetEl.tagName === "INPUT" || targetEl.tagName === "TEXTAREA") {
          return;
        }
        if (editing) return;
        // Yield Cmd+C to native copy ONLY for a text selection INSIDE the
        // tree (practically impossible — rows are select-none). A stale
        // selection in ANOTHER pane (markdown preview, chat) must not beat
        // an explicit file copy on the focused tree.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
          const sel = window.getSelection();
          if (
            sel &&
            !sel.isCollapsed &&
            sel.anchorNode &&
            treeContainerRef.current?.contains(sel.anchorNode)
          ) {
            return;
          }
        }

        const action = resolveTreeKeyAction(
          {
            key: e.key,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
          },
          { rows: visibleRows, focusedPath, isOpen },
        );
        if (!action) return;
        // Internal clipboard empty → this Cmd+V belongs to the OS clipboard:
        // the document-level `paste` listener imports files/screenshots into
        // the workspace, and preventDefault here would suppress that event
        // entirely (the tree usually has focus now that clicks focus it).
        if (action.type === "paste" && !clipboard) return;
        // Nothing to copy → don't preventDefault (which would suppress the
        // native copy command with no feedback — a silently swallowed
        // Ctrl+C, the exact failure mode this feature's toasts exist to
        // prevent). Mirrors copySelection's own node resolution.
        if (
          (action.type === "copy" || action.type === "cut") &&
          selectedNodes.length === 0 &&
          !(focusedPath && nodeMetaByPath.has(focusedPath))
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();

        switch (action.type) {
          case "focus":
            focusRow(action.path, action.extendSelection);
            break;
          case "collapse":
            closePath(action.path);
            break;
          case "expand": {
            openPath(action.path);
            const meta = nodeMetaByPath.get(action.path);
            if (meta?.data.loaded === false) void expandDir(action.path);
            break;
          }
          case "activate": {
            const meta = nodeMetaByPath.get(action.path);
            if (!meta) break;
            if (meta.data.type === "dir") {
              if (!isOpen(action.path) && meta.data.loaded === false) {
                void expandDir(action.path);
              }
              togglePath(action.path);
            } else {
              setSelectedNodes([meta.data]);
              void previewNode(meta.data);
            }
            break;
          }
          case "rename":
            startRename(action.path);
            break;
          case "delete": {
            if (selectedNodes.length > 1) {
              setDialog({ type: "delete-multi", node: null, nodes: selectedNodes });
            } else {
              const node =
                selectedNodes[0] ??
                (focusedPath ? nodeMetaByPath.get(focusedPath)?.data : undefined);
              if (node) setDialog({ type: "delete", node });
            }
            break;
          }
          case "select-all":
            setSelectedNodes(visibleRows.map((r) => r.data));
            break;
          case "copy":
            copySelection("copy");
            break;
          case "cut":
            copySelection("cut");
            break;
          case "paste":
            void pasteFromClipboard();
            break;
          case "undo":
            void executeUndo();
            break;
          case "type-ahead": {
            const ta = typeAheadRef.current;
            if (ta.timer) clearTimeout(ta.timer);
            ta.buffer += action.char;
            ta.timer = setTimeout(() => {
              ta.buffer = "";
              ta.timer = null;
            }, 600);
            const target = findTypeAheadTarget(
              visibleRows,
              focusedPath,
              ta.buffer,
            );
            if (target) focusRow(target, false);
            break;
          }
        }
      },
      [
        editing,
        clipboard,
        visibleRows,
        focusedPath,
        isOpen,
        focusRow,
        closePath,
        openPath,
        nodeMetaByPath,
        expandDir,
        togglePath,
        previewNode,
        startRename,
        selectedNodes,
        copySelection,
        pasteFromClipboard,
        executeUndo,
      ],
    );

    // Clear the pending type-ahead timer on unmount.
    useEffect(
      () => () => {
        if (typeAheadRef.current.timer) clearTimeout(typeAheadRef.current.timer);
      },
      [],
    );

    const handleContextMenu = useCallback((
      e: React.MouseEvent,
      node: DirectoryTreeNode | null,
    ) => {
      e.preventDefault();
      e.stopPropagation();

      // If right-clicking on empty area, clear selection and show root menu
      if (!node) {
        setSelectedNodes([]);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node: null,
          isMultiSelect: false,
        });
        return;
      }

      // If the clicked node is already in selection and we have multiple selections,
      // show multi-select menu
      const isAlreadySelected = selectedNodes.some((n) => n.path === node.path);
      if (isAlreadySelected && selectedNodes.length > 1) {
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node,
          isMultiSelect: true,
        });
      } else {
        // Single selection - select only this node
        setSelectedNodes([node]);
        lastClickedPathRef.current = node.path;
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node,
          isMultiSelect: false,
        });
      }
    }, [selectedNodes]);

    const handleTreeContainerContextMenu = (e: React.MouseEvent) => {
      // Only trigger if clicking on empty area (not on a tree item)
      const target = e.target as HTMLElement;
      if (!target.closest("[data-tree-row]")) {
        handleContextMenu(e, null);
      }
    };

    const handleRowContextMenu = useCallback(
      (row: VisibleTreeRow, e: React.MouseEvent) => {
        handleContextMenu(e, row.data);
      },
      [handleContextMenu],
    );

    // Sticky breadcrumb interactions (VS Code sticky-scroll semantics).
    // Right-click MUST open the FOLDER's menu: the breadcrumb shows a folder
    // name, so users right-click it intending that folder — pre-fix the event
    // fell through to the container's "empty area" handler and opened the
    // ROOT menu, which is how 「新建笔记」 on a folder created the note at the
    // workspace root.
    const handleStickyJump = useCallback(
      (path: string) => {
        const meta = nodeMetaByPath.get(path);
        if (meta) {
          setSelectedNodes([meta.data]);
          lastClickedPathRef.current = path;
          setFocusedPath(path);
        }
        setTreeRevealRequest({ id: ++treeRevealRequestIdRef.current, path });
      },
      [nodeMetaByPath, setTreeRevealRequest, treeRevealRequestIdRef],
    );

    const handleStickyContextMenu = useCallback(
      (path: string, e: React.MouseEvent) => {
        const meta = nodeMetaByPath.get(path);
        if (meta) {
          handleContextMenu(e, meta.data);
        } else {
          // Folder vanished mid-render (refresh race) — still swallow the
          // event so the browser menu / root menu don't appear.
          e.preventDefault();
          e.stopPropagation();
        }
      },
      [nodeMetaByPath, handleContextMenu],
    );

    const handleRowClick = useCallback(
      (row: VisibleTreeRow, e: React.MouseEvent) => {
        const data = row.data;
        const isMeta = e.metaKey || e.ctrlKey;
        const isShift = e.shiftKey;
        setFocusedPath(data.path);

        if (isMeta) {
          setSelectedNodes((prev) =>
            prev.some((node) => node.path === data.path)
              ? prev.filter((node) => node.path !== data.path)
              : [...prev, data],
          );
          lastClickedPathRef.current = data.path;
        } else if (isShift && lastClickedPathRef.current) {
          const rangePaths = getRangeSelection(
            lastClickedPathRef.current,
            data.path,
          );
          const rangeNodes = rangePaths
            .map((path) => nodeByPath.get(path))
            .filter((node): node is DirectoryTreeNode => !!node);
          setSelectedNodes(rangeNodes);
        } else if (row.isDir) {
          setSelectedNodes([data]);
          lastClickedPathRef.current = data.path;
        } else {
          setSelectedNodes([data]);
          lastClickedPathRef.current = data.path;
          void previewNode(data);
        }

        // Toggle expansion only on a PLAIN click. Cmd/Shift clicks are
        // selection edits — toggling there made multi-selecting folders
        // fold/unfold them as a side effect (VS Code keeps them put).
        if (row.isDir && !isMeta && !isShift) {
          if (!row.isOpen && data.loaded === false) {
            void expandDir(data.path);
          }
          togglePath(data.path);
        }
      },
      [expandDir, getRangeSelection, nodeByPath, previewNode, togglePath],
    );

    const handleTreeScrollTopChange = useCallback((scrollTop: number) => {
      treeScrollTopRef.current = scrollTop;
    }, []);

    const handleTreeRevealHandled = useCallback((id: number) => {
      setTreeRevealRequest((prev) => (prev?.id === id ? null : prev));
    }, [setTreeRevealRequest]);

    // Get unique parent directories for multi-select "open in finder"
    const getUniqueParentDirs = (nodes: DirectoryTreeNode[]): string[] => {
      const parentDirs = new Set<string>();
      for (const node of nodes) {
        if (node.type === "dir") {
          parentDirs.add(node.path);
        } else {
          const parts = node.path.split("/");
          parts.pop();
          parentDirs.add(parts.join("/") || ".");
        }
      }
      return Array.from(parentDirs);
    };

    // Handle multi-select delete
    const handleDeleteMultiple = async (nodes: DirectoryTreeNode[]) => {
      try {
        // Filter out nodes whose parent is also selected (avoid deleting already-deleted paths)
        const nodePaths = new Set(nodes.map((n) => n.path));
        const filteredNodes = nodes.filter((node) => {
          // Check if any other selected node is a parent of this node
          const parts = node.path.split("/");
          for (let i = 1; i < parts.length; i++) {
            const parentPath = parts.slice(0, i).join("/");
            if (nodePaths.has(parentPath)) {
              return false; // Skip this node, its parent will be deleted
            }
          }
          return true;
        });

        for (const node of filteredNodes) {
          await fileService.deleteFile({ path: node.path });
        }
        setSelectedNodes([]);
        toast.success(
          tRef.current("workspaceFiles.directory.toasts.multiTrashMoved", {
            count: filteredNodes.length,
          }),
        );
        refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tRef.current("workspaceFiles.directory.errors.deleteFailed"),
        );
      }
    };

    const getContextMenuItems = (
      node: DirectoryTreeNode | null,
      isMultiSelect?: boolean,
    ): ContextMenuItem[] => {
      // Multi-select menu
      if (isMultiSelect && selectedNodes.length > 1) {
        const uniqueParentDirs = getUniqueParentDirs(selectedNodes);
        return [
          {
            label: t("workspaceFiles.directory.copyCount", {
              count: selectedNodes.length,
            }),
            icon: <Copy className="h-4 w-4" />,
            onClick: () => copySelection("copy"),
          },
          {
            label: t("workspaceFiles.directory.cutCount", {
              count: selectedNodes.length,
            }),
            icon: <Scissors className="h-4 w-4" />,
            onClick: () => copySelection("cut"),
          },
          {
            label: t("workspaceFiles.directory.openFoldersCount", {
              count: uniqueParentDirs.length,
            }),
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => {
              for (const dir of uniqueParentDirs) {
                void handleOpenInFinder(dir);
              }
            },
          },
          {
            label: t("workspaceFiles.directory.quoteCount", {
              count: selectedNodes.length,
            }),
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => {
              onInsertReference?.(selectedNodes.map((n) => n.path));
            },
          },
          {
            label: t("workspaceFiles.directory.deleteCount", {
              count: selectedNodes.length,
            }),
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () =>
              setDialog({
                type: "delete-multi",
                node: null,
                nodes: selectedNodes,
              }),
          },
        ];
      }

      // Root directory menu (empty area)
      if (!node) {
        return [
          {
            label: t("workspaceFiles.common.newNote"),
            icon: <NotebookPen className="h-4 w-4" />,
            onClick: () => void handleNewNote(""),
          },
          {
            label: t("workspaceFiles.common.newFile"),
            icon: <FilePlus className="h-4 w-4" />,
            onClick: () => startCreate("", "create-file"),
          },
          {
            label: t("workspaceFiles.common.newFolder"),
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => startCreate("", "create-folder"),
          },
          {
            label: t("workspaceFiles.common.importFile"),
            icon: <Upload className="h-4 w-4" />,
            onClick: () => {
              setImportTargetDir("");
              importInputRef.current?.click();
            },
          },
          {
            label: t("workspaceFiles.common.paste"),
            icon: <ClipboardPaste className="h-4 w-4" />,
            disabled: !clipboard,
            onClick: () => void pasteFromClipboard(),
          },
          {
            // ⌘A now reaches the tree's keydown handler on macOS too — the
            // native Edit menu's Select All item (which used to pre-empt it as
            // the selectAll: selector) was removed; see src-tauri/src/lib.rs.
            // This menu item stays as a discoverable / mouse-reachable entry
            // (⌘C/⌘Z are still consumed by their native menu items, so the
            // copy/undo entries below remain their only reachable path).
            label: t("workspaceFiles.common.selectAll"),
            icon: <ListChecks className="h-4 w-4" />,
            disabled: visibleRows.length === 0,
            onClick: () => setSelectedNodes(visibleRows.map((r) => r.data)),
          },
          {
            // ⌘Z is consumed by the native Edit menu on macOS, so the menu
            // is the tree-undo's reachable entry point there.
            label: t("workspaceFiles.common.undoLast"),
            icon: <Undo2 className="h-4 w-4" />,
            disabled: undoJournalRef.current.length === 0,
            onClick: () => void executeUndo(),
          },
          {
            label: t("workspaceFiles.common.refresh"),
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: () => {
              refresh();
              onRefreshAll?.();
            },
          },
        ];
      }

      const isDir = node.type === "dir";
      const canPreview =
        !isDir &&
        (isPreviewable(node.name) ||
          isImageFile(node.name) ||
          isRichDocPreviewable(node.name));

      if (isDir) {
        return [
          {
            label: t("workspaceFiles.common.newNote"),
            icon: <NotebookPen className="h-4 w-4" />,
            onClick: () => void handleNewNote(node.path),
          },
          {
            label: t("workspaceFiles.common.newFile"),
            icon: <FilePlus className="h-4 w-4" />,
            onClick: () => startCreate(node.path, "create-file"),
          },
          {
            label: t("workspaceFiles.common.newFolder"),
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => startCreate(node.path, "create-folder"),
          },
          {
            label: t("workspaceFiles.common.importFile"),
            icon: <Upload className="h-4 w-4" />,
            onClick: () => {
              setImportTargetDir(node.path);
              importInputRef.current?.click();
            },
          },
          { separator: true },
          {
            label: t("workspaceFiles.common.copy"),
            icon: <Copy className="h-4 w-4" />,
            onClick: () => copySelection("copy"),
          },
          {
            label: t("workspaceFiles.common.cut"),
            icon: <Scissors className="h-4 w-4" />,
            onClick: () => copySelection("cut"),
          },
          {
            label: t("workspaceFiles.common.paste"),
            icon: <ClipboardPaste className="h-4 w-4" />,
            disabled: !clipboard,
            onClick: () => void pasteFromClipboard(),
          },
          { separator: true },
          {
            label: t("workspaceFiles.common.openContainingFolder"),
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => handleOpenInFinder(node.path),
          },
          {
            label: t("workspaceFiles.common.copyFolderPath"),
            icon: <Copy className="h-4 w-4" />,
            onClick: () =>
              handleCopyPath(
                node.path,
                "workspaceFiles.directory.toasts.copiedFolderPath",
              ),
          },
          {
            label: t("workspaceFiles.common.quote"),
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => onInsertReference?.([node.path]),
          },
          {
            label: t("workspaceFiles.common.rename"),
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => startRename(node.path),
          },
          {
            label: t("workspaceFiles.common.delete"),
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () => setDialog({ type: "delete", node }),
          },
          { separator: true },
          {
            label: t("workspaceFiles.common.refresh"),
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: () => {
              refresh();
              onRefreshAll?.();
            },
          },
        ];
      } else {
        return [
          {
            label: t("workspaceFiles.common.preview"),
            icon: <Eye className="h-4 w-4" />,
            disabled: !canPreview,
            onClick: () => {
              if (isImageFile(node.name)) {
                void handleImagePreview(node);
              } else if (isRichDocPreviewable(node.name)) {
                handleRichDocPreview(node);
              } else if (isPreviewable(node.name)) {
                void handlePreview(node);
              }
            },
          },
          {
            label: t("workspaceFiles.common.quote"),
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => onInsertReference?.([node.path]),
          },
          {
            label: t("workspaceFiles.common.open"),
            icon: <ExternalLink className="h-4 w-4" />,
            onClick: () => handleOpenWithDefault(node.path),
          },
          {
            label: t("workspaceFiles.common.openContainingFolder"),
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => handleOpenInFinder(node.path),
          },
          { separator: true },
          {
            label: t("workspaceFiles.common.copy"),
            icon: <Copy className="h-4 w-4" />,
            onClick: () => copySelection("copy"),
          },
          {
            label: t("workspaceFiles.common.cut"),
            icon: <Scissors className="h-4 w-4" />,
            onClick: () => copySelection("cut"),
          },
          {
            label: t("workspaceFiles.common.copyFilePath"),
            icon: <Copy className="h-4 w-4" />,
            onClick: () =>
              handleCopyPath(
                node.path,
                "workspaceFiles.directory.toasts.copiedFilePath",
              ),
          },
          {
            label: t("workspaceFiles.common.rename"),
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => startRename(node.path),
          },
          {
            label: t("workspaceFiles.common.delete"),
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () => setDialog({ type: "delete", node }),
          },
        ];
      }
    };

    return (
      <div
        ref={panelRef}
        tabIndex={0}
        className={`flex flex-col bg-[var(--paper-elevated)] outline-none overscroll-none ${
          isNarrowMode && isCollapsed ? "h-12" : "h-full"
        }`}
      >
        {/* Title bar - aligned with left panel header */}
        <div
          className={`flex h-12 flex-shrink-0 items-center justify-between px-4 select-none ${
            isNarrowMode ? "cursor-pointer hover:bg-[var(--hover-bg)]" : ""
          }`}
          onClick={
            isNarrowMode ? () => setIsCollapsed(!isCollapsed) : undefined
          }
        >
          <div className="flex items-center gap-2">
            {/* Search toggle button */}
            <Tip
              label={
                isSearchMode
                  ? t("workspaceFiles.directory.closeSearch")
                  : t("workspaceFiles.directory.fileSearch")
              }
              position="bottom"
            >
              <button
                  type="button"
                  onClick={(e) => {
                      e.stopPropagation();
                      setIsSearchMode(!isSearchMode);
                      if (!isSearchMode) {
                          setTimeout(() => searchInputRef.current?.focus(), 50);
                      } else {
                          setSearchQuery('');
                      }
                  }}
                  className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                      isSearchMode
                          ? "bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)]"
                          : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  }`}
              >
                  <Search className="h-4 w-4" />
              </button>
            </Tip>
            {/* Terminal button */}
            {onOpenTerminal && (
              <Tip
                label={
                  terminalAlive
                    ? t("workspaceFiles.directory.showTerminal")
                    : t("workspaceFiles.directory.openTerminal")
                }
                position="bottom"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTerminal();
                  }}
                  className={`relative flex h-6 w-6 items-center justify-center rounded transition-colors ${
                    terminalAlive
                      ? "text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                      : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  }`}
                >
                  <TerminalSquare className="h-4 w-4" />
                  {/* Alive indicator dot */}
                  {terminalAlive && (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                  )}
                </button>
              </Tip>
            )}
            {/* Browser button */}
            {onOpenBrowser && (
              <Tip label={t("workspaceFiles.directory.browser")} position="bottom">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenBrowser();
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <Globe className="h-4 w-4" />
                </button>
              </Tip>
            )}
          </div>
          {/* Right side buttons */}
          <div className="flex items-center gap-1">
            {onOpenConfig && (
              <Tip
                label={t("workspaceFiles.directory.openAgentSettings")}
                position="bottom"
                align="end"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenConfig();
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  {t("workspaceFiles.directory.agentSettings")}
                </button>
              </Tip>
            )}
            {!isNarrowMode && onCollapse && (
              <Tip
                label={t("workspaceFiles.directory.collapseWorkspace")}
                position="bottom"
                align="end"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCollapse();
                  }}
                  aria-label={t("workspaceFiles.directory.collapseWorkspace")}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
              </Tip>
            )}
            {/* Collapse toggle button - only in narrow mode, positioned at far right */}
            {isNarrowMode && (
              <Tip
                label={isCollapsed
                  ? t("workspaceFiles.directory.expandWorkspace")
                  : t("workspaceFiles.directory.foldWorkspace")}
                position="bottom"
                align="end"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsCollapsed(!isCollapsed);
                  }}
                  aria-label={isCollapsed
                    ? t("workspaceFiles.directory.expandWorkspace")
                    : t("workspaceFiles.directory.foldWorkspace")}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <ChevronUp
                    className={`h-4 w-4 transition-transform ${isCollapsed ? "rotate-180" : ""}`}
                  />
                </button>
              </Tip>
            )}
          </div>
        </div>

        {/* Collapsible content - hidden in narrow mode when collapsed */}
        {!(isNarrowMode && isCollapsed) && (
          <>
            {/* Inset divider: header → folder info */}
            <div className="mx-4 border-b border-[var(--line-subtle)]" />

            {/* Folder header OR Search Input */}
            {isSearchMode ? (
              <div className="flex h-[52px] items-center gap-2 px-4 py-2 border-b border-[var(--line-subtle)] flex-shrink-0">
                  <div className="relative flex-1 flex items-center">
                      <Search className="absolute left-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <input
                          ref={searchInputRef}
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder={t("workspaceFiles.directory.searchPlaceholder")}
                          className="h-7 w-full rounded-md border border-[var(--line)] bg-transparent pl-8 pr-8 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none transition-colors focus:border-[var(--accent)]"
                          onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                  setIsSearchMode(false);
                                  setSearchQuery('');
                              }
                          }}
                      />
                      <button
                          onClick={() => {
                              setIsSearchMode(false);
                              setSearchQuery('');
                          }}
                          title={t("workspaceFiles.directory.exitSearch")}
                          className="absolute right-2 flex items-center text-[var(--ink-muted)]/50 transition-colors hover:text-[var(--ink)]"
                      >
                          <X className="h-3.5 w-3.5" />
                      </button>
                  </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 pb-2 pt-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center">
                  <WorkspaceIcon icon={projectIcon} size={28} />
                </span>
                <div className="min-w-0 flex-1">
                  {/* First row: name and git branch */}
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
                      {projectDisplayName || folderName}
                    </span>
                    {gitBranch && (
                      <span className="flex max-w-[45%] shrink-0 items-center gap-0.5 overflow-hidden whitespace-nowrap rounded-md bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                        <GitBranch className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 truncate">{gitBranch}</span>
                      </span>
                    )}
                  </div>
                  {/* Second row: path */}
                  <div className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                    {shortenPathForDisplay(agentDir)}
                  </div>
                </div>
                {/* Hidden file input for import functionality */}
                <input
                  ref={importInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => handleImport(event.target.files)}
                  disabled={isUploading}
                />
              </div>
            )}

            {/* Tree + Capabilities container (60/40 split) */}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Tree container */}
              <div
                ref={treeContainerRef}
                role="tree"
                tabIndex={0}
                className={`relative min-h-0 flex-1 overflow-hidden overscroll-none outline-none ${
                  isExternalDrop ||
                  isTauriDragActive ||
                  (activeDragItem !== null && internalDropTarget === "")
                    ? "ring-2 ring-inset ring-[var(--accent)]/30"
                    : ""
                }`}
                onKeyDown={handleTreeKeyDown}
                // WebKit quirk: clicking a child of a tabindex=0 div does NOT
                // focus the container (Safari never focuses non-inputs on
                // click) — without this, keyboard navigation silently doesn't
                // start after a mouse click. The inline editor's input keeps
                // its own focus.
                onMouseDown={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") {
                    treeContainerRef.current?.focus({ preventScroll: true });
                  }
                }}
                // focus-within tracking: selection dims while the tree
                // doesn't own the keyboard (React focus/blur bubble).
                onFocus={() => setIsTreeFocusWithin(true)}
                onBlur={(e) => {
                  if (
                    !treeContainerRef.current?.contains(
                      e.relatedTarget as Node | null,
                    )
                  ) {
                    setIsTreeFocusWithin(false);
                  }
                }}
                onContextMenu={handleTreeContainerContextMenu}
                onDragEnter={handleTreeDragEnter}
                onDragOver={handleTreeDragOver}
                onDragLeave={handleTreeDragLeave}
                onDrop={handleTreeDrop}
                onClick={(e) => {
                  // Clear selection when clicking empty area in tree container
                  const target = e.target as HTMLElement;
                  const isTreeRow = target.closest("[data-tree-row]");
                  if (!isTreeRow) {
                    setSelectedNodes([]);
                    lastClickedPathRef.current = null;
                  }
                }}
                data-tree-root
              >
                {isSearchMode ? (
                  <FileSearchResults
                    results={searchResults}
                    isLoading={isSearching}
                    isRefreshing={isRefreshingSearch}
                    query={debouncedSearchQuery}
                    expandedFiles={expandedFiles}
                    activeTarget={activeSearchTarget}
                    onToggleFile={(path) => {
                      setExpandedFiles((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      });
                    }}
                    onFileClick={(hit) => handlePreviewSearchHit(hit)}
                    onRevealInTree={(hit) => {
                      void handleRevealSearchResultInTree(hit.path);
                    }}
                    onMatchClick={(hit, match) =>
                      handlePreviewSearchHit(hit, match)
                    }
                    onContextMenu={(e, hit) => {
                      setContextMenu(null);
                      setSearchContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        hit,
                      });
                    }}
                  />
                ) : (
                  <>
                    {error && (
                      <div className="px-4 py-3 text-xs text-[var(--error)]">
                        {error}
                      </div>
                    )}
                    {!error && !directoryInfo && (
                      <div className="px-4 py-3 text-xs text-[var(--ink-muted)]">
                        {t("workspaceFiles.directory.loading")}
                      </div>
                    )}
                    {directoryInfo && (
                      <DndContext
                    sensors={dndSensors}
                    collisionDetection={dndCollisionDetection}
                    onDragStart={handleDndDragStart}
                    onDragOver={handleDndDragOver}
                    onDragEnd={handleDndDragEnd}
                    onDragCancel={handleDndDragCancel}
                  >
                    <WorkspaceTreeViewport
                      ref={viewportRef}
                      items={items}
                      rowHeight={ROW_HEIGHT}
                      dropTargetPath={isExternalDrop ? dropTargetPath : null}
                      internalDropTarget={internalDropTarget}
                      activeDragPaths={activeDragItem?.paths ?? []}
                      cutPaths={
                        clipboard?.mode === "cut" ? clipboard.paths : []
                      }
                      focusedPath={focusedPath}
                      treeActive={isTreeFocusWithin}
                      initialScrollTop={treeScrollTopRef.current}
                      revealRequest={treeRevealRequest}
                      onRevealHandled={handleTreeRevealHandled}
                      getStickyAncestors={getStickyAncestors}
                      onCloseAncestorPath={closePath}
                      onJumpToAncestorPath={handleStickyJump}
                      onAncestorContextMenu={handleStickyContextMenu}
                      onScrollTopChange={handleTreeScrollTopChange}
                      onRowClick={handleRowClick}
                      onRowContextMenu={handleRowContextMenu}
                      onEditCommit={handleEditCommit}
                      onEditCancel={handleEditCancel}
                    />
                    {/* Drag overlay — floating preview that follows cursor */}
                    <DragOverlay dropAnimation={null}>
                      {activeDragItem && (
                        <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-sm shadow-lg">
                          <activeDragItem.icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]" />
                          <span className="font-medium text-[var(--ink)]">
                            {activeDragItem.name}
                          </span>
                          {activeDragItem.paths.length > 1 && (
                            <span className="text-xs text-[var(--ink-muted)]">
                              +{activeDragItem.paths.length - 1}
                            </span>
                          )}
                        </div>
                      )}
                    </DragOverlay>
                      </DndContext>
                    )}
                  </>
                )}
              </div>

              <WorkspaceSessionHistory
                key={agentDir}
                agentDir={agentDir}
                currentSessionId={currentSessionId}
                onSelectSession={onSelectSession}
              />

              {/* Vertical drag divider — tree ↔ capabilities
                Outer div: invisible hit area (py-1.5 = 12px), cursor hint
                Inner div: thin visual line, hover changes color via group */}
              <div
                className="group/cap-divider mx-4 cursor-row-resize py-1.5"
                onMouseDown={handleCapDividerMouseDown}
              >
                <div className="border-b border-[var(--line-subtle)] transition-colors group-hover/cap-divider:border-[var(--accent)]/40" />
              </div>

              {/* Agent Capabilities Panel */}
              <AgentCapabilitiesPanel
                enabledAgents={enabledAgents}
                enabledSkills={enabledSkills}
                enabledCommands={enabledCommands}
                globalSkillFolderNames={globalSkillFolderNames}
                onInsertSlashCommand={onInsertSlashCommand}
                onOpenSettings={onOpenSettings}
                onSyncSkillToGlobal={onSyncSkillToGlobal}
                onRefresh={() => {
                  refresh();
                  onRefreshAll?.();
                }}
                heightRatio={capRatio}
              />
            </div>
          </>
        )}

        {/* Context Menu */}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={getContextMenuItems(
              contextMenu.node,
              contextMenu.isMultiSelect,
            )}
            onClose={() => setContextMenu(null)}
            zIndex={320}
          />
        )}

        {searchContextMenu && (
          <ContextMenu
            x={searchContextMenu.x}
            y={searchContextMenu.y}
            items={getSearchResultContextMenuItems(searchContextMenu.hit)}
            onClose={() => setSearchContextMenu(null)}
            zIndex={320}
          />
        )}

        {/* Delete Confirm Dialog — deletion goes to the OS trash (recoverable
            via Finder/Explorer), the copy reflects that. */}
        {dialog?.type === "delete" && dialog.node && (
          <ConfirmDialog
            title={
              dialog.node.type === "dir"
                ? t("workspaceFiles.directory.deleteDialog.folderTitle")
                : t("workspaceFiles.directory.deleteDialog.fileTitle")
            }
            message={t("workspaceFiles.directory.deleteDialog.message", {
              name: dialog.node.name,
            })}
            confirmLabel={t("workspaceFiles.common.delete")}
            cancelLabel={t("actions.cancel", { ns: "common" })}
            danger
            onConfirm={() => {
              void handleDelete(dialog.node!.path);
              setDialog(null);
            }}
            onCancel={() => setDialog(null)}
          />
        )}

        {/* Multi-Delete Confirm Dialog */}
        {dialog?.type === "delete-multi" &&
          dialog.nodes &&
          dialog.nodes.length > 0 && (
            <ConfirmDialog
              title={t("workspaceFiles.directory.deleteDialog.multiTitle", {
                count: dialog.nodes.length,
              })}
              message={t("workspaceFiles.directory.deleteDialog.multiMessage", {
                count: dialog.nodes.length,
              })}
              confirmLabel={t("workspaceFiles.common.deleteAll")}
              cancelLabel={t("actions.cancel", { ns: "common" })}
              danger
              onConfirm={() => {
                void handleDeleteMultiple(dialog.nodes!);
                setDialog(null);
              }}
              onCancel={() => setDialog(null)}
            />
          )}

        {/* Preview modal - lazy loaded. Skip when split-view handles previews externally. */}
        {!onFilePreviewExternal &&
          (preview || previewError || isPreviewLoading) && (
            <Suspense fallback={null}>
              <FilePreviewModal
                name={preview?.name ?? t("workspaceFiles.common.preview")}
                content={preview?.content ?? ""}
                size={preview?.size ?? 0}
                path={preview?.path ?? ""}
                richDocKind={preview?.richDocKind}
                isLoading={isPreviewLoading}
                error={previewError}
                // Phase D.5: thread the absolute workspace root so rendered
                // markdown previews can load relative-path images.
                workspacePath={agentDir}
                initialEditMode={preview?.initialEditMode}
                initialLineNumber={preview?.initialLineNumber}
                focusTarget={preview?.focusTarget}
                externalRefreshSignal={refreshTrigger}
                onExternalContentUpdated={(updated) => {
                  setPreview((prev) => prev && prev.path === updated.path
                    ? { ...prev, name: updated.name, content: updated.content, size: updated.size, initialEditMode: undefined }
                    : prev);
                }}
                onClose={() => {
                  setPreview(null);
                  setPreviewError(null);
                }}
                onSaved={refresh}
                onRenamed={(newPath, newName) => {
                  // Update the preview state so subsequent saves target the
                  // new path. The fs watcher triggers a tree refresh on its
                  // own (rename → delete-old + create-new event pair).
                  setPreview((prev) =>
                    prev ? { ...prev, path: newPath, name: newName, initialEditMode: undefined } : prev,
                  );
                  refresh();
                }}
                // Phase D.5: route reveal through fileService rather than the
                // modal falling back to sidecar `/agent/open-in-finder`.
                onRevealFile={async () => {
                  const p = preview?.path;
                  if (!p) return;
                  await fileService.openInFinder({ path: p });
                }}
                onQuoteFile={onQuoteFile}
                onRevealInTree={(path) => {
                  void handleRevealSearchResultInTree(path);
                }}
                onQuoteSelection={onQuoteSelection}
              />
            </Suspense>
          )}
      </div>
    );
  }),
);

export default DirectoryPanel;
