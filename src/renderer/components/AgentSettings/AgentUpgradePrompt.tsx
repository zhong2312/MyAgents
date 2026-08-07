// Shown when a workspace is not yet an Agent — explains benefits + upgrade button
import { useCallback, useEffect, useRef } from 'react';
import { HeartPulse } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { enableAgentAndStartChannels, reconcilePersistedAgentWorkspaceIdentities } from '@/config/services/agentConfigService';

interface AgentUpgradePromptProps {
  projectId: string;
  onUpgraded?: (agentId: string) => void;
}

export default function AgentUpgradePrompt({ projectId, onUpgraded }: AgentUpgradePromptProps) {
  const { t } = useTranslation('settings');
  const { projects, patchProject, refreshConfig } = useConfig();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleUpgrade = useCallback(async () => {
    try {
      const project = projects.find(p => p.id === projectId);
      if (!project) throw new Error(`Project '${projectId}' not found.`);
      const identity = await reconcilePersistedAgentWorkspaceIdentities();
      const agent = identity.agentProjections.find(item => item.projectId === projectId)?.agent;
      if (!agent) throw new Error(`Could not resolve Agent for Project '${projectId}'.`);
      await enableAgentAndStartChannels(agent.id);
      await patchProject(projectId, { isAgent: true });
      await refreshConfig();

      if (isMountedRef.current) onUpgraded?.(agent.id);
    } catch (e) {
      console.error('[AgentUpgradePrompt] Upgrade failed:', e);
    }
  }, [projectId, projects, patchProject, refreshConfig, onUpgraded]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      <HeartPulse className="h-10 w-10 text-[var(--heartbeat)]" />
      <h2 className="text-lg font-semibold text-[var(--ink)]">
        {t('agentSettings.upgrade.title')}
      </h2>
      <p className="max-w-md text-center text-sm text-[var(--ink-muted)]">
        {t('agentSettings.upgrade.description')}
      </p>
      <ul className="max-w-md text-sm text-[var(--ink-muted)]">
        <li className="mb-1">• {t('agentSettings.upgrade.benefitShared')}</li>
        <li className="mb-1">• {t('agentSettings.upgrade.benefitOverrides')}</li>
        <li className="mb-1">• {t('agentSettings.upgrade.benefitUnified')}</li>
        <li>• {t('agentSettings.upgrade.benefitRouting')}</li>
      </ul>
      <button
        className="rounded-lg bg-[var(--button-primary-bg)] px-6 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        onClick={handleUpgrade}
      >
        {t('agentSettings.upgrade.action')}
      </button>
    </div>
  );
}
