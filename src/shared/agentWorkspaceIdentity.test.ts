import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  reconcileAgentWorkspaceIdentities,
  resolveAgentWorkspaceProjections,
  type AgentWorkspaceAgentRecord,
  type AgentWorkspaceProjectRecord,
} from './agentWorkspaceIdentity';

const compatibilityFixture = JSON.parse(readFileSync(
  new URL('./fixtures/agent-workspace-compatibility.json', import.meta.url),
  'utf8',
)) as {
  projects: TestProject[];
  agents: TestAgent[];
  expectedProjections: Array<{
    agentId: string;
    workspacePath: string;
    association: string;
  }>;
};

interface TestProject extends AgentWorkspaceProjectRecord {
  hidden?: boolean;
  archivedAt?: string;
}

interface TestAgent extends AgentWorkspaceAgentRecord {
  name: string;
  enabled: boolean;
}

function project(id: string, path: string, agentId?: string): TestProject {
  return { id, name: id, path, agentId };
}

function agent(id: string, workspacePath?: string, enabled = false): TestAgent {
  return { id, name: id, enabled, ...(workspacePath ? { workspacePath } : {}) } as TestAgent;
}

function reconcile(projects: TestProject[], agents: TestAgent[]) {
  let nextId = 0;
  return reconcileAgentWorkspaceIdentities(projects, agents, {
    buildAgent: (_source, requestedId) => agent(requestedId ?? `created-${++nextId}`),
  });
}

describe('reconcileAgentWorkspaceIdentities', () => {
  it('matches the shared TS/Rust compatibility projection fixture', () => {
    const result = resolveAgentWorkspaceProjections(
      compatibilityFixture.projects,
      compatibilityFixture.agents,
    );

    expect(result.agentProjections.map(({ agentId, workspacePath, association }) => ({
      agentId,
      workspacePath,
      association,
    }))).toEqual(compatibilityFixture.expectedProjections);
  });

  it('creates and links the one required Agent identity without mutating its inputs', () => {
    const projects = [project('project-1', '/work/one')];
    const agents: TestAgent[] = [];

    const result = reconcile(projects, agents);

    expect(result.changed).toBe(true);
    expect(result.createdAgentIds).toEqual(['created-1']);
    expect(result.projects[0]).toMatchObject({
      agentId: 'created-1',
    });
    expect(result.projects[0].isAgent).toBeUndefined();
    expect(result.agents[0]).not.toHaveProperty('workspacePath');
    expect(result.identities[0]).toMatchObject({
      projectId: 'project-1',
      agentId: 'created-1',
      workspacePath: '/work/one',
    });
    expect(projects[0].agentId).toBeUndefined();
    expect(agents).toEqual([]);
  });

  it('repairs a stale link from the first canonical workspace match', () => {
    const result = reconcile(
      [project('project-1', 'C:\\Users\\Me\\Workspace', 'missing-agent')],
      [
        agent('agent-first', 'c:/users/me/workspace/'),
        agent('agent-second', 'C:\\USERS\\ME\\WORKSPACE'),
      ],
    );

    expect(result.createdAgentIds).toEqual([]);
    expect(result.relinkedProjectIds).toEqual(['project-1']);
    expect(result.projects[0].agentId).toBe('agent-first');
  });

  it('uses a valid explicit link before legacy path evidence and projects extras through Project.path', () => {
    const result = reconcile(
      [project('project-1', '/work/moved', 'agent-linked')],
      [
        agent('agent-extra', '/work/moved'),
        agent('agent-linked', '/work/old-location'),
      ],
    );

    expect(result.identities[0]).toMatchObject({
      agentId: 'agent-linked',
      workspacePath: '/work/moved',
    });
    expect(result.projects[0].agentId).toBe('agent-linked');
    expect(result.agentProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'agent-extra',
        association: 'legacy-project',
        workspacePath: '/work/moved',
        canMutateProjectLifecycle: false,
      }),
      expect.objectContaining({
        agentId: 'agent-linked',
        association: 'project-linked',
        workspacePath: '/work/moved',
        canMutateProjectLifecycle: true,
      }),
    ]));
  });

  it('preserves orphan Agents and exposes their old path only through compatibility projection', () => {
    const orphan = agent('orphan', '/work/orphan');
    const result = reconcile([project('project-1', '/work/one')], [orphan]);

    expect(result.agents.map(item => item.id)).toEqual(['orphan', 'created-1']);
    expect(result.identities.map(item => item.agentId)).toEqual(['created-1']);
    expect(result.agentProjections).toContainEqual(expect.objectContaining({
      agentId: 'orphan',
      association: 'legacy-orphan',
      workspacePath: '/work/orphan',
      canMutateProjectLifecycle: false,
    }));
  });

  it('reuses a stale id when no legacy Agent matches', () => {
    const result = reconcile(
      [project('project-1', '/work/one', 'stale-agent-id')],
      [],
    );

    expect(result.projects[0].agentId).toBe('stale-agent-id');
    expect(result.createdAgentIds).toEqual(['stale-agent-id']);
    expect(result.agents[0]).toEqual(expect.objectContaining({ id: 'stale-agent-id' }));
    expect(result.agents[0]).not.toHaveProperty('workspacePath');
  });

  it('isolates duplicate canonical Project workspaces while preserving healthy identities', () => {
    const result = reconcile(
      [
        project('project-1', 'D:\\Work'),
        project('project-2', 'd:/work/'),
        project('project-healthy', '/healthy', 'agent-healthy'),
      ],
      [agent('agent-healthy', '/healthy')],
    );

    expect(result.identities.map(identity => identity.projectId)).toEqual(['project-healthy']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'DUPLICATE_PROJECT_WORKSPACE',
      projectIds: ['project-1', 'project-2'],
    }));
  });

  it('isolates duplicate explicit Agent claims while preserving healthy identities', () => {
    const result = reconcile(
      [
        project('project-one', '/one', 'agent-one'),
        project('project-two', '/two', 'agent-one'),
        project('project-healthy', '/healthy', 'agent-healthy'),
      ],
      [agent('agent-one', '/one'), agent('agent-healthy', '/healthy')],
    );

    expect(result.identities.map(identity => identity.projectId)).toEqual(['project-healthy']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
      agentIds: ['agent-one'],
      projectIds: ['project-one', 'project-two'],
    }));
  });

  it('keeps hidden and archived Projects in the identity invariant', () => {
    const projects = [
      { ...project('hidden', '/work/hidden'), hidden: true },
      { ...project('archived', '/work/archived'), archivedAt: '2026-08-01T00:00:00.000Z' },
    ];
    const result = reconcile(projects, []);

    expect(result.identities).toHaveLength(2);
    expect(result.projects.every(item => item.agentId)).toBe(true);
  });

  it('only promotes the legacy isAgent projection for enabled Agents', () => {
    const result = reconcile(
      [project('disabled-project', '/disabled'), project('enabled-project', '/enabled')],
      [agent('disabled-agent', '/disabled'), agent('enabled-agent', '/enabled', true)],
    );

    expect(result.projects[0].isAgent).toBeUndefined();
    expect(result.projects[1].isAgent).toBe(true);
  });
});
