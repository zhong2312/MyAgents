import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillItem } from '../../shared/skillsTypes';
import GlobalSkillsPanel from './GlobalSkillsPanel';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: apiMocks.get,
  apiPostJson: apiMocks.post,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('./SkillDetailPanel', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function MockSkillDetailPanel() {
      return <div data-testid="skill-detail" />;
    }),
  };
});

vi.mock('./CommandDetailPanel', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function MockCommandDetailPanel() {
      return <div data-testid="command-detail" />;
    }),
  };
});

const requiredSkill: SkillItem = {
  name: 'myagents-cli',
  description: 'MyAgents product operations',
  scope: 'user',
  path: '/tmp/myagents-cli/SKILL.md',
  folderName: 'myagents-cli',
  author: 'MyAgents',
  systemOwned: true,
  required: true,
  enabled: true,
};

const optionalSystemSkill: SkillItem = {
  name: 'prompt-writer',
  description: 'Prompt methodology',
  scope: 'user',
  path: '/tmp/prompt-writer/SKILL.md',
  folderName: 'prompt-writer',
  systemOwned: true,
  required: false,
  enabled: true,
};

describe('GlobalSkillsPanel required skill controls', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/skills?scope=user') {
        return { success: true, skills: [requiredSkill, optionalSystemSkill] };
      }
      if (path === '/api/command-items?scope=user') {
        return { success: true, commands: [] };
      }
      if (path === '/api/skill/sync-check') {
        return { canSync: false, count: 0, folders: [] };
      }
      return { success: false };
    });
    apiMocks.post.mockResolvedValue({ success: true });
  });

  it('hides only the required switch while keeping the required card navigable', async () => {
    const onDetailChange = vi.fn();
    render(<GlobalSkillsPanel onDetailChange={onDetailChange} />);

    const requiredTitle = await screen.findByText('myagents-cli');
    const optionalTitle = screen.getByText('prompt-writer');
    const requiredCard = requiredTitle.closest('.group');
    const optionalCard = optionalTitle.closest('.group');

    expect(requiredCard).not.toBeNull();
    expect(optionalCard).not.toBeNull();
    expect(requiredCard?.querySelector('[role="switch"]')).toBeNull();
    expect(optionalCard?.querySelector('[role="switch"]')).not.toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getByText('MyAgents')).toBeInTheDocument();

    fireEvent.click(requiredCard!);
    await waitFor(() => expect(onDetailChange).toHaveBeenLastCalledWith(true));
  });
});
