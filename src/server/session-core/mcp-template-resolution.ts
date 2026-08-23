import type { McpServerDefinition } from '../../shared/config-types';

const MCP_TEMPLATE_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export class McpTemplateResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTemplateResolutionError';
  }
}

export function resolveMcpTemplateValue(
  value: string,
  env: Readonly<Record<string, string>> | undefined,
): string | null {
  let missing = false;
  const resolved = value.replace(MCP_TEMPLATE_RE, (_match, key: string) => {
    const replacement = env?.[key];
    if (replacement === undefined) {
      missing = true;
      return '';
    }
    return replacement;
  });
  return missing ? null : resolved;
}

/** Resolve MyAgents-owned placeholders before handing a remote MCP to a transport. */
export function resolveRemoteMcpTransportConfig(
  server: Pick<McpServerDefinition, 'id' | 'url' | 'headers' | 'env'>,
): { url: string; headers: Record<string, string> } {
  if (!server.url) {
    throw new McpTemplateResolutionError(`MCP server '${server.id}' has no URL configured`);
  }
  const url = resolveMcpTemplateValue(server.url, server.env);
  if (url === null) {
    throw new McpTemplateResolutionError(`MCP server '${server.id}' URL references a missing env placeholder`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const resolved = resolveMcpTemplateValue(value, server.env);
    if (resolved === null) {
      throw new McpTemplateResolutionError(
        `MCP server '${server.id}' header '${name}' references a missing env placeholder`,
      );
    }
    headers[name] = resolved;
  }
  return { url, headers };
}
