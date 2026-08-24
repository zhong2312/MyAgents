import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandItem, SkillItem } from '../../shared/skillsTypes';
import SkillsCommandsList from './SkillsCommandsList';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: apiMocks.get,
  apiPostJson: apiMocks.post,
  apiDelete: apiMocks.delete,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

const requiredSkill: SkillItem = {
  name: 'myagents-cli',
  description: 'Required operations',
  scope: 'user',
  path: '/global/myagents-cli/SKILL.md',
  folderName: 'myagents-cli',
  systemOwned: true,
  required: true,
  enabled: true,
  capabilityId: 'global:skill:myagents-cli',
  origin: 'global',
};

const optionalSkill: SkillItem = {
  name: 'review',
  description: 'Project review',
  scope: 'project',
  path: '/workspace/.claude/skills/review/SKILL.md',
  folderName: 'review',
  systemOwned: false,
  required: false,
  enabled: true,
  capabilityId: 'project:skill:review',
  origin: 'project',
};

const globalCommand: CommandItem = {
  name: 'ship',
  description: 'Ship release',
  scope: 'user',
  path: '/global/commands/ship.md',
  fileName: 'ship',
  enabled: false,
  capabilityId: 'global:command:ship',
  origin: 'global',
  author: 'MyAgents',
};

describe('SkillsCommandsList project capability controls', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.delete.mockReset();
    apiMocks.get.mockResolvedValue({
      success: true,
      skills: [requiredSkill, optionalSkill],
      commands: [globalCommand],
    });
    apiMocks.post.mockResolvedValue({
      success: true,
      skills: [requiredSkill, { ...optionalSkill, enabled: false }],
      commands: [globalCommand],
    });
  });

  it('loads project and global cards once, hides required switches, and persists an exact toggle', async () => {
    const onSelectSkill = vi.fn();
    render(
      <SkillsCommandsList
        scope="project"
        agentDir="/workspace"
        onSelectSkill={onSelectSkill}
        onSelectCommand={vi.fn()}
      />,
    );

    const reviewTitle = await screen.findByText('review');
    const requiredCard = screen.getByText('myagents-cli').closest('.group');
    const reviewCard = reviewTitle.closest('.group');
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledWith('/api/project-capabilities?agentDir=%2Fworkspace');
    expect(requiredCard?.querySelector('[role="switch"]')).toBeNull();
    expect(reviewCard?.querySelector('[role="switch"]')).not.toBeNull();
    const requiredTitle = screen.getByText('myagents-cli');
    const systemStatus = screen.getByText('系统');
    const commandTitle = screen.getByText('ship');
    const commandCard = commandTitle.closest('.group');
    const commandIcon = commandCard?.querySelector('[data-capability-type-icon="command"]');
    const commandAuthor = commandCard?.querySelector('[data-capability-author]');
    expect(requiredCard?.querySelector('[data-capability-type-icon="skill"]')?.nextElementSibling).toContainElement(requiredTitle);
    expect(systemStatus).toHaveClass('rounded-full', 'bg-[var(--paper-inset)]');
    expect(commandIcon?.nextElementSibling).toContainElement(commandTitle);
    expect(commandTitle.nextElementSibling).toBe(commandAuthor);
    expect(commandAuthor).not.toHaveClass('rounded-full', 'bg-[var(--paper-inset)]');

    fireEvent.click(requiredCard!);
    expect(onSelectSkill).toHaveBeenCalledWith('myagents-cli', 'user');

    fireEvent.click(reviewCard!.querySelector('[role="switch"]')!);

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith(
      '/api/project-capability/toggle',
      {
        capabilityId: 'project:skill:review',
        enabled: false,
        agentDir: '/workspace',
      },
    ));
    await waitFor(() => expect(reviewCard!.querySelector('[role="switch"]')).toHaveAttribute('aria-checked', 'false'));
  });

  it('restores the last authoritative value when save and refresh both fail', async () => {
    apiMocks.get
      .mockResolvedValueOnce({
        success: true,
        skills: [requiredSkill, optionalSkill],
        commands: [globalCommand],
      })
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    apiMocks.post.mockRejectedValueOnce(new Error('save unavailable'));
    render(
      <SkillsCommandsList
        scope="project"
        agentDir="/workspace"
        onSelectSkill={vi.fn()}
        onSelectCommand={vi.fn()}
      />,
    );

    const reviewCard = (await screen.findByText('review')).closest('.group')!;
    const toggle = reviewCard.querySelector('[role="switch"]')!;
    fireEvent.click(toggle);

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });
});
