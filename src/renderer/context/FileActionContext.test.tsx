import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPaths: vi.fn(),
  checkLocalPaths: vi.fn(),
  readPreview: vi.fn(),
  readLocalPreview: vi.fn(),
  downloadFile: vi.fn(),
  downloadLocalFile: vi.fn(),
}));

vi.mock('@/components/Toast', () => ({
  useToastOptional: () => null,
}));

vi.mock('@/components/ContextMenu', () => ({
  default: ({
    items,
    onClose,
    zIndex,
  }: {
    items: Array<{ label: string; onClick: () => void; disabled?: boolean }>;
    onClose: () => void;
    zIndex?: number;
  }) => (
    <div data-testid="file-context-menu" data-z-index={zIndex}>
      {items.map((item) => (
        <button key={item.label} type="button" disabled={item.disabled} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
      <button type="button" data-testid="dismiss-file-context-menu" onClick={onClose}>
        dismiss
      </button>
    </div>
  ),
}));

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: (workspacePath: string | null) => ({
    isAvailable: true,
    checkPaths: (args: { paths: string[] }) => mocks.checkPaths(workspacePath, args),
    checkLocalPaths: (args: { paths: string[]; workspace: string | null }) => (
      mocks.checkLocalPaths(workspacePath, args)
    ),
    openWithDefault: vi.fn(),
    openPathWithDefault: vi.fn(),
    openPathExternal: vi.fn(),
    openInFinder: vi.fn(),
    readPreview: (args: { path: string }) => mocks.readPreview(workspacePath, args),
    readLocalPreview: (args: { fullPath: string; workspace: string | null }) => mocks.readLocalPreview(workspacePath, args),
    downloadFile: (args: { path: string }) => mocks.downloadFile(workspacePath, args),
    downloadLocalFile: (args: { fullPath: string; workspace: string | null }) => mocks.downloadLocalFile(workspacePath, args),
  }),
}));

import {
  FileActionProvider,
  useFileAction,
  useFileTargetInfo,
  type FileActionMenuOptions,
} from './FileActionContext';
import type { FileActionTarget } from '@/utils/workspaceFileLinks';

function Probe({ target, testId = 'state' }: { target: FileActionTarget; testId?: string }) {
  const info = useFileTargetInfo(target);
  return (
    <output data-testid={testId}>
      {info ? (info.exists ? 'available' : 'unavailable') : 'pending'}
    </output>
  );
}

function MenuProbe({
  target,
  options,
  testId = 'open-menu',
  onCancel,
}: {
  target: FileActionTarget;
  options?: FileActionMenuOptions;
  testId?: string;
  onCancel?: (cancel: () => void) => void;
}) {
  const fileAction = useFileAction();
  const info = useFileTargetInfo(target);
  return (
    <button
      data-testid={testId}
      type="button"
      disabled={!info?.exists}
      onClick={() => {
        const cancel = fileAction?.openFileTargetMenu(10, 20, target, options);
        if (cancel) onCancel?.(cancel);
      }}
    >
      open
    </button>
  );
}

function OpenProbe({ target, label }: { target: FileActionTarget; label: string }) {
  const fileAction = useFileAction();
  return (
    <button type="button" onClick={() => fileAction?.openFileTarget(target)}>
      {label}
    </button>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('FileActionProvider verified target cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.checkPaths.mockResolvedValue({ results: {} });
    mocks.checkLocalPaths.mockResolvedValue({ results: {} });
    mocks.readPreview.mockResolvedValue({ name: 'note.md', content: 'content', size: 7 });
    mocks.readLocalPreview.mockResolvedValue({ name: 'note.md', content: 'content', size: 7 });
    mocks.downloadFile.mockResolvedValue({ name: 'image.png', mimeType: 'image/png', data: '' });
    mocks.downloadLocalFile.mockResolvedValue({ name: 'image.png', mimeType: 'image/png', data: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards a late response from the previous workspace generation', async () => {
    const slowA = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    mocks.checkPaths.mockImplementation((workspace: string) => {
      if (workspace === '/workspace-a') return slowA.promise;
      return Promise.resolve({ results: { 'docs/a.md': { exists: false, type: 'file' } } });
    });

    const view = render(
      <FileActionProvider workspacePath="/workspace-a">
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalledWith(
      '/workspace-a',
      { paths: ['docs/a.md'] },
    ));

    view.rerender(
      <FileActionProvider workspacePath="/workspace-b">
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('unavailable'));

    await act(async () => {
      slowA.resolve({ results: { 'docs/a.md': { exists: true, type: 'file' } } });
      await slowA.promise;
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
  });

  it('expires and rechecks local results after the 30 second lease', async () => {
    vi.useFakeTimers();
    mocks.checkLocalPaths
      .mockResolvedValueOnce({ results: { '/Users/me/note.md': { exists: true, type: 'file' } } })
      .mockResolvedValueOnce({ results: { '/Users/me/note.md': { exists: false, type: 'file' } } });

    render(
      <FileActionProvider workspacePath="/workspace">
        <Probe target={{ scope: 'local', path: '/Users/me/note.md' }} />
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('available');

    await act(async () => { await vi.advanceTimersByTimeAsync(29_990); });
    expect(screen.getByTestId('state')).toHaveTextContent('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
    expect(mocks.checkLocalPaths).toHaveBeenCalledTimes(2);
  });

  it('splits mounted candidates at the Rust 200-path batch cap', async () => {
    vi.useFakeTimers();
    mocks.checkPaths.mockResolvedValue({ results: {} });
    const targets = Array.from({ length: 201 }, (_, index) => `docs/${index}.md`);

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path) => (
          <Probe key={path} testId={`state-${path}`} target={{ scope: 'workspace', path }} />
        ))}
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).toHaveBeenCalledTimes(2);
    expect(mocks.checkPaths.mock.calls.map(([, args]) => args.paths.length)).toEqual([200, 1]);
  });

  it('ignores response keys that were not requested by the active batch', async () => {
    vi.useFakeTimers();
    const firstResponse = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    mocks.checkPaths
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue({ results: { 'docs/extra.md': { exists: false, type: 'file' } } });

    const view = render(
      <FileActionProvider workspacePath="/workspace">
        <Probe key="requested" target={{ scope: 'workspace', path: 'docs/requested.md' }} />
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });

    view.rerender(
      <FileActionProvider workspacePath="/workspace">
        <Probe key="requested" target={{ scope: 'workspace', path: 'docs/requested.md' }} />
        <Probe key="extra" testId="extra-state" target={{ scope: 'workspace', path: 'docs/extra.md' }} />
      </FileActionProvider>,
    );

    await act(async () => {
      firstResponse.resolve({
        results: {
          'docs/requested.md': { exists: false, type: 'file' },
          'docs/extra.md': { exists: true, type: 'file' },
        },
      });
      await firstResponse.promise;
    });
    expect(screen.getByTestId('extra-state')).toHaveTextContent('pending');
  });

  it('does not accept a later chunk key from an earlier 200-path response', async () => {
    vi.useFakeTimers();
    const stalledTail = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    const targets = Array.from({ length: 201 }, (_, index) => `docs/chunk-${index}.md`);
    mocks.checkPaths.mockImplementation((_: string, args: { paths: string[] }) => (
      args.paths.length === 200
        ? Promise.resolve({ results: { [targets[200]]: { exists: true, type: 'file' as const } } })
        : stalledTail.promise
    ));

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path, index) => (
          <Probe key={path} testId={`chunk-${index}`} target={{ scope: 'workspace', path }} />
        ))}
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });

    expect(screen.getByTestId('chunk-200')).toHaveTextContent('pending');
    stalledTail.resolve({ results: { [targets[200]]: { exists: false, type: 'file' } } });
    await stalledTail.promise;
  });

  it('cancels queued work when the last mounted consumer leaves before flush', async () => {
    vi.useFakeTimers();
    const view = render(
      <FileActionProvider workspacePath="/workspace">
        <Probe target={{ scope: 'workspace', path: 'docs/gone.md' }} />
      </FileActionProvider>,
    );

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).not.toHaveBeenCalled();
  });

  it('deduplicates multiple mounted consumers of the same target', async () => {
    vi.useFakeTimers();
    mocks.checkPaths.mockResolvedValue({
      results: { 'docs/shared.md': { exists: true, type: 'file' } },
    });
    render(
      <FileActionProvider workspacePath="/workspace">
        <Probe testId="state-a" target={{ scope: 'workspace', path: 'docs/shared.md' }} />
        <Probe testId="state-b" target={{ scope: 'workspace', path: 'docs/shared.md' }} />
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).toHaveBeenCalledTimes(1);
    expect(mocks.checkPaths).toHaveBeenCalledWith('/workspace', { paths: ['docs/shared.md'] });
    expect(screen.getByTestId('state-a')).toHaveTextContent('available');
    expect(screen.getByTestId('state-b')).toHaveTextContent('available');
  });

  it('invalidates the same workspace on a controlled refresh generation', async () => {
    vi.useFakeTimers();
    mocks.checkPaths
      .mockResolvedValueOnce({ results: { 'docs/a.md': { exists: true, type: 'file' } } })
      .mockResolvedValueOnce({ results: { 'docs/a.md': { exists: false, type: 'file' } } });
    const view = render(
      <FileActionProvider workspacePath="/workspace" refreshTrigger={0}>
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('available');

    view.rerender(
      <FileActionProvider workspacePath="/workspace" refreshTrigger={1}>
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
  });

  it('closes an authorized file menu when the workspace identity changes', async () => {
    mocks.checkPaths.mockImplementation((workspace: string, args: { paths: string[] }) => ({
      results: Object.fromEntries(args.paths.map((path) => [
        path,
        { exists: workspace === '/workspace-a', type: 'file' as const },
      ])),
    }));
    const target: FileActionTarget = { scope: 'workspace', path: 'docs/a.md' };
    const view = render(
      <FileActionProvider workspacePath="/workspace-a">
        <MenuProbe target={target} />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());

    view.rerender(
      <FileActionProvider workspacePath="/workspace-b">
        <MenuProbe target={target} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('file-context-menu')).not.toBeInTheDocument());
  });

  it('forwards nested menu presentation and lifecycle without changing file actions', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    mocks.checkPaths.mockResolvedValue({
      results: { 'docs/a.md': { exists: true, type: 'file' } },
    });

    render(
      <FileActionProvider workspacePath="/workspace">
        <MenuProbe
          target={{ scope: 'workspace', path: 'docs/a.md' }}
          options={{ zIndex: 270, onOpen, onClose }}
        />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());

    expect(screen.getByTestId('file-context-menu')).toHaveAttribute('data-z-index', '270');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dismiss-file-context-menu'));
    expect(screen.queryByTestId('file-context-menu')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels delayed revalidation so a dismissed parent cannot reopen a ghost menu', async () => {
    const delayedRevalidation = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    mocks.checkPaths
      .mockResolvedValueOnce({
        results: { 'docs/a.md': { exists: true, type: 'file' } },
      })
      .mockReturnValueOnce(delayedRevalidation.promise);

    render(
      <FileActionProvider workspacePath="/workspace">
        <MenuProbe
          target={{ scope: 'workspace', path: 'docs/a.md' }}
          options={{ onOpen }}
          onCancel={onCancel}
        />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu'));
    const cancel = onCancel.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(cancel).toBeTypeOf('function');
    cancel?.();

    await act(async () => {
      delayedRevalidation.resolve({
        results: { 'docs/a.md': { exists: true, type: 'file' } },
      });
      await delayedRevalidation.promise;
    });

    expect(screen.queryByTestId('file-context-menu')).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('closes the previous menu before a replacement target finishes revalidation', async () => {
    const delayedB = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    const onOpenA = vi.fn();
    const onCloseA = vi.fn();
    const onOpenB = vi.fn();
    mocks.checkPaths
      .mockResolvedValueOnce({
        results: {
          'docs/a.md': { exists: true, type: 'file' },
          'docs/b.md': { exists: true, type: 'file' },
        },
      })
      .mockResolvedValueOnce({
        results: { 'docs/a.md': { exists: true, type: 'file' } },
      })
      .mockReturnValueOnce(delayedB.promise);

    render(
      <FileActionProvider workspacePath="/workspace">
        <MenuProbe
          testId="open-menu-a"
          target={{ scope: 'workspace', path: 'docs/a.md' }}
          options={{ onOpen: onOpenA, onClose: onCloseA }}
        />
        <MenuProbe
          testId="open-menu-b"
          target={{ scope: 'workspace', path: 'docs/b.md' }}
          options={{ onOpen: onOpenB }}
        />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu-a')).not.toBeDisabled());
    await waitFor(() => expect(screen.getByTestId('open-menu-b')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu-a'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());
    expect(onOpenA).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('open-menu-b'));
    expect(screen.queryByTestId('file-context-menu')).not.toBeInTheDocument();
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(onOpenB).not.toHaveBeenCalled();

    await act(async () => {
      delayedB.resolve({
        results: { 'docs/b.md': { exists: true, type: 'file' } },
      });
      await delayedB.promise;
    });
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());
    expect(onOpenB).toHaveBeenCalledTimes(1);
  });

  it('does not renew an early local chunk while a later 200-path chunk is stalled', async () => {
    vi.useFakeTimers();
    const stalledTail = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    let largeChunkCall = 0;
    mocks.checkLocalPaths.mockImplementation((_: string, args: { paths: string[] }) => {
      if (args.paths.length === 1) return stalledTail.promise;
      largeChunkCall += 1;
      return Promise.resolve({
        results: Object.fromEntries(args.paths.map((path) => [
          path,
          { exists: largeChunkCall === 1, type: 'file' as const },
        ])),
      });
    });
    const targets = Array.from({ length: 201 }, (_, index) => `/Users/me/${index}.md`);

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path, index) => (
          <Probe key={path} testId={`local-${index}`} target={{ scope: 'local', path }} />
        ))}
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('local-0')).toHaveTextContent('available');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_060); });
    expect(screen.getByTestId('local-0')).toHaveTextContent('unavailable');
    expect(largeChunkCall).toBe(2);

    stalledTail.resolve({ results: { [targets[200]]: { exists: false, type: 'file' } } });
    await stalledTail.promise;
  });

  it('composes workspace preview with tree reveal after action-time revalidation', async () => {
    mocks.checkPaths.mockResolvedValue({
      results: { 'docs/note.md': { exists: true, type: 'file' } },
    });
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'workspace', path: 'docs/note.md' }} label="open note" />
      </FileActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open note' }));

    await waitFor(() => expect(onRevealInTree).toHaveBeenCalledWith('docs/note.md'));
    await waitFor(() => expect(onFilePreviewExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'docs/note.md', content: 'content' }),
    ));
  });

  it('applies the same reveal composition to the Chat preview menu action', async () => {
    mocks.checkPaths.mockResolvedValue({
      results: { 'docs/menu.md': { exists: true, type: 'file' } },
    });
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <MenuProbe target={{ scope: 'workspace', path: 'docs/menu.md' }} />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Preview|预览/ }));

    await waitFor(() => expect(onRevealInTree).toHaveBeenCalledWith('docs/menu.md'));
    await waitFor(() => expect(onFilePreviewExternal).toHaveBeenCalled());
  });

  it('lets a later menu preview supersede an earlier main-click preflight', async () => {
    const firstCheck = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    mocks.checkPaths.mockImplementation((_: string, args: { paths: string[] }) => (
      args.paths[0] === 'a.md'
        ? firstCheck.promise
        : Promise.resolve({ results: { 'b.md': { exists: true, type: 'file' as const } } })
    ));
    mocks.readPreview.mockImplementation((_: string, args: { path: string }) => Promise.resolve({
      name: args.path,
      content: args.path,
      size: args.path.length,
    }));
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'workspace', path: 'a.md' }} label="open a" />
        <MenuProbe target={{ scope: 'workspace', path: 'b.md' }} />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'open a' }));
    fireEvent.click(screen.getByTestId('open-menu'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Preview|预览/ }));
    await waitFor(() => expect(onFilePreviewExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'b.md' }),
    ));

    await act(async () => {
      firstCheck.resolve({ results: { 'a.md': { exists: true, type: 'file' } } });
      await firstCheck.promise;
    });

    expect(onFilePreviewExternal).toHaveBeenCalledTimes(1);
    expect(onRevealInTree).toHaveBeenCalledTimes(1);
    expect(onRevealInTree).toHaveBeenCalledWith('b.md');
  });

  it('does not reveal local previews in the workspace tree', async () => {
    mocks.checkLocalPaths.mockResolvedValue({
      results: { '/Users/me/note.md': { exists: true, type: 'file' } },
    });
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'local', path: '/Users/me/note.md' }} label="open local" />
      </FileActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open local' }));

    await waitFor(() => expect(onFilePreviewExternal).toHaveBeenCalled());
    expect(onRevealInTree).not.toHaveBeenCalled();
  });

  it('lets tree reveal succeed independently when internal preview is unsupported', async () => {
    mocks.checkPaths.mockResolvedValue({
      results: { 'artifacts/archive.zip': { exists: true, type: 'file' } },
    });
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'workspace', path: 'artifacts/archive.zip' }} label="open archive" />
      </FileActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open archive' }));

    await waitFor(() => expect(onRevealInTree).toHaveBeenCalledWith('artifacts/archive.zip'));
    expect(onFilePreviewExternal).not.toHaveBeenCalled();
  });

  it('keeps the latest async preview when workspace files are clicked quickly', async () => {
    const first = deferred<{ name: string; content: string; size: number }>();
    const second = deferred<{ name: string; content: string; size: number }>();
    mocks.checkPaths.mockImplementation((_: string, args: { paths: string[] }) => ({
      results: { [args.paths[0]]: { exists: true, type: 'file' as const } },
    }));
    mocks.readPreview.mockImplementation((_: string, args: { path: string }) => (
      args.path === 'a.md' ? first.promise : second.promise
    ));
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'workspace', path: 'a.md' }} label="open a" />
        <OpenProbe target={{ scope: 'workspace', path: 'b.md' }} label="open b" />
      </FileActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open a' }));
    await waitFor(() => expect(mocks.readPreview).toHaveBeenCalledWith('/workspace', { path: 'a.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    await waitFor(() => expect(mocks.readPreview).toHaveBeenCalledWith('/workspace', { path: 'b.md' }));

    await act(async () => {
      second.resolve({ name: 'b.md', content: 'second', size: 6 });
      await second.promise;
    });
    await act(async () => {
      first.resolve({ name: 'a.md', content: 'first', size: 5 });
      await first.promise;
    });

    expect(onFilePreviewExternal).toHaveBeenCalledTimes(1);
    expect(onFilePreviewExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'b.md', content: 'second' }),
    );
    expect(onRevealInTree.mock.calls.map(([path]) => path)).toEqual(['a.md', 'b.md']);
  });

  it('keeps the latest file intent when cross-target revalidation resolves out of order', async () => {
    const firstCheck = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    const secondCheck = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    mocks.checkPaths.mockImplementation((_: string, args: { paths: string[] }) => (
      args.paths[0] === 'a.md' ? firstCheck.promise : secondCheck.promise
    ));
    mocks.readPreview.mockImplementation((_: string, args: { path: string }) => Promise.resolve({
      name: args.path,
      content: args.path,
      size: args.path.length,
    }));
    const onRevealInTree = vi.fn();
    const onFilePreviewExternal = vi.fn();
    render(
      <FileActionProvider
        workspacePath="/workspace"
        onRevealInTree={onRevealInTree}
        onFilePreviewExternal={onFilePreviewExternal}
      >
        <OpenProbe target={{ scope: 'workspace', path: 'a.md' }} label="open a" />
        <OpenProbe target={{ scope: 'workspace', path: 'b.md' }} label="open b" />
      </FileActionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open a' }));
    fireEvent.click(screen.getByRole('button', { name: 'open b' }));

    await act(async () => {
      secondCheck.resolve({ results: { 'b.md': { exists: true, type: 'file' } } });
      await secondCheck.promise;
    });
    await waitFor(() => expect(onFilePreviewExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'b.md' }),
    ));

    await act(async () => {
      firstCheck.resolve({ results: { 'a.md': { exists: true, type: 'file' } } });
      await firstCheck.promise;
    });

    expect(onFilePreviewExternal).toHaveBeenCalledTimes(1);
    expect(onRevealInTree).toHaveBeenCalledTimes(1);
    expect(onRevealInTree).toHaveBeenCalledWith('b.md');
    expect(mocks.readPreview).not.toHaveBeenCalledWith('/workspace', { path: 'a.md' });
  });
});
