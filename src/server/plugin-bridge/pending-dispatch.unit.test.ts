import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abortPendingDispatch,
  bindPendingStream,
  clearAllPendingDispatches,
  completePendingDispatch,
  enqueueBlockBoundary,
  enqueuePartial,
  enqueueRunStart,
  getPendingDispatch,
  registerPendingDispatch,
} from './pending-dispatch';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  clearAllPendingDispatches();
});

describe('request-scoped pending dispatch transport', () => {
  it('allows concurrent requests in the same chat without superseding either', async () => {
    const delivered: string[] = [];
    const first = registerPendingDispatch('request-1', 'same-chat', {
      sendFinalReply: payload => { delivered.push(`one:${payload.text}`); return true; },
    });
    const second = registerPendingDispatch('request-2', 'same-chat', {
      sendFinalReply: payload => { delivered.push(`two:${payload.text}`); return true; },
    });

    completePendingDispatch('request-2', [{ text: 'B' }]);
    completePendingDispatch('request-1', [{ text: 'A' }]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { queuedFinal: 1, counts: { final: 1 } },
      { queuedFinal: 1, counts: { final: 1 } },
    ]);
    expect(delivered).toEqual(['two:B', 'one:A']);
  });

  it('settles even when optional dispatcher diagnostics throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const completion = registerPendingDispatch('request-1', 'chat-1', {
        sendFinalReply: () => true,
        getQueuedCounts: () => { throw new Error('diagnostics unavailable'); },
      });

      completePendingDispatch('request-1', [{ text: 'answer' }]);
      await expect(completion).resolves.toEqual({
        queuedFinal: 1,
        counts: { final: 1 },
      });
      expect(getPendingDispatch('request-1')).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('serializes callbacks and only replaces adjacent snapshots for the same stream and lane', async () => {
    const firstPartial = deferred();
    const events: string[] = [];
    let concurrency = 0;
    let maxConcurrency = 0;
    let partialCalls = 0;
    const completion = registerPendingDispatch('request-1', 'chat-1', {
      onReplyStart: () => { events.push('start'); },
      onPartialReply: async payload => {
        concurrency += 1;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        partialCalls += 1;
        events.push(`partial:${payload.text}`);
        if (partialCalls === 1) await firstPartial.promise;
        concurrency -= 1;
      },
      sendFinalReply: payload => { events.push(`final:${payload.text}`); return true; },
    });

    enqueueRunStart('request-1');
    bindPendingStream('request-1', 'stream-1');
    enqueuePartial('stream-1', { text: 'snapshot-0' }, 'answer');
    await vi.waitFor(() => expect(partialCalls).toBe(1));
    for (let i = 1; i <= 100; i += 1) {
      enqueuePartial('stream-1', { text: `snapshot-${i}` }, 'answer');
    }
    enqueueBlockBoundary('stream-1');
    completePendingDispatch('request-1', [{ text: 'final' }]);

    expect(getPendingDispatch('request-1')?.partialCoalesced).toBe(99);
    firstPartial.resolve();
    await completion;

    expect(events).toEqual(['start', 'partial:snapshot-0', 'partial:snapshot-100', 'final:final']);
    expect(maxConcurrency).toBe(1);
  });

  it('treats block boundaries as barriers and forwards canonical finals unchanged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const completion = registerPendingDispatch('request-1', 'chat-1', {
      onPartialReply: payload => { events.push({ kind: 'partial', payload }); },
      sendFinalReply: payload => { events.push({ kind: 'final', payload }); return true; },
    });

    bindPendingStream('request-1', 'stream-1');
    enqueuePartial('stream-1', { text: 'first block' }, 'answer');
    enqueueBlockBoundary('stream-1');
    bindPendingStream('request-1', 'stream-2');
    enqueuePartial('stream-2', { text: 'second block' }, 'answer');
    try {
      completePendingDispatch('request-1', [
        { mediaUrl: 'attachment://one' },
        { text: 'answer' },
        { text: 'independent error', isError: true },
      ]);

      await expect(completion).resolves.toEqual({ queuedFinal: 3, counts: { final: 3 } });
      expect(events).toEqual([
        { kind: 'partial', payload: { text: 'first block' } },
        { kind: 'partial', payload: { text: 'second block' } },
        { kind: 'final', payload: { mediaUrl: 'attachment://one' } },
        { kind: 'final', payload: { text: 'answer' } },
        { kind: 'final', payload: { text: 'independent error', isError: true } },
      ]);
      const canonical = log.mock.calls
        .map(args => args.join(' '))
        .filter(message => message.includes('[pending-dispatch] canonical_final'));
      expect(canonical).toHaveLength(1);
      expect(canonical[0]).toMatch(/outcome=completed count=3 chars=24 hash=[a-f0-9]{12}$/);
      expect(canonical[0]).not.toContain('answer');
      expect(canonical.some(message => message.includes('first block'))).toBe(false);
      expect(canonical.some(message => message.includes('second block'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('drops queued replaceable partials on abort, delivers the terminal payload, and resolves normally', async () => {
    const firstPartial = deferred();
    const events: string[] = [];
    let partialCalls = 0;
    const completion = registerPendingDispatch('request-1', 'chat-1', {
      onPartialReply: async payload => {
        partialCalls += 1;
        events.push(`partial:${payload.text}`);
        if (partialCalls === 1) await firstPartial.promise;
      },
      sendFinalReply: payload => { events.push(`final:${payload.text}:${payload.isError}`); return true; },
    });

    bindPendingStream('request-1', 'stream-1');
    enqueuePartial('stream-1', { text: 'in-flight' }, 'answer');
    await vi.waitFor(() => expect(partialCalls).toBe(1));
    enqueuePartial('stream-1', { text: 'replaceable' }, 'answer');
    abortPendingDispatch('request-1', { text: '🛑 已取消', isError: true });
    firstPartial.resolve();

    await expect(completion).resolves.toEqual({ queuedFinal: 1, counts: { final: 1 } });
    expect(events).toEqual(['partial:in-flight', 'final:🛑 已取消:true']);
  });

  it('seals on a progress callback failure, attempts one safe final, and resolves normally', async () => {
    const events: string[] = [];
    const completion = registerPendingDispatch('request-1', 'chat-1', {
      onPartialReply: () => {
        events.push('partial');
        throw new Error('controller unavailable');
      },
      sendFinalReply: payload => {
        events.push(`final:${payload.text}:${payload.isError}`);
        return true;
      },
    }, 'openclaw-lark');

    bindPendingStream('request-1', 'stream-1');
    enqueuePartial('stream-1', { text: 'snapshot' }, 'answer');
    enqueueBlockBoundary('stream-1');
    completePendingDispatch('request-1', [{ text: 'producer final' }]);

    await expect(completion).resolves.toMatchObject({ queuedFinal: 1 });
    expect(events).toEqual(['partial', 'final:⚠️ 回复投递失败，请稍后重试。:true']);
    expect(getPendingDispatch('request-1')).toBeUndefined();
  });

  it('fails fast for a missing or late stream instead of creating fallback state', () => {
    expect(() => enqueuePartial('missing-stream', { text: 'late' }, 'answer'))
      .toThrow(/protocol_dispatch_missing/);
  });
});
