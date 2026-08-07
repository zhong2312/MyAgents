import { describe, expect, it } from 'vitest';

import type { AppConfig, Project, WorkspaceTemplate } from '../types';
import { DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID, PRESET_TEMPLATES } from '../types';
import {
  applyOpenClawPluginConfigMutation,
  buildAgentForProject,
  ensureAllProjectsHaveAgent,
  migrateImBotConfigsToAgents,
  resolveAgentRuntimeMcpServersJson,
  resolveAgentMcpSelectionForConfig,
  resolveAgentDefaultsForProject,
  projectMemoryEvolutionTaskRuntimeForAgent,
} from './agentConfigService';

describe('OpenClaw plugin config mutation', () => {
  it('merges independent editor saves without reviving a deleted field', () => {
    const afterDelete = applyOpenClawPluginConfigMutation(
      { timeout: 30, name: 'a' },
      { type: 'delete', key: 'timeout' },
    );
    const afterRemountEdit = applyOpenClawPluginConfigMutation(
      afterDelete,
      { type: 'set', key: 'name', value: 'b' },
    );

    expect(afterRemountEdit).toEqual({ name: 'b' });
  });
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'workspace',
    path: '/tmp/workspace',
    providerId: null,
    permissionMode: null,
    ...overrides,
  };
}

describe('agentConfigService template Agent defaults', () => {
  it('builds ordinary projects as disabled basic Agents', () => {
    const agent = buildAgentForProject(project({
      enabledPluginIds: ['plugin-one'],
      enabledOfficialToolIds: ['image-understanding'],
    }), {
      agentId: 'agent-1',
      defaultPermissionMode: 'auto',
    });

    expect(agent).toMatchObject({
      id: 'agent-1',
      name: 'workspace',
      enabled: false,
      channels: [],
      permissionMode: 'auto',
      enabledPluginIds: ['plugin-one'],
      enabledOfficialToolIds: ['image-understanding'],
    });
    expect(agent.heartbeat).toBeUndefined();
    expect(agent.memoryAutoUpdate).toBeUndefined();
  });

  it('applies builtin template defaults and clones nested config objects', () => {
    const templates: WorkspaceTemplate[] = [{
      id: 'agent-template',
      name: 'Agent Template',
      description: '',
      isBuiltin: true,
      agentDefaults: {
        enabled: true,
        heartbeat: {
          enabled: true,
          intervalMinutes: 240,
          ackMaxChars: 300,
          activeHours: { start: '09:00', end: '21:00', timezone: 'Asia/Shanghai' },
        },
        memoryAutoUpdate: {
          enabled: true,
          intervalHours: 24,
          queryThreshold: 3,
          updateWindowStart: '21:00',
          updateWindowEnd: '09:00',
        },
      },
    }];

    const sourceProject = project({
      templateId: 'agent-template',
      templateSource: 'builtin',
      displayName: 'From Template',
      icon: 'lightning',
    });
    const agent = buildAgentForProject(sourceProject, {
      agentId: 'agent-1',
      defaultPermissionMode: 'plan',
      templates,
    });

    expect(agent.enabled).toBe(true);
    expect(agent.name).toBe('From Template');
    expect(agent.icon).toBe('lightning');
    expect(agent.heartbeat).toEqual(templates[0].agentDefaults!.heartbeat);
    expect(agent.memoryAutoUpdate).toEqual(templates[0].agentDefaults!.memoryAutoUpdate);

    agent.heartbeat!.activeHours!.start = '10:00';
    expect(templates[0].agentDefaults!.heartbeat!.activeHours!.start).toBe('09:00');
  });

  it('does not apply builtin defaults to user templates with matching IDs', () => {
    const templates: WorkspaceTemplate[] = [{
      id: 'mino',
      name: 'Mino',
      description: '',
      isBuiltin: true,
      agentDefaults: { enabled: true },
    }];

    const defaults = resolveAgentDefaultsForProject(
      project({ templateId: 'mino', templateSource: 'user' }),
      templates,
    );

    expect(defaults).toBeUndefined();
  });

  it('creates proactive Mino Agents from the preset when a project has builtin template provenance', () => {
    const cfg: AppConfig = {
      defaultPermissionMode: 'auto',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [],
    };
    const projects = [project({
      templateId: DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID,
      templateSource: 'builtin',
      displayName: 'Mino',
    })];

    const result = ensureAllProjectsHaveAgent(cfg, projects, cfg.defaultPermissionMode);

    expect(result.changed).toBe(true);
    expect(projects[0].isAgent).toBe(true);
    expect(projects[0].agentId).toBeTruthy();
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents![0]).toMatchObject({
      name: 'Mino',
      enabled: true,
      heartbeat: PRESET_TEMPLATES[0].agentDefaults!.heartbeat,
      memoryAutoUpdate: PRESET_TEMPLATES[0].agentDefaults!.memoryAutoUpdate,
      channels: [],
    });
    expect(cfg.agents![0].heartbeat?.activeHours).toEqual({
      start: '09:00',
      end: '21:00',
      timezone: 'Asia/Shanghai',
    });
  });

  it('preserves an existing linked Agent while normalizing the required identity mirror', () => {
    const cfg: AppConfig = {
      defaultPermissionMode: 'auto',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [{
        id: 'existing-agent',
        name: 'Existing',
        enabled: false,
        permissionMode: 'plan',
        channels: [],
      }],
    };
    const projects = [project({
      agentId: 'existing-agent',
      templateId: DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID,
      templateSource: 'builtin',
    })];

    const result = ensureAllProjectsHaveAgent(cfg, projects, cfg.defaultPermissionMode);

    expect(result.changed).toBe(false);
    expect(cfg.agents![0].enabled).toBe(false);
    expect(cfg.agents![0].heartbeat).toBeUndefined();
    expect(projects[0].isAgent).toBeUndefined();
  });
});

describe('projectMemoryEvolutionTaskRuntimeForAgent', () => {
  it('projects Codex subscription Agents to the managed Codex runtime identity', () => {
    expect(projectMemoryEvolutionTaskRuntimeForAgent({
      providerId: 'codex-sub',
      model: ' gpt-5.5 ',
      permissionMode: 'fullAgency',
      runtime: 'builtin',
      runtimeConfig: {
        envPolicy: { proxy: 'terminal' },
        reasoningEffort: 'xhigh',
      },
    })).toEqual({
      runtime: 'codex',
      runtimeConfig: {
        source: 'managed-provider',
        model: 'gpt-5.5',
        envPolicy: { proxy: 'terminal' },
        permissionMode: 'no-restrictions',
        reasoningEffort: 'xhigh',
      },
    });
  });

  it('keeps ordinary Agent runtime settings unchanged', () => {
    expect(projectMemoryEvolutionTaskRuntimeForAgent({
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      runtime: 'builtin',
      runtimeConfig: { envPolicy: { proxy: 'myagents' } },
    })).toEqual({
      runtime: 'builtin',
      runtimeConfig: { envPolicy: { proxy: 'myagents' } },
    });
  });

  it('does not reroute memory evolution through a dormant managed provider', () => {
    expect(projectMemoryEvolutionTaskRuntimeForAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      permissionMode: 'fullAgency',
      runtime: 'gemini',
      runtimeConfig: {
        source: 'managed-provider',
        model: 'gemini-3.1-pro-preview',
        permissionMode: 'yolo',
      },
    })).toEqual({
      runtime: 'gemini',
      runtimeConfig: {
        source: 'managed-provider',
        model: 'gemini-3.1-pro-preview',
        permissionMode: 'yolo',
      },
    });
  });
});

describe('migrateImBotConfigsToAgents', () => {
  it('migrates only Project-backed IM groups into a pathless Agent and preserves unmatched bots', () => {
    const winPath = 'C:\\Users\\Me\\Project';
    const cfg = {
      defaultPermissionMode: 'auto',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      imBotConfigs: [
        {
          id: 'bot-a',
          name: 'Primary Bot',
          platform: 'telegram',
          botToken: 'token-a',
          allowedUsers: [],
          permissionMode: 'fullAgency',
          enabled: true,
          defaultWorkspacePath: winPath,
          setupCompleted: true,
        },
        {
          id: 'bot-b',
          name: 'Secondary Bot',
          platform: 'telegram',
          botToken: 'token-b',
          allowedUsers: [],
          permissionMode: 'fullAgency',
          enabled: true,
          defaultWorkspacePath: 'c:/users/me/project/',
          setupCompleted: true,
        },
        {
          id: 'bot-default',
          name: 'Default Bot',
          platform: 'telegram',
          botToken: 'token-default',
          allowedUsers: [],
          permissionMode: 'fullAgency',
          enabled: true,
          setupCompleted: true,
        },
      ],
    } as AppConfig;
    const projects = [
      project({ path: 'c:/users/me/project/' }),
      project({ id: 'malformed-project', path: undefined as unknown as string }),
    ];

    const migrated = migrateImBotConfigsToAgents(cfg, projects);

    expect(migrated.agents).toHaveLength(1);
    expect(migrated.agents![0]).not.toHaveProperty('workspacePath');
    expect(migrated.agents![0].channels).toHaveLength(2);
    expect(migrated.imBotConfigs?.map(bot => bot.id)).toEqual(['bot-default']);
    expect(projects[0]).toMatchObject({
      isAgent: true,
      agentId: migrated.agents![0].id,
    });
    expect(projects[1].isAgent).toBeUndefined();
    expect(projects[1].agentId).toBeUndefined();
  });
});

describe('resolveAgentMcpSelectionForConfig', () => {
  it('promotes legacy Agent-only HTTP MCP definitions into the global registry', () => {
    const legacyRemote = {
      id: 'remote-search',
      name: 'Remote Search',
      type: 'http' as const,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      isBuiltin: false,
    };
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      workspacePath: '/tmp/workspace',
      permissionMode: 'plan',
      channels: [],
      mcpServersJson: JSON.stringify([legacyRemote]),
    };
    const cfg: AppConfig = {
      defaultPermissionMode: 'plan',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [agent],
      mcpServers: [],
      mcpEnabledServers: [],
    };

    const result = resolveAgentMcpSelectionForConfig(cfg, agent, ['remote-search']);

    expect(result.config.mcpServers).toEqual([legacyRemote]);
    expect(result.config.mcpEnabledServers).toEqual(['remote-search']);
    expect(JSON.parse(result.mcpServersJson!)).toEqual([legacyRemote]);
  });

  it('does not globally enable a known custom SSE server that the user disabled globally', () => {
    const remoteSse = {
      id: 'remote-sse',
      name: 'Remote SSE',
      type: 'sse' as const,
      url: 'https://mcp.example.com/sse',
      isBuiltin: false,
    };
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      workspacePath: '/tmp/workspace',
      permissionMode: 'plan',
      channels: [],
    };
    const cfg: AppConfig = {
      defaultPermissionMode: 'plan',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [agent],
      mcpServers: [remoteSse],
      mcpEnabledServers: [],
    };

    const result = resolveAgentMcpSelectionForConfig(cfg, agent, ['remote-sse']);

    expect(result.config.mcpServers).toEqual([remoteSse]);
    expect(result.config.mcpEnabledServers).toEqual([]);
    expect(result.mcpServersJson).toBeUndefined();
  });

  it('builds runtime MCP JSON for an existing server only when the global gate is enabled', () => {
    const remoteSse = {
      id: 'remote-sse',
      name: 'Remote SSE',
      type: 'sse' as const,
      url: 'https://mcp.example.com/sse',
      isBuiltin: false,
    };
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      workspacePath: '/tmp/workspace',
      permissionMode: 'plan',
      channels: [],
    };
    const cfg: AppConfig = {
      defaultPermissionMode: 'plan',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [agent],
      mcpServers: [remoteSse],
      mcpEnabledServers: ['remote-sse'],
    };

    const result = resolveAgentMcpSelectionForConfig(cfg, agent, ['remote-sse']);

    expect(result.config.mcpServers).toEqual([remoteSse]);
    expect(result.config.mcpEnabledServers).toEqual(['remote-sse']);
    expect(JSON.parse(result.mcpServersJson!)).toEqual([remoteSse]);
  });

  it('does not fabricate runtime MCP JSON for unknown selected ids', () => {
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      workspacePath: '/tmp/workspace',
      permissionMode: 'plan',
      channels: [],
    };
    const cfg: AppConfig = {
      defaultPermissionMode: 'plan',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [agent],
      mcpServers: [],
      mcpEnabledServers: [],
    };

    const result = resolveAgentMcpSelectionForConfig(cfg, agent, ['missing']);

    expect(result.config.mcpServers).toEqual([]);
    expect(result.config.mcpEnabledServers).toEqual([]);
    expect(result.mcpServersJson).toBeUndefined();
  });

  it('does not promote malformed or non-remote definitions from Agent JSON', () => {
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      workspacePath: '/tmp/workspace',
      permissionMode: 'plan',
      channels: [],
      mcpServersJson: JSON.stringify([
        {
          id: 'remote-without-url',
          name: 'Remote Missing URL',
          type: 'http',
          isBuiltin: false,
        },
        {
          id: 'agent-stdio',
          name: 'Agent Stdio',
          type: 'stdio',
          command: 'node',
          isBuiltin: false,
        },
      ]),
    };
    const cfg: AppConfig = {
      defaultPermissionMode: 'plan',
      themeId: 'myagents-default',
      appearanceMode: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [agent],
      mcpServers: [],
      mcpEnabledServers: [],
    };

    const result = resolveAgentMcpSelectionForConfig(cfg, agent, ['remote-without-url', 'agent-stdio']);

    expect(result.config.mcpServers).toEqual([]);
    expect(result.config.mcpEnabledServers).toEqual([]);
    expect(result.mcpServersJson).toBeUndefined();
  });
});

describe('resolveAgentRuntimeMcpServersJson', () => {
  it('does not bypass the global enabled gate for manual Agent channel start', () => {
    const disabledRemote = {
      id: 'remote-sse',
      name: 'Remote SSE',
      type: 'sse' as const,
      url: 'https://mcp.example.com/sse',
      isBuiltin: false,
    };

    expect(
      resolveAgentRuntimeMcpServersJson(
        [disabledRemote],
        [],
        ['remote-sse'],
      ),
    ).toBeNull();
  });
});
