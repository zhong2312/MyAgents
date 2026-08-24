import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  onOpenMyAgentsPreview: vi.fn(),
  onFilePreviewExternal: vi.fn(),
  onRevealInTree: vi.fn(),
  writeText: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  openUrl: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
  isExternalUrl: (url: string) => /^https?:\/\//i.test(url),
}));

vi.mock('@/components/Toast', () => ({
  useToastOptional: () => ({
    info: mocks.toastInfo,
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  }),
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
    downloadFile: vi.fn(),
    downloadLocalFile: vi.fn(),
    readFileAsBlobUrl: vi.fn(),
    readLocalFileAsBlobUrl: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';
import { BrowserPanelContext } from '@/context/BrowserPanelContext';

import Markdown from './Markdown';

const WORKSPACE = '/Users/zhihu/Documents/project/mino';
const REL = '.claude/rules/04-MEMORY.md';
const ABS = `${WORKSPACE}/${REL}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderMarkdown(markdown: string) {
  render(
    <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
      <FileActionProvider
        workspacePath={WORKSPACE}
        onInsertReference={mocks.onInsertReference}
        onFilePreviewExternal={mocks.onFilePreviewExternal}
        onRevealInTree={mocks.onRevealInTree}
      >
        <Markdown>{markdown}</Markdown>
      </FileActionProvider>
    </BrowserPanelContext.Provider>,
  );
}

function renderFloatingMarkdown(markdown: string) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      onInsertReference={mocks.onInsertReference}
      menuProfile="floatingBall"
      onOpenMyAgentsPreview={mocks.onOpenMyAgentsPreview}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
}

describe('Markdown inline-code file paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.writeText.mockResolvedValue(undefined);
    mocks.checkPaths.mockResolvedValue({ results: {} });
    mocks.checkLocalPaths.mockResolvedValue({ results: {} });
    mocks.openWithDefault.mockResolvedValue(undefined);
    mocks.openPathWithDefault.mockResolvedValue(undefined);
    mocks.readPreview.mockResolvedValue({
      name: '04-MEMORY.md',
      content: '# memory',
      size: 8,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mocks.writeText },
      configurable: true,
    });
  });

  it('makes a workspace-relative path in backticks a direct internal-preview action', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL] });
    fireEvent.click(chip);
    await waitFor(() => expect(mocks.onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
      path: REL,
      content: '# memory',
    })));
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
  });

  // Regression: an ABSOLUTE in-workspace path written in backticks used to stay
  // a plain <code> because the absolute form was sent straight to the Rust
  // resolver, which rejects absolute paths. The chip must DISPLAY the absolute
  // text but check existence against the workspace-relative form.
  it('normalizes an in-workspace absolute path in backticks before the existence check', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${ABS}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(ABS);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    // Backend was hit with the relative form, never the absolute one.
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL] });
    expect(mocks.checkPaths).not.toHaveBeenCalledWith({ paths: [ABS] });
    // The chip still shows the original absolute text.
    expect(chip.getAttribute('title')).toBe(`文件: ${ABS}`);

    // 复制 copies the VERBATIM shown text (absolute here) — not the relative
    // action form the menu uses internally for backend calls.
    fireEvent.contextMenu(chip);
    fireEvent.click(await screen.findByText('复制'));
    expect(mocks.writeText).toHaveBeenCalledWith(ABS);
  });

  it('keeps a rejected absolute path plain and without file actions', async () => {
    const OUTSIDE = '/etc/hosts';
    mocks.checkLocalPaths.mockResolvedValue({ results: { [OUTSIDE]: { exists: false, type: 'file' } } });
    renderMarkdown(`见 \`${OUTSIDE}\` 。`);

    await waitFor(() => expect(mocks.checkLocalPaths).toHaveBeenCalledWith({
      paths: [OUTSIDE],
      workspace: WORKSPACE,
    }));
    const chip = screen.getByText(OUTSIDE);
    expect(chip).not.toHaveClass('cursor-pointer');
    fireEvent.click(chip);
    fireEvent.contextMenu(chip);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.queryByText('复制')).not.toBeInTheDocument();
    expect(screen.queryByText('打开')).not.toBeInTheDocument();
  });

  it('keeps the reported localized Desktop-relative path plain when it is absent', async () => {
    const reported = '桌面/产品介绍与使用说明.md';
    mocks.checkPaths.mockResolvedValue({ results: { [reported]: { exists: false, type: 'file' } } });
    renderMarkdown(`已复制到桌面并打开了 → \`${reported}\``);

    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [reported] }));
    expect(screen.getByText(reported)).not.toHaveClass('cursor-pointer');
    expect(screen.queryByTitle(`文件: ${reported}`)).not.toBeInTheDocument();
  });

  it('supports a verified workspace path containing spaces', async () => {
    const path = 'docs/Product Guide.md';
    mocks.checkPaths.mockResolvedValue({ results: { [path]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${path}\`。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(path);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(chip).toHaveAttribute('title', `文件: ${path}`);
  });

  it('offers 复制 below 预览 and copies the shown text verbatim', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.contextMenu(chip);
    await screen.findByText('预览');

    // 复制 sits directly after 预览 in the menu.
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['预览', '复制', '引用', '打开', '打开所在文件夹', '在文件目录中展示']);

    fireEvent.click(screen.getByText('复制'));
    // Copies exactly the shown text (relative here, as the model wrote it).
    expect(mocks.writeText).toHaveBeenCalledWith(REL);
  });

  it('uses the floating-ball four-action menu profile', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderFloatingMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.click(chip);
    await waitFor(() => expect(mocks.onOpenMyAgentsPreview).toHaveBeenCalledWith(
      REL,
      expect.objectContaining({ displayPath: REL }),
    ));
  });

  it('reveals a directory on primary click and keeps the menu on right-click', async () => {
    const dir = '.claude/rules';
    mocks.checkPaths.mockResolvedValue({ results: { [dir]: { exists: true, type: 'dir' } } });
    renderMarkdown(`见 \`${dir}\`。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(dir);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.click(chip);
    await waitFor(() => expect(mocks.onRevealInTree).toHaveBeenCalledWith(dir));
    expect(screen.queryByText('打开所在文件夹')).not.toBeInTheDocument();

    fireEvent.contextMenu(chip);
    expect(await screen.findByText('打开所在文件夹')).toBeInTheDocument();
  });

  it('uses the system default application for an explicit Cmd/Ctrl click', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${REL}\`。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.click(chip, { metaKey: true });

    await waitFor(() => expect(mocks.openWithDefault).toHaveBeenCalledWith({ path: REL }));
    expect(mocks.onFilePreviewExternal).not.toHaveBeenCalled();
  });

  it('exposes verified file code as a keyboard link without hijacking text selection', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${REL}\`。`);
    const chip = await screen.findByRole('link', { name: REL });
    expect(chip).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(chip, { key: 'Enter' });
    await waitFor(() => expect(mocks.onFilePreviewExternal).toHaveBeenCalled());

    mocks.onFilePreviewExternal.mockClear();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => REL } as Selection);
    fireEvent.click(chip);
    expect(mocks.onFilePreviewExternal).not.toHaveBeenCalled();
  });

  it('rechecks before primary click and revokes a stale affordance', async () => {
    mocks.checkPaths.mockResolvedValueOnce({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${REL}\`。`);
    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });

    mocks.checkPaths.mockResolvedValueOnce({ results: { [REL]: { exists: false, type: 'file' } } });
    fireEvent.click(chip);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('文件不存在或无法访问'));
    expect(screen.getByText(REL)).not.toHaveClass('cursor-pointer');
    expect(mocks.onFilePreviewExternal).not.toHaveBeenCalled();
  });

  it('rechecks before right-click and never opens a stale file menu', async () => {
    mocks.checkPaths.mockResolvedValueOnce({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${REL}\`。`);
    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });

    mocks.checkPaths.mockResolvedValueOnce({ results: { [REL]: { exists: false, type: 'file' } } });
    fireEvent.contextMenu(chip);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('文件不存在或无法访问'));
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
    expect(screen.queryByText('打开')).not.toBeInTheDocument();
    expect(screen.getByText(REL)).not.toHaveClass('cursor-pointer');
  });

  it('does not let an older concurrent recheck restore a newer unavailable result', async () => {
    mocks.checkPaths.mockResolvedValueOnce({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${REL}\`。`);
    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });

    const older = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    const newer = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    mocks.checkPaths.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    fireEvent.click(chip);
    fireEvent.click(chip);

    newer.resolve({ results: { [REL]: { exists: false, type: 'file' } } });
    await waitFor(() => expect(screen.getByText(REL)).not.toHaveClass('cursor-pointer'));
    older.resolve({ results: { [REL]: { exists: true, type: 'file' } } });
    await older.promise;

    expect(screen.getByText(REL)).not.toHaveClass('cursor-pointer');
    expect(mocks.onFilePreviewExternal).not.toHaveBeenCalled();
  });

  it('promotes a valid backtick HTTP(S) URL without sending it to file checks', () => {
    const url = 'https://example.com/file.ts?download=1#top';
    renderMarkdown(`见 \`${url}\`。`);

    const link = screen.getByRole('link', { name: url });
    fireEvent.click(link);
    expect(mocks.openUrl).toHaveBeenCalledWith(url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.checkPaths).not.toHaveBeenCalled();
    expect(mocks.checkLocalPaths).not.toHaveBeenCalled();

    fireEvent.click(link, { ctrlKey: true });
    expect(mocks.openExternal).toHaveBeenCalledWith(url);
  });

  it.each(['https://', 'https://example.com/%ZZ', 'javascript:alert(1)', 'foo://bar'])(
    'keeps invalid or unsupported backtick URL %s as ordinary code',
    (value) => {
      renderMarkdown(`见 \`${value}\`。`);
      expect(screen.getByText(value)).not.toHaveClass('cursor-pointer');
      expect(screen.queryByRole('link', { name: value })).not.toBeInTheDocument();
    },
  );
});
