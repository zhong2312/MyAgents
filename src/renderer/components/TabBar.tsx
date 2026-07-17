/**
 * TabBar - Drag-and-drop sortable tab bar with horizontal scroll
 * 
 * Features:
 * - Horizontal scroll when tabs overflow
 * - Fade gradients at edges to indicate hidden content
 * - Hides + button when at MAX_TABS
 */

import { memo, useCallback, useEffect, useRef, useState, type WheelEvent } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { List, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SortableTabItem from '@/components/SortableTabItem';
import { TAB_BAR_BUTTON_WIDTH_PX, TAB_BAR_GAP_PX, getTabStripIdealWidth } from '@/components/tabBarLayout';
import { TabPointerSensor, TAB_POINTER_SENSOR_OPTIONS } from '@/components/tabPointerSensor';
import { Popover } from '@/components/ui/Popover';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { type Tab, MAX_TABS, getFolderName } from '@/types/tab';
import { getFixedTabChromeTitle } from '@/utils/tabChromeTitle';

interface TabBarProps {
    tabs: Tab[];
    activeTabId: string | null;
    onSelectTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    onNewTab: () => void;
    onReorderTabs: (activeId: string, overId: string) => void;
}

export default memo(function TabBar({
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onReorderTabs,
}: TabBarProps) {
    const { t } = useTranslation('app');
    const canAddTab = tabs.length < MAX_TABS;
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const overflowButtonRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const stripIdealWidth = getTabStripIdealWidth(tabs.length, { canAddTab });

    useCloseLayer(() => {
        if (!menuOpen) return false;
        setMenuOpen(false);
        return true;
    }, menuOpen ? 260 : -1);

    // Track scroll state for fade indicators
    const [scrollState, setScrollState] = useState({
        canScrollLeft: false,
        canScrollRight: false,
        isOverflowing: false,
    });

    // Check scroll position and update fade indicators
    const updateScrollState = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollLeft, scrollWidth, clientWidth } = container;
        const isOverflowing = scrollWidth > clientWidth + 1; // +1 for subpixel rounding
        if (!isOverflowing) {
            setMenuOpen((open) => (open ? false : open));
        }
        const next = {
            canScrollLeft: isOverflowing && scrollLeft > 0,
            canScrollRight: isOverflowing && scrollLeft + clientWidth < scrollWidth - 1,
            isOverflowing,
        };
        setScrollState((prev) => {
            if (
                prev.canScrollLeft === next.canScrollLeft &&
                prev.canScrollRight === next.canScrollRight &&
                prev.isOverflowing === next.isOverflowing
            ) {
                return prev;
            }
            return next;
        });
    }, []);

    // Update scroll state on mount, resize, and tab changes
    useEffect(() => {
        const frameId = requestAnimationFrame(updateScrollState);

        const container = scrollContainerRef.current;
        if (!container) {
            return () => cancelAnimationFrame(frameId);
        }

        container.addEventListener('scroll', updateScrollState);
        window.addEventListener('resize', updateScrollState);
        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(updateScrollState)
            : null;
        resizeObserver?.observe(container);
        const fallbackMeasureInterval = resizeObserver
            ? null
            : window.setInterval(updateScrollState, 250);

        return () => {
            cancelAnimationFrame(frameId);
            container.removeEventListener('scroll', updateScrollState);
            window.removeEventListener('resize', updateScrollState);
            resizeObserver?.disconnect();
            if (fallbackMeasureInterval !== null) window.clearInterval(fallbackMeasureInterval);
        };
    }, [updateScrollState, tabs.length]);

    // Auto-scroll to active tab when it changes (e.g., when adding new tab)
    useEffect(() => {
        if (!activeTabId) return;

        const container = scrollContainerRef.current;
        if (!container) return;

        // Find the active tab element and scroll it into view
        const activeTabElement = container.querySelector(`[data-tab-id="${activeTabId}"]`);
        if (activeTabElement) {
            activeTabElement.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'nearest',
            });
            // Update scroll state after scroll animation
            setTimeout(updateScrollState, 300);
        }
    }, [activeTabId, updateScrollState]);

    // Configure sensors for drag detection
    const sensors = useSensors(
        useSensor(TabPointerSensor, TAB_POINTER_SENSOR_OPTIONS),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    // Handle drag end
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            onReorderTabs(active.id as string, over.id as string);
        }
    };

    const handleWheel = useCallback(
        (event: WheelEvent<HTMLDivElement>) => {
            const container = scrollContainerRef.current;
            if (!container || !scrollState.isOverflowing) return;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (delta === 0) return;
            container.scrollLeft += delta;
            event.preventDefault();
            updateScrollState();
        },
        [scrollState.isOverflowing, updateScrollState],
    );

    const handleSelectFromMenu = useCallback(
        (tabId: string) => {
            setMenuOpen(false);
            onSelectTab(tabId);
        },
        [onSelectTab],
    );

    return (
        <div className="flex h-full min-w-0 flex-1 items-center select-none overflow-hidden">
            <div
                data-testid="tabbar-layout-strip"
                className="flex h-full min-w-0 max-w-full flex-shrink items-center overflow-hidden"
                style={{ width: `${stripIdealWidth}px`, gap: TAB_BAR_GAP_PX }}
            >
                {/* Scroll container with fade indicators */}
                <div className="relative min-w-0 flex-1 overflow-hidden">
                    {/* Left fade gradient */}
                    {scrollState.canScrollLeft && (
                        <div
                            className="absolute left-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                            style={{
                                // #333: same-color 0-alpha endpoint, never the `transparent` keyword (see index.css --*-a0)
                                background: 'linear-gradient(to right, var(--paper) 0%, var(--paper-a0) 100%)',
                            }}
                        />
                    )}

                    {/* Right fade gradient */}
                    {scrollState.canScrollRight && (
                        <div
                            className="absolute right-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                            style={{
                                background: 'linear-gradient(to left, var(--paper) 0%, var(--paper-a0) 100%)',
                            }}
                        />
                    )}

                    {/* Sortable tab list */}
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={tabs.map((t) => t.id)}
                            strategy={horizontalListSortingStrategy}
                        >
                            <div
                                ref={scrollContainerRef}
                                className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
                                style={{
                                    gap: TAB_BAR_GAP_PX,
                                    scrollbarWidth: 'none',
                                    msOverflowStyle: 'none',
                                }}
                                aria-label={t('tabs.openTabs')}
                                onWheel={handleWheel}
                            >
                                {tabs.map((tab) => (
                                    <SortableTabItem
                                        key={tab.id}
                                        tab={tab}
                                        isActive={tab.id === activeTabId}
                                        onSelectTab={onSelectTab}
                                        onCloseTab={onCloseTab}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </div>

                {scrollState.isOverflowing && (
                    <>
                        <button
                            ref={overflowButtonRef}
                            type="button"
                            className={`flex flex-shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]/60 hover:text-[var(--ink)] ${
                                menuOpen ? 'bg-[var(--paper-inset)] text-[var(--ink)]' : ''
                            }`}
                            style={{ width: TAB_BAR_BUTTON_WIDTH_PX, height: TAB_BAR_BUTTON_WIDTH_PX }}
                            onClick={() => setMenuOpen((open) => !open)}
                            aria-label={t('tabs.allTabs')}
                            title={t('tabs.allTabs')}
                        >
                            <List className="h-4 w-4" />
                        </button>
                        <Popover
                            open={menuOpen}
                            onClose={() => setMenuOpen(false)}
                            anchorRef={overflowButtonRef}
                            placement="bottom-end"
                            className="max-h-96 w-72 overflow-y-auto py-1"
                        >
                            <div className="px-3 py-2 text-xs font-semibold tracking-[0.04em] text-[var(--ink-muted)]/60">
                                {t('tabs.genericTab')}
                            </div>
                            {tabs.map((tab) => {
                                const fixedViewTitle = getFixedTabChromeTitle(tab.view, t);
                                const hasSessionTitle = tab.title && tab.title !== 'New Tab' && tab.title !== 'New Chat';
                                const displayTitle = fixedViewTitle ?? (hasSessionTitle
                                    ? tab.title
                                    : tab.agentDir
                                      ? getFolderName(tab.agentDir)
                                      : tab.title);
                                const subtitle = tab.agentDir
                                    ? getFolderName(tab.agentDir)
                                    : tab.view === 'settings'
                                      ? t('tabs.settings')
                                      : tab.view === 'taskcenter'
                                        ? t('tabs.taskCenter')
                                        : tab.view === 'space'
                                          ? t('tabs.team')
                                          : tab.view === 'workbench'
                                            ? t('tabs.workbench')
                                          : t('tabs.launcher');
                                const isActive = tab.id === activeTabId;
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        aria-label={t('tabs.switchTo', { title: displayTitle })}
                                        aria-current={isActive ? 'page' : undefined}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                                            isActive
                                                ? 'bg-[var(--accent-warm-subtle)] text-[var(--ink)]'
                                                : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                                        }`}
                                        onClick={() => handleSelectFromMenu(tab.id)}
                                    >
                                        <span
                                            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                                                tab.isGenerating
                                                    ? 'bg-[var(--success)]'
                                                    : tab.hasUnread
                                                      ? 'bg-[var(--accent-warm)]'
                                                      : isActive
                                                        ? 'bg-[var(--accent-warm)]'
                                                        : 'bg-[var(--line-strong)]'
                                            }`}
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium">{displayTitle}</span>
                                            <span className="block truncate text-xs text-[var(--ink-muted)]/70">
                                                {subtitle}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </Popover>
                    </>
                )}

                {/* New tab button - hidden when at max tabs. It sits after the overflow
                    list so extreme widths keep the recovery affordance visible first. */}
                {canAddTab && (
                    <button
                        className="flex flex-shrink-0 items-center justify-center rounded-md transition-all duration-150 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]/60 hover:text-[var(--ink)]"
                        style={{ width: TAB_BAR_BUTTON_WIDTH_PX, height: TAB_BAR_BUTTON_WIDTH_PX }}
                        onClick={onNewTab}
                        title={`${t('tabs.newTab')} (${navigator.platform.toLowerCase().includes('mac') ? '⌘T' : 'Ctrl+T'})`}
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                )}
            </div>

            <div className="h-full min-w-0 flex-1" data-tauri-drag-region aria-hidden="true" />
        </div>
    );
});
