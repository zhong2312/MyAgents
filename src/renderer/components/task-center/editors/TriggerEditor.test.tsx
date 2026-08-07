import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskTrigger } from '@/../shared/types/task';
import { TriggerEditor } from './TriggerEditor';

const apiMocks = vi.hoisted(() => ({
  taskTriggerTestSpec: vi.fn(),
}));

vi.mock('@/api/taskCenter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/taskCenter')>()),
  taskTriggerTestSpec: apiMocks.taskTriggerTestSpec,
}));

function Harness({
  onValue,
  ownerTaskId,
}: {
  onValue?: (value: TaskTrigger) => void;
  ownerTaskId?: string;
}) {
  const [value, setValue] = useState<TaskTrigger>({
    source: { type: 'time' },
    detector: { type: 'always' },
  });
  return (
    <TriggerEditor
      value={value}
      workspacePath="/Users/me/感知 项目"
      ownerTaskId={ownerTaskId}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

describe('TriggerEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.taskTriggerTestSpec.mockResolvedValue({
      ok: true,
      result: {
        invocationId: 'inv-1',
        decision: 'activate',
        reason: { code: 'build_failed', message: '构建失败' },
        handoff: { summary: 'Build 319 failed' },
        nextCheckpoint: { cursor: 319 },
        durationMs: 41,
        exitCode: 0,
      },
    });
  });

  it('keeps structured args intact instead of splitting on spaces', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);

    fireEvent.click(screen.getByRole('button', { name: '本地命令检测' }));
    fireEvent.change(screen.getByPlaceholderText('例如 node 或 /usr/local/bin/tool'), {
      target: { value: 'node' },
    });
    fireEvent.change(screen.getByDisplayValue('[]'), {
      target: { value: '["--fixture", "path with spaces/输入.json"]' },
    });

    await waitFor(() => {
      const latest = onValue.mock.calls.at(-1)?.[0] as TaskTrigger;
      expect(latest.detector).toMatchObject({
        type: 'command',
        command: { args: ['--fixture', 'path with spaces/输入.json'] },
      });
    });
    expect(screen.queryByText('文件系统')).not.toBeInTheDocument();
    expect(screen.queryByText('邮件')).not.toBeInTheDocument();
  });

  it('validates timeout and renders the no-commit side-effect warning', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '本地命令检测' }));
    fireEvent.change(screen.getByPlaceholderText('例如 node 或 /usr/local/bin/tool'), {
      target: { value: 'node' },
    });
    fireEvent.change(screen.getByDisplayValue('30000'), { target: { value: '999' } });

    expect(screen.getByRole('alert')).toHaveTextContent('1000–300000');
    expect(screen.getByText(/脚本自身的文件、网络或数据库副作用不会回滚/)).toBeInTheDocument();
  });

  it('tests the current spec and shows structured decision evidence', async () => {
    render(<Harness ownerTaskId="task-existing" />);
    fireEvent.click(screen.getByRole('button', { name: '本地命令检测' }));
    fireEvent.change(screen.getByPlaceholderText('例如 node 或 /usr/local/bin/tool'), {
      target: { value: 'node' },
    });
    fireEvent.click(screen.getByRole('button', { name: '测试 Detector' }));

    await screen.findByText(/激活 AI · 构建失败/);
    expect(screen.getByText('Build 319 failed')).toBeInTheDocument();
    expect(apiMocks.taskTriggerTestSpec).toHaveBeenCalledWith(
      expect.objectContaining({ detector: expect.objectContaining({ type: 'command' }) }),
      '/Users/me/感知 项目',
      undefined,
      'task-existing',
    );
  });

  it('discards an in-flight test result after the draft changes', async () => {
    let resolveTest: ((value: Awaited<ReturnType<typeof apiMocks.taskTriggerTestSpec>>) => void) | undefined;
    apiMocks.taskTriggerTestSpec.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTest = resolve;
    }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '本地命令检测' }));
    const executable = screen.getByPlaceholderText('例如 node 或 /usr/local/bin/tool');
    fireEvent.change(executable, { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: '测试 Detector' }));
    await waitFor(() => expect(apiMocks.taskTriggerTestSpec).toHaveBeenCalledOnce());

    fireEvent.change(executable, { target: { value: '/usr/bin/node' } });
    await act(async () => {
      resolveTest?.({
        ok: true,
        result: {
          invocationId: 'stale',
          decision: 'activate',
          reason: { code: 'stale', message: '旧配置结果' },
          handoff: { summary: 'must stay hidden' },
          nextCheckpoint: null,
          durationMs: 1,
          exitCode: 0,
        },
      });
    });

    expect(screen.queryByText('旧配置结果')).not.toBeInTheDocument();
    expect(screen.queryByText('must stay hidden')).not.toBeInTheDocument();
  });
});
