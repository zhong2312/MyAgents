import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'fs';
import type { Stats } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

import { isCliToolRegistryEnabled, loadConfig as loadAdminConfig } from './admin-config';
import { ensureDirSync, isDirEntry } from './fs-utils';
import { getCrossPlatformEnv, isSkillBlockedOnPlatform } from './platform';
import { isRequiredSystemSkill } from '../../shared/systemSkills';

const MYAGENTS_USER_DIR = '.myagents';

/**
 * Get the MyAgents user directory path.
 * All user configs (MCP, providers, projects, etc.) are stored here.
 */
export function getMyAgentsUserDir(): string {
  const { home, temp } = getCrossPlatformEnv();
  const homeDir = home || temp;
  return join(homeDir, MYAGENTS_USER_DIR);
}

export interface ProjectUserConfigSyncOptions {
  cliToolRegistryEnabled?: boolean;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function removeSymlinkPath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function trySyncProjectUserConfigFiles(
  projectDir: string,
  options: ProjectUserConfigSyncOptions = {},
  logPrefix = 'project-user-config-sync',
): boolean {
  try {
    syncProjectUserConfigFiles(projectDir, options);
    return true;
  } catch (err) {
    console.warn(
      `[${logPrefix}] project user config sync failed; continuing without refreshed .claude config:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Sync user-level skills and commands into a project's .claude/ as symlinks.
 *
 * This is the shared disk bridge used by builtin Claude SDK sessions and
 * external runtimes that want to consume the same MyAgents-managed project
 * protocol. It only mutates symlinks that point back into ~/.myagents and
 * never overwrites real project skill/command entries.
 */
export function syncProjectUserConfigFiles(
  projectDir: string,
  options: ProjectUserConfigSyncOptions = {},
): void {
  const myagentsDir = getMyAgentsUserDir();
  const isWin = process.platform === 'win32';

  const userSkillsDir = join(myagentsDir, 'skills');
  const projectSkillsDir = join(projectDir, '.claude', 'skills');

  if (existsSync(userSkillsDir)) {
    ensureDirSync(projectSkillsDir);

    let disabled: string[] = [];
    try {
      const configPath = join(myagentsDir, 'skills-config.json');
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        disabled = Array.isArray(raw?.disabled) ? raw.disabled : [];
      }
    } catch {
      // Ignore read errors — treat all skills as enabled.
    }

    const cliToolRegistryEnabled = options.cliToolRegistryEnabled ?? isCliToolRegistryEnabled(loadAdminConfig());
    const managedSkillNames = new Set<string>();

    for (const entry of readdirSync(userSkillsDir, { withFileTypes: true })) {
      const target = join(userSkillsDir, entry.name);
      if (!isDirEntry(entry, target)) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSkillBlockedOnPlatform(entry.name)) continue;
      if (!existsSync(join(target, 'SKILL.md'))) continue;

      managedSkillNames.add(entry.name);
      const linkPath = join(projectSkillsDir, entry.name);

      if (
        (disabled.includes(entry.name) && !isRequiredSystemSkill(entry.name))
        || (!cliToolRegistryEnabled && entry.name === 'tool-creator')
      ) {
        try {
          const linkMeta = lstatIfPresent(linkPath);
          if (linkMeta?.isSymbolicLink()) {
            removeSymlinkPath(linkPath);
          }
        } catch {
          // Ignore individual cleanup failures.
        }
        continue;
      }

      try {
        const linkMeta = lstatIfPresent(linkPath);
        if (linkMeta) {
          if (!linkMeta.isSymbolicLink()) continue;
          removeSymlinkPath(linkPath);
        }
      } catch {
        // Missing or racing path; recreate below.
      }

      try {
        symlinkSync(target, linkPath, isWin ? 'junction' : undefined);
      } catch (err) {
        console.warn(`[skill-sync] Failed to symlink skill ${entry.name}:`, err);
      }
    }

    try {
      for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
        const linkPath = join(projectSkillsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectSkillsDir, target);
          if (isInside(userSkillsDir, resolvedTarget) && !managedSkillNames.has(entry.name)) {
            removeSymlinkPath(linkPath);
          }
        } catch {
          // Ignore individual cleanup failures.
        }
      }
    } catch {
      // Ignore — projectSkillsDir may have been removed externally.
    }
  }

  const userCommandsDir = join(myagentsDir, 'commands');
  const projectCommandsDir = join(projectDir, '.claude', 'commands');

  if (existsSync(userCommandsDir)) {
    ensureDirSync(projectCommandsDir);
    const managedCommandFiles = new Set<string>();

    for (const entry of readdirSync(userCommandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;

      managedCommandFiles.add(entry.name);
      const linkPath = join(projectCommandsDir, entry.name);
      const target = join(userCommandsDir, entry.name);

      try {
        const linkMeta = lstatIfPresent(linkPath);
        if (linkMeta) {
          if (!linkMeta.isSymbolicLink()) continue;
          removeSymlinkPath(linkPath);
        }
      } catch {
        // Missing or racing path; recreate below.
      }

      try {
        symlinkSync(target, linkPath);
      } catch (err) {
        console.warn(`[command-sync] Failed to symlink command ${entry.name}:`, err);
      }
    }

    try {
      for (const entry of readdirSync(projectCommandsDir, { withFileTypes: true })) {
        const linkPath = join(projectCommandsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectCommandsDir, target);
          if (isInside(userCommandsDir, resolvedTarget) && !managedCommandFiles.has(entry.name)) {
            removeSymlinkPath(linkPath);
          }
        } catch {
          // Ignore individual cleanup failures.
        }
      }
    } catch {
      // Ignore — projectCommandsDir may have been removed externally.
    }
  }
}
