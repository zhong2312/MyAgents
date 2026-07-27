import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FilePreviewModal, {
  decideLiveReload,
  formatFilePreviewUpdateTime,
} from './FilePreviewModal';

const mocks = vi.hoisted(() => ({
  readPreview: vi.fn(),
  saveFile: vi.fn(),
  rename: vi.fn(),
  openInFinder: vi.fn(),
  openPathExternal: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  copyMarkdownAsRichText: vi.fn(),
  copyPlainText: vi.fn(),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    readPreview: mocks.readPreview,
    saveFile: mocks.saveFile,
    rename: mocks.rename,
    openInFinder: mocks.openInFinder,
    openPathExternal: mocks.openPathExternal,
  }),
}));

vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({
  useWorkspaceChangeSignal: () => 0,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    info: vi.fn(),
  }),
}));

vi.mock('@/utils/markdownClipboard', () => ({
  copyMarkdownAsRichText: mocks.copyMarkdownAsRichText,
  copyPlainText: mocks.copyPlainText,
}));

vi.mock('./Tip', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./Markdown', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown-preview">{children}</div>
  ),
}));

vi.mock('./MonacoEditor', () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

const baseProps = {
  name: 'notes.md',
  content: 'old content',
  size: 11,
  path: 'notes.md',
  workspacePath: '/workspace',
  embedded: true,
  onClose: vi.fn(),
};

describe('FilePreviewModal live reload', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('re-reads the open markdown file in place and shows a subtle update timestamp', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'new content',
      size: 11,
    });
    const onExternalContentUpdated = vi.fn();

    const { container, rerender } = render(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={0}
        onExternalContentUpdated={onExternalContentUpdated}
      />,
    );

    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('old content');

    const scroller = container.querySelector('.overflow-auto') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    scroller.scrollTop = 360;

    rerender(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={1}
        onExternalContentUpdated={onExternalContentUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('new content');
    });
    expect(onExternalContentUpdated).toHaveBeenCalledWith({
      path: 'notes.md',
      name: 'notes.md',
      content: 'new content',
      size: 11,
    });
    expect(screen.getByText(/^已更新 \d{2}:\d{2}$/)).toBeTruthy();
    expect(scroller.scrollTop).toBe(360);
  });

  it('revalidates on first mount when an external refresh signal already happened', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'fresh after hidden update',
      size: 25,
    });

    render(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={3}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('fresh after hidden update');
    });
    expect(mocks.readPreview).toHaveBeenCalledWith({ path: 'notes.md' });
  });

  it('does not autosave a dirty local buffer over an external update', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });

    const { rerender } = render(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={0} />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    rerender(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={1} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(editor.value).toBe('local dirty content');
    expect(mocks.saveFile).not.toHaveBeenCalled();
  });

  it('keeps the dirty editor open when closing with an external-update conflict pending', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });
    const onClose = vi.fn();

    const { rerender } = render(
      <FilePreviewModal
        {...baseProps}
        onClose={onClose}
        initialEditMode
        externalRefreshSignal={0}
      />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    rerender(
      <FilePreviewModal
        {...baseProps}
        onClose={onClose}
        initialEditMode
        externalRefreshSignal={1}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    expect(mocks.toastWarning).toHaveBeenCalledWith('文件已在外部更新，未自动覆盖');
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(editor.value).toBe('local dirty content');
  });

  it('exposes file actions from the embedded toolbar more menu', async () => {
    const onQuoteFile = vi.fn();
    const onRevealInTree = vi.fn();
    const onClose = vi.fn();
    mocks.copyPlainText.mockResolvedValueOnce(undefined);

    render(
      <FilePreviewModal
        {...baseProps}
        onClose={onClose}
        onQuoteFile={onQuoteFile}
        onRevealInTree={onRevealInTree}
      />,
    );

    fireEvent.click(screen.getByLabelText('更多'));
    expect(screen.getByRole('button', { name: '引用' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在文件目录中展示' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制文件路径' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开所在文件夹' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重命名' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制全文' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '在文件目录中展示' }));
    expect(onRevealInTree).toHaveBeenCalledWith('notes.md');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '复制文件路径' }));
    expect(mocks.copyPlainText).toHaveBeenCalledWith('/workspace/notes.md');
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制文件路径'));

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
    expect(mocks.openInFinder).toHaveBeenCalledWith({ path: 'notes.md' });

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    expect(screen.getByDisplayValue('notes.md')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByDisplayValue('notes.md'), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '引用' }));
    await waitFor(() => expect(onQuoteFile).toHaveBeenCalledWith('notes.md'));
    expect(onClose).toHaveBeenCalled();
  });

  it('copies markdown preview as rich text from the full-text menu action', async () => {
    mocks.copyMarkdownAsRichText.mockResolvedValueOnce('rich');

    render(
      <FilePreviewModal {...baseProps} content={'# Title\n\n**Body**'} />,
    );

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));

    await waitFor(() => {
      expect(mocks.copyMarkdownAsRichText).toHaveBeenCalledWith('# Title\n\n**Body**');
    });
    expect(mocks.copyPlainText).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制全文');
  });

  it('copies markdown source from edit mode, including unsaved text', async () => {
    mocks.copyPlainText.mockResolvedValueOnce(undefined);

    render(
      <FilePreviewModal {...baseProps} content="# Saved" initialEditMode />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# Unsaved draft' } });
    mocks.saveFile.mockClear();

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));

    await waitFor(() => {
      expect(mocks.copyPlainText).toHaveBeenCalledWith('# Unsaved draft');
    });
    expect(mocks.copyMarkdownAsRichText).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制全文');
  });

  it('copies non-markdown text/code files as raw text', async () => {
    mocks.copyPlainText.mockResolvedValueOnce(undefined);

    render(
      <FilePreviewModal
        {...baseProps}
        name="app.ts"
        path="app.ts"
        content="const answer = 42;"
        size={18}
      />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'const answer = 43;' } });
    mocks.saveFile.mockClear();

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));

    await waitFor(() => {
      expect(mocks.copyPlainText).toHaveBeenCalledWith('const answer = 43;');
    });
    expect(mocks.copyMarkdownAsRichText).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制全文');
  });

  it('copies read-only text previews as raw text', async () => {
    mocks.copyPlainText.mockResolvedValueOnce(undefined);

    render(
      <FilePreviewModal
        {...baseProps}
        name="README.txt"
        path="README.txt"
        content="read-only text"
        size={14}
        workspacePath={null}
      />,
    );

    fireEvent.click(screen.getByLabelText('更多'));
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));

    await waitFor(() => {
      expect(mocks.copyPlainText).toHaveBeenCalledWith('read-only text');
    });
    expect(mocks.copyMarkdownAsRichText).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已复制全文');
  });

  it('passes the saved baseline to autosave and converts stale-save failures into external-update pending', async () => {
    mocks.saveFile.mockRejectedValueOnce(new Error('File changed externally'));
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });

    render(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={0} />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    await waitFor(() => {
      expect(mocks.saveFile).toHaveBeenCalledWith({
        path: 'notes.md',
        content: 'local dirty content',
        expectedContent: 'old content',
      });
    }, { timeout: 1500 });

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });
    expect(editor.value).toBe('local dirty content');
  });

  it('does not enter fullscreen while a dirty external-update conflict is pending', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });
    const onFullscreen = vi.fn();

    const { rerender } = render(
      <FilePreviewModal
        {...baseProps}
        initialEditMode
        externalRefreshSignal={0}
        onFullscreen={onFullscreen}
      />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    rerender(
      <FilePreviewModal
        {...baseProps}
        initialEditMode
        externalRefreshSignal={1}
        onFullscreen={onFullscreen}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('全屏预览'));

    expect(onFullscreen).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith('文件已在外部更新，未自动覆盖');
  });
});

describe('FilePreviewModal live reload helpers', () => {
  it('formats update time as HH:mm', () => {
    expect(formatFilePreviewUpdateTime(new Date(2026, 5, 6, 3, 4))).toBe('03:04');
  });

  it('does not overwrite dirty editable content on external reload', () => {
    expect(decideLiveReload({
      incomingContent: 'external',
      currentContent: 'local dirty',
      savedContent: 'old saved',
      canEdit: true,
    })).toBe('pending');
  });

  it('applies external content when the visible buffer is clean', () => {
    expect(decideLiveReload({
      incomingContent: 'external',
      currentContent: 'old saved',
      savedContent: 'old saved',
      canEdit: true,
    })).toBe('apply');
  });
});
