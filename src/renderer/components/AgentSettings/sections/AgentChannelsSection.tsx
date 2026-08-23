// Agent channels section: list channels, add/remove, start/stop, configure
// All channel operations open in a unified overlay panel (same size as WorkspaceConfigPanel)
import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Plus, X, Loader2 } from 'lucide-react';
import type { AgentConfig, ChannelConfig, ChannelType } from '../../../../shared/types/agent';
import type { AgentStatusData, ChannelStatusData } from '@/hooks/useAgentStatuses';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { dismissTopmost } from '@/utils/closeLayer';
import { startAndEnableAgentChannel, stopAndDisableAgentChannel } from '@/config/services/agentConfigService';
import ChannelPlatformSelect from '../channels/ChannelPlatformSelect';
import ChannelWizard from '../channels/ChannelWizard';
import ChannelDetailView from '../channels/ChannelDetailView';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';
import { resolveChannelDisplayName } from '@/utils/channelDisplayName';

interface AgentChannelsSectionProps {
  agent: AgentConfig;
  status?: AgentStatusData;
  onAgentChanged: () => void;
  /** Settings registry deep link. It opens this exact wizard once and returns
   * cancel/complete/close to the Channels section, never the platform picker. */
  initialAddPlatform?: ChannelType;
  onInitialAddPlatformConsumed?: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function getPlatformLabel(type: string): string {
  if (type.startsWith('openclaw:')) {
    const promoted = findPromotedByPlatform(type);
    if (promoted) return promoted.name;
    return type.slice('openclaw:'.length);
  }
  return PLATFORM_LABELS[type] || type;
}

function getPlatformIcon(type: string) {
  if (type === 'telegram') return <img src={telegramIcon} alt="Telegram" className="h-5 w-5" />;
  if (type === 'feishu') return <img src={feishuIcon} alt="飞书" className="h-5 w-5 rounded" />;
  if (type === 'dingtalk') return <img src={dingtalkIcon} alt="钉钉" className="h-5 w-5 rounded" />;
  const promoted = findPromotedByPlatform(type);
  if (promoted) return <img src={promoted.icon} alt={promoted.name} className="h-5 w-5 rounded" />;
  return <span className="text-base">💬</span>;
}

function getChannelStatus(status: AgentStatusData | undefined, channelId: string): ChannelStatusData | undefined {
  return status?.channels.find(ch => ch.channelId === channelId);
}

// Overlay state machine
type OverlayState =
  | null
  | { view: 'add'; platform?: ChannelType }
  | { view: 'detail'; channelId: string };

const CHANNEL_OVERLAY_Z_INDEX = 210;

function ChannelOverlayPanel({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, CHANNEL_OVERLAY_Z_INDEX);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dismissTopmost()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[210]">
      <div
        className="relative flex h-[90vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">
            {children}
          </div>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

export default function AgentChannelsSection({
  agent,
  status,
  onAgentChanged,
  initialAddPlatform,
  onInitialAddPlatformConsumed,
}: AgentChannelsSectionProps) {
  const { t } = useTranslation('settings');
  const [loading, setLoading] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(() => (
    initialAddPlatform ? { view: 'add', platform: initialAddPlatform } : null
  ));
  const directEntryRef = useRef(Boolean(initialAddPlatform));
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (initialAddPlatform) onInitialAddPlatformConsumed?.();
  }, [initialAddPlatform, onInitialAddPlatformConsumed]);

  const handleStartChannel = useCallback(async (channel: ChannelConfig) => {
    setLoading(channel.id);
    try {
      // issue #219 v2 symmetry: flip enabled=true alongside the runtime start.
      // Without this, a channel that was previously stopped (enabled=false)
      // could only be re-launched runtime-wise but would still be skipped by
      // auto_start_all_enabled_agent_channels on next restart.
      await startAndEnableAgentChannel(agent.id, channel.id);
      onAgentChanged();
    } catch (e) {
      console.error('[AgentChannels] Start failed:', e);
    } finally {
      if (isMountedRef.current) setLoading(null);
    }
  }, [agent.id, onAgentChanged]);

  const handleStopChannel = useCallback(async (channelId: string) => {
    setLoading(channelId);
    try {
      // issue #219: persist enabled=false so the channel stays stopped across
      // app restarts. Plain cmd_stop_agent_channel only kills the runtime
      // instance; auto_start_all_enabled_agent_channels would re-launch it
      // next launch because channel.enabled is still true on disk.
      await stopAndDisableAgentChannel(agent.id, channelId);
      onAgentChanged();
    } catch (e) {
      console.error('[AgentChannels] Stop failed:', e);
    } finally {
      if (isMountedRef.current) setLoading(null);
    }
  }, [agent.id, onAgentChanged]);

  // Close overlay and refresh
  const closeOverlay = useCallback(() => {
    directEntryRef.current = false;
    setOverlay(null);
    onAgentChanged();
  }, [onAgentChanged]);

  // Platform selected → transition to wizard
  const handlePlatformSelected = useCallback((platform: ChannelType) => {
    setOverlay({ view: 'add', platform });
  }, []);

  // Wizard completed → close overlay
  const handleWizardComplete = useCallback((_channelId: string) => {
    closeOverlay();
  }, [closeOverlay]);

  // Wizard cancelled → go back to platform select
  const handleWizardCancel = useCallback(() => {
    if (directEntryRef.current) {
      closeOverlay();
      return;
    }
    setOverlay({ view: 'add' });
  }, [closeOverlay]);

  // Detail back → close overlay
  const handleDetailBack = useCallback(() => {
    closeOverlay();
  }, [closeOverlay]);

  // Render overlay content based on state
  const renderOverlayContent = () => {
    if (!overlay) return null;

    if (overlay.view === 'add' && !overlay.platform) {
      return (
        <ChannelPlatformSelect
          onSelect={handlePlatformSelected}
          onCancel={closeOverlay}
        />
      );
    }

    if (overlay.view === 'add' && overlay.platform) {
      return (
        <ChannelWizard
          agent={agent}
          platform={overlay.platform}
          onComplete={handleWizardComplete}
          onCancel={handleWizardCancel}
        />
      );
    }

    if (overlay.view === 'detail') {
      return (
        <ChannelDetailView
          agent={agent}
          channelId={overlay.channelId}
          onBack={handleDetailBack}
          onChanged={onAgentChanged}
        />
      );
    }

    return null;
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium text-[var(--ink)]">{t('agentSettings.channels.title')}</h3>
          <button
            className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            onClick={() => setOverlay({ view: 'add' })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('agentSettings.channels.add')}
          </button>
        </div>

        {(agent.channels?.length ?? 0) === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-6">
            <p className="text-xs text-[var(--ink-subtle)]">
              {t('agentSettings.channels.empty')}
            </p>
          </div>
        )}

        <div className="space-y-2">
          {(agent.channels ?? []).map(channel => {
            const chStatus = getChannelStatus(status, channel.id);
            const isRunning = chStatus?.status === 'online' || chStatus?.status === 'connecting';
            const isLoading = loading === channel.id;

            const displayName = resolveChannelDisplayName(
              channel,
              chStatus,
              getPlatformLabel(channel.type),
            );

            return (
              <div
                key={channel.id}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                onClick={() => setOverlay({ view: 'detail', channelId: channel.id })}
              >
                <span className="flex-shrink-0">{getPlatformIcon(channel.type)}</span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--ink)]">
                    {displayName}
                  </span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className={`h-1.5 w-1.5 rounded-full ${
                      isRunning ? 'bg-[var(--success)]' : 'bg-[var(--ink-subtle)]'
                    }`} />
                    <span className={`text-xs ${
                      isRunning ? 'text-[var(--success)]' : 'text-[var(--ink-muted)]'
                    }`}>
                      {isRunning ? t('agentSettings.channels.running') : t('agentSettings.channels.stopped')}
                    </span>
                  </div>
                </div>
                <button
                  className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    isRunning
                      ? 'border border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10'
                      : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                  }`}
                  onClick={e => {
                    e.stopPropagation();
                    if (isRunning) { handleStopChannel(channel.id); } else { handleStartChannel(channel); }
                  }}
                  // issue #219 v2: removed `!channel.enabled` gate. handleStartChannel
                  // now flips enabled=true via startAndEnableAgentChannel, so the user
                  // can fully restart a disabled channel from list-view (previously
                  // forced them to navigate to detail view to re-enable).
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isRunning ? t('agentSettings.channels.stop') : t('agentSettings.channels.start')}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* === Unified Overlay Panel === */}
      {overlay && (
        <ChannelOverlayPanel onClose={closeOverlay}>
          {renderOverlayContent()}
        </ChannelOverlayPanel>
      )}
    </>
  );
}
