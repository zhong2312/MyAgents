import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../shared/types/agent';
import {
  bindOwnedSnapshotToRuntimeIdentity,
  createMaterializedSessionMetadata,
  isLiveFollowScenario,
} from './session-materialization';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    enabled: true,
    permissionMode: 'fullAgency',
    model: 'claude-sonnet-4-6',
    mcpEnabledServers: ['fs'],
    channels: [],
    runtime: 'codex',
    runtimeConfig: {
      model: 'gpt-5.1-codex',
      permissionMode: 'full-auto',
    },
    ...overrides,
  };
}

describe('createMaterializedSessionMetadata', () => {
  it('binds owned metadata to the live Sidecar identity after Agent config drifts', () => {
    const staleAgentSnapshot = {
      runtime: 'builtin' as const,
      model: 'claude-sonnet-4-6',
    };

    expect(bindOwnedSnapshotToRuntimeIdentity(staleAgentSnapshot, {
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    })).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    });
  });

  it('materializes published IM reset ids as live-follow sessions', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'fixed-session-id',
      scenario: 'agent-channel',
      agent: makeAgent(),
    });

    expect(meta.id).toBe('fixed-session-id');
    expect(meta.title).toBe('New Chat');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
    expect(meta.permissionMode).toBeUndefined();
    expect(meta.configSnapshotAt).toBeUndefined();
    expect(meta.origin).toEqual({ kind: 'agent-channel', surface: 'channel_message' });
  });

  it('keeps desktop materialization owned and self-contained', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'desktop-session-id',
      scenario: 'desktop',
      agent: makeAgent({ enabledPluginIds: ['planner@local'] }),
      title: 'First prompt',
    });

    expect(meta.id).toBe('desktop-session-id');
    expect(meta.title).toBe('First prompt');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBe('gpt-5.1-codex');
    expect(meta.permissionMode).toBe('full-auto');
    expect(meta.enabledPluginIds).toEqual(['planner@local']);
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('materializes a runtime switch using the target runtime snapshot view', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'runtime-switch-session-id',
      scenario: 'desktop',
      agent: makeAgent({
        runtime: 'builtin',
        model: 'claude-opus-4-7',
        permissionMode: 'fullAgency',
        runtimeConfig: {
          model: 'gemini-3.1-pro-preview',
          permissionMode: 'yolo',
        },
      }),
      runtimeOverride: 'codex',
    });

    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
    expect(meta.permissionMode).toBeUndefined();
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('uses the active runtime fallback when no agent config is available', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/unregistered-workspace',
      sessionId: 'external-reset-session-id',
      scenario: 'agent-channel',
      fallbackRuntime: 'codex',
    });

    expect(meta.id).toBe('external-reset-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
  });

  it('persists an explicit birth origin when the caller owns the surface fact', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'launcher-session-id',
      scenario: 'desktop',
      agent: makeAgent(),
      origin: { kind: 'desktop', surface: 'launcher_input' },
    });

    expect(meta.origin).toEqual({ kind: 'desktop', surface: 'launcher_input' });
  });

  it('materializes live-follow managed Codex as provider-backed runtime identity', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'managed-codex-session-id',
      scenario: 'agent-channel',
      agent: makeAgent({
        providerId: 'codex-sub',
        model: 'gpt-5.4-codex',
        runtime: 'builtin',
        runtimeConfig: { source: 'system-cli' },
      }),
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    });

    expect(meta.runtime).toBe('codex');
    expect(meta.runtimeSource).toBe('managed-provider');
    expect(meta.model).toBeUndefined();
    expect(meta.providerExecutionIdentity).toBeUndefined();
  });

  it('classifies IM, agent-channel, and registeredAgent scenarios as live-follow', () => {
    expect(isLiveFollowScenario('im')).toBe(true);
    expect(isLiveFollowScenario('agent-channel')).toBe(true);
    expect(isLiveFollowScenario('registeredAgent')).toBe(true);
    expect(isLiveFollowScenario('desktop')).toBe(false);
    expect(isLiveFollowScenario('cron')).toBe(false);
  });

  it('materializes registeredAgent sessions as live-follow sessions', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'registered-agent-session-id',
      scenario: 'registeredAgent',
      agent: makeAgent(),
      title: 'Issue title must not own this session',
    });

    expect(meta.id).toBe('registered-agent-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
    expect(meta.permissionMode).toBeUndefined();
    expect(meta.configSnapshotAt).toBeUndefined();
    expect(meta.title).toBe('Agent');
  });
});
