/**
 * Shared utilities for Task Center components
 * (RecentTasks, HistorySearchOverlayContent, CronTaskDetailPanel, SessionHistoryDropdown)
 */

import type { SessionMetadata } from '@/api/sessionClient';
import { findPromotedPlugin } from '@/components/ImSettings/promotedPlugins';
import { currentSupportedLocale, formatPastRelativeTime } from '@/i18n/format';
import type { SupportedLocale } from '../../shared/i18n';
export { getSessionDisplayText } from '@/utils/sessionDisplay';

/**
 * Extract folder name from path (cross-platform)
 * Returns 'Workspace' for empty/invalid paths
 */
export function getFolderName(path: string): string {
    if (!path) return 'Workspace';
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || 'Workspace';
}

/**
 * Format ISO timestamp as relative time (zh-CN)
 */
export function formatTime(
    isoString: string,
    now: Date = new Date(),
    locale: SupportedLocale = currentSupportedLocale(),
): string {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    const diffDays = localCalendarDayIndex(now) - localCalendarDayIndex(date);

    if (diffDays === 0) {
        return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return locale === 'zh-CN' ? '昨天' : 'Yesterday';
    } else if (diffDays > 1 && diffDays < 7) {
        return locale === 'zh-CN' ? `${diffDays}天前` : `${diffDays} days ago`;
    } else {
        return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    }
}

function localCalendarDayIndex(date: Date): number {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (1000 * 60 * 60 * 24));
}

/**
 * Check if session source indicates IM bot origin
 */
export function isImSource(source: SessionMetadata['source']): boolean {
    if (!source) return false;
    // Built-in IM platforms + OpenClaw channels all use "<platform>_private" / "<platform>_group"
    return (source.endsWith('_private') || source.endsWith('_group')) && source !== 'desktop';
}

/**
 * Extract platform display name from a session key.
 * Handles both legacy (`im:{platform}:{type}:{id}`) and
 * new agent format (`agent:{agentId}:{channelType}:{sourceType}:{id}`).
 */
/**
 * Resolve any platform/plugin ID to a concise tag label.
 * Lookup chain: built-in names → promoted plugin (by pluginId or channelBrand) → capitalize.
 */
function resolveTagLabel(id: string): string {
    if (BUILTIN_PLATFORM_NAMES[id]) return BUILTIN_PLATFORM_NAMES[id];
    const promoted = findPromotedPlugin(id); // matches pluginId OR channelBrand
    if (promoted) return promoted.name;
    return id.charAt(0).toUpperCase() + id.slice(1);
}

export function extractPlatformDisplay(sessionKey: string): string {
    const parts = sessionKey.split(':');
    // New agent format: agent:{agentId}:{channelType}:{private|group}:{id}
    // channelType may contain colons (e.g. "openclaw:wecom") which split into multiple parts
    if (parts[0] === 'agent' && parts.length >= 5) {
        const channelType = parts[2] ?? 'unknown';
        if (channelType.startsWith('openclaw:')) {
            return resolveTagLabel(channelType.slice('openclaw:'.length));
        }
        if (channelType === 'openclaw' && parts[3]) {
            return resolveTagLabel(parts[3]);
        }
        return resolveTagLabel(channelType);
    }
    // Legacy format: im:{platform}:{type}:{id}
    const platform = parts[1] ?? 'unknown';
    if (platform === 'openclaw' && parts[2]) {
        return resolveTagLabel(parts[2]);
    }
    return resolveTagLabel(platform);
}

/**
 * Get a concise display label for a channel type (e.g., "飞书", "Telegram", "钉钉").
 * Handles both plain types ("telegram") and openclaw prefixed ("openclaw:openclaw-lark").
 */
export function getChannelTypeLabel(channelType: string): string {
    if (channelType.startsWith('openclaw:')) {
        return resolveTagLabel(channelType.slice(9));
    }
    return resolveTagLabel(channelType);
}

/**
 * Built-in platform display names (non-OpenClaw).
 * OpenClaw plugins are resolved via findPromotedPlugin() + getPromotedTagLabel() —
 * no need to maintain a separate dict. Adding a new promoted plugin in
 * promotedPlugins.ts (with channelBrand + tagLabel) makes all display paths work.
 */
const BUILTIN_PLATFORM_NAMES: Record<string, string> = {
    telegram: 'Telegram',
    feishu: '飞书',
    dingtalk: '钉钉',
};

/** Format persisted user-turn count suffix. */
export function formatTurnCount(
    session: SessionMetadata,
    locale: SupportedLocale = currentSupportedLocale(),
): string | null {
    const count = session.stats?.turnCount;
    if (!count || count <= 0) return null;
    if (locale === 'en-US') return `${count} turn${count === 1 ? '' : 's'}`;
    return `${count} 轮`;
}

/**
 * "刚刚" / "N 分钟前" / "N 小时前" / "N 天前" / fallback 日期.
 * Shared by RecentThoughtsRow, TaskListRow, TaskCardItem, SummaryCard.
 *
 * Canonical form uses a space between the number and the CJK unit
 * (e.g. `"5 分钟前"` not `"5分钟前"`) per W3C Chinese typography
 * recommendation for CJK / Latin-digit rhythm. Two prior copies
 * (RecentThoughtsRow, TaskListRow) omitted the space; consolidating here
 * normalises them forward — the change is intentional, not a regression.
 */
export function relativeTime(
    ts: number,
    locale: SupportedLocale = currentSupportedLocale(),
): string {
    return formatPastRelativeTime(ts, locale);
}

const WEEKDAY_LABEL_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_LABEL_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * 时间段标签:0-4 凌晨 · 5-8 早上 · 9-11 上午 · 12 中午 · 13-17 下午 · 18-23 晚上.
 */
export function periodOfHour(hour: number, locale: SupportedLocale = currentSupportedLocale()): string {
    if (locale === 'en-US') {
        if (hour < 12) return 'AM';
        if (hour === 12) return 'noon';
        return 'PM';
    }
    if (hour < 5) return '凌晨';
    if (hour < 9) return '早上';
    if (hour < 12) return '上午';
    if (hour === 12) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
}

/**
 * "上午 11 点" / "下午 2:30" — integer hour drops the colon.
 */
export function formatClockCN(
    hour: number,
    minute: number,
    locale: SupportedLocale = currentSupportedLocale(),
): string {
    if (locale === 'en-US') {
        const period = hour < 12 ? 'AM' : 'PM';
        const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        const mm = String(minute).padStart(2, '0');
        return minute === 0 ? `${display} ${period}` : `${display}:${mm} ${period}`;
    }
    const period = periodOfHour(hour, locale);
    const display = hour === 0 ? 0 : hour > 12 ? hour - 12 : hour;
    if (minute === 0) return `${period} ${display} 点`;
    const mm = String(minute).padStart(2, '0');
    return `${period} ${display}:${mm}`;
}

/**
 * Best-effort cron → Chinese. Covers the five shapes the chip picker emits
 * (每天 / 工作日 / 单一星期 / 多星期 / 每月某日) plus common manual patterns.
 * Returns null for anything that doesn't match so callers can fall back to
 * cronstrue or the raw expression honestly.
 *
 * Month MUST be `*` — we only humanize patterns that fire every month of
 * the year. `0 8 15 1 *` is "January 15th yearly", not "monthly on the
 * 15th"; mistranslating would be worse than showing the raw cron.
 */
export function humanizeCron(
    expr: string,
    locale: SupportedLocale = currentSupportedLocale(),
): string | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minStr, hourStr, dom, month, dow] = parts;
    const minute = Number(minStr);
    const hour = Number(hourStr);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
    if (month !== '*') return null;
    const clock = formatClockCN(hour, minute, locale);

    if (dom === '*' && dow === '*') return locale === 'zh-CN' ? `每天${clock}` : `Daily at ${clock}`;
    if (dom === '*' && dow === '1-5') return locale === 'zh-CN' ? `工作日${clock}` : `Weekdays at ${clock}`;
    if (dom === '*' && /^\d$/.test(dow)) {
        const n = Number(dow);
        if (n >= 0 && n <= 6) {
            return locale === 'zh-CN' ? `${WEEKDAY_LABEL_CN[n]}${clock}` : `${WEEKDAY_LABEL_EN[n]} at ${clock}`;
        }
    }
    if (dom === '*' && /^\d(?:,\d)+$/.test(dow)) {
        // Strict: every value must be a valid weekday 0..6. Silent filtering
        // would turn `1,9` into "周一" — a malformed cron getting rendered
        // as a legitimate schedule. Return null on any invalid member so
        // scheduleSummary falls through to cronstrue, which honestly
        // reports the error shape. Dedupe before sort so `0,0,1` renders
        // as "周日、周一", not "周日、周日、周一".
        const nums = dow.split(',').map((d) => Number(d));
        if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
            return null;
        }
        const days = Array.from(new Set(nums))
            .sort((a, b) => a - b)
            .map((n) => locale === 'zh-CN' ? WEEKDAY_LABEL_CN[n] : WEEKDAY_LABEL_EN[n])
            .join(locale === 'zh-CN' ? '、' : ', ');
        return days ? (locale === 'zh-CN' ? `${days} ${clock}` : `${days} at ${clock}`) : null;
    }
    if (/^\d+$/.test(dom) && dow === '*') {
        const d = Number(dom);
        if (d >= 1 && d <= 31) {
            return locale === 'zh-CN' ? `每月 ${d} 号${clock}` : `Monthly on day ${d} at ${clock}`;
        }
    }
    return null;
}
