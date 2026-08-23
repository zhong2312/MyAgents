/** Settings → Chatbot Bot platform registry and workspace entry flow. */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { Project } from '@/config/types';
import type { ChannelType } from '../../../shared/types/agent';
import type { InstalledPlugin } from '../../../shared/types/im';
import { upsertInstalledPlugin } from './pluginInstallState';
import { PROMOTED_PLUGINS } from './promotedPlugins';
import BotWorkspacePickerDialog from './BotWorkspacePickerDialog';
import telegramIcon from './assets/telegram.png';
import dingtalkIcon from './assets/dingtalk.svg';

interface PlatformEntry {
  id: ChannelType;
  name: string;
  description: string;
  icon?: string;
  iconElement?: ReactNode;
  deprecationNotice?: string;
  plugin?: InstalledPlugin;
}

interface BotPlatformRegistryProps {
  projects: readonly Project[];
  defaultWorkspacePath?: string;
  onAddToWorkspace: (platform: ChannelType, project: Project) => void;
}

function staticPlatforms(t: TFunction<'settings'>): PlatformEntry[] {
  return [
    {
      id: 'telegram',
      name: 'Telegram',
      description: t('agentSettings.channels.telegramDescription'),
      icon: telegramIcon,
    },
    // The legacy built-in Feishu channel remains readable for compatibility,
    // but new setup uses the promoted official OpenClaw plugin.
    {
      id: 'dingtalk',
      name: '钉钉',
      description: t('agentSettings.channels.dingtalkDescription'),
      icon: dingtalkIcon,
    },
  ];
}

export default function BotPlatformRegistry({
  projects,
  defaultWorkspacePath,
  onAddToWorkspace,
}: BotPlatformRegistryProps) {
  const { t } = useTranslation('settings');
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
  const [autoInstallingSet, setAutoInstallingSet] = useState<Set<string>>(new Set());
  const [installNpmSpec, setInstallNpmSpec] = useState('');
  const [showInstallInput, setShowInstallInput] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updatingSet, setUpdatingSet] = useState<Set<string>>(new Set());
  const [workspacePlatform, setWorkspacePlatform] = useState<ChannelType | null>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);

  useEffect(() => () => { isMountedRef.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isTauriEnvironment()) {
        setLoading(false);
        return;
      }
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
        if (!cancelled) setInstalledPlugins(plugins);
      } catch (error) {
        console.warn('[BotPlatformRegistry] Failed to load plugins:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleUninstall = useCallback(async () => {
    if (!pendingUninstall || !isTauriEnvironment()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_uninstall_openclaw_plugin', { pluginId: pendingUninstall.pluginId });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => prev.filter(plugin => plugin.pluginId !== pendingUninstall.pluginId));
      toastRef.current.success(t('agentSettings.botRegistry.uninstalled', {
        name: pendingUninstall.manifest?.name || pendingUninstall.pluginId,
      }));
    } catch (error) {
      if (isMountedRef.current) {
        toastRef.current.error(t('agentSettings.botRegistry.uninstallFailed', { message: String(error) }));
      }
    } finally {
      if (isMountedRef.current) setPendingUninstall(null);
    }
  }, [pendingUninstall, t]);

  const handlePromotedInstall = useCallback(async (promoted: typeof PROMOTED_PLUGINS[number]) => {
    if (installedPlugins.some(plugin => plugin.pluginId === promoted.pluginId)
      || autoInstallingSet.has(promoted.pluginId)
      || !isTauriEnvironment()) return;
    setAutoInstallingSet(prev => new Set(prev).add(promoted.pluginId));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', {
        npmSpec: promoted.npmSpec,
      });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => upsertInstalledPlugin(prev, result));
      toastRef.current.success(t('agentSettings.botRegistry.promotedInstalled', { name: promoted.name }));
    } catch (error) {
      if (isMountedRef.current) {
        toastRef.current.error(t('agentSettings.botRegistry.installFailed', { message: String(error) }));
      }
    } finally {
      if (isMountedRef.current) {
        setAutoInstallingSet(prev => {
          const next = new Set(prev);
          next.delete(promoted.pluginId);
          return next;
        });
      }
    }
  }, [autoInstallingSet, installedPlugins, t]);

  const handleInstallPlugin = useCallback(async () => {
    if (!installNpmSpec.trim() || !isTauriEnvironment()) return;
    setInstalling(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', {
        npmSpec: installNpmSpec.trim(),
      });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => upsertInstalledPlugin(prev, result));
      toastRef.current.success(t('agentSettings.botRegistry.installed', {
        name: result.manifest?.name || result.pluginId,
      }));
      setShowInstallInput(false);
      setInstallNpmSpec('');
    } catch (error) {
      if (isMountedRef.current) {
        toastRef.current.error(t('agentSettings.botRegistry.installFailed', { message: String(error) }));
      }
    } finally {
      if (isMountedRef.current) setInstalling(false);
    }
  }, [installNpmSpec, t]);

  const handleUpdatePlugin = useCallback(async (npmSpec: string, pluginId: string) => {
    if (!isTauriEnvironment()) return;
    setUpdatingSet(prev => new Set(prev).add(pluginId));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => upsertInstalledPlugin(prev, result));
      const restart = await invoke<{ restarted: number; failed: number }>(
        'cmd_restart_channels_using_plugin',
        { pluginId },
      );
      if (!isMountedRef.current) return;
      const version = result.packageVersion
        ? t('agentSettings.botRegistry.installedWithVersion', { version: result.packageVersion })
        : t('agentSettings.botRegistry.latestVersion');
      if (restart.failed > 0) {
        toastRef.current.error(t('agentSettings.botRegistry.updatedWithFailedRestart', {
          version,
          count: restart.failed,
        }));
      } else if (restart.restarted > 0) {
        toastRef.current.success(t('agentSettings.botRegistry.updatedWithRestart', {
          version,
          count: restart.restarted,
        }));
      } else {
        toastRef.current.success(t('agentSettings.botRegistry.updated', { version }));
      }
    } catch (error) {
      if (isMountedRef.current) {
        toastRef.current.error(t('agentSettings.botRegistry.updateFailed', { message: String(error) }));
      }
    } finally {
      if (isMountedRef.current) {
        setUpdatingSet(prev => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      }
    }
  }, [t]);

  const promotedIds = new Set(PROMOTED_PLUGINS.map(plugin => plugin.pluginId));
  const pluginPlatforms: PlatformEntry[] = installedPlugins
    .filter(plugin => !promotedIds.has(plugin.pluginId))
    .map(plugin => ({
      id: `openclaw:${plugin.pluginId}`,
      name: plugin.manifest?.name || plugin.pluginId,
      description: plugin.manifest?.description || t(
        'agentSettings.botRegistry.communityPluginDescription',
        { npmSpec: plugin.npmSpec },
      ),
      iconElement: (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
          <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
        </div>
      ),
      plugin,
    }));
  const allPlatforms = [...staticPlatforms(t), ...pluginPlatforms];

  const versionControls = (plugin: InstalledPlugin) => (
    <>
      {plugin.packageVersion && (
        <span className="text-xs font-medium text-[var(--success)]">
          {t('agentSettings.botRegistry.installedWithVersion', { version: plugin.packageVersion })}
        </span>
      )}
      <button
        type="button"
        onClick={() => void handleUpdatePlugin(plugin.npmSpec, plugin.pluginId)}
        disabled={updatingSet.has(plugin.pluginId)}
        className="rounded-full p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
        title={t('agentSettings.botRegistry.checkUpdates')}
      >
        <RefreshCw className={`h-3 w-3 ${updatingSet.has(plugin.pluginId) ? 'animate-spin' : ''}`} />
      </button>
    </>
  );

  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--ink)]">{t('agentSettings.botRegistry.title')}</h2>
      <p className="mt-1 text-sm text-[var(--ink-muted)]">
        {t('agentSettings.botRegistry.description')}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {allPlatforms.map(platform => (
          <div
            key={platform.id}
            className="group relative flex min-h-52 flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
          >
            {platform.icon
              ? <img src={platform.icon} alt={platform.name} className="h-12 w-12 rounded-xl" />
              : platform.iconElement}
            <div className="flex items-center justify-center gap-1.5">
              <p className="text-sm font-medium text-[var(--ink)]">{platform.name}</p>
              {platform.plugin && versionControls(platform.plugin)}
            </div>
            <p className="text-center text-xs text-[var(--ink-muted)]">{platform.description}</p>
            {platform.deprecationNotice && (
              <p className="text-center text-xs text-[var(--warning)]">⚠ {platform.deprecationNotice}</p>
            )}
            <button
              type="button"
              onClick={() => setWorkspacePlatform(platform.id)}
              className="mt-auto rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent)]"
            >
              {t('agentSettings.botRegistry.addToWorkspace')}
            </button>
            {platform.plugin && (
              <button
                type="button"
                onClick={() => setPendingUninstall(platform.plugin!)}
                title={t('agentSettings.botRegistry.uninstallPlugin')}
                className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

        {PROMOTED_PLUGINS.map(promoted => {
          const installedPlugin = installedPlugins.find(plugin => plugin.pluginId === promoted.pluginId);
          const isInstalling = autoInstallingSet.has(promoted.pluginId);
          const isUpdating = updatingSet.has(promoted.pluginId);
          return (
            <div
              key={promoted.pluginId}
              className="group relative flex min-h-52 flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            >
              <img src={promoted.icon} alt={promoted.name} className="h-12 w-12 rounded-xl" />
              <div className="flex items-center justify-center gap-1.5">
                <p className="text-sm font-medium text-[var(--ink)]">{promoted.name}</p>
                {installedPlugin && versionControls(installedPlugin)}
              </div>
              <p className="text-center text-xs text-[var(--ink-muted)]">{promoted.description}</p>
              {installedPlugin ? (
                <button
                  type="button"
                  onClick={() => setWorkspacePlatform(`openclaw:${promoted.pluginId}`)}
                  className="mt-auto rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent)]"
                >
                  {t('agentSettings.botRegistry.addToWorkspace')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handlePromotedInstall(promoted)}
                  disabled={isInstalling || isUpdating || loading}
                  className="mt-auto flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] disabled:opacity-50"
                >
                  {(isInstalling || isUpdating) && <Loader2 className="h-3 w-3 animate-spin" />}
                  {isInstalling || isUpdating
                    ? t('agentSettings.botRegistry.installing')
                    : t('agentSettings.botRegistry.install')}
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => setShowInstallInput(true)}
          disabled={loading}
          className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] p-5 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
        >
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
              <Download className="h-6 w-6 text-[var(--ink-muted)]" />
            </div>
          )}
          <div className="text-center">
            <p className="text-sm font-medium text-[var(--ink-muted)]">
              {t('agentSettings.botRegistry.installCommunityPlugin')}
            </p>
            <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
              {t('agentSettings.botRegistry.installFromNpm')}
            </p>
          </div>
        </button>
      </div>

      {showInstallInput && (
        <div className="mt-4 flex items-center gap-2">
          <input
            type="text"
            value={installNpmSpec}
            onChange={event => setInstallNpmSpec(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void handleInstallPlugin(); }}
            placeholder={t('agentSettings.botRegistry.installPlaceholder')}
            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleInstallPlugin()}
            disabled={!installNpmSpec.trim() || installing}
            className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
          >
            {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('agentSettings.botRegistry.install')}
          </button>
          <button
            type="button"
            onClick={() => { setShowInstallInput(false); setInstallNpmSpec(''); }}
            className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            {t('agentSettings.botRegistry.cancel')}
          </button>
        </div>
      )}

      {workspacePlatform && (
        <BotWorkspacePickerDialog
          projects={projects}
          defaultWorkspacePath={defaultWorkspacePath}
          onClose={() => setWorkspacePlatform(null)}
          onSelect={project => {
            const platform = workspacePlatform;
            setWorkspacePlatform(null);
            onAddToWorkspace(platform, project);
          }}
        />
      )}

      {pendingUninstall && (
        <ConfirmDialog
          title={t('agentSettings.botRegistry.uninstallConfirmTitle')}
          message={t('agentSettings.botRegistry.uninstallConfirmMessage', {
            name: pendingUninstall.manifest?.name || pendingUninstall.pluginId,
          })}
          confirmText={t('agentSettings.botRegistry.uninstallConfirm')}
          confirmVariant="danger"
          onConfirm={handleUninstall}
          onCancel={() => setPendingUninstall(null)}
        />
      )}
    </div>
  );
}
