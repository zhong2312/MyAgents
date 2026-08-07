import { describe, expect, it } from 'vitest';

import type { McpServerDefinition } from '../../shared/config-types';
import {
  decideMcpSync,
  getMcpAuthorityForScenario,
  mcpConfigFingerprint,
  shouldDeferLiveMcpMutation,
} from './mcp-sync-policy';

function server(overrides: Partial<McpServerDefinition> & { id: string }): McpServerDefinition {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    command: 'node',
    args: [],
    enabled: true,
    type: 'stdio',
    ...rest,
  } as McpServerDefinition;
}

describe('mcp-sync-policy', () => {
  it('assigns MCP authority to tab for desktop and self-resolve for background owners', () => {
    expect(getMcpAuthorityForScenario('desktop')).toBe('tab');
    expect(getMcpAuthorityForScenario('im')).toBe('self-resolve');
    expect(getMcpAuthorityForScenario('cron')).toBe('self-resolve');
    expect(getMcpAuthorityForScenario('agent-channel')).toBe('self-resolve');
    expect(getMcpAuthorityForScenario('registeredAgent')).toBe('self-resolve');
  });

  it('fingerprints full MCP config independent of ordering', () => {
    const a = [
      server({ id: 'b', args: ['one'] }),
      server({ id: 'a', env: { TOKEN: '1' } }),
    ];
    const b = [
      server({ id: 'a', env: { TOKEN: '1' } }),
      server({ id: 'b', args: ['one'] }),
    ];
    expect(mcpConfigFingerprint(a)).toBe(mcpConfigFingerprint(b));
    expect(mcpConfigFingerprint(a)).not.toBe(mcpConfigFingerprint([server({ id: 'a', env: { TOKEN: '2' } })]));
  });

  it('fingerprints env and headers independent of nested object key ordering', () => {
    const a = [server({
      id: 'ordered',
      env: { B: '2', A: '1' },
      headers: { 'X-Second': '2', 'X-First': '1' },
    })];
    const b = [server({
      id: 'ordered',
      env: { A: '1', B: '2' },
      headers: { 'X-First': '1', 'X-Second': '2' },
    })];

    expect(mcpConfigFingerprint(a)).toBe(mcpConfigFingerprint(b));
  });

  it('restarts an active session for any owner-resolved MCP fingerprint change', () => {
    const previousServers = [server({ id: 'old' })];
    const nextServers = [server({ id: 'new' })];
    expect(decideMcpSync({
      previousServers,
      nextServers,
      hasQuerySession: true,
    })).toEqual({
      changed: true,
      shouldRestart: true,
      reason: 'fingerprint-changed',
    });
    expect(decideMcpSync({
      previousServers,
      nextServers,
      hasQuerySession: false,
    })).toEqual({
      changed: true,
      shouldRestart: false,
      reason: 'no-active-session',
    });
  });

  it('restarts for same-id definition updates', () => {
    const previousServers = [server({ id: 'same', command: 'old-command', env: { TOKEN: 'old' } })];
    const nextServers = [server({ id: 'same', command: 'new-command', env: { TOKEN: 'new' } })];

    expect(decideMcpSync({
      previousServers,
      nextServers,
      hasQuerySession: true,
    })).toEqual({
      changed: true,
      shouldRestart: true,
      reason: 'fingerprint-changed',
    });
  });

  it.each([
    { promotedItemInFlight: false, turnInFlight: false, sdkCommandInFlight: false, expected: false },
    { promotedItemInFlight: true, turnInFlight: false, sdkCommandInFlight: false, expected: true },
    { promotedItemInFlight: false, turnInFlight: true, sdkCommandInFlight: false, expected: true },
    { promotedItemInFlight: false, turnInFlight: false, sdkCommandInFlight: true, expected: true },
    { promotedItemInFlight: false, turnInFlight: false, sdkCommandInFlight: false, backgroundTasksActive: true, expected: true },
    { promotedItemInFlight: true, turnInFlight: true, sdkCommandInFlight: true, expected: true },
  ])('defers live MCP mutation while Query dispatch ownership is active: $expected', (input) => {
    expect(shouldDeferLiveMcpMutation(input)).toBe(input.expected);
  });
});
