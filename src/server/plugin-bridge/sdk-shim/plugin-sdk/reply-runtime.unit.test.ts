import { describe, expect, it, vi } from 'vitest';

import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  observeReplyDispatcherIdle,
  withReplyDispatcher,
} from './reply-runtime.js';

describe('OpenClaw reply dispatcher shim contract', () => {
  it('returns synchronous admission booleans and preserves tool/block/final order', async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        delivered.push(`${info.kind}:${payload.text}`);
      },
    });

    expect(dispatcher.sendToolResult({ text: 'tool' })).toBe(true);
    expect(dispatcher.sendBlockReply({ text: 'block' })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: 'final' })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: '  ' })).toBe(false);
    dispatcher.markComplete();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(['tool:tool', 'block:block', 'final:final']);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it('does not poison later deliveries when one delivery fails', async () => {
    const delivered: string[] = [];
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async (payload: { text?: string }) => {
        if (payload.text === 'bad') throw new Error('delivery failed');
        delivered.push(payload.text ?? '');
      },
      onError,
    });

    dispatcher.sendFinalReply({ text: 'bad' });
    dispatcher.sendFinalReply({ text: 'good' });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(['good']);
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('wires typing lifecycle and settles in markComplete → idle → onSettled order', async () => {
    const events: string[] = [];
    const typing = {
      markDispatchIdle: () => { events.push('typing-idle'); },
      markRunComplete: () => { events.push('run-complete'); },
    };
    const result = createReplyDispatcherWithTyping({
      deliver: async () => { events.push('deliver'); },
      onIdle: () => { events.push('idle'); },
      onReplyStart: () => { events.push('reply-start'); },
      onCleanup: () => { events.push('cleanup'); },
    });

    result.replyOptions.onTypingController(typing);
    await result.replyOptions.onReplyStart();
    result.dispatcher.sendFinalReply({ text: 'answer' });
    result.markRunComplete();
    await withReplyDispatcher({
      dispatcher: result.dispatcher,
      run: async () => { events.push('run'); return 42; },
      onSettled: () => { events.push('settled'); },
    });

    expect(events).toEqual([
      'reply-start',
      'run-complete',
      'run',
      'deliver',
      'typing-idle',
      'idle',
      'settled',
    ]);
  });

  it('observes the plugin-owned async idle boundary even when the plugin does not await it', async () => {
    const events: string[] = [];
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>(resolve => { releaseIdle = resolve; });
    const result = createReplyDispatcherWithTyping({
      onIdle: async () => {
        events.push('idle-start');
        await idleGate;
        events.push('idle-complete');
      },
    });
    const observed = new Promise<void>(resolve => {
      observeReplyDispatcherIdle(result.dispatcher, ({ outcome }: { outcome: string }) => {
        events.push(`observed:${outcome}`);
        resolve();
      });
    });

    result.markDispatchIdle();
    expect(events).toEqual(['idle-start']);
    releaseIdle();
    await observed;

    expect(events).toEqual(['idle-start', 'idle-complete', 'observed:completed']);
  });
});
