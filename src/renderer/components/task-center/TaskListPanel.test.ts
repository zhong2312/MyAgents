import { describe, expect, it } from 'vitest';

import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';
import { shouldAddOrphanWorkspacePath } from './taskListPanelWorkspace';

describe('TaskListPanel workspace orphan filter', () => {
  it('does not add orphan options for any registered project, including hidden projects', () => {
    const hiddenMinoId = normalizeWorkspacePathIdentity('/Users/me/.myagents/projects/mino');
    const knownProjectIds = new Set([hiddenMinoId]);

    expect(shouldAddOrphanWorkspacePath(
      '/Users/me/.myagents/projects/mino',
      new Set(),
      knownProjectIds,
      new Set(),
    )).toBe(false);
  });

  it('adds orphan options only for workspace paths missing from the project registry', () => {
    expect(shouldAddOrphanWorkspacePath(
      '/Users/me/removed-workspace',
      new Set(),
      new Set(),
      new Set(),
    )).toBe(true);
  });

  it('deduplicates already covered and already emitted orphan identities', () => {
    const id = normalizeWorkspacePathIdentity('/Users/me/workspace');

    expect(shouldAddOrphanWorkspacePath(
      '/Users/me/workspace',
      new Set([id]),
      new Set(),
      new Set(),
    )).toBe(false);

    expect(shouldAddOrphanWorkspacePath(
      '/Users/me/workspace',
      new Set(),
      new Set(),
      new Set([id]),
    )).toBe(false);
  });
});
