import { describe, expect, it } from 'vitest';

import type { MessageUsage, SessionMessage } from '../types/session';
import {
  addUsageTotals,
  diffUsageTotals,
  restoreRuntimeUsageTotals,
} from '../runtimes/usage-utils';

function assistantUsage(usage: MessageUsage): SessionMessage {
  return {
    id: `assistant-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: 'ok',
    timestamp: new Date().toISOString(),
    usage,
  };
}

describe('external runtime usage utils', () => {
  it('diffs running totals into per-turn deltas', () => {
    const previousTotals: MessageUsage = {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 20,
      model: 'gpt-5-codex',
    };
    const nextTotals: MessageUsage = {
      inputTokens: 170,
      outputTokens: 65,
      cacheReadTokens: 28,
      model: 'gpt-5-codex',
    };

    expect(diffUsageTotals(previousTotals, nextTotals)).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      cacheReadTokens: 8,
      cacheCreationTokens: undefined,
      model: 'gpt-5-codex',
      modelUsage: undefined,
    });
  });

  it('does not charge unknown historical cache when a Codex fallback omits cache dimensions', () => {
    const legacyBaseline: MessageUsage = {
      inputTokens: 1_000,
      outputTokens: 100,
      model: 'gpt-5-codex',
    };
    const nextFallbackTotal: MessageUsage = {
      inputTokens: 1_100,
      outputTokens: 110,
      model: 'gpt-5-codex',
    };

    expect(diffUsageTotals(legacyBaseline, nextFallbackTotal)).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      model: 'gpt-5-codex',
      modelUsage: undefined,
    });
  });

  it('restores codex baseline from the last historical running total when metadata is missing', () => {
    const messages: SessionMessage[] = [
      assistantUsage({ inputTokens: 12, outputTokens: 2, model: 'gpt-5-codex' }),
      assistantUsage({ inputTokens: 31, outputTokens: 5, model: 'gpt-5-codex' }),
      assistantUsage({ inputTokens: 49, outputTokens: 9, model: 'gpt-5-codex' }),
    ];

    expect(restoreRuntimeUsageTotals('codex', messages, null)).toEqual({
      inputTokens: 49,
      outputTokens: 9,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      model: 'gpt-5-codex',
      modelUsage: undefined,
    });
  });

  it('adds per-turn deltas for non-codex runtimes', () => {
    const messages: SessionMessage[] = [
      assistantUsage({ inputTokens: 12, outputTokens: 2, model: 'claude-sonnet-4' }),
      assistantUsage({ inputTokens: 18, outputTokens: 3, model: 'claude-sonnet-4' }),
    ];

    expect(restoreRuntimeUsageTotals('claude-code', messages, null)).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      model: 'claude-sonnet-4',
      modelUsage: undefined,
    });
  });

  it('merges modelUsage totals across turns', () => {
    expect(addUsageTotals(
      {
        inputTokens: 10,
        outputTokens: 4,
        model: 'primary-a',
        modelUsage: {
          'primary-a': { inputTokens: 10, outputTokens: 4 },
        },
      },
      {
        inputTokens: 6,
        outputTokens: 8,
        model: 'primary-b',
        modelUsage: {
          'primary-b': { inputTokens: 6, outputTokens: 8, cacheReadTokens: 3 },
        },
      },
    )).toEqual({
      inputTokens: 16,
      outputTokens: 12,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      model: 'primary-b',
      modelUsage: {
        'primary-a': { inputTokens: 10, outputTokens: 4, cacheReadTokens: undefined, cacheCreationTokens: undefined },
        'primary-b': { inputTokens: 6, outputTokens: 8, cacheReadTokens: 3, cacheCreationTokens: undefined },
      },
    });
  });
});
