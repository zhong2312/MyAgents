/**
 * SDK 0.2.91+ `terminal_reason` 枚举 — 标识 result 消息的终止原因。
 *
 * Re-exported directly from `@anthropic-ai/claude-agent-sdk` so SDK upgrades
 * adding new enum values cause tsc errors on the MAP below instead of silent
 * fallback-only behaviour. Double-sourcing was the original mistake here:
 * MyAgents hand-maintained the 12 values against SDK 0.2.107's type, which
 * works today but silently drifts when the SDK bumps.
 */
import type { TerminalReason as SdkTerminalReason } from '@anthropic-ai/claude-agent-sdk';
export type TerminalReason = SdkTerminalReason;

/**
 * 严重等级决定前端如何呈现：
 * - `info`：正常或无需打扰的状态（`completed`、`tool_deferred`）
 * - `notice`：需要用户知晓但非错误（`max_turns`、`aborted_*`）
 * - `error`：需要用户采取行动的错误（配额、Hook 阻断、图像/模型错误）
 */
export type TerminalReasonSeverity = 'info' | 'notice' | 'error';

export interface TerminalReasonInfo {
  /** 简短中文描述，用于 banner / toast */
  label: string;
  /** 更详细的说明，建议展示在 hover tip 或展开块中 */
  detail: string;
  severity: TerminalReasonSeverity;
}

// Record<TerminalReason, ...> forces exhaustive coverage — SDK adding a new
// enum value without an entry here breaks the build. That's the intent.
const MAP: Record<TerminalReason, TerminalReasonInfo> = {
  completed: {
    label: '已完成',
    detail: '本轮对话正常结束',
    severity: 'info',
  },
  max_turns: {
    label: '已达到最大对话轮次',
    detail: '本轮执行触达最大轮次上限。建议新开会话继续，或调整 Agent 的 maxTurns 配置。',
    severity: 'notice',
  },
  prompt_too_long: {
    label: '上下文已满',
    detail: '当前对话的 token 总量已达到模型上下文窗口上限，必须精简历史、清理附件或新开会话才能继续。',
    severity: 'error',
  },
  blocking_limit: {
    label: 'API 额度已用完',
    detail: '供应商返回 rate limit / quota 命中。请检查供应商后台配额或等待重置。',
    severity: 'error',
  },
  rapid_refill_breaker: {
    label: '请求过于频繁，已自动退避',
    detail: 'SDK 触发快速补发熔断器，正在自动退避重试。稍后会自行恢复。',
    severity: 'notice',
  },
  aborted_tools: {
    label: '工具执行被中断',
    detail: '工具调用被用户或系统中断。可重新发送消息让 AI 重试。',
    severity: 'notice',
  },
  aborted_streaming: {
    label: '回复被中断',
    detail: '流式回复在完成前被中断。可重新发送消息让 AI 重新生成。',
    severity: 'notice',
  },
  tool_deferred: {
    label: '工具被延迟执行',
    detail: '部分工具调用被延迟处理，本轮已返回。',
    severity: 'info',
  },
  background_requested: {
    label: '已转入后台执行',
    detail: 'SDK 已把后续工作转为后台任务，本轮前台响应已结束。可在后台任务通知中查看进展。',
    severity: 'info',
  },
  stop_hook_prevented: {
    label: '被 Stop Hook 阻止结束',
    detail: '项目配置的 Stop Hook 主动阻止了会话结束。请检查 Hook 逻辑或 settings.json。',
    severity: 'error',
  },
  hook_stopped: {
    label: '被 Hook 主动终止',
    detail: '某个 Hook 主动请求终止当前轮次。请检查 Hook 配置或日志定位触发的 Hook。',
    severity: 'error',
  },
  image_error: {
    label: '图像处理失败',
    detail: '图像内容块无法被模型处理，可能是格式不支持或尺寸超限（>8000px）。',
    severity: 'error',
  },
  model_error: {
    label: '模型返回错误',
    detail: '模型侧返回错误，请查看日志定位具体原因。',
    severity: 'error',
  },
  api_error: {
    label: '模型服务请求失败',
    detail: '模型服务返回 API 错误。请检查供应商状态、凭据和请求日志。',
    severity: 'error',
  },
  malformed_tool_use_exhausted: {
    label: '工具调用格式持续无效',
    detail: '模型多次生成了无法解析的工具调用，本轮已停止。可调整提示词或更换模型后重试。',
    severity: 'error',
  },
  budget_exhausted: {
    label: '执行预算已用尽',
    detail: '本轮已达到配置的执行预算上限。请调整预算或缩小任务范围后继续。',
    severity: 'notice',
  },
  structured_output_retry_exhausted: {
    label: '结构化输出生成失败',
    detail: '模型多次未能生成符合约束的结构化结果。请简化输出约束或更换模型。',
    severity: 'error',
  },
  tool_deferred_unavailable: {
    label: '延迟工具当前不可用',
    detail: '本轮请求的延迟工具无法继续执行。请稍后重试或改用当前可用工具。',
    severity: 'notice',
  },
  turn_setup_failed: {
    label: '对话轮次启动失败',
    detail: '会话在开始生成前未能完成初始化。请检查运行时配置并重试。',
    severity: 'error',
  },
};

/**
 * 解析 SDK `terminal_reason`。对未知值做兜底，避免 SDK 扩展枚举时前端 crash。
 * 返回 `null` 表示该原因无需展示（`completed` / `aborted_*` / 字段缺失）。
 *
 * Banner 抑制清单：
 * - `completed` — 正常结束
 * - `aborted_*`（`aborted_streaming` / `aborted_tools` / 任何未来新增的 `aborted_xxx`）
 *   — 都是同一个 abort 信号，只是命中时机不同（一个在文本流式阶段，一个在工具
 *   调用阶段）。触发源永远是三类：用户主动点停止 / 配置变更触发 session 重启 /
 *   Tab-IM 会话接管重启。三类都是用户预期或系统内部状态变化，不应打扰。消息流
 *   里已有"已停止"的内联反馈（红字 abort marker），banner 是冗余二次提示。
 *
 *   用 `startsWith('aborted_')` 而不是逐条罗列 — 未来 SDK 加 `aborted_init` 之类
 *   也自动覆盖，跟"对称抑制"的设计意图一致。
 *
 *   需要排查时看 unified logs 里的 `[agent][terminal_reason]` 行（agent-session.ts
 *   在每次非 completed 的 result 消息上都会记一行）。
 */
export function describeTerminalReason(reason: unknown): TerminalReasonInfo | null {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  if (reason === 'completed') return null;
  if (isAbortedTerminalReason(reason)) return null;
  const info = MAP[reason as TerminalReason];
  if (info) return info;
  // 未知 reason — 返回通用占位，避免前端 switch 穷举
  return {
    label: `未知原因 (${reason})`,
    detail: `SDK 返回了未知的 terminal_reason=${reason}。可能是 SDK 版本升级带来的新枚举值。`,
    severity: 'notice',
  };
}

/** 便捷判断：该 reason 是否应该打扰用户（banner/toast）。 */
export function shouldSurfaceTerminalReason(reason: unknown): boolean {
  return describeTerminalReason(reason) !== null;
}

/**
 * 是否应该在 terminal_reason banner 上提供"小助理诊断"。
 *
 * 只把真正需要排查的 terminal state 交给 support flow：
 * - error 级别：用户需要处理，通常涉及 Provider / Hook / 图像 / 上下文边界
 * - 未知枚举：SDK 升级后前端还没认识，值得诊断
 *
 * notice/info（max_turns / background_requested / rapid_refill_breaker 等）
 * 是正常边界或自恢复状态，不默认打扰用户。
 */
export function shouldOfferTerminalReasonDiagnostics(reason: unknown): boolean {
  const info = describeTerminalReason(reason);
  if (!info) return false;
  if (info.severity === 'error') return true;
  return typeof reason === 'string' && !Object.prototype.hasOwnProperty.call(MAP, reason);
}

/**
 * 该 result 是否是"用户/系统主动中止"（`aborted_streaming` / `aborted_tools` /
 * 未来任意 `aborted_*`）。
 *
 * 与 `shouldSurfaceTerminalReason` 的关键区别：本函数只对 abort 返回 true，
 * 对**缺失 / 未知 / 其它非 abort** 一律返回 false。`shouldSurfaceTerminalReason`
 * 对缺失 reason 也返回 false（因为 describeTerminalReason 把 undefined 也归为
 * "无需展示"），所以**不能**用它来判断"是不是 abort"——否则会把所有没带
 * terminal_reason 的合法错误（第三方供应商 4xx/5xx 等）误判成 abort 一起吞掉。
 *
 * #307：用户点停止后，SDK 把本轮包成 is_error result，result 文本是内部解析器
 * 诊断串 `[ede_diagnostic] result_type=user ...`。结果处理器据此判断"这是中止，
 * 不是真失败"，跳过 chat:agent-error，避免把内部诊断当报错横幅弹给用户。
 */
export function isAbortedTerminalReason(reason: unknown): boolean {
  return typeof reason === 'string' && reason.startsWith('aborted_');
}

/**
 * Title-gen turn-acceptance gate (#245).
 *
 * Returns true iff the turn ended cleanly enough that its (user, assistant)
 * text is safe to feed into auto title generation. Strictly `completed`:
 *
 * - `completed`              → use
 * - undefined / null / ''    → use (external runtimes 不携带 terminal_reason，
 *                              不能因为字段缺失就阻止它们自动起标题)
 * - everything else          → DISCARD (aborted_*: 流被中断/用户停掉，content
 *                              可能只是 OpenAI Bridge/SDK 把上游 4xx/5xx 当 text
 *                              块吐回来；*_error / *_limit / max_turns: 截断或
 *                              退化文本，喂给 title LLM 会得到无意义标题)
 *
 * #245 实战：SDK / openai-bridge 在上游 4xx/5xx 时把错误文本作为 assistant
 * text_delta 推到 renderer，并以 terminal_reason='aborted_streaming' 终止本
 * 轮。renderer 之前不看 reason，把这种"伪完成"轮当作正常 QA round 累积到
 * 3 轮就触发 title-gen，结果会话被命名为 "API Error: 400 ..."。Title-gen
 * 不是关键路径（前端会回退到"用户第一条消息截断"作为标题），保守拒绝即
 * 可，不需要更复杂的内容启发式。
 */
export function shouldRecordTurnForTitle(reason: unknown): boolean {
  if (typeof reason !== 'string' || reason.length === 0) return true;
  return reason === 'completed';
}

/**
 * #296 — builtin post-turn auto-title success gate.
 *
 * The builtin SDK result handler's "broadcast message-complete" branch is also
 * reached by `is_error:true` results that carried visible assistant text and by
 * non-`completed` terminal reasons (aborted_streaming / max_turns). Those must
 * NOT seed an auto title (same class as #245). The external runtime path gates on
 * its own `lastTurnSucceeded`; this is the builtin equivalent, composing the
 * is_error flag with {@link shouldRecordTurnForTitle}. Kept as a named pure
 * predicate so the gate is unit-tested rather than living inline in the 10k-line
 * result handler.
 */
export function shouldTitleCompletedTurn(isError: boolean, terminalReason: unknown): boolean {
  return !isError && shouldRecordTurnForTitle(terminalReason);
}
