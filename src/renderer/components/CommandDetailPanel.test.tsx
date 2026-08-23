import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from './Toast';
import CommandDetailPanel from './CommandDetailPanel';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  post: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: mocks.get,
  apiPutJson: mocks.put,
  apiDelete: mocks.remove,
  apiPostJson: mocks.post,
}));

vi.mock('@/context/TabContext', () => ({
  useTabApiOptional: () => undefined,
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ revealInFinder: mocks.reveal }),
}));

vi.mock('@/components/Markdown', () => ({ default: () => <div /> }));
vi.mock('@/components/MonacoEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="command body" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

describe('CommandDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({
      success: true,
      command: {
        name: '旧展示名',
        fileName: 'stable-command',
        path: '/tmp/.myagents/commands/stable-command.md',
        frontmatter: { name: '旧展示名', description: 'description' },
        body: 'body',
      },
    });
    mocks.put.mockResolvedValue({ success: true });
  });

  it('updates display metadata without implicitly renaming the invocation source file', async () => {
    render(
      <ToastProvider>
        <CommandDetailPanel
          name="stable-command"
          scope="user"
          onBack={vi.fn()}
          onSaved={vi.fn()}
          onDeleted={vi.fn()}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getAllByText('旧展示名')).not.toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: /编辑|edit/i }));
    fireEvent.change(screen.getByDisplayValue('旧展示名'), { target: { value: '新 展示名' } });
    fireEvent.click(screen.getByRole('button', { name: /保存|save/i }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledOnce());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/command-item/stable-command',
      expect.not.objectContaining({ newFileName: expect.anything() }),
    );
    expect(mocks.put.mock.calls[0][1]).toMatchObject({
      scope: 'user',
      frontmatter: { name: '新 展示名', description: 'description' },
      body: 'body',
    });
  });
});
