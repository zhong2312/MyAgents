import { describe, expect, it } from 'vitest';

import { translateRequest } from './request';
import { translateRequestToResponses } from './request-responses';
import type { AnthropicRequest } from '../types/anthropic';

const baseReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 1024,
};

const sdkMarkedReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  system: [
    { type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'dynamic tail' },
  ],
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling tool', cache_control: { type: 'ephemeral' } },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'lookup',
          input: { query: 'x' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'result',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'cached text', cache_control: { type: 'ephemeral' } },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/image.png' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ],
  tools: [{
    name: 'lookup',
    description: 'Lookup a value',
    input_schema: { type: 'object', properties: {} },
    cache_control: { type: 'ephemeral' },
  }],
  max_tokens: 1024,
};

function countBreakpoints(value: unknown): number {
  return (JSON.stringify(value).match(/prompt_cache_breakpoint/g) ?? []).length;
}

describe('Responses API prompt_cache_key injection', () => {
  it('omits prompt_cache_key unless the bridge supplies one', () => {
    const out = translateRequestToResponses({ ...baseReq }, {});

    expect('prompt_cache_key' in out).toBe(false);
  });

  it('forwards the bridge-generated prompt_cache_key without enabling stateful Responses fields', () => {
    const out = translateRequestToResponses(
      { ...baseReq },
      { promptCacheKey: 'myagents:responses:abc123' },
    );

    expect(out.prompt_cache_key).toBe('myagents:responses:abc123');
    expect('store' in out).toBe(false);
    expect('previous_response_id' in out).toBe(false);
    expect('conversation' in out).toBe(false);
    expect('prompt_cache_retention' in out).toBe(false);
  });

  it('projects SDK cache_control only onto Responses content locations that support breakpoints', () => {
    const out = translateRequestToResponses(sdkMarkedReq, {
      promptCacheKey: 'myagents:responses:abc123',
      promptCacheBreakpoints: true,
    });

    expect('instructions' in out).toBe(false);
    expect(out.input[0]).toEqual({
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'stable system',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        { type: 'input_text', text: '\n\ndynamic tail' },
      ],
    });
    expect(countBreakpoints(out)).toBe(3);
    expect(JSON.stringify(out.tools)).not.toContain('prompt_cache_breakpoint');
    expect(JSON.stringify(out.input.filter(item => 'type' in item && item.type === 'function_call_output')))
      .not.toContain('prompt_cache_breakpoint');
    expect('prompt_cache_options' in out).toBe(false);
    expect('store' in out).toBe(false);
    expect('previous_response_id' in out).toBe(false);
    expect('conversation' in out).toBe(false);
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.input.map(item => ('type' in item ? item.type : item.role))).toEqual([
      'developer',
      'assistant',
      'function_call',
      'function_call_output',
      'user',
    ]);
    expect(out.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'tool-1', name: 'lookup' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'tool-1', output: 'result' }),
    ]));
    expect(out.tools).toEqual([{
      type: 'function',
      name: 'lookup',
      description: 'Lookup a value',
      parameters: { type: 'object', properties: {} },
    }]);
  });

  it('keeps the legacy stateless request shape when breakpoint projection is disabled', () => {
    const out = translateRequestToResponses(sdkMarkedReq, {});

    expect(out.instructions).toBe('stable system\n\ndynamic tail');
    expect(out.input[0]).not.toHaveProperty('role', 'developer');
    expect(countBreakpoints(out)).toBe(0);
  });
});

describe('Chat Completions prompt_cache_key injection', () => {
  it('omits prompt_cache_key unless the bridge supplies one', () => {
    const out = translateRequest({ ...baseReq }, {});

    expect('prompt_cache_key' in out).toBe(false);
  });

  it('forwards the bridge-generated prompt_cache_key without enabling retention', () => {
    const out = translateRequest(
      { ...baseReq },
      { promptCacheKey: 'myagents:chat_completions:abc123' },
    );

    expect(out.prompt_cache_key).toBe('myagents:chat_completions:abc123');
    expect('prompt_cache_retention' in out).toBe(false);
  });

  it('projects SDK cache_control onto every supported Chat content part', () => {
    const out = translateRequest(sdkMarkedReq, {
      promptCacheKey: 'myagents:chat_completions:abc123',
      promptCacheBreakpoints: true,
    });

    expect(out.messages[0]).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'stable system',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        { type: 'text', text: '\n\ndynamic tail' },
      ],
    });
    expect(countBreakpoints(out)).toBe(5);
    expect(JSON.stringify(out.tools)).not.toContain('prompt_cache_breakpoint');
    expect(out.messages.map(message => message.role)).toEqual(['system', 'assistant', 'tool', 'user']);
    expect(out.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'calling tool',
        prompt_cache_breakpoint: { mode: 'explicit' },
      }],
      tool_calls: [expect.objectContaining({ id: 'tool-1' })],
    }));
    expect(out.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'tool-1',
      content: [{
        type: 'text',
        text: 'result',
        prompt_cache_breakpoint: { mode: 'explicit' },
      }],
    });
    expect('prompt_cache_options' in out).toBe(false);
  });

  it('retains the legacy Chat message shape when breakpoint projection is disabled', () => {
    const out = translateRequest(sdkMarkedReq, {});

    expect(out.messages[0]).toEqual({ role: 'system', content: 'stable system\n\ndynamic tail' });
    expect(countBreakpoints(out)).toBe(0);
  });
});

describe('streaming request parity', () => {
  it('keeps the same breakpoint projection when stream transport is requested', () => {
    const request = { ...sdkMarkedReq, stream: true };
    const responses = translateRequestToResponses(request, { promptCacheBreakpoints: true });
    const chat = translateRequest(request, { promptCacheBreakpoints: true });

    expect(responses.stream).toBe(true);
    expect(chat.stream).toBe(true);
    expect(countBreakpoints(responses)).toBe(3);
    expect(countBreakpoints(chat)).toBe(5);
  });
});
