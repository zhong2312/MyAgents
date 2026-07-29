import { describe, expect, it, vi } from 'vitest';

import type { UnifiedEvent } from './types';
import { ClaudeCodeRuntime } from './claude-code';

describe('Claude Code NDJSON log ownership', () => {
  it('delivers all delta kinds without first-N or every-N payload logging', async () => {
    const frames = [
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'thinking' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: 'secret-thinking-delta' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: 'secret-tool-delta' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'secret-text-delta' },
        },
      }),
      ...Array.from({ length: 44 }, (_, index) => JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `filler-${index}` },
        },
      })),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'secret-every-50-delta' },
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'composed final answer' }),
    ];
    expect(frames).toHaveLength(51);
    const rawLines = frames.join('\n') + '\n';
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(rawLines));
        controller.close();
      },
    });
    const events: UnifiedEvent[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runtime = new ClaudeCodeRuntime();

    try {
      await (runtime as unknown as {
        readEvents: (
          stream: ReadableStream<Uint8Array>,
          onEvent: (event: UnifiedEvent) => void,
          handle: { exited: boolean },
        ) => Promise<void>;
      }).readEvents(stdout, event => events.push(event), { exited: false });

      expect(events).toContainEqual({ kind: 'thinking_delta', text: 'secret-thinking-delta', index: 1 });
      expect(events).toContainEqual({ kind: 'tool_input_delta', toolUseId: 'tool-1', delta: 'secret-tool-delta' });
      expect(events).toContainEqual({ kind: 'text_delta', text: 'secret-text-delta' });
      expect(events).toContainEqual({ kind: 'text_delta', text: 'secret-every-50-delta' });
      const messages = log.mock.calls.map(args => args.join(' '));
      expect(messages.some(message => message.includes('secret-thinking-delta'))).toBe(false);
      expect(messages.some(message => message.includes('secret-tool-delta'))).toBe(false);
      expect(messages.some(message => message.includes('secret-text-delta'))).toBe(false);
      expect(messages.some(message => message.includes('secret-every-50-delta'))).toBe(false);
      expect(messages.some(message => message.includes('composed final answer'))).toBe(false);
      expect(messages.some(message => message.includes('session_complete subtype=success result=21chars'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
