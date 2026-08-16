import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitCompareArrows,
  GripVertical,
  Loader2,
  Maximize2,
  Minus,
  Minimize2,
  RotateCcw,
  X,
} from "lucide-react";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator } from "react-resizable-panels";

import ConfirmDialog from "@/components/ConfirmDialog";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { getFolderName, type Tab } from "@/types/tab";
import DraggableDialogFrame from "@/workbench-sdk/DraggableDialogFrame";
import { workbenchRegistry } from "@/workbench-registry";

interface WorkbenchAgentSurfaceHostProps {
  readonly surfaces: readonly Tab[];
  readonly activeSourceTabId: string | null;
  readonly renderSurface: (tab: Tab, isActive: boolean) => ReactNode;
  readonly onMinimize: (tabId: string) => void;
  readonly onRestore: (tabId: string) => void;
  readonly onExpandToTab: (tabId: string) => void;
  readonly onReview: (tabId: string) => void;
  readonly onRestart: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
}

const PROPOSAL_REVIEW_MODES = new Set([
  "world",
  "template",
  "assist",
  "items",
  "characters",
  "manuscript",
]);
const DOCK_VIEWPORT_MARGIN = 12;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface DockDragState {
  readonly pointerId: number;
  readonly startPointer: Point;
  readonly startOffset: Point;
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role='button']") !==
      null
  );
}

function supportsProposalReview(tab: Tab): boolean {
  const surface = tab.workbenchAgentSurface;
  return Boolean(
    surface?.toolset?.id === "novel-world" &&
      PROPOSAL_REVIEW_MODES.has(surface.toolset.context?.mode ?? ""),
  );
}

/**
 * An embedded surface belongs to a workbench-owned DOM region. Its mount target
 * is the stable identity: generic review and restore actions must never turn it
 * back into an independent dialog merely by changing its presentation value.
 */
function isEmbeddedReviewSurface(tab: Tab): boolean {
  return Boolean(tab.workbenchAgentSurface?.embeddedSurfaceId);
}

function SurfaceStatus({ tab }: { readonly tab: Tab }) {
  if (tab.isGenerating) {
    return (
      <span className="flex items-center gap-1 text-xs text-[var(--accent-cool)]">
        <Loader2 className="h-3 w-3 animate-spin" /> 正在运行
      </span>
    );
  }
  if (tab.hasUnread) {
    return (
      <span className="flex items-center gap-1 text-xs text-[var(--success)]">
        <CheckCircle2 className="h-3 w-3" /> 已完成
      </span>
    );
  }
  return <span className="text-xs text-[var(--ink-muted)]">会话已就绪</span>;
}

interface EmbeddedAgentSurfaceProps {
  readonly tab: Tab;
  readonly renderSurface: (tab: Tab, isActive: boolean) => ReactNode;
}

/**
 * The workbench owns these mounts and can replace them whenever its dialog
 * moves between workflow steps. Subscribe to DOM changes instead of updating
 * React state from an effect, so an embedded Agent never gets a transient
 * generic-dialog render while its target is appearing.
 */
function useEmbeddedSurfaceTarget(
  embeddedSurfaceId: string | undefined,
  suffix: "conversation" | "companion",
): HTMLElement | null {
  const getSnapshot = useMemo(
    () => () => {
      if (!embeddedSurfaceId || typeof document === "undefined") return null;
      return document.getElementById(`${embeddedSurfaceId}-${suffix}`);
    },
    [embeddedSurfaceId, suffix],
  );
  const subscribe = useMemo(
    () => (notify: () => void) => {
      if (!embeddedSurfaceId || typeof document === "undefined") {
        return () => undefined;
      }
      const observer = new MutationObserver(notify);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    [embeddedSurfaceId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function EmbeddedAgentSurface({
  tab,
  renderSurface,
}: EmbeddedAgentSurfaceProps) {
  const surface = tab.workbenchAgentSurface;
  const embeddedSurfaceId = surface?.embeddedSurfaceId;
  const conversationTarget = useEmbeddedSurfaceTarget(
    embeddedSurfaceId,
    "conversation",
  );
  const companionTarget = useEmbeddedSurfaceTarget(
    embeddedSurfaceId,
    "companion",
  );
  const companionRequest = surface?.companion;
  const AgentCompanion = workbenchRegistry.get(surface?.workbenchId ?? "")
    ?.AgentCompanion;

  if (!embeddedSurfaceId) return null;

  return (
    <>
      {conversationTarget &&
        createPortal(
          <section
            aria-label="AI 执行过程"
            className="absolute inset-0 z-10 min-h-0 min-w-0 overflow-hidden bg-[var(--paper)]"
          >
            {tab.view === "chat" ? (
              renderSurface(tab, true)
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在启动 Agent 会话
              </div>
            )}
          </section>,
          conversationTarget,
        )}
      {companionTarget &&
        createPortal(
          <section
            aria-label="正文候选审阅"
            className="absolute inset-0 z-10 min-h-0 min-w-0 overflow-hidden bg-[var(--paper)]"
          >
            {AgentCompanion && companionRequest ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在载入正文候选
                  </div>
                }
              >
                <AgentCompanion
                  workspacePath={surface?.workspacePath ?? ""}
                  conversationKey={surface?.conversationKey ?? ""}
                  companionId={companionRequest.id}
                  context={companionRequest.context ?? {}}
                  isAgentRunning={tab.isGenerating === true}
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--ink-muted)]">
                当前工作台没有提供正文候选审阅区
              </div>
            )}
          </section>,
          companionTarget,
        )}
    </>
  );
}

export default function WorkbenchAgentSurfaceHost({
  surfaces,
  activeSourceTabId,
  renderSurface,
  onMinimize,
  onRestore,
  onExpandToTab,
  onReview,
  onRestart,
  onClose,
}: WorkbenchAgentSurfaceHostProps) {
  const [pendingRestart, setPendingRestart] = useState<Tab | null>(null);
  const [maximizedDialogId, setMaximizedDialogId] = useState<string | null>(
    null,
  );
  const [isDockCollapsed, setIsDockCollapsed] = useState(false);
  const [dockOffset, setDockOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDockDragging, setIsDockDragging] = useState(false);
  const dockRef = useRef<HTMLElement | null>(null);
  const dockDragRef = useRef<DockDragState | null>(null);
  const [compactVertical, setCompactVertical] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 900,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setCompactVertical(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const visibleSurfaces = useMemo(
    () =>
      surfaces.filter(
        (tab) => tab.workbenchAgentSurface?.sourceTabId === activeSourceTabId,
      ),
    [activeSourceTabId, surfaces],
  );

  const dialog = useMemo(
    () =>
      [...visibleSurfaces]
        .reverse()
        .find((tab) => {
          const presentation = tab.workbenchAgentSurface?.presentation;
          return (
            !isEmbeddedReviewSurface(tab) &&
            (presentation === "dialog" || presentation === "compact-review")
          );
        }),
    [visibleSurfaces],
  );
  const embeddedSurfaces = useMemo(
    () => {
      // A mount target is a single-slot surface. Lifecycle cleanup normally
      // removes prior runs before a replacement starts; selecting the newest
      // surface here also prevents a stale session from splitting the same
      // conversation/output regions during any asynchronous overlap.
      const mountedSurfaceIds = new Set<string>();
      return [...visibleSurfaces]
        .reverse()
        .filter((tab) => {
          const surfaceId = tab.workbenchAgentSurface?.embeddedSurfaceId;
          if (!surfaceId || mountedSurfaceIds.has(surfaceId)) return false;
          mountedSurfaceIds.add(surfaceId);
          return true;
        })
        .reverse();
    },
    [visibleSurfaces],
  );
  const taskSurfaces = useMemo(
    () =>
      surfaces.filter(
        (tab) => {
          const presentation = tab.workbenchAgentSurface?.presentation;
          return presentation !== "hidden" && !isEmbeddedReviewSurface(tab);
        },
      ),
    [surfaces],
  );
  const orderedTaskSurfaces = useMemo(
    () => [...taskSurfaces].reverse(),
    [taskSurfaces],
  );
  const runningTaskCount = taskSurfaces.filter(
    (tab) => tab.isGenerating,
  ).length;
  const completedTaskCount = taskSurfaces.filter(
    (tab) => !tab.isGenerating && tab.hasUnread,
  ).length;
  const taskSummary =
    runningTaskCount > 0
      ? `${runningTaskCount} 个运行中${
          completedTaskCount > 0 ? ` · ${completedTaskCount} 个待查看` : ""
        }`
      : completedTaskCount > 0
        ? `${completedTaskCount} 个待查看`
        : `${taskSurfaces.length} 个任务`;

  const handleDockPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    const dock = dockRef.current;
    if (!dock) return;

    const boundary =
      dock.offsetParent instanceof HTMLElement
        ? dock.offsetParent.getBoundingClientRect()
        : {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            width: window.innerWidth,
            height: window.innerHeight,
          };
    const rect = dock.getBoundingClientRect();
    const margin = Math.min(
      DOCK_VIEWPORT_MARGIN,
      Math.max(0, (boundary.width - rect.width) / 2),
      Math.max(0, (boundary.height - rect.height) / 2),
    );

    dockDragRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startOffset: dockOffset,
      bounds: {
        minX: dockOffset.x + boundary.left + margin - rect.left,
        maxX: dockOffset.x + boundary.right - margin - rect.right,
        minY: dockOffset.y + boundary.top + margin - rect.top,
        maxY: dockOffset.y + boundary.bottom - margin - rect.bottom,
      },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDockDragging(true);
    event.preventDefault();
  };

  const handleDockPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dockDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDockOffset({
      x: clamp(
        drag.startOffset.x + event.clientX - drag.startPointer.x,
        drag.bounds.minX,
        drag.bounds.maxX,
      ),
      y: clamp(
        drag.startOffset.y + event.clientY - drag.startPointer.y,
        drag.bounds.minY,
        drag.bounds.maxY,
      ),
    });
  };

  const finishDockDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dockDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dockDragRef.current = null;
    setIsDockDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const visiblePendingRestart = pendingRestart;
  const isCompactReview =
    dialog?.workbenchAgentSurface?.presentation === "compact-review";
  const companionRequest = dialog?.workbenchAgentSurface?.companion;
  const AgentCompanion = dialog
    ? workbenchRegistry.get(dialog.workbenchAgentSurface?.workbenchId ?? "")
        ?.AgentCompanion
    : undefined;

  useCloseLayer(() => {
    if (visiblePendingRestart) {
      setPendingRestart(null);
      return true;
    }
    if (!dialog) return false;
    setMaximizedDialogId(null);
    onMinimize(dialog.id);
    return true;
  }, 210);

  return (
    <>
      {dialog && (
        <DraggableDialogFrame
          key={dialog.id}
          ariaLabel={dialog.title}
          maximized={maximizedDialogId === dialog.id}
          positioning="container"
          overlayClassName="z-[210]"
          className={
            isCompactReview
              ? "h-[min(820px,calc(100vh-3rem))] max-h-[calc(100%-1rem)] w-[min(1480px,calc(100vw-3rem))] max-w-[calc(100%-1rem)] max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)]"
              : "h-[min(720px,calc(100vh-4rem))] max-h-[calc(100%-1.5rem)] w-[min(1040px,calc(100vw-4rem))] max-w-[calc(100%-1.5rem)] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
          }
          headerClassName="flex h-11 items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-3"
          header={
            <>
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white">
                <Bot className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-semibold">
                  {dialog.title}
                </strong>
              </div>
              <SurfaceStatus tab={dialog} />
              {supportsProposalReview(dialog) && (
                <button
                  type="button"
                  aria-label="打开候选审阅"
                  title="审阅候选"
                  onClick={() => onReview(dialog.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <GitCompareArrows className="h-4 w-4" />
                </button>
              )}
              {dialog.workbenchAgentSurface?.bootstrap && (
                <button
                  type="button"
                  aria-label="重新开始 Agent 会话"
                  title="重新开始"
                  onClick={() => setPendingRestart(dialog)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                aria-label={
                  maximizedDialogId === dialog.id
                    ? "还原 Agent 窗口"
                    : "全屏显示 Agent 窗口"
                }
                title={maximizedDialogId === dialog.id ? "还原窗口" : "全屏"}
                onClick={() =>
                  setMaximizedDialogId((current) =>
                    current === dialog.id ? null : dialog.id,
                  )
                }
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                {maximizedDialogId === dialog.id ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                aria-label="最小化 Agent 会话"
                title="最小化"
                onClick={() => {
                  setMaximizedDialogId(null);
                  onMinimize(dialog.id);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="在页签中打开 Agent 会话"
                title="转为页签"
                onClick={() => {
                  setMaximizedDialogId(null);
                  onExpandToTab(dialog.id);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="关闭 Agent 窗口"
                title="关闭窗口"
                onClick={() => {
                  setMaximizedDialogId(null);
                  onClose(dialog.id);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          }
        >
          <div className="relative min-h-0 flex-1 bg-[var(--paper)]">
            {isCompactReview ? (
              <Group
                id={`workbench-agent-review-${dialog.id}`}
                orientation={compactVertical ? "vertical" : "horizontal"}
                className="h-full min-h-0"
              >
                <Panel
                  id="agent-conversation"
                  defaultSize={compactVertical ? "42%" : "38%"}
                  minSize={compactVertical ? "180px" : "320px"}
                  maxSize={compactVertical ? "70%" : "58%"}
                >
                  <section
                    aria-label="AI 执行过程"
                    className="relative h-full min-h-0 overflow-hidden border-[var(--line)] max-[899px]:border-b min-[900px]:border-r"
                  >
                    {dialog.view === "chat" ? (
                      renderSurface(dialog, true)
                    ) : (
                      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在启动 Agent 会话
                      </div>
                    )}
                  </section>
                </Panel>
                <Separator
                  id="agent-review-separator"
                  aria-label="调整执行过程与正文审阅的宽度"
                  className="group relative z-10 flex w-2 items-center justify-center bg-[var(--paper-inset)] outline-none transition-colors hover:bg-[var(--accent-cool-subtle)] focus-visible:bg-[var(--accent-cool-subtle)] max-[899px]:h-2 max-[899px]:w-full"
                >
                  <span className="flex h-7 w-4 items-center justify-center rounded-sm border border-[var(--line)] bg-[var(--paper-elevated)] text-[var(--ink-subtle)] shadow-sm max-[899px]:h-4 max-[899px]:w-7">
                    <GripVertical className="h-3 w-3 max-[899px]:rotate-90" />
                  </span>
                </Separator>
                <Panel id="workbench-review" minSize={compactVertical ? "220px" : "420px"}>
                  <section aria-label="正文差异审阅" className="h-full min-h-0 overflow-hidden">
                    {AgentCompanion && companionRequest ? (
                      <Suspense
                        fallback={
                          <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            正在载入审阅区
                          </div>
                        }
                      >
                        <AgentCompanion
                          workspacePath={dialog.workbenchAgentSurface?.workspacePath ?? ""}
                          conversationKey={dialog.workbenchAgentSurface?.conversationKey ?? ""}
                          companionId={companionRequest.id}
                          context={companionRequest.context ?? {}}
                          isAgentRunning={dialog.isGenerating === true}
                        />
                      </Suspense>
                    ) : (
                      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--ink-muted)]">
                        当前工作台没有提供此审阅面板
                      </div>
                    )}
                  </section>
                </Panel>
              </Group>
            ) : dialog.view === "chat" ? (
              renderSurface(dialog, true)
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在启动 Agent 会话
              </div>
            )}
          </div>
        </DraggableDialogFrame>
      )}

      {embeddedSurfaces.map((tab) => (
        <EmbeddedAgentSurface
          key={`embedded-${tab.id}`}
          tab={tab}
          renderSurface={renderSurface}
        />
      ))}

      {surfaces
        .filter(
          (tab) =>
            tab.id !== dialog?.id &&
            !isEmbeddedReviewSurface(tab),
        )
        .map((tab) => (
          <div
            key={`mounted-${tab.id}`}
            aria-hidden="true"
            className="pointer-events-none absolute -left-[10000px] top-0 h-px w-px overflow-hidden opacity-0"
          >
            {tab.view === "chat"
              ? renderSurface(
                  tab,
                  Boolean(tab.initialMessage) || tab.isGenerating === true,
                )
              : null}
          </div>
        ))}

      {taskSurfaces.length > 0 && (
        <aside
          ref={dockRef}
          aria-label="AI 任务坞"
          style={{
            transform: `translate3d(${dockOffset.x}px, ${dockOffset.y}px, 0)`,
          }}
          className="absolute bottom-5 right-5 z-[190] w-96 max-w-[calc(100%-2rem)] overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl"
        >
          <header
            aria-label="拖动 AI 任务坞"
            title="拖动任务坞"
            onPointerDown={handleDockPointerDown}
            onPointerMove={handleDockPointerMove}
            onPointerUp={finishDockDrag}
            onPointerCancel={finishDockDrag}
            className={`flex min-h-12 touch-none select-none items-center gap-2 border-b border-[var(--line)] px-3 py-2 [&_button]:cursor-pointer ${
              isDockDragging ? "cursor-grabbing" : "cursor-grab"
            }`}
          >
            <span
              aria-hidden="true"
              className="flex h-4 w-3 shrink-0 items-center justify-center text-[var(--ink-subtle)]"
            >
              <GripVertical className="h-4 w-4" />
            </span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
              {runningTaskCount > 0 ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Bot className="h-3.5 w-3.5" />
              )}
            </span>
            <button
              type="button"
              aria-expanded={!isDockCollapsed}
              onClick={() => setIsDockCollapsed((current) => !current)}
              className="min-w-0 flex-1 text-left"
            >
              <strong className="block truncate text-xs font-semibold">
                AI 任务
              </strong>
              <span className="block truncate text-xs text-[var(--ink-muted)]">
                {taskSummary}
              </span>
            </button>
            <span
              aria-label={`共 ${taskSurfaces.length} 个任务`}
              className="flex h-6 min-w-6 items-center justify-center rounded-full bg-[var(--paper-inset)] px-1.5 text-xs font-medium text-[var(--ink-muted)]"
            >
              {taskSurfaces.length}
            </span>
            <button
              type="button"
              aria-label={isDockCollapsed ? "展开 AI 任务" : "收起 AI 任务"}
              title={isDockCollapsed ? "展开" : "收起"}
              onClick={() => setIsDockCollapsed((current) => !current)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              {isDockCollapsed ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </header>

          {!isDockCollapsed && (
            <div className="max-h-[min(52vh,28rem)] overflow-y-auto">
              {orderedTaskSurfaces.map((tab) => (
                <section
                  key={tab.id}
                  className={`flex min-h-14 items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2 last:border-b-0 ${
                    tab.id === dialog?.id
                      ? "bg-[var(--accent-cool-subtle)]"
                      : tab.hasUnread
                        ? "bg-[var(--success-bg)]"
                        : ""
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--ink-muted)]">
                    {tab.isGenerating ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-cool)]" />
                    ) : tab.hasUnread ? (
                      <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRestore(tab.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <strong className="block truncate text-xs font-semibold">
                      {tab.title}
                    </strong>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <SurfaceStatus tab={tab} />
                      <span className="truncate text-xs text-[var(--ink-subtle)]">
                        ·{" "}
                        {getFolderName(
                          tab.workbenchAgentSurface?.workspacePath ?? "",
                        )}
                      </span>
                    </span>
                  </button>
                  {tab.workbenchAgentSurface?.bootstrap && (
                    <button
                      type="button"
                      aria-label={`重新开始 ${tab.title}`}
                      title="重新开始"
                      onClick={() => setPendingRestart(tab)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  )}
                  {supportsProposalReview(tab) && (
                    <button
                      type="button"
                      aria-label={`审阅 ${tab.title} 提案`}
                      title="审阅提案"
                      onClick={() => onReview(tab.id)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <GitCompareArrows className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`展开 ${tab.title}`}
                    title="展开"
                    onClick={() => onRestore(tab.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${tab.title}窗口`}
                    title="关闭窗口"
                    onClick={() => onClose(tab.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </section>
              ))}
            </div>
          )}
        </aside>
      )}

      {visiblePendingRestart && (
        <ConfirmDialog
          title="重新开始对话"
          message={
            visiblePendingRestart.isGenerating
              ? "当前对话仍在生成中。重新开始会结束当前任务并开启新会话，是否继续？"
              : "重新开始会开启新的对话，当前对话不会自动继续。是否继续？"
          }
          confirmText="重新开始"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={() => {
            const tabId = visiblePendingRestart.id;
            setPendingRestart(null);
            onRestart(tabId);
          }}
          onCancel={() => setPendingRestart(null)}
        />
      )}
    </>
  );
}
