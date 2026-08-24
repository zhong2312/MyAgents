import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REQUIRED_SYSTEM_SKILLS } from '../shared/systemSkills';
import { createGlobalSkillInventorySnapshot } from './global-skill-inventory';

const roots: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name}\n---\nRun.\n`;
}

function makeSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'myagents-skill-integrity-'));
  roots.push(root);
  const skillsRoot = join(root, 'skills');
  for (const name of REQUIRED_SYSTEM_SKILLS) {
    write(join(skillsRoot, name, 'SKILL.md'), skill(name));
  }
  return skillsRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('global Skill inventory', () => {
  it('blocks strong collision evidence while preserving warning-only Skills', () => {
    const root = makeSkillsRoot();
    write(join(root, 'pdf', 'SKILL(1).md'), skill('pdf'));
    write(join(root, 'pdf(2)', 'SKILL.md'), skill('pdf'));
    write(join(root, 'chapter(2)', 'SKILL.md'), skill('chapter-two'));
    write(join(root, 'reserved-entry', 'SKILL.md'), skill('reserved-entry'));
    write(join(root, 'reserved-entry', 'SKILL (3).md'), skill('old-copy'));

    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });

    expect(snapshot.entries.map(entry => entry.folderName)).toContain('chapter(2)');
    expect(snapshot.entries.map(entry => entry.folderName)).toContain('reserved-entry');
    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('pdf');
    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('pdf(2)');
    expect(snapshot.integrityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ folderName: 'pdf', reason: 'missing_canonical_entry', severity: 'blocked' }),
      expect.objectContaining({ folderName: 'pdf(2)', reason: 'collision_directory_identity', severity: 'blocked' }),
      expect.objectContaining({ folderName: 'chapter(2)', reason: 'unproven_suffix_directory', severity: 'warning' }),
      expect.objectContaining({ folderName: 'reserved-entry', reason: 'reserved_entry_sibling', severity: 'warning' }),
    ]));
  });

  it('reports a missing required Skill without rejecting the remaining inventory', () => {
    const root = makeSkillsRoot();
    rmSync(join(root, 'myagents-cli'), { recursive: true, force: true });
    mkdirSync(join(root, 'optional-broken'), { recursive: true });
    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });

    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('myagents-cli');
    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'myagents-cli',
      reason: 'missing_required_skill',
    }));
    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'optional-broken',
      required: false,
    }));
  });

  it('does not let a non-directory Required slot hide its diagnostic', () => {
    const root = makeSkillsRoot();
    rmSync(join(root, 'myagents-cli'), { recursive: true, force: true });
    writeFileSync(join(root, 'myagents-cli'), 'not a Skill directory');

    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });

    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'myagents-cli',
      reason: 'missing_required_skill',
    }));
  });

  it('keeps the observed candidates when the root changes after enumeration', () => {
    const root = makeSkillsRoot();
    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
      testHooks: {
        afterRootEnumeration: () => mkdirSync(join(root, 'late-arrival')),
      },
    });
    expect(snapshot.entries.map(entry => entry.folderName)).toEqual(
      expect.arrayContaining([...REQUIRED_SYSTEM_SKILLS]),
    );
    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('late-arrival');
  });

  it('blocks a slot whose canonical identity changes during its scan', () => {
    const root = makeSkillsRoot();
    write(join(root, 'unstable', 'SKILL.md'), skill('unstable'));
    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
      testHooks: {
        beforeSlotRecheck: folderName => {
          if (folderName === 'unstable') write(join(root, folderName, 'SKILL.md'), `${skill('unstable')}changed`);
        },
      },
    });
    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('unstable');
    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'unstable',
      reason: 'inventory_unstable',
    }));
  });

  it('changes projection revision when the healthy desired link set changes', () => {
    const root = makeSkillsRoot();
    const before = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });
    write(join(root, 'new-healthy-skill', 'SKILL.md'), skill('new-healthy-skill'));
    const after = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });

    expect(before.integrityIssues).toEqual(after.integrityIssues);
    expect(after.integrityRevision).not.toBe(before.integrityRevision);
  });

  const itNonWindows = process.platform === 'win32' ? it.skip : it;
  itNonWindows('rejects global symlink aliases without following them', () => {
    const root = makeSkillsRoot();
    const outside = join(root, '..', 'outside');
    write(join(outside, 'SKILL.md'), skill('outside'));
    symlinkSync(outside, join(root, 'alias'), 'dir');
    const snapshot = createGlobalSkillInventorySnapshot({
      rootPath: root,
      cliToolRegistryEnabled: true,
      disabledSkillNames: new Set(),
    });
    expect(snapshot.entries.map(entry => entry.folderName)).not.toContain('alias');
    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'alias',
      reason: 'untrusted_global_source',
    }));
  });
});
