import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPaths: vi.fn(),
  checkLocalPaths: vi.fn(),
  openImagePreview: vi.fn(),
  openWithDefault: vi.fn(),
  openPathWithDefault: vi.fn(),
  openPathExternal: vi.fn(),
  openInFinder: vi.fn(),
  readPreview: vi.fn(),
  readLocalPreview: vi.fn(),
  onInsertReference: vi.fn(),
}));

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: mocks.openImagePreview }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    checkPaths: mocks.checkPaths,
    checkLocalPaths: mocks.checkLocalPaths,
    openWithDefault: mocks.openWithDefault,
    openPathWithDefault: mocks.openPathWithDefault,
    openPathExternal: mocks.openPathExternal,
    openInFinder: mocks.openInFinder,
    readPreview: mocks.readPreview,
    readLocalPreview: mocks.readLocalPreview,
    readFileAsBlobUrl: vi.fn(),
    readLocalFileAsBlobUrl: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';

import EditTool from './EditTool';
import { FilePath } from './utils';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';
// File-tool cards carry ABSOLUTE file_path values (what the chip displays),
// but the existence check + menu actions must run against the WORKSPACE-RELATIVE
// form — the backend resolver rejects absolute paths. These pairs lock that
// in: the chip shows `*_PATH`, the backend is hit with `REL_*`.
const REL_FILE = 'src/renderer/components/tools/utils.tsx';
const FILE_PATH = `${WORKSPACE}/${REL_FILE}`;
const REL_DIR = 'src/renderer/components/tools';
const DIR_PATH = `${WORKSPACE}/${REL_DIR}`;
const REL_MISSING = 'src/renderer/components/tools/gone.ts';
const MISSING_PATH = `${WORKSPACE}/${REL_MISSING}`;

function renderFilePath(path: string) {
  render(
    <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
      <FilePath path={path} />
    </FileActionProvider>,
  );
}

describe('FilePath tool chip — clickable file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPaths.mockResolvedValue({ results: {} });
    mocks.checkLocalPaths.mockResolvedValue({ results: {} });
    mocks.openWithDefault.mockResolvedValue(undefined);
    mocks.openPathWithDefault.mockResolvedValue(undefined);
    mocks.openPathExternal.mockResolvedValue(undefined);
    mocks.openInFinder.mockResolvedValue(undefined);
  });

  // A file tool can arrive with NO path — a partial/streaming tool input
  // where file_path hasn't parsed yet, or a RESTORED old-session tool block whose
  // input lacks it (parsedInput comes from parsePartialJson, file_path optional).
  // Before the fix, FilePath fed undefined into toWorkspaceRelativePath's
  // `path.trim()` → uncaught render error → the root AppErrorBoundary replaced the
  // ENTIRE app with "界面渲染出错: Cannot read properties of undefined (reading 'trim')".
  it('renders nothing instead of crashing the whole app when the path is missing', () => {
    mocks.checkPaths.mockResolvedValue({ results: {} });
    for (const missing of [undefined, null, '', '   '] as const) {
      let container: HTMLElement | undefined;
      expect(() => {
        container = render(
          <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
            <FilePath path={missing} />
          </FileActionProvider>,
        ).container;
      }).not.toThrow();
      // Not just "didn't throw" — the chip renders nothing at all.
      expect(container?.querySelector('code')).toBeNull();
      expect(container?.textContent).toBe('');
    }
  });

  it('renders a real file as an interactive chip and opens the action menu on click', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL_FILE]: { exists: true, type: 'file' } } });
    renderFilePath(FILE_PATH);

    // First paint is a plain chip; becomes interactive after the batched existence check resolves.
    const chip = await waitFor(() => {
      const el = screen.getByText(FILE_PATH);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    // The chip still DISPLAYS the absolute path (what the tool card emits)…
    expect(chip.getAttribute('title')).toBe(`文件: ${FILE_PATH}`);
    // …but the backend existence check ran against the workspace-relative form.
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL_FILE] });

    fireEvent.click(chip);

    // File menu surfaces the same actions as inline paths in AI text.
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
    expect(screen.getByText('打开所在文件夹')).toBeInTheDocument();

    // 引用 inserts the relative path, matching inline-path @-mention behavior.
    fireEvent.click(screen.getByText('引用'));
    expect(mocks.onInsertReference).toHaveBeenCalledWith([REL_FILE]);
  });

  it('integrates exactly one More action and delegates its items to the existing file menu', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL_FILE]: { exists: true, type: 'file' } } });
    render(
      <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
        <EditTool tool={{
          id: 'call-edit-toolbar',
          name: 'Edit',
          input: {
            file_path: FILE_PATH,
            changes: [{
              path: FILE_PATH,
              kind: { type: 'update' },
              diff: '@@ -1 +1 @@\n-old\n+new',
            }],
          },
          streamIndex: 0,
        }} />
      </FileActionProvider>,
    );

    const more = await screen.findByRole('button', { name: '更多文件操作' });
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL_FILE] });
    const toolbar = more.closest('header');
    expect(toolbar).not.toBeNull();
    expect(within(toolbar as HTMLElement).getAllByRole('button')).toEqual([more]);
    expect(screen.queryByText('复制')).not.toBeInTheDocument();
    expect(screen.queryByText('打开')).not.toBeInTheDocument();

    fireEvent.click(more);
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('复制')).toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
  });

  it('keeps a declined move action attached to the still-existing source file', async () => {
    const source = `${WORKSPACE}/src/old.ts`;
    mocks.checkPaths.mockResolvedValue({ results: { 'src/old.ts': { exists: true, type: 'file' } } });
    render(
      <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
        <EditTool tool={{
          id: 'call-declined-move-toolbar',
          name: 'Edit',
          input: {
            file_path: source,
            changes: [{
              path: source,
              kind: { type: 'move', move_path: `${WORKSPACE}/src/new.ts` },
              diff: '@@ -1 +1 @@\n-old\n+new',
            }],
          },
          streamIndex: 0,
          result: '[declined]',
          resultMeta: { status: 'declined' },
          isError: true,
        }} />
      </FileActionProvider>,
    );

    await screen.findByRole('button', { name: '更多文件操作' });
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: ['src/old.ts'] });
    expect(mocks.checkPaths).not.toHaveBeenCalledWith({ paths: ['src/new.ts'] });
  });

  // Regression for the shipped-but-dead 0.2.29 feature: file-tool cards carry
  // ABSOLUTE file_path values, and the Rust resolver rejects absolute paths, so
  // the chip silently stayed plain. The earlier test mocked checkPaths keyed by
  // the absolute path and never caught it. This pins the normalization.
  it('normalizes an in-workspace absolute path to relative before the existence check', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL_FILE]: { exists: true, type: 'file' } } });
    renderFilePath(FILE_PATH);

    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalled());
    // The absolute path is NEVER sent to the backend — only the relative form is.
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL_FILE] });
    expect(mocks.checkPaths).not.toHaveBeenCalledWith({ paths: [FILE_PATH] });
  });

  it('leaves an absolute path OUTSIDE the workspace as a plain chip', async () => {
    const OUTSIDE = '/etc/passwd';
    mocks.checkLocalPaths.mockResolvedValue({ results: { [OUTSIDE]: { exists: false, type: 'file' } } });
    renderFilePath(OUTSIDE);

    await waitFor(() => expect(mocks.checkLocalPaths).toHaveBeenCalled());
    // Can't be made workspace-relative → local checker rejects it → stays plain.
    expect(mocks.checkLocalPaths).toHaveBeenCalledWith({ paths: [OUTSIDE], workspace: WORKSPACE });
    const chip = screen.getByText(OUTSIDE);
    expect(chip).not.toHaveClass('cursor-pointer');
    fireEvent.click(chip);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
  });

  it('keeps a non-existent path as a plain chip with no menu', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL_MISSING]: { exists: false, type: 'file' } } });
    renderFilePath(MISSING_PATH);

    // Wait for the existence check to flush, then assert it stayed plain.
    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalled());
    const chip = screen.getByText(MISSING_PATH);
    expect(chip).not.toHaveClass('cursor-pointer');

    fireEvent.click(chip);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
    expect(screen.queryByText('打开')).not.toBeInTheDocument();
  });

  it('omits 预览 for directories and labels them as folders', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL_DIR]: { exists: true, type: 'dir' } } });
    renderFilePath(DIR_PATH);

    const chip = await waitFor(() => {
      const el = screen.getByText(DIR_PATH);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(chip.getAttribute('title')).toBe(`文件夹: ${DIR_PATH}`);

    fireEvent.click(chip);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();
    expect(screen.getByText('打开所在文件夹')).toBeInTheDocument();
  });
});
