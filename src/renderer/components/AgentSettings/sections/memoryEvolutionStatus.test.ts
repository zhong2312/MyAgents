import { describe, expect, it } from 'vitest';

import { formatMemoryEvolutionRunTime } from './memoryEvolutionStatus';

describe('formatMemoryEvolutionRunTime', () => {
  it('uses a concise relative label within 24 hours', () => {
    const now = new Date(2026, 6, 8, 12, 0).getTime();
    const executedAt = now - 23 * 3_600_000;

    expect(formatMemoryEvolutionRunTime(executedAt, now, 'zh-CN')).toBe(
      '23 小时前',
    );
  });

  it('uses an unambiguous local date after 24 hours', () => {
    const now = new Date(2026, 6, 8, 12, 0).getTime();
    const executedAt = new Date(2026, 6, 7, 9, 0).getTime();

    expect(formatMemoryEvolutionRunTime(executedAt, now, 'zh-CN')).toBe(
      '2026-07-07',
    );
  });
});
