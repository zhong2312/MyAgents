// Agent memory auto-update section (v0.1.43)
import { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { MemoryAutoUpdateConfig } from '../../../../shared/types/im';
import { DEFAULT_MEMORY_AUTO_UPDATE_CONFIG } from '../../../../shared/types/im';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { useToast } from '@/components/Toast';

const FilePreviewModal = lazy(() => import('../../FilePreviewModal'));

interface AgentMemoryUpdateSectionProps {
  agent: AgentConfig;
  workspacePath: string;
  onAgentChanged: () => void | Promise<void>;
}

const INTERVAL_OPTIONS = [24, 48, 72] as const;

export default function AgentMemoryUpdateSection({ agent, workspacePath, onAgentChanged }: AgentMemoryUpdateSectionProps) {
  const { t } = useTranslation('settings');
  const config = agent.memoryAutoUpdate;

  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [previewFile, setPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);

  const updateConfig = useCallback(async (patch: Partial<MemoryAutoUpdateConfig>) => {
    const current = agent.memoryAutoUpdate ?? { ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG, enabled: false };
    try {
      await patchAgentConfig(agent.id, {
        memoryAutoUpdate: { ...current, ...patch },
      }, {
        memoryAutoUpdateReconcileFailure: 'throw',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[AgentMemoryUpdateSection] Memory update settings were not fully applied:', error);
      toastRef.current.error(t('agentSettings.memory.taskReconcileFailed', { message }));
    } finally {
      await onAgentChanged();
    }
  }, [agent.id, agent.memoryAutoUpdate, onAgentChanged, t]);

  // Resolve file path (cross-platform separator)
  const filePath = `${workspacePath}${workspacePath.includes('\\') ? '\\' : '/'}UPDATE_MEMORY.md`;

  const ensureRuleSubstrate = useCallback(async (): Promise<boolean> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_ensure_memory_rule_substrate', {
        workspacePath,
      });
      return true;
    } catch (e) {
      console.warn('[AgentMemoryUpdateSection] Memory rule substrate ensure failed:', e);
      toastRef.current.error(t('agentSettings.memory.fileError'));
      return false;
    }
  }, [workspacePath, t]);

  // Read or create file via Rust invoke (bypasses Tauri fs plugin scope)
  const ensureFile = useCallback(async (): Promise<{ ok: boolean; content: string }> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ content: string; created: boolean }>('cmd_ensure_update_memory_file', {
        workspacePath,
      });
      if (result.created) {
        toastRef.current.success(t('agentSettings.memory.createdFile'));
      }
      return { ok: true, content: result.content };
    } catch (e) {
      console.warn('[AgentMemoryUpdateSection] File operation failed:', e);
      toastRef.current.error(t('agentSettings.memory.fileError'));
      return { ok: false, content: '' };
    }
  }, [workspacePath, t]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !(config?.enabled ?? false);
    if (newEnabled) {
      const substrate = await ensureRuleSubstrate();
      if (!substrate) return;
    }
    await updateConfig({ enabled: newEnabled });
  }, [config?.enabled, ensureRuleSubstrate, updateConfig]);

  const handleOpenFile = useCallback(async () => {
    const { ok, content } = await ensureFile();
    if (!ok) return;
    setPreviewFile({ name: 'UPDATE_MEMORY.md', content, size: new TextEncoder().encode(content).length, path: filePath });
  }, [ensureFile, filePath]);

  const handleDirectSave = useCallback(async (content: string) => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_write_workspace_file', { path: filePath, content });
  }, [filePath]);

  const handleRevealFile = useCallback(async () => {
    if (!previewFile) return;
    const parentDir = previewFile.path.substring(0, previewFile.path.lastIndexOf('/'))
      || previewFile.path.substring(0, previewFile.path.lastIndexOf('\\'));
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parentDir);
  }, [previewFile]);

  const enabled = config?.enabled ?? false;
  const intervalHours = config?.intervalHours ?? 24;
  const queryThreshold = config?.queryThreshold ?? DEFAULT_MEMORY_AUTO_UPDATE_CONFIG.queryThreshold;
  const windowStart = config?.updateWindowStart ?? DEFAULT_MEMORY_AUTO_UPDATE_CONFIG.updateWindowStart;
  const windowEnd = config?.updateWindowEnd ?? DEFAULT_MEMORY_AUTO_UPDATE_CONFIG.updateWindowEnd;

  // Last batch info
  const lastBatchAt = config?.lastBatchAt;
  const lastBatchCount = config?.lastBatchSessionCount;
  let lastBatchLabel = '';
  if (lastBatchAt) {
    const dt = new Date(lastBatchAt);
    const diffMs = Date.now() - dt.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) lastBatchLabel = t('agentSettings.memory.lessThanHourAgo');
    else if (diffH < 24) lastBatchLabel = t('agentSettings.memory.hoursAgo', { count: diffH });
    else lastBatchLabel = t('agentSettings.memory.daysAgo', { count: Math.floor(diffH / 24) });
    if (lastBatchCount !== undefined && lastBatchCount !== null) {
      lastBatchLabel += ` · ${t('agentSettings.memory.sessionsUpdated', { count: lastBatchCount })}`;
    }
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header + Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium text-[var(--ink)]">{t('agentSettings.memory.title')}</h3>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              {t('agentSettings.memory.descriptionPrefix')}{' '}
              <button
                type="button"
                onClick={handleOpenFile}
                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
              >
                UPDATE_MEMORY.md
              </button>
              {' '}{t('agentSettings.memory.descriptionSuffix')}
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

        {enabled && (
          <div>
            <button
              type="button"
              aria-expanded={moreSettingsOpen}
              onClick={() => setMoreSettingsOpen(open => !open)}
              className="flex items-center gap-2 text-sm font-medium text-[var(--ink)] transition-colors hover:text-[var(--accent)]"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${moreSettingsOpen ? '' : '-rotate-90'}`} />
              {t('agentSettings.common.moreSettings')}
            </button>

            {moreSettingsOpen && (
              <div className="mt-4 space-y-4 pl-0">
                {/* Interval */}
                <div>
                  <label className="block text-sm font-medium text-[var(--ink)] mb-2">{t('agentSettings.memory.interval')}</label>
                  <div className="flex gap-2">
                    {INTERVAL_OPTIONS.map(hours => (
                      <button
                        key={hours}
                        type="button"
                        onClick={() => updateConfig({ intervalHours: hours })}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                          intervalHours === hours
                            ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                            : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--paper-hover)]'
                        }`}
                      >
                        {t('agentSettings.memory.intervalHours', { count: hours })}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Update Window */}
                <div>
                  <label className="block text-sm font-medium text-[var(--ink)] mb-2">{t('agentSettings.memory.window')}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={windowStart}
                      onChange={e => updateConfig({ updateWindowStart: e.target.value })}
                      className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                    <span className="text-xs text-[var(--ink-muted)]">—</span>
                    <input
                      type="time"
                      value={windowEnd}
                      onChange={e => updateConfig({ updateWindowEnd: e.target.value })}
                      className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                    <span className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)]">
                      {config?.updateWindowTimezone || agent.heartbeat?.activeHours?.timezone || 'Asia/Shanghai'}
                    </span>
                  </div>
                </div>

                {/* Threshold */}
                <div>
                  <label className="block text-sm font-medium text-[var(--ink)] mb-2">{t('agentSettings.memory.threshold')}</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--ink-muted)]">{t('agentSettings.memory.thresholdPrefix')}</span>
                    <input
                      type="number"
                      min={3}
                      max={50}
                      value={queryThreshold}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        if (v >= 3 && v <= 50) updateConfig({ queryThreshold: v });
                      }}
                      className="w-14 rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)] text-center border border-[var(--line)]"
                    />
                    <span className="text-xs text-[var(--ink-muted)]">{t('agentSettings.memory.thresholdSuffix')}</span>
                  </div>
                </div>

                {/* Last batch info */}
                {lastBatchLabel && (
                  <div className="border-t border-dashed border-[var(--line)] pt-3">
                    <span className="text-xs text-[var(--ink-muted)]">
                      {t('agentSettings.memory.lastUpdated', { time: lastBatchLabel })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* FilePreviewModal */}
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={previewFile.name}
            content={previewFile.content}
            size={previewFile.size}
            path={previewFile.path}
            onClose={() => setPreviewFile(null)}
            onSave={handleDirectSave}
            onRevealFile={handleRevealFile}
          />
        </Suspense>
      )}
    </>
  );
}
