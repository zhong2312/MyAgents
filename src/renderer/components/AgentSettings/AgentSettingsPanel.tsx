// Agent settings panel — flat layout with section dividers
// NOTE: This panel is still used by the Settings page Agent card list.
// The new WorkspaceGeneralTab replaces it inside WorkspaceConfigPanel.
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { getAgentById } from '@/config/services/agentConfigService';
import type { AgentConfig } from '../../../shared/types/agent';
import AgentBasicsSection from './sections/AgentBasicsSection';
import AgentChannelsSection from './sections/AgentChannelsSection';
import AgentToolsSection from './sections/AgentToolsSection';
import AgentHeartbeatSection from './sections/AgentHeartbeatSection';
import AgentMemoryUpdateSection from './sections/AgentMemoryUpdateSection';
import AgentMemoryEvolutionSection from './sections/AgentMemoryEvolutionSection';
import AgentTasksSection from './sections/AgentTasksSection';
import WorkspaceIcon from '../launcher/WorkspaceIcon';
import { DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import { resolveAgentWorkspaceProjections } from '../../../shared/agentWorkspaceIdentity';

interface AgentSettingsPanelProps {
  agentId: string;
}

export default function AgentSettingsPanel({ agentId }: AgentSettingsPanelProps) {
  const { t } = useTranslation('settings');
  const { config, projects, refreshConfig } = useConfig();
  const { statuses, refresh: refreshStatuses } = useAgentStatuses();
  const [agent, setAgent] = useState<AgentConfig | undefined>(() => getAgentById(config, agentId));

  useEffect(() => {
    setAgent(getAgentById(config, agentId));
  }, [config, agentId]);

  const handleAgentChanged = useCallback(async () => {
    await refreshConfig();
    await refreshStatuses();
  }, [refreshConfig, refreshStatuses]);
  const workspacePath = useMemo(
    () => resolveAgentWorkspaceProjections(projects, config.agents ?? []).agentProjections
      .find(item => item.agentId === agentId)?.workspacePath,
    [agentId, config.agents, projects],
  );

  if (!agent) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-[var(--ink-subtle)]">
          {t('agentSettings.panel.agentNotFound', { id: agentId })}
        </span>
      </div>
    );
  }

  const status = statuses[agentId];
  const proj = projects.find(p => p.agentId === agentId);
  const displayName = proj?.displayName || proj?.name || agent.name;
  const iconId = proj?.icon || agent.icon || DEFAULT_WORKSPACE_ICON;

  return (
    <div className="space-y-0 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 pb-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--paper-inset)]">
          <WorkspaceIcon icon={iconId} size={24} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-[var(--ink)]">
            {displayName}
          </h2>
          <span className="text-xs text-[var(--ink-subtle)]">
            {workspacePath ?? '—'}
          </span>
        </div>
      </div>

      {/* Basics */}
      <div className="border-b border-[var(--line)] pb-6">
        <AgentBasicsSection agent={agent} status={status} onAgentChanged={handleAgentChanged} />
      </div>

      {/* Channels */}
      <div className="border-b border-[var(--line)] pb-6 pt-6">
        <AgentChannelsSection agent={agent} status={status} onAgentChanged={handleAgentChanged} />
      </div>

      {/* MCP Tools */}
      <div className="border-b border-[var(--line)] pb-6 pt-6">
        <AgentToolsSection agent={agent} onAgentChanged={handleAgentChanged} />
      </div>

      {/* Heartbeat */}
      <div className="border-b border-[var(--line)] pb-6 pt-6">
        {workspacePath && <AgentHeartbeatSection agent={agent} workspacePath={workspacePath} onAgentChanged={handleAgentChanged} />}
      </div>

      {/* Memory Auto-Update (v0.1.43) */}
      <div className="border-b border-[var(--line)] pb-6 pt-6">
        {workspacePath && <AgentMemoryUpdateSection agent={agent} workspacePath={workspacePath} onAgentChanged={handleAgentChanged} />}
      </div>

      {/* Long-Term Memory Evolution */}
      <div className="border-b border-[var(--line)] pb-6 pt-6">
        {workspacePath && <AgentMemoryEvolutionSection
          agent={agent}
          workspaceId={proj?.id ?? agent.id}
          workspacePath={workspacePath}
          onAgentChanged={handleAgentChanged}
        />}
      </div>

      {/* Tasks (read-only) */}
      <div className="pt-6">
        {workspacePath && <AgentTasksSection workspacePath={workspacePath} />}
      </div>
    </div>
  );
}
