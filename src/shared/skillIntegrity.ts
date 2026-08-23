export type SkillIntegritySeverity = 'blocked' | 'warning';

export type SkillIntegrityReason =
  | 'missing_canonical_entry'
  | 'collision_directory_identity'
  | 'collision_directory_sibling'
  | 'untrusted_global_source'
  | 'reserved_entry_sibling'
  | 'unproven_suffix_directory'
  | 'inventory_unstable'
  | 'missing_required_skill';

export interface SkillIntegrityIssue {
  reason: SkillIntegrityReason;
  severity: SkillIntegritySeverity;
  folderName: string;
  canonicalPresent: boolean;
  revealPath: string;
  required: boolean;
}

export interface SkillIntegrityEvidence {
  folderName: string;
  declaredName?: string;
  /** Match the filesystem identity semantics of the platform doing the scan. */
  identityCaseInsensitive?: boolean;
  canonicalPresent: boolean;
  canonicalReadable: boolean;
  trustedSource: boolean;
  unsuffixedSiblingPresent: boolean;
  reservedEntrySiblingPresent: boolean;
  stable: boolean;
}

export interface SkillIntegrityClassification {
  disposition: 'admitted' | 'warning' | 'blocked';
  reasons: SkillIntegrityReason[];
}

const COLLISION_SUFFIX_RE = /^(.*?)(?: ?\((\d+)\))$/;
export const RESERVED_SKILL_ENTRY_RE = /^SKILL ?\(\d+\)\.md$/i;

export function collisionDirectoryBase(folderName: string): string | null {
  const match = COLLISION_SUFFIX_RE.exec(folderName);
  const base = match?.[1]?.trim();
  return base ? base : null;
}

export function skillIntegrityIdentityEquals(
  left: string,
  right: string,
  caseInsensitive: boolean,
): boolean {
  return caseInsensitive
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

/**
 * Classify only strong, shallow filesystem evidence. This deliberately does
 * not infer corruption from arbitrary naming differences: folder/frontmatter
 * mismatch is valid for ordinary Skills unless a Windows-style collision
 * suffix supplies additional evidence.
 */
export function classifySkillIntegrity(
  evidence: SkillIntegrityEvidence,
): SkillIntegrityClassification {
  if (!evidence.stable) {
    return { disposition: 'blocked', reasons: ['inventory_unstable'] };
  }
  if (!evidence.trustedSource) {
    return { disposition: 'blocked', reasons: ['untrusted_global_source'] };
  }
  if (!evidence.canonicalPresent || !evidence.canonicalReadable) {
    return { disposition: 'blocked', reasons: ['missing_canonical_entry'] };
  }

  const collisionBase = collisionDirectoryBase(evidence.folderName);
  if (
    collisionBase
    && evidence.declaredName
    && skillIntegrityIdentityEquals(
      evidence.declaredName,
      collisionBase,
      evidence.identityCaseInsensitive === true,
    )
  ) {
    return { disposition: 'blocked', reasons: ['collision_directory_identity'] };
  }
  if (collisionBase && evidence.unsuffixedSiblingPresent) {
    return { disposition: 'blocked', reasons: ['collision_directory_sibling'] };
  }

  const reasons: SkillIntegrityReason[] = [];
  if (collisionBase) reasons.push('unproven_suffix_directory');
  if (evidence.reservedEntrySiblingPresent) reasons.push('reserved_entry_sibling');
  return reasons.length > 0
    ? { disposition: 'warning', reasons }
    : { disposition: 'admitted', reasons: [] };
}
