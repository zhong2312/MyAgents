import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const startupDelayMs = Number.parseInt(process.env.MYAGENTS_TEST_MCP_DELAY_MS ?? '0', 10);
if (Number.isFinite(startupDelayMs) && startupDelayMs > 0) {
  await new Promise(resolve => setTimeout(resolve, startupDelayMs));
}

const server = new McpServer({ name: 'myagents-delayed-readiness-fixture', version: '1.0.0' });
server.registerTool(
  'delayed_echo',
  { description: 'Return the exact delayed MCP readiness fixture marker.' },
  async () => ({
    content: [{ type: 'text', text: 'MYAGENTS_DELAYED_MCP_READY' }],
  }),
);

await server.connect(new StdioServerTransport());
