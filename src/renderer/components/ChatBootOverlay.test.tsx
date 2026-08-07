import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ChatBootOverlay from './ChatBootOverlay';

describe('ChatBootOverlay', () => {
  it('uses the same elevated paper background as the loaded chat page', () => {
    render(<ChatBootOverlay />);

    const overlay = screen.getByText('AI 启动中').closest('div')?.parentElement;

    expect(overlay).toHaveClass('bg-[var(--paper-elevated)]/80');
    expect(overlay).not.toHaveClass('bg-[var(--paper)]/80');
  });

  it('stays mounted and can show immediately again after being dismissed', () => {
    const { rerender } = render(<ChatBootOverlay show />);
    const overlay = screen.getByText('AI 启动中').closest('div')?.parentElement;

    rerender(<ChatBootOverlay show={false} />);
    expect(overlay).toHaveClass('opacity-0', 'pointer-events-none');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay?.querySelector('svg')).not.toHaveClass('animate-spin');

    rerender(<ChatBootOverlay show />);
    expect(screen.getByText('AI 启动中').closest('div')?.parentElement).toBe(overlay);
    expect(overlay).toHaveClass('opacity-100');
    expect(overlay).not.toHaveClass('transition-opacity');
    expect(overlay).toHaveAttribute('aria-hidden', 'false');
    expect(overlay?.querySelector('svg')).toHaveClass('animate-spin');
  });

  it('keeps restore failures inside the same shell without a hidden spinner', () => {
    const onRetry = vi.fn();
    render(<ChatBootOverlay show error="restore failed" onRetry={onRetry} />);

    expect(screen.getByText('restore failed')).toBeInTheDocument();
    expect(screen.getByText('restore failed').closest('div')?.querySelector('svg')).not.toHaveClass('animate-spin');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
