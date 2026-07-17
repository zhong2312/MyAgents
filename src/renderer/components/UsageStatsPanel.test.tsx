import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalStats } from '@/api/sessionClient';
import UsageStatsPanel from './UsageStatsPanel';

const mocks = vi.hoisted(() => ({
    getGlobalStats: vi.fn(),
    getAllProviders: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
    getGlobalStats: mocks.getGlobalStats,
}));

vi.mock('@/config/services/providerService', () => ({
    getAllProviders: mocks.getAllProviders,
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function statsFor(label: string, inputTokens: number): GlobalStats {
    return {
        summary: {
            totalSessions: 1,
            turnCount: 1,
            humanQueryCount: 1,
            totalInputTokens: inputTokens,
            totalOutputTokens: 100,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
        },
        daily: [{
            date: '2026-07-17',
            inputTokens,
            outputTokens: 100,
            turnCount: 1,
            humanQueryCount: 1,
        }],
        byModel: {
            [label]: {
                model: label,
                providerId: 'provider-a',
                inputTokens,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                count: 1,
            },
        },
    };
}

beforeEach(() => {
    mocks.getGlobalStats.mockReset();
    mocks.getAllProviders.mockReset();
    mocks.getAllProviders.mockResolvedValue([{ id: 'provider-a', vendor: 'Vendor A', name: 'Provider A' }]);
});

describe('UsageStatsPanel range refresh', () => {
    it('keeps prior data visible while refreshing and loads provider labels only once', async () => {
        const initial = deferred<GlobalStats | null>();
        const sevenDays = deferred<GlobalStats | null>();
        mocks.getGlobalStats
            .mockReturnValueOnce(initial.promise)
            .mockReturnValueOnce(sevenDays.promise);

        render(<UsageStatsPanel />);
        expect(mocks.getGlobalStats).toHaveBeenCalledWith('30d');
        expect(screen.getByRole('status')).toHaveTextContent('加载中...');

        await act(async () => initial.resolve(statsFor('model-30d', 30_000)));
        expect(await screen.findByText('model-30d')).toBeInTheDocument();
        expect(await screen.findByText('Provider A')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '7天' }));
        expect(mocks.getGlobalStats).toHaveBeenLastCalledWith('7d');
        expect(screen.getByText('model-30d')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('加载中...');

        await act(async () => sevenDays.resolve(statsFor('model-7d', 7_000)));
        expect(await screen.findByText('model-7d')).toBeInTheDocument();
        expect(screen.queryByText('model-30d')).not.toBeInTheDocument();
        expect(mocks.getAllProviders).toHaveBeenCalledTimes(1);
    });

    it('does not present stale-range data as current after a refresh fails', async () => {
        mocks.getGlobalStats
            .mockResolvedValueOnce(statsFor('model-30d', 30_000))
            .mockResolvedValueOnce(null);

        render(<UsageStatsPanel />);
        expect(await screen.findByText('model-30d')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '7天' }));
        expect(await screen.findByText('无法加载统计数据')).toBeInTheDocument();
        expect(screen.queryByText('model-30d')).not.toBeInTheDocument();
    });

    it('ignores an obsolete range response that resolves after the latest selection', async () => {
        const sevenDays = deferred<GlobalStats | null>();
        const sixtyDays = deferred<GlobalStats | null>();
        mocks.getGlobalStats
            .mockResolvedValueOnce(statsFor('model-30d', 30_000))
            .mockReturnValueOnce(sevenDays.promise)
            .mockReturnValueOnce(sixtyDays.promise);

        render(<UsageStatsPanel />);
        expect(await screen.findByText('model-30d')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '7天' }));
        fireEvent.click(screen.getByRole('button', { name: '60天' }));

        await act(async () => sixtyDays.resolve(statsFor('model-60d', 60_000)));
        expect(await screen.findByText('model-60d')).toBeInTheDocument();

        await act(async () => sevenDays.resolve(statsFor('obsolete-model-7d', 7_000)));
        expect(screen.getByText('model-60d')).toBeInTheDocument();
        expect(screen.queryByText('obsolete-model-7d')).not.toBeInTheDocument();
    });
});
