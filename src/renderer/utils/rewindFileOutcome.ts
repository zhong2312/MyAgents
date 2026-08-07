export type RewindResponse = {
  success?: boolean;
  error?: string;
  skippedLinks?: number;
  fileRewindStatus?: 'complete' | 'partial' | 'failed' | 'not_attempted';
  rewindScope?: 'conversation-only';
  errorCode?: string;
};

export type CodexRewindTransportOutcome = 'committed' | 'unchanged' | 'target-unknown' | 'unresolved';

export type CodexRewindRecoveryProjection = {
  restoreMessageSnapshot: boolean;
  restoreComposerSnapshot: boolean;
};

export function classifyCodexRewindTransportOutcome(
  result: { restored: boolean; targetMessagePresent: boolean | null } | null,
): CodexRewindTransportOutcome {
  if (!result?.restored) return 'unresolved';
  if (result.targetMessagePresent === null) return 'target-unknown';
  return result.targetMessagePresent ? 'unchanged' : 'committed';
}

export function projectCodexRewindRecovery(
  outcome: CodexRewindTransportOutcome,
): CodexRewindRecoveryProjection {
  return {
    restoreMessageSnapshot: outcome === 'unresolved',
    restoreComposerSnapshot: outcome !== 'committed',
  };
}

type Translate = (key: string, options?: { count: number }) => string;

/** Keep transcript success separate from the optional workspace-file outcome. */
export function warnRewindFileOutcome(
  result: RewindResponse | undefined,
  warning: (message: string) => void,
  translate: Translate,
): void {
  if (result?.fileRewindStatus === 'failed') {
    warning(translate('shell.toasts.rewindFilesFailed'));
  } else if (result?.fileRewindStatus === 'not_attempted') {
    warning(translate('shell.toasts.rewindFilesNotAttempted'));
  } else if (result?.fileRewindStatus === 'partial' || (result?.skippedLinks ?? 0) > 0) {
    warning(translate('shell.toasts.rewindPartialLinks', { count: result?.skippedLinks ?? 0 }));
  }
}
