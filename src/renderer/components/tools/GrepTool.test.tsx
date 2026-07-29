import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import GrepTool from './GrepTool';
import { parseGrepStats } from './toolBadgeConfig';

afterEach(cleanup);

function grepTool(result: Record<string, unknown>): ToolUseSimple {
  return {
    id: 'grep-call',
    name: 'Grep',
    input: { pattern: 'needle' },
    parsedInput: { pattern: 'needle', path: 'src' },
    streamIndex: 0,
    result: JSON.stringify(result),
  };
}

describe('GrepTool SDK pagination metadata', () => {
  it('preserves the new SDK totals and pagination fields', () => {
    expect(parseGrepStats(grepTool({
      numFiles: 3,
      numLines: 20,
      numMatches: 18,
      totalFiles: 12,
      totalLines: 90,
      appliedLimit: 20,
      appliedOffset: 20,
    }).result)).toEqual({
      matches: 18,
      files: 3,
      returnedLines: 20,
      totalFiles: 12,
      totalLines: 90,
      appliedLimit: 20,
      appliedOffset: 20,
    });
  });

  it('shows a passive range notice when the SDK returned only part of the matching lines', () => {
    render(<GrepTool tool={grepTool({
      numFiles: 3,
      numLines: 20,
      numMatches: 18,
      totalFiles: 12,
      totalLines: 90,
      appliedLimit: 20,
      appliedOffset: 20,
      content: 'src/a.ts:needle',
    })} />);

    expect(screen.getByRole('status')).toHaveTextContent('显示第 21–40 行，共 90 行');
  });

  it('does not claim truncation when the returned range covers the total', () => {
    render(<GrepTool tool={grepTool({
      numFiles: 2,
      numMatches: 2,
      totalFiles: 2,
      appliedLimit: 10,
      appliedOffset: 0,
    })} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([
    { totalLines: -1, appliedOffset: 0 },
    { totalLines: 90, appliedOffset: -1 },
    { totalLines: 90, appliedOffset: 1e20 },
    { numFiles: -1, numLines: undefined, totalFiles: 10, appliedOffset: 0 },
    { numFiles: '3', numLines: undefined, totalFiles: 10, appliedOffset: 0 },
    { numFiles: null, numLines: undefined, totalFiles: 10, appliedOffset: 0 },
  ])('omits pagination claims for malformed SDK metadata: %o', (metadata) => {
    render(<GrepTool tool={grepTool({
      numFiles: 3,
      numLines: 20,
      numMatches: 18,
      ...metadata,
      content: 'src/a.ts:needle',
    })} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not render an impossible range whose offset is beyond the total', () => {
    render(<GrepTool tool={grepTool({
      numLines: 20,
      totalLines: 10,
      appliedOffset: 20,
    })} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
