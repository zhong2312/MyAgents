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

import Markdown from './Markdown';

const WORKSPACE = '/Users/zhihu/Documents/project/mino';
const REL = '.claude/rules/04-MEMORY.md';
const ABS = `${WORKSPACE}/${REL}`;

function renderMarkdown(markdown: string) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      onInsertReference={mocks.onInsertReference}
      onFilePreviewExternal={mocks.onFilePreviewExternal}
      onRevealInTree={mocks.onRevealInTree}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
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
    fireEvent.click(screen.getByText('复制'));
    expect(mocks.writeText).toHaveBeenCalledWith(ABS);
  });

  it('keeps a rejected absolute path actionable and explains the unavailable target', async () => {
    const OUTSIDE = '/etc/hosts';
    mocks.checkLocalPaths.mockResolvedValue({ results: { [OUTSIDE]: { exists: false, type: 'file' } } });
    renderMarkdown(`见 \`${OUTSIDE}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(OUTSIDE);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(mocks.checkLocalPaths).toHaveBeenCalledWith({ paths: [OUTSIDE], workspace: WORKSPACE });

    fireEvent.click(chip);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('文件不存在或无法访问'));

    fireEvent.contextMenu(chip);
    expect(screen.getByText('复制')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
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
    expect(screen.getByText('打开所在文件夹')).toBeInTheDocument();
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
});
