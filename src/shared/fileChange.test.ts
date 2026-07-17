import { describe, expect, it } from 'vitest';

import {
  countFileChangeDiffLines,
  fileChangeKindLabel,
  formatFileChangeForResult,
  summarizeFileChanges,
} from './fileChange';

describe('fileChange helpers', () => {
  it('normalizes Codex object kind labels instead of stringifying them', () => {
    const change = {
      path: '/tmp/example.md',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra',
    };

    expect(fileChangeKindLabel(change.kind)).toBe('update');
    expect(formatFileChangeForResult(change)).toBe(
      'update: /tmp/example.md\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra',
    );
  });

  it('counts unified diff additions and removals', () => {
    expect(countFileChangeDiffLines({
      kind: { type: 'update' },
      diff: '--- a/file.md\n+++ b/file.md\n@@ -1,3 +1,5 @@\n context\n-old\n+new\n+extra\n+--- content\n++++ content\n---- content',
    })).toEqual({ added: 4, removed: 2 });
  });

  it('counts raw add/delete content without treating markdown bullets or @@ markers as diff syntax', () => {
    expect(countFileChangeDiffLines({
      kind: { type: 'add' },
      diff: '---\ntitle: Test\n---\n\n- bullet\n@@ marker\nbody',
    })).toEqual({ added: 7, removed: 0 });

    expect(countFileChangeDiffLines({
      kind: { type: 'delete' },
      diff: '- bullet\n@@ marker\nbody',
    })).toEqual({ added: 0, removed: 3 });
  });

  it('formats moves with source and destination paths', () => {
    expect(formatFileChangeForResult({
      path: '/tmp/old.md',
      kind: { type: 'move', move_path: '/tmp/new.md' },
    })).toBe('move: /tmp/old.md -> /tmp/new.md');
  });

  it('summarizes multi-file Codex changes', () => {
    expect(summarizeFileChanges([
      { path: 'a.md', kind: { type: 'add' }, diff: 'one\ntwo' },
      { path: 'b.md', kind: { type: 'update' }, diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra' },
    ])).toEqual({ files: 2, added: 4, removed: 1 });
  });
});
