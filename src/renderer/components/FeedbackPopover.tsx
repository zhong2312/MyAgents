/**
 * FeedbackPopover - Quick access popover for the AI assistant.
 *
 * Drops down from the feedback button in the titlebar.
 * The community QR entry is intentionally not exposed in the product build.
 */

import { useTranslation } from 'react-i18next';
import { Bot, X } from 'lucide-react';

import { Popover } from '@/components/ui/Popover';

interface FeedbackPopoverProps {
    open: boolean;
    onClose: () => void;
    onOpenBugReport: () => void;
    /** Ref to the trigger button — anchors the popover. */
    triggerRef: React.RefObject<HTMLElement | null>;
}

export default function FeedbackPopover({ open, onClose, onOpenBugReport, triggerRef }: FeedbackPopoverProps) {
    const { t } = useTranslation('app');

    return (
        <Popover
            open={open}
            onClose={onClose}
            anchorRef={triggerRef}
            placement="bottom-end"
            offset={6}
            zIndex={200}
            className="w-72 rounded-xl shadow-lg"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    {t('titlebar.feedbackTitle')}
                </span>
                <button
                    onClick={onClose}
                    className="rounded-md p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title={t('titlebar.close')}
                    aria-label={t('titlebar.close')}
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* AI 小助理 */}
            <div className="px-3 pb-2">
                <button
                    onClick={() => {
                        onClose();
                        onOpenBugReport();
                    }}
                    className="group w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5
                        text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                >
                    <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] transition-colors group-hover:bg-[var(--accent-warm-muted)]">
                            <Bot className="h-4 w-4 text-[var(--accent-warm)]" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--ink)]">{t('titlebar.helper')}</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                                {t('titlebar.helperDescription')}
                            </p>
                        </div>
                    </div>
                </button>
            </div>

        </Popover>
    );
}
