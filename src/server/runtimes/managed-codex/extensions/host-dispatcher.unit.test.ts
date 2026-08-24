import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBuiltinMcpInstance: vi.fn(),
  getImBridgeToolServer: vi.fn(() => null),
}));

vi.mock('../../../tools/builtin-mcp-registry', () => ({
  getBuiltinMcpInstance: mocks.getBuiltinMcpInstance,
}));
vi.mock('../../../tools/im-bridge-tools', () => ({
  getImBridgeToolServer: mocks.getImBridgeToolServer,
}));

import type { ManagedCodexExtensionSnapshot } from './contracts';
import { attachManagedCodexHostTools } from './host-dispatcher';

function snapshot(): ManagedCodexExtensionSnapshot {
  return {
    revision: 'revision-one',
    workspacePath: '/workspace',
    scenario: { type: 'desktop' },
    enabledPluginIds: [],
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [{
      id: 'local-tools',
      name: 'Local tools',
      type: 'stdio',
      command: '__builtin__',
      isBuiltin: true,
    }],
    dynamicTools: [],
    components: [],
  };
}

function call(tool: string, args: unknown, generation = 'generation-one') {
  return {
    processGeneration: generation,
    threadId: 'thread-one',
    turnId: 'turn-one',
    callId: `call-${Math.random()}`,
    tool,
    arguments: args,
    signal: new AbortController().signal,
  };
}

describe('Managed Codex Host tool dispatcher', () => {
  it('discovers, validates, dispatches, and reconnects a cached in-process MCP server', async () => {
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo a value',
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({ content: [{ type: 'text', text: `echo:${value}` }] }),
    );
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));

    const first = await attachManagedCodexHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });
    expect(first.dynamicTools).toEqual([expect.objectContaining({
      name: 'myagents__mcp__local-tools__echo',
      description: 'Echo a value',
    })]);
    expect(first.dynamicTools[0]?.name).not.toMatch(/^mcp(?:__|$)/);
    expect(first.dynamicTools[0]?.name).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(first.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 'hello' }),
    )).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'text', text: 'echo:hello' }],
    });
    await expect(first.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 42 }),
    )).resolves.toMatchObject({ success: false });

    first.hostToolDispatcher!.dispose('process generation ended');
    const second = await attachManagedCodexHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });
    await expect(second.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 'again' }, 'generation-two'),
    )).resolves.toMatchObject({
      success: true,
      contentItems: [{ type: 'text', text: 'echo:again' }],
    });
    second.hostToolDispatcher!.dispose('test complete');
  });

  it('rejects stale process generations before invoking the handler', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool('once', { inputSchema: {} }, handler);
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));
    const attached = await attachManagedCodexHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });

    await attached.hostToolDispatcher!.dispatch(call('myagents__mcp__local-tools__once', {}));
    await expect(attached.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__once', {}, 'stale-generation'),
    )).rejects.toThrow(/stale/i);
    expect(handler).toHaveBeenCalledOnce();
    attached.hostToolDispatcher!.dispose('test complete');
  });

  it('rejects a server when distinct native names collapse to one Codex wire name', async () => {
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool('echo.tool', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'dot' }],
    }));
    server.registerTool('echo_tool', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'underscore' }],
    }));
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));

    const attached = await attachManagedCodexHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });

    expect(attached.dynamicTools).toEqual([]);
    expect(attached.hostToolDispatcher).toBeUndefined();
    expect(attached.components).toContainEqual(expect.objectContaining({
      component: 'host_tools',
      id: 'local-tools',
      state: 'failed',
      code: 'host_tool_name_conflict',
    }));
  });
});
