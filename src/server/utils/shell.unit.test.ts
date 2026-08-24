import { describe, expect, it } from 'vitest';
import { buildFallbackPath, getFallbackPaths } from './shell';

describe('external runtime shell PATH fallback', () => {
  it('includes MyAgents-managed CLI locations on Windows', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\tester',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      Path: 'C:\\Windows\\System32',
    };

    const paths = getFallbackPaths({
      platform: 'win32',
      env,
      bundledNodeDir: 'C:\\Users\\tester\\AppData\\Local\\MyAgents\\nodejs',
    });

    expect(paths).toContain(
      'C:\\Users\\tester\\AppData\\Local\\MyAgents\\nodejs',
    );
    expect(paths).toContain('C:\\Users\\tester\\.myagents\\npm-global');
    expect(paths).toContain('C:\\Users\\tester\\.myagents\\bin');
    expect(paths.indexOf('C:\\Users\\tester\\.myagents\\bin')).toBeLessThan(
      paths.indexOf('C:\\Users\\tester\\AppData\\Roaming\\npm'),
    );
    expect(paths.indexOf('C:\\Users\\tester\\.myagents\\bin')).toBeLessThan(
      paths.indexOf('C:\\Users\\tester\\.myagents\\npm-global'),
    );
  });

  it('prepends fallback paths before the inherited Windows PATH', () => {
    const fallback = buildFallbackPath({
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        Path: 'C:\\Windows\\System32',
      },
      bundledNodeDir: 'C:\\Users\\tester\\AppData\\Local\\MyAgents\\nodejs',
    });

    expect(
      fallback.indexOf('C:\\Users\\tester\\AppData\\Local\\MyAgents\\nodejs'),
    ).toBeLessThan(fallback.indexOf('C:\\Windows\\System32'));
  });

  it('keeps the app CLI ahead of npm-global on Unix-like platforms', () => {
    const paths = getFallbackPaths({
      platform: 'darwin',
      env: { HOME: '/Users/tester', PATH: '/usr/bin' },
      bundledNodeDir:
        '/Applications/MyAgents.app/Contents/Resources/nodejs/bin',
      exists: () => false,
    });

    expect(paths).toContain('/Users/tester/.myagents/npm-global/bin');
    expect(paths).toContain('/Users/tester/.myagents/bin');
    expect(
      paths.indexOf('/Users/tester/.myagents/bin'),
    ).toBeLessThan(paths.indexOf('/Users/tester/.myagents/npm-global/bin'));
  });
});
