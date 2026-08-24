import { describe, expect, it } from 'vitest';

import {
  normalizeProjectCapabilitySelection,
  parseProjectCapabilityId,
  projectCapabilityId,
} from './projectCapabilities';

describe('project capability selection contract', () => {
  it('defaults to enabled by normalizing an absent override to empty disabled lists', () => {
    expect(normalizeProjectCapabilitySelection(undefined)).toEqual({
      version: 1,
      disabled: { skills: [], commands: [] },
    });
  });

  it('uses exact source/kind/local identities and preserves nested command paths', () => {
    const id = projectCapabilityId('project', 'command', 'release/ship');
    expect(id).toBe('project:command:release/ship');
    expect(parseProjectCapabilityId(id)).toEqual({
      source: 'project',
      kind: 'command',
      sourceLocalId: 'release/ship',
    });

    const skillId = projectCapabilityId('project', 'skill', 'review:local');
    expect(skillId).toBe('project:skill:review:local');
    expect(parseProjectCapabilityId(skillId).sourceLocalId).toBe('review:local');
  });

  it('fails closed for unknown schema versions and invalid identities', () => {
    expect(() => normalizeProjectCapabilitySelection({ version: 2, disabled: {} })).toThrow(
      'Unsupported capabilitySelection version',
    );
    expect(() => normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['project:skill:../escape'] },
    })).toThrow('Skill capability source id must be one folder name');
  });

  it('canonicalizes global Required disables without guessing project frontmatter identity', () => {
    expect(normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['global:skill:myagents-cli'] },
    }).disabled.skills).toEqual([]);
    expect(normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['project:skill:myagents-cli'] },
    }).disabled.skills).toEqual(['project:skill:myagents-cli']);
  });
});
