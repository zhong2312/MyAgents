import { describe, expect, it } from 'vitest';

import { PLAYWRIGHT_MCP_PACKAGE_SPEC } from '../../shared/mcpPackages';
import { getAllMcpServers, resolveWorkbenchAiProviderSelection } from './admin-config';

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
