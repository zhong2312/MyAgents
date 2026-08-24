import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  findExistingPath: vi.fn(),
  getBundledNodeDir: vi.fn(),
  getBundledRuntimePath: vi.fn(),
  getSystemNpxPaths: vi.fn(),
}));

vi.mock('./runtime', () => runtimeMocks);

import { resolveNpxMcpInvocation } from './mcp-command';

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

function createWindowsNodeDistribution(root: string): {
  nodePath: string;
  npxPath: string;
  npxCliPath: string;
} {
  const nodePath = join(root, 'node.exe');
  const npxPath = join(root, 'npx.cmd');
  const npxCliPath = join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  touch(nodePath);
  touch(npxPath);
  touch(npxCliPath);
  return { nodePath, npxPath, npxCliPath };
}

describe('resolveNpxMcpInvocation', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'myagents-npx-'));
    runtimeMocks.findExistingPath.mockReset().mockReturnValue(null);
    runtimeMocks.getBundledNodeDir.mockReset().mockReturnValue(null);
    runtimeMocks.getBundledRuntimePath.mockReset().mockReturnValue('node');
    runtimeMocks.getSystemNpxPaths.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('projects Windows system npx through node.exe and the absolute npx CLI entry', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const system = createWindowsNodeDistribution(join(testRoot, 'system-node'));
    runtimeMocks.getSystemNpxPaths.mockReturnValue([system.npxPath]);

    expect(resolveNpxMcpInvocation(['@playwright/mcp@0.0.68'])).toEqual({
      command: system.nodePath,
      args: [system.npxCliPath, '-y', '@playwright/mcp@0.0.68'],
      source: 'system',
    });
  });

  it('skips an incomplete Windows system shim and uses the complete bundled distribution', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const incompleteSystemNpx = join(testRoot, 'incomplete-system', 'npx.cmd');
    touch(incompleteSystemNpx);
    const bundled = createWindowsNodeDistribution(join(testRoot, 'bundled-node'));
    runtimeMocks.getSystemNpxPaths.mockReturnValue([incompleteSystemNpx]);
    runtimeMocks.getBundledNodeDir.mockReturnValue(dirname(bundled.nodePath));

    expect(resolveNpxMcpInvocation(['package-name', '--flag'])).toEqual({
      command: bundled.nodePath,
      args: [bundled.npxCliPath, '-y', 'package-name', '--flag'],
      source: 'bundled',
    });
  });

  it('fails closed on Windows when no complete Node and npx CLI pair exists', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const incompleteSystemNpx = join(testRoot, 'incomplete-system', 'npx.cmd');
    touch(incompleteSystemNpx);
    runtimeMocks.getSystemNpxPaths.mockReturnValue([incompleteSystemNpx]);

    expect(() => resolveNpxMcpInvocation(['package-name'])).toThrow(
      'No complete Windows Node.js distribution with npm/bin/npx-cli.js was found for MCP startup',
    );
  });

  it('keeps the direct absolute npx executable contract on non-Windows platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    runtimeMocks.findExistingPath.mockReturnValue('/usr/local/bin/npx');
    runtimeMocks.getSystemNpxPaths.mockReturnValue(['/usr/local/bin/npx']);

    expect(resolveNpxMcpInvocation(['package-name', '-y'])).toEqual({
      command: '/usr/local/bin/npx',
      args: ['package-name', '-y'],
      source: 'system',
    });
  });
});
