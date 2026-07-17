/**
 * Promoted Plugins — community plugins that get first-class UI treatment.
 *
 * These are technically OpenClaw Channel Plugins (running via Plugin Bridge),
 * but displayed as built-in platforms with custom icons, branding, and setup guidance.
 */

import qqbotIcon from './assets/qqbot.png';
import qqbotStep1Img from './assets/qqbot_step1_index.png';
import qqbotStep2Img from './assets/qqbot_step2_credentials.png';
import feishuIcon from './assets/feishu.jpeg';
import feishuStep1Img from './assets/feishu_step1.png';
import weixinIcon from './assets/weixin.png';
import wecomIcon from './assets/wecom.jpeg';

export interface PromotedPlugin {
    /** Plugin ID — must match InstalledPlugin.pluginId after installation */
    pluginId: string;
    /** npm package spec for auto-install */
    npmSpec: string;
    /** Display name */
    name: string;
    /**
     * Channel brand — the `id` the plugin registers via `registerChannel({ id: ... })`.
     * May differ from pluginId (e.g. pluginId="wecom-openclaw-plugin" but brand="wecom").
     * Used to resolve display names from session keys and session sources, where the
     * bridge's channel brand appears instead of the npm package name.
     */
    channelBrand?: string;
    /** Short description shown on platform card */
    description: string;
    /** Icon asset (imported image path) */
    icon: string;
    /** Brand color for badges and accents */
    platformColor: string;
    /** Optional badge type for promoted plugins */
    badge?: 'official' | 'community';
    /** Required config field keys (pre-populate in wizard if plugin's isConfigured pattern is non-standard) */
    requiredFields?: string[];
    /** Default config values merged into pluginConfig when creating a new channel */
    defaultConfig?: Record<string, unknown>;
    /**
     * Authentication type:
     * - 'config' (default): user fills config fields (appId, appSecret, etc.)
     * - 'qrLogin': user scans QR code to login (e.g. WeChat)
     * - 'dualConfig': user chooses QR scan OR manual config to obtain credentials (e.g. WeCom)
     *   QR scan auto-creates a bot and retrieves credentials; manual lets user paste existing ones.
     *   Both paths write to openclawPluginConfig and then start normally via config auth.
     * Auto-detected for custom plugins via Bridge /capabilities supportsQrLogin.
     */
    authType?: 'config' | 'qrLogin' | 'dualConfig';
    /** Custom setup guidance for the wizard config step */
    setupGuide?: {
        /** Section title in config panel (e.g. "QQ Bot 应用凭证") */
        credentialTitle: string;
        /** Helper text above config inputs */
        credentialHint: string;
        /** Link URL for the credential hint text */
        credentialHintLink?: string;
        /** Step-by-step image guide shown below config inputs */
        steps?: Array<{
            /** Step image asset */
            image: string;
            /** Alt text for the image */
            alt: string;
            /** Caption / description shown above the image */
            caption: string;
            /** Optional: text within caption to make a link */
            captionLinkText?: string;
            /** Optional: URL for the caption link */
            captionLinkUrl?: string;
        }>;
    };
}

export const PROMOTED_PLUGINS: PromotedPlugin[] = [
    {
        pluginId: 'openclaw-lark',
        npmSpec: '@larksuite/openclaw-lark',
        name: '飞书',
        channelBrand: 'feishu',
        description: '飞书开放平台官方 OpenClaw 插件，支持文档/表格/日历等深度集成',
        icon: feishuIcon,
        platformColor: '#3370FF',
        badge: 'official',
        requiredFields: ['appId', 'appSecret'],
        defaultConfig: {
            streaming: true,
        },
        setupGuide: {
            credentialTitle: '飞书应用凭证',
            credentialHint: '前往飞书开放平台创建自建应用，获取 App ID 和 App Secret',
            credentialHintLink: 'https://open.feishu.cn/app',
            steps: [
                {
                    image: feishuStep1Img,
                    alt: '飞书开放平台 — 凭证与基础信息',
                    caption: '在飞书开放平台创建自建应用，「凭证与基础信息」页可看到 App ID 和 App Secret',
                    captionLinkText: '飞书开放平台',
                    captionLinkUrl: 'https://open.feishu.cn/app',
                },
            ],
        },
    },
    {
        pluginId: 'qqbot',
        npmSpec: '@sliverp/qqbot',
        name: 'QQ',
        channelBrand: 'qqbot',
        description: '通过 QQ Bot 远程使用 AI Agent',
        icon: qqbotIcon,
        platformColor: '#12B7F5',
        setupGuide: {
            credentialTitle: 'QQ Bot 应用凭证',
            credentialHint: '前往 QQ 开放平台创建应用，获取 AppID 和 AppSecret',
            credentialHintLink: 'https://q.qq.com/qqbot/openclaw/',
            steps: [
                {
                    image: qqbotStep1Img,
                    alt: 'QQ Bot 快速开始 — 扫码注册登录、创建机器人',
                    caption: '1. 扫码注册登录 QQ Bot 开放平台，创建机器人',
                    captionLinkText: 'QQ Bot 开放平台',
                    captionLinkUrl: 'https://q.qq.com/qqbot/openclaw/',
                },
                {
                    image: qqbotStep2Img,
                    alt: 'QQ Bot 凭证 — 获取 AppID 和 AppSecret',
                    caption: '2. 在机器人管理页获取 AppID 和 AppSecret，填入上方',
                },
            ],
        },
    },
    {
        pluginId: 'wecom-openclaw-plugin',
        npmSpec: '@wecom/wecom-openclaw-plugin',
        name: '企业微信',
        channelBrand: 'wecom',
        description: '腾讯企业微信官方 OpenClaw 插件，WebSocket 长连接、流式回复',
        icon: wecomIcon,
        platformColor: '#1B66F5',
        badge: 'official',
        authType: 'dualConfig',
        requiredFields: ['botId', 'secret'],
        defaultConfig: {
            dmPolicy: 'open',
            groupPolicy: 'disabled',
            sendThinkingMessage: 'true',
        },
        setupGuide: {
            credentialTitle: '企业微信机器人凭证',
            credentialHint: '前往企业微信管理后台创建智能机器人，获取 Bot ID 和 Secret',
            credentialHintLink: 'https://work.weixin.qq.com/wework_admin/',
        },
    },
    {
        pluginId: 'openclaw-weixin',
        npmSpec: '@tencent-weixin/openclaw-weixin',
        name: '微信',
        channelBrand: 'openclaw-weixin',
        description: '通过微信聊天使用 AI Agent，扫码即可连接',
        icon: weixinIcon,
        platformColor: '#07C160',
        badge: 'official',
        authType: 'qrLogin',
    },
];

/**
 * Find a promoted plugin by pluginId OR channelBrand.
 * This is the single lookup function — covers both npm package names (from config)
 * and bridge channel brands (from session keys / message sources).
 */
export function findPromotedPlugin(id: string | undefined): PromotedPlugin | undefined {
    if (!id) return undefined;
    return PROMOTED_PLUGINS.find(p => p.pluginId === id || p.channelBrand === id);
}

/** Find a promoted plugin by platform string (e.g. "openclaw:qqbot") */
export function findPromotedByPlatform(platform: string): PromotedPlugin | undefined {
    if (!platform.startsWith('openclaw:')) return undefined;
    const channelId = platform.slice('openclaw:'.length);
    return PROMOTED_PLUGINS.find(p => p.pluginId === channelId || p.channelBrand === channelId);
}
