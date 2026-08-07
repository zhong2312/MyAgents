import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));

import Message from './Message';

const TIMESTAMP = new Date('2026-06-27T08:00:00Z');

function assistantMsg(overrides: Partial<MessageType> = {}): MessageType {
  return {
    id: 'assistant-turn-meta',
    role: 'assistant',
    content: '这一轮已经完成。',
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

function userMsg(): MessageType {
  return {
    id: 'user-rewind-anchor',
    role: 'user',
    content: '回到这里',
    timestamp: TIMESTAMP,
  };
}

describe('Message — assistant turn meta footer', () => {
  it('renders duration and total tokens in the hover-only action row', () => {
    render(
      <Message
        message={assistantMsg({
          durationMs: 134_000,
          usage: {
            inputTokens: 10_000,
            outputTokens: 2_400,
          },
        })}
      />
    );

    const meta = screen.getByText('本轮耗时 2m 14s · 12.4K tokens');
    expect(meta).toBeInTheDocument();
    expect(meta).toHaveClass('text-xs', 'opacity-0', 'group-hover/actions:opacity-100');
  });

  it('omits the meta label when both duration and token numbers are absent', () => {
    render(<Message message={assistantMsg()} />);

    expect(screen.queryByText(/本轮耗时|tokens/)).not.toBeInTheDocument();
  });

  it('re-renders when only completed turn metrics change', () => {
    const { rerender } = render(<Message message={assistantMsg()} />);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();

    rerender(
      <Message
        message={assistantMsg({
          durationMs: 1_500,
          usage: {
            inputTokens: 500,
            outputTokens: 20,
          },
        })}
      />
    );

    expect(screen.getByText('本轮耗时 1.5s · 520 tokens')).toBeInTheDocument();
  });

  it('offers fork for a Codex assistant anchor without a builtin SDK uuid', () => {
    render(
      <Message
        message={assistantMsg({
          runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-1' },
        })}
        onFork={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '分支' })).toBeInTheDocument();
  });

  it('re-renders the same user row when rewind becomes available', () => {
    const message = userMsg();
    const { rerender } = render(<Message message={message} />);
    expect(screen.queryByRole('button', { name: '时间回溯' })).not.toBeInTheDocument();

    rerender(<Message message={message} onRewind={vi.fn()} />);

    expect(screen.getByRole('button', { name: '时间回溯' })).toBeInTheDocument();
  });

  it('re-renders the same anchored assistant row when fork becomes unavailable', () => {
    const message = assistantMsg({
      runtimeTurnAnchor: { turnId: 'turn-stable', rootUserMessageId: 'user-stable' },
    });
    const { rerender } = render(<Message message={message} onFork={vi.fn()} />);
    expect(screen.getByRole('button', { name: '分支' })).toBeInTheDocument();

    rerender(<Message message={message} />);

    expect(screen.queryByRole('button', { name: '分支' })).not.toBeInTheDocument();
  });
});
