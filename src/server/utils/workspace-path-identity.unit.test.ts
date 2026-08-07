import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEffectiveMcpServers } from './admin-config';
import {
  getDefaultEnabledPluginIdsForWorkspace,
  setWorkspaceEnabledPlugins,
} from '../plugins/store';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-win-path-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Windows workspace path identity for server config helpers', () => {
  it('resolves effective MCP servers across Windows separator, drive-case, and trailing-slash variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
        isBuiltin: false,
      }],
      mcpEnabledServers: ['win-custom'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'C:\\Users\\Me\\Project',
      mcpEnabledServers: ['win-custom'],
    }]);

    expect(getEffectiveMcpServers('c:/users/me/project/').map((server) => server.id))
      .toEqual(['win-custom']);
  });

  it('does not match malformed empty project paths when resolving effective MCP servers', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
        isBuiltin: false,
      }],
      mcpEnabledServers: ['win-custom'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Malformed Project',
      mcpEnabledServers: ['win-custom'],
    }]);

    expect(getEffectiveMcpServers('')).toEqual([]);
  });

  it('reads Agent plugin defaults across Windows path identity variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        enabledPluginIds: ['reviewer', 'charts'],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'C:\\Users\\Me\\Project',
      agentId: 'agent-1',
    }]);

    expect(getDefaultEnabledPluginIdsForWorkspace('c:/users/me/project/'))
      .toEqual(['reviewer', 'charts']);
  });

  it('falls back to Project plugin defaults across Windows path identity variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'C:\\Users\\Me\\Project',
      enabledPluginIds: ['workspace-plugin'],
    }]);

    expect(getDefaultEnabledPluginIdsForWorkspace('c:/users/me/project/'))
      .toEqual(['workspace-plugin']);
  });

  it('commits workspace plugin defaults to both Agent and Project under one intent', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: 'C:\\Users\\Me\\Project',
        enabledPluginIds: ['old-plugin'],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'c:/users/me/project/',
      agentId: 'agent-1',
      enabledPluginIds: ['old-plugin'],
    }]);

    await expect(setWorkspaceEnabledPlugins(
      'c:/users/me/project/',
      ['reviewer', 'reviewer', 'charts'],
    )).resolves.toEqual({ scope: 'agent', ids: ['reviewer', 'charts'] });

    const config = readJson<{ agents: Array<{ enabledPluginIds?: string[]; workspacePath?: string }> }>(
      join(scratch, '.myagents', 'config.json'),
    );
    const projects = readJson<Array<{ enabledPluginIds?: string[] }>>(
      join(scratch, '.myagents', 'projects.json'),
    );
    expect(config.agents[0].enabledPluginIds).toEqual(['reviewer', 'charts']);
    expect(config.agents[0].workspacePath).toBe('C:\\Users\\Me\\Project');
    expect(projects[0].enabledPluginIds).toEqual(['reviewer', 'charts']);
  });

  it('rolls back the Agent plugin default when its Project mirror cannot be written', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        enabledPluginIds: ['old-plugin'],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      enabledPluginIds: ['old-plugin'],
    }]);
    mkdirSync(join(scratch, '.myagents', 'projects.json.tmp'));

    await expect(setWorkspaceEnabledPlugins('/tmp/workspace', ['new-plugin']))
      .rejects.toThrow();

    const config = readJson<{ agents: Array<{ enabledPluginIds?: string[] }> }>(
      join(scratch, '.myagents', 'config.json'),
    );
    expect(config.agents[0].enabledPluginIds).toEqual(['old-plugin']);
  });
});
