import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listPluginQualifiedSkillNames } from './manifest';

const roots: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plugin runtime Skill inventory', () => {
  it('returns SDK-qualified default and manifest-path Skill names', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-plugin-manifest-'));
    roots.push(root);
    write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'review-tools',
      skills: './extra-skills',
    }));
    write(join(root, 'skills', 'default-folder', 'SKILL.md'), [
      '---',
      'name: default-review',
      'description: Default',
      '---',
    ].join('\n'));
    write(join(root, 'extra-skills', 'custom-folder', 'SKILL.md'), [
      '---',
      'name: custom-review',
      'description: Custom',
      '---',
    ].join('\n'));

    expect(listPluginQualifiedSkillNames(root)).toEqual([
      'review-tools:custom-review',
      'review-tools:default-review',
    ]);
  });
});
