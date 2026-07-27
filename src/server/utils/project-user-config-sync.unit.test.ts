import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMyAgentsUserDir, syncProjectUserConfigFiles, trySyncProjectUserConfigFiles } from './project-user-config-sync';

describe('project-user-config-sync', () => {
  const tempRoots: string[] = [];
  const itNonWindows = process.platform === 'win32' ? it.skip : it;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeEnv(): { root: string; home: string; workspace: string } {
    const root = join(tmpdir(), `myagents-project-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(temp, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    tempRoots.push(root);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('TMPDIR', temp);
    vi.stubEnv('TEMP', temp);
    vi.stubEnv('TMP', temp);
    return { root, home, workspace };
  }

  function writeUserSkill(home: string, name: string): void {
    const dir = join(home, '.myagents', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }

  function writeUserCommand(home: string, name: string): void {
    const dir = join(home, '.myagents', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  }

  it('links enabled MyAgents user skills into the project .claude/skills directory', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    const linkPath = join(workspace, '.claude', 'skills', 'review-helper');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(linkPath, 'SKILL.md'))).toBe(true);
    expect(getMyAgentsUserDir()).toBe(join(home, '.myagents'));
  });

  it('removes managed skill symlinks when the skill is disabled', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const linkPath = join(workspace, '.claude', 'skills', 'review-helper');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    const configPath = join(home, '.myagents', 'skills-config.json');
    writeFileSync(configPath, JSON.stringify({ disabled: ['review-helper'] }));

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(existsSync(linkPath)).toBe(false);
  });

  it('keeps all required system skills exposed while honoring an optional system skill disable', () => {
    const { home, workspace } = makeEnv();
    const required = [
      'myagents-memory-update',
      'myagents-memory-gardener',
      'myagents-memory-molt',
      'myagents-cli',
      'myagents-docs',
    ];
    for (const name of [...required, 'prompt-writer']) writeUserSkill(home, name);
    writeFileSync(
      join(home, '.myagents', 'skills-config.json'),
      JSON.stringify({ disabled: [...required, 'prompt-writer'] }),
    );

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    for (const name of required) {
      const linkPath = join(workspace, '.claude', 'skills', name);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
    expect(existsSync(join(workspace, '.claude', 'skills', 'prompt-writer'))).toBe(false);
  });

  it('does not overwrite real project skill directories', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const projectSkillDir = join(workspace, '.claude', 'skills', 'review-helper');
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(projectSkillDir, 'SKILL.md'), 'project-owned');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(lstatSync(projectSkillDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe('project-owned');
  });

  itNonWindows('replaces broken managed skill symlinks with current user skills', () => {
    const { home, root, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const linkPath = join(projectSkillsDir, 'review-helper');
    symlinkSync(join(root, 'missing-old-skill'), linkPath, 'dir');
    expect(existsSync(linkPath)).toBe(false);

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linkPath, 'SKILL.md'), 'utf-8')).toContain('review-helper');
  });

  itNonWindows('links MyAgents user commands into the project .claude/commands directory', () => {
    const { home, workspace } = makeEnv();
    writeUserCommand(home, 'ship-it');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    const linkPath = join(workspace, '.claude', 'commands', 'ship-it.md');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# ship-it\n');
  });

  itNonWindows('replaces broken managed command symlinks with current user commands', () => {
    const { home, root, workspace } = makeEnv();
    writeUserCommand(home, 'ship-it');
    const projectCommandsDir = join(workspace, '.claude', 'commands');
    mkdirSync(projectCommandsDir, { recursive: true });
    const linkPath = join(projectCommandsDir, 'ship-it.md');
    symlinkSync(join(root, 'missing-old-command.md'), linkPath);
    expect(existsSync(linkPath)).toBe(false);

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# ship-it\n');
  });

  it('reports sync failures without throwing from the tolerant wrapper', () => {
    const { home, root } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const workspaceFile = join(root, 'workspace-file');
    writeFileSync(workspaceFile, 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(trySyncProjectUserConfigFiles(workspaceFile, { cliToolRegistryEnabled: true }, 'test-sync')).toBe(false);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[test-sync] project user config sync failed; continuing without refreshed .claude config:'),
      expect.any(String),
    );
  });
});
