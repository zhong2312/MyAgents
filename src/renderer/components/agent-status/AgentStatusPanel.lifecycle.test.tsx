import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { Message, ToolUseSimple } from '@/types/chat';
import { BACKGROUND_TASK_STATUS_EVENT } from '@/utils/backgroundTaskStatus';

import AgentStatusPanel from './AgentStatusPanel';

const panelHarness = vi.hoisted(() => ({
  messages: [] as Message[],
  streamingMessage: null as Message | null,
  sessionState: 'idle' as 'idle' | 'running',
}));

vi.mock('@/context/TabContext', () => ({
  useTabStateOptional: () => ({
    messages: panelHarness.messages,
    streamingMessage: panelHarness.streamingMessage,
    sessionState: panelHarness.sessionState,
    agentPlanTodos: null,
    sessionId: 'session-panel',
  }),
}));

function messageWithLifecycle(status: 'running' | 'completed'): Message {
  const tool: ToolUseSimple = {
    id: 'spawn-card',
    name: 'CollabAgent',
    input: { tool: 'spawnAgent' },
    parsedInput: { tool: 'spawnAgent', prompt: 'Review lifecycle' },
    streamIndex: 0,
    subagentLifecycle: status === 'running'
      ? { status, startedAt: 100 }
      : { status, startedAt: 100, finishedAt: 1_100 },
  };
  return {
    id: 'assistant-turn',
    role: 'assistant',
    timestamp: new Date(0),
    content: [{ type: 'tool_use', tool }],
  };
}

describe('AgentStatusPanel child lifecycle group', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    panelHarness.messages = [];
    panelHarness.streamingMessage = null;
    panelHarness.sessionState = 'idle';
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows terminal rows for one 500ms group linger before fading', () => {
    panelHarness.messages = [messageWithLifecycle('running')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';
    render(
      <AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />,
    );
    act(() => vi.advanceTimersByTime(40));
    fireEvent.click(screen.getByRole('button', { name: '展开 Agent 状态面板' }));
    expect(screen.getByText('Review lifecycle')).toBeInTheDocument();

    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    act(() => window.dispatchEvent(new CustomEvent(BACKGROUND_TASK_STATUS_EVENT, {
      detail: { sessionId: 'session-panel' },
    })));
    expect(screen.getByText('Review lifecycle')).toBeInTheDocument();
    expect(document.querySelector('[aria-label="已完成"]')).not.toBeNull();
    const panel = document.querySelector('button[aria-label="收起 Agent 状态面板"]')?.parentElement;
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('opacity-100');

    act(() => vi.advanceTimersByTime(499));
    expect(panel).toHaveClass('opacity-100');
    act(() => vi.advanceTimersByTime(1));
    expect(panel).toHaveClass('opacity-0');
    expect(panel).toHaveAttribute('inert');
  });

  it('mounts a live terminal-first group when running and terminal updates batch', () => {
    panelHarness.messages = [messageWithLifecycle('completed')];
    panelHarness.streamingMessage = panelHarness.messages[0];
    panelHarness.sessionState = 'running';

    render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(40));

    expect(screen.getByText('Agents 1')).toBeInTheDocument();
    const panel = screen.getByRole('button', { name: '展开 Agent 状态面板' }).parentElement;
    expect(panel).toHaveClass('opacity-100');
    act(() => vi.advanceTimersByTime(499));
    expect(panel).toHaveClass('opacity-100');
  });

  it('does not mount a cold terminal history group', () => {
    panelHarness.messages = [messageWithLifecycle('completed')];
    render(<AgentStatusPanel containerRef={createRef<HTMLElement>()} onJumpToTool={() => undefined} />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('Agents 1')).not.toBeInTheDocument();
  });
});
