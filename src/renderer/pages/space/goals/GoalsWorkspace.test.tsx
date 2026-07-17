import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SpaceGoal, SpaceSession } from '@/api/spaceCloud';
import { ToastProvider } from '@/components/Toast';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { GoalsWorkspace } from './GoalsWorkspace';

const session: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'user-1', email: 'user@example.com' },
  space: {
    id: 'space-1',
    slug: 'official',
    name: 'MyAgents社区',
    joinPolicy: 'open',
    rootGoalId: 'goal-root',
  },
  membership: { id: 'membership-1', role: 'owner' },
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const rootGoal: SpaceGoal = {
  id: 'goal-root',
  spaceId: 'space-1',
  parentGoalId: null,
  path: '/goal-root/',
  depth: 0,
  title: 'MyAgents社区',
  context: 'Root context',
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
  goalPathLabel: 'MyAgents社区',
};

const childGoal: SpaceGoal = {
  id: 'goal-child',
  spaceId: 'space-1',
  parentGoalId: 'goal-root',
  path: '/goal-root/goal-child/',
  depth: 1,
  title: 'Runtime Delivery',
  context: 'Runtime context',
  createdAt: '2026-06-24T01:00:00.000Z',
  updatedAt: '2026-06-24T01:00:00.000Z',
  goalPathLabel: 'MyAgents社区 / Runtime Delivery',
};

function buildActions(overrides: Partial<SpaceActions> = {}): SpaceActions {
  return {
    ensureBootstrapped: vi.fn(),
    refreshIssues: vi.fn(),
    refreshGoals: vi.fn(),
    refreshIssueDetail: vi.fn(),
    refreshSkills: vi.fn(),
    refreshSkillDetail: vi.fn(),
    refreshSkillFile: vi.fn(),
    refreshSkillRevisions: vi.fn(),
    refreshLocalAgents: vi.fn(),
    refreshRegisteredAgents: vi.fn(),
    syncEvents: vi.fn(),
    createGoal: vi.fn(),
    updateGoal: vi.fn(),
    archiveGoal: vi.fn(),
    createIssue: vi.fn(),
    uploadIssueAttachments: vi.fn(),
    downloadIssueAttachment: vi.fn(),
    commentIssue: vi.fn(),
    setIssueState: vi.fn(),
    closeOwnIssue: vi.fn(),
    closeIssue: vi.fn(),
    completeIssue: vi.fn(),
    cancelIssueClaim: vi.fn(),
    uploadSkillZip: vi.fn(),
    uploadSkillRevision: vi.fn(),
    rollbackSkill: vi.fn(),
    deleteSkill: vi.fn(),
    installSkill: vi.fn(),
    registerAgent: vi.fn(),
    updateRegisteredAgent: vi.fn(),
    revokeRegisteredAgent: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  } as unknown as SpaceActions;
}

function renderGoals(actions: SpaceActions, onOpenIssuesForGoal = vi.fn()) {
  return render(
    <ToastProvider>
      <GoalsWorkspace
        admin
        session={session}
        goals={[rootGoal, childGoal]}
        actions={actions}
        onRefresh={vi.fn()}
        onOpenIssuesForGoal={onOpenIssuesForGoal}
      />
    </ToastProvider>,
  );
}

describe('GoalsWorkspace', () => {
  it('starts with an empty detail state until a goal is selected', () => {
    const actions = buildActions();
    renderGoals(actions);

    expect(screen.getByText('未选择目标')).toBeInTheDocument();
    expect(screen.queryByText('Root context')).not.toBeInTheDocument();
  });

  it('updates the selected goal from edit mode', async () => {
    const updateGoal = vi.fn().mockResolvedValue({
      ...childGoal,
      title: 'Runtime Reliability',
      context: 'Updated context',
    });
    const actions = buildActions({ updateGoal });
    renderGoals(actions);

    fireEvent.click(screen.getByRole('button', { name: 'Runtime Delivery' }));
    const context = screen.getByText('Runtime context');
    expect(context).toBeInTheDocument();
    expect(context.parentElement).toHaveClass('px-3', 'max-sm:px-2');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: 'Runtime Reliability' },
    });
    fireEvent.change(screen.getByLabelText('上下文'), {
      target: { value: 'Updated context' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateGoal).toHaveBeenCalledWith({
        goalId: 'goal-child',
        title: 'Runtime Reliability',
        context: 'Updated context',
      });
    });
  });

  it('opens child goal creation from the selected goal detail', async () => {
    const createGoal = vi.fn().mockResolvedValue({
      ...childGoal,
      id: 'goal-new',
      title: 'Renderer QA',
      context: 'Renderer context',
    });
    const actions = buildActions({ createGoal });
    renderGoals(actions);

    fireEvent.click(screen.getByRole('button', { name: 'MyAgents社区' }));
    fireEvent.click(screen.getByRole('button', { name: '新建子目标' }));

    expect(screen.getByText('父级目标：')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: 'Renderer QA' },
    });
    fireEvent.change(screen.getByLabelText('上下文'), {
      target: { value: 'Renderer context' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建子目标' }));

    await waitFor(() => {
      expect(createGoal).toHaveBeenCalledWith({
        parentGoalId: 'goal-root',
        title: 'Renderer QA',
        context: 'Renderer context',
      });
    });
  });

  it('lets the create-mode parent breadcrumb navigate back to the parent goal', () => {
    const actions = buildActions();
    renderGoals(actions);

    fireEvent.click(screen.getByRole('button', { name: 'MyAgents社区' }));
    fireEvent.click(screen.getByRole('button', { name: '新建子目标' }));

    const parentButtons = screen.getAllByRole('button', { name: 'MyAgents社区' });
    fireEvent.click(parentButtons[parentButtons.length - 1]);

    expect(screen.getByRole('heading', { name: 'MyAgents社区' })).toBeInTheDocument();
    expect(screen.getByText('Root context')).toBeInTheDocument();
  });

  it('navigates direct child goals from the detail child list', () => {
    const actions = buildActions();
    renderGoals(actions);

    fireEvent.click(screen.getByRole('button', { name: 'MyAgents社区' }));
    fireEvent.click(screen.getByText('Runtime context'));

    expect(screen.getByRole('heading', { name: 'Runtime Delivery' })).toBeInTheDocument();
  });

  it('requires confirmation before deleting a non-root goal', async () => {
    const archiveGoal = vi.fn().mockResolvedValue(undefined);
    const actions = buildActions({ archiveGoal });
    renderGoals(actions);

    fireEvent.click(screen.getByRole('button', { name: 'Runtime Delivery' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(archiveGoal).not.toHaveBeenCalled();
    expect(screen.getByText('删除目标')).toBeInTheDocument();

    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(archiveGoal).toHaveBeenCalledWith('goal-child');
    });
  });

  it('opens the Issue list for the selected goal', () => {
    const onOpenIssuesForGoal = vi.fn();
    const actions = buildActions();
    renderGoals(actions, onOpenIssuesForGoal);

    fireEvent.click(screen.getByRole('button', { name: 'Runtime Delivery' }));
    fireEvent.click(screen.getByRole('button', { name: '查看 Issues' }));

    expect(onOpenIssuesForGoal).toHaveBeenCalledWith('goal-child');
  });
});
