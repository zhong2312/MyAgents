import { describe, expect, it } from 'vitest';

import type { ContentBlock, ToolUseSimple } from '@/types/chat';
import type { FilePatchDisplayDescriptor } from '../../shared/toolDisplay/filePatch';
import { deriveTurnFileEdits } from './turnFileEdits';

function toolBlock(tool: Partial<ToolUseSimple> & Pick<ToolUseSimple, 'name'>): ContentBlock {
  return {
    type: 'tool_use',
    tool: {
      id: `tool-${tool.name}`,
      input: {},
      result: 'completed',
      ...tool,
    } as ToolUseSimple,
  };
}

function descriptor(
  changes: FilePatchDisplayDescriptor['changes'],
  writeMode?: FilePatchDisplayDescriptor['writeMode'],
): FilePatchDisplayDescriptor {
  return {
    kind: 'file_patch',
    version: 1,
    source: 'codex',
    ...(writeMode ? { writeMode } : {}),
    summary: {
      files: changes.length,
      added: changes.reduce((total, change) => total + change.added, 0),
      removed: changes.reduce((total, change) => total + change.removed, 0),
    },
    changes,
  };
}

function change(
  path: string,
  kind: string,
  added: number,
  removed: number,
  movePath?: string,
): FilePatchDisplayDescriptor['changes'][number] {
  return {
    path,
    kind,
    added,
    removed,
    ...(movePath ? { movePath } : {}),
    view: { kind: 'unified-diff' },
  };
}

describe('deriveTurnFileEdits', () => {
  it('aggregates completed top-level and nested edits by normalized target', () => {
    const content: ContentBlock[] = [
      toolBlock({
        name: 'Edit',
        input: { file_path: '/workspace/src/a.ts', old_string: 'old', new_string: 'new' },
      }),
      toolBlock({
        name: 'Task',
        isError: true,
        subagentCalls: [
          {
            id: 'nested-edit',
            name: 'Edit',
            input: { file_path: 'src/a.ts', old_string: 'before', new_string: 'after' },
            result: 'completed',
            isLoading: false,
          },
        ],
      }),
    ];

    const summary = deriveTurnFileEdits(content, '/workspace');

    expect(summary?.files).toHaveLength(1);
    expect(summary?.files[0]).toMatchObject({
      displayPath: 'src/a.ts',
      status: 'modified',
      added: 2,
      removed: 2,
      statsReliable: true,
      actionTarget: { scope: 'workspace', path: 'src/a.ts' },
    });
  });

  it('ignores unfinished, failed, stopped, and unstructured tools', () => {
    const content: ContentBlock[] = [
      toolBlock({ name: 'Edit', input: { file_path: 'loading.ts', old_string: 'a', new_string: 'b' }, isLoading: true }),
      toolBlock({ name: 'Edit', input: { file_path: 'failed.ts', old_string: 'a', new_string: 'b' }, isError: true }),
      toolBlock({ name: 'Edit', input: { file_path: 'stopped.ts', old_string: 'a', new_string: 'b' }, isStopped: true }),
      toolBlock({ name: 'Bash', input: { command: 'echo x > bash.ts' } }),
      toolBlock({ name: 'Edit', input: { file_path: 'no-result.ts', old_string: 'a', new_string: 'b' }, result: undefined }),
    ];

    expect(deriveTurnFileEdits(content, '/workspace')).toBeNull();
  });

  it('keeps add through updates and resolves update then delete', () => {
    const summary = deriveTurnFileEdits([
      toolBlock({
        name: 'fileChange',
        display: descriptor([
          change('new.ts', 'add', 5, 0),
          change('new.ts', 'update', 2, 1),
          change('removed.ts', 'update', 1, 1),
          change('removed.ts', 'delete', 0, 8),
        ]),
      }),
    ], '/workspace');

    expect(summary?.files).toEqual([
      expect.objectContaining({ displayPath: 'new.ts', status: 'added', added: 7, removed: 1 }),
      expect.objectContaining({ displayPath: 'removed.ts', status: 'deleted', added: 1, removed: 9 }),
    ]);
  });

  it('keeps rename identity and target through a later update', () => {
    const summary = deriveTurnFileEdits([
      toolBlock({
        name: 'fileChange',
        display: descriptor([
          change('old.ts', 'move', 0, 0, 'src/new.ts'),
          change('src/new.ts', 'update', 3, 2),
        ]),
      }),
    ], '/workspace');

    expect(summary?.files).toEqual([
      expect.objectContaining({
        originalPath: 'old.ts',
        displayPath: 'src/new.ts',
        status: 'renamed',
        added: 3,
        removed: 2,
        actionTarget: { scope: 'workspace', path: 'src/new.ts' },
      }),
    ]);
  });

  it('marks unknown Write statistics as unreliable instead of fabricating zeros', () => {
    const summary = deriveTurnFileEdits([
      toolBlock({
        name: 'Write',
        input: { file_path: 'binary.dat', content: 'payload' },
      }),
    ], '/workspace');

    expect(summary?.allStatsReliable).toBe(false);
    expect(summary?.files[0]).toMatchObject({
      status: 'edited',
      statsReliable: false,
      added: 0,
      removed: 0,
    });
  });

  it('fails closed when a bounded descriptor cannot materialize every file', () => {
    const partial = descriptor([change('visible.ts', 'update', 1, 1)]);
    partial.summary.files = 2;

    expect(deriveTurnFileEdits([
      toolBlock({ name: 'fileChange', display: partial }),
    ], '/workspace')).toBeNull();
  });

  it('recovers every structured file beyond the renderer projection budget', () => {
    const changes = Array.from({ length: 105 }, (_, index) => ({
      path: index === 0 ? 'BUILD' : `src/file-${index}.ts`,
      kind: { type: 'add' },
      diff: `line ${index}`,
    }));

    const summary = deriveTurnFileEdits([
      toolBlock({ name: 'fileChange', input: { changes } }),
    ], '/workspace');

    expect(summary?.files).toHaveLength(105);
    expect(summary?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayPath: 'BUILD', status: 'added' }),
      expect.objectContaining({ displayPath: 'src/file-104.ts', status: 'added' }),
    ]));
    expect(summary?.allStatsReliable).toBe(false);
  });

  it('fails one malformed structured tool closed without hiding other valid tools', () => {
    const partial = descriptor([change('partial.ts', 'update', 1, 1)]);
    partial.summary.files = 2;
    const summary = deriveTurnFileEdits([
      toolBlock({
        name: 'fileChange',
        input: {
          changes: [
            { path: 'partial.ts', kind: { type: 'add' }, diff: 'partial' },
            { kind: { type: 'add' }, diff: 'missing path' },
          ],
        },
        display: partial,
      }),
      toolBlock({ name: 'Edit', input: { file_path: 'kept.ts', old_string: 'a', new_string: 'b' } }),
    ], '/workspace');

    expect(summary?.files).toEqual([
      expect.objectContaining({ displayPath: 'kept.ts' }),
    ]);
  });

  it('suppresses totals when the shared patch projection reports hidden content', () => {
    const hidden = descriptor([change('large.ts', 'update', 12, 8)]);
    hidden.hasHiddenContent = true;

    const summary = deriveTurnFileEdits([
      toolBlock({ name: 'fileChange', display: hidden }),
    ], '/workspace');

    expect(summary).toMatchObject({
      totalAdded: 12,
      totalRemoved: 8,
      allStatsReliable: false,
      files: [expect.objectContaining({ statsReliable: false })],
    });
  });

  it('normalizes Windows workspace paths case-insensitively', () => {
    const summary = deriveTurnFileEdits([
      toolBlock({
        name: 'Edit',
        input: { file_path: 'C:\\Repo\\src\\A.ts', old_string: 'a', new_string: 'b' },
      }),
      toolBlock({
        name: 'Edit',
        input: { file_path: 'src/a.ts', old_string: 'c', new_string: 'd' },
      }),
    ], 'C:\\Repo');

    expect(summary?.files).toHaveLength(1);
    expect(summary?.files[0]).toMatchObject({ added: 2, removed: 2 });
  });
});
