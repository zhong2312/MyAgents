import {
  AgentWorkspaceIdentityError,
  buildAgentForProject,
  reconcileAgentWorkspaceIdentities,
  resolveAgentWorkspaceProjections,
  type AgentWorkspaceIdentityDiagnostic,
  type ResolvedAgentWorkspaceProjection,
  type ResolvedAgentWorkspaceIdentity,
} from '../../shared/agentWorkspaceIdentity';
import { type PermissionMode, type Project } from '../../shared/config-types';
import type { AgentConfig } from '../../shared/types/agent';
import { broadcast } from '../sse';
import {
  atomicModifyConfig,
  atomicModifyProjects,
  loadConfig,
  loadProjects,
  withAgentConfigIntentLock,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ProjectSlim,
} from './admin-config';

export type PersistedAgentWorkspaceIdentity = ResolvedAgentWorkspaceIdentity<
  ProjectSlim,
  AgentConfigSlim
>;
export type PersistedAgentWorkspaceProjection = ResolvedAgentWorkspaceProjection<
  ProjectSlim,
  AgentConfigSlim
>;

export interface PersistedAgentWorkspaceRegistry {
  config: AdminAppConfig;
  projects: ProjectSlim[];
  identities: PersistedAgentWorkspaceIdentity[];
  agentProjections: PersistedAgentWorkspaceProjection[];
  diagnostics: AgentWorkspaceIdentityDiagnostic[];
  repaired: boolean;
  repairDeferred: boolean;
  createdAgentIds: string[];
  relinkedProjectIds: string[];
}

function projectBuildOptions(config: AdminAppConfig) {
  return {
    buildAgent: (project: ProjectSlim, requestedAgentId?: string) => buildAgentForProject(
      asProjectBuildSource(project),
      {
        agentId: requestedAgentId,
        defaultPermissionMode: config.defaultPermissionMode,
      },
    ) as AgentConfig as AgentConfigSlim,
  };
}

function registryFromPersistedSnapshot(
  config: AdminAppConfig,
  projects: ProjectSlim[],
  repairDeferred: boolean,
): PersistedAgentWorkspaceRegistry {
  const projection = resolveAgentWorkspaceProjections(projects, config.agents ?? []);
  const identities = projection.agentProjections
    .filter(item => item.association === 'project-linked' && item.project)
    .map(item => ({
      projectId: item.projectId!,
      agentId: item.agentId,
      workspacePath: item.workspacePath,
      project: item.project!,
      agent: item.agent,
    }));
  return {
    config,
    projects,
    identities,
    agentProjections: projection.agentProjections,
    diagnostics: projection.diagnostics,
    repaired: false,
    repairDeferred,
    createdAgentIds: [],
    relinkedProjectIds: [],
  };
}

function asProjectBuildSource(project: ProjectSlim): Project {
  const permissionMode = project.permissionMode;
  const normalizedPermissionMode: PermissionMode | null =
    permissionMode === 'auto' || permissionMode === 'plan' || permissionMode === 'fullAgency'
      ? permissionMode
      : null;
  return {
    ...(project as unknown as Project),
    providerId: typeof project.providerId === 'string' ? project.providerId : null,
    permissionMode: normalizedPermissionMode,
    model: typeof project.model === 'string' ? project.model : null,
  };
}

/**
 * Resolve the disk authorities to the required Agent↔Workspace domain.
 * Repairs are serialized by the existing cross-process intent lock. Project
 * links commit before newly-created pathless Agents so a retry can rebuild the
 * same stale ID after an interruption.
 */
export async function resolvePersistedAgentWorkspaceRegistry(): Promise<PersistedAgentWorkspaceRegistry> {
  return withAgentConfigIntentLock(async () => {
    let projectResult: ReturnType<
      typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
    > | undefined;
    let projects: ProjectSlim[];
    try {
      projects = await atomicModifyProjects(currentProjects => {
      const currentConfig = loadConfig();
      projectResult = reconcileAgentWorkspaceIdentities(
        currentProjects,
        currentConfig.agents ?? [],
        projectBuildOptions(currentConfig),
      );
      return projectResult.projects;
      });
    } catch (error) {
      const fallbackConfig = loadConfig();
      const fallback = reconcileAgentWorkspaceIdentities(
        loadProjects(),
        fallbackConfig.agents ?? [],
        projectBuildOptions(fallbackConfig),
      );
      if (fallback.createdAgentIds.length > 0) throw error;
      console.warn('[agent-identity] code=IDENTITY_REPAIR_DEFERRED operation=project-link');
      return {
        ...registryFromPersistedSnapshot(fallbackConfig, fallback.projects, true),
        identities: fallback.identities,
        agentProjections: fallback.agentProjections,
        diagnostics: fallback.diagnostics,
        relinkedProjectIds: fallback.relinkedProjectIds,
      };
    }

    if (!projectResult) {
      throw new Error('Agent identity reconciliation did not produce a registry.');
    }
    if (projectResult.createdAgentIds.length === 0) {
      const config = loadConfig();
      return {
        ...registryFromPersistedSnapshot(config, projects, false),
        identities: projectResult.identities,
        agentProjections: projectResult.agentProjections,
        diagnostics: projectResult.diagnostics,
        repaired: projectResult.changed,
        relinkedProjectIds: projectResult.relinkedProjectIds,
      };
    }

    let configResult: ReturnType<
      typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
    > | undefined;
    let config: AdminAppConfig;
    try {
      config = await atomicModifyConfig(current => {
        configResult = reconcileAgentWorkspaceIdentities(
          projects,
          current.agents ?? [],
          projectBuildOptions(current),
        );
        return configResult.changed ? { ...current, agents: configResult.agents } : current;
      });
    } catch {
      console.warn('[agent-identity] code=AGENT_MATERIALIZATION_DEFERRED operation=agent-birth');
      return registryFromPersistedSnapshot(loadConfig(), loadProjects(), true);
    }
    if (!projectResult || !configResult) {
      throw new Error('Agent identity reconciliation did not produce a registry.');
    }
    const registry: PersistedAgentWorkspaceRegistry = {
      config,
      projects: configResult.projects,
      identities: configResult.identities,
      agentProjections: configResult.agentProjections,
      diagnostics: configResult.diagnostics,
      repaired: projectResult.changed || configResult.changed,
      repairDeferred: false,
      createdAgentIds: configResult.createdAgentIds,
      relinkedProjectIds: projectResult.relinkedProjectIds,
    };
    if (registry.repaired) {
      broadcast('config:changed', {
        section: 'agent-identity',
        action: 'repair',
        createdAgentIds: registry.createdAgentIds,
        relinkedProjectIds: registry.relinkedProjectIds,
      });
    }
    return registry;
  });
}

export function agentWorkspaceIdentityFailure(error: unknown): {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof AgentWorkspaceIdentityError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
