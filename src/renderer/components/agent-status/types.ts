// PRD 0.2.17 — Agent Status Panel
//
// Runtime-agnostic 渲染契约。当前由 useAgentStatusState 在 renderer 侧从 messages
// 与 backgroundTaskStatus 模块派生；后续接入 Codex / CC / Gemini Runtime 时新增各自
// mapper 输出同形态，消费侧组件不变。

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
  /** 用于 React key 的稳定 id（基于 tool.id + 索引派生） */
  key: string;
}

export type SubagentMode = 'sync' | 'background';
export type SubagentDisplayStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface SubagentStatus {
  /**
   * Task tool 的 tool_use_id（SDK 全局唯一），同时作为：
   *   - React key
   *   - 跳转锚点（对应 TaskTool 容器上的 data-tool-id 属性）
   *   - 后台任务状态查询的 key（getBackgroundTaskStatus）
   */
  id: string;
  /** AI 传给 Task 工具的 subagent_type；未指定时 fallback 'general-purpose' */
  agentType: string;
  /** AI 传给 Task 工具的 description（3-5 词的简短任务描述） */
  description: string;
  mode: SubagentMode;
  /** 开始时间（ms），用于实时计时；不变量，不要每次派生时重算 */
  startedAt: number;
  finishedAt?: number;
  status: SubagentDisplayStatus;
  inputTokens: number;
  outputTokens: number;
  toolCount: number;
}

export interface AgentStatusSummary {
  todoCompleted: number;
  /** 处于 in_progress 状态的 todo 个数，用于摘要 bar 选 icon（区分 ☐ vs ■） */
  todoInProgress: number;
  todoTotal: number;
  subagentRunning: number;
  subagentTotal: number;
  subagentTerminalStatus: Exclude<SubagentDisplayStatus, 'running'> | null;
  /**
   * 最早开始的活跃 subagent 的开始时间（ms epoch）。null 表示当前无活跃 subagent。
   * 暴露 startedAt 而不是已运行的 elapsedMs，让消费组件自己驱动 1s 计时器
   * 重渲计时显示——避免 useAgentStatusState 把 Date.now() 写进派生值后失去时效性。
   */
  longestSubagentStartedAt: number | null;
}

export interface AgentStatusState {
  todos: TodoItem[];
  subagents: SubagentStatus[];
  summary: AgentStatusSummary;
}
