import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TabBar from './TabBar';
import { TAB_ITEM_MIN_WIDTH_PX, getTabStripIdealWidth } from './tabBarLayout';
import { MAX_TABS, type Tab } from '@/types/tab';
import { dismissTopmost } from '@/utils/closeLayer';

function makeTab(id: string, title = id): Tab {
    return {
        id,
        agentDir: '/workspace/demo',
        sessionId: `session-${id}`,
        view: 'chat',
        title,
        sidecarConfigDisposition: 'push',
    };
}

function renderTabBar(over: Partial<React.ComponentProps<typeof TabBar>> = {}) {
    const props: React.ComponentProps<typeof TabBar> = {
        tabs: [makeTab('tab-1', 'Session 1'), makeTab('tab-2', 'Session 2')],
        activeTabId: 'tab-1',
        onSelectTab: vi.fn(),
        onCloseTab: vi.fn(),
        onNewTab: vi.fn(),
        onReorderTabs: vi.fn(),
        ...over,
    };
    const result = render(<TabBar {...props} />);
    return { ...result, ...props };
}

function setTabTrackMetrics(track: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(track, 'scrollWidth', {
        configurable: true,
        value: scrollWidth,
    });
    Object.defineProperty(track, 'clientWidth', {
        configurable: true,
        value: clientWidth,
    });
}

describe('TabBar', () => {
    beforeEach(() => {
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('raises the tab cap to 12 for Chrome-like compressed tabs', () => {
        expect(MAX_TABS).toBe(12);
    });

    it('keeps the overflow list hidden until the tab track actually overflows', () => {
        renderTabBar();
        expect(screen.queryByLabelText('所有标签页')).toBeNull();

        const track = screen.getByLabelText('打开的标签页');
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);

        expect(screen.getByLabelText('所有标签页')).toBeTruthy();
    });

    it('keeps the overflow recovery button before the new-tab button', () => {
        renderTabBar();
        const track = screen.getByLabelText('打开的标签页');
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);

        const overflowButton = screen.getByLabelText('所有标签页');
        const newTabButton = screen.getByTitle(/新建标签页/);

        expect(overflowButton.compareDocumentPosition(newTabButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('falls back to periodic overflow measurement without ResizeObserver', () => {
        const originalResizeObserver = globalThis.ResizeObserver;
        vi.useFakeTimers();
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: undefined,
        });

        const { unmount } = renderTabBar();
        try {
            const track = screen.getByLabelText('打开的标签页');
            setTabTrackMetrics(track, 600, 240);

            act(() => {
                vi.advanceTimersByTime(250);
            });

            expect(screen.getByLabelText('所有标签页')).toBeTruthy();
        } finally {
            unmount();
            if (originalResizeObserver === undefined) {
                Reflect.deleteProperty(globalThis, 'ResizeObserver');
            } else {
                Object.defineProperty(globalThis, 'ResizeObserver', {
                    configurable: true,
                    value: originalResizeObserver,
                });
            }
            vi.useRealTimers();
        }
    });

    it('uses a compressed tab minimum width for the 12-tab layout', () => {
        renderTabBar();
        expect((screen.getByText('Session 1').closest('[data-tab-id]') as HTMLElement).style.minWidth)
            .toBe(`${TAB_ITEM_MIN_WIDTH_PX}px`);
    });

    it('shows only the session title once a chat has a real title', () => {
        renderTabBar({ tabs: [makeTab('tab-1', 'Session 1')] });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        const sessionTitle = within(tab).getByText('Session 1');
        const titleHandle = sessionTitle.parentElement as HTMLElement;

        expect(tab).toHaveClass('text-[var(--ink)]');
        expect(titleHandle.getAttribute('class')).toBe('flex min-w-0 flex-1 items-center text-xs font-medium select-none');
        expect(titleHandle).not.toHaveAttribute('style');
        expect(sessionTitle.parentElement).toBe(titleHandle);
        expect(sessionTitle.getAttribute('class')).toBe('min-w-0 truncate');
        expect(sessionTitle).not.toHaveAttribute('style');
        expect(within(tab).queryByText('demo')).toBeNull();
        expect(tab.querySelector('[data-tab-title-divider]')).toBeNull();
        expect(tab).toHaveAttribute('title', 'demo — Session 1');
        expect(tab).toHaveAccessibleName('demo, Session 1');
    });

    it('lets the session title inherit the inactive and hover colors from the tab', () => {
        renderTabBar({ activeTabId: 'tab-2' });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        const sessionTitle = within(tab).getByText('Session 1');

        expect(tab).toHaveClass('text-[var(--ink-muted)]', 'hover:bg-[var(--hover-bg)]', 'hover:text-[var(--ink)]');
        expect(sessionTitle.className).not.toContain('text-[var(--ink');
    });

    it('uses the shared hover wash and proportional radius for the active tab', () => {
        renderTabBar();

        const activeTab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        expect(activeTab).toHaveClass('h-8', 'rounded-md', 'bg-[var(--hover-bg)]', 'text-[var(--ink)]');
        expect(activeTab).not.toHaveClass('rounded-lg', 'bg-[var(--paper-inset)]', 'shadow-sm');
        expect(activeTab.querySelector('[data-tab-active-indicator]')).toHaveClass('bg-[var(--accent)]/70');
    });

    it('uses the shared hover wash for titlebar auxiliary actions', () => {
        renderTabBar();
        const newTabButton = screen.getByTitle(/新建标签页/);
        expect(newTabButton).toHaveClass('hover:bg-[var(--hover-bg)]');
        expect(newTabButton).not.toHaveClass('hover:bg-[var(--paper-inset)]/60');

        const track = screen.getByLabelText('打开的标签页');
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);
        const overflowButton = screen.getByLabelText('所有标签页');
        expect(overflowButton).toHaveClass('hover:bg-[var(--hover-bg)]');

        fireEvent.click(overflowButton);
        expect(overflowButton).toHaveClass('bg-[var(--hover-bg)]');
        expect(overflowButton).not.toHaveClass('bg-[var(--paper-inset)]');
    });

    it('does not repeat the workspace when it matches the session title', () => {
        const sameNameTab = {
            ...makeTab('tab-1', 'demo'),
            agentDir: '/workspace/demo',
        };
        renderTabBar({ tabs: [sameNameTab] });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        expect(within(tab).getAllByText('demo')).toHaveLength(1);
        expect(tab.querySelector('[data-tab-title-divider]')).toBeNull();
        expect(tab).toHaveAttribute('title', 'demo — demo');
        expect(tab).toHaveAccessibleName('demo, demo');
    });

    it.each(['New Tab', 'New Chat'])('shows only the workspace before a session gets a real %s title', (title) => {
        renderTabBar({ tabs: [makeTab('tab-1', title)] });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        expect(within(tab).getByText('demo')).toBeTruthy();
        expect(within(tab).queryByText(title)).toBeNull();
        expect(tab.querySelector('[data-tab-title-divider]')).toBeNull();
        expect(tab).toHaveAttribute('title', 'demo');
    });

    it('does not prefix fixed product tabs with workspace context', () => {
        const settingsTab = { ...makeTab('tab-1', 'Ignored session title'), view: 'settings' as const };
        renderTabBar({ tabs: [settingsTab] });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        expect(within(tab).getByText('设置')).toBeTruthy();
        expect(within(tab).queryByText('demo')).toBeNull();
        expect(tab.querySelector('[data-tab-title-divider]')).toBeNull();
    });

    it('gives the full title width to a long session title', () => {
        const tabWithLongLabels = {
            ...makeTab('tab-1', 'A generated title that must keep the remaining tab width'),
            agentDir: '/workspace/a-very-long-agent-workspace-name',
        };
        renderTabBar({ tabs: [tabWithLongLabels] });

        const tab = document.querySelector('[data-tab-id="tab-1"]') as HTMLElement;
        expect(within(tab).getByText('A generated title that must keep the remaining tab width'))
            .toHaveClass('min-w-0', 'truncate');
        expect(within(tab).queryByText('a-very-long-agent-workspace-name')).toBeNull();
    });

    it('selects tabs on mouse down so drag click capture cannot swallow tab switching', () => {
        const props = renderTabBar();

        fireEvent.mouseDown(screen.getByText('Session 2'), { button: 0 });

        expect(props.onSelectTab).toHaveBeenCalledWith('tab-2');
    });

    it('sizes the occupied tab strip from tab count, not title content', () => {
        const shortTabs = [makeTab('tab-1', 'A'), makeTab('tab-2', 'B')];
        const longTabs = [
            makeTab('tab-1', 'A generated title that arrives after the first turn'),
            makeTab('tab-2', 'Another much longer generated session title'),
        ];
        const { rerender, ...props } = renderTabBar({ tabs: shortTabs });

        const strip = screen.getByTestId('tabbar-layout-strip');
        const initialWidth = strip.style.width;
        expect(initialWidth).toBe(`${getTabStripIdealWidth(shortTabs.length, { canAddTab: true })}px`);

        rerender(<TabBar {...props} tabs={longTabs} />);

        expect(screen.getByTestId('tabbar-layout-strip').style.width).toBe(initialWidth);
    });

    it('lists all tabs in the overflow menu and switches from the menu', () => {
        const props = renderTabBar();
        const track = screen.getByLabelText('打开的标签页');
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);

        fireEvent.click(screen.getByLabelText('所有标签页'));
        expect(screen.getByRole('button', { name: '切换到 Session 1' })).toHaveAttribute('aria-current', 'page');
        fireEvent.click(screen.getByRole('button', { name: '切换到 Session 2' }));

        expect(props.onSelectTab).toHaveBeenCalledWith('tab-2');
    });

    it('registers the overflow menu with the close-layer stack', () => {
        renderTabBar();
        const track = screen.getByLabelText('打开的标签页');
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);

        fireEvent.click(screen.getByLabelText('所有标签页'));
        expect(screen.getByRole('button', { name: '切换到 Session 2' })).toBeTruthy();

        act(() => {
            expect(dismissTopmost()).toBe(true);
        });

        expect(screen.queryByRole('button', { name: '切换到 Session 2' })).toBeNull();
    });

    it('maps vertical wheel movement to horizontal scroll as an overflow fallback', () => {
        renderTabBar();
        const track = screen.getByLabelText('打开的标签页') as HTMLDivElement;
        setTabTrackMetrics(track, 600, 240);
        fireEvent.scroll(track);

        fireEvent.wheel(track, { deltaY: 72, deltaX: 0 });

        expect(track.scrollLeft).toBe(72);
    });
});
