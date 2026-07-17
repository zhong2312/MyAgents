import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createBridgeHandler } from './handler';
import type { AnthropicRequest } from './types/anthropic';

const requestBody: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 32,
};

describe('OpenAI bridge timeout ownership', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('keeps a bounded timeout for response headers', async () => {
    server = createServer((req) => {
      req.resume();
      // Deliberately never send response headers. The bridge must abort this
      // connection using the headers-only timeout, independently of stream
      // body lifetime.
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test upstream');

    const handler = createBridgeHandler({
      getUpstreamConfig: () => ({
        providerId: 'timeout-fixture',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: 'test-key',
      }),
      upstreamHeadersTimeoutMs: 25,
      logger: null,
    });
    const response = await handler(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }));

    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Upstream request timed out' },
    });
  });

  it('stops the headers timer before reading a non-2xx response body', async () => {
    server = createServer((req, res) => {
      req.resume();
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.flushHeaders();
      setTimeout(() => {
        res.end(JSON.stringify({ error: { message: 'late upstream failure' } }));
      }, 100);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test upstream');

    const handler = createBridgeHandler({
      getUpstreamConfig: () => ({
        providerId: 'slow-error-body-fixture',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: 'test-key',
      }),
      upstreamHeadersTimeoutMs: 25,
      logger: null,
    });
    const response = await handler(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'late upstream failure' },
    });
  });
});
