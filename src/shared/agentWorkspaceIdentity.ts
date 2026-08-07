import {
  PRESET_TEMPLATES,
  type Project,
  type WorkspaceTemplate,
  type WorkspaceTemplateAgentDefaults,
} from './config-types';
import type { AgentConfig } from './types/agent';
import { readLegacyAgentWorkspacePath } from './legacyAgentWorkspace';
import { normalizeWorkspacePathIdentity } from './workspacePath';

/**
 * The persisted Project and Agent shapes intentionally remain independently
 * evolvable. This is the required product-domain projection used after the two
 * stores have been reconciled.
 */
export interface ResolvedAgentWorkspaceIdentity<
  P extends AgentWorkspaceProjectRecord = AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord = AgentWorkspaceAgentRecord,
> {
  projectId: string;
  agentId: string;
  workspacePath: string;
  project: P;
  agent: A;
}

export interface AgentWorkspaceProjectRecord {
  id: string;
  name: string;
  path: string;
  agentId?: string;
  isAgent?: boolean;
}

export interface AgentWorkspaceAgentRecord {
  id: string;
  enabled?: boolean;
}

export type AgentWorkspaceIdentityErrorCode =
  | 'INVALID_PROJECT_IDENTITY'
  | 'DUPLICATE_PROJECT_ID'
  | 'DUPLICATE_PROJECT_WORKSPACE'
  | 'DUPLICATE_AGENT_ID'
  | 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS'
  | 'CREATED_AGENT_ID_COLLISION';

export interface AgentWorkspaceIdentityDiagnostic {
  code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS' | 'DUPLICATE_PROJECT_WORKSPACE';
  message: string;
  projectIds: string[];
  agentIds: string[];
}

function collectProjectWorkspaceConflicts<P extends AgentWorkspaceProjectRecord>(projects: readonly P[]) {
  const projectsByWorkspace = new Map<string, P[]>();
  for (const project of projects) {
    const identity = normalizeWorkspacePathIdentity(project.path);
    if (!identity) continue;
    const matches = projectsByWorkspace.get(identity) ?? [];
    matches.push(project);
    projectsByWorkspace.set(identity, matches);
  }

  const diagnostics: AgentWorkspaceIdentityDiagnostic[] = [];
  const conflictedProjectIds = new Set<string>();
  for (const matches of projectsByWorkspace.values()) {
    if (matches.length < 2) continue;
    const projectIds = matches.map(project => project.id);
    projectIds.forEach(projectId => conflictedProjectIds.add(projectId));
    diagnostics.push({
      code: 'DUPLICATE_PROJECT_WORKSPACE',
      message: `Projects '${projectIds.join("', '")}' resolve to the same workspace.`,
      agentIds: matches.flatMap(project => project.agentId ? [project.agentId] : []),
      projectIds,
    });
  }
  return { diagnostics, conflictedProjectIds };
}

export type AgentWorkspaceAssociation =
  | 'project-linked'
  | 'legacy-project'
  | 'legacy-orphan';

export interface ResolvedAgentWorkspaceProjection<
  P extends AgentWorkspaceProjectRecord = AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord = AgentWorkspaceAgentRecord,
> {
  agentId: string;
  workspacePath: string;
  agent: A;
  projectId?: string;
  project?: P;
  association: AgentWorkspaceAssociation;
  canMutateProjectLifecycle: boolean;
}

function collectAgentClaimConflicts<P extends AgentWorkspaceProjectRecord>(projects: readonly P[]) {
  const claimsByAgent = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.agentId) continue;
    const claims = claimsByAgent.get(project.agentId) ?? [];
    claims.push(project.id);
    claimsByAgent.set(project.agentId, claims);
  }

  const diagnostics: AgentWorkspaceIdentityDiagnostic[] = [];
  const conflictedAgentIds = new Set<string>();
  const conflictedProjectIds = new Set<string>();
  for (const [agentId, projectIds] of claimsByAgent) {
    if (projectIds.length < 2) continue;
    conflictedAgentIds.add(agentId);
    projectIds.forEach(projectId => conflictedProjectIds.add(projectId));
    diagnostics.push({
      code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
      message: `Agent '${agentId}' is explicitly linked by multiple Projects.`,
      agentIds: [agentId],
      projectIds: [...projectIds],
    });
  }
  return { claimsByAgent, diagnostics, conflictedAgentIds, conflictedProjectIds };
}

/**
 * Read-only Agent → workspace projection for already-persisted snapshots.
 * Exact Project.agentId claims win; legacy path evidence is consulted only for
 * unlinked historical Agents, and a true orphan keeps its old path fallback.
 */
export function resolveAgentWorkspaceProjections<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
>(
  projects: readonly P[],
  agents: readonly A[],
): {
  agentProjections: Array<ResolvedAgentWorkspaceProjection<P, A>>;
  diagnostics: AgentWorkspaceIdentityDiagnostic[];
} {
  const conflictState = collectAgentClaimConflicts(projects);
  const workspaceConflictState = collectProjectWorkspaceConflicts(projects);
  const exactProjectByAgent = new Map<string, P>();
  for (const project of projects) {
    if (project.agentId
        && !conflictState.conflictedAgentIds.has(project.agentId)
        && !workspaceConflictState.conflictedProjectIds.has(project.id)) {
      exactProjectByAgent.set(project.agentId, project);
    }
  }

  const projectByWorkspace = new Map<string, P | null>();
  for (const project of projects) {
    if (workspaceConflictState.conflictedProjectIds.has(project.id)) continue;
    const identity = normalizeWorkspacePathIdentity(project.path);
    if (!identity) continue;
    projectByWorkspace.set(identity, projectByWorkspace.has(identity) ? null : project);
  }

  const agentProjections: Array<ResolvedAgentWorkspaceProjection<P, A>> = [];
  for (const agent of agents) {
    if (conflictState.conflictedAgentIds.has(agent.id)) continue;
    const exactProject = exactProjectByAgent.get(agent.id);
    if (exactProject) {
      agentProjections.push({
        agentId: agent.id,
        workspacePath: exactProject.path,
        agent,
        projectId: exactProject.id,
        project: exactProject,
        association: 'project-linked',
        canMutateProjectLifecycle: true,
      });
      continue;
    }

    const legacyWorkspacePath = readLegacyAgentWorkspacePath(agent);
    const workspaceIdentity = normalizeWorkspacePathIdentity(legacyWorkspacePath ?? '');
    if (!workspaceIdentity) continue;
    const legacyProject = projectByWorkspace.get(workspaceIdentity);
    if (legacyProject) {
      agentProjections.push({
        agentId: agent.id,
        workspacePath: legacyProject.path,
        agent,
        projectId: legacyProject.id,
        project: legacyProject,
        association: 'legacy-project',
        canMutateProjectLifecycle: false,
      });
      continue;
    }
    agentProjections.push({
      agentId: agent.id,
      workspacePath: legacyWorkspacePath!,
      agent,
      association: 'legacy-orphan',
      canMutateProjectLifecycle: false,
    });
  }

  return {
    agentProjections,
    diagnostics: [...workspaceConflictState.diagnostics, ...conflictState.diagnostics],
  };
}

export class AgentWorkspaceIdentityError extends Error {
  readonly code: AgentWorkspaceIdentityErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentWorkspaceIdentityErrorCode,
    message: string,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentWorkspaceIdentityError';
    this.code = code;
    this.details = details;
  }
}

export interface ReconcileAgentWorkspaceIdentityOptions<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
> {
  buildAgent: (project: P, requestedAgentId?: string) => A;
}

export interface ReconcileAgentWorkspaceIdentityResult<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
> {
  projects: P[];
  agents: A[];
  identities: Array<ResolvedAgentWorkspaceIdentity<P, A>>;
  agentProjections: Array<ResolvedAgentWorkspaceProjection<P, A>>;
  diagnostics: AgentWorkspaceIdentityDiagnostic[];
  changed: boolean;
  createdAgentIds: string[];
  relinkedProjectIds: string[];
}

/**
 * Pure reconciliation policy for the persisted Project ↔ Agent 1:1 invariant.
 *
 * It never guesses through ambiguity and never deletes orphan Agent records.
 * I/O owners run this while holding agent-config-intent.lock, then persist the
 * returned arrays through their existing per-file atomic writers.
 */
export function reconcileAgentWorkspaceIdentities<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
>(
  projects: readonly P[],
  agents: readonly A[],
  options: ReconcileAgentWorkspaceIdentityOptions<P, A>,
): ReconcileAgentWorkspaceIdentityResult<P, A> {
  const nextProjects = projects.map(project => ({ ...project }));
  const nextAgents = [...agents];
  const createdAgentIds: string[] = [];
  const relinkedProjectIds: string[] = [];

  const projectIds = new Set<string>();
  const projectsByWorkspace = new Map<string, P>();
  for (const project of nextProjects) {
    const workspaceIdentity = normalizeWorkspacePathIdentity(project.path);
    if (!project.id || !workspaceIdentity) {
      throw new AgentWorkspaceIdentityError(
        'INVALID_PROJECT_IDENTITY',
        `Project '${project.id || '(missing id)'}' has no canonical workspace path.`,
        { projectId: project.id, workspacePath: project.path },
      );
    }
    if (projectIds.has(project.id)) {
      throw new AgentWorkspaceIdentityError(
        'DUPLICATE_PROJECT_ID',
        `Project id '${project.id}' is duplicated.`,
        { projectId: project.id },
      );
    }
    projectIds.add(project.id);
    projectsByWorkspace.set(workspaceIdentity, project);
  }

  const agentsById = new Map<string, A>();
  const agentsByWorkspace = new Map<string, A[]>();
  for (const agent of nextAgents) {
    if (!agent.id || agentsById.has(agent.id)) {
      throw new AgentWorkspaceIdentityError(
        'DUPLICATE_AGENT_ID',
        `Agent id '${agent.id || '(missing id)'}' is duplicated.`,
        { agentId: agent.id },
      );
    }
    agentsById.set(agent.id, agent);
    const workspaceIdentity = normalizeWorkspacePathIdentity(readLegacyAgentWorkspacePath(agent) ?? '');
    if (!workspaceIdentity) continue;
    const matching = agentsByWorkspace.get(workspaceIdentity) ?? [];
    matching.push(agent);
    agentsByWorkspace.set(workspaceIdentity, matching);
  }

  // Explicit claims reserve an Agent before path-based legacy repair runs. A
  // duplicated claim is isolated as a target diagnostic so unrelated Projects
  // remain usable, but neither claimant may be silently selected or rewritten.
  const conflictState = collectAgentClaimConflicts(nextProjects);
  const workspaceConflictState = collectProjectWorkspaceConflicts(nextProjects);
  const { conflictedAgentIds } = conflictState;
  const conflictedProjectIds = new Set([
    ...conflictState.conflictedProjectIds,
    ...workspaceConflictState.conflictedProjectIds,
  ]);
  const reservedExplicitProjectByAgent = new Map<string, string>();
  for (const [agentId, projectIds] of conflictState.claimsByAgent) {
    if (projectIds.length === 1 && agentsById.has(agentId)) {
      reservedExplicitProjectByAgent.set(agentId, projectIds[0]);
    }
  }

  const assignedProjectByAgent = new Map<string, string>();
  const identities: Array<ResolvedAgentWorkspaceIdentity<P, A>> = [];
  let changed = false;

  for (let index = 0; index < nextProjects.length; index += 1) {
    let project = nextProjects[index];
    if (conflictedProjectIds.has(project.id)) continue;

    const workspaceIdentity = normalizeWorkspacePathIdentity(project.path);
    const matchingAgents = agentsByWorkspace.get(workspaceIdentity) ?? [];
    const linkedAgent = project.agentId ? agentsById.get(project.agentId) : undefined;
    let selectedAgent = linkedAgent;
    if (!selectedAgent) {
      selectedAgent = matchingAgents.find(agent => {
        if (conflictedAgentIds.has(agent.id)) return false;
        const reservedProjectId = reservedExplicitProjectByAgent.get(agent.id);
        return !reservedProjectId || reservedProjectId === project.id;
      });
    }

    if (!selectedAgent) {
      const requestedAgentId = project.agentId || undefined;
      selectedAgent = options.buildAgent(project, requestedAgentId);
      if (!selectedAgent.id || agentsById.has(selectedAgent.id)) {
        throw new AgentWorkspaceIdentityError(
          'CREATED_AGENT_ID_COLLISION',
          `Generated Agent id '${selectedAgent.id || '(missing id)'}' is not unique.`,
          { projectId: project.id, agentId: selectedAgent.id },
        );
      }
      if (requestedAgentId && selectedAgent.id !== requestedAgentId) {
        throw new AgentWorkspaceIdentityError(
          'CREATED_AGENT_ID_COLLISION',
          `Generated Agent '${selectedAgent.id}' did not reuse Project '${project.id}' stale Agent id.`,
          {
            projectId: project.id,
            requestedAgentId,
            generatedAgentId: selectedAgent.id,
          },
        );
      }
      nextAgents.push(selectedAgent);
      agentsById.set(selectedAgent.id, selectedAgent);
      createdAgentIds.push(selectedAgent.id);
      changed = true;
    }

    const priorProjectId = assignedProjectByAgent.get(selectedAgent.id);
    if (priorProjectId) {
      throw new AgentWorkspaceIdentityError(
        'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
        `Agent '${selectedAgent.id}' resolves to multiple Projects.`,
        { agentId: selectedAgent.id, projectIds: [priorProjectId, project.id] },
      );
    }
    assignedProjectByAgent.set(selectedAgent.id, project.id);

    const promoteLegacyProjection = selectedAgent.enabled === true && project.isAgent !== true;
    if (project.agentId !== selectedAgent.id || promoteLegacyProjection) {
      project = {
        ...project,
        agentId: selectedAgent.id,
        ...(promoteLegacyProjection ? { isAgent: true } : {}),
      };
      nextProjects[index] = project;
      relinkedProjectIds.push(project.id);
      changed = true;
    }

    identities.push({
      projectId: project.id,
      agentId: selectedAgent.id,
      workspacePath: project.path,
      project,
      agent: selectedAgent,
    });
  }

  const projectionResult = resolveAgentWorkspaceProjections(nextProjects, nextAgents);

  return {
    projects: nextProjects,
    agents: nextAgents,
    identities,
    agentProjections: projectionResult.agentProjections,
    diagnostics: projectionResult.diagnostics,
    changed,
    createdAgentIds,
    relinkedProjectIds,
  };
}

export interface BuildAgentForProjectOptions {
  agentId?: string;
  defaultPermissionMode?: string;
  agentDefaults?: WorkspaceTemplateAgentDefaults;
  templates?: readonly WorkspaceTemplate[];
}

function cloneHeartbeatConfig(defaults: WorkspaceTemplateAgentDefaults['heartbeat']) {
  if (!defaults) return undefined;
  return {
    ...defaults,
    activeHours: defaults.activeHours ? { ...defaults.activeHours } : undefined,
  };
}

export function resolveAgentDefaultsForProject(
  project: Pick<Project, 'templateSource' | 'templateId'>,
  templates: readonly WorkspaceTemplate[] = PRESET_TEMPLATES,
): WorkspaceTemplateAgentDefaults | undefined {
  if (project.templateSource !== 'builtin' || !project.templateId) return undefined;
  return templates.find(template => template.isBuiltin && template.id === project.templateId)?.agentDefaults;
}

/** Build the existing basic Agent shape from a Project; shared by both I/O owners. */
export function buildAgentForProject(
  project: Project,
  options: BuildAgentForProjectOptions = {},
): AgentConfig {
  const agentDefaults = options.agentDefaults ?? resolveAgentDefaultsForProject(project, options.templates);
  return {
    id: options.agentId ?? crypto.randomUUID(),
    name: project.displayName || project.name,
    icon: project.icon,
    enabled: agentDefaults?.enabled ?? false,
    channels: [],
    providerId: project.providerId ?? undefined,
    model: project.model ?? undefined,
    permissionMode: project.permissionMode || options.defaultPermissionMode || 'plan',
    mcpEnabledServers: project.mcpEnabledServers,
    enabledPluginIds: project.enabledPluginIds,
    enabledOfficialToolIds: project.enabledOfficialToolIds,
    heartbeat: cloneHeartbeatConfig(agentDefaults?.heartbeat),
    memoryAutoUpdate: agentDefaults?.memoryAutoUpdate
      ? { ...agentDefaults.memoryAutoUpdate }
      : undefined,
    memoryEvolution: agentDefaults?.memoryEvolution
      ? { ...agentDefaults.memoryEvolution }
      : undefined,
  };
}
