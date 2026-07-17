// IM Bot integration types (shared between frontend, backend, and Rust)

/**
 * IM platform type
 */
export type ImPlatform = 'telegram' | 'feishu' | 'dingtalk' | `openclaw:${string}`;

/**
 * Message source identifier
 */
export type MessageSource = 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group' | 'dingtalk_private' | 'dingtalk_group' | `${string}_private` | `${string}_group`;

/**
 * Metadata attached to each message indicating its origin
 */
export interface MessageMetadata {
  source: MessageSource;
  sourceId?: string;      // Telegram chat_id
  senderName?: string;    // Telegram username
}

/**
 * IM Bot operational status
 */
export type ImStatus = 'online' | 'connecting' | 'error' | 'stopped';

/**
 * IM source type (private chat vs group)
 */
export type ImSourceType = 'private' | 'group';

/**
 * Group permission status
 */
export type GroupPermissionStatus = 'pending' | 'approved';

/**
 * Group activation mode
 */
export type GroupActivation = 'mention' | 'always';

/**
 * Group chat permission record
 */
export interface GroupPermission {
  groupId: string;
  groupName: string;
  platform: ImPlatform;
  status: GroupPermissionStatus;
  discoveredAt: string;
  addedBy?: string;
}

/**
 * IM Bot configuration (stored in AppConfig)
 * Designed for multi-bot architecture (currently single bot)
 */
export interface ImBotConfig {
  // ===== Multi-bot identity =====
  id: string;                   // Bot unique ID (UUID)
  name: string;                 // User-defined name (e.g. "工作助手")
  platform: ImPlatform;         // Platform type

  // ===== Platform connection =====
  botToken: string;             // Telegram Bot Token
  allowedUsers: string[];       // user_id or username

  // ===== Feishu-specific credentials =====
  feishuAppId?: string;
  feishuAppSecret?: string;

  // ===== DingTalk-specific credentials =====
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  dingtalkUseAiCard?: boolean;
  dingtalkCardTemplateId?: string;

  // ===== Telegram-specific options =====
  /** Telegram: 使用 sendMessageDraft 实现打字机流式效果 (实验性, v0.1.34) */
  telegramUseDraft?: boolean;

  // ===== AI config (independent from Desktop client) =====
  providerId?: string;          // Provider ID (e.g. 'anthropic-sub', 'deepseek')
  model?: string;               // Model ID (e.g. 'claude-sonnet-4-6')
  providerEnvJson?: string;     // Persisted {baseUrl, apiKey, authType} for Rust auto-start
  permissionMode: string;       // 'plan' | 'auto' | 'fullAgency'
  mcpEnabledServers?: string[]; // Bot-enabled MCP server IDs

  // ===== Workspace =====
  defaultWorkspacePath?: string;

  // ===== Runtime state =====
  enabled: boolean;

  /** Wizard completed (Token verified + user bound). Defaults to false for new bots. */
  setupCompleted?: boolean;

  // ===== Heartbeat (v0.1.21) =====
  heartbeat?: HeartbeatConfig;

  // ===== Group Chat (v0.1.28) =====
  groupPermissions?: GroupPermission[];
  groupActivation?: GroupActivation;
  groupToolsDeny?: string[];

  // ===== OpenClaw Channel Plugin =====
  /** Install plugin ID used to locate ~/.myagents/openclaw-plugins/<pluginId>. */
  openclawPluginId?: string;
  openclawNpmSpec?: string;
  openclawPluginConfig?: Record<string, unknown>;
  openclawManifest?: Record<string, string>;
}

/**
 * Installed OpenClaw channel plugin (from ~/.myagents/openclaw-plugins/)
 */
export interface InstalledPlugin {
  pluginId: string;
  installDir: string;
  npmSpec: string;
  manifest: {
    id?: string;
    name?: string;
    description?: string;
    channels?: string[];
    configSchema?: {
      type: string;
      properties: Record<string, {
        type?: string;
        description?: string;
        enum?: unknown[];
        default?: unknown;
      }>;
      required?: string[];
    };
  } | null;
  packageVersion?: string;
  homepage?: string;
  /** Required config field names extracted from the plugin's isConfigured check */
  requiredFields?: string[];
  /** Whether the plugin supports QR code login (detected from gateway.loginWithQrStart) */
  supportsQrLogin?: boolean;
}

/**
 * Heartbeat configuration for periodic autonomous checks.
 * The actual checklist content lives in HEARTBEAT.md in the workspace root,
 * not in this config — the config only controls timing and behavior.
 */
export interface HeartbeatConfig {
  /** Enable/disable heartbeat (default: true) */
  enabled: boolean;
  /** Interval in minutes between heartbeat checks (default: 30, min: 5) */
  intervalMinutes: number;
  /** Active hours window — heartbeat only fires within this window */
  activeHours?: ActiveHoursConfig;
  /** Max chars for HEARTBEAT_OK detection after stripping token (default: 300) */
  ackMaxChars?: number;
}

/**
 * Active hours window for heartbeat scheduling
 */
export interface ActiveHoursConfig {
  /** Start time in HH:MM format (inclusive) */
  start: string;
  /** End time in HH:MM format (exclusive) */
  end: string;
  /** IANA timezone name (default: "Asia/Shanghai") */
  timezone: string;
}

export const DEFAULT_HEARTBEAT_ACTIVE_HOURS: ActiveHoursConfig = {
  start: '09:00',
  end: '21:00',
  timezone: 'Asia/Shanghai',
};

/**
 * Default heartbeat configuration
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMinutes: 240,
  activeHours: { ...DEFAULT_HEARTBEAT_ACTIVE_HOURS },
  ackMaxChars: 300,
};

/**
 * Memory auto-update configuration for periodic memory maintenance.
 * The actual update instructions live in UPDATE_MEMORY.md in the workspace root.
 * System reads the file body (stripping YAML frontmatter) as the prompt.
 */
export interface MemoryAutoUpdateConfig {
  /** Enable/disable auto memory update (default: true) */
  enabled: boolean;
  /** Minimum interval between update batches in hours (default: 24) */
  intervalHours: 24 | 48 | 72;
  /** Minimum new user queries in a session since last update to qualify (default: 3) */
  queryThreshold: number;
  /** Update window start time in HH:MM format (default: "21:00") */
  updateWindowStart: string;
  /** Update window end time in HH:MM format (default: "09:00") */
  updateWindowEnd: string;
  /** IANA timezone for update window (defaults to heartbeat timezone or "Asia/Shanghai") */
  updateWindowTimezone?: string;
  /** ISO timestamp of last batch start */
  lastBatchAt?: string;
  /** Number of sessions updated in last batch */
  lastBatchSessionCount?: number;
}

/**
 * Default memory auto-update configuration
 */
export const DEFAULT_MEMORY_AUTO_UPDATE_CONFIG: MemoryAutoUpdateConfig = {
  enabled: true,
  intervalHours: 24,
  queryThreshold: 3,
  updateWindowStart: '21:00',
  updateWindowEnd: '09:00',
  updateWindowTimezone: undefined,
};

export type MemoryEvolutionJobStatus = 'completed' | 'skipped' | 'error' | 'timeout';

/**
 * Long-term memory evolution configuration.
 * The public UI only exposes the top-level switch; cadence and job shape are
 * product-owned managed tasks.
 */
export interface MemoryEvolutionConfig {
  /** Enable/disable long-term memory evolution (default: true for Mino templates) */
  enabled: boolean;
  /** ISO timestamp of last memory gardener run */
  lastGardenerAt?: string;
  /** Last memory gardener run status */
  lastGardenerStatus?: MemoryEvolutionJobStatus;
  /** Optional short diagnostic from the last memory gardener run */
  lastGardenerMessage?: string;
  /** ISO timestamp of last molt run */
  lastMoltAt?: string;
  /** Last molt run status */
  lastMoltStatus?: MemoryEvolutionJobStatus;
  /** Optional short diagnostic from the last molt run */
  lastMoltMessage?: string;
}

export const DEFAULT_MEMORY_EVOLUTION_CONFIG: MemoryEvolutionConfig = {
  enabled: true,
};

/**
 * Active IM session info (for status display)
 */
export interface ImActiveSession {
  sessionKey: string;         // e.g. "im:telegram:private:12345"
  sessionId: string;          // SDK session ID (for resume after restart)
  sourceType: ImSourceType;
  workspacePath: string;
  messageCount: number;
  metadataBirthPending?: boolean;
  metadataIndexed?: boolean;
  lastActive: string;         // ISO timestamp
}

/**
 * IM Bot runtime status (returned by cmd_im_bot_status)
 */
export interface ImBotStatus {
  botUsername?: string;
  status: ImStatus;
  uptimeSeconds: number;
  lastMessageAt?: string;       // ISO timestamp
  activeSessions: ImActiveSession[];
  errorMessage?: string;
  restartCount: number;
  bufferedMessages: number;
  /** Deep link URL for QR code (e.g. https://t.me/BotName?start=BIND_xxxx) */
  bindUrl?: string;
  /** Plain bind code for platforms without deep links (e.g. Feishu) */
  bindCode?: string;
}

/**
 * IM conversation summary (for listing in Desktop UI)
 */
export interface ImConversation {
  sessionId: string;
  sessionKey: string;
  sourceType: ImSourceType;
  sourceId: string;             // Telegram chat_id
  workspacePath: string;
  messageCount: number;
  lastActive: string;           // ISO timestamp
}

/**
 * Check if a platform is an OpenClaw channel plugin
 */
export function isOpenClawPlatform(platform: ImPlatform): platform is `openclaw:${string}` {
  return platform.startsWith('openclaw:');
}

/**
 * Extract the channel ID from an OpenClaw platform string
 */
export function getOpenClawChannelId(platform: ImPlatform): string | null {
  if (!isOpenClawPlatform(platform)) return null;
  return platform.slice('openclaw:'.length);
}

/**
 * Default Telegram Bot configuration
 */
export const DEFAULT_IM_BOT_CONFIG: ImBotConfig = {
  id: '',           // Generated on creation
  name: 'Telegram Bot',
  platform: 'telegram',
  botToken: '',
  allowedUsers: [],
  providerId: undefined,
  model: undefined,
  permissionMode: 'fullAgency',
  mcpEnabledServers: undefined,
  enabled: false,
  setupCompleted: false,
};

/**
 * Default Feishu Bot configuration
 */
export const DEFAULT_FEISHU_BOT_CONFIG: ImBotConfig = {
  id: '',           // Generated on creation
  name: '飞书 Bot',
  platform: 'feishu',
  botToken: '',     // Not used for Feishu
  allowedUsers: [],
  feishuAppId: '',
  feishuAppSecret: '',
  providerId: undefined,
  model: undefined,
  permissionMode: 'fullAgency',
  mcpEnabledServers: undefined,
  enabled: false,
  setupCompleted: false,
};

/**
 * Default DingTalk Bot configuration
 */
export const DEFAULT_DINGTALK_BOT_CONFIG: ImBotConfig = {
  id: '',           // Generated on creation
  name: '钉钉 Bot',
  platform: 'dingtalk',
  botToken: '',     // Not used for DingTalk
  allowedUsers: [],
  dingtalkClientId: '',
  dingtalkClientSecret: '',
  dingtalkUseAiCard: false,
  providerId: undefined,
  model: undefined,
  permissionMode: 'fullAgency',
  mcpEnabledServers: undefined,
  enabled: false,
  setupCompleted: false,
};

/**
 * Source display labels (built-in platforms)
 */
const SOURCE_LABELS_MAP: Record<string, string> = {
  desktop: '桌面端',
  telegram_private: 'Telegram 私聊',
  telegram_group: 'Telegram 群聊',
  feishu_private: '飞书私聊',
  feishu_group: '飞书群聊',
  dingtalk_private: '钉钉私聊',
  dingtalk_group: '钉钉群聊',
};

/**
 * Get display label for a message source (supports dynamic OpenClaw sources)
 */
export function getSourceLabel(source: MessageSource): string {
  if (source in SOURCE_LABELS_MAP) return SOURCE_LABELS_MAP[source];
  // Dynamic fallback for OpenClaw plugins: "qqbot_private" → "qqbot 私聊"
  if (source.endsWith('_private')) return `${source.replace('_private', '')} 私聊`;
  if (source.endsWith('_group')) return `${source.replace('_group', '')} 群聊`;
  return source;
}

/** @deprecated Use getSourceLabel() for OpenClaw compatibility */
export const SOURCE_LABELS = SOURCE_LABELS_MAP as Record<MessageSource, string>;

/**
 * Source display icons (built-in platforms)
 */
const SOURCE_ICONS_MAP: Record<string, string> = {
  desktop: '🖥',
  telegram_private: '📱',
  telegram_group: '👥',
  feishu_private: '📱',
  feishu_group: '👥',
  dingtalk_private: '📱',
  dingtalk_group: '👥',
};

/**
 * Get display icon for a message source (supports dynamic OpenClaw sources)
 */
export function getSourceIcon(source: MessageSource): string {
  if (source in SOURCE_ICONS_MAP) return SOURCE_ICONS_MAP[source];
  if (source.endsWith('_group')) return '👥';
  return '📱';
}

/** @deprecated Use getSourceIcon() for OpenClaw compatibility */
export const SOURCE_ICONS = SOURCE_ICONS_MAP as Record<MessageSource, string>;
