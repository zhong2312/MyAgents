/**
 * BotPlatformRegistry — "聊天机器人 Bot" section in Settings
 *
 * Top: supported platform cards (built-in + promoted + community plugins)
 * Bottom: step-by-step guide for adding bots to agents
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Puzzle, Trash2, RefreshCw } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { InstalledPlugin } from '../../../shared/types/im';
import { upsertInstalledPlugin } from './pluginInstallState';
import { PROMOTED_PLUGINS } from './promotedPlugins';
import telegramIcon from './assets/telegram.png';
// feishuIcon import removed — old built-in Feishu hidden from this page (replaced by OpenClaw plugin)
import dingtalkIcon from './assets/dingtalk.svg';

// Guide images
import guide1_1 from './assets/Bot1-1.png';
import guide1_2 from './assets/Bot1-2.png';
import guide1_3 from './assets/Bot1-3.png';
import guide2_1 from './assets/Bot2-1.png';

interface PlatformEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  iconElement?: React.ReactNode;
  badge: string;       // '内置' | '插件' | '插件·已安装'
  badgeVariant: 'builtin' | 'plugin';
  platformBadge?: 'builtin' | 'official' | 'deprecated' | 'plugin';
  deprecationNotice?: string;
  plugin?: InstalledPlugin;
}

function staticPlatforms(t: TFunction<'settings'>): PlatformEntry[] {
  return [
  { id: 'telegram', name: 'Telegram', description: t('agentSettings.channels.telegramDescription'), icon: telegramIcon, badge: t('agentSettings.botRegistry.builtinBadge'), badgeVariant: 'builtin' },
  // Old built-in Feishu hidden from UI — replaced by official OpenClaw plugin (@larksuite/openclaw-lark).
  // Code retained for backward compatibility with existing channels; entry removed from display.
  // { id: 'feishu', name: '飞书', ... platformBadge: 'deprecated' },
  { id: 'dingtalk', name: '钉钉', description: t('agentSettings.channels.dingtalkDescription'), icon: dingtalkIcon, badge: t('agentSettings.botRegistry.builtinBadge'), badgeVariant: 'builtin' },
  ];
}

function guideStepsPath1(t: TFunction<'settings'>) {
  return [
  { image: guide1_1, caption: t('agentSettings.botRegistry.guideExistingStep1') },
  { image: guide1_2, caption: t('agentSettings.botRegistry.guideExistingStep2') },
  { image: guide1_3, caption: t('agentSettings.botRegistry.guideExistingStep3') },
  ];
}

function guideStepsPath2(t: TFunction<'settings'>) {
  return [
  { image: guide2_1, caption: t('agentSettings.botRegistry.guideNewStep1') },
  ];
}

export default function BotPlatformRegistry() {
  const { t } = useTranslation('settings');
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
  const [autoInstallingSet, setAutoInstallingSet] = useState<Set<string>>(new Set());
  const [installNpmSpec, setInstallNpmSpec] = useState('');
  const [showInstallInput, setShowInstallInput] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updatingSet, setUpdatingSet] = useState<Set<string>>(new Set()); // pluginIds being updated concurrently
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauriEnvironment()) { setLoading(false); return; }
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
        if (!cancelled) setInstalledPlugins(plugins);
      } catch (err) {
        console.warn('[BotPlatformRegistry] Failed to load plugins:', err);
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleUninstall = useCallback(async () => {
    if (!pendingUninstall || !isTauriEnvironment()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_uninstall_openclaw_plugin', { pluginId: pendingUninstall.pluginId });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => prev.filter(p => p.pluginId !== pendingUninstall.pluginId));
      toastRef.current.success(t('agentSettings.botRegistry.uninstalled', { name: pendingUninstall.manifest?.name || pendingUninstall.pluginId }));
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(t('agentSettings.botRegistry.uninstallFailed', { message: String(err) }));
    } finally {
      if (isMountedRef.current) setPendingUninstall(null);
    }
  }, [pendingUninstall, t]);

  const handlePromotedInstall = useCallback(async (promoted: typeof PROMOTED_PLUGINS[number]) => {
    const existing = installedPlugins.find(p => p.pluginId === promoted.pluginId);
    if (existing) {
      toastRef.current.info(t('agentSettings.botRegistry.alreadyInstalled', { name: promoted.name }));
      return;
    }
    if (autoInstallingSet.has(promoted.pluginId)) return;
    if (!isTauriEnvironment()) return;
    setAutoInstallingSet(prev => new Set(prev).add(promoted.pluginId));
    toastRef.current.info(t('agentSettings.botRegistry.installingPlugin'));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: promoted.npmSpec });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => upsertInstalledPlugin(prev, result));
      toastRef.current.success(t('agentSettings.botRegistry.promotedInstalled', { name: promoted.name }));
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(t('agentSettings.botRegistry.installFailed', { message: String(err) }));
    } finally {
      if (isMountedRef.current) {
        setAutoInstallingSet(prev => { const next = new Set(prev); next.delete(promoted.pluginId); return next; });
      }
    }
  }, [autoInstallingSet, installedPlugins, t]);

  const handleInstallPlugin = useCallback(async () => {
    if (!installNpmSpec.trim() || !isTauriEnvironment()) return;
    setInstalling(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: installNpmSpec.trim() });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => upsertInstalledPlugin(prev, result));
      toastRef.current.success(t('agentSettings.botRegistry.installed', { name: result.manifest?.name || result.pluginId }));
      setShowInstallInput(false);
      setInstallNpmSpec('');
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(t('agentSettings.botRegistry.installFailed', { message: String(err) }));
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
      setInstalledPlugins(prev => {
        const hasExisting = prev.some(p => p.pluginId === pluginId);
        if (!hasExisting) return upsertInstalledPlugin(prev, result);
        return prev.map(p => p.pluginId === pluginId ? result : p);
      });

      // Restart running channels that use this plugin
      const restart = await invoke<{ restarted: number; failed: number }>('cmd_restart_channels_using_plugin', { pluginId });
      if (!isMountedRef.current) return;
      const ver = result.packageVersion
        ? t('agentSettings.botRegistry.installedWithVersion', { version: result.packageVersion })
        : t('agentSettings.botRegistry.latestVersion');
      if (restart.failed > 0) {
        toastRef.current.error(t('agentSettings.botRegistry.updatedWithFailedRestart', { version: ver, count: restart.failed }));
      } else if (restart.restarted > 0) {
        toastRef.current.success(t('agentSettings.botRegistry.updatedWithRestart', { version: ver, count: restart.restarted }));
      } else {
        toastRef.current.success(t('agentSettings.botRegistry.updated', { version: ver }));
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(t('agentSettings.botRegistry.updateFailed', { message: String(err) }));
    } finally {
      if (isMountedRef.current) {
        setUpdatingSet(prev => { const next = new Set(prev); next.delete(pluginId); return next; });
      }
    }
  }, [t]);

  const promotedIds = new Set(PROMOTED_PLUGINS.map(p => p.pluginId));

  // Community plugins (exclude promoted)
  const pluginPlatforms: PlatformEntry[] = installedPlugins
    .filter(p => !promotedIds.has(p.pluginId))
    .map(p => ({
      id: `openclaw:${p.pluginId}`,
      name: p.manifest?.name || p.pluginId,
      description: p.manifest?.description || t('agentSettings.botRegistry.communityPluginDescription', { npmSpec: p.npmSpec }),
      iconElement: (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
          <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
        </div>
      ),
      badge: t('agentSettings.botRegistry.pluginInstalledBadge'),
      badgeVariant: 'plugin' as const,
      plugin: p,
    }));

  const allPlatforms = [...staticPlatforms(t), ...pluginPlatforms];
  const path1Steps = guideStepsPath1(t);
  const path2Steps = guideStepsPath2(t);

  return (
    <div className="space-y-10">
      {/* ── Section 1: Supported Platforms ── */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--ink)]">{t('agentSettings.botRegistry.title')}</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          {t('agentSettings.botRegistry.description')}
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* Built-in + community plugins */}
          {allPlatforms.map(p => (
            <div key={p.id} className="group relative flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
              {p.icon ? (
                <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
              ) : p.iconElement ?? null}
              <div className="text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                  {p.platformBadge === 'deprecated' && (
                    <span className="rounded-full bg-[var(--error)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--error)]">
                      {t('agentSettings.botRegistry.deprecatedBadge')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{p.description}</p>
                {p.deprecationNotice && (
                  <p className="mt-1 flex items-center justify-center gap-1 text-xs text-[var(--warning)]">
                    <span>⚠</span>
                    <span>{p.deprecationNotice}</span>
                  </p>
                )}
              </div>
              {p.plugin ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-full px-2 py-0.5 text-xs font-medium text-[var(--success)]"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
                  >
                    {p.plugin.packageVersion ? t('agentSettings.botRegistry.installedWithVersion', { version: p.plugin.packageVersion }) : t('agentSettings.botRegistry.installedBadge')}
                  </span>
                  <button
                    onClick={() => handleUpdatePlugin(p.plugin!.npmSpec, p.plugin!.pluginId)}
                    disabled={updatingSet.has(p.plugin.pluginId)}
                    className="rounded-full p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                    title={t('agentSettings.botRegistry.checkUpdates')}
                  >
                    <RefreshCw className={`h-3 w-3 ${updatingSet.has(p.plugin.pluginId) ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              ) : (
                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-subtle)]">
                  {p.badge}
                </span>
              )}
              {/* Uninstall for community plugins */}
              {p.plugin && (
                <button
                  onClick={() => setPendingUninstall(p.plugin!)}
                  title={t('agentSettings.botRegistry.uninstallPlugin')}
                  className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}

          {/* Promoted plugins */}
          {PROMOTED_PLUGINS.map(pp => {
            const installedPlugin = installedPlugins.find(p => p.pluginId === pp.pluginId);
            const isInstalled = !!installedPlugin;
            const isInstalling = autoInstallingSet.has(pp.pluginId);
            const isUpdating = updatingSet.has(pp.pluginId);
            const isBusy = isInstalling || isUpdating;
            return (
              <div
                key={`promoted-${pp.pluginId}`}
                className="group relative flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
              >
                <img src={pp.icon} alt={pp.name} className="h-12 w-12 rounded-xl" />
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <p className="text-sm font-medium text-[var(--ink)]">{pp.name}</p>
                    {pp.badge === 'official' && (
                      <span className="rounded-full bg-[var(--info-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--info)]">
                        {t('agentSettings.botRegistry.officialBadge')}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{pp.description}</p>
                </div>
                {isInstalled ? (
                  <div className="flex items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium text-[var(--success)]"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
                    >
                      {installedPlugin.packageVersion ? t('agentSettings.botRegistry.installedWithVersion', { version: installedPlugin.packageVersion }) : t('agentSettings.botRegistry.installedBadge')}
                    </span>
                    <button
                      onClick={() => handleUpdatePlugin(pp.npmSpec, pp.pluginId)}
                      disabled={isUpdating}
                      className="rounded-full p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                      title={t('agentSettings.botRegistry.checkUpdates')}
                    >
                      <RefreshCw className={`h-3 w-3 ${isUpdating ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handlePromotedInstall(pp)}
                    disabled={isBusy || loading}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)] disabled:opacity-50"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
                  >
                    {isBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                    {isBusy ? t('agentSettings.botRegistry.installing') : t('agentSettings.botRegistry.clickInstall')}
                  </button>
                )}
              </div>
            );
          })}

          {/* Install new community plugin */}
          <button
            onClick={() => setShowInstallInput(true)}
            disabled={loading}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] bg-transparent p-5 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
          >
            {loading ? (
              <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
                <Download className="h-6 w-6 text-[var(--ink-muted)]" />
              </div>
            )}
            <div className="text-center">
              <p className="text-sm font-medium text-[var(--ink-muted)]">{t('agentSettings.botRegistry.installCommunityPlugin')}</p>
              <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">{t('agentSettings.botRegistry.installFromNpm')}</p>
            </div>
          </button>
        </div>

        {/* npm install input */}
        {showInstallInput && (
          <div className="mt-4 flex items-center gap-2">
            <input
              type="text"
              value={installNpmSpec}
              onChange={e => setInstallNpmSpec(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleInstallPlugin(); }}
              placeholder={t('agentSettings.botRegistry.installPlaceholder')}
              className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleInstallPlugin}
              disabled={!installNpmSpec.trim() || installing}
              className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
            >
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('agentSettings.botRegistry.install')}
            </button>
            <button
              onClick={() => { setShowInstallInput(false); setInstallNpmSpec(''); }}
              className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
            >
              {t('agentSettings.botRegistry.cancel')}
            </button>
          </div>
        )}
      </div>

      {/* ── Section 2: How to add bots ── */}
      <div>
        <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.botRegistry.howToAddTitle')}</h3>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          {t('agentSettings.botRegistry.howToAddDescription')}
        </p>

        {/* Path 1 */}
        <div className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h4 className="text-sm font-semibold text-[var(--ink)]">
            {t('agentSettings.botRegistry.pathExistingTitle')}
          </h4>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {t('agentSettings.botRegistry.pathExistingDescription')}
          </p>
          <div className="mt-4 space-y-4">
            {path1Steps.map((step, i) => (
              <div key={i}>
                <p className="mb-2 text-xs font-medium text-[var(--ink-subtle)]">
                  <span className="mr-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--accent-warm)] text-xs font-bold text-[var(--on-accent)]">
                    {i + 1}
                  </span>
                  {step.caption}
                </p>
                <img
                  src={step.image}
                  alt={step.caption}
                  className="w-full rounded-lg border border-[var(--line)] shadow-sm"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Path 2 */}
        <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h4 className="text-sm font-semibold text-[var(--ink)]">
            {t('agentSettings.botRegistry.pathNewTitle')}
          </h4>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {t('agentSettings.botRegistry.pathNewDescription')}
          </p>
          <div className="mt-4 space-y-4">
            {path2Steps.map((step, i) => (
              <div key={i}>
                <p className="mb-2 text-xs font-medium text-[var(--ink-subtle)]">
                  <span className="mr-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--accent-warm)] text-xs font-bold text-[var(--on-accent)]">
                    {i + 1}
                  </span>
                  {step.caption}
                </p>
                <img
                  src={step.image}
                  alt={step.caption}
                  className="w-full rounded-lg border border-[var(--line)] shadow-sm"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Uninstall confirmation */}
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
