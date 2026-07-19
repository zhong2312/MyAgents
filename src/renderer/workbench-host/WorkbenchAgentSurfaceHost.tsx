import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitCompareArrows,
  Loader2,
  Maximize2,
  Minus,
  Minimize2,
  RotateCcw,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { getFolderName, type Tab } from "@/types/tab";
import DraggableDialogFrame from "@/workbench-sdk/DraggableDialogFrame";

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
        .find((tab) => tab.workbenchAgentSurface?.presentation === "dialog"),
    [visibleSurfaces],
  );
  const taskSurfaces = useMemo(
    () =>
      surfaces.filter(
        (tab) => tab.workbenchAgentSurface?.presentation !== "hidden",
      ),
    [surfaces],
  );
  const orderedTaskSurfaces = useMemo(
    () => [...taskSurfaces].reverse(),
    [taskSurfaces],
  );
  const runningTaskCount = taskSurfaces.filter((tab) => tab.isGenerating).length;
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

  const visiblePendingRestart = pendingRestart;

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
          className="h-[min(720px,calc(100vh-4rem))] max-h-[calc(100%-1.5rem)] w-[min(1040px,calc(100vw-4rem))] max-w-[calc(100%-1.5rem)] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
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
          <div className="relative min-h-0 flex-1">
            {dialog.view === "chat" ? (
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

      {surfaces
        .filter((tab) => tab.id !== dialog?.id)
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
          aria-label="AI 任务坞"
          className="absolute bottom-5 right-5 z-[190] w-96 max-w-[calc(100%-2rem)] overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl"
        >
          <header className="flex min-h-12 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
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
                  {tab.workbenchAgentSurface?.toolset?.id === "novel-world" && (
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
