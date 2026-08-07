import { describe, expect, it } from 'vitest';

import {
  isRequiredSystemSkill,
  REQUIRED_SYSTEM_SKILLS,
  withoutRequiredSystemSkills,
} from './systemSkills';

describe('required system skill contract', () => {
  it('contains exactly the eight product-required global skills', () => {
    expect(REQUIRED_SYSTEM_SKILLS).toEqual([
      'task-alignment',
      'task-implement',
      'myagents-memory-update',
      'myagents-memory-gardener',
      'myagents-memory-molt',
      'myagents-cli',
      'myagents-task-automation',
      'myagents-docs',
    ]);
    for (const name of REQUIRED_SYSTEM_SKILLS) {
      expect(isRequiredSystemSkill(name)).toBe(true);
    }
    expect(isRequiredSystemSkill('prompt-writer')).toBe(false);
  });

  it('removes required and malformed entries without disturbing optional disabled skills', () => {
    expect(withoutRequiredSystemSkills([
      'myagents-cli',
      'task-implement',
      'prompt-writer',
      null,
      'myagents-docs',
      'user-skill',
    ])).toEqual(['prompt-writer', 'user-skill']);
  });
});
