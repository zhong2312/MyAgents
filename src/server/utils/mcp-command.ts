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

  const systemNpx = findExistingPath(getSystemNpxPaths());
  if (systemNpx) {
    return { command: systemNpx, args: withYes, source: 'system' };
  }

  const bundledNodeDir = getBundledNodeDir();
  if (bundledNodeDir) {
    return {
      command: resolve(bundledNodeDir, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
      args: withYes,
      source: 'bundled',
    };
  }

  const runtimePath = getBundledRuntimePath();
  return {
    command: resolve(dirname(runtimePath), process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    args: withYes,
    source: 'runtime-sibling',
  };
}
