// WorkspaceGeneralTab — the "通用" tab in WorkspaceConfigPanel
// Flat layout: section titles + dividers, no outer card borders

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { getAgentById, disableAgentAndStopChannels, enableAgentAndStartChannels, reconcilePersistedAgentWorkspaceIdentities } from '@/config/services/agentConfigService';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import { DEFAULT_HEARTBEAT_CONFIG, DEFAULT_MEMORY_AUTO_UPDATE_CONFIG } from '../../../shared/types/im';
import WorkspaceBasicsSection from './WorkspaceBasicsSection';
import AgentChannelsSection from './sections/AgentChannelsSection';
import AgentHeartbeatSection from './sections/AgentHeartbeatSection';
import AgentMemoryUpdateSection from './sections/AgentMemoryUpdateSection';
import AgentMemoryEvolutionSection from './sections/AgentMemoryEvolutionSection';
import AgentTasksSection from './sections/AgentTasksSection';
import { Settings2, HeartPulse } from 'lucide-react';

interface WorkspaceGeneralTabProps {
  agentDir: string;
}

export default function WorkspaceGeneralTab({ agentDir }: WorkspaceGeneralTabProps) {
  const { t } = useTranslation('settings');
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const project = projects.find(p => workspacePathsEqual(p.path, agentDir));
  const agent = project?.agentId ? getAgentById(config, project.agentId) : undefined;
  const isProactive = !!(project?.isAgent && agent?.enabled);
  const { statuses, refresh: refreshStatuses } = useAgentStatuses(isProactive);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  const [toggling, setToggling] = useState(false);
  const [togglingWorkspacePanel, setTogglingWorkspacePanel] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleAgentChanged = useCallback(async () => {
    await refreshConfig();
    await refreshStatuses();
  }, [refreshConfig, refreshStatuses]);

  // Toggle proactive agent mode
  const handleToggleProactive = useCallback(async () => {
    if (!project || toggling) return;
    setToggling(true);
    try {
      if (agent && !agent.enabled) {
        // Upgrade existing basicAgent to proactive mode
        await enableAgentAndStartChannels(agent.id, {
          heartbeat: agent.heartbeat ?? {
            ...DEFAULT_HEARTBEAT_CONFIG,
            enabled: true,
          },
          memoryAutoUpdate: agent.memoryAutoUpdate ?? { ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG },
        });
        if (!project.isAgent) {
          await patchProject(project.id, { isAgent: true });
        }
        toastRef.current.success(t('agentSettings.general.enabled'));
      } else if (!agent) {
        const identity = await reconcilePersistedAgentWorkspaceIdentities();
        const created = identity.agentProjections.find(item => item.projectId === project.id)?.agent;
        if (!created) throw new Error(`Could not create Agent for Project '${project.id}'.`);
        await enableAgentAndStartChannels(created.id, {
          heartbeat: { ...DEFAULT_HEARTBEAT_CONFIG, enabled: true },
          memoryAutoUpdate: { ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG },
        });
        await patchProject(project.id, { isAgent: true });
        toastRef.current.success(t('agentSettings.general.enabled'));
      } else if (agent.enabled) {
        // Disable — stop all running channels first
        const stoppedCount = await disableAgentAndStopChannels(agent);
        toastRef.current.success(
          stoppedCount > 0
            ? t('agentSettings.general.disabledWithChannels', { count: stoppedCount })
            : t('agentSettings.general.disabled'),
        );
      } else {
        // Re-enable — auto-restart channels that have credentials (setupCompleted)
        const startedCount = await enableAgentAndStartChannels(agent.id);
        toastRef.current.success(
          startedCount > 0
            ? t('agentSettings.general.enabledWithChannels', { count: startedCount })
            : t('agentSettings.general.enabled'),
        );
        if (isMountedRef.current) await refreshStatuses();
        if (isMountedRef.current) setToggling(false);
        await refreshConfig();
        return;
      }
      await refreshConfig();
      if (isMountedRef.current) await refreshStatuses();
    } catch (e) {
      console.error('[WorkspaceGeneralTab] Toggle proactive failed:', e);
      toastRef.current.error(t('agentSettings.general.operationFailed'));
    } finally {
      if (isMountedRef.current) setToggling(false);
    }
  }, [project, agent, toggling, patchProject, refreshConfig, refreshStatuses, t]);

  const handleToggleWorkspacePanel = useCallback(async () => {
    if (!project || togglingWorkspacePanel) return;
    setTogglingWorkspacePanel(true);
    try {
      await patchProject(project.id, {
        workspacePanelVisible: project.workspacePanelVisible === false,
      });
    } catch (error) {
      console.error('[WorkspaceGeneralTab] Toggle workspace panel failed:', error);
      toastRef.current.error(t('agentSettings.general.operationFailed'));
    } finally {
      if (isMountedRef.current) setTogglingWorkspacePanel(false);
    }
  }, [patchProject, project, t, togglingWorkspacePanel]);

  const status = agent ? statuses[agent.id] : undefined;

  if (!project) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-[var(--ink-subtle)]">{t('agentSettings.general.missingWorkspace')}</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="mx-auto max-w-2xl space-y-6 pb-8">
        {/* Card 1: Basic settings */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
            <Settings2 className="h-[18px] w-[18px] text-[var(--ink-muted)]" />
            {t('agentSettings.general.basicsTitle')}
          </h3>
          <div className="mt-4">
            <WorkspaceBasicsSection project={project} agent={agent} agentDir={agentDir} />
          </div>
        </div>

        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-medium text-[var(--ink)]">
                {t('agentSettings.general.workspacePanelTitle')}
              </h3>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {t('agentSettings.general.workspacePanelDescription')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={project.workspacePanelVisible !== false}
              aria-label={t('agentSettings.general.workspacePanelTitle')}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                togglingWorkspacePanel ? 'cursor-wait opacity-50' : 'cursor-pointer'
              } ${
                project.workspacePanelVisible !== false ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
              }`}
              onClick={handleToggleWorkspacePanel}
              disabled={togglingWorkspacePanel}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                  project.workspacePanelVisible !== false ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Card 2: Proactive Agent mode */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <div className="flex items-center justify-between">
            <div className="flex-1 pr-4">
              <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
                <HeartPulse className="h-[18px] w-[18px] text-[var(--heartbeat)]" />
                {t('agentSettings.general.proactiveTitle')}
              </h3>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {t('agentSettings.general.proactiveDescription')}
              </p>
            </div>
            <button
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                toggling ? 'cursor-wait opacity-50' : 'cursor-pointer'
              } ${
                isProactive ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
              }`}
              onClick={handleToggleProactive}
              disabled={toggling}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                  isProactive ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Sub-sections: Channels / Heartbeat / Tasks */}
          {isProactive && agent && (
            <>
              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentChannelsSection agent={agent} status={status} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentHeartbeatSection agent={agent} workspacePath={project.path} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentMemoryUpdateSection agent={agent} workspacePath={project.path} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentMemoryEvolutionSection
                  agent={agent}
                  workspaceId={project.id}
                  workspacePath={project.path}
                  onAgentChanged={handleAgentChanged}
                />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentTasksSection workspacePath={project.path} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
