import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';

import WorkspaceCard from './WorkspaceCard';

const project: Project = {
    id: 'p1',
    name: 'Mino5',
    displayName: 'Mino5',
    path: '/Users/zhihu/.myagents/projects/Mino5',
    providerId: null,
    permissionMode: null,
    isAgent: true,
    agentId: 'agent-1',
};

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: 'agent-1',
        name: 'Mino5',
        enabled: true,
        workspacePath: project.path,
        permissionMode: 'auto',
        channels: [],
        ...overrides,
    };
}

function renderCard(props: Partial<ComponentProps<typeof WorkspaceCard>> = {}) {
    return render(
        <WorkspaceCard
            project={project}
            agent={agent()}
            onLaunch={vi.fn()}
            onRemove={vi.fn()}
            onArchive={vi.fn()}
            onUnarchive={vi.fn()}
            onAgentSettings={vi.fn()}
            onOpenFolder={vi.fn()}
            onTogglePin={vi.fn()}
            {...props}
        />,
    );
}

describe('WorkspaceCard', () => {
    it('does not show a pending chatbot setup hint when proactive Agent has no channels', () => {
        renderCard();

        expect(screen.getByText('Mino5')).toBeInTheDocument();
        expect(screen.queryByText('待配置聊天机器人')).not.toBeInTheDocument();
    });

    it('shows the registered workbench type beside the workspace name', () => {
        renderCard({ workbenchLabel: '小说' });

        expect(screen.getByText('小说')).toBeInTheDocument();
    });

    it('still renders channel status tags when channels exist', () => {
        const status: AgentStatusData = {
            agentId: 'agent-1',
            agentName: 'Mino5',
            enabled: true,
            channels: [{
                channelId: 'channel-1',
                channelType: 'telegram',
                status: 'online',
                uptimeSeconds: 12,
                activeSessions: [],
                restartCount: 0,
                bufferedMessages: 0,
            }],
        };

        renderCard({
            agent: agent({
                channels: [{
                    id: 'channel-1',
                    type: 'telegram',
                    enabled: true,
                    setupCompleted: true,
                }],
            }),
            agentStatus: status,
        });

        expect(screen.getByText('Telegram')).toBeInTheDocument();
    });

    it('keeps channel tags in a fade-clipped row and moves actions into an overlay', () => {
        const status: AgentStatusData = {
            agentId: 'agent-1',
            agentName: 'Mino5',
            enabled: true,
            channels: [{
                channelId: 'channel-1',
                channelType: 'telegram',
                status: 'online',
                uptimeSeconds: 12,
                activeSessions: [],
                restartCount: 0,
                bufferedMessages: 0,
            }],
        };

        renderCard({
            agent: agent({
                channels: [{
                    id: 'channel-1',
                    type: 'telegram',
                    enabled: true,
                    setupCompleted: true,
                }],
            }),
            agentStatus: status,
        });

        expect(screen.getByText('Telegram').closest('.workspace-card-channel-tags-fade')).not.toBeNull();
        const moreButton = screen.getByLabelText('更多');
        expect(moreButton.closest('button')).toHaveClass('overflow-hidden', 'hover:z-20');
        expect(moreButton.parentElement).toHaveClass('workspace-card-action-overlay', 'z-20');
        expect(screen.queryByText('更多')).not.toBeInTheDocument();
    });

    it('opens the context menu from the hover more action without launching the workspace', () => {
        const onLaunch = vi.fn();
        const onAgentSettings = vi.fn();

        renderCard({ onLaunch, onAgentSettings });
        fireEvent.click(screen.getByLabelText('更多'));

        expect(onLaunch).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '置顶' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Agent 设置' }));

        expect(onAgentSettings).toHaveBeenCalledWith(project);
        expect(onLaunch).not.toHaveBeenCalled();
    });

    it('opens the workspace folder from the shared workspace menu', () => {
        const onLaunch = vi.fn();
        const onOpenFolder = vi.fn();

        renderCard({ onLaunch, onOpenFolder });
        fireEvent.click(screen.getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));

        expect(onOpenFolder).toHaveBeenCalledWith(project);
        expect(onLaunch).not.toHaveBeenCalled();
    });

    it('shows pin action in the right-click menu', () => {
        const onTogglePin = vi.fn();

        renderCard({ onTogglePin });
        fireEvent.contextMenu(screen.getByRole('button', { name: /Mino5/ }));
        fireEvent.click(screen.getByRole('button', { name: '置顶' }));

        expect(onTogglePin).toHaveBeenCalledWith(project);
    });

    it('shows unpin action for pinned projects', () => {
        const pinnedProject = { ...project, pinnedAt: '2026-06-01T00:00:00.000Z' };
        const onTogglePin = vi.fn();

        renderCard({ project: pinnedProject, onTogglePin });
        fireEvent.contextMenu(screen.getByRole('button', { name: /Mino5/ }));
        fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));

        expect(onTogglePin).toHaveBeenCalledWith(pinnedProject);
    });

    it('switches archive and unarchive actions based on archived state', () => {
        const onArchive = vi.fn();
        const onUnarchive = vi.fn();

        const { rerender } = renderCard({ onArchive, onUnarchive });
        fireEvent.click(screen.getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '归档' }));

        expect(onArchive).toHaveBeenCalledWith(project);

        const archivedProject = { ...project, archivedAt: '2026-07-03T00:00:00.000Z' };
        rerender(
            <WorkspaceCard
                project={archivedProject}
                archived
                agent={agent()}
                onLaunch={vi.fn()}
                onRemove={vi.fn()}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onAgentSettings={vi.fn()}
                onOpenFolder={vi.fn()}
                onTogglePin={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByLabelText('更多'));

        expect(screen.queryByRole('button', { name: '置顶' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '取消归档' }));

        expect(onUnarchive).toHaveBeenCalledWith(archivedProject);
    });
});
