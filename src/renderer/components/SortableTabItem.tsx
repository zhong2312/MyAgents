/**
 * SortableTabItem - Individual sortable tab component
 * Uses @dnd-kit for high-performance drag-and-drop
 *
 * Drag listeners are bound to the title span only (not the entire tab div)
 * to prevent dnd-kit's document-level click capture from swallowing
 * clicks on the close button.
 */

import { memo, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TAB_ITEM_MAX_WIDTH_PX, TAB_ITEM_MIN_WIDTH_PX } from '@/components/tabBarLayout';
import { type Tab, getFolderName } from '@/types/tab';
import { getFixedTabChromeTitle } from '@/utils/tabChromeTitle';

interface SortableTabItemProps {
    tab: Tab;
    isActive: boolean;
    /** Stable callback — receives tabId so parent doesn't need inline closures */
    onSelectTab: (tabId: string) => void;
    /** Stable callback — receives tabId so parent doesn't need inline closures */
    onCloseTab: (tabId: string) => void;
}

export default memo(function SortableTabItem({
    tab,
    isActive,
    onSelectTab,
    onCloseTab,
}: SortableTabItemProps) {
    const { t } = useTranslation('app');
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: tab.id });

    const style: CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 100 : undefined,
        opacity: isDragging ? 0.8 : 1,
        minWidth: TAB_ITEM_MIN_WIDTH_PX,
        maxWidth: TAB_ITEM_MAX_WIDTH_PX,
        flex: `1 1 ${TAB_ITEM_MAX_WIDTH_PX}px`,
    };

    const fixedViewTitle = getFixedTabChromeTitle(tab.view, t);

    // A chat tab needs both pieces of identity once it has a real session title:
    // the workspace answers "which Agent?", while the session title answers
    // "which conversation?". Fixed product tabs remain localized chrome.
    const hasSessionTitle = tab.title && tab.title !== 'New Tab' && tab.title !== 'New Chat';
    const workspaceTitle = tab.agentDir ? getFolderName(tab.agentDir) : undefined;
    const displayTitle = fixedViewTitle ?? (hasSessionTitle
        ? tab.title
        : (workspaceTitle ?? tab.title));
    const showWorkspaceContext = tab.view === 'chat'
        && !!workspaceTitle
        && !!hasSessionTitle;
    const tooltipTitle = showWorkspaceContext
        ? `${workspaceTitle} — ${displayTitle}`
        : displayTitle;
    const accessibleTitle = showWorkspaceContext
        ? `${workspaceTitle}, ${displayTitle}`
        : displayTitle;

    return (
        <div
            ref={setNodeRef}
            style={style}
            data-tab-id={tab.id}
            title={tooltipTitle}
            className={`
                group/tab relative flex h-8 cursor-default items-center
                rounded-lg px-2.5 transition-colors duration-150
                ${isDragging ? 'shadow-lg ring-2 ring-[var(--accent)]/30' : ''}
                ${isActive
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)] shadow-sm'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]/60 hover:text-[var(--ink)]'
                }
            `}
            onMouseDown={(e) => {
                // Selection is owned by press, not click: a real drag may
                // intentionally swallow the later click event.
                if (e.button !== 0) return; // Left click only
                if ((e.target as HTMLElement).closest('button')) return; // Skip close button
                onSelectTab(tab.id);
            }}
            {...attributes}
        >
            {/* Tab title — drag handle is bound here, not on the entire tab */}
            <span
                className="flex min-w-0 flex-1 items-center text-xs font-medium select-none"
                aria-label={accessibleTitle}
                {...listeners}
            >
                {showWorkspaceContext ? (
                    <>
                        <span className="max-w-[35%] flex-shrink-0 truncate">
                            {workspaceTitle}
                        </span>
                        <span
                            data-tab-title-divider
                            className="mx-1.5 h-3 w-px flex-shrink-0 bg-[var(--line-strong)]/70"
                            aria-hidden="true"
                        />
                        <span className="min-w-0 truncate">{displayTitle}</span>
                    </>
                ) : (
                    <span className="min-w-0 truncate">{displayTitle}</span>
                )}
            </span>

            {/* Status dot indicator — streaming (pulsing green, always visible) or unread (static warm, non-active only) */}
            {tab.isGenerating && (
                <>
                    <span className="relative ml-1 flex h-1.5 w-1.5 flex-shrink-0" aria-hidden="true">
                        <span className="absolute inset-0 rounded-full bg-[var(--success)]" />
                        <span className="absolute inset-0 rounded-full bg-[var(--success)] animate-[tab-dot-pulse_1.6s_cubic-bezier(.22,.61,.36,1)_infinite]" />
                    </span>
                    <span className="sr-only">{t('tabs.generating')}</span>
                </>
            )}
            {!isActive && !tab.isGenerating && tab.hasUnread && (
                <>
                    <span className="ml-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent-warm)]" aria-hidden="true" />
                    <span className="sr-only">{t('tabs.unread')}</span>
                </>
            )}

            {/* Close button — enlarged hit area (24×24) with visual icon (12×12) */}
            <button
                className={`
                    -mr-1.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full
                    transition-all duration-150
                    ${isActive
                        ? 'opacity-60 hover:bg-[var(--ink)]/10 hover:opacity-100'
                        : 'opacity-0 group-hover/tab:opacity-60 hover:!bg-[var(--ink)]/10 hover:!opacity-100'
                    }
                `}
                onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                }}
                title={`${t('tabs.closeTab')} (${navigator.platform.toLowerCase().includes('mac') ? '⌘W' : 'Ctrl+W'})`}
            >
                <X className="h-3 w-3" />
            </button>

            {/* Active indicator */}
            {isActive && (
                <div className="absolute bottom-0.5 left-4 right-4 h-0.5 rounded-full bg-[var(--accent)]/70" />
            )}

        </div>
    );
});
