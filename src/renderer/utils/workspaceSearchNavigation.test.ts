import { describe, expect, it } from 'vitest';

import type { FileSearchHit } from '@/api/searchClient';
import {
  activeTargetStillExists,
  ancestorDirectoryPaths,
  defaultExpandedFilesForHits,
  firstMatchLine,
  isActiveSearchMatch,
  mergeExpandedFilesAfterRefresh,
  normalizeFileSearchHits,
  normalizeFolderSearchHits,
  normalizeWorkspaceSearchPath,
  parentDirectoryPath,
} from './workspaceSearchNavigation';

function hit(path: string, lines: number[] = []): FileSearchHit {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    path,
    name,
    matchCount: Math.max(1, lines.length),
    matches: lines.map((lineNumber) => ({
      lineNumber,
      lineContent: `line ${lineNumber}`,
      highlights: [],
    })),
  };
}

describe('workspace search navigation helpers', () => {
  it('computes ancestor directories for reveal-in-tree', () => {
    expect(ancestorDirectoryPaths('src-tauri/src/search/file_indexer.rs')).toEqual([
      'src-tauri',
      'src-tauri/src',
      'src-tauri/src/search',
    ]);
    expect(ancestorDirectoryPaths('src-tauri\\src\\search\\file_indexer.rs')).toEqual([
      'src-tauri',
      'src-tauri/src',
      'src-tauri/src/search',
    ]);
    expect(ancestorDirectoryPaths('README.md')).toEqual([]);
  });

  it('computes parent directory for root and nested files', () => {
    expect(parentDirectoryPath('README.md')).toBe('');
    expect(parentDirectoryPath('src/server/title-generator.ts')).toBe('src/server');
    expect(parentDirectoryPath('src\\server\\title-generator.ts')).toBe('src/server');
  });

  it('normalizes Windows search paths before they enter tree state', () => {
    expect(normalizeWorkspaceSearchPath('src\\server\\title-generator.ts')).toBe(
      'src/server/title-generator.ts',
    );

    const [normalized] = normalizeFileSearchHits([
      hit('src\\server\\title-generator.ts', [12]),
    ]);
    expect(normalized.path).toBe('src/server/title-generator.ts');
    expect(normalizeFolderSearchHits([
      { path: 'src\\server', name: 'server' },
    ])[0].path).toBe('src/server');
  });

  it('returns the first content match line when available', () => {
    expect(firstMatchLine(hit('notes.md', [32, 109]))).toBe(32);
    expect(firstMatchLine(hit('title-only.md'))).toBeUndefined();
  });

  it('defaults new query results to the two-line compact state', () => {
    expect([...defaultExpandedFilesForHits([hit('a.md'), hit('b.md')])]).toEqual([]);
  });

  it('preserves manual expanded state across refresh while keeping new hits compact', () => {
    const previousHits = [hit('a.md'), hit('b.md')];
    const previousExpanded = new Set(['a.md']);
    const nextHits = [hit('a.md'), hit('b.md'), hit('c.md')];

    expect([...mergeExpandedFilesAfterRefresh(previousExpanded, previousHits, nextHits)]).toEqual([
      'a.md',
    ]);
  });

  it('drops expanded state for hits that disappeared', () => {
    const next = mergeExpandedFilesAfterRefresh(
      new Set(['a.md', 'removed.md']),
      [hit('a.md'), hit('removed.md')],
      [hit('a.md')],
    );

    expect([...next]).toEqual(['a.md']);
  });

  it('checks whether active match still exists after refresh', () => {
    const active = { kind: 'match' as const, path: 'src\\a.md', lineNumber: 12, requestId: 1 };
    expect(activeTargetStillExists(active, [hit('src/a.md', [12])])).toBe(true);
    expect(activeTargetStillExists(active, [hit('a.md', [13])])).toBe(false);
    expect(isActiveSearchMatch(active, 'src/a.md', 12)).toBe(true);
  });
});
