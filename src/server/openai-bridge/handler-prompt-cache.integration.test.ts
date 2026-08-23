import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBridgeHandler } from './handler';
import type { UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';

type SeenRequest = {
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
};

type FakeUpstream = {
  baseUrl: string;
  seen: SeenRequest[];
  close: () => Promise<void>;
};

const anthropicReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 32,
};

const markedAnthropicReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  system: [{
    type: 'text',
    text: 'stable system',
    cache_control: { type: 'ephemeral' },
  }],
  messages: [{
    role: 'user',
    content: [{
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral' },
    }],
  }],
  max_tokens: 32,
};

const toolImageAnthropicReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  system: [{
    type: 'text',
    text: 'stable system',
    cache_control: { type: 'ephemeral' },
  }],
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-image', name: 'see', input: {} }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-image',
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from('same-image').toString('base64'),
          },
        }],
      }],
    },
  ],
  max_tokens: 32,
};

const temporaryWorkspaces: string[] = [];

afterEach(() => {
  for (const workspace of temporaryWorkspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

const okResponsesBody = {
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.5',
  output: [{
    type: 'message',
    id: 'msg_test',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'ok' }],
  }],
  usage: {
    input_tokens: 12,
    output_tokens: 1,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
  },
};

const okChatBody = {
  id: 'chatcmpl_test',
  object: 'chat.completion',
  created: 0,
  model: 'chat-model',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'ok' },
    finish_reason: 'stop',
  }],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 1,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
  },
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function startFakeUpstream(
  respond: (body: Record<string, unknown>, seen: SeenRequest[]) => { status: number; body: unknown },
): Promise<FakeUpstream> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    try {
      const body = await readJson(req);
      seen.push({
        path: req.url ?? '/',
        body,
        authorization: req.headers.authorization,
      });
      const response = respond(body, seen);
      writeJson(res, response.status, response.body);
    } catch (err) {
      writeJson(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('failed to bind fake upstream');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function callBridge(
  upstream: UpstreamConfig,
  logger: ((msg: string) => void) | null = null,
  stream = false,
): Promise<Response> {
  const handler = createBridgeHandler({
    getUpstreamConfig: async () => upstream,
    logger,
    workspacePath,
  });
  return handler(new Request('http://127.0.0.1/bridge/test/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(stream ? { ...anthropicReq, stream: true } : anthropicReq),
  }));
}

describe('OpenAI bridge Responses prompt_cache_key', () => {
  let fake: FakeUpstream | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('injects the same anonymous prompt_cache_key for repeated active-session requests', async () => {
    fake = await startFakeUpstream(() => ({ status: 200, body: okResponsesBody }));
    const upstream: UpstreamConfig = {
      providerId: 'fox',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: { sessionId: 'raw-session-id', promptCacheKeyMode: 'session' },
    };

    const firstResponse = await callBridge(upstream);
    const firstBody = await firstResponse.json() as {
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    expect(firstResponse.status).toBe(200);
    expect(firstBody.usage?.input_tokens).toBe(3);
    expect(firstBody.usage?.cache_read_input_tokens).toBe(7);
    expect(firstBody.usage?.cache_creation_input_tokens).toBe(2);
    await expect(callBridge(upstream).then((res) => res.status)).resolves.toBe(200);

    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0].path).toBe('/responses');
    const firstKey = fake.seen[0].body.prompt_cache_key;
    const secondKey = fake.seen[1].body.prompt_cache_key;
    expect(firstKey).toEqual(expect.stringMatching(/^myagents:responses:[a-f0-9]{32}$/));
    expect(secondKey).toBe(firstKey);
    expect(JSON.stringify(fake.seen[0].body)).not.toContain('raw-session-id');
  });

  it('omits prompt_cache_key when the bridge has no active-session cache affinity', async () => {
    fake = await startFakeUpstream(() => ({ status: 200, body: okResponsesBody }));
    const upstream: UpstreamConfig = {
      providerId: 'fox',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
    };

    await expect(callBridge(upstream, null, markedAnthropicReq).then((res) => res.status)).resolves.toBe(200);

    expect(fake.seen).toHaveLength(1);
    expect('prompt_cache_key' in fake.seen[0].body).toBe(false);
    expect(fake.seen[0].body.instructions).toBe('stable system');
    expect(JSON.stringify(fake.seen[0].body)).not.toContain('prompt_cache_breakpoint');
  });

  it('translates a JSON completion even when the downstream requested streaming', async () => {
    fake = await startFakeUpstream(() => ({ status: 200, body: okChatBody }));
    const upstream: UpstreamConfig = {
      providerId: 'json-stream-fallback',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
    };

    const response = await callBridge(upstream, null, true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('retries once without prompt_cache_key and disables later injection for the same bridge', async () => {
    fake = await startFakeUpstream((body, seen) => {
      if (seen.length === 1 && body.prompt_cache_key) {
        return {
          status: 400,
          body: { error: { message: 'Unknown parameter: prompt_cache_key' } },
        };
      }
      return { status: 200, body: okResponsesBody };
    });

    let disabled = false;
    const logs: string[] = [];
    const upstream = (): UpstreamConfig => ({
      providerId: 'strict-provider',
      baseUrl: fake!.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: disabled,
        disablePromptCacheKey: () => { disabled = true; },
      },
    });

    await expect(callBridge(upstream(), (msg) => logs.push(msg)).then((res) => res.status)).resolves.toBe(200);
    await expect(callBridge(upstream()).then((res) => res.status)).resolves.toBe(200);

    expect(disabled).toBe(true);
    expect(fake.seen).toHaveLength(3);
    expect(fake.seen[0].body.prompt_cache_key).toEqual(expect.stringMatching(/^myagents:responses:[a-f0-9]{32}$/));
    expect('prompt_cache_key' in fake.seen[1].body).toBe(false);
    expect('prompt_cache_key' in fake.seen[2].body).toBe(false);
    const joinedLogs = logs.join('\n');
    expect(joinedLogs).toContain('responses prompt_cache_key unsupported');
    expect(joinedLogs).not.toContain(String(fake.seen[0].body.prompt_cache_key));
    expect(joinedLogs).not.toContain('raw-session-id');
    expect(joinedLogs).not.toContain('sk-test');
    expect(joinedLogs).not.toContain(JSON.stringify(fake.seen[0].body));
  });

  it('does not downgrade or leak when an unrelated upstream error echoes the request body', async () => {
    fake = await startFakeUpstream((body) => ({
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: `invalid payload echo ${JSON.stringify(body)}`,
        },
      },
    }));

    let keyDisabled = false;
    let breakpointsDisabled = false;
    const logs: string[] = [];
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        disablePromptCacheKey: () => { keyDisabled = true; },
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    };

    const res = await callBridge(upstream, (msg) => logs.push(msg), markedAnthropicReq);
    const text = await res.text();
    const rawKey = String(fake.seen[0].body.prompt_cache_key);

    expect(res.status).toBe(400);
    expect(keyDisabled).toBe(false);
    expect(breakpointsDisabled).toBe(false);
    expect(fake.seen).toHaveLength(1);
    for (const output of [logs.join('\n'), text]) {
      expect(output).not.toContain(rawKey);
      expect(output).not.toContain('raw-session-id');
      expect(output).not.toContain('sk-test');
      expect(output).not.toContain('"input"');
      expect(output).not.toContain('hello');
    }
  });

  it.each([401, 429, 500])('does not retry HTTP %s even if the body names both cache field families', async (status) => {
    fake = await startFakeUpstream(() => ({
      status,
      body: { error: { message: 'Unknown prompt_cache_key and unsupported prompt_cache_breakpoint' } },
    }));

    let keyDisabled = false;
    let breakpointsDisabled = false;
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        disablePromptCacheKey: () => { keyDisabled = true; },
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    };

    const res = await callBridge(upstream, null, markedAnthropicReq);

    expect(res.status).toBe(status);
    expect(keyDisabled).toBe(false);
    expect(breakpointsDisabled).toBe(false);
    expect(fake.seen).toHaveLength(1);
  });

  it('downgrades cache key and breakpoint capabilities independently, then keeps both disabled', async () => {
    fake = await startFakeUpstream((body, seen) => {
      if (seen.length === 1) {
        return {
          status: 400,
          body: { error: { param: 'prompt_cache_key', message: 'Unsupported parameter' } },
        };
      }
      if (seen.length === 2) {
        return {
          status: 422,
          body: {
            error: {
              param: 'input[0].content[0].prompt_cache_breakpoint',
              message: 'Unsupported field',
            },
          },
        };
      }
      return { status: 200, body: okResponsesBody };
    });

    let keyDisabled = false;
    let breakpointsDisabled = false;
    const upstream = (): UpstreamConfig => ({
      providerId: 'strict-provider',
      baseUrl: fake!.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: keyDisabled,
        disablePromptCacheKey: () => { keyDisabled = true; },
        promptCacheBreakpointsDisabled: breakpointsDisabled,
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    });

    await expect(callBridge(upstream(), null, markedAnthropicReq).then(res => res.status)).resolves.toBe(200);
    await expect(callBridge(upstream(), null, markedAnthropicReq).then(res => res.status)).resolves.toBe(200);

    expect(keyDisabled).toBe(true);
    expect(breakpointsDisabled).toBe(true);
    expect(fake.seen).toHaveLength(4);
    expect(fake.seen[0].body.prompt_cache_key).toBeDefined();
    expect(JSON.stringify(fake.seen[0].body)).toContain('prompt_cache_breakpoint');
    expect('prompt_cache_key' in fake.seen[1].body).toBe(false);
    expect(JSON.stringify(fake.seen[1].body)).toContain('prompt_cache_breakpoint');
    for (const request of fake.seen.slice(2)) {
      expect('prompt_cache_key' in request.body).toBe(false);
      expect(request.body.instructions).toBe('stable system');
      expect(JSON.stringify(request.body)).not.toContain('prompt_cache_breakpoint');
      expect(JSON.stringify(request.body)).not.toContain('prompt_cache_options');
    }
  });

  it('falls back when Responses rejects structured content through an exact param path', async () => {
    fake = await startFakeUpstream((_body, seen) => seen.length === 1
      ? {
          status: 422,
          body: {
            error: {
              param: 'input[0].content',
              message: 'Input should be a valid string',
            },
          },
        }
      : { status: 200, body: okResponsesBody });

    let breakpointsDisabled = false;
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: true,
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    };

    await expect(callBridge(upstream, null, markedAnthropicReq).then(res => res.status)).resolves.toBe(200);

    expect(breakpointsDisabled).toBe(true);
    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0].body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'developer' }),
    ]));
    expect(fake.seen[1].body.instructions).toBe('stable system');
  });

  it('reuses tool-result image materialization across source retranslations', async () => {
    fake = await startFakeUpstream((_body, seen) => {
      if (seen.length === 1) {
        return { status: 400, body: { error: { message: 'Unknown parameter: prompt_cache_key' } } };
      }
      if (seen.length === 2) {
        return {
          status: 400,
          body: {
            error: {
              param: 'input[0].content[0].prompt_cache_breakpoint',
              message: 'Unsupported field',
            },
          },
        };
      }
      return { status: 200, body: okResponsesBody };
    });
    const workspace = mkdtempSync(join(tmpdir(), 'myagents-cache-retry-'));
    temporaryWorkspaces.push(workspace);
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        disablePromptCacheKey: () => {},
        disablePromptCacheBreakpoints: () => {},
      },
    };

    await expect(callBridge(upstream, null, toolImageAnthropicReq, workspace).then(res => res.status))
      .resolves.toBe(200);

    const outputs = fake.seen.map(({ body }) => {
      const input = body.input as Array<Record<string, unknown>>;
      return input.find(item => item.type === 'function_call_output')?.output;
    });
    expect(new Set(outputs).size).toBe(1);
    expect(readdirSync(join(workspace, 'myagents_files', 'temp'))).toHaveLength(1);
  });

  it('redacts echoed requests after prompt_cache_key has been removed', async () => {
    fake = await startFakeUpstream((body, seen) => {
      if (seen.length === 1) {
        return { status: 400, body: { error: { message: 'Unknown parameter: prompt_cache_key' } } };
      }
      if (seen.length === 2) {
        return {
          status: 422,
          body: {
            error: {
              param: 'input[0].content[0].prompt_cache_breakpoint',
              message: 'Unsupported field',
            },
          },
        };
      }
      return {
          status: 400,
          body: { error: { message: `invalid payload echo ${JSON.stringify(body)}` } },
      };
    });
    let keyDisabled = false;
    let breakpointsDisabled = false;
    const logs: string[] = [];
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        disablePromptCacheKey: () => { keyDisabled = true; },
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    };

    const response = await callBridge(upstream, message => logs.push(message), markedAnthropicReq);
    const returned = await response.text();

    expect(response.status).toBe(400);
    expect(keyDisabled).toBe(true);
    expect(breakpointsDisabled).toBe(true);
    expect(fake.seen).toHaveLength(3);
    for (const output of [logs.join('\n'), returned]) {
      expect(output).not.toContain('stable system');
      expect(output).not.toContain('hello');
      expect(output).not.toContain('"input"');
    }
  });

  it('redacts request echoes in HTTP-200 response.failed payloads', async () => {
    fake = await startFakeUpstream((body) => ({
      status: 200,
      body: {
        id: 'resp_failed',
        object: 'response',
        status: 'failed',
        model: 'gpt-5.5',
        output: [],
        error: { code: 'provider_failed', message: `echo ${JSON.stringify(body)}` },
      },
    }));
    const logs: string[] = [];
    const upstream: UpstreamConfig = {
      providerId: 'strict-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      upstreamFormat: 'responses',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: true,
      },
    };

    const response = await callBridge(upstream, message => logs.push(message), markedAnthropicReq);
    const returned = await response.text();

    expect(response.status).toBe(502);
    for (const output of [logs.join('\n'), returned]) {
      expect(output).not.toContain('stable system');
      expect(output).not.toContain('hello');
      expect(output).not.toContain('"input"');
    }
  });
});

describe('OpenAI bridge Chat Completions prompt_cache_key', () => {
  let fake: FakeUpstream | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('injects the same anonymous prompt_cache_key for repeated active-session requests', async () => {
    fake = await startFakeUpstream(() => ({ status: 200, body: okChatBody }));
    const upstream: UpstreamConfig = {
      providerId: 'siliconflow',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
      cacheAffinity: { sessionId: 'raw-session-id', promptCacheKeyMode: 'session' },
    };

    const firstResponse = await callBridge(upstream);
    const firstBody = await firstResponse.json() as {
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    expect(firstResponse.status).toBe(200);
    expect(firstBody.usage?.input_tokens).toBe(3);
    expect(firstBody.usage?.cache_read_input_tokens).toBe(7);
    expect(firstBody.usage?.cache_creation_input_tokens).toBe(2);
    await expect(callBridge(upstream).then((res) => res.status)).resolves.toBe(200);

    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0].path).toBe('/chat/completions');
    const firstKey = fake.seen[0].body.prompt_cache_key;
    const secondKey = fake.seen[1].body.prompt_cache_key;
    expect(firstKey).toEqual(expect.stringMatching(/^myagents:chat_completions:[a-f0-9]{32}$/));
    expect(secondKey).toBe(firstKey);
    expect(JSON.stringify(fake.seen[0].body)).not.toContain('raw-session-id');
  });

  it('omits prompt_cache_key when the bridge has no active-session cache affinity', async () => {
    fake = await startFakeUpstream(() => ({ status: 200, body: okChatBody }));
    const upstream: UpstreamConfig = {
      providerId: 'siliconflow',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
    };

    await expect(callBridge(upstream, null, markedAnthropicReq).then((res) => res.status)).resolves.toBe(200);

    expect(fake.seen).toHaveLength(1);
    expect('prompt_cache_key' in fake.seen[0].body).toBe(false);
    expect(fake.seen[0].body.messages).toEqual(expect.arrayContaining([
      { role: 'system', content: 'stable system' },
    ]));
    expect(JSON.stringify(fake.seen[0].body)).not.toContain('prompt_cache_breakpoint');
  });

  it('retries once without prompt_cache_key and disables later injection for the same bridge', async () => {
    fake = await startFakeUpstream((body, seen) => {
      if (seen.length === 1 && body.prompt_cache_key) {
        return {
          status: 400,
          body: { error: { message: 'Unknown parameter: prompt_cache_key' } },
        };
      }
      return { status: 200, body: okChatBody };
    });

    let disabled = false;
    const logs: string[] = [];
    const upstream = (): UpstreamConfig => ({
      providerId: 'strict-chat-provider',
      baseUrl: fake!.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: disabled,
        disablePromptCacheKey: () => { disabled = true; },
      },
    });

    await expect(callBridge(upstream(), (msg) => logs.push(msg)).then((res) => res.status)).resolves.toBe(200);
    await expect(callBridge(upstream()).then((res) => res.status)).resolves.toBe(200);

    expect(disabled).toBe(true);
    expect(fake.seen).toHaveLength(3);
    expect(fake.seen[0].body.prompt_cache_key).toEqual(expect.stringMatching(/^myagents:chat_completions:[a-f0-9]{32}$/));
    expect('prompt_cache_key' in fake.seen[1].body).toBe(false);
    expect('prompt_cache_key' in fake.seen[2].body).toBe(false);
    const joinedLogs = logs.join('\n');
    expect(joinedLogs).toContain('chat_completions prompt_cache_key unsupported');
    expect(joinedLogs).not.toContain(String(fake.seen[0].body.prompt_cache_key));
    expect(joinedLogs).not.toContain('raw-session-id');
    expect(joinedLogs).not.toContain('sk-test');
    expect(joinedLogs).not.toContain(JSON.stringify(fake.seen[0].body));
  });

  it('falls back from structured system content only for an exact schema rejection', async () => {
    fake = await startFakeUpstream((_body, seen) => seen.length === 1
      ? {
          status: 400,
          body: {
            error: {
              param: 'messages[1].content',
              message: 'Input should be a valid string',
            },
          },
        }
      : { status: 200, body: okChatBody });

    let disabled = false;
    const upstream = (): UpstreamConfig => ({
      providerId: 'strict-chat-provider',
      baseUrl: fake!.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: true,
        promptCacheBreakpointsDisabled: disabled,
        disablePromptCacheBreakpoints: () => { disabled = true; },
      },
    });

    await expect(callBridge(upstream(), null, markedAnthropicReq).then(res => res.status)).resolves.toBe(200);
    await expect(callBridge(upstream(), null, markedAnthropicReq).then(res => res.status)).resolves.toBe(200);

    expect(disabled).toBe(true);
    expect(fake.seen).toHaveLength(3);
    expect(JSON.stringify(fake.seen[0].body)).toContain('prompt_cache_breakpoint');
    expect(fake.seen[1].body.messages).toEqual(expect.arrayContaining([
      { role: 'system', content: 'stable system' },
    ]));
    expect(JSON.stringify(fake.seen[1].body)).not.toContain('prompt_cache_breakpoint');
    expect(JSON.stringify(fake.seen[2].body)).not.toContain('prompt_cache_breakpoint');
  });

  it('does not downgrade for a content-array rejection when legacy translation has the same shape', async () => {
    fake = await startFakeUpstream(() => ({
      status: 400,
      body: {
        error: {
          param: 'messages[0].content',
          message: 'Input should be a valid string',
        },
      },
    }));
    let breakpointsDisabled = false;
    const upstream: UpstreamConfig = {
      providerId: 'strict-chat-provider',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      model: 'chat-model',
      upstreamFormat: 'chat_completions',
      cacheAffinity: {
        sessionId: 'raw-session-id',
        promptCacheKeyMode: 'session',
        promptCacheKeyDisabled: true,
        disablePromptCacheBreakpoints: () => { breakpointsDisabled = true; },
      },
    };
    const multimodalRequest: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/image.png' },
          },
        ],
      }],
      max_tokens: 32,
    };

    const response = await callBridge(upstream, null, multimodalRequest);

    expect(response.status).toBe(400);
    expect(breakpointsDisabled).toBe(false);
    expect(fake.seen).toHaveLength(1);
  });
});

describe('OpenAI bridge managed OAuth recovery', () => {
  let fake: FakeUpstream | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('refreshes and retries the byte-equivalent request exactly once after 401', async () => {
    fake = await startFakeUpstream((_body, seen) => seen.length === 1
      ? { status: 401, body: { error: { message: 'expired' } } }
      : { status: 200, body: okResponsesBody });
    let recoverCalls = 0;
    let rejectCalls = 0;
    const reported: Array<[number, number]> = [];
    const upstream: UpstreamConfig = {
      providerId: 'xai-sub',
      baseUrl: fake.baseUrl,
      apiKey: 'old-access',
      credentialVersion: 1,
      model: 'grok-4.5',
      upstreamFormat: 'responses',
      recoverAuth: async (rejected) => {
        recoverCalls += 1;
        expect(rejected).toBe(1);
        return { apiKey: 'new-access', credentialVersion: 2 };
      },
      rejectCredential: async () => { rejectCalls += 1; },
      reportOutcome: async (version, status) => { reported.push([version, status]); },
    };

    const response = await callBridge(upstream);

    expect(response.status).toBe(200);
    expect(recoverCalls).toBe(1);
    expect(rejectCalls).toBe(0);
    expect(reported).toEqual([]);
    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0].authorization).toBe('Bearer old-access');
    expect(fake.seen[1].authorization).toBe('Bearer new-access');
    expect(fake.seen[1].body).toEqual(fake.seen[0].body);
  });

  it('quarantines after the recovery retry is also 401 and never retries a third time', async () => {
    fake = await startFakeUpstream(() => ({
      status: 401,
      body: { error: { message: 'still expired' } },
    }));
    const rejected: number[] = [];
    const reported: Array<[number, number]> = [];
    const upstream: UpstreamConfig = {
      providerId: 'xai-sub',
      baseUrl: fake.baseUrl,
      apiKey: 'old-access',
      credentialVersion: 7,
      model: 'grok-4.5',
      upstreamFormat: 'responses',
      recoverAuth: async () => ({ apiKey: 'new-access', credentialVersion: 8 }),
      rejectCredential: async (version) => { rejected.push(version); },
      reportOutcome: async (version, status) => { reported.push([version, status]); },
    };

    const response = await callBridge(upstream);

    expect(response.status).toBe(401);
    expect(fake.seen).toHaveLength(2);
    expect(rejected).toEqual([8]);
    expect(reported).toEqual([[8, 401]]);
  });

  it.each([403, 429])('does not refresh on upstream HTTP %s', async (status) => {
    fake = await startFakeUpstream(() => ({
      status,
      body: { error: { message: 'not an auth-refresh signal' } },
    }));
    let recoverCalls = 0;
    const reported: Array<[number, number]> = [];
    const upstream: UpstreamConfig = {
      providerId: 'xai-sub',
      baseUrl: fake.baseUrl,
      apiKey: 'access',
      credentialVersion: 1,
      model: 'grok-4.5',
      upstreamFormat: 'responses',
      recoverAuth: async () => {
        recoverCalls += 1;
        return { apiKey: 'unexpected', credentialVersion: 2 };
      },
      reportOutcome: async (version, reportedStatus) => {
        reported.push([version, reportedStatus]);
      },
    };

    const response = await callBridge(upstream);

    expect(response.status).toBe(status);
    expect(recoverCalls).toBe(0);
    expect(reported).toEqual([[1, status]]);
    expect(fake.seen).toHaveLength(1);
  });
});
