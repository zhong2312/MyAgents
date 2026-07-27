import { describe, expect, it } from 'vitest';

import { normalizeCronTaskFieldUpdate } from './cronTaskClient';

describe('normalizeCronTaskFieldUpdate', () => {
  it('drops stale intervalMinutes when an explicit cron expression owns the schedule', () => {
    expect(normalizeCronTaskFieldUpdate({
      schedule: { kind: 'cron', expr: '30 6 * * *', tz: 'Asia/Shanghai' },
      intervalMinutes: 60,
    })).toEqual({
      schedule: { kind: 'cron', expr: '30 6 * * *', tz: 'Asia/Shanghai' },
    });
  });

  it('uses the schedule minutes as the interval for every schedules', () => {
    expect(normalizeCronTaskFieldUpdate({
      schedule: { kind: 'every', minutes: 15 },
      intervalMinutes: 60,
    })).toEqual({
      schedule: { kind: 'every', minutes: 15 },
      intervalMinutes: 15,
    });
  });

  it('preserves interval-only compatibility updates', () => {
    expect(normalizeCronTaskFieldUpdate({
      intervalMinutes: 45,
    })).toEqual({
      intervalMinutes: 45,
    });
  });
});
