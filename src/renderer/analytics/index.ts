/**
 * Analytics Module
 * 埋点统计模块
 *
 * 使用方式:
 * ```typescript
 * import { track, initAnalytics } from '@/analytics';
 *
 * // 应用启动时初始化
 * await initAnalytics();
 *
 * // 追踪事件
 * track('message_send', { mode: 'auto', model: 'claude-3.5-sonnet' });
 * ```
 *
 * 配置 (.env):
 * - VITE_ANALYTICS_ENABLED=true     # 启用埋点
 * - VITE_ANALYTICS_API_KEY=xxx      # API Key
 * - VITE_ANALYTICS_ENDPOINT=xxx     # 可选，自定义上报地址
 */

// 核心功能
export {
  track,
  initAnalytics,
  flushEvents,
  isEnabled,
  // Active Context API（v0.2.19）
  setAnalyticsContext,
  clearAnalyticsContext,
  getAnalyticsContext,
} from './tracker';

// 隐私哈希（v0.2.19）
export { hashAgentName, hashAgentNameSync } from './hash';

// Pending birth context registry —— session_new 之前 caller 打入口上下文，consumer 消费
export {
  setPendingSessionBirth,
  peekPendingSessionBirth,
  consumePendingSessionBirth,
  clearPendingSessionBirth,
  setPendingSurface,
  consumePendingSurface,
  clearPendingSurface,
  birthContextForSurface,
} from './pendingSurface';

// 类型导出
export type {
  EventName,
  EventParams,
  AppLaunchParams,
  MessageSendParams,
  MessageCompleteParams,
  Source,
  Surface,
  EntryIntent,
  AssistantEntry,
  HistoryEntrySource,
  SessionNewParams,
  WorkspaceOpenParams,
  HistoryOpenParams,
  TaskCreateParams,
  TaskRunParams,
  TaskStopParams,
  TaskDeleteParams,
  LauncherModeSwitchParams,
  ThoughtCreateParams,
  AgentChannelMutationParams,
  AgentChannelToggleParams,
  TrackEvent,
} from './types';
export type { PendingSessionBirthContext } from './pendingSurface';

// 配置（调试用）
export { isAnalyticsEnabled, getAnalyticsConfig } from './config';

// 设备信息（调试用）
export { getDeviceId, getPlatform, getAppVersion } from './device';
