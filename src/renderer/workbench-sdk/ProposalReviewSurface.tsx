import {
  AlertTriangle,
  AlignJustify,
  Columns2,
  GitCompareArrows,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import DraggableDialogFrame from "./DraggableDialogFrame";

export interface ProposalReviewSurfaceProps {
  readonly title: string;
  readonly subtitle: string;
  readonly sideBySide: boolean;
  readonly showViewModeControl?: boolean;
  readonly isRefreshing?: boolean;
  readonly error?: string | null;
  readonly children: ReactNode;
  readonly onSideBySideChange: (value: boolean) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}

/** Project-tab approval frame; domain adapters own proposal loading/apply. */
export function ProposalReviewSurface({
  title,
  subtitle,
  sideBySide,
  showViewModeControl = true,
  isRefreshing = false,
  error,
  children,
  onSideBySideChange,
  onRefresh,
  onClose,
}: ProposalReviewSurfaceProps) {
  const [maximized, setMaximized] = useState(false);

  return (
    <DraggableDialogFrame
      ariaLabel={title}
      maximized={maximized}
      positioning="container"
      overlayClassName="z-[220]"
      className="h-[min(760px,calc(100vh-3rem))] max-h-[calc(100%-1.5rem)] w-[min(1180px,calc(100vw-3rem))] max-w-[calc(100%-1.5rem)] max-sm:h-[calc(100vh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
      headerClassName="flex min-h-14 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 max-sm:flex-wrap max-sm:py-2"
      header={
        <>
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
            <GitCompareArrows className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {subtitle}
            </p>
          </div>
          {showViewModeControl && (
            <div className="ml-auto flex items-center gap-1 rounded-md bg-[var(--paper-inset)] p-1 max-sm:order-2 max-sm:ml-0 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={sideBySide}
                title="并排差异"
                onClick={() => onSideBySideChange(true)}
                className={`flex h-7 items-center justify-center gap-1 rounded px-2 text-xs ${
                  sideBySide
                    ? "bg-[var(--paper-elevated)] shadow-sm"
                    : "text-[var(--ink-muted)]"
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" /> 并排
              </button>
              <button
                type="button"
                aria-pressed={!sideBySide}
                title="行内差异"
                onClick={() => onSideBySideChange(false)}
                className={`flex h-7 items-center justify-center gap-1 rounded px-2 text-xs ${
                  !sideBySide
                    ? "bg-[var(--paper-elevated)] shadow-sm"
                    : "text-[var(--ink-muted)]"
                }`}
              >
                <AlignJustify className="h-3.5 w-3.5" /> 行内
              </button>
            </div>
          )}
          {!showViewModeControl && <span className="ml-auto" />}
          <button
            type="button"
            aria-label="重新读取提案"
            title="重新读取提案"
            onClick={onRefresh}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
          </button>
          <button
            type="button"
            aria-label={maximized ? "还原提案窗口" : "全屏显示提案窗口"}
            title={maximized ? "还原窗口" : "全屏"}
            onClick={() => setMaximized((current) => !current)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            aria-label="关闭提案审阅"
            title="关闭"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      }
    >
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </DraggableDialogFrame>
  );
}
