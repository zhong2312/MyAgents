import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionSearchHit } from '@/api/searchClient';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';

import SessionSearchItem from './SessionSearchItem';

function hit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
    return {
        sessionId: 's1',
        title: 'Search Hit',
        agentDir: '/workspace',
        score: 1,
        matchType: 'title',
        snippet: null,
        snippetHighlights: [],
        titleHighlights: [],
        matchedRole: null,
        lastActiveAt: new Date(2026, 5, 20, 8, 0).toISOString(),
        source: 'desktop',
        turnCount: 1,
        ...overrides,
    };
}

function session(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
        id: 's1',
        agentDir: '/workspace',
        title: 'Search Hit',
        createdAt: new Date(2026, 5, 19, 18, 0).toISOString(),
        lastActiveAt: new Date(2026, 5, 19, 22, 0).toISOString(),
        ...overrides,
    };
}

const project: Project = {
    id: 'p1',
    name: 'Workspace',
    path: '/workspace',
    providerId: null,
    permissionMode: null,
};

describe('SessionSearchItem', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('formats time from fresh session metadata before falling back to the search index hit', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 5, 20, 9, 0));

        render(
            <SessionSearchItem
                hit={hit()}
                session={session()}
                project={project}
                deleteProtected={false}
                onClick={vi.fn()}
                onContextMenu={vi.fn()}
                onShowStats={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        expect(screen.getByText('昨天')).toBeInTheDocument();
        expect(screen.queryByText('08:00')).not.toBeInTheDocument();
    });

    it('suppresses right-click selection and forwards the context-menu request', () => {
        const onContextMenu = vi.fn((event: React.MouseEvent) => event.preventDefault());
        render(
            <SessionSearchItem
                hit={hit()}
                session={session()}
                project={project}
                deleteProtected={false}
                onClick={vi.fn()}
                onContextMenu={onContextMenu}
                onShowStats={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        const row = screen.getByText('Search Hit').closest<HTMLElement>('[data-history-search-session-row]')!;
        expect(row).toHaveClass('select-none');

        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
        fireEvent(row, mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);

        const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        fireEvent(row, contextMenu);
        expect(contextMenu.defaultPrevented).toBe(true);
        expect(onContextMenu).toHaveBeenCalledOnce();
    });
});
