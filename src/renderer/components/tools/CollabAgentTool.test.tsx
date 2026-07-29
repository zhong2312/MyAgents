// PRD 0.2.27 — Codex collab-agent (sub-agent) nesting renders via the existing
// TaskTool container + label helpers. These guard the frontend wiring that lets
// a 'CollabAgent' card behave like a builtin 'Task' card (expandable nested trace).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, fireEvent } from '@testing-library/react';

import { i18n } from '@/i18n';
import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import TaskTool from './TaskTool';
import { getToolLabel, getToolMainLabel, isSubagentContainerTool } from './toolBadgeConfig';
import { isSubagentContainerRunning } from './subagentActivity';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh-CN');
});

function collabTool(overrides: Partial<ToolUseSimple>): ToolUseSimple {
  return {
    id: 'card-1',
    name: 'CollabAgent',
    input: { tool: 'spawnAgent', prompt: 'henan worker', model: 'gpt-5-codex' },
    parsedInput: { tool: 'spawnAgent', prompt: 'henan worker', model: 'gpt-5-codex' } as unknown as ToolUseSimple['parsedInput'],
    streamIndex: 0,
    ...overrides,
  };
}

function taskTool(overrides: Partial<ToolUseSimple>): ToolUseSimple {
  return {
    id: 'task-card-1',
    name: 'Task',
    input: {},
    parsedInput: {
      description: 'Audit background tasks',
      prompt: 'Audit the background task lifecycle',
      subagent_type: 'Explore',
    } as unknown as ToolUseSimple['parsedInput'],
    streamIndex: 0,
    isLoading: false,
    ...overrides,
  };
}

describe('isSubagentContainerTool', () => {
  it('treats builtin Task/Agent and Codex CollabAgent as sub-agent containers', () => {
    expect(isSubagentContainerTool('Task')).toBe(true);
    expect(isSubagentContainerTool('Agent')).toBe(true);
    expect(isSubagentContainerTool('CollabAgent')).toBe(true);
  });
  it('rejects ordinary tools', () => {
    expect(isSubagentContainerTool('Bash')).toBe(false);
    expect(isSubagentContainerTool('TaskCreate')).toBe(false); // the todo tool, not a container
  });
});

describe('CollabAgent labels', () => {
  it('main label is a stable "Sub-agent"', () => {
    expect(getToolMainLabel(collabTool({}))).toBe('子 Agent');
  });
  it('compact label reflects the collab action + model', () => {
    expect(getToolLabel(collabTool({}))).toBe('派生子 Agent · gpt-5-codex');
  });
  it('localizes the collab action while preserving the model id', async () => {
    await i18n.changeLanguage('en-US');

    expect(getToolLabel(collabTool({}))).toBe('Spawn sub-agent · gpt-5-codex');
  });
  it('compact label shows the latest sub-agent call while running', () => {
    const label = getToolLabel(collabTool({
      isLoading: true,
      subagentCalls: [{ id: 't1', name: 'Bash', input: { command: 'ls' }, isLoading: true }],
    }));
    // getSubagentCallLabel(Bash with command) → first part of the command
    expect(label).toBe('ls');
  });
  it('compact label shows nested collab control actions while running', () => {
    const label = getToolLabel(collabTool({
      isLoading: true,
      subagentCalls: [{ id: 'wait-1', name: 'CollabAgent', input: { tool: 'wait' }, isLoading: true }],
    }));
    expect(label).toBe('等待子 Agent');
  });
  it('compact label shows nested sub-agent message traces while running', () => {
    const label = getToolLabel(collabTool({
      isLoading: true,
      subagentCalls: [{ id: 'msg-1', name: 'AgentMessage', input: {}, result: 'hello', isLoading: true }],
    }));
    expect(label).toBe('Agent 消息');
  });
  it('compact label still follows the nested trace after spawnAgent itself completed', () => {
    const tool = collabTool({
      result: 'Tool: spawnAgent\nStatus: completed',
      isLoading: false,
      subagentCalls: [{ id: 'wait-1', name: 'CollabAgent', input: { tool: 'wait' }, isLoading: true }],
    });
    expect(isSubagentContainerRunning(tool)).toBe(true);
    expect(getToolLabel(tool)).toBe('等待子 Agent');
  });
  it('compact label prefers the latest running nested call', () => {
    const label = getToolLabel(collabTool({
      result: 'Tool: spawnAgent\nStatus: completed',
      isLoading: false,
      subagentCalls: [
        { id: 'wait-1', name: 'CollabAgent', input: { tool: 'wait' }, isLoading: true },
        { id: 'msg-1', name: 'AgentMessage', input: {}, result: 'newer output', isLoading: true },
      ],
    }));
    expect(label).toBe('Agent 消息');
  });
});

describe('TaskTool renders a CollabAgent card with a nested trace', () => {
  it('renders omitted run_in_background Task input as a background task', () => {
    render(<TaskTool tool={taskTool({ result: undefined })} />);

    expect(screen.getByText('后台运行中')).toBeInTheDocument();
  });

  it('shows the SDK-resolved model path in the existing completed stats row', () => {
    const { container } = render(<TaskTool tool={taskTool({
      result: JSON.stringify({
        status: 'completed',
        content: [{ type: 'text', text: 'done' }],
        resolvedModel: 'claude-sonnet-5',
        modelsUsed: ['claude-haiku-4-5', 'claude-sonnet-5'],
        totalDurationMs: 50,
        totalTokens: 12,
        totalToolUseCount: 1,
      }),
    })} />);

    expect(container.querySelector('[data-task-models]')).toHaveTextContent(
      '模型 claude-haiku-4-5 → claude-sonnet-5',
    );
  });

  it('keeps the SDK-resolved final model last when it appeared earlier in the path', () => {
    const { container } = render(<TaskTool tool={taskTool({
      result: JSON.stringify({
        status: 'completed',
        content: [{ type: 'text', text: 'done' }],
        resolvedModel: 'model-a',
        modelsUsed: ['model-a', 'model-b', 'model-a'],
      }),
    })} />);

    expect(container.querySelector('[data-task-models]')).toHaveTextContent(
      '模型 model-b → model-a',
    );
  });

  it('bounds malformed model paths and preserves only the authoritative final model', () => {
    const { container } = render(<TaskTool tool={taskTool({
      result: JSON.stringify({
        status: 'completed',
        content: [{ type: 'text', text: 'done' }],
        resolvedModel: 'final-model',
        modelsUsed: Array.from({ length: 20 }, (_, index) => `model-${index}`),
      }),
    })} />);

    expect(container.querySelector('[data-task-models]')).toHaveTextContent('模型 final-model');
    expect(container.querySelector('[data-task-models]')).not.toHaveTextContent('model-0');
  });

  it('shows the SDK-resolved model for an async-launched background task', () => {
    const { container } = render(<TaskTool tool={taskTool({
      result: JSON.stringify({
        status: 'async_launched',
        agentId: 'agent-1',
        prompt: 'audit',
        outputFile: '/tmp/agent-1.output',
        resolvedModel: 'claude-sonnet-5',
        modelsUsed: ['claude-sonnet-5'],
      }),
    })} />);

    expect(container.querySelector('[data-task-models]')).toHaveTextContent(
      '模型 claude-sonnet-5',
    );
  });

  it('exposes a reachable trace toggle that reveals the sub-agent tool calls', () => {
    const { container } = render(<TaskTool tool={collabTool({
      result: 'Tool: spawnAgent\nPrompt: henan worker', // non-JSON collab summary
      isLoading: false,
      subagentCalls: [
        { id: 't1', name: 'Bash', input: { command: 'python3 validate.py' }, result: 'ok', isLoading: false },
        { id: 't2', name: 'WebSearch', input: { query: 'henan gaokao' }, result: 'done', isLoading: false },
      ],
    })} />);

    // The spawn prompt is shown.
    expect(screen.getAllByText(/henan worker/).length).toBeGreaterThan(0);

    // Trace is collapsed initially; the toggle is reachable (NOT buried where a
    // non-JSON-result collab card would otherwise have no stats bar at all).
    const toggle = container.querySelector('[aria-controls="task-trace-content"]');
    expect(toggle).not.toBeNull();

    // Expanding reveals each sub-agent tool by name.
    fireEvent.click(toggle!);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('WebSearch')).toBeInTheDocument();
  });

  it('renders a leaf collab card (no trace) without crashing', () => {
    render(<TaskTool tool={collabTool({
      input: { tool: 'wait' },
      parsedInput: { tool: 'wait' } as unknown as ToolUseSimple['parsedInput'],
      result: 'Tool: wait',
      isLoading: false,
    })} />);
    expect(screen.getByText(/Tool: wait/)).toBeInTheDocument();
  });

  it('keeps a completed spawnAgent card in running state while nested calls stream', () => {
    const { container } = render(<TaskTool tool={collabTool({
      result: 'Tool: spawnAgent\nStatus: completed',
      isLoading: false,
      taskStartTime: Date.now() - 10_000,
      taskStats: { toolCount: 84, inputTokens: 0, outputTokens: 0 },
      subagentCalls: [
        { id: 'thinking-1', name: 'Thinking', input: {}, result: 'checking', isLoading: true },
      ],
    })} />);

    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.queryByText('完成')).not.toBeInTheDocument();
    expect(screen.getByText('调用工具 84 次')).toBeInTheDocument();

    const toggle = container.querySelector('[aria-controls="task-trace-content"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });

  it('routes nested Edit calls through the bounded file-patch viewer', () => {
    const { container } = render(<TaskTool tool={collabTool({
      result: 'Tool: spawnAgent\nStatus: completed',
      isLoading: false,
      subagentCalls: [{
        id: 'edit-1',
        name: 'Edit',
        input: {
          file_path: '/tmp/nested.ts',
          changes: [{
            path: '/tmp/nested.ts',
            kind: { type: 'update' },
            diff: '@@ -1 +1 @@\n-old\n+new',
          }],
        },
        result: 'File changed',
        isLoading: false,
      }],
    })} />);

    fireEvent.click(container.querySelector('[aria-controls="task-trace-content"]')!);
    expect(screen.getByText('nested.ts')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(container.textContent).not.toContain('"changes"');
  });
});
