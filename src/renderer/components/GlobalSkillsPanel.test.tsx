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

    const typeIcon = requiredCard?.querySelector('[data-capability-type-icon="skill"]');
    const author = screen.getByText('MyAgents');
    const systemStatus = screen.getByText('系统');
    expect(typeIcon?.nextElementSibling).toContainElement(requiredTitle);
    expect(requiredTitle.nextElementSibling).toBe(author);
    expect(author).not.toHaveClass('rounded-full', 'bg-[var(--paper-inset)]');
    expect(systemStatus).toHaveClass('rounded-full', 'bg-[var(--paper-inset)]');

    fireEvent.click(requiredCard!);
    await waitFor(() => expect(onDetailChange).toHaveBeenLastCalledWith(true));
  });

  it('shows blocked and warning integrity evidence without offering automatic repair', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/skills?scope=user') {
        return {
          success: true,
          skills: [optionalSystemSkill],
          integrityIssues: [
            {
              reason: 'missing_canonical_entry',
              severity: 'blocked',
              folderName: 'pdf',
              canonicalPresent: false,
              revealPath: '/tmp/pdf',
              required: false,
            },
            {
              reason: 'reserved_entry_sibling',
              severity: 'warning',
              folderName: 'prompt-writer',
              canonicalPresent: true,
              revealPath: '/tmp/prompt-writer',
              required: false,
            },
          ],
        };
      }
      if (path === '/api/command-items?scope=user') return { success: true, commands: [] };
      if (path === '/api/skill/sync-check') return { canSync: false, count: 0, folders: [] };
      return { success: false };
    });

    render(<GlobalSkillsPanel />);

    expect(await screen.findByText('pdf')).toBeInTheDocument();
    expect(screen.getByText('已阻止加载')).toBeInTheDocument();
    expect(screen.getByText('需检查')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修复/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '在文件夹中显示' })).toHaveLength(2);
  });

  it('invalidates mounted project capability snapshots after creating a global Command', async () => {
    const changed = vi.fn();
    window.addEventListener('project-capabilities-changed', changed);
    try {
      render(<GlobalSkillsPanel />);
      const newButtons = await screen.findAllByRole('button', { name: /New|新建/ });
      fireEvent.click(newButtons.at(-1)!);

      const inputs = await screen.findAllByRole('textbox');
      fireEvent.change(inputs[0]!, { target: { value: '中文 总结' } });
      fireEvent.click(screen.getByRole('button', { name: /Create|创建/ }));

      await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith('/api/command-item/create', {
        name: '中文 总结',
        scope: 'user',
        description: undefined,
      }));
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener('project-capabilities-changed', changed);
    }
  });
});
