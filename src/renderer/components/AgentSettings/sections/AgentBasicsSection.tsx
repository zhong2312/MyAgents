// Agent basics: name, icon, provider+model, permission, enable/disable
import { useState, useCallback, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { isProviderAvailable } from '@/config/services/providerService';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';
import { patchAgentConfig, setProactiveAgentEnabled } from '@/config/services/agentConfigService';

interface AgentBasicsSectionProps {
  agent: AgentConfig;
  status?: AgentStatusData;
  onAgentChanged: () => void;
}

function permissionLabel(mode: string | undefined, t: TFunction<'settings'>): string {
  if (mode === 'fullAgency') return `🚀 ${t('agentSettings.permission.fullAgency')}`;
  if (mode === 'auto') return `⚡ ${t('agentSettings.permission.auto')}`;
  return `📋 ${t('agentSettings.permission.plan')}`;
}

export default function AgentBasicsSection({ agent, onAgentChanged }: AgentBasicsSectionProps) {
  const { t } = useTranslation('settings');
  const { providers, apiKeys, providerVerifyStatus } = useConfig();
  const [name, setName] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  const saveField = useCallback(async (patch: Partial<AgentConfig>) => {
    setSaving(true);
    try {
      await patchAgentConfig(agent.id, patch);
      if (isMountedRef.current) onAgentChanged();
    } catch (e) {
      console.error('[AgentBasics] Save failed:', e);
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [agent.id, onAgentChanged]);

  const handleNameBlur = useCallback(() => {
    if (name !== agent.name && name.trim()) {
      saveField({ name: name.trim() });
    }
  }, [name, agent.name, saveField]);

  const handleToggleEnabled = useCallback(async () => {
    setSaving(true);
    try {
      await setProactiveAgentEnabled(agent.id, !agent.enabled);
      if (isMountedRef.current) onAgentChanged();
    } catch (error) {
      console.error('[AgentBasics] Toggle proactive mode failed:', error);
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [agent.enabled, agent.id, onAgentChanged]);

  const selectedProvider = providers.find(p => p.id === agent.providerId);
  const modelDisplay = agent.model || selectedProvider?.primaryModel || t('agentSettings.basics.notSet');
  // Summary is read-only (no picker here) so we show the persisted value
  // as-is, but annotate when credentials are missing so the user isn't
  // surprised by a runtime failure. Same treatment as WorkspaceBasicsSection.
  const isSelectedProviderAvailable = selectedProvider
    ? isProviderAvailable(selectedProvider, apiKeys, providerVerifyStatus)
    : true;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.basics.basicInfo')}</h3>

      {/* Name */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">{t('agentSettings.basics.name')}</label>
        <input
          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          disabled={saving}
        />
      </div>

      {/* Provider + Model (read-only summary) */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">{t('agentSettings.basics.model')}</label>
        <span className="flex items-center gap-2 text-sm text-[var(--ink)]">
          <span>{selectedProvider?.name ?? t('agentSettings.basics.defaultProvider')} / {modelDisplay}</span>
          {!isSelectedProviderAvailable && selectedProvider && (
            <span
              className="rounded px-1.5 py-0.5 text-xs font-medium text-[var(--warning)]"
              title={t('agentSettings.basics.providerUnavailableHint')}
            >
              ⚠ {t('agentSettings.basics.unavailable')}
            </span>
          )}
        </span>
      </div>

      {/* Permission Mode */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">{t('agentSettings.basics.permission')}</label>
        <span className="text-sm text-[var(--ink)]">
          {permissionLabel(agent.permissionMode, t)}
        </span>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">{t('agentSettings.basics.status')}</label>
        <button
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            agent.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
          }`}
          onClick={handleToggleEnabled}
          disabled={saving}
        >
          <span
            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
              agent.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className="text-xs text-[var(--ink-muted)]">
          {agent.enabled ? t('agentSettings.basics.enabled') : t('agentSettings.basics.disabled')}
        </span>
      </div>
    </div>
  );
}
