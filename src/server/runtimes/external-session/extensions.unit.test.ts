import { describe, expect, it, vi } from 'vitest';
import type { McpServerDefinition } from '../../../shared/config-types';
import type { ManagedCodexExtensionSnapshot } from '../managed-codex/extensions/contracts';
import {
  getManagedCodexExtensionStatus,
  getManagedCodexDesiredSnapshot,
  markManagedCodexExtensionEffective,
  releaseManagedCodexExtensionGeneration,
  resolveManagedCodexMcpSelection,
  resetManagedCodexExtensionState,
  setManagedCodexDesiredSnapshot,
} from './extensions';

function snapshot(revision: string, mcpServers: McpServerDefinition[] = []): ManagedCodexExtensionSnapshot {
  return {
    revision,
    workspacePath: '/workspace',
    scenario: { type: 'desktop' },
    enabledPluginIds: [],
    skills: [],
    commands: [],
    agents: [],
    mcpServers,
    dynamicTools: [],
    components: [{ component: 'commands', state: 'applied', code: 'compiled' }],
  };
}

describe('Managed Codex extension generation state', () => {
  it('keeps no-op status operation-local instead of mutating durable diagnostics state', () => {
    resetManagedCodexExtensionState();
    markManagedCodexExtensionEffective(snapshot('one'), 'generation-one');

    expect(setManagedCodexDesiredSnapshot(snapshot('one'), 'idle-process')).toMatchObject({
      state: 'unchanged',
    });
    expect(getManagedCodexExtensionStatus()).toMatchObject({
      state: 'applied',
      components: [{ state: 'applied' }],
    });
  });

  it('resolves renderer MCP intent from the server-owned catalogue', () => {
    const authoritative: McpServerDefinition[] = [{
      id: 'safe',
      name: 'Safe',
      type: 'stdio',
      command: '/trusted/server',
      env: { TOKEN: 'trusted-secret' },
      isBuiltin: false,
    }];

    expect(resolveManagedCodexMcpSelection(['safe'], authoritative)).toEqual(authoritative);
    expect(() => resolveManagedCodexMcpSelection(['injected'], authoritative)).toThrow(
      'Unknown Managed Codex MCP selection: injected',
    );
  });

  it('coalesces desired revisions and only advances effective after startup confirmation', () => {
    resetManagedCodexExtensionState();
    expect(setManagedCodexDesiredSnapshot(snapshot('one'), 'no-live-process')).toMatchObject({
      desiredRevision: 'one',
      effectiveRevision: null,
      state: 'pending_next_start',
    });
    expect(markManagedCodexExtensionEffective(snapshot('one'), 'generation-one')).toMatchObject({
      desiredRevision: 'one',
      effectiveRevision: 'one',
      state: 'applied',
    });
    expect(setManagedCodexDesiredSnapshot(snapshot('two'), 'busy-process')).toMatchObject({
      desiredRevision: 'two',
      effectiveRevision: 'one',
      state: 'deferred_until_idle',
    });
    expect(setManagedCodexDesiredSnapshot(snapshot('three'), 'busy-process')).toMatchObject({
      desiredRevision: 'three',
      effectiveRevision: 'one',
      state: 'deferred_until_idle',
    });
    expect(setManagedCodexDesiredSnapshot(snapshot('one'), 'busy-process')).toMatchObject({
      desiredRevision: 'one',
      effectiveRevision: 'one',
      state: 'applied',
    });
  });

  it('keeps a failed optional MCP component below an applied generation', () => {
    resetManagedCodexExtensionState();
    const degraded = {
      ...snapshot('degraded'),
      components: [{
        component: 'mcp' as const,
        id: 'unsafe-query',
        state: 'failed' as const,
        code: 'mcp_projection_rejected',
        message: 'Unsafe URL query.',
      }],
    };

    expect(markManagedCodexExtensionEffective(degraded, 'generation-degraded')).toMatchObject({
      desiredRevision: 'degraded',
      effectiveRevision: 'degraded',
      state: 'applied',
      components: [{ component: 'mcp', id: 'unsafe-query', state: 'failed' }],
    });
  });

  it('ignores stale generation cleanup and releases the effective generation', () => {
    resetManagedCodexExtensionState();
    markManagedCodexExtensionEffective(snapshot('one'), 'generation-one');
    releaseManagedCodexExtensionGeneration('stale-generation');
    expect(getManagedCodexExtensionStatus().effectiveRevision).toBe('one');
    releaseManagedCodexExtensionGeneration('generation-one');
    expect(getManagedCodexExtensionStatus()).toMatchObject({
      desiredRevision: 'one',
      effectiveRevision: null,
      state: 'pending_next_start',
    });
  });

  it('preserves generation-owned Host resources when admission recompiles the same revision', () => {
    resetManagedCodexExtensionState();
    const dispose = vi.fn();
    const withHost: ManagedCodexExtensionSnapshot = {
      ...snapshot('one'),
      dynamicTools: [{ name: 'myagents__mcp__local__echo', description: 'Echo', inputSchema: {} }],
      hostToolDispatcher: { descriptors: [], dispatch: vi.fn(), dispose },
      components: [{ component: 'host_tools', state: 'applied', code: 'connected' }],
    };
    markManagedCodexExtensionEffective(withHost, 'generation-one');
    setManagedCodexDesiredSnapshot(snapshot('one'), 'idle-process');

    expect(getManagedCodexDesiredSnapshot()).toMatchObject({
      dynamicTools: [{ name: 'myagents__mcp__local__echo' }],
      hostToolDispatcher: withHost.hostToolDispatcher,
      components: [{ component: 'commands' }, { component: 'host_tools' }],
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('uses a private MCP apply fingerprint so secret rotation cannot look effective', () => {
    resetManagedCodexExtensionState();
    const server = (token: string): McpServerDefinition => ({
      id: 'remote',
      name: 'Remote',
      type: 'stdio',
      command: 'remote-mcp',
      env: { API_TOKEN: token },
      isBuiltin: false,
    });
    const first = snapshot('secret-safe-revision', [server('secret-one')]);
    const rotated = snapshot('secret-safe-revision', [server('secret-two')]);

    markManagedCodexExtensionEffective(first, 'generation-one');
    expect(setManagedCodexDesiredSnapshot(rotated, 'busy-process')).toMatchObject({
      desiredRevision: 'secret-safe-revision',
      effectiveRevision: 'secret-safe-revision',
      state: 'deferred_until_idle',
    });
    expect(JSON.stringify(getManagedCodexExtensionStatus())).not.toContain('secret-two');
    expect(setManagedCodexDesiredSnapshot(first, 'busy-process')).toMatchObject({
      state: 'applied',
    });
  });
});
