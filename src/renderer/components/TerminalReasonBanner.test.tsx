import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import TerminalReasonBanner from './TerminalReasonBanner';

describe('TerminalReasonBanner diagnostics action', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('shows diagnostics for error-level terminal reasons', () => {
    const onDiagnose = vi.fn();
    render(
      <TerminalReasonBanner
        reason="prompt_too_long"
        onDismiss={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask helper to diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith('prompt_too_long');
  });

  it('shows diagnostics for unknown future terminal reasons', () => {
    const onDiagnose = vi.fn();
    render(
      <TerminalReasonBanner
        reason="future_reason"
        onDismiss={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask helper to diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith('future_reason');
  });

  it('states that rapid context refill stopped the turn and offers diagnostics', () => {
    const onDiagnose = vi.fn();
    const { container } = render(
      <TerminalReasonBanner
        reason="rapid_refill_breaker"
        onDismiss={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    expect(screen.getByText('Context repeatedly refilled; this turn stopped')).toBeInTheDocument();
    expect(screen.getByText(
      'The context reached its limit several times shortly after automatic compaction. Reduce file or tool output and try again; if it still fails, start a new chat.',
    )).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('bg-[var(--error-bg)]');

    fireEvent.click(screen.getByRole('button', { name: 'Ask helper to diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith('rapid_refill_breaker');
  });

  it('uses the corrected Chinese copy for rapid context refill', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <TerminalReasonBanner
        reason="rapid_refill_breaker"
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('上下文反复填满，本轮已停止')).toBeInTheDocument();
    expect(screen.getByText(
      '自动压缩后，上下文仍在短时间内多次达到上限。请缩小文件或工具输出后重试；若仍失败，可新开会话继续。',
    )).toBeInTheDocument();
  });

  it('does not show diagnostics for normal or self-recovering reasons', () => {
    const onDiagnose = vi.fn();
    const { rerender } = render(
      <TerminalReasonBanner
        reason="max_turns"
        onDismiss={vi.fn()}
        onNewSession={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Ask helper to diagnose' })).not.toBeInTheDocument();

    for (const reason of ['tool_deferred', 'background_requested']) {
      rerender(
        <TerminalReasonBanner
          reason={reason}
          onDismiss={vi.fn()}
          onDiagnose={onDiagnose}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Ask helper to diagnose' })).not.toBeInTheDocument();
    }
  });
});
