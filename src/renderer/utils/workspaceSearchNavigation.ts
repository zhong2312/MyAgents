import type { FileSearchHit, FolderSearchHit } from '@/api/searchClient';

export type ActiveSearchTarget =
  | { kind: 'file'; path: string }
  | { kind: 'match'; path: string; lineNumber: number; requestId: number };

export function normalizeWorkspaceSearchPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function normalizeFileSearchHits(hits: readonly FileSearchHit[]): FileSearchHit[] {
  return hits.map((hit) => {
    const normalizedPath = normalizeWorkspaceSearchPath(hit.path);
    return normalizedPath === hit.path ? hit : { ...hit, path: normalizedPath };
  });
}

export function normalizeFolderSearchHits(hits: readonly FolderSearchHit[]): FolderSearchHit[] {
  return hits.map((hit) => {
    const normalizedPath = normalizeWorkspaceSearchPath(hit.path);
    return normalizedPath === hit.path ? hit : { ...hit, path: normalizedPath };
  });
}

export function firstMatchLine(hit: FileSearchHit): number | undefined {
  return hit.matches[0]?.lineNumber;
}

export function ancestorDirectoryPaths(path: string): string[] {
  const parts = normalizeWorkspaceSearchPath(path).split('/').filter(Boolean);
  if (parts.length <= 1) return [];

  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

export function parentDirectoryPath(path: string): string {
  const parts = normalizeWorkspaceSearchPath(path).split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

export function allHitPaths(hits: readonly FileSearchHit[]): Set<string> {
  return new Set(hits.map((hit) => normalizeWorkspaceSearchPath(hit.path)));
}

export function defaultExpandedFilesForHits(hits: readonly FileSearchHit[]): Set<string> {
  void hits;
  return new Set();
}

export function mergeExpandedFilesAfterRefresh(
  previous: ReadonlySet<string>,
  previousHits: readonly FileSearchHit[],
  nextHits: readonly FileSearchHit[],
): Set<string> {
  void previousHits;
  const nextHitPaths = allHitPaths(nextHits);
  const next = new Set<string>();

  for (const path of previous) {
    if (nextHitPaths.has(path)) {
      next.add(path);
    }
  }

  return next;
}

export function isActiveSearchFile(
  active: ActiveSearchTarget | null,
  path: string,
): boolean {
  return !!active && normalizeWorkspaceSearchPath(active.path) === normalizeWorkspaceSearchPath(path);
}

export function isActiveSearchMatch(
  active: ActiveSearchTarget | null,
  path: string,
  lineNumber: number,
): boolean {
  return active?.kind === 'match'
    && normalizeWorkspaceSearchPath(active.path) === normalizeWorkspaceSearchPath(path)
    && active.lineNumber === lineNumber;
}

export function activeTargetStillExists(
  active: ActiveSearchTarget | null,
  hits: readonly FileSearchHit[],
): boolean {
  if (!active) return false;
  const activePath = normalizeWorkspaceSearchPath(active.path);
  const hit = hits.find((candidate) => normalizeWorkspaceSearchPath(candidate.path) === activePath);
  if (!hit) return false;
  if (active.kind === 'file') return true;
  return hit.matches.some((match) => match.lineNumber === active.lineNumber);
}
