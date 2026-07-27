import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';

export function shouldAddOrphanWorkspacePath(
  path: string,
  coveredIds: ReadonlySet<string>,
  knownProjectIds: ReadonlySet<string>,
  seenOrphan: ReadonlySet<string>,
): boolean {
  const id = normalizeWorkspacePathIdentity(path);
  return !coveredIds.has(id) && !knownProjectIds.has(id) && !seenOrphan.has(id);
}
