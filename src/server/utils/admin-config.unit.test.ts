import { describe, expect, it } from 'vitest';

import { PLAYWRIGHT_MCP_PACKAGE_SPEC } from '../../shared/mcpPackages';
import { getAllMcpServers } from './admin-config';

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
