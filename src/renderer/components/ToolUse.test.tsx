import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import ToolUse from './ToolUse';

describe('ToolUse specialized result ownership', () => {
  it('passes a large Bash result intact to the terminal transcript budget', () => {
    const result = Array.from(
      { length: 5_001 },
      (_, index) => `line-${index}-${'x'.repeat(20)}`,
    ).join('\n');
    expect(result.length).toBeGreaterThan(50_000);
    const tool: ToolUseSimple = {
      id: 'large-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    };
    const { container } = render(<ToolUse tool={tool} />);

    expect(container).not.toHaveTextContent('结果过长，已截断');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container).toHaveTextContent('line-4998');
    expect(container).not.toHaveTextContent('line-5000');
    expect(screen.getByRole('status')).toHaveTextContent('终端内容过长');
  });

  it('does not corrupt a large SDK wrapper before Bash separates stderr', () => {
    const result = JSON.stringify({
      stdout: 'x'.repeat(210_000),
      stderr: 'warning from stderr',
      interrupted: false,
    });
    expect(result.length).toBeGreaterThan(200_000);
    const { container } = render(<ToolUse tool={{
      id: 'large-sdk-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    }} />);

    expect(container.querySelector('[data-bash-stream="stdout"]')).toBeInTheDocument();
    expect(container.querySelector('[data-bash-stream="stderr"]')).toHaveTextContent('warning from stderr');
    expect(container.querySelector('[data-bash-stream="combined"]')).not.toBeInTheDocument();
  });

  it('lets Edit parse a >200KB completion instead of showing the stale proposal', () => {
    const result = JSON.stringify({
      filePath: '/tmp/large-edit.ts',
      oldString: 'proposal-old',
      newString: 'applied-result',
      originalFile: 'x'.repeat(210_000),
      structuredPatch: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-proposal-old', '+applied-result'],
      }],
      userModified: true,
      replaceAll: false,
    });
    expect(result.length).toBeGreaterThan(200_000);

    const { container } = render(<ToolUse tool={{
      id: 'large-sdk-edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/large-edit.ts',
        old_string: 'proposal-old',
        new_string: 'stale-proposal',
      },
      streamIndex: 0,
      result,
    }} />);

    expect(container).toHaveTextContent('applied-result');
    expect(container).not.toHaveTextContent('stale-proposal');
    expect(container).toHaveTextContent('结果已在审批时调整');
    expect(container).not.toHaveTextContent('结果过长，已截断');
  });

  it('does not fall back to stale Edit input when the authoritative result was spilled', () => {
    const preview = '{"filePath":"/tmp/spilled-edit.ts","originalFile":"' + 'x'.repeat(8_000);
    const { container } = render(<ToolUse tool={{
      id: 'spilled-sdk-edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/spilled-edit.ts',
        old_string: 'proposal-old',
        new_string: 'stale-proposal',
      },
      streamIndex: 0,
      result: preview,
      resultMeta: {
        status: 'completed',
        largeValueRef: {
          kind: 'ref',
          id: 'abcdef1234',
          sizeBytes: 307_436,
          mimetype: 'text/plain; charset=utf-8',
          preview,
          expiresAt: Date.now() + 60_000,
        },
      },
    }} />);

    expect(container).toHaveTextContent('/tmp/spilled-edit.ts');
    expect(container).not.toHaveTextContent('stale-proposal');
    expect(container).toHaveTextContent('变更过大，仅展示有界预览');
  });
});
