import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchJsonLargeValueRef } from './largeValueRef';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchJsonLargeValueRef', () => {
  it('uses native fetch for a 300KiB ref body instead of the Tauri IPC proxy', async () => {
    const payload = { changes: [{ diff: 'x'.repeat(300 * 1024) }] };
    const nativeFetch = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', nativeFetch);

    await expect(fetchJsonLargeValueRef('http://127.0.0.1:4182', {
      kind: 'ref',
      id: 'a1b2c3d4',
      mimetype: 'application/json; charset=utf-8',
    })).resolves.toEqual(payload);
    expect(nativeFetch).toHaveBeenCalledWith('http://127.0.0.1:4182/refs/a1b2c3d4');
  });
});
