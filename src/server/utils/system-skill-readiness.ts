import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

import {
  SYSTEM_SKILLS_VERSION,
  type RequiredSystemSkill,
} from '../../shared/systemSkills';
import { getHomeDirOrNull } from './platform';

export interface SystemSkillExposureInput {
  workspacePath: string;
  skillName: RequiredSystemSkill;
  /** Test seam; production defaults to ~/.myagents. */
  myagentsRoot?: string;
}

function pathIdentity(path: string): string {
  const canonical = normalize(realpathSync(path));
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

/**
 * Prove that a managed workflow will resolve the official system skill from
 * this workspace, rather than a disabled, missing, or project-shadowed copy.
 */
export function assertOfficialSystemSkillExposed(input: SystemSkillExposureInput): void {
  const myagentsRoot = input.myagentsRoot
    ?? join(getHomeDirOrNull() || '', '.myagents');
  if (!myagentsRoot || myagentsRoot === '.myagents') {
    throw new Error('MyAgents home directory is unavailable');
  }

  const versionPath = join(myagentsRoot, '.system-skills-version');
  let installedVersion: string;
  try {
    installedVersion = readFileSync(versionPath, 'utf-8').trim();
  } catch (error) {
    throw new Error(`system skill version is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (installedVersion !== SYSTEM_SKILLS_VERSION) {
    throw new Error(`system skill version ${installedVersion || '(empty)'} is not current (${SYSTEM_SKILLS_VERSION})`);
  }

  const officialDir = join(myagentsRoot, 'skills', input.skillName);
  const officialSkillMd = join(officialDir, 'SKILL.md');
  try {
    const officialEntry = lstatSync(officialDir);
    if (!officialEntry.isDirectory() || officialEntry.isSymbolicLink()) {
      throw new Error('official install is not an owned directory');
    }
    if (!statSync(officialSkillMd).isFile()) {
      throw new Error('official SKILL.md is missing');
    }
  } catch (error) {
    throw new Error(`official system skill ${input.skillName} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const exposedDir = join(input.workspacePath, '.claude', 'skills', input.skillName);
  try {
    const exposedEntry = lstatSync(exposedDir);
    if (!exposedEntry.isSymbolicLink()) {
      throw new Error('workspace entry is a project-owned shadow, not the official link');
    }
    if (pathIdentity(exposedDir) !== pathIdentity(officialDir)) {
      throw new Error('workspace link does not resolve to the official install');
    }
    if (!statSync(join(exposedDir, 'SKILL.md')).isFile()) {
      throw new Error('workspace-exposed SKILL.md is missing');
    }
  } catch (error) {
    throw new Error(`workspace does not expose official system skill ${input.skillName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
