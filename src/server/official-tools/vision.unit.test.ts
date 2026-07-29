import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkChildLaunchCircuitOpenError } from '../utils/sdk-subprocess-diagnostics';

const mocks = vi.hoisted(() => ({
  workspace: '',
  capturedPromptText: '',
  queryMode: 'success' as 'success' | 'hang',
  lastAbortController: undefined as AbortController | undefined,
  lastQueryClose: undefined as ReturnType<typeof vi.fn> | undefined,
  loadConfig: vi.fn(),
  getEffectiveOfficialToolIdsForSession: vi.fn(() => ['image-understanding']),
  resolveImageUnderstandingToolAvailability: vi.fn(),
  resolveProviderEnv: vi.fn(() => ({ apiKey: 'test-key', baseUrl: 'https://example.test', apiProtocol: 'anthropic' })),
  findEffectiveProvider: vi.fn(),
  getAllEffectiveProviders: vi.fn(),
  processImage: vi.fn(async (image: unknown) => [image]),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<{ message?: { content?: unknown } }>; options?: { abortController?: AbortController } }) => {
    mocks.lastAbortController = args.options?.abortController;
    const close = vi.fn();
    mocks.lastQueryClose = close;
    const iterable = {
      async *[Symbol.asyncIterator]() {
        if (mocks.queryMode === 'hang') {
          await new Promise<never>(() => { /* intentionally pending */ });
        }
        for await (const item of args.prompt) {
          const content = item.message?.content;
          if (Array.isArray(content)) {
            const lastText = content
              .map(block => (block && typeof block === 'object' ? (block as { text?: unknown }).text : undefined))
              .filter((text): text is string => typeof text === 'string')
              .pop();
            mocks.capturedPromptText = lastText ?? '';
          }
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'vision result' }] } };
      },
      close,
      return: vi.fn(),
    };
    return iterable;
  }),
}));

vi.mock('../agent-session', () => ({
  buildClaudeSessionEnv: vi.fn(() => ({})),
  resolveClaudeCodeCli: vi.fn(() => 'claude'),
  startOneShotBridge: vi.fn(() => null),
}));

vi.mock('../utils/admin-config', () => ({
  findEffectiveProvider: mocks.findEffectiveProvider,
  getAllEffectiveProviders: mocks.getAllEffectiveProviders,
  getEffectiveOfficialToolIdsForSession: mocks.getEffectiveOfficialToolIdsForSession,
  loadConfig: mocks.loadConfig,
  resolveImageUnderstandingToolAvailability: mocks.resolveImageUnderstandingToolAvailability,
  resolveProviderEnv: mocks.resolveProviderEnv,
}));

vi.mock('../utils/imageResize', () => ({
  processImage: mocks.processImage,
}));

const { analyzeImages, buildVisionPrompt, getVisionToolReadme, isVisionUrlLikeInput, visionErrorResponse } = await import('./vision');

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function configureVisionProvider() {
  const config = {
    enabledOfficialToolIds: ['image-understanding'],
    officialToolSettings: {
      imageUnderstanding: { providerId: 'vision-provider', model: 'vision-model' },
    },
  };
  const provider = {
    id: 'vision-provider',
    name: 'Vision Provider',
    type: 'api',
    enabled: true,
    models: [{ model: 'vision-model', modelName: 'Vision Model', inputModalities: ['text', 'image'] }],
  };
  mocks.loadConfig.mockReturnValue(config);
  mocks.findEffectiveProvider.mockReturnValue(provider);
  mocks.getAllEffectiveProviders.mockReturnValue([provider]);
  mocks.resolveImageUnderstandingToolAvailability.mockReturnValue({
    ok: true,
    providerId: 'vision-provider',
    model: 'vision-model',
    provider,
    modelEntry: { model: 'vision-model', inputModalities: ['text', 'image'] },
  });
}

describe('official vision tool', () => {
  it('maps SDK launch circuit denial to an actionable service error', () => {
    const response = visionErrorResponse(
      new SdkChildLaunchCircuitOpenError('EPERM', 42_000, 'darwin'),
    );

    expect(response.status).toBe(503);
    expect(response.error).toContain('macOS');
    expect(response.error).not.toContain('SDK_CHILD_LAUNCH_CIRCUIT_OPEN');
  });

  beforeEach(() => {
    mocks.workspace = mkdtempSync(join(tmpdir(), 'myagents-vision-unit-'));
    mocks.capturedPromptText = '';
    mocks.queryMode = 'success';
    mocks.lastAbortController = undefined;
    mocks.lastQueryClose = undefined;
    vi.clearAllMocks();
    configureVisionProvider();
  });

  afterEach(() => {
    rmSync(mocks.workspace, { recursive: true, force: true });
  });

  it('combines the default visual analysis contract with a specific prompt', () => {
    const prompt = buildVisionPrompt('Read the error banner.');

    expect(prompt).toContain('Analyze the provided image(s)');
    expect(prompt).toContain('Specific inspection request from the calling agent:');
    expect(prompt).toContain('Read the error banner.');
  });

  it('documents prompt-file as a workspace-scoped option', () => {
    const readme = getVisionToolReadme();

    expect(readme).toContain('--prompt-file');
    expect(readme).toContain('workspace');
  });

  it('reads --prompt-file from the current workspace and preserves the default prompt', async () => {
    writeFileSync(join(mocks.workspace, 'screen.png'), pngBytes);
    writeFileSync(join(mocks.workspace, 'inspect.txt'), 'Extract visible error text.');

    const result = await analyzeImages({
      workspacePath: mocks.workspace,
      sessionMeta: { id: 'session-1', agentDir: mocks.workspace, title: 'Test', createdAt: '', lastActiveAt: '', enabledOfficialToolIds: ['image-understanding'] },
      images: ['@screen.png'],
      promptFile: 'inspect.txt',
    });

    expect(result.text).toBe('vision result');
    expect(result.prompt).toContain('Analyze the provided image(s)');
    expect(result.prompt).toContain('Extract visible error text.');
    expect(mocks.capturedPromptText).toBe(result.prompt);
  });

  it('rejects prompt files outside the workspace', async () => {
    writeFileSync(join(mocks.workspace, 'screen.png'), pngBytes);
    const outside = join(tmpdir(), `myagents-vision-outside-${Date.now()}.txt`);
    writeFileSync(outside, 'steal me');

    try {
      await analyzeImages({
        workspacePath: mocks.workspace,
        sessionMeta: { id: 'session-1', agentDir: mocks.workspace, title: 'Test', createdAt: '', lastActiveAt: '', enabledOfficialToolIds: ['image-understanding'] },
        images: ['screen.png'],
        promptFile: outside,
      });
      throw new Error('expected rejection');
    } catch (error) {
      const response = visionErrorResponse(error);
      expect(response.error).toContain('Prompt file must stay inside the current workspace');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects image files whose bytes do not match their extension', async () => {
    writeFileSync(join(mocks.workspace, 'fake.png'), 'not a png');

    await expect(analyzeImages({
      workspacePath: mocks.workspace,
      sessionMeta: { id: 'session-1', agentDir: mocks.workspace, title: 'Test', createdAt: '', lastActiveAt: '', enabledOfficialToolIds: ['image-understanding'] },
      images: ['fake.png'],
    })).rejects.toThrow('does not match its declared image type');
  });

  it('rejects symlink image paths before canonicalizing them', async () => {
    writeFileSync(join(mocks.workspace, 'screen.png'), pngBytes);
    symlinkSync(join(mocks.workspace, 'screen.png'), join(mocks.workspace, 'linked.png'));

    await expect(analyzeImages({
      workspacePath: mocks.workspace,
      sessionMeta: { id: 'session-1', agentDir: mocks.workspace, title: 'Test', createdAt: '', lastActiveAt: '', enabledOfficialToolIds: ['image-understanding'] },
      images: ['linked.png'],
    })).rejects.toThrow('must not be a symlink');
  });

  it('does not treat Windows drive-letter paths as URL inputs', () => {
    expect(isVisionUrlLikeInput('https://example.test/screen.png')).toBe(true);
    expect(isVisionUrlLikeInput('file:///tmp/screen.png')).toBe(true);
    expect(isVisionUrlLikeInput('C:\\Users\\me\\screen.png')).toBe(false);
    expect(isVisionUrlLikeInput('D:/workspace/screen.png')).toBe(false);
  });

  it('aborts and closes the one-shot SDK query when analysis times out', async () => {
    vi.useFakeTimers();
    try {
      writeFileSync(join(mocks.workspace, 'screen.png'), pngBytes);
      mocks.queryMode = 'hang';

      const promise = analyzeImages({
        workspacePath: mocks.workspace,
        sessionMeta: { id: 'session-1', agentDir: mocks.workspace, title: 'Test', createdAt: '', lastActiveAt: '', enabledOfficialToolIds: ['image-understanding'] },
        images: ['screen.png'],
      });
      const rejection = expect(promise).rejects.toThrow('Image understanding timed out');

      await vi.advanceTimersByTimeAsync(120_001);

      await rejection;
      expect(mocks.lastAbortController?.signal.aborted).toBe(true);
      expect(mocks.lastQueryClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
