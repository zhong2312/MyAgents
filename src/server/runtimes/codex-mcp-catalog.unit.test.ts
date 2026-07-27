import { describe, expect, it, vi } from 'vitest';

import {
  buildCodexMcpToolCatalog,
  listCodexMcpServerStatuses,
  type CodexMcpServerStatus,
} from './codex';

function server(
  name: string,
  tools: CodexMcpServerStatus['tools'],
  authStatus: unknown = 'unsupported',
): CodexMcpServerStatus {
  return { name, tools, resources: [], authStatus };
}

describe('buildCodexMcpToolCatalog', () => {
  it('maps only tools from ready, usable servers to the shared MCP naming convention', () => {
    expect(buildCodexMcpToolCatalog([
      server('playwright', {
        browser_click: { name: 'browser_click' },
        browser_navigate: { name: 'browser_navigate' },
      }),
      server('search', { query: { name: 'query' } }, 'oAuth'),
      server('failed', { stale_tool: { name: 'stale_tool' } }),
      server('login-required', { private_tool: { name: 'private_tool' } }, 'notLoggedIn'),
    ], new Set(['playwright', 'search', 'login-required']))).toEqual([
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_navigate',
      'mcp__search__query',
    ]);
  });

  it('uses the map key when an older Codex payload omits Tool.name', () => {
    expect(buildCodexMcpToolCatalog([
      server('legacy', { do_work: {} }),
    ], new Set(['legacy']))).toEqual(['mcp__legacy__do_work']);
  });
});

describe('listCodexMcpServerStatuses', () => {
  it('reads every page from the active thread with tool detail', async () => {
    const playwright = server('playwright', { browser_click: { name: 'browser_click' } });
    const search = server('search', { query: { name: 'query' } });
    const call = vi.fn()
      .mockResolvedValueOnce({ data: [playwright], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [search], nextCursor: null });

    await expect(listCodexMcpServerStatuses({ call }, 'thread-1')).resolves.toEqual([
      playwright,
      search,
    ]);
    expect(call).toHaveBeenNthCalledWith(1, 'mcpServerStatus/list', {
      threadId: 'thread-1',
      detail: 'toolsAndAuthOnly',
    }, 5_000);
    expect(call).toHaveBeenNthCalledWith(2, 'mcpServerStatus/list', {
      threadId: 'thread-1',
      detail: 'toolsAndAuthOnly',
      cursor: 'page-2',
    }, 5_000);
  });
});
