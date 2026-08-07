import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(scratch, '.myagents', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

function writeProjects(projects: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(scratch, '.myagents', 'projects.json'),
    JSON.stringify(projects, null, 2),
    'utf-8',
  );
}

function writeCustomProvider(provider: Record<string, unknown>): void {
  const dir = join(scratch, '.myagents', 'providers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${String(provider.id)}.json`),
    JSON.stringify(provider, null, 2),
    'utf-8',
  );
}

function customApiProvider(id: string, model: string, baseUrl: string): Record<string, unknown> {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: id,
    type: 'api',
    primaryModel: model,
    isBuiltin: false,
    config: { baseUrl },
    models: [{ model, modelName: model, modelSeries: model }],
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-workspace-perm-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('resolveWorkspaceConfig permissionMode (#295)', () => {
  it('returns agent permissionMode so pre-warm starts under the configured mode', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Plan Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'plan',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null, { includeMcp: false });

    expect(resolved.permissionMode).toBe('plan');
  });

  it('prefers session snapshot before agent, then project, then global default', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'fullAgency',
      agents: [{
        id: 'agent-1',
        name: 'Snapshot Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'plan',
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Project',
      path: workspacePath,
      permissionMode: 'auto',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    expect(resolveWorkspaceConfig(workspacePath, { permissionMode: 'fullAgency' } as SessionMetadata, { includeMcp: false }).permissionMode).toBe('fullAgency');

    writeConfig({
      defaultPermissionMode: 'fullAgency',
      agents: [{
        id: 'agent-1',
        name: 'Project Fallback Agent',
        enabled: true,
        workspacePath,
      }],
    });
    expect(resolveWorkspaceConfig(workspacePath, null, { includeMcp: false }).permissionMode).toBe('auto');

    writeProjects([]);
    expect(resolveWorkspaceConfig(workspacePath, null, { includeMcp: false }).permissionMode).toBe('fullAgency');
  });

  it('matches Windows workspace identity across separators, case, and trailing slash', async () => {
    const storedWorkspacePath = 'C:\\Users\\Alice\\Project\\';
    const runtimeWorkspacePath = 'c:/users/alice/project';
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Windows Agent',
        enabled: true,
        workspacePath: storedWorkspacePath,
        runtime: 'codex',
        runtimeConfig: {
          permissionMode: 'no-restrictions',
          reasoningEffort: 'xhigh',
        },
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Windows Project',
      path: storedWorkspacePath,
      permissionMode: 'plan',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(runtimeWorkspacePath, null, { includeMcp: false });

    expect(resolved.permissionMode).toBe('no-restrictions');
    expect(resolved.reasoningEffort).toBe('xhigh');
  });

  it('maps runtime-backed Codex provider agent fullAgency to no-restrictions without a runtimeConfig override', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Managed Codex Agent',
        enabled: true,
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'fullAgency',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null, { includeMcp: false });

    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.permissionMode).toBe('no-restrictions');
  });

  it('lets runtime-backed Codex provider agent permission win over stale runtimeConfig permission', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Managed Codex Agent',
        enabled: true,
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'fullAgency',
        runtimeConfig: { permissionMode: 'full-auto' },
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null, { includeMcp: false });

    expect(resolved.permissionMode).toBe('no-restrictions');
  });

  it('projects historical managed full-auto to auto-edit without writing it back', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Managed Codex Agent',
        enabled: true,
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'fullAgency',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const metadata = {
      id: 'managed-session',
      agentDir: workspacePath,
      title: 'Managed',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      permissionMode: 'full-auto',
      configSnapshotAt: new Date().toISOString(),
    } as SessionMetadata;
    const resolved = resolveWorkspaceConfig(workspacePath, metadata, { includeMcp: false });

    expect(resolved.permissionMode).toBe('auto-edit');
    expect(resolveWorkspaceConfig(workspacePath, metadata, { includeMcp: false }).permissionMode)
      .toBe('auto-edit');
    expect(resolveWorkspaceConfig(
      workspacePath,
      { ...metadata, permissionMode: 'no-restrictions' },
      { includeMcp: false },
    ).permissionMode).toBe('no-restrictions');
  });

  it('does not inherit current Agent permission into an existing managed Session with missing history', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'Managed Codex Agent',
        enabled: true,
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'fullAgency',
      }],
    });
    writeProjects([]);
    const metadata = {
      id: 'managed-legacy-session',
      agentDir: workspacePath,
      title: 'Managed Legacy',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    } as SessionMetadata;

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    expect(resolveWorkspaceConfig(workspacePath, metadata, { includeMcp: false }).permissionMode)
      .toBe('auto-edit');
  });

  it('preserves system Codex full-auto even when a dormant managed provider id remains', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      agents: [{
        id: 'agent-1',
        name: 'System Codex Agent',
        enabled: true,
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'fullAgency',
        runtime: 'codex',
        runtimeConfig: {
          source: 'system-cli',
          permissionMode: 'full-auto',
        },
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    expect(resolveWorkspaceConfig(workspacePath, null, { includeMcp: false }).permissionMode)
      .toBe('full-auto');
  });

  it('falls back to auto when no valid builtin permission mode is configured', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'bypassPermissions',
      agents: [{
        id: 'agent-1',
        name: 'Malformed Agent',
        enabled: true,
        workspacePath,
        permissionMode: 'not-a-builtin-mode',
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Project',
      path: workspacePath,
      permissionMode: 'full-auto',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, null, { includeMcp: false });

    expect(resolved.permissionMode).toBe('auto');
  });
});

describe('resolveWorkspaceConfig runtime-aware model snapshots', () => {
  it('drops obviously foreign external-runtime session models', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Codex Agent',
        enabled: true,
        workspacePath,
        runtime: 'codex',
        model: 'claude-opus-4-7',
        permissionMode: 'fullAgency',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-1',
      agentDir: workspacePath,
      title: 'New Chat',
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      runtime: 'codex',
      model: 'claude-opus-4-7',
      configSnapshotAt: '2026-06-19T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.model).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[runtime-coerce]'));
  });

  it('drops obviously foreign external-runtime permission modes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'fullAgency',
      agents: [{
        id: 'agent-1',
        name: 'Codex Agent',
        enabled: true,
        workspacePath,
        runtime: 'codex',
        permissionMode: 'fullAgency',
        runtimeConfig: { permissionMode: 'full-auto' },
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-1',
      agentDir: workspacePath,
      title: 'New Chat',
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      runtime: 'codex',
      permissionMode: 'fullAgency',
      configSnapshotAt: '2026-06-19T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.permissionMode).toBe('full-auto');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('permissionMode'));
  });

  it('projects unknown historical external permission modes to the interactive default', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({ agents: [] });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-unknown-permission',
      agentDir: workspacePath,
      title: 'Unknown Permission',
      createdAt: '2026-07-31T00:00:00.000Z',
      lastActiveAt: '2026-07-31T00:00:00.000Z',
      runtime: 'codex',
      runtimeSource: 'system-cli',
      permissionMode: 'unlimited',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.permissionMode).toBe('full-auto');
  });

  it('does not use agent model/provider/MCP fallbacks for locked owned snapshots', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultProviderId: 'deepseek',
      mcpEnabledServers: ['fs', 'git'],
      agents: [{
        id: 'agent-1',
        name: 'Locked Snapshot Agent',
        enabled: true,
        workspacePath,
        runtime: 'builtin',
        providerId: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'fullAgency',
        mcpEnabledServers: ['fs', 'git'],
      }],
    });
    writeProjects([{
      id: 'project-1',
      name: 'Project',
      path: workspacePath,
      mcpEnabledServers: ['fs'],
      permissionMode: 'plan',
    }]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-locked',
      agentDir: workspacePath,
      title: 'Locked',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      runtime: 'builtin',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    } as SessionMetadata);

    expect(resolved.model).toBeUndefined();
    expect(resolved.providerEnv).toBeUndefined();
    expect(resolved.mcpServers).toEqual([]);
    expect(resolved.permissionMode).toBe('auto');
  });

  it('honors a snapshotted providerId without falling back to the live agent provider', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      providerApiKeys: {
        deepseek: 'sk-test-deepseek',
        minimax: 'sk-test-minimax',
      },
      agents: [{
        id: 'agent-1',
        name: 'Locked Snapshot Agent',
        enabled: true,
        workspacePath,
        runtime: 'builtin',
        providerId: 'minimax',
        model: 'MiniMax-M2.7',
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-locked-provider',
      agentDir: workspacePath,
      title: 'Locked Provider',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      runtime: 'builtin',
      providerId: 'deepseek',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.providerEnv?.providerId).toBe('deepseek');
    expect(resolved.providerEnv?.apiKey).toBe('sk-test-deepseek');
    expect(resolved.providerEnv?.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(resolved.model).not.toBe('MiniMax-M2.7');
  });

  it('auto-repairs model-only owned snapshots using only credential-configured API providers', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeCustomProvider(customApiProvider('route-a', 'shared-model', 'https://a.example.com'));
    writeCustomProvider(customApiProvider('route-b', 'shared-model', 'https://b.example.com'));
    writeConfig({
      providerApiKeys: {
        'route-a': 'sk-route-a',
      },
      agents: [],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-model-only',
      agentDir: workspacePath,
      title: 'Model Only',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      runtime: 'builtin',
      model: 'shared-model',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.providerRoute).toEqual({ kind: 'provider', providerId: 'route-a', model: 'shared-model' });
    expect(resolved.providerEnv?.providerId).toBe('route-a');
    expect(resolved.providerEnv?.apiKey).toBe('sk-route-a');
    expect(resolved.providerEnv?.baseUrl).toBe('https://a.example.com');
  });

  it('treats Anthropic subscription account evidence as credential-configured for model-only repair', async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      providerVerifyStatus: {
        'anthropic-sub': {
          status: 'invalid',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          accountEmail: 'user@example.com',
        },
      },
      agents: [],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-subscription-model-only',
      agentDir: workspacePath,
      title: 'Subscription',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      runtime: 'builtin',
      model: 'claude-sonnet-4-6',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.providerRoute).toEqual({ kind: 'subscription', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' });
    expect(resolved.providerEnv).toBeUndefined();
    expect(resolved.model).toBe('claude-sonnet-4-6');
  });

  it("preserves external-runtime snapshot reasoningEffort='default' over agent non-default", async () => {
    const workspacePath = join(scratch, 'workspace');
    writeConfig({
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'agent-1',
        name: 'Codex Agent',
        enabled: true,
        workspacePath,
        runtime: 'codex',
        runtimeConfig: { reasoningEffort: 'xhigh' },
      }],
    });
    writeProjects([]);

    const { resolveWorkspaceConfig } = await import('../utils/admin-config');
    const resolved = resolveWorkspaceConfig(workspacePath, {
      id: 'session-1',
      agentDir: workspacePath,
      title: 'New Chat',
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      runtime: 'codex',
      reasoningEffort: 'default',
      configSnapshotAt: '2026-06-19T00:00:00.000Z',
    } as SessionMetadata, { includeMcp: false });

    expect(resolved.reasoningEffort).toBe('default');
  });
});
