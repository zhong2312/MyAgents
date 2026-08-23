import { describe, expect, it } from 'vitest';

import {
  classifyInlineCodeTarget,
  looksLikeFilePath,
  shortenPathForDisplay,
} from '@/utils/pathDetection';

describe('classifyInlineCodeTarget', () => {
  it.each([
    ['https://example.com/a?b=1#c', { kind: 'web', url: 'https://example.com/a?b=1#c' }],
    ['HTTP://LOCALHOST:3000', { kind: 'web', url: 'HTTP://LOCALHOST:3000' }],
    ['https://example.com/file.ts', { kind: 'web', url: 'https://example.com/file.ts' }],
    ['docs/Product Guide.md', { kind: 'file', path: 'docs/Product Guide.md' }],
    ['桌面/产品介绍与使用说明.md', { kind: 'file', path: '桌面/产品介绍与使用说明.md' }],
    ['report.pdf', { kind: 'file', path: 'report.pdf' }],
    ['file:///Users/me/My%20Note.md', { kind: 'file', path: 'file:///Users/me/My%20Note.md' }],
    ['C:\\Users\\me\\docs\\Guide.md', { kind: 'file', path: 'C:\\Users\\me\\docs\\Guide.md' }],
    ['C:/Users/me/docs/Guide.md', { kind: 'file', path: 'C:/Users/me/docs/Guide.md' }],
    ['file:///C:/Users/me/docs/Guide.md', { kind: 'file', path: 'file:///C:/Users/me/docs/Guide.md' }],
    ['\\\\?\\C:\\Users\\me\\docs\\Guide.md', { kind: 'file', path: '\\\\?\\C:\\Users\\me\\docs\\Guide.md' }],
    ['https://', { kind: 'plain' }],
    ['https://example.com/%ZZ', { kind: 'plain' }],
    ['javascript:alert(1)', { kind: 'plain' }],
    ['foo://bar', { kind: 'plain' }],
    ['foo()', { kind: 'plain' }],
  ])('classifies %s', (input, expected) => {
    expect(classifyInlineCodeTarget(input)).toEqual(expected);
  });

  it('does not let the file heuristic steal HTTP(S) URLs', () => {
    expect(looksLikeFilePath('https://example.com/file.ts')).toBe(false);
  });
});

describe('shortenPathForDisplay', () => {
  it('shortens macOS and Windows user profile paths', () => {
    expect(shortenPathForDisplay('/Users/zhihu/Documents/project/MyAgents')).toBe('~/Documents/project/MyAgents');
    expect(shortenPathForDisplay('C:\\Users\\zhihu\\Documents\\project\\MyAgents')).toBe('~/Documents/project/MyAgents');
    expect(shortenPathForDisplay('D:/Users/zhihu/work/MyAgents')).toBe('~/work/MyAgents');
  });

  it('keeps non-user paths unchanged', () => {
    expect(shortenPathForDisplay('/opt/MyAgents')).toBe('/opt/MyAgents');
  });
});
