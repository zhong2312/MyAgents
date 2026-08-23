import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBuiltinMcpInstance } from '../../../tools/builtin-mcp-registry';
import { getImBridgeToolServer } from '../../../tools/im-bridge-tools';
import { MYAGENTS_TOOL_CALL_TIMEOUT_MS } from '../../../session-core/tool-call-policy';
import { maybeSpill } from '../../../utils/large-value-store';
import type {
  ManagedCodexDynamicToolSpec,
  ManagedCodexExtensionComponentResult,
  ManagedCodexExtensionSnapshot,
  ManagedCodexHostToolCall,
  ManagedCodexHostToolDispatcher,
  ManagedCodexHostToolResult,
} from './contracts';

type ConnectedMcpTool = {
  exposedName: string;
  serverId: string;
  nativeName: string;
  descriptor: ManagedCodexDynamicToolSpec;
  client: Client;
};

type InProcessMcpServer = {
  type: 'sdk';
  name: string;
  instance: McpServer;
};

type ConnectedServer = {
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
};

function stableCatalogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCatalogValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCatalogValue(entry)]),
  );
}

export function managedCodexHostCatalogFingerprint(
  descriptors: readonly ManagedCodexDynamicToolSpec[],
): string {
  const catalog = [...descriptors]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(descriptor => stableCatalogValue(descriptor));
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

/** Cached builtin MCP instances reconnect across Codex process generations. */
const serverReleaseByInstance = new WeakMap<McpServer, Promise<void>>();

async function closeConnection(connection: ConnectedServer): Promise<void> {
  const release = Promise.allSettled([
    connection.client.close(),
    connection.server.close(),
    connection.clientTransport.close(),
    connection.serverTransport.close(),
  ]).then(() => undefined);
  serverReleaseByInstance.set(connection.server, release);
  try {
    await release;
  } finally {
    if (serverReleaseByInstance.get(connection.server) === release) {
      serverReleaseByInstance.delete(connection.server);
    }
  }
}

function codexDynamicToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  // Codex reserves `mcp` and `mcp__*` for MCP tools that it owns natively.
  // These tools are proxied by MyAgents through `thread/start.dynamicTools`,
  // so their wire identity must live in a separate namespace.
  return `myagents__mcp__${safeServer}__${safeTool}`;
}

async function connectServer(
  serverId: string,
  config: InProcessMcpServer,
): Promise<{ connection: ConnectedServer; tools: ConnectedMcpTool[] }> {
  await serverReleaseByInstance.get(config.instance);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `myagents-managed-codex-${serverId}`, version: '0.4.6' });
  try {
    await config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools(undefined, { timeout: 5_000 });
    return {
      connection: {
        client,
        server: config.instance,
        clientTransport,
        serverTransport,
      },
      tools: listed.tools.map(tool => ({
        exposedName: codexDynamicToolName(serverId, tool.name),
        serverId,
        nativeName: tool.name,
        descriptor: {
          name: codexDynamicToolName(serverId, tool.name),
          description: tool.description ?? '',
          inputSchema: tool.inputSchema as Record<string, unknown>,
        },
        client,
      })),
    };
  } catch (error) {
    await closeConnection({
      client,
      server: config.instance,
      clientTransport,
      serverTransport,
    });
    throw error;
  }
}

async function mapMcpResult(
  result: {
    isError?: boolean;
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
      | { type: 'audio'; data: string; mimeType: string }
      | { type: 'resource'; resource: { uri: string; text?: string } }
      | { type: 'resource_link'; name: string; uri: string }
    >;
  },
  sessionId: string,
): Promise<ManagedCodexHostToolResult> {
  const contentItems: ManagedCodexHostToolResult['contentItems'] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      const spilled = await maybeSpill(item.text, {
        mimetype: 'text/plain; charset=utf-8',
        sessionId,
      });
      contentItems.push({
        type: 'text',
        text: 'inline' in spilled
          ? item.text
          : `${spilled.preview}\n\n[完整结果已保存为 MyAgents ref: ${spilled.id}]`,
      });
      continue;
    }
    if (item.type === 'image') {
      contentItems.push({
        type: 'image',
        dataUrl: `data:${item.mimeType};base64,${item.data}`,
      });
      continue;
    }
    if (item.type === 'audio') {
      contentItems.push({
        type: 'audio',
        dataUrl: `data:${item.mimeType};base64,${item.data}`,
      });
      continue;
    }
    if (item.type === 'resource') {
      const resource = item.resource;
      const resourceText = typeof resource.text === 'string'
        ? resource.text
        : `[MCP resource ${resource.uri}]`;
      const spilled = await maybeSpill(resourceText, {
        mimetype: 'text/plain; charset=utf-8',
        sessionId,
      });
      contentItems.push({
        type: 'text',
        text: 'inline' in spilled
          ? resourceText
          : `${spilled.preview}\n\n[完整结果已保存为 MyAgents ref: ${spilled.id}]`,
      });
      continue;
    }
    if (item.type === 'resource_link') {
      contentItems.push({ type: 'text', text: `[MCP resource ${item.name}: ${item.uri}]` });
    }
  }
  if (contentItems.length === 0) {
    contentItems.push({ type: 'text', text: result.isError ? 'Host tool failed without output.' : 'Host tool completed.' });
  }
  return { success: result.isError !== true, contentItems };
}

class McpHostToolDispatcher implements ManagedCodexHostToolDispatcher {
  readonly descriptors: readonly ManagedCodexDynamicToolSpec[];
  private readonly tools: Map<string, ConnectedMcpTool>;
  private disposed = false;
  private processGeneration: string | null = null;

  constructor(
    tools: readonly ConnectedMcpTool[],
    private readonly connections: readonly ConnectedServer[],
    private readonly sessionId: string,
  ) {
    this.tools = new Map(tools.map(tool => [tool.exposedName, tool]));
    this.descriptors = tools.map(tool => tool.descriptor);
  }

  async dispatch(call: ManagedCodexHostToolCall): Promise<ManagedCodexHostToolResult> {
    if (this.disposed) throw new Error('Managed Codex Host tool generation is closed');
    if (this.processGeneration === null) this.processGeneration = call.processGeneration;
    if (this.processGeneration !== call.processGeneration) {
      throw new Error('Stale Managed Codex Host tool generation');
    }
    const tool = this.tools.get(call.tool);
    if (!tool) throw new Error(`Unknown Managed Codex Host tool: ${call.tool}`);
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error(`Invalid arguments for Managed Codex Host tool: ${call.tool}`);
    }
    const result = await tool.client.callTool(
      { name: tool.nativeName, arguments: call.arguments as Record<string, unknown> },
      undefined,
      {
        signal: call.signal,
        timeout: MYAGENTS_TOOL_CALL_TIMEOUT_MS,
        maxTotalTimeout: MYAGENTS_TOOL_CALL_TIMEOUT_MS,
      },
    );
    return mapMcpResult(result as Parameters<typeof mapMcpResult>[0], this.sessionId);
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    console.log(`[managed-codex-host] disposing ${this.connections.length} in-process MCP connection(s): ${reason}`);
    for (const connection of this.connections) {
      void closeConnection(connection);
    }
  }
}

export async function attachManagedCodexHostTools(input: {
  snapshot: ManagedCodexExtensionSnapshot;
  sessionId: string;
  workspacePath: string;
}): Promise<ManagedCodexExtensionSnapshot> {
  const reports: ManagedCodexExtensionComponentResult[] = [...input.snapshot.components];
  const serverConfigs: Array<{ id: string; config: InProcessMcpServer }> = [];
  for (const server of input.snapshot.mcpServers) {
    if (server.command !== '__builtin__') continue;
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      reports.push({
        component: 'host_tools',
        id: server.id,
        state: 'failed',
        code: 'builtin_host_tool_unregistered',
      });
      continue;
    }
    try {
      const entry = await entryPromise;
      entry.configure?.(server.env ?? {}, { sessionId: input.sessionId, workspace: input.workspacePath });
      serverConfigs.push({ id: server.id, config: entry.server as InProcessMcpServer });
    } catch {
      reports.push({
        component: 'host_tools',
        id: server.id,
        state: 'failed',
        code: 'builtin_host_tool_load_failed',
      });
    }
  }
  const imBridgeServer = getImBridgeToolServer();
  if (imBridgeServer) serverConfigs.push({ id: 'im-bridge-tools', config: imBridgeServer });

  const connections: ConnectedServer[] = [];
  const tools: ConnectedMcpTool[] = [];
  for (const server of serverConfigs) {
    try {
      const connected = await connectServer(server.id, server.config);
      const exposedNames = new Set(tools.map(tool => tool.exposedName));
      const duplicate = connected.tools.find((tool) => {
        if (exposedNames.has(tool.exposedName)) return true;
        exposedNames.add(tool.exposedName);
        return false;
      });
      if (duplicate) {
        await closeConnection(connected.connection);
        reports.push({
          component: 'host_tools',
          id: server.id,
          state: 'failed',
          code: 'host_tool_name_conflict',
        });
        continue;
      }
      connections.push(connected.connection);
      tools.push(...connected.tools);
      reports.push({
        component: 'host_tools',
        id: server.id,
        state: 'applied',
        code: 'host_tools_connected',
        message: `${connected.tools.length} tool(s)`,
      });
    } catch {
      reports.push({
        component: 'host_tools',
        id: server.id,
        state: 'failed',
        code: 'host_tools_connect_failed',
      });
    }
  }

  if (tools.length === 0) {
    for (const connection of connections) void closeConnection(connection);
    return { ...input.snapshot, components: reports };
  }
  const dispatcher = new McpHostToolDispatcher(tools, connections, input.sessionId);
  return {
    ...input.snapshot,
    dynamicTools: [...dispatcher.descriptors],
    hostToolDispatcher: dispatcher,
    components: reports,
  };
}
