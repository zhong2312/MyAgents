import { describe, expect, it } from 'vitest';

import {
  buildFilePatchDisplayDescriptor,
  FILE_PATCH_MAX_CHARACTER_BUDGET,
  FILE_PATCH_MAX_FILE_BUDGET,
  FILE_PATCH_MAX_ROW_BUDGET,
  parseUnifiedDiffRows,
  resolveFilePatchDisplay,
  resolveFilePatchRenderModel,
  type FilePatchToolLike,
} from './filePatch';

function deidentifiedUpdateDiff(
  label: string,
  hunks: ReadonlyArray<readonly [removed: number, added: number]>,
): string {
  let oldStart = 1;
  let newStart = 1;
  return hunks.map(([removed, added], hunkIndex) => {
    const header = `@@ -${oldStart},${removed} +${newStart},${added} @@`;
    const removedLines = Array.from(
      { length: removed },
      (_, lineIndex) => `-${label} old ${hunkIndex + 1}.${lineIndex + 1}`,
    );
    const addedLines = Array.from(
      { length: added },
      (_, lineIndex) => `+${label} new ${hunkIndex + 1}.${lineIndex + 1}`,
    );
    oldStart += Math.max(removed, 1) + 10;
    newStart += Math.max(added, 1) + 10;
    return [header, ...removedLines, ...addedLines].join('\n');
  }).join('\n');
}

/** Deidentified from Session 2d6ec8dc-7bad-4c6b-a393-2fcdafb5ebff. */
function codexFourFileSessionFixture(): {
  startedTool: FilePatchToolLike;
  appliedChanges: Record<string, { type: 'update'; unifiedDiff: string }>;
} {
  const changes = [
    {
      path: '/workspace/0612-life-simulator/h5/index.html',
      kind: { type: 'update', move_path: null },
      diff: deidentifiedUpdateDiff('index', [[1, 0]]),
    },
    {
      path: '/workspace/0612-life-simulator/h5/src/account.ts',
      kind: { type: 'update', move_path: null },
      diff: deidentifiedUpdateDiff('account', [[1, 13], [0, 13], [0, 13]]),
    },
    {
      path: '/workspace/0612-life-simulator/h5/src/analytics.ts',
      kind: { type: 'update', move_path: null },
      diff: deidentifiedUpdateDiff('analytics', [[3, 12], [3, 11]]),
    },
    {
      path: '/workspace/0612-life-simulator/h5/src/main.ts',
      kind: { type: 'update', move_path: null },
      diff: deidentifiedUpdateDiff('main', [[13, 14]]),
    },
  ];
  return {
    startedTool: {
      name: 'Edit',
      input: { changes },
      inputJson: JSON.stringify({
        file_path: '/workspace/0612-life-simulator/h5/index.html',
        changes,
      }),
      resultMeta: { status: 'completed' },
    },
    // The actual patch_apply_end object used a different path order. Keeping
    // this authority separate prevents a descriptor-only tautology.
    appliedChanges: {
      '/workspace/0612-life-simulator/h5/src/main.ts': {
        type: 'update',
        unifiedDiff: deidentifiedUpdateDiff('main', [[13, 14]]),
      },
      '/workspace/0612-life-simulator/h5/src/analytics.ts': {
        type: 'update',
        unifiedDiff: deidentifiedUpdateDiff('analytics', [[3, 12], [3, 11]]),
      },
      '/workspace/0612-life-simulator/h5/index.html': {
        type: 'update',
        unifiedDiff: deidentifiedUpdateDiff('index', [[1, 0]]),
      },
      '/workspace/0612-life-simulator/h5/src/account.ts': {
        type: 'update',
        unifiedDiff: deidentifiedUpdateDiff('account', [[1, 13], [0, 13], [0, 13]]),
      },
    },
  };
}

describe('filePatch display protocol', () => {
  it('builds a compact descriptor for builtin Edit without duplicating old/new text', () => {
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Edit',
      input: {
        file_path: '/tmp/example.md',
        old_string: 'old body\nsecond line',
        new_string: 'new body',
        replace_all: true,
      },
    });

    expect(descriptor).toMatchObject({
      kind: 'file_patch',
      version: 1,
      source: 'builtin',
      replaceAll: true,
      summary: { files: 1, added: 1, removed: 2 },
      changes: [{ kind: 'update', path: '/tmp/example.md', view: { kind: 'old-new' } }],
    });
    expect(JSON.stringify(descriptor)).not.toContain('old body');
    expect(JSON.stringify(descriptor)).not.toContain('new body');
  });

  it('builds a compact descriptor for Codex fileChange without duplicating diffs', () => {
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Edit',
      input: {
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra',
          },
        ],
      },
      resultMeta: { status: 'completed' },
    });

    expect(descriptor).toMatchObject({
      kind: 'file_patch',
      version: 1,
      source: 'codex',
      summary: { files: 1, added: 2, removed: 1 },
      changes: [{ kind: 'update', path: '/tmp/a.md', view: { kind: 'unified-diff' } }],
    });
    expect(JSON.stringify(descriptor)).not.toContain('-old');
    expect(JSON.stringify(descriptor)).not.toContain('+extra');
  });

  it('stores input-only Write as written lines without inventing additions', () => {
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Write',
      input: { file_path: '/tmp/unknown.md', content: 'one\ntwo\n' },
    });

    expect(descriptor).toMatchObject({
      version: 1,
      writeMode: 'unknown',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [{ kind: 'write', written: 2, added: 0, removed: 0, view: { kind: 'content' } }],
    });
    expect(JSON.stringify(descriptor)).not.toContain('one');
  });

  it('resolves new descriptors by materializing text from legacy inputJson', () => {
    const display = resolveFilePatchDisplay({
      name: 'Write',
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'one\ntwo\n',
      }),
      display: {
        kind: 'file_patch',
        version: 1,
        source: 'builtin',
        summary: { files: 1, added: 2, removed: 0 },
        changes: [
          {
            kind: 'add',
            path: '/tmp/generated.md',
            added: 2,
            removed: 0,
            view: { kind: 'content' },
          },
        ],
      },
    });

    expect(display?.summary).toEqual({ files: 1, added: 2, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'content', content: 'one\ntwo\n' });
  });

  it('falls through partial parsedInput to complete inputJson without claiming input-only Write additions', () => {
    const display = resolveFilePatchDisplay({
      name: 'Write',
      parsedInput: { file_path: '/tmp/generated.md' },
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'complete body',
      }),
    });

    expect(display?.summary).toEqual({ files: 1, added: 0, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'content', content: 'complete body' });
  });

  it('falls through partial parsedInput to complete inputJson for Codex fileChange', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      parsedInput: {
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
          },
        ],
      },
      inputJson: JSON.stringify({
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      }),
    });

    expect(display?.summary).toEqual({ files: 1, added: 1, removed: 1 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'unified-diff', diff: '@@ -1 +1 @@\n-old\n+new' });
  });

  it('keeps old history compatible when only raw input is available', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      input: {
        file_path: '/tmp/raw.md',
        old_string: '',
        new_string: 'created',
      },
    });

    expect(display?.summary).toEqual({ files: 1, added: 1, removed: 0 });
    expect(display?.changes[0]?.view).toEqual({ kind: 'old-new', oldText: '', newText: 'created' });
  });

  it('waits for both builtin Edit sides before producing a display summary', () => {
    expect(resolveFilePatchDisplay({
      name: 'Edit',
      parsedInput: {
        file_path: '/tmp/streaming.md',
        old_string: 'old only',
      },
    })).toBeNull();
  });

  it('keeps diff-less Codex moves materialized for header/status rendering', () => {
    const display = resolveFilePatchDisplay({
      name: 'Edit',
      input: {
        changes: [
          {
            path: '/tmp/old.md',
            kind: { type: 'move', move_path: '/tmp/new.md' },
          },
        ],
      },
      result: '[declined]\nmove: /tmp/old.md -> /tmp/new.md',
      resultMeta: { status: 'declined' },
    });

    expect(display).toMatchObject({
      status: 'declined',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [
        {
          kind: 'move',
          path: '/tmp/old.md',
          movePath: '/tmp/new.md',
          view: { kind: 'unified-diff', diff: '' },
        },
      ],
    });
  });
});

describe('filePatch render model', () => {
  it('uses SDK structuredPatch as the exact, result-side authority across multiple hunks', () => {
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        file_path: '/tmp/example.ts',
        old_string: 'stale preview',
        new_string: 'stale proposal',
      },
      result: JSON.stringify({
        filePath: '/tmp/example.ts',
        oldString: 'old',
        newString: 'new',
        originalFile: 'old',
        structuredPatch: [
          {
            oldStart: 3,
            oldLines: 2,
            newStart: 3,
            newLines: 2,
            lines: [' keep', '-old', '+new'],
          },
          {
            oldStart: 20,
            oldLines: 1,
            newStart: 20,
            newLines: 2,
            lines: ['-tail', '+tail()', '+extra()'],
          },
        ],
        userModified: true,
        replaceAll: true,
      }),
    });

    expect(model).toMatchObject({
      source: 'builtin',
      userModified: true,
      replaceAll: true,
      summary: { files: 1, added: 3, removed: 2 },
      changes: [{ path: '/tmp/example.ts', lineNumbers: 'exact', added: 3, removed: 2 }],
    });
    expect(model?.changes[0]?.rows).toEqual([
      {
        key: 'h0:0',
        kind: 'hunk',
        marker: '',
        text: '@@ -3,2 +3,2 @@',
        hunk: { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2 },
      },
      { key: 'h0:1', kind: 'context', oldLine: 3, newLine: 3, marker: '', text: 'keep' },
      { key: 'h0:2', kind: 'remove', oldLine: 4, marker: '-', text: 'old' },
      { key: 'h0:3', kind: 'add', newLine: 4, marker: '+', text: 'new' },
      {
        key: 'h1:4',
        kind: 'hunk',
        marker: '',
        text: '@@ -20,1 +20,2 @@',
        hunk: { oldStart: 20, oldLines: 1, newStart: 20, newLines: 2 },
      },
      { key: 'h1:5', kind: 'remove', oldLine: 20, marker: '-', text: 'tail' },
      { key: 'h1:6', kind: 'add', newLine: 20, marker: '+', text: 'tail()' },
      { key: 'h1:7', kind: 'add', newLine: 21, marker: '+', text: 'extra()' },
    ]);
  });

  it('distinguishes Write create, Write update, and input-only unknown semantics', () => {
    const created = resolveFilePatchRenderModel({
      name: 'Write',
      input: { file_path: '/tmp/new.md', content: 'stale input' },
      result: JSON.stringify({
        type: 'create',
        filePath: '/tmp/new.md',
        content: 'one\ntwo\n',
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      }),
    });
    expect(created).toMatchObject({
      writeMode: 'create',
      summary: { files: 1, added: 2, removed: 0 },
      changes: [{ kind: 'add', lineNumbers: 'exact' }],
    });
    expect(created?.changes[0]?.rows.map((row) => row.newLine)).toEqual([1, 2]);

    const updated = resolveFilePatchRenderModel({
      name: 'Write',
      input: { file_path: '/tmp/existing.md', content: 'current' },
      result: JSON.stringify({
        type: 'update',
        filePath: '/tmp/existing.md',
        content: 'current',
        structuredPatch: [{
          oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-before', '+after'],
        }],
        originalFile: 'before',
        userModified: false,
      }),
    });
    expect(updated).toMatchObject({
      writeMode: 'update',
      summary: { files: 1, added: 1, removed: 1 },
      changes: [{ kind: 'update', lineNumbers: 'exact' }],
    });

    const inputOnly = resolveFilePatchRenderModel({
      name: 'Write',
      input: { file_path: '/tmp/unknown.md', content: 'one\ntwo\n' },
    });
    expect(inputOnly).toMatchObject({
      writeMode: 'unknown',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [{ kind: 'write', written: 2, lineNumbers: 'unavailable', added: 0, removed: 0 }],
    });
    expect(inputOnly?.changes[0]?.rows.every((row) => row.oldLine === undefined && row.newLine === undefined)).toBe(true);
  });

  it('does not invent absolute line numbers for builtin old/new snippets', () => {
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        file_path: '/tmp/snippet.ts',
        old_string: 'first\nsecond',
        new_string: 'replacement',
      },
    });

    expect(model?.changes[0]?.lineNumbers).toBe('unavailable');
    expect(model?.changes[0]?.rows).toHaveLength(3);
    expect(model?.changes[0]?.rows.every((row) => row.oldLine === undefined && row.newLine === undefined)).toBe(true);
  });

  it('parses ordered Codex add/update/delete/move changes without reading completed text boundaries', () => {
    const changes = [
      {
        path: '/tmp/new.ts',
        kind: { type: 'add' },
        diff: 'const one = 1;\nconst two = 2;\n',
      },
      {
        path: '/tmp/update.ts',
        kind: { type: 'update' },
        diff: 'diff --git a/update.ts b/update.ts\n--- a/update.ts\n+++ b/update.ts\n@@ -4,2 +4,2 @@\n keep\n-old\n+new',
      },
      {
        path: '/tmp/deleted.ts',
        kind: { type: 'delete' },
        diff: 'gone\nforever',
      },
      {
        path: '/tmp/old.ts',
        kind: { type: 'move', move_path: '/tmp/moved.ts' },
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
    ];
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      input: { changes },
      result: '[completed]\nupdate: fake.ts\nadd: also-fake.ts',
    });

    expect(model?.changes.map((change) => change.path)).toEqual([
      '/tmp/new.ts', '/tmp/update.ts', '/tmp/deleted.ts', '/tmp/old.ts',
    ]);
    expect(model?.changes[3]?.movePath).toBe('/tmp/moved.ts');
    expect(model?.summary).toEqual({ files: 4, added: 4, removed: 4 });
    expect(model?.changes.some((change) => change.path === 'fake.ts')).toBe(false);
  });

  it('replays the deidentified four-file Codex session in protocol order with exact totals', () => {
    const fixture = codexFourFileSessionFixture();
    const model = resolveFilePatchRenderModel(fixture.startedTool);

    expect(model).toMatchObject({
      source: 'codex',
      status: 'completed',
      summary: { files: 4, added: 76, removed: 21 },
    });
    expect(model?.changes.map((change) => ({
      path: change.path?.replace('/workspace/0612-life-simulator/h5/', ''),
      added: change.added,
      removed: change.removed,
      hunks: change.rows.filter((row) => row.kind === 'hunk').length,
    }))).toEqual([
      { path: 'index.html', added: 0, removed: 1, hunks: 1 },
      { path: 'src/account.ts', added: 39, removed: 1, hunks: 3 },
      { path: 'src/analytics.ts', added: 23, removed: 6, hunks: 2 },
      { path: 'src/main.ts', added: 14, removed: 13, hunks: 1 },
    ]);

    const startedByPath = new Map(
      (fixture.startedTool.input as { changes: Array<{ path: string; diff: string }> })
        .changes.map((change) => [change.path, change.diff]),
    );
    expect(Object.keys(fixture.appliedChanges)).toEqual([
      '/workspace/0612-life-simulator/h5/src/main.ts',
      '/workspace/0612-life-simulator/h5/src/analytics.ts',
      '/workspace/0612-life-simulator/h5/index.html',
      '/workspace/0612-life-simulator/h5/src/account.ts',
    ]);
    expect(Object.entries(fixture.appliedChanges).every(
      ([path, applied]) => applied.type === 'update'
        && startedByPath.get(path) === applied.unifiedDiff,
    )).toBe(true);
  });

  it('treats hunk-like lines in Codex add content as source text', () => {
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [{
          path: '/tmp/hunk-example.md',
          kind: { type: 'add' },
          diff: 'before\n@@ -1 +1 @@\nafter',
        }],
      },
    });

    expect(model).toMatchObject({
      summary: { files: 1, added: 3, removed: 0 },
      changes: [{ lineNumbers: 'exact' }],
    });
    expect(model?.changes[0]?.rows.map((row) => row.text)).toEqual([
      'before', '@@ -1 +1 @@', 'after',
    ]);
  });

  it('excludes unified file headers from row statistics', () => {
    const parsed = parseUnifiedDiffRows(
      '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra',
      'update',
    );

    expect(parsed).toMatchObject({ added: 2, removed: 1, lineNumbers: 'exact' });
    expect(parsed.rows.some((row) => row.text === '-- a/a.ts')).toBe(false);
    expect(parsed.rows.some((row) => row.text === '++ b/a.ts')).toBe(false);
  });

  it('keeps changed code beginning with ++ or -- inside a valid hunk', () => {
    const parsed = parseUnifiedDiffRows('@@ -1 +1 @@\n---old\n+++new', 'update');

    expect(parsed).toMatchObject({ added: 1, removed: 1, lineNumbers: 'exact', valid: true });
    expect(parsed.rows.slice(1)).toEqual([
      { key: 'unified:1', kind: 'remove', oldLine: 1, marker: '-', text: '--old' },
      { key: 'unified:2', kind: 'add', newLine: 1, marker: '+', text: '++new' },
    ]);
  });

  it('rejects a truncated hunk instead of publishing partial exact statistics', () => {
    const parsed = parseUnifiedDiffRows('@@ -1,2 +1,2 @@\n-old\n+new', 'update');

    expect(parsed).toMatchObject({ added: 0, removed: 0, lineNumbers: 'unavailable', valid: false });
    expect(parsed.rows.every((row) => row.oldLine === undefined && row.newLine === undefined)).toBe(true);
  });

  it('fails closed for flat update text and malformed SDK output', () => {
    const flat = parseUnifiedDiffRows('-maybe old\n+maybe new', 'update');
    expect(flat).toMatchObject({ added: 0, removed: 0, lineNumbers: 'unavailable' });
    expect(flat.rows.every((row) => row.kind === 'context')).toBe(true);

    const malformed = resolveFilePatchRenderModel({
      name: 'Edit',
      input: { file_path: '/tmp/fallback.ts', old_string: 'old', new_string: 'new' },
      result: JSON.stringify({
        filePath: '/tmp/fallback.ts',
        oldString: 'old result',
        newString: 'new result',
        structuredPatch: [{ oldStart: 'oops', oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
      }),
    });
    expect(malformed?.changes[0]).toMatchObject({ path: '/tmp/fallback.ts', lineNumbers: 'unavailable' });
    expect(malformed?.changes[0]?.rows.map((row) => row.text)).toEqual(['old', 'new']);
  });

  it('keeps descriptor-only history visible without manufacturing body rows', () => {
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      display: {
        kind: 'file_patch',
        version: 1,
        source: 'codex',
        summary: { files: 1, added: 9, removed: 4 },
        changes: [{
          kind: 'update', path: '/tmp/history.ts', added: 9, removed: 4, view: { kind: 'unified-diff' },
        }],
      },
    });

    expect(model).toMatchObject({
      source: 'codex',
      summary: { files: 1, added: 9, removed: 4 },
      changes: [{ path: '/tmp/history.ts', rows: [], detailUnavailable: true }],
    });
  });

  it('keeps persisted descriptor metadata authoritative while materializing retained input', () => {
    const tool = {
      name: 'Write',
      inputJson: JSON.stringify({ file_path: '/tmp/history.md', content: 'retained body' }),
      display: {
        kind: 'file_patch' as const,
        version: 1 as const,
        source: 'external' as const,
        status: 'completed',
        userModified: true,
        writeMode: 'update' as const,
        summary: { files: 1, added: 1, removed: 1 },
        changes: [{
          kind: 'update',
          path: '/tmp/history.md',
          added: 1,
          removed: 1,
          view: { kind: 'content' as const },
        }],
      },
    };

    expect(resolveFilePatchRenderModel(tool)).toMatchObject({
      source: 'external',
      status: 'completed',
      userModified: true,
      writeMode: 'update',
      summary: { files: 1, added: 1, removed: 1 },
      changes: [{ kind: 'update', rows: [{ text: 'retained body' }] }],
    });
    expect(resolveFilePatchRenderModel(tool)?.changes[0]?.written).toBeUndefined();
  });

  it('keeps the legacy display consumer usable for SDK structured results', () => {
    const tool = {
      name: 'Edit',
      input: { file_path: '/tmp/sdk.ts', old_string: 'stale', new_string: 'preview' },
      result: JSON.stringify({
        filePath: '/tmp/sdk.ts',
        oldString: 'old',
        newString: 'new',
        originalFile: 'old',
        structuredPatch: [{
          oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-old', '+new'],
        }],
        userModified: false,
        replaceAll: false,
      }),
    };

    const descriptor = buildFilePatchDisplayDescriptor(tool);
    const display = resolveFilePatchDisplay({ ...tool, display: descriptor ?? undefined });
    expect(descriptor).toMatchObject({
      version: 1,
      summary: { files: 1, added: 1, removed: 1 },
      changes: [{ view: { kind: 'unified-diff' } }],
    });
    expect(display?.changes[0]?.view).toEqual({
      kind: 'unified-diff',
      diff: '@@ -5,1 +5,1 @@\n-old\n+new',
    });
  });

  it('parses only provenance-marked Gemini flat diffs and keeps relative line numbers', () => {
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        _displayName: 'replace',
        _geminiKind: 'edit',
        file_path: '/tmp/gemini.ts',
      },
      result: '--- /tmp/gemini.ts\n+++ /tmp/gemini.ts\n keep\n-old\n+new',
    });
    expect(model).toMatchObject({
      source: 'external',
      summary: { files: 1, added: 1, removed: 1 },
      changes: [{ path: '/tmp/gemini.ts', lineNumbers: 'relative' }],
    });

    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: { file_path: '/tmp/generic.ts' },
      result: '--- /tmp/generic.ts\n+++ /tmp/generic.ts\n-old\n+new',
    })).toBeNull();
  });

  it('fails closed for incomplete multi-file snapshots but retains a protocol-shaped diff-less move', () => {
    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [
          { path: '/tmp/complete.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' },
          { path: '/tmp/partial.ts', kind: { type: 'update', move_path: null } },
        ],
      },
    })).toBeNull();

    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [{ path: '/tmp/old.ts', kind: { type: 'update', move_path: '/tmp/new.ts' } }],
      },
      resultMeta: { status: 'declined' },
    })).toMatchObject({
      status: 'declined',
      changes: [{ kind: 'move', path: '/tmp/old.ts', movePath: '/tmp/new.ts', detailUnavailable: true }],
    });
  });

  it('prefers complete inputJson over stale parsed Codex snapshots', () => {
    const completeChanges = [
      { path: '/tmp/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old-a\n+new-a' },
      { path: '/tmp/b.ts', kind: { type: 'add' }, diff: 'new file' },
    ];
    const model = resolveFilePatchRenderModel({
      name: 'Edit',
      parsedInput: { changes: [completeChanges[0]] },
      inputJson: JSON.stringify({ changes: completeChanges }),
    });

    expect(model?.changes.map((change) => change.path)).toEqual(['/tmp/a.ts', '/tmp/b.ts']);
    expect(model?.summary).toEqual({ files: 2, added: 2, removed: 1 });

    const completedMove = resolveFilePatchRenderModel({
      name: 'Edit',
      parsedInput: {
        changes: [{ path: '/tmp/old.ts', kind: { type: 'update', move_path: '/tmp/new.ts' } }],
      },
      inputJson: JSON.stringify({
        changes: [{
          path: '/tmp/old.ts',
          kind: { type: 'update', move_path: '/tmp/new.ts' },
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      }),
    });
    expect(completedMove?.changes[0]).toMatchObject({ added: 1, removed: 1 });
    expect(completedMove?.changes[0]?.detailUnavailable).toBeUndefined();

    const richerWithoutRawJson = resolveFilePatchRenderModel({
      name: 'Edit',
      parsedInput: { changes: [completeChanges[0]] },
      input: { changes: completeChanges },
    });
    expect(richerWithoutRawJson?.summary.files).toBe(2);
  });

  it('does not publish a partial Codex parse while inputJson is still streaming', () => {
    const partialChange = {
      path: '/tmp/early.ts',
      kind: { type: 'update' },
      diff: '@@ -1 +1 @@\n-old\n+new',
    };
    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      parsedInput: { changes: [partialChange] },
      inputJson: `{"changes":[${JSON.stringify(partialChange)},`,
    })).toBeNull();
  });

  it('rejects incomplete SDK lookalikes and marks incoherent Write updates unavailable', () => {
    const fallback = resolveFilePatchRenderModel({
      name: 'Edit',
      input: { file_path: '/tmp/fallback.ts', old_string: 'old', new_string: 'new' },
      result: JSON.stringify({ filePath: '/tmp/fake.ts', structuredPatch: [] }),
    });
    expect(fallback).toMatchObject({
      source: 'builtin',
      changes: [{ path: '/tmp/fallback.ts', lineNumbers: 'unavailable', added: 1, removed: 1 }],
    });

    const unavailable = resolveFilePatchRenderModel({
      name: 'Write',
      input: { file_path: '/tmp/update.md', content: 'after' },
      result: JSON.stringify({
        type: 'update',
        filePath: '/tmp/update.md',
        content: 'after',
        originalFile: 'before',
        structuredPatch: [],
        userModified: false,
      }),
    });
    expect(unavailable).toMatchObject({
      writeMode: 'update',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [{ rows: [], lineNumbers: 'unavailable', detailUnavailable: true }],
    });

    const contradictoryNoOp = resolveFilePatchRenderModel({
      name: 'Write',
      result: JSON.stringify({
        type: 'update',
        filePath: '/tmp/contradictory.md',
        content: 'same',
        originalFile: 'same',
        structuredPatch: [],
        gitDiff: { patch: '@@ -1,2 +1,2 @@\n-old\n+new' },
      }),
    });
    expect(contradictoryNoOp).toMatchObject({
      summary: { files: 1, added: 0, removed: 0 },
      changes: [{ rows: [], lineNumbers: 'unavailable', detailUnavailable: true }],
    });
  });

  it('handles malformed JSON, no-op SDK output, and unknown structured kinds without throwing', () => {
    expect(resolveFilePatchRenderModel({
      name: 'Write',
      inputJson: '{"file_path":"/tmp/broken.md",',
      input: { file_path: '/tmp/fallback.md', content: '' },
    })).toMatchObject({
      writeMode: 'unknown',
      summary: { files: 1, added: 0, removed: 0 },
    });

    expect(resolveFilePatchRenderModel({
      name: 'Write',
      result: JSON.stringify({
        type: 'update', filePath: '/tmp/no-op.md', content: 'same', structuredPatch: [], originalFile: 'same',
      }),
    })).toMatchObject({
      writeMode: 'update',
      summary: { files: 1, added: 0, removed: 0 },
      changes: [{ rows: [] }],
    });

    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [{ path: '/tmp/unknown.ts', kind: { type: 'mystery' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
      },
    })).toMatchObject({
      summary: { files: 1, added: 1, removed: 1 },
      changes: [{ kind: 'mystery' }],
    });
  });

  it('projects large input without mutating the original tool payload', () => {
    const content = `${'line\n'.repeat(2_500)}`;
    const tool = { name: 'Write', input: { file_path: '/tmp/large.txt', content } };
    const before = JSON.stringify(tool);
    const model = resolveFilePatchRenderModel(tool);

    expect(model?.changes[0]?.rows).toHaveLength(2_500);
    expect(JSON.stringify(tool)).toBe(before);
    expect(tool.input.content).toBe(content);
  });

  it('bounds Codex files, rows, and characters before materializing renderer data', () => {
    const manyFiles = Array.from(
      { length: FILE_PATCH_MAX_FILE_BUDGET + 5 },
      (_, index) => ({
        path: `/tmp/file-${index}.ts`,
        kind: { type: 'add' },
        diff: `file ${index}`,
      }),
    );
    const fileBounded = resolveFilePatchRenderModel({
      name: 'Edit',
      input: { changes: manyFiles },
    });
    expect(fileBounded).toMatchObject({
      hasHiddenContent: true,
      summary: {
        files: FILE_PATCH_MAX_FILE_BUDGET + 5,
        added: FILE_PATCH_MAX_FILE_BUDGET + 5,
        removed: 0,
      },
    });
    expect(fileBounded?.changes).toHaveLength(FILE_PATCH_MAX_FILE_BUDGET);
    const descriptor = buildFilePatchDisplayDescriptor({
      name: 'Edit',
      input: { changes: manyFiles },
    });
    expect(descriptor).toMatchObject({
      hasHiddenContent: true,
      summary: {
        files: FILE_PATCH_MAX_FILE_BUDGET + 5,
        added: FILE_PATCH_MAX_FILE_BUDGET + 5,
        removed: 0,
      },
    });
    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      display: descriptor ?? undefined,
    })).toMatchObject({
      hasHiddenContent: true,
      summary: {
        files: FILE_PATCH_MAX_FILE_BUDGET + 5,
        added: FILE_PATCH_MAX_FILE_BUDGET + 5,
        removed: 0,
      },
    });

    const rowBounded = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [{
          path: '/tmp/rows.txt',
          kind: { type: 'add' },
          diff: 'row\n'.repeat(FILE_PATCH_MAX_ROW_BUDGET + 1),
        }],
      },
    });
    expect(rowBounded).toMatchObject({
      hasHiddenContent: true,
      changes: [{ hasHiddenContent: true }],
    });
    expect(rowBounded?.changes[0]?.rows).toHaveLength(FILE_PATCH_MAX_ROW_BUDGET);
    expect(rowBounded?.summary.added).toBe(FILE_PATCH_MAX_ROW_BUDGET + 1);

    const characterBounded = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        changes: [{
          path: '/tmp/characters.txt',
          kind: { type: 'add' },
          diff: 'x'.repeat(FILE_PATCH_MAX_CHARACTER_BUDGET + 1),
        }],
      },
    });
    expect(characterBounded).toMatchObject({
      hasHiddenContent: true,
      changes: [{ rows: [], detailUnavailable: true }],
    });
  });

  it('applies the shared row and character bounds to builtin and Gemini projections', () => {
    const oversizedWrite = resolveFilePatchRenderModel({
      name: 'Write',
      input: {
        file_path: '/tmp/write.txt',
        content: 'line\n'.repeat(FILE_PATCH_MAX_ROW_BUDGET + 2),
      },
    });
    expect(oversizedWrite).toMatchObject({
      hasHiddenContent: true,
      changes: [{ hasHiddenContent: true }],
    });
    expect(oversizedWrite?.changes[0]?.written).toBeUndefined();
    expect(oversizedWrite?.changes[0]?.rows).toHaveLength(FILE_PATCH_MAX_ROW_BUDGET);

    const oversizedGemini = resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        _displayName: 'replace',
        _geminiKind: 'edit',
        file_path: '/tmp/gemini.txt',
      },
      result: `--- /tmp/gemini.txt\n+++ /tmp/gemini.txt\n${'+line\n'.repeat(FILE_PATCH_MAX_ROW_BUDGET + 2)}`,
    });
    expect(oversizedGemini).toMatchObject({
      hasHiddenContent: true,
      summary: { added: FILE_PATCH_MAX_ROW_BUDGET, removed: 0 },
      changes: [{ hasHiddenContent: true }],
    });
    expect(oversizedGemini?.changes[0]?.rows).toHaveLength(FILE_PATCH_MAX_ROW_BUDGET);

    const oversizedInputJson = JSON.stringify({
      file_path: '/tmp/stale.txt',
      content: 'x'.repeat(FILE_PATCH_MAX_CHARACTER_BUDGET),
    });
    const fallback = resolveFilePatchRenderModel({
      name: 'Write',
      inputJson: oversizedInputJson,
      input: { file_path: '/tmp/fallback.txt', content: 'fallback' },
    });
    expect(fallback?.changes[0]?.path).toBe('/tmp/fallback.txt');

    const hugeSingleLine = 'x'.repeat(FILE_PATCH_MAX_CHARACTER_BUDGET * 2);
    const singleLineWrite = resolveFilePatchRenderModel({
      name: 'Write',
      input: { file_path: '/tmp/single.txt', content: hugeSingleLine },
    });
    expect(singleLineWrite).toMatchObject({
      hasHiddenContent: true,
      changes: [{ rows: [], hasHiddenContent: true }],
    });

    const singleLineGemini = resolveFilePatchRenderModel({
      name: 'Edit',
      input: { _displayName: 'replace', _geminiKind: 'edit' },
      result: `--- /tmp/single.txt\n+++ /tmp/single.txt\n+${hugeSingleLine}`,
    });
    expect(singleLineGemini).toMatchObject({
      hasHiddenContent: true,
      changes: [{ rows: [], hasHiddenContent: true }],
    });

    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        file_path: '/tmp/stale.ts',
        old_string: 'old proposal',
        new_string: 'stale proposal',
      },
      result: JSON.stringify({
        filePath: '/tmp/stale.ts',
        originalFile: 'x'.repeat(FILE_PATCH_MAX_CHARACTER_BUDGET),
        structuredPatch: [],
      }),
    })).toBeNull();

    expect(resolveFilePatchRenderModel({
      name: 'Edit',
      input: {
        file_path: '/tmp/spilled.ts',
        old_string: 'proposal-old',
        new_string: 'stale-proposal',
      },
      result: '{"filePath":"/tmp/spilled.ts","originalFile":"' + 'x'.repeat(8_000),
      resultMeta: {
        largeValueRef: { kind: 'ref', id: 'spilled-result' },
      },
    })).toBeNull();
  });
});
