import { beforeEach, describe, expect, it } from 'vitest';

import { imRequestRegistry } from './im-request-registry';

describe('ImRequestRegistry cancellation ownership', () => {
  beforeEach(() => {
    imRequestRegistry.clear();
  });

  it('keeps cancellation with the enqueue route until runtime admission succeeds', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');

    expect(entry.cancellationOwner).toBe('admission-route');
    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'claimed',
      owner: 'admission-route',
    });
    expect(entry.abortController.signal.aborted).toBe(true);
  });

  it('transfers cancellation ownership to the runtime after admission', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');

    imRequestRegistry.transferCancellationToRuntime('request-1');

    expect(entry.cancellationOwner).toBe('runtime');
    expect(entry.status).toBe('running');
  });

  it('gives overlapping runtime cancellation calls one atomic claim', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');
    imRequestRegistry.transferCancellationToRuntime('request-1');

    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'claimed',
      owner: 'runtime',
    });
    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'already-claimed',
      owner: 'runtime',
    });
    expect(imRequestRegistry.get('request-1')).toBe(entry);
    expect(entry.abortController.signal.aborted).toBe(true);
  });
});
