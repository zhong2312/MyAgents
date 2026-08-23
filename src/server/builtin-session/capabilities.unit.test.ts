import { describe, expect, it } from 'vitest';
import type {
  EffectiveProjectCapabilitySnapshot,
  ProjectCapabilityCandidate,
} from '../../shared/projectCapabilities';
import {
  buildBuiltinSkillAllowlist,
  filterSlashCommandsForCapabilities,
  findDisabledCapabilityForSlashInput,
  sanitizeSdkSkillAllowlist,
  sdkSkillNameRejectionReason,
} from './capabilities';

function candidate(
  id: string,
  kind: 'skill' | 'command',
  canonicalName: string,
  enabled: boolean,
): ProjectCapabilityCandidate {
  const [source, , ...sourceParts] = id.split(':');
  return {
    id,
    kind,
    source: source as 'project' | 'global',
    sourceLocalId: sourceParts.join(':'),
    canonicalName,
    name: canonicalName,
    description: '',
    path: `/fixture/${canonicalName}`,
    required: false,
    systemOwned: source === 'global',
    enabled,
    contentSha256: `${id}-sha`,
  };
}

function snapshot(): EffectiveProjectCapabilitySnapshot {
  const enabledSkill = candidate('project:skill:frontend', 'skill', 'frontend', true);
  const disabledSkill = candidate('global:skill:mail', 'skill', 'mail', false);
  const enabledCommand = candidate('project:command:review.md', 'command', 'review', true);
  const disabledCommand = candidate('global:command:release.md', 'command', 'release', false);
  const reservedCollision = candidate('project:command:compact.md', 'command', 'compact', false);
  const clientActionCollision = candidate('project:command:goal.md', 'command', 'goal', false);
  return {
    workspacePath: '/fixture/project',
    agentId: 'fixture-agent',
    revision: 'fixture-revision',
    integrityRevision: 'fixture-integrity-revision',
    integrityIssues: [],
    candidates: [enabledSkill, disabledSkill, enabledCommand, disabledCommand, reservedCollision, clientActionCollision],
    enabledSkills: [enabledSkill],
    enabledCommands: [enabledCommand],
  };
}

describe('builtin project capability admission', () => {
  it('builds an exact Skill allowlist from enabled project capabilities and plugins', () => {
    expect(buildBuiltinSkillAllowlist(snapshot(), ['plugin-a:one', 'frontend', 'plugin-a:one']))
      .toEqual(['frontend', 'plugin-a:one']);
    expect(buildBuiltinSkillAllowlist(snapshot(), ['plugin-a:one'], ['frontend']))
      .toEqual(['plugin-a:one']);
  });

  it('keeps SDK-compatible historical Skill names and plugin-qualified names', () => {
    expect(sanitizeSdkSkillAllowlist([
      'review-helper',
      'owner/skill-name',
      'plugin-a:one',
      '名字',
      'review-helper',
    ])).toEqual({
      allowlist: ['owner/skill-name', 'plugin-a:one', 'review-helper', '名字'].sort(),
      rejected: [],
    });
  });

  it('drops only names rejected synchronously by SDK 0.3.221+ so old Sessions still start', () => {
    const result = sanitizeSdkSkillAllowlist([
      'healthy',
      '*',
      'plugin:*',
      '/slash-prefixed',
      ' padded',
      'bad(name)',
      'bad,name',
      `control\nname`,
      'double\\\\slash',
      'trailing\\',
      `broken-${String.fromCharCode(0xd800)}`,
    ]);

    expect(result.allowlist).toEqual(['healthy']);
    expect(result.rejected.map(item => item.name)).toHaveLength(10);
    expect(result.rejected.every(item => item.reason.length > 0)).toBe(true);
  });

  it('keeps the local compatibility contract aligned with representative SDK boundaries', () => {
    expect(sdkSkillNameRejectionReason('plugin:skill')).toBeNull();
    expect(sdkSkillNameRejectionReason('skill *')).toContain('wildcard');
    expect(sdkSkillNameRejectionReason('path\\segment')).toBeNull();
    expect(sdkSkillNameRejectionReason('path\\\\segment')).toContain('backslashes');
  });

  it('hides and rejects disabled slash capabilities without changing enabled commands', () => {
    const capabilities = snapshot();
    expect(filterSlashCommandsForCapabilities([
      { name: 'review', description: '', source: 'sdk' },
      { name: 'release', description: '', source: 'sdk' },
      { name: 'compact', description: '', source: 'sdk' },
      { name: 'help', description: '', source: 'sdk' },
    ], capabilities).map(command => command.name)).toEqual(['review', 'compact', 'help']);
    expect(findDisabledCapabilityForSlashInput('/release now', capabilities)?.id)
      .toBe('global:command:release.md');
    expect(findDisabledCapabilityForSlashInput('/review now', capabilities)).toBeNull();
    expect(findDisabledCapabilityForSlashInput('/compact', capabilities)).toBeNull();
    expect(findDisabledCapabilityForSlashInput('/goal', capabilities)).toBeNull();
  });

  it('does not let a disabled Skill hide or reject a same-named Command', () => {
    const capabilities = snapshot();
    const disabledSkill = candidate('global:skill:review', 'skill', 'review', false);
    capabilities.candidates.push(disabledSkill);

    expect(filterSlashCommandsForCapabilities([
      { name: 'review', description: '', source: 'sdk' },
    ], capabilities).map(command => command.name)).toEqual(['review']);
    expect(findDisabledCapabilityForSlashInput('/review now', capabilities)).toBeNull();
  });
});
