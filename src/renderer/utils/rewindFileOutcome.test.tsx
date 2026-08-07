import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToastProvider, useToast } from '@/components/Toast';

import {
  classifyCodexRewindTransportOutcome,
  projectCodexRewindRecovery,
  type RewindResponse,
  warnRewindFileOutcome,
} from './rewindFileOutcome';

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

describe('Codex rewind transport reconciliation', () => {
  it('treats an absent target in restored authority as committed', () => {
    expect(classifyCodexRewindTransportOutcome({
      restored: true,
      targetMessagePresent: false,
    })).toBe('committed');
  });

  it('treats a target still present in restored authority as unchanged', () => {
    expect(classifyCodexRewindTransportOutcome({
      restored: true,
      targetMessagePresent: true,
    })).toBe('unchanged');
  });

  it('does not infer a result when authority could not be restored', () => {
    expect(classifyCodexRewindTransportOutcome({
      restored: false,
      targetMessagePresent: null,
    })).toBe('unresolved');
  });

  it('does not infer deletion when the target presence probe is incomplete', () => {
    expect(classifyCodexRewindTransportOutcome({
      restored: true,
      targetMessagePresent: null,
    })).toBe('target-unknown');
  });

  it.each([
    ['committed', false, false],
    ['unchanged', false, true],
    ['target-unknown', false, true],
    ['unresolved', true, true],
  ] as const)(
    'projects %s without overwriting SessionStore authority',
    (outcome, restoreMessageSnapshot, restoreComposerSnapshot) => {
      expect(projectCodexRewindRecovery(outcome)).toEqual({
        restoreMessageSnapshot,
        restoreComposerSnapshot,
      });
    },
  );
});
