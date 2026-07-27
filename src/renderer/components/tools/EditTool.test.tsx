import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import EditTool from './EditTool';
import { getToolSummaryNode } from './toolBadgeConfig';
import WriteTool from './WriteTool';

function codexEditTool(): ToolUseSimple {
  return {
    id: 'call-file-change',
    name: 'Edit',
    input: {},
    streamIndex: 0,
    parsedInput: {
      file_path: '/tmp/a.md',
      changes: [
        {
          path: '/tmp/a.md',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n\\ No newline at end of file',
        },
        {
          path: '/tmp/new.md',
          kind: { type: 'add' },
          diff: '---\ntitle: New\n---\n\nbody',
        },
      ],
    } as unknown as ToolUseSimple['parsedInput'],
    result: '[object Object]: /tmp/a.md\n@@ -1,2 +1,3 @@\n-old\n+new',
  };
}

function longUnifiedDiff(rowCount: number, prefix: string): string {
  const rows = Array.from({ length: rowCount }, (_, index) => ` ${prefix}-${index + 1}`);
  return `@@ -1,${rowCount} +1,${rowCount} @@\n${rows.join('\n')}`;
}

describe('EditTool Codex fileChange rendering', () => {
  it('shows the base header while Edit input is still empty', () => {
    const { container } = render(<EditTool tool={{
      id: 'call-empty-edit',
      name: 'Edit',
      input: {},
      streamIndex: 0,
    }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to raw result when no file patch display can be resolved', () => {
    render(<EditTool tool={{
      id: 'call-raw-edit',
      name: 'Edit',
      input: {},
      streamIndex: 0,
      result: '[declined]\nFile changed',
      isError: true,
    }} />);

    expect(screen.getByText('原始工具结果')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('File changed'))).toBeInTheDocument();
  });

  it('uses changes[].diff for the summary chip', () => {
    const { container } = render(<>{getToolSummaryNode(codexEditTool())}</>);

    expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('+7 -1');
  });

  it('uses inputJson as the summary source for restored history', () => {
    const { parsedInput: _parsedInput, ...tool } = codexEditTool();
    const restoredTool = {
      ...tool,
      inputJson: JSON.stringify({
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra',
          },
        ],
      }),
    };

    const { container } = render(<>{getToolSummaryNode(restoredTool)}</>);

    expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('+2 -1');
  });

  it('renders structured Codex diffs from persisted input when parsedInput is absent', () => {
    const { inputJson: _inputJson, parsedInput, ...tool } = codexEditTool();
    render(<EditTool tool={{ ...tool, input: parsedInput as Record<string, unknown> }} />);

    expect(screen.getByRole('heading', { name: 'a.md' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'new.md' })).toBeInTheDocument();
    expect(screen.queryByText('/tmp/a.md')).not.toBeInTheDocument();
    expect(screen.getByText('修改')).toBeInTheDocument();
    expect(screen.getByText('新建')).toBeInTheDocument();
    expect(screen.getByText('第 1 行附近 · 原 2 行 → 新 3 行')).toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes('@@ -1,2 +1,3 @@'))).not.toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('renders structured Codex diffs instead of the raw [object Object] result', () => {
    const { container } = render(<EditTool tool={codexEditTool()} />);

    expect(screen.getByRole('heading', { name: 'a.md' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'new.md' })).toBeInTheDocument();
    expect(screen.getByText('修改')).toBeInTheDocument();
    expect(screen.getByText('新建')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-diff-kind="add"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-diff-kind="remove"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-diff-column="old-line"]')).toHaveClass('select-none');
    expect(container.querySelector('[data-diff-column="new-line"]')).toHaveClass('select-none');
    expect(container.querySelector('[data-diff-column="marker"]')).toHaveClass('select-none');
    expect(container.querySelector('[data-diff-column="code"]')).toHaveClass('select-text');
    expect(container.querySelector('[data-diff-kind="hunk"]')).toHaveClass('select-none');
    expect(container.querySelector('[data-diff-kind="omission"]')).toHaveClass('select-none');
    expect(container.querySelector('[aria-label="a.md 的变更"]')).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('第 1 行附近 · 原 2 行 → 新 3 行')).toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes('@@ -1,2 +1,3 @@'))).not.toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('keeps non-completed patch status and move destination visible in structured diffs', () => {
    const tool: ToolUseSimple = {
      id: 'call-move',
      name: 'Edit',
      input: {
        file_path: '/tmp/old.md',
        changes: [
          {
            path: '/tmp/old.md',
            kind: { type: 'move', move_path: '/tmp/new.md' },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      },
      streamIndex: 0,
      result: '[declined]\nmove: /tmp/old.md -> /tmp/new.md\n@@ -1 +1 @@\n-old\n+new',
      resultMeta: { status: 'declined' },
      isError: true,
    };

    render(<EditTool tool={tool} />);

    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'old.md' })).toBeInTheDocument();
    expect(screen.getByText('new.md')).toBeInTheDocument();
    expect(screen.getByText('移动')).toBeInTheDocument();
    expect(screen.getByText('移动到 new.md')).toHaveClass('sr-only');
  });

  it('keeps ordered multi-file groups independent under the shared initial DOM budget', () => {
    const { container } = render(<EditTool tool={{
      id: 'call-long-multi-edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/first.ts',
        changes: [
          { path: '/tmp/first.ts', kind: { type: 'update' }, diff: longUnifiedDiff(500, 'first') },
          { path: '/tmp/second.ts', kind: { type: 'update' }, diff: longUnifiedDiff(500, 'second') },
        ],
      },
      streamIndex: 0,
    }} />);

    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-file-patch-path]'));
    expect(sections.map((section) => section.querySelector('h3')?.textContent)).toEqual(['first.ts', 'second.ts']);
    expect(sections).toHaveLength(2);
    expect(sections[0].parentElement).toHaveClass('space-y-3');
    expect(sections[0].parentElement).not.toHaveClass('divide-y');
    expect(sections[0]).toHaveClass('rounded-[var(--radius-lg)]', 'border', 'shadow-[var(--shadow-xs)]');
    expect(sections[1]).toHaveClass('rounded-[var(--radius-lg)]', 'border', 'shadow-[var(--shadow-xs)]');
    expect(sections[0].querySelectorAll('[data-diff-row]')).toHaveLength(200);
    expect(sections[1].querySelectorAll('[data-diff-row]')).toHaveLength(200);
    expect(sections[0].querySelector('[data-file-patch-actions]')).toHaveClass('w-[calc(100%-2.25rem)]', 'sm:w-auto');
    expect(container.querySelectorAll('[data-file-patch-show-all]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /展示 first\.ts 的全部变更/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /展示 second\.ts 的全部变更/ })).toBeInTheDocument();

    fireEvent.click(within(sections[0]).getByRole('button', { name: /展示 first\.ts 的全部变更/ }));

    expect(sections[0].querySelectorAll('[data-diff-row]')).toHaveLength(501);
    expect(sections[1].querySelectorAll('[data-diff-row]')).toHaveLength(200);
    expect(container.querySelectorAll('[data-file-patch-show-all]')).toHaveLength(1);
  });

  it('uses the shortest distinguishing parent suffix for duplicate basenames', () => {
    render(<EditTool tool={{
      id: 'call-duplicate-basenames',
      name: 'Edit',
      input: {
        file_path: '/project/src/a/index.ts',
        changes: [
          { path: '/project/src/a/index.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
          { path: '/project/test/a/index.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
        ],
      },
      streamIndex: 0,
    }} />);

    expect(screen.getByRole('heading', { name: 'src/a/index.ts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'test/a/index.ts' })).toBeInTheDocument();
    expect(screen.getByText('src/a')).toBeInTheDocument();
    expect(screen.getByText('test/a')).toBeInTheDocument();
    expect(screen.getByLabelText('src/a/index.ts 的变更')).toBeInTheDocument();
    expect(screen.getByLabelText('test/a/index.ts 的变更')).toBeInTheDocument();
  });

  it('falls back to plain code rows when the syntax source crosses the highlight budget', () => {
    const longLine = ` ${'x'.repeat(320)}`;
    const diff = `@@ -1,400 +1,400 @@\n${Array.from({ length: 400 }, () => longLine).join('\n')}`;
    const { container } = render(<EditTool tool={{
      id: 'call-highlight-budget',
      name: 'Edit',
      input: {
        file_path: '/tmp/large.ts',
        changes: [{ path: '/tmp/large.ts', kind: { type: 'update' }, diff }],
      },
      streamIndex: 0,
    }} />);

    expect(container.querySelector('[data-syntax-highlighted="false"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-diff-row]')).toHaveLength(400);
  });

  it('announces the hard row cap and keeps it associated with the expanded viewport', () => {
    const diff = longUnifiedDiff(5_001, 'hard-cap');
    const { container } = render(<EditTool tool={{
      id: 'call-hard-row-cap',
      name: 'Edit',
      input: {
        file_path: '/tmp/hard-cap.ts',
        changes: [{ path: '/tmp/hard-cap.ts', kind: { type: 'update' }, diff }],
      },
      streamIndex: 0,
    }} />);

    fireEvent.click(screen.getByRole('button', { name: /展示 hard-cap\.ts 的全部变更/ }));

    expect(container.querySelectorAll('[data-diff-row]')).toHaveLength(5_000);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('内容过长，仅展示前 5000 行');
    expect(screen.getByLabelText('hard-cap.ts 的变更')).toHaveAttribute('aria-describedby', status.id);
  });
});

describe('tool summary input fallback', () => {
  it('uses neutral, localized singular and plural labels for input-only Write summaries', () => {
    const writeTool: ToolUseSimple = {
      id: 'call-write',
      name: 'Write',
      input: {},
      streamIndex: 0,
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'one',
      }),
    };
    const en = i18n.getFixedT('en-US', 'chat');
    const zh = i18n.getFixedT('zh-CN', 'chat');
    const translateWith = (t: typeof en) => (key: string, options?: Record<string, unknown>) => (
      String(t(key, options))
    );

    const singular = render(<>{getToolSummaryNode(writeTool, translateWith(en))}</>);
    expect(singular.container.textContent?.trim()).toBe('Write 1 line');

    const pluralTool = {
      ...writeTool,
      inputJson: JSON.stringify({ file_path: '/tmp/generated.md', content: 'one\ntwo\nthree' }),
    };
    const plural = render(<>{getToolSummaryNode(pluralTool, translateWith(en))}</>);
    expect(plural.container.textContent?.trim()).toBe('Write 3 lines');

    const chinese = render(<>{getToolSummaryNode(pluralTool, translateWith(zh))}</>);
    expect(chinese.container.textContent?.trim()).toBe('写入 3 行');
  });
});

describe('WriteTool file patch rendering', () => {
  it('renders input-only Write as neutral written content without inventing additions', () => {
    const tool: ToolUseSimple = {
      id: 'call-write-input-only',
      name: 'Write',
      input: {
        file_path: '/tmp/generated.ts',
        content: 'export const answer = 42;\nexport default answer;',
      },
      streamIndex: 0,
    };

    const { container } = render(<WriteTool tool={tool} />);

    expect(screen.getByRole('heading', { name: 'generated.ts' })).toBeInTheDocument();
    expect(screen.getByText('写入')).toBeInTheDocument();
    expect(screen.getByText('写入 2 行')).toBeInTheDocument();
    expect(screen.getByText('结果未提供旧版本')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-diff-kind="add"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-diff-kind="context"]')).toHaveLength(2);
  });

  it('renders trusted SDK write output with status metadata and syntax-highlighted rows', () => {
    const tool: ToolUseSimple = {
      id: 'call-write-sdk',
      name: 'Write',
      input: { file_path: '/tmp/generated.ts', content: 'const answer = 42;' },
      streamIndex: 0,
      result: JSON.stringify({
        type: 'create',
        filePath: '/tmp/generated.ts',
        content: 'const answer = 42;',
        originalFile: null,
        structuredPatch: [{
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+const answer = 42;'],
        }],
        userModified: true,
      }),
    };

    const { container } = render(<WriteTool tool={tool} />);

    expect(screen.getByText('新建')).toBeInTheDocument();
    expect(screen.getByText('结果已在审批时调整')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-diff-kind="add"]')).toHaveLength(1);
    expect(container.querySelector('[data-diff-kind="add"] span[style]')).toBeInTheDocument();
  });

  it('represents an empty input-only Write as a potentially destructive write, not a no-op', () => {
    render(<WriteTool tool={{
      id: 'call-write-empty',
      name: 'Write',
      input: { file_path: '/tmp/existing.txt', content: '' },
      streamIndex: 0,
    }} />);

    expect(screen.getByText('写入 0 行')).toBeInTheDocument();
    expect(screen.getByText('写入后的文件内容为空')).toBeInTheDocument();
    expect(screen.queryByText('没有文本变更')).not.toBeInTheDocument();
  });

  it('keeps section heading relationships unique across separate tool instances', () => {
    const first = render(<WriteTool tool={{
      id: 'call-write-first',
      name: 'Write',
      input: { file_path: '/tmp/foo bar.ts', content: 'one' },
      streamIndex: 0,
    }} />);
    const second = render(<WriteTool tool={{
      id: 'call-write-second',
      name: 'Write',
      input: { file_path: '/tmp/foo@bar.ts', content: 'two' },
      streamIndex: 0,
    }} />);

    const firstSection = first.container.querySelector('section[aria-labelledby]');
    const secondSection = second.container.querySelector('section[aria-labelledby]');
    expect(firstSection?.getAttribute('aria-labelledby')).not.toBe(secondSection?.getAttribute('aria-labelledby'));
    expect(first.container.querySelector(`#${CSS.escape(firstSection?.getAttribute('aria-labelledby') ?? '')}`)).toBeInTheDocument();
    expect(second.container.querySelector(`#${CSS.escape(secondSection?.getAttribute('aria-labelledby') ?? '')}`)).toBeInTheDocument();
  });
});
