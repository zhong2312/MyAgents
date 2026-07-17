import {
  Bot,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Minus,
  X,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import type { Tab } from "@/types/tab";

interface WorkbenchAgentSurfaceHostProps {
  readonly surfaces: readonly Tab[];
  readonly renderSurface: (tab: Tab, isActive: boolean) => ReactNode;
  readonly onMinimize: (tabId: string) => void;
  readonly onRestore: (tabId: string) => void;
  readonly onExpandToTab: (tabId: string) => void;
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
  renderSurface,
  onMinimize,
  onRestore,
  onExpandToTab,
  onClose,
}: WorkbenchAgentSurfaceHostProps) {
  const dialog = useMemo(
    () =>
      [...surfaces]
        .reverse()
        .find((tab) => tab.workbenchAgentSurface?.presentation === "dialog"),
    [surfaces],
  );
  const docked = useMemo(
    () =>
      surfaces.filter(
        (tab) => tab.workbenchAgentSurface?.presentation === "dock",
      ),
    [surfaces],
  );

  useCloseLayer(() => {
    if (!dialog) return false;
    onMinimize(dialog.id);
    return true;
  }, 210);

  return (
    <>
      {dialog && (
        <OverlayBackdrop
          className="z-[210] p-4 max-sm:p-0"
          onClose={() => onMinimize(dialog.id)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title}
            className="flex h-[min(900px,calc(100vh-2rem))] w-[min(1280px,calc(100vw-2rem))] min-h-0 flex-col overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper)] shadow-2xl max-sm:h-full max-sm:w-full max-sm:rounded-none max-sm:border-0"
          >
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-[var(--ink)]">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white">
                <Bot className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-semibold">
                  {dialog.title}
                </strong>
              </div>
              <SurfaceStatus tab={dialog} />
              <button
                type="button"
                aria-label="最小化 Agent 会话"
                title="最小化"
                onClick={() => onMinimize(dialog.id)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="在页签中打开 Agent 会话"
                title="转为页签"
                onClick={() => onExpandToTab(dialog.id)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="关闭 Agent 会话"
                title="关闭"
                onClick={() => onClose(dialog.id)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
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
          </section>
        </OverlayBackdrop>
      )}

      {surfaces
        .filter((tab) => tab.id !== dialog?.id)
        .map((tab) => (
          <div
            key={`mounted-${tab.id}`}
            aria-hidden="true"
            className="pointer-events-none fixed -left-[10000px] top-0 h-px w-px overflow-hidden opacity-0"
          >
            {tab.view === "chat" ? renderSurface(tab, false) : null}
          </div>
        ))}

      {docked.length > 0 && (
        <aside
          aria-label="Agent 运行窗口"
          className="fixed bottom-5 right-5 z-[190] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
        >
          {docked.map((tab) => (
            <section
              key={tab.id}
              className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-xl"
            >
              <header className="flex min-h-12 items-center gap-2 px-3 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <button
                  type="button"
                  onClick={() => onRestore(tab.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <strong className="block truncate text-xs font-semibold">
                    {tab.title}
                  </strong>
                  <SurfaceStatus tab={tab} />
                </button>
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
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭"
                  onClick={() => onClose(tab.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>
            </section>
          ))}
        </aside>
      )}
    </>
  );
}
