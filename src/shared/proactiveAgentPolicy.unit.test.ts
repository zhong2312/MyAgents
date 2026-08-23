import { describe, expect, it } from 'vitest';
import { buildProactiveAgentTogglePatch } from './proactiveAgentPolicy';

describe('buildProactiveAgentTogglePatch', () => {
  it('creates all child configs and enables them together', () => {
    expect(buildProactiveAgentTogglePatch({ enabled: false }, true)).toMatchObject({
      enabled: true,
      heartbeat: { enabled: true, intervalMinutes: 240 },
      memoryAutoUpdate: { enabled: true, intervalHours: 24 },
      memoryEvolution: { enabled: true },
    });
  });

  it('disables every child without losing customized fields or run history', () => {
    const patch = buildProactiveAgentTogglePatch({
      enabled: true,
      heartbeat: {
        enabled: true,
        intervalMinutes: 48,
        activeHours: { start: '07:00', end: '23:00', timezone: 'Europe/Paris' },
        ackMaxChars: 512,
      },
      memoryAutoUpdate: {
        enabled: true,
        intervalHours: 72,
        queryThreshold: 9,
        updateWindowStart: '20:00',
        updateWindowEnd: '08:00',
        lastBatchAt: '2026-08-14T00:00:00Z',
        lastBatchSessionCount: 7,
      },
      memoryEvolution: {
        enabled: false,
        lastGardenerAt: '2026-08-14T01:00:00Z',
        lastGardenerStatus: 'completed',
      },
    }, false);

    expect(patch).toEqual({
      enabled: false,
      heartbeat: {
        enabled: false,
        intervalMinutes: 48,
        activeHours: { start: '07:00', end: '23:00', timezone: 'Europe/Paris' },
        ackMaxChars: 512,
      },
      memoryAutoUpdate: {
        enabled: false,
        intervalHours: 72,
        queryThreshold: 9,
        updateWindowStart: '20:00',
        updateWindowEnd: '08:00',
        updateWindowTimezone: undefined,
        lastBatchAt: '2026-08-14T00:00:00Z',
        lastBatchSessionCount: 7,
      },
      memoryEvolution: {
        enabled: false,
        lastGardenerAt: '2026-08-14T01:00:00Z',
        lastGardenerStatus: 'completed',
      },
    });
  });
});
