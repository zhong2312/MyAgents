import { describe, expect, it } from 'vitest';

import {
  resolveActionPath,
  resolveAgainstWorkspace,
  resolveFileActionTarget,
  resolveFileLinkTarget,
  resolveWorkspaceFileLinkTarget,
  toWorkspaceRelativePath,
} from './workspaceFileLinks';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';

describe('toWorkspaceRelativePath — total on missing input (restore-old-session crash)', () => {
  // A file-tool chip can pass an undefined `file_path` (partial/streaming or a
  // restored old block). This util must return null, never throw — an uncaught
  // throw here reaches the root error boundary and kills the whole app.
  it('returns null for nullish / empty / whitespace paths', () => {
    expect(toWorkspaceRelativePath(undefined, WORKSPACE)).toBeNull();
    expect(toWorkspaceRelativePath(null, WORKSPACE)).toBeNull();
    expect(toWorkspaceRelativePath('', WORKSPACE)).toBeNull();
    expect(toWorkspaceRelativePath('   ', WORKSPACE)).toBeNull();
  });
});

describe('resolveWorkspaceFileLinkTarget', () => {
  it('turns workspace absolute links into workspace-relative paths', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
    });
  });

  it('extracts line suffixes from absolute path links', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx:42`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
      initialLineNumber: 42,
    });
  });

  it('extracts #L line anchors', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx#L12-L18`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
      initialLineNumber: 12,
    });
  });

  it('supports file URLs and percent-encoded spaces', () => {
    expect(resolveWorkspaceFileLinkTarget(
      'file:///Users/zhihu/Documents/project/MyAgents/docs/My%20Note.md:7',
      WORKSPACE,
    )).toEqual({
      path: 'docs/My Note.md',
      initialLineNumber: 7,
    });
  });

  it('passes plausible workspace-relative links through', () => {
    expect(resolveWorkspaceFileLinkTarget('./src/renderer/App.tsx', WORKSPACE)).toEqual({
      path: 'src/renderer/App.tsx',
    });
    expect(resolveWorkspaceFileLinkTarget('package.json', WORKSPACE)).toEqual({
      path: 'package.json',
    });
  });

  it('rejects links outside the workspace and non-file schemes', () => {
    expect(resolveWorkspaceFileLinkTarget('/Users/zhihu/Other/file.ts', WORKSPACE)).toBeNull();
    expect(resolveWorkspaceFileLinkTarget('https://example.com/file.ts', WORKSPACE)).toBeNull();
    expect(resolveWorkspaceFileLinkTarget('mailto:a@example.com', WORKSPACE)).toBeNull();
  });

  it('rejects relative traversal that escapes workspace root', () => {
    expect(resolveWorkspaceFileLinkTarget('../outside.ts', WORKSPACE)).toBeNull();
  });
});

describe('resolveFileLinkTarget', () => {
  it('keeps workspace links on the workspace action path', () => {
    expect(resolveFileLinkTarget(`${WORKSPACE}/src/App.tsx#L9`, WORKSPACE)).toEqual({
      scope: 'workspace',
      path: 'src/App.tsx',
      initialLineNumber: 9,
    });
  });

  it('returns absolute local links outside the workspace as local targets', () => {
    expect(resolveFileLinkTarget('/Users/zhihu/Other/file.ts:12', WORKSPACE)).toEqual({
      scope: 'local',
      path: '/Users/zhihu/Other/file.ts',
      initialLineNumber: 12,
    });
  });

  it('supports file URLs outside the workspace', () => {
    expect(resolveFileLinkTarget('file:///Users/zhihu/Other/My%20Note.md#L3', WORKSPACE)).toEqual({
      scope: 'local',
      path: '/Users/zhihu/Other/My Note.md',
      initialLineNumber: 3,
    });
  });

  it('rejects non-file schemes', () => {
    expect(resolveFileLinkTarget('https://example.com/file.ts', WORKSPACE)).toBeNull();
    expect(resolveFileLinkTarget('mailto:a@example.com', WORKSPACE)).toBeNull();
  });
});

describe('resolveAgainstWorkspace', () => {
  it('joins a workspace-relative path to an absolute path', () => {
    expect(resolveAgainstWorkspace('myagents_files/generated_audio/tts_x.mp3', WORKSPACE))
      .toBe('/Users/zhihu/Documents/project/MyAgents/myagents_files/generated_audio/tts_x.mp3');
  });

  it('normalizes ./ and collapses redundant segments', () => {
    expect(resolveAgainstWorkspace('./a/b.mp3', WORKSPACE)).toBe(`${WORKSPACE}/a/b.mp3`);
    expect(resolveAgainstWorkspace('a/./b/../c.mp3', WORKSPACE)).toBe(`${WORKSPACE}/a/c.mp3`);
  });

  it('passes an already-absolute path through unchanged (posix)', () => {
    expect(resolveAgainstWorkspace('/Users/me/.myagents/generated/x.mp3', WORKSPACE))
      .toBe('/Users/me/.myagents/generated/x.mp3');
  });

  it('passes an already-absolute Windows path through unchanged', () => {
    expect(resolveAgainstWorkspace('C:\\Users\\me\\x.mp3', 'C:\\ws')).toBe('C:\\Users\\me\\x.mp3');
  });

  it('joins under a Windows workspace (forward-slashed; PathBuf normalizes)', () => {
    expect(resolveAgainstWorkspace('audio/x.mp3', 'C:\\Users\\me\\ws'))
      .toBe('C:/Users/me/ws/audio/x.mp3');
  });

  it('returns null for a relative path with no workspace', () => {
    expect(resolveAgainstWorkspace('audio/x.mp3', null)).toBeNull();
    expect(resolveAgainstWorkspace('audio/x.mp3', '')).toBeNull();
  });

  it('returns null when the relative path escapes the workspace root', () => {
    expect(resolveAgainstWorkspace('../../etc/passwd', WORKSPACE)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveAgainstWorkspace('', WORKSPACE)).toBeNull();
  });
});

describe('resolveActionPath', () => {
  it('normalizes an in-workspace absolute path to workspace-relative', () => {
    expect(resolveActionPath(`${WORKSPACE}/CLAUDE.md`, WORKSPACE)).toBe('CLAUDE.md');
    expect(resolveActionPath(`${WORKSPACE}/.claude/rules/04-MEMORY.md`, WORKSPACE))
      .toBe('.claude/rules/04-MEMORY.md');
  });

  it('passes a workspace-relative path through (normalized)', () => {
    expect(resolveActionPath('memory/2026-02-06.md', WORKSPACE)).toBe('memory/2026-02-06.md');
    expect(resolveActionPath('./src/App.tsx', WORKSPACE)).toBe('src/App.tsx');
  });

  it('leaves an absolute path OUTSIDE the workspace unchanged (backend will reject)', () => {
    expect(resolveActionPath('/etc/passwd', WORKSPACE)).toBe('/etc/passwd');
    expect(resolveActionPath('/Users/zhihu/Other/file.ts', WORKSPACE)).toBe('/Users/zhihu/Other/file.ts');
  });

  it('passes the raw path through when no workspace is known', () => {
    expect(resolveActionPath('memory/2026-02-06.md', null)).toBe('memory/2026-02-06.md');
    expect(resolveActionPath(`${WORKSPACE}/CLAUDE.md`, undefined)).toBe(`${WORKSPACE}/CLAUDE.md`);
  });

  it('passes a non-file-reference token through unchanged', () => {
    // toWorkspaceRelativePath can\'t classify it → fall back to the raw input.
    expect(resolveActionPath('foo', WORKSPACE)).toBe('foo');
  });
});

describe('resolveFileActionTarget', () => {
  it('normalizes an in-workspace absolute path to a workspace target', () => {
    expect(resolveFileActionTarget(`${WORKSPACE}/CLAUDE.md`, WORKSPACE)).toEqual({
      scope: 'workspace',
      path: 'CLAUDE.md',
    });
  });

  it('keeps an outside absolute path as a local target', () => {
    expect(resolveFileActionTarget('/Users/zhihu/Other/file.ts', WORKSPACE)).toEqual({
      scope: 'local',
      path: '/Users/zhihu/Other/file.ts',
    });
  });

  it('returns null for relative paths when no workspace is known', () => {
    expect(resolveFileActionTarget('src/App.tsx', null)).toBeNull();
  });

  it('supports file URLs, encoded spaces and line suffixes through the shared resolver', () => {
    expect(resolveFileActionTarget(
      'file:///Users/zhihu/Documents/project/MyAgents/docs/My%20Note.md:7',
      WORKSPACE,
    )).toEqual({
      scope: 'workspace',
      path: 'docs/My Note.md',
      initialLineNumber: 7,
    });
    expect(resolveFileActionTarget(
      'file:///Users/zhihu/Documents/project/MyAgents/docs/Issue%231.md',
      WORKSPACE,
    )).toEqual({
      scope: 'workspace',
      path: 'docs/Issue#1.md',
    });
  });

  it('preserves structured native filenames unless inline line parsing is requested', () => {
    expect(resolveFileActionTarget('/tmp/report:12', WORKSPACE)).toEqual({
      scope: 'local',
      path: '/tmp/report:12',
    });
    expect(resolveFileActionTarget('/tmp/report#L12', WORKSPACE)).toEqual({
      scope: 'local',
      path: '/tmp/report#L12',
    });
    expect(resolveFileActionTarget('/tmp/report:12', WORKSPACE, { parseLineReference: true })).toEqual({
      scope: 'local',
      path: '/tmp/report',
      initialLineNumber: 12,
    });
  });

  it('recognizes Windows UNC paths as local targets', () => {
    expect(resolveFileActionTarget('\\\\server\\share\\docs\\Guide.md', 'C:\\work')).toEqual({
      scope: 'local',
      path: '\\\\server\\share\\docs\\Guide.md',
    });
    expect(resolveFileActionTarget('file://server/share/docs/Guide.md', 'C:\\work')).toEqual({
      scope: 'local',
      path: '\\\\server\\share\\docs\\Guide.md',
    });
  });

  it('normalizes Windows drive paths and drive file URLs across separator forms', () => {
    const windowsWorkspace = 'C:\\Users\\me\\work';
    expect(resolveFileActionTarget('C:\\Users\\me\\work\\docs\\Guide.md', windowsWorkspace)).toEqual({
      scope: 'workspace',
      path: 'docs/Guide.md',
    });
    expect(resolveFileActionTarget('C:/Users/me/work/docs/Guide.md', windowsWorkspace)).toEqual({
      scope: 'workspace',
      path: 'docs/Guide.md',
    });
    expect(resolveFileActionTarget('file:///C:/Users/me/work/docs/Guide.md', windowsWorkspace)).toEqual({
      scope: 'workspace',
      path: 'docs/Guide.md',
    });
    expect(resolveFileActionTarget('\\\\?\\C:\\Users\\me\\docs\\Guide.md', windowsWorkspace)).toEqual({
      scope: 'local',
      path: '\\\\?\\C:\\Users\\me\\docs\\Guide.md',
    });
  });
});
