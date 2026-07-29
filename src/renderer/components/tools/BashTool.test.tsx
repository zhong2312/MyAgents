import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import BashTool from './BashTool';

function bashTool(overrides: Partial<ToolUseSimple> = {}): ToolUseSimple {
  return {
    id: 'bash-call',
    name: 'Bash',
    input: { command: 'printf "hello\\n"' },
    streamIndex: 0,
    result: 'hello',
    resultMeta: { status: 'completed', exitCode: 0 },
    ...overrides,
  };
}

describe('BashTool terminal transcript', () => {
  it('renders command, output, state, and metadata inside one terminal surface', () => {
    const { container } = render(<BashTool tool={bashTool({
      input: { command: 'pwd', cwd: '/project' },
      result: '/project',
      resultMeta: {
        status: 'completed',
        cwd: '/project',
        durationMs: 327,
        processId: '38910',
        exitCode: 0,
      },
    })} />);

    expect(container.querySelectorAll('[data-bash-terminal]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-bash-transcript]')).toHaveLength(1);
    expect(screen.getByText('命令')).toBeInTheDocument();
    expect(screen.getByText('原始输出')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getAllByText('/project')).toHaveLength(2);
    expect(screen.getByText('耗时 327ms')).toBeInTheDocument();
    expect(screen.getByText('PID 38910')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
    expect(container.querySelector('[data-bash-command-source]')).not.toHaveClass('break-all');
    expect(container.querySelector('[data-bash-transcript]')).toHaveClass('overflow-x-auto');
  });

  it('uses Codex commandActions in order without repeating the raw -lc wrapper', () => {
    const { container } = render(<BashTool tool={bashTool({
      input: {
        command: '/bin/zsh -lc "rg -n foo src && sed -n 1,20p file"',
        commandActions: [
          { type: 'search', command: 'rg -n foo src' },
          { type: 'read', command: 'sed -n 1,20p file' },
        ],
      },
    })} />);

    const command = container.querySelector('[data-bash-command-source="command-actions"]');
    expect(command).toBeInTheDocument();
    expect(command).toHaveTextContent('rg -n foo src');
    expect(command).toHaveTextContent('sed -n 1,20p file');
    expect(command).not.toHaveTextContent('/bin/zsh');
    expect(command).not.toHaveTextContent('-lc');
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument();
  });

  it('keeps SDK stdout and stderr as independently labelled accessible regions', () => {
    const { container } = render(<BashTool tool={bashTool({
      result: JSON.stringify({ stdout: 'normal output', stderr: 'warning output', interrupted: false }),
    })} />);

    const stdout = container.querySelector('[data-bash-stream="stdout"]');
    const stderr = container.querySelector('[data-bash-stream="stderr"]');
    expect(stdout).toHaveAttribute('aria-label', '标准输出');
    expect(stderr).toHaveAttribute('aria-label', '错误输出');
    expect(stdout).toHaveTextContent('normal output');
    expect(stderr).toHaveTextContent('warning output');
    expect(stderr).toHaveClass('border-l-2', 'border-l-[var(--error)]');
    expect(stderr).toHaveTextContent('错误输出');
    expect(container.textContent).not.toContain('[stderr]');
  });

  it('highlights only high-confidence JSON and diff while plain logs stay plain', () => {
    const json = render(<BashTool tool={bashTool({ result: '{"ok":true}' })} />);
    expect(json.container.querySelector('[data-bash-format="json"]')).toHaveTextContent('JSON');
    expect(json.container.querySelector('[data-syntax-highlighted="true"]')).toBeInTheDocument();
    json.unmount();

    const diffText = '@@ -1 +1 @@\n-old\n+new';
    const diff = render(<BashTool tool={bashTool({ result: diffText })} />);
    expect(diff.container.querySelector('[data-bash-format="diff"]')).toHaveTextContent('Diff');
    diff.unmount();

    const plain = render(<BashTool tool={bashTool({ result: 'server started\nlistening on 4182' })} />);
    expect(plain.container.querySelector('[data-bash-format="plain"]')).toBeInTheDocument();
    expect(plain.container.querySelector('[data-syntax-highlighted="false"]')).toBeInTheDocument();
    expect(plain.container).toHaveTextContent('server started');
  });

  it.each([
    [{ input: {}, result: undefined, resultMeta: undefined, isLoading: true }, 'initializing', '初始化中'],
    [{ result: undefined, resultMeta: undefined, isLoading: true }, 'running', '运行中'],
    [{ result: '', resultMeta: { exitCode: 0 } }, 'completed', '已完成'],
    [{ result: 'bad', resultMeta: { exitCode: 2 } }, 'failed', '失败'],
    [{ result: undefined, resultMeta: undefined, isStopped: true }, 'stopped', '已停止'],
    [{ result: undefined, resultMeta: { status: 'interrupted' } }, 'interrupted', '已中断'],
    [{ result: undefined, resultMeta: { status: 'timeout' } }, 'timeout', '已超时'],
    [{ input: { command: 'serve', run_in_background: true }, result: undefined }, 'background', '后台运行'],
  ] as const)('uses the same terminal skeleton for %s', (overrides, status, label) => {
    const { container } = render(<BashTool tool={bashTool(overrides as Partial<ToolUseSimple>)} />);
    expect(container.querySelectorAll('[data-bash-terminal]')).toHaveLength(1);
    expect(container.querySelector(`[data-bash-status="${status}"]`)).toHaveTextContent(label);
  });

  it('shows a compact empty-output row instead of an empty terminal body', () => {
    const { container } = render(<BashTool tool={bashTool({ result: '' })} />);

    expect(container.querySelector('[data-bash-empty-output]')).toHaveTextContent('无输出');
    expect(container.querySelector('[data-bash-stream]')).not.toBeInTheDocument();
  });

  it('renders a completed background handoff without a live waiting spinner', () => {
    const { container } = render(<BashTool tool={bashTool({
      input: { command: 'serve' },
      result: JSON.stringify({
        stdout: '',
        stderr: '',
        interrupted: false,
        backgroundTaskId: 'task-1',
      }),
      resultMeta: undefined,
    })} />);

    expect(container.querySelector('[data-bash-status="background"]')).toHaveTextContent('后台运行');
    expect(container.querySelector('[data-bash-empty-output]')).toHaveTextContent('无输出');
    expect(container.querySelector('[data-bash-empty-output] svg')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('等待输出');
  });

  it('explains SDK timeout-to-background and the unchanged session cwd', () => {
    const { container } = render(<BashTool tool={bashTool({
      input: { command: 'cd /tmp && serve' },
      result: JSON.stringify({
        stdout: '',
        stderr: '',
        interrupted: false,
        timedOutAfterMs: 120_000,
        backgroundCwdHint: 'Session cwd remains unchanged.',
      }),
      resultMeta: undefined,
    })} />);

    expect(container.querySelector('[data-bash-status="background"]')).toHaveTextContent('后台运行');
    expect(container.querySelector('[data-bash-meta]')).toHaveTextContent('等待 2m 0s 后转入后台');
    expect(container.querySelector('[data-bash-meta]')).toHaveTextContent('会话工作目录未改变');
  });

  it('offers one 展示全部 action and announces the hard output cap', () => {
    const output = Array.from({ length: 5_001 }, (_, index) => `line-${index}`).join('\n');
    const { container } = render(<BashTool tool={bashTool({ result: output })} />);

    expect(container.querySelector('[data-bash-transcript]')).toHaveClass('max-h-96', 'overflow-y-hidden');
    expect(container.querySelectorAll('[data-bash-show-all]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent('line-5000');

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container.querySelector('[data-bash-transcript]')).not.toHaveClass('max-h-96');
    expect(container.querySelector('[data-bash-show-all]')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('line-4998');
    expect(container).not.toHaveTextContent('line-5000');
    expect(screen.getByRole('status')).toHaveTextContent('终端内容过长，仅展示安全范围内的内容');
  });

  it('falls back to plain rendering when expanded diff output crosses the highlight budget', () => {
    const output = `@@ -1,1001 +1,1001 @@\n${Array.from({ length: 1_001 }, (_, index) => (
      index % 2 === 0 ? `-old-${index}` : `+new-${index}`
    )).join('\n')}`;
    const { container } = render(<BashTool tool={bashTool({ result: output })} />);

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container.querySelector('[data-bash-format="diff"] [data-syntax-highlighted="false"]')).toBeInTheDocument();
  });

  it('budgets commandActions as part of the same transcript and falls back from Prism', () => {
    const actions = Array.from({ length: 500 }, (_, index) => ({
      type: 'unknown',
      command: `printf action-${index}`,
    }));
    const { container } = render(<BashTool tool={bashTool({
      input: { command: '/bin/zsh -lc "batch"', commandActions: actions },
      result: '',
    })} />);

    const command = container.querySelector('[data-bash-command-source="command-actions"]');
    expect(command?.querySelector('[data-syntax-highlighted="false"]')).toBeInTheDocument();
    expect(command).toHaveTextContent('action-399');
    expect(command).not.toHaveTextContent('action-400');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();
  });

  it('preserves one multiline commandAction as one semantic prompt segment', () => {
    const commandActions = [
      { command: 'printf first\nprintf second' },
      ...Array.from({ length: 500 }, (_, index) => ({ command: `printf later-${index}` })),
    ];
    const { container } = render(<BashTool tool={bashTool({
      input: {
        command: '/bin/zsh -lc "script"',
        commandActions,
      },
      result: '',
    })} />);

    const command = container.querySelector('[data-bash-command-source="command-actions"]');
    const commandSegments = command?.querySelectorAll(':scope > div > div');
    expect(commandSegments?.[0]).toHaveTextContent('printf first');
    expect(commandSegments?.[0]).toHaveTextContent('printf second');
    expect(commandSegments?.[1]).toHaveTextContent('printf later-0');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();
  });

  it('announces commandActions hidden by the model hard cap', () => {
    const commandActions = [
      ...Array.from({ length: 5_000 }, () => ({ type: 'unknown' })),
      { command: 'printf hidden' },
    ];
    const { container } = render(<BashTool tool={bashTool({
      input: { commandActions },
      result: '',
    })} />);

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container).not.toHaveTextContent('printf hidden');
    expect(screen.getByRole('status')).toHaveTextContent('终端内容过长，仅展示安全范围内的内容');
  });

  it('does not render an empty prompt for oversized unknown whitespace', () => {
    const { container } = render(<BashTool tool={bashTool({
      input: { command: ' '.repeat(600_000) },
      result: undefined,
      resultMeta: undefined,
      isLoading: true,
    })} />);

    expect(container.querySelector('[data-bash-command-source]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-bash-status="running"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();
  });

  it('caps the complete transcript height when command chrome plus output exceeds the viewport', () => {
    const output = Array.from({ length: 16 }, (_, index) => `line-${index}`).join('\n');
    const { container } = render(<BashTool tool={bashTool({ result: output })} />);

    expect(container.querySelector('[data-bash-transcript]')).toHaveClass('max-h-96', 'overflow-y-hidden');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();
  });

  it('does not add command or output copy actions', () => {
    render(<BashTool tool={bashTool()} />);

    expect(screen.queryByRole('button', { name: /复制|copy/i })).not.toBeInTheDocument();
  });
});
