import { afterEach, describe, expect, it, vi } from 'vitest';

import { attemptFileRewind, summarizeFileRewindResult } from './rewind-file-result';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('summarizeFileRewindResult', () => {
  it('marks a successful checkpoint restoration complete', () => {
    expect(summarizeFileRewindResult({ canRewind: true, skippedLinks: 0 })).toEqual({
      fileRewindStatus: 'complete',
      skippedLinks: 0,
    });
  });

  it('marks link-safe omissions as a partial restoration', () => {
    expect(summarizeFileRewindResult({ canRewind: true, skippedLinks: 2 })).toEqual({
      fileRewindStatus: 'partial',
      skippedLinks: 2,
    });
  });

  it('marks an SDK refusal failed and rejects malformed counts', () => {
    expect(summarizeFileRewindResult({ canRewind: false, skippedLinks: 2 })).toEqual({
      fileRewindStatus: 'failed',
      skippedLinks: 0,
    });
    expect(summarizeFileRewindResult({ canRewind: true, skippedLinks: -1 })).toEqual({
      fileRewindStatus: 'complete',
      skippedLinks: 0,
    });
  });

  it.each([
    { query: null, targetUserUuid: 'user-1', abortRequested: false, isCurrentSessionUuid: true },
    { query: { rewindFiles: vi.fn() }, targetUserUuid: undefined, abortRequested: false, isCurrentSessionUuid: false },
    { query: { rewindFiles: vi.fn() }, targetUserUuid: 'stale', abortRequested: false, isCurrentSessionUuid: false },
    { query: { rewindFiles: vi.fn() }, targetUserUuid: 'user-1', abortRequested: true, isCurrentSessionUuid: true },
  ])('does not attempt file rewind without a usable live checkpoint: %o', async (input) => {
    await expect(attemptFileRewind(input)).resolves.toEqual({
      fileRewindStatus: 'not_attempted',
      skippedLinks: 0,
      attempted: false,
    });
    if (input.query) expect(input.query.rewindFiles).not.toHaveBeenCalled();
  });

  it('maps SDK rejection to an independent file rewind failure', async () => {
    const query = { rewindFiles: vi.fn(async () => { throw new Error('secret provider body'); }) };

    await expect(attemptFileRewind({
      query,
      targetUserUuid: 'user-1',
      abortRequested: false,
      isCurrentSessionUuid: true,
    })).resolves.toEqual({
      fileRewindStatus: 'failed',
      skippedLinks: 0,
      attempted: true,
    });
  });

  it('maps timeout to failure and does not wait for an unresponsive SDK call', async () => {
    vi.useFakeTimers();
    const query = { rewindFiles: vi.fn(() => new Promise<never>(() => {})) };
    const attempt = attemptFileRewind({
      query,
      targetUserUuid: 'user-1',
      abortRequested: false,
      isCurrentSessionUuid: true,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(attempt).resolves.toEqual({
      fileRewindStatus: 'failed',
      skippedLinks: 0,
      attempted: true,
    });
  });
});
