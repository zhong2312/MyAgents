import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '../../../../shared/types/agent';
import {
  DEFAULT_MEMORY_EVOLUTION_CONFIG,
  type MemoryEvolutionConfig,
} from '../../../../shared/types/im';
import {
  configureMemoryEvolutionTasksForAgent,
  patchAgentConfig,
} from '@/config/services/agentConfigService';
import { useToast } from '@/components/Toast';

interface AgentMemoryEvolutionSectionProps {
  agent: AgentConfig;
  workspaceId: string;
  workspacePath: string;
  onAgentChanged: () => void;
}

export default function AgentMemoryEvolutionSection({
  agent,
  workspaceId,
  workspacePath,
  onAgentChanged,
}: AgentMemoryEvolutionSectionProps) {
  const { t } = useTranslation('settings');
  const toast = useToast();
  const toastRef = useRef(toast);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const ensureRuleSubstrate = useCallback(async (): Promise<boolean> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_ensure_memory_rule_substrate', {
        workspacePath,
      });
      return true;
    } catch (e) {
      console.warn('[AgentMemoryEvolutionSection] Memory rule substrate ensure failed:', e);
      toastRef.current.error(t('agentSettings.memory.fileError'));
      return false;
    }
  }, [workspacePath, t]);

  const updateConfig = useCallback(async (patch: Partial<MemoryEvolutionConfig>) => {
    const current = agent.memoryEvolution ?? {
      ...DEFAULT_MEMORY_EVOLUTION_CONFIG,
      enabled: false,
    };
    await patchAgentConfig(agent.id, {
      memoryEvolution: { ...current, ...patch },
    });
    onAgentChanged();
  }, [agent.id, agent.memoryEvolution, onAgentChanged]);

  const configureManagedTasks = useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      await configureMemoryEvolutionTasksForAgent(agent, workspaceId, workspacePath, enabled);
      return true;
    } catch (e) {
      console.warn('[AgentMemoryEvolutionSection] Configure managed tasks failed:', e);
      toastRef.current.error(t('agentSettings.memoryEvolution.taskError'));
      return false;
    }
  }, [agent, t, workspaceId, workspacePath]);

  const enabled = agent.memoryEvolution?.enabled ?? false;

  const handleToggle = useCallback(async () => {
    const nextEnabled = !enabled;
    if (nextEnabled) {
      const ok = await ensureRuleSubstrate();
      if (!ok) return;
    }
    await updateConfig({ enabled: nextEnabled });
    const tasksOk = await configureManagedTasks(nextEnabled);
    if (!tasksOk) {
      try {
        await updateConfig({ enabled });
      } catch (e) {
        console.warn('[AgentMemoryEvolutionSection] Rollback memory evolution config failed:', e);
      }
    }
  }, [configureManagedTasks, enabled, ensureRuleSubstrate, updateConfig]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex-1 pr-4">
          <h3 className="text-base font-medium text-[var(--ink)]">
            {t('agentSettings.memoryEvolution.title')}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {t('agentSettings.memoryEvolution.description')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
            enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    </div>
  );
}
