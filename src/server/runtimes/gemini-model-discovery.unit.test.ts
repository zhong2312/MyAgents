import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const subprocessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const killMocks = vi.hoisted(() => ({
  killWithEscalation: vi.fn(),
}));

vi.mock('../utils/subprocess', () => ({ spawn: subprocessMocks.spawn }));
vi.mock('./utils/kill-with-escalation', () => ({ killWithEscalation: killMocks.killWithEscalation }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

type FakeProcess = {
  pid: number;
  stdin: { write(chunk: Uint8Array): Promise<void>; end(): Promise<void>; underlying: never };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: ReturnType<typeof vi.fn>;
};

function fakeAcpProcess(respond = true): FakeProcess {
  const encoder = new TextEncoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let closed = false;
  const stdout = new ReadableStream<Uint8Array>({ start: controller => { stdoutController = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ start: controller => { stderrController = controller; } });
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  const kill = vi.fn(() => {
    if (!closed) {
      closed = true;
      stdoutController.close();
      stderrController.close();
      resolveExit(0);
    }
    return true;
  });
  return {
    pid: 4242,
    stdout,
    stderr,
    exited,
    kill,
    stdin: {
      underlying: undefined as never,
      async write(chunk: Uint8Array) {
        if (!respond) return;
        const request = JSON.parse(new TextDecoder().decode(chunk)) as { id: number; method: string };
        const result = request.method === 'session/new'
          ? {
              models: {
                availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
                currentModelId: 'gemini-2.5-pro',
              },
            }
          : {};
        queueMicrotask(() => stdoutController.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)));
      },
      async end() {},
    },
  };
}

let scratch: string;
let previousHome: string | undefined;
let previousGeminiHome: string | undefined;
let previousGeminiKey: string | undefined;
let previousGca: string | undefined;
let previousCloudAccessToken: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-gemini-discovery-'));
  previousHome = process.env.HOME;
  previousGeminiHome = process.env.GEMINI_CLI_HOME;
  previousGeminiKey = process.env.GEMINI_API_KEY;
  previousGca = process.env.GOOGLE_GENAI_USE_GCA;
  previousCloudAccessToken = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
  process.env.HOME = scratch;
  delete process.env.GEMINI_CLI_HOME;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENAI_USE_GCA;
  delete process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
  vi.resetModules();
  subprocessMocks.spawn.mockReset();
  killMocks.killWithEscalation.mockReset();
  killMocks.killWithEscalation.mockImplementation(async (process: { kill(signal?: number): void }) => {
    process.kill(15);
    return { exited: true, signalUsed: 'graceful', orphanRisk: false, elapsedMs: 0 };
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = previousGeminiHome;
  if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousGeminiKey;
  if (previousGca === undefined) delete process.env.GOOGLE_GENAI_USE_GCA; else process.env.GOOGLE_GENAI_USE_GCA = previousGca;
  if (previousCloudAccessToken === undefined) delete process.env.GOOGLE_CLOUD_ACCESS_TOKEN; else process.env.GOOGLE_CLOUD_ACCESS_TOKEN = previousCloudAccessToken;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Gemini model discovery', () => {
  it('fails before spawn when an OAuth method is selected without credential evidence', async () => {
    const configDir = join(scratch, '.gemini');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
    }));
    const { assertGeminiModelDiscoveryAuthConfigured } = await import('./gemini');

    expect(() => assertGeminiModelDiscoveryAuthConfigured()).toThrow(/authenticate|login|credential/i);
    expect(subprocessMocks.spawn).not.toHaveBeenCalled();
  });

  it('does not treat the GCA selector alone as credential evidence', async () => {
    process.env.GOOGLE_GENAI_USE_GCA = 'true';
    const { assertGeminiModelDiscoveryAuthConfigured } = await import('./gemini');

    expect(() => assertGeminiModelDiscoveryAuthConfigured()).toThrow(/authenticate|login|credential/i);
    expect(subprocessMocks.spawn).not.toHaveBeenCalled();
  });

  it('tree-kills the temporary ACP process and bounds stream cleanup after success', async () => {
    process.env.GEMINI_API_KEY = 'test-only-key';
    const fakeProcess = fakeAcpProcess();
    subprocessMocks.spawn.mockReturnValue(fakeProcess);
    const { queryGeminiModelsViaAcp } = await import('./gemini');

    await expect(queryGeminiModelsViaAcp()).resolves.toEqual([
      { value: '', displayName: '默认', isDefault: true },
      expect.objectContaining({ value: 'gemini-2.5-pro' }),
    ]);
    expect(subprocessMocks.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(['--acp']),
      expect.objectContaining({ detached: process.platform !== 'win32', windowsHide: true }),
    );
    expect(killMocks.killWithEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4242 }),
      expect.objectContaining({ killTree: true }),
    );
  });

  it('cleans the process tree immediately when the discovery owner is aborted', async () => {
    process.env.GEMINI_API_KEY = 'test-only-key';
    subprocessMocks.spawn.mockReturnValue(fakeAcpProcess(false));
    const { queryGeminiModelsViaAcp } = await import('./gemini');
    const controller = new AbortController();

    const query = queryGeminiModelsViaAcp(controller.signal);
    controller.abort(new Error('request interrupted'));

    await expect(query).rejects.toThrow('request interrupted');
    expect(killMocks.killWithEscalation).toHaveBeenCalled();
  });
});
