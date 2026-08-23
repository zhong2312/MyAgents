import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentItem } from '../../shared/agentTypes';
import { AgentCard } from './AgentCards';

const agent: AgentItem = {
  name: 'review-agent',
  description: 'Reviews project changes',
  scope: 'user',
  path: '/global/agents/review-agent.md',
  folderName: 'review-agent',
  layout: 'flat',
  synced: true,
};

describe('AgentCard capability identity', () => {
  it('places the Sub-Agent type icon before the title and keeps status badges on the right', () => {
    render(<AgentCard agent={agent} onClick={vi.fn()} />);

    const title = screen.getByText('review-agent');
    const card = title.closest('.group');
    const icon = card?.querySelector('[data-capability-type-icon="agent"]');
    const scope = screen.getByText('全局');
    const synced = screen.getByText('Claude Code');

    expect(icon?.nextElementSibling).toBe(title);
    expect(scope).toHaveClass('rounded-full', 'bg-[var(--paper-inset)]');
    expect(synced).toHaveClass('rounded-full', 'bg-[var(--info-bg)]');
  });
});
