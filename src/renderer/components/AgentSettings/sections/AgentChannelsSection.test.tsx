import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ChannelType } from '../../../../shared/types/agent';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { dismissTopmost } from '@/utils/closeLayer';
import AgentChannelsSection from './AgentChannelsSection';

vi.mock('@/components/OverlayBackdrop', () => ({
  default: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="overlay" className={className}>{children}</div>
  ),
}));

vi.mock('../channels/ChannelPlatformSelect', () => ({
  default: ({ onSelect }: { onSelect: (platform: ChannelType) => void }) => (
    <div>
      <span>platform-picker</span>
      <button type="button" onClick={() => onSelect('dingtalk')}>pick-dingtalk</button>
    </div>
  ),
}));

vi.mock('../channels/ChannelWizard', () => ({
  default: ({ platform, onCancel, onComplete }: {
    platform: ChannelType;
    onCancel: () => void;
    onComplete: (channelId: string) => void;
  }) => (
    <div>
      <span>wizard-{platform}</span>
      <button type="button" onClick={onCancel}>wizard-cancel</button>
      <button type="button" onClick={() => onComplete('channel-1')}>wizard-complete</button>
    </div>
  ),
}));

vi.mock('../channels/ChannelDetailView', () => ({ default: () => null }));

vi.mock('@/config/services/agentConfigService', () => ({
  startAndEnableAgentChannel: vi.fn(),
  stopAndDisableAgentChannel: vi.fn(),
}));

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent',
  enabled: false,
  permissionMode: 'auto',
  channels: [],
};

function ParentOverlayHarness({ initialAddPlatform }: { initialAddPlatform?: ChannelType }) {
  const [open, setOpen] = useState(true);
  useCloseLayer(() => false, 300);
  useCloseLayer(() => {
    setOpen(false);
    return true;
  }, 200);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dismissTopmost()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!open) return null;
  return (
    <div data-testid="parent-overlay">
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
        initialAddPlatform={initialAddPlatform}
        onInitialAddPlatformConsumed={vi.fn()}
      />
    </div>
  );
}

describe('AgentChannelsSection direct entry', () => {
  it('returns a registry deep link to Channels but keeps normal Add navigation intact', () => {
    const onConsumed = vi.fn();
    render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
        initialAddPlatform="telegram"
        onInitialAddPlatformConsumed={onConsumed}
      />,
    );

    expect(screen.getByText('wizard-telegram')).toBeInTheDocument();
    expect(screen.getByTestId('overlay')).toHaveClass('z-[210]');
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /添加|Add/u }));
    expect(screen.getByText('platform-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pick-dingtalk' }));
    expect(screen.getByText('wizard-dingtalk')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    expect(screen.getByText('platform-picker')).toBeInTheDocument();
  });

  it('does not reopen a consumed registry intent after the section remounts', () => {
    const first = render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
        initialAddPlatform="telegram"
        onInitialAddPlatformConsumed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'wizard-cancel' }));
    first.unmount();

    render(
      <AgentChannelsSection
        agent={agent}
        onAgentChanged={vi.fn()}
      />,
    );

    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('platform-picker')).not.toBeInTheDocument();
  });

  it('owns a higher close layer than its parent overlay', () => {
    render(<ParentOverlayHarness initialAddPlatform="telegram" />);

    act(() => {
      expect(dismissTopmost()).toBe(true);
    });

    expect(screen.getByTestId('parent-overlay')).toBeInTheDocument();
    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();

    act(() => {
      expect(dismissTopmost()).toBe(true);
    });
    expect(screen.queryByTestId('parent-overlay')).not.toBeInTheDocument();
  });

  it('lets Escape close the channel overlay before its parent', () => {
    render(<ParentOverlayHarness initialAddPlatform="telegram" />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('parent-overlay')).toBeInTheDocument();
    expect(screen.queryByText('wizard-telegram')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('parent-overlay')).not.toBeInTheDocument();
  });
});
