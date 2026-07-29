export type FileRewindStatus = 'complete' | 'partial' | 'failed' | 'not_attempted';

export type FileRewindResultSummary = {
  fileRewindStatus: Exclude<FileRewindStatus, 'failed' | 'not_attempted'>;
  skippedLinks: number;
};

type RewindFilesResult = {
  canRewind: boolean;
  filesChanged?: unknown[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
};

type RewindFilesQuery = {
  rewindFiles(userMessageUuid: string): Promise<RewindFilesResult>;
};

export type FileRewindAttempt = {
  fileRewindStatus: FileRewindStatus;
  skippedLinks: number;
  attempted: boolean;
  diagnostics?: {
    canRewind: boolean;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
};

/** Normalize the SDK checkpoint result without trusting numeric metadata. */
export function summarizeFileRewindResult(result: {
  canRewind: boolean;
  skippedLinks?: number;
}): FileRewindResultSummary | { fileRewindStatus: 'failed'; skippedLinks: 0 } {
  if (!result.canRewind) {
    return { fileRewindStatus: 'failed', skippedLinks: 0 };
  }
  const skippedLinks = Number.isSafeInteger(result.skippedLinks) && (result.skippedLinks ?? 0) >= 0
    ? result.skippedLinks ?? 0
    : 0;
  return {
    fileRewindStatus: skippedLinks > 0 ? 'partial' : 'complete',
    skippedLinks,
  };
}

/**
 * Run the optional SDK file-checkpoint operation independently from transcript
 * rewind. Missing/stale ownership means "not attempted"; SDK refusal, timeout,
 * or rejection means "failed". The caller can still commit conversation rewind.
 */
export async function attemptFileRewind(params: {
  query: RewindFilesQuery | null;
  targetUserUuid: string | undefined;
  abortRequested: boolean;
  isCurrentSessionUuid: boolean;
  timeoutMs?: number;
}): Promise<FileRewindAttempt> {
  const {
    query,
    targetUserUuid,
    abortRequested,
    isCurrentSessionUuid,
    timeoutMs = 5_000,
  } = params;
  if (!query || !targetUserUuid || abortRequested || !isCurrentSessionUuid) {
    return { fileRewindStatus: 'not_attempted', skippedLinks: 0, attempted: false };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      query.rewindFiles(targetUserUuid),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('rewindFiles timeout')), timeoutMs);
      }),
    ]);
    const summary = summarizeFileRewindResult(result);
    return {
      ...summary,
      attempted: true,
      diagnostics: {
        canRewind: result.canRewind,
        filesChanged: Array.isArray(result.filesChanged) ? result.filesChanged.length : 0,
        insertions: Number.isSafeInteger(result.insertions) ? result.insertions ?? 0 : 0,
        deletions: Number.isSafeInteger(result.deletions) ? result.deletions ?? 0 : 0,
      },
    };
  } catch {
    return { fileRewindStatus: 'failed', skippedLinks: 0, attempted: true };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
