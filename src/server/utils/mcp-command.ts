import { existsSync } from 'fs';
import { dirname, resolve } from 'path';

import { pinPresetMcpPackageVersions } from '../../shared/mcpPackages';
import {
  findExistingPath,
  getBundledNodeDir,
  getBundledRuntimePath,
  getSystemNpxPaths,
} from './runtime';

export interface ResolvedNpxMcpInvocation {
  command: string;
  args: string[];
  source: 'system' | 'bundled' | 'runtime-sibling';
}

export class NpxMcpResolutionError extends Error {
  constructor() {
    super('No complete Windows Node.js distribution with npm/bin/npx-cli.js was found for MCP startup');
    this.name = 'NpxMcpResolutionError';
  }
}

function resolveWindowsNodeNpxInvocation(
  nodePath: string,
  args: string[],
  source: ResolvedNpxMcpInvocation['source'],
): ResolvedNpxMcpInvocation | null {
  const npxCliPath = resolve(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!existsSync(nodePath) || !existsSync(npxCliPath)) return null;
  return {
    command: nodePath,
    args: [npxCliPath, ...args],
    source,
  };
}

/**
 * Resolve a product-owned `npx` MCP invocation once, before handing it to an
 * SDK/runtime process. Both builtin Claude and managed Codex consume this
 * owner so they cannot drift on package pinning or bundled Node fallback.
 */
export function resolveNpxMcpInvocation(
  args: readonly string[],
  options: { pinPresetPackages?: boolean } = {},
): ResolvedNpxMcpInvocation {
  const normalizedArgs = options.pinPresetPackages
    ? pinPresetMcpPackageVersions(args)
    : [...args];
  const withYes = normalizedArgs.includes('-y') ? normalizedArgs : ['-y', ...normalizedArgs];

  if (process.platform === 'win32') {
    // Codex owns the final stdio spawn, so MyAgents cannot route a `.cmd`
    // shim through its subprocess adapter. Hand Codex a real executable and
    // structured argv from one complete Node distribution instead.
    for (const npxPath of getSystemNpxPaths()) {
      if (!existsSync(npxPath)) continue;
      const invocation = resolveWindowsNodeNpxInvocation(
        resolve(dirname(npxPath), 'node.exe'),
        withYes,
        'system',
      );
      if (invocation) return invocation;
    }

    const bundledNodeDir = getBundledNodeDir();
    if (bundledNodeDir) {
      const invocation = resolveWindowsNodeNpxInvocation(
        resolve(bundledNodeDir, 'node.exe'),
        withYes,
        'bundled',
      );
      if (invocation) return invocation;
    }

    const runtimePath = getBundledRuntimePath();
    const runtimeInvocation = resolveWindowsNodeNpxInvocation(
      runtimePath,
      withYes,
      'runtime-sibling',
    );
    if (runtimeInvocation) return runtimeInvocation;

    throw new NpxMcpResolutionError();
  }

  const systemNpx = findExistingPath(getSystemNpxPaths());
  if (systemNpx) {
    return { command: systemNpx, args: withYes, source: 'system' };
  }

  const bundledNodeDir = getBundledNodeDir();
  if (bundledNodeDir) {
    return {
      command: resolve(bundledNodeDir, 'npx'),
      args: withYes,
      source: 'bundled',
    };
  }

  const runtimePath = getBundledRuntimePath();
  return {
    command: resolve(dirname(runtimePath), 'npx'),
    args: withYes,
    source: 'runtime-sibling',
  };
}
