import { render, screen } from '@testing-library/react';
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
                isCronProtected={false}
                onClick={vi.fn()}
                onShowStats={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        expect(screen.getByText('昨天')).toBeInTheDocument();
        expect(screen.queryByText('08:00')).not.toBeInTheDocument();
    });
});
