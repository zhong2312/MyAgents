// Regression: OpenAI-bridge streaming must report token usage to the SDK.
//
// Issue #277: OpenAI-protocol third-party providers (apiProtocol: openai) reported
// modelUsage with inputTokens=0/outputTokens=0 even on completed turns. Two causes:
//   1. Per the OpenAI spec, with stream_options.include_usage=true the `usage`
//      payload arrives in a SEPARATE final chunk (empty `choices`) AFTER the
//      finish_reason chunk. The translator emitted the terminal message_delta /
//      message_stop on the finish_reason chunk — before usage was known → 0 output.
//   2. message_delta only carried `output_tokens`; input/cache were never sent.
//      The Anthropic SDK reads input_tokens from message_delta.usage when present
//      (node_modules/@anthropic-ai/sdk/lib/MessageStream.js accumulateMessage),
//      so omitting it left input_tokens pinned to the 0 from message_start.
//
// This test reproduces the SDK's usage accumulation to assert the end-to-end
// modelUsage the SDK would compute from the bridge's SSE stream.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { StreamTranslator } from './stream';
import { ResponsesStreamTranslator } from './stream-responses';
import { handleStreamResponse, handleResponsesStreamResponse } from '../handler';
import type { OpenAIStreamChunk } from '../types/openai';
import type { AnthropicStreamEvent, AnthropicUsage } from '../types/anthropic';
import type { ResponsesStreamEvent } from '../types/openai-responses';

const MODEL = 'skywork-ai/skyclaw-v1';

/**
 * Replicate the relevant part of @anthropic-ai/sdk's MessageStream.accumulateMessage:
 * message_start seeds the usage snapshot; message_delta overrides output_tokens
 * unconditionally and input/cache fields when present. Returns what the SDK would
 * surface as the assistant message's usage (→ result.modelUsage).
 */
function accumulateUsage(events: AnthropicStreamEvent[]): AnthropicUsage {
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  for (const ev of events) {
    if (ev.type === 'message_start') {
      usage = { ...ev.message.usage };
    } else if (ev.type === 'message_delta') {
      usage.output_tokens = ev.usage.output_tokens;
      if (ev.usage.input_tokens != null) usage.input_tokens = ev.usage.input_tokens;
      if (ev.usage.cache_read_input_tokens != null) usage.cache_read_input_tokens = ev.usage.cache_read_input_tokens;
      if (ev.usage.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = ev.usage.cache_creation_input_tokens;
    }
  }
  return usage;
}

function runChat(chunks: OpenAIStreamChunk[]): AnthropicStreamEvent[] {
  const t = new StreamTranslator(MODEL);
  const events: AnthropicStreamEvent[] = [];
  for (const c of chunks) events.push(...t.feed(c));
  events.push(...t.finalize());
  return events;
}

function chunk(partial: Partial<OpenAIStreamChunk> & Pick<OpenAIStreamChunk, 'choices'>): OpenAIStreamChunk {
  return { id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL, ...partial };
}

describe('StreamTranslator usage (issue #277)', () => {
  it('reports input+output tokens when usage arrives in a separate final chunk (OpenAI spec)', () => {
    const events = runChat([
      chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { content: 'Hello there' }, finish_reason: null }] }),
      // finish_reason chunk: usage is null per spec
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }),
      // separate usage-only chunk: empty choices, usage populated
      chunk({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } }),
    ]);

    const deltas = events.filter((e) => e.type === 'message_delta');
    expect(deltas).toHaveLength(1);

    const usage = accumulateUsage(events);
    expect(usage.input_tokens).toBe(1234);
    expect(usage.output_tokens).toBe(56);

    // message_stop must follow the usage-bearing message_delta
    const deltaIdx = events.findIndex((e) => e.type === 'message_delta');
    const stopIdx = events.findIndex((e) => e.type === 'message_stop');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(deltaIdx);
  });

  it('reports usage when a provider sends it in the same chunk as finish_reason', () => {
    const events = runChat([
      chunk({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    ]);

    const usage = accumulateUsage(events);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(20);
  });

  it('maps cached_tokens → cache_read_input_tokens', () => {
    const events = runChat([
      chunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }),
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 40,
          total_tokens: 540,
          prompt_tokens_details: { cached_tokens: 320 },
        },
      }),
    ]);

    const usage = accumulateUsage(events);
    expect(usage.input_tokens).toBe(500);
    expect(usage.output_tokens).toBe(40);
    expect(usage.cache_read_input_tokens).toBe(320);
  });

  it('preserves tool_use stop_reason while still reporting usage from the trailing chunk', () => {
    const events = runChat([
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } }] },
          finish_reason: null,
        }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: null }),
      chunk({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 12, total_tokens: 812 } }),
    ]);

    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta && delta.type === 'message_delta' && delta.delta.stop_reason).toBe('tool_use');

    const usage = accumulateUsage(events);
    expect(usage.input_tokens).toBe(800);
    expect(usage.output_tokens).toBe(12);
  });
});

// Integration: drive the REAL parse→translate pipeline (handler.ts) so we prove
// the terminal events are emitted on the OpenAI protocol terminator `[DONE]`,
// NOT only on transport EOF (TransformStream flush). Regression guard for the
// cross-AI review finding: keying finalization solely on body-close would lose
// usage + message_stop if a provider sends [DONE] then lingers before closing.
function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Reads the bridge's output until the stream reaches EOF (done:true) or a read
// stalls past `perReadTimeoutMs`. Crucially it does NOT stop at message_stop —
// it keeps reading to prove the bridge actually CLOSES the downstream on [DONE]
// (the SDK reads until EOF, not until message_stop). `reachedDone:false` means
// the stream hung — i.e. finalization/close still depends on transport EOF.
async function readAnthropicEvents(
  body: ReadableStream<Uint8Array>,
  perReadTimeoutMs: number,
): Promise<{ events: AnthropicStreamEvent[]; reachedDone: boolean }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: AnthropicStreamEvent[] = [];
  let reachedDone = false;
  try {
    for (;;) {
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), perReadTimeoutMs));
      const res = await Promise.race([reader.read(), timer]);
      if (res === 'timeout') break;
      const { done, value } = res;
      if (done) { reachedDone = true; break; }
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          events.push(JSON.parse(dataLine.slice('data:'.length).trim()) as AnthropicStreamEvent);
        } catch { /* skip */ }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return { events, reachedDone };
}

async function readAllAnthropicEvents(body: ReadableStream<Uint8Array>): Promise<AnthropicStreamEvent[]> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: AnthropicStreamEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const dataLine = part.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      try {
        events.push(JSON.parse(dataLine.slice('data:'.length).trim()) as AnthropicStreamEvent);
      } catch { /* skip malformed test output */ }
    }
  }
  return events;
}

describe('stream body liveness ownership (issue #458)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a Chat Completions stream alive across more than 60 seconds without bytes', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    });
    const upstreamAbort = new AbortController();
    const out = handleStreamResponse(
      new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }),
      MODEL,
      true,
      () => {},
      undefined,
      upstreamAbort,
      undefined,
      () => {},
    );
    const reading = readAllAnthropicEvents(out.body!);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(upstreamAbort.signal.aborted).toBe(false);

    source.enqueue(enc.encode(
      sseFrame(chunk({ choices: [{ index: 0, delta: { content: 'continued after silence' }, finish_reason: null }] }))
      + sseFrame(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }))
      + sseFrame(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
      + 'data: [DONE]\n\n',
    ));
    const events = await reading;
    const text = events.flatMap((event) => event.type === 'content_block_delta'
      && event.delta.type === 'text_delta' ? [event.delta.text] : []).join('');
    expect(text).toContain('continued after silence');
    expect(events.some((event) => event.type === 'message_stop')).toBe(true);
  });

  it('keeps a Responses stream alive across more than 60 seconds without bytes', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    });
    const upstreamAbort = new AbortController();
    const out = handleResponsesStreamResponse(
      new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }),
      MODEL,
      () => {},
      upstreamAbort,
      undefined,
      () => {},
    );
    const reading = readAllAnthropicEvents(out.body!);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(upstreamAbort.signal.aborted).toBe(false);

    source.enqueue(enc.encode(
      sseFrame({ type: 'response.output_text.delta', delta: 'continued after silence' })
      + sseFrame({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      }),
    ));
    const events = await reading;
    const text = events.flatMap((event) => event.type === 'content_block_delta'
      && event.delta.type === 'text_delta' ? [event.delta.text] : []).join('');
    expect(text).toContain('continued after silence');
    expect(events.some((event) => event.type === 'message_stop')).toBe(true);
  });

  it('still aborts the upstream transport when the downstream cancels', async () => {
    const upstreamAbort = new AbortController();
    const out = handleStreamResponse(
      new Response(new ReadableStream<Uint8Array>({ start() { /* remain open */ } })),
      MODEL,
      true,
      () => {},
      undefined,
      upstreamAbort,
      undefined,
      () => {},
    );

    await out.body!.cancel('user cancelled');
    expect(upstreamAbort.signal.aborted).toBe(true);
  });

  it('still aborts a Responses upstream transport when the downstream cancels', async () => {
    const upstreamAbort = new AbortController();
    const out = handleResponsesStreamResponse(
      new Response(new ReadableStream<Uint8Array>({ start() { /* remain open */ } })),
      MODEL,
      () => {},
      upstreamAbort,
      undefined,
      () => {},
    );

    await out.body!.cancel('user cancelled');
    expect(upstreamAbort.signal.aborted).toBe(true);
  });

  it('propagates a real Chat upstream stream error without rewriting it as timeout', async () => {
    const upstreamError = new Error('provider socket failed');
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(upstreamError); },
    });
    const out = handleStreamResponse(
      new Response(upstreamBody),
      MODEL,
      true,
      () => {},
      undefined,
      new AbortController(),
      undefined,
      () => {},
    );

    await expect(readAllAnthropicEvents(out.body!)).rejects.toThrow('provider socket failed');
  });

  it('propagates a real Responses upstream stream error without rewriting it as timeout', async () => {
    const upstreamError = new Error('responses provider socket failed');
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(upstreamError); },
    });
    const out = handleResponsesStreamResponse(
      new Response(upstreamBody),
      MODEL,
      () => {},
      new AbortController(),
      undefined,
      () => {},
    );

    await expect(readAllAnthropicEvents(out.body!)).rejects.toThrow('responses provider socket failed');
  });

  it('does not treat a Responses-only [DONE] marker as a protocol terminal', async () => {
    const enc = new TextEncoder();
    const upstreamAbort = new AbortController();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc.encode('data: [DONE]\n\n')); },
    });
    const out = handleResponsesStreamResponse(
      new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }),
      MODEL,
      () => {},
      upstreamAbort,
      undefined,
      () => {},
    );
    const reader = out.body!.getReader();

    const outcome = await Promise.race([
      reader.read().then(() => 'read'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(outcome).toBe('pending');
    expect(upstreamAbort.signal.aborted).toBe(false);
    await reader.cancel('test cleanup');
  });
});

describe('handleStreamResponse [DONE]-driven finalization (issue #277)', () => {
  it('emits terminal usage + message_stop on [DONE] WITHOUT waiting for the body to close', async () => {
    const enc = new TextEncoder();
    // Upstream emits the FULL OpenAI stream incl. `[DONE]` on the first pull, then
    // stays OPEN forever (never closes) — exactly the "provider lingers after
    // [DONE]" case. If finalization keyed off transport EOF, the read below would
    // hang to the per-read timeout and the assertions would fail.
    let emitted = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(c) {
        if (emitted) return; // produce nothing more; leave the stream open
        emitted = true;
        c.enqueue(enc.encode(
          sseFrame(chunk({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] })) +
          sseFrame(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null })) +
          sseFrame(chunk({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } })) +
          'data: [DONE]\n\n',
        ));
      },
    });
    const upstreamResp = new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const upstreamAbort = new AbortController();
    const out = handleStreamResponse(
      upstreamResp,
      MODEL,
      true,
      () => {},
      undefined,
      upstreamAbort,
      undefined,
      () => {},
    );

    const { events, reachedDone } = await readAnthropicEvents(out.body!, 2000);

    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta && delta.type === 'message_delta' && delta.usage.input_tokens).toBe(1234);
    expect(delta && delta.type === 'message_delta' && delta.usage.output_tokens).toBe(56);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    // The downstream stream must reach EOF on [DONE] even though the upstream
    // body never closes — otherwise the SDK (reads until EOF) would hang.
    expect(reachedDone).toBe(true);
    expect(upstreamAbort.signal.aborted).toBe(true);
  });

  it('Responses API: closes downstream on response.completed WITHOUT waiting for body close', async () => {
    const enc = new TextEncoder();
    let emitted = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(c) {
        if (emitted) return; // leave the stream open after the terminal event
        emitted = true;
        c.enqueue(enc.encode(
          sseFrame({ type: 'response.output_text.delta', delta: 'Hi' }) +
          sseFrame({ type: 'response.output_text.done' }) +
          sseFrame({
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: {
                input_tokens: 2000,
                output_tokens: 75,
                total_tokens: 2075,
                input_tokens_details: { cached_tokens: 128 },
              },
            },
          }),
        ));
      },
    });
    const upstreamResp = new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const upstreamAbort = new AbortController();
    const out = handleResponsesStreamResponse(
      upstreamResp,
      MODEL,
      () => {},
      upstreamAbort,
      undefined,
      () => {},
    );

    const { events, reachedDone } = await readAnthropicEvents(out.body!, 2000);

    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta && delta.type === 'message_delta' && delta.usage.input_tokens).toBe(2000);
    expect(delta && delta.type === 'message_delta' && delta.usage.output_tokens).toBe(75);
    expect(delta && delta.type === 'message_delta' && delta.usage.cache_read_input_tokens).toBe(128);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    expect(reachedDone).toBe(true);
    expect(upstreamAbort.signal.aborted).toBe(true);
  });

  it('Responses API: closes downstream on response.failed WITHOUT waiting for body close', async () => {
    const enc = new TextEncoder();
    let emitted = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) return;
        emitted = true;
        controller.enqueue(enc.encode(sseFrame({
          type: 'response.failed',
          response: {
            id: 'resp_failed',
            object: 'response',
            status: 'failed',
            model: MODEL,
            output: [],
            error: { code: 'upstream_failed', message: 'provider rejected the turn' },
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        })));
      },
    });
    const upstreamAbort = new AbortController();
    const out = handleResponsesStreamResponse(
      new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }),
      MODEL,
      () => {},
      upstreamAbort,
      undefined,
      () => {},
    );

    const { events, reachedDone } = await readAnthropicEvents(out.body!, 2_000);
    expect(events.some((event) => event.type === 'message_stop')).toBe(true);
    expect(reachedDone).toBe(true);
    expect(upstreamAbort.signal.aborted).toBe(true);
  });
});

describe('ResponsesStreamTranslator usage (issue #277)', () => {
  it('reports input+output tokens from response.completed', () => {
    const t = new ResponsesStreamTranslator(MODEL);
    const events: AnthropicStreamEvent[] = [];
    events.push(...t.feed({ type: 'response.output_text.delta', delta: 'Hello' } as ResponsesStreamEvent));
    events.push(...t.feed({ type: 'response.output_text.done' } as ResponsesStreamEvent));
    events.push(...t.feed({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: {
          input_tokens: 2000,
          output_tokens: 75,
          total_tokens: 2075,
          input_tokens_details: { cached_tokens: 128 },
        },
      },
    } as ResponsesStreamEvent));
    events.push(...t.finalize());

    const usage = accumulateUsage(events);
    expect(usage.input_tokens).toBe(2000);
    expect(usage.output_tokens).toBe(75);
    expect(usage.cache_read_input_tokens).toBe(128);
  });
});
