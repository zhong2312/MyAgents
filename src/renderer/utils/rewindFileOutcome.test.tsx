import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToastProvider, useToast } from '@/components/Toast';

import { type RewindResponse, warnRewindFileOutcome } from './rewindFileOutcome';

function Harness({ result }: { result: RewindResponse }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => warnRewindFileOutcome(
        result,
        toast.warning,
        (key, options) => `${key}${options ? `:${options.count}` : ''}`,
      )}
    >
      rewind
    </button>
  );
}

describe('rewind file outcome warning', () => {
  it.each([
    [{ fileRewindStatus: 'failed' }, 'shell.toasts.rewindFilesFailed'],
    [{ fileRewindStatus: 'not_attempted' }, 'shell.toasts.rewindFilesNotAttempted'],
    [{ fileRewindStatus: 'partial', skippedLinks: 2 }, 'shell.toasts.rewindPartialLinks:2'],
  ] as const)('shows the independent workspace warning for %o', (result, expected) => {
    render(<ToastProvider><Harness result={result} /></ToastProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'rewind' }));

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
