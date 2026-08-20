interface TrackingEvidenceChange {
  readonly evidence: string;
}

export function isManuscriptTrackingEvidenceGrounded(
  sourceContent: string,
  evidence: string,
): boolean {
  const normalizedEvidence = evidence.trim();
  return (
    Boolean(normalizedEvidence) && sourceContent.includes(normalizedEvidence)
  );
}

export function partitionManuscriptTrackingChangesByEvidence<
  Change extends TrackingEvidenceChange,
>(
  sourceContent: string,
  changes: readonly Change[],
): {
  readonly grounded: readonly Change[];
  readonly ungrounded: readonly Change[];
} {
  const grounded: Change[] = [];
  const ungrounded: Change[] = [];
  for (const change of changes) {
    (isManuscriptTrackingEvidenceGrounded(sourceContent, change.evidence)
      ? grounded
      : ungrounded
    ).push(change);
  }
  return { grounded, ungrounded };
}
