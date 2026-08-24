import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { searchWorkspaceFiles } from './searchClient';

describe('searchWorkspaceFiles', () => {
  beforeEach(() => invokeMock.mockReset());

  it('returns the atomic empty folder/file response without IPC for blank queries', async () => {
    await expect(searchWorkspaceFiles('   ', '/workspace')).resolves.toEqual({
      folderHits: [],
      hits: [],
      totalFolders: 0,
      totalFiles: 0,
      queryTimeMs: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('requests folder and file hits through the existing single Tauri command', async () => {
    const response = {
      folderHits: [{ path: 'docs', name: 'docs' }],
      hits: [],
      totalFolders: 1,
      totalFiles: 0,
      queryTimeMs: 2,
    };
    invokeMock.mockResolvedValue(response);

    await expect(searchWorkspaceFiles('docs', '/workspace')).resolves.toBe(response);
    expect(invokeMock).toHaveBeenCalledWith('cmd_search_workspace_files', {
      query: 'docs',
      workspace: '/workspace',
      limit: 50,
      maxMatchesPerFile: 10,
    });
  });
});
