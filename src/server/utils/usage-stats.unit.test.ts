import { describe, expect, it } from 'vitest';

import type { SessionData, SessionMessage } from '../types/session';
import {
  addMessageUsageToByModel,
  aggregateGlobalUsageStats,
  buildSessionDetailedUsageStats,
  type UsageByModel,
} from './usage-stats';

function session(
  id: string,
  messages: SessionMessage[],
  options: Partial<SessionData> = {},
): SessionData {
  return {
    id,
    agentDir: '/tmp/workspace',
    title: id,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    messages,
    ...options,
  };
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  timestamp: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  return { id, role, content, timestamp, ...extra };
}

describe('usage stats provider-qualified model aggregation', () => {
  it('keeps the same model id separate for different providers', () => {
    const byModel: UsageByModel = {};

    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        model: 'deepseek-v4-flash',
      },
    }, 'deepseek');
    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 20,
        outputTokens: 4,
        model: 'deepseek-v4-flash',
      },
    }, 'sensenova');

    expect(Object.values(byModel)).toEqual([
      expect.objectContaining({
        providerId: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 10,
        outputTokens: 2,
        count: 1,
      }),
      expect.objectContaining({
        providerId: 'sensenova',
        model: 'deepseek-v4-flash',
        inputTokens: 20,
        outputTokens: 4,
        count: 1,
      }),
    ]);
  });

  it('prefers per-message provider identity over session fallback', () => {
    const byModel: UsageByModel = {};

    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 8,
        outputTokens: 1,
        providerId: 'turn-provider',
        modelUsage: {
          'deepseek-v4-flash': {
            inputTokens: 8,
            outputTokens: 1,
          },
        },
      },
    }, 'session-provider');

    expect(Object.values(byModel)).toEqual([
      expect.objectContaining({
        providerId: 'turn-provider',
        model: 'deepseek-v4-flash',
        inputTokens: 8,
        outputTokens: 1,
        count: 1,
      }),
    ]);
  });
});

describe('aggregateGlobalUsageStats', () => {
  const cutoff = Date.parse('2026-07-10T00:00:00.000Z');

  it('uses exact message timestamps instead of session lastActiveAt', () => {
    const stats = aggregateGlobalUsageStats([
      session('stale-meta', [
        message('u1', 'user', 'inside range', '2026-07-10T00:00:00.000Z'),
        message('a1', 'assistant', 'answer', '2026-07-10T00:00:00.001Z', {
          usage: { inputTokens: 10, outputTokens: 2, model: 'model-a' },
        }),
      ], { lastActiveAt: '2020-01-01T00:00:00.000Z' }),
      session('recent-meta-old-rows', [
        message('u2', 'user', 'outside range', '2026-07-09T23:59:59.999Z'),
      ], { lastActiveAt: '2026-07-15T00:00:00.000Z' }),
    ], cutoff);

    expect(stats.summary).toMatchObject({
      totalSessions: 1,
      turnCount: 1,
      humanQueryCount: 1,
      totalInputTokens: 10,
      totalOutputTokens: 2,
    });
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]).toMatchObject({ turnCount: 1, humanQueryCount: 1 });
    expect(Object.values(stats.byModel)[0]).toMatchObject({ model: 'model-a', count: 1 });
  });

  it('separates all turns from human queries', () => {
    const stats = aggregateGlobalUsageStats([
      session('human', [
        message('human-user', 'user', 'hello', '2026-07-11T00:00:00.000Z'),
      ], { origin: { kind: 'desktop', surface: 'launcher_input' } }),
      session('space', [
        message(
          'space-user',
          'user',
          '<system-reminder><myagents-space-issue>secret</myagents-space-issue></system-reminder>Visible issue update',
          '2026-07-11T00:00:01.000Z',
        ),
      ], { origin: { kind: 'registered-agent', surface: 'space_issue_delivery', context: { spaceId: 'space-1', registeredAgentId: 'ra-1' } } }),
    ], cutoff);

    expect(stats.summary).toMatchObject({
      totalSessions: 2,
      turnCount: 2,
      humanQueryCount: 1,
    });
    expect(stats.daily[0]).toMatchObject({ turnCount: 2, humanQueryCount: 1 });
  });
});

describe('buildSessionDetailedUsageStats', () => {
  it('never exposes hidden reminder payload and preserves visible or attachment triggers', () => {
    const stats = buildSessionDetailedUsageStats(session('space', [
      message(
        'hidden-user',
        'user',
        '<system-reminder><myagents-space-issue>secret issue instructions</myagents-space-issue></system-reminder>',
        '2026-07-11T00:00:00.000Z',
      ),
      message('hidden-answer', 'assistant', 'done', '2026-07-11T00:00:01.000Z', {
        usage: { inputTokens: 4, outputTokens: 1, model: 'model-a' },
      }),
      message('attachment-user', 'user', '', '2026-07-11T00:00:02.000Z', {
        attachments: [{ id: 'a1', name: 'diagram.png', mimeType: 'image/png', path: 'diagram.png' }],
      }),
      message('attachment-answer', 'assistant', 'described', '2026-07-11T00:00:03.000Z', {
        usage: { inputTokens: 5, outputTokens: 2, model: 'model-a' },
      }),
      message(
        'visible-space-user',
        'user',
        '<system-reminder><myagents-space-issue>more secrets</myagents-space-issue></system-reminder>Visible issue update',
        '2026-07-11T00:00:04.000Z',
      ),
      message('visible-answer', 'assistant', 'updated', '2026-07-11T00:00:05.000Z', {
        usage: { inputTokens: 6, outputTokens: 3, model: 'model-a' },
      }),
    ], { origin: { kind: 'registered-agent', surface: 'space_issue_delivery', context: { spaceId: 'space-1', registeredAgentId: 'ra-1' } } }));

    expect(stats.summary).toMatchObject({ turnCount: 3, humanQueryCount: 0 });
    expect(stats.details.map(detail => detail.turnTrigger)).toEqual([
      '',
      '📎 diagram.png',
      'Visible issue update',
    ]);
    expect(JSON.stringify(stats)).not.toContain('secret issue instructions');
    expect(JSON.stringify(stats)).not.toContain('more secrets');
  });
});
