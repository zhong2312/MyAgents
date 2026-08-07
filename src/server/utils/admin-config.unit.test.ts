import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLAYWRIGHT_MCP_PACKAGE_SPEC } from '../../shared/mcpPackages';
import { getAllMcpServers, resolveWorkbenchAiProviderSelection, resolveWorkspaceConfig } from './admin-config';

const scratchDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('server MCP catalogue merge', () => {
  it('appends preset args instead of replacing the executable package spec', () => {
    const servers = getAllMcpServers({
      mcpServers: [],
      mcpEnabledServers: ['playwright'],
      mcpServerArgs: {
        playwright: ['--user-data-dir=/tmp/playwright-profile'],
      },
    });

    expect(servers.find((server) => server.id === 'playwright')?.args).toEqual([
      PLAYWRIGHT_MCP_PACKAGE_SPEC,
      '--user-data-dir=/tmp/playwright-profile',
    ]);
  });

  it('resolves owned Session IDs against current definitions and global enablement', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-config-'));
    scratchDirs.push(scratch);
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', scratch);
    const configPath = join(configDir, 'config.json');
    const writeConfig = (enabledIds: string[], command: string): void => {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [
          { id: 'owned', name: 'Owned', type: 'stdio', command, isBuiltin: false },
          { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
        ],
        mcpEnabledServers: enabledIds,
      }), 'utf8');
    };
    const metadata = {
      configSnapshotAt: '2026-08-05T00:00:00.000Z',
      mcpEnabledServers: ['owned'],
    } as never;

    writeConfig(['owned', 'workspace-default'], 'current-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([expect.objectContaining({ id: 'owned', command: 'current-command' })]);

    writeConfig(['workspace-default'], 'newer-but-disabled-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([]);
  });
});

describe('workbench one-shot AI provider selection', () => {
  it('accepts a user-added model on a preset provider', () => {
    const selection = resolveWorkbenchAiProviderSelection(
      'volcengine',
      'deepseek-v4-flash-260425',
      {
        presetCustomModels: {
          volcengine: [
            {
              model: 'deepseek-v4-flash-260425',
              modelName: 'DeepSeek V4 Flash',
              modelSeries: 'volcengine',
            },
          ],
        },
        providerPrimaryModels: {
          volcengine: 'deepseek-v4-flash-260425',
        },
        providerApiKeys: {
          volcengine: 'test-key',
        },
      },
    );

    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error(selection.error);
    expect(selection.providerEnv?.providerId).toBe('volcengine');
  });
});
