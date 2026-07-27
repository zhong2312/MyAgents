import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpaceRegisteredAgent, SpaceSession } from '@/api/spaceCloud';
import { SpaceIdentityLine } from '@/pages/space/SpaceAvatar';
import { IssueAssigneePicker } from './IssueAssigneePicker';

const getMembers = vi.fn().mockResolvedValue({
  members: [{
    id: 'member-1',
    spaceId: 'space-1',
    userId: 'user-2',
    role: 'member',
    createdAt: '2026-07-12T00:00:00.000Z',
    user: { id: 'user-2', name: 'Mira Chen', email: 'mira@example.test' },
  }],
  joinRequests: [],
  invitations: [],
});

vi.mock('@/api/spaceCloud', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/spaceCloud')>(),
  spaceGetMembers: (...args: unknown[]) => getMembers(...args),
}));

const session: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'user-1', name: 'Ethan', email: 'ethan@example.test' },
  space: { id: 'space-1', slug: 'official', name: 'Official', joinPolicy: 'open' },
  membership: { id: 'membership-1', role: 'owner' },
  updatedAt: '2026-07-12T00:00:00.000Z',
};

const agent: SpaceRegisteredAgent = {
  id: 'rag-1',
  spaceId: 'space-1',
  displayName: 'MyAgents Debugger',
  instruction: 'Debug accepted issues.',
  instructionRevision: 1,
  status: 'active',
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

describe('IssueAssigneePicker', () => {
  beforeEach(() => {
    getMembers.mockClear();
    localStorage.clear();
  });

  it('shows Agents by default and searches both Agents and Space members', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(
      <IssueAssigneePicker
        session={session}
        assignee={null}
        agents={[agent]}
        onSelect={onSelect}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole('button', { name: '待认领' }));
    expect(screen.getByText('MyAgents Debugger')).toBeInTheDocument();
    await waitFor(() => expect(getMembers).toHaveBeenCalled());
    expect(screen.queryByText('Mira Chen')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('搜索 Agent 或 Space 成员'), 'Mira');
    await user.click(await screen.findByText('Mira Chen'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: 'user-2',
      type: 'user',
      name: 'Mira Chen',
    }));
  });

  it('places cancellation on the current row and confirms before clearing', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <IssueAssigneePicker
        session={session}
        assignee={{ id: agent.id, type: 'registered_agent', name: agent.displayName }}
        agents={[agent]}
        onSelect={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /MyAgents Debugger/ }));
    await user.click(screen.getByRole('button', { name: '取消指派' }));
    expect(screen.getByText('取消当前指派？')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '取消指派' }).at(-1)!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the Agent owner tip only on the read-only Agent tag', async () => {
    const user = userEvent.setup();
    render(
      <SpaceIdentityLine
        name="MyAgents Debugger"
        type="registered_agent"
        showAgentTag
        agentOwnerName="Ethan L"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('拥有者：Ethan L')).toBeInTheDocument();
  });

  it('lets a Member select self without calling the admin-only members API', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(
      <IssueAssigneePicker
        session={{ ...session, membership: { ...session.membership, role: 'member' } }}
        assignee={null}
        agents={[agent]}
        onSelect={onSelect}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole('button', { name: '待认领' }));
    await user.click(screen.getByText('Ethan'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', type: 'user' }));
    expect(getMembers).not.toHaveBeenCalled();
  });

  it('hides Agents for human-only Issues and disables Member reassignment of someone else', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <IssueAssigneePicker
        session={session}
        assignee={null}
        agents={[agent]}
        humanOnly
        onSelect={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '待认领' }));
    expect(screen.queryByText('MyAgents Debugger')).not.toBeInTheDocument();

    unmount();
    render(
      <IssueAssigneePicker
        session={{ ...session, membership: { ...session.membership, role: 'member' } }}
        assignee={{ id: 'user-2', type: 'user', name: 'Mira Chen' }}
        agents={[agent]}
        onSelect={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole('button', { name: /Mira Chen/ })).toBeDisabled();
  });

  it('clears a create-form selection immediately without confirmation', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <IssueAssigneePicker
        session={session}
        assignee={{ id: 'user-1', type: 'user', name: 'Ethan' }}
        agents={[agent]}
        cancelMode="selection"
        onSelect={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Ethan/ }));
    await user.click(screen.getByRole('button', { name: '取消指派' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByText('清空当前选择？')).not.toBeInTheDocument();
  });
});
