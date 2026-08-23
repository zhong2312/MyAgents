import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Stream } from 'node:stream';

import type { McpServerDefinition } from '../../shared/config-types';
import { buildMcpSubprocessEnv } from '../session-core/mcp-env-policy';
import {
  McpTemplateResolutionError,
  resolveRemoteMcpTransportConfig,
} from '../session-core/mcp-template-resolution';
import { resolveNpxMcpInvocation } from './mcp-command';

export const MCP_CONNECTION_TEST_TIMEOUT_MS = 15_000;

const MAX_DIAGNOSTIC_CHARS = 4_000;
const MAX_STDERR_CHARS = MAX_DIAGNOSTIC_CHARS;
const SENSITIVE_ARG_NAME = /(?:api[-_]?key|auth(?:orization)?|credential|pass(?:phrase|word)?|secret|token)/i;
const PROXY_ENV_NAME = /^(?:https?|all)_proxy$/i;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const SENSITIVE_URL_PARAM = /([?&][^=&#\s]*(?:api[-_]?key|auth(?:orization)?|credential|pass(?:phrase|word)?|secret|token)[^=&#\s]*=)[^&#\s]*/gi;
const SSE_POST_AUTH_ERROR = /^Error POSTing to endpoint \(HTTP (401|403)\):/;

export interface McpConnectionTestResult {
  transport: 'stdio' | 'sse' | 'http';
  serverName?: string;
  serverVersion?: string;
  resolvedCommand?: string;
}

export class McpConnectionTestError extends Error {
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { statusCode?: number } = {},
  ) {
    super(message);
    this.name = 'McpConnectionTestError';
    this.statusCode = options.statusCode;
  }
}

interface McpConnectionTestOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  executionEnv?: Record<string, string>;
  cwd?: string;
}

interface ProbeTransport {
  transport: Transport;
  stderr?: Stream;
  resolvedCommand?: string;
}

function resolveRemoteMcpConfig(
  server: McpServerDefinition,
): { url: URL; headers: Record<string, string> } {
  try {
    const remote = resolveRemoteMcpTransportConfig(server);
    return { url: new URL(remote.url), headers: remote.headers };
  } catch (error) {
    throw new McpConnectionTestError(
      error instanceof McpTemplateResolutionError
        ? error.message
        : `MCP server '${server.id}' has an invalid URL`,
    );
  }
}

function createProbeTransport(
  server: McpServerDefinition,
  options: McpConnectionTestOptions,
): ProbeTransport {
  if (server.type === 'stdio') {
    if (!server.command) {
      throw new McpConnectionTestError(`MCP server '${server.id}' has no command configured`);
    }
    let command = server.command;
    let args = Array.isArray(server.args) ? [...server.args] : [];
    if (command === 'npx') {
      const invocation = resolveNpxMcpInvocation(args, {
        pinPresetPackages: server.isBuiltin === true,
      });
      command = invocation.command;
      args = invocation.args;
    }
    const transport = new StdioClientTransport({
      command,
      args,
      env: {
        ...options.executionEnv,
        ...buildMcpSubprocessEnv(process.env, server.env),
      },
      cwd: options.cwd,
      stderr: 'pipe',
    });
    return {
      transport,
      stderr: transport.stderr ?? undefined,
      resolvedCommand: command,
    };
  }

  const remote = resolveRemoteMcpConfig(server);
  const requestInit: RequestInit = { headers: remote.headers };
  if (server.type === 'http') {
    return {
      transport: new StreamableHTTPClientTransport(remote.url, {
        requestInit,
        fetch: options.fetch,
      }),
    };
  }
  if (server.type === 'sse') {
    return {
      transport: new SSEClientTransport(remote.url, {
        requestInit,
        fetch: options.fetch,
        eventSourceInit: options.fetch ? { fetch: options.fetch } : undefined,
      }),
    };
  }

  throw new McpConnectionTestError(
    `MCP server '${server.id}' has unsupported transport type '${String(server.type)}'`,
  );
}

async function connectWithDeadline(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new McpConnectionTestError(
        `Connection timed out (${Math.ceil(timeoutMs / 1_000)}s)`,
      ));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      client.connect(transport, { timeout: timeoutMs }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendBoundedStderr(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length > MAX_STDERR_CHARS
    ? combined.slice(-MAX_STDERR_CHARS)
    : combined;
}

function appendUrlValue(values: string[], value: string): void {
  if (!value) return;
  values.push(value);
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) values.push(decoded);
  } catch {
    // The full URL will still be scrubbed by the generic URL credential pass.
  }
}

function getSensitiveUrlValues(server: McpServerDefinition): string[] {
  if (!server.url) return [];
  const resolvedUrl = server.url.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => server.env?.[key] ?? '',
  );
  try {
    const url = new URL(resolvedUrl);
    const values: string[] = [];
    appendUrlValue(values, url.username);
    appendUrlValue(values, url.password);
    for (const [name, value] of url.searchParams) {
      if (SENSITIVE_ARG_NAME.test(name)) appendUrlValue(values, value);
    }
    return values;
  } catch {
    return [];
  }
}

function getSensitiveAssignmentValue(value: string): string | undefined {
  const assignment = value.replace(/^--?/, '').match(/^([^=:]+)[=:]\s*(.+)$/);
  return assignment && SENSITIVE_ARG_NAME.test(assignment[1])
    ? assignment[2]
    : undefined;
}

function getConfiguredSensitiveValues(server: McpServerDefinition): string[] {
  const values = [
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
    ...Object.entries(process.env)
      .filter(([name, value]) => PROXY_ENV_NAME.test(name) && typeof value === 'string')
      .map(([, value]) => value),
    ...getSensitiveUrlValues(server),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const assignmentValue = getSensitiveAssignmentValue(arg);
    if (assignmentValue) {
      values.push(assignmentValue);
      continue;
    }
    const flag = arg.match(/^--?(.+)$/);
    const nextArg = args[index + 1];
    if (
      flag
      && SENSITIVE_ARG_NAME.test(flag[1])
      && nextArg
      && !nextArg.startsWith('-')
    ) {
      values.push(nextArg);
      index += 1;
      continue;
    }
    if (flag && /^(?:h|header)$/i.test(flag[1]) && nextArg) {
      const headerValue = getSensitiveAssignmentValue(nextArg);
      if (headerValue) values.push(headerValue);
      index += 1;
    }
  }
  return values;
}

function redactConfiguredValues(text: string, server: McpServerDefinition): string {
  let redacted = text;
  const sensitiveValues = [...new Set(getConfiguredSensitiveValues(server))]
    .sort((left, right) => right.length - left.length);
  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join('****');
  }
  return redacted
    .replace(URL_USERINFO, '$1****@')
    .replace(SENSITIVE_URL_PARAM, '$1****');
}

function boundDiagnostic(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  const suffix = '\n… diagnostic truncated';
  return `${text.slice(0, MAX_DIAGNOSTIC_CHARS - suffix.length)}${suffix}`;
}

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  if (error instanceof Error) {
    const ssePostStatus = error.message.match(SSE_POST_AUTH_ERROR)?.[1];
    if (ssePostStatus) return Number(ssePostStatus);
  }
  return undefined;
}

function normalizeConnectionError(
  error: unknown,
  stderr: string,
  server: McpServerDefinition,
): McpConnectionTestError {
  const message = redactConfiguredValues(
    error instanceof Error ? error.message : String(error),
    server,
  );
  const stderrDetail = redactConfiguredValues(stderr, server).trim();
  return new McpConnectionTestError(
    boundDiagnostic(stderrDetail ? `${message}\nServer stderr:\n${stderrDetail}` : message),
    {
      statusCode: error instanceof McpConnectionTestError
        ? error.statusCode
        : errorStatusCode(error),
    },
  );
}

/**
 * Start the exact configured external MCP transport and require a successful
 * protocol initialize. The Client owns the transport for the duration of this
 * probe, and cleanup always closes the child/socket even on timeout or failure.
 */
export async function testMcpServerConnection(
  server: McpServerDefinition,
  options: McpConnectionTestOptions = {},
): Promise<McpConnectionTestResult> {
  const timeoutMs = options.timeoutMs ?? MCP_CONNECTION_TEST_TIMEOUT_MS;
  const probe = createProbeTransport(server, options);
  const client = new Client({ name: 'myagents-mcp-test', version: '1.0.0' });
  let stderr = '';
  const onStderr = (chunk: unknown): void => {
    stderr = appendBoundedStderr(stderr, chunk);
  };
  probe.stderr?.on('data', onStderr);

  let failure: unknown;
  let serverInfo: ReturnType<Client['getServerVersion']>;
  try {
    await connectWithDeadline(client, probe.transport, timeoutMs);
    serverInfo = client.getServerVersion();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      failure ??= closeError;
    }
    probe.stderr?.off('data', onStderr);
  }

  if (failure) {
    throw normalizeConnectionError(failure, stderr, server);
  }

  return {
    transport: server.type,
    serverName: serverInfo?.name,
    serverVersion: serverInfo?.version,
    resolvedCommand: probe.resolvedCommand,
  };
}
