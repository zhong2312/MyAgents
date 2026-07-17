import {
  AlertTriangle,
  AlignJustify,
  Columns2,
  GitCompareArrows,
  RefreshCw,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

export interface ProposalReviewSurfaceProps {
  readonly title: string;
  readonly subtitle: string;
  readonly sideBySide: boolean;
  readonly isRefreshing?: boolean;
  readonly error?: string | null;
  readonly children: ReactNode;
  readonly onSideBySideChange: (value: boolean) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}

/** Global workbench approval frame; domain adapters own proposal loading/apply. */
export function ProposalReviewSurface({
  title,
  subtitle,
  sideBySide,
  isRefreshing = false,
  error,
  children,
  onSideBySideChange,
  onRefresh,
  onClose,
}: ProposalReviewSurfaceProps) {
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[220] flex min-h-0 flex-col bg-[var(--paper)] text-[var(--ink)]"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 max-sm:flex-wrap max-sm:py-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
          <GitCompareArrows className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="truncate text-xs text-[var(--ink-muted)]">{subtitle}</p>
        </div>
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
          aria-label="关闭提案审阅"
          title="关闭"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      {children}
    </section>
  );
}
