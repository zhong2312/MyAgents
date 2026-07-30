import { describe, expect, it } from 'vitest';

import type { Project } from '../types';
import {
  getSystemPresetProjectMetadataPatch,
  isProjectVisibleToUser,
  isProjectActiveForUser,
  isSystemPresetProject,
} from '../types';
import { applyProjectArchiveIntent, applyProjectPatch, applyProjectRemovalIntent, applyProjectUnarchiveIntent } from './projectService';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'workspace',
    path: '/tmp/workspace',
    providerId: null,
    permissionMode: null,
    ...overrides,
  };
}

describe('system preset workspace helpers', () => {
  it('identifies system preset projects by lifecycle metadata, not template source alone', () => {
    expect(isSystemPresetProject(project({
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
    }))).toBe(true);

    expect(isSystemPresetProject(project({
      templateId: 'mino',
      templateSource: 'builtin',
    }))).toBe(false);
  });

  it('excludes internal and hidden projects from user-facing workspace lists', () => {
    expect(isProjectVisibleToUser(project())).toBe(true);
    expect(isProjectVisibleToUser(project({ internal: true }))).toBe(false);
    expect(isProjectVisibleToUser(project({ hidden: true }))).toBe(false);
    expect(isProjectActiveForUser(project())).toBe(true);
    expect(isProjectActiveForUser(project({ archivedAt: '2026-07-03T00:00:00.000Z' }))).toBe(false);
  });

  it('repairs only missing system preset metadata without overwriting user-facing customizations', () => {
    const patch = getSystemPresetProjectMetadataPatch(project({
      displayName: 'My Mino',
      icon: 'star',
      path: '/Users/me/.myagents/projects/mino',
    }), 'mino');

    expect(patch).toMatchObject({
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
      templateId: 'mino',
      templateSource: 'builtin',
    });
    expect(patch.displayName).toBeUndefined();
    expect(patch.icon).toBeUndefined();
    expect(patch.hidden).toBeUndefined();
  });
});

describe('applyProjectRemovalIntent', () => {
  it('removes ordinary workspaces from the project registry', () => {
    const ordinary = project({ id: 'ordinary' });
    const other = project({ id: 'other', path: '/tmp/other' });

    const result = applyProjectRemovalIntent([ordinary, other], ordinary.id, '2026-06-11T00:00:00.000Z');

    expect(result?.action).toBe('removed');
    expect(result?.project).toEqual(ordinary);
    expect(result?.projects).toEqual([other]);
  });

  it('soft-deletes system preset workspaces', () => {
    const mino = project({
      id: 'mino-project',
      path: '/Users/me/.myagents/projects/mino',
      workspaceType: 'system-preset',
      systemPresetId: 'mino',
    });
    const other = project({ id: 'other', path: '/tmp/other' });

    const result = applyProjectRemovalIntent([mino, other], mino.id, '2026-06-11T00:00:00.000Z');

    expect(result?.action).toBe('hidden');
    expect(result?.projects).toHaveLength(2);
    expect(result?.project).toMatchObject({
      id: 'mino-project',
      hidden: true,
      hiddenAt: '2026-06-11T00:00:00.000Z',
    });
    expect(result?.projects[0]).toEqual(result?.project);
    expect(result?.projects[1]).toEqual(other);
  });
});

describe('applyProjectPatch', () => {
  it('removes undefined fields so unpinning clears pinnedAt on save', () => {
    const patched = applyProjectPatch(
      project({ pinnedAt: '2026-06-19T10:00:00.000Z' }),
      { pinnedAt: undefined },
    );

    expect(patched).not.toHaveProperty('pinnedAt');
  });

  it('persists the workspace panel visibility preference independently of other project fields', () => {
    const hidden = applyProjectPatch(project({ displayName: 'A workspace' }), {
      workspacePanelVisible: false,
    });
    const visible = applyProjectPatch(hidden, { workspacePanelVisible: true });

    expect(hidden).toMatchObject({
      displayName: 'A workspace',
      workspacePanelVisible: false,
    });
    expect(visible.workspacePanelVisible).toBe(true);
  });
});

describe('project archive intents', () => {
  it('archives a project, remembers proactive state, and clears pinnedAt', () => {
    const result = applyProjectArchiveIntent(
      [project({ pinnedAt: '2026-06-19T10:00:00.000Z' })],
      'project-1',
      {
        archivedAtIso: '2026-07-03T00:00:00.000Z',
        agentEnabledBeforeArchive: true,
      },
    );

    expect(result?.project).toMatchObject({
      id: 'project-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    });
    expect(result?.project).not.toHaveProperty('pinnedAt');
  });

  it('keeps original restore metadata when archiving an already archived project', () => {
    const result = applyProjectArchiveIntent(
      [project({
        archivedAt: '2026-07-02T00:00:00.000Z',
        archivedAgentEnabledBeforeArchive: true,
      })],
      'project-1',
      {
        archivedAtIso: '2026-07-03T00:00:00.000Z',
        agentEnabledBeforeArchive: false,
      },
    );

    expect(result?.project).toMatchObject({
      archivedAt: '2026-07-02T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    });
  });

  it('unarchives a project and clears archive metadata', () => {
    const result = applyProjectUnarchiveIntent(
      [project({
        archivedAt: '2026-07-03T00:00:00.000Z',
        archivedAgentEnabledBeforeArchive: true,
      })],
      'project-1',
    );

    expect(result?.project).not.toHaveProperty('archivedAt');
    expect(result?.project).not.toHaveProperty('archivedAgentEnabledBeforeArchive');
  });
});
