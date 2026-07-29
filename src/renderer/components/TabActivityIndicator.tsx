import { useTranslation } from 'react-i18next';

interface TabActivityIndicatorProps {
    isGenerating?: boolean;
    hasUnread?: boolean;
    className?: string;
}

/**
 * The shared attention signal for a live Tab and every Session projection of it.
 * Runtime activity wins over unread completion; idle/selected/open state belongs
 * to the surrounding surface and intentionally renders no indicator here.
 */
export default function TabActivityIndicator({
    isGenerating = false,
    hasUnread = false,
    className = '',
}: TabActivityIndicatorProps) {
    const { t } = useTranslation('app');

    if (isGenerating) {
        return (
            <>
                <span
                    className={`relative flex h-1.5 w-1.5 shrink-0 ${className}`}
                    data-tab-activity-indicator="generating"
                    aria-hidden="true"
                >
                    <span className="absolute inset-0 rounded-full bg-[var(--success)]" />
                    <span className="absolute inset-0 animate-[tab-dot-pulse_1.6s_cubic-bezier(.22,.61,.36,1)_infinite] rounded-full bg-[var(--success)] motion-reduce:animate-none" />
                </span>
                <span className="sr-only">{t('tabs.generating')}</span>
            </>
        );
    }

    if (hasUnread) {
        return (
            <>
                <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-warm)] ${className}`}
                    data-tab-activity-indicator="unread"
                    aria-hidden="true"
                />
                <span className="sr-only">{t('tabs.unread')}</span>
            </>
        );
    }

    return null;
}
