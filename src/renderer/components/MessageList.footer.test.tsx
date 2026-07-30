import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

type VirtuosoMockProps = {
  components?: {
    Footer?: React.ComponentType<{ context?: unknown }>;
  };
};

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: VirtuosoMockProps) => {
    const Footer = props.components?.Footer;
    return (
      <div data-testid="virtuoso">
        {Footer ? <Footer context={undefined} /> : null}
      </div>
    );
  },
}));

vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createBaseProps(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  return {
    messages: [msg('h1', 'hello', 'user')],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef: { current: true } as React.MutableRefObject<boolean | 'force'>,
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const props: React.ComponentProps<typeof MessageList> = createBaseProps(overrides);
  return render(<MessageList {...props} />);
}

describe('MessageList footer status positioning', () => {
  it('keeps loading status in the Virtuoso footer flow above the measured spacer', () => {
    renderList({
      isLoading: true,
      bottomSpacerPx: 152.2,
    });

    expect(document.querySelector('[data-chat-status-overlay]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-footer-status-placeholder]')).not.toBeInTheDocument();

    const row = document.querySelector<HTMLElement>('[data-chat-status-row]');
    expect(row).toBeInTheDocument();
    if (!row) throw new Error('expected status row');
    expect(row).toHaveStyle({ height: '30px' });
    expect(row).not.toHaveClass('absolute');
    expect(row).not.toHaveClass('sticky');

    const spacer = document.querySelector<HTMLElement>('[data-chat-footer-spacer]');
    expect(spacer).toBeInTheDocument();
    if (!spacer) throw new Error('expected footer spacer');
    expect(spacer).toHaveStyle({ height: '193px' });
    expect(row.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-agent-execution-trace]')).not.toBeInTheDocument();
  });

  it('shows the real first-response wait in execution mode instead of random streaming copy', () => {
    renderList({
      isLoading: true,
      executionMode: true,
      sessionState: 'running',
    });

    const trace = document.querySelector('[data-agent-execution-trace]');
    expect(trace).toBeInTheDocument();
    expect(trace).toHaveTextContent('正在等待模型首个响应');
    expect(trace).not.toHaveTextContent('灵光一闪中');
    expect(document.querySelector('[data-chat-status-row]')).not.toBeInTheDocument();
  });

  it('reflects an active tool from the streaming message in execution mode', () => {
    const streamingMessage: MessageType = {
      id: 'streaming-tool',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        tool: {
          id: 'read-setting',
          name: 'Read',
          input: {},
          streamIndex: 0,
          isLoading: true,
        },
      }],
      timestamp: new Date(),
    };
    renderList({
      messages: [msg('h1', 'hello', 'user'), streamingMessage],
      streamingMessage,
      isLoading: true,
      executionMode: true,
      sessionState: 'running',
    });

    const trace = document.querySelector('[data-agent-execution-trace]');
    expect(trace).toHaveTextContent('正在调用工具：Read');
  });

  it('uses the same footer slot for idle system notices', () => {
    renderList({
      systemNotice: { kind: 'compact', level: 'success', message: 'Saved' },
    });

    expect(document.querySelector('[data-chat-status-row]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-footer-spacer]')).toBeInTheDocument();
    expect(document.body).toHaveTextContent('Saved');
  });
});
