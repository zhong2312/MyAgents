import { describe, expect, it, vi } from 'vitest';

import { installReactPerformanceGuard } from './reactPerformanceGuard';

describe('installReactPerformanceGuard', () => {
  it('removes React component detail before measuring and evicts its entries', () => {
    const entries = [{ name: '\u200bMessageList' }, { name: 'app-work' }];
    const measure = vi.fn(() => undefined as never);
    const clearMeasures = vi.fn();
    const performance = {
      measure,
      clearMeasures,
      getEntriesByType: vi.fn(() => entries),
    } as unknown as Performance;

    const restore = installReactPerformanceGuard(performance);
    performance.measure('\u200bMessageList', {
      start: 10,
      end: 20,
      detail: { huge: 'payload' },
    } as PerformanceMeasureOptions);
    performance.measure('app-work', { start: 1, end: 2 });

    expect(measure).toHaveBeenNthCalledWith(1, '\u200bMessageList', { start: 10, end: 20 });
    expect(measure).toHaveBeenNthCalledWith(2, 'app-work', { start: 1, end: 2 });
    expect(clearMeasures).toHaveBeenCalledWith('\u200bMessageList');
    expect(clearMeasures).not.toHaveBeenCalledWith('app-work');
    restore();
  });
});

