import {
  Bot,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Square,
  X,
} from "lucide-react";

export type CompactAiRunStatus = "preparing" | "running" | "ready" | "error";

export interface CompactAiRunWindowProps {
  readonly label: string;
  readonly status: CompactAiRunStatus;
  readonly output?: string;
  readonly error?: string;
  readonly applied?: boolean;
  readonly onApply?: () => void;
  readonly onRetry?: () => void;
  readonly onExpand?: () => void;
  readonly onClose: () => void;
}

const STATUS_TEXT: Record<CompactAiRunStatus, string> = {
  preparing: "正在装配上下文",
  running: "MyAgents 正在生成",
  ready: "结果可以审阅",
  error: "生成失败",
};

export function CompactAiRunWindow({
  label,
  status,
  output,
  error,
  applied = false,
  onApply,
  onRetry,
  onExpand,
  onClose,
}: CompactAiRunWindowProps) {
  const pending = status === "preparing" || status === "running";
  return (
    <aside
      aria-label={`${label} AI 运行窗口`}
      className="fixed bottom-5 right-5 z-[180] w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] shadow-2xl"
    >
      <header className="flex min-h-12 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool)] text-white">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold">
            {label}
          </strong>
          <span className="flex items-center gap-1 text-xs text-[var(--ink-muted)]">
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-cool)]" />
            ) : status === "ready" ? (
              <Check className="h-3 w-3 text-[var(--success)]" />
            ) : null}
            {STATUS_TEXT[status]}
          </span>
        </span>
        {onExpand && (
          <button
            type="button"
            aria-label="展开到完整 Agent 会话"
            title="展开到完整会话"
            onClick={onExpand}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭 AI 运行窗口"
          title="关闭"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="max-h-64 overflow-y-auto px-4 py-3 text-xs leading-5">
        {pending && (
          <div className="space-y-2 text-[var(--ink-muted)]">
            <div className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-[var(--success)]" />{" "}
              必要上下文已注入
            </div>
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-cool)]" />
              执行一次性生成请求
            </div>
          </div>
        )}
        {status === "ready" && output && (
          <pre className="whitespace-pre-wrap break-words font-sans text-[var(--ink)]">
            {output}
          </pre>
        )}
        {status === "error" && (
          <p className="break-words text-[var(--error)]">
            {error ?? "未知错误"}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-3 py-2.5">
        {pending ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs"
          >
            <Square className="h-3 w-3" /> 隐藏
          </button>
        ) : (
          <>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" /> 重新生成
              </button>
            )}
            {status === "ready" && onApply && (
              <button
                type="button"
                disabled={applied}
                onClick={onApply}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-cool)] px-2.5 text-xs font-medium text-white disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />{" "}
                {applied ? "已应用" : "应用到编辑区"}
              </button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}
