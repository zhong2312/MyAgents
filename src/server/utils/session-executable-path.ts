import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getMyAgentsNpmGlobalBinDir } from './npm-prefix-env';
import { getCrossPlatformEnv } from './platform';
import { getBundledNodeDir, getSystemNodeDirs } from './runtime';

export interface SessionExecutablePath {
  key: 'PATH' | 'Path';
  value: string;
  entries: string[];
  bundledNodeDir: string | null;
}

/**
 * Build the executable search path shared by real Agent sessions and probes.
 * GUI-launched processes do not inherit a login shell PATH, so app-owned and
 * conventional system runtime directories must be supplied explicitly.
 */
export function buildSessionExecutablePath(
  parentEnv: NodeJS.ProcessEnv = process.env,
): SessionExecutablePath {
  const { home } = getCrossPlatformEnv();
  const isWindows = process.platform === 'win32';
  const separator = isWindows ? ';' : ':';
  const key = isWindows ? 'Path' : 'PATH';
  const bundledNodeDir = getBundledNodeDir();
  const essentialPaths: string[] = [];

  for (const dir of getSystemNodeDirs()) {
    if (existsSync(dir)) essentialPaths.push(dir);
  }
  if (bundledNodeDir) essentialPaths.push(bundledNodeDir);

  const npmGlobalBinDir = getMyAgentsNpmGlobalBinDir(home);
  if (npmGlobalBinDir) essentialPaths.push(npmGlobalBinDir);

  if (home) {
    essentialPaths.push(isWindows
      ? resolve(home, '.myagents', 'bin')
      : `${home}/.myagents/bin`);
  }

  if (isWindows) {
    if (home) essentialPaths.push(resolve(home, '.bun', 'bin'));
    const programFiles = parentEnv.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = parentEnv['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = parentEnv.LOCALAPPDATA || '';
    essentialPaths.push(
      resolve(programFiles, 'Git', 'cmd'),
      resolve(programFilesX86, 'Git', 'cmd'),
      ...(localAppData ? [resolve(localAppData, 'Programs', 'Git', 'cmd')] : []),
    );
  } else {
    if (home) essentialPaths.push(`${home}/.bun/bin`);
    essentialPaths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  }

  const existingPath = parentEnv[key] || parentEnv.PATH || '';
  const entries = existingPath ? existingPath.split(separator) : [];
  const includesPath = (candidate: string): boolean => isWindows
    ? entries.some(entry => entry.toLowerCase() === candidate.toLowerCase())
    : entries.includes(candidate);

  for (const candidate of [...essentialPaths].reverse()) {
    if (candidate && !includesPath(candidate)) entries.unshift(candidate);
  }

  return {
    key,
    value: entries.join(separator),
    entries,
    bundledNodeDir,
  };
}
