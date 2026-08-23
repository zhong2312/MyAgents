import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import type { Provider } from '@/config/types';
import { i18n } from '@/i18n';
import { CUSTOM_EVENTS } from '../../shared/constants';
import {
  CC_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  GEMINI_PERMISSION_MODES,
} from '../../shared/types/runtime';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it('keeps keyboard and button send disabled while Session restore owns admission', async () => {
    const onSend = renderInput({ sendBlocked: true, providerAvailable: true });
    const textbox = screen.getByRole('textbox');

    fireEvent.change(textbox, { target: { value: 'do not send yet' } });
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    const sendButton = screen.getAllByRole('button').at(-1);
    expect(sendButton).toBeDefined();
    expect(sendButton).toBeDisabled();
    fireEvent.click(sendButton!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uses stable line icons for the three builtin permission modes', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    renderInput({
      runtime: 'builtin',
      permissionMode: 'fullAgency',
      onPermissionModeChange: vi.fn(),
    });

    const modeButton = screen.getByTitle('切换执行模式');
    expect(modeButton.querySelector('.lucide-lock-open')).toBeInTheDocument();

    await user.click(modeButton);

    expect(document.querySelector('.lucide-shield-check')).toBeInTheDocument();
    expect(document.querySelector('.lucide-eye')).toBeInTheDocument();
    expect(document.querySelectorAll('.lucide-lock-open')).toHaveLength(2);
    expect(screen.queryByText(/⚡|📋|🚀/u)).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'Claude Code',
      runtime: 'claude-code' as const,
      modes: CC_PERMISSION_MODES,
      expectedIcons: ['shield-question-mark', 'shield-check', 'eye', 'file-pen-line', 'lock-open', 'ban'],
    },
    {
      name: 'Gemini',
      runtime: 'gemini' as const,
      modes: GEMINI_PERMISSION_MODES,
      expectedIcons: ['shield-question-mark', 'file-pen-line', 'lock-open', 'eye'],
    },
    {
      name: 'Codex',
      runtime: 'codex' as const,
      modes: CODEX_PERMISSION_MODES,
      expectedIcons: ['shield-question-mark', 'file-pen-line', 'shield-check', 'lock-open'],
    },
  ])('maps $name permission boundaries to the shared line icon vocabulary', async ({ runtime, modes, expectedIcons }) => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    renderInput({ runtime, runtimePermissionModes: modes });

    await user.click(screen.getByTitle('切换执行模式'));

    for (const iconName of expectedIcons) {
      expect(document.querySelector(`.lucide-${iconName}`)).toBeInTheDocument();
    }
  });

  it.each(['chat', 'launcher'] as const)('keeps the scheduled-task action inside the animated plus menu in %s mode', async (mode) => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    const onCronButtonClick = vi.fn();
    renderInput({ mode, onCronButtonClick });

    expect(screen.queryByRole('button', { name: '定时任务' })).not.toBeInTheDocument();

    await user.click(screen.getByTitle('添加上下文'));

    const cronButton = screen.getByRole('button', { name: '定时任务' });
    expect(cronButton.querySelector('.lucide-timer')).toBeInTheDocument();
    expect(cronButton.closest('.composer-toolbar-menu-enter')).toBeInTheDocument();

    await user.click(cronButton);

    expect(onCronButtonClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '定时任务' })).not.toBeInTheDocument();
  });

  it('uses the same upward entry motion for all three left-side toolbar menus', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    renderInput({
      runtime: 'builtin',
      permissionMode: 'auto',
      onPermissionModeChange: vi.fn(),
    });

    for (const title of ['添加上下文', '切换执行模式', '使用工具']) {
      await user.click(screen.getByTitle(title));
      expect(document.querySelectorAll('.composer-toolbar-menu-enter')).toHaveLength(1);
    }
  });

  it('matches the mention and slash picker elevations to the composer', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    renderInput();

    const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
    await user.type(textarea, '@');

    const emptySearchHint = await screen.findByText('输入文件名搜索...');
    const mentionPicker = emptySearchHint.closest('[style*="box-shadow"]');
    expect(mentionPicker).toHaveStyle({ boxShadow: 'var(--shadow-md)' });

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      await user.clear(textarea);
      await user.type(textarea, '/');

      const slashCommand = await screen.findByText('/compact');
      const slashPicker = slashCommand.closest('[style*="box-shadow"]');
      expect(slashPicker).toHaveStyle({ boxShadow: 'var(--shadow-md)' });
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('keeps product and workspace actions while hiding SDK system commands', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    try {
      renderInput({
        showBuiltinSdkSlashCommands: false,
        onSlashAction: vi.fn(),
        workspaceSlashCommands: [
          {
            name: 'ship-it',
            description: 'Workspace command',
            source: 'custom',
          },
          {
            name: 'apple-notes',
            description: 'Project Skill',
            source: 'skill',
            scope: 'project',
          },
        ],
      });

      const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
      await user.type(textarea, '/');

      expect(await screen.findByText('/goal')).toBeInTheDocument();
      expect(screen.getByText('/ship-it')).toBeInTheDocument();
      expect(screen.getByText('/apple-notes')).toBeInTheDocument();
      expect(screen.getByText('skill')).toBeInTheDocument();
      expect(screen.queryByText('plugin')).not.toBeInTheDocument();
      expect(screen.queryByText('/compact')).not.toBeInTheDocument();
      expect(screen.queryByText('/context')).not.toBeInTheDocument();
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('filters runtime-blind Launcher scan results for non-builtin execution', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    workspaceMocks.service.listSlashCommands.mockResolvedValue({
      success: true,
      commands: [
        { name: 'compact', description: 'SDK compact', source: 'builtin' },
        { name: 'context', description: 'SDK context', source: 'builtin' },
        { name: 'ship-it', description: 'Workspace command', source: 'custom' },
        { name: 'apple-notes', description: 'Project Skill', source: 'skill', scope: 'project' },
      ],
      globalSkillFolderNames: [],
    });
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    try {
      renderInput({
        mode: 'launcher',
        workspacePath: '/tmp/workspace',
        showBuiltinSdkSlashCommands: false,
        onSlashAction: vi.fn(),
        sdkSlashCommands: [{
          name: 'plugin:review',
          description: 'Builtin SDK plugin command',
          source: 'sdk',
        }],
      });

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, '/');

      expect(await screen.findByText('/goal')).toBeInTheDocument();
      expect(screen.getByText('/ship-it')).toBeInTheDocument();
      expect(screen.getByText('/apple-notes')).toBeInTheDocument();
      expect(screen.queryByText('/compact')).not.toBeInTheDocument();
      expect(screen.queryByText('/context')).not.toBeInTheDocument();
      expect(screen.queryByText('/plugin:review')).not.toBeInTheDocument();
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('shows a Command display name but inserts its stable invocation name', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    try {
      renderInput({
        workspaceSlashCommands: [{
          name: '中文 总结',
          invocationName: '中文-总结',
          description: '总结当前工作',
          source: 'custom',
        }],
        showBuiltinSdkSlashCommands: false,
      });

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, '/');
      await user.click(await screen.findByText('/中文 总结'));

      expect(textarea).toHaveValue('/中文-总结 ');
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('does not let an older Launcher scan overwrite a newer invalidation result', async () => {
    vi.useFakeTimers();
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    workspaceMocks.service.listSlashCommands
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    try {
      renderInput({
        mode: 'launcher',
        workspacePath: '/tmp/workspace',
        showBuiltinSdkSlashCommands: false,
      });
      act(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
        vi.advanceTimersByTime(100);
      });

      newer.resolve({
        success: true,
        commands: [{
          name: '新 展示名',
          invocationName: '新-指令',
          description: '',
          source: 'custom',
        }],
        globalSkillFolderNames: [],
      });
      await act(async () => { await newer.promise; });

      older.resolve({
        success: true,
        commands: [{ name: '旧展示名', invocationName: '旧-指令', description: '', source: 'custom' }],
        globalSkillFolderNames: [],
      });
      await act(async () => { await older.promise; });

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });
      expect(screen.getByText('/新 展示名')).toBeInTheDocument();
      expect(screen.queryByText('/旧展示名')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('dispatches the Managed Codex compact command as a client action', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    const onSlashAction = vi.fn();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    try {
      const onSend = renderInput({
        showBuiltinSdkSlashCommands: false,
        onSlashAction,
        clientActionSlashCommands: [{
          name: 'compact',
          description: 'Compact',
          source: 'client',
        }],
      });
      const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
      await user.type(textarea, '/');
      await user.click(await screen.findByText('/compact'));

      expect(onSlashAction).toHaveBeenCalledWith('compact');
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea).toHaveValue('');
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
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

  it('keeps workspace MCP configuration editable with Managed Codex builtin input chrome', async () => {
    await i18n.changeLanguage('en-US');
    const user = userEvent.setup();
    renderInput({
      runtime: 'builtin',
      runtimeMcpTools: ['mcp__playwright__browser_click'],
      mcpServers: [
        { id: 'playwright', name: 'Playwright', description: 'Browser automation' },
        { id: 'configured-only', name: 'Configured only' },
      ],
      globalMcpEnabled: ['playwright', 'configured-only'],
      workspaceMcpEnabled: ['playwright', 'configured-only'],
    });

    const toolsButton = screen.getByTitle('Use tools');
    await user.click(toolsButton);

    expect(toolsButton).toHaveTextContent('2');
    const playwrightRow = screen.getByText('Playwright').parentElement?.parentElement;
    expect(playwrightRow).not.toBeNull();
    expect(playwrightRow?.querySelector('button')).not.toBeNull();
    expect(screen.getByText('Configured only')).toBeInTheDocument();
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

  it('centers the selected model inside the menu scroll container when opened', async () => {
    const user = userEvent.setup();
    const provider = {
      id: 'provider-a',
      name: 'Provider A',
      vendor: 'A',
      cloudProvider: '模型官方',
      type: 'api',
      primaryModel: 'model-0',
      isBuiltin: false,
      config: { baseUrl: 'https://a.example.com' },
      models: Array.from({ length: 12 }, (_, index) => ({
        model: `model-${index}`,
        modelName: `Model ${index}`,
      })),
    } as Provider;
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-model-list') ? 100 : 0;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-model-list') ? 500 : 0;
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-selected-model-row') ? 20 : 0;
    });
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-selected-model-row') ? 300 : 0;
    });

    try {
      renderInput({
        runtime: 'builtin',
        provider,
        providers: [provider],
        selectedModel: 'model-9',
        apiKeys: { 'provider-a': 'key-a' },
      });

      await user.click(screen.getByTitle('切换模型'));

      await screen.findByText('Provider A');
      const list = document.querySelector('[data-model-list]');
      expect(list).not.toBeNull();
      expect(list).toHaveProperty('scrollTop', 260);
    } finally {
      clientHeight.mockRestore();
      scrollHeight.mockRestore();
      offsetHeight.mockRestore();
      offsetTop.mockRestore();
    }
  });

  it('opens Model Providers from the builtin AgentSDK model menu', async () => {
    const user = userEvent.setup();
    const provider = {
      id: 'codex-sub',
      name: 'Codex (订阅)',
      vendor: 'OpenAI',
      cloudProvider: '模型官方',
      type: 'subscription',
      primaryModel: 'gpt-5.6-sol',
      isBuiltin: true,
      config: {},
      models: [{ model: 'gpt-5.6-sol', modelName: 'GPT-5.6-Sol' }],
    } as Provider;
    const openSettings = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);

    try {
      renderInput({
        runtime: 'builtin',
        provider,
        providers: [provider],
        providerAvailable: true,
        availableProviderIds: ['codex-sub'],
        selectedModel: 'gpt-5.6-sol',
      });

      await user.click(screen.getByTitle('切换模型'));
      await user.click(screen.getByRole('button', { name: '管理自定义模型服务' }));

      expect(openSettings).toHaveBeenCalledTimes(1);
      expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'providers' });
      expect(screen.queryByRole('button', { name: '管理自定义模型服务' })).not.toBeInTheDocument();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    }
  });

  it('does not show the custom model service row for user-managed CLI runtimes', async () => {
    const user = userEvent.setup();
    renderInput({
      runtime: 'codex',
      runtimeModels: [{ value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }],
    });

    await user.click(screen.getByTitle('切换模型'));

    expect(screen.queryByRole('button', { name: '管理自定义模型服务' })).not.toBeInTheDocument();
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

  it('opens the image preview with a single click on a pasted attachment', async () => {
    const user = userEvent.setup();
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

    const thumbnail = await screen.findByRole('button', { name: 'clip.png' });
    await user.click(thumbnail);

    expect(screen.getByAltText('clip.png')).toBeInTheDocument();
  });

  it('accepts up to eight pasted image attachments', async () => {
    renderInput({ mode: 'launcher' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const images = Array.from(
      { length: 9 },
      (_, index) => new File(['png'], `clip-${index + 1}.png`, { type: 'image/png' }),
    );

    fireEvent.paste(textarea, {
      clipboardData: {
        items: images.map((image) => ({
          kind: 'file',
          getAsFile: () => image,
        })),
      },
    });

    await waitFor(() => expect(screen.getAllByAltText('attachment')).toHaveLength(8));
    expect(screen.queryByRole('button', { name: 'clip-9.png' })).not.toBeInTheDocument();
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
