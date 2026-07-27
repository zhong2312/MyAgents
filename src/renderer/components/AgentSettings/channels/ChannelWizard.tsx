// Channel creation wizard — adapted from ImBotWizard for Agent+Channel architecture.
// Removes workspace step (Agent already has one), uses cmd_start_agent_channel.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Loader2, Plus, Puzzle, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { copyPlainText } from '@/utils/clipboard';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { patchAgentConfig, invokeStartAgentChannel } from '@/config/services/agentConfigService';
import { isDirtyChannelName } from '@/utils/channelDisplayName';
import BotTokenInput from '../../ImSettings/components/BotTokenInput';
import FeishuCredentialInput from '../../ImSettings/components/FeishuCredentialInput';
import DingtalkCredentialInput from '../../ImSettings/components/DingtalkCredentialInput';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import WhitelistManager from '../../ImSettings/components/WhitelistManager';
import type { AgentConfig, ChannelConfig, ChannelType } from '../../../../shared/types/agent';
import type { InstalledPlugin } from '../../../../shared/types/im';
import type { ChannelStatusData } from '@/hooks/useAgentStatuses';
import telegramBotAddImg from '../../ImSettings/assets/telegram_bot_add.png';
import feishuStep1Img from '../../ImSettings/assets/feishu_step1.png';
import feishuStep2PermImg from '../../ImSettings/assets/feishu_step2_permissions.png';
import feishuStep2EventImg from '../../ImSettings/assets/feishu_step2_events.png';
import feishuStep2AddBotImg from '../../ImSettings/assets/feishu_step2_5_add_bot.png';
import feishuStep2PublishImg from '../../ImSettings/assets/feishu_setp2_6_publish.png';
import dingtalkStep1CreateAppImg from '../../ImSettings/assets/dingtalk_step1_create_app.png';
import dingtalkStep1CredentialsImg from '../../ImSettings/assets/dingtalk_step1_credentials.png';
import dingtalkStep2AddRobotImg from '../../ImSettings/assets/dingtalk_step2_add_robot.png';
import dingtalkStep2StreamModeImg from '../../ImSettings/assets/dingtalk_step2_stream_mode.png';
import dingtalkStep2PublishImg from '../../ImSettings/assets/dingtalk_step2_publish.png';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';
import OpenClawScalarField from './OpenClawScalarField';
import {
    buildTypedOpenClawConfig,
    isOpenClawConfigValueInvalid,
    isOpenClawConfigValueMissing,
    mergeOpenClawSchemaProperties,
    type OpenClawSchemaProperties,
} from './openclawConfigScalars';

export const FEISHU_PERMISSIONS_JSON = `{
  "scopes": {
    "tenant": [
      "contact:user.base:readonly",
      "docx:document:readonly",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "application:application:self_manage",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": [
      "contact:user.employee_id:readonly",
      "offline_access",
      "base:app:copy",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:delete",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "base:app:create",
      "base:app:update",
      "base:app:read",
      "sheets:spreadsheet.meta:read",
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:create",
      "sheets:spreadsheet:write_only",
      "docs:document:export",
      "docs:document.media:upload",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:delete",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "contact:user.base:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document:copy",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "search:docs:read",
      "search:message",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only"
    ]
  }
}`;

interface ChannelWizardProps {
    agent: AgentConfig;
    platform: ChannelType;
    onComplete: (channelId: string) => void;
    onCancel: () => void;
}

// WeCom QR polling constants — shared between effect logic and render display
const WECOM_MAX_QR_REFRESHES = 5; // Auto-refresh up to 5 times on QR expiry, then error
const WECOM_POLL_INTERVAL = 3000;
const WECOM_MAX_POLLS_PER_QR = 200; // Defensive ~10min ceiling per QR in case server never returns terminal status

export default function ChannelWizard({
    agent,
    platform,
    onComplete,
    onCancel,
}: ChannelWizardProps) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { config, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    const isFeishu = platform === 'feishu';
    const isDingtalk = platform === 'dingtalk';
    const isOpenClaw = platform.startsWith('openclaw:');
    const openclawPluginId = isOpenClaw ? platform.slice('openclaw:'.length) : undefined;
    const promoted = isOpenClaw ? findPromotedByPlatform(platform) : undefined;

    // OpenClaw: config(1) → start(2) → binding(3)
    // OpenClaw QR: qrLogin(1) → binding(2)
    // OpenClaw dualConfig: config-or-qr(1) → start(2) → binding(3)
    // Telegram: credentials(1) → binding(2)
    // Feishu:   credentials(1) → permissions(2) → binding(3)
    // DingTalk: credentials(1) → permissions(2) → binding(3)
    // isQrLogin is computed below after installedPlugin state is declared
    const isQrLoginFromPreset = promoted?.authType === 'qrLogin';
    const isDualConfig = promoted?.authType === 'dualConfig';
    const totalStepsBase = isQrLoginFromPreset ? 2 : isOpenClaw ? 3 : (isFeishu || isDingtalk) ? 3 : 2;

    const [step, setStep] = useState(1);
    // Telegram credentials
    const [botToken, setBotToken] = useState('');
    // Feishu credentials
    const [feishuAppId, setFeishuAppId] = useState('');
    const [feishuAppSecret, setFeishuAppSecret] = useState('');
    // DingTalk credentials
    const [dingtalkClientId, setDingtalkClientId] = useState('');
    const [dingtalkClientSecret, setDingtalkClientSecret] = useState('');

    // OpenClaw plugin state
    const [installedPlugin, setInstalledPlugin] = useState<InstalledPlugin | null>(null);
    const [openclawSchemaValues, setOpenclawSchemaValues] = useState<Record<string, unknown>>(
        () => ({ ...(promoted?.defaultConfig ?? {}) }),
    );
    const [openclawCustomFields, setOpenclawCustomFields] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);

    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [starting, setStarting] = useState(false);
    const [channelId] = useState(() => crypto.randomUUID());
    const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
    const [botStatus, setBotStatus] = useState<ChannelStatusData | null>(null);
    const [permJsonCopied, setPermJsonCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    // QR Login state
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [qrMessage, setQrMessage] = useState<string>('');
    const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'connected' | 'error'>('idle');
    const qrAbortRef = useRef(false);
    const qrSessionKeyRef = useRef<string | undefined>(undefined);
    // Rendered QR image: either the raw data URI (WhatsApp) or QR-encoded from URL (WeChat)
    const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);

    // Convert qrDataUrl to a renderable image:
    // - data:image/* → use directly (WhatsApp returns base64 PNG)
    // - http(s):// URL → encode the URL INTO a QR code image (WeChat returns a URL to be QR-encoded)
    useEffect(() => {
        if (!qrDataUrl) { setQrImageUrl(null); return; }
        if (qrDataUrl.startsWith('data:image/')) {
            setQrImageUrl(qrDataUrl);
            return;
        }
        // URL needs to be QR-encoded into an image
        let cancelled = false;
        QRCode.toDataURL(qrDataUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
            .then((dataUrl: string) => { if (!cancelled) setQrImageUrl(dataUrl); })
            .catch(() => { if (!cancelled) setQrImageUrl(null); });
        return () => { cancelled = true; };
    }, [qrDataUrl]);

    // WeCom dualConfig state: QR scan OR manual config to obtain botId+secret
    const [dualConfigMode, setDualConfigMode] = useState<'qr' | 'config'>('qr');
    const [wecomQrStatus, setWecomQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'error'>('idle');
    const [wecomQrBotId, setWecomQrBotId] = useState('');
    const [wecomQrSecret, setWecomQrSecret] = useState('');
    const wecomQrAbortRef = useRef(false);
    const wecomQrStartedRef = useRef(false);
    const [wecomQrRetryTrigger, setWecomQrRetryTrigger] = useState(0);
    // Rendered QR image for WeCom (auth_url → QR code image)
    const [wecomQrImageUrl, setWecomQrImageUrl] = useState<string | null>(null);
    // QR refresh count for display (e.g., "二维码已刷新 (2/5)")
    const [wecomQrRefreshCount, setWecomQrRefreshCount] = useState(0);

    // Derived: QR login detection (from preset or installed plugin's detected capability)
    const isQrLogin = isQrLoginFromPreset || (!promoted && installedPlugin?.supportsQrLogin === true);
    const totalSteps = isQrLogin ? 2 : totalStepsBase;
    const bindingStep = totalSteps; // All platforms have binding as the last step

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            wecomQrAbortRef.current = true;
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    // WeCom dualConfig: auto-start QR flow when in QR mode on step 1
    // Design: polling lifecycle is tied to QR validity. When a QR expires,
    // auto-generate a new one and continue polling (up to WECOM_MAX_QR_REFRESHES auto-refreshes).
    // After all refreshes exhausted → error state. User can click retry to restart.
    useEffect(() => {
        if (!isDualConfig || dualConfigMode !== 'qr' || step !== 1 || wecomQrStartedRef.current) return;
        if (!isTauriEnvironment()) return;
        wecomQrStartedRef.current = true;
        let cancelled = false;

        // Helper: generate QR and render as image
        const generateQr = async (invoke: typeof import('@tauri-apps/api/core').invoke) => {
            const result = await invoke<{ scode: string; auth_url: string }>('cmd_wecom_qr_generate');
            if (cancelled || !isMountedRef.current) return null;
            const dataUrl = await QRCode.toDataURL(result.auth_url, {
                width: 200, margin: 2,
                color: { dark: '#000000', light: '#ffffff' },
            });
            if (cancelled || !isMountedRef.current) return null;
            setWecomQrImageUrl(dataUrl);
            return result.scode;
        };

        (async () => {
            try {
                setWecomQrStatus('loading');
                setWecomQrRefreshCount(0);
                const { invoke } = await import('@tauri-apps/api/core');
                let scode = await generateQr(invoke);
                if (!scode) return;
                setWecomQrStatus('waiting');

                let qrRefreshCount = 0;
                let globalPollIndex = 0;

                // Outer loop: one iteration per QR code (initial + up to N refreshes)
                while (qrRefreshCount <= WECOM_MAX_QR_REFRESHES) {
                    let pollsThisQr = 0;
                    // Inner loop: poll until success, terminal state, or per-QR ceiling
                    while (pollsThisQr < WECOM_MAX_POLLS_PER_QR) {
                        if (cancelled || !isMountedRef.current || wecomQrAbortRef.current) return;
                        await new Promise(r => setTimeout(r, WECOM_POLL_INTERVAL));
                        if (cancelled || !isMountedRef.current || wecomQrAbortRef.current) return;

                        const poll = await invoke<{ status: string; bot_id?: string; secret?: string }>(
                            'cmd_wecom_qr_poll', { scode, pollIndex: globalPollIndex }
                        );
                        globalPollIndex++;
                        pollsThisQr++;

                        if (poll.status === 'success' && poll.bot_id && poll.secret) {
                            if (cancelled || !isMountedRef.current) return;
                            setWecomQrBotId(poll.bot_id);
                            setWecomQrSecret(poll.secret);
                            setWecomQrStatus('success');
                            return;
                        }

                        // QR expired → auto-refresh
                        if (poll.status === 'expired') {
                            qrRefreshCount++;
                            if (qrRefreshCount > WECOM_MAX_QR_REFRESHES) break; // → error
                            if (cancelled || !isMountedRef.current) return;
                            setWecomQrRefreshCount(qrRefreshCount);
                            setWecomQrStatus('loading');
                            scode = await generateQr(invoke);
                            if (!scode) return;
                            setWecomQrStatus('waiting');
                            break; // restart inner poll loop with new scode
                        }

                        // User cancelled or denied on WeCom side → error
                        if (poll.status === 'cancelled' || poll.status === 'denied') {
                            if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
                            return;
                        }
                        // Otherwise "waiting" — continue polling
                    }
                    // If inner loop hit the per-QR ceiling without a terminal status,
                    // treat it as if the QR expired (auto-refresh)
                    if (pollsThisQr >= WECOM_MAX_POLLS_PER_QR) {
                        qrRefreshCount++;
                        if (qrRefreshCount > WECOM_MAX_QR_REFRESHES) break;
                        if (cancelled || !isMountedRef.current) return;
                        setWecomQrRefreshCount(qrRefreshCount);
                        setWecomQrStatus('loading');
                        scode = await generateQr(invoke);
                        if (!scode) return;
                        setWecomQrStatus('waiting');
                    }
                }

                // Exhausted all QR refreshes
                if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
            } catch (err) {
                console.error('[ChannelWizard] WeCom QR flow error:', err);
                if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
            }
        })();

        return () => { cancelled = true; };
    }, [isDualConfig, dualConfigMode, step, wecomQrRetryTrigger]);

    // Reset QR state when switching to QR mode (always re-trigger, even after prior success)
    const handleDualModeSwitch = useCallback((mode: 'qr' | 'config') => {
        setDualConfigMode(mode);
        if (mode === 'qr') {
            wecomQrStartedRef.current = false;
            wecomQrAbortRef.current = false;
            setWecomQrStatus('idle');
            setWecomQrImageUrl(null);
            setWecomQrBotId('');
            setWecomQrSecret('');
            setWecomQrRefreshCount(0);
        }
    }, []);

    // Load OpenClaw plugin info for config schema
    useEffect(() => {
        if (!isOpenClaw || !openclawPluginId || !isTauriEnvironment()) return;
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (cancelled) return;
                const found = plugins.find(p => p.pluginId === openclawPluginId);
                if (found) {
                    setInstalledPlugin(found);
                    const schemaDefaults = Object.fromEntries(
                        Object.entries(found.manifest?.configSchema?.properties ?? {})
                            .filter(([, field]) => field.default !== undefined)
                            .map(([key, field]) => [key, field.default]),
                    );
                    setOpenclawSchemaValues(prev => ({
                        ...(promoted?.defaultConfig ?? {}),
                        ...schemaDefaults,
                        ...prev,
                    }));
                    // Pre-populate custom fields from requiredFields if no schema
                    const hasSchema = found.manifest?.configSchema?.properties
                        && Object.keys(found.manifest.configSchema.properties).length > 0;
                    // Try plugin's extracted requiredFields first, fallback to promoted plugin's hardcoded list
                    const reqFields = found.requiredFields?.length
                        ? found.requiredFields
                        : promoted?.requiredFields;
                    if (!hasSchema && reqFields?.length) {
                        setOpenclawCustomFields(reqFields.map(k => ({ key: k, value: '' })));
                    }
                }
            } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
    }, [isOpenClaw, openclawPluginId, promoted?.defaultConfig, promoted?.requiredFields]);

    // OpenClaw config schema helpers
    const openclawSchemaProps = useMemo(
        () => mergeOpenClawSchemaProperties(
            installedPlugin?.manifest?.configSchema?.properties as OpenClawSchemaProperties | undefined,
            promoted?.defaultConfig,
        ),
        [installedPlugin?.manifest?.configSchema?.properties, promoted?.defaultConfig],
    );
    const hasOpenclawSchema = Object.keys(openclawSchemaProps).length > 0;
    const openclawSchemaRequired = useMemo(
        () => new Set(installedPlugin?.manifest?.configSchema?.required ?? []),
        [installedPlugin?.manifest?.configSchema?.required],
    );

    const buildOpenclawConfig = useCallback((): Record<string, unknown> => (
        buildTypedOpenClawConfig(openclawSchemaValues, openclawSchemaProps, openclawCustomFields)
    ), [openclawSchemaValues, openclawSchemaProps, openclawCustomFields]);

    const openclawHasIncompleteFields = openclawCustomFields.some(f => f.key.trim() && !f.value.trim());
    const openclawHasIncompleteSchema = hasOpenclawSchema
        && Object.entries(openclawSchemaProps).some(([key, field]) => (
            (openclawSchemaRequired.has(key) && isOpenClawConfigValueMissing(openclawSchemaValues[key]))
            || isOpenClawConfigValueInvalid(openclawSchemaValues[key], field)
        ));

    // Poll status when in binding step
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;

        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId });
                if (isMountedRef.current) {
                    setBotStatus(status);
                }
            } catch {
                // Not running
            }
        };

        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    }, [step, bindingStep, channelId, agent.id]);

    // Listen for user-bound events
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ botId: string; userId: string; username?: string }>(
            'im:user-bound',
            (event) => {
                if (!isMountedRef.current || event.payload.botId !== channelId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;

                setAllowedUsers(prev => {
                    if (prev.includes(userId) || (username && prev.includes(username))) return prev;
                    toastRef.current.success(t('agentSettings.channelWizard.toast.userBound', { name: displayName }));
                    return [...prev, userId];
                });
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [step, bindingStep, channelId, t]);

    // Check if credentials are filled
    const hasCredentials = isDualConfig
        ? (dualConfigMode === 'qr'
            ? wecomQrStatus === 'success' // QR scan returned botId+secret
            : !!(
                String(openclawSchemaValues['botId'] ?? '').trim()
                && String(openclawSchemaValues['secret'] ?? '').trim()
            ))
        : isOpenClaw
            ? true // OpenClaw uses its own validation
            : isFeishu
                ? feishuAppId.trim() && feishuAppSecret.trim()
                : isDingtalk
                    ? dingtalkClientId.trim() && dingtalkClientSecret.trim()
                    : botToken.trim();

    // Build channel config from current wizard state
    const buildChannelConfig = useCallback((): ChannelConfig => {
        if (isOpenClaw) {
            const pluginConfig = buildOpenclawConfig();
            // For dualConfig QR mode, inject the QR-obtained credentials
            if (isDualConfig && dualConfigMode === 'qr' && wecomQrBotId && wecomQrSecret) {
                pluginConfig.botId = wecomQrBotId;
                pluginConfig.secret = wecomQrSecret;
            }
            // Merge promoted plugin defaults (e.g. dmPolicy: 'open') under user values
            const mergedConfig = { ...(promoted?.defaultConfig ?? {}), ...pluginConfig };
            // Filter out manifest.name when it's actually the npm package id —
            // historically that's how "wecom/wecom-openclaw-plugin" got persisted
            // into channel.name and surfaced in the list. The same dirty-name
            // helper used at render time is reused here for write-side consistency.
            const manifestName = installedPlugin?.manifest?.name;
            const cleanManifestName = manifestName && !isDirtyChannelName({
                name: manifestName,
                openclawNpmSpec: installedPlugin?.npmSpec,
            }) ? manifestName : null;
            const pluginName = promoted?.name || cleanManifestName || openclawPluginId || 'Plugin Bot';
            // Enable all non-sensitive tool groups by default.
            // Sensitive groups (im, perm) are opt-in. Rust auto-merges new plugin groups at startup.
            const allToolGroups = ['doc', 'chat', 'wiki_drive', 'bitable', 'calendar', 'task', 'sheet', 'search', 'common'];
            return {
                id: channelId,
                type: platform,
                name: pluginName,
                enabled: true,
                allowedUsers: [],
                setupCompleted: false,
                openclawPluginId: openclawPluginId,
                openclawNpmSpec: installedPlugin?.npmSpec,
                openclawPluginConfig: Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined,
                openclawEnabledToolGroups: allToolGroups,
            };
        }
        return {
            id: channelId,
            type: platform,
            name: isDingtalk ? '钉钉 Bot' : isFeishu ? '飞书 Bot' : 'Telegram Bot',
            enabled: true,
            botToken: (isFeishu || isDingtalk) ? undefined : botToken.trim(),
            feishuAppId: isFeishu ? feishuAppId.trim() : undefined,
            feishuAppSecret: isFeishu ? feishuAppSecret.trim() : undefined,
            dingtalkClientId: isDingtalk ? dingtalkClientId.trim() : undefined,
            dingtalkClientSecret: isDingtalk ? dingtalkClientSecret.trim() : undefined,
            allowedUsers: [],
            setupCompleted: false,
        };
    }, [channelId, platform, isFeishu, isDingtalk, isOpenClaw, isDualConfig, dualConfigMode, wecomQrBotId, wecomQrSecret, botToken, feishuAppId, feishuAppSecret, dingtalkClientId, dingtalkClientSecret, openclawPluginId, promoted, installedPlugin, buildOpenclawConfig]);

    // Start channel via shared utility (resolves MCP + overrides)
    const startChannel = useCallback(async (channelCfg: ChannelConfig) => {
        if (!isTauriEnvironment()) return null;
        await invokeStartAgentChannel(agent, channelCfg);
        // Poll initial status after start
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId: channelCfg.id });
    }, [agent]);

    // OpenClaw: step 2 = start channel, then advance to binding step
    const handleOpenClawStart = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        setStarting(true);
        try {
            const channelCfg = { ...buildChannelConfig(), setupCompleted: true };

            // Save channel to agent config (dedup: replace if same ID exists from a previous attempt)
            const existingChannels = (agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, {
                channels: [...existingChannels, channelCfg],
            });
            await refreshConfig();

            // Start the channel
            await startChannel(channelCfg);

            if (isMountedRef.current) {
                track('agent_channel_create', { source: 'desktop', platform });
                toastRef.current.success(t('agentSettings.channelWizard.toast.channelStarted'));
                setStep(bindingStep); // Advance to binding step
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(t('agentSettings.channelWizard.toast.startFailed', { message: String(err) }));
            }
        } finally {
            if (isMountedRef.current) setStarting(false);
        }
    }, [buildChannelConfig, agent, platform, startChannel, refreshConfig, bindingStep, t]);

    // QR Login: start channel then initiate QR login flow
    const startQrLogin = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        qrAbortRef.current = false;
        setQrStatus('loading');
        setQrMessage(t('agentSettings.channelWizard.qr.startingPlugin'));

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            // 1. Start the channel (spawns Bridge process)
            // disk-first: read latest config from disk before writing (CLAUDE.md convention)
            const { loadAppConfig } = await import('@/config/configService');
            const latestConfig = await loadAppConfig();
            const latestAgent = (latestConfig.agents ?? []).find(a => a.id === agent.id);
            const channelCfg = { ...buildChannelConfig(), setupCompleted: true };
            const existingChannels = (latestAgent?.channels ?? agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, { channels: [...existingChannels, channelCfg] });
            await refreshConfig();
            await invokeStartAgentChannel(agent, channelCfg);

            // 2. Wait a moment for Bridge to load the plugin
            await new Promise(r => setTimeout(r, 2000));
            if (qrAbortRef.current || !isMountedRef.current) return;

            // 3. Request QR code from Bridge
            setQrMessage(t('agentSettings.channelWizard.qr.loading'));
            const startResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                'cmd_plugin_qr_login_start', { agentId: agent.id, channelId }
            );

            if (!startResult.ok || !startResult.qrDataUrl) {
                throw new Error(startResult.message || t('agentSettings.channelWizard.qr.loadFailed'));
            }

            if (!isMountedRef.current || qrAbortRef.current) return;
            qrSessionKeyRef.current = startResult.sessionKey;
            setQrDataUrl(startResult.qrDataUrl);
            setQrStatus('waiting');
            setQrMessage(t('agentSettings.channelWizard.qr.scanWith', { name: openclawPluginName }));

            // 4. Poll for QR scan completion (pass sessionKey — WeChat requires it)
            // Auto-retry with QR refresh on timeout/error, up to MAX_QR_RETRIES
            const MAX_QR_RETRIES = 10;
            let qrRetryCount = 0;

            while (!qrAbortRef.current && isMountedRef.current) {
                try {
                    const waitResult = await invoke<{ ok: boolean; connected?: boolean; message?: string; accountId?: string }>(
                        'cmd_plugin_qr_login_wait', { agentId: agent.id, channelId, sessionKey: qrSessionKeyRef.current }
                    );

                    if (!isMountedRef.current || qrAbortRef.current) return;

                    if (waitResult.connected) {
                        setQrStatus('connected');
                        setQrMessage(t('agentSettings.channelWizard.qr.loginSuccessStarting'));
                        await invoke('cmd_plugin_restart_gateway', {
                            agentId: agent.id, channelId,
                            accountId: waitResult.accountId,
                        });
                        // Persist accountId to channel config so Bridge finds credentials on restart
                        if (waitResult.accountId) {
                            const { loadAppConfig } = await import('@/config/configService');
                            const lat = await loadAppConfig();
                            const latAgent = (lat.agents ?? []).find(a => a.id === agent.id);
                            const updChs = (latAgent?.channels ?? []).map(ch =>
                                ch.id === channelId
                                    ? { ...ch, openclawPluginConfig: { ...(ch.openclawPluginConfig ?? {}), accountId: waitResult.accountId! } }
                                    : ch,
                            );
                            await patchAgentConfig(agent.id, { channels: updChs });
                            await refreshConfig();
                        }
                        if (isMountedRef.current) {
                            track('agent_channel_create', { source: 'desktop', platform });
                            toastRef.current.success(t('agentSettings.channelWizard.toast.scanLoginSuccess'));
                            setStep(2);
                        }
                        return;
                    }

                    // connected:false — could be timeout or terminal. Add delay to prevent spinning.
                    if (waitResult.message) setQrMessage(waitResult.message);
                    await new Promise(r => setTimeout(r, 1000));

                } catch (err) {
                    if (!isMountedRef.current || qrAbortRef.current) return;

                    // Most errors are transient: Rust proxy timeout, connection reset, QR expired.
                    // Only truly terminal: plugin 501 (not supported), Bridge crashed (ECONNREFUSED).
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isTerminal = /ECONNREFUSED|not support|501/i.test(errMsg);

                    if (isTerminal || qrRetryCount >= MAX_QR_RETRIES) {
                        setQrStatus('error');
                        setQrMessage(qrRetryCount >= MAX_QR_RETRIES
                            ? t('agentSettings.channelWizard.qr.maxRetries', { count: MAX_QR_RETRIES })
                            : t('agentSettings.channelWizard.qr.loginFailed', { message: errMsg }));
                        return;
                    }

                    // Auto-retry: refresh QR code and continue polling
                    qrRetryCount++;
                    try {
                        const refreshResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                            'cmd_plugin_qr_login_start', { agentId: agent.id, channelId }
                        );
                        if (refreshResult.ok && refreshResult.qrDataUrl) {
                            qrSessionKeyRef.current = refreshResult.sessionKey;
                            setQrDataUrl(refreshResult.qrDataUrl);
                            setQrMessage(t('agentSettings.channelWizard.qr.refreshed', { current: qrRetryCount, max: MAX_QR_RETRIES }));
                        }
                    } catch {
                        setQrStatus('error');
                        setQrMessage(t('agentSettings.channelWizard.qr.loadFailedRetry'));
                        return;
                    }
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                setQrStatus('error');
                setQrMessage(t('agentSettings.channelWizard.qr.startFailed', { message: String(err) }));
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildChannelConfig, agent, channelId, platform, refreshConfig, t]);

    // Auto-start QR login when entering step 1 for QR plugins.
    // CRITICAL: startQrLogin must NOT be in deps — it depends on `agent` which changes
    // after refreshConfig(), causing cleanup → abort → stuck. Use ref for stable access.
    const startQrLoginRef = useRef(startQrLogin);
    startQrLoginRef.current = startQrLogin;
    const qrStartedRef = useRef(false);
    useEffect(() => {
        if (!isQrLogin || step !== 1 || qrStartedRef.current) return;
        qrStartedRef.current = true;
        startQrLoginRef.current();
    }, [isQrLogin, step]);

    // Handle "Next" for all steps
    const handleNext = useCallback(async () => {
        // OpenClaw step 1 → step 2: just advance (validation is on the button disabled state)
        if (isOpenClaw && step === 1) {
            setStep(2);
            return;
        }

        // Feishu/DingTalk step 2 -> step 3 (permissions guide -> binding)
        if ((isFeishu || isDingtalk) && step === 2) {
            setStep(3);
            return;
        }

        // Step 1 -> Step 2: validate credentials and start channel
        if (!hasCredentials) {
            toastRef.current.error(
                isFeishu ? t('agentSettings.channelWizard.validation.feishuCredentials')
                    : isDingtalk ? t('agentSettings.channelWizard.validation.dingtalkCredentials')
                        : t('agentSettings.channelWizard.validation.botToken')
            );
            return;
        }

        // Check for duplicate credentials — against existing channels in this agent + other agents
        const allChannels = [
            ...(agent.channels ?? []).filter(ch => ch.id !== channelId && ch.setupCompleted),
            ...(config.agents ?? [])
                .filter(a => a.id !== agent.id)
                .flatMap(a => (a.channels ?? []).filter(ch => ch.setupCompleted)),
        ];
        if (isFeishu) {
            if (allChannels.some(ch => ch.feishuAppId === feishuAppId.trim())) {
                toastRef.current.error(t('agentSettings.channelWizard.validation.duplicateFeishu'));
                return;
            }
        } else if (isDingtalk) {
            if (allChannels.some(ch => ch.dingtalkClientId === dingtalkClientId.trim())) {
                toastRef.current.error(t('agentSettings.channelWizard.validation.duplicateDingtalk'));
                return;
            }
        } else {
            if (allChannels.some(ch => ch.botToken === botToken.trim())) {
                toastRef.current.error(t('agentSettings.channelWizard.validation.duplicateBotToken'));
                return;
            }
        }

        setStarting(true);
        setVerifyStatus('verifying');

        try {
            const channelCfg = buildChannelConfig();

            // Save channel to agent config (dedup: replace if same ID exists from a previous attempt)
            const existingChannels = (agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, {
                channels: [...existingChannels, channelCfg],
            });
            await refreshConfig();

            if (!isTauriEnvironment()) {
                setVerifyStatus('valid');
                setStep(2);
                return;
            }

            // Start the channel (this verifies the credentials)
            const status = await startChannel(channelCfg);

            if (isMountedRef.current) {
                setVerifyStatus('valid');
                setBotUsername(status?.botUsername ?? undefined);
                setBotStatus(status);
                // Save channel name from verification
                if (status?.botUsername) {
                    const displayName = platform === 'telegram' ? `@${status.botUsername}` : status.botUsername;
                    const updatedChannels = (agent.channels ?? [])
                        .filter(ch => ch.id !== channelId)
                        .concat([{ ...channelCfg, name: displayName }]);
                    await patchAgentConfig(agent.id, { channels: updatedChannels });
                    await refreshConfig();
                }
                setStep(2);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setVerifyStatus('invalid');
                toastRef.current.error(t('agentSettings.channelWizard.toast.verificationFailed', { message: String(err) }));
            }
        } finally {
            if (isMountedRef.current) {
                setStarting(false);
            }
        }
    }, [hasCredentials, isFeishu, isDingtalk, isOpenClaw, step, botToken, feishuAppId, dingtalkClientId, channelId, platform, agent, config.agents, buildChannelConfig, startChannel, refreshConfig, t]);

    // Complete wizard — merge local users with any Rust-persisted users
    const handleComplete = useCallback(async () => {
        // Read latest agent config from disk to merge users
        const { loadAppConfig } = await import('@/config/configService');
        const latest = await loadAppConfig();
        const latestAgent = (latest.agents ?? []).find(a => a.id === agent.id);
        const diskChannel = latestAgent?.channels?.find(ch => ch.id === channelId);
        const diskUsers = diskChannel?.allowedUsers ?? [];
        const mergedUsers = [...new Set([...diskUsers, ...allowedUsers])];

        // Update channel with setupCompleted + merged users
        const updatedChannels = (latestAgent?.channels ?? agent.channels ?? []).map(ch =>
            ch.id === channelId
                ? { ...ch, setupCompleted: true, allowedUsers: mergedUsers }
                : ch,
        );
        await patchAgentConfig(agent.id, { channels: updatedChannels });
        await refreshConfig();

        track('agent_channel_create', { source: 'desktop', platform });
        if (isMountedRef.current) onComplete(channelId);
    }, [agent.id, agent.channels, channelId, allowedUsers, platform, onComplete, refreshConfig]);

    // Cancel wizard - stop channel, remove from agent config
    const handleCancel = useCallback(async () => {
        if (isTauriEnvironment()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId });
            } catch {
                // Channel might not be running
            }
        }

        // Remove channel from agent config
        const updatedChannels = (agent.channels ?? []).filter(ch => ch.id !== channelId);
        await patchAgentConfig(agent.id, { channels: updatedChannels });
        await refreshConfig();

        if (isMountedRef.current) onCancel();
    }, [agent.id, agent.channels, channelId, onCancel, refreshConfig]);

    const handleCopyPermJson = useCallback(async () => {
        try {
            await copyPlainText(FEISHU_PERMISSIONS_JSON);
            setPermJsonCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setPermJsonCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, []);

    // Mirror the buildChannelConfig logic — filter manifest.name when it equals
    // the npm package id, otherwise the wizard header would display
    // "wecom/wecom-openclaw-plugin" before promoted.name resolves.
    const openclawWizardManifestName = installedPlugin?.manifest?.name && !isDirtyChannelName({
        name: installedPlugin.manifest.name,
        openclawNpmSpec: installedPlugin?.npmSpec,
    }) ? installedPlugin.manifest.name : null;
    const openclawPluginName = promoted?.name || openclawWizardManifestName || openclawPluginId || 'Plugin';
    const platformLabel = isOpenClaw
        ? openclawPluginName
        : isDingtalk
            ? t('agentSettings.channelWizard.platform.dingtalk')
            : isFeishu
                ? t('agentSettings.channelWizard.platform.feishu')
                : t('agentSettings.channelWizard.platform.telegram');

    // Platform icon for header
    const platformIcon = (() => {
        if (platform === 'telegram') return telegramIcon;
        if (platform === 'feishu') return feishuIcon;
        if (platform === 'dingtalk') return dingtalkIcon;
        if (promoted) return promoted.icon;
        return undefined;
    })();

    const stepLabel = (() => {
        if (isQrLogin) {
            if (step === 1) return t('agentSettings.channelWizard.steps.qrLogin');
            return t('agentSettings.channelWizard.steps.bindUser');
        }
        if (isOpenClaw) {
            if (step === 1) return t('agentSettings.channelWizard.steps.configurePlugin');
            if (step === 2) return t('agentSettings.channelWizard.steps.confirmAndStart');
            return t('agentSettings.channelWizard.steps.bindUser');
        }
        if (isDingtalk) {
            if (step === 1) return t('agentSettings.channelWizard.steps.configureCredentials');
            if (step === 2) return t('agentSettings.channelWizard.steps.configurePermissionsCapabilities');
            return t('agentSettings.channelWizard.steps.bindDingtalk');
        }
        if (isFeishu) {
            if (step === 1) return t('agentSettings.channelWizard.steps.configureCredentials');
            if (step === 2) return t('agentSettings.channelWizard.steps.configurePermissionsEvents');
            return t('agentSettings.channelWizard.steps.bindFeishu');
        }
        if (step === 1) return t('agentSettings.channelWizard.steps.configureBotToken');
        return t('agentSettings.channelWizard.steps.bindTelegram');
    })();

    // Reusable action bar for each step
    const renderActionBar = (props: {
        onBack?: () => void;
        backLabel?: string;
        onNext: () => void;
        nextLabel: string;
        nextDisabled?: boolean;
        nextLoading?: boolean;
        nextIcon?: React.ReactNode;
    }) => (
        <div className="flex items-center justify-between">
            {props.onBack ? (
                <button
                    onClick={props.onBack}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {props.backLabel || t('agentSettings.channelWizard.nav.back')}
                </button>
            ) : (
                <button
                    onClick={handleCancel}
                    className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                    {t('agentSettings.channelWizard.nav.cancel')}
                </button>
            )}
            <button
                onClick={props.onNext}
                disabled={props.nextDisabled}
                className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
            >
                {props.nextLabel}
                {props.nextLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : props.nextIcon ? (
                    props.nextIcon
                ) : null}
            </button>
        </div>
    );

    return (
        <div className="space-y-6">
            {/* Header: platform badge + title + step indicator */}
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    {platformIcon && (
                        <img src={platformIcon} alt={platformLabel} className="h-8 w-8 rounded-lg" />
                    )}
                    <div>
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            {t('agentSettings.channelWizard.header.title', { platform: platformLabel })}
                        </h2>
                        <p className="text-xs text-[var(--ink-muted)]">
                            {t('agentSettings.channelWizard.header.stepIndicator', { step, total: totalSteps, label: stepLabel })}
                        </p>
                    </div>
                </div>
                <div className="flex gap-1">
                    {Array.from({ length: totalSteps }, (_, i) => (
                        <div
                            key={i}
                            className={`h-1 flex-1 rounded-full ${step >= i + 1 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`}
                        />
                    ))}
                </div>
            </div>

            {/* Step 1: QR Login (for plugins that use QR code authentication) */}
            {step === 1 && isQrLogin && (
                <div className="space-y-6">
                    {/* Action bar — must use handleCancel to stop Bridge + remove config */}
                    {renderActionBar({
                        onNext: () => { qrAbortRef.current = true; handleCancel(); },
                        nextLabel: t('agentSettings.channelWizard.nav.cancel'),
                        nextIcon: undefined,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted && (
                                <img src={promoted.icon} alt={openclawPluginName} className="h-10 w-10 shrink-0 rounded-xl" />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* QR Code display */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6">
                        <div className="flex flex-col items-center gap-4">
                            {qrStatus === 'loading' && (
                                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-[var(--paper-inset)]">
                                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                                </div>
                            )}
                            {(qrStatus === 'waiting' || qrStatus === 'scanned') && qrImageUrl && (
                                <img src={qrImageUrl} alt={t('agentSettings.channelWizard.qr.scanAlt')} className="h-48 w-48 rounded-xl" />
                            )}
                            {qrStatus === 'connected' && (
                                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-[var(--accent-success-subtle)]">
                                    <Check className="h-12 w-12 text-[var(--accent-success)]" />
                                </div>
                            )}
                            {qrStatus === 'error' && (
                                <div className="flex h-48 w-48 flex-col items-center justify-center gap-2 rounded-xl bg-[var(--paper-inset)]">
                                    <p className="text-sm text-[var(--accent-danger)]">{t('agentSettings.channelWizard.qr.failed')}</p>
                                    <button
                                        onClick={() => { setQrStatus('idle'); }}
                                        className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                    >
                                        {t('agentSettings.channelWizard.qr.retry')}
                                    </button>
                                </div>
                            )}
                            <p className="text-sm text-[var(--ink-muted)]">{qrMessage}</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 1: DualConfig — QR scan OR manual config (WeCom) */}
            {step === 1 && isDualConfig && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: t('agentSettings.channelWizard.nav.next'),
                        nextDisabled: !hasCredentials,
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted && (
                                <img src={promoted.icon} alt={promoted.name} className="h-10 w-10 shrink-0 rounded-xl" />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{promoted?.name || openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                                {promoted?.description && (
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">{promoted.description}</p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Mode switcher: pill tab */}
                    <div className="flex gap-1 rounded-lg bg-[var(--paper-inset)] p-1">
                        <button
                            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                dualConfigMode === 'qr'
                                    ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                            onClick={() => handleDualModeSwitch('qr')}
                        >
                            {t('agentSettings.channelWizard.dual.scanMode')}
                        </button>
                        <button
                            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                dualConfigMode === 'config'
                                    ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                            onClick={() => handleDualModeSwitch('config')}
                        >
                            {t('agentSettings.channelWizard.dual.manualMode')}
                        </button>
                    </div>

                    {/* QR mode */}
                    {dualConfigMode === 'qr' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <p className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.dual.scanCreateBot')}</p>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                {t('agentSettings.channelWizard.dual.scanDescription', {
                                    app: promoted?.name?.replace(/（.*）/, '') || t('agentSettings.channelWizard.platform.wecom'),
                                })}
                            </p>

                            <div className="mt-5 flex flex-col items-center py-4">
                                {wecomQrStatus === 'loading' && (
                                    <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl border border-[var(--line)] bg-white">
                                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    </div>
                                )}
                                {wecomQrStatus === 'waiting' && wecomQrImageUrl && (
                                    <div className="rounded-xl border border-[var(--line)] bg-white p-1.5">
                                        <img src={wecomQrImageUrl} alt={t('agentSettings.channelWizard.dual.wecomScanAlt')} className="h-[200px] w-[200px] rounded-lg" />
                                    </div>
                                )}
                                {wecomQrStatus === 'success' && (
                                    <div className="flex h-[200px] w-[200px] flex-col items-center justify-center rounded-xl border border-[var(--success)] bg-[var(--success-bg)]">
                                        <Check className="h-8 w-8 text-[var(--success)]" />
                                        <p className="mt-2 text-sm font-medium text-[var(--success)]">{t('agentSettings.channelWizard.dual.scanSuccess')}</p>
                                        <p className="mt-1 text-xs text-[var(--success)]">{t('agentSettings.channelWizard.dual.credentialsReceived')}</p>
                                    </div>
                                )}
                                {wecomQrStatus === 'error' && (
                                    <div className="flex h-[200px] w-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                        <p className="text-sm text-[var(--ink-muted)]">
                                            {wecomQrRefreshCount > 0
                                                ? t('agentSettings.channelWizard.dual.qrExpiredMultiple')
                                                : t('agentSettings.channelWizard.qr.loadFailed')}
                                        </p>
                                        <button
                                            onClick={() => {
                                                wecomQrStartedRef.current = false;
                                                wecomQrAbortRef.current = false;
                                                setWecomQrStatus('idle');
                                                setWecomQrRefreshCount(0);
                                                setWecomQrRetryTrigger(n => n + 1);
                                            }}
                                            className="text-xs text-[var(--accent-warm)] hover:underline"
                                        >
                                            {t('agentSettings.channelWizard.qr.retry')}
                                        </button>
                                    </div>
                                )}
                                {wecomQrStatus === 'idle' && (
                                    <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    </div>
                                )}

                                <p className="mt-3 text-xs text-[var(--ink-muted)]">
                                    {wecomQrStatus === 'loading' && (wecomQrRefreshCount > 0
                                        ? t('agentSettings.channelWizard.dual.qrExpiredRefreshing', { current: wecomQrRefreshCount, max: WECOM_MAX_QR_REFRESHES })
                                        : t('agentSettings.channelWizard.qr.loading'))}
                                    {wecomQrStatus === 'waiting' && t('agentSettings.channelWizard.dual.scanWithWecom')}
                                    {wecomQrStatus === 'success' && t('agentSettings.channelWizard.dual.credentialsReady')}
                                    {wecomQrStatus === 'error' && (wecomQrRefreshCount > 0
                                        ? t('agentSettings.channelWizard.dual.qrExpiredRetry')
                                        : t('agentSettings.channelWizard.dual.networkRetry'))}
                                </p>
                            </div>

                            <p className="mt-2 text-xs text-[var(--ink-subtle)]">
                                {t('agentSettings.channelWizard.dual.scanNote')}
                            </p>
                        </div>
                    )}

                    {/* Manual config mode */}
                    {dualConfigMode === 'config' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <h3 className="text-sm font-medium text-[var(--ink)]">
                                {promoted?.setupGuide?.credentialTitle || t('agentSettings.channelWizard.config.pluginConfig')}
                            </h3>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                {promoted?.setupGuide?.credentialHintLink ? (
                                    <>
                                        {t('agentSettings.channelWizard.config.goToPrefix')}
                                        <a
                                            href={promoted.setupGuide.credentialHintLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                            onClick={(e) => {
                                                if (isTauriEnvironment()) {
                                                    e.preventDefault();
                                                    import('@tauri-apps/plugin-shell').then(({ open }) => open(promoted!.setupGuide!.credentialHintLink!));
                                                }
                                            }}
                                        >
                                            {t('agentSettings.channelWizard.dual.wecomAdmin')}
                                            <ExternalLink className="inline h-3 w-3" />
                                        </a>
                                        {t('agentSettings.channelWizard.dual.wecomCredentialSuffix')}
                                    </>
                                ) : (
                                    promoted?.setupGuide?.credentialHint || t('agentSettings.channelWizard.config.inputPluginParams')
                                )}
                            </p>

                            <div className="mt-4 space-y-3">
                                {(promoted?.requiredFields ?? []).map((key) => (
                                    <div key={key}>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                            {key}
                                            <span className="ml-1 text-[var(--error)]">*</span>
                                        </label>
                                        <input
                                            type={/secret|token|password|key/i.test(key) ? 'password' : 'text'}
                                            value={String(openclawSchemaValues[key] ?? '')}
                                            onChange={(e) => setOpenclawSchemaValues(prev => ({ ...prev, [key]: e.target.value }))}
                                            placeholder={t('agentSettings.channelWizard.config.fieldPlaceholder', { field: key })}
                                            className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                                        />
                                    </div>
                                ))}
                            </div>

                            <p className="mt-4 text-xs text-[var(--ink-subtle)]">
                                {t('agentSettings.channelWizard.dual.manualMethod')}
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Step 1: Credentials / OpenClaw Config */}
            {step === 1 && isOpenClaw && !isQrLogin && !isDualConfig && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: t('agentSettings.channelWizard.nav.next'),
                        nextDisabled: openclawHasIncompleteFields || openclawHasIncompleteSchema,
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted ? (
                                <img src={promoted.icon} alt={openclawPluginName} className="h-10 w-10 shrink-0 rounded-xl" />
                            ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
                                    <Puzzle className="h-5 w-5 text-[var(--accent-warm)]" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                                {(promoted?.description || installedPlugin?.manifest?.description) && (
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        {promoted?.description || installedPlugin?.manifest?.description}
                                    </p>
                                )}
                                {installedPlugin?.homepage && (
                                    <button
                                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--accent-warm)] hover:underline"
                                        onClick={() => {
                                            if (isTauriEnvironment()) {
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(installedPlugin!.homepage!));
                                            }
                                        }}
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        {t('agentSettings.channelWizard.config.projectHomepage')}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Config section */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {promoted?.setupGuide?.credentialTitle || t('agentSettings.channelWizard.config.pluginConfig')}
                        </h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            {promoted?.setupGuide?.credentialHintLink ? (
                                <>
                                    {promoted.setupGuide.credentialHint.split(promoted.setupGuide.credentialHintLink)[0] || t('agentSettings.channelWizard.config.goToPrefix')}
                                    <a
                                        href={promoted.setupGuide.credentialHintLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                        onClick={(e) => {
                                            if (isTauriEnvironment()) {
                                                e.preventDefault();
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(promoted!.setupGuide!.credentialHintLink!));
                                            }
                                        }}
                                    >
                                        {t('agentSettings.channelWizard.config.openPlatform', { name: openclawPluginName })}
                                        <ExternalLink className="inline h-3 w-3" />
                                    </a>
                                    {t('agentSettings.channelWizard.config.createAppSuffix')}
                                </>
                            ) : (
                                promoted?.setupGuide?.credentialHint || t('agentSettings.channelWizard.config.inputPluginParamsExample')
                            )}
                        </p>

                        <div className="mt-4">
                            {hasOpenclawSchema ? (
                                <div className="space-y-4">
                                    <div className="space-y-3">
                                        {Object.entries(openclawSchemaProps).map(([key, field]) => {
                                            const isRequired = openclawSchemaRequired.has(key);
                                            return (
                                                <OpenClawScalarField
                                                    key={key}
                                                    name={key}
                                                    field={field}
                                                    value={openclawSchemaValues[key]}
                                                    required={isRequired}
                                                    onChange={(value) => setOpenclawSchemaValues(prev => ({ ...prev, [key]: value }))}
                                                    placeholder={t('agentSettings.channelWizard.config.fieldPlaceholder', { field: key })}
                                                />
                                            );
                                        })}
                                    </div>
                                    {/* Extra custom fields */}
                                    <div className="border-t border-[var(--line-subtle)] pt-3">
                                        <p className="mb-2 text-xs text-[var(--ink-muted)]">{t('agentSettings.channelWizard.config.customConfig')}</p>
                                        <div className="space-y-2">
                                            {openclawCustomFields.map((field, i) => (
                                                <div key={i} className="flex items-center gap-2">
                                                    <input type="text" value={field.key} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], key: e.target.value }; setOpenclawCustomFields(next); }} placeholder={t('agentSettings.channelWizard.config.keyPlaceholder')} className="w-[140px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                                    <input type="text" value={field.value} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], value: e.target.value }; setOpenclawCustomFields(next); }} placeholder={t('agentSettings.channelWizard.config.valuePlaceholder')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                                    <button onClick={() => setOpenclawCustomFields(openclawCustomFields.filter((_, idx) => idx !== i))} className="shrink-0 rounded-lg p-1.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                                                </div>
                                            ))}
                                            <button onClick={() => setOpenclawCustomFields([...openclawCustomFields, { key: '', value: '' }])} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                                <Plus className="h-3.5 w-3.5" />
                                                {t('agentSettings.channelWizard.config.addConfigItem')}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {openclawCustomFields.map((field, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <input type="text" value={field.key} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], key: e.target.value }; setOpenclawCustomFields(next); }} placeholder={t('agentSettings.channelWizard.config.keyPlaceholder')} className="w-[140px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                            <input type="text" value={field.value} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], value: e.target.value }; setOpenclawCustomFields(next); }} placeholder={t('agentSettings.channelWizard.config.valuePlaceholder')} className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                            <button onClick={() => setOpenclawCustomFields(openclawCustomFields.filter((_, idx) => idx !== i))} className="shrink-0 rounded-lg p-1.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                                        </div>
                                    ))}
                                    <button onClick={() => setOpenclawCustomFields([...openclawCustomFields, { key: '', value: '' }])} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                        <Plus className="h-3.5 w-3.5" />
                                        {t('agentSettings.channelWizard.config.addConfigItem')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Step-by-step image guide (promoted plugins only) */}
                    {promoted?.setupGuide?.steps && promoted.setupGuide.steps.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <p className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.config.setupGuide')}</p>
                            {promoted.setupGuide.steps.map((guideStep, i) => {
                                const linkText = guideStep.captionLinkText;
                                const linkUrl = guideStep.captionLinkUrl;
                                const splitIdx = linkText ? guideStep.caption.indexOf(linkText) : -1;
                                return (
                                    <div key={i} className={i > 0 ? 'mt-5' : 'mt-3'}>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {splitIdx >= 0 && linkUrl ? (
                                                <>
                                                    {guideStep.caption.slice(0, splitIdx)}
                                                    <a
                                                        href={linkUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                                        onClick={(e) => {
                                                            if (isTauriEnvironment()) {
                                                                e.preventDefault();
                                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(linkUrl));
                                                            }
                                                        }}
                                                    >
                                                        {linkText}
                                                        <ExternalLink className="inline h-3 w-3" />
                                                    </a>
                                                    {guideStep.caption.slice(splitIdx + linkText!.length)}
                                                </>
                                            ) : guideStep.caption}
                                        </p>
                                        <img
                                            src={guideStep.image}
                                            alt={guideStep.alt}
                                            className="mt-2 w-full rounded-lg border border-[var(--line)]"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Step 1: Credentials (built-in platforms) */}
            {step === 1 && !isOpenClaw && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: t('agentSettings.channelWizard.nav.next'),
                        nextDisabled: !hasCredentials || starting,
                        nextLoading: starting,
                        nextIcon: !starting ? <ArrowRight className="h-4 w-4" /> : undefined,
                    })}

                    {isDingtalk ? (
                        <div className="space-y-6">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <DingtalkCredentialInput
                                    clientId={dingtalkClientId}
                                    clientSecret={dingtalkClientSecret}
                                    onClientIdChange={setDingtalkClientId}
                                    onClientSecretChange={setDingtalkClientSecret}
                                    verifyStatus={verifyStatus}
                                    botName={botUsername}
                                    showGuide={false}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <p className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.dingtalk.credentialsTitle')}
                                </p>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep1Prefix')}<a
                                        href="https://open-dev.dingtalk.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mx-0.5 inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                    >
                                        {t('agentSettings.channelWizard.guides.dingtalk.openPlatform')}
                                    </a>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep1Middle')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.appDevelopment')}</span> &gt; <span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.dingtalkApps')}</span></li>
                                    <li>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.createApp')}</span>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep2Suffix')}</li>
                                    <li>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep3Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.credentialsBasicInfo')}</span>{t('agentSettings.channelWizard.guides.dingtalk.credentialsStep3Suffix')}</li>
                                </ol>
                                <img src={dingtalkStep1CreateAppImg} alt={t('agentSettings.channelWizard.guides.dingtalk.altCreateApp')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                                <img src={dingtalkStep1CredentialsImg} alt={t('agentSettings.channelWizard.guides.dingtalk.altCredentials')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </div>
                    ) : isFeishu ? (
                        <div className="space-y-6">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <FeishuCredentialInput
                                    appId={feishuAppId}
                                    appSecret={feishuAppSecret}
                                    onAppIdChange={setFeishuAppId}
                                    onAppSecretChange={setFeishuAppSecret}
                                    verifyStatus={verifyStatus}
                                    botName={botUsername}
                                    showGuide={false}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <p className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.feishu.credentialsTitle')}
                                </p>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>{t('agentSettings.channelWizard.guides.feishu.credentialsStep1Prefix')}<a
                                        href="https://open.feishu.cn/app"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mx-0.5 inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                    >
                                        {t('agentSettings.channelWizard.guides.feishu.openPlatform')}
                                    </a>{t('agentSettings.channelWizard.guides.feishu.credentialsStep1Suffix')}</li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.credentialsStep2')}</li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.credentialsStep3')}</li>
                                </ol>
                                <img src={feishuStep1Img} alt={t('agentSettings.channelWizard.guides.feishu.altCredentials')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <BotTokenInput
                                    value={botToken}
                                    onChange={setBotToken}
                                    verifyStatus={verifyStatus}
                                    botUsername={botUsername}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.telegram.tokenTitle')}
                                </h3>
                                <div className="mt-3 flex gap-5">
                                    <img
                                        src={telegramBotAddImg}
                                        alt={t('agentSettings.channelWizard.guides.telegram.altBotFather')}
                                        className="h-[270px] flex-shrink-0 rounded-lg border border-[var(--line)] object-cover"
                                    />
                                    <ol className="flex-1 space-y-2 text-sm text-[var(--ink-muted)]">
                                        <li>{t('agentSettings.channelWizard.guides.telegram.step1Prefix')}<span className="font-medium text-[var(--ink)]">@BotFather</span>{t('agentSettings.channelWizard.guides.telegram.step1Suffix')}</li>
                                        <li>{t('agentSettings.channelWizard.guides.telegram.step2Prefix')}<code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">/newbot</code>{t('agentSettings.channelWizard.guides.telegram.step2Suffix')}</li>
                                        <li>{t('agentSettings.channelWizard.guides.telegram.step3')}</li>
                                        <li>{t('agentSettings.channelWizard.guides.telegram.step4Prefix')}<span className="font-medium text-[var(--ink)]">HTTP API Token</span></li>
                                        <li>{t('agentSettings.channelWizard.guides.telegram.step5')}</li>
                                    </ol>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Step 2 (DingTalk): Permissions & Capabilities guide */}
            {isDingtalk && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleNext,
                        nextLabel: t('agentSettings.channelWizard.nav.next'),
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.dingtalk.addBotTitle')}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.addBotStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.addCapability')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.addBotStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.bot')}</span>{t('agentSettings.channelWizard.guides.dingtalk.addBotStep2Middle')}<span className="font-medium text-[var(--ink)]">+ {t('agentSettings.channelWizard.guides.dingtalk.add')}</span></li>
                        </ol>
                        <img src={dingtalkStep2AddRobotImg} alt={t('agentSettings.channelWizard.guides.dingtalk.altAddBot')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.dingtalk.configureBotTitle')}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.bot')}</span>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep1Middle')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.botConfig')}</span>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep1Suffix')}</li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep2')}</li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep3Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.streamMode')}</span>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep3Suffix')}</li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep4Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.publish')}</span>{t('agentSettings.channelWizard.guides.dingtalk.configureBotStep4Suffix')}</li>
                        </ol>
                        <img src={dingtalkStep2StreamModeImg} alt={t('agentSettings.channelWizard.guides.dingtalk.altStreamMode')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.dingtalk.publishTitle')}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.publishStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.versionRelease')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.publishStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.createVersion')}</span>{t('agentSettings.channelWizard.guides.dingtalk.publishStep2Suffix')}</li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.publishStep3Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.appAvailableScope')}</span>{t('agentSettings.channelWizard.guides.dingtalk.publishStep3Middle')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.dingtalk.allEmployees')}</span>{t('agentSettings.channelWizard.guides.dingtalk.publishStep3Suffix')}</li>
                            <li>{t('agentSettings.channelWizard.guides.dingtalk.publishStep4')}</li>
                        </ol>
                        <img src={dingtalkStep2PublishImg} alt={t('agentSettings.channelWizard.guides.dingtalk.altPublish')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>
                </div>
            )}

            {/* Step 2 (Feishu): Permissions & Events guide */}
            {isFeishu && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleNext,
                        nextLabel: t('agentSettings.channelWizard.nav.next'),
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    {/* Status strip: credential verified, what's next */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-[var(--ink)]">
                            <Check className="h-4 w-4 text-[var(--success)]" />
                            <span>
                                {botUsername
                                    ? t('agentSettings.channelWizard.guides.feishu.credentialVerifiedWithName', { name: botUsername })
                                    : t('agentSettings.channelWizard.guides.feishu.credentialVerified')}
                            </span>
                        </div>
                        <p className="mt-1.5 pl-6 text-xs text-[var(--ink-muted)]">
                            {t('agentSettings.channelWizard.guides.feishu.nextHint')}
                        </p>
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.feishu.permissionsTitle', { step: 4 })}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.permissionManagement')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.batchImport')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep3')}</li>
                        </ol>
                        <div className="mt-3 relative">
                            <button
                                onClick={handleCopyPermJson}
                                className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                title={t('agentSettings.channelWizard.guides.feishu.copyJson')}
                            >
                                {permJsonCopied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                            <pre className="overflow-x-auto rounded-lg bg-[var(--paper-inset)] p-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                                {FEISHU_PERMISSIONS_JSON}
                            </pre>
                        </div>
                        <img src={feishuStep2PermImg} alt={t('agentSettings.channelWizard.guides.feishu.altPermissions')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.feishu.eventsTitle', { step: 5 })}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.eventsCallbacks')}</span> &gt; <span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.eventConfig')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.longConnection')}</span>{t('agentSettings.channelWizard.guides.feishu.eventsStep2Suffix')}</li>
                            <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep3Prefix')}<code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">im.message.receive_v1</code>{t('agentSettings.channelWizard.guides.feishu.eventsStep3Suffix')}</li>
                        </ol>
                        <img src={feishuStep2EventImg} alt={t('agentSettings.channelWizard.guides.feishu.altEvents')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {t('agentSettings.channelWizard.guides.feishu.publishTitle', { step: 6 })}
                        </h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>{t('agentSettings.channelWizard.guides.feishu.publishStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.versionRelease')}</span></li>
                            <li>{t('agentSettings.channelWizard.guides.feishu.publishStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.createVersion')}</span>{t('agentSettings.channelWizard.guides.feishu.publishStep2Suffix')}</li>
                        </ol>
                        <img src={feishuStep2PublishImg} alt={t('agentSettings.channelWizard.guides.feishu.altPublish')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>
                </div>
            )}

            {/* OpenClaw Step 2: Setup guide (for promoted plugins like feishu) + Confirm + Start */}
            {/* Skip for QR login plugins — they go directly from scan (step 1) to binding (step 2) */}
            {isOpenClaw && !isQrLogin && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleOpenClawStart,
                        nextLabel: starting
                            ? t('agentSettings.channelWizard.nav.starting')
                            : t('agentSettings.channelWizard.nav.startChannel'),
                        nextDisabled: starting,
                        nextLoading: starting,
                        nextIcon: !starting ? <Check className="h-4 w-4" /> : undefined,
                    })}

                    {/* Status strip (lark): show credentials + what's next */}
                    {promoted?.pluginId === 'openclaw-lark' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] px-4 py-3">
                            <div className="flex items-center gap-2 text-sm text-[var(--ink)]">
                                <Check className="h-4 w-4 text-[var(--success)]" />
                                <span>{t('agentSettings.channelWizard.openclaw.credentialsEntered', { name: openclawPluginName })}</span>
                            </div>
                            <p className="mt-1.5 pl-6 text-xs text-[var(--ink-muted)]">
                                {t('agentSettings.channelWizard.openclaw.larkNextHint')}
                            </p>
                        </div>
                    )}

                    {/* Feishu-specific: Permissions + Events + Publish guide (reuse built-in feishu setup) */}
                    {promoted?.pluginId === 'openclaw-lark' && (
                        <>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.feishu.permissionsTitle', { step: 2 })}
                                </h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.permissionManagement')}</span></li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.batchImport')}</span></li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.permissionsStep3')}</li>
                                </ol>
                                <div className="mt-3 relative">
                                    <button
                                        onClick={handleCopyPermJson}
                                        className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                        title={t('agentSettings.channelWizard.guides.feishu.copyJson')}
                                    >
                                        {permJsonCopied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                                    </button>
                                    <pre className="overflow-x-auto rounded-lg bg-[var(--paper-inset)] p-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                                        {FEISHU_PERMISSIONS_JSON}
                                    </pre>
                                </div>
                                <img src={feishuStep2PermImg} alt={t('agentSettings.channelWizard.guides.feishu.altPermissions')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>

                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.feishu.eventsTitle', { step: 3 })}
                                </h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.eventsCallbacks')}</span> &gt; <span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.eventConfig')}</span></li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.longConnection')}</span>{t('agentSettings.channelWizard.guides.feishu.eventsStep2Suffix')}</li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.eventsStep3Prefix')}<code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">im.message.receive_v1</code>{t('agentSettings.channelWizard.guides.feishu.eventsStep3Suffix')}</li>
                                </ol>
                                <img src={feishuStep2EventImg} alt={t('agentSettings.channelWizard.guides.feishu.altEvents')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>

                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    {t('agentSettings.channelWizard.guides.feishu.botPublishTitle', { step: 4 })}
                                </h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>{t('agentSettings.channelWizard.guides.feishu.botPublishStep1Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.addCapability')}</span>{t('agentSettings.channelWizard.guides.feishu.botPublishStep1Middle')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.bot')}</span>{t('agentSettings.channelWizard.guides.feishu.botPublishStep1Suffix')}</li>
                                    <li>{t('agentSettings.channelWizard.guides.feishu.botPublishStep2Prefix')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.versionRelease')}</span>{t('agentSettings.channelWizard.guides.feishu.botPublishStep2Middle')}<span className="font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.guides.feishu.createVersion')}</span>{t('agentSettings.channelWizard.guides.feishu.botPublishStep2Suffix')}</li>
                                </ol>
                                <img src={feishuStep2AddBotImg} alt={t('agentSettings.channelWizard.guides.feishu.altAddBot')} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </>
                    )}

                    {/* Promoted plugin setup guide steps (non-feishu plugins) */}
                    {promoted && promoted.pluginId !== 'openclaw-lark' && promoted.setupGuide?.steps && (
                        <>
                            {promoted.setupGuide.steps.map((s, i) => (
                                <div key={i} className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                    <p className="text-sm text-[var(--ink-muted)]">{s.caption}</p>
                                    <img src={s.image} alt={s.alt} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                                </div>
                            ))}
                        </>
                    )}

                    {/* Confirm panel (non-lark): lark uses the top status strip instead */}
                    {promoted?.pluginId !== 'openclaw-lark' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <h3 className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.openclaw.confirmTitle')}</h3>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                {t('agentSettings.channelWizard.openclaw.confirmDescription')}
                            </p>

                            <div className="mt-4 space-y-3">
                                <div className="flex items-center gap-3 rounded-lg border border-[var(--line)] p-3">
                                    {promoted ? (
                                        <img src={promoted.icon} alt={openclawPluginName} className="h-8 w-8 shrink-0 rounded-lg" />
                                    ) : (
                                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)]">
                                            <Puzzle className="h-4 w-4 text-[var(--accent-warm)]" />
                                        </div>
                                    )}
                                    <div>
                                        <p className="text-sm font-medium text-[var(--ink)]">{openclawPluginName}</p>
                                        {installedPlugin?.packageVersion && (
                                            <p className="text-xs text-[var(--ink-muted)]">v{installedPlugin.packageVersion}</p>
                                        )}
                                    </div>
                                </div>

                                {(() => {
                                    const cfg = buildOpenclawConfig();
                                    const count = Object.keys(cfg).length;
                                    return count > 0 ? (
                                        <div className="flex items-center justify-between rounded-lg border border-[var(--line)] p-3">
                                            <span className="text-xs text-[var(--ink-muted)]">{t('agentSettings.channelWizard.openclaw.configItems')}</span>
                                            <span className="text-sm text-[var(--ink)]">
                                                {t('agentSettings.channelWizard.openclaw.configItemsCount', { count })}
                                            </span>
                                        </div>
                                    ) : null;
                                })()}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Binding step (all platforms) */}
            {step === bindingStep && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: isQrLogin ? undefined : () => setStep((isFeishu || isDingtalk || isOpenClaw) ? 2 : 1),
                        onNext: handleComplete,
                        nextLabel: t('agentSettings.channelWizard.nav.finish'),
                        nextIcon: <Check className="h-4 w-4" />,
                    })}

                    {(isFeishu || isDingtalk || (isOpenClaw && !isQrLogin)) ? (
                        botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={allowedUsers.length > 0}
                                platformName={isOpenClaw ? platformLabel : isDingtalk
                                    ? t('agentSettings.channelWizard.platform.dingtalk')
                                    : t('agentSettings.channelWizard.platform.feishu')}
                            />
                        )
                    ) : isQrLogin ? (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelWizard.binding.title')}</label>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    {t('agentSettings.channelWizard.binding.qrOnly')}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            {botStatus?.bindUrl && (
                                <BindQrPanel
                                    bindUrl={botStatus.bindUrl}
                                    hasWhitelistUsers={allowedUsers.length > 0}
                                />
                            )}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <WhitelistManager
                                    users={allowedUsers}
                                    onChange={setAllowedUsers}
                                    platform={platform}
                                />
                            </div>
                        </>
                    )}

                    {(isFeishu || isDingtalk || (isOpenClaw && !isQrLogin)) && allowedUsers.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <WhitelistManager
                                users={allowedUsers}
                                onChange={setAllowedUsers}
                                platform={platform}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
