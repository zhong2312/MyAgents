import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { ContentBlock, ToolUseSimple } from '@/types/chat';
import type { FilePatchDisplayDescriptor } from '../../shared/toolDisplay/filePatch';

const fileActionMocks = vi.hoisted(() => ({
  openFileTarget: vi.fn(),
  openFileTargetMenu: vi.fn(),
}));

vi.mock('@/context/FileActionContext', () => ({
  useFileAction: () => ({
    workspacePath: '/workspace',
    openFileTarget: fileActionMocks.openFileTarget,
    openFileTargetMenu: fileActionMocks.openFileTargetMenu,
  }),
}));

import { TurnFileEditSummary } from './TurnFileEditSummary';

function contentWithChanges(
  changes: FilePatchDisplayDescriptor['changes'],
): ContentBlock[] {
  const display: FilePatchDisplayDescriptor = {
    kind: 'file_patch',
    version: 1,
    source: 'codex',
    summary: {
      files: changes.length,
      added: changes.reduce((total, item) => total + item.added, 0),
      removed: changes.reduce((total, item) => total + item.removed, 0),
    },
    changes,
  };
  return [{
    type: 'tool_use',
    tool: {
      id: 'file-change',
      name: 'fileChange',
      input: {},
      result: 'completed',
      display,
    } as ToolUseSimple,
  }];
}

function change(
  path: string,
  kind: string,
  added: number,
  removed: number,
  movePath?: string,
): FilePatchDisplayDescriptor['changes'][number] {
  return {
    path,
    kind,
    added,
    removed,
    ...(movePath ? { movePath } : {}),
    view: { kind: 'unified-diff' },
  };
}

describe('TurnFileEditSummary', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fileActionMocks.openFileTargetMenu.mockImplementation((
      _x: number,
      _y: number,
      _target: unknown,
      options?: { onOpen?: () => void },
    ) => {
      options?.onOpen?.();
      return vi.fn();
    });
    await i18n.changeLanguage('zh-CN');
  });

  it('renders a compact capsule and opens the full file list above the toolbar', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([
          change('src/a.ts', 'update', 2, 1),
          change('src/new.ts', 'add', 8, 0),
        ])}
      />,
    );

    const trigger = screen.getByRole('button', { name: /本轮编辑 2 个文件/ });
    expect(trigger).toHaveTextContent('+10');
    expect(trigger).toHaveTextContent('−1');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: '本轮文件编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已修改: src/a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已新增: src/new.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多操作: a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多操作: new.ts' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '本轮文件编辑' })).not.toHaveTextContent('src/');
  });

  it('closes before delegating a file row to the existing preview action', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));
    fireEvent.click(screen.getByRole('button', { name: '已修改: src/a.ts' }));

    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
    expect(fileActionMocks.openFileTarget).toHaveBeenCalledWith(
      { scope: 'workspace', path: 'src/a.ts' },
      { displayPath: 'src/a.ts' },
    );
  });

  it('keeps deleted files visible but non-clickable', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/gone.ts', 'delete', 0, 7)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));

    expect(screen.getByRole('button', { name: '已删除: src/gone.ts' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '更多操作: gone.ts' })).toBeDisabled();
  });

  it('keeps same-name moves on one line without showing either parent path', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'move', 0, 0, 'tests/a.ts')])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));

    const row = screen.getByRole('button', { name: '已重命名: src/a.ts → tests/a.ts' });
    expect(row).toHaveTextContent('a.ts');
    expect(row).not.toHaveTextContent('→');
    expect(screen.getByRole('dialog', { name: '本轮文件编辑' })).not.toHaveTextContent(/src|tests/);
  });

  it('opens the shared file menu from the fixed More button', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));
    const moreButton = screen.getByRole('button', { name: '更多操作: a.ts' });
    vi.spyOn(moreButton, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 40,
      width: 32,
      height: 32,
      top: 40,
      right: 132,
      bottom: 72,
      left: 100,
      toJSON: () => ({}),
    });

    fireEvent.click(moreButton);

    expect(fileActionMocks.openFileTarget).not.toHaveBeenCalled();
    expect(fileActionMocks.openFileTargetMenu).toHaveBeenCalledWith(
      132,
      76,
      { scope: 'workspace', path: 'src/a.ts' },
      expect.objectContaining({
        displayPath: 'src/a.ts',
        zIndex: 270,
        onOpen: expect.any(Function),
        onClose: expect.any(Function),
      }),
    );
  });

  it('opens the same shared file menu from a row right-click', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));

    fireEvent.contextMenu(screen.getByRole('button', { name: '已修改: src/a.ts' }), {
      clientX: 48,
      clientY: 96,
    });

    expect(fileActionMocks.openFileTarget).not.toHaveBeenCalled();
    expect(fileActionMocks.openFileTargetMenu).toHaveBeenCalledWith(
      48,
      96,
      { scope: 'workspace', path: 'src/a.ts' },
      expect.objectContaining({
        displayPath: 'src/a.ts',
        zIndex: 270,
      }),
    );
  });

  it('keeps the parent popover open while the nested file menu owns Escape', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作: a.ts' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '本轮文件编辑' })).toBeInTheDocument();

    const menuOptions = fileActionMocks.openFileTargetMenu.mock.calls[0]?.[3] as {
      onClose?: () => void;
    };
    act(() => menuOptions.onClose?.());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
  });

  it('cancels a pending file menu intent when Escape closes the parent', () => {
    const cancelPendingMenu = vi.fn();
    fileActionMocks.openFileTargetMenu.mockReturnValueOnce(cancelPendingMenu);
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作: a.ts' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(cancelPendingMenu).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
  });

  it('restores trigger focus when Escape dismisses the popover', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    const trigger = screen.getByRole('button', { name: /本轮编辑 1 个文件/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
