import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillDetail } from '../../shared/skillsTypes';
import SkillDetailPanel from './SkillDetailPanel';

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

vi.mock('@/context/TabContext', () => ({
  useTabApiOptional: () => null,
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ openPathExternal: vi.fn() }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/components/Markdown', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/MonacoEditor', () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: 'review',
    folderName: 'review',
    path: '/workspace/.claude/skills/review/SKILL.md',
    scope: 'project',
    systemOwned: false,
    required: false,
    frontmatter: { name: 'review', description: 'Review changes' },
    body: '# Review',
    ...overrides,
  };
}

function renderPanel(name: string, scope: 'user' | 'project', startInEditMode = false) {
  return render(
    <SkillDetailPanel
      name={name}
      scope={scope}
      agentDir="/workspace"
      startInEditMode={startInEditMode}
      onBack={vi.fn()}
      onSaved={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );
}

describe('SkillDetailPanel source and ownership controls', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.put.mockReset();
    apiMocks.delete.mockReset();
  });

  it('labels an ordinary global Skill and keeps explicit editing available', async () => {
    const path = '/home/user/.myagents/skills/global-review/SKILL.md';
    apiMocks.get.mockResolvedValue({
      success: true,
      skill: detail({
        name: 'global-review',
        folderName: 'global-review',
        path,
        scope: 'user',
      }),
    });

    renderPanel('global-review', 'user');

    expect(await screen.findByText('全局')).toBeInTheDocument();
    expect(screen.getByTitle(path)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
  });

  it('keeps a physical project Skill editable without a global tag', async () => {
    const path = '/workspace/.claude/skills/review/SKILL.md';
    apiMocks.get.mockResolvedValue({ success: true, skill: detail({ path }) });

    renderPanel('review', 'project');

    expect(await screen.findByTitle(path)).toBeInTheDocument();
    expect(screen.queryByText('全局')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
  });

  it('shows a global System Skill as read-only without edit or delete actions', async () => {
    apiMocks.get.mockResolvedValue({
      success: true,
      skill: detail({
        name: 'prompt-writer',
        folderName: 'prompt-writer',
        path: '/home/user/.myagents/skills/prompt-writer/SKILL.md',
        scope: 'user',
        systemOwned: true,
        required: false,
        frontmatter: { name: 'prompt-writer', description: 'Write prompts' },
      }),
    });

    renderPanel('prompt-writer', 'user', true);

    expect(await screen.findByText('全局')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('ignores an older editable response after switching to a System Skill', async () => {
    let resolveOlder!: (response: { success: boolean; skill: SkillDetail }) => void;
    const olderResponse = new Promise<{ success: boolean; skill: SkillDetail }>((resolve) => {
      resolveOlder = resolve;
    });
    apiMocks.get.mockImplementation((path: string) => {
      if (path.includes('global-review')) return olderResponse;
      return Promise.resolve({
        success: true,
        skill: detail({
          name: 'prompt-writer',
          folderName: 'prompt-writer',
          path: '/home/user/.myagents/skills/prompt-writer/SKILL.md',
          scope: 'user',
          systemOwned: true,
          frontmatter: { name: 'prompt-writer', description: 'Write prompts' },
        }),
      });
    });

    const view = renderPanel('global-review', 'user');
    view.rerender(
      <SkillDetailPanel
        name="prompt-writer"
        scope="user"
        agentDir="/workspace"
        onBack={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(await screen.findAllByText('prompt-writer')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        skill: detail({
          name: 'global-review',
          folderName: 'global-review',
          path: '/home/user/.myagents/skills/global-review/SKILL.md',
          scope: 'user',
          frontmatter: { name: 'global-review', description: 'Review changes' },
        }),
      });
      await olderResponse;
    });

    expect(screen.getAllByText('prompt-writer')).toHaveLength(2);
    expect(screen.queryByText('global-review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });
});
