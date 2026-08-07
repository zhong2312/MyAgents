import { AlertCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Unified "AI 启动中" boot overlay — the frosted-glass loading state shown from the
 * instant a chat is entered (Launcher→Chat) until the session is ready.
 *
 * Rendered in TWO phases so the whole entry is ONE continuous loading state:
 *   1. App's Suspense fallback while the lazy Chat chunk resolves (before mount) —
 *      replaces the old blank paper div that read as "nothing happened".
 *   2. Chat's in-page overlay during the sidecar cold boot (after mount), driven by
 *      the `show` prop.
 *
 * The shell stays mounted so a persisted restore can re-arm it without a remount
 * gap. Dismiss is animated; appearance is instant (no enter transition),
 * which prevents the old content from flashing before the shell becomes opaque.
 */
export default function ChatBootOverlay({
    show = true,
    error = null,
    onRetry,
}: {
    show?: boolean;
    error?: string | null;
    onRetry?: () => void;
}) {
    const { t } = useTranslation('chat');
    const hasError = show && Boolean(error);

    return (
        <div
            aria-hidden={!show}
            aria-live={show ? 'polite' : undefined}
            className={`absolute inset-0 z-30 flex items-center justify-center bg-[var(--paper-elevated)]/80 backdrop-blur-sm ${show ? 'opacity-100' : 'pointer-events-none opacity-0 transition-opacity duration-300 ease-out'}`}
        >
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                {hasError
                    ? <AlertCircle className="h-6 w-6 text-[var(--error)]" />
                    : <Loader2 className={`h-6 w-6 text-[var(--ink-muted)] ${show ? 'animate-spin' : ''}`} />}
                <p className="text-sm text-[var(--ink-muted)]">
                    {hasError ? t('shell.boot.restoreFailed') : t('shell.boot.loading')}
                </p>
                {hasError && <p className="text-xs text-[var(--ink-faint)]">{error}</p>}
                {hasError && onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-hover)] hover:text-[var(--ink)]"
                    >
                        {t('shell.boot.retry')}
                    </button>
                )}
            </div>
        </div>
    );
}
