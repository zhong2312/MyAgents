import { describe, expect, it } from 'vitest';
import type { Project } from '@/config/types';
import { getBotWorkspaceCandidates } from './botWorkspaceSelection';

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path: `/workspace/${id}`,
  providerId: null,
  permissionMode: null,
  ...overrides,
});

describe('getBotWorkspaceCandidates', () => {
  it('keeps only visible active workspaces and puts the default first', () => {
    const result = getBotWorkspaceCandidates([
      project('recent', { lastOpened: '2026-08-15T12:00:00Z' }),
      project('default', { lastOpened: '2026-08-14T12:00:00Z' }),
      project('hidden', { hidden: true }),
      project('internal', { internal: true }),
      project('archived', { archivedAt: '2026-08-15T00:00:00Z' }),
    ], '/workspace/default');

    expect(result.map(item => item.id)).toEqual(['default', 'recent']);
  });
});
