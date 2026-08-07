import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpServerDefinition } from '../../shared/config-types';
import { testMcpServerConnection } from './mcp-connection-test';

describe('MCP connection test lifecycle', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const scratch of scratchDirs.splice(0)) {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('times out a stalled stdio initialize and terminates the child process', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-probe-'));
    scratchDirs.push(scratch);
    const pidFile = join(scratch, 'child.pid');
    const serverCode = [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.MCP_TEST_PID_FILE, String(process.pid));",
      'process.stdin.resume();',
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    const server: McpServerDefinition = {
      id: 'stalled-stdio',
      name: 'Stalled stdio fixture',
      type: 'stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', serverCode],
      env: { MCP_TEST_PID_FILE: pidFile },
      isBuiltin: false,
    };

    await expect(testMcpServerConnection(server, { timeoutMs: 100 })).rejects.toMatchObject({
      message: 'Connection timed out (1s)',
    });

    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    }, { timeout: 2_000 });
  });

  it('passes the Session executable PATH and workspace cwd to a stdio probe', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-probe-env-'));
    scratchDirs.push(scratch);
    const resultFile = join(scratch, 'probe.json');
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const expectedPath = process.platform === 'win32' ? 'C:\\probe-bin' : '/probe-bin';
    const serverCode = [
      "import { writeFileSync } from 'node:fs';",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      '  buffer += chunk;',
      "  let newline = buffer.indexOf('\\n');",
      '  while (newline >= 0) {',
      '    const line = buffer.slice(0, newline);',
      '    buffer = buffer.slice(newline + 1);',
      '    if (line) {',
      '      const request = JSON.parse(line);',
      "      if (request.method === 'initialize') {",
      `        writeFileSync(process.env.MCP_TEST_RESULT_FILE, JSON.stringify({ cwd: process.cwd(), path: process.env[${JSON.stringify(pathKey)}] }));`,
      "        const response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: 'probe-env', version: '1.0.0' } } };",
      "        process.stdout.write(JSON.stringify(response) + '\\n');",
      '      }',
      '    }',
      "    newline = buffer.indexOf('\\n');",
      '  }',
      '});',
      "process.stdin.on('end', () => process.exit(0));",
    ].join('\n');
    const server: McpServerDefinition = {
      id: 'probe-env',
      name: 'Probe env fixture',
      type: 'stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', serverCode],
      env: { MCP_TEST_RESULT_FILE: resultFile },
      isBuiltin: false,
    };

    await expect(testMcpServerConnection(server, {
      timeoutMs: 1_000,
      executionEnv: { [pathKey]: expectedPath },
      cwd: scratch,
    })).resolves.toMatchObject({ serverName: 'probe-env' });

    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
      cwd: realpathSync(scratch),
      path: expectedPath,
    });
  });

  it('redacts a credential supplied as a sensitive command argument', async () => {
    const secret = 'argument-secret-504';
    const headerSecret = 'header-secret-504';
    const server: McpServerDefinition = {
      id: 'argument-secret-stdio',
      name: 'Argument secret fixture',
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        "process.stderr.write(process.argv.slice(1).join(' ')); process.exit(1)",
        '--',
        '--token',
        secret,
        '--header',
        `Authorization: Bearer ${headerSecret}`,
      ],
      isBuiltin: false,
    };

    const result = testMcpServerConnection(server, { timeoutMs: 1_000 });
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining('Server stderr:'),
    });
    await expect(result).rejects.not.toThrow(secret);
    await expect(result).rejects.not.toThrow(headerSecret);
  });

  it('redacts URL, header, and inherited proxy credentials from remote errors', async () => {
    const urlSecret = 'url-secret-504';
    const headerSecret = 'remote-header-secret-504';
    const proxySecret = 'proxy-secret-504';
    vi.stubEnv('HTTPS_PROXY', `http://proxy-user:${proxySecret}@proxy.invalid:8080`);
    const server: McpServerDefinition = {
      id: 'remote-secrets',
      name: 'Remote secret fixture',
      type: 'http',
      url: `https://url-user:${urlSecret}@mcp.invalid/mcp?api_key=${urlSecret}`,
      headers: { Authorization: `Bearer ${headerSecret}` },
      isBuiltin: false,
    };

    const result = testMcpServerConnection(server, {
      timeoutMs: 1_000,
      fetch: async (url, init) => new Response([
        String(url),
        new Headers(init?.headers).get('Authorization'),
        process.env.HTTPS_PROXY,
      ].join(' '), { status: 500 }),
    });

    await expect(result).rejects.not.toThrow(urlSecret);
    await expect(result).rejects.not.toThrow(headerSecret);
    await expect(result).rejects.not.toThrow(proxySecret);
  });

  it.each([401, 403])('preserves an SSE initialize POST HTTP %s status', async (status) => {
    const encoder = new TextEncoder();
    const server: McpServerDefinition = {
      id: `sse-auth-${status}`,
      name: 'SSE auth fixture',
      type: 'sse',
      url: 'https://mcp.invalid/events',
      isBuiltin: false,
    };

    const result = testMcpServerConnection(server, {
      timeoutMs: 1_000,
      fetch: async (_url, init) => {
        if (init?.method === 'POST') return new Response('denied', { status });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    await expect(result).rejects.toMatchObject({ statusCode: status });
  });

  it('bounds an arbitrarily large MCP initialize error', async () => {
    const serverCode = [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      '  buffer += chunk;',
      "  let newline = buffer.indexOf('\\n');",
      '  while (newline >= 0) {',
      '    const line = buffer.slice(0, newline);',
      '    buffer = buffer.slice(newline + 1);',
      "    if (line) {",
      '      const request = JSON.parse(line);',
      "      if (request.method === 'initialize') {",
      "        const response = { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'x'.repeat(10_000) } };",
      "        process.stdout.write(JSON.stringify(response) + '\\n');",
      '      }',
      '    }',
      "    newline = buffer.indexOf('\\n');",
      '  }',
      '});',
      "process.stdin.on('end', () => process.exit(0));",
    ].join('\n');
    const server: McpServerDefinition = {
      id: 'large-error-stdio',
      name: 'Large error fixture',
      type: 'stdio',
      command: process.execPath,
      args: ['-e', serverCode],
      isBuiltin: false,
    };

    const result = testMcpServerConnection(server, { timeoutMs: 1_000 });
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining('diagnostic truncated'),
    });
    try {
      await result;
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual(4_000);
    }
  });
});
