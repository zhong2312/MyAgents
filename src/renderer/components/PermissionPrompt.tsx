import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, X, Check, CheckCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface PermissionRequest {
    requestId: string;
    sessionId?: string | null;
    toolName: string;
    input: string;
    queuePosition?: number;
    queueTotal?: number;
}

interface PermissionPromptProps {
    request: PermissionRequest;
    onDecision: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
}

/**
 * Permission prompt card shown inline in the message flow
 * when Agent requests to use a tool that requires user confirmation
 */
export function PermissionPrompt({ request, onDecision }: PermissionPromptProps) {
    const { t } = useTranslation('chat');
    const [isResponding, setIsResponding] = useState(false);
    const [responded, setResponded] = useState(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const handleDecision = async (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (isResponding) return;
        const requestId = request.requestId;
        setIsResponding(true);
        try {
            await onDecision(requestId, decision);
            if (mountedRef.current) {
                setResponded(true);
            }
        } catch (error) {
            console.error('[PermissionPrompt] Permission response failed:', error);
            if (mountedRef.current) {
                setIsResponding(false);
            }
        }
    };

    // Format tool name for display
    const formatToolName = (name: string) => {
        // mcp__playwright__browser_tabs -> Playwright: browser_tabs
        if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
                return `${parts[1]}: ${parts.slice(2).join('_')}`;
            }
        }
        return name;
    };

    // Format input for display - extract key info
    const formatInput = (input: string) => {
        try {
            const parsed = JSON.parse(input);
            // For common tools, show key parameters
            if (parsed.query) return parsed.query;
            if (parsed.command) return parsed.command;
            if (parsed.url) return parsed.url;
            if (parsed.file_path) return parsed.file_path;
            return JSON.stringify(parsed, null, 2);
        } catch {
            return input;
        }
    };

    // If already responded, show nothing
    if (responded) {
        return null;
    }

    const formattedInput = formatInput(request.input);
    const queuePosition = request.queuePosition ?? 1;
    const queueTotal = request.queueTotal ?? 1;
    const showQueueProgress = queueTotal > 1;
    const progressPercent = Math.min(100, Math.max(0, (queuePosition / queueTotal) * 100));

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            {/* 反相版（PRD 0.2.34）：中性白卡 + 淡琥珀「命令盒」承载焦点内容，
                颜色当重点而非整卡底色。权限语义＝warning 琥珀（对齐 DESIGN.md §10.6）。 */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
                {showQueueProgress && (
                    <div className="mb-3 animate-in fade-in slide-in-from-top-1 duration-200">
                        <div className="mb-1.5 text-xs font-medium text-[var(--ink-muted)]">
                            {t('shell.permissionPrompt.progress', { index: queuePosition, total: queueTotal })}
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[var(--warning)]/15">
                            <div
                                className="h-full rounded-full bg-[var(--warning)] transition-[width] duration-300 ease-out"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Header */}
                <div className="flex items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--warning)]/15">
                        <ShieldAlert className="h-4.5 w-4.5 text-[var(--warning)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-[var(--ink)]">{t('shell.permissionPrompt.title')}</div>
                        <div className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('shell.permissionPrompt.subtitle')}</div>
                    </div>
                    <span className="flex items-center rounded-full bg-[var(--warning)]/15 px-2.5 py-1 text-xs font-medium text-[var(--warning)]">
                        {t('shell.permissionPrompt.badge')}
                    </span>
                </div>

                {/* 工具 + 入参 —— 上色的焦点盒（命令完整、等宽显示，不再截断） */}
                <div className="mt-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-3">
                    <span className="mb-1.5 inline-block rounded-md bg-[var(--warning)]/15 px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                        {formatToolName(request.toolName)}
                    </span>
                    {formattedInput && (
                        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--ink-secondary)]">
                            {formattedInput}
                        </div>
                    )}
                </div>

                {/* Actions — 主操作（允许）实心琥珀靠右 */}
                <div className="mt-3 flex items-center gap-2">
                    <button
                        onClick={() => handleDecision('deny')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-medium
                            text-[var(--ink-muted)] transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]
                            disabled:opacity-50"
                    >
                        <X className="size-3.5" />
                        <span>{t('shell.permissionPrompt.deny')}</span>
                    </button>

                    <div className="flex-1" />

                    <button
                        onClick={() => handleDecision('always_allow')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--warning)]/20 bg-[var(--warning)]/10 px-3 py-1.5 text-xs font-medium
                            text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/15 disabled:opacity-50"
                    >
                        <CheckCheck className="size-3.5" />
                        <span>{t('shell.permissionPrompt.alwaysAllow')}</span>
                    </button>

                    <button
                        onClick={() => handleDecision('allow_once')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 rounded-lg bg-[var(--warning)] px-3 py-1.5 text-xs font-medium
                            text-[var(--on-warning)] transition-colors hover:brightness-110 disabled:opacity-50"
                    >
                        <Check className="size-3.5" />
                        <span>{t('shell.permissionPrompt.allow')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
