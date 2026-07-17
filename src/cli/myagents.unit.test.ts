import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  formatCronInstantForDisplay,
  formatCronTaskScheduleForDisplay,
  buildRequestBody,
  buildRoute,
  buildClaimCancelBody,
  buildSpaceCompleteOperationKey,
  normalizeScheduleFlag,
  parseArgs,
  parseDispatchAtValue,
  printResult,
  readWorkspaceTextFile,
  rejectUnsupportedSpaceDryRun,
} from './myagents';

describe('myagents CLI Space issue contracts', () => {
  it('routes Goal discovery and builds scoped Goal/update request bodies', () => {
    expect(buildRoute('space', 'goal', ['list'])).toBe('space/goal-list');
    expect(buildRequestBody('space', 'goal', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeArchived: true,
    })).toMatchObject({
      spaceSlug: 'official',
      workspacePath: '/workspace',
      includeArchived: true,
    });

    expect(buildRoute('space', 'issue', ['update', 'iss_1'])).toBe('space/issue-update');
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'Updated title',
      goal: 'goal_cli',
      humanOnly: 'false',
    })).toMatchObject({
      spaceSlug: 'official',
      issueId: 'iss_1',
      title: 'Updated title',
      goalUpdate: { action: 'set', goalId: 'goal_cli' },
      humanOnly: false,
    });
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      clearGoal: true,
    })).toMatchObject({
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });
    const titleOnly = buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'No Goal change',
    });
    expect(titleOnly).not.toHaveProperty('goalUpdate');
  });

  it('parses presence flags and explicit human-only booleans without swallowing later flags', () => {
    expect(parseArgs([
      'space', 'goal', 'list', '--space', 'official', '--include-archived', '--json',
    ])).toMatchObject({
      positional: ['space', 'goal', 'list'],
      flags: { space: 'official', includeArchived: true, json: true },
    });
    expect(parseArgs([
      'space', 'issue', 'update', 'iss_1', '--clear-goal', '--json', '--human-only', 'false',
    ])).toMatchObject({
      positional: ['space', 'issue', 'update', 'iss_1'],
      flags: { clearGoal: true, json: true, humanOnly: 'false' },
    });
    expect(parseArgs(['--human-only'])).toMatchObject({ flags: { humanOnly: true } });
    expect(parseArgs(['--human-only=true'])).toMatchObject({ flags: { humanOnly: 'true' } });
    expect(parseArgs(['--human-only=false'])).toMatchObject({ flags: { humanOnly: 'false' } });
    expect(parseArgs(['--human-only', 'maybe', '--json'])).toMatchObject({
      positional: ['maybe'],
      flags: { humanOnly: true, humanOnlyInvalidValue: 'maybe', json: true },
    });
  });

  it('accepts the existing goalId alias and each single body source for update', () => {
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      goalId: 'goal_legacy_alias',
    })).toMatchObject({
      issueId: 'iss_1',
      goalUpdate: { action: 'set', goalId: 'goal_legacy_alias' },
    });
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      body: 'replacement body',
    })).toMatchObject({ issueId: 'iss_1', body: 'replacement body' });

    const dir = mkdtempSync(join(process.cwd(), '.space-update-body-test-'));
    try {
      const bodyPath = join(dir, 'issue.md');
      writeFileSync(bodyPath, 'body from file', 'utf8');
      expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
        space: 'official',
        workspacePath: dir,
        bodyFile: bodyPath,
      })).toMatchObject({ issueId: 'iss_1', body: 'body from file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes advertised Issue list booleans before Rust deserialization', () => {
    expect(buildRequestBody('space', 'issue', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeSubtree: 'false',
      humanOnly: 'true',
    })).toMatchObject({ includeSubtree: false, humanOnly: true });
    expect(buildRequestBody('space', 'issue', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeSubtree: 'true',
      humanOnly: 'false',
    })).toMatchObject({ includeSubtree: true, humanOnly: false });
  });

  it('keeps bare human-only compatible before a positional Issue id', () => {
    const { positional, flags } = parseArgs([
      'space', 'issue', 'update', '--human-only', 'iss_1', '--space', 'official',
    ]);
    expect(buildRequestBody(positional[0], positional[1], positional.slice(2), {
      ...flags,
      workspacePath: '/workspace',
    })).toMatchObject({ issueId: 'iss_1', humanOnly: true });
  });

  it('returns one structured local error for update conflicts, invalid booleans, and empty updates', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ json: true, space: 'official', goal: 'goal_1', clearGoal: true }, 'GOAL_SELECTION_CONFLICT'],
        [{ json: true, space: 'official', body: 'body', bodyFile: 'issue.md' }, 'BODY_SOURCE_CONFLICT'],
        [{ json: true, space: 'official', body: 'body', stdin: true }, 'BODY_SOURCE_CONFLICT'],
        [{ json: true, space: 'official', humanOnly: 'maybe' }, 'BOOLEAN_VALUE_INVALID'],
        [{ json: true, space: 'official', goal: true }, 'FLAG_VALUE_REQUIRED'],
        [{ json: true, space: 'official' }, 'ISSUE_UPDATE_EMPTY'],
      ];
      for (const [flags, code] of cases) {
        expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
          workspacePath: '/workspace',
          ...flags,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code,
          suggestion: expect.any(String),
        });
      }
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it('rejects explicit empty Goal values on create instead of silently creating Inbox', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      for (const goalFlags of [{ goal: '' }, { goalId: '' }, { goal: true }]) {
        expect(() => buildRequestBody('space', 'issue', ['create'], {
          json: true,
          space: 'official',
          title: 'Must not publish',
          body: 'Explicit empty Goal is invalid.',
          ...goalFlags,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code: 'FLAG_VALUE_REQUIRED',
        });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('validates the update identity before metadata fields', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['update'], {
        json: true,
        space: 'official',
        title: 'x',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'ARGUMENT_REQUIRED' });

      expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
        json: true,
        title: 'x',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'SPACE_REQUIRED' });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('rejects non-metadata update flags instead of partially applying a patch', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      for (const forbidden of [
        { state: 'done' },
        { assignee: 'agent:other' },
        { attachment: 'result.png' },
        { deliveryId: 'delivery_1' },
        { rollback: true },
        { expectedNotificationVersion: '4' },
        { localTaskId: 'task_1' },
      ]) {
        expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
          json: true,
          space: 'official',
          title: 'partial update must not happen',
          ...forbidden,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code: 'UPDATE_FIELD_UNSUPPORTED',
        });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('requires an explicit include-subtree boolean and rejects malformed list booleans', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const cases: Array<[string[], string]> = [
        [['--include-subtree', '--json'], 'FLAG_VALUE_REQUIRED'],
        [['--include-subtree', 'maybe', '--json'], 'BOOLEAN_VALUE_INVALID'],
      ];
      for (const [args, code] of cases) {
        const { flags } = parseArgs(['--space', 'official', ...args]);
        expect(() => buildRequestBody('space', 'issue', ['list'], {
          ...flags,
          workspacePath: '/workspace',
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('does not confuse a repeated Issue id with bare human-only syntax', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const { positional, flags } = parseArgs([
        'space', 'issue', 'update', 'iss_1', '--human-only', 'iss_1', '--space', 'official', '--json',
      ]);
      expect(() => buildRequestBody(positional[0], positional[1], positional.slice(2), {
        ...flags,
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        code: 'BOOLEAN_VALUE_INVALID',
      });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('keeps executable recovery commands visible with human suggestions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      printResult('space', 'issue', {
        success: false,
        error: 'Goal is archived.',
        suggestion: 'List active Goals and retry.',
        suggestedCommand: 'myagents space goal list --space official --json',
      }, false);
      expect(error.mock.calls.map(call => String(call[0]))).toEqual([
        'Error: Goal is archived.',
        'Suggestion: List active Goals and retry.',
        '  \u2192 Run: myagents space goal list --space official --json',
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('rejects unsupported Space mutation dry-runs before any HTTP call', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const mutations = [
        ['space', 'issue', 'create'],
        ['space', 'issue', 'update', 'iss_1'],
        ['space', 'issue', 'comment', 'iss_1'],
        ['space', 'issue', 'status', 'iss_1'],
        ['space', 'issue', 'claim', 'iss_1'],
        ['space', 'issue', 'delivery', 'ignore', 'delivery_1'],
        ['space', 'issue', 'attachment', 'add', 'iss_1'],
        ['space', 'issue', 'close', 'iss_1'],
        ['space', 'issue', 'complete', 'iss_1'],
        ['space', 'issue', 'cancel-claim', 'iss_1'],
        ['space', 'claim', 'local-task', 'iss_1'],
        ['space', 'attachment', 'add', 'iss_1'],
        ['space', 'attachment', 'download', 'att_1'],
      ];
      for (const positional of mutations) {
        expect(() => rejectUnsupportedSpaceDryRun(
          positional,
          { json: true, dryRun: true, space: 'official' },
        ), positional.join(' ')).toThrow('process.exit(2)');
        const nestedIssueLeaf = positional[1] === 'issue'
          && (positional[2] === 'delivery' || positional[2] === 'attachment');
        const expectedCommand = positional.slice(0, nestedIssueLeaf ? 4 : 3).join(' ');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          suggestion: expect.stringContaining(`Read myagents ${expectedCommand} --help`),
        });
      }
      expect(() => rejectUnsupportedSpaceDryRun(
        ['space', 'issue', 'update'],
        { json: true, dryRun: true, space: 'official', issueId: 'iss_alias' },
      )).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'DRY_RUN_UNSUPPORTED',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(() => rejectUnsupportedSpaceDryRun(
        ['space', 'goal', 'list'],
        { json: true, dryRun: true, space: 'official' },
      )).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('routes and builds exact comment lookup by issue and comment id', () => {
    expect(buildRoute('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1']))
      .toBe('space/issue-comment-get');
    expect(buildRequestBody('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1'], {
      space: 'official',
      workspacePath: '/workspace',
      agentId: 'rag_1',
    })).toEqual({
      issueId: 'iss_1',
      commentId: 'comment_1',
      spaceSlug: 'official',
      sessionId: undefined,
      workspaceId: undefined,
      agentId: 'rag_1',
      workspacePath: '/workspace',
    });
  });

  it('keeps the Issue detail default comment window at five', () => {
    expect(buildRequestBody('space', 'issue', ['view', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
    })).toMatchObject({
      issueId: 'iss_1',
      commentsLimit: undefined,
      commentsCursor: undefined,
    });
    expect(buildRoute('space', 'issue', ['comments', 'iss_1']))
      .toBe('space/issue-comments');
    expect(buildRequestBody('space', 'issue', ['comments', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      cursor: 'opaque-cursor',
    })).toMatchObject({
      issueId: 'iss_1',
      cursor: 'opaque-cursor',
      limit: 20,
    });
  });

  it('uses claim origin to constrain attached-task rollback', () => {
    const claimBody = { issueId: 'iss_1', agentId: 'rag_1', workspacePath: '/workspace' };
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_1', origin: 'self_claim' }, notificationVersion: 7 },
    })).toMatchObject({ rollback: true, expectedNotificationVersion: 7 });
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_2', origin: 'assignment_confirmation' }, notificationVersion: 9 },
    })).toEqual({
      ...claimBody,
      rollback: true,
    });
  });

  it('generates a stable completion operation key bound to Issue, Task, and result', () => {
    const input = { issueId: 'iss_1', taskOrSessionId: 'task_1', resultComment: 'done' };
    expect(buildSpaceCompleteOperationKey(input)).toBe(buildSpaceCompleteOperationKey(input));
    expect(buildSpaceCompleteOperationKey(input)).not.toBe(
      buildSpaceCompleteOperationKey({ ...input, resultComment: 'different result' }),
    );
  });

  it('builds scoped atomic create/comment requests and the top-level attachment route', () => {
    expect(buildRequestBody('space', 'issue', ['create'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'A new issue',
      body: 'Details',
      assignee: 'agent:regagent_1',
      attachment: ['one.png'],
      file: ['two.log'],
    })).toMatchObject({
      spaceSlug: 'official',
      title: 'A new issue',
      body: 'Details',
      assigneeId: 'agent:regagent_1',
      filePaths: ['one.png', 'two.log'],
    });

    expect(buildRequestBody('space', 'issue', ['comment', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      attachment: ['evidence.zip'],
    })).toMatchObject({
      issueId: 'iss_1',
      body: '',
      filePaths: ['evidence.zip'],
    });

    expect(buildRoute('space', 'issue', ['attachment', 'add', 'iss_1']))
      .toBe('space/attachment-add');
    expect(buildRequestBody('space', 'issue', ['attachment', 'add', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      file: ['report.pdf'],
    })).toMatchObject({ issueId: 'iss_1', filePaths: ['report.pdf'] });
  });

  it('collects both repeatable attachment flag spellings', () => {
    expect(parseArgs([
      'space', 'issue', 'comment', 'iss_1',
      '--space', 'official',
      '--attachment', 'a.png',
      '--attachment=b.log',
      '--file', 'c.zip',
    ])).toMatchObject({
      flags: {
        space: 'official',
        attachment: ['a.png', 'b.log'],
        file: ['c.zip'],
      },
    });
  });

  it('does not let a missing attachment value consume the following JSON flag', () => {
    expect(parseArgs([
      'space', 'issue', 'create',
      '--space', 'official',
      '--title', 'Title',
      '--body', 'Body',
      '--attachment',
      '--json',
    ])).toMatchObject({
      flags: {
        json: true,
        attachment: [],
        attachmentValueMissing: true,
      },
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const { flags } = parseArgs([
        '--space', 'official',
        '--title', 'Title',
        '--body', 'Body',
        '--file',
        '--json',
      ]);
      expect(() => buildRequestBody('space', 'issue', ['create'], flags)).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'FLAG_VALUE_REQUIRED',
        suggestion: expect.any(String),
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it('emits a structured recovery contract when a Space slug is missing in JSON mode', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['view', 'iss_1'], {
        json: true,
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        success: false,
        code: 'SPACE_REQUIRED',
        error: 'This command requires --space <slug>.',
        suggestion: 'Run `myagents space list --json`, then retry with one returned slug.',
        suggestedCommand: 'myagents space list --json',
      });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('keeps local Space validation machine-readable in JSON mode', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['create'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
        title: 'Missing body',
        body: '   ',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ISSUE_BODY_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(() => buildRequestBody('space', 'issue', ['attachment', 'add', 'iss_1'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ATTACHMENT_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(() => buildRequestBody('space', 'issue', ['create'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
        title: true,
        body: 'A title flag without a value must not throw a TypeError.',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ARGUMENT_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });
});

describe('myagents CLI Goal file inputs', () => {
  it('reads shell-sensitive objective and reason text from workspace files', () => {
    const dir = mkdtempSync(join(process.cwd(), '.goal-cli-test-'));
    try {
      const objectivePath = join(dir, 'objective.txt');
      const reasonPath = join(dir, 'reason.txt');
      const objective = 'finish $(touch should-not-run) with `literal` and "quotes"';
      const reason = 'verified $HOME without shell expansion';
      writeFileSync(objectivePath, objective, 'utf8');
      writeFileSync(reasonPath, reason, 'utf8');

      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
      })).toEqual({ objective });
      expect(buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reasonFile: reasonPath,
      })).toEqual({ status: 'complete', reason });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace, symlinks, oversized files, and NUL bytes', () => {
    const root = mkdtempSync(join(process.cwd(), '.goal-cli-safety-test-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    try {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'outside', 'utf8');
      expect(() => readWorkspaceTextFile(outside, workspace)).toThrow(/inside workspace/);

      const target = join(workspace, 'target.txt');
      const link = join(workspace, 'link.txt');
      writeFileSync(target, 'target', 'utf8');
      symlinkSync(target, link);
      expect(() => readWorkspaceTextFile(link, workspace)).toThrow(/symlink/);

      const oversized = join(workspace, 'oversized.txt');
      writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 1), 'utf8');
      expect(() => readWorkspaceTextFile(oversized, workspace)).toThrow(/exceeds/);

      const nul = join(workspace, 'nul.txt');
      writeFileSync(nul, 'before\0after', 'utf8');
      expect(() => readWorkspaceTextFile(nul, workspace)).toThrow(/NUL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects inline and positional Goal text before building an API request', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('goal', 'create', [], {
        objective: '$(touch should-not-run)',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', ['positional objective'], {}))
        .toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reason: '`touch should-not-run`',
      })).toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('myagents CLI parseArgs', () => {
  it('normalizes file-only Goal flags to camelCase', () => {
    expect(parseArgs([
      'goal',
      'create',
      '--objective-file',
      'myagents_files/objective.txt',
    ])).toMatchObject({
      positional: ['goal', 'create'],
      flags: { objectiveFile: 'myagents_files/objective.txt' },
    });
  });

  it('collects consecutive values for repeatable flags', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'sensenova-6.7-flash-lite',
      'deepseek-v4-flash',
      'glm-5.2',
      '--primary-model',
      'sensenova-6.7-flash-lite',
    ])).toMatchObject({
      positional: ['model', 'add'],
      flags: {
        models: ['sensenova-6.7-flash-lite', 'deepseek-v4-flash', 'glm-5.2'],
        primaryModel: 'sensenova-6.7-flash-lite',
      },
    });
  });

  it('appends repeated repeatable flags instead of overwriting them', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      '--models',
      'B',
      '--models=C',
    ])).toMatchObject({
      flags: { models: ['A', 'B', 'C'] },
    });
  });

  it('keeps model names aligned when both model lists use consecutive values', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      'B',
      '--model-names',
      'Model A',
      'Model B',
    ])).toMatchObject({
      flags: {
        models: ['A', 'B'],
        modelNames: ['Model A', 'Model B'],
      },
    });
  });

  it('still accepts dash-prefixed values as the first repeatable value', () => {
    expect(parseArgs([
      'mcp',
      'add',
      '--args',
      '--stdio',
      'server.js',
      '--env',
      'TOKEN=secret',
    ])).toMatchObject({
      flags: {
        args: ['--stdio', 'server.js'],
        env: ['TOKEN=secret'],
      },
    });
  });
});

describe('myagents CLI cron time handling', () => {
  it('adds a default IANA timezone to bare cron schedules on create paths', () => {
    expect(normalizeScheduleFlag('0 9 * * *', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('leaves bare cron schedules timezone-free for update inheritance', () => {
    expect(normalizeScheduleFlag('0 9 * * *')).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
    });
  });

  it('fills missing JSON cron timezone on create but preserves explicit UTC', () => {
    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });

    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'UTC',
    });
  });

  it('rejects retired loop schedules from ordinary cron commands', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => normalizeScheduleFlag('{"kind":"loop"}')).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Goal Mode'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('myagents goal create --objective-file'));
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('requires explicit offset or Z for one-shot dispatchAt strings', () => {
    expect(parseDispatchAtValue('2026-06-01T09:00:00+08:00')).toBe(Date.parse('2026-06-01T09:00:00+08:00'));
    expect(parseDispatchAtValue('2026-06-01T01:00:00Z')).toBe(Date.parse('2026-06-01T01:00:00Z'));
    expect(() => parseDispatchAtValue('2026-06-01T09:00:00')).toThrow(/explicit timezone offset or Z/);
  });

  it('marks legacy cron schedules without tz as UTC by default in display text', () => {
    expect(formatCronTaskScheduleForDisplay({
      schedule: { kind: 'cron', expr: '0 9 * * *' },
    }, 'long')).toBe('0 9 * * * @ UTC(default)');
  });

  it('formats instants with timezone name and offset for human output', () => {
    expect(formatCronInstantForDisplay('2026-07-09T01:00:00Z', 'Asia/Shanghai', 'long'))
      .toBe('2026-07-09 09:00 Asia/Shanghai (UTC+08:00)');
  });
});
