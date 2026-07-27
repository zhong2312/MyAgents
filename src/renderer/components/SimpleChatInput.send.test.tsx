import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import type { Provider } from '@/config/types';
import { i18n } from '@/i18n';
import SimpleChatInput, { type SimpleChatInputHandle } from './SimpleChatInput';
import { ToastProvider } from './Toast';

const workspaceMocks = vi.hoisted(() => ({
  service: {
    isAvailable: true,
    importBase64Files: vi.fn(),
    copyPaths: vi.fn(),
    addGitignore: vi.fn(),
    prepareUserImageAttachments: vi.fn(),
    searchFiles: vi.fn(),
    listSlashCommands: vi.fn(),
  },
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { chatSendShortcut: 'enter' } }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => workspaceMocks.service,
}));

function renderInput(props: Partial<React.ComponentProps<typeof SimpleChatInput>> = {}) {
  const onSend = vi.fn();
  render(
    <ToastProvider>
      <ImagePreviewProvider>
        <SimpleChatInput
          runtime="codex"
          isLoading={false}
          onSend={onSend}
          {...props}
        />
      </ImagePreviewProvider>
    </ToastProvider>,
  );
  return onSend;
}

describe('SimpleChatInput send paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMocks.service.importBase64Files.mockResolvedValue({
      success: true,
      files: ['myagents_files/pasted.txt'],
    });
    workspaceMocks.service.copyPaths.mockResolvedValue({
      success: true,
      copiedFiles: [{ targetPath: 'myagents_files/report.pdf' }],
    });
    workspaceMocks.service.addGitignore.mockResolvedValue({ success: true });
    workspaceMocks.service.searchFiles.mockResolvedValue([]);
    workspaceMocks.service.listSlashCommands.mockResolvedValue([]);
  });

  it('sends text from the Chat input surface', async () => {
    const user = userEvent.setup();
    const onSend = renderInput();

    const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
    await user.type(textarea, 'chat hello');
    await user.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('chat hello', undefined);
  });

  it('shows external runtime MCP servers as a read-only discovered catalog', async () => {
    await i18n.changeLanguage('en-US');
    const user = userEvent.setup();
    renderInput({
      runtimeMcpTools: [
        'mcp__playwright__browser_click',
        'mcp__playwright__browser_navigate',
        'mcp__tavily-search__search',
      ],
      mcpServers: [
        { id: 'playwright', name: 'Playwright', description: 'Browser automation' },
      ],
    });

    const toolsButton = screen.getByTitle('Use tools');
    await user.click(toolsButton);

    expect(screen.getByText('Playwright')).toBeInTheDocument();
    expect(screen.getByText('Browser automation')).toBeInTheDocument();
    expect(screen.getByText('tavily-search')).toBeInTheDocument();
    expect(toolsButton).toHaveTextContent('2');
    expect(screen.queryByText('browser_click')).not.toBeInTheDocument();
  });

  it('shows Goal and scheduled Task state independently', async () => {
    await i18n.changeLanguage('en-US');
    renderInput({
      cronTask: {
        status: 'running',
        intervalMinutes: 30,
        schedule: { kind: 'every', minutes: 30 },
        executionCount: 2,
        runMode: 'single_session',
      },
      sessionGoal: {
        id: 'goal-1',
        workspacePath: '/tmp/workspace',
        sessionId: 'session-1',
        objective: 'Ship the architecture closure',
        status: 'active',
        endConditions: { aiCanExit: true },
        notifyEnabled: true,
        permissionMode: '',
        turnCount: 1,
        createdAt: '2026-07-10T10:00:00.000Z',
        updatedAt: '2026-07-10T10:00:00.000Z',
        totalDurationMs: 0,
        totalTokens: 0,
        revision: 1,
        controlRevision: 1,
        isExecuting: false,
      },
      onCronStop: vi.fn(),
      onGoalCancel: vi.fn(),
    });

    expect(screen.getByText('Round 1 · Ship the architecture closure')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel goal' })).toBeInTheDocument();
    expect(screen.getByText('Scheduled task running')).toBeInTheDocument();
  });

  it('keeps a Goal draft independent from an active scheduled task', async () => {
    await i18n.changeLanguage('en-US');
    renderInput({
      cronTask: {
        status: 'running',
        intervalMinutes: 30,
        schedule: { kind: 'every', minutes: 30 },
        executionCount: 2,
        runMode: 'single_session',
      },
      goalDraftActive: true,
      onCronStop: vi.fn(),
      onGoalDraftCancel: vi.fn(),
    });

    expect(screen.getByText('Goal Mode')).toBeInTheDocument();
    expect(screen.getByText('Enter your goal in the input box, then send it to keep working until completion')).toBeInTheDocument();
    expect(screen.queryByText(/Run every 0 minutes/)).not.toBeInTheDocument();
    expect(screen.getByText('Scheduled task running')).toBeInTheDocument();
  });

  it('projects a Launcher-staged Goal through Goal chrome instead of Cron schedule text', async () => {
    await i18n.changeLanguage('en-US');
    renderInput({
      mode: 'launcher',
      cronModeEnabled: true,
      cronConfig: {
        taskKind: 'goal',
        intervalMinutes: 0,
        schedule: { kind: 'loop' },
      },
      onCronSettings: vi.fn(),
      onCronCancel: vi.fn(),
    });

    expect(screen.getByText('Goal Mode')).toBeInTheDocument();
    expect(screen.getByText('Enter your goal in the input box, then send it to keep working until completion')).toBeInTheDocument();
    expect(screen.queryByText('Legacy loop')).not.toBeInTheDocument();
  });

  it('gives a Goal draft sole ownership of the composer draft bar', async () => {
    await i18n.changeLanguage('en-US');
    renderInput({
      goalDraftActive: true,
      cronModeEnabled: true,
      cronConfig: {
        taskKind: 'cron',
        intervalMinutes: 30,
        schedule: { kind: 'every', minutes: 30 },
      },
    });

    expect(screen.getByText('Goal Mode')).toBeInTheDocument();
    expect(screen.queryByText('Run every 30 minutes')).not.toBeInTheDocument();
  });

  it('honors parent provider availability for subscription sessions with local account evidence', async () => {
    const user = userEvent.setup();
    const subscriptionProvider = {
      id: 'anthropic-sub',
      name: 'Anthropic',
      vendor: 'Anthropic',
      cloudProvider: '模型官方',
      type: 'subscription',
      primaryModel: 'claude-sonnet-4-6',
      isBuiltin: true,
      config: {},
      models: [{ model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6' }],
    } as Provider;
    const onSend = renderInput({
      runtime: 'builtin',
      provider: subscriptionProvider,
      providers: [subscriptionProvider],
      providerAvailable: true,
      availableProviderIds: ['anthropic-sub'],
      selectedModel: 'claude-sonnet-4-6',
      providerVerifyStatus: {
        'anthropic-sub': {
          status: 'invalid',
          accountEmail: 'user@example.com',
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
    await user.type(textarea, 'subscription hello');
    await user.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('subscription hello', undefined);
  });

  it('uses subscription provider names verbatim in the model menu', async () => {
    const user = userEvent.setup();
    const subscriptionProvider = {
      id: 'anthropic-sub',
      name: 'Anthropic (订阅)',
      vendor: 'Anthropic',
      cloudProvider: '模型官方',
      type: 'subscription',
      primaryModel: 'claude-sonnet-4-6',
      isBuiltin: true,
      config: {},
      models: [{ model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6' }],
    } as Provider;

    renderInput({
      runtime: 'builtin',
      provider: subscriptionProvider,
      providers: [subscriptionProvider],
      providerAvailable: true,
      availableProviderIds: ['anthropic-sub'],
      selectedModel: 'claude-sonnet-4-6',
    });

    await user.click(screen.getByTitle('切换模型'));

    expect(await screen.findByText('Anthropic (订阅)')).toBeInTheDocument();
    expect(screen.queryByText('Anthropic (订阅) (订阅)')).not.toBeInTheDocument();
  });

  it('emits provider-scoped builtin model selections from the model menu', async () => {
    const user = userEvent.setup();
    const onBuiltinModelSelect = vi.fn();
    const onModelChange = vi.fn();
    const providers = [
      {
        id: 'provider-a',
        name: 'Provider A',
        vendor: 'A',
        cloudProvider: '模型官方',
        type: 'api',
        primaryModel: 'deepseek-v4-pro',
        isBuiltin: false,
        config: { baseUrl: 'https://a.example.com' },
        models: [{ model: 'deepseek-v4-pro', modelName: 'A Pro' }],
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        vendor: 'B',
        cloudProvider: '模型官方',
        type: 'api',
        primaryModel: 'deepseek-v4-pro',
        isBuiltin: false,
        config: { baseUrl: 'https://b.example.com' },
        models: [{ model: 'deepseek-v4-pro', modelName: 'B Pro' }],
      },
    ] as Provider[];

    renderInput({
      runtime: 'builtin',
      provider: providers[0],
      providers,
      selectedModel: 'deepseek-v4-pro',
      apiKeys: { 'provider-a': 'key-a', 'provider-b': 'key-b' },
      onBuiltinModelSelect,
      onModelChange,
    });

    await user.click(screen.getByTitle('切换模型'));
    await user.click(await screen.findByText('B Pro'));

    expect(onBuiltinModelSelect).toHaveBeenCalledWith({
      providerId: 'provider-b',
      model: 'deepseek-v4-pro',
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('sends text from the Launcher input surface', async () => {
    const user = userEvent.setup();
    const onSend = renderInput({ mode: 'launcher' });

    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    await user.type(textarea, 'launcher hello');
    await user.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('launcher hello', undefined);
  });

  it('renders launcher input chrome in English when the UI language is English', async () => {
    await i18n.changeLanguage('en-US');
    const user = userEvent.setup();
    renderInput({ mode: 'launcher', providerAvailable: true });

    expect(screen.getByPlaceholderText('What do you want to do today?')).toBeInTheDocument();
    expect(screen.getByTitle('Add context')).toBeInTheDocument();
    expect(screen.getByTitle('Switch execution mode')).toBeInTheDocument();
    expect(screen.getByTitle('Switch model')).toBeInTheDocument();
    expect(screen.getByTitle('Send (Enter)')).toBeInTheDocument();

    await user.click(screen.getByTitle('Add context'));
    expect(screen.getByText('Reference file')).toBeInTheDocument();
    expect(screen.getByText('Use skill')).toBeInTheDocument();
    expect(screen.getByText('Upload file')).toBeInTheDocument();

    await user.click(screen.getByTitle('Switch execution mode'));
    expect(screen.getByText('Session mode')).toBeInTheDocument();
    expect(screen.getAllByText('Act').length).toBeGreaterThan(0);
    expect(screen.getByText('Agent works in the workspace and asks before using tools')).toBeInTheDocument();
  });

  it('accepts pasted image attachments without routing through workspace file IO for external runtimes', async () => {
    renderInput({ mode: 'launcher' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const image = new File(['png'], 'clip.png', { type: 'image/png' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => image,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByAltText('attachment')).toBeInTheDocument());
    expect(workspaceMocks.service.importBase64Files).not.toHaveBeenCalled();
    expect(workspaceMocks.service.copyPaths).not.toHaveBeenCalled();
    expect(workspaceMocks.service.prepareUserImageAttachments).not.toHaveBeenCalled();
  });

  it('pastes non-image attachments as workspace file references', async () => {
    renderInput({ mode: 'launcher', workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const file = new File(['hello'], 'pasted.txt', { type: 'text/plain' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(textarea).toHaveValue('@myagents_files/pasted.txt '));
    expect(workspaceMocks.service.importBase64Files).toHaveBeenCalledWith({
      files: [{ name: 'pasted.txt', content: expect.any(String) }],
      targetDir: 'myagents_files',
    });
  });

  it('preserves text typed while a pasted file import is still pending', async () => {
    const user = userEvent.setup();
    let resolveImport!: (value: { success: boolean; files: string[] }) => void;
    workspaceMocks.service.importBase64Files.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );

    renderInput({ mode: 'launcher', workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const file = new File(['hello'], 'pasted.txt', { type: 'text/plain' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(workspaceMocks.service.importBase64Files).toHaveBeenCalled());
    await user.type(textarea, 'keep me');

    await act(async () => {
      resolveImport({ success: true, files: ['myagents_files/pasted.txt'] });
    });

    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toContain('keep me');
      expect((textarea as HTMLTextAreaElement).value).toContain('@myagents_files/pasted.txt');
    });
  });

  it('copies dropped filesystem paths as workspace file references through the imperative handle', async () => {
    const ref = createRef<SimpleChatInputHandle>();
    renderInput({ mode: 'launcher', ref, workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    await act(async () => {
      const handle = ref.current;
      if (!handle?.processDroppedFilePaths) throw new Error('SimpleChatInput ref was not mounted');
      await handle.processDroppedFilePaths(['/tmp/report.pdf']);
    });

    await waitFor(() => expect(textarea).toHaveValue('@myagents_files/report.pdf '));
    expect(workspaceMocks.service.copyPaths).toHaveBeenCalledWith({
      sourcePaths: ['/tmp/report.pdf'],
      targetDir: 'myagents_files',
      autoRename: true,
    });
  });

  it('preserves text typed while a dropped path copy is still pending', async () => {
    const user = userEvent.setup();
    const ref = createRef<SimpleChatInputHandle>();
    let resolveCopy!: (value: { success: boolean; copiedFiles: Array<{ targetPath: string }> }) => void;
    workspaceMocks.service.copyPaths.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );

    renderInput({ mode: 'launcher', ref, workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    const handle = ref.current;
    if (!handle?.processDroppedFilePaths) throw new Error('SimpleChatInput ref was not mounted');
    const copyPromise = handle.processDroppedFilePaths(['/tmp/report.pdf']);
    await waitFor(() => expect(workspaceMocks.service.copyPaths).toHaveBeenCalled());
    await user.type(textarea, 'keep me');

    await act(async () => {
      resolveCopy({ success: true, copiedFiles: [{ targetPath: 'myagents_files/report.pdf' }] });
      await copyPromise;
    });

    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toContain('keep me');
      expect((textarea as HTMLTextAreaElement).value).toContain('@myagents_files/report.pdf');
    });
  });

  it('does not write a completed file import into a different workspace draft', async () => {
    const user = userEvent.setup();
    const ref = createRef<SimpleChatInputHandle>();
    let resolveCopy!: (value: { success: boolean; copiedFiles: Array<{ targetPath: string }> }) => void;
    workspaceMocks.service.copyPaths.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );
    const renderComposer = (workspacePath: string) => (
      <ToastProvider>
        <ImagePreviewProvider>
          <SimpleChatInput
            ref={ref}
            runtime="codex"
            mode="launcher"
            isLoading={false}
            onSend={vi.fn()}
            workspacePath={workspacePath}
          />
        </ImagePreviewProvider>
      </ToastProvider>
    );
    const view = render(renderComposer('/workspace-a'));
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    const handle = ref.current;
    if (!handle?.processDroppedFilePaths) throw new Error('SimpleChatInput ref was not mounted');
    const copyPromise = handle.processDroppedFilePaths(['/tmp/report.pdf']);
    await waitFor(() => expect(workspaceMocks.service.copyPaths).toHaveBeenCalled());

    view.rerender(renderComposer('/workspace-b'));
    await user.type(textarea, 'workspace B draft');
    await act(async () => {
      resolveCopy({ success: true, copiedFiles: [{ targetPath: 'myagents_files/report.pdf' }] });
      await copyPromise;
    });

    expect(textarea).toHaveValue('workspace B draft');
  });
});
