export type RewindResponse = {
  success?: boolean;
  error?: string;
  skippedLinks?: number;
  fileRewindStatus?: 'complete' | 'partial' | 'failed' | 'not_attempted';
};

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
