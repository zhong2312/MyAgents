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
import TabActivityIndicator from '@/components/TabActivityIndicator';
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

    // Prefer the session title once it exists; before that, the workspace name
    // gives an untitled chat tab a useful identity. Fixed product tabs remain
    // localized chrome.
    const hasSessionTitle = tab.title && tab.title !== 'New Tab' && tab.title !== 'New Chat';
    const workspaceTitle = tab.agentDir ? getFolderName(tab.agentDir) : undefined;
    const displayTitle = fixedViewTitle ?? (hasSessionTitle
        ? tab.title
        : (workspaceTitle ?? tab.title));
    const hasChatContext = tab.view === 'chat'
        && workspaceTitle
        && hasSessionTitle;
    const tooltipTitle = hasChatContext
        ? `${workspaceTitle} — ${displayTitle}`
        : displayTitle;
    const accessibleTitle = hasChatContext
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
                rounded-md px-2.5 transition-colors duration-150
                ${isDragging ? 'shadow-lg ring-2 ring-[var(--accent)]/30' : ''}
                ${isActive
                    ? 'bg-[var(--hover-bg)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
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
                <span className="min-w-0 truncate">{displayTitle}</span>
            </span>

            <TabActivityIndicator
                isGenerating={tab.isGenerating}
                hasUnread={!isActive && tab.hasUnread}
                className="ml-1"
            />

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
                <div
                    className="absolute bottom-0.5 left-4 right-4 h-0.5 rounded-full bg-[var(--accent)]/70"
                    data-tab-active-indicator
                />
            )}

        </div>
    );
});
