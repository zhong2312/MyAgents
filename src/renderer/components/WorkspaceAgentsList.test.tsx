import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentItem } from '../../shared/agentTypes';
import WorkspaceAgentsList from './WorkspaceAgentsList';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: apiMocks.get,
  apiPostJson: apiMocks.post,
  apiPutJson: apiMocks.put,
  apiDelete: apiMocks.delete,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

const localAgent: AgentItem = {
  name: 'workspace-reviewer',
  description: 'Reviews workspace changes',
  scope: 'project',
  path: '/workspace/.claude/agents/workspace-reviewer.md',
  folderName: 'workspace-reviewer',
  layout: 'flat',
};

describe('WorkspaceAgentsList capability identity', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.put.mockReset();
    apiMocks.delete.mockReset();
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/agents?scope=project&agentDir=%2Fworkspace') {
        return { success: true, agents: [localAgent] };
      }
      if (path === '/api/agents?scope=user') {
        return { success: true, agents: [] };
      }
      if (path === '/api/agents/workspace-config?agentDir=%2Fworkspace') {
        return { success: true, config: { local: {}, global_refs: {} } };
      }
      return { success: false };
    });
  });

  it('places the Sub-Agent type icon before the title in the workspace card', async () => {
    render(
      <WorkspaceAgentsList
        scope="project"
        agentDir="/workspace"
        onSelectAgent={vi.fn()}
      />,
    );

    const title = await screen.findByText('workspace-reviewer');
    const card = title.closest('.group');
    const icon = card?.querySelector('[data-capability-type-icon="agent"]');

    expect(icon?.nextElementSibling).toBe(title);
  });
});
