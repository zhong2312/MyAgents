import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpaceGoal, SpaceIssueDetail, SpaceSession } from '@/api/spaceCloud';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { IssueDetailDrawer } from '@/pages/space/issues/IssueDetailDrawer';

const openFileDialog = vi.fn();
const invokeTauri = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeTauri(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.clearAllMocks();
});

const session: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'u-1', email: 'user@example.com', name: 'User' },
  space: { id: 'space-1', slug: 'official', name: 'Official Space', joinPolicy: 'open' },
  membership: { id: 'membership-1', role: 'member' },
  updatedAt: '2026-06-30T00:00:00.000Z',
};

const detail: SpaceIssueDetail = {
  issue: {
    id: 'iss-1',
    number: 113,
    spaceId: 'space-1',
    title: 'Markdown issue',
    body: 'Issue body with **bold issue text**.\n\n- task one',
    state: 'todo',
    creator: { id: 'u-1', name: 'Ethan' },
    createdAt: '2026-06-25T00:25:00.000Z',
    updatedAt: '2026-06-25T00:25:00.000Z',
  },
  comments: {
    items: [
      {
        id: 'comment-1',
        author: { id: 'u-2', type: 'user', name: 'Commenter', avatarUrl: 'https://r2-public.myagents.test/commenter.png' },
        body: '## Comment heading\n\nComment with `inline code`.',
        attachments: [],
        createdAt: '2026-06-30T11:30:00.000Z',
      },
    ],
    hasMore: false,
    limit: 20,
  },
  attachments: [],
};

function actions(): SpaceActions {
  return {
    refreshIssueDetail: vi.fn().mockResolvedValue(undefined),
    updateIssue: vi.fn().mockResolvedValue({ ...detail.issue, title: 'Updated title', body: 'Updated body' }),
    uploadIssueAttachments: vi.fn().mockResolvedValue([]),
    commentIssue: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpaceActions;
}

describe('IssueDetailDrawer', () => {
  it('places issue actions in the header menu and renders issue text as Markdown', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[]}
        registeredAgents={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={actions()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const issueTitle = screen.getByRole('heading', { name: 'Markdown issue' });
    expect(within(issueTitle.parentElement!).queryByRole('button', { name: '复制 issue 口令' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制 issue 口令' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    expect(await screen.findByRole('button', { name: '复制 issue 口令' })).toBeInTheDocument();
    const metaRow = screen.getByText('#113').parentElement!;
    const metaText = metaRow.textContent ?? '';
    expect(metaText.indexOf('#113')).toBeLessThan(metaText.indexOf('Ethan'));
    expect(screen.getAllByText('Ethan').every((node) => node.tagName === 'SPAN')).toBe(true);
    expect(screen.getByText('Commenter').tagName).toBe('SPAN');
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByText('Issue 口令')).not.toBeInTheDocument();
    const taskCard = screen.getByRole('region', { name: 'Issue 任务信息' });
    expect(taskCard).toHaveClass('grid-cols-2');
    expect(taskCard).not.toHaveClass('grid-cols-4');
    const taskFacts = Array.from(taskCard.children);
    expect(within(taskFacts[0] as HTMLElement).getByText('创建人')).toBeInTheDocument();
    expect(within(taskFacts[1] as HTMLElement).getByText('目标')).toBeInTheDocument();
    expect(within(taskFacts[2] as HTMLElement).getByText('状态')).toBeInTheDocument();
    expect(within(taskFacts[3] as HTMLElement).getByText('经办人')).toBeInTheDocument();
    for (const fact of taskFacts) {
      expect(fact).toHaveClass('grid-cols-[3rem_minmax(0,1fr)]');
    }
    expect(within(taskCard).getByText('创建人')).toBeInTheDocument();
    expect(within(taskCard).getByText('Ethan')).toBeInTheDocument();
    expect(within(taskCard).getByText('待认领')).toBeInTheDocument();

    const attachmentsHeading = screen.getByRole('heading', { name: /附件/ });
    expect(attachmentsHeading.querySelector('svg')).not.toBeInTheDocument();
    expect(within(attachmentsHeading.parentElement!).getByRole('button', { name: '上传' })).toBeInTheDocument();

    const commentsHeading = screen.getByRole('heading', { name: /评论/ });
    expect(commentsHeading.querySelector('svg')).not.toBeInTheDocument();

    expect(screen.getByText('bold issue text').tagName).toBe('STRONG');
    const issueContent = screen.getByText('bold issue text').closest('.ai-message-content')?.parentElement;
    expect(issueContent).toHaveClass('px-3', 'max-sm:px-2');
    const commentHeading = screen.getByRole('heading', { name: 'Comment heading' });
    expect(commentHeading).toBeInTheDocument();
    expect(commentHeading.closest('.ai-message-content')?.parentElement).toHaveClass('px-3', 'max-sm:px-2');
    expect(screen.getByText('inline code')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-message-content')).toHaveLength(2);
  });

  it('uses the shared hierarchy label for a compact deep goal path', () => {
    const compactPath = '../MyAgents BUGFIX/Windows 系统兼容性优化';
    const deepGoal: SpaceGoal = {
      id: 'goal-deep',
      spaceId: 'space-1',
      parentGoalId: 'goal-parent',
      path: '/goal-root/goal-parent/goal-deep/',
      depth: 2,
      title: 'Windows 系统兼容性优化',
      context: 'Windows context',
      goalPathLabel: compactPath,
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:00:00.000Z',
    };
    const detailWithGoal: SpaceIssueDetail = {
      ...detail,
      issue: { ...detail.issue, goalId: deepGoal.id, goalPathLabel: compactPath },
      goalReference: {
        goalId: deepGoal.id,
        goalPath: deepGoal.path,
        goalPathLabel: compactPath,
        goalTitle: deepGoal.title,
        goalContext: deepGoal.context,
      },
    };

    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[deepGoal]}
        registeredAgents={[]}
        detailState={{ detail: detailWithGoal, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={actions()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const goalLabel = screen.getByTitle(compactPath);
    expect(within(goalLabel).getByText('../MyAgents BUGFIX')).toHaveClass('text-[var(--ink-muted)]/75');
    expect(within(goalLabel).getByText('Windows 系统兼容性优化')).toHaveClass('font-normal', 'text-[var(--ink)]');
  });

  it('saves edited issue title and body', async () => {
    const user = userEvent.setup();
    const mockActions = actions();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[]}
        registeredAgents={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={mockActions}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('Issue 标题'));
    await user.type(screen.getByLabelText('Issue 标题'), 'Renamed issue');
    await user.clear(screen.getByLabelText('Issue 正文'));
    await user.type(screen.getByLabelText('Issue 正文'), 'Edited body');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mockActions.updateIssue).toHaveBeenCalledWith({
      issueId: 'iss-1',
      title: 'Renamed issue',
      body: 'Edited body',
    });
  });

  it('navigates to adjacent issues from header arrow buttons', async () => {
    const user = userEvent.setup();
    const onNavigateIssue = vi.fn();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[]}
        registeredAgents={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={actions()}
        onClose={vi.fn()}
        onNavigateIssue={onNavigateIssue}
        previousIssueId="iss-0"
        nextIssueId="iss-2"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '上一条 Issue' }));
    await user.click(screen.getByRole('button', { name: '下一条 Issue' }));

    expect(onNavigateIssue).toHaveBeenNthCalledWith(1, 'iss-0');
    expect(onNavigateIssue).toHaveBeenNthCalledWith(2, 'iss-2');
  });

  it('keeps selected files in the comment draft and sends an attachment-only comment atomically', async () => {
    const user = userEvent.setup();
    const mockActions = actions();
    openFileDialog.mockResolvedValueOnce(['/workspace/evidence.pdf']);
    invokeTauri.mockResolvedValueOnce([{
      path: '/workspace/evidence.pdf',
      name: 'evidence.pdf',
      sizeBytes: 4096,
      mimeType: 'application/pdf',
    }]);
    const detailWithCommentAttachment: SpaceIssueDetail = {
      ...detail,
      comments: {
        ...detail.comments,
        items: [{
          ...detail.comments.items[0],
          attachments: [{
            id: 'att-comment-1',
            name: 'trace.log',
            sizeBytes: 4096,
            mimeType: 'text/plain',
            createdAt: '2026-06-30T11:31:00.000Z',
          }],
        }],
      },
    };
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[]}
        registeredAgents={[]}
        detailState={{ detail: detailWithCommentAttachment, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={mockActions}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const attachmentsHeading = screen.getByRole('heading', { name: /附件/ });
    expect(within(attachmentsHeading.parentElement!.parentElement!).queryByText('trace.log')).not.toBeInTheDocument();
    const commentAttachment = screen.getByText('trace.log');
    expect(commentAttachment).toBeInTheDocument();
    const commentAttachmentList = commentAttachment.closest('.divide-y');
    expect(commentAttachmentList).toHaveClass('border-b');
    expect(commentAttachmentList).not.toHaveClass('border-y');
    expect(commentAttachmentList?.parentElement).toHaveClass('px-3', 'max-sm:px-2');

    await user.click(screen.getByRole('button', { name: '上传附件' }));
    expect(await screen.findByText('evidence.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '发送评论' }));

    expect(mockActions.commentIssue).toHaveBeenCalledWith(
      'iss-1',
      '',
      ['/workspace/evidence.pdf'],
    );
    expect(screen.queryByText('evidence.pdf')).not.toBeInTheDocument();
  });

  it('uses custom composer tips and sends with the fixed modifier shortcut', async () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const user = userEvent.setup();
    const mockActions = actions();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        goals={[]}
        registeredAgents={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={mockActions}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const uploadButton = screen.getByRole('button', { name: '上传附件' });
    const sendButton = screen.getByRole('button', { name: '发送评论' });
    await user.hover(uploadButton.parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('上传附件');
    await user.unhover(uploadButton.parentElement!);

    await user.hover(sendButton.parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('发送评论');
    expect(screen.getByRole('tooltip')).toHaveTextContent('⌘ + Enter');
    expect(sendButton).not.toHaveAttribute('title');

    const composer = screen.getByPlaceholderText('说说你的想法');
    await user.type(composer, 'shortcut comment');
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(mockActions.commentIssue).toHaveBeenCalledWith('iss-1', 'shortcut comment', []);
    });
    platform.mockRestore();
  });

  it('does not clear the next Issue draft when an earlier comment request finishes', async () => {
    const user = userEvent.setup();
    let resolveComment!: () => void;
    const commentIssue = vi.fn(() => new Promise<void>(resolve => {
      resolveComment = resolve;
    }));
    const mockActions = { ...actions(), commentIssue } as SpaceActions;
    const props = {
      session,
      projects: [],
      goals: [],
      registeredAgents: [],
      actions: mockActions,
      onClose: vi.fn(),
      onChanged: vi.fn(),
    };
    const { rerender } = render(
      <IssueDetailDrawer
        {...props}
        issueId="iss-1"
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
      />,
    );
    const composer = screen.getByPlaceholderText('说说你的想法');
    await user.type(composer, 'old Issue comment');
    await user.click(screen.getByRole('button', { name: '发送评论' }));

    const nextDetail: SpaceIssueDetail = {
      ...detail,
      issue: { ...detail.issue, id: 'iss-2', number: 114, title: 'Next Issue' },
    };
    rerender(
      <IssueDetailDrawer
        {...props}
        issueId="iss-2"
        detailState={{ detail: nextDetail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
      />,
    );
    const nextComposer = screen.getByPlaceholderText('说说你的想法');
    await user.type(nextComposer, 'new Issue draft');
    resolveComment();

    await waitFor(() => expect(commentIssue).toHaveBeenCalledWith('iss-1', 'old Issue comment', []));
    expect(nextComposer).toHaveValue('new Issue draft');
  });

  it('exposes attachment actions to keyboard focus and closes the workspace menu before the drawer', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[
          { id: 'p-1', name: 'First', path: '/workspace/first' },
          { id: 'p-2', name: 'Second', path: '/workspace/second' },
        ] as never}
        goals={[]}
        registeredAgents={[]}
        detailState={{
          detail: {
            ...detail,
            attachments: [{
              id: 'att-1',
              name: 'report.pdf',
              sizeBytes: 4096,
              mimeType: 'application/pdf',
              createdAt: '2026-07-12T00:00:00.000Z',
            }],
          },
          isLoading: false,
          lastFetchedAt: Date.now(),
          error: null,
        }}
        actions={actions()}
        onClose={onClose}
        onChanged={vi.fn()}
      />,
    );

    const download = screen.getByRole('button', { name: '下载附件 report.pdf' });
    expect(download).toHaveClass('focus-visible:ring-2');
    expect(download).toHaveAttribute('aria-haspopup', 'menu');
    download.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: '下载到 Agent 工作区' });
    expect(within(menu).getByRole('menuitem', { name: 'First' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: '下载到 Agent 工作区' })).not.toBeInTheDocument();
    await waitFor(() => expect(download).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
  });
});
