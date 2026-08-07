/**
 * Analytics Types
 * 埋点统计类型定义
 */

import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import type { OriginKind, OriginSurface } from '../../shared/session-origin';

/**
 * 埋点上报的 runtime 字段类型 = SDK runtime + `'unknown'` 兜底。
 *
 * 复用 `RuntimeType` 是为了避免与 SDK 来源漂移——RuntimeType 增删 runtime 时
 * 本类型自动跟随。`'unknown'` 仅在 caller 显式选择"未知"分桶时使用；正常路径
 * `normalizeRuntime()` 永远返回 RuntimeType，不会落到 `'unknown'`。
 */
export type AnalyticsRuntime = RuntimeType | 'unknown';

/** Runtime source analytics dimension. Builtin / unknown runtimes report null. */
export type AnalyticsRuntimeSource = RuntimeSource | null;

/**
 * 基础事件参数（SDK 自动填充）
 */
export interface BaseEventParams {
  device_id: string;
  platform: string;
  app_version: string;
  client_timestamp: string;
}

/**
 * 触发来源 — GUI/CLI/Cron/IM 共用枚举。
 *
 * 适用规则：当一个事件可以由多个入口触发（例如任务创建既可以通过 GUI
 * 的"+ 新建"按钮，也可以通过 `myagents task create-direct` CLI），就必须
 * 带上这个字段，方便后续按渠道做拆分分析。详见 `specs/tech_docs/analytics_design.md`。
 *
 * 取值约定：
 *   - `desktop`     桌面端 GUI（未来若有移动端 app，再加 `mobile`）
 *   - `floating_ball` 桌面悬浮球伴侣窗（独立于主 Tab 的 AI turn）
 *   - `cli`         用户在终端手动跑 `myagents` 命令
 *   - `cli_agent`   AI 子进程（agent）通过 CLI 调用（`MYAGENTS_PORT` 在环境里）
 *   - `cron`        定时任务调度器
 *   - `im`          IM Bot（飞书 / Telegram / 钉钉）
 */
export type Source = 'desktop' | 'floating_ball' | 'cli' | 'cli_agent' | 'cron' | 'im';

/**
 * UI 入口面 —— `source` 维度内"desktop 渠道"的二级细分。
 *
 * `source` 回答"哪个进程触发"（desktop/cli/cron/im），`surface` 回答
 * "desktop 内部哪个 UI 表面触发"。两者正交，配合解释"用户究竟是怎么开始
 * 用 MyAgents 的"。详见 `specs/tech_docs/analytics_design.md`。
 *
 * 取值约定：
 *   - `launcher_input`   启动页输入框直接发首条消息（New Tab 空状态 + 用户打字）
 *   - `agent_card`       右侧 Agent 工作区卡片点击
 *   - `history_click`    历史会话入口（legacy surface；新细分见 `history_open.entry_source`）
 *   - `new_chat_button`  Chat 内"新对话"按钮（走 resetSession 或 handleNewSession 路径）
 *   - `cmd_k`            命令面板（v0.2.19 未实现，预留）
 *   - `external_link`    URL Scheme / 深链唤起（v0.2.19 未实现，预留）
 *   - `cron`             定时任务（非 desktop，统一到 surface 列方便分析）
 *   - `im`               IM Bot
 *   - `unknown`          兜底，正常路径不应出现
 *
 * 注意：曾经存在 `tab_create_blank` —— v0.2.19 实现期间确认它没有实际触发路径
 * （任何 surface 实际产生事件的入口都已识别），删除以避免 enum 与代码脱节。
 */
export type Surface =
  | 'launcher_input'
  | 'global_sidebar'
  | 'agent_card'
  | 'history_click'
  | 'new_chat_button'
  | 'task_center'
  | 'bug_report'
  | 'agent_setup'
  | 'cmd_k'
  | 'external_link'
  | 'cron'
  | 'im'
  /** 桌面悬浮球伴侣窗（PRD 0.2.35 渠道维度——功能 DAU 占比的分子） */
  | 'floating_ball'
  | 'unknown';

/**
 * 入口语义 —— 与 Surface 正交。
 *
 * `Surface` 回答"用户在哪个 UI 表面触发"，`EntryIntent` 回答"这次入口
 * 想做什么"。同一个 surface 可能承载不同 intent（例如工作区卡片既可
 * 只是打开工作区，也可发 `/init` 初始化），所以不要从 surface 推断
 * `has_initial_message`。
 */
export type EntryIntent =
  | 'send_message'
  | 'open_workspace'
  | 'open_history'
  | 'thought_alignment'
  | 'workspace_init'
  | 'support_diagnostics'
  | 'new_chat'
  | 'fork'
  | 'unknown';

/**
 * 小助理发起位置 —— 仅在 `session_new.triggered_by='bug_report'` 这类
 * Helper Agent 会话上作为细分维度使用。
 *
 * `triggered_by` 继续回答“这是小助理/诊断入口”，`assistant_entry` 回答
 * “小助理具体从哪个位置发起”，避免把 settings / titlebar / agent-error
 * 都混进同一个 support diagnostics 桶里。
 */
export type AssistantEntry =
  | 'settings'
  | 'tab_top'
  | 'agent_error'
  | 'terminal_reason'
  | 'runtime_diagnostics'
  | 'support_diagnostics'
  | 'other';

/**
 * 历史 session 打开入口。用于细分 `history_open`，同时保持事件名不变，
 * 让旧报表继续按 `history_open` 聚合。
 */
export type HistoryEntrySource =
  | 'global_sidebar'
  | 'launcher_recent'
  | 'launcher_overlay'
  | 'chat_dropdown'
  | 'chat_dropdown_new_tab'
  | 'workspace_history'
  | 'settings_helper_history'
  | 'task_run_history';

/**
 * 事件名称枚举
 *
 * 注意：每个事件都必须有对应的 track() 调用实现
 * 已移除的事件（规划时定义但实际不需要）：
 * - app_ready: 与 app_launch 功能重叠
 * - session_end: 会话只有切换/新建，无明确结束点
 */
export type EventName =
  // 应用生命周期
  | 'app_launch'
  // 会话管理
  | 'session_new'
  | 'session_rewind'
  | 'session_title_edit'
  | 'session_fork'
  // 核心交互
  | 'message_send'
  | 'message_complete'
  | 'message_stop'
  | 'message_error'
  | 'message_retry'
  | 'message_copy'
  | 'message_export'
  // 思考过程导出 / 复制
  | 'thinking_copy'
  | 'thinking_export'
  // 工具使用
  | 'tool_use'
  | 'official_tool_vision_analyze'
  // 权限控制
  | 'permission_grant'
  | 'permission_deny'
  // 配置变更
  | 'provider_switch'
  | 'model_switch'
  | 'reasoning_effort_switch'
  | 'mcp_add'
  | 'mcp_remove'
  // Agent & Skill
  | 'agent_add'
  | 'agent_remove'
  | 'agent_channel_create'
  | 'agent_channel_remove'
  | 'agent_channel_toggle'
  | 'skill_use'
  // IM Bot
  | 'im_bot_create'
  | 'im_bot_toggle'
  | 'im_bot_remove'
  // 功能使用
  | 'tab_new'
  | 'tab_close'
  | 'restore_last_session'
  | 'settings_open'
  | 'workspace_open'
  | 'workspace_create'
  | 'history_open'
  | 'file_drop'
  | 'tts_play'
  | 'task_center_open'
  | 'bug_report_submit'
  // MyAgents Space
  | 'space_open'
  | 'space_auth_start'
  | 'space_auth_complete'
  | 'space_switch'
  | 'space_issue_mutation'
  | 'space_goal_mutation'
  | 'space_skill_mutation'
  | 'space_registered_agent_mutation'
  | 'space_member_mutation'
  | 'space_settings_mutation'
  // 系统事件
  | 'update_check'
  | 'update_install'
  // 心跳循环
  | 'cron_enable'
  | 'cron_stop'
  | 'cron_recover'
  | 'launcher_cron_stage'
  | 'launcher_cron_create_standalone'
  // 任务中心（GUI + CLI 双触发面，带 source 字段）
  | 'task_create'
  | 'task_run'
  | 'task_stop'
  | 'task_delete'
  | 'task_align_discuss'
  // 启动页 / 想法输入
  | 'launcher_mode_switch'
  | 'thought_create'
  // 桌面悬浮球（PRD 0.2.35 §11.2 球生命周期事件）
  | 'floating_ball_toggle'
  | 'floating_ball_summon'
  | 'floating_ball_expand'
  | 'floating_ball_pet_select'
  // 服务端统一 AI turn 事件。由 trackServer() 上报，但仍属于同一事件契约。
  | 'ai_turn_complete';

/**
 * session_new 事件参数
 *
 * 这是整个会话生命周期的"出生证明"。下游所有 session-scoped 事件通过
 * `session_id` 反查这条记录拿 provenance，不要在每个下游事件上重复
 * 打 `triggered_by`。详见 `specs/tech_docs/analytics_design.md`。
 */
export interface SessionNewParams {
  /** SDK Session ID（与 ~/.myagents/sessions/*.jsonl 文件名一致） */
  session_id: string;
  /** Tab ID（前端会话归因 / 多 Tab debug 用） */
  tab_id?: string;
  /** UI 入口面 —— surface 维度由 caller 在 session 创建前显式打 */
  triggered_by: Surface;
  /** Stable session birth origin, preferred by new reports over triggered_by. */
  origin_kind: OriginKind;
  origin_surface: OriginSurface;
  /** 入口语义 —— 不要从 triggered_by 推断 */
  entry_intent: EntryIntent;
  /** 该 session 跑在哪个 runtime 下 */
  runtime: AnalyticsRuntime;
  /** 外部 runtime 来源；builtin / unknown 填 null */
  runtime_source: AnalyticsRuntimeSource;
  /** session 创建时是否真的带了首条消息 */
  has_initial_message: boolean;
  /** 小助理发起位置；仅小助理/诊断类 session_new 使用 */
  assistant_entry?: AssistantEntry;
  /** SHA-256(local_pepper + ':' + agent_name) 前 16 字节 hex；pepper 永不上传，
   *  无绑定 agent 填 null。详见 `analytics/hash.ts`。 */
  agent_hash: string | null;
}

/**
 * workspace_open 事件参数
 *
 * 用户从右侧 Agent 卡片打开工作区时触发（无 sessionId）。如果带了 sessionId
 * 走 `history_open` 路径。
 */
export interface WorkspaceOpenParams {
  /** UI surface that initiated the workspace open. */
  surface: Surface;
  /** SHA-256(local_pepper + ':' + agent_name) 前 16 字节 hex；pepper 永不上传，
   *  无绑定 agent 填 null。详见 `analytics/hash.ts`。 */
  agent_hash: string | null;
  /** 目标工作区的 runtime */
  runtime: AnalyticsRuntime;
  /** 工作区入口的语义（打开 / 发送 / 初始化等） */
  entry_intent: EntryIntent;
  /** 这次打开是否会随即自动发送首条消息 */
  has_initial_message: boolean;
  /** pre-session 入口事件，显式 null 防 stale Active Context */
  session_id: null;
  /** 目标 tab id；新建 tab 场景由 App 在 targetTabId 决定后显式传 */
  tab_id?: string;
}

/**
 * history_open 事件参数
 *
 * 用户从历史相关入口打开已有 session 时触发（带 sessionId）。
 */
export interface HistoryOpenParams {
  /** 用户点击的目标 session id。显式传值，不依赖 Active Context。 */
  session_id: string;
  agent_hash: string | null;
  runtime: AnalyticsRuntime;
  runtime_source: AnalyticsRuntimeSource;
  /** Birth origin of the opened target session. */
  origin_kind: OriginKind;
  origin_surface: OriginSurface;
  /**
   * 细分入口来源。旧版本没有该字段；查询时应把缺省值按 legacy launcher
   * 历史入口处理，不影响历史兼容聚合。
   */
  entry_source?: HistoryEntrySource;
}

/**
 * message_send 事件参数
 *
 * `session_id` 由 Active Context 自动注入（见 tracker.ts::setAnalyticsContext），
 * caller 无需手动传。同名规则适用于本文件下方所有"session-scoped"事件。
 */
export interface MessageSendParams {
  /** Effective runtime of THIS session — same value as the server-side
   *  ai_turn_complete.runtime, so the desktop funnel can be sliced by runtime
   *  without joining to session_new. Resolved as the session-FROZEN runtime
   *  (`sessionRuntime`) when known, else the agent-config effective runtime
   *  (`resolveEffectiveRuntime`). See analyticsMetaRef in TabProvider. */
  runtime: AnalyticsRuntime;
  runtime_source: AnalyticsRuntimeSource;
  mode: string;           // 权限模式: auto | confirm | deny
  model: string;          // 当前模型
  skill?: string | null;  // 技能/指令名称
  has_image: boolean;     // 是否含图片
  has_file: boolean;      // 是否含文件
  is_cron: boolean;       // 是否为心跳循环任务发送
  // session_id 由 Active Context 自动注入
}

/**
 * message_complete 事件参数
 */
export interface MessageCompleteParams {
  /** Effective runtime of THIS session (frozen sessionRuntime ?? agent-config) —
   *  see MessageSendParams.runtime. */
  runtime: AnalyticsRuntime;
  runtime_source: AnalyticsRuntimeSource;
  model?: string;                // 主模型名称
  input_tokens: number;          // 输入 tokens
  output_tokens: number;         // 输出 tokens
  cache_read_tokens: number;     // 缓存读取 tokens
  cache_creation_tokens: number; // 缓存创建 tokens
  tool_count: number;            // 工具调用次数
  duration_ms: number;           // 响应耗时（毫秒）
}

/**
 * app_launch 事件参数
 */
export interface AppLaunchParams {
  /** 启动类型（目前固定 'cold'） */
  launch_type: string;
  /**
   * 逗号分隔的 distinct 有效外部 runtime 列表（如 `"codex"` / `"claude-code,codex"`）。
   * gate-aware：`multiAgentRuntime` 关闭时为 `''`（所有 agent 实际跑 builtin）。
   * 用于"已配置但可能从未使用"的 runtime 采用率分析——turn 级事件看不到这部分。
   * config 尚未加载时该字段缺省（区分 `''`=无外部 与 缺省=未知）。
   */
  runtimes_active?: string;
}

/**
 * task_create 事件参数
 */
export interface TaskCreateParams {
  source: Source;
  /**
   * 创建路径来源 — 区分"凭空新建"和"从想法派发"两种业务语义，
   * 跟 `source` 字段（触发渠道）正交。
   */
  origin: 'manual' | 'thought_dispatch';
  has_workspace: boolean;
}

/**
 * task_run 事件参数
 */
export interface TaskRunParams {
  source: Source;
  /**
   * 第几次执行 — 1 = 首次派发；>1 = 重新派发（rerun）。
   * 由 Task execution owner 在接受 run/rerun mutation 后返回；Session
   * history 数量不参与计算，admission 失败也不会产生事件。
   */
  run_count: number;
}

/**
 * task_stop / task_delete 事件参数
 */
export interface TaskStopParams {
  source: Source;
}

export interface TaskDeleteParams {
  source: Source;
  /** 删除时任务所处状态（todo / running / done / archived 等） */
  status: string;
}

/**
 * agent_channel_create / agent_channel_remove 事件参数
 *
 * 双触发面：
 *   - GUI（ChannelWizard / ChannelDetailView）→ source: 'desktop'
 *   - CLI（`myagents agent channel add/remove`）→ source: cliSource()
 */
export interface AgentChannelMutationParams {
  source: Source;
  /**
   * 渠道类型：`'feishu'` / `'telegram'` / `'dingtalk'` / `'openclaw:<plugin>'`
   * / `'unknown'`（仅 GUI 删除路径，channelRef 已被清空时的兜底）。
   */
  platform: string;
}

/**
 * agent_channel_toggle 事件参数
 *
 * 当前 GUI 独有（CLI 没有 enable/disable 子命令）。如果未来 CLI 加上等价
 * 命令，再扩展为带 `source` 的形式。
 */
export interface AgentChannelToggleParams {
  platform: string;
  enabled: boolean;
}

/**
 * launcher_mode_switch 事件参数
 *
 * GUI 独有 —— CLI 没有 launcher 概念，所以不带 `source` 字段。
 */
export interface LauncherModeSwitchParams {
  to: 'task' | 'thought';
  via: 'click' | 'shortcut';
}

/**
 * thought_create 事件参数
 */
export interface ThoughtCreateParams {
  source: Source;
  /**
   * UI 上的入口位置 —— 仅在 `source === 'desktop'` 时有意义；
   * CLI 触发时为 `null`。
   */
  location: 'launcher' | 'task_center' | null;
}

/**
 * 通用事件参数类型
 */
export type EventParams = Record<string, string | number | boolean | null | undefined>;

/**
 * 待发送的事件
 */
export interface TrackEvent {
  event: EventName | string;
  device_id: string;
  platform: string;
  app_version: string;
  params: EventParams;
  client_timestamp: string;
}

/**
 * API 请求体
 */
export interface TrackRequest {
  events: TrackEvent[];
}

/**
 * API 响应
 */
export interface TrackResponse {
  success: boolean;
  received?: number;
  error?: string;
}
