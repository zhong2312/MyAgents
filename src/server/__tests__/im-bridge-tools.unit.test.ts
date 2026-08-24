import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  handlers: new Map<string, (params: { args: Record<string, unknown> }, extra?: unknown) => Promise<unknown>>(),
  createServer: vi.fn((config: unknown) => ({ type: 'sdk', name: 'im-bridge-tools', config })),
}));

vi.mock('../utils/cancellation', () => ({
  cancellableFetch: mocks.fetch,
}));

vi.mock('../utils/large-value-store', () => ({
  maybeSpill: vi.fn(async (value: string) => ({ inline: value })),
}));

vi.mock('../utils/turn-abort', () => ({
  getCurrentTurnSignal: vi.fn(() => undefined),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: mocks.createServer,
  tool: vi.fn((
    name: string,
    _description: string,
    _schema: unknown,
    handler: (params: { args: Record<string, unknown> }, extra?: unknown) => Promise<unknown>,
  ) => {
    mocks.handlers.set(name, handler);
    return { name };
  }),
}));

import { MCP_PREWARM_GRACE_MS } from '../session-core/mcp-prewarm-policy';
import {
  clearImBridgeToolsContext,
  ensureImBridgeToolSurface,
  getImBridgeToolServer,
  imBridgeToolSurfaceIdentity,
} from '../tools/im-bridge-tools';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const discoveryBody = {
  ok: true,
  tools: [{
    name: 'search_docs',
    description: 'Search documents',
    group: 'docs',
    parameters: {},
  }],
};

describe('IM Bridge stable tool surface', () => {
  beforeEach(() => {
    clearImBridgeToolsContext();
    mocks.fetch.mockReset();
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    mocks.fetch.mockImplementation(async (url: string) => (
      url.includes('/mcp/tools')
        ? jsonResponse(discoveryBody)
        : jsonResponse({ ok: true, result: 'done' })
    ));
  });

  afterEach(() => {
    clearImBridgeToolsContext();
  });

  it('normalizes group order, duplicates, and the interaction group into one identity', () => {
    expect(imBridgeToolSurfaceIdentity({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs', 'interaction', 'docs'],
    })).toBe(imBridgeToolSurfaceIdentity({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }));
  });

  it('discovers and builds a stable surface only once across consecutive messages', async () => {
    const resolveContext = () => ({ senderId: 'user-1' });
    const first = await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, resolveContext);
    const server = getImBridgeToolServer();
    const second = await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['interaction', 'docs', 'docs'],
    }, resolveContext);

    expect(first).toMatchObject({ changed: true, state: 'ready' });
    expect(second).toMatchObject({ changed: false, state: 'ready', generation: first.generation });
    expect(getImBridgeToolServer()).toBe(server);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
    const discoveryOptions = mocks.fetch.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(discoveryOptions.timeoutMs).toBeGreaterThan(0);
    expect(discoveryOptions.timeoutMs).toBeLessThanOrEqual(MCP_PREWARM_GRACE_MS);
  });

  it('keeps a degraded surface terminal instead of retrying per message', async () => {
    mocks.fetch.mockResolvedValue(new Response('bridge unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    }));
    const resolveContext = () => ({ senderId: 'user-1' });

    const first = await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, resolveContext);
    const second = await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, resolveContext);

    expect(first).toMatchObject({ changed: true, state: 'degraded' });
    expect(second).toMatchObject({ changed: false, state: 'degraded' });
    expect(getImBridgeToolServer()).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('creates a new generation only for a real surface identity change', async () => {
    const resolveContext = () => ({ senderId: 'user-1' });
    const first = await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, resolveContext);
    const second = await ensureImBridgeToolSurface({
      bridgePort: 4313,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, resolveContext);

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.changed).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves sender and chat identity from the active turn for every tool call', async () => {
    let currentContext = {
      senderId: 'user-1',
      chatId: 'chat-1',
      isOwner: false,
      sourceType: 'private',
      accountId: 'account-a',
    };
    await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, () => currentContext);
    const handler = mocks.handlers.get('search_docs');
    expect(handler).toBeDefined();

    await handler?.({ args: { query: 'first' } });
    currentContext = {
      senderId: 'user-2',
      chatId: 'chat-2',
      isOwner: true,
      sourceType: 'group',
      accountId: 'account-b',
    };
    await handler?.({ args: { query: 'second' } });

    const callBodies = mocks.fetch.mock.calls
      .filter(call => String(call[0]).includes('/mcp/call-tool'))
      .map(call => JSON.parse((call[1] as RequestInit).body as string));
    expect(callBodies).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        chatId: 'chat-1',
        chatType: 'p2p',
        accountId: 'account-a',
        isOwner: false,
      }),
      expect.objectContaining({
        userId: 'user-2',
        chatId: 'chat-2',
        chatType: 'group',
        accountId: 'account-b',
        isOwner: true,
      }),
    ]);
  });

  it('passes the Host call cancellation signal to the Bridge request', async () => {
    await ensureImBridgeToolSurface({
      bridgePort: 4312,
      pluginId: 'feishu',
      enabledToolGroups: ['docs'],
    }, () => ({ senderId: 'user-1' }));
    const controller = new AbortController();

    await mocks.handlers.get('search_docs')?.({ args: { query: 'cancel' } }, {
      signal: controller.signal,
    });

    const bridgeCall = mocks.fetch.mock.calls.find(call => String(call[0]).includes('/mcp/call-tool'));
    expect(bridgeCall?.[2]).toMatchObject({ parentSignal: controller.signal });
  });
});
